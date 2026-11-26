/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type TurnSource = 'ui' | 'headless';
export type TurnPreemptReason = 'settling' | 'cancelled' | 'headless' | 'interrupted';

export interface ExternalCancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => unknown): { dispose(): void };
}

export interface TurnCancellationHandle {
	readonly token: ExternalCancellationToken;
	cancel(): void;
	dispose(): void;
}

export interface TurnLease<TCts extends TurnCancellationHandle> {
	readonly key: string;
	readonly id: number;
	readonly source: TurnSource;
	readonly cts: TCts;
	readonly abortSignal: AbortSignal;
	readonly startedAt: number;
	readonly lastActivityAt: number;
	readonly done: Promise<void>;
	readonly isSettling: boolean;
	readonly timedOut: boolean;
	readonly idleTimedOut: boolean;
	readonly externalWaitCount: number;
	readonly ticketId?: string;
	readonly taskId?: string;
	markSettling(): void;
	touchActivity(): void;
	beginExternalWait(): void;
	endExternalWait(): void;
}

export interface AcquireTurnOptions<TCts extends TurnCancellationHandle> {
	readonly key: string;
	readonly source: TurnSource;
	readonly createCts: () => TCts;
	readonly externalToken?: ExternalCancellationToken;
	readonly externalSignal?: AbortSignal;
	/** Context-preserving interruption hook (`killTree: false`) invoked before grace-window escalation. */
	readonly interruptActive?: () => Promise<void>;
	readonly forceKill?: () => Promise<void>;
	readonly onPreempt?: (previous: TurnLease<TCts>, reason: TurnPreemptReason) => void;
	readonly graceTimeoutMs?: number;
	readonly forceKillTimeoutMs?: number;
	readonly turnTimeoutMs?: number;
	readonly idleStallTimeoutMs?: number;
	readonly waitTimeoutMs?: number;
	readonly preemptActive?: boolean;
	readonly ticketId?: string;
	readonly taskId?: string;
}

interface InternalTurnLease<TCts extends TurnCancellationHandle> extends TurnLease<TCts> {
	lastActivityAt: number;
	externalWaitCount: number;
	isSettling: boolean;
	timedOut: boolean;
	idleTimedOut: boolean;
	readonly startedSeq: number;
	readonly abortController: AbortController;
	readonly ctsTokenSub: { dispose(): void };
	readonly interruptActive?: () => Promise<void>;
	readonly forceKill?: () => Promise<void>;
	readonly resolveDone: () => void;
	turnDeadlineTimer?: ReturnType<typeof setTimeout>;
	idleStallTimer?: ReturnType<typeof setTimeout>;
	forceKillPromise?: Promise<void>;
}

interface HeadlessWaiter {
	cancelled: boolean;
	readonly enqueuedSeq: number;
	readonly preemptActive?: boolean;
	readonly ticketId?: string;
	readonly taskId?: string;
	wake(): void;
	cancel(): void;
}

const DEFAULT_GRACE_TIMEOUT_MS = 2500;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;

function createSignalToken(signal: AbortSignal | undefined): ExternalCancellationToken | undefined {
	if (!signal) {
		return undefined;
	}
	return {
		get isCancellationRequested() {
			return signal.aborted;
		},
		onCancellationRequested(listener: () => unknown) {
			if (signal.aborted) {
				listener();
				return { dispose() { } };
			}
			const onAbort = () => listener();
			signal.addEventListener('abort', onAbort, { once: true });
			return {
				dispose() {
					signal.removeEventListener('abort', onAbort);
				},
			};
		},
	};
}

function racePromiseWithTimeoutAndToken(
	promise: Promise<void>,
	timeoutMs: number | undefined,
	...tokens: ReadonlyArray<ExternalCancellationToken | undefined>
): Promise<'done' | 'timeout' | 'cancelled'> {
	for (const tok of tokens) {
		if (tok?.isCancellationRequested) {
			return Promise.resolve('cancelled');
		}
	}
	return new Promise(resolve => {
		let settled = false;
		const disposables: Array<{ dispose(): void }> = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (outcome: 'done' | 'timeout' | 'cancelled') => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			for (const d of disposables) {
				try { d.dispose(); } catch { /* ignore */ }
			}
			disposables.length = 0;
			resolve(outcome);
		};
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
			timer.unref?.();
		}
		for (const tok of tokens) {
			if (!tok) {
				continue;
			}
			disposables.push(tok.onCancellationRequested(() => finish('cancelled')));
		}
		promise.then(() => finish('done'), () => finish('done'));
	});
}

