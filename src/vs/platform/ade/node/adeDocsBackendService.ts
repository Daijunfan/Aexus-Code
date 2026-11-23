/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../base/common/path.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { isWindows } from '../../../base/common/platform.js';
import { ADE_API_LATEST_REVISION } from '../common/adeApiRegistry.js';
import { stripAdeControlEnv } from '../common/adeControl.js';
import { buildAdeDocsPaths, IAdeDocsPaths, normalizeAdeDocTargetKey } from '../common/adeDocsCatalog.js';
import {
	ADE_INBOX_FILE_NAME,
	encodeAdeMissionStorageFileName,
	IAdeApiDocReadResult,
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
	IAdeEngineeringBackendService,
	IAdeHeadlessControlResult,
	IAdeInboxItem,
	IAdeInboxMutation,
	IAdeMissionColdChangeEvent,
	IAdeMissionWatchdogSnapshot,
	IAdeOrchestrationDaemonMissionSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from '../common/adeEngineering.js';
import { parseMissionMermaidDag } from '../common/adeMissionDag.js';
import { parseDurationMs } from '../common/adeMissionEngine.js';
import {
	abortOrchestrationTokens,
	blockOrchestrationToken,
	canCallerAccessWhiteboard,
	completeOrchestrationToken,
	failOrchestrationToken,
	handoffOrchestrationToken,
	IOrchestrationContextBlobInput,
	IOrchestrationMintBranch,
	IOrchestrationRuntimeState,
	IOrchestrationWhiteboard,
	mintOrchestrationTokens,
	MissionTaskStatus,
	mutateDepartmentWhiteboard,
	ORCHESTRATION_SILENCE_REMINDER_MINUTES,
	OrchestrationEngineEffect,
	pauseOrchestration,
	resumeOrchestration,
	returnOrchestrationToken,
	syncMissionTaskStatusesFromOrchestration,
	updateMissionTaskNodeStatus,
} from '../common/adeOrchestrationEngine.js';
import { parseOrchestrationGraph, upsertOrchestrationWhiteboardInCode } from '../common/adeOrchestrationGraph.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, IAdeOrganizationConfig } from '../common/adeRoleSchema.js';
import { syncAdeApiDocsToDisk } from './adeDocsSync.js';
import { AdeMissionWatchdogService, IAdeRemoteWatchdogProbe } from './adeMissionWatchdogService.js';

const MAX_CHECK_MEMORY_BYTES = 64 * 1024;
const MAX_CHECK_TAIL_CHARS = 2_400;

function appendTailBuffer(prev: string, chunk: string, maxChars: number): string {
	const next = prev + chunk;
	if (next.length <= maxChars) {
		return next;
	}
	return next.slice(next.length - maxChars);
}

function formatBoundedOutputTail(raw: string, maxChars = MAX_CHECK_TAIL_CHARS): string {
	const trimmed = raw.trim();
	if (trimmed.length <= maxChars) {
		return trimmed;
	}
	const tail = trimmed.slice(trimmed.length - maxChars);
	const newlineIdx = tail.indexOf('\n');
	const aligned = newlineIdx >= 0 && newlineIdx < 160 ? tail.slice(newlineIdx + 1) : tail;
	return `…[truncated ${trimmed.length - aligned.length} chars]\n${aligned}`;
}

function matchesExpectedOutput(output: string, pattern: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed) {
		return true;
	}
	const regexLiteral = /^\/(.+)\/([a-z]*)$/.exec(trimmed);
	if (regexLiteral) {
		try {
			const re = new RegExp(regexLiteral[1], regexLiteral[2]);
			return re.test(output);
		} catch {
			return output.includes(trimmed);
		}
	}
	return output.includes(trimmed);
}

function runLocalDeterministicShell(
	command: string,
	cwd: string | undefined,
	timeoutMs: number,
): Promise<{ readonly exitCode: number; readonly output: string; readonly timedOut: boolean; readonly durationMs: number; readonly error?: string }> {
	const startedAt = Date.now();
	return new Promise(resolve => {
		const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
		const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];
		let child;
		try {
			child = spawn(shell, shellArgs, {
				cwd: cwd || undefined,
				windowsHide: true,
				detached: !isWindows,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: stripAdeControlEnv(process.env),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			resolve({ exitCode: 1, output: msg, timedOut: false, durationMs: Math.max(0, Date.now() - startedAt), error: msg });
			return;
		}

		let combined = '';
		let settled = false;
		let timedOut = false;

		const killTree = () => {
			if (!child.pid) {
				return;
			}
			try {
				if (!isWindows) {
					process.kill(-child.pid, 'SIGKILL');
				} else {
					child.kill('SIGKILL');
				}
			} catch {
				try { child.kill('SIGKILL'); } catch { /* already exited */ }
			}
		};

		const timer = setTimeout(() => {
			if (!settled) {
				timedOut = true;
				killTree();
			}
		}, timeoutMs);

		const onChunk = (buf: Buffer | string) => {
			const text = typeof buf === 'string' ? buf : buf.toString('utf8');
			combined = appendTailBuffer(combined, text, MAX_CHECK_MEMORY_BYTES);
		};
		child.stdout?.on('data', onChunk);
		child.stderr?.on('data', onChunk);

		child.once('error', err => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				const msg = err instanceof Error ? err.message : String(err);
				resolve({
					exitCode: timedOut ? 124 : 1,
					output: combined || msg,
					timedOut,
					durationMs: Math.max(0, Date.now() - startedAt),
					error: msg,
				});
			}
		});

		child.once('close', code => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({
					exitCode: timedOut ? 124 : (typeof code === 'number' ? code : 1),
					output: combined,
					timedOut,
					durationMs: Math.max(0, Date.now() - startedAt),
					...(timedOut ? { error: `Deterministic check timed out after ${timeoutMs}ms` } : {}),
				});
			}
		});
	});
}

export interface IAdeDocsBackendNodeServiceOptions {
	readonly baseDir?: string;
	readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	readonly watchdogPollIntervalMs?: number;
}

/**
 * Node main-process backend for:
 * 1) Single-copy ADE API docs synchronization & lazy read (`<adeHome>/docs/`)
 * 2) ADE Inbox JSON persistence (`<adeHome>/inbox.json`)
 * 3) Local Mission Watchdog Daemon & zero-token Source Trigger Monitor
 */
