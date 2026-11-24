/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Token usage accounted for a single completed engine turn. */
export interface EngineTurnTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens: number;
	/** Measured engine/system initialization tokens (grey context segment). */
	readonly contextInitTokens?: number;
	/** Measured ADE role/tier contract & pre-prompt tokens (blue context segment). */
	readonly contextTierDocTokens?: number;
	readonly durationMs?: number;
	readonly costUsd?: number;
	readonly model?: string;
	readonly estimated?: boolean;
	/** True when one or more tool/command/compile failures occurred during this turn (attributes tokens to rework noise). */
	readonly hadToolError?: boolean;
	/** Count of tool/command failures observed during this turn. */
	readonly toolErrorCount?: number;
}

const STREAM_TOOL_ERROR_PATTERNS: readonly RegExp[] = [
	/\bexited with (?:exit )?code [1-9]\d*\b/i,
	/\bexit code[:=\s]+[1-9]\d*\b/i,
	/\bcommand failed\b/i,
	/\berror executing tool\b/i,
	/\btool(?:_call| call)? (?:failed|error)\b/i,
	/\berror TS\d{4}:/,
	/\bTraceback \(most recent call last\):/,
	/\b(?:SyntaxError|TypeError|ReferenceError|AssertionError|RangeError):/,
	/\bnpm ERR!\b/,
	/(?:^|\n)\s*(?:FAIL|FAILED)\s+\S+/,
];

const STREAM_PROGRESS_TOOL_ERROR_PATTERNS: readonly RegExp[] = [
	/\bexited with (?:exit )?code [1-9]\d*\b/i,
	/\bexit code[:=\s]+[1-9]\d*\b/i,
	/\bcommand failed\b/i,
	/\berror executing tool\b/i,
	/\btool(?:_call| call)? (?:failed|error)\b/i,
];

/**
 * Detects concrete tool/command/build failure output in a streamed text chunk without
 * falsely triggering on ordinary prose discussing errors conceptually.
 */
export function detectToolErrorInStreamChunk(text: string): boolean {
	if (!text || text.length < 6) {
		return false;
	}
	for (const rx of STREAM_TOOL_ERROR_PATTERNS) {
		if (rx.test(text)) {
			return true;
		}
	}
	return false;
}

/**
 * Stricter detector for `stream.progress(...)` notifications so chain-of-thought reasoning
 * mentioning error class names (e.g. `TypeError:`) never false-positives as a tool failure.
 */
export function detectToolErrorInProgressText(text: string): boolean {
	if (!text || text.length < 6) {
		return false;
	}
	for (const rx of STREAM_PROGRESS_TOOL_ERROR_PATTERNS) {
		if (rx.test(text)) {
			return true;
		}
	}
	return false;
}

export interface StreamToolErrorScanner {
	scan(chunk: string): boolean;
	reset(): void;
}

/**
 * Stateful rolling-tail scanner that catches tool/command error markers even when split
 * across consecutive streaming token deltas (e.g. `"exit code "` + `"1"`), clearing the
 * tail after each match to avoid double-counting the same failure across subsequent chunks.
 */
export function createStreamToolErrorScanner(tailChars = 160): StreamToolErrorScanner {
	let rollingTail = '';
	const maxTail = Math.max(32, tailChars);
	return {
		scan(chunk: string): boolean {
			if (!chunk) {
				return false;
			}
			const combined = rollingTail + chunk;
			if (detectToolErrorInStreamChunk(combined)) {
				rollingTail = '';
				return true;
			}
			rollingTail = combined.length > maxTail ? combined.slice(-maxTail) : combined;
			return false;
		},
		reset(): void {
			rollingTail = '';
		},
	};
}

function readMarkdownOrString(val: unknown): string {
	if (typeof val === 'string') {
		return val;
	}
	if (val && typeof val === 'object' && typeof (val as { value?: unknown }).value === 'string') {
		return String((val as { value: string }).value);
	}
	return '';
}

