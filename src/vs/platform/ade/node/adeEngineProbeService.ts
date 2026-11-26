/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../base/common/path.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IAdeCloudHostBackendService } from '../common/adeCloudHosts.js';
import { normalizeAdeEngineId } from '../common/adeCliManifest.js';
import { stripAdeControlEnv } from '../common/adeControl.js';
import {
	ADE_REGISTERED_ENGINES,
	AdeEffortLevel,
	AdeEngineId,
	AdeError,
	isAdeEffortLevel,
} from '../common/adeModels.js';

interface IEngineStaticMetadata {
	readonly binaries: readonly string[];
	readonly defaultModels: readonly string[];
	readonly efforts: readonly AdeEffortLevel[];
	readonly defaultEffort: AdeEffortLevel;
}

const CLAUDE_OFFICIAL_BUILTIN_MODELS: readonly string[] = [
	'claude-sonnet-4-6',
	'claude-opus-4-6',
	'claude-haiku-4-5',
	'claude-sonnet-4-5',
	'claude-opus-4-5',
	'sonnet',
	'opus',
	'haiku',
];

const ENGINE_METADATA: Readonly<Record<AdeEngineId, IEngineStaticMetadata>> = {
	claude: {
		binaries: ['claude'],
		defaultModels: CLAUDE_OFFICIAL_BUILTIN_MODELS,
		efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		defaultEffort: 'medium',
	},
	codex: {
		binaries: ['codex'],
		defaultModels: ['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'o4-mini'],
		efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
		defaultEffort: 'medium',
	},
	kilo: {
		binaries: ['kilo', 'kilocode'],
		defaultModels: ['claude-sonnet-4-5'],
		efforts: ['none', 'low', 'high', 'max'],
		defaultEffort: 'high',
	},
	opencode: {
		binaries: ['opencode'],
		defaultModels: ['claude-sonnet-4-5'],
		efforts: ['low', 'medium', 'high', 'extra-high'],
		defaultEffort: 'medium',
	},
	dsh: {
		binaries: ['dsh'],
		defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
		efforts: ['off', 'low', 'high', 'max'],
		defaultEffort: 'high',
	},
	antigravity: {
		binaries: ['agy', 'antigravity'],
		defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
		efforts: ['low', 'medium', 'high', 'xhigh'],
		defaultEffort: 'medium',
	},
	cline: {
		binaries: ['cline'],
		defaultModels: ['claude-sonnet-4-5'],
		efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
		defaultEffort: 'medium',
	},
	pi: {
		binaries: ['pi'],
		defaultModels: ['claude-sonnet-4-5'],
		efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
		defaultEffort: 'medium',
	},
};

export interface IClaudeRuntimeEnvironmentHint {
	readonly needsClaudeDirCopy: boolean;
}

export interface IAdeProbedEngineMetadata {
	readonly engine: AdeEngineId;
	readonly models: readonly string[];
	readonly efforts: readonly string[];
	readonly defaultEffort: string;
}

export interface IAdeEngineProbeServiceOptions {
	readonly cloudHostService?: IAdeCloudHostBackendService;
	readonly configurationService?: Pick<IConfigurationService, 'getValue'>;
	readonly cacheTtlMs?: number;
	readonly modelCacheTtlMs?: number;
	readonly cliProbeTimeoutMs?: number;
	readonly homedir?: string;
	/** Optional override for deterministic unit tests. */
	readonly customLocalProber?: () => Promise<readonly AdeEngineId[]>;
}

interface ICachedEngineList {
	readonly engines: readonly AdeEngineId[];
	readonly expiresAt: number;
	readonly claudeNeedsSubdirCopy?: boolean;
}

interface ICachedModelProbe {
	readonly result: IAdeProbedEngineMetadata;
	readonly expiresAt: number;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return 0;
}

function parseSemverTuple(raw: string): [number, number, number] | undefined {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
	if (!m) {
		return undefined;
	}
	return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10)];
}

