/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AEXUS_SSH_SCHEME, buildCloudProjectUri, IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	buildAdeRemotePersistentPrefix,
	IAdeEngineeringBackendService,
	IAdeInboxService,
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	IMissionBoundaryConfig,
	IMissionNodeAssignment,
	IMissionSupervisorBinding,
	MissionNodeRoleKind,
	resolveSupervisorJurisdiction,
	validateMissionFactoryBoundary,
} from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	IMissionNodeCheckExecutionResult,
	IMissionNodeCheckHook,
	IMissionNodeCheckSuiteResult,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	appendMissionDagRevision,
	applySafeMissionPatch,
	blockMissionToken,
	completeMissionToken,
	composeMissionNodeWakeupPrompt,
	computeMissionTotalCostUsd,
	createInitialMissionRuntimeState,
	distillMissionNodeContext,
	escalateMissionIssue,
	expandTracePointer,
	failMissionToken,
	fireMissionSourceTrigger,
	IMissionEngineCaller,
	IMissionEngineTransitionResult,
	IMissionNodeTelemetry,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	IMissionTraceNode,
	IMissionTurnUsageInput,
	MissionEngineEffect,
	parseDurationMs,
	pauseMissionRun,
	recallMissionTokens,
	recordMissionNodeTurnUsage,
	recordTokenCheckResult,
	recordWatchdogWakeup,
	rejectMissionToken,
	resolveMissionGate,
	resumeMissionRun,
	retryMissionToken,
	setMissionBudgetLimit,
	setMissionSilenceTimeout,
	startMissionRun,
	stopMissionRun,
	validateSourceTrigger,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator, IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export const IAdeMissionRuntimeService = createDecorator<IAdeMissionRuntimeService>('adeMissionRuntimeService');

export interface IMissionStatusView {
	readonly missionId: string;
	readonly title: string;
	readonly status: IMissionRuntimeState['status'];
	readonly silenceTimeoutMinutes: number;
	readonly silenceTimeoutLocked: boolean;
	readonly boundary: IMissionBoundaryConfig;
	readonly boundaryValidation: ReturnType<typeof validateMissionFactoryBoundary>;
	readonly nodeStates: IMissionRuntimeState['nodeStates'];
	readonly tokens: readonly IMissionToken[];
	readonly activeTokenCount: number;
	readonly blockedTokenCount: number;
	readonly waitingGateCount: number;
	readonly waitingJoinCount?: number;
	readonly failedTokenCount: number;
	readonly triggers: readonly IMissionSourceTrigger[];
	readonly nodeChecks?: Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	readonly nodeTelemetry?: Readonly<Record<string, IMissionNodeTelemetry>>;
	readonly waveSeq: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly updatedAt: number;
}

export interface IAdeMissionRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<string>;

	getRuntimeState(missionId: string): IMissionRuntimeState;
	getMissionStatus(missionId: string): IMissionStatusView;
	findMissionForAgent(agentId: string): {
		readonly mission: IAdeMissionRecord;
		readonly runtime: IMissionRuntimeState;
		readonly nodeIds: readonly string[];
		readonly isOffGraphSupervisor?: boolean;
		readonly managedNodeIds?: readonly string[];
	} | undefined;

	start(missionId: string, options?: { readonly silenceTimeoutMinutes?: number; readonly initialPrompt?: string }): Promise<IMissionEngineTransitionResult>;
	pause(missionId: string): Promise<IMissionEngineTransitionResult>;
	resume(missionId: string): Promise<IMissionEngineTransitionResult>;
	stop(missionId: string): Promise<IMissionEngineTransitionResult>;
	setSilenceTimeout(missionId: string, minutes: number): Promise<IMissionEngineTransitionResult>;
	setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined): Promise<{ readonly ok: boolean; readonly state: IMissionRuntimeState; readonly error?: string }>;
	distillNodeContext(missionId: string, nodeId: string, options?: { readonly memo?: string }): Promise<IMissionEngineTransitionResult>;

	getBoundary(missionId: string): { readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary> };
	setBoundary(missionId: string, patch: {
		readonly offGraphMaxTier?: number;
		readonly supervisors?: readonly IMissionSupervisorBinding[];
		readonly nodeAssignments?: Readonly<Record<string, IMissionNodeAssignment>>;
	}): Promise<{ readonly ok: boolean; readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary>; readonly error?: string }>;

	bindNodeHost(missionId: string, nodeId: string, options: {
		readonly hostAlias?: string;
		readonly remoteProjectPath?: string;
		readonly agentId?: string;
		readonly roleKind?: MissionNodeRoleKind;
	}): Promise<{ readonly ok: boolean; readonly assignment?: IMissionNodeAssignment; readonly error?: string }>;

	getCurrentTokens(agentId: string, missionId?: string): readonly IMissionToken[];
	expandTrace(missionId: string, tracePtr: string, maxEntries?: number): readonly IMissionTraceNode[];
	getEffectiveNodeChecks(missionId: string, nodeId?: string): Readonly<Record<string, readonly IMissionNodeCheckHook[]>>;
	runNodeChecks(missionId: string, nodeId: string, options?: { readonly checkIds?: readonly string[] }): Promise<IMissionNodeCheckSuiteResult>;
	completeToken(missionId: string, params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string; readonly skipChecks?: boolean }): Promise<IMissionEngineTransitionResult>;
	rejectToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly targetNodeId?: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult>;
	blockToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDuration: string | number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
	}): Promise<IMissionEngineTransitionResult>;
	failToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult>;
	retryToken(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly tokenId?: string; readonly nodeId?: string; readonly guidance?: string }): Promise<IMissionEngineTransitionResult>;
	escalate(missionId: string, params: { readonly callerSupervisorId: string; readonly reason: string; readonly tokenId?: string; readonly nodeId?: string; readonly isSecretary?: boolean; readonly isHumanUser?: boolean }): Promise<IMissionEngineTransitionResult>;
	resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly tokenId?: string; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult>;
	recallTokens(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly nodeIds?: readonly string[]; readonly branchRootNodeId?: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult>;
	patchMermaid(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly newMermaidText: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult>;
	recoverInterruptedActiveTokens(missionId?: string): Promise<number>;

	listTriggers(missionId: string): readonly IMissionSourceTrigger[];
	setTrigger(missionId: string, triggerInput: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: IMissionSourceTrigger['kind'] }, caller: IMissionEngineCaller): Promise<{ readonly ok: boolean; readonly trigger?: IMissionSourceTrigger; readonly error?: string; readonly code?: string }>;
	removeTrigger(missionId: string, triggerId: string, caller: IMissionEngineCaller): Promise<{ readonly ok: boolean; readonly removedId?: string; readonly error?: string; readonly code?: string }>;

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp?: number): void;
	recordTurnUsageBySessionResource(sessionResource: string, usage: IMissionTurnUsageInput): void;
	recordNodeTurnUsage(missionId: string, nodeId: string, usage: IMissionTurnUsageInput): void;
}

