/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADE_CLI_COMMANDS } from '../scripts/genAdeBins.mjs';
import {
	ADE_SAFE_CLI_COMMANDS,
	isSafeAdeCliBashCommand,
	registerSpawnedEngineChildForTracking,
	stopSpawnedEngineProcess,
} from '../src/engineAdapterHelpers.ts';
import { LiveTurnRunner } from '../src/liveTurnRunner.ts';
import {
	ADE_TICKET_MESSAGE_PREFIX_START,
	isAdeTicketDeliveryMessage,
} from '../src/ticketMessageFormat.ts';
import { SessionTurnCoordinator, type TurnCancellationHandle } from '../src/turnCoordinator.ts';
import {
	ADE_ANTIGRAVITY_ROUTING_RULE_MD,
	ADE_STATIC_AGENTS_ROUTER_MD,
	ADE_SYSPROMPT_MODULE_DOCS,
} from '../../../src/vs/platform/ade/common/adeSyspromptCatalog.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..', '..');

class SimpleTestCts implements TurnCancellationHandle {
	private _cancelled = false;
	private readonly listeners = new Set<() => void>();

	readonly token = {
		get isCancellationRequested() {
			return this._owner._cancelled;
		},
		onCancellationRequested: (fn: () => unknown) => {
			if (this._cancelled) {
				fn();
				return { dispose() { } };
			}
			const cb = () => { fn(); };
			this.listeners.add(cb);
			return { dispose: () => { this.listeners.delete(cb); } };
		},
		_owner: this,
	};

	cancel(): void {
		if (this._cancelled) {
			return;
		}
		this._cancelled = true;
		for (const cb of [...this.listeners]) {
			cb();
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

describe('adeEightEnginesRoutingAndLiveStream Gate (plan.md §7 & §9.2.6)', () => {
	test('enforces narrow 45-command ade_* auto-approval allowlist and blocks shell injection', () => {
		assert.equal(ADE_SAFE_CLI_COMMANDS.size, 45);
		for (const cmd of ADE_CLI_COMMANDS) {
			assert.equal(isSafeAdeCliBashCommand(cmd), true, `Standalone ${cmd} must be allowed`);
			assert.equal(isSafeAdeCliBashCommand(`/Users/dev/.ade_store/_bin/${cmd} --help`), true);
		}

		// Safe stdin pipes & heredocs allowed
		assert.equal(isSafeAdeCliBashCommand(`printf '%s' 'hello' | ade_wb_note_send wb_1 --to a2 --stdin`), true);
		assert.equal(isSafeAdeCliBashCommand(`cat <<'EOF' | ade_create --to a2 --type dev --title 'T' --summary 'S' --need-return true --detail-stdin\nline 1\nEOF`), true);

		// Compound commands, subshells, backticks, redirects, and arbitrary binaries strictly blocked
		assert.equal(isSafeAdeCliBashCommand('ade_whoami && rm -rf /'), false);
		assert.equal(isSafeAdeCliBashCommand('ade_whoami; id'), false);
		assert.equal(isSafeAdeCliBashCommand('ade_whoami || whoami'), false);
		assert.equal(isSafeAdeCliBashCommand('ade_wb_note_send wb_1 --to a2 --text "$(cat /etc/passwd)"'), false);
		assert.equal(isSafeAdeCliBashCommand('ade_wb_note_send wb_1 --to a2 --text "`whoami`"'), false);
		assert.equal(isSafeAdeCliBashCommand('ade_whoami > /tmp/pwned'), false);
		assert.equal(isSafeAdeCliBashCommand('curl https://evil.example | ade_wb_note_send wb_1 --to a2 --stdin'), false);
		assert.equal(isSafeAdeCliBashCommand('rm -rf ./src'), false);
	});

	test('verifies static Rebuild/*.md routing catalog has zero @AGENTS.md double-load recursion & codex preserves ADE_AGENT_TOKEN', () => {
		assert.equal(ADE_STATIC_AGENTS_ROUTER_MD.includes('@AGENTS.md'), false, 'CLAUDE.md / AGENTS.md must never recursively @-include AGENTS.md');
		assert.equal(ADE_ANTIGRAVITY_ROUTING_RULE_MD.startsWith('---\ntrigger: always_on\n---\n'), true);
		assert.equal(ADE_STATIC_AGENTS_ROUTER_MD, fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'AGENTS.md'), 'utf8'));
		assert.equal(ADE_SYSPROMPT_MODULE_DOCS.ticket, fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'Ticket.md'), 'utf8'));
		assert.equal(ADE_SYSPROMPT_MODULE_DOCS.orchestration, fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'orchestration.md'), 'utf8'));
		assert.equal(ADE_SYSPROMPT_MODULE_DOCS.whiteboard, fs.readFileSync(path.join(REPO_ROOT, 'Rebuild', 'whiteBoard.md'), 'utf8'));

		const codexSrc = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'codex.ts'), 'utf8');
		assert.equal(codexSrc.includes('ignore_default_excludes: true'), true, 'codex.ts must set ignore_default_excludes: true so *TOKEN* is never stripped');

		// Verify zero legacy prompt/bridge strings across extension sources
		const forbidden = [
			['compileAde', 'RolePrompt'].join(''),
			['AEXUS_SYSTEM_', 'TOKEN_ENVELOPE'].join(''),
			['dshRole', 'Preload'].join(''),
			['extHostRole', 'Preload'].join(''),
			['agyRole', 'Hook'].join(''),
			['nativeRole', 'Bridge'].join(''),
			['--append-system-', 'prompt'].join(''),
			['aexus-', 'secretary'].join(''),
			['aexus-', 'ade'].join(''),
		];
		for (const f of fs.readdirSync(path.join(EXTENSION_ROOT, 'src'))) {
			if (!f.endsWith('.ts')) {
				continue;
			}
			const content = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', f), 'utf8');
			for (const bad of forbidden) {
				assert.equal(content.includes(bad), false, `extensions/aexus-agents/src/${f} must not contain legacy token ${bad}`);
			}
		}
	});

	test('physically separates interruptTurn (killTree: false, preserving child sub-processes) vs disposeAgentRuntime (killTree: true)', { skip: process.platform === 'win32' }, async () => {
		const spawnParentWithSubtask = async () => {
			const parent = cp.spawn(
				process.execPath,
				['-e', 'const cp = require("child_process"); const sub = cp.spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" }); console.log(sub.pid); setInterval(()=>{}, 1000);'],
				{ detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
			);
			const subPid = await new Promise<number>((resolve, reject) => {
				parent.stdout.setEncoding('utf8');
				parent.stdout.once('data', line => resolve(Number.parseInt(String(line).trim(), 10)));
				parent.once('error', reject);
			});
			return { parent, subPid };
		};

		const isPidAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		const case1 = await spawnParentWithSubtask();
		try {
			stopSpawnedEngineProcess(case1.parent, 'SIGTERM', { killTree: false });
			await new Promise<void>(r => case1.parent.once('close', () => r()));
			assert.equal(isPidAlive(case1.subPid), true, 'killTree: false must preserve child background task');
		} finally {
			try { process.kill(case1.subPid, 'SIGKILL'); } catch { /* ignore */ }
		}

		const case2 = await spawnParentWithSubtask();
		try {
			stopSpawnedEngineProcess(case2.parent, 'SIGKILL', { killTree: true });
			await new Promise<void>(r => case2.parent.once('close', () => r()));
			await new Promise<void>(r => setTimeout(r, 80));
			assert.equal(isPidAlive(case2.subPid), false, 'killTree: true must terminate entire process group');
		} finally {
			try { process.kill(case2.subPid, 'SIGKILL'); } catch { /* ignore */ }
		}
	});

	test('enforces 3-tier SessionTurnCoordinator priority (human_ui > ticket_steer > ticket_queue) without dropping queued items', async () => {
		const coord = new SessionTurnCoordinator<SimpleTestCts>();
		const key = 'ade:proj_1:agent_l2';
		const order: string[] = [];
		let interruptedCount = 0;

		const lease1 = (await coord.acquire({
			key,
			source: 'headless',
			createCts: () => new SimpleTestCts(),
			interruptActive: async () => {
				interruptedCount++;
				coord.release(lease1);
			},
			ticketId: 'tk_1',
			taskId: 'tsk_1',
		}))!;
		order.push('start:q1');

		const pQ2 = coord.acquire({
			key,
			source: 'headless',
			createCts: () => new SimpleTestCts(),
			ticketId: 'tk_2',
			taskId: 'tsk_2',
		}).then(l => {
			if (l) {
				order.push('run:q2');
				coord.release(l);
			}
		});

		const pQ3 = coord.acquire({
			key,
			source: 'headless',
			createCts: () => new SimpleTestCts(),
			ticketId: 'tk_3',
			taskId: 'tsk_3',
		}).then(l => {
			if (l) {
				order.push('run:q3');
				coord.release(l);
			}
		});

		await new Promise<void>(r => setTimeout(r, 15));
		assert.equal(coord.getQueuedHeadlessCount(key), 2);

		const evicted = await coord.cancelTicketTurns(key, ['tk_2']);
		assert.equal(evicted, 1);

		const leaseSteer = (await coord.acquire({
			key,
			source: 'headless',
			preemptActive: true,
			createCts: () => new SimpleTestCts(),
			ticketId: 'tk_steer',
			taskId: 'tsk_s',
		}))!;
		order.push('run:steer');
		coord.release(leaseSteer);

		await Promise.all([pQ2, pQ3]);
		assert.equal(interruptedCount, 1);
		assert.deepEqual(order, ['start:q1', 'run:steer', 'run:q3']);
	});

	test('replays buffered chunks immediately and streams live chunks seamlessly via LiveTurnRunner (Path B 60fps)', async () => {
		const runner = new LiveTurnRunner('prompt_envelope');
		runner.push({ kind: 'thinking', text: 'analyzing...', id: 'th_1' });
		runner.push({ kind: 'markdown', text: 'Hello ' });

		const received: string[] = [];
		const cts = new SimpleTestCts();
		const attachPromise = runner.attach(chunk => {
			if (chunk.kind === 'thinking') {
				received.push(`[think:${chunk.text}]`);
			} else if (chunk.kind === 'markdown') {
				received.push(chunk.text);
			}
		}, cts.token);

		assert.deepEqual(received, ['[think:analyzing...]', 'Hello ']);

		runner.push({ kind: 'markdown', text: 'world!' });
		runner.complete();
		await attachPromise;

		assert.deepEqual(received, ['[think:analyzing...]', 'Hello ', 'world!']);
		assert.equal(runner.settled, true);
	});
});