function stripAnsiCodes(raw: string): string {
	return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function stripJsoncCommentsAndTrailingCommas(text: string): string {
	let result = '';
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	let escaped = false;
	const cleanBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

	for (let i = 0; i < cleanBom.length; i++) {
		const ch = cleanBom[i];
		const next = i + 1 < cleanBom.length ? cleanBom[i + 1] : '';
		if (inLineComment) {
			if (ch === '\n') {
				inLineComment = false;
				result += ch;
			}
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			} else if (ch === '\n') {
				result += ch;
			}
			continue;
		}
		if (inString) {
			result += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === '\\') {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			result += ch;
			continue;
		}
		if (ch === '/' && next === '/') {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		result += ch;
	}
	return result.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonLoose(text: string | undefined): unknown {
	if (!text || !text.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(stripJsoncCommentsAndTrailingCommas(text)) as unknown;
	} catch {
		return undefined;
	}
}

class OrderedModelCollector {
	private readonly list: string[] = [];
	private readonly indexByLower = new Map<string, number>();

	get size(): number {
		return this.list.length;
	}

	private isValidModelId(raw: string): boolean {
		const t = raw.trim();
		if (!t || t.length > 200 || /\s/.test(t)) {
			return false;
		}
		const low = t.toLowerCase();
		if (low === 'default' || low === 'none' || low === 'null' || low === 'undefined') {
			return false;
		}
		return true;
	}

	add(raw: unknown): void {
		const s = nonEmptyString(raw);
		if (!s || !this.isValidModelId(s)) {
			return;
		}
		const low = s.toLowerCase();
		if (this.indexByLower.has(low)) {
			return;
		}
		this.indexByLower.set(low, this.list.length);
		this.list.push(s);
	}

	promoteFirst(raw: unknown): void {
		const s = nonEmptyString(raw);
		if (!s || !this.isValidModelId(s)) {
			return;
		}
		const low = s.toLowerCase();
		const existingIdx = this.indexByLower.get(low);
		if (existingIdx === 0) {
			this.list[0] = s;
			return;
		}
		if (existingIdx !== undefined) {
			this.list.splice(existingIdx, 1);
		}
		this.list.unshift(s);
		this.indexByLower.clear();
		for (let i = 0; i < this.list.length; i++) {
			this.indexByLower.set(this.list[i].toLowerCase(), i);
		}
	}

	toArray(): string[] {
		return [...this.list];
	}
}

export function parseClaudeModelsFromSettings(settingsText: string | undefined): {
	readonly models: readonly string[];
	readonly replaceBuiltInOptions: boolean;
} {
	const collector = new OrderedModelCollector();
	const parsed = asRecord(parseJsonLoose(settingsText));
	let replaceBuiltInOptions = false;

	if (parsed) {
		const topModelVal = parsed.model;
		let topModel: string | undefined;
		if (typeof topModelVal === 'string') {
			topModel = nonEmptyString(topModelVal);
		} else {
			const topRec = asRecord(topModelVal);
			topModel = nonEmptyString(topRec?.value) ?? nonEmptyString(topRec?.model) ?? nonEmptyString(topRec?.id);
		}

		const picker = parsed.modelPicker;
		const pickerRec = asRecord(picker);
		replaceBuiltInOptions = pickerRec?.replaceBuiltInOptions === true;
		const pickerOptions = Array.isArray(picker)
			? picker
			: Array.isArray(pickerRec?.options) ? pickerRec.options : [];
		for (const opt of pickerOptions) {
			if (typeof opt === 'string') {
				collector.add(opt);
			} else {
				const optRec = asRecord(opt);
				if (optRec) {
					collector.add(optRec.value ?? optRec.model ?? optRec.id);
				}
			}
		}

		const modelSettingsRec = asRecord(parsed.modelSettings);
		if (modelSettingsRec) {
			for (const key of Object.keys(modelSettingsRec)) {
				collector.add(key);
			}
		}

		const envRec = asRecord(parsed.env);
		if (envRec) {
			collector.add(envRec.ANTHROPIC_MODEL);
			collector.add(envRec.ANTHROPIC_DEFAULT_OPUS_MODEL);
			collector.add(envRec.ANTHROPIC_DEFAULT_SONNET_MODEL);
			collector.add(envRec.ANTHROPIC_DEFAULT_HAIKU_MODEL);
			collector.add(envRec.ANTHROPIC_DEFAULT_FABLE_MODEL);
			collector.add(envRec.ANTHROPIC_CUSTOM_MODEL_OPTION);
		}

		if (topModel) {
			collector.promoteFirst(topModel);
		} else if (envRec?.ANTHROPIC_MODEL) {
			collector.promoteFirst(envRec.ANTHROPIC_MODEL);
		}
	}

	if (!replaceBuiltInOptions || collector.size === 0) {
		for (const builtin of CLAUDE_OFFICIAL_BUILTIN_MODELS) {
			collector.add(builtin);
		}
	}

	return {
		models: collector.toArray(),
		replaceBuiltInOptions,
	};
}

export function parseCodexTomlConfig(tomlText: string | undefined): {
	readonly defaultModel?: string;
	readonly profileModels: readonly string[];
	readonly defaultEffort?: string;
} {
	if (!tomlText) {
		return { profileModels: [] };
	}
	let currentSection = '';
	let defaultModel: string | undefined;
	let defaultEffort: string | undefined;
	const profileModels: string[] = [];

	for (const rawLine of tomlText.split(/\r?\n/)) {
		const stripped = rawLine.replace(/#.*$/, '').trim();
		if (!stripped) {
			continue;
		}
		const secMatch = /^\[([^\]]+)\]$/.exec(stripped);
		if (secMatch) {
			currentSection = secMatch[1].trim();
			continue;
		}
		const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(stripped);
		if (!kvMatch) {
			continue;
		}
		const key = kvMatch[1];
		const val = (kvMatch[2] ?? kvMatch[3] ?? '').trim();
		if (!val) {
			continue;
		}
		if (!currentSection) {
			if (key === 'model' && !defaultModel) {
				defaultModel = val;
			} else if (key === 'model_reasoning_effort' && !defaultEffort) {
				defaultEffort = val.toLowerCase();
			}
		} else if (/^profiles\./i.test(currentSection) && key === 'model') {
			profileModels.push(val);
		}
	}
	return { defaultModel, profileModels, defaultEffort };
}

export function parseCodexModelsFromSources(input: {
	readonly configToml?: string;
	readonly modelsCacheJson?: string;
	readonly appServerListData?: readonly unknown[];
}): { readonly models: readonly string[]; readonly efforts: readonly string[]; readonly defaultEffort: string } {
	const collector = new OrderedModelCollector();
	const parsedToml = parseCodexTomlConfig(input.configToml);
	const discoveredEfforts = new Set<string>(ENGINE_METADATA.codex.efforts);

	if (Array.isArray(input.appServerListData)) {
		for (const item of input.appServerListData) {
			const rec = asRecord(item);
			if (!rec) {
				continue;
			}
			const vis = nonEmptyString(rec.visibility)?.toLowerCase();
			if (rec.hidden === true || vis === 'hide' || vis === 'hidden') {
				continue;
			}
			collector.add(rec.id ?? rec.model ?? rec.slug);
			const effList = Array.isArray(rec.supportedReasoningEfforts) ? rec.supportedReasoningEfforts : [];
			for (const effEntry of effList) {
				if (typeof effEntry === 'string' && effEntry.trim()) {
					discoveredEfforts.add(effEntry.trim().toLowerCase());
				} else {
					const effRec = asRecord(effEntry);
					const effVal = nonEmptyString(effRec?.reasoningEffort ?? effRec?.effort);
					if (effVal) {
						discoveredEfforts.add(effVal.toLowerCase());
					}
				}
			}
		}
	}

	const cacheParsed = asRecord(parseJsonLoose(input.modelsCacheJson));
	const cacheList = Array.isArray(cacheParsed?.models)
		? cacheParsed.models
		: Array.isArray(cacheParsed?.data) ? cacheParsed.data : [];
	for (const entry of cacheList) {
		const rec = asRecord(entry);
		if (!rec) {
			continue;
		}
		const vis = nonEmptyString(rec.visibility)?.toLowerCase();
		if (rec.hidden === true || vis === 'hide' || vis === 'hidden') {
			continue;
		}
		collector.add(rec.slug ?? rec.model ?? rec.id);
		const effList = Array.isArray(rec.supported_reasoning_levels) ? rec.supported_reasoning_levels : [];
		for (const effEntry of effList) {
			const effRec = asRecord(effEntry);
			const effVal = nonEmptyString(effRec?.effort ?? effRec?.reasoningEffort);
			if (effVal) {
				discoveredEfforts.add(effVal.toLowerCase());
			}
		}
	}

	for (const pm of parsedToml.profileModels) {
		collector.add(pm);
	}
	if (parsedToml.defaultModel) {
		collector.promoteFirst(parsedToml.defaultModel);
	}

	if (collector.size === 0) {
		for (const fb of ENGINE_METADATA.codex.defaultModels) {
			collector.add(fb);
		}
	}

	const orderedEfforts: string[] = [...ENGINE_METADATA.codex.efforts];
	for (const eff of discoveredEfforts) {
		if (!orderedEfforts.includes(eff)) {
			orderedEfforts.push(eff);
		}
	}
	const defaultEffort = parsedToml.defaultEffort && orderedEfforts.includes(parsedToml.defaultEffort)
		? parsedToml.defaultEffort
		: ENGINE_METADATA.codex.defaultEffort;

	return {
		models: collector.toArray(),
		efforts: orderedEfforts,
		defaultEffort,
	};
}

function collectProviderConfigModels(parsed: Record<string, unknown>, collector: OrderedModelCollector): void {
	const providerMap = asRecord(parsed.provider);
	if (!providerMap) {
		return;
	}
	for (const [providerId, provVal] of Object.entries(providerMap)) {
		const provRec = asRecord(provVal);
		if (!provRec) {
			continue;
		}
		const whitelist = Array.isArray(provRec.whitelist) ? provRec.whitelist : [];
		for (const w of whitelist) {
			const wid = nonEmptyString(w);
			if (wid) {
				collector.add(wid.includes('/') ? wid : `${providerId}/${wid}`);
			}
		}
		const rawModels = provRec.models;
		if (Array.isArray(rawModels)) {
			for (const entry of rawModels) {
				if (typeof entry === 'string') {
					const mid = nonEmptyString(entry);
					if (mid) {
						collector.add(mid.includes('/') ? mid : `${providerId}/${mid}`);
					}
				} else {
					const mRec = asRecord(entry);
					const mid = nonEmptyString(mRec?.id ?? mRec?.model ?? mRec?.name);
					if (mid) {
						collector.add(mid.includes('/') ? mid : `${providerId}/${mid}`);
					}
				}
			}
		} else {
			const modelsObj = asRecord(rawModels);
			if (modelsObj) {
				for (const [modelKey, modelVal] of Object.entries(modelsObj)) {
					const mRec = asRecord(modelVal);
					const mid = nonEmptyString(mRec?.id) ?? modelKey;
					if (mid) {
						collector.add(mid.includes('/') ? mid : `${providerId}/${mid}`);
					}
				}
			}
		}
	}
}

function collectProviderSlashModelLines(cliOutput: string | undefined, collector: OrderedModelCollector): void {
	if (!cliOutput) {
		return;
	}
	const clean = stripAnsiCodes(cliOutput);
	for (const rawLine of clean.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const token = line.split(/\s+/)[0] ?? '';
		if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/[\]-]+$/.test(token)) {
			collector.add(token);
		}
	}
}

export function parseKiloModelsFromSources(configTexts: readonly (string | undefined)[], cliOutput?: string): readonly string[] {
	const collector = new OrderedModelCollector();
	let firstDefault: string | undefined;
	collectProviderSlashModelLines(cliOutput, collector);
	for (const txt of configTexts) {
		const parsed = asRecord(parseJsonLoose(txt));
		if (!parsed) {
			continue;
		}
		const defModel = nonEmptyString(parsed.model);
		if (defModel && !firstDefault) {
			firstDefault = defModel;
		}
		collectProviderConfigModels(parsed, collector);
		if (defModel) {
			collector.add(defModel);
		}
	}
	if (firstDefault) {
		collector.promoteFirst(firstDefault);
	}
	if (collector.size === 0) {
		for (const fb of ENGINE_METADATA.kilo.defaultModels) {
			collector.add(fb);
		}
	}
	return collector.toArray();
}

export function parseOpenCodeModelsFromSources(configTexts: readonly (string | undefined)[], cliOutput?: string): readonly string[] {
	const collector = new OrderedModelCollector();
	let firstDefault: string | undefined;
	collectProviderSlashModelLines(cliOutput, collector);
	for (const txt of configTexts) {
		const parsed = asRecord(parseJsonLoose(txt));
		if (!parsed) {
			continue;
		}
		const defModel = nonEmptyString(parsed.model);
		if (defModel && !firstDefault) {
			firstDefault = defModel;
		}
		const smallModel = nonEmptyString(parsed.small_model);
		collectProviderConfigModels(parsed, collector);
		if (defModel) {
			collector.add(defModel);
		}
		if (smallModel) {
			collector.add(smallModel);
		}
	}
	if (firstDefault) {
		collector.promoteFirst(firstDefault);
	}
	if (collector.size === 0) {
		for (const fb of ENGINE_METADATA.opencode.defaultModels) {
			collector.add(fb);
		}
	}
	return collector.toArray();
}

