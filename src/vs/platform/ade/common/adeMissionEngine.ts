/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { buildTokenSystemEnvelopeLines, sanitizeAdeSystemEnvelopeHeaders } from './adeMessageEnvelope.js';
import {
	createDefaultMissionBoundary,
	findDirectSupervisorForNode,
	findParentSupervisorForEscalation,
	IMissionBoundaryConfig,
	resolveSupervisorJurisdiction,
	validateMissionFactoryBoundary,
} from './adeMissionBoundary.js';
import {
	computeConcurrencySlotUsage,
	drainMissionConcurrencyQueueCore,
	evaluateConcurrencySlot,
	IMissionConcurrencyLimits,
	IMissionTokenQueueInfo,
	normalizeMissionConcurrencyLimits,
	recordActiveSlotOccupancy,
	renumberMissionConcurrencyQueueCore,
} from './adeMissionConcurrency.js';
import {
	getMissionEdgeKind,
	IMissionDagParseResult,
	IMissionNodeCheckSuiteResult,
	MissionCheckOnFailAction,
} from './adeMissionDag.js';
import type { IAdeOrganizationConfig } from './adeRoleSchema.js';

export * from './adeMissionConcurrency.js';

export type MissionRunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
export type MissionNodeRuntimeStatus = 'idle' | 'active' | 'queued' | 'blocked' | 'waiting_gate' | 'waiting_join' | 'completed' | 'failed';
export type MissionTokenStatus = 'active' | 'queued' | 'blocked' | 'waiting_gate' | 'waiting_join' | 'frozen_failed' | 'recalled' | 'completed';

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
	readonly event: 'mint' | 'complete' | 'reject' | 'reject_bounce' | 'fail_route' | 'fail_escalate' | 'retry' | 'join' | 'gate_approve' | 'gate_reject' | 'recall' | 'trigger' | 'check_passed' | 'check_failed' | 'distill' | 'checkpoint_restore';
	readonly summary?: string;
	readonly timestamp: number;
}

export interface IMissionDagRevision {
	readonly version: number;
	readonly mermaidText: string;
	readonly reason: string;
	readonly timestamp: number;
	readonly nodeCount: number;
	readonly edgeCount: number;
	readonly addedNodeIds?: readonly string[];
	readonly removedNodeIds?: readonly string[];
}

export interface IMissionFinOpsBucket {
	readonly key: string;
	readonly label: string;
	readonly costUsd: number;
	readonly tokens: number;
	readonly nodeCount: number;
	readonly pct: number;
	readonly hasEstimatedCost?: boolean;
}

export interface IMissionFinOpsNodeSpend {
	readonly nodeId: string;
	readonly label: string;
	readonly costUsd: number;
	readonly tokens: number;
	readonly turns: number;
	readonly hostAlias: string;
	readonly tier: number;
	readonly costEstimated?: boolean;
	readonly costLocalFree?: boolean;
}

export interface IMissionFinOpsSummary {
	readonly totalTokens: number;
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly totalCacheReadTokens: number;
	readonly totalCostUsd: number;
	/** Portion of totalCostUsd derived from the built-in/custom model pricing catalog rather than direct CLI billing. */
	readonly estimatedCostUsd: number;
	/** True when any positive spend in this mission is estimated via token pricing rather than reported directly by the engine CLI. */
	readonly hasEstimatedCost: boolean;
	/** True when at least one active node is running on a recognized local / self-hosted zero-cost model. */
	readonly hasLocalFreeNodes?: boolean;
	readonly cacheSavingsPct: number;
	readonly budgetLimitUsd: number | undefined;
	readonly budgetUsedPct: number;
	readonly budgetCircuitTripped: boolean;
	readonly severity: 'normal' | 'warn' | 'critical' | 'tripped';
	readonly byTier: readonly IMissionFinOpsBucket[];
	readonly byHost: readonly IMissionFinOpsBucket[];
	readonly byNode: readonly IMissionFinOpsNodeSpend[];
}

export type MissionHistoryEntryKind = 'goal' | 'milestone' | 'reject' | 'fail' | 'gate' | 'check' | 'retry';

export interface IMissionHistoryEntry {
	readonly nodeId?: string;
	readonly kind: MissionHistoryEntryKind;
	readonly digest: string;
	readonly artifacts: readonly string[];
	readonly metrics: readonly string[];
}

export interface IMissionRollingHistoryState {
	readonly archivedCount: number;
	readonly archivedNodeIds: readonly string[];
	readonly archivedArtifacts: readonly string[];
	readonly archivedOutcomes: readonly string[];
	readonly recentEntries: readonly IMissionHistoryEntry[];
}

export interface IMissionTokenCheckFailureInfo {
	readonly summary: string;
	readonly failedAt: number;
	readonly attempt: number;
	readonly maxAutoRetries: number;
}

export interface IMissionTokenBlockedInfo {
	readonly reason: string;
	readonly startedAt: number;
	readonly maxDurationMs: number;
	readonly expiresAt: number;
	readonly watchPid?: number;
	readonly watchFile?: string;
	/** File mtime (ms on target host's own clock) captured when blocked, or `null` if file did not exist yet. */
	readonly initialFileMtime?: number | null;
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

export interface IMissionReturnFrame {
	readonly nodeId: string;
	readonly waveId?: string;
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
	/** Rolling hierarchically compacted history of earlier steps in this wave (bounded high-SNR). */
	readonly compressedHistory: string;
	/** Structured multi-tier rolling history state (preserves cumulative step counts, node trail, artifacts & verdicts across hops/joins). */
	readonly historyState?: IMissionRollingHistoryState;
	/** Lightweight pointer into `state.traces` expandable via `token.trace`. */
	readonly tracePtr: string;
	readonly fromNodeId?: string;
	/** When set (via Reviewer/Gate reject), completing this reworked token returns directly to this node, bypassing join barriers & sibling fan-out. */
	readonly returnToNodeId?: string;
	/** Preserves the original wave ID before a Reviewer/Gate reject so downstream join barriers in the original wave release cleanly after rework returns. */
	readonly returnWaveId?: string;
	/** Stack of outer rework return targets preserved across nested Reviewer/Gate rejections. */
	readonly returnStack?: readonly IMissionReturnFrame[];
	/** Marks a single-branch arrival token parked inside a multi-inDegree join barrier (must not be retried standalone as a released join execution). */
	readonly isJoinArrival?: boolean;
	/** True when this token represents rework (check failure bounce, Reviewer/Gate rejection, or failure retry). */
	readonly isRework?: boolean;
	/** Trigger that flagged this token as rework so subsequent turns auto-attribute into the crimson noise segment. */
	readonly reworkReason?: MissionReworkNoiseReason;
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	readonly nudgeCount: number;
	/** Number of consecutive zero-cost deterministic check failures recorded on this active token. */
	readonly checkFailureCount?: number;
	/** Most recent deterministic verification failure details (surfaced in nudges & UI). */
	readonly lastCheckFailure?: IMissionTokenCheckFailureInfo;
	readonly blocked?: IMissionTokenBlockedInfo;
	readonly queued?: IMissionTokenQueueInfo;
	readonly failure?: IMissionTokenFailureInfo;
}

export interface IMissionJoinBarrier {
	readonly key: string;
	readonly waveId: string;
	readonly targetNodeId: string;
	readonly expectedFromNodeIds: readonly string[];
	readonly arrivedByFrom: Readonly<Record<string, IMissionToken>>;
	readonly skippedFromNodeIds: readonly string[];
	readonly restoreWaveId?: string;
	readonly restoreReturnToNodeId?: string;
	readonly restoreReturnWaveId?: string;
	readonly restoreReturnStack?: readonly IMissionReturnFrame[];
}

export type MissionReworkNoiseReason =
	| 'check_failed'
	| 'reviewer_rejected'
	| 'gate_rejected'
	| 'retry'
	| 'watchdog_nudge'
	| 'tool_error';


export * from './adeMissionFinOpsAndHistory.js';
import {
	buildMissionRunArchiveSnapshot,
	compactSummaryToBudget,
	compressTokenHistoryState,
	computeMissionTotalCostUsd,
	estimateNoiseDiagnosticTokens,
	expandTracePointer,
	IMissionNodeTelemetry,
	IMissionRunArchive,
	inferModelContextWindowTokens,
	MAX_MISSION_RUN_HISTORY,
	MAX_SILENCE_NUDGES_BEFORE_ESCALATE,
	mergeRollingHistoryStates,
	trimCleanlyToBudget,
} from './adeMissionFinOpsAndHistory.js';
import { collectReachableNodes } from './adeMissionGovernanceAndTriggers.js';

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
	/** Per-node live context window & token usage telemetry. */
	readonly nodeTelemetry?: Readonly<Record<string, IMissionNodeTelemetry>>;
	/** Maps each `waveId` to the entry root node IDs that minted that wave (used for deadlock-free wave-scoped Join Barriers). */
	readonly waveRoots?: Readonly<Record<string, readonly string[]>>;
	/** Effects deferred while Mission is `paused` (flushed automatically upon `resume`). */
	readonly deferredEffects?: readonly MissionEngineEffect[];
	/** FinOps hard budget ceiling in USD (undefined or <= 0 means unlimited). */
	readonly budgetLimitUsd?: number;
	/** Set true when cumulative costUsd hit or exceeded budgetLimitUsd, auto-pausing the Mission. */
	readonly budgetCircuitTripped?: boolean;
	/** Timestamp when the FinOps budget circuit-breaker tripped. */
	readonly budgetTrippedAt?: number;
	/** Chronological snapshots of Mission Mermaid topologies (`v1 ▸ vN`) for non-destructive timeline replay. */
	readonly revisions?: readonly IMissionDagRevision[];
	/** Multi-level concurrency limits governing wide fan-out & multi-wave dispatch (global / local / cloud host / provider). */
	readonly concurrencyLimits?: IMissionConcurrencyLimits;
	/** Monotonic counter of Mission runs (1, 2, 3...) for run ledger indexing. */
	readonly runSeq?: number;
	/** Chronological archived run ledgers preserved across re-runs for multi-run cost/latency/token comparison. */
	readonly runHistory?: readonly IMissionRunArchive[];
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
		readonly wakeupReason: 'silence_timeout' | 'block_expired' | 'pid_exited' | 'file_ready' | 'agent_exited';
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
	readonly code?: 'INVALID_STATE' | 'NOT_FOUND' | 'FORBIDDEN' | 'OUT_OF_JURISDICTION' | 'DANGLING_NODE_VIOLATION' | 'INVALID_DAG' | 'BOUNDARY_VIOLATION' | 'LOCKED_CONFIG' | 'CHECK_FAILED' | 'BUDGET_EXCEEDED';
	readonly outOfScopeNodeIds?: readonly string[];
	readonly danglingNodeIds?: readonly string[];
	readonly parentSupervisorId?: string;
}

const MAX_STORED_TRACES = 1000;
const MAX_STORED_ARCHIVED_TOKENS = 200;
const MAX_STORED_WAVES = 64;

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


const PRE_PROMPT_SECTION_HEADING = '### Node Pre-Prompt (`pre_prompt`)';
const PREV_SUMMARY_HEADING = '### Previous Step Summary (`last_summary`)';

/**
 * Packages a node's authored Pre-Prompt together with its live Mission Token dispatch payload
 * so woken agents immediately receive both their persistent task instructions and live token state.
 */
export function composeMissionNodeWakeupPrompt(
	tokenPrompt: string,
	nodePrePrompt: string | undefined,
): string {
	const cleaned = nodePrePrompt?.trim();
	if (!cleaned) {
		return tokenPrompt;
	}
	if (tokenPrompt.includes(PRE_PROMPT_SECTION_HEADING)) {
		return tokenPrompt;
	}
	const block = `${PRE_PROMPT_SECTION_HEADING}\n${cleaned}`;
	const anchorIdx = tokenPrompt.indexOf(PREV_SUMMARY_HEADING);
	if (anchorIdx >= 0) {
		return `${tokenPrompt.slice(0, anchorIdx)}${block}\n\n${tokenPrompt.slice(anchorIdx)}`;
	}
	return `${block}\n\n${tokenPrompt}`;
}

