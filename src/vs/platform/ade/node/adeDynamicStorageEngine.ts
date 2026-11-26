/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { pipeline as streamPipeline, Readable, Transform } from 'stream';
import { promisify } from 'util';

const pipeline = promisify(streamPipeline);
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { IAdeCloudHost, IAdeCloudHostBackendService } from '../common/adeCloudHosts.js';
import { ADE_CONTROL_DIR_NAME, ADE_REMOTE_STORE_DIR_NAME, stripAdeControlEnv } from '../common/adeControl.js';
import { AdeError, IAdeBlobPointer } from '../common/adeModels.js';
import { AdeSqliteStore, IAdeSqlRunner } from './adeSqliteStore.js';

interface IDataStreamHostPool {
	active: number;
	readonly waiters: Array<{ readonly resolve: () => void; readonly reject: (err: Error) => void }>;
}

export const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class SshPipeExitError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(alias: string, exitCode: number | null, stderr: string) {
		super(`SSH stream on '${alias}' exited with code ${exitCode ?? 'null'}${stderr ? `: ${stderr}` : ''}`);
		this.name = 'SshPipeExitError';
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

function isUnexpectedZeroExpectedBytes(expectedBytes: number | undefined, expectedSha256: string | undefined): boolean {
	return expectedBytes === 0 && (!expectedSha256 || expectedSha256.toLowerCase() !== EMPTY_SHA256_HEX);
}

function destroyStreamQuietly(stream: NodeJS.ReadableStream | NodeJS.WritableStream | undefined, err?: Error): void {
	if (!stream) {
		return;
	}
	const candidate = stream as { destroy?: (error?: Error) => void };
	if (typeof candidate.destroy === 'function') {
		try { candidate.destroy(err); } catch { /* ignore */ }
	}
}

function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function posixQuoteRemotePath(value: string): string {
	if (value === '~') {
		return '"$HOME"';
	}
	if (value.startsWith('~/')) {
		return `"$HOME"/${posixQuote(value.slice(2))}`;
	}
	return posixQuote(value);
}

export function sanitizeSafeFilename(rawName: string): string {
	const base = path.posix.basename(path.win32.basename(rawName || 'file.bin'))
		.replace(/[\x00-\x1f/\\]+/g, '_')
		.replace(/^\.+/, '');
	return (base || 'file.bin').slice(0, 180);
}

export interface IAdeStreamTransferVerifyInput {
	readonly exitCode: number | null;
	readonly actualBytes: number;
	readonly expectedBytes: number;
	readonly actualSha256: string;
	readonly expectedSha256: string;
}

/**
 * SSH 3-way integrity gate: returns `true` ONLY when `exitCode === 0`, byte size matches, and SHA-256 matches
 * (catches OpenSSH `exit 255` mid-stream disconnects that still emit `stdout.on('end')`).
 */
export function verifySshStreamIntegrityGate(input: IAdeStreamTransferVerifyInput): boolean {
	return (
		input.exitCode === 0
		&& Number.isInteger(input.actualBytes)
		&& input.actualBytes >= 0
		&& input.actualBytes === input.expectedBytes
		&& input.actualSha256.length === 64
		&& input.actualSha256.toLowerCase() === input.expectedSha256.toLowerCase()
	);
}

/**
 * Computes the default `storage_host` according to the 4-quadrant storage routing matrix (§6.1).
 */
export function resolveTicketDetailStorageHost(
	fromHost: string,
	toHost: string,
	crossHostDefaultStorage: string,
): string {
	const a = (fromHost || 'local').trim();
	const b = (toHost || 'local').trim();
	if (a === 'local' && b === 'local') {
		return 'local';
	}
	if (a !== 'local' && a === b) {
		return a;
	}
	return (crossHostDefaultStorage || 'local').trim() || 'local';
}

export interface IAdeStorageTransportAdapter {
	getEffectiveSshConfigPath(): Promise<string>;
	resolveHost(ipOrAlias: string): Promise<{ readonly ip: string; readonly alias: string; readonly os: 'linux' | 'macos' | 'windows'; readonly remoteHome: string }>;
	spawnSshStream?(
		alias: string,
		remoteShCommand: string,
	): Promise<{
		readonly stdin: NodeJS.WritableStream;
		readonly stdout: Readable;
		readonly waitClose: () => Promise<{ readonly exitCode: number | null; readonly stderr: string }>;
		readonly kill: () => void;
	}>;
}

export interface IAdeDynamicStorageEngineOptions {
	readonly sqliteStore: AdeSqliteStore;
	readonly cloudHostService?: IAdeCloudHostBackendService;
	readonly customTransport?: IAdeStorageTransportAdapter;
	readonly maxDataStreamsPerHost?: number;
	readonly sshExecutable?: string;
	readonly homedir?: string;
	readonly logService?: ILogService;
}

/**
 * Four-quadrant cross-host dynamic storage engine with:
 * - Separate per-host data-stream semaphore (`maxDataStreams = 2`)
 * - Lexicographical total-order dual-host lock `acquireOrderedDualHostSlots(hostA, hostB)` (zero AB-BA deadlock)
 * - SSH 3-way integrity gate (`exitCode === 0 && actualBytes === expectedBytes && actualSha256 === expectedSha256`)
 * - Synchronous in-memory `pinBlobForRead(+1)` / `unpinBlob` refcount + `catalog.db.remote_gc_tombstones` GC
 * - Sensitive path & `realpath` symlink escape guard on `ade_wb_download --dest`
 */
export class AdeDynamicStorageEngine extends Disposable {
	private readonly store: AdeSqliteStore;
	private readonly cloudHosts?: IAdeCloudHostBackendService;
	private readonly customTransport?: IAdeStorageTransportAdapter;
	private readonly maxDataStreamsPerHost: number;
	private readonly sshExec: string;
	private readonly homedir: string;
	private readonly logService?: ILogService;

	private readonly hostDataPools = new Map<string, IDataStreamHostPool>();
	private readonly blobPinCounts = new Map<string, { readonly rawHost: string; readonly rawPath: string; count: number }>();
	private readonly knownHostToCanonicalIp = new Map<string, string>();
	private readonly knownRemoteHomeByCanonicalIp = new Map<string, string>();
	private readonly inFlightHostProbes = new Map<string, Promise<string>>();
	private readonly activeSshPipes = new Set<{ readonly kill: () => void }>();
	private gcPromise: Promise<number> | undefined;
	private gcRerunRequested = false;
	private shuttingDown = false;
	private disposed = false;

	constructor(options: IAdeDynamicStorageEngineOptions) {
		super();
		this.store = options.sqliteStore;
		this.cloudHosts = options.cloudHostService;
		this.customTransport = options.customTransport;
		this.maxDataStreamsPerHost = Math.max(1, Math.min(8, options.maxDataStreamsPerHost ?? 2));
		this.sshExec = options.sshExecutable ?? 'ssh';
		this.homedir = options.homedir ?? os.homedir();
		this.logService = options.logService;
	}

	invalidateHostMappingCache(): void {
		this.knownHostToCanonicalIp.clear();
		this.knownRemoteHomeByCanonicalIp.clear();
	}

	private normalizePoolKey(host: string): string {
		const trimmed = host.trim().toLowerCase();
		return trimmed || 'local';
	}

	private recordResolvedHostInfo(
		rawQuery: string,
		info: { readonly ip: string; readonly alias: string; readonly remoteHome: string },
	): void {
		const canonicalIp = this.normalizePoolKey(info.ip);
		if (!canonicalIp || canonicalIp === 'local') {
			return;
		}
		this.knownHostToCanonicalIp.set(canonicalIp, canonicalIp);
		const aliasKey = this.normalizePoolKey(info.alias);
		if (aliasKey && aliasKey !== 'local') {
			this.knownHostToCanonicalIp.set(aliasKey, canonicalIp);
		}
		const queryKey = this.normalizePoolKey(rawQuery);
		if (queryKey && queryKey !== 'local') {
			this.knownHostToCanonicalIp.set(queryKey, canonicalIp);
		}
		const cleanHome = info.remoteHome.trim().replace(/\/+$/, '');
		if (cleanHome) {
			this.knownRemoteHomeByCanonicalIp.set(canonicalIp, cleanHome);
		}
	}

	private async resolveCanonicalPoolHostKey(host: string): Promise<string> {
		const norm = this.normalizePoolKey(host);
		if (norm === 'local') {
			return 'local';
		}
		const cached = this.knownHostToCanonicalIp.get(norm);
		if (cached) {
			return cached;
		}
		if (this.customTransport || this.cloudHosts) {
			try {
				const info = await this.resolveRemoteHostInfo(host);
				return this.normalizePoolKey(info.ip);
			} catch {
				return this.knownHostToCanonicalIp.get(norm) ?? norm;
			}
		}
		return norm;
	}

	async acquireSingleHostDataSlot(host: string): Promise<() => void> {
		if (this.disposed || this.shuttingDown) {
			throw new Error('AdeDynamicStorageEngine is shutting down');
		}
		const norm = await this.resolveCanonicalPoolHostKey(host);
		if (this.disposed || this.shuttingDown) {
			throw new Error('AdeDynamicStorageEngine is shutting down');
		}
		if (norm === 'local') {
			return () => undefined;
		}
		let pool = this.hostDataPools.get(norm);
		if (!pool) {
			pool = { active: 0, waiters: [] };
			this.hostDataPools.set(norm, pool);
		}
		const makeRelease = (targetPool: IDataStreamHostPool): (() => void) => {
			let released = false;
			return () => {
				if (released) {
					return;
				}
				released = true;
				const next = targetPool.waiters.shift();
				if (next) {
					if (this.disposed || this.shuttingDown) {
						targetPool.active = Math.max(0, targetPool.active - 1);
						next.reject(new Error('AdeDynamicStorageEngine is shutting down'));
					} else {
						next.resolve();
					}
				} else {
					targetPool.active = Math.max(0, targetPool.active - 1);
				}
			};
		};
		if (pool.active < this.maxDataStreamsPerHost) {
			pool.active += 1;
			return makeRelease(pool);
		}
		const targetPool = pool;
		return new Promise((resolve, reject) => {
			targetPool.waiters.push({
				resolve: () => resolve(makeRelease(targetPool)),
				reject,
			});
		});
	}

	/**
	 * Acquires data-stream slots on `hostA` and `hostB` in strict lexicographical order of canonical host keys,
	 * mathematically eliminating AB-BA deadlocks under concurrent bidirectional transfers (`HostA <-> HostB`).
	 */
	async acquireOrderedDualHostSlots(hostA: string, hostB: string): Promise<() => void> {
		if (this.disposed || this.shuttingDown) {
			throw new Error('AdeDynamicStorageEngine is shutting down');
		}
		const [keyA, keyB] = await Promise.all([
			this.resolveCanonicalPoolHostKey(hostA),
			this.resolveCanonicalPoolHostKey(hostB),
		]);
		if (this.disposed || this.shuttingDown) {
			throw new Error('AdeDynamicStorageEngine is shutting down');
		}
		if (keyA === 'local' && keyB === 'local') {
			return () => undefined;
		}
		if (keyA === 'local') {
			return this.acquireSingleHostDataSlot(keyB);
		}
		if (keyB === 'local' || keyA === keyB) {
			return this.acquireSingleHostDataSlot(keyA);
		}
		const [first, second] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
		const relFirst = await this.acquireSingleHostDataSlot(first);
		try {
			const relSecond = await this.acquireSingleHostDataSlot(second);
			let done = false;
			return () => {
				if (done) {
					return;
				}
				done = true;
				try {
					relSecond();
				} finally {
					relFirst();
				}
			};
		} catch (err) {
			relFirst();
			throw err;
		}
	}

	private normalizeHostAndPathSync(
		storageHost: string,
		storagePath: string,
	): { readonly canonicalHost: string; readonly normalizedPath: string } {
		const rawHostKey = this.normalizePoolKey(storageHost);
		if (rawHostKey === 'local') {
			const trimmed = storagePath.trim();
			const expanded = trimmed === '~'
				? this.homedir
				: (trimmed.startsWith('~/') || trimmed.startsWith('~\\')
					? path.join(this.homedir, trimmed.slice(2))
					: trimmed);
			let resolved = path.resolve(expanded);
			const rootLen = path.parse(resolved).root.length;
			while (resolved.length > rootLen && resolved.endsWith(path.sep)) {
				resolved = resolved.slice(0, -1);
			}
			return { canonicalHost: 'local', normalizedPath: resolved };
		}

		const canonicalHost = this.knownHostToCanonicalIp.get(rawHostKey) ?? rawHostKey;
		const cleanHome = this.knownRemoteHomeByCanonicalIp.get(canonicalHost);
		const trimmed = storagePath.trim().replace(/\\/g, '/');
		if (cleanHome) {
			const expanded = trimmed === '~'
				? cleanHome
				: (trimmed.startsWith('~/') ? path.posix.join(cleanHome, trimmed.slice(2)) : trimmed);
			let norm = path.posix.normalize(expanded);
			if (norm.length > 1 && norm.endsWith('/')) {
				norm = norm.slice(0, -1);
			}
			return { canonicalHost, normalizedPath: norm };
		}

		// Cold-cache fallback before resolveRemoteHostInfo has run: normalize both `~/.ade_store/...` and `/.../.ade_store/...` equivalently
		const storeMarker = `/${ADE_REMOTE_STORE_DIR_NAME}`;
		if (trimmed === `~${storeMarker}` || trimmed.startsWith(`~${storeMarker}/`)) {
			const rel = path.posix.normalize(trimmed.slice(2));
			return { canonicalHost, normalizedPath: `~/${rel.replace(/\/+$/, '')}` };
		}
		const markerSlashIdx = trimmed.indexOf(`${storeMarker}/`);
		if (markerSlashIdx >= 0) {
			const rel = path.posix.normalize(trimmed.slice(markerSlashIdx + 1));
			return { canonicalHost, normalizedPath: `~/${rel.replace(/\/+$/, '')}` };
		}
		if (trimmed.endsWith(storeMarker)) {
			return { canonicalHost, normalizedPath: `~/${ADE_REMOTE_STORE_DIR_NAME}` };
		}
		let norm = trimmed.startsWith('~/')
			? `~/${path.posix.normalize(trimmed.slice(2))}`
			: path.posix.normalize(trimmed);
		if (norm.length > 1 && norm.endsWith('/')) {
			norm = norm.slice(0, -1);
		}
		return { canonicalHost, normalizedPath: norm };
	}

	private isDescendantOrSameNormalizedPath(canonicalHost: string, candidatePath: string, dirPath: string): boolean {
		if (canonicalHost === 'local') {
			const prefix = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
			return candidatePath === dirPath || candidatePath.startsWith(prefix);
		}
		const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
		return candidatePath === dirPath || candidatePath.startsWith(prefix);
	}

	private hasActivePinBlockingDelete(canonicalHost: string, normalizedTarget: string, isDir: boolean): boolean {
		for (const entry of this.blobPinCounts.values()) {
			if (entry.count <= 0) {
				continue;
			}
			const { canonicalHost: pinHost, normalizedPath: pinPath } = this.normalizeHostAndPathSync(entry.rawHost, entry.rawPath);
			if (pinHost !== canonicalHost) {
				continue;
			}
			if (!isDir) {
				if (pinPath === normalizedTarget) {
					return true;
				}
			} else if (this.isDescendantOrSameNormalizedPath(canonicalHost, pinPath, normalizedTarget)) {
				return true;
			}
		}
		return false;
	}

	private async warmHostMappingsForGc(hosts: Iterable<string>): Promise<void> {
		if (this.cloudHosts) {
			const list = await this.cloudHosts.listHosts().catch(() => []);
			for (const h of list) {
				const remoteHome = h.lastTestStatus?.remoteHome?.trim();
				if (h.hostName && remoteHome) {
					this.recordResolvedHostInfo(h.alias || h.hostName, {
						ip: h.hostName,
						alias: h.alias,
						remoteHome,
					});
				}
			}
		}
		const uniqueRemoteHosts = new Set<string>();
		for (const raw of hosts) {
			const key = this.normalizePoolKey(raw);
			if (key && key !== 'local') {
				const mapped = this.knownHostToCanonicalIp.get(key);
				if (!mapped || !this.knownRemoteHomeByCanonicalIp.has(mapped)) {
					uniqueRemoteHosts.add(raw.trim());
				}
			}
		}
		for (const raw of uniqueRemoteHosts) {
			if (this.disposed || this.shuttingDown) {
				break;
			}
			await this.resolveRemoteHostInfo(raw).catch(() => undefined);
		}
	}

	/**
	 * Synchronously increments the in-memory pin count of `(storageHost, storagePath)`.
	 * MUST be called in the same synchronous turn inside `state.db`'s `Sequencer` lock right after reading the pointer.
	 */
	pinBlobForRead(storageHost: string, storagePath: string): () => void {
		const rawHost = (storageHost || 'local').trim() || 'local';
		const rawPath = storagePath;
		const entryKey = `${rawHost}\0${rawPath}`;
		const existing = this.blobPinCounts.get(entryKey);
		if (existing) {
			existing.count += 1;
		} else {
			this.blobPinCounts.set(entryKey, { rawHost, rawPath, count: 1 });
		}
		let unpinned = false;
		return () => {
			if (unpinned) {
				return;
			}
			unpinned = true;
			const curEntry = this.blobPinCounts.get(entryKey);
			if (!curEntry) {
				return;
			}
			curEntry.count -= 1;
			if (curEntry.count <= 0) {
				this.blobPinCounts.delete(entryKey);
				void this.drainTombstonesAsync().catch(() => undefined);
			}
		};
	}

	getPinCount(storageHost: string, storagePath: string): number {
		const target = this.normalizeHostAndPathSync(storageHost, storagePath);
		let total = 0;
		for (const entry of this.blobPinCounts.values()) {
			if (entry.count <= 0) {
				continue;
			}
			const normEntry = this.normalizeHostAndPathSync(entry.rawHost, entry.rawPath);
			if (normEntry.canonicalHost === target.canonicalHost && normEntry.normalizedPath === target.normalizedPath) {
				total += entry.count;
			}
		}
		return total;
	}

	async resolveRemoteHostInfo(hostIpOrAlias: string): Promise<{
		readonly ip: string;
		readonly alias: string;
		readonly os: 'linux' | 'macos' | 'windows';
		readonly remoteHome: string;
	}> {
		if (this.customTransport) {
			const resolved = await this.customTransport.resolveHost(hostIpOrAlias);
			this.recordResolvedHostInfo(hostIpOrAlias, resolved);
			return resolved;
		}
		if (!this.cloudHosts) {
			throw new AdeError('ERR_INVALID_ARGS', `未配置云主机服务，无法访问远程主机: ${hostIpOrAlias}`);
		}
		const needle = hostIpOrAlias.trim();
		const list = await this.cloudHosts.listHosts();
		const matched: IAdeCloudHost | undefined = list.find(h =>
			h.hostName === needle
			|| h.alias === needle
			|| h.id === needle
			|| h.hostName.toLowerCase() === needle.toLowerCase()
			|| h.alias.toLowerCase() === needle.toLowerCase(),
		);
		if (!matched) {
			throw new AdeError('ERR_INVALID_ARGS', `未知的存储或执行主机: ${hostIpOrAlias}`);
		}
		this.recordResolvedHostInfo(hostIpOrAlias, { ip: matched.hostName, alias: matched.alias, remoteHome: '' });
		let remoteHome = matched.lastTestStatus?.remoteHome?.trim();
		if (!remoteHome) {
			const cachedHome = this.knownRemoteHomeByCanonicalIp.get(this.normalizePoolKey(matched.hostName));
			if (cachedHome) {
				remoteHome = cachedHome;
			} else {
				let probe = this.inFlightHostProbes.get(matched.id);
				if (!probe) {
					probe = this.cloudHosts.testConnection(matched.alias).then(check => {
						if (!check.ok || !check.remoteHome?.trim()) {
							throw new AdeError('ERR_INVALID_ARGS', `无法连接远程云主机 ${matched.hostName}: ${check.error ?? 'SSH 不可达'}`);
						}
						return check.remoteHome.trim();
					}).finally(() => this.inFlightHostProbes.delete(matched.id));
					this.inFlightHostProbes.set(matched.id, probe);
				}
				remoteHome = await probe;
			}
		}
		const resolved = {
			ip: matched.hostName,
			alias: matched.alias,
			os: matched.os,
			remoteHome,
		};
		this.recordResolvedHostInfo(hostIpOrAlias, resolved);
		return resolved;
	}

	private async buildTargetBlobPath(
		storageHost: string,
		relSubdir: string,
		fileName: string,
	): Promise<{ readonly canonicalHost: string; readonly fullPath: string }> {
		const normHost = (storageHost || 'local').trim();
		if (normHost === 'local') {
			return {
				canonicalHost: 'local',
				fullPath: path.join(this.store.localStoreRootDir, relSubdir, fileName),
			};
		}
		const info = await this.resolveRemoteHostInfo(normHost);
		const cleanHome = info.remoteHome.replace(/\/+$/, '');
		return {
			canonicalHost: info.ip,
			fullPath: path.posix.join(cleanHome, ADE_REMOTE_STORE_DIR_NAME, relSubdir.replace(/\\/g, '/'), fileName),
		};
	}

	/**
	 * Resolves the physical path of `targetDirPath` by walking upward to its nearest existing ancestor directory
	 * and calling `fs.promises.realpath` WITHOUT creating any directories on disk.
	 */
	private async resolvePhysicalDirWithoutMkdir(targetDirPath: string, rawDestForError?: string): Promise<string> {
		const relSegments: string[] = [];
		let anc = path.resolve(targetDirPath);
		while (true) {
			let lst: fs.Stats | undefined;
			try {
				lst = await fs.promises.lstat(anc);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'ENOENT') {
					if (rawDestForError !== undefined) {
						throw new AdeError('ERR_INVALID_ARGS', `非法的下载目标路径 (${rawDestForError}): ${(err as Error).message}`);
					}
					return relSegments.length > 0 ? path.join(anc, ...relSegments) : anc;
				}
				lst = undefined;
			}
			if (lst) {
				if (lst.isSymbolicLink()) {
					let st: fs.Stats;
					try {
						st = await fs.promises.stat(anc);
					} catch {
						if (rawDestForError !== undefined) {
							throw new AdeError('ERR_INVALID_ARGS', `拒绝通过悬空或非法符号链接祖先目录下载: ${rawDestForError}`);
						}
						return relSegments.length > 0 ? path.join(anc, ...relSegments) : anc;
					}
					if (!st.isDirectory()) {
						if (rawDestForError !== undefined) {
							throw new AdeError('ERR_INVALID_ARGS', `下载目标祖先符号链接不是目录: ${rawDestForError}`);
						}
						return relSegments.length > 0 ? path.join(anc, ...relSegments) : anc;
					}
				} else if (!lst.isDirectory()) {
					if (rawDestForError !== undefined) {
						throw new AdeError('ERR_INVALID_ARGS', `下载目标祖先路径包含非目录文件: ${rawDestForError}`);
					}
					return relSegments.length > 0 ? path.join(anc, ...relSegments) : anc;
				}
				const realAnc = await fs.promises.realpath(anc);
				return relSegments.length > 0 ? path.join(realAnc, ...relSegments) : realAnc;
			}
			const parent = path.dirname(anc);
			if (parent === anc) {
				return relSegments.length > 0 ? path.join(anc, ...relSegments) : anc;
			}
			relSegments.unshift(path.basename(anc));
			anc = parent;
		}
	}

	/**
	 * Validates a local destination path for `ade_wb_download --dest`, blocking sensitive system/ADE paths
	 * (`~/.aexus-code`, `~/.ade_store`, `~/.ssh`, `/etc`, `/System`, `/var/root`, `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`)
	 * and symlink parent escapes BEFORE creating any parent directories.
	 */
	async validateAndResolveLocalDownloadDest(
		rawDest: string,
		fallbackFilename: string,
		destIsDirHint = false,
	): Promise<string> {
		if (!rawDest || typeof rawDest !== 'string' || !rawDest.trim()) {
			throw new AdeError('ERR_INVALID_ARGS', '必须提供合法的 --dest 保存目标路径');
		}
		if (/[\x00-\x1f]/.test(rawDest)) {
			throw new AdeError('ERR_INVALID_ARGS', '下载目标路径禁止包含换行符或控制字符');
		}
		const trimmed = rawDest.trim();
		const expanded = trimmed === '~'
			? this.homedir
			: (trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? path.join(this.homedir, trimmed.slice(2)) : trimmed);
		const absCandidate = path.resolve(expanded);

		let isDirTarget = destIsDirHint || trimmed.endsWith('/') || trimmed.endsWith('\\');
		if (!isDirTarget) {
			try {
				const st = await fs.promises.stat(absCandidate);
				if (st.isDirectory()) {
					isDirTarget = true;
				}
			} catch {
				// target does not exist yet
			}
		}
		const finalTarget = isDirTarget
			? path.join(absCandidate, sanitizeSafeFilename(fallbackFilename))
			: absCandidate;

		// Check if finalTarget itself is a symlink or directory
		try {
			const lst = await fs.promises.lstat(finalTarget);
			if (lst.isSymbolicLink()) {
				throw new AdeError('ERR_INVALID_ARGS', '拒绝覆盖符号链接目标路径');
			}
			if (lst.isDirectory()) {
				throw new AdeError('ERR_INVALID_ARGS', `下载目标路径不能是目录: ${rawDest}`);
			}
		} catch (err) {
			if (err instanceof AdeError) {
				throw err;
			}
		}

		const parentDir = path.dirname(finalTarget);
		const realParent = await this.resolvePhysicalDirWithoutMkdir(parentDir, rawDest);
		const canonicalTarget = path.join(realParent, path.basename(finalTarget));

		const logicalHome = path.resolve(this.homedir);
		const physicalHome = await this.resolvePhysicalDirWithoutMkdir(logicalHome);
		for (const homeCandidate of [logicalHome, physicalHome]) {
			if (finalTarget === homeCandidate || canonicalTarget === homeCandidate) {
				throw new AdeError('ERR_INVALID_ARGS', `禁止直接覆盖用户主目录: ${rawDest}`);
			}
		}

		const forbiddenPrefixes = [
			path.resolve(this.store.adeHomeDir),
			path.resolve(logicalHome, ADE_CONTROL_DIR_NAME),
			path.resolve(physicalHome, ADE_CONTROL_DIR_NAME),
			path.resolve(logicalHome, ADE_REMOTE_STORE_DIR_NAME),
			path.resolve(physicalHome, ADE_REMOTE_STORE_DIR_NAME),
			path.resolve(logicalHome, '.ssh'),
			path.resolve(physicalHome, '.ssh'),
			'/etc',
			'/private/etc',
			'/var/root',
			'/private/var/root',
			'/System',
			'/bin',
			'/sbin',
			'/usr/bin',
			'/usr/sbin',
		];
		const foldCase = process.platform === 'darwin' || process.platform === 'win32';
		const normCmp = (p: string) => (foldCase ? p.toLowerCase() : p);
		const finalCmp = normCmp(finalTarget);
		const canonicalCmp = normCmp(canonicalTarget);
		for (const rawPrefix of forbiddenPrefixes) {
			const realPrefix = await this.resolvePhysicalDirWithoutMkdir(rawPrefix);
			for (const checkPrefix of [rawPrefix, realPrefix]) {
				const pfxCmp = normCmp(checkPrefix);
				if (
					finalCmp === pfxCmp
					|| finalCmp.startsWith(`${pfxCmp}${path.sep}`)
					|| canonicalCmp === pfxCmp
					|| canonicalCmp.startsWith(`${pfxCmp}${path.sep}`)
				) {
					throw new AdeError('ERR_INVALID_ARGS', `禁止将文件下载至受保护系统或控制中心目录: ${rawDest}`);
				}
			}
		}

		await fs.promises.mkdir(realParent, { recursive: true });
		return canonicalTarget;
	}

	abortActiveStreamsForShutdown(): void {
		this.shuttingDown = true;
		for (const pipe of [...this.activeSshPipes]) {
			try { pipe.kill(); } catch { /* ignore */ }
		}
		this.activeSshPipes.clear();
		for (const pool of this.hostDataPools.values()) {
			const waiters = pool.waiters.splice(0, pool.waiters.length);
			for (const w of waiters) {
				w.reject(new Error('AdeDynamicStorageEngine is shutting down'));
			}
		}
	}

	async waitForPendingGc(): Promise<void> {
		if (this.gcPromise) {
			await this.gcPromise.catch(() => undefined);
		}
	}

	private async openSshPipe(
		alias: string,
		remoteShCommand: string,
	): Promise<{
		readonly stdin: NodeJS.WritableStream;
		readonly stdout: Readable;
		readonly waitClose: () => Promise<{ readonly exitCode: 0; readonly stderr: string }>;
		readonly kill: () => void;
	}> {
		if (this.disposed || this.shuttingDown) {
			throw new Error('AdeDynamicStorageEngine is shutting down');
		}
		let rawPipe: {
			readonly stdin: NodeJS.WritableStream;
			readonly stdout: Readable;
			readonly waitClose: () => Promise<{ readonly exitCode: number | null; readonly stderr: string }>;
			readonly kill: () => void;
		};
		if (this.customTransport?.spawnSshStream) {
			rawPipe = await this.customTransport.spawnSshStream(alias, remoteShCommand);
			if (this.disposed || this.shuttingDown) {
				try { rawPipe.kill(); } catch { /* ignore */ }
				destroyStreamQuietly(rawPipe.stdin);
				destroyStreamQuietly(rawPipe.stdout);
				throw new Error('AdeDynamicStorageEngine is shutting down');
			}
		} else {
			const sshCfg = this.customTransport
				? await this.customTransport.getEffectiveSshConfigPath()
				: (this.cloudHosts ? await this.cloudHosts.getEffectiveSshConfigPath() : path.join(this.homedir, '.ssh', 'config'));
			if (this.disposed || this.shuttingDown) {
				throw new Error('AdeDynamicStorageEngine is shutting down');
			}
			const args = [
				'-F', sshCfg,
				'-T',
				'-o', 'BatchMode=yes',
				'-o', 'ConnectTimeout=10',
				'-o', 'ControlMaster=no',
				'-o', 'ControlPath=none',
				'--',
				alias,
				`sh -c ${posixQuote(remoteShCommand)}`,
			];
			const child = spawn(this.sshExec, args, {
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...stripAdeControlEnv(process.env), SSH_ASKPASS_REQUIRE: 'never', DISPLAY: '' },
			});
			let stderr = '';
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => {
				if (stderr.length < 65_536) {
					stderr += chunk;
				}
			});
			const rawClosePromise = new Promise<{ readonly exitCode: number | null; readonly stderr: string }>((resolve, reject) => {
				child.once('error', err => reject(err));
				child.once('close', code => resolve({ exitCode: code, stderr: stderr.trim() }));
			});
			rawPipe = {
				stdin: child.stdin,
				stdout: child.stdout,
				waitClose: () => rawClosePromise,
				kill: () => {
					try { child.kill('SIGKILL'); } catch { /* ignore */ }
				},
			};
		}

		let stdinStreamErr: Error | undefined;
		rawPipe.stdin.on('error', (err: Error) => {
			stdinStreamErr = err;
		});

		const handleRef = {
			kill: () => {
				try { rawPipe.kill(); } catch { /* ignore */ }
				destroyStreamQuietly(rawPipe.stdin);
				destroyStreamQuietly(rawPipe.stdout);
			},
		};
		this.activeSshPipes.add(handleRef);

		const verifiedClosePromise = rawPipe.waitClose().then(
			res => {
				this.activeSshPipes.delete(handleRef);
				const cleanStderr = (res.stderr || stdinStreamErr?.message || '').trim();
				if (res.exitCode !== 0) {
					const exitErr = new SshPipeExitError(alias, res.exitCode, cleanStderr);
					destroyStreamQuietly(rawPipe.stdin, exitErr);
					destroyStreamQuietly(rawPipe.stdout, exitErr);
					throw exitErr;
				}
				return { exitCode: 0 as const, stderr: cleanStderr };
			},
			err => {
				this.activeSshPipes.delete(handleRef);
				const wrapErr = err instanceof Error ? err : new Error(String(err));
				destroyStreamQuietly(rawPipe.stdin, wrapErr);
				destroyStreamQuietly(rawPipe.stdout, wrapErr);
				throw wrapErr;
			},
		);
		// Prevent unhandled rejection warnings when upstream stream pipeline fails slightly before waitClose() is awaited
		verifiedClosePromise.catch(() => undefined);

		return {
			stdin: rawPipe.stdin,
			stdout: rawPipe.stdout,
			waitClose: () => verifiedClosePromise,
			kill: handleRef.kill,
		};
	}

	/**
	 * Writes inline UTF-8 text (`detail` or `note > 300 chars`) to `targetStorageHost` and returns its immutable `IAdeBlobPointer`.
	 */
	async storeTextBlob(input: {
		readonly targetStorageHost: string;
		readonly relSubdir: string;
		readonly filePrefix: string;
		readonly text: string;
		readonly contentRev?: number;
	}): Promise<IAdeBlobPointer> {
		const uuid12 = crypto.randomBytes(6).toString('hex');
		const blobId = `blb_${uuid12}`;
		const fileName = `${input.filePrefix}_${uuid12}.detail.txt`;
		const buf = Buffer.from(input.text, 'utf8');
		const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
		const sizeBytes = buf.byteLength;
		const { canonicalHost, fullPath } = await this.buildTargetBlobPath(input.targetStorageHost, input.relSubdir, fileName);

		if (canonicalHost === 'local') {
			await this.writeLocalBufferAtomically(fullPath, buf);
		} else {
			const hostInfo = await this.resolveRemoteHostInfo(canonicalHost);
			const release = await this.acquireSingleHostDataSlot(canonicalHost);
			try {
				await this.streamBufferToRemoteVerified(hostInfo.ip, hostInfo.alias, fullPath, buf, sizeBytes, sha256);
			} finally {
				release();
			}
		}

		return {
			blob_id: blobId,
			storage_host: canonicalHost,
			storage_path: fullPath,
			size_bytes: sizeBytes,
			sha256,
			content_rev: input.contentRev ?? 1,
		};
	}

	/**
	 * Stores a file from `sourceHost` (`sourcePath`) into `targetStorageHost` (`relSubdir`) with zero round-trip when
	 * `sourceHost === targetStorageHost` on the same cloud host, or streaming 64KB backpressure pipe across hosts.
	 */
	async storeFileFromHost(input: {
		readonly sourceHost: string;
		readonly sourcePath: string;
		readonly deleteSourceTempAfter?: boolean;
		readonly targetStorageHost: string;
		readonly relSubdir: string;
		readonly filePrefix: string;
		readonly displayFilename?: string;
		readonly contentRev?: number;
	}): Promise<IAdeBlobPointer & { readonly filename: string }> {
		const uuid12 = crypto.randomBytes(6).toString('hex');
		const blobId = `blb_${uuid12}`;
		const safeName = sanitizeSafeFilename(input.displayFilename ?? path.basename(input.sourcePath));
		const storedName = input.displayFilename
			? `${input.filePrefix}_${uuid12}_${safeName}`
			: `${input.filePrefix}_${uuid12}.detail.txt`;

		const srcHostNorm = (input.sourceHost || 'local').trim();
		const { canonicalHost: dstHost, fullPath: dstPath } = await this.buildTargetBlobPath(
			input.targetStorageHost,
			input.relSubdir,
			storedName,
		);

		try {
			// Quadrant 1: local -> local
			if (srcHostNorm === 'local' && dstHost === 'local') {
				const { sizeBytes, sha256 } = await this.copyLocalToLocalVerified(input.sourcePath, dstPath);
				return {
					blob_id: blobId,
					storage_host: 'local',
					storage_path: dstPath,
					size_bytes: sizeBytes,
					sha256,
					content_rev: input.contentRev ?? 1,
					filename: safeName,
				};
			}

			// Quadrant 2: same cloud host IP_A -> IP_A (zero round-trip single remote SSH atomic copy + sha256)
			if (srcHostNorm !== 'local' && dstHost !== 'local') {
				const srcInfo = await this.resolveRemoteHostInfo(srcHostNorm);
				const dstInfo = await this.resolveRemoteHostInfo(dstHost);
				if (srcInfo.ip === dstInfo.ip) {
					const release = await this.acquireSingleHostDataSlot(srcInfo.ip);
					try {
						const { sizeBytes, sha256 } = await this.copySameRemoteToRemoteVerified(dstInfo.ip, srcInfo.alias, input.sourcePath, dstPath);
						return {
							blob_id: blobId,
							storage_host: dstInfo.ip,
							storage_path: dstPath,
							size_bytes: sizeBytes,
							sha256,
							content_rev: input.contentRev ?? 1,
							filename: safeName,
						};
					} finally {
						release();
					}
				}
			}

			// Quadrant 3 & 4: cross-host streaming (`local -> IP`, `IP -> local`, or `IP_A -> IP_B`)
			const canonicalSrcHost = srcHostNorm === 'local'
				? 'local'
				: (await this.resolveRemoteHostInfo(srcHostNorm)).ip;
			const release = await this.acquireOrderedDualHostSlots(canonicalSrcHost, dstHost);
			try {
				const { sizeBytes, sha256 } = await this.transferCrossHostVerified(canonicalSrcHost, input.sourcePath, dstHost, dstPath);
				return {
					blob_id: blobId,
					storage_host: dstHost,
					storage_path: dstPath,
					size_bytes: sizeBytes,
					sha256,
					content_rev: input.contentRev ?? 1,
					filename: safeName,
				};
			} finally {
				release();
			}
		} finally {
			if (input.deleteSourceTempAfter && (srcHostNorm === 'local' || (!this.disposed && !this.shuttingDown))) {
				await this.bestEffortDeleteTempFile(srcHostNorm, input.sourcePath);
			}
		}
	}

	/**
	 * Reads a UTF-8 text blob from `ptr.storage_host` (`local` or cloud IP), verifying size and SHA-256.
	 */
	async readTextBlobVerified(ptr: Pick<IAdeBlobPointer, 'storage_host' | 'storage_path' | 'size_bytes' | 'sha256'>): Promise<string> {
		if (ptr.storage_host === 'local') {
			let buf: Buffer;
			try {
				buf = await fs.promises.readFile(ptr.storage_path);
			} catch {
				throw new AdeError('ERR_DETAIL_NOT_FOUND', '目标详述物理文件不存在或已被清理');
			}
			const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
			if (ptr.sha256 && actualSha !== ptr.sha256) {
				throw new Error(`本地存储文件哈希校验失败: ${ptr.storage_path}`);
			}
			return buf.toString('utf8');
		}

		const info = await this.resolveRemoteHostInfo(ptr.storage_host);
		const release = await this.acquireSingleHostDataSlot(info.ip);
		try {
			const buf = await this.readRemoteFileVerified(info.alias, ptr.storage_path, ptr.size_bytes, ptr.sha256);
			return buf.toString('utf8');
		} finally {
			release();
		}
	}

	async readRemoteUtf8Prefix(host: string, remotePath: string, maxBytes = 2048): Promise<string> {
		const info = await this.resolveRemoteHostInfo(host);
		const release = await this.acquireSingleHostDataSlot(info.ip);
		try {
			const cap = Math.max(512, Math.min(16_384, Math.trunc(maxBytes)));
			const cmd = `p=${posixQuoteRemotePath(remotePath)}; [ -f "$p" ] && [ ! -L "$p" ] || exit 44; head -c ${cap} -- "$p"`;
			const pipe = await this.openSshPipe(info.alias, cmd);
			pipe.stdin.end();
			const chunks: Buffer[] = [];
			for await (const chunk of pipe.stdout) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			await pipe.waitClose();
			const rawBuf = Buffer.concat(chunks);
			let validEnd = rawBuf.byteLength;
			if (rawBuf.byteLength === cap) {
				while (validEnd > 0 && (rawBuf[validEnd - 1] & 0xc0) === 0x80) {
					validEnd--;
				}
				if (validEnd > 0 && rawBuf[validEnd - 1] >= 0xc0) {
					validEnd--;
				}
			}
			return rawBuf.subarray(0, validEnd).toString('utf8');
		} finally {
			release();
		}
	}

	/**
	 * Downloads a whiteboard backup file (`ptr`) to `callerHost` at `rawDestPath` (`local` or cloud IP),
	 * enforcing sensitive directory & symlink guards and the 3-way SSH integrity gate.
	 */
	async downloadBlobToHost(input: {
		readonly ptr: Pick<IAdeBlobPointer, 'storage_host' | 'storage_path' | 'size_bytes' | 'sha256'>;
		readonly fallbackFilename: string;
		readonly callerHost: string;
		readonly rawDestPath: string;
		readonly destIsDirHint?: boolean;
	}): Promise<string> {
		const dstHostNorm = (input.callerHost || 'local').trim();
		const srcHostNorm = (input.ptr.storage_host || 'local').trim();

		if (dstHostNorm === 'local') {
			const safeLocalDest = await this.validateAndResolveLocalDownloadDest(
				input.rawDestPath,
				input.fallbackFilename,
				input.destIsDirHint,
			);
			if (srcHostNorm === 'local') {
				await this.copyLocalToLocalVerified(input.ptr.storage_path, safeLocalDest, input.ptr.size_bytes, input.ptr.sha256);
			} else {
				const srcInfo = await this.resolveRemoteHostInfo(srcHostNorm);
				const release = await this.acquireSingleHostDataSlot(srcInfo.ip);
				try {
					await this.transferCrossHostVerified(srcInfo.ip, input.ptr.storage_path, 'local', safeLocalDest, input.ptr.size_bytes, input.ptr.sha256);
				} finally {
					release();
				}
			}
			return safeLocalDest;
		}

		const dstInfo = await this.resolveRemoteHostInfo(dstHostNorm);
		const safeRemoteDest = await this.validateAndResolveRemoteDownloadDest(
			dstInfo.ip,
			dstInfo.alias,
			dstInfo.remoteHome,
			input.rawDestPath,
			input.fallbackFilename,
			Boolean(input.destIsDirHint),
		);

		const canonicalSrcHost = srcHostNorm === 'local'
			? 'local'
			: (await this.resolveRemoteHostInfo(srcHostNorm)).ip;
		if (canonicalSrcHost !== 'local' && canonicalSrcHost === dstInfo.ip) {
			const srcInfo = await this.resolveRemoteHostInfo(srcHostNorm);
			const release = await this.acquireSingleHostDataSlot(dstInfo.ip);
			try {
				await this.copySameRemoteToRemoteVerified(dstInfo.ip, srcInfo.alias, input.ptr.storage_path, safeRemoteDest, input.ptr.size_bytes, input.ptr.sha256);
				return safeRemoteDest;
			} finally {
				release();
			}
		}

		const release = await this.acquireOrderedDualHostSlots(canonicalSrcHost, dstInfo.ip);
		try {
			await this.transferCrossHostVerified(canonicalSrcHost, input.ptr.storage_path, dstInfo.ip, safeRemoteDest, input.ptr.size_bytes, input.ptr.sha256);
			return safeRemoteDest;
		} finally {
			release();
		}
	}

	/**
	 * Copies a stored blob from `(srcHost, srcPath)` to `targetStorageHost` for CAS online migration,
	 * verifying `expectedBytes` and `expectedSha256` before returning the new path.
	 */
	async copyBlobForMigration(input: {
		readonly srcHost: string;
		readonly srcPath: string;
		readonly dstHost: string;
		readonly relSubdir: string;
		readonly expectedBytes: number;
		readonly expectedSha256: string;
	}): Promise<{ readonly canonicalDstHost: string; readonly dstPath: string; readonly sizeBytes: number }> {
		const rawBase = path.posix.basename(input.srcPath.replace(/\\/g, '/')).replace(/^m[0-9a-f]{8}_/, '');
		const migTag = crypto.randomBytes(4).toString('hex');
		const fileName = `m${migTag}_${rawBase}`.slice(0, 220);
		const srcHostTrimmed = (input.srcHost || 'local').trim() || 'local';
		const canonicalSrcHost = srcHostTrimmed === 'local'
			? 'local'
			: (await this.resolveRemoteHostInfo(srcHostTrimmed)).ip;
		const { canonicalHost: canonicalDstHost, fullPath: dstPath } = await this.buildTargetBlobPath(
			input.dstHost,
			input.relSubdir,
			fileName,
		);
		const effectiveExpectedBytes = isUnexpectedZeroExpectedBytes(input.expectedBytes, input.expectedSha256)
			? undefined
			: input.expectedBytes;
		const release = await this.acquireOrderedDualHostSlots(canonicalSrcHost, canonicalDstHost);
		let sizeBytes = input.expectedBytes;
		try {
			if (canonicalSrcHost === 'local' && canonicalDstHost === 'local') {
				const copied = await this.copyLocalToLocalVerified(input.srcPath, dstPath, effectiveExpectedBytes, input.expectedSha256);
				sizeBytes = copied.sizeBytes;
			} else {
				const copied = await this.transferCrossHostVerified(
					canonicalSrcHost,
					input.srcPath,
					canonicalDstHost,
					dstPath,
					effectiveExpectedBytes,
					input.expectedSha256,
				);
				sizeBytes = copied.sizeBytes;
			}
		} finally {
			release();
		}
		return { canonicalDstHost, dstPath, sizeBytes };
	}

	/**
	 * Enqueues physical paths into `catalog.db.remote_gc_tombstones` and kicks off non-blocking safe GC
	 * (respecting `pinCount === 0` and verifying non-symlink containment inside `ade-store` / `.ade_store`).
	 */
	async enqueueTombstones(
		entries: readonly {
			readonly projectId: string;
			readonly storageHost: string;
			readonly storagePath: string;
			readonly isDir?: boolean;
			readonly sha256?: string | null;
		}[],
		catalogTx?: IAdeSqlRunner,
	): Promise<void> {
		if (entries.length === 0) {
			return;
		}
		const now = Date.now();
		const insertMany = async (runner: IAdeSqlRunner) => {
			for (const item of entries) {
				if (!item.storagePath) {
					continue;
				}
				const id = `tmb_${crypto.randomBytes(8).toString('hex')}`;
				await runner.run(
					`INSERT OR IGNORE INTO remote_gc_tombstones
					 (tombstone_id, project_id, storage_host, storage_path, is_dir, sha256, retry_count, next_retry_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
					[id, item.projectId, item.storageHost || 'local', item.storagePath, item.isDir ? 1 : 0, item.sha256 ?? null, now],
				);
			}
		};
		if (catalogTx) {
			await insertMany(catalogTx);
		} else {
			await this.store.catalog.transaction(insertMany);
		}
		void this.drainTombstonesAsync().catch(() => undefined);
	}

	async drainTombstonesAsync(): Promise<number> {
		if (this.disposed || this.shuttingDown) {
			return 0;
		}
		if (this.gcPromise) {
			this.gcRerunRequested = true;
			return this.gcPromise;
		}
		const runLoop = async (): Promise<number> => {
			let deletedCount = 0;
			do {
				this.gcRerunRequested = false;
				if (this.disposed || this.shuttingDown) {
					break;
				}
				const now = Date.now();
				const rawRows = await this.store.catalog.all<{
					tombstone_id: string;
					storage_host: string;
					storage_path: string;
					is_dir: number;
					retry_count: number;
					next_retry_at: number;
					created_at: number;
				}>(
					`SELECT tombstone_id, storage_host, storage_path, is_dir, retry_count, next_retry_at, created_at
					 FROM remote_gc_tombstones
					 ORDER BY is_dir ASC, created_at ASC`,
				);
				if (rawRows.length === 0 || this.disposed || this.shuttingDown) {
					break;
				}

				const hostsToWarm = new Set<string>();
				for (const r of rawRows) {
					hostsToWarm.add(r.storage_host);
				}
				for (const p of this.blobPinCounts.values()) {
					if (p.count > 0) {
						hostsToWarm.add(p.rawHost);
					}
				}
				await this.warmHostMappingsForGc(hostsToWarm);
				if (this.disposed || this.shuttingDown) {
					break;
				}

				type INormalizedTombstoneRow = (typeof rawRows)[number] & {
					readonly canonicalHost: string;
					readonly normalizedPath: string;
				};
				const normalizedRows: INormalizedTombstoneRow[] = rawRows.map(r => ({
					...r,
					...this.normalizeHostAndPathSync(r.storage_host, r.storage_path),
				}));
				const liveTombstones = new Map<string, INormalizedTombstoneRow>(
					normalizedRows.map(r => [r.tombstone_id, r]),
				);

				// Process all `is_dir = 0` file tombstones first (`created_at ASC`), then `is_dir = 1` directory tombstones
				// (deeper subdirectories before parent directories so nested `<pid>_tickets/<ticket_id>` drains cleanly in one pass)
				const dueRows = normalizedRows
					.filter(r => r.next_retry_at <= now)
					.sort((a, b) => {
						if (a.is_dir !== b.is_dir) {
							return a.is_dir - b.is_dir;
						}
						if (a.is_dir === 1 && a.normalizedPath.length !== b.normalizedPath.length) {
							return b.normalizedPath.length - a.normalizedPath.length;
						}
						return a.created_at - b.created_at;
					});

				for (const row of dueRows) {
					if (this.disposed || this.shuttingDown) {
						break;
					}
					const isDir = row.is_dir === 1;
					if (this.hasActivePinBlockingDelete(row.canonicalHost, row.normalizedPath, isDir)) {
						continue;
					}
					if (isDir) {
						let hasRemainingChildTombstone = false;
						for (const other of liveTombstones.values()) {
							if (other.tombstone_id === row.tombstone_id || other.canonicalHost !== row.canonicalHost) {
								continue;
							}
							if (other.is_dir === 0 && this.isDescendantOrSameNormalizedPath(row.canonicalHost, other.normalizedPath, row.normalizedPath)) {
								hasRemainingChildTombstone = true;
								break;
							}
							if (other.is_dir === 1 && other.normalizedPath !== row.normalizedPath && this.isDescendantOrSameNormalizedPath(row.canonicalHost, other.normalizedPath, row.normalizedPath)) {
								hasRemainingChildTombstone = true;
								break;
							}
						}
						if (hasRemainingChildTombstone) {
							continue;
						}
					}
					try {
						await this.executeSafePhysicalDelete(row.storage_host, row.storage_path, isDir);
						await this.store.catalog.run(
							`DELETE FROM remote_gc_tombstones WHERE tombstone_id = ?`,
							[row.tombstone_id],
						);
						liveTombstones.delete(row.tombstone_id);
						deletedCount++;
					} catch (err) {
						const nextRetry = Date.now() + Math.min(300_000, 2_000 * Math.pow(2, Math.min(7, row.retry_count)));
						await this.store.catalog.run(
							`UPDATE remote_gc_tombstones
							 SET retry_count = retry_count + 1, next_retry_at = ?, last_error = ?
							 WHERE tombstone_id = ?`,
							[nextRetry, err instanceof Error ? err.message : String(err), row.tombstone_id],
						).catch(() => undefined);
					}
				}
			} while (this.gcRerunRequested && !this.disposed && !this.shuttingDown);
			return deletedCount;
		};
		this.gcPromise = runLoop().finally(() => {
			this.gcPromise = undefined;
		});
		return this.gcPromise;
	}

	private async executeSafePhysicalDelete(storageHost: string, targetPath: string, isDir: boolean): Promise<void> {
		if (storageHost === 'local') {
			const allowedRoots = [
				path.resolve(this.store.localStoreRootDir),
				path.resolve(this.store.adeHomeDir, 'workspaces'),
			];
			const resolved = path.resolve(targetPath);
			const withinAllowedRoot = allowedRoots.some(
				allowedRoot => resolved !== allowedRoot && resolved.startsWith(`${allowedRoot}${path.sep}`),
			);
			if (!withinAllowedRoot) {
				throw new Error(`Refusing GC outside local ade-store/workspaces: ${targetPath}`);
			}
			try {
				const lst = await fs.promises.lstat(resolved);
				const realAllowedRoots = await Promise.all(
					allowedRoots.map(r => this.resolvePhysicalDirWithoutMkdir(r)),
				);
				const parentDir = path.dirname(resolved);
				const parentLst = await fs.promises.lstat(parentDir);
				if (parentLst.isSymbolicLink()) {
					throw new Error(`Refusing GC through symlinked parent directory: ${parentDir}`);
				}
				const realParent = await fs.promises.realpath(parentDir);
				const parentContained = realAllowedRoots.some(
					root => realParent === root || realParent.startsWith(`${root}${path.sep}`),
				);
				if (!parentContained) {
					throw new Error(`Refusing GC escaping physical store root via ancestor symlink: ${targetPath}`);
				}
				if (lst.isSymbolicLink()) {
					await fs.promises.unlink(resolved);
					return;
				}
				if (isDir || lst.isDirectory()) {
					await fs.promises.rm(resolved, { recursive: true, force: true });
				} else {
					await fs.promises.unlink(resolved);
				}
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw err;
				}
			}
			return;
		}

		const info = await this.resolveRemoteHostInfo(storageHost);
		const cleanHome = info.remoteHome.replace(/\/+$/, '');
		const storeRoot = path.posix.join(cleanHome, ADE_REMOTE_STORE_DIR_NAME);
		const expandedTarget = targetPath === `~/${ADE_REMOTE_STORE_DIR_NAME}`
			? storeRoot
			: (targetPath.startsWith(`~/${ADE_REMOTE_STORE_DIR_NAME}/`)
				? path.posix.join(cleanHome, targetPath.slice(2))
				: targetPath);
		const normTarget = path.posix.normalize(expandedTarget);
		if (normTarget === storeRoot || !normTarget.startsWith(`${storeRoot}/`)) {
			throw new Error(`Refusing remote GC outside ~/.ade_store: ${targetPath}`);
		}
		const qt = posixQuoteRemotePath(normTarget);
		const qRoot = posixQuoteRemotePath(storeRoot);
		const guard = `t=${qt}; r=${qRoot}; [ -d "$r" ] || exit 0; rp_r=$(cd -- "$r" && pwd -P); dp=$(dirname -- "$t"); [ -e "$dp" ] || [ -L "$dp" ] || exit 0; if [ -L "$dp" ]; then exit 4; fi; rp_d=$(cd -- "$dp" && pwd -P); case "$rp_d/" in "$rp_r/"*) ;; *) exit 4 ;; esac`;
		const script = isDir
			? `${guard}; if [ ! -L "$t" ] && [ -d "$t" ]; then rm -rf -- "$t"; fi`
			: `${guard}; if [ ! -L "$t" ] && [ -f "$t" ]; then rm -f -- "$t"; fi`;
		const release = await this.acquireSingleHostDataSlot(info.ip);
		try {
			const pipe = await this.openSshPipe(info.alias, script);
			pipe.stdin.end();
			await pipe.waitClose();
		} catch (err) {
			if (err instanceof SshPipeExitError) {
				throw new Error(`Remote GC failed on ${info.ip}: ${err.stderr || `exit ${err.exitCode}`}`);
			}
			throw err;
		} finally {
			release();
		}
	}

	private async writeLocalBufferAtomically(targetPath: string, buf: Buffer): Promise<void> {
		const dir = path.dirname(targetPath);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		const tmp = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
		try {
			await fs.promises.writeFile(tmp, buf, { mode: 0o600 });
			await fs.promises.rename(tmp, targetPath);
		} catch (err) {
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
	}

	private async copyLocalToLocalVerified(
		srcPath: string,
		dstPath: string,
		expectedBytes?: number,
		expectedSha256?: string,
	): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
		if (this.disposed || this.shuttingDown) {
			throw new Error('AdeDynamicStorageEngine is shutting down');
		}
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(srcPath);
		} catch {
			throw new AdeError('ERR_INVALID_ARGS', `待读取的本地文件不存在: ${srcPath}`);
		}
		if (!st.isFile()) {
			throw new AdeError('ERR_INVALID_ARGS', `目标路径不是普通文件: ${srcPath}`);
		}
		const effectiveExpectedBytes = isUnexpectedZeroExpectedBytes(expectedBytes, expectedSha256)
			? st.size
			: expectedBytes;
		const dir = path.dirname(dstPath);
		await fs.promises.mkdir(dir, { recursive: true });
		const tmp = `${dstPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
		const hash = crypto.createHash('sha256');
		let actualBytes = 0;

		const rs = fs.createReadStream(srcPath, { highWaterMark: 64 * 1024 });
		const ws = fs.createWriteStream(tmp, { mode: 0o600, highWaterMark: 64 * 1024 });
		const meter = new Transform({
			highWaterMark: 64 * 1024,
			transform(chunk: Buffer, _enc, cb) {
				actualBytes += chunk.byteLength;
				hash.update(chunk);
				cb(null, chunk);
			},
		});
		try {
			await pipeline(rs, meter, ws);
			const actualSha = hash.digest('hex');
			if (effectiveExpectedBytes !== undefined && actualBytes !== effectiveExpectedBytes) {
				throw new Error(`字节数不匹配: 预期 ${effectiveExpectedBytes}，实际 ${actualBytes}`);
			}
			if (expectedSha256 && actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
				throw new Error(`SHA-256 校验失败: ${srcPath}`);
			}
			await fs.promises.rename(tmp, dstPath);
			return { sizeBytes: actualBytes, sha256: actualSha };
		} catch (err) {
			destroyStreamQuietly(rs);
			destroyStreamQuietly(meter);
			destroyStreamQuietly(ws);
			await fs.promises.unlink(tmp).catch(() => undefined);
			throw err;
		}
	}

	private async copySameRemoteToRemoteVerified(
		hostIp: string,
		alias: string,
		srcRemotePath: string,
		dstRemotePath: string,
		expectedBytes?: number,
		expectedSha256?: string,
	): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
		const qs = posixQuoteRemotePath(srcRemotePath);
		const qd = posixQuoteRemotePath(dstRemotePath);
		const uuid = crypto.randomBytes(6).toString('hex');
		const qu = posixQuote(uuid);
		const remoteTmpPath = `${dstRemotePath}.tmp.${uuid}`;
		const effectiveExpectedBytes = isUnexpectedZeroExpectedBytes(expectedBytes, expectedSha256)
			? undefined
			: expectedBytes;
		const script = [
			`set -e`,
			`s=${qs}; d=${qd}; u=${qu}; tmp="$d.tmp.$u"`,
			`trap 'rm -f -- "$tmp"' EXIT INT TERM HUP`,
			`if [ ! -f "$s" ]; then echo "__ADE_ERR__:ENOENT" >&2; exit 2; fi`,
			`mkdir -p -- "$(dirname -- "$d")"`,
			`cp -f -- "$s" "$tmp"`,
			`sz=$(wc -c < "$tmp" | tr -d ' \\t\\r\\n')`,
			`sha=$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | awk '{print $1}' )`,
			effectiveExpectedBytes !== undefined ? `eb=${posixQuote(String(effectiveExpectedBytes))}; if [ "$sz" != "$eb" ]; then rm -f -- "$tmp"; exit 5; fi` : '',
			expectedSha256 ? `es=${posixQuote(expectedSha256.toLowerCase())}; if [ "$sha" != "$es" ]; then rm -f -- "$tmp"; exit 6; fi` : '',
			`mv -f -- "$tmp" "$d"`,
			`printf '%s|%s\\n' "$sz" "$sha"`,
		].filter(Boolean).join('; ');

		const pipe = await this.openSshPipe(alias, script);
		pipe.stdin.end();
		const outChunks: Buffer[] = [];
		pipe.stdout.on('data', (c: Buffer) => outChunks.push(c));
		try {
			await pipe.waitClose();
			const line = Buffer.concat(outChunks).toString('utf8').trim().split(/\r?\n/).pop() ?? '';
			const [szStr, shaStr] = line.split('|');
			const sizeBytes = Number.parseInt(szStr ?? '', 10);
			if (!Number.isInteger(sizeBytes) || !/^[0-9a-f]{64}$/i.test(shaStr ?? '')) {
				throw new Error(`同云主机哈希回包异常: ${line}`);
			}
			return { sizeBytes, sha256: shaStr.toLowerCase() };
		} catch (err) {
			pipe.kill();
			if (!this.disposed && !this.shuttingDown) {
				await this.bestEffortDeleteTempFile(hostIp, remoteTmpPath, true).catch(() => undefined);
			}
			if (err instanceof SshPipeExitError) {
				if (err.stderr.includes('__ADE_ERR__:ENOENT')) {
					throw new AdeError('ERR_INVALID_ARGS', `远程源文件不存在: ${srcRemotePath}`);
				}
				throw new Error(`同云主机原子备份拷贝失败 (exit ${err.exitCode}): ${err.stderr}`);
			}
			throw err;
		}
	}

	private async streamBufferToRemoteVerified(
		hostIp: string,
		alias: string,
		dstRemotePath: string,
		buf: Buffer,
		expectedBytes: number,
		expectedSha256: string,
	): Promise<void> {
		const qd = posixQuoteRemotePath(dstRemotePath);
		const uuid = crypto.randomBytes(6).toString('hex');
		const qu = posixQuote(uuid);
		const remoteTmpPath = `${dstRemotePath}.tmp.${uuid}`;
		const qeb = posixQuote(String(expectedBytes));
		const qes = posixQuote(expectedSha256.toLowerCase());
		const script = [
			`set -e`,
			`d=${qd}; u=${qu}; eb=${qeb}; es=${qes}; tmp="$d.tmp.$u"`,
			`trap 'rm -f -- "$tmp"' EXIT INT TERM HUP`,
			`mkdir -p -m 700 -- "$(dirname -- "$d")"`,
			`cat > "$tmp"`,
			`sz=$(wc -c < "$tmp" | tr -d ' \\t\\r\\n')`,
			`sha=$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | awk '{print $1}' )`,
			`if [ "$sz" = "$eb" ] && [ "$sha" = "$es" ]; then chmod 600 "$tmp" 2>/dev/null || true; mv -f -- "$tmp" "$d"; printf 'OK\\n'; else rm -f -- "$tmp"; exit 9; fi`,
		].join('; ');
		const pipe = await this.openSshPipe(alias, script);
		const out: Buffer[] = [];
		pipe.stdout.on('data', (c: Buffer) => out.push(c));
		try {
			await Promise.all([
				pipeline(Readable.from(buf), pipe.stdin),
				pipe.waitClose().catch(err => {
					const e = err instanceof Error ? err : new Error(String(err));
					destroyStreamQuietly(pipe.stdin, e);
					throw e;
				}),
			]);
			const ack = Buffer.concat(out).toString('utf8').trim();
			if (!ack.endsWith('OK')) {
				throw new Error(`SSH 远程流写入完整性门禁未通过: 缺少 OK 确认帧`);
			}
		} catch (err) {
			pipe.kill();
			if (!this.disposed && !this.shuttingDown) {
				await this.bestEffortDeleteTempFile(hostIp, remoteTmpPath, true).catch(() => undefined);
			}
			if (err instanceof SshPipeExitError) {
				throw new Error(`SSH 远程流写入完整性门禁未通过 (exit ${err.exitCode}): ${err.stderr}`);
			}
			throw err;
		}
	}

	private async readRemoteFileVerified(
		alias: string,
		remotePath: string,
		expectedBytes: number,
		expectedSha256: string,
	): Promise<Buffer> {
		let resolvedExpectedBytes = isUnexpectedZeroExpectedBytes(expectedBytes, expectedSha256)
			? undefined
			: expectedBytes;
		let resolvedExpectedSha = expectedSha256;
		if (resolvedExpectedBytes === undefined || !resolvedExpectedSha) {
			let meta: { readonly sizeBytes: number; readonly sha256: string };
			try {
				meta = await this.probeRemoteSourceMeta(alias, remotePath);
			} catch (err) {
				if (err instanceof AdeError && err.code === 'ERR_INVALID_ARGS') {
					throw new AdeError('ERR_DETAIL_NOT_FOUND', `远程存储文件不存在: ${remotePath}`);
				}
				throw err;
			}
			if (resolvedExpectedBytes === undefined) {
				resolvedExpectedBytes = meta.sizeBytes;
			}
			if (!resolvedExpectedSha) {
				resolvedExpectedSha = meta.sha256;
			}
		}
		const qp = posixQuoteRemotePath(remotePath);
		const script = `p=${qp}; if [ ! -f "$p" ]; then echo "__ADE_ERR__:ENOENT" >&2; exit 2; fi; cat -- "$p"`;
		const pipe = await this.openSshPipe(alias, script);
		pipe.stdin.end();
		const chunks: Buffer[] = [];
		let actualBytes = 0;
		const hash = crypto.createHash('sha256');
		pipe.stdout.on('data', (c: Buffer) => {
			actualBytes += c.byteLength;
			hash.update(c);
			chunks.push(c);
		});
		let closeRes: { readonly exitCode: 0; readonly stderr: string };
		try {
			closeRes = await pipe.waitClose();
		} catch (err) {
			pipe.kill();
			if (err instanceof SshPipeExitError) {
				if (err.stderr.includes('__ADE_ERR__:ENOENT')) {
					throw new AdeError('ERR_DETAIL_NOT_FOUND', `远程存储文件不存在: ${remotePath}`);
				}
				throw new Error(`SSH 流读取未通过三重完整性门禁 (exit=${err.exitCode}, bytes=${actualBytes}/${resolvedExpectedBytes}): ${err.stderr}`);
			}
			throw err;
		}
		const actualSha = hash.digest('hex');
		if (!verifySshStreamIntegrityGate({
			exitCode: closeRes.exitCode,
			actualBytes,
			expectedBytes: resolvedExpectedBytes,
			actualSha256: actualSha,
			expectedSha256: resolvedExpectedSha,
		})) {
			throw new Error(`SSH 流读取未通过三重完整性门禁 (exit=${closeRes.exitCode}, bytes=${actualBytes}/${resolvedExpectedBytes}): ${closeRes.stderr}`);
		}
		return Buffer.concat(chunks);
	}

	private async transferCrossHostVerified(
		srcHost: string,
		srcPath: string,
		dstHost: string,
		dstPath: string,
		knownExpectedBytes?: number,
		knownExpectedSha256?: string,
	): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
		const uuid = crypto.randomBytes(6).toString('hex');

		// Case A: Remote `srcHost` -> Local `dstPath`
		if (srcHost !== 'local' && dstHost === 'local') {
			const srcInfo = await this.resolveRemoteHostInfo(srcHost);
			let expectedBytes = isUnexpectedZeroExpectedBytes(knownExpectedBytes, knownExpectedSha256)
				? undefined
				: knownExpectedBytes;
			let expectedSha = knownExpectedSha256;
			if (expectedBytes === undefined || !expectedSha) {
				const meta = await this.probeRemoteSourceMeta(srcInfo.alias, srcPath);
				if (expectedBytes === undefined) {
					expectedBytes = meta.sizeBytes;
				}
				if (!expectedSha) {
					expectedSha = meta.sha256;
				}
			}
			await fs.promises.mkdir(path.dirname(dstPath), { recursive: true });
			const tmpLocal = `${dstPath}.tmp.${process.pid}.${uuid}`;
			const pipe = await this.openSshPipe(srcInfo.alias, `p=${posixQuoteRemotePath(srcPath)}; if [ ! -f "$p" ]; then exit 2; fi; cat -- "$p"`);
			pipe.stdin.end();

			const hash = crypto.createHash('sha256');
			let actualBytes = 0;
			const ws = fs.createWriteStream(tmpLocal, { mode: 0o600, highWaterMark: 64 * 1024 });
			const meter = new Transform({
				highWaterMark: 64 * 1024,
				transform(chunk: Buffer, _enc, cb) {
					actualBytes += chunk.byteLength;
					hash.update(chunk);
					cb(null, chunk);
				},
			});
			try {
				const [, closeRes] = await Promise.all([
					pipeline(pipe.stdout, meter, ws),
					pipe.waitClose().catch(err => {
						const e = err instanceof Error ? err : new Error(String(err));
						destroyStreamQuietly(meter, e);
						destroyStreamQuietly(ws, e);
						throw e;
					}),
				]);
				const actualSha = hash.digest('hex');
				if (!verifySshStreamIntegrityGate({
					exitCode: closeRes.exitCode,
					actualBytes,
					expectedBytes,
					actualSha256: actualSha,
					expectedSha256: expectedSha,
				})) {
					await fs.promises.unlink(tmpLocal).catch(() => undefined);
					throw new Error(`SSH 下载流三重门禁拦截残缺文件 (exit=${closeRes.exitCode}, bytes=${actualBytes}/${expectedBytes}): ${closeRes.stderr}`);
				}
				await fs.promises.rename(tmpLocal, dstPath);
				return { sizeBytes: actualBytes, sha256: actualSha };
			} catch (err) {
				destroyStreamQuietly(meter);
				destroyStreamQuietly(ws);
				pipe.kill();
				await fs.promises.unlink(tmpLocal).catch(() => undefined);
				throw err;
			}
		}

		// Case B: Local `srcPath` -> Remote `dstHost`
		if (srcHost === 'local' && dstHost !== 'local') {
			const dstInfo = await this.resolveRemoteHostInfo(dstHost);
			let expectedBytes = isUnexpectedZeroExpectedBytes(knownExpectedBytes, knownExpectedSha256)
				? undefined
				: knownExpectedBytes;
			let expectedSha = knownExpectedSha256;
			if (expectedBytes === undefined || !expectedSha) {
				const localMeta = await this.computeLocalFileMeta(srcPath);
				if (expectedBytes === undefined) {
					expectedBytes = localMeta.sizeBytes;
				}
				if (!expectedSha) {
					expectedSha = localMeta.sha256;
				}
			}
			const remoteTmpPath = `${dstPath}.tmp.${uuid}`;
			const qd = posixQuoteRemotePath(dstPath);
			const qu = posixQuote(uuid);
			const qeb = posixQuote(String(expectedBytes));
			const qes = posixQuote(expectedSha.toLowerCase());
			const dstScript = [
				`set -e`,
				`d=${qd}; u=${qu}; eb=${qeb}; es=${qes}; tmp="$d.tmp.$u"`,
				`trap 'rm -f -- "$tmp"' EXIT INT TERM HUP`,
				`mkdir -p -- "$(dirname -- "$d")"`,
				`cat > "$tmp"`,
				`sz=$(wc -c < "$tmp" | tr -d ' \\t\\r\\n')`,
				`sha=$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | awk '{print $1}' )`,
				`if [ "$sz" = "$eb" ] && [ "$sha" = "$es" ]; then mv -f -- "$tmp" "$d"; printf 'OK\\n'; else rm -f -- "$tmp"; exit 9; fi`,
			].join('; ');

			const dstPipe = await this.openSshPipe(dstInfo.alias, dstScript);
			const ackChunks: Buffer[] = [];
			dstPipe.stdout.on('data', (c: Buffer) => ackChunks.push(c));
			const rs = fs.createReadStream(srcPath, { highWaterMark: 64 * 1024 });
			try {
				const [, closeRes] = await Promise.all([
					pipeline(rs, dstPipe.stdin),
					dstPipe.waitClose().catch(err => {
						const e = err instanceof Error ? err : new Error(String(err));
						destroyStreamQuietly(rs, e);
						throw e;
					}),
				]);
				const ack = Buffer.concat(ackChunks).toString('utf8').trim();
				if (closeRes.exitCode !== 0 || !ack.endsWith('OK')) {
					throw new Error(`SSH 上传流三重门禁校验失败 (exit=${closeRes.exitCode}): ${closeRes.stderr}`);
				}
				return { sizeBytes: expectedBytes, sha256: expectedSha };
			} catch (err) {
				destroyStreamQuietly(rs);
				dstPipe.kill();
				if (!this.disposed && !this.shuttingDown) {
					await this.bestEffortDeleteTempFile(dstInfo.ip, remoteTmpPath, true).catch(() => undefined);
				}
				throw err;
			}
		}

		// Case C: Heterogeneous Dual-Cloud `IP_A -> IP_B` pure memory pipe through local Mac (zero Mac temp file!)
		const srcInfo = await this.resolveRemoteHostInfo(srcHost);
		const dstInfo = await this.resolveRemoteHostInfo(dstHost);
		if (srcInfo.ip === dstInfo.ip) {
			return this.copySameRemoteToRemoteVerified(dstInfo.ip, srcInfo.alias, srcPath, dstPath, knownExpectedBytes, knownExpectedSha256);
		}
		let expectedBytes = isUnexpectedZeroExpectedBytes(knownExpectedBytes, knownExpectedSha256)
			? undefined
			: knownExpectedBytes;
		let expectedSha = knownExpectedSha256;
		if (expectedBytes === undefined || !expectedSha) {
			const meta = await this.probeRemoteSourceMeta(srcInfo.alias, srcPath);
			if (expectedBytes === undefined) {
				expectedBytes = meta.sizeBytes;
			}
			if (!expectedSha) {
				expectedSha = meta.sha256;
			}
		}
		const remoteTmpPath = `${dstPath}.tmp.${uuid}`;
		const qd = posixQuoteRemotePath(dstPath);
		const qu = posixQuote(uuid);
		const qeb = posixQuote(String(expectedBytes));
		const qes = posixQuote(expectedSha.toLowerCase());
		const dstScript = [
			`set -e`,
			`d=${qd}; u=${qu}; eb=${qeb}; es=${qes}; tmp="$d.tmp.$u"`,
			`trap 'rm -f -- "$tmp"' EXIT INT TERM HUP`,
			`mkdir -p -- "$(dirname -- "$d")"`,
			`cat > "$tmp"`,
			`sz=$(wc -c < "$tmp" | tr -d ' \\t\\r\\n')`,
			`sha=$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | awk '{print $1}' )`,
			`if [ "$sz" = "$eb" ] && [ "$sha" = "$es" ]; then mv -f -- "$tmp" "$d"; printf 'OK\\n'; else rm -f -- "$tmp"; exit 9; fi`,
		].join('; ');

		const dstPipe = await this.openSshPipe(dstInfo.alias, dstScript);
		const ackChunks: Buffer[] = [];
		dstPipe.stdout.on('data', (c: Buffer) => ackChunks.push(c));

		let srcPipe: Awaited<ReturnType<AdeDynamicStorageEngine['openSshPipe']>> | undefined;
		let meter: Transform | undefined;
		try {
			srcPipe = await this.openSshPipe(srcInfo.alias, `p=${posixQuoteRemotePath(srcPath)}; if [ ! -f "$p" ]; then exit 2; fi; cat -- "$p"`);
			srcPipe.stdin.end();

			const hash = crypto.createHash('sha256');
			let actualBytes = 0;
			meter = new Transform({
				highWaterMark: 64 * 1024,
				transform(chunk: Buffer, _enc, cb) {
					actualBytes += chunk.byteLength;
					hash.update(chunk);
					cb(null, chunk);
				},
			});

			const [, srcClose, dstClose] = await Promise.all([
				pipeline(srcPipe.stdout, meter, dstPipe.stdin),
				srcPipe.waitClose().catch(err => {
					const e = err instanceof Error ? err : new Error(String(err));
					destroyStreamQuietly(meter, e);
					destroyStreamQuietly(dstPipe.stdin, e);
					dstPipe.kill();
					throw e;
				}),
				dstPipe.waitClose().catch(err => {
					const e = err instanceof Error ? err : new Error(String(err));
					srcPipe?.kill();
					destroyStreamQuietly(srcPipe?.stdout, e);
					destroyStreamQuietly(meter, e);
					throw e;
				}),
			]);
			const actualSha = hash.digest('hex');
			const ack = Buffer.concat(ackChunks).toString('utf8').trim();
			if (
				!verifySshStreamIntegrityGate({
					exitCode: srcClose.exitCode,
					actualBytes,
					expectedBytes,
					actualSha256: actualSha,
					expectedSha256: expectedSha,
				})
				|| dstClose.exitCode !== 0
				|| !ack.endsWith('OK')
			) {
				throw new Error(`异构双云管道传输未通过三重门禁 (srcExit=${srcClose.exitCode}, dstExit=${dstClose.exitCode})`);
			}
			return { sizeBytes: actualBytes, sha256: actualSha };
		} catch (err) {
			destroyStreamQuietly(meter);
			srcPipe?.kill();
			dstPipe.kill();
			if (!this.disposed && !this.shuttingDown) {
				await this.bestEffortDeleteTempFile(dstInfo.ip, remoteTmpPath, true).catch(() => undefined);
			}
			throw err;
		}
	}

	private async computeLocalFileMeta(localPath: string): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(localPath);
		} catch {
			throw new AdeError('ERR_INVALID_ARGS', `本地文件不存在: ${localPath}`);
		}
		if (!st.isFile()) {
			throw new AdeError('ERR_INVALID_ARGS', `指定路径不是文件: ${localPath}`);
		}
		const hash = crypto.createHash('sha256');
		let sizeBytes = 0;
		const rs = fs.createReadStream(localPath, { highWaterMark: 64 * 1024 });
		try {
			await new Promise<void>((resolve, reject) => {
				rs.on('data', (c: Buffer | string) => {
					const b = typeof c === 'string' ? Buffer.from(c) : c;
					sizeBytes += b.byteLength;
					hash.update(b);
				});
				rs.once('error', reject);
				rs.once('end', () => resolve());
			});
		} catch (err) {
			destroyStreamQuietly(rs);
			throw err;
		}
		return { sizeBytes, sha256: hash.digest('hex') };
	}

	private async probeRemoteSourceMeta(alias: string, remotePath: string): Promise<{ readonly sizeBytes: number; readonly sha256: string }> {
		const qp = posixQuoteRemotePath(remotePath);
		const script = [
			`p=${qp}`,
			`if [ ! -f "$p" ]; then echo "__ADE_ERR__:ENOENT" >&2; exit 2; fi`,
			`sz=$(wc -c < "$p" | tr -d ' \\t\\r\\n')`,
			`sha=$( (sha256sum "$p" 2>/dev/null || shasum -a 256 "$p") | awk '{print $1}' )`,
			`printf '%s|%s\\n' "$sz" "$sha"`,
		].join('; ');
		const pipe = await this.openSshPipe(alias, script);
		pipe.stdin.end();
		const out: Buffer[] = [];
		pipe.stdout.on('data', (c: Buffer) => out.push(c));
		try {
			await pipe.waitClose();
		} catch (err) {
			if (err instanceof SshPipeExitError) {
				if (err.stderr.includes('__ADE_ERR__:ENOENT')) {
					throw new AdeError('ERR_INVALID_ARGS', `远程待读取文件不存在: ${remotePath}`);
				}
				throw new Error(`探测远程源文件哈希失败: ${err.stderr || `exit ${err.exitCode}`}`);
			}
			throw err;
		}
		const line = Buffer.concat(out).toString('utf8').trim().split(/\r?\n/).pop() ?? '';
		const [szStr, shaStr] = line.split('|');
		return {
			sizeBytes: Number.parseInt(szStr ?? '0', 10),
			sha256: (shaStr ?? '').toLowerCase(),
		};
	}

	private async validateAndResolveRemoteDownloadDest(
		hostIp: string,
		alias: string,
		remoteHome: string,
		rawDest: string,
		fallbackFilename: string,
		destIsDirHint: boolean,
	): Promise<string> {
		const trimmed = rawDest.trim();
		if (!trimmed) {
			throw new AdeError('ERR_INVALID_ARGS', '必须提供 --dest 目标路径');
		}
		if (/[\x00-\x1f]/.test(rawDest)) {
			throw new AdeError('ERR_INVALID_ARGS', '远程 --dest 目标路径禁止包含换行符或控制字符');
		}
		const cleanHome = remoteHome.replace(/\/+$/, '');
		const expanded = trimmed === '~'
			? cleanHome
			: (trimmed.startsWith('~/') ? path.posix.join(cleanHome, trimmed.slice(2)) : trimmed);
		if (!expanded.startsWith('/')) {
			throw new AdeError('ERR_INVALID_ARGS', `远程 --dest 路径必须为绝对路径: ${rawDest}`);
		}
		const safeFallback = sanitizeSafeFilename(fallbackFilename);
		const script = [
			`set -e`,
			`cand=${posixQuote(expanded)}`,
			`fb=${posixQuote(safeFallback)}`,
			`home_in=${posixQuote(cleanHome)}`,
			`is_dir=${destIsDirHint || trimmed.endsWith('/') ? '1' : '0'}`,
			'if [ -d "$cand" ]; then is_dir=1; fi',
			'if [ "$is_dir" = "1" ]; then base_c="${cand%/}"; if [ -z "$base_c" ]; then target="/$fb"; else target="$base_c/$fb"; fi; else target="$cand"; fi',
			'if [ -L "$target" ]; then echo "__ADE_ERR__:SYMLINK" >&2; exit 4; fi',
			'if [ -d "$target" ]; then echo "__ADE_ERR__:ISDIR" >&2; exit 4; fi',
			'anc=$(dirname -- "$target"); rel=$(basename -- "$target")',
			'if [ -z "$rel" ] || [ "$rel" = "." ] || [ "$rel" = ".." ]; then echo "__ADE_ERR__:INVALID" >&2; exit 4; fi',
			'while [ ! -e "$anc" ]; do if [ -L "$anc" ]; then echo "__ADE_ERR__:SYMLINK" >&2; exit 4; fi; seg=$(basename -- "$anc"); par=$(dirname -- "$anc"); if [ "$par" = "$anc" ]; then break; fi; if [ "$seg" = ".." ]; then echo "__ADE_ERR__:INVALID" >&2; exit 4; fi; if [ -n "$seg" ] && [ "$seg" != "." ]; then rel="$seg/$rel"; fi; anc="$par"; done',
			'if [ ! -d "$anc" ]; then echo "__ADE_ERR__:NOTDIR" >&2; exit 4; fi',
			'rp=$(cd -- "$anc" && pwd -P)',
			'if [ "$rp" = "/" ]; then final="/$rel"; else final="${rp%/}/$rel"; fi',
			'tlc() { printf \'%s\' "$1" | tr \'[:upper:]\' \'[:lower:]\'; }',
			't_lc=$(tlc "$target"); f_lc=$(tlc "$final")',
			'chk_exact() { p="${1%/}"; [ -n "$p" ] || return 0; p_lc=$(tlc "$p"); if [ "$t_lc" = "$p_lc" ] || [ "$f_lc" = "$p_lc" ]; then echo "__ADE_ERR__:FORBIDDEN" >&2; exit 5; fi; }',
			'chk_dir() { d="${1%/}"; [ -n "$d" ] || return 0; d_lc=$(tlc "$d"); case "$t_lc" in "$d_lc"|"$d_lc/"*) echo "__ADE_ERR__:FORBIDDEN" >&2; exit 5 ;; esac; case "$f_lc" in "$d_lc"|"$d_lc/"*) echo "__ADE_ERR__:FORBIDDEN" >&2; exit 5 ;; esac; if [ -d "$d" ]; then pd=$(cd -- "$d" 2>/dev/null && pwd -P || true); pd="${pd%/}"; if [ -n "$pd" ]; then pd_lc=$(tlc "$pd"); case "$t_lc" in "$pd_lc"|"$pd_lc/"*) echo "__ADE_ERR__:FORBIDDEN" >&2; exit 5 ;; esac; case "$f_lc" in "$pd_lc"|"$pd_lc/"*) echo "__ADE_ERR__:FORBIDDEN" >&2; exit 5 ;; esac; fi; fi; }',
			'for h in "$HOME" "$home_in"; do h="${h%/}"; [ -n "$h" ] || continue; chk_exact "$h"; chk_dir "$h/.ade_store"; chk_dir "$h/.aexus-code"; chk_dir "$h/.ssh"; if [ -d "$h" ]; then hp=$(cd -- "$h" 2>/dev/null && pwd -P || true); hp="${hp%/}"; if [ -n "$hp" ]; then chk_exact "$hp"; chk_dir "$hp/.ade_store"; chk_dir "$hp/.aexus-code"; chk_dir "$hp/.ssh"; fi; fi; done',
			'for sd in /etc /private/etc /var/root /private/var/root /System /bin /sbin /usr/bin /usr/sbin; do chk_dir "$sd"; done',
			'mkdir -p -- "$(dirname -- "$final")"',
			'printf \'__ADE_DEST_OK__:%s\\0\' "$final"',
		].join('\n');
		const release = await this.acquireSingleHostDataSlot(hostIp);
		try {
			const pipe = await this.openSshPipe(alias, script);
			pipe.stdin.end();
			const out: Buffer[] = [];
			pipe.stdout.on('data', (c: Buffer) => out.push(c));
			try {
				await pipe.waitClose();
			} catch (err) {
				if (err instanceof SshPipeExitError) {
					throw new AdeError('ERR_INVALID_ARGS', `非法的远程下载目标路径 (${rawDest}): ${err.stderr || `exit ${err.exitCode}`}`);
				}
				throw err;
			}
			const rawStdout = Buffer.concat(out).toString('utf8');
			const marker = '__ADE_DEST_OK__:';
			const mIdx = rawStdout.lastIndexOf(marker);
			const nulIdx = mIdx >= 0 ? rawStdout.indexOf('\0', mIdx + marker.length) : -1;
			const resolvedDest = mIdx >= 0 ? rawStdout.slice(mIdx + marker.length, nulIdx >= 0 ? nulIdx : undefined) : '';
			if (!resolvedDest.startsWith('/') || /[\x00-\x1f]/.test(resolvedDest)) {
				throw new AdeError('ERR_INVALID_ARGS', `远程下载目标路径校验回包异常: ${rawDest}`);
			}
			return resolvedDest;
		} finally {
			release();
		}
	}

	async deleteTempFileBestEffort(host: string, filePath: string): Promise<void> {
		await this.bestEffortDeleteTempFile(host, filePath, false);
	}

	private async bestEffortDeleteTempFile(host: string, filePath: string, alreadyHoldingHostSlot = false): Promise<void> {
		const trimmedHost = (host || 'local').trim() || 'local';
		if (trimmedHost === 'local') {
			await fs.promises.unlink(filePath).catch(() => undefined);
			return;
		}
		if (this.disposed || this.shuttingDown) {
			return;
		}
		try {
			const info = await this.resolveRemoteHostInfo(trimmedHost);
			const release = alreadyHoldingHostSlot ? undefined : await this.acquireSingleHostDataSlot(info.ip);
			try {
				const pipe = await this.openSshPipe(info.alias, `p=${posixQuoteRemotePath(filePath)}; if [ -f "$p" ] && [ ! -L "$p" ]; then rm -f -- "$p"; fi`);
				pipe.stdin.end();
				await pipe.waitClose();
			} finally {
				release?.();
			}
		} catch (err) {
			this.logService?.debug('[AdeDynamicStorageEngine] bestEffortDeleteTempFile ignored error', err);
		}
	}

	override dispose(): void {
		this.disposed = true;
		this.abortActiveStreamsForShutdown();
		for (const pool of this.hostDataPools.values()) {
			const waiters = pool.waiters.splice(0, pool.waiters.length);
			for (const w of waiters) {
				w.reject(new Error('AdeDynamicStorageEngine disposed'));
			}
		}
		this.hostDataPools.clear();
		super.dispose();
	}
}