/**
 * Detects failed tool invocation parts emitted via VS Code `ChatResponseStream.push(...)`
 * across Claude, Codex, Kilo/OpenCode, ACP, and Pi drivers.
 */
export function detectToolErrorInStreamPart(part: unknown): boolean {
	if (!part || typeof part !== 'object') {
		return false;
	}
	const rec = part as Record<string, unknown>;
	if (rec.isError === true || rec.is_error === true || rec.status === 'error' || rec.status === 'failed') {
		return true;
	}
	if (readMarkdownOrString(rec.errorMessage).trim().length > 0) {
		return true;
	}
	if (rec.resultDetails && typeof rec.resultDetails === 'object') {
		const rd = rec.resultDetails as Record<string, unknown>;
		if (rd.isError === true || rd.is_error === true) {
			return true;
		}
	}
	const pastTense = readMarkdownOrString(rec.pastTenseMessage);
	if (pastTense && (/\b(?:failed|error|exit code [1-9])\b/i.test(pastTense) || detectToolErrorInStreamChunk(pastTense))) {
		return true;
	}
	const invocation = readMarkdownOrString(rec.invocationMessage);
	if (invocation && detectToolErrorInStreamChunk(invocation)) {
		return true;
	}
	return false;
}

export function estimateTextTokens(text: string): number {
	if (!text) {
		return 0;
	}
	let cjkChars = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (
			(code >= 0x3000 && code <= 0x9FFF)
			|| (code >= 0xAC00 && code <= 0xD7AF)
			|| (code >= 0xF900 && code <= 0xFAFF)
			|| (code >= 0xFF00 && code <= 0xFFEF)
		) {
			cjkChars++;
		}
	}
	return Math.max(1, Math.ceil(cjkChars * 1.15 + (text.length - cjkChars) / 4));
}

export interface ProviderTokenUsageHints {
	/** Explicit hint when a provider's `inputTokens` is known to include (`true`) or exclude (`false`) `cacheReadTokens`. */
	readonly inputIncludesCacheRead?: boolean;
	readonly costUsd?: number;
	readonly model?: string;
	readonly durationMs?: number;
	readonly allowZeroTotal?: boolean;
}

function readFiniteNonNegativeNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const val = record[key];
		if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
			return val;
		}
	}
	return undefined;
}

function readUsageCostUsd(record: Record<string, unknown>): number | undefined {
	for (const key of ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd', 'totalCost', 'cost']) {
		const val = record[key];
		if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
			return val;
		}
		if (val && typeof val === 'object') {
			const total = (val as Record<string, unknown>).total;
			if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
				return total;
			}
		}
	}
	return undefined;
}

function readUsageModelString(record: Record<string, unknown>): string | undefined {
	const topProvider = typeof record.provider === 'string' && record.provider.trim()
		? record.provider.trim()
		: (typeof record.providerID === 'string' && record.providerID.trim() ? record.providerID.trim() : undefined);
	for (const key of ['model', 'modelId', 'model_id', 'modelID']) {
		const val = record[key];
		if (typeof val === 'string' && val.trim() && val.trim().toLowerCase() !== 'default') {
			const m = val.trim();
			return topProvider && !m.startsWith(`${topProvider}/`) ? `${topProvider}/${m}` : m;
		}
		if (val && typeof val === 'object') {
			const obj = val as Record<string, unknown>;
			const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : undefined;
			const p = typeof obj.provider === 'string' && obj.provider.trim() ? obj.provider.trim() : topProvider;
			if (id) {
				return p && !id.startsWith(`${p}/`) ? `${p}/${id}` : id;
			}
		}
	}
	return undefined;
}

const INCLUSIVE_CACHE_MODEL_FAMILY_RE = /^(?:openai\/|codex\/|google\/)?(?:gpt-|o[134](?:[-_]|$)|codex|chatgpt-|gemini-)/i;

