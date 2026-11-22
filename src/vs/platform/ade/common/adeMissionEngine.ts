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
	IMissionNodeCheckSuiteResult,
	MissionCheckOnFailAction,
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
	readonly event: 'mint' | 'complete' | 'reject' | 'fail_route' | 'fail_escalate' | 'retry' | 'join' | 'gate_approve' | 'gate_reject' | 'recall' | 'trigger' | 'check_passed' | 'check_failed' | 'distill';
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
}

export interface IMissionFinOpsNodeSpend {
	readonly nodeId: string;
	readonly label: string;
	readonly costUsd: number;
	readonly tokens: number;
	readonly turns: number;
	readonly hostAlias: string;
	readonly tier: number;
}

export interface IMissionFinOpsSummary {
	readonly totalTokens: number;
	readonly totalInputTokens: number;
	readonly totalOutputTokens: number;
	readonly totalCacheReadTokens: number;
	readonly totalCostUsd: number;
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
	/** Marks a single-branch arrival token parked inside a multi-inDegree join barrier (must not be retried standalone as a released join execution). */
	readonly isJoinArrival?: boolean;
	readonly arrivedAt: number;
	readonly lastActivityAt: number;
	readonly lastNudgeAt?: number;
	readonly nudgeCount: number;
	/** Number of consecutive zero-cost deterministic check failures recorded on this active token. */
	readonly checkFailureCount?: number;
	/** Most recent deterministic verification failure details (surfaced in nudges & UI). */
	readonly lastCheckFailure?: IMissionTokenCheckFailureInfo;
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
	readonly restoreWaveId?: string;
}

export const DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS = 200_000;
export const MAX_SILENCE_NUDGES_BEFORE_ESCALATE = 3;

export function inferModelContextWindowTokens(model?: string): number {
	const m = (model ?? '').trim().toLowerCase();
	if (!m) {
		return DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS;
	}
	if (m.includes('[1m]') || m.includes('-1m') || m.includes('gemini-')) {
		return 1_000_000;
	}
	return DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS;
}

export interface IMissionNodeTelemetry {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly costUsd: number;
	readonly turns: number;
	readonly contextWindowMax: number;
	/** Gray segment: minimal system/role initialization context. */
	readonly contextInitTokens: number;
	/** Sky-blue segment: tier/mission contract context. */
	readonly contextTierDocTokens: number;
	/** Emerald segment: workspace files & active working context. */
	readonly contextSourceTokens: number;
	/** Crimson segment: compile errors / retries / rework noise. */
	readonly contextNoiseTokens: number;
	readonly model?: string;
	readonly summary?: string;
	readonly lastCheckStatus?: 'passed' | 'failed';
	readonly lastCheckSummary?: string;
	readonly lastCheckAt?: number;
	readonly updatedAt?: number;
}

export interface IMissionTurnUsageInput {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
	readonly turns?: number;
	readonly model?: string;
	readonly summary?: string;
	readonly contextWindowMax?: number;
	/** Measured system/role initialization context tokens (gray segment of 4-color bar). */
	readonly contextInitTokens?: number;
	/** Measured tier/mission contract & pre-prompt context tokens (blue segment of 4-color bar). */
	readonly contextTierDocTokens?: number;
	readonly isNoiseTurn?: boolean;
	readonly timestamp?: number;
}

export interface IMissionNodeContextBreakdown {
	readonly usedTokens: number;
	readonly maxTokens: number;
	readonly usedPct: number;
	readonly initPct: number;
	readonly tierPct: number;
	readonly sourcePct: number;
	readonly noisePct: number;
	readonly severity: 'normal' | 'warn' | 'critical';
}