function collectPiProviderJsonModels(jsonText: string | undefined, collector: OrderedModelCollector): void {
	const parsed = asRecord(parseJsonLoose(jsonText));
	if (!parsed) {
		return;
	}
	const providersContainer = asRecord(parsed.providers) ?? parsed;
	for (const [providerId, provEntry] of Object.entries(providersContainer)) {
		if (providerId === 'version' || providerId === '$schema') {
			continue;
		}
		const provRec = asRecord(provEntry);
		const modelsArr = Array.isArray(provRec?.models) ? provRec.models : undefined;
		if (!modelsArr) {
			continue;
		}
		for (const m of modelsArr) {
			if (typeof m === 'string') {
				const mid = nonEmptyString(m);
				if (mid) {
					collector.add(mid.includes('/') ? mid : `${providerId}/${mid}`);
				}
			} else {
				const mRec = asRecord(m);
				const mid = nonEmptyString(mRec?.id ?? mRec?.model);
				if (mid) {
					collector.add(mid.includes('/') ? mid : `${providerId}/${mid}`);
				}
			}
		}
	}
}

export function parsePiModelsFromSources(input: {
	readonly settingsJson?: string;
	readonly modelsJson?: string;
	readonly modelsStoreJson?: string;
	readonly listModelsCliOutput?: string;
}): readonly string[] {
	const collector = new OrderedModelCollector();
	let defaultFullId: string | undefined;

	const settingsRec = asRecord(parseJsonLoose(input.settingsJson));
	if (settingsRec) {
		const defProv = nonEmptyString(settingsRec.defaultProvider);
		const defMod = nonEmptyString(settingsRec.defaultModel);
		if (defMod) {
			defaultFullId = defProv && !defMod.includes('/') ? `${defProv}/${defMod}` : defMod;
		}
	}

	if (input.listModelsCliOutput) {
		const clean = stripAnsiCodes(input.listModelsCliOutput);
		for (const rawLine of clean.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || /^provider\s+model\b/i.test(line) || /^[-=]{3,}/.test(line)) {
				continue;
			}
			if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/[\]-]+$/.test(line)) {
				collector.add(line);
				continue;
			}
			const cols = line.split(/\s+/);
			if (cols.length >= 2 && /^[A-Za-z0-9._-]+$/.test(cols[0]) && /^[A-Za-z0-9._:/[\]-]+$/.test(cols[1])) {
				collector.add(`${cols[0]}/${cols[1]}`);
			}
		}
	}

	collectPiProviderJsonModels(input.modelsJson, collector);
	collectPiProviderJsonModels(input.modelsStoreJson, collector);

	if (defaultFullId) {
		collector.promoteFirst(defaultFullId);
	}
	if (collector.size === 0) {
		for (const fb of ENGINE_METADATA.pi.defaultModels) {
			collector.add(fb);
		}
	}
	return collector.toArray();
}

export function foldAntigravityTierSuffix(rawModelId: string): string {
	return rawModelId.trim().replace(/-(?:low|medium|high|xhigh)$/i, '');
}

export function parseAntigravityModelsFromSources(cliOutput?: string, settingsTexts: readonly (string | undefined)[] = []): readonly string[] {
	const collector = new OrderedModelCollector();
	let configuredDefault: string | undefined;

	for (const txt of settingsTexts) {
		const rec = asRecord(parseJsonLoose(txt));
		if (!rec) {
			continue;
		}
		const def = nonEmptyString(rec.model ?? rec.defaultModel);
		if (def && !configuredDefault) {
			configuredDefault = foldAntigravityTierSuffix(def);
		}
	}

	if (cliOutput) {
		const clean = stripAnsiCodes(cliOutput);
		for (const rawLine of clean.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || /^fetching\b/i.test(line) || /^loading\b/i.test(line)) {
				continue;
			}
			let rawId: string | undefined;
			const tabIdx = line.indexOf('\t');
			if (tabIdx > 0) {
				rawId = line.slice(0, tabIdx).trim();
			} else {
				const m = /^([A-Za-z0-9._:/-]+)(?:\s{2,}.*)?$/.exec(line);
				rawId = m?.[1]?.trim();
			}
			if (rawId && /^[A-Za-z0-9._-]+$/.test(rawId)) {
				collector.add(foldAntigravityTierSuffix(rawId));
			}
		}
	}

	if (configuredDefault) {
		collector.promoteFirst(configuredDefault);
	}
	if (collector.size === 0) {
		for (const fb of ENGINE_METADATA.antigravity.defaultModels) {
			collector.add(fb);
		}
	}
	return collector.toArray();
}

function unwrapPossibleProviderTuple(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed) && typeof parsed[1] === 'string' && parsed[1].trim()) {
				return parsed[1].trim();
			}
		} catch {
			// Keep raw value
		}
	}
	return trimmed;
}

function extractAcpSessionNewModels(sessionNewResult: unknown, collector: OrderedModelCollector): string | undefined {
	const resRec = asRecord(sessionNewResult);
	if (!resRec) {
		return undefined;
	}
	let currentDefault: string | undefined;
	const modelsBlock = asRecord(resRec.models);
	if (modelsBlock) {
		const curId = nonEmptyString(modelsBlock.currentModelId);
		if (curId) {
			currentDefault = unwrapPossibleProviderTuple(curId);
		}
		const avail = Array.isArray(modelsBlock.availableModels) ? modelsBlock.availableModels : [];
		for (const m of avail) {
			const mRec = asRecord(m);
			const id = nonEmptyString(mRec?.modelId ?? mRec?.id);
			if (id) {
				collector.add(unwrapPossibleProviderTuple(id));
			}
		}
	}
	const configOpts = Array.isArray(resRec.configOptions) ? resRec.configOptions : [];
	for (const opt of configOpts) {
		const optRec = asRecord(opt);
		if (nonEmptyString(optRec?.id) !== 'model') {
			continue;
		}
		const curVal = nonEmptyString(optRec?.currentValue);
		if (curVal && !currentDefault) {
			currentDefault = unwrapPossibleProviderTuple(curVal);
		}
		const rawOptions = Array.isArray(optRec?.options) ? optRec.options : [];
		for (const entry of rawOptions) {
			const entryRec = asRecord(entry);
			const nested = Array.isArray(entryRec?.options) ? entryRec.options : [entry];
			for (const leaf of nested) {
				const leafRec = asRecord(leaf);
				const val = nonEmptyString(leafRec?.value ?? leafRec?.id);
				if (val) {
					collector.add(unwrapPossibleProviderTuple(val));
				}
			}
		}
	}
	return currentDefault;
}

