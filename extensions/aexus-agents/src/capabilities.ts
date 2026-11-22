/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CloudHostTarget } from './cloudTransport';

export type RemoteTextFilesBatchReader = (
	target: CloudHostTarget,
	remotePaths: readonly string[],
) => Promise<Map<string, string | undefined>>;

let registeredRemoteBatchReader: RemoteTextFilesBatchReader | undefined;

export function registerRemoteCapabilitiesReader(reader: RemoteTextFilesBatchReader): void {
	registeredRemoteBatchReader = reader;
}

function joinRemoteCapabilityPath(hostOs: CloudHostTarget['os'], ...segments: string[]): string {
	return hostOs === 'windows' ? path.win32.join(...segments) : path.posix.join(...segments);
}

export type EngineId = 'aexus-claude' | 'aexus-codex' | 'aexus-kilo' | 'aexus-opencode' | 'aexus-dsh' | 'aexus-antigravity' | 'aexus-cline' | 'aexus-pi';

export interface SessionConfigState {
	model?: string;
	thinking?: string;
	mode?: string;
	permissionMode?: string;
	sandboxMode?: string;
	webSearch?: string;
	secretaryEngineId?: EngineId;
}

export interface DiscoveredOptionItem {
	id: string;
	name: string;
	description?: string;
	default?: boolean;
	slashCommand?: string;
	tooltip?: string;
}

/** Parses the tab-separated model table printed by the Antigravity `agy` CLI. */
export function parseAgyModelsOutput(output: string): Array<{ id: string; name: string }> {
	const models: Array<{ id: string; name: string }> = [];
	const seen = new Set<string>();
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || /^fetching\b/i.test(line)) {
			continue;
		}
		const tabIdx = line.indexOf('\t');
		let id: string;
		let name: string;
		if (tabIdx > 0) {
			id = line.slice(0, tabIdx).trim();
			name = line.slice(tabIdx + 1).trim() || id;
		} else {
			const match = /^([A-Za-z0-9._:/-]+)\s{2,}(.+)$/.exec(line);
			if (!match) {
				continue;
			}
			id = match[1].trim();
			name = match[2].trim() || id;
		}
		if (!id || /\s/.test(id) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		models.push({ id, name });
	}
	return models;
}

export interface DiscoveredOptionGroup {
	id: string;
	name: string;
	description?: string;
	items: DiscoveredOptionItem[];
	selectedId: string;
}

export interface DiscoveredSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	source: 'builtin' | 'local' | 'user' | 'plugin';
	kind: 'command' | 'skill' | 'prompt' | 'workflow' | 'macro';
	filePath?: string;
	engineId?: EngineId;
}

export interface DiscoveredCustomizationFile {
	uriPath: string;
	isBuiltin: boolean;
	type: 'skill' | 'prompt' | 'agent' | 'instructions' | 'hook' | 'plugin';
	name: string;
	description?: string;
	source: 'local' | 'user' | 'plugin' | 'builtin';
	userInvocable?: boolean;
}

const CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 400;

interface CacheEntry<T> {
	readonly value: T;
	readonly expiresAt: number;
}

interface DirEntryInfo {
	readonly name: string;
	readonly kind: 'file' | 'directory';
}

const textFileCache = new Map<string, CacheEntry<string | undefined>>();
const directoryCache = new Map<string, CacheEntry<readonly DirEntryInfo[]>>();

async function readTextFileCached(filePath: string): Promise<string | undefined> {
	const absolute = path.resolve(filePath);
	const now = Date.now();
	const cached = textFileCache.get(absolute);
	if (cached && cached.expiresAt > now) {
		return cached.value;
	}
	let value: string | undefined;
	try {
		value = await fs.readFile(absolute, 'utf8');
	} catch {
		value = undefined;
	}
	if (textFileCache.size > MAX_CACHE_ENTRIES) {
		textFileCache.clear();
	}
	textFileCache.set(absolute, { value, expiresAt: now + CACHE_TTL_MS });
	return value;
}

async function readDirectoryCached(dirPath: string): Promise<readonly DirEntryInfo[]> {
	const absolute = path.resolve(dirPath);
	const now = Date.now();
	const cached = directoryCache.get(absolute);
	if (cached && cached.expiresAt > now) {
		return cached.value;
	}
	const entries: DirEntryInfo[] = [];
	try {
		for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				entries.push({ name: entry.name, kind: 'directory' });
			} else if (entry.isFile()) {
				entries.push({ name: entry.name, kind: 'file' });
			} else if (entry.isSymbolicLink()) {
				try {
					const stat = await fs.stat(path.join(absolute, entry.name));
					entries.push({ name: entry.name, kind: stat.isDirectory() ? 'directory' : 'file' });
				} catch { /* Ignore broken symbolic links. */ }
			}
		}
	} catch { /* Missing or unreadable directory. */ }
	if (directoryCache.size > MAX_CACHE_ENTRIES) {
		directoryCache.clear();
	}
	directoryCache.set(absolute, { value: entries, expiresAt: now + CACHE_TTL_MS });
	return entries;
}

async function listFiles(dirPath: string, extension: string | undefined, recursive: boolean, maxDepth: number): Promise<string[]> {
	const results: string[] = [];
	const normalizedExtension = extension?.toLowerCase();
	const visit = async (current: string, depth: number): Promise<void> => {
		if (depth > maxDepth) {
			return;
		}
		for (const entry of await readDirectoryCached(current)) {
			const fullPath = path.join(current, entry.name);
			if (entry.kind === 'directory') {
				if (recursive) {
					await visit(fullPath, depth + 1);
				}
			} else if (!normalizedExtension || entry.name.toLowerCase().endsWith(normalizedExtension)) {
				results.push(fullPath);
			}
		}
	};
	await visit(path.resolve(dirPath), 0);
	return results;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stripJsoncComments(text: string): string {
	let result = '';
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const character = text[i];
		const next = i + 1 < text.length ? text[i + 1] : '';
		if (inLineComment) {
			if (character === '\n') {
				inLineComment = false;
				result += character;
			}
			continue;
		}
		if (inBlockComment) {
			if (character === '*' && next === '/') {
				inBlockComment = false;
				i++;
			} else if (character === '\n') {
				result += character;
			}
			continue;
		}
		if (inString) {
			result += character;
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
			result += character;
			continue;
		}
		if (character === '/' && next === '/') {
			inLineComment = true;
			i++;
			continue;
		}
		if (character === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		result += character;
	}
	return result;
}

function parseJsonLoose(text: string): unknown {
	const stripped = stripJsoncComments(text).replace(/,(\s*[}\]])/g, '$1');
	try {
		return JSON.parse(stripped) as unknown;
	} catch {
		return undefined;
	}
}

interface MarkdownParts {
	readonly body: string;
	readonly frontmatter: Readonly<Record<string, string>>;
}

function parseFrontmatterValue(rawValue: string): string {
	const trimmed = rawValue.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		const doubleQuote = String.fromCharCode(34);
	const singleQuote = String.fromCharCode(39);
	if ((first === doubleQuote && last === doubleQuote) || (first === singleQuote && last === singleQuote)) {
			return trimmed.slice(1, -1).trim();
		}
	}
	return trimmed;
}

function splitFrontmatter(text: string): MarkdownParts {
	const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	if (lines.length === 0 || lines[0].trim() !== '---') {
		return { body: normalized, frontmatter: {} };
	}
	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === '---' || line === '...') {
			endIndex = i;
			break;
		}
	}
	if (endIndex < 0) {
		return { body: normalized, frontmatter: {} };
	}
	const frontmatter: Record<string, string> = {};
	for (let i = 1; i < endIndex; i++) {
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
		if (!match) {
			continue;
		}
		const rawValue = match[2];
		if (!rawValue) {
			continue;
		}
		frontmatter[match[1]] = parseFrontmatterValue(rawValue);
	}
	return { body: lines.slice(endIndex + 1).join('\n').replace(/^\n+/, ''), frontmatter };
}

interface MarkdownMetadata {
	name?: string;
	description?: string;
	argumentHint?: string;
}

function readMarkdownMetadata(text: string): MarkdownMetadata {
	const frontmatter = splitFrontmatter(text).frontmatter;
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		argumentHint: frontmatter['argument-hint'],
	};
}

interface ModelConfigRead {
	defaultModel?: string;
	replaceBuiltInOptions?: boolean;
	models: DiscoveredOptionItem[];
}

async function readModelConfigFromCandidates(
	candidates: readonly string[],
	reader: (text: string) => ModelConfigRead,
	readText: (filePath: string) => Promise<string | undefined> = readTextFileCached,
): Promise<ModelConfigRead> {
	for (const candidate of candidates) {
		const text = await readText(candidate);
		if (text === undefined) {
			continue;
		}
		const read = reader(text);
		if (read.defaultModel || read.models.length > 0) {
			return read;
		}
	}
	return { models: [] };
}