export function formatCompactTokenCount(tokens: number): string {
	const safe = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
	if (safe >= 1_000_000) {
		return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M`;
	}
	if (safe >= 1_000) {
		return `${Math.round(safe / 1_000)}k`;
	}
	return String(safe);
}

export function computeMissionNodeContextBreakdown(telemetry: IMissionNodeTelemetry | undefined): IMissionNodeContextBreakdown {
	const maxTokens = Math.max(1, telemetry?.contextWindowMax || DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS);
	if (!telemetry) {
		return {
			usedTokens: 0,
			maxTokens,
			usedPct: 0,
			initPct: 0,
			tierPct: 0,
			sourcePct: 0,
			noisePct: 0,
			severity: 'normal',
		};
	}
	const segmentedSum = Math.max(0, telemetry.contextInitTokens)
		+ Math.max(0, telemetry.contextTierDocTokens)
		+ Math.max(0, telemetry.contextSourceTokens)
		+ Math.max(0, telemetry.contextNoiseTokens);
	const fallbackUsed = Math.max(0, telemetry.inputTokens + telemetry.cacheReadTokens + telemetry.outputTokens);
	const usedTokens = segmentedSum > 0 ? segmentedSum : Math.min(maxTokens, fallbackUsed);
	const initTokens = segmentedSum > 0 ? Math.max(0, telemetry.contextInitTokens) : Math.round(usedTokens * 0.12);
	const tierTokens = segmentedSum > 0 ? Math.max(0, telemetry.contextTierDocTokens) : Math.round(usedTokens * 0.22);
	const noiseTokens = segmentedSum > 0 ? Math.max(0, telemetry.contextNoiseTokens) : 0;
	const sourceTokens = segmentedSum > 0
		? Math.max(0, telemetry.contextSourceTokens)
		: Math.max(0, usedTokens - initTokens - tierTokens - noiseTokens);

	const usedPct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
	const toPct = (v: number) => Math.max(0, Math.min(100, (v / maxTokens) * 100));
	const initPct = toPct(initTokens);
	const tierPct = toPct(tierTokens);
	const sourcePct = toPct(sourceTokens);
	const noisePct = toPct(noiseTokens);
	const severity: 'normal' | 'warn' | 'critical' = usedPct >= 80 ? 'critical' : usedPct >= 60 ? 'warn' : 'normal';
	return {
		usedTokens,
		maxTokens,
		usedPct,
		initPct,
		tierPct,
		sourcePct,
		noisePct,
		severity,
	};
}

export function recordMissionNodeTurnUsage(
	state: IMissionRuntimeState,
	nodeId: string,
	usage: IMissionTurnUsageInput,
): IMissionRuntimeState {
	const prev = state.nodeTelemetry?.[nodeId];
	const now = usage.timestamp ?? Date.now();
	const addInput = Math.max(0, Math.round(usage.inputTokens ?? 0));
	const addOutput = Math.max(0, Math.round(usage.outputTokens ?? 0));
	const addCacheRead = Math.max(0, Math.round(usage.cacheReadTokens ?? 0));
	const addCacheWrite = Math.max(0, Math.round(usage.cacheWriteTokens ?? 0));
	const addTotal = Math.max(0, Math.round(usage.totalTokens ?? (addInput + addOutput + addCacheRead + addCacheWrite)));
	const addCost = Math.max(0, Number.isFinite(usage.costUsd ?? 0) ? (usage.costUsd ?? 0) : 0);
	const addTurns = Math.max(0, Math.round(usage.turns ?? 1));
	const effectiveModel = usage.model?.trim() || prev?.model;
	const inferredMax = inferModelContextWindowTokens(effectiveModel);
	const contextWindowMax = Math.max(8_192, Math.round(
		usage.contextWindowMax
		?? (prev?.contextWindowMax && prev.contextWindowMax !== DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS ? prev.contextWindowMax : inferredMax),
	));

	// Track actual measured init/tier segments when supplied, and track real working context growth
	// (`input + output + cacheWrite`) without double-counting newly attributed init/tier tokens or cumulative cache reads.
	const prevInit = prev?.contextInitTokens ?? 0;
	const prevTier = prev?.contextTierDocTokens ?? 0;
	const nextInit = usage.contextInitTokens !== undefined
		? Math.max(prevInit, Math.max(0, Math.round(usage.contextInitTokens)))
		: prevInit;
	const nextTier = usage.contextTierDocTokens !== undefined
		? Math.max(prevTier, Math.max(0, Math.round(usage.contextTierDocTokens)))
		: prevTier;
	const initGrowth = nextInit - prevInit;
	const tierGrowth = nextTier - prevTier;
	const prevSource = prev?.contextSourceTokens ?? 0;
	const prevNoise = prev?.contextNoiseTokens ?? 0;
	const netNewTokens = addInput + addOutput + addCacheWrite;
	const rawActiveDelta = netNewTokens > 0
		? netNewTokens
		: (addCacheRead > 0 && prevSource === 0 ? Math.min(Math.round(contextWindowMax * 0.25), addCacheRead) : 0);
	const activeDelta = Math.max(0, rawActiveDelta - initGrowth - tierGrowth);
	const nextNoise = usage.isNoiseTurn ? Math.min(contextWindowMax, prevNoise + activeDelta) : prevNoise;
	const nextSource = usage.isNoiseTurn ? prevSource : Math.min(Math.max(0, contextWindowMax - nextInit - nextTier - nextNoise), prevSource + activeDelta);

	const nextEntry: IMissionNodeTelemetry = {
		inputTokens: (prev?.inputTokens ?? 0) + addInput,
		outputTokens: (prev?.outputTokens ?? 0) + addOutput,
		cacheReadTokens: (prev?.cacheReadTokens ?? 0) + addCacheRead,
		cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + addCacheWrite,
		totalTokens: (prev?.totalTokens ?? 0) + addTotal,
		costUsd: Math.round(((prev?.costUsd ?? 0) + addCost) * 10_000) / 10_000,
		turns: (prev?.turns ?? 0) + addTurns,
		contextWindowMax,
		contextInitTokens: nextInit,
		contextTierDocTokens: nextTier,
		contextSourceTokens: nextSource,
		contextNoiseTokens: nextNoise,
		model: usage.model?.trim() || prev?.model,
		summary: usage.summary?.trim() || prev?.summary,
		...(prev?.lastCheckStatus ? { lastCheckStatus: prev.lastCheckStatus } : {}),
		...(prev?.lastCheckSummary ? { lastCheckSummary: prev.lastCheckSummary } : {}),
		...(prev?.lastCheckAt !== undefined ? { lastCheckAt: prev.lastCheckAt } : {}),
		updatedAt: now,
	};
	const nextTelemetryMap: Record<string, IMissionNodeTelemetry> = {
		...(state.nodeTelemetry ?? {}),
		[nodeId]: nextEntry,
	};
	let totalCostUsd = 0;
	for (const entry of Object.values(nextTelemetryMap)) {
		totalCostUsd += Math.max(0, Number.isFinite(entry.costUsd) ? entry.costUsd : 0);
	}
	totalCostUsd = Math.round(totalCostUsd * 10_000) / 10_000;
	const hasLimit = typeof state.budgetLimitUsd === 'number' && Number.isFinite(state.budgetLimitUsd) && state.budgetLimitUsd > 0;
	const shouldTripBudget = hasLimit && totalCostUsd >= state.budgetLimitUsd! && state.status === 'running';
	return {
		...state,
		...(shouldTripBudget ? { status: 'paused' as const, budgetCircuitTripped: true, budgetTrippedAt: now } : {}),
		nodeTelemetry: nextTelemetryMap,
		updatedAt: now,
	};
}

export function computeMissionTotalCostUsd(state: IMissionRuntimeState): number {
	let sum = 0;
	for (const entry of Object.values(state.nodeTelemetry ?? {})) {
		sum += Math.max(0, Number.isFinite(entry.costUsd) ? entry.costUsd : 0);
	}
	return Math.round(sum * 10_000) / 10_000;
}

export function computeMissionFinOpsSummary(
	state: IMissionRuntimeState | undefined,
	nodes: readonly { readonly id: string; readonly label: string }[],
	hostByNodeId?: ReadonlyMap<string, string>,
): IMissionFinOpsSummary {
	let totalTokens = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheReadTokens = 0;
	let totalCacheWriteTokens = 0;
	let totalCostUsd = 0;

	const nodeLabelMap = new Map(nodes.map(n => [n.id, n.label]));
	const tierAgg = new Map<number, { costUsd: number; tokens: number; nodeIds: Set<string> }>();
	const hostAgg = new Map<string, { costUsd: number; tokens: number; nodeIds: Set<string> }>();
	const nodeSpends: IMissionFinOpsNodeSpend[] = [];

	if (state?.nodeTelemetry) {
		for (const [nodeId, tel] of Object.entries(state.nodeTelemetry)) {
			const cost = Math.max(0, Number.isFinite(tel.costUsd) ? tel.costUsd : 0);
			const toks = Math.max(0, Number.isFinite(tel.totalTokens) ? tel.totalTokens : 0);
			const inp = Math.max(0, Number.isFinite(tel.inputTokens) ? tel.inputTokens : 0);
			const out = Math.max(0, Number.isFinite(tel.outputTokens) ? tel.outputTokens : 0);
			const cacheRead = Math.max(0, Number.isFinite(tel.cacheReadTokens) ? tel.cacheReadTokens : 0);
			const cacheWrite = Math.max(0, Number.isFinite(tel.cacheWriteTokens) ? tel.cacheWriteTokens : 0);
			totalTokens += toks;
			totalInputTokens += inp;
			totalOutputTokens += out;
			totalCacheReadTokens += cacheRead;
			totalCacheWriteTokens += cacheWrite;
			totalCostUsd += cost;

			const assign = state.boundary.nodeAssignments[nodeId];
			const tier = assign?.tier ?? 2;
			const hostAlias = hostByNodeId?.get(nodeId) ?? assign?.hostAlias ?? 'local';

			const tBucket = tierAgg.get(tier) ?? { costUsd: 0, tokens: 0, nodeIds: new Set<string>() };
			tBucket.costUsd += cost;
			tBucket.tokens += toks;
			tBucket.nodeIds.add(nodeId);
			tierAgg.set(tier, tBucket);

			const hBucket = hostAgg.get(hostAlias) ?? { costUsd: 0, tokens: 0, nodeIds: new Set<string>() };
			hBucket.costUsd += cost;
			hBucket.tokens += toks;
			hBucket.nodeIds.add(nodeId);
			hostAgg.set(hostAlias, hBucket);

			if (cost > 0 || toks > 0) {
				nodeSpends.push({
					nodeId,
					label: nodeLabelMap.get(nodeId) ?? nodeId,
					costUsd: Math.round(cost * 10_000) / 10_000,
					tokens: toks,
					turns: tel.turns,
					hostAlias,
					tier,
				});
			}
		}
	}

	totalCostUsd = Math.round(totalCostUsd * 10_000) / 10_000;
	const cacheDenom = totalInputTokens + totalCacheReadTokens + totalCacheWriteTokens;
	const cacheSavingsPct = cacheDenom > 0 ? Math.min(99, Math.round((totalCacheReadTokens / cacheDenom) * 100)) : 0;
	const budgetLimitUsd = typeof state?.budgetLimitUsd === 'number' && Number.isFinite(state.budgetLimitUsd) && state.budgetLimitUsd > 0
		? state.budgetLimitUsd
		: undefined;
	const budgetUsedPct = budgetLimitUsd ? Math.min(100, Math.round((totalCostUsd / budgetLimitUsd) * 100)) : 0;
	const isTerminalMission = state?.status === 'completed' || state?.status === 'stopped' || state?.status === 'failed';
	const budgetCircuitTripped = !isTerminalMission && Boolean(state?.budgetCircuitTripped || (budgetLimitUsd !== undefined && totalCostUsd >= budgetLimitUsd));
	const severity: IMissionFinOpsSummary['severity'] = budgetCircuitTripped
		? 'tripped'
		: budgetLimitUsd !== undefined && budgetUsedPct >= 90
			? 'critical'
			: budgetLimitUsd !== undefined && budgetUsedPct >= 70
				? 'warn'
				: 'normal';

	const denomForPct = totalCostUsd > 0 ? totalCostUsd : Math.max(1, totalTokens);
	const byTier: IMissionFinOpsBucket[] = Array.from(tierAgg.entries())
		.sort((a, b) => a[0] - b[0])
		.map(([tier, b]) => ({
			key: `L${tier}`,
			label: `L${tier}`,
			costUsd: Math.round(b.costUsd * 10_000) / 10_000,
			tokens: b.tokens,
			nodeCount: b.nodeIds.size,
			pct: Math.round(((totalCostUsd > 0 ? b.costUsd : b.tokens) / denomForPct) * 100),
		}));

	const byHost: IMissionFinOpsBucket[] = Array.from(hostAgg.entries())
		.sort((a, b) => (b[1].costUsd - a[1].costUsd) || (b[1].tokens - a[1].tokens))
		.map(([hostAlias, b]) => ({
			key: hostAlias,
			label: hostAlias === 'local' ? '@Local' : `@${hostAlias}`,
			costUsd: Math.round(b.costUsd * 10_000) / 10_000,
			tokens: b.tokens,
			nodeCount: b.nodeIds.size,
			pct: Math.round(((totalCostUsd > 0 ? b.costUsd : b.tokens) / denomForPct) * 100),
		}));

	nodeSpends.sort((a, b) => (b.costUsd - a.costUsd) || (b.tokens - a.tokens));

	return {
		totalTokens,
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCostUsd,
		cacheSavingsPct,
		budgetLimitUsd,
		budgetUsedPct,
		budgetCircuitTripped,
		severity,
		byTier,
		byHost,
		byNode: nodeSpends,
	};
}

export function setMissionBudgetLimit(
	state: IMissionRuntimeState,
	budgetLimitUsd: number | undefined,
	now = Date.now(),
): IMissionRuntimeState {
	const normalized = typeof budgetLimitUsd === 'number' && Number.isFinite(budgetLimitUsd) && budgetLimitUsd > 0
		? Math.max(0.01, Math.round(budgetLimitUsd * 100) / 100)
		: undefined;
	const spent = computeMissionTotalCostUsd(state);
	const isLive = state.status === 'running' || state.status === 'paused';
	const exceeded = normalized !== undefined && spent >= normalized && isLive;
	const tripNow = exceeded && state.status === 'running';
	return {
		...state,
		budgetLimitUsd: normalized,
		budgetCircuitTripped: exceeded,
		...(tripNow ? { status: 'paused' as const, budgetTrippedAt: now } : {}),
		updatedAt: now,
	};
}

const MAX_STORED_REVISIONS = 30;

export function appendMissionDagRevision(
	state: IMissionRuntimeState,
	mermaidText: string,
	reason: string,
	prevGraph?: IMissionDagParseResult,
	nextGraph?: IMissionDagParseResult,
	now = Date.now(),
): IMissionRuntimeState {
	const trimmed = mermaidText.trim();
	if (!trimmed) {
		return state;
	}
	const existing = state.revisions ?? [];
	const last = existing[existing.length - 1];
	if (last && last.mermaidText.trim() === trimmed) {
		return state;
	}
	const parsedNext = nextGraph ?? parseMissionMermaidDag(mermaidText);
	if (parsedNext.error) {
		return state;
	}
	const prevIds = new Set((prevGraph?.nodes ?? []).map(n => n.id));
	const nextIds = new Set(parsedNext.nodes.map(n => n.id));
	const addedNodeIds = prevGraph ? parsedNext.nodes.map(n => n.id).filter(id => !prevIds.has(id)) : undefined;
	const removedNodeIds = prevGraph ? prevGraph.nodes.map(n => n.id).filter(id => !nextIds.has(id)) : undefined;
	const nextRev: IMissionDagRevision = {
		version: (last?.version ?? 0) + 1,
		mermaidText,
		reason: reason.trim() || 'Topology update',
		timestamp: now,
		nodeCount: parsedNext.nodes.length,
		edgeCount: parsedNext.edges.length,
		...(addedNodeIds && addedNodeIds.length > 0 ? { addedNodeIds } : {}),
		...(removedNodeIds && removedNodeIds.length > 0 ? { removedNodeIds } : {}),
	};
	const nextRevisions = [...existing, nextRev];
	const bounded = nextRevisions.length > MAX_STORED_REVISIONS
		? nextRevisions.slice(nextRevisions.length - MAX_STORED_REVISIONS)
		: nextRevisions;
	return {
		...state,
		revisions: bounded,
		updatedAt: now,
	};
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

const MAX_COMPRESSED_HISTORY_CHARS = 1200;
const MAX_SINGLE_HOP_DIGEST_CHARS = 220;
const COMPACT_HOP_DIGEST_CHARS = 128;
const MAX_STORED_TRACES = 1000;
const MAX_STORED_ARCHIVED_TOKENS = 200;
const MAX_STORED_WAVES = 64;
const SYNTHETIC_START_SUMMARY = 'Mission started — begin execution of this step.';

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

function dedupeBounded(items: readonly string[], limit: number): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const clean = item.trim();
		if (!clean) {
			continue;
		}
		const key = clean.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			out.push(clean);
			if (out.length >= limit) {
				break;
			}
		}
	}
	return out;
}

function isCjkCharCode(code: number): boolean {
	return (code >= 0x3000 && code <= 0x9FFF)
		|| (code >= 0xAC00 && code <= 0xD7AF)
		|| (code >= 0xF900 && code <= 0xFAFF);
}

/**
 * Trims text to `maxChars` cleanly at sentence, clause, whitespace, or CJK boundaries
 * instead of slicing blindly through identifiers or file paths.
 */
function trimCleanlyToBudget(raw: string, maxChars: number): string {
	const text = raw.replace(/\s+/g, ' ').trim();
	if (maxChars <= 0) {
		return '';
	}
	if (text.length <= maxChars) {
		return text;
	}
	if (maxChars <= 3) {
		return text.slice(0, maxChars);
	}
	const limit = maxChars - 1;
	const minCut = Math.max(16, Math.floor(limit * 0.58));

	// 1. Prefer strong clause/sentence punctuation near the tail
	const strongPunct = ['。', '；', '！', '？', '; ', '. ', '! ', '? ', ' | ', ' — ', '，', ', '];
	let bestStrong = -1;
	for (const sep of strongPunct) {
		const idx = text.lastIndexOf(sep, limit - sep.length);
		if (idx >= minCut && idx > bestStrong) {
			// Avoid cutting inside a dotted file path/decimal when separator is `. `
			bestStrong = idx + (sep.trim().length > 0 && !sep.endsWith(' ') ? sep.length : 0);
		}
	}
	if (bestStrong >= minCut) {
		const head = text.slice(0, bestStrong).replace(/[\s,;:—|]+$/, '');
		if (head.length > 0) {
			return `${head}…`;
		}
	}

	// 2. Prefer whitespace or CJK boundary (avoid cutting mid-word/mid-path)
	let cut = limit;
	while (cut > minCut) {
		const ch = text[cut];
		const prevCode = text.charCodeAt(cut - 1);
		if (ch === ' ' || isCjkCharCode(prevCode)) {
			break;
		}
		cut--;
	}
	const chosen = cut > minCut ? cut : limit;
	const head = text.slice(0, chosen).replace(/[\s,;:—|]+$/, '');
	return `${head || text.slice(0, limit)}…`;
}

const FILE_ARTIFACT_RE = /(?:^|[\s(`'"[,])((?:\.\.?\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10}|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|swift|py|rs|go|java|kt|cpp|cc|c|h|hpp|css|scss|html|json|yaml|yml|toml|md|sh|sql|xcodeproj|pbxproj|plist))\b/g;
const BACKTICK_SYMBOL_RE = /`([^`\n]{2,56})`/g;
const METRIC_VERDICT_RE = /\b(?:\d+\s*(?:\/\s*\d+\s*)?(?:passing|passed|failed|failing|errors?|warnings?|tests?|specs?|files?)|exit(?:\s+code)?\s*\d+|(?:0|zero)\s+errors?|(?:PASS|FAIL|VERIFIED))\b|(?:\d+\s*(?:个)?(?:通过|失败|错误|用例))/gi;

function extractEngineeringArtifacts(raw: string): string[] {
	const found: string[] = [];
	FILE_ARTIFACT_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FILE_ARTIFACT_RE.exec(raw)) !== null) {
		const candidate = m[1].trim();
		if (candidate && !candidate.startsWith('http://') && !candidate.startsWith('https://')) {
			found.push(candidate);
		}
	}
	BACKTICK_SYMBOL_RE.lastIndex = 0;
	while ((m = BACKTICK_SYMBOL_RE.exec(raw)) !== null) {
		const token = m[1].trim();
		if (token && !token.includes('aexus-ade ') && (token.includes('/') || token.includes('.') || /^[A-Za-z_][A-Za-z0-9_()-]{2,40}$/.test(token))) {
			found.push(token);
		}
	}
	return dedupeBounded(found, 6);
}

function extractEngineeringMetrics(raw: string): string[] {
	const found: string[] = [];
	METRIC_VERDICT_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = METRIC_VERDICT_RE.exec(raw)) !== null) {
		const hit = m[0].trim();
		if (hit) {
			found.push(hit);
		}
	}
	return dedupeBounded(found, 4);
}

function classifyHistoryEntryKind(rawSummary: string, previousNodeId?: string): MissionHistoryEntryKind {
	const trimmed = rawSummary.trim();
	if (/^\[(?:Rejected by |Gate [^\]]+ Rejected)/i.test(trimmed)) {
		return 'reject';
	}
	if (/^\[Fallback after /i.test(trimmed)) {
		return 'fail';
	}
	if (/^\[(?:Check |Verified:)/i.test(trimmed)) {
		return 'check';
	}
	if (/^\[Gate [^\]]+ Approved/i.test(trimmed)) {
		return 'gate';
	}
	if (/^\[Supervisor Retry Guidance\]/i.test(trimmed)) {
		return 'retry';
	}
	if (!previousNodeId) {
		return 'goal';
	}
	return 'milestone';
}

function splitSummaryClauses(raw: string): string[] {
	const lines = raw
		.split(/\r?\n+/)
		.map(l => l.replace(/^\s*[-*•]\s+/, '').trim())
		.filter(Boolean);
	const clauses: string[] = [];
	for (const line of lines) {
		// Split on CJK sentence terminators or ASCII sentence breaks followed by whitespace + clause start,
		// without breaking dotted file paths (src/app.ts) or decimals (1.4s).
		const parts = line
			.split(/(?<=[。！？；])|(?<=[!?])\s+|(?<=[^A-Za-z0-9_./]\.)\s+|(?<=[A-Za-z]{2}\.)\s+(?=[A-Z[\u4e00-\u9fff])|(?<=;)\s+/)
			.map(p => p.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			clauses.push(line);
		} else {
			clauses.push(...parts);
		}
	}
	return clauses;
}

function scoreSummaryClause(clause: string, index: number, total: number): number {
	let score = 1;
	if (index === 0) { score += 2.2; }
	if (index === total - 1 && total > 1) { score += 2.4; }
	if (/^\[(?:Rejected|Fallback|Gate|Verified|Check|Supervisor|Patched)/i.test(clause)) { score += 5; }
	if (/\b(?:fix(?:ed)?|implement(?:ed)?|add(?:ed)?|creat(?:ed)?|updat(?:ed)?|verif(?:ied)?|pass(?:ed|ing)?|fail(?:ed|ing)?|reject(?:ed)?|error|root cause|decision|schema|api|endpoint|test|build|lint)\b/i.test(clause)) { score += 2.5; }
	if (/(?:修复|新增|实现|通过|失败|驳回|验证|结论|决定|接口|架构|编译|测试)/.test(clause)) { score += 2.5; }
	FILE_ARTIFACT_RE.lastIndex = 0;
	if (FILE_ARTIFACT_RE.test(clause)) { score += 2.5; }
	METRIC_VERDICT_RE.lastIndex = 0;
	if (METRIC_VERDICT_RE.test(clause)) { score += 2.5; }
	if (clause.includes('`')) { score += 1.5; }
	return score;
}

