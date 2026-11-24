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
import { AdeThinkingLevel } from '../../../../platform/ade/common/adeEngineering.js';
import { IMissionDagNode } from '../../../../platform/ade/common/adeMissionDag.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	AdeLlmPickerVendor,
	AdeModelCategoryOverrides,
	isAdeLlmPickerVendor,
	normalizeAdeModelIdentityKey,
} from '../../../browser/adeLlmIcon.js';
import { resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { IAdeAgent } from '../common/ade.js';
import { IAdeEngineAvailability, IAdeSessionsService } from './adeSessionsService.js';

export const MISSION_ENGINE_FALLBACK_NAMES: Readonly<Record<string, string>> = {
	'aexus-claude': 'Claude Code',
	'aexus-codex': 'Codex',
	'aexus-kilo': 'Kilo Code',
	'aexus-opencode': 'OpenCode',
	'aexus-dsh': 'DeepSeek Harness',
	'aexus-antigravity': 'Google Antigravity',
	'aexus-cline': 'Cline',
	'aexus-pi': 'Pi',
};

export const MISSION_ENGINE_DEFAULT_MODELS: Readonly<Record<string, string>> = {
	'aexus-claude': 'claude-opus-5-5',
	'aexus-codex': 'gpt-6.1-sol',
	'aexus-kilo': 'grok-4.5',
	'aexus-opencode': 'qwen4-max',
	'aexus-dsh': 'deepseek-v4-pro',
	'aexus-antigravity': 'gemini-4-argon',
	'aexus-cline': 'kimi-k3.1-pro',
	'aexus-pi': 'gpt-6.1-sol',
};

export const MISSION_THINKING_LEVEL_OPTIONS: readonly AdeThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

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
	readonly hostAlias: string;
	readonly displayHost: string;
	readonly isRemote: boolean;
	readonly osKind: AdeOsIconKind;
	readonly osLabel: string;
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
 * Manages TTL-cached local & SSH cloud host engine availability probing,
 * deduplicated configured model discovery, cloud host OS metadata, and
 * user-persisted model-to-vendor icon category overrides for the Mission Canvas.
 */
export class AdeMissionHostCatalog extends Disposable {
	private readonly _onDidChangeHosts = this._register(new Emitter<void>());
	readonly onDidChangeHosts: Event<void> = this._onDidChangeHosts.event;

	private cloudHostsByAlias = new Map<string, IAdeCloudHost>();
	private readonly configuredModelsCache = new Map<string, { readonly fetchedAt: number; readonly data: Record<string, readonly { readonly id: string; readonly label: string }[]> }>();
	private readonly configuredModelsPending = new Map<string, Promise<Record<string, readonly { readonly id: string; readonly label: string }[]> | undefined>>();
	private readonly hostEnginesCache = new Map<string, IHostEngineProbeCacheEntry>();
	private readonly hostEnginesPending = new Map<string, Promise<IHostEngineProbeCacheEntry | undefined>>();
	private readonly hostEnginesLatestSeq = new Map<string, number>();
	private hostEnginesCacheEpoch = 0;
	private hostEnginesProbeSeq = 0;
	private modelCategoryOverrides: Record<string, Record<string, AdeLlmPickerVendor>> = {};
	private disposed = false;

	constructor(
		private readonly storageService: IStorageService,
		private readonly sessionsService: IAdeSessionsService | undefined,
		private readonly cloudHostService: IAdeCloudHostBackendService | undefined,
		private readonly commandService: ICommandService | undefined,
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
					const next = new Map<string, IAdeCloudHost>();
					for (const h of hosts) {
						next.set(h.alias.toLowerCase(), h);
						if (h.name) {
							next.set(h.name.toLowerCase(), h);
						}
					}
					this.cloudHostsByAlias = next;
					this._onDidChangeHosts.fire();
				}).catch(() => undefined);
			};
			refreshCloudHosts();
			if (this.cloudHostService.onDidChangeHosts) {
				this._register(this.cloudHostService.onDidChangeHosts(() => refreshCloudHosts()));
			}
		}
	}

	override dispose(): void {
		this.disposed = true;
		this.configuredModelsCache.clear();
		this.configuredModelsPending.clear();
		this.hostEnginesCache.clear();
		this.hostEnginesPending.clear();
		this.hostEnginesLatestSeq.clear();
		super.dispose();
	}

	getEngineDisplayName(engineId: string): string {
		const resolved = this.sessionsService?.getEngineName(engineId);
		return resolved && resolved !== engineId
			? resolved
			: (MISSION_ENGINE_FALLBACK_NAMES[engineId] ?? engineId.replace(/^aexus-/, ''));
	}

	getEngineIcon(engineId: string): URI | ThemeIcon | undefined {
		const liveIcon = this.sessionsService?.getIcon(engineId);
		if (liveIcon) {
			return liveIcon;
		}
		for (const entry of this.hostEnginesCache.values()) {
			const match = entry.allEngines.find(e => e.id === engineId);
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
	}

	resolveNodeHostAndOs(
		explicitHostAlias: string | undefined,
		linkedAgent: IAdeAgent | undefined,
	): IMissionNodeHostInfo {
		const trimmedExplicit = explicitHostAlias?.trim();
		const uriAuthority = linkedAgent && isCloudProjectUri(linkedAgent.projectUri) ? linkedAgent.projectUri.authority : undefined;
		const rawHost = trimmedExplicit || uriAuthority || 'local';
		const isRemote = rawHost !== 'local';
		if (!isRemote) {
			const osKind = resolveLocalOsIconKind();
			return {
				hostAlias: 'local',
				displayHost: 'Local',
				isRemote: false,
				osKind,
				osLabel: ADE_OS_ICON_LABELS[osKind],
			};
		}
		const savedHost = this.cloudHostsByAlias.get(rawHost.toLowerCase());
		const displayHost = savedHost?.alias || rawHost;
		const osKind = resolveAdeOsIconKind({
			os: savedHost?.os,
			distribution: savedHost?.lastTestStatus?.remoteUname,
			hint: `${savedHost?.name ?? ''} ${savedHost?.alias ?? ''} ${savedHost?.user ?? ''} ${rawHost} ${linkedAgent?.projectUri.path ?? ''}`,
		});
		return {
			hostAlias: displayHost,
			displayHost,
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
			const savedHost = this.cloudHostsByAlias.get(explicitHost.toLowerCase());
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

	getCachedHostEngines(projectUri: URI): IHostEngineProbeCacheEntry | undefined {
		const entry = this.hostEnginesCache.get(this.hostProbeCacheKey(projectUri));
		if (!entry || Date.now() - entry.fetchedAt > HOST_ENGINES_CACHE_TTL_MS) {
			return undefined;
		}
		return entry;
	}

	async probeHostEngines(projectUri: URI, forceRefresh = false): Promise<IHostEngineProbeCacheEntry | undefined> {
		if (!this.sessionsService || this.disposed) {
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
					for (const [id, name] of Object.entries(MISSION_ENGINE_FALLBACK_NAMES)) {
						if (!byId.has(id)) {
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
				const fallbackAll: IAdeEngineAvailability[] = Object.entries(MISSION_ENGINE_FALLBACK_NAMES).map(([id, name]) => ({
					id,
					name,
					description: name,
					icon: this.sessionsService?.getIcon(id),
					available: false,
				}));
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

	prewarmMissionHosts(
		nodes: readonly IMissionDagNode[],
		resolveAgentForNode: (node: IMissionDagNode) => IAdeAgent | undefined,
		resolveExplicitHost: (nodeId: string) => string | undefined,
		onFreshHostProbed: () => void,
	): void {
		if (!this.sessionsService || this.disposed) {
			return;
		}
		const uniqueHostUris = new Map<string, URI>();
		const uniqueModelUris = new Map<string, URI>();
		for (const node of nodes) {
			if (node.kind === 'gate') {
				continue;
			}
			const linkedAgent = resolveAgentForNode(node);
			if (!linkedAgent) {
				continue;
			}
			const probeUri = this.resolveEffectiveNodeProbeUri(resolveExplicitHost(node.id), linkedAgent);
			const hKey = this.hostProbeCacheKey(probeUri);
			if (!uniqueHostUris.has(hKey)) {
				uniqueHostUris.set(hKey, probeUri);
			}
			const mKey = probeUri.toString();
			if (!uniqueModelUris.has(mKey)) {
				uniqueModelUris.set(mKey, probeUri);
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
		for (const uri of uniqueModelUris.values()) {
			void this.fetchConfiguredModels(uri);
		}
	}

	getCachedConfiguredModels(projectUri: URI, engineId: string): readonly { readonly id: string; readonly label?: string }[] | undefined {
		const entry = this.configuredModelsCache.get(projectUri.toString());
		if (!entry || Date.now() - entry.fetchedAt > CONFIGURED_MODELS_CACHE_TTL_MS) {
			return undefined;
		}
		return entry.data[engineId];
	}

	async fetchConfiguredModels(projectUri: URI): Promise<Record<string, readonly { readonly id: string; readonly label: string }[]> | undefined> {
		if (this.disposed || !this.commandService) {
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
			try {
				const res = await this.commandService!.executeCommand<Record<string, readonly { readonly id: string; readonly label: string }[]>>(
					'aexus.agentEngines.listConfiguredModels',
					projectUri,
				);
				if (!this.disposed && res && typeof res === 'object') {
					this.configuredModelsCache.set(key, { fetchedAt: Date.now(), data: res });
					return res;
				}
			} catch {
				// Best-effort live discovery; native catalog fallback stays active.
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
		const engineMap: Record<string, AdeLlmPickerVendor> = { ...(this.modelCategoryOverrides[engineId] ?? {}) };
		if (vendor) {
			engineMap[normKey] = vendor;
			this.modelCategoryOverrides = { ...this.modelCategoryOverrides, [engineId]: engineMap };
		} else {
			delete engineMap[normKey];
			const next = { ...this.modelCategoryOverrides };
			if (Object.keys(engineMap).length > 0) {
				next[engineId] = engineMap;
			} else {
				delete next[engineId];
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
					clean[engineId] = cleanedEngine;
				}
			}
			this.modelCategoryOverrides = clean;
		} catch {
			// Ignore malformed storage data
		}
	}
}