function modelItemsFromUnknown(value: unknown): DiscoveredOptionItem[] {
	const items: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	const addItem = (idRaw: unknown, nameRaw?: unknown, descriptionRaw?: unknown): void => {
		const id = stringValue(idRaw);
		if (!id || seen.has(id)) {
			return;
		}
		seen.add(id);
		items.push({ id, name: stringValue(nameRaw) ?? id, description: stringValue(descriptionRaw) });
	};
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry === 'string') {
				addItem(entry, entry);
				continue;
			}
			const record = asRecord(entry);
			if (!record) {
				continue;
			}
			addItem(record.id ?? record.model ?? record.value, record.name ?? record.label, record.description);
		}
		return items;
	}
	const record = asRecord(value);
	if (record) {
		for (const key of Object.keys(record)) {
			addItem(key, key);
		}
	}
	return items;
}

function providerModelItems(providerValue: unknown): DiscoveredOptionItem[] {
	const provider = asRecord(providerValue);
	if (!provider) {
		return [];
	}
	const items: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	const addProviderModel = (providerId: string, modelId: string, modelRecord?: Record<string, unknown>): void => {
		const fullId = modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
		if (!modelId || seen.has(fullId)) {
			return;
		}
		seen.add(fullId);
		const displayName = stringValue(modelRecord?.name) ?? stringValue(modelRecord?.label);
		items.push(displayName && displayName !== fullId
			? { id: fullId, name: displayName, description: fullId }
			: { id: fullId, name: fullId });
	};
	for (const [providerId, providerEntry] of Object.entries(provider)) {
		const providerRecord = asRecord(providerEntry);
		const rawModels = providerRecord?.models;
		if (Array.isArray(rawModels)) {
			for (const entry of rawModels) {
				if (typeof entry === 'string') {
					const modelId = stringValue(entry);
					if (modelId) {
						addProviderModel(providerId, modelId);
					}
					continue;
				}
				const modelRecord = asRecord(entry);
				const modelId = stringValue(modelRecord?.id) ?? stringValue(modelRecord?.model) ?? stringValue(modelRecord?.name);
				if (modelId) {
					addProviderModel(providerId, modelId, modelRecord);
				}
			}
			continue;
		}
		const models = asRecord(rawModels);
		if (!models) {
			continue;
		}
		for (const [modelId, modelEntry] of Object.entries(models)) {
			addProviderModel(providerId, modelId, asRecord(modelEntry));
		}
	}
	return items;
}

function readClaudeSettings(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const models: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	const addModel = (idRaw: unknown, nameRaw?: unknown, descriptionRaw?: unknown): void => {
		const id = stringValue(idRaw);
		if (!id || seen.has(id)) {
			return;
		}
		seen.add(id);
		const label = stringValue(nameRaw);
		const desc = stringValue(descriptionRaw);
		models.push({
			id,
			name: label ?? id,
			description: label && label !== id ? (desc ? `${id} · ${desc}` : id) : desc,
		});
	};

	const picker = parsed.modelPicker;
	const pickerRecord = asRecord(picker);
	const replaceBuiltInOptions = pickerRecord?.replaceBuiltInOptions === true;
	const pickerOptions = Array.isArray(picker)
		? picker
		: pickerRecord && Array.isArray(pickerRecord.options) ? pickerRecord.options : [];
	for (const option of pickerOptions) {
		if (typeof option === 'string') {
			addModel(option, option);
			continue;
		}
		const optionRecord = asRecord(option);
		if (!optionRecord) {
			continue;
		}
		addModel(optionRecord.model ?? optionRecord.id ?? optionRecord.value, optionRecord.label ?? optionRecord.name, optionRecord.description);
	}

	const model = parsed.model;
	if (typeof model === 'string') {
		addModel(model, model);
	} else {
		const modelRecord = asRecord(model);
		if (modelRecord) {
			addModel(modelRecord.id ?? modelRecord.model, modelRecord.name ?? modelRecord.label, modelRecord.description);
		}
	}

	const envRecord = asRecord(parsed.env);
	if (envRecord) {
		addModel(
			envRecord.ANTHROPIC_CUSTOM_MODEL_OPTION,
			envRecord.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,
			envRecord.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION,
		);
		addModel(envRecord.ANTHROPIC_MODEL);
		if (!replaceBuiltInOptions) {
			addModel(envRecord.ANTHROPIC_DEFAULT_SONNET_MODEL, envRecord.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME);
			addModel(envRecord.ANTHROPIC_DEFAULT_OPUS_MODEL, envRecord.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME);
			addModel(envRecord.ANTHROPIC_DEFAULT_HAIKU_MODEL, envRecord.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME);
		}
	}

	if (!replaceBuiltInOptions) {
		for (const item of modelItemsFromUnknown(parsed.modelSettings)) {
			addModel(item.id, item.name);
		}
	}

	const resolvedDefault = stringValue(model) ?? stringValue(envRecord?.ANTHROPIC_MODEL);
	return { defaultModel: resolvedDefault, replaceBuiltInOptions, models };
}

function readCodexModelsCache(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const list = Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed.data) ? parsed.data : [];
	const models: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	for (const entry of list) {
		const rec = asRecord(entry);
		const visibility = stringValue(rec?.visibility)?.toLowerCase();
		if (visibility === 'hide' || visibility === 'hidden' || rec?.hidden === true) {
			continue;
		}
		const id = stringValue(rec?.slug) ?? stringValue(rec?.model) ?? stringValue(rec?.id);
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const display = stringValue(rec?.display_name) ?? stringValue(rec?.displayName) ?? id;
		const desc = stringValue(rec?.description);
		models.push({
			id,
			name: display,
			description: display !== id ? (desc ? `${id} · ${desc}` : id) : desc,
		});
	}
	return { models };
}

function readTomlModel(text: string): string | undefined {
	const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(text);
	if (!match) {
		return undefined;
	}
	return (match[1] ?? match[2] ?? '').trim() || undefined;
}

function readKiloConfig(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		const fallback = /"model"\s*:\s*"([^"]+)"/.exec(text);
		const defaultModel = fallback ? fallback[1].trim() : undefined;
		return { defaultModel, models: defaultModel ? [{ id: defaultModel, name: defaultModel }] : [] };
	}
	const defaultModel = stringValue(parsed.model);
	const providerModels = providerModelItems(parsed.provider);
	const models: DiscoveredOptionItem[] = [];
	if (defaultModel && !providerModels.some(m => m.id === defaultModel)) {
		models.push({ id: defaultModel, name: defaultModel });
	}
	models.push(...providerModels);
	return { defaultModel, models };
}

function readOpenCodeConfig(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		const fallback = /"model"\s*:\s*"([^"]+)"/.exec(text);
		const defaultModel = fallback ? fallback[1].trim() : undefined;
		return { defaultModel, models: defaultModel ? [{ id: defaultModel, name: defaultModel }] : [] };
	}
	const defaultModel = stringValue(parsed.model);
	const smallModel = stringValue(parsed.small_model);
	const providerModels = providerModelItems(parsed.provider);
	const models: DiscoveredOptionItem[] = [];
	if (defaultModel && !providerModels.some(m => m.id === defaultModel)) {
		models.push({ id: defaultModel, name: defaultModel });
	}
	if (smallModel && !providerModels.some(m => m.id === smallModel)) {
		models.push({ id: smallModel, name: `${smallModel} (Small)` });
	}
	for (const item of providerModels) {
		if (smallModel && item.id === smallModel) {
			models.push({ ...item, name: item.name.includes('(Small)') ? item.name : `${item.name} (Small)` });
		} else {
			models.push(item);
		}
	}
	return { defaultModel, models };
}

function readPiSettings(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const provider = stringValue(parsed.defaultProvider);
	const model = stringValue(parsed.defaultModel);
	if (!model) {
		return { models: [] };
	}
	const id = provider && !model.includes('/') ? `${provider}/${model}` : model;
	return { defaultModel: id, models: [{ id, name: id }] };
}

function readAntigravitySettings(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const defaultModel = stringValue(parsed.model) ?? stringValue(parsed.defaultModel);
	const models: DiscoveredOptionItem[] = [];
	if (defaultModel) {
		models.push({ id: defaultModel, name: defaultModel });
	}
	models.push(...modelItemsFromUnknown(parsed.modelSettings));
	models.push(...modelItemsFromUnknown(parsed.models));
	return { defaultModel, models };
}

function readDshJson(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const defaultModel = stringValue(parsed.model) ?? stringValue(parsed.defaultModel) ?? stringValue(parsed.modelId);
	const models: DiscoveredOptionItem[] = [];
	if (defaultModel) {
		models.push({ id: defaultModel, name: defaultModel });
	}
	models.push(...modelItemsFromUnknown(parsed.modelSettings));
	return { defaultModel, models };
}

