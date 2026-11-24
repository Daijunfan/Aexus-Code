/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IMissionDagParseResult, parseMissionMermaidDag } from './adeMissionDag.js';
import {
	AdeModelPricingOverrides,
	estimateTokenCostUsd,
	normalizeNonCachedInputTokens,
	resolveModelContextWindowTokens,
	resolveModelTokenPricingRate,
} from './adeModelPricing.js';
import type {
	IMissionDagRevision,
	IMissionFinOpsBucket,
	IMissionFinOpsNodeSpend,
	IMissionFinOpsSummary,
	IMissionHistoryEntry,
	IMissionRollingHistoryState,
	IMissionRuntimeState,
	IMissionToken,
	IMissionTraceNode,
	MissionHistoryEntryKind,
	MissionNodeRuntimeStatus,
	MissionReworkNoiseReason,
} from './adeMissionEngine.js';

const MAX_COMPRESSED_HISTORY_CHARS = 1200;
const MAX_SINGLE_HOP_DIGEST_CHARS = 220;
const COMPACT_HOP_DIGEST_CHARS = 128;
export const SYNTHETIC_START_SUMMARY = 'Mission started — begin execution of this step.';

export const DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS = 200_000;
export const MAX_SILENCE_NUDGES_BEFORE_ESCALATE = 3;

export function inferModelContextWindowTokens(
	model?: string,
	options?: {
		readonly engineId?: string;
		readonly overrides?: AdeModelPricingOverrides;
	},
): number {
	return resolveModelContextWindowTokens(model, options?.engineId, options?.overrides);
}

export function estimateNoiseDiagnosticTokens(text: string | undefined): number {
	const trimmed = text?.trim() ?? '';
	if (!trimmed) {
		return 0;
	}
	let cjk = 0;
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (
			(code >= 0x3000 && code <= 0x9FFF)
			|| (code >= 0xAC00 && code <= 0xD7AF)
			|| (code >= 0xF900 && code <= 0xFAFF)
		) {
			cjk++;
		}
	}
	return Math.max(120, Math.min(4_000, Math.ceil(cjk * 1.15 + (trimmed.length - cjk) / 4)));
}

export interface IMissionNodeTelemetry {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly totalTokens: number;
	readonly costUsd: number;
	/** True when any portion of this node's accumulated costUsd was estimated via token rates instead of direct CLI billing. */
	readonly costEstimated?: boolean;
	/** True when this node is accounted as a local / self-hosted zero-cost model ($0.00). */
	readonly costLocalFree?: boolean;
	/** Accumulated USD portion estimated from token rates (tracks mixed real + estimated turns cleanly). */
	readonly estimatedCostUsd?: number;
	/**
	 * Temporary estimated USD accumulated during mid-turn streaming ticks (`turns === 0`).
	 * Reconciled (subtracted) when a turn completes with a real provider-reported `costUsd`, avoiding double-counting.
	 */
	readonly pendingInterimEstimatedCostUsd?: number;
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
	/** Active rework/error trigger that automatically attributes subsequent node turns into crimson rework noise until resolved or distilled. */
	readonly pendingNoiseReason?: MissionReworkNoiseReason;
	/** Count of turns attributed to rework/error noise on this node. */
	readonly noiseTurns?: number;
	readonly model?: string;
	readonly engineId?: string;
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
	readonly engineId?: string;
	readonly summary?: string;
	readonly contextWindowMax?: number;
	/** Measured system/role initialization context tokens (gray segment of 4-color bar). */
	readonly contextInitTokens?: number;
	/** Measured tier/mission contract & pre-prompt context tokens (blue segment of 4-color bar). */
	readonly contextTierDocTokens?: number;
	readonly isNoiseTurn?: boolean;
	/** True when one or more tool/command/build failures occurred during this turn (automatically flags rework noise). */
	readonly hadToolError?: boolean;
	/** Number of tool/command failures observed during this turn. */
	readonly toolErrorCount?: number;
	/** Immutable turn identifier bound at dispatch/interactive start for exact node billing attribution. */
	readonly turnId?: string;
	/** Optional token identifier associated with this turn for deterministic fallback attribution. */
	readonly tokenId?: string;
	readonly timestamp?: number;
}

