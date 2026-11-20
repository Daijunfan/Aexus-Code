/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { buildCloudProjectUri, IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
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
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	applySafeMissionPatch,
	blockMissionToken,
	completeMissionToken,
	createInitialMissionRuntimeState,
	escalateMissionIssue,
	expandTracePointer,
	failMissionToken,
	fireMissionSourceTrigger,
	IMissionEngineCaller,
	IMissionEngineTransitionResult,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	IMissionTraceNode,
	MissionEngineEffect,
	parseDurationMs,
	pauseMissionRun,
	recallMissionTokens,
	recordWatchdogWakeup,
	rejectMissionToken,
	resolveMissionGate,
	resumeMissionRun,
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
	readonly failedTokenCount: number;
	readonly triggers: readonly IMissionSourceTrigger[];
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
	completeToken(missionId: string, params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult>;
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
	escalate(missionId: string, params: { readonly callerSupervisorId: string; readonly reason: string; readonly tokenId?: string; readonly nodeId?: string; readonly isSecretary?: boolean; readonly isHumanUser?: boolean }): Promise<IMissionEngineTransitionResult>;
	resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult>;
	recallTokens(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly nodeIds?: readonly string[]; readonly branchRootNodeId?: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult>;
	patchMermaid(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly newMermaidText: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult>;

	listTriggers(missionId: string): readonly IMissionSourceTrigger[];
	setTrigger(missionId: string, triggerInput: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: IMissionSourceTrigger['kind'] }, caller: IMissionEngineCaller): Promise<{ readonly ok: boolean; readonly trigger?: IMissionSourceTrigger; readonly error?: string; readonly code?: string }>;
	removeTrigger(missionId: string, triggerId: string, caller: IMissionEngineCaller): Promise<{ readonly ok: boolean; readonly removedId?: string; readonly error?: string; readonly code?: string }>;

	touchAgentActivity(sessionResourceOrAgentId: string, timestamp?: number): void;
}

export class AdeMissionRuntimeService extends Disposable implements IAdeMissionRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly lastHeartbeatSyncAt = new Map<string, number>();
	private readonly inMemoryAgentActivityAt = new Map<string, number>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.bindBackendEvents();
		// Rehydrate watchdog registrations for any previously running missions.
		queueMicrotask(() => {
			const missions = this.missionService?.listMissions() ?? [];
			for (const rec of missions) {
				if (rec.runtime?.status === 'running') {
					this.syncWatchdog(rec.id, rec.runtime);
				}
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

		const defaultInGraphTier = Math.min(org.ranks.length, Math.max(1, base.boundary.offGraphMaxTier + 1));
		const nextAssignments: Record<string, IMissionNodeAssignment> = { ...base.boundary.nodeAssignments };
		let assignmentsChanged = false;
		for (const node of parsed.nodes) {
			if (node.kind === 'gate') {
				continue;
			}
			const existing = nextAssignments[node.id];
			const matchedAgent = byNodeId.get(node.id);
			// Prefer current Mermaid/popover employee mapping over stale cached agentId.
			const resolvedAgentId = matchedAgent?.id ?? existing?.agentId;
			const resolvedAgent = matchedAgent ?? (resolvedAgentId ? this.projectsService?.getAgent(resolvedAgentId) : undefined);
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

		// Sync live tiers of bound supervisors so boundary checks always inspect live session ranks.
		let supervisorsChanged = false;
		const nextSupervisors = base.boundary.supervisors.map(sup => {
			if (sup.id === ADE_SECRETARY_ID) {
				if (sup.tier !== 0) {
					supervisorsChanged = true;
					return { ...sup, tier: 0 };
				}
				return sup;
			}
			const supAgent = this.projectsService?.getAgent(sup.id);
			if (supAgent) {
				const liveTier = resolveEffectiveRankDefinition(org, supAgent.role, this.projectsService?.hasSubordinates(supAgent.id) ?? false).tier;
				if (sup.tier !== liveTier) {
					supervisorsChanged = true;
					return { ...sup, tier: liveTier };
				}
			}
			return sup;
		});

		const nextNodeStates: Record<string, IMissionRuntimeState['nodeStates'][string]> = { ...base.nodeStates };
		let statesChanged = false;
		for (const node of parsed.nodes) {
			if (!Object.hasOwn(nextNodeStates, node.id)) {
				nextNodeStates[node.id] = 'idle';
				statesChanged = true;
			}
		}

		// Keep live active/blocked token holderAgentId synchronized with current node assignment on reassignment.
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

		if (!assignmentsChanged && !supervisorsChanged && !statesChanged && !tokensChanged && rec.runtime) {
			return base;
		}
		return {
			...base,
			nodeStates: nextNodeStates,
			tokens: nextTokens,
			boundary: {
				...base.boundary,
				supervisors: nextSupervisors,
				nodeAssignments: nextAssignments,
			},
		};
	}

	private commitState(missionId: string, state: IMissionRuntimeState): void {
		this.missionService?.updateRuntime(missionId, state);
		this.syncWatchdog(missionId, state);
		this._onDidChange.fire(missionId);
	}

	private syncWatchdog(missionId: string, state: IMissionRuntimeState): void {
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
					return {
						tokenId: t.id,
						nodeId: t.nodeId,
						holderAgentId: t.holderAgentId,
						status: t.status,
						lastActivityAt: Math.max(t.lastActivityAt, memActivity),
						lastNudgeAt: t.lastNudgeAt,
						...(t.blocked ? { blocked: t.blocked } : {}),
					};
				}),
			triggers: state.triggers,
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
			failedTokenCount: tokens.filter(t => t.status === 'frozen_failed').length,
			triggers: state.triggers,
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
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
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

	async completeToken(missionId: string, params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = completeMissionToken(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			await this.executeEffects(rec, result.effects);
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
		const rec = this.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const durationMs = parseDurationMs(params.maxDuration);
		if (!durationMs) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Invalid maxDuration "${String(params.maxDuration)}". Use formats like "30m", "2h", "10h", or milliseconds.`,
			};
		}
		const token = state.tokens[params.tokenId];
		const inferredHost = params.hostAlias
			?? (token ? state.boundary.nodeAssignments[token.nodeId]?.hostAlias : undefined);
		const result = blockMissionToken(state, {
			tokenId: params.tokenId,
			reason: params.reason,
			maxDurationMs: durationMs,
			watchPid: params.watchPid,
			watchFile: params.watchFile,
			hostAlias: inferredHost,
			callerAgentId: params.callerAgentId,
		});
		if (result.ok) {
			this.commitState(rec.id, result.state);
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

	async resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = resolveMissionGate(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.commitState(rec.id, result.state);
			// Mark matching Inbox gate todo resolved if present.
			const inbox = this.inboxService;
			if (inbox) {
				const openGate = inbox.list({ includeResolved: false }).find(item =>
					item.kind === 'user_gate'
					&& item.nodeId === params.nodeId
					&& (item.governorSessionId === rec.ownerSessionId || item.governorSessionId === rec.id)
				);
				if (openGate) {
					await inbox.resolveItem(openGate.id, `${params.decision}${params.note ? `: ${params.note}` : ''}`).catch(() => undefined);
				}
			}
			await this.executeEffects(rec, result.effects);
		}
		return result;
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
			// Apply new Mermaid first so locked sidebar employees sync cleanly, then persist updated runtime state!
			this.missionService?.updateMermaid(rec.id, params.newMermaidText);
			const refreshed = this.requireMission(rec.id);
			const synchronized = this.ensureSynchronizedState({ ...refreshed, runtime: result.state });
			this.commitState(rec.id, synchronized);
			await this.executeEffects(refreshed, result.effects.filter(e => e.kind !== 'mermaid_patched'));
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

	private async handleWatchdogWakeup(ev: IAdeWatchdogWakeupEvent): Promise<void> {
		const rec = this.missionService?.getMission(ev.missionId);
		if (!rec || rec.runtime?.status !== 'running') {
			return;
		}
		const result = recordWatchdogWakeup(rec.runtime, {
			tokenId: ev.tokenId,
			reason: ev.reason,
			detail: ev.detail,
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

	private async dispatchPromptToAgent(agentId: string | undefined, prompt: string, options?: { readonly autonomousApproved?: boolean }): Promise<boolean> {
		if (!agentId || !this.projectsService || !this.commandService) {
			return false;
		}
		if (agentId === ADE_SECRETARY_ID) {
			const secSession = this.projectsService.secretary.session;
			if (!secSession) {
				this.projectsService.setSecretaryDraft(prompt);
				return true;
			}
			void this.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', secSession.resource, prompt, {
				agentId: ADE_SECRETARY_ID,
				pureWorker: false,
				callerRole: 'secretary',
				autonomousApproved: options?.autonomousApproved ?? true,
			}).catch(() => undefined);
			return true;
		}
		const agent = this.projectsService.getAgent(agentId);
		if (!agent) {
			return false;
		}
		const resource = await this.ensureAgentSessionReady(agent);
		if (!resource) {
			return false;
		}
		const rankDef = resolveEffectiveRankDefinition(this.orgConfig, agent.role, this.projectsService.hasSubordinates(agent.id));
		this.projectsService.setAgentStatus(agent.id, 'working');
		void this.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', resource, prompt, {
			agentId: agent.id,
			model: agent.preferredModel,
			thinking: agent.preferredThinking,
			pureWorker: false,
			isMissionNode: Boolean(agent.treeNodeId),
			callerRole: rankDef.id,
			autonomousApproved: options?.autonomousApproved ?? true,
		}).then(
			() => { this.projectsService?.setAgentStatus(agent.id, 'idle'); },
			() => { this.projectsService?.setAgentStatus(agent.id, 'idle'); },
		);
		return true;
	}

	private async executeEffects(rec: IAdeMissionRecord, effects: readonly MissionEngineEffect[]): Promise<void> {
		for (const effect of effects) {
			switch (effect.kind) {
				case 'dispatch_token': {
					await this.dispatchPromptToAgent(effect.holderAgentId, effect.prompt, { autonomousApproved: true });
					break;
				}
				case 'wakeup_agent': {
					await this.dispatchPromptToAgent(effect.holderAgentId, effect.message, { autonomousApproved: true });
					break;
				}
				case 'stop_agent': {
					if (effect.holderAgentId) {
						const agent = this.projectsService?.getAgent(effect.holderAgentId);
						if (agent?.session) {
							await this.sessionsService?.stop?.(agent.session).catch(() => undefined);
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
					const prompt = [
						`[Mission Escalation · ${rec.title} (${rec.id})]`,
						`- Node: ${effect.nodeId} | Token: ${effect.tokenId}`,
						`- Failure / Escalation Reason: ${effect.reason}`,
						`- Next Actions: Pull subordinate context via \`aexus-ade org context <agentId> --json\`, then either patch/recall within your jurisdiction (\`aexus-ade mission recall\`, \`aexus-ade mission patch\`) or escalate upward (\`aexus-ade org escalate --mission ${rec.id} --token ${effect.tokenId} --reason "..."\`).`,
					].join('\n');
					const delivered = await this.dispatchPromptToAgent(effect.supervisorId, prompt, { autonomousApproved: true });
					if (!delivered) {
						// Never silently drop an escalation when target supervisor session is unavailable: fall back to Human Inbox!
						const govId = rec.ownerSessionId ?? rec.id;
						await this.inboxService?.postGovernorMessage({
							governorSessionId: govId,
							title: `Mission Escalation (${effect.nodeId || rec.id})`,
							message: `Supervisor "${effect.supervisorId}" could not be reached for token \`${effect.tokenId}\`.\n\n${effect.reason}`,
							nodeId: effect.nodeId || undefined,
							severity: 'critical',
						}).catch(() => undefined);
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
