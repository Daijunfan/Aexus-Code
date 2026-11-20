/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	createDefaultMissionBoundary,
	findDirectSupervisorForNode,
	findParentSupervisorForEscalation,
	IMissionBoundaryConfig,
	resolveSupervisorJurisdiction,
	validateMissionFactoryBoundary,
} from './adeMissionBoundary.js';
import {
	getMissionEdgeKind,
	IMissionDagParseResult,
	parseMissionMermaidDag,
} from './adeMissionDag.js';
import type { IAdeOrganizationConfig } from './adeRoleSchema.js';

export type MissionRunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
export type MissionNodeRuntimeStatus = 'idle' | 'active' | 'blocked' | 'waiting_gate' | 'waiting_join' | 'completed' | 'failed';
export type MissionTokenStatus = 'active' | 'blocked' | 'waiting_gate' | 'waiting_join' | 'frozen_failed' | 'recalled' | 'completed';

export type MissionSourceTriggerKind = 'once' | 'interval' | 'cron' | 'event';
export type MissionExternalEventType = 'file_created' | 'file_changed' | 'git_updated' | 'gpu_idle';

export interface IMissionSourceTrigger {
	readonly id: string;
	/** Must satisfy `inDegree === 0 && outDegree >= 1`. */
	readonly nodeId: string;
	readonly kind: MissionSourceTriggerKind;
	readonly enabled: boolean;
	/** For `once`: epoch ms when trigger fires. */
	readonly fireAt?: number;
	/** For `interval`: repeating period in ms (min 5000ms). */
	readonly intervalMs?: number;
	/** For `cron`: standard 5-field cron expression (`min hour dom month dow`). */
	readonly cronExpr?: string;
	/** For `event`: external zero-token condition type. */
	readonly eventType?: MissionExternalEventType;
	/** File path or Git repo path for `file_*` / `git_updated` events. */
	readonly targetPath?: string;
	/** Host where the external event is observed (`'local'` or SSH Cloud Host alias). */
	readonly hostAlias?: string;
	/** GPU utilization ceiling (%) for `gpu_idle` event (default 10%). */
	readonly gpuUtilThresholdPct?: number;
	/** If false (default for triggers), Mission start listens instead of firing immediately. */
	readonly autoStartOnMissionStart?: boolean;
	readonly lastFiredAt?: number;
	readonly fireCount: number;
}

export interface IMissionTraceNode {
	readonly ptr: string;
	readonly parentPtrs: readonly string[];
	readonly nodeId: string;
	readonly employeeId?: string;
	readonly waveId: string;
	readonly event: 'mint' | 'complete' | 'reject' | 'fail_route' | 'fail_escalate' | 'join' | 'gate_approve' | 'gate_reject' | 'recall' | 'trigger';
	readonly summary?: string;
	readonly timestamp: number;
}

export interface IMissionTokenBlockedInfo {
	readonly reason: string;
	readonly startedAt: number;
	readonly maxDurationMs: number;
	readonly expiresAt: number;
	readonly watchPid?: number;
	readonly watchFile?: string;
	readonly hostAlias?: string;
}

export interface IMissionTokenFailureInfo {
	readonly reason: string;
	readonly failedAt: number;
	readonly escalatedToSupervisorId?: string;
	readonly escalatedToInbox?: boolean;
	readonly escalationHistory: readonly {
		readonly fromId: string;
		readonly toId: string;
		readonly note: string;
		readonly at: number;
	}[];
}

export interface IMissionToken {
	readonly id: string;
	readonly missionId: string;
	readonly waveId: string;
	readonly nodeId: string;
	readonly holderAgentId?: string;
	readonly status: MissionTokenStatus;
	/** Verbatim plain-text summary submitted by the immediately preceding step. */
	readonly lastSummary: string;
	/** Rolling compressed history of earlier steps in this wave (bounded high-SNR). */
	readonly compressedHistory: string;
	/** Lightweight pointer into `state.traces` expandable via `token.trace`. */
	readonly tracePtr: string;
	readonly fromNodeId?: string;
	/** When set (via Reviewer/Gate reject), completing this reworked token returns directly to this node, bypassing join barriers & sibling fan-out. */
	readonly returnToNodeId?: string;
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	readonly nudgeCount: number;
	readonly blocked?: IMissionTokenBlockedInfo;
	readonly failure?: IMissionTokenFailureInfo;
}

export interface IMissionJoinBarrier {
	readonly key: string;
	readonly waveId: string;
	readonly targetNodeId: string;
	readonly expectedFromNodeIds: readonly string[];
	readonly arrivedByFrom: Readonly<Record<string, IMissionToken>>;
	readonly skippedFromNodeIds: readonly string[];
}

export interface IMissionRuntimeState {
	readonly missionId: string;
	readonly status: MissionRunStatus;
	readonly silenceTimeoutMinutes: number;
	/** Locked immutable once Mission enters `running` until stopped/reset. */
	readonly silenceTimeoutLocked: boolean;
	readonly boundary: IMissionBoundaryConfig;
	readonly triggers: readonly IMissionSourceTrigger[];
	readonly nodeStates: Readonly<Record<string, MissionNodeRuntimeStatus>>;
	readonly tokens: Readonly<Record<string, IMissionToken>>;
	readonly joinBarriers: Readonly<Record<string, IMissionJoinBarrier>>;
	readonly traces: Readonly<Record<string, IMissionTraceNode>>;
	/** Maps each `waveId` to the entry root node IDs that minted that wave (used for deadlock-free wave-scoped Join Barriers). */
	readonly waveRoots?: Readonly<Record<string, readonly string[]>>;
	/** Effects deferred while Mission is `paused` (flushed automatically upon `resume`). */
	readonly deferredEffects?: readonly MissionEngineEffect[];
	readonly waveSeq: number;
	readonly tokenSeq: number;
	readonly traceSeq: number;
	readonly startedAt?: number;
	readonly completedAt?: number;
	readonly updatedAt: number;
}

export interface IMissionEngineCaller {
	readonly isHumanUser?: boolean;
	readonly isSecretary?: boolean;
	readonly sessionId?: string;
	readonly tier?: number;
	readonly ownerSessionId?: string;
}

export type MissionEngineEffect =
	| {
		readonly kind: 'dispatch_token';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly holderAgentId?: string;
		readonly isRejection?: boolean;
		readonly prompt: string;
	}
	| {
		readonly kind: 'upsert_gate_inbox';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly nodeTitle: string;
		readonly upstreamSummary: string;
		readonly rollbackCandidates: readonly { readonly id: string; readonly title: string }[];
	}
	| {
		readonly kind: 'escalate_to_supervisor';
		readonly missionId: string;
		readonly supervisorId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly reason: string;
	}
	| {
		readonly kind: 'post_inbox';
		readonly missionId: string;
		readonly nodeId?: string;
		readonly tokenId?: string;
		readonly title: string;
		readonly message: string;
		readonly severity: 'critical' | 'info';
		readonly senderAgentId?: string;
	}
	| {
		readonly kind: 'stop_agent';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly holderAgentId?: string;
		readonly reason: string;
	}
	| {
		readonly kind: 'wakeup_agent';
		readonly missionId: string;
		readonly nodeId: string;
		readonly tokenId: string;
		readonly holderAgentId?: string;
		readonly wakeupReason: 'silence_timeout' | 'block_expired' | 'pid_exited' | 'file_ready';
		readonly message: string;
	}
	| {
		readonly kind: 'mermaid_patched';
		readonly missionId: string;
		readonly newMermaidText: string;
		readonly reason?: string;
	};

export interface IMissionEngineTransitionResult<TData = unknown> {
	readonly ok: boolean;
	readonly state: IMissionRuntimeState;
	readonly effects: readonly MissionEngineEffect[];
	readonly data?: TData;
	readonly error?: string;
	readonly code?: 'INVALID_STATE' | 'NOT_FOUND' | 'FORBIDDEN' | 'OUT_OF_JURISDICTION' | 'DANGLING_NODE_VIOLATION' | 'INVALID_DAG' | 'BOUNDARY_VIOLATION' | 'LOCKED_CONFIG';
	readonly outOfScopeNodeIds?: readonly string[];
	readonly danglingNodeIds?: readonly string[];
	readonly parentSupervisorId?: string;
}

const MAX_COMPRESSED_HISTORY_CHARS = 1200;
const MAX_SINGLE_HOP_DIGEST_CHARS = 240;

export function createInitialMissionRuntimeState(
	missionId: string,
	orgConfig: IAdeOrganizationConfig,
	owner?: { readonly ownerSessionId?: string; readonly ownerTier?: number },
	nodeIds: readonly string[] = [],
	silenceTimeoutMinutes = 5,
): IMissionRuntimeState {
	const nodeStates: Record<string, MissionNodeRuntimeStatus> = {};
	for (const nid of nodeIds) {
		nodeStates[nid] = 'idle';
	}
	return {
		missionId,
		status: 'idle',
		silenceTimeoutMinutes: Math.max(1, Math.min(240, Math.round(silenceTimeoutMinutes || 5))),
		silenceTimeoutLocked: false,
		boundary: createDefaultMissionBoundary(orgConfig, owner, nodeIds),
		triggers: [],
		nodeStates,
		tokens: {},
		joinBarriers: {},
		traces: {},
		waveSeq: 0,
		tokenSeq: 0,
		traceSeq: 0,
		updatedAt: Date.now(),
	};
}

/**
 * Parses human-friendly durations such as `10h`, `30m`, `600s`, `1h30m`, or numeric seconds.
 */
export function parseDurationMs(raw: string | number | undefined): number | undefined {
	if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
		return Math.round(raw);
	}
	if (typeof raw !== 'string') {
		return undefined;
	}
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) {
		return undefined;
	}
	if (/^\d+$/.test(trimmed)) {
		return Number.parseInt(trimmed, 10) * 1000;
	}
	let totalMs = 0;
	let matchedAny = false;
	const tokenRe = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d)/g;
	let m: RegExpExecArray | null;
	while ((m = tokenRe.exec(trimmed)) !== null) {
		matchedAny = true;
		const val = Number.parseFloat(m[1]);
		const unit = m[2];
		if (unit === 'ms') { totalMs += val; }
		else if (unit === 's' || unit === 'sec' || unit === 'secs') { totalMs += val * 1000; }
		else if (unit === 'm' || unit === 'min' || unit === 'mins') { totalMs += val * 60_000; }
		else if (unit === 'h' || unit === 'hr' || unit === 'hrs') { totalMs += val * 3_600_000; }
		else if (unit === 'd') { totalMs += val * 86_400_000; }
	}
	return matchedAny && totalMs > 0 ? Math.round(totalMs) : undefined;
}

function budgetHistoryLines(lines: readonly string[]): string {
	const cleaned = lines
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('... ('));
	if (cleaned.length === 0) {
		return '';
	}
	let joined = cleaned.join('\n');
	if (joined.length <= MAX_COMPRESSED_HISTORY_CHARS) {
		return joined;
	}
	// Preserve first anchor milestone + as many most-recent hops as fit within budget (line-safe)
	const first = cleaned[0];
	const keptTail: string[] = [];
	let budget = MAX_COMPRESSED_HISTORY_CHARS - first.length - 48;
	for (let i = cleaned.length - 1; i >= 1; i--) {
		const candidate = cleaned[i];
		if (candidate.length + 1 <= budget) {
			keptTail.unshift(candidate);
			budget -= candidate.length + 1;
		} else {
			break;
		}
	}
	const omitted = cleaned.length - 1 - keptTail.length;
	joined = omitted > 0
		? [first, `... (${omitted} earlier step(s) condensed; use \`aexus-ade token trace <ptr>\` to expand)`, ...keptTail].join('\n')
		: [first, ...keptTail].join('\n');
	return joined;
}

