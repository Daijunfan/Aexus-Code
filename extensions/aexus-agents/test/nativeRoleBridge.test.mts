/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const extRoot = path.resolve(import.meta.dirname, '..');
const srcDir = path.join(extRoot, 'src');
const distDir = path.join(extRoot, 'dist');

interface MockChildProcess extends cp.ChildProcess {
	readonly stdin: PassThrough;
	readonly stdout: PassThrough;
	readonly stderr: PassThrough;
}

function createMockChild(): MockChildProcess {
	const emitter = new EventEmitter() as MockChildProcess;
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	Object.assign(emitter, {
		stdin,
		stdout,
		stderr,
		stdio: [stdin, stdout, stderr, null, null],
		pid: 42424,
		killed: false,
		exitCode: null,
		signalCode: null,
		kill: () => true,
	});
	return emitter;
}

interface ParsedWsFrame {
	readonly fin: boolean;
	readonly opcode: number;
	readonly masked: boolean;
	readonly payload: Buffer;
	readonly raw: Buffer;
}

/** Encodes an arbitrary RFC 6455 frame (any FIN/opcode/fragmentation shape), optionally masking the payload. */
function encodeRawWsFrame(opcode: number, fin: boolean, payload: Buffer, maskKey?: Buffer): Buffer {
	const maskBit = maskKey ? 0x80 : 0x00;
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([(fin ? 0x80 : 0) | opcode, maskBit | length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = maskBit | 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = maskBit | 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	if (!maskKey) {
		return Buffer.concat([header, payload]);
	}
	const masked = Buffer.alloc(length);
	for (let i = 0; i < length; i++) {
		masked[i] = payload[i] ^ maskKey[i & 3];
	}
	return Buffer.concat([header, maskKey, masked]);
}

/** Splits a byte stream into RFC 6455 frames and unmasks payloads (server -> client frames are unmasked). */
function parseWsFrames(buffer: Buffer): ParsedWsFrame[] {
	const frames: ParsedWsFrame[] = [];
	let pos = 0;
	while (pos + 2 <= buffer.length) {
		const b0 = buffer[pos];
		const b1 = buffer[pos + 1];
		const fin = (b0 & 0x80) !== 0;
		const opcode = b0 & 0x0f;
		const masked = (b1 & 0x80) !== 0;
		let length = b1 & 0x7f;
		let offset = pos + 2;
		if (length === 126) {
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			length = Number(buffer.readBigUInt64BE(offset));
			offset += 8;
		}
		let maskKey: Buffer | undefined;
		if (masked) {
			maskKey = buffer.subarray(offset, offset + 4);
			offset += 4;
		}
		const payload = Buffer.from(buffer.subarray(offset, offset + length));
		if (maskKey) {
			for (let i = 0; i < payload.length; i++) {
				payload[i] ^= maskKey[i & 3];
			}
		}
		frames.push({ fin, opcode, masked, payload, raw: Buffer.from(buffer.subarray(pos, offset + length)) });
		pos = offset + length;
	}
	assert.strictEqual(pos, buffer.length, 'Expected the frame parser to consume the entire byte stream');
	return frames;
}

/** Parses a single RFC 6455 frame from the front of a possibly incomplete byte stream. */
function tryParseWsFrame(buffer: Buffer): { readonly frame: ParsedWsFrame; readonly consumed: number } | undefined {
	if (buffer.length < 2) {
		return undefined;
	}
	const b0 = buffer[0];
	const b1 = buffer[1];
	const masked = (b1 & 0x80) !== 0;
	let length = b1 & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) {
			return undefined;
		}
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) {
			return undefined;
		}
		length = Number(buffer.readBigUInt64BE(2));
		offset = 10;
	}
	let maskKey: Buffer | undefined;
	if (masked) {
		if (buffer.length < offset + 4) {
			return undefined;
		}
		maskKey = buffer.subarray(offset, offset + 4);
		offset += 4;
	}
	if (buffer.length < offset + length) {
		return undefined;
	}
	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (maskKey) {
		for (let i = 0; i < payload.length; i++) {
			payload[i] ^= maskKey[i & 3];
		}
	}
	return {
		frame: {
			fin: (b0 & 0x80) !== 0,
			opcode: b0 & 0x0f,
			masked,
			payload,
			raw: Buffer.from(buffer.subarray(0, offset + length)),
		},
		consumed: offset + length,
	};
}

