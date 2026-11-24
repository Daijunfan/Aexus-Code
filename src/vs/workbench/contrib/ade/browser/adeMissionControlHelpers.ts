/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isStrictCompanyWideExecutiveDept } from '../../../../platform/ade/common/adeControlPolicy.js';
import { resolveSupervisorJurisdiction } from '../../../../platform/ade/common/adeMissionBoundary.js';
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionEngineCaller } from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	findHighestRankStaffNode,
	resolveEffectiveStaffTier,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { parseOrchestrationGraph } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { IAdeOrganizationConfig, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
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

export function findAssociatedMissionsForSession(
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

export function resolveMissionRecord(
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

export function buildEngineCaller(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord): IMissionEngineCaller {
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

export function assertMissionMemberOrSupervisor(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord): void {
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

export function isOrchestrationBackedMission(mission: IAdeMissionRecord): boolean {
	if (!mission.orchestrationText?.trim()) {
		return false;
	}
	const parsed = parseOrchestrationGraph(mission.orchestrationText);
	return !parsed.error && parsed.nodes.some(n => n.kind === 'staff');
}

export function assertNotOrchestrationLegacyAction(mission: IAdeMissionRecord, action: string, replacement: string): void {
	if (isOrchestrationBackedMission(mission)) {
		throw new Error(
			`LEGACY_API_REMOVED: "${action}" is a retired static-Mission API and cannot be used on Orchestration-backed Engineering workspace "${mission.id}". Use ${replacement} instead.`,
		);
	}
}

export function assertFullMissionControlAuthority(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord, actionLabel: string): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	if (!ctx.callerSessionId) {
		throw new Error(`FORBIDDEN: cannot ${actionLabel} Mission "${mission.id}" without an authenticated supervisor/owner session.`);
	}
	if (mission.ownerSessionId === ctx.callerSessionId) {
		return;
	}
	if (mission.orchestrationText?.trim() && ctx.callerAgent) {
		const orch = ctx.missionRuntime?.getOrchestrationState(mission.id);
		const boundNodeId = (orch ? Object.entries(orch.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0] : undefined)
			?? (ctx.callerAgent.treeGovernorId === mission.id ? ctx.callerAgent.treeNodeId : undefined);
		if (boundNodeId) {
			const parsed = parseOrchestrationGraph(mission.orchestrationText);
			const highestNode = !parsed.error ? findHighestRankStaffNode(parsed) : undefined;
			const callerTier = resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier;
			const highestTier = Math.min(...ctx.roleConfig.ranks.map(r => r.tier));
			if (callerTier <= highestTier || (highestNode && highestNode.id === boundNodeId)) {
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

export function assertDepartmentWhiteboardAdminAuthority(
	ctx: IAdeMissionControlContext,
	mission: IAdeMissionRecord,
	targetDepartments: readonly (string | undefined)[],
	actionLabel: string,
): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	assertMissionMemberOrSupervisor(ctx, mission);
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
			if (isStrictCompanyWideExecutiveDept(callerDept)) {
				return;
			}
			if (!callerDept) {
				throw new Error(
					`CROSS_DEPARTMENT_FORBIDDEN: department lead "${callerNodeId}" has no assigned department and cannot ${actionLabel} Department Whiteboard.`,
				);
			}
			const nonEmptyTargets = targetDepartments.map(d => d?.trim()).filter((d): d is string => Boolean(d));
			const allSameDept = nonEmptyTargets.length > 0 && nonEmptyTargets.every(d => d.toLowerCase() === callerDept.toLowerCase());
			if (allSameDept) {
				return;
			}
			throw new Error(
				`CROSS_DEPARTMENT_FORBIDDEN: department lead "${callerNodeId}" ("${callerDept}") cannot ${actionLabel} whiteboard in foreign department (${nonEmptyTargets.join(' -> ') || 'General'}).`,
			);
		}
	}
	assertFullMissionControlAuthority(ctx, mission, `${actionLabel} Department Whiteboard for`);
}

export function assertStaffConfigureAuthority(
	ctx: IAdeMissionControlContext,
	mission: IAdeMissionRecord,
	targetNodeId: string,
): void {
	if (ctx.isHumanUser || ctx.isSecretary) {
		return;
	}
	assertMissionMemberOrSupervisor(ctx, mission);
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
	if (mission.orchestrationText?.trim() && ctx.missionRuntime && ctx.callerSessionId && callerRank && !callerRank.pureExecution && callerRank.canHaveSubordinates) {
		const orch = ctx.missionRuntime.getOrchestrationState(mission.id);
		const callerNodeId = Object.entries(orch.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0];
		if (callerNodeId && callerNodeId !== targetNodeId) {
			const parsed = parseOrchestrationGraph(mission.orchestrationText);
			const callerNode = parsed.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
			const targetNode = parsed.nodes.find(n => n.id === targetNodeId && n.kind === 'staff');
			if (callerNode && targetNode) {
				const targetTier = resolveEffectiveStaffTier(targetNode, ctx.roleConfig);
				const strictlyLower = targetTier !== undefined && targetTier > callerRank.tier;
				const callerDept = callerNode.department?.trim();
				const targetDept = targetNode.department?.trim();
				const sameDept = isStrictCompanyWideExecutiveDept(callerDept)
					|| (Boolean(callerDept) && Boolean(targetDept) && targetDept!.toLowerCase() === callerDept!.toLowerCase());
				const hasDirectEdge = parsed.edges.some(e => e.from === callerNodeId && e.to === targetNodeId);
				if (strictlyLower && sameDept && hasDirectEdge) {
					return;
				}
				if (!strictlyLower) {
					throw new Error(`FORBIDDEN: staff "${callerNodeId}" (L${callerRank.tier}) cannot configure equal/higher-rank staff "${targetNodeId}".`);
				}
				if (!sameDept) {
					throw new Error(`CROSS_DEPARTMENT_FORBIDDEN: staff "${callerNodeId}" ("${callerDept || 'Unassigned'}") cannot configure staff "${targetNodeId}" in department "${targetDept || 'Unassigned'}".`);
				}
				throw new Error(`FORBIDDEN: staff "${targetNodeId}" does not report directly to "${callerNodeId}".`);
			}
		}
	}
	assertFullMissionControlAuthority(ctx, mission, 'configure Orchestration staff node for');
}

export function assertMissionTaskDesignScope(
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
	assertMissionMemberOrSupervisor(ctx, mission);
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
		assertFullMissionControlAuthority(ctx, mission, `${actionLabel} Mission task for`);
		return;
	}
	const orch = ctx.missionRuntime.getOrchestrationState(mission.id);
	const callerNodeId = Object.entries(orch.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0];
	if (!callerNodeId) {
		assertFullMissionControlAuthority(ctx, mission, `${actionLabel} Mission task for`);
		return;
	}
	const parsedOrch = parseOrchestrationGraph(mission.orchestrationText);
	const callerNode = parsedOrch.nodes.find(n => n.id === callerNodeId && n.kind === 'staff');
	const callerDept = callerNode?.department?.trim();
	if (isStrictCompanyWideExecutiveDept(callerDept)) {
		return;
	}
	if (!callerDept) {
		throw new Error(`CROSS_DEPARTMENT_FORBIDDEN: supervisor "${callerNodeId}" has no assigned department and cannot ${actionLabel} Mission tasks.`);
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
			const ownerTier = ownerNode ? resolveEffectiveStaffTier(ownerNode, ctx.roleConfig) : undefined;
			if (ownerTier !== undefined && ownerTier < callerRank.tier) {
				throw new Error(`FORBIDDEN: supervisor "${callerNodeId}" (L${callerRank.tier}) cannot ${actionLabel} Mission task "${options.targetTask.id}" owned by superior "${ownerNode!.id}" (L${ownerTier}).`);
			}
		}
	}
}

export function assertInGraphTokenCaller(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord, tokenId?: string): string | undefined {
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
	const isOffGraphSupervisor = runtime.boundary.supervisors.some(s => s.id === ctx.callerSessionId);
	if (isOffGraphSupervisor) {
		throw new Error('FORBIDDEN: off-graph supervisors cannot call in-graph token execution APIs; use org.* or mission.* commands.');
	}
	const orchAgentIds = mission.orchestrationText?.trim()
		? Object.values(ctx.missionRuntime?.getOrchestrationState(mission.id).nodeAgentIds ?? {})
		: [];
	const isAssignedInThisMission = Object.values(runtime.boundary.nodeAssignments).some(a => a.agentId === ctx.callerSessionId)
		|| orchAgentIds.includes(ctx.callerSessionId)
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

export function isCompanyWideOrgSupervisor(
	node: { readonly department?: string } | undefined,
	effectiveTier: number | undefined,
	roleConfig: IAdeOrganizationConfig,
): boolean {
	const highestTier = roleConfig.ranks.length > 0 ? Math.min(...roleConfig.ranks.map(r => r.tier)) : 1;
	if (effectiveTier !== undefined && effectiveTier <= highestTier) {
		return true;
	}
	return isStrictCompanyWideExecutiveDept(node?.department);
}

export function resolveOrgTargetAgent(
	targetRaw: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): IAdeAgent | undefined {
	const lookupInMission = (rec: IAdeMissionRecord): IAdeAgent | undefined => {
		if (!ctx.missionRuntime) {
			return undefined;
		}
		if (rec.orchestrationText?.trim()) {
			const orchState = ctx.missionRuntime.getOrchestrationState(rec.id);
			const directOrchAgentId = orchState.nodeAgentIds[targetRaw];
			if (directOrchAgentId) {
				const byOrch = ctx.projects.getAgent(directOrchAgentId);
				if (byOrch) {
					return byOrch;
				}
			}
			const parsedOrch = parseOrchestrationGraph(rec.orchestrationText);
			if (!parsedOrch.error) {
				const byNameOrLabel = parsedOrch.nodes.find(
					n => n.kind === 'staff' && (n.id === targetRaw || n.employeeName === targetRaw || n.label === targetRaw),
				);
				if (byNameOrLabel) {
					const mappedId = orchState.nodeAgentIds[byNameOrLabel.id] ?? byNameOrLabel.agentId;
					if (mappedId) {
						const ag = ctx.projects.getAgent(mappedId);
						if (ag) {
							return ag;
						}
					}
				}
			}
		}
		if (!isOrchestrationBackedMission(rec)) {
			const rt = ctx.missionRuntime.getRuntimeState(rec.id);
			const assignedId = rt.boundary.nodeAssignments[targetRaw]?.agentId;
			if (assignedId) {
				const byNode = ctx.projects.getAgent(assignedId);
				if (byNode) {
					return byNode;
				}
			}
		}
		return undefined;
	};

	const explicitMission = String(params.mission ?? params.missionId ?? '').trim();
	if (explicitMission && ctx.missionService && ctx.missionRuntime) {
		const rec = ctx.missionService.getMission(explicitMission) ?? ctx.missionService.getMissionByLinkedSession(explicitMission);
		if (rec) {
			const hit = lookupInMission(rec);
			if (hit) {
				return hit;
			}
		}
	}
	const exactAgent = ctx.projects.getAgent(targetRaw);
	if (exactAgent) {
		return exactAgent;
	}
	if (ctx.missionRuntime) {
		const associated = ctx.callerSessionId ? findAssociatedMissionsForSession(ctx.callerSessionId, ctx) : [];
		for (const rec of associated) {
			const hit = lookupInMission(rec);
			if (hit) {
				return hit;
			}
		}
		if (ctx.isHumanUser || ctx.isSecretary || associated.length === 0) {
			for (const rec of ctx.missionService?.listMissions() ?? []) {
				const hit = lookupInMission(rec);
				if (hit) {
					return hit;
				}
			}
		}
	}
	return ctx.projects.agents.find(a => a.id.startsWith(targetRaw) || a.label === targetRaw);
}

export function assertSupervisorHasAuthorityOverTarget(
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

	const sidebarCallerTier = resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier;
	const sidebarTargetTier = resolveEffectiveRankDefinition(ctx.roleConfig, targetAgent.role, ctx.projects.hasSubordinates(targetAgent.id)).tier;

	const missions = ctx.missionService?.listMissions() ?? [];
	const highestTier = ctx.roleConfig.ranks.length > 0 ? Math.min(...ctx.roleConfig.ranks.map(r => r.tier)) : 1;
	let matchedSharedOrch = false;
	for (const rec of missions) {
		if (!rec.orchestrationText?.trim() || !ctx.missionRuntime) {
			continue;
		}
		const orchState = ctx.missionRuntime.getOrchestrationState(rec.id);
		let callerNodeId: string | undefined;
		let targetNodeId: string | undefined;
		for (const [nid, aid] of Object.entries(orchState.nodeAgentIds)) {
			if (aid === ctx.callerSessionId) { callerNodeId = nid; }
			if (aid === targetAgent.id) { targetNodeId = nid; }
		}
		if (!callerNodeId || !targetNodeId) {
			continue;
		}
		const orchGraph = parseOrchestrationGraph(rec.orchestrationText);
		if (orchGraph.error) {
			continue;
		}
		matchedSharedOrch = true;
		const staffNodes = orchGraph.nodes.filter(n => n.kind === 'staff');
		const callerNode = staffNodes.find(n => n.id === callerNodeId);
		const targetNode = staffNodes.find(n => n.id === targetNodeId);
		const callerOrchTier = resolveEffectiveStaffTier(callerNode, ctx.roleConfig) ?? sidebarCallerTier;
		const targetOrchTier = resolveEffectiveStaffTier(targetNode, ctx.roleConfig) ?? sidebarTargetTier;

		if (callerOrchTier >= targetOrchTier) {
			return {
				authorized: false,
				reason: `UPWARD_MESSAGE_FORBIDDEN: strictly top-down communication only. Caller (L${callerOrchTier}) cannot message/inspect target "${targetAgent.label}" (L${targetOrchTier}). Subordinates must report via token.* or org.escalate.`,
			};
		}

		const isExecCaller = isCompanyWideOrgSupervisor(callerNode, callerOrchTier, ctx.roleConfig);
		if (callerOrchTier <= highestTier) {
			return { authorized: true, viaMissionId: rec.id };
		}

		const callerDept = callerNode?.department?.trim();
		const targetDept = targetNode?.department?.trim();
		const deptMatch = isExecCaller
			|| !targetDept
			|| (callerDept !== undefined && callerDept.toLowerCase() === targetDept.toLowerCase());
		if (deptMatch) {
			const visited = new Set<string>([callerNodeId]);
			const queue: string[] = [callerNodeId];
			while (queue.length > 0) {
				const cur = queue.shift()!;
				const curNode = staffNodes.find(n => n.id === cur);
				const curTier = resolveEffectiveStaffTier(curNode, ctx.roleConfig);
				for (const e of orchGraph.edges) {
					if (e.from !== cur || visited.has(e.to)) { continue; }
					const nxt = staffNodes.find(n => n.id === e.to);
					if (!nxt) { continue; }
					const nxtTier = resolveEffectiveStaffTier(nxt, ctx.roleConfig);
					if (nxtTier !== undefined && nxtTier <= callerOrchTier) {
						continue;
					}
					if (curTier !== undefined && nxtTier !== undefined && nxtTier < curTier) {
						continue;
					}
					if (!isExecCaller && nxt.department && callerDept && nxt.department.trim().toLowerCase() !== callerDept.toLowerCase()) {
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

	if (sidebarCallerTier >= sidebarTargetTier) {
		return {
			authorized: false,
			reason: `UPWARD_MESSAGE_FORBIDDEN: strictly top-down communication only. Caller (L${sidebarCallerTier}) cannot message/inspect target "${targetAgent.label}" (L${sidebarTargetTier}). Subordinates must report via token.* or org.escalate.`,
		};
	}

	if (!matchedSharedOrch && ctx.isStrictDescendant(targetAgent.id, ctx.callerAgent.id)) {
		return { authorized: true };
	}

	for (const rec of missions) {
		if (isOrchestrationBackedMission(rec)) {
			continue;
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
		reason: `OUT_OF_JURISDICTION: target "${targetAgent.label}" (${targetAgent.id}) is outside your subordinate tree and department jurisdiction.`,
	};
}

export function assertOrchestrationTokenCaller(ctx: IAdeMissionControlContext, mission: IAdeMissionRecord, tokenId?: string): string | undefined {
	if (ctx.isHumanUser) {
		return undefined;
	}
	if (!ctx.callerSessionId || !ctx.callerAgent) {
		throw new Error('FORBIDDEN: Orchestration token operations require an authenticated staff session.');
	}
	assertMissionMemberOrSupervisor(ctx, mission);
	const orch = ctx.missionRuntime?.getOrchestrationState(mission.id);
	if (!orch) {
		throw new Error('ADE Mission runtime service is not available.');
	}
	if (tokenId) {
		const tok = orch.tokens[tokenId];
		if (tok) {
			const holder = orch.nodeAgentIds[tok.nodeId] ?? tok.holderAgentId;
			if (!holder || holder !== ctx.callerSessionId) {
				throw new Error(`FORBIDDEN: Orchestration token "${tokenId}" on staff node "${tok.nodeId}" is not held by caller "${ctx.callerSessionId}".`);
			}
		}
	}
	return ctx.callerSessionId;
}

export function findMissionByTokenId(ctx: IAdeMissionControlContext, tokenId: string): IAdeMissionRecord | undefined {
	for (const rec of ctx.missionService?.listMissions() ?? []) {
		if (rec.orchestrationRuntime?.tokens[tokenId]) {
			return rec;
		}
		if (!isOrchestrationBackedMission(rec)) {
			const rt = ctx.missionRuntime?.getRuntimeState(rec.id);
			if (rt?.tokens[tokenId]) {
				return rec;
			}
		}
	}
	return undefined;
}

export function findMissionByTracePtr(ctx: IAdeMissionControlContext, tracePtr: string): IAdeMissionRecord | undefined {
	for (const rec of ctx.missionService?.listMissions() ?? []) {
		if (rec.orchestrationRuntime?.traces?.[tracePtr]) {
			return rec;
		}
		if (!isOrchestrationBackedMission(rec)) {
			const rt = ctx.missionRuntime?.getRuntimeState(rec.id);
			if (rt?.traces?.[tracePtr]) {
				return rec;
			}
		}
	}
	return undefined;
}
