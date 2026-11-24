/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AEXUS_SSH_SCHEME, buildCloudProjectUri } from '../../../../platform/ade/common/adeCloudHosts.js';
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
	computeMissionTotalCostUsd,
	createInitialMissionRuntimeState,
	distillMissionNodeContext,
	escalateMissionIssue,
	expandTracePointer,
	failMissionToken,
	IMissionConcurrencyLimits,
	IMissionEngineCaller,
	IMissionEngineTransitionResult,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	IMissionTraceNode,
	IMissionTurnUsagePricingOptions,
	inferMissionConcurrencyProvider,
	MissionEngineEffect,
	parseDurationMs,
	pauseMissionRun,
	recallMissionTokens,
	recordTokenCheckResult,
	rejectMissionToken,
	resolveMissionGate,
	resumeMissionRun,
	retryMissionToken,
	setMissionBudgetLimit,
	setMissionConcurrencyLimits,
	setMissionSilenceTimeout,
	startMissionRun,
	stopMissionRun,
	validateSourceTrigger,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	resolveEffectiveStaffTier,
	setOrchestrationGuardrails,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	parseOrchestrationGraph,
	upsertOrchestrationStaffMetaInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ADE_SECRETARY_ID, IAdeAgent } from '../common/ade.js';
import { IAdeMissionRecord } from './adeMissionStore.js';
import type { IAdeMissionRuntimeHost, IMissionStatusView } from './adeMissionRuntimeTypes.js';

export class AdeMissionLegacyEngineController {
	constructor(
		private readonly host: IAdeMissionRuntimeHost,
	) { }

	async reconcileRunningMissionConcurrencyQueues(): Promise<void> {
		const missions = this.host.missionService;
		if (!missions) {
			return;
		}
		for (const rec of missions.listMissions()) {
			if (rec.runtime?.status !== 'running') {
				continue;
			}
			const hasQueued = Object.values(rec.runtime.tokens).some(t => t.status === 'queued');
			if (!hasQueued) {
				continue;
			}
			const synced = this.ensureSynchronizedState(rec);
			const res = setMissionConcurrencyLimits(synced, synced.concurrencyLimits);
			if (res.ok && (res.data?.promotedTokenIds.length ?? 0) > 0) {
				this.host.commitState(rec.id, res.state);
				if (res.effects.length > 0) {
					await this.host.executeEffects(rec, res.effects);
				}
			}
		}
	}

	async applyConfiguredConcurrencyLimitsToRunningMissions(): Promise<void> {
		const missions = this.host.missionService;
		if (!missions) {
			return;
		}
		const configured = this.host.getConfiguredConcurrencyLimits();
		for (const rec of missions.listMissions()) {
			if (rec.runtime?.status === 'running' || rec.runtime?.status === 'paused') {
				const res = setMissionConcurrencyLimits(this.ensureSynchronizedState(rec), configured);
				if (res.ok) {
					this.host.commitState(rec.id, res.state);
					if (res.effects.length > 0) {
						await this.host.executeEffects(this.host.requireMission(rec.id), res.effects);
					}
				}
			}
		}
	}

	resolveNodePricingOptions(state: IMissionRuntimeState, nodeId: string, fallbackAgent?: IAdeAgent): IMissionTurnUsagePricingOptions {
		const assignedAgentId = state.boundary.nodeAssignments[nodeId]?.agentId;
		const agent = fallbackAgent ?? (assignedAgentId ? this.host.projectsService?.getAgent(assignedAgentId) : undefined);
		const fallbackModel = agent?.preferredModel?.trim() && agent.preferredModel.trim().toLowerCase() !== 'default'
			? agent.preferredModel.trim()
			: undefined;
		const fallbackEngineId = agent?.session?.engineId || agent?.preferredEngineId;
		return {
			overrides: this.host.getModelPricingOverrides(),
			fallbackModel,
			fallbackEngineId,
		};
	}

