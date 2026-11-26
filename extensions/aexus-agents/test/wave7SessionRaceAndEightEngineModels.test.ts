/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeCliHmacRequestProof, computeCliHmacResponseProof } from '../src/adeCliTransport.ts';
import {
	discoverEngineModels,
	foldAntigravityModelVariant,
	parseAgyModelsOutput,
	readClaudeSettings,
	readPiModelsJson,
	THINKING_LEVELS,
} from '../src/capabilities.ts';
import {
	ADE_SAFE_CLI_COMMANDS,
	isSafeAcpAdePermissionRequest,
	isSafeAdeCliBashCommand,
	isSafeAdeCliCommandInput,
	isSafeCodexAdeApprovalRequest,
	isSafeKiloAdePermissionRequest,
	sanitizeSensitiveErrorText,
} from '../src/engineAdapterHelpers.ts';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(TEST_DIR, '..');

interface VscodeMockController {
	autonomousMode: boolean;
	cliPaths: Record<string, string>;
	httpProxy: string;
	readonly registeredCommands: Map<string, (...args: unknown[]) => unknown>;
	readonly contentProviders: Map<string, {
		readonly onDidChangeChatSessionOptions?: (listener: (e: unknown) => void) => { dispose(): void };
		readonly onDidChangeChatSessionProviderOptions?: (listener: () => void) => { dispose(): void };
		provideChatSessionProviderOptions?(): Promise<{
			readonly optionGroups: ReadonlyArray<{
				readonly id: string;
				readonly items: ReadonlyArray<{ readonly id: string; readonly name: string }>;
			}>;
		}>;
		provideChatSessionContent(uri: unknown, token: unknown): Promise<{
			readonly title: string;
			readonly history: readonly unknown[];
			readonly requestHandler?: (
				request: { readonly prompt: string; readonly command?: string; readonly references: readonly unknown[] },
				chatContext: Record<string, unknown>,
				stream: Record<string, (...args: unknown[]) => void>,
				token: unknown,
			) => Promise<Record<string, unknown>>;
			dispose(): void;
		}>;
	}>;
	createUri(raw: string): {
		readonly scheme: string;
		readonly authority: string;
		readonly path: string;
		readonly fsPath: string;
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
	resetForActivation(): void;
}

interface Wave7Bundle {
	readonly vscodeMock: VscodeMockController;
	readonly activateExtension: (context: unknown) => Promise<void>;
	readonly applyHttpConfigurationToEnv: (env: NodeJS.ProcessEnv) => void;
	readonly applyHttpProxySettingsToEnv: (
		env: Record<string, string | undefined>,
		httpConfig: { proxy?: string; proxySupport?: string; noProxy?: string } | undefined,
		isMacOrWin: boolean,
	) => void;
	readonly enrichCodingAgentPath: (
		existingPath: string | undefined,
		userHomePath: string,
		isMacintosh: boolean,
		isWindows: boolean,
		prependBinDirs?: readonly string[],
		nvmNodeVersions?: readonly string[],
	) => string;
	readonly refreshNvmNodeBinDirectories: (home?: string) => Promise<string[]>;
	readonly getStandardCliDirectories: (env?: NodeJS.ProcessEnv) => string[];
	readonly findExecutable: (name: string) => Promise<string | undefined>;
	readonly extractClaudeErrorDetail: (
		event: { result?: string; errors?: Array<string | { message?: string }>; error?: string | { message?: string } } | undefined,
		stderrText: string,
		fallbackMessage: string,
	) => string;
	readonly encodeClaudeProjectSlug: (cwd: string) => string;
	readonly parseKiloCliModelsOutput: (stdout: string) => Array<{ id: string; name: string }>;
	readonly ClaudeRuntime: new (executable: string, remoteTarget?: unknown) => {
		send(session: Record<string, unknown>, text: string, stream: Record<string, (...args: unknown[]) => void>, token: unknown, options?: Record<string, unknown>): Promise<void>;
		getRuntimeCapabilities(cwd: string, session?: Record<string, unknown>): Promise<{ defaultModel?: string; models?: Array<{ id: string; name: string }> }>;
		dispose(): void;
	};
	readonly CodexRuntime: new (executable: string) => {
		prepareSession(session: Record<string, unknown>, options: Record<string, unknown> | undefined, token: unknown): Promise<void>;
		send(session: Record<string, unknown>, text: string, stream: Record<string, (...args: unknown[]) => void>, token: unknown, options?: Record<string, unknown>): Promise<void>;
		dispose(): void;
	};
	readonly KiloRuntime: new (executable: string) => {
		send(session: Record<string, unknown>, text: string, stream: Record<string, (...args: unknown[]) => void>, token: unknown, options?: Record<string, unknown>): Promise<void>;
		getRuntimeCapabilities(cwd: string): Promise<{ models?: Array<{ id: string; name: string }> }>;
		dispose(): void;
	};
	readonly DshRuntime: new (executable: string) => {
		send(session: Record<string, unknown>, text: string, stream: Record<string, (...args: unknown[]) => void>, token: unknown, options?: Record<string, unknown>): Promise<void>;
		getRuntimeCapabilities(cwd: string, session?: Record<string, unknown>): Promise<{ models?: Array<{ id: string; name: string }> }>;
		dispose(): void;
	};
	readonly AntigravityRuntime: new (executable: string) => {
		getRuntimeCapabilities(cwd: string, session?: Record<string, unknown>): Promise<{ models?: Array<{ id: string; name: string }> }>;
		dispose(): void;
	};
	readonly PiRuntime: new (executable: string) => {
		getRuntimeCapabilities(cwd: string, session?: Record<string, unknown>): Promise<{ defaultModel?: string; models?: Array<{ id: string; name: string }> }>;
		dispose(): void;
	};
}

const tempDirs: string[] = [];
after(() => {
	for (const d of tempDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch { /* ignore */ }
	}
});

function createTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createExecutableNodeScript(dir: string, name: string, body: string): string {
	const scriptPath = path.join(dir, `${name}.cjs`);
	fs.writeFileSync(scriptPath, body, 'utf8');
	const wrapperPath = path.join(dir, name);
	fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
	return wrapperPath;
}

function makeCollectStream(): {
	readonly stream: Record<string, (...args: unknown[]) => void>;
	getMarkdown(): string;
} {
	const parts: string[] = [];
	return {
		stream: {
			markdown: (v: unknown) => {
				parts.push(typeof v === 'string' ? v : String((v as { value?: unknown })?.value ?? ''));
			},
			progress: () => { },
			thinkingProgress: () => { },
			push: () => { },
		},
		getMarkdown: () => parts.join(''),
	};
}

let cachedBundle: Promise<Wave7Bundle> | undefined;
function loadWave7Bundle(): Promise<Wave7Bundle> {
	if (!cachedBundle) {
		cachedBundle = (async () => {
			const esbuild = await import('esbuild');
			const tmpDir = createTempDir(`ade-w7-bundle-${process.pid}-`);
			const vscodeShimPath = path.join(tmpDir, 'vscode-mock.mjs');
			fs.writeFileSync(vscodeShimPath, `
import * as path from 'node:path';

class MockEventEmitter {
	constructor() {
		this._listeners = new Set();
		this.event = (listener) => {
			this._listeners.add(listener);
			return { dispose: () => this._listeners.delete(listener) };
		};
	}
	fire(data) {
		for (const fn of [...this._listeners]) {
			fn(data);
		}
	}
	dispose() {
		this._listeners.clear();
	}
}

class MockCancellationError extends Error {
	constructor() {
		super('Canceled');
		this.name = 'CancellationError';
	}
}

class MockCancellationTokenSource {
	constructor() {
		this._cancelled = false;
		this._listeners = new Set();
		const self = this;
		this.token = {
			get isCancellationRequested() { return self._cancelled; },
			onCancellationRequested(fn) {
				if (self._cancelled) {
					fn();
					return { dispose() {} };
				}
				self._listeners.add(fn);
				return { dispose: () => self._listeners.delete(fn) };
			},
		};
	}
	cancel() {
		if (this._cancelled) return;
		this._cancelled = true;
		for (const fn of [...this._listeners]) {
			fn();
		}
	}
	dispose() {
		this._listeners.clear();
	}
}

class MockUri {
	constructor(scheme, authority, uriPath) {
		this.scheme = scheme || 'file';
		this.authority = authority || '';
		this.path = uriPath || '';
	}
	get fsPath() { return this.path; }
	with(change) {
		return new MockUri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
		);
	}
	toString() {
		if (this.authority) return \`\${this.scheme}://\${this.authority}\${this.path}\`;
		if (this.scheme === 'file') return \`file://\${this.path}\`;
		return \`\${this.scheme}:\${this.path}\`;
	}
	static file(fsPath) {
		const resolved = path.resolve(fsPath).replace(/\\\\/g, '/');
		return new MockUri('file', '', resolved.startsWith('/') ? resolved : '/' + resolved);
	}
	static from(components) {
		return new MockUri(components.scheme, components.authority || '', components.path || '');
	}
	static joinPath(base, ...segments) {
		return new MockUri(base.scheme, base.authority, path.posix.join(base.path || '/', ...segments));
	}
	static parse(raw) {
		const m = /^([a-zA-Z0-9+.-]+):(?:\\/\\/([^/]*))?(.*)$/.exec(String(raw));
		if (!m) return MockUri.file(String(raw));
		let p = m[3] || '';
		if (!m[2] && p.startsWith('///')) p = p.slice(2);
		return new MockUri(m[1], m[2] || '', p);
	}
}

class MockThemeIcon { constructor(id) { this.id = id; } }
class MockMarkdownString { constructor(value = '') { this.value = value; } }
class MockLocation { constructor(uri, range) { this.uri = uri; this.range = range; } }
class MockChatRequestTurn2 {
	constructor(prompt, command, references, participant, toolReferences, editedFileEvents, id, modelId, modeInstructions2, isSystemInitiated) {
		this.prompt = prompt;
		this.command = command;
		this.references = references;
		this.participant = participant;
		this.id = id;
		this.isSystemInitiated = isSystemInitiated;
	}
}
class MockChatResponseMarkdownPart {
	constructor(value) { this.value = typeof value === 'string' ? new MockMarkdownString(value) : value; }
}
class MockChatResponseTurn2 {
	constructor(response, result, participant) {
		this.response = response;
		this.result = result;
		this.participant = participant;
	}
}

const configListeners = new Set();
export const __controller = {
	autonomousMode: true,
	cliPaths: {},
	httpProxy: '',
	registeredCommands: new Map(),
	contentProviders: new Map(),
	createUri: (raw) => MockUri.parse(raw),
	createCts: () => new MockCancellationTokenSource(),
	resetForActivation: () => {
		__controller.registeredCommands.clear();
		__controller.contentProviders.clear();
		configListeners.clear();
	},
};

export const EventEmitter = MockEventEmitter;
export const CancellationError = MockCancellationError;
export const CancellationTokenSource = MockCancellationTokenSource;
export const Uri = MockUri;
export const ThemeIcon = MockThemeIcon;
export const MarkdownString = MockMarkdownString;
export const Location = MockLocation;
export const ChatRequestTurn2 = MockChatRequestTurn2;
export const ChatResponseTurn2 = MockChatResponseTurn2;
export const ChatResponseMarkdownPart = MockChatResponseMarkdownPart;
export const ChatSessionStatus = { Completed: 1, InProgress: 2, Failed: 3 };
export const ChatSessionCustomizationType = { Skill: 1, Prompt: 2, Agent: 3, Instructions: 4, Hook: 5, Plugins: 6 };
export const env = { appRoot: ${JSON.stringify(EXTENSION_ROOT)} };
export const l10n = {
	t: (msg, ...args) => String(msg).replace(/\\{(\\d+)\\}/g, (_, i) => String(args[Number(i)] ?? '')),
};
export const workspace = {
	workspaceFolders: [{ uri: MockUri.file(process.cwd()) }],
	getConfiguration: (section) => ({
		get: (key, defaultVal) => {
			if (section === 'aexus.ade' && key === 'autonomousMode') return __controller.autonomousMode;
			if (section === 'aexus.ade' && key === 'cliPaths') return { ...__controller.cliPaths };
			if (section === 'aexus.ade.cliPaths') return __controller.cliPaths[key] ?? defaultVal;
			if (section === 'http' && key === 'proxy') return __controller.httpProxy || defaultVal;
			return defaultVal;
		},
		inspect: (key) => {
			if (section === 'aexus.ade' && key === 'autonomousMode') {
				return { globalValue: __controller.autonomousMode, defaultValue: true };
			}
			if (section === 'aexus.ade' && key === 'cliPaths') {
				return { globalValue: { ...__controller.cliPaths } };
			}
			return undefined;
		},
	}),
	onDidChangeConfiguration: (fn) => {
		configListeners.add(fn);
		return { dispose: () => configListeners.delete(fn) };
	},
};
export const window = {
	showWarningMessage: async () => undefined,
	showInformationMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	showInputBox: async () => undefined,
	showQuickPick: async (items) => items[0],
};
export const commands = {
	registerCommand: (id, handler) => {
		__controller.registeredCommands.set(id, handler);
		return {
			dispose: () => {
				if (__controller.registeredCommands.get(id) === handler) {
					__controller.registeredCommands.delete(id);
				}
			},
		};
	},
	executeCommand: async (id, ...args) => {
		const fn = __controller.registeredCommands.get(id);
		return fn ? await fn(...args) : undefined;
	},
};
export const chat = {
	createChatParticipant: (id, handler) => ({ id, requestHandler: handler, iconPath: undefined, dispose() {} }),
	createChatSessionItemController: () => ({
		createChatSessionItem: (resource, label) => ({ resource, label, description: '', metadata: {} }),
		createChatSessionInputState: (groups) => ({
			groups,
			sessionResource: undefined,
			onDidDispose: () => ({ dispose() {} }),
			dispose() {},
		}),
		items: { add() {}, delete() {}, replace() {} },
		dispose() {},
	}),
	registerChatSessionContentProvider: (scheme, provider) => {
		__controller.contentProviders.set(scheme, provider);
		return { dispose: () => { __controller.contentProviders.delete(scheme); } };
	},
};
`, 'utf8');

			const outPath = path.join(tmpDir, 'wave7-bundle.mjs');
			await esbuild.build({
				stdin: {
					contents: `
						export { __controller as vscodeMock } from 'vscode';
						export { activate as activateExtension } from './src/extension.ts';
						export { applyHttpConfigurationToEnv, refreshNvmNodeBinDirectories, getStandardCliDirectories, findExecutable } from './src/runtime.ts';
						export { applyHttpProxySettingsToEnv, enrichCodingAgentPath } from '../../src/vs/platform/ade/common/adeEnv.ts';
						export { ClaudeRuntime, extractClaudeErrorDetail, encodeClaudeProjectSlug } from './src/claude.ts';
						export { CodexRuntime } from './src/codex.ts';
						export { KiloRuntime, parseKiloCliModelsOutput } from './src/kilo.ts';
						export { DshRuntime, AntigravityRuntime } from './src/acp.ts';
						export { PiRuntime } from './src/pi.ts';
					`,
					resolveDir: EXTENSION_ROOT,
					loader: 'ts',
				},
				alias: { vscode: vscodeShimPath },
				define: { __dirname: JSON.stringify(path.join(EXTENSION_ROOT, 'dist')) },
				bundle: true,
				outfile: outPath,
				platform: 'node',
				format: 'esm',
			});
			return await import(pathToFileURL(outPath).href) as Wave7Bundle;
		})();
	}
	return cachedBundle;
}

function createExtensionContextStub(vscodeMock: VscodeMockController, initialState: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(initialState));
	const subscriptions: Array<{ dispose(): void }> = [];
	return {
		extensionPath: EXTENSION_ROOT,
		extensionUri: vscodeMock.createUri(`file://${EXTENSION_ROOT}`),
		subscriptions,
		globalState: {
			get: <T>(k: string, defaultVal?: T): T => (store.has(k) ? (store.get(k) as T) : (defaultVal as T)),
			update: async (k: string, v: unknown) => {
				store.set(k, v);
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

describe('Wave 7 Track A + Track B2: Session Race Elimination, 8-Engine Self-Healing & Real Model/Effort Discovery', { skip: process.platform === 'win32' ? 'POSIX mock CLIs.' : false }, () => {
	test('[Track A-1] cuts pre-send markAgentSessionStarted -> syncCachedEmployeeMeta fake-UUID race and self-heals poisoned Chief state.vscdb entries', async () => {
		const bundle = await loadWave7Bundle();
		const { vscodeMock, activateExtension, encodeClaudeProjectSlug } = bundle;

		const tmpDir = createTempDir('w7-race-');
		const claudeCfgDir = path.join(tmpDir, 'claude-cfg');
		fs.mkdirSync(path.join(claudeCfgDir, 'projects'), { recursive: true });
		const invocationsLog = path.join(tmpDir, 'invocations.jsonl');

		// Strict mock Claude CLI: rejects --resume if .jsonl does not exist on disk yet, creates .jsonl on --session-id!
		const mockClaude = createExecutableNodeScript(tmpDir, 'claude', `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const argv = process.argv.slice(2);
const resumeIdx = argv.indexOf('--resume');
const sidIdx = argv.indexOf('--session-id');
const sid = resumeIdx >= 0 ? argv[resumeIdx + 1] : (sidIdx >= 0 ? argv[sidIdx + 1] : 'unknown');
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
const projDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug);
const jsonlPath = path.join(projDir, sid + '.jsonl');
fs.appendFileSync(${JSON.stringify(invocationsLog)}, JSON.stringify({ argv, isResume: resumeIdx >= 0, sid }) + '\\n');
if (resumeIdx >= 0 && !fs.existsSync(jsonlPath)) {
	process.stdout.write(JSON.stringify({
		type: 'result',
		subtype: 'error_during_execution',
		is_error: true,
		errors: ['No conversation found with session ID: ' + sid],
	}) + '\\n');
	process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	fs.mkdirSync(projDir, { recursive: true });
	fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'deepseek-flash[1m]' }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Chief ready' }] } }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Chief ready' }) + '\\n');
	process.exit(0);
});
`);

		const savedClaudeCfg = process.env.CLAUDE_CONFIG_DIR;
		const savedPath = process.env.PATH;
		process.env.CLAUDE_CONFIG_DIR = claudeCfgDir;
		process.env.PATH = '';

		const poisonedChiefUuid = 'b9b1b4cb-1111-4222-8333-444444444444';
		vscodeMock.resetForActivation();
		vscodeMock.autonomousMode = true;
		vscodeMock.cliPaths = { claude: mockClaude };

		const ctx = createExtensionContextStub(vscodeMock, {
			nativeSessions: {
				'claude:ade-proj_poison-agent_chief': {
					id: poisonedChiefUuid,
					resourceId: 'ade-proj_poison-agent_chief',
					engine: 'claude',
					cwd: tmpDir,
					label: 'Chief',
					created: Date.now() - 10000,
					updated: Date.now() - 10000,
					provisional: false, // Poisoned by legacy bug without .jsonl on disk!
					nativeId: poisonedChiefUuid,
					adeProjectId: 'proj_poison',
					adeAgentId: 'agent_chief',
				},
			},
		});

		const lifecycleEvents: string[] = [];
		try {
			await activateExtension(ctx);

			vscodeMock.registeredCommands.set('aexus.ade.resolveEmployeeSessionMeta', async (_projId: unknown, agentId: unknown) => {
				if (agentId === 'agent_chief') {
					return {
						agentId: 'agent_chief',
						name: 'Chief',
						engine: 'claude',
						sessionStarted: true,
						workspaceCwdUri: `file://${tmpDir}`,
						nativeSessionId: poisonedChiefUuid,
					};
				}
				return {
					agentId: 'agent_fresh',
					name: 'Fresh Engineer',
					engine: 'claude',
					sessionStarted: false,
					workspaceCwdUri: `file://${tmpDir}`,
				};
			});

			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarting', async (projId: unknown, agentId: unknown, resUri: unknown) => {
				lifecycleEvents.push(`starting:${String(projId)}:${String(agentId)}:${String(resUri)}`);
				// Simulate aggressive fireProjectChanged -> syncCachedEmployeeMeta callback during pre-send!
				const syncFn = vscodeMock.registeredCommands.get('aexus.ade.syncCachedEmployeeMeta');
				await syncFn?.({
					projectId: projId,
					agents: [{
						agentId,
						name: 'Fresh Engineer',
						engine: 'claude',
						sessionStarted: true,
						workspaceCwdUri: `file://${tmpDir}`,
						nativeSessionId: '00000000-fake-race-uuid-999999999999',
					}],
				});
			});

			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarted', async (projId: unknown, agentId: unknown, sid: unknown) => {
				lifecycleEvents.push(`started:${String(projId)}:${String(agentId)}:${String(sid)}`);
			});

			const claudeProvider = vscodeMock.contentProviders.get('aexus-claude')!;
			const cts = vscodeMock.createCts();

			// Subcase A: Brand-new unstarted employee survives mid-flight syncCachedEmployeeMeta without fake-UUID overwrite or --resume crash
			const freshUri = vscodeMock.createUri('aexus-claude:/ade-proj_race-agent_fresh');
			const freshSession = await claudeProvider.provideChatSessionContent(freshUri, cts.token);
			const freshStream = makeCollectStream();
			await freshSession.requestHandler!({ prompt: 'hi fresh', references: [] }, {}, freshStream.stream, cts.token);
			assert.equal(freshStream.getMarkdown(), 'Chief ready');
			assert.equal(lifecycleEvents[0], 'starting:proj_race:agent_fresh:aexus-claude:/ade-proj_race-agent_fresh');
			assert.equal(lifecycleEvents[1]?.startsWith('started:proj_race:agent_fresh:'), true);
			assert.equal(lifecycleEvents[1]?.endsWith('00000000-fake-race-uuid-999999999999'), false, 'Active turn must reject mid-flight nativeSessionId overwrite');

			// Subcase B: Poisoned Chief (provisional: false in state.vscdb, no .jsonl on disk) heals via --session-id on Turn 1, then uses --resume on Turn 2
			const chiefUri = vscodeMock.createUri('aexus-claude:/ade-proj_poison-agent_chief');
			const chiefSession = await claudeProvider.provideChatSessionContent(chiefUri, cts.token);
			const s1 = makeCollectStream();
			await chiefSession.requestHandler!({ prompt: 'hi，你的职级？', references: [] }, {}, s1.stream, cts.token);
			assert.equal(s1.getMarkdown(), 'Chief ready');

			const realTmpDir = fs.realpathSync(tmpDir);
			const expectedJsonl = path.join(claudeCfgDir, 'projects', encodeClaudeProjectSlug(realTmpDir), `${poisonedChiefUuid}.jsonl`);
			assert.equal(fs.existsSync(expectedJsonl), true, 'Turn 1 must materialize .jsonl under encoded cwd slug');

			const s2 = makeCollectStream();
			await chiefSession.requestHandler!({ prompt: 'second turn', references: [] }, {}, s2.stream, cts.token);
			assert.equal(s2.getMarkdown(), 'Chief ready');

			const logged = fs.readFileSync(invocationsLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { isResume: boolean; sid: string });
			assert.equal(logged.length, 3);
			assert.equal(logged[0].isResume, false, 'Fresh session Turn 1 must use --session-id');
			assert.equal(logged[1].sid, poisonedChiefUuid);
			assert.equal(logged[1].isResume, false, 'Poisoned Chief without .jsonl must self-heal with --session-id');
			assert.equal(logged[2].sid, poisonedChiefUuid);
			assert.equal(logged[2].isResume, true, 'Once .jsonl exists on disk, Turn 2 must use --resume');

			freshSession.dispose();
			chiefSession.dispose();
			cts.dispose();
		} finally {
			ctx.disposeAll();
			if (savedClaudeCfg === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = savedClaudeCfg;
			}
			process.env.PATH = savedPath;
		}
	});

	test('[Track A-2 & A-3] surfaces sanitized real errors (event.errors + stderr) and self-heals missing sessions & rejected models across Claude, Codex, Kilo & ACP', async () => {
		const bundle = await loadWave7Bundle();
		const {
			vscodeMock,
			extractClaudeErrorDetail,
			ClaudeRuntime,
			CodexRuntime,
			KiloRuntime,
			DshRuntime,
		} = bundle;

		// 1. Secret sanitization + priority extraction
		const extracted = extractClaudeErrorDetail(
			{
				result: '',
				errors: ['Gateway rejected Authorization: Bearer sk-1234567890abcdef1234567890 and apiKey="secret_abc123456789"'],
			},
			'',
			'Claude Code could not complete this request.',
		);
		assert.equal(extracted.includes('sk-1234567890'), false);
		assert.equal(extracted.includes('secret_abc123456789'), false);
		assert.equal(extracted.includes('[REDACTED]'), true);
		assert.equal(sanitizeSensitiveErrorText('token=ades1.jti123.sec456789'), 'token=[REDACTED]');

		const tmpDir = createTempDir('w7-selfheal-');
		const claudeCfgDir = path.join(tmpDir, 'claude-cfg');
		fs.mkdirSync(claudeCfgDir, { recursive: true });
		fs.writeFileSync(path.join(claudeCfgDir, 'settings.json'), JSON.stringify({
			model: 'deepseek-flash[1m]',
			modelPicker: { replaceBuiltInOptions: true },
		}));

		const savedClaudeCfg = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = claudeCfgDir;
		const cts = vscodeMock.createCts();

		try {
			// 2a. Claude stderr fallback when result event has empty result/errors
			const stderrClaudeBin = createExecutableNodeScript(tmpDir, 'claude-stderr', `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
	process.stdout.write(JSON.stringify({ type: 'result', is_error: true }) + '\\n');
	process.stderr.write('Upstream 502 Bad Gateway with key sk-abcdef1234567890abcdef\\n');
	process.exit(1);
});
`);
			const stderrRt = new ClaudeRuntime(stderrClaudeBin);
			await assert.rejects(
				() => stderrRt.send({ id: 'sid-err', cwd: tmpDir, label: 'Err', created: 1, updated: 1, provisional: true }, 'hi', makeCollectStream().stream, cts.token),
				(err: Error) => err.message.includes('Upstream 502 Bad Gateway') && !err.message.includes('sk-abcdef1234567890abcdef') && err.message.includes('[REDACTED]'),
			);
			stderrRt.dispose();

			// 2b. Claude rejected legacy built-in model (`claude-sonnet-4-6`) retries with configured default (`deepseek-flash[1m]`)
			const modelRetryLog = path.join(tmpDir, 'claude-model-retry.jsonl');
			const modelRetryBin = createExecutableNodeScript(tmpDir, 'claude-model-retry', `
const fs = require('node:fs');
const readline = require('node:readline');
const argv = process.argv.slice(2);
const mIdx = argv.indexOf('--model');
const model = mIdx >= 0 ? argv[mIdx + 1] : '';
fs.appendFileSync(${JSON.stringify(modelRetryLog)}, JSON.stringify({ model, argv }) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', () => {
	if (model === 'claude-sonnet-4-6') {
		process.stdout.write(JSON.stringify({
			type: 'result',
			is_error: true,
			errors: ['Error: model claude-sonnet-4-6 is not supported by custom router'],
		}) + '\\n');
		process.exit(1);
		return;
	}
	process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered on ' + model }] } }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }) + '\\n');
	process.exit(0);
});
`);
			const modelRt = new ClaudeRuntime(modelRetryBin);
			const modelStream = makeCollectStream();
			await modelRt.send(
				{ id: 'sid-model', cwd: tmpDir, label: 'M', created: 1, updated: 1, provisional: true },
				'hi',
				modelStream.stream,
				cts.token,
				{ model: 'claude-sonnet-4-6' },
			);
			assert.equal(modelStream.getMarkdown(), 'Recovered on deepseek-flash[1m]');
			const modelAttempts = fs.readFileSync(modelRetryLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { model: string });
			assert.deepEqual(modelAttempts.map(a => a.model), ['claude-sonnet-4-6', 'deepseek-flash[1m]']);
			modelRt.dispose();

			// 2c. Codex thread/resume missing rollout self-heals via thread/start even when provisional=false
			const mockCodexBin = createExecutableNodeScript(tmpDir, 'codex', `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'mock-codex' } } }) + '\\n');
	} else if (msg.method === 'thread/resume') {
		process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'no rollout found for thread ' + msg.params.threadId } }) + '\\n');
	} else if (msg.method === 'thread/start') {
		process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 'healed-codex-thread-99', cwd: process.cwd(), createdAt: 1, updatedAt: 1 }, model: 'gpt-5.6-terra' } }) + '\\n');
	}
});
`);
			const codexRt = new CodexRuntime(mockCodexBin);
			try {
				const codexSession: Record<string, unknown> = {
					id: 'stale-codex-uuid',
					cwd: tmpDir,
					label: 'Codex',
					customLabel: true,
					created: 1,
					updated: 1,
					provisional: false,
					unmaterialized: false,
				};
				await codexRt.prepareSession(codexSession, undefined, cts.token);
				assert.equal(codexSession.id, 'healed-codex-thread-99');
				assert.equal(codexSession.label, 'Codex');
			} finally {
				codexRt.dispose();
			}

			// 2d. Kilo 404 Session not found recreates session via POST /session and retries cleanly
			let kiloMsgCalls = 0;
			const sseResponses = new Set<http.ServerResponse>();
			const kiloHttp = http.createServer((req, res) => {
				const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
				const chunks: Buffer[] = [];
				req.on('data', c => chunks.push(c));
				req.on('end', () => {
					if (pathname === '/event') {
						res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
						res.write(': connected\n\n');
						sseResponses.add(res);
						req.on('close', () => sseResponses.delete(res));
						return;
					}
					res.setHeader('Content-Type', 'application/json');
					if (pathname === '/global/health') {
						res.end(JSON.stringify({ healthy: true }));
						return;
					}
					if (pathname === '/agent') {
						res.end(JSON.stringify([{ name: 'code', mode: 'primary' }]));
						return;
					}
					if (pathname === '/config/providers') {
						res.end(JSON.stringify({ providers: [{ id: 'deepseek-official', models: { 'deepseek-flash': { name: 'DeepSeek Flash' } } }] }));
						return;
					}
					if (pathname === '/command') {
						res.end(JSON.stringify([]));
						return;
					}
					if (req.method === 'POST' && pathname === '/session') {
						res.end(JSON.stringify({ id: 'healed-kilo-session-77', directory: tmpDir, title: 'Healed', time: { created: 1, updated: 1 } }));
						return;
					}
					if (req.method === 'POST' && pathname === '/session/stale-kilo-id/message') {
						kiloMsgCalls++;
						res.statusCode = 404;
						res.end(JSON.stringify({ message: 'Session not found: stale-kilo-id' }));
						return;
					}
					if (req.method === 'POST' && pathname === '/session/healed-kilo-session-77/message') {
						kiloMsgCalls++;
						res.end(JSON.stringify({ info: {}, parts: [{ type: 'text', text: 'Kilo healed reply' }] }));
						return;
					}
					res.statusCode = 404;
					res.end('{}');
				});
			});
			await new Promise<void>(resolve => kiloHttp.listen(0, '127.0.0.1', () => resolve()));
			const kiloPort = (kiloHttp.address() as { port: number }).port;
			const mockKiloBin = createExecutableNodeScript(tmpDir, 'kilo', `
if (process.argv[2] === 'models') {
	process.stdout.write('\\x1b[32mdeepseek-official/deepseek-flash\\x1b[0m\\n');
	process.exit(0);
}
process.stdout.write('kilo server listening on http://127.0.0.1:${kiloPort}\\n');
const timer = setInterval(() => {}, 10000);
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
process.stdin.resume();
`);
			const kiloRt = new KiloRuntime(mockKiloBin);
			try {
				const kiloSession: Record<string, unknown> = {
					id: 'stale-kilo-id',
					cwd: tmpDir,
					label: 'Kilo',
					created: 1,
					updated: 1,
					provisional: false,
					unmaterialized: false,
				};
				const kiloStream = makeCollectStream();
				await kiloRt.send(kiloSession, 'hello kilo', kiloStream.stream, cts.token);
				assert.equal(kiloSession.id, 'healed-kilo-session-77');
				assert.equal(kiloMsgCalls, 2);
				assert.equal(kiloStream.getMarkdown(), 'Kilo healed reply');
			} finally {
				kiloRt.dispose();
				for (const sse of sseResponses) {
					try { sse.destroy(); } catch { /* ignore */ }
				}
				kiloHttp.closeAllConnections?.();
				await new Promise<void>(resolve => kiloHttp.close(() => resolve()));
			}

			// 2e. ACP (DSH) -32602 Session not found on session/resume + session/load self-heals via session/new
			const mockDshBin = createExecutableNodeScript(tmpDir, 'dsh', `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		process.stdout.write(JSON.stringify({
			id: msg.id,
			result: { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } },
		}) + '\\n');
	} else if (msg.method === 'session/resume' || msg.method === 'session/load') {
		process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: 'Unknown session stale-dsh-id' } }) + '\\n');
	} else if (msg.method === 'session/new') {
		process.stdout.write(JSON.stringify({
			id: msg.id,
			result: {
				sessionId: 'healed-dsh-session-88',
				models: { currentModelId: 'deepseek-official/deepseek-v4', availableModels: [{ modelId: 'deepseek-official/deepseek-v4', name: 'DeepSeek V4' }] },
			},
		}) + '\\n');
	} else if (msg.method === 'session/prompt') {
		process.stdout.write(JSON.stringify({
			method: 'session/update',
			params: {
				sessionId: msg.params.sessionId,
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DSH healed reply' } },
			},
		}) + '\\n');
		process.stdout.write(JSON.stringify({ id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
	}
});
`);
			const dshRt = new DshRuntime(mockDshBin);
			try {
				const dshSession: Record<string, unknown> = {
					id: 'stale-dsh-id',
					cwd: tmpDir,
					label: 'DSH',
					created: 1,
					updated: 1,
					provisional: false,
					unmaterialized: false,
				};
				const dshStream = makeCollectStream();
				await dshRt.send(dshSession, 'hello dsh', dshStream.stream, cts.token);
				assert.equal(dshSession.id, 'healed-dsh-session-88');
				assert.equal(dshStream.getMarkdown(), 'DSH healed reply');
			} finally {
				dshRt.dispose();
			}
		} finally {
			cts.dispose();
			if (savedClaudeCfg === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = savedClaudeCfg;
			}
		}
	});

	test('[Track A-3] enforces NO_PROXY loopback bypass when HTTP(S)_PROXY is active and enriches macOS GUI minimal PATH + user-first codex lookup', async () => {
		const bundle = await loadWave7Bundle();
		const {
			vscodeMock,
			applyHttpConfigurationToEnv,
			applyHttpProxySettingsToEnv,
			enrichCodingAgentPath,
			refreshNvmNodeBinDirectories,
			getStandardCliDirectories,
			findExecutable,
		} = bundle;

		// 1. runtime.ts applyHttpConfigurationToEnv
		vscodeMock.httpProxy = 'http://127.0.0.1:7890';
		const env1: NodeJS.ProcessEnv = { NO_PROXY: '.internal.corp, localhost' };
		applyHttpConfigurationToEnv(env1);
		assert.equal(env1.HTTP_PROXY, 'http://127.0.0.1:7890');
		assert.equal(env1.HTTPS_PROXY, 'http://127.0.0.1:7890');
		for (const host of ['127.0.0.1', 'localhost', '::1', '.internal.corp']) {
			assert.equal((env1.NO_PROXY ?? '').split(',').includes(host), true);
			assert.equal((env1.no_proxy ?? '').split(',').includes(host), true);
		}
		vscodeMock.httpProxy = '';

		// Even when proxy was pre-populated in env rather than VS Code http.proxy setting:
		const env2: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
		applyHttpConfigurationToEnv(env2);
		assert.equal(env2.NO_PROXY, '127.0.0.1,localhost,::1');
		assert.equal(env2.no_proxy, '127.0.0.1,localhost,::1');

		// 2. adeEnv.ts applyHttpProxySettingsToEnv + enrichCodingAgentPath
		const env3: Record<string, string | undefined> = {};
		applyHttpProxySettingsToEnv(env3, { proxy: 'http://127.0.0.1:7890', noProxy: '10.0.0.1' }, true);
		assert.equal(env3.NO_PROXY, '10.0.0.1,127.0.0.1,localhost,::1');

		const enriched = enrichCodingAgentPath('/usr/bin:/bin', '/Users/testuser', true, false, undefined, ['v20.11.0', 'v22.14.0']);
		const parts = enriched.split(':');
		for (const expectedDir of [
			'/Users/testuser/.gemini/bin',
			'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin',
			'/Users/testuser/.npm-global/bin',
			'/Users/testuser/.local/node-current/bin',
			'/Users/testuser/.bun/bin',
			'/Users/testuser/.volta/bin',
			'/Users/testuser/.asdf/shims',
			'/Users/testuser/.cargo/bin',
			'/Users/testuser/.nvm/versions/node/v22.14.0/bin',
			'/Users/testuser/.nvm/versions/node/v20.11.0/bin',
		]) {
			assert.equal(parts.includes(expectedDir), true, `Missing expected dir ${expectedDir}`);
		}
		assert.equal(
			parts.indexOf('/Users/testuser/.nvm/versions/node/v22.14.0/bin') < parts.indexOf('/Users/testuser/.nvm/versions/node/v20.11.0/bin'),
			true,
			'NVM node versions must be ordered descending so newest wins',
		);

		// 3. runtime.ts getStandardCliDirectories + user-PATH-first codex lookup
		const tmpHome = createTempDir('w7-gui-home-');
		fs.mkdirSync(path.join(tmpHome, '.nvm', 'versions', 'node', 'v18.0.0', 'bin'), { recursive: true });
		fs.mkdirSync(path.join(tmpHome, '.nvm', 'versions', 'node', 'v22.9.0', 'bin'), { recursive: true });
		const userNpmBin = path.join(tmpHome, '.npm-global', 'bin');
		fs.mkdirSync(userNpmBin, { recursive: true });
		const userCodex = createExecutableNodeScript(userNpmBin, 'codex', 'process.exit(0);');
		const legacyBundledDir = path.join(tmpHome, '.aexus-code', 'extensions', 'openai.chatgpt-0.1.0', 'bin', 'macos-aarch64');
		fs.mkdirSync(legacyBundledDir, { recursive: true });
		createExecutableNodeScript(legacyBundledDir, 'codex', 'process.exit(0);');

		const savedHome = process.env.HOME;
		const savedPath = process.env.PATH;
		process.env.HOME = tmpHome;
		process.env.PATH = '/usr/bin:/bin';
		try {
			await refreshNvmNodeBinDirectories(tmpHome);
			const stdDirs = getStandardCliDirectories({ HOME: tmpHome });
			assert.equal(stdDirs.includes(path.join(tmpHome, '.nvm', 'versions', 'node', 'v22.9.0', 'bin')), true);
			const resolvedCodex = await findExecutable('codex');
			assert.equal(resolvedCodex, userCodex, 'findExecutable(codex) must prefer user ~/.npm-global/bin/codex over legacy bundled extension');
		} finally {
			if (savedHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = savedHome;
			}
			process.env.PATH = savedPath;
		}
	});

	test('[Track B2] discovers full 8-engine models & thinking levels, probes cold listConfiguredModels actively, and fires onDidChangeChatSessionProviderOptions', async () => {
		const bundle = await loadWave7Bundle();
		const { vscodeMock, activateExtension, parseKiloCliModelsOutput, DshRuntime, AntigravityRuntime, PiRuntime } = bundle;

		// 1. Codex max & ultra thinking tiers
		assert.equal(THINKING_LEVELS['aexus-codex'].includes('max'), true);
		assert.equal(THINKING_LEVELS['aexus-codex'].includes('ultra'), true);

		// 2. Claude JSONC settings with replaceBuiltInOptions: true + top-level model + picker + modelSettings + 6 ANTHROPIC_* env vars
		const claudeJsonc = `{
			// Default router model must appear first
			"model": "deepseek-flash[1m]",
			"modelPicker": {
				"replaceBuiltInOptions": true,
				"options": [
					{ "model": "deepseek-v4-reasoner", "label": "DeepSeek V4 Reasoner" },
					{ "model": "glm-5.1", "label": "GLM 5.1" },
				],
			},
			"modelSettings": {
				"kimi-k2.5": { "supportsImages": true },
				"deepseek-flash[1m]": { "supportsImages": true },
			},
			"env": {
				"ANTHROPIC_MODEL": "qwen3-coder-plus",
				"ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-flash",
				"ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4",
				"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
				"ANTHROPIC_DEFAULT_FABLE_MODEL": "deepseek-fable",
				"ANTHROPIC_CUSTOM_MODEL_OPTION": "minimax-m2.7",
				"ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "MiniMax M2.7",
			},
		}`;
		const parsedClaude = readClaudeSettings(claudeJsonc);
		assert.equal(parsedClaude.replaceBuiltInOptions, true);
		assert.equal(parsedClaude.defaultModel, 'deepseek-flash[1m]');
		assert.deepEqual(parsedClaude.models.map(m => m.id), [
			'deepseek-flash[1m]',
			'deepseek-v4-reasoner',
			'glm-5.1',
			'kimi-k2.5',
			'qwen3-coder-plus',
			'deepseek-v4-pro',
			'deepseek-v4',
			'deepseek-flash',
			'deepseek-fable',
			'minimax-m2.7',
		]);

		const tmpDir = createTempDir('w7-models-');
		const tmpHome = path.join(tmpDir, 'home');
		fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
		fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), claudeJsonc, 'utf8');

		// 3. Pi models.json + models-store.json merge
		fs.mkdirSync(path.join(tmpHome, '.pi', 'agent'), { recursive: true });
		fs.writeFileSync(path.join(tmpHome, '.pi', 'agent', 'models.json'), JSON.stringify({
			providers: {
				'group-openai': {
					models: [
						{ id: 'gpt-5.4', name: 'GPT-5.4' },
						{ id: 'o3-pro', name: 'o3 Pro' },
					],
				},
			},
		}));
		fs.writeFileSync(path.join(tmpHome, '.pi', 'agent', 'models-store.json'), JSON.stringify({
			deepseek: {
				models: [
					{ id: 'deepseek-chat', name: 'DeepSeek Chat' },
					{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
				],
			},
		}));
		assert.equal(readPiModelsJson(fs.readFileSync(path.join(tmpHome, '.pi', 'agent', 'models-store.json'), 'utf8')).models.length, 2);

		// 4. Antigravity variant folding + proxy injection into agy models
		assert.equal(foldAntigravityModelVariant('gemini-4-neon-xhigh').id, 'gemini-4-neon');
		assert.equal(foldAntigravityModelVariant('gpt-oss-120b-medium').id, 'gpt-oss-120b');
		const foldedAgy = parseAgyModelsOutput([
			'Fetching available models...',
			'gemini-4-neon-low\tGemini 4 Neon (Low)',
			'gemini-4-neon-high\tGemini 4 Neon (High)',
			'claude-opus-5-5-medium\tClaude Opus 5.5 (Thinking)',
			'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
		].join('\n'));
		assert.deepEqual(foldedAgy.map(m => m.id), ['gemini-4-neon', 'claude-opus-5-5', 'gpt-oss-120b']);

		// 5. Kilo ANSI CLI output parser
		const parsedKilo = parseKiloCliModelsOutput('\x1b[1mAvailable models:\x1b[0m\n\x1b[36mdeepseek-official/deepseek-flash\x1b[0m\ndeepseek-official/deepseek-v4-pro\n');
		assert.deepEqual(parsedKilo.map(m => m.id), ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro']);

		// 6. Cold listConfiguredModels + unstarted ACP probe + live onDidChangeChatSessionProviderOptions firing
		const mockAgyBin = createExecutableNodeScript(tmpDir, 'agy', `
if (process.argv[2] === 'models') {
	if (!process.env.HTTP_PROXY || !process.env.NO_PROXY || !process.env.NO_PROXY.includes('127.0.0.1')) {
		process.stderr.write('Missing proxy or NO_PROXY in agy models env\\n');
		process.exit(2);
	}
	process.stdout.write('Fetching available models...\\ngemini-4-neon-high\\tGemini 4 Neon (High)\\ngpt-oss-120b-medium\\tGPT-OSS 120B (Medium)\\n');
	process.exit(0);
}
process.exit(0);
`);
		const dshProbeCloseLog = path.join(tmpDir, 'dsh-probe-closed.txt');
		const mockDshProbeBin = createExecutableNodeScript(tmpDir, 'dsh-probe', `
const fs = require('node:fs');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		process.stdout.write(JSON.stringify({ id: msg.id, result: { agentCapabilities: {} } }) + '\\n');
	} else if (msg.method === 'session/new') {
		process.stdout.write(JSON.stringify({
			id: msg.id,
			result: {
				sessionId: 'probe-dsh-temp-1',
				models: {
					currentModelId: 'deepseek-official/deepseek-flash',
					availableModels: [
						{ modelId: 'deepseek-official/deepseek-flash', name: 'DeepSeek Flash' },
						{ modelId: 'deepseek-official/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
					],
				},
			},
		}) + '\\n');
	} else if (msg.method === 'session/close') {
		fs.writeFileSync(${JSON.stringify(dshProbeCloseLog)}, 'closed:' + msg.params.sessionId, 'utf8');
		process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
	}
});
`);
		const mockKiloFastBin = createExecutableNodeScript(tmpDir, 'kilo-fast', `
if (process.argv[2] === 'models') {
	process.stdout.write('deepseek-official/deepseek-flash\\ndeepseek-official/deepseek-v4-pro\\n');
	process.exit(0);
}
process.exit(1);
`);
		const mockPiOfflineBin = createExecutableNodeScript(tmpDir, 'pi-offline', 'process.exit(1);');

		const savedHome = process.env.HOME;
		const savedClaudeCfg = process.env.CLAUDE_CONFIG_DIR;
		const savedPath = process.env.PATH;
		process.env.HOME = tmpHome;
		process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
		process.env.PATH = '';

		vscodeMock.resetForActivation();
		vscodeMock.httpProxy = 'http://127.0.0.1:7890';
		vscodeMock.cliPaths = {
			claude: mockKiloFastBin,
			antigravity: mockAgyBin,
			dsh: mockDshProbeBin,
			kilo: mockKiloFastBin,
			pi: mockPiOfflineBin,
		};

		const ctx = createExtensionContextStub(vscodeMock);
		try {
			const dshProbeRt = new DshRuntime(mockDshProbeBin);
			const dshCaps = await dshProbeRt.getRuntimeCapabilities(tmpDir);
			assert.deepEqual(dshCaps.models?.map(m => m.id), ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro']);
			assert.equal(fs.readFileSync(dshProbeCloseLog, 'utf8'), 'closed:probe-dsh-temp-1', 'Temporary ACP probe session must be cleanly closed');
			dshProbeRt.dispose();

			const agyProbeRt = new AntigravityRuntime(mockAgyBin);
			const agyCaps = await agyProbeRt.getRuntimeCapabilities(tmpDir);
			assert.deepEqual(agyCaps.models?.map(m => m.id), ['gemini-4-neon', 'gpt-oss-120b']);
			agyProbeRt.dispose();

			const piProbeRt = new PiRuntime(mockPiOfflineBin);
			const piCaps = await piProbeRt.getRuntimeCapabilities(tmpDir);
			assert.deepEqual(piCaps.models?.map(m => m.id), [
				'group-openai/gpt-5.4',
				'group-openai/o3-pro',
				'deepseek/deepseek-chat',
				'deepseek/deepseek-reasoner',
			]);
			piProbeRt.dispose();

			const claudeModels = await discoverEngineModels('aexus-claude', tmpDir);
			assert.equal(claudeModels.some(m => m.id === 'claude-sonnet-4-6'), false, 'replaceBuiltInOptions:true must suppress unconfigured claude-sonnet-4-6');
			assert.equal(claudeModels[1]?.id, 'deepseek-flash[1m]', 'Configured default model must be first after default item');

			await activateExtension(ctx);
			let dshOptionsFired = 0;
			const dshProvider = vscodeMock.contentProviders.get('aexus-dsh')!;
			const disp = dshProvider.onDidChangeChatSessionProviderOptions?.(() => {
				dshOptionsFired++;
			});

			const listCmd = vscodeMock.registeredCommands.get('aexus.agentEngines.listConfiguredModels')!;
			const catalog = await listCmd(`file://${tmpDir}`) as Record<string, Array<{ id: string; label: string }>>;
			assert.equal(catalog.claude?.[0]?.id, 'deepseek-flash[1m]');
			assert.equal(catalog.claude?.some(m => m.id === 'claude-sonnet-4-6'), false);
			assert.deepEqual(catalog.dsh?.map(m => m.id), ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro']);
			assert.deepEqual(catalog.antigravity?.map(m => m.id), ['gemini-4-neon', 'gpt-oss-120b']);
			assert.deepEqual(catalog.kilo?.map(m => m.id), ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro']);
			assert.equal((catalog.pi?.length ?? 0), 4);
			assert.equal(dshOptionsFired >= 1, true, 'Resolving runtime caps must fire onDidChangeChatSessionProviderOptions');
			disp?.dispose();
		} finally {
			ctx.disposeAll();
			vscodeMock.httpProxy = '';
			if (savedHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = savedHome;
			}
			if (savedClaudeCfg === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = savedClaudeCfg;
			}
			process.env.PATH = savedPath;
		}
	});

	test('[Cross-Track Seam 1] resets started employee (provisional: false) on allowSessionReset host switch & engine switch: kills old runtime slot, rotates UUID, sets provisional/unmaterialized=true, updates cwd, and starts clean next turn', async () => {
		const bundle = await loadWave7Bundle();
		const { vscodeMock, activateExtension } = bundle;

		const tmpDir = createTempDir('w7-seam1-reset-');
		const wsLocalA = path.join(tmpDir, 'ws-local-a');
		const wsLocalB = path.join(tmpDir, 'ws-local-b');
		const claudeCfgDir = path.join(tmpDir, 'claude-cfg');
		fs.mkdirSync(wsLocalA, { recursive: true });
		fs.mkdirSync(wsLocalB, { recursive: true });
		fs.mkdirSync(path.join(claudeCfgDir, 'projects'), { recursive: true });

		const claudeRunsLog = path.join(tmpDir, 'claude-runs.jsonl');
		const codexDaemonPidFile = path.join(tmpDir, 'codex-daemon.pid');
		const codexRunsLog = path.join(tmpDir, 'codex-runs.jsonl');

		const mockClaude = createExecutableNodeScript(tmpDir, 'claude', `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const argv = process.argv.slice(2);
const resumeIdx = argv.indexOf('--resume');
const sidIdx = argv.indexOf('--session-id');
const sid = resumeIdx >= 0 ? argv[resumeIdx + 1] : (sidIdx >= 0 ? argv[sidIdx + 1] : 'unknown');
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
const projDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', slug);
const jsonlPath = path.join(projDir, sid + '.jsonl');
fs.appendFileSync(${JSON.stringify(claudeRunsLog)}, JSON.stringify({ cwd: process.cwd(), isResume: resumeIdx >= 0, sid }) + '\\n');
if (resumeIdx >= 0 && !fs.existsSync(jsonlPath)) {
	process.stdout.write(JSON.stringify({
		type: 'result',
		is_error: true,
		errors: ['No conversation found with session ID: ' + sid],
	}) + '\\n');
	process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	fs.mkdirSync(projDir, { recursive: true });
	fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', uuid: 'u', message: { content: line } }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude:' + sid } ] } }) + '\\n');
	process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'Claude:' + sid }) + '\\n');
	process.exit(0);
});
`);

		const mockCodex = createExecutableNodeScript(tmpDir, 'codex', `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(codexDaemonPidFile)}, String(process.pid), 'utf8');
let seq = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') {
		process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'mock-codex' } } }) + '\\n');
	} else if (msg.method === 'thread/start') {
		seq++;
		const tid = 'codex-native-thread-' + seq;
		fs.appendFileSync(${JSON.stringify(codexRunsLog)}, JSON.stringify({ method: 'thread/start', tid, cwd: process.cwd() }) + '\\n');
		process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: tid, cwd: process.cwd(), createdAt: 1, updatedAt: 1 }, model: 'gpt-5.4' } }) + '\\n');
	} else if (msg.method === 'thread/unsubscribe') {
		process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n');
	} else if (msg.method === 'turn/start') {
		const turnId = 'turn-' + seq;
		const threadId = msg.params?.threadId || 'codex-native-thread-1';
		process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId } } }) + '\\n');
		setImmediate(() => {
			process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'm1', delta: 'Codex:' + threadId } }) + '\\n');
			process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }) + '\\n');
		});
	}
});
setInterval(() => {}, 1000);
`);

		const savedClaudeCfg = process.env.CLAUDE_CONFIG_DIR;
		const savedPath = process.env.PATH;
		process.env.CLAUDE_CONFIG_DIR = claudeCfgDir;
		process.env.PATH = '';

		vscodeMock.resetForActivation();
		vscodeMock.autonomousMode = true;
		vscodeMock.cliPaths = { claude: mockClaude, codex: mockCodex };

		let currentMeta: Record<string, unknown> = {
			agentId: 'agent_worker',
			name: 'Worker',
			host: 'local',
			engine: 'claude',
			sessionStarted: false,
			workspaceCwdUri: `file://${wsLocalA}`,
			model: 'deepseek-flash[1m]',
			effort: 'medium',
		};

		const ctx = createExtensionContextStub(vscodeMock);
		const isPidAlive = (pid: number): boolean => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		try {
			await activateExtension(ctx);

			vscodeMock.registeredCommands.set('aexus.ade.resolveEmployeeSessionMeta', async () => ({ ...currentMeta }));
			vscodeMock.registeredCommands.set('aexus.ade.getCloudHostSshContext', async (authority: unknown) => ({
				alias: String(authority || 'gpu-box'),
				os: 'linux',
				remoteHome: '/home/ubuntu',
				hostName: '10.20.30.40',
				user: 'ubuntu',
				port: 22,
			}));
			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarting', async () => undefined);
			vscodeMock.registeredCommands.set('aexus.ade.markAgentSessionStarted', async (_p: unknown, _a: unknown, sid: unknown) => {
				currentMeta = { ...currentMeta, sessionStarted: true, nativeSessionId: String(sid) };
			});

			const claudeProvider = vscodeMock.contentProviders.get('aexus-claude')!;
			const codexProvider = vscodeMock.contentProviders.get('aexus-codex')!;
			const syncCmd = vscodeMock.registeredCommands.get('aexus.ade.syncCachedEmployeeMeta')!;
			const cts = vscodeMock.createCts();

			// 1. Start employee on Claude (local wsLocalA) -> record becomes provisional: false, unmaterialized: false
			const claudeUri = vscodeMock.createUri('aexus-claude:/ade-proj_seam1-agent_worker');
			const session1 = await claudeProvider.provideChatSessionContent(claudeUri, cts.token);
			const historyEvents: Array<readonly unknown[]> = [];
			const histSession1 = session1 as unknown as { onDidChangeHistory?: (fn: (items: readonly unknown[]) => void) => { dispose(): void } };
			const histSub = histSession1.onDidChangeHistory?.(items => historyEvents.push(items));

			const s1 = makeCollectStream();
			await session1.requestHandler!({ prompt: 'turn 1 on local A', references: [] }, {}, s1.stream, cts.token);

			const getSavedRecords = () => (ctx.store.get('nativeSessions') ?? {}) as Record<string, Record<string, unknown>>;
			const recAfterTurn1 = getSavedRecords()['claude:ade-proj_seam1-agent_worker'];
			assert.ok(recAfterTurn1, 'Expected saved claude employee record');
			const turn1Uuid = String(recAfterTurn1.id);
			assert.equal(recAfterTurn1.provisional, false);
			assert.equal(recAfterTurn1.unmaterialized, false);
			assert.equal(recAfterTurn1.nativeId, turn1Uuid);
			assert.equal(s1.getMarkdown(), `Claude:${turn1Uuid}`);

			// 2. Human UI switches SAME engine ('claude') from 'local' -> SSH host ('10.20.30.40' / 'gpu-box') with allowSessionReset: true
			currentMeta = {
				agentId: 'agent_worker',
				name: 'Worker',
				host: '10.20.30.40',
				engine: 'claude',
				sessionStarted: false,
				nativeSessionId: undefined,
				workspaceCwdUri: 'aexus-ssh://gpu-box/home/ubuntu/cloud-repo',
				model: 'deepseek-flash[1m]',
				effort: 'high',
			};
			const syncHostSwitch = await syncCmd({
				projectId: 'proj_seam1',
				agents: [currentMeta],
			}) as { synced: number; updated: boolean; migrations: unknown[] };
			assert.equal(syncHostSwitch.updated, true);
			assert.equal(syncHostSwitch.synced, 1);

			const recAfterSshSwitch = getSavedRecords()['claude:ade-proj_seam1-agent_worker'];
			const sshResetUuid = String(recAfterSshSwitch.id);
			assert.notEqual(sshResetUuid, turn1Uuid, 'Same-engine host reset MUST generate a brand-new UUID');
			assert.equal(recAfterSshSwitch.provisional, true);
			assert.equal(recAfterSshSwitch.unmaterialized, true);
			assert.equal(recAfterSshSwitch.nativeId, undefined);
			assert.equal(recAfterSshSwitch.cwd, '/home/ubuntu/cloud-repo');
			assert.equal(recAfterSshSwitch.cloudProjectUri, 'aexus-ssh://gpu-box/home/ubuntu/cloud-repo');
			assert.equal(recAfterSshSwitch.adeHost, '10.20.30.40');
			assert.equal(historyEvents.some(items => items.length === 0), true, 'Same-engine reset must clear open chat history via onDidChangeHistory([])');

			// Switch same engine ('claude') onto local wsLocalB and send Turn 2 -> must run clean --session-id (NOT --resume) in wsLocalB!
			currentMeta = {
				agentId: 'agent_worker',
				name: 'Worker',
				host: 'local',
				engine: 'claude',
				sessionStarted: false,
				nativeSessionId: undefined,
				workspaceCwdUri: `file://${wsLocalB}`,
				model: 'deepseek-flash[1m]',
				effort: 'high',
			};
			await syncCmd({ projectId: 'proj_seam1', agents: [currentMeta] });
			const recOnLocalB = getSavedRecords()['claude:ade-proj_seam1-agent_worker'];
			const localBUuid = String(recOnLocalB.id);
			assert.notEqual(localBUuid, sshResetUuid);
			assert.notEqual(localBUuid, turn1Uuid);
			assert.equal(recOnLocalB.provisional, true);
			assert.equal(recOnLocalB.unmaterialized, true);
			assert.equal(recOnLocalB.cloudProjectUri, undefined);
			assert.equal(fs.realpathSync(String(recOnLocalB.cwd)), fs.realpathSync(wsLocalB));

			const s2 = makeCollectStream();
			await session1.requestHandler!({ prompt: 'turn 2 clean on local B', references: [] }, {}, s2.stream, cts.token);
			assert.equal(s2.getMarkdown(), `Claude:${localBUuid}`);
			assert.equal(getSavedRecords()['claude:ade-proj_seam1-agent_worker'].provisional, false);

			// 3. Human UI switches started employee from 'claude' -> 'codex' (allowSessionReset: true), runs Codex turn (spawning live daemon),
			//    then switches started 'codex' -> 'claude' (allowSessionReset: true), proving live Codex daemon slot is killed & Claude gets a fresh UUID!
			currentMeta = {
				agentId: 'agent_worker',
				name: 'Worker',
				host: 'local',
				engine: 'codex',
				sessionStarted: false,
				nativeSessionId: undefined,
				workspaceCwdUri: `file://${wsLocalB}`,
				model: 'gpt-5.4',
				effort: 'high',
			};
			const syncToCodex = await syncCmd({
				projectId: 'proj_seam1',
				agents: [currentMeta],
			}) as { synced: number; updated: boolean; migrations: Array<{ agentId: string; previousEngine: string; currentEngine: string }> };
			assert.equal(syncToCodex.updated, true);
			assert.deepEqual(syncToCodex.migrations, [{ agentId: 'agent_worker', previousEngine: 'claude', currentEngine: 'codex' }]);
			assert.equal(getSavedRecords()['claude:ade-proj_seam1-agent_worker'], undefined);
			const codexRecUnstarted = getSavedRecords()['codex:ade-proj_seam1-agent_worker'];
			assert.ok(codexRecUnstarted);
			assert.notEqual(codexRecUnstarted.id, localBUuid);
			assert.equal(codexRecUnstarted.provisional, true);
			assert.equal(codexRecUnstarted.unmaterialized, true);

			const codexUri = vscodeMock.createUri('aexus-codex:/ade-proj_seam1-agent_worker');
			const codexSession = await codexProvider.provideChatSessionContent(codexUri, cts.token);
			const sCodex = makeCollectStream();
			await codexSession.requestHandler!({ prompt: 'hello codex', references: [] }, {}, sCodex.stream, cts.token);
			assert.equal(sCodex.getMarkdown(), 'Codex:codex-native-thread-1');

			const codexDaemonPid = Number(fs.readFileSync(codexDaemonPidFile, 'utf8').trim());
			assert.equal(Number.isInteger(codexDaemonPid) && codexDaemonPid > 0, true);
			assert.equal(isPidAlive(codexDaemonPid), true, 'Codex app-server daemon slot should be alive after Codex turn');
			assert.equal(getSavedRecords()['codex:ade-proj_seam1-agent_worker'].provisional, false);

			// Switch started 'codex' back to 'claude' via allowSessionReset: true -> must kill live Codex daemon slot & allocate brand-new Claude UUID!
			currentMeta = {
				agentId: 'agent_worker',
				name: 'Worker',
				host: 'local',
				engine: 'claude',
				sessionStarted: false,
				nativeSessionId: undefined,
				workspaceCwdUri: `file://${wsLocalA}`,
				model: 'deepseek-flash[1m]',
				effort: 'medium',
			};
			const syncBackToClaude = await syncCmd({
				projectId: 'proj_seam1',
				agents: [currentMeta],
			}) as { updated: boolean; migrations: Array<{ agentId: string; previousEngine: string; currentEngine: string }> };
			assert.equal(syncBackToClaude.updated, true);
			assert.deepEqual(syncBackToClaude.migrations, [{ agentId: 'agent_worker', previousEngine: 'codex', currentEngine: 'claude' }]);

			const waitKillDeadline = Date.now() + 3000;
			while (isPidAlive(codexDaemonPid) && Date.now() < waitKillDeadline) {
				await new Promise<void>(r => setTimeout(r, 25));
			}
			assert.equal(isPidAlive(codexDaemonPid), false, 'Resetting started Codex employee MUST terminate its persistent daemon slot');

			const finalClaudeRec = getSavedRecords()['claude:ade-proj_seam1-agent_worker'];
			const roundTripUuid = String(finalClaudeRec.id);
			assert.notEqual(roundTripUuid, turn1Uuid, 'claude -> codex -> claude MUST NOT reuse original Claude UUID');
			assert.notEqual(roundTripUuid, localBUuid, 'claude -> codex -> claude MUST NOT reuse prior Claude UUID');
			assert.notEqual(roundTripUuid, 'codex-native-thread-1');
			assert.equal(finalClaudeRec.provisional, true);
			assert.equal(finalClaudeRec.unmaterialized, true);

			const sessionFinal = await claudeProvider.provideChatSessionContent(claudeUri, cts.token);
			const sFinal = makeCollectStream();
			await sessionFinal.requestHandler!({ prompt: 'fresh claude after round-trip', references: [] }, {}, sFinal.stream, cts.token);
			assert.equal(sFinal.getMarkdown(), `Claude:${roundTripUuid}`);

			const claudeInvocations = fs.readFileSync(claudeRunsLog, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { cwd: string; isResume: boolean; sid: string });
			assert.equal(claudeInvocations.length, 3);
			assert.equal(claudeInvocations[0].isResume, false);
			assert.equal(claudeInvocations[0].sid, turn1Uuid);
			assert.equal(claudeInvocations[1].isResume, false, 'Turn after same-engine host reset must start fresh (--session-id)');
			assert.equal(claudeInvocations[1].sid, localBUuid);
			assert.equal(fs.realpathSync(claudeInvocations[1].cwd), fs.realpathSync(wsLocalB));
			assert.equal(claudeInvocations[2].isResume, false, 'Turn after claude -> codex -> claude reset must start fresh (--session-id)');
			assert.equal(claudeInvocations[2].sid, roundTripUuid);
			assert.equal(fs.realpathSync(claudeInvocations[2].cwd), fs.realpathSync(wsLocalA));

			histSub?.dispose();
			session1.dispose();
			codexSession.dispose();
			sessionFinal.dispose();
			cts.dispose();
		} finally {
			ctx.disposeAll();
			if (savedClaudeCfg === undefined) {
				delete process.env.CLAUDE_CONFIG_DIR;
			} else {
				process.env.CLAUDE_CONFIG_DIR = savedClaudeCfg;
			}
			process.env.PATH = savedPath;
		}
	});

	test('[Cross-Track Seam 2] auto-approves all 45 ade_* commands across bare, quoted & backslash-escaped "/Applications/Aexus Code.app/..." paths and executes "hi，你的职级？" -> ade_whoami without space word-splitting', async () => {
		const bundle = await loadWave7Bundle();
		const { vscodeMock, ClaudeRuntime } = bundle;

		assert.equal(ADE_SAFE_CLI_COMMANDS.size, 45);
		for (const cmd of ADE_SAFE_CLI_COMMANDS) {
			const variants = [
				cmd,
				`"/Applications/Aexus Code.app/Contents/Resources/app/bin/${cmd}"`,
				`'/Applications/Aexus Code.app/Contents/Resources/app/bin/${cmd}'`,
				`/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/${cmd}`,
				`/Applications/Aexus\\ Code.app/Contents/Resources/app/extensions/aexus-agents/bin/${cmd}`,
				`"/Applications/Aexus Code.app/Contents/Resources/app/bin/${cmd}" --help`,
				`/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/${cmd} --help`,
			];
			for (const v of variants) {
				assert.equal(isSafeAdeCliBashCommand(v), true, `Expected Claude Bash auto-approve for: ${v}`);
				assert.equal(isSafeAdeCliCommandInput(v), true, `Expected CLI input auto-approve for: ${v}`);
				assert.equal(isSafeCodexAdeApprovalRequest(true, 'item/commandExecution/requestApproval', { command: v }), true, `Expected Codex auto-approve for: ${v}`);
				assert.equal(isSafeKiloAdePermissionRequest(true, { permission: 'bash', command: v }), true, `Expected Kilo auto-approve for: ${v}`);
				assert.equal(isSafeAcpAdePermissionRequest(true, { toolCall: { kind: 'execute', rawInput: { command: v } } }), true, `Expected ACP auto-approve for: ${v}`);
			}

			// Shell launcher wrappers (-lc / -c) and direct argv arrays with spaces in executable path
			const appBinExe = `/Applications/Aexus Code.app/Contents/Resources/app/bin/${cmd}`;
			assert.equal(isSafeAdeCliCommandInput(`/bin/zsh -lc '"${appBinExe}"'`), true);
			assert.equal(isSafeAdeCliCommandInput(`/bin/zsh -lc '/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/${cmd}'`), true);
			assert.equal(isSafeAdeCliCommandInput(`/bin/zsh -lc ''\\''${appBinExe}'\\'''`), true);
			assert.equal(isSafeAdeCliCommandInput([appBinExe]), true, `Expected argv array with spaces to auto-approve: ${appBinExe}`);
			assert.equal(isSafeAdeCliCommandInput(['/bin/zsh', '-lc', `/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/${cmd}`]), true);
		}

		// Strict negative checks: command chaining, command substitution, redirects, and untrusted directories MUST be rejected
		for (const unsafe of [
			`"/Applications/Aexus Code.app/Contents/Resources/app/bin/ade_whoami" && id`,
			`/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/ade_whoami; uname -a`,
			`/Applications/Aexus\\ Code.app/Contents/Resources/app/bin/ade_whoami $(id)`,
			`/tmp/evil\\ dir/ade_whoami`,
			`["/tmp/Aexus Fake/ade_whoami"]`,
			`./ade_whoami`,
		]) {
			assert.equal(isSafeAdeCliBashCommand(unsafe), false, `Must reject unsafe command: ${unsafe}`);
		}
		assert.equal(isSafeAdeCliCommandInput(['/tmp/Untrusted Dir/bin/ade_whoami']), false);

		// End-to-end "hi，你的职级？" turn under non-autonomous mode (`autonomousMode = false` -> `acceptEdits`):
		// Stages real `_ade_runner` + `ade_whoami` + `adeCli.js` inside `<tmp>/Aexus Code.app/Contents/Resources/app/...`
		// and executes via backslash-escaped space path against a live mutual-HMAC UDS control server!
		const baseShortTmp = fs.mkdtempSync('/tmp/ade-s2-');
		tempDirs.push(baseShortTmp);
		const appRootWithSpace = path.join(baseShortTmp, 'Aexus Code.app', 'Contents', 'Resources', 'app');
		const appBinWithSpace = path.join(appRootWithSpace, 'bin');
		const appExtDistWithSpace = path.join(appRootWithSpace, 'extensions', 'aexus-agents', 'dist');
		fs.mkdirSync(appBinWithSpace, { recursive: true });
		fs.mkdirSync(appExtDistWithSpace, { recursive: true });

		fs.copyFileSync(path.join(EXTENSION_ROOT, 'bin', '_ade_runner'), path.join(appBinWithSpace, '_ade_runner'));
		fs.copyFileSync(path.join(EXTENSION_ROOT, 'bin', 'ade_whoami'), path.join(appBinWithSpace, 'ade_whoami'));
		fs.chmodSync(path.join(appBinWithSpace, '_ade_runner'), 0o755);
		fs.chmodSync(path.join(appBinWithSpace, 'ade_whoami'), 0o755);
		fs.copyFileSync(path.join(EXTENSION_ROOT, 'dist', 'adeCli.js'), path.join(appExtDistWithSpace, 'adeCli.js'));

		const sockPath = path.join(baseShortTmp, 'c.sock');
		const secret = crypto.randomBytes(32);
		const token = `ades1.jti_chief.${secret.toString('base64url')}`;
		const udsServer = net.createServer(socket => {
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
				const req = JSON.parse(buf.slice(0, nl)) as { jti: string; payloadJson: string; reqProof: string };
				const expectedReq = computeCliHmacRequestProof(secret, nonce, req.jti, req.payloadJson);
				assert.equal(req.reqProof, expectedReq);
				const responseJson = JSON.stringify({
					ok: true,
					agent_id: 'agent_chief',
					project_id: 'proj_1',
					level: 'L1',
					name: 'Chief',
					role_summary: 'Chief Architect',
					host: 'local',
					held_ticket_count: 0,
					wb_unread_total: 0,
					current_doc_rev: 1,
				});
				const resProof = computeCliHmacResponseProof(secret, nonce, req.jti, responseJson);
				socket.end(JSON.stringify({ type: 'response', responseJson, resProof }) + '\n');
			});
		});
		await new Promise<void>((resolve, reject) => {
			udsServer.once('error', reject);
			udsServer.listen(sockPath, () => resolve());
		});

		const backslashEscapedWhoami = path.join(appBinWithSpace, 'ade_whoami').replace(/ /g, '\\ ');
		const mockClaudeWhoami = createExecutableNodeScript(baseShortTmp, 'claude-whoami', `
const cp = require('node:child_process');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let prompted = false;
rl.on('line', (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (!prompted && msg.type === 'user') {
		prompted = true;
		process.stdout.write(JSON.stringify({
			type: 'control_request',
			request_id: 'req_whoami_1',
			request: {
				subtype: 'can_use_tool',
				tool_name: 'Bash',
				input: { command: ${JSON.stringify(backslashEscapedWhoami)} },
			},
		}) + '\\n');
		return;
	}
	if (msg.type === 'control_response' && msg.response?.request_id === 'req_whoami_1') {
		const behavior = msg.response?.response?.behavior;
		if (behavior !== 'allow') {
			process.stdout.write(JSON.stringify({ type: 'result', is_error: true, errors: ['Permission denied for ade_whoami'] }) + '\\n');
			process.exit(1);
			return;
		}
		const out = cp.execSync(${JSON.stringify(backslashEscapedWhoami)}, {
			shell: '/bin/sh',
			env: { ...process.env, ADE_NODE_BIN: process.execPath },
			encoding: 'utf8',
		});
		const parsed = JSON.parse(out.trim());
		const reply = '我的职级是 ' + parsed.level + ' (' + parsed.name + ')';
		process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }) + '\\n');
		process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: reply }) + '\\n');
		process.exit(0);
	}
});
`);

		const savedAuto = vscodeMock.autonomousMode;
		vscodeMock.autonomousMode = false;
		const cts = vscodeMock.createCts();
		const rt = new ClaudeRuntime(mockClaudeWhoami);
		try {
			const stream = makeCollectStream();
			await rt.send(
				{ id: 'sid-whoami-space', cwd: baseShortTmp, label: 'Chief', created: 1, updated: 1, provisional: true },
				'hi，你的职级？',
				stream.stream,
				cts.token,
				{
					permissionMode: 'acceptEdits',
					automatedEngineering: false,
					pureWorker: false,
					adeProjectId: 'proj_1',
					adeAgentId: 'agent_chief',
					adeAgentToken: token,
					adeControlSocketPath: sockPath,
				},
			);
			assert.equal(stream.getMarkdown(), '我的职级是 L1 (Chief)');
		} finally {
			rt.dispose();
			cts.dispose();
			vscodeMock.autonomousMode = savedAuto;
			await new Promise<void>(resolve => udsServer.close(() => resolve()));
		}
	});
});
