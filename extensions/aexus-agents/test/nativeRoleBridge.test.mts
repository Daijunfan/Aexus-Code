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

	it('proxies agy --hub --hub-port end-to-end for HTML useWebSocket override, StartCascade binding, binary Protobuf & JSON appendPromptSections, and clean Worker pass-through', async () => {
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
		let upstreamServer: http.Server | undefined;

		const fakeSpawn = ((_cmd: string, args: readonly string[] = []) => {
			const child = createMockChild();
			const hubArg = args.find(a => a.startsWith('--hub-port='));
			assert.ok(hubArg, 'Expected --hub-port=<upstreamPort> arg');
			upstreamBoundPort = Number(hubArg.slice('--hub-port='.length));
			assert.notStrictEqual(upstreamBoundPort, targetPort, 'Expected upstream port to differ from targetPort');

			upstreamServer = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on('data', c => chunks.push(Buffer.from(c)));
				req.on('end', () => {
					const body = Buffer.concat(chunks);
					if (req.url?.startsWith('/index.html') || req.url === '/' || req.url?.startsWith('/?')) {
						res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
						res.end('<!doctype html><html><head><title>Antigravity</title></head><body>ok</body></html>');
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
			upstreamServer.listen(upstreamBoundPort, '127.0.0.1');
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
			let htmlText = '';
			for (let i = 0; i < 40; i++) {
				try {
					const res = await fetch(`http://127.0.0.1:${targetPort}/?useWebSocket=true`);
					if (res.ok) {
						htmlText = await res.text();
						break;
					}
				} catch {
					await new Promise(r => setTimeout(r, 25));
				}
			}
			assert.ok(htmlText.includes('id="aexus-ade-agy-connect"'), 'Expected HTML script overriding useWebSocket=true');

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
			await new Promise<void>(resolve => upstreamServer ? upstreamServer.close(() => resolve()) : resolve());
		}
	});
});