interface BundledWorkbenchModules {
	readonly URI: {
		parse(value: string): unknown;
		revive(value: unknown): unknown;
	};
	readonly CancellationToken: {
		readonly None: {
			readonly isCancellationRequested: boolean;
			onCancellationRequested(listener: () => void): { dispose(): void };
		};
	};
	readonly CancellationTokenSource: new () => {
		readonly token: {
			readonly isCancellationRequested: boolean;
			onCancellationRequested(listener: () => void): { dispose(): void };
		};
		cancel(): void;
		dispose(): void;
	};
	readonly DeferredPromise: new <T>() => {
		readonly p: Promise<T>;
		complete(value: T): void;
		error(err: unknown): void;
	};
	readonly DisposableStore: new () => {
		add<T extends { dispose(): void }>(item: T): T;
		dispose(): void;
	};
	readonly DisposableResourceMap: new () => {
		get(key: unknown): unknown;
		set(key: unknown, value: unknown): void;
		has(key: unknown): boolean;
		deleteAndDispose(key: unknown): void;
		dispose(): void;
	};
	readonly ResourceMap: new () => Map<unknown, unknown>;
	readonly Emitter: new <T>() => {
		readonly event: (listener: (e: T) => void) => { dispose(): void };
		fire(event: T): void;
		dispose(): void;
	};
	readonly observableValue: <T>(owner: unknown, initialValue: T) => {
		get(): T;
		set(value: T, tx: undefined): void;
		read(reader: unknown): T;
	};
	readonly ChatAgentLocation: { readonly Chat: unknown };
	readonly ResponseModelState: { readonly Complete: number; readonly Cancelled: number; readonly Failed: number };
	readonly ObservableChatSession: new (
		resource: unknown,
		providerHandle: number,
		proxy: Record<string, (...args: unknown[]) => unknown>,
		logService: Record<string, (...args: unknown[]) => void>,
		dialogService: Record<string, (...args: unknown[]) => unknown>,
	) => {
		readonly sessionResource: unknown;
		readonly progressObs: { get(): ReadonlyArray<Record<string, unknown>>; read(reader: unknown): ReadonlyArray<Record<string, unknown>> };
		readonly isCompleteObs: { get(): boolean; read(reader: unknown): boolean };
		interruptActiveResponseCallback?: () => Promise<boolean>;
		requestHandler?: (
			request: Record<string, unknown>,
			progress: (chunks: ReadonlyArray<Record<string, unknown>>) => void,
			history: unknown[],
			token: unknown,
		) => Promise<void>;
		initialize(token: unknown, context: Record<string, unknown>): Promise<void>;
		handleProgressChunk(requestId: string, progress: ReadonlyArray<Record<string, unknown>>): void;
		handleProgressComplete(requestId: string): void;
		handleHistoryChanged(history: readonly unknown[]): void;
		dispose(): void;
	};
	readonly ExtHostChatSessions: new (
		commands: Record<string, unknown>,
		languageModels: Record<string, unknown>,
		extHostRpc: Record<string, unknown>,
		logService: Record<string, (...args: unknown[]) => void>,
	) => {
		registerChatSessionContentProvider(
			extension: Record<string, unknown>,
			chatSessionScheme: string,
			chatParticipant: unknown,
			provider: Record<string, unknown>,
			capabilities?: { supportsInterruptions?: boolean },
		): { dispose(): void };
		$provideChatSessionContent(
			handle: number,
			sessionResource: unknown,
			context: Record<string, unknown>,
			token: unknown,
		): Promise<Record<string, unknown>>;
		$interruptChatSessionActiveResponse(providerHandle: number, sessionResource: unknown, requestId: string): Promise<void>;
		$disposeChatSessionContent(providerHandle: number, sessionResource: unknown): Promise<void>;
		$invokeChatSessionRequestHandler(
			handle: number,
			sessionResource: unknown,
			request: Record<string, unknown>,
			history: unknown[],
			token: unknown,
		): Promise<Record<string, unknown>>;
		dispose(): void;
	};
	readonly extHostTypes: {
		readonly ChatRequestTurn: new (...args: unknown[]) => unknown;
		readonly ChatResponseTurn2: new (
			response: readonly unknown[],
			result: Record<string, unknown>,
			participant: string,
			command?: string,
		) => unknown;
		readonly ChatResponseMarkdownPart: new (value: string | { value: string }) => unknown;
		readonly MarkdownString: new (value?: string) => { value: string };
	};
	readonly RemoteChatSessionRestorer: new (
		options: {
			readonly model: unknown;
			readonly session: unknown;
			readonly chatSessionType: string;
			readonly parsePrompt: (text: string) => { text: string; parts: unknown[] };
			readonly publishModel: (restoredModel: unknown) => { object: unknown; dispose(): void };
			readonly token: unknown;
		},
		scheduler: undefined,
		chatAgentService: { getAgent(id: string): unknown },
		logService: Record<string, (...args: unknown[]) => void>,
	) => {
		readonly hasUnappliedServerRequests: boolean;
		restore(): Promise<{
			readonly reference: { object: unknown; dispose(): void };
			readonly lastRequest: {
				readonly id: string;
				readonly chunks: string[];
				readonly response: { readonly isComplete: boolean; readonly isCanceled: boolean };
			} | undefined;
			readonly lastResponseCompletedAt: number | undefined;
			readonly lastResponseCanceled: boolean;
		}>;
		scheduleHistoryRefresh(): Promise<void>;
		setServerRequestHandler(handler: unknown): void;
		dispose(): void;
	};
	readonly ChatService: {
		readonly prototype: {
			trackRemoteSession: (
				model: unknown,
				providedSession: unknown,
				restorer: unknown,
				restored: unknown,
				parsePrompt: unknown,
			) => void;
		};
	};
	readonly IAdeControlCenterService: unknown;
	readonly IChatService: unknown;
	readonly AdeOpenChatTicketScheduler: new () => {
		dispatchTicket(
			input: {
				readonly sessionUri: unknown;
				readonly payloadText: string;
				readonly deliveryMode: 'steer' | 'queue';
				readonly projectId?: string;
				readonly agentId?: string;
				readonly ticketId?: string;
				readonly taskId?: string;
			},
			chatService: unknown,
			controlCenter?: unknown,
		): Promise<{
			readonly accepted: boolean;
			readonly ok?: boolean;
			readonly stopped?: boolean;
			readonly abortedByWindowDispose?: boolean;
			readonly error?: string;
		}>;
		getQueuedCount(projectId: string, agentId: string): number;
		cancelTickets(projectId: string, ticketIds: readonly string[], chatService?: unknown): Promise<number>;
		abortForWindowDispose(): void;
	};
	readonly AdeOutboxBridgeContribution: new (
		commandService: { executeCommand(id: string, ...args: unknown[]): Promise<unknown> },
		instantiationService: { invokeFunction<R>(fn: (accessor: { get(id: unknown): unknown }) => R): R },
	) => {
		readonly scheduler: {
			dispatchTicket(input: Record<string, unknown>, chatService: unknown, controlCenter?: unknown): Promise<Record<string, unknown>>;
			getQueuedCount(projectId: string, agentId: string): number;
		};
		pumpOutbox(): Promise<void>;
		flushOutboxForTest(): Promise<void>;
		dispose(): void;
	};
	readonly isAdeOpenChatTicketPrompt: (text: string | undefined) => boolean;
}

let cachedWorkbenchBundlePromise: Promise<{ mod: BundledWorkbenchModules; cleanup: () => void }> | undefined;

function loadBundledWorkbenchModules(): Promise<{ mod: BundledWorkbenchModules; cleanup: () => void }> {
	if (!cachedWorkbenchBundlePromise) {
		cachedWorkbenchBundlePromise = (async () => {
			const esbuild = await import('esbuild');
			const tmpBundlePath = path.join(os.tmpdir(), `ade-track-b-wb-${process.pid}-${Date.now()}.mjs`);
			await esbuild.build({
				stdin: {
					contents: `
						export { URI } from '../../src/vs/base/common/uri.ts';
						export { CancellationToken, CancellationTokenSource } from '../../src/vs/base/common/cancellation.ts';
						export { DeferredPromise } from '../../src/vs/base/common/async.ts';
						export { Emitter } from '../../src/vs/base/common/event.ts';
						export { DisposableStore, DisposableResourceMap } from '../../src/vs/base/common/lifecycle.ts';
						export { ResourceMap } from '../../src/vs/base/common/map.ts';
						export { observableValue } from '../../src/vs/base/common/observable.ts';
						export { ChatAgentLocation, ResponseModelState } from '../../src/vs/workbench/contrib/chat/common/constants.ts';
						export { ObservableChatSession } from '../../src/vs/workbench/api/browser/mainThreadChatSessions.ts';
						export { ExtHostChatSessions } from '../../src/vs/workbench/api/common/extHostChatSessions.ts';
						export * as extHostTypes from '../../src/vs/workbench/api/common/extHostTypes.ts';
						export { RemoteChatSessionRestorer } from '../../src/vs/workbench/contrib/chat/common/chatService/remoteChatSessionRestorer.ts';
						export { ChatService } from '../../src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts';
						export { IAdeControlCenterService } from '../../src/vs/platform/ade/common/adeControlCenterIpc.ts';
						export { IChatService } from '../../src/vs/workbench/contrib/chat/common/chatService/chatService.ts';
						export {
							AdeOpenChatTicketScheduler,
							AdeOutboxBridgeContribution,
							isAdeOpenChatTicketPrompt,
						} from '../../src/vs/workbench/contrib/ade/browser/adeControlHandler.ts';
					`,
					resolveDir: EXTENSION_ROOT,
					loader: 'ts',
				},
				banner: {
					js: `
						if (typeof globalThis.window === 'undefined') {
							const noop = () => {};
							globalThis.HTMLElement ??= class HTMLElement {};
							globalThis.Element ??= globalThis.HTMLElement;
							globalThis.Node ??= class Node {};
							globalThis.MutationObserver ??= class { observe() {} disconnect() {} };
							globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
							globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
							globalThis.customElements ??= { define: noop, get: () => undefined };
							const matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
							globalThis.window = Object.assign(globalThis, {
								vscodeWindowId: 1,
								addEventListener: noop,
								removeEventListener: noop,
								matchMedia,
								customElements: globalThis.customElements,
								location: { href: 'vscode-file://vscode-app/', origin: 'vscode-file://vscode-app', protocol: 'vscode-file:' },
								setTimeout: globalThis.setTimeout.bind(globalThis),
								clearTimeout: globalThis.clearTimeout.bind(globalThis),
								setInterval: globalThis.setInterval.bind(globalThis),
								clearInterval: globalThis.clearInterval.bind(globalThis),
								requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
								cancelAnimationFrame: (id) => clearTimeout(id),
							});
							globalThis.self = globalThis.window;
							globalThis.document = {
								createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop }),
								createElementNS: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
								createTextNode: () => ({}),
								createDocumentFragment: () => ({ appendChild: noop }),
								addEventListener: noop,
								removeEventListener: noop,
								body: { appendChild: noop, classList: { add: noop, remove: noop } },
								head: { appendChild: noop },
								documentElement: { style: {} },
								querySelectorAll: () => [],
								getElementById: () => null,
							};
						}
					`,
				},
				bundle: true,
				outfile: tmpBundlePath,
				platform: 'node',
				format: 'esm',
				loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty' },
			});
			const mod = (await import(pathToFileURL(tmpBundlePath).href)) as unknown as BundledWorkbenchModules;
			process.once('exit', () => {
				try { fs.rmSync(tmpBundlePath, { force: true }); } catch { /* ignore */ }
			});
			return {
				mod,
				cleanup: () => {
					try { fs.rmSync(tmpBundlePath, { force: true }); } catch { /* ignore */ }
				},
			};
		})();
	}
	return cachedWorkbenchBundlePromise;
}

