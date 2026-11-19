/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ADE_CONTROL_DIR_NAME } from '../common/adeControl.js';
import {
	ADE_ENGINEERING_DIR_NAME,
	ADE_INBOX_FILE_NAME,
	ADE_RESEARCH_DIR_NAME,
	AdeWorkTreeType,
	IAdeEngineeringBackendService,
	IAdeEngineeringTreeState,
	IAdeInboxItem,
	IAdeSegmentWorktreeInfo,
	IAdeStoredEngineeringRecord,
	IAdeTouchedFileChange,
	IAdeVerificationResult,
	IAdeWorkerTurnChanges,
	IAdeWorkspaceFileSnapshotEntry,
	IAdeWorkspaceSnapshot,
} from '../common/adeEngineering.js';

const IGNORED_DIRS = new Set<string>([
	'.git',
	'node_modules',
	'.build',
	'out',
	'out-build',
	'dist',
	'build',
	'.next',
	'target',
	'__pycache__',
	'.venv',
	'venv',
	'.cache',
	'.turbo',
]);

const IGNORED_FILES = new Set<string>(['.DS_Store', 'Thumbs.db']);

const MAX_SNAPSHOT_FILES = 12_000;
const MAX_HASHED_FILE_BYTES = 1_048_576; // 1 MiB
const MAX_TEXT_PREVIEW_BYTES = 65_536; // 64 KiB
const MAX_DIFF_FILES = 40;
const MAX_TOTAL_DIFF_CHARS = 32_000;
const GIT_DELETED_SENTINEL = '__ade_git_deleted__';
const AEXUS_CO_AUTHOR_TRAILER = 'Co-authored-by: Aexus Engineering <ade@aexus.local>';
const NO_HOOKS_GIT_ARGS: readonly string[] = ['-c', 'core.hooksPath=/dev/null'];

export const ADE_SCRUBBED_CONTROL_ENV_KEYS: readonly string[] = [
	'AEXUS_ADE_CONTROL_FILE',
	'AEXUS_ADE_TOKEN',
	'AEXUS_ADE_SOCKET',
	'AEXUS_ADE_SESSION_TOKEN',
	'AEXUS_ADE_CALLER',
	'AEXUS_ADE_WINDOW_KEY',
	'AEXUS_ADE_ROLE_STATE_FILE',
];

const ADE_SCRUBBED_CONTROL_ENV_SET = new Set(ADE_SCRUBBED_CONTROL_ENV_KEYS);

/**
 * Strips Aexus ADE control-plane credentials and identity variables before spawning untrusted
 * repository hooks, Git subprocesses, or `verify:` verification shell commands inside Worker worktrees.
 */
export function scrubAdeControlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || ADE_SCRUBBED_CONTROL_ENV_SET.has(key.toUpperCase())) {
			continue;
		}
		sanitized[key] = value;
	}
	return sanitized;
}

export function buildVerificationSpawnSpec(
	command: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): {
	readonly bin: string;
	readonly args: readonly string[];
	readonly windowsVerbatimArguments?: boolean;
	readonly env: NodeJS.ProcessEnv;
} {
	const trimmed = command.trim();
	const sanitizedEnv: NodeJS.ProcessEnv = {
		...scrubAdeControlEnv(env),
		CI: '1',
		GIT_TERMINAL_PROMPT: '0',
	};
	if (platform === 'win32') {
		return {
			bin: env.ComSpec || env.COMSPEC || 'cmd.exe',
			args: ['/d', '/s', '/c', trimmed],
			windowsVerbatimArguments: true,
			env: sanitizedEnv,
		};
	}
	return {
		bin: '/bin/sh',
		args: ['-c', trimmed],
		env: sanitizedEnv,
	};
}

function sanitizePathSegment(raw: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
	if (!cleaned || cleaned === '.' || cleaned === '..') {
		throw new Error(`Invalid storage identifier: "${raw}"`);
	}
	return cleaned;
}

