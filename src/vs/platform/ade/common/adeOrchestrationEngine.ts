/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure Engineering Dual-View Runtime Engine:
 * 1. Mission View (Task DAG): strictly acyclic task status tracking where ONLY authorized
 *    completers (highest-rank role, owner, minCompleterTier, superior, or Human User) may
 *    mark qualifying task nodes as "completed".
 * 2. Orchestration View (All-Staff Cyclic Collaboration):
 *    - Zero off-graph wall: ALL staff tiers enter the same canvas.
 *    - Strict employee uniqueness: 1 node === 1 employee; employees are NEVER destroyed
 *      after handing off a token and are seamlessly re-woken on future token arrivals (cycles!).
 *    - Token relay-baton handoff (`handoff` / `mint` / `return` / `complete` / `dispatch`) supporting
 *      1-to-N fan-out, bidirectional collaboration, nested join barriers (`all` / `any` / `quorum`),
 *      and cyclic re-entry with delta views.
 *    - Loop-vs-fanout separation (`relayDepth` + `edgeBounceCounts`) so wide fan-outs never falsely
 *      trip `MAX_HOPS_EXCEEDED` while genuine relay cycles trip deterministically.
 */

import { IMissionDagParseResult } from './adeMissionDag.js';
import { IMissionTraceNode } from './adeMissionEngine.js';
import { normalizeNonCachedInputTokens } from './adeModelPricing.js';
import {
	IOrchestrationGraphNode,
	IOrchestrationGraphParseResult,
	parseOrchestrationGraph,
} from './adeOrchestrationGraph.js';
import {
	areScopePatternsSubsetOfAllowed,
	assertOrchestrationTokenHolder,
	buildOrchestrationDispatchEffect,
	buildPayloadDigestIndex,
	buildStaffGraphIndex,
	computeJoinBarrierFileConflicts,
	detectScopePathsOverlap,
	findActiveAncestorTokenOnNode,
	findHighestRankStaffNode,
	findWaitingJoinAncestorTokenOnNode,
	formatBudgetExceededError,
	hasDownwardLineageFrom,
	incrementEdgeBounceCounts,
	isOrchestrationBudgetTripped,
	normalizeBoundTaskIds,
	normalizeRepoRelativePath,
	recomputeOrchestrationNodeState,
	stageTransitionContext,
	storeOrReuseContextBlob,
	validateScopedPaths,
} from './adeOrchestrationPipeline.js';
import {
	syncMissionTaskStatusesFromOrchestration,
	validateTokenTaskBindings,
} from './adeOrchestrationTasks.js';
import {
	buildCompactHeadline,
	buildHopKey,
	DEFAULT_ORCHESTRATION_MAX_HOPS,
	getHighestRankInSchema,
	IMissionTaskStatusRecord,
	IOrchestrationContextBlob,
	IOrchestrationContextBlobInput,
	IOrchestrationContextRef,
	IOrchestrationFinOpsTelemetry,
	IOrchestrationHopLedgerEntry,
	IOrchestrationJoinBarrier,
	IOrchestrationJoinBarrierChildResult,
	IOrchestrationMintBranch,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationTransitionResult,
	IOrchestrationWhiteboard,
	IOrchestrationWhiteboardPointer,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
	OrchestrationNodeRuntimeStatus,
	OrchestrationScopeConflictPolicy,
	recordNodeCursorObservation,
	refreshContextRefsWithLiveWhiteboards,
	resolveEffectiveStaffTier,
} from './adeOrchestrationTypes.js';
import { validateTokenWhiteboardAttachments } from './adeOrchestrationWhiteboards.js';
import { IAdeOrganizationConfig } from './adeRoleSchema.js';

export * from './adeOrchestrationTypes.js';
export * from './adeOrchestrationTasks.js';
export * from './adeOrchestrationWhiteboards.js';
export * from './adeOrchestrationStaffPlans.js';
export * from './adeOrchestrationArchive.js';
export * from './adeOrchestrationPipeline.js';
export * from './adeOrchestrationCheckpoints.js';
export * from './adeOrchestrationDiagnostics.js';

export function createInitialOrchestrationRuntimeState(
	missionId: string,
	staffNodeIds: readonly string[] = [],
	now = Date.now(),
): IOrchestrationRuntimeState {
	const nodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {};
	for (const id of staffNodeIds) {
		nodeStates[id] = 'idle';
	}
	return {
		missionId,
		status: 'running',
		silenceReminderMinutes: ORCHESTRATION_SILENCE_REMINDER_MINUTES,
		nodeStates,
		nodeAgentIds: {},
		tokens: {},
		traces: {},
		joinBarriers: {},
		barrierSeq: 0,
		payloadStore: {},
		payloadSeq: 0,
		externalizedBlobIndex: {},
		archivedTokenCount: 0,
		archivedTraceCount: 0,
		nodeReadCursors: {},
		tokenSeq: 0,
		waveSeq: 0,
		traceSeq: 0,
		stateRevision: 0,
		updatedAt: now,
	};
}

export function hasActiveOrchestrationTokens(state: IOrchestrationRuntimeState | undefined): boolean {
	if (!state) {
		return false;
	}
	return Object.values(state.tokens).some(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
}

/**
 * Configures Orchestration fault-tolerance guardrails (`maxHops` cycle circuit-breaker and
 * `budgetLimitUsd` / `totalCostUsd` FinOps hard circuit-breaker).
 * - Keeps `totalCostUsd` monotonic (`Math.max`) so spend cannot be silently decreased.
 * - Never resurrects `status: 'aborted'` back to `'paused'`.
 * - Automatically latches `budgetCircuitTripped: true` when spend reaches ceiling and unlatches when raised/cleared.
 */
export function setOrchestrationGuardrails(
	state: IOrchestrationRuntimeState,
	params: {
		readonly maxHops?: number | null;
		readonly budgetLimitUsd?: number | null;
		readonly totalCostUsd?: number;
		readonly now?: number;
	},
): {
	readonly state: IOrchestrationRuntimeState;
	readonly budgetTrippedNow: boolean;
} {
	const now = params.now ?? Date.now();
	const nextMaxHops = params.maxHops === null
		? undefined
		: (params.maxHops !== undefined && Number.isFinite(params.maxHops)
			? Math.max(1, Math.min(10_000, Math.floor(params.maxHops)))
			: state.maxHops);
	const nextBudgetLimitUsd = params.budgetLimitUsd === null
		? undefined
		: (params.budgetLimitUsd !== undefined && Number.isFinite(params.budgetLimitUsd) && params.budgetLimitUsd > 0
			? params.budgetLimitUsd
			: state.budgetLimitUsd);
	const prevCost = state.totalCostUsd ?? 0;
	const nextTotalCostUsd = params.totalCostUsd !== undefined && Number.isFinite(params.totalCostUsd) && params.totalCostUsd >= 0
		? Math.max(prevCost, params.totalCostUsd)
		: prevCost;

	const shouldTrip = nextBudgetLimitUsd !== undefined && nextTotalCostUsd >= nextBudgetLimitUsd;
	const wasTripped = Boolean(state.budgetCircuitTripped);
	const budgetTrippedNow = shouldTrip && !wasTripped;
	const isAborted = state.status === 'aborted';
	const budgetReason = shouldTrip
		? `BUDGET_EXCEEDED: Orchestration paused after spending $${nextTotalCostUsd.toFixed(4)} against $${nextBudgetLimitUsd!.toFixed(2)} budget ceiling.`
		: undefined;
	const nextPausedReason = shouldTrip && !isAborted
		? budgetReason
		: (state.pausedReason?.startsWith('BUDGET_EXCEEDED:') ? undefined : state.pausedReason);

	return {
		state: {
			...state,
			...(nextMaxHops !== undefined ? { maxHops: nextMaxHops } : { maxHops: undefined }),
			...(nextBudgetLimitUsd !== undefined ? { budgetLimitUsd: nextBudgetLimitUsd } : { budgetLimitUsd: undefined }),
			...(nextTotalCostUsd > 0 || state.totalCostUsd !== undefined ? { totalCostUsd: nextTotalCostUsd } : {}),
			budgetCircuitTripped: shouldTrip ? true : undefined,
			...(shouldTrip && !isAborted ? { status: 'paused' as const, pausedAt: state.pausedAt ?? now } : {}),
			...(nextPausedReason ? { pausedReason: nextPausedReason } : { pausedReason: undefined }),
			stateRevision: (state.stateRevision ?? 0) + 1,
			updatedAt: now,
		},
		budgetTrippedNow,
	};
}

/**
 * Pure FinOps telemetry recorder for Orchestration token turns:
 * - Normalizes inclusive provider `inputTokens` (OpenAI/Codex/Gemini/DeepSeek) so cached reads are never double-counted.
 * - Accumulates `finOpsTelemetry` (`totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`,
 *   `totalCacheWriteTokens`, `cacheHitRatePct`, optional `reworkTokens`) and optionally advances monotonic
 *   `totalCostUsd` + `budgetCircuitTripped`.
 */
export function recordOrchestrationFinOpsUsage(
	state: IOrchestrationRuntimeState,
	usage: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly cacheReadTokens?: number;
		readonly cacheWriteTokens?: number;
		readonly totalTokens?: number;
		readonly costUsd?: number;
		readonly isRework?: boolean;
		readonly model?: string;
		readonly engineId?: string;
		readonly now?: number;
	},
): {
	readonly state: IOrchestrationRuntimeState;
	readonly telemetry: IOrchestrationFinOpsTelemetry;
	readonly budgetTrippedNow: boolean;
} {
	const now = usage.now ?? Date.now();
	const rawIn = Math.max(0, Number.isFinite(usage.inputTokens) ? Math.floor(usage.inputTokens!) : 0);
	const rawOut = Math.max(0, Number.isFinite(usage.outputTokens) ? Math.floor(usage.outputTokens!) : 0);
	const rawCacheRead = Math.max(0, Number.isFinite(usage.cacheReadTokens) ? Math.floor(usage.cacheReadTokens!) : 0);
	const rawCacheWrite = Math.max(0, Number.isFinite(usage.cacheWriteTokens) ? Math.floor(usage.cacheWriteTokens!) : 0);
	const norm = normalizeNonCachedInputTokens({
		inputTokens: rawIn,
		outputTokens: rawOut,
		cacheReadTokens: rawCacheRead,
		cacheWriteTokens: rawCacheWrite,
		totalTokens: usage.totalTokens,
		model: usage.model,
		engineId: usage.engineId,
	});
	const nonCachedIn = norm.inputTokens;
	const prev = state.finOpsTelemetry;
	const totalInputTokens = (prev?.totalInputTokens ?? 0) + nonCachedIn;
	const totalOutputTokens = (prev?.totalOutputTokens ?? 0) + rawOut;
	const totalCacheReadTokens = (prev?.totalCacheReadTokens ?? 0) + rawCacheRead;
	const totalCacheWriteTokens = (prev?.totalCacheWriteTokens ?? 0) + rawCacheWrite;
	const turnTotalTokens = nonCachedIn + rawOut + rawCacheRead + rawCacheWrite;
	const reworkTokens = (prev?.reworkTokens ?? 0) + (usage.isRework ? turnTotalTokens : 0);
	const cacheDenom = totalInputTokens + totalCacheReadTokens;
	const cacheHitRatePct = cacheDenom > 0 ? Math.round((totalCacheReadTokens / cacheDenom) * 1000) / 10 : 0;
	const telemetry: IOrchestrationFinOpsTelemetry = {
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCacheWriteTokens,
		cacheHitRatePct,
		...(reworkTokens > 0 ? { reworkTokens } : {}),
		updatedAt: now,
	};

	const addedCost = usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd > 0 ? usage.costUsd : 0;
	if (addedCost > 0) {
		const nextCost = (state.totalCostUsd ?? 0) + addedCost;
		const guard = setOrchestrationGuardrails({ ...state, finOpsTelemetry: telemetry }, { totalCostUsd: nextCost, now });
		return { state: guard.state, telemetry, budgetTrippedNow: guard.budgetTrippedNow };
	}

	return {
		state: {
			...state,
			finOpsTelemetry: telemetry,
			stateRevision: (state.stateRevision ?? 0) + 1,
			updatedAt: now,
		},
		telemetry,
		budgetTrippedNow: false,
	};
}