	ensureSynchronizedState(rec: IAdeMissionRecord): IMissionRuntimeState {
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		const nodeIds = parsed.nodes.map(n => n.id);
		const org = this.host.orgConfig;
		const base = rec.runtime ?? createInitialMissionRuntimeState(
			rec.id,
			org,
			{ ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
			nodeIds,
			5,
		);

		const generatedEmployees = this.host.missionService?.getGeneratedEmployees(rec.id) ?? [];
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
		const parsedOrch = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const orchStaffNodeIds = parsedOrch && !parsedOrch.error
			? parsedOrch.nodes.filter(n => n.kind === 'staff').map(n => n.id)
			: [];
		const canPruneStaleNodes = !parsed.error && !isLiveRun && (nodeIds.length > 0 || orchStaffNodeIds.length > 0 || isExplicitEmpty);
		const validNodeIdSet = new Set([...nodeIds, ...orchStaffNodeIds]);
		const validTaskNodeIdSet = new Set([
			...parsed.nodes.filter(n => n.kind !== 'gate').map(n => n.id),
			...orchStaffNodeIds,
		]);
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
				const existingAgent = existing?.agentId ? this.host.projectsService?.getAgent(existing.agentId) : undefined;
				const hasManualOverride = Boolean(existingAgent && !existingAgent.treeNodeId && (!existingAgent.treeNodeIds || existingAgent.treeNodeIds.length === 0));
				const resolvedAgentId = hasManualOverride ? existingAgent!.id : (matchedAgent?.id ?? existing?.agentId);
				const resolvedAgent = hasManualOverride ? existingAgent : (matchedAgent ?? existingAgent);
				const resolvedTier = resolvedAgent
					? resolveEffectiveRankDefinition(org, resolvedAgent.role, this.host.projectsService?.hasSubordinates(resolvedAgent.id) ?? false).tier
					: (existing?.tier ?? defaultInGraphTier);
				const resolvedHost = existing?.hostAlias ?? (resolvedAgent?.projectUri.scheme === 'aexus-ssh' ? resolvedAgent.projectUri.authority : 'local');
				const resolvedRemotePath = existing?.remoteProjectPath ?? (resolvedAgent?.projectUri.scheme === 'aexus-ssh' ? resolvedAgent.projectUri.path : undefined);
				const hasLiveModelOrEngine = Boolean(
					resolvedAgent && (resolvedAgent.preferredModel || resolvedAgent.session?.engineId || resolvedAgent.preferredEngineId),
				);
				const resolvedProvider = hasLiveModelOrEngine
					? inferMissionConcurrencyProvider(
						resolvedAgent?.preferredModel,
						resolvedAgent?.session?.engineId ?? resolvedAgent?.preferredEngineId,
					)
					: existing?.provider;
				if (!existing || existing.agentId !== resolvedAgentId || existing.tier !== resolvedTier || existing.provider !== resolvedProvider) {
					nextAssignments[node.id] = {
						agentId: resolvedAgentId,
						tier: resolvedTier,
						roleKind: existing?.roleKind ?? 'worker',
						hostAlias: resolvedHost,
						...(resolvedRemotePath ? { remoteProjectPath: resolvedRemotePath } : {}),
						...(resolvedProvider ? { provider: resolvedProvider } : {}),
					};
					assignmentsChanged = true;
				}
			}
		}

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
			const supAgent = this.host.projectsService?.getAgent(nextSup.id);
			if (supAgent) {
				const liveTier = resolveEffectiveRankDefinition(org, supAgent.role, this.host.projectsService?.hasSubordinates(supAgent.id) ?? false).tier;
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

		let tokensChanged = false;
		const nextTokens: Record<string, IMissionToken> = { ...base.tokens };
		for (const [tid, tok] of Object.entries(base.tokens)) {
			if (tok.status === 'active' || tok.status === 'queued' || tok.status === 'blocked') {
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

	getRuntimeState(missionId: string): IMissionRuntimeState {
		const rec = this.host.requireMission(missionId);
		return this.ensureSynchronizedState(rec);
	}

	getMissionStatus(missionId: string): IMissionStatusView {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		const validation = validateMissionFactoryBoundary(this.host.orgConfig, state.boundary, parsed);
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
			queuedTokenCount: tokens.filter(t => t.status === 'queued').length,
			blockedTokenCount: tokens.filter(t => t.status === 'blocked').length,
			waitingGateCount: tokens.filter(t => t.status === 'waiting_gate').length,
			waitingJoinCount: tokens.filter(t => t.status === 'waiting_join').length,
			failedTokenCount: tokens.filter(t => t.status === 'frozen_failed').length,
			...(state.concurrencyLimits ? { concurrencyLimits: state.concurrencyLimits } : {}),
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
		readonly isOrchestrationStaff?: boolean;
		readonly department?: string;
		readonly managedNodeIds?: readonly string[];
	} | undefined {
		const missions = this.host.missionService?.listMissions() ?? [];
		for (const rec of missions) {
			const state = this.ensureSynchronizedState(rec);
			if (rec.orchestrationText?.trim()) {
				const orchState = this.host.ensureSynchronizedOrchestrationState(rec);
				const orchNodes = Object.entries(orchState.nodeAgentIds)
					.filter(([, aid]) => aid === agentId)
					.map(([nid]) => nid);
				if (orchNodes.length > 0) {
					const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
					const matchedNode = orchGraph.nodes.find(n => n.id === orchNodes[0]);
					return {
						mission: rec,
						runtime: state,
						nodeIds: orchNodes,
						isOffGraphSupervisor: false,
						isOrchestrationStaff: true,
						...(matchedNode?.department ? { department: matchedNode.department } : {}),
					};
				}
			}
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
		const agent = this.host.projectsService?.getAgent(agentId);
		if (agent?.treeGovernorId) {
			const rec = this.host.missionService?.getMission(agent.treeGovernorId) ?? this.host.missionService?.getMissionByLinkedSession(agent.treeGovernorId);
			if (rec) {
				const nodeIds = agent.treeNodeIds && agent.treeNodeIds.length > 0
					? agent.treeNodeIds
					: (agent.treeNodeId ? [agent.treeNodeId] : []);
				if (rec.orchestrationText?.trim()) {
					const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
					if (!orchGraph.error && orchGraph.nodes.some(n => n.kind === 'staff')) {
						const matchedNode = orchGraph.nodes.find(n => n.kind === 'staff' && (nodeIds.includes(n.id) || (n.employeeKey && nodeIds.includes(n.employeeKey))));
						return {
							mission: rec,
							runtime: this.ensureSynchronizedState(rec),
							nodeIds: matchedNode ? [matchedNode.id] : nodeIds,
							isOffGraphSupervisor: false,
							isOrchestrationStaff: true,
							...(matchedNode?.department ? { department: matchedNode.department } : {}),
						};
					}
				}
				return { mission: rec, runtime: this.ensureSynchronizedState(rec), nodeIds, isOffGraphSupervisor: false };
			}
		}
		return undefined;
	}

	async start(missionId: string, options?: { readonly silenceTimeoutMinutes?: number; readonly initialPrompt?: string; readonly concurrencyLimits?: IMissionConcurrencyLimits }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const effectiveConcurrency = options?.concurrencyLimits ?? state.concurrencyLimits ?? this.host.getConfiguredConcurrencyLimits();
		const result = startMissionRun(state, graph, this.host.orgConfig, {
			...options,
			...(effectiveConcurrency ? { concurrencyLimits: effectiveConcurrency } : {}),
			requireAssignedNodes: Boolean(this.host.projectsService),
		});
		if (result.ok) {
			const withInitialRev = appendMissionDagRevision(result.state, rec.mermaidText, 'Mission started (v1)', undefined, graph);
			this.host.commitState(rec.id, withInitialRev);
			await this.host.executeEffects(rec, result.effects);
			return { ...result, state: withInitialRev };
		}
		return result;
	}

	async setConcurrencyLimits(missionId: string, limits: IMissionConcurrencyLimits | undefined): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const result = setMissionConcurrencyLimits(this.ensureSynchronizedState(rec), limits);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			if (result.effects.length > 0) {
				await this.host.executeEffects(this.host.requireMission(rec.id), result.effects);
			}
		}
		return result;
	}

	async pause(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const result = pauseMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
		}
		return result;
	}

	async resume(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const result = resumeMissionRun(this.ensureSynchronizedState(rec));
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			await this.host.executeEffects(rec, result.effects);
			for (const agentId of Array.from(this.host.pendingDispatchesByAgent.keys())) {
				const queue = this.host.pendingDispatchesByAgent.get(agentId);
				if (queue?.some(item => item.options?.missionId === rec.id)) {
					this.host.flushNextQueuedDispatch(agentId);
				}
			}
		}
		return result;
	}

