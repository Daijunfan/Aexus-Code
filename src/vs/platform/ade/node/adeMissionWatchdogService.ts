/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { stripAdeControlEnv } from '../common/adeControl.js';
import {
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogTokenSpec,
	IAdeWatchdogWakeupEvent,
} from '../common/adeEngineering.js';
import { IMissionSourceTrigger, matchesCronExpression } from '../common/adeMissionEngine.js';

export interface IAdeRemoteBatchProbeSpec {
	readonly pids?: readonly number[];
	readonly filePaths?: readonly string[];
	readonly gitPaths?: readonly string[];
	readonly persistentPrefixes?: readonly string[];
	readonly checkGpu?: boolean;
}

export interface IAdeRemoteBatchProbeResult {
	readonly remoteNowMs?: number;
	readonly pidAlive: Readonly<Record<number, boolean>>;
	readonly fileMtime: Readonly<Record<string, number | undefined>>;
	readonly fileSignature?: Readonly<Record<string, string | undefined>>;
	readonly gitHead: Readonly<Record<string, string | undefined>>;
	readonly persistentSessions: Readonly<Record<string, { readonly aliveCount: number; readonly exitedCodes: readonly number[] }>>;
	readonly gpuUtilPct?: number;
}

export interface IAdeRemoteWatchdogProbe {
	remoteIsPidAlive(authority: string, pid: number): Promise<boolean>;
	remoteFileStatMtime(authority: string, remotePath: string): Promise<number | undefined>;
	remoteFileStatSignature?(authority: string, remotePath: string): Promise<string | undefined>;
	remoteGitHeadCommit(authority: string, projectPath: string): Promise<string | undefined>;
	remoteGpuUtilizationPct(authority: string): Promise<number | undefined>;
	remoteCheckPersistentSessions?(authority: string, idPrefix: string): Promise<{ readonly aliveCount: number; readonly exitedCodes: readonly number[] } | undefined>;
	/** Optional single-SSH batched host probe eliminating per-token/per-trigger SSH handshake storms. */
	remoteBatchProbe?(authority: string, spec: IAdeRemoteBatchProbeSpec): Promise<IAdeRemoteBatchProbeResult>;
	remoteStat?(authority: string, remotePath: string): Promise<{ readonly type: 'file' | 'directory' | 'symlink' | 'unknown'; readonly size: number; readonly mtime: number }>;
	remoteExecCommand?(authority: string, options: {
		readonly command: string;
		readonly cwd?: string;
		readonly timeoutMs?: number;
		readonly maxOutputChars?: number;
	}): Promise<{
		readonly exitCode: number;
		readonly outputTail: string;
		readonly timedOut: boolean;
		readonly durationMs: number;
		readonly error?: string;
	}>;
}

export interface IAdeLocalWatchdogProbe {
	isPidAlive(pid: number): Promise<boolean>;
	fileStatMtime(filePath: string): Promise<number | undefined>;
	fileStatSignature?(filePath: string): Promise<string | undefined>;
	gitHeadCommit(projectPath: string): Promise<string | undefined>;
	gpuUtilizationPct(): Promise<number | undefined>;
}

export interface IAdeMissionWatchdogServiceOptions {
	readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	readonly localProbe?: IAdeLocalWatchdogProbe;
	readonly pollIntervalMs?: number;
	/** Per-probe timeout (ms) so a single hanging SSH host never stalls local or other remote probes. */
	readonly probeTimeoutMs?: number;
	/** Maximum concurrent probes executed in parallel during a single watchdog tick. */
	readonly maxConcurrentProbes?: number;
	/** Optional JSON file path used to persist trigger baselines/fire history across IDE restarts. */
	readonly triggerStatePath?: string;
	/** Optional JSON file path used to persist active Mission Watchdog snapshots across restarts / 0-window daemon runs. */
	readonly snapshotStatePath?: string;
	/** Minimum grace period (ms) after token activity before probing whether a remote persistent session exited unexpectedly (defaults to 30s). */
	readonly remoteSessionProbeGraceMs?: number;
	/** Minimum cooldown (ms) between repeated `agent_exited` wakeups for the same token (defaults to 60s). */
	readonly remoteSessionExitCooldownMs?: number;
	readonly now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CONCURRENT_PROBES = 6;
const DEFAULT_REMOTE_SESSION_PROBE_GRACE_MS = 30_000;
const DEFAULT_REMOTE_SESSION_EXIT_COOLDOWN_MS = 60_000;
const GPU_IDLE_COOLDOWN_MS = 60_000;

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				reject(new Error(`Watchdog probe timed out after ${timeoutMs}ms (${label})`));
			}
		}, timeoutMs);
		if (typeof (timer as { unref?: () => void }).unref === 'function') {
			(timer as { unref?: () => void }).unref!();
		}
		promise.then(
			val => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(val);
				}
			},
			err => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err);
				}
			},
		);
	});
}

async function runWithConcurrency(tasks: readonly (() => Promise<void>)[], concurrency: number): Promise<void> {
	if (tasks.length === 0) {
		return;
	}
	const limit = Math.max(1, Math.min(concurrency, tasks.length));
	let cursor = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (cursor < tasks.length) {
			const idx = cursor++;
			try {
				await tasks[idx]();
			} catch {
				// Isolated per-task failure must never abort sibling probes
			}
		}
	});
	await Promise.all(workers);
}

function runExecFile(file: string, args: readonly string[], timeoutMs = 8_000): Promise<{ code: number; stdout: string }> {
	return new Promise(resolve => {
		execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, env: stripAdeControlEnv(process.env) }, (err, stdout) => {
			if (err) {
				resolve({ code: typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1, stdout: String(stdout ?? '') });
				return;
			}
			resolve({ code: 0, stdout: String(stdout ?? '') });
		});
	});
}

function createDefaultLocalProbe(): IAdeLocalWatchdogProbe {
	return {
		async isPidAlive(pid: number): Promise<boolean> {
			if (!Number.isInteger(pid) || pid <= 0) {
				return false;
			}
			try {
				process.kill(pid, 0);
				return true;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException | undefined)?.code;
				// EPERM means process exists but owned by another user.
				return code === 'EPERM';
			}
		},
		async fileStatMtime(filePath: string): Promise<number | undefined> {
			try {
				const st = await fs.promises.stat(filePath);
				return st.mtimeMs;
			} catch {
				return undefined;
			}
		},
		async fileStatSignature(filePath: string): Promise<string | undefined> {
			try {
				const st = await fs.promises.stat(filePath);
				return `${Math.round(st.mtimeMs)}:${st.size}:${st.ino}`;
			} catch {
				return undefined;
			}
		},
		async gitHeadCommit(projectPath: string): Promise<string | undefined> {
			const res = await runExecFile('git', ['-C', projectPath, 'rev-parse', 'HEAD'], 8_000);
			const sha = res.stdout.trim();
			return res.code === 0 && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
		},
		async gpuUtilizationPct(): Promise<number | undefined> {
			const res = await runExecFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], 8_000);
			if (res.code !== 0) {
				return undefined;
			}
			const values = res.stdout
				.split(/\r?\n/)
				.map(line => Number.parseFloat(line.trim()))
				.filter(n => Number.isFinite(n));
			return values.length > 0 ? Math.max(...values) : undefined;
		},
	};
}

interface ITriggerMonitorMemory {
	lastFiredAt?: number;
	lastCronMinuteBucket?: number;
	firedOnce?: boolean;
	rearmedFireAt?: number;
	fileExisted?: boolean;
	lastFileMtime?: number;
	lastGitHead?: string;
	/** Edge-trigger hysteresis latch for `gpu_idle`: set true after firing until GPU rises above threshold again. */
	gpuIdleDisarmed?: boolean;
}

/**
 * Local Watchdog Daemon & Zero-Token Source Trigger Monitor.
 *
 * Runs inside the local Electron main process and supervises BOTH local and remote SSH Cloud Host
 * agents holding active/blocked Mission tokens, plus `inDegree === 0` source trigger schedules/events.
 */