export function buildTokenDispatchPrompt(
	token: IMissionToken,
	nodeLabel: string,
	isRejection = false,
	nodePrePrompt?: string,
	bannerNote?: string,
): string {
	const lines: string[] = [
		...buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: token.nodeId,
			nodeLabel,
			sourceDescription: isRejection
				? `Mission revision bounce to node \`${token.nodeId}\` (wave \`${token.waveId}\`)`
				: `Mission baton dispatch to node \`${token.nodeId}\` (wave \`${token.waveId}\`)`,
		}),
		...(bannerNote ? [bannerNote] : []),
		`[Mission Token Dispatched — ${isRejection ? 'REVISION REQUESTED' : 'ACTIVE'}]`,
		`- Mission: \`${token.missionId}\` | Node: \`${token.nodeId}\` (${nodeLabel}) | Token: \`${token.id}\` | Wave: \`${token.waveId}\``,
		`- Trace Pointer: \`${token.tracePtr}\` (expand only if needed: \`aexus-ade token trace ${token.tracePtr} --json\`)`,
		'',
		PREV_SUMMARY_HEADING,
		sanitizeAdeSystemEnvelopeHeaders(token.lastSummary || '(Initial entry step — no upstream summary)'),
	];
	if (token.compressedHistory) {
		const renderedHistory = sanitizeAdeSystemEnvelopeHeaders(
			token.compressedHistory.replace(/aexus-ade token trace <ptr>/g, `aexus-ade token trace ${token.tracePtr}`),
		);
		lines.push('', '### Compressed Earlier History (`compressed_history`)', renderedHistory);
	}
	lines.push(
		'',
		'### Completion / Reporting Commands',
		`- Complete: \`aexus-ade token complete ${token.id} --summary "<plain human summary of concrete changes & conclusions>" --json\``,
		`- Long-running wait: \`aexus-ade token block ${token.id} --duration <e.g. 2h> --reason "<why>" [--watch-pid <pid>] [--watch-file <path>] --json\``,
		`- Reviewer reject: \`aexus-ade token reject ${token.id} --reason "<concrete defects>" --json\``,
		`- Unrecoverable failure: \`aexus-ade token fail ${token.id} --reason "<root cause>" --json\``,
	);
	return composeMissionNodeWakeupPrompt(lines.join('\n'), nodePrePrompt);
}

export interface IMutableEngineContext {
	status: MissionRunStatus;
	silenceTimeoutMinutes: number;
	silenceTimeoutLocked: boolean;
	boundary: IMissionBoundaryConfig;
	triggers: IMissionSourceTrigger[];
	nodeStates: Record<string, MissionNodeRuntimeStatus>;
	tokens: Record<string, IMissionToken>;
	joinBarriers: Record<string, IMissionJoinBarrier>;
	traces: Record<string, IMissionTraceNode>;
	nodeTelemetry?: Record<string, IMissionNodeTelemetry>;
	waveRoots: Record<string, readonly string[]>;
	deferredEffects: MissionEngineEffect[];
	budgetLimitUsd?: number;
	budgetCircuitTripped?: boolean;
	budgetTrippedAt?: number;
	revisions?: IMissionDagRevision[];
	concurrencyLimits?: IMissionConcurrencyLimits;
	runSeq: number;
	runHistory: IMissionRunArchive[];
	waveSeq: number;
	tokenSeq: number;
	traceSeq: number;
	startedAt?: number;
	completedAt?: number;
	updatedAt: number;
	effects: MissionEngineEffect[];
}

export function cloneMutable(state: IMissionRuntimeState, now: number): IMutableEngineContext {
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
		...(state.nodeTelemetry ? { nodeTelemetry: { ...state.nodeTelemetry } } : {}),
		waveRoots: { ...(state.waveRoots ?? {}) },
		deferredEffects: [...(state.deferredEffects ?? [])],
		...(state.budgetLimitUsd !== undefined ? { budgetLimitUsd: state.budgetLimitUsd } : {}),
		...(state.budgetCircuitTripped !== undefined ? { budgetCircuitTripped: state.budgetCircuitTripped } : {}),
		...(state.budgetTrippedAt !== undefined ? { budgetTrippedAt: state.budgetTrippedAt } : {}),
		...(state.revisions ? { revisions: [...state.revisions] } : {}),
		...(state.concurrencyLimits ? { concurrencyLimits: state.concurrencyLimits } : {}),
		runSeq: state.runSeq ?? (state.startedAt !== undefined ? Math.max(1, (state.runHistory?.length ?? 0) + 1) : (state.runHistory?.length ?? 0)),
		runHistory: state.runHistory ? [...state.runHistory] : [],
		waveSeq: state.waveSeq,
		tokenSeq: state.tokenSeq,
		traceSeq: state.traceSeq,
		startedAt: state.startedAt,
		completedAt: state.completedAt,
		updatedAt: now,
		effects: [],
	};
}

export function resolveLiveTokenHolder(
	boundary: IMissionBoundaryConfig,
	token: Pick<IMissionToken, 'nodeId' | 'holderAgentId'>,
): string | undefined {
	return boundary.nodeAssignments[token.nodeId]?.agentId ?? token.holderAgentId;
}

export function recomputeNodeState(
	ctx: IMutableEngineContext,
	nodeId: string,
	fallbackState: MissionNodeRuntimeStatus = 'idle',
): void {
	recomputeNodeStatesBatch(ctx, new Set([nodeId]), fallbackState);
}

/**
 * Single-pass O(T + B) state recomputation across a batch of nodes (eliminates O(Q * T) queue scans).
 */
export function recomputeNodeStatesBatch(
	ctx: IMutableEngineContext,
	nodeIds: ReadonlySet<string>,
	fallbackState: MissionNodeRuntimeStatus = 'idle',
): void {
	if (nodeIds.size === 0) {
		return;
	}
	const rankOf = (status: MissionTokenStatus): number => {
		switch (status) {
			case 'active': return 6;
			case 'waiting_gate': return 5;
			case 'blocked': return 4;
			case 'queued': return 3;
			case 'frozen_failed': return 2;
			case 'waiting_join': return 1;
			default: return 0;
		}
	};
	const bestRankByNode = new Map<string, number>();
	for (const tok of Object.values(ctx.tokens)) {
		if (!nodeIds.has(tok.nodeId)) {
			continue;
		}
		const r = rankOf(tok.status);
		if (r > (bestRankByNode.get(tok.nodeId) ?? 0)) {
			bestRankByNode.set(tok.nodeId, r);
		}
	}
	const barrierTargets = new Set<string>();
	for (const barrier of Object.values(ctx.joinBarriers)) {
		if (nodeIds.has(barrier.targetNodeId)) {
			barrierTargets.add(barrier.targetNodeId);
		}
	}
	for (const nodeId of nodeIds) {
		const best = bestRankByNode.get(nodeId) ?? 0;
		if (best === 6) {
			ctx.nodeStates[nodeId] = 'active';
		} else if (best === 5) {
			ctx.nodeStates[nodeId] = 'waiting_gate';
		} else if (best === 4) {
			ctx.nodeStates[nodeId] = 'blocked';
		} else if (best === 3) {
			ctx.nodeStates[nodeId] = 'queued';
		} else if (best === 2) {
			ctx.nodeStates[nodeId] = 'failed';
		} else if (best === 1 || barrierTargets.has(nodeId)) {
			ctx.nodeStates[nodeId] = 'waiting_join';
		} else {
			ctx.nodeStates[nodeId] = fallbackState;
		}
	}
}

function pruneMissionRuntimeHistory(ctx: IMutableEngineContext): void {
	const allTokens = Object.values(ctx.tokens);
	const terminalTokens = allTokens.filter(t => t.status === 'completed' || t.status === 'recalled');
	if (terminalTokens.length > MAX_STORED_ARCHIVED_TOKENS) {
		const protectedIds = new Set<string>();
		// Always retain any token referenced in an open join barrier and the latest completed token per nodeId
		// (used by applySafeMissionPatch / rollback anchor lookup).
		for (const barrier of Object.values(ctx.joinBarriers)) {
			for (const arrivedTok of Object.values(barrier.arrivedByFrom)) {
				protectedIds.add(arrivedTok.id);
			}
		}
		const latestCompletedByNode = new Map<string, IMissionToken>();
		for (const tok of terminalTokens) {
			if (tok.status === 'completed' && !tok.isJoinArrival) {
				const prev = latestCompletedByNode.get(tok.nodeId);
				if (!prev || tok.lastActivityAt >= prev.lastActivityAt) {
					latestCompletedByNode.set(tok.nodeId, tok);
				}
			}
		}
		for (const tok of latestCompletedByNode.values()) {
			protectedIds.add(tok.id);
		}
		const evictable = terminalTokens
			.filter(t => !protectedIds.has(t.id))
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
		const targetDrop = terminalTokens.length - MAX_STORED_ARCHIVED_TOKENS;
		for (let i = 0; i < Math.min(targetDrop, evictable.length); i++) {
			delete ctx.tokens[evictable[i].id];
		}
	}

	const waveIds = Object.keys(ctx.waveRoots);
	if (waveIds.length > MAX_STORED_WAVES) {
		const activeWaveIds = new Set<string>();
		for (const tok of Object.values(ctx.tokens)) {
			activeWaveIds.add(tok.waveId);
			if (tok.returnWaveId) {
				activeWaveIds.add(tok.returnWaveId);
			}
		}
		for (const barrier of Object.values(ctx.joinBarriers)) {
			activeWaveIds.add(barrier.waveId);
			if (barrier.restoreWaveId) {
				activeWaveIds.add(barrier.restoreWaveId);
			}
		}
		const waveNum = (id: string): number => {
			const m = /^wave-(\d+)$/.exec(id);
			return m ? Number.parseInt(m[1], 10) : 0;
		};
		const evictableWaves = waveIds
			.filter(id => !activeWaveIds.has(id))
			.sort((a, b) => waveNum(a) - waveNum(b));
		const dropCount = waveIds.length - MAX_STORED_WAVES;
		for (let i = 0; i < Math.min(dropCount, evictableWaves.length); i++) {
			delete ctx.waveRoots[evictableWaves[i]];
		}
	}

	if (Object.keys(ctx.traces).length > MAX_STORED_TRACES) {
		pruneOldCompletedTraces(ctx);
	}
}

export function freezeMutable(missionId: string, ctx: IMutableEngineContext): IMissionRuntimeState {
	pruneMissionRuntimeHistory(ctx);
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
		...(ctx.nodeTelemetry && Object.keys(ctx.nodeTelemetry).length > 0 ? { nodeTelemetry: ctx.nodeTelemetry } : {}),
		...(Object.keys(ctx.waveRoots).length > 0 ? { waveRoots: ctx.waveRoots } : {}),
		...(ctx.deferredEffects.length > 0 ? { deferredEffects: ctx.deferredEffects } : {}),
		...(ctx.budgetLimitUsd !== undefined ? { budgetLimitUsd: ctx.budgetLimitUsd } : {}),
		...(ctx.budgetCircuitTripped !== undefined ? { budgetCircuitTripped: ctx.budgetCircuitTripped } : {}),
		...(ctx.budgetTrippedAt !== undefined ? { budgetTrippedAt: ctx.budgetTrippedAt } : {}),
		...(ctx.revisions && ctx.revisions.length > 0 ? { revisions: ctx.revisions } : {}),
		...(ctx.concurrencyLimits ? { concurrencyLimits: ctx.concurrencyLimits } : {}),
		...(ctx.runSeq > 0 ? { runSeq: ctx.runSeq } : {}),
		...(ctx.runHistory.length > 0 ? { runHistory: ctx.runHistory } : {}),
		waveSeq: ctx.waveSeq,
		tokenSeq: ctx.tokenSeq,
		traceSeq: ctx.traceSeq,
		startedAt: ctx.startedAt,
		completedAt: ctx.completedAt,
		updatedAt: ctx.updatedAt,
	};
}

