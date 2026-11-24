/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { runCli } from '../src/adeCli.ts';
import { sendControlRequestWithRetry } from '../src/adeCliRuntimeSupport.mjs';

interface IReceivedControlRequest {
	readonly token?: string;
	readonly action?: string;
	readonly params?: Record<string, unknown>;
}

interface IMockControlServer {
	readonly tmpDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly received: IReceivedControlRequest[];
	close(): Promise<void>;
}

/** Spins up a one-shot-per-connection Unix control socket that records the wire request and replies `ok`. */
async function createMockControlServer(prefix: string): Promise<IMockControlServer> {
	const tmpDir = await fs.mkdtemp(path.join('/tmp', prefix));
	const sockPath = path.join(tmpDir, 'ade.sock');
	const received: IReceivedControlRequest[] = [];
	const server = net.createServer(socket => {
		let buffer = '';
		socket.setEncoding('utf8');
		socket.on('data', chunk => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline >= 0) {
				received.push(JSON.parse(buffer.slice(0, newline)) as IReceivedControlRequest);
				socket.end(JSON.stringify({ ok: true, result: { status: 'ok' } }) + '\n');
			}
		});
	});
	await new Promise<void>(resolve => server.listen(sockPath, resolve));
	return {
		tmpDir,
		env: { AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_TOKEN: 'test-token' },
		received,
		async close() {
			await new Promise<void>(resolve => server.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		},
	};
}

async function invokeWithStdin(
	argv: string[],
	stdin: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
	let stdout = '';
	let stderr = '';
	const code = await runCli(argv, {
		stdout: text => { stdout += text; },
		stderr: text => { stderr += text; },
		stdin,
		env,
		cwd,
	});
	return { code, stdout, stderr };
}

