/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { parseCliCommand, runCli } from '../src/adeCli.ts';
import {
	buildCompletionScript,
	formatHumanOutput,
	HELP_TEXT,
	isIdempotentReadRequest,
	normalizeExplicitSocketPath,
} from '../src/adeCliRuntimeSupport.mjs';

const CWD = '/workspace/proj';

describe('Round 2 · C1 Socket Path Mirroring, Trailing Global Flags & Mutation Idempotency (#95 P0-A, #124 #3)', () => {
	test('normalizeExplicitSocketPath maps >90-byte Unix paths to /tmp/aexus-ade-<uid>/c-<hash>.sock', () => {
		const shortPath = '/tmp/ade-short.sock';
		assert.strictEqual(normalizeExplicitSocketPath(shortPath), shortPath);

		const tcpEndpoint = 'tcp://127.0.0.1:54321';
		assert.strictEqual(normalizeExplicitSocketPath(tcpEndpoint), tcpEndpoint);

		if (process.platform !== 'win32') {
			const overlongDir = `/Users/developer/Library/Application Support/Aexus Code Insiders Very Long Profile Directory Name/sockets`;
			const overlongPath = `${overlongDir}/ade-control.sock`;
			assert.ok(Buffer.byteLength(overlongPath, 'utf8') > 90);
			const shortened = normalizeExplicitSocketPath(overlongPath);
			assert.ok(shortened);
			assert.match(shortened, /^\/tmp\/aexus-ade-\d+\/c-[0-9a-f]{12}\.sock$/);
			assert.ok(Buffer.byteLength(shortened, 'utf8') < 64);
			assert.strictEqual(normalizeExplicitSocketPath(overlongPath), shortened);
			assert.notStrictEqual(normalizeExplicitSocketPath(`${overlongDir}/window-2.sock`), shortened);
		}
	});

	test('peels multiple trailing global flags in free-text send without corrupting prompt (#124 #3)', () => {
		const s1 = parseCliCommand(['session', 'send', 's1', 'hello', '--idempotency-key=k1', '--json'], CWD);
		assert.strictEqual(s1.json, true);
		assert.strictEqual(s1.idempotencyKey, 'k1');
		assert.strictEqual(s1.params?.prompt, 'hello');

		const s2 = parseCliCommand(['session', 'send', 's1', 'hello', '--json', '--idempotency-key=k1'], CWD);
		assert.strictEqual(s2.json, true);
		assert.strictEqual(s2.idempotencyKey, 'k1');
		assert.strictEqual(s2.params?.prompt, 'hello');

		const s3 = parseCliCommand(['session', 'send', 's1', 'hello world', '--idempotency-key', 'k2', '--window', '4', '--pretty'], CWD);
		assert.strictEqual(s3.pretty, true);
		assert.strictEqual(s3.windowId, 4);
		assert.strictEqual(s3.idempotencyKey, 'k2');
		assert.strictEqual(s3.params?.prompt, 'hello world');

		// `--help` and `--version` inside freeform prompt stay part of the prompt!
		const s4 = parseCliCommand(['session', 'send', 's1', 'Run aexus-ade --help', '--json'], CWD);
		assert.strictEqual(s4.help, false);
		assert.strictEqual(s4.json, true);
		assert.strictEqual(s4.params?.prompt, 'Run aexus-ade --help');
	});

	test('isIdempotentReadRequest excludes cursor-mutating token.read while allowing sliced/TOC reads and C6 read actions', () => {
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'] }), false);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], toc: true }), true);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], summaryOnly: true }), true);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], section: 'Contract' }), true);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], maxChars: 800 }), true);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], offset: 100 }), true);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], tailChars: 400 }), true);
		assert.strictEqual(isIdempotentReadRequest('token.read', { ptrs: ['p1'], tail: 400 }), true);

		for (const readAction of [
			'host.browse',
			'mission.get',
			'mission.export',
			'orchestration.export',
			'mission.diagnostics',
			'orchestration.diagnostics',
			'mission.checkpoint.list',
			'mission.checkpoint.diff',
			'orchestration.checkpoint.list',
			'orchestration.checkpoint.diff',
			'whiteboard.read',
		]) {
			assert.strictEqual(isIdempotentReadRequest(readAction, {}), true, `${readAction} must be idempotent read`);
		}
		assert.strictEqual(isIdempotentReadRequest('mission.checkpoint.create', {}), false);
		assert.strictEqual(isIdempotentReadRequest('mission.checkpoint.restore', {}), false);
	});

	test('propagates explicit --idempotency-key / env, auto-mints UUIDv4 on mutating calls, and omits on pure reads', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const parsedExplicit = parseCliCommand(['--idempotency-key', 'idem-wave-01', 'token', 'mint', 'otok-1', '--to', 'Dev1', '--summary', 'Go'], CWD);
		assert.strictEqual(parsedExplicit.idempotencyKey, 'idem-wave-01');

		assert.throws(
			() => parseCliCommand(['--idempotency-key', 'bad\nkey', 'whoami'], CWD),
			/Invalid --idempotency-key/i,
		);

		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ade-idem-'));
		const sockPath = path.join(tmpDir, 'ade.sock');
		const wireLog: Array<{ action: string; idempotencyKey?: string; params?: Record<string, unknown> }> = [];
		const server = net.createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl >= 0) {
					const req = JSON.parse(buf.slice(0, nl)) as { action: string; idempotencyKey?: string; params?: Record<string, unknown> };
					wireLog.push(req);
					if (req.action === 'mission.export') {
						sock.end(JSON.stringify({
							ok: true,
							result: { format: 'markdown', content: '# Exported Mission\n\nRaw markdown payload.\n' },
						}) + '\n');
					} else {
						sock.end(JSON.stringify({ ok: true, result: { ok: true } }) + '\n');
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sockPath, resolve));
		try {
			const baseEnv = { AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_SESSION_TOKEN: 'cap-1' };

			await runCli(['whoami', '--json'], { stdout: () => { }, stderr: () => { }, env: baseEnv, cwd: tmpDir });
			assert.strictEqual(wireLog.at(-1)?.action, 'whoami');
			assert.strictEqual(wireLog.at(-1)?.idempotencyKey, undefined);

			await runCli(['token', 'read', 'ptr-1', '--toc', '--json'], { stdout: () => { }, stderr: () => { }, env: baseEnv, cwd: tmpDir });
			assert.strictEqual(wireLog.at(-1)?.idempotencyKey, undefined);

			await runCli(['token', 'read', 'ptr-1', '--json'], { stdout: () => { }, stderr: () => { }, env: baseEnv, cwd: tmpDir });
			assert.match(wireLog.at(-1)?.idempotencyKey ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/i);

			await runCli(['token', 'complete', 'otok-1', '--summary', 'Done', '--json'], {
				stdout: () => { },
				stderr: () => { },
				env: { ...baseEnv, AEXUS_ADE_IDEMPOTENCY_KEY: 'env-key-77' },
				cwd: tmpDir,
			});
			assert.strictEqual(wireLog.at(-1)?.idempotencyKey, 'env-key-77');

			const mdOutPath = path.join(tmpDir, 'bundle.md');
			const exportCode = await runCli(['mission', 'export', 'm-1', '--format', 'markdown', '--file', mdOutPath], {
				stdout: () => { },
				stderr: () => { },
				env: baseEnv,
				cwd: tmpDir,
			});
			assert.strictEqual(exportCode, 0);
			const writtenMd = await fs.readFile(mdOutPath, 'utf8');
			assert.strictEqual(writtenMd, '# Exported Mission\n\nRaw markdown payload.\n');
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe('Round 2 · C3 / C4 / C5 / C6 CLI Flags, Subcommands & Completions (#122, #128)', () => {
	test('C3 parses whiteboard read/toc/write --section and rejects flag-swallowing --section --toc (#128 #6a)', () => {
		const wbRead = parseCliCommand(
			['whiteboard', 'read', 'wb_arch', '--mission', 'm-1', '--section', '## API Contract', '--max-chars', '1200', '--offset', '40'],
			CWD,
		);
		assert.strictEqual(wbRead.action, 'whiteboard.read');
		assert.deepStrictEqual(wbRead.params, {
			id: 'wb_arch',
			missionId: 'm-1',
			section: '## API Contract',
			maxChars: 1200,
			offset: 40,
		});

		assert.throws(
			() => parseCliCommand(['token', 'read', 'ptr-1', '--section', '--toc'], CWD),
			/Option --section requires a value, got --toc/i,
		);

		const wbToc = parseCliCommand(['whiteboard', 'toc', 'wb_arch', '--summary-only'], CWD);
		assert.strictEqual(wbToc.action, 'whiteboard.read');
		assert.deepStrictEqual(wbToc.params, { id: 'wb_arch', toc: true, summaryOnly: true });

		const wbWriteSec = parseCliCommand(['whiteboard', 'write', 'wb_arch', '--section', 'Rollout', '--content', 'Wave 1 green'], CWD);
		assert.strictEqual(wbWriteSec.action, 'whiteboard.write');
		assert.deepStrictEqual(wbWriteSec.params, { id: 'wb_arch', section: 'Rollout', content: 'Wave 1 green' });

		const tokReadSlice = parseCliCommand(['token', 'read', 'ptr-a,ptr-b', '--section', 'Diff', '--tail', '600', '--summary-only'], CWD);
		assert.strictEqual(tokReadSlice.action, 'token.read');
		assert.deepStrictEqual(tokReadSlice.params, {
			ptrs: ['ptr-a', 'ptr-b'],
			section: 'Diff',
			tailChars: 600,
			summaryOnly: true,
		});
	});

	test('C4 aligns mission task create/update/set contracts with Slice 1/2 without swallowing positionals (#122 #1, #2, #8)', () => {
		// Boolean contract flags BEFORE positional title/nodeId must NOT swallow the positional!
		const tCreatePositional = parseCliCommand([
			'mission', 'task', 'create', '--mission', 'm-1', '--id', 'T1',
			'--require-checks', '--require-artifact', '--require-files', 'Implement Auth Service',
			'--require-whiteboard', 'wb_arch;wb_api', '--min-summary', '80',
		], CWD);
		assert.strictEqual(tCreatePositional.action, 'mission.task.create');
		assert.strictEqual(tCreatePositional.params?.title, 'Implement Auth Service');
		assert.strictEqual(tCreatePositional.params?.requireChecksPassed, true);
		assert.strictEqual(tCreatePositional.params?.requireArtifact, true);
		assert.strictEqual(tCreatePositional.params?.requireFiles, true);
		assert.deepStrictEqual(tCreatePositional.params?.requiredWhiteboardIds, ['wb_arch', 'wb_api']);
		assert.strictEqual(tCreatePositional.params?.minSummaryChars, 80);

		// Bare `--require-whiteboard` or boolean `true` rejected with helpful message (#122 #2)
		assert.throws(
			() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--require-whiteboard'], CWD),
			/requires a value/i,
		);
		assert.throws(
			() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--require-whiteboard=true'], CWD),
			/requires one or more whiteboard IDs/i,
		);
		assert.throws(
			() => parseCliCommand(['mission', 'task', 'create', '--title', 'T', '--min-summary', '5000'], CWD),
			/between 1 and 2000/i,
		);

		const tUpdate = parseCliCommand([
			'mission', 'task', 'update', '--require-files', 'T1', '--no-require-checks', '--no-require-whiteboard', '--min-summary', '0',
		], CWD);
		assert.strictEqual(tUpdate.action, 'mission.task.update');
		assert.strictEqual(tUpdate.params?.nodeId, 'T1');
		assert.strictEqual(tUpdate.params?.requireFiles, true);
		assert.strictEqual(tUpdate.params?.requireChecksPassed, false);
		assert.strictEqual(tUpdate.params?.requiredWhiteboardIds, null);
		assert.strictEqual(tUpdate.params?.minSummaryChars, null);

		// `mission task set` with contract flags routes to `mission.task.update` so existing description is NEVER wiped (#122 #1)!
		const tSetContractOnly = parseCliCommand([
			'mission', 'task', 'set', 'T1', '--require-checks', '--min-summary', '50',
		], CWD);
		assert.strictEqual(tSetContractOnly.action, 'mission.task.update');
		assert.strictEqual(tSetContractOnly.params?.requireChecksPassed, true);
		assert.strictEqual(tSetContractOnly.params?.minSummaryChars, 50);

		const taskComp = parseCliCommand(['mission', 'task', 'complete', 'T1', '--evidence', 'tsc + eslint pass', '--files', 'src/a.ts;src/b.ts'], CWD);
		assert.strictEqual(taskComp.action, 'mission.task.complete');
		assert.strictEqual(taskComp.params?.note, 'tsc + eslint pass');
		assert.deepStrictEqual(taskComp.params?.touchedFiles, ['src/a.ts', 'src/b.ts']);
	});

	test('C5 parses --scope-paths (/[,|;]/), --conflict-policy, --allow-overlap, and --wave-summary on token mint & split', () => {
		const minted = parseCliCommand([
			'token', 'mint', 'otok-root', '--to', 'Dev1,Dev2', '--summary', 'Implement slice',
			'--scope-paths', 'src/auth/**;!src/auth/legacy/**', '--conflict-policy', 'reject', '--wave-summary', 'Wave 1 Auth',
		], CWD);
		assert.strictEqual(minted.action, 'token.mint');
		assert.deepStrictEqual(minted.params?.scopePaths, ['src/auth/**', '!src/auth/legacy/**']);
		assert.strictEqual(minted.params?.conflictPolicy, 'reject');
		assert.strictEqual(minted.params?.waveSummary, 'Wave 1 Auth');

		const splitAllow = parseCliCommand([
			'token', 'split', 'otok-root',
			'--branch', '{"toNodeId":"Dev1","summary":"Part A"}',
			'--branch', '{"toNodeId":"Dev2","summary":"Part B"}',
			'--allow-overlap', '--wave-summary', 'Parallel spike',
		], CWD);
		assert.strictEqual(splitAllow.action, 'token.split');
		assert.strictEqual(splitAllow.params?.conflictPolicy, 'allow');
		assert.strictEqual(splitAllow.params?.waveSummary, 'Parallel spike');
	});

	test('C6 parses diagnostics, checkpoints, rework categories (including security & other), and orchestration limits --silence 1..1440', () => {
		assert.deepStrictEqual(
			parseCliCommand(['mission', 'diagnostics', 'm-1'], CWD).params,
			{ missionId: 'm-1' },
		);
		assert.strictEqual(parseCliCommand(['orchestration', 'diagnostics', '--mission', 'm-1'], CWD).action, 'mission.diagnostics');

		assert.deepStrictEqual(
			parseCliCommand(['mission', 'checkpoint', 'diff', 'ckpt-1', 'ckpt-2', '--mission', 'm-1'], CWD).params,
			{ checkpointId: 'ckpt-1', id: 'ckpt-1', from: 'ckpt-1', to: 'ckpt-2', againstCheckpointId: 'ckpt-2', missionId: 'm-1' },
		);
		assert.deepStrictEqual(
			parseCliCommand(['orchestration', 'checkpoint', 'restore', 'ckpt-1', '--mission', 'm-1', '--tokens-only', '--reason', 'Rollback spike'], CWD).params,
			{ checkpointId: 'ckpt-1', id: 'ckpt-1', missionId: 'm-1', mode: 'tokens_only', reason: 'Rollback spike' },
		);

		assert.strictEqual(
			parseCliCommand(['token', 'reject', 'otok-5', '--reason', 'Auth bypass', '--category', 'security'], CWD).params?.category,
			'security',
		);
		assert.strictEqual(
			parseCliCommand(['token', 'fail', 'otok-5', '--reason', 'Infra issue', '--category', 'other'], CWD).params?.category,
			'other',
		);

		assert.strictEqual(
			parseCliCommand(['orchestration', 'limits', '--silence', '15'], CWD).params?.silenceReminderMinutes,
			15,
		);
		assert.throws(
			() => parseCliCommand(['orchestration', 'limits', '--silence', 'off'], CWD),
			/between 1 and 1440/i,
		);

		for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
			const script = buildCompletionScript(shell);
			assert.ok(script.includes('diagnostics'), `${shell} completion missing diagnostics`);
			assert.ok(script.includes('checkpoint'), `${shell} completion missing checkpoint`);
			assert.ok(script.includes('toc'), `${shell} completion missing whiteboard toc`);
		}
		assert.ok(HELP_TEXT.includes('security|other'));
	});
});

describe('Round 2 · #93 §4–§5 + #122/#124 Human Formatters & Full CLI Action Coverage', () => {
	test('formatHumanOutput renders whoami, subordinates, context, role schema, whiteboard TOC/section-miss, diagnostics, and checkpoint list/diff/restore', () => {
		const whoamiFlat = formatHumanOutput('whoami', {
			id: 'sess-gov-1', rankId: 'governor', tier: 1, label: 'Alice', missionId: 'm-9', nodeIds: ['CEO', 'Board'],
		});
		assert.match(whoamiFlat, /\[L1 · governor\] "Alice" id=sess-gov-1 mission=m-9 nodes=CEO,Board/);

		const subsOut = formatHumanOutput('org.subordinates', {
			directSubordinates: [{ id: 's-mgr', rankId: 'manager', tier: 2, label: 'Bob', status: 'working' }],
			orchestrationSubordinates: [{ id: 'Dev1', rankId: 'employee', tier: 3, label: 'Carol', status: 'idle', department: 'Core' }],
			missionJurisdictions: [{ missionId: 'm-9', managedNodes: ['QA1'] }],
		});
		assert.match(subsOut, /Subordinates \(3\):/);

		const ctxOut = formatHumanOutput('org.context', {
			history: [{ role: 'user', text: 'Audit auth module' }],
		});
		assert.match(ctxOut, /\[user\] Audit auth module/);

		const roleOut = formatHumanOutput('role.schema.get', {
			ranks: [
				{ id: 'governor', tier: 1, name: 'Governor', pureExecution: false, allowedApis: ['mission.design', 'session.manage'] },
				{ id: 'worker', tier: 4, name: 'Worker', pureExecution: true, allowedApis: [] },
			],
		});
		assert.match(roleOut, /- governor \(L1\): Governor \(2 APIs\)/);
		assert.match(roleOut, /- worker \(L4\): Worker \[pure: 0 APIs\]/);

		// Whiteboard `--toc` response from Slice 1/2 (non-empty `content` + `truncated: true` -> must NOT append `[truncated: ...]`, #122 #6)
		const wbTocLive = formatHumanOutput('whiteboard.read', {
			ok: true,
			missionId: 'm-9',
			whiteboard: { id: 'WB_CORE', title: 'Architecture', version: 4, content: '- ## API Contract (L1-L12, 420 chars)' },
			slice: {
				truncated: true,
				totalChars: 2048,
				offset: 0,
				isPartialSlice: true,
				headings: [{ level: 2, title: 'API Contract', startLine: 1, chars: 420 }],
			},
		});
		assert.ok(!wbTocLive.includes('[truncated:'), 'TOC response must not print misleading [truncated: ...] footer');

		// Whiteboard `--section` miss surfaces `availableSections` (#122 #6)
		const wbMissOut = formatHumanOutput('whiteboard.read', {
			ok: true,
			missionId: 'm-9',
			whiteboard: { id: 'WB_CORE', title: 'Architecture', version: 4, content: '' },
			slice: {
				truncated: true,
				totalChars: 2048,
				offset: 0,
				isPartialSlice: true,
				headings: [{ level: 2, title: 'API Contract', startLine: 1, chars: 420 }],
				availableSections: ['API Contract', 'Rollout'],
			},
		});
		assert.match(wbMissOut, /section not found; available sections: API Contract, Rollout/);

		// Checkpoint diff & restore real server response shapes (#122 #5, #124 #4, #141 #3)
		const ckptDiffOut = formatHumanOutput('mission.checkpoint.diff', {
			ok: true,
			missionId: 'm-9',
			fromCheckpointId: 'ckpt-1',
			toCheckpointId: 'live',
			diff: {
				fromId: 'ckpt-1',
				toId: 'live',
				fromStateRevision: 4,
				toStateRevision: 9,
				addedTokenIds: ['otok-1'],
				removedTokenIds: [],
				statusChangedTokens: [{ tokenId: 'otok-2', fromStatus: 'dispatched', toStatus: 'done' }],
				taskStatusChanges: [{ taskId: 'T1', fromStatus: 'in_progress', toStatus: 'done' }],
				whiteboardVersionChanges: [{ whiteboardId: 'WB_CORE', fromVersion: 1, toVersion: 2 }],
				barrierChanges: [{ barrierId: 'bar-1', fromStatus: 'waiting', toStatus: 'satisfied' }],
			},
		});
		assert.strictEqual(
			ckptDiffOut,
			'Checkpoint Diff (ckpt-1 -> live): rev=4->9 tokenChanges=2 taskChanges=1 wbChanges=1 barrierChanges=1',
		);

		const ckptRestoreOut = formatHumanOutput('mission.checkpoint.restore', {
			ok: true,
			missionId: 'm-9',
			state: { tokens: {} },
			whiteboards: {},
			diff: { fromId: 'ckpt-1', toId: 'live' },
			preRestoreCheckpointId: 'ckpt-auto-99',
		});
		assert.strictEqual(ckptRestoreOut, 'OK mission.checkpoint.restore ckpt-1 backup=ckpt-auto-99');
	});

	test('covers all #93 §5 previously untested CLI commands (inbox.*, mode.get, project.move, secretary.*, mission.task.remove/edge.remove, token.retry, whiteboard.create)', () => {
		assert.deepStrictEqual(
			parseCliCommand(['inbox', 'list', '--unread', '--active-only', '--governor', 'gov-1'], CWD).params,
			{ unreadOnly: true, includeResolved: false, governor: 'gov-1' },
		);
		assert.deepStrictEqual(
			parseCliCommand(['inbox', 'post', '--from', 'gov-1', '--title', 'Gate Ready', '--message', 'Approve U1', '--node', 'U1'], CWD).params,
			{ from: 'gov-1', title: 'Gate Ready', message: 'Approve U1', node: 'U1' },
		);
		assert.deepStrictEqual(
			parseCliCommand(['inbox', 'mark-read', 'item-9'], CWD),
			{ help: false, json: false, windowId: undefined, action: 'inbox.markRead', params: { id: 'item-9' } },
		);
		assert.deepStrictEqual(
			parseCliCommand(['inbox', 'resolve', 'item-9', '--resolution', 'Approved'], CWD).params,
			{ id: 'item-9', resolution: 'Approved' },
		);
		assert.strictEqual(parseCliCommand(['mode', 'get'], CWD).action, 'mode.get');
		assert.deepStrictEqual(
			parseCliCommand(['project', 'move', '/workspace/a', '--before', '/workspace/b'], CWD).action,
			'project.move',
		);
		assert.strictEqual(parseCliCommand(['secretary', 'open'], CWD).action, 'secretary.open');
		assert.strictEqual(parseCliCommand(['secretary', 'status'], CWD).action, 'secretary.status');
		assert.strictEqual(parseCliCommand(['mission', 'task', 'remove', 'T9', '--mission', 'm-1'], CWD).action, 'mission.task.remove');
		assert.strictEqual(parseCliCommand(['mission', 'task', 'edge', 'remove', '--mission', 'm-1', 'T1', 'T2'], CWD).action, 'mission.task.edge.remove');
		assert.deepStrictEqual(
			parseCliCommand(['token', 'retry', 'otok-8', '--to', 'Dev2', '--note', 'Re-run with clean env'], CWD).params,
			{ tokenId: 'otok-8', nodeId: 'Dev2', guidance: 'Re-run with clean env' },
		);
		assert.strictEqual(
			parseCliCommand(['whiteboard', 'create', '--mission', 'm-1', '--department', 'Backend', '--title', 'Auth Spec'], CWD).action,
			'whiteboard.create',
		);
	});
});
