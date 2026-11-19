/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADE_SCRUBBED_CONTROL_ENV_KEYS,
	AdeEngineeringNodeService,
	buildVerificationSpawnSpec,
	scrubAdeControlEnv,
} from '../../node/adeEngineeringService.js';

function runGitSync(cwd: string, args: string[]): void {
	cp.execFileSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

suite('AdeEngineeringNodeService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let tmpDir: string;

	setup(async () => {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ade-eng-node-'));
	});

	teardown(async () => {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	});

	test('persists engineering & research trees and inbox under baseDir with zero repo pollution', async () => {
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const projectDir = path.join(tmpDir, 'my-project');
		await fs.promises.mkdir(projectDir, { recursive: true });
		await fs.promises.writeFile(path.join(projectDir, 'index.ts'), 'export const v = 1;\n', 'utf8');

		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			await svc.saveTree({
				governorSessionId: 'gov-123',
				treeType: 'engineering',
				blueprintText: '```mermaid\nflowchart LR\n  N1["Init"]\n```\n',
				state: {
					treeType: 'engineering',
					governorSessionId: 'gov-123',
					projectPath: projectDir,
					runStatus: 'idle',
					createdAt: 100,
					updatedAt: 200,
					managerAgentsBySegment: {},
					nodes: {},
					reports: {},
					events: [],
				},
			});

			await svc.saveInbox([{
				id: 'msg-1',
				kind: 'governor_message',
				treeType: 'engineering',
				governorSessionId: 'gov-123',
				governorLabel: 'Gov Alpha',
				projectPath: projectDir,
				projectName: 'my-project',
				title: 'Circuit Breaker',
				message: 'Need human review',
				unread: true,
				resolved: false,
				createdAt: 300,
			}]);

			const loaded = await svc.loadTree('gov-123');
			assert.ok(loaded);
			assert.strictEqual(loaded.governorSessionId, 'gov-123');
			assert.strictEqual(loaded.state.projectPath, projectDir);

			const listed = await svc.listStoredTrees('engineering');
			assert.strictEqual(listed.length, 1);

			const inbox = await svc.loadInbox();
			assert.strictEqual(inbox.length, 1);
			assert.strictEqual(inbox[0].title, 'Circuit Breaker');

			// Verify zero hidden files created inside projectDir
			const projectFiles = await fs.promises.readdir(projectDir);
			assert.deepStrictEqual(projectFiles, ['index.ts']);

			await svc.deleteTree('gov-123');
			assert.strictEqual(await svc.loadTree('gov-123'), undefined);
		} finally {
			svc.dispose();
		}
	});

	test('captures single-Worker touched files & unified diff while ignoring parallel untouched dirty files', async () => {
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const projectDir = path.join(tmpDir, 'shared-project');
		await fs.promises.mkdir(path.join(projectDir, 'src'), { recursive: true });
		// Pre-existing file edited by parallel branch D before our Worker starts:
		await fs.promises.writeFile(path.join(projectDir, 'src', 'parallelD.ts'), 'export const d = "dirty-before";\n', 'utf8');
		await fs.promises.writeFile(path.join(projectDir, 'src', 'targetB.ts'), 'export function calc() {\n\treturn 1;\n}\n', 'utf8');

		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			const before = await svc.captureWorkspaceSnapshot(projectDir);

			// Worker B modifies targetB.ts and creates newHelper.ts, leaving parallelD.ts untouched
			await fs.promises.writeFile(path.join(projectDir, 'src', 'targetB.ts'), 'export function calc() {\n\treturn 42;\n}\n', 'utf8');
			await fs.promises.writeFile(path.join(projectDir, 'src', 'newHelper.ts'), 'export const helper = true;\n', 'utf8');

			const changes = await svc.computeWorkerTurnChanges(projectDir, before);
			assert.deepStrictEqual(
				changes.touchedFiles.map(f => ({ path: f.relativePath, kind: f.kind })),
				[
					{ path: 'src/newHelper.ts', kind: 'added' },
					{ path: 'src/targetB.ts', kind: 'modified' },
				],
			);
			assert.ok(changes.combinedDiff.includes('-	return 1;'));
			assert.ok(changes.combinedDiff.includes('+	return 42;'));
			assert.ok(!changes.combinedDiff.includes('parallelD.ts'));

			// Verify Shared-Root Concurrent Sibling Isolation:
			// Suppose Worker C started at `before` too and created `src/siblingC.ts` AFTER Worker B finished:
			const bFileSha1 = changes.touchedFiles.find(f => f.relativePath === 'src/newHelper.ts')?.afterSha1;
			const bModSha1 = changes.touchedFiles.find(f => f.relativePath === 'src/targetB.ts')?.afterSha1;
			assert.ok(bFileSha1 && bModSha1);

			await fs.promises.writeFile(path.join(projectDir, 'src', 'siblingC.ts'), 'export const c = 99;\n', 'utf8');
			const changesC = await svc.computeWorkerTurnChanges(projectDir, before, {
				'src/newHelper.ts': bFileSha1!,
				'src/targetB.ts': bModSha1!,
			});
			assert.deepStrictEqual(
				changesC.touchedFiles.map(f => ({ path: f.relativePath, kind: f.kind })),
				[{ path: 'src/siblingC.ts', kind: 'added' }],
				'Parallel sibling files recorded in ignoreSiblingSha1s must NOT cross-contaminate Worker C diff',
			);
			assert.ok(!changesC.combinedDiff.includes('newHelper.ts'));
			assert.ok(!changesC.combinedDiff.includes('targetB.ts'));
		} finally {
			svc.dispose();
		}
	});

	test('isolates segment worktrees and detects Git merge conflicts cleanly', async () => {
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const repoDir = path.join(tmpDir, 'git-project');
		await fs.promises.mkdir(repoDir, { recursive: true });
		runGitSync(repoDir, ['init']);
		runGitSync(repoDir, ['config', 'user.name', 'Test']);
		runGitSync(repoDir, ['config', 'user.email', 'test@example.com']);
		await fs.promises.writeFile(path.join(repoDir, 'shared.txt'), 'line 1\n', 'utf8');
		runGitSync(repoDir, ['add', '.']);
		runGitSync(repoDir, ['commit', '-m', 'initial']);

		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			const segB = await svc.ensureSegmentWorktree('gov-wt', repoDir, 'B', []);
			const segC = await svc.ensureSegmentWorktree('gov-wt', repoDir, 'C', []);

			await fs.promises.writeFile(path.join(segB.worktree.worktreePath, 'shared.txt'), 'from B\n', 'utf8');
			await svc.commitSegmentWorktree(segB.worktree.worktreePath, 'seg B commit');

			await fs.promises.writeFile(path.join(segC.worktree.worktreePath, 'shared.txt'), 'from C\n', 'utf8');
			await svc.commitSegmentWorktree(segC.worktree.worktreePath, 'seg C commit');

			const segD = await svc.ensureSegmentWorktree('gov-wt', repoDir, 'D', [
				segB.worktree.branchName,
				segC.worktree.branchName,
			]);
			assert.ok(segD.mergeConflict);
			assert.deepStrictEqual(segD.mergeConflict.conflictedFiles, ['shared.txt']);

			await svc.cleanupTreeWorktrees('gov-wt', repoDir, true);
		} finally {
			svc.dispose();
		}
	});

	test('uses git-native dirty tracking honoring .gitignore and detects adds, mods, deletes, reverts, and mid-turn commits (P1-5)', async () => {
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const repoDir = path.join(tmpDir, 'git-snapshot-repo');
		await fs.promises.mkdir(path.join(repoDir, 'src'), { recursive: true });
		runGitSync(repoDir, ['init']);
		runGitSync(repoDir, ['config', 'user.name', 'Real Dev']);
		runGitSync(repoDir, ['config', 'user.email', 'dev@example.org']);
		await fs.promises.writeFile(path.join(repoDir, '.gitignore'), 'ignored-out/\n*.log\n', 'utf8');
		await fs.promises.writeFile(path.join(repoDir, 'src', 'keep.ts'), 'export const keep = 1;\n', 'utf8');
		await fs.promises.writeFile(path.join(repoDir, 'src', 'drop.ts'), 'export const drop = 1;\n', 'utf8');
		await fs.promises.writeFile(path.join(repoDir, 'src', 'committed.ts'), 'export const committed = "v1";\n', 'utf8');
		runGitSync(repoDir, ['add', '.']);
		runGitSync(repoDir, ['commit', '-m', 'initial']);

		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			const before = await svc.captureWorkspaceSnapshot(repoDir);
			assert.strictEqual(before.gitDirtyMode, true, 'Git repo snapshot must use gitDirtyMode instead of full tree walk');
			assert.ok(before.gitHead, 'Git repo snapshot records HEAD commit SHA');
			assert.deepStrictEqual(Object.keys(before.entries), [], 'Clean repo starts with 0 dirty entries');

			// Mutate tracked, add untracked, delete tracked, write ignored files
			await fs.promises.mkdir(path.join(repoDir, 'ignored-out'), { recursive: true });
			await fs.promises.writeFile(path.join(repoDir, 'ignored-out', 'noise.js'), 'console.log(1);\n', 'utf8');
			await fs.promises.writeFile(path.join(repoDir, 'debug.log'), 'noisy log\n', 'utf8');
			await fs.promises.writeFile(path.join(repoDir, 'src', 'keep.ts'), 'export const keep = 2;\n', 'utf8');
			await fs.promises.writeFile(path.join(repoDir, 'src', 'added.ts'), 'export const added = true;\n', 'utf8');
			await fs.promises.rm(path.join(repoDir, 'src', 'drop.ts'));

			const changes = await svc.computeWorkerTurnChanges(repoDir, before);
			assert.deepStrictEqual(
				changes.touchedFiles.map(f => ({ path: f.relativePath, kind: f.kind })),
				[
					{ path: 'src/added.ts', kind: 'added' },
					{ path: 'src/drop.ts', kind: 'deleted' },
					{ path: 'src/keep.ts', kind: 'modified' },
				],
			);
			assert.ok(changes.combinedDiff.includes('-export const keep = 1;'));
			assert.ok(changes.combinedDiff.includes('+export const keep = 2;'));
			assert.ok(changes.combinedDiff.includes('-export const drop = 1;'));
			assert.ok(!changes.combinedDiff.includes('noise.js'), '.gitignore entries must be excluded');
			assert.ok(!changes.combinedDiff.includes('debug.log'), '.gitignore patterns must be excluded');

			// Also verify mid-turn commit detection
			const beforeCommitTurn = await svc.captureWorkspaceSnapshot(repoDir);
			await fs.promises.writeFile(path.join(repoDir, 'src', 'committed.ts'), 'export const committed = "v2";\n', 'utf8');
			runGitSync(repoDir, ['add', 'src/committed.ts']);
			runGitSync(repoDir, ['commit', '-m', 'worker committed mid-turn']);
			const commitTurnChanges = await svc.computeWorkerTurnChanges(repoDir, beforeCommitTurn);
			assert.deepStrictEqual(
				commitTurnChanges.touchedFiles.map(f => ({ path: f.relativePath, kind: f.kind })),
				[{ path: 'src/committed.ts', kind: 'modified' }],
			);
		} finally {
			svc.dispose();
		}
	});

	test('preserves user Git identity + Co-authored-by trailer, reuses existing branches without -B, refuses dirty merges, and uses safe -d cleanup (P1-3)', async () => {
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const repoDir = path.join(tmpDir, 'git-safe-wt');
		await fs.promises.mkdir(repoDir, { recursive: true });
		runGitSync(repoDir, ['init']);
		runGitSync(repoDir, ['config', 'user.name', 'Alice Developer']);
		runGitSync(repoDir, ['config', 'user.email', 'alice@company.dev']);
		await fs.promises.writeFile(path.join(repoDir, 'app.txt'), 'v1\n', 'utf8');
		runGitSync(repoDir, ['add', '.']);
		runGitSync(repoDir, ['commit', '-m', 'init']);

		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			const segA = await svc.ensureSegmentWorktree('gov-safe', repoDir, 'A', []);
			await fs.promises.writeFile(path.join(segA.worktree.worktreePath, 'feature.txt'), 'hello\n', 'utf8');
			const sha1 = await svc.commitSegmentWorktree(segA.worktree.worktreePath, 'feat: add feature');
			assert.ok(sha1);

			// Verify user identity preserved and Co-authored-by trailer appended
			const logInfo = cp.execFileSync('git', ['log', '-1', '--format=%an <%ae>%n%B'], { cwd: segA.worktree.worktreePath, encoding: 'utf8' });
			assert.ok(logInfo.includes('Alice Developer <alice@company.dev>'), 'Must preserve user Git identity');
			assert.ok(logInfo.includes('Co-authored-by: Aexus Engineering <ade@aexus.local>'), 'Must append Co-authored-by trailer');

			// Remove worktree dir ONLY (leaving branch with unmerged commit), then re-attach -> must reuse existing branch (NOT -B reset!)
			runGitSync(repoDir, ['worktree', 'remove', '--force', segA.worktree.worktreePath]);
			const reattached = await svc.ensureSegmentWorktree('gov-safe', repoDir, 'A', []);
			assert.strictEqual(reattached.worktree.headCommit, sha1, 'Existing unmerged segment branch must be reused without destructive -B reset');

			// Dirty working tree in projectPath MUST refuse mergeSegmentsIntoProject
			await fs.promises.writeFile(path.join(repoDir, 'app.txt'), 'uncommitted local edit\n', 'utf8');
			const dirtyMerge = await svc.mergeSegmentsIntoProject(repoDir, [segA.worktree.branchName]);
			assert.strictEqual(dirtyMerge.ok, false, 'Dirty working tree must block segment merge');
			assert.ok(dirtyMerge.summary.includes('uncommitted changes'));

			// Safe default cleanup uses `git branch -d` -> unmerged branch MUST survive!
			await svc.cleanupTreeWorktrees('gov-safe', repoDir);
			const remainingBranches = cp.execFileSync('git', ['branch', '--list', segA.worktree.branchName], { cwd: repoDir, encoding: 'utf8' }).trim();
			assert.ok(remainingBranches.includes(segA.worktree.branchName), 'Safe cleanup (-d) must preserve unmerged branch');

			// Explicit force=true cleanup deletes unmerged branch cleanly
			await svc.cleanupTreeWorktrees('gov-safe', repoDir, true);
			const afterForce = cp.execFileSync('git', ['branch', '--list', segA.worktree.branchName], { cwd: repoDir, encoding: 'utf8' }).trim();
			assert.strictEqual(afterForce, '', 'Forced cleanup (-D) deletes unmerged branch');
		} finally {
			svc.dispose();
		}
	});

	test('runs verify command via POSIX /bin/sh -c and kills entire process group on timeout (P0-6, P2-5)', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const workDir = path.join(tmpDir, 'verify-pgkill');
		await fs.promises.mkdir(workDir, { recursive: true });
		const pidFile = path.join(workDir, 'grandchild.pid');

		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			const okRes = await svc.runNodeVerificationCommand(workDir, 'printf "verify-ok"', 5000);
			assert.strictEqual(okRes.passed, true);
			assert.strictEqual(okRes.output, 'verify-ok');

			// Spawn a background grandchild `sleep 30` and wait on it; timeout must SIGKILL the whole process group!
			const timeoutRes = await svc.runNodeVerificationCommand(
				workDir,
				`sleep 30 & echo $! > "${pidFile}"; wait`,
				1000,
			);
			assert.strictEqual(timeoutRes.passed, false);
			assert.strictEqual(timeoutRes.exitCode, 124);
			assert.ok(timeoutRes.output.includes('timed out'));

			const rawPid = (await fs.promises.readFile(pidFile, 'utf8')).trim();
			const grandchildPid = Number(rawPid);
			assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `Expected valid grandchild pid, got ${rawPid}`);

			// Give OS a brief tick to reap SIGKILLed process group member
			await new Promise(resolve => setTimeout(resolve, 100));
			let alive = true;
			try {
				process.kill(grandchildPid, 0);
			} catch {
				alive = false;
			}
			assert.strictEqual(alive, false, `Grandchild process ${grandchildPid} must be terminated when verify times out`);
		} finally {
			svc.dispose();
		}
	});

	test('scrubs ADE control-plane credentials from verify & git child environments, disables repo git hooks, and uses Windows /d /s /c spawn spec (P0-02, P1-14)', async () => {
		// 1. Direct unit check of scrubAdeControlEnv (case-insensitive)
		const scrubbed = scrubAdeControlEnv({
			PATH: '/usr/bin',
			SAFE_VAR: 'keep-me',
			AEXUS_ADE_CONTROL_FILE: '/tmp/secret-ctrl.json',
			AEXUS_ADE_TOKEN: 'secret-token',
			AEXUS_ADE_SOCKET: '/tmp/ade.sock',
			AEXUS_ADE_SESSION_TOKEN: 'session-secret',
			aexus_ade_caller: 'governor',
			AEXUS_ADE_WINDOW_KEY: 'win-1',
			AEXUS_ADE_ROLE_STATE_FILE: '/tmp/role.json',
		});
		assert.strictEqual(scrubbed.SAFE_VAR, 'keep-me');
		assert.strictEqual(scrubbed.PATH, '/usr/bin');
		for (const key of ADE_SCRUBBED_CONTROL_ENV_KEYS) {
			assert.strictEqual(scrubbed[key], undefined, `${key} must be stripped`);
		}
		assert.strictEqual(scrubbed.aexus_ade_caller, undefined, 'Case-insensitive ADE env key must be stripped');

		// 2. Windows cmd.exe spawn spec must pass ['/d', '/s', '/c', command] + windowsVerbatimArguments: true
		const winSpec = buildVerificationSpawnSpec('npm test -- --run "a b"', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
		assert.strictEqual(winSpec.bin, 'C:\\Windows\\System32\\cmd.exe');
		assert.deepStrictEqual(winSpec.args, ['/d', '/s', '/c', 'npm test -- --run "a b"']);
		assert.strictEqual(winSpec.windowsVerbatimArguments, true);
		const posixSpec = buildVerificationSpawnSpec('echo hi', 'darwin', {});
		assert.strictEqual(posixSpec.bin, '/bin/sh');
		assert.deepStrictEqual(posixSpec.args, ['-c', 'echo hi']);
		assert.strictEqual(Boolean(posixSpec.windowsVerbatimArguments), false);

		if (process.platform === 'win32') {
			return;
		}

		// 3. Real verify child process must NOT observe ADE control env vars inherited from parent process
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of ADE_SCRUBBED_CONTROL_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			process.env[key] = `leaked-${key}`;
		}
		const aexusHome = path.join(tmpDir, '.aexus-code');
		const repoDir = path.join(tmpDir, 'git-hooks-safety');
		await fs.promises.mkdir(repoDir, { recursive: true });
		const svc = new AdeEngineeringNodeService({ baseDir: aexusHome });
		try {
			const envRes = await svc.runNodeVerificationCommand(
				repoDir,
				'printf "%s|%s|%s|%s|%s" "${AEXUS_ADE_CONTROL_FILE:-}" "${AEXUS_ADE_TOKEN:-}" "${AEXUS_ADE_SOCKET:-}" "${AEXUS_ADE_SESSION_TOKEN:-}" "${AEXUS_ADE_CALLER:-}"',
				5000,
			);
			assert.strictEqual(envRes.passed, true);
			assert.strictEqual(envRes.output, '||||', 'Verify child process must not receive any ADE control env vars');

			// 4. Malicious git hooks in repository MUST NOT execute during automated worktree add / commit / merge (-c core.hooksPath=/dev/null)
			runGitSync(repoDir, ['init']);
			runGitSync(repoDir, ['config', 'user.name', 'Test']);
			runGitSync(repoDir, ['config', 'user.email', 'test@example.com']);
			await fs.promises.writeFile(path.join(repoDir, 'base.txt'), 'v1\n', 'utf8');
			runGitSync(repoDir, ['add', '.']);
			runGitSync(repoDir, ['commit', '-m', 'init']);

			const markerFile = path.join(tmpDir, 'hook-pwned.txt');
			const hooksDir = path.join(repoDir, '.git', 'hooks');
			await fs.promises.mkdir(hooksDir, { recursive: true });
			const hookScript = `#!/bin/sh\necho "pwned:$AEXUS_ADE_TOKEN" >> "${markerFile}"\n`;
			for (const hookName of ['pre-commit', 'post-checkout', 'post-merge', 'post-commit']) {
				const hookPath = path.join(hooksDir, hookName);
				await fs.promises.writeFile(hookPath, hookScript, { encoding: 'utf8', mode: 0o755 });
			}

			const seg = await svc.ensureSegmentWorktree('gov-hooks', repoDir, 'S1', []);
			await fs.promises.writeFile(path.join(seg.worktree.worktreePath, 'work.txt'), 'safe\n', 'utf8');
			const sha = await svc.commitSegmentWorktree(seg.worktree.worktreePath, 'feat: safe commit');
			assert.ok(sha);
			const mergeRes = await svc.mergeSegmentsIntoProject(repoDir, [seg.worktree.branchName]);
			assert.strictEqual(mergeRes.ok, true);
			assert.strictEqual(fs.existsSync(markerFile), false, 'Automated worktree git ops must disable repo hooks via core.hooksPath=/dev/null');

			await svc.cleanupTreeWorktrees('gov-hooks', repoDir, true);
		} finally {
			svc.dispose();
			for (const key of ADE_SCRUBBED_CONTROL_ENV_KEYS) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		}
	});
});