/**
 * Three-tier session turn coordinator (`human_ui > ticket_steer > ticket_queue`):
 * - Interactive `ui` turns preempt active turns via context-preserving `interruptActive` (`killTree: false`)
 *   and leapfrog parked headless waiters.
 * - `ticket_steer` (`preemptActive: true`) preempts an active headless turn via `interruptActive`
 *   and inserts ahead of pending `ticket_queue` items without clearing the rest of the queue.
 * - `cancelTicketTurns` selectively evicts invalidated/destroyed ticket waiters without killing unrelated turns.
 */
export class SessionTurnCoordinator<TCts extends TurnCancellationHandle> {
	private readonly active = new Map<string, InternalTurnLease<TCts>>();
	private readonly uiChains = new Map<string, Promise<void>>();
	private readonly pendingUiCounts = new Map<string, number>();
	private readonly headlessQueues = new Map<string, HeadlessWaiter[]>();
	private nextLeaseId = 0;
	private nextEventSeq = 0;

	isBusy(key: string): boolean {
		return this.active.has(key);
	}

	get(key: string): TurnLease<TCts> | undefined {
		return this.active.get(key);
	}

	getQueuedHeadlessCount(key: string): number {
		return this.headlessQueues.get(key)?.length ?? 0;
	}

	async acquire(options: AcquireTurnOptions<TCts>): Promise<TurnLease<TCts> | undefined> {
		const extSigToken = createSignalToken(options.externalSignal);
		if (options.externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
			return undefined;
		}
		if (options.source === 'ui') {
			return this.acquireUi(options, extSigToken);
		}
		return this.acquireHeadless(options, extSigToken);
	}

	private async acquireUi(
		options: AcquireTurnOptions<TCts>,
		extSigToken: ExternalCancellationToken | undefined,
	): Promise<TurnLease<TCts> | undefined> {
		const {
			key,
			externalToken,
			onPreempt,
			graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS,
			forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
		} = options;

		this.pendingUiCounts.set(key, (this.pendingUiCounts.get(key) ?? 0) + 1);
		const previousTail = this.uiChains.get(key) ?? Promise.resolve();
		let releaseChain!: () => void;
		const gatePromise = new Promise<void>(resolve => { releaseChain = resolve; });
		const currentTail = previousTail.catch(() => undefined).then(() => gatePromise);
		this.uiChains.set(key, currentTail);

		try {
			const queueWait = await racePromiseWithTimeoutAndToken(previousTail, undefined, externalToken, extSigToken);
			if (queueWait === 'cancelled' || externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
				return undefined;
			}

			while (true) {
				if (externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
					return undefined;
				}
				const existing = this.active.get(key);
				if (!existing) {
					break;
				}

				let reason: TurnPreemptReason;
				if (existing.isSettling) {
					reason = 'settling';
				} else if (existing.cts.token.isCancellationRequested) {
					reason = 'cancelled';
				} else if (existing.source === 'headless') {
					reason = 'headless';
					existing.cts.cancel();
					void existing.interruptActive?.().catch(() => undefined);
				} else {
					reason = 'interrupted';
					existing.cts.cancel();
					void existing.interruptActive?.().catch(() => undefined);
				}
				try { onPreempt?.(existing, reason); } catch { /* ignore */ }

				const outcome = await racePromiseWithTimeoutAndToken(existing.done, graceTimeoutMs, externalToken, extSigToken);
				if (outcome === 'cancelled' || externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
					return undefined;
				}
				if (this.active.get(key) === existing) {
					await this.forceEvict(existing, forceKillTimeoutMs);
				}
			}

			if (externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
				return undefined;
			}
			return this.mintAndActivateLease(options);
		} finally {
			const remainingUi = (this.pendingUiCounts.get(key) ?? 1) - 1;
			if (remainingUi <= 0) {
				this.pendingUiCounts.delete(key);
			} else {
				this.pendingUiCounts.set(key, remainingUi);
			}
			releaseChain();
			void currentTail.finally(() => {
				if (this.uiChains.get(key) === currentTail) {
					this.uiChains.delete(key);
				}
			});
			this.wakeHeadlessWaiters(key);
		}
	}

