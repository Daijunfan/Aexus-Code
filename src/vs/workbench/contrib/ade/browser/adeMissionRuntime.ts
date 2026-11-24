/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { AEXUS_SSH_SCHEME, IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	buildAdeRemotePersistentPrefix,
	IAdeEngineeringBackendService,
	IAdeInboxService,
	IAdeMissionWatchdogSnapshot,
	IAdeWatchdogBarrierSpec,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	ADE_MISSION_CONCURRENCY_CONFIG_KEY,
	IMissionConcurrencyLimits,
	IMissionRuntimeState,
	IMissionToken,
	IMissionTurnUsageInput,
	IMissionTurnUsagePricingOptions,
	MissionEngineEffect,
	normalizeMissionConcurrencyLimits,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY,
	AdeModelPricingOverrides,
} from '../../../../platform/ade/common/adeModelPricing.js';
import {
	hasActiveOrchestrationTokens,
	IOrchestrationRuntimeState,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IAdeAgent, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { AdeMissionAgentDispatchController } from './adeMissionAgentDispatchController.js';
import { AdeMissionLegacyEngineController } from './adeMissionLegacyEngineController.js';
import { AdeMissionOrchestrationController } from './adeMissionOrchestrationController.js';
import {
	IAdeMissionRuntimeHost,
	IAdeMissionRuntimeService,
	IInMemoryCheckpointEntry,
	IMissionStatusView,
	IMissionTurnAttribution,
	IPendingAgentDispatch,
	IPendingAgentDispatchOptions,
} from './adeMissionRuntimeTypes.js';
import { IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export { IAdeMissionRuntimeService };
export type { IMissionStatusView };

const DEFAULT_ENGINEERING_TURN_TIMEOUT_MS = 10 * 60_000;

export class AdeMissionRuntimeService extends Disposable implements IAdeMissionRuntimeService, IAdeMissionRuntimeHost {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	readonly lastHeartbeatSyncAt = new Map<string, number>();
	readonly inMemoryAgentActivityAt = new Map<string, number>();
	readonly unclosedTurnNudgeCount = new Map<string, number>();
	readonly transientRetryCount = new Map<string, number>();
	transientRetryBackoffsMs: readonly number[] = [8_000, 20_000, 45_000];
	engineeringTurnTimeoutMs = DEFAULT_ENGINEERING_TURN_TIMEOUT_MS;
	readonly transientCircuitFailuresByKey = new Map<string, { count: number; lastFailureAt: number }>();
	readonly inFlightCheckTokens = new Set<string>();
	private readonly pendingTurnNudgeTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly pendingTimersByMission = new Map<string, Set<ReturnType<typeof setTimeout>>>();
	readonly blockedFileSignatureByTokenKey = new Map<string, string | null>();
	private readonly knownMissionIds = new Set<string>();
	readonly activeTurnsByAgent = new Map<string, number>();
	turnAttributionSeq = 0;
	readonly turnAttributionById = new Map<string, IMissionTurnAttribution>();
	readonly inFlightTurnByAgent = new Map<string, IMissionTurnAttribution>();
	readonly inFlightTurnBySession = new Map<string, IMissionTurnAttribution>();
	readonly lastTurnByAgent = new Map<string, IMissionTurnAttribution>();
	readonly lastTurnBySession = new Map<string, IMissionTurnAttribution>();
	readonly pendingDispatchesByAgent = new Map<string, IPendingAgentDispatch[]>();
	readonly compactionChains = new Map<string, Promise<void>>();
	readonly memoryCheckpointsByMission = new Map<string, IInMemoryCheckpointEntry[]>();

	private readonly legacyController: AdeMissionLegacyEngineController;
	private readonly dispatchController: AdeMissionAgentDispatchController;
	private readonly orchestrationController: AdeMissionOrchestrationController;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.legacyController = new AdeMissionLegacyEngineController(this);
		this.dispatchController = new AdeMissionAgentDispatchController(this);
		this.orchestrationController = new AdeMissionOrchestrationController(this);

		this._register({
			dispose: () => {
				for (const timer of this.pendingTurnNudgeTimers) {
					clearTimeout(timer);
				}
				this.pendingTurnNudgeTimers.clear();
				this.pendingTimersByMission.clear();
				this.blockedFileSignatureByTokenKey.clear();
				this.transientCircuitFailuresByKey.clear();
				this.memoryCheckpointsByMission.clear();
			},
		});
		this.bindBackendEvents();
		queueMicrotask(() => {
			if (this._store.isDisposed) {
				return;
			}
			const cfg = this.configurationService;
			if (cfg?.onDidChangeConfiguration) {
				this._register(cfg.onDidChangeConfiguration(e => {
					if (e.affectsConfiguration(ADE_MISSION_CONCURRENCY_CONFIG_KEY)) {
						void this.legacyController.applyConfiguredConcurrencyLimitsToRunningMissions();
					}
				}));
			}
			const projects = this.projectsService;
			if (projects?.onDidChange) {
				this._register(projects.onDidChange(() => {
					void this.legacyController.reconcileRunningMissionConcurrencyQueues();
				}));
			}
			const missions = this.missionService;
			if (missions) {
				for (const rec of missions.listMissions()) {
					this.knownMissionIds.add(rec.id);
				}
				if (missions.onDidChange) {
					this._register(missions.onDidChange(() => {
						const liveIds = new Set(missions.listMissions().map(r => r.id));
						for (const knownId of [...this.knownMissionIds]) {
							if (!liveIds.has(knownId)) {
								this.knownMissionIds.delete(knownId);
								this.teardownMission(knownId);
							}
						}
						for (const liveId of liveIds) {
							this.knownMissionIds.add(liveId);
						}
					}));
				}
			}
			if (missions?.onDidChangeExternal) {
				this._register(missions.onDidChangeExternal(() => {
					for (const rec of this.missionService?.listMissions() ?? []) {
						this._onDidChange.fire(rec.id);
					}
				}));
			}
			void (async () => {
				try {
					await missions?.whenHydrated?.();
				} catch {
					// Proceed with whatever state is currently loaded
				}
				if (this._store.isDisposed) {
					return;
				}
				let hasRunningMissions = false;
				for (const rec of missions?.listMissions() ?? []) {
					const hasPendingHeadless = Boolean(rec.orchestrationRuntime?.pendingHeadlessEffects && rec.orchestrationRuntime.pendingHeadlessEffects.length > 0);
					const hasLiveOrch = Boolean(rec.orchestrationRuntime && rec.orchestrationRuntime.status !== 'paused' && (hasActiveOrchestrationTokens(rec.orchestrationRuntime) || hasPendingHeadless));
					const hasPausedOrch = Boolean(rec.orchestrationRuntime && rec.orchestrationRuntime.status === 'paused' && hasActiveOrchestrationTokens(rec.orchestrationRuntime));
					if (rec.runtime?.status === 'running' || hasLiveOrch || hasPausedOrch) {
						hasRunningMissions = true;
						if (rec.runtime?.status === 'running' || hasLiveOrch) {
							this.syncWatchdog(rec.id, rec.runtime ?? this.ensureSynchronizedState(rec), { preserveExistingOwner: true });
						}
					}
				}
				if (hasRunningMissions) {
					const recoveryTimer = setTimeout(() => {
						this.pendingTurnNudgeTimers.delete(recoveryTimer);
						if (this._store.isDisposed) {
							return;
						}
						void this.recoverInterruptedActiveTokens().catch(() => undefined);
					}, 1500);
					this.pendingTurnNudgeTimers.add(recoveryTimer);
				}
			})();
		});
	}

	get isDisposed(): boolean {
		return this._store.isDisposed;
	}

	private tryGet<T>(id: ServiceIdentifier<T>): T | undefined {
		try {
			return this.instantiationService.invokeFunction(accessor => accessor.get(id));
		} catch {
			return undefined;
		}
	}

	get missionService(): IAdeMissionService | undefined {
		return this.tryGet(IAdeMissionService);
	}

	get projectsService(): IAdeProjectsService | undefined {
		return this.tryGet(IAdeProjectsService);
	}

	get sessionsService(): IAdeSessionsService | undefined {
		return this.tryGet(IAdeSessionsService);
	}

	get inboxService(): IAdeInboxService | undefined {
		return this.tryGet(IAdeInboxService);
	}

	get backendService(): IAdeEngineeringBackendService | undefined {
		return this.tryGet(IAdeEngineeringBackendService);
	}

	get roleSchemaService(): IAdeRoleSchemaService | undefined {
		return this.tryGet(IAdeRoleSchemaService);
	}

	get cloudHostService(): IAdeCloudHostBackendService | undefined {
		return this.tryGet(IAdeCloudHostBackendService);
	}

	get commandService(): ICommandService | undefined {
		return this.tryGet(ICommandService);
	}

	get configurationService(): IConfigurationService | undefined {
		return this.tryGet(IConfigurationService);
	}

	get orgConfig(): IAdeOrganizationConfig {
		return this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	}

	getModelPricingOverrides(): AdeModelPricingOverrides | undefined {
		const raw = this.configurationService?.getValue<unknown>(ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AdeModelPricingOverrides) : undefined;
	}

	getConfiguredConcurrencyLimits(): IMissionConcurrencyLimits | undefined {
		const raw = this.configurationService?.getValue<unknown>(ADE_MISSION_CONCURRENCY_CONFIG_KEY);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? normalizeMissionConcurrencyLimits(raw as IMissionConcurrencyLimits) : undefined;
	}

	private bindBackendEvents(): void {
		const backend = this.backendService;
		if (!backend) {
			return;
		}
		if (backend.onDidWatchdogWakeup) {
			this._register(backend.onDidWatchdogWakeup(ev => {
				void this.dispatchController.handleWatchdogWakeup(ev);
			}));
		}
		if (backend.onDidSourceTriggerFire) {
			this._register(backend.onDidSourceTriggerFire(ev => {
				void this.dispatchController.handleSourceTriggerFire(ev);
			}));
		}
		if (backend.onDidSystemResume) {
			this._register(backend.onDidSystemResume(() => {
				void this.commandService?.executeCommand('aexus.agentEngines.notifySystemResume').catch(() => undefined);
			}));
		}
	}

	requireMission(missionId: string): IAdeMissionRecord {
		const missions = this.missionService;
		if (!missions) {
			throw new Error('ADE Mission service is not available.');
		}
		const rec = missions.getMission(missionId) ?? missions.getMissionByLinkedSession(missionId);
		if (!rec) {
			throw new Error(`Mission not found: ${missionId}`);
		}
		return rec;
	}

	fireDidChange(missionId: string): void {
		this._onDidChange.fire(missionId);
	}

	scheduleTrackedTimer(missionId: string | undefined, fn: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const handle = setTimeout(() => {
			this.pendingTurnNudgeTimers.delete(handle);
			if (missionId) {
				const set = this.pendingTimersByMission.get(missionId);
				if (set) {
					set.delete(handle);
					if (set.size === 0) {
						this.pendingTimersByMission.delete(missionId);
					}
				}
			}
			if (this._store.isDisposed) {
				return;
			}
			fn();
		}, delayMs);
		this.pendingTurnNudgeTimers.add(handle);
		if (missionId) {
			let set = this.pendingTimersByMission.get(missionId);
			if (!set) {
				set = new Set();
				this.pendingTimersByMission.set(missionId, set);
			}
			set.add(handle);
		}
		return handle;
	}

	computeTransientRetryDelayMs(baseMs: number, circuitKey: string): number {
		const now = Date.now();
		const entry = this.transientCircuitFailuresByKey.get(circuitKey);
		let multiplier = 1;
		if (entry && now - entry.lastFailureAt < 120_000 && entry.count >= 3) {
			multiplier = Math.min(3, 1 + (entry.count - 2) * 0.5);
		}
		if (baseMs < 250) {
			return Math.max(1, Math.round(baseMs * multiplier));
		}
		const jitterFactor = 0.85 + Math.random() * 0.3;
		return Math.min(120_000, Math.round(baseMs * multiplier * jitterFactor));
	}

	teardownMission(missionId: string): void {
		const timers = this.pendingTimersByMission.get(missionId);
		if (timers) {
			for (const t of timers) {
				clearTimeout(t);
				this.pendingTurnNudgeTimers.delete(t);
			}
			this.pendingTimersByMission.delete(missionId);
		}
		const prefix = `${missionId}:`;
		for (const key of [...this.transientRetryCount.keys()]) {
			if (key.startsWith(prefix)) {
				this.transientRetryCount.delete(key);
			}
		}
		for (const key of [...this.unclosedTurnNudgeCount.keys()]) {
			if (key.startsWith(prefix)) {
				this.unclosedTurnNudgeCount.delete(key);
			}
		}
		for (const key of [...this.blockedFileSignatureByTokenKey.keys()]) {
			if (key.startsWith(prefix)) {
				this.blockedFileSignatureByTokenKey.delete(key);
			}
		}
		for (const key of [...this.inFlightCheckTokens]) {
			if (key.startsWith(prefix) || key.startsWith(`orch-check:${prefix}`)) {
				this.inFlightCheckTokens.delete(key);
			}
		}
		for (const [agentId, queue] of [...this.pendingDispatchesByAgent.entries()]) {
			const kept = queue.filter(item => item.options?.missionId !== missionId);
			if (kept.length === 0) {
				this.pendingDispatchesByAgent.delete(agentId);
			} else if (kept.length !== queue.length) {
				this.pendingDispatchesByAgent.set(agentId, kept);
			}
		}
		for (const [turnId, attr] of [...this.turnAttributionById.entries()]) {
			if (attr.missionId === missionId) {
				this.turnAttributionById.delete(turnId);
				if (this.inFlightTurnByAgent.get(attr.agentId)?.turnId === turnId) {
					this.inFlightTurnByAgent.delete(attr.agentId);
				}
				if (attr.sessionResource && this.inFlightTurnBySession.get(attr.sessionResource)?.turnId === turnId) {
					this.inFlightTurnBySession.delete(attr.sessionResource);
				}
			}
		}
		this.compactionChains.delete(missionId);
		this.memoryCheckpointsByMission.delete(missionId);
		void this.backendService?.removeMissionWatchdog?.(missionId).catch(() => undefined);
	}

	commitState(missionId: string, state: IMissionRuntimeState, options?: { readonly deferPersist?: boolean; readonly skipWatchdogSync?: boolean }): void {
		this.missionService?.updateRuntime(missionId, state, options?.deferPersist ? { deferPersist: true } : undefined);
		if (!options?.skipWatchdogSync) {
			this.syncWatchdog(missionId, state);
		}
		this._onDidChange.fire(missionId);
	}

	syncWatchdog(missionId: string, state: IMissionRuntimeState, options?: { readonly preserveExistingOwner?: boolean }): void {
		const backend = this.backendService;
		if (!backend?.syncMissionWatchdog) {
			return;
		}
		const rec = this.missionService?.getMission(missionId);
		const orch = rec?.orchestrationRuntime;
		const isOrchPaused = orch?.status === 'paused' || orch?.status === 'aborted' || Boolean(orch?.budgetCircuitTripped);
		const orchBarriers: IAdeWatchdogBarrierSpec[] = !isOrchPaused && orch?.joinBarriers
			? Object.values(orch.joinBarriers)
				.filter(b => b.status === 'waiting' && typeof b.deadlineAt === 'number' && Number.isFinite(b.deadlineAt))
				.map(b => ({
					barrierId: b.id,
					parentTokenId: b.parentTokenId,
					ownerNodeId: b.ownerNodeId,
					ownerAgentId: orch.nodeAgentIds?.[b.ownerNodeId],
					deadlineAt: b.deadlineAt!,
				}))
			: [];
		const hasOrchActive = Boolean(orch && !isOrchPaused && (hasActiveOrchestrationTokens(orch) || orchBarriers.length > 0));
		if (orch && backend.syncOrchestrationDaemonState) {
			const allOrchTokens = Object.values(orch.tokens);
			void backend.syncOrchestrationDaemonState({
				missionId,
				status: orch.status ?? 'running',
				activeTokenCount: allOrchTokens.filter(t => t.status === 'active').length,
				blockedTokenCount: allOrchTokens.filter(t => t.status === 'blocked').length,
				waitingJoinCount: allOrchTokens.filter(t => t.status === 'waiting_join').length,
				updatedAt: orch.updatedAt,
				...(orch.pausedReason ? { pausedReason: orch.pausedReason } : {}),
			}).catch(() => undefined);
		}
		const isLegacyRunning = state.status === 'running';
		if (!isLegacyRunning && !hasOrchActive) {
			void backend.removeMissionWatchdog?.(missionId).catch(() => undefined);
			return;
		}
		const mapTokenForWatchdog = (t: {
			readonly id: string;
			readonly nodeId: string;
			readonly holderAgentId?: string;
			readonly status: string;
			readonly lastActivityAt: number;
			readonly lastNudgeAt?: number;
			readonly blocked?: IMissionToken['blocked'];
		}) => {
			const memActivity = t.holderAgentId ? (this.inMemoryAgentActivityAt.get(t.holderAgentId) ?? 0) : 0;
			const holderAgent = t.holderAgentId ? this.projectsService?.getAgent(t.holderAgentId) : undefined;
			const hostAlias = holderAgent?.projectUri?.scheme === AEXUS_SSH_SCHEME && holderAgent.projectUri.authority
				? holderAgent.projectUri.authority
				: undefined;
			const sessionId = holderAgent?.session?.resource?.path?.replace(/^\/+/, '');
			const remoteSessionPrefix = hostAlias && holderAgent?.session?.engineId && sessionId
				? buildAdeRemotePersistentPrefix(holderAgent.session.engineId, sessionId)
				: undefined;
			const sigKey = `${missionId}:${t.id}`;
			const initialFileSignature = t.status === 'blocked'
				? this.blockedFileSignatureByTokenKey.get(sigKey)
				: undefined;
			if (t.status !== 'blocked') {
				this.blockedFileSignatureByTokenKey.delete(sigKey);
			}
			return {
				tokenId: t.id,
				nodeId: t.nodeId,
				holderAgentId: t.holderAgentId,
				status: (t.status === 'blocked' ? 'blocked' : 'active') as 'active' | 'blocked',
				lastActivityAt: Math.max(t.lastActivityAt, memActivity),
				lastNudgeAt: t.lastNudgeAt,
				...(hostAlias ? { hostAlias } : {}),
				...(remoteSessionPrefix ? { remoteSessionPrefix } : {}),
				...(t.blocked
					? {
						blocked: initialFileSignature !== undefined
							? { ...t.blocked, initialFileSignature }
							: t.blocked,
					}
					: {}),
			};
		};
		const legacyTokens = isLegacyRunning
			? Object.values(state.tokens).filter(t => t.status === 'active' || t.status === 'blocked').map(mapTokenForWatchdog)
			: [];
		const orchTokens = hasOrchActive && orch
			? Object.values(orch.tokens).filter(t => t.status === 'active' || t.status === 'blocked').map(mapTokenForWatchdog)
			: [];
		const silenceTimeoutMinutes = isLegacyRunning
			? state.silenceTimeoutMinutes
			: (orch?.silenceReminderMinutes || ORCHESTRATION_SILENCE_REMINDER_MINUTES);
		const snapshot: IAdeMissionWatchdogSnapshot = {
			missionId,
			status: 'running',
			silenceTimeoutMinutes,
			tokens: [...legacyTokens, ...orchTokens],
			triggers: isLegacyRunning ? state.triggers : [],
			...(orchBarriers.length > 0 ? { barriers: orchBarriers } : {}),
			...(options?.preserveExistingOwner ? { preserveExistingOwner: true } : {}),
		};
		void backend.syncMissionWatchdog(snapshot).catch(() => undefined);
	}

	// ---- Cross-controller host bridges ----

	ensureSynchronizedState(rec: IAdeMissionRecord): IMissionRuntimeState {
		return this.legacyController.ensureSynchronizedState(rec);
	}

	ensureSynchronizedOrchestrationState(rec: IAdeMissionRecord): IOrchestrationRuntimeState {
		return this.orchestrationController.ensureSynchronizedOrchestrationState(rec);
	}

	commitOrchestrationState(missionId: string, state: IOrchestrationRuntimeState): void {
		this.orchestrationController.commitOrchestrationState(missionId, state);
	}

	resolveNodePricingOptions(state: IMissionRuntimeState, nodeId: string, fallbackAgent?: IAdeAgent): IMissionTurnUsagePricingOptions {
		return this.legacyController.resolveNodePricingOptions(state, nodeId, fallbackAgent);
	}

	computeEffectiveNodeChecks(rec: IAdeMissionRecord, parsed?: Parameters<AdeMissionLegacyEngineController['computeEffectiveNodeChecks']>[1], onlyNodeId?: string) {
		return this.legacyController.computeEffectiveNodeChecks(rec, parsed, onlyNodeId);
	}

	stopActiveAgentsOnBudgetTrip(state: IMissionRuntimeState, rec?: IAdeMissionRecord): Promise<void> {
		return this.legacyController.stopActiveAgentsOnBudgetTrip(state, rec);
	}

	notifyBudgetCircuitTripped(rec: IAdeMissionRecord, state: IMissionRuntimeState): void {
		this.legacyController.notifyBudgetCircuitTripped(rec, state);
	}

	flushNextQueuedDispatch(agentId: string): void {
		this.dispatchController.flushNextQueuedDispatch(agentId);
	}

	flushPendingDispatchesForReleasedAgents(prevState: IMissionRuntimeState, nextState: IMissionRuntimeState): void {
		this.dispatchController.flushPendingDispatchesForReleasedAgents(prevState, nextState);
	}

	flushPendingDispatchesForReleasedOrchAgents(prevState: IOrchestrationRuntimeState | undefined, nextState: IOrchestrationRuntimeState): void {
		this.dispatchController.flushPendingDispatchesForReleasedOrchAgents(prevState, nextState);
	}

	dispatchPromptToAgent(agentId: string | undefined, prompt: string, options?: IPendingAgentDispatchOptions): Promise<boolean> {
		return this.dispatchController.dispatchPromptToAgent(agentId, prompt, options);
	}

	executeEffects(rec: IAdeMissionRecord, effects: readonly MissionEngineEffect[]): Promise<void> {
		return this.dispatchController.executeEffects(rec, effects);
	}

	executeOrchestrationEffects(rec: IAdeMissionRecord, effects: readonly OrchestrationEngineEffect[], options?: { readonly preferReattachForRemote?: boolean }): Promise<void> {
		return this.dispatchController.executeOrchestrationEffects(rec, effects, options);
	}

	// ---- Public IAdeMissionRuntimeService delegates ----

	getRuntimeState(missionId: string): IMissionRuntimeState {
		return this.legacyController.getRuntimeState(missionId);
	}

	getMissionStatus(missionId: string): IMissionStatusView {
		return this.legacyController.getMissionStatus(missionId);
	}

	findMissionForAgent(agentId: string) {
		return this.legacyController.findMissionForAgent(agentId);
	}

	start(missionId: string, options?: Parameters<IAdeMissionRuntimeService['start']>[1]) {
		return this.legacyController.start(missionId, options);
	}

	setConcurrencyLimits(missionId: string, limits: IMissionConcurrencyLimits | undefined) {
		return this.legacyController.setConcurrencyLimits(missionId, limits);
	}

	pause(missionId: string) {
		return this.legacyController.pause(missionId);
	}

	resume(missionId: string) {
		return this.legacyController.resume(missionId);
	}

	stop(missionId: string) {
		return this.legacyController.stop(missionId);
	}

	setSilenceTimeout(missionId: string, minutes: number) {
		return this.legacyController.setSilenceTimeout(missionId, minutes);
	}

	setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined) {
		return this.legacyController.setBudgetLimit(missionId, budgetLimitUsd);
	}

	distillNodeContext(missionId: string, nodeId: string, options?: { readonly memo?: string }) {
		return this.legacyController.distillNodeContext(missionId, nodeId, options);
	}

	getBoundary(missionId: string) {
		return this.legacyController.getBoundary(missionId);
	}

	setBoundary(missionId: string, patch: Parameters<IAdeMissionRuntimeService['setBoundary']>[1]) {
		return this.legacyController.setBoundary(missionId, patch);
	}

	bindNodeHost(missionId: string, nodeId: string, options: Parameters<IAdeMissionRuntimeService['bindNodeHost']>[2]) {
		return this.legacyController.bindNodeHost(missionId, nodeId, options);
	}

	getCurrentTokens(agentId: string, missionId?: string) {
		return this.legacyController.getCurrentTokens(agentId, missionId);
	}

	expandTrace(missionId: string, tracePtr: string, maxEntries = 100) {
		return this.legacyController.expandTrace(missionId, tracePtr, maxEntries);
	}

	getEffectiveNodeChecks(missionId: string, nodeId?: string) {
		return this.legacyController.getEffectiveNodeChecks(missionId, nodeId);
	}

	runNodeChecks(missionId: string, nodeId: string, options?: { readonly checkIds?: readonly string[] }) {
		return this.legacyController.runNodeChecks(missionId, nodeId, options);
	}

	completeToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['completeToken']>[1]) {
		return this.legacyController.completeToken(missionId, params);
	}

	rejectToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['rejectToken']>[1]) {
		return this.legacyController.rejectToken(missionId, params);
	}

	blockToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['blockToken']>[1]) {
		return this.legacyController.blockToken(missionId, params);
	}

	failToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['failToken']>[1]) {
		return this.legacyController.failToken(missionId, params);
	}

	retryToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['retryToken']>[1]) {
		return this.legacyController.retryToken(missionId, params);
	}

	escalate(missionId: string, params: Parameters<IAdeMissionRuntimeService['escalate']>[1]) {
		return this.legacyController.escalate(missionId, params);
	}

	resolveGate(missionId: string, params: Parameters<IAdeMissionRuntimeService['resolveGate']>[1]) {
		return this.legacyController.resolveGate(missionId, params);
	}

	recallTokens(missionId: string, params: Parameters<IAdeMissionRuntimeService['recallTokens']>[1]) {
		return this.legacyController.recallTokens(missionId, params);
	}

	patchMermaid(missionId: string, params: Parameters<IAdeMissionRuntimeService['patchMermaid']>[1]) {
		return this.legacyController.patchMermaid(missionId, params);
	}

	listTriggers(missionId: string) {
		return this.legacyController.listTriggers(missionId);
	}

	setTrigger(missionId: string, triggerInput: Parameters<IAdeMissionRuntimeService['setTrigger']>[1], caller: Parameters<IAdeMissionRuntimeService['setTrigger']>[2]) {
		return this.legacyController.setTrigger(missionId, triggerInput, caller);
	}

	removeTrigger(missionId: string, triggerId: string, caller: Parameters<IAdeMissionRuntimeService['removeTrigger']>[2]) {
		return this.legacyController.removeTrigger(missionId, triggerId, caller);
	}

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp = Date.now()): void {
		this.dispatchController.touchAgentActivity(sessionResourceOrAgentId, timestamp);
	}

	beginInteractiveTurn(sessionResourceOrAgentId: string, options?: { readonly userPrompt?: string; readonly isDirectUserChat?: boolean }) {
		return this.dispatchController.beginInteractiveTurn(sessionResourceOrAgentId, options);
	}

	endInteractiveTurn(turnId: string): void {
		this.dispatchController.endInteractiveTurn(turnId);
	}

	recordTurnUsageBySessionResource(
		sessionResource: string,
		usage: IMissionTurnUsageInput,
		options?: { readonly turnId?: string; readonly missionId?: string; readonly nodeId?: string; readonly tokenId?: string },
	): void {
		this.dispatchController.recordTurnUsageBySessionResource(sessionResource, usage, options);
	}

	recordNodeTurnUsage(missionId: string, nodeId: string, usage: IMissionTurnUsageInput): void {
		this.dispatchController.recordNodeTurnUsage(missionId, nodeId, usage);
	}

	recoverInterruptedActiveTokens(missionId?: string): Promise<number> {
		return this.dispatchController.recoverInterruptedActiveTokens(missionId);
	}

	setTransientRetryBackoffsForTesting(backoffsMs: readonly number[]): void {
		this.transientRetryBackoffsMs = backoffsMs.length > 0 ? [...backoffsMs] : [8_000, 20_000, 45_000];
	}

	setMissionTaskStatus(missionId: string, params: Parameters<IAdeMissionRuntimeService['setMissionTaskStatus']>[1]) {
		return this.orchestrationController.setMissionTaskStatus(missionId, params);
	}

	recordTaskCheckReceipt(missionId: string, nodeId: string, receipt: Parameters<NonNullable<IAdeMissionRuntimeService['recordTaskCheckReceipt']>>[2]): void {
		this.orchestrationController.recordTaskCheckReceipt(missionId, nodeId, receipt);
	}

	getMissionDiagnostics(missionId: string) {
		return this.orchestrationController.getMissionDiagnostics(missionId);
	}

	createMissionCheckpoint(missionId: string, options?: Parameters<IAdeMissionRuntimeService['createMissionCheckpoint']>[1]) {
		return this.orchestrationController.createMissionCheckpoint(missionId, options);
	}

	listMissionCheckpoints(missionId: string) {
		return this.orchestrationController.listMissionCheckpoints(missionId);
	}

	diffMissionCheckpoint(missionId: string, fromCheckpointId: string, toCheckpointId?: string) {
		return this.orchestrationController.diffMissionCheckpoint(missionId, fromCheckpointId, toCheckpointId);
	}

	restoreMissionCheckpoint(missionId: string, checkpointId: string, options?: Parameters<IAdeMissionRuntimeService['restoreMissionCheckpoint']>[2]) {
		return this.orchestrationController.restoreMissionCheckpoint(missionId, checkpointId, options);
	}

	getOrchestrationState(missionId: string) {
		return this.orchestrationController.getOrchestrationState(missionId);
	}

	getCurrentOrchestrationTokens(agentId: string, missionId?: string) {
		return this.orchestrationController.getCurrentOrchestrationTokens(agentId, missionId);
	}

	getOrchestrationTokenDelta(missionId: string, tokenId: string) {
		return this.orchestrationController.getOrchestrationTokenDelta(missionId, tokenId);
	}

	getOrchestrationTokenHistory(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }) {
		return this.orchestrationController.getOrchestrationTokenHistory(missionId, tokenId, options);
	}

	getOrchestrationTokenHistoryAsync(missionId: string, tokenId: string, options?: { readonly includeAll?: boolean }) {
		return this.orchestrationController.getOrchestrationTokenHistoryAsync(missionId, tokenId, options);
	}

	readOrchestrationTokenPointers(missionId: string, params: Parameters<IAdeMissionRuntimeService['readOrchestrationTokenPointers']>[1]) {
		return this.orchestrationController.readOrchestrationTokenPointers(missionId, params);
	}

	readOrchestrationTokenPointersAsync(missionId: string, params: Parameters<NonNullable<IAdeMissionRuntimeService['readOrchestrationTokenPointersAsync']>>[1]) {
		return this.orchestrationController.readOrchestrationTokenPointersAsync(missionId, params);
	}

	dispatchOrchestrationRequirement(missionId: string, params: Parameters<IAdeMissionRuntimeService['dispatchOrchestrationRequirement']>[1]) {
		return this.orchestrationController.dispatchOrchestrationRequirement(missionId, params);
	}

	mintOrchestrationTokens(missionId: string, params: Parameters<IAdeMissionRuntimeService['mintOrchestrationTokens']>[1]) {
		return this.orchestrationController.mintOrchestrationTokens(missionId, params);
	}

	returnOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['returnOrchestrationToken']>[1]) {
		return this.orchestrationController.returnOrchestrationToken(missionId, params);
	}

	handoffOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['handoffOrchestrationToken']>[1]) {
		return this.orchestrationController.handoffOrchestrationToken(missionId, params);
	}

	completeOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['completeOrchestrationToken']>[1]) {
		return this.orchestrationController.completeOrchestrationToken(missionId, params);
	}

	failOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['failOrchestrationToken']>[1]) {
		return this.orchestrationController.failOrchestrationToken(missionId, params);
	}

	rejectOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['rejectOrchestrationToken']>[1]) {
		return this.orchestrationController.rejectOrchestrationToken(missionId, params);
	}

	retryOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['retryOrchestrationToken']>[1]) {
		return this.orchestrationController.retryOrchestrationToken(missionId, params);
	}

	pauseOrchestration(missionId: string, reason?: string) {
		return this.orchestrationController.pauseOrchestration(missionId, reason);
	}

	resumeOrchestration(missionId: string) {
		return this.orchestrationController.resumeOrchestration(missionId);
	}

	abortOrchestrationTokens(missionId: string, reason?: string) {
		return this.orchestrationController.abortOrchestrationTokens(missionId, reason);
	}

	setOrchestrationLimits(missionId: string, params: Parameters<IAdeMissionRuntimeService['setOrchestrationLimits']>[1]) {
		return this.orchestrationController.setOrchestrationLimits(missionId, params);
	}

	blockOrchestrationToken(missionId: string, params: Parameters<IAdeMissionRuntimeService['blockOrchestrationToken']>[1]) {
		return this.orchestrationController.blockOrchestrationToken(missionId, params);
	}

	removeOrchestrationSubordinate(missionId: string, params: Parameters<IAdeMissionRuntimeService['removeOrchestrationSubordinate']>[1]) {
		return this.orchestrationController.removeOrchestrationSubordinate(missionId, params);
	}

	reconcileRemovedOrchestrationStaff(missionId: string, removedNodeIds: readonly string[], options?: Parameters<IAdeMissionRuntimeService['reconcileRemovedOrchestrationStaff']>[2]) {
		return this.orchestrationController.reconcileRemovedOrchestrationStaff(missionId, removedNodeIds, options);
	}

	updateOrchestrationStaffConfig(missionId: string, nodeId: string, patch: Parameters<IAdeMissionRuntimeService['updateOrchestrationStaffConfig']>[2]) {
		return this.orchestrationController.updateOrchestrationStaffConfig(missionId, nodeId, patch);
	}

	createOrchestrationSubordinate(missionId: string, params: Parameters<IAdeMissionRuntimeService['createOrchestrationSubordinate']>[1]) {
		return this.orchestrationController.createOrchestrationSubordinate(missionId, params);
	}

	listOrchestrationWhiteboards(missionId: string, caller?: Parameters<IAdeMissionRuntimeService['listOrchestrationWhiteboards']>[1]) {
		return this.orchestrationController.listOrchestrationWhiteboards(missionId, caller);
	}

	readOrchestrationWhiteboard(missionId: string, whiteboardId: string, caller?: Parameters<IAdeMissionRuntimeService['readOrchestrationWhiteboard']>[2]) {
		return this.orchestrationController.readOrchestrationWhiteboard(missionId, whiteboardId, caller);
	}

	upsertOrchestrationWhiteboard(missionId: string, params: Parameters<IAdeMissionRuntimeService['upsertOrchestrationWhiteboard']>[1]) {
		return this.orchestrationController.upsertOrchestrationWhiteboard(missionId, params);
	}

	removeOrchestrationWhiteboard(missionId: string, whiteboardId: string) {
		return this.orchestrationController.removeOrchestrationWhiteboard(missionId, whiteboardId);
	}
}
