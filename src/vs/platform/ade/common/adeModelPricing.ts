/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const ADE_MODEL_PRICING_OVERRIDES_CONFIG_KEY = 'aexus.ade.finOps.modelPricingOverrides';

/**
 * Per-million-token USD pricing rates for a model.
 * All rates are in USD per 1,000,000 tokens.
 */
export interface IModelTokenPricingRate {
	/** USD per 1,000,000 non-cached input tokens. */
	readonly inputPerMillion: number;
	/** USD per 1,000,000 output tokens. */
	readonly outputPerMillion: number;
	/** USD per 1,000,000 cache-read input tokens. */
	readonly cacheReadPerMillion: number;
	/** USD per 1,000,000 cache-write / cache-creation input tokens. */
	readonly cacheWritePerMillion: number;
	/** When true, marks a self-hosted / local zero-cost model ($0.00). */
	readonly local?: boolean;
}

/**
 * User-configurable override entry in `aexus.ade.finOps.modelPricingOverrides`.
 * Partial rates inherit remaining cache rates from the matched built-in rate (or standard ratios).
 */
export interface IModelPricingOverrideEntry {
	readonly inputPerMillion?: number;
	readonly outputPerMillion?: number;
	readonly cacheReadPerMillion?: number;
	readonly cacheWritePerMillion?: number;
	/** Optional context window capacity override in tokens (e.g. 64000, 128000, 200000, 1000000). */
	readonly contextWindowTokens?: number;
	/** Mark this model or pattern as a local / self-hosted zero-cost model ($0.00). */
	readonly local?: boolean;
}

export type AdeModelPricingOverrides = Readonly<Record<string, IModelPricingOverrideEntry>>;

export type ModelPricingResolutionSource =
	| 'override'
	| 'override_local'
	| 'local_free'
	| 'catalog'
	| 'engine_default'
	| 'fallback';

export interface IResolvedModelPricing {
	readonly rate: IModelTokenPricingRate;
	readonly isLocalFree: boolean;
	readonly source: ModelPricingResolutionSource;
	readonly matchedPattern?: string;
}

export interface ITokenCostEstimateInput {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	/** Optional total token count used to detect OpenAI-style inclusive `inputTokens` containing `cacheReadTokens`. */
	readonly totalTokens?: number;
	readonly model?: string;
	readonly engineId?: string;
	readonly overrides?: AdeModelPricingOverrides;
}

export interface ITokenCostEstimateResult extends IResolvedModelPricing {
	readonly costUsd: number;
	/** True whenever a non-local model cost was computed from the pricing catalog / override rather than a provider bill. */
	readonly estimated: boolean;
}

export const ADE_MODEL_PRICING_OVERRIDES_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: {
		type: 'object',
		additionalProperties: false,
		properties: {
			inputPerMillion: {
				type: 'number',
				minimum: 0,
				description: 'USD per 1,000,000 non-cached input tokens.',
			},
			outputPerMillion: {
				type: 'number',
				minimum: 0,
				description: 'USD per 1,000,000 output tokens.',
			},
			cacheReadPerMillion: {
				type: 'number',
				minimum: 0,
				description: 'USD per 1,000,000 cache-read input tokens.',
			},
			cacheWritePerMillion: {
				type: 'number',
				minimum: 0,
				description: 'USD per 1,000,000 cache-write / cache-creation input tokens.',
			},
			contextWindowTokens: {
				type: 'integer',
				minimum: 4096,
				maximum: 10000000,
				description: 'Optional context window capacity in tokens (e.g. 64000, 128000, 200000, 1000000) used by the Mission context heatbar.',
			},
			local: {
				type: 'boolean',
				description: 'Set true to treat matching models as self-hosted / local zero-cost ($0.00).',
			},
		},
	},
} as const;

const ZERO_LOCAL_RATE: IModelTokenPricingRate = Object.freeze({
	inputPerMillion: 0,
	outputPerMillion: 0,
	cacheReadPerMillion: 0,
	cacheWritePerMillion: 0,
	local: true,
});

/**
 * Conservative cloud fallback rate when neither model nor engine matches any known pricing entry.
 * Prevents unknown paid cloud models from silently reporting $0.00 and bypassing budget circuit-breakers.
 */
export const DEFAULT_FALLBACK_CLOUD_RATE: IModelTokenPricingRate = Object.freeze({
	inputPerMillion: 2.0,
	outputPerMillion: 8.0,
	cacheReadPerMillion: 0.2,
	cacheWritePerMillion: 2.5,
});

/**
 * Default representative model per Aexus Agent engine used as fallback when an engine
 * emits token counts without reporting its active model ID.
 */
