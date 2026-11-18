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

function sanitizePathSegment(raw: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
	if (!cleaned || cleaned === '.' || cleaned === '..') {
		throw new Error(`Invalid storage identifier: "${raw}"`);
	}
	return cleaned;
}

function execGit(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		let settled = false;
		const child = cp.spawn('git', args, {
			cwd,
			windowsHide: true,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				try { child.kill('SIGKILL'); } catch { /* ignore */ }
				resolve({ code: 124, stdout, stderr: `${stderr}\nGit command timed out after ${timeoutMs}ms`.trim() });
			}
		}, timeoutMs);
		child.stdout.on('data', chunk => {
			if (stdout.length < 256_000) {
				stdout += String(chunk);
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
				resolve({ code: 1, stdout: '', stderr: err.message });
			}
		});
		child.on('close', code => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ code: code ?? 1, stdout, stderr });
			}
		});
	});
}

const GIT_FALLBACK_IDENTITY_ARGS = ['-c', 'user.name=Aexus Engineering', '-c', 'user.email=engineering@aexus.local'] as const;

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
				const state = JSON.parse(rawState) as IAdeEngineeringTreeState;
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

	async captureWorkspaceSnapshot(cwd: string): Promise<IAdeWorkspaceSnapshot> {
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
				try {
					const stat = await fs.promises.stat(fullPath);
					let sha1: string;
					let textPreview: string | undefined;
					if (stat.size <= MAX_HASHED_FILE_BYTES) {
						const buf = await fs.promises.readFile(fullPath);
						sha1 = crypto.createHash('sha1').update(buf).digest('hex');
						if (stat.size <= MAX_TEXT_PREVIEW_BYTES && !buf.includes(0)) {
							textPreview = buf.toString('utf8');
						}
					} else {
						sha1 = `meta:${stat.size}:${Math.floor(stat.mtimeMs)}`;
					}
					entries[relPath] = {
						relativePath: relPath,
						size: stat.size,
						mtimeMs: stat.mtimeMs,
						sha1,
						...(textPreview !== undefined ? { textPreview } : {}),
					};
					count++;
				} catch {
					// Ignore transient file deletions during scan
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
		const allPaths = new Set<string>([
			...Object.keys(before.entries),
			...Object.keys(after.entries),
		]);

		const sortedPaths = [...allPaths].sort();
		const touchedFiles: IAdeTouchedFileChange[] = [];
		const diffChunks: string[] = [];
		let totalDiffChars = 0;

		for (const relPath of sortedPaths) {
			const prev = before.entries[relPath];
			const next = after.entries[relPath];
			if (prev && next && prev.sha1 === next.sha1) {
				continue;
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

		const safeGov = sanitizePathSegment(governorSessionId).slice(0, 12);
		const safeSeg = sanitizePathSegment(segmentId);
		const branchName = `aexus-eng/${safeGov}/${safeSeg}`;
		const worktreePath = path.join(this.getTreeDir(governorSessionId, 'engineering'), 'worktrees', safeSeg);

		await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });

		const exists = await fs.promises.stat(path.join(worktreePath, '.git')).then(() => true, () => false);
		if (!exists) {
			await execGit(projectPath, ['worktree', 'prune']);
			const baseRef = upstreamBranches[0] || 'HEAD';
			const addRes = await execGit(projectPath, ['worktree', 'add', '-B', branchName, worktreePath, baseRef]);
			if (addRes.code !== 0) {
				throw new Error(`Failed to create Git worktree for segment ${segmentId}: ${addRes.stderr || addRes.stdout}`);
			}
		}

		let mergeConflict: { readonly conflictedFiles: readonly string[]; readonly summary: string } | undefined;
		const branchesToMerge = exists ? upstreamBranches : upstreamBranches.slice(1);
		for (const upstreamBranch of branchesToMerge) {
			if (!upstreamBranch || upstreamBranch === branchName) {
				continue;
			}
			const mergeRes = await execGit(worktreePath, [...GIT_FALLBACK_IDENTITY_ARGS, 'merge', '--no-edit', upstreamBranch]);
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
			await execGit(worktreePath, ['add', '-A']);
			await execGit(worktreePath, [...GIT_FALLBACK_IDENTITY_ARGS, 'commit', '-m', message]);
		}
		const head = await execGit(worktreePath, ['rev-parse', 'HEAD']);
		return head.code === 0 ? head.stdout.trim() : undefined;
	}

	async mergeSegmentsIntoProject(
		projectPath: string,
		branches: readonly string[],
	): Promise<{ readonly ok: boolean; readonly conflictedFiles: readonly string[]; readonly summary: string }> {
		for (const branch of branches) {
			if (!branch) {
				continue;
			}
			const mergeRes = await execGit(projectPath, [...GIT_FALLBACK_IDENTITY_ARGS, 'merge', '--no-edit', branch]);
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

	async cleanupTreeWorktrees(governorSessionId: string, projectPath: string): Promise<void> {
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
			for (const b of branches) {
				await execGit(projectPath, ['branch', '-D', b]).catch(() => { });
			}
		}
	}
}