/**
 * Signal-aware extractive summary compaction: retains high-SNR clauses (verdicts, paths, metrics,
 * conclusions) in chronological order and trims cleanly on sentence/word/CJK boundaries.
 */
function compactSummaryToBudget(
	rawSummary: string,
	maxChars: number,
	artifacts: readonly string[],
	metrics: readonly string[],
): string {
	const normalized = rawSummary.replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	const clauses = splitSummaryClauses(rawSummary);
	if (clauses.length <= 1) {
		return trimCleanlyToBudget(normalized, maxChars);
	}
	const scored = clauses.map((text, idx) => ({
		idx,
		text,
		score: scoreSummaryClause(text, idx, clauses.length),
	}));
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

	const pickedIndices: number[] = [];
	let used = 0;
	for (const cand of scored) {
		const sepLen = pickedIndices.length > 0 ? 3 : 0; // ' · '
		if (used + sepLen + cand.text.length <= maxChars) {
			pickedIndices.push(cand.idx);
			used += sepLen + cand.text.length;
		} else if (pickedIndices.length === 0) {
			// Even the highest-scoring clause exceeds maxChars -> cleanly trim it
			pickedIndices.push(cand.idx);
			used = maxChars;
			break;
		}
	}
	pickedIndices.sort((a, b) => a - b);
	let result = pickedIndices.map(i => clauses[i]).join(' · ');
	if (result.length > maxChars) {
		result = trimCleanlyToBudget(result, maxChars);
	}

	// Preserve salient trailing metrics/artifacts if they were omitted from selected clauses and room remains
	const missingMetrics = metrics.filter(m => !result.toLowerCase().includes(m.toLowerCase()));
	const missingArtifacts = artifacts.filter(a => !result.toLowerCase().includes(a.toLowerCase()));
	const extras = [...missingMetrics.slice(0, 2), ...missingArtifacts.slice(0, 2)];
	if (extras.length > 0 && result.length + 14 < maxChars) {
		const suffix = ` [${extras.join(', ')}]`;
		if (result.length + suffix.length <= maxChars) {
			result += suffix;
		}
	}
	return result;
}

