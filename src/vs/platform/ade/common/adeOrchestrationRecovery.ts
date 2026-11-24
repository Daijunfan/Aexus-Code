/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMissionDagParseResult } from './adeMissionDag.js';
import { IMissionTraceNode } from './adeMissionEngine.js';
import { IOrchestrationGraphParseResult } from './adeOrchestrationGraph.js';
import {
	checkAndTripOrchestrationMaxHops,
	settleJoinBarrierIfApplicable,
} from './adeOrchestrationEngine.js';
import {
	assertOrchestrationTokenHolder,
	buildOrchestrationDispatchEffect,
	buildStaffGraphIndex,
	findActiveAncestorTokenOnNode,
	formatBudgetExceededError,
	hasDownwardLineageFrom,
	incrementEdgeBounceCounts,
	isOrchestrationBudgetTripped,
	normalizeBoundTaskIds,
	recomputeOrchestrationNodeState,
	stageTransitionContext,
	storeOrReuseContextBlob,
} from './adeOrchestrationPipeline.js';
import { syncMissionTaskStatusesFromOrchestration, validateTokenTaskBindings } from './adeOrchestrationTasks.js';
import {
	buildCompactHeadline,
	buildHopKey,
	DEFAULT_ORCHESTRATION_MAX_HOPS,
	getHighestRankInSchema,
	IMissionTaskStatusRecord,
	IOrchestrationContextBlob,
	IOrchestrationContextBlobInput,
	IOrchestrationContextRef,
	IOrchestrationHopLedgerEntry,
	IOrchestrationJoinBarrier,
	IOrchestrationReworkEntry,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTransitionResult,
	IOrchestrationWhiteboard,
	IOrchestrationWhiteboardPointer,
	ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS,
	OrchestrationNodeRuntimeStatus,
	OrchestrationReworkCategory,
	OrchestrationTokenStatus,
	recordNodeCursorObservation,
	refreshContextRefsWithLiveWhiteboards,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { validateTokenWhiteboardAttachments } from './adeOrchestrationWhiteboards.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

const MAX_ORCHESTRATION_REWORK_HISTORY = 8;

function appendReworkMemory(
	prevHistory: readonly IOrchestrationReworkEntry[] | undefined,
	entry: IOrchestrationReworkEntry,
): readonly IOrchestrationReworkEntry[] {
	const merged = [...(prevHistory ?? []), entry];
	return merged.length > MAX_ORCHESTRATION_REWORK_HISTORY
		? merged.slice(-MAX_ORCHESTRATION_REWORK_HISTORY)
		: merged;
}

/**
 * Explicitly marks an Orchestration token as `'failed'`, settling any waiting join barrier
 * so a failed branch never deadlocks its waiting superior.
 */
export function failOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly detail?: string;
		readonly category?: OrchestrationReworkCategory;
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly barrierSatisfied?: boolean; readonly payloadPtr?: string; readonly notifiedSuperiorNodeId?: string; readonly recoveryTokenId?: string }> {
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before failing tokens.' };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	const holderCheck = assertOrchestrationTokenHolder(state, graph, token, params.callerAgentId);
	if (!holderCheck.ok) {
		return { ok: false, state, effects: [], code: holderCheck.code, error: holderCheck.error };
	}
	const reason = params.reason.trim() || 'Execution failed';
	const now = params.now ?? Date.now();
	const traceSeq = state.traceSeq + 1;
	const failTracePtr = `otrc-${traceSeq}`;
	const nextHop = (token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1)) + 1;
	const { headline, wasTruncated } = buildCompactHeadline(reason);
	const rawDetail = params.detail?.trim() || (wasTruncated ? reason : '');
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const mergedRefs = [...(token.contextRefs ?? [])];
	let payloadPtr: string | undefined;
	if (rawDetail) {
		const failRef = storeOrReuseContextBlob(
			payloadStore,
			payloadSeqRef,
			{
				kind: 'handoff',
				title: `Failure #${nextHop} @ ${token.nodeId}`,
				content: rawDetail,
				authorNodeId: token.nodeId,
				authorAgentId: token.holderAgentId,
				hop: nextHop,
				waveId: token.waveId,
				now,
			},
			state.externalizedBlobIndex,
		);
		payloadPtr = failRef.ptr;
	}
	const failedToken: IOrchestrationToken = {
		...token,
		status: 'failed',
		blocked: undefined,
		failureReason: reason,
		...(params.category ? { reworkCategory: params.category } : {}),
		hopIndex: nextHop,
		lastSummary: headline,
		...(payloadPtr ? { payloadPtr } : {}),
		contextRefs: mergedRefs,
		hopLog: [...(token.hopLog ?? []), {
			hop: nextHop,
			tokenId: token.id,
			fromNodeId: token.nodeId,
			toNodeId: token.nodeId,
			event: 'fail',
			headline,
			...(payloadPtr ? { payloadPtr } : {}),
			timestamp: now,
		}],
		lastActivityAt: now,
	};
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: failedToken,
	};
	// Record failure of trailing branch on already-satisfied join barrier without re-waking resumed superior
	let nextBarriers = state.joinBarriers;
	const existingBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
	if (existingBarrier && existingBarrier.status === 'satisfied' && state.joinBarriers) {
		nextBarriers = {
			...state.joinBarriers,
			[existingBarrier.id]: {
				...existingBarrier,
				settledChildren: {
					...existingBarrier.settledChildren,
					[token.id]: {
						tokenId: token.id,
						fromNodeId: token.nodeId,
						outcome: 'failed',
						summary: `FAILED: ${headline}`,
						...(payloadPtr ? { payloadPtr } : {}),
						...(token.taskNodeId ? { taskNodeId: token.taskNodeId } : {}),
						...(token.scopePaths && token.scopePaths.length > 0 ? { scopePaths: token.scopePaths } : {}),
						...(token.touchedFiles && token.touchedFiles.length > 0 ? { touchedFiles: token.touchedFiles } : {}),
						settledAt: now,
					},
				},
			},
		};
	}
	const preBarrierState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		},
		...(nextBarriers ? { joinBarriers: nextBarriers } : {}),
		traces: {
			...state.traces,
			[failTracePtr]: {
				ptr: failTracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'fail_escalate',
				summary: headline,
				timestamp: now,
			},
		},
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};
	const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
		childToken: failedToken,
		outcome: 'failed',
		summary: `FAILED: ${headline}`,
		payloadPtr,
		extraContextRefs: mergedRefs,
		taskGraph: params.taskGraph,
		taskStatuses: params.taskStatuses,
		now,
	});

	const parentBarrierStatus = failedToken.parentJoinBarrierId ? settled.state.joinBarriers?.[failedToken.parentJoinBarrierId]?.status : undefined;
	if (!failedToken.parentJoinBarrierId && settled.effects.length === 0 && parentBarrierStatus !== 'satisfied') {
		const staffIndex = buildStaffGraphIndex(graph);
		const fallbackSuperiorId = [
			failedToken.returnToNodeId,
			failedToken.originNodeId && failedToken.originNodeId !== 'User' ? failedToken.originNodeId : undefined,
		].find((id): id is string => Boolean(id && id !== failedToken.nodeId && staffIndex.staffById.has(id)));
		if (fallbackSuperiorId) {
			const supNode = staffIndex.staffById.get(fallbackSuperiorId)!;
			const supAgentId = settled.state.nodeAgentIds[fallbackSuperiorId] ?? supNode.agentId;
			const activeParent = findActiveAncestorTokenOnNode(settled.state, failedToken, fallbackSuperiorId);
			if (activeParent) {
				const nextTraceSeq = settled.state.traceSeq + 1;
				const noticeTracePtr = `otrc-${nextTraceSeq}`;
				const noticeHeadline = buildCompactHeadline(`[FAILED at ${failedToken.nodeId} (${failedToken.id})] ${reason}`).headline;
				const parentHop = Math.max(nextHop + 1, (activeParent.hopIndex ?? Math.max(0, (activeParent.hopLog?.length ?? 1) - 1)) + 1);
				const noticeHop: IOrchestrationHopLedgerEntry = {
					hop: parentHop,
					tokenId: activeParent.id,
					fromNodeId: failedToken.nodeId,
					toNodeId: fallbackSuperiorId,
					event: 'fail',
					headline: noticeHeadline,
					...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
					timestamp: now,
				};
				const mergedParentRefMap = new Map<string, IOrchestrationContextRef>();
				for (const r of activeParent.contextRefs ?? []) { mergedParentRefMap.set(r.ptr, r); }
				for (const r of failedToken.contextRefs ?? []) { mergedParentRefMap.set(r.ptr, r); }
				const updatedParent: IOrchestrationToken = {
					...activeParent,
					status: 'active',
					blocked: undefined,
					fromNodeId: failedToken.nodeId,
					holderAgentId: supAgentId,
					hopIndex: parentHop,
					relayDepth: activeParent.relayDepth ?? 0,
					lastSummary: noticeHeadline,
					...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
					hopLog: [...(activeParent.hopLog ?? []), noticeHop],
					contextRefs: [...mergedParentRefMap.values()],
					lastActivityAt: now,
					lastNudgeAt: undefined,
					nudgeCount: 0,
				};
				const mergedTokens = { ...settled.state.tokens, [activeParent.id]: updatedParent };
				const bouncedState: IOrchestrationRuntimeState = {
					...settled.state,
					tokens: mergedTokens,
					nodeStates: {
						...settled.state.nodeStates,
						[fallbackSuperiorId]: recomputeOrchestrationNodeState(mergedTokens, fallbackSuperiorId),
					},
					traces: {
						...settled.state.traces,
						[noticeTracePtr]: {
							ptr: noticeTracePtr,
							parentPtrs: [failTracePtr, activeParent.tracePtr],
							nodeId: fallbackSuperiorId,
							employeeId: supAgentId,
							waveId: failedToken.waveId,
							event: 'fail_escalate',
							summary: noticeHeadline,
							timestamp: now,
						},
					},
					traceSeq: nextTraceSeq,
					stateRevision: (settled.state.stateRevision ?? 0) + 1,
					updatedAt: now,
				};
				return {
					ok: true,
					state: bouncedState,
					effects: [buildOrchestrationDispatchEffect({
						state: bouncedState,
						graph,
						staffIndex,
						whiteboards,
						config,
						targetNode: supNode,
						token: updatedParent,
						holderAgentId: supAgentId,
						taskGraph: params.taskGraph,
						rawTaskStatuses: params.taskStatuses,
					})],
					data: {
						notifiedSuperiorNodeId: fallbackSuperiorId,
						recoveryTokenId: activeParent.id,
						...(payloadPtr ? { payloadPtr } : {}),
					},
				};
			}
			const nextTokenSeq = settled.state.tokenSeq + 1;
			const nextTraceSeq = settled.state.traceSeq + 1;
			const noticeTokenId = `otok-${nextTokenSeq}`;
			const noticeTracePtr = `otrc-${nextTraceSeq}`;
			const noticeHeadline = buildCompactHeadline(`[FAILED at ${failedToken.nodeId}] ${reason}`).headline;
			const noticeHop: IOrchestrationHopLedgerEntry = {
				hop: nextHop + 1,
				tokenId: noticeTokenId,
				fromNodeId: failedToken.nodeId,
				toNodeId: fallbackSuperiorId,
				event: 'fail',
				headline: noticeHeadline,
				...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
				timestamp: now,
			};
			const noticeToken: IOrchestrationToken = {
				id: noticeTokenId,
				waveId: failedToken.waveId,
				nodeId: fallbackSuperiorId,
				fromNodeId: failedToken.nodeId,
				holderAgentId: supAgentId,
				status: 'active',
				parentTokenId: failedToken.id,
				rootTokenId: failedToken.rootTokenId ?? failedToken.id,
				originNodeId: failedToken.originNodeId,
				dispatchKind: 'return',
				...(failedToken.taskNodeId ? { taskNodeId: failedToken.taskNodeId } : {}),
				...(failedToken.taskNodeIds ? { taskNodeIds: failedToken.taskNodeIds } : {}),
				hopIndex: nextHop + 1,
				relayDepth: failedToken.relayDepth ?? 0,
				lastSummary: noticeHeadline,
				...(failedToken.payloadPtr ? { payloadPtr: failedToken.payloadPtr } : {}),
				hopLog: [...(failedToken.hopLog ?? []), noticeHop],
				contextRefs: failedToken.contextRefs ?? [],
				compressedHistory: '',
				tracePtr: noticeTracePtr,
				...(failedToken.whiteboardPointers ? { whiteboardPointers: failedToken.whiteboardPointers } : {}),
				arrivedAt: now,
				lastActivityAt: now,
				nudgeCount: 0,
			};
			const mergedTokens = { ...settled.state.tokens, [noticeTokenId]: noticeToken };
			const bouncedState: IOrchestrationRuntimeState = {
				...settled.state,
				tokens: mergedTokens,
				nodeStates: {
					...settled.state.nodeStates,
					[fallbackSuperiorId]: recomputeOrchestrationNodeState(mergedTokens, fallbackSuperiorId),
				},
				traces: {
					...settled.state.traces,
					[noticeTracePtr]: {
						ptr: noticeTracePtr,
						parentPtrs: [failTracePtr],
						nodeId: fallbackSuperiorId,
						employeeId: supAgentId,
						waveId: failedToken.waveId,
						event: 'fail_escalate',
						summary: noticeHeadline,
						timestamp: now,
					},
				},
				tokenSeq: nextTokenSeq,
				traceSeq: nextTraceSeq,
				stateRevision: (settled.state.stateRevision ?? 0) + 1,
				updatedAt: now,
			};
			return {
				ok: true,
				state: bouncedState,
				effects: [buildOrchestrationDispatchEffect({
					state: bouncedState,
					graph,
					staffIndex,
					whiteboards,
					config,
					targetNode: supNode,
					token: noticeToken,
					holderAgentId: supAgentId,
					taskGraph: params.taskGraph,
					rawTaskStatuses: params.taskStatuses,
				})],
				data: {
					notifiedSuperiorNodeId: fallbackSuperiorId,
					recoveryTokenId: noticeTokenId,
					...(payloadPtr ? { payloadPtr } : {}),
				},
			};
		}
		return {
			ok: true,
			state: settled.state,
			effects: [{
				kind: 'post_inbox',
				missionId: state.missionId,
				nodeId: failedToken.nodeId,
				tokenId: failedToken.id,
				title: `Engineering Failure (${failedToken.nodeId})`,
				message: `Token \`${failedToken.id}\` failed on staff node \`${failedToken.nodeId}\`: ${reason}`,
				severity: 'critical',
				senderAgentId: failedToken.holderAgentId,
			}],
			data: { ...(payloadPtr ? { payloadPtr } : {}) },
		};
	}
	return {
		ok: true,
		state: settled.state,
		effects: settled.effects,
		data: {
			...(settled.barrierSatisfied ? { barrierSatisfied: true } : {}),
			...(payloadPtr ? { payloadPtr } : {}),
		},
	};
}