function pruneOldCompletedTraces(ctx: IMutableEngineContext): void {
	const allPtrs = Object.keys(ctx.traces);
	if (allPtrs.length <= MAX_STORED_TRACES) {
		return;
	}
	const protectedPtrs = new Set<string>();
	const markReachable = (startPtr: string) => {
		const stack = [startPtr];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (!cur || protectedPtrs.has(cur)) {
				continue;
			}
			const node = ctx.traces[cur];
			if (!node) {
				continue;
			}
			protectedPtrs.add(cur);
			for (const p of node.parentPtrs) {
				if (!protectedPtrs.has(p)) {
					stack.push(p);
				}
			}
		}
	};
	for (const tok of Object.values(ctx.tokens)) {
		if (tok.status === 'active' || tok.status === 'queued' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
			markReachable(tok.tracePtr);
		}
	}
	for (const barrier of Object.values(ctx.joinBarriers)) {
		for (const arrivedTok of Object.values(barrier.arrivedByFrom)) {
			markReachable(arrivedTok.tracePtr);
		}
	}
	const evictable = allPtrs
		.filter(ptr => !protectedPtrs.has(ptr))
		.sort((a, b) => (ctx.traces[a]?.timestamp ?? 0) - (ctx.traces[b]?.timestamp ?? 0));
	const targetDrop = allPtrs.length - MAX_STORED_TRACES;
	for (let i = 0; i < Math.min(targetDrop, evictable.length); i++) {
		delete ctx.traces[evictable[i]];
	}
}

export function appendTrace(
	ctx: IMutableEngineContext,
	entry: Omit<IMissionTraceNode, 'ptr'>,
): string {
	ctx.traceSeq += 1;
	const ptr = `trc-${ctx.traceSeq}`;
	ctx.traces[ptr] = { ptr, ...entry };
	if (ctx.traceSeq % 64 === 0) {
		pruneOldCompletedTraces(ctx);
	}
	return ptr;
}

export function getIncomingEdges(graph: Pick<IMissionDagParseResult, 'edges'>, nodeId: string) {
	return graph.edges.filter(e => e.to === nodeId);
}

export function getOutgoingEdges(graph: Pick<IMissionDagParseResult, 'edges'>, nodeId: string, kind?: 'success' | 'fail') {
	return graph.edges.filter(e => e.from === nodeId && (!kind || getMissionEdgeKind(e) === kind));
}

export function computeWaveExpectedIncoming(
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

export function deliverTokenToTarget(
	missionId: string,
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	params: {
		readonly targetNodeId: string;
		readonly fromNodeId?: string;
		readonly waveId: string;
		readonly lastSummary: string;
		readonly compressedHistory: string;
		readonly historyState?: IMissionRollingHistoryState;
		readonly tracePtr: string;
		readonly now: number;
		readonly isRejection?: boolean;
		readonly bypassJoin?: boolean;
		readonly returnToNodeId?: string;
		readonly returnWaveId?: string;
		readonly returnStack?: readonly IMissionReturnFrame[];
		readonly restoreWaveId?: string;
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
			...(params.restoreWaveId ? { restoreWaveId: params.restoreWaveId } : {}),
			...(params.returnToNodeId ? { restoreReturnToNodeId: params.returnToNodeId } : {}),
			...(params.returnWaveId ? { restoreReturnWaveId: params.returnWaveId } : {}),
			...(params.returnStack && params.returnStack.length > 0 ? { restoreReturnStack: params.returnStack } : {}),
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
			...(params.historyState ? { historyState: params.historyState } : {}),
			tracePtr: params.tracePtr,
			fromNodeId: params.fromNodeId,
			isJoinArrival: true,
			arrivedAt: params.now,
			lastActivityAt: params.now,
			nudgeCount: 0,
		};
		ctx.tokens[waitingTok.id] = waitingTok;
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
			...(params.restoreWaveId && !existing.restoreWaveId ? { restoreWaveId: params.restoreWaveId } : {}),
			...(params.returnToNodeId && !existing.restoreReturnToNodeId ? { restoreReturnToNodeId: params.returnToNodeId } : {}),
			...(params.returnWaveId && !existing.restoreReturnWaveId ? { restoreReturnWaveId: params.returnWaveId } : {}),
			...(params.returnStack && params.returnStack.length > 0 && !existing.restoreReturnStack ? { restoreReturnStack: params.returnStack } : {}),
		};
		ctx.joinBarriers[barrierKey] = updatedBarrier;
		ctx.nodeStates[targetNode.id] = 'waiting_join';
		return tryReleaseJoinBarrier(missionId, ctx, graph, barrierKey, params.now);
	}

	return materializeAndDispatchToken(missionId, ctx, graph, {
		targetNodeId: targetNode.id,
		fromNodeId: params.fromNodeId,
		waveId: params.restoreWaveId ?? params.waveId,
		lastSummary: params.lastSummary,
		compressedHistory: params.compressedHistory,
		historyState: params.historyState,
		tracePtr: params.tracePtr,
		now: params.now,
		isRejection: params.isRejection,
		returnToNodeId: params.returnToNodeId,
		returnWaveId: params.returnWaveId,
		returnStack: params.returnStack,
	});
}

export function tryReleaseJoinBarrier(
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
		if (ctx.nodeStates[barrier.targetNodeId] === 'waiting_join') {
			ctx.nodeStates[barrier.targetNodeId] = 'idle';
		}
		// Every incoming branch was skipped/recalled -> propagate skip downstream!
		for (const outEdge of getOutgoingEdges(graph, barrier.targetNodeId)) {
			markBranchSkipped(missionId, ctx, graph, barrier.waveId, barrier.targetNodeId, outEdge.to, now);
		}
		return undefined;
	}

	const mergedLastSummary = arrivedList
		.map(t => `[${t.fromNodeId ?? t.nodeId}] ${t.lastSummary}`.trim())
		.join('\n');
	const mergedHistory = mergeRollingHistoryStates(arrivedList);
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
		waveId: barrier.restoreWaveId ?? barrier.waveId,
		lastSummary: mergedLastSummary,
		compressedHistory: mergedHistory.text,
		historyState: mergedHistory.state,
		tracePtr: joinPtr,
		now,
		returnToNodeId: barrier.restoreReturnToNodeId,
		returnWaveId: barrier.restoreReturnWaveId,
		returnStack: barrier.restoreReturnStack,
	});
}

export function markBranchSkipped(
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

/**
 * Reverses a previous `markBranchSkipped` mark when a recalled branch is explicitly retried
 * before its downstream join barrier has released.
 */
function clearBranchSkipped(
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	waveId: string,
	fromNodeId: string,
	targetNodeId: string,
	visited = new Set<string>(),
): void {
	const edgeKey = `${fromNodeId}->${targetNodeId}`;
	if (visited.has(edgeKey)) {
		return;
	}
	visited.add(edgeKey);
	const expectedFrom = computeWaveExpectedIncoming(ctx, graph, waveId, targetNodeId);
	if (!expectedFrom.includes(fromNodeId)) {
		return;
	}
	if (expectedFrom.length <= 1) {
		for (const outEdge of getOutgoingEdges(graph, targetNodeId)) {
			clearBranchSkipped(ctx, graph, waveId, targetNodeId, outEdge.to, visited);
		}
		return;
	}
	const barrierKey = `${waveId}::${targetNodeId}`;
	const existing = ctx.joinBarriers[barrierKey];
	if (!existing || !existing.skippedFromNodeIds.includes(fromNodeId)) {
		return;
	}
	const nextSkipped = existing.skippedFromNodeIds.filter(id => id !== fromNodeId);
	if (nextSkipped.length === 0 && Object.keys(existing.arrivedByFrom).length === 0) {
		delete ctx.joinBarriers[barrierKey];
	} else {
		ctx.joinBarriers[barrierKey] = {
			...existing,
			skippedFromNodeIds: nextSkipped,
		};
	}
}

/**
 * Finds downstream multi-input join nodes impacted by recalling `startNodeIds`
 * (traversing single-input linear segments until reaching a join node with >=2 incoming edges).
 */
export function collectImpactedDownstreamJoins(
	graph: Pick<IMissionDagParseResult, 'edges'>,
	startNodeIds: ReadonlySet<string>,
): Set<string> {
	const inDeg = new Map<string, number>();
	for (const e of graph.edges) {
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
	}
	const joins = new Set<string>();
	const visited = new Set<string>();
	const queue = [...startNodeIds];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (visited.has(cur)) {
			continue;
		}
		visited.add(cur);
		for (const outEdge of getOutgoingEdges(graph, cur)) {
			if ((inDeg.get(outEdge.to) ?? 0) > 1) {
				joins.add(outEdge.to);
			} else if (!visited.has(outEdge.to)) {
				queue.push(outEdge.to);
			}
		}
	}
	return joins;
}

function renumberMissionConcurrencyQueue(ctx: IMutableEngineContext): void {
	renumberMissionConcurrencyQueueCore(ctx, {
		buildPrompt: (tok, nodeId, isRejection) => buildTokenDispatchPrompt(tok, nodeId, isRejection),
		recomputeNodeStatesBatch: (nodeIds, fallbackState) => recomputeNodeStatesBatch(ctx, nodeIds, fallbackState),
	});
}

/**
 * Work-conserving multi-level FIFO concurrency scheduler:
 * promotes every queued token whose `(host, provider, global)` semaphores have free capacity,
 * avoiding head-of-line blocking across independent hosts/providers, then renumbers remaining ranks `#1..#K`.
 */
export function drainMissionConcurrencyQueue(
	missionId: string,
	ctx: IMutableEngineContext,
	now: number,
): string[] {
	return drainMissionConcurrencyQueueCore(missionId, ctx, now, {
		buildPrompt: (tok, nodeId, isRejection) => buildTokenDispatchPrompt(tok, nodeId, isRejection),
		recomputeNodeStatesBatch: (nodeIds, fallbackState) => recomputeNodeStatesBatch(ctx, nodeIds, fallbackState),
		emitDispatch: effect => { ctx.effects.push(effect); },
	});
}

/**
 * Updates a Mission's multi-level concurrency limits and immediately drains queued tokens
 * whenever raising limits frees capacity.
 */
export function setMissionConcurrencyLimits(
	state: IMissionRuntimeState,
	limits: IMissionConcurrencyLimits | undefined,
	now = Date.now(),
): IMissionEngineTransitionResult<{ readonly promotedTokenIds: readonly string[] }> {
	const ctx = cloneMutable(state, now);
	ctx.concurrencyLimits = limits ? normalizeMissionConcurrencyLimits(limits) : undefined;
	const promotedTokenIds = drainMissionConcurrencyQueue(state.missionId, ctx, now);
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { promotedTokenIds },
	};
}

function markNodeReworkNoise(
	ctx: IMutableEngineContext,
	nodeId: string,
	reason: MissionReworkNoiseReason,
	diagnosticText: string | undefined,
	now: number,
): void {
	const prev = ctx.nodeTelemetry?.[nodeId];
	const contextWindowMax = prev?.contextWindowMax
		?? inferModelContextWindowTokens(prev?.model, { engineId: prev?.engineId });
	const addedNoise = estimateNoiseDiagnosticTokens(diagnosticText);
	const nextNoise = Math.min(contextWindowMax, (prev?.contextNoiseTokens ?? 0) + addedNoise);
	ctx.nodeTelemetry = {
		...(ctx.nodeTelemetry ?? {}),
		[nodeId]: {
			inputTokens: prev?.inputTokens ?? 0,
			outputTokens: prev?.outputTokens ?? 0,
			cacheReadTokens: prev?.cacheReadTokens ?? 0,
			cacheWriteTokens: prev?.cacheWriteTokens ?? 0,
			totalTokens: prev?.totalTokens ?? 0,
			costUsd: prev?.costUsd ?? 0,
			...(prev?.costEstimated ? { costEstimated: true } : {}),
			...(prev?.costLocalFree ? { costLocalFree: true } : {}),
			...(prev?.estimatedCostUsd !== undefined ? { estimatedCostUsd: prev.estimatedCostUsd } : {}),
			...(prev?.pendingInterimEstimatedCostUsd !== undefined ? { pendingInterimEstimatedCostUsd: prev.pendingInterimEstimatedCostUsd } : {}),
			turns: prev?.turns ?? 0,
			contextWindowMax,
			contextInitTokens: prev?.contextInitTokens ?? 0,
			contextTierDocTokens: prev?.contextTierDocTokens ?? 0,
			contextSourceTokens: prev?.contextSourceTokens ?? 0,
			contextNoiseTokens: nextNoise,
			pendingNoiseReason: reason,
			...(prev?.noiseTurns !== undefined ? { noiseTurns: prev.noiseTurns } : {}),
			...(prev?.model ? { model: prev.model } : {}),
			...(prev?.engineId ? { engineId: prev.engineId } : {}),
			...(prev?.summary ? { summary: prev.summary } : {}),
			...(prev?.lastCheckStatus ? { lastCheckStatus: prev.lastCheckStatus } : {}),
			...(prev?.lastCheckSummary ? { lastCheckSummary: prev.lastCheckSummary } : {}),
			...(prev?.lastCheckAt !== undefined ? { lastCheckAt: prev.lastCheckAt } : {}),
			updatedAt: now,
		},
	};
}