export class AdeMissionWatchdogService extends Disposable {
	private readonly _onDidWatchdogWakeup = this._register(new Emitter<IAdeWatchdogWakeupEvent>());
	readonly onDidWatchdogWakeup: Event<IAdeWatchdogWakeupEvent> = this._onDidWatchdogWakeup.event;

	private readonly _onDidSourceTriggerFire = this._register(new Emitter<IAdeSourceTriggerFireEvent>());
	readonly onDidSourceTriggerFire: Event<IAdeSourceTriggerFireEvent> = this._onDidSourceTriggerFire.event;

	private readonly snapshots = new Map<string, IAdeMissionWatchdogSnapshot>();
	private readonly lastSilenceWakeupAt = new Map<string, number>();
	private readonly lastAgentExitWakeupAt = new Map<string, number>();
	private readonly blockedWakeupNotified = new Set<string>();
	private readonly barrierDeadlineNotifiedAt = new Map<string, number>();
	private readonly triggerMemory = new Map<string, ITriggerMonitorMemory>();

	private readonly localProbe: IAdeLocalWatchdogProbe;
	private readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	private readonly pollIntervalMs: number;
	private readonly probeTimeoutMs: number;
	private readonly maxConcurrentProbes: number;
	private readonly triggerStatePath?: string;
	private readonly snapshotStatePath?: string;
	private readonly remoteSessionProbeGraceMs: number;
	private readonly remoteSessionExitCooldownMs: number;
	private readonly nowFn: () => number;

	private readonly inFlightProbeKeys = new Map<string, number>();
	private probeSeq = 0;
	private tickInFlight: Promise<void> | undefined;
	private tickPendingRerun = false;
	private triggerPersistChain: Promise<void> = Promise.resolve();
	private snapshotPersistChain: Promise<void> = Promise.resolve();
	private triggerStateLoadPromise: Promise<void> | undefined;
	private snapshotStateLoadPromise: Promise<void> | undefined;
	private triggerStateHydrated = false;
	private snapshotStateHydrated = false;
	private triggerMemoryDirty = false;
	private triggerMutationSeq = 0;
	private snapshotDirty = false;
	private snapshotMutationSeq = 0;
	private readonly explicitlyRemovedMissionIds = new Set<string>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private snapshotFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(options?: IAdeMissionWatchdogServiceOptions) {
		super();
		this.localProbe = options?.localProbe ?? createDefaultLocalProbe();
		this.remoteProbe = options?.remoteProbe;
		this.pollIntervalMs = Math.max(1_000, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		this.probeTimeoutMs = Math.max(100, options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
		this.maxConcurrentProbes = Math.max(1, options?.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES);
		this.triggerStatePath = options?.triggerStatePath;
		this.snapshotStatePath = options?.snapshotStatePath;
		this.remoteSessionProbeGraceMs = Math.max(0, options?.remoteSessionProbeGraceMs ?? DEFAULT_REMOTE_SESSION_PROBE_GRACE_MS);
		this.remoteSessionExitCooldownMs = Math.max(1_000, options?.remoteSessionExitCooldownMs ?? DEFAULT_REMOTE_SESSION_EXIT_COOLDOWN_MS);
		this.nowFn = options?.now ?? (() => Date.now());
		if (this.snapshotStatePath) {
			// Hydrate persisted running Mission snapshots immediately on main-process startup so
			// daemon supervision resumes even before any renderer window connects.
			void this.ensureSnapshotsLoaded().then(() => {
				if (!this._store.isDisposed) {
					this.reconcileTimer();
				}
			});
		}
	}

	private ensureSnapshotsLoaded(): Promise<void> {
		if (this.snapshotStateHydrated || !this.snapshotStatePath) {
			this.snapshotStateHydrated = true;
			return Promise.resolve();
		}
		if (!this.snapshotStateLoadPromise) {
			const targetPath = this.snapshotStatePath;
			this.snapshotStateLoadPromise = (async () => {
				try {
					const raw = await fs.promises.readFile(targetPath, 'utf8');
					const parsed = JSON.parse(raw) as Record<string, IAdeMissionWatchdogSnapshot>;
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						for (const [missionId, snap] of Object.entries(parsed)) {
							if (
								!this.snapshots.has(missionId)
								&& !this.explicitlyRemovedMissionIds.has(missionId)
								&& snap
								&& typeof snap === 'object'
								&& snap.missionId === missionId
								&& snap.status === 'running'
							) {
								this.snapshots.set(missionId, snap);
							}
						}
					}
				} catch {
					// File may not exist on first run
				} finally {
					this.snapshotStateHydrated = true;
				}
			})();
		}
		return this.snapshotStateLoadPromise;
	}

	private scheduleSnapshotPersist(immediate: boolean): void {
		if (!this.snapshotStatePath || this._store.isDisposed) {
			return;
		}
		if (immediate) {
			if (this.snapshotFlushTimer !== undefined) {
				clearTimeout(this.snapshotFlushTimer);
				this.snapshotFlushTimer = undefined;
			}
			void this.persistSnapshotsIfDirty();
			return;
		}
		if (this.snapshotFlushTimer !== undefined) {
			return;
		}
		this.snapshotFlushTimer = setTimeout(() => {
			this.snapshotFlushTimer = undefined;
			if (!this._store.isDisposed) {
				void this.persistSnapshotsIfDirty();
			}
		}, 3_000);
		if (typeof (this.snapshotFlushTimer as { unref?: () => void }).unref === 'function') {
			(this.snapshotFlushTimer as { unref?: () => void }).unref!();
		}
	}

	/**
	 * Awaits any in-flight snapshot or trigger-memory disk writes (useful before disposal / headless teardown).
	 */
	async flushPendingWrites(): Promise<void> {
		if (this.snapshotFlushTimer !== undefined) {
			clearTimeout(this.snapshotFlushTimer);
			this.snapshotFlushTimer = undefined;
		}
		await Promise.all([
			this.persistSnapshotsIfDirty(),
			this.persistTriggerMemoryIfDirty(),
		]);
	}

	private persistSnapshotsIfDirty(): Promise<void> {
		if (!this.snapshotStatePath || this._store.isDisposed) {
			return this.snapshotPersistChain;
		}
		if (!this.snapshotDirty) {
			return this.snapshotPersistChain;
		}
		const targetPath = this.snapshotStatePath;
		const writeOp = async () => {
			if (this._store.isDisposed) {
				return;
			}
			await this.ensureSnapshotsLoaded();
			if (this._store.isDisposed || !this.snapshotDirty) {
				return;
			}
			const capturedSeq = this.snapshotMutationSeq;
			const payloadObj: Record<string, IAdeMissionWatchdogSnapshot> = {};
			for (const [missionId, snap] of this.snapshots.entries()) {
				if (snap.status === 'running') {
					payloadObj[missionId] = snap;
				}
			}
			const serialized = JSON.stringify(payloadObj, null, 2);
			if (this._store.isDisposed) {
				return;
			}
			await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
			if (this._store.isDisposed) {
				return;
			}
			const tmp = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
			try {
				await fs.promises.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
				if (this.disposed || this._store.isDisposed) {
					await fs.promises.unlink(tmp).catch(() => undefined);
					return;
				}
				await fs.promises.rename(tmp, targetPath);
				if (this.disposed || this._store.isDisposed) {
					return;
				}
				if (this.snapshotMutationSeq === capturedSeq) {
					this.snapshotDirty = false;
				} else if (!this.disposed && !this._store.isDisposed) {
					this.scheduleSnapshotPersist(false);
				}
			} catch {
				await fs.promises.unlink(tmp).catch(() => undefined);
			}
		};
		const next = this.snapshotPersistChain.then(writeOp, writeOp);
		this.snapshotPersistChain = next.catch(() => undefined);
		return next;
	}

	/**
	 * Immediately runs a supervision tick after OS wake / resume from laptop sleep so blocked
	 * tokens, dead remote sessions, and due triggers reconcile immediately without waiting.
	 */
	notifySystemResume(): void {
		if (this._store.isDisposed) {
			return;
		}
		void this.runTick();
	}

	private ensureTriggerMemoryLoaded(): Promise<void> {
		if (this.triggerStateHydrated || !this.triggerStatePath) {
			this.triggerStateHydrated = true;
			return Promise.resolve();
		}
		if (!this.triggerStateLoadPromise) {
			const targetPath = this.triggerStatePath;
			this.triggerStateLoadPromise = (async () => {
				try {
					const raw = await fs.promises.readFile(targetPath, 'utf8');
					const parsed = JSON.parse(raw) as Record<string, ITriggerMonitorMemory>;
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						for (const [k, v] of Object.entries(parsed)) {
							if (!this.triggerMemory.has(k) && v && typeof v === 'object') {
								this.triggerMemory.set(k, { ...v });
							}
						}
					}
				} catch {
					// File may not exist yet on first run
				} finally {
					this.triggerStateHydrated = true;
				}
			})();
		}
		return this.triggerStateLoadPromise;
	}