/**
 * Ensures an `EngineTurnTokenUsage` object uses canonical **non-cached** `inputTokens`
 * (`inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === totalTokens`),
 * preventing +80-90% token inflation and ~4x USD double-billing when OpenAI/Codex/Gemini/DeepSeek
 * packets report `inputTokens` inclusive of `cacheReadTokens`.
 */
export function ensureNonCachedTokenUsage(usage: EngineTurnTokenUsage): EngineTurnTokenUsage {
	const rawIn = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0;
	const out = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
	const cacheRead = Number.isFinite(usage.cacheReadTokens ?? 0) ? Math.max(0, usage.cacheReadTokens ?? 0) : 0;
	const cacheWrite = Number.isFinite(usage.cacheWriteTokens ?? 0) ? Math.max(0, usage.cacheWriteTokens ?? 0) : 0;
	const reportedTotal = Number.isFinite(usage.totalTokens) ? Math.max(0, usage.totalTokens) : 0;
	const isInclusiveByTotal = cacheRead > 0
		&& rawIn >= cacheRead
		&& reportedTotal > 0
		&& (rawIn + out + cacheWrite) <= reportedTotal
		&& reportedTotal < (rawIn + out + cacheRead + cacheWrite);
	const isInclusiveByModelWhenTotalMissing = cacheRead > 0
		&& rawIn >= cacheRead
		&& reportedTotal === 0
		&& INCLUSIVE_CACHE_MODEL_FAMILY_RE.test((usage.model ?? '').trim());
	const nonCachedIn = (isInclusiveByTotal || isInclusiveByModelWhenTotalMissing) ? rawIn - cacheRead : rawIn;
	const canonicalTotal = Math.max(reportedTotal, nonCachedIn + out + cacheRead + cacheWrite);
	if (nonCachedIn === usage.inputTokens && canonicalTotal === usage.totalTokens) {
		return usage;
	}
	return {
		...usage,
		inputTokens: nonCachedIn,
		outputTokens: out,
		...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: cacheRead } : {}),
		...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
		totalTokens: canonicalTotal,
	};
}

/**
 * Unified provider token-usage normalizer across Anthropic/Claude, OpenAI Chat & Responses,
 * Codex `app-server`, Gemini/Antigravity, DeepSeek/DSH, Pi, ACP, and Kilo/OpenCode:
 * - Extracts flat and nested cache fields (`prompt_tokens_details.cached_tokens`,
 *   `input_tokens_details.cached_tokens`, `cachedInputTokens`, `prompt_cache_hit_tokens` /
 *   `prompt_cache_miss_tokens`, `cachedContentTokenCount`, `cache.read` / `cache.write`).
 * - Normalizes `inputTokens` strictly to **non-cached input tokens** across every provider so
 *   `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` equals `totalTokens`.
 */
