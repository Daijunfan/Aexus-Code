/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { FileAccess } from '../../../../base/common/network.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADE_CONTROL_META_NAME,
	ADE_CONTROL_SOCKET_NAME,
	IAdeControlConnectionMetadata,
	IAdeControlDispatchRequest,
	IAdeControlWireResponse,
} from '../../common/adeControl.js';
import { AdeControlServer } from '../../node/adeControlServer.js';

function sendRawLine(socketPath: string, rawLine: string): Promise<IAdeControlWireResponse> {
	return new Promise<IAdeControlWireResponse>((resolve, reject) => {
		const client = net.createConnection({ path: socketPath });
		const chunks: Buffer[] = [];

		client.once('error', reject);
		client.once('connect', () => {
			client.end(rawLine, 'utf8');
		});
		client.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
		});
		client.once('end', () => {
			try {
				const text = Buffer.concat(chunks).toString('utf8').trim();
				resolve(JSON.parse(text) as IAdeControlWireResponse);
			} catch (err) {
				reject(err);
			}
		});
	});
}

function sendWireRequest(socketPath: string, payload: Record<string, unknown>): Promise<IAdeControlWireResponse> {
	return sendRawLine(socketPath, JSON.stringify(payload) + '\n');
}

suite('AdeControlServer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let tempDir: string;

	setup(() => {
		// Use /tmp on POSIX so Unix domain socket paths stay well under the 104-byte macOS sun_path limit.
		const baseTmp = isWindows ? os.tmpdir() : '/tmp';
		tempDir = fs.mkdtempSync(path.join(baseTmp, 'ade-srv-'));
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('creates 0600 socket and metadata file and dispatches authenticated requests', async () => {
		const calls: Array<{ request: IAdeControlDispatchRequest; windowId?: number }> = [];
		const server = store.add(new AdeControlServer(async (request, windowId) => {
			calls.push({ request, windowId });
			return { echoedAction: request.action, count: 3 };
		}, { controlDir: tempDir }));

		await server.whenReady();

		const meta = JSON.parse(fs.readFileSync(server.metaPath, 'utf8')) as IAdeControlConnectionMetadata;
		assert.deepStrictEqual(meta, {
			socketPath: server.socketPath,
			token: server.token,
			pid: process.pid,
		});
		assert.strictEqual(meta.token.length, 64);

		if (!isWindows) {
			assert.deepStrictEqual({
				socketMode: fs.statSync(server.socketPath).mode & 0o777,
				metaMode: fs.statSync(server.metaPath).mode & 0o777,
			}, {
				socketMode: 0o600,
				metaMode: 0o600,
			});
		}

		const response = await sendWireRequest(meta.socketPath, {
			token: meta.token,
			action: 'project.list',
			params: { includeArchived: false },
			windowId: 7,
		});

		assert.deepStrictEqual({ response, calls }, {
			response: {
				ok: true,
				result: { echoedAction: 'project.list', count: 3 },
			},
			calls: [
				{
					request: { action: 'project.list', params: { includeArchived: false } },
					windowId: 7,
				},
			],
		});
	});

	test('rejects invalid tokens and malformed payloads without invoking dispatcher', async () => {
		let invoked = false;
		const server = store.add(new AdeControlServer(async () => {
			invoked = true;
			return { unexpected: true };
		}, { controlDir: tempDir, maxPayloadBytes: 256 }));

		await server.whenReady();

		const wrongEqualLengthToken = server.token.startsWith('a')
			? 'b' + server.token.slice(1)
			: 'a' + server.token.slice(1);

		const [wrongTokenRes, shortTokenRes, badJsonRes, oversizedRes] = await Promise.all([
			sendWireRequest(server.socketPath, { token: wrongEqualLengthToken, action: 'status' }),
			sendWireRequest(server.socketPath, { token: 'short', action: 'status' }),
			sendRawLine(server.socketPath, '{malformed-json\n'),
			sendWireRequest(server.socketPath, { token: server.token, action: 'status', params: { big: 'x'.repeat(512) } }),
		]);

		assert.deepStrictEqual({
			invoked,
			wrongTokenOk: wrongTokenRes.ok,
			shortTokenOk: shortTokenRes.ok,
			badJsonOk: badJsonRes.ok,
			oversizedOk: oversizedRes.ok,
		}, {
			invoked: false,
			wrongTokenOk: false,
			shortTokenOk: false,
			badJsonOk: false,
			oversizedOk: false,
		});
	});

	(isWindows ? test.skip : test)('recovers from a stale dead Unix socket file', async () => {
		const staleSocketPath = path.join(tempDir, ADE_CONTROL_SOCKET_NAME);

		// Spawn a short-lived child that binds a real Unix domain socket and exits immediately without unlinking it.
		const child = spawnSync(
			process.execPath,
			['-e', 'const net = require("net"); const s = net.createServer(); s.listen(process.argv[1], () => process.exit(0));', staleSocketPath],
			{ stdio: 'ignore' }
		);
		assert.strictEqual(child.status, 0);
		assert.strictEqual(fs.lstatSync(staleSocketPath).isSocket(), true);

		const server = store.add(new AdeControlServer(async req => ({ recovered: req.action }), {
			controlDir: tempDir,
			socketPath: staleSocketPath,
		}));
		await server.whenReady();

		const response = await sendWireRequest(staleSocketPath, {
			token: server.token,
			action: 'status',
		});

		assert.deepStrictEqual(response, {
			ok: true,
			result: { recovered: 'status' },
		});
	});

	(isWindows ? test.skip : test)('falls back to per-PID socket when primary socket is owned by a live server', async () => {
		const primarySocketPath = path.join(tempDir, ADE_CONTROL_SOCKET_NAME);
		const primaryMetaPath = path.join(tempDir, ADE_CONTROL_META_NAME);
		const primaryMetadata: IAdeControlConnectionMetadata = {
			socketPath: primarySocketPath,
			token: crypto.randomBytes(32).toString('hex'),
			pid: process.pid + 100_000,
		};

		const livePrimary = net.createServer(sock => sock.end());
		await new Promise<void>((resolve, reject) => {
			livePrimary.once('error', reject);
			livePrimary.listen(primarySocketPath, () => resolve());
		});

		try {
			fs.writeFileSync(primaryMetaPath, JSON.stringify(primaryMetadata), 'utf8');

			const secondary = store.add(new AdeControlServer(async req => ({ via: 'secondary', action: req.action }), {
				controlDir: tempDir,
			}));
			await secondary.whenReady();

			const expectedFallbackPath = path.join(tempDir, `ade-control.${process.pid}.sock`);
			const secondaryRes = await sendWireRequest(secondary.socketPath, {
				token: secondary.token,
				action: 'ping',
			});

			secondary.dispose();

			const preservedMeta = JSON.parse(fs.readFileSync(primaryMetaPath, 'utf8')) as IAdeControlConnectionMetadata;
			assert.deepStrictEqual({
				fallbackSocketPath: secondary.socketPath,
				secondaryRes,
				preservedMeta,
				primarySocketStillExists: fs.existsSync(primarySocketPath),
			}, {
				fallbackSocketPath: expectedFallbackPath,
				secondaryRes: { ok: true, result: { via: 'secondary', action: 'ping' } },
				preservedMeta: primaryMetadata,
				primarySocketStillExists: true,
			});
		} finally {
			await new Promise<void>(resolve => livePrimary.close(() => resolve()));
		}
	});

	test('handles concurrent requests and propagates dispatcher errors cleanly', async () => {
		const server = store.add(new AdeControlServer(async req => {
			if (req.action === 'fail') {
				throw new Error('Session abc not found');
			}
			const idx = Number(req.params?.index ?? 0);
			await new Promise(resolve => setTimeout(resolve, (10 - idx) * 3));
			return { index: idx };
		}, { controlDir: tempDir }));

		await server.whenReady();

		const concurrentResponses = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				sendWireRequest(server.socketPath, {
					token: server.token,
					action: 'echo',
					params: { index },
				})
			)
		);
		const errorResponse = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: 'fail',
		});

		assert.deepStrictEqual({
			concurrentResponses,
			errorResponse,
		}, {
			concurrentResponses: Array.from({ length: 8 }, (_, index) => ({ ok: true, result: { index } })),
			errorResponse: { ok: false, error: 'Session abc not found' },
		});
	});

	test('unlinks socket and owned metadata on dispose, while preserving foreign-PID metadata', async () => {
		const server1 = store.add(new AdeControlServer(async () => ({}), { controlDir: tempDir }));
		await server1.whenReady();

		const sock1 = server1.socketPath;
		const meta1 = server1.metaPath;
		assert.strictEqual(fs.existsSync(meta1), true);

		server1.dispose();
		assert.deepStrictEqual({
			sock1Exists: !isWindows && fs.existsSync(sock1),
			meta1Exists: fs.existsSync(meta1),
		}, {
			sock1Exists: false,
			meta1Exists: false,
		});

		const server2 = store.add(new AdeControlServer(async () => ({}), { controlDir: tempDir }));
		await server2.whenReady();

		const foreignMeta: IAdeControlConnectionMetadata = {
			socketPath: server2.socketPath,
			token: 'foreign-token',
			pid: process.pid + 200_000,
		};
		fs.writeFileSync(server2.metaPath, JSON.stringify(foreignMeta), 'utf8');

		server2.dispose();
		assert.deepStrictEqual({
			sock2Exists: !isWindows && fs.existsSync(server2.socketPath),
			foreignMetaPreserved: fs.existsSync(server2.metaPath),
		}, {
			sock2Exists: false,
			foreignMetaPreserved: true,
		});
	});

	(isWindows ? test.skip : test)('executes the bundled aexus-ade CLI end-to-end over the authenticated socket', async () => {
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			if (req.action === 'status') {
				return { mode: 'ade', counts: { projects: 2 } };
			}
			return { action: req.action, params: req.params };
		}, { controlDir: tempDir }));
		await server.whenReady();

		const repoRoot = path.resolve(FileAccess.asFileUri('').fsPath, '..');
		const cliBin = path.join(repoRoot, 'extensions', 'aexus-agents', 'bin', 'aexus-ade');
		const runCli = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(cliBin, args, {
				env: { ...process.env, AEXUS_ADE_CONTROL_FILE: server.metaPath },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => { stdout += chunk; });
			child.stderr.on('data', (chunk: string) => { stderr += chunk; });
			child.once('error', reject);
			child.once('close', status => resolve({ status, stdout, stderr }));
		});

		const helpRun = await runCli(['--help']);
		assert.strictEqual(helpRun.status, 0, helpRun.stderr);
		assert.ok(helpRun.stdout.includes('Usage: aexus-ade'));

		const statusRun = await runCli(['--json', 'status']);
		assert.strictEqual(statusRun.status, 0, statusRun.stderr);
		assert.deepStrictEqual(JSON.parse(statusRun.stdout), {
			mode: 'ade',
			counts: { projects: 2 },
		});

		const viewRun = await runCli(['--json', 'view', '--archived']);
		assert.strictEqual(viewRun.status, 0, viewRun.stderr);

		const createRun = await runCli(['--json', 'session', 'create', '--project', '/projects/Alpha', '--engine', 'codex', '--title', 'Auth Governor', '--role', 'governor', '--side']);
		assert.strictEqual(createRun.status, 0, createRun.stderr);

		const subsRun = await runCli(['--json', 'session', 'subordinates', 'gov-1', '--recursive']);
		assert.strictEqual(subsRun.status, 0, subsRun.stderr);

		const selfSubsRun = await runCli(['--json', 'session', 'subordinates']);
		assert.strictEqual(selfSubsRun.status, 0, selfSubsRun.stderr);

		const treeRun = await runCli(['--json', 'session', 'tree', 'gov-1']);
		assert.strictEqual(treeRun.status, 0, treeRun.stderr);

		const selfTreeRun = await runCli(['--json', 'session', 'tree']);
		assert.strictEqual(selfTreeRun.status, 0, selfTreeRun.stderr);

		const moveRun = await runCli(['--json', 'session', 'move', 'sub-1', 'gov-2', '--project', '/projects/Beta']);
		assert.strictEqual(moveRun.status, 0, moveRun.stderr);

		const historyRun = await runCli(['--json', 'session', 'history', 'sub-1', '--limit', '5']);
		assert.strictEqual(historyRun.status, 0, historyRun.stderr);

		const listRun = await runCli(['--json', 'session', 'list', '--parent', 'gov-1', '--role', 'worker']);
		assert.strictEqual(listRun.status, 0, listRun.stderr);

		const deleteRun = await runCli(['--json', 'session', 'delete', 'agent-1', '--force']);
		assert.strictEqual(deleteRun.status, 0, deleteRun.stderr);

		const projectDeleteRun = await runCli(['--json', 'project', 'delete', '/projects/Beta', '--sessions', '--files']);
		assert.strictEqual(projectDeleteRun.status, 0, projectDeleteRun.stderr);

		const secRun = await runCli(['--json', 'secretary', 'send', 'Focus', 'Alpha', '--wait']);
		assert.strictEqual(secRun.status, 0, secRun.stderr);

		const viewGetRun = await runCli(['--json', 'view', 'status']);
		assert.strictEqual(viewGetRun.status, 0, viewGetRun.stderr);

		const inspectorRun = await runCli(['--json', 'view', '--inspector', 'changes']);
		assert.strictEqual(inspectorRun.status, 0, inspectorRun.stderr);

		const selectProjRun = await runCli(['--json', 'project', 'select', '/projects/Alpha']);
		assert.strictEqual(selectProjRun.status, 0, selectProjRun.stderr);

		const changesRun = await runCli(['--json', 'project', 'changes', '/projects/Alpha']);
		assert.strictEqual(changesRun.status, 0, changesRun.stderr);

		const filesRun = await runCli(['--json', 'project', 'files', '/projects/Alpha', '--path', 'src', '--depth', '2']);
		assert.strictEqual(filesRun.status, 0, filesRun.stderr);

		const engSessRun = await runCli(['--json', 'engine', 'sessions', 'claude', '--project', '/projects/Alpha', '--limit', '10']);
		assert.strictEqual(engSessRun.status, 0, engSessRun.stderr);

		const attachRun = await runCli(['--json', 'session', 'attach', '--engine', 'claude', '--native-id', 'nat-1', '--project', '/projects/Alpha', '--role', 'manager', '--no-open']);
		assert.strictEqual(attachRun.status, 0, attachRun.stderr);

		const secHistRun = await runCli(['--json', 'secretary', 'history', '--limit', '5']);
		assert.strictEqual(secHistRun.status, 0, secHistRun.stderr);

		assert.deepStrictEqual(dispatched, [
			{ action: 'status', params: {} },
			{ action: 'view.set', params: { archived: true } },
			{
				action: 'session.create',
				params: {
					open: true,
					side: true,
					project: '/projects/Alpha',
					engine: 'codex',
					title: 'Auth Governor',
					role: 'governor',
				},
			},
			{ action: 'session.subordinates', params: { id: 'gov-1', recursive: true } },
			{ action: 'session.subordinates', params: {} },
			{ action: 'session.tree', params: { id: 'gov-1' } },
			{ action: 'session.tree', params: {} },
			{ action: 'session.reparent', params: { id: 'sub-1', parentId: 'gov-2', project: '/projects/Beta' } },
			{ action: 'session.history', params: { id: 'sub-1', limit: 5 } },
			{ action: 'session.list', params: { parent: 'gov-1', role: 'worker' } },
			{ action: 'session.delete', params: { id: 'agent-1' } },
			{ action: 'project.delete', params: { target: '/projects/Beta', deleteSessions: true, deleteFiles: true } },
			{ action: 'secretary.send', params: { prompt: 'Focus Alpha', wait: true } },
			{ action: 'view.get', params: {} },
			{ action: 'view.set', params: { inspector: 'changes' } },
			{ action: 'project.select', params: { target: '/projects/Alpha' } },
			{ action: 'project.changes', params: { target: '/projects/Alpha' } },
			{ action: 'project.files', params: { target: '/projects/Alpha', subpath: 'src', depth: 2 } },
			{ action: 'engine.sessions', params: { engine: 'claude', project: '/projects/Alpha', limit: 10 } },
			{ action: 'session.attach', params: { engine: 'claude', nativeId: 'nat-1', open: false, project: '/projects/Alpha', role: 'manager' } },
			{ action: 'secretary.history', params: { limit: 5 } },
		]);
	});

	(isWindows ? test.skip : test)('executes aexus-ade engineering and inbox CLI subcommands end-to-end with blueprint file reading and AEXUS_ADE_CALLER forwarding', async () => {
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { action: req.action, params: req.params };
		}, { controlDir: tempDir }));
		await server.whenReady();

		const sampleBpPath = path.join(tempDir, 'blueprint.md');
		fs.writeFileSync(sampleBpPath, '# Sample Blueprint\n', 'utf8');

		const repoRoot = path.resolve(FileAccess.asFileUri('').fsPath, '..');
		const cliBin = path.join(repoRoot, 'extensions', 'aexus-agents', 'bin', 'aexus-ade');
		const runCli = (args: string[], extraEnv?: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
			const child = spawn(cliBin, args, {
				env: { ...process.env, AEXUS_ADE_CONTROL_FILE: server.metaPath, ...(extraEnv ?? {}) },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => { stdout += chunk; });
			child.stderr.on('data', (chunk: string) => { stderr += chunk; });
			child.once('error', reject);
			child.once('close', status => resolve({ status, stdout, stderr }));
		});

		for (const [args, env] of [
			[['--json', 'engineering', 'init', '--governor', 'gov-1', '--on-children', 'relocate'], undefined],
			[['--json', 'engineering', 'list', '--tree-type', 'engineering'], undefined],
			[['--json', 'engineering', 'open', '--governor', 'gov-1'], undefined],
			[['--json', 'engineering', 'blueprint', 'get', '--governor', 'gov-1'], undefined],
			[['--json', 'engineering', 'blueprint', 'apply', '--governor', 'gov-1', '--file', sampleBpPath, '--force-stop-running'], undefined],
			[['--json', 'engineering', 'run', '--governor', 'gov-1'], { AEXUS_ADE_CALLER: 'secretary' }],
			[['--json', 'engineering', 'pause', '--governor', 'gov-1'], undefined],
			[['--json', 'engineering', 'resume', '--governor', 'gov-1'], { AEXUS_ADE_CALLER: 'secretary' }],
			[['--json', 'engineering', 'stop', '--governor', 'gov-1'], undefined],
			[['--json', 'engineering', 'status', '--governor', 'gov-1', '--node', 'N1'], undefined],
			[['--json', 'engineering', 'review', '--governor', 'gov-1', '--node', 'N1', '--role', 'employee', '--verdict', 'pass', '--report', 'Clean diff'], { AEXUS_ADE_CALLER: 'employee' }],
			[['--json', 'engineering', 'gate', '--governor', 'gov-1', '--node', 'U1', '--verdict', 'rollback', '--target-node', 'N1', '--feedback', 'Fix schema'], undefined],
			[['--json', 'engineering', 'watchdog-action', '--governor', 'gov-1', '--node', 'N1', '--action', 'kill-restart'], { AEXUS_ADE_CALLER: 'manager' }],
			[['--json', 'inbox', 'list', '--unread-only'], undefined],
			[['--json', 'inbox', 'post', '--from', 'gov-1', '--title', 'Need Decision', '--message', 'Approve migration?'], { AEXUS_ADE_CALLER: 'governor' }],
			[['--json', 'inbox', 'resolve', 'inb-1', '--note', 'Approved'], undefined],
			[['--json', 'inbox', 'mark-read', 'inb-1'], undefined],
		] as const) {
			const res = await runCli([...args], env);
			assert.strictEqual(res.status, 0, res.stderr);
		}

		assert.strictEqual(dispatched.length, 17);
		assert.deepStrictEqual(dispatched[0], {
			action: 'engineering.init',
			params: { governor: 'gov-1', onChildren: 'relocate' },
		});
		assert.strictEqual(dispatched[4].action, 'engineering.blueprint.apply');
		assert.strictEqual(dispatched[4].params?.text, '# Sample Blueprint\n');
		assert.strictEqual(dispatched[4].params?.forceStopRunning, true);
		assert.deepStrictEqual(dispatched[5], {
			action: 'engineering.run',
			params: { governor: 'gov-1', caller: 'secretary' },
		});
		assert.deepStrictEqual(dispatched[10], {
			action: 'engineering.review',
			params: { governor: 'gov-1', node: 'N1', role: 'employee', verdict: 'pass', report: 'Clean diff', caller: 'employee' },
		});
		assert.deepStrictEqual(dispatched[11], {
			action: 'engineering.gate',
			params: { governor: 'gov-1', node: 'U1', verdict: 'rollback', targetNode: 'N1', feedback: 'Fix schema' },
		});
		assert.deepStrictEqual(dispatched[12], {
			action: 'engineering.watchdogAction',
			params: { governor: 'gov-1', node: 'N1', watchdogAction: 'kill-restart', caller: 'manager' },
		});
		assert.deepStrictEqual(dispatched[14], {
			action: 'inbox.post',
			params: { from: 'gov-1', title: 'Need Decision', message: 'Approve migration?', caller: 'governor' },
		});
	});
});
