/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { ADE_API_LATEST_REVISION } from '../common/adeApiRegistry.js';
import type { IAdeCloudHostBackendService } from '../common/adeCloudHosts.js';
import {
	isExplicitMissionMemberOrSupervisor,
	resolveMergedNodeCheckHooks,
	stripForeignWhiteboardBodiesFromOrchestrationText,
} from '../common/adeControlPolicy.js';
import { buildAdeDocsBundle, buildAdeDocsPaths, IAdeDocsPaths, normalizeAdeDocTargetKey } from '../common/adeDocsCatalog.js';
import {
	ADE_INBOX_FILE_NAME,
	buildAdeRemotePersistentPrefix,
	encodeAdeMissionStorageFileName,
	IAdeApiDocReadResult,
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
	IAdeEngineeringBackendService,
	IAdeHeadlessControlResult,
	IAdeInboxItem,
	IAdeInboxMutation,
	IAdeMissionCheckpointMeta,
	IAdeMissionColdChangeEvent,
	IAdeMissionWatchdogSnapshot,
	IAdeOrchestrationDaemonMissionSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogBarrierSpec,
	IAdeWatchdogWakeupEvent,
} from '../common/adeEngineering.js';
import { IMissionNodeCheckHook, parseMissionMermaidDag } from '../common/adeMissionDag.js';
import { IMissionSourceTrigger } from '../common/adeMissionEngine.js';
import {
	canCallerAccessWhiteboard,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationWhiteboard,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
	recordOrchestrationSilenceReminder,
	syncMissionTaskStatusesFromOrchestration,
	wakeBlockedOrchestrationToken,
} from '../common/adeOrchestrationEngine.js';
import { expireOrchestrationJoinBarrier } from '../common/adeOrchestrationLifecycle.js';
import { IOrchestrationGraphParseResult, parseOrchestrationGraph } from '../common/adeOrchestrationGraph.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../common/adeRoleSchema.js';
import { executeAdeDeterministicCheck } from './adeDeterministicCheckRunner.js';
import { syncAdeApiDocsToDisk } from './adeDocsSync.js';
import { executeHeadlessMissionMutationAction } from './adeHeadlessControlMutationActions.js';
import {
	canHeadlessCallerOperateMission,
	checkHeadlessMissionRbac,
	HEADLESS_MUTATING_MISSION_ACTIONS,
	HEADLESS_SUPPORTED_ACTIONS,
	IAdeHeadlessBackendHost,
	IAdeParsedMissionIndexEntry,
	IHeadlessMissionScopeContext,
	resolveHeadlessCaller,
	resolveHeadlessMissionId,
	tryExecuteHeadlessGlobalAction,
	tryExecuteHeadlessMissionReadAction,
} from './adeHeadlessControlReadActions.js';
import { AdeMissionWatchdogService, IAdeRemoteWatchdogProbe } from './adeMissionWatchdogService.js';

const MAX_CHECKPOINTS_PER_MISSION = 20;
const MAX_REVOKED_SESSION_ENTRIES = 4_096;

export interface IAdeDocsBackendNodeServiceOptions {
	readonly baseDir?: string;
	readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	readonly cloudHostService?: IAdeCloudHostBackendService;
	readonly onRevokeSession?: (sessionId: string, revokedAt: number) => void;
	readonly watchdogPollIntervalMs?: number;
}

/**
 * Node main-process backend for:
 * 1) Single-copy ADE API docs synchronization & lazy read (`<adeHome>/docs/`)
 * 2) ADE Inbox JSON persistence (`<adeHome>/inbox.json`)
 * 3) Local Mission Watchdog Daemon & zero-token Source Trigger Monitor
 * 4) Cold per-Mission storage with O(1) parsed metadata index, checkpoints ring-buffer, and revision CAS
 * 5) 0-window headless Orchestration control continuity
 */
export class AdeDocsBackendNodeService extends Disposable implements IAdeEngineeringBackendService, IAdeHeadlessBackendHost {
	declare readonly _serviceBrand: undefined;

	readonly baseDir: string;
	readonly cloudHostService?: IAdeCloudHostBackendService;
	private readonly watchdog: AdeMissionWatchdogService;
	private readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	private readonly onRevokeSession?: (sessionId: string, revokedAt: number) => void;
	private cachedOrgConfig: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG;
	private orgConfigCacheLoaded = false;
	private orgConfigWriteChain: Promise<void> = Promise.resolve();
	private inboxWriteChain: Promise<void> = Promise.resolve();
	private daemonWriteChain: Promise<void> = Promise.resolve();
	private daemonStateCache: Record<string, IAdeOrchestrationDaemonMissionSnapshot> | undefined;
	private daemonStateDirty = false;
	private readonly missionWriteChains = new Map<string, Promise<void>>();
	private readonly checkpointWriteChains = new Map<string, Promise<void>>();
	private readonly missionFileCache = new Map<string, { readonly mtimeMs: number; readonly size: number; readonly id: string; readonly raw: string }>();
	private readonly parsedMissionIndex = new Map<string, IAdeParsedMissionIndexEntry>();
	private readonly headlessOrchestrationMissionIds = new Set<string>();
	private readonly revokedSessionCutoffs = new Map<string, number>();
	private readonly liveRendererContexts = new Set<string>();
	private headlessWatchdogQueue: Promise<void> = Promise.resolve();
	private activeRendererWindowCount = 0;
	private inboxTmpSeq = 0;

	private readonly _onDidInboxChange = this._register(new Emitter<readonly IAdeInboxItem[]>());
	readonly onDidInboxChange: Event<readonly IAdeInboxItem[]> = this._onDidInboxChange.event;

	private readonly _onDidMissionRecordChange = this._register(new Emitter<IAdeMissionColdChangeEvent>());
	readonly onDidMissionRecordChange: Event<IAdeMissionColdChangeEvent> = this._onDidMissionRecordChange.event;

	private readonly _onDidSystemResume = this._register(new Emitter<number>());
	readonly onDidSystemResume: Event<number> = this._onDidSystemResume.event;

	readonly onDidWatchdogWakeup: Event<IAdeWatchdogWakeupEvent>;
	readonly onDidSourceTriggerFire: Event<IAdeSourceTriggerFireEvent>;

	constructor(options?: IAdeDocsBackendNodeServiceOptions) {
		super();
		const envHome = process.env.AEXUS_ADE_HOME?.trim();
		this.baseDir = options?.baseDir || envHome || path.join(os.homedir(), '.aexus-code');
		this.remoteProbe = options?.remoteProbe;
		this.cloudHostService = options?.cloudHostService;
		this.onRevokeSession = options?.onRevokeSession;
		this.watchdog = this._register(new AdeMissionWatchdogService({
			remoteProbe: options?.remoteProbe,
			pollIntervalMs: options?.watchdogPollIntervalMs,
			triggerStatePath: path.join(this.baseDir, 'watchdog-triggers.json'),
			snapshotStatePath: path.join(this.baseDir, 'watchdog-snapshots.json'),
		}));
		this.onDidWatchdogWakeup = this.watchdog.onDidWatchdogWakeup;
		this.onDidSourceTriggerFire = this.watchdog.onDidSourceTriggerFire;
		this._register(this.watchdog.onDidWatchdogWakeup(ev => {
			if (this.activeRendererWindowCount === 0 && !this._store.isDisposed) {
				const op = () => this.processHeadlessWatchdogWakeup(ev).then(() => undefined, () => undefined);
				this.headlessWatchdogQueue = this.headlessWatchdogQueue.then(op, op);
			}
		}));
	}

	nextTmpSeq(): number {
		return ++this.inboxTmpSeq;
	}

	setActiveRendererWindowCount(count: number): void {
		this.activeRendererWindowCount = Math.max(0, Math.floor(count));
		if (this.activeRendererWindowCount === 0) {
			this.liveRendererContexts.clear();
		}
	}

	registerLiveRendererContext(ctx: string): void {
		const trimmed = ctx.trim();
		if (trimmed) {
			this.liveRendererContexts.add(trimmed);
		}
	}

	unregisterLiveRendererContext(ctx: string): void {
		this.liveRendererContexts.delete(ctx.trim());
	}

	willHandleWatchdogWakeupHeadlessly(ev: IAdeWatchdogWakeupEvent): boolean {
		return this.activeRendererWindowCount === 0 && this.headlessOrchestrationMissionIds.has(ev.missionId);
	}

	getCachedOrgConfig(): IAdeOrganizationConfig {
		return this.cachedOrgConfig;
	}

