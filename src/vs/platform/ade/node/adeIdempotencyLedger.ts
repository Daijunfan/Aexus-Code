/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { canonicalizeJsonForHash } from '../common/adeControlPolicy.js';

export interface IAdeIdempotencyLedgerOptions {
	/** Optional 0o600 JSON file path for durable cross-restart deduplication (e.g. `<adeHome>/idempotency-ledger.json`). */
	readonly storagePath?: string;
	/** Entry TTL in milliseconds (defaults to 15 minutes). */
	readonly ttlMs?: number;
	/** Maximum number of completed entries retained in the bounded LRU (defaults to 4,096). */
	readonly maxEntries?: number;
	/** Debounce interval (ms) before flushing dirty mutations to disk (defaults to 500ms). */
	readonly flushDebounceMs?: number;
	/** Optional clock override for deterministic tests. */
	readonly now?: () => number;
}

interface IPersistedIdempotencyEntry {
	readonly payloadHash: string;
	readonly result: unknown;
	readonly createdAt: number;
	readonly expiresAt: number;
}

interface IInFlightEntry {
	readonly payloadHash: string;
	readonly promise: Promise<unknown>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_FLUSH_DEBOUNCE_MS = 500;
const HASH_OMIT_KEYS = new Set(['idempotencyKey', '_verifiedCaller', '_callerSessionId', '_callerTokenIat']);
const VERIFIED_CALLER_HASH_OMIT_KEYS = new Set([...HASH_OMIT_KEYS, 'caller']);

export class AdeIdempotencyConflictError extends Error {
	readonly code = 'IDEMPOTENCY_CONFLICT';
	constructor(action: string, key: string) {
		super(`IDEMPOTENCY_CONFLICT: idempotencyKey "${key}" for action "${action}" was already used with different request parameters.`);
		this.name = 'AdeIdempotencyConflictError';
	}
}

/**
 * Temporal-grade main-process mutation idempotency ledger.
 *
 * Guarantees at-most-once execution across local UDS, loopback TCP (`ssh -R`),
 * renderer-routed, and 0-window headless fallback retries:
 * - Keys are strictly scoped by `(principalId, action, idempotencyKey)` to prevent cross-tenant replay.
 * - Canonical SHA-256 payload hashing rejects same-key parameter mismatches with `IDEMPOTENCY_CONFLICT`.
 * - Concurrent duplicate retries coalesce onto the single in-flight promise.
 * - Only successful executions are cached and persisted; transient failures evict the slot so retries recover.
 */
export class AdeIdempotencyLedger extends Disposable {
	private readonly storagePath?: string;
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	private readonly flushDebounceMs: number;
	private readonly nowFn: () => number;

	private readonly completed = new Map<string, IPersistedIdempotencyEntry>();
	private readonly inFlight = new Map<string, IInFlightEntry>();
	private loadPromise: Promise<void> | undefined;
	private loaded = false;
	private mutationSeq = 0;
	private flushedSeq = 0;
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private writeChain: Promise<void> = Promise.resolve();
	private tmpSeq = 0;
	private disposed = false;

	constructor(options?: IAdeIdempotencyLedgerOptions) {
		super();
		this.storagePath = options?.storagePath;
		this.ttlMs = Math.max(100, options?.ttlMs ?? DEFAULT_TTL_MS);
		this.maxEntries = Math.max(16, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
		this.flushDebounceMs = Math.max(0, options?.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS);
		this.nowFn = options?.now ?? (() => Date.now());
	}

	private ensureLoaded(): Promise<void> {
		if (this.loaded || !this.storagePath) {
			this.loaded = true;
			return Promise.resolve();
		}
		if (!this.loadPromise) {
			const filePath = this.storagePath;
			this.loadPromise = (async () => {
				try {
					const raw = await fs.promises.readFile(filePath, 'utf8');
					const parsed = JSON.parse(raw) as { readonly version?: number; readonly entries?: Readonly<Record<string, IPersistedIdempotencyEntry>> };
					const now = this.nowFn();
					if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
						for (const [scopeKey, entry] of Object.entries(parsed.entries)) {
							if (
								!this.completed.has(scopeKey)
								&& entry
								&& typeof entry === 'object'
								&& typeof entry.payloadHash === 'string'
								&& typeof entry.expiresAt === 'number'
								&& entry.expiresAt > now
							) {
								this.completed.set(scopeKey, entry);
							}
						}
						this.pruneOverflow(now);
					}
				} catch {
					// First startup or absent file
				} finally {
					this.loaded = true;
				}
			})();
		}
		return this.loadPromise;
	}

