/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	IAdeEngineeringTreeSnapshot,
	IAdeRoleModelConfig,
	IAdeTokenUsage,
} from './adeEngineering.js';
import { normalizeBlueprintEngine } from './adeEngineeringBlueprint.js';

export interface IAdeModelPricingRate {
	readonly label: string;
	/** USD per 1,000,000 uncached input tokens. */
	readonly inputPerMTok: number;
	/** USD per 1,000,000 output tokens. */
	readonly outputPerMTok: number;
	/** USD per 1,000,000 prompt-cache read tokens. */
	readonly cacheReadPerMTok: number;
	/** USD per 1,000,000 prompt-cache write tokens. */
	readonly cacheWritePerMTok: number;
}

const MODEL_PRICING_RULES: readonly { readonly match: RegExp; readonly rate: IAdeModelPricingRate }[] = [
	// Anthropic Claude family
	{ match: /opus/i, rate: { label: 'Claude Opus', inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 } },
	{ match: /haiku/i, rate: { label: 'Claude Haiku', inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 } },
	{ match: /sonnet|claude/i, rate: { label: 'Claude Sonnet', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } },
	// OpenAI / Codex family
	{ match: /\bo3-mini\b|\bo4-mini\b|\bmini\b/i, rate: { label: 'OpenAI Mini', inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275, cacheWritePerMTok: 1.1 } },
	{ match: /\bo3\b|\bo1\b/i, rate: { label: 'OpenAI Reasoning', inputPerMTok: 10, outputPerMTok: 40, cacheReadPerMTok: 2.5, cacheWritePerMTok: 10 } },
	{ match: /gpt-5|gpt-4\.1|codex/i, rate: { label: 'OpenAI Codex', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 } },
	// Google Gemini / Antigravity family
	{ match: /flash/i, rate: { label: 'Gemini Flash', inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.3 } },
	{ match: /gemini|pro/i, rate: { label: 'Gemini Pro', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31, cacheWritePerMTok: 1.25 } },
	// DeepSeek family
	{ match: /r1|reasoner/i, rate: { label: 'DeepSeek Reasoner', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14, cacheWritePerMTok: 0.55 } },
	{ match: /deepseek|dsh|v3/i, rate: { label: 'DeepSeek Chat', inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07, cacheWritePerMTok: 0.27 } },
	// Qwen family
	{ match: /qwen/i, rate: { label: 'Qwen Coder', inputPerMTok: 0.4, outputPerMTok: 1.2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 0.4 } },
];