export function normalizeProviderTokenUsage(
	value: unknown,
	hints?: ProviderTokenUsageHints,
	depth = 0,
): EngineTurnTokenUsage | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const outerCostUsd = readUsageCostUsd(record) ?? hints?.costUsd;
	const outerModelRaw = readUsageModelString(record) ?? hints?.model;
	const outerModel = outerModelRaw?.trim() && outerModelRaw.trim().toLowerCase() !== 'default'
		? outerModelRaw.trim()
		: undefined;
	const outerDurationMs = readFiniteNonNegativeNumber(record, 'durationMs', 'duration_ms') ?? hints?.durationMs;

	for (const nestedKey of ['usage', 'tokenUsage', 'token_usage', 'tokens', 'usageMetadata', 'total', 'total_token_usage', 'totalTokenUsage', 'last', 'last_token_usage']) {
		const nested = record[nestedKey];
		if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
			const extracted = normalizeProviderTokenUsage(
				nested,
				{
					...hints,
					costUsd: outerCostUsd,
					model: outerModel,
					durationMs: outerDurationMs,
				},
				depth + 1,
			);
			if (extracted) {
				return extracted;
			}
		}
	}

	const cacheObj = record.cache && typeof record.cache === 'object' && !Array.isArray(record.cache)
		? record.cache as Record<string, unknown>
		: undefined;
	const promptDetails = record.prompt_tokens_details && typeof record.prompt_tokens_details === 'object'
		? record.prompt_tokens_details as Record<string, unknown>
		: (record.promptTokensDetails && typeof record.promptTokensDetails === 'object'
			? record.promptTokensDetails as Record<string, unknown>
			: undefined);
	const inputDetails = record.input_tokens_details && typeof record.input_tokens_details === 'object'
		? record.input_tokens_details as Record<string, unknown>
		: (record.inputTokensDetails && typeof record.inputTokensDetails === 'object'
			? record.inputTokensDetails as Record<string, unknown>
			: undefined);

	const exclusiveCacheRead = readFiniteNonNegativeNumber(
		record,
		'cache_read_input_tokens',
		'cacheReadInputTokens',
		'cacheReadTokens',
		'cacheRead',
	) ?? (cacheObj ? readFiniteNonNegativeNumber(cacheObj, 'read') : undefined);

	const inclusiveFlatCacheRead = readFiniteNonNegativeNumber(
		record,
		'cachedInputTokens',
		'cached_input_tokens',
		'cached_tokens',
		'prompt_cache_hit_tokens',
		'cachedContentTokenCount',
		'cached_content_token_count',
	);
	const nestedDetailsCacheRead = (inputDetails ? readFiniteNonNegativeNumber(inputDetails, 'cached_tokens', 'cachedTokens') : undefined)
		?? (promptDetails ? readFiniteNonNegativeNumber(promptDetails, 'cached_tokens', 'cachedTokens') : undefined);

	const cacheReadTokens = exclusiveCacheRead ?? inclusiveFlatCacheRead ?? nestedDetailsCacheRead ?? 0;
	const schemaIsInclusive = exclusiveCacheRead === undefined && (inclusiveFlatCacheRead !== undefined || nestedDetailsCacheRead !== undefined);

	const cacheWriteTokens = readFiniteNonNegativeNumber(
		record,
		'cache_creation_input_tokens',
		'cacheCreationInputTokens',
		'cacheWriteTokens',
		'cache_write_tokens',
		'cacheWrite',
	)
		?? (cacheObj ? readFiniteNonNegativeNumber(cacheObj, 'write') : undefined)
		?? (inputDetails ? readFiniteNonNegativeNumber(inputDetails, 'cache_creation_tokens', 'cacheCreationTokens') : undefined)
		?? (promptDetails ? readFiniteNonNegativeNumber(promptDetails, 'cache_creation_tokens', 'cacheCreationTokens') : undefined)
		?? 0;

	const explicitDeepSeekMiss = readFiniteNonNegativeNumber(record, 'prompt_cache_miss_tokens');
	const rawInput = readFiniteNonNegativeNumber(
		record,
		'inputTokens',
		'input_tokens',
		'input',
		'prompt_tokens',
		'promptTokens',
		'promptTokenCount',
		'prompt_token_count',
	) ?? 0;

	const directOutput = readFiniteNonNegativeNumber(
		record,
		'outputTokens',
		'output_tokens',
		'output',
		'completion_tokens',
		'completionTokens',
	);
	const geminiCandidates = readFiniteNonNegativeNumber(record, 'candidatesTokenCount', 'candidates_token_count');
	const geminiThoughts = readFiniteNonNegativeNumber(record, 'thoughtsTokenCount', 'thoughts_token_count') ?? 0;
	const outputTokens = directOutput ?? (geminiCandidates !== undefined ? geminiCandidates + geminiThoughts : 0);

	const reportedTotal = readFiniteNonNegativeNumber(
		record,
		'totalTokens',
		'total_tokens',
		'total',
		'totalTokenCount',
		'total_token_count',
	) ?? 0;

	let nonCachedInput: number;
	if (explicitDeepSeekMiss !== undefined) {
		nonCachedInput = explicitDeepSeekMiss;
	} else if (exclusiveCacheRead !== undefined) {
		// Explicitly exclusive cache schema (`cache_read_input_tokens`, `cacheReadTokens`, `cacheRead`, `cache.read`):
		// `rawInput` is already non-cached regardless of `reportedTotal` or provider hints (#123 #2b/#2c).
		nonCachedInput = rawInput;
	} else if (cacheReadTokens > 0 && rawInput >= cacheReadTokens) {
		const inclusiveCandidate = rawInput + outputTokens + cacheWriteTokens;
		const exclusiveCandidate = inclusiveCandidate + cacheReadTokens;
		if (reportedTotal > 0) {
			if (reportedTotal >= exclusiveCandidate) {
				nonCachedInput = rawInput;
			} else if (inclusiveCandidate <= reportedTotal && reportedTotal < exclusiveCandidate) {
				nonCachedInput = rawInput - cacheReadTokens;
			} else {
				nonCachedInput = (hints?.inputIncludesCacheRead ?? schemaIsInclusive) ? rawInput - cacheReadTokens : rawInput;
			}
		} else {
			nonCachedInput = (hints?.inputIncludesCacheRead ?? schemaIsInclusive) ? rawInput - cacheReadTokens : rawInput;
		}
	} else {
		nonCachedInput = rawInput;
	}

	const componentSum = nonCachedInput + outputTokens + cacheReadTokens + cacheWriteTokens;
	const totalTokens = Math.max(reportedTotal, componentSum);
	if (totalTokens <= 0 && !hints?.allowZeroTotal) {
		return undefined;
	}

	return {
		inputTokens: nonCachedInput,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		...(outerDurationMs !== undefined ? { durationMs: outerDurationMs } : {}),
		...(outerCostUsd !== undefined ? { costUsd: outerCostUsd } : {}),
		...(outerModel ? { model: outerModel } : {}),
		estimated: false,
	};
}

