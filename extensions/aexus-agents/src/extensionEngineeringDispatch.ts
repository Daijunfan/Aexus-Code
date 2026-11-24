/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { discoverEngineModels, EngineId } from './capabilities';
import {
	clearCloudTransportCaches,
	CloudHostTarget,
	isCloudUri,
	 probeRemoteEngines,
	resolveCloudHostTarget,
	toRemoteNativePath,
} from './cloudTransport';
import {
	computeMeasuredContextSegments,
	definitions,
	hashRolePrompt,
	parseOptionalUri,
	recordCloudAuthority,
	RecordEntry,
	resolveCompletedTurnUsage,
	SecretaryState,
} from './extensionSessionHelpers';
import { NativeRoleBridgeController } from './nativeRoleBridge';
import {
	AEXUS_PREAMBLE_END_MARKER,
	computeStaticRolePromptHash,
	extractDynamicRoleBindingsTail,
	extractStaticRoleCharter,
	isRawPureRole,
	RoleSyncSnapshot,
} from './roleBridgeShared';
import {
	EngineRuntime,
	EngineRuntimeCapabilities,
	EngineSendOptions,
	EngineThinkingLevel,
	EngineTurnTokenUsage,
	getConfiguredEngineIdleStallTimeoutMs,
	getConfiguredEngineTurnTimeoutMs,
	isAutonomousModeEnabled,
	mintSessionCapabilityToken,
	setHostWindowId,
} from './runtime';
import { SessionTurnCoordinator } from './turnCoordinator';
import { createStreamToolErrorScanner, detectToolErrorInProgressText, detectToolErrorInStreamPart } from './usageTracker';

export interface EngineeringBridgeDeps {
	readonly context: vscode.ExtensionContext;
	readonly roleBridge: NativeRoleBridgeController;
	readonly records: Map<string, RecordEntry>;
	readonly controllers: ReadonlyMap<string, vscode.ChatSessionItemController>;
	readonly turnCoordinator: SessionTurnCoordinator<vscode.CancellationTokenSource>;
	readonly lastTurnReplies: Map<string, string>;
	readonly lastTurnErrors: Map<string, string>;
	getSecretaryState(): SecretaryState | undefined;
	defaultCwd(): string;
	key(engine: string, id: string): string;
	identity(record: RecordEntry): string;
	item(record: RecordEntry): vscode.ChatSessionItem;
	syncRecordStorageKey(record: RecordEntry, prevId: string): void;
	refreshSecretaryItem(): void;
	findCachedRecord(uri: vscode.Uri): RecordEntry | undefined;
	getRecord(uri: vscode.Uri, token: vscode.CancellationToken): Promise<RecordEntry>;
	runtimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget }>;
	tryRuntimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget } | undefined>;
	getCachedRuntimeCaps(shortEng: string, cwd: string, authority?: string): EngineRuntimeCapabilities;
	notifySessionOptionsUpdated(sessionType: string, sessionUri: vscode.Uri, refreshGroups?: boolean): Promise<void>;
	notifyCloudProjectMutated(cloudProjectUri: string | undefined): void;
	publishHistory(record: RecordEntry): Promise<void>;
	save(): Promise<void>;
}