	private persistTriggerMemoryIfDirty(): Promise<void> {
		if (!this.triggerStatePath || this._store.isDisposed) {
			return this.triggerPersistChain;
		}
		if (!this.triggerMemoryDirty) {
			return this.triggerPersistChain;
		}
		const targetPath = this.triggerStatePath;
		const writeOp = async () => {
			if (this._store.isDisposed) {
				return;
			}
			await this.ensureTriggerMemoryLoaded();
			if (this._store.isDisposed || !this.triggerMemoryDirty) {
				return;
			}
			const capturedSeq = this.triggerMutationSeq;
			const payloadObj: Record<string, ITriggerMonitorMemory> = {};
			for (const [k, v] of this.triggerMemory.entries()) {
				payloadObj[k] = { ...v };
			}
			const serialized = JSON.stringify(payloadObj, null, 2);
			if (this._store.isDisposed) {
				return;
			}
			await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
			if (this._store.isDisposed) {
				return;
			}
			const tmp = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
			try {
				await fs.promises.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
				if (this.disposed || this._store.isDisposed) {
					await fs.promises.unlink(tmp).catch(() => undefined);
					return;
				}
				await fs.promises.rename(tmp, targetPath);
				if (this.disposed || this._store.isDisposed) {
					return;
				}
				if (this.triggerMutationSeq === capturedSeq) {
					this.triggerMemoryDirty = false;
				}
			} catch {
				await fs.promises.unlink(tmp).catch(() => undefined);
			}
		};
		const next = this.triggerPersistChain.then(writeOp, writeOp);
		this.triggerPersistChain = next.catch(() => undefined);
		return next;
	}

	private isStructuralSnapshotChange(prev: IAdeMissionWatchdogSnapshot | undefined, next: IAdeMissionWatchdogSnapshot): boolean {
		if (!prev) {
			return true;
		}
		const prevBarriers = prev.barriers ?? [];
		const nextBarriers = next.barriers ?? [];
		if (
			prev.status !== next.status
			|| prev.silenceTimeoutMinutes !== next.silenceTimeoutMinutes
			|| prev.ownerWindowCtx !== next.ownerWindowCtx
			|| prev.tokens.length !== next.tokens.length
			|| prev.triggers.length !== next.triggers.length
			|| prevBarriers.length !== nextBarriers.length
		) {
			return true;
		}
		for (let i = 0; i < next.tokens.length; i++) {
			const a = prev.tokens[i];
			const b = next.tokens[i];
			if (
				a.tokenId !== b.tokenId
				|| a.nodeId !== b.nodeId
				|| a.status !== b.status
				|| a.blocked?.startedAt !== b.blocked?.startedAt
				|| a.blocked?.expiresAt !== b.blocked?.expiresAt
			) {
				return true;
			}
		}
		for (let i = 0; i < next.triggers.length; i++) {
			const a = prev.triggers[i];
			const b = next.triggers[i];
			if (a.id !== b.id || a.enabled !== b.enabled || a.fireAt !== b.fireAt || a.cronExpr !== b.cronExpr || a.intervalMs !== b.intervalMs) {
				return true;
			}
		}
		for (let i = 0; i < nextBarriers.length; i++) {
			const a = prevBarriers[i];
			const b = nextBarriers[i];
			if (a.barrierId !== b.barrierId || a.parentTokenId !== b.parentTokenId || a.deadlineAt !== b.deadlineAt) {
				return true;
			}
		}
		return false;
	}

	private markSnapshotDirty(): void {
		this.snapshotDirty = true;
		this.snapshotMutationSeq++;
	}

	private markTriggerMemoryDirty(): void {
		this.triggerMemoryDirty = true;
		this.triggerMutationSeq++;
	}

	private reserveProbeKey(key: string): number | undefined {
		if (this.inFlightProbeKeys.has(key)) {
			return undefined;
		}
		const seq = ++this.probeSeq;
		this.inFlightProbeKeys.set(key, seq);
		return seq;
	}

	private releaseProbeKey(key: string, seq: number): void {
		if (this.inFlightProbeKeys.get(key) === seq) {
			this.inFlightProbeKeys.delete(key);
		}
	}