function distillHistoryHop(previousLastSummary: string, previousNodeId?: string): IMissionHistoryEntry | undefined {
	const trimmed = previousLastSummary.trim();
	if (!trimmed) {
		return undefined;
	}
	// Never waste rolling history budget on synthetic startup boilerplate when no user initialPrompt was given
	if (!previousNodeId && trimmed === SYNTHETIC_START_SUMMARY) {
		return undefined;
	}
	const kind = classifyHistoryEntryKind(trimmed, previousNodeId);
	const artifacts = extractEngineeringArtifacts(trimmed);
	const metrics = extractEngineeringMetrics(trimmed);
	const digest = compactSummaryToBudget(trimmed, MAX_SINGLE_HOP_DIGEST_CHARS, artifacts, metrics);
	return {
		...(previousNodeId ? { nodeId: previousNodeId } : {}),
		kind,
		digest,
		artifacts,
		metrics,
	};
}

function formatHistoryEntryLine(entry: IMissionHistoryEntry, maxDigestChars?: number): string {
	const body = maxDigestChars && entry.digest.length > maxDigestChars
		? compactSummaryToBudget(entry.digest, maxDigestChars, entry.artifacts, entry.metrics)
		: entry.digest;
	if (entry.nodeId) {
		return `- [${entry.nodeId}] ${body}`;
	}
	if (entry.kind === 'goal') {
		return `- [Goal] ${body}`;
	}
	return `- ${body}`;
}

function formatArchivedNodeTrail(nodeIds: readonly string[]): string {
	const cleaned = nodeIds.filter(Boolean);
	if (cleaned.length === 0) {
		return '';
	}
	if (cleaned.length <= 5) {
		return cleaned.join('→');
	}
	return `${cleaned[0]}→${cleaned[1]}→…→${cleaned[cleaned.length - 2]}→${cleaned[cleaned.length - 1]}`;
}

function buildArchivedOutcomeSnippet(entry: IMissionHistoryEntry): string {
	const prefix = entry.nodeId ? `${entry.nodeId}: ` : '';
	const parts: string[] = [];
	if (entry.kind === 'reject' || entry.kind === 'fail' || entry.kind === 'check' || entry.kind === 'gate') {
		parts.push(trimCleanlyToBudget(entry.digest, 72));
	} else if (entry.metrics.length > 0) {
		parts.push(`${trimCleanlyToBudget(entry.digest, 48)} (${entry.metrics[0]})`);
	} else {
		parts.push(trimCleanlyToBudget(entry.digest, 56));
	}
	return `${prefix}${parts.join(' ')}`.trim();
}

function renderArchivedRollupLine(state: IMissionRollingHistoryState, maxChars: number): string {
	if (state.archivedCount <= 0) {
		return '';
	}
	const expandHint = 'expand: `aexus-ade token trace <ptr>`';
	const trail = formatArchivedNodeTrail(state.archivedNodeIds);
	const baseHead = `... (${state.archivedCount} earlier step(s) condensed${trail ? ` [${trail}]` : ''}`;
	const baseTail = `; ${expandHint})`;
	const baseOnly = `${baseHead}${baseTail}`;
	if (baseOnly.length >= maxChars) {
		return trimCleanlyToBudget(`... (${state.archivedCount} earlier step(s) condensed; ${expandHint})`, maxChars);
	}

	const detailBudget = maxChars - baseOnly.length - 2; // ': '
	const segments: string[] = [];
	if (state.archivedArtifacts.length > 0) {
		segments.push(`files: ${state.archivedArtifacts.slice(0, 4).join(', ')}`);
	}
	if (state.archivedOutcomes.length > 0) {
		segments.push(`key: ${state.archivedOutcomes.slice(0, 3).join(' | ')}`);
	}
	if (segments.length === 0 || detailBudget < 16) {
		return baseOnly;
	}
	const detailText = trimCleanlyToBudget(segments.join('; '), detailBudget);
	return detailText ? `${baseHead}: ${detailText}${baseTail}` : baseOnly;
}

const ARCHIVED_LINE_RE = /^\.\.\.\s*\((\d+)\s+earlier step\(s\) condensed(?:\s*\[([^\]]+)\])?(?::\s*(.+?))?(?:;\s*(?:use|expand:).*)?\)$/i;

function parseLegacyCompressedHistory(raw: string): IMissionRollingHistoryState {
	let archivedCount = 0;
	const archivedNodeIds: string[] = [];
	const archivedArtifacts: string[] = [];
	const archivedOutcomes: string[] = [];
	const recentEntries: IMissionHistoryEntry[] = [];

	for (const rawLine of raw.split('\n')) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const archMatch = ARCHIVED_LINE_RE.exec(line);
		if (archMatch) {
			archivedCount += Number.parseInt(archMatch[1], 10) || 0;
			if (archMatch[2]) {
				for (const nid of archMatch[2].split('→').map(s => s.trim()).filter(s => s && s !== '…')) {
					archivedNodeIds.push(nid);
				}
			}
			if (archMatch[3]) {
				for (const art of extractEngineeringArtifacts(archMatch[3])) {
					archivedArtifacts.push(art);
				}
				const keyPart = /(?:^|;\s*)key:\s*(.+)$/i.exec(archMatch[3]);
				if (keyPart) {
					for (const outcome of keyPart[1].split('|').map(s => s.trim()).filter(Boolean)) {
						archivedOutcomes.push(outcome);
					}
				}
			}
			continue;
		}
		const bulletMatch = /^-\s*(?:\[([^\]]+)\]\s*)?(.+)$/.exec(line);
		const tag = bulletMatch?.[1]?.trim();
		const body = (bulletMatch ? bulletMatch[2] : line).trim();
		const nodeId = tag && tag !== 'Goal' ? tag : undefined;
		const entry = distillHistoryHop(body, nodeId);
		if (entry) {
			recentEntries.push(tag === 'Goal' ? { ...entry, kind: 'goal' } : entry);
		}
	}

	return {
		archivedCount,
		archivedNodeIds,
		archivedArtifacts: dedupeBounded(archivedArtifacts, 8),
		archivedOutcomes: dedupeBounded(archivedOutcomes, 4),
		recentEntries,
	};
}

function pickEvictionCandidateIndex(entries: readonly IMissionHistoryEntry[]): number {
	// Always protect the two newest hops when possible; evict oldest low-priority milestone first
	const protectedTail = Math.min(2, entries.length - 1);
	const evictableEnd = Math.max(1, entries.length - protectedTail);
	const priorityOf = (kind: MissionHistoryEntryKind): number => {
		if (kind === 'goal') { return 3; }
		if (kind === 'reject' || kind === 'fail' || kind === 'check') { return 2; }
		if (kind === 'gate' || kind === 'retry') { return 1; }
		return 0;
	};
	let chosenIdx = 0;
	let lowestPriority = priorityOf(entries[0].kind);
	for (let i = 1; i < evictableEnd; i++) {
		const p = priorityOf(entries[i].kind);
		if (p < lowestPriority) {
			lowestPriority = p;
			chosenIdx = i;
		}
	}
	return chosenIdx;
}

/**
 * Hierarchically fits a rolling history state into `MAX_COMPRESSED_HISTORY_CHARS`:
 * 1. Gently tightens older recent entries before evicting.
 * 2. Evicts lowest-priority oldest entries into the cumulative archived rollup (preserving count,
 *    node trail, touched artifacts, and critical verdicts instead of hard-deleting middle hops).
 */