export class AdeDocsBackendNodeService extends Disposable implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly baseDir: string;
	private readonly watchdog: AdeMissionWatchdogService;
	private readonly remoteProbe?: IAdeRemoteWatchdogProbe;
	private cachedOrgConfig: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG;
	private orgConfigCacheLoaded = false;
	private inboxWriteChain: Promise<void> = Promise.resolve();
	private readonly missionWriteChains = new Map<string, Promise<void>>();
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
		this.watchdog = this._register(new AdeMissionWatchdogService({
			remoteProbe: options?.remoteProbe,
			pollIntervalMs: options?.watchdogPollIntervalMs,
			triggerStatePath: path.join(this.baseDir, 'watchdog-triggers.json'),
			snapshotStatePath: path.join(this.baseDir, 'watchdog-snapshots.json'),
		}));
		this.onDidWatchdogWakeup = this.watchdog.onDidWatchdogWakeup;
		this.onDidSourceTriggerFire = this.watchdog.onDidSourceTriggerFire;
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

	private missionArchivePath(missionId: string): string {
		return this.missionFilePath(missionId).replace(/\.json$/i, '.archive.jsonl');
	}

	private get orchestrationDaemonPath(): string {
		return path.join(this.baseDir, 'orchestration-daemon.json');
	}

	private sanitizeBlobPtrFileName(ptr: string): string | undefined {
		const trimmed = ptr.trim();
		if (!trimmed || !/^[A-Za-z0-9_.-]{1,96}$/.test(trimmed) || trimmed.includes('..')) {
			return undefined;
		}
		return `${trimmed}.json`;
	}

	private enqueueMissionFileOp(missionId: string, op: () => Promise<void>): Promise<void> {
		const prev = this.missionWriteChains.get(missionId) ?? Promise.resolve();
		const next = prev.then(op, op);
		const settled = next.then(() => undefined, () => undefined);
		this.missionWriteChains.set(missionId, settled);
		void settled.finally(() => {
			if (this.missionWriteChains.get(missionId) === settled) {
				this.missionWriteChains.delete(missionId);
			}
		});
		return next;
	}

	async loadMissionRecord(missionId: string): Promise<string | undefined> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			return await fs.promises.readFile(this.missionFilePath(trimmed), 'utf8');
		} catch {
			return undefined;
		}
	}

	async loadAllMissionRecords(): Promise<Readonly<Record<string, string>>> {
		const out: Record<string, string> = {};
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.missionsDir);
		} catch {
			return out;
		}
		await Promise.all(entries.map(async name => {
			if (!name.endsWith('.json') || name.includes('.tmp.')) {
				return;
			}
			try {
				const raw = await fs.promises.readFile(path.join(this.missionsDir, name), 'utf8');
				const parsed = JSON.parse(raw) as { id?: unknown };
				if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && parsed.id.trim()) {
					out[parsed.id.trim()] = raw;
				}
			} catch {
				// Skip corrupt or half-written file cleanly
			}
		}));
		return out;
	}

	async saveMissionRecord(missionId: string, payloadJson: string, updatedAt: number, writerId?: string): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return;
		}
		return this.enqueueMissionFileOp(trimmed, async () => {
			await fs.promises.mkdir(this.missionsDir, { recursive: true, mode: 0o700 });
			const target = this.missionFilePath(trimmed);
			const uniqueSuffix = `${process.pid}.${Date.now()}.${++this.inboxTmpSeq}.${crypto.randomBytes(6).toString('hex')}`;
			const tmp = `${target}.tmp.${uniqueSuffix}`;
			try {
				await fs.promises.writeFile(tmp, payloadJson, { encoding: 'utf8', mode: 0o600 });
				await fs.promises.rename(tmp, target);
			} catch (err) {
				await fs.promises.unlink(tmp).catch(() => undefined);
				throw err;
			}
			this._onDidMissionRecordChange.fire({
				missionId: trimmed,
				updatedAt,
				...(writerId ? { writerId } : {}),
			});
		});
	}

	async deleteMissionRecord(missionId: string, writerId?: string): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed) {
			return;
		}
		return this.enqueueMissionFileOp(trimmed, async () => {
			await fs.promises.unlink(this.missionFilePath(trimmed)).catch(() => undefined);
			await fs.promises.rm(this.missionBlobsDir(trimmed), { recursive: true, force: true }).catch(() => undefined);
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

	async saveOrchestrationBlobs(missionId: string, blobs: readonly { readonly ptr: string; readonly payloadJson: string }[]): Promise<void> {
		const trimmed = missionId.trim();
		if (!trimmed || blobs.length === 0) {
			return;
		}
		return this.enqueueMissionFileOp(trimmed, async () => {
			const dir = this.missionBlobsDir(trimmed);
			await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
			for (const item of blobs) {
				const fileName = this.sanitizeBlobPtrFileName(item.ptr);
				if (!fileName) {
					continue;
				}
				const target = path.join(dir, fileName);
				try {
					// Content-addressed blobs are immutable; skip re-writing if already persisted on disk.
					await fs.promises.access(target, fs.constants.F_OK);
					continue;
				} catch {
					// Not present yet -> write atomically
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
	}

	async readOrchestrationBlob(missionId: string, ptr: string): Promise<string | undefined> {
		const trimmed = missionId.trim();
		const fileName = this.sanitizeBlobPtrFileName(ptr);
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
		return this.enqueueMissionFileOp(trimmed, async () => {
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

	private async removeOrchestrationDaemonEntry(missionId: string): Promise<void> {
		const map = await this.loadDaemonStateMap();
		if (Object.hasOwn(map, missionId)) {
			delete map[missionId];
			await this.writeDaemonStateMap(map);
		}
	}

	async syncOrchestrationDaemonState(snapshot: IAdeOrchestrationDaemonMissionSnapshot): Promise<void> {
		if (!snapshot?.missionId?.trim()) {
			return;
		}
		const missionId = snapshot.missionId.trim();
		const map = await this.loadDaemonStateMap();
		map[missionId] = { ...snapshot, missionId };
		await this.writeDaemonStateMap(map);
	}

	async getOrchestrationDaemonState(missionId?: string): Promise<Readonly<Record<string, IAdeOrchestrationDaemonMissionSnapshot>>> {
		const map = await this.loadDaemonStateMap();
		if (missionId?.trim()) {
			const entry = map[missionId.trim()];
			return entry ? { [missionId.trim()]: entry } : {};
		}
		return map;
	}

	/**
	 * Headless main-process Orchestration control fallback when 0 workbench windows are open:
	 * serves Orchestration token transitions (`token.current|return|handoff|complete|block|fail|mint|split|read|history`),
	 * Department Whiteboards (`whiteboard.list|read|create|write`), Mission Task DAG updates (`mission.task.complete|status`),
	 * and run controls (`orchestration.status|pause|resume|abort`) directly against cold mission storage & daemon,
	 * durably queueing `pendingHeadlessEffects` so the next workbench window immediately dispatches woken turns & Inbox deliveries.
	 */
	async executeHeadlessOrchestrationControl(
		action: string,
		params: Readonly<Record<string, unknown>>,
	): Promise<IAdeHeadlessControlResult> {
		const SUPPORTED = new Set([
			'orchestration.status',
			'orchestration.pause',
			'orchestration.resume',
			'orchestration.abort',
			'token.current',
			'token.read',
			'token.history',
			'token.return',
			'token.handoff',
			'token.complete',
			'token.block',
			'token.fail',
			'token.mint',
			'token.split',
			'whiteboard.list',
			'whiteboard.read',
			'whiteboard.create',
			'whiteboard.write',
			'mission.task.complete',
			'mission.task.status',
		]);
		if (!SUPPORTED.has(action)) {
			return { handled: false };
		}

		let missionId = typeof params.missionId === 'string' && params.missionId.trim()
			? params.missionId.trim()
			: (typeof params.mission === 'string' && params.mission.trim() ? params.mission.trim() : '');
		if (!missionId) {
			if (action === 'orchestration.status') {
				const daemonState = await this.getOrchestrationDaemonState();
				return { handled: true, result: { headless: true, daemonMissions: daemonState } };
			}
			// Auto-resolve Mission from tokenId or authenticated caller session against cold mission storage.
			const allCold = await this.loadAllMissionRecords();
			const lookupTokenId = typeof (params.tokenId ?? params.token ?? params.parentTokenId) === 'string'
				? String(params.tokenId ?? params.token ?? params.parentTokenId).trim()
				: '';
			const verifiedSid = params._verifiedCaller === true && typeof params._callerSessionId === 'string'
				? params._callerSessionId.trim()
				: '';
			const candidateIds: string[] = [];
			for (const [mid, raw] of Object.entries(allCold)) {
				try {
					const rec = JSON.parse(raw) as { ownerSessionId?: string; orchestrationRuntime?: IOrchestrationRuntimeState };
					if (lookupTokenId && rec.orchestrationRuntime?.tokens?.[lookupTokenId]) {
						missionId = mid;
						break;
					}
					if (verifiedSid) {
						const isMember = rec.ownerSessionId === verifiedSid
							|| Object.values(rec.orchestrationRuntime?.nodeAgentIds ?? {}).includes(verifiedSid);
						if (isMember) {
							candidateIds.push(mid);
						}
					}
				} catch {
					// skip malformed cold record
				}
			}
			if (!missionId) {
				if (candidateIds.length === 1) {
					missionId = candidateIds[0];
				} else if (!verifiedSid && Object.keys(allCold).length === 1) {
					missionId = Object.keys(allCold)[0];
				}
			}
			if (!missionId) {
				return { handled: true, error: `Missing --mission <id> for headless "${action}".` };
			}
		}

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
		const allowsMissingOrch = action === 'whiteboard.list'
			|| action === 'whiteboard.read'
			|| action === 'whiteboard.create'
			|| action === 'whiteboard.write'
			|| action === 'mission.task.complete'
			|| action === 'mission.task.status';
		if (!orch && !allowsMissingOrch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const effectiveOrgConfig = await this.loadCachedOrgConfig();
		const orchestrationText = typeof record.orchestrationText === 'string' ? record.orchestrationText : '';
		const parsedGraph = parseOrchestrationGraph(orchestrationText);
		const resolveHeadlessCaller = () => {
			const isVerified = params._verifiedCaller === true;
			const callerStr = typeof params.caller === 'string' ? params.caller.trim().toLowerCase() : '';
			const verifiedSessionId = isVerified && typeof params._callerSessionId === 'string' ? params._callerSessionId.trim() : '';
			const fallbackSessionId = !isVerified && typeof params.callerSessionId === 'string' ? params.callerSessionId.trim() : '';
			const callerSessionId = verifiedSessionId || fallbackSessionId;
			const explicitNodeId = !isVerified && typeof params.callerNodeId === 'string' ? params.callerNodeId.trim() : '';
			if (!isVerified && !callerStr && !callerSessionId && !explicitNodeId) {
				return { isHumanUser: true, isSecretary: false, callerSessionId: undefined as string | undefined, callerTier: -1 as number | undefined, callerNodeId: undefined as string | undefined };
			}
			if (callerStr === 'secretary') {
				return { isHumanUser: false, isSecretary: true, callerSessionId: '__secretary__', callerTier: 0 as number | undefined, callerNodeId: undefined as string | undefined };
			}
			let callerNodeId = explicitNodeId || undefined;
			if (!callerNodeId && callerSessionId && orch?.nodeAgentIds) {
				for (const [nid, aid] of Object.entries(orch.nodeAgentIds)) {
					if (aid === callerSessionId) {
						callerNodeId = nid;
						break;
					}
				}
			}
			const matchedRank = effectiveOrgConfig.ranks.find(
				r => r.id.toLowerCase() === callerStr || r.name.toLowerCase() === callerStr,
			);
			const staffNode = callerNodeId ? parsedGraph.nodes.find(n => n.id === callerNodeId && n.kind === 'staff') : undefined;
			return {
				isHumanUser: false,
				isSecretary: false,
				callerSessionId: callerSessionId || undefined,
				callerTier: matchedRank?.tier ?? staffNode?.tier,
				callerNodeId,
			};
		};
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

		if (action === 'whiteboard.list') {
			const caller = resolveHeadlessCaller();
			const deptFilter = typeof params.department === 'string' && params.department.trim()
				? params.department.trim().toLowerCase()
				: undefined;
			const allWbs = Object.values(buildMergedWhiteboards())
				.filter(wb => canCallerAccessWhiteboard(parsedGraph, wb, effectiveOrgConfig, caller))
				.filter(wb => !deptFilter || wb.department.trim().toLowerCase() === deptFilter);
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					whiteboards: allWbs.map(wb => ({
						whiteboardId: wb.id,
						title: wb.title,
						department: wb.department,
						version: wb.version,
						contentLength: wb.content.length,
						updatedAt: wb.updatedAt,
						updatedByLabel: wb.updatedByLabel,
					})),
				},
			};
		}

		if (action === 'whiteboard.read') {
			const id = String(params.id ?? params.whiteboardId ?? params.whiteboard ?? '').trim();
			if (!id) {
				return { handled: true, error: 'Whiteboard ID is required for whiteboard.read.' };
			}
			const wb = buildMergedWhiteboards()[id];
			if (!wb) {
				return { handled: true, error: `Department whiteboard "${id}" not found.` };
			}
			const caller = resolveHeadlessCaller();
			if (!canCallerAccessWhiteboard(parsedGraph, wb, effectiveOrgConfig, caller)) {
				return {
					handled: true,
					error: `FORBIDDEN: caller does not belong to department "${wb.department}" and is not connected to whiteboard "${wb.id}".`,
				};
			}
			return { handled: true, result: { headless: true, ok: true, missionId, whiteboard: wb } };
		}

		if (action === 'orchestration.status') {
			if (!orch) {
				return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
			}
			const tokens = Object.values(orch.tokens ?? {});
			const activeTokens = tokens.filter(t => t.status === 'active');
			const blockedTokens = tokens.filter(t => t.status === 'blocked');
			const waitingJoinTokens = tokens.filter(t => t.status === 'waiting_join');
			const daemon = (await this.getOrchestrationDaemonState(missionId))[missionId];
			return {
				handled: true,
				result: {
					headless: true,
					missionId,
					status: orch.status ?? 'running',
					...(orch.pausedAt ? { pausedAt: orch.pausedAt } : {}),
					...(orch.pausedReason ? { pausedReason: orch.pausedReason } : {}),
					activeCount: activeTokens.length,
					blockedCount: blockedTokens.length,
					waitingJoinCount: waitingJoinTokens.length,
					activeTokens,
					blockedTokens,
					waitingJoinTokens,
					joinBarriers: orch.joinBarriers ?? {},
					archivedTokenCount: orch.archivedTokenCount ?? 0,
					archivedTraceCount: orch.archivedTraceCount ?? 0,
					...(daemon ? { daemon } : {}),
					updatedAt: orch.updatedAt,
				},
			};
		}

		if (action === 'token.read') {
			if (!orch) {
				return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
			}
			const rawPtrs = Array.isArray(params.ptrs)
				? params.ptrs.map(p => String(p))
				: (typeof params.ptr === 'string' ? params.ptr.split(',') : []);
			const whiteboards = buildMergedWhiteboards();
			const caller = resolveHeadlessCaller();
			const items: unknown[] = [];
			for (const rawPtr of rawPtrs) {
				const ptr = rawPtr.trim();
				if (!ptr) { continue; }
				const hotBlob = orch.payloadStore?.[ptr];
				if (hotBlob) {
					items.push({ ptr: hotBlob.ptr, ok: true, kind: hotBlob.kind, title: hotBlob.title, version: 1, hop: hotBlob.hop, sizeChars: hotBlob.sizeChars, content: hotBlob.content });
					continue;
				}
				const coldBlobRaw = await this.readOrchestrationBlob(missionId, ptr);
				if (coldBlobRaw) {
					try {
						const parsedBlob = JSON.parse(coldBlobRaw) as { ptr?: string; kind?: string; title?: string; hop?: number; sizeChars?: number; content?: string };
						items.push({ ptr: parsedBlob.ptr ?? ptr, ok: true, kind: parsedBlob.kind, title: parsedBlob.title, version: 1, hop: parsedBlob.hop, sizeChars: parsedBlob.sizeChars, content: parsedBlob.content, coldBlob: true });
						continue;
					} catch {
						// fall through
					}
				}
				const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
				const wb = whiteboards[wbId];
				if (wb) {
					if (!canCallerAccessWhiteboard(parsedGraph, wb, effectiveOrgConfig, caller)) {
						items.push({ ptr, ok: false, kind: 'whiteboard', error: `FORBIDDEN: caller cannot read whiteboard "${wb.id}" (Department: "${wb.department}").` });
						continue;
					}
					items.push({ ptr: `wb:${wb.id}`, ok: true, kind: 'whiteboard', title: wb.title, version: wb.version, department: wb.department, sizeChars: wb.content.length, content: wb.content });
					continue;
				}
				const tr = orch.traces?.[ptr];
				if (tr) {
					items.push({ ptr: tr.ptr, ok: true, kind: 'trace', title: `${tr.event} @ ${tr.nodeId}`, version: 1, content: tr.summary ?? '' });
					continue;
				}
				items.push({ ptr, ok: false, error: ptr.startsWith('wb:') ? `Whiteboard pointer "${ptr}" not found (removed or does not exist).` : `Pointer "${ptr}" not found in hot or cold storage.` });
			}
			return { handled: true, result: { headless: true, missionId, items } };
		}

		if (action === 'token.history') {
			if (!orch) {
				return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
			}
			const tokenId = typeof params.tokenId === 'string' ? params.tokenId.trim() : '';
			const tok = tokenId ? orch.tokens?.[tokenId] : undefined;
			if (tok) {
				return {
					handled: true,
					result: {
						headless: true,
						ok: true,
						tokenId: tok.id,
						waveId: tok.waveId,
						nodeId: tok.nodeId,
						status: tok.status,
						hopLog: tok.hopLog ?? [],
						contextRefs: tok.contextRefs ?? [],
					},
				};
			}
			// Search cold JSONL archive for archived terminal token
			const archivedLines = await this.readOrchestrationArchive(missionId);
			for (let i = archivedLines.length - 1; i >= 0; i--) {
				try {
					const entry = JSON.parse(archivedLines[i]) as { kind?: string; token?: { id?: string; waveId?: string; nodeId?: string; status?: string; hopLog?: unknown[]; contextRefs?: unknown[] } };
					if (entry.kind === 'token' && entry.token?.id === tokenId) {
						return {
							handled: true,
							result: {
								headless: true,
								archived: true,
								ok: true,
								tokenId: entry.token.id,
								waveId: entry.token.waveId,
								nodeId: entry.token.nodeId,
								status: entry.token.status,
								hopLog: entry.token.hopLog ?? [],
								contextRefs: entry.token.contextRefs ?? [],
							},
						};
					}
				} catch {
					// skip malformed line
				}
			}
			return { handled: true, error: `Orchestration token "${tokenId}" not found.` };
		}

		const syncHeadlessWatchdog = (nextOrch: IOrchestrationRuntimeState) => {
			const liveTokens = Object.values(nextOrch.tokens ?? {}).filter(t => t.status === 'active' || t.status === 'blocked');
			if (nextOrch.status === 'paused' || nextOrch.status === 'aborted' || liveTokens.length === 0) {
				this.watchdog.removeMission(missionId);
				return;
			}
			this.watchdog.syncMission({
				missionId,
				status: 'running',
				silenceTimeoutMinutes: nextOrch.silenceReminderMinutes || ORCHESTRATION_SILENCE_REMINDER_MINUTES,
				tokens: liveTokens.map(t => ({
					tokenId: t.id,
					nodeId: t.nodeId,
					holderAgentId: t.holderAgentId,
					status: t.status === 'blocked' ? 'blocked' : 'active',
					lastActivityAt: t.lastActivityAt,
					lastNudgeAt: t.lastNudgeAt,
					...(t.blocked ? { blocked: t.blocked } : {}),
				})),
				triggers: [],
			});
		};

		const persistHeadlessOrchState = async (
			nextOrchBase: IOrchestrationRuntimeState,
			emittedEffects: readonly OrchestrationEngineEffect[],
			nowTs: number,
		): Promise<IOrchestrationRuntimeState> => {
			const existingPending = nextOrchBase.pendingHeadlessEffects ?? [];
			const nextOrch: IOrchestrationRuntimeState = emittedEffects.length > 0
				? { ...nextOrchBase, pendingHeadlessEffects: [...existingPending, ...emittedEffects] }
				: nextOrchBase;
			record.orchestrationRuntime = nextOrch;
			const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
			if (mermaidText.trim()) {
				const taskGraph = parseMissionMermaidDag(mermaidText);
				if (!taskGraph.error && taskGraph.nodes.length > 0) {
					const synced = syncMissionTaskStatusesFromOrchestration(
						record.taskStatuses as Readonly<Record<string, import('../common/adeOrchestrationEngine.js').IMissionTaskStatusRecord>> | undefined,
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
			await this.saveMissionRecord(missionId, JSON.stringify(record), nowTs, 'headless-daemon');
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
			syncHeadlessWatchdog(nextOrch);
			return nextOrch;
		};

		if (action === 'whiteboard.create' || action === 'whiteboard.write') {
			const caller = resolveHeadlessCaller();
			const wbId = String(params.id ?? params.whiteboardId ?? params.whiteboard ?? '').trim();
			if (!wbId) {
				return { handled: true, error: 'Whiteboard ID is required for headless whiteboard write.' };
			}
			const existingWbs = buildMergedWhiteboards();
			const existing = existingWbs[wbId];
			if (existing && !canCallerAccessWhiteboard(parsedGraph, existing, effectiveOrgConfig, caller)) {
				return { handled: true, error: `FORBIDDEN: caller cannot write to department "${existing.department}" whiteboard "${existing.id}".` };
			}
			const now = Date.now();
			const rawExpected = params.expectedVersion ?? params.ifVersion;
			const expectedVersion = rawExpected !== undefined && rawExpected !== null && String(rawExpected).trim() !== ''
				? Number(rawExpected)
				: undefined;
			const callerNode = caller.callerNodeId ? parsedGraph.nodes.find(n => n.id === caller.callerNodeId && n.kind === 'staff') : undefined;
			const mutated = mutateDepartmentWhiteboard(existingWbs, {
				id: wbId,
				title: typeof params.title === 'string' ? params.title : undefined,
				department: typeof params.department === 'string' ? params.department : (existing?.department ?? callerNode?.department ?? 'General'),
				content: typeof params.content === 'string' ? params.content : undefined,
				appendContent: typeof params.appendContent === 'string' ? params.appendContent : undefined,
				mode: action === 'whiteboard.create' ? 'create' : 'write',
				...(expectedVersion !== undefined && Number.isInteger(expectedVersion) ? { expectedVersion } : {}),
				updatedBy: caller.callerSessionId ?? (caller.isHumanUser ? 'human' : undefined),
				now,
			});
			if (!mutated.ok || !mutated.whiteboard || !mutated.whiteboards) {
				return { handled: true, error: mutated.error ?? 'Failed to write Department Whiteboard.' };
			}
			record.whiteboards = mutated.whiteboards;
			record.orchestrationText = upsertOrchestrationWhiteboardInCode(orchestrationText, {
				id: mutated.whiteboard.id,
				title: mutated.whiteboard.title,
				department: mutated.whiteboard.department,
				content: mutated.whiteboard.content,
				version: mutated.whiteboard.version,
			});
			record.updatedAt = now;
			await this.saveMissionRecord(missionId, JSON.stringify(record), now, 'headless-daemon');
			return {
				handled: true,
				result: {
					headless: true,
					ok: true,
					missionId,
					whiteboard: {
						whiteboardId: mutated.whiteboard.id,
						title: mutated.whiteboard.title,
						department: mutated.whiteboard.department,
						version: mutated.whiteboard.version,
						updatedAt: mutated.whiteboard.updatedAt,
					},
				},
			};
		}

		if (action === 'mission.task.complete' || action === 'mission.task.status') {
			const caller = resolveHeadlessCaller();
			const nodeId = String(params.node ?? params.nodeId ?? '').trim();
			if (!nodeId) {
				return { handled: true, error: 'Task node ID (--node) is required.' };
			}
			const rawStatus = action === 'mission.task.complete' ? 'completed' : String(params.status ?? '').trim().toLowerCase();
			if (!['pending', 'in_progress', 'completed', 'blocked'].includes(rawStatus)) {
				return { handled: true, error: `Invalid task status "${rawStatus}".` };
			}
			const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
			const taskGraph = parseMissionMermaidDag(mermaidText);
			const now = Date.now();
			const res = updateMissionTaskNodeStatus(
				record.taskStatuses as Readonly<Record<string, import('../common/adeOrchestrationEngine.js').IMissionTaskStatusRecord>> | undefined,
				taskGraph,
				effectiveOrgConfig,
				{
					nodeId,
					status: rawStatus as MissionTaskStatus,
					caller: {
						isHumanUser: caller.isHumanUser,
						callerTier: caller.callerTier,
						callerSessionId: caller.callerSessionId,
						callerNodeId: caller.callerNodeId,
					},
					orchGraph: !parsedGraph.error ? parsedGraph : undefined,
					force: params.force === true,
					note: typeof params.note === 'string' ? params.note : undefined,
					now,
				},
			);
			if (!res.ok) {
				return { handled: true, error: res.error ?? `Failed to update task "${nodeId}" status.` };
			}
			record.taskStatuses = res.taskStatuses;
			record.updatedAt = now;
			await this.saveMissionRecord(missionId, JSON.stringify(record), now, 'headless-daemon');
			return {
				handled: true,
				result: { headless: true, ok: true, missionId, nodeId, status: res.taskStatuses[nodeId] },
			};
		}

		if (action === 'token.current') {
			if (!orch) {
				return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
			}
			const caller = resolveHeadlessCaller();
			const allLive = Object.values(orch.tokens ?? {}).filter(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join');
			const filtered = (caller.isHumanUser || caller.isSecretary)
				? allLive
				: allLive.filter(t => (caller.callerNodeId && t.nodeId === caller.callerNodeId) || (caller.callerSessionId && (t.holderAgentId === caller.callerSessionId || orch.nodeAgentIds?.[t.nodeId] === caller.callerSessionId)));
			return { handled: true, result: { headless: true, missionId, tokens: filtered } };
		}

		if (action === 'token.return' || action === 'token.handoff' || action === 'token.complete' || action === 'token.block' || action === 'token.fail' || action === 'token.mint' || action === 'token.split') {
			if (!orch) {
				return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
			}
			const caller = resolveHeadlessCaller();
			const callerAgentId = caller.isHumanUser ? undefined : caller.callerSessionId;
			const whiteboards = buildMergedWhiteboards();
			const mermaidText = typeof record.mermaidText === 'string' ? record.mermaidText : '';
			const taskGraph = mermaidText.trim() ? parseMissionMermaidDag(mermaidText) : undefined;
			const taskStatuses = record.taskStatuses as Readonly<Record<string, import('../common/adeOrchestrationEngine.js').IMissionTaskStatusRecord>> | undefined;
			const now = Date.now();
			const parseStrList = (raw: unknown): readonly string[] | undefined => Array.isArray(raw)
				? raw.map(v => String(v).trim()).filter(Boolean)
				: (typeof raw === 'string' && raw.trim() ? raw.split(',').map(s => s.trim()).filter(Boolean) : undefined);
			const parseBlobList = (raw: unknown): readonly IOrchestrationContextBlobInput[] | undefined => {
				if (!Array.isArray(raw)) { return undefined; }
				const out: IOrchestrationContextBlobInput[] = [];
				for (const item of raw) {
					if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
						out.push({ title: typeof (item as { title?: unknown }).title === 'string' ? (item as { title: string }).title : '', content: (item as { content: string }).content });
					}
				}
				return out.length > 0 ? out : undefined;
			};

			if (action === 'token.return') {
				const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
				const summary = String(params.summary ?? params.message ?? '').trim();
				const res = returnOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
					tokenId,
					toNodeId: typeof (params.toNodeId ?? params.to ?? params.target) === 'string' ? String(params.toNodeId ?? params.to ?? params.target).trim() : undefined,
					summary,
					detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
					whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
					artifacts: parseBlobList(params.artifacts),
					decisions: parseBlobList(params.decisions),
					refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref),
					modifiedFiles: parseStrList(params.modifiedFiles ?? params.files),
					callerAgentId,
					now,
				});
				if (!res.ok) { return { handled: true, error: res.error ?? `Failed to return token ${tokenId}.` }; }
				await persistHeadlessOrchState(res.state, res.effects, now);
				return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
			}

			if (action === 'token.handoff') {
				const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
				const summary = String(params.summary ?? params.message ?? '').trim();
				const toNodeIds = parseStrList(params.toNodeIds ?? params.to ?? params.target ?? params.targets) ?? [];
				const res = handoffOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
					tokenId,
					toNodeIds,
					summary,
					detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
					taskNodeId: typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' ? String(params.taskNodeId ?? params.task ?? params.taskNode).trim() : undefined,
					taskNodeIds: parseStrList(params.taskNodeIds ?? params.tasks),
					...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
					whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
					artifacts: parseBlobList(params.artifacts),
					decisions: parseBlobList(params.decisions),
					refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref),
					modifiedFiles: parseStrList(params.modifiedFiles ?? params.files),
					callerAgentId,
					now,
				});
				if (!res.ok) { return { handled: true, error: res.error ?? `Failed to hand off token ${tokenId}.` }; }
				await persistHeadlessOrchState(res.state, res.effects, now);
				return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
			}

			if (action === 'token.complete') {
				const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
				const summary = String(params.summary ?? params.message ?? '').trim();
				const res = completeOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
					tokenId,
					summary,
					detail: typeof params.detail === 'string' && params.detail.trim() ? params.detail : undefined,
					toNodeIds: parseStrList(params.toNodeIds ?? params.to ?? params.target),
					taskNodeId: typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' ? String(params.taskNodeId ?? params.task ?? params.taskNode).trim() : undefined,
					taskNodeIds: parseStrList(params.taskNodeIds ?? params.tasks),
					...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
					whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard),
					artifacts: parseBlobList(params.artifacts),
					decisions: parseBlobList(params.decisions),
					refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref),
					modifiedFiles: parseStrList(params.modifiedFiles ?? params.files),
					finish: params.finish === true,
					callerAgentId,
					now,
				});
				if (!res.ok) { return { handled: true, error: res.error ?? `Failed to complete token ${tokenId}.` }; }
				await persistHeadlessOrchState(res.state, res.effects, now);
				return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
			}

			if (action === 'token.block') {
				const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
				const maxDurationMs = parseDurationMs((params.maxDuration ?? params.max ?? params.duration) as string | number);
				if (!maxDurationMs) {
					return { handled: true, error: 'Valid --duration (e.g. "30m", "2h") is required for token.block.' };
				}
				const res = blockOrchestrationToken(orch, {
					tokenId,
					reason: String(params.reason ?? params.message ?? '').trim() || 'Long-running task in progress',
					maxDurationMs,
					watchPid: typeof params.watchPid === 'number' ? params.watchPid : undefined,
					watchFile: typeof (params.watchFile ?? params.file) === 'string' ? String(params.watchFile ?? params.file).trim() : undefined,
					hostAlias: typeof (params.host ?? params.hostAlias) === 'string' ? String(params.host ?? params.hostAlias).trim() : undefined,
					callerAgentId,
					now,
				});
				if (!res.ok) { return { handled: true, error: res.error ?? `Failed to block token ${tokenId}.` }; }
				await persistHeadlessOrchState(res.state, res.effects, now);
				return { handled: true, result: { headless: true, ok: true, missionId, token: res.state.tokens[tokenId] } };
			}

			if (action === 'token.fail') {
				const tokenId = String(params.tokenId ?? params.token ?? params.id ?? '').trim();
				const reason = String(params.reason ?? params.message ?? '').trim();
				const res = failOrchestrationToken(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
					tokenId,
					reason,
					callerAgentId,
					now,
				});
				if (!res.ok) { return { handled: true, error: res.error ?? `Failed to report failure on token ${tokenId}.` }; }
				await persistHeadlessOrchState(res.state, res.effects, now);
				return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
			}

			// token.mint / token.split
			const rawParent = String(params.parentTokenId ?? params.tokenId ?? params.token ?? '').trim();
			const parentTokenId = (!rawParent || rawParent.toLowerCase() === 'root' || rawParent.toLowerCase() === 'new') ? undefined : rawParent;
			let rawBranches: unknown = params.branches;
			if (!rawBranches && typeof params.branchesJson === 'string' && params.branchesJson.trim()) {
				try { rawBranches = JSON.parse(params.branchesJson); } catch (err) {
					return { handled: true, error: `Invalid --branches-json payload: ${err instanceof Error ? err.message : String(err)}` };
				}
			}
			const branches: IOrchestrationMintBranch[] = [];
			if (Array.isArray(rawBranches) && rawBranches.length > 0) {
				for (const item of rawBranches) {
					if (!item || typeof item !== 'object') { continue; }
					const b = item as Record<string, unknown>;
					branches.push({
						toNodeId: String(b.toNodeId ?? b.to ?? b.target ?? '').trim(),
						summary: String(b.summary ?? b.message ?? '').trim(),
						...(typeof b.detail === 'string' && b.detail.trim() ? { detail: b.detail } : {}),
						...(typeof (b.taskNodeId ?? b.task) === 'string' && String(b.taskNodeId ?? b.task).trim() ? { taskNodeId: String(b.taskNodeId ?? b.task).trim() } : {}),
						...(parseStrList(b.taskNodeIds ?? b.tasks) ? { taskNodeIds: parseStrList(b.taskNodeIds ?? b.tasks) } : {}),
						...(parseStrList(b.whiteboardIds ?? b.whiteboards ?? b.whiteboard) ? { whiteboardIds: parseStrList(b.whiteboardIds ?? b.whiteboards ?? b.whiteboard) } : {}),
						...(parseBlobList(b.artifacts) ? { artifacts: parseBlobList(b.artifacts) } : {}),
						...(parseBlobList(b.decisions) ? { decisions: parseBlobList(b.decisions) } : {}),
						...(parseStrList(b.refPtrs ?? b.refs ?? b.ref) ? { refPtrs: parseStrList(b.refPtrs ?? b.refs ?? b.ref) } : {}),
					});
				}
			} else {
				const targets = parseStrList(params.toNodeIds ?? params.to ?? params.target) ?? [];
				const summary = String(params.summary ?? params.message ?? '').trim();
				for (const toNodeId of targets) {
					branches.push({
						toNodeId,
						summary,
						...(typeof params.detail === 'string' && params.detail.trim() ? { detail: params.detail } : {}),
						...(typeof (params.taskNodeId ?? params.task ?? params.taskNode) === 'string' && String(params.taskNodeId ?? params.task ?? params.taskNode).trim() ? { taskNodeId: String(params.taskNodeId ?? params.task ?? params.taskNode).trim() } : {}),
						...(parseStrList(params.taskNodeIds ?? params.tasks) ? { taskNodeIds: parseStrList(params.taskNodeIds ?? params.tasks) } : {}),
						...(parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard) ? { whiteboardIds: parseStrList(params.whiteboardIds ?? params.whiteboards ?? params.whiteboard) } : {}),
						...(parseBlobList(params.artifacts) ? { artifacts: parseBlobList(params.artifacts) } : {}),
						...(parseBlobList(params.decisions) ? { decisions: parseBlobList(params.decisions) } : {}),
						...(parseStrList(params.refPtrs ?? params.refs ?? params.ref) ? { refPtrs: parseStrList(params.refPtrs ?? params.refs ?? params.ref) } : {}),
					});
				}
			}
			const waitJoin = params.waitJoin !== undefined ? params.waitJoin === true : (action === 'token.split' && params.noWaitJoin !== true);
			const res = mintOrchestrationTokens(orch, parsedGraph, whiteboards, effectiveOrgConfig, {
				...(parentTokenId ? { parentTokenId } : {}),
				...(typeof (params.fromNodeId ?? params.from) === 'string' && String(params.fromNodeId ?? params.from).trim() ? { fromNodeId: String(params.fromNodeId ?? params.from).trim() } : {}),
				branches,
				waitJoin,
				joinMode: params.joinMode === 'any' ? 'any' : 'all',
				...(taskGraph && !taskGraph.error && taskGraph.nodes.length > 0 ? { taskGraph, taskStatuses } : {}),
				callerAgentId,
				now,
			});
			if (!res.ok) { return { handled: true, error: res.error ?? 'Failed to mint Orchestration tokens.' }; }
			await persistHeadlessOrchState(res.state, res.effects, now);
			return { handled: true, result: { headless: true, ok: true, missionId, queuedEffects: res.effects.length, ...(res.data as Record<string, unknown> ?? {}) } };
		}

		// Strictly authorize pause / resume / abort in headless daemon mode!
		if (!orch) {
			return { handled: true, error: `Mission "${missionId}" has no active Orchestration runtime state.` };
		}
		const caller = resolveHeadlessCaller();
		const ownerSessionId = typeof record.ownerSessionId === 'string' ? record.ownerSessionId.trim() : '';
		const highestTier = effectiveOrgConfig.ranks.length > 0 ? Math.min(...effectiveOrgConfig.ranks.map(r => r.tier)) : 1;
		const isAuthorizedForRunControl = Boolean(
			caller.isHumanUser
			|| caller.isSecretary
			|| (ownerSessionId && caller.callerSessionId === ownerSessionId)
			|| (caller.callerTier !== undefined && caller.callerTier <= highestTier),
		);
		if (!isAuthorizedForRunControl) {
			return {
				handled: true,
				error: `FORBIDDEN: only Human User (L-1), Secretary (L0), the Mission owner, or highest-rank role (L${highestTier}) may invoke "${action}".`,
			};
		}

		const now = Date.now();
		const reason = typeof params.reason === 'string' ? params.reason : undefined;
		const transition = action === 'orchestration.pause'
			? pauseOrchestration(orch, { reason, now })
			: action === 'orchestration.resume'
				? resumeOrchestration(orch, { now })
				: abortOrchestrationTokens(orch, { reason, now });

		await persistHeadlessOrchState(transition.state, [], now);
		return {
			handled: true,
			result: {
				headless: true,
				ok: transition.ok,
				missionId,
				status: transition.state.status,
				...(transition.data ? transition.data as Record<string, unknown> : {}),
			},
		};
	}

	private get orgConfigCachePath(): string {
		return path.join(this.baseDir, 'org-config.cache.json');
	}

	private async loadCachedOrgConfig(): Promise<IAdeOrganizationConfig> {
		if (this.orgConfigCacheLoaded) {
			return this.cachedOrgConfig;
		}
		this.orgConfigCacheLoaded = true;
		try {
			const raw = await fs.promises.readFile(this.orgConfigCachePath, 'utf8');
			const parsed = JSON.parse(raw) as IAdeOrganizationConfig;
			if (parsed && Array.isArray(parsed.ranks) && parsed.ranks.length > 0) {
				this.cachedOrgConfig = parsed;
			}
		} catch {
			// Fall back to default organization config until first syncApiDocs
		}
		return this.cachedOrgConfig;
	}

	async syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths> {
		this.cachedOrgConfig = config;
		this.orgConfigCacheLoaded = true;
		void (async () => {
			try {
				await fs.promises.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
				const tmp = `${this.orgConfigCachePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
				await fs.promises.writeFile(tmp, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
				await fs.promises.rename(tmp, this.orgConfigCachePath);
			} catch {
				// Non-fatal cache write
			}
		})();
		return syncAdeApiDocsToDisk(this.baseDir, config);
	}

	async getApiDocsPaths(rankCount: number): Promise<IAdeDocsPaths> {
		return buildAdeDocsPaths(this.baseDir, rankCount);
	}

	async readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult> {
		const normalized = (target || '').trim();
		const effectiveConfig = config ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const paths = buildAdeDocsPaths(this.baseDir, effectiveConfig.ranks.length);

		const parsedTarget = normalizeAdeDocTargetKey(normalized);
		let filePath: string | undefined;
		let canonicalTarget = parsedTarget?.canonicalTarget ?? normalized;

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

		const expectedFingerprint = [...effectiveConfig.ranks]
			.sort((a, b) => a.tier - b.tier)
			.map(r => `${r.tier}:${r.id}:${r.pureExecution ? '1' : '0'}:${r.canHaveSubordinates ? '1' : '0'}:${r.allowedApis.join(',')}`)
			.join('|');

		let docsUpToDate = false;
		if (paths.manifestFile) {
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

		// Docs missing, stale revision, or rank config drifted: sync single-copy docs to disk before returning.
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

	async syncMissionWatchdog(snapshot: IAdeMissionWatchdogSnapshot): Promise<void> {
		this.watchdog.syncMission(snapshot);
	}

	async removeMissionWatchdog(missionId: string): Promise<void> {
		this.watchdog.removeMission(missionId);
	}

	getMissionWatchdogOwner(missionId: string): string | undefined {
		return this.watchdog.getMissionOwnerWindowCtx(missionId);
	}

	async canRecoverMission(_missionId: string): Promise<boolean> {
		return true;
	}

	async notifySystemResume(): Promise<void> {
		this._onDidSystemResume.fire(Date.now());
		this.watchdog.notifySystemResume();
	}

	async runDeterministicCheck(request: IAdeDeterministicCheckRequest): Promise<IAdeDeterministicCheckResponse> {
		const startedAt = Date.now();
		const hostAlias = request.hostAlias?.trim() || 'local';
		const isRemote = hostAlias !== 'local';
		const expectedExitCode = Number.isInteger(request.expectExitCode) ? Number(request.expectExitCode) : 0;
		const timeoutMs = Math.max(1_000, Math.min(300_000, Math.round(request.timeoutMs ?? 120_000)));
		const command = request.command?.trim() || undefined;
		const cwd = request.cwd?.trim() || undefined;
		const expectFiles = (request.expectFiles ?? []).map(f => f.trim()).filter(Boolean);
		const expectOutputMatch = request.expectOutputMatch?.trim() || undefined;

		let exitCode = 0;
		let timedOut = false;
		let rawOutput = '';
		let execError: string | undefined;

		if (command) {
			if (isRemote) {
				if (!this.remoteProbe?.remoteExecCommand) {
					return {
						checkId: request.checkId,
						name: request.name,
						command,
						hostAlias,
						cwd,
						passed: false,
						exitCode: -1,
						expectedExitCode,
						durationMs: Math.max(0, Date.now() - startedAt),
						outputTail: '',
						error: `Remote deterministic check execution is unavailable for SSH host "${hostAlias}".`,
					};
				}
				const remoteRes = await this.remoteProbe.remoteExecCommand(hostAlias, {
					command,
					cwd,
					timeoutMs,
					maxOutputChars: MAX_CHECK_TAIL_CHARS,
				});
				exitCode = remoteRes.exitCode;
				rawOutput = remoteRes.outputTail;
				timedOut = remoteRes.timedOut;
				execError = remoteRes.error;
			} else {
				const localRes = await runLocalDeterministicShell(command, cwd, timeoutMs);
				exitCode = localRes.exitCode;
				rawOutput = localRes.output;
				timedOut = localRes.timedOut;
				execError = localRes.error;
			}
		}

		const exitOk = !timedOut && !execError && (!command || exitCode === expectedExitCode);
		const outputMatchFailed = Boolean(command && expectOutputMatch && !matchesExpectedOutput(rawOutput, expectOutputMatch));

		const missingFiles: string[] = [];
		if (expectFiles.length > 0 && exitOk && !outputMatchFailed) {
			for (const relOrAbs of expectFiles) {
				const resolvedTarget = isRemote
					? (relOrAbs.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relOrAbs)
						? relOrAbs
						: (cwd ? path.posix.join(cwd, relOrAbs) : relOrAbs))
					: (path.isAbsolute(relOrAbs) ? relOrAbs : (cwd ? path.resolve(cwd, relOrAbs) : path.resolve(relOrAbs)));
				let existsOk = false;
				if (isRemote) {
					try {
						if (this.remoteProbe?.remoteStat) {
							const st = await this.remoteProbe.remoteStat(hostAlias, resolvedTarget);
							existsOk = st.type === 'directory' || st.size > 0;
						} else if (this.remoteProbe) {
							const mtime = await this.remoteProbe.remoteFileStatMtime(hostAlias, resolvedTarget);
							existsOk = mtime !== undefined;
						}
					} catch {
						existsOk = false;
					}
				} else {
					try {
						const st = await fs.promises.stat(resolvedTarget);
						existsOk = st.isDirectory() || st.size > 0;
					} catch {
						existsOk = false;
					}
				}
				if (!existsOk) {
					missingFiles.push(relOrAbs);
				}
			}
		}

		const passed = exitOk && !outputMatchFailed && missingFiles.length === 0;
		const errorParts: string[] = [];
		if (execError) {
			errorParts.push(execError);
		} else if (command && exitCode !== expectedExitCode) {
			errorParts.push(`Exit code ${exitCode} (expected ${expectedExitCode})`);
		}
		if (outputMatchFailed) {
			errorParts.push(`Output did not match required pattern "${expectOutputMatch}"`);
		}
		if (missingFiles.length > 0) {
			errorParts.push(`Missing or empty required artifact(s): ${missingFiles.join(', ')}`);
		}

		return {
			checkId: request.checkId,
			...(request.name ? { name: request.name } : {}),
			...(command ? { command } : {}),
			hostAlias,
			...(cwd ? { cwd } : {}),
			passed,
			exitCode,
			expectedExitCode,
			...(timedOut ? { timedOut: true } : {}),
			durationMs: Math.max(0, Date.now() - startedAt),
			...(missingFiles.length > 0 ? { missingFiles } : {}),
			...(outputMatchFailed ? { outputMatchFailed: true } : {}),
			outputTail: formatBoundedOutputTail(rawOutput),
			...(errorParts.length > 0 ? { error: errorParts.join('; ') } : {}),
		};
	}
}
