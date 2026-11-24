/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type { IAdeDocsPaths } from './adeDocsCatalog.js';
import {
	IAdeApiDocReadResult,
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
	IAdeEngineeringBackendService,
	IAdeHeadlessControlResult,
	IAdeInboxItem,
	IAdeInboxMutation,
	IAdeMissionCheckpointMeta,
	IAdeMissionColdChangeEvent,
	IAdeMissionWatchdogSnapshot,
	IAdeOrchestrationDaemonMissionSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from './adeEngineering.js';
import type { IAdeOrganizationConfig } from './adeRoleSchema.js';

const MAX_PENDING_BUFFERED_EVENTS = 200;

interface IWindowScopedRouter<E extends { readonly ownerWindowCtx?: string }> {
	readonly subscribers: Map<string, Emitter<E>>;
	readonly pending: Map<string, E>;
	readonly dedupeKey: (ev: E) => string;
}

export class AdeEngineeringBackendChannel implements IServerChannel {
	private readonly wakeupRouter: IWindowScopedRouter<IAdeWatchdogWakeupEvent>;
	private readonly triggerRouter: IWindowScopedRouter<IAdeSourceTriggerFireEvent>;
	private readonly sourceDisposables: IDisposable[] = [];

	constructor(private readonly service: IAdeEngineeringBackendService) {
		this.wakeupRouter = {
			subscribers: new Map(),
			pending: new Map(),
			dedupeKey: ev => `${ev.missionId}:${ev.barrierId ?? ev.tokenId}:${ev.reason}`,
		};
		this.triggerRouter = {
			subscribers: new Map(),
			pending: new Map(),
			dedupeKey: ev => `${ev.missionId}:${ev.triggerId}`,
		};
		// Always subscribe to main-process Watchdog events in the channel constructor so events firing
		// while 0 renderer windows are open (e.g. window reload or macOS background daemon mode) are
		// buffered and flushed immediately to the first window that reconnects!
		if (this.service.onDidWatchdogWakeup) {
			this.sourceDisposables.push(this.service.onDidWatchdogWakeup(ev => this.dispatchWindowScoped(this.wakeupRouter, ev)));
		}
		if (this.service.onDidSourceTriggerFire) {
			this.sourceDisposables.push(this.service.onDidSourceTriggerFire(ev => this.dispatchWindowScoped(this.triggerRouter, ev)));
		}
	}

	dispose(): void {
		for (const d of this.sourceDisposables) {
			d.dispose();
		}
		this.sourceDisposables.length = 0;
	}

	private normalizeCtx(ctx: unknown): string | undefined {
		return typeof ctx === 'string' && ctx.trim().length > 0 ? ctx.trim() : undefined;
	}

	private dispatchWindowScoped<E extends { readonly ownerWindowCtx?: string }>(
		router: IWindowScopedRouter<E>,
		ev: E,
	): void {
		if (router.subscribers.size === 0) {
			if (
				router === (this.wakeupRouter as unknown as IWindowScopedRouter<E>)
				&& this.service.willHandleWatchdogWakeupHeadlessly?.(ev as unknown as IAdeWatchdogWakeupEvent)
			) {
				return;
			}
			const key = router.dedupeKey(ev);
			if (router.pending.has(key)) {
				router.pending.delete(key);
			} else if (router.pending.size >= MAX_PENDING_BUFFERED_EVENTS) {
				const oldestKey = router.pending.keys().next().value;
				if (oldestKey !== undefined) {
					router.pending.delete(oldestKey);
				}
			}
			router.pending.set(key, ev);
			return;
		}
		const owner = ev.ownerWindowCtx?.trim();
		if (owner) {
			const exact = router.subscribers.get(owner);
			if (exact) {
				exact.fire(ev);
				return;
			}
		}
		// Owner window disconnected/closed or unowned event: deliver strictly to the first live window.
		const failoverEmitter = router.subscribers.values().next().value;
		failoverEmitter?.fire(ev);
	}

	private flushPendingFor<E extends { readonly ownerWindowCtx?: string }>(
		router: IWindowScopedRouter<E>,
	): void {
		if (router.pending.size === 0 || router.subscribers.size === 0) {
			return;
		}
		const queued = Array.from(router.pending.values());
		router.pending.clear();
		for (const ev of queued) {
			this.dispatchWindowScoped(router, ev);
		}
	}

	private createWindowScopedEvent<E extends { readonly ownerWindowCtx?: string }>(
		source: Event<E> | undefined,
		ctx: unknown,
		router: IWindowScopedRouter<E>,
		trackRendererCount = false,
	): Event<E> {
		if (!source) {
			return Event.None;
		}
		const ctxKey = this.normalizeCtx(ctx);
		if (!ctxKey) {
			return source;
		}
		const emitter = new Emitter<E>({
			onWillAddFirstListener: () => {
				router.subscribers.set(ctxKey, emitter);
				if (trackRendererCount) {
					this.service.registerLiveRendererContext?.(ctxKey);
					this.service.setActiveRendererWindowCount?.(router.subscribers.size);
				}
				if (router.pending.size > 0) {
					// Defer flush one microtask so the newly attached IPC listener is fully wired.
					queueMicrotask(() => this.flushPendingFor(router));
				}
			},
			onDidRemoveLastListener: () => {
				if (router.subscribers.get(ctxKey) === emitter) {
					router.subscribers.delete(ctxKey);
					if (trackRendererCount) {
						this.service.unregisterLiveRendererContext?.(ctxKey);
						this.service.setActiveRendererWindowCount?.(router.subscribers.size);
					}
				}
			},
		});
		return emitter.event;
	}

	listen<T>(ctx: unknown, event: string): Event<T> {
		switch (event) {
			case 'onDidWatchdogWakeup':
				return this.createWindowScopedEvent(this.service.onDidWatchdogWakeup, ctx, this.wakeupRouter, true) as Event<T>;
			case 'onDidSourceTriggerFire':
				return this.createWindowScopedEvent(this.service.onDidSourceTriggerFire, ctx, this.triggerRouter) as Event<T>;
			case 'onDidInboxChange':
				return (this.service.onDidInboxChange ?? Event.None) as Event<T>;
			case 'onDidMissionRecordChange':
				return (this.service.onDidMissionRecordChange ?? Event.None) as Event<T>;
			case 'onDidSystemResume':
				return (this.service.onDidSystemResume ?? Event.None) as Event<T>;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	call<T>(ctx: unknown, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'loadInbox':
				return this.service.loadInbox() as Promise<T>;
			case 'saveInbox':
				return this.service.saveInbox(arg as readonly IAdeInboxItem[]) as Promise<T>;
			case 'mutateInbox':
				return (this.service.mutateInbox
					? this.service.mutateInbox(arg as IAdeInboxMutation)
					: this.service.loadInbox()) as Promise<T>;
			case 'loadMissionRecord':
				return (this.service.loadMissionRecord
					? this.service.loadMissionRecord(String(arg ?? ''))
					: Promise.resolve(undefined)) as Promise<T>;
			case 'loadAllMissionRecords':
				return (this.service.loadAllMissionRecords
					? this.service.loadAllMissionRecords()
					: Promise.resolve({})) as Promise<T>;
			case 'saveMissionRecord': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; payloadJson?: string; updatedAt?: number; writerId?: string; expectedRevision?: number }
					: undefined;
				if (!this.service.saveMissionRecord || !params?.missionId || typeof params.payloadJson !== 'string') {
					return Promise.resolve() as Promise<T>;
				}
				return this.service.saveMissionRecord(params.missionId, params.payloadJson, params.updatedAt ?? Date.now(), params.writerId, params.expectedRevision) as Promise<T>;
			}
			case 'deleteMissionRecord': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; writerId?: string }
					: { missionId: String(arg ?? '') };
				if (!this.service.deleteMissionRecord || !params.missionId) {
					return Promise.resolve() as Promise<T>;
				}
				return this.service.deleteMissionRecord(params.missionId, params.writerId) as Promise<T>;
			}
			case 'saveMissionCheckpoint': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; checkpointId?: string; payloadJson?: string; meta?: IAdeMissionCheckpointMeta }
					: undefined;
				if (!this.service.saveMissionCheckpoint || !params?.missionId || !params.checkpointId || typeof params.payloadJson !== 'string' || !params.meta) {
					return Promise.resolve() as Promise<T>;
				}
				return this.service.saveMissionCheckpoint(params.missionId, params.checkpointId, params.payloadJson, params.meta) as Promise<T>;
			}
			case 'listMissionCheckpoints':
				return (this.service.listMissionCheckpoints
					? this.service.listMissionCheckpoints(String(arg ?? ''))
					: Promise.resolve([])) as Promise<T>;
			case 'loadMissionCheckpoint': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; checkpointId?: string }
					: undefined;
				if (!this.service.loadMissionCheckpoint || !params?.missionId || !params.checkpointId) {
					return Promise.resolve(undefined) as Promise<T>;
				}
				return this.service.loadMissionCheckpoint(params.missionId, params.checkpointId) as Promise<T>;
			}
			case 'deleteMissionCheckpoint': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; checkpointId?: string }
					: undefined;
				if (!this.service.deleteMissionCheckpoint || !params?.missionId || !params.checkpointId) {
					return Promise.resolve() as Promise<T>;
				}
				return this.service.deleteMissionCheckpoint(params.missionId, params.checkpointId) as Promise<T>;
			}
			case 'saveOrchestrationBlobs': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; blobs?: readonly { readonly ptr: string; readonly payloadJson: string }[] }
					: undefined;
				if (!this.service.saveOrchestrationBlobs || !params?.missionId || !Array.isArray(params.blobs)) {
					return Promise.resolve() as Promise<T>;
				}
				return this.service.saveOrchestrationBlobs(params.missionId, params.blobs) as Promise<T>;
			}
			case 'readOrchestrationBlob': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; ptr?: string }
					: undefined;
				if (!this.service.readOrchestrationBlob || !params?.missionId || !params.ptr) {
					return Promise.resolve(undefined) as Promise<T>;
				}
				return this.service.readOrchestrationBlob(params.missionId, params.ptr) as Promise<T>;
			}
			case 'appendOrchestrationArchive': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; lines?: readonly string[] }
					: undefined;
				if (!this.service.appendOrchestrationArchive || !params?.missionId || !Array.isArray(params.lines)) {
					return Promise.resolve() as Promise<T>;
				}
				return this.service.appendOrchestrationArchive(params.missionId, params.lines) as Promise<T>;
			}
			case 'readOrchestrationArchive': {
				const params = (arg && typeof arg === 'object')
					? arg as { missionId?: string; limit?: number; offset?: number }
					: undefined;
				if (!this.service.readOrchestrationArchive || !params?.missionId) {
					return Promise.resolve([]) as Promise<T>;
				}
				return this.service.readOrchestrationArchive(params.missionId, { limit: params.limit, offset: params.offset }) as Promise<T>;
			}
			case 'syncOrchestrationDaemonState': {
				if (!this.service.syncOrchestrationDaemonState || !arg || typeof arg !== 'object') {
					return Promise.resolve() as Promise<T>;
				}
				const rawSnap = arg as IAdeOrchestrationDaemonMissionSnapshot;
				const callerCtx = this.normalizeCtx(ctx);
				const stamped: IAdeOrchestrationDaemonMissionSnapshot = callerCtx && !rawSnap.ownerWindowCtx
					? { ...rawSnap, ownerWindowCtx: callerCtx }
					: rawSnap;
				return this.service.syncOrchestrationDaemonState(stamped) as Promise<T>;
			}
			case 'getOrchestrationDaemonState':
				return (this.service.getOrchestrationDaemonState
					? this.service.getOrchestrationDaemonState(typeof arg === 'string' && arg.trim() ? arg.trim() : undefined)
					: Promise.resolve({})) as Promise<T>;
			case 'executeHeadlessOrchestrationControl': {
				const params = (arg && typeof arg === 'object')
					? arg as { action?: string; params?: Readonly<Record<string, unknown>> }
					: undefined;
				if (!this.service.executeHeadlessOrchestrationControl || !params?.action) {
					return Promise.resolve({ handled: false } satisfies IAdeHeadlessControlResult) as Promise<T>;
				}
				return this.service.executeHeadlessOrchestrationControl(params.action, params.params ?? {}) as Promise<T>;
			}
			case 'syncApiDocs':
				return (this.service.syncApiDocs
					? this.service.syncApiDocs(arg as IAdeOrganizationConfig)
					: Promise.resolve(undefined)) as Promise<T>;
			case 'getApiDocsPaths':
				return (this.service.getApiDocsPaths
					? this.service.getApiDocsPaths(typeof arg === 'number' ? arg : 4)
					: Promise.resolve(undefined)) as Promise<T>;
			case 'readApiDoc': {
				const params = (arg && typeof arg === 'object')
					? arg as { target?: string; config?: IAdeOrganizationConfig }
					: { target: String(arg ?? '') };
				return (this.service.readApiDoc
					? this.service.readApiDoc(params.target ?? '', params.config)
					: Promise.resolve({ ok: false, target: params.target ?? '', revision: 0, error: 'readApiDoc unavailable' })) as Promise<T>;
			}
			case 'syncMissionWatchdog': {
				if (!this.service.syncMissionWatchdog) {
					return Promise.resolve() as Promise<T>;
				}
				const rawSnapshot = arg as IAdeMissionWatchdogSnapshot;
				const callerCtx = this.normalizeCtx(ctx);
				const stampedSnapshot: IAdeMissionWatchdogSnapshot = callerCtx && !rawSnapshot.ownerWindowCtx
					? { ...rawSnapshot, ownerWindowCtx: callerCtx }
					: rawSnapshot;
				return this.service.syncMissionWatchdog(stampedSnapshot) as Promise<T>;
			}
			case 'removeMissionWatchdog':
				return (this.service.removeMissionWatchdog
					? this.service.removeMissionWatchdog(String(arg ?? ''))
					: Promise.resolve()) as Promise<T>;
			case 'canRecoverMission': {
				const missionId = String(arg ?? '');
				const callerCtx = this.normalizeCtx(ctx);
				const ownerGetter = (this.service as IAdeEngineeringBackendService & { getMissionWatchdogOwner?(id: string): string | undefined }).getMissionWatchdogOwner;
				const ownerCtx = ownerGetter ? ownerGetter.call(this.service, missionId)?.trim() : undefined;
				if (ownerCtx && callerCtx && ownerCtx !== callerCtx && this.wakeupRouter.subscribers.has(ownerCtx)) {
					return Promise.resolve(false) as Promise<T>;
				}
				return Promise.resolve(true) as Promise<T>;
			}
			case 'notifySystemResume':
				return (this.service.notifySystemResume
					? this.service.notifySystemResume()
					: Promise.resolve()) as Promise<T>;
			case 'probeFileMtime': {
				const params = (arg && typeof arg === 'object')
					? arg as { hostAlias?: string; filePath?: string }
					: { hostAlias: 'local', filePath: '' };
				return (this.service.probeFileMtime
					? this.service.probeFileMtime(params.hostAlias ?? 'local', params.filePath ?? '')
					: Promise.resolve(null)) as Promise<T>;
			}
			case 'probeFileSignature': {
				const params = (arg && typeof arg === 'object')
					? arg as { hostAlias?: string; filePath?: string }
					: { hostAlias: 'local', filePath: '' };
				return (this.service.probeFileSignature
					? this.service.probeFileSignature(params.hostAlias ?? 'local', params.filePath ?? '')
					: Promise.resolve(null)) as Promise<T>;
			}
			case 'revokeSession': {
				const sessionId = typeof arg === 'string' ? arg.trim() : '';
				return (this.service.revokeSession && sessionId
					? this.service.revokeSession(sessionId)
					: Promise.resolve()) as Promise<T>;
			}
			case 'runDeterministicCheck': {
				const req = arg as IAdeDeterministicCheckRequest;
				if (!this.service.runDeterministicCheck) {
					return Promise.resolve({
						checkId: req?.checkId ?? 'unknown',
						name: req?.name,
						command: req?.command,
						hostAlias: req?.hostAlias || 'local',
						cwd: req?.cwd,
						passed: false,
						exitCode: -1,
						expectedExitCode: req?.expectExitCode ?? 0,
						durationMs: 0,
						outputTail: '',
						error: 'Deterministic check runner is unavailable in this backend.',
					} satisfies IAdeDeterministicCheckResponse) as Promise<T>;
				}
				return this.service.runDeterministicCheck(req) as Promise<T>;
			}
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}
}