	private async acquireHeadless(
		options: AcquireTurnOptions<TCts>,
		extSigToken: ExternalCancellationToken | undefined,
	): Promise<TurnLease<TCts> | undefined> {
		const {
			key,
			externalToken,
			graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS,
			forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
			waitTimeoutMs,
		} = options;

		const waitDeadline = typeof waitTimeoutMs === 'number' && Number.isFinite(waitTimeoutMs) && waitTimeoutMs >= 0
			? Date.now() + waitTimeoutMs
			: undefined;

		let wakeResolve: (() => void) | undefined;
		let cancelListeners: Array<() => unknown> = [];
		const waiter: HeadlessWaiter = {
			cancelled: false,
			enqueuedSeq: ++this.nextEventSeq,
			preemptActive: Boolean(options.preemptActive),
			ticketId: options.ticketId,
			taskId: options.taskId,
			wake() {
				const fn = wakeResolve;
				wakeResolve = undefined;
				fn?.();
			},
			cancel() {
				if (this.cancelled) {
					return;
				}
				this.cancelled = true;
				const fn = wakeResolve;
				wakeResolve = undefined;
				fn?.();
				for (const l of [...cancelListeners]) {
					try { l(); } catch { /* ignore */ }
				}
				cancelListeners = [];
			},
		};
		const waiterToken: ExternalCancellationToken = {
			get isCancellationRequested() {
				return waiter.cancelled;
			},
			onCancellationRequested(listener: () => unknown) {
				if (waiter.cancelled) {
					listener();
					return { dispose() { } };
				}
				cancelListeners.push(listener);
				return {
					dispose() {
						const idx = cancelListeners.indexOf(listener);
						if (idx >= 0) {
							cancelListeners.splice(idx, 1);
						}
					},
				};
			},
		};

		let queue = this.headlessQueues.get(key);
		if (!queue) {
			queue = [];
			this.headlessQueues.set(key, queue);
		}
		if (options.preemptActive) {
			let insertIdx = 0;
			while (insertIdx < queue.length && queue[insertIdx].preemptActive) {
				insertIdx++;
			}
			queue.splice(insertIdx, 0, waiter);
		} else {
			queue.push(waiter);
		}

		const nextWakeSignal = (): Promise<void> => new Promise<void>(resolve => {
			wakeResolve = resolve;
		});

		try {
			while (true) {
				if (waiter.cancelled || externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
					return undefined;
				}
				const remainingWaitMs = waitDeadline !== undefined ? waitDeadline - Date.now() : undefined;
				if (remainingWaitMs !== undefined && remainingWaitMs <= 0) {
					return undefined;
				}

				const isHeadOfHeadlessQueue = queue[0] === waiter;
				const uiPending = (this.pendingUiCounts.get(key) ?? 0) > 0;
				const existing = this.active.get(key);

				if (uiPending || !isHeadOfHeadlessQueue) {
					const wakePromise = nextWakeSignal();
					const outcome = await racePromiseWithTimeoutAndToken(
						wakePromise,
						remainingWaitMs,
						externalToken,
						extSigToken,
						waiterToken,
					);
					if (outcome !== 'done') {
						return undefined;
					}
					continue;
				}

				if (!existing) {
					return this.mintAndActivateLease(options);
				}

				// Note: per §7.2.1, `steer` (`preemptActive`) NEVER interrupts an active `human_ui` (`source === 'ui'`) turn;
				// it waits politely for the human turn to finish and runs immediately as #1 afterwards!
				// Monotonic `enqueuedSeq > existing.startedSeq` ensures multiple `steer` tickets queued concurrently execute independently in FIFO order.
				const canPreemptExisting = Boolean(options.preemptActive) && existing.source === 'headless' && waiter.enqueuedSeq > existing.startedSeq;
				if (canPreemptExisting || existing.isSettling || existing.cts.token.isCancellationRequested) {
					if (canPreemptExisting && !existing.isSettling && !existing.cts.token.isCancellationRequested) {
						existing.cts.cancel();
						void existing.interruptActive?.().catch(() => undefined);
						try { options.onPreempt?.(existing, 'headless'); } catch { /* ignore */ }
					}
					const effectiveGraceMs = remainingWaitMs !== undefined
						? Math.min(graceTimeoutMs, Math.max(0, remainingWaitMs))
						: graceTimeoutMs;
					const outcome = await racePromiseWithTimeoutAndToken(
						existing.done,
						effectiveGraceMs,
						externalToken,
						extSigToken,
						waiterToken,
					);
					if (outcome === 'cancelled' || waiter.cancelled || externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
						return undefined;
					}
					if (waitDeadline !== undefined && Date.now() >= waitDeadline) {
						return undefined;
					}
					if ((this.pendingUiCounts.get(key) ?? 0) === 0 && this.active.get(key) === existing) {
						await this.forceEvict(existing, forceKillTimeoutMs);
					}
					continue;
				}

				const outcome = await racePromiseWithTimeoutAndToken(
					existing.done,
					remainingWaitMs,
					externalToken,
					extSigToken,
					waiterToken,
					existing.cts.token,
				);
				if (outcome === 'timeout' || waiter.cancelled || externalToken?.isCancellationRequested || extSigToken?.isCancellationRequested) {
					return undefined;
				}
			}
		} finally {
			const q = this.headlessQueues.get(key);
			if (q) {
				const idx = q.indexOf(waiter);
				if (idx >= 0) {
					q.splice(idx, 1);
				}
				if (q.length === 0) {
					this.headlessQueues.delete(key);
				}
			}
			this.wakeHeadlessWaiters(key);
		}
	}