export function checkAndTripOrchestrationMaxHops<T = unknown>(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	token: IOrchestrationToken,
	nextRelayDepth: number,
	actionLabel: string,
	now: number,
): { readonly tripped: false } | { readonly tripped: true; readonly result: IOrchestrationTransitionResult<T> } {
	const effectiveMaxHops = state.maxHops !== undefined && Number.isFinite(state.maxHops) && state.maxHops >= 1
		? Math.floor(state.maxHops)
		: DEFAULT_ORCHESTRATION_MAX_HOPS;
	if (nextRelayDepth <= effectiveMaxHops) {
		return { tripped: false };
	}
	const nextHopIndex = (token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1)) + 1;
	const reason = `MAX_HOPS_EXCEEDED: baton "${token.id}" on "${token.nodeId}" reached relay hop #${nextRelayDepth} during ${actionLabel}, exceeding cycle circuit-breaker ceiling (${effectiveMaxHops} hops).`;
	const traceSeq = state.traceSeq + 1;
	const tripTracePtr = `otrc-${traceSeq}`;
	const headline = buildCompactHeadline(reason).headline;
	const trippedToken: IOrchestrationToken = {
		...token,
		status: 'failed',
		blocked: undefined,
		failureReason: reason,
		hopIndex: nextHopIndex,
		relayDepth: nextRelayDepth,
		lastSummary: headline,
		hopLog: [...(token.hopLog ?? []), {
			hop: nextHopIndex,
			tokenId: token.id,
			fromNodeId: token.nodeId,
			toNodeId: token.nodeId,
			event: 'fail',
			headline,
			timestamp: now,
		}],
		lastActivityAt: now,
	};
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: trippedToken,
	};
	const preBarrierState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
		},
		traces: {
			...state.traces,
			[tripTracePtr]: {
				ptr: tripTracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'fail_escalate',
				summary: headline,
				timestamp: now,
			},
		},
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};
	const settled = settleJoinBarrierIfApplicable(preBarrierState, graph, whiteboards, config, {
		childToken: trippedToken,
		outcome: 'failed',
		summary: `CYCLE BREAKER: ${headline}`,
		now,
	});
	const effects: OrchestrationEngineEffect[] = [
		...settled.effects,
		{
			kind: 'post_inbox',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			title: `Orchestration Cycle Circuit-Breaker Tripped (${token.nodeId})`,
			message: `${reason} Token "${token.id}" was frozen as failed to stop an infinite relay cycle. Inspect \`token history ${token.id}\` or raise \`maxHops\` before retrying.`,
			severity: 'critical',
			senderAgentId: token.holderAgentId,
		},
	];
	return {
		tripped: true,
		result: {
			ok: false,
			state: settled.state,
			effects,
			code: 'MAX_HOPS_EXCEEDED',
			error: reason,
		},
	};
}

/**
 * Dispatches a top-level requirement from the User to the highest-rank role on the Orchestration canvas
 * (or an explicitly targeted staff node).
 */
export function dispatchRequirementToOrchestration(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly prompt: string;
		readonly detail?: string;
		readonly targetNodeId?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{ readonly tokenId: string; readonly targetNodeId: string; readonly payloadPtr?: string }> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'dispatch new requirements') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before dispatching new requirements.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	const promptText = params.prompt.trim();
	if (!promptText) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Requirement prompt is required.' };
	}
	const staffIndex = buildStaffGraphIndex(graph);
	const targetNode = params.targetNodeId
		? staffIndex.staffById.get(params.targetNodeId)
		: findHighestRankStaffNode(graph);
	if (!targetNode) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NOT_FOUND',
			error: params.targetNodeId
				? `Staff node "${params.targetNodeId}" not found on Orchestration canvas.`
				: 'No staff nodes exist on the Orchestration canvas.',
		};
	}
	const wbCheck = validateTokenWhiteboardAttachments(graph, whiteboards, config, { isHumanUser: true, state }, params.whiteboardIds, params.refPtrs);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}
	const explicitTaskIds = [...new Set([
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	const taskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitTaskIds);
	if (!taskCheck.ok) {
		return { ok: false, state, effects: [], code: taskCheck.code ?? 'INVALID_STATE', error: taskCheck.error };
	}

	const now = params.now ?? Date.now();
	const nextWaveSeq = state.waveSeq + 1;
	const nextTokenSeq = state.tokenSeq + 1;
	const nextTraceSeq = state.traceSeq + 1;
	const waveId = `wave-${nextWaveSeq}`;
	const tokenId = `otok-${nextTokenSeq}`;
	const tracePtr = `otrc-${nextTraceSeq}`;
	const holderAgentId = state.nodeAgentIds[targetNode.id] ?? targetNode.agentId;

	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const staged = stageTransitionContext({
		payloadStore,
		payloadSeqRef,
		externalizedBlobIndex: state.externalizedBlobIndex,
		whiteboards,
		summary: promptText,
		detail: params.detail,
		detailTitle: `Hop #0 Dispatch → ${targetNode.id}`,
		authorNodeId: 'User',
		hop: 0,
		waveId,
		now,
		artifacts: params.artifacts,
		decisions: params.decisions,
		refPtrs: params.refPtrs,
		normalizedWhiteboardIds: wbCheck.normalizedIds,
		defaultArtifactTitle: 'Artifact',
		defaultDecisionTitle: 'Decision',
	});

	const hopEntry: IOrchestrationHopLedgerEntry = {
		hop: 0,
		tokenId,
		toNodeId: targetNode.id,
		event: 'dispatch',
		headline: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
		timestamp: now,
	};

	const boundTaskFields = normalizeBoundTaskIds(params.taskNodeId, params.taskNodeIds);
	const token: IOrchestrationToken = {
		id: tokenId,
		waveId,
		nodeId: targetNode.id,
		holderAgentId,
		status: 'active',
		rootTokenId: tokenId,
		originNodeId: 'User',
		dispatchKind: 'dispatch',
		...boundTaskFields,
		hopIndex: 0,
		relayDepth: 0,
		lastSummary: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		hopLog: [hopEntry],
		contextRefs: staged.contextRefs,
		compressedHistory: '',
		tracePtr,
		...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
		arrivedAt: now,
		lastActivityAt: now,
		nudgeCount: 0,
	};

	const trace: IMissionTraceNode = {
		ptr: tracePtr,
		parentPtrs: [],
		nodeId: targetNode.id,
		employeeId: holderAgentId,
		waveId,
		event: 'mint',
		summary: staged.headline,
		timestamp: now,
	};

	const nextTokens = { ...state.tokens, [tokenId]: token };
	const nextNodeStates = { ...state.nodeStates, [targetNode.id]: recomputeOrchestrationNodeState(nextTokens, targetNode.id) };
	const nextState: IOrchestrationRuntimeState = {
		...state,
		status: 'running',
		pausedAt: undefined,
		pausedReason: undefined,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: { ...state.traces, [tracePtr]: trace },
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		waveSeq: nextWaveSeq,
		tokenSeq: nextTokenSeq,
		traceSeq: nextTraceSeq,
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
			token,
			holderAgentId,
			taskGraph: params.taskGraph,
			rawTaskStatuses: params.taskStatuses,
		})],
		data: { tokenId, targetNodeId: targetNode.id, ...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}) },
	};
}

/**
 * Hands off a held Orchestration token along connected edges to 1 or more target staff nodes
 * (supports 1-to-N fan-out, bidirectional replies, and cyclic re-entry into idle employees).
 */