	async stop(missionId: string): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const prevState = this.ensureSynchronizedState(rec);
		const result = stopMissionRun(prevState);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			this.host.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.host.executeEffects(rec, result.effects);
			this.host.teardownMission(rec.id);
		}
		return result;
	}

	async setSilenceTimeout(missionId: string, minutes: number): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const result = setMissionSilenceTimeout(this.ensureSynchronizedState(rec), minutes);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
		}
		return result;
	}

	async setBudgetLimit(missionId: string, budgetLimitUsd: number | undefined): Promise<{ readonly ok: boolean; readonly state: IMissionRuntimeState; readonly error?: string }> {
		const rec = this.host.requireMission(missionId);
		const prev = this.ensureSynchronizedState(rec);
		const next = setMissionBudgetLimit(prev, budgetLimitUsd);
		this.host.commitState(rec.id, next);
		let orchTrippedNow = false;
		if (rec.orchestrationRuntime || rec.orchestrationText?.trim()) {
			const curOrch = this.host.ensureSynchronizedOrchestrationState(this.host.requireMission(rec.id));
			const totalCostUsd = computeMissionTotalCostUsd(next);
			const synced = setOrchestrationGuardrails(curOrch, {
				budgetLimitUsd: budgetLimitUsd ?? null,
				totalCostUsd,
			});
			orchTrippedNow = synced.budgetTrippedNow;
			this.host.commitOrchestrationState(rec.id, synced.state);
		}
		if ((next.budgetCircuitTripped && !prev.budgetCircuitTripped) || orchTrippedNow) {
			void this.stopActiveAgentsOnBudgetTrip(next, this.host.missionService?.getMission(rec.id) ?? rec);
			this.notifyBudgetCircuitTripped(rec, next);
		}
		return { ok: true, state: next };
	}

	async distillNodeContext(missionId: string, nodeId: string, options?: { readonly memo?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const state = this.ensureSynchronizedState(rec);
		const result = distillMissionNodeContext(state, graph, nodeId, options);
		if (!result.ok) {
			return result;
		}
		this.host.commitState(rec.id, result.state);
		const stopEff = result.effects.find(e => e.kind === 'stop_agent');
		const agentId = result.state.boundary.nodeAssignments[nodeId]?.agentId
			?? (stopEff?.kind === 'stop_agent' ? stopEff.holderAgentId : undefined);
		if (agentId && this.host.projectsService) {
			const agent = this.host.projectsService.getAgent(agentId);
			if (agent?.session) {
				const engineId = agent.session.engineId ?? agent.preferredEngineId ?? 'aexus-claude';
				const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
				await this.host.sessionsService?.stop?.(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				this.host.projectsService.setAgentStatus(agent.id, 'idle');
				if (this.host.sessionsService?.create) {
					const fresh = await this.host.sessionsService.create(engineId, agent.projectUri).catch(() => undefined);
					if (fresh) {
						this.host.projectsService.bindSession(agent.id, fresh);
					}
				}
			}
		}
		const nonStopEffects = result.effects.filter(e => e.kind !== 'stop_agent');
		if (nonStopEffects.length > 0) {
			await this.host.executeEffects(this.host.requireMission(rec.id), nonStopEffects);
		}
		return result;
	}

	async stopActiveAgentsOnBudgetTrip(state: IMissionRuntimeState, rec?: IAdeMissionRecord): Promise<void> {
		if (!this.host.projectsService || !this.host.sessionsService?.stop) {
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
		const orch = rec?.orchestrationRuntime;
		if (orch) {
			for (const tok of Object.values(orch.tokens)) {
				if (tok.status === 'active' || tok.status === 'blocked') {
					const aid = orch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
					if (aid) {
						agentIds.add(aid);
					}
				}
			}
		}
		for (const aid of agentIds) {
			const agent = this.host.projectsService.getAgent(aid);
			if (agent?.session) {
				const hostAlias = agent.projectUri.scheme === AEXUS_SSH_SCHEME ? agent.projectUri.authority : undefined;
				await this.host.sessionsService.stop(agent.session, hostAlias ? { hostAlias } : undefined).catch(() => undefined);
				this.host.projectsService.setAgentStatus(agent.id, 'idle');
			}
		}
	}

	notifyBudgetCircuitTripped(rec: IAdeMissionRecord, state: IMissionRuntimeState): void {
		const spent = computeMissionTotalCostUsd(state);
		const limit = state.budgetLimitUsd ?? 0;
		const hasEstimated = Object.values(state.nodeTelemetry ?? {}).some(t => Boolean(t.costEstimated || (t.estimatedCostUsd ?? 0) > 0));
		const spentLabel = hasEstimated ? `~$${spent.toFixed(2)} (estimated)` : `$${spent.toFixed(2)}`;
		void this.host.inboxService?.postGovernorMessage?.({
			governorSessionId: rec.ownerSessionId ?? rec.id,
			title: `FinOps Budget Circuit-Breaker Tripped (${rec.title})`,
			message: `Mission "${rec.title}" automatically paused after spending ${spentLabel} against the $${limit.toFixed(2)} FinOps budget ceiling. Raise the budget limit in the FinOps Ledger to resume.`,
			severity: 'critical',
		}).catch(() => undefined);
	}

	getBoundary(missionId: string): { readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary> } {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);
		return {
			boundary: state.boundary,
			validation: validateMissionFactoryBoundary(this.host.orgConfig, state.boundary, parsed),
		};
	}

	async setBoundary(missionId: string, patch: {
		readonly offGraphMaxTier?: number;
		readonly supervisors?: readonly IMissionSupervisorBinding[];
		readonly nodeAssignments?: Readonly<Record<string, IMissionNodeAssignment>>;
	}): Promise<{ readonly ok: boolean; readonly boundary: IMissionBoundaryConfig; readonly validation: ReturnType<typeof validateMissionFactoryBoundary>; readonly error?: string }> {
		const rec = this.host.requireMission(missionId);
		const state = this.ensureSynchronizedState(rec);
		const parsed = parseMissionMermaidDag(rec.mermaidText);

		const nextOffGraphMax = patch.offGraphMaxTier !== undefined ? patch.offGraphMaxTier : state.boundary.offGraphMaxTier;
		const org = this.host.orgConfig;
		const projects = this.host.projectsService;

		const rawAssignments = patch.nodeAssignments ?? state.boundary.nodeAssignments;
		const nextAssignments: Record<string, IMissionNodeAssignment> = {};
		for (const [nid, assign] of Object.entries(rawAssignments)) {
			const agent = assign.agentId ? projects?.getAgent(assign.agentId) : undefined;
			const liveTier = agent
				? resolveEffectiveRankDefinition(org, agent.role, projects?.hasSubordinates(agent.id) ?? false).tier
				: assign.tier;
			nextAssignments[nid] = { ...assign, tier: liveTier };
		}

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
		if (nextState.status === 'running' && Object.values(nextState.tokens).some(t => t.status === 'queued')) {
			const drained = setMissionConcurrencyLimits(nextState, nextState.concurrencyLimits);
			this.host.commitState(rec.id, drained.state);
			if (drained.effects.length > 0) {
				await this.host.executeEffects(rec, drained.effects);
			}
		} else {
			this.host.commitState(rec.id, nextState);
		}
		return { ok: true, boundary: candidate, validation };
	}

	async bindNodeHost(missionId: string, nodeId: string, options: {
		readonly hostAlias?: string;
		readonly remoteProjectPath?: string;
		readonly agentId?: string;
		readonly roleKind?: MissionNodeRoleKind;
	}): Promise<{ readonly ok: boolean; readonly assignment?: IMissionNodeAssignment; readonly error?: string }> {
		const initialRec = this.host.requireMission(missionId);
		const parsed = parseMissionMermaidDag(initialRec.mermaidText);
		const parsedOrch = parseOrchestrationGraph(initialRec.orchestrationText ?? '');
		const node = parsed.nodes.find(n => n.id === nodeId);
		const orchStaffNode = parsedOrch.nodes.find(n => n.id === nodeId && n.kind === 'staff');
		if (!node && !orchStaffNode) {
			return { ok: false, error: `Node "${nodeId}" not found in Mission "${initialRec.id}".` };
		}
		const initialState = this.ensureSynchronizedState(initialRec);
		const initialExisting = initialState.boundary.nodeAssignments[nodeId];
		const hostAlias = (options.hostAlias?.trim() || 'local');
		let remoteProjectPath = options.remoteProjectPath?.trim() || initialExisting?.remoteProjectPath;

		let resolvedUri: URI | undefined;
		if (hostAlias !== 'local') {
			const host = await this.host.cloudHostService?.getHost(hostAlias).catch(() => undefined);
			if (host && !remoteProjectPath) {
				remoteProjectPath = host.defaultDirectory || host.recentDirectories[0] || '/';
			}
			resolvedUri = buildCloudProjectUri(host?.alias ?? hostAlias, remoteProjectPath || '/', host?.os);
		} else if (initialRec.projectUri) {
			resolvedUri = URI.parse(initialRec.projectUri);
			remoteProjectPath = undefined;
		}

		const freshRec = this.host.requireMission(missionId);
		const freshState = this.ensureSynchronizedState(freshRec);
		const freshOrchState = orchStaffNode ? this.host.ensureSynchronizedOrchestrationState(freshRec) : undefined;
		const existing = freshState.boundary.nodeAssignments[nodeId];
		const targetAgentId = options.agentId?.trim() || freshOrchState?.nodeAgentIds[nodeId] || existing?.agentId;
		if (targetAgentId && resolvedUri && this.host.projectsService?.updateAgentEnginePreferences) {
			this.host.projectsService.updateAgentEnginePreferences(targetAgentId, { projectUri: resolvedUri });
		}
		if (orchStaffNode && freshRec.orchestrationText) {
			const updatedCode = upsertOrchestrationStaffMetaInCode(freshRec.orchestrationText, nodeId, { hostAlias });
			if (updatedCode.ok && updatedCode.orchestrationText && updatedCode.orchestrationText !== freshRec.orchestrationText) {
				this.host.missionService?.updateOrchestrationText(freshRec.id, updatedCode.orchestrationText);
			}
		}
		const targetAgent = targetAgentId ? this.host.projectsService?.getAgent(targetAgentId) : undefined;
		const resolvedTier = targetAgent
			? resolveEffectiveRankDefinition(this.host.orgConfig, targetAgent.role, this.host.projectsService?.hasSubordinates(targetAgent.id) ?? false).tier
			: (existing?.tier ?? Math.min(this.host.orgConfig.ranks.length, Math.max(1, freshState.boundary.offGraphMaxTier + 1)));

		const hasLiveTargetMeta = Boolean(
			targetAgent && (targetAgent.preferredModel || targetAgent.session?.engineId || targetAgent.preferredEngineId),
		);
		const resolvedProvider = hasLiveTargetMeta
			? inferMissionConcurrencyProvider(
				targetAgent?.preferredModel,
				targetAgent?.session?.engineId ?? targetAgent?.preferredEngineId,
			)
			: existing?.provider;
		const updatedAssignment: IMissionNodeAssignment = {
			agentId: targetAgentId,
			tier: resolvedTier,
			roleKind: options.roleKind ?? existing?.roleKind ?? 'worker',
			hostAlias,
			...(hostAlias !== 'local' && remoteProjectPath ? { remoteProjectPath } : {}),
			...(resolvedProvider ? { provider: resolvedProvider } : {}),
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
		if (nextState.status === 'running' && Object.values(nextState.tokens).some(t => t.status === 'queued')) {
			const drained = setMissionConcurrencyLimits(nextState, nextState.concurrencyLimits);
			this.host.commitState(freshRec.id, drained.state);
			if (drained.effects.length > 0) {
				await this.host.executeEffects(freshRec, drained.effects);
			}
		} else {
			this.host.commitState(freshRec.id, nextState);
		}
		return { ok: true, assignment: updatedAssignment };
	}

	getCurrentTokens(agentId: string, missionId?: string): readonly IMissionToken[] {
		const missions = missionId
			? [this.host.missionService?.getMission(missionId) ?? this.host.missionService?.getMissionByLinkedSession(missionId)].filter((m): m is IAdeMissionRecord => Boolean(m))
			: (this.host.missionService?.listMissions() ?? []);
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
		const rec = this.host.requireMission(missionId);
		const orch = rec.orchestrationRuntime;
		if (orch?.traces[tracePtr]) {
			const out: IMissionTraceNode[] = [];
			const visited = new Set<string>();
			const queue: string[] = [tracePtr];
			while (queue.length > 0 && out.length < maxEntries) {
				const ptr = queue.shift()!;
				if (visited.has(ptr)) {
					continue;
				}
				visited.add(ptr);
				const node = orch.traces[ptr];
				if (!node) {
					continue;
				}
				out.push(node);
				for (const parentPtr of node.parentPtrs) {
					if (!visited.has(parentPtr)) {
						queue.push(parentPtr);
					}
				}
			}
			return out;
		}
		const state = this.ensureSynchronizedState(rec);
		return expandTracePointer(state, tracePtr, maxEntries);
	}

	computeEffectiveNodeChecks(
		rec: IAdeMissionRecord,
		parsed = parseMissionMermaidDag(rec.mermaidText),
		onlyNodeId?: string,
	): Record<string, readonly IMissionNodeCheckHook[]> {
		const parsedOrch = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const out: Record<string, readonly IMissionNodeCheckHook[]> = {};
		const nodeIds = onlyNodeId
			? [onlyNodeId]
			: [...new Set([
				...parsed.nodes.filter(n => n.kind === 'task').map(n => n.id),
				...(parsedOrch?.nodes.filter(n => n.kind === 'staff').map(n => n.id) ?? []),
				...Object.keys(rec.nodeChecks ?? {}),
			])];

		for (const nid of nodeIds) {
			const dagNode = parsed.nodes.find(n => n.id === nid);
			if (dagNode?.kind === 'gate') {
				continue;
			}
			const orchNode = parsedOrch?.nodes.find(n => n.id === nid && n.kind === 'staff');
			const mermaidHooks = dagNode?.checks ?? [];
			const orchHooks = orchNode?.checks ?? [];
			const configHooks = rec.nodeChecks?.[nid] ?? [];
			const mergedById = new Map<string, IMissionNodeCheckHook>();
			for (const mh of mermaidHooks) {
				mergedById.set(mh.id, mh);
			}
			for (const oh of orchHooks) {
				mergedById.set(oh.id, oh);
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
		const rec = this.host.requireMission(missionId);
		return this.computeEffectiveNodeChecks(rec, parseMissionMermaidDag(rec.mermaidText), nodeId);
	}

	private resolveCheckExecutionTarget(
		rec: IAdeMissionRecord,
		state: IMissionRuntimeState,
		nodeId: string,
		hook: IMissionNodeCheckHook,
	): { readonly hostAlias: string; readonly cwd?: string } {
		const orchGraph = rec.orchestrationText?.trim() ? parseOrchestrationGraph(rec.orchestrationText) : undefined;
		const orchStaffNode = orchGraph && !orchGraph.error
			? orchGraph.nodes.find(n => n.id === nodeId && n.kind === 'staff')
			: undefined;
		const orchState = orchStaffNode ? this.host.ensureSynchronizedOrchestrationState(rec) : undefined;
		const orchAgentId = orchState?.nodeAgentIds[nodeId] ?? orchStaffNode?.agentId;
		const assignment = state.boundary.nodeAssignments[nodeId];
		const agentId = orchAgentId ?? assignment?.agentId;
		const agent = agentId ? this.host.projectsService?.getAgent(agentId) : undefined;
		const hostAlias = hook.hostAlias?.trim()
			|| orchStaffNode?.hostAlias?.trim()
			|| assignment?.hostAlias?.trim()
			|| (agent?.projectUri.scheme === 'aexus-ssh' ? agent.projectUri.authority : 'local');
		const isRemote = hostAlias !== 'local';

		let baseDir: string | undefined;
		if (isRemote) {
			baseDir = (agent?.projectUri.scheme === 'aexus-ssh' ? agent.projectUri.path : undefined)
				|| assignment?.remoteProjectPath?.trim();
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
		const rec = this.host.requireMission(missionId);
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

		const backend = this.host.backendService;
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
		const initialRec = this.host.requireMission(missionId);
		const initialGraph = parseMissionMermaidDag(initialRec.mermaidText);
		const initialState = this.ensureSynchronizedState(initialRec);

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
			if (this.host.inFlightCheckTokens.has(lockKey)) {
				return {
					ok: false,
					state: initialState,
					effects: [],
					code: 'INVALID_STATE',
					error: `Deterministic verification is already running for token "${params.tokenId}". Wait for it to finish.`,
				};
			}
			this.host.inFlightCheckTokens.add(lockKey);
			const activeHolderId = initialState.boundary.nodeAssignments[initialToken.nodeId]?.agentId ?? initialToken.holderAgentId;
			if (activeHolderId) {
				this.host.touchAgentActivity(activeHolderId, Date.now());
			}
			try {
				checkSuite = await this.runNodeChecks(initialRec.id, initialToken.nodeId);
			} finally {
				this.host.inFlightCheckTokens.delete(lockKey);
				if (activeHolderId) {
					this.host.touchAgentActivity(activeHolderId, Date.now());
				}
			}

			const freshRec = this.host.requireMission(initialRec.id);
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
			this.host.commitState(freshRec.id, checkTransition.state);
			if (checkTransition.effects.length > 0) {
				await this.host.executeEffects(freshRec, checkTransition.effects);
			}
			if (!checkTransition.ok) {
				return checkTransition;
			}
			verificationNote = checkSuite.summary;
		}

		const latestRec = this.host.requireMission(initialRec.id);
		const latestGraph = parseMissionMermaidDag(latestRec.mermaidText);
		const prevCompleteState = this.ensureSynchronizedState(latestRec);
		const result = completeMissionToken(prevCompleteState, latestGraph, {
			tokenId: params.tokenId,
			summary: params.summary,
			callerAgentId: params.callerAgentId,
			...(verificationNote ? { verificationNote } : {}),
		});
		if (result.ok) {
			this.host.commitState(latestRec.id, result.state);
			this.host.flushPendingDispatchesForReleasedAgents(prevCompleteState, result.state);
			await this.host.executeEffects(latestRec, result.effects);
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
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = rejectMissionToken(prevState, graph, params);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			this.host.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.host.executeEffects(rec, result.effects);
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
		const initialRec = this.host.requireMission(missionId);
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

		let initialFileMtime: number | null | undefined;
		let initialFileSignature: string | null | undefined;
		if (params.watchFile?.trim() && (this.host.backendService?.probeFileMtime || this.host.backendService?.probeFileSignature)) {
			const host = inferredHost || 'local';
			const trimmedWatch = params.watchFile.trim();
			let probeTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				const probeResult = await Promise.race([
					Promise.all([
						this.host.backendService.probeFileMtime
							? this.host.backendService.probeFileMtime(host, trimmedWatch).catch(() => undefined)
							: Promise.resolve(undefined),
						this.host.backendService.probeFileSignature
							? this.host.backendService.probeFileSignature(host, trimmedWatch).catch(() => undefined)
							: Promise.resolve(undefined),
					]),
					new Promise<readonly [undefined, undefined]>(resolve => {
						probeTimer = setTimeout(() => resolve([undefined, undefined] as const), 4_000);
					}),
				]);
				initialFileMtime = probeResult[0];
				initialFileSignature = probeResult[1];
			} finally {
				if (probeTimer !== undefined) {
					clearTimeout(probeTimer);
				}
			}
		}

		const freshRec = this.host.requireMission(missionId);
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
			if (params.watchFile?.trim() && initialFileSignature !== undefined) {
				this.host.blockedFileSignatureByTokenKey.set(`${freshRec.id}:${params.tokenId}`, initialFileSignature);
			}
			this.host.commitState(freshRec.id, result.state);
			if (result.effects.length > 0) {
				await this.host.executeEffects(this.host.requireMission(freshRec.id), result.effects);
			}
		}
		return result;
	}

	async failToken(missionId: string, params: { readonly tokenId: string; readonly reason: string; readonly callerAgentId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = failMissionToken(prevState, graph, {
			...params,
			owner: { ownerSessionId: rec.ownerSessionId, ownerTier: rec.ownerTier },
		});
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			this.host.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.host.executeEffects(rec, result.effects);
		}
		return result;
	}

	async retryToken(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly tokenId?: string; readonly nodeId?: string; readonly guidance?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = retryMissionToken(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			await this.host.executeEffects(rec, result.effects);
		}
		return result;
	}

	async escalate(missionId: string, params: { readonly callerSupervisorId: string; readonly reason: string; readonly tokenId?: string; readonly nodeId?: string; readonly isSecretary?: boolean; readonly isHumanUser?: boolean }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		if (rec.orchestrationText?.trim() && !params.isHumanUser && !params.isSecretary) {
			const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
			if (orchGraph.error) {
				const orchState = this.host.ensureSynchronizedOrchestrationState(rec);
				const callerNodeId = Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === params.callerSupervisorId)?.[0];
				const state = this.ensureSynchronizedState(rec);
				if (rec.ownerSessionId && rec.ownerSessionId !== ADE_SECRETARY_ID && rec.ownerSessionId !== params.callerSupervisorId) {
					await this.host.executeEffects(rec, [{
						kind: 'escalate_to_supervisor',
						missionId: rec.id,
						supervisorId: rec.ownerSessionId,
						nodeId: params.nodeId || callerNodeId || 'orchestration',
						tokenId: params.tokenId || '',
						reason: `[Escalated by ${callerNodeId ?? params.callerSupervisorId}] ${params.reason}`,
					}]);
					return { ok: true, state, effects: [], data: { escalatedTo: rec.ownerSessionId } };
				}
				await this.host.executeEffects(rec, [{
					kind: 'post_inbox',
					missionId: rec.id,
					nodeId: params.nodeId || callerNodeId || 'orchestration',
					title: `Engineering Escalation (${callerNodeId ?? 'staff'})`,
					message: `Escalated by \`${callerNodeId ?? params.callerSupervisorId}\`${params.tokenId ? ` for token \`${params.tokenId}\`` : ''}:\n\n${params.reason}`,
					severity: 'critical',
					senderAgentId: params.callerSupervisorId,
				}]);
				return { ok: true, state, effects: [], data: { escalatedTo: 'inbox' } };
			}
			if (!orchGraph.error && orchGraph.nodes.some(n => n.kind === 'staff')) {
				const orchState = this.host.ensureSynchronizedOrchestrationState(rec);
				const callerNodeId = Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === params.callerSupervisorId)?.[0]
					?? (params.nodeId && orchGraph.nodes.some(n => n.id === params.nodeId && n.kind === 'staff') ? params.nodeId : undefined);
				const callerNode = callerNodeId ? orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
				if (callerNode) {
					const callerTier = resolveEffectiveStaffTier(callerNode, this.host.orgConfig) ?? 99;
					const higherSuperiors = orchGraph.edges
						.filter(e => e.to === callerNode.id)
						.map(e => orchGraph.nodes.find(n => n.id === e.from && n.kind === 'staff'))
						.filter((n): n is NonNullable<typeof n> => {
							if (!n || n.id === callerNode.id) { return false; }
							const supTier = resolveEffectiveStaffTier(n, this.host.orgConfig);
							return supTier !== undefined && supTier < callerTier;
						})
						.sort((a, b) => (resolveEffectiveStaffTier(b, this.host.orgConfig) ?? 0) - (resolveEffectiveStaffTier(a, this.host.orgConfig) ?? 0));
					const targetSupNode = higherSuperiors[0];
					const targetSupAgentId = targetSupNode ? (orchState.nodeAgentIds[targetSupNode.id] ?? targetSupNode.agentId) : undefined;
					const state = this.ensureSynchronizedState(rec);
					if (targetSupNode && targetSupAgentId && targetSupAgentId !== params.callerSupervisorId) {
						await this.host.executeEffects(rec, [{
							kind: 'escalate_to_supervisor',
							missionId: rec.id,
							supervisorId: targetSupAgentId,
							nodeId: params.nodeId || callerNode.id,
							tokenId: params.tokenId || '',
							reason: `[Escalated by ${callerNode.id} (${callerNode.label})] ${params.reason}`,
						}]);
						return {
							ok: true,
							state,
							effects: [],
							data: { escalatedTo: targetSupAgentId, escalatedToNodeId: targetSupNode.id },
						};
					}
					await this.host.executeEffects(rec, [{
						kind: 'post_inbox',
						missionId: rec.id,
						nodeId: params.nodeId || callerNode.id,
						title: `Engineering Escalation (${callerNode.id})`,
						message: `Escalated by \`${callerNode.id}\` (${callerNode.label})${params.tokenId ? ` for token \`${params.tokenId}\`` : ''}:\n\n${params.reason}`,
						severity: 'critical',
						senderAgentId: params.callerSupervisorId,
					}]);
					return {
						ok: true,
						state,
						effects: [],
						data: { escalatedTo: 'human_inbox' },
					};
				}
			}
		}
		const result = escalateMissionIssue(this.ensureSynchronizedState(rec), {
			...params,
			ownerSessionId: rec.ownerSessionId,
		});
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			await this.host.executeEffects(rec, result.effects);
		}
		return result;
	}

	async resolveGate(missionId: string, params: { readonly nodeId: string; readonly decision: 'approve' | 'reject'; readonly tokenId?: string; readonly note?: string; readonly rollbackNodeId?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const result = resolveMissionGate(this.ensureSynchronizedState(rec), graph, params);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			const inbox = this.host.inboxService;
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
			await this.host.executeEffects(rec, result.effects);
		}
		return result;
	}

	async recallTokens(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly nodeIds?: readonly string[]; readonly branchRootNodeId?: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = recallMissionTokens(prevState, graph, params);
		if (result.ok) {
			this.host.commitState(rec.id, result.state);
			this.host.flushPendingDispatchesForReleasedAgents(prevState, result.state);
			await this.host.executeEffects(rec, result.effects);
		}
		return result;
	}

	async patchMermaid(missionId: string, params: { readonly caller: IMissionEngineCaller; readonly newMermaidText: string; readonly reason?: string }): Promise<IMissionEngineTransitionResult> {
		const rec = this.host.requireMission(missionId);
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const prevState = this.ensureSynchronizedState(rec);
		const result = applySafeMissionPatch(prevState, graph, params);
		if (result.ok) {
			this.host.missionService?.updateMermaid(rec.id, params.newMermaidText);
			const refreshed = this.host.requireMission(rec.id);
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
			this.host.commitState(rec.id, synchronized);
			this.host.flushPendingDispatchesForReleasedAgents(prevState, synchronized);
			const latest = this.host.requireMission(rec.id);
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
			await this.host.executeEffects(latest, hydratedEffects);
			return { ...result, state: synchronized, effects: hydratedEffects };
		}
		return result;
	}

	listTriggers(missionId: string): readonly IMissionSourceTrigger[] {
		const rec = this.host.requireMission(missionId);
		return this.ensureSynchronizedState(rec).triggers;
	}

	async setTrigger(
		missionId: string,
		triggerInput: Partial<IMissionSourceTrigger> & { readonly nodeId: string; readonly kind: IMissionSourceTrigger['kind'] },
		caller: IMissionEngineCaller,
	): Promise<{ readonly ok: boolean; readonly trigger?: IMissionSourceTrigger; readonly error?: string; readonly code?: string }> {
		const rec = this.host.requireMission(missionId);
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
		this.host.commitState(rec.id, nextState);
		return { ok: true, trigger: candidate };
	}

	async removeTrigger(
		missionId: string,
		triggerId: string,
		caller: IMissionEngineCaller,
	): Promise<{ readonly ok: boolean; readonly removedId?: string; readonly error?: string; readonly code?: string }> {
		const rec = this.host.requireMission(missionId);
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
		this.host.commitState(rec.id, nextState);
		return { ok: true, removedId: triggerId };
	}
}
