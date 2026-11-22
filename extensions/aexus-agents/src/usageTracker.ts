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

export interface TurnInterimUsageTracker {
	recordRealUsage(rawUsage: EngineTurnTokenUsage, options?: { readonly cumulativeAcrossThread?: boolean }): EngineTurnTokenUsage;
	recordStreamDelta(deltaText: string, options?: { readonly skipToolErrorScan?: boolean }): void;
	recordToolError(count?: number): void;
	getToolErrorCount(): number;
	getLatestRealUsage(): EngineTurnTokenUsage | undefined;
}

/**
 * Unified per-turn streaming token usage tracker shared across Codex, Kilo/OpenCode, ACP, and Pi:
 * - Subtracts optional pre-turn baselines when an engine reports thread-cumulative totals.
 * - Throttles `onInterimUsage` callbacks so UI updates stay smooth without spamming storage.
 * - Falls back to throttled text-delta estimates mid-turn until the engine emits a real usage packet.
 */
export function createTurnInterimUsageTracker(
	promptText: string,
	onInterimUsage: ((cumulativeTurnUsage: EngineTurnTokenUsage) => void) | undefined,
	options?: { readonly preTurnBaseline?: EngineTurnTokenUsage; readonly throttleMs?: number; readonly model?: string },
): TurnInterimUsageTracker {
	const throttleMs = Math.max(0, options?.throttleMs ?? 1000);
	const baseline = options?.preTurnBaseline;
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
		recordRealUsage(rawUsage, opts) {
			if (rawUsage.hadToolError || (rawUsage.toolErrorCount ?? 0) > 0) {
				toolErrorCount = Math.max(toolErrorCount, rawUsage.toolErrorCount ?? 1);
			}
			let normalized = rawUsage;
			if (
				opts?.cumulativeAcrossThread
				&& baseline
				&& rawUsage.totalTokens >= baseline.totalTokens
				&& rawUsage.inputTokens >= baseline.inputTokens
				&& rawUsage.outputTokens >= baseline.outputTokens
			) {
				const inputTokens = Math.max(0, rawUsage.inputTokens - baseline.inputTokens);
				const outputTokens = Math.max(0, rawUsage.outputTokens - baseline.outputTokens);
				const cacheReadTokens = Math.max(0, (rawUsage.cacheReadTokens ?? 0) - (baseline.cacheReadTokens ?? 0));
				const cacheWriteTokens = Math.max(0, (rawUsage.cacheWriteTokens ?? 0) - (baseline.cacheWriteTokens ?? 0));
				const totalTokens = Math.max(
					inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
					rawUsage.totalTokens - baseline.totalTokens,
				);
				const deltaCostUsd = typeof rawUsage.costUsd === 'number' && Number.isFinite(rawUsage.costUsd)
					? (typeof baseline.costUsd === 'number' && Number.isFinite(baseline.costUsd) && rawUsage.costUsd >= baseline.costUsd
						? Math.round((rawUsage.costUsd - baseline.costUsd) * 1_000_000) / 1_000_000
						: rawUsage.costUsd)
					: undefined;
				normalized = {
					...rawUsage,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
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
