/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SessionTurnCoordinator,
	type ExternalCancellationToken,
	type TurnCancellationHandle,
	type TurnPreemptReason,
} from '../src/turnCoordinator.ts';

function createFakeCts(): TurnCancellationHandle {
	let cancelled = false;
	const listeners = new Set<() => unknown>();
	const token: ExternalCancellationToken = {
		get isCancellationRequested() {
			return cancelled;
		},
		onCancellationRequested(listener: () => unknown) {
			if (cancelled) {
				listener();
				return { dispose() { } };
			}
			listeners.add(listener);
			return { dispose: () => { listeners.delete(listener); } };
		},
	};
	return {
		token,
		cancel() {
			if (cancelled) {
				return;
			}
			cancelled = true;
			for (const l of [...listeners]) {
				l();
			}
			listeners.clear();
		},
		dispose() {
			listeners.clear();
		},
	};
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

test('UI turn cleanly preempts an invisible headless background turn instead of throwing', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:conv-1';

	const headlessLease = await coord.acquire({
		key,
		source: 'headless',
		createCts: createFakeCts,
	});
	assert.ok(headlessLease);
	assert.equal(coord.isBusy(key), true);

	// Headless turn releases shortly after cancellation fires
	headlessLease.cts.token.onCancellationRequested(() => {
		setTimeout(() => coord.release(headlessLease), 15);
	});

	const reasons: TurnPreemptReason[] = [];
	const uiLease = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		onPreempt: (_prev, reason) => reasons.push(reason),
		graceTimeoutMs: 500,
	});

	assert.ok(uiLease);
	assert.deepEqual(reasons, ['headless']);
	assert.equal(headlessLease.cts.token.isCancellationRequested, true);
	assert.equal(coord.get(key)?.id, uiLease.id);

	coord.release(uiLease);
	assert.equal(coord.isBusy(key), false);
});

test('UI turn recovers automatically via forceKill when a cancelled ACP turn hangs forever', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:wedged-session';
	let forceKilled = 0;

	const stuckLease = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		forceKill: async () => {
			forceKilled++;
		},
	});
	assert.ok(stuckLease);

	// Simulate user clicking Stop -> token cancelled, but engine ignores session/cancel and NEVER calls release!
	stuckLease.cts.cancel();

	const reasons: TurnPreemptReason[] = [];
	const nextLease = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		onPreempt: (_prev, reason) => reasons.push(reason),
		graceTimeoutMs: 40,
		forceKillTimeoutMs: 200,
	});

	assert.ok(nextLease);
	assert.deepEqual(reasons, ['cancelled']);
	assert.equal(forceKilled, 1);
	assert.equal(coord.get(key)?.id, nextLease.id);

	// When the old wedged turn finally wakes up and runs its `finally`, it MUST NOT clobber the new turn's lock!
	coord.release(stuckLease);
	assert.equal(coord.isBusy(key), true);
	assert.equal(coord.get(key)?.id, nextLease.id);

	coord.release(nextLease);
	assert.equal(coord.isBusy(key), false);
});

test('UI turn waits smoothly when previous turn is already settling (post-send save)', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:settling-session';

	const first = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(first);
	first.markSettling();
	setTimeout(() => coord.release(first), 20);

	const reasons: TurnPreemptReason[] = [];
	const second = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		onPreempt: (_prev, reason) => reasons.push(reason),
		graceTimeoutMs: 500,
	});

	assert.ok(second);
	assert.deepEqual(reasons, ['settling']);
	assert.equal(first.cts.token.isCancellationRequested, false);
	coord.release(second);
	assert.equal(coord.isBusy(key), false);
});

test('Headless turn waits politely for a live human UI turn instead of cancelling it', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:governor';

	const uiLease = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(uiLease);

	let headlessAcquired = false;
	const headlessPromise = coord.acquire({
		key,
		source: 'headless',
		createCts: createFakeCts,
	}).then(lease => {
		headlessAcquired = true;
		return lease;
	});

	await delay(30);
	// UI turn must NOT be cancelled or preempted by headless dispatch!
	assert.equal(uiLease.cts.token.isCancellationRequested, false);
	assert.equal(headlessAcquired, false);

	coord.release(uiLease);
	const headlessLease = await headlessPromise;
	assert.ok(headlessLease);
	assert.equal(headlessAcquired, true);
	assert.equal(coord.get(key)?.id, headlessLease.id);
	coord.release(headlessLease);
	assert.equal(coord.isBusy(key), false);
});