export function materializeAndDispatchToken(
	missionId: string,
	ctx: IMutableEngineContext,
	graph: IMissionDagParseResult,
	params: {
		readonly targetNodeId: string;
		readonly fromNodeId?: string;
		readonly waveId: string;
		readonly lastSummary: string;
		readonly compressedHistory: string;
		readonly historyState?: IMissionRollingHistoryState;
		readonly tracePtr: string;
		readonly now: number;
		readonly isRejection?: boolean;
		readonly reworkReason?: MissionReworkNoiseReason;
		readonly returnToNodeId?: string;
		readonly returnWaveId?: string;
		readonly returnStack?: readonly IMissionReturnFrame[];
	},
): IMissionToken {
	const targetNode = graph.nodes.find(n => n.id === params.targetNodeId)!;
	const holderAgentId = ctx.boundary.nodeAssignments[targetNode.id]?.agentId;
	ctx.tokenSeq += 1;
	const isGate = targetNode.kind === 'gate';
	const effectiveReworkReason: MissionReworkNoiseReason | undefined = params.reworkReason
		?? (params.isRejection
			? (params.fromNodeId && graph.nodes.find(n => n.id === params.fromNodeId)?.kind === 'gate'
				? 'gate_rejected'
				: 'reviewer_rejected')
			: undefined);
	const isRework = Boolean(effectiveReworkReason || params.isRejection);
	if (isRework && !isGate && effectiveReworkReason) {
		markNodeReworkNoise(ctx, targetNode.id, effectiveReworkReason, params.lastSummary, params.now);
	} else if (!isRework && !isGate && ctx.nodeTelemetry?.[targetNode.id]?.pendingNoiseReason) {
		// Starting a fresh clean token on a node whose previous rework wave was abandoned/recalled clears stale pendingNoiseReason.
		const prevTel = ctx.nodeTelemetry[targetNode.id];
		ctx.nodeTelemetry = {
			...ctx.nodeTelemetry,
			[targetNode.id]: {
				...prevTel,
				pendingNoiseReason: undefined,
			},
		};
	}
	const baseToken: IMissionToken = {
		id: `tok-${ctx.tokenSeq}`,
		missionId,
		waveId: params.waveId,
		nodeId: targetNode.id,
		holderAgentId,
		status: isGate ? 'waiting_gate' : 'active',
		lastSummary: params.lastSummary,
		compressedHistory: params.compressedHistory,
		...(params.historyState ? { historyState: params.historyState } : {}),
		tracePtr: params.tracePtr,
		fromNodeId: params.fromNodeId,
		...(params.returnToNodeId ? { returnToNodeId: params.returnToNodeId } : {}),
		...(params.returnWaveId ? { returnWaveId: params.returnWaveId } : {}),
		...(params.returnStack && params.returnStack.length > 0 ? { returnStack: params.returnStack } : {}),
		...(isRework ? { isRework: true } : {}),
		...(effectiveReworkReason ? { reworkReason: effectiveReworkReason } : {}),
		arrivedAt: params.now,
		lastActivityAt: params.now,
		nudgeCount: 0,
	};

	if (isGate) {
		ctx.tokens[baseToken.id] = baseToken;
		ctx.nodeStates[targetNode.id] = 'waiting_gate';
		const rollbackCandidates = collectValidUpstreamRollbackCandidates(ctx, graph, targetNode.id, params.tracePtr, params.fromNodeId).map(c => ({
			id: c.id,
			title: c.title,
		}));
		ctx.effects.push({
			kind: 'upsert_gate_inbox',
			missionId,
			nodeId: targetNode.id,
			tokenId: baseToken.id,
			nodeTitle: targetNode.label,
			upstreamSummary: params.lastSummary,
			rollbackCandidates,
		});
		return baseToken;
	}

	const dispatchPrompt = buildTokenDispatchPrompt(baseToken, targetNode.label, params.isRejection);
	if (ctx.status === 'paused') {
		ctx.tokens[baseToken.id] = baseToken;
		recomputeNodeState(ctx, targetNode.id, 'active');
		ctx.deferredEffects.push({
			kind: 'dispatch_token',
			missionId,
			nodeId: targetNode.id,
			tokenId: baseToken.id,
			holderAgentId,
			isRejection: params.isRejection,
			prompt: dispatchPrompt,
		});
		return baseToken;
	}

	const limits = normalizeMissionConcurrencyLimits(ctx.concurrencyLimits);
	const usage = computeConcurrencySlotUsage(ctx);
	const admission = evaluateConcurrencySlot(ctx, usage, targetNode.id, limits);
	if (admission.admitted) {
		ctx.tokens[baseToken.id] = baseToken;
		recomputeNodeState(ctx, targetNode.id, 'active');
		ctx.effects.push({
			kind: 'dispatch_token',
			missionId,
			nodeId: targetNode.id,
			tokenId: baseToken.id,
			holderAgentId,
			isRejection: params.isRejection,
			prompt: dispatchPrompt,
		});
		return baseToken;
	}

	// Concurrency slot saturated (global / local / cloud host / provider) -> park token in FIFO queue!
	const queuedToken: IMissionToken = {
		...baseToken,
		status: 'queued',
		queued: {
			position: 1,
			totalQueued: 1,
			blockedBy: admission.blockedBy,
			scopeKey: admission.scopeKey,
			activeSlots: admission.activeSlots,
			maxSlots: admission.maxSlots,
			enqueuedAt: params.now,
			pendingPrompt: dispatchPrompt,
			...(params.isRejection ? { isRejection: true } : {}),
		},
	};
	ctx.tokens[queuedToken.id] = queuedToken;
	renumberMissionConcurrencyQueue(ctx);
	return ctx.tokens[queuedToken.id];
}