export function renderRollingHistory(
	inputState: IMissionRollingHistoryState,
	maxChars = MAX_COMPRESSED_HISTORY_CHARS,
): { readonly state: IMissionRollingHistoryState; readonly text: string } {
	let archivedCount = inputState.archivedCount;
	const archivedNodeIds = [...inputState.archivedNodeIds];
	let archivedArtifacts = dedupeBounded(inputState.archivedArtifacts, 8);
	let archivedOutcomes = dedupeBounded(inputState.archivedOutcomes, 4);
	let recentEntries = [...inputState.recentEntries];

	const formatWith = (tightOlder: boolean): string => {
		const lines: string[] = [];
		const currentState: IMissionRollingHistoryState = {
			archivedCount,
			archivedNodeIds,
			archivedArtifacts,
			archivedOutcomes,
			recentEntries,
		};
		if (archivedCount > 0) {
			const rollupBudget = recentEntries.length > 0 ? Math.min(340, Math.floor(maxChars * 0.34)) : maxChars;
			lines.push(renderArchivedRollupLine(currentState, rollupBudget));
		}
		for (let i = 0; i < recentEntries.length; i++) {
			const isLatestTwo = i >= recentEntries.length - 2;
			const cap = tightOlder && !isLatestTwo ? COMPACT_HOP_DIGEST_CHARS : undefined;
			lines.push(formatHistoryEntryLine(recentEntries[i], cap));
		}
		return lines.join('\n');
	};

	// Fast path: fits without tightening or eviction
	let rendered = formatWith(false);
	if (rendered.length <= maxChars) {
		return {
			state: { archivedCount, archivedNodeIds, archivedArtifacts, archivedOutcomes, recentEntries },
			text: rendered,
		};
	}

	// Stage 1: gracefully tighten older recent hops before evicting anything
	rendered = formatWith(true);
	if (rendered.length <= maxChars) {
		recentEntries = recentEntries.map((entry, idx) =>
			idx < recentEntries.length - 2 && entry.digest.length > COMPACT_HOP_DIGEST_CHARS
				? { ...entry, digest: compactSummaryToBudget(entry.digest, COMPACT_HOP_DIGEST_CHARS, entry.artifacts, entry.metrics) }
				: entry,
		);
		return {
			state: { archivedCount, archivedNodeIds, archivedArtifacts, archivedOutcomes, recentEntries },
			text: rendered,
		};
	}

	// Stage 2: progressively roll oldest low-priority hops into cumulative archived rollup
	while (recentEntries.length > 1 && rendered.length > maxChars) {
		const evictIdx = pickEvictionCandidateIndex(recentEntries);
		const [evicted] = recentEntries.splice(evictIdx, 1);
		archivedCount += 1;
		if (evicted.nodeId) {
			archivedNodeIds.push(evicted.nodeId);
		}
		if (evicted.artifacts.length > 0) {
			archivedArtifacts = dedupeBounded([...archivedArtifacts, ...evicted.artifacts], 8);
		}
		const snippet = buildArchivedOutcomeSnippet(evicted);
		if (snippet) {
			const prioritizeFront = evicted.kind === 'reject' || evicted.kind === 'fail' || evicted.kind === 'check' || evicted.kind === 'goal';
			archivedOutcomes = dedupeBounded(
				prioritizeFront ? [snippet, ...archivedOutcomes] : [...archivedOutcomes, snippet],
				4,
			);
		}
		rendered = formatWith(true);
	}

	// Final safety guarantee when a single remaining entry + rollup still exceeds maxChars
	if (rendered.length > maxChars && recentEntries.length === 1) {
		const rollup = archivedCount > 0
			? renderArchivedRollupLine({ archivedCount, archivedNodeIds, archivedArtifacts, archivedOutcomes, recentEntries }, Math.min(280, Math.floor(maxChars * 0.35)))
			: '';
		const remBudget = Math.max(32, maxChars - (rollup ? rollup.length + 1 : 0));
		const entry = recentEntries[0];
		const prefixLen = entry.nodeId ? entry.nodeId.length + 5 : 2;
		const trimmedEntry: IMissionHistoryEntry = {
			...entry,
			digest: compactSummaryToBudget(entry.digest, Math.max(20, remBudget - prefixLen), entry.artifacts, entry.metrics),
		};
		recentEntries = [trimmedEntry];
		rendered = rollup ? `${rollup}\n${formatHistoryEntryLine(trimmedEntry)}` : formatHistoryEntryLine(trimmedEntry);
	}

	if (rendered.length > maxChars) {
		rendered = trimCleanlyToBudget(rendered, maxChars);
	}

	return {
		state: { archivedCount, archivedNodeIds, archivedArtifacts, archivedOutcomes, recentEntries },
		text: rendered,
	};
}

/**
 * Hierarchical semantic rolling history compactor: folds `previousLastSummary` into structured
 * rolling state and renders a strictly bounded high-SNR digest (preserving cumulative counts,
 * node trail, file artifacts, and critical verdicts instead of hard truncation).
 */
export function compressTokenHistoryState(
	prevState: IMissionRollingHistoryState | undefined,
	prevCompressed: string,
	previousLastSummary: string,
	previousNodeId?: string,
): { readonly state: IMissionRollingHistoryState; readonly text: string } {
	const baseState: IMissionRollingHistoryState = prevState
		? {
			archivedCount: prevState.archivedCount,
			archivedNodeIds: [...prevState.archivedNodeIds],
			archivedArtifacts: [...prevState.archivedArtifacts],
			archivedOutcomes: [...prevState.archivedOutcomes],
			recentEntries: [...prevState.recentEntries],
		}
		: parseLegacyCompressedHistory(prevCompressed);

	const newEntry = distillHistoryHop(previousLastSummary, previousNodeId);
	if (!newEntry) {
		return renderRollingHistory(baseState);
	}
	return renderRollingHistory({
		...baseState,
		recentEntries: [...baseState.recentEntries, newEntry],
	});
}

/**
 * Backward-compatible string wrapper over the hierarchical semantic rolling history compactor.
 */
export function compressTokenHistory(
	prevCompressed: string,
	previousLastSummary: string,
	previousNodeId?: string,
	prevState?: IMissionRollingHistoryState,
): string {
	return compressTokenHistoryState(prevState, prevCompressed, previousLastSummary, previousNodeId).text;
}

/**
 * Merges rolling histories from multiple parallel branches converging at a Join Barrier
 * without losing cumulative archived steps, touched artifacts, or critical outcomes.
 */
export function mergeRollingHistoryStates(
	tokens: readonly Pick<IMissionToken, 'compressedHistory' | 'historyState'>[],
): { readonly state: IMissionRollingHistoryState; readonly text: string } {
	let archivedCount = 0;
	const archivedNodeIds: string[] = [];
	const seenArchivedNodeIds = new Set<string>();
	const archivedArtifacts: string[] = [];
	const archivedOutcomes: string[] = [];
	const recentEntries: IMissionHistoryEntry[] = [];
	const seenEntryKeys = new Set<string>();

	for (const tok of tokens) {
		const st = tok.historyState ?? parseLegacyCompressedHistory(tok.compressedHistory);
		// Deduplicate shared pre-fork archived nodes while counting distinct branch-archived steps
		let sharedCount = 0;
		for (const nid of st.archivedNodeIds) {
			if (seenArchivedNodeIds.has(nid)) {
				sharedCount++;
			} else {
				seenArchivedNodeIds.add(nid);
				archivedNodeIds.push(nid);
			}
		}
		const distinctArchived = Math.max(0, st.archivedCount - sharedCount);
		archivedCount += distinctArchived;
		if (st.archivedNodeIds.length === 0 && st.archivedCount > 0) {
			archivedCount = Math.max(archivedCount, st.archivedCount);
		}
		archivedArtifacts.push(...st.archivedArtifacts);
		archivedOutcomes.push(...st.archivedOutcomes);
		for (const entry of st.recentEntries) {
			const key = `${entry.nodeId ?? ''}\x1f${entry.kind}\x1f${entry.digest}`;
			if (!seenEntryKeys.has(key)) {
				seenEntryKeys.add(key);
				recentEntries.push(entry);
			}
		}
	}

	return renderRollingHistory({
		archivedCount,
		archivedNodeIds,
		archivedArtifacts: dedupeBounded(archivedArtifacts, 8),
		archivedOutcomes: dedupeBounded(archivedOutcomes, 4),
		recentEntries,
	});
}

/**
 * Expands a lightweight `tracePtr` into the MOST RECENT `maxEntries` chronological traversal steps
 * (including recent rejection loops & merged branches), never dropping newest hops when history is deep.
 */
export function expandTracePointer(
	state: Pick<IMissionRuntimeState, 'traces'>,
	tracePtr: string,
	maxEntries = 100,
): readonly IMissionTraceNode[] {
	const limit = Math.max(1, Math.floor(maxEntries));
	const visited = new Set<string>();
	const collected: IMissionTraceNode[] = [];
	const queue: string[] = tracePtr ? [tracePtr] : [];

	// Reverse-BFS from newest tracePtr backwards so deep chains retain the latest `maxEntries` hops.
	while (queue.length > 0 && collected.length < limit) {
		const ptr = queue.shift()!;
		if (!ptr || visited.has(ptr)) {
			continue;
		}
		const node = state.traces[ptr];
		if (!node) {
			continue;
		}
		visited.add(ptr);
		collected.push(node);
		if (node.parentPtrs.length > 1) {
			const sortedParents = [...node.parentPtrs].sort((a, b) =>
				(state.traces[b]?.timestamp ?? 0) - (state.traces[a]?.timestamp ?? 0),
			);
			for (const parentPtr of sortedParents) {
				if (parentPtr && !visited.has(parentPtr)) {
					queue.push(parentPtr);
				}
			}
		} else if (node.parentPtrs.length === 1) {
			const parentPtr = node.parentPtrs[0];
			if (parentPtr && !visited.has(parentPtr)) {
				queue.push(parentPtr);
			}
		}
	}
	return collected.sort((a, b) => a.timestamp - b.timestamp || a.ptr.localeCompare(b.ptr));
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
): string {
	const lines: string[] = [
		`[Mission Token Dispatched — ${isRejection ? 'REVISION REQUESTED' : 'ACTIVE'}]`,
		`- Mission: \`${token.missionId}\` | Node: \`${token.nodeId}\` (${nodeLabel}) | Token: \`${token.id}\` | Wave: \`${token.waveId}\``,
		`- Trace Pointer: \`${token.tracePtr}\` (expand only if needed: \`aexus-ade token trace ${token.tracePtr} --json\`)`,
		'',
		PREV_SUMMARY_HEADING,
		token.lastSummary || '(Initial entry step — no upstream summary)',
	];
	if (token.compressedHistory) {
		const renderedHistory = token.compressedHistory.replace(/aexus-ade token trace <ptr>/g, `aexus-ade token trace ${token.tracePtr}`);
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
	nodeTelemetry?: Record<string, IMissionNodeTelemetry>;
	waveRoots: Record<string, readonly string[]>;
	deferredEffects: MissionEngineEffect[];
	budgetLimitUsd?: number;
	budgetCircuitTripped?: boolean;
	budgetTrippedAt?: number;
	revisions?: IMissionDagRevision[];
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
		...(state.nodeTelemetry ? { nodeTelemetry: { ...state.nodeTelemetry } } : {}),
		waveRoots: { ...(state.waveRoots ?? {}) },
		deferredEffects: [...(state.deferredEffects ?? [])],
		...(state.budgetLimitUsd !== undefined ? { budgetLimitUsd: state.budgetLimitUsd } : {}),
		...(state.budgetCircuitTripped !== undefined ? { budgetCircuitTripped: state.budgetCircuitTripped } : {}),
		...(state.budgetTrippedAt !== undefined ? { budgetTrippedAt: state.budgetTrippedAt } : {}),
		...(state.revisions ? { revisions: [...state.revisions] } : {}),
		waveSeq: state.waveSeq,
		tokenSeq: state.tokenSeq,
		traceSeq: state.traceSeq,
		startedAt: state.startedAt,
		completedAt: state.completedAt,
		updatedAt: now,
		effects: [],
	};
}