export function handoffOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly toNodeIds: readonly string[];
		readonly summary: string;
		readonly detail?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly nextTokenIds: readonly string[];
	readonly handedOffTo: readonly string[];
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
	readonly barrierSatisfied?: boolean;
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'hand off tokens') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before handing off tokens.' };
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
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concise handoff --summary is required.' };
	}

	const uniqueTargets = [...new Set(params.toNodeIds.map(s => s.trim()).filter(Boolean))];
	if (uniqueTargets.length === 0) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'At least one target staff node (--to) is required for token handoff.' };
	}

	// Barrier-aware routing:
	// - Single target matching a waiting OR already-satisfied barrier owner routes through `returnOrchestrationToken`
	//   (preserving task bindings & taskGraph/taskStatuses and settling trailing branches silently).
	// - Multi-target fan-out that mixes a waiting barrier owner with other targets is rejected cleanly (`INVALID_STATE`).
	if (token.parentJoinBarrierId) {
		const barrier = state.joinBarriers?.[token.parentJoinBarrierId];
		if (barrier && (barrier.status === 'waiting' || barrier.status === 'satisfied')) {
			if (uniqueTargets.length === 1 && barrier.ownerNodeId === uniqueTargets[0]) {
				const ret = returnOrchestrationToken(state, graph, whiteboards, config, {
					tokenId: params.tokenId,
					toNodeId: uniqueTargets[0],
					summary,
					detail: params.detail,
					taskNodeId: params.taskNodeId,
					taskNodeIds: params.taskNodeIds,
					taskGraph: params.taskGraph,
					taskStatuses: params.taskStatuses,
					whiteboardIds: params.whiteboardIds,
					artifacts: params.artifacts,
					decisions: params.decisions,
					refPtrs: params.refPtrs,
					modifiedFiles: params.modifiedFiles,
					callerAgentId: params.callerAgentId,
					now: params.now,
				});
				return {
					...ret,
					data: ret.data
						? {
							nextTokenIds: ret.data.returnedTokenId ? [ret.data.returnedTokenId] : [],
							handedOffTo: [uniqueTargets[0]],
							...(ret.data.payloadPtr ? { payloadPtr: ret.data.payloadPtr } : {}),
							...(ret.data.attachedRefPtrs ? { attachedRefPtrs: ret.data.attachedRefPtrs } : {}),
							...(ret.data.barrierSatisfied ? { barrierSatisfied: true } : {}),
						}
						: undefined,
				};
			}
			if (barrier.status === 'waiting' && uniqueTargets.length > 1 && uniqueTargets.includes(barrier.ownerNodeId)) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'INVALID_STATE',
					error: `Cannot fan-out token "${token.id}" simultaneously to waiting join barrier owner "${barrier.ownerNodeId}" and other targets. Use "token return" to settle the barrier.`,
				};
			}
		}
	}

	const staffIndex = buildStaffGraphIndex(graph);
	const holderNode = staffIndex.staffById.get(token.nodeId);
	const pathScopeCheck = validateScopedPaths(holderNode, token.scopePaths, params.modifiedFiles);
	if (!pathScopeCheck.ok) {
		return { ok: false, state, effects: [], code: 'ALLOWED_PATHS_VIOLATION', error: pathScopeCheck.error };
	}
	const mergedTouchedFiles = [...new Set([
		...(token.touchedFiles ?? []),
		...(pathScopeCheck.normalizedFiles ?? []),
	])];
	const holderTier = resolveEffectiveStaffTier(holderNode, config);
	const validOutgoing = new Set(staffIndex.outgoingStaffByNode.get(token.nodeId) ?? []);
	for (const targetId of uniqueTargets) {
		if (targetId === token.nodeId) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Staff node "${token.nodeId}" cannot hand off token "${token.id}" to itself.` };
		}
		const targetNode = staffIndex.staffById.get(targetId);
		if (!targetNode) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Target staff node "${targetId}" does not exist on Orchestration canvas.` };
		}
		if (!validOutgoing.has(targetId)) {
			const available = [...validOutgoing];
			const hasReverseEdge = (staffIndex.outgoingStaffByNode.get(targetId) ?? []).includes(token.nodeId);
			const choreographyHint = hasReverseEdge
				? ` Only one-way edge "${targetId} --> ${token.nodeId}" exists — add a return edge (${targetId} <--> ${token.nodeId}) during orchestration so "${token.nodeId}" can hand tokens back.`
				: '';
			return {
				ok: false,
				state,
				effects: [],
				code: 'NO_EDGE',
				error: `No directed edge from "${token.nodeId}" to "${targetId}" in Orchestration graph.${choreographyHint} Connected targets: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
			};
		}
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		if (holderTier !== undefined && targetTier !== undefined && targetTier < holderTier) {
			if (!hasDownwardLineageFrom(token, targetId)) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'UPWARD_TOKEN_FORBIDDEN',
					error: `UPWARD_TOKEN_FORBIDDEN: subordinate "${token.nodeId}" (L${holderTier}) cannot send token "${token.id}" upward to superior "${targetId}" (L${targetTier}) who did not dispatch this token's lineage.`,
				};
			}
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

	const explicitTaskIds = [...new Set([
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	])];
	const taskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitTaskIds);
	if (!taskCheck.ok) {
		return { ok: false, state, effects: [], code: taskCheck.code ?? 'INVALID_STATE', error: taskCheck.error };
	}

	const now = params.now ?? Date.now();
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const nextRelayDepth = (token.relayDepth ?? prevHopIndex) + 1;
	const hopCheck = checkAndTripOrchestrationMaxHops<{
		readonly nextTokenIds: readonly string[];
		readonly handedOffTo: readonly string[];
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
		readonly barrierSatisfied?: boolean;
	}>(state, graph, whiteboards, config, token, nextRelayDepth, 'token.handoff', now);
	if (hopCheck.tripped) {
		return hopCheck.result;
	}

	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const staged = stageTransitionContext({
		payloadStore,
		payloadSeqRef,
		externalizedBlobIndex: state.externalizedBlobIndex,
		whiteboards,
		baseRefs: token.contextRefs,
		baseWhiteboardPointers: token.whiteboardPointers,
		summary,
		detail: params.detail,
		detailTitle: `Hop #${nextHopIndex}: ${token.nodeId} → ${uniqueTargets.join(', ')}`,
		authorNodeId: token.nodeId,
		authorAgentId: token.holderAgentId,
		hop: nextHopIndex,
		waveId: token.waveId,
		now,
		artifacts: params.artifacts,
		decisions: params.decisions,
		refPtrs: params.refPtrs,
		normalizedWhiteboardIds: wbCheck.normalizedIds,
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

	let tokenSeq = state.tokenSeq;
	let traceSeq = state.traceSeq + 1;
	const handoffTracePtr = `otrc-${traceSeq}`;
	const allocatedTargets = uniqueTargets.map(targetId => {
		tokenSeq += 1;
		traceSeq += 1;
		return {
			targetId,
			childTokenId: `otok-${tokenSeq}`,
			arriveTracePtr: `otrc-${traceSeq}`,
		};
	});
	const observedHopIds = [
		...baseHopLog.map(h => buildHopKey(h)),
		...allocatedTargets.map(t => `${t.childTokenId}:${nextHopIndex}`),
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
	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'handed_off',
			blocked: undefined,
			...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
			lastActivityAt: now,
			handedOffToNodeIds: uniqueTargets,
		},
	};
	const nextTraces: Record<string, IMissionTraceNode> = {
		...state.traces,
		[handoffTracePtr]: {
			ptr: handoffTracePtr,
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: token.holderAgentId,
			waveId: token.waveId,
			event: 'complete',
			summary: `Handoff -> [${uniqueTargets.join(', ')}]: ${staged.headline}`,
			timestamp: now,
		},
	};

	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = {
		...state.nodeStates,
		[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
	};
	const waitingBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
	const forwardedBarrierId = waitingBarrier && waitingBarrier.status === 'waiting' ? waitingBarrier.id : undefined;
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> | undefined = forwardedBarrierId && state.joinBarriers
		? {
			...state.joinBarriers,
			[forwardedBarrierId]: {
				...waitingBarrier!,
				childTokenIds: waitingBarrier!.childTokenIds.flatMap(cid =>
					cid === token.id ? allocatedTargets.map(a => a.childTokenId) : [cid],
				),
			},
		}
		: state.joinBarriers;

	const hasExplicitTask = Boolean(params.taskNodeId?.trim() || (params.taskNodeIds && params.taskNodeIds.length > 0));
	const inheritedTasks = hasExplicitTask
		? normalizeBoundTaskIds(params.taskNodeId, params.taskNodeIds)
		: normalizeBoundTaskIds(token.taskNodeId, token.taskNodeIds);

	const nextTokenIds: string[] = [];
	const pendingDispatches: { readonly targetNode: IOrchestrationGraphNode; readonly childToken: IOrchestrationToken; readonly targetAgentId?: string }[] = [];

	for (const { targetId, childTokenId, arriveTracePtr } of allocatedTargets) {
		const targetNode = staffIndex.staffById.get(targetId)!;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		const isDownwardMove = Boolean(holderTier !== undefined && targetTier !== undefined && targetTier > holderTier);
		const isUpwardMove = Boolean(holderTier !== undefined && targetTier !== undefined && targetTier < holderTier);

		const hopEntry: IOrchestrationHopLedgerEntry = {
			hop: nextHopIndex,
			tokenId: childTokenId,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: isUpwardMove ? 'return' : 'handoff',
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
			originNodeId: isDownwardMove ? token.nodeId : (token.originNodeId ?? token.nodeId),
			...(isDownwardMove
				? { returnToNodeId: token.nodeId }
				: (!isUpwardMove && token.returnToNodeId ? { returnToNodeId: token.returnToNodeId } : {})),
			...(forwardedBarrierId ? { parentJoinBarrierId: forwardedBarrierId } : {}),
			dispatchKind: isUpwardMove ? 'return' : 'handoff',
			...inheritedTasks,
			...(token.scopePaths && token.scopePaths.length > 0 ? { scopePaths: token.scopePaths } : {}),
			...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
			...(token.attemptNumber !== undefined ? { attemptNumber: token.attemptNumber } : {}),
			...(token.reworkHistory && token.reworkHistory.length > 0 ? { reworkHistory: token.reworkHistory } : {}),
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
		nextTokens[childTokenId] = childToken;
		nextTraces[arriveTracePtr] = {
			ptr: arriveTracePtr,
			parentPtrs: [handoffTracePtr],
			nodeId: targetId,
			employeeId: targetAgentId,
			waveId: token.waveId,
			event: 'mint',
			summary: staged.headline,
			timestamp: now,
		};
		nextNodeStates[targetId] = recomputeOrchestrationNodeState(nextTokens, targetId);
		nextTokenIds.push(childTokenId);
		pendingDispatches.push({ targetNode, childToken, targetAgentId });
	}

	const finalState: IOrchestrationRuntimeState = {
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
		? syncMissionTaskStatusesFromOrchestration(params.taskStatuses, params.taskGraph, finalState, graph).taskStatuses
		: params.taskStatuses;
	const effects = pendingDispatches.map(({ targetNode, childToken, targetAgentId }) =>
		buildOrchestrationDispatchEffect({
			state: finalState,
			graph,
			staffIndex,
			whiteboards,
			config,
			targetNode,
			token: childToken,
			holderAgentId: targetAgentId,
			taskGraph: params.taskGraph,
			syncedTaskStatuses,
		}),
	);

	return {
		ok: true,
		state: finalState,
		effects,
		data: {
			nextTokenIds,
			handedOffTo: uniqueTargets,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
		},
	};
}

/**
 * Settles a child token into its parent's `IOrchestrationJoinBarrier` (`all` | `any` | `quorum`):
 * - `any`: satisfied on the first non-failed child (`returned`/`completed`), OR when ALL children have settled (so a failed sibling doesn't prematurely satisfy an `any` race!).
 * - `quorum`: satisfied when non-failed count >= `quorumCount`, OR when remaining unsettled children can no longer meet quorum.
 * - `all`: satisfied when all `childTokenIds` have settled.
 * - When `failFast === true` on `any`/`quorum` satisfaction, automatically reclaims trailing active sibling branches.
 * - Preserves `parentToken.relayDepth` across fan-in convergences so wide parallel fan-outs never trip `MAX_HOPS_EXCEEDED`.
 */
export function settleJoinBarrierIfApplicable(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly childToken: IOrchestrationToken;
		readonly outcome: IOrchestrationJoinBarrierChildResult['outcome'];
		readonly summary: string;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
		readonly extraContextRefs?: readonly IOrchestrationContextRef[];
		readonly extraWhiteboardPointers?: readonly IOrchestrationWhiteboardPointer[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly now: number;
	},
): {
	readonly state: IOrchestrationRuntimeState;
	readonly effects: readonly OrchestrationEngineEffect[];
	readonly barrierSatisfied: boolean;
	readonly parentTokenId?: string;
} {
	const barrierId = params.childToken.parentJoinBarrierId;
	if (!barrierId) {
		return { state, effects: [], barrierSatisfied: false };
	}
	const barrier = state.joinBarriers?.[barrierId];
	if (!barrier || barrier.status !== 'waiting') {
		return { state, effects: [], barrierSatisfied: false };
	}
	const childResult: IOrchestrationJoinBarrierChildResult = {
		tokenId: params.childToken.id,
		fromNodeId: params.childToken.nodeId,
		outcome: params.outcome,
		summary: buildCompactHeadline(params.summary).headline,
		...(params.payloadPtr ? { payloadPtr: params.payloadPtr } : (params.childToken.payloadPtr ? { payloadPtr: params.childToken.payloadPtr } : {})),
		...(params.attachedRefPtrs && params.attachedRefPtrs.length > 0 ? { attachedRefPtrs: params.attachedRefPtrs } : {}),
		...(params.childToken.taskNodeId ? { taskNodeId: params.childToken.taskNodeId } : {}),
		...(params.childToken.scopePaths && params.childToken.scopePaths.length > 0 ? { scopePaths: params.childToken.scopePaths } : {}),
		...(params.childToken.touchedFiles && params.childToken.touchedFiles.length > 0 ? { touchedFiles: params.childToken.touchedFiles } : {}),
		settledAt: params.now,
	};
	const nextSettled: Record<string, IOrchestrationJoinBarrierChildResult> = {
		...barrier.settledChildren,
		[params.childToken.id]: childResult,
	};

	const isSuccessOutcome = (o: IOrchestrationJoinBarrierChildResult['outcome'] | undefined): boolean =>
		o === 'returned' || o === 'completed';
	const allSettled = barrier.childTokenIds.every(cid => Boolean(nextSettled[cid]));
	let satisfied: boolean;
	if (barrier.mode === 'any') {
		const hasSuccessful = barrier.childTokenIds.some(cid => isSuccessOutcome(nextSettled[cid]?.outcome));
		satisfied = hasSuccessful || allSettled;
	} else if (barrier.mode === 'quorum') {
		const required = Math.max(1, Math.min(barrier.childTokenIds.length, barrier.quorumCount ?? Math.ceil(barrier.childTokenIds.length / 2)));
		let successCount = 0;
		let remainingUnsettled = 0;
		for (const cid of barrier.childTokenIds) {
			const res = nextSettled[cid];
			if (!res) {
				remainingUnsettled += 1;
			} else if (isSuccessOutcome(res.outcome)) {
				successCount += 1;
			}
		}
		satisfied = successCount >= required || (successCount + remainingUnsettled < required);
	} else {
		satisfied = allSettled || Boolean(barrier.failFast && params.outcome === 'failed');
	}

	const fileConflicts = satisfied ? computeJoinBarrierFileConflicts(nextSettled) : [];
	const updatedBarrier: IOrchestrationJoinBarrier = {
		...barrier,
		settledChildren: nextSettled,
		status: satisfied ? 'satisfied' : 'waiting',
		...(satisfied ? { satisfiedAt: params.now } : {}),
		...(fileConflicts.length > 0 ? { fileConflicts } : {}),
	};
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> = {
		...(state.joinBarriers ?? {}),
		[barrier.id]: updatedBarrier,
	};

	if (!satisfied) {
		return {
			state: {
				...state,
				joinBarriers: nextBarriers,
				stateRevision: (state.stateRevision ?? 0) + 1,
				updatedAt: params.now,
			},
			effects: [],
			barrierSatisfied: false,
			parentTokenId: barrier.parentTokenId,
		};
	}

	const now = params.now;
	const nextTokens: Record<string, IOrchestrationToken> = { ...state.tokens };
	const touchedNodes = new Set<string>();

	// Fail-fast cleanup (`all` on first failure, or `any`/`quorum` on early convergence):
	// recursively abort nested waiting child join barriers and auto-reclaim remaining unsettled sibling/grandchild branches.
	if (barrier.failFast) {
		const reclaimQueue: string[] = [];
		for (const cid of barrier.childTokenIds) {
			if (!nextSettled[cid]) {
				reclaimQueue.push(cid);
			}
		}
		const visitedReclaim = new Set<string>();
		while (reclaimQueue.length > 0) {
			const cid = reclaimQueue.shift()!;
			if (visitedReclaim.has(cid)) {
				continue;
			}
			visitedReclaim.add(cid);
			const sib = nextTokens[cid];
			if (!sib || (sib.status !== 'active' && sib.status !== 'blocked' && sib.status !== 'waiting_join')) {
				continue;
			}
			const nestedBarrierId = sib.joinBarrierId;
			if (nestedBarrierId) {
				const nestedBarrier = nextBarriers[nestedBarrierId];
				if (nestedBarrier && nestedBarrier.status === 'waiting') {
					nextBarriers[nestedBarrierId] = { ...nestedBarrier, status: 'aborted' };
					for (const grandChildId of nestedBarrier.childTokenIds) {
						if (!nestedBarrier.settledChildren[grandChildId]) {
							reclaimQueue.push(grandChildId);
						}
					}
				}
			}
			// Also reclaim any non-barrier active child tokens spawned by this branch (`waitJoin: false`)
			for (const grandChildId of sib.childTokenIds ?? []) {
				reclaimQueue.push(grandChildId);
			}
			const sibHop = (sib.hopIndex ?? Math.max(0, (sib.hopLog?.length ?? 1) - 1)) + 1;
			const reclaimHeadline = `Auto-reclaimed: join barrier ${barrier.id} already satisfied`;
			nextTokens[cid] = {
				...sib,
				status: 'reclaimed',
				blocked: undefined,
				joinBarrierId: undefined,
				reclaimedReason: reclaimHeadline,
				reclaimedBy: barrier.ownerNodeId,
				hopIndex: sibHop,
				hopLog: [...(sib.hopLog ?? []), {
					hop: sibHop,
					tokenId: sib.id,
					fromNodeId: barrier.ownerNodeId,
					toNodeId: sib.nodeId,
					event: 'reclaim',
					headline: reclaimHeadline,
					timestamp: now,
				}],
				lastActivityAt: now,
			};
			touchedNodes.add(sib.nodeId);
		}
	}

	const parentToken = nextTokens[barrier.parentTokenId];
	if (!parentToken || parentToken.status !== 'waiting_join') {
		const nextNodeStates = { ...state.nodeStates };
		for (const nid of touchedNodes) {
			nextNodeStates[nid] = recomputeOrchestrationNodeState(nextTokens, nid);
		}
		return {
			state: {
				...state,
				tokens: nextTokens,
				nodeStates: nextNodeStates,
				joinBarriers: nextBarriers,
				stateRevision: (state.stateRevision ?? 0) + 1,
				updatedAt: now,
			},
			effects: [],
			barrierSatisfied: true,
			parentTokenId: barrier.parentTokenId,
		};
	}

	const nextHop = (parentToken.hopIndex ?? Math.max(0, (parentToken.hopLog?.length ?? 1) - 1)) + 1;
	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const settledEntries = barrier.childTokenIds
		.map(cid => nextSettled[cid])
		.filter((r): r is IOrchestrationJoinBarrierChildResult => Boolean(r));
	const convergenceLines = [
		...settledEntries.map(r =>
			`- ${r.tokenId} (${r.fromNodeId}, ${r.outcome}${r.taskNodeId ? `, task:${r.taskNodeId}` : ''}): ${r.summary}${r.payloadPtr ? ` [detail:${r.payloadPtr}]` : ''}`,
		),
		...(fileConflicts.length > 0
			? ['', `Parallel File Overlaps (${fileConflicts.length}):`, ...fileConflicts.map(c => `- ${c.path}: touched by ${c.fromNodeIds.join(', ')} (${c.tokenIds.join(', ')})`)]
			: []),
	];
	const convergenceSummary = buildCompactHeadline(
		`Join barrier ${barrier.id} satisfied (${settledEntries.length}/${barrier.childTokenIds.length}): ${settledEntries.map(r => `${r.fromNodeId}=${r.outcome}`).join(', ')}`,
	).headline;
	const convergenceRef = storeOrReuseContextBlob(
		payloadStore,
		payloadSeqRef,
		{
			kind: 'handoff',
			title: `Join Barrier ${barrier.id} Convergence (${settledEntries.length} branches)`,
			content: convergenceLines.join('\n'),
			authorNodeId: barrier.ownerNodeId,
			hop: nextHop,
			waveId: parentToken.waveId,
			now,
		},
		state.externalizedBlobIndex,
	);

	// Consolidate durable lightweight pointers from parent + settled children (omit synthetic convergenceRef from contextRefs so it's not duplicated!)
	const refMap = new Map<string, IOrchestrationContextRef>();
	for (const ref of refreshContextRefsWithLiveWhiteboards(parentToken.contextRefs, whiteboards, parentToken.whiteboardPointers, nextHop)) {
		refMap.set(ref.ptr, ref);
	}
	for (const cid of barrier.childTokenIds) {
		const cTok = nextTokens[cid];
		for (const ref of cTok?.contextRefs ?? []) {
			refMap.set(ref.ptr, ref);
		}
	}
	for (const ref of params.extraContextRefs ?? []) {
		refMap.set(ref.ptr, ref);
	}

	const wbMap = new Map<string, IOrchestrationWhiteboardPointer>();
	for (const wp of parentToken.whiteboardPointers ?? []) {
		wbMap.set(wp.whiteboardId, wp);
	}
	for (const cid of barrier.childTokenIds) {
		const cTok = nextTokens[cid];
		for (const wp of cTok?.whiteboardPointers ?? []) {
			wbMap.set(wp.whiteboardId, wp);
		}
	}
	for (const wp of params.extraWhiteboardPointers ?? []) {
		wbMap.set(wp.whiteboardId, wp);
	}

	const mergedRefs = [...refMap.values()];
	const mergedWbs = [...wbMap.values()];
	const mergedTouchedFiles = [...new Set([
		...(parentToken.touchedFiles ?? []),
		...settledEntries.flatMap(r => r.touchedFiles ?? []),
	])];
	// Propagate child rejection/rework memory onto the converged parent token so rework provenance survives join convergence
	const childReworkEntries = barrier.childTokenIds
		.flatMap(cid => {
			const cTok = nextTokens[cid];
			return nextSettled[cid]?.outcome === 'rejected' ? (cTok?.reworkHistory ?? []) : [];
		});
	const mergedParentReworkHistory = childReworkEntries.length > 0
		? [...(parentToken.reworkHistory ?? []), ...childReworkEntries].slice(-8)
		: parentToken.reworkHistory;
	const latestRejectedChild = barrier.childTokenIds
		.map(cid => (nextSettled[cid]?.outcome === 'rejected' ? nextTokens[cid] : undefined))
		.filter((t): t is IOrchestrationToken => Boolean(t))
		.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
	const traceSeq = state.traceSeq + 1;
	const resumeTracePtr = `otrc-${traceSeq}`;
	const resumeHop: IOrchestrationHopLedgerEntry = {
		hop: nextHop,
		tokenId: parentToken.id,
		fromNodeId: params.childToken.nodeId,
		toNodeId: parentToken.nodeId,
		event: 'join_resume',
		headline: convergenceSummary,
		payloadPtr: convergenceRef.ptr,
		timestamp: now,
	};
	const resumedParent: IOrchestrationToken = {
		...parentToken,
		status: 'active',
		joinBarrierId: undefined,
		hopIndex: nextHop,
		// Preserve parent's relayDepth on fan-in convergence so wide parallel fan-outs never falsely trip MAX_HOPS_EXCEEDED!
		relayDepth: parentToken.relayDepth ?? 0,
		lastSummary: convergenceSummary,
		payloadPtr: convergenceRef.ptr,
		hopLog: [...(parentToken.hopLog ?? []), resumeHop],
		contextRefs: mergedRefs,
		...(mergedWbs.length > 0 ? { whiteboardPointers: mergedWbs } : {}),
		...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
		...(latestRejectedChild?.reworkCategory ? { reworkCategory: latestRejectedChild.reworkCategory } : {}),
		...(mergedParentReworkHistory && mergedParentReworkHistory.length > 0 ? { reworkHistory: mergedParentReworkHistory } : {}),
		lastActivityAt: now,
		lastNudgeAt: undefined,
		nudgeCount: 0,
	};
	nextTokens[parentToken.id] = resumedParent;
	touchedNodes.add(parentToken.nodeId);

	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
	for (const nid of touchedNodes) {
		nextNodeStates[nid] = recomputeOrchestrationNodeState(nextTokens, nid);
	}
	const nextTraces: Record<string, IMissionTraceNode> = {
		...state.traces,
		[resumeTracePtr]: {
			ptr: resumeTracePtr,
			parentPtrs: [parentToken.tracePtr, ...barrier.childTokenIds.map(cid => nextTokens[cid]?.tracePtr).filter((p): p is string => Boolean(p))],
			nodeId: parentToken.nodeId,
			employeeId: state.nodeAgentIds[parentToken.nodeId] ?? parentToken.holderAgentId,
			waveId: parentToken.waveId,
			event: 'mint',
			summary: convergenceSummary,
			timestamp: now,
		},
	};
	const nextState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: nextTraces,
		joinBarriers: nextBarriers,
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};

	const effects: OrchestrationEngineEffect[] = [];
	const staffIndex = buildStaffGraphIndex(graph);
	const parsedOwnerNode = staffIndex.staffById.get(parentToken.nodeId);
	const resolvedOwnerAgentId = state.nodeAgentIds[parentToken.nodeId] ?? resumedParent.holderAgentId;
	const ownerNode: IOrchestrationGraphNode | undefined = parsedOwnerNode
		?? (resolvedOwnerAgentId
			? {
				id: parentToken.nodeId,
				kind: 'staff',
				label: parentToken.nodeId,
				agentId: resolvedOwnerAgentId,
			}
			: undefined);
	if (ownerNode) {
		effects.push(buildOrchestrationDispatchEffect({
			state: nextState,
			graph,
			staffIndex,
			whiteboards,
			config,
			targetNode: ownerNode,
			token: resumedParent,
			holderAgentId: resolvedOwnerAgentId,
			convergedBarrier: updatedBarrier,
			taskGraph: params.taskGraph,
			rawTaskStatuses: params.taskStatuses,
		}));
	}

	return {
		state: nextState,
		effects,
		barrierSatisfied: true,
		parentTokenId: parentToken.id,
	};
}

/**
 * Active Minting & Heterogeneous Sub-Task Token Splitting + Optional Join/Convergence Barrier (`all` | `any` | `quorum`):
 * - Strictly downward-only (`targetNode.tier > parentNode.tier`).
 * - When `parentTokenId` is omitted, adopts the caller's sole active baton (root OR delegated) before creating a synthetic root.
 * - Restricts synthetic `'User'` root waves to Human/Secretary/highest-rank callers.
 * - Replaces (does not union with) parent's `taskNodeIds` when a branch specifies explicit `taskNodeId` / `taskNodeIds`.
 */
export function mintOrchestrationTokens(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly parentTokenId?: string;
		readonly fromNodeId?: string;
		readonly waveSummary?: string;
		readonly branches: readonly IOrchestrationMintBranch[];
		readonly waitJoin?: boolean;
		readonly joinMode?: 'all' | 'any' | 'quorum';
		readonly quorumCount?: number;
		readonly failFast?: boolean;
		readonly deadlineAt?: number;
		readonly conflictPolicy?: OrchestrationScopeConflictPolicy;
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly isHumanUser?: boolean;
		readonly isSecretary?: boolean;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly parentTokenId: string;
	readonly mintedTokenIds: readonly string[];
	readonly joinBarrierId?: string;
	readonly createdRootParent?: boolean;
	readonly reusedActiveRootParent?: boolean;
	readonly scopeOverlapWarnings?: readonly string[];
	readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly scopePaths?: readonly string[]; readonly payloadPtr?: string }[];
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'mint/split tokens') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before minting tokens.' };
	}
	if (graph.error) {
		return { ok: false, state, effects: [], code: 'INVALID_GRAPH', error: graph.error };
	}
	if (!params.branches || params.branches.length === 0) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'At least one sub-task branch is required to mint tokens.' };
	}

	const staffIndex = buildStaffGraphIndex(graph);
	const rawParentId = params.parentTokenId?.trim() ?? '';
	const explicitFreshRoot = rawParentId.toLowerCase() === 'root' || rawParentId.toLowerCase() === 'new';
	let shouldCreateRootParent = !rawParentId || explicitFreshRoot;
	let reusedActiveRootParent = false;

	let parentNode: IOrchestrationGraphNode | undefined;
	let existingParentToken: IOrchestrationToken | undefined;

	if (!shouldCreateRootParent) {
		existingParentToken = state.tokens[rawParentId];
		if (!existingParentToken || (existingParentToken.status !== 'active' && existingParentToken.status !== 'blocked')) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active parent Orchestration token "${rawParentId}" not found.` };
		}
		const holderCheck = assertOrchestrationTokenHolder(state, graph, existingParentToken, params.callerAgentId);
		if (!holderCheck.ok) {
			return { ok: false, state, effects: [], code: holderCheck.code, error: holderCheck.error };
		}
		parentNode = staffIndex.staffById.get(existingParentToken.nodeId);
		if (!parentNode) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Parent staff node "${existingParentToken.nodeId}" not found on Orchestration canvas.` };
		}
	} else {
		const requestedFrom = params.fromNodeId?.trim();
		if (params.callerAgentId !== undefined) {
			const boundNodeId = Object.entries(state.nodeAgentIds).find(([, aid]) => aid === params.callerAgentId)?.[0]
				?? graph.nodes.find(n => n.kind === 'staff' && n.agentId === params.callerAgentId)?.id;
			if (!boundNodeId) {
				return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Caller "${params.callerAgentId}" is not bound to any staff node on the Orchestration canvas.` };
			}
			if (requestedFrom && requestedFrom !== boundNodeId) {
				return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `FORBIDDEN: caller "${params.callerAgentId}" (staff "${boundNodeId}") cannot mint root tokens on behalf of "${requestedFrom}".` };
			}
			parentNode = staffIndex.staffById.get(boundNodeId);
		} else {
			parentNode = requestedFrom
				? staffIndex.staffById.get(requestedFrom)
				: findHighestRankStaffNode(graph);
		}
		if (!parentNode) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'NOT_FOUND',
				error: requestedFrom
					? `Originating staff node "${requestedFrom}" not found on Orchestration canvas.`
					: 'No staff nodes exist on the Orchestration canvas to originate tokens.',
			};
		}
		// When `parentTokenId` is omitted (not explicitly `'root'`/`'new'`), adopt the caller's sole active baton
		// (preferring an unsplit root baton, else a sole active delegated baton) so managers never orphan their active wave!
		if (!explicitFreshRoot) {
			const activeTokensOnNode = Object.values(state.tokens).filter(t =>
				t.nodeId === parentNode!.id
				&& t.status === 'active'
				&& !t.joinBarrierId,
			);
			const activeRootsOnNode = activeTokensOnNode.filter(t => !t.parentTokenId && !(t.childTokenIds && t.childTokenIds.length > 0));
			if (activeRootsOnNode.length === 1) {
				existingParentToken = activeRootsOnNode[0];
				shouldCreateRootParent = false;
				reusedActiveRootParent = true;
			} else if (activeTokensOnNode.length === 1) {
				existingParentToken = activeTokensOnNode[0];
				shouldCreateRootParent = false;
				reusedActiveRootParent = true;
			} else if (activeTokensOnNode.length === 0) {
				const blockedTokensOnNode = Object.values(state.tokens).filter(t =>
					t.nodeId === parentNode!.id
					&& t.status === 'blocked'
					&& !t.joinBarrierId,
				);
				if (blockedTokensOnNode.length === 1) {
					existingParentToken = blockedTokensOnNode[0];
					shouldCreateRootParent = false;
					reusedActiveRootParent = true;
				}
			}
		}
	}

	const parentTier = resolveEffectiveStaffTier(parentNode, config);
	const parentRank = parentTier !== undefined ? config.ranks.find(r => r.tier === parentTier) : undefined;
	if (parentRank && (parentRank.pureExecution || !parentRank.canHaveSubordinates)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'UPWARD_MINT_FORBIDDEN',
			error: `UPWARD_MINT_FORBIDDEN: leaf execution staff "${parentNode.id}" (L${parentRank.tier} ${parentRank.name}) cannot mint new downward tokens. Use "token return" or "token handoff" along existing edges.`,
		};
	}

	// Only Human, Secretary, or highest-rank staff may stamp `originNodeId: 'User'`;
	// mid-tier managers (`canHaveSubordinates`) originating an internal sub-wave via `parentTokenId: 'new'`
	// stamp their own `parentNode.id` so they can never spoof `'User'` root waves or User Inbox delivery.
	const highestRankForRoot = getHighestRankInSchema(config);
	const isHighestRootOriginator = Boolean(
		params.isHumanUser
		|| params.isSecretary
		|| (parentTier !== undefined
			? (highestRankForRoot ? parentTier <= highestRankForRoot.tier : false)
			: parentNode.id === staffIndex.topStaffId),
	);

	const validOutgoing = new Set(staffIndex.outgoingStaffByNode.get(parentNode.id) ?? []);
	const normalizedBranchWbIds: (readonly string[])[] = [];
	const normalizedBranchScopes: (readonly string[])[] = [];

	// Atomic pre-validation of EVERY branch before mutating any state!
	for (let i = 0; i < params.branches.length; i++) {
		const branch = params.branches[i];
		const targetId = branch.toNodeId?.trim();
		const summary = branch.summary?.trim();
		if (!targetId) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Branch #${i + 1} is missing target staff node "toNodeId".` };
		}
		if (!summary) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Branch #${i + 1} (-> "${targetId}") is missing a concise "summary".` };
		}
		if (targetId === parentNode.id) {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Staff node "${parentNode.id}" cannot mint a child token to itself.` };
		}
		const targetNode = staffIndex.staffById.get(targetId);
		if (!targetNode) {
			return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Target staff node "${targetId}" does not exist on Orchestration canvas.` };
		}
		if (!validOutgoing.has(targetId)) {
			const available = [...validOutgoing];
			return {
				ok: false,
				state,
				effects: [],
				code: 'NO_EDGE',
				error: `No directed edge from "${parentNode.id}" to "${targetId}" in Orchestration graph. Connected targets: ${available.length > 0 ? available.join(', ') : '(none)'}.`,
			};
		}
		const targetTier = resolveEffectiveStaffTier(targetNode, config);
		if (parentTier !== undefined && targetTier !== undefined && targetTier <= parentTier) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'UPWARD_MINT_FORBIDDEN',
				error: `UPWARD_MINT_FORBIDDEN: staff "${parentNode.id}" (L${parentTier}) may only mint new tokens downward to strictly lower-tier subordinates, not to "${targetId}" (L${targetTier}). Use "token return" to reply upward on a received token.`,
			};
		}
		// Parallel branch scopePaths validation (reject traversal/absolute/control-char paths, verify FULL set subset
		// including `!negation` exclusions against BOTH target staff `allowedPaths` AND `existingParentToken.scopePaths`,
		// and inherit parent scope when omitted!)
		const parentScopePaths = existingParentToken?.scopePaths;
		const branchScopeClean: string[] = [];
		for (const rawScope of branch.scopePaths ?? []) {
			if (!rawScope || !rawScope.trim()) {
				continue;
			}
			const normScope = normalizeRepoRelativePath(rawScope, { allowGlobWildcards: true, allowNegation: true });
			if (!normScope.ok) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'ALLOWED_PATHS_VIOLATION',
					error: `ALLOWED_PATHS_VIOLATION: branch #${i + 1} (-> "${targetId}") has invalid scopePath "${rawScope}": ${normScope.reason}`,
				};
			}
			const canonicalPattern = normScope.negated ? `!${normScope.path}` : normScope.path;
			branchScopeClean.push(canonicalPattern);
		}
		const uniqueExplicitScope = [...new Set(branchScopeClean)];
		if (uniqueExplicitScope.length > 0) {
			if (!areScopePatternsSubsetOfAllowed(uniqueExplicitScope, targetNode.allowedPaths)) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'ALLOWED_PATHS_VIOLATION',
					error: `ALLOWED_PATHS_VIOLATION: branch #${i + 1} (-> "${targetId}") scopePaths [${uniqueExplicitScope.join(', ')}] exceed staff "${targetId}" allowedPaths (${(targetNode.allowedPaths ?? []).join(', ')}).`,
				};
			}
			if (parentScopePaths && parentScopePaths.length > 0 && !areScopePatternsSubsetOfAllowed(uniqueExplicitScope, parentScopePaths)) {
				return {
					ok: false,
					state,
					effects: [],
					code: 'ALLOWED_PATHS_VIOLATION',
					error: `ALLOWED_PATHS_VIOLATION: branch #${i + 1} (-> "${targetId}") scopePaths [${uniqueExplicitScope.join(', ')}] widen parent token "${existingParentToken!.id}" scopePaths (${parentScopePaths.join(', ')}).`,
				};
			}
		}
		const effectiveBranchScope = uniqueExplicitScope.length > 0
			? uniqueExplicitScope
			: (parentScopePaths && parentScopePaths.length > 0 ? [...parentScopePaths] : []);
		normalizedBranchScopes.push(effectiveBranchScope);

		const wbCheck = validateTokenWhiteboardAttachments(
			graph,
			whiteboards,
			config,
			{ callerNodeId: parentNode.id, callerTier: parentTier, state },
			branch.whiteboardIds,
			branch.refPtrs,
		);
		if (!wbCheck.ok) {
			return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
		}
		normalizedBranchWbIds.push(wbCheck.normalizedIds);
		const branchExplicitTasks = [...new Set([
			...(branch.taskNodeId?.trim() ? [branch.taskNodeId.trim()] : []),
			...(branch.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
		])];
		const taskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, branchExplicitTasks);
		if (!taskCheck.ok) {
			return { ok: false, state, effects: [], code: taskCheck.code ?? 'INVALID_STATE', error: taskCheck.error };
		}
	}

	// Parallel branch scopePaths conflict governance (`reject` | `warn` | `allow`)
	const conflictPolicy: OrchestrationScopeConflictPolicy = params.conflictPolicy ?? 'warn';
	const scopeOverlapWarnings: string[] = [];
	if (params.branches.length >= 2 && conflictPolicy !== 'allow') {
		for (let i = 0; i < params.branches.length; i++) {
			const scopeA = normalizedBranchScopes[i] ?? [];
			if (scopeA.length === 0) {
				continue;
			}
			for (let j = i + 1; j < params.branches.length; j++) {
				const scopeB = normalizedBranchScopes[j] ?? [];
				if (scopeB.length === 0) {
					continue;
				}
				const overlaps = detectScopePathsOverlap(scopeA, scopeB);
				if (overlaps.length > 0) {
					scopeOverlapWarnings.push(
						`Branch #${i + 1} (${params.branches[i].toNodeId.trim()}) & Branch #${j + 1} (${params.branches[j].toNodeId.trim()}) overlap on [${overlaps.join(', ')}]`,
					);
				}
			}
		}
		if (scopeOverlapWarnings.length > 0 && conflictPolicy === 'reject') {
			return {
				ok: false,
				state,
				effects: [],
				code: 'SCOPE_CONFLICT',
				error: `SCOPE_CONFLICT: parallel branches have overlapping write scopes (${scopeOverlapWarnings.join('; ')}). Partition scopePaths disjointly or pass conflictPolicy "warn"|"allow".`,
			};
		}
	}

	const now = params.now ?? Date.now();
	let waveSeq = state.waveSeq;
	let tokenSeq = state.tokenSeq;
	let traceSeq = state.traceSeq;
	const nextTraces: Record<string, IMissionTraceNode> = { ...state.traces };

	let parentToken: IOrchestrationToken;
	if (existingParentToken) {
		parentToken = existingParentToken;
	} else {
		waveSeq += 1;
		tokenSeq += 1;
		traceSeq += 1;
		const waveId = `wave-${waveSeq}`;
		const synthParentId = `otok-${tokenSeq}`;
		const synthTracePtr = `otrc-${traceSeq}`;
		const synthAgentId = state.nodeAgentIds[parentNode.id] ?? parentNode.agentId;
		const defaultWaveSummary = params.waveSummary?.trim()
			|| (params.branches.length === 1
				? `Delegated to ${params.branches[0].toNodeId.trim()}: ${params.branches[0].summary.trim()}`
				: `Split into ${params.branches.length} branches (${params.branches.map(b => b.toNodeId.trim()).join(', ')})`);
		const synthHeadline = buildCompactHeadline(defaultWaveSummary).headline;
		parentToken = {
			id: synthParentId,
			waveId,
			nodeId: parentNode.id,
			holderAgentId: synthAgentId,
			status: 'active',
			rootTokenId: synthParentId,
			originNodeId: isHighestRootOriginator ? 'User' : parentNode.id,
			dispatchKind: 'dispatch',
			hopIndex: 0,
			relayDepth: 0,
			lastSummary: synthHeadline,
			hopLog: [{
				hop: 0,
				tokenId: synthParentId,
				toNodeId: parentNode.id,
				event: 'dispatch',
				headline: synthHeadline,
				timestamp: now,
			}],
			contextRefs: [],
			compressedHistory: '',
			tracePtr: synthTracePtr,
			arrivedAt: now,
			lastActivityAt: now,
			nudgeCount: 0,
		};
		nextTraces[synthTracePtr] = {
			ptr: synthTracePtr,
			parentPtrs: [],
			nodeId: parentNode.id,
			employeeId: synthAgentId,
			waveId,
			event: 'mint',
			summary: synthHeadline,
			timestamp: now,
		};
	}

	const prevHopIndex = parentToken.hopIndex ?? Math.max(0, (parentToken.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const childRelayDepth = (parentToken.relayDepth ?? 0) + 1;
	if (existingParentToken) {
		const hopCheck = checkAndTripOrchestrationMaxHops<{
			readonly parentTokenId: string;
			readonly mintedTokenIds: readonly string[];
			readonly joinBarrierId?: string;
			readonly createdRootParent?: boolean;
			readonly reusedActiveRootParent?: boolean;
			readonly branches: readonly { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly payloadPtr?: string }[];
		}>(state, graph, whiteboards, config, existingParentToken, childRelayDepth, 'token.mint', now);
		if (hopCheck.tripped) {
			return hopCheck.result;
		}
	}

	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const digestIndex = buildPayloadDigestIndex(payloadStore);
	const parentBaseRefs = refreshContextRefsWithLiveWhiteboards(parentToken.contextRefs, whiteboards, parentToken.whiteboardPointers, nextHopIndex);
	const baseHopLog: readonly IOrchestrationHopLedgerEntry[] = parentToken.hopLog && parentToken.hopLog.length > 0
		? parentToken.hopLog
		: [{
			hop: prevHopIndex,
			tokenId: parentToken.id,
			...(parentToken.fromNodeId ? { fromNodeId: parentToken.fromNodeId } : {}),
			toNodeId: parentToken.nodeId,
			event: parentToken.fromNodeId ? 'handoff' : 'dispatch',
			headline: buildCompactHeadline(parentToken.lastSummary).headline,
			...(parentToken.payloadPtr ? { payloadPtr: parentToken.payloadPtr } : {}),
			timestamp: parentToken.arrivedAt,
		}];

	let barrierSeq = state.barrierSeq ?? 0;
	let joinBarrierId: string | undefined;
	if (params.waitJoin) {
		barrierSeq += 1;
		joinBarrierId = `bar-${barrierSeq}`;
	}

	const allocated = params.branches.map((branch, idx) => {
		tokenSeq += 1;
		traceSeq += 1;
		return {
			branch,
			normalizedWbIds: normalizedBranchWbIds[idx] ?? [],
			normalizedScopePaths: normalizedBranchScopes[idx] ?? [],
			targetId: branch.toNodeId.trim(),
			childTokenId: `otok-${tokenSeq}`,
			tracePtr: `otrc-${traceSeq}`,
		};
	});

	const mintedTokenIds = allocated.map(a => a.childTokenId);
	const existingChildIds = parentToken.childTokenIds ?? [];
	const updatedParentToken: IOrchestrationToken = {
		...parentToken,
		status: params.waitJoin ? 'waiting_join' : 'active',
		blocked: undefined,
		...(joinBarrierId ? { joinBarrierId } : {}),
		childTokenIds: [...existingChildIds, ...mintedTokenIds],
		lastActivityAt: now,
	};

	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[parentToken.id]: updatedParentToken,
	};
	const nextNodeStates: Record<string, OrchestrationNodeRuntimeStatus> = { ...state.nodeStates };
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> = { ...(state.joinBarriers ?? {}) };
	if (joinBarrierId) {
		const resolvedMode: IOrchestrationJoinBarrier['mode'] = params.joinMode === 'any'
			? 'any'
			: params.joinMode === 'quorum'
				? 'quorum'
				: 'all';
		const resolvedQuorum = resolvedMode === 'quorum'
			? Math.max(1, Math.min(mintedTokenIds.length, params.quorumCount ?? Math.ceil(mintedTokenIds.length / 2)))
			: undefined;
		nextBarriers[joinBarrierId] = {
			id: joinBarrierId,
			waveId: parentToken.waveId,
			parentTokenId: parentToken.id,
			ownerNodeId: parentToken.nodeId,
			childTokenIds: mintedTokenIds,
			mode: resolvedMode,
			...(resolvedQuorum !== undefined ? { quorumCount: resolvedQuorum } : {}),
			...(params.failFast ? { failFast: true } : {}),
			...(params.deadlineAt !== undefined && Number.isFinite(params.deadlineAt) ? { deadlineAt: params.deadlineAt } : {}),
			...(scopeOverlapWarnings.length > 0 ? { scopeOverlapWarnings } : {}),
			status: 'waiting',
			settledChildren: {},
			createdAt: now,
		};
	}

	const allParentObservedRefs = new Map<string, IOrchestrationContextRef>();
	for (const ref of parentBaseRefs) {
		allParentObservedRefs.set(ref.ptr, ref);
	}
	const observedHopIds = [
		...baseHopLog.map(h => buildHopKey(h)),
		...allocated.map(a => `${a.childTokenId}:${nextHopIndex}`),
	];

	const branchResults: { readonly tokenId: string; readonly toNodeId: string; readonly taskNodeId?: string; readonly scopePaths?: readonly string[]; readonly payloadPtr?: string }[] = [];
	const pendingDispatches: { readonly targetNode: IOrchestrationGraphNode; readonly childToken: IOrchestrationToken; readonly targetAgentId?: string }[] = [];

	for (const item of allocated) {
		const { branch, targetId, childTokenId, tracePtr } = item;
		const targetNode = staffIndex.staffById.get(targetId)!;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const staged = stageTransitionContext({
			payloadStore,
			payloadSeqRef,
			externalizedBlobIndex: state.externalizedBlobIndex,
			digestIndex,
			whiteboards,
			baseRefs: parentBaseRefs,
			baseWhiteboardPointers: parentToken.whiteboardPointers,
			summary: branch.summary,
			detail: branch.detail,
			detailTitle: `Mint #${nextHopIndex}: ${parentToken.nodeId} → ${targetId}`,
			authorNodeId: parentToken.nodeId,
			authorAgentId: parentToken.holderAgentId,
			hop: nextHopIndex,
			waveId: parentToken.waveId,
			now,
			artifacts: branch.artifacts,
			decisions: branch.decisions,
			refPtrs: branch.refPtrs,
			normalizedWhiteboardIds: item.normalizedWbIds,
		});
		for (const ref of staged.allObservedRefs) {
			allParentObservedRefs.set(ref.ptr, ref);
		}

		// Explicit branch taskNodeId/taskNodeIds REPLACES (does not union with) parent's task bindings!
		const hasBranchExplicitTask = Boolean(branch.taskNodeId?.trim() || (branch.taskNodeIds && branch.taskNodeIds.length > 0));
		const boundTasks = hasBranchExplicitTask
			? normalizeBoundTaskIds(branch.taskNodeId, branch.taskNodeIds)
			: normalizeBoundTaskIds(parentToken.taskNodeId, parentToken.taskNodeIds);

		const hopEntry: IOrchestrationHopLedgerEntry = {
			hop: nextHopIndex,
			tokenId: childTokenId,
			fromNodeId: parentToken.nodeId,
			toNodeId: targetId,
			event: 'mint',
			headline: staged.headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			timestamp: now,
		};

		const childToken: IOrchestrationToken = {
			id: childTokenId,
			waveId: parentToken.waveId,
			nodeId: targetId,
			fromNodeId: parentToken.nodeId,
			holderAgentId: targetAgentId,
			status: 'active',
			parentTokenId: parentToken.id,
			rootTokenId: parentToken.rootTokenId ?? parentToken.id,
			originNodeId: parentToken.nodeId,
			returnToNodeId: parentToken.nodeId,
			dispatchKind: 'mint',
			...(joinBarrierId ? { parentJoinBarrierId: joinBarrierId } : {}),
			...boundTasks,
			...(item.normalizedScopePaths.length > 0 ? { scopePaths: item.normalizedScopePaths } : {}),
			hopIndex: nextHopIndex,
			relayDepth: childRelayDepth,
			edgeBounceCounts: incrementEdgeBounceCounts(parentToken.edgeBounceCounts, parentToken.nodeId, targetId),
			lastSummary: staged.headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			hopLog: [...baseHopLog, hopEntry],
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
			parentPtrs: [parentToken.tracePtr],
			nodeId: targetId,
			employeeId: targetAgentId,
			waveId: parentToken.waveId,
			event: 'mint',
			summary: `Mint -> ${targetId}: ${staged.headline}`,
			timestamp: now,
		};
		nextNodeStates[targetId] = recomputeOrchestrationNodeState(nextTokens, targetId);
		branchResults.push({
			tokenId: childTokenId,
			toNodeId: targetId,
			...(boundTasks.taskNodeId ? { taskNodeId: boundTasks.taskNodeId } : {}),
			...(item.normalizedScopePaths.length > 0 ? { scopePaths: item.normalizedScopePaths } : {}),
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		});
		pendingDispatches.push({ targetNode, childToken, targetAgentId });
	}

	nextNodeStates[parentToken.nodeId] = recomputeOrchestrationNodeState(nextTokens, parentToken.nodeId);
	const nextCursors = recordNodeCursorObservation(
		state.nodeReadCursors,
		parentToken.waveId,
		parentToken.nodeId,
		nextHopIndex,
		[...allParentObservedRefs.values()],
		now,
		observedHopIds,
	);

	const nextState: IOrchestrationRuntimeState = {
		...state,
		status: 'running',
		pausedAt: undefined,
		pausedReason: undefined,
		tokens: nextTokens,
		nodeStates: nextNodeStates,
		traces: nextTraces,
		joinBarriers: nextBarriers,
		barrierSeq,
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		nodeReadCursors: nextCursors,
		waveSeq,
		tokenSeq,
		traceSeq,
		stateRevision: (state.stateRevision ?? 0) + 1,
		updatedAt: now,
	};

	const syncedTaskStatuses = params.taskGraph && !params.taskGraph.error
		? syncMissionTaskStatusesFromOrchestration(params.taskStatuses, params.taskGraph, nextState, graph).taskStatuses
		: params.taskStatuses;
	const effects = pendingDispatches.map(({ targetNode, childToken, targetAgentId }) =>
		buildOrchestrationDispatchEffect({
			state: nextState,
			graph,
			staffIndex,
			whiteboards,
			config,
			targetNode,
			token: childToken,
			holderAgentId: targetAgentId,
			taskGraph: params.taskGraph,
			syncedTaskStatuses,
		}),
	);

	return {
		ok: true,
		state: nextState,
		effects,
		data: {
			parentTokenId: parentToken.id,
			mintedTokenIds,
			...(joinBarrierId ? { joinBarrierId } : {}),
			...(shouldCreateRootParent ? { createdRootParent: true } : {}),
			...(reusedActiveRootParent ? { reusedActiveRootParent: true } : {}),
			...(scopeOverlapWarnings.length > 0 ? { scopeOverlapWarnings } : {}),
			branches: branchResults,
		},
	};
}

