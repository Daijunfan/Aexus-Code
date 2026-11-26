/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { LiveTurnChunk, LiveTurnRunner } from './liveTurnRunner';
import { discoverEngineModels, EngineId } from './capabilities';
import {
	buildRemotePersistentPrefix,
	clearCloudTransportCaches,
	CloudHostTarget,
	isCloudUri,
	probeRemoteEngines,
	resolveCloudHostTarget,
	terminateRemotePersistentSessionsByPrefix,
	toRemoteNativePath,
} from './cloudTransport';
import {
	definitions,
	ENGINE_ALIASES,
	parseAdeAgentResourceIds,
	parseOptionalUri,
	RecordEntry,
	resolveCompletedTurnUsage,
} from './extensionSessionHelpers';
import {
	emitThinkingProgress,
	EngineRuntime,
	EngineRuntimeCapabilities,
	EngineSendOptions,
	EngineThinkingLevel,
	getConfiguredEngineIdleStallTimeoutMs,
	getConfiguredEngineTurnTimeoutMs,
	isAutonomousModeEnabled,
} from './runtime';
import { SessionTurnCoordinator } from './turnCoordinator';

export type LiveBufferedChunk = LiveTurnChunk<vscode.ChatResponsePart>;

export interface LiveHeadlessTurnSnapshot {
	readonly requestId: string;
	readonly requestPrompt: string;
	readonly startedAt: number;
	readonly attach: (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => Promise<void>;
	readonly interrupt: () => Promise<void>;
}

function replayChunkToStream(stream: vscode.ChatResponseStream, chunk: LiveBufferedChunk): void {
	switch (chunk.kind) {
		case 'markdown':
			stream.markdown(chunk.text);
			break;
		case 'progress':
			stream.progress(chunk.text);
			break;
		case 'thinking':
			emitThinkingProgress(stream, chunk.text, chunk.id);
			break;
		case 'part':
			stream.push(chunk.part);
			break;
	}
}

export interface AdeTicketDispatchPayload {
	readonly deliveryId?: string;
	readonly projectId: string;
	readonly agentId: string;
	readonly agentName?: string;
	readonly sessionResource: string;
	readonly workspaceCwdUri: string;
	readonly engine: string;
	readonly model?: string;
	readonly effort?: EngineThinkingLevel;
	readonly ticketId: string;
	readonly taskId: string;
	readonly deliveryMode: 'queue' | 'steer';
	readonly payloadText: string;
	readonly agentToken?: string;
	readonly controlSocketPath?: string;
	readonly remoteControlEndpoint?: string;
	readonly remoteBridgeFile?: string;
	readonly timeoutMs?: number;
}

export interface EngineeringBridgeDeps {
	readonly context: vscode.ExtensionContext;
	readonly records: Map<string, RecordEntry>;
	readonly controllers: ReadonlyMap<string, vscode.ChatSessionItemController>;
	readonly turnCoordinator: SessionTurnCoordinator<vscode.CancellationTokenSource>;
	readonly lastTurnReplies: Map<string, string>;
	readonly lastTurnErrors: Map<string, string>;
	defaultCwd(): string;
	key(engine: string, id: string): string;
	identity(record: RecordEntry): string;
	item(record: RecordEntry): vscode.ChatSessionItem;
	syncRecordStorageKey(record: RecordEntry, prevId: string): void;
	findCachedRecord(uri: vscode.Uri): RecordEntry | undefined;
	ensureEmployeeRecord(params: {
		readonly sessionUri: vscode.Uri;
		readonly engineShort: string;
		readonly workspaceCwdUri?: string;
		readonly label?: string;
		readonly projectId: string;
		readonly agentId: string;
		readonly model?: string;
		readonly effort?: string;
	}): Promise<RecordEntry>;
	runtimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget }>;
	tryRuntimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget } | undefined>;
	getCachedRuntimeCaps(shortEng: string, cwd: string, authority?: string): EngineRuntimeCapabilities;
	fetchRuntimeCaps(
		shortEng: string,
		cwd: string,
		record?: RecordEntry,
		explicitRemoteTarget?: CloudHostTarget,
	): Promise<{ readonly caps: EngineRuntimeCapabilities; readonly changed: boolean }>;
	notifyMissingEngineForTicket?(info: {
		readonly engineShort: string;
		readonly record: RecordEntry;
		readonly agentName: string;
		readonly ticketId?: string;
	}): void;
	notifyCloudProjectMutated(cloudProjectUri: string | undefined): void;
	publishHistory(record: RecordEntry): Promise<void>;
	save(): Promise<void>;
}