	private mintAndActivateLease(options: AcquireTurnOptions<TCts>): TurnLease<TCts> {
		const {
			key,
			source,
			createCts,
			interruptActive,
			forceKill,
			graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS,
			forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
			turnTimeoutMs,
			idleStallTimeoutMs,
		} = options;

		let resolveDone!: () => void;
		let resolved = false;
		const done = new Promise<void>(resolve => {
			resolveDone = () => {
				if (!resolved) {
					resolved = true;
					resolve();
				}
			};
		});

		const cts = createCts();
		const abortController = new AbortController();
		const ctsTokenSub = cts.token.onCancellationRequested(() => {
			if (!abortController.signal.aborted) {
				abortController.abort(new Error('Turn cancelled'));
			}
		});

		const now = Date.now();
		const lease: InternalTurnLease<TCts> = {
			key,
			id: ++this.nextLeaseId,
			startedSeq: ++this.nextEventSeq,
			source,
			cts,
			abortSignal: abortController.signal,
			startedAt: now,
			lastActivityAt: now,
			externalWaitCount: 0,
			done,
			isSettling: false,
			timedOut: false,
			idleTimedOut: false,
			ticketId: options.ticketId,
			taskId: options.taskId,
			abortController,
			ctsTokenSub,
			interruptActive,
			forceKill,
			resolveDone,
			markSettling() {
				this.isSettling = true;
			},
			touchActivity() {
				this.lastActivityAt = Date.now();
			},
			beginExternalWait() {
				this.externalWaitCount += 1;
				this.lastActivityAt = Date.now();
			},
			endExternalWait() {
				this.externalWaitCount = Math.max(0, this.externalWaitCount - 1);
				this.lastActivityAt = Date.now();
			},
		};

		const triggerTimeoutEviction = (reason: Error, isIdle: boolean) => {
			if (this.active.get(key) !== lease || lease.timedOut || lease.isSettling) {
				return;
			}
			lease.timedOut = true;
			if (isIdle) {
				lease.idleTimedOut = true;
			}
			if (lease.turnDeadlineTimer !== undefined) {
				clearTimeout(lease.turnDeadlineTimer);
				lease.turnDeadlineTimer = undefined;
			}
			if (lease.idleStallTimer !== undefined) {
				clearTimeout(lease.idleStallTimer);
				lease.idleStallTimer = undefined;
			}
			if (!abortController.signal.aborted) {
				abortController.abort(reason);
			}
			try { lease.cts.cancel(); } catch { /* ignore */ }
			void lease.interruptActive?.().catch(() => undefined);
			void (async () => {
				const outcome = await racePromiseWithTimeoutAndToken(lease.done, graceTimeoutMs);
				if (outcome === 'timeout' && this.active.get(key) === lease) {
					await this.forceEvict(lease, forceKillTimeoutMs);
				}
			})();
		};

		if (typeof turnTimeoutMs === 'number' && Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0) {
			const timer = setTimeout(() => {
				lease.turnDeadlineTimer = undefined;
				triggerTimeoutEviction(new Error(`Turn exceeded hard deadline of ${turnTimeoutMs}ms`), false);
			}, turnTimeoutMs);
			timer.unref?.();
			lease.turnDeadlineTimer = timer;
		}

		if (typeof idleStallTimeoutMs === 'number' && Number.isFinite(idleStallTimeoutMs) && idleStallTimeoutMs > 0) {
			const armIdleCheck = (delayMs: number) => {
				const timer = setTimeout(() => {
					lease.idleStallTimer = undefined;
					if (this.active.get(key) !== lease || lease.isSettling || lease.timedOut) {
						return;
					}
					if (lease.externalWaitCount > 0) {
						armIdleCheck(idleStallTimeoutMs);
						return;
					}
					const idleElapsed = Date.now() - lease.lastActivityAt;
					if (idleElapsed < idleStallTimeoutMs) {
						armIdleCheck(Math.max(1, idleStallTimeoutMs - idleElapsed));
						return;
					}
					triggerTimeoutEviction(new Error(`Turn stalled with no engine stream activity for ${idleStallTimeoutMs}ms`), true);
				}, delayMs);
				timer.unref?.();
				lease.idleStallTimer = timer;
			};
			armIdleCheck(idleStallTimeoutMs);
		}

		this.active.set(key, lease);
		return lease;
	}

