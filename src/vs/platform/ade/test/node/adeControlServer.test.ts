/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { DeferredPromise } from '../../../../base/common/async.js';
import { FileAccess } from '../../../../base/common/network.js';
import * as path from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import {
	ADE_AGENT_TOKEN_PREFIX,
	IAdeCliWireRequestPayload,
	IAdeHmacClientRequestFrame,
	IAdeHmacServerChallengeFrame,
	IAdeHmacServerResponseFrame,
	stripAdeControlEnv,
} from '../../common/adeControl.js';
import { AdeError } from '../../common/adeModels.js';
import {
	AdeControlServer,
	computeAdeHmacRequestProof,
	computeAdeHmacResponseProof,
} from '../../node/adeControlServer.js';

function parseIssuedToken(rawToken: string): { readonly jti: string; readonly secret: Buffer } {
	assert.ok(rawToken.startsWith(ADE_AGENT_TOKEN_PREFIX));
	const rest = rawToken.slice(ADE_AGENT_TOKEN_PREFIX.length);
	const dot = rest.indexOf('.');
	assert.ok(dot > 0);
	const jti = rest.slice(0, dot);
	const secret = Buffer.from(rest.slice(dot + 1), 'base64url');
	return { jti, secret };
}

function sendMutualHmacRequest(
	endpoint: { readonly socketPath?: string; readonly port?: number },
	token: string,
	payload: IAdeCliWireRequestPayload,
	options?: { readonly tamperReqProof?: boolean },
): Promise<{ readonly body: Record<string, unknown>; readonly verifiedResProof: boolean }> {
	const { jti, secret } = parseIssuedToken(token);
	const payloadJson = JSON.stringify(payload);

	return new Promise((resolve, reject) => {
		const socket = endpoint.socketPath
			? net.createConnection({ path: endpoint.socketPath })
			: net.createConnection({ host: '127.0.0.1', port: endpoint.port! });

		let stage: 'challenge' | 'response' = 'challenge';
		let nonce = '';
		let buf = '';

		socket.setEncoding('utf8');
		socket.once('error', reject);
		socket.on('data', (chunk: string) => {
			buf += chunk;
			let nl = buf.indexOf('\n');
			while (nl !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf('\n');
				if (!line) {
					continue;
				}
				if (stage === 'challenge') {
					const ch = JSON.parse(line) as IAdeHmacServerChallengeFrame;
					assert.strictEqual(ch.type, 'challenge');
					assert.strictEqual(ch.nonce.length, 64);
					nonce = ch.nonce;
					const validProof = computeAdeHmacRequestProof(secret, nonce, jti, payloadJson);
					const reqFrame: IAdeHmacClientRequestFrame = {
						type: 'request',
						jti,
						payloadJson,
						reqProof: options?.tamperReqProof ? '0'.repeat(64) : validProof,
					};
					stage = 'response';
					socket.write(`${JSON.stringify(reqFrame)}\n`, 'utf8');
					continue;
				}
				const resFrame = JSON.parse(line) as IAdeHmacServerResponseFrame;
				assert.strictEqual(resFrame.type, 'response');
				const body = JSON.parse(resFrame.responseJson) as Record<string, unknown>;
				let verifiedResProof = false;
				if (resFrame.resProof) {
					const expectedRes = computeAdeHmacResponseProof(secret, nonce, jti, resFrame.responseJson);
					const a = Buffer.from(resFrame.resProof, 'hex');
					const b = Buffer.from(expectedRes, 'hex');
					verifiedResProof = a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
				}
				socket.destroy();
				resolve({ body, verifiedResProof });
				return;
			}
		});
	});
}

function spawnAdeCliSubprocess(
	binDir: string,
	cmdName: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
	const exe = isWindows ? path.join(binDir, `${cmdName}.cmd`) : path.join(binDir, cmdName);
	return new Promise((resolve, reject) => {
		const child = spawn(exe, [...args], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: isWindows,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (c: string) => { stdout += c; });
		child.stderr.on('data', (c: string) => { stderr += c; });
		child.once('error', reject);
		child.once('close', status => resolve({ status, stdout, stderr }));
	});
}