function readPiModelsJson(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const providers = asRecord(parsed.providers);
	if (!providers) {
		return { models: modelItemsFromUnknown(parsed.models) };
	}
	const models: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	for (const [providerId, providerEntry] of Object.entries(providers)) {
		const provRec = asRecord(providerEntry);
		const provModels = Array.isArray(provRec?.models) ? provRec.models : [];
		for (const m of provModels) {
			if (typeof m === 'string') {
				const fullId = m.includes('/') ? m : `${providerId}/${m}`;
				if (!seen.has(fullId)) {
					seen.add(fullId);
					models.push({ id: fullId, name: fullId });
				}
				continue;
			}
			const mRec = asRecord(m);
			const rawId = stringValue(mRec?.id) ?? stringValue(mRec?.model);
			if (!rawId) {
				continue;
			}
			const fullId = rawId.includes('/') ? rawId : `${providerId}/${rawId}`;
			if (seen.has(fullId)) {
				continue;
			}
			seen.add(fullId);
			const display = stringValue(mRec?.name) ?? rawId;
			models.push({
				id: fullId,
				name: display === rawId ? fullId : `${display} (${providerId})`,
				description: display === rawId ? undefined : fullId,
			});
		}
	}
	return { models };
}

function readDshYaml(text: string): ModelConfigRead {
	const modelMatch = /^\s*model\s*:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m.exec(text);
	const providerMatch = /^\s*provider\s*:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/m.exec(text);
	const defaultModel = modelMatch ? modelMatch[1].trim() || undefined : undefined;
	const provider = providerMatch ? providerMatch[1].trim() || undefined : undefined;
	if (!defaultModel) {
		return { models: [] };
	}
	const tupleId = provider ? JSON.stringify([provider, defaultModel]) : defaultModel;
	return {
		defaultModel,
		models: [{ id: tupleId, name: defaultModel, description: provider ? `${provider}/${defaultModel}` : undefined }],
	};
}

function readClineModelsFile(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const providers = asRecord(parsed.providers);
	if (!providers) {
		return { models: [] };
	}
	const models: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	let defaultModel: string | undefined;
	for (const [providerId, providerEntry] of Object.entries(providers)) {
		const entryRec = asRecord(providerEntry);
		const provMeta = asRecord(entryRec?.provider);
		defaultModel ??= stringValue(provMeta?.defaultModelId);
		const modelsMap = asRecord(entryRec?.models);
		if (!modelsMap) {
			continue;
		}
		for (const [modelKey, modelVal] of Object.entries(modelsMap)) {
			const mRec = asRecord(modelVal);
			const id = stringValue(mRec?.id) ?? modelKey;
			if (!id || seen.has(id)) {
				continue;
			}
			seen.add(id);
			const name = stringValue(mRec?.name) ?? id;
			models.push({ id, name, description: `${providerId} · ${id}` });
		}
	}
	return { defaultModel, models };
}

function readClineProvidersFile(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const lastUsed = stringValue(parsed.lastUsedProvider);
	const providers = asRecord(parsed.providers);
	if (!providers) {
		return { models: [] };
	}
	const models: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	let defaultModel: string | undefined;
	const orderedEntries = lastUsed && providers[lastUsed]
		? [[lastUsed, providers[lastUsed]] as const, ...Object.entries(providers).filter(([k]) => k !== lastUsed)]
		: Object.entries(providers);
	for (const [providerId, providerEntry] of orderedEntries) {
		const settings = asRecord(asRecord(providerEntry)?.settings);
		const model = stringValue(settings?.model);
		if (!model || seen.has(model)) {
			continue;
		}
		seen.add(model);
		if (providerId === lastUsed || !defaultModel) {
			defaultModel = model;
		}
		models.push({ id: model, name: model, description: `${providerId} · ${model}` });
	}
	return { defaultModel, models };
}

function readClineGlobalState(text: string): ModelConfigRead {
	const parsed = asRecord(parseJsonLoose(text));
	if (!parsed) {
		return { models: [] };
	}
	const actModel = stringValue(parsed.actModeApiModelId);
	const planModel = stringValue(parsed.planModeApiModelId);
	const generalModel = stringValue(parsed.model);
	const models: DiscoveredOptionItem[] = [];
	if (actModel) {
		models.push({ id: actModel, name: `${actModel} (Act)` });
	}
	if (planModel) {
		models.push({ id: planModel, name: `${planModel} (Plan)` });
	}
	if (generalModel) {
		models.push({ id: generalModel, name: generalModel });
	}
	return { defaultModel: actModel ?? planModel ?? generalModel, models };
}

const ENGINE_INFO: ReadonlyArray<{ id: EngineId; name: string; description: string }> = [
	{ id: 'aexus-claude', name: 'Claude Code', description: 'Anthropic Claude Code coding agent' },
	{ id: 'aexus-codex', name: 'Codex', description: 'OpenAI Codex coding agent' },
	{ id: 'aexus-kilo', name: 'Kilo Code', description: 'Kilo Code coding agent' },
	{ id: 'aexus-opencode', name: 'OpenCode', description: 'OpenCode coding agent' },
	{ id: 'aexus-dsh', name: 'DeepSeek Harness', description: 'DeepSeek Harness coding agent' },
	{ id: 'aexus-antigravity', name: 'Google Antigravity', description: 'Google Antigravity coding agent' },
	{ id: 'aexus-cline', name: 'Cline', description: 'Cline coding agent' },
	{ id: 'aexus-pi', name: 'Pi', description: 'Pi coding agent' },
];