	private wakeHeadlessWaiters(key: string): void {
		const q = this.headlessQueues.get(key);
		if (!q || q.length === 0) {
			return;
		}
		for (const w of q) {
			w.wake();
		}
	}

	private cancelQueuedHeadlessWaiters(key: string): number {
		const q = this.headlessQueues.get(key);
		if (!q || q.length === 0) {
			return 0;
		}
		const snapshot = [...q];
		q.length = 0;
		this.headlessQueues.delete(key);
		for (const w of snapshot) {
			w.cancel();
		}
		return snapshot.length;
	}

	release(lease: TurnLease<TCts>): void {
		const internal = lease as InternalTurnLease<TCts>;
		internal.isSettling = true;
		if (internal.turnDeadlineTimer !== undefined) {
			clearTimeout(internal.turnDeadlineTimer);
			internal.turnDeadlineTimer = undefined;
		}
		if (internal.idleStallTimer !== undefined) {
			clearTimeout(internal.idleStallTimer);
			internal.idleStallTimer = undefined;
		}
		try { internal.ctsTokenSub.dispose(); } catch { /* ignore */ }
		if (this.active.get(internal.key) === internal) {
			this.active.delete(internal.key);
		}
		internal.resolveDone();
		this.wakeHeadlessWaiters(internal.key);
	}

	async cancelTicketTurns(
		key: string,
		ticketIds?: readonly string[],
		graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS,
	): Promise<number> {
		const filterSet = ticketIds && ticketIds.length > 0 ? new Set(ticketIds) : undefined;
		let cancelledCount = 0;
		const q = this.headlessQueues.get(key);
		if (q && q.length > 0) {
			for (let i = q.length - 1; i >= 0; i--) {
				const w = q[i];
				if (!filterSet || (w.ticketId && filterSet.has(w.ticketId))) {
					q.splice(i, 1);
					w.cancel();
					cancelledCount++;
				}
			}
			if (q.length === 0) {
				this.headlessQueues.delete(key);
			}
		}
		const existing = this.active.get(key);
		if (existing && existing.source === 'headless' && (!filterSet || (existing.ticketId && filterSet.has(existing.ticketId)))) {
			cancelledCount++;
			existing.cts.cancel();
			await existing.interruptActive?.().catch(() => undefined);
			await racePromiseWithTimeoutAndToken(existing.done, graceTimeoutMs);
		}
		return cancelledCount;
	}

	async stop(
		key: string,
		graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS,
		forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
		options?: { readonly cancelQueuedHeadless?: boolean },
	): Promise<boolean> {
		const evictedWaiters = options?.cancelQueuedHeadless !== false
			? this.cancelQueuedHeadlessWaiters(key)
			: 0;
		const existing = this.active.get(key);
		if (!existing) {
			return evictedWaiters > 0;
		}
		existing.cts.cancel();
		void existing.interruptActive?.().catch(() => undefined);
		const outcome = await racePromiseWithTimeoutAndToken(existing.done, graceTimeoutMs);
		if (outcome === 'timeout' && this.active.get(key) === existing) {
			await this.forceEvict(existing, forceKillTimeoutMs);
		}
		return true;
	}

	async forceRelease(
		key: string,
		forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
		options?: { readonly cancelQueuedHeadless?: boolean },
	): Promise<boolean> {
		const evictedWaiters = options?.cancelQueuedHeadless !== false
			? this.cancelQueuedHeadlessWaiters(key)
			: 0;
		const existing = this.active.get(key);
		if (!existing) {
			return evictedWaiters > 0;
		}
		existing.cts.cancel();
		await this.forceEvict(existing, forceKillTimeoutMs);
		return true;
	}

	private async forceEvict(lease: InternalTurnLease<TCts>, forceKillTimeoutMs: number): Promise<void> {
		try { lease.cts.cancel(); } catch { /* ignore */ }
		if (lease.forceKill) {
			lease.forceKillPromise ??= Promise.resolve()
				.then(() => lease.forceKill!())
				.catch(() => undefined);
			await racePromiseWithTimeoutAndToken(lease.forceKillPromise, forceKillTimeoutMs);
		}
		this.release(lease);
	}
}