/**
 * Deterministic rolling history compressor: folds the previous `lastSummary` into `compressedHistory`
 * while keeping total size strictly bounded so long Mission chains never blow agent context.
 */
export function compressTokenHistory(
	prevCompressed: string,
	previousLastSummary: string,
	previousNodeId?: string,
): string {
	const cleaned = previousLastSummary.replace(/\s+/g, ' ').trim();
	if (!cleaned) {
		return prevCompressed.trim();
	}
	const digest = cleaned.length > MAX_SINGLE_HOP_DIGEST_CHARS
		? `${cleaned.slice(0, MAX_SINGLE_HOP_DIGEST_CHARS - 1)}…`
		: cleaned;
	const line = previousNodeId ? `- [${previousNodeId}] ${digest}` : `- ${digest}`;
	const existingLines = prevCompressed
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('... ('));
	return budgetHistoryLines([...existingLines, line]);
}

/**
 * Expands a lightweight `tracePtr` into chronological traversal steps (including rejection loops & merged branches).
 */
export function expandTracePointer(
	state: Pick<IMissionRuntimeState, 'traces'>,
	tracePtr: string,
	maxEntries = 100,
): readonly IMissionTraceNode[] {
	const visited = new Set<string>();
	const collected: IMissionTraceNode[] = [];
	const walk = (ptr: string) => {
		if (!ptr || visited.has(ptr) || collected.length >= maxEntries) {
			return;
		}
		const node = state.traces[ptr];
		if (!node) {
			return;
		}
		visited.add(ptr);
		for (const parentPtr of node.parentPtrs) {
			walk(parentPtr);
		}
		if (collected.length < maxEntries) {
			collected.push(node);
		}
	};
	walk(tracePtr);
	return collected.sort((a, b) => a.timestamp - b.timestamp || a.ptr.localeCompare(b.ptr));
}

function buildTokenDispatchPrompt(
	token: IMissionToken,
	nodeLabel: string,
	isRejection = false,
): string {
	const lines: string[] = [
		`[Mission Token Dispatched — ${isRejection ? 'REVISION REQUESTED' : 'ACTIVE'}]`,
		`- Mission: \`${token.missionId}\` | Node: \`${token.nodeId}\` (${nodeLabel}) | Token: \`${token.id}\` | Wave: \`${token.waveId}\``,
		`- Trace Pointer: \`${token.tracePtr}\` (expand only if needed: \`aexus-ade token trace ${token.tracePtr} --json\`)`,
		'',
		'### Previous Step Summary (`last_summary`)',
		token.lastSummary || '(Initial entry step — no upstream summary)',
	];
	if (token.compressedHistory) {
		lines.push('', '### Compressed Earlier History (`compressed_history`)', token.compressedHistory);
	}
	lines.push(
		'',
		'### Completion / Reporting Commands',
		`- Complete: \`aexus-ade token complete ${token.id} --summary "<plain human summary of concrete changes & conclusions>" --json\``,
		`- Long-running wait: \`aexus-ade token block ${token.id} --duration <e.g. 2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>] --json\``,
		`- Reviewer reject: \`aexus-ade token reject ${token.id} --reason "<concrete defects>" --json\``,
		`- Unrecoverable failure: \`aexus-ade token fail ${token.id} --reason "<root cause>" --json\``,
	);
	return lines.join('\n');
}

interface IMutableEngineContext {
	status: MissionRunStatus;
	silenceTimeoutMinutes: number;
	silenceTimeoutLocked: boolean;
	boundary: IMissionBoundaryConfig;
	triggers: IMissionSourceTrigger[];
	nodeStates: Record<string, MissionNodeRuntimeStatus>;
	tokens: Record<string, IMissionToken>;
	joinBarriers: Record<string, IMissionJoinBarrier>;
	traces: Record<string, IMissionTraceNode>;
	waveRoots: Record<string, readonly string[]>;
	deferredEffects: MissionEngineEffect[];
	waveSeq: number;
	tokenSeq: number;
	traceSeq: number;
	startedAt?: number;
	completedAt?: number;
	updatedAt: number;
	effects: MissionEngineEffect[];
}

function cloneMutable(state: IMissionRuntimeState, now: number): IMutableEngineContext {
	return {
		status: state.status,
		silenceTimeoutMinutes: state.silenceTimeoutMinutes,
		silenceTimeoutLocked: state.silenceTimeoutLocked,
		boundary: state.boundary,
		triggers: [...state.triggers],
		nodeStates: { ...state.nodeStates },
		tokens: { ...state.tokens },
		joinBarriers: { ...state.joinBarriers },
		traces: { ...state.traces },
		waveRoots: { ...(state.waveRoots ?? {}) },
		deferredEffects: [...(state.deferredEffects ?? [])],
		waveSeq: state.waveSeq,
		tokenSeq: state.tokenSeq,
		traceSeq: state.traceSeq,
		startedAt: state.startedAt,
		completedAt: state.completedAt,
		updatedAt: now,
		effects: [],
	};
}

function freezeMutable(missionId: string, ctx: IMutableEngineContext): IMissionRuntimeState {
	return {
		missionId,
		status: ctx.status,
		silenceTimeoutMinutes: ctx.silenceTimeoutMinutes,
		silenceTimeoutLocked: ctx.silenceTimeoutLocked,
		boundary: ctx.boundary,
		triggers: ctx.triggers,
		nodeStates: ctx.nodeStates,
		tokens: ctx.tokens,
		joinBarriers: ctx.joinBarriers,
		traces: ctx.traces,
		...(Object.keys(ctx.waveRoots).length > 0 ? { waveRoots: ctx.waveRoots } : {}),
		...(ctx.deferredEffects.length > 0 ? { deferredEffects: ctx.deferredEffects } : {}),
		waveSeq: ctx.waveSeq,
		tokenSeq: ctx.tokenSeq,
		traceSeq: ctx.traceSeq,
		startedAt: ctx.startedAt,
		completedAt: ctx.completedAt,
		updatedAt: ctx.updatedAt,
	};
}

function appendTrace(
	ctx: IMutableEngineContext,
	entry: Omit<IMissionTraceNode, 'ptr'>,
): string {
	ctx.traceSeq += 1;
	const ptr = `trc-${ctx.traceSeq}`;
	ctx.traces[ptr] = { ptr, ...entry };
	return ptr;
}

function getIncomingEdges(graph: Pick<IMissionDagParseResult, 'edges'>, nodeId: string) {
	return graph.edges.filter(e => e.to === nodeId);
}

function getOutgoingEdges(graph: Pick<IMissionDagParseResult, 'edges'>, nodeId: string, kind?: 'success' | 'fail') {
	return graph.edges.filter(e => e.from === nodeId && (!kind || getMissionEdgeKind(e) === kind));
}

function computeWaveExpectedIncoming(
	ctx: IMutableEngineContext,
	graph: Pick<IMissionDagParseResult, 'edges'>,
	waveId: string,
	targetNodeId: string,
): readonly string[] {
	const incoming = getIncomingEdges(graph, targetNodeId).map(e => e.from);
	const roots = ctx.waveRoots[waveId];
	if (!roots || roots.length === 0) {
		return incoming;
	}
	const reachable = collectReachableNodes(graph, roots);
	const scoped = incoming.filter(fromId => reachable.has(fromId));
	return scoped.length > 0 ? scoped : incoming;
}

function deliverTokenToTarget(
	missionId: string,
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	params: {
		readonly targetNodeId: string;
		readonly fromNodeId?: string;
		readonly waveId: string;
		readonly lastSummary: string;
		readonly compressedHistory: string;
		readonly tracePtr: string;
		readonly now: number;
		readonly isRejection?: boolean;
		readonly bypassJoin?: boolean;
		readonly returnToNodeId?: string;
	},
): IMissionToken | undefined {
	const targetNode = graph.nodes.find(n => n.id === params.targetNodeId);
	if (!targetNode) {
		return undefined;
	}
	const baseExpected = computeWaveExpectedIncoming(ctx, graph, params.waveId, targetNode.id);
	const expectedFrom = (params.fromNodeId && baseExpected.length > 0 && !baseExpected.includes(params.fromNodeId))
		? [...baseExpected, params.fromNodeId]
		: baseExpected;

	// Wave-scoped Multi-branch Join Barrier (for non-rejection forward flow when >=2 incoming branches belong to this wave)
	if (!params.bypassJoin && !params.isRejection && expectedFrom.length > 1 && params.fromNodeId) {
		const barrierKey = `${params.waveId}::${targetNode.id}`;
		const existing = ctx.joinBarriers[barrierKey] ?? {
			key: barrierKey,
			waveId: params.waveId,
			targetNodeId: targetNode.id,
			expectedFromNodeIds: [...expectedFrom],
			arrivedByFrom: {},
			skippedFromNodeIds: [],
		};
		ctx.tokenSeq += 1;
		const waitingTok: IMissionToken = {
			id: `tok-${ctx.tokenSeq}`,
			missionId,
			waveId: params.waveId,
			nodeId: targetNode.id,
			holderAgentId: ctx.boundary.nodeAssignments[targetNode.id]?.agentId,
			status: 'waiting_join',
			lastSummary: params.lastSummary,
			compressedHistory: params.compressedHistory,
			tracePtr: params.tracePtr,
			fromNodeId: params.fromNodeId,
			arrivedAt: params.now,
			lastActivityAt: params.now,
			nudgeCount: 0,
		};
		const prevArrived = existing.arrivedByFrom[params.fromNodeId];
		if (prevArrived && ctx.tokens[prevArrived.id]) {
			ctx.tokens[prevArrived.id] = { ...ctx.tokens[prevArrived.id], status: 'recalled', lastActivityAt: params.now };
		}
		const nextArrived = { ...existing.arrivedByFrom, [params.fromNodeId]: waitingTok };
		const nextSkipped = existing.skippedFromNodeIds.filter(id => id !== params.fromNodeId);
		const updatedBarrier: IMissionJoinBarrier = {
			...existing,
			expectedFromNodeIds: [...expectedFrom],
			arrivedByFrom: nextArrived,
			skippedFromNodeIds: nextSkipped,
		};
		ctx.joinBarriers[barrierKey] = updatedBarrier;
		ctx.nodeStates[targetNode.id] = 'waiting_join';
		return tryReleaseJoinBarrier(missionId, ctx, graph, barrierKey, params.now);
	}

	return materializeAndDispatchToken(missionId, ctx, graph, {
		targetNodeId: targetNode.id,
		fromNodeId: params.fromNodeId,
		waveId: params.waveId,
		lastSummary: params.lastSummary,
		compressedHistory: params.compressedHistory,
		tracePtr: params.tracePtr,
		now: params.now,
		isRejection: params.isRejection,
		returnToNodeId: params.returnToNodeId,
	});
}