export function checkMissionCompletion(ctx: IMutableEngineContext): void {
	if (ctx.status !== 'running') {
		return;
	}
	const hasLiveTokens = Object.values(ctx.tokens).some(t =>
		t.status === 'active' || t.status === 'queued' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join' || t.status === 'frozen_failed',
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
		readonly concurrencyLimits?: IMissionConcurrencyLimits;
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
	// Archive previous run's telemetry ledger (cost, duration, tokens, per-node metrics) before starting a fresh run
	// so re-runs never erase historical optimization baselines.
	const hadPreviousRun = ctx.startedAt !== undefined && (
		Object.keys(ctx.nodeTelemetry ?? {}).length > 0
		|| Object.keys(ctx.tokens).length > 0
		|| state.status === 'completed'
		|| state.status === 'stopped'
		|| state.status === 'failed'
	);
	if (hadPreviousRun) {
		const prevStartedAt = ctx.startedAt!;
		const alreadyArchived = ctx.runHistory.some(entry => entry.startedAt === prevStartedAt);
		if (!alreadyArchived) {
			const archiveRunNumber = ctx.runSeq > 0 ? ctx.runSeq : (ctx.runHistory.length + 1);
			const archived = buildMissionRunArchiveSnapshot(
				{
					status: state.status,
					startedAt: prevStartedAt,
					completedAt: ctx.completedAt,
					updatedAt: state.updatedAt,
					boundary: ctx.boundary,
					nodeStates: ctx.nodeStates,
					tokens: ctx.tokens,
					nodeTelemetry: ctx.nodeTelemetry,
					waveRoots: ctx.waveRoots,
					budgetLimitUsd: ctx.budgetLimitUsd,
					budgetCircuitTripped: ctx.budgetCircuitTripped,
					revisions: ctx.revisions,
					runSeq: archiveRunNumber,
					runHistory: ctx.runHistory,
				},
				graph.nodes,
				{ runNumber: archiveRunNumber, now },
			);
			ctx.runHistory.push(archived);
			if (ctx.runHistory.length > MAX_MISSION_RUN_HISTORY) {
				ctx.runHistory.splice(0, ctx.runHistory.length - MAX_MISSION_RUN_HISTORY);
			}
			ctx.runSeq = Math.max(ctx.runSeq, archiveRunNumber);
		}
	}
	ctx.runSeq = Math.max(ctx.runSeq, ctx.runHistory.length) + 1;
	ctx.silenceTimeoutLocked = true;
	ctx.status = 'running';
	ctx.startedAt = now;
	ctx.completedAt = undefined;
	ctx.budgetCircuitTripped = false;
	ctx.budgetTrippedAt = undefined;
	ctx.deferredEffects = [];
	ctx.nodeTelemetry = {};
	// Reset previous run's live execution graphs so stale frozen_failed/waiting tokens from Run N never poison Run N+1
	// (while preserving strictly monotonic tokenSeq/waveSeq/traceSeq and archived runHistory).
	ctx.tokens = {};
	ctx.joinBarriers = {};
	ctx.waveRoots = {};
	ctx.traces = {};
	if (options?.concurrencyLimits) {
		ctx.concurrencyLimits = normalizeMissionConcurrencyLimits(options.concurrencyLimits);
	}
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

export function distillMissionNodeContext(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	nodeId: string,
	options?: { readonly memo?: string; readonly now?: number },
): IMissionEngineTransitionResult<{ readonly distilledMemo: string; readonly tokenId?: string }> {
	const node = graph.nodes.find(n => n.id === nodeId);
	if (!node || node.kind === 'gate') {
		return { ok: false, state, effects: [], code: 'NOT_FOUND', error: `Task node "${nodeId}" not found for context distillation.` };
	}
	const now = options?.now ?? Date.now();
	const ctx = cloneMutable(state, now);

	// Find primary LIVE token on this node (never mutate historical completed/recalled tokens)
	const nodeTokens = Object.values(ctx.tokens)
		.filter(t => t.nodeId === nodeId)
		.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
	const liveTok = nodeTokens.find(t => t.status === 'active' || t.status === 'blocked' || t.status === 'frozen_failed');
	const refTok = liveTok ?? nodeTokens[0];

	const customMemo = options?.memo?.trim();
	const priorSummary = refTok?.lastSummary?.trim();
	const priorErr = refTok?.failure?.reason || refTok?.lastCheckFailure?.summary;
	const memoParts = [
		customMemo ? `Supervisor Memo: ${customMemo}` : undefined,
		priorSummary ? `Previous Handoff: ${compactSummaryToBudget(priorSummary, 180, [], [])}` : undefined,
		priorErr ? `Pitfalls to Avoid: ${compactSummaryToBudget(priorErr, 180, [], [])}` : undefined,
		'All local/remote workspace files on disk have been preserved. Continue cleanly from the existing workspace state.',
	].filter((v): v is string => Boolean(v));
	const distilledMemo = memoParts.join('\n');

	// Reset noisy working context bars to a crisp distilled baseline while keeping cumulative spend & total tokens honest.
	const prevTel = ctx.nodeTelemetry?.[nodeId];
	if (prevTel) {
		ctx.nodeTelemetry = {
			...(ctx.nodeTelemetry ?? {}),
			[nodeId]: {
				...prevTel,
				contextSourceTokens: Math.min(2_400, prevTel.contextSourceTokens),
				contextNoiseTokens: 0,
				pendingNoiseReason: undefined,
				summary: `✨ Context distilled — fresh session ready`,
				updatedAt: now,
			},
		};
	}

	const assignedAgentId = ctx.boundary.nodeAssignments[nodeId]?.agentId ?? liveTok?.holderAgentId;
	if (liveTok) {
		const wasActive = liveTok.status === 'active';
		const hadWatchPid = liveTok.status === 'blocked' && liveTok.blocked?.watchPid !== undefined;
		const distillTracePtr = appendTrace(ctx, {
			parentPtrs: [liveTok.tracePtr],
			nodeId,
			employeeId: assignedAgentId,
			waveId: liveTok.waveId,
			event: 'distill',
			summary: customMemo ? `Context distilled: ${customMemo}` : 'Context distilled & session refreshed',
			timestamp: now,
		});
		const baseUpdatedTok: IMissionToken = {
			...liveTok,
			status: 'active',
			holderAgentId: assignedAgentId,
			lastSummary: distilledMemo,
			tracePtr: distillTracePtr,
			lastActivityAt: now,
			nudgeCount: 0,
			checkFailureCount: 0,
			lastCheckFailure: undefined,
			isRework: undefined,
			reworkReason: undefined,
			blocked: undefined,
			queued: undefined,
			failure: undefined,
		};

		if (assignedAgentId) {
			ctx.effects.push({
				kind: 'stop_agent',
				missionId: state.missionId,
				nodeId,
				tokenId: liveTok.id,
				holderAgentId: assignedAgentId,
				reason: 'Context distillation refresh requested',
			});
		}

		const distillPrompt = buildTokenDispatchPrompt(baseUpdatedTok, node.label, false, undefined, '[Context Distilled & Session Refreshed]');
		let shouldQueue = false;
		let queueDecision: ReturnType<typeof evaluateConcurrencySlot> | undefined;
		if (!wasActive && ctx.status === 'running') {
			// Clear old blocked/failed record before measuring active slot occupancy so this token never double-counts itself.
			ctx.tokens[liveTok.id] = { ...baseUpdatedTok, status: 'frozen_failed' };
			const limits = normalizeMissionConcurrencyLimits(ctx.concurrencyLimits);
			const usage = computeConcurrencySlotUsage(ctx);
			queueDecision = evaluateConcurrencySlot(ctx, usage, nodeId, limits);
			shouldQueue = !queueDecision.admitted;
		}

		if (shouldQueue && queueDecision && !queueDecision.admitted) {
			ctx.tokens[liveTok.id] = {
				...baseUpdatedTok,
				status: 'queued',
				queued: {
					position: 0,
					totalQueued: 0,
					blockedBy: queueDecision.blockedBy,
					scopeKey: queueDecision.scopeKey,
					activeSlots: queueDecision.activeSlots,
					maxSlots: queueDecision.maxSlots,
					enqueuedAt: now,
					pendingPrompt: distillPrompt,
				},
			};
			if (hadWatchPid) {
				drainMissionConcurrencyQueue(state.missionId, ctx, now);
			} else {
				renumberMissionConcurrencyQueue(ctx);
			}
			recomputeNodeState(ctx, nodeId);
		} else {
			ctx.tokens[liveTok.id] = baseUpdatedTok;
			recomputeNodeState(ctx, nodeId);
			const dispatchEffect: MissionEngineEffect = {
				kind: 'dispatch_token',
				missionId: state.missionId,
				nodeId,
				tokenId: baseUpdatedTok.id,
				holderAgentId: assignedAgentId,
				prompt: distillPrompt,
			};
			if (ctx.status === 'running') {
				ctx.effects.push(dispatchEffect);
			} else if (ctx.status === 'paused') {
				ctx.deferredEffects = ctx.deferredEffects.filter(
					eff => !(eff.kind === 'dispatch_token' && eff.tokenId === baseUpdatedTok.id),
				);
				ctx.deferredEffects.push(dispatchEffect);
			}
		}
	} else {
		appendTrace(ctx, {
			parentPtrs: refTok ? [refTok.tracePtr] : [],
			nodeId,
			employeeId: assignedAgentId,
			waveId: refTok?.waveId ?? 'distill',
			event: 'distill',
			summary: customMemo ? `Context distilled (idle): ${customMemo}` : 'Context distilled (idle)',
			timestamp: now,
		});
	}

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { distilledMemo, tokenId: liveTok?.id },
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
	const spent = computeMissionTotalCostUsd(state);
	if (typeof state.budgetLimitUsd === 'number' && state.budgetLimitUsd > 0 && spent >= state.budgetLimitUsd) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'BUDGET_EXCEEDED',
			error: `FinOps budget ceiling ($${state.budgetLimitUsd.toFixed(2)}) reached ($${spent.toFixed(2)} spent). Raise the budget limit before resuming.`,
		};
	}
	const ctx = cloneMutable(state, now);
	ctx.status = 'running';
	ctx.budgetCircuitTripped = false;
	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (tok.status === 'active') {
			ctx.tokens[tid] = { ...tok, lastActivityAt: now };
		}
	}
	if (ctx.deferredEffects.length > 0) {
		const limits = normalizeMissionConcurrencyLimits(ctx.concurrencyLimits);
		const deferredDispatchTokenIds = new Set(
			ctx.deferredEffects
				.filter((eff): eff is Extract<MissionEngineEffect, { kind: 'dispatch_token' }> => eff.kind === 'dispatch_token')
				.map(eff => eff.tokenId),
		);
		// Temporarily exclude deferred-dispatch tokens from occupancy so we admit them fairly up to limits!
		const usage = computeConcurrencySlotUsage({
			...ctx,
			tokens: Object.fromEntries(
				Object.entries(ctx.tokens).filter(([tid]) => !deferredDispatchTokenIds.has(tid)),
			),
		});
		for (const eff of ctx.deferredEffects) {
			if (eff.kind === 'dispatch_token') {
				const liveTok = ctx.tokens[eff.tokenId];
				if (!liveTok || liveTok.status !== 'active') {
					continue;
				}
				const decision = evaluateConcurrencySlot(ctx, usage, eff.nodeId, limits);
				if (decision.admitted) {
					recordActiveSlotOccupancy(ctx, usage, eff.nodeId, eff.tokenId);
					ctx.effects.push(eff);
				} else {
					ctx.tokens[liveTok.id] = {
						...liveTok,
						status: 'queued',
						queued: {
							position: 1,
							totalQueued: 1,
							blockedBy: decision.blockedBy,
							scopeKey: decision.scopeKey,
							activeSlots: decision.activeSlots,
							maxSlots: decision.maxSlots,
							enqueuedAt: now,
							pendingPrompt: eff.prompt,
							...(eff.isRejection ? { isRejection: true } : {}),
						},
					};
					recomputeNodeState(ctx, liveTok.nodeId, 'queued');
				}
				continue;
			}
			ctx.effects.push(eff);
		}
		ctx.deferredEffects = [];
	}
	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	checkMissionCompletion(ctx);
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
}

