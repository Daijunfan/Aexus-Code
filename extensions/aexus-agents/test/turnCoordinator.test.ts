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

test('Interactive UI turn leapfrogs parked headless waiters without head-of-line blocking', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'claude:leapfrog-session';
	const order: string[] = [];

	// T1: active headless turn
	const t1 = await coord.acquire({ key, source: 'headless', createCts: createFakeCts });
	assert.ok(t1);
	order.push('t1-start');
	t1.cts.token.onCancellationRequested(() => {
		order.push('t1-preempted');
		setTimeout(() => coord.release(t1), 15);
	});

	// H2: second headless turn parks in the background queue behind T1
	const h2Promise = coord.acquire({ key, source: 'headless', createCts: createFakeCts }).then(lease => {
		if (lease) {
			order.push('h2-start');
			coord.release(lease);
		}
		return lease;
	});
	await delay(15);
	assert.equal(coord.getQueuedHeadlessCount(key), 1);

	// U3: human interactive UI turn arrives while T1 is active AND H2 is parked!
	// U3 MUST immediately preempt T1 and acquire BEFORE H2 runs!
	const u3 = await coord.acquire({
		key,
		source: 'ui',
		createCts: createFakeCts,
		graceTimeoutMs: 400,
	});
	assert.ok(u3);
	order.push('u3-start');
	assert.equal(coord.getQueuedHeadlessCount(key), 1, 'H2 must remain parked while U3 runs');

	await delay(15);
	order.push('u3-end');
	coord.release(u3);

	const h2 = await h2Promise;
	assert.ok(h2);
	assert.deepEqual(order, ['t1-start', 't1-preempted', 'u3-start', 'u3-end', 'h2-start']);
	assert.equal(coord.isBusy(key), false);
});

test('stop() and forceRelease() evict parked headless waiters immediately so cancelled sessions do not auto-start queued turns', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'codex:evict-waiters';

	const active = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(active);
	active.cts.token.onCancellationRequested(() => coord.release(active));

	const parked1 = coord.acquire({ key, source: 'headless', createCts: createFakeCts });
	const parked2 = coord.acquire({ key, source: 'headless', createCts: createFakeCts });
	await delay(10);
	assert.equal(coord.getQueuedHeadlessCount(key), 2);

	const stopped = await coord.stop(key, 200);
	assert.equal(stopped, true);
	assert.equal(await parked1, undefined);
	assert.equal(await parked2, undefined);
	assert.equal(coord.getQueuedHeadlessCount(key), 0);
	assert.equal(coord.isBusy(key), false);
});

test('turnTimeoutMs auto-cancels, aborts abortSignal, and force-kills wedged turns so sessions never deadlock forever', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'kilo:deadline-watchdog';
	let forceKills = 0;
	let signalAborted = false;

	const wedged = await coord.acquire({
		key,
		source: 'headless',
		createCts: createFakeCts,
		turnTimeoutMs: 45,
		graceTimeoutMs: 30,
		forceKillTimeoutMs: 200,
		forceKill: async () => { forceKills += 1; },
	});
	assert.ok(wedged);
	wedged.abortSignal.addEventListener('abort', () => {
		signalAborted = true;
	}, { once: true });

	// Do NOT call coord.release(wedged) — watchdog must cancel, abort signal, forceKill, and evict lock!
	await delay(130);
	assert.equal(wedged.cts.token.isCancellationRequested, true);
	assert.equal(signalAborted, true);
	assert.equal(forceKills, 1);
	assert.equal(coord.isBusy(key), false);
});