function execGitRaw(
	cwd: string,
	args: readonly string[],
	timeoutMs = 60_000,
	maxStdoutBytes = 256_000,
): Promise<{ code: number; stdout: Buffer; stderr: string; stdoutTruncated: boolean }> {
	return new Promise(resolve => {
		let settled = false;
		const fullArgs = process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args;
		const child = cp.spawn('git', fullArgs, {
			cwd,
			windowsHide: true,
			env: { ...scrubAdeControlEnv(process.env), GIT_TERMINAL_PROMPT: '0' },
		});
		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stdoutTruncated = false;
		let stderr = '';
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				if (process.platform === 'win32' && child.pid) {
					try { cp.spawn(path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
				} else {
					try { child.kill('SIGKILL'); } catch { /* ignore */ }
				}
				resolve({
					code: 124,
					stdout: Buffer.concat(stdoutChunks),
					stderr: `${stderr}\nGit command timed out after ${timeoutMs}ms`.trim(),
					stdoutTruncated,
				});
			}
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (stdoutBytes < maxStdoutBytes) {
				const remaining = maxStdoutBytes - stdoutBytes;
				if (buf.length <= remaining) {
					stdoutChunks.push(buf);
					stdoutBytes += buf.length;
				} else {
					stdoutChunks.push(buf.subarray(0, remaining));
					stdoutBytes += remaining;
					stdoutTruncated = true;
				}
			} else {
				stdoutTruncated = true;
			}
		});
		child.stderr.on('data', chunk => {
			if (stderr.length < 64_000) {
				stderr += String(chunk);
			}
		});
		child.on('error', err => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ code: 1, stdout: Buffer.alloc(0), stderr: err.message, stdoutTruncated: false });
			}
		});
		child.on('close', code => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ code: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr, stdoutTruncated });
			}
		});
	});
}

async function execGit(
	cwd: string,
	args: readonly string[],
	timeoutMs = 60_000,
	maxStdoutBytes = 256_000,
): Promise<{ code: number; stdout: string; stderr: string; stdoutTruncated: boolean }> {
	const raw = await execGitRaw(cwd, args, timeoutMs, maxStdoutBytes);
	return {
		code: raw.code,
		stdout: raw.stdout.toString('utf8'),
		stderr: raw.stderr,
		stdoutTruncated: raw.stdoutTruncated,
	};
}

/**
 * Preserves the user's configured Git `user.name` and `user.email` (required for DCO / signed commits),
 * falling back to Aexus Engineering defaults ONLY when either config value is unset.
 */
async function resolveGitIdentityArgs(cwd: string): Promise<string[]> {
	const [nameRes, emailRes] = await Promise.all([
		execGit(cwd, ['config', '--get', 'user.name'], 10_000),
		execGit(cwd, ['config', '--get', 'user.email'], 10_000),
	]);
	const args: string[] = [];
	if (nameRes.code !== 0 || !nameRes.stdout.trim()) {
		args.push('-c', 'user.name=Aexus Engineering');
	}
	if (emailRes.code !== 0 || !emailRes.stdout.trim()) {
		args.push('-c', 'user.email=engineering@aexus.local');
	}
	return args;
}

function splitFirstNSpaces(line: string, n: number): { readonly fields: string[]; readonly rest: string } {
	const fields: string[] = [];
	let start = 0;
	for (let i = 0; i < n; i++) {
		const idx = line.indexOf(' ', start);
		if (idx < 0) {
			fields.push(line.slice(start));
			return { fields, rest: '' };
		}
		fields.push(line.slice(start, idx));
		start = idx + 1;
	}
	return { fields, rest: line.slice(start) };
}

function parseGitPorcelainV2Z(raw: string): string[] {
	const tokens = raw.split('\0');
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) {
			continue;
		}
		if (token.startsWith('? ')) {
			const p = token.slice(2);
			if (p) {
				paths.push(p);
			}
		} else if (token.startsWith('1 ')) {
			const { rest } = splitFirstNSpaces(token, 8);
			if (rest) {
				paths.push(rest);
			}
		} else if (token.startsWith('2 ')) {
			const { rest } = splitFirstNSpaces(token, 9);
			if (rest) {
				paths.push(rest);
			}
			const origPath = tokens[i + 1];
			if (origPath) {
				paths.push(origPath);
			}
			i++; // consume origPath token
		} else if (token.startsWith('u ')) {
			const { rest } = splitFirstNSpaces(token, 10);
			if (rest) {
				paths.push(rest);
			}
		}
	}
	return paths;
}

async function readDiskSnapshotEntry(fullPath: string, relPath: string): Promise<IAdeWorkspaceFileSnapshotEntry | undefined> {
	try {
		const lstat = await fs.promises.lstat(fullPath);
		if (lstat.isSymbolicLink() || !lstat.isFile()) {
			return undefined;
		}
		let sha1: string;
		let textPreview: string | undefined;
		if (lstat.size <= MAX_HASHED_FILE_BYTES) {
			const buf = await fs.promises.readFile(fullPath);
			sha1 = crypto.createHash('sha1').update(buf).digest('hex');
			if (lstat.size <= MAX_TEXT_PREVIEW_BYTES && !buf.includes(0)) {
				textPreview = buf.toString('utf8');
			}
		} else {
			sha1 = `meta:${lstat.size}:${Math.floor(lstat.mtimeMs)}`;
		}
		return {
			relativePath: relPath,
			size: lstat.size,
			mtimeMs: lstat.mtimeMs,
			sha1,
			...(textPreview !== undefined ? { textPreview } : {}),
		};
	} catch {
		return undefined;
	}
}

