/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodeTest from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADE_CLI_COMMANDS } from '../scripts/genAdeBins.mjs';
import { ALL_45_COMMANDS, runAdeCliMain } from '../src/adeCli.ts';
import {
	computeCliHmacRequestProof,
	computeCliHmacResponseProof,
	parseEndpointString,
	readStdinWithTimeoutAndTempBypass,
	resolveControlEndpointFromEnv,
} from '../src/adeCliTransport.ts';

const describe: typeof nodeTest.describe = typeof (globalThis as { describe?: unknown }).describe === 'function'
	? (globalThis as unknown as { describe: typeof nodeTest.describe }).describe
	: nodeTest.describe;
const test: typeof nodeTest.test = typeof (globalThis as { it?: unknown }).it === 'function'
	? (globalThis as unknown as { it: typeof nodeTest.test }).it
	: nodeTest.test;
import { ADE_ERROR_CODES } from '../../../src/vs/platform/ade/common/adeModels.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');

function spawnBinAsync(
	binPath: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	stdinInput?: string,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(binPath, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', c => { stdout += c; });
		child.stderr.on('data', c => { stderr += c; });
		child.once('error', reject);
		child.once('close', status => resolve({ status, stdout, stderr }));
		if (stdinInput !== undefined) {
			child.stdin.end(stdinInput, 'utf8');
		} else {
			child.stdin.end();
		}
	});
}