const MAX_COMPLETED_TASK_IDS = 2048;

/**
 * Pure zero-prompt Ticket delivery & `LiveTurnRunner` streaming bridge (`plan.md` §7.2 & §7.3):
 * - Delivers `payloadText` 100% verbatim without any role charter, preamble, or dynamic tail.
 * - Path A (open chat window): delegates to `aexus.ade.trySendOpenChatRequest` (`IChatService.sendRequest`
 *   with `isSystemInitiated: false`) for native 60fps streaming.
 * - Path B (background headless turn): buffers live stream chunks in `LiveTurnRunner` so opening the
 *   employee's chat mid-turn attaches immediately via `provideChatSessionContent.activeResponseCallback`
 *   with zero flicker and zero dropped characters.
 */
export function registerEngineeringDispatchBridge(deps: EngineeringBridgeDeps): {
	readonly getActiveLiveTurn: (recordKey: string) => LiveHeadlessTurnSnapshot | undefined;
} {
	const {
		context,
		records,
		controllers,
		turnCoordinator,
		lastTurnReplies,
		lastTurnErrors,
	} = deps;

	const activeLiveTurns = new Map<string, LiveTurnRunner<vscode.ChatResponsePart>>();
	const pendingSteerPreemptions = new Map<string, {
		readonly deliveryMode: 'steer';
		readonly nextModel?: string;
	}>();
	const completedTaskOrder: string[] = [];
	const completedTaskSet = new Set<string>();

	const markTaskCompleted = (dedupKey: string | undefined): void => {
		if (!dedupKey || completedTaskSet.has(dedupKey)) {
			return;
		}
		completedTaskSet.add(dedupKey);
		completedTaskOrder.push(dedupKey);
		if (completedTaskOrder.length > MAX_COMPLETED_TASK_IDS) {
			const oldest = completedTaskOrder.shift();
			if (oldest) {
				completedTaskSet.delete(oldest);
			}
		}
	};

	const getActiveLiveTurn = (recordKey: string): LiveHeadlessTurnSnapshot | undefined => {
		const live = activeLiveTurns.get(recordKey);
		if (!live || live.settled) {
			return undefined;
		}
		return {
			requestId: live.requestId,
			requestPrompt: live.requestPrompt,
			startedAt: live.startedAt,
			attach: (stream: vscode.ChatResponseStream, token: vscode.CancellationToken) =>
				live.attach(chunk => replayChunkToStream(stream, chunk), token),
			interrupt: () => live.interrupt(),
		};
	};

	const dispatchTicketTurn = async (payload: AdeTicketDispatchPayload) => {
		const dedupKey = payload.ticketId && payload.taskId
			? `${payload.projectId}:${payload.ticketId}:${payload.taskId}`
			: undefined;
		if (dedupKey && completedTaskSet.has(dedupKey)) {
			return { ok: true, deduplicated: true };
		}

		const sessionUri = vscode.Uri.parse(payload.sessionResource);
		const rawEng = payload.engine.trim().toLowerCase();
		const engineShort = ENGINE_ALIASES[rawEng] ?? (rawEng.startsWith('aexus-') ? rawEng.slice('aexus-'.length) : rawEng);
		const record = await deps.ensureEmployeeRecord({
			sessionUri,
			engineShort,
			workspaceCwdUri: payload.workspaceCwdUri,
			label: payload.agentName,
			projectId: payload.projectId,
			agentId: payload.agentId,
			model: payload.model,
			effort: payload.effort,
		});
		const recordKey = deps.identity(record);

		// Unified CLI binary pre-probe (local `tryRuntimeForRecord` / remote SSH CLI probe)
		// BEFORE entering either Path A (`trySendOpenChatRequest`) or Path B (`LiveTurnRunner`).
		// Prevents Path A open-chat `send()` from returning `{}` on missing CLI and falsely triggering `ackDeliveryDispatched`.
		const preResolved = await deps.tryRuntimeForRecord(record);
		if (!preResolved) {
			deps.notifyMissingEngineForTicket?.({
				engineShort,
				record,
				agentName: payload.agentName || record.label || payload.agentId,
				ticketId: payload.ticketId,
			});
			return {
				ok: false,
				cliMissing: true,
				error: `Engine CLI "${engineShort}" is not installed on target host.`,
			};
		}

		// Path A: If the employee's chat session is currently open in the workbench UI, route through
		// `aexus.ade.trySendOpenChatRequest`, which enforces `human_ui > ticket_steer > ticket_queue`
		// per-employee scheduling and resolves ONLY once the turn finishes (or is preempted/aborted).
		try {
			const handledByOpenChat = await Promise.resolve(
				vscode.commands.executeCommand<{
					readonly accepted: boolean;
					readonly ok?: boolean;
					readonly stopped?: boolean;
					readonly steeredInStream?: boolean;
					readonly abortedByWindowDispose?: boolean;
					readonly error?: string;
				} | boolean>(
					'aexus.ade.trySendOpenChatRequest',
					{
						deliveryId: payload.deliveryId,
						sessionResource: sessionUri.toString(),
						payloadText: payload.payloadText,
						deliveryMode: payload.deliveryMode,
						projectId: payload.projectId,
						agentId: payload.agentId,
						engine: engineShort,
						model: payload.model,
						effort: payload.effort,
						ticketId: payload.ticketId,
						taskId: payload.taskId,
					},
				),
			);
			if (typeof handledByOpenChat === 'boolean') {
				if (handledByOpenChat) {
					record.provisional = false;
					record.nativeId ??= record.id;
					markTaskCompleted(dedupKey);
					return { ok: true, routedViaOpenChat: true, nativeSessionId: record.id };
				}
			} else if (handledByOpenChat?.accepted) {
				if (handledByOpenChat.abortedByWindowDispose) {
					return {
						ok: false,
						abortedByWindowDispose: true,
						routedViaOpenChat: true,
						nativeSessionId: record.id,
					};
				}
				if (handledByOpenChat.ok === false && !handledByOpenChat.stopped) {
					return {
						ok: false,
						error: handledByOpenChat.error || 'Open chat Ticket turn failed.',
						routedViaOpenChat: true,
						nativeSessionId: record.id,
					};
				}
				if (!handledByOpenChat.stopped) {
					record.provisional = false;
					record.nativeId ??= record.id;
					markTaskCompleted(dedupKey);
					if (handledByOpenChat.steeredInStream) {
						await deps.save();
					}
				}
				return {
					ok: handledByOpenChat.ok !== false,
					stopped: Boolean(handledByOpenChat.stopped),
					...(handledByOpenChat.steeredInStream ? { steeredInStream: true } : {}),
					routedViaOpenChat: true,
					nativeSessionId: record.id,
				};
			}
		} catch {
			// Fall through to headless `LiveTurnRunner` Path B when workbench command is absent or chat is closed.
		}

		const incomingSteerModel = payload.model === 'default'
			? 'default'
			: (payload.model
				? payload.model
				: (record.sessionConfig?.model && record.sessionConfig.model !== 'default' ? record.sessionConfig.model : undefined));

		const interruptRecord = async () => {
			const resolved = await deps.tryRuntimeForRecord(record).catch(() => undefined);
			const steerable = resolved?.engine as (EngineRuntime & {
				prepareSteerPreemption?: (session: RecordEntry, nextModel?: string) => Promise<boolean>;
			}) | undefined;
			const incomingSteer = pendingSteerPreemptions.get(recordKey);
			if (incomingSteer?.deliveryMode === 'steer' && typeof steerable?.prepareSteerPreemption === 'function') {
				const handled = await steerable.prepareSteerPreemption(record, incomingSteer.nextModel).catch(() => false);
				if (handled) {
					return;
				}
			}
			if (resolved?.engine.interruptTurn) {
				await resolved.engine.interruptTurn(record).catch(() => undefined);
			}
		};
		const forceKillRecord = async () => {
			const resolved = await deps.tryRuntimeForRecord(record).catch(() => undefined);
			if (resolved?.engine.killSession) {
				await resolved.engine.killSession(record).catch(() => undefined);
			}
		};

		const turnTimeoutMs = typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
			? payload.timeoutMs
			: getConfiguredEngineTurnTimeoutMs();

		const steerPreemptCtx = payload.deliveryMode === 'steer'
			? { deliveryMode: 'steer' as const, nextModel: incomingSteerModel }
			: undefined;
		if (steerPreemptCtx) {
			pendingSteerPreemptions.set(recordKey, steerPreemptCtx);
		}
		let lease: Awaited<ReturnType<typeof turnCoordinator.acquire>>;
		try {
			const existingLease = turnCoordinator.get(recordKey);
			if (steerPreemptCtx && existingLease && existingLease.source === 'headless' && !existingLease.isSettling) {
				const steerable = preResolved.engine as EngineRuntime & {
					prepareSteerPreemption?: (session: RecordEntry, nextModel?: string) => Promise<boolean>;
				};
				if (typeof steerable.prepareSteerPreemption === 'function') {
					const handled = await steerable.prepareSteerPreemption(record, steerPreemptCtx.nextModel).catch(() => false);
					if (handled) {
						await existingLease.done.catch(() => undefined);
					}
				}
			}

			lease = await turnCoordinator.acquire({
				key: recordKey,
				source: 'headless',
				createCts: () => new vscode.CancellationTokenSource(),
				interruptActive: interruptRecord,
				forceKill: forceKillRecord,
				graceTimeoutMs: 2500,
				turnTimeoutMs,
				idleStallTimeoutMs: getConfiguredEngineIdleStallTimeoutMs(),
				preemptActive: payload.deliveryMode === 'steer',
				ticketId: payload.ticketId,
				taskId: payload.taskId,
			});
		} finally {
			if (steerPreemptCtx && pendingSteerPreemptions.get(recordKey) === steerPreemptCtx) {
				pendingSteerPreemptions.delete(recordKey);
			}
		}
		if (!lease) {
			return { ok: false, stopped: true, nativeSessionId: record.id };
		}

		const turnCancellation = lease.cts;
		const liveTurn = new LiveTurnRunner<vscode.ChatResponsePart>(
			payload.payloadText,
			Date.now(),
			async () => {
				turnCancellation.cancel();
				await interruptRecord();
			},
		);
		activeLiveTurns.set(recordKey, liveTurn);
		let streamedMarkdown = '';

		const pushLiveChunk = (chunk: LiveBufferedChunk) => {
			liveTurn.push(chunk);
		};

		try {
			controllers.get(record.engine)?.items.add(deps.item(record));
			const resolvedEng = await deps.runtimeForRecord(record);
			const engine = resolvedEng.engine;

			const streamTarget: vscode.ChatResponseStream = Object.create(null);
			const headlessStream = new Proxy(streamTarget, {
				get(_dummy, prop) {
					if (prop === 'markdown') {
						return (value: string | vscode.MarkdownString) => {
							const textChunk = typeof value === 'string' ? value : value.value;
							if (textChunk) {
								streamedMarkdown += textChunk;
								lease.touchActivity();
								pushLiveChunk({ kind: 'markdown', text: textChunk });
							}
						};
					}
					if (prop === 'progress') {
						return (value?: string) => {
							lease.touchActivity();
							if (typeof value === 'string' && value) {
								pushLiveChunk({ kind: 'progress', text: value });
							}
						};
					}
					if (prop === 'thinkingProgress') {
						return (delta?: { text?: string; id?: string }) => {
							lease.touchActivity();
							if (delta?.text) {
								pushLiveChunk({ kind: 'thinking', text: delta.text, id: delta.id || 'thinking' });
							}
						};
					}
					if (prop === 'push') {
						return (part: vscode.ChatResponsePart) => {
							lease.touchActivity();
							pushLiveChunk({ kind: 'part', part });
						};
					}
					return () => { };
				},
			});

			const cfg = record.sessionConfig ?? {};
			const sendOptions: EngineSendOptions = {
				model: payload.model && payload.model !== 'default'
					? payload.model
					: (cfg.model && cfg.model !== 'default' ? cfg.model : undefined),
				thinking: payload.effort && payload.effort !== 'default'
					? (payload.effort === 'none' ? 'off' : payload.effort)
					: (cfg.thinking && cfg.thinking !== 'default' ? cfg.thinking : undefined),
				mode: cfg.mode && cfg.mode !== 'default' ? cfg.mode : undefined,
				permissionMode: cfg.permissionMode && cfg.permissionMode !== 'default' ? cfg.permissionMode : undefined,
				sandboxMode: cfg.sandboxMode && cfg.sandboxMode !== 'default' ? cfg.sandboxMode : undefined,
				webSearch: cfg.webSearch,
				pureWorker: false,
				adeProjectId: payload.projectId,
				adeAgentId: payload.agentId,
				adeSessionResource: sessionUri.toString(),
				adeAgentToken: payload.agentToken,
				adeControlSocketPath: payload.controlSocketPath,
				adeRemoteControlEndpoint: payload.remoteControlEndpoint,
				adeRemoteBridgeFile: payload.remoteBridgeFile,
				automatedEngineering: isAutonomousModeEnabled(),
				abortSignal: lease.abortSignal,
				timeoutMs: turnTimeoutMs,
				onStreamActivity: () => lease.touchActivity(),
				onExternalWaitStart: () => lease.beginExternalWait(),
				onExternalWaitEnd: () => lease.endExternalWait(),
			};

			record.preparingOrSending = true;
			const wasUnstartedBeforeTurn = Boolean(record.provisional || record.unmaterialized);
			if (wasUnstartedBeforeTurn) {
				void Promise.resolve(
					vscode.commands.executeCommand(
						'aexus.ade.markAgentSessionStarting',
						payload.projectId,
						payload.agentId,
						sessionUri.toString(),
					),
				).catch(() => undefined);
			} else {
				record.nativeId = record.id;
				void Promise.resolve(
					vscode.commands.executeCommand(
						'aexus.ade.markAgentSessionStarted',
						payload.projectId,
						payload.agentId,
						record.id,
					),
				).catch(() => undefined);
			}

			const prevId = record.id;
			if (engine.prepareSession) {
				await engine.prepareSession(record, sendOptions, turnCancellation.token);
				deps.syncRecordStorageKey(record, prevId);
				await deps.save();
			}
			if (turnCancellation.token.isCancellationRequested) {
				liveTurn.complete();
				return { ok: false, stopped: true, nativeSessionId: record.id };
			}

			if (wasUnstartedBeforeTurn && !record.unmaterialized && (!record.provisional || record.id !== prevId)) {
				record.nativeId = record.id;
				void Promise.resolve(
					vscode.commands.executeCommand(
						'aexus.ade.markAgentSessionStarted',
						payload.projectId,
						payload.agentId,
						record.id,
					),
				).catch(() => undefined);
			}

			lastTurnErrors.delete(recordKey);
			const turnStartedAt = Date.now();
			const preSendId = record.id;
			// Strictly zero prompt modification: `payload.payloadText` is passed byte-for-byte intact!
			await engine.send(record, payload.payloadText, headlessStream, turnCancellation.token, sendOptions);
			deps.syncRecordStorageKey(record, preSendId);
			record.provisional = false;
			record.unmaterialized = false;
			record.nativeId = record.id;
			void Promise.resolve(
				vscode.commands.executeCommand(
					'aexus.ade.markAgentSessionStarted',
					payload.projectId,
					payload.agentId,
					record.id,
				),
			).catch(() => undefined);

			if (streamedMarkdown.trim()) {
				lastTurnReplies.set(deps.identity(record), streamedMarkdown.trim());
			}
			record.updated = Date.now();
			const usage = resolveCompletedTurnUsage(engine, record.id, payload.payloadText, streamedMarkdown, turnStartedAt);
			if (!turnCancellation.token.isCancellationRequested) {
				markTaskCompleted(dedupKey);
			}
			liveTurn.complete();
			return {
				ok: true,
				reply: streamedMarkdown.trim(),
				nativeSessionId: record.id,
				stopped: turnCancellation.token.isCancellationRequested,
				usage,
			};
		} catch (error) {
			if (turnCancellation.token.isCancellationRequested || error instanceof vscode.CancellationError) {
				liveTurn.complete();
				return { ok: false, stopped: true, nativeSessionId: record.id };
			}
			const errObj = error instanceof Error ? error : new Error(String(error));
			lastTurnErrors.set(deps.identity(record), errObj.message);
			liveTurn.fail(errObj);
			throw error;
		} finally {
			record.preparingOrSending = false;
			if (activeLiveTurns.get(recordKey) === liveTurn) {
				activeLiveTurns.delete(recordKey);
			}
			liveTurn.complete();
			lease.markSettling();
			turnCancellation.dispose();
			turnCoordinator.release(lease);
			if (records.has(deps.key(record.engine, record.id)) || [...records.values()].includes(record)) {
				controllers.get(record.engine)?.items.add(deps.item(record));
			}
			deps.notifyCloudProjectMutated(record.cloudProjectUri);
			await deps.publishHistory(record).catch(() => undefined);
			await deps.save();
		}
	};

	context.subscriptions.push(
		{
			dispose: () => {
				activeLiveTurns.clear();
				pendingSteerPreemptions.clear();
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
			const aliasKeysByType: Record<EngineId, string[]> = {
				'aexus-claude': ['claude', 'claude-code', 'aexus-claude'],
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
					let caps = deps.getCachedRuntimeCaps(def.id, cwd, remoteTarget?.authority);
					if (!caps.models || caps.models.length === 0) {
						const fetched = await deps.fetchRuntimeCaps(def.id, cwd, undefined, remoteTarget);
						caps = fetched.caps;
					}
					const items = (await discoverEngineModels(def.type, cwd, caps.models, caps.defaultModel, [], remoteTarget))
						.filter(m => m.id !== 'default')
						.map(m => ({ id: m.id, label: m.name !== m.id ? `${m.name} (${m.id})` : m.id }));
					if (items.length > 0) {
						for (const aliasKey of aliasKeysByType[def.type]) {
							out[aliasKey] = items;
						}
					}
				} catch { /* Non-fatal single-engine model discovery failure */ }
			}));
			return out;
		}),
		vscode.commands.registerCommand('aexus.agentEngines.dispatchTicketTurn', dispatchTicketTurn),
		vscode.commands.registerCommand('aexus.agentEngines.cancelTicketTurns', async (params?: {
			readonly sessionResource?: string;
			readonly projectId?: string;
			readonly agentId?: string;
			readonly ticketIds?: readonly string[];
		}) => {
			if (!params) {
				return { cancelled: 0 };
			}
			let targetRecord: RecordEntry | undefined;
			if (params.sessionResource) {
				try {
					targetRecord = deps.findCachedRecord(vscode.Uri.parse(params.sessionResource));
				} catch { /* ignore */ }
			}
			if (!targetRecord && params.projectId && params.agentId) {
				targetRecord = [...records.values()].find(r => {
					if (r.adeProjectId === params.projectId && r.adeAgentId === params.agentId) {
						return true;
					}
					const parsed = parseAdeAgentResourceIds(r.resourceId);
					return parsed?.projectId === params.projectId && parsed?.agentId === params.agentId;
				});
			}
			if (!targetRecord) {
				return { cancelled: 0 };
			}
			const cancelled = await turnCoordinator.cancelTicketTurns(deps.identity(targetRecord), params.ticketIds);
			return { cancelled };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.disposeAgentRuntime', async (params?: {
			readonly sessionResource?: string;
			readonly projectId?: string;
			readonly agentId?: string;
			readonly hostAlias?: string;
			readonly preserveRecordForReset?: boolean;
		}) => {
			if (!params) {
				return { disposed: false };
			}
			let targetRecord: RecordEntry | undefined;
			if (params.sessionResource) {
				try {
					targetRecord = deps.findCachedRecord(vscode.Uri.parse(params.sessionResource));
				} catch { /* ignore */ }
			}
			if (!targetRecord && params.projectId && params.agentId) {
				targetRecord = [...records.values()].find(r => {
					if (r.adeProjectId === params.projectId && r.adeAgentId === params.agentId) {
						return true;
					}
					const parsed = parseAdeAgentResourceIds(r.resourceId);
					return parsed?.projectId === params.projectId && parsed?.agentId === params.agentId;
				});
			}
			if (!targetRecord) {
				if (params.hostAlias && params.sessionResource) {
					try {
						const parsedUri = vscode.Uri.parse(params.sessionResource);
						const eng = parsedUri.scheme.startsWith('aexus-') ? parsedUri.scheme.slice('aexus-'.length) : '';
						const sid = parsedUri.path.replace(/^\/+/, '');
						const target = await resolveCloudHostTarget(params.hostAlias).catch(() => undefined);
						if (target && target.os !== 'windows' && eng && sid) {
							await terminateRemotePersistentSessionsByPrefix(
								target,
								buildRemotePersistentPrefix(eng, sid),
								{ killTree: true },
							).catch(() => undefined);
						}
					} catch { /* ignore */ }
				}
				return { disposed: true };
			}

			const recKey = deps.identity(targetRecord);
			const plainKey = deps.key(targetRecord.engine, targetRecord.id);
			await turnCoordinator.forceRelease(recKey);
			const resolved = await deps.tryRuntimeForRecord(targetRecord).catch(() => undefined);
			if (resolved) {
				await resolved.engine.killSession?.(targetRecord).catch(() => undefined);
				if (resolved.engine.remoteTarget && resolved.engine.remoteTarget.os !== 'windows' && targetRecord.resourceId && targetRecord.resourceId !== targetRecord.id) {
					await terminateRemotePersistentSessionsByPrefix(
						resolved.engine.remoteTarget,
						buildRemotePersistentPrefix(targetRecord.engine, targetRecord.resourceId),
						{ killTree: true },
					).catch(() => undefined);
				}
			} else if (params.hostAlias?.trim()) {
				const target = await resolveCloudHostTarget(params.hostAlias.trim()).catch(() => undefined);
				if (target && target.os !== 'windows') {
					await terminateRemotePersistentSessionsByPrefix(
						target,
						buildRemotePersistentPrefix(targetRecord.engine, targetRecord.id),
						{ killTree: true },
					).catch(() => undefined);
				}
			}
			lastTurnReplies.delete(recKey);
			lastTurnErrors.delete(recKey);
			lastTurnReplies.delete(plainKey);
			lastTurnErrors.delete(plainKey);
			if (params.preserveRecordForReset) {
				const prevId = targetRecord.id;
				targetRecord.id = randomUUID();
				targetRecord.nativeId = undefined;
				targetRecord.file = undefined;
				targetRecord.provisional = true;
				targetRecord.unmaterialized = true;
				targetRecord.initialTitle = undefined;
				targetRecord.updated = Date.now();
				deps.syncRecordStorageKey(targetRecord, prevId);
				controllers.get(targetRecord.engine)?.items.add(deps.item(targetRecord));
				await deps.save();
				return { disposed: true, resetInPlace: true };
			}
			for (const [k, v] of [...records.entries()]) {
				if (v === targetRecord) {
					records.delete(k);
				}
			}
			const resourceUri = vscode.Uri.from({ scheme: `aexus-${targetRecord.engine}`, path: `/${targetRecord.resourceId ?? targetRecord.id}` });
			controllers.get(targetRecord.engine)?.items.delete(resourceUri);
			await deps.save();
			return { disposed: true };
		}),
	);

	return {
		getActiveLiveTurn,
	};
}