export const ADE_ENGINE_DEFAULT_PRICING_MODELS: Readonly<Record<string, string>> = Object.freeze({
	'aexus-claude': 'claude-opus-4-6',
	'claude': 'claude-opus-4-6',
	'aexus-codex': 'gpt-5.3-codex',
	'codex': 'gpt-5.3-codex',
	'aexus-kilo': 'claude-sonnet-4-6',
	'kilo': 'claude-sonnet-4-6',
	'aexus-opencode': 'qwen3-coder',
	'opencode': 'qwen3-coder',
	'aexus-dsh': 'deepseek-r1',
	'dsh': 'deepseek-r1',
	'aexus-antigravity': 'gemini-2.5-pro',
	'antigravity': 'gemini-2.5-pro',
	'aexus-cline': 'claude-sonnet-4-6',
	'cline': 'claude-sonnet-4-6',
	'aexus-pi': 'gpt-5.2',
	'pi': 'gpt-5.2',
});

interface IBuiltInPricingEntry {
	readonly pattern: string;
	readonly rate: IModelTokenPricingRate;
	/** True maximum context window capacity in tokens for this model family. */
	readonly contextWindowTokens: number;
}

function r(
	inputPerMillion: number,
	outputPerMillion: number,
	cacheReadPerMillion: number,
	cacheWritePerMillion: number,
): IModelTokenPricingRate {
	return Object.freeze({ inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion });
}

/**
 * Built-in multi-vendor model catalog (USD per 1,000,000 tokens + real context window capacity in tokens).
 * Matching sorts patterns by length descending so specific variants (e.g. `gpt-5-mini`,
 * `gemini-2.5-flash-lite`, `claude-opus-4-6`, `llama-3.3`) always win over broader families (`gpt-5`, `llama-3`).
 */
