/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IMissionNodeAssignment,
	IMissionSupervisorBinding,
	resolveSupervisorJurisdiction,
} from '../../../../platform/ade/common/adeMissionBoundary.js';
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionEngineCaller, IMissionSourceTrigger, parseDurationMs } from '../../../../platform/ade/common/adeMissionEngine.js';
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

const MISSION_RUNTIME_ACTIONS = new Set([
	// In-graph Token Bus
	'token.current',
	'token.trace',
	'token.complete',
	'token.reject',
	'token.block',
	'token.fail',
	// Off-graph strictly top-down Org APIs
	'org.subordinates',
	'org.send',
	'org.context',
	'org.escalate',
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
	'mission.patch',
	'mission.gate',
	'mission.trigger.list',
	'mission.trigger.set',
	'mission.trigger.remove',
	'mission.host.bind',
	// Also accept engineering.* mapped equivalents
	'engineering.start',
	'engineering.run',
	'engineering.pause',
	'engineering.resume',
	'engineering.stop',
	'engineering.status',
	'engineering.timeout.set',
	'engineering.boundary.get',
	'engineering.boundary.set',
	'engineering.recall',
	'engineering.patch',
	'engineering.gate',
	'engineering.trigger.list',
	'engineering.trigger.set',
	'engineering.trigger.remove',
	'engineering.host.bind',
]);

export function isAdeMissionRuntimeAction(action: string): boolean {
	return MISSION_RUNTIME_ACTIONS.has(action);
}

function normalizeAction(action: string): string {
	return action.startsWith('engineering.') ? `mission.${action.slice('engineering.'.length)}` : action;
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
	const rawId = String(params.mission ?? params.missionId ?? params.id ?? params.governor ?? params.governorSessionId ?? '').trim();
	if (rawId) {
		const hit = missions.getMission(rawId) ?? missions.getMissionByLinkedSession(rawId);
		if (hit) {
			return hit;
		}
		throw new Error(`Mission not found: ${rawId}`);
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
	if (ctx.callerAgent?.treeNodeId && (ctx.callerAgent.treeGovernorId === mission.id || ctx.callerAgent.treeGovernorId === mission.ownerSessionId)) {
		return;
	}
	throw new Error(`FORBIDDEN: session "${ctx.callerSessionId}" is not a member or supervisor of Mission "${mission.id}".`);
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
	// Fallback: resolve DAG node ID across caller's associated mission(s)
	if (ctx.callerSessionId && ctx.missionRuntime) {
		for (const rec of findAssociatedMissionsForSession(ctx.callerSessionId, ctx)) {
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

	// 2. Mission free jump-node off-graph jurisdiction check
	const missions = ctx.missionService?.listMissions() ?? [];
	for (const rec of missions) {
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

function findMissionByTokenId(ctx: IAdeMissionControlContext, tokenId: string): IAdeMissionRecord | undefined {
	for (const rec of ctx.missionService?.listMissions() ?? []) {
		const rt = ctx.missionRuntime?.getRuntimeState(rec.id);
		if (rt?.tokens[tokenId]) {
			return rec;
		}
	}
	return undefined;
}

export async function executeAdeMissionRuntimeAction(
	rawAction: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): Promise<unknown> {
	const runtime = ctx.missionRuntime;
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}
	const action = normalizeAction(rawAction);

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
				assertInGraphTokenCaller(ctx, mission);
				const tokens = runtime.getCurrentTokens(ctx.callerSessionId!, mission.id);
				return { missionId: mission.id, agentId: ctx.callerSessionId, tokens };
			}

			if (explicitAgentId) {
				const tokens = runtime.getCurrentTokens(explicitAgentId, explicitMissionId);
				return { missionId: explicitMissionId, agentId: explicitAgentId, tokens };
			}
			const mission = resolveMissionRecord(params, ctx);
			const state = runtime.getRuntimeState(mission.id);
			const tokens = Object.values(state.tokens).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed');
			return { missionId: mission.id, tokens };
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
			if (!tokenId) {
				throw new Error('Token ID is required for token.complete.');
			}
			if (!summary) {
				throw new Error('A plain-text factual --summary is required for token.complete.');
			}
			const mission = (params.mission || params.missionId)
				? resolveMissionRecord(params, ctx)
				: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
			const callerAgentId = assertInGraphTokenCaller(ctx, mission, tokenId);
			const res = await runtime.completeToken(mission.id, { tokenId, summary, callerAgentId });
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
				if (jur.hasFullJurisdiction || jur.nodeIds.size > 0 || jur.supervisorIds.size > 0) {
					missionJurisdictions.push({
						missionId: rec.id,
						missionTitle: rec.title,
						managedNodeIds: Array.from(jur.nodeIds),
						subordinateSupervisorIds: Array.from(jur.supervisorIds),
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
				const engId = targetAgent.preferredEngineId || engines[0]?.id;
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

			const senderTag = ctx.isHumanUser
				? 'User (L-1)'
				: ctx.isSecretary
					? 'Secretary (L0)'
					: `${ctx.callerAgent?.label ?? ctx.callerSessionId} (L${resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent?.role, true).tier})`;
			const directive = `[Directive from Superior: ${senderTag}]\n${message}`;
			const targetRank = resolveEffectiveRankDefinition(ctx.roleConfig, targetAgent.role, ctx.projects.hasSubordinates(targetAgent.id));

			const dispatchPromise = ctx.commandService.executeCommand('aexus.agentEngines.dispatchEngineeringTurn', resource, directive, {
				agentId: targetAgent.id,
				model: targetAgent.preferredModel,
				thinking: targetAgent.preferredThinking,
				pureWorker: false,
				isMissionNode: Boolean(targetAgent.treeNodeId),
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
			const heldTokens = runtime.getCurrentTokens(targetAgent.id);

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
				const isBoundSupervisorOrOwner = Boolean(
					ctx.callerSessionId
					&& (ctx.callerSessionId === mission.ownerSessionId || rt.boundary.supervisors.some(s => s.id === ctx.callerSessionId)),
				);
				if (!isBoundSupervisorOrOwner) {
					throw new Error(`FORBIDDEN: only a bound off-graph supervisor, Mission owner, Secretary, or Human may invoke org.escalate on Mission "${mission.id}".`);
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

		case 'mission.patch': {
			const mission = resolveMissionRecord(params, ctx);
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
			const jur = resolveSupervisorJurisdiction(
				rt.boundary,
				caller.sessionId ?? '',
				graph.nodes.map(n => n.id),
				{ isHumanUser: caller.isHumanUser, isSecretary: caller.isSecretary, ownerSessionId: mission.ownerSessionId },
			);
			if (!jur.hasFullJurisdiction && !jur.nodeIds.has(nodeId)) {
				throw new Error(`OUT_OF_JURISDICTION: caller lacks off-graph jurisdiction to bind host for node "${nodeId}" in Mission "${mission.id}".`);
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

		default:
			throw new Error(`Unsupported Mission runtime action: ${rawAction}`);
	}
}