/**
 * Dedicated subordinate upward return (`token return`):
 * - Honors `token.returnToNodeId` BEFORE `activeBarrier.ownerNodeId` to prevent rank-skipping on nested delegations.
 * - Handles already-satisfied barriers cleanly (Path A0), waiting barriers (Path A), live active ancestors (Path B0 without incrementing parent `relayDepth`), and direct return (Path B).
 */
export function returnOrchestrationToken(
	state: IOrchestrationRuntimeState,
	graph: IOrchestrationGraphParseResult,
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	config: IAdeOrganizationConfig,
	params: {
		readonly tokenId: string;
		readonly toNodeId?: string;
		readonly summary: string;
		readonly detail?: string;
		readonly taskNodeId?: string;
		readonly taskNodeIds?: readonly string[];
		readonly taskGraph?: IMissionDagParseResult;
		readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
		readonly whiteboardIds?: readonly string[];
		readonly artifacts?: readonly IOrchestrationContextBlobInput[];
		readonly decisions?: readonly IOrchestrationContextBlobInput[];
		readonly refPtrs?: readonly string[];
		readonly modifiedFiles?: readonly string[];
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IOrchestrationTransitionResult<{
	readonly returnedToNodeId: string;
	readonly returnedTokenId?: string;
	readonly absorbedIntoWaitingAncestor?: boolean;
	readonly barrierId?: string;
	readonly barrierSatisfied?: boolean;
	readonly payloadPtr?: string;
	readonly attachedRefPtrs?: readonly string[];
}> {
	if (isOrchestrationBudgetTripped(state)) {
		return { ok: false, state, effects: [], code: 'BUDGET_EXCEEDED', error: formatBudgetExceededError(state, 'return tokens') };
	}
	if (state.status === 'paused') {
		return { ok: false, state, effects: [], code: 'PAUSED', error: 'Orchestration is currently paused. Resume before returning tokens.' };
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
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concise return --summary is required.' };
	}

	const staffIndex = buildStaffGraphIndex(graph);
	const activeBarrier = token.parentJoinBarrierId ? state.joinBarriers?.[token.parentJoinBarrierId] : undefined;
	// Prefer explicit `toNodeId`, then immediate `returnToNodeId` (preventing rank-skipping on nested delegations!),
	// falling back to waiting barrier owner / origin / prior sender.
	const targetId = params.toNodeId?.trim()
		|| token.returnToNodeId
		|| (activeBarrier?.status === 'waiting' ? activeBarrier.ownerNodeId : undefined)
		|| (token.originNodeId && token.originNodeId !== 'User' ? token.originNodeId : undefined)
		|| token.fromNodeId;
	if (!targetId || targetId === token.nodeId) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Token "${token.id}" has no upstream superior return target; use "token complete --finish" or specify --to.` };
	}
	const targetNode = staffIndex.staffById.get(targetId);
	if (!targetNode) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Return target staff node "${targetId}" does not exist on Orchestration canvas.` };
	}
	const holderNode = staffIndex.staffById.get(token.nodeId);
	const holderTier = resolveEffectiveStaffTier(holderNode, config);
	const targetTier = resolveEffectiveStaffTier(targetNode, config);
	// `token.return` is strictly upward: a superior cannot accidentally "return" downward to a subordinate whose prior return updated `fromNodeId`
	if (holderTier !== undefined && targetTier !== undefined && targetTier >= holderTier) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `INVALID_STATE: "${token.nodeId}" (L${holderTier}) cannot use "token return" to target "${targetId}" (L${targetTier}). "token return" is strictly upward; use "token handoff", "token mint", or "token complete --finish".`,
		};
	}
	if (!hasDownwardLineageFrom(token, targetId) && activeBarrier?.ownerNodeId !== targetId) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'UPWARD_TOKEN_FORBIDDEN',
			error: `UPWARD_TOKEN_FORBIDDEN: "${token.nodeId}" can only return token "${token.id}" to a superior in its dispatch lineage, not to "${targetId}".`,
		};
	}
	const returnPathCheck = validateScopedPaths(holderNode, token.scopePaths, params.modifiedFiles);
	if (!returnPathCheck.ok) {
		return { ok: false, state, effects: [], code: 'ALLOWED_PATHS_VIOLATION', error: returnPathCheck.error };
	}
	const mergedTouchedFiles = [...new Set([
		...(token.touchedFiles ?? []),
		...(returnPathCheck.normalizedFiles ?? []),
	])];
	const wbCheck = validateTokenWhiteboardAttachments(
		graph,
		whiteboards,
		config,
		{ callerNodeId: token.nodeId, callerTier: resolveEffectiveStaffTier(holderNode, config), state },
		params.whiteboardIds,
		params.refPtrs,
	);
	if (!wbCheck.ok) {
		return { ok: false, state, effects: [], code: wbCheck.code ?? 'INVALID_STATE', error: wbCheck.error };
	}
	const explicitReturnTaskIds = [
		...(params.taskNodeId?.trim() ? [params.taskNodeId.trim()] : []),
		...(params.taskNodeIds ?? []).map(s => s.trim()).filter(Boolean),
	];
	if (explicitReturnTaskIds.length > 0) {
		const retTaskCheck = validateTokenTaskBindings(params.taskGraph, params.taskStatuses, explicitReturnTaskIds, { allowCompleted: true });
		if (!retTaskCheck.ok) {
			return { ok: false, state, effects: [], code: retTaskCheck.code ?? 'INVALID_STATE', error: retTaskCheck.error };
		}
	}
	const mergedReturnTasks = normalizeBoundTaskIds(
		params.taskNodeId ?? token.taskNodeId,
		[...(token.taskNodeIds ?? []), ...(params.taskNodeIds ?? [])],
	);

	const now = params.now ?? Date.now();
	const prevHopIndex = token.hopIndex ?? Math.max(0, (token.hopLog?.length ?? 1) - 1);
	const nextHopIndex = prevHopIndex + 1;
	const nextRelayDepth = (token.relayDepth ?? prevHopIndex) + 1;
	const hopCheck = checkAndTripOrchestrationMaxHops<{
		readonly returnedToNodeId: string;
		readonly returnedTokenId?: string;
		readonly barrierId?: string;
		readonly barrierSatisfied?: boolean;
		readonly payloadPtr?: string;
		readonly attachedRefPtrs?: readonly string[];
	}>(state, graph, whiteboards, config, token, nextRelayDepth, 'token.return', now);
	if (hopCheck.tripped) {
		return hopCheck.result;
	}

	const payloadStore: Record<string, IOrchestrationContextBlob> = { ...(state.payloadStore ?? {}) };
	const payloadSeqRef = { value: state.payloadSeq ?? 0 };
	const staged = stageTransitionContext({
		payloadStore,
		payloadSeqRef,
		externalizedBlobIndex: state.externalizedBlobIndex,
		whiteboards,
		baseRefs: token.contextRefs,
		baseWhiteboardPointers: token.whiteboardPointers,
		summary,
		detail: params.detail,
		detailTitle: `Return #${nextHopIndex}: ${token.nodeId} → ${targetId}`,
		authorNodeId: token.nodeId,
		authorAgentId: token.holderAgentId,
		hop: nextHopIndex,
		waveId: token.waveId,
		now,
		artifacts: params.artifacts,
		decisions: params.decisions,
		refPtrs: params.refPtrs,
		normalizedWhiteboardIds: wbCheck.normalizedIds,
	});

	const returnHopEntry: IOrchestrationHopLedgerEntry = {
		hop: nextHopIndex,
		tokenId: token.id,
		fromNodeId: token.nodeId,
		toNodeId: targetId,
		event: 'return',
		headline: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
		timestamp: now,
	};

	const buildCompletedChild = (): IOrchestrationToken => ({
		...token,
		status: 'completed',
		blocked: undefined,
		...(mergedReturnTasks.taskNodeId ? { taskNodeId: mergedReturnTasks.taskNodeId } : {}),
		...(mergedReturnTasks.taskNodeIds ? { taskNodeIds: mergedReturnTasks.taskNodeIds } : {}),
		...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
		hopIndex: nextHopIndex,
		relayDepth: nextRelayDepth,
		lastSummary: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		hopLog: [...(token.hopLog ?? []), returnHopEntry],
		contextRefs: staged.contextRefs,
		...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
		lastActivityAt: now,
	});

	// Path A0: Trailing branch of an ALREADY-satisfied join barrier (`any` / `quorum`) returning to barrier owner
	if (activeBarrier && activeBarrier.status === 'satisfied' && activeBarrier.ownerNodeId === targetId) {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const finishedChild = buildCompletedChild();
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
		};
		const nextBarriers: Record<string, IOrchestrationJoinBarrier> = {
			...(state.joinBarriers ?? {}),
			[activeBarrier.id]: {
				...activeBarrier,
				settledChildren: {
					...activeBarrier.settledChildren,
					[token.id]: {
						tokenId: token.id,
						fromNodeId: token.nodeId,
						outcome: 'returned',
						summary: staged.headline,
						...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
						...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
						...(mergedReturnTasks.taskNodeId ? { taskNodeId: mergedReturnTasks.taskNodeId } : {}),
						...(token.scopePaths && token.scopePaths.length > 0 ? { scopePaths: token.scopePaths } : {}),
						...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
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
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
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
					[retTracePtr]: {
						ptr: retTracePtr,
						parentPtrs: [token.tracePtr],
						nodeId: token.nodeId,
						employeeId: token.holderAgentId,
						waveId: token.waveId,
						event: 'complete',
						summary: `Trailing return -> ${targetId} (barrier ${activeBarrier.id} already satisfied): ${staged.headline}`,
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
				returnedToNodeId: targetId,
				barrierId: activeBarrier.id,
				barrierSatisfied: true,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			},
		};
	}

	// Path A: Settling a waiting join barrier owned by `targetId`
	if (activeBarrier && activeBarrier.status === 'waiting' && activeBarrier.ownerNodeId === targetId) {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const finishedChild = buildCompletedChild();
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
		};
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			staged.allObservedRefs,
			now,
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
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
				[retTracePtr]: {
					ptr: retTracePtr,
					parentPtrs: [token.tracePtr],
					nodeId: token.nodeId,
					employeeId: token.holderAgentId,
					waveId: token.waveId,
					event: 'complete',
					summary: `Return -> ${targetId} (barrier ${activeBarrier.id}): ${staged.headline}`,
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
			childToken: finishedChild,
			outcome: 'returned',
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
				returnedToNodeId: targetId,
				barrierId: activeBarrier.id,
				barrierSatisfied: settled.barrierSatisfied,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			},
		};
	}

	// Path B0: Superior still holds its active parent baton -> merge cleanly WITHOUT incrementing parent `relayDepth`!
	const existingActiveParent = findActiveAncestorTokenOnNode(state, token, targetId);
	if (existingActiveParent) {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const parentHopIndex = Math.max(
			nextHopIndex,
			(existingActiveParent.hopIndex ?? Math.max(0, (existingActiveParent.hopLog?.length ?? 1) - 1)) + 1,
		);
		const parentRefMap = new Map<string, IOrchestrationContextRef>();
		for (const ref of refreshContextRefsWithLiveWhiteboards(existingActiveParent.contextRefs, whiteboards, existingActiveParent.whiteboardPointers, parentHopIndex)) {
			parentRefMap.set(ref.ptr, ref);
		}
		for (const ref of staged.contextRefs) {
			parentRefMap.set(ref.ptr, ref);
		}
		const parentWbMap = new Map<string, IOrchestrationWhiteboardPointer>();
		for (const wp of existingActiveParent.whiteboardPointers ?? []) {
			parentWbMap.set(wp.whiteboardId, wp);
		}
		for (const wp of staged.whiteboardPointers) {
			parentWbMap.set(wp.whiteboardId, wp);
		}
		const mergedParentRefs = [...parentRefMap.values()];
		const mergedParentWbs = [...parentWbMap.values()];
		const parentReturnHop: IOrchestrationHopLedgerEntry = {
			hop: parentHopIndex,
			tokenId: existingActiveParent.id,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: 'return',
			headline: buildCompactHeadline(`[Returned from ${token.nodeId} (${token.id})] ${staged.headline}`).headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			timestamp: now,
		};
		const finishedChild = buildCompletedChild();
		const updatedParent: IOrchestrationToken = {
			...existingActiveParent,
			status: 'active',
			blocked: undefined,
			fromNodeId: token.nodeId,
			holderAgentId: targetAgentId,
			hopIndex: parentHopIndex,
			// Do NOT increment parent relayDepth on fan-in return!
			relayDepth: existingActiveParent.relayDepth ?? 0,
			lastSummary: parentReturnHop.headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			hopLog: [...(existingActiveParent.hopLog ?? []), parentReturnHop],
			contextRefs: mergedParentRefs,
			...(mergedParentWbs.length > 0 ? { whiteboardPointers: mergedParentWbs } : {}),
			...(mergedTouchedFiles.length > 0
				? { touchedFiles: [...new Set([...(existingActiveParent.touchedFiles ?? []), ...mergedTouchedFiles])] }
				: {}),
			lastActivityAt: now,
			lastNudgeAt: undefined,
			nudgeCount: 0,
		};
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
			[existingActiveParent.id]: updatedParent,
		};
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			staged.allObservedRefs,
			now,
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
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
				[retTracePtr]: {
					ptr: retTracePtr,
					parentPtrs: [token.tracePtr, existingActiveParent.tracePtr],
					nodeId: targetId,
					employeeId: targetAgentId,
					waveId: token.waveId,
					event: 'complete',
					summary: `Return (${token.nodeId} -> ${targetId} into ${existingActiveParent.id}): ${staged.headline}`,
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
				targetNode,
				token: updatedParent,
				holderAgentId: targetAgentId,
				taskGraph: params.taskGraph,
				rawTaskStatuses: params.taskStatuses,
			})],
			data: {
				returnedToNodeId: targetId,
				returnedTokenId: existingActiveParent.id,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			},
		};
	}

	// Path B0-wait: Non-barrier child returning to an ancestor currently parked in `waiting_join` ->
	// absorb deliverables/refs/hop into the waiting ancestor without spawning a split-brain second active baton!
	const waitingAncestor = findWaitingJoinAncestorTokenOnNode(state, token, targetId);
	if (waitingAncestor) {
		const traceSeq = state.traceSeq + 1;
		const retTracePtr = `otrc-${traceSeq}`;
		const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
		const parentHopIndex = Math.max(
			nextHopIndex,
			(waitingAncestor.hopIndex ?? Math.max(0, (waitingAncestor.hopLog?.length ?? 1) - 1)) + 1,
		);
		const parentRefMap = new Map<string, IOrchestrationContextRef>();
		for (const ref of refreshContextRefsWithLiveWhiteboards(waitingAncestor.contextRefs, whiteboards, waitingAncestor.whiteboardPointers, parentHopIndex)) {
			parentRefMap.set(ref.ptr, ref);
		}
		for (const ref of staged.contextRefs) {
			parentRefMap.set(ref.ptr, ref);
		}
		const parentWbMap = new Map<string, IOrchestrationWhiteboardPointer>();
		for (const wp of waitingAncestor.whiteboardPointers ?? []) {
			parentWbMap.set(wp.whiteboardId, wp);
		}
		for (const wp of staged.whiteboardPointers) {
			parentWbMap.set(wp.whiteboardId, wp);
		}
		const absorbedHop: IOrchestrationHopLedgerEntry = {
			hop: parentHopIndex,
			tokenId: waitingAncestor.id,
			fromNodeId: token.nodeId,
			toNodeId: targetId,
			event: 'return',
			headline: buildCompactHeadline(`[Returned from ${token.nodeId} (${token.id})] ${staged.headline}`).headline,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			timestamp: now,
		};
		const finishedChild = buildCompletedChild();
		const updatedWaitingParent: IOrchestrationToken = {
			...waitingAncestor,
			hopIndex: parentHopIndex,
			relayDepth: waitingAncestor.relayDepth ?? 0,
			hopLog: [...(waitingAncestor.hopLog ?? []), absorbedHop],
			contextRefs: [...parentRefMap.values()],
			...(parentWbMap.size > 0 ? { whiteboardPointers: [...parentWbMap.values()] } : {}),
			...(mergedTouchedFiles.length > 0
				? { touchedFiles: [...new Set([...(waitingAncestor.touchedFiles ?? []), ...mergedTouchedFiles])] }
				: {}),
			lastActivityAt: now,
		};
		const nextTokens: Record<string, IOrchestrationToken> = {
			...state.tokens,
			[token.id]: finishedChild,
			[waitingAncestor.id]: updatedWaitingParent,
		};
		const nextCursors = recordNodeCursorObservation(
			state.nodeReadCursors,
			token.waveId,
			token.nodeId,
			nextHopIndex,
			staged.allObservedRefs,
			now,
			[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(returnHopEntry)],
		);
		return {
			ok: true,
			state: {
				...state,
				tokens: nextTokens,
				nodeStates: {
					...state.nodeStates,
					[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
					[targetId]: recomputeOrchestrationNodeState(nextTokens, targetId),
				},
				traces: {
					...state.traces,
					[retTracePtr]: {
						ptr: retTracePtr,
						parentPtrs: [token.tracePtr, waitingAncestor.tracePtr],
						nodeId: targetId,
						employeeId: targetAgentId,
						waveId: token.waveId,
						event: 'complete',
						summary: `Return absorbed (${token.nodeId} -> waiting_join ${waitingAncestor.id}): ${staged.headline}`,
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
				returnedToNodeId: targetId,
				returnedTokenId: waitingAncestor.id,
				absorbedIntoWaitingAncestor: true,
				...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
				...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
			},
		};
	}

	// Path B: Direct return token to dispatching superior
	const hasDirectEdge = (staffIndex.outgoingStaffByNode.get(token.nodeId) ?? []).includes(targetId);
	if (!hasDirectEdge && token.returnToNodeId !== targetId) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NO_EDGE',
			error: `No directed return edge from "${token.nodeId}" to "${targetId}" in Orchestration graph.`,
		};
	}

	const tokenSeq = state.tokenSeq + 1;
	const retTokenId = `otok-${tokenSeq}`;
	const handoffTracePtr = `otrc-${state.traceSeq + 1}`;
	const arriveTracePtr = `otrc-${state.traceSeq + 2}`;
	const traceSeq = state.traceSeq + 2;
	const targetAgentId = state.nodeAgentIds[targetId] ?? targetNode.agentId;
	const childReturnHop: IOrchestrationHopLedgerEntry = {
		...returnHopEntry,
		tokenId: retTokenId,
	};
	const forwardedBarrierId = activeBarrier && activeBarrier.status === 'waiting' && activeBarrier.ownerNodeId !== targetId
		? activeBarrier.id
		: undefined;
	const nextBarriers: Record<string, IOrchestrationJoinBarrier> | undefined = forwardedBarrierId && state.joinBarriers
		? {
			...state.joinBarriers,
			[forwardedBarrierId]: {
				...activeBarrier!,
				childTokenIds: activeBarrier!.childTokenIds.map(cid => cid === token.id ? retTokenId : cid),
			},
		}
		: state.joinBarriers;
	const returnedToken: IOrchestrationToken = {
		id: retTokenId,
		waveId: token.waveId,
		nodeId: targetId,
		fromNodeId: token.nodeId,
		holderAgentId: targetAgentId,
		status: 'active',
		parentTokenId: token.id,
		rootTokenId: token.rootTokenId ?? token.id,
		originNodeId: token.originNodeId,
		...(forwardedBarrierId ? { parentJoinBarrierId: forwardedBarrierId, returnToNodeId: activeBarrier!.ownerNodeId } : {}),
		dispatchKind: 'return',
		...(mergedReturnTasks.taskNodeId ? { taskNodeId: mergedReturnTasks.taskNodeId } : {}),
		...(mergedReturnTasks.taskNodeIds ? { taskNodeIds: mergedReturnTasks.taskNodeIds } : {}),
		...(mergedTouchedFiles.length > 0 ? { touchedFiles: mergedTouchedFiles } : {}),
		hopIndex: nextHopIndex,
		relayDepth: nextRelayDepth,
		edgeBounceCounts: incrementEdgeBounceCounts(token.edgeBounceCounts, token.nodeId, targetId),
		lastSummary: staged.headline,
		...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
		hopLog: [...(token.hopLog ?? []), childReturnHop],
		contextRefs: staged.contextRefs,
		compressedHistory: '',
		tracePtr: arriveTracePtr,
		...(staged.whiteboardPointers.length > 0 ? { whiteboardPointers: staged.whiteboardPointers } : {}),
		arrivedAt: now,
		lastActivityAt: now,
		nudgeCount: 0,
	};

	const nextTokens: Record<string, IOrchestrationToken> = {
		...state.tokens,
		[token.id]: {
			...token,
			status: 'handed_off',
			blocked: undefined,
			lastActivityAt: now,
			handedOffToNodeIds: [targetId],
		},
		[retTokenId]: returnedToken,
	};
	const nextCursors = recordNodeCursorObservation(
		state.nodeReadCursors,
		token.waveId,
		token.nodeId,
		nextHopIndex,
		staged.allObservedRefs,
		now,
		[...(token.hopLog ?? []).map(h => buildHopKey(h)), buildHopKey(childReturnHop)],
	);
	const nextState: IOrchestrationRuntimeState = {
		...state,
		tokens: nextTokens,
		nodeStates: {
			...state.nodeStates,
			[token.nodeId]: recomputeOrchestrationNodeState(nextTokens, token.nodeId),
			[targetId]: recomputeOrchestrationNodeState(nextTokens, targetId),
		},
		...(nextBarriers ? { joinBarriers: nextBarriers } : {}),
		traces: {
			...state.traces,
			[handoffTracePtr]: {
				ptr: handoffTracePtr,
				parentPtrs: [token.tracePtr],
				nodeId: token.nodeId,
				employeeId: token.holderAgentId,
				waveId: token.waveId,
				event: 'complete',
				summary: `Return -> ${targetId}: ${staged.headline}`,
				timestamp: now,
			},
			[arriveTracePtr]: {
				ptr: arriveTracePtr,
				parentPtrs: [handoffTracePtr],
				nodeId: targetId,
				employeeId: targetAgentId,
				waveId: token.waveId,
				event: 'mint',
				summary: staged.headline,
				timestamp: now,
			},
		},
		payloadStore,
		payloadSeq: payloadSeqRef.value,
		nodeReadCursors: nextCursors,
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
			token: returnedToken,
			holderAgentId: targetAgentId,
			taskGraph: params.taskGraph,
			rawTaskStatuses: params.taskStatuses,
		})],
		data: {
			returnedToNodeId: targetId,
			returnedTokenId: retTokenId,
			...(staged.payloadPtr ? { payloadPtr: staged.payloadPtr } : {}),
			...(staged.attachedRefPtrs.length > 0 ? { attachedRefPtrs: staged.attachedRefPtrs } : {}),
		},
	};
}

export * from './adeOrchestrationRecovery.js';
export * from './adeOrchestrationLifecycle.js';
export { parseOrchestrationGraph };