function tryReleaseJoinBarrier(
	missionId: string,
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	barrierKey: string,
	now: number,
): IMissionToken | undefined {
	const barrier = ctx.joinBarriers[barrierKey];
	if (!barrier) {
		return undefined;
	}
	const skippedSet = new Set(barrier.skippedFromNodeIds);
	const allAccounted = barrier.expectedFromNodeIds.every(fromId =>
		Boolean(barrier.arrivedByFrom[fromId]) || skippedSet.has(fromId),
	);
	if (!allAccounted) {
		return undefined;
	}
	const arrivedList = barrier.expectedFromNodeIds
		.map(fromId => barrier.arrivedByFrom[fromId])
		.filter((t): t is IMissionToken => Boolean(t));
	delete ctx.joinBarriers[barrierKey];

	for (const arrivedTok of arrivedList) {
		if (ctx.tokens[arrivedTok.id] && ctx.tokens[arrivedTok.id].status === 'waiting_join') {
			ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'completed', lastActivityAt: now };
		}
	}

	if (arrivedList.length === 0) {
		// Every incoming branch was skipped -> propagate skip downstream!
		for (const outEdge of getOutgoingEdges(graph, barrier.targetNodeId)) {
			markBranchSkipped(missionId, ctx, graph, barrier.waveId, barrier.targetNodeId, outEdge.to, now);
		}
		return undefined;
	}

	const mergedLastSummary = arrivedList
		.map(t => `[${t.fromNodeId ?? t.nodeId}] ${t.lastSummary}`.trim())
		.join('\n');
	const uniqueHistoryLines: string[] = [];
	const seenLines = new Set<string>();
	for (const t of arrivedList) {
		for (const line of t.compressedHistory.split('\n').map(l => l.trim()).filter(Boolean)) {
			if (!seenLines.has(line)) {
				seenLines.add(line);
				uniqueHistoryLines.push(line);
			}
		}
	}
	const mergedHistory = budgetHistoryLines(uniqueHistoryLines);
	const joinPtr = appendTrace(ctx, {
		parentPtrs: arrivedList.map(t => t.tracePtr),
		nodeId: barrier.targetNodeId,
		employeeId: ctx.boundary.nodeAssignments[barrier.targetNodeId]?.agentId,
		waveId: barrier.waveId,
		event: 'join',
		summary: `Merged ${arrivedList.length} branch(es): ${arrivedList.map(t => t.fromNodeId ?? '?').join(', ')}`,
		timestamp: now,
	});

	return materializeAndDispatchToken(missionId, ctx, graph, {
		targetNodeId: barrier.targetNodeId,
		fromNodeId: arrivedList[arrivedList.length - 1]?.fromNodeId,
		waveId: barrier.waveId,
		lastSummary: mergedLastSummary,
		compressedHistory: mergedHistory,
		tracePtr: joinPtr,
		now,
	});
}

function markBranchSkipped(
	missionId: string,
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	waveId: string,
	fromNodeId: string,
	targetNodeId: string,
	now: number,
): void {
	const expectedFrom = computeWaveExpectedIncoming(ctx, graph, waveId, targetNodeId);
	if (!expectedFrom.includes(fromNodeId)) {
		return;
	}
	if (expectedFrom.length <= 1) {
		// Target has no other active upstream path in this wave -> cascade skip downstream
		for (const outEdge of getOutgoingEdges(graph, targetNodeId)) {
			markBranchSkipped(missionId, ctx, graph, waveId, targetNodeId, outEdge.to, now);
		}
		return;
	}
	const barrierKey = `${waveId}::${targetNodeId}`;
	const existing = ctx.joinBarriers[barrierKey] ?? {
		key: barrierKey,
		waveId,
		targetNodeId,
		expectedFromNodeIds: [...expectedFrom],
		arrivedByFrom: {},
		skippedFromNodeIds: [],
	};
	if (existing.arrivedByFrom[fromNodeId] || existing.skippedFromNodeIds.includes(fromNodeId)) {
		return;
	}
	ctx.joinBarriers[barrierKey] = {
		...existing,
		expectedFromNodeIds: [...expectedFrom],
		skippedFromNodeIds: [...existing.skippedFromNodeIds, fromNodeId],
	};
	tryReleaseJoinBarrier(missionId, ctx, graph, barrierKey, now);
}

function materializeAndDispatchToken(
	missionId: string,
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	params: {
		readonly targetNodeId: string;
		readonly fromNodeId?: string;
		readonly waveId: string;
		readonly lastSummary: string;
		readonly compressedHistory: string;
		readonly tracePtr: string;
		readonly now: number;
		readonly isRejection?: boolean;
		readonly returnToNodeId?: string;
	},
): IMissionToken {
	const targetNode = graph.nodes.find(n => n.id === params.targetNodeId)!;
	const holderAgentId = ctx.boundary.nodeAssignments[targetNode.id]?.agentId;
	ctx.tokenSeq += 1;
	const isGate = targetNode.kind === 'gate';
	const token: IMissionToken = {
		id: `tok-${ctx.tokenSeq}`,
		missionId,
		waveId: params.waveId,
		nodeId: targetNode.id,
		holderAgentId,
		status: isGate ? 'waiting_gate' : 'active',
		lastSummary: params.lastSummary,
		compressedHistory: params.compressedHistory,
		tracePtr: params.tracePtr,
		fromNodeId: params.fromNodeId,
		...(params.returnToNodeId ? { returnToNodeId: params.returnToNodeId } : {}),
		arrivedAt: params.now,
		lastActivityAt: params.now,
		nudgeCount: 0,
	};
	ctx.tokens[token.id] = token;
	ctx.nodeStates[targetNode.id] = isGate ? 'waiting_gate' : 'active';

	if (isGate) {
		const traceAncestors = new Set(expandTracePointer(ctx, params.tracePtr).map(t => t.nodeId));
		const incomingEdges = getIncomingEdges(graph, targetNode.id);
		const candidateEdges = incomingEdges.filter(e => traceAncestors.size === 0 || traceAncestors.has(e.from));
		const rollbackCandidates = (candidateEdges.length > 0 ? candidateEdges : incomingEdges).map(e => {
			const src = graph.nodes.find(n => n.id === e.from);
			return { id: e.from, title: src?.label ?? e.from };
		});
		ctx.effects.push({
			kind: 'upsert_gate_inbox',
			missionId,
			nodeId: targetNode.id,
			tokenId: token.id,
			nodeTitle: targetNode.label,
			upstreamSummary: params.lastSummary,
			rollbackCandidates,
		});
	} else {
		const dispatchEffect: MissionEngineEffect = {
			kind: 'dispatch_token',
			missionId,
			nodeId: targetNode.id,
			tokenId: token.id,
			holderAgentId,
			isRejection: params.isRejection,
			prompt: buildTokenDispatchPrompt(token, targetNode.label, params.isRejection),
		};
		if (ctx.status === 'paused') {
			ctx.deferredEffects.push(dispatchEffect);
		} else {
			ctx.effects.push(dispatchEffect);
		}
	}
	return token;
}

function checkMissionCompletion(ctx: IMutableEngineContext): void {
	if (ctx.status !== 'running') {
		return;
	}
	const hasLiveTokens = Object.values(ctx.tokens).some(t =>
		t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join' || t.status === 'frozen_failed',
	);
	const hasPendingBarriers = Object.keys(ctx.joinBarriers).length > 0;
	const hasEnabledTriggers = ctx.triggers.some(tr => tr.enabled);
	if (!hasLiveTokens && !hasPendingBarriers && !hasEnabledTriggers) {
		ctx.status = 'completed';
		ctx.completedAt = ctx.updatedAt;
	}
}

/**
 * Starts a Mission: validates factory boundary, locks `silenceTimeoutMinutes`, and mints
 * initial wave tokens on all non-trigger-gated entry (`inDegree === 0`) nodes.
 */
export function startMissionRun(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	orgConfig: IAdeOrganizationConfig,
	options?: {
		readonly silenceTimeoutMinutes?: number;
		readonly initialPrompt?: string;
		readonly requireAssignedNodes?: boolean;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly waveId?: string; readonly mintedTokenIds: readonly string[] }> {
	if (graph.error || graph.nodes.length === 0) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_DAG',
			error: graph.error || 'Cannot start an empty Mission DAG.',
		};
	}
	const boundaryCheck = validateMissionFactoryBoundary(orgConfig, state.boundary, graph);
	if (!boundaryCheck.valid) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'BOUNDARY_VIOLATION',
			error: boundaryCheck.errors.join(' '),
		};
	}
	if (state.status === 'running' || state.status === 'paused') {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `Mission is already ${state.status}. Resume or stop it before starting a new run.`,
		};
	}
	if (options?.requireAssignedNodes) {
		const unassigned = graph.nodes
			.filter(n => n.kind !== 'gate' && !state.boundary.nodeAssignments[n.id]?.agentId)
			.map(n => n.id);
		if (unassigned.length > 0) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Cannot start Mission: unassigned task node(s): ${unassigned.join(', ')}. Bind an employee to every non-gate node first.`,
			};
		}
	}

	const now = options?.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	if (options?.silenceTimeoutMinutes !== undefined) {
		if (ctx.silenceTimeoutLocked) {
			return {
				ok: false,
				state,
				effects: [],
				code: 'LOCKED_CONFIG',
				error: 'Silence timeout is locked once Mission has started.',
			};
		}
		ctx.silenceTimeoutMinutes = Math.max(1, Math.min(240, Math.round(options.silenceTimeoutMinutes)));
	}
	ctx.silenceTimeoutLocked = true;
	ctx.status = 'running';
	ctx.startedAt = now;
	ctx.completedAt = undefined;
	ctx.deferredEffects = [];
	for (const node of graph.nodes) {
		ctx.nodeStates[node.id] = 'idle';
	}

	// Find inDegree === 0 source nodes
	const inDeg = new Map<string, number>();
	for (const n of graph.nodes) { inDeg.set(n.id, 0); }
	for (const e of graph.edges) { inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1); }
	const triggerByNode = new Map<string, IMissionSourceTrigger[]>();
	for (const tr of ctx.triggers) {
		if (tr.enabled) {
			const list = triggerByNode.get(tr.nodeId) ?? [];
			list.push(tr);
			triggerByNode.set(tr.nodeId, list);
		}
	}

	const immediateRoots = graph.nodes.filter(n => {
		if ((inDeg.get(n.id) ?? 0) !== 0) { return false; }
		const nodeTriggers = triggerByNode.get(n.id);
		if (!nodeTriggers || nodeTriggers.length === 0) { return true; }
		return nodeTriggers.some(tr => tr.autoStartOnMissionStart === true);
	});

	const mintedTokenIds: string[] = [];
	let waveId: string | undefined;
	if (immediateRoots.length > 0) {
		ctx.waveSeq += 1;
		waveId = `wave-${ctx.waveSeq}`;
		ctx.waveRoots[waveId] = immediateRoots.map(r => r.id);
		for (const root of immediateRoots) {
			const ptr = appendTrace(ctx, {
				parentPtrs: [],
				nodeId: root.id,
				employeeId: ctx.boundary.nodeAssignments[root.id]?.agentId,
				waveId,
				event: 'mint',
				summary: options?.initialPrompt?.trim() || 'Mission started',
				timestamp: now,
			});
			const tok = materializeAndDispatchToken(state.missionId, ctx, graph, {
				targetNodeId: root.id,
				waveId,
				lastSummary: options?.initialPrompt?.trim() || 'Mission started — begin execution of this step.',
				compressedHistory: '',
				tracePtr: ptr,
				now,
			});
			mintedTokenIds.push(tok.id);
		}
	}

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { waveId, mintedTokenIds },
	};
}

export function setMissionSilenceTimeout(
	state: IMissionRuntimeState,
	minutes: number,
	now = Date.now(),
): IMissionEngineTransitionResult {
	if (state.silenceTimeoutLocked || state.status === 'running' || state.status === 'paused') {
		return {
			ok: false,
			state,
			effects: [],
			code: 'LOCKED_CONFIG',
			error: 'Silence timeout is locked while Mission is running/paused. Stop the Mission before changing it.',
		};
	}
	const clamped = Math.max(1, Math.min(240, Math.round(minutes)));
	const ctx = cloneMutable(state, now);
	ctx.silenceTimeoutMinutes = clamped;
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: [] };
}

export function pauseMissionRun(state: IMissionRuntimeState, now = Date.now()): IMissionEngineTransitionResult {
	if (state.status !== 'running') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Cannot pause Mission in state "${state.status}".` };
	}
	const ctx = cloneMutable(state, now);
	ctx.status = 'paused';
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: [] };
}