export function registerEngineeringAndRoleBridge(deps: EngineeringBridgeDeps): {
	readonly refreshRoleSnapshotFromWorkbench: () => Promise<RoleSyncSnapshot | undefined>;
	readonly evictSyncedAgentPrefs: (resourceStr: string) => void;
} {
	const {
		context,
		roleBridge,
		records,
		controllers,
		turnCoordinator,
		lastTurnReplies,
		lastTurnErrors,
	} = deps;

	const lastSyncedAgentPrefs = new Map<string, { model?: string; thinking?: string }>();
	const evictSyncedAgentPrefs = (resourceStr: string): void => {
		lastSyncedAgentPrefs.delete(resourceStr);
	};

	const bindNativeRecord = (agentResource: string | undefined, realNativeId: string) => {
		if (!agentResource || !realNativeId) { return; }
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(agentResource);
		} catch {
			return;
		}
		const record = deps.findCachedRecord(uri);
		if (!record) { return; }
		if (record.id === realNativeId && !record.provisional && !record.unmaterialized) { return; }

		const prevId = record.id;
		const nextPlainKey = deps.key(record.engine, realNativeId);
		const existingReal = records.get(nextPlainKey);
		record.resourceId ??= record.id;
		if (existingReal && existingReal !== record && recordCloudAuthority(existingReal) === recordCloudAuthority(record)) {
			record.file ??= existingReal.file;
			record.created ||= existingReal.created;
			record.updated = Math.max(record.updated, existingReal.updated);
		}
		record.id = realNativeId;
		record.provisional = false;
		record.unmaterialized = false;
		deps.syncRecordStorageKey(record, prevId);
		controllers.get(record.engine)?.items.add(deps.item(record));
		const secState = deps.getSecretaryState();
		if (secState && records.get(secState.recordKey) === record) {
			deps.refreshSecretaryItem();
		}
		void deps.save();
	};

	const syncPreferencesFromSnapshot = (snapshot: RoleSyncSnapshot) => {
		let dirty = false;
		for (const agentEntry of snapshot.agents) {
			if (!agentEntry.resource) {
				continue;
			}
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(agentEntry.resource);
			} catch {
				continue;
			}
			const rec = deps.findCachedRecord(uri);
			if (!rec) {
				continue;
			}
			const cfg = (rec.sessionConfig ??= {});
			const prev = lastSyncedAgentPrefs.get(agentEntry.resource) ?? {};
			let recUpdated = false;
			if (agentEntry.preferredModel) {
				const prefChanged = prev.model !== undefined && prev.model !== agentEntry.preferredModel;
				if ((prefChanged || !cfg.model || cfg.model === 'default') && cfg.model !== agentEntry.preferredModel) {
					cfg.model = agentEntry.preferredModel;
					recUpdated = true;
				}
				prev.model = agentEntry.preferredModel;
			}
			if (agentEntry.preferredThinking) {
				const mappedThinking = agentEntry.preferredThinking === 'none' ? 'off' : agentEntry.preferredThinking;
				const prefChanged = prev.thinking !== undefined && prev.thinking !== mappedThinking;
				if ((prefChanged || !cfg.thinking || cfg.thinking === 'default') && cfg.thinking !== mappedThinking) {
					cfg.thinking = mappedThinking;
					recUpdated = true;
				}
				prev.thinking = mappedThinking;
			}
			lastSyncedAgentPrefs.set(agentEntry.resource, prev);
			if (recUpdated) {
				dirty = true;
				void deps.notifySessionOptionsUpdated(`aexus-${rec.engine}`, uri, true);
			}
		}
		if (dirty) {
			void deps.save();
		}
	};

	const enrichRoleSnapshot = async (raw: RoleSyncSnapshot): Promise<RoleSyncSnapshot> => {
		syncPreferencesFromSnapshot(raw);
		const [agyBindings, externalBindings] = await Promise.all([
			roleBridge.readAgyBindings(),
			roleBridge.readExternalNativeBindings(),
		]);
		const agyAgentToConv = new Map<string, string>();
		for (const [conversationId, agentId] of Object.entries(agyBindings)) {
			agyAgentToConv.set(agentId, conversationId);
		}
		const externalByKey = new Map<string, string>();
		for (const binding of externalBindings) {
			externalByKey.set(`${binding.shortEngine}:${binding.agentId}`, binding.nativeSessionId);
		}
		const [enrichedAgents, secretaryMinted] = await Promise.all([
			Promise.all(raw.agents.map(async entry => {
				let nativeSessionId = entry.nativeSessionId;
				if (!nativeSessionId && entry.resource) {
					try {
						const record = deps.findCachedRecord(vscode.Uri.parse(entry.resource));
						if (record && !record.provisional && !record.unmaterialized) {
							nativeSessionId = record.id;
						}
					} catch { /* Ignore invalid resource URI. */ }
				}
				if (entry.engineId?.startsWith('aexus-')) {
					const shortEngine = entry.engineId.slice('aexus-'.length);
					const extNativeId = externalByKey.get(`${shortEngine}:${entry.id}`);
					if (extNativeId) {
						nativeSessionId ??= extNativeId;
						if (entry.resource) {
							bindNativeRecord(entry.resource, extNativeId);
						}
					}
				}
				if (entry.engineId === 'aexus-antigravity') {
					const agyConvId = agyAgentToConv.get(entry.id);
					if (agyConvId) {
						nativeSessionId ??= agyConvId;
						if (entry.resource) {
							bindNativeRecord(entry.resource, agyConvId);
						}
					}
				}
				let sessionToken = entry.sessionToken;
				let controlSocketPath = entry.controlSocketPath;
				if (raw.mode === 'ade' && !sessionToken) {
					const isStandalonePure = !entry.isOrchestrated && !entry.isMissionNode;
					const isRawPure = isStandalonePure || isRawPureRole({ callerRole: entry.rank });
					const minted = await mintSessionCapabilityToken(
						entry.id,
						entry.rank || 'worker',
						isRawPure,
						process.env,
						Boolean(entry.isMissionNode),
					);
					if (minted) {
						sessionToken = minted.token;
						controlSocketPath = isStandalonePure ? undefined : minted.socketPath;
					}
				}
				return {
					...entry,
					...(nativeSessionId ? { nativeSessionId } : {}),
					...(sessionToken ? { sessionToken } : {}),
					...(controlSocketPath ? { controlSocketPath } : {}),
				};
			})),
			raw.mode === 'ade'
				? mintSessionCapabilityToken('__secretary__', 'secretary', false, process.env, false)
				: Promise.resolve(undefined),
		]);
		return {
			...raw,
			agents: enrichedAgents,
			...(secretaryMinted?.token ? { secretarySessionToken: secretaryMinted.token } : {}),
			...(secretaryMinted?.socketPath ? { secretaryControlSocketPath: secretaryMinted.socketPath } : {}),
		};
	};

	roleBridge.setOnNativeSessionBound((_shortEngine, agentId, realNativeId) => {
		const agent = roleBridge.getSnapshot().agents.find(entry => entry.id === agentId);
		if (agent?.resource) {
			bindNativeRecord(agent.resource, realNativeId);
		}
	});

	let lastRoleSnapshotSig: string | undefined;
	const updateSnapshotIfChanged = async (enriched: RoleSyncSnapshot): Promise<void> => {
		const sig = JSON.stringify(enriched);
		if (sig === lastRoleSnapshotSig) {
			return;
		}
		lastRoleSnapshotSig = sig;
		await roleBridge.updateSnapshot(enriched);
	};

	let bindingSyncInFlight = false;
	let bindingSyncPending = false;
	const syncExternalBindingsIntoSnapshot = async () => {
		if (bindingSyncInFlight) {
			bindingSyncPending = true;
			return;
		}
		bindingSyncInFlight = true;
		try {
			do {
				bindingSyncPending = false;
				const current = roleBridge.getSnapshot();
				if (!current.agents.length) {
					continue;
				}
				const enriched = await enrichRoleSnapshot(current);
				const changed = enriched.agents.some((entry, idx) => entry.nativeSessionId !== current.agents[idx]?.nativeSessionId);
				if (changed) {
					await updateSnapshotIfChanged(enriched);
				}
			} while (bindingSyncPending);
		} finally {
			bindingSyncInFlight = false;
		}
	};

	const stopBindingWatcher = roleBridge.watchExternalBindings(() => {
		void syncExternalBindingsIntoSnapshot();
	});

	let refreshInFlight: Promise<RoleSyncSnapshot | undefined> | undefined;
	const refreshRoleSnapshotFromWorkbench = (): Promise<RoleSyncSnapshot | undefined> => {
		if (refreshInFlight) {
			return refreshInFlight;
		}
		const run = (async (): Promise<RoleSyncSnapshot | undefined> => {
			try {
				const fresh = await Promise.resolve(vscode.commands.executeCommand<RoleSyncSnapshot>('aexus.ade.getRoleSyncSnapshot'));
				if (fresh && typeof fresh === 'object' && Array.isArray(fresh.agents)) {
					const enriched = await enrichRoleSnapshot(fresh);
					await updateSnapshotIfChanged(enriched);
					return enriched;
				}
			} catch { /* Workbench command may be unavailable during shutdown or tests. */ }
			return undefined;
		})();
		refreshInFlight = run.finally(() => {
			if (refreshInFlight === run) {
				refreshInFlight = undefined;
			}
		});
		return refreshInFlight;
	};

	context.subscriptions.push(
		{
			dispose: () => {
				stopBindingWatcher();
				roleBridge.dispose();
				clearCloudTransportCaches();
			},
		},
		vscode.commands.registerCommand('aexus.agentEngines.listConfiguredModels', async (rawProject?: vscode.Uri | string): Promise<Record<string, readonly { readonly id: string; readonly label: string }[]>> => {
			const out: Record<string, readonly { readonly id: string; readonly label: string }[]> = {};
			const parsedProject = parseOptionalUri(rawProject);
			let remoteTarget = isCloudUri(parsedProject)
				? await resolveCloudHostTarget(parsedProject.authority).catch(() => undefined)
				: undefined;
			if (remoteTarget && !remoteTarget.remoteHome) {
				const probed = await probeRemoteEngines(remoteTarget).catch(() => undefined);
				if (probed?.target) {
					remoteTarget = probed.target;
				}
			}
			const cwd = isCloudUri(parsedProject) && remoteTarget
				? toRemoteNativePath(parsedProject.path || '/', remoteTarget.os, remoteTarget.remoteHome)
				: (parsedProject?.scheme === 'file' ? parsedProject.fsPath : deps.defaultCwd());
			const legacyKeys: Record<EngineId, string[]> = {
				'aexus-claude': ['claude-code', 'aexus-claude'],
				'aexus-codex': ['codex', 'aexus-codex'],
				'aexus-kilo': ['kilo', 'aexus-kilo'],
				'aexus-opencode': ['opencode', 'aexus-opencode'],
				'aexus-dsh': ['dsh', 'aexus-dsh'],
				'aexus-antigravity': ['antigravity', 'aexus-antigravity'],
				'aexus-cline': ['cline', 'aexus-cline'],
				'aexus-pi': ['pi', 'aexus-pi'],
			};
			await Promise.all(definitions.map(async def => {
				try {
					const caps = deps.getCachedRuntimeCaps(def.id, cwd, remoteTarget?.authority);
					const items = (await discoverEngineModels(def.type, cwd, caps.models, caps.defaultModel, [], remoteTarget))
						.filter(m => m.id !== 'default')
						.map(m => ({ id: m.id, label: m.name !== m.id ? `${m.name} (${m.id})` : m.id }));
					if (items.length > 0) {
						for (const aliasKey of legacyKeys[def.type]) {
							out[aliasKey] = items;
						}
					}
				} catch { /* Non-fatal single-engine model discovery failure */ }
			}));
			return out;
		}),
		vscode.commands.registerCommand('aexus.agentEngines.dispatchEngineeringTurn', async (
			uri: vscode.Uri,
			rawPrompt: string,
			rawOptions?: {
				agentId?: string;
				missionId?: string;
				nodeId?: string;
				tokenId?: string;
				turnId?: string;
				model?: string;
				thinking?: EngineThinkingLevel;
				pureWorker?: boolean;
				callerRole?: string;
				isMissionNode?: boolean;
				autonomousApproved?: boolean;
				sandboxMode?: string;
				preferReattach?: boolean;
				timeoutMs?: number;
			},
		) => {
			const lookupToken = new vscode.CancellationTokenSource();
			let record: RecordEntry;
			try {
				record = await deps.getRecord(uri, lookupToken.token);
			} finally {
				lookupToken.dispose();
			}

			record.resourceId ??= record.id;
			const recordKey = deps.identity(record);
			const forceKillRecord = async () => {
				const resolved = await deps.tryRuntimeForRecord(record).catch(() => undefined);
				if (resolved) {
					await resolved.engine.killSession?.(record).catch(() => undefined);
				}
			};
			const turnTimeoutMs = typeof rawOptions?.timeoutMs === 'number' && Number.isFinite(rawOptions.timeoutMs) && rawOptions.timeoutMs > 0
				? rawOptions.timeoutMs
				: getConfiguredEngineTurnTimeoutMs();
			const lease = await turnCoordinator.acquire({
				key: recordKey,
				source: 'headless',
				createCts: () => new vscode.CancellationTokenSource(),
				forceKill: forceKillRecord,
				graceTimeoutMs: 2500,
				turnTimeoutMs,
				idleStallTimeoutMs: getConfiguredEngineIdleStallTimeoutMs(),
			});
			if (!lease) {
				return {
					reply: '',
					nativeId: record.id,
					stopped: true,
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
				};
			}

			const turnCancellation = lease.cts;
			let streamedMarkdown = '';
			let activeEngine: EngineRuntime | undefined;
			let finalizeTurnUsage: ((engine: EngineRuntime, replyText: string) => EngineTurnTokenUsage & { turns: number }) | undefined;
			try {
				controllers.get(record.engine)?.items.add(deps.item(record));
				const secState = deps.getSecretaryState();
				if (secState && records.get(secState.recordKey) === record) {
					deps.refreshSecretaryItem();
				}
				const liveDispatchSnap = await refreshRoleSnapshotFromWorkbench();
				const snapEntryForDispatch = (liveDispatchSnap ?? roleBridge.getSnapshot()).agents.find(a => a.id === rawOptions?.agentId || a.resource === uri.toString());
				const isMissionNodeDispatch = Boolean(rawOptions?.isMissionNode ?? snapEntryForDispatch?.isMissionNode);
				const isPureWorker = Boolean(rawOptions?.pureWorker) && !isMissionNodeDispatch;
				let finalPrompt = rawPrompt;
				let callerRole: string | undefined;
				let alreadyInit = false;
				let headlessPromptHash: string | undefined;
				let headlessTrimmedInjected: string | undefined;
				let headlessStaticSystemCharter: string | undefined;
				let headlessPendingDelta: string | undefined;
				const supportsSystemCharterFlag = record.engine === 'claude' || record.engine === 'pi';
				if (!isPureWorker) {
					const snapEntry = snapEntryForDispatch;
					callerRole = rawOptions?.callerRole ?? snapEntry?.rank;
					headlessPromptHash = computeStaticRolePromptHash(snapEntry);
					alreadyInit = Boolean(
						callerRole
						&& record.roleInit
						&& record.roleInit.engine === record.engine
						&& record.roleInit.rank === callerRole
						&& (
							headlessPromptHash
								? record.roleInit.promptHash === headlessPromptHash
								: Boolean(record.roleInit.promptHash)
						),
					);
					const injected = await Promise.resolve(vscode.commands.executeCommand<string | undefined>(
						'aexus.ade.resolvePromptContext',
						alreadyInit
							? { ...(rawOptions?.agentId ? { agentId: rawOptions.agentId } : {}), resource: uri, mode: 'delta' }
							: (rawOptions?.agentId ? { agentId: rawOptions.agentId, resource: uri } : uri),
					)).catch(() => undefined);
					headlessTrimmedInjected = injected?.trim();
					if (supportsSystemCharterFlag) {
						const candidateCharter = extractStaticRoleCharter(snapEntry?.rolePrompt ?? (!alreadyInit ? headlessTrimmedInjected : undefined), snapEntry?.staticRoleCharter)
							|| record.roleInit?.staticSystemCharter;
						if (candidateCharter) {
							headlessStaticSystemCharter = candidateCharter;
							headlessPromptHash ??= hashRolePrompt(candidateCharter);
						}
					} else if (!alreadyInit && !headlessPromptHash && headlessTrimmedInjected) {
						const extractedStatic = extractStaticRoleCharter(headlessTrimmedInjected);
						if (extractedStatic) {
							headlessPromptHash = hashRolePrompt(extractedStatic);
						}
					}
					if (headlessTrimmedInjected) {
						const userTurnPreamble = (!alreadyInit && headlessStaticSystemCharter)
							? extractDynamicRoleBindingsTail(headlessTrimmedInjected, headlessStaticSystemCharter)
							: headlessTrimmedInjected;
						if (userTurnPreamble && (!alreadyInit || userTurnPreamble !== record.lastDeltaContext)) {
							finalPrompt = `${userTurnPreamble}\n\n${AEXUS_PREAMBLE_END_MARKER}\n\n${rawPrompt}`;
							if (alreadyInit) {
								headlessPendingDelta = userTurnPreamble;
							}
						}
					}
				}

				let lastHeartbeatSent = 0;
				const emitHeartbeat = () => {
					lease.touchActivity();
					const now = Date.now();
					if (now - lastHeartbeatSent >= 1000) {
						lastHeartbeatSent = now;
						void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.workerHeartbeat', uri.toString(), now)).catch(() => undefined);
					}
				};

				let headlessToolErrorCount = 0;
				const headlessErrorScanner = createStreamToolErrorScanner();
				const headlessStreamTarget: vscode.ChatResponseStream = Object.create(null);
				const headlessStream: vscode.ChatResponseStream = new Proxy(headlessStreamTarget, {
					get(_dummy, prop) {
						if (prop === 'markdown') {
							return (value: string | vscode.MarkdownString) => {
								const textChunk = typeof value === 'string' ? value : value.value;
								if (textChunk) {
									if (headlessErrorScanner.scan(textChunk)) {
										headlessToolErrorCount += 1;
									}
									streamedMarkdown += textChunk;
									emitHeartbeat();
								}
							};
						}
						if (prop === 'progress') {
							return (value?: string) => {
								if (typeof value === 'string' && detectToolErrorInProgressText(value)) {
									headlessToolErrorCount += 1;
								}
								emitHeartbeat();
							};
						}
						if (prop === 'push') {
							return (part: unknown) => {
								if (detectToolErrorInStreamPart(part)) {
									headlessToolErrorCount += 1;
								}
								emitHeartbeat();
							};
						}
						return () => { };
					},
				});

				const turnStartedAt = Date.now();
				const headlessInjectedContract = (!alreadyInit || headlessPendingDelta !== undefined) ? headlessTrimmedInjected : undefined;
				const reportedSoFar = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: 0 };
				let lastInterimReportAt = 0;
				const reportInterimUsage = (cumulative: EngineTurnTokenUsage) => {
					const now = Date.now();
					if (now - lastInterimReportAt < 1200) {
						return;
					}
					const delta = {
						inputTokens: Math.max(0, cumulative.inputTokens - reportedSoFar.inputTokens),
						outputTokens: Math.max(0, cumulative.outputTokens - reportedSoFar.outputTokens),
						cacheReadTokens: Math.max(0, (cumulative.cacheReadTokens ?? 0) - reportedSoFar.cacheReadTokens),
						cacheWriteTokens: Math.max(0, (cumulative.cacheWriteTokens ?? 0) - reportedSoFar.cacheWriteTokens),
						totalTokens: Math.max(0, cumulative.totalTokens - reportedSoFar.totalTokens),
					};
					if (delta.totalTokens === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) {
						return;
					}
					lastInterimReportAt = now;
					reportedSoFar.inputTokens += delta.inputTokens;
					reportedSoFar.outputTokens += delta.outputTokens;
					reportedSoFar.cacheReadTokens += delta.cacheReadTokens;
					reportedSoFar.cacheWriteTokens += delta.cacheWriteTokens;
					reportedSoFar.totalTokens += delta.totalTokens;
					let deltaCostUsd: number | undefined;
					if (typeof cumulative.costUsd === 'number' && Number.isFinite(cumulative.costUsd) && cumulative.costUsd > reportedSoFar.costUsd) {
						deltaCostUsd = Math.round((cumulative.costUsd - reportedSoFar.costUsd) * 1_000_000) / 1_000_000;
						reportedSoFar.costUsd = cumulative.costUsd;
					}
					const segments = computeMeasuredContextSegments({
						injectedContractText: headlessInjectedContract,
						rawPrompt,
						finalPrompt,
						appendSystemPrompt: headlessStaticSystemCharter,
						usage: cumulative,
						isFirstTurn: !alreadyInit,
					});
					const effectiveHeadlessToolErrors = Math.max(headlessToolErrorCount, cumulative.toolErrorCount ?? 0);
					const effectiveModel = cumulative.model || (rawOptions?.model && rawOptions.model !== 'default' ? rawOptions.model : undefined);
					void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.recordTurnUsage', {
						sessionResource: uri.toString(),
						agentId: rawOptions?.agentId,
						missionId: rawOptions?.missionId,
						nodeId: rawOptions?.nodeId,
						tokenId: rawOptions?.tokenId,
						turnId: rawOptions?.turnId,
						usage: {
							...delta,
							...segments,
							...(deltaCostUsd !== undefined ? { costUsd: deltaCostUsd } : {}),
							...(effectiveHeadlessToolErrors > 0 || cumulative.hadToolError ? { hadToolError: true, toolErrorCount: Math.max(1, effectiveHeadlessToolErrors) } : {}),
							model: effectiveModel,
							engineId: record.engine,
							turns: 0,
							...(cumulative.estimated !== undefined ? { estimated: cumulative.estimated } : {}),
						},
					})).catch(() => undefined);
				};
				finalizeTurnUsage = (engine: EngineRuntime, replyText: string) => {
					const finalUsage = resolveCompletedTurnUsage(engine, record.id, finalPrompt, replyText, turnStartedAt);
					const segments = computeMeasuredContextSegments({
						injectedContractText: headlessInjectedContract,
						rawPrompt,
						finalPrompt,
						appendSystemPrompt: headlessStaticSystemCharter,
						usage: finalUsage,
						isFirstTurn: !alreadyInit,
					});
					const finalCostUsd = typeof finalUsage.costUsd === 'number' && Number.isFinite(finalUsage.costUsd)
						? Math.max(0, Math.round((finalUsage.costUsd - reportedSoFar.costUsd) * 1_000_000) / 1_000_000)
						: undefined;
					const finalToolErrors = Math.max(headlessToolErrorCount, finalUsage.toolErrorCount ?? 0);
					return {
						inputTokens: Math.max(0, finalUsage.inputTokens - reportedSoFar.inputTokens),
						outputTokens: Math.max(0, finalUsage.outputTokens - reportedSoFar.outputTokens),
						cacheReadTokens: Math.max(0, (finalUsage.cacheReadTokens ?? 0) - reportedSoFar.cacheReadTokens),
						cacheWriteTokens: Math.max(0, (finalUsage.cacheWriteTokens ?? 0) - reportedSoFar.cacheWriteTokens),
						totalTokens: Math.max(0, finalUsage.totalTokens - reportedSoFar.totalTokens),
						...segments,
						durationMs: finalUsage.durationMs,
						...(finalCostUsd !== undefined ? { costUsd: finalCostUsd } : {}),
						...(finalToolErrors > 0 || finalUsage.hadToolError ? { hadToolError: true, toolErrorCount: Math.max(1, finalToolErrors) } : {}),
						model: finalUsage.model || (rawOptions?.model && rawOptions.model !== 'default' ? rawOptions.model : undefined),
						engineId: record.engine,
						turns: 1,
						estimated: finalUsage.estimated,
					};
				};

				if (turnCancellation.token.isCancellationRequested) {
					return {
						reply: '',
						nativeId: record.id,
						stopped: true,
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
					};
				}

				const resolvedEng = await deps.runtimeForRecord(record);
				const engine = resolvedEng.engine;
				activeEngine = engine;
				const prevId = record.id;
				let contextCompactedDuringTurn = false;
				const cfg = record.sessionConfig ?? {};
				const effectiveAutomatedEngineering = rawOptions?.autonomousApproved !== undefined
					? (rawOptions.autonomousApproved || isAutonomousModeEnabled())
					: true;
				const effectiveSandboxMode = rawOptions?.sandboxMode && rawOptions.sandboxMode !== 'default'
					? rawOptions.sandboxMode
					: (cfg.sandboxMode && cfg.sandboxMode !== 'default' ? cfg.sandboxMode : undefined);
				const headlessSendOptions: EngineSendOptions = {
					model: rawOptions?.model ?? (cfg.model && cfg.model !== 'default' ? cfg.model : undefined),
					thinking: rawOptions?.thinking ?? (cfg.thinking && cfg.thinking !== 'default' ? cfg.thinking : undefined),
					mode: cfg.mode && cfg.mode !== 'default' ? cfg.mode : undefined,
					permissionMode: cfg.permissionMode && cfg.permissionMode !== 'default' ? cfg.permissionMode : undefined,
					sandboxMode: effectiveSandboxMode,
					webSearch: cfg.webSearch,
					pureWorker: isPureWorker,
					callerRole,
					isMissionNode: isMissionNodeDispatch,
					adeSessionId: rawOptions?.agentId ?? snapEntryForDispatch?.id,
					automatedEngineering: effectiveAutomatedEngineering,
					onInterimUsage: reportInterimUsage,
					onContextCompacted: () => {
						contextCompactedDuringTurn = true;
						record.roleInit = undefined;
						record.lastDeltaContext = undefined;
					},
					abortSignal: lease.abortSignal,
					timeoutMs: turnTimeoutMs,
					...(headlessStaticSystemCharter ? { appendSystemPrompt: headlessStaticSystemCharter } : {}),
					onStreamActivity: emitHeartbeat,
					onExternalWaitStart: () => lease.beginExternalWait(),
					onExternalWaitEnd: () => lease.endExternalWait(),
				};
				if (engine.prepareSession) {
					await engine.prepareSession(record, headlessSendOptions, turnCancellation.token);
					deps.syncRecordStorageKey(record, prevId);
					await deps.save();
				}
				if (turnCancellation.token.isCancellationRequested) {
					return {
						reply: '',
						nativeId: record.id,
						stopped: true,
						usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
					};
				}
				lastTurnErrors.delete(recordKey);
				const preSendId = record.id;
				let reattached = false;
				if (rawOptions?.preferReattach && engine.reattachIfRunning) {
					const reattachOutcome = await engine.reattachIfRunning(record, headlessStream, turnCancellation.token, {
						...headlessSendOptions,
						preferReattach: true,
					}).catch(() => 'not_running' as const);
					reattached = reattachOutcome === 'reattached';
				}
				if (!reattached) {
					await engine.send(record, finalPrompt, headlessStream, turnCancellation.token, headlessSendOptions);
				}
				deps.syncRecordStorageKey(record, preSendId);
				if (contextCompactedDuringTurn) {
					record.roleInit = undefined;
					record.lastDeltaContext = undefined;
				} else if (!reattached && !isPureWorker && !alreadyInit && callerRole && !turnCancellation.token.isCancellationRequested) {
					record.roleInit = {
						rank: callerRole,
						engine: record.engine,
						promptHash: headlessPromptHash ?? hashRolePrompt(headlessTrimmedInjected),
						...(headlessStaticSystemCharter ? { staticSystemCharter: headlessStaticSystemCharter } : {}),
						initializedAt: Date.now(),
					};
					record.lastDeltaContext = undefined;
				} else if (!reattached && !isPureWorker && headlessPendingDelta !== undefined && !turnCancellation.token.isCancellationRequested) {
					record.lastDeltaContext = headlessPendingDelta;
				}
				if (streamedMarkdown.trim()) {
					lastTurnReplies.set(deps.identity(record), streamedMarkdown.trim());
				}
				record.updated = Date.now();
				return {
					reply: streamedMarkdown.trim(),
					nativeId: record.id,
					stopped: turnCancellation.token.isCancellationRequested,
					...(reattached ? { reattached: true } : {}),
					usage: finalizeTurnUsage(engine, streamedMarkdown),
				};
			} catch (error) {
				if (turnCancellation.token.isCancellationRequested || error instanceof vscode.CancellationError) {
					return {
						reply: streamedMarkdown.trim(),
						nativeId: record.id,
						stopped: true,
						usage: activeEngine && finalizeTurnUsage ? finalizeTurnUsage(activeEngine, streamedMarkdown) : { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 1 },
					};
				}
				const errText = error instanceof Error ? error.message : String(error);
				lastTurnErrors.set(deps.identity(record), errText);
				throw error;
			} finally {
				lease.markSettling();
				turnCancellation.dispose();
				turnCoordinator.release(lease);
				if (records.has(deps.key(record.engine, record.id)) || [...records.values()].includes(record)) {
					controllers.get(record.engine)?.items.add(deps.item(record));
				}
				const secStateAfter = deps.getSecretaryState();
				if (secStateAfter && records.get(secStateAfter.recordKey) === record) {
					deps.refreshSecretaryItem();
				}
				deps.notifyCloudProjectMutated(record.cloudProjectUri);
				await deps.publishHistory(record).catch(() => undefined);
				await deps.save();
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.syncRoleContext', async (rawSnapshot?: RoleSyncSnapshot) => {
			if (!rawSnapshot || typeof rawSnapshot !== 'object' || !Array.isArray(rawSnapshot.agents)) {
				return;
			}
			const enriched = await enrichRoleSnapshot(rawSnapshot);
			await updateSnapshotIfChanged(enriched);
		}),
	);

	void Promise.resolve(vscode.commands.executeCommand<number>('aexus.ade.getWindowId'))
		.then(wid => {
			if (typeof wid === 'number' && Number.isInteger(wid) && wid > 0) {
				setHostWindowId(wid);
			}
		})
		.catch(() => undefined);

	void refreshRoleSnapshotFromWorkbench();

	return {
		refreshRoleSnapshotFromWorkbench,
		evictSyncedAgentPrefs,
	};
}