const CLAUDE_ALIAS_MODELS: readonly DiscoveredOptionItem[] = [
	{ id: 'sonnet', name: 'Sonnet' },
	{ id: 'opus', name: 'Opus' },
	{ id: 'haiku', name: 'Haiku' },
	{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
	{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
];

const CODEX_COMMON_MODELS: readonly DiscoveredOptionItem[] = [
	{ id: 'gpt-5', name: 'GPT-5' },
	{ id: 'gpt-5-mini', name: 'GPT-5 Mini' },
	{ id: 'o3', name: 'o3' },
	{ id: 'o4-mini', name: 'o4-mini' },
	{ id: 'codex-mini-latest', name: 'Codex Mini' },
];

const PI_FALLBACK_MODELS: readonly DiscoveredOptionItem[] = [
	{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
	{ id: 'gpt-5', name: 'GPT-5' },
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
	{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
];

const ANTIGRAVITY_MODELS: readonly DiscoveredOptionItem[] = [
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
	{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
	{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
];

const DSH_KNOWN_MODELS: readonly DiscoveredOptionItem[] = [
	{ id: '["deepseek-official","deepseek-reasoner"]', name: 'deepseek-reasoner', description: 'deepseek-official/deepseek-reasoner' },
	{ id: '["deepseek-official","deepseek-chat"]', name: 'deepseek-chat', description: 'deepseek-official/deepseek-chat' },
];

const CLINE_KNOWN_MODELS: readonly DiscoveredOptionItem[] = [
	{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
	{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
	{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
	{ id: 'gpt-5', name: 'GPT-5' },
	{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
];

function appendOptionItems(target: DiscoveredOptionItem[], seen: Set<string>, items: readonly DiscoveredOptionItem[]): void {
	for (const item of items) {
		if (seen.has(item.id)) {
			continue;
		}
		seen.add(item.id);
		target.push(item);
	}
}

function runtimeModelItems(runtimeModels: Array<{ id: string; name: string; description?: string }>): DiscoveredOptionItem[] {
	return runtimeModels.map(model => ({ id: model.id, name: model.name || model.id, description: model.description }));
}

/**
 * Discovers the models an engine can run, including the engine's resolved default model.
 * Only model identifiers are read from configuration files; credentials are never touched.
 */
export async function discoverEngineModels(
	engineId: EngineId,
	cwd: string,
	runtimeModels: Array<{ id: string; name: string; description?: string }> = [],
	runtimeDefaultModel?: string,
	customModels: readonly string[] = [],
	remoteTarget?: CloudHostTarget,
): Promise<DiscoveredOptionItem[]> {
	const home = remoteTarget ? remoteTarget.remoteHome : os.homedir();
	const join = remoteTarget
		? (...parts: string[]) => joinRemoteCapabilityPath(remoteTarget.os, ...parts)
		: (...parts: string[]) => path.join(...parts);
	const withHome = (...rel: string[]): string[] => home ? [join(home, ...rel)] : [];
	const items: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	let resolvedDefault: string | undefined;

	let readText: (filePath: string) => Promise<string | undefined> = readTextFileCached;
	if (remoteTarget) {
		const batchPaths: string[] = [];
		switch (engineId) {
			case 'aexus-claude':
				batchPaths.push(join(cwd, '.claude', 'settings.json'), ...withHome('.claude', 'settings.json'));
				break;
			case 'aexus-codex':
				batchPaths.push(
					join(cwd, '.codex', 'config.toml'), ...withHome('.codex', 'config.toml'),
					join(cwd, '.codex', 'models_cache.json'), ...withHome('.codex', 'models_cache.json'),
				);
				break;
			case 'aexus-kilo':
				batchPaths.push(join(cwd, '.kilo', 'kilo.jsonc'), ...withHome('.config', 'kilo', 'kilo.jsonc'));
				break;
			case 'aexus-opencode':
				batchPaths.push(
					join(cwd, 'opencode.json'), join(cwd, 'opencode.jsonc'),
					join(cwd, '.opencode', 'opencode.json'), join(cwd, '.opencode', 'opencode.jsonc'),
					...withHome('.config', 'opencode', 'opencode.json'), ...withHome('.config', 'opencode', 'opencode.jsonc'),
				);
				break;
			case 'aexus-pi':
				batchPaths.push(
					join(cwd, '.pi', 'settings.json'), ...withHome('.pi', 'agent', 'settings.json'),
					join(cwd, '.pi', 'models.json'), ...withHome('.pi', 'agent', 'models.json'),
				);
				break;
			case 'aexus-antigravity':
				batchPaths.push(
					join(cwd, '.gemini', 'settings.json'), join(cwd, '.gemini', 'antigravity', 'settings.json'),
					...withHome('.gemini', 'antigravity', 'settings.json'), ...withHome('.gemini', 'antigravity-cli', 'settings.json'), ...withHome('.gemini', 'settings.json'),
				);
				break;
			case 'aexus-dsh':
				batchPaths.push(
					join(cwd, '.dsh', 'config.json'), join(cwd, '.dsh', 'settings.json'),
					...withHome('.dsh', 'config.json'), ...withHome('.dsh', 'settings.json'),
					join(cwd, '.dsh', 'cordis.patch.yml'), join(cwd, '.dsh', 'cordis.yml'),
					...withHome('.dsh', 'cordis.patch.yml'), ...withHome('.dsh', 'cordis.yml'),
				);
				break;
			case 'aexus-cline':
				batchPaths.push(
					join(cwd, '.cline', 'settings', 'models.json'), ...withHome('.cline', 'data', 'settings', 'models.json'),
					join(cwd, '.cline', 'settings', 'providers.json'), ...withHome('.cline', 'data', 'settings', 'providers.json'),
					join(cwd, '.cline', 'globalState.json'), ...withHome('.cline', 'data', 'globalState.json'), ...withHome('.cline', 'globalState.json'),
				);
				break;
		}
		const batch = registeredRemoteBatchReader
			? await registeredRemoteBatchReader(remoteTarget, batchPaths).catch(() => new Map<string, string | undefined>())
			: new Map<string, string | undefined>();
		readText = async filePath => batch.get(filePath);
	}

	const appendRead = (read: ModelConfigRead): void => appendOptionItems(items, seen, read.models);

	switch (engineId) {
		case 'aexus-claude': {
			const projectSettings = await readModelConfigFromCandidates([join(cwd, '.claude', 'settings.json')], readClaudeSettings, readText);
			const homeSettings = await readModelConfigFromCandidates(withHome('.claude', 'settings.json'), readClaudeSettings, readText);
			resolvedDefault = projectSettings.defaultModel ?? homeSettings.defaultModel ?? runtimeDefaultModel;
			const replaceBuiltIns = Boolean(projectSettings.replaceBuiltInOptions || homeSettings.replaceBuiltInOptions);
			appendRead(projectSettings);
			appendRead(homeSettings);
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			if (!replaceBuiltIns || items.length === 0) {
				appendOptionItems(items, seen, CLAUDE_ALIAS_MODELS);
			}
			break;
		}
		case 'aexus-codex': {
			const config = await readModelConfigFromCandidates(
				[join(cwd, '.codex', 'config.toml'), ...withHome('.codex', 'config.toml')],
				text => {
					const model = readTomlModel(text);
					return { defaultModel: model, models: model ? [{ id: model, name: model }] : [] };
				},
				readText,
			);
			const modelsCache = await readModelConfigFromCandidates(
				[join(cwd, '.codex', 'models_cache.json'), ...withHome('.codex', 'models_cache.json')],
				readCodexModelsCache,
				readText,
			);
			resolvedDefault = config.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(modelsCache);
			appendRead(config);
			if (runtimeModels.length === 0 && modelsCache.models.length === 0) {
				appendOptionItems(items, seen, CODEX_COMMON_MODELS);
			}
			break;
		}
		case 'aexus-kilo': {
			const config = await readModelConfigFromCandidates(
				[join(cwd, '.kilo', 'kilo.jsonc'), ...withHome('.config', 'kilo', 'kilo.jsonc')],
				readKiloConfig,
				readText,
			);
			resolvedDefault = config.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(config);
			break;
		}
		case 'aexus-opencode': {
			const config = await readModelConfigFromCandidates(
				[
					join(cwd, 'opencode.json'),
					join(cwd, 'opencode.jsonc'),
					join(cwd, '.opencode', 'opencode.json'),
					join(cwd, '.opencode', 'opencode.jsonc'),
					...withHome('.config', 'opencode', 'opencode.json'),
					...withHome('.config', 'opencode', 'opencode.jsonc'),
				],
				readOpenCodeConfig,
				readText,
			);
			resolvedDefault = config.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(config);
			break;
		}
		case 'aexus-pi': {
			const config = await readModelConfigFromCandidates(
				[join(cwd, '.pi', 'settings.json'), ...withHome('.pi', 'agent', 'settings.json')],
				readPiSettings,
				readText,
			);
			const modelsFile = await readModelConfigFromCandidates(
				[join(cwd, '.pi', 'models.json'), ...withHome('.pi', 'agent', 'models.json')],
				readPiModelsJson,
				readText,
			);
			resolvedDefault = config.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(modelsFile);
			appendRead(config);
			if (runtimeModels.length === 0 && modelsFile.models.length === 0) {
				appendOptionItems(items, seen, PI_FALLBACK_MODELS);
			}
			break;
		}
		case 'aexus-antigravity': {
			const config = await readModelConfigFromCandidates(
				[
					join(cwd, '.gemini', 'settings.json'),
					join(cwd, '.gemini', 'antigravity', 'settings.json'),
					...withHome('.gemini', 'antigravity', 'settings.json'),
					...withHome('.gemini', 'antigravity-cli', 'settings.json'),
					...withHome('.gemini', 'settings.json'),
				],
				readAntigravitySettings,
				readText,
			);
			resolvedDefault = config.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(config);
			if (runtimeModels.length === 0) {
				appendOptionItems(items, seen, ANTIGRAVITY_MODELS);
			}
			break;
		}
		case 'aexus-dsh': {
			const jsonConfig = await readModelConfigFromCandidates(
				[
					join(cwd, '.dsh', 'config.json'),
					join(cwd, '.dsh', 'settings.json'),
					...withHome('.dsh', 'config.json'),
					...withHome('.dsh', 'settings.json'),
				],
				readDshJson,
				readText,
			);
			const yamlConfig = await readModelConfigFromCandidates(
				[
					join(cwd, '.dsh', 'cordis.patch.yml'),
					join(cwd, '.dsh', 'cordis.yml'),
					...withHome('.dsh', 'cordis.patch.yml'),
					...withHome('.dsh', 'cordis.yml'),
				],
				readDshYaml,
				readText,
			);
			resolvedDefault = jsonConfig.defaultModel ?? yamlConfig.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(jsonConfig);
			appendRead(yamlConfig);
			if (runtimeModels.length === 0) {
				appendOptionItems(items, seen, DSH_KNOWN_MODELS);
			}
			break;
		}
		case 'aexus-cline': {
			const modelsCfg = await readModelConfigFromCandidates(
				[
					join(cwd, '.cline', 'settings', 'models.json'),
					...withHome('.cline', 'data', 'settings', 'models.json'),
				],
				readClineModelsFile,
				readText,
			);
			const providersCfg = await readModelConfigFromCandidates(
				[
					join(cwd, '.cline', 'settings', 'providers.json'),
					...withHome('.cline', 'data', 'settings', 'providers.json'),
				],
				readClineProvidersFile,
				readText,
			);
			const globalCfg = await readModelConfigFromCandidates(
				[
					join(cwd, '.cline', 'globalState.json'),
					...withHome('.cline', 'data', 'globalState.json'),
					...withHome('.cline', 'globalState.json'),
				],
				readClineGlobalState,
				readText,
			);
			resolvedDefault = providersCfg.defaultModel ?? modelsCfg.defaultModel ?? globalCfg.defaultModel ?? runtimeDefaultModel;
			appendOptionItems(items, seen, runtimeModelItems(runtimeModels));
			appendRead(modelsCfg);
			appendRead(providersCfg);
			appendRead(globalCfg);
			if (runtimeModels.length === 0 && modelsCfg.models.length === 0 && providersCfg.models.length === 0) {
				appendOptionItems(items, seen, CLINE_KNOWN_MODELS);
			}
			break;
		}
	}

	for (const rawCustom of customModels) {
		const trimmed = rawCustom?.trim();
		if (trimmed && trimmed !== 'default' && !seen.has(trimmed)) {
			seen.add(trimmed);
			items.push({ id: trimmed, name: trimmed, description: 'Custom model' });
		}
	}

	const defaultName = resolvedDefault ? `Default (${resolvedDefault})` : 'Default (Engine Config)';
	const defaultDescription = resolvedDefault
		? `Use engine default model from config (resolved: ${resolvedDefault})`
		: 'Use engine default model from config';
	return [{ id: 'default', name: defaultName, description: defaultDescription, default: true }, ...items];
}

const THINKING_LEVELS: Readonly<Record<EngineId, readonly string[]>> = {
	'aexus-claude': ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
	'aexus-codex': ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'],
	'aexus-kilo': ['default', 'none', 'low', 'high', 'max'],
	'aexus-opencode': ['default', 'low', 'medium', 'high', 'extra-high'],
	'aexus-pi': ['default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
	'aexus-antigravity': ['default', 'low', 'medium', 'high', 'xhigh'],
	'aexus-dsh': ['default', 'off', 'low', 'high', 'max'],
	'aexus-cline': ['default', 'none', 'low', 'medium', 'high', 'xhigh'],
};

const CLAUDE_PERMISSION_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'bypassPermissions', name: 'Bypass All', description: 'Skip all permission prompts', slashCommand: 'bypass' },
	{ id: 'auto', name: 'Auto Mode', description: 'Automatically approve routine tool use' },
	{ id: 'acceptEdits', name: 'Auto-Edit', description: 'Automatically accept file edits' },
	{ id: 'plan', name: 'Plan Mode', description: 'Plan changes without modifying files' },
	{ id: 'ask', name: 'Ask', description: 'Prompt before using tools that need approval' },
];

const CODEX_APPROVAL_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'never', name: 'Never Ask', description: 'Never ask for approval (full auto)' },
	{ id: 'on-request', name: 'On Request', description: 'Ask only when the model requests approval' },
	{ id: 'untrusted', name: 'Untrusted', description: 'Ask before running untrusted commands' },
];

const CODEX_SANDBOX_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'danger-full-access', name: 'Full Access', description: 'Allow unrestricted reads, writes, and commands' },
	{ id: 'workspace-write', name: 'Workspace Write', description: 'Allow writes inside the workspace' },
	{ id: 'read-only', name: 'Read-Only', description: 'Allow reads only' },
];

const CODEX_WEB_SEARCH_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'enabled', name: 'Enabled', description: 'Allow web search' },
	{ id: 'disabled', name: 'Disabled', description: 'Disable web search' },
];

const KILO_MODE_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'code', name: 'Code', description: 'Write and modify code' },
	{ id: 'architect', name: 'Architect (Plan)', description: 'Plan before implementing' },
	{ id: 'ask', name: 'Ask', description: 'Answer questions without editing' },
	{ id: 'debug', name: 'Debug', description: 'Diagnose and fix failures' },
	{ id: 'orchestrator', name: 'Orchestrator', description: 'Coordinate subagents' },
	{ id: 'explore', name: 'Explore', description: 'Explore the codebase' },
];

const OPENCODE_AGENT_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'build', name: 'Build', description: 'Write and modify code' },
	{ id: 'plan', name: 'Plan', description: 'Plan changes without modifying files' },
	{ id: 'general', name: 'General', description: 'Use all configured tools' },
	{ id: 'explore', name: 'Explore', description: 'Explore the codebase read-only' },
];

