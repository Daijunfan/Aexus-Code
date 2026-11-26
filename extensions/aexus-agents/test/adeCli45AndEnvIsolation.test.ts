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
import { Duplex, PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALL_45_COMMANDS, buildRpcArgsForCommand, runAdeCliMain } from '../src/adeCli.ts';
import { computeCliHmacRequestProof, computeCliHmacResponseProof } from '../src/adeCliTransport.ts';
import {
	SHARED_PURE_SCOPE_KEY,
	buildAgentChildEnv,
	computeAgentIdentityScopeKey,
	stripAdeControlEnv,
} from '../src/agentEnvIsolation.ts';
import {
	isAdeTicketDeliveryMessage,
	parseAdeTicketDeliveryMessage,
} from '../src/ticketMessageFormat.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');

function createInMemoryDuplexPair(): { readonly client: Duplex; readonly server: Duplex } {
	const c2s = new PassThrough();
	const s2c = new PassThrough();
	const makeEnd = (readable: PassThrough, writable: PassThrough): Duplex => {
		const d = new Duplex({
			read() { /* pushed via readable */ },
			write(chunk, encoding, callback) {
				writable.write(chunk, encoding, callback);
			},
			final(callback) {
				writable.end(callback);
			},
		});
		readable.on('data', chunk => { d.push(chunk); });
		readable.on('end', () => { d.push(null); });
		return d;
	};
	return {
		client: makeEnd(s2c, c2s),
		server: makeEnd(c2s, s2c),
	};
}

function spawnAsyncWithInput(
	exe: string,
	args: readonly string[],
	options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv },
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(exe, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: options.env,
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', c => { stdout += c; });
		child.stderr.on('data', c => { stderr += c; });
		child.once('error', reject);
		child.once('close', status => resolve({ status, stdout, stderr }));
		if (options.input !== undefined) {
			child.stdin.end(options.input, 'utf8');
		}
	});
}