export class AdeEngineeringBackendChannelClient implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	readonly onDidWatchdogWakeup: Event<IAdeWatchdogWakeupEvent>;
	readonly onDidSourceTriggerFire: Event<IAdeSourceTriggerFireEvent>;
	readonly onDidInboxChange: Event<readonly IAdeInboxItem[]>;
	readonly onDidMissionRecordChange: Event<IAdeMissionColdChangeEvent>;
	readonly onDidSystemResume: Event<number>;

	constructor(private readonly channel: IChannel) {
		this.onDidWatchdogWakeup = this.channel.listen<IAdeWatchdogWakeupEvent>('onDidWatchdogWakeup');
		this.onDidSourceTriggerFire = this.channel.listen<IAdeSourceTriggerFireEvent>('onDidSourceTriggerFire');
		this.onDidInboxChange = this.channel.listen<readonly IAdeInboxItem[]>('onDidInboxChange');
		this.onDidMissionRecordChange = this.channel.listen<IAdeMissionColdChangeEvent>('onDidMissionRecordChange');
		this.onDidSystemResume = this.channel.listen<number>('onDidSystemResume');
	}

	loadInbox(): Promise<IAdeInboxItem[]> {
		return this.channel.call('loadInbox');
	}

	saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		return this.channel.call('saveInbox', items);
	}

	mutateInbox(mutation: IAdeInboxMutation): Promise<IAdeInboxItem[]> {
		return this.channel.call('mutateInbox', mutation);
	}

	loadMissionRecord(missionId: string): Promise<string | undefined> {
		return this.channel.call('loadMissionRecord', missionId);
	}

	loadAllMissionRecords(): Promise<Readonly<Record<string, string>>> {
		return this.channel.call('loadAllMissionRecords');
	}

	saveMissionRecord(missionId: string, payloadJson: string, updatedAt: number, writerId?: string, expectedRevision?: number): Promise<void> {
		return this.channel.call('saveMissionRecord', { missionId, payloadJson, updatedAt, writerId, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
	}

	deleteMissionRecord(missionId: string, writerId?: string): Promise<void> {
		return this.channel.call('deleteMissionRecord', { missionId, writerId });
	}

	saveMissionCheckpoint(missionId: string, checkpointId: string, payloadJson: string, meta: IAdeMissionCheckpointMeta): Promise<void> {
		return this.channel.call('saveMissionCheckpoint', { missionId, checkpointId, payloadJson, meta });
	}

	listMissionCheckpoints(missionId: string): Promise<readonly IAdeMissionCheckpointMeta[]> {
		return this.channel.call('listMissionCheckpoints', missionId);
	}

	loadMissionCheckpoint(missionId: string, checkpointId: string): Promise<string | undefined> {
		return this.channel.call('loadMissionCheckpoint', { missionId, checkpointId });
	}

	deleteMissionCheckpoint(missionId: string, checkpointId: string): Promise<void> {
		return this.channel.call('deleteMissionCheckpoint', { missionId, checkpointId });
	}

	saveOrchestrationBlobs(missionId: string, blobs: readonly { readonly ptr: string; readonly payloadJson: string }[]): Promise<void> {
		return this.channel.call('saveOrchestrationBlobs', { missionId, blobs });
	}

	readOrchestrationBlob(missionId: string, ptr: string): Promise<string | undefined> {
		return this.channel.call('readOrchestrationBlob', { missionId, ptr });
	}

	appendOrchestrationArchive(missionId: string, lines: readonly string[]): Promise<void> {
		return this.channel.call('appendOrchestrationArchive', { missionId, lines });
	}

	readOrchestrationArchive(missionId: string, options?: { readonly limit?: number; readonly offset?: number }): Promise<readonly string[]> {
		return this.channel.call('readOrchestrationArchive', { missionId, ...options });
	}

	syncOrchestrationDaemonState(snapshot: IAdeOrchestrationDaemonMissionSnapshot): Promise<void> {
		return this.channel.call('syncOrchestrationDaemonState', snapshot);
	}

	getOrchestrationDaemonState(missionId?: string): Promise<Readonly<Record<string, IAdeOrchestrationDaemonMissionSnapshot>>> {
		return this.channel.call('getOrchestrationDaemonState', missionId);
	}

	executeHeadlessOrchestrationControl(action: string, params: Readonly<Record<string, unknown>>): Promise<IAdeHeadlessControlResult> {
		return this.channel.call('executeHeadlessOrchestrationControl', { action, params });
	}

	syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths> {
		return this.channel.call('syncApiDocs', config);
	}

	getApiDocsPaths(rankCount: number): Promise<IAdeDocsPaths> {
		return this.channel.call('getApiDocsPaths', rankCount);
	}

	readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult> {
		return this.channel.call('readApiDoc', { target, config });
	}

	syncMissionWatchdog(snapshot: IAdeMissionWatchdogSnapshot): Promise<void> {
		return this.channel.call('syncMissionWatchdog', snapshot);
	}

	removeMissionWatchdog(missionId: string): Promise<void> {
		return this.channel.call('removeMissionWatchdog', missionId);
	}

	canRecoverMission(missionId: string): Promise<boolean> {
		return this.channel.call('canRecoverMission', missionId);
	}

	notifySystemResume(): Promise<void> {
		return this.channel.call('notifySystemResume');
	}

	probeFileMtime(hostAlias: string, filePath: string): Promise<number | null> {
		return this.channel.call('probeFileMtime', { hostAlias, filePath });
	}

	probeFileSignature(hostAlias: string, filePath: string): Promise<string | null> {
		return this.channel.call('probeFileSignature', { hostAlias, filePath });
	}

	revokeSession(sessionId: string): Promise<void> {
		return this.channel.call('revokeSession', sessionId);
	}

	runDeterministicCheck(request: IAdeDeterministicCheckRequest): Promise<IAdeDeterministicCheckResponse> {
		return this.channel.call('runDeterministicCheck', request);
	}
}