const ENGINE_DEFAULT_PRICING: Readonly<Record<string, IAdeModelPricingRate>> = {
	'claude-code': { label: 'Claude Code', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
	codex: { label: 'Codex', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
	antigravity: { label: 'Antigravity', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31, cacheWritePerMTok: 1.25 },
	dsh: { label: 'DeepSeek Harness', inputPerMTok: 0.55, outputPerMTok: 2.19, cacheReadPerMTok: 0.14, cacheWritePerMTok: 0.55 },
	opencode: { label: 'OpenCode', inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 0.3, cacheWritePerMTok: 2.5 },
	kilo: { label: 'Kilo Code', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
	cline: { label: 'Cline', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
	pi: { label: 'Pi', inputPerMTok: 1.5, outputPerMTok: 6, cacheReadPerMTok: 0.2, cacheWritePerMTok: 1.5 },
};

const FALLBACK_PRICING: IAdeModelPricingRate = {
	label: 'Standard LLM',
	inputPerMTok: 2.5,
	outputPerMTok: 10,
	cacheReadPerMTok: 0.3,
	cacheWritePerMTok: 2.5,
};

export function resolveModelPricing(roleConfig?: Pick<IAdeRoleModelConfig, 'engine' | 'model'>): IAdeModelPricingRate {
	const model = roleConfig?.model?.trim();
	if (model) {
		for (const rule of MODEL_PRICING_RULES) {
			if (rule.match.test(model)) {
				return rule.rate;
			}
		}
	}
	const engine = roleConfig?.engine ? normalizeBlueprintEngine(roleConfig.engine) : undefined;
	if (engine && ENGINE_DEFAULT_PRICING[engine]) {
		return ENGINE_DEFAULT_PRICING[engine];
	}
	return FALLBACK_PRICING;
}

/**
 * Computes the USD cost of a token usage bucket.
 * Honors explicit `usage.costUsd` reported directly by an engine; otherwise estimates from model pricing.
 */
export function estimateTokenUsageCostUsd(
	usage: IAdeTokenUsage | undefined,
	roleConfig?: Pick<IAdeRoleModelConfig, 'engine' | 'model'>,
): number {
	if (!usage) {
		return 0;
	}
	if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd > 0) {
		return Math.round(usage.costUsd * 1_000_000) / 1_000_000;
	}
	if (usage.totalTokens <= 0) {
		return 0;
	}
	const rate = resolveModelPricing(roleConfig);
	const structuredTotal = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	let cost: number;
	if (structuredTotal > 0) {
		cost = (
			usage.inputTokens * rate.inputPerMTok
			+ usage.outputTokens * rate.outputPerMTok
			+ usage.cacheReadTokens * rate.cacheReadPerMTok
			+ usage.cacheWriteTokens * rate.cacheWritePerMTok
		) / 1_000_000;
	} else {
		// Fallback split when only totalTokens is provided (75% input / 25% output)
		cost = (usage.totalTokens * 0.75 * rate.inputPerMTok + usage.totalTokens * 0.25 * rate.outputPerMTok) / 1_000_000;
	}
	return Math.round(Math.max(0, cost) * 1_000_000) / 1_000_000;
}

/**
 * Estimates USD saved by prompt caching relative to paying full uncached input token rates.
 */
export function estimateCacheSavingsUsd(
	usage: IAdeTokenUsage | undefined,
	roleConfig?: Pick<IAdeRoleModelConfig, 'engine' | 'model'>,
): number {
	if (!usage || usage.cacheReadTokens <= 0) {
		return 0;
	}
	const rate = resolveModelPricing(roleConfig);
	const savedPerMTok = Math.max(0, rate.inputPerMTok - rate.cacheReadPerMTok);
	return Math.round(((usage.cacheReadTokens * savedPerMTok) / 1_000_000) * 1_000_000) / 1_000_000;
}

export function formatUsdCost(usd: number): string {
	const val = Number.isFinite(usd) && usd > 0 ? usd : 0;
	if (val === 0) {
		return '$0.00';
	}
	if (val < 0.01) {
		return `$${val.toFixed(3)}`;
	}
	if (val < 100) {
		return `$${val.toFixed(2)}`;
	}
	return `$${val.toFixed(1)}`;
}

export type AdeBudgetStatus = 'none' | 'ok' | 'warn' | 'exceeded';

export interface IAdeTreeFinancialSummary {
	readonly totalCostUsd: number;
	readonly cacheSavingsUsd: number;
	readonly cacheHitRatePct: number;
	readonly costByTier: {
		readonly governor: number;
		readonly manager: number;
		readonly employee: number;
		readonly worker: number;
	};
	readonly costByNode: Readonly<Record<string, number>>;
	readonly costBySegment: Readonly<Record<string, number>>;
	readonly maxBudgetUsd?: number;
	readonly budgetUtilizationPct?: number;
	readonly budgetStatus: AdeBudgetStatus;
}

export function computeTreeFinancialSummary(
	snapshot: Pick<IAdeEngineeringTreeSnapshot, 'blueprint' | 'state' | 'tokenUsage'>,
): IAdeTreeFinancialSummary {
	const bp = snapshot.blueprint;
	const firstWorkerCfg = bp.nodes.find(n => n.worker)?.worker;
	const firstEmpCfg = bp.nodes.find(n => n.employee)?.employee;
	const firstMgrCfg = bp.managers[0]?.config;

	const costByNode: Record<string, number> = {};
	let workerSumFromNodes = 0;
	let empSumFromNodes = 0;
	let mgrSumFromNodes = 0;
	let savingsFromNodes = 0;

	const segmentByNode = new Map<string, IAdeRoleModelConfig>();
	for (const seg of bp.managers) {
		for (const nid of seg.nodeIds) {
			segmentByNode.set(nid, seg.config);
		}
	}

	for (const node of bp.nodes) {
		const rt = snapshot.state.nodes[node.id];
		if (!rt?.tokenUsage) {
			costByNode[node.id] = 0;
			continue;
		}
		const wCost = estimateTokenUsageCostUsd(rt.tokenUsage.worker, node.worker);
		const eCost = estimateTokenUsageCostUsd(rt.tokenUsage.employee, node.employee);
		const mCost = estimateTokenUsageCostUsd(rt.tokenUsage.manager, segmentByNode.get(node.id) ?? firstMgrCfg);
		const nTotal = Math.round((wCost + eCost + mCost) * 1_000_000) / 1_000_000;
		costByNode[node.id] = nTotal;
		workerSumFromNodes += wCost;
		empSumFromNodes += eCost;
		mgrSumFromNodes += mCost;
		savingsFromNodes += estimateCacheSavingsUsd(rt.tokenUsage.worker, node.worker)
			+ estimateCacheSavingsUsd(rt.tokenUsage.employee, node.employee)
			+ estimateCacheSavingsUsd(rt.tokenUsage.manager, segmentByNode.get(node.id) ?? firstMgrCfg);
	}

	const tu = snapshot.tokenUsage;
	const govCost = estimateTokenUsageCostUsd(tu.governor, firstMgrCfg ?? firstEmpCfg ?? firstWorkerCfg);
	const mgrCost = mgrSumFromNodes > 0 ? Math.round(mgrSumFromNodes * 1_000_000) / 1_000_000 : estimateTokenUsageCostUsd(tu.manager, firstMgrCfg);
	const empCost = empSumFromNodes > 0 ? Math.round(empSumFromNodes * 1_000_000) / 1_000_000 : estimateTokenUsageCostUsd(tu.employee, firstEmpCfg);
	const wrkCost = workerSumFromNodes > 0 ? Math.round(workerSumFromNodes * 1_000_000) / 1_000_000 : estimateTokenUsageCostUsd(tu.worker, firstWorkerCfg);

	const tierSum = Math.round((govCost + mgrCost + empCost + wrkCost) * 1_000_000) / 1_000_000;
	const explicitTotal = typeof tu.total.costUsd === 'number' && tu.total.costUsd > 0 ? tu.total.costUsd : 0;
	const totalCostUsd = Math.max(tierSum, explicitTotal);

	const govSavings = estimateCacheSavingsUsd(tu.governor, firstMgrCfg ?? firstWorkerCfg);
	const cacheSavingsUsd = Math.round((
		(savingsFromNodes > 0 ? savingsFromNodes : (
			estimateCacheSavingsUsd(tu.worker, firstWorkerCfg)
			+ estimateCacheSavingsUsd(tu.employee, firstEmpCfg)
			+ estimateCacheSavingsUsd(tu.manager, firstMgrCfg)
		)) + govSavings
	) * 1_000_000) / 1_000_000;

	const inputDenominator = tu.total.inputTokens + tu.total.cacheReadTokens;
	const cacheHitRatePct = inputDenominator > 0 ? Math.round((tu.total.cacheReadTokens / inputDenominator) * 100) : 0;

	const costBySegment: Record<string, number> = {};
	for (const seg of bp.managers) {
		let sum = 0;
		for (const nid of seg.nodeIds) {
			sum += costByNode[nid] ?? 0;
		}
		costBySegment[seg.segmentId] = Math.round(sum * 1_000_000) / 1_000_000;
	}

	const rawCap = bp.metadata.maxBudgetUsd;
	const maxBudgetUsd = typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0 ? rawCap : undefined;
	let budgetUtilizationPct: number | undefined;
	let budgetStatus: AdeBudgetStatus = 'none';
	if (maxBudgetUsd !== undefined) {
		budgetUtilizationPct = Math.round((totalCostUsd / maxBudgetUsd) * 100);
		if (totalCostUsd >= maxBudgetUsd) {
			budgetStatus = 'exceeded';
		} else if (totalCostUsd >= maxBudgetUsd * 0.8) {
			budgetStatus = 'warn';
		} else {
			budgetStatus = 'ok';
		}
	}

	return {
		totalCostUsd,
		cacheSavingsUsd,
		cacheHitRatePct,
		costByTier: {
			governor: govCost,
			manager: mgrCost,
			employee: empCost,
			worker: wrkCost,
		},
		costByNode,
		costBySegment,
		...(maxBudgetUsd !== undefined ? { maxBudgetUsd, budgetUtilizationPct } : {}),
		budgetStatus,
	};
}
