/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	ADE_OS_ICON_LABELS,
	AdeOsIconKind,
	AEXUS_SSH_SCHEME,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	isCloudProjectUri,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import { ADE_REGISTERED_ENGINES } from '../../../../platform/ade/common/adeModels.js';
import { IOrchestrationGraphNode } from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	AdeLlmPickerVendor,
	AdeModelCategoryOverrides,
	isAdeLlmPickerVendor,
	normalizeAdeModelIdentityKey,
} from '../../../browser/adeLlmIcon.js';
import { resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { IAdeAgent, normalizeAdeShortEngineId } from '../common/ade.js';
import { IAdeEngineAvailability, IAdeSessionsService } from './adeSessionsService.js';

export type AdeThinkingEffortLevel = 'off' | 'low' | 'medium' | 'high' | 'max' | string;

export const MISSION_ENGINE_FALLBACK_NAMES: Readonly<Record<string, string>> = {
	'aexus-claude': 'Claude Code',
	'aexus-codex': 'Codex',
	'aexus-kilo': 'Kilo Code',
	'aexus-opencode': 'OpenCode',
	'aexus-dsh': 'DeepSeek Harness',
	'aexus-antigravity': 'Google Antigravity',
	'aexus-cline': 'Cline',
	'aexus-pi': 'Pi',
	'claude': 'Claude Code',
	'codex': 'Codex',
	'kilo': 'Kilo Code',
	'opencode': 'OpenCode',
	'dsh': 'DeepSeek Harness',
	'antigravity': 'Google Antigravity',
	'cline': 'Cline',
	'pi': 'Pi',
};

export const MISSION_ENGINE_DEFAULT_MODELS: Readonly<Record<string, string>> = {
	'aexus-claude': 'claude-sonnet-4-5',
	'aexus-codex': 'gpt-5.2-codex',
	'aexus-kilo': 'claude-sonnet-4-5',
	'aexus-opencode': 'claude-sonnet-4-5',
	'aexus-dsh': 'deepseek-chat',
	'aexus-antigravity': 'gemini-2.5-pro',
	'aexus-cline': 'claude-sonnet-4-5',
	'aexus-pi': 'claude-sonnet-4-5',
	'claude': 'claude-sonnet-4-5',
	'codex': 'gpt-5.2-codex',
	'kilo': 'claude-sonnet-4-5',
	'opencode': 'claude-sonnet-4-5',
	'dsh': 'deepseek-chat',
	'antigravity': 'gemini-2.5-pro',
	'cline': 'claude-sonnet-4-5',
	'pi': 'claude-sonnet-4-5',
};

export const MISSION_THINKING_LEVEL_OPTIONS: readonly string[] = ['low', 'medium', 'high'];

const MISSION_ENGINE_FALLBACK_EFFORTS: Readonly<Record<string, readonly string[]>> = {
	claude: ['low', 'medium', 'high', 'xhigh', 'max'],
	codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
	kilo: ['none', 'low', 'high', 'max'],
	opencode: ['low', 'medium', 'high', 'extra-high'],
	dsh: ['off', 'low', 'high', 'max'],
	antigravity: ['low', 'medium', 'high', 'xhigh'],
	cline: ['none', 'low', 'medium', 'high', 'xhigh'],
	pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
};

const CLAUDE_BUILTIN_MODEL_SET = new Set<string>([
	'claude-sonnet-4-6',
	'claude-opus-4-6',
	'claude-haiku-4-5',
	'claude-sonnet-4-5',
	'claude-opus-4-5',
	'sonnet',
	'opus',
	'haiku',
]);

const CONFIGURED_MODELS_CACHE_TTL_MS = 15_000;
const HOST_ENGINES_CACHE_TTL_MS = 30_000;
const MODEL_CATEGORY_OVERRIDES_STORAGE_KEY = 'aexus.ade.mission.modelCategoryOverrides.v1';

export interface IHostEngineProbeCacheEntry {
	readonly fetchedAt: number;
	readonly hostLabel: string;
	readonly allEngines: readonly IAdeEngineAvailability[];
	readonly availableIds: ReadonlySet<string>;
	readonly error?: string;
}

export interface IMissionNodeHostInfo {
	readonly hostKey: string;
	readonly hostAlias: string;
	readonly displayHost: string;
	readonly isRemote: boolean;
	readonly osKind: AdeOsIconKind;
	readonly osLabel: string;
}

export function toPrefixedAdeEngineId(rawEngineId: string): string {
	const short = normalizeAdeShortEngineId(rawEngineId);
	return `aexus-${short}`;
}

export function serializeMissionEngineIconKey(icon: URI | ThemeIcon | undefined): string {
	if (URI.isUri(icon)) {
		return `uri:${icon.toString()}`;
	}
	return icon ? `theme:${icon.id}:${icon.color?.id ?? ''}` : 'theme:hubot';
}

export function applyMissionEngineIcon(iconEl: HTMLElement, icon: URI | ThemeIcon | undefined): void {
	const isCore = iconEl.classList.contains('is-core');
	const coreCls = isCore ? ' is-core' : '';
	if (URI.isUri(icon)) {
		iconEl.className = `ade-mission-engine-icon ade-mission-engine-icon-svg${coreCls}`;
		iconEl.style.backgroundImage = asCSSUrl(icon);
	} else {
		const themeIcon = icon ?? Codicon.hubot;
		iconEl.className = `ade-mission-engine-icon ${ThemeIcon.asClassName(themeIcon)}${coreCls}`;
		iconEl.style.backgroundImage = '';
	}
}

/**
 * Manages TTL-cached local & SSH cloud host engine/model probing (bridging `IAdeControlCenterService`
 * and `IAdeSessionsService`), cloud host OS metadata, and user-persisted model-to-vendor icon category overrides.
 */
export class AdeMissionHostCatalog extends Disposable {
	private readonly _onDidChangeHosts = this._register(new Emitter<void>());
	readonly onDidChangeHosts: Event<void> = this._onDidChangeHosts.event;

	private cloudHostsList: readonly IAdeCloudHost[] = [];
	private cloudHostsByKey = new Map<string, IAdeCloudHost>();
	private readonly configuredModelsCache = new Map<string, { readonly fetchedAt: number; readonly data: Record<string, readonly { readonly id: string; readonly label: string }[]> }>();
	private readonly configuredModelsPending = new Map<string, Promise<Record<string, readonly { readonly id: string; readonly label: string }[]> | undefined>>();
	private readonly hostEnginesCache = new Map<string, IHostEngineProbeCacheEntry>();
	private readonly hostEnginesPending = new Map<string, Promise<IHostEngineProbeCacheEntry | undefined>>();
	private readonly hostEnginesLatestSeq = new Map<string, number>();
	private readonly controlProbeModelsCache = new Map<string, { readonly fetchedAt: number; readonly models: readonly string[]; readonly efforts: readonly string[] }>();
	private readonly controlProbeModelsPending = new Map<string, Promise<{ readonly models: readonly string[]; readonly efforts: readonly string[] }>>();
	private hostEnginesCacheEpoch = 0;
	private hostEnginesProbeSeq = 0;
	private modelCategoryOverrides: Record<string, Record<string, AdeLlmPickerVendor>> = {};
	private disposed = false;

	constructor(
		private readonly storageService: IStorageService,
		private readonly sessionsService: IAdeSessionsService | undefined,
		private readonly cloudHostService: IAdeCloudHostBackendService | undefined,
		private readonly commandService: ICommandService | undefined,
		private readonly controlCenterService?: IAdeControlCenterService,
	) {
		super();
		this.loadModelCategoryOverrides();

		if (this.sessionsService) {
			this._register(this.sessionsService.onDidChangeEngines(() => {
				this.clearEngineCache();
			}));
		}
		if (this.cloudHostService) {
			const refreshCloudHosts = () => {
				void this.cloudHostService?.listHosts().then(hosts => {
					if (this.disposed) {
						return;
					}
					this.cloudHostsList = hosts;
					this.cloudHostsByKey = AdeMissionHostCatalog.buildCloudHostLookupMap(hosts);
					this._onDidChangeHosts.fire();
				}).catch(() => undefined);
			};
			refreshCloudHosts();
			if (this.cloudHostService.onDidChangeHosts) {
				this._register(this.cloudHostService.onDidChangeHosts(() => refreshCloudHosts()));
			}
		}
	}

	private static scoreCloudHostSpecificity(host: IAdeCloudHost): number {
		const osKind = resolveAdeOsIconKind({
			os: host.os,
			distribution: host.lastTestStatus?.remoteUname,
			hint: `${host.name ?? ''} ${host.alias ?? ''} ${host.user ?? ''} ${host.notes ?? ''}`,
		});
		let score = 0;
		if (osKind === 'kali') {
			score += 20;
		}
		if (host.lastTestStatus?.remoteUname) {
			score += 10;
		}
		if (host.alias && host.hostName && host.alias.toLowerCase() !== host.hostName.toLowerCase()) {
			score += 4;
		}
		if (host.source === 'user') {
			score += 2;
		}
		return score;
	}

	private static buildCloudHostLookupMap(hosts: readonly IAdeCloudHost[]): Map<string, IAdeCloudHost> {
		const next = new Map<string, IAdeCloudHost>();
		const exactKeys = new Set<string>();
		const setPreferSpecific = (key: string, candidate: IAdeCloudHost, isExact: boolean) => {
			if (!key) {
				return;
			}
			if (isExact) {
				exactKeys.add(key);
				const prev = next.get(key);
				if (!prev || AdeMissionHostCatalog.scoreCloudHostSpecificity(candidate) >= AdeMissionHostCatalog.scoreCloudHostSpecificity(prev)) {
					next.set(key, candidate);
				}
				return;
			}
			if (exactKeys.has(key)) {
				return;
			}
			const prev = next.get(key);
			if (!prev || AdeMissionHostCatalog.scoreCloudHostSpecificity(candidate) > AdeMissionHostCatalog.scoreCloudHostSpecificity(prev)) {
				next.set(key, candidate);
			}
		};

		// Pass 1: exact non-bare-IP identity keys (named alias, id, explicit non-22 hostName:port)
		for (const h of hosts) {
			const rawAlias = h.alias?.trim() ?? '';
			const aliasKey = rawAlias.toLowerCase();
			if (aliasKey && !AdeMissionHostCatalog.isBareIpOrHostPort(rawAlias)) {
				setPreferSpecific(aliasKey, h, true);
			}
			const idKey = h.id?.trim().toLowerCase();
			if (idKey && !AdeMissionHostCatalog.isBareIpOrHostPort(idKey)) {
				setPreferSpecific(idKey, h, true);
			}
			const hostLower = h.hostName?.trim().toLowerCase();
			if (hostLower && h.port && h.port !== 22) {
				setPreferSpecific(`${hostLower}:${h.port}`, h, true);
			}
		}

		// Pass 2: shared fallback keys (bare IP alias, hostName / IP, hostName:22, display name) ranked by specificity so Kali/named hosts win over generic IP entries
		for (const h of hosts) {
			const aliasLower = h.alias?.trim().toLowerCase();
			if (aliasLower) {
				setPreferSpecific(aliasLower, h, false);
			}
			const hostLower = h.hostName?.trim().toLowerCase();
			if (hostLower) {
				setPreferSpecific(hostLower, h, false);
				setPreferSpecific(`${hostLower}:${h.port || 22}`, h, false);
			}
			const nameLower = h.name?.trim().toLowerCase();
			if (nameLower) {
				setPreferSpecific(nameLower, h, false);
			}
		}
		return next;
	}

	private lookupCloudHost(rawKey: string): IAdeCloudHost | undefined {
		const key = rawKey.trim().toLowerCase();
		if (!key || key === 'local') {
			return undefined;
		}
		const direct = this.cloudHostsByKey.get(key);
		if (direct) {
			return direct;
		}
		if (key.endsWith(':22')) {
			return this.cloudHostsByKey.get(key.slice(0, -3));
		}
		if (!key.includes(':')) {
			return this.cloudHostsByKey.get(`${key}:22`);
		}
		return undefined;
	}

	private static isBareIpOrHostPort(text: string): boolean {
		const trimmed = text.trim();
		return /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(trimmed) || /^\[[0-9a-fA-F:]+\](?::\d+)?$/.test(trimmed);
	}

	override dispose(): void {
		this.disposed = true;
		this.configuredModelsCache.clear();
		this.configuredModelsPending.clear();
		this.hostEnginesCache.clear();
		this.hostEnginesPending.clear();
		this.hostEnginesLatestSeq.clear();
		this.controlProbeModelsCache.clear();
		this.controlProbeModelsPending.clear();
		super.dispose();
	}

	getKnownCloudHosts(): readonly IAdeCloudHost[] {
		return this.cloudHostsList;
	}

	getEngineDisplayName(engineId: string): string {
		const prefixed = toPrefixedAdeEngineId(engineId);
		const resolved = this.sessionsService?.getEngineName(prefixed) ?? this.sessionsService?.getEngineName(engineId);
		return resolved && resolved !== engineId && resolved !== prefixed
			? resolved
			: (MISSION_ENGINE_FALLBACK_NAMES[engineId] ?? MISSION_ENGINE_FALLBACK_NAMES[prefixed] ?? normalizeAdeShortEngineId(engineId));
	}

	getEngineIcon(engineId: string): URI | ThemeIcon | undefined {
		const prefixed = toPrefixedAdeEngineId(engineId);
		const liveIcon = this.sessionsService?.getIcon(prefixed) ?? this.sessionsService?.getIcon(engineId);
		if (liveIcon) {
			return liveIcon;
		}
		for (const entry of this.hostEnginesCache.values()) {
			const match = entry.allEngines.find(e => e.id === prefixed || e.id === engineId);
			if (match?.icon) {
				return match.icon;
			}
		}
		return undefined;
	}

	clearEngineCache(): void {
		this.hostEnginesCacheEpoch++;
		this.hostEnginesCache.clear();
		this.hostEnginesPending.clear();
		this.hostEnginesLatestSeq.clear();
		this.controlProbeModelsCache.clear();
		this.controlProbeModelsPending.clear();
	}

	resolveNodeHostAndOs(
		explicitHost: string | undefined,
		linkedAgent?: IAdeAgent,
	): IMissionNodeHostInfo {
		const trimmedExplicit = explicitHost?.trim();
		const uriAuthority = linkedAgent && isCloudProjectUri(linkedAgent.projectUri) ? linkedAgent.projectUri.authority : undefined;
		const rawHost = trimmedExplicit || uriAuthority || 'local';
		const isRemote = rawHost.toLowerCase() !== 'local';
		if (!isRemote) {
			const osKind = resolveLocalOsIconKind();
			return {
				hostKey: 'local',
				hostAlias: 'local',
				displayHost: 'Local',
				isRemote: false,
				osKind,
				osLabel: ADE_OS_ICON_LABELS[osKind],
			};
		}
		const savedHost = this.lookupCloudHost(rawHost) ?? (uriAuthority ? this.lookupCloudHost(uriAuthority) : undefined);
		const friendlyAlias = savedHost?.alias && !AdeMissionHostCatalog.isBareIpOrHostPort(savedHost.alias)
			? savedHost.alias
			: savedHost?.name && !AdeMissionHostCatalog.isBareIpOrHostPort(savedHost.name)
				? savedHost.name
				: (savedHost?.alias || savedHost?.name || (uriAuthority && !AdeMissionHostCatalog.isBareIpOrHostPort(uriAuthority) ? uriAuthority : rawHost));
		const osKind = resolveAdeOsIconKind({
			os: savedHost?.os,
			distribution: savedHost?.lastTestStatus?.remoteUname,
			hint: `${savedHost?.name ?? ''} ${savedHost?.alias ?? ''} ${savedHost?.user ?? ''} ${savedHost?.notes ?? ''} ${rawHost} ${uriAuthority ?? ''} ${linkedAgent?.projectUri.path ?? ''}`,
		});
		return {
			hostKey: savedHost?.hostName || rawHost,
			hostAlias: savedHost?.alias || friendlyAlias,
			displayHost: friendlyAlias,
			isRemote: true,
			osKind,
			osLabel: ADE_OS_ICON_LABELS[osKind],
		};
	}

	resolveEffectiveNodeProbeUri(explicitHostAlias: string | undefined, agent: IAdeAgent | undefined): URI {
		const explicitHost = explicitHostAlias?.trim();
		if (explicitHost && explicitHost.toLowerCase() !== 'local') {
			if (agent && isCloudProjectUri(agent.projectUri) && agent.projectUri.authority.toLowerCase() === explicitHost.toLowerCase()) {
				return agent.projectUri;
			}
			const savedHost = this.lookupCloudHost(explicitHost);
			const rawDir = savedHost?.defaultDirectory?.trim() || '/';
			const uriPath = rawDir.startsWith('/') ? rawDir : `/${rawDir}`;
			return URI.from({ scheme: AEXUS_SSH_SCHEME, authority: savedHost?.alias || explicitHost, path: uriPath });
		}
		if (!agent) {
			return URI.file('/');
		}
		if (explicitHost?.toLowerCase() === 'local' && isCloudProjectUri(agent.projectUri)) {
			return URI.file('/');
		}
		return agent.projectUri;
	}

	hostProbeCacheKey(projectUri: URI): string {
		return isCloudProjectUri(projectUri) ? `cloud:${projectUri.authority.toLowerCase()}` : 'local';
	}

	formatHostLabelForUri(projectUri: URI): string {
		if (isCloudProjectUri(projectUri)) {
			return projectUri.authority;
		}
		return localize('adeMissionLocalHostShort', "Local");
	}

	async probeControlCenterEngines(host: string): Promise<readonly string[]> {
		const targetHost = host.trim() || 'local';
		if (this.controlCenterService) {
			try {
				const list = await this.controlCenterService.probeEngines(targetHost);
				if (list.length > 0) {
					return list;
				}
			} catch {
				// Fall through to sessionsService / registered list
			}
		}
		const probeUri = this.resolveEffectiveNodeProbeUri(targetHost, undefined);
		const entry = await this.probeHostEngines(probeUri, false);
		if (entry && entry.availableIds.size > 0) {
			return [...entry.availableIds].map(id => normalizeAdeShortEngineId(id));
		}
		return [...ADE_REGISTERED_ENGINES];
	}

	async probeControlCenterModels(
		host: string,
		engine: string,
	): Promise<{ readonly models: readonly string[]; readonly efforts: readonly string[] }> {
		const targetHost = host.trim() || 'local';
		const shortEngine = normalizeAdeShortEngineId(engine);
		const cacheKey = `${targetHost.toLowerCase()}::${shortEngine}`;
		const cached = this.controlProbeModelsCache.get(cacheKey);
		if (cached && Date.now() - cached.fetchedAt <= CONFIGURED_MODELS_CACHE_TTL_MS) {
			return { models: cached.models, efforts: cached.efforts };
		}
		const pending = this.controlProbeModelsPending.get(cacheKey);
		if (pending) {
			return pending;
		}

		const task = (async (): Promise<{ readonly models: readonly string[]; readonly efforts: readonly string[] }> => {
			const probeUri = this.resolveEffectiveNodeProbeUri(targetHost, undefined);
			const [ccRes, extMap] = await Promise.all([
				this.controlCenterService
					? this.controlCenterService.probeModels(targetHost, shortEngine).catch(() => undefined)
					: Promise.resolve(undefined),
				this.fetchExtensionConfiguredModelsOnly(probeUri),
			]);

			const mergedModels: string[] = [];
			const seenLower = new Set<string>();
			const addModel = (rawId: string | undefined) => {
				const trimmed = rawId?.trim();
				if (!trimmed || trimmed.toLowerCase() === 'default') {
					return;
				}
				const low = trimmed.toLowerCase();
				if (seenLower.has(low)) {
					return;
				}
				seenLower.add(low);
				mergedModels.push(trimmed);
			};

			// 1. Preserve ControlCenter index-0 default model & probed model order first
			for (const m of ccRes?.models ?? []) {
				addModel(m);
			}

			// 2. Union with extension `aexus.agentEngines.listConfiguredModels` (guarding Claude `replaceBuiltInOptions` custom-only mode)
			const claudeCustomOnly = shortEngine === 'claude'
				&& (ccRes?.models.length ?? 0) > 0
				&& !(ccRes?.models ?? []).some(m => CLAUDE_BUILTIN_MODEL_SET.has(m.trim().toLowerCase()));
			const extItems = extMap?.[toPrefixedAdeEngineId(shortEngine)] ?? extMap?.[shortEngine] ?? [];
			for (const item of extItems) {
				const id = item?.id?.trim();
				if (!id) {
					continue;
				}
				if (claudeCustomOnly && CLAUDE_BUILTIN_MODEL_SET.has(id.toLowerCase())) {
					continue;
				}
				addModel(id);
			}

			const fallbackEfforts = MISSION_ENGINE_FALLBACK_EFFORTS[shortEngine] ?? MISSION_THINKING_LEVEL_OPTIONS;
			const resolvedEfforts = ccRes && ccRes.efforts.length > 0 ? ccRes.efforts : fallbackEfforts;

			if (mergedModels.length > 0) {
				const result = { models: mergedModels, efforts: resolvedEfforts };
				if (!this.disposed) {
					this.controlProbeModelsCache.set(cacheKey, {
						fetchedAt: Date.now(),
						models: result.models,
						efforts: result.efforts,
					});
				}
				return result;
			}

			const fallbackModel = MISSION_ENGINE_DEFAULT_MODELS[shortEngine] ?? 'claude-sonnet-4-5';
			return {
				models: [fallbackModel],
				efforts: fallbackEfforts,
			};
		})().finally(() => {
			if (this.controlProbeModelsPending.get(cacheKey) === task) {
				this.controlProbeModelsPending.delete(cacheKey);
			}
		});

		this.controlProbeModelsPending.set(cacheKey, task);
		return task;
	}

	private async fetchExtensionConfiguredModelsOnly(
		projectUri: URI,
	): Promise<Record<string, readonly { readonly id: string; readonly label: string }[]> | undefined> {
		if (this.disposed || !this.commandService) {
			return undefined;
		}
		const key = projectUri.toString();
		const cached = this.configuredModelsCache.get(key);
		if (cached && Date.now() - cached.fetchedAt <= CONFIGURED_MODELS_CACHE_TTL_MS) {
			return cached.data;
		}
		try {
			const res = await this.commandService.executeCommand<Record<string, readonly { readonly id: string; readonly label: string }[]>>(
				'aexus.agentEngines.listConfiguredModels',
				projectUri,
			);
			if (!this.disposed && res && typeof res === 'object') {
				this.configuredModelsCache.set(key, { fetchedAt: Date.now(), data: res });
				return res;
			}
		} catch {
			// Command may not be registered before extension activation
		}
		return undefined;
	}

	getCachedHostEngines(projectUri: URI): IHostEngineProbeCacheEntry | undefined {
		const entry = this.hostEnginesCache.get(this.hostProbeCacheKey(projectUri));
		if (!entry || Date.now() - entry.fetchedAt > HOST_ENGINES_CACHE_TTL_MS) {
			return undefined;
		}
		return entry;
	}

	async probeHostEngines(projectUri: URI, forceRefresh = false): Promise<IHostEngineProbeCacheEntry | undefined> {
		if (this.disposed) {
			return undefined;
		}
		if (!this.sessionsService && !this.controlCenterService) {
			return undefined;
		}
		const key = this.hostProbeCacheKey(projectUri);
		if (!forceRefresh) {
			const cached = this.getCachedHostEngines(projectUri);
			if (cached) {
				return cached;
			}
			const pending = this.hostEnginesPending.get(key);
			if (pending) {
				return pending;
			}
		}
		const hostLabel = this.formatHostLabelForUri(projectUri);
		const probeEpoch = this.hostEnginesCacheEpoch;
		const probeSeq = ++this.hostEnginesProbeSeq;
		this.hostEnginesLatestSeq.set(key, probeSeq);
		const isCurrentProbe = () => !this.disposed && probeEpoch === this.hostEnginesCacheEpoch && this.hostEnginesLatestSeq.get(key) === probeSeq;

		const task: Promise<IHostEngineProbeCacheEntry> = (async (): Promise<IHostEngineProbeCacheEntry> => {
			try {
				if (this.controlCenterService) {
					const hostArg = isCloudProjectUri(projectUri)
						? (this.cloudHostsByKey.get(projectUri.authority.toLowerCase())?.hostName || projectUri.authority)
						: 'local';
					const availableShorts = new Set(await this.controlCenterService.probeEngines(hostArg));
					const allEngines: IAdeEngineAvailability[] = ADE_REGISTERED_ENGINES.map(shortId => {
						const prefId = `aexus-${shortId}`;
						const name = this.getEngineDisplayName(prefId);
						return {
							id: prefId,
							name,
							description: name,
							icon: this.sessionsService?.getIcon(prefId),
							available: availableShorts.has(shortId),
						};
					}).sort((a, b) => Number(b.available) - Number(a.available));
					const availableIds = new Set(allEngines.filter(e => e.available).map(e => e.id));
					const entry: IHostEngineProbeCacheEntry = {
						fetchedAt: Date.now(),
						hostLabel,
						allEngines,
						availableIds,
					};
					if (isCurrentProbe()) {
						this.hostEnginesCache.set(key, entry);
					}
					return entry;
				}

				const probe = this.sessionsService!.probeEnginesForProject
					? await this.sessionsService!.probeEnginesForProject(projectUri, { forceRefresh })
					: { engines: await this.sessionsService!.getEngines(projectUri, { forceRefresh }) };

				const byId = new Map<string, IAdeEngineAvailability>();
				if (probe.allEngines && probe.allEngines.length > 0) {
					for (const eng of probe.allEngines) {
						byId.set(eng.id, eng);
					}
				} else {
					for (const eng of probe.engines) {
						byId.set(eng.id, { ...eng, available: !probe.error });
					}
					for (const shortId of ADE_REGISTERED_ENGINES) {
						const id = `aexus-${shortId}`;
						if (!byId.has(id)) {
							const name = MISSION_ENGINE_FALLBACK_NAMES[id] ?? shortId;
							byId.set(id, {
								id,
								name,
								description: name,
								icon: this.sessionsService?.getIcon(id),
								available: false,
							});
						}
					}
				}
				const sorted = [...byId.values()].sort((a, b) => Number(b.available) - Number(a.available));
				const availableIds = new Set<string>(sorted.filter(e => e.available).map(e => e.id));
				const entry: IHostEngineProbeCacheEntry = {
					fetchedAt: Date.now(),
					hostLabel: probe.remoteHost || hostLabel,
					allEngines: sorted,
					availableIds,
					error: probe.error,
				};
				if (isCurrentProbe()) {
					this.hostEnginesCache.set(key, entry);
				}
				return entry;
			} catch (err) {
				const fallbackAll: IAdeEngineAvailability[] = ADE_REGISTERED_ENGINES.map(shortId => {
					const id = `aexus-${shortId}`;
					const name = MISSION_ENGINE_FALLBACK_NAMES[id] ?? shortId;
					return {
						id,
						name,
						description: name,
						icon: this.sessionsService?.getIcon(id),
						available: false,
					};
				});
				const entry: IHostEngineProbeCacheEntry = {
					fetchedAt: Date.now(),
					hostLabel,
					allEngines: fallbackAll,
					availableIds: new Set<string>(),
					error: err instanceof Error ? err.message : String(err),
				};
				if (isCurrentProbe()) {
					this.hostEnginesCache.set(key, entry);
				}
				return entry;
			}
		})().finally(() => {
			if (this.hostEnginesLatestSeq.get(key) === probeSeq) {
				this.hostEnginesPending.delete(key);
			}
		});
		this.hostEnginesPending.set(key, task);
		return task;
	}

	prewarmOrchestrationHosts(
		nodes: readonly IOrchestrationGraphNode[],
		onFreshHostProbed: () => void,
	): void {
		if (this.disposed || (!this.sessionsService && !this.controlCenterService)) {
			return;
		}
		const uniqueHostUris = new Map<string, URI>();
		for (const node of nodes) {
			if (node.kind !== 'staff') {
				continue;
			}
			const probeUri = this.resolveEffectiveNodeProbeUri(node.host, undefined);
			const hKey = this.hostProbeCacheKey(probeUri);
			if (!uniqueHostUris.has(hKey)) {
				uniqueHostUris.set(hKey, probeUri);
			}
		}
		for (const uri of uniqueHostUris.values()) {
			const hadCached = Boolean(this.getCachedHostEngines(uri));
			void this.probeHostEngines(uri, false).then(entry => {
				if (!this.disposed && !hadCached && entry) {
					onFreshHostProbed();
				}
			});
		}
	}

	getCachedConfiguredModels(projectUri: URI, engineId: string): readonly { readonly id: string; readonly label?: string }[] | undefined {
		const entry = this.configuredModelsCache.get(projectUri.toString());
		if (!entry || Date.now() - entry.fetchedAt > CONFIGURED_MODELS_CACHE_TTL_MS) {
			return undefined;
		}
		return entry.data[toPrefixedAdeEngineId(engineId)] ?? entry.data[engineId];
	}

	async fetchConfiguredModels(projectUri: URI): Promise<Record<string, readonly { readonly id: string; readonly label: string }[]> | undefined> {
		if (this.disposed) {
			return undefined;
		}
		const key = projectUri.toString();
		const cached = this.configuredModelsCache.get(key);
		if (cached && Date.now() - cached.fetchedAt <= CONFIGURED_MODELS_CACHE_TTL_MS) {
			return cached.data;
		}
		const pending = this.configuredModelsPending.get(key);
		if (pending) {
			return pending;
		}
		const task = (async () => {
			if (this.commandService) {
				try {
					const res = await this.commandService.executeCommand<Record<string, readonly { readonly id: string; readonly label: string }[]>>(
						'aexus.agentEngines.listConfiguredModels',
						projectUri,
					);
					if (!this.disposed && res && typeof res === 'object') {
						this.configuredModelsCache.set(key, { fetchedAt: Date.now(), data: res });
						return res;
					}
				} catch {
					// Fallback to controlCenterService probe
				}
			}
			if (this.controlCenterService) {
				try {
					const hostArg = isCloudProjectUri(projectUri)
						? (this.cloudHostsByKey.get(projectUri.authority.toLowerCase())?.hostName || projectUri.authority)
						: 'local';
					const out: Record<string, readonly { readonly id: string; readonly label: string }[]> = {};
					await Promise.all(ADE_REGISTERED_ENGINES.map(async shortEng => {
						const res = await this.controlCenterService!.probeModels(hostArg, shortEng);
						const items = res.models.map(m => ({ id: m, label: m }));
						out[shortEng] = items;
						out[`aexus-${shortEng}`] = items;
					}));
					if (!this.disposed) {
						this.configuredModelsCache.set(key, { fetchedAt: Date.now(), data: out });
					}
					return out;
				} catch {
					// Ignore
				}
			}
			return undefined;
		})().finally(() => {
			if (this.configuredModelsPending.get(key) === task) {
				this.configuredModelsPending.delete(key);
			}
		});
		this.configuredModelsPending.set(key, task);
		return task;
	}

	getModelCategoryOverrides(): AdeModelCategoryOverrides {
		return this.modelCategoryOverrides;
	}

	setModelCategoryOverride(engineId: string, modelId: string, vendor: AdeLlmPickerVendor | undefined): void {
		const normKey = normalizeAdeModelIdentityKey(modelId);
		if (!normKey) {
			return;
		}
		const prefEngine = toPrefixedAdeEngineId(engineId);
		const engineMap: Record<string, AdeLlmPickerVendor> = { ...(this.modelCategoryOverrides[prefEngine] ?? {}) };
		if (vendor) {
			engineMap[normKey] = vendor;
			this.modelCategoryOverrides = { ...this.modelCategoryOverrides, [prefEngine]: engineMap };
		} else {
			delete engineMap[normKey];
			const next = { ...this.modelCategoryOverrides };
			if (Object.keys(engineMap).length > 0) {
				next[prefEngine] = engineMap;
			} else {
				delete next[prefEngine];
			}
			this.modelCategoryOverrides = next;
		}
		this.storageService.store(
			MODEL_CATEGORY_OVERRIDES_STORAGE_KEY,
			JSON.stringify(this.modelCategoryOverrides),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
	}

	private loadModelCategoryOverrides(): void {
		const raw = this.storageService.get(MODEL_CATEGORY_OVERRIDES_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
			if (!parsed || typeof parsed !== 'object') {
				return;
			}
			const clean: Record<string, Record<string, AdeLlmPickerVendor>> = {};
			for (const [engineId, modelMap] of Object.entries(parsed)) {
				if (!modelMap || typeof modelMap !== 'object') {
					continue;
				}
				const cleanedEngine: Record<string, AdeLlmPickerVendor> = {};
				for (const [modelKey, vendor] of Object.entries(modelMap)) {
					if (isAdeLlmPickerVendor(vendor)) {
						cleanedEngine[normalizeAdeModelIdentityKey(modelKey)] = vendor;
					}
				}
				if (Object.keys(cleanedEngine).length > 0) {
					clean[toPrefixedAdeEngineId(engineId)] = cleanedEngine;
				}
			}
			this.modelCategoryOverrides = clean;
		} catch {
			// Ignore malformed storage data
		}
	}
}