export function resumeMissionRun(state: IMissionRuntimeState, now = Date.now()): IMissionEngineTransitionResult {
	if (state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Cannot resume Mission in state "${state.status}".` };
	}
	const ctx = cloneMutable(state, now);
	ctx.status = 'running';
	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (tok.status === 'active') {
			ctx.tokens[tid] = { ...tok, lastActivityAt: now };
		}
	}
	if (ctx.deferredEffects.length > 0) {
		for (const eff of ctx.deferredEffects) {
			if (eff.kind === 'dispatch_token') {
				const liveTok = ctx.tokens[eff.tokenId];
				if (!liveTok || liveTok.status !== 'active') {
					continue;
				}
			}
			ctx.effects.push(eff);
		}
		ctx.deferredEffects = [];
	}
	checkMissionCompletion(ctx);
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
}

export function stopMissionRun(state: IMissionRuntimeState, now = Date.now()): IMissionEngineTransitionResult {
	const ctx = cloneMutable(state, now);
	ctx.status = 'stopped';
	ctx.silenceTimeoutLocked = false;
	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
			ctx.tokens[tid] = { ...tok, status: 'recalled', blocked: undefined, lastActivityAt: now };
			if (tok.status === 'active' || tok.status === 'blocked') {
				ctx.effects.push({
					kind: 'stop_agent',
					missionId: state.missionId,
					nodeId: tok.nodeId,
					tokenId: tok.id,
					holderAgentId: tok.holderAgentId,
					reason: 'Mission stopped',
				});
			}
		}
	}
	ctx.joinBarriers = {};
	ctx.waveRoots = {};
	ctx.deferredEffects = [];
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
}

function isAuthorizedTokenHolder(
	state: IMissionRuntimeState,
	token: IMissionToken,
	callerAgentId: string | undefined,
): boolean {
	if (callerAgentId === undefined) {
		return true;
	}
	// Live node assignment takes precedence over historical holderAgentId so mid-run employee reassignment hands off authority cleanly.
	const assignedHolder = state.boundary.nodeAssignments[token.nodeId]?.agentId ?? token.holderAgentId;
	return Boolean(assignedHolder && assignedHolder === callerAgentId);
}

function isValidUpstreamRollbackTarget(
	state: Pick<IMissionRuntimeState, 'traces'>,
	graph: IMissionDagParseResult,
	currentNodeId: string,
	targetNodeId: string,
	tracePtr: string,
): boolean {
	if (!targetNodeId || targetNodeId === currentNodeId) {
		return false;
	}
	if (!graph.nodes.some(n => n.id === targetNodeId)) {
		return false;
	}
	// Target must be a genuine DAG upstream ancestor of currentNodeId
	if (!collectReachableNodes(graph, [targetNodeId]).has(currentNodeId)) {
		return false;
	}
	// And must have appeared in this token's traversal trace
	const traceAncestors = new Set(
		expandTracePointer(state, tracePtr)
			.map(entry => entry.nodeId)
			.filter(nid => nid !== currentNodeId),
	);
	return traceAncestors.has(targetNodeId);
}

/**
 * In-graph employee completes current token with a plain human-readable summary.
 */
export function completeMissionToken(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string; readonly now?: number },
): IMissionEngineTransitionResult<{ readonly nextTokenIds: readonly string[] }> {
	if (state.status !== 'running' && state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active token "${params.tokenId}" not found.` };
	}
	if (!isAuthorizedTokenHolder(state, token, params.callerAgentId)) {
		return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
	}
	const summary = params.summary.trim();
	if (!summary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concrete plain-text summary is required to complete a token.' };
	}

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[token.id] = { ...token, status: 'completed', blocked: undefined, lastActivityAt: now };
	ctx.nodeStates[token.nodeId] = 'completed';

	const nextCompressed = compressTokenHistory(token.compressedHistory, token.lastSummary, token.fromNodeId);
	const donePtr = appendTrace(ctx, {
		parentPtrs: [token.tracePtr],
		nodeId: token.nodeId,
		employeeId: token.holderAgentId,
		waveId: token.waveId,
		event: 'complete',
		summary,
		timestamp: now,
	});

	const nextTokenIds: string[] = [];
	// Mark untaken fail edges as skipped before routing (including rework waves) so downstream join barriers never deadlock.
	for (const failEdge of getOutgoingEdges(graph, token.nodeId, 'fail')) {
		markBranchSkipped(state.missionId, ctx, graph, token.waveId, token.nodeId, failEdge.to, now);
	}

	// Rework return routing: follow ONLY outgoing success edges leading to `returnToNodeId`,
	// relying on the rework wave's `waveRoots` for exact join-barrier scoping (1-hop, multi-hop linear,
	// multi-hop fork-join, and diamond reworks all converge with zero sibling re-runs or duplicate tokens).
	if (token.returnToNodeId && graph.nodes.some(n => n.id === token.returnToNodeId)) {
		const returnTarget = token.returnToNodeId;
		const onPathSuccessors = getOutgoingEdges(graph, token.nodeId, 'success')
			.filter(e => e.to === returnTarget || collectReachableNodes(graph, [e.to]).has(returnTarget));
		if (onPathSuccessors.length > 0) {
			for (const edge of onPathSuccessors) {
				const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
					targetNodeId: edge.to,
					fromNodeId: token.nodeId,
					waveId: token.waveId,
					lastSummary: summary,
					compressedHistory: nextCompressed,
					tracePtr: donePtr,
					now,
					returnToNodeId: edge.to === returnTarget ? undefined : returnTarget,
				});
				if (delivered) {
					nextTokenIds.push(delivered.id);
				}
			}
		} else {
			// Fallback if a mid-run patch removed all paths from token.nodeId to returnTarget
			const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
				targetNodeId: returnTarget,
				fromNodeId: token.nodeId,
				waveId: token.waveId,
				lastSummary: summary,
				compressedHistory: nextCompressed,
				tracePtr: donePtr,
				now,
				bypassJoin: true,
			});
			if (delivered) {
				nextTokenIds.push(delivered.id);
			}
		}
		checkMissionCompletion(ctx);
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { nextTokenIds },
		};
	}

	for (const succEdge of getOutgoingEdges(graph, token.nodeId, 'success')) {
		const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
			targetNodeId: succEdge.to,
			fromNodeId: token.nodeId,
			waveId: token.waveId,
			lastSummary: summary,
			compressedHistory: nextCompressed,
			tracePtr: donePtr,
			now,
		});
		if (delivered) {
			nextTokenIds.push(delivered.id);
		}
	}

	checkMissionCompletion(ctx);
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { nextTokenIds },
	};
}

/**
 * In-graph Reviewer rejects upstream deliverable and routes token back to previous step
 * without adding any backward arrow to the static Mermaid DAG.
 */
export function rejectMissionToken(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: { readonly tokenId: string; readonly reason: string; readonly targetNodeId?: string; readonly callerAgentId?: string; readonly now?: number },
): IMissionEngineTransitionResult<{ readonly bouncedTokenId: string; readonly targetNodeId: string }> {
	if (state.status !== 'running' && state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active token "${params.tokenId}" not found.` };
	}
	if (!isAuthorizedTokenHolder(state, token, params.callerAgentId)) {
		return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
	}
	const explicitTarget = params.targetNodeId?.trim();
	const defaultTarget = (token.fromNodeId && isValidUpstreamRollbackTarget(state, graph, token.nodeId, token.fromNodeId, token.tracePtr))
		? token.fromNodeId
		: getIncomingEdges(graph, token.nodeId).map(e => e.from).find(fid => isValidUpstreamRollbackTarget(state, graph, token.nodeId, fid, token.tracePtr));
	const targetNodeId = explicitTarget || defaultTarget;
	if (!targetNodeId || !isValidUpstreamRollbackTarget(state, graph, token.nodeId, targetNodeId, token.tracePtr)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: explicitTarget
				? `Rejection target "${explicitTarget}" is not an executed upstream ancestor of node "${token.nodeId}".`
				: `No executed upstream target node available for rejection from "${token.nodeId}".`,
		};
	}
	const reason = params.reason.trim();
	if (!reason) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A rejection reason is required.' };
	}

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[token.id] = { ...token, status: 'completed', blocked: undefined, lastActivityAt: now };
	ctx.nodeStates[token.nodeId] = 'idle';

	ctx.waveSeq += 1;
	const reworkWaveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[reworkWaveId] = [targetNodeId];

	const nextCompressed = compressTokenHistory(token.compressedHistory, token.lastSummary, token.fromNodeId);
	const rejPtr = appendTrace(ctx, {
		parentPtrs: [token.tracePtr],
		nodeId: token.nodeId,
		employeeId: token.holderAgentId,
		waveId: reworkWaveId,
		event: 'reject',
		summary: `Rejected -> ${targetNodeId}: ${reason}`,
		timestamp: now,
	});

	const bounced = deliverTokenToTarget(state.missionId, ctx, graph, {
		targetNodeId,
		fromNodeId: token.nodeId,
		waveId: reworkWaveId,
		lastSummary: `[Rejected by ${token.nodeId}] ${reason}`,
		compressedHistory: nextCompressed,
		tracePtr: rejPtr,
		now,
		isRejection: true,
		bypassJoin: true,
		returnToNodeId: token.nodeId,
	})!;

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { bouncedTokenId: bounced.id, targetNodeId },
	};
}

/**
 * Declares an active token blocked on a long-running task (e.g., GPU training / build / benchmark),
 * pausing routine silence nudges until early wakeup condition (PID exit / file ready) or max duration expires.
 */
export function blockMissionToken(
	state: IMissionRuntimeState,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly maxDurationMs: number;
		readonly watchPid?: number;
		readonly watchFile?: string;
		readonly hostAlias?: string;
		readonly callerAgentId?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult {
	if (state.status !== 'running' && state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active token "${params.tokenId}" not found.` };
	}
	if (!isAuthorizedTokenHolder(state, token, params.callerAgentId)) {
		return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
	}
	const durationMs = Math.max(10_000, Math.min(7 * 86_400_000, Math.round(params.maxDurationMs)));
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[token.id] = {
		...token,
		status: 'blocked',
		lastActivityAt: now,
		blocked: {
			reason: params.reason.trim() || 'Long-running task in progress',
			startedAt: now,
			maxDurationMs: durationMs,
			expiresAt: now + durationMs,
			...(typeof params.watchPid === 'number' && params.watchPid > 0 ? { watchPid: Math.floor(params.watchPid) } : {}),
			...(params.watchFile?.trim() ? { watchFile: params.watchFile.trim() } : {}),
			...(params.hostAlias?.trim() ? { hostAlias: params.hostAlias.trim() } : {}),
		},
	};
	ctx.nodeStates[token.nodeId] = 'blocked';
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: [] };
}

