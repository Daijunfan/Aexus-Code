/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';

export interface NativeSession {
	id: string;
	parentId?: string;
	cwd: string;
	label: string;
	created: number;
	updated: number;
	file?: string;
	provisional?: boolean;
	unmaterialized?: boolean;
	readOnly?: boolean;
}

export type EngineThinkingLevel = 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'extra-high' | 'max' | string;

export interface EngineAttachment {
	readonly kind: 'file' | 'image';
	readonly filePath: string;
	readonly mimeType?: string;
	readonly rangeText?: string;
}

export interface EngineSendOptions {
	readonly model?: string;
	readonly thinking?: EngineThinkingLevel;
	readonly mode?: string;
	readonly permissionMode?: string;
	readonly sandboxMode?: string;
	readonly webSearch?: string;
	readonly attachments?: readonly EngineAttachment[];
	readonly pureWorker?: boolean;
	readonly callerRole?: string;
	readonly automatedEngineering?: boolean;
}

export interface EngineRuntimeCapabilities {
	readonly defaultModel?: string;
	readonly models?: Array<{ id: string; name: string; description?: string }>;
	readonly modes?: Array<{ id: string; name: string; description?: string }>;
	readonly commands?: Array<{ name: string; description?: string }>;
}

export interface HistoryEntry { id?: string; role: 'user' | 'assistant'; text: string; isSystemInitiated?: boolean }

/** Token usage accounted for a single completed engine turn. */
export interface EngineTurnTokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens: number;
	readonly durationMs?: number;
	readonly costUsd?: number;
	readonly estimated?: boolean;
}

export interface EngineRuntime extends vscode.Disposable {
	readonly id: string;
	readonly name: string;
	readonly onDidChangeSessions?: vscode.Event<readonly NativeSession[]>;
	list(token: vscode.CancellationToken): Promise<NativeSession[]>;
	children?(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]>;
	create(cwd: string): Promise<NativeSession>;
	prepareSession?(session: NativeSession): Promise<void>;
	history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]>;
	send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void>;
	getRuntimeCapabilities?(cwd: string, session?: NativeSession): Promise<EngineRuntimeCapabilities>;
	executeCommand?(session: NativeSession, command: string, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<boolean>;
	killSession?(session: NativeSession): Promise<void>;
	/** Retrieves and clears the token usage of the most recently completed turn for a session, when the engine can report it. */
	consumeLastTurnUsage?(sessionId: string): EngineTurnTokenUsage | undefined;
	delete(session: NativeSession, token: vscode.CancellationToken): Promise<void>;
}

export function emitThinkingProgress(stream: vscode.ChatResponseStream, text: string, id = 'thinking'): void {
	if (!text) {
		return;
	}
	const extended = stream as vscode.ChatResponseStream & { thinkingProgress?: (delta: { text: string; id?: string }) => void };
	if (typeof extended.thinkingProgress === 'function') {
		try {
			extended.thinkingProgress({ text, id });
			return;
		} catch { /* Fall back cleanly if unavailable in host. */ }
	}
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
		promise.then(
			value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); },
		);
	});
}

let cliBinDir: string | undefined;

export function setCliBinDirectory(dir: string): void {
	cliBinDir = dir;
}

function getStandardCliDirectories(): string[] {
	const home = os.homedir();
	return [
		path.join(home, '.npm-global', 'bin'),
		path.join(home, '.local', 'bin'),
		path.join(home, '.gemini', 'bin'),
		path.join(home, '.opencode', 'bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		...(process.platform === 'darwin' ? ['/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin'] : []),
	];
}

function mergeCliPath(existingPath: string | undefined, prependDir?: string): string {
	const seen = new Set<string>();
	const result: string[] = [];
	const normalize = (entry: string) => process.platform === 'win32' ? entry.toLowerCase() : entry;
	const addEntry = (rawEntry: string) => {
		const trimmed = rawEntry.trim();
		if (!trimmed) {
			return;
		}
		const key = normalize(trimmed);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(trimmed);
		}
	};

	if (prependDir) {
		addEntry(prependDir);
	}
	if (existingPath) {
		for (const segment of existingPath.split(path.delimiter)) {
			addEntry(segment);
		}
	}
	for (const candidate of getStandardCliDirectories()) {
		addEntry(candidate);
	}
	return result.join(path.delimiter);
}

function parseNoProxyValues(value: unknown): string[] {
	if (typeof value === 'string') {
		return value.split(',').map(item => item.trim()).filter(Boolean);
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
	}
	return [];
}