async function readGitBlobSnapshotEntry(
	cwd: string,
	gitRef: string,
	repoRelPath: string,
	relPath: string,
): Promise<IAdeWorkspaceFileSnapshotEntry | undefined> {
	const res = await execGitRaw(cwd, ['show', `${gitRef}:${repoRelPath}`], 15_000, MAX_HASHED_FILE_BYTES + 1);
	if (res.code !== 0) {
		return undefined;
	}
	const buf = res.stdout;
	let sha1: string;
	let textPreview: string | undefined;
	if (!res.stdoutTruncated && buf.length <= MAX_HASHED_FILE_BYTES) {
		sha1 = crypto.createHash('sha1').update(buf).digest('hex');
		if (buf.length <= MAX_TEXT_PREVIEW_BYTES && !buf.includes(0)) {
			textPreview = buf.toString('utf8');
		}
	} else {
		sha1 = `git:${gitRef}:${repoRelPath}`;
	}
	return {
		relativePath: relPath,
		size: buf.length,
		mtimeMs: 0,
		sha1,
		...(textPreview !== undefined ? { textPreview } : {}),
	};
}

function buildCompactLineDiff(relativePath: string, beforeText: string | undefined, afterText: string | undefined): string {
	const oldLines = beforeText !== undefined ? beforeText.replace(/\r\n/g, '\n').split('\n') : [];
	const newLines = afterText !== undefined ? afterText.replace(/\r\n/g, '\n').split('\n') : [];

	const header = [
		`--- ${beforeText === undefined ? '/dev/null' : `a/${relativePath}`}`,
		`+++ ${afterText === undefined ? '/dev/null' : `b/${relativePath}`}`,
	];

	if (beforeText === undefined) {
		const preview = newLines.slice(0, 80).map(l => `+${l}`);
		if (newLines.length > 80) {
			preview.push(`+... (${newLines.length - 80} more lines)`);
		}
		return [...header, `@@ -0,0 +1,${newLines.length} @@`, ...preview].join('\n');
	}
	if (afterText === undefined) {
		const preview = oldLines.slice(0, 60).map(l => `-${l}`);
		if (oldLines.length > 60) {
			preview.push(`-... (${oldLines.length - 60} more lines)`);
		}
		return [...header, `@@ -1,${oldLines.length} +0,0 @@`, ...preview].join('\n');
	}

	// Find common prefix and common suffix for fast, readable hunk generation
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}
	let oldEnd = oldLines.length - 1;
	let newEnd = newLines.length - 1;
	while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
		oldEnd--;
		newEnd--;
	}

	const ctxBeforeStart = Math.max(0, prefix - 3);
	const ctxAfterOldEnd = Math.min(oldLines.length - 1, oldEnd + 3);
	const hunkLines: string[] = [];
	for (let i = ctxBeforeStart; i < prefix; i++) {
		hunkLines.push(` ${oldLines[i]}`);
	}
	const removedSlice = oldLines.slice(prefix, oldEnd + 1);
	const addedSlice = newLines.slice(prefix, newEnd + 1);
	for (const line of removedSlice.slice(0, 80)) {
		hunkLines.push(`-${line}`);
	}
	if (removedSlice.length > 80) {
		hunkLines.push(`-... (${removedSlice.length - 80} more removed lines)`);
	}
	for (const line of addedSlice.slice(0, 80)) {
		hunkLines.push(`+${line}`);
	}
	if (addedSlice.length > 80) {
		hunkLines.push(`+... (${addedSlice.length - 80} more added lines)`);
	}
	for (let i = oldEnd + 1; i <= ctxAfterOldEnd; i++) {
		hunkLines.push(` ${oldLines[i]}`);
	}

	return [
		...header,
		`@@ -${ctxBeforeStart + 1},${Math.max(0, ctxAfterOldEnd - ctxBeforeStart + 1)} +${ctxBeforeStart + 1},${Math.max(0, newEnd - ctxBeforeStart + 1 + (ctxAfterOldEnd - oldEnd))} @@`,
		...hunkLines,
	].join('\n');
}

export interface IAdeEngineeringNodeServiceOptions {
	readonly baseDir?: string;
}

/**
 * Node-side persistence, single-Worker workspace file snapshot/diff engine,
 * and optional Git Worktree sandbox isolator for ADE Engineering & Research trees.
 */
