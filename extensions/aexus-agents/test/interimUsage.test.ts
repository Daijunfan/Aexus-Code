/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTurnInterimUsageTracker, estimateTextTokens, type EngineTurnTokenUsage } from '../src/usageTracker.ts';

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
});
