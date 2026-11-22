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
	readonly estimated?: boolean;
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
	recordStreamDelta(deltaText: string): void;
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
	options?: { readonly preTurnBaseline?: EngineTurnTokenUsage; readonly throttleMs?: number },
): TurnInterimUsageTracker {
	const throttleMs = Math.max(0, options?.throttleMs ?? 1000);
	const baseline = options?.preTurnBaseline;
	const promptEstTokens = estimateTextTokens(promptText);
	let streamedOutputEstTokens = 0;
	let sawRealUsage = false;
	let latestRealUsage: EngineTurnTokenUsage | undefined;
	let lastReportedAt = 0;
	let lastReportedTotal = 0;

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
			onInterimUsage(snapshot);
		} catch { /* Live usage reporting must never break the turn. */ }
	};

	return {
		recordRealUsage(rawUsage, opts) {
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
				normalized = {
					...rawUsage,
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheWriteTokens,
					totalTokens,
				};
			}
			const firstReal = !sawRealUsage;
			sawRealUsage = true;
			latestRealUsage = normalized;
			maybeEmit(normalized, firstReal);
			return normalized;
		},
		recordStreamDelta(deltaText) {
			if (!deltaText) {
				return;
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
				estimated: true,
			});
		},
		getLatestRealUsage() {
			return latestRealUsage;
		},
	};
}
