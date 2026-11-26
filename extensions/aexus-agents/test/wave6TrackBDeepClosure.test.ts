/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADE_TICKET_MESSAGE_PREFIX_START } from '../src/ticketMessageFormat.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');

interface VscodeMockController {
	autonomousMode: boolean;
	cliPaths: Record<string, string>;
	readonly warningMessages: string[];
	readonly registeredCommands: Map<string, (...args: unknown[]) => unknown>;
	readonly contentProviders: Map<string, {
		provideChatSessionContent(uri: unknown, token: unknown): Promise<{
			readonly title: string;
			readonly options?: Record<string, { readonly id: string; readonly name: string }>;
			readonly history: ReadonlyArray<{ readonly prompt?: string; readonly response?: ReadonlyArray<{ readonly value?: { readonly value?: string } }> }>;
			readonly activeResponseCallback?: (stream: Record<string, (...args: unknown[]) => void>, token: unknown) => Promise<void>;
			readonly interruptActiveResponse?: () => Promise<void>;
			readonly requestHandler?: (
				request: { readonly prompt: string; readonly command?: string; readonly references: readonly unknown[] },
				chatContext: Record<string, unknown>,
				stream: Record<string, (...args: unknown[]) => void>,
				token: unknown,
			) => Promise<Record<string, unknown>>;
			dispose(): void;
		}>;
	}>;
	readonly itemControllers: Map<string, {
		readonly itemsMap: Map<string, { readonly resource: unknown; label: string; description?: string; metadata?: Record<string, unknown> }>;
	}>;
	createUri(raw: string): {
		readonly scheme: string;
		readonly authority: string;
		readonly path: string;
		readonly fsPath: string;
		with(change: { scheme?: string; authority?: string; path?: string }): unknown;
		toString(): string;
	};
	createCts(): {
		readonly token: {
			readonly isCancellationRequested: boolean;
			onCancellationRequested(fn: () => void): { dispose(): void };
		};
		cancel(): void;
		dispose(): void;
	};
	fireConfigChange(section: string): void;
	resetForActivation(): void;
}

interface Wave6SuiteBundle {
	readonly vscodeMock: VscodeMockController;
	readonly parseAdeAgentResourceIds: (resourceId: string | undefined) => { readonly projectId: string; readonly agentId: string } | undefined;
	readonly arePiModelsEquivalent: (requestedModel: string | undefined, slotCurrentModel: string | undefined) => boolean;
	readonly activateExtension: (context: unknown) => Promise<void>;
	readonly deactivateExtension: () => Promise<void>;
	readonly workbench: {
		readonly URI: { parse(v: string): { readonly scheme: string; readonly path: string; toString(): string } };
		readonly Emitter: new <T>() => {
			readonly event: (listener: (e: T) => void) => { dispose(): void };
			fire(event: T): void;
			dispose(): void;
		};
		readonly CommandsRegistry: {
			getCommand(id: string): { readonly handler: (accessor: { get(id: unknown): unknown }, ...args: unknown[]) => unknown } | undefined;
		};
		readonly ICommandService: unknown;
		readonly IAdeControlCenterService: unknown;
		readonly IChatService: unknown;
		readonly IConfigurationService: unknown;
		readonly IAdeEditorService: unknown;
		readonly AdeOpenChatTicketScheduler: new () => {
			dispatchTicket(
				input: Record<string, unknown>,
				chatService: unknown,
				controlCenter?: unknown,
				commandService?: unknown,
			): Promise<Record<string, unknown>>;
			getQueuedCount(projectId: string, agentId: string): number;
			abortForWindowDispose(): void;
		};
		readonly AdeOutboxBridgeContribution: new (
			commandService: { executeCommand(id: string, ...args: unknown[]): Promise<unknown> },
			instantiationService: { invokeFunction<R>(fn: (accessor: { get(id: unknown): unknown }) => R): R },
		) => {
			readonly scheduler: {
				dispatchTicket(
					input: Record<string, unknown>,
					chatService: unknown,
					controlCenter?: unknown,
					commandService?: unknown,
				): Promise<Record<string, unknown>>;
			};
			pumpOutbox(): Promise<void>;
			flushOutboxForTest(): Promise<void>;
			dispose(): void;
		};
		readonly parseAdeEmployeeSessionUri: (uri: unknown) => { readonly engine: string; readonly projectId: string; readonly agentId: string } | undefined;
		readonly buildAdeEmployeeSessionUri: (engine: string, projectId: string, agentId: string) => { readonly scheme: string; toString(): string };
		readonly AdeEditorService: new (
			modeService: unknown,
			editorGroupsService: unknown,
			editorService: unknown,
			instantiationService: unknown,
			projectsService: unknown,
			extensionService: unknown,
		) => {
			readonly activeEditor: unknown;
			openAgent(id: string, options?: { readonly projectId?: string; readonly side?: boolean }): Promise<void>;
			rebindUnstartedAgentEditors(projectId?: string, snapshot?: unknown): Promise<number>;
			dispose(): void;
		};
		readonly AdeLineageChatEditorInput: new (...args: unknown[]) => {
			readonly sessionResource?: { toString(): string; readonly scheme: string };
			readonly hasResolvedModel: boolean;
			setLineageProvider(provider: (() => string | undefined) | undefined): void;
			isDisposed(): boolean;
			dispose(): void;
		};
	};
}

const tempArtifactsToClean: string[] = [];
after(() => {
	for (const p of tempArtifactsToClean) {
		try {
			fs.rmSync(p, { recursive: true, force: true });
		} catch { /* ignore */ }
	}
});

let cachedBundlePromise: Promise<Wave6SuiteBundle> | undefined;