/**
 * Transitions a `blocked` token back to `active` upon early condition match (PID exit / file ready)
 * or max duration expiration, or emits a silence nudge for a silent `active` token.
 */
export function recordWatchdogWakeup(
	state: IMissionRuntimeState,
	params: {
		readonly tokenId: string;
		readonly reason: 'silence_timeout' | 'block_expired' | 'pid_exited' | 'file_ready';
		readonly detail?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult {
	if (state.status !== 'running') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Mission is not running.' };
	}
	const token = state.tokens[params.tokenId];
	if (!token) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Token "${params.tokenId}" not found.` };
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);

	if (params.reason === 'silence_timeout') {
		if (token.status !== 'active') {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Token is not active.' };
		}
		ctx.tokens[token.id] = {
			...token,
			lastNudgeAt: now,
			nudgeCount: token.nudgeCount + 1,
		};
		ctx.effects.push({
			kind: 'wakeup_agent',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			holderAgentId: token.holderAgentId,
			wakeupReason: 'silence_timeout',
			message: `[Mission Watchdog Reminder] You hold active token \`${token.id}\` on node \`${token.nodeId}\` with no activity for ${state.silenceTimeoutMinutes}m. If finished, submit \`aexus-ade token complete ${token.id} --summary "..."\`. If running a long command, call \`aexus-ade token block ${token.id} --duration ... --reason "..."\`. If stuck, call \`aexus-ade token fail ${token.id} --reason "..."\`.`,
		});
		return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
	}

	if (token.status !== 'blocked') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Token is not blocked.' };
	}
	ctx.tokens[token.id] = {
		...token,
		status: 'active',
		blocked: undefined,
		lastActivityAt: now,
		lastNudgeAt: now,
	};
	ctx.nodeStates[token.nodeId] = 'active';
	const reasonLabel = params.reason === 'pid_exited'
		? `Watched PID exited${params.detail ? ` (${params.detail})` : ''}`
		: params.reason === 'file_ready'
			? `Watched output file appeared${params.detail ? ` (${params.detail})` : ''}`
			: 'Blocked maximum wait duration elapsed';
	ctx.effects.push({
		kind: 'wakeup_agent',
		missionId: state.missionId,
		nodeId: token.nodeId,
		tokenId: token.id,
		holderAgentId: token.holderAgentId,
		wakeupReason: params.reason,
		message: `[Mission Watchdog Wakeup] ${reasonLabel} for token \`${token.id}\` on node \`${token.nodeId}\`. Inspect the results and proceed (or call \`token complete\`, \`token block\`, or \`token fail\`). Routine ${state.silenceTimeoutMinutes}m supervision has resumed.`,
	});
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
}

/**
 * In-graph employee declares task failure:
 * - If node has explicit `fail` outgoing edge(s), automatically routes along them (no supervisor disturbance).
 * - Otherwise freezes token and escalates to direct off-graph supervisor (or Human Inbox if none exists).
 */
export function failMissionToken(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly callerAgentId?: string;
		readonly owner?: { readonly ownerSessionId?: string; readonly ownerTier?: number };
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly routedViaFailEdge: boolean; readonly nextTokenIds: readonly string[]; readonly escalatedToSupervisorId?: string; readonly escalatedToInbox?: boolean }> {
	if (state.status !== 'running' && state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const token = state.tokens[params.tokenId];
	if (!token || (token.status !== 'active' && token.status !== 'blocked')) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Active token "${params.tokenId}" not found.` };
	}
	if (!isAuthorizedTokenHolder(state, token, params.callerAgentId)) {
		return { ok: false, state, effects: [], code: 'FORBIDDEN', error: `Token "${params.tokenId}" is not held by caller "${params.callerAgentId}".` };
	}
	const reason = params.reason.trim() || 'Task failed';
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);

	const failEdges = getOutgoingEdges(graph, token.nodeId, 'fail');
	if (failEdges.length > 0) {
		ctx.tokens[token.id] = { ...token, status: 'completed', blocked: undefined, lastActivityAt: now };
		ctx.nodeStates[token.nodeId] = 'failed';

		const nextCompressed = compressTokenHistory(token.compressedHistory, token.lastSummary, token.fromNodeId);
		const failPtr = appendTrace(ctx, {
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: token.holderAgentId,
			waveId: token.waveId,
			event: 'fail_route',
			summary: `Failed -> fallback edge(s): ${reason}`,
			timestamp: now,
		});

		// Mark untaken success edges skipped so downstream joins don't deadlock!
		for (const succEdge of getOutgoingEdges(graph, token.nodeId, 'success')) {
			markBranchSkipped(state.missionId, ctx, graph, token.waveId, token.nodeId, succEdge.to, now);
		}

		const nextTokenIds: string[] = [];
		for (const fEdge of failEdges) {
			const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
				targetNodeId: fEdge.to,
				fromNodeId: token.nodeId,
				waveId: token.waveId,
				lastSummary: `[Fallback after ${token.nodeId} failed] ${reason}`,
				compressedHistory: nextCompressed,
				tracePtr: failPtr,
				now,
			});
			if (delivered) {
				nextTokenIds.push(delivered.id);
			}
		}
		checkMissionCompletion(ctx);
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { routedViaFailEdge: true, nextTokenIds },
		};
	}

	// No fail edge configured -> freeze token & escalate to direct off-graph supervisor (or Human Inbox)
	const escPtr = appendTrace(ctx, {
		parentPtrs: [token.tracePtr],
		nodeId: token.nodeId,
		employeeId: token.holderAgentId,
		waveId: token.waveId,
		event: 'fail_escalate',
		summary: `Frozen & escalated: ${reason}`,
		timestamp: now,
	});
	const directSup = findDirectSupervisorForNode(ctx.boundary, token.nodeId, params.owner);
	if (directSup) {
		ctx.tokens[token.id] = {
			...token,
			status: 'frozen_failed',
			blocked: undefined,
			tracePtr: escPtr,
			lastActivityAt: now,
			failure: {
				reason,
				failedAt: now,
				escalatedToSupervisorId: directSup.id,
				escalationHistory: [{ fromId: token.holderAgentId ?? token.nodeId, toId: directSup.id, note: reason, at: now }],
			},
		};
		ctx.nodeStates[token.nodeId] = 'failed';
		ctx.effects.push({
			kind: 'escalate_to_supervisor',
			missionId: state.missionId,
			supervisorId: directSup.id,
			nodeId: token.nodeId,
			tokenId: token.id,
			reason,
		});
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { routedViaFailEdge: false, nextTokenIds: [], escalatedToSupervisorId: directSup.id },
		};
	}

	// No off-graph supervisor configured -> deliver directly to Human Inbox!
	ctx.tokens[token.id] = {
		...token,
		status: 'frozen_failed',
		blocked: undefined,
		tracePtr: escPtr,
		lastActivityAt: now,
		failure: {
			reason,
			failedAt: now,
			escalatedToInbox: true,
			escalationHistory: [{ fromId: token.holderAgentId ?? token.nodeId, toId: 'human-inbox', note: reason, at: now }],
		},
	};
	ctx.nodeStates[token.nodeId] = 'failed';
	ctx.effects.push({
		kind: 'post_inbox',
		missionId: state.missionId,
		nodeId: token.nodeId,
		tokenId: token.id,
		title: `Mission Failure on ${token.nodeId}`,
		message: `Node \`${token.nodeId}\` (token \`${token.id}\`) failed with no fallback edge:\n${reason}`,
		severity: 'critical',
		senderAgentId: token.holderAgentId,
	});
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { routedViaFailEdge: false, nextTokenIds: [], escalatedToInbox: true },
	};
}

/**
 * Off-graph supervisor escalates a failure or out-of-jurisdiction decision to its parent supervisor.
 * When `L1` (or top-most supervisor) escalates, the alert is delivered directly into Human `Inbox`.
 */
export function escalateMissionIssue(
	state: IMissionRuntimeState,
	params: {
		readonly callerSupervisorId: string;
		readonly reason: string;
		readonly tokenId?: string;
		readonly nodeId?: string;
		readonly ownerSessionId?: string;
		readonly isSecretary?: boolean;
		readonly isHumanUser?: boolean;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly escalatedToSupervisorId?: string; readonly escalatedToInbox: boolean }> {
	const isKnownSupervisor = state.boundary.supervisors.some(s => s.id === params.callerSupervisorId);
	const isOwner = Boolean(params.ownerSessionId && params.callerSupervisorId === params.ownerSessionId);
	if (!isKnownSupervisor && !isOwner && !params.isSecretary && !params.isHumanUser) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'FORBIDDEN',
			error: `Session "${params.callerSupervisorId}" is not a bound off-graph supervisor or owner of this Mission and cannot escalate.`,
		};
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	const parentSup = findParentSupervisorForEscalation(ctx.boundary, params.callerSupervisorId);
	const token = params.tokenId
		? ctx.tokens[params.tokenId]
		: (params.nodeId ? Object.values(ctx.tokens).find(t => t.nodeId === params.nodeId && (t.status === 'frozen_failed' || t.status === 'active')) : undefined);
	const nodeId = params.nodeId ?? token?.nodeId;
	const note = params.reason.trim() || 'Escalated by off-graph supervisor';

	if (parentSup) {
		if (token) {
			ctx.tokens[token.id] = {
				...token,
				failure: {
					reason: token.failure?.reason ?? note,
					failedAt: token.failure?.failedAt ?? now,
					escalatedToSupervisorId: parentSup.id,
					escalationHistory: [
						...(token.failure?.escalationHistory ?? []),
						{ fromId: params.callerSupervisorId, toId: parentSup.id, note, at: now },
					],
				},
			};
		}
		ctx.effects.push({
			kind: 'escalate_to_supervisor',
			missionId: state.missionId,
			supervisorId: parentSup.id,
			nodeId: nodeId ?? '',
			tokenId: token?.id ?? '',
			reason: `[Escalated from ${params.callerSupervisorId}] ${note}`,
		});
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { escalatedToSupervisorId: parentSup.id, escalatedToInbox: false },
		};
	}

	// Reached L1 / top-most off-graph level -> submit to Human Inbox!
	if (token) {
		ctx.tokens[token.id] = {
			...token,
			failure: {
				reason: token.failure?.reason ?? note,
				failedAt: token.failure?.failedAt ?? now,
				escalatedToInbox: true,
				escalationHistory: [
					...(token.failure?.escalationHistory ?? []),
					{ fromId: params.callerSupervisorId, toId: 'human-inbox', note, at: now },
				],
			},
		};
	}
	ctx.effects.push({
		kind: 'post_inbox',
		missionId: state.missionId,
		nodeId,
		tokenId: token?.id,
		title: nodeId ? `Mission Escalation (${nodeId})` : `Mission Escalation (${state.missionId})`,
		message: note,
		severity: 'critical',
		senderAgentId: params.callerSupervisorId,
	});
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { escalatedToInbox: true },
	};
}