const GENERAL_PERMISSION_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'bypassPermissions', name: 'Bypass All', description: 'Approve all tool and command permissions automatically', slashCommand: 'bypass' },
	{ id: 'ask', name: 'Ask', description: 'Prompt before running commands or external access' },
];

const PI_TOOL_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'full', name: 'All Tools', description: 'Read, write, execute, and network tools' },
	{ id: 'readonly', name: 'Read-Only Tools', description: 'read, grep, find, ls' },
	{ id: 'chat', name: 'No Tools', description: 'Conversation only' },
];

const ANTIGRAVITY_MODE_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'auto', name: 'Auto', description: 'Automatically approve all tool calls and edits' },
	{ id: 'accept-edits', name: 'Accept Edits', description: 'Automatically accept file edits' },
	{ id: 'plan', name: 'Plan', description: 'Plan changes without modifying files' },
	{ id: 'ask', name: 'Ask', description: 'Prompt before running tools that need approval' },
];

const DSH_PERMISSION_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'danger-full-access', name: 'Full Access', description: 'Allow unrestricted reads, writes, and commands' },
	{ id: 'workspace-write', name: 'Workspace Write', description: 'Allow writes inside the workspace' },
	{ id: 'read-only', name: 'Read-Only', description: 'Allow reads only' },
	{ id: 'ask', name: 'Ask', description: 'Prompt before running tools that need approval' },
];

const CLINE_MODE_ITEMS: readonly DiscoveredOptionItem[] = [
	{ id: 'yolo', name: 'Auto-Approve YOLO', description: 'Approve all tool use automatically' },
	{ id: 'act', name: 'Act Mode', description: 'Execute changes directly' },
	{ id: 'plan', name: 'Plan Mode', description: 'Plan changes before executing' },
	{ id: 'ask', name: 'Ask', description: 'Prompt before tool execution' },
];

function thinkingDisplayName(level: string): string {
	switch (level) {
		case 'default': return 'Default';
		case 'minimal': return 'Minimal';
		case 'none': return 'None';
		case 'off': return 'Off';
		case 'xhigh': return 'Extra High';
		case 'extra-high': return 'Extra High';
		case 'max': return 'Max';
		default: return level.charAt(0).toUpperCase() + level.slice(1);
	}
}

function thinkingItems(levels: readonly string[]): DiscoveredOptionItem[] {
	return levels.map(level => ({
		id: level,
		name: thinkingDisplayName(level),
		description: level === 'default' ? 'Use engine default thinking level' : undefined,
	}));
}

function mergeOptionItems(base: readonly DiscoveredOptionItem[], extra: readonly DiscoveredOptionItem[]): DiscoveredOptionItem[] {
	const merged: DiscoveredOptionItem[] = [];
	const seen = new Set<string>();
	for (const item of [...base, ...extra]) {
		if (seen.has(item.id)) {
			continue;
		}
		seen.add(item.id);
		merged.push(item);
	}
	return merged;
}

function optionGroup(id: string, name: string, items: DiscoveredOptionItem[], selectedId: string, description?: string, selectedInsertAt = 0): DiscoveredOptionGroup {
	let finalItems = items;
	if (selectedId && !items.some(item => item.id === selectedId)) {
		finalItems = [...items.slice(0, selectedInsertAt), { id: selectedId, name: selectedId }, ...items.slice(selectedInsertAt)];
	}
	return description === undefined
		? { id, name, items: finalItems, selectedId }
		: { id, name, description, items: finalItems, selectedId };
}

function selectedOr(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed ? trimmed : fallback;
}

function selectedNonDefault(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	return trimmed && trimmed !== 'default' ? trimmed : fallback;
}