export interface IMissionTurnUsagePricingOptions {
	readonly overrides?: AdeModelPricingOverrides;
	readonly fallbackModel?: string;
	readonly fallbackEngineId?: string;
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

export function computeMissionNodeContextBreakdown(
	telemetry: IMissionNodeTelemetry | undefined,
	fallbackMaxTokens?: number,
): IMissionNodeContextBreakdown {
	const effectiveFallback = typeof fallbackMaxTokens === 'number' && Number.isFinite(fallbackMaxTokens) && fallbackMaxTokens > 0
		? Math.round(fallbackMaxTokens)
		: DEFAULT_MISSION_CONTEXT_WINDOW_TOKENS;
	const maxTokens = Math.max(1, telemetry?.contextWindowMax || effectiveFallback);
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
	const safePos = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
	const rawInit = safePos(telemetry.contextInitTokens);
	const rawTier = safePos(telemetry.contextTierDocTokens);
	const rawSource = safePos(telemetry.contextSourceTokens);
	const rawNoise = safePos(telemetry.contextNoiseTokens);
	const segmentedSum = rawInit + rawTier + rawSource + rawNoise;
	const fallbackUsed = safePos(telemetry.inputTokens) + safePos(telemetry.cacheReadTokens) + safePos(telemetry.outputTokens);
	const usedTokens = segmentedSum > 0 ? segmentedSum : Math.min(maxTokens, fallbackUsed);
	const initTokens = segmentedSum > 0 ? rawInit : Math.round(usedTokens * 0.12);
	const tierTokens = segmentedSum > 0 ? rawTier : Math.round(usedTokens * 0.22);
	const noiseTokens = segmentedSum > 0 ? rawNoise : 0;
	const sourceTokens = segmentedSum > 0
		? rawSource
		: Math.max(0, usedTokens - initTokens - tierTokens - noiseTokens);

	const usedPct = Math.min(100, Math.round((usedTokens / maxTokens) * 100));
	const segTotal = initTokens + tierTokens + sourceTokens + noiseTokens;
	const segDenom = Math.max(maxTokens, segTotal);
	const toPct = (v: number) => Math.max(0, Math.min(100, (v / segDenom) * 100));
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

function roundCostUsd(value: number): number {
	return Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 1_000_000) / 1_000_000;
}

function roundSignedCostUsd(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	const rounded = Math.round(value * 1_000_000) / 1_000_000;
	return rounded === 0 ? 0 : rounded;
}

export function recordMissionNodeTurnUsage(
	state: IMissionRuntimeState,
	nodeId: string,
	usage: IMissionTurnUsageInput,
	pricingOptions?: IMissionTurnUsagePricingOptions,
): IMissionRuntimeState {
	const prev = state.nodeTelemetry?.[nodeId];
	const now = usage.timestamp ?? Date.now();
	const effectiveModel = (usage.model?.trim() && usage.model.trim().toLowerCase() !== 'default' ? usage.model.trim() : undefined)
		|| prev?.model
		|| (pricingOptions?.fallbackModel?.trim() && pricingOptions.fallbackModel.trim().toLowerCase() !== 'default' ? pricingOptions.fallbackModel.trim() : undefined);
	const effectiveEngineId = usage.engineId?.trim() || prev?.engineId || pricingOptions?.fallbackEngineId?.trim();
	// Canonicalize OpenAI/Codex/Gemini/DeepSeek inclusive `inputTokens` to strictly non-cached input tokens
	// so `netNewTokens` (`contextSourceTokens`), `cacheSavingsPct`, and `estimateTokenCostUsd` never double-count cache hits!
	const normalizedUsage = normalizeNonCachedInputTokens({
		inputTokens: Math.max(0, Math.round(usage.inputTokens ?? 0)),
		outputTokens: Math.max(0, Math.round(usage.outputTokens ?? 0)),
		cacheReadTokens: Math.max(0, Math.round(usage.cacheReadTokens ?? 0)),
		cacheWriteTokens: Math.max(0, Math.round(usage.cacheWriteTokens ?? 0)),
		totalTokens: usage.totalTokens !== undefined ? Math.max(0, Math.round(usage.totalTokens)) : 0,
		model: effectiveModel,
		engineId: effectiveEngineId,
	});
	const addInput = normalizedUsage.inputTokens;
	const addOutput = normalizedUsage.outputTokens;
	const addCacheRead = normalizedUsage.cacheReadTokens;
	const addCacheWrite = normalizedUsage.cacheWriteTokens;
	const addTotal = usage.totalTokens !== undefined
		? Math.max(0, Math.round(usage.totalTokens))
		: normalizedUsage.totalTokens;
	const addTurns = Math.max(0, Math.round(usage.turns ?? 1));
	const inferredMax = inferModelContextWindowTokens(effectiveModel, {
		engineId: effectiveEngineId,
		overrides: pricingOptions?.overrides,
	});
	const contextWindowMax = Math.max(4_096, Math.round(usage.contextWindowMax ?? inferredMax));

	// Cost accounting with multi-engine fallback pricing & interim-to-real reconciliation:
	// - When an engine CLI reports a real USD bill (`usage.costUsd`), reconcile any temporary interim estimate
	//   accumulated during streaming ticks of this turn so spend is never double-counted.
	// - When an engine CLI only reports tokens (Codex, Kilo/OpenCode without cost, ACP/Antigravity/Cline/DSH, Pi),
	//   convert tokens to USD via the unified pricing catalog + user overrides, marking `costEstimated` (or `costLocalFree`).
	const prevCost = Math.max(0, Number.isFinite(prev?.costUsd ?? 0) ? (prev?.costUsd ?? 0) : 0);
	const prevEstimatedCost = Math.max(
		0,
		Number.isFinite(prev?.estimatedCostUsd ?? NaN)
			? (prev!.estimatedCostUsd!)
			: (prev?.costEstimated ? prevCost : 0),
	);
	const prevPendingInterim = Math.max(0, Number.isFinite(prev?.pendingInterimEstimatedCostUsd ?? 0) ? (prev?.pendingInterimEstimatedCostUsd ?? 0) : 0);
	const hasBillableTokens = addInput > 0 || addOutput > 0 || addCacheRead > 0 || addCacheWrite > 0;
	const rawProviderCostUsd = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
		? usage.costUsd
		: undefined;
	const zeroCostRateCheck = rawProviderCostUsd === 0 && hasBillableTokens
		? resolveModelTokenPricingRate(effectiveModel, effectiveEngineId, pricingOptions?.overrides)
		: undefined;
	// Do NOT treat a placeholder `costUsd: 0` with billable tokens on a paid cloud model as an authoritative $0 invoice
	// (prevents zero-cost placeholders from wiping pending interim estimates and blinding FinOps budget breakers).
	const hasExplicitProviderCost = rawProviderCostUsd !== undefined
		&& (rawProviderCostUsd > 0 || !hasBillableTokens || Boolean(zeroCostRateCheck?.isLocalFree));

	let nextCostUsd = prevCost;
	let nextEstimatedCostUsd = prevEstimatedCost;
	let nextPendingInterim = prevPendingInterim;
	let nextCostLocalFree = Boolean(prev?.costLocalFree);

	if (hasExplicitProviderCost) {
		const realCost = Math.max(0, rawProviderCostUsd!);
		const shouldReconcilePending = prevPendingInterim > 0 && (addTurns > 0 || realCost > 0);
		const reconciledCostBase = shouldReconcilePending ? Math.max(0, prevCost - prevPendingInterim) : prevCost;
		const reconciledEstBase = shouldReconcilePending ? Math.max(0, prevEstimatedCost - prevPendingInterim) : prevEstimatedCost;
		nextCostUsd = roundCostUsd(reconciledCostBase + realCost);
		nextEstimatedCostUsd = roundCostUsd(reconciledEstBase);
		nextPendingInterim = shouldReconcilePending || addTurns > 0 ? 0 : prevPendingInterim;
		if (nextCostUsd > 0) {
			nextCostLocalFree = false;
		} else if (zeroCostRateCheck?.isLocalFree) {
			nextCostLocalFree = true;
		}
	} else if (hasBillableTokens) {
		const est = estimateTokenCostUsd({
			inputTokens: addInput,
			outputTokens: addOutput,
			cacheReadTokens: addCacheRead,
			cacheWriteTokens: addCacheWrite,
			totalTokens: addTotal,
			model: effectiveModel,
			engineId: effectiveEngineId,
			overrides: pricingOptions?.overrides,
		});
		if (est.isLocalFree) {
			nextCostLocalFree = nextCostUsd === 0;
			if (addTurns > 0) {
				nextPendingInterim = 0;
			}
		} else {
			nextCostUsd = roundCostUsd(prevCost + est.costUsd);
			nextEstimatedCostUsd = roundCostUsd(prevEstimatedCost + est.costUsd);
			nextCostLocalFree = false;
			nextPendingInterim = addTurns === 0 ? roundCostUsd(prevPendingInterim + est.costUsd) : 0;
		}
	} else if (addTurns > 0) {
		nextPendingInterim = 0;
	}
	const nextCostEstimated = nextEstimatedCostUsd > 0;

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
	// Automatically attribute rework/error turns into the crimson noise segment in production:
	// - Explicit `usage.isNoiseTurn` always wins (true or false).
	// - Otherwise, turns with tool/command failures (`hadToolError` / `toolErrorCount > 0`), active rework tokens
	//   (check failure bounce, Reviewer/Gate rejection, retry, watchdog nudge), or `pendingNoiseReason` automatically
	//   accumulate into `contextNoiseTokens` so the 4-color context heatbar visibly warns when distillation is needed.
	const activeNodeToken = Object.values(state.tokens).find(t =>
		t.nodeId === nodeId && (t.status === 'active' || t.status === 'blocked'),
	);
	const hasReworkToken = Boolean(
		activeNodeToken?.isRework
		|| (activeNodeToken?.checkFailureCount ?? 0) > 0
		|| (activeNodeToken?.nudgeCount ?? 0) > 0,
	);
	const hasToolError = Boolean(usage.hadToolError || (usage.toolErrorCount ?? 0) > 0);
	const effectiveIsNoiseTurn = usage.isNoiseTurn !== undefined
		? Boolean(usage.isNoiseTurn)
		: (hasToolError || hasReworkToken || Boolean(prev?.pendingNoiseReason));
	const nextNoiseReason: MissionReworkNoiseReason | undefined = hasToolError
		? 'tool_error'
		: (activeNodeToken?.reworkReason
			?? ((activeNodeToken?.checkFailureCount ?? 0) > 0 ? 'check_failed' : undefined)
			?? ((activeNodeToken?.nudgeCount ?? 0) > 0 ? 'watchdog_nudge' : undefined)
			?? prev?.pendingNoiseReason);

	const activeDelta = Math.max(0, rawActiveDelta - initGrowth - tierGrowth);
	const nextNoise = effectiveIsNoiseTurn ? Math.min(contextWindowMax, prevNoise + activeDelta) : prevNoise;
	const nextSource = effectiveIsNoiseTurn ? prevSource : Math.min(Math.max(0, contextWindowMax - nextInit - nextTier - nextNoise), prevSource + activeDelta);
	const nextNoiseTurns = (prev?.noiseTurns ?? 0) + (effectiveIsNoiseTurn && addTurns > 0 ? addTurns : 0);
	// Tool-error noise stays sticky only during the failing turn (clears on final turn completion unless token itself is in rework).
	const retainedPendingNoiseReason: MissionReworkNoiseReason | undefined = (nextNoiseReason === 'tool_error' && addTurns > 0 && !hasReworkToken)
		? undefined
		: (effectiveIsNoiseTurn ? nextNoiseReason : prev?.pendingNoiseReason);

	const nextEntry: IMissionNodeTelemetry = {
		inputTokens: (prev?.inputTokens ?? 0) + addInput,
		outputTokens: (prev?.outputTokens ?? 0) + addOutput,
		cacheReadTokens: (prev?.cacheReadTokens ?? 0) + addCacheRead,
		cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + addCacheWrite,
		totalTokens: (prev?.totalTokens ?? 0) + addTotal,
		costUsd: nextCostUsd,
		...(nextCostEstimated ? { costEstimated: true } : {}),
		...(nextCostLocalFree ? { costLocalFree: true } : {}),
		...(nextEstimatedCostUsd > 0 ? { estimatedCostUsd: nextEstimatedCostUsd } : {}),
		...(nextPendingInterim > 0 ? { pendingInterimEstimatedCostUsd: nextPendingInterim } : {}),
		turns: (prev?.turns ?? 0) + addTurns,
		contextWindowMax,
		contextInitTokens: nextInit,
		contextTierDocTokens: nextTier,
		contextSourceTokens: nextSource,
		contextNoiseTokens: nextNoise,
		...(retainedPendingNoiseReason ? { pendingNoiseReason: retainedPendingNoiseReason } : {}),
		...(nextNoiseTurns > 0 ? { noiseTurns: nextNoiseTurns } : {}),
		model: effectiveModel,
		...(effectiveEngineId ? { engineId: effectiveEngineId } : {}),
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
	totalCostUsd = roundCostUsd(totalCostUsd);
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
	return roundCostUsd(sum);
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
	let estimatedCostUsd = 0;
	let hasLocalFreeNodes = false;

	const nodeLabelMap = new Map(nodes.map(n => [n.id, n.label]));
	const tierAgg = new Map<number, { costUsd: number; tokens: number; nodeIds: Set<string>; hasEstimatedCost: boolean }>();
	const hostAgg = new Map<string, { costUsd: number; tokens: number; nodeIds: Set<string>; hasEstimatedCost: boolean }>();
	const nodeSpends: IMissionFinOpsNodeSpend[] = [];

	if (state?.nodeTelemetry) {
		for (const [nodeId, tel] of Object.entries(state.nodeTelemetry)) {
			const cost = Math.max(0, Number.isFinite(tel.costUsd) ? tel.costUsd : 0);
			const nodeEstCost = Math.max(
				0,
				Number.isFinite(tel.estimatedCostUsd ?? NaN)
					? tel.estimatedCostUsd!
					: (tel.costEstimated ? cost : 0),
			);
			const nodeEstimated = Boolean(tel.costEstimated || nodeEstCost > 0);
			const nodeLocalFree = Boolean(tel.costLocalFree);
			if (nodeLocalFree) {
				hasLocalFreeNodes = true;
			}
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
			estimatedCostUsd += nodeEstCost;

			const assign = state.boundary.nodeAssignments[nodeId];
			const tier = assign?.tier ?? 2;
			const hostAlias = hostByNodeId?.get(nodeId) ?? assign?.hostAlias ?? 'local';

			const tBucket = tierAgg.get(tier) ?? { costUsd: 0, tokens: 0, nodeIds: new Set<string>(), hasEstimatedCost: false };
			tBucket.costUsd += cost;
			tBucket.tokens += toks;
			tBucket.nodeIds.add(nodeId);
			if (nodeEstimated) {
				tBucket.hasEstimatedCost = true;
			}
			tierAgg.set(tier, tBucket);

			const hBucket = hostAgg.get(hostAlias) ?? { costUsd: 0, tokens: 0, nodeIds: new Set<string>(), hasEstimatedCost: false };
			hBucket.costUsd += cost;
			hBucket.tokens += toks;
			hBucket.nodeIds.add(nodeId);
			if (nodeEstimated) {
				hBucket.hasEstimatedCost = true;
			}
			hostAgg.set(hostAlias, hBucket);

			if (cost > 0 || toks > 0) {
				nodeSpends.push({
					nodeId,
					label: nodeLabelMap.get(nodeId) ?? nodeId,
					costUsd: roundCostUsd(cost),
					tokens: toks,
					turns: tel.turns,
					hostAlias,
					tier,
					...(nodeEstimated ? { costEstimated: true } : {}),
					...(nodeLocalFree ? { costLocalFree: true } : {}),
				});
			}
		}
	}

	totalCostUsd = roundCostUsd(totalCostUsd);
	estimatedCostUsd = roundCostUsd(estimatedCostUsd);
	const hasEstimatedCost = estimatedCostUsd > 0;
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
			costUsd: roundCostUsd(b.costUsd),
			tokens: b.tokens,
			nodeCount: b.nodeIds.size,
			pct: Math.round(((totalCostUsd > 0 ? b.costUsd : b.tokens) / denomForPct) * 100),
			...(b.hasEstimatedCost ? { hasEstimatedCost: true } : {}),
		}));

	const byHost: IMissionFinOpsBucket[] = Array.from(hostAgg.entries())
		.sort((a, b) => (b[1].costUsd - a[1].costUsd) || (b[1].tokens - a[1].tokens))
		.map(([hostAlias, b]) => ({
			key: hostAlias,
			label: hostAlias === 'local' ? '@Local' : `@${hostAlias}`,
			costUsd: roundCostUsd(b.costUsd),
			tokens: b.tokens,
			nodeCount: b.nodeIds.size,
			pct: Math.round(((totalCostUsd > 0 ? b.costUsd : b.tokens) / denomForPct) * 100),
			...(b.hasEstimatedCost ? { hasEstimatedCost: true } : {}),
		}));

	nodeSpends.sort((a, b) => (b.costUsd - a.costUsd) || (b.tokens - a.tokens));

	return {
		totalTokens,
		totalInputTokens,
		totalOutputTokens,
		totalCacheReadTokens,
		totalCostUsd,
		estimatedCostUsd,
		hasEstimatedCost,
		...(hasLocalFreeNodes ? { hasLocalFreeNodes: true } : {}),
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

export interface IMissionRunNodeMetric {
	readonly nodeId: string;
	readonly label: string;
	readonly costUsd: number;
	readonly estimatedCostUsd?: number;
	readonly costEstimated?: boolean;
	readonly costLocalFree?: boolean;
	readonly totalTokens: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly turns: number;
	readonly durationMs?: number;
	readonly hostAlias: string;
	readonly tier: number;
	readonly model?: string;
	readonly engineId?: string;
	readonly finalStatus: MissionNodeRuntimeStatus;
}

export interface IMissionRunArchive {
	readonly runNumber: number;
	readonly runId: string;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly durationMs: number;
	readonly outcome: 'completed' | 'failed' | 'stopped';
	readonly totalCostUsd: number;
	readonly estimatedCostUsd: number;
	readonly hasEstimatedCost: boolean;
	readonly totalTokens: number;
	readonly cacheSavingsPct: number;
	readonly waveCount: number;
	readonly completedNodeCount: number;
	readonly failedNodeCount: number;
	readonly totalCheckFailures: number;
	readonly budgetLimitUsd?: number;
	readonly budgetCircuitTripped?: boolean;
	readonly dagRevision?: number;
	readonly nodeMetrics: readonly IMissionRunNodeMetric[];
}

export interface IMissionRunComparisonNodeDelta {
	readonly nodeId: string;
	readonly label: string;
	readonly currentCostUsd: number;
	readonly baselineCostUsd: number;
	readonly costDeltaUsd: number;
	readonly currentTokens: number;
	readonly baselineTokens: number;
	readonly tokensDelta: number;
	readonly currentDurationMs?: number;
	readonly baselineDurationMs?: number;
	readonly durationDeltaMs?: number;
}

export interface IMissionRunComparisonDelta {
	readonly currentRunNumber: number;
	readonly baselineRunNumber: number;
	readonly costDeltaUsd: number;
	readonly costDeltaPct?: number;
	readonly durationDeltaMs: number;
	readonly durationDeltaPct?: number;
	readonly tokensDelta: number;
	readonly tokensDeltaPct?: number;
	readonly cacheSavingsDeltaPct: number;
	readonly nodeDeltas: readonly IMissionRunComparisonNodeDelta[];
}

const MAX_STORED_REVISIONS = 30;
export const MAX_MISSION_RUN_HISTORY = 20;

export function buildMissionRunArchiveSnapshot(
	state: Pick<
		IMissionRuntimeState,
		| 'status'
		| 'startedAt'
		| 'completedAt'
		| 'updatedAt'
		| 'boundary'
		| 'nodeStates'
		| 'tokens'
		| 'nodeTelemetry'
		| 'waveRoots'
		| 'budgetLimitUsd'
		| 'budgetCircuitTripped'
		| 'revisions'
		| 'runSeq'
		| 'runHistory'
	>,
	nodes: readonly { readonly id: string; readonly label: string }[],
	options?: {
		readonly runNumber?: number;
		readonly hostByNodeId?: ReadonlyMap<string, string>;
		readonly now?: number;
		readonly outcomeOverride?: IMissionRunArchive['outcome'];
	},
): IMissionRunArchive {
	const now = options?.now ?? Date.now();
	const startedAt = state.startedAt ?? now;
	let latestActivityAt = startedAt;
	const nodeWindow = new Map<string, { firstAt: number; lastAt: number }>();
	const waveSet = new Set<string>(Object.keys(state.waveRoots ?? {}));
	let totalCheckFailures = 0;

	for (const tok of Object.values(state.tokens)) {
		if (tok.arrivedAt < startedAt && tok.lastActivityAt < startedAt) {
			continue;
		}
		if (tok.waveId) {
			waveSet.add(tok.waveId);
		}
		totalCheckFailures += tok.checkFailureCount ?? 0;
		const endAt = Math.max(tok.arrivedAt, tok.lastActivityAt);
		if (endAt > latestActivityAt) {
			latestActivityAt = endAt;
		}
		const prevWin = nodeWindow.get(tok.nodeId);
		if (!prevWin) {
			nodeWindow.set(tok.nodeId, { firstAt: tok.arrivedAt, lastAt: endAt });
		} else {
			if (tok.arrivedAt < prevWin.firstAt) {
				prevWin.firstAt = tok.arrivedAt;
			}
			if (endAt > prevWin.lastAt) {
				prevWin.lastAt = endAt;
			}
		}
	}
	for (const tel of Object.values(state.nodeTelemetry ?? {})) {
		if (typeof tel.updatedAt === 'number' && tel.updatedAt > latestActivityAt) {
			latestActivityAt = tel.updatedAt;
		}
	}

	const finishedAt = state.completedAt !== undefined && state.completedAt >= startedAt
		? state.completedAt
		: Math.max(startedAt, state.status === 'running' || state.status === 'paused' ? now : latestActivityAt);
	const durationMs = Math.max(0, finishedAt - startedAt);

	const summary = computeMissionFinOpsSummary(state as IMissionRuntimeState, nodes, options?.hostByNodeId);
	const nodeLabelMap = new Map(nodes.map(n => [n.id, n.label]));
	const nodeIdSet = new Set<string>([
		...Object.keys(state.nodeTelemetry ?? {}),
		...nodes.map(n => n.id).filter(id => state.nodeStates[id] && state.nodeStates[id] !== 'idle'),
	]);
	const nodeMetrics: IMissionRunNodeMetric[] = [];
	for (const nodeId of nodeIdSet) {
		const tel = state.nodeTelemetry?.[nodeId];
		const assign = state.boundary.nodeAssignments[nodeId];
		const win = nodeWindow.get(nodeId);
		const nodeDurationMs = win ? Math.max(0, win.lastAt - win.firstAt) : undefined;
		const finalStatus = state.nodeStates[nodeId] ?? 'idle';
		if (!tel && finalStatus === 'idle' && nodeDurationMs === undefined) {
			continue;
		}
		const costUsd = roundCostUsd(Math.max(0, Number.isFinite(tel?.costUsd ?? NaN) ? tel!.costUsd : 0));
		const estimatedCostUsd = tel?.estimatedCostUsd !== undefined && Number.isFinite(tel.estimatedCostUsd)
			? roundCostUsd(Math.max(0, tel.estimatedCostUsd))
			: (tel?.costEstimated ? costUsd : undefined);
		nodeMetrics.push({
			nodeId,
			label: nodeLabelMap.get(nodeId) ?? nodeId,
			costUsd,
			...(estimatedCostUsd !== undefined && estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
			...(tel?.costEstimated ? { costEstimated: true } : {}),
			...(tel?.costLocalFree ? { costLocalFree: true } : {}),
			totalTokens: Math.max(0, Number.isFinite(tel?.totalTokens ?? NaN) ? tel!.totalTokens : 0),
			inputTokens: Math.max(0, Number.isFinite(tel?.inputTokens ?? NaN) ? tel!.inputTokens : 0),
			outputTokens: Math.max(0, Number.isFinite(tel?.outputTokens ?? NaN) ? tel!.outputTokens : 0),
			cacheReadTokens: Math.max(0, Number.isFinite(tel?.cacheReadTokens ?? NaN) ? tel!.cacheReadTokens : 0),
			turns: tel?.turns ?? 0,
			...(nodeDurationMs !== undefined ? { durationMs: nodeDurationMs } : {}),
			hostAlias: options?.hostByNodeId?.get(nodeId) ?? assign?.hostAlias ?? 'local',
			tier: assign?.tier ?? 2,
			...(tel?.model ? { model: tel.model } : {}),
			...(tel?.engineId ? { engineId: tel.engineId } : {}),
			finalStatus,
		});
	}
	nodeMetrics.sort((a, b) => (b.costUsd - a.costUsd) || (b.totalTokens - a.totalTokens) || a.nodeId.localeCompare(b.nodeId));

	let completedNodeCount = 0;
	let failedNodeCount = 0;
	for (const status of Object.values(state.nodeStates)) {
		if (status === 'completed') {
			completedNodeCount += 1;
		} else if (status === 'failed') {
			failedNodeCount += 1;
		}
	}

	const outcome: IMissionRunArchive['outcome'] = options?.outcomeOverride
		?? (state.status === 'completed'
			? 'completed'
			: (state.status === 'failed' || failedNodeCount > 0 ? 'failed' : 'stopped'));
	const nextRunNumber = options?.runNumber ?? Math.max(1, state.runSeq ?? ((state.runHistory?.length ?? 0) + 1));
	const latestRev = state.revisions && state.revisions.length > 0
		? state.revisions[state.revisions.length - 1].version
		: undefined;

	return {
		runNumber: nextRunNumber,
		runId: `run-${nextRunNumber}-${startedAt}`,
		startedAt,
		finishedAt,
		durationMs,
		outcome,
		totalCostUsd: summary.totalCostUsd,
		estimatedCostUsd: summary.estimatedCostUsd,
		hasEstimatedCost: summary.hasEstimatedCost,
		totalTokens: summary.totalTokens,
		cacheSavingsPct: summary.cacheSavingsPct,
		waveCount: Math.max(waveSet.size, Object.keys(state.tokens).length > 0 ? 1 : 0),
		completedNodeCount,
		failedNodeCount,
		totalCheckFailures,
		...(state.budgetLimitUsd !== undefined ? { budgetLimitUsd: state.budgetLimitUsd } : {}),
		...(state.budgetCircuitTripped ? { budgetCircuitTripped: true } : {}),
		...(latestRev !== undefined ? { dagRevision: latestRev } : {}),
		nodeMetrics,
	};
}

export function compareMissionRuns(
	current: Pick<IMissionRunArchive, 'runNumber' | 'totalCostUsd' | 'durationMs' | 'totalTokens' | 'cacheSavingsPct' | 'nodeMetrics'>,
	baseline: Pick<IMissionRunArchive, 'runNumber' | 'totalCostUsd' | 'durationMs' | 'totalTokens' | 'cacheSavingsPct' | 'nodeMetrics'>,
): IMissionRunComparisonDelta {
	const costDeltaUsd = roundSignedCostUsd(current.totalCostUsd - baseline.totalCostUsd);
	const costDeltaPct = baseline.totalCostUsd > 0
		? Math.round(((current.totalCostUsd - baseline.totalCostUsd) / baseline.totalCostUsd) * 100)
		: undefined;
	const durationDeltaMs = current.durationMs - baseline.durationMs;
	const durationDeltaPct = baseline.durationMs > 0
		? Math.round(((current.durationMs - baseline.durationMs) / baseline.durationMs) * 100)
		: undefined;
	const tokensDelta = current.totalTokens - baseline.totalTokens;
	const tokensDeltaPct = baseline.totalTokens > 0
		? Math.round(((current.totalTokens - baseline.totalTokens) / baseline.totalTokens) * 100)
		: undefined;
	const cacheSavingsDeltaPct = current.cacheSavingsPct - baseline.cacheSavingsPct;

	const baseByNode = new Map(baseline.nodeMetrics.map(m => [m.nodeId, m]));
	const curByNode = new Map(current.nodeMetrics.map(m => [m.nodeId, m]));
	const allNodeIds = new Set<string>([...curByNode.keys(), ...baseByNode.keys()]);
	const nodeDeltas: IMissionRunComparisonNodeDelta[] = [];
	for (const nodeId of allNodeIds) {
		const cur = curByNode.get(nodeId);
		const base = baseByNode.get(nodeId);
		const curCost = cur?.costUsd ?? 0;
		const baseCost = base?.costUsd ?? 0;
		const curToks = cur?.totalTokens ?? 0;
		const baseToks = base?.totalTokens ?? 0;
		const durationDelta = cur?.durationMs !== undefined && base?.durationMs !== undefined
			? cur.durationMs - base.durationMs
			: undefined;
		nodeDeltas.push({
			nodeId,
			label: cur?.label ?? base?.label ?? nodeId,
			currentCostUsd: curCost,
			baselineCostUsd: baseCost,
			costDeltaUsd: roundSignedCostUsd(curCost - baseCost),
			currentTokens: curToks,
			baselineTokens: baseToks,
			tokensDelta: curToks - baseToks,
			...(cur?.durationMs !== undefined ? { currentDurationMs: cur.durationMs } : {}),
			...(base?.durationMs !== undefined ? { baselineDurationMs: base.durationMs } : {}),
			...(durationDelta !== undefined ? { durationDeltaMs: durationDelta } : {}),
		});
	}
	nodeDeltas.sort((a, b) => Math.abs(b.costDeltaUsd) - Math.abs(a.costDeltaUsd) || Math.abs(b.tokensDelta) - Math.abs(a.tokensDelta));

	return {
		currentRunNumber: current.runNumber,
		baselineRunNumber: baseline.runNumber,
		costDeltaUsd,
		...(costDeltaPct !== undefined ? { costDeltaPct } : {}),
		durationDeltaMs,
		...(durationDeltaPct !== undefined ? { durationDeltaPct } : {}),
		tokensDelta,
		...(tokensDeltaPct !== undefined ? { tokensDeltaPct } : {}),
		cacheSavingsDeltaPct,
		nodeDeltas,
	};
}

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
export function trimCleanlyToBudget(raw: string, maxChars: number): string {
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
export function compactSummaryToBudget(
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