describe('adeCli45ContractAndHmacAuth Gate (plan.md §9.2.2)', () => {
	test('verifies 1:1 parity of all 45 commands & 28 error codes against Rebuild/*.md specs', () => {
		assert.equal(ADE_CLI_COMMANDS.length, 45);
		assert.equal(ALL_45_COMMANDS.size, 45);
		assert.equal(ADE_ERROR_CODES.length, 28);

		const manifestSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'vs', 'platform', 'ade', 'common', 'adeCliManifest.ts'), 'utf8');
		const extractArray = (constName: string): string[] => {
			const m = new RegExp(`${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(manifestSrc);
			return m ? [...m[1].matchAll(/'(ade_[a-z_]+)'/g)].map(x => x[1]) : [];
		};
		const baseCmds = extractArray('ADE_BASE_COMMANDS');
		const ticketCmds = extractArray('ADE_TICKET_COMMANDS');
		const orchCmds = extractArray('ADE_ORCHESTRATION_COMMANDS');
		const wbCmds = extractArray('ADE_WHITEBOARD_COMMANDS');
		const wbUnreadCmds = new Set(extractArray('ADE_WB_COMMANDS_WITH_UNREAD_COUNT'));
		assert.equal(baseCmds.length, 3);
		assert.equal(ticketCmds.length, 7);
		assert.equal(orchCmds.length, 15);
		assert.equal(wbCmds.length, 20);
		assert.equal(wbUnreadCmds.size, 17);

		const rebuildCombined = [
			fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'AGENTS.md'), 'utf8'),
			fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'Ticket.md'), 'utf8'),
			fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'orchestration.md'), 'utf8'),
			fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'whiteBoard.md'), 'utf8'),
		].join('\n');

		for (const cmd of ADE_CLI_COMMANDS) {
			assert.equal(ALL_45_COMMANDS.has(cmd), true, `adeCli.ts missing ${cmd}`);
			assert.equal(rebuildCombined.includes(cmd), true, `Rebuild/*.md missing command ${cmd}`);
		}
		for (const code of ADE_ERROR_CODES) {
			assert.equal(rebuildCombined.includes(code), true, `Rebuild/*.md missing error code ${code}`);
		}

		const wbWithoutUnread = wbCmds.filter(n => !wbUnreadCmds.has(n)).sort();
		assert.deepEqual(wbWithoutUnread, ['ade_wb_delete', 'ade_wb_list', 'ade_wb_unread_all']);
	});

	test('verifies real bin/ade_* subprocess fail-closed auth, cross-host replay rejection, bridge.json hot-reload & unsigned response defense', async () => {
		const baseTmp = process.platform === 'win32' ? os.tmpdir() : '/tmp';
		const tmpRoot = fs.mkdtempSync(path.join(baseTmp, 'ade-gate-'));
		const localSock = path.join(tmpRoot, 'local.sock');
		const binWhoami = process.platform === 'win32'
			? path.join(EXTENSION_ROOT, 'bin', 'ade_whoami.cmd')
			: path.join(EXTENSION_ROOT, 'bin', 'ade_whoami');

		const sessions = new Map<string, { secret: Buffer; host: string }>();
		const localSecret = crypto.randomBytes(32);
		const remoteSecret = crypto.randomBytes(32);
		sessions.set('jti_local', { secret: localSecret, host: 'local' });
		sessions.set('jti_remote', { secret: remoteSecret, host: '10.0.1.12' });

		let omitResProof = false;

		const createBoundListener = (boundHost: string) => net.createServer(socket => {
			const nonce = crypto.randomBytes(32).toString('hex');
			socket.write(JSON.stringify({ type: 'challenge', nonce, serverTime: Date.now() }) + '\n');
			let buf = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl < 0) {
					return;
				}
				const frame = JSON.parse(buf.slice(0, nl)) as { type: string; jti: string; payloadJson: string; reqProof: string };
				const sess = sessions.get(frame.jti);
				if (!sess) {
					socket.end(JSON.stringify({ type: 'response', responseJson: JSON.stringify({ ok: false, code: 'ERR_UNAUTHORIZED', error: 'unknown jti' }) }) + '\n');
					return;
				}
				const expectedReq = computeCliHmacRequestProof(sess.secret, nonce, frame.jti, frame.payloadJson);
				if (frame.reqProof !== expectedReq) {
					socket.end(JSON.stringify({ type: 'response', responseJson: JSON.stringify({ ok: false, code: 'ERR_UNAUTHORIZED', error: 'bad reqProof' }) }) + '\n');
					return;
				}
				if (sess.host !== boundHost) {
					const errJson = JSON.stringify({ ok: false, code: 'ERR_UNAUTHORIZED', error: 'cross-host token replay blocked' });
					socket.end(JSON.stringify({
						type: 'response',
						responseJson: errJson,
						resProof: computeCliHmacResponseProof(sess.secret, nonce, frame.jti, errJson),
					}) + '\n');
					return;
				}
				const okJson = JSON.stringify({
					ok: true,
					agent_id: 'agent_l1',
					project_id: 'proj_alpha',
					level: 'L1',
					name: 'Lead',
					role_summary: 'Architect',
					host: sess.host,
					held_ticket_count: 1,
					wb_unread_total: 2,
					current_doc_rev: 1,
				});
				socket.end(JSON.stringify({
					type: 'response',
					responseJson: okJson,
					...(omitResProof ? {} : { resProof: computeCliHmacResponseProof(sess.secret, nonce, frame.jti, okJson) }),
				}) + '\n');
			});
		});

		const localSrv = createBoundListener('local');
		const remoteSrvA = createBoundListener('10.0.1.12');
		const remoteSrvB = createBoundListener('10.0.1.12');

		let listenSupported = true;
		try {
			await new Promise<void>((res, rej) => { localSrv.once('error', rej); localSrv.listen(localSock, () => res()); });
			await new Promise<void>((res, rej) => { remoteSrvA.once('error', rej); remoteSrvA.listen(0, '127.0.0.1', () => res()); });
			await new Promise<void>((res, rej) => { remoteSrvB.once('error', rej); remoteSrvB.listen(0, '127.0.0.1', () => res()); });
		} catch {
			listenSupported = false;
		}

		try {
			if (process.platform !== 'win32') {
				const cleanEnv: NodeJS.ProcessEnv = { ...process.env, ADE_CONTROL_SOCKET: localSock };
				delete cleanEnv.ADE_AGENT_TOKEN;
				const subNoTok = await spawnBinAsync(binWhoami, [], cleanEnv);
				assert.equal(subNoTok.status, 1);
				assert.equal(subNoTok.stderr, '');
				const parsedNoTok = JSON.parse(subNoTok.stdout.trim()) as { ok: boolean; code: string };
				assert.equal(parsedNoTok.ok, false);
				assert.equal(parsedNoTok.code, 'ERR_UNAUTHORIZED');
			}

			if (!listenSupported) {
				return;
			}

			const localToken = `ades1.jti_local.${localSecret.toString('base64url')}`;
			const remoteToken = `ades1.jti_remote.${remoteSecret.toString('base64url')}`;

			if (process.platform !== 'win32') {
				const subOk = await spawnBinAsync(binWhoami, [], {
					...process.env,
					ADE_AGENT_TOKEN: localToken,
					ADE_CONTROL_SOCKET: localSock,
				});
				assert.equal(subOk.status, 0, subOk.stderr || subOk.stdout);
				assert.equal(subOk.stderr, '');
				const body = JSON.parse(subOk.stdout.trim()) as Record<string, unknown>;
				assert.deepEqual(
					Object.keys(body).sort(),
					['agent_id', 'current_doc_rev', 'held_ticket_count', 'host', 'level', 'name', 'ok', 'project_id', 'role_summary', 'wb_unread_total'],
				);
			}

			// Cross-host token replay (`10.0.1.12` token replayed onto `local` UDS) -> ERR_UNAUTHORIZED
			let outCross = '';
			const codeCross = await runAdeCliMain(
				['node', 'ade_whoami'],
				{ ADE_AGENT_TOKEN: remoteToken, ADE_CONTROL_SOCKET: localSock },
				{ writeStdout: l => { outCross += l; } },
			);
			assert.equal(codeCross, 1);
			assert.equal(JSON.parse(outCross.trim()).code, 'ERR_UNAUTHORIZED');

			// Zero-secret bridge.json endpoint hot-reload self-healing
			const portA = (remoteSrvA.address() as net.AddressInfo).port;
			const portB = (remoteSrvB.address() as net.AddressInfo).port;
			const bridgeFile = path.join(tmpRoot, 'bridge.json');
			fs.writeFileSync(bridgeFile, JSON.stringify({ endpoint: `tcp:127.0.0.1:${portA}`, updatedAt: 1 }), { mode: 0o600 });

			let outBridgeA = '';
			assert.equal(await runAdeCliMain(['node', 'ade_whoami'], { ADE_AGENT_TOKEN: remoteToken, ADE_CONTROL_BRIDGE_FILE: bridgeFile }, { writeStdout: l => { outBridgeA += l; } }), 0);
			assert.equal(JSON.parse(outBridgeA.trim()).host, '10.0.1.12');

			await new Promise<void>(r => remoteSrvA.close(() => r()));
			fs.writeFileSync(bridgeFile, JSON.stringify({ endpoint: `tcp:127.0.0.1:${portB}`, updatedAt: 2 }), { mode: 0o600 });

			let outBridgeB = '';
			assert.equal(await runAdeCliMain(['node', 'ade_whoami'], { ADE_AGENT_TOKEN: remoteToken, ADE_CONTROL_BRIDGE_FILE: bridgeFile }, { writeStdout: l => { outBridgeB += l; } }), 0);
			assert.equal(JSON.parse(outBridgeB.trim()).ok, true);

			// MITM server omitting resProof on `{ ok: true }` is rejected with ERR_UNAUTHORIZED
			omitResProof = true;
			let outUnsigned = '';
			const codeUnsigned = await runAdeCliMain(
				['node', 'ade_whoami'],
				{ ADE_AGENT_TOKEN: localToken, ADE_CONTROL_SOCKET: localSock },
				{ writeStdout: l => { outUnsigned += l; } },
			);
			assert.equal(codeUnsigned, 1);
			assert.equal(JSON.parse(outUnsigned.trim()).code, 'ERR_UNAUTHORIZED');
		} finally {
			await Promise.all([
				new Promise<void>(r => { try { localSrv.close(() => r()); } catch { r(); } }),
				new Promise<void>(r => { try { remoteSrvA.close(() => r()); } catch { r(); } }),
				new Promise<void>(r => { try { remoteSrvB.close(() => r()); } catch { r(); } }),
			]);
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('verifies readStdinWithTimeoutAndTempBypass creates 0700 dir & 0600 file when >64KB', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-tmp-perm-'));
		const transportTs = path.join(EXTENSION_ROOT, 'src', 'adeCliTransport.ts');
		const payload = 'Z'.repeat(70 * 1024);
		try {
			const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const subDir = path.join(tmpDir, 'isolated');
				const child = cp.spawn(
					process.execPath,
					['-e', `import(${JSON.stringify(transportTs)}).then(async m => { const r = await m.readStdinWithTimeoutAndTempBypass({ tempDirOverride: ${JSON.stringify(subDir)} }); process.stdout.write(JSON.stringify(r)); });`],
					{ stdio: ['pipe', 'pipe', 'pipe'] },
				);
				let out = '';
				let err = '';
				child.stdout.setEncoding('utf8');
				child.stderr.setEncoding('utf8');
				child.stdout.on('data', c => { out += c; });
				child.stderr.on('data', c => { err += c; });
				child.once('error', reject);
				child.once('close', status => resolve({ status, stdout: out, stderr: err }));
				child.stdin.end(payload, 'utf8');
			});
			assert.equal(res.status, 0, res.stderr);
			const parsed = JSON.parse(res.stdout) as { tempFilePath: string; byteLength: number };
			assert.equal(parsed.byteLength, 70 * 1024);
			if (process.platform !== 'win32') {
				const dirMode = fs.statSync(path.dirname(parsed.tempFilePath)).mode & 0o777;
				const fileMode = fs.statSync(parsed.tempFilePath).mode & 0o777;
				assert.equal(dirMode, 0o700);
				assert.equal(fileMode, 0o600);
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
		assert.equal(typeof readStdinWithTimeoutAndTempBypass, 'function');
	});

	test('parses both tcp:host:port and tcp://host:port in bridge.json & ADE_CONTROL_ENDPOINT end-to-end and verifies cloudTransport canonical format', async () => {
		assert.deepEqual(parseEndpointString('tcp:127.0.0.1:43210'), { kind: 'tcp', host: '127.0.0.1', port: 43210 });
		assert.deepEqual(parseEndpointString('tcp://127.0.0.1:43210'), { kind: 'tcp', host: '127.0.0.1', port: 43210 });

		const cloudSrc = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'cloudTransport.ts'), 'utf8');
		assert.equal(cloudSrc.includes('tcp:127.0.0.1:${endpoint.tcpPort}'), true, 'writeRemoteBridgeMetadataFile must write canonical tcp:127.0.0.1:<port>');
		assert.equal(cloudSrc.includes('tcp://127.0.0.1:${endpoint.tcpPort}'), false);

		const baseTmp = process.platform === 'win32' ? os.tmpdir() : '/tmp';
		const tmpRoot = fs.mkdtempSync(path.join(baseTmp, 'ade-tcp-uri-'));
		const secret = crypto.randomBytes(32);
		const remoteToken = `ades1.jti_tcp_uri.${secret.toString('base64url')}`;

		const srv = net.createServer(socket => {
			const nonce = crypto.randomBytes(32).toString('hex');
			socket.write(JSON.stringify({ type: 'challenge', nonce, serverTime: Date.now() }) + '\n');
			let buf = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl < 0) {
					return;
				}
				const frame = JSON.parse(buf.slice(0, nl)) as { jti: string; payloadJson: string; reqProof: string };
				const expectedReq = computeCliHmacRequestProof(secret, nonce, frame.jti, frame.payloadJson);
				if (frame.reqProof !== expectedReq) {
					socket.end(JSON.stringify({ type: 'response', responseJson: JSON.stringify({ ok: false, code: 'ERR_UNAUTHORIZED', error: 'bad hmac' }) }) + '\n');
					return;
				}
				const okJson = JSON.stringify({ ok: true, agent_id: 'ag_remote', host: '10.0.9.9' });
				socket.end(JSON.stringify({
					type: 'response',
					responseJson: okJson,
					resProof: computeCliHmacResponseProof(secret, nonce, frame.jti, okJson),
				}) + '\n');
			});
		});

		let listenOk = true;
		try {
			await new Promise<void>((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', () => res()); });
		} catch {
			listenOk = false;
		}

		try {
			if (!listenOk) {
				return;
			}
			const port = (srv.address() as net.AddressInfo).port;
			const bridgeJsonPath = path.join(tmpRoot, 'bridge-tcp-slash.json');
			// Write legacy/fallback `tcp://127.0.0.1:<port>` WITH tcpPort in bridge.json -> must NOT parse host as "//127.0.0.1"!
			fs.writeFileSync(bridgeJsonPath, JSON.stringify({
				endpoint: `tcp://127.0.0.1:${port}`,
				tcpPort: port,
				updatedAt: Date.now(),
			}), { mode: 0o600 });

			const resolvedEp = await resolveControlEndpointFromEnv({ ADE_CONTROL_BRIDGE_FILE: bridgeJsonPath });
			assert.deepEqual(resolvedEp, { kind: 'tcp', host: '127.0.0.1', port });

			let out1 = '';
			const code1 = await runAdeCliMain(
				['node', 'ade_whoami'],
				{ ADE_AGENT_TOKEN: remoteToken, ADE_CONTROL_BRIDGE_FILE: bridgeJsonPath },
				{ writeStdout: l => { out1 += l; } },
			);
			assert.equal(code1, 0, out1);
			assert.equal(JSON.parse(out1.trim()).agent_id, 'ag_remote');

			// Also verify ADE_CONTROL_ENDPOINT="tcp://127.0.0.1:<port>" directly via real bin/ade_whoami subprocess
			if (process.platform !== 'win32') {
				const binWhoami = path.join(EXTENSION_ROOT, 'bin', 'ade_whoami');
				const sub = await spawnBinAsync(binWhoami, [], {
					...process.env,
					ADE_AGENT_TOKEN: remoteToken,
					ADE_CONTROL_ENDPOINT: `tcp://127.0.0.1:${port}`,
				});
				assert.equal(sub.status, 0, sub.stderr || sub.stdout);
				assert.equal(JSON.parse(sub.stdout.trim()).ok, true);
			}
		} finally {
			await new Promise<void>(r => { try { srv.close(() => r()); } catch { r(); } });
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('unlinks >64KB stdin-*.tmp file in finally block when auth or permission rejection occurs', async () => {
		const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-unlink-gate-'));
		const largeStdin = 'X'.repeat(72 * 1024);
		const binPostMsg = process.platform === 'win32'
			? path.join(EXTENSION_ROOT, 'bin', 'ade_wb_post_msg.cmd')
			: path.join(EXTENSION_ROOT, 'bin', 'ade_wb_post_msg');
		const binNoteSend = process.platform === 'win32'
			? path.join(EXTENSION_ROOT, 'bin', 'ade_wb_note_send.cmd')
			: path.join(EXTENSION_ROOT, 'bin', 'ade_wb_note_send');

		try {
			if (process.platform === 'win32') {
				return;
			}
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				TMPDIR: isolatedTmp,
				TMP: isolatedTmp,
				TEMP: isolatedTmp,
				ADE_AGENT_TOKEN: 'invalid-token-triggers-ERR_UNAUTHORIZED',
				ADE_CONTROL_SOCKET: path.join(isolatedTmp, 'missing.sock'),
			};

			const r1 = await spawnBinAsync(
				binPostMsg,
				['wb_123', '--summary', 'S', '--stars', '5', '--detail-stdin'],
				childEnv,
				largeStdin,
			);
			assert.equal(r1.status, 1);
			assert.equal(JSON.parse(r1.stdout.trim()).code, 'ERR_UNAUTHORIZED');

			const r2 = await spawnBinAsync(
				binNoteSend,
				['wb_123', '--to', 'ag_2', '--stdin'],
				childEnv,
				largeStdin,
			);
			assert.equal(r2.status, 1);
			assert.equal(JSON.parse(r2.stdout.trim()).code, 'ERR_UNAUTHORIZED');

			// Also test server-side permission rejection ({ ok: false, code: 'ERR_WB_FORBIDDEN' })
			const permSock = path.join(isolatedTmp, 'perm.sock');
			const permSecret = crypto.randomBytes(32);
			const permToken = `ades1.jti_perm.${permSecret.toString('base64url')}`;
			const permSrv = net.createServer(socket => {
				const nonce = crypto.randomBytes(32).toString('hex');
				socket.write(JSON.stringify({ type: 'challenge', nonce, serverTime: Date.now() }) + '\n');
				let buf = '';
				socket.setEncoding('utf8');
				socket.on('data', (c: string) => {
					buf += c;
					const nl = buf.indexOf('\n');
					if (nl < 0) {
						return;
					}
					const errJson = JSON.stringify({ ok: false, code: 'ERR_WB_FORBIDDEN', error: 'no write access' });
					socket.end(JSON.stringify({
						type: 'response',
						responseJson: errJson,
						resProof: computeCliHmacResponseProof(permSecret, nonce, 'jti_perm', errJson),
					}) + '\n');
				});
			});
			await new Promise<void>((res, rej) => { permSrv.once('error', rej); permSrv.listen(permSock, () => res()); });
			try {
				const r3 = await spawnBinAsync(
					binPostMsg,
					['wb_123', '--summary', 'S', '--stars', '5', '--detail-stdin'],
					{ ...childEnv, ADE_AGENT_TOKEN: permToken, ADE_CONTROL_SOCKET: permSock },
					largeStdin,
				);
				assert.equal(r3.status, 1);
				assert.equal(JSON.parse(r3.stdout.trim()).code, 'ERR_WB_FORBIDDEN');
			} finally {
				await new Promise<void>(r => permSrv.close(() => r()));
			}

			// Walk isolatedTmp and assert zero leftover .tmp files exist!
			const leftoverTmpFiles: string[] = [];
			const walk = (dir: string) => {
				for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, ent.name);
					if (ent.isDirectory()) {
						walk(full);
					} else if (ent.name.endsWith('.tmp')) {
						leftoverTmpFiles.push(full);
					}
				}
			};
			walk(isolatedTmp);
			assert.deepEqual(leftoverTmpFiles, [], `Auth failure must never leak stdin-*.tmp files: ${leftoverTmpFiles.join(', ')}`);
		} finally {
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});
