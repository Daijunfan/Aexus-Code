/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	wrapRoleDirectMessageEnvelope,
	wrapUserDirectMessageEnvelope,
} from '../../../../platform/ade/common/adeMessageEnvelope.js';
import {
	IMissionNodeAssignment,
	IMissionSupervisorBinding,
	resolveSupervisorJurisdiction,
} from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	IMissionNodeCheckHook,
	MissionCheckOnFailAction,
	parseMissionMermaidDag,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	renameNodeInMermaid,
	upsertTaskMetadataInMermaid,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionEngineCaller, IMissionSourceTrigger, parseDurationMs } from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	compileOrchestrationManifest,
	exportToOrchestrationManifest,
	validateOrchestrationManifest,
} from '../../../../platform/ade/common/adeOrchestrationConfig.js';
import {
	IOrchestrationContextBlobInput,
	IOrchestrationMintBranch,
	IOrchestrationWhiteboard,
	MissionTaskStatus,
	resolveEffectiveStaffTier,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	addOrchestrationGroup,
	connectOrchestrationEdge,
	moveOrchestrationNodeToGroup,
	OrchestrationLayoutMode,
	parseOrchestrationGraph,
	removeOrchestrationEdge,
	removeOrchestrationGroup,
	renameOrchestrationEdgeLabel,
	renameOrchestrationGroup,
	renameOrchestrationNode,
	serializeOrchestrationGraph,
	setOrchestrationLayoutInCode,
	upsertOrchestrationWhiteboardInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import {
	ADE_SECRETARY_TIER_TAG,
	formatTierTag,
} from '../../../../platform/ade/common/adeRankResize.js';
import { IAdeOrganizationConfig, normalizeAdeEngineId, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ADE_SECRETARY_ID, IAdeAgent, IAdeProjectsService } from '../common/ade.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export interface IAdeMissionControlContext {
	readonly projects: IAdeProjectsService;
	readonly sessions: IAdeSessionsService | undefined;
	readonly missionService: IAdeMissionService | undefined;
	readonly missionRuntime: IAdeMissionRuntimeService | undefined;
	readonly commandService: ICommandService | undefined;
	readonly roleConfig: IAdeOrganizationConfig;
	readonly isHumanUser: boolean;
	readonly isSecretary: boolean;
	readonly callerAgent: IAdeAgent | undefined;
	readonly callerSessionId: string | undefined;
	readonly isStrictDescendant: (candidateId: string, ancestorId: string) => boolean;
}

const MISSION_RUNTIME_ACTIONS = new Set([
	// In-graph & Orchestration Token Bus
	'token.current',
	'token.trace',
	'token.read',
	'token.history',
	'token.handoff',
	'token.mint',
	'token.split',
	'token.return',
	'token.complete',
	'token.reject',
	'token.block',
	'token.fail',
	'token.retry',
	// Off-graph strictly top-down Org APIs
	'org.subordinates',
	'org.send',
	'org.context',
	'org.escalate',
	// Engineering Mission Task DAG
	'mission.task.list',
	'mission.task.get',
	'mission.task.set',
	'mission.task.create',
	'mission.task.update',
	'mission.task.remove',
	'mission.task.edge.add',
	'mission.task.edge.remove',
	'mission.task.complete',
	'mission.task.status',
	'mission.export',
	// Engineering Orchestration (All-Staff Cyclic Graph + Lossless Groups/Layout/Migration)
	'orchestration.get',
	'orchestration.apply',
	'orchestration.validate',
	'orchestration.load',
	'orchestration.export',
	'orchestration.import',
	'orchestration.layout.set',
	'orchestration.status',
	'orchestration.pause',
	'orchestration.resume',
	'orchestration.abort',
	'orchestration.dispatch',
	'orchestration.group.list',
	'orchestration.group.create',
	'orchestration.group.rename',
	'orchestration.group.assign',
	'orchestration.group.remove',
	'orchestration.staff.create',
	'orchestration.staff.rename',
	'orchestration.staff.configure',
	'orchestration.staff.remove',
	'orchestration.edge.connect',
	'orchestration.edge.label',
	'orchestration.edge.remove',
	// Department Shared Whiteboards
	'whiteboard.list',
	'whiteboard.create',
	'whiteboard.read',
	'whiteboard.write',
	'whiteboard.rename',
	'whiteboard.remove',
	// Mission Runtime Lifecycle, Boundary, Recall, Patch, Gate, Triggers, Host Binding
	'mission.start',
	'mission.run',
	'mission.pause',
	'mission.resume',
	'mission.stop',
	'mission.status',
	'mission.timeout.set',
	'mission.boundary.get',
	'mission.boundary.set',
	'mission.recall',
	'mission.retry',
	'mission.patch',
	'mission.gate',
	'mission.trigger.list',
	'mission.trigger.set',
	'mission.trigger.remove',
	'mission.host.bind',
	'mission.prompt.list',
	'mission.prompt.get',
	'mission.prompt.set',
	'mission.check.list',
	'mission.check.get',
	'mission.check.set',
	'mission.check.remove',
	'mission.check.run',
]);

export function isAdeMissionRuntimeAction(action: string): boolean {
	return MISSION_RUNTIME_ACTIONS.has(action);
}

function findAssociatedMissionsForSession(
	sessionId: string,
	ctx: IAdeMissionControlContext,
): IAdeMissionRecord[] {
	const missions = ctx.missionService?.listMissions() ?? [];
	const matches: IAdeMissionRecord[] = [];
	const seen = new Set<string>();
	const add = (rec: IAdeMissionRecord) => {
		if (!seen.has(rec.id)) {
			seen.add(rec.id);
			matches.push(rec);
		}
	};
	for (const rec of missions) {
		if (rec.ownerSessionId === sessionId) {
			add(rec);
			continue;
		}
		const rt = ctx.missionRuntime?.getRuntimeState(rec.id);
		if (rt?.boundary.supervisors.some(s => s.id === sessionId)) {
			add(rec);
			continue;
		}
		if (rt && Object.values(rt.boundary.nodeAssignments).some(a => a.agentId === sessionId)) {
			add(rec);
			continue;
		}
		if (rec.orchestrationText?.trim()) {
			const orch = ctx.missionRuntime?.getOrchestrationState(rec.id);
			if (orch && Object.values(orch.nodeAgentIds).includes(sessionId)) {
				add(rec);
				continue;
			}
		}
	}
	const agent = ctx.projects.getAgent(sessionId);
	if (agent?.treeGovernorId) {
		const hit = ctx.missionService?.getMission(agent.treeGovernorId)
			?? ctx.missionService?.getMissionByLinkedSession(agent.treeGovernorId);
		if (hit) {
			add(hit);
		}
	}
	return matches;
}

function resolveMissionRecord(
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): IAdeMissionRecord {
	const missions = ctx.missionService;
	if (!missions) {
		throw new Error('ADE Mission service is not available.');
	}
	const explicitMissionRaw = String(params.mission ?? params.missionId ?? params.governor ?? params.governorSessionId ?? '').trim();
	if (explicitMissionRaw) {
		const hit = missions.getMission(explicitMissionRaw) ?? missions.getMissionByLinkedSession(explicitMissionRaw);
		if (hit) {
			return hit;
		}
		throw new Error(`Mission not found: ${explicitMissionRaw}`);
	}
	// Only treat `params.id` as a Mission ID if it actually matches an existing Mission — never collide with
	// entity IDs (whiteboard IDs like `WB_BE`, task IDs like `T1`, staff IDs like `Sub1`) when `--mission` is omitted!
	const candidateId = typeof params.id === 'string' ? params.id.trim() : '';
	if (candidateId) {
		const idHit = missions.getMission(candidateId) ?? missions.getMissionByLinkedSession(candidateId);
		if (idHit) {
			return idHit;
		}
	}
	if (!ctx.isHumanUser && !ctx.isSecretary) {
		if (!ctx.callerSessionId) {
			throw new Error('Mission ID (--mission) is required.');
		}
		const associated = findAssociatedMissionsForSession(ctx.callerSessionId, ctx);
		if (associated.length === 1) {
			return associated[0];
		}
		if (associated.length > 1) {
			throw new Error(`Multiple Missions are associated with your session (${associated.map(m => m.id).join(', ')}); specify --mission <id>.`);
		}
		throw new Error('No Mission is associated with your session; specify --mission <id>.');
	}
	if (ctx.isSecretary) {
		const bySec = missions.getMissionByLinkedSession(ADE_SECRETARY_ID);
		if (bySec) {
			return bySec;
		}
	}
	const all = missions.listMissions();
	if (all.length === 1) {
		return all[0];
	}
	throw new Error('Mission ID (--mission) is required.');
}

function buildEngineCaller(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord): IMissionEngineCaller {
	const callerTier = ctx.callerAgent
		? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
		: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
	return {
		isHumanUser: ctx.isHumanUser,
		isSecretary: ctx.isSecretary,
		sessionId: ctx.callerSessionId,
		tier: callerTier,
		ownerSessionId: mission.ownerSessionId,
	};
}

function assertMissionMemberOrSupervisor(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	if (!ctx.callerSessionId) {
		throw new Error(`FORBIDDEN: caller is not associated with Mission "${mission.id}".`);
	}
	const runtime = ctx.missionRuntime?.getRuntimeState(mission.id);
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}
	if (mission.ownerSessionId === ctx.callerSessionId) {
		return;
	}
	if (runtime.boundary.supervisors.some(s => s.id === ctx.callerSessionId)) {
		return;
	}
	if (Object.values(runtime.boundary.nodeAssignments).some(a => a.agentId === ctx.callerSessionId)) {
		return;
	}
	if (mission.orchestrationText?.trim()) {
		const orch = ctx.missionRuntime?.getOrchestrationState(mission.id);
		if (orch && Object.values(orch.nodeAgentIds).includes(ctx.callerSessionId)) {
			return;
		}
	}
	if (ctx.callerAgent?.treeNodeId && (ctx.callerAgent.treeGovernorId === mission.id || ctx.callerAgent.treeGovernorId === mission.ownerSessionId)) {
		return;
	}
	throw new Error(`FORBIDDEN: session "${ctx.callerSessionId}" is not a member or supervisor of Mission "${mission.id}".`);
}

function isOrchestrationBackedMission(mission: IAdeMissionRecord): boolean {
	if (!mission.orchestrationText?.trim()) {
		return false;
	}
	const parsed = parseOrchestrationGraph(mission.orchestrationText);
	return !parsed.error && parsed.nodes.some(n => n.kind === 'staff');
}

function assertNotOrchestrationLegacyAction(mission: IAdeMissionRecord, action: string, replacement: string): void {
	if (isOrchestrationBackedMission(mission)) {
		throw new Error(
			`LEGACY_API_REMOVED: "${action}" is a retired static-Mission API and cannot be used on Orchestration-backed Engineering workspace "${mission.id}". Use ${replacement} instead.`,
		);
	}
}

function assertFullMissionControlAuthority(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord, actionLabel: string): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	if (!ctx.callerSessionId) {
		throw new Error(`FORBIDDEN: cannot ${actionLabel} Mission "${mission.id}" without an authenticated supervisor/owner session.`);
	}
	if (mission.ownerSessionId === ctx.callerSessionId) {
		return;
	}
	// Top-rank Orchestration staff member (e.g. L1 Governor on canvas) holds full Engineering control authority.
	if (mission.orchestrationText?.trim() && ctx.missionRuntime && ctx.callerAgent) {
		const orch = ctx.missionRuntime.getOrchestrationState(mission.id);
		const isOnCanvas = Object.values(orch.nodeAgentIds).includes(ctx.callerSessionId);
		if (isOnCanvas) {
			const callerTier = resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier;
			const highestTier = Math.min(...ctx.roleConfig.ranks.map(r => r.tier));
			if (callerTier <= highestTier) {
				return;
			}
		}
	}
	const runtime = ctx.missionRuntime?.getRuntimeState(mission.id);
	if (runtime) {
		const graph = parseMissionMermaidDag(mission.mermaidText);
		const jur = resolveSupervisorJurisdiction(
			runtime.boundary,
			ctx.callerSessionId,
			graph.nodes.map(n => n.id),
			{ ownerSessionId: mission.ownerSessionId },
		);
		if (jur.hasFullJurisdiction) {
			return;
		}
	}
	throw new Error(`FORBIDDEN: only Human (L-1), Secretary (L0), Mission owner, or a full-jurisdiction supervisor may ${actionLabel} Mission "${mission.id}".`);
}

function assertDepartmentWhiteboardAdminAuthority(
	ctx: IAdeMissionControlContext,
	mission: IAdeMissionRecord,
	targetDepartments: readonly (string | undefined)[],
	actionLabel: string,
): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	if (!ctx.callerSessionId) {
		throw new Error(`FORBIDDEN: cannot ${actionLabel} Department Whiteboard without an authenticated session.`);
	}
	if (mission.ownerSessionId === ctx.callerSessionId) {
		return;
	}
	const callerRank = ctx.callerAgent
		? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id))
		: undefined;
	const highestTier = Math.min(...ctx.roleConfig.ranks.map(r => r.tier));
	if (callerRank && callerRank.tier <= highestTier) {
		return;
	}
	if (mission.orchestrationText?.trim() && ctx.missionRuntime && callerRank && !callerRank.pureExecution && callerRank.canHaveSubordinates) {
		const orch = ctx.missionRuntime.getOrchestrationState(mission.id);
		const callerNodeId = Object.entries(orch.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0];
		if (callerNodeId) {
			const parsed = parseOrchestrationGraph(mission.orchestrationText);
			const callerNode = parsed.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
			const callerDept = callerNode?.department?.trim();
			const isExecDept = !callerDept || /^(?:executive|hq|headquarters|leadership|company|general|all|root)$/i.test(callerDept);
			if (isExecDept) {
				return;
			}
			const nonEmptyTargets = targetDepartments.map(d => d?.trim()).filter((d): d is string => Boolean(d));
			const allSameDept = nonEmptyTargets.every(d => d.toLowerCase() === callerDept.toLowerCase());
			if (allSameDept) {
				return;
			}
			throw new Error(
				`CROSS_DEPARTMENT_FORBIDDEN: department lead "${callerNodeId}" ("${callerDept}") cannot ${actionLabel} whiteboard in foreign department (${nonEmptyTargets.join(' -> ')}).`,
			);
		}
	}
	assertFullMissionControlAuthority(ctx, mission, `${actionLabel} Department Whiteboard for`);
}

function assertStaffConfigureAuthority(
	ctx: IAdeMissionControlContext,
	mission: IAdeMissionRecord,
	targetNodeId: string,
): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	if (mission.ownerSessionId && ctx.callerSessionId === mission.ownerSessionId) {
		return;
	}
	const callerRank = ctx.callerAgent
		? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id))
		: undefined;
	const highestTier = Math.min(...ctx.roleConfig.ranks.map(r => r.tier));
	if (callerRank && callerRank.tier <= highestTier) {
		return;
	}
	// Mid-tier supervisors (e.g. L2 Manager) may configure their own strictly lower-tier direct subordinates in the same department.
	if (mission.orchestrationText?.trim() && ctx.missionRuntime && ctx.callerSessionId && callerRank && !callerRank.pureExecution && callerRank.canHaveSubordinates) {
		const orch = ctx.missionRuntime.getOrchestrationState(mission.id);
		const callerNodeId = Object.entries(orch.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0];
		if (callerNodeId && callerNodeId !== targetNodeId) {
			const parsed = parseOrchestrationGraph(mission.orchestrationText);
			const callerNode = parsed.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
			const targetNode = parsed.nodes.find(n => n.id === targetNodeId && n.kind === 'staff');
			if (callerNode && targetNode) {
				const targetTier = targetNode.tier;
				const strictlyLower = targetTier !== undefined && targetTier > callerRank.tier;
				const callerDept = callerNode.department?.trim();
				const targetDept = targetNode.department?.trim();
				const isExecDept = !callerDept || /^(?:executive|hq|headquarters|leadership|company|general|all|root)$/i.test(callerDept);
				const sameDept = isExecDept || (Boolean(targetDept) && targetDept!.toLowerCase() === callerDept!.toLowerCase());
				const hasDirectEdge = parsed.edges.some(e => e.from === callerNodeId && e.to === targetNodeId);
				if (strictlyLower && sameDept && hasDirectEdge) {
					return;
				}
				if (!strictlyLower) {
					throw new Error(`FORBIDDEN: staff "${callerNodeId}" (L${callerRank.tier}) cannot configure equal/higher-rank staff "${targetNodeId}".`);
				}
				if (!sameDept) {
					throw new Error(`CROSS_DEPARTMENT_FORBIDDEN: staff "${callerNodeId}" ("${callerDept}") cannot configure staff "${targetNodeId}" in department "${targetDept || 'Unassigned'}".`);
				}
				throw new Error(`FORBIDDEN: staff "${targetNodeId}" does not report directly to "${callerNodeId}".`);
			}
		}
	}
	assertFullMissionControlAuthority(ctx, mission, 'configure Orchestration staff node for');
}