/**
 * Human resolves a waiting Gate node (`approve` advances downstream; `reject` bounces back).
 */
export function resolveMissionGate(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly nodeId: string;
		readonly decision: 'approve' | 'reject';
		readonly note?: string;
		readonly rollbackNodeId?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly nextTokenIds: readonly string[] }> {
	if (state.status !== 'running') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const waitingToken = Object.values(state.tokens).find(t => t.nodeId === params.nodeId && t.status === 'waiting_gate');
	if (!waitingToken) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `No token is waiting at Gate "${params.nodeId}".` };
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[waitingToken.id] = { ...waitingToken, status: 'completed', lastActivityAt: now };

	if (params.decision === 'approve') {
		ctx.nodeStates[params.nodeId] = 'completed';
		const summary = params.note?.trim()
			? `[Gate ${params.nodeId} Approved] ${params.note.trim()}`
			: waitingToken.lastSummary;
		const approvePtr = appendTrace(ctx, {
			parentPtrs: [waitingToken.tracePtr],
			nodeId: params.nodeId,
			waveId: waitingToken.waveId,
			event: 'gate_approve',
			summary,
			timestamp: now,
		});
		const nextCompressed = compressTokenHistory(waitingToken.compressedHistory, waitingToken.lastSummary, waitingToken.fromNodeId);
		const nextTokenIds: string[] = [];
		for (const succEdge of getOutgoingEdges(graph, params.nodeId, 'success')) {
			const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
				targetNodeId: succEdge.to,
				fromNodeId: params.nodeId,
				waveId: waitingToken.waveId,
				lastSummary: summary,
				compressedHistory: nextCompressed,
				tracePtr: approvePtr,
				now,
			});
			if (delivered) {
				nextTokenIds.push(delivered.id);
			}
		}
		// Untaken fail-branch edges from this approved Gate are marked skipped so downstream joins never deadlock.
		for (const failEdge of getOutgoingEdges(graph, params.nodeId, 'fail')) {
			markBranchSkipped(state.missionId, ctx, graph, waitingToken.waveId, params.nodeId, failEdge.to, now);
		}
		checkMissionCompletion(ctx);
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { nextTokenIds },
		};
	}

	// Gate reject -> bounce back to rollbackNodeId or direct upstream predecessor (strictly executed upstream ancestor)
	const explicitRollback = params.rollbackNodeId?.trim();
	const defaultRollback = (waitingToken.fromNodeId && isValidUpstreamRollbackTarget(state, graph, params.nodeId, waitingToken.fromNodeId, waitingToken.tracePtr))
		? waitingToken.fromNodeId
		: getIncomingEdges(graph, params.nodeId).map(e => e.from).find(fid => isValidUpstreamRollbackTarget(state, graph, params.nodeId, fid, waitingToken.tracePtr));
	const rollbackTarget = explicitRollback || defaultRollback;
	if (!rollbackTarget || !isValidUpstreamRollbackTarget(state, graph, params.nodeId, rollbackTarget, waitingToken.tracePtr)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: explicitRollback
				? `Rollback target "${explicitRollback}" is not an executed upstream ancestor of Gate "${params.nodeId}".`
				: `No executed upstream rollback node found for Gate "${params.nodeId}" rejection.`,
		};
	}
	ctx.nodeStates[params.nodeId] = 'idle';
	ctx.waveSeq += 1;
	const reworkWaveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[reworkWaveId] = [rollbackTarget];
	const note = params.note?.trim() || 'Rejected at Human Gate — revise and resubmit.';
	const rejPtr = appendTrace(ctx, {
		parentPtrs: [waitingToken.tracePtr],
		nodeId: params.nodeId,
		waveId: reworkWaveId,
		event: 'gate_reject',
		summary: `Gate rejected -> ${rollbackTarget}: ${note}`,
		timestamp: now,
	});
	const bounced = deliverTokenToTarget(state.missionId, ctx, graph, {
		targetNodeId: rollbackTarget,
		fromNodeId: params.nodeId,
		waveId: reworkWaveId,
		lastSummary: `[Gate ${params.nodeId} Rejected] ${note}`,
		compressedHistory: compressTokenHistory(waitingToken.compressedHistory, waitingToken.lastSummary, waitingToken.fromNodeId),
		tracePtr: rejPtr,
		now,
		isRejection: true,
		bypassJoin: true,
		returnToNodeId: params.nodeId,
	})!;
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { nextTokenIds: [bounced.id] },
	};
}

function collectReachableNodes(graph: Pick<IMissionDagParseResult, 'edges'>, startIds: readonly string[]): Set<string> {
	const adj = new Map<string, string[]>();
	for (const e of graph.edges) {
		const list = adj.get(e.from) ?? [];
		list.push(e.to);
		adj.set(e.from, list);
	}
	const visited = new Set<string>();
	const queue = [...startIds];
	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) { continue; }
		visited.add(id);
		for (const next of adj.get(id) ?? []) {
			if (!visited.has(next)) { queue.push(next); }
		}
	}
	return visited;
}

/**
 * Forcibly recalls active/blocked in-flight tokens within an off-graph supervisor's jurisdiction.
 * If requested nodes or affected parallel join branches exceed caller jurisdiction, blocks and
 * instructs escalation to the parent supervisor.
 */
export function recallMissionTokens(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly caller: IMissionEngineCaller;
		readonly nodeIds?: readonly string[];
		readonly branchRootNodeId?: string;
		readonly reason?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly recalledTokenIds: readonly string[]; readonly affectedNodeIds: readonly string[] }> {
	const isOffGraph = Boolean(
		params.caller.isHumanUser
		|| params.caller.isSecretary
		|| (params.caller.tier !== undefined && params.caller.tier <= state.boundary.offGraphMaxTier),
	);
	if (!isOffGraph) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'FORBIDDEN',
			error: 'Only off-graph supervisors, L0 Secretary, or Human User may recall tokens.',
		};
	}

	const allNodeIds = graph.nodes.map(n => n.id);
	const jurisdiction = resolveSupervisorJurisdiction(
		state.boundary,
		params.caller.sessionId ?? '',
		allNodeIds,
		{ isHumanUser: params.caller.isHumanUser, isSecretary: params.caller.isSecretary, ownerSessionId: params.caller.ownerSessionId },
	);

	let targetNodeSet: Set<string>;
	if (params.branchRootNodeId) {
		targetNodeSet = collectReachableNodes(graph, [params.branchRootNodeId]);
	} else if (params.nodeIds && params.nodeIds.length > 0) {
		targetNodeSet = new Set(params.nodeIds);
	} else {
		targetNodeSet = new Set(
			Object.values(state.tokens)
				.filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed')
				.map(t => t.nodeId)
				.filter(nid => jurisdiction.hasFullJurisdiction || jurisdiction.nodeIds.has(nid)),
		);
	}

	if (!jurisdiction.hasFullJurisdiction) {
		const outOfScope = [...targetNodeSet].filter(nid => !jurisdiction.nodeIds.has(nid));
		// Also check if any recalled branch feeds a join barrier whose sibling active branch runs outside jurisdiction
		for (const barrier of Object.values(state.joinBarriers)) {
			if (barrier.expectedFromNodeIds.some(fid => targetNodeSet.has(fid)) && !jurisdiction.nodeIds.has(barrier.targetNodeId)) {
				outOfScope.push(barrier.targetNodeId);
			}
		}
		if (outOfScope.length > 0) {
			const uniqueOut = [...new Set(outOfScope)];
			const parentSup = params.caller.sessionId ? findParentSupervisorForEscalation(state.boundary, params.caller.sessionId) : undefined;
			return {
				ok: false,
				state,
				effects: [],
				code: 'OUT_OF_JURISDICTION',
				outOfScopeNodeIds: uniqueOut,
				parentSupervisorId: parentSup?.id,
				error: `Recall touches node(s) outside your jurisdiction (${uniqueOut.join(', ')}). Escalate to ${parentSup ? `supervisor "${parentSup.id}"` : 'higher authority'} to coordinate recall.`,
			};
		}
	}

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	const reason = params.reason?.trim() || 'Recalled by off-graph supervisor';
	const recalledTokenIds: string[] = [];
	const affectedNodeIds = new Set<string>();

	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (!targetNodeSet.has(tok.nodeId)) {
			continue;
		}
		if (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
			const recPtr = appendTrace(ctx, {
				parentPtrs: [tok.tracePtr],
				nodeId: tok.nodeId,
				employeeId: tok.holderAgentId,
				waveId: tok.waveId,
				event: 'recall',
				summary: reason,
				timestamp: now,
			});
			ctx.tokens[tid] = { ...tok, status: 'recalled', blocked: undefined, tracePtr: recPtr, lastActivityAt: now };
			ctx.nodeStates[tok.nodeId] = 'idle';
			recalledTokenIds.push(tid);
			affectedNodeIds.add(tok.nodeId);
			if (tok.status === 'active' || tok.status === 'blocked') {
				ctx.effects.push({
					kind: 'stop_agent',
					missionId: state.missionId,
					nodeId: tok.nodeId,
					tokenId: tok.id,
					holderAgentId: tok.holderAgentId,
					reason,
				});
			}
		}
	}

	// Clear any pending join barriers targeting recalled nodes, and purge stale arrivals from recalled upstream nodes
	for (const [bKey, barrier] of Object.entries(ctx.joinBarriers)) {
		if (targetNodeSet.has(barrier.targetNodeId)) {
			delete ctx.joinBarriers[bKey];
			continue;
		}
		let cleaned = false;
		const nextArrived: Record<string, IMissionToken> = {};
		for (const [fromId, arrivedTok] of Object.entries(barrier.arrivedByFrom)) {
			if (targetNodeSet.has(fromId)) {
				cleaned = true;
				if (ctx.tokens[arrivedTok.id]) {
					ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'recalled', lastActivityAt: now };
				}
			} else {
				nextArrived[fromId] = arrivedTok;
			}
		}
		if (cleaned) {
			ctx.joinBarriers[bKey] = {
				...barrier,
				arrivedByFrom: nextArrived,
			};
		}
	}

	// Drop any deferred dispatches for recalled tokens
	if (recalledTokenIds.length > 0 && ctx.deferredEffects.length > 0) {
		const recalledSet = new Set(recalledTokenIds);
		ctx.deferredEffects = ctx.deferredEffects.filter(eff => !(eff.kind === 'dispatch_token' && recalledSet.has(eff.tokenId)));
	}

	checkMissionCompletion(ctx);

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { recalledTokenIds, affectedNodeIds: [...affectedNodeIds] },
	};
}

/**
 * Atomic safe Mermaid DAG patcher (`mission_plan.md` Section 4.3 #3):
 * 1. Strictly off-graph supervisors / L0 / Human only.
 * 2. Validates Mermaid syntax & DAG acyclicity.
 * 3. Protects already-completed nodes from deletion/rewriting and rejects new incoming edges into completed nodes.
 * 4. Enforces supervisor jurisdiction over all added/removed/modified nodes, relabeled edges & join interfaces;
 *    returns `OUT_OF_JURISDICTION` + `parentSupervisorId` when escalation is required.
 * 5. **Hard Anti-Dangling Connectivity Validation**:
 *    No surviving non-source downstream node may lose all reachable incoming paths
 *    (e.g., deleting sole upstream node A before providing an alternative path to B is rejected!).
 *    Multi-branch join pruning is allowed only when remaining branches still reach the join
 *    AND caller has jurisdiction over that join node.
 * 6. Prunes removed nodes from boundary & binds added nodes to caller supervisor, reconciles open join barriers,
 *    kicks off newly ready added/reconnected nodes with inherited wave & history, and emits `mermaid_patched`.
 */