	private buildScopeKey(principalId: string, action: string, idempotencyKey: string): string {
		return JSON.stringify([principalId, action, idempotencyKey]);
	}

	private computePayloadHash(action: string, params: Readonly<Record<string, unknown>> | undefined, windowId: number | undefined): string {
		const omitKeys = params?._verifiedCaller === true ? VERIFIED_CALLER_HASH_OMIT_KEYS : HASH_OMIT_KEYS;
		const canonical = canonicalizeJsonForHash({
			action,
			params: params ?? {},
			...(windowId !== undefined ? { windowId } : {}),
		}, omitKeys);
		return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
	}

	private pruneOverflow(now: number): void {
		for (const [k, v] of this.completed) {
			if (v.expiresAt <= now) {
				this.completed.delete(k);
			}
		}
		while (this.completed.size > this.maxEntries) {
			const oldest = this.completed.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.completed.delete(oldest);
		}
	}

	private scheduleFlush(delayOverrideMs?: number): void {
		if (!this.storagePath || this._store.isDisposed) {
			return;
		}
		const delayMs = delayOverrideMs ?? this.flushDebounceMs;
		if (delayMs === 0) {
			void this.flush();
			return;
		}
		if (this.flushTimer !== undefined) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			if (!this._store.isDisposed) {
				void this.flush();
			}
		}, delayMs);
		if (typeof (this.flushTimer as { unref?: () => void }).unref === 'function') {
			(this.flushTimer as { unref?: () => void }).unref!();
		}
	}

	async flush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (!this.storagePath || this.flushedSeq >= this.mutationSeq || this._store.isDisposed) {
			return this.writeChain;
		}
		const targetPath = this.storagePath;
		const writeOp = async (): Promise<void> => {
			if (this.flushedSeq >= this.mutationSeq || this._store.isDisposed) {
				return;
			}
			const snapshotSeq = this.mutationSeq;
			const now = this.nowFn();
			this.pruneOverflow(now);
			const entriesObj: Record<string, IPersistedIdempotencyEntry> = {};
			for (const [k, v] of this.completed.entries()) {
				entriesObj[k] = v;
			}
			const serialized = JSON.stringify({ version: 1, entries: entriesObj });
			const dir = path.dirname(targetPath);
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			if (this._store.isDisposed) {
				return;
			}
			const tmpPath = `${targetPath}.tmp.${process.pid}.${++this.tmpSeq}.${crypto.randomBytes(6).toString('hex')}`;
			try {
				await fs.promises.writeFile(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
				if (!isWindows) {
					await fs.promises.chmod(tmpPath, 0o600).catch(() => undefined);
				}
				if (this.disposed || this._store.isDisposed) {
					await fs.promises.unlink(tmpPath).catch(() => undefined);
					return;
				}
				await fs.promises.rename(tmpPath, targetPath);
				if (this.disposed || this._store.isDisposed) {
					return;
				}
				this.flushedSeq = Math.max(this.flushedSeq, snapshotSeq);
				if (this.flushedSeq < this.mutationSeq && !this.disposed && !this._store.isDisposed) {
					this.scheduleFlush();
				}
			} catch {
				await fs.promises.unlink(tmpPath).catch(() => undefined);
				if (!this.disposed && !this._store.isDisposed && this.flushedSeq < this.mutationSeq) {
					this.scheduleFlush(Math.max(this.flushDebounceMs, 1_000));
				}
			}
		};
		const next = this.writeChain.then(writeOp, writeOp);
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	async execute<T>(
		input: {
			readonly principalId: string;
			readonly action: string;
			readonly idempotencyKey: string;
			readonly params?: Readonly<Record<string, unknown>>;
			readonly windowId?: number;
			readonly timeoutMs?: number;
		},
		run: () => Promise<T>,
	): Promise<{ readonly result: T; readonly replayed: boolean }> {
		await this.ensureLoaded();
		const now = this.nowFn();
		const scopeKey = this.buildScopeKey(input.principalId, input.action, input.idempotencyKey);
		const payloadHash = this.computePayloadHash(input.action, input.params, input.windowId);

		// 1. Check completed ledger (LRU refresh on hit)
		const cached = this.completed.get(scopeKey);
		if (cached) {
			if (cached.expiresAt > now) {
				if (cached.payloadHash !== payloadHash) {
					throw new AdeIdempotencyConflictError(input.action, input.idempotencyKey);
				}
				this.completed.delete(scopeKey);
				this.completed.set(scopeKey, cached);
				return { result: cached.result as T, replayed: true };
			}
			this.completed.delete(scopeKey);
		}

		// 2. Coalesce concurrent duplicate retry onto in-flight execution
		const active = this.inFlight.get(scopeKey);
		if (active) {
			if (active.payloadHash !== payloadHash) {
				throw new AdeIdempotencyConflictError(input.action, input.idempotencyKey);
			}
			const result = await active.promise as T;
			return { result, replayed: true };
		}

		// 3. Execute once; cache strictly on success, evict on failure or hard timeout so retries never wedge.
		let timedOut = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const rawRunPromise = (async () => {
			const result = await run();
			if (!timedOut) {
				const doneAt = this.nowFn();
				this.completed.set(scopeKey, {
					payloadHash,
					result,
					createdAt: doneAt,
					expiresAt: doneAt + this.ttlMs,
				});
				this.pruneOverflow(doneAt);
				this.mutationSeq++;
				this.scheduleFlush();
			}
			return result;
		})();
		rawRunPromise.catch(() => undefined);

		const execPromise: Promise<T> = input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
			? new Promise<T>((resolve, reject) => {
				timeoutTimer = setTimeout(() => {
					timedOut = true;
					if (this.inFlight.get(scopeKey)?.promise === execPromise) {
						this.inFlight.delete(scopeKey);
					}
					reject(new Error(`ADE control action "${input.action}" timed out after ${input.timeoutMs}ms`));
				}, input.timeoutMs);
				if (typeof (timeoutTimer as { unref?: () => void }).unref === 'function') {
					(timeoutTimer as { unref?: () => void }).unref!();
				}
				rawRunPromise.then(
					value => {
						if (timeoutTimer !== undefined) {
							clearTimeout(timeoutTimer);
							timeoutTimer = undefined;
						}
						resolve(value);
					},
					err => {
						if (timeoutTimer !== undefined) {
							clearTimeout(timeoutTimer);
							timeoutTimer = undefined;
						}
						reject(err);
					},
				);
			})
			: rawRunPromise;

		this.inFlight.set(scopeKey, { payloadHash, promise: execPromise });
		try {
			const result = await execPromise;
			return { result, replayed: false };
		} finally {
			if (timeoutTimer !== undefined) {
				clearTimeout(timeoutTimer);
			}
			if (this.inFlight.get(scopeKey)?.promise === execPromise) {
				this.inFlight.delete(scopeKey);
			}
		}
	}

	override dispose(): void {
		this.disposed = true;
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.flushedSeq < this.mutationSeq && this.storagePath) {
			try {
				const snapshotSeq = this.mutationSeq;
				const now = this.nowFn();
				this.pruneOverflow(now);
				const entriesObj: Record<string, IPersistedIdempotencyEntry> = {};
				for (const [k, v] of this.completed.entries()) {
					entriesObj[k] = v;
				}
				const serialized = JSON.stringify({ version: 1, entries: entriesObj });
				const dir = path.dirname(this.storagePath);
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must flush pending idempotency keys before shutdown.
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
				const tmpPath = `${this.storagePath}.tmp.${process.pid}.${++this.tmpSeq}.${crypto.randomBytes(6).toString('hex')}`;
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must flush pending idempotency keys before shutdown.
				fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
				if (!isWindows) {
					try {
						// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and enforces 0600 permissions before atomic rename.
						fs.chmodSync(tmpPath, 0o600);
					} catch {
						// ignore chmod errors
					}
				}
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and commits the idempotency ledger atomically before shutdown.
				fs.renameSync(tmpPath, this.storagePath);
				this.flushedSeq = Math.max(this.flushedSeq, snapshotSeq);
			} catch {
				// Best-effort flush on teardown
			}
		}
		this.inFlight.clear();
		super.dispose();
	}
}
