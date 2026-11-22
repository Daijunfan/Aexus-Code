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
import { buildAdeDocsPaths, IAdeDocsPaths } from '../common/adeDocsCatalog.js';
import {
	ADE_INBOX_FILE_NAME,
	encodeAdeMissionStorageFileName,
	IAdeApiDocReadResult,
	IAdeDeterministicCheckRequest,
	IAdeDeterministicCheckResponse,
	IAdeEngineeringBackendService,
	IAdeInboxItem,
	IAdeInboxMutation,
	IAdeMissionColdChangeEvent,
	IAdeMissionWatchdogSnapshot,
	IAdeSourceTriggerFireEvent,
	IAdeWatchdogWakeupEvent,
} from '../common/adeEngineering.js';
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
			this._onDidMissionRecordChange.fire({
				missionId: trimmed,
				updatedAt: Date.now(),
				deleted: true,
				...(writerId ? { writerId } : {}),
			});
		});
	}

	async syncApiDocs(config: IAdeOrganizationConfig): Promise<IAdeDocsPaths> {
		return syncAdeApiDocsToDisk(this.baseDir, config);
	}

	async getApiDocsPaths(rankCount: number): Promise<IAdeDocsPaths> {
		return buildAdeDocsPaths(this.baseDir, rankCount);
	}

	async readApiDoc(target: string, config?: IAdeOrganizationConfig): Promise<IAdeApiDocReadResult> {
		const normalized = (target || '').trim();
		const effectiveConfig = config ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const paths = buildAdeDocsPaths(this.baseDir, effectiveConfig.ranks.length);

		let filePath: string | undefined;
		let canonicalTarget = normalized;

		if (/^common$/i.test(normalized)) {
			filePath = paths.commonDoc;
			canonicalTarget = 'common';
		} else if (/^mission$/i.test(normalized)) {
			filePath = paths.missionDoc;
			canonicalTarget = 'mission';
		} else if (/^manifest$/i.test(normalized)) {
			filePath = paths.manifestFile;
			canonicalTarget = 'manifest';
		} else {
			const rankMatch = /^L(\d+)$/i.exec(normalized);
			if (rankMatch) {
				const tier = Number(rankMatch[1]);
				canonicalTarget = `L${tier}`;
				filePath = paths.rankDocs[canonicalTarget];
			}
		}

		if (!filePath) {
			return {
				ok: false,
				target: canonicalTarget || normalized,
				revision: ADE_API_LATEST_REVISION,
				error: `Unknown API doc target "${target}". Valid targets: common, mission, manifest, L0..L${effectiveConfig.ranks.length}.`,
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