suite('AdeControlServer (Full-Duplex Mutual HMAC-SHA256 & Host-Channel Binding)', () => {
	let tempDir: string;
	const activeServers: AdeControlServer[] = [];
	const trackServer = (srv: AdeControlServer): AdeControlServer => {
		activeServers.push(srv);
		return srv;
	};

	teardown(async () => {
		while (activeServers.length > 0) {
			const srv = activeServers.pop()!;
			await srv.stopAndClose();
			srv.dispose();
		}
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	setup(async () => {
		const baseTmp = isWindows ? os.tmpdir() : '/tmp';
		tempDir = await fs.promises.mkdtemp(path.join(baseTmp, 'ade-cs-'));
	});

	teardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test('binds 0600 local UDS with zero plaintext master token files on disk and verifies mutual HMAC-SHA256', async () => {
		const server = trackServer(new AdeControlServer(
			async (caller, command, args) => {
				return {
					agent_id: caller.agentId,
					project_id: caller.projectId,
					host: caller.host,
					echo_cmd: command,
					echo_mod: args.module ?? 'all',
				};
			},
			{
				controlDir: tempDir,
				socketPath: isWindows ? undefined : path.join(tempDir, 'run', 'ctrl.sock'),
				persistIdempotencyLedger: false,
			},
		));
		await server.whenReady();

		// Zero plaintext token files written anywhere in controlDir
		const entries = await fs.promises.readdir(tempDir);
		for (const name of entries) {
			assert.strictEqual(name.endsWith('.json'), false, `Unexpected plaintext metadata file: ${name}`);
		}
		if (!isWindows) {
			const st = await fs.promises.stat(server.socketPath);
			assert.strictEqual(st.mode & 0o777, 0o600);
		}

		const localToken = server.issueAgentSessionToken({
			projectId: 'proj_1',
			agentId: 'agent_l1',
			host: 'local',
			tokenGen: 1,
		});

		const okRes = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			localToken,
			{ command: 'ade_sysprompt_path', args: { module: 'ticket' } },
		);
		assert.strictEqual(okRes.verifiedResProof, true);
		assert.strictEqual(okRes.body.ok, true);
		assert.strictEqual(okRes.body.agent_id, 'agent_l1');
		assert.strictEqual(okRes.body.echo_mod, 'ticket');

		// Tampered reqProof is rejected immediately with ERR_UNAUTHORIZED
		const badRes = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			localToken,
			{ command: 'ade_whoami', args: {} },
			{ tamperReqProof: true },
		);
		assert.strictEqual(badRes.body.ok, false);
		assert.strictEqual(badRes.body.code, 'ERR_UNAUTHORIZED');

		await server.stopAndClose();
	});

	test('enforces strict host-channel binding (blocks cross-host token replay) and revokes rotated/deleted tokens', async () => {
		const server = trackServer(new AdeControlServer(
			async caller => ({ agent_id: caller.agentId, host: caller.host, token_gen: caller.tokenGen }),
			{
				controlDir: tempDir,
				socketPath: isWindows ? undefined : path.join(tempDir, 'run', 'hostbind.sock'),
				persistIdempotencyLedger: false,
			},
		));
		await server.whenReady();

		const portHostA = await server.ensureHostLoopbackPort('10.0.1.12');
		const portHostB = await server.ensureHostLoopbackPort('10.0.1.99');
		assert.notStrictEqual(portHostA, portHostB);

		const tokenHostA = server.issueAgentSessionToken({
			projectId: 'proj_alpha',
			agentId: 'agent_l2_gpu',
			host: '10.0.1.12',
			tokenGen: 1,
		});

		// Valid on HostA's own bound loopback listener
		const validRemote = await sendMutualHmacRequest(
			{ port: portHostA },
			tokenHostA,
			{ command: 'ade_whoami', args: {} },
		);
		assert.strictEqual(validRemote.body.ok, true);
		assert.strictEqual(validRemote.verifiedResProof, true);
		assert.strictEqual(validRemote.body.host, '10.0.1.12');

		// Replay of HostA token onto local UDS -> ERR_UNAUTHORIZED
		const replayOnLocal = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			tokenHostA,
			{ command: 'ade_whoami', args: {} },
		);
		assert.strictEqual(replayOnLocal.body.ok, false);
		assert.strictEqual(replayOnLocal.body.code, 'ERR_UNAUTHORIZED');

		// Replay of HostA token onto HostB loopback listener -> ERR_UNAUTHORIZED
		const replayOnHostB = await sendMutualHmacRequest(
			{ port: portHostB },
			tokenHostA,
			{ command: 'ade_whoami', args: {} },
		);
		assert.strictEqual(replayOnHostB.body.ok, false);
		assert.strictEqual(replayOnHostB.body.code, 'ERR_UNAUTHORIZED');

		// Token rotation (tokenGen 2) evicts tokenGen 1 immediately
		const tokenGen2 = server.issueAgentSessionToken({
			projectId: 'proj_alpha',
			agentId: 'agent_l2_gpu',
			host: '10.0.1.12',
			tokenGen: 2,
		});
		const oldAfterRotate = await sendMutualHmacRequest(
			{ port: portHostA },
			tokenHostA,
			{ command: 'ade_whoami', args: {} },
		);
		assert.strictEqual(oldAfterRotate.body.ok, false);
		assert.strictEqual(oldAfterRotate.body.code, 'ERR_UNAUTHORIZED');

		const gen2Ok = await sendMutualHmacRequest(
			{ port: portHostA },
			tokenGen2,
			{ command: 'ade_whoami', args: {} },
		);
		assert.strictEqual(gen2Ok.body.ok, true);

		// Explicit revokeAgentTokens invalidates gen2 immediately
		server.revokeAgentTokens('proj_alpha', 'agent_l2_gpu');
		const afterRevoke = await sendMutualHmacRequest(
			{ port: portHostA },
			tokenGen2,
			{ command: 'ade_whoami', args: {} },
		);
		assert.strictEqual(afterRevoke.body.ok, false);
		assert.strictEqual(afterRevoke.body.code, 'ERR_UNAUTHORIZED');

		await server.stopAndClose();
	});

	test('deduplicates mutating commands via AdeIdempotencyLedger, rejects conflicting reuse, and executes bundled bin/ade_* subprocesses', async () => {
		let createCount = 0;
		const server = trackServer(new AdeControlServer(
			async (caller, command, args) => {
				if (command === 'ade_create') {
					createCount++;
					return { ticket_id: `tk_${createCount}`, task_id: 'tsk_001' };
				}
				if (command === 'ade_destroy') {
					throw new AdeError('ERR_RETURN_REQUIRED', 'need_return is true');
				}
				return {
					agent_id: caller.agentId,
					project_id: caller.projectId,
					level: 'L1',
					name: 'Lead',
					role_summary: 'Top role',
					host: caller.host,
					held_ticket_count: createCount,
					wb_unread_total: 0,
					current_doc_rev: 1,
					args_seen: args,
				};
			},
			{
				controlDir: tempDir,
				socketPath: isWindows ? undefined : path.join(tempDir, 'run', 'idemp.sock'),
				persistIdempotencyLedger: false,
			},
		));
		await server.whenReady();

		const token = server.issueAgentSessionToken({
			projectId: 'proj_1',
			agentId: 'agent_l1',
			host: 'local',
			tokenGen: 1,
		});

		// Same idempotencyKey + identical args -> executes handler once and replays result
		const r1 = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			token,
			{ command: 'ade_create', args: { to: 'a2', title: 'T1' }, idempotencyKey: 'idem_001' },
		);
		const r2 = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			token,
			{ command: 'ade_create', args: { to: 'a2', title: 'T1' }, idempotencyKey: 'idem_001' },
		);
		assert.strictEqual(createCount, 1);
		assert.strictEqual(r1.body.ticket_id, 'tk_1');
		assert.strictEqual(r2.body.ticket_id, 'tk_1');

		// Same idempotencyKey + different args -> rejected with ERR_INVALID_ARGS
		const rConflict = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			token,
			{ command: 'ade_create', args: { to: 'a2', title: 'DIFFERENT' }, idempotencyKey: 'idem_001' },
		);
		assert.strictEqual(rConflict.body.ok, false);
		assert.strictEqual(rConflict.body.code, 'ERR_INVALID_ARGS');

		// AdeError propagates exact AdeErrorCode
		const rErr = await sendMutualHmacRequest(
			{ socketPath: server.socketPath },
			token,
			{ command: 'ade_destroy', args: { ticketId: 'tk_1' } },
		);
		assert.strictEqual(rErr.body.ok, false);
		assert.strictEqual(rErr.body.code, 'ERR_RETURN_REQUIRED');

		// End-to-end bundled `bin/ade_whoami` subprocess over live UDS
		const repoRoot = path.resolve(FileAccess.asFileUri('').fsPath, '..');
		const binDir = path.join(repoRoot, 'extensions', 'aexus-agents', 'bin');
		const childEnv: NodeJS.ProcessEnv = {
			...stripAdeControlEnv(process.env),
			ADE_AGENT_TOKEN: token,
			ADE_CONTROL_SOCKET: server.socketPath,
		};
		const sub = await spawnAdeCliSubprocess(binDir, 'ade_whoami', [], childEnv);
		assert.strictEqual(sub.status, 0, sub.stderr || sub.stdout);
		const parsed = JSON.parse(sub.stdout.trim()) as Record<string, unknown>;
		assert.strictEqual(parsed.ok, true);
		assert.strictEqual(parsed.agent_id, 'agent_l1');
		assert.strictEqual(parsed.held_ticket_count, 1);

		await server.stopAndClose();
	});

	test('reuses live jti/token for identical (projectId, agentId, host, tokenGen) and evicts stale jti on rotation or revocation', async () => {
		const server = trackServer(new AdeControlServer(
			async caller => ({ agent_id: caller.agentId, token_gen: caller.tokenGen }),
			{
				controlDir: tempDir,
				socketPath: isWindows ? undefined : path.join(tempDir, 'run', 'reuse.sock'),
				persistIdempotencyLedger: false,
			},
		));
		await server.whenReady();

		const first = server.issueAgentSessionToken({
			projectId: 'proj_1',
			agentId: 'ag_1',
			host: 'local',
			tokenGen: 1,
		});
		for (let i = 0; i < 8; i++) {
			const again = server.issueAgentSessionToken({
				projectId: 'proj_1',
				agentId: 'ag_1',
				host: 'local',
				tokenGen: 1,
			});
			assert.strictEqual(again, first, 'Repeated launches of same (projectId, agentId, host, tokenGen) must reuse existing live token');
		}
		assert.strictEqual(server.activeSessionCredentialCount, 1);

		const rotated = server.issueAgentSessionToken({
			projectId: 'proj_1',
			agentId: 'ag_1',
			host: 'local',
			tokenGen: 2,
		});
		assert.notStrictEqual(rotated, first);
		assert.strictEqual(server.activeSessionCredentialCount, 1, 'Rotating tokenGen must evict old jti without growing _sessionsByJti');

		server.revokeAgentTokens('proj_1', 'ag_1');
		assert.strictEqual(server.activeSessionCredentialCount, 0);

		await server.stopAndClose();
	});

	test('drains in-flight _processAuthenticatedLine requests inside stopAndClose() before resolving', async () => {
		const handlerEntered = new DeferredPromise<void>();
		const releaseHandler = new DeferredPromise<void>();
		let handlerCompleted = false;

		const server = trackServer(new AdeControlServer(
			async caller => {
				handlerEntered.complete();
				await releaseHandler.p;
				handlerCompleted = true;
				return { agent_id: caller.agentId };
			},
			{
				controlDir: tempDir,
				socketPath: isWindows ? undefined : path.join(tempDir, 'run', 'drain.sock'),
				persistIdempotencyLedger: false,
			},
		));
		await server.whenReady();

		const token = server.issueAgentSessionToken({
			projectId: 'proj_drain',
			agentId: 'ag_drain',
			host: 'local',
			tokenGen: 1,
		});
		const { jti, secret } = parseIssuedToken(token);
		const payloadJson = JSON.stringify({ command: 'ade_whoami', args: {} } satisfies IAdeCliWireRequestPayload);

		const clientSock = net.createConnection({ path: server.socketPath });
		clientSock.setEncoding('utf8');
		clientSock.on('error', () => { /* expected destroy on stopAndClose */ });
		let recvBuf = '';
		clientSock.on('data', (chunk: string) => {
			recvBuf += chunk;
			const nl = recvBuf.indexOf('\n');
			if (nl !== -1) {
				const line = recvBuf.slice(0, nl).trim();
				recvBuf = '';
				const parsed = JSON.parse(line) as IAdeHmacServerChallengeFrame;
				if (parsed.type === 'challenge') {
					const reqFrame: IAdeHmacClientRequestFrame = {
						type: 'request',
						jti,
						payloadJson,
						reqProof: computeAdeHmacRequestProof(secret, parsed.nonce, jti, payloadJson),
					};
					clientSock.write(`${JSON.stringify(reqFrame)}\n`, 'utf8');
				}
			}
		});

		await handlerEntered.p;

		let stopResolved = false;
		const stopP1 = server.stopAndClose().then(() => { stopResolved = true; });
		const stopP2 = server.stopAndClose();

		// Give event loop several ticks: stopAndClose() MUST remain pending while handler is still running!
		await new Promise<void>(r => setTimeout(r, 25));
		assert.strictEqual(stopResolved, false, 'stopAndClose() must wait for in-flight authenticated request handler to settle');
		assert.strictEqual(handlerCompleted, false);

		releaseHandler.complete();
		await Promise.all([stopP1, stopP2]);
		assert.strictEqual(handlerCompleted, true, 'In-flight handler must have completely finished before stopAndClose() resolved');
		clientSock.destroy();
	});
});
