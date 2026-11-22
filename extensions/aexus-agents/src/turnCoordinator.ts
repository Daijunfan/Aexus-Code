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
	readonly startedAt: number;
	readonly done: Promise<void>;
	readonly isSettling: boolean;
	markSettling(): void;
}

export interface AcquireTurnOptions<TCts extends TurnCancellationHandle> {
	readonly key: string;
	readonly source: TurnSource;
	readonly createCts: () => TCts;
	readonly externalToken?: ExternalCancellationToken;
	readonly forceKill?: () => Promise<void>;
	readonly onPreempt?: (previous: TurnLease<TCts>, reason: TurnPreemptReason) => void;
	readonly graceTimeoutMs?: number;
	readonly forceKillTimeoutMs?: number;
}

interface InternalTurnLease<TCts extends TurnCancellationHandle> extends TurnLease<TCts> {
	isSettling: boolean;
	readonly forceKill?: () => Promise<void>;
	readonly resolveDone: () => void;
	forceKillPromise?: Promise<void>;
}

const DEFAULT_GRACE_TIMEOUT_MS = 2500;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 3000;

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
 * Coordinates single-flight execution per conversation key while guaranteeing:
 * - Serialized acquisition (eliminating check-then-set TOCTOU races).
 * - Strict lease ownership checks on release (a late `finally` can never clear a newer turn's lock).
 * - Interactive (`ui`) messages cleanly hand off from settling, cancelled, invisible `headless`,
 *   or interrupted turns with a bounded grace window + `forceKill` fallback instead of throwing
 *   a stuck "already working" error.
 * - Background (`headless`) turns wait politely for live interactive turns instead of killing them.
 */
export class SessionTurnCoordinator<TCts extends TurnCancellationHandle> {
	private readonly active = new Map<string, InternalTurnLease<TCts>>();
	private readonly acquireChains = new Map<string, Promise<void>>();
	private nextLeaseId = 0;

	isBusy(key: string): boolean {
		return this.active.has(key);
	}

	get(key: string): TurnLease<TCts> | undefined {
		return this.active.get(key);
	}

	async acquire(options: AcquireTurnOptions<TCts>): Promise<TurnLease<TCts> | undefined> {
		const { key, externalToken } = options;
		if (externalToken?.isCancellationRequested) {
			return undefined;
		}
		const previousTail = this.acquireChains.get(key) ?? Promise.resolve();
		let releaseChain!: () => void;
		const currentTail = new Promise<void>(resolve => { releaseChain = resolve; });
		this.acquireChains.set(key, currentTail);

		try {
			const queueWait = await racePromiseWithTimeoutAndToken(previousTail, undefined, externalToken);
			if (queueWait === 'cancelled' || externalToken?.isCancellationRequested) {
				return undefined;
			}
			return await this.acquireSerialized(options);
		} finally {
			releaseChain();
			if (this.acquireChains.get(key) === currentTail) {
				this.acquireChains.delete(key);
			}
		}
	}

	private async acquireSerialized(options: AcquireTurnOptions<TCts>): Promise<TurnLease<TCts> | undefined> {
		const {
			key,
			source,
			createCts,
			externalToken,
			forceKill,
			onPreempt,
			graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS,
			forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
		} = options;

		while (true) {
			if (externalToken?.isCancellationRequested) {
				return undefined;
			}
			const existing = this.active.get(key);
			if (!existing) {
				break;
			}

			if (source === 'ui') {
				let reason: TurnPreemptReason;
				if (existing.isSettling) {
					reason = 'settling';
				} else if (existing.cts.token.isCancellationRequested) {
					reason = 'cancelled';
				} else if (existing.source === 'headless') {
					reason = 'headless';
					existing.cts.cancel();
				} else {
					reason = 'interrupted';
					existing.cts.cancel();
				}
				try { onPreempt?.(existing, reason); } catch { /* ignore */ }

				const outcome = await racePromiseWithTimeoutAndToken(existing.done, graceTimeoutMs, externalToken);
				if (outcome === 'cancelled' || externalToken?.isCancellationRequested) {
					return undefined;
				}
				if (this.active.get(key) === existing) {
					await this.forceEvict(existing, forceKillTimeoutMs);
				}
				continue;
			}

			// Headless turn: recover settling/cancelled turns with bounded grace,
			// but wait politely for live interactive or live headless turns instead of killing them.
			if (existing.isSettling || existing.cts.token.isCancellationRequested) {
				const outcome = await racePromiseWithTimeoutAndToken(existing.done, graceTimeoutMs, externalToken);
				if (outcome === 'cancelled' || externalToken?.isCancellationRequested) {
					return undefined;
				}
				if (this.active.get(key) === existing) {
					await this.forceEvict(existing, forceKillTimeoutMs);
				}
				continue;
			}

			// Wait until existing finishes, external caller cancels, OR existing itself gets cancelled
			// (in which case the next loop iteration applies the bounded cancel grace + forceKill).
			await racePromiseWithTimeoutAndToken(existing.done, undefined, externalToken, existing.cts.token);
			if (externalToken?.isCancellationRequested) {
				return undefined;
			}
		}

		if (externalToken?.isCancellationRequested) {
			return undefined;
		}

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

		const lease: InternalTurnLease<TCts> = {
			key,
			id: ++this.nextLeaseId,
			source,
			cts: createCts(),
			startedAt: Date.now(),
			done,
			isSettling: false,
			forceKill,
			resolveDone,
			markSettling() {
				this.isSettling = true;
			},
		};
		this.active.set(key, lease);
		return lease;
	}

	release(lease: TurnLease<TCts>): void {
		const internal = lease as InternalTurnLease<TCts>;
		internal.isSettling = true;
		if (this.active.get(internal.key) === internal) {
			this.active.delete(internal.key);
		}
		internal.resolveDone();
	}

	async stop(key: string, graceTimeoutMs = DEFAULT_GRACE_TIMEOUT_MS, forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS): Promise<boolean> {
		const existing = this.active.get(key);
		if (!existing) {
			return false;
		}
		existing.cts.cancel();
		const outcome = await racePromiseWithTimeoutAndToken(existing.done, graceTimeoutMs);
		if (outcome === 'timeout' && this.active.get(key) === existing) {
			await this.forceEvict(existing, forceKillTimeoutMs);
		}
		return true;
	}

	async forceRelease(key: string, forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS): Promise<boolean> {
		const existing = this.active.get(key);
		if (!existing) {
			return false;
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
