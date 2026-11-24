/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	projectOrchestrationTokenView,
	sanitizeOrgContextMessage,
} from '../../../../platform/ade/common/adeControlPolicy.js';
import {
	wrapRoleDirectMessageEnvelope,
	wrapUserDirectMessageEnvelope,
} from '../../../../platform/ade/common/adeMessageEnvelope.js';
import { resolveSupervisorJurisdiction } from '../../../../platform/ade/common/adeMissionBoundary.js';
import { parseMissionMermaidDag } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	canCallerAccessWhiteboard,
	resolveEffectiveStaffTier,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { parseOrchestrationGraph } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { ADE_SECRETARY_TIER_TAG, formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import { normalizeAdeEngineId, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { ADE_SECRETARY_ID } from '../common/ade.js';
import {
	assertSupervisorHasAuthorityOverTarget,
	IAdeMissionControlContext,
	isCompanyWideOrgSupervisor,
	isOrchestrationBackedMission,
	resolveMissionRecord,
	resolveOrgTargetAgent,
} from './adeMissionControlHelpers.js';

export const ADE_ORG_CONTROL_ACTIONS = new Set([
	'org.subordinates',
	'org.send',
	'org.context',
	'org.escalate',
]);

export async function executeAdeOrgControlAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): Promise<unknown> {
	const runtime = ctx.missionRuntime;
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}

	switch (action) {
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
								const highestTier = ctx.roleConfig.ranks.length > 0 ? Math.min(...ctx.roleConfig.ranks.map(r => r.tier)) : 1;
								const callerDept = callerNode?.department?.trim();
								const isExecDept = isCompanyWideOrgSupervisor(callerNode, callerTier, ctx.roleConfig);
								if (callerTier !== undefined && callerTier <= highestTier) {
									for (const nxt of staffNodes) {
										if (nxt.id === callerNodeId) { continue; }
										const nxtTier = resolveEffectiveStaffTier(nxt, ctx.roleConfig);
										if (nxtTier !== undefined && nxtTier <= callerTier) { continue; }
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
								} else {
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
											if (callerTier !== undefined && nxtTier !== undefined && nxtTier <= callerTier) {
												continue;
											}
											if (curTier !== undefined && nxtTier !== undefined && nxtTier < curTier) {
												continue;
											}
											if (!isExecDept && nxt.department && callerDept && nxt.department.trim().toLowerCase() !== callerDept.toLowerCase()) {
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
			const directive = ctx.isHumanUser
				? wrapUserDirectMessageEnvelope(message, 'org.send')
				: ctx.isSecretary
					? wrapRoleDirectMessageEnvelope({
						senderLabel: ctx.projects.secretary.label || 'Secretary',
						senderTierTag: ADE_SECRETARY_TIER_TAG,
						senderRankName: 'Secretary',
						senderSessionId: ADE_SECRETARY_ID,
						channel: 'org.send',
						message,
					})
					: wrapRoleDirectMessageEnvelope({
						senderLabel: ctx.callerAgent?.label ?? ctx.callerSessionId ?? callerRankDef!.name,
						senderTierTag: formatTierTag(callerRankDef!.tier),
						senderRankName: callerRankDef!.name,
						senderSessionId: ctx.callerAgent?.id ?? ctx.callerSessionId,
						channel: 'org.send',
						message,
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
				pureWorker: Boolean(targetRank.pureExecution && !targetIsInGraphNode),
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
				: 6;
			const historyRes = targetAgent.session && ctx.commandService && targetAgent.session.engineId.startsWith('aexus-')
				? await ctx.commandService.executeCommand<{ readonly messages?: ReadonlyArray<{ readonly role: string; readonly text: string }> }>(
					'aexus.agentEngines.history',
					targetAgent.session.resource,
					limit,
				).catch(() => undefined)
				: undefined;
			const full = params.full === true || params.verbose === true;
			const rawHistory = historyRes?.messages ?? [];
			const history = rawHistory.map(m => ({
				role: m.role,
				text: sanitizeOrgContextMessage(m.text, full, undefined, m.role),
			}));
			const explicitMissionStr = String(params.mission ?? params.missionId ?? '').trim();
			const targetMission = (explicitMissionStr
				? (ctx.missionService?.getMission(explicitMissionStr) ?? ctx.missionService?.getMissionByLinkedSession(explicitMissionStr))
				: undefined)
				?? (auth.viaMissionId ? ctx.missionService?.getMission(auth.viaMissionId) : undefined)
				?? (ctx.missionService?.listMissions() ?? []).find(m =>
					m.orchestrationText?.trim()
					&& Object.values(runtime.getOrchestrationState(m.id).nodeAgentIds).includes(targetAgent.id),
				);

			let orchContext: {
				readonly missionId: string;
				readonly nodeId: string;
				readonly department?: string;
				readonly tier?: number;
				readonly nodeState: string;
				readonly boundTaskIds: readonly string[];
				readonly recentTraces: readonly { readonly ptr: string; readonly event: string; readonly summary: string; readonly timestamp: number }[];
				readonly whiteboardIds: readonly string[];
			} | undefined;
			let isTargetOrchBacked = false;
			if (targetMission && isOrchestrationBackedMission(targetMission)) {
				const orchState = runtime.getOrchestrationState(targetMission.id);
				const nodeId = Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === targetAgent.id)?.[0];
				if (nodeId) {
					isTargetOrchBacked = true;
					const orchGraph = parseOrchestrationGraph(targetMission.orchestrationText ?? '');
					const staffNode = orchGraph.nodes.find(n => n.id === nodeId && n.kind === 'staff');
					const effectiveTier = resolveEffectiveStaffTier(staffNode, ctx.roleConfig);
					const liveOrchTokens = runtime.getCurrentOrchestrationTokens(targetAgent.id, targetMission.id);
					const boundTaskIds = [...new Set(liveOrchTokens.flatMap(t => [
						...(t.taskNodeId ? [t.taskNodeId] : []),
						...(t.taskNodeIds ?? []),
					]))];
					const recentTraces = Object.values(orchState.traces ?? {})
						.filter(tr => tr.nodeId === nodeId || tr.employeeId === targetAgent.id)
						.sort((a, b) => b.timestamp - a.timestamp)
						.slice(0, Math.min(limit, 5))
						.map(tr => ({ ptr: tr.ptr, event: tr.event, summary: tr.summary ?? '', timestamp: tr.timestamp }));
					const whiteboardIds = runtime.listOrchestrationWhiteboards(targetMission.id)
						.filter(wb => canCallerAccessWhiteboard(orchGraph, wb, ctx.roleConfig, {
							callerNodeId: nodeId,
							callerTier: effectiveTier,
							access: 'read',
							state: orchState,
						}))
						.map(wb => wb.id);
					orchContext = {
						missionId: targetMission.id,
						nodeId,
						...(staffNode?.department ? { department: staffNode.department } : {}),
						...(effectiveTier !== undefined ? { tier: effectiveTier } : {}),
						nodeState: orchState.nodeStates[nodeId] ?? 'idle',
						boundTaskIds,
						recentTraces,
						whiteboardIds,
					};
				}
			}

			const rawHeldTokens = isTargetOrchBacked && targetMission
				? runtime.getCurrentOrchestrationTokens(targetAgent.id, targetMission.id)
				: [
					...runtime.getCurrentOrchestrationTokens(targetAgent.id),
					...runtime.getCurrentTokens(targetAgent.id),
				];
			const heldTokens = full
				? rawHeldTokens
				: rawHeldTokens.map(t => (Object.hasOwn(t, 'hopLog') || Object.hasOwn(t, 'contextRefs') || Object.hasOwn(t, 'tracePtr'))
					? projectOrchestrationTokenView(t as import('../../../../platform/ade/common/adeOrchestrationEngine.js').IOrchestrationToken, { full: false })
					: t);

			return {
				agentId: targetAgent.id,
				label: targetAgent.label,
				role: targetAgent.role,
				host: targetAgent.projectUri.scheme === 'aexus-ssh' ? targetAgent.projectUri.authority : 'local',
				projectUri: targetAgent.projectUri.toString(),
				status: targetAgent.session ? (targetAgent.status ?? 'idle') : 'draft',
				...(orchContext ? {
					missionId: orchContext.missionId,
					nodeId: orchContext.nodeId,
					...(orchContext.department ? { department: orchContext.department } : {}),
					...(orchContext.tier !== undefined ? { tier: orchContext.tier } : {}),
					nodeState: orchContext.nodeState,
					boundTaskIds: orchContext.boundTaskIds,
					recentTraces: orchContext.recentTraces,
					whiteboardIds: orchContext.whiteboardIds,
				} : {}),
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
				const isOrchBoundStaff = Boolean(
					ctx.callerSessionId
					&& mission.orchestrationText?.trim()
					&& Object.values(runtime.getOrchestrationState(mission.id).nodeAgentIds).includes(ctx.callerSessionId),
				);
				const isBoundSupervisorOrOwner = Boolean(
					ctx.callerSessionId
					&& (ctx.callerSessionId === mission.ownerSessionId || rt.boundary.supervisors.some(s => s.id === ctx.callerSessionId) || isOrchBoundStaff),
				);
				if (!isBoundSupervisorOrOwner) {
					throw new Error(`FORBIDDEN: only a bound supervisor, Orchestration staff member, Mission owner, Secretary, or Human may invoke org.escalate on Mission "${mission.id}".`);
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

		default:
			throw new Error(`Unsupported org control action: ${action}`);
	}
}