export function parseDshModelsFromSources(input: {
	readonly yamlTexts?: readonly (string | undefined)[];
	readonly jsonTexts?: readonly (string | undefined)[];
	readonly acpSessionNewResult?: unknown;
}): readonly string[] {
	const collector = new OrderedModelCollector();
	let defaultModel: string | undefined;

	for (const yml of input.yamlTexts ?? []) {
		if (!yml) {
			continue;
		}
		for (const m of yml.matchAll(/^\s*model\s*:\s*["']?([^"'\r\n#]+)["']?\s*(?:#.*)?$/gm)) {
			const id = m[1]?.trim();
			if (id) {
				if (!defaultModel) {
					defaultModel = id;
				}
				collector.add(id);
			}
		}
	}
	for (const jt of input.jsonTexts ?? []) {
		const rec = asRecord(parseJsonLoose(jt));
		const id = nonEmptyString(rec?.model ?? rec?.defaultModel ?? rec?.modelId);
		if (id) {
			if (!defaultModel) {
				defaultModel = id;
			}
			collector.add(id);
		}
	}

	const acpDefault = extractAcpSessionNewModels(input.acpSessionNewResult, collector);
	if (!defaultModel && acpDefault) {
		defaultModel = acpDefault;
	}

	collector.add('deepseek-chat');
	collector.add('deepseek-reasoner');

	if (defaultModel) {
		collector.promoteFirst(defaultModel);
	}
	return collector.toArray();
}

export function parseClineModelsFromSources(input: {
	readonly modelsJson?: string;
	readonly providersJson?: string;
	readonly globalStateJsons?: readonly (string | undefined)[];
	readonly acpSessionNewResult?: unknown;
}): readonly string[] {
	const collector = new OrderedModelCollector();
	let defaultModel: string | undefined;

	for (const gsText of input.globalStateJsons ?? []) {
		const gs = asRecord(parseJsonLoose(gsText));
		if (!gs) {
			continue;
		}
		const actApi = nonEmptyString(gs.actModeApiModelId);
		const planApi = nonEmptyString(gs.planModeApiModelId);
		const actOai = nonEmptyString(gs.actModeOpenAiModelId);
		const planOai = nonEmptyString(gs.planModeOpenAiModelId);
		const genModel = nonEmptyString(gs.model);
		defaultModel ??= actApi ?? planApi ?? actOai ?? planOai ?? genModel;
		for (const candidate of [actApi, planApi, actOai, planOai, genModel]) {
			if (candidate) {
				collector.add(candidate);
			}
		}
	}

	const provDoc = asRecord(parseJsonLoose(input.providersJson));
	if (provDoc) {
		const lastUsed = nonEmptyString(provDoc.lastUsedProvider);
		const providers = asRecord(provDoc.providers);
		if (providers) {
			const entries = lastUsed && providers[lastUsed]
				? [[lastUsed, providers[lastUsed]] as const, ...Object.entries(providers).filter(([k]) => k !== lastUsed)]
				: Object.entries(providers);
			for (const [pid, pEntry] of entries) {
				const settings = asRecord(asRecord(pEntry)?.settings);
				const m = nonEmptyString(settings?.model);
				if (m) {
					if (pid === lastUsed && !defaultModel) {
						defaultModel = m;
					}
					collector.add(m);
				}
			}
		}
	}

	const modelsDoc = asRecord(parseJsonLoose(input.modelsJson));
	const mProviders = asRecord(modelsDoc?.providers);
	if (mProviders) {
		for (const pEntry of Object.values(mProviders)) {
			const pRec = asRecord(pEntry);
			const metaRec = asRecord(pRec?.provider);
			const pDefault = nonEmptyString(metaRec?.defaultModelId);
			defaultModel ??= pDefault;
			if (pDefault) {
				collector.add(pDefault);
			}
			const modelsMap = asRecord(pRec?.models);
			if (modelsMap) {
				for (const [mKey, mVal] of Object.entries(modelsMap)) {
					const mRec = asRecord(mVal);
					collector.add(nonEmptyString(mRec?.id) ?? mKey);
				}
			}
		}
	}

	const acpDefault = extractAcpSessionNewModels(input.acpSessionNewResult, collector);
	defaultModel ??= acpDefault;

	if (defaultModel) {
		collector.promoteFirst(defaultModel);
	}
	if (collector.size === 0) {
		for (const fb of ENGINE_METADATA.cline.defaultModels) {
			collector.add(fb);
		}
	}
	return collector.toArray();
}

export class AdeEngineProbeService {
	private readonly cloudHosts?: IAdeCloudHostBackendService;
	private readonly configurationService?: Pick<IConfigurationService, 'getValue'>;
	private readonly cacheTtlMs: number;
	private readonly modelCacheTtlMs: number;
	private readonly cliProbeTimeoutMs: number;
	private readonly homeDir: string;
	private readonly customLocalProber?: () => Promise<readonly AdeEngineId[]>;
	private readonly cache = new Map<string, ICachedEngineList>();
	private readonly modelCache = new Map<string, ICachedModelProbe>();
	private readonly modelInflight = new Map<string, Promise<IAdeProbedEngineMetadata>>();
	private cachedProxyLookup?: { readonly proxyUrl: string | undefined; readonly expiresAt: number };

	constructor(options?: IAdeEngineProbeServiceOptions) {
		this.cloudHosts = options?.cloudHostService;
		this.configurationService = options?.configurationService;
		this.cacheTtlMs = Math.max(1_000, options?.cacheTtlMs ?? 60_000);
		this.modelCacheTtlMs = Math.max(1_000, options?.modelCacheTtlMs ?? 30_000);
		this.cliProbeTimeoutMs = Math.max(500, options?.cliProbeTimeoutMs ?? 4_500);
		this.homeDir = options?.homedir ?? os.homedir();
		this.customLocalProber = options?.customLocalProber;
	}

	invalidateCache(host?: string): void {
		this.cachedProxyLookup = undefined;
		if (!host) {
			this.cache.clear();
			this.modelCache.clear();
			return;
		}
		const normHost = host.trim().toLowerCase();
		this.cache.delete(normHost);
		for (const k of [...this.modelCache.keys()]) {
			if (k.startsWith(`${normHost}::`)) {
				this.modelCache.delete(k);
			}
		}
	}

	getDefaultMetadata(engineRaw: string): IAdeProbedEngineMetadata {
		const engine = normalizeAdeEngineId(engineRaw);
		const meta = ENGINE_METADATA[engine];
		return {
			engine,
			models: [...meta.defaultModels],
			efforts: [...meta.efforts],
			defaultEffort: meta.defaultEffort,
		};
	}

	isCompatibleEffort(engineRaw: string, effortRaw: string): boolean {
		const engine = normalizeAdeEngineId(engineRaw);
		const norm = effortRaw.trim().toLowerCase();
		if (!norm) {
			return false;
		}
		const meta = ENGINE_METADATA[engine];
		return (meta.efforts as readonly string[]).includes(norm) || isAdeEffortLevel(norm);
	}

	async resolveCloudAuthority(hostIpOrAlias: string): Promise<{ readonly ip: string; readonly alias: string; readonly os: 'linux' | 'macos' | 'windows' }> {
		if (!this.cloudHosts) {
			throw new AdeError('ERR_INVALID_ARGS', `未知的远程云主机: ${hostIpOrAlias}`);
		}
		const needle = hostIpOrAlias.trim();
		const all = await this.cloudHosts.listHosts();
		const matched = all.find(h =>
			h.hostName === needle
			|| h.alias === needle
			|| h.id === needle
			|| h.hostName.toLowerCase() === needle.toLowerCase()
			|| h.alias.toLowerCase() === needle.toLowerCase(),
		);
		if (!matched) {
			throw new AdeError('ERR_INVALID_ARGS', `未知的远程云主机: ${hostIpOrAlias}`);
		}
		return { ip: matched.hostName, alias: matched.alias, os: matched.os };
	}

	async probeEngines(hostRaw: string): Promise<readonly AdeEngineId[]> {
		const trimmed = hostRaw.trim();
		if (!trimmed) {
			throw new AdeError('ERR_INVALID_ARGS', '必须指定 --host <local|ip>');
		}
		const isLocal = trimmed === 'local';
		const cacheKey = isLocal ? 'local' : trimmed.toLowerCase();
		const now = Date.now();
		const hit = this.cache.get(cacheKey);
		if (hit && hit.expiresAt > now) {
			return hit.engines;
		}

		if (isLocal) {
			const res = await this.probeLocalEngines();
			this.cache.set(cacheKey, {
				engines: res.engines,
				claudeNeedsSubdirCopy: res.claudeNeedsSubdirCopy,
				expiresAt: now + this.cacheTtlMs,
			});
			return res.engines;
		}

		const { alias, os: hostOs } = await this.resolveCloudAuthority(trimmed);
		const remoteRes = await this.probeRemoteEngines(alias, hostOs);
		this.cache.set(cacheKey, {
			engines: remoteRes.engines,
			claudeNeedsSubdirCopy: remoteRes.claudeNeedsSubdirCopy,
			expiresAt: now + this.cacheTtlMs,
		});
		return remoteRes.engines;
	}

	async doesHostClaudeNeedSubdirCopy(hostRaw: string): Promise<boolean> {
		const key = hostRaw.trim() === 'local' ? 'local' : hostRaw.trim().toLowerCase();
		let hit = this.cache.get(key);
		if (!hit || hit.expiresAt <= Date.now()) {
			await this.probeEngines(hostRaw).catch(() => undefined);
			hit = this.cache.get(key);
		}
		return hit?.claudeNeedsSubdirCopy ?? false;
	}

	async probeModels(hostRaw: string, engineRaw: string): Promise<IAdeProbedEngineMetadata> {
		const trimmedHost = hostRaw.trim();
		if (!trimmedHost) {
			throw new AdeError('ERR_INVALID_ARGS', '必须指定 --host <local|ip>');
		}
		const engine = normalizeAdeEngineId(engineRaw);
		const isLocal = trimmedHost === 'local';
		let resolvedRemote: { readonly ip: string; readonly alias: string; readonly os: 'linux' | 'macos' | 'windows' } | undefined;
		if (!isLocal) {
			resolvedRemote = await this.resolveCloudAuthority(trimmedHost);
		}

		const hostCacheKey = isLocal ? 'local' : (resolvedRemote?.ip || trimmedHost).toLowerCase();
		const fullKey = `${hostCacheKey}::${engine}`;
		const now = Date.now();
		const cached = this.modelCache.get(fullKey);
		if (cached && cached.expiresAt > now) {
			return cached.result;
		}

		const inflight = this.modelInflight.get(fullKey);
		if (inflight) {
			return inflight;
		}

		const task = (async (): Promise<IAdeProbedEngineMetadata> => {
			const probed = isLocal
				? await this.probeLocalEngineModels(engine)
				: await this.probeRemoteEngineModels(resolvedRemote!.alias, resolvedRemote!.os, engine);
			this.modelCache.set(fullKey, {
				result: probed,
				expiresAt: Date.now() + this.modelCacheTtlMs,
			});
			return probed;
		})().finally(() => {
			if (this.modelInflight.get(fullKey) === task) {
				this.modelInflight.delete(fullKey);
			}
		});

		this.modelInflight.set(fullKey, task);
		return task;
	}

	async collectLocalBinSearchDirs(): Promise<string[]> {
		const rawPath = process.env.PATH || process.env.Path || '';
		const sep = isWindows ? ';' : ':';
		const home = this.homeDir;
		const nvmBins = await this.scanNvmNodeBinDirs(home);

		const priorityExtras = isWindows
			? [
				path.join(home, '.gemini', 'bin'),
				path.join(home, '.local', 'node-current', 'bin'),
				path.join(home, '.local', 'bin'),
				path.join(home, '.bun', 'bin'),
				path.join(home, '.volta', 'bin'),
				path.join(home, '.npm-global', 'bin'),
				...nvmBins,
				path.join(home, 'AppData', 'Roaming', 'npm'),
				path.join(home, '.opencode', 'bin'),
				path.join(home, '.cargo', 'bin'),
			]
			: [
				path.join(home, '.gemini', 'bin'),
				path.join(home, '.local', 'node-current', 'bin'),
				path.join(home, '.local', 'bin'),
				path.join(home, '.bun', 'bin'),
				path.join(home, '.volta', 'bin'),
				path.join(home, '.npm-global', 'bin'),
				...nvmBins,
				path.join(home, '.opencode', 'bin'),
				path.join(home, '.cargo', 'bin'),
				'/opt/homebrew/bin',
				'/usr/local/bin',
				'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin',
			];

		return Array.from(new Set([
			...priorityExtras,
			...rawPath.split(sep).filter(Boolean),
		]));
	}

	private async scanNvmNodeBinDirs(home: string): Promise<string[]> {
		const versionsRoot = path.join(home, '.nvm', 'versions', 'node');
		try {
			const entries = await fs.promises.readdir(versionsRoot, { withFileTypes: true });
			const dirs = entries
				.filter(e => e.isDirectory())
				.map(e => e.name)
				.sort((a, b) => {
					const va = parseSemverTuple(a) ?? [0, 0, 0];
					const vb = parseSemverTuple(b) ?? [0, 0, 0];
					return compareSemver(vb, va) || b.localeCompare(a);
				});
			return dirs.map(d => path.join(versionsRoot, d, 'bin'));
		} catch {
			return [];
		}
	}

	private async resolveConfiguredHttpProxy(): Promise<string | undefined> {
		const fromConfig = nonEmptyString(this.configurationService?.getValue<string>('http.proxy'));
		if (fromConfig) {
			const support = nonEmptyString(this.configurationService?.getValue<string>('http.proxySupport'));
			if (support?.toLowerCase() !== 'off') {
				return fromConfig;
			}
		}

		const now = Date.now();
		if (this.cachedProxyLookup && this.cachedProxyLookup.expiresAt > now) {
			return this.cachedProxyLookup.proxyUrl;
		}

		const home = this.homeDir;
		const candidates: string[] = [
			path.join(home, '.aexus-code', 'settings.json'),
			path.join(home, '.aexus-code', 'User', 'settings.json'),
		];
		if (isMacintosh) {
			candidates.unshift(
				path.join(home, 'Library', 'Application Support', 'Aexus Code', 'User', 'settings.json'),
				path.join(home, 'Library', 'Application Support', 'Aexus', 'User', 'settings.json'),
			);
			candidates.push(
				path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
			);
		} else if (isWindows) {
			const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
			candidates.unshift(
				path.join(appData, 'Aexus Code', 'User', 'settings.json'),
				path.join(appData, 'Aexus', 'User', 'settings.json'),
			);
			candidates.push(
				path.join(appData, 'Code', 'User', 'settings.json'),
			);
		} else {
			const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
			candidates.unshift(
				path.join(xdgConfig, 'Aexus Code', 'User', 'settings.json'),
				path.join(xdgConfig, 'Aexus', 'User', 'settings.json'),
			);
			candidates.push(
				path.join(xdgConfig, 'Code', 'User', 'settings.json'),
			);
		}

		let resolved: string | undefined;
		for (const filePath of candidates) {
			const txt = await this.readTextFileSafe(filePath);
			if (!txt) {
				continue;
			}
			const rec = asRecord(parseJsonLoose(txt));
			if (!rec) {
				continue;
			}
			const support = nonEmptyString(rec['http.proxySupport'])?.toLowerCase();
			if (support === 'off') {
				continue;
			}
			const proxy = nonEmptyString(rec['http.proxy']);
			if (proxy && /^https?:\/\/|^socks5h?:\/\//i.test(proxy)) {
				resolved = proxy;
				break;
			}
		}

		this.cachedProxyLookup = { proxyUrl: resolved, expiresAt: now + 30_000 };
		return resolved;
	}

	async buildSubprocessEnv(): Promise<NodeJS.ProcessEnv> {
		const env = stripAdeControlEnv(process.env);
		const sep = isWindows ? ';' : ':';
		const joinedPath = (await this.collectLocalBinSearchDirs()).join(sep);

		if (isWindows) {
			const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path';
			env[pathKey] = joinedPath;
		} else {
			env.PATH = joinedPath;
		}

		let proxyActive = Boolean(
			nonEmptyString(env.HTTP_PROXY)
			|| nonEmptyString(env.http_proxy)
			|| nonEmptyString(env.HTTPS_PROXY)
			|| nonEmptyString(env.https_proxy)
			|| nonEmptyString(env.ALL_PROXY)
			|| nonEmptyString(env.all_proxy),
		);
		if (!proxyActive) {
			const proxyUrl = await this.resolveConfiguredHttpProxy();
			if (proxyUrl) {
				env.HTTP_PROXY = proxyUrl;
				env.HTTPS_PROXY = proxyUrl;
				env.ALL_PROXY = proxyUrl;
				proxyActive = true;
			}
		}
		if (proxyActive) {
			const mergedNoProxy = this.mergeLoopbackNoProxy(env.NO_PROXY, env.no_proxy);
			env.NO_PROXY = mergedNoProxy;
			env.no_proxy = mergedNoProxy;
		}
		return env;
	}

	private mergeLoopbackNoProxy(...rawValues: readonly (string | undefined)[]): string {
		const out: string[] = [];
		const seenLower = new Set<string>();
		const pushToken = (raw: string) => {
			const trimmed = raw.trim();
			if (!trimmed) {
				return;
			}
			const key = trimmed.toLowerCase();
			if (!seenLower.has(key)) {
				seenLower.add(key);
				out.push(trimmed);
			}
		};
		for (const raw of rawValues) {
			if (!raw) {
				continue;
			}
			for (const part of raw.split(',')) {
				pushToken(part);
			}
		}
		for (const loopback of ['127.0.0.1', 'localhost', '::1']) {
			pushToken(loopback);
		}
		return out.join(',');
	}

	private async readTextFileSafe(filePath: string): Promise<string | undefined> {
		try {
			return await fs.promises.readFile(filePath, 'utf8');
		} catch {
			return undefined;
		}
	}

	private async findEngineBinary(engine: AdeEngineId): Promise<string | undefined> {
		const dirs = await this.collectLocalBinSearchDirs();
		for (const binName of ENGINE_METADATA[engine].binaries) {
			const found = await this.findExecutableInDirs(binName, dirs);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	private async probeLocalEngines(): Promise<{ readonly engines: readonly AdeEngineId[]; readonly claudeNeedsSubdirCopy: boolean }> {
		if (this.customLocalProber) {
			const engines = await this.customLocalProber();
			return { engines, claudeNeedsSubdirCopy: false };
		}
		const searchDirs = await this.collectLocalBinSearchDirs();
		const found: AdeEngineId[] = [];
		let claudePath: string | undefined;

		for (const engine of ADE_REGISTERED_ENGINES) {
			const meta = ENGINE_METADATA[engine];
			let matchedBin: string | undefined;
			for (const binName of meta.binaries) {
				matchedBin = await this.findExecutableInDirs(binName, searchDirs);
				if (matchedBin) {
					break;
				}
			}
			if (matchedBin) {
				found.push(engine);
				if (engine === 'claude') {
					claudePath = matchedBin;
				}
			}
		}

		let claudeNeedsSubdirCopy = Boolean(
			process.env.CLAUDE_CODE_USE_BEDROCK === '1'
			|| process.env.CLAUDE_CODE_USE_VERTEX === '1',
		);
		if (claudePath && !claudeNeedsSubdirCopy) {
			const verOut = await this.execCapture(claudePath, ['--version'], 2_500);
			const ver = parseSemverTuple(verOut);
			if (!ver || compareSemver(ver, [2, 1, 277]) < 0) {
				claudeNeedsSubdirCopy = true;
			}
		}

		return { engines: found, claudeNeedsSubdirCopy };
	}

	private async probeLocalEngineModels(engine: AdeEngineId): Promise<IAdeProbedEngineMetadata> {
		const home = this.homeDir;
		const staticMeta = ENGINE_METADATA[engine];

		switch (engine) {
			case 'claude': {
				const settingsText = await this.readTextFileSafe(path.join(home, '.claude', 'settings.json'));
				const parsed = parseClaudeModelsFromSettings(settingsText);
				return {
					engine,
					models: parsed.models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
			case 'codex': {
				const [configToml, modelsCacheJson, codexBin] = await Promise.all([
					this.readTextFileSafe(path.join(home, '.codex', 'config.toml')),
					this.readTextFileSafe(path.join(home, '.codex', 'models_cache.json')),
					this.findEngineBinary('codex'),
				]);
				let appServerListData: readonly unknown[] | undefined;
				if (codexBin) {
					const rpcRes = await this.probeJsonRpcStdio(
						codexBin,
						['app-server'],
						[
							{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'aexus-code-probe', version: '1.0.0' } } },
							{ jsonrpc: '2.0', method: 'initialized', params: {} },
							{ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} },
						],
						2,
						this.cliProbeTimeoutMs,
					);
					const resRec = asRecord(asRecord(rpcRes)?.result);
					if (Array.isArray(resRec?.data)) {
						appServerListData = resRec.data;
					} else if (Array.isArray(resRec?.models)) {
						appServerListData = resRec.models;
					}
				}
				const parsed = parseCodexModelsFromSources({ configToml, modelsCacheJson, appServerListData });
				return {
					engine,
					models: parsed.models,
					efforts: parsed.efforts,
					defaultEffort: parsed.defaultEffort,
				};
			}
			case 'kilo': {
				const kiloDir = path.join(home, '.config', 'kilo');
				const [kiloJsonc, kiloJson, kiloOpencodeJson, kiloBin] = await Promise.all([
					this.readTextFileSafe(path.join(kiloDir, 'kilo.jsonc')),
					this.readTextFileSafe(path.join(kiloDir, 'kilo.json')),
					this.readTextFileSafe(path.join(kiloDir, 'opencode.json')),
					this.findEngineBinary('kilo'),
				]);
				const cliOut = kiloBin ? await this.execCapture(kiloBin, ['models'], this.cliProbeTimeoutMs) : undefined;
				const models = parseKiloModelsFromSources([kiloJsonc, kiloJson, kiloOpencodeJson], cliOut);
				return {
					engine,
					models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
			case 'opencode': {
				const ocDir = path.join(home, '.config', 'opencode');
				const [ocJsonc, ocJson, ocBin] = await Promise.all([
					this.readTextFileSafe(path.join(ocDir, 'opencode.jsonc')),
					this.readTextFileSafe(path.join(ocDir, 'opencode.json')),
					this.findEngineBinary('opencode'),
				]);
				const cliOut = ocBin ? await this.execCapture(ocBin, ['models'], this.cliProbeTimeoutMs) : undefined;
				const models = parseOpenCodeModelsFromSources([ocJsonc, ocJson], cliOut);
				return {
					engine,
					models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
			case 'pi': {
				const piAgentDir = path.join(home, '.pi', 'agent');
				const [settingsJson, modelsJson, modelsStoreJson, piBin] = await Promise.all([
					this.readTextFileSafe(path.join(piAgentDir, 'settings.json')),
					this.readTextFileSafe(path.join(piAgentDir, 'models.json')),
					this.readTextFileSafe(path.join(piAgentDir, 'models-store.json')),
					this.findEngineBinary('pi'),
				]);
				const cliOut = piBin ? await this.execCapture(piBin, ['--list-models'], this.cliProbeTimeoutMs) : undefined;
				const models = parsePiModelsFromSources({
					settingsJson,
					modelsJson,
					modelsStoreJson,
					listModelsCliOutput: cliOut,
				});
				return {
					engine,
					models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
			case 'antigravity': {
				const gemDir = path.join(home, '.gemini');
				const [s1, s2, s3, agyBin] = await Promise.all([
					this.readTextFileSafe(path.join(gemDir, 'antigravity', 'settings.json')),
					this.readTextFileSafe(path.join(gemDir, 'antigravity-cli', 'settings.json')),
					this.readTextFileSafe(path.join(gemDir, 'settings.json')),
					this.findEngineBinary('antigravity'),
				]);
				const cliOut = agyBin ? await this.execCapture(agyBin, ['models'], this.cliProbeTimeoutMs) : undefined;
				const models = parseAntigravityModelsFromSources(cliOut, [s1, s2, s3]);
				return {
					engine,
					models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
			case 'dsh': {
				const dshDir = path.join(home, '.dsh');
				const [patchYml, cordisYml, cfgJson, settingsJson, dshBin] = await Promise.all([
					this.readTextFileSafe(path.join(dshDir, 'cordis.patch.yml')),
					this.readTextFileSafe(path.join(dshDir, 'cordis.yml')),
					this.readTextFileSafe(path.join(dshDir, 'config.json')),
					this.readTextFileSafe(path.join(dshDir, 'settings.json')),
					this.findEngineBinary('dsh'),
				]);
				let acpSessionNewResult: unknown;
				if (dshBin) {
					const rpcRes = await this.probeJsonRpcStdio(
						dshBin,
						['acp'],
						[
							{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
							{ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.tmpdir(), mcpServers: [] } },
						],
						2,
						this.cliProbeTimeoutMs,
					);
					acpSessionNewResult = asRecord(rpcRes)?.result;
				}
				const models = parseDshModelsFromSources({
					yamlTexts: [patchYml, cordisYml],
					jsonTexts: [cfgJson, settingsJson],
					acpSessionNewResult,
				});
				return {
					engine,
					models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
			case 'cline': {
				const clineDataDir = path.join(home, '.cline', 'data');
				const [modelsJson, providersJson, gs1, gs2, gs3, clineBin] = await Promise.all([
					this.readTextFileSafe(path.join(clineDataDir, 'settings', 'models.json')),
					this.readTextFileSafe(path.join(clineDataDir, 'settings', 'providers.json')),
					this.readTextFileSafe(path.join(clineDataDir, 'settings', 'globalState.json')),
					this.readTextFileSafe(path.join(clineDataDir, 'globalState.json')),
					this.readTextFileSafe(path.join(home, '.cline', 'globalState.json')),
					this.findEngineBinary('cline'),
				]);
				let acpSessionNewResult: unknown;
				if (clineBin) {
					const rpcRes = await this.probeJsonRpcStdio(
						clineBin,
						['--acp'],
						[
							{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
							{ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.tmpdir(), mcpServers: [] } },
						],
						2,
						this.cliProbeTimeoutMs,
					);
					acpSessionNewResult = asRecord(rpcRes)?.result;
				}
				const models = parseClineModelsFromSources({
					modelsJson,
					providersJson,
					globalStateJsons: [gs1, gs2, gs3],
					acpSessionNewResult,
				});
				return {
					engine,
					models,
					efforts: [...staticMeta.efforts],
					defaultEffort: staticMeta.defaultEffort,
				};
			}
		}
	}

	private async findExecutableInDirs(binName: string, dirs: readonly string[]): Promise<string | undefined> {
		const exts = isWindows ? ['.cmd', '.exe', '.bat', ''] : [''];
		for (const dir of dirs) {
			for (const ext of exts) {
				const candidate = path.join(dir, `${binName}${ext}`);
				try {
					await fs.promises.access(candidate, fs.constants.X_OK);
					const st = await fs.promises.stat(candidate);
					if (st.isFile()) {
						return candidate;
					}
				} catch {
					// continue
				}
			}
		}
		return undefined;
	}

	private async execCapture(cmd: string, args: readonly string[], timeoutMs: number): Promise<string> {
		const env = await this.buildSubprocessEnv();
		return new Promise(resolve => {
			let out = '';
			let settled = false;
			const child = spawn(cmd, [...args], {
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
				env,
			});
			child.stdout.setEncoding('utf8');
			const finish = (killChild: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (killChild) {
					try { child.kill('SIGKILL'); } catch { /* ignore */ }
				}
				resolve(out);
			};
			const timer = setTimeout(() => finish(true), timeoutMs);
			if (typeof (timer as { unref?: () => void }).unref === 'function') {
				(timer as { unref?: () => void }).unref!();
			}
			child.stdout.on('data', (chunk: string) => {
				if (out.length < 262_144) {
					out += chunk;
				}
			});
			child.once('error', () => finish(false));
			child.once('close', () => finish(false));
		});
	}

	private async probeJsonRpcStdio(
		cmd: string,
		args: readonly string[],
		requests: readonly Record<string, unknown>[],
		targetResponseId: number,
		timeoutMs: number,
	): Promise<unknown> {
		const env = await this.buildSubprocessEnv();
		return new Promise(resolve => {
			let settled = false;
			let matchedMessage: unknown;
			let lineBuf = '';

			const child = spawn(cmd, [...args], {
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env,
			});
			child.stdout.setEncoding('utf8');
			child.stdin.on('error', () => { /* ignore broken pipe */ });

			const terminateAndResolve = () => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				try { child.stdin.end(); } catch { /* ignore */ }
				try { child.kill('SIGKILL'); } catch { /* ignore */ }

				if (child.exitCode !== null || child.killed) {
					const reapTimer = setTimeout(() => resolve(matchedMessage), 120);
					if (typeof (reapTimer as { unref?: () => void }).unref === 'function') {
						(reapTimer as { unref?: () => void }).unref!();
					}
					child.once('close', () => {
						clearTimeout(reapTimer);
						resolve(matchedMessage);
					});
					return;
				}
				resolve(matchedMessage);
			};

			const timer = setTimeout(() => terminateAndResolve(), timeoutMs);
			if (typeof (timer as { unref?: () => void }).unref === 'function') {
				(timer as { unref?: () => void }).unref!();
			}

			child.stdout.on('data', (chunk: string) => {
				if (settled) {
					return;
				}
				lineBuf += chunk;
				let nlIdx = lineBuf.indexOf('\n');
				while (nlIdx >= 0) {
					const line = lineBuf.slice(0, nlIdx).trim();
					lineBuf = lineBuf.slice(nlIdx + 1);
					if (line.startsWith('{')) {
						try {
							const parsed = JSON.parse(line) as Record<string, unknown>;
							if (parsed.id === targetResponseId) {
								matchedMessage = parsed;
								terminateAndResolve();
								return;
							}
						} catch {
							// ignore non-JSON line
						}
					}
					nlIdx = lineBuf.indexOf('\n');
				}
			});

			child.once('error', () => terminateAndResolve());
			child.once('close', () => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(matchedMessage);
				}
			});

			try {
				for (const req of requests) {
					child.stdin.write(`${JSON.stringify(req)}\n`);
				}
			} catch {
				terminateAndResolve();
			}
		});
	}

	private buildRemotePosixPathBootstrap(): string {
		return [
			`for _d in /usr/local/bin /opt/homebrew/bin "$HOME/.cargo/bin" "$HOME/.opencode/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/.local/node-current/bin" "$HOME/.gemini/bin"; do if [ -d "$_d" ]; then PATH="$_d:$PATH"; fi; done`,
			`if [ -d "$HOME/.nvm/versions/node" ]; then for _nv in $(ls -1d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V); do PATH="$_nv:$PATH"; done; fi`,
			`export PATH`,
			`if [ -n "\${HTTP_PROXY:-}\${HTTPS_PROXY:-}\${ALL_PROXY:-}\${http_proxy:-}\${https_proxy:-}\${all_proxy:-}" ]; then _np="\${NO_PROXY:-\${no_proxy:-}}"; for _h in 127.0.0.1 localhost ::1; do case ",$_np," in *,"$_h",*) ;; *) _np="\${_np:+$_np,}$_h" ;; esac; done; NO_PROXY="$_np"; no_proxy="$_np"; export NO_PROXY no_proxy; fi`,
		].join('; ');
	}

	private async probeRemoteEngines(alias: string, hostOs: 'linux' | 'macos' | 'windows' = 'linux'): Promise<{ readonly engines: readonly AdeEngineId[]; readonly claudeNeedsSubdirCopy: boolean }> {
		const svc = this.cloudHosts as (IAdeCloudHostBackendService & {
			remoteExecCommand?: (authority: string, opts: { command: string; timeoutMs?: number; maxOutputChars?: number }) => Promise<{ exitCode: number; outputTail: string }>;
		}) | undefined;
		if (!svc?.remoteExecCommand) {
			return { engines: [], claudeNeedsSubdirCopy: false };
		}
		const probeScript = hostOs === 'windows'
			? [
				`$ErrorActionPreference='SilentlyContinue'`,
				`$_dirs = @((Join-Path $env:USERPROFILE '.gemini\\bin'), (Join-Path $env:USERPROFILE '.local\\node-current\\bin'), (Join-Path $env:USERPROFILE '.bun\\bin'), (Join-Path $env:USERPROFILE '.volta\\bin'), (Join-Path $env:USERPROFILE '.npm-global\\bin'), (Join-Path $env:APPDATA 'npm'), (Join-Path $env:USERPROFILE '.local\\bin'), (Join-Path $env:USERPROFILE '.cargo\\bin'), (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links'), (Join-Path $env:LOCALAPPDATA 'Programs\\claude'), (Join-Path $env:ProgramFiles 'nodejs')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }`,
				`if ($_dirs.Count -gt 0) { $env:Path = (($_dirs -join ';') + ';' + $env:Path) }`,
				`foreach ($pair in @('claude:claude','codex:codex','kilo:kilo','kilo:kilocode','opencode:opencode','dsh:dsh','antigravity:agy','antigravity:antigravity','cline:cline','pi:pi')) { $p=$pair -split ':',2; if (Get-Command $p[1] -ErrorAction SilentlyContinue) { Write-Output ('ENG' + [char]9 + $p[0]) } }`,
				`if (Get-Command claude -ErrorAction SilentlyContinue) { $v=(claude --version 2>$null | Select-Object -First 1); if ($v) { Write-Output ('CLAUDE_VER' + [char]9 + $v) } }`,
				`if ($env:CLAUDE_CODE_USE_BEDROCK -eq '1' -or $env:CLAUDE_CODE_USE_VERTEX -eq '1') { Write-Output ('CLAUDE_BEDROCK' + [char]9 + '1') }`,
				`exit 0`,
			].join('; ')
			: [
				this.buildRemotePosixPathBootstrap(),
				`for pair in "claude:claude" "codex:codex" "kilo:kilo" "kilo:kilocode" "opencode:opencode" "dsh:dsh" "antigravity:agy" "antigravity:antigravity" "cline:cline" "pi:pi"; do eng="\${pair%%:*}"; bin="\${pair#*:}"; if command -v "$bin" >/dev/null 2>&1; then printf 'ENG\\t%s\\n' "$eng"; fi; done`,
				`if command -v claude >/dev/null 2>&1; then printf 'CLAUDE_VER\\t%s\\n' "$(claude --version 2>/dev/null | head -n 1)"; fi`,
				`if [ "\${CLAUDE_CODE_USE_BEDROCK:-}" = "1" ] || [ "\${CLAUDE_CODE_USE_VERTEX:-}" = "1" ]; then printf 'CLAUDE_BEDROCK\\t1\\n'; fi`,
			].join('; ');
		const res = await svc.remoteExecCommand(alias, { command: probeScript, timeoutMs: 10_000, maxOutputChars: 4_000 });
		if (res.exitCode !== 0) {
			return { engines: [], claudeNeedsSubdirCopy: false };
		}
		const foundSet = new Set<AdeEngineId>();
		let claudeVerTuple: [number, number, number] | undefined;
		let claudeBedrock = false;
		for (const line of res.outputTail.split(/\r?\n/)) {
			const [tag, val] = line.trim().split('\t');
			if (tag === 'ENG' && val && (ADE_REGISTERED_ENGINES as readonly string[]).includes(val)) {
				foundSet.add(val as AdeEngineId);
			} else if (tag === 'CLAUDE_VER' && val) {
				claudeVerTuple = parseSemverTuple(val);
			} else if (tag === 'CLAUDE_BEDROCK') {
				claudeBedrock = true;
			}
		}
		const ordered = ADE_REGISTERED_ENGINES.filter(e => foundSet.has(e));
		const claudeNeedsSubdirCopy = claudeBedrock || (foundSet.has('claude') && (!claudeVerTuple || compareSemver(claudeVerTuple, [2, 1, 277]) < 0));
		return { engines: ordered, claudeNeedsSubdirCopy };
	}

	private async probeRemoteEngineModels(
		alias: string,
		hostOs: 'linux' | 'macos' | 'windows',
		engine: AdeEngineId,
	): Promise<IAdeProbedEngineMetadata> {
		const fallback = this.getDefaultMetadata(engine);
		const svc = this.cloudHosts as (IAdeCloudHostBackendService & {
			remoteExecCommand?: (authority: string, opts: { command: string; timeoutMs?: number; maxOutputChars?: number }) => Promise<{ exitCode: number; outputTail: string }>;
		}) | undefined;
		if (!svc?.remoteExecCommand) {
			return fallback;
		}

		const relFilesByEngine: Readonly<Record<AdeEngineId, readonly [string, string][]>> = {
			claude: [
				['claude_settings', '.claude/settings.json'],
			],
			codex: [
				['codex_toml', '.codex/config.toml'],
				['codex_cache', '.codex/models_cache.json'],
			],
			kilo: [
				['kilo_jsonc', '.config/kilo/kilo.jsonc'],
				['kilo_json', '.config/kilo/kilo.json'],
				['kilo_oc', '.config/kilo/opencode.json'],
			],
			opencode: [
				['oc_jsonc', '.config/opencode/opencode.jsonc'],
				['oc_json', '.config/opencode/opencode.json'],
			],
			pi: [
				['pi_settings', '.pi/agent/settings.json'],
				['pi_models', '.pi/agent/models.json'],
				['pi_store', '.pi/agent/models-store.json'],
			],
			antigravity: [
				['agy_s1', '.gemini/antigravity/settings.json'],
				['agy_s2', '.gemini/antigravity-cli/settings.json'],
				['agy_s3', '.gemini/settings.json'],
			],
			dsh: [
				['dsh_patch', '.dsh/cordis.patch.yml'],
				['dsh_yml', '.dsh/cordis.yml'],
				['dsh_cfg', '.dsh/config.json'],
				['dsh_set', '.dsh/settings.json'],
			],
			cline: [
				['cline_models', '.cline/data/settings/models.json'],
				['cline_provs', '.cline/data/settings/providers.json'],
				['cline_gs1', '.cline/data/settings/globalState.json'],
				['cline_gs2', '.cline/data/globalState.json'],
				['cline_gs3', '.cline/globalState.json'],
			],
		};

		const filesToRead = relFilesByEngine[engine];
		let script: string;
		if (hostOs === 'windows') {
			const psFileReads = filesToRead.map(([key, rel]) => {
				const winRel = rel.replace(/\//g, '\\');
				return `$_p = Join-Path $env:USERPROFILE '${winRel}'; if (Test-Path -LiteralPath $_p) { $_b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_p)); Write-Output ('B64' + [char]9 + '${key}' + [char]9 + $_b) }`;
			});
			const psCli = engine === 'kilo'
				? `if (Get-Command kilo -ErrorAction SilentlyContinue) { $_o = (kilo models 2>$null | Out-String); if ($_o) { Write-Output ('B64' + [char]9 + 'cli_out' + [char]9 + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_o))) } }`
				: engine === 'opencode'
					? `if (Get-Command opencode -ErrorAction SilentlyContinue) { $_o = (opencode models 2>$null | Out-String); if ($_o) { Write-Output ('B64' + [char]9 + 'cli_out' + [char]9 + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_o))) } }`
					: engine === 'pi'
						? `if (Get-Command pi -ErrorAction SilentlyContinue) { $_o = (pi --list-models 2>$null | Out-String); if ($_o) { Write-Output ('B64' + [char]9 + 'cli_out' + [char]9 + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_o))) } }`
						: engine === 'antigravity'
							? `if (Get-Command agy -ErrorAction SilentlyContinue) { $_o = (agy models 2>$null | Out-String); if ($_o) { Write-Output ('B64' + [char]9 + 'cli_out' + [char]9 + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_o))) } }`
							: '';
			script = [
				`$ErrorActionPreference='SilentlyContinue'`,
				`$_dirs = @((Join-Path $env:USERPROFILE '.gemini\\bin'), (Join-Path $env:USERPROFILE '.local\\node-current\\bin'), (Join-Path $env:USERPROFILE '.bun\\bin'), (Join-Path $env:USERPROFILE '.volta\\bin'), (Join-Path $env:USERPROFILE '.npm-global\\bin'), (Join-Path $env:APPDATA 'npm'), (Join-Path $env:USERPROFILE '.local\\bin')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }`,
				`if ($_dirs.Count -gt 0) { $env:Path = (($_dirs -join ';') + ';' + $env:Path) }`,
				`if ($env:HTTP_PROXY -or $env:HTTPS_PROXY -or $env:ALL_PROXY -or $env:http_proxy -or $env:https_proxy -or $env:all_proxy) { $_np = @((($env:NO_PROXY, $env:no_proxy) -join ',') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }); foreach ($_h in @('127.0.0.1','localhost','::1')) { if ($_np -notcontains $_h) { $_np += $_h } }; $env:NO_PROXY = ($_np -join ','); $env:no_proxy = $env:NO_PROXY }`,
				...psFileReads,
				...(psCli ? [psCli] : []),
				`exit 0`,
			].join('; ');
		} else {
			const shFileReads = filesToRead.map(([key, rel]) =>
				`if [ -f "$HOME/${rel}" ]; then printf 'B64\\t${key}\\t%s\\n' "$(base64 < "$HOME/${rel}" 2>/dev/null | tr -d '\\r\\n')"; fi`,
			);
			const runBoundedPosix = (cmdExpr: string) =>
				`_out="$(if command -v timeout >/dev/null 2>&1; then timeout 4 ${cmdExpr}; elif command -v python3 >/dev/null 2>&1; then python3 -c 'import subprocess,sys; p=subprocess.run(sys.argv[1:], capture_output=True, timeout=4); sys.stdout.buffer.write(p.stdout)' ${cmdExpr}; else ${cmdExpr}; fi 2>/dev/null)"; if [ -n "$_out" ]; then printf 'B64\\tcli_out\\t%s\\n' "$(printf '%s' "$_out" | base64 2>/dev/null | tr -d '\\r\\n')"; fi`;
			const shCli = engine === 'kilo'
				? `if command -v kilo >/dev/null 2>&1; then ${runBoundedPosix('kilo models')}; elif command -v kilocode >/dev/null 2>&1; then ${runBoundedPosix('kilocode models')}; fi`
				: engine === 'opencode'
					? `if command -v opencode >/dev/null 2>&1; then ${runBoundedPosix('opencode models')}; fi`
					: engine === 'pi'
						? `if command -v pi >/dev/null 2>&1; then ${runBoundedPosix('pi --list-models')}; fi`
						: engine === 'antigravity'
							? `if command -v agy >/dev/null 2>&1; then ${runBoundedPosix('agy models')}; elif command -v antigravity >/dev/null 2>&1; then ${runBoundedPosix('antigravity models')}; fi`
							: '';
			script = [
				this.buildRemotePosixPathBootstrap(),
				...shFileReads,
				...(shCli ? [shCli] : []),
				`exit 0`,
			].join('; ');
		}

		const res = await svc.remoteExecCommand(alias, {
			command: script,
			timeoutMs: 12_000,
			maxOutputChars: 131_072,
		}).catch(() => ({ exitCode: 1, outputTail: '' }));
		if (res.exitCode !== 0 || !res.outputTail) {
			return fallback;
		}

		const blobs = new Map<string, string>();
		for (const rawLine of res.outputTail.split(/\r?\n/)) {
			const parts = rawLine.trim().split('\t');
			if (parts[0] === 'B64' && parts[1] && parts[2]) {
				try {
					blobs.set(parts[1], Buffer.from(parts[2], 'base64').toString('utf8'));
				} catch {
					// ignore malformed b64
				}
			}
		}

		switch (engine) {
			case 'claude': {
				const parsed = parseClaudeModelsFromSettings(blobs.get('claude_settings'));
				return { engine, models: parsed.models, efforts: fallback.efforts, defaultEffort: fallback.defaultEffort };
			}
			case 'codex': {
				const parsed = parseCodexModelsFromSources({
					configToml: blobs.get('codex_toml'),
					modelsCacheJson: blobs.get('codex_cache'),
				});
				return { engine, models: parsed.models, efforts: parsed.efforts, defaultEffort: parsed.defaultEffort };
			}
			case 'kilo':
				return {
					engine,
					models: parseKiloModelsFromSources([blobs.get('kilo_jsonc'), blobs.get('kilo_json'), blobs.get('kilo_oc')], blobs.get('cli_out')),
					efforts: fallback.efforts,
					defaultEffort: fallback.defaultEffort,
				};
			case 'opencode':
				return {
					engine,
					models: parseOpenCodeModelsFromSources([blobs.get('oc_jsonc'), blobs.get('oc_json')], blobs.get('cli_out')),
					efforts: fallback.efforts,
					defaultEffort: fallback.defaultEffort,
				};
			case 'pi':
				return {
					engine,
					models: parsePiModelsFromSources({
						settingsJson: blobs.get('pi_settings'),
						modelsJson: blobs.get('pi_models'),
						modelsStoreJson: blobs.get('pi_store'),
						listModelsCliOutput: blobs.get('cli_out'),
					}),
					efforts: fallback.efforts,
					defaultEffort: fallback.defaultEffort,
				};
			case 'antigravity':
				return {
					engine,
					models: parseAntigravityModelsFromSources(blobs.get('cli_out'), [blobs.get('agy_s1'), blobs.get('agy_s2'), blobs.get('agy_s3')]),
					efforts: fallback.efforts,
					defaultEffort: fallback.defaultEffort,
				};
			case 'dsh':
				return {
					engine,
					models: parseDshModelsFromSources({
						yamlTexts: [blobs.get('dsh_patch'), blobs.get('dsh_yml')],
						jsonTexts: [blobs.get('dsh_cfg'), blobs.get('dsh_set')],
					}),
					efforts: fallback.efforts,
					defaultEffort: fallback.defaultEffort,
				};
			case 'cline':
				return {
					engine,
					models: parseClineModelsFromSources({
						modelsJson: blobs.get('cline_models'),
						providersJson: blobs.get('cline_provs'),
						globalStateJsons: [blobs.get('cline_gs1'), blobs.get('cline_gs2'), blobs.get('cline_gs3')],
					}),
					efforts: fallback.efforts,
					defaultEffort: fallback.defaultEffort,
				};
		}
	}
}