test('cancelling a middle queued UI waiter preserves uiChains serialization between U1 and U3 (#67 P2-7)', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'claude:ui-chain-cancel';
	const order: string[] = [];

	const u1 = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(u1);
	order.push('u1-start');

	// U1 stays active while U1b (waiting on U1) and U2 (cancelled mid-wait) and U3 queue behind it
	let releaseU1!: () => void;
	u1.cts.token.onCancellationRequested(() => {
		setTimeout(() => {
			order.push('u1-released');
			coord.release(u1);
			releaseU1?.();
		}, 40);
	});

	const u1bPromise = coord.acquire({ key, source: 'ui', createCts: createFakeCts, graceTimeoutMs: 200 });
	await delay(5);

	const u2Ext = createFakeCts();
	const u2Promise = coord.acquire({ key, source: 'ui', createCts: createFakeCts, externalToken: u2Ext.token, graceTimeoutMs: 200 });
	await delay(5);

	// Cancel U2 while U2 IS THE TAIL WAITER (`uiChains[key] === currentTail_2`) BEFORE U3 arrives (#78 item 2)!
	// `uiChains[key]` must stay pinned until U1b (`previousTail`) finishes so U3 arriving afterwards still waits behind U1b.
	u2Ext.cancel();
	assert.equal(await u2Promise, undefined);

	const u3Promise = coord.acquire({ key, source: 'ui', createCts: createFakeCts, graceTimeoutMs: 200 });
	await delay(5);

	const u1b = await u1bPromise;
	assert.ok(u1b);
	order.push('u1b-acquired');
	u1b.cts.token.onCancellationRequested(() => {
		order.push('u1b-preempted-by-u3');
		coord.release(u1b);
	});

	const u3 = await u3Promise;
	assert.ok(u3);
	order.push('u3-acquired');
	coord.release(u3);

	assert.deepEqual(order, ['u1-start', 'u1-released', 'u1b-acquired', 'u1b-preempted-by-u3', 'u3-acquired']);
	assert.equal(coord.isBusy(key), false);
});

test('headless acquire with preemptActive=true immediately preempts active turn and leapfrogs queued headless waiters', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'claude:busy-immediate-push';
	const order: string[] = [];

	const h1 = await coord.acquire({ key, source: 'headless', createCts: createFakeCts });
	assert.ok(h1);
	order.push('h1-start');
	h1.cts.token.onCancellationRequested(() => {
		order.push('h1-cancelled');
		coord.release(h1);
	});

	// Polite queued headless waiter (default busyTokenDeliveryMode === 'queue')
	const hQueuedPromise = coord.acquire({ key, source: 'headless', createCts: createFakeCts });
	await delay(10);
	assert.equal(coord.getQueuedHeadlessCount(key), 1);

	// Immediate push headless waiter (`preemptActive: true` for busyTokenDeliveryMode === 'immediate')
	const hImmediate = await coord.acquire({
		key,
		source: 'headless',
		preemptActive: true,
		createCts: createFakeCts,
		onPreempt: (_prev, reason) => { order.push(`preempt:${reason}`); },
	});
	assert.ok(hImmediate, 'immediate push must acquire lease right away');
	order.push('hImmediate-start');
	coord.release(hImmediate);

	const hQueued = await hQueuedPromise;
	assert.ok(hQueued, 'queued waiter resumes after immediate push finishes');
	order.push('hQueued-start');
	coord.release(hQueued);

	assert.deepEqual(order, ['h1-start', 'h1-cancelled', 'preempt:headless', 'hImmediate-start', 'hQueued-start']);
	assert.equal(coord.isBusy(key), false);
});

test('multiple steer waiters parked behind a human UI turn execute sequentially in FIFO order without S2 falsely cancelling S1', async () => {
	const coord = new SessionTurnCoordinator();
	const key = 'claude:multi-steer-after-ui';
	const order: string[] = [];

	const u1 = await coord.acquire({ key, source: 'ui', createCts: createFakeCts });
	assert.ok(u1);
	order.push('u1-start');

	const s1Promise = coord.acquire({
		key,
		source: 'headless',
		preemptActive: true,
		createCts: createFakeCts,
		ticketId: 'tk_s1',
	}).then(async s1 => {
		assert.ok(s1);
		order.push('s1-start');
		s1.cts.token.onCancellationRequested(() => {
			order.push('s1-falsely-cancelled');
		});
		await delay(25);
		order.push('s1-end');
		coord.release(s1);
	});

	await delay(5);

	const s2Promise = coord.acquire({
		key,
		source: 'headless',
		preemptActive: true,
		createCts: createFakeCts,
		ticketId: 'tk_s2',
	}).then(async s2 => {
		assert.ok(s2);
		order.push('s2-start');
		await delay(10);
		order.push('s2-end');
		coord.release(s2);
	});

	await delay(15);
	assert.equal(u1.cts.token.isCancellationRequested, false, 'Human UI turn must never be interrupted by steer waiters');

	order.push('u1-end');
	coord.release(u1);

	await Promise.all([s1Promise, s2Promise]);
	assert.deepEqual(order, ['u1-start', 'u1-end', 's1-start', 's1-end', 's2-start', 's2-end']);
	assert.equal(coord.isBusy(key), false);
});