test('Headless turn recovers if the live UI turn it is waiting on gets cancelled and wedges', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:governor-cancel';
	let forceKilled = 0;

	const uiLease = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		forceKill: async () => { forceKilled++; },
	});
	assert.ok(uiLease);

	const headlessPromise = coord.acquire({
		key,
		source: 'headless',
		createCts: createFakeCts,
		graceTimeoutMs: 40,
	});

	await delay(20);
	// Now user clicks Stop on the UI turn, but UI engine wedges and never calls release.
	uiLease.cts.cancel();

	const headlessLease = await headlessPromise;
	assert.ok(headlessLease);
	assert.equal(forceKilled, 1);
	coord.release(headlessLease);
	assert.equal(coord.isBusy(key), false);
});

test('stop() cancels active turn and escalates to forceKill + lock eviction if wedged', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:stop-test';
	let forceKilled = 0;

	const lease = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		forceKill: async () => { forceKilled++; },
	});
	assert.ok(lease);

	const stopped = await coord.stop(key, 40, 200);
	assert.equal(stopped, true);
	assert.equal(lease.cts.token.isCancellationRequested, true);
	assert.equal(forceKilled, 1);
	assert.equal(coord.isBusy(key), false);

	assert.equal(await coord.stop(key, 40), false);
});

test('Concurrent UI acquires serialize strictly without TOCTOU overlap or leaked locks', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:concurrent';
	const order: string[] = [];

	const p1 = coord.acquire({ key, source: 'ui', createCts: createFakeCts, graceTimeoutMs: 50 }).then(async l => {
		assert.ok(l);
		order.push('start-1');
		await delay(20);
		order.push('end-1');
		coord.release(l);
	});
	const p2 = coord.acquire({ key, source: 'ui', createCts: createFakeCts, graceTimeoutMs: 100 }).then(async l => {
		assert.ok(l);
		order.push('start-2');
		coord.release(l);
	});

	await Promise.all([p1, p2]);
	assert.deepEqual(order, ['start-1', 'end-1', 'start-2']);
	assert.equal(coord.isBusy(key), false);
});

test('External cancellation while waiting in acquire() aborts cleanly without stealing lock', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:ext-cancel';

	const first = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(first);

	const callerCts = createFakeCts();
	const waiting = coord.acquire({
		key,
		source: 'headless',
		createCts: createFakeCts,
		externalToken: callerCts.token,
	});
	await delay(15);
	callerCts.cancel();

	const res = await waiting;
	assert.equal(res, undefined);
	assert.equal(coord.get(key)?.id, first.id);

	coord.release(first);
	assert.equal(coord.isBusy(key), false);
});

test('UI turn cleanly interrupts an active live UI turn (supportsInterruptions) with bounded grace', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:interrupt';

	const first = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(first);
	first.cts.token.onCancellationRequested(() => {
		setTimeout(() => coord.release(first), 10);
	});

	const reasons: TurnPreemptReason[] = [];
	const second = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		onPreempt: (_prev, reason) => reasons.push(reason),
		graceTimeoutMs: 500,
	});
	assert.ok(second);
	assert.deepEqual(reasons, ['interrupted']);
	assert.equal(first.cts.token.isCancellationRequested, true);
	assert.equal(coord.get(key)?.id, second.id);
	coord.release(second);
	assert.equal(coord.isBusy(key), false);
});

test('forceRelease cancels, invokes forceKill once, and immediately clears lock', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'antigravity:kill';
	let forceKilled = 0;

	const lease = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		forceKill: async () => { forceKilled++; },
	});
	assert.ok(lease);

	const released = await coord.forceRelease(key, 200);
	assert.equal(released, true);
	assert.equal(lease.cts.token.isCancellationRequested, true);
	assert.equal(forceKilled, 1);
	assert.equal(coord.isBusy(key), false);

	// Subsequent stale release is a safe no-op
	coord.release(lease);
	assert.equal(coord.isBusy(key), false);
});