function buildEngineSpecificGroups(engineId: EngineId, state: SessionConfigState, runtimeModes?: Array<{ id: string; name: string; description?: string }>): DiscoveredOptionGroup[] {
	switch (engineId) {
		case 'aexus-claude':
			return [
				optionGroup('permissions', 'Permissions', [...CLAUDE_PERMISSION_ITEMS], selectedNonDefault(state.permissionMode, 'bypassPermissions'), 'Tool permission behavior'),
			];
		case 'aexus-codex':
			return [
				optionGroup('permissions', 'Approval', [...CODEX_APPROVAL_ITEMS], selectedNonDefault(state.permissionMode, 'never'), 'When to ask for command approval'),
				optionGroup('sandbox', 'Sandbox', [...CODEX_SANDBOX_ITEMS], selectedNonDefault(state.sandboxMode, 'danger-full-access'), 'Filesystem access policy'),
				optionGroup('webSearch', 'Web Search', [...CODEX_WEB_SEARCH_ITEMS], selectedOr(state.webSearch, 'enabled'), 'Whether web search is available'),
			];
		case 'aexus-kilo':
			return [
				optionGroup('mode', 'Mode', [...KILO_MODE_ITEMS], selectedNonDefault(state.mode, 'code'), 'How Kilo responds and edits'),
				optionGroup('permissions', 'Permissions', [...GENERAL_PERMISSION_ITEMS], selectedNonDefault(state.permissionMode, 'bypassPermissions'), 'Tool permission behavior'),
			];
		case 'aexus-opencode':
			return [
				optionGroup('mode', 'Agent', [...OPENCODE_AGENT_ITEMS], selectedNonDefault(state.mode, 'build'), 'The active OpenCode agent'),
				optionGroup('permissions', 'Permissions', [...GENERAL_PERMISSION_ITEMS], selectedNonDefault(state.permissionMode, 'bypassPermissions'), 'Tool permission behavior'),
			];
		case 'aexus-pi':
			return [
				optionGroup('mode', 'Tools', [...PI_TOOL_ITEMS], selectedNonDefault(state.mode, 'full'), 'Which tools Pi may use'),
				optionGroup('permissions', 'Permissions', [...GENERAL_PERMISSION_ITEMS], selectedNonDefault(state.permissionMode, 'bypassPermissions'), 'Tool confirmation behavior'),
			];
		case 'aexus-antigravity': {
			const extraModes = (runtimeModes ?? []).map(mode => ({ id: mode.id, name: mode.name, description: mode.description }));
			return [
				optionGroup('mode', 'Mode', mergeOptionItems(ANTIGRAVITY_MODE_ITEMS, extraModes), selectedNonDefault(state.mode, 'auto'), 'How Antigravity executes work'),
			];
		}
		case 'aexus-dsh': {
			const groups: DiscoveredOptionGroup[] = [
				optionGroup('permissions', 'Permissions', [...DSH_PERMISSION_ITEMS], selectedNonDefault(state.permissionMode, 'danger-full-access'), 'Filesystem and tool access policy'),
			];
			const extraModes = (runtimeModes ?? []).map(mode => ({ id: mode.id, name: mode.name, description: mode.description }));
			if (extraModes.length > 0) {
				groups.push(optionGroup('mode', 'Mode', extraModes, selectedNonDefault(state.mode, extraModes[0].id), 'The active DeepSeek Harness mode'));
			}
			return groups;
		}
		case 'aexus-cline':
			return [
				optionGroup('mode', 'Mode', [...CLINE_MODE_ITEMS], selectedNonDefault(state.mode, 'yolo'), 'How Cline executes work'),
			];
	}
}

/**
 * Builds the configuration groups shown for a session. For the secretary the first group selects the
 * underlying engine, and the remaining groups describe that engine's controls.
 */
export async function buildOptionGroupsForSession(
	targetKind: 'secretary' | EngineId,
	state: SessionConfigState,
	cwd: string,
	runtimeExtras?: { defaultModel?: string; models?: Array<{ id: string; name: string; description?: string }>; modes?: Array<{ id: string; name: string; description?: string }>; customModels?: readonly string[]; remoteTarget?: CloudHostTarget },
): Promise<DiscoveredOptionGroup[]> {
	const effectiveEngineId: EngineId = targetKind === 'secretary' ? state.secretaryEngineId ?? 'aexus-claude' : targetKind;
	const groups: DiscoveredOptionGroup[] = [];

	if (targetKind === 'secretary') {
		groups.push({
			id: 'engine',
			name: 'Engine',
			description: 'Secretary underlying coding agent engine',
			items: ENGINE_INFO.map(engine => ({ id: engine.id, name: engine.name, description: engine.description })),
			selectedId: effectiveEngineId,
		});
	}

	const modelItems = await discoverEngineModels(effectiveEngineId, cwd, runtimeExtras?.models ?? [], runtimeExtras?.defaultModel, runtimeExtras?.customModels ?? [], runtimeExtras?.remoteTarget);
	groups.push(optionGroup('model', 'Model', modelItems, selectedOr(state.model, 'default'), 'Model used for this session', 1));

	const levels = THINKING_LEVELS[effectiveEngineId];
	groups.push(optionGroup('thinking', 'Thinking', thinkingItems(levels), selectedOr(state.thinking, 'default'), 'Reasoning depth for this session'));

	groups.push(...buildEngineSpecificGroups(effectiveEngineId, state, runtimeExtras?.modes));
	return groups;
}

interface BuiltinCommand {
	readonly name: string;
	readonly description: string;
}

function commands(entries: ReadonlyArray<readonly [string, string]>): readonly BuiltinCommand[] {
	return entries.map(([name, description]) => ({ name, description }));
}

const GOAL_COMMAND: BuiltinCommand = {
	name: 'goal',
	description: 'Set an autonomous goal verified before stopping [<goal> | clear]',
};

const SECRETARY_COMMANDS: readonly BuiltinCommand[] = commands([
	['status', 'Show secretary and agent status'],
	['projects', 'List and switch projects'],
	['sessions', 'List and resume agent sessions'],
	['mission', 'List active ADE Missions and runtime status'],
	['inbox', 'Open the secretary Inbox'],
	['focus', 'Focus the active agent session'],
	['home', 'Return to the secretary home'],
	['new', 'Start a new session'],
	['engine', 'Switch the underlying coding agent engine'],
	['reset', 'Reset the secretary conversation'],
]);

