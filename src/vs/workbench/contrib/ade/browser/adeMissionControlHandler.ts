/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	buildUnifiedOrchestrationStatusResponse,
	canCallerInspectOrchestrationTokenHistory,
	canCallerInspectOrchestrationTrace,
	parseJoinBarrierOptions,
	parseOrchestrationLimitsRequest,
	parseStrictPositiveInt,
	parseWhiteboardSliceParams,
	projectJoinBarrierSummary,
	projectOrchestrationTokenView,
	stripForeignWhiteboardBodiesFromOrchestrationText,
} from '../../../../platform/ade/common/adeControlPolicy.js';
import {
	OrchestrationReworkCategory,
	OrchestrationScopeConflictPolicy,
} from '../../../../platform/ade/common/adeOrchestrationTypes.js';
import {
	IMissionNodeAssignment,
	IMissionSupervisorBinding,
	resolveSupervisorJurisdiction,
} from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	IMissionNodeCheckHook,
	MissionCheckOnFailAction,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionSourceTrigger, parseDurationMs } from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	compileOrchestrationManifest,
	exportToOrchestrationManifest,
	validateOrchestrationManifest,
} from '../../../../platform/ade/common/adeOrchestrationConfig.js';
import {
	IOrchestrationContextBlobInput,
	IOrchestrationMintBranch,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	addOrchestrationGroup,
	moveOrchestrationNodeToGroup,
	OrchestrationLayoutMode,
	parseOrchestrationGraph,
	removeOrchestrationGroup,
	renameOrchestrationGroup,
	renameOrchestrationNode,
	serializeOrchestrationGraph,
	setOrchestrationLayoutInCode,
	upsertOrchestrationWhiteboardInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import {
	assertFullMissionControlAuthority,
	assertInGraphTokenCaller,
	assertMissionMemberOrSupervisor,
	assertNotOrchestrationLegacyAction,
	assertOrchestrationTokenCaller,
	assertStaffConfigureAuthority,
	assertSupervisorHasAuthorityOverTarget,
	buildEngineCaller,
	findMissionByTokenId,
	findMissionByTracePtr,
	IAdeMissionControlContext,
	isOrchestrationBackedMission,
	resolveMissionRecord,
} from './adeMissionControlHelpers.js';
import { ADE_MISSION_TASK_CONTROL_ACTIONS, executeAdeMissionTaskControlAction } from './adeMissionTaskControlActions.js';
import { ADE_ORG_CONTROL_ACTIONS, executeAdeOrgControlAction } from './adeOrgControlActions.js';
import { ADE_WHITEBOARD_CONTROL_ACTIONS, executeAdeWhiteboardControlAction } from './adeWhiteboardControlActions.js';

export { assertSupervisorHasAuthorityOverTarget };
export type { IAdeMissionControlContext };

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
	...ADE_ORG_CONTROL_ACTIONS,
	// Engineering Mission Task DAG
	...ADE_MISSION_TASK_CONTROL_ACTIONS,
	// Engineering Orchestration (All-Staff Cyclic Graph + Lossless Groups/Layout/Migration)
	'orchestration.get',
	'orchestration.apply',
	'orchestration.validate',
	'orchestration.load',
	'orchestration.export',
	'orchestration.import',
	'orchestration.layout.set',
	'orchestration.status',
	'orchestration.limits',
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
	// Department Shared Whiteboards
	...ADE_WHITEBOARD_CONTROL_ACTIONS,
	// Mission Runtime Lifecycle, Boundary, Recall, Patch, Gate, Triggers, Host Binding
	'mission.start',
	'mission.run',
	'mission.pause',
	'mission.resume',
	'mission.stop',
	'mission.status',
	'mission.timeout.set',
	'mission.budget.set',
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

export async function executeAdeMissionRuntimeAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeMissionControlContext,
): Promise<unknown> {
	const runtime = ctx.missionRuntime;
	if (!runtime) {
		throw new Error('ADE Mission runtime service is not available.');
	}
	if (ADE_ORG_CONTROL_ACTIONS.has(action)) {
		return executeAdeOrgControlAction(action, params, ctx);
	}
	if (ADE_MISSION_TASK_CONTROL_ACTIONS.has(action)) {
		return executeAdeMissionTaskControlAction(action, params, ctx);
	}
	if (ADE_WHITEBOARD_CONTROL_ACTIONS.has(action)) {
		return executeAdeWhiteboardControlAction(action, params, ctx);
	}

	switch (action) {
					case 'token.current': {
						const full = params.full === true || params.verbose === true;
						const explicitMissionId = typeof (params.mission ?? params.missionId) === 'string'
							? String(params.mission ?? params.missionId).trim()
							: undefined;
						const explicitAgentId = (ctx.isHumanUser || ctx.isSecretary) && typeof (params.agent ?? params.agentId) === 'string'
							? String(params.agent ?? params.agentId).trim()
							: undefined;

						if (!ctx.isHumanUser && !ctx.isSecretary) {
							const mission = resolveMissionRecord(params, ctx);
							const orchState = runtime.getOrchestrationState(mission.id);
							const orchTokens = runtime.getCurrentOrchestrationTokens(ctx.callerSessionId!, mission.id).map(t => projectOrchestrationTokenView(t, {
								full,
								delta: runtime.getOrchestrationTokenDelta(mission.id, t.id),
								...(t.joinBarrierId && orchState.joinBarriers?.[t.joinBarrierId]
									? { joinBarrier: projectJoinBarrierSummary(orchState.joinBarriers[t.joinBarrierId], full) }
									: {}),
							}));
							if (orchTokens.length > 0 || isOrchestrationBackedMission(mission)) {
								return { missionId: mission.id, agentId: ctx.callerSessionId, tokens: orchTokens };
							}
							assertInGraphTokenCaller(ctx, mission);
							const tokens = runtime.getCurrentTokens(ctx.callerSessionId!, mission.id);
							return { missionId: mission.id, agentId: ctx.callerSessionId, tokens };
						}

						if (explicitAgentId) {
							const explicitMission = explicitMissionId ? (ctx.missionService?.getMission(explicitMissionId) ?? ctx.missionService?.getMissionByLinkedSession(explicitMissionId)) : undefined;
							const orchTokens = runtime.getCurrentOrchestrationTokens(explicitAgentId, explicitMissionId).map(t => projectOrchestrationTokenView(t, { full }));
							if (explicitMission && isOrchestrationBackedMission(explicitMission)) {
								return { missionId: explicitMissionId, agentId: explicitAgentId, tokens: orchTokens };
							}
							const tokens = runtime.getCurrentTokens(explicitAgentId, explicitMissionId);
							return { missionId: explicitMissionId, agentId: explicitAgentId, tokens: [...orchTokens, ...tokens] };
						}
						const mission = resolveMissionRecord(params, ctx);
						const orch = runtime.getOrchestrationState(mission.id);
						const orchTokens = Object.values(orch.tokens)
							.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join')
							.map(t => projectOrchestrationTokenView(t, {
								full,
								...(t.joinBarrierId && orch.joinBarriers?.[t.joinBarrierId]
									? { joinBarrier: projectJoinBarrierSummary(orch.joinBarriers[t.joinBarrierId], full) }
									: {}),
							}));
						if (isOrchestrationBackedMission(mission)) {
							return { missionId: mission.id, tokens: orchTokens };
						}
						const state = runtime.getRuntimeState(mission.id);
						const tokens = Object.values(state.tokens).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed');
						return { missionId: mission.id, tokens: [...orchTokens, ...tokens] };
					}

					case 'token.handoff': {
						const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
						const summary = String(params.summary ?? params.message ?? params.evidence ?? params.evidenceSummary ?? '').trim();
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
						const taskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
							? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
							: undefined;
						const rawTaskIds = params.taskNodeIds ?? params.taskIds ?? params.tasks;
						const taskNodeIds = Array.isArray(rawTaskIds)
							? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
						const mission = (params.mission || params.missionId)
							? resolveMissionRecord(params, ctx)
							: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
						const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
						const rawModifiedFiles = params.touchedFiles ?? params.modifiedFiles ?? params.files;
						const modifiedFiles = Array.isArray(rawModifiedFiles)
							? rawModifiedFiles.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawModifiedFiles === 'string' ? rawModifiedFiles.split(/[|,;]/).map(s => s.trim()).filter(Boolean) : undefined);
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
								const list = raw.split(/[|,;]/).map(s => s.trim()).filter(Boolean);
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
									...(typeof (b.taskNodeId ?? b.taskId ?? b.task) === 'string' && String(b.taskNodeId ?? b.taskId ?? b.task).trim()
										? { taskNodeId: String(b.taskNodeId ?? b.taskId ?? b.task).trim() }
										: {}),
									...(parseStrList(b.taskNodeIds ?? b.taskIds ?? b.tasks) ? { taskNodeIds: parseStrList(b.taskNodeIds ?? b.taskIds ?? b.tasks) } : {}),
									...(parseStrList(b.scopePaths ?? b.scope) ? { scopePaths: parseStrList(b.scopePaths ?? b.scope) } : {}),
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
							const taskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
								? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
								: undefined;
							const taskNodeIds = parseStrList(params.taskNodeIds ?? params.taskIds ?? params.tasks);
							const scopePaths = parseStrList(params.scopePaths ?? params.scope);
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
									...(scopePaths ? { scopePaths } : {}),
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
						const parsedBarrier = parseJoinBarrierOptions(params);
						if (!parsedBarrier.ok) {
							throw new Error(parsedBarrier.error);
						}
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
							joinMode: parsedBarrier.joinMode,
							...(parsedBarrier.quorumCount !== undefined ? { quorumCount: parsedBarrier.quorumCount } : {}),
							...(parsedBarrier.failFast ? { failFast: true } : {}),
							...(parsedBarrier.deadlineAt !== undefined ? { deadlineAt: parsedBarrier.deadlineAt } : {}),
							...(parsedBarrier.conflictPolicy ? { conflictPolicy: parsedBarrier.conflictPolicy as OrchestrationScopeConflictPolicy } : {}),
							isHumanUser: ctx.isHumanUser,
							isSecretary: ctx.isSecretary,
							callerAgentId,
						});
						if (!res.ok) {
							throw new Error(res.error ?? `Failed to mint sub-task token(s)${parentTokenId ? ` from ${parentTokenId}` : ''}`);
						}
						const mintData = (res.data as Record<string, unknown> | undefined) ?? {};
						const armedBarrierId = typeof mintData.joinBarrierId === 'string' && mintData.joinBarrierId ? mintData.joinBarrierId : undefined;
						return {
							ok: true,
							missionId: mission.id,
							...mintData,
							...(armedBarrierId
								? {
									nextAction: `STOP_TURN_NOW: Join barrier ${armedBarrierId} is armed. End your turn immediately without polling, sleeping, or spawning background shell watchers — Aexus will automatically wake you in a fresh turn once all child tokens return.`,
								}
								: {}),
						};
					}

					case 'token.return': {
						const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
						const summary = String(params.summary ?? params.message ?? params.evidence ?? params.evidenceSummary ?? '').trim();
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
						const rawModifiedFiles = params.touchedFiles ?? params.modifiedFiles ?? params.files;
						const modifiedFiles = Array.isArray(rawModifiedFiles)
							? rawModifiedFiles.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawModifiedFiles === 'string' ? rawModifiedFiles.split(/[|,;]/).map(s => s.trim()).filter(Boolean) : undefined);
						const taskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
							? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
							: undefined;
						const rawTaskIds = params.taskNodeIds ?? params.taskIds ?? params.tasks;
						const taskNodeIds = Array.isArray(rawTaskIds)
							? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
						const callerTier = ctx.callerAgent
							? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
							: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
						const res = await runtime.returnOrchestrationToken(mission.id, {
							tokenId,
							...(toNodeId ? { toNodeId } : {}),
							summary,
							...(detail ? { detail } : {}),
							...(taskNodeId ? { taskNodeId } : {}),
							...(taskNodeIds && taskNodeIds.length > 0 ? { taskNodeIds } : {}),
							whiteboardIds,
							...(parseBlobInputs(params.artifacts) ? { artifacts: parseBlobInputs(params.artifacts) } : {}),
							...(parseBlobInputs(params.decisions) ? { decisions: parseBlobInputs(params.decisions) } : {}),
							...(refPtrs ? { refPtrs } : {}),
							...(modifiedFiles && modifiedFiles.length > 0 ? { modifiedFiles } : {}),
							callerAgentId,
							...(skipChecks ? { skipChecks: true } : {}),
							...(params.completeTask === true ? { completeTask: true } : {}),
							...(params.force === true ? { force: true } : {}),
							isHumanUser: ctx.isHumanUser,
							isSecretary: ctx.isSecretary,
							callerTier,
							callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
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
						const slice = parseWhiteboardSliceParams(params);
						const res = runtime.readOrchestrationTokenPointersAsync
							? await runtime.readOrchestrationTokenPointersAsync(mission.id, {
								ptrs,
								tokenId,
								...(slice.hasSliceParams ? { slice } : {}),
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
								...(slice.hasSliceParams ? { slice } : {}),
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
						const includeAll = Boolean(params.all === true || params.includeAll === true || params.deltaOnly === false);
						const history = runtime.getOrchestrationTokenHistoryAsync
							? await runtime.getOrchestrationTokenHistoryAsync(mission.id, tokenId, { includeAll })
							: runtime.getOrchestrationTokenHistory(mission.id, tokenId, { includeAll });
						if (!history.ok) {
							throw new Error(history.error ?? `Orchestration token "${tokenId}" not found.`);
						}
						const orchForHistory = runtime.getOrchestrationState(mission.id);
						const parsedOrchForHistory = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
						const callerTier = ctx.callerAgent
							? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
							: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
						const lineageToken = orchForHistory.tokens[tokenId] ?? {
							id: history.tokenId,
							nodeId: history.nodeId,
							hopLog: history.hopLog,
						};
						if (!canCallerInspectOrchestrationTokenHistory(orchForHistory, parsedOrchForHistory, ctx.roleConfig, lineageToken, {
							isHumanUser: ctx.isHumanUser,
							isSecretary: ctx.isSecretary,
							isMissionOwner: Boolean(mission.ownerSessionId && ctx.callerSessionId === mission.ownerSessionId),
							callerTier,
							callerSessionId: ctx.callerSessionId,
						})) {
							throw new Error(`FORBIDDEN: caller "${ctx.callerSessionId ?? 'unknown'}" does not have lineage access to token "${tokenId}".`);
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
						const mission = (params.mission || params.missionId)
							? resolveMissionRecord(params, ctx)
							: (findMissionByTracePtr(ctx, tracePtr) ?? resolveMissionRecord(params, ctx));
						assertMissionMemberOrSupervisor(ctx, mission);
						const orchForTrace = mission.orchestrationRuntime;
						if (orchForTrace?.traces?.[tracePtr]) {
							const parsedOrchForTrace = mission.orchestrationText?.trim() ? parseOrchestrationGraph(mission.orchestrationText) : undefined;
							const callerTier = ctx.callerAgent
								? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
								: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
							if (!canCallerInspectOrchestrationTrace(orchForTrace, parsedOrchForTrace, ctx.roleConfig, tracePtr, {
								isHumanUser: ctx.isHumanUser,
								isSecretary: ctx.isSecretary,
								isMissionOwner: Boolean(mission.ownerSessionId && ctx.callerSessionId === mission.ownerSessionId),
								callerTier,
								callerSessionId: ctx.callerSessionId,
							})) {
								throw new Error(`FORBIDDEN: caller "${ctx.callerSessionId ?? 'unknown'}" does not have lineage access to trace "${tracePtr}".`);
							}
						}
						const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;
						const trace = runtime.expandTrace(mission.id, tracePtr, limit);
						return { missionId: mission.id, tracePtr, count: trace.length, entries: trace };
					}

					case 'token.complete': {
						const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
						const summary = String(params.summary ?? params.message ?? params.evidence ?? params.evidenceSummary ?? '').trim();
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
							const taskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
								? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
								: undefined;
							const rawTaskIds = params.taskNodeIds ?? params.taskIds ?? params.tasks;
							const taskNodeIds = Array.isArray(rawTaskIds)
								? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
								: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
							const rawModifiedFiles = params.touchedFiles ?? params.modifiedFiles ?? params.files;
							const modifiedFiles = Array.isArray(rawModifiedFiles)
								? rawModifiedFiles.map(v => String(v).trim()).filter(Boolean)
								: (typeof rawModifiedFiles === 'string' ? rawModifiedFiles.split(/[|,;]/).map(s => s.trim()).filter(Boolean) : undefined);
							const callerTier = ctx.callerAgent
								? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
								: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
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
								...(params.completeTask === true ? { completeTask: true } : {}),
								...(params.force === true ? { force: true } : {}),
								isHumanUser: ctx.isHumanUser,
								isSecretary: ctx.isSecretary,
								callerTier,
								callerLabel: ctx.callerAgent?.label ?? (ctx.isHumanUser ? 'User' : ctx.isSecretary ? 'Secretary' : undefined),
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
						const reason = String(params.reason ?? params.feedback ?? params.message ?? params.summary ?? '').trim();
						const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
						const rawTarget = params.targetNodeIds ?? params.targets ?? params.target ?? params.targetNode ?? params.targetNodeId ?? params.to;
						const targetNodeIds = Array.isArray(rawTarget)
							? rawTarget.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.split(',').map(s => s.trim()).filter(Boolean) : undefined);
						const targetNodeId = targetNodeIds?.[0];
						if (!tokenId) {
							throw new Error('Token ID is required for token.reject.');
						}
						if (!reason) {
							throw new Error('Rejection --reason is required for token.reject.');
						}
						const mission = (params.mission || params.missionId)
							? resolveMissionRecord(params, ctx)
							: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
						if (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-') || isOrchestrationBackedMission(mission)) {
							const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
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
							const waitJoin = params.waitJoin !== undefined
								? params.waitJoin === true
								: (params.noWaitJoin === true ? false : undefined);
							const rawRejectCat = typeof (params.category ?? params.reworkCategory) === 'string'
								? String(params.category ?? params.reworkCategory).trim().toLowerCase()
								: undefined;
							const validReworkCategories = new Set(['defect', 'spec', 'test', 'env', 'scope', 'security', 'other']);
							if (rawRejectCat && !validReworkCategories.has(rawRejectCat)) {
								throw new Error(`Invalid rework --category "${rawRejectCat}". Valid values: defect, spec, test, env, scope, security, other.`);
							}
							const rejectCategory = rawRejectCat
								? (rawRejectCat as OrchestrationReworkCategory)
								: undefined;
							const res = await runtime.rejectOrchestrationToken(mission.id, {
								tokenId,
								reason,
								...(detail ? { detail } : {}),
								...(rejectCategory ? { category: rejectCategory } : {}),
								...(targetNodeId ? { targetNodeId } : {}),
								...(targetNodeIds && targetNodeIds.length > 0 ? { targetNodeIds } : {}),
								...(whiteboardIds ? { whiteboardIds } : {}),
								...(parseBlobInputs(params.artifacts) ? { artifacts: parseBlobInputs(params.artifacts) } : {}),
								...(parseBlobInputs(params.decisions) ? { decisions: parseBlobInputs(params.decisions) } : {}),
								...(refPtrs ? { refPtrs } : {}),
								...(waitJoin !== undefined ? { waitJoin } : {}),
								callerAgentId,
							});
							if (!res.ok) {
								throw new Error(res.error ?? `Failed to reject Orchestration token ${tokenId}`);
							}
							return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
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
						const watchPid = parseStrictPositiveInt(rawPid);
						if (rawPid !== undefined && rawPid !== null && String(rawPid).trim() !== '' && watchPid === undefined) {
							throw new Error(`Invalid --watch-pid "${String(rawPid)}": expected a positive integer PID.`);
						}
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
						const detail = typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined;
						if (!tokenId) {
							throw new Error('Token ID is required for token.fail.');
						}
						if (!reason) {
							throw new Error('Failure --reason is required for token.fail.');
						}
						const mission = (params.mission || params.missionId)
							? resolveMissionRecord(params, ctx)
							: (findMissionByTokenId(ctx, tokenId) ?? resolveMissionRecord(params, ctx));
						if (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-') || isOrchestrationBackedMission(mission)) {
							const callerAgentId = assertOrchestrationTokenCaller(ctx, mission, tokenId);
							const rawFailCat = typeof (params.category ?? params.reworkCategory) === 'string'
								? String(params.category ?? params.reworkCategory).trim().toLowerCase()
								: undefined;
							const validReworkCategories = new Set(['defect', 'spec', 'test', 'env', 'scope', 'security', 'other']);
							if (rawFailCat && !validReworkCategories.has(rawFailCat)) {
								throw new Error(`Invalid rework --category "${rawFailCat}". Valid values: defect, spec, test, env, scope, security, other.`);
							}
							const failCategory = rawFailCat
								? (rawFailCat as OrchestrationReworkCategory)
								: undefined;
							const res = await runtime.failOrchestrationToken(mission.id, {
								tokenId,
								reason,
								...(detail ? { detail } : {}),
								...(failCategory ? { category: failCategory } : {}),
								callerAgentId,
							});
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

					case 'mission.budget.set':
					case 'orchestration.limits': {
						const mission = resolveMissionRecord(params, ctx);
						const parsedLimits = parseOrchestrationLimitsRequest(params, { isHumanUser: ctx.isHumanUser });
						if (!parsedLimits.ok) {
							throw new Error(parsedLimits.error ?? 'Invalid orchestration limits parameters.');
						}
						if (parsedLimits.isReadOnlyQuery) {
							assertMissionMemberOrSupervisor(ctx, mission);
							const orch = runtime.getOrchestrationState(mission.id);
							return {
								ok: true,
								missionId: mission.id,
								maxHops: orch.maxHops,
								budgetLimitUsd: orch.budgetLimitUsd,
								totalCostUsd: orch.totalCostUsd,
								budgetCircuitTripped: orch.budgetCircuitTripped,
								silenceReminderMinutes: orch.silenceReminderMinutes,
								status: orch.status,
							};
						}
						assertFullMissionControlAuthority(ctx, mission, 'configure limits/budget for');
						const res = await runtime.setOrchestrationLimits(mission.id, {
							...(parsedLimits.clearMaxHops ? { maxHops: null } : parsedLimits.maxHops !== undefined ? { maxHops: parsedLimits.maxHops } : {}),
							...(parsedLimits.clearBudgetLimit ? { budgetLimitUsd: null } : parsedLimits.budgetLimitUsd !== undefined ? { budgetLimitUsd: parsedLimits.budgetLimitUsd } : {}),
							...(parsedLimits.totalCostUsd !== undefined ? { totalCostUsd: parsedLimits.totalCostUsd } : {}),
							...(parsedLimits.silenceReminderMinutes !== undefined ? { silenceReminderMinutes: parsedLimits.silenceReminderMinutes } : {}),
						});
						return { missionId: mission.id, ...res };
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
							throw new Error(`Either --token <tokenId> or --node <nodeId> is required for ${action}.`);
						}
						const mission = (params.mission || params.missionId)
							? resolveMissionRecord(params, ctx)
							: ((tokenId ? findMissionByTokenId(ctx, tokenId) : undefined) ?? resolveMissionRecord(params, ctx));
						const guidance = typeof (params.guidance ?? params.reason ?? params.message ?? params.note) === 'string'
							? String(params.guidance ?? params.reason ?? params.message ?? params.note).trim()
							: undefined;
						if (action === 'token.retry' && (isOrchestrationBackedMission(mission) || Boolean(tokenId && (mission.orchestrationRuntime?.tokens[tokenId] || tokenId.startsWith('otok-'))))) {
							assertMissionMemberOrSupervisor(ctx, mission);
							const orchState = runtime.getOrchestrationState(mission.id);
							const callerNodeId = ctx.callerSessionId
								? Object.entries(orchState.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0]
								: undefined;
							const callerTier = ctx.callerAgent
								? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
								: undefined;
							const waitJoin = params.waitJoin !== undefined
								? params.waitJoin === true
								: (params.noWaitJoin === true ? false : undefined);
							const res = await runtime.retryOrchestrationToken(mission.id, {
								...(tokenId ? { tokenId } : {}),
								...(nodeId ? { nodeId } : {}),
								...(guidance ? { guidance } : {}),
								...(waitJoin !== undefined ? { waitJoin } : {}),
								caller: {
									isHumanUser: ctx.isHumanUser,
									isSecretary: ctx.isSecretary,
									...(callerTier !== undefined ? { callerTier } : {}),
									...(callerNodeId ? { callerNodeId } : {}),
									...(ctx.callerSessionId ? { callerAgentId: ctx.callerSessionId } : {}),
								},
							});
							if (!res.ok) {
								throw new Error(res.error ?? 'Orchestration token retry rejected.');
							}
							return { ok: true, missionId: mission.id, ...(res.data as Record<string, unknown> ?? {}) };
						}
						assertNotOrchestrationLegacyAction(mission, action, '"aexus-ade token retry <otok-id>" or "aexus-ade token mint"');
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
						assertMissionMemberOrSupervisor(ctx, mission);
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
						assertMissionMemberOrSupervisor(ctx, mission);
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
						assertMissionMemberOrSupervisor(ctx, mission);
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
						assertMissionMemberOrSupervisor(ctx, mission);
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
						assertMissionMemberOrSupervisor(ctx, mission);
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
						const isTaskDagNode = graph.nodes.some(n => n.id === nodeId);
						if (isTaskDagNode && !rawCheckId && suite.results.length > 0) {
							const orchStateForReceipt = mission.orchestrationText?.trim() ? runtime.getOrchestrationState(mission.id) : undefined;
							const callerOrchNodeId = ctx.callerSessionId && orchStateForReceipt?.nodeAgentIds
								? Object.entries(orchStateForReceipt.nodeAgentIds).find(([, aid]) => aid === ctx.callerSessionId)?.[0]
								: undefined;
							runtime.recordTaskCheckReceipt?.(mission.id, nodeId, {
								passed: suite.passed,
								summary: suite.summary,
								checkedAt: Date.now(),
								checkCount: suite.results.length,
								...(callerOrchNodeId ? { byNodeId: callerOrchNodeId } : {}),
							});
						}
						return { ok: true, missionId: mission.id, ...suite };
					}

					case 'orchestration.get': {
						const mission = resolveMissionRecord(params, ctx);
						assertMissionMemberOrSupervisor(ctx, mission);
						const callerTier = ctx.callerAgent
							? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
							: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
						const visibleWhiteboards = runtime.listOrchestrationWhiteboards(mission.id, {
							isHumanUser: ctx.isHumanUser,
							isSecretary: ctx.isSecretary,
							callerTier,
							callerAgentId: ctx.callerSessionId,
						});
						const allowedWbIds = new Set(visibleWhiteboards.map(wb => wb.id));
						const rawText = mission.orchestrationText ?? '';
						const safeText = (ctx.isHumanUser || ctx.isSecretary)
							? rawText
							: stripForeignWhiteboardBodiesFromOrchestrationText(rawText, allowedWbIds);
						if (params.raw === true) {
							return safeText;
						}
						const parsed = parseOrchestrationGraph(safeText);
						const orchState = runtime.getOrchestrationState(mission.id);
						return {
							missionId: mission.id,
							title: mission.title,
							layoutMode: mission.orchestrationLayoutMode ?? parsed.layoutMode,
							orchestrationText: safeText,
							parsed,
							nodeAgentIds: orchState.nodeAgentIds,
							nodeStates: orchState.nodeStates,
							whiteboards: visibleWhiteboards,
						};
					}

					case 'orchestration.export': {
						const mission = resolveMissionRecord(params, ctx);
						assertMissionMemberOrSupervisor(ctx, mission);
						const withPositions = params.withPositions === true;
						const includeAgentIds = params.includeAgentIds === true;
						const callerTier = ctx.callerAgent
							? resolveEffectiveRankDefinition(ctx.roleConfig, ctx.callerAgent.role, ctx.projects.hasSubordinates(ctx.callerAgent.id)).tier
							: (ctx.isSecretary ? 0 : ctx.isHumanUser ? -1 : undefined);
						const wbList = runtime.listOrchestrationWhiteboards(mission.id, {
							isHumanUser: ctx.isHumanUser,
							isSecretary: ctx.isSecretary,
							callerTier,
							callerAgentId: ctx.callerSessionId,
						});
						const allowedWbIds = new Set(wbList.map(wb => wb.id));
						const safeOrchSource = (ctx.isHumanUser || ctx.isSecretary)
							? (mission.orchestrationText ?? '')
							: stripForeignWhiteboardBodiesFromOrchestrationText(mission.orchestrationText ?? '', allowedWbIds);
						const parsed = parseOrchestrationGraph(safeOrchSource);
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
						const wbMap: Record<string, IOrchestrationWhiteboard> = {};
						for (const wb of wbList) {
							wbMap[wb.id] = wb;
						}
						const exportFormat = String(params.format ?? 'mermaid').trim().toLowerCase();
						if (exportFormat === 'json' || exportFormat === 'manifest') {
							const manifest = exportToOrchestrationManifest({
								name: mission.title,
								orchestrationText: safeOrchSource,
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
							...(!(ctx.isHumanUser || ctx.isSecretary) ? { allowedWhiteboardIds: allowedWbIds } : {}),
						});
						const safeSerialized = (ctx.isHumanUser || ctx.isSecretary)
							? serialized
							: stripForeignWhiteboardBodiesFromOrchestrationText(serialized, allowedWbIds);
						if (params.raw === true) {
							return safeSerialized;
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
							orchestrationText: safeSerialized,
						};
					}

					case 'orchestration.validate': {
						const requestedFormat = typeof params.format === 'string' ? params.format.trim().toLowerCase() : undefined;
						if (params.manifest !== undefined || requestedFormat === 'json' || requestedFormat === 'manifest') {
							let rawManifest = params.manifest !== undefined ? params.manifest : (params.text ?? params.orchestrationText ?? params.mermaid);
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
						const prevOrchGraph = parseOrchestrationGraph(mission.orchestrationText ?? '');
						const prevOrchState = runtime.getOrchestrationState(mission.id);
						if (mission.orchestrationText?.trim()) {
							await runtime.createMissionCheckpoint(mission.id, {
								reason: 'pre_orchestration_load',
								createdBy: ctx.callerSessionId ?? (ctx.isHumanUser ? 'human' : 'secretary'),
							}).catch(() => undefined);
						}
						const compiled = compileOrchestrationManifest(validation.manifest);
						const nextStaffIds = new Set(validation.manifest.staff.map(s => s.id));
						const removedStaffIds = prevOrchGraph.nodes
							.filter(n => n.kind === 'staff' && !nextStaffIds.has(n.id))
							.map(n => n.id);
						ctx.missionService?.updateOrchestrationText(mission.id, compiled.orchestrationText, {
							replaceWhiteboards: true,
							replacePositions: true,
						});
						if (removedStaffIds.length > 0) {
							await runtime.reconcileRemovedOrchestrationStaff(mission.id, removedStaffIds, {
								preState: prevOrchState,
								preGraph: prevOrchGraph,
								isHumanUser: ctx.isHumanUser,
								reason: 'Staff removed via orchestration.load',
							});
						}
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
						const prevOrchGraph = parseOrchestrationGraph(mission.orchestrationText ?? '');
						const prevOrchState = runtime.getOrchestrationState(mission.id);
						if (mission.orchestrationText?.trim()) {
							await runtime.createMissionCheckpoint(mission.id, {
								reason: `pre_${action.replace(/\./g, '_')}`,
								createdBy: ctx.callerSessionId ?? (ctx.isHumanUser ? 'human' : 'secretary'),
							}).catch(() => undefined);
						}
						const nextStaffIds = new Set(parsed.nodes.filter(n => n.kind === 'staff').map(n => n.id));
						const removedStaffIds = prevOrchGraph.nodes
							.filter(n => n.kind === 'staff' && !nextStaffIds.has(n.id))
							.map(n => n.id);
						ctx.missionService?.updateOrchestrationText(mission.id, text, isImport ? { replaceWhiteboards: true, replacePositions: true } : undefined);
						if (removedStaffIds.length > 0) {
							await runtime.reconcileRemovedOrchestrationStaff(mission.id, removedStaffIds, {
								preState: prevOrchState,
								preGraph: prevOrchGraph,
								isHumanUser: ctx.isHumanUser,
								reason: `Staff removed via ${action}`,
							});
						}
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
						const deleteMembers = params.deleteMembers === true;
						const prevOrchGraph = parseOrchestrationGraph(mission.orchestrationText ?? '');
						const prevOrchState = deleteMembers ? runtime.getOrchestrationState(mission.id) : undefined;
						const res = removeOrchestrationGroup(mission.orchestrationText ?? '', group, {
							deleteMembers,
						});
						if (!res.ok || !res.orchestrationText) {
							throw new Error(res.error ?? `Failed to remove group "${group}".`);
						}
						ctx.missionService?.updateOrchestrationText(mission.id, res.orchestrationText);
						let reconciledStaff: {
							readonly reclaimedTokenIds?: readonly string[];
							readonly recoveryTokenIds?: readonly string[];
							readonly settledBarrierIds?: readonly string[];
							readonly stoppedAgentIds?: readonly string[];
						} | undefined;
						if (deleteMembers && res.removedNodeIds && res.removedNodeIds.length > 0) {
							const removedStaffIds = res.removedNodeIds.filter(nid => prevOrchGraph.nodes.some(n => n.id === nid && n.kind === 'staff'));
							if (removedStaffIds.length > 0) {
								reconciledStaff = await runtime.reconcileRemovedOrchestrationStaff(mission.id, removedStaffIds, {
									preState: prevOrchState,
									preGraph: prevOrchGraph,
									isHumanUser: ctx.isHumanUser,
									reason: `Department group "${group}" removed with --delete-members`,
								});
							}
							const removedWbIds = res.removedNodeIds.filter(nid =>
								prevOrchGraph.nodes.some(n => n.id === nid && n.kind === 'whiteboard')
								|| Boolean(mission.whiteboards && Object.hasOwn(mission.whiteboards, nid)),
							);
							for (const wbId of removedWbIds) {
								runtime.removeOrchestrationWhiteboard(mission.id, wbId);
							}
							const latestWbs = ctx.missionService?.getMission(mission.id)?.whiteboards;
							if (latestWbs) {
								const nextWbs: Record<string, IOrchestrationWhiteboard> = { ...latestWbs };
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
						}
						return {
							ok: true,
							missionId: mission.id,
							groupId: res.groupId,
							removedNodeIds: res.removedNodeIds ?? [],
							...(reconciledStaff ? {
								reclaimedTokenIds: reconciledStaff.reclaimedTokenIds ?? [],
								recoveryTokenIds: reconciledStaff.recoveryTokenIds ?? [],
								settledBarrierIds: reconciledStaff.settledBarrierIds ?? [],
								stoppedAgentIds: reconciledStaff.stoppedAgentIds ?? [],
							} : {}),
						};
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
						assertMissionMemberOrSupervisor(ctx, mission);
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
							stoppedAgentIds: res.stoppedAgentIds ?? [],
						};
					}

					case 'orchestration.status': {
						const mission = resolveMissionRecord(params, ctx);
						assertMissionMemberOrSupervisor(ctx, mission);
						const full = params.full === true || params.verbose === true;
						const parsed = parseOrchestrationGraph(mission.orchestrationText ?? '');
						const orchState = runtime.getOrchestrationState(mission.id);
						const unified = buildUnifiedOrchestrationStatusResponse({
							missionId: mission.id,
							title: mission.title,
							state: orchState,
							staffCount: parsed.nodes.filter(n => n.kind === 'staff').length,
							full,
						});
						return {
							...unified,
							silenceReminderMinutes: orchState.silenceReminderMinutes,
							whiteboardCount: parsed.nodes.filter(n => n.kind === 'whiteboard').length,
							edgeCount: parsed.edges.length,
							nodeAgentIds: orchState.nodeAgentIds,
							...(parsed.advisories && parsed.advisories.length > 0 ? { advisories: parsed.advisories } : {}),
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
						const taskNodeId = typeof (params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
							? String(params.taskNodeId ?? params.taskId ?? params.task ?? params.taskNode).trim()
							: undefined;
						const rawTaskIds = params.taskNodeIds ?? params.taskIds ?? params.tasks;
						const taskNodeIds = Array.isArray(rawTaskIds)
							? rawTaskIds.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawTaskIds === 'string' ? rawTaskIds.split(',').map(s => s.trim()).filter(Boolean) : undefined);
						const rawRefs = params.refPtrs ?? params.refs ?? params.ref;
						const refPtrs = Array.isArray(rawRefs)
							? rawRefs.map(v => String(v).trim()).filter(Boolean)
							: (typeof rawRefs === 'string' ? rawRefs.split(',').map(s => s.trim()).filter(Boolean) : undefined);
						const res = await runtime.dispatchOrchestrationRequirement(mission.id, {
							prompt,
							...(detail ? { detail } : {}),
							targetNodeId: typeof (params.targetNodeId ?? params.target ?? params.to ?? params.node) === 'string'
								? String(params.targetNodeId ?? params.target ?? params.to ?? params.node).trim()
								: undefined,
							...(taskNodeId ? { taskNodeId } : {}),
							...(taskNodeIds && taskNodeIds.length > 0 ? { taskNodeIds } : {}),
							whiteboardIds,
							...(parseBlobInputs(params.artifacts) ? { artifacts: parseBlobInputs(params.artifacts) } : {}),
							...(parseBlobInputs(params.decisions) ? { decisions: parseBlobInputs(params.decisions) } : {}),
							...(refPtrs && refPtrs.length > 0 ? { refPtrs } : {}),
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
							createWhiteboard: params.createWhiteboard === true,
							whiteboardTitle: typeof params.whiteboardTitle === 'string' ? params.whiteboardTitle : undefined,
						});
						if (!res.ok) {
							throw new Error(res.error ?? `Failed to dynamically create subordinate "${name}".`);
						}
						return {
							ok: true,
							missionId: mission.id,
							nodeId: res.newNodeId,
							agentId: res.agentId,
							...(res.department ? { department: res.department } : {}),
							...(res.createdDepartment !== undefined ? { createdDepartment: res.createdDepartment } : {}),
							...(res.whiteboardId ? { whiteboardId: res.whiteboardId } : {}),
							...(res.nextTokenIds ? { nextTokenIds: res.nextTokenIds } : {}),
						};
					}

		default:
			throw new Error(`Unsupported Mission runtime action: ${action}`);
	}
}