describe('45 ade_* CLI parsers, mutual HMAC-SHA256 handshake, stdin 3s timeout & >64KB temp file bypass', () => {
	test('declares and parses all 45 commands cleanly', async () => {
		assert.equal(ALL_45_COMMANDS.size, 45);

		const sampleMatrix: Array<[string, string[]]> = [
			['ade_whoami', []],
			['ade_sysprompt_path', ['--module', 'ticket']],
			['ade_sysprompt_update', ['--since', '0']],
			['ade_create', ['--to', 'a2', '--type', 'dev', '--title', 'T', '--summary', 'S', '--need-return', 'true', '--mode', 'steer', '--detail', 'D']],
			['ade_destroy', ['tk_1']],
			['ade_edit', ['tk_1', '--type', 'review', '--title', 'T2', '--summary', 'S2', '--need-return', 'false']],
			['ade_list', []],
			['ade_get', ['tk_1']],
			['ade_detail', ['tk_1', 'tsk_1']],
			['ade_history', ['tk_1']],
			['ade_host_list', []],
			['ade_engine_list', ['--host', 'local']],
			['ade_model_list', ['--host', 'local', '--engine', 'claude-code']],
			['ade_agent_list', ['--depth', '2', '--depts', 'd1,d2']],
			['ade_agent_create', ['--host', 'local', '--engine', 'codex', '--model', 'gpt-5', '--effort', 'high', '--level', 'L2', '--name', 'Dev', '--role', 'Backend']],
			['ade_agent_edit', ['a2', '--model', 'o3', '--effort', 'medium']],
			['ade_agent_move', ['a3', '--to-parent', 'a1']],
			['ade_agent_delete', ['a3']],
			['ade_dept_create', ['--root', 'a2', '--name', 'Backend']],
			['ade_dept_edit', ['d1', '--name', 'Core', '--board', 'wb1', '--perm', 'read_write']],
			['ade_dept_delete', ['d1']],
			['ade_dept_member', ['d1', '--agent', 'a3', '--action', 'out']],
			['ade_dept_members', ['d1']],
			['ade_dept_info', ['--agent', 'a2']],
			['ade_wb_grant', ['wb1', '--to', 'a3', '--perm', 'read']],
			['ade_wb_list', []],
			['ade_wb_my_perm', ['wb1']],
			['ade_wb_members', ['wb1']],
			['ade_wb_create', ['--name', 'Board', '--dept', 'd1', '--host', 'local', '--tags', 'api,spec']],
			['ade_wb_config', ['wb1', '--host', '10.0.0.2']],
			['ade_wb_delete', ['wb1']],
			['ade_wb_tags', ['wb1']],
			['ade_wb_tag_manage', ['wb1', '--action', 'add', '--tags', 'perf']],
			['ade_wb_post_msg', ['wb1', '--summary', 'Msg', '--stars', '5', '--tags', 'api', '--detail', 'Body']],
			['ade_wb_upload_file', ['wb1', '--file', './spec.md', '--summary', 'Spec', '--stars', '4']],
			['ade_wb_items', ['wb1', '--sort', 'stars', '--limit', '10', '--stars', '3-5']],
			['ade_wb_get_msg', ['wb1', 'itm1']],
			['ade_wb_download', ['wb1', 'itm2', '--dest', './downloads/']],
			['ade_wb_edit_item', ['wb1', 'itm1', '--summary', 'Updated', '--tags', '']],
			['ade_wb_delete_item', ['wb1', 'itm1']],
			['ade_wb_manage_item', ['wb1', 'itm2', '--pin', 'true', '--stars', '5']],
			['ade_wb_note_send', ['wb1', '--to', 'a2', '--text', 'Check item 102']],
			['ade_wb_note_unread', ['wb1']],
			['ade_wb_note_detail', ['wb1', 'nt1']],
			['ade_wb_unread_all', []],
		];

		assert.equal(sampleMatrix.length, 45);
		for (const [cmd, argv] of sampleMatrix) {
			const parsed = await buildRpcArgsForCommand(cmd, argv);
			assert.equal(typeof parsed.rpcArgs, 'object', cmd);
		}

		// ade_edit must reject --from / --to
		await assert.rejects(() => buildRpcArgsForCommand('ade_edit', ['tk_1', '--to', 'a1', '--type', 't', '--title', 'x', '--summary', 'y', '--need-return', 'false']));
	});

	test('completes full-duplex mutual HMAC-SHA256 handshake, rejects missing token & tampered resProof, and bypasses >64KB stdin via 0700 temp file', async () => {
		const baseTmp = process.platform === 'win32' ? os.tmpdir() : '/tmp';
		const sockDir = fs.mkdtempSync(path.join(baseTmp, 'ade-hm-'));
		const sockPath = path.join(sockDir, 'c.sock');
		const secret = crypto.randomBytes(32);
		const jti = 'jti_agent_l2';
		const token = `ades1.${jti}.${secret.toString('base64url')}`;
		let tamperResProof = false;
		const receivedRequests: Array<{ command: string; args: Record<string, unknown> }> = [];

		const handleServerSocket = (socket: Duplex) => {
			const nonce = crypto.randomBytes(32).toString('hex');
			socket.write(JSON.stringify({ type: 'challenge', nonce, serverTime: Date.now() }) + '\n');
			let buf = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk: string) => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl >= 0) {
					const req = JSON.parse(buf.slice(0, nl)) as {
						type: string;
						jti: string;
						payloadJson: string;
						reqProof: string;
					};
					const expectedReq = computeCliHmacRequestProof(secret, nonce, req.jti, req.payloadJson);
					if (req.type !== 'request' || req.reqProof !== expectedReq) {
						const responseJson = JSON.stringify({ ok: false, code: 'ERR_UNAUTHORIZED', error: 'bad hmac' });
						socket.end(JSON.stringify({ type: 'response', responseJson }) + '\n');
						return;
					}
					const payload = JSON.parse(req.payloadJson) as { command: string; args: Record<string, unknown> };
					receivedRequests.push({ command: payload.command, args: payload.args ?? {} });
					const resultBody = payload.command === 'ade_sysprompt_path'
						? { ok: true, doc_rev: 1, base_dir: '~/.ade_store/sysprompts/v1', files: { ticket: '~/.ade_store/sysprompts/v1/ticket.md' } }
						: { ok: true, agent_id: 'agent_l2', project_id: 'proj_1', level: 'L2', name: 'Dev', role_summary: 'Dev', host: 'local', held_ticket_count: 0, wb_unread_total: 0, current_doc_rev: 1 };
					const responseJson = JSON.stringify(resultBody);
					const validResProof = computeCliHmacResponseProof(secret, nonce, req.jti, responseJson);
					const resProof = tamperResProof ? '0'.repeat(64) : validResProof;
					socket.end(JSON.stringify({ type: 'response', responseJson, resProof }) + '\n');
				}
			});
		};

		let udsServer: net.Server | undefined;
		let useInMemoryStream = false;
		try {
			const candidate = net.createServer(s => handleServerSocket(s));
			await new Promise<void>((resolve, reject) => {
				candidate.once('error', reject);
				candidate.listen(sockPath, () => resolve());
			});
			udsServer = candidate;
		} catch {
			useInMemoryStream = true;
		}

		let capturedOut = '';
		const makeRpcOpts = () => ({
			...(useInMemoryStream ? {
				connectStream: () => {
					const pair = createInMemoryDuplexPair();
					setImmediate(() => handleServerSocket(pair.server));
					return pair.client;
				},
			} : {}),
			writeStdout: (line: string) => { capturedOut += line; },
		});

		try {
			// 1. Missing ADE_AGENT_TOKEN fails closed with ERR_UNAUTHORIZED
			capturedOut = '';
			const codeNoToken = await runAdeCliMain(['node', 'ade_whoami'], { ADE_CONTROL_SOCKET: sockPath }, makeRpcOpts());
			assert.equal(codeNoToken, 1);
			assert.equal(JSON.parse(capturedOut.trim()).code, 'ERR_UNAUTHORIZED');

			// 2. Valid mutual HMAC + remote ade_sysprompt_path tilde expansion to local os.homedir()
			capturedOut = '';
			const bridgeFile = path.join(sockDir, 'bridge.json');
			fs.writeFileSync(bridgeFile, JSON.stringify({ endpoint: sockPath, updatedAt: Date.now() }), { mode: 0o600 });
			const codeOk = await runAdeCliMain(
				['node', 'ade_sysprompt_path', '--module', 'ticket'],
				{ ADE_AGENT_TOKEN: token, ADE_CONTROL_BRIDGE_FILE: bridgeFile },
				makeRpcOpts(),
			);
			assert.equal(codeOk, 0);
			const syspromptRes = JSON.parse(capturedOut.trim()) as { ok: boolean; base_dir: string; files: { ticket: string } };
			assert.equal(syspromptRes.ok, true);
			assert.equal(syspromptRes.base_dir.startsWith('~'), false, 'Tilde must be expanded to real absolute path');
			assert.equal(syspromptRes.files.ticket, path.join(os.homedir(), '.ade_store', 'sysprompts', 'v1', 'ticket.md'));

			// 3. Tampered server resProof is rejected by client mutual HMAC check!
			capturedOut = '';
			tamperResProof = true;
			const codeTampered = await runAdeCliMain(
				['node', 'ade_whoami'],
				{ ADE_AGENT_TOKEN: token, ADE_CONTROL_SOCKET: sockPath },
				makeRpcOpts(),
			);
			assert.equal(codeTampered, 1);
			assert.equal(JSON.parse(capturedOut.trim()).code, 'ERR_UNAUTHORIZED');
			tamperResProof = false;

			// 4. Verify >64KB piped stdin temp-file bypass (<4KB wire JSON) via async spawn (zero event-loop deadlock!)
			const cliJs = path.join(EXTENSION_ROOT, 'dist', 'adeCli.js');
			const bigDetail = 'X'.repeat(80 * 1024);
			if (!useInMemoryStream) {
				const bigProc = await spawnAsyncWithInput(
					process.execPath,
					[cliJs, 'ade_wb_post_msg', 'wb_01', '--summary', 'Big', '--stars', '5', '--detail-stdin'],
					{
						input: bigDetail,
						env: { ...process.env, ADE_AGENT_TOKEN: token, ADE_CONTROL_SOCKET: sockPath },
					},
				);
				assert.equal(bigProc.status, 0, bigProc.stderr || bigProc.stdout);
				const lastReq = receivedRequests[receivedRequests.length - 1];
				assert.equal(lastReq.command, 'ade_wb_post_msg');
				assert.equal(typeof lastReq.args.detailTempFile, 'string', '>64KB stdin must use local temp file bypass');
				assert.equal(fs.readFileSync(String(lastReq.args.detailTempFile), 'utf8'), bigDetail);
				fs.rmSync(String(lastReq.args.detailTempFile), { force: true });
			} else {
				const transportTs = path.join(EXTENSION_ROOT, 'src', 'adeCliTransport.ts');
				const bigProc = await spawnAsyncWithInput(
					process.execPath,
					['-e', `import(${JSON.stringify(transportTs)}).then(async m => { const r = await m.readStdinWithTimeoutAndTempBypass(); process.stdout.write(JSON.stringify(r)); });`],
					{ input: bigDetail, env: process.env },
				);
				assert.equal(bigProc.status, 0, bigProc.stderr || bigProc.stdout);
				const parsedBypass = JSON.parse(bigProc.stdout.trim()) as { tempFilePath?: string; byteLength: number };
				assert.equal(parsedBypass.byteLength, 80 * 1024);
				assert.equal(typeof parsedBypass.tempFilePath, 'string');
				assert.equal(fs.readFileSync(parsedBypass.tempFilePath!, 'utf8'), bigDetail);
				fs.rmSync(parsedBypass.tempFilePath!, { force: true });
			}

			// 5. Empty non-EOF pipe on --stdin times out cleanly at 3000ms with ERR_INVALID_ARGS (no infinite hang!)
			const hangChild = cp.spawn(
				process.execPath,
				[cliJs, 'ade_wb_note_send', 'wb_01', '--to', 'a2', '--stdin'],
				{
					stdio: ['pipe', 'pipe', 'pipe'],
					env: { ...process.env, ADE_AGENT_TOKEN: token, ADE_CONTROL_SOCKET: sockPath },
				},
			);
			let hangOut = '';
			hangChild.stdout.setEncoding('utf8');
			hangChild.stdout.on('data', c => { hangOut += c; });
			const hangExit = await new Promise<number | null>(resolve => hangChild.once('close', resolve));
			hangChild.stdin.destroy();
			assert.equal(hangExit, 1);
			assert.equal(JSON.parse(hangOut.trim()).code, 'ERR_INVALID_ARGS');
		} finally {
			if (udsServer) {
				await new Promise<void>(resolve => udsServer!.close(() => resolve()));
			}
			fs.rmSync(sockDir, { recursive: true, force: true });
		}
	});
});