	isSessionRevoked(sessionId: string, tokenIat?: number): boolean {
		const cutoff = this.revokedSessionCutoffs.get(sessionId.trim());
		return cutoff !== undefined && (tokenIat === undefined || tokenIat <= cutoff);
	}

	async revokeSession(sessionId: string, revokedAt?: number, options?: { readonly skipNotify?: boolean }): Promise<void> {
		const sid = sessionId.trim();
		if (!sid) {
			return;
		}
		const prev = this.revokedSessionCutoffs.get(sid) ?? -1;
		const now = Date.now();
		const cutoff = revokedAt !== undefined ? Math.max(prev, revokedAt) : Math.max(prev, now);
		this.revokedSessionCutoffs.set(sid, cutoff);
		if (this.revokedSessionCutoffs.size > MAX_REVOKED_SESSION_ENTRIES) {
			const expiry = now - 24 * 60 * 60 * 1000;
			for (const [k, ts] of this.revokedSessionCutoffs) {
				if (ts < expiry) {
					this.revokedSessionCutoffs.delete(k);
				}
			}
		}
		if (!options?.skipNotify) {
			this.onRevokeSession?.(sid, cutoff);
		}
	}

	private get inboxPath(): string {
		return path.join(this.baseDir, ADE_INBOX_FILE_NAME);
	}

	async loadInbox(): Promise<IAdeInboxItem[]> {
		try {
			const raw = await fs.promises.readFile(this.inboxPath, 'utf8');
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed as IAdeInboxItem[] : [];
		} catch {
			return [];
		}
	}

	private async writeInboxFileAtomic(snapshot: readonly IAdeInboxItem[]): Promise<void> {
		await fs.promises.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
		const uniqueSuffix = `${process.pid}.${Date.now()}.${++this.inboxTmpSeq}.${crypto.randomBytes(6).toString('hex')}`;
		const tmp = `${this.inboxPath}.tmp.${uniqueSuffix}`;
		try {
			await fs.promises.writeFile(tmp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
			await fs.promises.rename(tmp, this.inboxPath);
		} catch (err) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
		this._onDidInboxChange.fire(snapshot);
	}

	async saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		const snapshot = [...items];
		const writeOp = () => this.writeInboxFileAtomic(snapshot);
		const queued = this.inboxWriteChain.then(writeOp, writeOp);
		this.inboxWriteChain = queued.catch(() => undefined);
		return queued;
	}

	async mutateInbox(mutation: IAdeInboxMutation): Promise<IAdeInboxItem[]> {
		const mutateOp = async (): Promise<IAdeInboxItem[]> => {
			const current = await this.loadInbox();
			let next: IAdeInboxItem[];
			switch (mutation.kind) {
				case 'upsert': {
					const filtered = current.filter(i => i.id !== mutation.item.id);
					next = [mutation.item, ...filtered].sort((a, b) => b.createdAt - a.createdAt);
					break;
				}
				case 'markRead': {
					next = current.map(item => ((!mutation.id || item.id === mutation.id) && item.unread)
						? { ...item, unread: false }
						: item);
					break;
				}
				case 'resolve': {
					next = current.map(item => item.id === mutation.id
						? { ...item, unread: false, resolved: true, resolution: mutation.resolution, resolvedAt: mutation.resolvedAt }
						: item);
					break;
				}
				case 'removeGovernor': {
					next = current.filter(item => item.governorSessionId !== mutation.governorSessionId);
					break;
				}
			}
			await this.writeInboxFileAtomic(next);
			return next;
		};
		const queued = this.inboxWriteChain.then(mutateOp, mutateOp);
		this.inboxWriteChain = queued.then(() => undefined, () => undefined);
		return queued;
	}

	private get missionsDir(): string {
		return path.join(this.baseDir, 'missions');
	}

	private missionFilePath(missionId: string): string {
		return path.join(this.missionsDir, encodeAdeMissionStorageFileName(missionId));
	}

	private missionBlobsDir(missionId: string): string {
		return this.missionFilePath(missionId).replace(/\.json$/i, '.blobs');
	}

	private missionCheckpointsDir(missionId: string): string {
		return this.missionFilePath(missionId).replace(/\.json$/i, '.checkpoints');
	}

	private missionArchivePath(missionId: string): string {
		return this.missionFilePath(missionId).replace(/\.json$/i, '.archive.jsonl');
	}

	private get orchestrationDaemonPath(): string {
		return path.join(this.baseDir, 'orchestration-daemon.json');
	}

	private sanitizeSafeIdFileName(raw: string): string | undefined {
		const trimmed = raw.trim();
		if (!trimmed || !/^[A-Za-z0-9_.-]{1,96}$/.test(trimmed) || trimmed.includes('..')) {
			return undefined;
		}
		return `${trimmed}.json`;
	}

	private updateParsedIndexFromRaw(missionId: string, raw: string, mtimeMs: number, size: number): void {
		try {
			const rec = JSON.parse(raw) as Record<string, unknown>;
			if (!rec || typeof rec !== 'object') {
				return;
			}
			const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : missionId;
			const orch = rec.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
			const tokens = Object.values(orch?.tokens ?? {});
			const legacyBoundary = (rec.runtime as {
				readonly boundary?: {
					readonly supervisors?: ReadonlyArray<{ readonly id: string }>;
					readonly nodeAssignments?: Readonly<Record<string, { readonly agentId?: string }>>;
				};
			} | undefined)?.boundary;
			const supervisorIds = legacyBoundary?.supervisors?.map(s => s.id).filter(Boolean) ?? [];
			const nodeAssignmentAgentIds = Object.values(legacyBoundary?.nodeAssignments ?? {})
				.map(a => a?.agentId)
				.filter((aid): aid is string => Boolean(aid));
			this.parsedMissionIndex.set(id, {
				id,
				title: typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : id,
				...(typeof rec.ownerSessionId === 'string' && rec.ownerSessionId.trim() ? { ownerSessionId: rec.ownerSessionId.trim() } : {}),
				...(typeof rec.ownerTier === 'number' && Number.isFinite(rec.ownerTier) ? { ownerTier: Math.floor(rec.ownerTier) } : {}),
				...(typeof rec.projectUri === 'string' && rec.projectUri.trim() ? { projectUri: rec.projectUri.trim() } : {}),
				updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
				...(orch?.status ? { orchStatus: orch.status } : {}),
				activeTokenCount: tokens.filter(t => t.status === 'active').length,
				nodeAgentIds: orch?.nodeAgentIds ?? {},
				tokenIds: new Set(Object.keys(orch?.tokens ?? {})),
				tracePtrs: new Set(Object.keys(orch?.traces ?? {})),
				supervisorIds,
				nodeAssignmentAgentIds,
				mtimeMs,
				size,
			});
		} catch {
			// Skip malformed record
		}
	}

	withMissionLock<T>(missionId: string, op: () => Promise<T>): Promise<T> {
		const key = missionId.trim();
		const prev = this.missionWriteChains.get(key) ?? Promise.resolve();
		const next = prev.then(op, op);
		const settled = next.then(() => undefined, () => undefined);
		this.missionWriteChains.set(key, settled);
		void settled.finally(() => {
			if (this.missionWriteChains.get(key) === settled) {
				this.missionWriteChains.delete(key);
			}
		});
		return next;
	}