export class AdeEngineeringNodeService extends Disposable implements IAdeEngineeringBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly baseDir: string;

	constructor(options?: IAdeEngineeringNodeServiceOptions) {
		super();
		this.baseDir = options?.baseDir || process.env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
	}

	private getCategoryDir(treeType: AdeWorkTreeType): string {
		return path.join(this.baseDir, treeType === 'research' ? ADE_RESEARCH_DIR_NAME : ADE_ENGINEERING_DIR_NAME);
	}

	private getTreeDir(governorSessionId: string, treeType: AdeWorkTreeType): string {
		return path.join(this.getCategoryDir(treeType), sanitizePathSegment(governorSessionId));
	}

	private getInboxPath(): string {
		return path.join(this.baseDir, ADE_INBOX_FILE_NAME);
	}

	private async writeAtomicFile(filePath: string, content: string): Promise<void> {
		const dir = path.dirname(filePath);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
		await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
		if (!isWindows) {
			await fs.promises.chmod(tmpPath, 0o600).catch(() => { });
		}
		await fs.promises.rename(tmpPath, filePath);
	}

	async listStoredTrees(treeType?: AdeWorkTreeType): Promise<readonly IAdeStoredEngineeringRecord[]> {
		const types: AdeWorkTreeType[] = treeType ? [treeType] : ['engineering', 'research'];
		const records: IAdeStoredEngineeringRecord[] = [];
		for (const kind of types) {
			const catDir = this.getCategoryDir(kind);
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(catDir, { withFileTypes: true });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					continue;
				}
				throw err;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const loaded = await this.loadTree(entry.name, kind);
				if (loaded) {
					records.push(loaded);
				}
			}
		}
		return records;
	}

	async loadTree(governorSessionId: string, treeType?: AdeWorkTreeType): Promise<IAdeStoredEngineeringRecord | undefined> {
		const candidates: AdeWorkTreeType[] = treeType ? [treeType] : ['engineering', 'research'];
		for (const kind of candidates) {
			const dir = this.getTreeDir(governorSessionId, kind);
			const blueprintPath = path.join(dir, 'blueprint.md');
			const statePath = path.join(dir, 'state.json');
			try {
				const [blueprintText, rawState] = await Promise.all([
					fs.promises.readFile(blueprintPath, 'utf8'),
					fs.promises.readFile(statePath, 'utf8'),
				]);
				let state: IAdeEngineeringTreeState;
				try {
					state = JSON.parse(rawState) as IAdeEngineeringTreeState;
				} catch {
					continue;
				}
				if (!state || typeof state !== 'object') {
					continue;
				}
				return {
					governorSessionId,
					treeType: state.treeType || kind,
					blueprintText,
					state: { ...state, governorSessionId },
				};
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
					continue;
				}
				throw err;
			}
		}
		return undefined;
	}

	async saveTree(record: IAdeStoredEngineeringRecord): Promise<void> {
		const dir = this.getTreeDir(record.governorSessionId, record.treeType);
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		await Promise.all([
			this.writeAtomicFile(path.join(dir, 'blueprint.md'), record.blueprintText),
			this.writeAtomicFile(path.join(dir, 'state.json'), JSON.stringify(record.state, null, '\t') + '\n'),
		]);
	}

	async deleteTree(governorSessionId: string, treeType?: AdeWorkTreeType): Promise<void> {
		const candidates: AdeWorkTreeType[] = treeType ? [treeType] : ['engineering', 'research'];
		for (const kind of candidates) {
			const dir = this.getTreeDir(governorSessionId, kind);
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
		}
	}

	async loadInbox(): Promise<readonly IAdeInboxItem[]> {
		const inboxPath = this.getInboxPath();
		try {
			const raw = await fs.promises.readFile(inboxPath, 'utf8');
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed as IAdeInboxItem[] : [];
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			await fs.promises.copyFile(inboxPath, `${inboxPath}.corrupt.${Date.now()}`).catch(() => { });
			return [];
		}
	}

	async saveInbox(items: readonly IAdeInboxItem[]): Promise<void> {
		await this.writeAtomicFile(this.getInboxPath(), JSON.stringify(items, null, '\t') + '\n');
	}

	private async captureGitDirtySnapshot(cwd: string): Promise<IAdeWorkspaceSnapshot | undefined> {
		const insideRes = await execGit(cwd, ['rev-parse', '--is-inside-work-tree'], 10_000);
		if (insideRes.code !== 0 || insideRes.stdout.trim() !== 'true') {
			return undefined;
		}
		const [prefixRes, headRes, statusRes] = await Promise.all([
			execGit(cwd, ['rev-parse', '--show-prefix'], 10_000),
			execGit(cwd, ['rev-parse', '--verify', 'HEAD'], 10_000),
			execGit(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.'], 30_000, 4_000_000),
		]);
		if (statusRes.code !== 0) {
			return undefined;
		}
		const prefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : '';
		const gitHead = headRes.code === 0 ? headRes.stdout.trim() : undefined;
		const repoPaths = parseGitPorcelainV2Z(statusRes.stdout);
		const entries: Record<string, IAdeWorkspaceFileSnapshotEntry> = {};
		const seen = new Set<string>();

		for (const repoPath of repoPaths) {
			const normalizedRepoPath = repoPath.replace(/\\/g, '/');
			let relPath = normalizedRepoPath;
			if (prefix) {
				if (!normalizedRepoPath.startsWith(prefix)) {
					continue;
				}
				relPath = normalizedRepoPath.slice(prefix.length);
			}
			if (!relPath || seen.has(relPath)) {
				continue;
			}
			const baseName = path.basename(relPath);
			if (IGNORED_FILES.has(baseName)) {
				continue;
			}
			seen.add(relPath);
			const fullPath = path.join(cwd, relPath);
			const diskEntry = await readDiskSnapshotEntry(fullPath, relPath);
			if (diskEntry) {
				entries[relPath] = diskEntry;
			} else {
				// Record tracked deletion explicitly so diffing against a clean HEAD snapshot detects deletions.
				entries[relPath] = {
					relativePath: relPath,
					size: 0,
					mtimeMs: 0,
					sha1: GIT_DELETED_SENTINEL,
				};
			}
		}

		return {
			rootPath: cwd,
			capturedAt: Date.now(),
			entries,
			gitDirtyMode: true,
			...(gitHead ? { gitHead } : {}),
			...(statusRes.stdoutTruncated ? { truncated: true } : {}),
		};
	}

	async captureWorkspaceSnapshot(cwd: string): Promise<IAdeWorkspaceSnapshot> {
		const gitSnapshot = await this.captureGitDirtySnapshot(cwd);
		if (gitSnapshot) {
			return gitSnapshot;
		}

		const entries: Record<string, IAdeWorkspaceFileSnapshotEntry> = {};
		let count = 0;

		const walk = async (absDir: string, relPrefix: string): Promise<void> => {
			if (count >= MAX_SNAPSHOT_FILES) {
				return;
			}
			let dirents: fs.Dirent[];
			try {
				dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			dirents.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of dirents) {
				if (count >= MAX_SNAPSHOT_FILES) {
					break;
				}
				if (entry.isSymbolicLink()) {
					continue;
				}
				if (entry.isDirectory()) {
					if (IGNORED_DIRS.has(entry.name)) {
						continue;
					}
					const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
					await walk(path.join(absDir, entry.name), nextRel);
					continue;
				}
				if (!entry.isFile() || IGNORED_FILES.has(entry.name)) {
					continue;
				}
				const fullPath = path.join(absDir, entry.name);
				const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
				const diskEntry = await readDiskSnapshotEntry(fullPath, relPath);
				if (diskEntry) {
					entries[relPath] = diskEntry;
					count++;
				}
			}
		};

		await walk(cwd, '');
		return {
			rootPath: cwd,
			capturedAt: Date.now(),
			entries,
			...(count >= MAX_SNAPSHOT_FILES ? { truncated: true } : {}),
		};
	}

	async computeWorkerTurnChanges(
		cwd: string,
		before: IAdeWorkspaceSnapshot,
		ignoreSiblingSha1s?: Readonly<Record<string, string | null>>,
	): Promise<IAdeWorkerTurnChanges> {
		const after = await this.captureWorkspaceSnapshot(cwd);
		const isGitDirtyDiff = Boolean(before.gitDirtyMode && after.gitDirtyMode);
		const allPaths = new Set<string>([
			...Object.keys(before.entries),
			...Object.keys(after.entries),
		]);

		let gitPrefix = '';
		if (isGitDirtyDiff) {
			const prefixRes = await execGit(cwd, ['rev-parse', '--show-prefix'], 10_000);
			gitPrefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : '';
			const addRepoPaths = (rawNullSeparated: string) => {
				for (const rawPath of rawNullSeparated.split('\0')) {
					if (!rawPath) {
						continue;
					}
					const norm = rawPath.replace(/\\/g, '/');
					const rel = gitPrefix
						? (norm.startsWith(gitPrefix) ? norm.slice(gitPrefix.length) : '')
						: norm;
					if (rel && !IGNORED_FILES.has(path.basename(rel))) {
						allPaths.add(rel);
					}
				}
			};
			if (before.gitHead && after.gitHead && before.gitHead !== after.gitHead) {
				const commitDiff = await execGit(cwd, ['diff', '--name-only', '-z', before.gitHead, after.gitHead, '--', '.'], 20_000, 2_000_000);
				if (commitDiff.code === 0) {
					addRepoPaths(commitDiff.stdout);
				}
			} else if (!before.gitHead && after.gitHead) {
				const initialTree = await execGit(cwd, ['ls-tree', '-r', '--name-only', '-z', after.gitHead, '--', '.'], 20_000, 2_000_000);
				if (initialTree.code === 0) {
					addRepoPaths(initialTree.stdout);
				}
			}
		}

		const sortedPaths = [...allPaths].sort();
		const touchedFiles: IAdeTouchedFileChange[] = [];
		const diffChunks: string[] = [];
		let totalDiffChars = 0;

		for (const relPath of sortedPaths) {
			const rawPrev = before.entries[relPath];
			const rawNext = after.entries[relPath];
			if (rawPrev && rawNext && rawPrev.sha1 === rawNext.sha1) {
				continue;
			}

			let prev: IAdeWorkspaceFileSnapshotEntry | undefined;
			let next: IAdeWorkspaceFileSnapshotEntry | undefined;
			if (isGitDirtyDiff) {
				const repoRelPath = gitPrefix ? `${gitPrefix}${relPath}` : relPath;
				if (rawPrev) {
					prev = rawPrev.sha1 === GIT_DELETED_SENTINEL ? undefined : rawPrev;
				} else if (before.gitHead) {
					prev = await readGitBlobSnapshotEntry(cwd, before.gitHead, repoRelPath, relPath);
				}
				if (rawNext) {
					next = rawNext.sha1 === GIT_DELETED_SENTINEL ? undefined : rawNext;
				} else {
					next = await readDiskSnapshotEntry(path.join(cwd, relPath), relPath);
				}
				if (!prev && !next) {
					continue;
				}
				if (prev && next && prev.sha1 === next.sha1) {
					continue;
				}
			} else {
				prev = rawPrev;
				next = rawNext;
			}

			// Shared-Root Concurrent Sibling Isolation:
			// Exclude file changes whose exact post-turn state was recorded by a parallel sibling node
			// that completed while this Worker turn was in flight.
			if (ignoreSiblingSha1s && Object.prototype.hasOwnProperty.call(ignoreSiblingSha1s, relPath)) {
				const siblingSha1 = ignoreSiblingSha1s[relPath];
				if (siblingSha1 === null && !next) {
					continue;
				}
				if (typeof siblingSha1 === 'string' && next?.sha1 === siblingSha1) {
					continue;
				}
			}
			const kind: 'added' | 'modified' | 'deleted' = !prev
				? 'added'
				: !next
					? 'deleted'
					: 'modified';

			let fileDiff: string | undefined;
			if (touchedFiles.length < MAX_DIFF_FILES && totalDiffChars < MAX_TOTAL_DIFF_CHARS) {
				if ((prev?.textPreview !== undefined || !prev) && (next?.textPreview !== undefined || !next)) {
					fileDiff = buildCompactLineDiff(relPath, prev?.textPreview, next?.textPreview);
				} else {
					const gitRes = await execGit(cwd, ['diff', '--no-ext-diff', '--', relPath]);
					if (gitRes.code === 0 && gitRes.stdout.trim()) {
						fileDiff = gitRes.stdout.trim();
					} else {
						fileDiff = `--- a/${relPath}\n+++ b/${relPath}\n@@ binary or large file ${kind} (${prev?.size ?? 0}B -> ${next?.size ?? 0}B) @@`;
					}
				}

				if (fileDiff) {
					const remaining = MAX_TOTAL_DIFF_CHARS - totalDiffChars;
					if (fileDiff.length > remaining) {
						fileDiff = fileDiff.slice(0, remaining) + '\n... (diff truncated)';
					}
					totalDiffChars += fileDiff.length;
					diffChunks.push(fileDiff);
				}
			}

			touchedFiles.push({
				relativePath: relPath,
				kind,
				...(next?.sha1 ? { afterSha1: next.sha1 } : {}),
				...(fileDiff ? { diff: fileDiff } : {}),
			});
		}

		return {
			capturedAt: Date.now(),
			touchedFiles,
			combinedDiff: diffChunks.join('\n\n'),
			...((before.truncated || after.truncated || touchedFiles.length > MAX_DIFF_FILES) ? { truncated: true } : {}),
		};
	}

	async ensureSegmentWorktree(
		governorSessionId: string,
		projectPath: string,
		segmentId: string,
		upstreamBranches: readonly string[],
	): Promise<{
		readonly worktree: IAdeSegmentWorktreeInfo;
		readonly mergeConflict?: { readonly conflictedFiles: readonly string[]; readonly summary: string };
	}> {
		const headRes = await execGit(projectPath, ['rev-parse', '--verify', 'HEAD']);
		if (headRes.code !== 0) {
			throw new Error(`Git Worktree isolation requires an initialized Git repository with at least one commit (${projectPath}).`);
		}

		const existing = await this.loadTree(governorSessionId).catch(() => undefined);
		const treeType: AdeWorkTreeType = existing?.treeType ?? 'engineering';
		const safeGov = sanitizePathSegment(governorSessionId).slice(0, 12);
		const safeSeg = sanitizePathSegment(segmentId);
		const branchName = `aexus-eng/${safeGov}/${safeSeg}`;
		const worktreePath = path.join(this.getTreeDir(governorSessionId, treeType), 'worktrees', safeSeg);

		await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });

		const exists = await fs.promises.stat(path.join(worktreePath, '.git')).then(() => true, () => false);
		let reusedExistingBranch = exists;
		if (!exists) {
			await execGit(projectPath, ['worktree', 'prune']);
			const branchRefRes = await execGit(projectPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
			if (branchRefRes.code === 0) {
				// Reuse existing segment branch safely without destructive `-B` reset.
				reusedExistingBranch = true;
				const attachRes = await execGit(projectPath, [...NO_HOOKS_GIT_ARGS, 'worktree', 'add', worktreePath, branchName]);
				if (attachRes.code !== 0) {
					throw new Error(`Failed to attach existing Git worktree branch ${branchName} for segment ${segmentId}: ${attachRes.stderr || attachRes.stdout}`);
				}
			} else {
				const baseRef = upstreamBranches[0] || 'HEAD';
				const addRes = await execGit(projectPath, [...NO_HOOKS_GIT_ARGS, 'worktree', 'add', '-b', branchName, worktreePath, baseRef]);
				if (addRes.code !== 0) {
					throw new Error(`Failed to create Git worktree for segment ${segmentId}: ${addRes.stderr || addRes.stdout}`);
				}
			}
		}

		let mergeConflict: { readonly conflictedFiles: readonly string[]; readonly summary: string } | undefined;
		const branchesToMerge = reusedExistingBranch ? upstreamBranches : upstreamBranches.slice(1);
		const identityArgs = branchesToMerge.length > 0 ? await resolveGitIdentityArgs(worktreePath) : [];
		for (const upstreamBranch of branchesToMerge) {
			if (!upstreamBranch || upstreamBranch === branchName) {
				continue;
			}
			const mergeRes = await execGit(worktreePath, [...NO_HOOKS_GIT_ARGS, ...identityArgs, 'merge', '--no-edit', upstreamBranch]);
			if (mergeRes.code !== 0) {
				const unmerged = await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
				const conflictedFiles = unmerged.stdout.split('\n').map(s => s.trim()).filter(Boolean);
				mergeConflict = {
					conflictedFiles: conflictedFiles.length > 0 ? conflictedFiles : [`(${upstreamBranch})`],
					summary: (mergeRes.stdout + '\n' + mergeRes.stderr).trim(),
				};
				break;
			}
		}

		const wtHead = await execGit(worktreePath, ['rev-parse', 'HEAD']);
		return {
			worktree: {
				segmentId,
				branchName,
				worktreePath,
				headCommit: wtHead.code === 0 ? wtHead.stdout.trim() : undefined,
			},
			...(mergeConflict ? { mergeConflict } : {}),
		};
	}

	async commitSegmentWorktree(worktreePath: string, message: string): Promise<string | undefined> {
		const status = await execGit(worktreePath, ['status', '--porcelain']);
		if (status.code === 0 && status.stdout.trim()) {
			const identityArgs = await resolveGitIdentityArgs(worktreePath);
			const fullMessage = message.includes(AEXUS_CO_AUTHOR_TRAILER)
				? message
				: `${message.trim()}\n\n${AEXUS_CO_AUTHOR_TRAILER}`;
			await execGit(worktreePath, ['add', '-A']);
			await execGit(worktreePath, [...NO_HOOKS_GIT_ARGS, ...identityArgs, 'commit', '-m', fullMessage]);
		}
		const head = await execGit(worktreePath, ['rev-parse', 'HEAD']);
		return head.code === 0 ? head.stdout.trim() : undefined;
	}

	async mergeSegmentsIntoProject(
		projectPath: string,
		branches: readonly string[],
	): Promise<{ readonly ok: boolean; readonly conflictedFiles: readonly string[]; readonly summary: string }> {
		const dirtyRes = await execGit(projectPath, ['status', '--porcelain']);
		if (dirtyRes.code === 0 && dirtyRes.stdout.trim()) {
			const dirtyFiles = dirtyRes.stdout
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
				.map(line => line.replace(/^[A-Z?!]{1,2}\s+/, '').trim());
			return {
				ok: false,
				conflictedFiles: dirtyFiles.length > 0 ? dirtyFiles : ['(dirty working tree)'],
				summary: `Refused to merge segment branches: working tree at ${projectPath} has uncommitted changes (${dirtyFiles.slice(0, 5).join(', ')}). Commit or stash local changes first.`,
			};
		}

		const identityArgs = await resolveGitIdentityArgs(projectPath);
		for (const branch of branches) {
			if (!branch) {
				continue;
			}
			const mergeRes = await execGit(projectPath, [...NO_HOOKS_GIT_ARGS, ...identityArgs, 'merge', '--no-edit', branch]);
			if (mergeRes.code !== 0) {
				const unmerged = await execGit(projectPath, ['diff', '--name-only', '--diff-filter=U']);
				const conflictedFiles = unmerged.stdout.split('\n').map(s => s.trim()).filter(Boolean);
				await execGit(projectPath, ['merge', '--abort']).catch(() => { });
				return {
					ok: false,
					conflictedFiles: conflictedFiles.length > 0 ? conflictedFiles : [branch],
					summary: (mergeRes.stdout + '\n' + mergeRes.stderr).trim(),
				};
			}
		}
		return { ok: true, conflictedFiles: [], summary: 'Merged cleanly.' };
	}

	async cleanupTreeWorktrees(governorSessionId: string, projectPath: string, force = false): Promise<void> {
		for (const kind of ['engineering', 'research'] as const) {
			const wtRoot = path.join(this.getTreeDir(governorSessionId, kind), 'worktrees');
			let entries: fs.Dirent[] = [];
			try {
				entries = await fs.promises.readdir(wtRoot, { withFileTypes: true });
			} catch {
				entries = [];
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const wtPath = path.join(wtRoot, entry.name);
					await execGit(projectPath, ['worktree', 'remove', '--force', wtPath]).catch(() => { });
				}
			}
			await fs.promises.rm(wtRoot, { recursive: true, force: true }).catch(() => { });
		}
		await execGit(projectPath, ['worktree', 'prune']).catch(() => { });
		const safeGov = sanitizePathSegment(governorSessionId).slice(0, 12);
		const branchList = await execGit(projectPath, ['branch', '--list', `aexus-eng/${safeGov}/*`]).catch(() => ({ code: 1, stdout: '', stderr: '' }));
		if (branchList.code === 0 && branchList.stdout.trim()) {
			const branches = branchList.stdout.split('\n').map(line => line.replace(/^\*?\s+/, '').trim()).filter(Boolean);
			const deleteFlag = force ? '-D' : '-d';
			for (const b of branches) {
				await execGit(projectPath, ['branch', deleteFlag, b]).catch(() => { });
			}
		}
	}

	async runNodeVerificationCommand(cwd: string, command: string, timeoutMs = 120_000): Promise<IAdeVerificationResult> {
		const trimmed = command.trim();
		const startedAt = Date.now();
		if (!trimmed) {
			return { passed: true, exitCode: 0, output: '', durationMs: 0 };
		}
		return new Promise(resolve => {
			let settled = false;
			const spawnSpec = buildVerificationSpawnSpec(trimmed, process.platform, process.env);
			const child = cp.spawn(spawnSpec.bin, spawnSpec.args, {
				cwd,
				windowsHide: true,
				detached: !isWindows,
				...(spawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
				env: spawnSpec.env,
			});
			const maxBytes = 16_000;
			let combined = '';
			const appendChunk = (chunk: unknown) => {
				if (combined.length < maxBytes) {
					combined += String(chunk).slice(0, maxBytes - combined.length);
				}
			};
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					if (isWindows && child.pid) {
						try { cp.spawn(path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
					} else if (child.pid) {
						try {
							process.kill(-child.pid, 'SIGKILL');
						} catch {
							try { child.kill('SIGKILL'); } catch { /* ignore */ }
						}
					}
					resolve({
						passed: false,
						exitCode: 124,
						output: `${combined}\n[Verification command timed out after ${timeoutMs}ms]`.trim(),
						durationMs: Math.max(0, Date.now() - startedAt),
					});
				}
			}, Math.max(1000, timeoutMs));
			child.stdout.on('data', appendChunk);
			child.stderr.on('data', appendChunk);
			child.on('error', err => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve({
						passed: false,
						exitCode: 1,
						output: err.message,
						durationMs: Math.max(0, Date.now() - startedAt),
					});
				}
			});
			child.on('close', code => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					const exitCode = code ?? 1;
					resolve({
						passed: exitCode === 0,
						exitCode,
						output: combined.trim(),
						durationMs: Math.max(0, Date.now() - startedAt),
					});
				}
			});
		});
	}
}