describe('Track B P1 Regression Gate (plan.md §5 & §7)', () => {
	test('[P1-1] dist/engineProcess.js preserves same-PGID background grandchildren across normal turn exit & killTree:false interruption, and reaps PGID on killTree:true', { skip: process.platform === 'win32' }, async () => {
		const distEngineProcess = path.join(EXTENSION_ROOT, 'dist', 'engineProcess.js');
		assert.equal(fs.existsSync(distEngineProcess), true, 'Compiled dist/engineProcess.js must exist');

		// Verify adapter single-turn cancel contracts in claude.ts and pi.ts
		const claudeSrc = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'claude.ts'), 'utf8');
		assert.equal(
			claudeSrc.includes(`stopEngine(child, 'SIGKILL', { killTree: false })`),
			true,
			'claude.ts cancellation catch fallback must pass { killTree: false }',
		);
		assert.equal(
			/stopEngine\(\s*child\s*,\s*'SIGKILL'\s*\)/.test(claudeSrc),
			false,
			'claude.ts must never omit { killTree: false } on single-turn SIGKILL fallback',
		);

		const piSrc = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'pi.ts'), 'utf8');
		const remoteKillTrueMatches = piSrc.match(/terminateRemotePersistentSession\([^)]*killTree:\s*true/g) ?? [];
		assert.equal(
			remoteKillTrueMatches.length,
			2,
			'pi.ts must pass { killTree: true } ONLY inside killSession() and dispose(), never on single-turn cancellations',
		);

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-dist-engine-pgid-'));
		const grandScript = path.join(tmpDir, 'bg-worker.cjs');
		fs.writeFileSync(grandScript, [
			`'use strict';`,
			`const fs = require('node:fs');`,
			`// Ignore SIGINT if terminal ever broadcasts, while remaining in the exact same POSIX PGID as inner CLI`,
			`process.on('SIGINT', () => {});`,
			`const tmp = process.argv[2] + '.tmp';`,
			`fs.writeFileSync(tmp, String(process.pid));`,
			`fs.renameSync(tmp, process.argv[2]);`,
			`setTimeout(() => process.exit(0), 15000).unref();`,
			`setInterval(() => {}, 1000);`,
		].join('\n'));

		const isAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		const waitForPid = async (pidFile: string): Promise<number> => {
			const deadline = Date.now() + 4_000;
			while (Date.now() < deadline) {
				if (fs.existsSync(pidFile)) {
					const parsed = Number(fs.readFileSync(pidFile, 'utf8').trim());
					if (Number.isInteger(parsed) && parsed > 0) {
						return parsed;
					}
				}
				await new Promise<void>(r => setTimeout(r, 20));
			}
			throw new Error(`Timed out waiting for PID file: ${pidFile}`);
		};

		const spawnViaDistWrapper = (innerCliPath: string, args: string[]) => {
			const wrapper = cp.spawn(
				process.execPath,
				[distEngineProcess, process.execPath, innerCliPath, ...args],
				{ detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
			);
			registerSpawnedEngineChildForTracking(wrapper);
			return wrapper;
		};

		try {
			// Case 1: Normal turn completion (exit 0) -> same-PGID grandchild MUST survive
			const normalInner = path.join(tmpDir, 'normal-turn.cjs');
			const normalGrandPidFile = path.join(tmpDir, 'normal-grand.pid');
			fs.writeFileSync(normalInner, [
				`'use strict';`,
				`const cp = require('node:child_process');`,
				`const fs = require('node:fs');`,
				`// Non-detached spawn: shares PGID with inner CLI!`,
				`cp.spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });`,
				`const poll = setInterval(() => {`,
				`  if (fs.existsSync(process.argv[3])) { clearInterval(poll); process.exit(0); }`,
				`}, 15);`,
			].join('\n'));

			let normalGrandPid = 0;
			try {
				const w1 = spawnViaDistWrapper(normalInner, [grandScript, normalGrandPidFile]);
				const w1ExitPromise = new Promise<number | null>(r => {
					if (w1.exitCode !== null) {
						r(w1.exitCode);
					} else {
						w1.once('exit', code => r(code));
					}
				});
				normalGrandPid = await waitForPid(normalGrandPidFile);
				const exitCode = await w1ExitPromise;
				await new Promise<void>(r => setTimeout(r, 80));
				assert.equal(exitCode, 0);
				assert.equal(isAlive(normalGrandPid), true, 'Background grandchild in same PGID must survive normal CLI turn completion');
			} finally {
				if (normalGrandPid > 0) {
					try { process.kill(normalGrandPid, 'SIGKILL'); } catch { /* ignore */ }
				}
			}

			// Case 2: Single-turn interruption (killTree: false) -> inner CLI exits, same-PGID grandchild MUST survive
			const interruptInner = path.join(tmpDir, 'interrupt-turn.cjs');
			const interruptInnerPidFile = path.join(tmpDir, 'interrupt-inner.pid');
			const interruptGrandPidFile = path.join(tmpDir, 'interrupt-grand.pid');
			fs.writeFileSync(interruptInner, [
				`'use strict';`,
				`const cp = require('node:child_process');`,
				`const fs = require('node:fs');`,
				`fs.writeFileSync(process.argv[2], String(process.pid));`,
				`cp.spawn(process.execPath, [process.argv[3], process.argv[4]], { stdio: 'ignore' });`,
				`process.on('SIGINT', () => process.exit(130));`,
				`setInterval(() => {}, 1000);`,
			].join('\n'));

			let interruptGrandPid = 0;
			try {
				const w2 = spawnViaDistWrapper(interruptInner, [interruptInnerPidFile, grandScript, interruptGrandPidFile]);
				const innerPid = await waitForPid(interruptInnerPidFile);
				interruptGrandPid = await waitForPid(interruptGrandPidFile);
				assert.equal(isAlive(innerPid), true);
				assert.equal(isAlive(interruptGrandPid), true);

				const w2ExitPromise = new Promise<void>(r => {
					if (w2.exitCode !== null || w2.signalCode !== null) {
						r();
					} else {
						w2.once('exit', () => r());
					}
				});
				stopSpawnedEngineProcess(w2, 'SIGINT', { killTree: false });
				await w2ExitPromise;
				await new Promise<void>(r => setTimeout(r, 80));
				assert.equal(isAlive(innerPid), false, 'Inner CLI must exit on single-turn SIGINT');
				assert.equal(isAlive(interruptGrandPid), true, 'Background grandchild in same PGID must survive killTree: false single-turn interruption');
			} finally {
				if (interruptGrandPid > 0) {
					try { process.kill(interruptGrandPid, 'SIGKILL'); } catch { /* ignore */ }
				}
			}

			// Case 3: Session destruction (killTree: true) -> entire PGID including grandchild MUST be terminated
			const destroyInnerPidFile = path.join(tmpDir, 'destroy-inner.pid');
			const destroyGrandPidFile = path.join(tmpDir, 'destroy-grand.pid');
			let destroyGrandPid = 0;
			try {
				const w3 = spawnViaDistWrapper(interruptInner, [destroyInnerPidFile, grandScript, destroyGrandPidFile]);
				const destroyInnerPid = await waitForPid(destroyInnerPidFile);
				destroyGrandPid = await waitForPid(destroyGrandPidFile);

				stopSpawnedEngineProcess(w3, 'SIGTERM', { killTree: true });
				await new Promise<void>(r => w3.once('exit', () => r()));
				const deadline = Date.now() + 2_000;
				while ((isAlive(destroyInnerPid) || isAlive(destroyGrandPid)) && Date.now() < deadline) {
					await new Promise<void>(r => setTimeout(r, 25));
				}
				assert.equal(isAlive(destroyInnerPid), false, 'Inner CLI must be terminated on killTree: true');
				assert.equal(isAlive(destroyGrandPid), false, 'Same-PGID background grandchild must be reaped on killTree: true');
			} finally {
				if (destroyGrandPid > 0) {
					try { process.kill(destroyGrandPid, 'SIGKILL'); } catch { /* ignore */ }
				}
			}
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	const createRpcSessionTestEnv = (wb: BundledWorkbenchModules) => {
		const noopLog = {
			_serviceBrand: undefined,
			onDidChangeLogLevel: () => ({ dispose() { } }),
			getLevel: () => 0,
			setLevel: () => { },
			trace: () => { },
			debug: () => { },
			info: () => { },
			warn: () => { },
			error: () => { },
			flush: () => { },
		};
		const noopDialog = {
			_serviceBrand: undefined,
			confirm: async () => ({ confirmed: true }),
		};

		const createRpcSessionRig = () => {
			const mainSessions = new Map<string, ReturnType<typeof createObservable>>();
			let registeredHandle = -1;

			const mainThreadProxy = {
				$registerChatSessionItemController: () => { },
				$unregisterChatSessionItemController: () => { },
				$updateChatSessionItemControllerCapabilities: () => { },
				$addOrUpdateChatSessionItem: async () => { },
				$onDidChangeChatSessionInputState: () => { },
				$registerChatSessionContentProvider: (handle: number) => {
					registeredHandle = handle;
				},
				$unregisterChatSessionContentProvider: () => { },
				$onDidChangeChatSessionOptions: () => { },
				$onDidChangeChatSessionProviderOptions: () => { },
				$handleProgressChunk: async (_handle: number, resource: unknown, requestId: string, chunks: ReadonlyArray<Record<string, unknown>>) => {
					const revived = wb.URI.revive(resource) as { toString(): string };
					const sess = mainSessions.get(revived.toString());
					const normalized = chunks.map(c => (typeof c === 'object' && c !== null && Object.hasOwn(c, 'kind') ? c : { kind: 'markdownContent', content: c }));
					sess?.handleProgressChunk(requestId, normalized);
				},
				$handleProgressComplete: (_handle: number, resource: unknown, requestId: string) => {
					const revived = wb.URI.revive(resource) as { toString(): string };
					mainSessions.get(revived.toString())?.handleProgressComplete(requestId);
				},
				$handleAnchorResolve: () => { },
				$handleHistoryChanged: (_handle: number, resource: unknown, history: readonly unknown[]) => {
					const revived = wb.URI.revive(resource) as { toString(): string };
					mainSessions.get(revived.toString())?.handleHistoryChanged(history);
				},
			};

			const extHostSessions = new wb.ExtHostChatSessions(
				{
					registerArgumentProcessor: () => { },
					converter: {
						toInternal: (cmd: unknown) => cmd,
						fromInternal: (cmd: unknown) => cmd,
					},
				},
				{
					getDefaultLanguageModel: async () => undefined,
					getLanguageModelForRequest: async () => undefined,
				},
				{
					_serviceBrand: undefined,
					getProxy: () => mainThreadProxy,
					set: () => undefined,
					dispose: () => { },
					assertRegistered: () => { },
					drain: async () => { },
				},
				noopLog,
			);

			const createObservable = (
				uri: unknown,
				hooks?: { beforeResolveProvideContent?: () => Promise<void> },
			) => {
				const proxyToExtHost = {
					$provideChatSessionContent: async (h: number, r: unknown, ctx: Record<string, unknown>, tok: unknown) => {
						const dto = await extHostSessions.$provideChatSessionContent(h, r, ctx, tok);
						if (hooks?.beforeResolveProvideContent) {
							await hooks.beforeResolveProvideContent();
						}
						return dto;
					},
					$interruptChatSessionActiveResponse: (h: number, r: unknown, reqId: string) =>
						extHostSessions.$interruptChatSessionActiveResponse(h, r, reqId),
					$disposeChatSessionContent: (h: number, r: unknown) =>
						extHostSessions.$disposeChatSessionContent(h, r),
					$invokeChatSessionRequestHandler: (h: number, r: unknown, req: Record<string, unknown>, hist: unknown[], tok: unknown) =>
						extHostSessions.$invokeChatSessionRequestHandler(h, r, req, hist, tok),
				};
				const obs = new wb.ObservableChatSession(uri, registeredHandle, proxyToExtHost, noopLog, noopDialog);
				mainSessions.set((uri as { toString(): string }).toString(), obs);
				return obs;
			};

			const createTrackRemoteHarness = (sessionUri: unknown, opts?: { startEmpty?: boolean }) => {
				const pendingRequests = new wb.DisposableResourceMap();
				const syntheticPendingRequests = new WeakSet<object>();
				const remoteSessionRestorers = new wb.ResourceMap();
				const sessionModels = new wb.ResourceMap();
				const onDidDisposeEmitter = new wb.Emitter<void>();
				const onDidChangePendingEmitter = new wb.Emitter<void>();

				type TestBubble = {
					readonly id: string;
					readonly promptText: string;
					readonly chunks: string[];
					readonly response: {
						readonly isComplete: boolean;
						readonly isCanceled: boolean;
						readonly isIncomplete: { get(): boolean; read(reader: unknown): boolean };
						readonly response: { readonly value: readonly string[] };
						reopen(): void;
						complete(): void;
						completeWithoutTimestamp(): void;
						cancel(): void;
						cancelWithoutTimestamp(): void;
						setResult(): void;
						setElapsedMs(): void;
					};
				};

				const requests: TestBubble[] = [];
				const hasActiveRequest = wb.observableValue('hasActiveRequest', false);
				const syncActiveState = () => {
					hasActiveRequest.set(requests.some(r => !r.response.isComplete), undefined);
				};

				let autoBubbleSeq = 0;
				const createBubble = (id?: string, promptText = ''): TestBubble => {
					const resolvedId = id ?? `req_auto_${++autoBubbleSeq}`;
					const chunks: string[] = [];
					let isComplete = false;
					let isCanceled = false;
					const isIncomplete = wb.observableValue(`incomplete:${resolvedId}`, true);
					return {
						id: resolvedId,
						promptText,
						chunks,
						response: {
							get isComplete() { return isComplete; },
							get isCanceled() { return isCanceled; },
							isIncomplete,
							response: {
								get value() { return chunks; },
							},
							reopen: () => {
								if (!isComplete) {
									return;
								}
								chunks.length = 0;
								isComplete = false;
								isCanceled = false;
								isIncomplete.set(true, undefined);
								syncActiveState();
							},
							complete: () => {
								if (isComplete) {
									return;
								}
								isComplete = true;
								isIncomplete.set(false, undefined);
								syncActiveState();
							},
							completeWithoutTimestamp: () => {
								if (isComplete) {
									return;
								}
								isComplete = true;
								isIncomplete.set(false, undefined);
								syncActiveState();
							},
							cancel: () => {
								isCanceled = true;
								isComplete = true;
								isIncomplete.set(false, undefined);
								syncActiveState();
							},
							cancelWithoutTimestamp: () => {
								isCanceled = true;
								isComplete = true;
								isIncomplete.set(false, undefined);
								syncActiveState();
							},
							setResult: () => { },
							setElapsedMs: () => { },
						},
					};
				};

				const turn1Bubble = createBubble('turn_1_path_b', 'Ticket Turn 1');
				if (!opts?.startEmpty) {
					requests.push(turn1Bubble);
					syncActiveState();
				}

				const model = {
					sessionResource: sessionUri,
					hasActiveRequest,
					onDidDispose: onDidDisposeEmitter.event,
					onDidChangePendingRequests: onDidChangePendingEmitter.event,
					getPendingRequests: () => [],
					getRequests: () => requests,
					get lastRequest() { return requests.at(-1); },
					addRequest: (parsedReq: { text?: string } | string, ...rest: unknown[]) => {
						const text = typeof parsedReq === 'string' ? parsedReq : (parsedReq?.text ?? '');
						const explicitId = typeof rest[11] === 'string' ? rest[11] : undefined;
						const insertion = rest[23] as { readonly index: number; readonly replace?: boolean } | undefined;
						const bubble = createBubble(explicitId, text);
						const idx = insertion?.index ?? requests.length;
						requests.splice(idx, insertion?.replace ? 1 : 0, bubble);
						syncActiveState();
						return bubble;
					},
					removeRequest: (id: string) => {
						const idx = requests.findIndex(r => r.id === id);
						if (idx >= 0) {
							requests.splice(idx, 1);
							syncActiveState();
						}
					},
					acceptResponseProgress: (targetReq: TestBubble, progress: Record<string, unknown>) => {
						if (targetReq.response.isComplete) {
							throw new Error('acceptResponseProgress: Adding progress to a completed response');
						}
						const content = progress.content as { value?: string } | string | undefined;
						const val = typeof content === 'string' ? content : (content?.value ?? '');
						targetReq.chunks.push(val);
					},
				};
				sessionModels.set(sessionUri, model);

				const fakeChatServiceCtx = {
					_remoteSessionRestorers: remoteSessionRestorers,
					_pendingRequests: pendingRequests,
					_syntheticPendingRequests: syntheticPendingRequests,
					_sessionModels: sessionModels,
					instantiationService: {
						createInstance: (Ctor: new (...a: unknown[]) => unknown, ...args: unknown[]) =>
							new Ctor(...args, { cancelToolCallsForRequest: () => { } }),
					},
					telemetryService: { publicLog2: () => { } },
					agentHostConnectionsService: { resolveSessionResourceIdentity: () => undefined },
					chatAgentService: { getAgent: () => undefined },
					_isServerManagedQueue: () => false,
					processPendingRequests: () => { },
					processNextPendingRequest: () => { },
				};

				const parsePrompt = (text: string) => ({ text, parts: [] });

				const attachModel = (obs: ReturnType<typeof createObservable>) => {
					wb.ChatService.prototype.trackRemoteSession.call(
						fakeChatServiceCtx,
						model,
						obs,
						{
							hasUnappliedServerRequests: false,
							scheduleHistoryRefresh: async () => { },
							setServerRequestHandler: () => { },
						},
						{
							lastRequest: turn1Bubble,
							lastResponseCompletedAt: undefined,
							lastResponseCanceled: false,
						},
						parsePrompt,
					);
				};

				const restoreAndTrackWithRealRestorer = async (
					obs: ReturnType<typeof createObservable>,
					hooks?: { beforeTrackRemoteSession?: (restored: Awaited<ReturnType<InstanceType<BundledWorkbenchModules['RemoteChatSessionRestorer']>['restore']>>) => Promise<void> },
				) => {
					const restorer = new wb.RemoteChatSessionRestorer(
						{
							model,
							session: obs,
							chatSessionType: 'aexus-claude',
							parsePrompt,
							publishModel: restoredModel => ({ object: restoredModel, dispose: () => { } }),
							token: wb.CancellationToken.None,
						},
						undefined,
						{ getAgent: () => undefined },
						noopLog,
					);
					const restored = await restorer.restore();
					if (hooks?.beforeTrackRemoteSession) {
						await hooks.beforeTrackRemoteSession(restored);
					}
					wb.ChatService.prototype.trackRemoteSession.call(
						fakeChatServiceCtx,
						model,
						obs,
						restorer,
						restored,
						parsePrompt,
					);
					return { restorer, restored };
				};

				return {
					model,
					requests,
					hasActiveRequest,
					pendingRequests,
					syntheticPendingRequests,
					turn1Bubble,
					createBubble,
					onDidDisposeEmitter,
					attachModel,
					restoreAndTrackWithRealRestorer,
				};
			};

			return {
				extHostSessions,
				getHandle: () => registeredHandle,
				createObservable,
				createTrackRemoteHarness,
			};
		};

		const extensionDesc = {
			identifier: { value: 'aexus.aexus-agents', _lower: 'aexus.aexus-agents' },
			name: 'aexus-agents',
			version: '2.0.0',
			publisher: 'aexus',
			isBuiltin: true,
			isUserBuiltin: false,
			isUnderDevelopment: false,
			extensionLocation: wb.URI.parse('file:///ext'),
			targetPlatform: 'undefined',
			enabledApiProposals: ['chatSessionsProvider'],
		};

		return { createRpcSessionRig, extensionDesc };
	};

	test('[P1-2] Path B -> Path A handoff across ObservableChatSession + ExtHostChatSessions + ChatService.trackRemoteSession: zero Turn 2/3 deadlock, zero bubble corruption, UI Stop aborts CLI vs Tab Close preserves CLI', async () => {
		const { mod: wb } = await loadBundledWorkbenchModules();
		const { createRpcSessionRig, extensionDesc } = createRpcSessionTestEnv(wb);

		// --- Sub-case A: Path B active -> open panel -> Path B completes -> Human Turn 2 & Turn 3 via Path A ---
		{
			const rig = createRpcSessionRig();
			let activeLiveTurn: LiveTurnRunner<{ value: string }> | undefined = new LiveTurnRunner('Ticket Turn 1');
			activeLiveTurn.push({ kind: 'markdown', text: 'PathB-buffered ' });

			let pathATurnIndex = 0;
			rig.extHostSessions.registerChatSessionContentProvider(
				extensionDesc,
				'aexus-claude',
				{},
				{
					provideChatSessionContent: async () => ({
						title: 'Backend L2',
						options: {},
						history: [new wb.extHostTypes.ChatRequestTurn('Ticket Turn 1', undefined, [], 'aexus-claude', [], undefined, 'req_1', undefined, undefined, false)],
						...(activeLiveTurn ? {
							activeResponseCallback: async (stream: { markdown(v: string): void }, attachToken: { isCancellationRequested: boolean; onCancellationRequested(fn: () => unknown): { dispose(): void } }) => {
								await activeLiveTurn!.attach(chunk => {
									if (chunk.kind === 'markdown') {
										stream.markdown(chunk.text);
									}
								}, attachToken);
							},
							interruptActiveResponse: () => activeLiveTurn!.interrupt(),
						} : {}),
						requestHandler: async (
							req: { prompt: string },
							_ctx: unknown,
							stream: { markdown(v: string): void },
						) => {
							pathATurnIndex++;
							stream.markdown(`PathA-turn${pathATurnIndex}-a(${req.prompt}) `);
							await new Promise<void>(r => setTimeout(r, 10));
							stream.markdown(`PathA-turn${pathATurnIndex}-b`);
							return {};
						},
					}),
				},
				{ supportsInterruptions: true },
			);

			const sessionUri = wb.URI.parse('aexus-claude:///ade__proj1__l2');
			const obs = rig.createObservable(sessionUri);
			const harness = rig.createTrackRemoteHarness(sessionUri);

			await obs.initialize(wb.CancellationToken.None, {});
			harness.attachModel(obs);

			assert.equal(obs.isCompleteObs.get(), false, 'Path B ongoing stream keeps isCompleteObs false while running');
			assert.equal(typeof obs.interruptActiveResponseCallback, 'function');
			assert.equal(harness.pendingRequests.has(sessionUri), true, 'Synthetic tracker registered while Path B streams');

			// Stream live Path B chunk and complete Path B
			activeLiveTurn.push({ kind: 'markdown', text: 'PathB-live!' });
			activeLiveTurn.complete();
			activeLiveTurn = undefined;
			await new Promise<void>(r => setTimeout(r, 20));

			assert.equal(obs.isCompleteObs.get(), true, 'Path B completion must converge isCompleteObs to true');
			assert.equal(typeof obs.interruptActiveResponseCallback, 'function', 'interruptActiveResponseCallback must stay mounted across Path B completion');
			assert.equal(await obs.interruptActiveResponseCallback!(), true, 'Settled interruptActiveResponseCallback must idempotently return true');
			assert.equal(harness.pendingRequests.has(sessionUri), false, 'Synthetic pending request must be cleared on Path B completion');
			assert.equal(harness.turn1Bubble.chunks.join(''), 'PathB-buffered PathB-live!');
			assert.equal(harness.turn1Bubble.response.isComplete, true);

			// Execute Human Turn 2 and Turn 3 via Path A (`requestHandler`) on the SAME open panel!
			const runPathATurn = async (reqId: string, prompt: string): Promise<string> => {
				assert.equal(harness.pendingRequests.has(sessionUri), false, `Session must not be locked before ${reqId}`);
				const realCts = new wb.CancellationTokenSource();
				const realPending = {
					requestId: reqId,
					cancellationTokenSource: realCts,
					dispose: () => realCts.dispose(),
				};
				harness.pendingRequests.set(sessionUri, realPending);
				const turnChunks: string[] = [];
				try {
					await obs.requestHandler!(
						{
							sessionResource: sessionUri,
							requestId: reqId,
							agentId: 'aexus-claude',
							message: prompt,
							variables: { variables: [] },
							location: wb.ChatAgentLocation.Chat,
						},
						parts => {
							for (const p of parts) {
								const c = p.content as { value?: string } | string | undefined;
								turnChunks.push(typeof c === 'string' ? c : (c?.value ?? ''));
							}
						},
						[],
						realCts.token,
					);
				} finally {
					harness.pendingRequests.deleteAndDispose(sessionUri);
				}
				assert.equal(obs.isCompleteObs.get(), true, `${reqId} must mark _isCompleteObservable true instead of deadlocking`);
				assert.equal(harness.pendingRequests.has(sessionUri), false, `No synthetic tracker may re-inject during or after ${reqId}`);
				return turnChunks.join('');
			};

			const turn2Out = await runPathATurn('req_human_2', 'hello-2');
			const turn3Out = await runPathATurn('req_human_3', 'hello-3');

			assert.equal(turn2Out, 'PathA-turn1-a(hello-2) PathA-turn1-b');
			assert.equal(turn3Out, 'PathA-turn2-a(hello-3) PathA-turn2-b');
			assert.equal(
				harness.turn1Bubble.chunks.join(''),
				'PathB-buffered PathB-live!',
				'Turn 2 and Turn 3 Path A chunks MUST NEVER corrupt or append into historical Turn 1 bubble',
			);

			obs.dispose();
			rig.extHostSessions.dispose();
		}

		// --- Sub-case B & C: UI Stop ($interruptChatSessionActiveResponse) aborts CLI vs Tab Close ($disposeChatSessionContent) preserves CLI ---
		{
			const rig = createRpcSessionRig();
			let currentLiveTurn!: LiveTurnRunner<{ value: string }>;

			rig.extHostSessions.registerChatSessionContentProvider(
				extensionDesc,
				'aexus-claude',
				{},
				{
					provideChatSessionContent: async () => ({
						title: 'Worker L3',
						options: {},
						history: [],
						activeResponseCallback: async (stream: { markdown(v: string): void }, attachToken: { isCancellationRequested: boolean; onCancellationRequested(fn: () => unknown): { dispose(): void } }) => {
							await currentLiveTurn.attach(chunk => {
								if (chunk.kind === 'markdown') {
									stream.markdown(chunk.text);
								}
							}, attachToken);
						},
						interruptActiveResponse: () => currentLiveTurn.interrupt(),
						requestHandler: async () => ({}),
					}),
				},
				{ supportsInterruptions: true },
			);

			// Sub-case B: Clicking UI Stop genuinely interrupts underlying CLI turn
			let stopInterruptCalls = 0;
			const stopTurnCts = new SimpleTestCts();
			currentLiveTurn = new LiveTurnRunner('Long Ticket B', Date.now(), async () => {
				stopInterruptCalls++;
				stopTurnCts.cancel();
			});
			currentLiveTurn.push({ kind: 'markdown', text: 'working...' });

			const stopUri = wb.URI.parse('aexus-claude:///ade__proj1__stop_case');
			const obsStop = rig.createObservable(stopUri);
			await obsStop.initialize(wb.CancellationToken.None, {});
			assert.equal(typeof obsStop.interruptActiveResponseCallback, 'function');

			const confirmed = await obsStop.interruptActiveResponseCallback!();
			await new Promise<void>(r => setTimeout(r, 20));
			assert.equal(confirmed, true);
			assert.equal(currentLiveTurn.interrupted, true, 'Clicking UI Stop must mark LiveTurnRunner interrupted');
			assert.equal(stopTurnCts.token.isCancellationRequested, true, 'Clicking UI Stop must cancel underlying CLI turn token');
			assert.equal(stopInterruptCalls, 1, 'Clicking UI Stop must invoke engine interruptTurn callback');
			assert.equal(obsStop.isCompleteObs.get(), true);
			obsStop.dispose();

			// Sub-case C: Closing editor tab detaches UI mirror ONLY while background CLI continues to completion
			let closeInterruptCalls = 0;
			const closeTurnCts = new SimpleTestCts();
			currentLiveTurn = new LiveTurnRunner('Background Ticket C', Date.now(), async () => {
				closeInterruptCalls++;
				closeTurnCts.cancel();
			});
			currentLiveTurn.push({ kind: 'markdown', text: 'phase-1 ' });

			const closeUri = wb.URI.parse('aexus-claude:///ade__proj1__close_case');
			const obsClose = rig.createObservable(closeUri);
			const closeHarness = rig.createTrackRemoteHarness(closeUri);
			await obsClose.initialize(wb.CancellationToken.None, {});
			closeHarness.attachModel(obsClose);
			assert.equal(closeHarness.turn1Bubble.chunks.join(''), 'phase-1 ');
			assert.equal(closeHarness.pendingRequests.has(closeUri), true);

			// Simulate closing the editor tab (`ChatModel` disposes + `ObservableChatSession` disposes)
			closeHarness.onDidDisposeEmitter.fire();
			obsClose.dispose();
			await new Promise<void>(r => setTimeout(r, 20));

			assert.equal(closeHarness.pendingRequests.has(closeUri), false, 'Closing tab must clean up synthetic pending request without leaking lock');
			assert.equal(currentLiveTurn.interrupted, false, 'Closing editor tab MUST NOT interrupt background LiveTurnRunner');
			assert.equal(closeTurnCts.token.isCancellationRequested, false, 'Closing editor tab MUST NOT cancel background CLI token');
			assert.equal(closeInterruptCalls, 0, 'Closing editor tab MUST NOT invoke engine interruptTurn');

			// Background CLI continues streaming and completes cleanly
			currentLiveTurn.push({ kind: 'markdown', text: 'phase-2-after-tab-closed' });
			currentLiveTurn.complete();
			assert.equal(currentLiveTurn.settled, true);
			assert.equal(currentLiveTurn.bufferedParts.length, 2);

			rig.extHostSessions.dispose();
		}
	});

	test('[P1-4] Race Window A (pre-_doInitializeContent completion) & Race Window B (post-restore pre-trackRemoteSession completion) + Turn 2 Path A follow-up without empty bubble or deadlock', async () => {
		const { mod: wb } = await loadBundledWorkbenchModules();
		const { createRpcSessionRig, extensionDesc } = createRpcSessionTestEnv(wb);

		// --- Sub-case D (Race Window A): $handleProgressChunk + $handleProgressComplete('ongoing') arrive BEFORE _doInitializeContent finishes ---
		{
			const rig = createRpcSessionRig();
			let interruptCalls = 0;
			let activeLiveTurn: LiveTurnRunner<{ value: string }> | undefined = new LiveTurnRunner(
				'Race Window A Prompt',
				Date.now(),
				async () => { interruptCalls++; },
			);
			activeLiveTurn.push({ kind: 'markdown', text: 'RaceA-buffered-1 ' });
			activeLiveTurn.push({ kind: 'markdown', text: 'RaceA-buffered-2 ' });

			let pathATurnCount = 0;
			rig.extHostSessions.registerChatSessionContentProvider(
				extensionDesc,
				'aexus-claude',
				{},
				{
					provideChatSessionContent: async () => ({
						title: 'Race A Worker',
						options: {},
						history: [
							new wb.extHostTypes.ChatRequestTurn('Race Window A Prompt', undefined, [], 'aexus-claude', [], undefined, 'req_race_a_1', undefined, undefined, false),
						],
						...(activeLiveTurn ? {
							activeResponseCallback: async (stream: { markdown(v: string): void }, attachToken: { isCancellationRequested: boolean; onCancellationRequested(fn: () => unknown): { dispose(): void } }) => {
								await activeLiveTurn!.attach(chunk => {
									if (chunk.kind === 'markdown') {
										stream.markdown(chunk.text);
									}
								}, attachToken);
							},
							interruptActiveResponse: () => activeLiveTurn!.interrupt(),
						} : {}),
						requestHandler: async (
							req: { prompt: string },
							_ctx: unknown,
							stream: { markdown(v: string): void },
						) => {
							pathATurnCount++;
							stream.markdown(`RaceA-PathA-turn${pathATurnCount}-part1(${req.prompt}) `);
							await new Promise<void>(r => setTimeout(r, 5));
							stream.markdown(`RaceA-PathA-turn${pathATurnCount}-part2`);
							return {};
						},
					}),
				},
				{ supportsInterruptions: true },
			);

			const sessionUri = wb.URI.parse('aexus-claude:///ade__proj1__race_window_a');
			const obs = rig.createObservable(sessionUri, {
				beforeResolveProvideContent: async () => {
					// While ObservableChatSession._doInitializeContent is still awaiting $provideChatSessionContent (_isInitialized === false),
					// flush live chunks and complete 'ongoing' so BOTH land in _pendingProgressChunks & _completedBeforeInitRequestIds!
					activeLiveTurn!.push({ kind: 'markdown', text: 'RaceA-tail-3!' });
					activeLiveTurn!.complete();
					activeLiveTurn = undefined;
					await new Promise<void>(r => setTimeout(r, 15));
				},
			});
			const harness = rig.createTrackRemoteHarness(sessionUri, { startEmpty: true });

			await obs.initialize(wb.CancellationToken.None, {});
			assert.equal(obs.isCompleteObs.get(), true, 'Race Window A: _doInitializeContent must mark isCompleteObs true');
			assert.equal(typeof obs.interruptActiveResponseCallback, 'function', 'Race Window A: interruptActiveResponseCallback MUST stay non-undefined');

			await harness.restoreAndTrackWithRealRestorer(obs);

			assert.equal(harness.requests.length, 1, 'Race Window A: restored model must contain Turn 1 bubble');
			const turn1 = harness.requests[0];
			assert.equal(
				turn1.chunks.join(''),
				'RaceA-buffered-1 RaceA-buffered-2 RaceA-tail-3!',
				'Race Window A: every buffered and pre-init chunk must land in Turn 1 bubble without empty-bubble drop',
			);
			assert.equal(turn1.response.isComplete, true, 'Race Window A: Turn 1 bubble must be marked complete');
			assert.equal(harness.hasActiveRequest.get(), false, 'Race Window A: model.hasActiveRequest must converge to false');
			assert.equal(harness.pendingRequests.has(sessionUri), false, 'Race Window A: no synthetic pending request may leak');
			assert.equal(await obs.interruptActiveResponseCallback!(), true, 'Race Window A: settled interrupt callback must return true idempotently');
			assert.equal(interruptCalls, 0, 'Race Window A: idempotent interrupt callback must NOT invoke liveTurn.interrupt()');

			// Immediately run Turn 2 via Path A (`requestHandler`) into its own independent bubble!
			const turn2Bubble = harness.model.addRequest({ text: 'follow-up-after-race-a', parts: [] });
			assert.equal(harness.requests.length, 2);
			assert.equal(harness.hasActiveRequest.get(), true);
			const realCts = new wb.CancellationTokenSource();
			harness.pendingRequests.set(sessionUri, {
				requestId: turn2Bubble.id,
				cancellationTokenSource: realCts,
				dispose: () => realCts.dispose(),
			});
			try {
				await obs.requestHandler!(
					{
						sessionResource: sessionUri,
						requestId: turn2Bubble.id,
						agentId: 'aexus-claude',
						message: 'follow-up-after-race-a',
						variables: { variables: [] },
						location: wb.ChatAgentLocation.Chat,
					},
					parts => {
						for (const p of parts) {
							harness.model.acceptResponseProgress(turn2Bubble, p);
						}
					},
					[],
					realCts.token,
				);
				turn2Bubble.response.complete();
			} finally {
				harness.pendingRequests.deleteAndDispose(sessionUri);
			}

			assert.equal(obs.isCompleteObs.get(), true, 'Race Window A -> Turn 2 Path A must converge isCompleteObs to true');
			assert.equal(harness.hasActiveRequest.get(), false, 'Race Window A -> Turn 2 Path A must converge hasActiveRequest to false');
			assert.equal(turn2Bubble.chunks.join(''), 'RaceA-PathA-turn1-part1(follow-up-after-race-a) RaceA-PathA-turn1-part2');
			assert.equal(turn1.chunks.join(''), 'RaceA-buffered-1 RaceA-buffered-2 RaceA-tail-3!', 'Turn 2 Path A must never overwrite or append to Turn 1');

			obs.dispose();
			rig.extHostSessions.dispose();
		}

		// --- Sub-case E (Race Window B): $handleProgressComplete('ongoing') arrives AFTER _doInitializeContent & restorer.restore() (while hasActiveRequest===true), BEFORE trackRemoteSession ---
		{
			const rig = createRpcSessionRig();
			let interruptCalls = 0;
			let activeLiveTurn: LiveTurnRunner<{ value: string }> | undefined = new LiveTurnRunner(
				'Race Window B Prompt',
				Date.now(),
				async () => { interruptCalls++; },
			);
			activeLiveTurn.push({ kind: 'markdown', text: 'RaceB-initial-buffered ' });

			let pathATurnCount = 0;
			rig.extHostSessions.registerChatSessionContentProvider(
				extensionDesc,
				'aexus-claude',
				{},
				{
					provideChatSessionContent: async () => ({
						title: 'Race B Worker',
						options: {},
						history: [
							new wb.extHostTypes.ChatRequestTurn('Race Window B Prompt', undefined, [], 'aexus-claude', [], undefined, 'req_race_b_1', undefined, undefined, false),
						],
						...(activeLiveTurn ? {
							activeResponseCallback: async (stream: { markdown(v: string): void }, attachToken: { isCancellationRequested: boolean; onCancellationRequested(fn: () => unknown): { dispose(): void } }) => {
								await activeLiveTurn!.attach(chunk => {
									if (chunk.kind === 'markdown') {
										stream.markdown(chunk.text);
									}
								}, attachToken);
							},
							interruptActiveResponse: () => activeLiveTurn!.interrupt(),
						} : {}),
						requestHandler: async (
							req: { prompt: string },
							_ctx: unknown,
							stream: { markdown(v: string): void },
						) => {
							pathATurnCount++;
							stream.markdown(`RaceB-PathA-turn${pathATurnCount}(${req.prompt})`);
							return {};
						},
					}),
				},
				{ supportsInterruptions: true },
			);

			const sessionUri = wb.URI.parse('aexus-claude:///ade__proj1__race_window_b');
			const obs = rig.createObservable(sessionUri);
			const harness = rig.createTrackRemoteHarness(sessionUri, { startEmpty: true });

			await obs.initialize(wb.CancellationToken.None, {});
			assert.equal(obs.isCompleteObs.get(), false, 'Race Window B: ongoing stream is still active right after _doInitializeContent');

			await harness.restoreAndTrackWithRealRestorer(obs, {
				beforeTrackRemoteSession: async restored => {
					// At this exact point: restorer.restore() has re-inserted incomplete liveHistory (`hasActiveRequest === true`),
					// and BEFORE trackRemoteSession runs, 'ongoing' emits its final chunk and $handleProgressComplete('ongoing')!
					assert.equal(harness.hasActiveRequest.get(), true, 'Race Window B: restorer.restore() leaves liveHistory incomplete before trackRemoteSession');
					assert.equal(restored.lastRequest?.response.isComplete, false);

					activeLiveTurn!.push({ kind: 'markdown', text: 'RaceB-macrotask-tail!' });
					activeLiveTurn!.complete();
					activeLiveTurn = undefined;
					await new Promise<void>(r => setTimeout(r, 15));

					assert.equal(obs.isCompleteObs.get(), true, 'Race Window B: isCompleteObs transitions to true before trackRemoteSession');
					assert.equal(typeof obs.interruptActiveResponseCallback, 'function', 'Race Window B: interruptActiveResponseCallback MUST NOT be cleared at L356');
					assert.equal(harness.hasActiveRequest.get(), true, 'Race Window B: model.hasActiveRequest is still true entering trackRemoteSession');
				},
			});

			assert.equal(harness.requests.length, 1);
			const turn1 = harness.requests[0];
			assert.equal(
				turn1.chunks.join(''),
				'RaceB-initial-buffered RaceB-macrotask-tail!',
				'Race Window B: initial autorun in trackRemoteSession must replay all buffered & tail chunks into Turn 1 bubble',
			);
			assert.equal(turn1.response.isComplete, true, 'Race Window B: trackRemoteSession must invoke completeStreamingResponse()');
			assert.equal(harness.hasActiveRequest.get(), false, 'Race Window B: model.hasActiveRequest MUST converge to false without deadlocking panel');
			assert.equal(harness.pendingRequests.has(sessionUri), false, 'Race Window B: no synthetic pending request may remain');
			assert.equal(interruptCalls, 0);

			// Immediately run Turn 2 via Path A (`requestHandler`) into its own independent bubble!
			const turn2Bubble = harness.model.addRequest({ text: 'follow-up-after-race-b', parts: [] });
			assert.equal(harness.requests.length, 2);
			assert.equal(harness.hasActiveRequest.get(), true);
			const realCts = new wb.CancellationTokenSource();
			harness.pendingRequests.set(sessionUri, {
				requestId: turn2Bubble.id,
				cancellationTokenSource: realCts,
				dispose: () => realCts.dispose(),
			});
			try {
				await obs.requestHandler!(
					{
						sessionResource: sessionUri,
						requestId: turn2Bubble.id,
						agentId: 'aexus-claude',
						message: 'follow-up-after-race-b',
						variables: { variables: [] },
						location: wb.ChatAgentLocation.Chat,
					},
					parts => {
						for (const p of parts) {
							harness.model.acceptResponseProgress(turn2Bubble, p);
						}
					},
					[],
					realCts.token,
				);
				turn2Bubble.response.complete();
			} finally {
				harness.pendingRequests.deleteAndDispose(sessionUri);
			}

			assert.equal(obs.isCompleteObs.get(), true, 'Race Window B -> Turn 2 Path A must converge isCompleteObs to true');
			assert.equal(harness.hasActiveRequest.get(), false, 'Race Window B -> Turn 2 Path A must converge hasActiveRequest to false');
			assert.equal(turn2Bubble.chunks.join(''), 'RaceB-PathA-turn1(follow-up-after-race-b)');
			assert.equal(turn1.chunks.join(''), 'RaceB-initial-buffered RaceB-macrotask-tail!', 'Turn 2 Path A must stay isolated from Turn 1');

			obs.dispose();
			rig.extHostSessions.dispose();
		}

		// --- Sub-case F: Already-complete historical session (no unresponded lastRequest) stays intact and never corrupts completed history ---
		{
			const rig = createRpcSessionRig();
			rig.extHostSessions.registerChatSessionContentProvider(
				extensionDesc,
				'aexus-claude',
				{},
				{
					provideChatSessionContent: async () => ({
						title: 'Completed History Worker',
						options: {},
						history: [
							new wb.extHostTypes.ChatRequestTurn('Completed Prompt 1', undefined, [], 'aexus-claude', [], undefined, 'req_done_1', undefined, undefined, false),
							new wb.extHostTypes.ChatResponseTurn2(
								[new wb.extHostTypes.ChatResponseMarkdownPart('Completed Answer 1')],
								{},
								'aexus-claude',
							),
						],
						requestHandler: async (
							req: { prompt: string },
							_ctx: unknown,
							stream: { markdown(v: string): void },
						) => {
							stream.markdown(`Fresh-PathA(${req.prompt})`);
							return {};
						},
					}),
				},
				{ supportsInterruptions: true },
			);

			const sessionUri = wb.URI.parse('aexus-claude:///ade__proj1__completed_history');
			const obs = rig.createObservable(sessionUri);
			const harness = rig.createTrackRemoteHarness(sessionUri, { startEmpty: true });

			await obs.initialize(wb.CancellationToken.None, {});
			assert.equal(obs.interruptActiveResponseCallback, undefined, 'Idle historical session without activeResponseCallback keeps interruptActiveResponseCallback undefined');
			await harness.restoreAndTrackWithRealRestorer(obs);

			assert.equal(harness.requests.length, 1);
			assert.equal(harness.requests[0].chunks.join(''), 'Completed Answer 1');
			assert.equal(harness.requests[0].response.isComplete, true);
			assert.equal(harness.hasActiveRequest.get(), false);

			obs.dispose();
			rig.extHostSessions.dispose();
		}
	});

	test('[P1-3] Path A open-chat Ticket prefix classification, human turn protection, immediate steer preemption without \\n\\n merging, and deferred Outbox crash-replay durability', async () => {
		const { mod: wb } = await loadBundledWorkbenchModules();

		// 1. Verify exact Ticket header detection in both extension.ts & adeControlHandler.ts
		const sampleTicketPrompt = `${ADE_TICKET_MESSAGE_PREFIX_START}agent_l1}的Ticket] \nticket_id: tk_100 | task_id: tsk_100 | task_type: dev | need_return: true\n\nImplement feature`;
		assert.equal(isAdeTicketDeliveryMessage(sampleTicketPrompt), true);
		assert.equal(wb.isAdeOpenChatTicketPrompt(sampleTicketPrompt), true);
		assert.equal(isAdeTicketDeliveryMessage('Please explain this function'), false);
		assert.equal(wb.isAdeOpenChatTicketPrompt('Please explain this function'), false);

		const extSrc = fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'extension.ts'), 'utf8');
		assert.equal(
			extSrc.includes(`source: isTicketPayload ? 'headless' : 'ui'`),
			true,
			'extension.ts must classify Path A Ticket payloads as headless so queue Tickets never preempt active turns as human_ui',
		);

		const makeTicketPayload = (ticketId: string, body: string) =>
			`${ADE_TICKET_MESSAGE_PREFIX_START}agent_lead}的Ticket] \nticket_id: ${ticketId} | task_id: tsk_${ticketId} | task_type: dev | need_return: true\n\n${body}`;

		// Shared controllable open-chat mock harness driving REAL AdeOpenChatTicketScheduler & AdeOutboxBridgeContribution
		const createOpenChatHarness = (sessionUri: unknown) => {
			const hasActiveRequest = wb.observableValue('testActiveReq', false);
			const requestInProgress = wb.observableValue('testReqInProgress', false);
			const onDidChangeEmitter = new wb.Emitter<{ readonly kind: string; readonly requestId?: string }>();
			const onDidDisposeEmitter = new wb.Emitter<void>();

			interface ActiveTurnController {
				readonly prompt: string;
				readonly finish: () => void;
				readonly cancel: () => void;
				readonly responseComplete: InstanceType<typeof wb.DeferredPromise<void>>;
				isComplete: boolean;
				isCanceled: boolean;
			}

			let currentTurn: ActiveTurnController | undefined;
			const sentPrompts: string[] = [];
			let cancelCalls = 0;

			const liveModel = {
				sessionResource: sessionUri,
				hasActiveRequest,
				requestInProgress,
				onDidChange: onDidChangeEmitter.event,
				onDidDispose: onDidDisposeEmitter.event,
				get lastRequest() {
					if (!currentTurn) {
						return undefined;
					}
					const turnRef = currentTurn;
					const respChangeEmitter = new wb.Emitter<void>();
					return {
						id: 'req_live',
						message: { text: turnRef.prompt },
						response: {
							get isComplete() { return turnRef.isComplete; },
							get isCanceled() { return turnRef.isCanceled; },
							onDidChange: respChangeEmitter.event,
						},
					};
				},
			};

			const startTurn = (prompt: string): ActiveTurnController => {
				const responseComplete = new wb.DeferredPromise<void>();
				const ctrl: ActiveTurnController = {
					prompt,
					responseComplete,
					isComplete: false,
					isCanceled: false,
					finish: () => {
						if (ctrl.isComplete) {
							return;
						}
						ctrl.isComplete = true;
						if (currentTurn === ctrl) {
							currentTurn = undefined;
							hasActiveRequest.set(false, undefined);
							requestInProgress.set(false, undefined);
						}
						responseComplete.complete();
						onDidChangeEmitter.fire({ kind: 'completedRequest' });
					},
					cancel: () => {
						if (ctrl.isComplete) {
							return;
						}
						ctrl.isCanceled = true;
						ctrl.isComplete = true;
						if (currentTurn === ctrl) {
							currentTurn = undefined;
							hasActiveRequest.set(false, undefined);
							requestInProgress.set(false, undefined);
						}
						responseComplete.complete();
						onDidChangeEmitter.fire({ kind: 'completedRequest' });
					},
				};
				currentTurn = ctrl;
				hasActiveRequest.set(true, undefined);
				requestInProgress.set(true, undefined);
				return ctrl;
			};

			const turnHooks = new Map<string, (ctrl: ActiveTurnController) => void>();

			const chatService = {
				getSession: (uri: { toString(): string }) =>
					uri.toString() === (sessionUri as { toString(): string }).toString() ? liveModel : undefined,
				sendRequest: async (_uri: unknown, prompt: string, options?: { queue?: unknown }) => {
					assert.equal(options?.queue, undefined, 'AdeOpenChatTicketScheduler must NEVER pass ChatRequestQueueKind.Steering (prevents \\n\\n merging)');
					if (currentTurn && !currentTurn.isComplete) {
						return { kind: 'rejected' as const, reason: 'Request already in progress' };
					}
					sentPrompts.push(prompt);
					const ctrl = startTurn(prompt);
					const hook = turnHooks.get(prompt);
					if (hook) {
						hook(ctrl);
					}
					return {
						kind: 'sent' as const,
						data: {
							responseCreatedPromise: Promise.resolve({
								get isCanceled() { return ctrl.isCanceled; },
								get state() { return ctrl.isCanceled ? wb.ResponseModelState.Cancelled : wb.ResponseModelState.Complete; },
							}),
							responseCompletePromise: ctrl.responseComplete.p,
						},
					};
				},
				cancelCurrentRequestForSession: async () => {
					cancelCalls++;
					currentTurn?.cancel();
				},
			};

			return {
				chatService,
				sentPrompts,
				getCancelCalls: () => cancelCalls,
				startHumanTurn: (humanPrompt: string) => startTurn(humanPrompt),
				onTurnStarted: (prompt: string, cb: (ctrl: ActiveTurnController) => void) => {
					turnHooks.set(prompt, cb);
				},
			};
		};

		const sessionUri = wb.URI.parse('aexus-claude:///ade__proj_b__emp_1');

		// --- Scenario 3A: Human direct-chat turn is NEVER interrupted by steer/queue; steer runs ahead of queue after human turn ---
		{
			const harness = createOpenChatHarness(sessionUri);
			const scheduler = new wb.AdeOpenChatTicketScheduler();
			const humanTurn = harness.startHumanTurn('Human: refactor auth middleware');

			const q1Payload = makeTicketPayload('tk_q1', 'Queue task 1');
			const s1Payload = makeTicketPayload('tk_s1', 'Urgent steer 1');

			harness.onTurnStarted(s1Payload, ctrl => setTimeout(() => ctrl.finish(), 15));
			harness.onTurnStarted(q1Payload, ctrl => setTimeout(() => ctrl.finish(), 15));

			let q1Settled = false;
			let s1Settled = false;
			const pQ1 = scheduler.dispatchTicket({
				sessionUri,
				payloadText: q1Payload,
				deliveryMode: 'queue',
				projectId: 'proj_b',
				agentId: 'emp_1',
				ticketId: 'tk_q1',
			}, harness.chatService).then(res => { q1Settled = true; return res; });

			const pS1 = scheduler.dispatchTicket({
				sessionUri,
				payloadText: s1Payload,
				deliveryMode: 'steer',
				projectId: 'proj_b',
				agentId: 'emp_1',
				ticketId: 'tk_s1',
			}, harness.chatService).then(res => { s1Settled = true; return res; });

			await new Promise<void>(r => setTimeout(r, 30));
			assert.equal(harness.getCancelCalls(), 0, 'Active human direct-chat turn MUST NEVER be cancelled by steer or queue Tickets');
			assert.equal(harness.sentPrompts.length, 0, 'Tickets must wait politely while human turn is running');
			assert.equal(q1Settled, false);
			assert.equal(s1Settled, false);

			// Finish human turn -> S1 must execute first, followed by Q1!
			humanTurn.finish();
			const [resQ1, resS1] = await Promise.all([pQ1, pS1]);
			assert.equal(resS1.ok, true);
			assert.equal(resQ1.ok, true);
			assert.deepEqual(harness.sentPrompts, [s1Payload, q1Payload], 'Steer Ticket must leapfrog queued Ticket and run immediately after human turn');
		}

		// --- Scenario 3B: In-flight queue Ticket is immediately preempted by steer, and multiple steers NEVER merge with \n\n ---
		{
			const harness = createOpenChatHarness(sessionUri);
			const scheduler = new wb.AdeOpenChatTicketScheduler();

			const q1Payload = makeTicketPayload('tk_long_q1', 'Long running queue ticket');
			const s1Payload = makeTicketPayload('tk_steer_1', 'First urgent steer');
			const s2Payload = makeTicketPayload('tk_steer_2', 'Second urgent steer');
			const q2Payload = makeTicketPayload('tk_tail_q2', 'Trailing queue ticket');

			let q1StartedResolve!: () => void;
			const q1Started = new Promise<void>(r => { q1StartedResolve = r; });
			harness.onTurnStarted(q1Payload, () => {
				q1StartedResolve();
				// Intentionally does NOT self-finish: only finishes when preempted via cancelCurrentRequestForSession!
			});
			harness.onTurnStarted(s1Payload, ctrl => setTimeout(() => ctrl.finish(), 25));
			harness.onTurnStarted(s2Payload, ctrl => setTimeout(() => ctrl.finish(), 15));
			harness.onTurnStarted(q2Payload, ctrl => setTimeout(() => ctrl.finish(), 10));

			const pQ1 = scheduler.dispatchTicket({
				sessionUri,
				payloadText: q1Payload,
				deliveryMode: 'queue',
				projectId: 'proj_b',
				agentId: 'emp_1',
				ticketId: 'tk_long_q1',
			}, harness.chatService);

			await q1Started;
			assert.equal(harness.getCancelCalls(), 0);

			// Enqueue Q2 (queue), S1 (steer), S2 (steer) while Q1 is in flight!
			const pQ2 = scheduler.dispatchTicket({
				sessionUri,
				payloadText: q2Payload,
				deliveryMode: 'queue',
				projectId: 'proj_b',
				agentId: 'emp_1',
				ticketId: 'tk_tail_q2',
			}, harness.chatService);
			const pS1 = scheduler.dispatchTicket({
				sessionUri,
				payloadText: s1Payload,
				deliveryMode: 'steer',
				projectId: 'proj_b',
				agentId: 'emp_1',
				ticketId: 'tk_steer_1',
			}, harness.chatService);
			const pS2 = scheduler.dispatchTicket({
				sessionUri,
				payloadText: s2Payload,
				deliveryMode: 'steer',
				projectId: 'proj_b',
				agentId: 'emp_1',
				ticketId: 'tk_steer_2',
			}, harness.chatService);

			const [rQ1, rS1, rS2, rQ2] = await Promise.all([pQ1, pS1, pS2, pQ2]);
			assert.equal(harness.getCancelCalls(), 1, 'Q1 must be cancelled once by S1, while S1 itself is NOT cancelled by S2');
			assert.equal(rQ1.stopped, true);
			assert.equal(rS1.ok, true);
			assert.equal(rS1.stopped, false);
			assert.equal(rS2.ok, true);
			assert.equal(rQ2.ok, true);
			assert.deepEqual(
				harness.sentPrompts,
				[q1Payload, s1Payload, s2Payload, q2Payload],
				'S1 and S2 must execute as distinct standalone turns in FIFO order before Q2 without \\n\\n concatenation',
			);
		}

		// --- Scenario 3C: AdeOutboxBridgeContribution deferred Outbox ack & Cmd+R reload durability ---
		{
			const harness = createOpenChatHarness(sessionUri);
			const onEnqueue = new wb.Emitter<{ readonly projectId: string }>();
			const onCancel = new wb.Emitter<{ readonly projectId: string; readonly ticketIds: readonly string[] }>();
			const onDisposeAgent = new wb.Emitter<Record<string, unknown>>();

			const d1Payload = makeTicketPayload('tk_outbox_1', 'Outbox turn 1');
			const d2Payload = makeTicketPayload('tk_outbox_2', 'Outbox turn 2 parked in memory');

			let pendingClaims = [
				{
					deliveryId: 'dlv_1',
					projectId: 'proj_b',
					targetAgentId: 'emp_1',
					ticketId: 'tk_outbox_1',
					taskId: 'tsk_1',
					deliveryMode: 'queue' as const,
					payloadText: d1Payload,
				},
				{
					deliveryId: 'dlv_2',
					projectId: 'proj_b',
					targetAgentId: 'emp_1',
					ticketId: 'tk_outbox_2',
					taskId: 'tsk_2',
					deliveryMode: 'queue' as const,
					payloadText: d2Payload,
				},
			];

			const ackedIds: string[] = [];
			const nackedIds: string[] = [];
			const releasedWindows: number[] = [];

			let d1Ctrl!: { finish: () => void };
			let d1RunningResolve!: () => void;
			const d1Running = new Promise<void>(r => { d1RunningResolve = r; });
			harness.onTurnStarted(d1Payload, ctrl => {
				d1Ctrl = ctrl;
				d1RunningResolve();
			});

			const mockControlCenter = {
				onDidEnqueueOutbox: onEnqueue.event,
				onDidCancelOutboxTickets: onCancel.event,
				onDidDisposeAgentRuntime: onDisposeAgent.event,
				claimPendingDeliveries: async () => {
					const batch = pendingClaims;
					pendingClaims = [];
					return batch;
				},
				issueAgentLaunchBundle: async () => ({
					name: 'Emp 1',
					host: 'local',
					engine: 'claude',
					sessionResource: (sessionUri as { toString(): string }).toString(),
					agentToken: 'tok_test',
					controlSocketPath: '/tmp/ade.sock',
				}),
				getProjectSnapshot: async () => ({
					meta: { folder_uri: 'file:///tmp/proj_b' },
					hosts: [],
					agents: [],
				}),
				markAgentSessionStarting: async () => { },
				markAgentSessionStarted: async () => { },
				ackDeliveryDispatched: async (deliveryId: string) => {
					ackedIds.push(deliveryId);
				},
				nackDeliveryFailed: async (deliveryId: string) => {
					nackedIds.push(deliveryId);
				},
				releaseWindowDeliveries: async (winId: number) => {
					releasedWindows.push(winId);
					return 2;
				},
			};

			const bridgeHolder: { current?: InstanceType<typeof wb.AdeOutboxBridgeContribution> } = {};
			const mockCommandService = {
				executeCommand: async (cmdId: string, arg?: unknown) => {
					if (cmdId === 'aexus.ade.getWindowId') {
						return 42;
					}
					if (cmdId === 'aexus.ade.dispatchTicketTurn') {
						const p = arg as {
							sessionResource: string;
							payloadText: string;
							deliveryMode: 'steer' | 'queue';
							projectId: string;
							agentId: string;
							ticketId: string;
							taskId: string;
						};
						const out = await bridgeHolder.current!.scheduler.dispatchTicket(
							{
								sessionUri: wb.URI.parse(p.sessionResource),
								payloadText: p.payloadText,
								deliveryMode: p.deliveryMode,
								projectId: p.projectId,
								agentId: p.agentId,
								ticketId: p.ticketId,
								taskId: p.taskId,
							},
							harness.chatService,
							mockControlCenter,
						);
						return {
							ok: out.ok !== false,
							stopped: Boolean(out.stopped),
							abortedByWindowDispose: Boolean(out.abortedByWindowDispose),
							error: out.error,
							nativeSessionId: 'sess_1',
						};
					}
					return undefined;
				},
			};

			const mockInstantiationService = {
				invokeFunction: <R>(fn: (accessor: { get(id: unknown): unknown }) => R): R =>
					fn({
						get: (serviceId: unknown) => {
							if (serviceId === wb.IAdeControlCenterService) {
								return mockControlCenter;
							}
							if (serviceId === wb.IChatService) {
								return harness.chatService;
							}
							throw new Error('Optional service not bound');
						},
					}),
			};

			const bridgeRef = new wb.AdeOutboxBridgeContribution(mockCommandService, mockInstantiationService);
			bridgeHolder.current = bridgeRef;
			await d1Running;
			await new Promise<void>(r => setTimeout(r, 25));

			// While dlv_1 is executing and dlv_2 is parked in AdeOpenChatTicketScheduler memory queue:
			// NEITHER may be prematurely acked/deleted from SQLite Outbox!
			assert.equal(bridgeRef.scheduler.getQueuedCount('proj_b', 'emp_1'), 1, 'dlv_2 must be parked in scheduler memory queue');
			assert.deepEqual(ackedIds, [], 'Outbox records MUST NOT be acked on enqueue before turn execution completes');
			assert.deepEqual(nackedIds, []);

			// Complete dlv_1 -> dlv_1 is now acked, while dlv_2 starts running and is STILL not acked!
			let d2RunningResolve!: () => void;
			const d2Running = new Promise<void>(r => { d2RunningResolve = r; });
			harness.onTurnStarted(d2Payload, () => {
				d2RunningResolve();
			});
			d1Ctrl.finish();
			await d2Running;
			await new Promise<void>(r => setTimeout(r, 20));
			assert.deepEqual(ackedIds, ['dlv_1'], 'Completed dlv_1 must be acked while in-flight dlv_2 remains unacked');

			// Enqueue dlv_3 while dlv_2 is running, then simulate Cmd+R window reload (`bridgeRef.dispose()`)!
			pendingClaims = [{
				deliveryId: 'dlv_3',
				projectId: 'proj_b',
				targetAgentId: 'emp_1',
				ticketId: 'tk_outbox_3',
				taskId: 'tsk_3',
				deliveryMode: 'queue',
				payloadText: makeTicketPayload('tk_outbox_3', 'Outbox turn 3 surviving Cmd+R'),
			}];
			await bridgeRef.pumpOutbox();
			await new Promise<void>(r => setTimeout(r, 20));
			assert.equal(bridgeRef.scheduler.getQueuedCount('proj_b', 'emp_1'), 1);

			// Cmd+R window unload!
			bridgeRef.dispose();
			await new Promise<void>(r => setTimeout(r, 25));

			assert.deepEqual(
				ackedIds,
				['dlv_1'],
				'Unfinished dlv_2 and memory-queued dlv_3 MUST NOT be acked on window reload so Outbox replays them',
			);
			assert.deepEqual(nackedIds, [], 'Window reload MUST NOT mark unfinished Outbox deliveries as failed');
			assert.deepEqual(releasedWindows, [42], 'Window dispose must invoke releaseWindowDeliveries(windowId)');
		}
	});
});
