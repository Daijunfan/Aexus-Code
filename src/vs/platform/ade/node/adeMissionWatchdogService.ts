/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import {
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogTokenSpec,
	IAdeWatchdogWakeupEvent,
} from '../common/adeEngineering.js';
import { IMissionSourceTrigger, matchesCronExpression } from '../common/adeMissionEngine.js';

export interface IAdeRemoteWatchdogProbe {
	remoteIsPidAlive(authority: string, pid: number): Promise<boolean>;
	remoteFileStatMtime(authority: string, remotePath: string): Promise<number | undefined>;
	remoteGitHeadCommit(authority: string, projectPath: string): Promise<string | undefined>;
	remoteGpuUtilizationPct(authority: string): Promise<number | undefined>;
}

export interface IAdeLocalWatchdogProbe {
	isPidAlive(pid: number): Promise<boolean>;
	fileStatMtime(filePath: string): Promise<number | undefined>;
	gitHeadCommit(projectPath: string): Promise<string | undefined>;
	gpuUtilizationPct(): Promise<number | undefined>;
}

export interface IAdeMissionWatchdogServiceOptions {
	readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	readonly localProbe?: IAdeLocalWatchdogProbe;
	readonly pollIntervalMs?: number;
	readonly now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const GPU_IDLE_COOLDOWN_MS = 60_000;

function runExecFile(file: string, args: readonly string[], timeoutMs = 8_000): Promise<{ code: number; stdout: string }> {
	return new Promise(resolve => {
		execFile(file, [...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
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
	fileExisted?: boolean;
	lastFileMtime?: number;
	lastGitHead?: string;
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
	private readonly blockedWakeupNotified = new Set<string>();
	private readonly triggerMemory = new Map<string, ITriggerMonitorMemory>();

	private readonly localProbe: IAdeLocalWatchdogProbe;
	private readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	private readonly pollIntervalMs: number;
	private readonly nowFn: () => number;

	private timer: ReturnType<typeof setInterval> | undefined;
	private ticking = false;

	constructor(options?: IAdeMissionWatchdogServiceOptions) {
		super();
		this.localProbe = options?.localProbe ?? createDefaultLocalProbe();
		this.remoteProbe = options?.remoteProbe;
		this.pollIntervalMs = Math.max(1_000, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		this.nowFn = options?.now ?? (() => Date.now());
	}

	syncMission(snapshot: IAdeMissionWatchdogSnapshot): void {
		this.snapshots.set(snapshot.missionId, snapshot);

		// Clean stale per-token trackers for this mission.
		const liveTokenKeys = new Set<string>();
		for (const token of snapshot.tokens) {
			const key = `${snapshot.missionId}:${token.tokenId}`;
			liveTokenKeys.add(key);
			if (token.status !== 'blocked') {
				this.blockedWakeupNotified.delete(key);
			}
			if (token.status !== 'active') {
				this.lastSilenceWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.lastSilenceWakeupAt.keys())) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTokenKeys.has(key)) {
				this.lastSilenceWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.blockedWakeupNotified)) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTokenKeys.has(key)) {
				this.blockedWakeupNotified.delete(key);
			}
		}

		// Clean stale trigger trackers for this mission.
		const liveTriggerKeys = new Set(snapshot.triggers.map(t => `${snapshot.missionId}:${t.id}`));
		for (const key of Array.from(this.triggerMemory.keys())) {
			if (key.startsWith(`${snapshot.missionId}:`) && !liveTriggerKeys.has(key)) {
				this.triggerMemory.delete(key);
			}
		}

		this.reconcileTimer();
	}

	removeMission(missionId: string): void {
		this.snapshots.delete(missionId);
		const prefix = `${missionId}:`;
		for (const key of Array.from(this.lastSilenceWakeupAt.keys())) {
			if (key.startsWith(prefix)) {
				this.lastSilenceWakeupAt.delete(key);
			}
		}
		for (const key of Array.from(this.blockedWakeupNotified)) {
			if (key.startsWith(prefix)) {
				this.blockedWakeupNotified.delete(key);
			}
		}
		for (const key of Array.from(this.triggerMemory.keys())) {
			if (key.startsWith(prefix)) {
				this.triggerMemory.delete(key);
			}
		}
		this.reconcileTimer();
	}

	getTrackedMissionIds(): readonly string[] {
		return Array.from(this.snapshots.keys());
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
	 * Executes one full supervision tick across all `running` Missions.
	 * Public for deterministic unit testing.
	 */
	async runTick(): Promise<void> {
		if (this.ticking) {
			return;
		}
		this.ticking = true;
		try {
			const now = this.nowFn();
			const runningSnapshots = Array.from(this.snapshots.values()).filter(s => s.status === 'running');
			for (const snapshot of runningSnapshots) {
				await this.checkSnapshotTokens(snapshot, now);
				await this.checkSnapshotTriggers(snapshot, now);
			}
		} finally {
			this.ticking = false;
		}
	}

	private async checkSnapshotTokens(snapshot: IAdeMissionWatchdogSnapshot, now: number): Promise<void> {
		const silenceMs = Math.max(1, snapshot.silenceTimeoutMinutes || 5) * 60_000;
		for (const token of snapshot.tokens) {
			if (token.status === 'active') {
				this.checkActiveSilenceTimeout(snapshot.missionId, token, silenceMs, now);
			} else if (token.status === 'blocked' && token.blocked) {
				await this.checkBlockedWakeup(snapshot.missionId, token, now);
			}
		}
	}

	private checkActiveSilenceTimeout(missionId: string, token: IAdeWatchdogTokenSpec, silenceMs: number, now: number): void {
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
		});
	}

	private async checkBlockedWakeup(missionId: string, token: IAdeWatchdogTokenSpec, now: number): Promise<void> {
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
			});
			return;
		}

		const isRemote = Boolean(blocked.hostAlias && blocked.hostAlias !== 'local');

		// 2. Early wakeup on PID exit (local or remote SSH)
		if (blocked.watchPid && Number.isInteger(blocked.watchPid) && blocked.watchPid > 0) {
			let alive = true;
			try {
				if (isRemote && this.remoteProbe && blocked.hostAlias) {
					alive = await this.remoteProbe.remoteIsPidAlive(blocked.hostAlias, blocked.watchPid);
				} else if (!isRemote) {
					alive = await this.localProbe.isPidAlive(blocked.watchPid);
				}
			} catch {
				// Transient probe failure should NOT falsely wake the employee.
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
				});
				return;
			}
		}

		// 3. Early wakeup on file arrival (local or remote SSH)
		if (blocked.watchFile && blocked.watchFile.trim()) {
			let mtime: number | undefined;
			try {
				if (isRemote && this.remoteProbe && blocked.hostAlias) {
					mtime = await this.remoteProbe.remoteFileStatMtime(blocked.hostAlias, blocked.watchFile);
				} else if (!isRemote) {
					mtime = await this.localProbe.fileStatMtime(blocked.watchFile);
				}
			} catch {
				mtime = undefined;
			}
			if (mtime !== undefined && mtime >= blocked.startedAt) {
				this.blockedWakeupNotified.add(key);
				this._onDidWatchdogWakeup.fire({
					missionId,
					tokenId: token.tokenId,
					nodeId: token.nodeId,
					holderAgentId: token.holderAgentId,
					reason: 'file_ready',
					detail: `Watched file ready: ${blocked.watchFile} on ${blocked.hostAlias || 'local'}`,
					timestamp: now,
				});
			}
		}
	}

	private async checkSnapshotTriggers(snapshot: IAdeMissionWatchdogSnapshot, now: number): Promise<void> {
		const busySourceNodes = new Set(
			snapshot.tokens
				.filter(t => t.status === 'active' || t.status === 'blocked')
				.map(t => t.nodeId),
		);
		for (const trigger of snapshot.triggers) {
			if (!trigger.enabled) {
				continue;
			}
			// Never fire a new wave onto a source node that still holds a live in-flight token.
			if (busySourceNodes.has(trigger.nodeId)) {
				continue;
			}
			await this.evaluateTrigger(snapshot.missionId, trigger, now);
		}
	}

	private async evaluateTrigger(missionId: string, trigger: IMissionSourceTrigger, now: number): Promise<void> {
		const key = `${missionId}:${trigger.id}`;
		let mem = this.triggerMemory.get(key);
		if (!mem) {
			mem = {};
			this.triggerMemory.set(key, mem);
		}
		const lastFiredAt = Math.max(trigger.lastFiredAt ?? 0, mem.lastFiredAt ?? 0);

		if (trigger.kind === 'once') {
			if (trigger.fireCount > 0 || mem.firedOnce) {
				return;
			}
			if (typeof trigger.fireAt === 'number' && now >= trigger.fireAt) {
				mem.firedOnce = true;
				mem.lastFiredAt = now;
				this.emitTriggerFire(missionId, trigger, now, `One-shot schedule reached (${new Date(trigger.fireAt).toISOString()})`);
			}
			return;
		}

		if (trigger.kind === 'interval') {
			if (typeof trigger.intervalMs !== 'number' || !Number.isFinite(trigger.intervalMs) || trigger.intervalMs < 5_000) {
				return;
			}
			const intervalMs = trigger.intervalMs;
			if (lastFiredAt === 0) {
				// Baseline interval clock at first observation so trigger fires after 1 full interval, not immediately at tick 0.
				mem.lastFiredAt = now;
				return;
			}
			if (now - lastFiredAt >= intervalMs) {
				mem.lastFiredAt = now;
				this.emitTriggerFire(missionId, trigger, now, `Interval trigger (${intervalMs}ms)`);
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
				this.emitTriggerFire(missionId, trigger, now, `Cron matched (${trigger.cronExpr})`);
			}
			return;
		}

		if (trigger.kind === 'event' && trigger.eventType) {
			await this.evaluateEventTrigger(missionId, trigger, mem, lastFiredAt, now);
		}
	}

	private async evaluateEventTrigger(
		missionId: string,
		trigger: IMissionSourceTrigger,
		mem: ITriggerMonitorMemory,
		lastFiredAt: number,
		now: number,
	): Promise<void> {
		const hostAlias = trigger.hostAlias && trigger.hostAlias !== 'local' ? trigger.hostAlias : undefined;

		if (trigger.eventType === 'file_created' || trigger.eventType === 'file_changed') {
			if (!trigger.targetPath) {
				return;
			}
			let mtime: number | undefined;
			try {
				mtime = hostAlias && this.remoteProbe
					? await this.remoteProbe.remoteFileStatMtime(hostAlias, trigger.targetPath)
					: !hostAlias
						? await this.localProbe.fileStatMtime(trigger.targetPath)
						: undefined;
			} catch {
				return;
			}

			if (trigger.eventType === 'file_created') {
				const existsNow = mtime !== undefined;
				const existedBefore = mem.fileExisted;
				mem.fileExisted = existsNow;
				if (existedBefore === undefined) {
					// Initial baseline observation: never fire on pre-existing files; only fire on a false -> true creation transition.
					if (existsNow) {
						mem.lastFileMtime = mtime;
					}
					return;
				}
				if (!existedBefore && existsNow) {
					mem.lastFileMtime = mtime;
					mem.lastFiredAt = now;
					this.emitTriggerFire(missionId, trigger, now, `File created: ${trigger.targetPath}`);
				}
				return;
			}

			// file_changed
			if (mtime === undefined) {
				return;
			}
			if (mem.lastFileMtime === undefined) {
				mem.lastFileMtime = mtime;
				return;
			}
			if (mtime !== mem.lastFileMtime) {
				mem.lastFileMtime = mtime;
				mem.lastFiredAt = now;
				this.emitTriggerFire(missionId, trigger, now, `File changed: ${trigger.targetPath}`);
			}
			return;
		}

		if (trigger.eventType === 'git_updated') {
			if (!trigger.targetPath) {
				return;
			}
			let sha: string | undefined;
			try {
				sha = hostAlias && this.remoteProbe
					? await this.remoteProbe.remoteGitHeadCommit(hostAlias, trigger.targetPath)
					: !hostAlias
						? await this.localProbe.gitHeadCommit(trigger.targetPath)
						: undefined;
			} catch {
				return;
			}
			if (!sha) {
				return;
			}
			if (mem.lastGitHead === undefined) {
				mem.lastGitHead = sha;
				return;
			}
			if (sha !== mem.lastGitHead) {
				const prev = mem.lastGitHead;
				mem.lastGitHead = sha;
				mem.lastFiredAt = now;
				this.emitTriggerFire(missionId, trigger, now, `Git HEAD changed ${prev.slice(0, 7)} -> ${sha.slice(0, 7)}`);
			}
			return;
		}

		if (trigger.eventType === 'gpu_idle') {
			if (lastFiredAt > 0 && now - lastFiredAt < GPU_IDLE_COOLDOWN_MS) {
				return;
			}
			let utilPct: number | undefined;
			try {
				utilPct = hostAlias && this.remoteProbe
					? await this.remoteProbe.remoteGpuUtilizationPct(hostAlias)
					: !hostAlias
						? await this.localProbe.gpuUtilizationPct()
						: undefined;
			} catch {
				return;
			}
			const threshold = Math.max(0, Math.min(100, trigger.gpuUtilThresholdPct ?? 10));
			if (utilPct !== undefined && utilPct <= threshold) {
				mem.lastFiredAt = now;
				this.emitTriggerFire(missionId, trigger, now, `GPU idle on ${hostAlias || 'local'} (${utilPct}% <= ${threshold}%)`);
			}
		}
	}

	private emitTriggerFire(missionId: string, trigger: IMissionSourceTrigger, timestamp: number, detail: string): void {
		this._onDidSourceTriggerFire.fire({
			missionId,
			triggerId: trigger.id,
			nodeId: trigger.nodeId,
			kind: trigger.kind,
			detail,
			timestamp,
		});
	}

	override dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		super.dispose();
	}
}