function loadWave6SuiteBundle(): Promise<Wave6SuiteBundle> {
	if (!cachedBundlePromise) {
		cachedBundlePromise = (async () => {
			const esbuild = await import('esbuild');
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ade-w6-trackb-${process.pid}-`));
			tempArtifactsToClean.push(tmpDir);

			const vscodeShimPath = path.join(tmpDir, 'vscode-mock.mjs');
			fs.writeFileSync(vscodeShimPath, [
				"import * as path from 'node:path';",
				"class MockEventEmitter {",
				"  constructor() { this._listeners = new Set(); this.event = (l) => { this._listeners.add(l); return { dispose: () => this._listeners.delete(l) }; }; }",
				"  fire(data) { for (const fn of [...this._listeners]) fn(data); }",
				"  dispose() { this._listeners.clear(); }",
				"}",
				"class MockCancellationError extends Error { constructor() { super('Canceled'); this.name = 'CancellationError'; } }",
				"class MockCancellationTokenSource {",
				"  constructor() {",
				"    this._cancelled = false; this._listeners = new Set(); const self = this;",
				"    this.token = {",
				"      get isCancellationRequested() { return self._cancelled; },",
				"      onCancellationRequested(fn) { if (self._cancelled) { fn(); return { dispose() {} }; } self._listeners.add(fn); return { dispose: () => self._listeners.delete(fn) }; },",
				"    };",
				"  }",
				"  cancel() { if (this._cancelled) return; this._cancelled = true; for (const fn of [...this._listeners]) fn(); }",
				"  dispose() { this._listeners.clear(); }",
				"}",
				"class MockUri {",
				"  constructor(scheme, authority, uriPath) { this.scheme = scheme || 'file'; this.authority = authority || ''; this.path = uriPath || ''; }",
				"  get fsPath() { return this.path; }",
				"  with(c) { return new MockUri(c.scheme ?? this.scheme, c.authority ?? this.authority, c.path ?? this.path); }",
				"  toString() { if (this.authority) return this.scheme + '://' + this.authority + this.path; if (this.scheme === 'file') return 'file://' + this.path; return this.scheme + ':' + this.path; }",
				"  static file(fsPath) { const r = path.resolve(fsPath).replace(/\\\\/g, '/'); return new MockUri('file', '', r.startsWith('/') ? r : '/' + r); }",
				"  static from(c) { return new MockUri(c.scheme, c.authority || '', c.path || ''); }",
				"  static joinPath(base, ...segs) { return new MockUri(base.scheme, base.authority, path.posix.join(base.path || '/', ...segs)); }",
				"  static parse(raw) { const m = /^([a-zA-Z0-9+.-]+):(?:\\/\\/([^/]*))?(.*)$/.exec(String(raw)); if (!m) return MockUri.file(String(raw)); let p = m[3] || ''; if (!m[2] && p.startsWith('///')) p = p.slice(2); return new MockUri(m[1], m[2] || '', p); }",
				"}",
				"class MockThemeIcon { constructor(id) { this.id = id; } }",
				"class MockMarkdownString { constructor(value = '') { this.value = value; } }",
				"class MockLocation { constructor(uri, range) { this.uri = uri; this.range = range; } }",
				"class MockChatRequestTurn2 { constructor(prompt, command, references, participant, _t, _e, id, _m, _i, isSystemInitiated) { this.prompt = prompt; this.command = command; this.references = references; this.participant = participant; this.id = id; this.isSystemInitiated = isSystemInitiated; } }",
				"class MockChatResponseMarkdownPart { constructor(value) { this.value = typeof value === 'string' ? new MockMarkdownString(value) : value; } }",
				"class MockChatResponseTurn2 { constructor(response, result, participant) { this.response = response; this.result = result; this.participant = participant; } }",
				"const configListeners = new Set();",
				"export const __controller = {",
				"  autonomousMode: true, cliPaths: {}, warningMessages: [], registeredCommands: new Map(), contentProviders: new Map(), itemControllers: new Map(),",
				"  createUri: (raw) => MockUri.parse(raw),",
				"  createCts: () => new MockCancellationTokenSource(),",
				"  fireConfigChange: (section) => { const evt = { affectsConfiguration: (p) => section === p || section.startsWith(p + '.') || p.startsWith(section + '.') }; for (const fn of [...configListeners]) fn(evt); },",
				"  resetForActivation: () => { __controller.warningMessages.length = 0; __controller.registeredCommands.clear(); __controller.contentProviders.clear(); __controller.itemControllers.clear(); configListeners.clear(); },",
				"};",
				"export const EventEmitter = MockEventEmitter;",
				"export const CancellationError = MockCancellationError;",
				"export const CancellationTokenSource = MockCancellationTokenSource;",
				"export const Uri = MockUri;",
				"export const ThemeIcon = MockThemeIcon;",
				"export const MarkdownString = MockMarkdownString;",
				"export const Location = MockLocation;",
				"export const ChatRequestTurn2 = MockChatRequestTurn2;",
				"export const ChatResponseTurn2 = MockChatResponseTurn2;",
				"export const ChatResponseMarkdownPart = MockChatResponseMarkdownPart;",
				"export const ChatSessionStatus = { Completed: 1, InProgress: 2, Failed: 3 };",
				"export const ChatSessionCustomizationType = { Skill: 1, Prompt: 2, Agent: 3, Instructions: 4, Hook: 5, Plugins: 6 };",
				`export const env = { appRoot: ${JSON.stringify(EXTENSION_ROOT)} };`,
				"export const l10n = { t: (msg, ...args) => String(msg).replace(/\\{(\\d+)\\}/g, (_, i) => String(args[Number(i)] ?? '')) };",
				"export const workspace = {",
				"  workspaceFolders: [{ uri: MockUri.file(process.cwd()) }],",
				"  getConfiguration: (section) => ({",
				"    get: (key, defaultVal) => {",
				"      if (section === 'aexus.ade' && key === 'autonomousMode') return __controller.autonomousMode;",
				"      if (section === 'aexus.ade' && key === 'cliPaths') return { ...__controller.cliPaths };",
				"      if (section === 'aexus.ade.cliPaths') return __controller.cliPaths[key] ?? defaultVal;",
				"      return defaultVal;",
				"    },",
				"    inspect: (key) => {",
				"      if (section === 'aexus.ade' && key === 'autonomousMode') return { globalValue: __controller.autonomousMode, defaultValue: true };",
				"      if (section === 'aexus.ade' && key === 'cliPaths') return { globalValue: { ...__controller.cliPaths } };",
				"      return undefined;",
				"    },",
				"  }),",
				"  onDidChangeConfiguration: (fn) => { configListeners.add(fn); return { dispose: () => configListeners.delete(fn) }; },",
				"};",
				"export const window = {",
				"  showWarningMessage: async (msg) => { __controller.warningMessages.push(String(msg)); return undefined; },",
				"  showInformationMessage: async () => undefined,",
				"  showErrorMessage: async () => undefined,",
				"  showInputBox: async () => undefined,",
				"  showQuickPick: async (items) => items[0],",
				"};",
				"export const commands = {",
				"  registerCommand: (id, handler) => { __controller.registeredCommands.set(id, handler); return { dispose: () => { if (__controller.registeredCommands.get(id) === handler) __controller.registeredCommands.delete(id); } }; },",
				"  executeCommand: async (id, ...args) => { const fn = __controller.registeredCommands.get(id); return fn ? await fn(...args) : undefined; },",
				"};",
				"export const chat = {",
				"  createChatParticipant: (id, handler) => ({ id, requestHandler: handler, iconPath: undefined, dispose() {} }),",
				"  createChatSessionItemController: (type) => {",
				"    const itemsMap = new Map();",
				"    const ctrl = {",
				"      itemsMap,",
				"      createChatSessionItem: (resource, label) => ({ resource, label, description: '', metadata: {} }),",
				"      createChatSessionInputState: (groups) => { const d = new MockEventEmitter(); return { groups, sessionResource: undefined, onDidDispose: d.event, dispose: () => d.fire() }; },",
				"      items: { add: (it) => itemsMap.set(it.resource.toString(), it), delete: (uri) => itemsMap.delete(uri.toString()), replace: (arr) => { itemsMap.clear(); for (const it of arr) itemsMap.set(it.resource.toString(), it); } },",
				"      dispose() {},",
				"    };",
				"    __controller.itemControllers.set(type, ctrl);",
				"    return ctrl;",
				"  },",
				"  registerChatSessionContentProvider: (scheme, provider) => { __controller.contentProviders.set(scheme, provider); return { dispose: () => { if (__controller.contentProviders.get(scheme) === provider) __controller.contentProviders.delete(scheme); } }; },",
				"};",
			].join('\n'));

			const extOutPath = path.join(tmpDir, 'ext-w6-bundle.mjs');
			await esbuild.build({
				stdin: {
					contents: [
						"export { __controller as vscodeMock } from 'vscode';",
						"export { parseAdeAgentResourceIds } from './src/extensionSessionHelpers.ts';",
						"export { arePiModelsEquivalent } from './src/pi.ts';",
						"export { activate as activateExtension, deactivate as deactivateExtension } from './src/extension.ts';",
					].join('\n'),
					resolveDir: EXTENSION_ROOT,
					loader: 'ts',
				},
				alias: { vscode: vscodeShimPath },
				define: { __dirname: JSON.stringify(path.join(EXTENSION_ROOT, 'dist')) },
				bundle: true,
				outfile: extOutPath,
				platform: 'node',
				format: 'esm',
			});

			const paneStubPath = path.join(tmpDir, 'ade-pane-stub.mjs');
			fs.writeFileSync(paneStubPath, [
				'export class AdeEngineeringEditorInput {}',
				'export class AdeCloudHostsEditorInput {}',
				'export class AdeCloudHostsEditorPane {}',
			].join(' '));
			const wbOutPath = path.join(tmpDir, 'wb-w6-bundle.mjs');
			await esbuild.build({
				stdin: {
					contents: [
						"export { URI } from '../../src/vs/base/common/uri.ts';",
						"export { Emitter } from '../../src/vs/base/common/event.ts';",
						"export { CommandsRegistry, ICommandService } from '../../src/vs/platform/commands/common/commands.ts';",
						"export { IConfigurationService } from '../../src/vs/platform/configuration/common/configuration.ts';",
						"export { IAdeControlCenterService } from '../../src/vs/platform/ade/common/adeControlCenterIpc.ts';",
						"export { IChatService } from '../../src/vs/workbench/contrib/chat/common/chatService/chatService.ts';",
						"export { AdeOpenChatTicketScheduler, AdeOutboxBridgeContribution } from '../../src/vs/workbench/contrib/ade/browser/adeControlHandler.ts';",
						"export { AdeEditorService, AdeLineageChatEditorInput } from '../../src/vs/workbench/contrib/ade/browser/adeEditorService.ts';",
						"export { IAdeEditorService, parseAdeEmployeeSessionUri, buildAdeEmployeeSessionUri } from '../../src/vs/workbench/contrib/ade/common/ade.ts';",
					].join('\n'),
					resolveDir: EXTENSION_ROOT,
					loader: 'ts',
				},
				banner: {
					js: [
						"if (typeof globalThis.window === 'undefined') {",
						"  const noop = () => {};",
						"  globalThis.HTMLElement ??= class HTMLElement {};",
						"  globalThis.Element ??= globalThis.HTMLElement;",
						"  globalThis.Node ??= class Node {};",
						"  globalThis.MutationObserver ??= class { observe() {} disconnect() {} };",
						"  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };",
						"  globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };",
						"  globalThis.customElements ??= { define: noop, get: () => undefined };",
						"  const matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });",
						"  globalThis.window = Object.assign(globalThis, { vscodeWindowId: 1, addEventListener: noop, removeEventListener: noop, matchMedia, customElements: globalThis.customElements, location: { href: 'vscode-file://vscode-app/', origin: 'vscode-file://vscode-app', protocol: 'vscode-file:' }, setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16), cancelAnimationFrame: (id) => clearTimeout(id) });",
						"  globalThis.self = globalThis.window;",
						"  globalThis.document = { createElement: () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop }), createElementNS: () => ({ style: {}, setAttribute: noop, appendChild: noop }), createTextNode: () => ({}), createDocumentFragment: () => ({ appendChild: noop }), addEventListener: noop, removeEventListener: noop, body: { appendChild: noop, classList: { add: noop, remove: noop } }, head: { appendChild: noop }, documentElement: { style: {} }, querySelectorAll: () => [], getElementById: () => null };",
						"}",
					].join('\n'),
				},
				plugins: [{
					name: 'stub-heavy-panes',
					setup(build) {
						build.onResolve({ filter: /(adeEngineeringEditorPane|adeCloudHostsEditorPane)\.js$/ }, () => ({ path: paneStubPath }));
					},
				}],
				bundle: true,
				outfile: wbOutPath,
				platform: 'node',
				format: 'esm',
				loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.mp3': 'empty' },
			});

			const extMod = await import(pathToFileURL(extOutPath).href);
			const wbMod = await import(pathToFileURL(wbOutPath).href);
			return {
				...extMod,
				workbench: wbMod,
			} as Wave6SuiteBundle;
		})();
	}
	return cachedBundlePromise;
}

function createExecutableNodeScript(dir: string, name: string, jsBody: string): string {
	const scriptPath = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
	if (process.platform === 'win32') {
		const innerPath = path.join(dir, `${name}.cjs`);
		fs.writeFileSync(innerPath, `'use strict';\n${jsBody}\n`, 'utf8');
		fs.writeFileSync(scriptPath, `@echo off\r\n"${process.execPath}" "${innerPath}" %*\r\n`, 'utf8');
	} else {
		fs.writeFileSync(scriptPath, `#!${process.execPath}\n'use strict';\n${jsBody}\n`, { mode: 0o755 });
	}
	return scriptPath;
}

function createExtensionContextStub(vscodeMock: VscodeMockController) {
	const store = new Map<string, unknown>();
	const subscriptions: Array<{ dispose(): void }> = [];
	return {
		subscriptions,
		extensionPath: EXTENSION_ROOT,
		extensionUri: vscodeMock.createUri(`file://${EXTENSION_ROOT}`),
		globalState: {
			get: <T>(key: string, defaultVal?: T): T => (store.has(key) ? (store.get(key) as T) : (defaultVal as T)),
			update: async (key: string, val: unknown): Promise<void> => {
				store.set(key, structuredClone(val));
			},
		},
		store,
		disposeAll: () => {
			for (const sub of subscriptions.splice(0)) {
				try { sub.dispose(); } catch { /* ignore */ }
			}
		},
	};
}

describe('Wave 6 Track B Deep Closure Regression Suite', () => {
	test('[Defect B4] lossless double-hyphen -- URI parsing parity across parseAdeAgentResourceIds and parseAdeEmployeeSessionUri', async () => {
		const { parseAdeAgentResourceIds, workbench } = await loadWave6SuiteBundle();

		const matrix: Array<[string, string, string]> = [
			['ade-proj_a1b2c3d4--agent_5678ef01', 'proj_a1b2c3d4', 'agent_5678ef01'],
			['ade-proj_a1b2c3d4--worker_1', 'proj_a1b2c3d4', 'worker_1'],
			['ade-proj_a1b2c3d4-agent_5678ef01', 'proj_a1b2c3d4', 'agent_5678ef01'],
			['ade-proj_a1b2c3d4-worker_1', 'proj_a1b2c3d4', 'worker_1'],
			['ade-proj_a1b2c3d4::worker_1', 'proj_a1b2c3d4', 'worker_1'],
			['ade-my-hyphen-proj--custom-worker-node', 'my-hyphen-proj', 'custom-worker-node'],
		];

		for (const [rawId, expectedProjectId, expectedAgentId] of matrix) {
			const fullUri = `aexus-pi:/${rawId}`;
			assert.deepEqual(parseAdeAgentResourceIds(rawId), {
				projectId: expectedProjectId,
				agentId: expectedAgentId,
			});
			assert.deepEqual(parseAdeAgentResourceIds(`/${rawId}`), {
				projectId: expectedProjectId,
				agentId: expectedAgentId,
			});
			assert.deepEqual(parseAdeAgentResourceIds(fullUri), {
				projectId: expectedProjectId,
				agentId: expectedAgentId,
			});

			const wbParsed = workbench.parseAdeEmployeeSessionUri(workbench.URI.parse(fullUri));
			assert.deepEqual(wbParsed, {
				engine: 'pi',
				projectId: expectedProjectId,
				agentId: expectedAgentId,
			});
		}
	});

	test('[Defect B3] open-chat (Path A, Path B -> LiveTurnRunner mirror, and human turn) pi same-model steer uses native RPC {"type":"steer"} with ZERO abort, preserves history, falls back to abort+set_model on model switch, and fixes Path B queue->steer preemption closure', async () => {
		const suite = await loadWave6SuiteBundle();
		const { vscodeMock, workbench, activateExtension } = suite;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-w6-b3-pi-'));
		tempArtifactsToClean.push(tmpDir);
		const rpcLogPath = path.join(tmpDir, 'pi-w6-rpc.jsonl');
		const sessionJsonlPath = path.join(tmpDir, 'pi-w6-session.jsonl');

		const mockPiBin = createExecutableNodeScript(tmpDir, 'mock-pi-w6', `
const fs = require('node:fs');
const readline = require('node:readline');
const logEvent = (ev) => fs.appendFileSync(${JSON.stringify(rpcLogPath)}, JSON.stringify({ pid: process.pid, ts: Date.now(), ...ev }) + '\\n');
const appendJsonl = (entry) => fs.appendFileSync(${JSON.stringify(sessionJsonlPath)}, JSON.stringify(entry) + '\\n');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

let currentModel = 'default';
const modelIdx = process.argv.indexOf('--model');
if (modelIdx >= 0 && process.argv[modelIdx + 1]) {
	currentModel = process.argv[modelIdx + 1];
}
if (!fs.existsSync(${JSON.stringify(sessionJsonlPath)})) {
	appendJsonl({ type: 'session', id: 'pi_native_w6', cwd: process.cwd(), timestamp: new Date().toISOString() });
}
logEvent({ event: 'spawn', argv: process.argv.slice(2), initialModel: currentModel });

let activeHoldTimer = null;
let entrySeq = 0;

const finishTurn = (textOut) => {
	if (activeHoldTimer) {
		clearTimeout(activeHoldTimer);
		activeHoldTimer = null;
	}
	appendJsonl({ id: 'm_' + (++entrySeq), type: 'message', message: { role: 'assistant', content: textOut } });
	send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: textOut } });
	send({ type: 'agent_end', messages: [{ role: 'assistant', model: currentModel, usage: { input_tokens: 8, output_tokens: 6 } }] });
	send({ type: 'agent_settled' });
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const cmd = JSON.parse(line);
	logEvent({ event: 'rpc', type: cmd.type, message: cmd.message, provider: cmd.provider, modelId: cmd.modelId, level: cmd.level });

	if (cmd.type === 'get_state') {
		send({ type: 'response', id: cmd.id, command: 'get_state', success: true, data: { sessionFile: ${JSON.stringify(sessionJsonlPath)}, model: currentModel } });
		return;
	}
	if (cmd.type === 'get_available_models') {
		send({
			type: 'response',
			id: cmd.id,
			command: 'get_available_models',
			success: true,
			data: {
				models: [
					{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
					{ provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
					{ provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4' },
				],
			},
		});
		return;
	}
	if (cmd.type === 'set_model') {
		currentModel = cmd.provider ? (cmd.provider + '/' + cmd.modelId) : cmd.modelId;
		send({ type: 'response', id: cmd.id, command: 'set_model', success: true, data: { model: currentModel } });
		return;
	}
	if (cmd.type === 'set_thinking_level' || cmd.type === 'clear_queue') {
		send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} });
		return;
	}
	if (cmd.type === 'abort') {
		if (activeHoldTimer) {
			clearTimeout(activeHoldTimer);
			activeHoldTimer = null;
			setTimeout(() => {
				logEvent({ event: 'abort_flushed' });
				send({ type: 'agent_end', messages: [] });
				send({ type: 'agent_settled' });
			}, 40);
		}
		send({ type: 'response', id: cmd.id, command: 'abort', success: true, data: {} });
		return;
	}
	if (cmd.type === 'prompt') {
		appendJsonl({ id: 'u_' + (++entrySeq), type: 'message', message: { role: 'user', content: String(cmd.message || '') } });
		send({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: {} });
		send({ type: 'agent_start' });
		const holdMatch = /\\[HOLD_MS:(\\d+)\\]/.exec(String(cmd.message || ''));
		if (holdMatch) {
			const ms = Number(holdMatch[1]);
			send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '[started:' + process.pid + ':' + currentModel + ']' } });
			activeHoldTimer = setTimeout(() => {
				activeHoldTimer = null;
				finishTurn('[completed:' + process.pid + ':' + currentModel + ']');
			}, ms);
		} else {
			finishTurn('[reply:' + process.pid + ':' + currentModel + ':' + String(cmd.message || '').split('\\n').at(-1).replace('summary: ', '') + ']');
		}
		return;
	}
	if (cmd.type === 'steer') {
		if (!activeHoldTimer) {
			send({ type: 'response', id: cmd.id, command: 'steer', success: false, error: 'Not streaming' });
			return;
		}
		// Simulate real pi where in-stream steer relies on extension synthetic history until later flush
		send({ type: 'response', id: cmd.id, command: 'steer', success: true, data: {} });
		clearTimeout(activeHoldTimer);
		activeHoldTimer = setTimeout(() => {
			activeHoldTimer = null;
			finishTurn('[steered:' + process.pid + ':' + currentModel + ':' + String(cmd.message || '').split('\\n').at(-1).replace('summary: ', '') + ']');
		}, 120);
		return;
	}
	send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} });
});
`);

		const savedPath = process.env.PATH;
		process.env.PATH = '';
		vscodeMock.resetForActivation();
		vscodeMock.autonomousMode = true;
		vscodeMock.cliPaths = { pi: mockPiBin };

		const ctx = createExtensionContextStub(vscodeMock);
		try {
			await activateExtension(ctx);

			const agentState = {
				agent_id: 'agent_pi_b3',
				name: 'Pi Stream Worker',
				host: 'local',
				engine: 'pi',
				model: 'anthropic/claude-sonnet-4-6',
				effort: 'medium',
				session_phase: 'unstarted' as 'unstarted' | 'starting' | 'started',
				session_started: false,
				session_resource: 'aexus-pi:/ade-proj_b3-agent_pi_b3',
				native_session_id: undefined as string | undefined,
			};

			const onChangeProject = new workbench.Emitter<{ readonly projectId: string }>();
			const onEnqueueOutbox = new workbench.Emitter<{ readonly projectId: string; readonly targetAgentId: string }>();
			const onCancelOutbox = new workbench.Emitter<{ readonly projectId: string; readonly ticketIds: readonly string[] }>();
			const onDisposeRuntime = new workbench.Emitter<Record<string, unknown>>();

			interface OutboxRow {
				deliveryId: string;
				projectId: string;
				targetAgentId: string;
				ticketId: string;
				taskId: string;
				deliveryMode: 'queue' | 'steer';
				payloadText: string;
				state: 'pending' | 'in_flight' | 'blocked_cli';
			}
			const outbox = new Map<string, OutboxRow>();
			const ackOrder: string[] = [];

			interface LiveChatModelHarness {
				uriStr: string;
				busy: boolean;
				lastPromptText: string;
				lastReqId: string;
				activeCts?: ReturnType<VscodeMockController['createCts']>;
				interruptFn?: () => Promise<void>;
				onChange: InstanceType<Wave6SuiteBundle['workbench']['Emitter']>;
				onDispose: InstanceType<Wave6SuiteBundle['workbench']['Emitter']>;
				providedSession?: Awaited<ReturnType<NonNullable<ReturnType<VscodeMockController['contentProviders']['get']>>['provideChatSessionContent']>>;
				streamedChunks: string[];
			}
			const openChats = new Map<string, LiveChatModelHarness>();
			let cancelSessionCalls = 0;
			let reqCounter = 0;

			const mockChatService = {
				getSession: (uri: { toString(): string }) => {
					const h = openChats.get(uri.toString());
					if (!h) {
						return undefined;
					}
					return {
						sessionResource: uri,
						lastRequest: h.lastPromptText ? {
							id: h.lastReqId,
							message: { text: h.lastPromptText },
							response: {
								isComplete: !h.busy,
								onDidChange: (fn: () => void) => h.onChange.event(fn),
							},
						} : undefined,
						hasActiveRequest: {
							get: () => h.busy,
							read: () => h.busy,
						},
						requestInProgress: {
							get: () => h.busy,
							read: () => h.busy,
						},
						onDidDispose: h.onDispose.event,
						onDidChange: h.onChange.event,
					};
				},
				sendRequest: async (uri: { toString(): string }, message: string) => {
					const h = openChats.get(uri.toString());
					if (!h?.providedSession?.requestHandler) {
						return { kind: 'rejected' as const, reason: 'No session' };
					}
					if (h.busy) {
						return { kind: 'rejected' as const, reason: 'Request already in progress' };
					}
					h.busy = true;
					h.lastPromptText = message;
					h.lastReqId = `req_${++reqCounter}`;
					const reqCts = vscodeMock.createCts();
					h.activeCts = reqCts;
					let isCanceled = false;
					reqCts.token.onCancellationRequested(() => { isCanceled = true; });
					const streamProxy = {
						markdown: (v: unknown) => {
							const txt = typeof v === 'string' ? v : String((v as { value?: unknown })?.value ?? '');
							h.streamedChunks.push(txt);
						},
						progress: () => { },
						thinkingProgress: () => { },
						push: () => { },
					};
					const completePromise = (async () => {
						try {
							await h.providedSession!.requestHandler!(
								{ prompt: message, references: [] },
								{},
								streamProxy,
								reqCts.token,
							);
						} finally {
							h.busy = false;
							h.activeCts = undefined;
							reqCts.dispose();
							h.onChange.fire({ kind: 'completedRequest' });
						}
					})();
					return {
						kind: 'sent' as const,
						data: {
							responseCreatedPromise: completePromise.then(() => ({ isCanceled, state: 1 })),
							responseCompletePromise: completePromise,
						},
					};
				},
				cancelCurrentRequestForSession: async (uri: { toString(): string }) => {
					cancelSessionCalls++;
					const h = openChats.get(uri.toString());
					if (h?.activeCts) {
						h.activeCts.cancel();
					}
					if (h?.interruptFn) {
						await h.interruptFn();
					}
				},
			};

			const mockControlCenter = {
				onDidChangeProject: onChangeProject.event,
				onDidEnqueueOutbox: onEnqueueOutbox.event,
				onDidCancelOutboxTickets: onCancelOutbox.event,
				onDidDisposeAgentRuntime: onDisposeRuntime.event,
				getProjectSnapshot: async () => ({
					meta: { project_id: 'proj_b3', folder_uri: `file://${tmpDir}` },
					hosts: [],
					agents: [{ ...agentState }],
				}),
				issueAgentLaunchBundle: async () => ({
					projectId: 'proj_b3',
					agentId: agentState.agent_id,
					level: 2,
					name: agentState.name,
					host: 'local',
					engine: agentState.engine,
					model: agentState.model,
					effort: agentState.effort,
					workspaceCwd: tmpDir,
					sessionResource: agentState.session_resource,
					nativeSessionId: agentState.native_session_id,
					agentToken: 'ades1.jti_b3.secret',
					controlSocketPath: path.join(tmpDir, 'ade.sock'),
				}),
				markAgentSessionStarting: async (_p: string, _a: string, res?: string) => {
					if (agentState.session_phase !== 'started') agentState.session_phase = 'starting';
					agentState.session_started = true;
					if (res) agentState.session_resource = res;
				},
				markAgentSessionStarted: async (_p: string, _a: string, info: { sessionResource?: string; nativeSessionId?: string }) => {
					agentState.session_phase = 'started';
					agentState.session_started = true;
					if (info.sessionResource) agentState.session_resource = info.sessionResource;
					if (info.nativeSessionId) agentState.native_session_id = info.nativeSessionId;
				},
				rollbackUnstartedIfCliMissing: async () => false,
				claimPendingDeliveries: async () => {
					const out: OutboxRow[] = [];
					for (const item of outbox.values()) {
						if (item.state === 'pending') {
							item.state = 'in_flight';
							out.push({ ...item });
						}
					}
					return out;
				},
				ackDeliveryDispatched: async (deliveryId: string) => {
					ackOrder.push(deliveryId);
					outbox.delete(deliveryId);
				},
				nackDeliveryFailed: async (deliveryId: string, _w: number, _e: string, cliMissing?: boolean) => {
					const row = outbox.get(deliveryId);
					if (row) row.state = cliMissing ? 'blocked_cli' : 'pending';
				},
				releaseWindowDeliveries: async () => { },
				requeueBlockedCliDeliveries: async () => ({ requeuedCount: 0 }),
			};

			const accessor = {
				get: (serviceId: unknown) => {
					if (serviceId === workbench.IAdeControlCenterService) return mockControlCenter;
					if (serviceId === workbench.IChatService) return mockChatService;
					if (serviceId === workbench.ICommandService) return commandBridge;
					throw new Error('Service not bound');
				},
			};

			const commandBridge = {
				executeCommand: async (id: string, ...args: unknown[]) => {
					if (id === 'aexus.ade.getWindowId') return 3;
					const extFn = vscodeMock.registeredCommands.get(id);
					if (extFn) return await extFn(...args);
					const wbCmd = workbench.CommandsRegistry.getCommand(id);
					if (wbCmd) return await wbCmd.handler(accessor, ...args);
					return undefined;
				},
			};

			vscodeMock.registeredCommands.set('aexus.ade.resolveEmployeeSessionMeta', async () => ({
				name: agentState.name,
				engine: agentState.engine,
				sessionStarted: agentState.session_started,
				workspaceCwdUri: `file://${tmpDir}`,
				model: agentState.model,
				effort: agentState.effort,
				nativeSessionId: agentState.native_session_id,
			}));
			vscodeMock.registeredCommands.set('aexus.ade.issueAgentLaunchBundle', async () => mockControlCenter.issueAgentLaunchBundle());
			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarted', async (_p: unknown, _a: unknown, sid: unknown) => {
				await mockControlCenter.markAgentSessionStarted('proj_b3', agentState.agent_id, { nativeSessionId: String(sid) });
			});
			for (const wbCmdId of ['aexus.ade.trySendOpenChatRequest']) {
				vscodeMock.registeredCommands.set(wbCmdId, (...args: unknown[]) => {
					const wbCmd = workbench.CommandsRegistry.getCommand(wbCmdId);
					return wbCmd?.handler(accessor, ...args);
				});
			}

			const mkTicket = (tid: string, taskId: string, body: string) =>
				`${ADE_TICKET_MESSAGE_PREFIX_START}agent_l1_boss}的Ticket] \nticket_id: ${tid} | task_id: ${taskId} | task_type: dev | need_return: true\nsummary: ${body}`;

			const openTabForSession = async (uriStr: string) => {
				const piProvider = vscodeMock.contentProviders.get('aexus-pi')!;
				const cts = vscodeMock.createCts();
				const provided = await piProvider.provideChatSessionContent(vscodeMock.createUri(uriStr), cts.token);
				const harness: LiveChatModelHarness = {
					uriStr,
					busy: Boolean(provided.activeResponseCallback),
					lastPromptText: provided.history.at(-1)?.prompt ?? '',
					lastReqId: `req_init_${++reqCounter}`,
					interruptFn: provided.interruptActiveResponse,
					onChange: new workbench.Emitter(),
					onDispose: new workbench.Emitter(),
					providedSession: provided,
					streamedChunks: [],
				};
				openChats.set(uriStr, harness);
				if (provided.activeResponseCallback) {
					const attachCts = vscodeMock.createCts();
					harness.activeCts = attachCts;
					void provided.activeResponseCallback({
						markdown: (v: unknown) => {
							harness.streamedChunks.push(typeof v === 'string' ? v : String((v as { value?: unknown })?.value ?? ''));
						},
						progress: () => { },
						thinkingProgress: () => { },
						push: () => { },
					}, attachCts.token).finally(() => {
						harness.busy = false;
						harness.activeCts = undefined;
						harness.interruptFn = undefined;
						attachCts.dispose();
						harness.onChange.fire({ kind: 'completedRequest' });
					});
				}
				return { harness, closeTab: () => { openChats.delete(uriStr); provided.dispose(); cts.dispose(); } };
			};

			const bridge = new workbench.AdeOutboxBridgeContribution(commandBridge, {
				invokeFunction: fn => fn(accessor),
			});

			try {
				// === 3A. Pure Path A open chat: same-model steer uses native {"type":"steer"} with ZERO cancelCurrentRequestForSession & immediate ack! ===
				const tabA = await openTabForSession(agentState.session_resource);
				outbox.set('dlv_3a_1', {
					deliveryId: 'dlv_3a_1',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3a_1',
					taskId: 'tsk_3a_1',
					deliveryMode: 'queue',
					payloadText: mkTicket('tk_3a_1', 'tsk_3a_1', 'pathA-turn-1 [HOLD_MS:900]'),
					state: 'pending',
				});
				await bridge.pumpOutbox();

				const waitStart3A = Date.now() + 3000;
				while (!tabA.harness.streamedChunks.join('').includes('[started:') && Date.now() < waitStart3A) {
					await new Promise<void>(r => setTimeout(r, 15));
				}
				assert.equal(tabA.harness.busy, true, 'Path A turn 1 must be actively streaming');

				outbox.set('dlv_3a_2', {
					deliveryId: 'dlv_3a_2',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3a_2',
					taskId: 'tsk_3a_2',
					deliveryMode: 'steer',
					payloadText: mkTicket('tk_3a_2', 'tsk_3a_2', 'pathA-same-model-steer'),
					state: 'pending',
				});
				onEnqueueOutbox.fire({ projectId: 'proj_b3', targetAgentId: agentState.agent_id });

				const waitSteerAck = Date.now() + 2000;
				while (!ackOrder.includes('dlv_3a_2') && Date.now() < waitSteerAck) {
					await new Promise<void>(r => setTimeout(r, 10));
				}
				assert.equal(ackOrder[0], 'dlv_3a_2', 'In-stream native steer MUST immediately ack deliveryId while original Path A turn continues');
				assert.equal(cancelSessionCalls, 0, 'Same-model pi steer in open chat MUST NOT call cancelCurrentRequestForSession');

				await bridge.flushOutboxForTest();
				assert.deepEqual(ackOrder, ['dlv_3a_2', 'dlv_3a_1']);
				const joinedStream3A = tabA.harness.streamedChunks.join('');
				assert.equal(joinedStream3A.includes('Steer Ticket from'), true, 'Active stream must display lightweight steer separator');
				assert.equal(joinedStream3A.includes('pathA-same-model-steer]'), true, 'Active stream must continue smoothly with steered output');

				// Close & reopen tab -> verify injected Steer Ticket is preserved in session history!
				tabA.closeTab();
				const reopenedTab = await openTabForSession(agentState.session_resource);
				const userPromptsInHistory = reopenedTab.harness.providedSession!.history
					.filter(t => typeof t.prompt === 'string')
					.map(t => t.prompt!);
				assert.equal(
					userPromptsInHistory.some(p => p.includes('tk_3a_2') && p.includes('pathA-same-model-steer')),
					true,
					'Reopening chat tab MUST retain injected native steer Ticket in history',
				);

				// === 3B. Active HUMAN pi turn in open chat: same-model steer injects in-stream without cancelling human turn! ===
				await mockChatService.sendRequest(
					workbench.URI.parse(agentState.session_resource),
					'Human direct pi prompt [HOLD_MS:900]',
				);
				const waitHumanStart = Date.now() + 3000;
				while (!reopenedTab.harness.streamedChunks.join('').includes('[started:') && Date.now() < waitHumanStart) {
					await new Promise<void>(r => setTimeout(r, 15));
				}
				outbox.set('dlv_3b_human_steer', {
					deliveryId: 'dlv_3b_human_steer',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3b_1',
					taskId: 'tsk_3b_1',
					deliveryMode: 'steer',
					payloadText: mkTicket('tk_3b_1', 'tsk_3b_1', 'steer-into-human-pi-turn'),
					state: 'pending',
				});
				onEnqueueOutbox.fire({ projectId: 'proj_b3', targetAgentId: agentState.agent_id });
				await bridge.flushOutboxForTest();
				assert.equal(ackOrder.includes('dlv_3b_human_steer'), true);
				assert.equal(cancelSessionCalls, 0, 'Same-model steer during human pi turn must NOT cancel request');
				const waitHumanFinish = Date.now() + 3000;
				while (reopenedTab.harness.busy && Date.now() < waitHumanFinish) {
					await new Promise<void>(r => setTimeout(r, 15));
				}
				assert.equal(reopenedTab.harness.streamedChunks.join('').includes('steer-into-human-pi-turn]'), true);
				reopenedTab.closeTab();

				// === 3C. Path B headless turn mirrored into open chat via LiveTurnRunner: same-model steer uses native {"type":"steer"} with ZERO cancel! ===
				outbox.set('dlv_3c_bg', {
					deliveryId: 'dlv_3c_bg',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3c_1',
					taskId: 'tsk_3c_1',
					deliveryMode: 'queue',
					payloadText: mkTicket('tk_3c_1', 'tsk_3c_1', 'pathB-mirrored-turn [HOLD_MS:1000]'),
					state: 'pending',
				});
				await bridge.pumpOutbox();
				const waitBgStart = Date.now() + 3000;
				while (Date.now() < waitBgStart) {
					const lines = fs.existsSync(rpcLogPath) ? fs.readFileSync(rpcLogPath, 'utf8') : '';
					if (lines.includes('pathB-mirrored-turn')) break;
					await new Promise<void>(r => setTimeout(r, 15));
				}
				await new Promise<void>(r => setTimeout(r, 40));

				const mirroredTab = await openTabForSession(agentState.session_resource);
				assert.equal(mirroredTab.harness.busy, true, 'Mirrored Path B LiveTurnRunner turn must appear active in open chat');

				outbox.set('dlv_3c_steer', {
					deliveryId: 'dlv_3c_steer',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3c_2',
					taskId: 'tsk_3c_2',
					deliveryMode: 'steer',
					payloadText: mkTicket('tk_3c_2', 'tsk_3c_2', 'mirrored-same-model-steer'),
					state: 'pending',
				});
				onEnqueueOutbox.fire({ projectId: 'proj_b3', targetAgentId: agentState.agent_id });
				await bridge.flushOutboxForTest();

				assert.equal(ackOrder.includes('dlv_3c_steer'), true);
				assert.equal(ackOrder.includes('dlv_3c_bg'), true);
				assert.equal(cancelSessionCalls, 0, 'Same-model steer on LiveTurnRunner mirrored pi turn MUST NOT call cancelCurrentRequestForSession');
				assert.equal(mirroredTab.harness.streamedChunks.join('').includes('mirrored-same-model-steer]'), true);

				const logBeforeModelSwitch = fs.readFileSync(rpcLogPath, 'utf8')
					.trim()
					.split('\n')
					.map(l => JSON.parse(l) as { pid: number; event: string; type?: string });
				assert.equal(
					logBeforeModelSwitch.some(e => e.event === 'rpc' && e.type === 'abort'),
					false,
					'All same-model steers across Path A, Human, and Mirrored Path B MUST emit ZERO abort RPCs',
				);

				// === 3D. Open-chat Path A Ticket turn + HOT MODEL SWITCH steer -> tryNativeInStreamSteer returns {steered:false} -> cancelCurrentRequestForSession -> abort -> flush -> set_model! ===
				outbox.set('dlv_3d_1', {
					deliveryId: 'dlv_3d_1',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3d_1',
					taskId: 'tsk_3d_1',
					deliveryMode: 'queue',
					payloadText: mkTicket('tk_3d_1', 'tsk_3d_1', 'before-hot-switch [HOLD_MS:900]'),
					state: 'pending',
				});
				mirroredTab.harness.streamedChunks.length = 0;
				await bridge.pumpOutbox();
				const wait3D = Date.now() + 3000;
				while (!mirroredTab.harness.streamedChunks.join('').includes('[started:') && Date.now() < wait3D) {
					await new Promise<void>(r => setTimeout(r, 15));
				}

				agentState.model = 'openai/gpt-5.4';
				onChangeProject.fire({ projectId: 'proj_b3' });
				await new Promise<void>(r => setTimeout(r, 25));

				outbox.set('dlv_3d_2', {
					deliveryId: 'dlv_3d_2',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3d_2',
					taskId: 'tsk_3d_2',
					deliveryMode: 'steer',
					payloadText: mkTicket('tk_3d_2', 'tsk_3d_2', 'after-hot-model-switch'),
					state: 'pending',
				});
				onEnqueueOutbox.fire({ projectId: 'proj_b3', targetAgentId: agentState.agent_id });
				await bridge.flushOutboxForTest();

				assert.equal(cancelSessionCalls >= 1, true, 'Model-switch steer MUST fall back to cancelCurrentRequestForSession');
				assert.equal(
					mirroredTab.harness.streamedChunks.join('').includes('openai/gpt-5.4:after-hot-model-switch]'),
					true,
					`Expected hot-switched model output, got: ${JSON.stringify(mirroredTab.harness.streamedChunks.join(''))}`,
				);
				mirroredTab.closeTab();

				// === 3E. Headless Path B 'queue' turn preempted by incoming 'steer' turn closure fix ===
				const logCountBefore3E = fs.readFileSync(rpcLogPath, 'utf8').trim().split('\n').length;
				outbox.set('dlv_3e_q', {
					deliveryId: 'dlv_3e_q',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3e_1',
					taskId: 'tsk_3e_1',
					deliveryMode: 'queue',
					payloadText: mkTicket('tk_3e_1', 'tsk_3e_1', 'headless-queue-turn [HOLD_MS:900]'),
					state: 'pending',
				});
				await bridge.pumpOutbox();
				const wait3E = Date.now() + 3000;
				while (Date.now() < wait3E) {
					const lines = fs.readFileSync(rpcLogPath, 'utf8');
					if (lines.includes('headless-queue-turn')) break;
					await new Promise<void>(r => setTimeout(r, 15));
				}
				await new Promise<void>(r => setTimeout(r, 30));

				outbox.set('dlv_3e_s', {
					deliveryId: 'dlv_3e_s',
					projectId: 'proj_b3',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_3e_2',
					taskId: 'tsk_3e_2',
					deliveryMode: 'steer',
					payloadText: mkTicket('tk_3e_2', 'tsk_3e_2', 'headless-incoming-steer'),
					state: 'pending',
				});
				onEnqueueOutbox.fire({ projectId: 'proj_b3', targetAgentId: agentState.agent_id });
				await bridge.flushOutboxForTest();

				const slice3E = fs.readFileSync(rpcLogPath, 'utf8')
					.trim()
					.split('\n')
					.slice(logCountBefore3E)
					.map(l => JSON.parse(l) as { pid: number; event: string; type?: string });
				assert.equal(slice3E.some(e => e.event === 'rpc' && e.type === 'steer'), true, 'Path B queue turn preempted by same-model steer must invoke prepareSteerPreemption -> native steer');
				assert.equal(slice3E.some(e => e.event === 'rpc' && e.type === 'abort'), false, 'Path B queue->steer same-model preemption must NOT emit abort');

				const allEvents = fs.readFileSync(rpcLogPath, 'utf8')
					.trim()
					.split('\n')
					.map(l => JSON.parse(l) as { pid: number; event: string; argv?: string[] });
				const sessionDaemonSpawns = allEvents.filter(
					e => e.event === 'spawn' && Array.isArray(e.argv) && (e.argv.includes('--session-id') || e.argv.includes('--session')),
				);
				assert.equal(sessionDaemonSpawns.length, 1, 'Single persistent pi session daemon process reused across all 3A-3E scenarios');

				await commandBridge.executeCommand('aexus.agentEngines.disposeAgentRuntime', {
					projectId: 'proj_b3',
					agentId: agentState.agent_id,
					sessionResource: agentState.session_resource,
				});
			} finally {
				bridge.dispose();
			}
		} finally {
			ctx.disposeAll();
			process.env.PATH = savedPath;
		}
	});

	test('[Defect B2 & B1] unstarted employee engine switch migrates cache + rebinds open tab + supports transient URI fallback, and cliMissing throttles toast + auto-replays on aexus.agentEngines config change', async () => {
		const suite = await loadWave6SuiteBundle();
		const { vscodeMock, workbench, activateExtension } = suite;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-w6-b2b1-'));
		tempArtifactsToClean.push(tmpDir);
		const mockClaudeBin = createExecutableNodeScript(tmpDir, 'mock-claude-w6', `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.type === 'user') {
		const txt = typeof msg.message?.content === 'string' ? msg.message.content : '';
		process.stdout.write(JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'claude-rebound:' + txt.split('\\n').at(-1) }] },
		}) + '\\n');
		process.stdout.write(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'ok',
			usage: { input_tokens: 6, output_tokens: 4 },
		}) + '\\n');
		process.exit(0);
	}
});
`);

		const savedPath = process.env.PATH;
		process.env.PATH = '';
		vscodeMock.resetForActivation();
		vscodeMock.autonomousMode = true;
		vscodeMock.cliPaths = {
			kilo: path.join(tmpDir, 'missing-kilo-bin'),
			claude: path.join(tmpDir, 'missing-claude-initially'),
		};

		const ctx = createExtensionContextStub(vscodeMock);
		try {
			await activateExtension(ctx);

			const agent1 = {
				agent_id: 'agent_1',
				name: 'Worker One',
				host: 'local',
				engine: 'kilo',
				model: 'claude-sonnet-4-6',
				effort: 'high',
				session_phase: 'unstarted' as 'unstarted' | 'starting' | 'started',
				session_started: false,
				session_resource: 'aexus-kilo:/ade-proj_1-agent_1',
				native_session_id: undefined as string | undefined,
			};

			const onChangeProject = new workbench.Emitter<{ readonly projectId: string }>();
			const onEnqueueOutbox = new workbench.Emitter<{ readonly projectId: string; readonly targetAgentId: string }>();
			const onCancelOutbox = new workbench.Emitter<{ readonly projectId: string; readonly ticketIds: readonly string[] }>();
			const onDisposeRuntime = new workbench.Emitter<Record<string, unknown>>();
			const onDidChangeConfiguration = new workbench.Emitter<{ affectsConfiguration(section: string): boolean }>();

			const reboundCalls: Array<{ projectId?: string; newEngine?: string }> = [];
			const mockAdeEditors = {
				rebindUnstartedAgentEditors: async (projectId?: string, snapshot?: { agents: ReadonlyArray<{ engine: string }> }) => {
					reboundCalls.push({ projectId, newEngine: snapshot?.agents[0]?.engine });
					return 1;
				},
			};

			interface OutboxRow {
				deliveryId: string;
				projectId: string;
				targetAgentId: string;
				ticketId: string;
				taskId: string;
				deliveryMode: 'queue' | 'steer';
				payloadText: string;
				state: 'pending' | 'in_flight' | 'blocked_cli';
			}
			const outbox = new Map<string, OutboxRow>();
			const acked: string[] = [];
			let requeueCalls = 0;

			const mockControlCenter = {
				onDidChangeProject: onChangeProject.event,
				onDidEnqueueOutbox: onEnqueueOutbox.event,
				onDidCancelOutboxTickets: onCancelOutbox.event,
				onDidDisposeAgentRuntime: onDisposeRuntime.event,
				getProjectSnapshot: async () => ({
					meta: { project_id: 'proj_1', folder_uri: `file://${tmpDir}` },
					hosts: [],
					agents: [{ ...agent1 }],
				}),
				issueAgentLaunchBundle: async () => ({
					projectId: 'proj_1',
					agentId: agent1.agent_id,
					level: 2,
					name: agent1.name,
					host: 'local',
					engine: agent1.engine,
					model: agent1.model,
					effort: agent1.effort,
					workspaceCwd: tmpDir,
					sessionResource: agent1.session_resource,
					nativeSessionId: agent1.native_session_id,
					agentToken: 'ades1.jti_b2.secret',
					controlSocketPath: path.join(tmpDir, 'ade.sock'),
				}),
				markAgentSessionStarting: async () => {
					if (agent1.session_phase !== 'started') agent1.session_phase = 'starting';
					agent1.session_started = true;
				},
				markAgentSessionStarted: async (_p: string, _a: string, info: { sessionResource?: string; nativeSessionId?: string }) => {
					agent1.session_phase = 'started';
					agent1.session_started = true;
					if (info.sessionResource) agent1.session_resource = info.sessionResource;
					if (info.nativeSessionId) agent1.native_session_id = info.nativeSessionId;
				},
				rollbackUnstartedIfCliMissing: async () => {
					if (agent1.session_phase !== 'starting') return false;
					agent1.session_phase = 'unstarted';
					agent1.session_started = false;
					return true;
				},
				claimPendingDeliveries: async () => {
					const out: OutboxRow[] = [];
					for (const r of outbox.values()) {
						if (r.state === 'pending') {
							r.state = 'in_flight';
							out.push({ ...r });
						}
					}
					return out;
				},
				ackDeliveryDispatched: async (id: string) => {
					acked.push(id);
					outbox.delete(id);
				},
				nackDeliveryFailed: async (id: string, _w: number, _e: string, cliMissing?: boolean) => {
					const r = outbox.get(id);
					if (r) r.state = cliMissing ? 'blocked_cli' : 'pending';
				},
				releaseWindowDeliveries: async () => { },
				requeueBlockedCliDeliveries: async () => {
					requeueCalls++;
					let requeuedCount = 0;
					for (const r of outbox.values()) {
						if (r.state === 'blocked_cli') {
							r.state = 'pending';
							requeuedCount++;
							onEnqueueOutbox.fire({ projectId: r.projectId, targetAgentId: r.targetAgentId });
						}
					}
					return { requeuedCount };
				},
			};

			const mockConfigService = {
				onDidChangeConfiguration: onDidChangeConfiguration.event,
			};

			const accessor = {
				get: (serviceId: unknown) => {
					if (serviceId === workbench.IAdeControlCenterService) return mockControlCenter;
					if (serviceId === workbench.IConfigurationService) return mockConfigService;
					if (serviceId === workbench.IAdeEditorService) return mockAdeEditors;
					if (serviceId === workbench.ICommandService) return commandBridge;
					throw new Error('Optional service not bound');
				},
			};

			const commandBridge = {
				executeCommand: async (id: string, ...args: unknown[]) => {
					if (id === 'aexus.ade.getWindowId') return 5;
					const extFn = vscodeMock.registeredCommands.get(id);
					if (extFn) return await extFn(...args);
					const wbCmd = workbench.CommandsRegistry.getCommand(id);
					if (wbCmd) return await wbCmd.handler(accessor, ...args);
					return undefined;
				},
			};

			vscodeMock.registeredCommands.set('aexus.ade.resolveEmployeeSessionMeta', async () => ({
				name: agent1.name,
				engine: agent1.engine,
				sessionStarted: agent1.session_started,
				workspaceCwdUri: `file://${tmpDir}`,
				model: agent1.model,
				effort: agent1.effort,
				nativeSessionId: agent1.native_session_id,
			}));
			vscodeMock.registeredCommands.set('aexus.ade.issueAgentLaunchBundle', async () => mockControlCenter.issueAgentLaunchBundle());
			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarted', async (_p: unknown, _a: unknown, sid: unknown) => {
				await mockControlCenter.markAgentSessionStarted('proj_1', agent1.agent_id, { nativeSessionId: String(sid) });
			});

			const bridge = new workbench.AdeOutboxBridgeContribution(commandBridge, {
				invokeFunction: fn => fn(accessor),
			});

			try {
				// 1. User opens unstarted `aexus-kilo:/ade-proj_1-agent_1` tab
				const kiloProvider = vscodeMock.contentProviders.get('aexus-kilo')!;
				const oldKiloUri = vscodeMock.createUri('aexus-kilo:/ade-proj_1-agent_1');
				const cts = vscodeMock.createCts();
				const providedKilo = await kiloProvider.provideChatSessionContent(oldKiloUri, cts.token);
				assert.equal(providedKilo.title, 'Worker One');
				assert.equal(vscodeMock.itemControllers.get('aexus-kilo')?.itemsMap.has('aexus-kilo:/ade-proj_1-agent_1'), true);

				// 2. Canvas / supervisor edits unstarted `agent_1` engine from `kilo` -> `claude`!
				agent1.engine = 'claude';
				agent1.session_resource = 'aexus-claude:/ade-proj_1-agent_1';

				const syncRes = await commandBridge.executeCommand('aexus.ade.syncCachedEmployeeMeta', {
					projectId: 'proj_1',
					agents: [{
						agentId: 'agent_1',
						name: agent1.name,
						engine: 'claude',
						model: agent1.model,
						effort: agent1.effort,
						sessionStarted: false,
						sessionResource: agent1.session_resource,
						workspaceCwdUri: `file://${tmpDir}`,
					}],
				}) as { updated: boolean; previousEngine?: string; currentEngine?: string };

				assert.equal(syncRes.updated, true);
				assert.equal(syncRes.previousEngine, 'kilo');
				assert.equal(syncRes.currentEngine, 'claude');

				assert.equal(vscodeMock.itemControllers.get('aexus-kilo')?.itemsMap.has('aexus-kilo:/ade-proj_1-agent_1'), false, 'Orphan kilo session item must be cleaned up');
				assert.equal(vscodeMock.itemControllers.get('aexus-claude')?.itemsMap.has('aexus-claude:/ade-proj_1-agent_1'), true, 'Migrated claude session item must be registered');
				const persistedAfterMigrate = ctx.store.get('nativeSessions') as Record<string, { engine: string }>;
				assert.equal(Object.keys(persistedAfterMigrate).some(k => k.startsWith('kilo:')), false, 'Orphan kilo record key must be removed');
				assert.equal(Object.keys(persistedAfterMigrate).includes('claude:ade-proj_1-agent_1'), true);

				// Transient window fallback: calling `info` and `stop` with stale `oldKiloUri` resolves migrated `claude` record cleanly!
				const fallbackInfo = await commandBridge.executeCommand('aexus.agentEngines.info', oldKiloUri) as { engine: string; adeAgentId: string };
				assert.equal(fallbackInfo.engine, 'claude');
				assert.equal(fallbackInfo.adeAgentId, 'agent_1');
				const fallbackStop = await commandBridge.executeCommand('aexus.agentEngines.stop', oldKiloUri) as { stopped: boolean };
				assert.equal(typeof fallbackStop.stopped, 'boolean');

				onChangeProject.fire({ projectId: 'proj_1' });
				await new Promise<void>(r => setTimeout(r, 30));
				assert.equal(reboundCalls.some(c => c.projectId === 'proj_1' && c.newEngine === 'claude'), true);
				providedKilo.dispose();

				// 3. [Defect B1] Dispatch two Tickets while `claude` CLI binary is missing -> enters `blocked_cli`, emits deduplicated warning!
				vscodeMock.warningMessages.length = 0;
				const ticket1 = `${ADE_TICKET_MESSAGE_PREFIX_START}agent_l1}的Ticket] \nticket_id: tk_b1_1 | task_id: tsk_b1_1 | task_type: dev | need_return: true\n\nRun after CLI config`;
				outbox.set('dlv_b1_1', {
					deliveryId: 'dlv_b1_1',
					projectId: 'proj_1',
					targetAgentId: 'agent_1',
					ticketId: 'tk_b1_1',
					taskId: 'tsk_b1_1',
					deliveryMode: 'queue',
					payloadText: ticket1,
					state: 'pending',
				});
				outbox.set('dlv_b1_2', {
					deliveryId: 'dlv_b1_2',
					projectId: 'proj_1',
					targetAgentId: 'agent_1',
					ticketId: 'tk_b1_2',
					taskId: 'tsk_b1_2',
					deliveryMode: 'queue',
					payloadText: `${ADE_TICKET_MESSAGE_PREFIX_START}agent_l1}的Ticket] \nticket_id: tk_b1_2 | task_id: tsk_b1_2 | task_type: dev | need_return: true\n\nSecond ticket`,
					state: 'pending',
				});

				await bridge.flushOutboxForTest();

				assert.equal(outbox.get('dlv_b1_1')?.state, 'blocked_cli');
				assert.equal(outbox.get('dlv_b1_2')?.state, 'blocked_cli');
				assert.equal(vscodeMock.warningMessages.length, 1, 'Per-engine cliMissing warning toast MUST be deduplicated/throttled');
				assert.equal(vscodeMock.warningMessages[0].includes('tk_b1_'), true);
				assert.deepEqual(acked, []);

				await bridge.flushOutboxForTest();
				assert.deepEqual(acked, []);

				// 4. User configures CLI path (`aexus.agentEngines`) -> auto-refreshes & calls `requeueBlockedCliDeliveries({})` -> replays both!
				vscodeMock.cliPaths = { claude: mockClaudeBin };
				vscodeMock.fireConfigChange('aexus.agentEngines');
				onDidChangeConfiguration.fire({
					affectsConfiguration: (sec: string) => sec === 'aexus.agentEngines' || sec.startsWith('aexus.agentEngines.'),
				});

				const waitReplay = Date.now() + 3000;
				while (acked.length < 2 && Date.now() < waitReplay) {
					await new Promise<void>(r => setTimeout(r, 20));
				}
				await bridge.flushOutboxForTest();

				assert.equal(requeueCalls >= 1, true, 'Changing aexus.agentEngines must invoke controlCenter.requeueBlockedCliDeliveries');
				assert.deepEqual(acked.sort(), ['dlv_b1_1', 'dlv_b1_2']);
				assert.equal(agent1.session_started, true);
				cts.dispose();
			} finally {
				bridge.dispose();
			}
		} finally {
			ctx.disposeAll();
			process.env.PATH = savedPath;
		}
	});

	test('[Wave 7 B-R1 & B-R2] decoupled 0ms syncCachedEmployeeMeta + per-project single-flight trailing coalescing + Path A replay after cliMissing engine switch + started heterogeneous tab rebind', async () => {
		const suite = await loadWave6SuiteBundle();
		const { vscodeMock, workbench, activateExtension } = suite;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-w7-br1br2-'));
		tempArtifactsToClean.push(tmpDir);

		const mockClaudeBin = createExecutableNodeScript(tmpDir, 'mock-claude-w7', `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.type === 'user') {
		const txt = typeof msg.message?.content === 'string' ? msg.message.content : '';
		process.stdout.write(JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'text', text: '[w7-claude-pathA:' + txt.split('\\n').at(-1) + ']' }] },
		}) + '\\n');
		process.stdout.write(JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'ok',
			usage: { input_tokens: 5, output_tokens: 5 },
		}) + '\\n');
		process.exit(0);
	}
});
`);

		const savedPath = process.env.PATH;
		process.env.PATH = '';
		vscodeMock.resetForActivation();
		vscodeMock.autonomousMode = true;
		vscodeMock.cliPaths = {
			kilo: path.join(tmpDir, 'nonexistent-kilo-cli'),
			claude: mockClaudeBin,
		};

		const ctx = createExtensionContextStub(vscodeMock);
		try {
			await activateExtension(ctx);

			const agentState = {
				agent_id: 'agent_w7',
				project_id: 'proj_w7',
				parent_id: null,
				level: 1,
				is_top_role: true,
				name: 'Wave7 Worker',
				role_summary: 'L1',
				host: 'local',
				engine: 'kilo',
				model: 'claude-sonnet-4-6',
				effort: 'high',
				session_phase: 'unstarted' as 'unstarted' | 'starting' | 'started',
				session_started: false,
				session_resource: 'aexus-kilo:/ade-proj_w7-agent_w7',
				native_session_id: undefined as string | undefined,
				excluded_dept_ids: [] as string[],
				token_gen: 1,
				created_at: Date.now(),
				updated_at: Date.now(),
			};

			const onChangeProject = new workbench.Emitter<{ readonly projectId: string }>();
			const onEnqueueOutbox = new workbench.Emitter<{ readonly projectId: string; readonly targetAgentId: string }>();
			const onCancelOutbox = new workbench.Emitter<{ readonly projectId: string; readonly ticketIds: readonly string[] }>();
			const onDisposeRuntime = new workbench.Emitter<Record<string, unknown>>();
			const onActiveEditorChange = new workbench.Emitter<void>();
			const onProjectsChange = new workbench.Emitter<void>();

			interface OutboxRow {
				deliveryId: string;
				projectId: string;
				targetAgentId: string;
				ticketId: string;
				taskId: string;
				deliveryMode: 'queue' | 'steer';
				payloadText: string;
				state: 'pending' | 'in_flight' | 'blocked_cli';
			}
			const outbox = new Map<string, OutboxRow>();
			const acked: string[] = [];

			interface LiveChatTabHarness {
				uriStr: string;
				busy: boolean;
				lastPromptText: string;
				onChange: InstanceType<Wave6SuiteBundle['workbench']['Emitter']>;
				onDispose: InstanceType<Wave6SuiteBundle['workbench']['Emitter']>;
				providedSession?: Awaited<ReturnType<NonNullable<ReturnType<VscodeMockController['contentProviders']['get']>>['provideChatSessionContent']>>;
				streamedChunks: string[];
				cts: ReturnType<VscodeMockController['createCts']>;
			}
			const openChats = new Map<string, LiveChatTabHarness>();
			const pathASentLog: string[] = [];

			const mountProviderSession = async (uriStr: string): Promise<LiveChatTabHarness> => {
				const existing = openChats.get(uriStr);
				if (existing) {
					return existing;
				}
				const scheme = uriStr.split(':')[0];
				const provider = vscodeMock.contentProviders.get(scheme);
				assert.ok(provider, `Expected content provider for ${scheme}`);
				const cts = vscodeMock.createCts();
				const provided = await provider.provideChatSessionContent(vscodeMock.createUri(uriStr), cts.token);
				const harness: LiveChatTabHarness = {
					uriStr,
					busy: false,
					lastPromptText: '',
					onChange: new workbench.Emitter(),
					onDispose: new workbench.Emitter(),
					providedSession: provided,
					streamedChunks: [],
					cts,
				};
				openChats.set(uriStr, harness);
				return harness;
			};

			const mockChatService = {
				getSession: (uri: { toString(): string }) => {
					const h = openChats.get(uri.toString());
					if (!h) {
						return undefined;
					}
					return {
						sessionResource: uri,
						title: agentState.name,
						hasCustomTitle: true,
						hasRequests: Boolean(h.lastPromptText),
						lastRequest: h.lastPromptText ? {
							id: 'req_w7',
							message: { text: h.lastPromptText },
							response: {
								isComplete: !h.busy,
								onDidChange: (fn: () => void) => h.onChange.event(fn),
							},
						} : undefined,
						hasActiveRequest: { get: () => h.busy, read: () => h.busy },
						requestInProgress: { get: () => h.busy, read: () => h.busy },
						onDidDispose: h.onDispose.event,
						onDidChange: h.onChange.event,
					};
				},
				getSessionTitle: () => agentState.name,
				acquireOrLoadSession: async (uri: { toString(): string }) => {
					const h = await mountProviderSession(uri.toString());
					return {
						object: mockChatService.getSession(uri),
						dispose: () => {
							void h;
						},
					};
				},
				sendRequest: async (uri: { toString(): string }, message: string) => {
					const h = openChats.get(uri.toString());
					if (!h?.providedSession?.requestHandler) {
						return { kind: 'rejected' as const, reason: 'Session not open' };
					}
					pathASentLog.push(uri.toString());
					h.busy = true;
					h.lastPromptText = message;
					const reqCts = vscodeMock.createCts();
					const streamProxy = {
						markdown: (v: unknown) => {
							const txt = typeof v === 'string' ? v : String((v as { value?: unknown })?.value ?? '');
							h.streamedChunks.push(txt);
						},
						progress: () => { },
						thinkingProgress: () => { },
						push: () => { },
					};
					const completePromise = (async () => {
						try {
							await h.providedSession!.requestHandler!(
								{ prompt: message, references: [] },
								{},
								streamProxy,
								reqCts.token,
							);
						} finally {
							h.busy = false;
							reqCts.dispose();
							h.onChange.fire({ kind: 'completedRequest' });
						}
					})();
					return {
						kind: 'sent' as const,
						data: {
							responseCreatedPromise: completePromise.then(() => ({ isCanceled: false, state: 1 })),
							responseCompletePromise: completePromise,
						},
					};
				},
				clearSession: (uri: { toString(): string }) => {
					const h = openChats.get(uri.toString());
					if (h) {
						openChats.delete(uri.toString());
						h.providedSession?.dispose();
						h.cts.dispose();
					}
				},
				removeHistoryEntry: async (uri: { toString(): string }) => {
					mockChatService.clearSession(uri);
				},
			};

			// Minimal FakeGroup + real AdeEditorService + spy on notifyProjectSnapshotLoaded
			const groupEditors: Array<InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']>> = [];
			let activeGroupEditor: InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']> | null = null;
			const fakeGroup = {
				id: 1,
				get editors() { return groupEditors; },
				get activeEditor() { return activeGroupEditor; },
				isPinned: () => true,
				replaceEditors: async (replacements: ReadonlyArray<{ editor: InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']>; replacement: InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']> }>) => {
					for (const rep of replacements) {
						const idx = groupEditors.indexOf(rep.editor);
						const wasActive = activeGroupEditor === rep.editor;
						if (idx >= 0) {
							groupEditors.splice(idx, 1, rep.replacement);
						} else {
							groupEditors.push(rep.replacement);
						}
						if (wasActive || !activeGroupEditor) {
							activeGroupEditor = rep.replacement;
						}
						if (!rep.editor.isDisposed()) {
							rep.editor.dispose();
						}
					}
					onActiveEditorChange.fire();
				},
			};

			const mockEditorGroupsService = {
				mainPart: {
					get activeGroup() { return fakeGroup; },
					get groups() { return [fakeGroup]; },
					findGroup: () => undefined,
					addGroup: () => fakeGroup,
				},
			};
			const mockEditorService = {
				onDidActiveEditorChange: onActiveEditorChange.event,
				get activeEditor() { return activeGroupEditor ?? undefined; },
				openEditor: async (input: InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']>) => {
					if (!groupEditors.includes(input)) {
						groupEditors.push(input);
					}
					activeGroupEditor = input;
					const resStr = input.sessionResource?.toString();
					if (resStr) {
						await mountProviderSession(resStr);
					}
					onActiveEditorChange.fire();
					return undefined;
				},
				closeEditors: async (targets: ReadonlyArray<{ editor: InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']> }>) => {
					for (const t of targets) {
						const idx = groupEditors.indexOf(t.editor);
						if (idx >= 0) {
							groupEditors.splice(idx, 1);
						}
						if (!t.editor.isDisposed()) {
							t.editor.dispose();
						}
					}
					onActiveEditorChange.fire();
				},
			};

			let notifySnapshotBackflowCount = 0;
			const mockProjectsService = {
				onDidChange: onProjectsChange.event,
				selectedProjectPageId: 'proj_w7',
				selectedProject: { uri: workbench.URI.parse(`file://${tmpDir}`), name: 'W7' },
				get agents() {
					return [{
						id: agentState.agent_id,
						projectId: 'proj_w7',
						projectUri: workbench.URI.parse(`file://${tmpDir}`),
						label: agentState.name,
						level: 1,
						isTopRole: true,
						roleSummary: 'L1',
						host: 'local',
						engine: agentState.engine,
						model: agentState.model,
						effort: agentState.effort,
						sessionPhase: agentState.session_phase,
						sessionStarted: agentState.session_started,
						session: {
							engineId: `aexus-${agentState.engine}`,
							resource: workbench.URI.parse(agentState.session_resource),
						},
					}];
				},
				getProjectPage: (pid: string) => pid === 'proj_w7' ? { projectId: 'proj_w7', folderId: 'f1', folderUri: workbench.URI.parse(`file://${tmpDir}`), name: 'W7', sortOrder: 10, createdAt: 1, updatedAt: 1 } : undefined,
				getFolderForProjectPage: () => ({ uri: workbench.URI.parse(`file://${tmpDir}`), name: 'W7' }),
				getAgent: (id: string, pid?: string) => (id === agentState.agent_id && (!pid || pid === 'proj_w7')) ? mockProjectsService.agents[0] : undefined,
				selectProject: () => { },
				selectProjectPage: () => { },
				selectAgent: () => { },
				markRead: () => { },
				notifyProjectSnapshotLoaded: () => {
					notifySnapshotBackflowCount++;
				},
			};

			const mockControlCenter = {
				onDidChangeProject: onChangeProject.event,
				onDidEnqueueOutbox: onEnqueueOutbox.event,
				onDidCancelOutboxTickets: onCancelOutbox.event,
				onDidDisposeAgentRuntime: onDisposeRuntime.event,
				getProjectSnapshot: async () => ({
					meta: { project_id: 'proj_w7', folder_uri: `file://${tmpDir}` },
					hosts: [],
					agents: [{ ...agentState }],
					deleted_agents: [],
					departments: [],
					whiteboards: [],
					board_grants: [],
					tickets: [],
					edge_latest_transfer_at: {},
				}),
				issueAgentLaunchBundle: async () => ({
					projectId: 'proj_w7',
					agentId: agentState.agent_id,
					level: 1,
					name: agentState.name,
					host: 'local',
					engine: agentState.engine,
					model: agentState.model,
					effort: agentState.effort,
					workspaceCwd: tmpDir,
					sessionResource: agentState.session_resource,
					nativeSessionId: agentState.native_session_id,
					agentToken: 'ades1.jti_w7.secret',
					controlSocketPath: path.join(tmpDir, 'ade.sock'),
				}),
				markAgentSessionStarting: async (_p: string, _a: string, res?: string) => {
					if (agentState.session_phase !== 'started') agentState.session_phase = 'starting';
					agentState.session_started = true;
					if (res) agentState.session_resource = res;
				},
				markAgentSessionStarted: async (_p: string, _a: string, info: { sessionResource?: string; nativeSessionId?: string }) => {
					agentState.session_phase = 'started';
					agentState.session_started = true;
					if (info.sessionResource) agentState.session_resource = info.sessionResource;
					if (info.nativeSessionId) agentState.native_session_id = info.nativeSessionId;
				},
				rollbackUnstartedIfCliMissing: async () => {
					if (agentState.session_phase !== 'starting') return false;
					agentState.session_phase = 'unstarted';
					agentState.session_started = false;
					return true;
				},
				claimPendingDeliveries: async () => {
					const out: OutboxRow[] = [];
					for (const r of outbox.values()) {
						if (r.state === 'pending') {
							r.state = 'in_flight';
							out.push({ ...r });
						}
					}
					return out;
				},
				ackDeliveryDispatched: async (id: string) => {
					acked.push(id);
					outbox.delete(id);
				},
				nackDeliveryFailed: async (id: string, _w: number, _e: string, cliMissing?: boolean) => {
					const r = outbox.get(id);
					if (r) r.state = cliMissing ? 'blocked_cli' : 'pending';
				},
				releaseWindowDeliveries: async () => { },
				requeueBlockedCliDeliveries: async () => {
					let requeuedCount = 0;
					for (const r of outbox.values()) {
						if (r.state === 'blocked_cli') {
							r.state = 'pending';
							requeuedCount++;
							onEnqueueOutbox.fire({ projectId: r.projectId, targetAgentId: r.targetAgentId });
						}
					}
					return { requeuedCount };
				},
			};

			let injectSyncDelayMs = 0;
			let adeEditorsInstance!: ReturnType<typeof createAdeEditors>;
			const accessor = {
				get: (serviceId: unknown) => {
					if (serviceId === workbench.IAdeControlCenterService) return mockControlCenter;
					if (serviceId === workbench.IChatService) return mockChatService;
					if (serviceId === workbench.IAdeEditorService) return adeEditorsInstance;
					if (serviceId === workbench.ICommandService) return commandBridge;
					throw new Error('Optional service not bound');
				},
			};

			const createLightChatInput = (resource: { toString(): string; readonly scheme: string }, options: unknown) => {
				let disposed = false;
				let resolved = false;
				return {
					resource,
					sessionResource: resource,
					options,
					get hasResolvedModel() { return resolved; },
					setLineageProvider: () => { },
					refreshLineage: () => { },
					setTitleOverride: () => { },
					releaseModel: () => { resolved = false; },
					resolve: async () => {
						await mockChatService.acquireOrLoadSession(resource);
						resolved = true;
						return null;
					},
					isDisposed: () => disposed,
					dispose: () => { disposed = true; },
				};
			};
			// Ensure instanceof ChatEditorInput checks inside AdeEditorService recognize lightweight test inputs via Symbol.hasInstance or real prototype!
			const protoChain = workbench.AdeLineageChatEditorInput.prototype;
			const createProtoChatInput = (resource: unknown, options: unknown) => {
				const base = createLightChatInput(resource as { toString(): string; readonly scheme: string }, options);
				Object.setPrototypeOf(base, protoChain);
				return base as unknown as InstanceType<Wave6SuiteBundle['workbench']['AdeLineageChatEditorInput']>;
			};

			const mockInstantiationService = {
				invokeFunction: <R>(fn: (acc: { get(id: unknown): unknown }) => R): R => fn(accessor),
				createInstance: (_ctor: unknown, ...args: unknown[]) => createProtoChatInput(args[0], args[1]),
			};

			const createAdeEditors = () => new workbench.AdeEditorService(
				{ mode: 'ade', onDidChangeMode: () => ({ dispose() { } }) },
				mockEditorGroupsService,
				mockEditorService,
				mockInstantiationService,
				mockProjectsService,
				{ activateById: async () => { } },
			);
			adeEditorsInstance = createAdeEditors();

			const commandBridge = {
				executeCommand: async (id: string, ...args: unknown[]) => {
					if (id === 'aexus.ade.getWindowId') return 7;
					if (id === 'aexus.ade.syncCachedEmployeeMeta' && injectSyncDelayMs > 0) {
						await new Promise<void>(r => setTimeout(r, injectSyncDelayMs));
					}
					const extFn = vscodeMock.registeredCommands.get(id);
					if (extFn) return await extFn(...args);
					const wbCmd = workbench.CommandsRegistry.getCommand(id);
					if (wbCmd) return await wbCmd.handler(accessor, ...args);
					return undefined;
				},
			};

			vscodeMock.registeredCommands.set('aexus.ade.resolveEmployeeSessionMeta', async () => ({
				name: agentState.name,
				engine: agentState.engine,
				sessionStarted: agentState.session_started,
				workspaceCwdUri: `file://${tmpDir}`,
				model: agentState.model,
				effort: agentState.effort,
				nativeSessionId: agentState.native_session_id,
			}));
			vscodeMock.registeredCommands.set('aexus.ade.issueAgentLaunchBundle', async () => mockControlCenter.issueAgentLaunchBundle());
			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarted', async (_p: unknown, _a: unknown, sid: unknown) => {
				await mockControlCenter.markAgentSessionStarted('proj_w7', agentState.agent_id, { nativeSessionId: String(sid) });
			});
			vscodeMock.registeredCommands.set('aexus.ade.trySendOpenChatRequest', (...args: unknown[]) => {
				const wbCmd = workbench.CommandsRegistry.getCommand('aexus.ade.trySendOpenChatRequest');
				return wbCmd?.handler(accessor, ...args);
			});

			const bridge = new workbench.AdeOutboxBridgeContribution(commandBridge, mockInstantiationService);
			try {
				// --- Assertion A: syncCachedEmployeeMeta returns in << 80ms (decoupled from 80ms SAVE_DEBOUNCE_MS timer) ---
				await adeEditorsInstance.openAgent(agentState.agent_id, { projectId: 'proj_w7' });
				assert.equal(groupEditors.length, 1);
				assert.equal(groupEditors[0].sessionResource?.toString(), 'aexus-kilo:/ade-proj_w7-agent_w7');

				const t0 = performance.now();
				const fastSyncRes = await vscodeMock.registeredCommands.get('aexus.ade.syncCachedEmployeeMeta')!({
					projectId: 'proj_w7',
					agents: [{
						agentId: agentState.agent_id,
						name: agentState.name,
						engine: 'kilo',
						model: 'claude-opus-4-6',
						effort: 'max',
						sessionStarted: false,
						sessionResource: 'aexus-kilo:/ade-proj_w7-agent_w7',
						workspaceCwdUri: `file://${tmpDir}`,
					}],
				}) as { updated: boolean };
				const elapsedMs = performance.now() - t0;
				assert.equal(fastSyncRes.updated, true);
				assert.equal(elapsedMs < 50, true, `syncCachedEmployeeMeta MUST NOT block on 80ms save() debounce; took ${elapsedMs.toFixed(2)}ms`);

				// --- Assertion B: Rapid back-to-back kilo -> claude -> pi (first sync slower than second) converges strictly to aexus-pi ---
				injectSyncDelayMs = 60;
				agentState.engine = 'claude';
				agentState.session_resource = 'aexus-claude:/ade-proj_w7-agent_w7';
				onChangeProject.fire({ projectId: 'proj_w7' });

				await new Promise<void>(r => setTimeout(r, 8));
				injectSyncDelayMs = 5;
				agentState.engine = 'pi';
				agentState.session_resource = 'aexus-pi:/ade-proj_w7-agent_w7';
				onChangeProject.fire({ projectId: 'proj_w7' });

				await bridge.flushOutboxForTest();
				await new Promise<void>(r => setTimeout(r, 30));
				assert.equal(groupEditors.length, 1);
				assert.equal(groupEditors[0].sessionResource?.toString(), 'aexus-pi:/ade-proj_w7-agent_w7', 'Double switch kilo -> claude -> pi must converge strictly to aexus-pi');
				assert.equal(notifySnapshotBackflowCount, 0, 'rebindUnstartedAgentEditors MUST NEVER call projects.notifyProjectSnapshotLoaded');

				// Switch back to unstarted kilo to test cliMissing -> engine switch -> Path A replay!
				injectSyncDelayMs = 0;
				agentState.engine = 'kilo';
				agentState.session_resource = 'aexus-kilo:/ade-proj_w7-agent_w7';
				onChangeProject.fire({ projectId: 'proj_w7' });
				await bridge.flushOutboxForTest();
				await new Promise<void>(r => setTimeout(r, 20));
				assert.equal(groupEditors[0].sessionResource?.toString(), 'aexus-kilo:/ade-proj_w7-agent_w7');

				// --- Assertion C: cliMissing rollback + open tab + delayed syncCachedEmployeeMeta -> 100% Path A replay! ---
				const firstTicket = `${ADE_TICKET_MESSAGE_PREFIX_START}agent_boss}的Ticket] \nticket_id: tk_w7_1 | task_id: tsk_w7_1 | task_type: dev | need_return: true\nsummary: verify-path-a-replay`;
				outbox.set('dlv_w7_1', {
					deliveryId: 'dlv_w7_1',
					projectId: 'proj_w7',
					targetAgentId: agentState.agent_id,
					ticketId: 'tk_w7_1',
					taskId: 'tsk_w7_1',
					deliveryMode: 'queue',
					payloadText: firstTicket,
					state: 'pending',
				});
				await bridge.flushOutboxForTest();
				assert.equal(outbox.get('dlv_w7_1')?.state, 'blocked_cli');
				assert.equal(agentState.session_started, false);

				// Inject 60ms delay into syncCachedEmployeeMeta while simultaneously firing onDidChangeProject + requeueBlockedCliDeliveries!
				injectSyncDelayMs = 60;
				agentState.engine = 'claude';
				agentState.session_resource = 'aexus-claude:/ade-proj_w7-agent_w7';
				onChangeProject.fire({ projectId: 'proj_w7' });
				await mockControlCenter.requeueBlockedCliDeliveries();
				await bridge.flushOutboxForTest();

				assert.deepEqual(acked, ['dlv_w7_1']);
				assert.equal(groupEditors[0].sessionResource?.toString(), 'aexus-claude:/ade-proj_w7-agent_w7');
				assert.deepEqual(pathASentLog, ['aexus-claude:/ade-proj_w7-agent_w7'], 'Replayed first Ticket MUST route 100% via Path A open chat');
				const claudeTabHarness = openChats.get('aexus-claude:/ade-proj_w7-agent_w7');
				assert.equal(claudeTabHarness?.streamedChunks.join('').includes('[w7-claude-pathA:'), true, 'Rebound claude tab must receive live Path A stream chunks');
				assert.equal(notifySnapshotBackflowCount, 0, 'Zero stale snapshot backflow into AdeProjectsService');

				// --- Assertion D: Orphaned heterogeneous tab (aexus-kilo) still rebinds in-place when authoritative snapshot already has session_started = true ---
				assert.equal(agentState.session_started, true);
				assert.equal(agentState.engine, 'claude');
				const staleOrphanKiloTab = createProtoChatInput(workbench.URI.parse('aexus-kilo:/ade-proj_w7-agent_w7'), {});
				groupEditors.splice(0, groupEditors.length, staleOrphanKiloTab);
				activeGroupEditor = staleOrphanKiloTab;

				const reboundStarted = await adeEditorsInstance.rebindUnstartedAgentEditors('proj_w7');
				assert.equal(reboundStarted, 1, 'Orphaned heterogeneous tab must rebind even when session_started === true');
				assert.equal(groupEditors[0].sessionResource?.toString(), 'aexus-claude:/ade-proj_w7-agent_w7');
				assert.equal(staleOrphanKiloTab.isDisposed(), true);
				assert.equal(notifySnapshotBackflowCount, 0);
			} finally {
				for (const h of openChats.values()) {
					h.providedSession?.dispose();
					h.cts.dispose();
				}
				openChats.clear();
				adeEditorsInstance.dispose();
				bridge.dispose();
			}
		} finally {
			ctx.disposeAll();
			process.env.PATH = savedPath;
		}
	});

	test('[Wave 8 Hotfix Track B] pumpStateWrite microtask-gap-free persistence, AdeOpenChatTicketScheduler candidateStartedSeq steer preemption without dropping queue, and pi Path B bare-vs-prefixed model equivalence', async () => {
		const suite = await loadWave6SuiteBundle();
		const { vscodeMock, workbench, activateExtension, deactivateExtension, arePiModelsEquivalent } = suite;

		// === 1. Unit equivalence matrix on `arePiModelsEquivalent` ===
		assert.equal(arePiModelsEquivalent(undefined, 'anthropic/claude-sonnet-4-6'), true);
		assert.equal(arePiModelsEquivalent('default', undefined), true);
		assert.equal(arePiModelsEquivalent('default', 'default'), true);
		assert.equal(arePiModelsEquivalent('default', 'anthropic/claude-sonnet-4-6'), false);
		assert.equal(arePiModelsEquivalent('claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'), true);
		assert.equal(arePiModelsEquivalent('anthropic/claude-sonnet-4-6', 'claude-sonnet-4-6'), true);
		assert.equal(arePiModelsEquivalent('openai/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'), false);
		assert.equal(arePiModelsEquivalent('gpt-5.4', 'anthropic/claude-sonnet-4-6'), false);

		// === 2. `AdeOpenChatTicketScheduler` `candidateStartedSeq` during `markAgentSessionStarting` ===
		const scheduler = new workbench.AdeOpenChatTicketScheduler();
		try {
			const claudeUri = workbench.URI.parse('aexus-claude:/ade-proj_w8-agent_claude');
			const sessionChange = new workbench.Emitter<{ kind: 'completedRequest' | 'removeRequest' }>();
			let activeTurnComplete: (() => void) | undefined;
			let lastPromptText = '';
			const sentPrompts: string[] = [];

			const mockChatService = {
				getSession: (uri: { toString(): string }) => {
					if (uri.toString() !== claudeUri.toString()) {
						return undefined;
					}
					const busy = activeTurnComplete !== undefined;
					return {
						sessionResource: claudeUri,
						lastRequest: lastPromptText ? {
							id: `req_w8_${sentPrompts.length}`,
							message: { text: lastPromptText },
							response: {
								isComplete: !busy,
								onDidChange: (fn: () => void) => sessionChange.event(fn),
							},
						} : undefined,
						hasActiveRequest: { get: () => busy, read: () => busy },
						requestInProgress: { get: () => busy, read: () => busy },
						onDidDispose: () => ({ dispose() { } }),
						onDidChange: sessionChange.event,
					};
				},
				sendRequest: async (_uri: { toString(): string }, message: string) => {
					sentPrompts.push(message);
					lastPromptText = message;
					let finishTurn!: () => void;
					const turnPromise = new Promise<void>(r => { finishTurn = r; });
					activeTurnComplete = () => {
						activeTurnComplete = undefined;
						finishTurn();
						sessionChange.fire({ kind: 'completedRequest' });
					};
					return {
						kind: 'sent' as const,
						data: {
							responseCreatedPromise: turnPromise.then(() => ({ isCanceled: false, state: 1 })),
							responseCompletePromise: turnPromise,
						},
					};
				},
				cancelCurrentRequestForSession: async () => {
					activeTurnComplete?.();
				},
			};

			let releaseFirstStarting: (() => void) | undefined;
			let startingEnteredResolve!: () => void;
			const startingEntered = new Promise<void>(r => { startingEnteredResolve = r; });
			let startingCalls = 0;

			const mockControlCenter = {
				markAgentSessionStarting: async () => {
					startingCalls++;
					if (startingCalls === 1) {
						startingEnteredResolve();
						await new Promise<void>(r => { releaseFirstStarting = r; });
					}
				},
			};

			const qPayload = `${ADE_TICKET_MESSAGE_PREFIX_START}agent_boss}的Ticket] \nticket_id: tk_w8_q1 | task_id: tsk_w8_q1 | task_type: dev | need_return: true\nsummary: queue-first-enqueued`;
			const sPayload = `${ADE_TICKET_MESSAGE_PREFIX_START}agent_boss}的Ticket] \nticket_id: tk_w8_s1 | task_id: tsk_w8_s1 | task_type: dev | need_return: true\nsummary: steer-during-starting`;

			let queueResolvedEarly = false;
			const pQueue = scheduler.dispatchTicket(
				{
					sessionUri: claudeUri,
					payloadText: qPayload,
					deliveryMode: 'queue',
					projectId: 'proj_w8',
					agentId: 'agent_claude',
					engine: 'claude',
					ticketId: 'tk_w8_q1',
					taskId: 'tsk_w8_q1',
				},
				mockChatService,
				mockControlCenter,
			).then(res => {
				queueResolvedEarly = true;
				return res;
			});

			await startingEntered;
			// Arrive `steer` while `tk_w8_q1` is suspended inside `markAgentSessionStarting`!
			const pSteer = scheduler.dispatchTicket(
				{
					sessionUri: claudeUri,
					payloadText: sPayload,
					deliveryMode: 'steer',
					projectId: 'proj_w8',
					agentId: 'agent_claude',
					engine: 'claude',
					ticketId: 'tk_w8_s1',
					taskId: 'tsk_w8_s1',
				},
				mockChatService,
				mockControlCenter,
			);

			releaseFirstStarting!();
			const waitFirstSend = Date.now() + 2000;
			while (sentPrompts.length < 1 && Date.now() < waitFirstSend) {
				await new Promise<void>(r => setTimeout(r, 5));
			}
			assert.equal(sentPrompts.length, 1);
			assert.equal(sentPrompts[0].includes('tk_w8_s1'), true, 'Steer arriving during markAgentSessionStarting MUST execute before queue');
			assert.equal(queueResolvedEarly, false, 'Re-queued Ticket MUST NOT prematurely resolve/ack before executing');
			assert.equal(scheduler.getQueuedCount('proj_w8', 'agent_claude'), 1, 'Queue item must be losslessly re-inserted into state.queue');

			// Finish `steer` turn -> `queue` turn must automatically run second!
			activeTurnComplete!();
			const steerOutcome = await pSteer;
			assert.equal(steerOutcome.ok, true);
			assert.equal(Boolean(steerOutcome.stopped), false);

			const waitSecondSend = Date.now() + 2000;
			while (sentPrompts.length < 2 && Date.now() < waitSecondSend) {
				await new Promise<void>(r => setTimeout(r, 5));
			}
			assert.equal(sentPrompts.length, 2);
			assert.equal(sentPrompts[1].includes('tk_w8_q1'), true, 'Queue Ticket must execute right after steer completes');
			assert.equal(queueResolvedEarly, false);

			activeTurnComplete!();
			const queueOutcome = await pQueue;
			assert.equal(queueOutcome.ok, true);
			assert.equal(Boolean(queueOutcome.stopped), false, 'Queue Ticket must complete normally with stopped: false');
			sessionChange.dispose();
		} finally {
			scheduler.abortForWindowDispose();
		}

		// === 3. Microtask consecutive `triggerImmediateSave` + Path B `pi` bare-vs-prefixed steer equivalence ===
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-w8-trackb-'));
		tempArtifactsToClean.push(tmpDir);
		const rpcLogPath = path.join(tmpDir, 'pi-w8-rpc.jsonl');
		const sessionJsonlPath = path.join(tmpDir, 'pi-w8-session.jsonl');

		const mockPiBin = createExecutableNodeScript(tmpDir, 'mock-pi-w8', `
const fs = require('node:fs');
const readline = require('node:readline');
const logEvent = (ev) => fs.appendFileSync(${JSON.stringify(rpcLogPath)}, JSON.stringify(ev) + '\\n');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let currentModel = 'default';
const modelIdx = process.argv.indexOf('--model');
if (modelIdx >= 0 && process.argv[modelIdx + 1]) currentModel = process.argv[modelIdx + 1];
if (!fs.existsSync(${JSON.stringify(sessionJsonlPath)})) {
	fs.writeFileSync(${JSON.stringify(sessionJsonlPath)}, JSON.stringify({ type: 'session', id: 'pi_w8_ses', cwd: process.cwd() }) + '\\n');
}
let holdTimer = null;
const finish = (txt) => {
	if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
	send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: txt } });
	send({ type: 'agent_end', messages: [{ role: 'assistant', model: currentModel, usage: { input_tokens: 4, output_tokens: 4 } }] });
	send({ type: 'agent_settled' });
};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const cmd = JSON.parse(line);
	logEvent({ event: 'rpc', type: cmd.type, provider: cmd.provider, modelId: cmd.modelId });
	if (cmd.type === 'get_state') {
		send({ type: 'response', id: cmd.id, command: 'get_state', success: true, data: { sessionFile: ${JSON.stringify(sessionJsonlPath)}, model: currentModel } });
		return;
	}
	if (cmd.type === 'prompt') {
		send({ type: 'response', id: cmd.id, command: 'prompt', success: true, data: {} });
		send({ type: 'agent_start' });
		const m = /\\[HOLD_MS:(\\d+)\\]/.exec(String(cmd.message || ''));
		if (m) {
			holdTimer = setTimeout(() => { holdTimer = null; finish('[done]'); }, Number(m[1]));
		} else {
			finish('[fast]');
		}
		return;
	}
	if (cmd.type === 'steer') {
		send({ type: 'response', id: cmd.id, command: 'steer', success: true, data: {} });
		if (holdTimer) { clearTimeout(holdTimer); }
		holdTimer = setTimeout(() => { holdTimer = null; finish('[steered-ok]'); }, 60);
		return;
	}
	if (cmd.type === 'abort') {
		if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
		send({ type: 'response', id: cmd.id, command: 'abort', success: true, data: {} });
		send({ type: 'agent_end', messages: [] });
		send({ type: 'agent_settled' });
		return;
	}
	send({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} });
});
`);

		const savedPath = process.env.PATH;
		process.env.PATH = '';
		vscodeMock.resetForActivation();
		vscodeMock.autonomousMode = true;
		vscodeMock.cliPaths = { pi: mockPiBin };

		const ctx = createExtensionContextStub(vscodeMock);
		let interceptBurstArmed = false;
		let nativeSessionsWriteCount = 0;
		const origUpdate = ctx.globalState.update;
		ctx.globalState.update = async (key: string, val: unknown): Promise<void> => {
			if (key === 'nativeSessions') {
				nativeSessionsWriteCount++;
				if (interceptBurstArmed) {
					interceptBurstArmed = false;
					let releaseWrite!: () => void;
					const gate = new Promise<void>(r => { releaseWrite = r; });
					setTimeout(() => {
						// Schedule consecutive `syncCachedEmployeeMeta` writes across exact microtask hops 0..4
						// right as `writeStateNow()` resolves (targeting the former `.finally()` microtask gap)!
						const syncCmd = vscodeMock.registeredCommands.get('aexus.ade.syncCachedEmployeeMeta')!;
						const fireHop = (hop: number) => {
							void syncCmd({
								projectId: 'proj_w8',
								agents: [{
									agentId: 'agent_pi_w8',
									name: 'Wave8 Pi Worker',
									engine: 'pi',
									model: `anthropic/claude-hop-${hop}`,
									effort: 'high',
									sessionStarted: false,
									sessionResource: 'aexus-pi:/ade-proj_w8-agent_pi_w8',
									workspaceCwdUri: `file://${tmpDir}`,
								}],
							});
						};
						releaseWrite();
						fireHop(0);
						Promise.resolve()
							.then(() => { fireHop(1); })
							.then(() => { fireHop(2); })
							.then(() => { fireHop(3); })
							.then(() => { fireHop(4); });
					}, 5);
					await gate;
				}
			}
			await origUpdate(key, val);
		};

		try {
			await activateExtension(ctx);
			vscodeMock.registeredCommands.set('aexus.ade.resolveEmployeeSessionMeta', async () => ({
				name: 'Wave8 Pi Worker',
				engine: 'pi',
				sessionStarted: false,
				workspaceCwdUri: `file://${tmpDir}`,
				model: 'anthropic/claude-sonnet-4-6',
				effort: 'medium',
			}));
			vscodeMock.registeredCommands.set('aexus.ade.trySendOpenChatRequest', async () => ({ accepted: false }));

			// Seed record via provider
			const piProvider = vscodeMock.contentProviders.get('aexus-pi')!;
			const seedCts = vscodeMock.createCts();
			const seeded = await piProvider.provideChatSessionContent(
				vscodeMock.createUri('aexus-pi:/ade-proj_w8-agent_pi_w8'),
				seedCts.token,
			);
			seeded.dispose();
			seedCts.dispose();
			await new Promise<void>(r => setTimeout(r, 15));

			// Trigger microtask burst across `pumpStateWrite` boundary
			interceptBurstArmed = true;
			const syncCmd = vscodeMock.registeredCommands.get('aexus.ade.syncCachedEmployeeMeta')!;
			await syncCmd({
				projectId: 'proj_w8',
				agents: [{
					agentId: 'agent_pi_w8',
					name: 'Wave8 Pi Worker',
					engine: 'pi',
					model: 'anthropic/claude-initial-burst',
					effort: 'medium',
					sessionStarted: false,
					sessionResource: 'aexus-pi:/ade-proj_w8-agent_pi_w8',
					workspaceCwdUri: `file://${tmpDir}`,
				}],
			});
			await new Promise<void>(r => setTimeout(r, 30));
			await deactivateExtension();

			const savedSessions = ctx.store.get('nativeSessions') as Record<string, { sessionConfig?: { model?: string } }> | undefined;
			const savedEntry = Object.values(savedSessions ?? {}).find(
				(r: { adeAgentId?: string }) => r.adeAgentId === 'agent_pi_w8',
			) as { sessionConfig?: { model?: string } } | undefined;
			assert.equal(
				savedEntry?.sessionConfig?.model,
				'anthropic/claude-hop-4',
				`Microtask-adjacent triggerImmediateSave MUST NOT drop final write; got ${JSON.stringify(savedEntry?.sessionConfig)}`,
			);
			assert.equal(nativeSessionsWriteCount >= 2, true);

			// Reset model to `anthropic/claude-sonnet-4-6` and verify Path B `queue` (`anthropic/claude-sonnet-4-6`)
			// preempted by Path B `steer` (`claude-sonnet-4-6` bare ID) uses native `steer` with ZERO `abort` or `set_model`!
			const dispatchCmd = vscodeMock.registeredCommands.get('aexus.agentEngines.dispatchTicketTurn')!;
			const pTurn1 = dispatchCmd({
				deliveryId: 'dlv_w8_pb_1',
				projectId: 'proj_w8',
				agentId: 'agent_pi_w8',
				agentName: 'Wave8 Pi Worker',
				sessionResource: 'aexus-pi:/ade-proj_w8-agent_pi_w8',
				workspaceCwdUri: `file://${tmpDir}`,
				engine: 'pi',
				model: 'anthropic/claude-sonnet-4-6',
				effort: 'medium',
				ticketId: 'tk_w8_pb_1',
				taskId: 'tsk_w8_pb_1',
				deliveryMode: 'queue',
				payloadText: `${ADE_TICKET_MESSAGE_PREFIX_START}agent_boss}的Ticket] \nticket_id: tk_w8_pb_1 | task_id: tsk_w8_pb_1 | task_type: dev | need_return: true\nsummary: pathB-prefixed [HOLD_MS:800]`,
				agentToken: 'ades1.jti_w8.secret',
				controlSocketPath: path.join(tmpDir, 'ade.sock'),
			}) as Promise<{ ok?: boolean }>;

			const waitStart = Date.now() + 3000;
			while (Date.now() < waitStart) {
				const raw = fs.existsSync(rpcLogPath) ? fs.readFileSync(rpcLogPath, 'utf8') : '';
				if (raw.includes('"type":"prompt"')) break;
				await new Promise<void>(r => setTimeout(r, 15));
			}
			await new Promise<void>(r => setTimeout(r, 25));
			const logCountBeforeSteer = fs.readFileSync(rpcLogPath, 'utf8').trim().split('\n').length;

			const pTurn2 = dispatchCmd({
				deliveryId: 'dlv_w8_pb_2',
				projectId: 'proj_w8',
				agentId: 'agent_pi_w8',
				agentName: 'Wave8 Pi Worker',
				sessionResource: 'aexus-pi:/ade-proj_w8-agent_pi_w8',
				workspaceCwdUri: `file://${tmpDir}`,
				engine: 'pi',
				model: 'claude-sonnet-4-6', // Bare modelId equivalent to `anthropic/claude-sonnet-4-6`!
				effort: 'medium',
				ticketId: 'tk_w8_pb_2',
				taskId: 'tsk_w8_pb_2',
				deliveryMode: 'steer',
				payloadText: `${ADE_TICKET_MESSAGE_PREFIX_START}agent_boss}的Ticket] \nticket_id: tk_w8_pb_2 | task_id: tsk_w8_pb_2 | task_type: dev | need_return: true\nsummary: pathB-bare-steer`,
				agentToken: 'ades1.jti_w8.secret',
				controlSocketPath: path.join(tmpDir, 'ade.sock'),
			}) as Promise<{ ok?: boolean }>;

			const [res1, res2] = await Promise.all([pTurn1, pTurn2]);
			assert.equal(res1?.ok, true);
			assert.equal(res2?.ok, true);

			const steerRpcEvents = fs.readFileSync(rpcLogPath, 'utf8')
				.trim()
				.split('\n')
				.slice(logCountBeforeSteer)
				.map(l => JSON.parse(l) as { event: string; type?: string });
			assert.equal(steerRpcEvents.some(e => e.event === 'rpc' && e.type === 'steer'), true, 'Bare modelId matching provider/modelId must steer in-place');
			assert.equal(steerRpcEvents.some(e => e.event === 'rpc' && e.type === 'abort'), false, 'Equivalent bare modelId MUST NOT trigger abort');
			assert.equal(steerRpcEvents.some(e => e.event === 'rpc' && e.type === 'set_model'), false, 'Equivalent bare modelId MUST NOT trigger set_model');

			await vscodeMock.registeredCommands.get('aexus.agentEngines.disposeAgentRuntime')!({
				projectId: 'proj_w8',
				agentId: 'agent_pi_w8',
				sessionResource: 'aexus-pi:/ade-proj_w8-agent_pi_w8',
			});
		} finally {
			ctx.disposeAll();
			process.env.PATH = savedPath;
		}
	});
});