export function stopMissionRun(state: IMissionRuntimeState, now = Date.now()): IMissionEngineTransitionResult {
	const ctx = cloneMutable(state, now);
	// Preserve an already-completed Mission's outcome so subsequent re-runs archive it honestly as 'completed'.
	if (state.status !== 'completed') {
		ctx.status = 'stopped';
	}
	ctx.silenceTimeoutLocked = false;
	ctx.budgetCircuitTripped = false;
	if (ctx.startedAt !== undefined && ctx.completedAt === undefined) {
		ctx.completedAt = now;
	}
	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (tok.status === 'active' || tok.status === 'queued' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
			ctx.tokens[tid] = { ...tok, status: 'recalled', blocked: undefined, queued: undefined, lastActivityAt: now };
			if (tok.status === 'active' || tok.status === 'blocked') {
				ctx.effects.push({
					kind: 'stop_agent',
					missionId: state.missionId,
					nodeId: tok.nodeId,
					tokenId: tok.id,
					holderAgentId: resolveLiveTokenHolder(ctx.boundary, tok),
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

export interface IMissionRollbackCandidate {
	readonly id: string;
	readonly title: string;
	readonly isDirectPredecessor: boolean;
}

export function isValidUpstreamRollbackTarget(
	state: Pick<IMissionRuntimeState, 'traces'>,
	graph: Pick<IMissionDagParseResult, 'nodes' | 'edges'>,
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
 * Collects every executed upstream reachable rollback target for a Gate/node token,
 * ordered from earliest upstream ancestor to closest/direct predecessor (last element = default target).
 * Every returned candidate is guaranteed to pass `isValidUpstreamRollbackTarget` in `resolveMissionGate`.
 */
export function collectValidUpstreamRollbackCandidates(
	state: Pick<IMissionRuntimeState, 'traces'>,
	graph: Pick<IMissionDagParseResult, 'nodes' | 'edges'>,
	currentNodeId: string,
	tracePtr: string,
	preferredDefaultId?: string,
): readonly IMissionRollbackCandidate[] {
	const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
	const directPredecessors = new Set(graph.edges.filter(e => e.to === currentNodeId).map(e => e.from));
	const traceEntries = expandTracePointer(state, tracePtr);

	// Track latest trace index per unique valid executed upstream ancestor (chronological: earliest -> closest).
	const reachabilityCache = new Map<string, boolean>();
	const latestIndexByTaskId = new Map<string, number>();
	const latestIndexByAnyId = new Map<string, number>();
	for (let i = 0; i < traceEntries.length; i++) {
		const candidateId = traceEntries[i].nodeId;
		if (!candidateId || candidateId === currentNodeId) {
			continue;
		}
		const node = nodeById.get(candidateId);
		if (!node) {
			continue;
		}
		let canReachGate = reachabilityCache.get(candidateId);
		if (canReachGate === undefined) {
			canReachGate = collectReachableNodes(graph, [candidateId]).has(currentNodeId);
			reachabilityCache.set(candidateId, canReachGate);
		}
		if (!canReachGate) {
			continue;
		}
		latestIndexByAnyId.set(candidateId, i);
		if (node.kind !== 'gate') {
			latestIndexByTaskId.set(candidateId, i);
		}
	}

	const chosenIndexMap = latestIndexByTaskId.size > 0 ? latestIndexByTaskId : latestIndexByAnyId;
	let orderedIds = [...chosenIndexMap.entries()]
		.sort((a, b) => a[1] - b[1])
		.map(([id]) => id);

	// Place preferredDefaultId (typically token.fromNodeId) at the end so both Inbox and Canvas default to it.
	if (preferredDefaultId && orderedIds.includes(preferredDefaultId)) {
		orderedIds = [...orderedIds.filter(id => id !== preferredDefaultId), preferredDefaultId];
	}

	return orderedIds.map(id => {
		const node = nodeById.get(id);
		return {
			id,
			title: node?.label ?? id,
			isDirectPredecessor: directPredecessors.has(id),
		};
	});
}

export function formatCheckFailureDiagnostic(
	nodeId: string,
	tokenId: string,
	suite: IMissionNodeCheckSuiteResult,
	attempt: number,
	maxAutoRetries: number,
	action: 'bounced' | 'failed' | 'escalated',
): string {
	const failedChecks = suite.results.filter(r => !r.passed);
	const lines: string[] = [
		action === 'bounced'
			? `DETERMINISTIC_CHECK_FAILED (attempt ${attempt}/${maxAutoRetries} — token ${tokenId} remains ACTIVE on node ${nodeId}; zero LLM review tokens spent):`
			: `DETERMINISTIC_CHECK_FAILED (${action === 'escalated' ? 'escalated to supervisor' : 'auto-retries exhausted / failed'} on node ${nodeId}, token ${tokenId}):`,
	];
	for (const res of failedChecks) {
		const label = res.name ? `"${res.name}" (${res.checkId})` : res.checkId;
		const detail = res.error
			? res.error
			: `exit code ${res.exitCode} (expected ${res.expectedExitCode})`;
		lines.push(`- Check ${label} FAILED in ${res.durationMs}ms on ${res.hostAlias}: ${detail}${res.command ? ` | cmd: \`${res.command}\`` : ''}`);
		if (res.missingFiles && res.missingFiles.length > 0) {
			lines.push(`  Missing/empty files: ${res.missingFiles.join(', ')}`);
		}
		if (res.outputTail) {
			lines.push('  --- Output Tail ---', res.outputTail, '  -------------------');
		}
	}
	if (action === 'bounced') {
		lines.push(`Fix the failing check(s) in your workspace, re-verify, and submit \`aexus-ade token complete ${tokenId} --summary "..."\` again.`);
	}
	return lines.join('\n');
}

function updateNodeCheckTelemetry(
	ctx: IMutableEngineContext,
	nodeId: string,
	status: 'passed' | 'failed',
	summary: string,
	now: number,
	diagnosticText?: string,
): void {
	const prev = ctx.nodeTelemetry?.[nodeId];
	const contextWindowMax = prev?.contextWindowMax
		?? inferModelContextWindowTokens(prev?.model, { engineId: prev?.engineId });
	const addedNoise = status === 'failed' ? estimateNoiseDiagnosticTokens(diagnosticText || summary) : 0;
	const nextNoise = Math.min(contextWindowMax, (prev?.contextNoiseTokens ?? 0) + addedNoise);
	const nextEntry: IMissionNodeTelemetry = {
		inputTokens: prev?.inputTokens ?? 0,
		outputTokens: prev?.outputTokens ?? 0,
		cacheReadTokens: prev?.cacheReadTokens ?? 0,
		cacheWriteTokens: prev?.cacheWriteTokens ?? 0,
		totalTokens: prev?.totalTokens ?? 0,
		costUsd: prev?.costUsd ?? 0,
		...(prev?.costEstimated ? { costEstimated: true } : {}),
		...(prev?.costLocalFree ? { costLocalFree: true } : {}),
		...(prev?.estimatedCostUsd !== undefined ? { estimatedCostUsd: prev.estimatedCostUsd } : {}),
		...(prev?.pendingInterimEstimatedCostUsd !== undefined ? { pendingInterimEstimatedCostUsd: prev.pendingInterimEstimatedCostUsd } : {}),
		turns: prev?.turns ?? 0,
		contextWindowMax,
		contextInitTokens: prev?.contextInitTokens ?? 0,
		contextTierDocTokens: prev?.contextTierDocTokens ?? 0,
		contextSourceTokens: prev?.contextSourceTokens ?? 0,
		contextNoiseTokens: nextNoise,
		...(status === 'failed'
			? { pendingNoiseReason: 'check_failed' as const }
			: (prev?.pendingNoiseReason && prev.pendingNoiseReason !== 'check_failed' ? { pendingNoiseReason: prev.pendingNoiseReason } : {})),
		...(prev?.noiseTurns !== undefined ? { noiseTurns: prev.noiseTurns } : {}),
		...(prev?.model ? { model: prev.model } : {}),
		...(prev?.engineId ? { engineId: prev.engineId } : {}),
		...(prev?.summary ? { summary: prev.summary } : {}),
		lastCheckStatus: status,
		lastCheckSummary: summary,
		lastCheckAt: now,
		updatedAt: now,
	};
	ctx.nodeTelemetry = {
		...(ctx.nodeTelemetry ?? {}),
		[nodeId]: nextEntry,
	};
}

/**
 * Applies the outcome of zero-cost deterministic verification hook(s) executed before advancing a token:
 * - Passed: records a `check_passed` trace entry + telemetry badge so `completeMissionToken` can proceed.
 * - Failed (`bounce` with attempts remaining): keeps token `active` on the same node, increments
 *   `checkFailureCount`, records `lastCheckFailure`, and returns a crisp diagnostic (0 LLM reviewer cost!).
 * - Failed (`fail` or retries exhausted): delegates to `failMissionToken` (routes along `-->|fail|` if present,
 *   else freezes & escalates to direct off-graph supervisor / Human Inbox).
 * - Failed (`escalate`): freezes token and escalates directly to direct off-graph supervisor / Human Inbox.
 */
export function recordTokenCheckResult(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly tokenId: string;
		readonly suiteResult: IMissionNodeCheckSuiteResult;
		readonly onFail?: MissionCheckOnFailAction;
		readonly maxAutoRetries?: number;
		readonly callerAgentId?: string;
		readonly owner?: { readonly ownerSessionId?: string; readonly ownerTier?: number };
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{
	readonly action: 'passed' | 'bounced' | 'failed' | 'escalated';
	readonly attempt: number;
	readonly maxAutoRetries: number;
	readonly diagnostic?: string;
	readonly checkSuite: IMissionNodeCheckSuiteResult;
	readonly routedViaFailEdge?: boolean;
	readonly nextTokenIds?: readonly string[];
	readonly escalatedToSupervisorId?: string;
	readonly escalatedToInbox?: boolean;
}> {
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

	const now = params.now ?? Date.now();
	const onFail: MissionCheckOnFailAction = params.onFail ?? 'bounce';
	const maxAutoRetries = Math.max(0, Math.min(5, Math.floor(params.maxAutoRetries ?? 2)));
	const ctx = cloneMutable(state, now);

	const liveHolder = resolveLiveTokenHolder(ctx.boundary, token);

	if (params.suiteResult.passed) {
		const passPtr = appendTrace(ctx, {
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: liveHolder,
			waveId: token.waveId,
			event: 'check_passed',
			summary: params.suiteResult.summary,
			timestamp: now,
		});
		const wasCheckRework = token.reworkReason === 'check_failed' || (token.isRework && !token.reworkReason);
		ctx.tokens[token.id] = {
			...token,
			tracePtr: passPtr,
			checkFailureCount: 0,
			lastCheckFailure: undefined,
			...(wasCheckRework ? { isRework: undefined, reworkReason: undefined } : {}),
			lastActivityAt: now,
		};
		updateNodeCheckTelemetry(ctx, token.nodeId, 'passed', params.suiteResult.summary, now);
		const passedTel = ctx.nodeTelemetry?.[token.nodeId];
		if (passedTel && passedTel.pendingNoiseReason === 'check_failed') {
			ctx.nodeTelemetry = {
				...(ctx.nodeTelemetry ?? {}),
				[token.nodeId]: {
					...passedTel,
					pendingNoiseReason: undefined,
				},
			};
		}
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: [],
			data: {
				action: 'passed',
				attempt: token.checkFailureCount ?? 0,
				maxAutoRetries,
				checkSuite: params.suiteResult,
			},
		};
	}

	const nextAttempt = (token.checkFailureCount ?? 0) + 1;
	const canBounce = onFail === 'bounce' && nextAttempt <= maxAutoRetries;
	const actionKind: 'bounced' | 'failed' | 'escalated' = canBounce
		? 'bounced'
		: (onFail === 'escalate' ? 'escalated' : 'failed');
	const diagnostic = formatCheckFailureDiagnostic(
		token.nodeId,
		token.id,
		params.suiteResult,
		nextAttempt,
		maxAutoRetries,
		actionKind,
	);

	const failCheckPtr = appendTrace(ctx, {
		parentPtrs: [token.tracePtr],
		nodeId: token.nodeId,
		employeeId: liveHolder,
		waveId: token.waveId,
		event: 'check_failed',
		summary: trimCleanlyToBudget(params.suiteResult.summary, 280),
		timestamp: now,
	});
	updateNodeCheckTelemetry(ctx, token.nodeId, 'failed', params.suiteResult.summary, now, diagnostic);

	if (canBounce) {
		ctx.tokens[token.id] = {
			...token,
			tracePtr: failCheckPtr,
			isRework: true,
			reworkReason: 'check_failed',
			checkFailureCount: nextAttempt,
			lastCheckFailure: {
				summary: params.suiteResult.summary,
				failedAt: now,
				attempt: nextAttempt,
				maxAutoRetries,
			},
			lastActivityAt: now,
		};
		return {
			ok: false,
			state: freezeMutable(state.missionId, ctx),
			effects: [],
			code: 'CHECK_FAILED',
			error: diagnostic,
			data: {
				action: 'bounced',
				attempt: nextAttempt,
				maxAutoRetries,
				diagnostic,
				checkSuite: params.suiteResult,
			},
		};
	}

	if (onFail === 'escalate') {
		const directSup = findDirectSupervisorForNode(ctx.boundary, token.nodeId, params.owner);
		const escPtr = appendTrace(ctx, {
			parentPtrs: [failCheckPtr],
			nodeId: token.nodeId,
			employeeId: liveHolder,
			waveId: token.waveId,
			event: 'fail_escalate',
			summary: `Deterministic check failed & escalated: ${params.suiteResult.summary}`,
			timestamp: now,
		});
		ctx.nodeStates[token.nodeId] = 'failed';
		if (directSup) {
			ctx.tokens[token.id] = {
				...token,
				status: 'frozen_failed',
				blocked: undefined,
				tracePtr: escPtr,
				checkFailureCount: nextAttempt,
				lastCheckFailure: { summary: params.suiteResult.summary, failedAt: now, attempt: nextAttempt, maxAutoRetries },
				lastActivityAt: now,
				failure: {
					reason: diagnostic,
					failedAt: now,
					escalatedToSupervisorId: directSup.id,
					escalationHistory: [{ fromId: liveHolder ?? token.nodeId, toId: directSup.id, note: params.suiteResult.summary, at: now }],
				},
			};
			ctx.effects.push({
				kind: 'escalate_to_supervisor',
				missionId: state.missionId,
				supervisorId: directSup.id,
				nodeId: token.nodeId,
				tokenId: token.id,
				reason: diagnostic,
			});
			recomputeNodeState(ctx, token.nodeId, 'failed');
			drainMissionConcurrencyQueue(state.missionId, ctx, now);
			checkMissionCompletion(ctx);
			return {
				ok: false,
				state: freezeMutable(state.missionId, ctx),
				effects: ctx.effects,
				code: 'CHECK_FAILED',
				error: diagnostic,
				data: {
					action: 'escalated',
					attempt: nextAttempt,
					maxAutoRetries,
					diagnostic,
					checkSuite: params.suiteResult,
					escalatedToSupervisorId: directSup.id,
				},
			};
		}
		ctx.tokens[token.id] = {
			...token,
			status: 'frozen_failed',
			blocked: undefined,
			tracePtr: escPtr,
			checkFailureCount: nextAttempt,
			lastCheckFailure: { summary: params.suiteResult.summary, failedAt: now, attempt: nextAttempt, maxAutoRetries },
			lastActivityAt: now,
			failure: {
				reason: diagnostic,
				failedAt: now,
				escalatedToInbox: true,
				escalationHistory: [{ fromId: liveHolder ?? token.nodeId, toId: 'human-inbox', note: params.suiteResult.summary, at: now }],
			},
		};
		ctx.effects.push({
			kind: 'post_inbox',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			title: `Deterministic Check Failed on ${token.nodeId}`,
			message: diagnostic,
			severity: 'critical',
			senderAgentId: liveHolder,
		});
		recomputeNodeState(ctx, token.nodeId, 'failed');
		drainMissionConcurrencyQueue(state.missionId, ctx, now);
		checkMissionCompletion(ctx);
		return {
			ok: false,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			code: 'CHECK_FAILED',
			error: diagnostic,
			data: {
				action: 'escalated',
				attempt: nextAttempt,
				maxAutoRetries,
				diagnostic,
				checkSuite: params.suiteResult,
				escalatedToInbox: true,
			},
		};
	}

	// onFail === 'fail' OR bounce retries exhausted -> route via `failMissionToken` (`-->|fail|` edge or supervisor escalation)
	ctx.tokens[token.id] = {
		...token,
		tracePtr: failCheckPtr,
		checkFailureCount: nextAttempt,
		lastCheckFailure: { summary: params.suiteResult.summary, failedAt: now, attempt: nextAttempt, maxAutoRetries },
		lastActivityAt: now,
	};
	const preFailState = freezeMutable(state.missionId, ctx);
	const failRes = failMissionToken(preFailState, graph, {
		tokenId: token.id,
		reason: diagnostic,
		callerAgentId: params.callerAgentId,
		owner: params.owner,
		now,
	});
	return {
		ok: false,
		state: failRes.state,
		effects: failRes.effects,
		code: 'CHECK_FAILED',
		error: diagnostic,
		data: {
			action: failRes.data?.routedViaFailEdge ? 'failed' : 'escalated',
			attempt: nextAttempt,
			maxAutoRetries,
			diagnostic,
			checkSuite: params.suiteResult,
			routedViaFailEdge: failRes.data?.routedViaFailEdge,
			nextTokenIds: failRes.data?.nextTokenIds,
			escalatedToSupervisorId: failRes.data?.escalatedToSupervisorId,
			escalatedToInbox: failRes.data?.escalatedToInbox,
		},
	};
}

/**
 * In-graph employee completes current token with a plain human-readable summary.
 */
export function completeMissionToken(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: { readonly tokenId: string; readonly summary: string; readonly callerAgentId?: string; readonly verificationNote?: string; readonly now?: number },
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
	const rawSummary = params.summary.trim();
	if (!rawSummary) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A concrete plain-text summary is required to complete a token.' };
	}
	const verNote = params.verificationNote?.trim();
	const summary = verNote ? `${rawSummary}\n${verNote}` : rawSummary;

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[token.id] = { ...token, status: 'completed', blocked: undefined, lastCheckFailure: undefined, lastActivityAt: now };
	const prevNodeTel = ctx.nodeTelemetry?.[token.nodeId];
	if (prevNodeTel?.pendingNoiseReason) {
		ctx.nodeTelemetry = {
			...(ctx.nodeTelemetry ?? {}),
			[token.nodeId]: {
				...prevNodeTel,
				pendingNoiseReason: undefined,
				updatedAt: now,
			},
		};
	}
	recomputeNodeState(ctx, token.nodeId, 'completed');

	const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
	const donePtr = appendTrace(ctx, {
		parentPtrs: [token.tracePtr],
		nodeId: token.nodeId,
		employeeId: resolveLiveTokenHolder(ctx.boundary, token),
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
	// multi-hop fork-join, diamond, and nested rework waves all converge cleanly with zero sibling re-runs).
	if (token.returnToNodeId && graph.nodes.some(n => n.id === token.returnToNodeId)) {
		const returnTarget = token.returnToNodeId;
		const outerReturnFrame = token.returnStack && token.returnStack.length > 0
			? token.returnStack[token.returnStack.length - 1]
			: undefined;
		const remainingReturnStack = token.returnStack && token.returnStack.length > 1
			? token.returnStack.slice(0, -1)
			: undefined;
		const allSuccessors = getOutgoingEdges(graph, token.nodeId, 'success');
		const onPathSuccessors = allSuccessors
			.filter(e => e.to === returnTarget || collectReachableNodes(graph, [e.to]).has(returnTarget));
		const onPathIds = new Set(onPathSuccessors.map(e => e.to));
		for (const offEdge of allSuccessors) {
			if (!onPathIds.has(offEdge.to)) {
				markBranchSkipped(state.missionId, ctx, graph, token.waveId, token.nodeId, offEdge.to, now);
			}
		}
		if (onPathSuccessors.length > 0) {
			for (const edge of onPathSuccessors) {
				const reachingReturnTarget = edge.to === returnTarget;
				const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
					targetNodeId: edge.to,
					fromNodeId: token.nodeId,
					waveId: token.waveId,
					lastSummary: summary,
					compressedHistory: rolledHistory.text,
					historyState: rolledHistory.state,
					tracePtr: donePtr,
					now,
					returnToNodeId: reachingReturnTarget ? outerReturnFrame?.nodeId : returnTarget,
					returnWaveId: reachingReturnTarget ? outerReturnFrame?.waveId : token.returnWaveId,
					returnStack: reachingReturnTarget ? remainingReturnStack : token.returnStack,
					restoreWaveId: reachingReturnTarget ? token.returnWaveId : undefined,
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
				waveId: token.returnWaveId ?? token.waveId,
				lastSummary: summary,
				compressedHistory: rolledHistory.text,
				historyState: rolledHistory.state,
				tracePtr: donePtr,
				now,
				bypassJoin: true,
				returnToNodeId: outerReturnFrame?.nodeId,
				returnWaveId: outerReturnFrame?.waveId,
				returnStack: remainingReturnStack,
			});
			if (delivered) {
				nextTokenIds.push(delivered.id);
			}
		}
		drainMissionConcurrencyQueue(state.missionId, ctx, now);
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
			compressedHistory: rolledHistory.text,
			historyState: rolledHistory.state,
			tracePtr: donePtr,
			now,
		});
		if (delivered) {
			nextTokenIds.push(delivered.id);
		}
	}

	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	checkMissionCompletion(ctx);
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { nextTokenIds },
	};
}

export const DEFAULT_MAX_MISSION_REJECT_BOUNCES_PER_EDGE = 64;

/**
 * In-graph Reviewer rejects upstream deliverable and routes token back to previous step
 * without adding any backward arrow to the static Mermaid DAG.
 */
export function rejectMissionToken(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly tokenId: string;
		readonly reason: string;
		readonly targetNodeId?: string;
		readonly callerAgentId?: string;
		readonly maxRejectBouncesPerEdge?: number;
		readonly now?: number;
	},
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
	const bounceLimit = params.maxRejectBouncesPerEdge !== undefined && Number.isFinite(params.maxRejectBouncesPerEdge) && params.maxRejectBouncesPerEdge >= 1
		? Math.floor(params.maxRejectBouncesPerEdge)
		: DEFAULT_MAX_MISSION_REJECT_BOUNCES_PER_EDGE;
	const rejectPrefix = `Rejected -> ${targetNodeId}:`;
	let priorEdgeBounces = 0;
	for (const trace of Object.values(state.traces)) {
		if (trace.event === 'reject' && trace.nodeId === token.nodeId && (trace.summary ?? '').startsWith(rejectPrefix)) {
			priorEdgeBounces += 1;
		}
	}
	if (priorEdgeBounces >= bounceLimit) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `MAX_REJECT_BOUNCES_EXCEEDED: rejection edge "${token.nodeId} -> ${targetNodeId}" reached ${priorEdgeBounces} bounces (ceiling: ${bounceLimit}). Intervene manually or escalate via token fail.`,
		};
	}

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[token.id] = { ...token, status: 'completed', blocked: undefined, lastActivityAt: now };
	recomputeNodeState(ctx, token.nodeId, 'idle');

	ctx.waveSeq += 1;
	const reworkWaveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[reworkWaveId] = [targetNodeId];

	const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
	const rejPtr = appendTrace(ctx, {
		parentPtrs: [token.tracePtr],
		nodeId: token.nodeId,
		employeeId: resolveLiveTokenHolder(ctx.boundary, token),
		waveId: reworkWaveId,
		event: 'reject',
		summary: `Rejected -> ${targetNodeId}: ${reason}`,
		timestamp: now,
	});
	const nextReturnStack: readonly IMissionReturnFrame[] | undefined = token.returnToNodeId
		? [...(token.returnStack ?? []), { nodeId: token.returnToNodeId, waveId: token.returnWaveId }]
		: token.returnStack;

	const bounced = deliverTokenToTarget(state.missionId, ctx, graph, {
		targetNodeId,
		fromNodeId: token.nodeId,
		waveId: reworkWaveId,
		lastSummary: `[Rejected by ${token.nodeId}] ${reason}`,
		compressedHistory: rolledHistory.text,
		historyState: rolledHistory.state,
		tracePtr: rejPtr,
		now,
		isRejection: true,
		bypassJoin: true,
		returnToNodeId: token.nodeId,
		returnWaveId: token.waveId,
		returnStack: nextReturnStack,
	})!;
	drainMissionConcurrencyQueue(state.missionId, ctx, now);

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
		readonly initialFileMtime?: number | null;
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
	if (!Number.isFinite(params.maxDurationMs) || params.maxDurationMs <= 0) {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'A positive finite maxDurationMs is required to block a token.' };
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
			...(params.initialFileMtime !== undefined ? { initialFileMtime: params.initialFileMtime } : {}),
			...(params.hostAlias?.trim() ? { hostAlias: params.hostAlias.trim() } : {}),
		},
	};
	recomputeNodeState(ctx, token.nodeId, 'blocked');
	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
}