const ENGINE_BUILTIN_COMMANDS: Readonly<Record<EngineId, readonly BuiltinCommand[]>> = {
	'aexus-claude': commands([
		['init', 'Initialize a CLAUDE.md file with codebase documentation'],
		['compact', 'Compact the conversation to free up context'],
		['review', 'Review a pull request or the current changes'],
		['security-review', 'Run a security review of pending changes'],
		['plan', 'Enter plan mode and draft an implementation plan'],
		['clear', 'Clear the conversation history'],
		['model', 'Select the model for this session'],
		['effort', 'Set the reasoning effort level'],
		['permissions', 'Configure tool permissions'],
		['mcp', 'Manage MCP servers'],
		['memory', 'View or edit project memory'],
		['cost', 'Show token usage and cost for this session'],
		['context', 'Show context window usage'],
		['doctor', 'Diagnose the engine installation'],
		['diff', 'Show the current working tree diff'],
		['agents', 'Manage subagents'],
		['verify', 'Verify a change works before finishing'],
		['debug', 'Debug a failing behavior'],
		['simplify', 'Review changes for reuse and simplification'],
		['loop', 'Run a prompt or command on an interval'],
		['deep-research', 'Run a multi-step research workflow'],
		['recap', 'Summarize what has happened so far'],
		['usage', 'Show plan usage limits'],
		['config', 'Open the configuration UI'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-codex': commands([
		['init', 'Initialize project instructions from the codebase'],
		['compact', 'Compact the conversation to free up context'],
		['review', 'Review a pull request or the current changes'],
		['fork', 'Fork the current conversation into a new branch'],
		['plan', 'Enter plan mode and draft an implementation plan'],
		['clear', 'Clear the conversation history'],
		['model', 'Select the model for this session'],
		['effort', 'Set the reasoning effort level'],
		['permissions', 'Configure approval behavior'],
		['sandbox', 'Configure the sandbox policy'],
		['search', 'Search the conversation or codebase'],
		['mcp', 'Manage MCP servers'],
		['status', 'Show session and engine status'],
		['diff', 'Show the current working tree diff'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-kilo': commands([
		['init', 'Initialize project instructions from the codebase'],
		['compact', 'Compact the conversation to free up context'],
		['summarize', 'Summarize the conversation so far'],
		['undo', 'Undo the last change'],
		['redo', 'Redo the last undone change'],
		['share', 'Share the current conversation'],
		['unshare', 'Stop sharing the current conversation'],
		['mode', 'Switch the Kilo mode'],
		['model', 'Select the model for this session'],
		['thinking', 'Set the thinking level'],
		['mcp', 'Manage MCP servers'],
		['clear', 'Clear the conversation history'],
		['diff', 'Show the current working tree diff'],
		['review', 'Review a pull request or the current changes'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-opencode': commands([
		['init', 'Initialize project instructions from the codebase'],
		['compact', 'Compact the conversation to free up context'],
		['undo', 'Undo the last change'],
		['redo', 'Redo the last undone change'],
		['share', 'Share the current conversation'],
		['unshare', 'Stop sharing the current conversation'],
		['agent', 'Switch the active OpenCode agent'],
		['model', 'Select the model for this session'],
		['thinking', 'Set the thinking level'],
		['mcp', 'Manage MCP servers'],
		['clear', 'Clear the conversation history'],
		['diff', 'Show the current working tree diff'],
		['review', 'Review a pull request or the current changes'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-antigravity': commands([
		['plan', 'Draft an implementation plan'],
		['grill-me', 'Stress-test a plan with adversarial questions'],
		['boost', 'Boost reasoning or performance for the current task'],
		['teamwork', 'Coordinate multiple agents on a shared task'],
		['learn', 'Capture learnings into project memory'],
		['compact', 'Compact the conversation to free up context'],
		['browser', 'Open or control the built-in browser'],
		['schedule', 'Schedule a recurring task'],
		['model', 'Select the model for this session'],
		['mode', 'Switch the Antigravity mode'],
		['mcp', 'Manage MCP servers'],
		['clear', 'Clear the conversation history'],
		['diff', 'Show the current working tree diff'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-pi': commands([
		['compact', 'Compact the conversation to free up context'],
		['tree', 'Show the conversation tree'],
		['fork', 'Fork the current conversation into a new branch'],
		['new', 'Start a new conversation'],
		['clear', 'Clear the conversation history'],
		['model', 'Select the model for this session'],
		['thinking', 'Set the thinking level'],
		['stats', 'Show session statistics'],
		['reload', 'Reload settings and skills'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-dsh': commands([
		['init', 'Initialize project instructions from the codebase'],
		['compact', 'Compact the conversation to free up context'],
		['plan', 'Draft an implementation plan'],
		['review', 'Review a pull request or the current changes'],
		['mode', 'Switch the DeepSeek Harness mode'],
		['model', 'Select the model for this session'],
		['thinking', 'Set the thinking level'],
		['permissions', 'Configure the permission policy'],
		['clear', 'Clear the conversation history'],
		['diff', 'Show the current working tree diff'],
		['feedback', 'Send feedback about the session'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
	'aexus-cline': commands([
		['newtask', 'Start a new task'],
		['smol', 'Condense the conversation to a smaller context'],
		['compact', 'Compact the conversation to free up context'],
		['deep-planning', 'Run deep planning before implementation'],
		['plan', 'Switch to plan mode'],
		['act', 'Switch to act mode'],
		['undo', 'Undo the last change'],
		['fork', 'Fork the current conversation into a new task'],
		['model', 'Select the model for this session'],
		['thinking', 'Set the thinking level'],
		['mcp', 'Manage MCP servers'],
		['clear', 'Clear the conversation history'],
		['diff', 'Show the current working tree diff'],
		['history', 'Show task history'],
		['skills', 'List available skills'],
		['help', 'Show help for available commands'],
	]),
};

type TemplateSource = 'local' | 'user' | 'plugin' | 'builtin';
type SlashCommandKind = DiscoveredSlashCommand['kind'];

interface ScannedTemplateFile {
	readonly filePath: string;
	readonly source: TemplateSource;
	readonly kind: SlashCommandKind;
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

function normalizeCommandName(name: string): string {
	return name.trim().replace(/^\//, '').toLowerCase();
}

function defaultTemplateDescription(kind: SlashCommandKind): string {
	switch (kind) {
		case 'skill': return 'Project skill';
		case 'workflow': return 'Custom workflow';
		case 'prompt': return 'Custom prompt';
		default: return 'Custom command';
	}
}

async function scanSkillTemplates(cwd: string, home: string): Promise<ScannedTemplateFile[]> {
	const results: ScannedTemplateFile[] = [];
	const seen = new Set<string>();
	const roots: ReadonlyArray<{ dir: string; source: TemplateSource }> = [
		{ dir: path.join(cwd, '.agents', 'skills'), source: 'local' },
		{ dir: path.join(home, '.agents', 'skills'), source: 'user' },
		{ dir: path.join(cwd, '.claude', 'skills'), source: 'local' },
		{ dir: path.join(home, '.claude', 'skills'), source: 'user' },
		{ dir: path.join(home, '.codex', 'skills'), source: 'user' },
		{ dir: path.join(home, '.config', 'opencode', 'skills'), source: 'user' },
		{ dir: path.join(home, '.config', 'kilo', 'skills'), source: 'user' },
		{ dir: path.join(home, '.pi', 'agent', 'skills'), source: 'user' },
		{ dir: path.join(home, '.gemini', 'antigravity', 'builtin', 'skills'), source: 'builtin' },
	];
	for (const root of roots) {
		for (const entry of await readDirectoryCached(root.dir)) {
			if (entry.kind !== 'directory') {
				continue;
			}
			const filePath = path.join(root.dir, entry.name, 'SKILL.md');
			if (seen.has(filePath)) {
				continue;
			}
			const text = await readTextFileCached(filePath);
			if (text === undefined) {
				continue;
			}
			seen.add(filePath);
			const metadata = readMarkdownMetadata(text);
			results.push({
				filePath,
				source: root.source,
				kind: 'skill',
				name: metadata.name ?? entry.name,
				description: metadata.description,
				argumentHint: metadata.argumentHint,
			});
		}
	}
	return results;
}

async function scanTemplateFiles(cwd: string, home: string): Promise<ScannedTemplateFile[]> {
	const results: ScannedTemplateFile[] = [];
	const seen = new Set<string>();
	const roots: ReadonlyArray<{ dir: string; source: TemplateSource; kind: SlashCommandKind; recursive: boolean }> = [
		{ dir: path.join(cwd, '.claude', 'commands'), source: 'local', kind: 'command', recursive: true },
		{ dir: path.join(home, '.claude', 'commands'), source: 'user', kind: 'command', recursive: true },
		{ dir: path.join(home, '.codex', 'prompts'), source: 'user', kind: 'prompt', recursive: false },
		{ dir: path.join(cwd, '.opencode', 'command'), source: 'local', kind: 'command', recursive: false },
		{ dir: path.join(cwd, '.opencode', 'commands'), source: 'local', kind: 'command', recursive: false },
		{ dir: path.join(home, '.config', 'opencode', 'commands'), source: 'user', kind: 'command', recursive: false },
		{ dir: path.join(cwd, '.kilo', 'commands'), source: 'local', kind: 'command', recursive: false },
		{ dir: path.join(cwd, '.kilo', 'workflows'), source: 'local', kind: 'workflow', recursive: false },
		{ dir: path.join(cwd, '.kilocode', 'workflows'), source: 'local', kind: 'workflow', recursive: false },
		{ dir: path.join(cwd, '.clinerules', 'workflows'), source: 'local', kind: 'workflow', recursive: false },
		{ dir: path.join(cwd, '.agents', 'workflows'), source: 'local', kind: 'workflow', recursive: false },
	];
	for (const root of roots) {
		for (const filePath of await listFiles(root.dir, '.md', root.recursive, 4)) {
			if (seen.has(filePath)) {
				continue;
			}
			const text = await readTextFileCached(filePath);
			if (text === undefined) {
				continue;
			}
			seen.add(filePath);
			const metadata = readMarkdownMetadata(text);
			results.push({
				filePath,
				source: root.source,
				kind: root.kind,
				name: metadata.name ?? path.basename(filePath, path.extname(filePath)),
				description: metadata.description,
				argumentHint: metadata.argumentHint,
			});
		}
	}
	return results;
}

/**
 * Discovers every slash command available for an engine (or the secretary), merging engine built-ins,
 * on-disk custom skills/commands/workflows, and commands supplied by the runtime.
 */
export async function discoverSlashCommands(
	targetKind: 'secretary' | EngineId,
	effectiveEngineId: EngineId,
	cwd: string,
	runtimeCommands?: Array<{ name: string; description?: string }>,
	remoteTarget?: CloudHostTarget,
): Promise<DiscoveredSlashCommand[]> {
	const home = os.homedir();
	const results: DiscoveredSlashCommand[] = [];
	const seen = new Set<string>();
	const push = (command: DiscoveredSlashCommand): void => {
		const key = normalizeCommandName(command.name);
		if (!key || seen.has(key)) {
			return;
		}
		seen.add(key);
		results.push({ ...command, name: command.name.replace(/^\//, '') });
	};

	push({ name: GOAL_COMMAND.name, description: GOAL_COMMAND.description, source: 'builtin', kind: 'command', engineId: effectiveEngineId });

	if (targetKind === 'secretary') {
		for (const command of SECRETARY_COMMANDS) {
			push({ name: command.name, description: command.description, source: 'builtin', kind: 'macro' });
		}
	}

	for (const command of ENGINE_BUILTIN_COMMANDS[effectiveEngineId]) {
		push({ name: command.name, description: command.description, source: 'builtin', kind: 'command', engineId: effectiveEngineId });
	}

	if (!remoteTarget) {
		for (const template of [...await scanSkillTemplates(cwd, home), ...await scanTemplateFiles(cwd, home)]) {
			push({
				name: template.name,
				description: template.description ?? defaultTemplateDescription(template.kind),
				argumentHint: template.argumentHint,
				source: template.source,
				kind: template.kind,
				filePath: template.filePath,
				engineId: effectiveEngineId,
			});
		}
	}

	for (const command of runtimeCommands ?? []) {
		push({
			name: command.name,
			description: command.description ?? 'Custom command',
			source: 'local',
			kind: 'command',
			engineId: effectiveEngineId,
		});
	}

	return results;
}

async function collectSkillFiles(cwd: string, home: string): Promise<DiscoveredCustomizationFile[]> {
	return (await scanSkillTemplates(cwd, home)).map(template => ({
		uriPath: template.filePath,
		isBuiltin: template.source === 'builtin',
		type: 'skill',
		name: template.name,
		description: template.description,
		source: template.source,
		userInvocable: true,
	}));
}

async function collectPromptFiles(cwd: string, home: string): Promise<DiscoveredCustomizationFile[]> {
	return (await scanTemplateFiles(cwd, home)).map(template => ({
		uriPath: template.filePath,
		isBuiltin: false,
		type: 'prompt',
		name: template.name,
		description: template.description ?? defaultTemplateDescription(template.kind),
		source: template.source,
		userInvocable: true,
	}));
}

async function collectAgentFiles(cwd: string, home: string): Promise<DiscoveredCustomizationFile[]> {
	const results: DiscoveredCustomizationFile[] = [];
	const seen = new Set<string>();
	const roots: ReadonlyArray<{ dir: string; source: TemplateSource; recursive: boolean }> = [
		{ dir: path.join(cwd, '.claude', 'agents'), source: 'local', recursive: true },
		{ dir: path.join(home, '.claude', 'agents'), source: 'user', recursive: true },
		{ dir: path.join(cwd, '.opencode', 'agent'), source: 'local', recursive: false },
		{ dir: path.join(cwd, '.opencode', 'agents'), source: 'local', recursive: false },
		{ dir: path.join(home, '.config', 'opencode', 'agent'), source: 'user', recursive: false },
		{ dir: path.join(home, '.config', 'opencode', 'agents'), source: 'user', recursive: false },
		{ dir: path.join(cwd, '.codex', 'agents'), source: 'local', recursive: false },
		{ dir: path.join(home, '.codex', 'agents'), source: 'user', recursive: false },
		{ dir: path.join(cwd, '.kilo', 'agents'), source: 'local', recursive: false },
	];
	for (const root of roots) {
		for (const filePath of await listFiles(root.dir, '.md', root.recursive, 3)) {
			if (seen.has(filePath)) {
				continue;
			}
			const text = await readTextFileCached(filePath);
			if (text === undefined) {
				continue;
			}
			seen.add(filePath);
			const metadata = readMarkdownMetadata(text);
			results.push({
				uriPath: filePath,
				isBuiltin: false,
				type: 'agent',
				name: metadata.name ?? path.basename(filePath, path.extname(filePath)),
				description: metadata.description,
				source: root.source,
				userInvocable: true,
			});
		}
	}
	return results;
}

async function collectInstructionFiles(cwd: string, home: string): Promise<DiscoveredCustomizationFile[]> {
	const results: DiscoveredCustomizationFile[] = [];
	const seen = new Set<string>();
	const addFile = async (filePath: string, source: 'local' | 'user'): Promise<void> => {
		if (seen.has(filePath)) {
			return;
		}
		const text = await readTextFileCached(filePath);
		if (text === undefined) {
			return;
		}
		seen.add(filePath);
		const metadata = readMarkdownMetadata(text);
		const fileName = path.basename(filePath);
		results.push({
			uriPath: filePath,
			isBuiltin: false,
			type: 'instructions',
			name: metadata.name ?? fileName,
			description: metadata.description ?? `Instructions from ${fileName}`,
			source,
			userInvocable: false,
		});
	};
	const instructionNames = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.clinerules'];
	for (const name of instructionNames) {
		await addFile(path.join(cwd, name), 'local');
		await addFile(path.join(home, name), 'user');
	}
	for (const filePath of await listFiles(path.join(cwd, '.clinerules'), '.md', true, 2)) {
		await addFile(filePath, 'local');
	}
	for (const filePath of await listFiles(path.join(home, '.clinerules'), '.md', true, 2)) {
		await addFile(filePath, 'user');
	}
	return results;
}

async function collectHookFiles(cwd: string, home: string): Promise<DiscoveredCustomizationFile[]> {
	const results: DiscoveredCustomizationFile[] = [];
	const seen = new Set<string>();
	const roots: ReadonlyArray<{ dir: string; source: 'local' | 'user' }> = [
		{ dir: path.join(cwd, '.claude', 'hooks'), source: 'local' },
		{ dir: path.join(home, '.claude', 'hooks'), source: 'user' },
		{ dir: path.join(home, '.codex', 'hooks'), source: 'user' },
	];
	for (const root of roots) {
		for (const filePath of await listFiles(root.dir, undefined, false, 0)) {
			if (seen.has(filePath)) {
				continue;
			}
			seen.add(filePath);
			results.push({
				uriPath: filePath,
				isBuiltin: false,
				type: 'hook',
				name: path.basename(filePath),
				description: `Hook from ${path.basename(root.dir)}`,
				source: root.source,
				userInvocable: false,
			});
		}
	}
	return results;
}

async function collectPluginFiles(cwd: string, home: string): Promise<DiscoveredCustomizationFile[]> {
	const results: DiscoveredCustomizationFile[] = [];
	const seen = new Set<string>();
	const roots: ReadonlyArray<{ dir: string; source: 'local' | 'user' }> = [
		{ dir: path.join(cwd, '.claude', 'plugins'), source: 'local' },
		{ dir: path.join(home, '.claude', 'plugins'), source: 'user' },
	];
	for (const root of roots) {
		for (const manifestPath of await listFiles(root.dir, 'plugin.json', true, 5)) {
			if (seen.has(manifestPath)) {
				continue;
			}
			seen.add(manifestPath);
			const text = await readTextFileCached(manifestPath);
			const parsed = text === undefined ? undefined : asRecord(parseJsonLoose(text));
			const fallbackName = path.basename(path.dirname(manifestPath));
			results.push({
				uriPath: manifestPath,
				isBuiltin: false,
				type: 'plugin',
				name: (parsed ? stringValue(parsed.name) : undefined) ?? fallbackName,
				description: parsed ? stringValue(parsed.description) : undefined,
				source: 'plugin',
				userInvocable: false,
			});
		}
	}
	return results;
}

/**
 * Collects every customization ChatSessionCustomizationProvider can surface: skills, prompts,
 * workflows, agents, instructions, hooks, plugins, and non-file built-in commands.
 */
export async function discoverCustomizationFiles(
	effectiveEngineId: EngineId,
	cwd: string,
	runtimeCommands?: Array<{ name: string; description?: string }>,
	remoteTarget?: CloudHostTarget,
): Promise<DiscoveredCustomizationFile[]> {
	const home = os.homedir();
	const results: DiscoveredCustomizationFile[] = [];
	const seen = new Set<string>();
	const add = (entry: DiscoveredCustomizationFile): void => {
		const uriKey = `${entry.type}:${entry.uriPath}`;
		const nameKey = `${entry.type}:${entry.name.toLowerCase()}`;
		if (seen.has(uriKey) || seen.has(nameKey)) {
			return;
		}
		seen.add(uriKey);
		seen.add(nameKey);
		results.push(entry);
	};

	if (!remoteTarget) {
		for (const entry of await collectSkillFiles(cwd, home)) {
			add(entry);
		}
		for (const entry of await collectPromptFiles(cwd, home)) {
			add(entry);
		}
		for (const entry of await collectAgentFiles(cwd, home)) {
			add(entry);
		}
		for (const entry of await collectInstructionFiles(cwd, home)) {
			add(entry);
		}
		for (const entry of await collectHookFiles(cwd, home)) {
			add(entry);
		}
		for (const entry of await collectPluginFiles(cwd, home)) {
			add(entry);
		}
	}

	const commandNames = new Set(results.filter(entry => entry.type === 'skill' || entry.type === 'prompt').map(entry => entry.name.toLowerCase()));
	for (const command of await discoverSlashCommands(effectiveEngineId, effectiveEngineId, cwd, runtimeCommands, remoteTarget)) {
		if (command.filePath) {
			continue;
		}
		const key = command.name.toLowerCase();
		if (commandNames.has(key)) {
			continue;
		}
		commandNames.add(key);
		add({
			uriPath: `agent-builtin://aexus/${command.name}`,
			isBuiltin: true,
			type: 'prompt',
			name: command.name,
			description: command.description,
			source: command.source,
			userInvocable: true,
		});
	}

	return results;
}

/**
 * Reads the markdown body of a discovered command or skill and expands its prompt template.
 * YAML frontmatter is stripped, `$ARGUMENTS` is substituted, and otherwise the request is appended.
 */
export async function readSkillOrCommandTemplate(command: DiscoveredSlashCommand, argsText: string): Promise<string | undefined> {
	if (!command.filePath) {
		return undefined;
	}
	let text: string;
	try {
		text = await fs.readFile(command.filePath, 'utf8');
	} catch {
		return undefined;
	}
	const body = splitFrontmatter(text).body.trim();
	if (!body) {
		return undefined;
	}
	const args = argsText.trim();
	if (/\$ARGUMENTS/.test(body)) {
		return body.replace(/\$ARGUMENTS/g, args);
	}
	return args ? `${body}\n\nUser Request: ${args}` : body;
}