export class AdeMissionRuntimeService extends Disposable implements IAdeMissionRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly lastHeartbeatSyncAt = new Map<string, number>();
	private readonly inMemoryAgentActivityAt = new Map<string, number>();
	private readonly unclosedTurnNudgeCount = new Map<string, number>();
	private readonly transientRetryCount = new Map<string, number>();
	private readonly inFlightCheckTokens = new Set<string>();
	private readonly pendingTurnNudgeTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly activeTurnsByAgent = new Map<string, number>();
	private readonly pendingDispatchesByAgent = new Map<string, Array<{
		readonly prompt: string;
		readonly options?: {
			readonly autonomousApproved?: boolean;
			readonly missionId?: string;
			readonly tokenId?: string;
			readonly nodeId?: string;
			readonly requireLiveDelivery?: boolean;
			readonly dedupeKey?: string;
			readonly retryAttempt?: number;
			readonly preferReattach?: boolean;
			readonly onDispatchError?: (reason: string) => void;
		};
	}>>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register({
			dispose: () => {
				for (const timer of this.pendingTurnNudgeTimers) {
					clearTimeout(timer);
				}
				this.pendingTurnNudgeTimers.clear();
			},
		});
		this.bindBackendEvents();
		// Rehydrate watchdog registrations (preserving any active owner window) and subscribe to cross-window Mission sync.
		queueMicrotask(() => {
			if (this._store.isDisposed) {
				return;
			}
			const missions = this.missionService;
			if (missions?.onDidChangeExternal) {
				this._register(missions.onDidChangeExternal(() => {
					for (const rec of this.missionService?.listMissions() ?? []) {
						this._onDidChange.fire(rec.id);
					}
				}));
			}
			let hasRunningMissions = false;
			for (const rec of missions?.listMissions() ?? []) {
				if (rec.runtime?.status === 'running') {
					hasRunningMissions = true;
					this.syncWatchdog(rec.id, rec.runtime, { preserveExistingOwner: true });
				}
			}
			// After IDE restart, automatically resume interrupted active tokens instead of waiting for silence timeout.
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
		});
	}

	private tryGet<T>(id: ServiceIdentifier<T>): T | undefined {
		try {
			return this.instantiationService.invokeFunction(accessor => accessor.get(id));
		} catch {
			return undefined;
		}
	}

	private get missionService(): IAdeMissionService | undefined {
		return this.tryGet(IAdeMissionService);
	}

	private get projectsService(): IAdeProjectsService | undefined {
		return this.tryGet(IAdeProjectsService);
	}

	private get sessionsService(): IAdeSessionsService | undefined {
		return this.tryGet(IAdeSessionsService);
	}

	private get inboxService(): IAdeInboxService | undefined {
		return this.tryGet(IAdeInboxService);
	}

	private get backendService(): IAdeEngineeringBackendService | undefined {
		return this.tryGet(IAdeEngineeringBackendService);
	}

	private get roleSchemaService(): IAdeRoleSchemaService | undefined {
		return this.tryGet(IAdeRoleSchemaService);
	}

	private get cloudHostService(): IAdeCloudHostBackendService | undefined {
		return this.tryGet(IAdeCloudHostBackendService);
	}

	private get commandService(): ICommandService | undefined {
		return this.tryGet(ICommandService);
	}

	private get orgConfig(): IAdeOrganizationConfig {
		return this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	}

	private bindBackendEvents(): void {
		const backend = this.backendService;
		if (!backend) {
			return;
		}
		if (backend.onDidWatchdogWakeup) {
			this._register(backend.onDidWatchdogWakeup(ev => {
				void this.handleWatchdogWakeup(ev);
			}));
		}
		if (backend.onDidSourceTriggerFire) {
			this._register(backend.onDidSourceTriggerFire(ev => {
				void this.handleSourceTriggerFire(ev);
			}));
		}
		if (backend.onDidSystemResume) {
			this._register(backend.onDidSystemResume(() => {
				// Wake sleeping SSH reattach loops & heal dropped reverse control bridges immediately on OS wake.
				void this.commandService?.executeCommand('aexus.agentEngines.notifySystemResume').catch(() => undefined);
			}));
		}
	}

	private requireMission(missionId: string): IAdeMissionRecord {
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

	private ensureSynchronizedState(rec: IAdeMissionRecord): IMissionRuntimeState {
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		const nodeIds = parsed.nodes.map(n => n.id);
		const org = this.orgConfig;
		const base = rec.runtime ?? createInitialMissionRuntimeState(
			rec.id,
			org,
			{ ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
			nodeIds,
			5,
		);

		const generatedEmployees = this.missionService?.getGeneratedEmployees(rec.id) ?? [];
		const byNodeId = new Map<string, IAdeAgent>();
		for (const emp of generatedEmployees) {
			if (emp.treeNodeId) {
				byNodeId.set(emp.treeNodeId, emp);
			}
			for (const nid of emp.treeNodeIds ?? []) {
				byNodeId.set(nid, emp);
			}
		}

		const isLiveRun = base.status === 'running' || base.status === 'paused';
		const isExplicitEmpty = rec.mermaidText.trim().length === 0;
		// Only prune stale node references when Mermaid parses cleanly AND is not mid-typing a header-only draft
		// AND the Mission is not actively running/paused (live runs mutate topology atomically via patchMermaid).
		const canPruneStaleNodes = !parsed.error && !isLiveRun && (nodeIds.length > 0 || isExplicitEmpty);
		const validNodeIdSet = new Set(nodeIds);
		const validTaskNodeIdSet = new Set(parsed.nodes.filter(n => n.kind !== 'gate').map(n => n.id));
		const defaultInGraphTier = Math.min(org.ranks.length, Math.max(1, base.boundary.offGraphMaxTier + 1));
		const nextAssignments: Record<string, IMissionNodeAssignment> = { ...base.boundary.nodeAssignments };
		let assignmentsChanged = false;
		if (canPruneStaleNodes) {
			for (const existingNodeId of Object.keys(nextAssignments)) {
				if (!validTaskNodeIdSet.has(existingNodeId)) {
					delete nextAssignments[existingNodeId];
					assignmentsChanged = true;
				}
			}
		}
		if (!parsed.error) {
			for (const node of parsed.nodes) {
				if (node.kind === 'gate') {
					continue;
				}
				const existing = nextAssignments[node.id];
				const matchedAgent = byNodeId.get(node.id);
				const existingAgent = existing?.agentId ? this.projectsService?.getAgent(existing.agentId) : undefined;
				// Preserve explicit manual agent bindings (e.g. standalone pure Workers bound via `mission host bind --agent`
				// or `mission boundary set`), while still following Mermaid/popover reassignment among Mission-generated employees.
				const hasManualOverride = Boolean(existingAgent && !existingAgent.treeNodeId && (!existingAgent.treeNodeIds || existingAgent.treeNodeIds.length === 0));
				const resolvedAgentId = hasManualOverride ? existingAgent!.id : (matchedAgent?.id ?? existing?.agentId);
				const resolvedAgent = hasManualOverride ? existingAgent : (matchedAgent ?? existingAgent);
				// Resolve real live rank tier with ZERO artificial clamping so factory boundary checks are honest.
				const resolvedTier = resolvedAgent
					? resolveEffectiveRankDefinition(org, resolvedAgent.role, this.projectsService?.hasSubordinates(resolvedAgent.id) ?? false).tier
					: (existing?.tier ?? defaultInGraphTier);
				const resolvedHost = existing?.hostAlias ?? (resolvedAgent?.projectUri.scheme === 'aexus-ssh' ? resolvedAgent.projectUri.authority : 'local');
				const resolvedRemotePath = existing?.remoteProjectPath ?? (resolvedAgent?.projectUri.scheme === 'aexus-ssh' ? resolvedAgent.projectUri.path : undefined);
				if (!existing || existing.agentId !== resolvedAgentId || existing.tier !== resolvedTier) {
					nextAssignments[node.id] = {
						agentId: resolvedAgentId,
						tier: resolvedTier,
						roleKind: existing?.roleKind ?? 'worker',
						hostAlias: resolvedHost,
						...(resolvedRemotePath ? { remoteProjectPath: resolvedRemotePath } : {}),
					};
					assignmentsChanged = true;
				}
			}
		}

		// Prune stale deleted-node references (when safe) and sync live supervisor tiers
		// so deleting/replacing DAG nodes never leaves ghost "references unknown DAG node" boundary errors.
		let supervisorsChanged = false;
		const nextSupervisors = base.boundary.supervisors.map(sup => {
			let nextSup = sup;
			if (canPruneStaleNodes) {
				const filteredNodes = sup.managedNodeIds.filter(nid => validNodeIdSet.has(nid));
				if (filteredNodes.length !== sup.managedNodeIds.length) {
					supervisorsChanged = true;
					nextSup = { ...nextSup, managedNodeIds: filteredNodes };
				}
			}
			if (nextSup.id === ADE_SECRETARY_ID) {
				if (nextSup.tier !== 0) {
					supervisorsChanged = true;
					return { ...nextSup, tier: 0 };
				}
				return nextSup;
			}
			const supAgent = this.projectsService?.getAgent(nextSup.id);
			if (supAgent) {
				const liveTier = resolveEffectiveRankDefinition(org, supAgent.role, this.projectsService?.hasSubordinates(supAgent.id) ?? false).tier;
				if (nextSup.tier !== liveTier) {
					supervisorsChanged = true;
					return { ...nextSup, tier: liveTier };
				}
			}
			return nextSup;
		});

		const nextNodeStates: Record<string, IMissionRuntimeState['nodeStates'][string]> = { ...base.nodeStates };
		let statesChanged = false;
		if (canPruneStaleNodes) {
			for (const existingStateNodeId of Object.keys(nextNodeStates)) {
				if (!validNodeIdSet.has(existingStateNodeId)) {
					delete nextNodeStates[existingStateNodeId];
					statesChanged = true;
				}
			}
		}
		if (!parsed.error) {
			for (const node of parsed.nodes) {
				if (!Object.hasOwn(nextNodeStates, node.id)) {
					nextNodeStates[node.id] = 'idle';
					statesChanged = true;
				}
			}
		}

		// Keep live active/blocked token holderAgentId and deferred dispatch effects synchronized with current node assignment.
		let tokensChanged = false;
		const nextTokens: Record<string, IMissionToken> = { ...base.tokens };
		for (const [tid, tok] of Object.entries(base.tokens)) {
			if (tok.status === 'active' || tok.status === 'blocked') {
				const currentAssigned = nextAssignments[tok.nodeId]?.agentId;
				if (currentAssigned && tok.holderAgentId !== currentAssigned) {
					nextTokens[tid] = { ...tok, holderAgentId: currentAssigned };
					tokensChanged = true;
				}
			}
		}

		let deferredChanged = false;
		const nextDeferredEffects = base.deferredEffects?.map(eff => {
			if (eff.kind === 'dispatch_token' || eff.kind === 'wakeup_agent') {
				const currentAssigned = nextAssignments[eff.nodeId]?.agentId ?? nextTokens[eff.tokenId]?.holderAgentId;
				if (currentAssigned && eff.holderAgentId !== currentAssigned) {
					deferredChanged = true;
					return { ...eff, holderAgentId: currentAssigned };
				}
			}
			return eff;
		});

		if (!assignmentsChanged && !supervisorsChanged && !statesChanged && !tokensChanged && !deferredChanged && rec.runtime) {
			return base;
		}
		return {
			...base,
			nodeStates: nextNodeStates,
			tokens: nextTokens,
			...(nextDeferredEffects ? { deferredEffects: nextDeferredEffects } : {}),
			boundary: {
				...base.boundary,
				supervisors: nextSupervisors,
				nodeAssignments: nextAssignments,
			},
		};
	}

	private commitState(missionId: string, state: IMissionRuntimeState, options?: { readonly deferPersist?: boolean; readonly skipWatchdogSync?: boolean }): void {
		this.missionService?.updateRuntime(missionId, state, options?.deferPersist ? { deferPersist: true } : undefined);
		if (!options?.skipWatchdogSync) {
			this.syncWatchdog(missionId, state);
		}
		this._onDidChange.fire(missionId);
	}

	private syncWatchdog(missionId: string, state: IMissionRuntimeState, options?: { readonly preserveExistingOwner?: boolean }): void {
		const backend = this.backendService;
		if (!backend?.syncMissionWatchdog) {
			return;
		}
		if (state.status !== 'running') {
			void backend.removeMissionWatchdog?.(missionId).catch(() => undefined);
			return;
		}
		const snapshot: IAdeMissionWatchdogSnapshot = {
			missionId,
			status: state.status,
			silenceTimeoutMinutes: state.silenceTimeoutMinutes,
			tokens: Object.values(state.tokens)
				.filter(t => t.status === 'active' || t.status === 'blocked')
				.map(t => {
					const memActivity = t.holderAgentId ? (this.inMemoryAgentActivityAt.get(t.holderAgentId) ?? 0) : 0;
					const holderAgent = t.holderAgentId ? this.projectsService?.getAgent(t.holderAgentId) : undefined;
					const hostAlias = holderAgent?.projectUri?.scheme === AEXUS_SSH_SCHEME && holderAgent.projectUri.authority
						? holderAgent.projectUri.authority
						: undefined;
					const sessionId = holderAgent?.session?.resource?.path?.replace(/^\/+/, '');
					const remoteSessionPrefix = hostAlias && holderAgent?.session?.engineId && sessionId
						? buildAdeRemotePersistentPrefix(holderAgent.session.engineId, sessionId)
						: undefined;
					return {
						tokenId: t.id,
						nodeId: t.nodeId,
						holderAgentId: t.holderAgentId,
						status: t.status,
						lastActivityAt: Math.max(t.lastActivityAt, memActivity),
						lastNudgeAt: t.lastNudgeAt,
						...(hostAlias ? { hostAlias } : {}),
						...(remoteSessionPrefix ? { remoteSessionPrefix } : {}),
						...(t.blocked ? { blocked: t.blocked } : {}),
					};
				}),
			triggers: state.triggers,
			...(options?.preserveExistingOwner ? { preserveExistingOwner: true } : {}),
		};
		void backend.syncMissionWatchdog(snapshot).catch(() => undefined);
	}

	getRuntimeState(missionId: string): IMissionRuntimeState {
		const rec = this.requireMission(missionId);
		return this.ensureSynchronizedState(rec);
	}

	getMissionStatus(missionId: string): IMissionStatusView {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		const validation = validateMissionFactoryBoundary(this.orgConfig, state.boundary, parsed);
		const tokens = Object.values(state.tokens);
		const nodeChecks = this.computeEffectiveNodeChecks(rec, parsed);
		return {
			missionId: rec.id,
			title: rec.title,
			status: state.status,
			silenceTimeoutMinutes: state.silenceTimeoutMinutes,
			silenceTimeoutLocked: state.silenceTimeoutLocked,
			boundary: state.boundary,
			boundaryValidation: validation,
			nodeStates: state.nodeStates,
			tokens,
			activeTokenCount: tokens.filter(t => t.status === 'active').length,
			blockedTokenCount: tokens.filter(t => t.status === 'blocked').length,
			waitingGateCount: tokens.filter(t => t.status === 'waiting_gate').length,
			waitingJoinCount: tokens.filter(t => t.status === 'waiting_join').length,
			failedTokenCount: tokens.filter(t => t.status === 'frozen_failed').length,
			triggers: state.triggers,
			...(Object.keys(nodeChecks).length > 0 ? { nodeChecks } : {}),
			...(state.nodeTelemetry ? { nodeTelemetry: state.nodeTelemetry } : {}),
			waveSeq: state.waveSeq,
			startedAt: state.startedAt,
			completedAt: state.completedAt,
			updatedAt: state.updatedAt,
		};
	}

	findMissionForAgent(agentId: string): {
		readonly mission: IAdeMissionRecord;
		readonly runtime: IMissionRuntimeState;
		readonly nodeIds: readonly string[];
		readonly isOffGraphSupervisor?: boolean;
		readonly managedNodeIds?: readonly string[];
	} | undefined {
		const missions = this.missionService?.listMissions() ?? [];
		for (const rec of missions) {
			const state = this.ensureSynchronizedState(rec);
			// 1. Check bound off-graph supervisors / Mission owner first
			const boundSup = state.boundary.supervisors.find(s => s.id === agentId);
			if (boundSup || rec.ownerSessionId === agentId) {
				const graph = parseMissionMermaidDag(rec.mermaidText);
				const jur = resolveSupervisorJurisdiction(state.boundary, agentId, graph.nodes.map(n => n.id), { ownerSessionId: rec.ownerSessionId });
				return {
					mission: rec,
					runtime: state,
					nodeIds: [],
					isOffGraphSupervisor: true,
					managedNodeIds: Array.from(jur.nodeIds),
				};
			}
			// 2. Check in-graph DAG node assignments
			const matchedNodes: string[] = [];
			for (const [nid, assign] of Object.entries(state.boundary.nodeAssignments)) {
				if (assign.agentId === agentId) {
					matchedNodes.push(nid);
				}
			}
			if (matchedNodes.length > 0) {
				return { mission: rec, runtime: state, nodeIds: matchedNodes, isOffGraphSupervisor: false };
			}
		}
		// Fallback to sidebar tree metadata
		const agent = this.projectsService?.getAgent(agentId);
		if (agent?.treeGovernorId) {
			const rec = this.missionService?.getMission(agent.treeGovernorId) ?? this.missionService?.getMissionByLinkedSession(agent.treeGovernorId);
			if (rec) {
				const nodeIds = agent.treeNodeIds && agent.treeNodeIds.length > 0
					? agent.treeNodeIds
					: (agent.treeNodeId ? [agent.treeNodeId] : []);
				return { mission: rec, runtime: this.ensureSynchronizedState(rec), nodeIds, isOffGraphSupervisor: false };
			}
		}
		return undefined;
	}

	async start(missionId: string, options?: { readonly silenceTimeoutMinutes?: number; readonly initialPrompt?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const result = startMissionRun(state, graph, this.orgConfig, {
			...options,
			requireAssignedNodes: Boolean(this.projectsService),
		});
		if (result.ok) {
			const withInitialRev = appendMissionDagRevision(result.state, rec.mermaidText, 'Mission started (v1)', undefined, graph);
			this.commitState(rec.id, withInitialRev);
			await this.executeEffects(rec, result.effects);
			return { ...result, state: withInitialRev };
		}
		return result;
	}

	async pause(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = pauseMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.commitState(rec.id, result.state);
		}
		return result;
	}

	async resume(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = resumeMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
			// Re-flush any queued per-agent dispatches that were preserved while this Mission was paused.
			for (const agentId of Array.from(this.pendingDispatchesByAgent.keys())) {
				const queue = this.pendingDispatchesByAgent.get(agentId);
				if (queue?.some(item => item.options?.missionId === rec.id)) {
					this.flushNextQueuedDispatch(agentId);
				}
			}
		}
		return result;
	}

	async stop(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = stopMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async setSilenceTimeout(missionId: string, minutes: number): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = setMissionSilenceTimeout(this.ensureSynchronizedState(rec), minutes);
		if (result.ok) {
			this.commitState(rec.id, result.state);
		}
		return result;
	}

	async setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined): Promise<{ readonly ok: boolean; readonly state: IMissionRuntimeState; readonly error?: string }> {
		const rec = this.requireMission(missionId);
		const prev = this.ensureSynchronizedState(rec);
		const next = setMissionBudgetLimit(prev, budgetLimitUsd);
		this.commitState(rec.id, next);
		if (next.budgetCircuitTripped && !prev.budgetCircuitTripped) {
			void this.stopActiveAgentsOnBudgetTrip(next);
			this.notifyBudgetCircuitTripped(rec, next);
		}
		return { ok: true, state: next };
	}

	async distillNodeContext(missionId: string, nodeId: string, options?: { readonly memo?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const result = distillMissionNodeContext(state, graph, nodeId, options);
		if (!result.ok) {
			return result;
		}
		this.commitState(rec.id, result.state);
		// Stop any bloated session (resolved via nodeAssignment or token holder) and rotate to a clean session before re-dispatching.
		const stopEff = result.effects.find(e => e.kind === 'stop_agent');
		const agentId = result.state.boundary.nodeAssignments[nodeId]?.agentId
			?? (stopEff?.kind === 'stop_agent' ? stopEff.holderAgentId : undefined);
		if (agentId && this.projectsService) {
			const agent = this.projectsService.getAgent(agentId);
			if (agent?.session) {
				const engineId = agent.session.engineId ?? agent.preferredEngineId ?? 'aexus-claude';
				const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
				await this.sessionsService?.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				this.projectsService.setAgentStatus(agent.id, 'idle');
				if (this.sessionsService?.create) {
					const fresh = await this.sessionsService.create(engineId, agent.projectUri).catch(() => undefined);
					if (fresh) {
						this.projectsService.bindSession(agent.id, fresh);
					}
				}
			}
		}
		const nonStopEffects = result.effects.filter(e => e.kind !== 'stop_agent');
		if (nonStopEffects.length > 0) {
			await this.executeEffects(this.requireMission(rec.id), nonStopEffects);
		}
		return result;
	}

	private async stopActiveAgentsOnBudgetTrip(state: IMissionRuntimeState): Promise<void> {
		if (!this.projectsService || !this.sessionsService?.stop) {
			return;
		}
		const agentIds = new Set<string>();
		for (const tok of Object.values(state.tokens)) {
			if (tok.status === 'active' || tok.status === 'blocked') {
				const aid = tok.holderAgentId ?? state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				if (aid) {
					agentIds.add(aid);
				}
			}
		}
		for (const aid of agentIds) {
			const agent = this.projectsService.getAgent(aid);
			if (agent?.session) {
				const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
				await this.sessionsService.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				this.projectsService.setAgentStatus(agent.id, 'idle');
			}
		}
	}

	private notifyBudgetCircuitTripped(rec: IAdeMissionRecord, state: IMissionRuntimeState): void {
		const spent = computeMissionTotalCostUsd(state);
		const limit = state.budgetLimitUsd ?? 0;
		void this.inboxService?.postGovernorMessage?.({
			governorSessionId: rec.ownerSessionId ?? rec.id,
			title: `FinOps Budget Circuit-Breaker Tripped (${rec.title})`,
			message: `Mission "${rec.title}" automatically paused after spending $${spent.toFixed(2)} against the $${limit.toFixed(2)} FinOps budget ceiling. Raise the budget limit in the FinOps Ledger to resume.`,
			severity: 'critical',
		}).catch(() => undefined);
	}

	getBoundary(missionId: string): { readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary> } {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		return {
			boundary: state.boundary,
			validation: validateMissionFactoryBoundary(this.orgConfig, state.boundary, parsed),
		};
	}

	async setBoundary(missionId: string, patch: {
		readonly offGraphMaxTier?: number;
		readonly supervisors?: readonly IMissionSupervisorBinding[];
		readonly nodeAssignments?: Readonly<Record<string, IMissionNodeAssignment>>;
	}): Promise<{ readonly ok: boolean; readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary>; readonly error?: string }> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);

		const nextOffGraphMax = patch.offGraphMaxTier !== undefined ? patch.offGraphMaxTier : state.boundary.offGraphMaxTier;
		const org = this.orgConfig;
		const projects = this.projectsService;

		// Resolve live session tiers for every node assignment (no artificial clamping or silent rewriting).
		const rawAssignments = patch.nodeAssignments ?? state.boundary.nodeAssignments;
		const nextAssignments: Record<string, IMissionNodeAssignment> = {};
		for (const [nid, assign] of Object.entries(rawAssignments)) {
			const agent = assign.agentId ? projects?.getAgent(assign.agentId) : undefined;
			const liveTier = agent
				? resolveEffectiveRankDefinition(org, agent.role, projects?.hasSubordinates(agent.id) ?? false).tier
				: assign.tier;
			nextAssignments[nid] = { ...assign, tier: liveTier };
		}

		// Resolve live session tiers for every supervisor binding and reject unknown session IDs.
		const rawSupervisors = patch.supervisors ?? state.boundary.supervisors;
		const resolvedSupervisors: IMissionSupervisorBinding[] = [];
		for (const sup of rawSupervisors) {
			const supId = sup.id?.trim();
			if (!supId) {
				const errMsg = 'Supervisor binding requires a non-empty session ID.';
				return { ok: false, boundary: state.boundary, validation: { valid: false, errors: [errMsg], offGraphTiers: [], inGraphTiers: [] }, error: errMsg };
			}
			if (supId === ADE_SECRETARY_ID) {
				resolvedSupervisors.push({ ...sup, id: supId, tier: 0 });
				continue;
			}
			if (projects) {
				const supAgent = projects.getAgent(supId);
				if (!supAgent) {
					const errMsg = `Unknown supervisor session ID "${supId}".`;
					return { ok: false, boundary: state.boundary, validation: { valid: false, errors: [errMsg], offGraphTiers: [], inGraphTiers: [] }, error: errMsg };
				}
				const liveTier = resolveEffectiveRankDefinition(org, supAgent.role, projects.hasSubordinates(supAgent.id)).tier;
				resolvedSupervisors.push({ ...sup, id: supId, tier: liveTier });
			} else {
				resolvedSupervisors.push({ ...sup, id: supId });
			}
		}

		const candidate: IMissionBoundaryConfig = {
			offGraphMaxTier: nextOffGraphMax,
			supervisors: resolvedSupervisors,
			nodeAssignments: nextAssignments,
		};
		const validation = validateMissionFactoryBoundary(org, candidate, parsed);
		if (!validation.valid) {
			return {
				ok: false,
				boundary: state.boundary,
				validation,
				error: validation.errors.join(' '),
			};
		}
		const nextState: IMissionRuntimeState = {
			...state,
			boundary: candidate,
			updatedAt: Date.now(),
		};
		this.commitState(rec.id, nextState);
		return { ok: true, boundary: candidate, validation };
	}

	async bindNodeHost(missionId: string, nodeId: string, options: {
		readonly hostAlias?: string;
		readonly remoteProjectPath?: string;
		readonly agentId?: string;
		readonly roleKind?: MissionNodeRoleKind;
	}): Promise<{ readonly ok: boolean; readonly assignment?: IMissionNodeAssignment; readonly error?: string }> {
		const initialRec = this.requireMission(missionId);
		const parsed = parseMissionMermaidDag(initialRec.mermaidText);
		const node = parsed.nodes.find(n => n.id === nodeId);
		if (!node) {
			return { ok: false, error: `Node "${nodeId}" not found in Mission "${initialRec.id}".` };
		}
		const initialState = this.ensureSynchronizedState(initialRec);
		const initialExisting = initialState.boundary.nodeAssignments[nodeId];
		const hostAlias = (options.hostAlias?.trim() || 'local');
		let remoteProjectPath = options.remoteProjectPath?.trim() || initialExisting?.remoteProjectPath;

		let resolvedUri: URI | undefined;
		if (hostAlias !== 'local') {
			const host = await this.cloudHostService?.getHost(hostAlias).catch(() => undefined);
			if (host && !remoteProjectPath) {
				remoteProjectPath = host.defaultDirectory || host.recentDirectories[0] || '/';
			}
			resolvedUri = buildCloudProjectUri(host?.alias ?? hostAlias, remoteProjectPath || '/', host?.os);
		} else if (initialRec.projectUri) {
			resolvedUri = URI.parse(initialRec.projectUri);
			remoteProjectPath = undefined;
		}

		// Re-read freshest runtime state AFTER awaiting cloudHostService to avoid lost updates on concurrent token transitions!
		const freshRec = this.requireMission(missionId);
		const freshState = this.ensureSynchronizedState(freshRec);
		const existing = freshState.boundary.nodeAssignments[nodeId];
		const targetAgentId = options.agentId?.trim() || existing?.agentId;
		if (targetAgentId && resolvedUri && this.projectsService?.updateAgentEnginePreferences) {
			this.projectsService.updateAgentEnginePreferences(targetAgentId, { projectUri: resolvedUri });
		}
		const targetAgent = targetAgentId ? this.projectsService?.getAgent(targetAgentId) : undefined;
		const resolvedTier = targetAgent
			? resolveEffectiveRankDefinition(this.orgConfig, targetAgent.role, this.projectsService?.hasSubordinates(targetAgent.id) ?? false).tier
			: (existing?.tier ?? Math.min(this.orgConfig.ranks.length, Math.max(1, freshState.boundary.offGraphMaxTier + 1)));

		const updatedAssignment: IMissionNodeAssignment = {
			agentId: targetAgentId,
			tier: resolvedTier,
			roleKind: options.roleKind ?? existing?.roleKind ?? 'worker',
			hostAlias,
			...(hostAlias !== 'local' && remoteProjectPath ? { remoteProjectPath } : {}),
		};
		const nextState: IMissionRuntimeState = {
			...freshState,
			boundary: {
				...freshState.boundary,
				nodeAssignments: {
					...freshState.boundary.nodeAssignments,
					[nodeId]: updatedAssignment,
				},
			},
			updatedAt: Date.now(),
		};
		this.commitState(freshRec.id, nextState);
		return { ok: true, assignment: updatedAssignment };
	}

	getCurrentTokens(agentId: string, missionId?: string): readonly IMissionToken[] {
		const missions = missionId
			? [this.missionService?.getMission(missionId) ?? this.missionService?.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: (this.missionService?.listMissions() ?? []);
		const out: IMissionToken[] = [];
		for (const rec of missions) {
			const state = this.ensureSynchronizedState(rec);
			for (const tok of Object.values(state.tokens)) {
				const assignedAgent = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				const matchesHolder = tok.holderAgentId === agentId || assignedAgent === agentId;
				if (matchesHolder && (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'frozen_failed' || tok.status === 'waiting_gate')) {
					out.push(tok);
				}
			}
		}
		return out;
	}

	expandTrace(missionId: string, tracePtr: string, maxEntries = 100): readonly IMissionTraceNode[] {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		return expandTracePointer(state, tracePtr, maxEntries);
	}

	private computeEffectiveNodeChecks(
		rec: IAdeMissionRecord,
		parsed = parseMissionMermaidDag(rec.mermaidText),
		onlyNodeId?: string,
	): Record<string, readonly IMissionNodeCheckHook[]> {
		const out: Record<string, readonly IMissionNodeCheckHook[]> = {};
		const nodeIds = onlyNodeId
			? [onlyNodeId]
			: [...new Set([
				...parsed.nodes.filter(n => n.kind === 'task').map(n => n.id),
				...Object.keys(rec.nodeChecks ?? {}),
			])];

		for (const nid of nodeIds) {
			const dagNode = parsed.nodes.find(n => n.id === nid);
			if (dagNode?.kind === 'gate') {
				continue;
			}
			const mermaidHooks = dagNode?.checks ?? [];
			const configHooks = rec.nodeChecks?.[nid] ?? [];
			const mergedById = new Map<string, IMissionNodeCheckHook>();
			for (const mh of mermaidHooks) {
				mergedById.set(mh.id, mh);
			}
			for (const ch of configHooks) {
				mergedById.set(ch.id, ch);
			}
			const combined = [...mergedById.values()];
			if (combined.length > 0) {
				out[nid] = combined;
			}
		}
		return out;
	}

	getEffectiveNodeChecks(missionId: string, nodeId?: string): Readonly<Record<string, readonly IMissionNodeCheckHook[]>> {
		const rec = this.requireMission(missionId);
		return this.computeEffectiveNodeChecks(rec, parseMissionMermaidDag(rec.mermaidText), nodeId);
	}

	private resolveCheckExecutionTarget(
		rec: IAdeMissionRecord,
		state: IMissionRuntimeState,
		nodeId: string,
		hook: IMissionNodeCheckHook,
	): { readonly hostAlias: string; readonly cwd?: string } {
		const assignment = state.boundary.nodeAssignments[nodeId];
		const agent = assignment?.agentId ? this.projectsService?.getAgent(assignment.agentId) : undefined;
		const hostAlias = hook.hostAlias?.trim()
			|| assignment?.hostAlias?.trim()
			|| (agent?.projectUri.scheme === 'aexus-ssh' ? agent.projectUri.authority : 'local');
		const isRemote = hostAlias !== 'local';

		let baseDir: string | undefined;
		if (isRemote) {
			baseDir = assignment?.remoteProjectPath?.trim()
				|| (agent?.projectUri.scheme === 'aexus-ssh' ? agent.projectUri.path : undefined);
		} else if (agent?.projectUri.scheme === 'file') {
			baseDir = agent.projectUri.fsPath;
		} else if (rec.projectUri) {
			const parsedUri = URI.parse(rec.projectUri);
			if (parsedUri.scheme === 'file') {
				baseDir = parsedUri.fsPath;
			}
		}

		const rawCwd = hook.cwd?.trim();
		let cwd: string | undefined;
		if (!rawCwd) {
			cwd = baseDir;
		} else if (isRemote) {
			cwd = rawCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawCwd)
				? rawCwd
				: (baseDir ? path.posix.join(baseDir, rawCwd) : rawCwd);
		} else {
			cwd = path.isAbsolute(rawCwd)
				? rawCwd
				: (baseDir ? path.join(baseDir, rawCwd) : rawCwd);
		}
		return { hostAlias, cwd };
	}

	async runNodeChecks(
		missionId: string,
		nodeId: string,
		options?: { readonly checkIds?: readonly string[] },
	): Promise<IMissionNodeCheckSuiteResult> {
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const allHooks = this.computeEffectiveNodeChecks(rec, parseMissionMermaidDag(rec.mermaidText), nodeId)[nodeId] ?? [];
		const filterSet = options?.checkIds && options.checkIds.length > 0 ? new Set(options.checkIds) : undefined;
		const enabledHooks = allHooks.filter(h => h.enabled !== false && (!filterSet || filterSet.has(h.id)));

		if (enabledHooks.length === 0) {
			return {
				nodeId,
				passed: true,
				totalDurationMs: 0,
				results: [],
				summary: `No enabled deterministic checks configured for node ${nodeId}.`,
			};
		}

		const backend = this.backendService;
		const results: IMissionNodeCheckExecutionResult[] = [];
		let totalDurationMs = 0;
		let allPassed = true;

		for (const hook of enabledHooks) {
			const target = this.resolveCheckExecutionTarget(rec, state, nodeId, hook);
			let res: IMissionNodeCheckExecutionResult;
			if (!backend?.runDeterministicCheck) {
				res = {
					checkId: hook.id,
					...(hook.name ? { name: hook.name } : {}),
					...(hook.command ? { command: hook.command } : {}),
					hostAlias: target.hostAlias,
					...(target.cwd ? { cwd: target.cwd } : {}),
					passed: false,
					exitCode: -1,
					expectedExitCode: hook.expectExitCode ?? 0,
					durationMs: 0,
					outputTail: '',
					error: 'Deterministic check backend service is unavailable.',
				};
			} else {
				res = await backend.runDeterministicCheck({
					checkId: hook.id,
					name: hook.name,
					command: hook.command,
					expectExitCode: hook.expectExitCode,
					cwd: target.cwd,
					hostAlias: target.hostAlias,
					expectFiles: hook.expectFiles,
					expectOutputMatch: hook.expectOutputMatch,
					timeoutMs: hook.timeoutMs,
				});
			}
			results.push(res);
			totalDurationMs += res.durationMs;
			if (!res.passed) {
				allPassed = false;
				// Fail-fast in declared hook order (e.g. skip test suite when build/typecheck already failed)
				break;
			}
		}

		const summary = allPassed
			? `[Verified: ${results.map(r => `${r.name || r.command || r.checkId} (ok, ${r.durationMs}ms)`).join('; ')}]`
			: (() => {
				const failed = results.find(r => !r.passed)!;
				return `[Check Failed: ${failed.name || failed.command || failed.checkId} — ${failed.error || `exit ${failed.exitCode}`}]`;
			})();

		return {
			nodeId,
			passed: allPassed,
			totalDurationMs,
			results,
			summary,
		};
	}

	async completeToken(missionId: string, params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string; readonly skipChecks?: boolean }): Promise<IMissionEngineTransitionResult> {
		const initialRec = this.requireMission(missionId);
		const initialGraph = parseMissionMermaidDag(initialRec.mermaidText);
		const initialState = this.ensureSynchronizedState(initialRec);

		// Validate basic preconditions & holder authority BEFORE executing any shell verification hook!
		if (initialState.status !== 'running' && initialState.status !== 'paused') {
			return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: `Mission is "${initialState.status}", not running.` };
		}
		const initialToken = initialState.tokens[params.tokenId];
		if (!initialToken || (initialToken.status !== 'active' && initialToken.status !== 'blocked')) {
			return { ok: false, state: initialState, effects: [], code: 'NOT_FOUND', error: `Active token "${params.tokenId}" not found.` };
		}
		if (params.callerAgentId !== undefined) {
			const assignedHolder = initialState.boundary.nodeAssignments[initialToken.nodeId]?.agentId ?? initialToken.holderAgentId;
			if (!assignedHolder || assignedHolder !== params.callerAgentId) {
				return { ok: false, state: initialState, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
			}
		}
		if (!params.summary.trim()) {
			return { ok: false, state: initialState, effects: [], code: 'INVALID_STATE', error: 'A concrete plain-text summary is required to complete a token.' };
		}

		const nodeHooks = (this.computeEffectiveNodeChecks(initialRec, initialGraph, initialToken.nodeId)[initialToken.nodeId] ?? [])
			.filter(h => h.enabled !== false);
		const allowSkip = Boolean(params.skipChecks && params.callerAgentId === undefined);

		let verificationNote: string | undefined;
		let checkSuite: IMissionNodeCheckSuiteResult | undefined;

		if (nodeHooks.length > 0 && !allowSkip) {
			const lockKey = `${initialRec.id}:${params.tokenId}`;
			if (this.inFlightCheckTokens.has(lockKey)) {
				return {
					ok: false,
					state: initialState,
					effects: [],
					code: 'INVALID_STATE',
					error: `Deterministic verification is already running for token "${params.tokenId}". Wait for it to finish.`,
				};
			}
			this.inFlightCheckTokens.add(lockKey);
			const activeHolderId = initialState.boundary.nodeAssignments[initialToken.nodeId]?.agentId ?? initialToken.holderAgentId;
			if (activeHolderId) {
				this.touchAgentActivity(activeHolderId, Date.now());
			}
			try {
				checkSuite = await this.runNodeChecks(initialRec.id, initialToken.nodeId);
			} finally {
				this.inFlightCheckTokens.delete(lockKey);
				if (activeHolderId) {
					this.touchAgentActivity(activeHolderId, Date.now());
				}
			}

			// Re-read freshest Mission state AFTER awaiting deterministic checks (avoid lost updates or stale completion after stop/recall!)
			const freshRec = this.requireMission(initialRec.id);
			const freshGraph = parseMissionMermaidDag(freshRec.mermaidText);
			const freshState = this.ensureSynchronizedState(freshRec);
			const failedResult = checkSuite.results.find(r => !r.passed);
			const failedHook = failedResult ? nodeHooks.find(h => h.id === failedResult.checkId) : nodeHooks[0];

			const checkTransition = recordTokenCheckResult(freshState, freshGraph, {
				tokenId: params.tokenId,
				suiteResult: checkSuite,
				onFail: failedHook?.onFail ?? 'bounce',
				maxAutoRetries: failedHook?.maxAutoRetries ?? 2,
				callerAgentId: params.callerAgentId,
				owner: { ownerSessionId: freshRec.ownerSessionId, ownerTier: freshRec.ownerTier },
			});
			this.commitState(freshRec.id, checkTransition.state);
			if (checkTransition.effects.length > 0) {
				await this.executeEffects(freshRec, checkTransition.effects);
			}
			if (!checkTransition.ok) {
				return checkTransition;
			}
			verificationNote = checkSuite.summary;
		}

		const latestRec = this.requireMission(initialRec.id);
		const latestGraph = parseMissionMermaidDag(latestRec.mermaidText);
		const result = completeMissionToken(this.ensureSynchronizedState(latestRec), latestGraph, {
			tokenId: params.tokenId,
			summary: params.summary,
			callerAgentId: params.callerAgentId,
			...(verificationNote ? { verificationNote } : {}),
		});
		if (result.ok) {
			this.commitState(latestRec.id, result.state);
			await this.executeEffects(latestRec, result.effects);
			if (checkSuite) {
				return {
					...result,
					data: {
						...(result.data as Record<string, unknown> ?? {}),
						verified: true,
						checkSuite,
					},
				};
			}
		}
		return result;
	}

	async rejectToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly targetNodeId?: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = rejectMissionToken(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async blockToken(missionId: string, params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDuration: string | number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
	}): Promise<IMissionEngineTransitionResult> {
		const initialRec = this.requireMission(missionId);
		const initialState = this.ensureSynchronizedState(initialRec);
		const durationMs = parseDurationMs(params.maxDuration);
		if (!durationMs) {
			return {
				ok: false,
				state: initialState,
				effects: [],
				code: 'INVALID_STATE',
				error: `Invalid maxDuration "${String(params.maxDuration)}". Use formats like "30m", "2h", "10h", or milliseconds.`,
			};
		}
		const initialToken = initialState.tokens[params.tokenId];
		const inferredHost = params.hostAlias
			?? (initialToken ? initialState.boundary.nodeAssignments[initialToken.nodeId]?.hostAlias : undefined);

		// Capture baseline mtime directly on the target host at block time so remote clock skew / 1s truncation
		// never causes `--watch-file` / `--wake-on-file` to miss a newly written output file.
		let initialFileMtime: number | null | undefined;
		if (params.watchFile?.trim() && this.backendService?.probeFileMtime) {
			let probeTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				initialFileMtime = await Promise.race([
					this.backendService.probeFileMtime(inferredHost || 'local', params.watchFile.trim()).catch(() => undefined),
					new Promise<undefined>(resolve => {
						probeTimer = setTimeout(() => resolve(undefined), 4_000);
					}),
				]);
			} finally {
				if (probeTimer !== undefined) {
					clearTimeout(probeTimer);
				}
			}
		}

		// Re-read freshest runtime state after async remote mtime probe to avoid clobbering concurrent token transitions.
		const freshRec = this.requireMission(missionId);
		const freshState = this.ensureSynchronizedState(freshRec);
		const result = blockMissionToken(freshState, {
			tokenId: params.tokenId,
			reason: params.reason,
			maxDurationMs: durationMs,
			watchPid: params.watchPid,
			watchFile: params.watchFile,
			...(initialFileMtime !== undefined ? { initialFileMtime } : {}),
			hostAlias: inferredHost,
			callerAgentId: params.callerAgentId,
		});
		if (result.ok) {
			this.commitState(freshRec.id, result.state);
		}
		return result;
	}

	async failToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = failMissionToken(this.ensureSynchronizedState(rec), graph, {
			...params,
			owner: { ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async retryToken(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly tokenId?: string; readonly nodeId?: string; readonly guidance?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = retryMissionToken(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async escalate(missionId: string, params: { readonly callerSupervisorId: string; readonly reason: string; readonly tokenId?: string; readonly nodeId?: string; readonly isSecretary?: boolean; readonly isHumanUser?: boolean }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const result = escalateMissionIssue(this.ensureSynchronizedState(rec), {
			...params,
			ownerSessionId: rec.ownerSessionId,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly tokenId?: string; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = resolveMissionGate(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			// Mark matching unresolved Inbox gate todos resolved when no queued wave remains (or for the resolved token).
			const inbox = this.inboxService;
			if (inbox) {
				const resolvedData = result.data as { readonly resolvedTokenId?: string; readonly remainingQueuedGateCount?: number } | undefined;
				const remainingQueued = resolvedData?.remainingQueuedGateCount ?? 0;
				const openGates = inbox.list({ includeResolved: false }).filter(item =>
					item.kind === 'user_gate'
					&& item.nodeId === params.nodeId
					&& (item.governorSessionId === rec.ownerSessionId || item.governorSessionId === rec.id)
				);
				const resolutionText = `${params.decision}${params.note ? `: ${params.note}` : ''}`;
				for (const openGate of openGates) {
					if (remainingQueued === 0 || !resolvedData?.resolvedTokenId || openGate.message.includes(resolvedData.resolvedTokenId)) {
						await inbox.resolveItem(openGate.id, resolutionText).catch(() => undefined);
					}
				}
			}
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async recoverInterruptedActiveTokens(missionId?: string): Promise<number> {
		const missions = this.missionService;
		const projects = this.projectsService;
		if (!missions || !projects || !this.commandService) {
			return 0;
		}
		const targetRecords = missionId
			? [missions.getMission(missionId) ?? missions.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: missions.listMissions();
		let resumedCount = 0;
		for (const rec of targetRecords) {
			if (rec.runtime?.status !== 'running') {
				continue;
			}
			// On automatic startup recovery (missionId omitted), skip Missions currently owned by another
			// live Electron window so opening a second window never injects duplicate turns into live agents!
			if (!missionId && this.backendService?.canRecoverMission) {
				const canRecover = await this.backendService.canRecoverMission(rec.id).catch(() => true);
				if (!canRecover) {
					continue;
				}
			}
			const state = this.ensureSynchronizedState(rec);
			const graph = parseMissionMermaidDag(rec.mermaidText);
			const recoveredTokenIds: string[] = [];
			for (const tok of Object.values(state.tokens)) {
				if (tok.status !== 'active') {
					continue;
				}
				const targetAgentId = state.boundary.nodeAssignments[tok.nodeId]?.agentId ?? tok.holderAgentId;
				if (!targetAgentId) {
					continue;
				}
				if ((this.activeTurnsByAgent.get(targetAgentId) ?? 0) > 0) {
					continue;
				}
				const dedupeKey = `recover:${rec.id}:${tok.id}`;
				const queued = this.pendingDispatchesByAgent.get(targetAgentId);
				if (queued?.some(item => item.options?.tokenId === tok.id && item.options?.missionId === rec.id)) {
					continue;
				}
				const agent = projects.getAgent(targetAgentId);
				if (!agent) {
					continue;
				}
				const isRemoteAgent = agent.projectUri.scheme === AEXUS_SSH_SCHEME;
				const dagNode = graph.nodes.find(n => n.id === tok.nodeId);
				const nodeLabel = dagNode?.label ?? tok.nodeId;
				const nodePrePrompt = rec.nodePrompts?.[tok.nodeId];
				const basePrompt = [
					`[IDE Restart Auto-Recovery · Node \`${tok.nodeId}\` (${nodeLabel}) · Token \`${tok.id}\`]`,
					`Aexus Code restarted while you held active token \`${tok.id}\` (wave \`${tok.waveId}\`).`,
					`Inspect your workspace (preserve any deliverables already written), complete remaining work and checks, and close the token via \`aexus-ade token complete ${tok.id} --summary "..."\` (or \`token block\` / \`token fail\`).`,
					tok.lastSummary ? `\n### Previous Step Summary (\`last_summary\`)\n${tok.lastSummary}` : '',
				].filter(Boolean).join('\n');
				const recoveryPrompt = composeMissionNodeWakeupPrompt(basePrompt, nodePrePrompt);
				const dispatched = await this.dispatchPromptToAgent(targetAgentId, recoveryPrompt, {
					autonomousApproved: true,
					missionId: rec.id,
					tokenId: tok.id,
					nodeId: tok.nodeId,
					dedupeKey,
					...(isRemoteAgent ? { preferReattach: true } : {}),
				});
				if (dispatched) {
					resumedCount++;
					this.inMemoryAgentActivityAt.set(targetAgentId, Date.now());
					recoveredTokenIds.push(tok.id);
				}
			}
			// Re-read freshest runtime AFTER awaits so concurrent completions/pauses/stops are never overwritten.
			if (recoveredTokenIds.length > 0) {
				const latestRec = missions.getMission(rec.id);
				if (latestRec?.runtime?.status === 'running') {
					const latestState = this.ensureSynchronizedState(latestRec);
					const now = Date.now();
					let updatedTokens: Record<string, IMissionToken> | undefined;
					for (const tid of recoveredTokenIds) {
						const liveTok = latestState.tokens[tid];
						if (liveTok?.status === 'active') {
							updatedTokens ??= { ...latestState.tokens };
							updatedTokens[tid] = { ...liveTok, lastActivityAt: now };
						}
					}
					if (updatedTokens) {
						this.commitState(latestRec.id, { ...latestState, tokens: updatedTokens, updatedAt: now });
					}
				}
			}
		}
		return resumedCount;
	}

	async recallTokens(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly nodeIds?: readonly string[]; readonly branchRootNodeId?: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = recallMissionTokens(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
		return result;
	}

	async patchMermaid(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly newMermaidText: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = applySafeMissionPatch(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			// Apply new Mermaid first so locked sidebar employees are created for any added nodes,
			// then synchronize runtime assignments/tokens and hydrate newly minted dispatch effects before executing!
			this.missionService?.updateMermaid(rec.id, params.newMermaidText);
			const refreshed = this.requireMission(rec.id);
			const nextGraph = parseMissionMermaidDag(params.newMermaidText);
			const synchronizedBase = this.ensureSynchronizedState({ ...refreshed, runtime: result.state });
			const withBaseline = (synchronizedBase.revisions?.length ?? 0) === 0
				? appendMissionDagRevision(synchronizedBase, rec.mermaidText, 'Initial topology (v1)', undefined, graph)
				: synchronizedBase;
			const synchronized = appendMissionDagRevision(
				withBaseline,
				params.newMermaidText,
				params.reason ?? 'Dynamic DAG patch',
				graph,
				nextGraph,
			);
			this.commitState(rec.id, synchronized);
			const latest = this.requireMission(rec.id);
			const hydratedEffects: MissionEngineEffect[] = result.effects
				.filter(e => e.kind !== 'mermaid_patched')
				.map(eff => {
					if (eff.kind === 'dispatch_token' || eff.kind === 'wakeup_agent') {
						const boundAgentId = synchronized.boundary.nodeAssignments[eff.nodeId]?.agentId
							?? synchronized.tokens[eff.tokenId]?.holderAgentId
							?? eff.holderAgentId;
						return boundAgentId !== eff.holderAgentId ? { ...eff, holderAgentId: boundAgentId } : eff;
					}
					return eff;
				});
			await this.executeEffects(latest, hydratedEffects);
			return { ...result, state: synchronized, effects: hydratedEffects };
		}
		return result;
	}

	listTriggers(missionId: string): readonly IMissionSourceTrigger[] {
		const rec = this.requireMission(missionId);
		return this.ensureSynchronizedState(rec).triggers;
	}

	async setTrigger(
		missionId: string,
		triggerInput: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: IMissionSourceTrigger['kind'] },
		caller: IMissionEngineCaller,
	): Promise<{ readonly ok: boolean; readonly trigger?: IMissionSourceTrigger; readonly error?: string; readonly code?: string }> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);

		const jurisdiction = resolveSupervisorJurisdiction(
			state.boundary,
			caller.sessionId ?? '',
			graph.nodes.map(n => n.id),
			{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: rec.ownerSessionId },
		);
		if (!jurisdiction.hasFullJurisdiction && !jurisdiction.nodeIds.has(triggerInput.nodeId)) {
			return {
				ok: false,
				code: 'OUT_OF_JURISDICTION',
				error: `Caller lacks off-graph jurisdiction to configure triggers on source node "${triggerInput.nodeId}".`,
			};
		}

		const candidate: IMissionSourceTrigger = {
			id: triggerInput.id?.trim() || `trig-${generateUuid().slice(0, 8)}`,
			nodeId: triggerInput.nodeId.trim(),
			kind: triggerInput.kind,
			enabled: triggerInput.enabled !== false,
			...(triggerInput.fireAt !== undefined ? { fireAt: triggerInput.fireAt } : {}),
			...(triggerInput.intervalMs !== undefined ? { intervalMs: triggerInput.intervalMs } : {}),
			...(triggerInput.cronExpr ? { cronExpr: triggerInput.cronExpr.trim() } : {}),
			...(triggerInput.eventType ? { eventType: triggerInput.eventType } : {}),
			...(triggerInput.targetPath ? { targetPath: triggerInput.targetPath.trim() } : {}),
			...(triggerInput.hostAlias ? { hostAlias: triggerInput.hostAlias.trim() } : {}),
			...(triggerInput.gpuUtilThresholdPct !== undefined ? { gpuUtilThresholdPct: triggerInput.gpuUtilThresholdPct } : {}),
			...(triggerInput.autoStartOnMissionStart !== undefined ? { autoStartOnMissionStart: triggerInput.autoStartOnMissionStart } : {}),
			lastFiredAt: triggerInput.lastFiredAt,
			fireCount: triggerInput.fireCount ?? 0,
		};

		const validationErr = validateSourceTrigger(graph, candidate);
		if (validationErr) {
			return { ok: false, code: 'INVALID_DAG', error: validationErr };
		}

		const existingIdx = state.triggers.findIndex(t => t.id === candidate.id);
		const nextTriggers = existingIdx >= 0
			? state.triggers.map((t, idx) => idx === existingIdx ? candidate : t)
			: [...state.triggers, candidate];
		const nextState: IMissionRuntimeState = {
			...state,
			triggers: nextTriggers,
			updatedAt: Date.now(),
		};
		this.commitState(rec.id, nextState);
		return { ok: true, trigger: candidate };
	}

	async removeTrigger(
		missionId: string,
		triggerId: string,
		caller: IMissionEngineCaller,
	): Promise<{ readonly ok: boolean; readonly removedId?: string; readonly error?: string; readonly code?: string }> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const existing = state.triggers.find(t => t.id === triggerId);
		if (!existing) {
			return { ok: false, code: 'NOT_FOUND', error: `Trigger "${triggerId}" not found.` };
		}
		const jurisdiction = resolveSupervisorJurisdiction(
			state.boundary,
			caller.sessionId ?? '',
			graph.nodes.map(n => n.id),
			{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: rec.ownerSessionId },
		);
		if (!jurisdiction.hasFullJurisdiction && !jurisdiction.nodeIds.has(existing.nodeId)) {
			return {
				ok: false,
				code: 'OUT_OF_JURISDICTION',
				error: `Caller lacks off-graph jurisdiction to remove trigger "${triggerId}" on node "${existing.nodeId}".`,
			};
		}
		const nextState: IMissionRuntimeState = {
			...state,
			triggers: state.triggers.filter(t => t.id !== triggerId),
			updatedAt: Date.now(),
		};
		this.commitState(rec.id, nextState);
		return { ok: true, removedId: triggerId };
	}

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp = Date.now()): void {
		const projects = this.projectsService;
		const missions = this.missionService;
		if (!projects || !missions || !sessionResourceOrAgentId) {
			return;
		}
		const agent = projects.getAgent(sessionResourceOrAgentId)
			?? projects.agents.find(a => a.session?.resource.toString() === sessionResourceOrAgentId);
		if (!agent) {
			return;
		}
		// Keep activity timestamps strictly in memory and forward throttled updates to the watchdog daemon
		// without rewriting full Mission storage every 5s.
		this.inMemoryAgentActivityAt.set(agent.id, timestamp);
		const lastSync = this.lastHeartbeatSyncAt.get(agent.id) ?? 0;
		if (timestamp - lastSync < 5_000) {
			return;
		}
		this.lastHeartbeatSyncAt.set(agent.id, timestamp);

		for (const rec of missions.listMissions()) {
			if (rec.runtime?.status !== 'running') {
				continue;
			}
			const hasActiveForAgent = Object.values(rec.runtime.tokens).some(tok => {
				const assigned = rec.runtime!.boundary.nodeAssignments[tok.nodeId]?.agentId;
				return tok.status === 'active' && (tok.holderAgentId === agent.id || assigned === agent.id);
			});
			if (hasActiveForAgent) {
				this.syncWatchdog(rec.id, rec.runtime);
			}
		}
	}

	recordNodeTurnUsage(missionId: string, nodeId: string, usage: IMissionTurnUsageInput): void {
		const missions = this.missionService;
		if (!missions || !missionId || !nodeId) {
			return;
		}
		const rec = missions.getMission(missionId);
		const state = rec?.runtime;
		if (!rec || !state) {
			return;
		}
		const nextState = recordMissionNodeTurnUsage(state, nodeId, usage);
		const trippedNow = Boolean(nextState.budgetCircuitTripped && !state.budgetCircuitTripped);
		this.commitState(rec.id, nextState, trippedNow ? undefined : { deferPersist: true, skipWatchdogSync: true });
		if (trippedNow) {
			void this.stopActiveAgentsOnBudgetTrip(nextState);
			this.notifyBudgetCircuitTripped(rec, nextState);
		}
	}

	recordTurnUsageBySessionResource(sessionResource: string, usage: IMissionTurnUsageInput): void {
		const projects = this.projectsService;
		const missions = this.missionService;
		if (!projects || !missions || !sessionResource) {
			return;
		}
		const agent = projects.getAgent(sessionResource)
			?? projects.agents.find(a => a.session?.resource.toString() === sessionResource);
		if (!agent) {
			return;
		}
		for (const rec of missions.listMissions()) {
			const state = rec.runtime;
			if (!state || state.status === 'completed' || state.status === 'stopped' || state.status === 'failed') {
				continue;
			}
			// Prefer the currently active token held by this employee; while running, never bleed into idle/skipped sibling nodes
			// (e.g., an unexecuted on_fail node owned by the same employee).
			const activeTok = Object.values(state.tokens).find(tok => {
				const assigned = state.boundary.nodeAssignments[tok.nodeId]?.agentId;
				return tok.status === 'active' && (tok.holderAgentId === agent.id || assigned === agent.id);
			});
			const assignedNodes = Object.entries(state.boundary.nodeAssignments)
				.filter(([, assign]) => assign.agentId === agent.id)
				.map(([nid]) => nid);
			const targetNodeIds = activeTok
				? [activeTok.nodeId]
				: (assignedNodes.length > 0 ? [assignedNodes[0]] : []);
			if (targetNodeIds.length === 0) {
				continue;
			}
			let nextState = state;
			for (const nid of targetNodeIds) {
				nextState = recordMissionNodeTurnUsage(nextState, nid, usage);
			}
			const trippedNow = Boolean(nextState.budgetCircuitTripped && !state.budgetCircuitTripped);
			this.commitState(rec.id, nextState, trippedNow ? undefined : { deferPersist: true, skipWatchdogSync: true });
			if (trippedNow) {
				void this.stopActiveAgentsOnBudgetTrip(nextState);
				this.notifyBudgetCircuitTripped(rec, nextState);
			}
			if (activeTok) {
				break;
			}
		}
	}

	private async handleWatchdogWakeup(ev: IAdeWatchdogWakeupEvent): Promise<void> {
		const rec = this.missionService?.getMission(ev.missionId);
		if (!rec || rec.runtime?.status !== 'running') {
			return;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = recordWatchdogWakeup(rec.runtime, {
			tokenId: ev.tokenId,
			reason: ev.reason,
			detail: ev.detail,
			graph,
			owner: { ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
			now: ev.timestamp,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
	}

	private async handleSourceTriggerFire(ev: IAdeSourceTriggerFireEvent): Promise<void> {
		const rec = this.missionService?.getMission(ev.missionId);
		if (!rec || rec.runtime?.status !== 'running') {
			return;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = fireMissionSourceTrigger(rec.runtime, graph, {
			triggerId: ev.triggerId,
			payloadSummary: ev.detail,
			now: ev.timestamp,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
		}
	}

	private async ensureAgentSessionReady(agent: IAdeAgent): Promise<URI | undefined> {
		if (agent.session?.resource) {
			return agent.session.resource;
		}
		const sessions = this.sessionsService;
		const projects = this.projectsService;
		if (!sessions || !projects) {
			return undefined;
		}
		const available = await sessions.getEngines(agent.projectUri).catch(() => []);
		const engineId = agent.preferredEngineId || available[0]?.id;
		if (!engineId) {
			return undefined;
		}
		const created = await sessions.create(engineId, agent.projectUri).catch(() => undefined);
		if (!created) {
			return undefined;
		}
		projects.bindSession(agent.id, created);
		return created.resource;
	}

	private isTransientDispatchError(errMsg: string): boolean {
		return /\b(502|503|504|429|520|522|524)\b|upstream connection failed|urlerror|tls handshake timeout|econnreset|etimedout|econnrefused|epipe|socket hang up|context deadline exceeded|temporarily unavailable|overloaded|rate limit|network error|\beof\b|exited with code 255|exit code 255|broken pipe|connection closed by remote host|client_loop|ssh_exchange_identification|kex_exchange_identification|network is unreachable|no route to host|host is down|connection timed out/i.test(errMsg);
	}

	private flushNextQueuedDispatch(agentId: string): void {
		if ((this.activeTurnsByAgent.get(agentId) ?? 0) > 0) {
			return;
		}
		const queue = this.pendingDispatchesByAgent.get(agentId);
		if (!queue || queue.length === 0) {
			return;
		}
		const deferredPaused: typeof queue = [];
		while (queue.length > 0) {
			const next = queue.shift()!;
			if (next.options?.missionId && next.options?.tokenId) {
				const rec = this.missionService?.getMission(next.options.missionId);
				const tok = rec?.runtime?.tokens[next.options.tokenId];
				if (!rec || !tok || tok.status !== 'active') {
					continue;
				}
				if (rec.runtime?.status === 'paused') {
					// Preserve queued turns for paused Missions so resume() dispatches them immediately.
					deferredPaused.push(next);
					continue;
				}
				if (rec.runtime?.status !== 'running') {
					continue;
				}
			}
			if (deferredPaused.length > 0) {
				queue.unshift(...deferredPaused);
			}
			if (queue.length === 0) {
				this.pendingDispatchesByAgent.delete(agentId);
			}
			void this.dispatchPromptToAgent(agentId, next.prompt, next.options).then(dispatched => {
				if (dispatched) {
					return;
				}
				if (next.options?.onDispatchError) {
					next.options.onDispatchError(`Queued dispatch failed: agent "${agentId}" or its session is unavailable.`);
				} else if (next.options?.missionId && next.options?.tokenId) {
					void this.failToken(next.options.missionId, {
						tokenId: next.options.tokenId,
						reason: `Unable to dispatch queued token ${next.options.tokenId} on node ${next.options.nodeId ?? ''} (agent "${agentId}" unavailable).`,
					}).catch(() => undefined);
				}
			}, err => {
				const reason = err instanceof Error ? err.message : String(err ?? 'Queued dispatch error');
				if (next.options?.onDispatchError) {
					next.options.onDispatchError(reason);
				} else if (next.options?.missionId && next.options?.tokenId) {
					void this.failToken(next.options.missionId, {
						tokenId: next.options.tokenId,
						reason: `Queued dispatch error on node ${next.options.nodeId ?? ''}: ${reason.slice(0, 300)}`,
					}).catch(() => undefined);
				}
			});
			return;
		}
		if (deferredPaused.length > 0) {
			this.pendingDispatchesByAgent.set(agentId, deferredPaused);
		} else {
			this.pendingDispatchesByAgent.delete(agentId);
		}
	}

	private async dispatchPromptToAgent(
		agentId: string | undefined,
		prompt: string,
		options?: {
			readonly autonomousApproved?: boolean;
			readonly missionId?: string;
			readonly tokenId?: string;
			readonly nodeId?: string;
			readonly requireLiveDelivery?: boolean;
			readonly dedupeKey?: string;
			readonly retryAttempt?: number;
			readonly preferReattach?: boolean;
			readonly onDispatchError?: (reason: string) => void;
		},
	): Promise<boolean> {
		if (!agentId || !this.projectsService || !this.commandService) {
			return false;
		}
		if (agentId === ADE_SECRETARY_ID) {
			const secSession = this.projectsService.secretary.session;
			if (!secSession) {
				this.projectsService.setSecretaryDraft(prompt);
				// Never hide critical escalations behind an unread draft when a live delivery is required.
				return options?.requireLiveDelivery ? false : true;
			}
			void this.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', secSession.resource, prompt, {
				agentId: ADE_SECRETARY_ID,
				pureWorker: false,
				callerRole: 'secretary',
				autonomousApproved: options?.autonomousApproved ?? true,
			}).catch(err => {
				const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown Secretary dispatch error');
				options?.onDispatchError?.(errMsg);
			});
			return true;
		}
		const agent = this.projectsService.getAgent(agentId);
		if (!agent) {
			return false;
		}
		const trackedMissionId = options?.missionId;
		const trackedTokenId = options?.tokenId;
		const trackedNodeId = options?.nodeId;
		const dedupeKey = options?.dedupeKey ?? (trackedMissionId && trackedTokenId ? `${trackedMissionId}:${trackedTokenId}` : undefined);

		const enqueueForAgent = () => {
			const queue = this.pendingDispatchesByAgent.get(agent.id) ?? [];
			const alreadyQueued = dedupeKey
				? queue.some(item => (item.options?.dedupeKey ?? (item.options?.missionId && item.options?.tokenId ? `${item.options.missionId}:${item.options.tokenId}` : undefined)) === dedupeKey)
				: false;
			if (!alreadyQueued) {
				queue.push({ prompt, options });
				this.pendingDispatchesByAgent.set(agent.id, queue);
			}
		};

		// Serialize ALL dispatches onto the same agent (both multi-position Mission tokens AND concurrent
		// supervisor/Governor escalations!) so a second arrival NEVER force-cancels an in-flight turn.
		if ((this.activeTurnsByAgent.get(agent.id) ?? 0) > 0) {
			enqueueForAgent();
			return true;
		}

		// Reserve the agent's slot BEFORE awaiting async session creation so concurrent calls arriving
		// within milliseconds (e.g., two parallel nodes failing simultaneously) queue cleanly instead of racing!
		this.activeTurnsByAgent.set(agent.id, 1);
		let slotClaimed = true;
		const releaseSlot = () => {
			if (!slotClaimed) {
				return;
			}
			slotClaimed = false;
			const remaining = Math.max(0, (this.activeTurnsByAgent.get(agent.id) ?? 1) - 1);
			if (remaining === 0) {
				this.activeTurnsByAgent.delete(agent.id);
				this.projectsService?.setAgentStatus(agent.id, 'idle');
				this.flushNextQueuedDispatch(agent.id);
			} else {
				this.activeTurnsByAgent.set(agent.id, remaining);
			}
		};

		let resource: URI | undefined;
		try {
			resource = await this.ensureAgentSessionReady(agent);
		} catch {
			releaseSlot();
			return false;
		}
		if (!resource) {
			releaseSlot();
			return false;
		}

		// Re-validate Mission & token liveness after async session creation so stopped/paused/recalled tokens never fire stale turns.
		if (trackedMissionId && trackedTokenId) {
			const freshRec = this.missionService?.getMission(trackedMissionId);
			const freshTok = freshRec?.runtime?.tokens[trackedTokenId];
			if (!freshRec || freshRec.runtime?.status !== 'running' || !freshTok || freshTok.status !== 'active') {
				releaseSlot();
				return true;
			}
		}

		const rankDef = resolveEffectiveRankDefinition(this.orgConfig, agent.role, this.projectsService.hasSubordinates(agent.id));
		this.projectsService.setAgentStatus(agent.id, 'working');
		void this.commandService.executeCommand<{
			readonly reply?: string;
			readonly stopped?: boolean;
			readonly usage?: IMissionTurnUsageInput;
		} | undefined>('aexus.agentEngines.dispatchEngineeringTurn', resource, prompt, {
			agentId: agent.id,
			missionId: trackedMissionId,
			nodeId: trackedNodeId,
			model: agent.preferredModel,
			thinking: agent.preferredThinking,
			pureWorker: false,
			isMissionNode: Boolean(trackedNodeId || agent.treeNodeId || (agent.treeNodeIds && agent.treeNodeIds.length > 0)),
			callerRole: rankDef.id,
			autonomousApproved: options?.autonomousApproved ?? true,
			...(options?.preferReattach ? { preferReattach: true } : {}),
		}).then(
			turnRes => {
				releaseSlot();
				if (trackedMissionId && trackedTokenId) {
					this.transientRetryCount.delete(`${trackedMissionId}:${trackedTokenId}`);
				}
				if (turnRes && typeof turnRes === 'object') {
					const latestAgent = this.projectsService?.getAgent(agent.id) ?? agent;
					const conciseReply = typeof turnRes.reply === 'string' && turnRes.reply.trim()
						? turnRes.reply.trim().split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 120)
						: undefined;
					if (turnRes.usage || conciseReply) {
						const payload: IMissionTurnUsageInput = {
							...(turnRes.usage ?? {}),
							model: latestAgent.preferredModel,
							...(conciseReply ? { summary: conciseReply } : {}),
						};
						if (trackedMissionId && trackedNodeId) {
							this.recordNodeTurnUsage(trackedMissionId, trackedNodeId, payload);
						} else {
							this.recordTurnUsageBySessionResource(resource.toString(), payload);
						}
					}
				}
				// If this was a Mission node turn and the agent finished without closing its active token,
				// send a fast follow-up reminder (up to 2x) so low-thinking workers don't stall for the full silence window.
				if (trackedMissionId && trackedTokenId && trackedNodeId && !turnRes?.stopped) {
					this.scheduleUnclosedTokenCheck(trackedMissionId, trackedTokenId, trackedNodeId, agent.id);
				}
			},
			err => {
				releaseSlot();
				const errMsg = err instanceof Error ? err.message : String(err ?? 'Unknown engine dispatch error');
				const isTransient = this.isTransientDispatchError(errMsg);

				// Auto-retry transient upstream/gateway errors (502/503/504/429/URLError/TLS timeout) with exponential backoff
				// before freezing a Mission node or falling back a supervisor escalation to Human Inbox.
				if (trackedMissionId && trackedTokenId) {
					const retryKey = `${trackedMissionId}:${trackedTokenId}`;
					const rec = this.missionService?.getMission(trackedMissionId);
					const tok = rec?.runtime?.tokens[trackedTokenId];
					if (rec?.runtime?.status === 'running' && tok?.status === 'active') {
						const prevAttempts = this.transientRetryCount.get(retryKey) ?? 0;
						const backoffsMs = [8_000, 20_000, 45_000];
						if (isTransient && prevAttempts < backoffsMs.length) {
							const attempt = prevAttempts + 1;
							const delayMs = backoffsMs[prevAttempts];
							this.transientRetryCount.set(retryKey, attempt);
							this.touchAgentActivity(agent.id, Date.now());
							const retryTimer = setTimeout(() => {
								this.pendingTurnNudgeTimers.delete(retryTimer);
								const latestRec = this.missionService?.getMission(trackedMissionId);
								const latestTok = latestRec?.runtime?.tokens[trackedTokenId];
								if (!latestRec || latestRec.runtime?.status !== 'running' || !latestTok || latestTok.status !== 'active') {
									this.transientRetryCount.delete(retryKey);
									return;
								}
								this.touchAgentActivity(agent.id, Date.now());
								const retryPrompt = [
									`[Automatic Transient Error Recovery #${attempt}/${backoffsMs.length} · Node \`${trackedNodeId ?? latestTok.nodeId}\` · Token \`${trackedTokenId}\`]`,
									`Your previous turn was interrupted by a transient gateway/network error (\`${errMsg.slice(0, 220)}\`).`,
									`Inspect your workspace (keep any files you already wrote), finish remaining deliverables & tests, and close token \`${trackedTokenId}\` via \`aexus-ade token complete ${trackedTokenId} --summary "..."\`.`,
								].join('\n');
								void this.dispatchPromptToAgent(agent.id, retryPrompt, {
									...options,
									retryAttempt: attempt,
								});
							}, delayMs);
							this.pendingTurnNudgeTimers.add(retryTimer);
							return;
						}
						this.transientRetryCount.delete(retryKey);
						this.unclosedTurnNudgeCount.delete(retryKey);
						void this.failToken(trackedMissionId, {
							tokenId: trackedTokenId,
							reason: `Engine dispatch error on node ${trackedNodeId ?? tok.nodeId}: ${errMsg.slice(0, 400)}`,
						}).catch(() => undefined);
					}
					return;
				}

				const escAttempt = options?.retryAttempt ?? 0;
				const escBackoffsMs = [10_000, 25_000];
				if (isTransient && options?.requireLiveDelivery && escAttempt < escBackoffsMs.length) {
					const delayMs = escBackoffsMs[escAttempt];
					const retryTimer = setTimeout(() => {
						this.pendingTurnNudgeTimers.delete(retryTimer);
						void this.dispatchPromptToAgent(agent.id, prompt, {
							...options,
							retryAttempt: escAttempt + 1,
						});
					}, delayMs);
					this.pendingTurnNudgeTimers.add(retryTimer);
					return;
				}

				options?.onDispatchError?.(errMsg);
			},
		);
		return true;
	}

	private scheduleUnclosedTokenCheck(missionId: string, tokenId: string, nodeId: string, agentId: string): void {
		const nudgeKey = `${missionId}:${tokenId}`;
		const timer = setTimeout(() => {
			this.pendingTurnNudgeTimers.delete(timer);
			const rec = this.missionService?.getMission(missionId);
			if (!rec || rec.runtime?.status !== 'running') {
				this.unclosedTurnNudgeCount.delete(nudgeKey);
				return;
			}
			const tok = rec.runtime.tokens[tokenId];
			if (!tok || tok.status !== 'active' || tok.nodeId !== nodeId) {
				this.unclosedTurnNudgeCount.delete(nudgeKey);
				return;
			}
			const count = (this.unclosedTurnNudgeCount.get(nudgeKey) ?? 0) + 1;
			this.unclosedTurnNudgeCount.set(nudgeKey, count);
			if (count <= 2) {
				const checkHintLines = tok.lastCheckFailure
					? [
						`Last deterministic verification FAILED (attempt ${tok.lastCheckFailure.attempt}/${tok.lastCheckFailure.maxAutoRetries}): ${tok.lastCheckFailure.summary}`,
						`Fix the failure, self-check with \`aexus-ade mission check run --mission ${missionId} --node ${nodeId} --json\`, then call \`aexus-ade token complete ${tokenId} --summary "..."\`.`,
					]
					: [
						`You MUST close this token via the shell right now so downstream nodes can proceed:`,
						`- If finished: \`aexus-ade token complete ${tokenId} --summary "<concise factual summary of deliverables & test results>"\``,
						`- If blocked/unrecoverable: \`aexus-ade token fail ${tokenId} --reason "<exact failure reason>"\``,
					];
				const reminder = [
					`[Mission Token Reminder #${count}/2 · Node \`${nodeId}\` · Token \`${tokenId}\`]`,
					`Your previous turn ended while token \`${tokenId}\` is still ACTIVE.`,
					...checkHintLines,
					`Run the command immediately without repeating completed work.`,
				].join('\n');
				void this.dispatchPromptToAgent(agentId, reminder, {
					autonomousApproved: true,
					missionId,
					tokenId,
					nodeId,
				});
			} else {
				this.unclosedTurnNudgeCount.delete(nudgeKey);
				void this.failToken(missionId, {
					tokenId,
					reason: `Node ${nodeId} ended its turn ${count} times without closing token ${tokenId} via aexus-ade token complete/fail.`,
				}).catch(() => undefined);
			}
		}, 1500);
		this.pendingTurnNudgeTimers.add(timer);
	}

	private async executeEffects(rec: IAdeMissionRecord, effects: readonly MissionEngineEffect[]): Promise<void> {
		for (const effect of effects) {
			switch (effect.kind) {
				case 'dispatch_token': {
					// Package the node's latest authored Pre-Prompt together with its live Token info on wakeup,
					// and always resolve the live bound employee ID so newly patched / reassigned nodes never lose their first token!
					const latestRec = this.missionService?.getMission(rec.id) ?? rec;
					const liveState = this.ensureSynchronizedState(latestRec);
					const targetAgentId = liveState.boundary.nodeAssignments[effect.nodeId]?.agentId
						?? liveState.tokens[effect.tokenId]?.holderAgentId
						?? effect.holderAgentId;
					const nodePrePrompt = latestRec.nodePrompts?.[effect.nodeId];
					const nodeChecks = (this.computeEffectiveNodeChecks(latestRec, parseMissionMermaidDag(latestRec.mermaidText), effect.nodeId)[effect.nodeId] ?? [])
						.filter(h => h.enabled !== false);
					let wakeupPrompt = composeMissionNodeWakeupPrompt(effect.prompt, nodePrePrompt);
					if (nodeChecks.length > 0) {
						const checkLines = nodeChecks.map(h => {
							const parts: string[] = [];
							if (h.command) { parts.push(`\`${h.command}\``); }
							if (h.expectFiles && h.expectFiles.length > 0) { parts.push(`files: ${h.expectFiles.join(', ')}`); }
							return `- ${h.name || h.id}: ${parts.join(' + ')}`;
						});
						wakeupPrompt += `\n\n### Deterministic Verification Gate (Auto-Run on \`token complete\`)\n${checkLines.join('\n')}\n- Self-verify anytime (0 review cost): \`aexus-ade mission check run --mission ${rec.id} --node ${effect.nodeId} --json\``;
					}
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, wakeupPrompt, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: effect.tokenId,
						nodeId: effect.nodeId,
					});
					if (!dispatched) {
						await this.failToken(rec.id, {
							tokenId: effect.tokenId,
							reason: `Unable to dispatch token ${effect.tokenId} to node ${effect.nodeId} (agent "${targetAgentId ?? 'unassigned'}" unavailable).`,
						}).catch(() => undefined);
					}
					break;
				}
				case 'wakeup_agent': {
					const latestRec = this.missionService?.getMission(rec.id) ?? rec;
					const liveState = this.ensureSynchronizedState(latestRec);
					const targetAgentId = liveState.boundary.nodeAssignments[effect.nodeId]?.agentId
						?? liveState.tokens[effect.tokenId]?.holderAgentId
						?? effect.holderAgentId;
					const dispatched = await this.dispatchPromptToAgent(targetAgentId, effect.message, {
						autonomousApproved: true,
						missionId: rec.id,
						tokenId: effect.tokenId,
						nodeId: effect.nodeId,
					});
					if (!dispatched) {
						await this.failToken(rec.id, {
							tokenId: effect.tokenId,
							reason: `Unable to wake agent "${targetAgentId ?? 'unassigned'}" for node ${effect.nodeId} (${effect.wakeupReason}).`,
						}).catch(() => undefined);
					}
					break;
				}
				case 'stop_agent': {
					if (effect.holderAgentId) {
						const agent = this.projectsService?.getAgent(effect.holderAgentId);
						if (agent?.session) {
							const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
							await this.sessionsService?.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
							this.projectsService?.setAgentStatus(agent.id, 'idle');
						}
					}
					break;
				}
				case 'upsert_gate_inbox': {
					const govId = rec.ownerSessionId ?? rec.id;
					await this.inboxService?.upsertUserGateTodo?.({
						governorSessionId: govId,
						treeType: 'mission',
						nodeId: effect.nodeId,
						nodeTitle: effect.nodeTitle,
						description: `Human Gate "${effect.nodeTitle}" (token ${effect.tokenId}) requires Approve / Reject sign-off.`,
						upstreamSummary: effect.upstreamSummary,
						rollbackCandidates: effect.rollbackCandidates,
					}).catch(() => undefined);
					break;
				}
				case 'escalate_to_supervisor': {
					const latestRec = this.missionService?.getMission(rec.id) ?? rec;
					const failedAgentId = effect.nodeId
						? latestRec.runtime?.boundary.nodeAssignments[effect.nodeId]?.agentId
						: undefined;
					const prompt = [
						`[Mission Escalation · ${rec.title} (${rec.id})]`,
						`- Node: ${effect.nodeId || '(unknown)'} | Token: ${effect.tokenId || '(unknown)'}${failedAgentId ? ` | Subordinate Agent: \`${failedAgentId}\`` : ''}`,
						`- Failure / Escalation Reason: ${effect.reason}`,
						`- Next Actions:`,
						`  1. Inspect subordinate context via \`aexus-ade org context ${failedAgentId || '<agentId>'} --json\`.`,
						`  2. Retry the frozen node in-place (preserving wave & join barriers) via \`aexus-ade mission retry --mission ${rec.id} --token ${effect.tokenId} --guidance "<recovery instructions>" --json\`.`,
						`  3. Or patch/recall within your jurisdiction (\`aexus-ade mission recall\`, \`aexus-ade mission patch\`) or escalate upward (\`aexus-ade org escalate --mission ${rec.id} --token ${effect.tokenId} --reason "..."\`).`,
					].join('\n');
					const postInboxFallback = (detail: string) => {
						const govId = rec.ownerSessionId ?? rec.id;
						void this.inboxService?.postGovernorMessage({
							governorSessionId: govId,
							title: `Mission Escalation (${effect.nodeId || rec.id})`,
							message: `Supervisor "${effect.supervisorId}" could not handle escalation for token \`${effect.tokenId}\` (${detail}).\n\n${effect.reason}`,
							nodeId: effect.nodeId || undefined,
							severity: 'critical',
						}).catch(() => undefined);
					};
					const delivered = await this.dispatchPromptToAgent(effect.supervisorId, prompt, {
						autonomousApproved: true,
						requireLiveDelivery: true,
						dedupeKey: `escalate:${rec.id}:${effect.tokenId || effect.nodeId}`,
						onDispatchError: errMsg => postInboxFallback(`dispatch failed: ${errMsg.slice(0, 300)}`),
					});
					if (!delivered) {
						postInboxFallback('supervisor session unavailable');
					}
					break;
				}
				case 'post_inbox': {
					const govId = rec.ownerSessionId ?? rec.id;
					await this.inboxService?.postGovernorMessage({
						governorSessionId: govId,
						title: effect.title,
						message: effect.message,
						nodeId: effect.nodeId,
						severity: effect.severity,
						senderAgentId: effect.senderAgentId,
					}).catch(() => undefined);
					break;
				}
				case 'mermaid_patched': {
					this.missionService?.updateMermaid(rec.id, effect.newMermaidText);
					break;
				}
			}
		}
	}
}