/**
 * Transitions a `blocked` token back to `active` upon early condition match (PID exit / file ready)
 * or max duration expiration, or emits a silence nudge for a silent `active` token.
 */
export function recordWatchdogWakeup(
	state: IMissionRuntimeState,
	params: {
		readonly tokenId: string;
		readonly reason: 'silence_timeout' | 'block_expired' | 'pid_exited' | 'file_ready' | 'agent_exited';
		readonly detail?: string;
		readonly graph?: IMissionDagParseResult;
		readonly owner?: { readonly ownerSessionId?: string; readonly ownerTier?: number };
		readonly maxSilenceNudges?: number;
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

	if (params.reason === 'silence_timeout' || params.reason === 'agent_exited') {
		if (token.status !== 'active') {
			return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Token is not active.' };
		}
		const maxNudges = Math.max(1, Math.floor(params.maxSilenceNudges ?? MAX_SILENCE_NUDGES_BEFORE_ESCALATE));
		const nextNudgeCount = token.nudgeCount + 1;
		if (nextNudgeCount > maxNudges && params.graph) {
			return failMissionToken(state, params.graph, {
				tokenId: token.id,
				reason: params.reason === 'agent_exited'
					? `Node ${token.nodeId} remote agent exited repeatedly without closing token (${params.detail || 'session exited'}); auto-escalating.`
					: `Node ${token.nodeId} remained silent after ${token.nudgeCount} watchdog reminder(s) (${state.silenceTimeoutMinutes}m interval); auto-escalating stall.`,
				owner: params.owner,
				now,
			});
		}
		ctx.tokens[token.id] = {
			...token,
			lastNudgeAt: now,
			nudgeCount: nextNudgeCount,
			isRework: true,
			reworkReason: token.reworkReason ?? 'watchdog_nudge',
		};
		markNodeReworkNoise(ctx, token.nodeId, 'watchdog_nudge', params.detail || `Watchdog ${params.reason} reminder #${nextNudgeCount}`, now);
		const nudgeEnvelope = buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: token.nodeId,
			sourceDescription: params.reason === 'agent_exited'
				? `Mission Watchdog Fast Recovery #${nextNudgeCount}/${maxNudges}`
				: `Mission Watchdog Reminder #${nextNudgeCount}/${maxNudges}`,
			isReminder: true,
		});
		ctx.effects.push({
			kind: 'wakeup_agent',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			holderAgentId: resolveLiveTokenHolder(ctx.boundary, token),
			wakeupReason: params.reason,
			message: [
				...nudgeEnvelope,
				params.reason === 'agent_exited'
					? `[Mission Watchdog Fast Recovery #${nextNudgeCount}/${maxNudges}] Your remote persistent process for active token \`${token.id}\` on node \`${token.nodeId}\` exited without closing the token (${params.detail || 'remote session terminated'}). Inspect your workspace, preserve completed progress, and either finish and call \`aexus-ade token complete ${token.id} --summary "..."\`, block via \`token block\`, or report failure via \`token fail\`.`
					: `[Mission Watchdog Reminder #${nextNudgeCount}/${maxNudges}] You hold active token \`${token.id}\` on node \`${token.nodeId}\` with no activity for ${state.silenceTimeoutMinutes}m. If finished, submit \`aexus-ade token complete ${token.id} --summary "..."\`. If running a long command, call \`aexus-ade token block ${token.id} --duration ... --reason "..."\`. If stuck, call \`aexus-ade token fail ${token.id} --reason "..."\`.`,
			].join('\n'),
		});
		return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
	}

	if (token.status !== 'blocked') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: 'Token is not blocked.' };
	}
	const hadWatchPid = token.blocked?.watchPid !== undefined;
	const reasonLabel = params.reason === 'pid_exited'
		? `Watched PID exited${params.detail ? ` (${params.detail})` : ''}`
		: params.reason === 'file_ready'
			? `Watched output file appeared${params.detail ? ` (${params.detail})` : ''}`
			: 'Blocked maximum wait duration elapsed';
	const wakeupMessage = [
		...buildTokenSystemEnvelopeLines({
			tokenId: token.id,
			nodeId: token.nodeId,
			sourceDescription: `Mission Watchdog Wakeup (${params.reason})`,
			isReminder: true,
		}),
		`[Mission Watchdog Wakeup] ${reasonLabel} for token \`${token.id}\` on node \`${token.nodeId}\`. Inspect the results and proceed (or call \`token complete\`, \`token block\`, or \`token fail\`). Routine ${state.silenceTimeoutMinutes}m supervision has resumed.`,
	].join('\n');

	// Exclude this token's own blocked record before evaluating concurrency admission (both host & employee exclusivity).
	ctx.tokens[token.id] = {
		...token,
		status: 'blocked',
		blocked: undefined,
	};
	const limits = normalizeMissionConcurrencyLimits(ctx.concurrencyLimits);
	const usage = computeConcurrencySlotUsage(ctx, token.id);
	const decision = ctx.status === 'running'
		? evaluateConcurrencySlot(ctx, usage, token.nodeId, limits)
		: { admitted: true as const };

	if (!decision.admitted) {
		ctx.tokens[token.id] = {
			...token,
			status: 'queued',
			blocked: undefined,
			lastActivityAt: now,
			lastNudgeAt: now,
			queued: {
				position: 0,
				totalQueued: 0,
				blockedBy: decision.blockedBy,
				scopeKey: decision.scopeKey,
				activeSlots: decision.activeSlots,
				maxSlots: decision.maxSlots,
				enqueuedAt: now,
				pendingPrompt: wakeupMessage,
			},
		};
		if (hadWatchPid) {
			drainMissionConcurrencyQueue(state.missionId, ctx, now);
		} else {
			renumberMissionConcurrencyQueue(ctx);
		}
		recomputeNodeState(ctx, token.nodeId);
		return { ok: true, state: freezeMutable(state.missionId, ctx), effects: ctx.effects };
	}

	const liveHolder = resolveLiveTokenHolder(ctx.boundary, token);
	ctx.tokens[token.id] = {
		...token,
		status: 'active',
		holderAgentId: liveHolder,
		blocked: undefined,
		queued: undefined,
		lastActivityAt: now,
		lastNudgeAt: now,
	};
	recomputeNodeState(ctx, token.nodeId, 'active');
	ctx.effects.push({
		kind: 'wakeup_agent',
		missionId: state.missionId,
		nodeId: token.nodeId,
		tokenId: token.id,
		holderAgentId: liveHolder,
		wakeupReason: params.reason,
		message: wakeupMessage,
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

	const liveHolder = resolveLiveTokenHolder(ctx.boundary, token);
	const failEdges = getOutgoingEdges(graph, token.nodeId, 'fail');
	if (failEdges.length > 0) {
		ctx.tokens[token.id] = { ...token, status: 'completed', blocked: undefined, lastActivityAt: now };
		recomputeNodeState(ctx, token.nodeId, 'failed');

		const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
		const failPtr = appendTrace(ctx, {
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: liveHolder,
			waveId: token.waveId,
			event: 'fail_route',
			summary: `Failed -> fallback edge(s): ${reason}`,
			timestamp: now,
		});

		// Mark untaken success edges skipped so downstream joins don't deadlock!
		for (const succEdge of getOutgoingEdges(graph, token.nodeId, 'success')) {
			markBranchSkipped(state.missionId, ctx, graph, token.waveId, token.nodeId, succEdge.to, now);
		}

		const outerReturnFrame = token.returnStack && token.returnStack.length > 0
			? token.returnStack[token.returnStack.length - 1]
			: undefined;
		const remainingReturnStack = token.returnStack && token.returnStack.length > 1
			? token.returnStack.slice(0, -1)
			: undefined;
		const nextTokenIds: string[] = [];
		for (const fEdge of failEdges) {
			const reachingReturnTarget = Boolean(token.returnToNodeId && fEdge.to === token.returnToNodeId);
			const nextReturnTo = reachingReturnTarget ? outerReturnFrame?.nodeId : token.returnToNodeId;
			const nextReturnWave = reachingReturnTarget ? outerReturnFrame?.waveId : token.returnWaveId;
			const nextReturnStack = reachingReturnTarget ? remainingReturnStack : token.returnStack;
			const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
				targetNodeId: fEdge.to,
				fromNodeId: token.nodeId,
				waveId: token.waveId,
				lastSummary: `[Fallback after ${token.nodeId} failed] ${reason}`,
				compressedHistory: rolledHistory.text,
				historyState: rolledHistory.state,
				tracePtr: failPtr,
				now,
				...(nextReturnTo ? { returnToNodeId: nextReturnTo } : {}),
				...(nextReturnWave ? { returnWaveId: nextReturnWave } : {}),
				...(nextReturnStack && nextReturnStack.length > 0 ? { returnStack: nextReturnStack } : {}),
				...(reachingReturnTarget && token.returnWaveId ? { restoreWaveId: token.returnWaveId } : {}),
			});
			if (delivered) {
				nextTokenIds.push(delivered.id);
			}
		}
		drainMissionConcurrencyQueue(state.missionId, ctx, now);
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
		employeeId: liveHolder,
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
				escalationHistory: [{ fromId: liveHolder ?? token.nodeId, toId: directSup.id, note: reason, at: now }],
			},
		};
		recomputeNodeState(ctx, token.nodeId, 'failed');
		ctx.effects.push({
			kind: 'escalate_to_supervisor',
			missionId: state.missionId,
			supervisorId: directSup.id,
			nodeId: token.nodeId,
			tokenId: token.id,
			reason,
		});
		drainMissionConcurrencyQueue(state.missionId, ctx, now);
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
			escalationHistory: [{ fromId: liveHolder ?? token.nodeId, toId: 'human-inbox', note: reason, at: now }],
		},
	};
	recomputeNodeState(ctx, token.nodeId, 'failed');
	ctx.effects.push({
		kind: 'post_inbox',
		missionId: state.missionId,
		nodeId: token.nodeId,
		tokenId: token.id,
		title: `Mission Failure on ${token.nodeId}`,
		message: `Node \`${token.nodeId}\` (token \`${token.id}\`) failed with no fallback edge:\n${reason}`,
		severity: 'critical',
		senderAgentId: liveHolder,
	});
	drainMissionConcurrencyQueue(state.missionId, ctx, now);
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { routedViaFailEdge: false, nextTokenIds: [], escalatedToInbox: true },
	};
}

