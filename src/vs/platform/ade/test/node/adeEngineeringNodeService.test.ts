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
import { AdeEngineeringNodeService } from '../../node/adeEngineeringService.js';

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

			await svc.cleanupTreeWorktrees('gov-wt', repoDir);
		} finally {
			svc.dispose();
		}
	});
});