function applyHttpConfigurationToEnv(targetEnv: NodeJS.ProcessEnv, explicitEnv?: NodeJS.ProcessEnv): void {
	let httpCfg: vscode.WorkspaceConfiguration | undefined;
	try {
		httpCfg = vscode.workspace.getConfiguration('http', null);
	} catch {
		httpCfg = undefined;
	}

	const callerOverrodeProxy = Boolean(explicitEnv && ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
		.some(key => Object.hasOwn(explicitEnv, key) && explicitEnv[key] !== process.env[key]));
	const callerOverrodeNoProxy = Boolean(explicitEnv && ['NO_PROXY', 'no_proxy']
		.some(key => Object.hasOwn(explicitEnv, key) && explicitEnv[key] !== process.env[key]));

	const rawSupport = httpCfg?.get<string>('proxySupport');
	const proxySupport = typeof rawSupport === 'string' ? rawSupport.trim().toLowerCase() : undefined;

	if (!callerOverrodeProxy) {
		if (proxySupport === 'off') {
			delete targetEnv.HTTP_PROXY;
			delete targetEnv.http_proxy;
			delete targetEnv.HTTPS_PROXY;
			delete targetEnv.https_proxy;
			delete targetEnv.ALL_PROXY;
			delete targetEnv.all_proxy;
			if (!callerOverrodeNoProxy) {
				targetEnv.NO_PROXY = '*';
				targetEnv.no_proxy = '*';
			}
		} else {
			const rawProxy = httpCfg?.get<string>('proxy');
			const configuredProxy = typeof rawProxy === 'string' && rawProxy.trim() ? rawProxy.trim() : undefined;
			const existingProxy = [
				targetEnv.HTTPS_PROXY,
				targetEnv.https_proxy,
				targetEnv.HTTP_PROXY,
				targetEnv.http_proxy,
				targetEnv.ALL_PROXY,
				targetEnv.all_proxy,
			].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
			const effectiveProxy = configuredProxy ?? existingProxy;

			if (configuredProxy) {
				targetEnv.HTTP_PROXY = configuredProxy;
				targetEnv.http_proxy = configuredProxy;
				targetEnv.HTTPS_PROXY = configuredProxy;
				targetEnv.https_proxy = configuredProxy;
			} else if (existingProxy) {
				if (!targetEnv.HTTP_PROXY?.trim()) { targetEnv.HTTP_PROXY = existingProxy; }
				if (!targetEnv.http_proxy?.trim()) { targetEnv.http_proxy = existingProxy; }
				if (!targetEnv.HTTPS_PROXY?.trim()) { targetEnv.HTTPS_PROXY = existingProxy; }
				if (!targetEnv.https_proxy?.trim()) { targetEnv.https_proxy = existingProxy; }
			}

			const configNoProxy = parseNoProxyValues(httpCfg?.get('noProxy'));
			if (!callerOverrodeNoProxy && (effectiveProxy || configNoProxy.length > 0)) {
				const existingNoProxy = [
					...parseNoProxyValues(targetEnv.NO_PROXY),
					...parseNoProxyValues(targetEnv.no_proxy),
				];
				const seen = new Set<string>();
				const merged: string[] = [];
				const addHost = (host: string) => {
					const lower = host.toLowerCase();
					if (!seen.has(lower)) {
						seen.add(lower);
						merged.push(host);
					}
				};
				for (const entry of existingNoProxy) { addHost(entry); }
				for (const entry of configNoProxy) { addHost(entry); }
				if (!seen.has('*')) {
					for (const loopback of ['localhost', '127.0.0.1', '::1']) {
						addHost(loopback);
					}
				}
				const joined = merged.join(',');
				targetEnv.NO_PROXY = joined;
				targetEnv.no_proxy = joined;
			}
		}
	}

	const systemCertificatesNode = httpCfg?.get<boolean>('systemCertificatesNode', true);
	if ((process.platform === 'darwin' || process.platform === 'win32') && systemCertificatesNode !== false && !targetEnv.NODE_USE_SYSTEM_CA) {
		targetEnv.NODE_USE_SYSTEM_CA = '1';
	}
}