describe('runCli stdin payload handling', () => {
	test('whiteboard write --content - reads multiline Markdown with backticks and dollar signs from stdin', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const server = await createMockControlServer('ade-cli-stdin-');
		try {
			const stdin = '# Architecture Contract\n- Use `$HOME` and `foo()`\n- Price: $100\n';
			const result = await invokeWithStdin(
				['whiteboard', 'write', 'wb_arch', '--content', '-', '--json'],
				stdin,
				server.env,
				server.tmpDir,
			);
			assert.strictEqual(result.code, 0, result.stderr || result.stdout);
			assert.strictEqual(server.received.length, 1);
			assert.strictEqual(server.received[0].action, 'whiteboard.write');
			assert.strictEqual(server.received[0].params?.content, stdin);
		} finally {
			await server.close();
		}
	});

	test('whiteboard write --append - reads multiline Markdown from stdin into appendContent', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const server = await createMockControlServer('ade-cli-stdin-');
		try {
			const stdin = '## Addendum\n- Verified';
			const result = await invokeWithStdin(
				['whiteboard', 'write', 'wb_arch', '--append', '-', '--json'],
				stdin,
				server.env,
				server.tmpDir,
			);
			assert.strictEqual(result.code, 0, result.stderr || result.stdout);
			assert.strictEqual(server.received.length, 1);
			assert.strictEqual(server.received[0].action, 'whiteboard.write');
			assert.strictEqual(server.received[0].params?.appendContent, '## Addendum\n- Verified');
		} finally {
			await server.close();
		}
	});

	test('token return --detail - --complete-task forwards full stdin detail and completeTask=true', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const server = await createMockControlServer('ade-cli-stdin-');
		try {
			const stdin = '### Verification Output\nAll 42 tests passed.';
			const result = await invokeWithStdin(
				['token', 'return', 'otok-7', '--summary', 'Delivered Core', '--detail', '-', '--complete-task', '--json'],
				stdin,
				server.env,
				server.tmpDir,
			);
			assert.strictEqual(result.code, 0, result.stderr || result.stdout);
			assert.strictEqual(server.received.length, 1);
			assert.strictEqual(server.received[0].action, 'token.return');
			assert.strictEqual(server.received[0].params?.tokenId, 'otok-7');
			assert.strictEqual(server.received[0].params?.detail, '### Verification Output\nAll 42 tests passed.');
			assert.strictEqual(server.received[0].params?.completeTask, true);
		} finally {
			await server.close();
		}
	});

	test('token split --branches-json - parses branch array from stdin', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const server = await createMockControlServer('ade-cli-stdin-');
		try {
			const stdin = JSON.stringify([
				{ to: 'CoreMgr', summary: 'Core', task: 'T2' },
				{ to: 'CliMgr', summary: 'CLI', task: 'T3' },
			]);
			const result = await invokeWithStdin(
				['token', 'split', 'otok-1', '--branches-json', '-', '--json'],
				stdin,
				server.env,
				server.tmpDir,
			);
			assert.strictEqual(result.code, 0, result.stderr || result.stdout);
			assert.strictEqual(server.received.length, 1);
			assert.strictEqual(server.received[0].action, 'token.split');
			// The wire contract forwards the stdin text verbatim as `branchesJson`; the control plane
			// parses it into branch objects server-side.
			assert.strictEqual(server.received[0].params?.branchesJson, stdin);
			const branches = JSON.parse(server.received[0].params?.branchesJson as string) as unknown[];
			assert.ok(Array.isArray(branches));
			assert.strictEqual(branches.length, 2);
		} finally {
			await server.close();
		}
	});

	test('emits compact single-line JSON on non-TTY --json, indented JSON with --pretty, concise human formatters, and retries transient socket connect/EOF', async t => {
		if (process.platform === 'win32') {
			t.skip('Unix domain socket test');
			return;
		}
		const tmpDir = await fs.mkdtemp(path.join('/tmp', 'ade-cli-compact-'));
		const sockPath = path.join(tmpDir, 'ade.sock');
		let attempts = 0;
		const server = net.createServer(socket => {
			attempts += 1;
			// First connection simulates transient empty-EOF contention on a read action (`whoami`)
			if (attempts === 1) {
				socket.destroy();
				return;
			}
			let buf = '';
			socket.setEncoding('utf8');
			socket.on('data', chunk => {
				buf += chunk;
				const nl = buf.indexOf('\n');
				if (nl >= 0) {
					const req = JSON.parse(buf.slice(0, nl)) as { action: string; params?: Record<string, unknown>; idempotencyKey?: string };
					if (req.action === 'whoami') {
						socket.end(JSON.stringify({ ok: true, result: { agentId: 'gov-1', rank: 'governor', tier: 1, label: 'Alice', missionId: 'm-1', nodeId: 'CEO' } }) + '\n');
					} else if (req.action === 'token.mint') {
						if (!req.idempotencyKey) {
							// Keyless mutating calls simulate post-write empty EOF — must NOT be retried!
							socket.destroy();
						} else if (!(server as net.Server & { seenMintKeys?: Set<string> }).seenMintKeys?.has(req.idempotencyKey)) {
							const holder = server as net.Server & { seenMintKeys?: Set<string> };
							holder.seenMintKeys = holder.seenMintKeys ?? new Set<string>();
							holder.seenMintKeys.add(req.idempotencyKey);
							// First attempt with idempotencyKey drops connection mid-flight; CLI safely replays same key!
							socket.destroy();
						} else {
							socket.end(JSON.stringify({ ok: true, result: { tokenId: 'otok-minted', status: 'active' }, idempotentReplay: true }) + '\n');
						}
					} else if (req.action === 'whiteboard.list') {
						socket.end(JSON.stringify({ ok: true, result: { whiteboards: [{ whiteboardId: 'wb_arch', department: 'Core', version: 3, title: 'Architecture' }] } }) + '\n');
					} else if (req.action === 'whiteboard.read') {
						socket.end(JSON.stringify({ ok: true, result: { ok: true, missionId: 'm-1', whiteboard: { id: 'wb_arch', title: 'Architecture', department: 'Core', version: 3, content: '## Contract' } } }) + '\n');
					} else if (req.action === 'token.current') {
						socket.end(JSON.stringify({ ok: true, result: { missionId: 'm-1', tokens: [{ id: 'otok-9', status: 'active', nodeId: 'Dev1', lastSummary: 'Implement parser' }] } }) + '\n');
					} else if (req.action === 'token.handoff') {
						socket.end(JSON.stringify({ ok: true, result: { tokenId: 'otok-9', status: 'handed_off', handedOffTo: ['QA1'], nextTokenIds: ['otok-10'] } }) + '\n');
					} else {
						socket.end(JSON.stringify({ ok: true, result: { received: req.params } }) + '\n');
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sockPath, resolve));
		try {
			const env = { AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_TOKEN: 'tok' };

			// 1. Retries zero-byte EOF on idempotent read (`whoami`) & emits compact 1-line JSON on non-TTY
			let compactOut = '';
			const code1 = await runCli(['whoami', '--json'], {
				stdout: s => { compactOut += s; },
				stderr: () => { },
				env,
				cwd: tmpDir,
				stdoutIsTTY: false,
			});
			assert.strictEqual(code1, 0);
			assert.strictEqual(attempts, 2, 'Expected transparent retry on transient zero-byte socket EOF');
			assert.strictEqual(compactOut.trim().split('\n').length, 1, 'Non-TTY --json must emit compact single-line JSON');

			// 2. --pretty forces multi-line indented JSON even on non-TTY
			let prettyOut = '';
			const code2 = await runCli(['whoami', '--json', '--pretty'], {
				stdout: s => { prettyOut += s; },
				stderr: () => { },
				env,
				cwd: tmpDir,
				stdoutIsTTY: false,
			});
			assert.strictEqual(code2, 0);
			assert.ok(prettyOut.trim().split('\n').length > 4, '--pretty must emit multi-line JSON');

			// 3. Concise human output for `whoami` without --json
			let humanOut = '';
			const code3 = await runCli(['whoami'], {
				stdout: s => { humanOut += s; },
				stderr: () => { },
				env,
				cwd: tmpDir,
			});
			assert.strictEqual(code3, 0);
			assert.match(humanOut, /\[L1 · governor\] "Alice" id=gov-1 mission=m-1 node=CEO/);

			// 4. Unified stdin: `mission blueprint apply --mission m-1 --file -` & `session send s-1 --prompt-file -`
			const bpRes = await invokeWithStdin(
				['mission', 'blueprint', 'apply', '--mission', 'm-1', '--file', '-', '--json'],
				'flowchart LR\n  T1 --> T2\n',
				env,
				tmpDir,
			);
			assert.strictEqual(bpRes.code, 0, bpRes.stderr || bpRes.stdout);
			assert.deepStrictEqual(JSON.parse(bpRes.stdout).received, {
				missionId: 'm-1',
				text: 'flowchart LR\n  T1 --> T2\n',
			});

			const sendRes = await invokeWithStdin(
				['session', 'send', 's-1', '--prompt-file', '-', '--wait', '--json'],
				' Inspect $PATH and run --help ',
				env,
				tmpDir,
			);
			assert.strictEqual(sendRes.code, 0, sendRes.stderr || sendRes.stdout);
			assert.deepStrictEqual(JSON.parse(sendRes.stdout).received, {
				id: 's-1',
				prompt: ' Inspect $PATH and run --help ',
				wait: true,
			});

			// 5. Duplicate "-" across multiple stdin flags in one command fails fast with usage error
			const dupRes = await invokeWithStdin(
				['token', 'mint', 'otok-1', '--detail', '-', '--branches-json', '-', '--json'],
				'{}',
				env,
				tmpDir,
			);
			assert.strictEqual(dupRes.code, 1);
			assert.match(dupRes.stdout + dupRes.stderr, /cannot be consumed by multiple options/i);

			// 6a. Keyless mutating requests (`sendControlRequestWithRetry` without `idempotencyKey`) NEVER retry on post-write emptySocketEof
			const beforeKeylessMintAttempts = attempts;
			await assert.rejects(
				() => sendControlRequestWithRetry(
					{ AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_SESSION_TOKEN: 'cap-tok' },
					sockPath,
					{ token: 'cap-tok', action: 'token.mint', params: { tokenId: 'otok-1', targetNodeIds: ['Dev1'], summary: 'Build' } },
					false,
				),
				/closed without sending a response/i,
			);
			assert.strictEqual(attempts - beforeKeylessMintAttempts, 1, 'Keyless mutating token.mint must NOT retry on post-write emptySocketEof');

			// 6b. CLI mutating actions (`token.mint`) auto-attach UUIDv4 `idempotencyKey` and safely replay on transient emptySocketEof
			const beforeMintAttempts = attempts;
			let mintOut = '';
			let mintErr = '';
			const mintCode = await runCli(['token', 'mint', 'otok-1', '--to', 'Dev1', '--summary', 'Build', '--json'], {
				stdout: s => { mintOut += s; },
				stderr: s => { mintErr += s; },
				env: { AEXUS_ADE_SOCKET: sockPath, AEXUS_ADE_SESSION_TOKEN: 'cap-tok' },
				cwd: tmpDir,
			});
			assert.strictEqual(mintCode, 0, mintOut + mintErr);
			assert.strictEqual(attempts - beforeMintAttempts, 2, 'CLI mutating token.mint with auto-UUIDv4 idempotencyKey must replay once on emptySocketEof');
			assert.strictEqual(JSON.parse(mintOut).tokenId, 'otok-minted');

			// 7. Human formatters render whiteboardId, nested record.whiteboard, tok.lastSummary, handedOffTo/nextTokenIds, and `mission task create --description -`
			let wbListOut = '';
			assert.strictEqual(await runCli(['whiteboard', 'list'], { stdout: s => { wbListOut += s; }, stderr: () => { }, env, cwd: tmpDir }), 0);
			assert.match(wbListOut, /- wb_arch \[Core\] v3: Architecture/);

			let wbReadOut = '';
			assert.strictEqual(await runCli(['whiteboard', 'read', 'wb_arch'], { stdout: s => { wbReadOut += s; }, stderr: () => { }, env, cwd: tmpDir }), 0);
			assert.match(wbReadOut, /# Architecture \(wb_arch · Core · v3\)\n## Contract/);

			let curOut = '';
			assert.strictEqual(await runCli(['token', 'current'], { stdout: s => { curOut += s; }, stderr: () => { }, env, cwd: tmpDir }), 0);
			assert.match(curOut, /otok-9 \[active\] @Dev1 — Implement parser/);

			let handoffOut = '';
			assert.strictEqual(await runCli(['token', 'handoff', 'otok-9', '--to', 'QA1', '--summary', 'Ready'], { stdout: s => { handoffOut += s; }, stderr: () => { }, env, cwd: tmpDir }), 0);
			assert.match(handoffOut, /OK token\.handoff otok-9 \[handed_off\] -> QA1 next=\[otok-10\]/);

			const createTaskRes = await invokeWithStdin(
				['mission', 'task', 'create', '--mission', 'm-1', '--title', 'Spec Task', '--description', '-', '--json'],
				'Multi-line task spec',
				env,
				tmpDir,
			);
			assert.strictEqual(createTaskRes.code, 0);
			assert.strictEqual(JSON.parse(createTaskRes.stdout).received.description, 'Multi-line task spec');
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