export function applySafeMissionPatch(
	state: IMissionRuntimeState,
	currentGraph: IMissionDagParseResult,
	params: {
		readonly caller: IMissionEngineCaller;
		readonly newMermaidText: string;
		readonly reason?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{
	readonly addedNodes: readonly string[];
	readonly removedNodes: readonly string[];
	readonly addedEdges: readonly string[];
	readonly removedEdges: readonly string[];
}> {
	const isOffGraph = Boolean(
		params.caller.isHumanUser
		|| params.caller.isSecretary
		|| (params.caller.tier !== undefined && params.caller.tier <= state.boundary.offGraphMaxTier),
	);
	if (!isOffGraph) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'FORBIDDEN',
			error: 'In-graph employees are strictly forbidden from patching the Mission DAG.',
		};
	}

	const nextGraph = parseMissionMermaidDag(params.newMermaidText);
	if (nextGraph.error || nextGraph.nodes.length === 0) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_DAG',
			error: nextGraph.error || 'Patched Mermaid DAG cannot be empty.',
		};
	}

	const oldNodeMap = new Map(currentGraph.nodes.map(n => [n.id, n]));
	const newNodeMap = new Map(nextGraph.nodes.map(n => [n.id, n]));
	const oldEdgeMap = new Map(currentGraph.edges.map(e => [e.id, e]));
	const newEdgeMap = new Map(nextGraph.edges.map(e => [e.id, e]));

	const addedNodes = nextGraph.nodes.filter(n => !oldNodeMap.has(n.id)).map(n => n.id);
	const removedNodes = currentGraph.nodes.filter(n => !newNodeMap.has(n.id)).map(n => n.id);
	const modifiedNodes = nextGraph.nodes
		.filter(n => {
			const prev = oldNodeMap.get(n.id);
			return prev && (prev.label !== n.label || prev.kind !== n.kind || prev.employeeKey !== n.employeeKey);
		})
		.map(n => n.id);
	const addedEdges = nextGraph.edges.filter(e => !oldEdgeMap.has(e.id)).map(e => e.id);
	const removedEdges = currentGraph.edges.filter(e => !newEdgeMap.has(e.id)).map(e => e.id);
	const modifiedEdges = nextGraph.edges
		.filter(e => {
			const prev = oldEdgeMap.get(e.id);
			return Boolean(prev && (getMissionEdgeKind(prev) !== getMissionEdgeKind(e) || prev.label !== e.label));
		})
		.map(e => e.id);

	// Completed-zone protection (no deleting/modifying completed nodes or adding/relabeling incoming edges into completed nodes)
	for (const nid of [...removedNodes, ...modifiedNodes]) {
		if (state.nodeStates[nid] === 'completed') {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Cannot delete or modify already-completed node "${nid}". Only unfinished regions may be patched.`,
			};
		}
	}
	for (const eId of [...addedEdges, ...modifiedEdges]) {
		const e = newEdgeMap.get(eId)!;
		if (state.nodeStates[e.to] === 'completed') {
			return {
				ok: false,
				state,
				effects: [],
				code: 'INVALID_STATE',
				error: `Cannot add or modify incoming edge "${e.from} -> ${e.to}" targeting already-completed node "${e.to}".`,
			};
		}
	}

	// Compute old & new in-degrees
	const oldInDeg = new Map<string, number>();
	const newInDeg = new Map<string, number>();
	for (const n of currentGraph.nodes) { oldInDeg.set(n.id, 0); }
	for (const e of currentGraph.edges) { oldInDeg.set(e.to, (oldInDeg.get(e.to) ?? 0) + 1); }
	for (const n of nextGraph.nodes) { newInDeg.set(n.id, 0); }
	for (const e of nextGraph.edges) { newInDeg.set(e.to, (newInDeg.get(e.to) ?? 0) + 1); }

	// Jurisdiction check over all touched existing nodes, relabeled edges & join endpoints
	const allOldIds = currentGraph.nodes.map(n => n.id);
	const jurisdiction = resolveSupervisorJurisdiction(
		state.boundary,
		params.caller.sessionId ?? '',
		allOldIds,
		{ isHumanUser: params.caller.isHumanUser, isSecretary: params.caller.isSecretary, ownerSessionId: params.caller.ownerSessionId },
	);

	if (!jurisdiction.hasFullJurisdiction) {
		const touchedExisting = new Set<string>([...removedNodes, ...modifiedNodes]);
		for (const eId of removedEdges) {
			const e = oldEdgeMap.get(eId)!;
			touchedExisting.add(e.from);
			touchedExisting.add(e.to);
		}
		for (const eId of modifiedEdges) {
			const e = newEdgeMap.get(eId)!;
			touchedExisting.add(e.from);
			touchedExisting.add(e.to);
		}
		for (const eId of addedEdges) {
			const e = newEdgeMap.get(eId)!;
			if (oldNodeMap.has(e.from) && state.nodeStates[e.from] !== 'completed') {
				touchedExisting.add(e.from);
			}
			if (oldNodeMap.has(e.to)) {
				touchedExisting.add(e.to);
			}
		}
		const outOfScope = [...touchedExisting].filter(nid => !jurisdiction.nodeIds.has(nid));
		if (outOfScope.length > 0) {
			const parentSup = params.caller.sessionId ? findParentSupervisorForEscalation(state.boundary, params.caller.sessionId) : undefined;
			return {
				ok: false,
				state,
				effects: [],
				code: 'OUT_OF_JURISDICTION',
				outOfScopeNodeIds: outOfScope,
				parentSupervisorId: parentSup?.id,
				error: `Patch touches node(s) outside your jurisdiction (${outOfScope.join(', ')}). Escalate to ${parentSup ? `supervisor "${parentSup.id}"` : 'higher authority'}.`,
			};
		}
	}

	// HARD ANTI-DANGLING CONNECTIVITY CHECK:
	// Any surviving unfinished node that previously had incoming edges MUST retain >= 1 incoming edge
	// AND remain reachable from valid entry sources (original source nodes, newly added source nodes, or completed nodes).
	const validEntryStarts: string[] = [];
	for (const n of nextGraph.nodes) {
		const isOriginalSource = oldNodeMap.has(n.id) && (oldInDeg.get(n.id) ?? 0) === 0;
		const isNewlyAddedSource = !oldNodeMap.has(n.id) && (newInDeg.get(n.id) ?? 0) === 0;
		const isCompletedAnchor = state.nodeStates[n.id] === 'completed';
		if (isOriginalSource || isNewlyAddedSource || isCompletedAnchor) {
			validEntryStarts.push(n.id);
		}
	}
	const reachableInNew = collectReachableNodes(nextGraph, validEntryStarts);
	const danglingNodeIds: string[] = [];
	for (const n of nextGraph.nodes) {
		const hadIncomingBefore = oldNodeMap.has(n.id) && (oldInDeg.get(n.id) ?? 0) > 0;
		if (hadIncomingBefore && state.nodeStates[n.id] !== 'completed') {
			if ((newInDeg.get(n.id) ?? 0) === 0 || !reachableInNew.has(n.id)) {
				danglingNodeIds.push(n.id);
			}
		}
	}
	if (danglingNodeIds.length > 0) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'DANGLING_NODE_VIOLATION',
			danglingNodeIds,
			error: `Anti-dangling violation: patching would orphan downstream node(s) [${danglingNodeIds.join(', ')}] with no incoming path. Atomically add a replacement route to these node(s) in the same patch.`,
		};
	}

	// Apply atomic patch!
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);

	// 1. Clean up removed nodes' states, tokens (including waiting_join), deferred effects, triggers & boundary
	const removedSet = new Set(removedNodes);
	const removedRecalledTokens: IMissionToken[] = [];
	for (const rid of removedNodes) {
		delete ctx.nodeStates[rid];
	}
	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (removedSet.has(tok.nodeId) && (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed')) {
			removedRecalledTokens.push(tok);
			ctx.tokens[tid] = { ...tok, status: 'recalled', blocked: undefined, lastActivityAt: now };
			if (tok.status === 'active' || tok.status === 'blocked') {
				ctx.effects.push({
					kind: 'stop_agent',
					missionId: state.missionId,
					nodeId: tok.nodeId,
					tokenId: tok.id,
					holderAgentId: tok.holderAgentId,
					reason: params.reason || 'Node removed by atomic DAG patch',
				});
			}
		}
	}
	if (removedSet.size > 0 && ctx.deferredEffects.length > 0) {
		ctx.deferredEffects = ctx.deferredEffects.filter(eff => !(eff.kind === 'dispatch_token' && removedSet.has(eff.nodeId)));
	}
	ctx.triggers = ctx.triggers.filter(tr => !removedSet.has(tr.nodeId));

	// Boundary hygiene: prune removed nodes from nodeAssignments & supervisors, and grant addedNodes to partial caller supervisor
	if (removedSet.size > 0 || addedNodes.length > 0) {
		const nextAssignments: Record<string, typeof ctx.boundary.nodeAssignments[string]> = {};
		for (const [nid, assignment] of Object.entries(ctx.boundary.nodeAssignments)) {
			if (!removedSet.has(nid)) {
				nextAssignments[nid] = assignment;
			}
		}
		const callerSupId = params.caller.sessionId;
		const nextSupervisors = ctx.boundary.supervisors.map(sup => {
			let managed = sup.managedNodeIds.filter(nid => !removedSet.has(nid));
			if (addedNodes.length > 0 && callerSupId && sup.id === callerSupId && sup.managedNodeIds.length > 0) {
				const existingSet = new Set(managed);
				managed = [...managed, ...addedNodes.filter(aid => !existingSet.has(aid))];
			}
			return { ...sup, managedNodeIds: managed };
		});
		ctx.boundary = {
			...ctx.boundary,
			nodeAssignments: nextAssignments,
			supervisors: nextSupervisors,
		};
	}

	// 2. Initialize newly added nodes
	for (const aid of addedNodes) {
		ctx.nodeStates[aid] = 'idle';
	}

	// 3. Reconcile open join barriers against the new edge set & wave roots!
	for (const [bKey, barrier] of Object.entries(ctx.joinBarriers)) {
		if (removedSet.has(barrier.targetNodeId)) {
			for (const arrivedTok of Object.values(barrier.arrivedByFrom)) {
				if (ctx.tokens[arrivedTok.id] && ctx.tokens[arrivedTok.id].status === 'waiting_join') {
					ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'recalled', lastActivityAt: now };
				}
			}
			delete ctx.joinBarriers[bKey];
			continue;
		}
		const nextExpected = computeWaveExpectedIncoming(ctx, nextGraph, barrier.waveId, barrier.targetNodeId);
		const nextExpectedSet = new Set(nextExpected);
		const nextArrived: Record<string, IMissionToken> = {};
		for (const [fid, tok] of Object.entries(barrier.arrivedByFrom)) {
			if (nextExpectedSet.has(fid)) {
				nextArrived[fid] = tok;
			} else if (ctx.tokens[tok.id] && ctx.tokens[tok.id].status === 'waiting_join') {
				ctx.tokens[tok.id] = { ...ctx.tokens[tok.id], status: 'recalled', lastActivityAt: now };
			}
		}
		if (nextExpected.length === 0) {
			delete ctx.joinBarriers[bKey];
			continue;
		}
		const nextSkipped = barrier.skippedFromNodeIds.filter(fid => nextExpectedSet.has(fid));
		ctx.joinBarriers[bKey] = {
			...barrier,
			expectedFromNodeIds: [...nextExpected],
			arrivedByFrom: nextArrived,
			skippedFromNodeIds: nextSkipped,
		};
		tryReleaseJoinBarrier(state.missionId, ctx, nextGraph, bKey, now);
	}

	// 4. Kick off newly added OR newly reconnected ready nodes (both while running and queued while paused)
	if (ctx.status === 'running' || ctx.status === 'paused') {
		const addedNodeSet = new Set(addedNodes);
		const kickCandidates: string[] = [];
		const seenCandidates = new Set<string>();
		for (const aid of addedNodes) {
			if (!seenCandidates.has(aid)) {
				seenCandidates.add(aid);
				kickCandidates.push(aid);
			}
		}
		for (const eId of addedEdges) {
			const targetId = newEdgeMap.get(eId)?.to;
			if (targetId && !seenCandidates.has(targetId)) {
				seenCandidates.add(targetId);
				kickCandidates.push(targetId);
			}
		}

		const latestRemovedTok = [...removedRecalledTokens].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
		const findLatestCompletedTokenForNode = (nid: string): IMissionToken | undefined =>
			Object.values(ctx.tokens)
				.filter(t => t.nodeId === nid && t.status === 'completed')
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];

		for (const cid of kickCandidates) {
			if (ctx.nodeStates[cid] === 'completed') {
				continue;
			}
			const hasLiveOnNode = Object.values(ctx.tokens).some(t =>
				t.nodeId === cid && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join' || t.status === 'frozen_failed'),
			);
			const hasBarrierOnNode = Object.values(ctx.joinBarriers).some(b => b.targetNodeId === cid);
			if (hasLiveOnNode || hasBarrierOnNode) {
				continue;
			}
			const incoming = getIncomingEdges(nextGraph, cid);
			const isNewUntriggeredSource = incoming.length === 0 && addedNodeSet.has(cid) && !ctx.triggers.some(tr => tr.enabled && tr.nodeId === cid);
			const allIncomingCompleted = incoming.length > 0 && incoming.every(e => ctx.nodeStates[e.from] === 'completed');
			if (!isNewUntriggeredSource && !allIncomingCompleted) {
				continue;
			}

			const upstreamTokens = incoming
				.map(e => findLatestCompletedTokenForNode(e.from))
				.filter((t): t is IMissionToken => Boolean(t))
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
			const anchorTok = upstreamTokens[0] ?? latestRemovedTok;
			let targetWaveId = anchorTok?.waveId;
			if (!targetWaveId) {
				ctx.waveSeq += 1;
				targetWaveId = `wave-${ctx.waveSeq}`;
			}
			const existingRoots = ctx.waveRoots[targetWaveId] ?? [];
			if (!existingRoots.includes(cid)) {
				ctx.waveRoots[targetWaveId] = [...existingRoots, cid];
			}

			// Inherit latest completion trace summary & compressedHistory from upstream completed node(s) or replaced node
			const parentPtrs = upstreamTokens.length > 0
				? upstreamTokens.map(t => t.tracePtr)
				: (anchorTok ? [anchorTok.tracePtr] : []);
			const latestCompleteTrace = upstreamTokens[0]
				? Object.values(ctx.traces)
					.filter(tr => tr.nodeId === upstreamTokens[0].nodeId && tr.waveId === upstreamTokens[0].waveId && tr.event === 'complete')
					.sort((a, b) => b.timestamp - a.timestamp)[0]
				: undefined;
			const inheritedSummary = latestCompleteTrace?.summary
				|| (upstreamTokens.length > 0 ? upstreamTokens[0].lastSummary : undefined)
				|| anchorTok?.lastSummary;
			const summaryText = params.reason
				? (inheritedSummary ? `[Patched Route: ${params.reason}] ${inheritedSummary}` : `[Patched Route] ${params.reason}`)
				: (inheritedSummary || 'Patched replacement route activated.');
			const inheritedHistory = upstreamTokens.length > 0
				? compressTokenHistory(upstreamTokens[0].compressedHistory, upstreamTokens[0].lastSummary, upstreamTokens[0].fromNodeId)
				: (anchorTok?.compressedHistory ?? '');

			const ptr = appendTrace(ctx, {
				parentPtrs,
				nodeId: cid,
				employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
				waveId: targetWaveId,
				event: 'mint',
				summary: params.reason ? `Patched recovery path: ${params.reason}` : 'Patched recovery step started',
				timestamp: now,
			});
			materializeAndDispatchToken(state.missionId, ctx, nextGraph, {
				targetNodeId: cid,
				fromNodeId: incoming[0]?.from,
				waveId: targetWaveId,
				lastSummary: summaryText,
				compressedHistory: inheritedHistory,
				tracePtr: ptr,
				now,
			});
		}
	}

	ctx.effects.push({
		kind: 'mermaid_patched',
		missionId: state.missionId,
		newMermaidText: params.newMermaidText,
		reason: params.reason,
	});
	checkMissionCompletion(ctx);

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { addedNodes, removedNodes, addedEdges, removedEdges },
	};
}

/**
 * Validates that a trigger is attached strictly to a source generator node (`inDegree === 0 && outDegree >= 1`).
 */
export function validateSourceTrigger(
	graph: Pick<IMissionDagParseResult, 'nodes' | 'edges'>,
	trigger: Pick<IMissionSourceTrigger, 'nodeId' | 'kind' | 'cronExpr' | 'intervalMs' | 'fireAt' | 'eventType'>,
): string | undefined {
	if (!graph.nodes.some(n => n.id === trigger.nodeId)) {
		return `Trigger node "${trigger.nodeId}" does not exist in Mission DAG.`;
	}
	const inCount = graph.edges.filter(e => e.to === trigger.nodeId).length;
	const outCount = graph.edges.filter(e => e.from === trigger.nodeId).length;
	if (inCount !== 0 || outCount < 1) {
		return `Source trigger node "${trigger.nodeId}" must have inDegree = 0 and outDegree >= 1 (actual: in=${inCount}, out=${outCount}).`;
	}
	if (trigger.kind === 'cron') {
		if (!trigger.cronExpr || trigger.cronExpr.trim().split(/\s+/).length !== 5) {
			return 'Cron trigger requires a standard 5-field cron expression (e.g. "*/15 * * * *").';
		}
	} else if (trigger.kind === 'interval') {
		if (!trigger.intervalMs || trigger.intervalMs < 5000) {
			return 'Interval trigger requires intervalMs >= 5000 (5 seconds).';
		}
	} else if (trigger.kind === 'once') {
		if (!trigger.fireAt || !Number.isFinite(trigger.fireAt)) {
			return 'One-shot trigger requires a valid fireAt timestamp.';
		}
	} else if (trigger.kind === 'event') {
		if (!trigger.eventType) {
			return 'Event trigger requires eventType (file_created | file_changed | git_updated | gpu_idle).';
		}
	}
	return undefined;
}

/**
 * Fires a source node trigger, minting a brand-new `wave_id` token at that source node.
 */
export function fireMissionSourceTrigger(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: { readonly triggerId: string; readonly payloadSummary?: string; readonly now?: number },
): IMissionEngineTransitionResult<{ readonly waveId: string; readonly tokenId: string }> {
	if (state.status !== 'running') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const idx = state.triggers.findIndex(t => t.id === params.triggerId && t.enabled);
	if (idx < 0) {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Enabled trigger "${params.triggerId}" not found.` };
	}
	const trigger = state.triggers[idx];
	const hasLiveTokenOnSource = Object.values(state.tokens).some(t =>
		t.nodeId === trigger.nodeId && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join'),
	);
	if (hasLiveTokenOnSource) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `Source node "${trigger.nodeId}" already holds a live in-flight token; skipping trigger "${trigger.id}".`,
		};
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.waveSeq += 1;
	const waveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[waveId] = [trigger.nodeId];
	const summary = params.payloadSummary?.trim() || `Triggered (${trigger.kind}) on source node ${trigger.nodeId}`;

	const ptr = appendTrace(ctx, {
		parentPtrs: [],
		nodeId: trigger.nodeId,
		employeeId: ctx.boundary.nodeAssignments[trigger.nodeId]?.agentId,
		waveId,
		event: 'trigger',
		summary,
		timestamp: now,
	});
	const tok = materializeAndDispatchToken(state.missionId, ctx, graph, {
		targetNodeId: trigger.nodeId,
		waveId,
		lastSummary: summary,
		compressedHistory: '',
		tracePtr: ptr,
		now,
	});
	ctx.triggers[idx] = {
		...trigger,
		lastFiredAt: now,
		fireCount: trigger.fireCount + 1,
		enabled: trigger.kind === 'once' ? false : trigger.enabled,
	};
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { waveId, tokenId: tok.id },
	};
}