export async function findExecutable(name: string): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('aexus.ade', null).get<Record<string, string>>('cliPaths', {})[name]?.trim();
	const checkBundledExtensions = async (): Promise<string | undefined> => {
		const extRoot = path.join(os.homedir(), '.aexus-code', 'extensions');
		try {
			const entries = (await fs.readdir(extRoot)).sort().reverse();
			const bundledCandidates: string[] = [];
			for (const entry of entries) {
				if (name === 'claude' && entry.startsWith('anthropic.claude-code-')) {
					bundledCandidates.push(path.join(extRoot, entry, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude'));
				} else if (name === 'kilo' && entry.startsWith('kilocode.kilo-code-')) {
					bundledCandidates.push(path.join(extRoot, entry, 'bin', process.platform === 'win32' ? 'kilo.exe' : 'kilo'));
				} else if (name === 'codex' && entry.startsWith('openai.chatgpt-')) {
					const binDir = path.join(extRoot, entry, 'bin');
					const subdirs = await fs.readdir(binDir).catch(() => [] as string[]);
					for (const sub of subdirs) {
						bundledCandidates.push(path.join(binDir, sub, process.platform === 'win32' ? 'codex.exe' : 'codex'));
					}
				}
			}
			for (const candidate of bundledCandidates) {
				try {
					await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
					return candidate;
				} catch { /* Continue checking bundled fallbacks. */ }
			}
		} catch { /* Ignore missing extensions root. */ }
		return undefined;
	};
	if (!configured && name === 'codex') {
		const bundledCodex = await checkBundledExtensions();
		if (bundledCodex) {
			return bundledCodex;
		}
	}
	const directories = [
		...(process.env.PATH ?? '').split(path.delimiter),
		...getStandardCliDirectories(),
	];
	const candidates = configured
		? [configured]
		: directories.filter(Boolean).flatMap(directory => (process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']).map(suffix => path.join(directory, name + suffix)));
	for (const candidate of candidates) {
		try {
			await fs.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
			return candidate;
		} catch { /* Try the next executable location. */ }
	}
	if (!configured) {
		return checkBundledExtensions();
	}
	return undefined;
}

export function spawnEngine(executable: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): cp.ChildProcessWithoutNullStreams {
	const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
	const existingPath = mergedEnv.PATH ?? (process.platform === 'win32' ? mergedEnv.Path : undefined);
	mergedEnv.PATH = mergeCliPath(existingPath, cliBinDir);
	applyHttpConfigurationToEnv(mergedEnv, env);
	const child = cp.spawn(process.execPath, [path.join(__dirname, 'engineProcess.js'), executable, ...args], {
		cwd: cwd ?? os.homedir(),
		env: { ...mergedEnv, ELECTRON_RUN_AS_NODE: '1' },
		windowsHide: true,
		detached: process.platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
	}) as cp.ChildProcessWithoutNullStreams;
	return child;
}

export function stopEngine(child: cp.ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
	try {
		if (child.pid && process.platform !== 'win32') { process.kill(-child.pid, signal); }
		else if (child.connected) { child.disconnect(); }
		else { child.kill(signal); }
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
}

export async function capture(executable: string, args: readonly string[], token: vscode.CancellationToken, cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
	const child = spawnEngine(executable, args, cwd, env);
	let output = '';
	let error = '';
	child.stdout.on('data', data => output += String(data));
	child.stderr.on('data', data => error = (error + String(data)).slice(-8000));
	const cancellation = token.onCancellationRequested(() => stopEngine(child));
	child.stdin.end();
	try {
		await new Promise<void>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', code => token.isCancellationRequested ? reject(new vscode.CancellationError()) : code === 0 ? resolve() : reject(new Error(error || vscode.l10n.t('The engine exited with code {0}.', String(code)))));
		});
		return output;
	} finally {
		cancellation.dispose();
	}
}

export function readJsonOutput<T>(output: string): T {
	const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
	return JSON.parse(text.slice(text.search(/^[\[{]/m))) as T;
}

export interface RpcPacket {
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code?: number; message: string; data?: unknown };
}

/** A dedicated stdio client; it never restarts or terminates another engine process. */
export class JsonLineClient implements vscode.Disposable {
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly listeners = new Set<(packet: RpcPacket) => void>();
	private readonly child: cp.ChildProcessWithoutNullStreams;
	private readonly closedPromise: Promise<void>;
	private nextId = 0;
	private error = '';
	private closedError: Error | undefined;
	get isClosed(): boolean { return !!this.closedError; }

	constructor(executable: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
		this.child = spawnEngine(executable, args, cwd, env);
		this.child.stderr.on('data', data => this.error = (this.error + String(data)).slice(-8000));
		const lines = readline.createInterface({ input: this.child.stdout });
		lines.on('line', line => {
			let packet: RpcPacket;
			try { packet = JSON.parse(line) as RpcPacket; } catch { return; }
			if (typeof packet.id === 'number' && !packet.method) {
				const entry = this.pending.get(packet.id);
				this.pending.delete(packet.id);
				if (packet.error) { entry?.reject(new Error(packet.error.message)); } else { entry?.resolve(packet.result); }
			} else {
				for (const listener of this.listeners) { listener(packet); }
			}
		});
		const fail = (error: Error) => {
			if (this.closedError) { return; }
			this.closedError = error;
			for (const entry of this.pending.values()) { entry.reject(error); }
			this.pending.clear();
			for (const listener of this.listeners) { listener({ method: 'aexus/connectionClosed', params: { message: error.message } }); }
		};
		this.child.on('error', fail);
		this.child.stdin.on('error', fail);
		this.closedPromise = new Promise<void>(resolve => {
			this.child.on('close', code => {
				lines.close();
				fail(new Error(this.error || vscode.l10n.t('The engine connection ended ({0}).', String(code))));
				resolve();
			});
		});
	}

	request<T>(method: string, params: object): Promise<T> {
		if (this.closedError) { return Promise.reject(this.closedError); }
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: value => resolve(value as T), reject });
			this.write({ jsonrpc: '2.0', id, method, params });
		});
	}

	write(packet: object): void {
		if (this.closedError) { throw this.closedError; }
		this.child.stdin.write(JSON.stringify(packet) + '\n');
	}

	waitForClose(timeoutMs = 1500): Promise<void> {
		return Promise.race([
			this.closedPromise,
			new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
		]);
	}

	onPacket(listener: (packet: RpcPacket) => void): vscode.Disposable { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
	dispose(): void { this.child.stdin.end(); stopEngine(this.child); }
}