	async saveMissionRecordUnlocked(
		missionId: string,
		payloadJson: string,
		updatedAt: number,
		writerId?: string,
		expectedRevision?: number,
	): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed || this._store.isDisposed) {
			return;
		}
		if (expectedRevision !== undefined && Number.isFinite(expectedRevision)) {
			const existingRaw = await this.loadMissionRecord(trimmed);
			if (existingRaw) {
				try {
					const existingParsed = JSON.parse(existingRaw) as { orchestrationRuntime?: { stateRevision?: number } };
					const onDiskRev = existingParsed?.orchestrationRuntime?.stateRevision;
					if (typeof onDiskRev === 'number' && Number.isFinite(onDiskRev) && onDiskRev > expectedRevision) {
						throw new Error(`REVISION_CONFLICT: Mission "${trimmed}" on disk is at stateRevision ${onDiskRev}, expected <= ${expectedRevision}.`);
					}
				} catch (err) {
					if (err instanceof Error && err.message.startsWith('REVISION_CONFLICT:')) {
						throw err;
					}
				}
			}
		}
		await fs.promises.mkdir(this.missionsDir, { recursive: true, mode: 0o700 });
		if (this._store.isDisposed) {
			return;
		}
		const target = this.missionFilePath(trimmed);
		const uniqueSuffix = `${process.pid}.${Date.now()}.${++this.inboxTmpSeq}.${crypto.randomBytes(6).toString('hex')}`;
		const tmp = `${target}.tmp.${uniqueSuffix}`;
		try {
			await fs.promises.writeFile(tmp, payloadJson, { encoding: 'utf8', mode: 0o600 });
			if (this._store.isDisposed) {
				await fs.promises.unlink(tmp).catch(() => undefined);
				return;
			}
			await fs.promises.rename(tmp, target);
			try {
				const st = await fs.promises.stat(target);
				this.missionFileCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, id: trimmed, raw: payloadJson });
				this.updateParsedIndexFromRaw(trimmed, payloadJson, st.mtimeMs, st.size);
			} catch {
				this.missionFileCache.delete(target);
				this.parsedMissionIndex.delete(trimmed);
			}
		} catch (err) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
		this._onDidMissionRecordChange.fire({
			missionId: trimmed,
			updatedAt,
			...(writerId ? { writerId } : {}),
		});
	}

	async loadMissionRecord(missionId: string): Promise<string | undefined> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return undefined;
		}
		const targetPath = this.missionFilePath(trimmed);
		try {
			const st = await fs.promises.stat(targetPath);
			const cached = this.missionFileCache.get(targetPath);
			if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
				if (!this.parsedMissionIndex.has(trimmed)) {
					this.updateParsedIndexFromRaw(trimmed, cached.raw, st.mtimeMs, st.size);
				}
				return cached.raw;
			}
			const raw = await fs.promises.readFile(targetPath, 'utf8');
			this.missionFileCache.set(targetPath, { mtimeMs: st.mtimeMs, size: st.size, id: trimmed, raw });
			this.updateParsedIndexFromRaw(trimmed, raw, st.mtimeMs, st.size);
			return raw;
		} catch {
			this.missionFileCache.delete(targetPath);
			this.parsedMissionIndex.delete(trimmed);
			return undefined;
		}
	}

	async getParsedMissionIndex(): Promise<ReadonlyMap<string, IAdeParsedMissionIndexEntry>> {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.missionsDir);
		} catch {
			this.parsedMissionIndex.clear();
			return this.parsedMissionIndex;
		}
		const seenIds = new Set<string>();
		const seenPaths = new Set<string>();
		await Promise.all(entries.map(async name => {
			if (!name.endsWith('.json') || name.includes('.tmp.')) {
				return;
			}
			const fullPath = path.join(this.missionsDir, name);
			seenPaths.add(fullPath);
			try {
				const st = await fs.promises.stat(fullPath);
				const cached = this.missionFileCache.get(fullPath);
				if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
					seenIds.add(cached.id);
					const existingIdx = this.parsedMissionIndex.get(cached.id);
					if (!existingIdx || existingIdx.mtimeMs !== st.mtimeMs || existingIdx.size !== st.size) {
						this.updateParsedIndexFromRaw(cached.id, cached.raw, st.mtimeMs, st.size);
					}
					return;
				}
				const raw = await fs.promises.readFile(fullPath, 'utf8');
				const parsed = JSON.parse(raw) as { id?: unknown };
				if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && parsed.id.trim()) {
					const id = parsed.id.trim();
					seenIds.add(id);
					this.missionFileCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, id, raw });
					this.updateParsedIndexFromRaw(id, raw, st.mtimeMs, st.size);
				}
			} catch {
				// Skip corrupt file
			}
		}));
		for (const cachedPath of this.missionFileCache.keys()) {
			if (!seenPaths.has(cachedPath)) {
				this.missionFileCache.delete(cachedPath);
			}
		}
		for (const indexedId of this.parsedMissionIndex.keys()) {
			if (!seenIds.has(indexedId)) {
				this.parsedMissionIndex.delete(indexedId);
			}
		}
		return this.parsedMissionIndex;
	}

	async loadAllMissionRecords(): Promise<Readonly<Record<string, string>>> {
		const out: Record<string, string> = {};
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.missionsDir);
		} catch {
			return out;
		}
		const seenPaths = new Set<string>();
		const seenIds = new Set<string>();
		await Promise.all(entries.map(async name => {
			if (!name.endsWith('.json') || name.includes('.tmp.')) {
				return;
			}
			const fullPath = path.join(this.missionsDir, name);
			seenPaths.add(fullPath);
			try {
				const st = await fs.promises.stat(fullPath);
				const cached = this.missionFileCache.get(fullPath);
				if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
					out[cached.id] = cached.raw;
					seenIds.add(cached.id);
					return;
				}
				const raw = await fs.promises.readFile(fullPath, 'utf8');
				const parsed = JSON.parse(raw) as { id?: unknown };
				if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && parsed.id.trim()) {
					const id = parsed.id.trim();
					seenIds.add(id);
					this.missionFileCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, id, raw });
					this.updateParsedIndexFromRaw(id, raw, st.mtimeMs, st.size);
					out[id] = raw;
				}
			} catch {
				// Skip corrupt or half-written file cleanly
			}
		}));
		for (const cachedPath of this.missionFileCache.keys()) {
			if (!seenPaths.has(cachedPath)) {
				this.missionFileCache.delete(cachedPath);
			}
		}
		for (const indexedId of this.parsedMissionIndex.keys()) {
			if (!seenIds.has(indexedId)) {
				this.parsedMissionIndex.delete(indexedId);
			}
		}
		return out;
	}

	async saveMissionRecord(missionId: string, payloadJson: string, updatedAt: number, writerId?: string, expectedRevision?: number): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return;
		}
		return this.withMissionLock(trimmed, () => this.saveMissionRecordUnlocked(trimmed, payloadJson, updatedAt, writerId, expectedRevision));
	}

	async deleteMissionRecord(missionId: string, writerId?: string): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return;
		}
		return this.withMissionLock(trimmed, async () => {
			this.headlessOrchestrationMissionIds.delete(trimmed);
			this.missionFileCache.delete(this.missionFilePath(trimmed));
			this.parsedMissionIndex.delete(trimmed);
			await fs.promises.unlink(this.missionFilePath(trimmed)).catch(() => undefined);
			await fs.promises.rm(this.missionBlobsDir(trimmed), { recursive: true, force: true }).catch(() => undefined);
			await fs.promises.rm(this.missionCheckpointsDir(trimmed), { recursive: true, force: true }).catch(() => undefined);
			await fs.promises.unlink(this.missionArchivePath(trimmed)).catch(() => undefined);
			await this.removeOrchestrationDaemonEntry(trimmed).catch(() => undefined);
			this._onDidMissionRecordChange.fire({
				missionId: trimmed,
				updatedAt: Date.now(),
				deleted: true,
				...(writerId ? { writerId } : {}),
			});
		});
	}

	private withCheckpointLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
		const key = missionId.trim();
		const prev = this.checkpointWriteChains.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.then(() => undefined, () => undefined);
		this.checkpointWriteChains.set(key, tail);
		void tail.finally(() => {
			if (this.checkpointWriteChains.get(key) === tail) {
				this.checkpointWriteChains.delete(key);
			}
		});
		return next;
	}

	async saveMissionCheckpoint(
		missionId: string,
		checkpointId: string,
		payloadJson: string,
		meta: IAdeMissionCheckpointMeta,
	): Promise<void> {
		const trimmed = missionId.trim();
		const fileName = this.sanitizeSafeIdFileName(checkpointId);
		if (!trimmed || !fileName || this._store.isDisposed) {
			return;
		}
		return this.withCheckpointLock(trimmed, async () => {
			if (this._store.isDisposed) {
				return;
			}
			const dir = this.missionCheckpointsDir(trimmed);
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			const target = path.join(dir, fileName);
			const tmp = `${target}.tmp.${process.pid}.${++this.inboxTmpSeq}.${crypto.randomBytes(4).toString('hex')}`;
			try {
				await fs.promises.writeFile(tmp, payloadJson, { encoding: 'utf8', mode: 0o600 });
				await fs.promises.rename(tmp, target);
			} catch (err) {
				await fs.promises.unlink(tmp).catch(() => undefined);
				throw err;
			}
			// Maintain bounded ring-buffer index (max 20 checkpoints per mission) under dedicated lock
			const indexPath = path.join(dir, 'index.json');
			const existing = await this.listMissionCheckpoints(trimmed);
			const merged = [meta, ...existing.filter(m => m.id !== meta.id)]
				.sort((a, b) => b.createdAt - a.createdAt || b.stateRevision - a.stateRevision);
			const kept = merged.slice(0, MAX_CHECKPOINTS_PER_MISSION);
			const evicted = merged.slice(MAX_CHECKPOINTS_PER_MISSION);
			const idxTmp = `${indexPath}.tmp.${process.pid}.${++this.inboxTmpSeq}.${crypto.randomBytes(4).toString('hex')}`;
			try {
				await fs.promises.writeFile(idxTmp, JSON.stringify(kept, null, 2), { encoding: 'utf8', mode: 0o600 });
				await fs.promises.rename(idxTmp, indexPath);
			} catch {
				await fs.promises.unlink(idxTmp).catch(() => undefined);
			}
			for (const old of evicted) {
				const oldFile = this.sanitizeSafeIdFileName(old.id);
				if (oldFile) {
					await fs.promises.unlink(path.join(dir, oldFile)).catch(() => undefined);
				}
			}
		});
	}

	async listMissionCheckpoints(missionId: string): Promise<readonly IAdeMissionCheckpointMeta[]> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return [];
		}
		const indexPath = path.join(this.missionCheckpointsDir(trimmed), 'index.json');
		try {
			const raw = await fs.promises.readFile(indexPath, 'utf8');
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed as IAdeMissionCheckpointMeta[] : [];
		} catch {
			return [];
		}
	}

	async loadMissionCheckpoint(missionId: string, checkpointId: string): Promise<string | undefined> {
		const trimmed = missionId.trim();
		const fileName = this.sanitizeSafeIdFileName(checkpointId);
		if (!trimmed || !fileName) {
			return undefined;
		}
		try {
			return await fs.promises.readFile(path.join(this.missionCheckpointsDir(trimmed), fileName), 'utf8');
		} catch {
			return undefined;
		}
	}

	async deleteMissionCheckpoint(missionId: string, checkpointId: string): Promise<void> {
		const trimmed = missionId.trim();
		const fileName = this.sanitizeSafeIdFileName(checkpointId);
		if (!trimmed || !fileName) {
			return;
		}
		return this.withCheckpointLock(trimmed, async () => {
			const dir = this.missionCheckpointsDir(trimmed);
			await fs.promises.unlink(path.join(dir, fileName)).catch(() => undefined);
			const existing = await this.listMissionCheckpoints(trimmed);
			const next = existing.filter(m => m.id !== checkpointId.trim());
			const indexPath = path.join(dir, 'index.json');
			const idxTmp = `${indexPath}.tmp.${process.pid}.${++this.inboxTmpSeq}.${crypto.randomBytes(4).toString('hex')}`;
			try {
				await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
				await fs.promises.writeFile(idxTmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
				await fs.promises.rename(idxTmp, indexPath);
			} catch {
				await fs.promises.unlink(idxTmp).catch(() => undefined);
			}
		});
	}

	async saveOrchestrationBlobs(missionId: string, blobs: readonly { readonly ptr: string; readonly payloadJson: string }[]): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed || blobs.length === 0) {
			return;
		}
		return this.withMissionLock(trimmed, async () => {
			const dir = this.missionBlobsDir(trimmed);
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			const CONCURRENCY = 8;
			let cursor = 0;
			const workers = Array.from({ length: Math.min(CONCURRENCY, blobs.length) }, async () => {
				while (cursor < blobs.length) {
					const item = blobs[cursor++];
					const fileName = this.sanitizeSafeIdFileName(item.ptr);
					if (!fileName) {
						continue;
					}
					const target = path.join(dir, fileName);
					try {
						await fs.promises.access(target, fs.constants.F_OK);
						continue;
					} catch {
						// Not present yet
					}
					const uniqueSuffix = `${process.pid}.${Date.now()}.${++this.inboxTmpSeq}.${crypto.randomBytes(4).toString('hex')}`;
					const tmp = `${target}.tmp.${uniqueSuffix}`;
					try {
						await fs.promises.writeFile(tmp, item.payloadJson, { encoding: 'utf8', mode: 0o600 });
						await fs.promises.rename(tmp, target);
					} catch (err) {
						await fs.promises.unlink(tmp).catch(() => undefined);
						throw err;
					}
				}
			});
			await Promise.all(workers);
		});
	}

	async readOrchestrationBlob(missionId: string, ptr: string): Promise<string | undefined> {
		const trimmed = missionId.trim();
		const fileName = this.sanitizeSafeIdFileName(ptr);
		if (!trimmed || !fileName) {
			return undefined;
		}
		try {
			return await fs.promises.readFile(path.join(this.missionBlobsDir(trimmed), fileName), 'utf8');
		} catch {
			return undefined;
		}
	}

	async appendOrchestrationArchive(missionId: string, lines: readonly string[]): Promise<void> {
		const trimmed = missionId.trim();
		const nonEmpty = lines.map(l => l.trim()).filter(Boolean);
		if (!trimmed || nonEmpty.length === 0) {
			return;
		}
		return this.withMissionLock(trimmed, async () => {
			await fs.promises.mkdir(this.missionsDir, { recursive: true, mode: 0o700 });
			const archivePath = this.missionArchivePath(trimmed);
			await fs.promises.appendFile(archivePath, `${nonEmpty.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
		});
	}

	async readOrchestrationArchive(missionId: string, options?: { readonly limit?: number; readonly offset?: number }): Promise<readonly string[]> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return [];
		}
		try {
			const raw = await fs.promises.readFile(this.missionArchivePath(trimmed), 'utf8');
			const all = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
			const offset = Math.max(0, Math.floor(options?.offset ?? 0));
			const limit = options?.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : all.length;
			return all.slice(offset, offset + limit);
		} catch {
			return [];
		}
	}

	private async loadDaemonStateMap(): Promise<Record<string, IAdeOrchestrationDaemonMissionSnapshot>> {
		try {
			const raw = await fs.promises.readFile(this.orchestrationDaemonPath, 'utf8');
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? parsed as Record<string, IAdeOrchestrationDaemonMissionSnapshot>
				: {};
		} catch {
			return {};
		}
	}

	private async writeDaemonStateMap(map: Readonly<Record<string, IAdeOrchestrationDaemonMissionSnapshot>>): Promise<void> {
		await fs.promises.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
		const uniqueSuffix = `${process.pid}.${Date.now()}.${++this.inboxTmpSeq}.${crypto.randomBytes(4).toString('hex')}`;
		const tmp = `${this.orchestrationDaemonPath}.tmp.${uniqueSuffix}`;
		try {
			await fs.promises.writeFile(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
			await fs.promises.rename(tmp, this.orchestrationDaemonPath);
		} catch (err) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
	}

	private async ensureDaemonStateCache(): Promise<Record<string, IAdeOrchestrationDaemonMissionSnapshot>> {
		if (this.daemonStateCache) {
			return this.daemonStateCache;
		}
		const loaded = await this.loadDaemonStateMap();
		if (!this.daemonStateCache) {
			this.daemonStateCache = loaded;
		}
		return this.daemonStateCache;
	}

	private flushDaemonStateCache(): Promise<void> {
		this.daemonStateDirty = true;
		const writeOp = async () => {
			if (!this.daemonStateDirty || !this.daemonStateCache) {
				return;
			}
			this.daemonStateDirty = false;
			await this.writeDaemonStateMap({ ...this.daemonStateCache });
		};
		const next = this.daemonWriteChain.then(writeOp, writeOp);
		this.daemonWriteChain = next.catch(() => undefined);
		return next;
	}

	private async removeOrchestrationDaemonEntry(missionId: string): Promise<void> {
		const op = async () => {
			const map = await this.ensureDaemonStateCache();
			if (Object.hasOwn(map, missionId)) {
				delete map[missionId];
				this.daemonStateDirty = true;
				await this.writeDaemonStateMap({ ...map });
				this.daemonStateDirty = false;
			}
		};
		const next = this.daemonWriteChain.then(op, op);
		this.daemonWriteChain = next.catch(() => undefined);
		return next;
	}

	async syncOrchestrationDaemonState(snapshot: IAdeOrchestrationDaemonMissionSnapshot): Promise<void> {
		if (!snapshot?.missionId?.trim()) {
			return;
		}
		const missionId = snapshot.missionId.trim();
		if (snapshot.status === 'running' && ((snapshot.activeTokenCount ?? 0) > 0 || (snapshot.blockedTokenCount ?? 0) > 0 || (snapshot.waitingJoinCount ?? 0) > 0)) {
			this.headlessOrchestrationMissionIds.add(missionId);
		} else {
			this.headlessOrchestrationMissionIds.delete(missionId);
		}
		const map = await this.ensureDaemonStateCache();
		map[missionId] = { ...snapshot, missionId };
		await this.flushDaemonStateCache();
	}

	async getOrchestrationDaemonState(missionId?: string): Promise<Readonly<Record<string, IAdeOrchestrationDaemonMissionSnapshot>>> {
		const map = await this.ensureDaemonStateCache();
		if (missionId?.trim()) {
			const entry = map[missionId.trim()];
			return entry ? { [missionId.trim()]: entry } : {};
		}
		return { ...map };
	}

	syncHeadlessWatchdogForRecord(missionId: string, record: Record<string, unknown>): void {
		const orch = record.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
		if (!orch) {
			this.headlessOrchestrationMissionIds.delete(missionId);
			this.watchdog.removeMission(missionId);
			return;
		}
		const orchText = typeof record.orchestrationText === 'string' ? record.orchestrationText : '';
		const parsedGraph = parseOrchestrationGraph(orchText);
		this.syncHeadlessWatchdogForMission(missionId, orch, record, parsedGraph);
	}

	private syncHeadlessWatchdogForMission(
		missionId: string,
		nextOrch: IOrchestrationRuntimeState,
		record?: Record<string, unknown>,
		parsedGraph?: IOrchestrationGraphParseResult,
	): void {
		const liveTokens = Object.values(nextOrch.tokens ?? {}).filter(t => t.status === 'active' || t.status === 'blocked');
		const existingTriggers = Array.isArray(record?.triggers)
			? (record!.triggers as readonly IMissionSourceTrigger[])
			: (Array.isArray((record?.runtime as { readonly triggers?: unknown } | undefined)?.triggers)
				? ((record!.runtime as { readonly triggers: readonly IMissionSourceTrigger[] }).triggers)
				: []);
		const deadlineBarriers: IAdeWatchdogBarrierSpec[] = Object.values(nextOrch.joinBarriers ?? {})
			.filter(b => b.status === 'waiting' && typeof b.deadlineAt === 'number' && Number.isFinite(b.deadlineAt))
			.map(b => ({
				barrierId: b.id,
				parentTokenId: b.parentTokenId,
				ownerNodeId: b.ownerNodeId,
				ownerAgentId: nextOrch.nodeAgentIds?.[b.ownerNodeId],
				deadlineAt: b.deadlineAt!,
			}));
		if (
			nextOrch.status === 'paused'
			|| nextOrch.status === 'aborted'
			|| nextOrch.budgetCircuitTripped
			|| (liveTokens.length === 0 && existingTriggers.length === 0 && deadlineBarriers.length === 0)
		) {
			this.headlessOrchestrationMissionIds.delete(missionId);
			this.watchdog.removeMission(missionId);
			return;
		}
		this.headlessOrchestrationMissionIds.add(missionId);
		this.watchdog.syncMission({
			missionId,
			status: 'running',
			silenceTimeoutMinutes: nextOrch.silenceReminderMinutes || ORCHESTRATION_SILENCE_REMINDER_MINUTES,
			tokens: liveTokens.map(t => {
				const staffNode = parsedGraph?.nodes.find(n => n.id === t.nodeId && n.kind === 'staff');
				const hostAlias = t.blocked?.hostAlias || staffNode?.hostAlias;
				const holderAgentId = nextOrch.nodeAgentIds?.[t.nodeId] ?? t.holderAgentId;
				const remoteSessionPrefix = hostAlias && hostAlias !== 'local' && holderAgentId
					? buildAdeRemotePersistentPrefix(staffNode?.engineId || 'claude', holderAgentId)
					: undefined;
				return {
					tokenId: t.id,
					nodeId: t.nodeId,
					holderAgentId,
					status: t.status === 'blocked' ? 'blocked' : 'active',
					lastActivityAt: t.lastActivityAt,
					lastNudgeAt: t.lastNudgeAt,
					...(hostAlias && hostAlias !== 'local' ? { hostAlias } : {}),
					...(remoteSessionPrefix ? { remoteSessionPrefix } : {}),
					...(t.blocked ? { blocked: t.blocked } : {}),
				};
			}),
			triggers: existingTriggers,
			...(deadlineBarriers.length > 0 ? { barriers: deadlineBarriers } : {}),
		});
	}

	private dedupePendingHeadlessEffects(
		existing: readonly OrchestrationEngineEffect[],
		incoming: readonly OrchestrationEngineEffect[],
	): readonly OrchestrationEngineEffect[] {
		const merged = [...existing, ...incoming];
		const out: OrchestrationEngineEffect[] = [];
		const lastIdxByKey = new Map<string, number>();
		const keyOf = (eff: OrchestrationEngineEffect): string | undefined => {
			if (eff.kind === 'silence_reminder' || eff.kind === 'wakeup_blocked' || eff.kind === 'dispatch_token') {
				return `${eff.kind}:${eff.tokenId}`;
			}
			return undefined;
		};
		for (let i = 0; i < merged.length; i++) {
			const k = keyOf(merged[i]);
			if (k) {
				lastIdxByKey.set(k, i);
			}
		}
		for (let i = 0; i < merged.length; i++) {
			const k = keyOf(merged[i]);
			if (!k || lastIdxByKey.get(k) === i) {
				out.push(merged[i]);
			}
		}
		return out;
	}

	async persistHeadlessOrchStateRecord(
		missionId: string,
		record: Record<string, unknown>,
		parsedGraph: IOrchestrationGraphParseResult,
		nextOrchBase: IOrchestrationRuntimeState,
		emittedEffects: readonly OrchestrationEngineEffect[],
		nowTs: number,
		options?: { readonly alreadyLocked?: boolean },
	): Promise<IOrchestrationRuntimeState> {
		const inboxEffects: Array<Extract<OrchestrationEngineEffect, { readonly kind: 'post_inbox' }>> = [];
		const deferredEffects: OrchestrationEngineEffect[] = [];
		for (const eff of emittedEffects) {
			if (eff.kind === 'post_inbox') {
				inboxEffects.push(eff);
			} else {
				deferredEffects.push(eff);
			}
		}

		if (inboxEffects.length > 0) {
			const projectUriStr = typeof record.projectUri === 'string' ? record.projectUri : '';
			const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : missionId;
			const governorSessionId = typeof record.ownerSessionId === 'string' && record.ownerSessionId.trim()
				? record.ownerSessionId.trim()
				: missionId;
			const batchItems: IAdeInboxItem[] = inboxEffects.map(eff => ({
				id: `headless-inb-${missionId}-${nowTs}-${++this.inboxTmpSeq}`,
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId,
				governorLabel: title,
				projectPath: projectUriStr,
				projectName: title,
				nodeId: eff.nodeId,
				title: eff.title,
				message: eff.message,
				severity: eff.severity,
				senderAgentId: eff.senderAgentId,
				createdAt: nowTs,
				unread: true,
				resolved: false,
			}));
			const upsertBatchOp = async (): Promise<void> => {
				const current = await this.loadInbox();
				const incomingIds = new Set(batchItems.map(i => i.id));
				const next = [...batchItems, ...current.filter(i => !incomingIds.has(i.id))].sort((a, b) => b.createdAt - a.createdAt);
				await this.writeInboxFileAtomic(next);
			};
			const queued = this.inboxWriteChain.then(upsertBatchOp, upsertBatchOp);
			this.inboxWriteChain = queued.catch(() => undefined);
			await queued;
		}

		const existingPending = nextOrchBase.pendingHeadlessEffects ?? [];
		const nextOrch: IOrchestrationRuntimeState = deferredEffects.length > 0
			? { ...nextOrchBase, pendingHeadlessEffects: this.dedupePendingHeadlessEffects(existingPending, deferredEffects) }
			: nextOrchBase;
		record.orchestrationRuntime = nextOrch;
		const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
		if (mermaidText.trim()) {
			const taskGraph = parseMissionMermaidDag(mermaidText);
			if (!taskGraph.error && taskGraph.nodes.length > 0) {
				const synced = syncMissionTaskStatusesFromOrchestration(
					record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
					taskGraph,
					nextOrch,
					parsedGraph,
					nowTs,
				);
				if (synced.changed) {
					record.taskStatuses = synced.taskStatuses;
				}
			}
		}
		record.updatedAt = nowTs;
		if (options?.alreadyLocked) {
			await this.saveMissionRecordUnlocked(missionId, JSON.stringify(record), nowTs, 'headless-daemon');
		} else {
			await this.saveMissionRecord(missionId, JSON.stringify(record), nowTs, 'headless-daemon');
		}
		const nextTokens = Object.values(nextOrch.tokens ?? {});
		await this.syncOrchestrationDaemonState({
			missionId,
			status: nextOrch.status ?? 'running',
			activeTokenCount: nextTokens.filter(t => t.status === 'active').length,
			blockedTokenCount: nextTokens.filter(t => t.status === 'blocked').length,
			waitingJoinCount: nextTokens.filter(t => t.status === 'waiting_join').length,
			updatedAt: nowTs,
			...(nextOrch.pausedReason ? { pausedReason: nextOrch.pausedReason } : {}),
		});
		this.syncHeadlessWatchdogForMission(missionId, nextOrch, record, parsedGraph);
		await this.watchdog.flushPendingWrites();
		return nextOrch;
	}

	resolveProjectCwdFromRecord(record: Record<string, unknown>): string | undefined {
		const raw = typeof record.projectUri === 'string' ? record.projectUri.trim() : '';
		if (!raw) {
			return undefined;
		}
		if (raw.includes('://')) {
			try {
				const uri = URI.parse(raw);
				if (uri.scheme === 'file' && uri.fsPath) {
					return uri.fsPath;
				}
				return uri.path || undefined;
			} catch {
				return undefined;
			}
		}
		return raw;
	}

	async runHeadlessOrchestrationChecksIfNeeded(
		record: Record<string, unknown>,
		parsedGraph: IOrchestrationGraphParseResult,
		taskGraph: ReturnType<typeof parseMissionMermaidDag> | undefined,
		nodeId: string,
		extraTaskNodeIds: readonly string[],
		skipChecks: boolean,
		isHumanUser: boolean,
		tokenId?: string,
	) {
		const staffNode = parsedGraph.nodes.find(n => n.id === nodeId && n.kind === 'staff');
		const nodeChecksMap = (record.nodeChecks && typeof record.nodeChecks === 'object')
			? record.nodeChecks as Readonly<Record<string, readonly IMissionNodeCheckHook[]>>
			: undefined;
		const collected = resolveMergedNodeCheckHooks({
			nodeIds: [nodeId, ...extraTaskNodeIds],
			recordNodeChecks: nodeChecksMap,
			parsedOrch: !parsedGraph.error ? parsedGraph : undefined,
			parsedDag: taskGraph && !taskGraph.error ? taskGraph : undefined,
			onlyEnabled: true,
		});
		if (collected.length === 0) {
			return { ok: true, checkCount: 0, totalDurationMs: 0, results: [] };
		}
		if (skipChecks) {
			if (!isHumanUser) {
				return {
					ok: false,
					error: `FORBIDDEN: Only Human User (L-1) may pass --skip-checks to bypass deterministic verification hooks on "${nodeId}".`,
					checkCount: collected.length,
					totalDurationMs: 0,
					results: [],
				};
			}
			return { ok: true, checkCount: 0, totalDurationMs: 0, results: [] };
		}

		const projectCwd = this.resolveProjectCwdFromRecord(record);
		const runtimeBoundary = (record.runtime as { readonly boundary?: { readonly nodeAssignments?: Readonly<Record<string, { readonly hostAlias?: string }>> } } | undefined)?.boundary;
		const defaultHostAlias = staffNode?.hostAlias || runtimeBoundary?.nodeAssignments?.[nodeId]?.hostAlias || 'local';
		const failures: string[] = [];
		const results: IAdeDeterministicCheckResponse[] = [];
		const startedAt = Date.now();
		for (const chk of collected) {
			const hostAlias = chk.hostAlias?.trim() || defaultHostAlias;
			const rawCheckCwd = chk.cwd?.trim();
			const resolvedCwd = rawCheckCwd
				? (hostAlias !== 'local'
					? (rawCheckCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawCheckCwd) ? rawCheckCwd : (projectCwd ? path.posix.join(projectCwd, rawCheckCwd) : rawCheckCwd))
					: (path.isAbsolute(rawCheckCwd) ? rawCheckCwd : (projectCwd ? path.resolve(projectCwd, rawCheckCwd) : rawCheckCwd)))
				: projectCwd;
			const res = await this.runDeterministicCheck({
				checkId: chk.id,
				name: chk.name,
				command: chk.command,
				cwd: resolvedCwd,
				hostAlias,
				expectExitCode: chk.expectExitCode,
				expectFiles: chk.expectFiles,
				expectOutputMatch: chk.expectOutputMatch,
				timeoutMs: chk.timeoutMs,
			});
			results.push(res);
			if (!res.passed) {
				const parts: string[] = [`- [${chk.name || chk.id}] FAILED (exit=${res.exitCode}, expected=${res.expectedExitCode}, host=${hostAlias})`];
				if (res.error) { parts.push(`  error: ${res.error}`); }
				if (res.missingFiles && res.missingFiles.length > 0) { parts.push(`  missing/empty files: ${res.missingFiles.join(', ')}`); }
				if (res.outputTail) { parts.push(`  output tail:\n${res.outputTail}`); }
				failures.push(parts.join('\n'));
			}
		}
		const totalDurationMs = Math.max(0, Date.now() - startedAt);
		const passedCount = results.filter(r => r.passed).length;
		const receipt = {
			passed: failures.length === 0,
			summary: `${passedCount}/${results.length} check(s) passed on "${nodeId}"`,
			checkedAt: Date.now(),
			checkCount: results.length,
			...(tokenId ? { tokenId } : {}),
			byNodeId: nodeId,
		};
		if (failures.length > 0) {
			return {
				ok: false,
				receipt,
				checkCount: collected.length,
				totalDurationMs,
				results,
				error: `DETERMINISTIC_CHECK_FAILED on "${nodeId}" (${failures.length}/${collected.length} check(s) failed). Fix the underlying failure before advancing the token:\n${failures.join('\n')}`,
			};
		}
		return { ok: true, receipt, checkCount: collected.length, totalDurationMs, results };
	}

	async processHeadlessWatchdogWakeup(ev: IAdeWatchdogWakeupEvent): Promise<boolean> {
		if (this._store.isDisposed) {
			return false;
		}
		return this.withMissionLock(ev.missionId, async () => {
			if (this._store.isDisposed) {
				return false;
			}
			const rawMission = await this.loadMissionRecord(ev.missionId);
			if (!rawMission) {
				return false;
			}
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(rawMission) as Record<string, unknown>;
			} catch {
				return false;
			}
			const orch = record.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
			if (!orch || orch.status === 'paused' || orch.status === 'aborted' || orch.budgetCircuitTripped) {
				return false;
			}
			const nowTs = ev.timestamp || Date.now();
			const orchestrationText = typeof record.orchestrationText === 'string' ? record.orchestrationText : '';
			const parsedGraph = parseOrchestrationGraph(orchestrationText);

			if (ev.reason === 'barrier_deadline_expired' && ev.barrierId) {
				const barrier = orch.joinBarriers?.[ev.barrierId];
				if (!barrier || barrier.status !== 'waiting') {
					return false;
				}
				const orgConfig = await this.loadCachedOrgConfig();
				const whiteboards = record.whiteboards as Readonly<Record<string, IOrchestrationWhiteboard>> | undefined;
				const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
				const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
				const taskStatuses = record.taskStatuses as Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
				const res = expireOrchestrationJoinBarrier(orch, parsedGraph, whiteboards, orgConfig, {
					barrierId: ev.barrierId,
					reason: ev.detail,
					...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
					now: nowTs,
				});
				if (!res.ok) {
					return false;
				}
				await this.persistHeadlessOrchStateRecord(ev.missionId, record, parsedGraph, res.state, res.effects, nowTs, { alreadyLocked: true });
				return true;
			}

			if (!orch.tokens?.[ev.tokenId]) {
				return false;
			}
			if (ev.reason === 'pid_exited' || ev.reason === 'file_ready' || ev.reason === 'block_expired') {
				const res = wakeBlockedOrchestrationToken(orch, {
					tokenId: ev.tokenId,
					reason: ev.reason,
					detail: ev.detail,
					now: nowTs,
				});
				if (!res.ok) {
					return false;
				}
				await this.persistHeadlessOrchStateRecord(ev.missionId, record, parsedGraph, res.state, res.effects, nowTs, { alreadyLocked: true });
				return true;
			}

			if (ev.reason === 'silence_timeout' || ev.reason === 'agent_exited') {
				const res = recordOrchestrationSilenceReminder(orch, {
					tokenId: ev.tokenId,
					detail: ev.detail,
					now: nowTs,
				});
				if (!res.ok) {
					return false;
				}
				const effects: OrchestrationEngineEffect[] = [...res.effects];
				const updatedTok = res.state.tokens[ev.tokenId];
				const nudgeCount = updatedTok?.nudgeCount ?? 0;
				// Headless 3-strike silence auto-escalation parity with renderer: surface a critical escalation
				// to ADE Inbox every 3 consecutive unacknowledged reminders so stuck headless workers never loop silently.
				if (updatedTok && updatedTok.status === 'active' && nudgeCount >= 3 && nudgeCount % 3 === 0) {
					const superiorNodeId = (updatedTok.returnToNodeId && updatedTok.returnToNodeId !== updatedTok.nodeId)
						? updatedTok.returnToNodeId
						: (updatedTok.fromNodeId && updatedTok.fromNodeId !== updatedTok.nodeId ? updatedTok.fromNodeId : undefined);
					effects.push({
						kind: 'post_inbox',
						missionId: ev.missionId,
						tokenId: updatedTok.id,
						nodeId: updatedTok.nodeId,
						senderAgentId: res.state.nodeAgentIds?.[updatedTok.nodeId] ?? updatedTok.holderAgentId,
						severity: 'critical',
						title: `Engineering Escalation: "${updatedTok.nodeId}" unresponsive (${nudgeCount}x ${ev.reason})`,
						message: `Staff node "${updatedTok.nodeId}" remained unresponsive after ${nudgeCount} consecutive watchdog reminders (${ev.reason}) for baton "${updatedTok.id}".${superiorNodeId ? ` Escalated for superior "${superiorNodeId}" / Human intervention.` : ' Human intervention requested.'}`,
					});
				}
				await this.persistHeadlessOrchStateRecord(ev.missionId, record, parsedGraph, res.state, effects, nowTs, { alreadyLocked: true });
				return true;
			}

			return false;
		});
	}

	async executeHeadlessOrchestrationControl(
		action: string,
		params: Readonly<Record<string, unknown>>,
	): Promise<IAdeHeadlessControlResult> {
		if (!HEADLESS_SUPPORTED_ACTIONS.has(action)) {
			return { handled: false };
		}

		const preConfig = await this.loadCachedOrgConfig();
		const globalResult = await tryExecuteHeadlessGlobalAction(this, action, params, preConfig);
		if (globalResult !== undefined) {
			return globalResult;
		}

		const resolved = await resolveHeadlessMissionId(this, action, params);
		if (resolved.earlyResult) {
			return resolved.earlyResult;
		}
		const missionId = resolved.missionId!;

		const isMutatingMissionAction = HEADLESS_MUTATING_MISSION_ACTIONS.has(action);
		if (isMutatingMissionAction) {
			return this.withMissionLock(missionId, () => this.executeHeadlessMissionScopedControl(missionId, action, params, preConfig, true));
		}
		return this.executeHeadlessMissionScopedControl(missionId, action, params, preConfig, false);
	}

	private async executeHeadlessMissionScopedControl(
		missionId: string,
		action: string,
		params: Readonly<Record<string, unknown>>,
		effectiveOrgConfig: IAdeOrganizationConfig,
		isLocked: boolean,
	): Promise<IAdeHeadlessControlResult> {
		const rawMission = await this.loadMissionRecord(missionId);
		if (!rawMission) {
			return { handled: true, error: `Mission "${missionId}" not found in cold storage.` };
		}
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(rawMission) as Record<string, unknown>;
		} catch {
			return { handled: true, error: `Mission "${missionId}" cold record is malformed JSON.` };
		}
		const orch = record.orchestrationRuntime as IOrchestrationRuntimeState | undefined;
		const requiresActiveOrch = action === 'orchestration.status'
			|| action === 'orchestration.pause'
			|| action === 'orchestration.resume'
			|| action === 'orchestration.abort'
			|| action.startsWith('token.');
		if (!orch && requiresActiveOrch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}

		const orchestrationText = typeof record.orchestrationText === 'string' ? record.orchestrationText : '';
		const parsedGraph = parseOrchestrationGraph(orchestrationText);
		const caller = resolveHeadlessCaller(params, orch, parsedGraph, effectiveOrgConfig);

		const buildMergedWhiteboards = (): Readonly<Record<string, IOrchestrationWhiteboard>> => {
			const merged: Record<string, IOrchestrationWhiteboard> = {
				...((record.whiteboards ?? {}) as Readonly<Record<string, IOrchestrationWhiteboard>>),
			};
			const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0;
			const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : createdAt;
			for (const node of parsedGraph.nodes) {
				if (node.kind === 'whiteboard' && !merged[node.id]) {
					merged[node.id] = {
						id: node.id,
						title: node.label,
						department: node.department || 'General',
						content: '',
						version: 0,
						createdAt,
						updatedAt,
					};
				}
			}
			return merged;
		};

		const isMissionMember = (c = caller): boolean => {
			const legacyBoundary = (record.runtime as {
				readonly boundary?: {
					readonly supervisors?: ReadonlyArray<{ readonly id: string }>;
					readonly nodeAssignments?: Readonly<Record<string, { readonly agentId?: string }>>;
				};
			} | undefined)?.boundary;
			const supervisorIds = legacyBoundary?.supervisors?.map(s => s.id) ?? [];
			const nodeAssignmentAgentIds = Object.values(legacyBoundary?.nodeAssignments ?? {})
				.map(a => a?.agentId)
				.filter((id): id is string => Boolean(id));
			if (isExplicitMissionMemberOrSupervisor({
				missionId,
				isHumanUser: c.isHumanUser,
				isSecretary: c.isSecretary,
				callerSessionId: c.callerSessionId,
				ownerSessionId: typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : undefined,
				supervisorIds,
				nodeAssignmentAgentIds,
				orchNodeAgentIds: orch?.nodeAgentIds,
			})) {
				return true;
			}
			if (params._verifiedCaller !== true && c.callerNodeId && parsedGraph.nodes.some(n => n.id === c.callerNodeId && n.kind === 'staff')) {
				return true;
			}
			return false;
		};

		const ctx: IHeadlessMissionScopeContext = {
			host: this,
			missionId,
			action,
			params,
			effectiveOrgConfig,
			isLocked,
			record,
			orch,
			orchestrationText,
			parsedGraph,
			caller,
			buildMergedWhiteboards,
			isMissionMember,
			assertMissionMemberOrSupervisor: (c = caller) => isMissionMember(c) ? undefined : `FORBIDDEN: caller is not a member or supervisor of Mission "${missionId}".`,
			canOperateMission: (c = caller) => canHeadlessCallerOperateMission(record, parsedGraph, effectiveOrgConfig, c),
			saveCurrentRecord: async (nowTs: number) => {
				record.updatedAt = nowTs;
				if (isLocked) {
					await this.saveMissionRecordUnlocked(missionId, JSON.stringify(record), nowTs, 'headless-daemon');
				} else {
					await this.saveMissionRecord(missionId, JSON.stringify(record), nowTs, 'headless-daemon');
				}
			},
			collectEffectiveNodeChecks: (filterNodeId?: string) => {
				const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
				const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
				const nodeChecksMap = (record.nodeChecks && typeof record.nodeChecks === 'object')
					? record.nodeChecks as Readonly<Record<string, readonly IMissionNodeCheckHook[]>>
					: {};
				const candidateIds = filterNodeId
					? [filterNodeId]
					: [...new Set([
						...parsedGraph.nodes.filter(n => n.kind === 'staff').map(n => n.id),
						...(taskGraph && !taskGraph.error ? taskGraph.nodes.map(n => n.id) : []),
						...Object.keys(nodeChecksMap),
					])];
				const out: Record<string, readonly IMissionNodeCheckHook[]> = {};
				for (const nid of candidateIds) {
					const mergedHooks = resolveMergedNodeCheckHooks({
						nodeIds: [nid],
						recordNodeChecks: nodeChecksMap,
						parsedOrch: !parsedGraph.error ? parsedGraph : undefined,
						parsedDag: taskGraph && !taskGraph.error ? taskGraph : undefined,
						onlyEnabled: false,
					});
					if (filterNodeId || mergedHooks.length > 0) {
						out[nid] = mergedHooks;
					}
				}
				return out;
			},
			filterWhiteboardsForCaller: (c = caller) => {
				const merged = buildMergedWhiteboards();
				const visible = Object.values(merged).filter(wb =>
					canCallerAccessWhiteboard(parsedGraph, wb, effectiveOrgConfig, { ...c, access: 'read', state: orch }),
				);
				const allowedIds = new Set(visible.map(w => w.id));
				const safeOrchText = (c.isHumanUser || c.isSecretary)
					? orchestrationText
					: stripForeignWhiteboardBodiesFromOrchestrationText(orchestrationText, allowedIds);
				return { visible, allowedIds, safeOrchText };
			},
			persistHeadlessOrchState: (nextOrchBase, emittedEffects, nowTs) =>
				this.persistHeadlessOrchStateRecord(missionId, record, parsedGraph, nextOrchBase, emittedEffects, nowTs, { alreadyLocked: isLocked }),
		};

		const rbacErr = checkHeadlessMissionRbac(ctx);
		if (rbacErr) {
			return { handled: true, error: rbacErr };
		}

		const readRes = await tryExecuteHeadlessMissionReadAction(ctx);
		if (readRes !== undefined) {
			return readRes;
		}
		return executeHeadlessMissionMutationAction(ctx);
	}

	private get orgConfigCachePath(): string {
		return path.join(this.baseDir, 'org-config.cache.json');
	}

	async loadCachedOrgConfig(): Promise<IAdeOrganizationConfig> {
		if (this.orgConfigCacheLoaded) {
			return this.cachedOrgConfig;
		}
		try {
			const raw = await fs.promises.readFile(this.orgConfigCachePath, 'utf8');
			const parsed = JSON.parse(raw) as IAdeOrganizationConfig;
			if (parsed && Array.isArray(parsed.ranks) && parsed.ranks.length > 0) {
				this.cachedOrgConfig = parsed;
				this.orgConfigCacheLoaded = true;
			}
		} catch (err) {
			// Only latch on definitive ENOENT; transient read/rename errors will retry on next call.
			if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
				this.orgConfigCacheLoaded = true;
			}
		}
		return this.cachedOrgConfig;
	}

	async syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths> {
		this.cachedOrgConfig = config;
		this.orgConfigCacheLoaded = true;
		const writeCacheOp = async () => {
			if (this._store.isDisposed) {
				return;
			}
			try {
				await fs.promises.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
				if (this._store.isDisposed) {
					return;
				}
				const tmp = `${this.orgConfigCachePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
				await fs.promises.writeFile(tmp, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
				if (this._store.isDisposed) {
					await fs.promises.unlink(tmp).catch(() => undefined);
					return;
				}
				await fs.promises.rename(tmp, this.orgConfigCachePath);
			} catch {
				// Non-fatal cache write
			}
		};
		const queuedCache = this.orgConfigWriteChain.then(writeCacheOp, writeCacheOp);
		this.orgConfigWriteChain = queuedCache.catch(() => undefined);
		const [paths] = await Promise.all([
			syncAdeApiDocsToDisk(this.baseDir, config),
			queuedCache,
		]);
		return paths;
	}

	async getApiDocsPaths(rankCount: number): Promise<IAdeDocsPaths> {
		return buildAdeDocsPaths(this.baseDir, rankCount);
	}

	async readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult> {
		const normalized = (target || '').trim();
		const effectiveConfig = config ?? await this.loadCachedOrgConfig();
		const paths = buildAdeDocsPaths(this.baseDir, effectiveConfig.ranks.length);

		const parsedTarget = normalizeAdeDocTargetKey(normalized);
		let filePath: string | undefined;
		const canonicalTarget = parsedTarget?.canonicalTarget ?? normalized;

		if (parsedTarget) {
			switch (parsedTarget.kind) {
				case 'common':
					filePath = paths.commonDoc;
					break;
				case 'engineering-paradigm':
					filePath = paths.engineeringParadigmDoc;
					break;
				case 'engineering-api':
					filePath = paths.engineeringApiDoc;
					break;
				case 'mission':
					filePath = paths.missionDoc;
					break;
				case 'manifest':
					filePath = paths.manifestFile;
					break;
				case 'rank':
					filePath = paths.rankDocs[parsedTarget.canonicalTarget];
					break;
			}
		}

		if (!filePath) {
			return {
				ok: false,
				target: canonicalTarget || normalized,
				revision: ADE_API_LATEST_REVISION,
				error: `Unknown API doc target "${target}". Valid targets: common, engineering, paradigm, engineering-api, mission, manifest, L0..L${effectiveConfig.ranks.length}.`,
			};
		}

		let expectedFingerprint: string | undefined;
		try {
			const bundle = buildAdeDocsBundle(effectiveConfig);
			const parsedBundleManifest = bundle.manifestJson ? JSON.parse(bundle.manifestJson) as { configFingerprint?: unknown } : undefined;
			if (typeof parsedBundleManifest?.configFingerprint === 'string') {
				expectedFingerprint = parsedBundleManifest.configFingerprint;
			}
		} catch {
			expectedFingerprint = undefined;
		}

		let docsUpToDate = false;
		if (paths.manifestFile && expectedFingerprint) {
			try {
				const rawManifest = await fs.promises.readFile(paths.manifestFile, 'utf8');
				const parsedManifest = JSON.parse(rawManifest) as { currentRevision?: unknown; rankCount?: unknown; configFingerprint?: unknown };
				docsUpToDate = parsedManifest.currentRevision === ADE_API_LATEST_REVISION
					&& parsedManifest.rankCount === effectiveConfig.ranks.length
					&& parsedManifest.configFingerprint === expectedFingerprint;
			} catch {
				docsUpToDate = false;
			}
		}

		if (docsUpToDate) {
			try {
				const content = await fs.promises.readFile(filePath, 'utf8');
				return {
					ok: true,
					target: canonicalTarget,
					path: filePath,
					revision: ADE_API_LATEST_REVISION,
					content,
				};
			} catch {
				// Target file missing despite manifest -> resync below
			}
		}

		try {
			await syncAdeApiDocsToDisk(this.baseDir, effectiveConfig);
			const content = await fs.promises.readFile(filePath, 'utf8');
			return {
				ok: true,
				target: canonicalTarget,
				path: filePath,
				revision: ADE_API_LATEST_REVISION,
				content,
			};
		} catch (err) {
			return {
				ok: false,
				target: canonicalTarget,
				path: filePath,
				revision: ADE_API_LATEST_REVISION,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	async probeFileMtime(hostAlias: string, filePath: string): Promise<number | null> {
		const trimmed = filePath.trim();
		if (!trimmed) {
			return null;
		}
		const normalizedHost = hostAlias.trim() || 'local';
		try {
			if (normalizedHost !== 'local') {
				if (!this.remoteProbe) {
					return null;
				}
				const mtime = await this.remoteProbe.remoteFileStatMtime(normalizedHost, trimmed);
				return typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : null;
			}
			const st = await fs.promises.stat(trimmed);
			return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
		} catch {
			return null;
		}
	}

	async probeFileSignature(hostAlias: string, filePath: string): Promise<string | null> {
		const trimmed = filePath.trim();
		if (!trimmed) {
			return null;
		}
		const normalizedHost = hostAlias.trim() || 'local';
		try {
			if (normalizedHost !== 'local') {
				if (!this.remoteProbe) {
					return null;
				}
				if (this.remoteProbe.remoteFileStatSignature) {
					const sig = await this.remoteProbe.remoteFileStatSignature(normalizedHost, trimmed);
					return sig ?? null;
				}
				if (this.remoteProbe.remoteStat) {
					const st = await this.remoteProbe.remoteStat(normalizedHost, trimmed);
					return `${Math.round(st.mtime)}:${st.size}`;
				}
				const mtime = await this.remoteProbe.remoteFileStatMtime(normalizedHost, trimmed);
				return typeof mtime === 'number' && Number.isFinite(mtime) ? `${mtime}` : null;
			}
			const st = await fs.promises.stat(trimmed);
			return `${Math.round(st.mtimeMs)}:${st.size}:${st.ino}`;
		} catch {
			return null;
		}
	}

	async syncMissionWatchdog(snapshot: IAdeMissionWatchdogSnapshot): Promise<void> {
		if (snapshot.ownerWindowCtx?.trim()) {
			this.liveRendererContexts.add(snapshot.ownerWindowCtx.trim());
		}
		this.watchdog.syncMission(snapshot);
	}

	async removeMissionWatchdog(missionId: string): Promise<void> {
		this.watchdog.removeMission(missionId);
	}

	getMissionWatchdogOwner(missionId: string): string | undefined {
		return this.watchdog.getMissionOwnerWindowCtx(missionId);
	}

	async canRecoverMission(missionId: string, callerWindowCtx?: string): Promise<boolean> {
		const ownerCtx = this.watchdog.getMissionOwnerWindowCtx(missionId)?.trim();
		const caller = callerWindowCtx?.trim();
		if (ownerCtx && caller && ownerCtx !== caller && this.liveRendererContexts.has(ownerCtx)) {
			return false;
		}
		return true;
	}

	async notifySystemResume(): Promise<void> {
		this._onDidSystemResume.fire(Date.now());
		this.watchdog.notifySystemResume();
	}

	async runDeterministicCheck(request: IAdeDeterministicCheckRequest): Promise<IAdeDeterministicCheckResponse> {
		return executeAdeDeterministicCheck(request, this.remoteProbe);
	}
}