describe('ADE Native Extension Role Bridge', () => {
	let tempDir: string;
	let bridgeModule: typeof import('../src/nativeRoleBridge');
	let sharedModule: typeof import('../src/roleBridgeShared');

	before(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aexus-role-bridge-test-'));
		esbuild.buildSync({
			entryPoints: [
				path.join(srcDir, 'nativeRoleBridge.ts'),
				path.join(srcDir, 'roleBridgeShared.ts'),
			],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outdir: tempDir,
		});
		bridgeModule = require(path.join(tempDir, 'nativeRoleBridge.js'));
		sharedModule = require(path.join(tempDir, 'roleBridgeShared.js'));
	});

	after(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('stripInjectedAdeContextFromUserTurn & filterAndCleanHistoryTurns', () => {
		const stripPreamble = (text: string): string => sharedModule.stripInjectedAdeContextFromUserTurn(text);

		it('strips a sentinel-delimited preamble stacking Role Context, Cloud Host, Active Goal & keeps the prompt with attached files', () => {
			const raw = [
				'[Aexus Orchestrated Role Context]',
				'You ARE an official orchestrated organizational agent session.',
				'- Role: Governor',
				'- Direct Subordinates: Beta Employee (emp-1)',
				'',
				'[Aexus Cloud Host Project Context]',
				'- Active Project is on SSH Cloud Host `prod-eu-1` at remote directory `/srv/alpha` (URI: `vscode-remote://ssh-remote+prod-eu-1/srv/alpha`, OS: `linux`).',
				'- Execute shell commands, builds, tests, and file edits on the Cloud Host via SSH.',
				'',
				'[Autonomous Session Goal Active]',
				'Goal Condition: Ship the telemetry refactor.',
				'- Execute thoroughly and verify all requirements end-to-end before stopping.',
				'- Only when EVERY requirement of the goal is 100% complete and verified, output the exact completion marker `<!-- AEXUS_GOAL_COMPLETE -->` at the very end of your response.',
				'',
				sharedModule.AEXUS_PREAMBLE_END_MARKER,
				'',
				'Fix the flaky native role bridge test.',
				'',
				'Attached files:',
				'- src/nativeRoleBridge.ts',
				'- test/nativeRoleBridge.test.mts',
			].join('\n');

			const expected = [
				'Fix the flaky native role bridge test.',
				'',
				'Attached files:',
				'- src/nativeRoleBridge.ts',
				'- test/nativeRoleBridge.test.mts',
			].join('\n');

			assert.deepStrictEqual(stripPreamble(raw), expected);
			assert.deepStrictEqual(stripPreamble(expected), expected, 'Expected stripping to be idempotent');
		});

		it('peels stacked legacy blocks without a sentinel (Role Context, hierarchy delta, Secretary viewport, Cloud Host, multi-paragraph goal)', () => {
			const raw = [
				'[Aexus Orchestrated Role Context]',
				'You ARE an official orchestrated organizational agent session.',
				'- Role: Governor',
				'- Direct Subordinates: Beta Employee (emp-1)',
				'',
				'[ADE Live Hierarchy State]',
				'- Governor: Alpha Governor (gov-1)',
				'- Employee: Beta Employee (emp-1)',
				'- Worker: Gamma Worker (wrk-1)',
				'',
				'[Aexus ADE Live Viewport & Macro Control Context]',
				'You are the global **Secretary** in **Aexus Code ADE**.',
				'- Active Project: Alpha',
				'- Focused Agent: Gamma Worker (wrk-1)',
				'',
				'[Aexus Cloud Host Project Context]',
				'- Shared SSH Cloud Host `prod-eu-1` at remote directory `/srv/alpha`.',
				'- Network latency budget applies to every remote command.',
				'',
				'[Autonomous Session Goal Active]',
				'Goal Condition: Reconcile the DAG analytics with the live hierarchy.',
				'',
				'Every Employee must report its branch status before the next heartbeat, and no Worker may remain idle across two consecutive rounds.',
				'',
				'Only when EVERY requirement of the goal is 100% complete and verified, output the exact completion marker `<!-- AEXUS_GOAL_COMPLETE -->` at the very end of your response.',
				'',
				'Re-run the analytics test suite and summarize the delta.',
			].join('\n');

			assert.deepStrictEqual(stripPreamble(raw), 'Re-run the analytics test suite and summarize the delta.');
		});

		it('strips the single-newline array-joined Codex fallback with a doubled Role Context header', () => {
			const raw = [
				'[Aexus Orchestrated Role Context]',
				'[Aexus Orchestrated Role Context]',
				'- Role: Governor',
				'- Direct Subordinates: Beta Employee (emp-1)',
				'你的身份?',
			].join('\n');

			assert.deepStrictEqual(stripPreamble(raw), '你的身份?');
		});

		it('strips Claude Role Context Updated and Role Cleared turns', () => {
			const updated = [
				'[Aexus Orchestrated Role Context Updated]',
				'- Role: Governor',
				'- Direct Subordinates: Beta Employee (emp-1)',
				'- Board: Alpha',
				'请汇报当前进度',
			].join('\n');
			const cleared = [
				'[Aexus Role Cleared: Governor]',
				'现在你是一名普通 Worker。',
			].join('\n');

			assert.deepStrictEqual(
				[stripPreamble(updated), stripPreamble(cleared)],
				['请汇报当前进度', '现在你是一名普通 Worker。'],
			);
		});

		it('drops the silent role initialization with its assistant ack, even when prefixed by nativeRoleBridge, and condenses goal stop-checks', () => {
			const turns: Array<{ id: string; role: 'user' | 'assistant'; text: string }> = [
				{ id: 'u-init', role: 'user', text: `${sharedModule.ROLE_INIT_MARKER}\nSilent warmup: internalize the charter and reply with the exact single token: ACK` },
				{ id: 'a-init', role: 'assistant', text: 'ACK' },
				{ id: 'u-prefixed-init', role: 'user', text: '[Aexus Orchestrated Role Context]\n- Role: Governor\n\n[AEXUS_ADE_ROLE_INITIALIZATION]\nReply with the exact single token: ACK' },
				{ id: 'a-prefixed-init', role: 'assistant', text: 'ACK' },
				{ id: 'u-prompt', role: 'user', text: 'Now wire the telemetry counter.' },
				{ id: 'a-prompt', role: 'assistant', text: 'Done.' },
				{ id: 'u-stop', role: 'user', text: '[Autonomous Goal Stop-Check — Round 2/6]\nActive Goal: Ship the telemetry refactor.\nYou stopped without emitting `<!-- AEXUS_GOAL_COMPLETE -->`.' },
			];

			assert.deepStrictEqual(sharedModule.filterAndCleanHistoryTurns(turns), [
				{ id: 'u-prompt', role: 'user', text: 'Now wire the telemetry counter.' },
				{ id: 'a-prompt', role: 'assistant', text: 'Done.' },
				{ id: 'u-stop', role: 'user', text: '[Autonomous Goal Verification · Round 2/6]', isSystemInitiated: true },
			]);
		});

		it('preserves normal user prompts and turns untouched', () => {
			const prompts = [
				'Fix the flaky native role bridge test.',
				'- not a bullet preamble\nJust a dash-led prompt.',
				'你好，请总结一下 [Aexus Orchestrated Role Context] 的作用。',
				'Documentation mentions this sentinel <!-- /AEXUS_ADE_PREAMBLE --> mid-text.',
				'',
			];
			assert.deepStrictEqual(prompts.map(stripPreamble), prompts);

			const turns: Array<{ id: string; role: 'user' | 'assistant'; text: string }> = [
				{ id: 'u-1', role: 'user', text: 'Summarize the failing test.\n\nAttached files:\n- test/nativeRoleBridge.test.mts' },
				{ id: 'a-1', role: 'assistant', text: 'The failure is a timeout.' },
				{ id: 'u-empty', role: 'user', text: '' },
			];
			assert.deepStrictEqual(sharedModule.filterAndCleanHistoryTurns(turns), [
				{ id: 'u-1', role: 'user', text: 'Summarize the failing test.\n\nAttached files:\n- test/nativeRoleBridge.test.mts' },
				{ id: 'a-1', role: 'assistant', text: 'The failure is a timeout.' },
			]);
		});
	});

	it('injects --append-system-prompt for Claude Governor, tracks session_id & hot-swap updates, and keeps pure Worker clean', async () => {
		const bridgeDir = path.join(tempDir, 'claude-bridge');
		const spawns: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; child: MockChildProcess; stdinChunks: string[] }> = [];
		const spawnStub = ((command: string, args: readonly string[] = [], options?: cp.SpawnOptions) => {
			const child = createMockChild();
			const stdinChunks: string[] = [];
			const origWrite = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
			child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
				stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
				return origWrite(chunk, ...rest);
			}) as typeof child.stdin.write;
			spawns.push({ command, args: [...args], env: options?.env, child, stdinChunks });
			return child;
		}) as unknown as typeof cp.spawn;
		const fakeCp = { spawn: spawnStub };

		const boundCalls: Array<{ engine: string; agentId: string; nativeId: string }> = [];
		const controller = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir,
			pid: 9001,
			childProcessModule: fakeCp,
			fetchHost: { fetch: globalThis.fetch },
			onNativeSessionBound: (engine, agentId, nativeId) => boundCalls.push({ engine, agentId, nativeId }),
		});

		try {
			await controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'gov-1',
				selectedAgentId: 'gov-1',
				agents: [
					{
						id: 'gov-1',
						label: 'Alpha Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/gov-res',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor\n- Direct Subordinates: None',
					},
					{
						id: 'wrk-1',
						label: 'Clean Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/wrk-res',
						rank: 'worker',
						isOrchestrated: false,
						rolePrompt: undefined,
					},
				],
			});

			// 1. Spawn Claude for Governor -> gets --append-system-prompt
			const govChild = (fakeCp.spawn as Function)('/usr/local/bin/claude', [
				'--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
			], { cwd: '/projects/Alpha' }) as MockChildProcess;

			const promptIdx = spawns[0].args.indexOf('--append-system-prompt');
			assert.ok(promptIdx >= 0, 'Expected --append-system-prompt on Governor Claude spawn');
			assert.ok(spawns[0].args[promptIdx + 1].includes('Role: Governor'));

			// Turn 1 uses initial system prompt without repeating update banner in user text
			govChild.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '你的身份?' } }) + '\n');
			assert.ok(!spawns[0].stdinChunks.at(-1)!.includes('[Aexus Orchestrated Role Context Updated]'));

			// Emit init event with real Claude session_id
			govChild.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-real-gov-99' }) + '\n'));
			assert.deepStrictEqual(boundCalls, [{ engine: 'claude', agentId: 'gov-1', nativeId: 'claude-real-gov-99' }]);

			// Hot-swap a subordinate onto Governor while process stays running -> next stdin turn carries updated hierarchy!
			await controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'gov-1',
				selectedAgentId: 'gov-1',
				agents: [
					{
						id: 'gov-1',
						label: 'Alpha Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/gov-res',
						nativeSessionId: 'claude-real-gov-99',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor\n- Direct Subordinates: mgr-2',
					},
					{
						id: 'wrk-1',
						label: 'Clean Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/wrk-res',
						rank: 'worker',
						isOrchestrated: false,
						rolePrompt: undefined,
					},
				],
			});

			govChild.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'List subordinates' } }) + '\n');
			const updatedTurn = JSON.parse(spawns[0].stdinChunks.at(-1)!.trim()) as { message: { content: string } };
			assert.ok(updatedTurn.message.content.includes('[Aexus Orchestrated Role Context Updated]'));
			assert.ok(updatedTurn.message.content.includes('Direct Subordinates: mgr-2'));

			// 2. Switch active session to pure Worker -> ZERO --append-system-prompt, ZERO stdin rewrite
			await controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'wrk-1',
				selectedAgentId: 'wrk-1',
				agents: controller.getSnapshot().agents,
			});
			const wrkChild = (fakeCp.spawn as Function)('/usr/local/bin/claude', [
				'--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
			], { cwd: '/projects/Alpha' }) as MockChildProcess;
			assert.strictEqual(spawns[1].args.includes('--append-system-prompt'), false);
			wrkChild.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello worker' } }) + '\n');
			assert.strictEqual(JSON.parse(spawns[1].stdinChunks[0].trim()).message.content, 'Hello worker');
		} finally {
			controller.dispose();
		}
	});

	it('handles Codex app-server prewarm safety, turn/start thread/inject_items barrier, ack filtering, hot-swap & clean Worker', async () => {
		const bridgeDir = path.join(tempDir, 'codex-bridge');
		const sentToCodex: string[] = [];
		let capturedChild!: MockChildProcess;
		const receivedFromCodex: string[] = [];

		const spawnStub = (() => {
			const child = createMockChild();
			capturedChild = child;
			const origWrite = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
			child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
				const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
				for (const line of text.split('\n').filter(Boolean)) {
					sentToCodex.push(line);
					const pkt = JSON.parse(line) as { id?: string; method?: string };
					if (typeof pkt.id === 'string' && pkt.id.startsWith('__aexus_codex_inject_') && pkt.method === 'thread/inject_items') {
						// Respond cleanly like real `codex app-server`
						setImmediate(() => {
							child.stdout.push(Buffer.from(JSON.stringify({ id: pkt.id, result: {} }) + '\n'));
						});
					}
				}
				return origWrite(chunk, ...rest);
			}) as typeof child.stdin.write;
			return child;
		}) as unknown as typeof cp.spawn;
		const fakeCp = { spawn: spawnStub };

		const boundCalls: Array<{ engine: string; agentId: string; nativeId: string }> = [];
		const controller = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir,
			pid: 9002,
			childProcessModule: fakeCp,
			fetchHost: { fetch: globalThis.fetch },
			onNativeSessionBound: (engine, agentId, nativeId) => boundCalls.push({ engine, agentId, nativeId }),
		});

		try {
			controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'mgr-codex',
				selectedAgentId: 'mgr-codex',
				agents: [
					{
						id: 'mgr-codex',
						label: 'Codex Manager',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-codex',
						resource: 'aexus-codex:/mgr',
						rank: 'manager',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Manager (initial)',
					},
					{
						id: 'wrk-codex',
						label: 'Codex Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-codex',
						resource: 'aexus-codex:/wrk',
						rank: 'worker',
						isOrchestrated: false,
					},
				],
			});

			const child = (fakeCp.spawn as Function)('codex', ['-c', 'features.code_mode_host=true', 'app-server']) as MockChildProcess;
			child.stdout.on('data', chunk => {
				for (const line of String(chunk).split('\n').filter(Boolean)) {
					receivedFromCodex.push(line);
				}
			});

			// 1. Prewarmed thread/start must NOT be polluted (could later serve a Worker!)
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'prewarm-1', method: 'thread/start', params: { cwd: '/projects/Alpha', ephemeral: false } }) + '\n');
			assert.strictEqual(JSON.parse(sentToCodex.at(-1)!).params.developerInstructions, undefined);

			// 2. Ephemeral helper thread must NOT be bound or injected
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'ephem-req', method: 'thread/start', params: { cwd: '/projects/Alpha', ephemeral: true } }) + '\n');
			capturedChild.stdout.push(Buffer.from(JSON.stringify({ id: 'ephem-req', result: { thread: { id: 'thr-ephem' } } }) + '\n'));
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'ephem-turn', method: 'turn/start', params: { threadId: 'thr-ephem', input: [{ type: 'text', text: 'title' }] } }) + '\n');

			// 3. First real user turn/start on Codex Manager thread -> injects thread/inject_items BEFORE turn/start & filters ack from stdout!
			sentToCodex.length = 0;
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'turn-1', method: 'turn/start', params: { threadId: 'thr-gov', cwd: '/projects/Alpha', input: [{ type: 'text', text: '你的身份?' }] } }) + '\n');

			await new Promise(r => setTimeout(r, 40));

			assert.strictEqual(sentToCodex.length, 2, 'Expected thread/inject_items followed by turn/start');
			const pkt0 = JSON.parse(sentToCodex[0]) as { method: string; params: { items: Array<{ role: string; content: Array<{ text: string }> }> } };
			const pkt1 = JSON.parse(sentToCodex[1]) as { method: string; id: string };
			assert.strictEqual(pkt0.method, 'thread/inject_items');
			assert.strictEqual(pkt0.params.items[0].role, 'developer');
			assert.ok(pkt0.params.items[0].content[0].text.includes('Role: Manager (initial)'));
			assert.strictEqual(pkt1.method, 'turn/start');
			assert.strictEqual(pkt1.id, 'turn-1');
			assert.deepStrictEqual(boundCalls, [{ engine: 'codex', agentId: 'mgr-codex', nativeId: 'thr-gov' }]);
			assert.ok(!receivedFromCodex.some(line => line.includes('__aexus_codex_inject_')), 'Synthetic inject ack must be stripped from extension stdout');

			// 4. Turn 2 with unchanged rolePrompt does NOT re-inject; Turn 3 after hot-swap DOES re-inject
			sentToCodex.length = 0;
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'turn-2', method: 'turn/start', params: { threadId: 'thr-gov', input: [{ type: 'text', text: 'turn 2' }] } }) + '\n');
			assert.strictEqual(sentToCodex.length, 1);

			controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'mgr-codex',
				selectedAgentId: 'mgr-codex',
				agents: [
					{
						id: 'mgr-codex',
						label: 'Codex Manager',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-codex',
						resource: 'aexus-codex:/mgr',
						nativeSessionId: 'thr-gov',
						rank: 'manager',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Manager (hot-swapped child)',
					},
					controller.getSnapshot().agents[1],
				],
			});
			sentToCodex.length = 0;
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'turn-3', method: 'turn/start', params: { threadId: 'thr-gov', input: [{ type: 'text', text: 'turn 3' }] } }) + '\n');
			await new Promise(r => setTimeout(r, 40));
			assert.strictEqual(sentToCodex.length, 2);
			assert.ok(sentToCodex[0].includes('hot-swapped child'));

			// 5. Switch to pure Worker thread -> ZERO injection!
			controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'wrk-codex',
				selectedAgentId: 'wrk-codex',
				agents: controller.getSnapshot().agents,
			});
			sentToCodex.length = 0;
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'turn-wrk', method: 'turn/start', params: { threadId: 'thr-wrk', cwd: '/projects/Alpha', input: [{ type: 'text', text: 'worker turn' }] } }) + '\n');
			assert.strictEqual(sentToCodex.length, 1);
			assert.strictEqual(JSON.parse(sentToCodex[0]).method, 'turn/start');

			// 6. thread/resume on orchestrated thread injects developerInstructions directly
			sentToCodex.length = 0;
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'res-1', method: 'thread/resume', params: { threadId: 'thr-gov', cwd: '/projects/Alpha' } }) + '\n');
			assert.ok(JSON.parse(sentToCodex[0]).params.developerInstructions.includes('hot-swapped child'));
		} finally {
			controller.dispose();
		}
	});

	it('handles Kilo/OpenCode fetch (Request & init), Pi --mode rpc, Cline LLM fetch, DSH spawn/preload, and Antigravity PreInvocation hook', async () => {
		const bridgeDir = path.join(tempDir, 'all-others-bridge');
		const capturedFetch: Array<{ url: string; body?: string }> = [];
		const fetchHost = {
			fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				const body = typeof init?.body === 'string'
					? init.body
					: (input instanceof Request ? await input.clone().text() : undefined);
				capturedFetch.push({ url, body });
				return new Response('{}', { status: 200 });
			}) as typeof globalThis.fetch,
		};
		const spawns: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
		const spawnStub = ((command: string, args: readonly string[] = [], options?: cp.SpawnOptions) => {
			spawns.push({ command, args: [...args], env: options?.env });
			return createMockChild();
		}) as unknown as typeof cp.spawn;
		const fakeCp = { spawn: spawnStub };

		const controller = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir,
			pid: 9003,
			childProcessModule: fakeCp,
			fetchHost,
		});

		try {
			// --- Kilo & OpenCode via fetchHost.fetch (Request object + init object) ---
			controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'kilo-emp',
				selectedAgentId: 'kilo-emp',
				agents: [
					{
						id: 'kilo-emp',
						label: 'Kilo Employee',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-kilo',
						resource: 'aexus-kilo:/k1',
						rank: 'employee',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Employee (Kilo)',
					},
					{
						id: 'opencode-wrk',
						label: 'OpenCode Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-opencode',
						resource: 'aexus-opencode:/oc1',
						rank: 'worker',
						isOrchestrated: false,
					},
					{
						id: 'pi-gov',
						label: 'Pi Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-pi',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (Pi)',
					},
					{
						id: 'cline-mgr',
						label: 'Cline Manager',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-cline',
						rank: 'manager',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Manager (Cline)',
					},
					{
						id: 'dsh-gov',
						label: 'DSH Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-dsh',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (DSH)',
					},
					{
						id: 'agy-gov',
						label: 'Agy Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-antigravity',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (AGY)',
					},
					{
						id: 'agy-wrk',
						label: 'Agy Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-antigravity',
						nativeSessionId: 'conv-wrk-1',
						rank: 'worker',
						isOrchestrated: false,
					},
				],
			});

			// 1. Kilo Code sends fetch(new Request(...)) -> injects `system`
			const req = new Request('http://127.0.0.1:41234/session/kilo-sess-1/prompt_async?directory=%2Fprojects%2FAlpha', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parts: [{ type: 'text', text: 'Who are you?' }] }),
			});
			await fetchHost.fetch(req);
			assert.ok(JSON.parse(capturedFetch.at(-1)!.body!).system.includes('Role: Employee (Kilo)'));

			// 2. OpenCode pure Worker -> ZERO `system` field injected
			controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: 'opencode-wrk', selectedAgentId: 'opencode-wrk' });
			await fetchHost.fetch('http://127.0.0.1:41235/session/oc-sess-1/prompt_async', {
				method: 'POST',
				body: JSON.stringify({ parts: [{ type: 'text', text: 'Clean worker' }] }),
			});
			assert.strictEqual(JSON.parse(capturedFetch.at(-1)!.body!).system, undefined);

			// 3. Pi --mode rpc injects --append-system-prompt
			controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: 'pi-gov', selectedAgentId: 'pi-gov' });
			(fakeCp.spawn as Function)('pi', ['--mode', 'rpc'], { cwd: '/projects/Alpha' });
			const piSpawn = spawns.at(-1)!;
			assert.ok(piSpawn.args.includes('--append-system-prompt'));
			assert.ok(piSpawn.args[piSpawn.args.indexOf('--append-system-prompt') + 1].includes('Role: Governor (Pi)'));

			// 4. Cline LLM payload injection across Anthropic & OpenAI Chat Completions & Responses & Gemini
			controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: 'cline-mgr', selectedAgentId: 'cline-mgr' });
			await fetchHost.fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				body: JSON.stringify({ model: 'claude', system: 'Base prompt', messages: [{ role: 'user', content: 'hi' }] }),
			});
			assert.ok(JSON.parse(capturedFetch.at(-1)!.body!).system.includes('Role: Manager (Cline)'));

			await fetchHost.fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
			});
			assert.ok(JSON.parse(capturedFetch.at(-1)!.body!).messages[0].content.includes('Role: Manager (Cline)'));

			// Pure Worker in shared helper never alters LLM payload
			assert.strictEqual(
				sharedModule.injectLlmPayloadSystemPrompt('https://api.openai.com/v1/responses', { instructions: 'Base', input: 'hi' }, '[Aexus Orchestrated Role Context]\n- Role: Governor'),
				true,
			);

			// 5. DSH script wrapper rewriting (npm node script & macOS DeepSeek Harness wrapper) & real dist/dshRolePreload.js runtime test
			const fakeDshScript = path.join(tempDir, 'dsh');
			fs.writeFileSync(fakeDshScript, '#!/usr/bin/env node\nconsole.log("ok");\n', { mode: 0o755 });
			controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: 'dsh-gov', selectedAgentId: 'dsh-gov' });
			(fakeCp.spawn as Function)(fakeDshScript, ['--profile', 'web', '--no-open'], { cwd: '/projects/Alpha' });
			const dshSpawn = spawns.at(-1)!;
			assert.ok(dshSpawn.args.includes('--require'));
			assert.ok(dshSpawn.args.includes(path.join(distDir, 'dshRolePreload.js')));
			assert.strictEqual(dshSpawn.env?.[sharedModule.ROLE_STATE_ENV_KEY], controller.stateFilePath);

			// Also test bare "dsh" command resolution via PATH (matching dsh-vscode-panel on macOS/Linux)
			const barePathSpec = sharedModule.resolveDshDirectSpawn(
				'dsh',
				['--profile', 'web', '--no-open'],
				{ ...process.env, PATH: `${tempDir}${path.delimiter}${process.env.PATH ?? ''}` },
				path.join(distDir, 'dshRolePreload.js'),
				controller.stateFilePath,
			);
			assert.ok(barePathSpec, 'Expected bare "dsh" command on PATH to rewrite to --require dshRolePreload.js');
			assert.strictEqual(barePathSpec.args[0], '--require');
			assert.strictEqual(barePathSpec.args[1], path.join(distDir, 'dshRolePreload.js'));

			// Also test macOS DeepSeek Harness shell wrapper resolution when bundle files exist
			const fakeAppContents = path.join(tempDir, 'DeepSeek Harness.app', 'Contents');
			const fakeElectron = path.join(fakeAppContents, 'MacOS', 'DeepSeek Harness');
			const fakeResources = path.join(fakeAppContents, 'Resources');
			const fakeDshBin = path.join(fakeResources, 'runtime', 'cli', 'bin', 'dsh');
			fs.mkdirSync(path.dirname(fakeElectron), { recursive: true });
			fs.mkdirSync(path.dirname(fakeDshBin), { recursive: true });
			fs.writeFileSync(fakeElectron, '', { mode: 0o755 });
			fs.writeFileSync(
				fakeDshBin,
				'#!/bin/sh\nresources=$(CDPATH= cd -- "$(dirname -- "$launcher")/../../.." && pwd -P)\nELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"\n',
				{ mode: 0o755 },
			);
			const appSpec = sharedModule.resolveDshDirectSpawn(
				fakeDshBin,
				['--profile', 'web', '--no-open'],
				undefined,
				path.join(distDir, 'dshRolePreload.js'),
				controller.stateFilePath,
			);
			assert.ok(appSpec, 'Expected DeepSeek Harness wrapper rewrite');
			assert.strictEqual(appSpec.command, fs.realpathSync(fakeElectron));
			assert.deepStrictEqual(appSpec.args.slice(0, 3), ['--require', path.join(distDir, 'dshRolePreload.js'), '--expose-internals']);
			assert.strictEqual(appSpec.env.ELECTRON_RUN_AS_NODE, '1');

			// Verify built dist/dshRolePreload.js inside a real Node subprocess for both Governor and pure Worker
			const runDshPreloadProbe = async (activeId: string, expectInjected: boolean) => {
				await controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: activeId, selectedAgentId: activeId });
				const dshPreloadCheck = cp.spawnSync(process.execPath, [
					'-e', `
						let seenBody;
						globalThis.fetch = async (_u, i) => { seenBody = JSON.parse(i.body); return new Response("{}"); };
						require(process.argv[1]);
						globalThis.fetch("https://api.deepseek.com/v1/chat/completions", {
							method: "POST",
							body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "你的身份?" }] }),
						}).then(() => {
							console.log(JSON.stringify(seenBody));
						}).catch(err => { console.error(err); process.exit(1); });
					`,
					path.join(distDir, 'dshRolePreload.js'),
				], { env: { ...process.env, [sharedModule.ROLE_STATE_ENV_KEY]: controller.stateFilePath }, encoding: 'utf8' });
				assert.strictEqual(dshPreloadCheck.status, 0, dshPreloadCheck.stderr);
				const payload = JSON.parse(dshPreloadCheck.stdout.trim()) as { messages: Array<{ role: string; content: string }> };
				if (expectInjected) {
					assert.strictEqual(payload.messages[0].role, 'system');
					assert.ok(payload.messages[0].content.includes('Role: Governor (DSH)'));
				} else {
					assert.strictEqual(payload.messages.length, 1);
					assert.strictEqual(payload.messages[0].role, 'user');
				}
			};
			await runDshPreloadProbe('dsh-gov', true);
			await controller.updateSnapshot({
				...controller.getSnapshot(),
				agents: [
					...controller.getSnapshot().agents,
					{ id: 'dsh-wrk', label: 'DSH Worker', projectPath: '/projects/Alpha', engineId: 'aexus-dsh', rank: 'worker', isOrchestrated: false },
				],
			});
			await runDshPreloadProbe('dsh-wrk', false);

			// 6. Antigravity agy --hub spawn + real dist/agyRoleHook.js execution (Governor initial -> repeat -> hot-swap -> pure Worker clean)
			(fakeCp.spawn as Function)('/Users/test/.gemini/bin/agy', ['--hub', '--app_data_dir=antigravity'], { cwd: '/projects/Alpha' });
			const agySpawn = spawns.at(-1)!;
			assert.ok(agySpawn.args.includes(`--add-dir=${controller.agyHooksWorkspaceDir}`));
			assert.ok(fs.existsSync(path.join(controller.agyHooksWorkspaceDir, '.agents', 'hooks.json')));

			await controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: 'agy-gov', selectedAgentId: 'agy-gov' });
			const runAgyHook = (conversationId: string) => {
				const res = cp.spawnSync(process.execPath, [path.join(distDir, 'agyRoleHook.js')], {
					input: JSON.stringify({ conversationId, cwd: '/projects/Alpha' }),
					env: { ...process.env, [sharedModule.ROLE_STATE_ENV_KEY]: controller.stateFilePath },
					encoding: 'utf8',
				});
				assert.strictEqual(res.status, 0, res.stderr);
				return JSON.parse(res.stdout) as { injectSteps?: Array<{ systemMessage?: { systemMessage?: string } }> };
			};

			// First turn for Governor injects systemMessage
			const turn1 = runAgyHook('conv-gov-1');
			assert.ok(turn1.injectSteps?.[0]?.systemMessage?.systemMessage?.includes('Role: Governor (AGY)'));
			assert.strictEqual((await controller.readAgyBindings())['conv-gov-1'], 'agy-gov');

			// Second turn with identical rolePrompt does NOT duplicate injection
			const turn2 = runAgyHook('conv-gov-1');
			assert.deepStrictEqual(turn2, {});

			// Hot-swap update triggers one updated injection
			await controller.updateSnapshot({
				...controller.getSnapshot(),
				agents: controller.getSnapshot().agents.map(a => a.id === 'agy-gov' ? { ...a, rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (AGY hot-swapped)' } : a),
			});
			const turn3 = runAgyHook('conv-gov-1');
			assert.ok(turn3.injectSteps?.[0]?.systemMessage?.systemMessage?.includes('AGY hot-swapped'));

			// Pure Worker conversation produces `{}` (zero injection)
			await controller.updateSnapshot({ ...controller.getSnapshot(), activeAgentId: 'agy-wrk', selectedAgentId: 'agy-wrk' });
			const workerTurn = runAgyHook('conv-wrk-1');
			assert.deepStrictEqual(workerTurn, {});
		} finally {
			controller.dispose();
		}
	});

	it('synchronizes snapshots and native bindings across primary and follower extension hosts', async () => {
		const bridgeDir = path.join(tempDir, 'cross-host-bridge');
		const scopeId = 'win-test-99';

		const primary = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir,
			scopeId,
			follower: false,
			childProcessModule: { spawn: (() => createMockChild()) as unknown as typeof cp.spawn },
			fetchHost: { fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch },
		});

		const followerFetchCalls: Array<{ url: string; body?: string }> = [];
		const followerFetchHost = {
			fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				const body = typeof init?.body === 'string' ? init.body : undefined;
				followerFetchCalls.push({ url, body });
				return new Response('{}', { status: 200 });
			}) as typeof globalThis.fetch,
		};
		const followerSpawns: string[][] = [];
		const followerCp = {
			spawn: ((_cmd: string, args: readonly string[] = []) => {
				followerSpawns.push([...args]);
				return createMockChild();
			}) as unknown as typeof cp.spawn,
		};

		const follower = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir,
			scopeId,
			follower: true,
			childProcessModule: followerCp,
			fetchHost: followerFetchHost,
		});

		try {
			await primary.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'kilo-cross',
				selectedAgentId: 'kilo-cross',
				agents: [
					{
						id: 'kilo-cross',
						label: 'Kilo Cross-Host Manager',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-kilo',
						resource: 'aexus-kilo:/cross-1',
						rank: 'manager',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Manager (Cross-Host)',
					},
					{
						id: 'claude-cross',
						label: 'Claude Cross-Host Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/cross-2',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (Cross-Host)',
					},
				],
			});

			// Follower fetch refreshes snapshot on POST and injects rolePrompt + records external binding
			await followerFetchHost.fetch('http://127.0.0.1:41999/session/ses_cross_kilo/prompt_async', {
				method: 'POST',
				body: JSON.stringify({ parts: [{ type: 'text', text: 'check subordinates' }] }),
			});
			const sentBody = JSON.parse(followerFetchCalls[0].body!) as { system?: string };
			assert.ok(sentBody.system?.includes('Role: Manager (Cross-Host)'));

			// Wait briefly for external binding write, then switch active agent to claude-cross
			await primary.updateSnapshot({
				...primary.getSnapshot(),
				activeAgentId: 'claude-cross',
				selectedAgentId: 'claude-cross',
			});
			// Follower picks up claude-cross synchronously on the very next millisecond (no 250ms wait!)
			(followerCp.spawn as Function)('/usr/local/bin/claude', ['--input-format', 'stream-json', '--output-format', 'stream-json'], { cwd: '/projects/Alpha' });
			assert.ok(followerSpawns.at(-1)!.includes('--append-system-prompt'));
			const externalBindings = await (async () => {
				for (let i = 0; i < 20; i++) {
					const items = await primary.readExternalNativeBindings();
					if (items.length > 0) { return items; }
					await new Promise(r => setTimeout(r, 25));
				}
				return primary.readExternalNativeBindings();
			})();
			assert.deepStrictEqual(externalBindings, [
				{ shortEngine: 'kilo', nativeSessionId: 'ses_cross_kilo', agentId: 'kilo-cross' },
			]);

			// Disposing follower preserves shared files; promoting works cleanly on a separate follower
			follower.dispose();
			assert.ok(fs.existsSync(primary.stateFilePath));

			const promotable = bridgeModule.createNativeRoleBridgeController({
				distDir,
				bridgeDir,
				scopeId: `${scopeId}-promote`,
				follower: true,
				childProcessModule: { spawn: (() => createMockChild()) as unknown as typeof cp.spawn },
				fetchHost: { fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch },
			});
			try {
				promotable.promoteToPrimary();
				await promotable.updateSnapshot({ mode: 'ade', agents: [] });
				assert.ok(fs.existsSync(promotable.stateFilePath));
			} finally {
				promotable.dispose();
			}
		} finally {
			follower.dispose();
			primary.dispose();
		}
	});

	it('proxies agy --hub --hub-port end-to-end for preserved HTML, StartCascade binding, WebSocket /connect-websocket role injection, binary Protobuf & JSON appendPromptSections, and clean Worker pass-through', async () => {
		const net = await import('node:net');
		const http = await import('node:http');

		const findFreePort = (): Promise<number> => new Promise((resolve, reject) => {
			const s = net.createServer();
			s.once('error', reject);
			s.listen(0, '127.0.0.1', () => {
				const p = (s.address() as net.AddressInfo).port;
				s.close(() => resolve(p));
			});
		});

		const targetPort = await findFreePort();
		let upstreamBoundPort = 0;
		const receivedSendBodies: Buffer[] = [];
		const expectedHtml = '<!doctype html><html><head><title>Antigravity</title></head><body>ok</body></html>';
		const wsUpstreamTexts: string[] = [];
		let resolveWsSend!: (text: string) => void;
		const wsSendReceived = new Promise<string>(resolve => { resolveWsSend = resolve; });
		let upstreamServer: http.Server | undefined;
		const upgradedSockets = new Set<import('node:stream').Duplex>();

		const fakeSpawn = ((_cmd: string, args: readonly string[] = []) => {
			const child = createMockChild();
			const hubArg = args.find(a => a.startsWith('--hub-port='));
			assert.ok(hubArg, 'Expected --hub-port=<upstreamPort> arg');
			upstreamBoundPort = Number(hubArg.slice('--hub-port='.length));
			assert.notStrictEqual(upstreamBoundPort, targetPort, 'Expected upstream port to differ from targetPort');

			const server = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on('data', c => chunks.push(Buffer.from(c)));
				req.on('end', () => {
					const body = Buffer.concat(chunks);
					if (req.url?.startsWith('/index.html') || req.url === '/' || req.url?.startsWith('/?') || req.url?.startsWith('/cascade')) {
						res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
						res.end(expectedHtml);
						return;
					}
					if (req.url?.endsWith('/StartCascade')) {
						res.writeHead(200, { 'content-type': 'application/json' });
						res.end(JSON.stringify({ cascadeId: 'cascade-gov-777' }));
						return;
					}
					if (req.url?.endsWith('/SendUserCascadeMessage')) {
						receivedSendBodies.push(body);
						res.writeHead(200, { 'content-type': 'application/proto' });
						res.end(Buffer.alloc(0));
						return;
					}
					res.writeHead(200);
					res.end('ok');
				});
			});
			server.on('upgrade', (req, socket) => {
				upgradedSockets.add(socket);
				socket.once('close', () => upgradedSockets.delete(socket));
				const upgradePath = (req.url ?? '/').split('?')[0];
				if (!upgradePath.endsWith('/connect-websocket')) {
					socket.destroy();
					return;
				}
				socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
				let pending = Buffer.alloc(0);
				socket.on('data', chunk => {
					pending = Buffer.concat([pending, Buffer.from(chunk)]);
					let parsed = tryParseWsFrame(pending);
					while (parsed) {
						pending = pending.subarray(parsed.consumed);
						const text = parsed.frame.payload.toString('utf8');
						wsUpstreamTexts.push(text);
						if (text.includes('/StartCascade')) {
							const streamId = (JSON.parse(text) as { streamId?: string }).streamId;
							const reply = JSON.stringify({ streamId, type: 'data', payload: { cascadeId: 'cascade-ws-777' } });
							socket.write(encodeRawWsFrame(0x1, true, Buffer.from(reply, 'utf8')));
						} else if (text.includes('/SendUserCascadeMessage')) {
							resolveWsSend(text);
						}
						parsed = tryParseWsFrame(pending);
					}
				});
			});
			server.listen(upstreamBoundPort, '127.0.0.1');
			upstreamServer = server;
			return child;
		}) as unknown as typeof cp.spawn;

		const cpHost = { spawn: fakeSpawn };
		const controller = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir: path.join(tempDir, 'agy-proxy-bridge'),
			scopeId: 'agy-proxy-1',
			childProcessModule: cpHost,
			fetchHost: { fetch: globalThis.fetch },
		});

		try {
			await controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'agy-gov-1',
				selectedAgentId: 'agy-gov-1',
				agents: [
					{
						id: 'agy-gov-1',
						label: 'Antigravity Gov',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-antigravity',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (Proxy Verified)',
					},
					{
						id: 'agy-wrk-1',
						label: 'Antigravity Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-antigravity',
						rank: 'worker',
						isOrchestrated: false,
					},
				],
			});

			// Wait 30ms so controller's ephemeral port pool has a probed port ready
			await new Promise(r => setTimeout(r, 30));
			(cpHost.spawn as unknown as Function)('/Users/test/.gemini/bin/agy', ['--hub', `--hub-port=${targetPort}`, '--app_data_dir=antigravity']);
			// Wait for proxy to detect upstream ready and bind targetPort
			const fetchHtml = async (pathname: string): Promise<string | undefined> => {
				try {
					const res = await fetch(`http://127.0.0.1:${targetPort}${pathname}?useWebSocket=true`);
					return res.ok ? res.text() : undefined;
				} catch {
					return undefined;
				}
			};
			let rootHtml: string | undefined;
			for (let i = 0; i < 40 && rootHtml === undefined; i++) {
				rootHtml = await fetchHtml('/');
				if (rootHtml === undefined) {
					await new Promise(r => setTimeout(r, 25));
				}
			}
			assert.strictEqual(rootHtml, expectedHtml, 'Expected GET / HTML to pass through untouched with useWebSocket=true intact');
			assert.strictEqual(rootHtml.includes('aexus-ade-agy-connect'), false, 'Expected no HTML script forcing useWebSocket=false');
			assert.strictEqual(await fetchHtml('/cascade'), expectedHtml, 'Expected GET /cascade HTML to pass through untouched');

			// StartCascade binds cascade-gov-777 -> agy-gov-1
			const startRes = await fetch(`http://127.0.0.1:${targetPort}/exa.language_server_pb.LanguageServerService/StartCascade`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			});
			assert.strictEqual(startRes.status, 200);

			// Binary Protobuf SendUserCascadeMessage for bound Governor injects appendPromptSections
			const encodeField1Str = (s: string) => {
				const b = Buffer.from(s, 'utf8');
				return Buffer.concat([Buffer.from([0x0a, b.length]), b]);
			};
			const origGovProto = encodeField1Str('cascade-gov-777');
			const sendGovRes = await fetch(`http://127.0.0.1:${targetPort}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
				method: 'POST',
				headers: { 'content-type': 'application/proto' },
				body: origGovProto,
			});
			assert.strictEqual(sendGovRes.status, 200);
			const receivedGov = receivedSendBodies.at(-1)!;
			assert.ok(receivedGov.length > origGovProto.length);
			assert.ok(receivedGov.toString('utf8').includes('aexus_ade_role_context'));
			assert.ok(receivedGov.toString('utf8').includes('Role: Governor (Proxy Verified)'));

			// Live HTTP Upgrade to /connect-websocket: proxy-observed StartCascade binds the cascade,
			// then the forwarded SendUserCascadeMessage frame is rewritten with the role prompt sections.
			const wsClient = net.createConnection({ host: '127.0.0.1', port: targetPort });
			try {
				let wsClientBuf = Buffer.alloc(0);
				let headersParsed = false;
				let resolveHeaders!: () => void;
				let resolveCascadeReply!: () => void;
				const headersReady = new Promise<void>(resolve => { resolveHeaders = resolve; });
				const cascadeReply = new Promise<void>(resolve => { resolveCascadeReply = resolve; });
				wsClient.on('data', chunk => {
					wsClientBuf = Buffer.concat([wsClientBuf, Buffer.from(chunk)]);
					if (!headersParsed) {
						const headerEnd = wsClientBuf.indexOf('\r\n\r\n');
						if (headerEnd < 0) {
							return;
						}
						assert.ok(wsClientBuf.subarray(0, headerEnd).toString('utf8').startsWith('HTTP/1.1 101'), 'Expected the proxy to relay the 101 Switching Protocols response');
						wsClientBuf = wsClientBuf.subarray(headerEnd + 4);
						headersParsed = true;
						resolveHeaders();
					}
					let parsed = tryParseWsFrame(wsClientBuf);
					while (parsed) {
						wsClientBuf = wsClientBuf.subarray(parsed.consumed);
						if (parsed.frame.payload.toString('utf8').includes('cascade-ws-777')) {
							resolveCascadeReply();
						}
						parsed = tryParseWsFrame(wsClientBuf);
					}
				});
				await new Promise<void>((resolve, reject) => {
					wsClient.once('connect', () => resolve());
					wsClient.once('error', reject);
				});
				wsClient.write('GET /connect-websocket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
				await headersReady;
				const wsMask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
				wsClient.write(encodeRawWsFrame(0x1, true, Buffer.from(JSON.stringify({
					type: 'start',
					streamId: 'stream-ws-start',
					procedure: '/exa.language_server_pb.LanguageServerService/StartCascade',
					payload: {},
				}), 'utf8'), wsMask));
				await cascadeReply;
				wsClient.write(encodeRawWsFrame(0x1, true, Buffer.from(JSON.stringify({
					type: 'start',
					streamId: 'stream-ws-send',
					procedure: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
					payload: { cascadeId: 'cascade-ws-777', items: [{ text: '你是谁' }] },
				}), 'utf8'), wsMask));
				const wsRewritten = JSON.parse(await wsSendReceived) as {
					payload: { cascadeId: string; items: Array<{ text: string }>; cascadeConfig: { plannerConfig: { promptSectionCustomizationConfig: { appendPromptSections: unknown[] } } } };
				};
				assert.strictEqual(wsRewritten.payload.cascadeId, 'cascade-ws-777');
				assert.deepStrictEqual(wsRewritten.payload.items, [{ text: '你是谁' }]);
				assert.deepStrictEqual(
					wsRewritten.payload.cascadeConfig.plannerConfig.promptSectionCustomizationConfig.appendPromptSections,
					[{ title: 'aexus_ade_role_context', content: '[Aexus Orchestrated Role Context]\n- Role: Governor (Proxy Verified)' }],
				);
				assert.strictEqual(wsUpstreamTexts.some(text => text.includes('/StartCascade')), true);
			} finally {
				wsClient.destroy();
			}

			// Switch active agent to pure Worker with a new cascadeId -> byte-for-byte untouched!
			await controller.updateSnapshot({
				...controller.getSnapshot(),
				activeAgentId: 'agy-wrk-1',
				selectedAgentId: 'agy-wrk-1',
			});
			const origWrkProto = encodeField1Str('cascade-wrk-999');
			const sendWrkRes = await fetch(`http://127.0.0.1:${targetPort}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
				method: 'POST',
				headers: { 'content-type': 'application/proto' },
				body: origWrkProto,
			});
			assert.strictEqual(sendWrkRes.status, 200);
			assert.deepStrictEqual(receivedSendBodies.at(-1), origWrkProto);
		} finally {
			controller.dispose();
			for (const s of upgradedSockets) {
				s.destroy();
			}
			upstreamServer?.closeAllConnections?.();
			await new Promise<void>(resolve => upstreamServer ? upstreamServer.close(() => resolve()) : resolve());
		}
	});

	it('handles Pi RPC --session binding & new_session reset, preserved SPA-route agy HTML, Codex inject_items error fallback, and split-pane Kilo/OpenCode rebinding', async () => {
		// 1. Pi spawned as a node script (--mode rpc --session) binds, re-injects after new_session, and clears for a pure Worker
		{
			const bridgeDir = path.join(tempDir, 'pi-rpc-bridge');
			const piSpawns: Array<{ command: string; args: string[]; child: MockChildProcess; stdinChunks: string[] }> = [];
			const piCp = {
				spawn: ((command: string, args: readonly string[] = []) => {
					const child = createMockChild();
					const stdinChunks: string[] = [];
					const origWrite = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
					child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
						stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
						return origWrite(chunk, ...rest);
					}) as typeof child.stdin.write;
					piSpawns.push({ command, args: [...args], child, stdinChunks });
					return child;
				}) as unknown as typeof cp.spawn,
			};
			const piBound: Array<{ engine: string; agentId: string; nativeId: string }> = [];
			const piController = bridgeModule.createNativeRoleBridgeController({
				distDir,
				bridgeDir,
				pid: 9004,
				childProcessModule: piCp,
				fetchHost: { fetch: globalThis.fetch },
				onNativeSessionBound: (engine, agentId, nativeId) => piBound.push({ engine, agentId, nativeId }),
			});

			try {
				await piController.updateSnapshot({
					mode: 'ade',
					activeAgentId: 'pi-gov-rpc',
					selectedAgentId: 'pi-gov-rpc',
					agents: [
						{
							id: 'pi-gov-rpc',
							label: 'Pi Governor',
							projectPath: '/projects/Alpha',
							engineId: 'aexus-pi',
							rank: 'governor',
							isOrchestrated: true,
							rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (Pi RPC)',
						},
						{
							id: 'pi-wrk-rpc',
							label: 'Pi Worker',
							projectPath: '/projects/Alpha',
							engineId: 'aexus-pi',
							rank: 'worker',
							isOrchestrated: false,
						},
					],
				});

				const piCli = '/Users/test/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
				(piCp.spawn as Function)('node', [piCli, '--mode', 'rpc', '--session', '/tmp/pi-sess.jsonl'], { cwd: '/projects/Alpha' });
				const piSpawn = piSpawns.at(-1)!;
				const piPromptIdx = piSpawn.args.indexOf('--append-system-prompt');
				assert.ok(piPromptIdx >= 0, 'Expected Pi RPC spawn to receive --append-system-prompt');
				assert.ok(piSpawn.args[piPromptIdx + 1].includes('Role: Governor (Pi RPC)'));
				assert.deepStrictEqual(piBound, [{ engine: 'pi', agentId: 'pi-gov-rpc', nativeId: '/tmp/pi-sess.jsonl' }]);

				const writePi = (pkt: Record<string, unknown>) => piSpawn.child.stdin.write(JSON.stringify(pkt) + '\n');

				// Initial turn already carries the role via --append-system-prompt, so no stdin rewrite.
				writePi({ type: 'prompt', message: '第一问' });
				assert.deepStrictEqual(JSON.parse(piSpawn.stdinChunks.at(-1)!.trim()), { type: 'prompt', message: '第一问' });

				// new_session drops the initial prompt and the next prompt re-injects the role.
				writePi({ type: 'new_session' });
				writePi({ type: 'prompt', message: '第二问' });
				const reinjected = JSON.parse(piSpawn.stdinChunks.at(-1)!.trim()) as { message: string };
				assert.ok(reinjected.message.startsWith('[Aexus Orchestrated Role Context Updated]'));
				assert.ok(reinjected.message.includes('Role: Governor (Pi RPC)'));
				assert.ok(reinjected.message.endsWith('第二问'));

				// Switching the active session to a pure Worker prepends the role-cleared notice.
				await piController.updateSnapshot({
					...piController.getSnapshot(),
					activeAgentId: 'pi-wrk-rpc',
					selectedAgentId: 'pi-wrk-rpc',
				});
				writePi({ type: 'prompt', message: '作为工人' });
				const cleared = JSON.parse(piSpawn.stdinChunks.at(-1)!.trim()) as { message: string };
				assert.ok(cleared.message.startsWith('[Aexus Role Cleared:'));
				assert.ok(cleared.message.endsWith('作为工人'));
			} finally {
				piController.dispose();
			}
		}

		// 2. Antigravity Hub proxy injects the connect script on non-root SPA routes, not just "/"
		{
			const net = await import('node:net');
			const http = await import('node:http');

			const findFreePort = (): Promise<number> => new Promise((resolve, reject) => {
				const s = net.createServer();
				s.once('error', reject);
				s.listen(0, '127.0.0.1', () => {
					const p = (s.address() as net.AddressInfo).port;
					s.close(() => resolve(p));
				});
			});

			const targetPort = await findFreePort();
			let upstreamBoundPort = 0;
			const expectedSpaHtml = '<!doctype html><html><head><title>Cascade</title></head><body><div id="root"></div></body></html>';
			let upstreamServer: http.Server | undefined;
		const upgradedSockets = new Set<import('node:stream').Duplex>();

			const agyCp = {
				spawn: ((_cmd: string, args: readonly string[] = []) => {
					const child = createMockChild();
					const hubArg = args.find(a => a.startsWith('--hub-port='));
					assert.ok(hubArg, 'Expected --hub-port=<upstreamPort> arg');
					upstreamBoundPort = Number(hubArg!.slice('--hub-port='.length));
					const server = http.createServer((req, res) => {
						if ((req.url ?? '').startsWith('/c/')) {
							res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
							res.end(expectedSpaHtml);
							return;
						}
						res.writeHead(200, { 'content-type': 'text/plain' });
						res.end('ok');
					});
					server.listen(upstreamBoundPort, '127.0.0.1');
					upstreamServer = server;
					return child;
				}) as unknown as typeof cp.spawn,
			};
			const agyController = bridgeModule.createNativeRoleBridgeController({
				distDir,
				bridgeDir: path.join(tempDir, 'agy-spa-proxy-bridge'),
				scopeId: 'agy-spa-proxy-1',
				childProcessModule: agyCp,
				fetchHost: { fetch: globalThis.fetch },
			});

			try {
				await agyController.updateSnapshot({ mode: 'ade', agents: [] });
				await new Promise(r => setTimeout(r, 30));
				(agyCp.spawn as Function)('/Users/test/.gemini/bin/agy', ['--hub', `--hub-port=${targetPort}`]);

				let spaHtml = '';
				for (let i = 0; i < 40; i++) {
					try {
						const res = await fetch(`http://127.0.0.1:${targetPort}/c/cascade-xyz?useWebSocket=true`);
						if (res.ok) {
							spaHtml = await res.text();
							break;
						}
					} catch {
						await new Promise(r => setTimeout(r, 25));
					}
				}
				assert.strictEqual(spaHtml, expectedSpaHtml, 'Expected SPA route HTML to pass through untouched with useWebSocket=true intact');
				assert.strictEqual(spaHtml.includes('aexus-ade-agy-connect'), false, 'Expected no HTML script forcing useWebSocket=false');
			} finally {
				agyController.dispose();
				upstreamServer?.closeAllConnections?.();
				await new Promise<void>(resolve => upstreamServer ? upstreamServer.close(() => resolve()) : resolve());
			}
		}

		// 3. Codex turn/start falls back to prefixing params.input when thread/inject_items errors
		{
			const bridgeDir = path.join(tempDir, 'codex-fallback-bridge');
			const sentToCodex: string[] = [];
			const codexCp = {
				spawn: (() => {
					const child = createMockChild();
					const origWrite = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
					child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
						const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
						for (const line of text.split('\n').filter(Boolean)) {
							sentToCodex.push(line);
							const pkt = JSON.parse(line) as { id?: string; method?: string };
							if (typeof pkt.id === 'string' && pkt.id.startsWith('__aexus_codex_inject_') && pkt.method === 'thread/inject_items') {
								// Reject the synthetic injection so the barrier must fall back to prefixing the turn input.
								setImmediate(() => {
									child.stdout.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: pkt.id, error: { code: -32601, message: 'Method not found' } }) + '\n'));
								});
							}
						}
						return origWrite(chunk, ...rest);
					}) as typeof child.stdin.write;
					return child;
				}) as unknown as typeof cp.spawn,
			};
			const codexController = bridgeModule.createNativeRoleBridgeController({
				distDir,
				bridgeDir,
				pid: 9005,
				childProcessModule: codexCp,
				fetchHost: { fetch: globalThis.fetch },
			});

			try {
				await codexController.updateSnapshot({
					mode: 'ade',
					activeAgentId: 'codex-gov-fallback',
					selectedAgentId: 'codex-gov-fallback',
					agents: [
						{
							id: 'codex-gov-fallback',
							label: 'Codex Governor',
							projectPath: '/projects/Alpha',
							engineId: 'aexus-codex',
							rank: 'governor',
							isOrchestrated: true,
							rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Governor (Fallback)',
						},
					],
				});

				const child = (codexCp.spawn as Function)('codex', ['app-server']) as MockChildProcess;
				child.stdin.write(JSON.stringify({
					jsonrpc: '2.0',
					id: 'turn-fallback',
					method: 'turn/start',
					params: { threadId: 'thr-fallback', cwd: '/projects/Alpha', input: [{ type: 'text', text: '你的身份?' }] },
				}) + '\n');

				await new Promise(r => setTimeout(r, 40));

				assert.deepStrictEqual(
					sentToCodex.map(line => (JSON.parse(line) as { method?: string }).method),
					['thread/inject_items', 'turn/start'],
				);
				const turn = JSON.parse(sentToCodex.at(-1)!) as { params: { input: Array<{ type: string; text: string }> } };
				assert.deepStrictEqual(turn.params.input, [
					{ type: 'text', text: '[Aexus Orchestrated Role Context]\n[Aexus Orchestrated Role Context]\n- Role: Governor (Fallback)' },
					{ type: 'text', text: '你的身份?' },
				]);
			} finally {
				codexController.dispose();
			}
		}

		// 4. Split-pane resolution: active Claude tab in Group 1, selected Pi/Kilo session in Group 2
		{
			const splitSnapshot: NonNullable<Parameters<typeof sharedModule.resolveActiveEngineAgent>[0]> = {
				mode: 'ade',
				activeAgentId: 'claude-group-1',
				selectedAgentId: 'pi-group-2',
				agents: [
					{ id: 'claude-group-1', label: 'Claude Tab', projectPath: '/projects/Alpha', engineId: 'aexus-claude', rank: 'governor', isOrchestrated: true, rolePrompt: 'Role G1' },
					{ id: 'pi-group-2', label: 'Pi Session', projectPath: '/projects/Alpha', engineId: 'aexus-pi', rank: 'governor', isOrchestrated: true, rolePrompt: 'Role Pi G2' },
					{ id: 'kilo-group-2', label: 'Kilo Session', projectPath: '/projects/Beta', engineId: 'aexus-kilo', rank: 'manager', isOrchestrated: true, rolePrompt: 'Role Kilo G2' },
				],
			};
			assert.strictEqual(sharedModule.resolveActiveEngineAgent(splitSnapshot, 'claude')?.id, 'claude-group-1');
			assert.strictEqual(sharedModule.resolveActiveEngineAgent(splitSnapshot, 'pi')?.id, 'pi-group-2');
			assert.strictEqual(sharedModule.resolveActiveEngineAgent(splitSnapshot, 'kilo')?.id, 'kilo-group-2');

			// Kilo/OpenCode re-bind when the native UI opens a brand new session ID
			const bridgeDir = path.join(tempDir, 'split-pane-rebind-bridge');
			const capturedFetch: Array<{ url: string; body?: string }> = [];
			const rebindFetchHost = {
				fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
					capturedFetch.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
					return new Response('{}', { status: 200 });
				}) as typeof globalThis.fetch,
			};
			const rebindBound: Array<{ engine: string; agentId: string; nativeId: string }> = [];
			const rebindController = bridgeModule.createNativeRoleBridgeController({
				distDir,
				bridgeDir,
				pid: 9006,
				childProcessModule: { spawn: (() => createMockChild()) as unknown as typeof cp.spawn },
				fetchHost: rebindFetchHost,
				onNativeSessionBound: (engine, agentId, nativeId) => rebindBound.push({ engine, agentId, nativeId }),
			});

			try {
				await rebindController.updateSnapshot({
					mode: 'ade',
					activeAgentId: 'claude-group-1',
					selectedAgentId: 'kilo-group-2',
					agents: [
						{ id: 'claude-group-1', label: 'Claude Tab', projectPath: '/projects/Alpha', engineId: 'aexus-claude', rank: 'governor', isOrchestrated: true, rolePrompt: 'Role G1' },
						{ id: 'kilo-group-2', label: 'Kilo Session', projectPath: '/projects/Alpha', engineId: 'aexus-kilo', nativeSessionId: 'ses_kilo_old', rank: 'manager', isOrchestrated: true, rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Manager (Kilo Group 2)' },
					],
				});
				await rebindFetchHost.fetch('http://127.0.0.1:41200/session/ses_kilo_new/prompt_async?directory=%2Fprojects%2FAlpha', {
					method: 'POST',
					body: JSON.stringify({ parts: [{ type: 'text', text: 'who are you' }] }),
				});
				assert.ok((JSON.parse(capturedFetch.at(-1)!.body!) as { system?: string }).system?.includes('Role: Manager (Kilo Group 2)'));

				// Drop the Kilo agents so OpenCode detection is unambiguous for the selected Group 2 tab.
				await rebindController.updateSnapshot({
					mode: 'ade',
					activeAgentId: 'claude-group-1',
					selectedAgentId: 'opencode-group-2',
					agents: [
						{ id: 'claude-group-1', label: 'Claude Tab', projectPath: '/projects/Alpha', engineId: 'aexus-claude', rank: 'governor', isOrchestrated: true, rolePrompt: 'Role G1' },
						{ id: 'opencode-group-2', label: 'OpenCode Session', projectPath: '/projects/Alpha', engineId: 'aexus-opencode', nativeSessionId: 'ses_oc_old', rank: 'employee', isOrchestrated: true, rolePrompt: '[Aexus Orchestrated Role Context]\n- Role: Employee (OpenCode Group 2)' },
					],
				});
				await rebindFetchHost.fetch('http://127.0.0.1:41201/session/ses_oc_new/prompt_async', {
					method: 'POST',
					body: JSON.stringify({ parts: [{ type: 'text', text: 'who are you' }] }),
				});
				assert.ok((JSON.parse(capturedFetch.at(-1)!.body!) as { system?: string }).system?.includes('Role: Employee (OpenCode Group 2)'));

				assert.deepStrictEqual(rebindBound, [
					{ engine: 'kilo', agentId: 'kilo-group-2', nativeId: 'ses_kilo_new' },
					{ engine: 'opencode', agentId: 'opencode-group-2', nativeId: 'ses_oc_new' },
				]);
			} finally {
				rebindController.dispose();
			}
		}
	});

	it('merges rolePrompt into Claude Code control_request initialize systemPrompt.append and appendSystemPrompt for orchestrated sessions while leaving pure Worker untouched', async () => {
		const bridgeDir = path.join(tempDir, 'claude-init-bridge');
		const govRole = '[Aexus Orchestrated Role Context]\n- Role: Governor (Init Merge)';
		const spawns: Array<{ args: string[]; child: MockChildProcess; stdinChunks: string[] }> = [];
		const spawnStub = ((_command: string, args: readonly string[] = []) => {
			const child = createMockChild();
			const stdinChunks: string[] = [];
			const origWrite = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
			child.stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
				stdinChunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
				return origWrite(chunk, ...rest);
			}) as typeof child.stdin.write;
			spawns.push({ args: [...args], child, stdinChunks });
			return child;
		}) as unknown as typeof cp.spawn;

		const fakeCp = { spawn: spawnStub };
		const controller = bridgeModule.createNativeRoleBridgeController({
			distDir,
			bridgeDir,
			pid: 9007,
			childProcessModule: fakeCp,
			fetchHost: { fetch: globalThis.fetch },
		});

		try {
			await controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'init-gov',
				selectedAgentId: 'init-gov',
				agents: [
					{
						id: 'init-gov',
						label: 'Init Governor',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/init-gov',
						rank: 'governor',
						isOrchestrated: true,
						rolePrompt: govRole,
					},
					{
						id: 'init-wrk',
						label: 'Init Worker',
						projectPath: '/projects/Alpha',
						engineId: 'aexus-claude',
						resource: 'aexus-claude:/init-wrk',
						rank: 'worker',
						isOrchestrated: false,
					},
				],
			});

			const spawnClaude = () => {
				(fakeCp.spawn as Function)('/usr/local/bin/claude', [
					'--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
				], { cwd: '/projects/Alpha' });
				return spawns.at(-1)!;
			};

			// Orchestrated session: the CLI-level prompt is appended at spawn time.
			const govSpawn = spawnClaude();
			assert.ok(govSpawn.args.includes('--append-system-prompt'));

			// 1. SDK initialize preset (`systemPrompt.append`) and adapter `appendSystemPrompt` both receive the role prompt.
			govSpawn.child.stdin.write(JSON.stringify({
				type: 'control_request',
				request_id: 'init-gov-1',
				request: {
					subtype: 'initialize',
					systemPrompt: { type: 'preset', preset: 'claude_code', append: 'CLI preset append' },
					appendSystemPrompt: 'SDK adapter append',
					hooks: { SessionStart: [] },
				},
			}) + '\n');
			assert.deepStrictEqual(JSON.parse(govSpawn.stdinChunks.at(-1)!.trim()), {
				type: 'control_request',
				request_id: 'init-gov-1',
				request: {
					subtype: 'initialize',
					systemPrompt: { type: 'preset', preset: 'claude_code', append: `CLI preset append\n\n${govRole}` },
					appendSystemPrompt: `SDK adapter append\n\n${govRole}`,
					hooks: { SessionStart: [] },
				},
			});

			// 2. Array-shaped `systemPrompt` gets the role prompt appended as an extra block, plus a synthesized `appendSystemPrompt`.
			govSpawn.child.stdin.write(JSON.stringify({
				type: 'control_request',
				request_id: 'init-gov-2',
				request: {
					subtype: 'initialize',
					systemPrompt: [{ type: 'text', text: 'preset block' }],
				},
			}) + '\n');
			assert.deepStrictEqual(JSON.parse(govSpawn.stdinChunks.at(-1)!.trim()), {
				type: 'control_request',
				request_id: 'init-gov-2',
				request: {
					subtype: 'initialize',
					systemPrompt: [{ type: 'text', text: 'preset block' }, govRole],
					appendSystemPrompt: govRole,
				},
			});

			// 3. Non-initialize control requests pass through byte-for-byte.
			const interruptLine = JSON.stringify({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }) + '\n';
			govSpawn.child.stdin.write(interruptLine);
			assert.strictEqual(govSpawn.stdinChunks.at(-1), interruptLine);

			// Pure Worker session: no spawn flag, no initialize rewrite, even when the SDK sends its own append prompts.
			await controller.updateSnapshot({
				mode: 'ade',
				activeAgentId: 'init-wrk',
				selectedAgentId: 'init-wrk',
				agents: controller.getSnapshot().agents,
			});
			const wrkSpawn = spawnClaude();
			assert.strictEqual(wrkSpawn.args.includes('--append-system-prompt'), false);
			const workerInitLine = JSON.stringify({
				type: 'control_request',
				request_id: 'init-wrk-1',
				request: {
					subtype: 'initialize',
					systemPrompt: { type: 'preset', preset: 'claude_code', append: 'worker preset append' },
					appendSystemPrompt: 'worker adapter append',
				},
			}) + '\n';
			wrkSpawn.child.stdin.write(workerInitLine);
			assert.strictEqual(wrkSpawn.stdinChunks.at(-1), workerInitLine);
		} finally {
			controller.dispose();
		}
	});

	it('binds StartCascade and injects rolePrompt into masked >125-byte Antigravity /connect-websocket SendUserCascadeMessage frames across split chunks and interleaved pings without mutating pure Worker frames', () => {
		const servicePrefix = '/exa.language_server_pb.LanguageServerService';
		const govRole = '[Aexus Orchestrated Role Context]\n- Role: Governor (WS Frames)';
		const agentByCascade = new Map<string, { readonly isOrchestrated: boolean; readonly rolePrompt?: string }>([
			['cascade-gov-ws', { isOrchestrated: true, rolePrompt: govRole }],
			['cascade-wrk-ws', { isOrchestrated: false }],
		]);
		const startCascadeStreams = new Set<string>();
		const startedCascades: string[] = [];
		const boundCascades: string[] = [];
		const clientOut: Buffer[] = [];
		const serverOut: Buffer[] = [];

		const serverObserver = sharedModule.createWsFrameTransformer({
			shouldDecodeText: () => startCascadeStreams.size > 0,
			onTextMessage: text => {
				sharedModule.observeAgyConnectWsServerMessage(text, startCascadeStreams, cascadeId => {
					startedCascades.push(cascadeId);
					boundCascades.push(cascadeId);
				});
				return undefined;
			},
			onChunkOut: out => serverOut.push(Buffer.from(out)),
		});
		const clientTransformer = sharedModule.createWsFrameTransformer({
			onTextMessage: text => sharedModule.transformAgyConnectWsClientMessage(text, startCascadeStreams, cascadeId => {
				const agent = cascadeId ? agentByCascade.get(cascadeId) : undefined;
				if (agent && cascadeId && !boundCascades.includes(cascadeId)) {
					boundCascades.push(cascadeId);
				}
				return agent;
			}),
			onChunkOut: out => clientOut.push(Buffer.from(out)),
		});

		const buildSendMessageJson = (cascadeId: string, text: string, cascadeConfig?: Record<string, unknown>) => JSON.stringify({
			type: 'start',
			streamId: `stream-send-${cascadeId}`,
			procedure: `${servicePrefix}/SendUserCascadeMessage`,
			payload: {
				cascadeId,
				items: [{ text }],
				...(cascadeConfig ? { cascadeConfig } : {}),
			},
		});
		const roleSection = { title: 'aexus_ade_role_context', content: govRole };

		// 1. StartCascade registers the client stream, and the server `data` frame binds the spawned cascadeId.
		const startCascadeFrame = sharedModule.encodeWsTextFrame(JSON.stringify({
			type: 'start',
			streamId: 'stream-gov-1',
			procedure: `${servicePrefix}/StartCascade`,
			payload: {},
		}), Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]));
		clientTransformer.push(startCascadeFrame);
		assert.deepStrictEqual([...startCascadeStreams], ['stream-gov-1']);
		const startCascadeOut = parseWsFrames(Buffer.concat(clientOut));
		assert.strictEqual(startCascadeOut.length, 1);
		assert.deepStrictEqual(startCascadeOut[0].raw, startCascadeFrame);

		clientOut.length = 0;
		serverObserver.push(sharedModule.encodeWsTextFrame(JSON.stringify({
			streamId: 'stream-gov-1',
			type: 'data',
			payload: { cascadeId: 'cascade-gov-ws' },
		})));
		assert.deepStrictEqual(startedCascades, ['cascade-gov-ws']);
		assert.deepStrictEqual(boundCascades, ['cascade-gov-ws']);
		assert.ok(serverOut.length > 0);
		serverObserver.push(sharedModule.encodeWsTextFrame(JSON.stringify({ streamId: 'stream-gov-1', type: 'end' })));
		assert.strictEqual(startCascadeStreams.size, 0);

		// 2. A single masked frame with a >125-byte payload (16-bit extended length) delivered across arbitrary byte splits.
		const govText = '每'.repeat(80);
		const govJson = buildSendMessageJson('cascade-gov-ws', govText);
		assert.ok(Buffer.byteLength(govJson, 'utf8') > 125);
		const govMask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
		const govFrame = sharedModule.encodeWsTextFrame(govJson, govMask);
		assert.strictEqual(govFrame[1] & 0x7f, 126, 'Expected a 16-bit extended payload length');
		clientTransformer.push(govFrame.subarray(0, 3));
		clientTransformer.push(govFrame.subarray(3, 11));
		clientTransformer.push(govFrame.subarray(11));

		const govOut = parseWsFrames(Buffer.concat(clientOut));
		assert.strictEqual(govOut.length, 1);
		assert.deepStrictEqual([govOut[0].fin, govOut[0].opcode, govOut[0].masked], [true, 0x1, true]);
		assert.notDeepStrictEqual(govOut[0].raw, govFrame, 'Expected the Governor frame to be rewritten');
		const govPacket = JSON.parse(govOut[0].payload.toString('utf8')) as {
			streamId: string;
			procedure: string;
			payload: { cascadeId: string; items: Array<{ text: string }>; cascadeConfig: { plannerConfig: { promptSectionCustomizationConfig: { appendPromptSections: unknown[] } } } };
		};
		assert.strictEqual(govPacket.procedure, `${servicePrefix}/SendUserCascadeMessage`);
		assert.strictEqual(govPacket.streamId, 'stream-send-cascade-gov-ws');
		assert.strictEqual(govPacket.payload.cascadeId, 'cascade-gov-ws');
		assert.strictEqual(govPacket.payload.items[0].text, govText);
		assert.deepStrictEqual(govPacket.payload.cascadeConfig.plannerConfig.promptSectionCustomizationConfig.appendPromptSections, [roleSection]);

		// 3. A fragmented masked message (each fragment >125 bytes) with a ping interleaved between fragments stays intact.
		clientOut.length = 0;
		const fragText = '分片消息'.repeat(40);
		const fragJson = buildSendMessageJson('cascade-gov-ws', fragText, {
			plannerConfig: {
				promptSectionCustomizationConfig: {
					appendPromptSections: [{ title: 'existing_section', content: 'keep existing' }],
				},
			},
		});
		const fragPayload = Buffer.from(fragJson, 'utf8');
		const fragSplit = 140;
		assert.ok(fragSplit > 125 && fragPayload.length - fragSplit > 125);
		const firstFragment = encodeRawWsFrame(0x1, false, fragPayload.subarray(0, fragSplit), Buffer.from([0x01, 0x02, 0x03, 0x04]));
		const pingFrame = encodeRawWsFrame(0x9, true, Buffer.from('keepalive'), Buffer.from([0x09, 0x08, 0x07, 0x06]));
		const lastFragment = encodeRawWsFrame(0x0, true, fragPayload.subarray(fragSplit), Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]));
		assert.strictEqual(firstFragment[1] & 0x7f, 126);
		clientTransformer.push(firstFragment.subarray(0, 5));
		clientTransformer.push(firstFragment.subarray(5));
		clientTransformer.push(pingFrame);
		clientTransformer.push(lastFragment.subarray(0, 7));
		clientTransformer.push(lastFragment.subarray(7));

		const fragOut = parseWsFrames(Buffer.concat(clientOut));
		assert.strictEqual(fragOut.length, 2);
		assert.deepStrictEqual([fragOut[0].fin, fragOut[0].opcode, fragOut[0].masked, fragOut[0].payload.toString('utf8')], [true, 0x9, true, 'keepalive']);
		assert.deepStrictEqual(fragOut[0].raw, pingFrame, 'Expected the interleaved ping to be forwarded untouched');
		assert.deepStrictEqual([fragOut[1].fin, fragOut[1].opcode], [true, 0x1]);
		const fragPacket = JSON.parse(fragOut[1].payload.toString('utf8')) as {
			payload: { items: Array<{ text: string }>; cascadeConfig: { plannerConfig: { promptSectionCustomizationConfig: { appendPromptSections: unknown[] } } } };
		};
		assert.strictEqual(fragPacket.payload.items[0].text, fragText);
		assert.deepStrictEqual(fragPacket.payload.cascadeConfig.plannerConfig.promptSectionCustomizationConfig.appendPromptSections, [
			{ title: 'existing_section', content: 'keep existing' },
			roleSection,
		]);

		// 4. Pure Worker frames are byte-for-byte identical even when split across chunks.
		clientOut.length = 0;
		const workerText = '工人'.repeat(100);
		const workerJson = buildSendMessageJson('cascade-wrk-ws', workerText);
		assert.ok(Buffer.byteLength(workerJson, 'utf8') > 125);
		const workerFrame = sharedModule.encodeWsTextFrame(workerJson, Buffer.from([0x55, 0x66, 0x77, 0x88]));
		clientTransformer.push(workerFrame.subarray(0, 1));
		clientTransformer.push(workerFrame.subarray(1, 2));
		clientTransformer.push(workerFrame.subarray(2));

		const workerOut = parseWsFrames(Buffer.concat(clientOut));
		assert.strictEqual(workerOut.length, 1);
		assert.deepStrictEqual(workerOut[0].raw, workerFrame, 'Expected the pure Worker frame to be untouched');
		assert.strictEqual(workerOut[0].payload.toString('utf8'), workerJson);
		assert.strictEqual(workerOut[0].payload.toString('utf8').includes('aexus_ade_role_context'), false);
	});
});