function recomputeNodeState(
	ctx: IMutableEngineContext,
	nodeId: string,
	fallbackState: MissionNodeRuntimeStatus = 'idle',
): void {
	let hasActive = false;
	let hasWaitingGate = false;
	let hasBlocked = false;
	let hasFrozenFailed = false;
	let hasWaitingJoin = false;
	for (const tok of Object.values(ctx.tokens)) {
		if (tok.nodeId !== nodeId) {
			continue;
		}
		if (tok.status === 'active') {
			hasActive = true;
			break;
		}
		if (tok.status === 'waiting_gate') {
			hasWaitingGate = true;
		} else if (tok.status === 'blocked') {
			hasBlocked = true;
		} else if (tok.status === 'frozen_failed') {
			hasFrozenFailed = true;
		} else if (tok.status === 'waiting_join') {
			hasWaitingJoin = true;
		}
	}
	if (hasActive) {
		ctx.nodeStates[nodeId] = 'active';
	} else if (hasWaitingGate) {
		ctx.nodeStates[nodeId] = 'waiting_gate';
	} else if (hasBlocked) {
		ctx.nodeStates[nodeId] = 'blocked';
	} else if (hasFrozenFailed) {
		ctx.nodeStates[nodeId] = 'failed';
	} else if (hasWaitingJoin || Object.values(ctx.joinBarriers).some(b => b.targetNodeId === nodeId)) {
		ctx.nodeStates[nodeId] = 'waiting_join';
	} else {
		ctx.nodeStates[nodeId] = fallbackState;
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

function freezeMutable(missionId: string, ctx: IMutableEngineContext): IMissionRuntimeState {
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
		if (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
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

function appendTrace(
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
		readonly historyState?: IMissionRollingHistoryState;
		readonly tracePtr: string;
		readonly now: number;
		readonly isRejection?: boolean;
		readonly bypassJoin?: boolean;
		readonly returnToNodeId?: string;
		readonly returnWaveId?: string;
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
function collectImpactedDownstreamJoins(
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
		readonly historyState?: IMissionRollingHistoryState;
		readonly tracePtr: string;
		readonly now: number;
		readonly isRejection?: boolean;
		readonly returnToNodeId?: string;
		readonly returnWaveId?: string;
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
		...(params.historyState ? { historyState: params.historyState } : {}),
		tracePtr: params.tracePtr,
		fromNodeId: params.fromNodeId,
		...(params.returnToNodeId ? { returnToNodeId: params.returnToNodeId } : {}),
		...(params.returnWaveId ? { returnWaveId: params.returnWaveId } : {}),
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
	ctx.nodeTelemetry = {};
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
				summary: `✨ Context distilled — fresh session ready`,
				updatedAt: now,
			},
		};
	}

	const assignedAgentId = ctx.boundary.nodeAssignments[nodeId]?.agentId ?? liveTok?.holderAgentId;
	if (liveTok) {
		const distillTracePtr = appendTrace(ctx, {
			parentPtrs: [liveTok.tracePtr],
			nodeId,
			employeeId: assignedAgentId,
			waveId: liveTok.waveId,
			event: 'distill',
			summary: customMemo ? `Context distilled: ${customMemo}` : 'Context distilled & session refreshed',
			timestamp: now,
		});
		const updatedTok: IMissionToken = {
			...liveTok,
			status: 'active',
			holderAgentId: assignedAgentId,
			lastSummary: distilledMemo,
			tracePtr: distillTracePtr,
			lastActivityAt: now,
			nudgeCount: 0,
			checkFailureCount: 0,
			lastCheckFailure: undefined,
			blocked: undefined,
			failure: undefined,
		};
		ctx.tokens[liveTok.id] = updatedTok;
		recomputeNodeState(ctx, nodeId);

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
		if (ctx.status === 'running') {
			const basePrompt = buildTokenDispatchPrompt(updatedTok, node.label, false);
			ctx.effects.push({
				kind: 'dispatch_token',
				missionId: state.missionId,
				nodeId,
				tokenId: updatedTok.id,
				holderAgentId: assignedAgentId,
				prompt: `[Context Distilled & Session Refreshed]\n${basePrompt}`,
			});
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
	ctx.budgetCircuitTripped = false;
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
): void {
	const prev = ctx.nodeTelemetry?.[nodeId];
	const nextEntry: IMissionNodeTelemetry = {
		inputTokens: prev?.inputTokens ?? 0,
		outputTokens: prev?.outputTokens ?? 0,
		cacheReadTokens: prev?.cacheReadTokens ?? 0,
		cacheWriteTokens: prev?.cacheWriteTokens ?? 0,
		totalTokens: prev?.totalTokens ?? 0,
		costUsd: prev?.costUsd ?? 0,
		turns: prev?.turns ?? 0,
		contextWindowMax: prev?.contextWindowMax ?? DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS,
		contextInitTokens: prev?.contextInitTokens ?? 0,
		contextTierDocTokens: prev?.contextTierDocTokens ?? 0,
		contextSourceTokens: prev?.contextSourceTokens ?? 0,
		contextNoiseTokens: prev?.contextNoiseTokens ?? 0,
		...(prev?.model ? { model: prev.model } : {}),
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

	if (params.suiteResult.passed) {
		const passPtr = appendTrace(ctx, {
			parentPtrs: [token.tracePtr],
			nodeId: token.nodeId,
			employeeId: token.holderAgentId,
			waveId: token.waveId,
			event: 'check_passed',
			summary: params.suiteResult.summary,
			timestamp: now,
		});
		ctx.tokens[token.id] = {
			...token,
			tracePtr: passPtr,
			lastCheckFailure: undefined,
			lastActivityAt: now,
		};
		updateNodeCheckTelemetry(ctx, token.nodeId, 'passed', params.suiteResult.summary, now);
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
		employeeId: token.holderAgentId,
		waveId: token.waveId,
		event: 'check_failed',
		summary: trimCleanlyToBudget(params.suiteResult.summary, 280),
		timestamp: now,
	});
	updateNodeCheckTelemetry(ctx, token.nodeId, 'failed', params.suiteResult.summary, now);

	if (canBounce) {
		ctx.tokens[token.id] = {
			...token,
			tracePtr: failCheckPtr,
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
			employeeId: token.holderAgentId,
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
					escalationHistory: [{ fromId: token.holderAgentId ?? token.nodeId, toId: directSup.id, note: params.suiteResult.summary, at: now }],
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
				escalationHistory: [{ fromId: token.holderAgentId ?? token.nodeId, toId: 'human-inbox', note: params.suiteResult.summary, at: now }],
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
			senderAgentId: token.holderAgentId,
		});
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
	recomputeNodeState(ctx, token.nodeId, 'completed');

	const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
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
					returnToNodeId: reachingReturnTarget ? undefined : returnTarget,
					returnWaveId: reachingReturnTarget ? undefined : token.returnWaveId,
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
			compressedHistory: rolledHistory.text,
			historyState: rolledHistory.state,
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
	recomputeNodeState(ctx, token.nodeId, 'idle');

	ctx.waveSeq += 1;
	const reworkWaveId = `wave-${ctx.waveSeq}`;
	ctx.waveRoots[reworkWaveId] = [targetNodeId];

	const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
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
		compressedHistory: rolledHistory.text,
		historyState: rolledHistory.state,
		tracePtr: rejPtr,
		now,
		isRejection: true,
		bypassJoin: true,
		returnToNodeId: token.nodeId,
		returnWaveId: token.waveId,
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
		};
		ctx.effects.push({
			kind: 'wakeup_agent',
			missionId: state.missionId,
			nodeId: token.nodeId,
			tokenId: token.id,
			holderAgentId: token.holderAgentId,
			wakeupReason: params.reason,
			message: params.reason === 'agent_exited'
				? `[Mission Watchdog Fast Recovery #${nextNudgeCount}/${maxNudges}] Your remote persistent process for active token \`${token.id}\` on node \`${token.nodeId}\` exited without closing the token (${params.detail || 'remote session terminated'}). Inspect your workspace, preserve completed progress, and either finish and call \`aexus-ade token complete ${token.id} --summary "..."\`, block via \`token block\`, or report failure via \`token fail\`.`
				: `[Mission Watchdog Reminder #${nextNudgeCount}/${maxNudges}] You hold active token \`${token.id}\` on node \`${token.nodeId}\` with no activity for ${state.silenceTimeoutMinutes}m. If finished, submit \`aexus-ade token complete ${token.id} --summary "..."\`. If running a long command, call \`aexus-ade token block ${token.id} --duration ... --reason "..."\`. If stuck, call \`aexus-ade token fail ${token.id} --reason "..."\`.`,
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
		recomputeNodeState(ctx, token.nodeId, 'failed');

		const rolledHistory = compressTokenHistoryState(token.historyState, token.compressedHistory, token.lastSummary, token.fromNodeId);
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
			const reachingReturnTarget = Boolean(token.returnToNodeId && fEdge.to === token.returnToNodeId);
			const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
				targetNodeId: fEdge.to,
				fromNodeId: token.nodeId,
				waveId: token.waveId,
				lastSummary: `[Fallback after ${token.nodeId} failed] ${reason}`,
				compressedHistory: rolledHistory.text,
				historyState: rolledHistory.state,
				tracePtr: failPtr,
				now,
				...(token.returnToNodeId && !reachingReturnTarget ? { returnToNodeId: token.returnToNodeId } : {}),
				...(token.returnWaveId && !reachingReturnTarget ? { returnWaveId: token.returnWaveId } : {}),
				...(reachingReturnTarget && token.returnWaveId ? { restoreWaveId: token.returnWaveId } : {}),
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
		&& (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join'),
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
		returnToNodeId: candidate.returnToNodeId,
		returnWaveId: candidate.returnWaveId,
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
		readonly tokenId?: string;
		readonly note?: string;
		readonly rollbackNodeId?: string;
		readonly now?: number;
	},
): IMissionEngineTransitionResult<{ readonly nextTokenIds: readonly string[]; readonly resolvedTokenId?: string; readonly remainingQueuedGateCount?: number }> {
	if (state.status !== 'running') {
		return { ok: false, state, effects: [], code: 'INVALID_STATE', error: `Mission is "${state.status}", not running.` };
	}
	const waitingTokens = Object.values(state.tokens)
		.filter(t => t.nodeId === params.nodeId && t.status === 'waiting_gate')
		.sort((a, b) => a.arrivedAt - b.arrivedAt);
	const waitingToken = params.tokenId
		? waitingTokens.find(t => t.id === params.tokenId)
		: waitingTokens[0];
	if (!waitingToken) {
		return {
			ok: false,
			state,
			effects: [],
			code: 'NOT_FOUND',
			error: params.tokenId
				? `Waiting gate token "${params.tokenId}" not found on Gate "${params.nodeId}".`
				: `No token is waiting at Gate "${params.nodeId}".`,
		};
	}
	const now = params.now ?? Date.now();
	const ctx = cloneMutable(state, now);
	ctx.tokens[waitingToken.id] = { ...waitingToken, status: 'completed', lastActivityAt: now };

	const surfaceNextQueuedGate = (): number => {
		const remaining = Object.values(ctx.tokens)
			.filter(t => t.nodeId === params.nodeId && t.status === 'waiting_gate')
			.sort((a, b) => a.arrivedAt - b.arrivedAt);
		if (remaining.length > 0) {
			const nextGateTok = remaining[0];
			const gateNode = graph.nodes.find(n => n.id === params.nodeId);
			const traceAncestors = new Set(expandTracePointer(ctx, nextGateTok.tracePtr).map(t => t.nodeId));
			const incomingEdges = getIncomingEdges(graph, params.nodeId);
			const candidateEdges = incomingEdges.filter(e => traceAncestors.size === 0 || traceAncestors.has(e.from));
			const rollbackCandidates = (candidateEdges.length > 0 ? candidateEdges : incomingEdges).map(e => {
				const src = graph.nodes.find(n => n.id === e.from);
				return { id: e.from, title: src?.label ?? e.from };
			});
			ctx.effects.push({
				kind: 'upsert_gate_inbox',
				missionId: state.missionId,
				nodeId: params.nodeId,
				tokenId: nextGateTok.id,
				nodeTitle: gateNode?.label ?? params.nodeId,
				upstreamSummary: nextGateTok.lastSummary,
				rollbackCandidates,
			});
		}
		return remaining.length;
	};

	if (params.decision === 'approve') {
		recomputeNodeState(ctx, params.nodeId, 'completed');
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
		const rolledHistory = compressTokenHistoryState(waitingToken.historyState, waitingToken.compressedHistory, waitingToken.lastSummary, waitingToken.fromNodeId);
		const nextTokenIds: string[] = [];
		for (const succEdge of getOutgoingEdges(graph, params.nodeId, 'success')) {
			const delivered = deliverTokenToTarget(state.missionId, ctx, graph, {
				targetNodeId: succEdge.to,
				fromNodeId: params.nodeId,
				waveId: waitingToken.waveId,
				lastSummary: summary,
				compressedHistory: rolledHistory.text,
				historyState: rolledHistory.state,
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
		const remainingQueuedGateCount = surfaceNextQueuedGate();
		checkMissionCompletion(ctx);
		return {
			ok: true,
			state: freezeMutable(state.missionId, ctx),
			effects: ctx.effects,
			data: { nextTokenIds, resolvedTokenId: waitingToken.id, remainingQueuedGateCount },
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
	recomputeNodeState(ctx, params.nodeId, 'idle');
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
	const rolledRejectHistory = compressTokenHistoryState(waitingToken.historyState, waitingToken.compressedHistory, waitingToken.lastSummary, waitingToken.fromNodeId);
	const bounced = deliverTokenToTarget(state.missionId, ctx, graph, {
		targetNodeId: rollbackTarget,
		fromNodeId: params.nodeId,
		waveId: reworkWaveId,
		lastSummary: `[Gate ${params.nodeId} Rejected] ${note}`,
		compressedHistory: rolledRejectHistory.text,
		historyState: rolledRejectHistory.state,
		tracePtr: rejPtr,
		now,
		isRejection: true,
		bypassJoin: true,
		returnToNodeId: params.nodeId,
		returnWaveId: waitingToken.waveId,
	})!;
	const remainingQueuedGateCount = surfaceNextQueuedGate();
	return {
		ok: true,
		state: freezeMutable(state.missionId, ctx),
		effects: ctx.effects,
		data: { nextTokenIds: [bounced.id], resolvedTokenId: waitingToken.id, remainingQueuedGateCount },
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

	const explicitNodeSet = new Set(params.nodeIds ?? []);
	if (!jurisdiction.hasFullJurisdiction) {
		const outOfScope = [...targetNodeSet].filter(nid => !jurisdiction.nodeIds.has(nid));
		// Check if any recalled branch feeds a join barrier (either already open or reachable downstream in an active wave) outside jurisdiction.
		for (const barrier of Object.values(state.joinBarriers)) {
			if (barrier.expectedFromNodeIds.some(fid => targetNodeSet.has(fid)) && !jurisdiction.nodeIds.has(barrier.targetNodeId)) {
				outOfScope.push(barrier.targetNodeId);
			}
		}
		const hasLiveInTarget = Object.values(state.tokens).some(t =>
			targetNodeSet.has(t.nodeId) && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'waiting_join' || t.status === 'frozen_failed'),
		);
		if (hasLiveInTarget) {
			for (const joinNodeId of collectImpactedDownstreamJoins(graph, targetNodeSet)) {
				if (!jurisdiction.nodeIds.has(joinNodeId)) {
					outOfScope.push(joinNodeId);
				}
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
	const recalledWavesByNode = new Map<string, Set<string>>();
	const recordRecalledBranchWave = (nodeId: string, waveId: string) => {
		let waves = recalledWavesByNode.get(nodeId);
		if (!waves) {
			waves = new Set<string>();
			recalledWavesByNode.set(nodeId, waves);
		}
		waves.add(waveId);
	};

	for (const [tid, tok] of Object.entries(ctx.tokens)) {
		if (!targetNodeSet.has(tok.nodeId)) {
			continue;
		}
		if (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_gate' || tok.status === 'waiting_join' || tok.status === 'frozen_failed') {
			// When recalling via `branchRootNodeId`, preserve uncontaminated sibling `waiting_join` arrivals
			// at a downstream join node (handled cleanly by join-barrier reconciliation below).
			if (tok.status === 'waiting_join' && params.branchRootNodeId && !explicitNodeSet.has(tok.nodeId) && tok.fromNodeId && !targetNodeSet.has(tok.fromNodeId)) {
				continue;
			}
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
			if (tok.status !== 'waiting_join' || explicitNodeSet.has(tok.nodeId) || !params.branchRootNodeId) {
				recomputeNodeState(ctx, tok.nodeId, 'idle');
				recordRecalledBranchWave(tok.nodeId, tok.waveId);
			} else if (tok.fromNodeId) {
				recordRecalledBranchWave(tok.fromNodeId, tok.waveId);
			}
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

	// Reconcile existing join barriers:
	// - If a join target itself was explicitly recalled (or has no uncontaminated sibling arrivals), clear the barrier
	//   AND record `(barrier.targetNodeId, barrier.waveId)` so any nested downstream join barrier is marked skipped.
	// - If reached only via branchRootNodeId while an unrelated sibling already arrived at the join, preserve the sibling arrival.
	// - Purge any stale arrivals from recalled upstream nodes and record their (fromId, waveId) so downstream joins mark them skipped.
	for (const [bKey, barrier] of Object.entries(ctx.joinBarriers)) {
		const siblingArrivals = Object.entries(barrier.arrivedByFrom).filter(([fromId]) => !targetNodeSet.has(fromId));
		const explicitlyRecalledJoin = explicitNodeSet.has(barrier.targetNodeId) || (!params.branchRootNodeId && targetNodeSet.has(barrier.targetNodeId));
		if (targetNodeSet.has(barrier.targetNodeId) && (explicitlyRecalledJoin || siblingArrivals.length === 0)) {
			for (const arrivedTok of Object.values(barrier.arrivedByFrom)) {
				if (!recalledTokenIds.includes(arrivedTok.id)) {
					recalledTokenIds.push(arrivedTok.id);
				}
				if (ctx.tokens[arrivedTok.id]) {
					ctx.tokens[arrivedTok.id] = { ...ctx.tokens[arrivedTok.id], status: 'recalled', lastActivityAt: now };
				}
			}
			affectedNodeIds.add(barrier.targetNodeId);
			recordRecalledBranchWave(barrier.targetNodeId, barrier.waveId);
			delete ctx.joinBarriers[bKey];
			recomputeNodeState(ctx, barrier.targetNodeId, 'idle');
			continue;
		}
		let cleaned = false;
		const nextArrived: Record<string, IMissionToken> = {};
		for (const [fromId, arrivedTok] of Object.entries(barrier.arrivedByFrom)) {
			if (targetNodeSet.has(fromId)) {
				cleaned = true;
				if (!recalledTokenIds.includes(arrivedTok.id)) {
					recalledTokenIds.push(arrivedTok.id);
				}
				affectedNodeIds.add(fromId);
				recordRecalledBranchWave(fromId, barrier.waveId);
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
			if (Object.keys(nextArrived).length === 0 && ctx.nodeStates[barrier.targetNodeId] === 'waiting_join') {
				ctx.nodeStates[barrier.targetNodeId] = 'idle';
			}
		}
	}

	// Anti-deadlock for single-branch recall: propagate skip marks from every recalled branch into downstream join barriers
	// so surviving parallel sibling branches never deadlock forever waiting on a recalled branch.
	for (const [recalledNodeId, waveIds] of recalledWavesByNode.entries()) {
		for (const waveId of waveIds) {
			for (const outEdge of getOutgoingEdges(graph, recalledNodeId)) {
				markBranchSkipped(state.missionId, ctx, graph, waveId, recalledNodeId, outEdge.to, now);
			}
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
			if (state.nodeStates[e.from] !== 'completed') {
				touchedExisting.add(e.from);
			}
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
		if (ctx.nodeTelemetry) {
			delete ctx.nodeTelemetry[rid];
		}
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

	// 2. Initialize newly added nodes and register any newly added source nodes into active waves feeding open barriers
	for (const aid of addedNodes) {
		ctx.nodeStates[aid] = 'idle';
	}
	if (addedNodes.length > 0 && Object.keys(ctx.joinBarriers).length > 0) {
		const newSources = addedNodes.filter(aid => (newInDeg.get(aid) ?? 0) === 0 && !ctx.triggers.some(tr => tr.enabled && tr.nodeId === aid));
		for (const srcId of newSources) {
			const reachableFromSrc = collectReachableNodes(nextGraph, [srcId]);
			for (const barrier of Object.values(ctx.joinBarriers)) {
				if (reachableFromSrc.has(barrier.targetNodeId)) {
					const roots = ctx.waveRoots[barrier.waveId] ?? [];
					if (!roots.includes(srcId)) {
						ctx.waveRoots[barrier.waveId] = [...roots, srcId];
					}
				}
			}
		}
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

	// 4. Kick off newly added OR newly reconnected ready nodes (both while running and queued while paused),
	//    and replay already-completed upstream arrivals into newly added/rewired multi-branch joins so they never deadlock!
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
				t.nodeId === cid && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed'),
			);
			if (hasLiveOnNode) {
				continue;
			}
			const incoming = getIncomingEdges(nextGraph, cid);
			const isNewUntriggeredSource = incoming.length === 0 && addedNodeSet.has(cid) && !ctx.triggers.some(tr => tr.enabled && tr.nodeId === cid);
			if (isNewUntriggeredSource) {
				if (Object.values(ctx.joinBarriers).some(b => b.targetNodeId === cid)) {
					continue;
				}
				const reachableFromNewSrc = collectReachableNodes(nextGraph, [cid]);
				const feedingBarrier = Object.values(ctx.joinBarriers).find(b => reachableFromNewSrc.has(b.targetNodeId));
				let targetWaveId = feedingBarrier?.waveId ?? latestRemovedTok?.waveId;
				if (!targetWaveId) {
					ctx.waveSeq += 1;
					targetWaveId = `wave-${ctx.waveSeq}`;
				}
				const existingRoots = ctx.waveRoots[targetWaveId] ?? [];
				if (!existingRoots.includes(cid)) {
					ctx.waveRoots[targetWaveId] = [...existingRoots, cid];
				}
				const summaryText = params.reason
					? (latestRemovedTok?.lastSummary ? `[Patched Route: ${params.reason}] ${latestRemovedTok.lastSummary}` : `[Patched Route] ${params.reason}`)
					: (latestRemovedTok?.lastSummary || 'Patched replacement route activated.');
				const ptr = appendTrace(ctx, {
					parentPtrs: latestRemovedTok ? [latestRemovedTok.tracePtr] : [],
					nodeId: cid,
					employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
					waveId: targetWaveId,
					event: 'mint',
					summary: params.reason ? `Patched recovery path: ${params.reason}` : 'Patched recovery step started',
					timestamp: now,
				});
				materializeAndDispatchToken(state.missionId, ctx, nextGraph, {
					targetNodeId: cid,
					waveId: targetWaveId,
					lastSummary: summaryText,
					compressedHistory: latestRemovedTok?.compressedHistory ?? '',
					historyState: latestRemovedTok?.historyState,
					tracePtr: ptr,
					now,
				});
				continue;
			}

			// Replay already-completed upstream edges into `cid` (handles single-input kickoffs, multi-input all-completed merges,
			// AND partially-completed new/rewired join nodes whose remaining sibling branches are still in flight!).
			const allSuccessIncoming = incoming.filter(e => getMissionEdgeKind(e) === 'success');
			const completedSuccessEdges = allSuccessIncoming.filter(e => ctx.nodeStates[e.from] === 'completed');
			const completedFailEdges = incoming.filter(e => getMissionEdgeKind(e) === 'fail' && ctx.nodeStates[e.from] === 'completed');
			if (completedSuccessEdges.length === 0) {
				continue;
			}
			const existingBarrier = Object.values(ctx.joinBarriers).find(b => b.targetNodeId === cid);
			const edgesToReplay = existingBarrier
				? completedSuccessEdges.filter(e => !existingBarrier.arrivedByFrom[e.from])
				: completedSuccessEdges;
			if (edgesToReplay.length === 0) {
				continue;
			}

			const resolveUpstreamInfo = (fromNodeId: string) => {
				const upTok = findLatestCompletedTokenForNode(fromNodeId);
				const anchorTok = upTok ?? latestRemovedTok;
				const latestCompleteTrace = upTok
					? Object.values(ctx.traces)
						.filter(tr => tr.nodeId === upTok.nodeId && tr.waveId === upTok.waveId && tr.event === 'complete')
						.sort((a, b) => b.timestamp - a.timestamp)[0]
					: undefined;
				const inheritedSummary = latestCompleteTrace?.summary
					|| upTok?.lastSummary
					|| anchorTok?.lastSummary
					|| 'Patched replacement route activated.';
				const inheritedHistory = upTok
					? compressTokenHistoryState(upTok.historyState, upTok.compressedHistory, upTok.lastSummary, upTok.fromNodeId)
					: { text: anchorTok?.compressedHistory ?? '', state: anchorTok?.historyState };
				return { upTok, anchorTok, inheritedSummary, inheritedHistory };
			};

			// Determine canonical waveId across replayed completed edges
			const firstUpstreamTok = edgesToReplay
				.map(e => findLatestCompletedTokenForNode(e.from))
				.filter((t): t is IMissionToken => Boolean(t))
				.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
			let targetWaveId = existingBarrier?.waveId ?? firstUpstreamTok?.waveId ?? latestRemovedTok?.waveId;
			if (!targetWaveId) {
				ctx.waveSeq += 1;
				targetWaveId = `wave-${ctx.waveSeq}`;
			}
			// Mark untaken fail edges from already-completed predecessors skipped in this wave
			for (const fEdge of completedFailEdges) {
				markBranchSkipped(state.missionId, ctx, nextGraph, targetWaveId, fEdge.from, cid, now);
			}

			// When ALL incoming success branches are already completed (multi-inDegree patch merge),
			// merge EVERY completed upstream summary, rolling history, and trace pointer into one unified join token
			// instead of losing sibling branch context across waves.
			if (!existingBarrier && edgesToReplay.length > 1 && completedSuccessEdges.length === allSuccessIncoming.length) {
				const infos = edgesToReplay.map(edge => ({ edge, ...resolveUpstreamInfo(edge.from) }));
				const mergedSummaryBody = infos
					.map(info => `[${info.edge.from}] ${info.inheritedSummary}`.trim())
					.join('\n');
				const mergedSummary = params.reason
					? `[Patched Route: ${params.reason}]\n${mergedSummaryBody}`
					: mergedSummaryBody;
				const mergedHistory = mergeRollingHistoryStates(
					infos.map(info => ({
						compressedHistory: info.inheritedHistory.text,
						historyState: info.inheritedHistory.state,
					})),
				);
				const parentPtrs = [...new Set(infos.map(info => info.anchorTok?.tracePtr).filter((p): p is string => Boolean(p)))];
				const mergePtr = appendTrace(ctx, {
					parentPtrs,
					nodeId: cid,
					employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
					waveId: targetWaveId,
					event: 'join',
					summary: params.reason
						? `Patched merge (${infos.map(i => i.edge.from).join(', ')}): ${params.reason}`
						: `Patched merge of ${infos.length} completed branch(es): ${infos.map(i => i.edge.from).join(', ')}`,
					timestamp: now,
				});
				deliverTokenToTarget(state.missionId, ctx, nextGraph, {
					targetNodeId: cid,
					fromNodeId: infos[infos.length - 1].edge.from,
					waveId: targetWaveId,
					lastSummary: mergedSummary,
					compressedHistory: mergedHistory.text,
					historyState: mergedHistory.state,
					tracePtr: mergePtr,
					now,
					bypassJoin: true,
				});
				continue;
			}

			// Ensure waveRoots[targetWaveId] covers every replayed predecessor so partial multi-branch joins park cleanly.
			const curRoots = ctx.waveRoots[targetWaveId] ?? [];
			const nextRoots = [...curRoots];
			for (const edge of edgesToReplay) {
				const upTok = findLatestCompletedTokenForNode(edge.from);
				const upRoots = upTok ? (ctx.waveRoots[upTok.waveId] ?? [edge.from]) : [edge.from];
				for (const r of upRoots) {
					if (!nextRoots.includes(r)) {
						nextRoots.push(r);
					}
				}
			}
			if (nextRoots.length > curRoots.length) {
				ctx.waveRoots[targetWaveId] = nextRoots;
			}

			for (const edge of edgesToReplay) {
				const { anchorTok, inheritedSummary, inheritedHistory } = resolveUpstreamInfo(edge.from);
				const summaryText = params.reason
					? `[Patched Route: ${params.reason}] ${inheritedSummary}`
					: inheritedSummary;
				const ptr = appendTrace(ctx, {
					parentPtrs: anchorTok ? [anchorTok.tracePtr] : [],
					nodeId: cid,
					employeeId: ctx.boundary.nodeAssignments[cid]?.agentId,
					waveId: targetWaveId,
					event: 'mint',
					summary: params.reason ? `Patched recovery path: ${params.reason}` : 'Patched recovery step started',
					timestamp: now,
				});
				deliverTokenToTarget(state.missionId, ctx, nextGraph, {
					targetNodeId: cid,
					fromNodeId: edge.from,
					waveId: targetWaveId,
					lastSummary: summaryText,
					compressedHistory: inheritedHistory.text,
					historyState: inheritedHistory.state,
					tracePtr: ptr,
					now,
				});
			}
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