export interface MultiStepTurnUsageAccumulator {
	/**
	 * Records or updates per-step usage keyed by `stepId` (e.g. assistant message ID or step index)
	 * and returns the aggregated usage across all steps seen so far in this turn.
	 */
	recordStep(stepId: string, stepUsage: EngineTurnTokenUsage): EngineTurnTokenUsage;
	getAggregatedUsage(): EngineTurnTokenUsage | undefined;
	readonly stepCount: number;
}

/**
 * Accumulates per-LLM-step token & cost usage across multi-tool agent loops (Pi, Kilo/OpenCode,
 * Claude streaming assistant messages) so intermediate tool-call steps are never overwritten by
 * the final summary step, while idempotently updating in-place when the same `stepId` emits
 * progressive updates.
 */
export function createMultiStepTurnUsageAccumulator(): MultiStepTurnUsageAccumulator {
	const steps = new Map<string, EngineTurnTokenUsage>();

	const computeTotal = (): EngineTurnTokenUsage | undefined => {
		if (steps.size === 0) {
			return undefined;
		}
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheWriteTokens = 0;
		let hasCache = false;
		let totalTokens = 0;
		let costUsd = 0;
		let hasCost = false;
		let durationMs = 0;
		let hasDuration = false;
		let model: string | undefined;
		let allEstimated = true;
		let maxToolErrors = 0;
		let anyToolError = false;

		for (const u of steps.values()) {
			inputTokens += Math.max(0, u.inputTokens);
			outputTokens += Math.max(0, u.outputTokens);
			if (u.cacheReadTokens !== undefined || u.cacheWriteTokens !== undefined) {
				hasCache = true;
				cacheReadTokens += Math.max(0, u.cacheReadTokens ?? 0);
				cacheWriteTokens += Math.max(0, u.cacheWriteTokens ?? 0);
			}
			totalTokens += Math.max(
				u.totalTokens,
				Math.max(0, u.inputTokens) + Math.max(0, u.outputTokens) + Math.max(0, u.cacheReadTokens ?? 0) + Math.max(0, u.cacheWriteTokens ?? 0),
			);
			if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0) {
				hasCost = true;
				costUsd += u.costUsd;
			}
			if (typeof u.durationMs === 'number' && Number.isFinite(u.durationMs) && u.durationMs >= 0) {
				hasDuration = true;
				durationMs += u.durationMs;
			}
			if (u.model) {
				model = u.model;
			}
			if (u.estimated !== true) {
				allEstimated = false;
			}
			if (u.hadToolError || (u.toolErrorCount ?? 0) > 0) {
				anyToolError = true;
				maxToolErrors = Math.max(maxToolErrors, u.toolErrorCount ?? 1);
			}
		}

		return {
			inputTokens,
			outputTokens,
			...(hasCache ? { cacheReadTokens, cacheWriteTokens } : {}),
			totalTokens: Math.max(totalTokens, inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens),
			...(hasCost ? { costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 } : {}),
			...(hasDuration ? { durationMs } : {}),
			...(model ? { model } : {}),
			...(anyToolError ? { hadToolError: true, ...(maxToolErrors > 0 ? { toolErrorCount: maxToolErrors } : {}) } : {}),
			estimated: allEstimated,
		};
	};

	return {
		recordStep(stepId: string, rawStepUsage: EngineTurnTokenUsage): EngineTurnTokenUsage {
			const stepUsage = ensureNonCachedTokenUsage(rawStepUsage);
			const key = stepId.trim() || `__step_${steps.size}`;
			const prev = steps.get(key);
			if (prev) {
				// Keep maximum monotonic values for progressive updates on the same message ID.
				const mergedInput = Math.max(prev.inputTokens, stepUsage.inputTokens);
				const mergedOutput = Math.max(prev.outputTokens, stepUsage.outputTokens);
				const mergedCacheRead = stepUsage.cacheReadTokens !== undefined || prev.cacheReadTokens !== undefined
					? Math.max(prev.cacheReadTokens ?? 0, stepUsage.cacheReadTokens ?? 0)
					: undefined;
				const mergedCacheWrite = stepUsage.cacheWriteTokens !== undefined || prev.cacheWriteTokens !== undefined
					? Math.max(prev.cacheWriteTokens ?? 0, stepUsage.cacheWriteTokens ?? 0)
					: undefined;
				const mergedCost = typeof stepUsage.costUsd === 'number' && Number.isFinite(stepUsage.costUsd)
					? Math.max(prev.costUsd ?? 0, stepUsage.costUsd)
					: prev.costUsd;
				const mergedHadToolError = Boolean(prev.hadToolError || stepUsage.hadToolError);
				const mergedToolErrorCount = Math.max(prev.toolErrorCount ?? 0, stepUsage.toolErrorCount ?? 0);
				steps.set(key, {
					...prev,
					...stepUsage,
					inputTokens: mergedInput,
					outputTokens: mergedOutput,
					...(mergedCacheRead !== undefined ? { cacheReadTokens: mergedCacheRead } : {}),
					...(mergedCacheWrite !== undefined ? { cacheWriteTokens: mergedCacheWrite } : {}),
					totalTokens: Math.max(
						prev.totalTokens,
						stepUsage.totalTokens,
						mergedInput + mergedOutput + (mergedCacheRead ?? 0) + (mergedCacheWrite ?? 0),
					),
					...(mergedCost !== undefined ? { costUsd: mergedCost } : {}),
					...(mergedHadToolError || mergedToolErrorCount > 0 ? {
						hadToolError: true,
						...(mergedToolErrorCount > 0 ? { toolErrorCount: mergedToolErrorCount } : {}),
					} : {}),
					model: stepUsage.model ?? prev.model,
				});
			} else {
				steps.set(key, stepUsage);
			}
			return computeTotal()!;
		},
		getAggregatedUsage() {
			return computeTotal();
		},
		get stepCount() {
			return steps.size;
		},
	};
}