describe('agentEnvIsolation & ticketMessageFormat', () => {
	test('isolates daemon slot keys per ADE employee and strips all ADE_* vars on standalone IDE sessions', () => {
		const slotA = computeAgentIdentityScopeKey('s1', { projectId: 'proj_1', agentId: 'agent_l1', agentToken: 'ades1.a.b' });
		const slotB = computeAgentIdentityScopeKey('s2', { projectId: 'proj_1', agentId: 'agent_l2', agentToken: 'ades1.c.d' });
		const pureSlot = computeAgentIdentityScopeKey('s3', undefined);

		assert.equal(slotA, 'ade:proj_1:agent_l1');
		assert.equal(slotB, 'ade:proj_1:agent_l2');
		assert.notEqual(slotA, slotB);
		assert.equal(pureSlot, SHARED_PURE_SCOPE_KEY);

		const adeBinDir = path.join(EXTENSION_ROOT, 'bin');
		const dirtyBase = {
			PATH: `${adeBinDir}${path.delimiter}/usr/bin`,
			ADE_AGENT_TOKEN: 'ades1.leak.secret',
			ADE_CONTROL_SOCKET: '/tmp/leak.sock',
			AEXUS_ADE_TOKEN: 'legacy-leak',
		};
		const pureEnv = buildAgentChildEnv({ identity: undefined, baseEnv: dirtyBase, cliBinDirs: [adeBinDir] });
		assert.equal(pureEnv.ADE_AGENT_TOKEN, undefined);
		assert.equal(pureEnv.ADE_CONTROL_SOCKET, undefined);
		assert.equal(pureEnv.AEXUS_ADE_TOKEN, undefined);
		assert.equal(pureEnv.PATH?.includes(adeBinDir), false, 'Standalone IDE session PATH must not expose bin/ade_*');
		assert.equal(stripAdeControlEnv(dirtyBase).ADE_AGENT_TOKEN, undefined);
	});

	test('recognizes exact Ticket header literal with {<from_id>} and trailing single space on line 1', () => {
		const validEnvelope = [
			'[系统提示词: 此消息是来自Agent {agent_l1_lead}的Ticket] ',
			'ticket_id: tk_8f3k2a | task_id: tsk_001 | task_type: dev | need_return: true',
			'has_detail_ref: true | has_history_ref: false',
			'task_title: 实现会话环境变量鉴权中间件',
			'summary: 请在今天完成鉴权实现并回传结果',
		].join('\n');

		assert.equal(isAdeTicketDeliveryMessage(validEnvelope), true);
		const parsed = parseAdeTicketDeliveryMessage(validEnvelope);
		assert.deepEqual(parsed, {
			fromAgentId: 'agent_l1_lead',
			ticketId: 'tk_8f3k2a',
			taskId: 'tsk_001',
			taskType: 'dev',
			needReturn: true,
			hasDetailRef: true,
			hasHistoryRef: false,
			taskTitle: '实现会话环境变量鉴权中间件',
			summary: '请在今天完成鉴权实现并回传结果',
		});

		// Missing trailing space on line 1 or missing braces must fail strict header regex
		const missingSpace = validEnvelope.replace('}的Ticket] \n', '}的Ticket]\n');
		assert.equal(parseAdeTicketDeliveryMessage(missingSpace), undefined);
		const missingBraces = validEnvelope.replace('{agent_l1_lead}', 'agent_l1_lead');
		assert.equal(parseAdeTicketDeliveryMessage(missingBraces), undefined);
	});
});