/**
 * Lightweight zero-dependency 5-field cron matcher (`min hour dom month dow`).
 * Supports 1-based step origins (`dom`, `month`), Sunday as `0` or `7`, and standard `dom`/`dow` OR semantics.
 */
export function matchesCronExpression(expr: string, date: Date): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		return false;
	}
	const values = [
		date.getMinutes(),
		date.getHours(),
		date.getDate(),
		date.getMonth() + 1,
		date.getDay(),
	];
	const mins = [0, 0, 1, 1, 0];
	const matchField = (field: string, value: number, minVal: number, isDow: boolean): boolean => {
		const normalizeVal = (n: number) => (isDow && n === 7 ? 0 : n);
		for (const part of field.split(',')) {
			const trimmed = part.trim();
			if (!trimmed) { continue; }
			const [rangePart, stepPart] = trimmed.split('/');
			const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
			if (!Number.isInteger(step) || step <= 0) { continue; }
			if (rangePart === '*') {
				if ((value - minVal) % step === 0) { return true; }
				continue;
			}
			if (rangePart.includes('-')) {
				const [aStr, bStr] = rangePart.split('-');
				const a = Number.parseInt(aStr, 10);
				const b = Number.parseInt(bStr, 10);
				if (Number.isInteger(a) && Number.isInteger(b)) {
					if (isDow && b === 7 && value === 0 && (7 - a) % step === 0) {
						return true;
					}
					if (value >= a && value <= b && (value - a) % step === 0) {
						return true;
					}
				}
				continue;
			}
			const exact = Number.parseInt(rangePart, 10);
			if (Number.isInteger(exact) && normalizeVal(exact) === value) {
				return true;
			}
		}
		return false;
	};
	const minMatch = matchField(fields[0], values[0], mins[0], false);
	const hourMatch = matchField(fields[1], values[1], mins[1], false);
	const monthMatch = matchField(fields[3], values[3], mins[3], false);
	if (!minMatch || !hourMatch || !monthMatch) {
		return false;
	}
	const domRestricted = !fields[2].startsWith('*');
	const dowRestricted = !fields[4].startsWith('*');
	const domMatch = matchField(fields[2], values[2], mins[2], false);
	const dowMatch = matchField(fields[4], values[4], mins[4], true);
	if (domRestricted && dowRestricted) {
		return domMatch || dowMatch;
	}
	return domMatch && dowMatch;
}