export interface TurnInterimUsageTracker {
	recordRealUsage(rawUsage: EngineTurnTokenUsage, options?: { readonly cumulativeAcrossThread?: boolean }): EngineTurnTokenUsage;
	recordStreamDelta(deltaText: string, options?: { readonly skipToolErrorScan?: boolean }): void;
	recordToolError(count?: number): void;
	getToolErrorCount(): number;
	getLatestRealUsage(): EngineTurnTokenUsage | undefined;
}

function computeDeltaCounter(rawVal: number | undefined, baseVal: number | undefined): number {
	const r = Math.max(0, rawVal ?? 0);
	const b = Math.max(0, baseVal ?? 0);
	return r >= b ? r - b : r;
}

/**
 * Unified per-turn streaming token usage tracker shared across Codex, Kilo/OpenCode, ACP, and Pi:
 * - Normalizes incoming & baseline packets to canonical non-cached `inputTokens`.
 * - Subtracts optional pre-turn baselines per-counter when an engine reports thread-cumulative
 *   totals — including after context compaction where `inputTokens` may dip below the pre-compaction
 *   baseline while cumulative `outputTokens` and `costUsd` continue increasing monotonically.
 * - Leaves per-turn packets untouched when `outputTokens < baseline.outputTokens` (fresh reset).
 * - Throttles `onInterimUsage` callbacks so UI updates stay smooth without spamming storage.
 * - Falls back to throttled text-delta estimates mid-turn until the engine emits a real usage packet.
 */