/**
 * First-class Orchestration revision / rejection loop (`token reject`):
 * Closes the feedback loop cleanly across ALL 3 staff-topology directions without breaking Join Barriers.
 */
export function rejectOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly detail?: string;
		readonly category?: OrchestrationReworkCategory;
		readonly targetNodeId?: string;
		readonly targetNodeIds?: readonly string[];
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly waitJoin?: boolean;
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly rejectedTokenId: string;
	readonly bouncedTokenId?: string;
	readonly nextTokenIds: readonly string[];
	readonly targetNodeId: string;
	readonly targetNodeIds: readonly string[];
	readonly mode: 'downward_rework' | 'peer_bounce' | 'upward_reject';
	readonly joinBarrierId?: string;
	readonly barrierSatisfied?: boolean;
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'reject tokens') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before rejecting tokens.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active Orchestration token "${params.tokenId}" not found.` };
	}
	const holderCheck = assertOrchestrationTokenHolder(state, graph, token, params.callerAgentId);
	if (!holderCheck.ok) {
		return { ok: false, state, effects: [], code: holderCheck.code, error: holderCheck.error };
	}
	const reason = params.reason.trim();
	if (!reason) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Rejection --reason is required for token.reject.' };
	}

	const staffIndex = buildStaffGraphIndex(graph);
	const staffById = staffIndex.staffById;
	const holderNode = staffById.get(token.nodeId);
	const holderTier = resolveEffectiveStaffTier(holderNode, config);

	const explicitTargets = [...new Set([
		...(params.targetNodeId?.trim() ? params.targetNodeId.split(',').map(s => s.trim()).filter(Boolean) : []),
		...(params.targetNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	let targetIds: string[];
	if (explicitTargets.length > 0) {
		targetIds = explicitTargets;
	} else {
		const lastHopSender = [...(token.hopLog ?? [])]
			.reverse()
			.find(h => h.fromNodeId && h.fromNodeId !== token.nodeId && staffById.has(h.fromNodeId))
			?.fromNodeId;
		const autoTarget = [
			token.fromNodeId,
			lastHopSender,
			token.returnToNodeId,
			token.originNodeId && token.originNodeId !== 'User' ? token.originNodeId : undefined,
		].find((id): id is string => Boolean(id && id !== token.nodeId && staffById.has(id)));
		if (!autoTarget) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Token "${token.id}" on "${token.nodeId}" has no prior sender to bounce back to. Specify --target <subordinateNodeId> to request revision, or use "aexus-ade token fail ${token.id} --reason ..." to report failure.`,
			};
		}
		targetIds = [autoTarget];
	}

	for (const tid of targetIds) {
		if (tid === token.nodeId) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Staff node "${token.nodeId}" cannot reject token "${token.id}" to itself.` };
		}
		if (!staffById.has(tid)) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Rejection target staff node "${tid}" does not exist on Orchestration canvas.` };
		}
	}

	const wbCheck = validateTokenWhiteboardAttachments(
		graph,
		whiteboards,
		config,
		{ callerNodeId: token.nodeId, callerTier: holderTier, state },
		params.whiteboardIds,
		params.refPtrs,
	);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}

	const explicitRejectTaskIds = [...new Set([
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	if (explicitRejectTaskIds.length > 0) {
		const rejTaskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitRejectTaskIds, { allowCompleted: true });
		if (!rejTaskCheck.ok) {
			return { ok: false, state, effects: [], code: rejTaskCheck.code ?? 'INVALID_STATE', error: rejTaskCheck.error };
		}
	}

	const primaryTarget = staffById.get(targetIds[0])!;
	const primaryTargetTier = resolveEffectiveStaffTier(primaryTarget, config);
	const allStrictlyDownward = holderTier !== undefined
		&& targetIds.every(tid => {
			const tTier = resolveEffectiveStaffTier(staffById.get(tid), config);
			return tTier !== undefined && tTier > holderTier;
		});
	const isUpwardSingle = targetIds.length === 1
		&& holderTier !== undefined
		&& primaryTargetTier !== undefined
		&& primaryTargetTier < holderTier;

	const now = params.now ?? Date.now();
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const nextRelayDepth = (token.relayDepth ?? prevHopIndex) + 1;
	const hopCheck = checkAndTripOrchestrationMaxHops<{
		readonly rejectedTokenId: string;
		readonly bouncedTokenId?: string;
		readonly nextTokenIds: readonly string[];
		readonly targetNodeId: string;
		readonly targetNodeIds: readonly string[];
		readonly mode: 'downward_rework' | 'peer_bounce' | 'upward_reject';
		readonly joinBarrierId?: string;
		readonly barrierSatisfied?: boolean;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
	}>(state, graph, whiteboards, config, token, nextRelayDepth, 'token.reject', now);
	if (hopCheck.tripped) {
		return hopCheck.result;
	}

	const prefixedSummary = `[REJECTED by ${token.nodeId}] ${reason}`;
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const staged = stageTransitionContext({
		payloadStore,
		payloadSeqRef,
		externalizedBlobIndex: state.externalizedBlobIndex,
		whiteboards,
		baseRefs: token.contextRefs,
		baseWhiteboardPointers: token.whiteboardPointers,
		summary: prefixedSummary,
		detail: params.detail || (prefixedSummary.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS ? reason : undefined),
		detailTitle: `Rejection #${nextHopIndex}: ${token.nodeId} → ${targetIds.join(', ')}`,
		authorNodeId: token.nodeId,
		authorAgentId: token.holderAgentId,
		hop: nextHopIndex,
		waveId: token.waveId,
		now,
		artifacts: params.artifacts,
		decisions: params.decisions,
		refPtrs: params.refPtrs,
		normalizedWhiteboardIds: wbCheck.normalizedIds,
		defaultArtifactTitle: `Rejection Evidence from ${token.nodeId}`,
		defaultDecisionTitle: `Rejection Criteria by ${token.nodeId}`,
	});

	const baseHopLog: readonly IOrchestrationHopLedgerEntry[] = token.hopLog && token.hopLog.length > 0
		? token.hopLog
		: [{
			hop: prevHopIndex,
			tokenId: token.id,
			...(token.fromNodeId ? { fromNodeId: token.fromNodeId } : {}),
			toNodeId: token.nodeId,
			event: token.fromNodeId ? 'handoff' : 'dispatch',
			headline: buildCompactHeadline(token.lastSummary).headline,
			...(token.payloadPtr ? { payloadPtr: token.payloadPtr } : {}),
			timestamp: token.arrivedAt,
		}];

	// Mode 1: Downward Revision Rework (Superior -> Subordinate(s))
	if (allStrictlyDownward) {
		const validOutgoing = new Set(staffIndex.outgoingStaffByNode.get(token.nodeId) ?? []);
		for (const tid of targetIds) {
			const hasAnyEdgeOrPrior = validOutgoing.has(tid)
				|| token.fromNodeId === tid
				|| (token.hopLog ?? []).some(h => h.fromNodeId === tid || h.toNodeId === tid);
			if (!hasAnyEdgeOrPrior) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'NO_EDGE',
					error: `No directed edge or prior delivery lineage from "${token.nodeId}" to "${tid}" in Orchestration graph.`,
				};
			}
		}

		const waitJoin = params.waitJoin !== false;
		let barrierSeq = state.barrierSeq ?? 0;
		let joinBarrierId: string | undefined;
		if (waitJoin) {
			barrierSeq += 1;
			joinBarrierId = `bar-${barrierSeq}`;
		}
		let tokenSeq = state.tokenSeq;
		let traceSeq = state.traceSeq;
		const allocated = targetIds.map(tid => {
			tokenSeq += 1;
			traceSeq += 1;
			return {
				targetId: tid,
				childTokenId: `otok-${tokenSeq}`,
				tracePtr: `otrc-${traceSeq}`,
			};
		});
		const mintedTokenIds = allocated.map(a => a.childTokenId);
		const updatedParent: IOrchestrationToken = {
			...token,
			status: waitJoin ? 'waiting_join' : 'active',
			blocked: undefined,
			...(joinBarrierId ? { joinBarrierId } : {}),
			childTokenIds: [...(token.childTokenIds ?? []), ...mintedTokenIds],
			lastActivityAt: now,
		};
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: updatedParent,
		};
		const nextTraces: Record<string, IMissionTraceNode> = { ...state.traces };
		const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
		const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(state.joinBarriers ?? {}) };
		if (joinBarrierId) {
			nextBarriers[joinBarrierId] = {
				id: joinBarrierId,
				waveId: token.waveId,
				parentTokenId: token.id,
				ownerNodeId: token.nodeId,
				childTokenIds: mintedTokenIds,
				mode: 'all',
				status: 'waiting',
				settledChildren: {},
				createdAt: now,
			};
		}
		const spawnedChildren: { readonly targetId: string; readonly childToken: IOrchestrationToken; readonly targetAgentId?: string }[] = [];
		const parentChildSet = new Set(token.childTokenIds ?? []);
		for (const { targetId, childTokenId, tracePtr } of allocated) {
			const targetNode = staffById.get(targetId)!;
			const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
			// Prefer explicit task binding; else inherit the most recent prior branch child's task/scope/rework history for `targetId`
			const priorBranchChild = Object.values(state.tokens)
				.filter(t => t.nodeId === targetId && (t.parentTokenId === token.id || parentChildSet.has(t.id)))
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
			const branchTaskBinding = explicitRejectTaskIds.length > 0
				? normalizeBoundTaskIds(params.taskNodeId, params.taskNodeIds)
				: (priorBranchChild && (priorBranchChild.taskNodeId || (priorBranchChild.taskNodeIds && priorBranchChild.taskNodeIds.length > 0))
					? normalizeBoundTaskIds(priorBranchChild.taskNodeId, priorBranchChild.taskNodeIds)
					: normalizeBoundTaskIds(token.taskNodeId, token.taskNodeIds));
			const priorReworkHistory = priorBranchChild?.reworkHistory ?? token.reworkHistory;
			const nextAttempt = (priorBranchChild?.attemptNumber ?? token.attemptNumber ?? 1) + 1;
			const nextReworkHistory = appendReworkMemory(priorReworkHistory, {
				attempt: nextAttempt,
				kind: 'reject',
				byNodeId: token.nodeId,
				...(params.category ? { category: params.category } : {}),
				summary: buildCompactHeadline(reason).headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				timestamp: now,
			});
			const rejHop: IOrchestrationHopLedgerEntry = {
				hop: nextHopIndex,
				tokenId: childTokenId,
				fromNodeId: token.nodeId,
				toNodeId: targetId,
				event: 'reject',
				headline: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
				timestamp: now,
			};
			const childToken: IOrchestrationToken = {
				id: childTokenId,
				waveId: token.waveId,
				nodeId: targetId,
				fromNodeId: token.nodeId,
				holderAgentId: targetAgentId,
				status: 'active',
				parentTokenId: token.id,
				rootTokenId: token.rootTokenId ?? token.id,
				originNodeId: token.nodeId,
				returnToNodeId: token.nodeId,
				dispatchKind: 'reject',
				rejectionReason: reason,
				attemptNumber: nextAttempt,
				...(params.category ? { reworkCategory: params.category } : {}),
				reworkHistory: nextReworkHistory,
				...(priorBranchChild?.scopePaths && priorBranchChild.scopePaths.length > 0
					? { scopePaths: priorBranchChild.scopePaths }
					: (token.scopePaths && token.scopePaths.length > 0 ? { scopePaths: token.scopePaths } : {})),
				...(joinBarrierId ? { parentJoinBarrierId: joinBarrierId } : {}),
				...branchTaskBinding,
				hopIndex: nextHopIndex,
				relayDepth: nextRelayDepth,
				edgeBounceCounts: incrementEdgeBounceCounts(token.edgeBounceCounts, token.nodeId, targetId),
				lastSummary: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				hopLog: [...baseHopLog, rejHop],
				contextRefs: staged.contextRefs,
				compressedHistory: '',
				tracePtr,
				...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
				arrivedAt: now,
				lastActivityAt: now,
				nudgeCount: 0,
			};
			nextTokens[childTokenId] = childToken;
			nextTraces[tracePtr] = {
				ptr: tracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: targetId,
				employeeId: targetAgentId,
				waveId: token.waveId,
				event: 'reject_bounce',
				summary: `Reject -> ${targetId}: ${staged.headline}`,
				timestamp: now,
			};
			nextNodeStates[targetId] = recomputeOrchestrationNodeState(nextTokens, targetId);
			spawnedChildren.push({ targetId, childToken, targetAgentId });
		}
		nextNodeStates[token.nodeId] = recomputeOrchestrationNodeState(nextTokens, token.nodeId);
		const observedHopIds = [
			...baseHopLog.map(h => buildHopKey(h)),
			...allocated.map(a => `${a.childTokenId}:${nextHopIndex}`),
		];
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			staged.allObservedRefs,
			now,
			observedHopIds,
		);
		const nextState: IOrchestrationRuntimeState = {
			...state,
			status: 'running',
			tokens: nextTokens,
			nodeStates: nextNodeStates,
			traces: nextTraces,
			joinBarriers: nextBarriers,
			barrierSeq,
			payloadStore,
			payloadSeq: payloadSeqRef.value,
			nodeReadCursors: nextCursors,
			tokenSeq,
			traceSeq,
			stateRevision: (state.stateRevision ?? 0) + 1,
			updatedAt: now,
		};
		const syncedTaskStatuses = params.taskGraph && !params.taskGraph.error
			? syncMissionTaskStatusesFromOrchestration(params.taskStatuses, params.taskGraph, nextState, graph).taskStatuses
			: params.taskStatuses;
		return {
			ok: true,
			state: nextState,
			effects: spawnedChildren.map(c => buildOrchestrationDispatchEffect({
				state: nextState,
				graph,
				staffIndex,
				whiteboards,
				config,
				targetNode: staffById.get(c.targetId)!,
				token: c.childToken,
				holderAgentId: c.targetAgentId,
				taskGraph: params.taskGraph,
				syncedTaskStatuses,
			})),
			data: {
				rejectedTokenId: token.id,
				bouncedTokenId: mintedTokenIds[0],
				nextTokenIds: mintedTokenIds,
				targetNodeId: targetIds[0],
				targetNodeIds: targetIds,
				mode: 'downward_rework',
				...(joinBarrierId ? { joinBarrierId } : {}),
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			},
		};
	}

	// Mode 2: Upward Rejection / Refusal (Subordinate -> Dispatching Superior)
	if (isUpwardSingle) {
		const targetId = targetIds[0];
		const activeBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
		const isDirectDispatcher = activeBarrier?.ownerNodeId === targetId
			|| token.returnToNodeId === targetId
			|| token.originNodeId === targetId
			|| token.fromNodeId === targetId;
		const hasDirectUpwardEdge = (staffIndex.outgoingStaffByNode.get(token.nodeId) ?? []).includes(targetId);
		if (!isDirectDispatcher && !(hasDirectUpwardEdge && hasDownwardLineageFrom(token, targetId))) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'UPWARD_TOKEN_FORBIDDEN',
				error: `UPWARD_TOKEN_FORBIDDEN: subordinate "${token.nodeId}" (L${holderTier}) cannot reject token "${token.id}" upward to superior "${targetId}" (L${primaryTargetTier}) without direct dispatch lineage or edge.`,
			};
		}
		const rejectHopEntry: IOrchestrationHopLedgerEntry = {
			hop: nextHopIndex,
			tokenId: token.id,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: 'reject',
			headline: staged.headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			timestamp: now,
		};

		// 2a-0. Trailing branch of an ALREADY-satisfied join barrier -> record rejection cleanly without corrupting resumed parent!
		const upwardChildAttempt = (token.attemptNumber ?? 1) + 1;
		const upwardChildReworkHistory = appendReworkMemory(token.reworkHistory, {
			attempt: upwardChildAttempt,
			kind: 'reject',
			byNodeId: token.nodeId,
			...(params.category ? { category: params.category } : {}),
			summary: buildCompactHeadline(reason).headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			timestamp: now,
		});
		if (activeBarrier && activeBarrier.status === 'satisfied' && activeBarrier.ownerNodeId === targetId) {
			const traceSeq = state.traceSeq + 1;
			const rejTracePtr = `otrc-${traceSeq}`;
			const closedChild: IOrchestrationToken = {
				...token,
				status: 'completed',
				blocked: undefined,
				rejectionReason: reason,
				attemptNumber: upwardChildAttempt,
				...(params.category ? { reworkCategory: params.category } : {}),
				reworkHistory: upwardChildReworkHistory,
				hopIndex: nextHopIndex,
				relayDepth: nextRelayDepth,
				lastSummary: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				hopLog: [...baseHopLog, rejectHopEntry],
				contextRefs: staged.contextRefs,
				...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
				lastActivityAt: now,
			};
			const nextTokens = { ...state.tokens, [token.id]: closedChild };
			const nextBarriers: Record<string, IOrchestrationJoinBarrier> = {
				...(state.joinBarriers ?? {}),
				[activeBarrier.id]: {
					...activeBarrier,
					settledChildren: {
						...activeBarrier.settledChildren,
						[token.id]: {
							tokenId: token.id,
							fromNodeId: token.nodeId,
							outcome: 'rejected',
							summary: staged.headline,
							...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
							...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
							...(token.taskNodeId ? { taskNodeId: token.taskNodeId } : {}),
							...(token.scopePaths && token.scopePaths.length > 0 ? { scopePaths: token.scopePaths } : {}),
							...(token.touchedFiles && token.touchedFiles.length > 0 ? { touchedFiles: token.touchedFiles } : {}),
							settledAt: now,
						},
					},
				},
			};
			const nextCursors = recordNodeCursorObservation(
				state.nodeReadCursors,
				token.waveId,
				token.nodeId,
				nextHopIndex,
				staged.allObservedRefs,
				now,
				[...baseHopLog.map(h => buildHopKey(h)), buildHopKey(rejectHopEntry)],
			);
			return {
				ok: true,
				state: {
					...state,
					tokens: nextTokens,
					nodeStates: {
						...state.nodeStates,
						[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
					},
					joinBarriers: nextBarriers,
					traces: {
						...state.traces,
						[rejTracePtr]: {
							ptr: rejTracePtr,
							parentPtrs: [token.tracePtr],
							nodeId: token.nodeId,
							employeeId: token.holderAgentId,
							waveId: token.waveId,
							event: 'reject_bounce',
							summary: `Trailing reject -> ${targetId} (barrier ${activeBarrier.id} already satisfied): ${staged.headline}`,
							timestamp: now,
						},
					},
					payloadStore,
					payloadSeq: payloadSeqRef.value,
					nodeReadCursors: nextCursors,
					traceSeq,
					stateRevision: (state.stateRevision ?? 0) + 1,
					updatedAt: now,
				},
				effects: [],
				data: {
					rejectedTokenId: token.id,
					nextTokenIds: [],
					targetNodeId: targetId,
					targetNodeIds: [targetId],
					mode: 'upward_reject',
					joinBarrierId: activeBarrier.id,
					barrierSatisfied: true,
					...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
					...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
				},
			};
		}

		// 2a. Settling waiting Join Barrier owned by `targetId`
		if (activeBarrier && activeBarrier.status === 'waiting' && activeBarrier.ownerNodeId === targetId) {
			const traceSeq = state.traceSeq + 1;
			const rejTracePtr = `otrc-${traceSeq}`;
			const closedChild: IOrchestrationToken = {
				...token,
				status: 'completed',
				blocked: undefined,
				rejectionReason: reason,
				attemptNumber: upwardChildAttempt,
				...(params.category ? { reworkCategory: params.category } : {}),
				reworkHistory: upwardChildReworkHistory,
				hopIndex: nextHopIndex,
				relayDepth: nextRelayDepth,
				lastSummary: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				hopLog: [...baseHopLog, rejectHopEntry],
				contextRefs: staged.contextRefs,
				...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
				lastActivityAt: now,
			};
			const nextTokens = { ...state.tokens, [token.id]: closedChild };
			const nextCursors = recordNodeCursorObservation(
				state.nodeReadCursors,
				token.waveId,
				token.nodeId,
				nextHopIndex,
				staged.allObservedRefs,
				now,
				[...baseHopLog.map(h => buildHopKey(h)), buildHopKey(rejectHopEntry)],
			);
			const preBarrierState: IOrchestrationRuntimeState = {
				...state,
				tokens: nextTokens,
				nodeStates: {
					...state.nodeStates,
					[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
				},
				traces: {
					...state.traces,
					[rejTracePtr]: {
						ptr: rejTracePtr,
						parentPtrs: [token.tracePtr],
						nodeId: token.nodeId,
						employeeId: token.holderAgentId,
						waveId: token.waveId,
						event: 'reject_bounce',
						summary: `Reject -> ${targetId} (barrier ${activeBarrier.id}): ${staged.headline}`,
						timestamp: now,
					},
				},
				payloadStore,
				payloadSeq: payloadSeqRef.value,
				nodeReadCursors: nextCursors,
				traceSeq,
				stateRevision: (state.stateRevision ?? 0) + 1,
				updatedAt: now,
			};
			const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
				childToken: closedChild,
				outcome: 'rejected',
				summary: staged.headline,
				payloadPtr: staged.payloadPtr,
				attachedRefPtrs: staged.attachedRefPtrs,
				extraContextRefs: staged.contextRefs,
				extraWhiteboardPointers: staged.whiteboardPointers,
				taskGraph: params.taskGraph,
				taskStatuses: params.taskStatuses,
				now,
			});
			return {
				ok: true,
				state: settled.state,
				effects: settled.effects,
				data: {
					rejectedTokenId: token.id,
					bouncedTokenId: settled.parentTokenId,
					nextTokenIds: settled.parentTokenId ? [settled.parentTokenId] : [],
					targetNodeId: targetId,
					targetNodeIds: [targetId],
					mode: 'upward_reject',
					joinBarrierId: activeBarrier.id,
					barrierSatisfied: settled.barrierSatisfied,
					...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
					...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
				},
			};
		}

		// 2b. Superior still holds active parent baton -> merge rejection into parent baton cleanly
		const existingActiveParent = findActiveAncestorTokenOnNode(state, token, targetId);
		if (existingActiveParent) {
			const traceSeq = state.traceSeq + 1;
			const rejTracePtr = `otrc-${traceSeq}`;
			const targetAgentId = state.nodeAgentIds[targetId] ?? primaryTarget.agentId;
			const parentHopIndex = Math.max(nextHopIndex, (existingActiveParent.hopIndex ?? Math.max(0, (existingActiveParent.hopLog?.length ?? 1) - 1)) + 1);
			const parentRefMap = new Map<string, IOrchestrationContextRef>();
			for (const r of refreshContextRefsWithLiveWhiteboards(existingActiveParent.contextRefs, whiteboards, existingActiveParent.whiteboardPointers, parentHopIndex)) {
				parentRefMap.set(r.ptr, r);
			}
			for (const r of staged.contextRefs) { parentRefMap.set(r.ptr, r); }
			const parentWbMap = new Map<string, IOrchestrationWhiteboardPointer>();
			for (const wp of existingActiveParent.whiteboardPointers ?? []) { parentWbMap.set(wp.whiteboardId, wp); }
			for (const wp of staged.whiteboardPointers) { parentWbMap.set(wp.whiteboardId, wp); }
			const parentRejectHop: IOrchestrationHopLedgerEntry = {
				hop: parentHopIndex,
				tokenId: existingActiveParent.id,
				fromNodeId: token.nodeId,
				toNodeId: targetId,
				event: 'reject',
				headline: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
				timestamp: now,
			};
			const closedChild: IOrchestrationToken = {
				...token,
				status: 'completed',
				blocked: undefined,
				rejectionReason: reason,
				hopIndex: nextHopIndex,
				relayDepth: nextRelayDepth,
				lastSummary: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				hopLog: [...baseHopLog, rejectHopEntry],
				contextRefs: staged.contextRefs,
				...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
				lastActivityAt: now,
			};
			const parentAttempt = (existingActiveParent.attemptNumber ?? 1) + 1;
			const parentReworkHistory = appendReworkMemory(existingActiveParent.reworkHistory, {
				attempt: parentAttempt,
				kind: 'reject',
				byNodeId: token.nodeId,
				...(params.category ? { category: params.category } : {}),
				summary: buildCompactHeadline(reason).headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				timestamp: now,
			});
			const updatedParent: IOrchestrationToken = {
				...existingActiveParent,
				status: 'active',
				blocked: undefined,
				fromNodeId: token.nodeId,
				holderAgentId: targetAgentId,
				dispatchKind: 'reject',
				rejectionReason: reason,
				attemptNumber: parentAttempt,
				...(params.category ? { reworkCategory: params.category } : {}),
				reworkHistory: parentReworkHistory,
				hopIndex: parentHopIndex,
				relayDepth: existingActiveParent.relayDepth ?? 0,
				lastSummary: staged.headline,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				hopLog: [...(existingActiveParent.hopLog ?? []), parentRejectHop],
				contextRefs: [...parentRefMap.values()],
				...(parentWbMap.size > 0 ? { whiteboardPointers: [...parentWbMap.values()] } : {}),
				lastActivityAt: now,
				lastNudgeAt: undefined,
				nudgeCount: 0,
			};
			const nextTokens = {
				...state.tokens,
				[token.id]: closedChild,
				[existingActiveParent.id]: updatedParent,
			};
			const nextCursors = recordNodeCursorObservation(
				state.nodeReadCursors,
				token.waveId,
				token.nodeId,
				nextHopIndex,
				staged.allObservedRefs,
				now,
				[...baseHopLog.map(h => buildHopKey(h)), buildHopKey(rejectHopEntry)],
			);
			const nextState: IOrchestrationRuntimeState = {
				...state,
				tokens: nextTokens,
				nodeStates: {
					...state.nodeStates,
					[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
					[targetId]: recomputeOrchestrationNodeState(nextTokens, targetId),
				},
				traces: {
					...state.traces,
					[rejTracePtr]: {
						ptr: rejTracePtr,
						parentPtrs: [token.tracePtr, existingActiveParent.tracePtr],
						nodeId: targetId,
						employeeId: targetAgentId,
						waveId: token.waveId,
						event: 'reject_bounce',
						summary: `Reject (${token.nodeId} -> ${targetId}): ${staged.headline}`,
						timestamp: now,
					},
				},
				payloadStore,
				payloadSeq: payloadSeqRef.value,
				nodeReadCursors: nextCursors,
				traceSeq,
				stateRevision: (state.stateRevision ?? 0) + 1,
				updatedAt: now,
			};
			return {
				ok: true,
				state: nextState,
				effects: [buildOrchestrationDispatchEffect({
					state: nextState,
					graph,
					staffIndex,
					whiteboards,
					config,
					targetNode: primaryTarget,
					token: updatedParent,
					holderAgentId: targetAgentId,
					taskGraph: params.taskGraph,
					rawTaskStatuses: params.taskStatuses,
				})],
				data: {
					rejectedTokenId: token.id,
					bouncedTokenId: existingActiveParent.id,
					nextTokenIds: [existingActiveParent.id],
					targetNodeId: targetId,
					targetNodeIds: [targetId],
					mode: 'upward_reject',
					...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
					...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
				},
			};
		}
	}

	// Mode 3: Peer Review Bounce (or direct upward bounce when no active parent / waiting barrier matched)
	const validOutgoing = new Set(staffIndex.outgoingStaffByNode.get(token.nodeId) ?? []);
	for (const tid of targetIds) {
		const targetNode = staffById.get(tid)!;
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		const isDirectOrigin = token.returnToNodeId === tid || token.originNodeId === tid || token.fromNodeId === tid;
		if (holderTier !== undefined && targetTier !== undefined && targetTier < holderTier) {
			if (!isDirectOrigin && !(validOutgoing.has(tid) && hasDownwardLineageFrom(token, tid))) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'UPWARD_TOKEN_FORBIDDEN',
					error: `UPWARD_TOKEN_FORBIDDEN: subordinate "${token.nodeId}" (L${holderTier}) cannot reject token "${token.id}" upward to superior "${tid}" (L${targetTier}) without direct dispatch lineage or edge.`,
				};
			}
		}
		const canBounce = validOutgoing.has(tid) || isDirectOrigin;
		if (!canBounce) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'NO_EDGE',
				error: `No directed edge or prior baton lineage from "${token.nodeId}" to "${tid}" in Orchestration graph.`,
			};
		}
	}

	let tokenSeq = state.tokenSeq;
	let traceSeq = state.traceSeq + 1;
	const bounceTracePtr = `otrc-${traceSeq}`;
	const allocated = targetIds.map(tid => {
		tokenSeq += 1;
		traceSeq += 1;
		return {
			targetId: tid,
			bouncedTokenId: `otok-${tokenSeq}`,
			arriveTracePtr: `otrc-${traceSeq}`,
		};
	});
	const nextTokenIds = allocated.map(a => a.bouncedTokenId);
	const waitingBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
	const forwardedBarrierId = waitingBarrier && waitingBarrier.status === 'waiting' ? waitingBarrier.id : undefined;
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> | undefined = forwardedBarrierId && state.joinBarriers
		? {
			...state.joinBarriers,
			[forwardedBarrierId]: {
				...waitingBarrier!,
				childTokenIds: waitingBarrier!.childTokenIds.flatMap(cid => cid === token.id ? nextTokenIds : [cid]),
			},
		}
		: state.joinBarriers;

	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'handed_off',
			blocked: undefined,
			rejectionReason: reason,
			lastActivityAt: now,
			handedOffToNodeIds: targetIds,
		},
	};
	const nextTraces: Record<string, IMissionTraceNode> = {
		...state.traces,
		[bounceTracePtr]: {
			ptr: bounceTracePtr,
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: token.holderAgentId,
			waveId: token.waveId,
			event: 'reject_bounce',
			summary: `Reject -> [${targetIds.join(', ')}]: ${staged.headline}`,
			timestamp: now,
		},
	};
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
		...state.nodeStates,
		[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
	};
	const spawned: { readonly targetId: string; readonly tok: IOrchestrationToken; readonly targetAgentId?: string }[] = [];
	for (const { targetId, bouncedTokenId, arriveTracePtr } of allocated) {
		const targetNode = staffById.get(targetId)!;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const hopEntry: IOrchestrationHopLedgerEntry = {
			hop: nextHopIndex,
			tokenId: bouncedTokenId,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: 'reject',
			headline: staged.headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			timestamp: now,
		};
		const bounceAttempt = (token.attemptNumber ?? 1) + 1;
		const bounceReworkHistory = appendReworkMemory(token.reworkHistory, {
			attempt: bounceAttempt,
			kind: 'reject',
			byNodeId: token.nodeId,
			...(params.category ? { category: params.category } : {}),
			summary: buildCompactHeadline(reason).headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			timestamp: now,
		});
		const bounceTaskBinding = explicitRejectTaskIds.length > 0
			? normalizeBoundTaskIds(params.taskNodeId, params.taskNodeIds)
			: normalizeBoundTaskIds(token.taskNodeId, token.taskNodeIds);
		const bouncedToken: IOrchestrationToken = {
			id: bouncedTokenId,
			waveId: token.waveId,
			nodeId: targetId,
			fromNodeId: token.nodeId,
			holderAgentId: targetAgentId,
			status: 'active',
			parentTokenId: token.id,
			rootTokenId: token.rootTokenId ?? token.id,
			originNodeId: token.originNodeId ?? token.nodeId,
			...(forwardedBarrierId
				? { parentJoinBarrierId: forwardedBarrierId, returnToNodeId: token.returnToNodeId ?? waitingBarrier!.ownerNodeId }
				: (!isUpwardSingle && token.returnToNodeId ? { returnToNodeId: token.returnToNodeId } : {})),
			dispatchKind: 'reject',
			rejectionReason: reason,
			attemptNumber: bounceAttempt,
			...(params.category ? { reworkCategory: params.category } : {}),
			reworkHistory: bounceReworkHistory,
			...(token.scopePaths && token.scopePaths.length > 0 ? { scopePaths: token.scopePaths } : {}),
			...bounceTaskBinding,
			hopIndex: nextHopIndex,
			relayDepth: nextRelayDepth,
			edgeBounceCounts: incrementEdgeBounceCounts(token.edgeBounceCounts, token.nodeId, targetId),
			lastSummary: staged.headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			hopLog: [...baseHopLog, hopEntry],
			contextRefs: staged.contextRefs,
			compressedHistory: '',
			tracePtr: arriveTracePtr,
			...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
			arrivedAt: now,
			lastActivityAt: now,
			nudgeCount: 0,
		};
		nextTokens[bouncedTokenId] = bouncedToken;
		nextTraces[arriveTracePtr] = {
			ptr: arriveTracePtr,
			parentPtrs: [bounceTracePtr],
			nodeId: targetId,
			employeeId: targetAgentId,
			waveId: token.waveId,
			event: 'reject_bounce',
			summary: staged.headline,
			timestamp: now,
		};
		nextNodeStates[targetId] = recomputeOrchestrationNodeState(nextTokens, targetId);
		spawned.push({ targetId, tok: bouncedToken, targetAgentId });
	}
	const observedHopIds = [
		...baseHopLog.map(h => buildHopKey(h)),
		...allocated.map(a => `${a.bouncedTokenId}:${nextHopIndex}`),
	];
	const nextCursors = recordNodeCursorObservation(
		state.nodeReadCursors,
		token.waveId,
		token.nodeId,
		nextHopIndex,
		staged.allObservedRefs,
		now,
		observedHopIds,
	);
	const nextState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: nextTraces,
		...(nextBarriers ? { joinBarriers: nextBarriers } : {}),
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		nodeReadCursors: nextCursors,
		tokenSeq,
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};
	const syncedTaskStatuses = params.taskGraph && !params.taskGraph.error
		? syncMissionTaskStatusesFromOrchestration(params.taskStatuses, params.taskGraph, nextState, graph).taskStatuses
		: params.taskStatuses;
	return {
		ok: true,
		state: nextState,
		effects: spawned.map(s => buildOrchestrationDispatchEffect({
			state: nextState,
			graph,
			staffIndex,
			whiteboards,
			config,
			targetNode: staffById.get(s.targetId)!,
			token: s.tok,
			holderAgentId: s.targetAgentId,
			taskGraph: params.taskGraph,
			syncedTaskStatuses,
		})),
		data: {
			rejectedTokenId: token.id,
			bouncedTokenId: nextTokenIds[0],
			nextTokenIds,
			targetNodeId: targetIds[0],
			targetNodeIds: targetIds,
			mode: isUpwardSingle ? 'upward_reject' : 'peer_bounce',
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
		},
	};
}