const BUILTIN_MODEL_PRICING_RAW: readonly IBuiltInPricingEntry[] = [
	// Anthropic Claude (200k standard; `[1m]` / `-1m` suffixes resolve to 1M)
	{ pattern: 'claude-opus-4-6', rate: r(5.0, 25.0, 0.5, 6.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus-4.6', rate: r(5.0, 25.0, 0.5, 6.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus-4-5', rate: r(5.0, 25.0, 0.5, 6.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus-4.5', rate: r(5.0, 25.0, 0.5, 6.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus-4-1', rate: r(15.0, 75.0, 1.5, 18.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus-4.1', rate: r(15.0, 75.0, 1.5, 18.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus-4', rate: r(15.0, 75.0, 1.5, 18.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-sonnet-4-6', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-sonnet-4.6', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-sonnet-4-5', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-sonnet-4.5', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-sonnet-4', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-3-7-sonnet', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-3.7-sonnet', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-3-5-sonnet', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-3.5-sonnet', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-haiku-4-5', rate: r(1.0, 5.0, 0.1, 1.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-haiku-4.5', rate: r(1.0, 5.0, 0.1, 1.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-3-5-haiku', rate: r(0.8, 4.0, 0.08, 1.0), contextWindowTokens: 200_000 },
	{ pattern: 'claude-3.5-haiku', rate: r(0.8, 4.0, 0.08, 1.0), contextWindowTokens: 200_000 },
	{ pattern: 'claude-opus', rate: r(5.0, 25.0, 0.5, 6.25), contextWindowTokens: 200_000 },
	{ pattern: 'claude-sonnet', rate: r(3.0, 15.0, 0.3, 3.75), contextWindowTokens: 200_000 },
	{ pattern: 'claude-haiku', rate: r(1.0, 5.0, 0.1, 1.25), contextWindowTokens: 200_000 },

	// OpenAI / Codex
	{ pattern: 'gpt-5.4-pro', rate: r(15.0, 120.0, 1.5, 15.0), contextWindowTokens: 1_000_000 },
	{ pattern: 'gpt-5-pro', rate: r(15.0, 120.0, 1.5, 15.0), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.4-mini', rate: r(0.75, 4.5, 0.075, 0.75), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.4-nano', rate: r(0.2, 1.25, 0.02, 0.2), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.4', rate: r(2.5, 15.0, 0.25, 2.5), contextWindowTokens: 1_000_000 },
	{ pattern: 'gpt-5.3-codex-spark', rate: r(0.5, 3.0, 0.05, 0.5), contextWindowTokens: 128_000 },
	{ pattern: 'gpt-5.3-codex', rate: r(1.75, 14.0, 0.175, 1.75), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.2-codex', rate: r(1.75, 14.0, 0.175, 1.75), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.2-pro', rate: r(15.0, 120.0, 1.5, 15.0), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.2', rate: r(1.75, 14.0, 0.175, 1.75), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.1-codex-mini', rate: r(0.25, 2.0, 0.025, 0.25), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.1-codex', rate: r(1.25, 10.0, 0.125, 1.25), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5.1', rate: r(1.25, 10.0, 0.125, 1.25), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5-codex', rate: r(1.25, 10.0, 0.125, 1.25), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5-mini', rate: r(0.25, 2.0, 0.025, 0.25), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5-nano', rate: r(0.05, 0.4, 0.005, 0.05), contextWindowTokens: 400_000 },
	{ pattern: 'gpt-5', rate: r(1.25, 10.0, 0.125, 1.25), contextWindowTokens: 400_000 },
	{ pattern: 'codex-mini', rate: r(1.5, 6.0, 0.375, 1.5), contextWindowTokens: 200_000 },
	{ pattern: 'gpt-4.1-mini', rate: r(0.4, 1.6, 0.1, 0.4), contextWindowTokens: 1_000_000 },
	{ pattern: 'gpt-4.1-nano', rate: r(0.1, 0.4, 0.025, 0.1), contextWindowTokens: 1_000_000 },
	{ pattern: 'gpt-4.1', rate: r(2.0, 8.0, 0.5, 2.0), contextWindowTokens: 1_000_000 },
	{ pattern: 'gpt-4o-mini', rate: r(0.15, 0.6, 0.075, 0.15), contextWindowTokens: 128_000 },
	{ pattern: 'gpt-4o', rate: r(2.5, 10.0, 1.25, 2.5), contextWindowTokens: 128_000 },
	{ pattern: 'gpt-4-turbo', rate: r(10.0, 30.0, 5.0, 10.0), contextWindowTokens: 128_000 },
	{ pattern: 'gpt-4-32k', rate: r(60.0, 120.0, 30.0, 60.0), contextWindowTokens: 32_768 },
	{ pattern: 'gpt-4', rate: r(30.0, 60.0, 15.0, 30.0), contextWindowTokens: 8_192 },
	{ pattern: 'gpt-3.5', rate: r(0.5, 1.5, 0.25, 0.5), contextWindowTokens: 16_384 },
	{ pattern: 'o3-pro', rate: r(20.0, 80.0, 5.0, 20.0), contextWindowTokens: 200_000 },
	{ pattern: 'o3-mini', rate: r(1.1, 4.4, 0.275, 1.1), contextWindowTokens: 200_000 },
	{ pattern: 'o4-mini', rate: r(1.1, 4.4, 0.275, 1.1), contextWindowTokens: 200_000 },
	{ pattern: 'o3', rate: r(2.0, 8.0, 0.5, 2.0), contextWindowTokens: 200_000 },
	{ pattern: 'o1-mini', rate: r(1.1, 4.4, 0.55, 1.1), contextWindowTokens: 128_000 },
	{ pattern: 'o1-preview', rate: r(15.0, 60.0, 7.5, 15.0), contextWindowTokens: 128_000 },
	{ pattern: 'o1', rate: r(15.0, 60.0, 7.5, 15.0), contextWindowTokens: 200_000 },

	// Google Gemini / Antigravity
	{ pattern: 'gemini-3.1-pro', rate: r(2.0, 12.0, 0.2, 2.0), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-3-pro', rate: r(2.0, 12.0, 0.2, 2.0), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-3-flash', rate: r(0.5, 3.0, 0.05, 0.5), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-3.0-flash', rate: r(0.5, 3.0, 0.05, 0.5), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-2.5-pro', rate: r(1.25, 10.0, 0.3125, 1.25), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-2.5-flash-lite', rate: r(0.1, 0.4, 0.025, 0.1), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-2.5-flash', rate: r(0.3, 2.5, 0.075, 0.3), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-2.0-flash-lite', rate: r(0.075, 0.3, 0.01875, 0.075), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-2.0-flash', rate: r(0.1, 0.4, 0.025, 0.1), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-1.5-pro', rate: r(1.25, 5.0, 0.3125, 1.25), contextWindowTokens: 2_000_000 },
	{ pattern: 'gemini-pro', rate: r(1.25, 10.0, 0.3125, 1.25), contextWindowTokens: 1_000_000 },
	{ pattern: 'gemini-flash', rate: r(0.3, 2.5, 0.075, 0.3), contextWindowTokens: 1_000_000 },

	// DeepSeek / DSH (64k/128k real windows; `[1m]` tags override to 1M)
	{ pattern: 'deepseek-reasoner', rate: r(0.55, 2.19, 0.14, 0.55), contextWindowTokens: 64_000 },
	{ pattern: 'deepseek-r1', rate: r(0.55, 2.19, 0.14, 0.55), contextWindowTokens: 64_000 },
	{ pattern: 'deepseek-v3.2', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 128_000 },
	{ pattern: 'deepseek-v3.1', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 128_000 },
	{ pattern: 'deepseek-v3', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 64_000 },
	{ pattern: 'deepseek-chat', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 64_000 },
	{ pattern: 'deepseek-coder-v2', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 128_000 },
	{ pattern: 'deepseek-coder', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 64_000 },
	{ pattern: 'deepseek-flash', rate: r(0.14, 0.56, 0.035, 0.14), contextWindowTokens: 128_000 },
	{ pattern: 'deepseek', rate: r(0.27, 1.1, 0.07, 0.27), contextWindowTokens: 64_000 },

	// Qwen / OpenCode
	{ pattern: 'qwen-long', rate: r(0.2, 0.8, 0.05, 0.2), contextWindowTokens: 1_000_000 },
	{ pattern: 'qwen3-coder', rate: r(0.3, 1.2, 0.06, 0.3), contextWindowTokens: 256_000 },
	{ pattern: 'qwen2.5-coder', rate: r(0.3, 1.2, 0.06, 0.3), contextWindowTokens: 128_000 },
	{ pattern: 'qwen-coder', rate: r(0.3, 1.2, 0.06, 0.3), contextWindowTokens: 128_000 },
	{ pattern: 'qwen3-max', rate: r(1.2, 6.0, 0.24, 1.2), contextWindowTokens: 256_000 },
	{ pattern: 'qwen-max', rate: r(1.2, 6.0, 0.24, 1.2), contextWindowTokens: 128_000 },
	{ pattern: 'qwen-plus', rate: r(0.4, 1.2, 0.08, 0.4), contextWindowTokens: 128_000 },
	{ pattern: 'qwen-turbo', rate: r(0.1, 0.3, 0.02, 0.1), contextWindowTokens: 1_000_000 },
	{ pattern: 'qwq-32b', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'qwen3', rate: r(0.4, 1.2, 0.08, 0.4), contextWindowTokens: 128_000 },
	{ pattern: 'qwen2.5', rate: r(0.3, 0.9, 0.06, 0.3), contextWindowTokens: 128_000 },
	{ pattern: 'qwen', rate: r(0.4, 1.2, 0.08, 0.4), contextWindowTokens: 128_000 },

	// xAI Grok
	{ pattern: 'grok-code', rate: r(0.2, 1.5, 0.02, 0.2), contextWindowTokens: 256_000 },
	{ pattern: 'grok-4-fast', rate: r(0.2, 0.5, 0.05, 0.2), contextWindowTokens: 2_000_000 },
	{ pattern: 'grok-3-mini', rate: r(0.3, 0.5, 0.075, 0.3), contextWindowTokens: 128_000 },
	{ pattern: 'grok-4', rate: r(3.0, 15.0, 0.75, 3.0), contextWindowTokens: 256_000 },
	{ pattern: 'grok-3', rate: r(3.0, 15.0, 0.75, 3.0), contextWindowTokens: 128_000 },
	{ pattern: 'grok', rate: r(3.0, 15.0, 0.75, 3.0), contextWindowTokens: 128_000 },

	// Moonshot Kimi / Zhipu GLM / MiniMax / Mistral / Llama / Gemma / Phi
	{ pattern: 'kimi-k2.5', rate: r(0.6, 2.5, 0.15, 0.6), contextWindowTokens: 256_000 },
	{ pattern: 'kimi-k2', rate: r(0.6, 2.5, 0.15, 0.6), contextWindowTokens: 128_000 },
	{ pattern: 'moonshot', rate: r(0.6, 2.5, 0.15, 0.6), contextWindowTokens: 128_000 },
	{ pattern: 'glm-4.5', rate: r(0.6, 2.2, 0.11, 0.6), contextWindowTokens: 128_000 },
	{ pattern: 'glm-4', rate: r(0.6, 2.2, 0.11, 0.6), contextWindowTokens: 128_000 },
	{ pattern: 'glm', rate: r(0.6, 2.2, 0.11, 0.6), contextWindowTokens: 128_000 },
	{ pattern: 'minimax-m2', rate: r(0.3, 1.2, 0.03, 0.375), contextWindowTokens: 200_000 },
	{ pattern: 'minimax-m1', rate: r(0.4, 2.2, 0.04, 0.5), contextWindowTokens: 1_000_000 },
	{ pattern: 'minimax', rate: r(0.3, 1.2, 0.03, 0.375), contextWindowTokens: 200_000 },
	{ pattern: 'codestral', rate: r(0.3, 0.9, 0.075, 0.3), contextWindowTokens: 256_000 },
	{ pattern: 'devstral', rate: r(0.4, 2.0, 0.1, 0.4), contextWindowTokens: 128_000 },
	{ pattern: 'mistral-large', rate: r(2.0, 6.0, 0.5, 2.0), contextWindowTokens: 128_000 },
	{ pattern: 'mistral-small', rate: r(0.1, 0.3, 0.025, 0.1), contextWindowTokens: 128_000 },
	{ pattern: 'mixtral', rate: r(0.24, 0.24, 0.06, 0.24), contextWindowTokens: 32_768 },
	{ pattern: 'mistral-7b', rate: r(0.1, 0.1, 0.025, 0.1), contextWindowTokens: 32_768 },
	{ pattern: 'llama-4', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 1_000_000 },
	{ pattern: 'llama4', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 1_000_000 },
	{ pattern: 'llama-3.3', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'llama3.3', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'llama-3.2', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'llama3.2', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'llama-3.1', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'llama3.1', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 128_000 },
	{ pattern: 'llama-3', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 8_192 },
	{ pattern: 'llama3', rate: r(0.2, 0.6, 0.05, 0.2), contextWindowTokens: 8_192 },
	{ pattern: 'gemma-3', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 128_000 },
	{ pattern: 'gemma3', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 128_000 },
	{ pattern: 'gemma-2', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 8_192 },
	{ pattern: 'gemma2', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 8_192 },
	{ pattern: 'phi-4', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 16_384 },
	{ pattern: 'phi4', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 16_384 },
	{ pattern: 'phi-3', rate: r(0.1, 0.2, 0.025, 0.1), contextWindowTokens: 128_000 },
];

const BUILTIN_MODEL_PRICING_SORTED: readonly IBuiltInPricingEntry[] = [...BUILTIN_MODEL_PRICING_RAW]
	.sort((a, b) => b.pattern.length - a.pattern.length);

const LOCAL_ZERO_COST_PREFIXES = [
	'ollama/',
	'ollama:',
	'local/',
	'local:',
	'lmstudio/',
	'lmstudio:',
	'lm-studio/',
	'lm-studio:',
	'vllm/',
	'vllm:',
	'llamacpp/',
	'llama.cpp/',
	'mlx/',
	'mlx-community/',
	'localhost/',
	'127.0.0.1/',
	'self-hosted/',
	'selfhosted/',
	'sglang/',
];

const LOCAL_ZERO_COST_SUFFIXES = [
	':local',
	':free',
	'@local',
	'(local)',
	'[local]',
];

/**
 * Unwraps raw model strings (including DSH JSON tuple IDs like `["deepseek-official","deepseek-r1"]`)
 * into normalized lowercase candidate keys for pricing lookup.
 */
export function normalizePricingModelCandidates(model: string | undefined): {
	readonly raw: string;
	readonly stripped: string;
} {
	let trimmed = (model ?? '').trim();
	if (!trimmed || trimmed.toLowerCase() === 'default') {
		return { raw: '', stripped: '' };
	}
	// Handle DSH tuple format `["provider", "model"]`
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				const parts = parsed.map(p => (typeof p === 'string' ? p.trim() : '')).filter(Boolean);
				if (parts.length >= 2) {
					trimmed = `${parts[0]}/${parts[1]}`;
				} else if (parts.length === 1) {
					trimmed = parts[0];
				}
			}
		} catch {
			// Keep original trimmed value if not valid JSON
		}
	}
	const raw = trimmed.toLowerCase();
	const lastSlash = raw.lastIndexOf('/');
	const stripped = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
	return { raw, stripped };
}

/**
 * Returns true if the model string matches a well-known local / self-hosted / free zero-cost pattern.
 */
export function isBuiltInLocalZeroCostModel(model: string | undefined): boolean {
	const { raw, stripped } = normalizePricingModelCandidates(model);
	if (!raw) {
		return false;
	}
	for (const prefix of LOCAL_ZERO_COST_PREFIXES) {
		if (raw.startsWith(prefix)) {
			return true;
		}
	}
	for (const suffix of LOCAL_ZERO_COST_SUFFIXES) {
		if (raw.endsWith(suffix) || stripped.endsWith(suffix)) {
			return true;
		}
	}
	return false;
}

function wildcardMatches(pattern: string, text: string): boolean {
	if (!pattern || !text) {
		return false;
	}
	if (pattern === '*') {
		return true;
	}
	if (!pattern.includes('*')) {
		return text === pattern;
	}
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	try {
		return new RegExp(`^${escaped}$`, 'i').test(text);
	} catch {
		return false;
	}
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const EXACT_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	'opus': 'claude-opus-4-6',
	'sonnet': 'claude-sonnet-4-6',
	'haiku': 'claude-haiku-4-5',
});

function matchBuiltInCatalog(model: string | undefined): IBuiltInPricingEntry | undefined {
	const { raw, stripped } = normalizePricingModelCandidates(model);
	if (!raw) {
		return undefined;
	}
	const normalizedStripped = stripped
		.replace(/\[1m\]/g, '')
		.replace(/:thinking$/g, '')
		.trim();
	const aliased = EXACT_MODEL_ALIASES[normalizedStripped] ?? EXACT_MODEL_ALIASES[stripped];
	const candidates = [aliased ?? '', normalizedStripped, stripped, raw].filter(Boolean);
	for (const entry of BUILTIN_MODEL_PRICING_SORTED) {
		for (const candidate of candidates) {
			if (candidate === entry.pattern || candidate.includes(entry.pattern)) {
				return entry;
			}
		}
	}
	return undefined;
}

function matchUserOverride(
	model: string | undefined,
	engineId: string | undefined,
	overrides: AdeModelPricingOverrides | undefined,
): { readonly pattern: string; readonly entry: IModelPricingOverrideEntry } | undefined {
	if (!overrides || typeof overrides !== 'object') {
		return undefined;
	}
	const { raw, stripped } = normalizePricingModelCandidates(model);
	const normalizedStripped = stripped
		.replace(/\[1m\]/g, '')
		.replace(/:thinking$/g, '')
		.trim();
	const fallbackModel = !raw && engineId ? ADE_ENGINE_DEFAULT_PRICING_MODELS[engineId.trim().toLowerCase()] : undefined;
	const candidates = Array.from(new Set([raw, stripped, normalizedStripped, fallbackModel?.toLowerCase() ?? ''].filter(Boolean)));
	if (candidates.length === 0) {
		return undefined;
	}

	const entries: Array<{ readonly key: string; readonly normalized: string; readonly entry: IModelPricingOverrideEntry }> = [];
	for (const [key, entry] of Object.entries(overrides)) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const normalized = key.trim().toLowerCase();
		if (normalized) {
			entries.push({ key, normalized, entry });
		}
	}
	if (entries.length === 0) {
		return undefined;
	}

	// 1. Exact matches first (raw model ID beats stripped ID)
	for (const candidate of candidates) {
		const exact = entries.find(e => !e.normalized.includes('*') && e.normalized === candidate);
		if (exact) {
			return { pattern: exact.key, entry: exact.entry };
		}
	}

	// 2. Wildcard / glob matches sorted by literal specificity descending
	const wildcardEntries = entries
		.filter(e => e.normalized.includes('*'))
		.sort((a, b) => b.normalized.replace(/\*/g, '').length - a.normalized.replace(/\*/g, '').length);
	for (const item of wildcardEntries) {
		for (const candidate of candidates) {
			if (wildcardMatches(item.normalized, candidate)) {
				return { pattern: item.key, entry: item.entry };
			}
		}
	}

	return undefined;
}

/**
 * Resolves effective per-million-token pricing for a given `(model, engineId, overrides)`:
 * 1. User settings overrides (`aexus.ade.finOps.modelPricingOverrides`) — exact or glob, including `local: true`.
 * 2. Built-in local / self-hosted zero-cost detection (`ollama/*`, `local/*`, `vllm/*`, `:local`, `:free`, etc.).
 * 3. Built-in multi-vendor model pricing catalog.
 * 4. Engine default model pricing fallback (when a CLI doesn't report its active model).
 * 5. Conservative generic cloud fallback rate so paid engines never stay blind at $0.00.
 */
export function resolveModelTokenPricingRate(
	model?: string,
	engineId?: string,
	overrides?: AdeModelPricingOverrides,
): IResolvedModelPricing {
	const userMatch = matchUserOverride(model, engineId, overrides);
	if (userMatch) {
		const entry = userMatch.entry;
		const inRate = finiteNonNegative(entry.inputPerMillion);
		const outRate = finiteNonNegative(entry.outputPerMillion);
		const crRate = finiteNonNegative(entry.cacheReadPerMillion);
		const cwRate = finiteNonNegative(entry.cacheWritePerMillion);
		const allExplicitZero = entry.local === true
			|| (
				entry.local !== false
				&& (inRate !== undefined || outRate !== undefined || crRate !== undefined || cwRate !== undefined)
				&& (inRate ?? 0) === 0
				&& (outRate ?? 0) === 0
				&& (crRate ?? 0) === 0
				&& (cwRate ?? 0) === 0
			);
		if (allExplicitZero) {
			return {
				rate: ZERO_LOCAL_RATE,
				isLocalFree: true,
				source: 'override_local',
				matchedPattern: userMatch.pattern,
			};
		}
		const baseCatalog = matchBuiltInCatalog(model)?.rate ?? DEFAULT_FALLBACK_CLOUD_RATE;
		const inputPerMillion = inRate ?? baseCatalog.inputPerMillion;
		const outputPerMillion = outRate ?? baseCatalog.outputPerMillion;
		const cacheReadPerMillion = crRate ?? (inRate !== undefined ? Math.round(inRate * 0.1 * 10_000) / 10_000 : baseCatalog.cacheReadPerMillion);
		const cacheWritePerMillion = cwRate ?? (inRate !== undefined ? Math.round(inRate * 1.25 * 10_000) / 10_000 : baseCatalog.cacheWritePerMillion);
		return {
			rate: { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion },
			isLocalFree: false,
			source: 'override',
			matchedPattern: userMatch.pattern,
		};
	}

	if (isBuiltInLocalZeroCostModel(model)) {
		return {
			rate: ZERO_LOCAL_RATE,
			isLocalFree: true,
			source: 'local_free',
			matchedPattern: model?.trim(),
		};
	}

	const catalogMatch = matchBuiltInCatalog(model);
	if (catalogMatch) {
		return {
			rate: catalogMatch.rate,
			isLocalFree: false,
			source: 'catalog',
			matchedPattern: catalogMatch.pattern,
		};
	}

	const normalizedEngine = engineId?.trim().toLowerCase();
	if (normalizedEngine && ADE_ENGINE_DEFAULT_PRICING_MODELS[normalizedEngine]) {
		const engineDefaultModel = ADE_ENGINE_DEFAULT_PRICING_MODELS[normalizedEngine];
		const engineCatalogMatch = matchBuiltInCatalog(engineDefaultModel);
		if (engineCatalogMatch) {
			return {
				rate: engineCatalogMatch.rate,
				isLocalFree: false,
				source: 'engine_default',
				matchedPattern: engineCatalogMatch.pattern,
			};
		}
	}

	return {
		rate: DEFAULT_FALLBACK_CLOUD_RATE,
		isLocalFree: false,
		source: 'fallback',
	};
}

/**
 * Computes estimated USD cost for a token usage delta / turn using the unified pricing catalog
 * and optional user overrides. Automatically avoids double-billing cached input tokens when a
 * provider reports OpenAI-style inclusive `inputTokens` (where `inputTokens` already includes `cacheReadTokens`).
 */
export function estimateTokenCostUsd(params: ITokenCostEstimateInput): ITokenCostEstimateResult {
	const inputTokens = Math.max(0, Number.isFinite(params.inputTokens) ? params.inputTokens : 0);
	const outputTokens = Math.max(0, Number.isFinite(params.outputTokens) ? params.outputTokens : 0);
	const cacheReadTokens = Math.max(0, Number.isFinite(params.cacheReadTokens ?? 0) ? (params.cacheReadTokens ?? 0) : 0);
	const cacheWriteTokens = Math.max(0, Number.isFinite(params.cacheWriteTokens ?? 0) ? (params.cacheWriteTokens ?? 0) : 0);
	const totalTokens = Math.max(0, Number.isFinite(params.totalTokens ?? 0) ? (params.totalTokens ?? 0) : 0);

	const resolved = resolveModelTokenPricingRate(params.model, params.engineId, params.overrides);
	if (resolved.isLocalFree) {
		return {
			...resolved,
			costUsd: 0,
			estimated: false,
		};
	}

	// OpenAI/Codex-style payloads often set `input_tokens` inclusive of `cached_input_tokens`,
	// so `input + output + cacheWrite <= totalTokens < input + output + cacheRead + cacheWrite`.
	const inputIncludesCacheRead = totalTokens > 0
		&& cacheReadTokens > 0
		&& inputTokens >= cacheReadTokens
		&& (inputTokens + outputTokens + cacheWriteTokens) <= totalTokens
		&& (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) > totalTokens;
	const billableNonCachedInput = inputIncludesCacheRead
		? Math.max(0, inputTokens - cacheReadTokens)
		: inputTokens;

	const rawCost = (
		billableNonCachedInput * resolved.rate.inputPerMillion
		+ outputTokens * resolved.rate.outputPerMillion
		+ cacheReadTokens * resolved.rate.cacheReadPerMillion
		+ cacheWriteTokens * resolved.rate.cacheWritePerMillion
	) / 1_000_000;

	const costUsd = Math.round(Math.max(0, rawCost) * 1_000_000) / 1_000_000;
	return {
		...resolved,
		costUsd,
		estimated: true,
	};
}

const DEFAULT_UNSPECIFIED_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_UNKNOWN_CLOUD_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_UNKNOWN_LOCAL_CONTEXT_WINDOW_TOKENS = 32_768;

function clampContextWindowTokens(tokens: number): number {
	return Math.max(4_096, Math.min(10_000_000, Math.round(tokens)));
}

/**
 * Parses explicit context-window size tags embedded in model IDs such as
 * `[1m]`, `-1m`, `:2m`, `-64k`, `-128k`, `-32k`, `[256k]`, `moonshot-v1-8k`.
 */
export function parseExplicitModelContextWindowTag(model: string | undefined): number | undefined {
	const { raw, stripped } = normalizePricingModelCandidates(model);
	if (!raw) {
		return undefined;
	}
	for (const candidate of [stripped, raw]) {
		const mMatch = /(?:^|[\[\s:_(@-])(\d+(?:\.\d+)?)m(?:[\]\s)@_-]|$)/i.exec(candidate);
		if (mMatch) {
			const val = Number.parseFloat(mMatch[1]);
			if (Number.isFinite(val) && val >= 0.5 && val <= 10) {
				return clampContextWindowTokens(val * 1_000_000);
			}
		}
		const kMatch = /(?:^|[\[\s:_(@-])(4|8|16|24|32|48|64|96|128|160|200|256|300|400|512)k(?:[\]\s)@_-]|$)/i.exec(candidate);
		if (kMatch) {
			const val = Number.parseInt(kMatch[1], 10);
			if (Number.isFinite(val) && val >= 4) {
				return clampContextWindowTokens(val * 1_000);
			}
		}
	}
	return undefined;
}

/**
 * Resolves the real context window capacity (in tokens) for a model across all vendors & engines:
 * 1. User settings override (`aexus.ade.finOps.modelPricingOverrides.<pattern>.contextWindowTokens`).
 * 2. Explicit size tag embedded in model ID (`[1m]`, `-64k`, `-128k`, `-32k`, etc.).
 * 3. Unified multi-vendor model catalog (works for both cloud models and local mirrors like `ollama/deepseek-r1`).
 * 4. Conservative local/self-hosted fallback (`32,768`) when model is local and family is unknown.
 * 5. Engine representative default model catalog lookup (e.g. `dsh` -> 64k, `codex` -> 400k, `antigravity` -> 1M).
 * 6. Realistic cloud fallback (`128,000`) for unrecognized named cloud models, or `200,000` when both model and engine are omitted.
 */
export function resolveModelContextWindowTokens(
	model?: string,
	engineId?: string,
	overrides?: AdeModelPricingOverrides,
): number {
	const userMatch = matchUserOverride(model, engineId, overrides);
	if (userMatch && typeof userMatch.entry.contextWindowTokens === 'number' && Number.isFinite(userMatch.entry.contextWindowTokens) && userMatch.entry.contextWindowTokens > 0) {
		return clampContextWindowTokens(userMatch.entry.contextWindowTokens);
	}

	const explicitTag = parseExplicitModelContextWindowTag(model);
	if (explicitTag !== undefined) {
		return explicitTag;
	}

	const catalogMatch = matchBuiltInCatalog(model);
	if (catalogMatch) {
		return catalogMatch.contextWindowTokens;
	}

	if (isBuiltInLocalZeroCostModel(model)) {
		return DEFAULT_UNKNOWN_LOCAL_CONTEXT_WINDOW_TOKENS;
	}

	const { raw } = normalizePricingModelCandidates(model);
	const normalizedEngine = engineId?.trim().toLowerCase();
	if (!raw && normalizedEngine && ADE_ENGINE_DEFAULT_PRICING_MODELS[normalizedEngine]) {
		const engineCatalogMatch = matchBuiltInCatalog(ADE_ENGINE_DEFAULT_PRICING_MODELS[normalizedEngine]);
		if (engineCatalogMatch) {
			return engineCatalogMatch.contextWindowTokens;
		}
	}
	if (raw) {
		return DEFAULT_UNKNOWN_CLOUD_CONTEXT_WINDOW_TOKENS;
	}
	return DEFAULT_UNSPECIFIED_CONTEXT_WINDOW_TOKENS;
}

/**
 * Formats a USD amount with an optional `~` prefix when the figure includes token-estimated spend.
 */
export function formatFinOpsUsd(costUsd: number, options?: { readonly estimated?: boolean; readonly compact?: boolean }): string {
	const safe = Math.max(0, Number.isFinite(costUsd) ? costUsd : 0);
	const prefix = options?.estimated && safe > 0 ? '~$' : '$';
	if (options?.compact && safe > 0 && safe < 0.01) {
		return `${prefix}${safe.toFixed(3)}`;
	}
	return `${prefix}${safe.toFixed(2)}`;
}