function assertMissionTaskDesignScope(
	ctx: IAdeMissionControlContext,
	mission: IAdeMissionRecord,
	actionLabel: string,
	options?: {
		readonly targetTask?: { readonly id: string; readonly department?: string; readonly ownerNodeId?: string };
		readonly requestedDepartment?: string;
	},
): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	if (mission.ownerSessionId && ctx.callerSessionId === mission.ownerSessionId) {
		return;
	}
	const callerRank = ctx.callerAgent
		? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id))
		: undefined;
	if (!callerRank || callerRank.pureExecution || (!callerRank.canHaveSubordinates && !callerRank.allowedApis.includes('mission.design'))) {
		throw new Error(`FORBIDDEN: only top-rank or supervisory roles may ${actionLabel} Mission Task DAG nodes.`);
	}
	const highestTier = Math.min(...ctx.roleConfig.ranks.map(r => r.tier));
	if (callerRank.tier <= highestTier) {
		return;
	}
	if (!mission.orchestrationText?.trim() || !ctx.missionRuntime || !ctx.callerSessionId) {
		return;
	}
	const orch = ctx.missionRuntime.getOrchestrationState(mission.id);
	const callerNodeId = Object.entries(orch.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0];
	if (!callerNodeId) {
		return;
	}
	const parsedOrch = parseOrchestrationGraph(mission.orchestrationText);
	const callerNode = parsedOrch.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
	const callerDept = callerNode?.department?.trim();
	const isExecDept = !callerDept || /^(?:executive|hq|headquarters|leadership|company|general|all|root)$/i.test(callerDept);
	if (isExecDept) {
		return;
	}
	const reqDept = options?.requestedDepartment?.trim();
	if (reqDept && reqDept.toLowerCase() !== callerDept.toLowerCase()) {
		throw new Error(`CROSS_DEPARTMENT_FORBIDDEN: supervisor "${callerNodeId}" ("${callerDept}") cannot ${actionLabel} Mission task in foreign department "${reqDept}".`);
	}
	if (options?.targetTask) {
		const tDept = options.targetTask.department?.trim();
		if (tDept && tDept.toLowerCase() !== callerDept.toLowerCase()) {
			throw new Error(`CROSS_DEPARTMENT_FORBIDDEN: supervisor "${callerNodeId}" ("${callerDept}") cannot ${actionLabel} Mission task "${options.targetTask.id}" in foreign department "${tDept}".`);
		}
		if (options.targetTask.ownerNodeId && options.targetTask.ownerNodeId !== callerNodeId) {
			const ownerNode = parsedOrch.nodes.find(n => n.id === options.targetTask!.ownerNodeId && n.kind === 'staff');
			if (ownerNode?.tier !== undefined && ownerNode.tier < callerRank.tier) {
				throw new Error(`FORBIDDEN: supervisor "${callerNodeId}" (L${callerRank.tier}) cannot ${actionLabel} Mission task "${options.targetTask.id}" owned by superior "${ownerNode.id}" (L${ownerNode.tier}).`);
			}
		}
	}
}

function assertInGraphTokenCaller(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord, tokenId?: string): string | undefined {
	// Human (L-1) may override token actions; Secretary (L0) is off-graph and may NOT mutate in-graph tokens!
	if (ctx.isHumanUser) {
		return undefined;
	}
	if (ctx.isSecretary) {
		throw new Error('FORBIDDEN: off-graph Secretary (L0) cannot invoke in-graph token execution mutations; use mission.* or org.* commands.');
	}
	if (!ctx.callerSessionId || !ctx.callerAgent) {
		throw new Error('FORBIDDEN: token operations require an authenticated in-graph Mission node employee session.');
	}
	const runtime = ctx.missionRuntime?.getRuntimeState(mission.id);
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}
	// Reject off-graph supervisors calling in-graph token APIs.
	const isOffGraphSupervisor = runtime.boundary.supervisors.some(s => s.id === ctx.callerSessionId);
	if (isOffGraphSupervisor) {
		throw new Error('FORBIDDEN: off-graph supervisors cannot call in-graph token execution APIs; use org.* or mission.* commands.');
	}
	const isAssignedInThisMission = Object.values(runtime.boundary.nodeAssignments).some(a => a.agentId === ctx.callerSessionId)
		|| (Boolean(ctx.callerAgent.treeNodeId) && (ctx.callerAgent.treeGovernorId === mission.id || ctx.callerAgent.treeGovernorId === mission.ownerSessionId));
	if (!isAssignedInThisMission) {
		throw new Error(`FORBIDDEN: caller "${ctx.callerSessionId}" is not assigned to any node in Mission "${mission.id}".`);
	}
	if (tokenId) {
		const tok = runtime.tokens[tokenId];
		if (tok) {
			const assignedAgent = runtime.boundary.nodeAssignments[tok.nodeId]?.agentId;
			const effectiveHolder = assignedAgent ?? tok.holderAgentId;
			if (!effectiveHolder || effectiveHolder !== ctx.callerSessionId) {
				throw new Error(`FORBIDDEN: token "${tokenId}" on node "${tok.nodeId}" is not held by caller "${ctx.callerSessionId}".`);
			}
		}
	}
	return ctx.callerSessionId;
}

function resolveOrgTargetAgent(
	targetRaw: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): IAdeAgent | undefined {
	const explicitMission = String(params.mission ?? params.missionId ?? '').trim();
	if (explicitMission && ctx.missionService && ctx.missionRuntime) {
		const rec = ctx.missionService.getMission(explicitMission) ?? ctx.missionService.getMissionByLinkedSession(explicitMission);
		if (rec) {
			const orchAgentId = ctx.missionRuntime.getOrchestrationState(rec.id).nodeAgentIds[targetRaw];
			if (orchAgentId) {
				const byOrch = ctx.projects.getAgent(orchAgentId);
				if (byOrch) {
					return byOrch;
				}
			}
			const rt = ctx.missionRuntime.getRuntimeState(rec.id);
			const assignedId = rt.boundary.nodeAssignments[targetRaw]?.agentId;
			if (assignedId) {
				const byNode = ctx.projects.getAgent(assignedId);
				if (byNode) {
					return byNode;
				}
			}
		}
	}
	const direct = ctx.projects.getAgent(targetRaw)
		?? ctx.projects.agents.find(a => a.id.startsWith(targetRaw) || a.label === targetRaw);
	if (direct) {
		return direct;
	}
	// Fallback: resolve Orchestration staff node ID or DAG node ID across caller's associated mission(s)
	if (ctx.callerSessionId && ctx.missionRuntime) {
		for (const rec of findAssociatedMissionsForSession(ctx.callerSessionId, ctx)) {
			const orchAgentId = ctx.missionRuntime.getOrchestrationState(rec.id).nodeAgentIds[targetRaw];
			if (orchAgentId) {
				const byOrch = ctx.projects.getAgent(orchAgentId);
				if (byOrch) {
					return byOrch;
				}
			}
			const assignedId = ctx.missionRuntime.getRuntimeState(rec.id).boundary.nodeAssignments[targetRaw]?.agentId;
			if (assignedId) {
				const byNode = ctx.projects.getAgent(assignedId);
				if (byNode) {
					return byNode;
				}
			}
		}
	}
	return undefined;
}

function assertSupervisorHasAuthorityOverTarget(
	ctx: IAdeMissionControlContext,
	targetAgent: IAdeAgent,
): { readonly authorized: boolean; readonly viaMissionId?: string; readonly reason?: string } {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return { authorized: true };
	}
	if (!ctx.callerAgent || !ctx.callerSessionId) {
		return { authorized: false, reason: 'Caller session could not be identified.' };
	}
	if (targetAgent.id === ctx.callerAgent.id) {
		return { authorized: false, reason: 'UPWARD_MESSAGE_FORBIDDEN: cannot send org messages to yourself.' };
	}

	const callerTier = resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier;
	const targetTier = resolveEffectiveRankDefinition(ctx.roleConfig, targetAgent.role, ctx.projects.hasSubordinates(targetAgent.id)).tier;

	// Hard top-down iron law: lower number = higher authority. Strictly forbid equal or upward direction!
	if (callerTier >= targetTier) {
		return {
			authorized: false,
			reason: `UPWARD_MESSAGE_FORBIDDEN: strictly top-down communication only. Caller (L${callerTier}) cannot message/inspect target "${targetAgent.label}" (L${targetTier}). Subordinates must report via token.* or org.escalate.`,
		};
	}

	// 1. Direct or transitive hierarchy subtree check
	if (ctx.isStrictDescendant(targetAgent.id, ctx.callerAgent.id)) {
		return { authorized: true };
	}

	// 2. Orchestration graph downward reachability + Mission off-graph jurisdiction check
	const missions = ctx.missionService?.listMissions() ?? [];
	for (const rec of missions) {
		if (rec.orchestrationText?.trim() && ctx.missionRuntime) {
			const orchState = ctx.missionRuntime.getOrchestrationState(rec.id);
			let callerNodeId: string | undefined;
			let targetNodeId: string | undefined;
			for (const [nid, aid] of Object.entries(orchState.nodeAgentIds)) {
				if (aid === ctx.callerSessionId) { callerNodeId = nid; }
				if (aid === targetAgent.id) { targetNodeId = nid; }
			}
			if (callerNodeId && targetNodeId) {
				const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
				const callerNode = orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
				const targetNode = orchGraph.nodes.find(n => n.id === targetNodeId && n.kind === 'staff');
				const deptMatch = !callerNode?.department
					|| /^(?:executive|hq|headquarters|leadership|company|general|all|root)$/i.test(callerNode.department.trim())
					|| !targetNode?.department
					|| callerNode.department.trim().toLowerCase() === targetNode.department.trim().toLowerCase();
				if (deptMatch) {
					// BFS strictly downward along Orchestration edges
					const visited = new Set<string>([callerNodeId]);
					const queue: string[] = [callerNodeId];
					while (queue.length > 0) {
						const cur = queue.shift()!;
						const curNode = orchGraph.nodes.find(n => n.id === cur && n.kind === 'staff');
						for (const e of orchGraph.edges) {
							if (e.from !== cur || visited.has(e.to)) { continue; }
							const nxt = orchGraph.nodes.find(n => n.id === e.to && n.kind === 'staff');
							if (!nxt) { continue; }
							if (curNode?.tier !== undefined && nxt.tier !== undefined && nxt.tier <= curNode.tier) {
								continue;
							}
							if (nxt.id === targetNodeId) {
								return { authorized: true, viaMissionId: rec.id };
							}
							visited.add(nxt.id);
							queue.push(nxt.id);
						}
					}
				}
			}
		}

		const rt = ctx.missionRuntime?.getRuntimeState(rec.id);
		if (!rt) {
			continue;
		}
		const graph = parseMissionMermaidDag(rec.mermaidText);
		const jur = resolveSupervisorJurisdiction(
			rt.boundary,
			ctx.callerSessionId,
			graph.nodes.map(n => n.id),
			{ ownerSessionId: rec.ownerSessionId },
		);
		if (jur.supervisorIds.has(targetAgent.id)) {
			return { authorized: true, viaMissionId: rec.id };
		}
		for (const nid of jur.nodeIds) {
			if (rt.boundary.nodeAssignments[nid]?.agentId === targetAgent.id) {
				return { authorized: true, viaMissionId: rec.id };
			}
		}
	}

	return {
		authorized: false,
		reason: `OUT_OF_JURISDICTION: target "${targetAgent.label}" (${targetAgent.id}) is outside your subordinate tree and off-graph Mission jurisdiction.`,
	};
}

function assertOrchestrationTokenCaller(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord, tokenId?: string): string | undefined {
	if (ctx.isHumanUser) {
		return undefined;
	}
	if (!ctx.callerSessionId || !ctx.callerAgent) {
		throw new Error('FORBIDDEN: Orchestration token operations require an authenticated staff session.');
	}
	const orch = ctx.missionRuntime?.getOrchestrationState(mission.id);
	if (!orch) {
		throw new Error('ADE Mission runtime service is not available.');
	}
	if (tokenId) {
		const tok = orch.tokens[tokenId];
		if (tok) {
			const holder = orch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
			if (holder && holder !== ctx.callerSessionId) {
				throw new Error(`FORBIDDEN: Orchestration token "${tokenId}" on staff node "${tok.nodeId}" is not held by caller "${ctx.callerSessionId}".`);
			}
		}
	}
	return ctx.callerSessionId;
}

function findMissionByTokenId(ctx: IAdeMissionControlContext, tokenId: string): IAdeMissionRecord | undefined {
	for (const rec of ctx.missionService?.listMissions() ?? []) {
		if (rec.orchestrationRuntime?.tokens[tokenId]) {
			return rec;
		}
		const rt = ctx.missionRuntime?.getRuntimeState(rec.id);
		if (rt?.tokens[tokenId]) {
			return rec;
		}
	}
	return undefined;
}

export async function executeAdeMissionRuntimeAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): Promise<unknown> {
	const runtime = ctx.missionRuntime;
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}

	switch (action) {
		// =====================================================================
		// In-Graph Token Bus (`token.*`)
		// =====================================================================
		case 'token.current': {
			const explicitMissionId = typeof (params.mission ?? params.missionId) === 'string'
				? String(params.mission ?? params.missionId).trim()
				: undefined;
			const explicitAgentId = (ctx.isHumanUser || ctx.isSecretary) && typeof (params.agent ?? params.agentId) === 'string'
				? String(params.agent ?? params.agentId).trim()
				: undefined;

			if (!ctx.isHumanUser && !ctx.isSecretary) {
				const mission = resolveMissionRecord(params, ctx);
				const orchState = runtime.getOrchestrationState(mission.id);
				const orchTokens = runtime.getCurrentOrchestrationTokens(ctx.callerSessionId!, mission.id).map(t => ({
					...t,
					delta: runtime.getOrchestrationTokenDelta(mission.id, t.id),
					...(t.joinBarrierId && orchState.joinBarriers?.[t.joinBarrierId] ? { joinBarrier: orchState.joinBarriers[t.joinBarrierId] } : {}),
				}));
				if (orchTokens.length > 0 || isOrchestrationBackedMission(mission)) {
					const legacyTokens = runtime.getCurrentTokens(ctx.callerSessionId!, mission.id);
					return { missionId: mission.id, agentId: ctx.callerSessionId, tokens: [...orchTokens, ...legacyTokens] };
				}
				assertInGraphTokenCaller(ctx, mission);
				const tokens = runtime.getCurrentTokens(ctx.callerSessionId!, mission.id);
				return { missionId: mission.id, agentId: ctx.callerSessionId, tokens };
			}

			if (explicitAgentId) {
				const orchTokens = runtime.getCurrentOrchestrationTokens(explicitAgentId, explicitMissionId);
				const tokens = runtime.getCurrentTokens(explicitAgentId, explicitMissionId);
				return { missionId: explicitMissionId, agentId: explicitAgentId, tokens: [...orchTokens, ...tokens] };
			}
			const mission = resolveMissionRecord(params, ctx);
			const state = runtime.getRuntimeState(mission.id);
			const orch = runtime.getOrchestrationState(mission.id);
			const orchTokens = Object.values(orch.tokens)
				.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join')
				.map(t => ({
					...t,
					...(t.joinBarrierId && orch.joinBarriers?.[t.joinBarrierId] ? { joinBarrier: orch.joinBarriers[t.joinBarrierId] } : {}),
				}));
			const tokens = Object.values(state.tokens).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed');
			return { missionId: mission.id, tokens: [...orchTokens, ...tokens] };
		}

		case 'token.handoff': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const summary = String(params.summary ?? params.message ?? '').trim();
			const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
			const rawTo = params.toNodeIds ?? params.to ?? params.target ?? params.targets;
			const toNodeIds = Array.isArray(rawTo)
				? rawTo.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawTo === 'string' ? rawTo.split(',').map(s => s.trim()).filter(Boolean) : []);
			const rawWb = params.whiteboardIds ?? params.whiteboards ?? params.whiteboard;
			const whiteboardIds = Array.isArray(rawWb)
				? rawWb.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawWb === 'string' ? rawWb.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const rawRefs = params.refPtrs ?? params.refs ?? params.ref;
			const refPtrs = Array.isArray(rawRefs)
				? rawRefs.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawRefs === 'string' ? rawRefs.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const parseBlobInputs = (raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined => {
				if (!Array.isArray(raw)) {
					return undefined;
				}
				const out: IOrchestrationContextBlobInput[] = [];
				for (const item of raw) {
					if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
						out.push({
							title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '',
							content: (item as { content: string }).content,
						});
					}
				}
				return out.length > 0 ? out : undefined;
			};
			const artifacts = parseBlobInputs(params.artifacts);
			const decisions = parseBlobInputs(params.decisions);
			if (!tokenId) {
				throw new Error('Token ID is required for token.handoff.');
			}
			if (toNodeIds.length === 0) {
				throw new Error('At least one target staff node (--to) is required for token.handoff.');
			}
			if (!summary) {
				throw new Error('A plain-text factual --summary is required for token.handoff.');
			}
			const skipChecks = params.skipChecks === true;
			if (skipChecks && !ctx.isHumanUser) {
				throw new Error('FORBIDDEN: only Human User (L-1) may bypass automated verification checks with --skip-checks.');
			}
			const taskNodeId = typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
				? String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
				: undefined;
			const rawTaskIds = params.taskNodeIds ?? params.tasks;
			const taskNodeIds = Array.isArray(rawTaskIds)
				? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
			const rawModifiedFiles = params.modifiedFiles ?? params.files;
			const modifiedFiles = Array.isArray(rawModifiedFiles)
				? rawModifiedFiles.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawModifiedFiles === 'string' ? rawModifiedFiles.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const res = await runtime.handoffOrchestrationToken(mission.id, {
				tokenId,
				toNodeIds,
				summary,
				...(detail ? { detail } : {}),
				...(taskNodeId ? { taskNodeId } : {}),
				...(taskNodeIds && taskNodeIds.length > 0 ? { taskNodeIds } : {}),
				whiteboardIds,
				...(artifacts ? { artifacts } : {}),
				...(decisions ? { decisions } : {}),
				...(refPtrs ? { refPtrs } : {}),
				...(modifiedFiles && modifiedFiles.length > 0 ? { modifiedFiles } : {}),
				callerAgentId,
				...(skipChecks ? { skipChecks: true } : {}),
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to hand off token ${tokenId}`);
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'token.mint':
		case 'token.split': {
			const rawParentTokenId = String(params.parentTokenId ?? params.tokenId ?? params.token ?? params.id ?? '').trim();
			const isRootMint = !rawParentTokenId || rawParentTokenId.toLowerCase() === 'root' || rawParentTokenId.toLowerCase() === 'new';
			const parentTokenId = isRootMint ? undefined : rawParentTokenId;
			const fromNodeId = typeof (params.fromNodeId ?? params.from ?? params.origin) === 'string' && String(params.fromNodeId ?? params.from ?? params.origin).trim()
				? String(params.fromNodeId ?? params.from ?? params.origin).trim()
				: undefined;
			const waveSummary = typeof params.waveSummary === 'string' && params.waveSummary.trim() ? params.waveSummary.trim() : undefined;
			const parseBlobList = (raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined => {
				if (!Array.isArray(raw)) {
					return undefined;
				}
				const out: IOrchestrationContextBlobInput[] = [];
				for (const item of raw) {
					if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
						out.push({
							title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '',
							content: (item as { content: string }).content,
						});
					}
				}
				return out.length > 0 ? out : undefined;
			};
			const parseStrList = (raw: unknown): readonly string[] | undefined => {
				if (Array.isArray(raw)) {
					const list = raw.map(v => String(v).trim()).filter(Boolean);
					return list.length > 0 ? list : undefined;
				}
				if (typeof raw === 'string' && raw.trim()) {
					const list = raw.split(',').map(s => s.trim()).filter(Boolean);
					return list.length > 0 ? list : undefined;
				}
				return undefined;
			};

			let rawBranches: unknown = params.branches;
			if (!rawBranches && typeof params.branchesJson === 'string' && params.branchesJson.trim()) {
				try {
					rawBranches = JSON.parse(params.branchesJson);
				} catch (err) {
					throw new Error(`Invalid --branches-json payload: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			const branches: IOrchestrationMintBranch[] = [];
			if (Array.isArray(rawBranches) && rawBranches.length > 0) {
				for (const item of rawBranches) {
					if (!item || typeof item !== 'object') {
						continue;
					}
					const b = item as Record<string, unknown>;
					const toNodeId = String(b.toNodeId ?? b.to ?? b.target ?? '').trim();
					const summary = String(b.summary ?? b.message ?? '').trim();
					branches.push({
						toNodeId,
						summary,
						...(typeof b.detail === 'string' && b.detail.trim() ? { detail: b.detail } : {}),
						...(typeof (b.taskNodeId ?? b.task) === 'string' && String(b.taskNodeId ?? b.task).trim()
							? { taskNodeId: String(b.taskNodeId ?? b.task).trim() }
							: {}),
						...(parseStrList(b.taskNodeIds ?? b.tasks) ? { taskNodeIds: parseStrList(b.taskNodeIds ?? b.tasks) } : {}),
						...(parseStrList(b.whiteboardIds ?? b.whiteboards ?? b.whiteboard) ? { whiteboardIds: parseStrList(b.whiteboardIds ?? b.whiteboards ?? b.whiteboard) } : {}),
						...(parseBlobList(b.artifacts) ? { artifacts: parseBlobList(b.artifacts) } : {}),
						...(parseBlobList(b.decisions) ? { decisions: parseBlobList(b.decisions) } : {}),
						...(parseStrList(b.refPtrs ?? b.refs ?? b.ref) ? { refPtrs: parseStrList(b.refPtrs ?? b.refs ?? b.ref) } : {}),
					});
				}
			} else {
				const targets = parseStrList(params.toNodeIds ?? params.to ?? params.target) ?? [];
				const summary = String(params.summary ?? params.message ?? '').trim();
				const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
				const taskNodeId = typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
					? String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
					: undefined;
				const taskNodeIds = parseStrList(params.taskNodeIds ?? params.tasks);
				const whiteboardIds = parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard);
				const artifacts = parseBlobList(params.artifacts);
				const decisions = parseBlobList(params.decisions);
				const refPtrs = parseStrList(params.refPtrs ?? params.refs ?? params.ref);
				for (const toNodeId of targets) {
					branches.push({
						toNodeId,
						summary,
						...(detail ? { detail } : {}),
						...(taskNodeId ? { taskNodeId } : {}),
						...(taskNodeIds ? { taskNodeIds } : {}),
						...(whiteboardIds ? { whiteboardIds } : {}),
						...(artifacts ? { artifacts } : {}),
						...(decisions ? { decisions } : {}),
						...(refPtrs ? { refPtrs } : {}),
					});
				}
			}

			if (branches.length === 0) {
				throw new Error(`At least one branch (--to <nodeId> --summary "..." or --branches-json '[...]') is required for ${action}.`);
			}
			const waitJoin = params.waitJoin !== undefined
				? params.waitJoin === true
				: (action === 'token.split' && params.noWaitJoin !== true);
			const joinMode = params.joinMode === 'any' ? 'any' : 'all';
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: ((parentTokenId ? findMissionByTokenId(ctx, parentTokenId) : undefined) ?? resolveMissionRecord(params, ctx));
			if (isRootMint) {
				assertMissionMemberOrSupervisor(ctx, mission);
			}
			const callerAgentId = parentTokenId
				? assertOrchestrationTokenCaller(ctx, mission, parentTokenId)
				: (ctx.isHumanUser || ctx.isSecretary ? undefined : assertOrchestrationTokenCaller(ctx, mission));
			const res = await runtime.mintOrchestrationTokens(mission.id, {
				...(parentTokenId ? { parentTokenId } : {}),
				...(fromNodeId ? { fromNodeId } : {}),
				...(waveSummary ? { waveSummary } : {}),
				branches,
				waitJoin,
				joinMode,
				callerAgentId,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to mint sub-task token(s)${parentTokenId ? ` from ${parentTokenId}` : ''}`);
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'token.return': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const summary = String(params.summary ?? params.message ?? '').trim();
			const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
			const toNodeId = typeof (params.toNodeId ?? params.to ?? params.target) === 'string' && String(params.toNodeId ?? params.to ?? params.target).trim()
				? String(params.toNodeId ?? params.to ?? params.target).trim()
				: undefined;
			const skipChecks = params.skipChecks === true;
			if (!tokenId) {
				throw new Error('Token ID is required for token.return.');
			}
			if (!summary) {
				throw new Error('A concise factual --summary is required for token.return.');
			}
			if (skipChecks && !ctx.isHumanUser) {
				throw new Error('FORBIDDEN: only Human User (L-1) may bypass automated verification checks with --skip-checks.');
			}
			const rawWb = params.whiteboardIds ?? params.whiteboards ?? params.whiteboard;
			const whiteboardIds = Array.isArray(rawWb)
				? rawWb.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawWb === 'string' ? rawWb.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const rawRefs = params.refPtrs ?? params.refs ?? params.ref;
			const refPtrs = Array.isArray(rawRefs)
				? rawRefs.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawRefs === 'string' ? rawRefs.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const parseBlobInputs = (raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined => {
				if (!Array.isArray(raw)) { return undefined; }
				const out: IOrchestrationContextBlobInput[] = [];
				for (const item of raw) {
					if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
						out.push({
							title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '',
							content: (item as { content: string }).content,
						});
					}
				}
				return out.length > 0 ? out : undefined;
			};
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
			const rawModifiedFiles = params.modifiedFiles ?? params.files;
			const modifiedFiles = Array.isArray(rawModifiedFiles)
				? rawModifiedFiles.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawModifiedFiles === 'string' ? rawModifiedFiles.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const res = await runtime.returnOrchestrationToken(mission.id, {
				tokenId,
				...(toNodeId ? { toNodeId } : {}),
				summary,
				...(detail ? { detail } : {}),
				whiteboardIds,
				...(parseBlobInputs(params.artifacts) ? { artifacts: parseBlobInputs(params.artifacts) } : {}),
				...(parseBlobInputs(params.decisions) ? { decisions: parseBlobInputs(params.decisions) } : {}),
				...(refPtrs ? { refPtrs } : {}),
				...(modifiedFiles && modifiedFiles.length > 0 ? { modifiedFiles } : {}),
				callerAgentId,
				...(skipChecks ? { skipChecks: true } : {}),
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to return token ${tokenId}`);
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'token.read': {
			const rawPtrs = params.ptrs ?? params.ptr ?? params.pointers ?? params.pointer;
			const ptrs = Array.isArray(rawPtrs)
				? rawPtrs.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawPtrs === 'string' ? rawPtrs.split(',').map(s => s.trim()).filter(Boolean) : []);
			if (ptrs.length === 0) {
				throw new Error('At least one pointer ID (e.g. hop-1, art-1, dec-1, wb:WB_BE) is required for token.read.');
			}
			const tokenId = typeof (params.tokenId ?? params.token) === 'string' ? String(params.tokenId ?? params.token).trim() : undefined;
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: ((tokenId ? findMissionByTokenId(ctx, tokenId) : undefined) ?? resolveMissionRecord(params, ctx));
			assertMissionMemberOrSupervisor(ctx, mission);
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = runtime.readOrchestrationTokenPointersAsync
				? await runtime.readOrchestrationTokenPointersAsync(mission.id, {
					ptrs,
					tokenId,
					caller: {
						isHumanUser: ctx.isHumanUser,
						isSecretary: ctx.isSecretary,
						callerTier,
						callerAgentId: ctx.callerSessionId,
					},
				})
				: runtime.readOrchestrationTokenPointers(mission.id, {
					ptrs,
					tokenId,
					caller: {
						isHumanUser: ctx.isHumanUser,
						isSecretary: ctx.isSecretary,
						callerTier,
						callerAgentId: ctx.callerSessionId,
					},
				});
			return {
				ok: true,
				missionId: mission.id,
				count: res.items.length,
				items: res.items,
			};
		}

		case 'token.history': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			if (!tokenId) {
				throw new Error('Token ID is required for token.history.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			assertMissionMemberOrSupervisor(ctx, mission);
			const includeAll = params.deltaOnly === true || params.includeAll === false || params.all === false
				? false
				: true;
			const history = runtime.getOrchestrationTokenHistoryAsync
				? await runtime.getOrchestrationTokenHistoryAsync(mission.id, tokenId, { includeAll })
				: runtime.getOrchestrationTokenHistory(mission.id, tokenId, { includeAll });
			if (!history.ok) {
				throw new Error(history.error ?? `Orchestration token "${tokenId}" not found.`);
			}
			return {
				missionId: mission.id,
				...history,
			};
		}

		case 'token.trace': {
			const tracePtr = String(params.tracePtr ?? params.ptr ?? params.trace ?? '').trim();
			if (!tracePtr) {
				throw new Error('Trace pointer (tracePtr) is required.');
			}
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;
			const trace = runtime.expandTrace(mission.id, tracePtr, limit);
			return { missionId: mission.id, tracePtr, count: trace.length, entries: trace };
		}

		case 'token.complete': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const summary = String(params.summary ?? params.message ?? '').trim();
			const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
			const skipChecks = params.skipChecks === true;
			if (!tokenId) {
				throw new Error('Token ID is required for token.complete.');
			}
			if (!summary) {
				throw new Error('A plain-text factual --summary is required for token.complete.');
			}
			if (skipChecks && !ctx.isHumanUser) {
				throw new Error('FORBIDDEN: only Human User (L-1) may bypass deterministic node verification hooks with --skip-checks.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			// Transparently support Orchestration baton tokens (`otok-*`) alongside legacy DAG tokens (`tok-*`).
			if (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-')) {
				const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
				const rawTo = params.toNodeIds ?? params.to ?? params.target;
				const toNodeIds = Array.isArray(rawTo)
					? rawTo.map(v => String(v).trim()).filter(Boolean)
					: (typeof rawTo === 'string' ? rawTo.split(',').map(s => s.trim()).filter(Boolean) : undefined);
				const rawWb = params.whiteboardIds ?? params.whiteboards ?? params.whiteboard;
				const whiteboardIds = Array.isArray(rawWb)
					? rawWb.map(v => String(v).trim()).filter(Boolean)
					: (typeof rawWb === 'string' ? rawWb.split(',').map(s => s.trim()).filter(Boolean) : undefined);
				const rawRefs = params.refPtrs ?? params.refs ?? params.ref;
				const refPtrs = Array.isArray(rawRefs)
					? rawRefs.map(v => String(v).trim()).filter(Boolean)
					: (typeof rawRefs === 'string' ? rawRefs.split(',').map(s => s.trim()).filter(Boolean) : undefined);
				const parseBlobInputs = (raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined => {
					if (!Array.isArray(raw)) {
						return undefined;
					}
					const out: IOrchestrationContextBlobInput[] = [];
					for (const item of raw) {
						if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
							out.push({
								title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '',
								content: (item as { content: string }).content,
							});
						}
					}
					return out.length > 0 ? out : undefined;
				};
				const taskNodeId = typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
					? String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
					: undefined;
				const rawTaskIds = params.taskNodeIds ?? params.tasks;
				const taskNodeIds = Array.isArray(rawTaskIds)
					? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
					: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
				const rawModifiedFiles = params.modifiedFiles ?? params.files;
				const modifiedFiles = Array.isArray(rawModifiedFiles)
					? rawModifiedFiles.map(v => String(v).trim()).filter(Boolean)
					: (typeof rawModifiedFiles === 'string' ? rawModifiedFiles.split(',').map(s => s.trim()).filter(Boolean) : undefined);
				const res = await runtime.completeOrchestrationToken(mission.id, {
					tokenId,
					summary,
					...(detail ? { detail } : {}),
					toNodeIds,
					...(taskNodeId ? { taskNodeId } : {}),
					...(taskNodeIds && taskNodeIds.length > 0 ? { taskNodeIds } : {}),
					whiteboardIds,
					...(parseBlobInputs(params.artifacts) ? { artifacts: parseBlobInputs(params.artifacts) } : {}),
					...(parseBlobInputs(params.decisions) ? { decisions: parseBlobInputs(params.decisions) } : {}),
					...(refPtrs ? { refPtrs } : {}),
					...(modifiedFiles && modifiedFiles.length > 0 ? { modifiedFiles } : {}),
					finish: params.finish === true,
					callerAgentId,
					...(skipChecks ? { skipChecks: true } : {}),
				});
				if (!res.ok) {
					throw new Error(res.error ?? `Failed to complete Orchestration token ${tokenId}`);
				}
				return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
			}
			const callerAgentId = assertInGraphTokenCaller(ctx, mission, tokenId);
			const res = await runtime.completeToken(mission.id, { tokenId, summary, callerAgentId, ...(skipChecks ? { skipChecks: true } : {}) });
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to complete token ${tokenId}`);
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'token.reject': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const reason = String(params.reason ?? params.feedback ?? params.message ?? '').trim();
			const targetNodeId = typeof (params.target ?? params.targetNode ?? params.targetNodeId ?? params.to) === 'string'
				? String(params.target ?? params.targetNode ?? params.targetNodeId ?? params.to).trim()
				: undefined;
			if (!tokenId) {
				throw new Error('Token ID is required for token.reject.');
			}
			if (!reason) {
				throw new Error('Rejection --reason is required for token.reject.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			if (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-')) {
				throw new Error(
					`LEGACY_API_REMOVED: "token.reject" is retired on Orchestration tokens ("${tokenId}"). Use "aexus-ade token handoff ${tokenId} --to <nodeId> --summary ..." to route revisions, or "aexus-ade token return ${tokenId} --summary ..." to report upward.`,
				);
			}
			const callerAgentId = assertInGraphTokenCaller(ctx, mission, tokenId);
			const res = await runtime.rejectToken(mission.id, { tokenId, reason, targetNodeId, callerAgentId });
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to reject token ${tokenId}`);
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'token.block': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const reason = String(params.reason ?? params.message ?? '').trim() || 'Long-running task in progress';
			const maxDuration = (params.maxDuration ?? params.max ?? params.duration) as string | number | undefined;
			const rawPid = params.watchPid ?? params.pid;
			const watchPid = typeof rawPid === 'number'
				? rawPid
				: (typeof rawPid === 'string' && /^\d+$/.test(rawPid.trim()) ? Number(rawPid.trim()) : undefined);
			const watchFile = typeof (params.watchFile ?? params.file) === 'string' && String(params.watchFile ?? params.file).trim()
				? String(params.watchFile ?? params.file).trim()
				: undefined;
			const hostAlias = typeof (params.host ?? params.hostAlias) === 'string' && String(params.host ?? params.hostAlias).trim()
				? String(params.host ?? params.hostAlias).trim()
				: undefined;
			if (!tokenId) {
				throw new Error('Token ID is required for token.block.');
			}
			if (maxDuration === undefined || maxDuration === null || String(maxDuration).trim() === '') {
				throw new Error('Maximum wait duration (--max, e.g. "2h", "30m") is required for token.block.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			if (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-')) {
				const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
				const res = await runtime.blockOrchestrationToken(mission.id, {
					tokenId,
					reason,
					maxDuration,
					watchPid,
					watchFile,
					hostAlias,
					callerAgentId,
				});
				if (!res.ok) {
					throw new Error(res.error ?? `Failed to block Orchestration token ${tokenId}`);
				}
				return { ok: true, missionId: mission.id, token: res.state.tokens[tokenId] };
			}
			const callerAgentId = assertInGraphTokenCaller(ctx, mission, tokenId);
			const res = await runtime.blockToken(mission.id, {
				tokenId,
				reason,
				maxDuration,
				watchPid,
				watchFile,
				hostAlias,
				callerAgentId,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to block token ${tokenId}`);
			}
			return { ok: true, missionId: mission.id, token: res.state.tokens[tokenId] };
		}

		case 'token.fail': {
			const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
			const reason = String(params.reason ?? params.message ?? '').trim();
			if (!tokenId) {
				throw new Error('Token ID is required for token.fail.');
			}
			if (!reason) {
				throw new Error('Failure --reason is required for token.fail.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			if (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-')) {
				const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
				const res = await runtime.failOrchestrationToken(mission.id, { tokenId, reason, callerAgentId });
				if (!res.ok) {
					throw new Error(res.error ?? `Failed to report failure on Orchestration token ${tokenId}`);
				}
				return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
			}
			const callerAgentId = assertInGraphTokenCaller(ctx, mission, tokenId);
			const res = await runtime.failToken(mission.id, { tokenId, reason, callerAgentId });
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to report failure on token ${tokenId}`);
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		// =====================================================================
		// Off-Graph Strictly Top-Down Org APIs (`org.*`)
		// =====================================================================
		case 'org.subordinates': {
			const supervisorId = (ctx.isHumanUser || ctx.isSecretary) && typeof (params.id ?? params.supervisorId) === 'string' && String(params.id ?? params.supervisorId).trim()
				? String(params.id ?? params.supervisorId).trim()
				: ctx.callerSessionId;

			const directTreeSubordinates = supervisorId && supervisorId !== ADE_SECRETARY_ID
				? ctx.projects.getDirectSubordinates(supervisorId)
				: (ctx.isHumanUser || ctx.isSecretary
					? ctx.projects.agents.filter(a => !a.parentId && !ctx.projects.isArchived(a.id))
					: []);

			const explicitMissionRaw = String(params.mission ?? params.missionId ?? '').trim();
			const candidateMissions = explicitMissionRaw
				? [resolveMissionRecord(params, ctx)]
				: (ctx.missionService?.listMissions() ?? []);

			const missionJurisdictions: {
				readonly missionId: string;
				readonly missionTitle: string;
				readonly managedNodeIds: readonly string[];
				readonly subordinateSupervisorIds: readonly string[];
				readonly orchestrationSubordinates?: readonly {
					readonly nodeId: string;
					readonly agentId?: string;
					readonly label: string;
					readonly roleLabel?: string;
					readonly tier?: number;
					readonly department?: string;
					readonly status: string;
				}[];
			}[] = [];

			const allOrchSubordinates: {
				readonly missionId: string;
				readonly nodeId: string;
				readonly agentId?: string;
				readonly label: string;
				readonly roleLabel?: string;
				readonly tier?: number;
				readonly department?: string;
				readonly status: string;
			}[] = [];

			for (const rec of candidateMissions) {
				const rt = runtime.getRuntimeState(rec.id);
				const graph = parseMissionMermaidDag(rec.mermaidText);
				const jur = resolveSupervisorJurisdiction(
					rt.boundary,
					supervisorId ?? '',
					graph.nodes.map(n => n.id),
					{ isHumanUser: ctx.isHumanUser, isSecretary: ctx.isSecretary, ownerSessionId: rec.ownerSessionId },
				);

				// Collect downward-reachable Orchestration staff subordinates (zero off-graph barrier!)
				const orchSubsForMission: {
					readonly nodeId: string;
					readonly agentId?: string;
					readonly label: string;
					readonly roleLabel?: string;
					readonly tier?: number;
					readonly department?: string;
					readonly status: string;
				}[] = [];
				if (rec.orchestrationText?.trim()) {
					const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
					if (!orchGraph.error) {
						const orchState = runtime.getOrchestrationState(rec.id);
						const staffNodes = orchGraph.nodes.filter(n => n.kind === 'staff');
						if (ctx.isHumanUser || ctx.isSecretary) {
							for (const n of staffNodes) {
								const aid = orchState.nodeAgentIds[n.id] ?? n.agentId;
								const ag = aid ? ctx.projects.getAgent(aid) : undefined;
								orchSubsForMission.push({
									nodeId: n.id,
									...(aid ? { agentId: aid } : {}),
									label: n.label,
									...(n.rankId ? { roleLabel: n.rankId } : {}),
									...(resolveEffectiveStaffTier(n, ctx.roleConfig) !== undefined ? { tier: resolveEffectiveStaffTier(n, ctx.roleConfig) } : {}),
									...(n.department ? { department: n.department } : {}),
									status: orchState.nodeStates[n.id] ?? (ag?.session ? (ag.status ?? 'idle') : 'draft'),
								});
							}
						} else if (supervisorId) {
							const callerNodeId = Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === supervisorId)?.[0];
							if (callerNodeId) {
								const callerNode = staffNodes.find(n => n.id === callerNodeId);
								const callerTier = resolveEffectiveStaffTier(callerNode, ctx.roleConfig);
								const callerDept = callerNode?.department?.trim();
								const isExecDept = !callerDept || /^(?:executive|hq|headquarters|leadership|company|general|all|root)$/i.test(callerDept);
								const visited = new Set<string>([callerNodeId]);
								const queue: string[] = [callerNodeId];
								while (queue.length > 0) {
									const cur = queue.shift()!;
									const curNode = staffNodes.find(n => n.id === cur);
									const curTier = resolveEffectiveStaffTier(curNode, ctx.roleConfig);
									for (const e of orchGraph.edges) {
										if (e.from !== cur || visited.has(e.to)) {
											continue;
										}
										const nxt = staffNodes.find(n => n.id === e.to);
										if (!nxt) {
											continue;
										}
										const nxtTier = resolveEffectiveStaffTier(nxt, ctx.roleConfig);
										if (curTier !== undefined && nxtTier !== undefined && nxtTier <= curTier) {
											continue;
										}
										if (callerTier !== undefined && nxtTier !== undefined && nxtTier <= callerTier) {
											continue;
										}
										if (!isExecDept && nxt.department && nxt.department.trim().toLowerCase() !== callerDept.toLowerCase()) {
											continue;
										}
										visited.add(nxt.id);
										queue.push(nxt.id);
										const aid = orchState.nodeAgentIds[nxt.id] ?? nxt.agentId;
										const ag = aid ? ctx.projects.getAgent(aid) : undefined;
										orchSubsForMission.push({
											nodeId: nxt.id,
											...(aid ? { agentId: aid } : {}),
											label: nxt.label,
											...(nxt.rankId ? { roleLabel: nxt.rankId } : {}),
											...(nxtTier !== undefined ? { tier: nxtTier } : {}),
											...(nxt.department ? { department: nxt.department } : {}),
											status: orchState.nodeStates[nxt.id] ?? (ag?.session ? (ag.status ?? 'idle') : 'draft'),
										});
									}
								}
							}
						}
					}
				}
				for (const sub of orchSubsForMission) {
					allOrchSubordinates.push({ missionId: rec.id, ...sub });
				}

				const managedNodeIds = [...new Set([...jur.nodeIds, ...orchSubsForMission.map(s => s.nodeId)])];
				if (jur.hasFullJurisdiction || managedNodeIds.length > 0 || jur.supervisorIds.size > 0) {
					missionJurisdictions.push({
						missionId: rec.id,
						missionTitle: rec.title,
						managedNodeIds,
						subordinateSupervisorIds: Array.from(jur.supervisorIds),
						...(orchSubsForMission.length > 0 ? { orchestrationSubordinates: orchSubsForMission } : {}),
					});
				}
			}

			return {
				supervisorId: supervisorId ?? (ctx.isSecretary ? ADE_SECRETARY_ID : 'human'),
				directSubordinates: directTreeSubordinates.map(a => ({
					id: a.id,
					label: a.label,
					role: a.role,
					tier: resolveEffectiveRankDefinition(ctx.roleConfig, a.role, ctx.projects.hasSubordinates(a.id)).tier,
					host: a.projectUri.scheme === 'aexus-ssh' ? a.projectUri.authority : 'local',
					status: a.session ? (a.status ?? 'idle') : 'draft',
				})),
				...(allOrchSubordinates.length > 0 ? { orchestrationSubordinates: allOrchSubordinates } : {}),
				missionJurisdictions,
			};
		}

		case 'org.send': {
			const targetRaw = String(params.target ?? params.to ?? params.id ?? params.agentId ?? '').trim();
			const message = String(params.message ?? params.prompt ?? '').trim();
			if (!targetRaw || !message) {
				throw new Error('Target agent ID and message are required for org.send.');
			}
			const targetAgent = resolveOrgTargetAgent(targetRaw, params, ctx);
			if (!targetAgent) {
				throw new Error(`Target agent not found: ${targetRaw}`);
			}

			const auth = assertSupervisorHasAuthorityOverTarget(ctx, targetAgent);
			if (!auth.authorized) {
				throw new Error(auth.reason ?? 'Permission denied for org.send.');
			}

			// Ensure target session exists (locally or on SSH Cloud Host) before delivering directive.
			let resource = targetAgent.session?.resource;
			if (!resource && ctx.sessions) {
				const engines = await ctx.sessions.getEngines(targetAgent.projectUri).catch(() => []);
				const engId = normalizeAdeEngineId(targetAgent.preferredEngineId) || engines[0]?.id;
				if (engId) {
					const created = await ctx.sessions.create(engId, targetAgent.projectUri);
					if (created) {
						ctx.projects.bindSession(targetAgent.id, created);
						resource = created.resource;
					}
				}
			}
			if (!resource || !ctx.commandService) {
				throw new Error(`Target agent "${targetAgent.label}" has no available engine session.`);
			}

			const callerRankDef = !ctx.isHumanUser && !ctx.isSecretary
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent?.role, true)
				: undefined;
			const senderTag = ctx.isHumanUser
				? 'User (L-1)'
				: ctx.isSecretary
					? 'Secretary (L0)'
					: `${ctx.callerAgent?.label ?? ctx.callerSessionId} (L${callerRankDef!.tier})`;
			const rawDirective = `[Directive from Superior: ${senderTag}]\n${message}`;
			const directive = ctx.isHumanUser
				? wrapUserDirectMessageEnvelope(rawDirective, 'org.send')
				: ctx.isSecretary
					? wrapRoleDirectMessageEnvelope({
						senderLabel: ctx.projects.secretary.label || 'Secretary',
						senderTierTag: ADE_SECRETARY_TIER_TAG,
						senderRankName: 'Secretary',
						senderSessionId: ADE_SECRETARY_ID,
						channel: 'org.send',
						message: rawDirective,
					})
					: wrapRoleDirectMessageEnvelope({
						senderLabel: ctx.callerAgent?.label ?? ctx.callerSessionId ?? callerRankDef!.name,
						senderTierTag: formatTierTag(callerRankDef!.tier),
						senderRankName: callerRankDef!.name,
						senderSessionId: ctx.callerAgent?.id ?? ctx.callerSessionId,
						channel: 'org.send',
						message: rawDirective,
					});
			const targetRank = resolveEffectiveRankDefinition(ctx.roleConfig, targetAgent.role, ctx.projects.hasSubordinates(targetAgent.id));

			const targetMissionBinding = ctx.missionRuntime?.findMissionForAgent(targetAgent.id);
			const targetIsInGraphNode = Boolean(
				(targetMissionBinding && !targetMissionBinding.isOffGraphSupervisor && targetMissionBinding.nodeIds.length > 0)
				|| targetAgent.treeNodeId
				|| (targetAgent.treeNodeIds && targetAgent.treeNodeIds.length > 0),
			);
			const dispatchPromise = ctx.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', resource, directive, {
				agentId: targetAgent.id,
				model: targetAgent.preferredModel,
				thinking: targetAgent.preferredThinking,
				pureWorker: false,
				isMissionNode: targetIsInGraphNode,
				callerRole: targetRank.id,
				autonomousApproved: true,
			});
			if (params.wait === true) {
				await dispatchPromise;
			} else {
				void Promise.resolve(dispatchPromise).catch(() => undefined);
			}
			return {
				ok: true,
				deliveredTo: targetAgent.id,
				label: targetAgent.label,
				host: targetAgent.projectUri.scheme === 'aexus-ssh' ? targetAgent.projectUri.authority : 'local',
				waited: params.wait === true,
			};
		}

		case 'org.context': {
			const targetRaw = String(params.target ?? params.id ?? params.agentId ?? '').trim();
			if (!targetRaw) {
				throw new Error('Target agent ID is required for org.context.');
			}
			const targetAgent = resolveOrgTargetAgent(targetRaw, params, ctx);
			if (!targetAgent) {
				throw new Error(`Target agent not found: ${targetRaw}`);
			}

			const auth = assertSupervisorHasAuthorityOverTarget(ctx, targetAgent);
			if (!auth.authorized) {
				throw new Error(auth.reason ?? 'Permission denied for org.context.');
			}

			const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
				? Math.max(1, Math.min(100, Math.floor(params.limit)))
				: 12;
			const historyRes = targetAgent.session && ctx.commandService && targetAgent.session.engineId.startsWith('aexus-')
				? await ctx.commandService.executeCommand<{ readonly messages?: ReadonlyArray<{ readonly role: string; readonly text: string }> }>(
					'aexus.agentEngines.history',
					targetAgent.session.resource,
					limit,
				).catch(() => undefined)
				: undefined;
			const history = historyRes?.messages ?? [];
			const heldTokens = [
				...runtime.getCurrentOrchestrationTokens(targetAgent.id),
				...runtime.getCurrentTokens(targetAgent.id),
			];

			return {
				agentId: targetAgent.id,
				label: targetAgent.label,
				role: targetAgent.role,
				host: targetAgent.projectUri.scheme === 'aexus-ssh' ? targetAgent.projectUri.authority : 'local',
				projectUri: targetAgent.projectUri.toString(),
				status: targetAgent.session ? (targetAgent.status ?? 'idle') : 'draft',
				heldTokens,
				historyCount: history.length,
				history,
			};
		}

		case 'org.escalate': {
			const mission = resolveMissionRecord(params, ctx);
			const reason = String(params.reason ?? params.message ?? '').trim();
			if (!reason) {
				throw new Error('Escalation --reason is required for org.escalate.');
			}
			const rt = runtime.getRuntimeState(mission.id);
			if (!ctx.isHumanUser && !ctx.isSecretary) {
				const callerRank = ctx.callerAgent
					? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id))
					: undefined;
				const isOrchSupervisoryStaff = Boolean(
					ctx.callerSessionId
					&& mission.orchestrationText?.trim()
					&& callerRank
					&& !callerRank.pureExecution
					&& callerRank.canHaveSubordinates
					&& Object.values(runtime.getOrchestrationState(mission.id).nodeAgentIds).includes(ctx.callerSessionId),
				);
				const isBoundSupervisorOrOwner = Boolean(
					ctx.callerSessionId
					&& (ctx.callerSessionId === mission.ownerSessionId || rt.boundary.supervisors.some(s => s.id === ctx.callerSessionId) || isOrchSupervisoryStaff),
				);
				if (!isBoundSupervisorOrOwner) {
					throw new Error(`FORBIDDEN: only a bound supervisor, Orchestration lead, Mission owner, Secretary, or Human may invoke org.escalate on Mission "${mission.id}".`);
				}
			}
			const callerSupervisorId = String(
				(ctx.isHumanUser || ctx.isSecretary)
					? (params.from ?? params.supervisorId ?? ctx.callerSessionId ?? mission.ownerSessionId ?? ADE_SECRETARY_ID)
					: (ctx.callerSessionId ?? ''),
			).trim();
			if (!callerSupervisorId) {
				throw new Error('Unable to identify escalating supervisor.');
			}
			const res = await runtime.escalate(mission.id, {
				callerSupervisorId,
				reason,
				tokenId: typeof (params.tokenId ?? params.token) === 'string' ? String(params.tokenId ?? params.token).trim() : undefined,
				nodeId: typeof (params.nodeId ?? params.node) === 'string' ? String(params.nodeId ?? params.node).trim() : undefined,
				isSecretary: ctx.isSecretary,
				isHumanUser: ctx.isHumanUser,
			});
			if (!res.ok) {
				throw new Error(res.error ?? 'Escalation failed.');
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		// =====================================================================
		// Mission Runtime Lifecycle, Boundary, Recall, Patch, Gate, Triggers, Host
		// =====================================================================
		case 'mission.status': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			return runtime.getMissionStatus(mission.id);
		}

		case 'mission.start':
		case 'mission.run': {
			const mission = resolveMissionRecord(params, ctx);
			assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade orchestration dispatch"');
			assertFullMissionControlAuthority(ctx, mission, 'start');
			const timeoutRaw = params.silenceTimeoutMinutes ?? params.timeout ?? params.silenceTimeout;
			const silenceTimeoutMinutes = typeof timeoutRaw === 'number'
				? timeoutRaw
				: (typeof timeoutRaw === 'string' && /^\d+$/.test(timeoutRaw.trim()) ? Number(timeoutRaw.trim()) : undefined);
			const initialPrompt = typeof (params.prompt ?? params.initialPrompt) === 'string'
				? String(params.prompt ?? params.initialPrompt)
				: undefined;
			const res = await runtime.start(mission.id, { silenceTimeoutMinutes, initialPrompt });
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to start Mission "${mission.id}".`);
			}
			return { ok: true, missionId: mission.id, status: res.state.status, silenceTimeoutMinutes: res.state.silenceTimeoutMinutes, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'mission.pause': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'pause');
			const res = await runtime.pause(mission.id);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to pause Mission.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status };
		}

		case 'mission.resume': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'resume');
			const res = await runtime.resume(mission.id);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to resume Mission.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status };
		}

		case 'mission.stop': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'stop');
			const res = await runtime.stop(mission.id);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to stop Mission.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status };
		}

		case 'mission.timeout.set': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'configure silence timeout for');
			const minutes = Number(params.minutes ?? params.silenceTimeoutMinutes ?? params.timeout);
			if (!Number.isFinite(minutes) || minutes < 1) {
				throw new Error('Positive integer --minutes is required.');
			}
			const res = await runtime.setSilenceTimeout(mission.id, minutes);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to update silence timeout.');
			}
			return { ok: true, missionId: mission.id, silenceTimeoutMinutes: res.state.silenceTimeoutMinutes, locked: res.state.silenceTimeoutLocked };
		}

		case 'mission.boundary.get': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			return { missionId: mission.id, ...runtime.getBoundary(mission.id) };
		}

		case 'mission.boundary.set': {
			const mission = resolveMissionRecord(params, ctx);
			assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade orchestration apply|staff|edge"');
			if (!ctx.isHumanUser && !ctx.isSecretary && (!ctx.callerSessionId || ctx.callerSessionId !== mission.ownerSessionId)) {
				throw new Error(`FORBIDDEN: only Human (L-1), Secretary (L0), or Mission owner may modify factory boundary / supervisor jurisdictions for Mission "${mission.id}".`);
			}
			const offGraphMaxTier = params.offGraphMaxTier !== undefined ? Number(params.offGraphMaxTier) : undefined;
			const supervisors = Array.isArray(params.supervisors) ? params.supervisors as IMissionSupervisorBinding[] : undefined;
			const nodeAssignments = params.nodeAssignments && typeof params.nodeAssignments === 'object'
				? params.nodeAssignments as Record<string, IMissionNodeAssignment>
				: undefined;
			const res = await runtime.setBoundary(mission.id, { offGraphMaxTier, supervisors, nodeAssignments });
			if (!res.ok) {
				throw new Error(res.error ?? 'Factory boundary validation failed.');
			}
			return { ok: true, missionId: mission.id, boundary: res.boundary, validation: res.validation };
		}

		case 'mission.recall': {
			const mission = resolveMissionRecord(params, ctx);
			assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade orchestration abort" or "aexus-ade orchestration staff remove --force"');
			const rawNodes = params.nodes ?? params.nodeIds;
			const nodeIds = Array.isArray(rawNodes)
				? rawNodes.map(x => String(x).trim()).filter(Boolean)
				: (typeof rawNodes === 'string' && rawNodes.trim() ? rawNodes.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const branchRootNodeId = typeof (params.branch ?? params.branchRoot ?? params.branchRootNodeId ?? params.fromNode) === 'string'
				? String(params.branch ?? params.branchRoot ?? params.branchRootNodeId ?? params.fromNode).trim()
				: undefined;
			const reason = typeof params.reason === 'string' ? params.reason.trim() : undefined;
			const res = await runtime.recallTokens(mission.id, {
				caller: buildEngineCaller(ctx, mission),
				nodeIds,
				branchRootNodeId,
				reason,
			});
			if (!res.ok) {
				const err = new Error(res.error ?? 'Recall rejected.');
				throw err;
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'mission.retry':
		case 'token.retry': {
			const tokenId = typeof (params.tokenId ?? params.token) === 'string' && String(params.tokenId ?? params.token).trim()
				? String(params.tokenId ?? params.token).trim()
				: undefined;
			const nodeId = typeof (params.node ?? params.nodeId) === 'string' && String(params.node ?? params.nodeId).trim()
				? String(params.node ?? params.nodeId).trim()
				: undefined;
			if (!tokenId && !nodeId) {
				throw new Error('Either --token <tokenId> or --node <nodeId> is required for mission.retry.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: ((tokenId ? findMissionByTokenId(ctx, tokenId) : undefined) ?? resolveMissionRecord(params, ctx));
			assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade token mint" or "aexus-ade token handoff"');
			const guidance = typeof (params.guidance ?? params.reason ?? params.message ?? params.note) === 'string'
				? String(params.guidance ?? params.reason ?? params.message ?? params.note).trim()
				: undefined;
			const res = await runtime.retryToken(mission.id, {
				caller: buildEngineCaller(ctx, mission),
				tokenId,
				nodeId,
				guidance,
			});
			if (!res.ok) {
				throw new Error(res.error ?? 'Retry rejected.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'mission.patch': {
			const mission = resolveMissionRecord(params, ctx);
			assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade orchestration apply|staff|edge" or "aexus-ade mission task create|update|remove"');
			const newMermaidText = String(params.mermaid ?? params.text ?? params.mermaidText ?? '').trim();
			if (!newMermaidText) {
				throw new Error('Updated Mermaid text (--mermaid or --file) is required for mission.patch.');
			}
			const reason = typeof params.reason === 'string' ? params.reason.trim() : undefined;
			const res = await runtime.patchMermaid(mission.id, {
				caller: buildEngineCaller(ctx, mission),
				newMermaidText,
				reason,
			});
			if (!res.ok) {
				throw new Error(res.error ?? 'Safe Mission patch rejected.');
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'mission.gate': {
			if (!ctx.isHumanUser) {
				throw new Error('FORBIDDEN: Human Gate sign-off (mission.gate) is strictly restricted to the Human User (L-1).');
			}
			const mission = resolveMissionRecord(params, ctx);
			assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade mission task complete"');
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			const rawDecision = String(params.decision ?? params.verdict ?? '').trim().toLowerCase();
			if (!nodeId) {
				throw new Error('Gate --node ID is required.');
			}
			const normalizedDecision: 'approve' | 'reject' | undefined =
				(rawDecision === 'approve' || rawDecision === 'pass') ? 'approve'
					: (rawDecision === 'reject' || rawDecision === 'rollback') ? 'reject'
						: undefined;
			if (!normalizedDecision) {
				throw new Error('Gate decision must be "approve" (or "pass") or "reject" (or "rollback").');
			}
			const res = await runtime.resolveGate(mission.id, {
				nodeId,
				decision: normalizedDecision,
				tokenId: typeof (params.tokenId ?? params.token) === 'string' && String(params.tokenId ?? params.token).trim()
					? String(params.tokenId ?? params.token).trim()
					: undefined,
				note: typeof (params.note ?? params.feedback ?? params.reason) === 'string' ? String(params.note ?? params.feedback ?? params.reason).trim() : undefined,
				rollbackNodeId: typeof (params.rollback ?? params.rollbackNodeId ?? params.targetNode ?? params.target) === 'string'
					? String(params.rollback ?? params.rollbackNodeId ?? params.targetNode ?? params.target).trim()
					: undefined,
			});
			if (!res.ok) {
				throw new Error(res.error ?? 'Gate resolution failed.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'mission.trigger.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			return { missionId: mission.id, triggers: runtime.listTriggers(mission.id) };
		}

		case 'mission.trigger.set': {
			const mission = resolveMissionRecord(params, ctx);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			const kind = String(params.kind ?? params.type ?? '').trim().toLowerCase() as IMissionSourceTrigger['kind'];
			if (!nodeId || !['once', 'interval', 'cron', 'event'].includes(kind)) {
				throw new Error('Source trigger requires --node <id> and --kind <once|interval|cron|event>.');
			}
			const intervalMs = params.intervalMs !== undefined
				? Number(params.intervalMs)
				: (params.interval !== undefined ? parseDurationMs(params.interval as string | number) : undefined);
			let fireAt: number | undefined;
			if (params.fireAt !== undefined) {
				fireAt = typeof params.fireAt === 'number' ? params.fireAt : Date.parse(String(params.fireAt));
			} else if (params.delay !== undefined) {
				const d = parseDurationMs(params.delay as string | number);
				if (d) {
					fireAt = Date.now() + d;
				}
			}
			const res = await runtime.setTrigger(mission.id, {
				id: typeof (params.trigger ?? params.triggerId) === 'string' ? String(params.trigger ?? params.triggerId).trim() : undefined,
				nodeId,
				kind,
				enabled: params.disabled === true ? false : true,
				fireAt,
				intervalMs,
				cronExpr: typeof (params.cron ?? params.cronExpr) === 'string' ? String(params.cron ?? params.cronExpr).trim() : undefined,
				eventType: typeof (params.eventType ?? params.event) === 'string' ? String(params.eventType ?? params.event).trim() as IMissionSourceTrigger['eventType'] : undefined,
				targetPath: typeof (params.target ?? params.path ?? params.targetPath) === 'string' ? String(params.target ?? params.path ?? params.targetPath).trim() : undefined,
				hostAlias: typeof (params.host ?? params.hostAlias) === 'string' ? String(params.host ?? params.hostAlias).trim() : undefined,
				gpuUtilThresholdPct: params.gpuThreshold !== undefined ? Number(params.gpuThreshold) : undefined,
				...(params.autoStartOnMissionStart === true ? { autoStartOnMissionStart: true } : {}),
			}, buildEngineCaller(ctx, mission));
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to set source trigger.');
			}
			return { ok: true, missionId: mission.id, trigger: res.trigger };
		}

		case 'mission.trigger.remove': {
			const mission = resolveMissionRecord(params, ctx);
			const triggerId = String(params.trigger ?? params.triggerId ?? params.id ?? '').trim();
			if (!triggerId) {
				throw new Error('Trigger ID (--trigger) is required.');
			}
			const res = await runtime.removeTrigger(mission.id, triggerId, buildEngineCaller(ctx, mission));
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to remove source trigger.');
			}
			return { ok: true, missionId: mission.id, removedId: res.removedId };
		}

		case 'mission.host.bind': {
			const mission = resolveMissionRecord(params, ctx);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Node ID (--node) is required for mission.host.bind.');
			}
			const caller = buildEngineCaller(ctx, mission);
			const rt = runtime.getRuntimeState(mission.id);
			const graph = parseMissionMermaidDag(mission.mermaidText);
			const parsedOrchForHost = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
			const isOrchStaffTarget = Boolean(parsedOrchForHost && !parsedOrchForHost.error && parsedOrchForHost.nodes.some(n => n.kind === 'staff' && n.id === nodeId));
			if (isOrchStaffTarget) {
				assertStaffConfigureAuthority(ctx, mission, nodeId);
			} else {
				const jur = resolveSupervisorJurisdiction(
					rt.boundary,
					caller.sessionId ?? '',
					graph.nodes.map(n => n.id),
					{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: mission.ownerSessionId },
				);
				if (!jur.hasFullJurisdiction && !jur.nodeIds.has(nodeId)) {
					throw new Error(`OUT_OF_JURISDICTION: caller lacks off-graph jurisdiction to bind host for node "${nodeId}" in Mission "${mission.id}".`);
				}
			}
			const roleKindRaw = typeof (params.roleKind ?? params.nodeRole) === 'string'
				? String(params.roleKind ?? params.nodeRole).trim().toLowerCase()
				: undefined;
			const roleKind = roleKindRaw === 'reviewer' ? 'reviewer' : (roleKindRaw === 'worker' || roleKindRaw === 'executor') ? 'worker' : undefined;
			const res = await runtime.bindNodeHost(mission.id, nodeId, {
				hostAlias: typeof (params.host ?? params.hostAlias) === 'string' ? String(params.host ?? params.hostAlias).trim() : 'local',
				remoteProjectPath: typeof (params.path ?? params.remotePath ?? params.remoteProjectPath) === 'string'
					? String(params.path ?? params.remotePath ?? params.remoteProjectPath).trim()
					: undefined,
				agentId: typeof (params.agent ?? params.agentId) === 'string' ? String(params.agent ?? params.agentId).trim() : undefined,
				roleKind,
			});
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to bind host to Mission node.');
			}
			return { ok: true, missionId: mission.id, assignment: res.assignment };
		}

		case 'mission.prompt.list':
		case 'mission.prompt.get':
		case 'mission.prompt.set': {
			throw new Error(
				`LEGACY_API_REMOVED: "${action}" (node pre-prompts) has been retired. Deliver task context via baton tokens ("aexus-ade token mint|split|handoff --detail ... --whiteboard <wbId>") or manage Mission Task DAG descriptions via "aexus-ade mission task list|get|set".`,
			);
		}

		case 'mission.check.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = typeof (params.node ?? params.nodeId) === 'string' && String(params.node ?? params.nodeId).trim()
				? String(params.node ?? params.nodeId).trim()
				: undefined;
			const nodeChecks = runtime.getEffectiveNodeChecks(mission.id, nodeId);
			return { missionId: mission.id, nodeChecks };
		}

		case 'mission.check.get': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Node ID (--node) is required for mission.check.get.');
			}
			const checks = runtime.getEffectiveNodeChecks(mission.id, nodeId)[nodeId] ?? [];
			return { missionId: mission.id, nodeId, checks };
		}

		case 'mission.check.set': {
			const mission = resolveMissionRecord(params, ctx);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Node ID (--node) is required for mission.check.set.');
			}
			const caller = buildEngineCaller(ctx, mission);
			const rt = runtime.getRuntimeState(mission.id);
			const graph = parseMissionMermaidDag(mission.mermaidText);
			const parsedOrchForCheck = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
			const targetNode = graph.nodes.find(n => n.id === nodeId);
			const targetOrchStaff = parsedOrchForCheck && !parsedOrchForCheck.error
				? parsedOrchForCheck.nodes.find(n => n.id === nodeId && n.kind === 'staff')
				: undefined;
			if (!targetNode && !targetOrchStaff) {
				throw new Error(`Node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			if (targetNode?.kind === 'gate') {
				throw new Error(`Cannot attach deterministic checks to Human Gate node "${nodeId}". Attach checks to task or staff nodes.`);
			}
			if (targetOrchStaff) {
				assertStaffConfigureAuthority(ctx, mission, nodeId);
			} else {
				const isOffGraph = Boolean(
					caller.isHumanUser
					|| caller.isSecretary
					|| (caller.tier !== undefined && caller.tier <= rt.boundary.offGraphMaxTier),
				);
				if (!isOffGraph) {
					throw new Error('FORBIDDEN: in-graph employees cannot configure or modify deterministic verification hooks.');
				}
				const jur = resolveSupervisorJurisdiction(
					rt.boundary,
					caller.sessionId ?? '',
					graph.nodes.map(n => n.id),
					{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: mission.ownerSessionId },
				);
				if (!jur.hasFullJurisdiction && !jur.nodeIds.has(nodeId)) {
					throw new Error(`OUT_OF_JURISDICTION: caller lacks off-graph jurisdiction to configure checks for node "${nodeId}" in Mission "${mission.id}".`);
				}
			}

			const command = typeof (params.command ?? params.cmd) === 'string' && String(params.command ?? params.cmd).trim()
				? String(params.command ?? params.cmd).trim()
				: undefined;
			const rawExpectFiles = params.expectFiles ?? params.expectFile ?? params.files;
			const expectFiles = Array.isArray(rawExpectFiles)
				? rawExpectFiles.map(x => String(x).trim()).filter(Boolean)
				: (typeof rawExpectFiles === 'string' && rawExpectFiles.trim()
					? rawExpectFiles.split(',').map(s => s.trim()).filter(Boolean)
					: undefined);
			if (!command && (!expectFiles || expectFiles.length === 0)) {
				throw new Error('At least one of --cmd "<shell command>" or --expect-file "<path>" is required for mission.check.set.');
			}

			const onFailRaw = typeof (params.onFail ?? params.on_fail) === 'string'
				? String(params.onFail ?? params.on_fail).trim().toLowerCase()
				: undefined;
			let onFail: MissionCheckOnFailAction | undefined;
			if (onFailRaw !== undefined && onFailRaw !== '') {
				if (onFailRaw !== 'bounce' && onFailRaw !== 'fail' && onFailRaw !== 'escalate') {
					throw new Error(`Invalid --on-fail mode "${onFailRaw}". Expected bounce, fail, or escalate.`);
				}
				onFail = onFailRaw;
			}

			const timeoutRaw = params.timeoutMs ?? params.timeout;
			const parsedTimeout = timeoutRaw !== undefined
				? (typeof timeoutRaw === 'number' ? timeoutRaw : parseDurationMs(String(timeoutRaw)))
				: undefined;
			const timeoutMs = parsedTimeout !== undefined
				? Math.max(1_000, Math.min(300_000, Math.round(parsedTimeout)))
				: undefined;

			const maxRetriesRaw = params.maxAutoRetries ?? params.maxRetries ?? params.retries;
			const maxAutoRetries = maxRetriesRaw !== undefined && Number.isFinite(Number(maxRetriesRaw))
				? Math.max(0, Math.min(5, Math.floor(Number(maxRetriesRaw))))
				: undefined;

			const expectExitRaw = params.expectExitCode ?? params.expectExit;
			const expectExitCode = expectExitRaw !== undefined && Number.isInteger(Number(expectExitRaw))
				? Number(expectExitRaw)
				: undefined;

			const existingForNode = mission.nodeChecks?.[nodeId] ?? [];
			const explicitId = typeof (params.checkId ?? params.id) === 'string' && String(params.checkId ?? params.id).trim()
				? String(params.checkId ?? params.id).trim()
				: undefined;
			const checkId = explicitId || `chk-${nodeId}-${existingForNode.length + 1}`;

			const hook: IMissionNodeCheckHook = {
				id: checkId,
				...(typeof params.name === 'string' && params.name.trim() ? { name: params.name.trim() } : {}),
				...(command ? { command } : {}),
				...(expectExitCode !== undefined ? { expectExitCode } : {}),
				...(typeof params.cwd === 'string' && params.cwd.trim() ? { cwd: params.cwd.trim() } : {}),
				...(typeof (params.host ?? params.hostAlias) === 'string' && String(params.host ?? params.hostAlias).trim()
					? { hostAlias: String(params.host ?? params.hostAlias).trim() }
					: {}),
				...(expectFiles && expectFiles.length > 0 ? { expectFiles } : {}),
				...(typeof (params.expectOutputMatch ?? params.match) === 'string' && String(params.expectOutputMatch ?? params.match).trim()
					? { expectOutputMatch: String(params.expectOutputMatch ?? params.match).trim() }
					: {}),
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
				...(onFail ? { onFail } : {}),
				...(maxAutoRetries !== undefined ? { maxAutoRetries } : {}),
				enabled: params.disabled === true ? false : true,
				source: 'config',
			};
			ctx.missionService?.upsertNodeCheck(mission.id, nodeId, hook);
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				check: hook,
				checks: runtime.getEffectiveNodeChecks(mission.id, nodeId)[nodeId] ?? [],
			};
		}

		case 'mission.check.remove': {
			const mission = resolveMissionRecord(params, ctx);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Node ID (--node) is required for mission.check.remove.');
			}
			const caller = buildEngineCaller(ctx, mission);
			const rt = runtime.getRuntimeState(mission.id);
			const graph = parseMissionMermaidDag(mission.mermaidText);
			const parsedOrchForRemove = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
			const isOrchStaffCheckRemove = Boolean(parsedOrchForRemove && !parsedOrchForRemove.error && parsedOrchForRemove.nodes.some(n => n.id === nodeId && n.kind === 'staff'));
			if (isOrchStaffCheckRemove) {
				assertStaffConfigureAuthority(ctx, mission, nodeId);
			} else {
				const isOffGraph = Boolean(
					caller.isHumanUser
					|| caller.isSecretary
					|| (caller.tier !== undefined && caller.tier <= rt.boundary.offGraphMaxTier),
				);
				if (!isOffGraph) {
					throw new Error('FORBIDDEN: in-graph employees cannot remove deterministic verification hooks.');
				}
				const jur = resolveSupervisorJurisdiction(
					rt.boundary,
					caller.sessionId ?? '',
					graph.nodes.map(n => n.id),
					{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: mission.ownerSessionId },
				);
				if (!jur.hasFullJurisdiction && !jur.nodeIds.has(nodeId)) {
					throw new Error(`OUT_OF_JURISDICTION: caller lacks off-graph jurisdiction to remove checks for node "${nodeId}" in Mission "${mission.id}".`);
				}
			}
			const checkId = params.all === true
				? undefined
				: (typeof (params.checkId ?? params.id) === 'string' && String(params.checkId ?? params.id).trim()
					? String(params.checkId ?? params.id).trim()
					: undefined);
			ctx.missionService?.removeNodeCheck(mission.id, nodeId, checkId);
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				removedCheckId: checkId ?? '*',
				checks: runtime.getEffectiveNodeChecks(mission.id, nodeId)[nodeId] ?? [],
			};
		}

		case 'mission.check.run': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Node ID (--node) is required for mission.check.run.');
			}
			const caller = buildEngineCaller(ctx, mission);
			const rt = runtime.getRuntimeState(mission.id);
			const graph = parseMissionMermaidDag(mission.mermaidText);
			const parsedOrchForRun = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
			const isOrchStaffRun = Boolean(parsedOrchForRun && !parsedOrchForRun.error && parsedOrchForRun.nodes.some(n => n.id === nodeId && n.kind === 'staff'));
			if (!graph.nodes.some(n => n.id === nodeId) && !isOrchStaffRun) {
				throw new Error(`Node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			if (!caller.isHumanUser && !caller.isSecretary) {
				const orchStateForRun = isOrchStaffRun ? runtime.getOrchestrationState(mission.id) : undefined;
				const isOwnAssignedNode = Boolean(
					caller.sessionId
					&& (rt.boundary.nodeAssignments[nodeId]?.agentId === caller.sessionId || orchStateForRun?.nodeAgentIds[nodeId] === caller.sessionId),
				);
				if (!isOwnAssignedNode) {
					if (isOrchStaffRun) {
						assertStaffConfigureAuthority(ctx, mission, nodeId);
					} else {
						const jur = resolveSupervisorJurisdiction(
							rt.boundary,
							caller.sessionId ?? '',
							graph.nodes.map(n => n.id),
							{ ownerSessionId: mission.ownerSessionId },
						);
						if (!jur.hasFullJurisdiction && !jur.nodeIds.has(nodeId)) {
							throw new Error(`FORBIDDEN: caller lacks jurisdiction or node assignment to dry-run checks for node "${nodeId}".`);
						}
					}
				}
			}
			const rawCheckId = typeof (params.checkId ?? params.id) === 'string' && String(params.checkId ?? params.id).trim()
				? String(params.checkId ?? params.id).trim()
				: undefined;
			const suite = await runtime.runNodeChecks(mission.id, nodeId, rawCheckId ? { checkIds: [rawCheckId] } : undefined);
			return { ok: true, missionId: mission.id, ...suite };
		}

		// =====================================================================
		// Engineering Mission Task DAG (`mission.task.*`)
		// =====================================================================
		case 'mission.task.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const parsed = parseMissionMermaidDag(mission.mermaidText);
			const tasks = parsed.nodes.map(n => {
				const st = mission.taskStatuses?.[n.id];
				return {
					id: n.id,
					title: n.label,
					kind: n.kind,
					description: mission.nodePrompts?.[n.id] ?? '',
					status: st?.status ?? 'pending',
					...(n.ownerNodeId ? { ownerNodeId: n.ownerNodeId } : {}),
					...(st?.assigneeNodeId ?? n.assigneeNodeId ? { assigneeNodeId: st?.assigneeNodeId ?? n.assigneeNodeId } : {}),
					...(st?.assigneeLabel ? { assigneeLabel: st.assigneeLabel } : {}),
					...(n.department ? { department: n.department } : {}),
					...(n.minCompleterTier !== undefined ? { minCompleterTier: n.minCompleterTier } : {}),
					...(n.allowedCompleterNodeIds ? { allowedCompleterNodeIds: n.allowedCompleterNodeIds } : {}),
					...(st?.activeTokenIds && st.activeTokenIds.length > 0 ? { activeTokenIds: st.activeTokenIds } : {}),
					...(st?.lastTokenId ? { lastTokenId: st.lastTokenId } : {}),
					...(st?.startedAt !== undefined ? { startedAt: st.startedAt } : {}),
					...(st?.durationMs !== undefined ? { durationMs: st.durationMs } : {}),
					...(st?.artifactPtrs && st.artifactPtrs.length > 0 ? { artifactPtrs: st.artifactPtrs } : {}),
					...(st?.blockedReason ? { blockedReason: st.blockedReason } : {}),
					...(st?.lastError ? { lastError: st.lastError } : {}),
					completedBy: st?.completedBy,
					completedByLabel: st?.completedByLabel,
					completedAt: st?.completedAt,
					note: st?.note,
					upstreamIds: parsed.edges.filter(e => e.to === n.id).map(e => e.from),
					downstreamIds: parsed.edges.filter(e => e.from === n.id).map(e => e.to),
				};
			});
			return { missionId: mission.id, title: mission.title, tasks, error: parsed.error };
		}

		case 'mission.task.get': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.get.');
			}
			const parsed = parseMissionMermaidDag(mission.mermaidText);
			const node = parsed.nodes.find(n => n.id === nodeId);
			if (!node) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			const statusRec = mission.taskStatuses?.[nodeId];
			return {
				missionId: mission.id,
				id: node.id,
				title: node.label,
				kind: node.kind,
				description: mission.nodePrompts?.[nodeId] ?? '',
				...(node.ownerNodeId ? { ownerNodeId: node.ownerNodeId } : {}),
				...(statusRec?.assigneeNodeId ?? node.assigneeNodeId ? { assigneeNodeId: statusRec?.assigneeNodeId ?? node.assigneeNodeId } : {}),
				...(node.department ? { department: node.department } : {}),
				...(node.minCompleterTier !== undefined ? { minCompleterTier: node.minCompleterTier } : {}),
				...(node.allowedCompleterNodeIds ? { allowedCompleterNodeIds: node.allowedCompleterNodeIds } : {}),
				status: statusRec?.status ?? 'pending',
				statusRecord: statusRec,
				upstreamIds: parsed.edges.filter(e => e.to === node.id).map(e => e.from),
				downstreamIds: parsed.edges.filter(e => e.from === node.id).map(e => e.to),
			};
		}

		case 'mission.task.set': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.set.');
			}
			const parsed = parseMissionMermaidDag(mission.mermaidText);
			const targetTask = parsed.nodes.find(n => n.id === nodeId);
			if (!targetTask) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			assertMissionTaskDesignScope(ctx, mission, 'edit description of', { targetTask });
			const description = String(params.description ?? params.prompt ?? params.text ?? '');
			const updated = ctx.missionService?.updateNodePrompt(mission.id, nodeId, description);
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				description: updated?.nodePrompts?.[nodeId] ?? '',
			};
		}

		case 'mission.task.create': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const explicitDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			assertMissionTaskDesignScope(ctx, mission, 'create', { requestedDepartment: explicitDept });
			const title = String(params.title ?? params.label ?? params.name ?? '').trim();
			const explicitId = typeof (params.id ?? params.node ?? params.nodeId) === 'string' && String(params.id ?? params.node ?? params.nodeId).trim()
				? String(params.id ?? params.node ?? params.nodeId).trim()
				: undefined;
			if (!title && !explicitId) {
				throw new Error('Task --title (or --id) is required for mission.task.create.');
			}
			const kind = params.kind === 'gate' ? 'gate' : 'task';
			const added = addNodeToMermaid(mission.mermaidText ?? '', {
				id: explicitId,
				label: title || explicitId,
				kind,
			});
			let nextMermaid = added.mermaidText;
			const nodeId = added.nodeId;

			const parseCsv = (raw: unknown): string[] => Array.isArray(raw)
				? raw.map(v => String(v).trim()).filter(Boolean)
				: (typeof raw === 'string' ? raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean) : []);

			// Resolve caller's own Orchestration node ID & department for smart defaults on mid-tier creation
			const orchState = runtime.getOrchestrationState(mission.id);
			const orchGraph = parseOrchestrationGraph(mission.orchestrationText ?? '');
			let callerNodeId: string | undefined;
			if (ctx.callerSessionId) {
				for (const [nid, aid] of Object.entries(orchState.nodeAgentIds)) {
					if (aid === ctx.callerSessionId) { callerNodeId = nid; break; }
				}
			}
			const callerStaffNode = callerNodeId ? orchGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
			const ownerNodeId = typeof (params.ownerNodeId ?? params.owner) === 'string' && String(params.ownerNodeId ?? params.owner).trim()
				? String(params.ownerNodeId ?? params.owner).trim()
				: callerNodeId;
			const assigneeNodeId = typeof (params.assigneeNodeId ?? params.assignee) === 'string' && String(params.assigneeNodeId ?? params.assignee).trim()
				? String(params.assigneeNodeId ?? params.assignee).trim()
				: undefined;
			const department = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: callerStaffNode?.department;
			const minTierRaw = params.minCompleterTier ?? params.minTier;
			const minCompleterTier = minTierRaw !== undefined && Number.isInteger(Number(minTierRaw)) && Number(minTierRaw) >= 0
				? Number(minTierRaw)
				: undefined;
			const allowedCompleterNodeIds = parseCsv(params.allowedCompleterNodeIds ?? params.completers);

			if (ownerNodeId || assigneeNodeId || department || minCompleterTier !== undefined || allowedCompleterNodeIds.length > 0) {
				nextMermaid = upsertTaskMetadataInMermaid(nextMermaid, nodeId, {
					...(ownerNodeId ? { ownerNodeId } : {}),
					...(assigneeNodeId ? { assigneeNodeId } : {}),
					...(department ? { department } : {}),
					...(minCompleterTier !== undefined ? { minCompleterTier } : {}),
					...(allowedCompleterNodeIds.length > 0 ? { allowedCompleterNodeIds } : {}),
				});
			}

			for (const upId of parseCsv(params.after ?? params.upstream ?? params.dependsOn)) {
				const edgeRes = addEdgeToMermaid(nextMermaid, upId, nodeId);
				if (!edgeRes.ok || !edgeRes.mermaidText) {
					throw new Error(edgeRes.error ?? `Failed to add dependency edge ${upId} -> ${nodeId}.`);
				}
				nextMermaid = edgeRes.mermaidText;
			}
			for (const downId of parseCsv(params.before ?? params.downstream)) {
				const edgeRes = addEdgeToMermaid(nextMermaid, nodeId, downId);
				if (!edgeRes.ok || !edgeRes.mermaidText) {
					throw new Error(edgeRes.error ?? `Failed to add dependency edge ${nodeId} -> ${downId}.`);
				}
				nextMermaid = edgeRes.mermaidText;
			}
			const finalParsed = parseMissionMermaidDag(nextMermaid);
			if (finalParsed.error) {
				throw new Error(finalParsed.error);
			}
			ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			if (typeof params.description === 'string' && params.description.trim()) {
				ctx.missionService?.updateNodePrompt(mission.id, nodeId, params.description.trim());
			}
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				node: finalParsed.nodes.find(n => n.id === nodeId),
			};
		}

		case 'mission.task.update': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? params.id ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.update.');
			}
			let nextMermaid = mission.mermaidText ?? '';
			const initialParsed = parseMissionMermaidDag(nextMermaid);
			const targetTask = initialParsed.nodes.find(n => n.id === nodeId);
			if (!targetTask) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			const requestedDept = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim()
				: undefined;
			assertMissionTaskDesignScope(ctx, mission, 'update', { targetTask, requestedDepartment: requestedDept });
			const nextTitle = typeof (params.title ?? params.label ?? params.name) === 'string' && String(params.title ?? params.label ?? params.name).trim()
				? String(params.title ?? params.label ?? params.name).trim()
				: undefined;
			if (nextTitle) {
				nextMermaid = renameNodeInMermaid(nextMermaid, nodeId, nextTitle);
			}
			const parseOptCsv = (raw: unknown): readonly string[] | null | undefined => {
				if (raw === null || raw === '') { return null; }
				if (raw === undefined) { return undefined; }
				return Array.isArray(raw)
					? raw.map(v => String(v).trim()).filter(Boolean)
					: String(raw).split(/[|,;]/).map(s => s.trim()).filter(Boolean);
			};
			const metaPatch: {
				ownerNodeId?: string | null;
				assigneeNodeId?: string | null;
				department?: string | null;
				minCompleterTier?: number | null;
				allowedCompleterNodeIds?: readonly string[] | null;
				color?: string | null;
			} = {};
			let hasMetaPatch = false;
			if (params.ownerNodeId !== undefined || params.owner !== undefined) {
				const v = params.ownerNodeId ?? params.owner;
				metaPatch.ownerNodeId = v === null ? null : String(v);
				hasMetaPatch = true;
			}
			if (params.assigneeNodeId !== undefined || params.assignee !== undefined) {
				const v = params.assigneeNodeId ?? params.assignee;
				metaPatch.assigneeNodeId = v === null ? null : String(v);
				hasMetaPatch = true;
			}
			if (params.department !== undefined || params.dept !== undefined) {
				const v = params.department ?? params.dept;
				metaPatch.department = v === null ? null : String(v);
				hasMetaPatch = true;
			}
			if (params.minCompleterTier !== undefined || params.minTier !== undefined) {
				const v = params.minCompleterTier ?? params.minTier;
				metaPatch.minCompleterTier = (v === null || v === '') ? null : Number(v);
				hasMetaPatch = true;
			}
			const completersPatch = parseOptCsv(params.allowedCompleterNodeIds ?? params.completers);
			if (completersPatch !== undefined) {
				metaPatch.allowedCompleterNodeIds = completersPatch;
				hasMetaPatch = true;
			}
			if (params.color !== undefined || params.accent !== undefined) {
				const v = params.color ?? params.accent;
				metaPatch.color = (v === null || v === '') ? null : String(v);
				hasMetaPatch = true;
			}
			if (hasMetaPatch) {
				nextMermaid = upsertTaskMetadataInMermaid(nextMermaid, nodeId, metaPatch);
			}
			if (nextMermaid !== (mission.mermaidText ?? '')) {
				ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			}
			if (typeof params.description === 'string') {
				ctx.missionService?.updateNodePrompt(mission.id, nodeId, params.description);
			}
			const reparsed = parseMissionMermaidDag(nextMermaid);
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				node: reparsed.nodes.find(n => n.id === nodeId),
			};
		}

		case 'mission.task.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? params.id ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required for mission.task.remove.');
			}
			const parsed = parseMissionMermaidDag(mission.mermaidText ?? '');
			const targetTask = parsed.nodes.find(n => n.id === nodeId);
			if (!targetTask) {
				throw new Error(`Task node "${nodeId}" not found in Mission "${mission.id}".`);
			}
			assertMissionTaskDesignScope(ctx, mission, 'remove', { targetTask });
			const nextMermaid = removeNodeFromMermaid(mission.mermaidText ?? '', nodeId);
			ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			if (mission.taskStatuses && Object.hasOwn(mission.taskStatuses, nodeId)) {
				const nextStatuses = { ...mission.taskStatuses };
				delete nextStatuses[nodeId];
				ctx.missionService?.updateTaskStatuses(mission.id, nextStatuses);
			}
			return { ok: true, missionId: mission.id, removedNodeId: nodeId };
		}

		case 'mission.task.edge.add': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			if (!ctx.isHumanUser && !ctx.isSecretary) {
				const callerRank = ctx.callerAgent
					? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id))
					: undefined;
				if (!callerRank || callerRank.pureExecution || (!callerRank.canHaveSubordinates && !callerRank.allowedApis.includes('mission.design'))) {
					throw new Error('FORBIDDEN: only top-rank or supervisory roles may add Mission Task DAG edges.');
				}
			}
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to task node IDs are required for mission.task.edge.add.');
			}
			const res = addEdgeToMermaid(mission.mermaidText ?? '', from, to, {
				label: typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined,
				kind: params.kind === 'fail' ? 'fail' : 'success',
			});
			if (!res.ok || !res.mermaidText) {
				throw new Error(res.error ?? `Failed to add Mission Task DAG edge ${from} -> ${to}.`);
			}
			ctx.missionService?.updateMermaid(mission.id, res.mermaidText);
			return { ok: true, missionId: mission.id, from, to };
		}

		case 'mission.task.edge.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			if (!ctx.isHumanUser && !ctx.isSecretary) {
				const callerRank = ctx.callerAgent
					? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id))
					: undefined;
				if (!callerRank || callerRank.pureExecution || (!callerRank.canHaveSubordinates && !callerRank.allowedApis.includes('mission.design'))) {
					throw new Error('FORBIDDEN: only top-rank or supervisory roles may remove Mission Task DAG edges.');
				}
			}
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to task node IDs are required for mission.task.edge.remove.');
			}
			const nextMermaid = removeEdgeFromMermaid(mission.mermaidText ?? '', from, to);
			ctx.missionService?.updateMermaid(mission.id, nextMermaid);
			return { ok: true, missionId: mission.id, from, to };
		}

		case 'mission.task.complete':
		case 'mission.task.status': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				throw new Error('Task node ID (--node) is required.');
			}
			const rawStatus = action === 'mission.task.complete'
				? 'completed'
				: String(params.status ?? '').trim().toLowerCase();
			if (!['pending', 'in_progress', 'completed', 'blocked'].includes(rawStatus)) {
				throw new Error(`Invalid task status "${rawStatus}". Expected pending, in_progress, completed, or blocked.`);
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = runtime.setMissionTaskStatus(mission.id, {
				nodeId,
				status: rawStatus as MissionTaskStatus,
				caller: {
					isHumanUser: ctx.isHumanUser,
					callerTier,
					callerSessionId: ctx.callerSessionId,
					callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
				},
				force: params.force === true,
				note: typeof params.note === 'string' ? params.note : undefined,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to update task "${nodeId}" status.`);
			}
			return {
				ok: true,
				missionId: mission.id,
				nodeId,
				status: res.taskStatuses[nodeId],
				...(res.incompleteUpstreamTaskIds ? { incompleteUpstreamTaskIds: res.incompleteUpstreamTaskIds } : {}),
			};
		}

		// =====================================================================
		// Engineering Lossless Export (`mission.export`, `orchestration.export/import`, Groups, Edges, Layout)
		// =====================================================================
		case 'mission.export': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const withPositions = params.withPositions === true;
			const includeAgentIds = params.includeAgentIds === true;
			const parsedOrch = parseOrchestrationGraph(mission.orchestrationText ?? '');
			const orchState = runtime.getOrchestrationState(mission.id);
			const rtState = runtime.getRuntimeState(mission.id);
			const staffRuntimeMeta: Record<string, { engineId?: string; model?: string; thinking?: string; hostAlias?: string; agentId?: string }> = {};
			for (const node of parsedOrch.nodes) {
				if (node.kind !== 'staff') {
					continue;
				}
				const aid = orchState.nodeAgentIds[node.id] ?? node.agentId;
				const agent = aid ? ctx.projects.getAgent(aid) : undefined;
				const hostAlias = rtState.boundary.nodeAssignments[node.id]?.hostAlias ?? node.hostAlias;
				staffRuntimeMeta[node.id] = {
					...(agent?.session?.engineId ?? agent?.preferredEngineId ?? node.engineId ? { engineId: agent?.session?.engineId ?? agent?.preferredEngineId ?? node.engineId } : {}),
					...(agent?.preferredModel ?? node.model ? { model: agent?.preferredModel ?? node.model } : {}),
					...(agent?.preferredThinking ?? node.thinking ? { thinking: agent?.preferredThinking ?? node.thinking } : {}),
					...(hostAlias ? { hostAlias } : {}),
					...(includeAgentIds && aid ? { agentId: aid } : {}),
				};
			}
			const wbList = runtime.listOrchestrationWhiteboards(mission.id);
			const wbMap: Record<string, IOrchestrationWhiteboard> = {};
			for (const wb of wbList) {
				wbMap[wb.id] = wb;
			}
			const losslessOrchText = (mission.orchestrationText?.trim() || wbList.length > 0)
				? serializeOrchestrationGraph({
					direction: parsedOrch.direction,
					layoutMode: mission.orchestrationLayoutMode ?? parsedOrch.layoutMode,
					nodes: parsedOrch.nodes,
					edges: parsedOrch.edges,
					departments: parsedOrch.departments,
					whiteboards: wbMap,
					positions: withPositions ? (mission.orchestrationPositions ?? parsedOrch.positions) : undefined,
					staffRuntimeMeta,
					includeAgentIds,
				})
				: '';
			return {
				schemaVersion: 1,
				exportedAt: Date.now(),
				missionId: mission.id,
				title: mission.title,
				mermaidText: mission.mermaidText,
				nodePrompts: mission.nodePrompts ?? {},
				taskStatuses: mission.taskStatuses ?? {},
				orchestrationLayoutMode: mission.orchestrationLayoutMode ?? parsedOrch.layoutMode,
				orchestrationText: losslessOrchText,
				whiteboards: wbMap,
				...(withPositions && Object.keys(mission.positions ?? {}).length > 0 ? { positions: mission.positions } : {}),
				...(withPositions && Object.keys(mission.orchestrationPositions ?? {}).length > 0 ? { orchestrationPositions: mission.orchestrationPositions } : {}),
			};
		}

		// =====================================================================
		// Engineering Orchestration (All-Staff Cyclic Free-Topology Graph)
		// =====================================================================
		case 'orchestration.get': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const text = mission.orchestrationText ?? '';
			if (params.raw === true) {
				return text;
			}
			const parsed = parseOrchestrationGraph(text);
			const orchState = runtime.getOrchestrationState(mission.id);
			return {
				missionId: mission.id,
				title: mission.title,
				layoutMode: mission.orchestrationLayoutMode ?? parsed.layoutMode,
				orchestrationText: text,
				parsed,
				nodeAgentIds: orchState.nodeAgentIds,
				nodeStates: orchState.nodeStates,
				whiteboards: runtime.listOrchestrationWhiteboards(mission.id),
			};
		}

		case 'orchestration.export': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const withPositions = params.withPositions === true;
			const includeAgentIds = params.includeAgentIds === true;
			const parsed = parseOrchestrationGraph(mission.orchestrationText ?? '');
			const orchState = runtime.getOrchestrationState(mission.id);
			const rtState = runtime.getRuntimeState(mission.id);
			const staffRuntimeMeta: Record<string, { engineId?: string; model?: string; thinking?: string; hostAlias?: string; agentId?: string }> = {};
			for (const node of parsed.nodes) {
				if (node.kind !== 'staff') {
					continue;
				}
				const aid = orchState.nodeAgentIds[node.id] ?? node.agentId;
				const agent = aid ? ctx.projects.getAgent(aid) : undefined;
				const hostAlias = rtState.boundary.nodeAssignments[node.id]?.hostAlias ?? node.hostAlias;
				staffRuntimeMeta[node.id] = {
					...(agent?.session?.engineId ?? agent?.preferredEngineId ?? node.engineId ? { engineId: agent?.session?.engineId ?? agent?.preferredEngineId ?? node.engineId } : {}),
					...(agent?.preferredModel ?? node.model ? { model: agent?.preferredModel ?? node.model } : {}),
					...(agent?.preferredThinking ?? node.thinking ? { thinking: agent?.preferredThinking ?? node.thinking } : {}),
					...(hostAlias ? { hostAlias } : {}),
					...(includeAgentIds && aid ? { agentId: aid } : {}),
				};
			}
			const wbList = runtime.listOrchestrationWhiteboards(mission.id);
			const wbMap: Record<string, IOrchestrationWhiteboard> = {};
			for (const wb of wbList) {
				wbMap[wb.id] = wb;
			}
			const exportFormat = String(params.format ?? 'mermaid').trim().toLowerCase();
			if (exportFormat === 'json' || exportFormat === 'manifest') {
				const manifest = exportToOrchestrationManifest({
					name: mission.title,
					orchestrationText: mission.orchestrationText ?? '',
					whiteboards: wbMap,
					mermaidText: mission.mermaidText,
					nodePrompts: mission.nodePrompts,
					nodeChecks: mission.nodeChecks,
					staffRuntimeMeta,
				});
				if (params.raw === true) {
					return JSON.stringify(manifest, null, 2);
				}
				return {
					missionId: mission.id,
					title: mission.title,
					format: 'json',
					manifest,
				};
			}
			const serialized = serializeOrchestrationGraph({
				direction: parsed.direction,
				layoutMode: mission.orchestrationLayoutMode ?? parsed.layoutMode,
				nodes: parsed.nodes,
				edges: parsed.edges,
				departments: parsed.departments,
				whiteboards: wbMap,
				positions: withPositions ? (mission.orchestrationPositions ?? parsed.positions) : undefined,
				staffRuntimeMeta,
				includeAgentIds,
			});
			if (params.raw === true) {
				return serialized;
			}
			return {
				missionId: mission.id,
				title: mission.title,
				format: 'mermaid',
				layoutMode: mission.orchestrationLayoutMode ?? parsed.layoutMode,
				groupCount: parsed.departments.length,
				staffCount: parsed.nodes.filter(n => n.kind === 'staff').length,
				whiteboardCount: Object.keys(wbMap).length,
				edgeCount: parsed.edges.length,
				withPositions,
				orchestrationText: serialized,
			};
		}

		case 'orchestration.validate': {
			if (params.manifest !== undefined) {
				let rawManifest = params.manifest;
				if (typeof rawManifest === 'string') {
					try {
						rawManifest = JSON.parse(rawManifest);
					} catch (err) {
						return {
							valid: false,
							format: 'json',
							errors: [`Malformed JSON manifest: ${err instanceof Error ? err.message : String(err)}`],
							warnings: [],
						};
					}
				}
				const validation = validateOrchestrationManifest(rawManifest);
				return {
					valid: validation.valid,
					format: 'json',
					errors: validation.errors,
					warnings: validation.warnings,
					...(validation.manifest ? { staffCount: validation.manifest.staff.length, taskCount: validation.manifest.tasks?.nodes.length ?? 0 } : {}),
				};
			}
			const text = typeof (params.text ?? params.mermaid ?? params.orchestrationText) === 'string'
				? String(params.text ?? params.mermaid ?? params.orchestrationText)
				: '';
			const parsed = parseOrchestrationGraph(text);
			return {
				valid: !parsed.error,
				format: 'mermaid',
				errors: parsed.error ? [parsed.error] : [],
				warnings: (parsed.advisories ?? []).map(a => a.message),
				staffCount: parsed.nodes.filter(n => n.kind === 'staff').length,
				whiteboardCount: parsed.nodes.filter(n => n.kind === 'whiteboard').length,
				edgeCount: parsed.edges.length,
			};
		}

		case 'orchestration.load': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'load Orchestration manifest for');
			let rawManifest = params.manifest;
			if (typeof rawManifest === 'string') {
				try {
					rawManifest = JSON.parse(rawManifest);
				} catch (err) {
					throw new Error(`Malformed JSON manifest: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const validation = validateOrchestrationManifest(rawManifest);
			if (!validation.valid || !validation.manifest) {
				throw new Error(`Invalid Orchestration manifest:\n- ${validation.errors.join('\n- ')}`);
			}
			const compiled = compileOrchestrationManifest(validation.manifest);
			ctx.missionService?.updateOrchestrationText(mission.id, compiled.orchestrationText, {
				replaceWhiteboards: true,
				replacePositions: true,
			});
			const now = Date.now();
			if (Object.keys(compiled.whiteboards).length > 0) {
				const wbRecords: Record<string, IOrchestrationWhiteboard> = {};
				for (const [wid, wb] of Object.entries(compiled.whiteboards)) {
					wbRecords[wid] = {
						id: wb.id,
						title: wb.title,
						department: wb.department,
						content: wb.content,
						version: wb.version,
						createdAt: now,
						updatedAt: now,
					};
				}
				ctx.missionService?.updateWhiteboards(mission.id, wbRecords);
			}
			if (compiled.mermaidText) {
				ctx.missionService?.updateMermaid(mission.id, compiled.mermaidText);
			}
			for (const [nid, desc] of Object.entries(compiled.nodePrompts)) {
				ctx.missionService?.updateNodePrompt(mission.id, nid, desc);
			}
			for (const [nid, hooks] of Object.entries(compiled.nodeChecks)) {
				for (const hook of hooks) {
					ctx.missionService?.upsertNodeCheck(mission.id, nid, hook);
				}
			}
			// Also sync pre-configured staff engine/model/thinking/host metadata onto generated agents
			for (const s of validation.manifest.staff) {
				if (s.engineId || s.model || s.thinking || s.hostAlias) {
					await runtime.updateOrchestrationStaffConfig(mission.id, s.id, {
						...(s.engineId ? { engineId: s.engineId } : {}),
						...(s.model ? { model: s.model } : {}),
						...(s.thinking ? { thinking: s.thinking } : {}),
						...(s.hostAlias ? { hostAlias: s.hostAlias } : {}),
					}).catch(() => undefined);
				}
			}
			const orchState = runtime.getOrchestrationState(mission.id);
			return {
				ok: true,
				missionId: mission.id,
				staffCount: validation.manifest.staff.length,
				whiteboardCount: Object.keys(compiled.whiteboards).length,
				taskCount: validation.manifest.tasks?.nodes.length ?? 0,
				warnings: validation.warnings,
				nodeAgentIds: orchState.nodeAgentIds,
			};
		}

		case 'orchestration.apply':
		case 'orchestration.import': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'update Orchestration topology for');
			const text = typeof (params.text ?? params.mermaid ?? params.orchestrationText) === 'string'
				? String(params.text ?? params.mermaid ?? params.orchestrationText)
				: '';
			const parsed = parseOrchestrationGraph(text);
			if (parsed.error) {
				throw new Error(parsed.error);
			}
			const isImport = action === 'orchestration.import';
			ctx.missionService?.updateOrchestrationText(mission.id, text, isImport ? { replaceWhiteboards: true, replacePositions: true } : undefined);
			for (const staffNode of parsed.nodes) {
				if (staffNode.kind === 'staff' && staffNode.hostAlias && staffNode.hostAlias.trim() && staffNode.hostAlias.trim().toLowerCase() !== 'local') {
					await runtime.bindNodeHost(mission.id, staffNode.id, { hostAlias: staffNode.hostAlias.trim() }).catch(() => undefined);
				}
			}
			const orchState = runtime.getOrchestrationState(mission.id);
			return {
				ok: true,
				missionId: mission.id,
				layoutMode: parsed.layoutMode ?? ctx.missionService?.getMission(mission.id)?.orchestrationLayoutMode,
				groupCount: parsed.departments.length,
				staffCount: parsed.nodes.filter(n => n.kind === 'staff').length,
				whiteboardCount: parsed.nodes.filter(n => n.kind === 'whiteboard').length,
				edgeCount: parsed.edges.length,
				nodeAgentIds: orchState.nodeAgentIds,
				...(parsed.advisories && parsed.advisories.length > 0 ? { advisories: parsed.advisories } : {}),
			};
		}

		case 'orchestration.layout.set': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'change Orchestration presentation layout for');
			const rawMode = String(params.layoutMode ?? params.mode ?? params.layout ?? '').trim().toLowerCase();
			if (rawMode !== 'lr' && rawMode !== 'td' && rawMode !== 'radial' && rawMode !== 'grid') {
				throw new Error(`Invalid layout mode "${rawMode}". Expected lr, td, radial, or grid.`);
			}
			const mode = rawMode as OrchestrationLayoutMode;
			ctx.missionService?.updateOrchestrationLayoutMode?.(mission.id, mode);
			if (params.keepPositions !== true) {
				ctx.missionService?.clearOrchestrationPositions(mission.id);
			}
			if (params.persistInCode === true) {
				const nextCode = setOrchestrationLayoutInCode(mission.orchestrationText ?? '', mode, { clearPositions: params.keepPositions !== true });
				ctx.missionService?.updateOrchestrationText(mission.id, nextCode);
			}
			return { ok: true, missionId: mission.id, layoutMode: mode };
		}

		case 'orchestration.group.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const parsed = parseOrchestrationGraph(mission.orchestrationText ?? '');
			return {
				missionId: mission.id,
				groups: parsed.departments,
			};
		}

		case 'orchestration.group.create': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'create Orchestration group for');
			const name = String(params.name ?? params.title ?? '').trim();
			if (!name) {
				throw new Error('Group --name is required for orchestration.group.create.');
			}
			const res = addOrchestrationGroup(mission.orchestrationText ?? '', {
				id: typeof params.groupId === 'string' && params.groupId.trim() ? params.groupId.trim() : undefined,
				name,
			});
			if (!res.ok || !res.orchestrationText) {
				throw new Error(res.error ?? `Failed to create group "${name}".`);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, res.orchestrationText);
			return { ok: true, missionId: mission.id, groupId: res.groupId, groupName: res.groupName };
		}

		case 'orchestration.group.rename': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'rename Orchestration group for');
			const group = String(params.group ?? params.groupId ?? params.from ?? '').trim();
			const nextName = String(params.name ?? params.newName ?? params.title ?? '').trim();
			if (!group || !nextName) {
				throw new Error('Both group identifier and new --name are required for orchestration.group.rename.');
			}
			const res = renameOrchestrationGroup(mission.orchestrationText ?? '', group, nextName);
			if (!res.ok || !res.orchestrationText) {
				throw new Error(res.error ?? `Failed to rename group "${group}".`);
			}
			let syncedCode = res.orchestrationText;
			if (mission.whiteboards && res.oldName && res.newName) {
				const oldLower = res.oldName.trim().toLowerCase();
				const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...mission.whiteboards };
				let wbUpdated = false;
				for (const [wbId, wb] of Object.entries(mission.whiteboards)) {
					if (wb.department.trim().toLowerCase() === oldLower) {
						const updatedWb: IOrchestrationWhiteboard = { ...wb, department: res.newName };
						nextWbs[wbId] = updatedWb;
						syncedCode = upsertOrchestrationWhiteboardInCode(syncedCode, {
							id: updatedWb.id,
							title: updatedWb.title,
							department: updatedWb.department,
							content: updatedWb.content,
							version: updatedWb.version,
						});
						wbUpdated = true;
					}
				}
				if (wbUpdated) {
					ctx.missionService?.updateWhiteboards(mission.id, nextWbs);
				}
			}
			ctx.missionService?.updateOrchestrationText(mission.id, syncedCode);
			return { ok: true, missionId: mission.id, groupId: res.groupId, oldName: res.oldName, newName: res.newName };
		}

		case 'orchestration.group.assign': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'assign Orchestration node to group for');
			const nodeId = String(params.nodeId ?? params.node ?? '').trim();
			if (!nodeId) {
				throw new Error('Node ID (--node) is required for orchestration.group.assign.');
			}
			const targetGroup = params.ungroup === true
				? undefined
				: (typeof (params.group ?? params.groupId ?? params.department) === 'string' && String(params.group ?? params.groupId ?? params.department).trim()
					? String(params.group ?? params.groupId ?? params.department).trim()
					: undefined);
			const res = moveOrchestrationNodeToGroup(mission.orchestrationText ?? '', nodeId, targetGroup);
			if (!res.ok || !res.orchestrationText) {
				throw new Error(res.error ?? `Failed to assign node "${nodeId}" to group.`);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, res.orchestrationText);
			return { ok: true, missionId: mission.id, nodeId, groupId: res.groupId, groupName: res.groupName };
		}

		case 'orchestration.group.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'remove Orchestration group for');
			const group = String(params.group ?? params.groupId ?? params.name ?? '').trim();
			if (!group) {
				throw new Error('Group identifier is required for orchestration.group.remove.');
			}
			const res = removeOrchestrationGroup(mission.orchestrationText ?? '', group, {
				deleteMembers: params.deleteMembers === true,
			});
			if (!res.ok || !res.orchestrationText) {
				throw new Error(res.error ?? `Failed to remove group "${group}".`);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, res.orchestrationText);
			if (params.deleteMembers === true && res.removedNodeIds && res.removedNodeIds.length > 0 && mission.whiteboards) {
				const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...mission.whiteboards };
				let wbDeleted = false;
				for (const nid of res.removedNodeIds) {
					if (Object.hasOwn(nextWbs, nid)) {
						delete nextWbs[nid];
						wbDeleted = true;
					}
				}
				if (wbDeleted) {
					ctx.missionService?.updateWhiteboards(mission.id, nextWbs);
				}
			}
			return { ok: true, missionId: mission.id, groupId: res.groupId, removedNodeIds: res.removedNodeIds ?? [] };
		}

		case 'orchestration.staff.rename': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'rename Orchestration staff node for');
			const nodeId = String(params.nodeId ?? params.node ?? '').trim();
			const label = String(params.label ?? params.name ?? params.title ?? '').trim();
			if (!nodeId || !label) {
				throw new Error('Both --node and new --name/--label are required for orchestration.staff.rename.');
			}
			const curText = mission.orchestrationText ?? '';
			const parsed = parseOrchestrationGraph(curText);
			if (!parsed.nodes.some(n => n.id === nodeId)) {
				throw new Error(`Staff node "${nodeId}" not found in Orchestration graph.`);
			}
			const nextText = renameOrchestrationNode(curText, nodeId, label);
			const reparsed = parseOrchestrationGraph(nextText);
			if (reparsed.error) {
				throw new Error(reparsed.error);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, nextText);
			return { ok: true, missionId: mission.id, nodeId, label };
		}

		case 'orchestration.staff.configure': {
			const mission = resolveMissionRecord(params, ctx);
			const nodeId = String(params.nodeId ?? params.node ?? '').trim();
			if (!nodeId) {
				throw new Error('Staff node ID (--node) is required for orchestration.staff.configure.');
			}
			assertStaffConfigureAuthority(ctx, mission, nodeId);
			const allowedPaths = params.allowedPaths === null
				? null
				: Array.isArray(params.allowedPaths)
					? params.allowedPaths.map(v => String(v).trim()).filter(Boolean)
					: (typeof params.allowedPaths === 'string'
						? params.allowedPaths.split(/[|,;]/).map(s => s.trim()).filter(Boolean)
						: undefined);
			const res = await runtime.updateOrchestrationStaffConfig(mission.id, nodeId, {
				...(params.engineId !== undefined || params.engine !== undefined ? { engineId: (params.engineId ?? params.engine) as string | null } : {}),
				...(params.model !== undefined ? { model: params.model as string | null } : {}),
				...(params.thinking !== undefined ? { thinking: params.thinking as string | null } : {}),
				...(params.hostAlias !== undefined || params.host !== undefined ? { hostAlias: (params.hostAlias ?? params.host) as string | null } : {}),
				...(params.rolePrompt !== undefined ? { rolePrompt: params.rolePrompt as string | null } : {}),
				...(allowedPaths !== undefined ? { allowedPaths } : {}),
				...(params.color !== undefined || params.accent !== undefined ? { color: (params.color ?? params.accent) as string | null } : {}),
				resetSession: params.resetSession === true,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to configure staff node "${nodeId}".`);
			}
			return { ...res, missionId: mission.id };
		}

		case 'orchestration.staff.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const nodeId = String(params.nodeId ?? params.node ?? '').trim();
			if (!nodeId) {
				throw new Error('Staff node ID (--node) is required for orchestration.staff.remove.');
			}
			const orchState = runtime.getOrchestrationState(mission.id);
			const requestedCallerNodeId = typeof params.callerNodeId === 'string' && params.callerNodeId.trim()
				? params.callerNodeId.trim()
				: undefined;
			let callerNodeId: string | undefined;
			if (ctx.isHumanUser || ctx.isSecretary) {
				callerNodeId = requestedCallerNodeId;
			} else if (ctx.callerSessionId) {
				for (const [nid, aid] of Object.entries(orchState.nodeAgentIds)) {
					if (aid === ctx.callerSessionId) {
						callerNodeId = nid;
						break;
					}
				}
				if (requestedCallerNodeId && requestedCallerNodeId !== callerNodeId) {
					throw new Error(`FORBIDDEN: authenticated caller "${ctx.callerSessionId}" cannot impersonate staff node "${requestedCallerNodeId}" in orchestration.staff.remove.`);
				}
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = await runtime.removeOrchestrationSubordinate(mission.id, {
				targetNodeId: nodeId,
				callerNodeId,
				callerTier,
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				force: params.force === true,
				reason: typeof params.reason === 'string' ? params.reason : undefined,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to remove staff node "${nodeId}".`);
			}
			return {
				ok: true,
				missionId: mission.id,
				removedNodeId: res.removedNodeId,
				reclaimedTokenIds: res.reclaimedTokenIds ?? [],
				recoveryTokenIds: res.recoveryTokenIds ?? [],
				settledBarrierIds: res.settledBarrierIds ?? [],
				reparentedTokenIds: res.reparentedTokenIds ?? [],
			};
		}

		case 'orchestration.pause': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'pause Orchestration for');
			const reason = typeof params.reason === 'string' ? params.reason : undefined;
			const res = await runtime.pauseOrchestration(mission.id, reason);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to pause Orchestration.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status };
		}

		case 'orchestration.resume': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'resume Orchestration for');
			const res = await runtime.resumeOrchestration(mission.id);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to resume Orchestration.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'orchestration.abort': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'abort all active Orchestration tokens for');
			const reason = typeof params.reason === 'string' ? params.reason : undefined;
			const res = await runtime.abortOrchestrationTokens(mission.id, reason);
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to abort Orchestration tokens.');
			}
			return { ok: true, missionId: mission.id, status: res.state.status, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'orchestration.edge.connect': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'connect Orchestration edge for');
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to node IDs are required for orchestration.edge.connect.');
			}
			const bidirectional = params.bidirectional !== false;
			const label = typeof params.label === 'string' && params.label.trim() ? params.label.trim() : undefined;
			const dashed = params.dashed === true;
			const res = connectOrchestrationEdge(mission.orchestrationText ?? '', from, to, { label, bidirectional, dashed });
			if (!res.ok || !res.orchestrationText) {
				throw new Error(res.error ?? `Failed to connect edge "${from}" -> "${to}".`);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, res.orchestrationText);
			return { ok: true, missionId: mission.id, from, to, bidirectional, ...(label ? { label } : {}), ...(dashed ? { dashed: true } : {}) };
		}

		case 'orchestration.edge.label': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'edit Orchestration edge label for');
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			const label = typeof params.label === 'string' ? params.label.trim() : '';
			if (!from || !to) {
				throw new Error('Both --from and --to node IDs are required for orchestration.edge.label.');
			}
			const nextText = renameOrchestrationEdgeLabel(mission.orchestrationText ?? '', from, to, label);
			ctx.missionService?.updateOrchestrationText(mission.id, nextText);
			return { ok: true, missionId: mission.id, from, to, label };
		}

		case 'orchestration.edge.remove': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'remove Orchestration edge for');
			const from = String(params.from ?? '').trim();
			const to = String(params.to ?? '').trim();
			if (!from || !to) {
				throw new Error('Both --from and --to node IDs are required for orchestration.edge.remove.');
			}
			let nextText = removeOrchestrationEdge(mission.orchestrationText ?? '', from, to);
			if (params.both === true) {
				nextText = removeOrchestrationEdge(nextText, to, from);
			}
			ctx.missionService?.updateOrchestrationText(mission.id, nextText);
			return { ok: true, missionId: mission.id, from, to, ...(params.both === true ? { both: true } : {}) };
		}

		case 'orchestration.status': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const parsed = parseOrchestrationGraph(mission.orchestrationText ?? '');
			const orchState = runtime.getOrchestrationState(mission.id);
			const tokens = Object.values(orchState.tokens);
			return {
				missionId: mission.id,
				title: mission.title,
				status: orchState.status ?? 'running',
				...(orchState.pausedAt ? { pausedAt: orchState.pausedAt } : {}),
				...(orchState.pausedReason ? { pausedReason: orchState.pausedReason } : {}),
				silenceReminderMinutes: orchState.silenceReminderMinutes,
				staffCount: parsed.nodes.filter(n => n.kind === 'staff').length,
				whiteboardCount: parsed.nodes.filter(n => n.kind === 'whiteboard').length,
				edgeCount: parsed.edges.length,
				nodeStates: orchState.nodeStates,
				nodeAgentIds: orchState.nodeAgentIds,
				activeTokenCount: tokens.filter(t => t.status === 'active').length,
				blockedTokenCount: tokens.filter(t => t.status === 'blocked').length,
				waitingJoinCount: tokens.filter(t => t.status === 'waiting_join').length,
				joinBarriers: orchState.joinBarriers ?? {},
				archivedTokenCount: orchState.archivedTokenCount ?? 0,
				archivedTraceCount: orchState.archivedTraceCount ?? 0,
				tokens,
				...(parsed.advisories && parsed.advisories.length > 0 ? { advisories: parsed.advisories } : {}),
				updatedAt: orchState.updatedAt,
			};
		}

		case 'orchestration.dispatch': {
			const mission = resolveMissionRecord(params, ctx);
			assertFullMissionControlAuthority(ctx, mission, 'dispatch requirement into Orchestration for');
			const prompt = String(params.prompt ?? params.message ?? params.text ?? '').trim();
			if (!prompt) {
				throw new Error('Requirement --prompt is required for orchestration.dispatch.');
			}
			const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
			const rawWb = params.whiteboardIds ?? params.whiteboards ?? params.whiteboard;
			const whiteboardIds = Array.isArray(rawWb)
				? rawWb.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawWb === 'string' ? rawWb.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const parseBlobInputs = (raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined => {
				if (!Array.isArray(raw)) {
					return undefined;
				}
				const out: IOrchestrationContextBlobInput[] = [];
				for (const item of raw) {
					if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
						out.push({
							title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '',
							content: (item as { content: string }).content,
						});
					}
				}
				return out.length > 0 ? out : undefined;
			};
			const taskNodeId = typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
				? String(params.taskNodeId ?? params.task ?? params.taskNode).trim()
				: undefined;
			const rawTaskIds = params.taskNodeIds ?? params.tasks;
			const taskNodeIds = Array.isArray(rawTaskIds)
				? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const res = await runtime.dispatchOrchestrationRequirement(mission.id, {
				prompt,
				...(detail ? { detail } : {}),
				targetNodeId: typeof (params.targetNodeId ?? params.to ?? params.node) === 'string'
					? String(params.targetNodeId ?? params.to ?? params.node).trim()
					: undefined,
				...(taskNodeId ? { taskNodeId } : {}),
				...(taskNodeIds && taskNodeIds.length > 0 ? { taskNodeIds } : {}),
				whiteboardIds,
				...(parseBlobInputs(params.artifacts) ? { artifacts: parseBlobInputs(params.artifacts) } : {}),
				...(parseBlobInputs(params.decisions) ? { decisions: parseBlobInputs(params.decisions) } : {}),
			});
			if (!res.ok) {
				throw new Error(res.error ?? 'Failed to dispatch Orchestration requirement.');
			}
			return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
		}

		case 'orchestration.staff.create': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const name = String(params.name ?? params.employee ?? '').trim();
			if (!name) {
				throw new Error('Staff employee --name is required for orchestration.staff.create.');
			}
			const orchState = runtime.getOrchestrationState(mission.id);
			const requestedCallerNodeId = typeof params.callerNodeId === 'string' && params.callerNodeId.trim()
				? params.callerNodeId.trim()
				: undefined;
			let callerNodeId: string | undefined;
			if (ctx.isHumanUser || ctx.isSecretary) {
				callerNodeId = requestedCallerNodeId;
			} else if (ctx.callerSessionId) {
				for (const [nid, aid] of Object.entries(orchState.nodeAgentIds)) {
					if (aid === ctx.callerSessionId) {
						callerNodeId = nid;
						break;
					}
				}
				if (requestedCallerNodeId && requestedCallerNodeId !== callerNodeId) {
					throw new Error(`FORBIDDEN: authenticated caller "${ctx.callerSessionId}" cannot impersonate staff node "${requestedCallerNodeId}" in orchestration.staff.create.`);
				}
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const rawWb = params.whiteboardIds ?? params.whiteboards ?? params.whiteboard;
			const whiteboardIds = Array.isArray(rawWb)
				? rawWb.map(v => String(v).trim()).filter(Boolean)
				: (typeof rawWb === 'string' ? rawWb.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const res = await runtime.createOrchestrationSubordinate(mission.id, {
				callerNodeId,
				callerAgentId: ctx.callerSessionId,
				callerTier,
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				id: typeof params.id === 'string' && params.id.trim() ? params.id.trim() : undefined,
				name,
				roleLabel: typeof params.roleLabel === 'string' ? params.roleLabel : undefined,
				targetRankIdOrTier: params.rank as string | number | undefined,
				department: typeof params.department === 'string' ? params.department : undefined,
				engineId: typeof params.engineId === 'string' ? params.engineId : undefined,
				model: typeof params.model === 'string' ? params.model : undefined,
				thinking: typeof params.thinking === 'string' ? params.thinking : undefined,
				hostAlias: typeof params.hostAlias === 'string' ? params.hostAlias : undefined,
				rolePrompt: typeof params.rolePrompt === 'string' ? params.rolePrompt : undefined,
				allowedPaths: Array.isArray(params.allowedPaths) ? params.allowedPaths.map(v => String(v).trim()).filter(Boolean) : undefined,
				color: typeof (params.color ?? params.accent) === 'string' ? String(params.color ?? params.accent).trim() : undefined,
				bidirectional: params.bidirectional !== false,
				edgeLabel: typeof params.edgeLabel === 'string' ? params.edgeLabel : undefined,
				handoffTokenId: typeof params.handoffTokenId === 'string' ? params.handoffTokenId : undefined,
				mintTokenId: typeof params.mintTokenId === 'string' ? params.mintTokenId : undefined,
				handoffSummary: typeof params.handoffSummary === 'string' ? params.handoffSummary : undefined,
				whiteboardIds,
			});
			if (!res.ok) {
				throw new Error(res.error ?? `Failed to dynamically create subordinate "${name}".`);
			}
			return {
				ok: true,
				missionId: mission.id,
				nodeId: res.newNodeId,
				agentId: res.agentId,
				...(res.nextTokenIds ? { nextTokenIds: res.nextTokenIds } : {}),
			};
		}

		// =====================================================================
		// Department Shared Whiteboards (`whiteboard.*`)
		// =====================================================================
		case 'whiteboard.list': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const deptFilter = typeof (params.department ?? params.dept) === 'string' && String(params.department ?? params.dept).trim()
				? String(params.department ?? params.dept).trim().toLowerCase()
				: undefined;
			const whiteboards = runtime.listOrchestrationWhiteboards(mission.id, {
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				callerTier,
				callerAgentId: ctx.callerSessionId,
			}).filter(wb => !deptFilter || wb.department.trim().toLowerCase() === deptFilter);
			// Return lightweight index (pointer metadata) so listing never floods context!
			return {
				missionId: mission.id,
				whiteboards: whiteboards.map(wb => ({
					whiteboardId: wb.id,
					title: wb.title,
					department: wb.department,
					version: wb.version,
					contentLength: wb.content.length,
					updatedAt: wb.updatedAt,
					updatedByLabel: wb.updatedByLabel,
				})),
			};
		}

		case 'whiteboard.read': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const id = String(params.id ?? params.whiteboardId ?? params.whiteboard ?? '').trim();
			if (!id) {
				throw new Error('Whiteboard ID is required for whiteboard.read.');
			}
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = runtime.readOrchestrationWhiteboard(mission.id, id, {
				isHumanUser: ctx.isHumanUser,
				isSecretary: ctx.isSecretary,
				callerTier,
				callerAgentId: ctx.callerSessionId,
			});
			if (!res.ok || !res.whiteboard) {
				throw new Error(res.error ?? `Unable to read whiteboard "${id}".`);
			}
			return { ok: true, missionId: mission.id, whiteboard: res.whiteboard };
		}

		case 'whiteboard.create':
		case 'whiteboard.write': {
			const mission = resolveMissionRecord(params, ctx);
			assertMissionMemberOrSupervisor(ctx, mission);
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const rawExpectedVersion = params.expectedVersion ?? params.ifVersion;
			let expectedVersion: number | undefined;
			if (rawExpectedVersion !== undefined && rawExpectedVersion !== null && String(rawExpectedVersion).trim() !== '') {
				const parsedVer = Number(rawExpectedVersion);
				if (!Number.isInteger(parsedVer) || parsedVer < 0) {
					throw new Error(`Invalid --expected-version "${String(rawExpectedVersion)}": must be a non-negative integer.`);
				}
				expectedVersion = parsedVer;
			}
			const res = runtime.upsertOrchestrationWhiteboard(mission.id, {
				id: typeof (params.id ?? params.whiteboardId) === 'string' && String(params.id ?? params.whiteboardId).trim()
					? String(params.id ?? params.whiteboardId).trim()
					: undefined,
				title: typeof params.title === 'string' ? params.title : undefined,
				department: typeof params.department === 'string' ? params.department : undefined,
				content: typeof params.content === 'string' ? params.content : undefined,
				appendContent: typeof params.appendContent === 'string' ? params.appendContent : undefined,
				mode: action === 'whiteboard.create' ? 'create' : 'write',
				...(expectedVersion !== undefined ? { expectedVersion } : {}),
				caller: {
					isHumanUser: ctx.isHumanUser,
					isSecretary: ctx.isSecretary,
					callerTier,
					callerAgentId: ctx.callerSessionId,
					callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
				},
			});
			if (!res.ok || !res.whiteboard) {
				throw new Error(res.error ?? 'Failed to write Department Whiteboard.');
			}
			return {
				ok: true,
				missionId: mission.id,
				whiteboard: {
					whiteboardId: res.whiteboard.id,
					title: res.whiteboard.title,
					department: res.whiteboard.department,
					version: res.whiteboard.version,
					updatedAt: res.whiteboard.updatedAt,
				},
			};
		}

		case 'whiteboard.rename': {
			const mission = resolveMissionRecord(params, ctx);
			const wbId = String(params.whiteboardId ?? params.whiteboard ?? params.id ?? '').trim();
			const title = String(params.title ?? params.name ?? '').trim();
			const department = typeof params.department === 'string' && params.department.trim() ? params.department.trim() : undefined;
			if (!wbId || !title) {
				throw new Error('Whiteboard ID and new --title are required for whiteboard.rename.');
			}
			const existing = runtime.listOrchestrationWhiteboards(mission.id).find(w => w.id === wbId);
			if (!existing) {
				throw new Error(`Department whiteboard "${wbId}" not found.`);
			}
			const nextDept = department ?? existing.department;
			assertDepartmentWhiteboardAdminAuthority(ctx, mission, [existing.department, nextDept], 'rename');
			const callerTier = ctx.callerAgent
				? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
				: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
			const res = runtime.upsertOrchestrationWhiteboard(mission.id, {
				id: wbId,
				title,
				department: nextDept,
				mode: 'write',
				caller: {
					isHumanUser: ctx.isHumanUser,
					isSecretary: ctx.isSecretary,
					callerTier,
					callerAgentId: ctx.callerSessionId,
					callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
				},
			});
			if (!res.ok || !res.whiteboard) {
				throw new Error(res.error ?? `Failed to rename whiteboard "${wbId}".`);
			}
			const latestMission = ctx.missionService?.getMission(mission.id) ?? mission;
			const nextCode = upsertOrchestrationWhiteboardInCode(latestMission.orchestrationText ?? '', {
				id: res.whiteboard.id,
				title: res.whiteboard.title,
				department: res.whiteboard.department,
				content: res.whiteboard.content,
				version: res.whiteboard.version,
			});
			ctx.missionService?.updateOrchestrationText(mission.id, nextCode);
			return {
				ok: true,
				missionId: mission.id,
				whiteboard: {
					whiteboardId: res.whiteboard.id,
					title: res.whiteboard.title,
					department: res.whiteboard.department,
					version: res.whiteboard.version,
				},
			};
		}

		case 'whiteboard.remove': {
			const mission = resolveMissionRecord(params, ctx);
			const wbId = String(params.whiteboardId ?? params.whiteboard ?? params.id ?? '').trim();
			if (!wbId) {
				throw new Error('Whiteboard ID is required for whiteboard.remove.');
			}
			const existing = runtime.listOrchestrationWhiteboards(mission.id).find(w => w.id === wbId);
			if (!existing) {
				throw new Error(`Department whiteboard "${wbId}" not found.`);
			}
			assertDepartmentWhiteboardAdminAuthority(ctx, mission, [existing.department], 'remove');
			const removed = runtime.removeOrchestrationWhiteboard(mission.id, wbId);
			if (!removed.ok) {
				throw new Error(removed.error ?? `Failed to remove whiteboard "${wbId}".`);
			}
			return {
				ok: true,
				missionId: mission.id,
				removedWhiteboardId: wbId,
				...(removed.prunedTokenIds && removed.prunedTokenIds.length > 0 ? { prunedTokenIds: removed.prunedTokenIds } : {}),
			};
		}

		default:
			throw new Error(`Unsupported Mission runtime action: ${action}`);
	}
}