/**
 * First-class Orchestration token retry (`token retry`):
 * - Checks `maxHops` cleanly WITHOUT mutating already-terminal `origToken` or double-settling barriers.
 * - Marks `origToken.supersededByTokenId = retryTokenId` and skips superseded tokens on `--node` lookup.
 * - Updates parent `childTokenIds`, re-attaches to waiting barriers, and supports optional `waitJoin`.
 */
export function retryOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId?: string;
		readonly nodeId?: string;
		readonly guidance?: string;
		readonly category?: OrchestrationReworkCategory;
		readonly waitJoin?: boolean;
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly caller?: {
			readonly isHumanUser?: boolean;
			readonly isSecretary?: boolean;
			readonly callerTier?: number;
			readonly callerNodeId?: string;
			readonly callerAgentId?: string;
		};
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly retriedFromTokenId: string;
	readonly tokenId: string;
	readonly nodeId: string;
	readonly joinBarrierId?: string;
	readonly payloadPtr?: string;
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'retry tokens') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before retrying tokens.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}

	const retryableStatuses = new Set<OrchestrationTokenStatus>(['failed', 'aborted', 'reclaimed']);
	let origToken: IOrchestrationToken | undefined;
	if (params.tokenId?.trim()) {
		origToken = state.tokens[params.tokenId.trim()];
		if (!origToken) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Orchestration token "${params.tokenId.trim()}" not found.` };
		}
		if (!retryableStatuses.has(origToken.status)) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Orchestration token "${origToken.id}" is "${origToken.status}" and cannot be retried (only failed, aborted, or reclaimed tokens can be retried).`,
			};
		}
		if (origToken.supersededByTokenId) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Orchestration token "${origToken.id}" was already retried and superseded by "${origToken.supersededByTokenId}". Retry "${origToken.supersededByTokenId}" instead if needed.`,
			};
		}
	} else if (params.nodeId?.trim()) {
		const targetNodeId = params.nodeId.trim();
		const candidates = Object.values(state.tokens)
			.filter(t => t.nodeId === targetNodeId && retryableStatuses.has(t.status) && !t.supersededByTokenId)
			.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
		origToken = candidates[0];
		if (!origToken) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'NOT_FOUND',
				error: `No active retryable (failed, aborted, or reclaimed) Orchestration token found on staff node "${targetNodeId}".`,
			};
		}
	} else {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Either --token <tokenId> or --node <nodeId> is required for token.retry.' };
	}

	const staffIndex = buildStaffGraphIndex(graph);
	const targetNode = staffIndex.staffById.get(origToken.nodeId);
	if (!targetNode) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Staff node "${origToken.nodeId}" no longer exists on Orchestration canvas.` };
	}

	// Enforce retry authorization
	if (params.caller && !params.caller.isHumanUser && !params.caller.isSecretary) {
		const highest = getHighestRankInSchema(config);
		const callerNode = params.caller.callerNodeId ? staffIndex.staffById.get(params.caller.callerNodeId) : undefined;
		const callerTier = params.caller.callerTier ?? resolveEffectiveStaffTier(callerNode, config);
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		const isTop = callerTier !== undefined && highest ? callerTier <= highest.tier : false;
		const isOrigin = Boolean(params.caller.callerNodeId && (origToken.originNodeId === params.caller.callerNodeId || origToken.returnToNodeId === params.caller.callerNodeId));
		const callerDept = callerNode?.department?.trim();
		const targetDept = targetNode.department?.trim();
		const isDeptSuperior = Boolean(
			callerTier !== undefined
			&& targetTier !== undefined
			&& callerTier < targetTier
			&& (!targetDept || (callerDept && callerDept.toLowerCase() === targetDept.toLowerCase())),
		);
		if (!isTop && !isOrigin && !isDeptSuperior) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'FORBIDDEN',
				error: `FORBIDDEN: caller cannot retry token "${origToken.id}" on staff node "${origToken.nodeId}". Only Human (L-1), Secretary (L0), top-rank leader, or a superior in scope may retry.`,
			};
		}
	}

	const now = params.now ?? Date.now();
	const prevHopIndex = origToken.hopIndex ?? Math.max(0, (origToken.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const nextRelayDepth = (origToken.relayDepth ?? prevHopIndex) + 1;
	const effectiveMaxHops = state.maxHops !== undefined && Number.isFinite(state.maxHops) && state.maxHops >= 1
		? Math.floor(state.maxHops)
		: DEFAULT_ORCHESTRATION_MAX_HOPS;
	// Check maxHops cleanly WITHOUT mutating already-terminal `origToken` or double-settling barriers!
	if (nextRelayDepth > effectiveMaxHops) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'MAX_HOPS_EXCEEDED',
			error: `MAX_HOPS_EXCEEDED: retrying token "${origToken.id}" on "${origToken.nodeId}" would reach relay hop #${nextRelayDepth}, exceeding ceiling (${effectiveMaxHops}). Raise maxHops before retrying.`,
		};
	}

	const tokenSeq = state.tokenSeq + 1;
	const traceSeq = state.traceSeq + 1;
	const retryTokenId = `otok-${tokenSeq}`;
	const retryTracePtr = `otrc-${traceSeq}`;
	const guidance = params.guidance?.trim();
	const rawSummary = guidance ? `[RETRY] ${guidance}` : `[RETRY] ${origToken.lastSummary}`;
	const { headline, wasTruncated } = buildCompactHeadline(rawSummary);
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const refMap = new Map<string, IOrchestrationContextRef>();
	for (const r of refreshContextRefsWithLiveWhiteboards(origToken.contextRefs, whiteboards, origToken.whiteboardPointers, nextHopIndex)) {
		refMap.set(r.ptr, r);
	}
	let payloadPtr = origToken.payloadPtr;
	if (guidance && (wasTruncated || guidance.length > ORCHESTRATION_TOKEN_HEADLINE_MAX_CHARS)) {
		const retryRef = storeOrReuseContextBlob(
			payloadStore,
			payloadSeqRef,
			{
				kind: 'handoff',
				title: `Retry #${nextHopIndex} Guidance for ${origToken.nodeId}`,
				content: guidance,
				authorNodeId: params.caller?.callerNodeId ?? 'User',
				authorAgentId: params.caller?.callerAgentId,
				hop: nextHopIndex,
				waveId: origToken.waveId,
				now,
			},
			state.externalizedBlobIndex,
		);
		payloadPtr = retryRef.ptr;
	}

	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[origToken.id]: {
			...origToken,
			supersededByTokenId: retryTokenId,
		},
	};
	const touchedNodes = new Set<string>([origToken.nodeId]);
	let barrierSeq = state.barrierSeq ?? 0;
	let nextBarriers = state.joinBarriers ? { ...state.joinBarriers } : undefined;
	const origBarrier = origToken.parentJoinBarrierId ? state.joinBarriers?.[origToken.parentJoinBarrierId] : undefined;
	let attachedBarrierId = origBarrier && origBarrier.status === 'waiting' ? origBarrier.id : undefined;

	if (attachedBarrierId && origBarrier && nextBarriers) {
		const nextSettled = { ...origBarrier.settledChildren };
		delete nextSettled[origToken.id];
		nextBarriers[attachedBarrierId] = {
			...origBarrier,
			childTokenIds: origBarrier.childTokenIds.map(cid => cid === origToken!.id ? retryTokenId : cid),
			settledChildren: nextSettled,
		};
	}

	// Update parent's `childTokenIds` and optionally create a new waiting join barrier if `params.waitJoin === true`
	if (origToken.parentTokenId && nextTokens[origToken.parentTokenId]) {
		const parentTok = nextTokens[origToken.parentTokenId];
		let updatedParent: IOrchestrationToken = {
			...parentTok,
			childTokenIds: [...(parentTok.childTokenIds ?? []), retryTokenId],
			lastActivityAt: now,
		};
		if (!attachedBarrierId && params.waitJoin && (parentTok.status === 'active' || parentTok.status === 'blocked')) {
			barrierSeq += 1;
			attachedBarrierId = `bar-${barrierSeq}`;
			nextBarriers ??= {};
			nextBarriers[attachedBarrierId] = {
				id: attachedBarrierId,
				waveId: parentTok.waveId,
				parentTokenId: parentTok.id,
				ownerNodeId: parentTok.nodeId,
				childTokenIds: [retryTokenId],
				mode: 'all',
				status: 'waiting',
				settledChildren: {},
				createdAt: now,
			};
			updatedParent = {
				...updatedParent,
				status: 'waiting_join',
				blocked: undefined,
				joinBarrierId: attachedBarrierId,
			};
			touchedNodes.add(parentTok.nodeId);
		}
		nextTokens[parentTok.id] = updatedParent;
	}

	const targetAgentId = state.nodeAgentIds[origToken.nodeId] ?? targetNode.agentId;
	const fromNodeId = params.caller?.callerNodeId ?? origToken.originNodeId ?? origToken.fromNodeId;
	const retryHop: IOrchestrationHopLedgerEntry = {
		hop: nextHopIndex,
		tokenId: retryTokenId,
		...(fromNodeId && fromNodeId !== 'User' ? { fromNodeId } : {}),
		toNodeId: origToken.nodeId,
		event: 'retry',
		headline,
		...(payloadPtr ? { payloadPtr } : {}),
		timestamp: now,
	};
	const retryAttempt = (origToken.attemptNumber ?? 1) + 1;
	const retryCategory = params.category ?? origToken.reworkCategory;
	const retryMemorySummary = origToken.failureReason
		? `Prior failure: ${origToken.failureReason}${guidance ? ` | Guidance: ${guidance}` : ''}`
		: (guidance || origToken.lastSummary);
	const retryReworkHistory = appendReworkMemory(origToken.reworkHistory, {
		attempt: retryAttempt,
		kind: 'retry',
		byNodeId: params.caller?.callerNodeId ?? 'User',
		...(retryCategory ? { category: retryCategory } : {}),
		summary: buildCompactHeadline(retryMemorySummary).headline,
		...(payloadPtr ? { payloadPtr } : {}),
		timestamp: now,
	});
	const retryToken: IOrchestrationToken = {
		id: retryTokenId,
		waveId: origToken.waveId,
		nodeId: origToken.nodeId,
		...(fromNodeId && fromNodeId !== 'User' ? { fromNodeId } : {}),
		holderAgentId: targetAgentId,
		status: 'active',
		parentTokenId: origToken.parentTokenId,
		rootTokenId: origToken.rootTokenId ?? retryTokenId,
		originNodeId: origToken.originNodeId,
		...(origToken.returnToNodeId ? { returnToNodeId: origToken.returnToNodeId } : {}),
		...(attachedBarrierId ? { parentJoinBarrierId: attachedBarrierId } : {}),
		dispatchKind: 'retry',
		attemptNumber: retryAttempt,
		...(retryCategory ? { reworkCategory: retryCategory } : {}),
		reworkHistory: retryReworkHistory,
		...(origToken.scopePaths && origToken.scopePaths.length > 0 ? { scopePaths: origToken.scopePaths } : {}),
		...(origToken.taskNodeId ? { taskNodeId: origToken.taskNodeId } : {}),
		...(origToken.taskNodeIds ? { taskNodeIds: origToken.taskNodeIds } : {}),
		hopIndex: nextHopIndex,
		relayDepth: nextRelayDepth,
		...(origToken.edgeBounceCounts ? { edgeBounceCounts: origToken.edgeBounceCounts } : {}),
		lastSummary: headline,
		...(payloadPtr ? { payloadPtr } : {}),
		hopLog: [...(origToken.hopLog ?? []), retryHop],
		contextRefs: [...refMap.values()],
		compressedHistory: '',
		tracePtr: retryTracePtr,
		...(origToken.whiteboardPointers ? { whiteboardPointers: origToken.whiteboardPointers } : {}),
		arrivedAt: now,
		lastActivityAt: now,
		nudgeCount: 0,
	};

	nextTokens[retryTokenId] = retryToken;
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
	for (const nid of touchedNodes) {
		nextNodeStates[nid] = recomputeOrchestrationNodeState(nextTokens, nid);
	}
	const nextState: IOrchestrationRuntimeState = {
		...state,
		status: 'running',
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		...(nextBarriers ? { joinBarriers: nextBarriers } : {}),
		barrierSeq,
		traces: {
			...state.traces,
			[retryTracePtr]: {
				ptr: retryTracePtr,
				parentPtrs: [origToken.tracePtr],
				nodeId: origToken.nodeId,
				employeeId: targetAgentId,
				waveId: origToken.waveId,
				event: 'retry',
				summary: `Retry ${origToken.id} -> ${retryTokenId}: ${headline}`,
				timestamp: now,
			},
		},
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		tokenSeq,
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};

	return {
		ok: true,
		state: nextState,
		effects: [buildOrchestrationDispatchEffect({
			state: nextState,
			graph,
			staffIndex,
			whiteboards,
			config,
			targetNode,
			token: retryToken,
			holderAgentId: targetAgentId,
			taskGraph: params.taskGraph,
			rawTaskStatuses: params.taskStatuses,
		})],
		data: {
			retriedFromTokenId: origToken.id,
			tokenId: retryTokenId,
			nodeId: targetNode.id,
			...(attachedBarrierId ? { joinBarrierId: attachedBarrierId } : {}),
			...(payloadPtr ? { payloadPtr } : {}),
		},
	};
}