export function createTurnInterimUsageTracker(
	promptText: string,
	onInterimUsage: ((cumulativeTurnUsage: EngineTurnTokenUsage) => void) | undefined,
	options?: { readonly preTurnBaseline?: EngineTurnTokenUsage; readonly throttleMs?: number; readonly model?: string },
): TurnInterimUsageTracker {
	const throttleMs = Math.max(0, options?.throttleMs ?? 1000);
	const baseline = options?.preTurnBaseline ? ensureNonCachedTokenUsage(options.preTurnBaseline) : undefined;
	const defaultModel = options?.model?.trim() && options.model.trim().toLowerCase() !== 'default'
		? options.model.trim()
		: undefined;
	const promptEstTokens = estimateTextTokens(promptText);
	let streamedOutputEstTokens = 0;
	let sawRealUsage = false;
	let latestRealUsage: EngineTurnTokenUsage | undefined;
	let lastReportedAt = 0;
	let lastReportedTotal = 0;
	let toolErrorCount = 0;
	const streamErrorScanner = createStreamToolErrorScanner();

	const withToolErrors = (snapshot: EngineTurnTokenUsage): EngineTurnTokenUsage => {
		const effectiveCount = Math.max(toolErrorCount, snapshot.toolErrorCount ?? 0);
		if (effectiveCount > 0 || snapshot.hadToolError) {
			return {
				...snapshot,
				hadToolError: true,
				...(effectiveCount > 0 ? { toolErrorCount: effectiveCount } : {}),
			};
		}
		return snapshot;
	};

	const maybeEmit = (snapshot: EngineTurnTokenUsage, forceOnFirstReal = false): void => {
		if (!onInterimUsage || snapshot.totalTokens <= 0) {
			return;
		}
		const now = Date.now();
		if (!forceOnFirstReal && (snapshot.totalTokens <= lastReportedTotal || now - lastReportedAt < throttleMs)) {
			return;
		}
		lastReportedAt = now;
		lastReportedTotal = Math.max(lastReportedTotal, snapshot.totalTokens);
		try {
			onInterimUsage(withToolErrors(snapshot));
		} catch { /* Live usage reporting must never break the turn. */ }
	};

	return {
		recordRealUsage(incomingUsage, opts) {
			const rawUsage = ensureNonCachedTokenUsage(incomingUsage);
			if (rawUsage.hadToolError || (rawUsage.toolErrorCount ?? 0) > 0) {
				toolErrorCount = Math.max(toolErrorCount, rawUsage.toolErrorCount ?? 1);
			}
			let normalized = rawUsage;
			const cumulativeMonotonicOutput = Boolean(
				opts?.cumulativeAcrossThread
				&& baseline
				&& rawUsage.outputTokens >= baseline.outputTokens
				&& (
					(rawUsage.inputTokens >= baseline.inputTokens && rawUsage.totalTokens >= baseline.totalTokens)
					// Post-compaction cumulative thread packet: input context shrank, but cumulative
					// outputTokens (or cumulative costUsd) stayed >= pre-turn thread baseline.
					|| baseline.outputTokens > 0
					|| (
						typeof rawUsage.costUsd === 'number'
						&& typeof baseline.costUsd === 'number'
						&& rawUsage.costUsd >= baseline.costUsd
						&& baseline.costUsd > 0
					)
				),
			);
			if (cumulativeMonotonicOutput && baseline) {
				const inputCompacted = rawUsage.inputTokens < baseline.inputTokens;
				if (inputCompacted) {
					lastReportedTotal = 0;
				}
				const inputTokens = inputCompacted
					? Math.max(0, rawUsage.inputTokens)
					: Math.max(0, rawUsage.inputTokens - baseline.inputTokens);
				const outputTokens = Math.max(0, rawUsage.outputTokens - baseline.outputTokens);
				const cacheReadTokens = computeDeltaCounter(rawUsage.cacheReadTokens, baseline.cacheReadTokens);
				const cacheWriteTokens = computeDeltaCounter(rawUsage.cacheWriteTokens, baseline.cacheWriteTokens);
				const componentSum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
				const totalTokens = !inputCompacted && rawUsage.totalTokens >= baseline.totalTokens
					? Math.max(componentSum, rawUsage.totalTokens - baseline.totalTokens)
					: componentSum;
				const deltaCostUsd = typeof rawUsage.costUsd === 'number' && Number.isFinite(rawUsage.costUsd)
					? (typeof baseline.costUsd === 'number' && Number.isFinite(baseline.costUsd) && rawUsage.costUsd >= baseline.costUsd
						? Math.round((rawUsage.costUsd - baseline.costUsd) * 1_000_000) / 1_000_000
						: rawUsage.costUsd)
					: undefined;
				normalized = {
					...rawUsage,
					inputTokens,
					outputTokens,
					...(rawUsage.cacheReadTokens !== undefined || baseline.cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
					...(rawUsage.cacheWriteTokens !== undefined || baseline.cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
					totalTokens,
					...(deltaCostUsd !== undefined ? { costUsd: deltaCostUsd } : {}),
				};
			}
			if (!normalized.model && defaultModel) {
				normalized = { ...normalized, model: defaultModel };
			}
			normalized = withToolErrors(normalized);
			const firstReal = !sawRealUsage;
			sawRealUsage = true;
			latestRealUsage = normalized;
			maybeEmit(normalized, firstReal);
			return normalized;
		},
		recordStreamDelta(deltaText, deltaOpts) {
			if (!deltaText) {
				return;
			}
			if (!deltaOpts?.skipToolErrorScan && streamErrorScanner.scan(deltaText)) {
				toolErrorCount += 1;
			}
			streamedOutputEstTokens += estimateTextTokens(deltaText);
			if (sawRealUsage || !onInterimUsage) {
				return;
			}
			const totalTokens = promptEstTokens + streamedOutputEstTokens;
			maybeEmit({
				inputTokens: promptEstTokens,
				outputTokens: streamedOutputEstTokens,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens,
				...(defaultModel ? { model: defaultModel } : {}),
				estimated: true,
			});
		},
		recordToolError(count = 1) {
			const inc = Math.max(1, Math.floor(count));
			toolErrorCount += inc;
		},
		getToolErrorCount() {
			return toolErrorCount;
		},
		getLatestRealUsage() {
			return latestRealUsage ? withToolErrors(latestRealUsage) : undefined;
		},
	};
}
