/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	createMultiStepTurnUsageAccumulator,
	createStreamToolErrorScanner,
	createTurnInterimUsageTracker,
	detectToolErrorInProgressText,
	detectToolErrorInStreamChunk,
	detectToolErrorInStreamPart,
	estimateTextTokens,
	type EngineTurnTokenUsage,
} from '../src/usageTracker.ts';

describe('createTurnInterimUsageTracker (multi-engine live streaming usage)', () => {
	test('emits estimated delta usage mid-turn before real usage arrives, then transitions cleanly to real usage', () => {
		const emitted: EngineTurnTokenUsage[] = [];
		const tracker = createTurnInterimUsageTracker('Implement user auth endpoint with unit tests', u => emitted.push(u), {
			throttleMs: 0,
		});

		tracker.recordStreamDelta('Working on src/auth.ts and writing tests...');
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].estimated, true);
		assert.ok(emitted[0].inputTokens >= estimateTextTokens('Implement user auth endpoint with unit tests'));
		assert.ok(emitted[0].outputTokens > 0);

		const real = tracker.recordRealUsage({
			inputTokens: 4200,
			outputTokens: 650,
			cacheReadTokens: 1200,
			cacheWriteTokens: 0,
			totalTokens: 6050,
			estimated: false,
		});
		assert.equal(real.totalTokens, 6050);
		assert.equal(emitted.length, 2);
		assert.equal(emitted[1].estimated, false);
		assert.equal(emitted[1].totalTokens, 6050);

		// Once real usage has arrived, further text deltas must NOT emit stale estimated payloads.
		tracker.recordStreamDelta('More trailing summary text...');
		assert.equal(emitted.length, 2);
		assert.deepEqual(tracker.getLatestRealUsage(), real);
	});

	test('subtracts pre-turn cumulative thread baseline on Turn 2+ without double-counting Turn 1', () => {
		const emitted: EngineTurnTokenUsage[] = [];
		const turn1Raw: EngineTurnTokenUsage = {
			inputTokens: 1000,
			outputTokens: 300,
			cacheReadTokens: 400,
			cacheWriteTokens: 100,
			totalTokens: 1800,
			estimated: false,
		};
		const tracker = createTurnInterimUsageTracker('Follow-up prompt', u => emitted.push(u), {
			preTurnBaseline: turn1Raw,
			throttleMs: 0,
		});

		const normalized = tracker.recordRealUsage({
			inputTokens: 1600,
			outputTokens: 550,
			cacheReadTokens: 900,
			cacheWriteTokens: 100,
			totalTokens: 3150,
			estimated: false,
		}, { cumulativeAcrossThread: true });

		assert.deepEqual(normalized, {
			inputTokens: 600,
			outputTokens: 250,
			cacheReadTokens: 500,
			cacheWriteTokens: 0,
			totalTokens: 1350,
			estimated: false,
		});
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].totalTokens, 1350);
	});

	test('leaves per-turn usage untouched when raw counts are smaller than prior cumulative baseline', () => {
		const tracker = createTurnInterimUsageTracker('Short prompt', undefined, {
			preTurnBaseline: {
				inputTokens: 5000,
				outputTokens: 2000,
				totalTokens: 7000,
				estimated: false,
			},
			throttleMs: 0,
		});
		const perTurn = tracker.recordRealUsage({
			inputTokens: 400,
			outputTokens: 120,
			totalTokens: 520,
			estimated: false,
		}, { cumulativeAcrossThread: true });
		assert.equal(perTurn.inputTokens, 400);
		assert.equal(perTurn.outputTokens, 120);
		assert.equal(perTurn.totalTokens, 520);
	});

	test('propagates resolved model and subtracts cumulative real costUsd across thread turns', () => {
		const emitted: EngineTurnTokenUsage[] = [];
		const turn1Raw: EngineTurnTokenUsage = {
			inputTokens: 2000,
			outputTokens: 500,
			totalTokens: 2500,
			costUsd: 0.015,
			model: 'openai/gpt-5.3-codex',
			estimated: false,
		};
		const tracker = createTurnInterimUsageTracker('Second turn', u => emitted.push(u), {
			preTurnBaseline: turn1Raw,
			model: 'openai/gpt-5.3-codex',
			throttleMs: 0,
		});

		tracker.recordStreamDelta('Streaming response chunk...');
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].model, 'openai/gpt-5.3-codex');

		const turn2Delta = tracker.recordRealUsage({
			inputTokens: 3200,
			outputTokens: 900,
			totalTokens: 4100,
			costUsd: 0.028,
			estimated: false,
		}, { cumulativeAcrossThread: true });

		assert.equal(turn2Delta.inputTokens, 1200);
		assert.equal(turn2Delta.outputTokens, 400);
		assert.equal(turn2Delta.costUsd, 0.013);
		assert.equal(turn2Delta.model, 'openai/gpt-5.3-codex');
	});

	test('detects tool/command failures in stream chunks & parts and propagates hadToolError / toolErrorCount (Audit #24)', () => {
		// Positive detections for real shell / compiler / test / tool failures
		assert.equal(detectToolErrorInStreamChunk('Command failed with exit code 1'), true);
		assert.equal(detectToolErrorInStreamChunk('Process exited with code 127'), true);
		assert.equal(detectToolErrorInStreamChunk('src/foo.ts(12,5): error TS2304: Cannot find name "foo".'), true);
		assert.equal(detectToolErrorInStreamChunk('FAIL src/auth.test.ts\nAssertionError: expected 1 to equal 2'), true);
		assert.equal(detectToolErrorInStreamChunk('Traceback (most recent call last):\n  File "app.py", line 4'), true);
		assert.equal(detectToolErrorInStreamChunk('Tool failed: ENOENT no such file or directory'), true);

		// Negative checks: normal prose / zero-error summaries must NOT false-positive
		assert.equal(detectToolErrorInStreamChunk('All 42 tests passed with 0 errors and exit code 0.'), false);
		assert.equal(detectToolErrorInStreamChunk('Added error handling middleware to src/server.ts.'), false);
		assert.equal(detectToolErrorInStreamChunk('Refactored retry logic for network timeouts.'), false);

		// Structured ChatToolInvocationPart error detection (including errorMessage, resultDetails, invocationMessage)
		assert.equal(detectToolErrorInStreamPart({ isError: true }), true);
		assert.equal(detectToolErrorInStreamPart({ errorMessage: 'Permission denied' }), true);
		assert.equal(detectToolErrorInStreamPart({ resultDetails: { isError: true } }), true);
		assert.equal(detectToolErrorInStreamPart({ invocationMessage: 'Command failed with exit code 2' }), true);
		assert.equal(detectToolErrorInStreamPart({ isError: false, invocationMessage: 'Running pnpm test' }), false);

		// Rolling stream scanner catches errors split across consecutive token deltas without false-positiving on progress thinking text
		const scanner = createStreamToolErrorScanner();
		assert.equal(scanner.scan('Running build... exit '), false);
		assert.equal(scanner.scan('code 2 in src/app.ts'), true);
		assert.equal(scanner.scan('continuing cleanly'), false);
		assert.equal(detectToolErrorInProgressText('Thinking about how to guard TypeError: undefined property'), false);
		assert.equal(detectToolErrorInProgressText('Command failed with exit code 1'), true);

		// Tracker propagates tool error flags onto both interim and final usage packets and skips thinking deltas
		const emitted: EngineTurnTokenUsage[] = [];
		const tracker = createTurnInterimUsageTracker('Fix failing build', u => emitted.push(u), {
			model: 'deepseek-r1',
			throttleMs: 0,
		});
		tracker.recordStreamDelta('Reasoning: TypeError: x is undefined could happen if null', { skipToolErrorScan: true });
		assert.equal(tracker.getToolErrorCount(), 0);
		assert.equal(emitted[0].hadToolError, undefined);

		tracker.recordToolError();
		tracker.recordStreamDelta('Investigating failing test output...');
		assert.equal(emitted[emitted.length - 1].hadToolError, true);
		assert.equal(emitted[emitted.length - 1].toolErrorCount, 1);

		tracker.recordToolError(2);
		const real = tracker.recordRealUsage({
			inputTokens: 4500,
			outputTokens: 900,
			totalTokens: 5400,
			estimated: false,
		});
		assert.equal(real.hadToolError, true);
		assert.equal(real.toolErrorCount, 3);
		assert.equal(emitted[emitted.length - 1].hadToolError, true);
		assert.equal(emitted[emitted.length - 1].toolErrorCount, 3);
	});

	test('createMultiStepTurnUsageAccumulator sums distinct assistant tool-loop steps while deduplicating progressive same-step updates', () => {
		const acc = createMultiStepTurnUsageAccumulator();
		// Step 1 streams progressive update then final update for msg_1
		acc.recordStep('msg_1', {
			inputTokens: 1200,
			outputTokens: 80,
			cacheReadTokens: 500,
			cacheWriteTokens: 100,
			totalTokens: 1880,
			costUsd: 0.004,
			model: 'claude-sonnet-4-6',
			estimated: false,
		});
		const afterStep1Final = acc.recordStep('msg_1', {
			inputTokens: 1200,
			outputTokens: 200,
			cacheReadTokens: 500,
			cacheWriteTokens: 100,
			totalTokens: 2000,
			costUsd: 0.006,
			model: 'claude-sonnet-4-6',
			estimated: false,
		});
		assert.equal(acc.stepCount, 1);
		assert.equal(afterStep1Final.outputTokens, 200);

		// Step 2 (after tool execution) has its own per-call usage
		const afterStep2 = acc.recordStep('msg_2', {
			inputTokens: 1500,
			outputTokens: 350,
			cacheReadTokens: 1600,
			cacheWriteTokens: 50,
			totalTokens: 3500,
			costUsd: 0.009,
			model: 'claude-sonnet-4-6',
			estimated: false,
		});
		assert.equal(acc.stepCount, 2);
		assert.deepEqual(afterStep2, {
			inputTokens: 2700,
			outputTokens: 550,
			cacheReadTokens: 2100,
			cacheWriteTokens: 150,
			totalTokens: 5500,
			costUsd: 0.015,
			model: 'claude-sonnet-4-6',
			estimated: false,
		});
	});

	test('subtracts cumulative baseline outputTokens and costUsd even when inputTokens dips after context compaction', () => {
		const preCompactionBaseline: EngineTurnTokenUsage = {
			inputTokens: 80_000,
			outputTokens: 12_000,
			cacheReadTokens: 40_000,
			cacheWriteTokens: 5_000,
			totalTokens: 137_000,
			costUsd: 0.42,
			estimated: false,
		};
		const tracker = createTurnInterimUsageTracker('Post-compaction turn', undefined, {
			preTurnBaseline: preCompactionBaseline,
			throttleMs: 0,
		});

		// After auto-compaction, current prompt inputTokens drops from 80k -> 9k, while cumulative thread outputTokens & costUsd continue growing monotonically!
		const delta = tracker.recordRealUsage({
			inputTokens: 9_000,
			outputTokens: 12_600,
			cacheReadTokens: 2_000,
			cacheWriteTokens: 500,
			totalTokens: 24_100,
			costUsd: 0.45,
			estimated: false,
		}, { cumulativeAcrossThread: true });

		assert.equal(delta.inputTokens, 9_000);
		assert.equal(delta.outputTokens, 600, 'Must subtract 12,000 baseline outputTokens instead of charging 12,600');
		assert.equal(delta.costUsd, 0.03, 'Must subtract $0.42 baseline costUsd instead of re-charging historical cost');
	});
});
