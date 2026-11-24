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
	ADE_CAPABILITY_TOKEN_PREFIX,
	ADE_CONTROL_META_NAME,
	ADE_CONTROL_SOCKET_NAME,
	ADE_MINT_SESSION_TOKEN_ACTION,
	ADE_REVOKE_SESSION_TOKEN_ACTION,
	IAdeControlConnectionMetadata,
	IAdeControlDispatchRequest,
	IAdeControlWireResponse,
	stripAdeControlEnv,
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

function sendWireRequestOverTcp(port: number, payload: Record<string, unknown>): Promise<IAdeControlWireResponse> {
	return new Promise<IAdeControlWireResponse>((resolve, reject) => {
		const client = net.createConnection({ host: '127.0.0.1', port });
		const chunks: Buffer[] = [];

		client.once('error', reject);
		client.once('connect', () => {
			client.end(JSON.stringify(payload) + '\n', 'utf8');
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

function spawnBundledAdeCli(repoRoot: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const binDir = path.join(repoRoot, 'extensions', 'aexus-agents', 'bin');
	return new Promise((resolve, reject) => {
		let child;
		if (isWindows) {
			const hasNewlineArg = args.some(a => a.includes('\n') || a.includes('\r'));
			if (hasNewlineArg) {
				// Windows cmd.exe batch `%*` truncates arguments at literal newlines; pass UTF-16LE `-EncodedCommand`
				// with single-quoted literals to `aexus-ade.ps1` so newlines and double quotes arrive verbatim.
				const psExe = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
				const psQuote = (s: string) => `'${s.replace(/'/g, '\'\'')}'`;
				const psScript = `& ${psQuote(path.join(binDir, 'aexus-ade.ps1'))} ${args.map(psQuote).join(' ')}; exit $LASTEXITCODE`;
				const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
				child = spawn(psExe, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
				});
			} else {
				const cliBin = path.join(binDir, 'aexus-ade.cmd');
				const escapeToken = (arg: string, isCmd: boolean) => {
					if (isCmd) {
						return `"${arg.replace(/"/g, '')}"`;
					}
					let esc = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
					esc = `"${esc}"`;
					return esc.replace(/[()%!^"<>&|]/g, '^$&');
				};
				const comspec = process.env['ComSpec'] || path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'cmd.exe');
				const innerCmd = [escapeToken(cliBin, true), ...args.map(a => escapeToken(a, false))].join(' ');
				child = spawn(comspec, ['/d', '/s', '/c', `"${innerCmd}"`], {
					env,
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
					windowsVerbatimArguments: true,
				});
			}
		} else {
			child = spawn(path.join(binDir, 'aexus-ade'), args, {
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		}
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.on('data', (chunk: string) => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', status => resolve({ status, stdout, stderr }));
	});
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
			tcpPort: server.tcpPort,
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
			{ stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
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
			const expectedInstanceMetaPath = path.join(tempDir, `ade-control.${process.pid}.json`);
			assert.strictEqual(secondary.instanceMetaPath, expectedInstanceMetaPath);
			const secondaryInstanceMeta = JSON.parse(fs.readFileSync(secondary.instanceMetaPath, 'utf8')) as IAdeControlConnectionMetadata;
			assert.deepStrictEqual(secondaryInstanceMeta, {
				socketPath: expectedFallbackPath,
				token: secondary.token,
				pid: process.pid,
				tcpPort: secondary.tcpPort,
			});
			assert.strictEqual(fs.statSync(secondary.instanceMetaPath).mode & 0o777, 0o600);
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
				instanceMetaCleanedUp: !fs.existsSync(expectedInstanceMetaPath),
			}, {
				fallbackSocketPath: expectedFallbackPath,
				secondaryRes: { ok: true, result: { via: 'secondary', action: 'ping' } },
				preservedMeta: primaryMetadata,
				primarySocketStillExists: true,
				instanceMetaCleanedUp: true,
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

	test('executes the bundled aexus-ade CLI end-to-end over the authenticated socket', async function () {
		this.timeout(30_000);
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
		const alphaPath = path.resolve('/projects/Alpha');
		const betaPath = path.resolve('/projects/Beta');
		const runCli = (args: string[]) => spawnBundledAdeCli(repoRoot, args, { ...process.env, AEXUS_ADE_CONTROL_FILE: server.metaPath });

		const helpRun = await runCli(['--help']);
		assert.strictEqual(helpRun.status, 0, helpRun.stderr);
		assert.ok(helpRun.stdout.includes('Usage: aexus-ade'));

		const statusRun = await runCli(['--json', 'status']);
		assert.strictEqual(statusRun.status, 0, statusRun.stderr);
		assert.deepStrictEqual(JSON.parse(statusRun.stdout), {
			schemaVersion: 1,
			mode: 'ade',
			counts: { projects: 2 },
		});

		const viewRun = await runCli(['--json', 'view', '--archived']);
		assert.strictEqual(viewRun.status, 0, viewRun.stderr);

		const createRun = await runCli(['--json', 'session', 'create', '--project', alphaPath, '--engine', 'codex', '--title', 'Auth Governor', '--role', 'governor', '--side']);
		assert.strictEqual(createRun.status, 0, createRun.stderr);

		const subsRun = await runCli(['--json', 'session', 'subordinates', 'gov-1', '--recursive']);
		assert.strictEqual(subsRun.status, 0, subsRun.stderr);

		const selfSubsRun = await runCli(['--json', 'session', 'subordinates']);
		assert.strictEqual(selfSubsRun.status, 0, selfSubsRun.stderr);

		const treeRun = await runCli(['--json', 'session', 'tree', 'gov-1']);
		assert.strictEqual(treeRun.status, 0, treeRun.stderr);

		const selfTreeRun = await runCli(['--json', 'session', 'tree']);
		assert.strictEqual(selfTreeRun.status, 0, selfTreeRun.stderr);

		const moveRun = await runCli(['--json', 'session', 'move', 'sub-1', 'gov-2', '--project', betaPath]);
		assert.strictEqual(moveRun.status, 0, moveRun.stderr);

		const historyRun = await runCli(['--json', 'session', 'history', 'sub-1', '--limit', '5']);
		assert.strictEqual(historyRun.status, 0, historyRun.stderr);

		const listRun = await runCli(['--json', 'session', 'list', '--parent', 'gov-1', '--role', 'worker']);
		assert.strictEqual(listRun.status, 0, listRun.stderr);

		const deleteRun = await runCli(['--json', 'session', 'delete', 'agent-1', '--force']);
		assert.strictEqual(deleteRun.status, 0, deleteRun.stderr);

		const projectDeleteRun = await runCli(['--json', 'project', 'delete', betaPath, '--sessions', '--files']);
		assert.strictEqual(projectDeleteRun.status, 0, projectDeleteRun.stderr);

		const secRun = await runCli(['--json', 'secretary', 'send', 'Focus', 'Alpha', '--wait']);
		assert.strictEqual(secRun.status, 0, secRun.stderr);

		const viewGetRun = await runCli(['--json', 'view', 'status']);
		assert.strictEqual(viewGetRun.status, 0, viewGetRun.stderr);

		const inspectorRun = await runCli(['--json', 'view', '--inspector', 'changes']);
		assert.strictEqual(inspectorRun.status, 0, inspectorRun.stderr);

		const selectProjRun = await runCli(['--json', 'project', 'select', alphaPath]);
		assert.strictEqual(selectProjRun.status, 0, selectProjRun.stderr);

		const changesRun = await runCli(['--json', 'project', 'changes', alphaPath]);
		assert.strictEqual(changesRun.status, 0, changesRun.stderr);

		const filesRun = await runCli(['--json', 'project', 'files', alphaPath, '--path', 'src', '--depth', '2']);
		assert.strictEqual(filesRun.status, 0, filesRun.stderr);

		const engSessRun = await runCli(['--json', 'engine', 'sessions', 'claude', '--project', alphaPath, '--limit', '10']);
		assert.strictEqual(engSessRun.status, 0, engSessRun.stderr);

		const attachRun = await runCli(['--json', 'session', 'attach', '--engine', 'claude', '--native-id', 'nat-1', '--project', alphaPath, '--role', 'manager', '--no-open']);
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
					project: alphaPath,
					engine: 'codex',
					title: 'Auth Governor',
					role: 'governor',
				},
			},
			{ action: 'session.subordinates', params: { id: 'gov-1', recursive: true } },
			{ action: 'session.subordinates', params: {} },
			{ action: 'session.tree', params: { id: 'gov-1' } },
			{ action: 'session.tree', params: {} },
			{ action: 'session.reparent', params: { id: 'sub-1', parentId: 'gov-2', project: betaPath } },
			{ action: 'session.history', params: { id: 'sub-1', limit: 5 } },
			{ action: 'session.list', params: { parent: 'gov-1', role: 'worker' } },
			{ action: 'session.delete', params: { id: 'agent-1', force: true } },
			{ action: 'project.delete', params: { target: betaPath, deleteSessions: true, deleteFiles: true } },
			{ action: 'secretary.send', params: { prompt: 'Focus Alpha', wait: true } },
			{ action: 'view.get', params: {} },
			{ action: 'view.set', params: { inspector: 'changes' } },
			{ action: 'project.select', params: { target: alphaPath } },
			{ action: 'project.changes', params: { target: alphaPath } },
			{ action: 'project.files', params: { target: alphaPath, subpath: 'src', depth: 2 } },
			{ action: 'engine.sessions', params: { engine: 'claude', project: alphaPath, limit: 10 } },
			{ action: 'session.attach', params: { engine: 'claude', nativeId: 'nat-1', open: false, project: alphaPath, role: 'manager' } },
			{ action: 'secretary.history', params: { limit: 5 } },
		]);
	});

	test('executes aexus-ade mission, token, org and inbox CLI subcommands end-to-end with blueprint file reading and AEXUS_ADE_CALLER forwarding', async function () {
		this.timeout(30_000);
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { action: req.action, params: req.params };
		}, { controlDir: tempDir }));
		await server.whenReady();

		const sampleBpPath = path.join(tempDir, 'mission.mmd');
		fs.writeFileSync(sampleBpPath, 'flowchart LR\n  N1["Spec"] --> N2["Build"]\n', 'utf8');

		const repoRoot = path.resolve(FileAccess.asFileUri('').fsPath, '..');
		const runCli = (args: string[], extraEnv?: Record<string, string>) => spawnBundledAdeCli(repoRoot, args, { ...process.env, AEXUS_ADE_CONTROL_FILE: server.metaPath, ...(extraEnv ?? {}) });

		for (const [args, env] of [
			[['--json', 'mission', 'init', '--governor', 'gov-1', '--open'], undefined],
			[['--json', 'mission', 'list'], undefined],
			[['--json', 'mission', 'open', '--governor', 'gov-1'], undefined],
			[['--json', 'mission', 'blueprint', 'get', '--governor', 'gov-1'], undefined],
			[['--json', 'mission', 'blueprint', 'apply', '--governor', 'gov-1', '--file', sampleBpPath], undefined],
			[['--json', 'mission', 'run', '--governor', 'gov-1'], { AEXUS_ADE_CALLER: 'secretary' }],
			[['--json', 'mission', 'pause', '--governor', 'gov-1'], undefined],
			[['--json', 'mission', 'resume', '--governor', 'gov-1'], { AEXUS_ADE_CALLER: 'secretary' }],
			[['--json', 'mission', 'stop', '--governor', 'gov-1'], undefined],
			[['--json', 'mission', 'status', '--governor', 'gov-1'], undefined],
			[['--json', 'token', 'complete', 'tok-1', '--summary', 'Clean diff'], { AEXUS_ADE_CALLER: 'employee' }],
			[['--json', 'mission', 'gate', 'reject', '--mission', 'm-1', '--node', 'U1', '--rollback', 'N1', '--note', 'Fix schema'], undefined],
			[['--json', 'mission', 'prompt', 'set', '--mission', 'm-1', '--node', 'N1', '--text', 'Verify invariants'], { AEXUS_ADE_CALLER: 'manager' }],
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
			action: 'mission.init',
			params: { owner: 'gov-1', open: true },
		});
		assert.strictEqual(dispatched[4].action, 'mission.blueprint.apply');
		assert.strictEqual(dispatched[4].params?.text, 'flowchart LR\n  N1["Spec"] --> N2["Build"]\n');
		assert.deepStrictEqual(dispatched[5], {
			action: 'mission.run',
			params: { missionId: 'gov-1', caller: 'secretary' },
		});
		assert.deepStrictEqual(dispatched[10], {
			action: 'token.complete',
			params: { tokenId: 'tok-1', summary: 'Clean diff', caller: 'employee' },
		});
		assert.deepStrictEqual(dispatched[11], {
			action: 'mission.gate',
			params: { missionId: 'm-1', node: 'U1', decision: 'reject', rollback: 'N1', note: 'Fix schema' },
		});
		assert.deepStrictEqual(dispatched[12], {
			action: 'mission.prompt.set',
			params: { missionId: 'm-1', nodeId: 'N1', prompt: 'Verify invariants', caller: 'manager' },
		});
		assert.deepStrictEqual(dispatched[14], {
			action: 'inbox.post',
			params: { from: 'gov-1', title: 'Need Decision', message: 'Approve migration?', caller: 'governor' },
		});
	});

	test('parses free-text prompts, mission options, and inbox mark-read usage end-to-end', async function () {
		this.timeout(30_000);
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { action: req.action, params: req.params };
		}, { controlDir: tempDir }));
		await server.whenReady();

		const repoRoot = path.resolve(FileAccess.asFileUri('').fsPath, '..');
		const runCli = (args: string[], extraEnv?: Record<string, string>) => spawnBundledAdeCli(repoRoot, args, { ...process.env, AEXUS_ADE_CONTROL_FILE: server.metaPath, AEXUS_ADE_CALLER: '', ...(extraEnv ?? {}) });

		// `--json` after the positional prompt is opaque text, never a global flag.
		const sendRun = await runCli(['session', 'send', 'sess-1', 'Please', 'explain', '--json', 'output']);
		const promptGetRun = await runCli(['mission', 'prompt', 'get', '--mission', 'm1', '--node', 'N2']);
		const recallRun = await runCli(['mission', 'recall', '--mission', 'm1', '--nodes', 'N2', '--reason', 'pivot']);
		const retryRun = await runCli(['mission', 'retry', '--mission', 'm1', '--node', 'N1']);
		const blueprintGetRun = await runCli(['mission', 'blueprint', 'get', '--governor', 'g1', '--raw']);
		const validateText = 'flowchart LR\n  A["Only Node"]';
		const validateRun = await runCli(['mission', 'blueprint', 'validate', '--text', validateText]);
		const bareMarkReadRun = await runCli(['inbox', 'mark-read']);
		const markReadAllRun = await runCli(['inbox', 'mark-read', '--all']);
		const runWithCaller = await runCli(['mission', 'run', '--governor', 'g1'], { AEXUS_ADE_CALLER: 'manager' });

		assert.deepStrictEqual(
			{
				statuses: [
					sendRun.status,
					promptGetRun.status,
					recallRun.status,
					retryRun.status,
					blueprintGetRun.status,
					validateRun.status,
					bareMarkReadRun.status,
					markReadAllRun.status,
					runWithCaller.status,
				],
				bareMarkReadUsage: bareMarkReadRun.stderr.includes('Usage: aexus-ade inbox mark-read (<id> | --all)'),
				dispatched,
			},
			{
				statuses: [0, 0, 0, 0, 0, 0, 1, 0, 0],
				bareMarkReadUsage: true,
				dispatched: [
					{ action: 'session.send', params: { id: 'sess-1', prompt: 'Please explain --json output' } },
					{ action: 'mission.prompt.get', params: { missionId: 'm1', nodeId: 'N2' } },
					{ action: 'mission.recall', params: { missionId: 'm1', nodes: ['N2'], reason: 'pivot' } },
					{ action: 'mission.retry', params: { missionId: 'm1', nodeId: 'N1' } },
					{ action: 'mission.blueprint.get', params: { missionId: 'g1', raw: true } },
					{ action: 'mission.blueprint.validate', params: { text: validateText } },
					{ action: 'inbox.markRead', params: { all: true } },
					{ action: 'mission.run', params: { missionId: 'g1', caller: 'manager' } },
				],
			},
		);
	});

	test('enforces server-signed per-session capability tokens, blocks spoofing/tampering, and denies pure Workers', async () => {
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { action: req.action, params: req.params };
		}, { controlDir: tempDir }));
		await server.whenReady();

		// 1. Per-instance metadata file is always created alongside global meta with 0600 permissions.
		const expectedInstanceMetaPath = path.join(tempDir, `ade-control.${process.pid}.json`);
		assert.strictEqual(server.instanceMetaPath, expectedInstanceMetaPath);
		assert.deepStrictEqual(
			JSON.parse(fs.readFileSync(server.instanceMetaPath, 'utf8')) as IAdeControlConnectionMetadata,
			{ socketPath: server.socketPath, token: server.token, pid: process.pid, tcpPort: server.tcpPort },
		);
		if (!isWindows) {
			assert.strictEqual(fs.statSync(server.instanceMetaPath).mode & 0o777, 0o600);
		}

		// 2. auth.mintSessionToken succeeds with master token and is intercepted before workbench dispatcher.
		const mintEmployeeRes = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'emp-42', rank: 'employee', pure: false },
		});
		assert.strictEqual(mintEmployeeRes.ok, true);
		const employeeToken = (mintEmployeeRes.result as { token?: string })?.token ?? '';
		assert.ok(employeeToken.startsWith(ADE_CAPABILITY_TOKEN_PREFIX));
		assert.strictEqual(dispatched.length, 0, 'auth.mintSessionToken must be handled inside AdeControlServer');

		const mintPureRes = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'wrk-99', rank: 'worker', pure: true },
		});
		assert.strictEqual(mintPureRes.ok, true);
		const pureWorkerToken = (mintPureRes.result as { token?: string })?.token ?? '';
		assert.ok(pureWorkerToken.startsWith(ADE_CAPABILITY_TOKEN_PREFIX));

		// 3. Capability tokens CANNOT mint new session tokens.
		const mintWithCapRes = await sendWireRequest(server.socketPath, {
			token: employeeToken,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'spoof-1', rank: 'secretary', pure: false },
		});
		assert.strictEqual(mintWithCapRes.ok, false);
		assert.match(mintWithCapRes.error ?? '', /master control token/i);

		// 4. Tampered payload or tampered HMAC signature is rejected without invoking dispatcher.
		const [, body] = employeeToken.split(ADE_CAPABILITY_TOKEN_PREFIX);
		const [encodedPayload, sigHex] = body.split('.');
		const forgedPayload = Buffer.from(JSON.stringify({ sid: 'emp-42', rank: 'secretary', iat: Date.now() }), 'utf8').toString('base64url');
		const tamperedPayloadToken = `${ADE_CAPABILITY_TOKEN_PREFIX}${forgedPayload}.${sigHex}`;
		const tamperedSigToken = `${ADE_CAPABILITY_TOKEN_PREFIX}${encodedPayload}.${(sigHex.startsWith('0') ? '1' : '0') + sigHex.slice(1)}`;
		const [tamperedPayloadRes, tamperedSigRes, forgedTokenRes] = await Promise.all([
			sendWireRequest(server.socketPath, { token: tamperedPayloadToken, action: 'session.delete', params: { id: 'gov-1' } }),
			sendWireRequest(server.socketPath, { token: tamperedSigToken, action: 'session.delete', params: { id: 'gov-1' } }),
			sendWireRequest(server.socketPath, { token: `${ADE_CAPABILITY_TOKEN_PREFIX}bad`, action: 'status' }),
		]);
		assert.strictEqual(tamperedPayloadRes.ok, false);
		assert.strictEqual(tamperedSigRes.ok, false);
		assert.strictEqual(forgedTokenRes.ok, false);
		assert.strictEqual(dispatched.length, 0);

		// 5. Pure execution Worker token is immediately denied before reaching dispatcher.
		const pureRes = await sendWireRequest(server.socketPath, {
			token: pureWorkerToken,
			action: 'session.delete',
			params: { id: 'gov-1', caller: 'secretary' },
		});
		assert.deepStrictEqual(pureRes, {
			ok: false,
			error: 'Permission denied: pure execution Worker sessions have no ADE control plane access.',
		});
		assert.strictEqual(dispatched.length, 0);

		// 6. Valid capability token forcibly overwrites spoofed/absent caller with verified rank + sessionId.
		const spoofAttemptRes = await sendWireRequest(server.socketPath, {
			token: employeeToken,
			action: 'token.complete',
			params: { tokenId: 'tok-1', summary: 'Done', caller: 'secretary', _verifiedCaller: false, _callerSessionId: 'fake' },
		});
		assert.strictEqual(spoofAttemptRes.ok, true);
		const omittedCallerRes = await sendWireRequest(server.socketPath, {
			token: employeeToken,
			action: 'status',
		});
		assert.strictEqual(omittedCallerRes.ok, true);
		for (const d of dispatched) {
			assert.strictEqual(typeof d.params?._callerTokenIat, 'number');
		}
		assert.deepStrictEqual(
			dispatched.map(d => {
				const { _callerTokenIat: _iat, ...rest } = d.params ?? {};
				return { action: d.action, params: rest };
			}),
			[
				{
					action: 'token.complete',
					params: {
						tokenId: 'tok-1',
						summary: 'Done',
						caller: 'employee',
						_verifiedCaller: true,
						_callerSessionId: 'emp-42',
					},
				},
				{
					action: 'status',
					params: {
						caller: 'employee',
						_verifiedCaller: true,
						_callerSessionId: 'emp-42',
					},
				},
			],
		);
	});

	test('exposes loopback TCP bridge metadata and enforces capability tokens over TCP', async () => {
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { via: 'tcp', action: req.action };
		}, { controlDir: tempDir }));
		await server.whenReady();

		// 1. The loopback listener owns a valid ephemeral port and persists it in metadata.
		const tcpPort = server.tcpPort;
		assert.ok(typeof tcpPort === 'number' && Number.isInteger(tcpPort) && tcpPort > 0, 'tcpPort must be a positive integer');
		const meta = JSON.parse(fs.readFileSync(server.metaPath, 'utf8')) as IAdeControlConnectionMetadata;
		assert.strictEqual(meta.tcpPort, tcpPort);

		// 2. A server-minted capability token authenticates over TCP and is verified as the session caller.
		const employeeToken = server.mintSessionCapabilityToken('emp-9', 'employee', false);
		const employeeRes = await sendWireRequestOverTcp(tcpPort, { token: employeeToken, action: 'status' });
		assert.deepStrictEqual(employeeRes, { ok: true, result: { via: 'tcp', action: 'status' } });
		assert.strictEqual(typeof dispatched[0]?.params?._callerTokenIat, 'number');
		assert.deepStrictEqual(
			dispatched.map(d => {
				const { _callerTokenIat: _iat, ...rest } = d.params ?? {};
				return { action: d.action, params: rest };
			}),
			[{
				action: 'status',
				params: {
					caller: 'employee',
					_verifiedCaller: true,
					_callerSessionId: 'emp-9',
				},
			}],
		);

		// 3. Pure Workers and invalid tokens are still rejected over TCP, before reaching the dispatcher.
		const pureToken = server.mintSessionCapabilityToken('wrk-9', 'worker', true);
		const [pureRes, invalidRes] = await Promise.all([
			sendWireRequestOverTcp(tcpPort, { token: pureToken, action: 'status' }),
			sendWireRequestOverTcp(tcpPort, { token: 'not-a-valid-token', action: 'status' }),
		]);
		assert.deepStrictEqual(pureRes, {
			ok: false,
			error: 'Permission denied: pure execution Worker sessions have no ADE control plane access.',
		});
		assert.strictEqual(invalidRes.ok, false);
		assert.match(invalidRes.error ?? '', /^Unauthorized/);
		assert.strictEqual(dispatched.length, 1, 'rejected TCP requests must not reach the dispatcher');
	});

	test('stripAdeControlEnv removes all ADE control-plane credentials case-insensitively without mutating source env', () => {
		const original: NodeJS.ProcessEnv = {
			PATH: '/usr/bin',
			HOME: '/Users/dev',
			AEXUS_ADE_CONTROL_FILE: '/tmp/ade-control.json',
			AEXUS_ADE_TOKEN: 'master-token',
			AEXUS_ADE_SOCKET: '/tmp/ade.sock',
			AEXUS_ADE_SESSION_TOKEN: 'aexus-cap.abc.def',
			AEXUS_ADE_CALLER: 'governor',
			aexus_ade_token: 'lowercase-win-variant',
			AEXUS_OTHER: 'keep-me',
		};
		const cleaned = stripAdeControlEnv(original);
		assert.deepStrictEqual(cleaned, {
			PATH: '/usr/bin',
			HOME: '/Users/dev',
			AEXUS_OTHER: 'keep-me',
		});
		assert.strictEqual(original.AEXUS_ADE_TOKEN, 'master-token', 'source env must not be mutated');
	});

	test('routes bundled aexus-ade CLI via AEXUS_ADE_SESSION_TOKEN without reading master control metadata', async function () {
		this.timeout(30_000);
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { action: req.action, params: req.params };
		}, { controlDir: tempDir }));
		await server.whenReady();

		const managerToken = server.mintSessionCapabilityToken('mgr-7', 'manager', false);
		const pureToken = server.mintSessionCapabilityToken('wrk-7', 'worker', true);
		const repoRoot = path.resolve(FileAccess.asFileUri('').fsPath, '..');
		const nonexistentHome = path.join(tempDir, 'no-such-ade-home');

		// Even with AEXUS_ADE_CALLER=secretary and no control file, server enforces manager from the signed token.
		const mgrRun = await spawnBundledAdeCli(repoRoot, ['--json', 'mission', 'retry', '--mission', 'm-1', '--node', 'N1'], {
			...process.env,
			AEXUS_ADE_HOME: nonexistentHome,
			AEXUS_ADE_CONTROL_FILE: path.join(nonexistentHome, 'missing.json'),
			AEXUS_ADE_TOKEN: '',
			AEXUS_ADE_SOCKET: server.socketPath,
			AEXUS_ADE_SESSION_TOKEN: managerToken,
			AEXUS_ADE_CALLER: 'secretary',
		});
		assert.strictEqual(mgrRun.status, 0, mgrRun.stderr);

		// Pure Worker capability token fails with exit code 1 and permission-denied error.
		const workerRun = await spawnBundledAdeCli(repoRoot, ['--json', 'session', 'delete', 'gov-1', '--force'], {
			...process.env,
			AEXUS_ADE_HOME: nonexistentHome,
			AEXUS_ADE_CONTROL_FILE: path.join(nonexistentHome, 'missing.json'),
			AEXUS_ADE_TOKEN: '',
			AEXUS_ADE_SOCKET: server.socketPath,
			AEXUS_ADE_SESSION_TOKEN: pureToken,
			AEXUS_ADE_CALLER: 'secretary',
		});
		assert.strictEqual(workerRun.status, 1);
		assert.match(workerRun.stdout + workerRun.stderr, /pure execution Worker sessions have no ADE control plane access/i);

		assert.strictEqual(typeof dispatched[0]?.params?._callerTokenIat, 'number');
		assert.deepStrictEqual(
			dispatched.map(d => {
				const { _callerTokenIat: _iat, ...rest } = d.params ?? {};
				return { action: d.action, params: rest };
			}),
			[
				{
					action: 'mission.retry',
					params: {
						missionId: 'm-1',
						nodeId: 'N1',
						caller: 'manager',
						_verifiedCaller: true,
						_callerSessionId: 'mgr-7',
					},
				},
			],
		);
	});

	test('allows pure-rank Mission node capability tokens strictly for token.*/whoami/docs.read/api.update while blocking all other actions', async () => {
		const dispatched: IAdeControlDispatchRequest[] = [];
		const server = store.add(new AdeControlServer(async req => {
			dispatched.push(req);
			return { ok: true, action: req.action };
		}, { controlDir: tempDir }));
		await server.whenReady();

		// Mint pure + missionNode token via auth.mintSessionToken wire action
		const mintRes = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'mnode-1', rank: 'worker', pure: true, missionNode: true },
		});
		assert.strictEqual(mintRes.ok, true);
		const missionNodePureToken = (mintRes.result as { readonly token: string }).token;

		// Allowed in-graph token/universal/read-only check actions succeed with verified worker identity
		const completeRes = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'token.complete',
			params: { tokenId: 'tok-1', summary: 'Done' },
		});
		const returnRes = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'token.return',
			params: { tokenId: 'otok-1', summary: 'Returned to superior' },
		});
		const whoamiRes = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'whoami',
		});
		const dryRunCheckRes = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'mission.check.run',
			params: { missionId: 'm1', nodeId: 'N1' },
		});
		assert.strictEqual(completeRes.ok, true);
		assert.strictEqual(returnRes.ok, true);
		assert.strictEqual(whoamiRes.ok, true);
		assert.strictEqual(dryRunCheckRes.ok, true);

		// All non-token orchestration actions (including mint/split, staff mutation, task completion, check mutation) are strictly denied
		const deniedMint = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'token.mint',
			params: { tokenId: 'otok-1', branches: [] },
		});
		const deniedStaffRemove = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'orchestration.staff.remove',
			params: { nodeId: 'E1' },
		});
		const deniedTaskComplete = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'mission.task.complete',
			params: { nodeId: 'T1' },
		});
		const deniedPatch = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'mission.patch',
			params: { mermaid: 'flowchart LR\n  A --> B' },
		});
		const deniedCheckSet = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'mission.check.set',
			params: { missionId: 'm1', nodeId: 'N1', command: 'true' },
		});
		const deniedCheckRemove = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'mission.check.remove',
			params: { missionId: 'm1', nodeId: 'N1' },
		});
		const deniedDelete = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'session.delete',
			params: { id: 'gov-1' },
		});
		const deniedWhiteboardCreate = await sendWireRequest(server.socketPath, {
			token: missionNodePureToken,
			action: 'whiteboard.create',
			params: { missionId: 'm1', id: 'wb_rogue', title: 'Rogue', content: 'nope' },
		});
		for (const denied of [deniedMint, deniedStaffRemove, deniedTaskComplete, deniedPatch, deniedCheckSet, deniedCheckRemove, deniedDelete, deniedWhiteboardCreate]) {
			assert.strictEqual(denied.ok, false);
			assert.match(denied.error ?? '', /pure-execution (Mission node|Engineering staff) sessions/i);
		}

		for (const d of dispatched) {
			assert.strictEqual(typeof d.params?._callerTokenIat, 'number');
		}
		assert.deepStrictEqual(
			dispatched.map(d => {
				const { _callerTokenIat: _iat, ...rest } = d.params ?? {};
				return { action: d.action, params: rest };
			}),
			[
				{
					action: 'token.complete',
					params: { tokenId: 'tok-1', summary: 'Done', caller: 'worker', _verifiedCaller: true, _callerSessionId: 'mnode-1' },
				},
				{
					action: 'token.return',
					params: { tokenId: 'otok-1', summary: 'Returned to superior', caller: 'worker', _verifiedCaller: true, _callerSessionId: 'mnode-1' },
				},
				{
					action: 'whoami',
					params: { caller: 'worker', _verifiedCaller: true, _callerSessionId: 'mnode-1' },
				},
				{
					action: 'mission.check.run',
					params: { missionId: 'm1', nodeId: 'N1', caller: 'worker', _verifiedCaller: true, _callerSessionId: 'mnode-1' },
				},
			],
		);
	});

	test('pins originating windowId into signed capability token and routes background requests with softWindowPin fallback', async () => {
		const routed: Array<{ action: string; windowId: number | undefined; softWindowPin: boolean | undefined }> = [];
		const server = store.add(new AdeControlServer(async (req, windowId, opts) => {
			routed.push({ action: req.action, windowId, softWindowPin: opts?.softWindowPin });
			return { ok: true };
		}, { controlDir: tempDir }));
		await server.whenReady();

		const mintRes = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'emp-bg', rank: 'employee', windowId: 42 },
		});
		assert.strictEqual(mintRes.ok, true);
		const pinnedToken = (mintRes.result as { readonly token: string }).token;

		// 1. Omitting wire windowId automatically routes to signed wid=42 with softWindowPin=true
		const implicitRes = await sendWireRequest(server.socketPath, {
			token: pinnedToken,
			action: 'token.complete',
			params: { tokenId: 'tok-1', summary: 'done' },
		});
		assert.strictEqual(implicitRes.ok, true);

		// 2. Explicit wire windowId overrides token wid with strict routing (softWindowPin undefined)
		const explicitRes = await sendWireRequest(server.socketPath, {
			token: pinnedToken,
			action: 'token.current',
			windowId: 7,
		});
		assert.strictEqual(explicitRes.ok, true);

		assert.deepStrictEqual(routed, [
			{ action: 'token.complete', windowId: 42, softWindowPin: true },
			{ action: 'token.current', windowId: 7, softWindowPin: undefined },
		]);
	});

	test('fails hung control requests cleanly after executionTimeoutMs instead of hanging CLI forever', async () => {
		const server = store.add(new AdeControlServer(async req => {
			if (req.action === 'org.send') {
				return new Promise(() => { /* intentionally never settles */ });
			}
			return { ok: true };
		}, {
			controlDir: tempDir,
			executionTimeoutMs: 120,
		}));
		await server.whenReady();

		const startedAt = Date.now();
		const res = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: 'org.send',
			params: { target: 'emp-1', message: 'ping' },
		});
		const elapsed = Date.now() - startedAt;

		assert.strictEqual(res.ok, false);
		assert.match(res.error ?? '', /timed out after 120ms/i);
		assert.ok(elapsed < 2000, `Expected bounded timeout, took ${elapsed}ms`);

		// Subsequent healthy requests continue working after a timed-out request.
		const healthy = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: 'status',
		});
		assert.deepStrictEqual(healthy, { ok: true, result: { ok: true } });
	});

	test('enforces capability token TTL expiration and immediate session token revocation', async () => {
		let fakeNow = 1_700_000_000_000;
		const server = store.add(new AdeControlServer(async req => ({ action: req.action, caller: req.params?._callerSessionId }), {
			controlDir: tempDir,
			capabilityTokenTtlMs: 5_000,
			now: () => fakeNow,
		}));
		await server.whenReady();

		const mint1 = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'emp-ttl', rank: 'employee' },
		});
		assert.strictEqual(mint1.ok, true);
		const tok1 = (mint1.result as { readonly token: string }).token;
		const parsedPayload = JSON.parse(Buffer.from(tok1.slice(ADE_CAPABILITY_TOKEN_PREFIX.length).split('.')[0], 'base64url').toString('utf8')) as { readonly exp?: number };
		assert.strictEqual(parsedPayload.exp, fakeNow + 5_000);

		// Valid before TTL
		const okBefore = await sendWireRequest(server.socketPath, { token: tok1, action: 'whoami' });
		assert.strictEqual(okBefore.ok, true);

		// Revoke session immediately via wire action
		fakeNow += 1_000;
		const revokeRes = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_REVOKE_SESSION_TOKEN_ACTION,
			params: { sessionId: 'emp-ttl' },
		});
		assert.strictEqual(revokeRes.ok, true);

		const afterRevoke = await sendWireRequest(server.socketPath, { token: tok1, action: 'whoami' });
		assert.strictEqual(afterRevoke.ok, false);
		assert.match(afterRevoke.error ?? '', /Unauthorized/i);

		// Re-minting after revocation yields a fresh valid token
		fakeNow += 500;
		const mint2 = await sendWireRequest(server.socketPath, {
			token: server.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'emp-ttl', rank: 'employee' },
		});
		assert.strictEqual(mint2.ok, true);
		const tok2 = (mint2.result as { readonly token: string }).token;
		const okRemint = await sendWireRequest(server.socketPath, { token: tok2, action: 'whoami' });
		assert.strictEqual(okRemint.ok, true);

		// Advance past tok2 TTL -> rejected as expired
		fakeNow += 6_000;
		const expiredRes = await sendWireRequest(server.socketPath, { token: tok2, action: 'whoami' });
		assert.strictEqual(expiredRes.ok, false);
		assert.match(expiredRes.error ?? '', /Unauthorized/i);
	});

	test('aborts dispatch AbortSignal on timeout and enforces maxConcurrentSockets & headerTimeoutMs', async () => {
		let abortedOnTimeout = false;
		const server = store.add(new AdeControlServer(async (req, _windowId, opts) => {
			if (req.action === 'slow.op') {
				opts?.signal?.addEventListener('abort', () => {
					abortedOnTimeout = true;
				});
				return new Promise(() => { /* intentionally stalls */ });
			}
			return { ok: true };
		}, {
			controlDir: tempDir,
			executionTimeoutMs: 100,
			headerTimeoutMs: 120,
			maxConcurrentSockets: 2,
		}));
		await server.whenReady();

		// 1. Timeout aborts AbortSignal cleanly
		const slowRes = await sendWireRequest(server.socketPath, { token: server.token, action: 'slow.op' });
		assert.strictEqual(slowRes.ok, false);
		assert.strictEqual(abortedOnTimeout, true, 'AbortSignal must fire when executionTimeoutMs trips');

		// 2. Stalled pre-newline client is terminated by headerTimeoutMs
		const stalledResult = await new Promise<string>((resolve, reject) => {
			const sock = net.createConnection({ path: server.socketPath });
			const chunks: Buffer[] = [];
			sock.once('error', reject);
			sock.once('connect', () => {
				sock.write('{"token":"incomplete"');
			});
			sock.on('data', c => chunks.push(c));
			sock.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
		});
		assert.match(stalledResult, /header deadline exceeded/i);

		// 3. Excess concurrent sockets beyond maxConcurrentSockets are rejected with busy error
		const hold1 = net.createConnection({ path: server.socketPath });
		const hold2 = net.createConnection({ path: server.socketPath });
		await Promise.all([
			new Promise<void>(r => hold1.once('connect', r)),
			new Promise<void>(r => hold2.once('connect', r)),
		]);
		try {
			const overflow = await sendWireRequest(server.socketPath, { token: server.token, action: 'status' });
			assert.strictEqual(overflow.ok, false);
			assert.match(overflow.error ?? '', /Too many concurrent/i);
		} finally {
			hold1.destroy();
			hold2.destroy();
		}
	});

	test('C1 idempotency ledger: replay, concurrent coalescing, conflict detection, cross-principal isolation, disk persistence, and pure missionNode policy', async () => {
		let execCount = 0;
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });

		const server1 = new AdeControlServer(async req => {
			execCount++;
			if (req.action === 'token.mint' && req.params?.slow === true) {
				await slowGate;
			}
			return { seq: execCount, action: req.action, summary: req.params?.summary };
		}, {
			controlDir: tempDir,
		});
		await server1.whenReady();

		try {
			// Mint two distinct session principals
			const mintA = await sendWireRequest(server1.socketPath, {
				token: server1.token,
				action: ADE_MINT_SESSION_TOKEN_ACTION,
				params: { sessionId: 'sess-idem-a', rank: 'manager', isMissionNode: true },
			});
			const mintB = await sendWireRequest(server1.socketPath, {
				token: server1.token,
				action: ADE_MINT_SESSION_TOKEN_ACTION,
				params: { sessionId: 'sess-idem-b', rank: 'manager', isMissionNode: true },
			});
			const mintPure = await sendWireRequest(server1.socketPath, {
				token: server1.token,
				action: ADE_MINT_SESSION_TOKEN_ACTION,
				params: { sessionId: 'sess-pure-node', rank: 'worker', pure: true, missionNode: true },
			});
			const tokA = (mintA.result as { readonly token: string }).token;
			const tokB = (mintB.result as { readonly token: string }).token;
			const tokPure = (mintPure.result as { readonly token: string }).token;

			// 1. Replay identical (principal, action, idempotencyKey) executes handler ONCE and marks idempotentReplay: true
			const first = await sendWireRequest(server1.socketPath, {
				token: tokA,
				action: 'token.return',
				params: { summary: 'done-1', mission: 'm1' },
				idempotencyKey: 'idem-key-001',
			});
			assert.strictEqual(first.ok, true);
			assert.strictEqual(first.idempotentReplay, undefined);
			assert.strictEqual((first.result as { readonly seq: number }).seq, 1);

			const replay = await sendWireRequest(server1.socketPath, {
				token: tokA,
				action: 'token.return',
				params: { mission: 'm1', summary: 'done-1' }, // different key order -> canonical hash must match
				idempotencyKey: 'idem-key-001',
			});
			assert.strictEqual(replay.ok, true);
			assert.strictEqual(replay.idempotentReplay, true);
			assert.strictEqual((replay.result as { readonly seq: number }).seq, 1);
			assert.strictEqual(execCount, 1);

			// 2. Same idempotencyKey with different params -> IDEMPOTENCY_CONFLICT
			const conflict = await sendWireRequest(server1.socketPath, {
				token: tokA,
				action: 'token.return',
				params: { summary: 'mutated-payload', mission: 'm1' },
				idempotencyKey: 'idem-key-001',
			});
			assert.strictEqual(conflict.ok, false);
			assert.match(conflict.error ?? '', /IDEMPOTENCY_CONFLICT/i);
			assert.strictEqual(execCount, 1);

			// 3. Cross-principal isolation: principal B using same key executes independently
			const otherPrincipal = await sendWireRequest(server1.socketPath, {
				token: tokB,
				action: 'token.return',
				params: { summary: 'principal-b-payload', mission: 'm1' },
				idempotencyKey: 'idem-key-001',
			});
			assert.strictEqual(otherPrincipal.ok, true);
			assert.strictEqual(otherPrincipal.idempotentReplay, undefined);
			assert.strictEqual((otherPrincipal.result as { readonly seq: number }).seq, 2);
			assert.strictEqual(execCount, 2);

			// 4. Concurrent in-flight coalescing
			const p1 = sendWireRequest(server1.socketPath, {
				token: tokA,
				action: 'token.mint',
				params: { slow: true, summary: 'parallel-wave' },
				idempotencyKey: 'idem-coalesce-01',
			});
			const p2 = sendWireRequest(server1.socketPath, {
				token: tokA,
				action: 'token.mint',
				params: { summary: 'parallel-wave', slow: true },
				idempotencyKey: 'idem-coalesce-01',
			});
			await new Promise(r => setTimeout(r, 30));
			releaseSlow();
			const [r1, r2] = await Promise.all([p1, p2]);
			assert.strictEqual(r1.ok, true);
			assert.strictEqual(r2.ok, true);
			assert.strictEqual((r1.result as { readonly seq: number }).seq, (r2.result as { readonly seq: number }).seq);
			assert.strictEqual(execCount, 3);

			// 5. Pure missionNode policy: read-only diagnostics/checkpoint.list/orchestration.validate allowed; checkpoint.restore denied
			const pureDiag = await sendWireRequest(server1.socketPath, {
				token: tokPure,
				action: 'mission.diagnostics',
				params: { mission: 'm1' },
			});
			assert.strictEqual(pureDiag.ok, true);
			const pureVal = await sendWireRequest(server1.socketPath, {
				token: tokPure,
				action: 'orchestration.validate',
				params: { mission: 'm1' },
			});
			assert.strictEqual(pureVal.ok, true);
			const pureRestore = await sendWireRequest(server1.socketPath, {
				token: tokPure,
				action: 'mission.checkpoint.restore',
				params: { mission: 'm1', id: 'ckpt-1' },
			});
			assert.strictEqual(pureRestore.ok, false);
			assert.match(pureRestore.error ?? '', /Permission denied|Forbidden/i);
		} finally {
			server1.dispose();
		}

		// 6. Disk persistence across server restart (0o600 file survived dispose sync flush)
		let server2ExecCount = 0;
		const server2 = store.add(new AdeControlServer(async req => {
			server2ExecCount++;
			return { seq: 999, action: req.action };
		}, {
			controlDir: tempDir,
		}));
		await server2.whenReady();

		const ledgerPath = path.join(tempDir, 'idempotency-ledger.json');
		const ledgerStat = await fs.promises.stat(ledgerPath);
		if (process.platform !== 'win32') {
			assert.strictEqual(ledgerStat.mode & 0o777, 0o600, 'idempotency-ledger.json must have 0o600 permissions');
		}

		// Mint token with same sessionId 'sess-idem-a' (same principalId 'session:sess-idem-a')
		const mintA2 = await sendWireRequest(server2.socketPath, {
			token: server2.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'sess-idem-a', rank: 'manager', isMissionNode: true },
		});
		const tokA2 = (mintA2.result as { readonly token: string }).token;
		const postRestartReplay = await sendWireRequest(server2.socketPath, {
			token: tokA2,
			action: 'token.return',
			params: { summary: 'done-1', mission: 'm1' },
			idempotencyKey: 'idem-key-001',
		});
		assert.strictEqual(postRestartReplay.ok, true);
		assert.strictEqual(postRestartReplay.idempotentReplay, true);
		assert.strictEqual((postRestartReplay.result as { readonly seq: number }).seq, 1);
		assert.strictEqual(server2ExecCount, 0, 'Handler must NOT re-execute on post-restart idempotent replay');

		// 7. Stage 3 C1 hardening: soft-pin wid + live rank resize token rotation do NOT trigger false IDEMPOTENCY_CONFLICT
		const mintRotated = await sendWireRequest(server2.socketPath, {
			token: server2.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: { sessionId: 'sess-idem-a', rank: 'governor', isMissionNode: true, windowId: 42 },
		});
		const tokRotated = (mintRotated.result as { readonly token: string }).token;
		const rotatedReplay = await sendWireRequest(server2.socketPath, {
			token: tokRotated,
			action: 'token.return',
			params: { summary: 'done-1', mission: 'm1' },
			idempotencyKey: 'idem-key-001',
		});
		assert.strictEqual(rotatedReplay.ok, true);
		assert.strictEqual(rotatedReplay.idempotentReplay, true);
		assert.strictEqual(server2ExecCount, 0);

		// 8. Stage 3: bidirectional onDidRevokeSession callback fires on master auth.revokeSessionToken
		const revokedEvents: Array<{ sid: string; ts: number }> = [];
		server2.setOnDidRevokeSession((sid, ts) => revokedEvents.push({ sid, ts }));
		const revRes = await sendWireRequest(server2.socketPath, {
			token: server2.token,
			action: ADE_REVOKE_SESSION_TOKEN_ACTION,
			params: { sessionId: 'sess-idem-a' },
		});
		assert.strictEqual(revRes.ok, true);
		assert.strictEqual(revokedEvents.length, 1);
		assert.strictEqual(revokedEvents[0].sid, 'sess-idem-a');
	});
});