	syncMission(snapshot: IAdeMissionWatchdogSnapshot): void {
		if (this._store.isDisposed) {
			return;
		}
		this.explicitlyRemovedMissionIds.delete(snapshot.missionId);
		const existing = this.snapshots.get(snapshot.missionId);
		const effectiveOwnerWindowCtx = snapshot.preserveExistingOwner && existing?.ownerWindowCtx
			? existing.ownerWindowCtx
			: (snapshot.ownerWindowCtx ?? existing?.ownerWindowCtx);
		const storedSnapshot: IAdeMissionWatchdogSnapshot = {
			...snapshot,
			...(effectiveOwnerWindowCtx ? { ownerWindowCtx: effectiveOwnerWindowCtx } : {}),
		};
		const structuralChange = this.isStructuralSnapshotChange(existing, storedSnapshot);
		this.snapshots.set(snapshot.missionId, storedSnapshot);
		this.markSnapshotDirty();
		// Debounce pure activity-heartbeat syncs (every 5s) to prevent SSD write storms,
		// while immediately persisting structural state transitions (status/tokens/triggers).
		this.scheduleSnapshotPersist(structuralChange);

		// Clean stale per-token trackers for this mission.
		const prevTokensById = new Map((existing?.tokens ?? []).map(t => [t.tokenId, t]));
		const liveTokenKeys = new Set<string>();
		for (const token of snapshot.tokens) {
			const key = `${snapshot.missionId}:${token.tokenId}`;
			liveTokenKeys.add(key);
			const prevTok = prevTokensById.get(token.tokenId);
			if (token.status !== 'blocked' || (prevTok?.blocked?.startedAt !== undefined && token.blocked?.startedAt !== prevTok.blocked.startedAt)) {
				this.blockedWakeupNotified.delete(key);
			}
			if (token.status !== 'active') {
				this.lastSilenceWakeupAt.delete(key);
				this.lastAgentExitWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.lastSilenceWakeupAt.keys())) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTokenKeys.has(key)) {
				this.lastSilenceWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.lastAgentExitWakeupAt.keys())) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTokenKeys.has(key)) {
				this.lastAgentExitWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.blockedWakeupNotified)) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTokenKeys.has(key)) {
				this.blockedWakeupNotified.delete(key);
			}
		}

		// Clean stale / extended barrier deadline notifications.
		const prevBarriersById = new Map((existing?.barriers ?? []).map(b => [b.barrierId, b]));
		const liveBarrierKeys = new Set<string>();
		for (const barrier of snapshot.barriers ?? []) {
			const bKey = `${snapshot.missionId}:${barrier.barrierId}`;
			liveBarrierKeys.add(bKey);
			const prevBarrier = prevBarriersById.get(barrier.barrierId);
			if (prevBarrier && barrier.deadlineAt > prevBarrier.deadlineAt) {
				this.barrierDeadlineNotifiedAt.delete(bKey);
			}
		}
		for (const key of Array.from(this.barrierDeadlineNotifiedAt.keys())) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveBarrierKeys.has(key)) {
				this.barrierDeadlineNotifiedAt.delete(key);
			}
		}

		// Clean stale trigger trackers & reset re-armed `once` triggers when fireAt/fireCount changes.
		const prevTriggersById = new Map((existing?.triggers ?? []).map(t => [t.id, t]));
		let triggerMemMutated = false;
		for (const trig of snapshot.triggers) {
			if (trig.kind === 'once') {
				const prevTrig = prevTriggersById.get(trig.id);
				const trigKey = `${snapshot.missionId}:${trig.id}`;
				const mem = this.triggerMemory.get(trigKey);
				if (prevTrig && (prevTrig.fireAt !== trig.fireAt || (trig.fireCount === 0 && prevTrig.fireCount > 0))) {
					const nextMem = mem ?? {};
					nextMem.firedOnce = false;
					nextMem.rearmedFireAt = trig.fireAt;
					this.triggerMemory.set(trigKey, nextMem);
					triggerMemMutated = true;
				}
			}
		}
		const liveTriggerKeys = new Set(snapshot.triggers.map(t => `${snapshot.missionId}:${t.id}`));
		for (const key of Array.from(this.triggerMemory.keys())) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTriggerKeys.has(key)) {
				this.triggerMemory.delete(key);
				triggerMemMutated = true;
			}
		}
		if (triggerMemMutated) {
			this.markTriggerMemoryDirty();
			void this.persistTriggerMemoryIfDirty();
		}

		this.reconcileTimer();
	}

	removeMission(missionId: string): void {
		this.explicitlyRemovedMissionIds.add(missionId);
		this.snapshots.delete(missionId);
		this.markSnapshotDirty();
		void this.persistSnapshotsIfDirty();
		const prefix = `${missionId}:`;
		for (const key of Array.from(this.lastSilenceWakeupAt.keys())) {
			if (key.startsWith(prefix)) {
				this.lastSilenceWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.lastAgentExitWakeupAt.keys())) {
			if (key.startsWith(prefix)) {
				this.lastAgentExitWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.blockedWakeupNotified)) {
			if (key.startsWith(prefix)) {
				this.blockedWakeupNotified.delete(key);
			}
		}
		for (const key of Array.from(this.barrierDeadlineNotifiedAt.keys())) {
			if (key.startsWith(prefix)) {
				this.barrierDeadlineNotifiedAt.delete(key);
			}
		}
		let removedAnyTrigger = false;
		for (const key of Array.from(this.triggerMemory.keys())) {
			if (key.startsWith(prefix)) {
				this.triggerMemory.delete(key);
				removedAnyTrigger = true;
			}
		}
		if (removedAnyTrigger) {
			this.markTriggerMemoryDirty();
			void this.persistTriggerMemoryIfDirty();
		}
		this.reconcileTimer();
	}

	getTrackedMissionIds(): readonly string[] {
		return Array.from(this.snapshots.keys());
	}

	getMissionOwnerWindowCtx(missionId: string): string | undefined {
		return this.snapshots.get(missionId)?.ownerWindowCtx;
	}

	private hasRunningMission(): boolean {
		for (const snap of this.snapshots.values()) {
			if (snap.status === 'running') {
				return true;
			}
		}
		return false;
	}

	private reconcileTimer(): void {
		if (this.hasRunningMission()) {
			if (!this.timer) {
				this.timer = setInterval(() => {
					void this.runTick();
				}, this.pollIntervalMs);
				if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
					(this.timer as { unref?: () => void }).unref!();
				}
			}
		} else if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Executes one full supervision tick across all `running` Missions:
	 * 1. Phase 1 (100% synchronous zero-I/O): evaluates silence timeouts, expired blocked windows,
	 *    and ALL time-based triggers (`once`, `interval`, `cron`) immediately — a hanging remote
	 *    SSH host can NEVER stall cron schedules or local silence checks.
	 * 2. Phase 2 (batched per-host SSH + concurrent local probes): when `remoteBatchProbe` is
	 *    supported, coalesces ALL PID / file / git / GPU / persistent-session checks for each
	 *    `hostAlias` into ONE single multiplexed SSH invocation per tick!
	 */
	async runTick(): Promise<void> {
		if (this.tickInFlight) {
			this.tickPendingRerun = true;
			return this.tickInFlight;
		}
		const loop = (async () => {
			do {
				this.tickPendingRerun = false;
				await this.executeTickOnce();
			} while (this.tickPendingRerun && !this._store.isDisposed);
		})();
		this.tickInFlight = loop;
		try {
			await loop;
		} finally {
			if (this.tickInFlight === loop) {
				this.tickInFlight = undefined;
			}
		}
	}

	private async executeTickOnce(): Promise<void> {
		await Promise.all([
			this.ensureTriggerMemoryLoaded(),
			this.ensureSnapshotsLoaded(),
		]);
		const now = this.nowFn();
		const runningSnapshots = Array.from(this.snapshots.values()).filter(s => s.status === 'running');
		const asyncTasks: (() => Promise<void>)[] = [];

		// Per-host remote batch accumulator (used when remoteProbe.remoteBatchProbe is available).
		interface IHostBatchBucket {
			readonly pids: Set<number>;
			readonly filePaths: Set<string>;
			readonly gitPaths: Set<string>;
			readonly persistentPrefixes: Set<string>;
			checkGpu: boolean;
			readonly consumers: Array<(batch: IAdeRemoteBatchProbeResult) => void>;
		}
		const useRemoteBatch = Boolean(this.remoteProbe?.remoteBatchProbe);
		const hostBuckets = new Map<string, IHostBatchBucket>();
		const getHostBucket = (hostAlias: string): IHostBatchBucket => {
			let bucket = hostBuckets.get(hostAlias);
			if (!bucket) {
				bucket = {
					pids: new Set(),
					filePaths: new Set(),
					gitPaths: new Set(),
					persistentPrefixes: new Set(),
					checkGpu: false,
					consumers: [],
				};
				hostBuckets.set(hostAlias, bucket);
			}
			return bucket;
		};

		for (const snapshot of runningSnapshots) {
			const silenceMs = Math.max(1, snapshot.silenceTimeoutMinutes || 5) * 60_000;
			const busySourceNodes = new Set(
				snapshot.tokens
					.filter(t => t.status === 'active' || t.status === 'blocked')
					.map(t => t.nodeId),
			);
			const missionHasLiveWave = snapshot.tokens.some(t =>
				t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join' || t.status === 'waiting_gate',
			);

			// Phase 1a: Synchronous zero-I/O token checks (silence timeouts + expired blocked windows + join barrier deadlines).
			const BARRIER_DEADLINE_RETRY_COOLDOWN_MS = 60_000;
			for (const barrier of snapshot.barriers ?? []) {
				if (!barrier.barrierId || typeof barrier.deadlineAt !== 'number' || !Number.isFinite(barrier.deadlineAt)) {
					continue;
				}
				const bKey = `${snapshot.missionId}:${barrier.barrierId}`;
				const lastNotifiedAt = this.barrierDeadlineNotifiedAt.get(bKey);
				if (lastNotifiedAt !== undefined && now - lastNotifiedAt < BARRIER_DEADLINE_RETRY_COOLDOWN_MS) {
					continue;
				}
				if (now >= barrier.deadlineAt) {
					this.barrierDeadlineNotifiedAt.set(bKey, now);
					this._onDidWatchdogWakeup.fire({
						missionId: snapshot.missionId,
						tokenId: barrier.parentTokenId,
						nodeId: barrier.ownerNodeId,
						holderAgentId: barrier.ownerAgentId,
						reason: 'barrier_deadline_expired',
						barrierId: barrier.barrierId,
						detail: `Join barrier ${barrier.barrierId} deadline expired at ${new Date(barrier.deadlineAt).toISOString()}`,
						timestamp: now,
						...(snapshot.ownerWindowCtx ? { ownerWindowCtx: snapshot.ownerWindowCtx } : {}),
					});
				}
			}

			for (const token of snapshot.tokens) {
				if (token.status === 'active') {
					this.checkActiveSilenceTimeout(snapshot.missionId, token, silenceMs, now, snapshot.ownerWindowCtx);
					if (token.hostAlias && token.hostAlias !== 'local' && token.remoteSessionPrefix) {
						if (useRemoteBatch) {
							const bucket = getHostBucket(token.hostAlias);
							bucket.persistentPrefixes.add(token.remoteSessionPrefix);
							bucket.consumers.push(batch => {
								this.applyRemoteActiveSessionLiveness(snapshot.missionId, token, batch.persistentSessions[token.remoteSessionPrefix!], now, snapshot.ownerWindowCtx);
							});
						} else if (this.remoteProbe?.remoteCheckPersistentSessions) {
							const livenessKey = `rem:${snapshot.missionId}:${token.tokenId}`;
							const seq = this.reserveProbeKey(livenessKey);
							if (seq !== undefined) {
								asyncTasks.push(async () => {
									const probePromise = this.checkRemoteActiveSessionLiveness(snapshot.missionId, token, now, snapshot.ownerWindowCtx)
										.catch(() => undefined);
									try {
										await raceWithTimeout(probePromise, this.probeTimeoutMs, livenessKey).catch(() => undefined);
									} finally {
										this.releaseProbeKey(livenessKey, seq);
									}
								});
							}
						}
					}
				} else if (token.status === 'blocked' && token.blocked) {
					const blocked = token.blocked;
					const key = `${snapshot.missionId}:${token.tokenId}`;
					if (this.blockedWakeupNotified.has(key)) {
						continue;
					}
					if (now >= blocked.expiresAt) {
						this.blockedWakeupNotified.add(key);
						this._onDidWatchdogWakeup.fire({
							missionId: snapshot.missionId,
							tokenId: token.tokenId,
							nodeId: token.nodeId,
							holderAgentId: token.holderAgentId,
							reason: 'block_expired',
							detail: `Blocked window expired (${blocked.reason})`,
							timestamp: now,
							...(snapshot.ownerWindowCtx ? { ownerWindowCtx: snapshot.ownerWindowCtx } : {}),
						});
						continue;
					}
					const isRemote = Boolean(blocked.hostAlias && blocked.hostAlias !== 'local');
					if (isRemote && useRemoteBatch && blocked.hostAlias) {
						const bucket = getHostBucket(blocked.hostAlias);
						if (blocked.watchPid && Number.isInteger(blocked.watchPid) && blocked.watchPid > 0) {
							bucket.pids.add(blocked.watchPid);
						}
						if (blocked.watchFile?.trim()) {
							bucket.filePaths.add(blocked.watchFile.trim());
						}
						bucket.consumers.push(batch => {
							this.applyBatchedBlockedWakeup(snapshot.missionId, token, batch, now, snapshot.ownerWindowCtx);
						});
					} else {
						const probeKey = `blk:${snapshot.missionId}:${token.tokenId}`;
						const seq = this.reserveProbeKey(probeKey);
						if (seq !== undefined) {
							asyncTasks.push(async () => {
								const probePromise = this.checkBlockedWakeup(snapshot.missionId, token, now, snapshot.ownerWindowCtx)
									.catch(() => undefined);
								try {
									await raceWithTimeout(probePromise, this.probeTimeoutMs, probeKey).catch(() => undefined);
								} finally {
									this.releaseProbeKey(probeKey, seq);
								}
							});
						}
					}
				}
			}

			// Phase 1b: Synchronous zero-I/O time triggers (`once`, `interval`, `cron`) fire BEFORE any SSH probe!
			for (const trigger of snapshot.triggers) {
				if (!trigger.enabled) {
					continue;
				}
				const isGpuIdle = trigger.kind === 'event' && trigger.eventType === 'gpu_idle';
				// For gpu_idle we still sample GPU utilization while a wave is running so busy->idle hysteresis
				// can re-arm cleanly once the downstream node occupies the GPU!
				if (!isGpuIdle && busySourceNodes.has(trigger.nodeId)) {
					continue;
				}
				if (trigger.kind === 'once' || trigger.kind === 'interval' || trigger.kind === 'cron') {
					this.evaluateTimeTriggerSync(snapshot.missionId, trigger, now, snapshot.ownerWindowCtx);
					continue;
				}
				if (trigger.kind === 'event' && trigger.eventType) {
					const hostAlias = trigger.hostAlias && trigger.hostAlias !== 'local' ? trigger.hostAlias : undefined;
					if (hostAlias && useRemoteBatch) {
						const bucket = getHostBucket(hostAlias);
						if ((trigger.eventType === 'file_created' || trigger.eventType === 'file_changed') && trigger.targetPath) {
							bucket.filePaths.add(trigger.targetPath);
						} else if (trigger.eventType === 'git_updated' && trigger.targetPath) {
							bucket.gitPaths.add(trigger.targetPath);
						} else if (trigger.eventType === 'gpu_idle') {
							bucket.checkGpu = true;
						}
						bucket.consumers.push(batch => {
							this.applyBatchedEventTrigger(snapshot.missionId, trigger, batch, now, snapshot.ownerWindowCtx, missionHasLiveWave);
						});
					} else {
						const trigKey = `trg:${snapshot.missionId}:${trigger.id}`;
						const seq = this.reserveProbeKey(trigKey);
						if (seq !== undefined) {
							asyncTasks.push(async () => {
								const trigPromise = this.evaluateTrigger(snapshot.missionId, trigger, now, snapshot.ownerWindowCtx, missionHasLiveWave)
									.catch(() => undefined);
								try {
									await raceWithTimeout(trigPromise, this.probeTimeoutMs, trigKey).catch(() => undefined);
								} finally {
									this.releaseProbeKey(trigKey, seq);
								}
							});
						}
					}
				}
			}
		}

		// Flush Phase-1 cron/time trigger memory immediately so a slow SSH host never delays cron persistence!
		if (this.triggerMemoryDirty) {
			await this.persistTriggerMemoryIfDirty();
		}

		// Enqueue ONE batched SSH probe per remote Cloud Host (per-host in-flight deduplication).
		if (useRemoteBatch && this.remoteProbe?.remoteBatchProbe) {
			const batchFn = this.remoteProbe.remoteBatchProbe.bind(this.remoteProbe);
			for (const [hostAlias, bucket] of hostBuckets.entries()) {
				const hostKey = `host-batch:${hostAlias}`;
				const seq = this.reserveProbeKey(hostKey);
				if (seq === undefined) {
					continue;
				}
				asyncTasks.push(async () => {
					const probePromise = batchFn(hostAlias, {
						pids: [...bucket.pids],
						filePaths: [...bucket.filePaths],
						gitPaths: [...bucket.gitPaths],
						persistentPrefixes: [...bucket.persistentPrefixes],
						checkGpu: bucket.checkGpu,
					}).then(result => {
						for (const consume of bucket.consumers) {
							try { consume(result); } catch { /* Isolate per-consumer failure */ }
						}
					}).catch(() => undefined);
					try {
						await raceWithTimeout(probePromise, this.probeTimeoutMs, hostKey).catch(() => undefined);
					} finally {
						this.releaseProbeKey(hostKey, seq);
					}
				});
			}
		}

		await runWithConcurrency(asyncTasks, this.maxConcurrentProbes);
		await Promise.all([
			this.persistTriggerMemoryIfDirty(),
			this.persistSnapshotsIfDirty(),
		]);
	}

	private applyRemoteActiveSessionLiveness(
		missionId: string,
		token: IAdeWatchdogTokenSpec,
		status: { readonly aliveCount: number; readonly exitedCodes: readonly number[] } | undefined,
		now: number,
		ownerWindowCtx?: string,
	): void {
		if (!status || status.aliveCount > 0) {
			return;
		}
		const key = `${missionId}:${token.tokenId}`;
		const lastAlert = this.lastAgentExitWakeupAt.get(key) ?? 0;
		const referenceTs = Math.max(token.lastActivityAt, token.lastNudgeAt ?? 0);
		if (now - referenceTs < this.remoteSessionProbeGraceMs) {
			return;
		}
		if (lastAlert > 0 && now - lastAlert < this.remoteSessionExitCooldownMs) {
			return;
		}
		this.lastAgentExitWakeupAt.set(key, now);
		const detail = status.exitedCodes.length > 0
			? `remote persistent session on ${token.hostAlias} exited with code ${status.exitedCodes[0]}`
			: `no live remote persistent session (${token.remoteSessionPrefix}) found on ${token.hostAlias}`;
		this._onDidWatchdogWakeup.fire({
			missionId,
			tokenId: token.tokenId,
			nodeId: token.nodeId,
			holderAgentId: token.holderAgentId,
			reason: 'agent_exited',
			detail,
			timestamp: now,
			...(ownerWindowCtx ? { ownerWindowCtx } : {}),
		});
	}

	private applyBatchedBlockedWakeup(
		missionId: string,
		token: IAdeWatchdogTokenSpec,
		batch: IAdeRemoteBatchProbeResult,
		now: number,
		ownerWindowCtx?: string,
	): void {
		const blocked = token.blocked;
		if (!blocked) {
			return;
		}
		const key = `${missionId}:${token.tokenId}`;
		if (this.blockedWakeupNotified.has(key)) {
			return;
		}
		if (blocked.watchPid && Number.isInteger(blocked.watchPid) && blocked.watchPid > 0) {
			const alive = batch.pidAlive[blocked.watchPid];
			if (alive === false) {
				this.blockedWakeupNotified.add(key);
				this._onDidWatchdogWakeup.fire({
					missionId,
					tokenId: token.tokenId,
					nodeId: token.nodeId,
					holderAgentId: token.holderAgentId,
					reason: 'pid_exited',
					detail: `Watched PID ${blocked.watchPid} exited on ${blocked.hostAlias || 'local'}`,
					timestamp: now,
					...(ownerWindowCtx ? { ownerWindowCtx } : {}),
				});
				return;
			}
		}
		const watchFile = blocked.watchFile?.trim();
		if (watchFile) {
			const mtime = batch.fileMtime[watchFile];
			const signature = batch.fileSignature?.[watchFile];
			const clockOffsetMs = typeof batch.remoteNowMs === 'number' ? batch.remoteNowMs - now : 0;
			if (this.isBlockedFileReady(blocked, mtime, clockOffsetMs, signature)) {
				this.blockedWakeupNotified.add(key);
				this._onDidWatchdogWakeup.fire({
					missionId,
					tokenId: token.tokenId,
					nodeId: token.nodeId,
					holderAgentId: token.holderAgentId,
					reason: 'file_ready',
					detail: `Watched file ready: ${watchFile} on ${blocked.hostAlias || 'local'}`,
					timestamp: now,
					...(ownerWindowCtx ? { ownerWindowCtx } : {}),
				});
			}
		}
	}

	private isBlockedFileReady(
		blocked: NonNullable<IAdeWatchdogTokenSpec['blocked']>,
		mtime: number | undefined,
		remoteClockOffsetMs = 0,
		signature?: string,
	): boolean {
		if (mtime === undefined && signature === undefined) {
			return false;
		}
		if (blocked.initialFileSignature === null || blocked.initialFileMtime === null) {
			return true;
		}
		if (typeof blocked.initialFileSignature === 'string' && signature !== undefined) {
			return signature !== blocked.initialFileSignature;
		}
		if (mtime === undefined) {
			return false;
		}
		if (typeof blocked.initialFileMtime === 'number') {
			return mtime !== blocked.initialFileMtime;
		}
		// Fallback when no initialFileMtime baseline was captured: shift startedAt onto target host's own clock
		// using remoteNowMs offset so cross-host clock skew still cannot suppress file_ready wakeups!
		const targetStartedAtSecMs = Math.floor((blocked.startedAt + remoteClockOffsetMs) / 1000) * 1000;
		return mtime >= targetStartedAtSecMs;
	}

	private applyBatchedEventTrigger(
		missionId: string,
		trigger: IMissionSourceTrigger,
		batch: IAdeRemoteBatchProbeResult,
		now: number,
		ownerWindowCtx: string | undefined,
		missionHasLiveWave: boolean,
	): void {
		const key = `${missionId}:${trigger.id}`;
		let mem = this.triggerMemory.get(key);
		if (!mem) {
			mem = {};
			this.triggerMemory.set(key, mem);
		}
		const lastFiredAt = Math.max(trigger.lastFiredAt ?? 0, mem.lastFiredAt ?? 0);
		if (trigger.eventType === 'file_created' || trigger.eventType === 'file_changed') {
			if (!trigger.targetPath) { return; }
			this.applyFileEventObservation(missionId, trigger, mem, batch.fileMtime[trigger.targetPath], now, ownerWindowCtx);
		} else if (trigger.eventType === 'git_updated') {
			if (!trigger.targetPath) { return; }
			this.applyGitEventObservation(missionId, trigger, mem, batch.gitHead[trigger.targetPath], now, ownerWindowCtx);
		} else if (trigger.eventType === 'gpu_idle') {
			this.applyGpuIdleObservation(missionId, trigger, mem, batch.gpuUtilPct, lastFiredAt, now, ownerWindowCtx, missionHasLiveWave);
		}
	}

	private async checkRemoteActiveSessionLiveness(
		missionId: string,
		token: IAdeWatchdogTokenSpec,
		now: number,
		ownerWindowCtx?: string,
	): Promise<void> {
		if (!this.remoteProbe?.remoteCheckPersistentSessions || !token.hostAlias || token.hostAlias === 'local' || !token.remoteSessionPrefix) {
			return;
		}
		const key = `${missionId}:${token.tokenId}`;
		const lastAlert = this.lastAgentExitWakeupAt.get(key) ?? 0;
		const referenceTs = Math.max(token.lastActivityAt, token.lastNudgeAt ?? 0);
		if (now - referenceTs < this.remoteSessionProbeGraceMs) {
			return;
		}
		if (lastAlert > 0 && now - lastAlert < this.remoteSessionExitCooldownMs) {
			return;
		}
		const status = await this.remoteProbe.remoteCheckPersistentSessions(token.hostAlias, token.remoteSessionPrefix);
		this.applyRemoteActiveSessionLiveness(missionId, token, status, now, ownerWindowCtx);
	}

	private checkActiveSilenceTimeout(missionId: string, token: IAdeWatchdogTokenSpec, silenceMs: number, now: number, ownerWindowCtx?: string): void {
		const key = `${missionId}:${token.tokenId}`;
		const localLast = this.lastSilenceWakeupAt.get(key) ?? 0;
		const referenceTs = Math.max(token.lastActivityAt, token.lastNudgeAt ?? 0, localLast);
		if (now - referenceTs < silenceMs) {
			return;
		}
		this.lastSilenceWakeupAt.set(key, now);
		this._onDidWatchdogWakeup.fire({
			missionId,
			tokenId: token.tokenId,
			nodeId: token.nodeId,
			holderAgentId: token.holderAgentId,
			reason: 'silence_timeout',
			detail: `No activity for ${Math.round((now - token.lastActivityAt) / 60_000)}m`,
			timestamp: now,
			...(ownerWindowCtx ? { ownerWindowCtx } : {}),
		});
	}

	private async checkBlockedWakeup(missionId: string, token: IAdeWatchdogTokenSpec, now: number, ownerWindowCtx?: string): Promise<void> {
		const blocked = token.blocked;
		if (!blocked) {
			return;
		}
		const key = `${missionId}:${token.tokenId}`;
		if (this.blockedWakeupNotified.has(key)) {
			return;
		}

		// 1. Maximum blocked duration expired
		if (now >= blocked.expiresAt) {
			this.blockedWakeupNotified.add(key);
			this._onDidWatchdogWakeup.fire({
				missionId,
				tokenId: token.tokenId,
				nodeId: token.nodeId,
				holderAgentId: token.holderAgentId,
				reason: 'block_expired',
				detail: `Blocked window expired (${blocked.reason})`,
				timestamp: now,
				...(ownerWindowCtx ? { ownerWindowCtx } : {}),
			});
			return;
		}

		const isRemote = Boolean(blocked.hostAlias && blocked.hostAlias !== 'local');

		// 2. Early wakeup on PID exit (local or remote SSH)
		if (blocked.watchPid && Number.isInteger(blocked.watchPid) && blocked.watchPid > 0) {
			let alive = true;
			try {
				if (isRemote && this.remoteProbe && blocked.hostAlias) {
					alive = await raceWithTimeout(
						this.remoteProbe.remoteIsPidAlive(blocked.hostAlias, blocked.watchPid),
						this.probeTimeoutMs,
						`remoteIsPidAlive:${blocked.hostAlias}:${blocked.watchPid}`,
					);
				} else if (!isRemote) {
					alive = await raceWithTimeout(
						this.localProbe.isPidAlive(blocked.watchPid),
						this.probeTimeoutMs,
						`localIsPidAlive:${blocked.watchPid}`,
					);
				}
			} catch {
				// Transient probe failure or timeout should NOT falsely wake the employee.
				alive = true;
			}
			if (!alive) {
				this.blockedWakeupNotified.add(key);
				this._onDidWatchdogWakeup.fire({
					missionId,
					tokenId: token.tokenId,
					nodeId: token.nodeId,
					holderAgentId: token.holderAgentId,
					reason: 'pid_exited',
					detail: `Watched PID ${blocked.watchPid} exited on ${blocked.hostAlias || 'local'}`,
					timestamp: now,
					...(ownerWindowCtx ? { ownerWindowCtx } : {}),
				});
				return;
			}
		}

		// 3. Early wakeup on file arrival/update (local or remote SSH, clock-drift safe via target-host baseline mtime/signature)
		if (blocked.watchFile && blocked.watchFile.trim()) {
			let mtime: number | undefined;
			let signature: string | undefined;
			try {
				if (isRemote && this.remoteProbe && blocked.hostAlias) {
					if (typeof blocked.initialFileSignature === 'string' && this.remoteProbe.remoteFileStatSignature) {
						signature = await raceWithTimeout(
							this.remoteProbe.remoteFileStatSignature(blocked.hostAlias, blocked.watchFile),
							this.probeTimeoutMs,
							`remoteFileStatSignature:${blocked.hostAlias}:${blocked.watchFile}`,
						);
					}
					if (signature === undefined) {
						mtime = await raceWithTimeout(
							this.remoteProbe.remoteFileStatMtime(blocked.hostAlias, blocked.watchFile),
							this.probeTimeoutMs,
							`remoteFileStatMtime:${blocked.hostAlias}:${blocked.watchFile}`,
						);
					}
				} else if (!isRemote) {
					if (typeof blocked.initialFileSignature === 'string' && this.localProbe.fileStatSignature) {
						signature = await raceWithTimeout(
							this.localProbe.fileStatSignature(blocked.watchFile),
							this.probeTimeoutMs,
							`localFileStatSignature:${blocked.watchFile}`,
						);
					}
					if (signature === undefined) {
						mtime = await raceWithTimeout(
							this.localProbe.fileStatMtime(blocked.watchFile),
							this.probeTimeoutMs,
							`localFileStatMtime:${blocked.watchFile}`,
						);
					}
				}
			} catch {
				mtime = undefined;
				signature = undefined;
			}
			if (this.isBlockedFileReady(blocked, mtime, 0, signature)) {
				this.blockedWakeupNotified.add(key);
				this._onDidWatchdogWakeup.fire({
					missionId,
					tokenId: token.tokenId,
					nodeId: token.nodeId,
					holderAgentId: token.holderAgentId,
					reason: 'file_ready',
					detail: `Watched file ready: ${blocked.watchFile} on ${blocked.hostAlias || 'local'}`,
					timestamp: now,
					...(ownerWindowCtx ? { ownerWindowCtx } : {}),
				});
			}
		}
	}

	private evaluateTimeTriggerSync(missionId: string, trigger: IMissionSourceTrigger, now: number, ownerWindowCtx?: string): void {
		const key = `${missionId}:${trigger.id}`;
		let mem = this.triggerMemory.get(key);
		if (!mem) {
			mem = {};
			this.triggerMemory.set(key, mem);
		}
		const lastFiredAt = Math.max(trigger.lastFiredAt ?? 0, mem.lastFiredAt ?? 0);

		if (trigger.kind === 'once') {
			const isRearmed = mem.rearmedFireAt !== undefined && mem.rearmedFireAt === trigger.fireAt;
			if (mem.firedOnce || (trigger.fireCount > 0 && !isRearmed)) {
				return;
			}
			if (typeof trigger.fireAt === 'number' && now >= trigger.fireAt) {
				mem.firedOnce = true;
				mem.rearmedFireAt = undefined;
				mem.lastFiredAt = now;
				this.markTriggerMemoryDirty();
				this.emitTriggerFire(missionId, trigger, now, `One-shot schedule reached (${new Date(trigger.fireAt).toISOString()})`, ownerWindowCtx);
			}
			return;
		}

		if (trigger.kind === 'interval') {
			if (typeof trigger.intervalMs !== 'number' || !Number.isFinite(trigger.intervalMs) || trigger.intervalMs < 5_000) {
				return;
			}
			const intervalMs = trigger.intervalMs;
			if (lastFiredAt === 0) {
				mem.lastFiredAt = now;
				this.markTriggerMemoryDirty();
				return;
			}
			if (now - lastFiredAt >= intervalMs) {
				mem.lastFiredAt = now;
				this.markTriggerMemoryDirty();
				this.emitTriggerFire(missionId, trigger, now, `Interval trigger (${intervalMs}ms)`, ownerWindowCtx);
			}
			return;
		}

		if (trigger.kind === 'cron') {
			if (!trigger.cronExpr) {
				return;
			}
			const minuteBucket = Math.floor(now / 60_000);
			if (mem.lastCronMinuteBucket === minuteBucket) {
				return;
			}
			if (matchesCronExpression(trigger.cronExpr, new Date(now))) {
				mem.lastCronMinuteBucket = minuteBucket;
				mem.lastFiredAt = now;
				this.markTriggerMemoryDirty();
				this.emitTriggerFire(missionId, trigger, now, `Cron matched (${trigger.cronExpr})`, ownerWindowCtx);
			}
		}
	}

	private async evaluateTrigger(
		missionId: string,
		trigger: IMissionSourceTrigger,
		now: number,
		ownerWindowCtx?: string,
		missionHasLiveWave = false,
	): Promise<void> {
		if (trigger.kind === 'once' || trigger.kind === 'interval' || trigger.kind === 'cron') {
			this.evaluateTimeTriggerSync(missionId, trigger, now, ownerWindowCtx);
			return;
		}
		const key = `${missionId}:${trigger.id}`;
		let mem = this.triggerMemory.get(key);
		if (!mem) {
			mem = {};
			this.triggerMemory.set(key, mem);
		}
		const lastFiredAt = Math.max(trigger.lastFiredAt ?? 0, mem.lastFiredAt ?? 0);

		if (trigger.kind === 'event' && trigger.eventType) {
			await this.evaluateEventTrigger(missionId, trigger, mem, lastFiredAt, now, ownerWindowCtx, missionHasLiveWave);
		}
	}

	private applyFileEventObservation(
		missionId: string,
		trigger: IMissionSourceTrigger,
		mem: ITriggerMonitorMemory,
		mtime: number | undefined,
		now: number,
		ownerWindowCtx?: string,
	): void {
		if (trigger.eventType === 'file_created') {
			const existsNow = mtime !== undefined;
			const existedBefore = mem.fileExisted;
			if (mem.fileExisted !== existsNow) {
				mem.fileExisted = existsNow;
				this.markTriggerMemoryDirty();
			}
			if (existedBefore === undefined) {
				if (existsNow) {
					mem.lastFileMtime = mtime;
				}
				this.markTriggerMemoryDirty();
				return;
			}
			if (!existedBefore && existsNow) {
				mem.lastFileMtime = mtime;
				mem.lastFiredAt = now;
				this.markTriggerMemoryDirty();
				this.emitTriggerFire(missionId, trigger, now, `File created: ${trigger.targetPath}`, ownerWindowCtx);
			}
			return;
		}

		// file_changed
		if (mtime === undefined) {
			return;
		}
		if (mem.lastFileMtime === undefined) {
			mem.lastFileMtime = mtime;
			this.markTriggerMemoryDirty();
			return;
		}
		if (mtime !== mem.lastFileMtime) {
			mem.lastFileMtime = mtime;
			mem.lastFiredAt = now;
			this.markTriggerMemoryDirty();
			this.emitTriggerFire(missionId, trigger, now, `File changed: ${trigger.targetPath}`, ownerWindowCtx);
		}
	}

	private applyGitEventObservation(
		missionId: string,
		trigger: IMissionSourceTrigger,
		mem: ITriggerMonitorMemory,
		sha: string | undefined,
		now: number,
		ownerWindowCtx?: string,
	): void {
		if (!sha) {
			return;
		}
		if (mem.lastGitHead === undefined) {
			mem.lastGitHead = sha;
			this.markTriggerMemoryDirty();
			return;
		}
		if (sha !== mem.lastGitHead) {
			const prev = mem.lastGitHead;
			mem.lastGitHead = sha;
			mem.lastFiredAt = now;
			this.markTriggerMemoryDirty();
			this.emitTriggerFire(missionId, trigger, now, `Git HEAD changed ${prev.slice(0, 7)} -> ${sha.slice(0, 7)}`, ownerWindowCtx);
		}
	}

	/**
	 * Edge-triggered GPU idle detector with Mission-wide active-wave guard:
	 * - Fires at most once on an idle window, then latches `gpuIdleDisarmed = true` until GPU
	 *   utilization actually rises above threshold (`utilPct > threshold`, proving a real workload
	 *   ran on the GPU before returning to idle).
	 * - Never launches a new batch while ANY wave token is still active/blocked/waiting downstream
	 *   on this Mission (e.g. while downstream nodes are still preparing data before occupying GPU).
	 */
	private applyGpuIdleObservation(
		missionId: string,
		trigger: IMissionSourceTrigger,
		mem: ITriggerMonitorMemory,
		utilPct: number | undefined,
		lastFiredAt: number,
		now: number,
		ownerWindowCtx: string | undefined,
		missionHasLiveWave: boolean,
	): void {
		if (utilPct === undefined) {
			return;
		}
		const threshold = Math.max(0, Math.min(100, trigger.gpuUtilThresholdPct ?? 10));
		if (utilPct > threshold) {
			// GPU became genuinely busy -> re-arm edge detector for the next busy -> idle transition!
			if (mem.gpuIdleDisarmed) {
				mem.gpuIdleDisarmed = false;
				this.markTriggerMemoryDirty();
			}
			return;
		}
		if (missionHasLiveWave || mem.gpuIdleDisarmed) {
			return;
		}
		if (lastFiredAt > 0 && now - lastFiredAt < GPU_IDLE_COOLDOWN_MS) {
			return;
		}
		const hostLabel = trigger.hostAlias && trigger.hostAlias !== 'local' ? trigger.hostAlias : 'local';
		mem.gpuIdleDisarmed = true;
		mem.lastFiredAt = now;
		this.markTriggerMemoryDirty();
		this.emitTriggerFire(missionId, trigger, now, `GPU idle on ${hostLabel} (${utilPct}% <= ${threshold}%)`, ownerWindowCtx);
	}

	private async evaluateEventTrigger(
		missionId: string,
		trigger: IMissionSourceTrigger,
		mem: ITriggerMonitorMemory,
		lastFiredAt: number,
		now: number,
		ownerWindowCtx?: string,
		missionHasLiveWave = false,
	): Promise<void> {
		const hostAlias = trigger.hostAlias && trigger.hostAlias !== 'local' ? trigger.hostAlias : undefined;

		if (trigger.eventType === 'file_created' || trigger.eventType === 'file_changed') {
			if (!trigger.targetPath) {
				return;
			}
			let mtime: number | undefined;
			try {
				mtime = hostAlias && this.remoteProbe
					? await raceWithTimeout(this.remoteProbe.remoteFileStatMtime(hostAlias, trigger.targetPath), this.probeTimeoutMs, `triggerFileStat:${hostAlias}`)
					: !hostAlias
						? await raceWithTimeout(this.localProbe.fileStatMtime(trigger.targetPath), this.probeTimeoutMs, `triggerFileStat:local`)
						: undefined;
			} catch {
				return;
			}
			this.applyFileEventObservation(missionId, trigger, mem, mtime, now, ownerWindowCtx);
			return;
		}

		if (trigger.eventType === 'git_updated') {
			if (!trigger.targetPath) {
				return;
			}
			let sha: string | undefined;
			try {
				sha = hostAlias && this.remoteProbe
					? await raceWithTimeout(this.remoteProbe.remoteGitHeadCommit(hostAlias, trigger.targetPath), this.probeTimeoutMs, `triggerGit:${hostAlias}`)
					: !hostAlias
						? await raceWithTimeout(this.localProbe.gitHeadCommit(trigger.targetPath), this.probeTimeoutMs, `triggerGit:local`)
						: undefined;
			} catch {
				return;
			}
			this.applyGitEventObservation(missionId, trigger, mem, sha, now, ownerWindowCtx);
			return;
		}

		if (trigger.eventType === 'gpu_idle') {
			let utilPct: number | undefined;
			try {
				utilPct = hostAlias && this.remoteProbe
					? await raceWithTimeout(this.remoteProbe.remoteGpuUtilizationPct(hostAlias), this.probeTimeoutMs, `triggerGpu:${hostAlias}`)
					: !hostAlias
						? await raceWithTimeout(this.localProbe.gpuUtilizationPct(), this.probeTimeoutMs, `triggerGpu:local`)
						: undefined;
			} catch {
				return;
			}
			this.applyGpuIdleObservation(missionId, trigger, mem, utilPct, lastFiredAt, now, ownerWindowCtx, missionHasLiveWave);
		}
	}

	private emitTriggerFire(missionId: string, trigger: IMissionSourceTrigger, timestamp: number, detail: string, ownerWindowCtx?: string): void {
		this._onDidSourceTriggerFire.fire({
			missionId,
			triggerId: trigger.id,
			nodeId: trigger.nodeId,
			kind: trigger.kind,
			detail,
			timestamp,
			...(ownerWindowCtx ? { ownerWindowCtx } : {}),
		});
	}

	override dispose(): void {
		this.disposed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.snapshotFlushTimer !== undefined) {
			clearTimeout(this.snapshotFlushTimer);
			this.snapshotFlushTimer = undefined;
		}
		if (this.snapshotDirty && this.snapshotStatePath) {
			try {
				const payloadObj: Record<string, IAdeMissionWatchdogSnapshot> = {};
				for (const [missionId, snap] of this.snapshots.entries()) {
					if (snap.status === 'running') {
						payloadObj[missionId] = snap;
					}
				}
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must flush pending watchdog snapshots before shutdown.
				fs.mkdirSync(path.dirname(this.snapshotStatePath), { recursive: true, mode: 0o700 });
				const tmp = `${this.snapshotStatePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must flush pending watchdog snapshots before shutdown.
				fs.writeFileSync(tmp, JSON.stringify(payloadObj, null, 2), { encoding: 'utf8', mode: 0o600 });
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and commits watchdog snapshots atomically before shutdown.
				fs.renameSync(tmp, this.snapshotStatePath);
			} catch {
				// Best-effort flush on teardown
			}
		}
		if (this.triggerMemoryDirty && this.triggerStatePath) {
			try {
				const payloadObj: Record<string, ITriggerMonitorMemory> = {};
				for (const [k, v] of this.triggerMemory.entries()) {
					payloadObj[k] = { ...v };
				}
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must flush pending trigger state before shutdown.
				fs.mkdirSync(path.dirname(this.triggerStatePath), { recursive: true, mode: 0o700 });
				const tmp = `${this.triggerStatePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must flush pending trigger state before shutdown.
				fs.writeFileSync(tmp, JSON.stringify(payloadObj, null, 2), { encoding: 'utf8', mode: 0o600 });
				// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and commits trigger state atomically before shutdown.
				fs.renameSync(tmp, this.triggerStatePath);
			} catch {
				// Best-effort flush on teardown
			}
		}
		this.snapshotDirty = false;
		this.triggerMemoryDirty = false;
		super.dispose();
	}
}