/**
 * Off-graph supervisor (or Human / Secretary) retries a `frozen_failed` (or `recalled`) node in-place,
 * preserving its original `waveId`, `joinBarriers`, and `returnToNodeId`/`returnWaveId` so parallel joins
 * complete cleanly once the retried node succeeds.
 */
export function retryMissionToken(
	state: IMissionRuntimeState,
	graph: IMissionDagParseResult,
	params: {
		readonly caller: IMissionEngineCaller;
		readonly tokenId?: string;
		readonly nodeId?: string;
		readonly guidance?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly retriedTokenId: string; readonly previousTokenId: string; readonly nodeId: string; readonly waveId: string }> {
	if (state.status !== 'running' && state.status !== 'paused') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
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
			error: 'Only off-graph supervisors, L0 Secretary, or Human User may retry failed Mission tokens.',
		};
	}

	const explicitToken = params.tokenId ? state.tokens[params.tokenId] : undefined;
	const targetNodeId = explicitToken?.nodeId ?? params.nodeId?.trim();
	if (!targetNodeId || !graph.nodes.some(n => n.id === targetNodeId)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NOT_FOUND',
			error: params.tokenId
				? `Token "${params.tokenId}" not found in Mission "${state.missionId}".`
				: `Node "${params.nodeId ?? ''}" not found in Mission "${state.missionId}".`,
		};
	}

	const jurisdiction = resolveSupervisorJurisdiction(
		state.boundary,
		params.caller.sessionId ?? '',
		graph.nodes.map(n => n.id),
		{ isHumanUser: params.caller.isHumanUser, isSecretary: params.caller.isSecretary, ownerSessionId: params.caller.ownerSessionId },
	);
	if (!jurisdiction.hasFullJurisdiction && !jurisdiction.nodeIds.has(targetNodeId)) {
		const parentSup = params.caller.sessionId ? findParentSupervisorForEscalation(state.boundary, params.caller.sessionId) : undefined;
		return {
			ok: false,
			state,
			effects: [],
			code: 'OUT_OF_JURISDICTION',
			outOfScopeNodeIds: [targetNodeId],
			parentSupervisorId: parentSup?.id,
			error: `Node "${targetNodeId}" is outside your jurisdiction. Escalate to ${parentSup ? `supervisor "${parentSup.id}"` : 'higher authority'}.`,
		};
	}

	const isJoinArrivalToken = (tok: IMissionToken): boolean => {
		if (tok.isJoinArrival === true) {
			return true;
		}
		if (tok.returnToNodeId) {
			return false;
		}
		const traceNode = state.traces[tok.tracePtr];
		const incomingSuccessCount = graph.edges.filter(e => e.to === tok.nodeId && getMissionEdgeKind(e) === 'success').length;
		return incomingSuccessCount > 1 && Boolean(tok.fromNodeId) && Boolean(traceNode && traceNode.nodeId !== tok.nodeId);
	};

	if (explicitToken && isJoinArrivalToken(explicitToken)) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `Cannot retry partial join arrival token "${explicitToken.id}" on node "${targetNodeId}". Retry the upstream branch or the released join token instead.`,
		};
	}

	const candidate = explicitToken ?? Object.values(state.tokens)
		.filter(t => t.nodeId === targetNodeId && (t.status === 'frozen_failed' || t.status === 'recalled') && !isJoinArrivalToken(t))
		.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
	if (!candidate || (candidate.status !== 'frozen_failed' && candidate.status !== 'recalled')) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `No frozen_failed or recalled token found on node "${targetNodeId}" to retry.`,
		};
	}
	const hasLiveOnNode = Object.values(state.tokens).some(t =>
		t.id !== candidate.id
		&& t.nodeId === targetNodeId
		&& (t.status === 'active' || t.status === 'queued' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join'),
	);
	if (hasLiveOnNode) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'INVALID_STATE',
			error: `Node "${targetNodeId}" already has an active token in flight.`,
		};
	}

	// Guard against retrying a recalled branch after its downstream join barrier already released for that wave,
	// which would otherwise mint an orphan barrier waiting forever for already-completed sibling branches.
	if (candidate.status === 'recalled' && !candidate.returnToNodeId) {
		const impactedJoins = collectImpactedDownstreamJoins(graph, new Set([targetNodeId]));
		for (const joinNodeId of impactedJoins) {
			const barrierKey = `${candidate.waveId}::${joinNodeId}`;
			if (!state.joinBarriers[barrierKey]) {
				const joinAlreadyReleased = Object.values(state.tokens).some(t =>
					t.nodeId === joinNodeId
					&& t.waveId === candidate.waveId
					&& !isJoinArrivalToken(t)
					&& t.status !== 'waiting_join'
					&& t.status !== 'recalled',
				);
				if (joinAlreadyReleased) {
					return {
						ok: false,
						state,
						effects: [],
						code: 'INVALID_STATE',
						error: `Cannot retry recalled node "${targetNodeId}" because downstream join "${joinNodeId}" already released for wave "${candidate.waveId}". Retry "${joinNodeId}" or start a new wave instead.`,
					};
				}
			}
		}
	}

	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[candidate.id] = { ...candidate, status: 'recalled', blocked: undefined, lastActivityAt: now };

	// If this node was previously recalled (marking its downstream join branch skipped), re-arm open join barriers for this wave.
	for (const outEdge of getOutgoingEdges(graph, targetNodeId)) {
		clearBranchSkipped(ctx, graph, candidate.waveId, targetNodeId, outEdge.to);
	}

	const guidance = params.guidance?.trim();
	const nextSummary = guidance
		? `[Supervisor Retry Guidance] ${guidance}\n\n${candidate.lastSummary}`
		: candidate.lastSummary;
	const retryPtr = appendTrace(ctx, {
		parentPtrs: [candidate.tracePtr],
		nodeId: targetNodeId,
		employeeId: ctx.boundary.nodeAssignments[targetNodeId]?.agentId,
		waveId: candidate.waveId,
		event: 'retry',
		summary: guidance ? `Retried by off-graph supervisor: ${guidance}` : 'Retried by off-graph supervisor',
		timestamp: now,
	});
	const retried = materializeAndDispatchToken(state.missionId, ctx, graph, {
		targetNodeId,
		fromNodeId: candidate.fromNodeId,
		waveId: candidate.waveId,
		lastSummary: nextSummary,
		compressedHistory: candidate.compressedHistory,
		historyState: candidate.historyState,
		tracePtr: retryPtr,
		now,
		reworkReason: 'retry',
		returnToNodeId: candidate.returnToNodeId,
		returnWaveId: candidate.returnWaveId,
		returnStack: candidate.returnStack,
	});

	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: {
			retriedTokenId: retried.id,
			previousTokenId: candidate.id,
			nodeId: targetNodeId,
			waveId: candidate.waveId,
		},
	};
}


export * from './adeMissionGovernanceAndTriggers.js';
