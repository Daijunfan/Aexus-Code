/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as vscode from 'vscode';
import {
	captureRemoteEngine,
	CloudHostTarget,
	ensureRemoteControlReverseBridge,
	spawnRemoteEngine,
	stageRemoteAdeCliShim,
} from './cloudTransport';
import {
	ADE_MINT_SESSION_TOKEN_ACTION,
	ADE_PURE_WORKER_FALLBACK_DENY_TOKEN,
	AgentChildIdentity,
	buildAgentChildEnv,
	computeAgentIdentityScopeKey,
	isPureWorkerDenyToken,
	isPureWorkerIdentity,
	isRawPureRole,
	SHARED_PURE_SCOPE_KEY,
	stripDirectoriesFromPath,
} from './roleBridgeShared';

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
	/** True when `filePath` already refers to a path on the session's remote SSH Cloud Host. */
	readonly remote?: boolean;
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
	readonly isMissionNode?: boolean;
	readonly adeSessionId?: string;
	readonly automatedEngineering?: boolean;
	/** Reports live (cumulative for the turn) token usage while the engine is still streaming. */
	readonly onInterimUsage?: (cumulativeTurnUsage: EngineTurnTokenUsage) => void;
	/** Called when the engine auto-compacts conversation context during a turn. */
	readonly onContextCompacted?: () => void;
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
	readonly remoteTarget?: CloudHostTarget;
	readonly onDidChangeSessions?: vscode.Event<readonly NativeSession[]>;
	list(token: vscode.CancellationToken): Promise<NativeSession[]>;
	children?(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]>;
	create(cwd: string): Promise<NativeSession>;
	prepareSession?(session: NativeSession, options?: EngineSendOptions): Promise<void>;
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

export function getBundledCliBinDirs(): string[] {
	const candidates = [
		cliBinDir,
		path.resolve(__dirname, '..', 'bin'),
		(() => {
			try {
				return vscode.env?.appRoot ? path.join(vscode.env.appRoot, 'bin') : undefined;
			} catch {
				return undefined;
			}
		})(),
	];
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
		if (!seen.has(normalized)) {
			seen.add(normalized);
			dirs.push(candidate);
		}
	}
	return dirs;
}

export function isAutonomousModeEnabled(): boolean {
	try {
		const cfg = vscode.workspace.getConfiguration('aexus.ade', null);
		const inspected = cfg.inspect<boolean>('autonomousMode');
		const effective = inspected?.globalValue ?? inspected?.defaultValue ?? cfg.get<boolean>('autonomousMode', false);
		return effective === true;
	} catch {
		return false;
	}
}

export { SHARED_PURE_SCOPE_KEY };

export function agentIdentityScopeKey(sessionId: string, identity?: AgentChildIdentity, cwd?: string): string {
	return computeAgentIdentityScopeKey(sessionId, identity, cwd);
}

interface MasterControlConnection {
	readonly socketPath: string;
	readonly token: string;
	readonly tcpPort?: number;
}

const mintedCapabilityTokenCache = new Map<string, { readonly token: string; readonly socketPath: string }>();

async function resolveMasterControlConnection(env: NodeJS.ProcessEnv = process.env): Promise<MasterControlConnection | undefined> {
	const envTcpPortRaw = env.AEXUS_ADE_TCP_PORT?.trim();
	const envTcpPort = envTcpPortRaw && /^\d+$/.test(envTcpPortRaw) ? Number.parseInt(envTcpPortRaw, 10) : undefined;
	const socketOverride = env.AEXUS_ADE_SOCKET?.trim();
	const tokenOverride = env.AEXUS_ADE_TOKEN?.trim();
	if (socketOverride && tokenOverride) {
		return { socketPath: socketOverride, token: tokenOverride, ...(envTcpPort ? { tcpPort: envTcpPort } : {}) };
	}
	const adeHome = env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), '.aexus-code');
	const controlFile = env.AEXUS_ADE_CONTROL_FILE?.trim() || path.join(adeHome, 'ade-control.json');
	try {
		const raw = await fs.readFile(controlFile, 'utf8');
		const parsed = JSON.parse(raw) as { socketPath?: unknown; token?: unknown; tcpPort?: unknown };
		const metaSocketPath = typeof parsed.socketPath === 'string' ? parsed.socketPath.trim() : '';
		const socketPath = metaSocketPath || socketOverride || '';
		const token = tokenOverride || (typeof parsed.token === 'string' ? parsed.token.trim() : '');
		const tcpPort = typeof parsed.tcpPort === 'number' && Number.isInteger(parsed.tcpPort) && parsed.tcpPort > 0
			? parsed.tcpPort
			: envTcpPort;
		if (socketPath && token) {
			return { socketPath, token, ...(tcpPort ? { tcpPort } : {}) };
		}
	} catch {
		// Control plane metadata may not exist in unit tests or standalone mode.
	}
	return undefined;
}

function requestControlSocket<T>(socketPath: string, payload: Record<string, unknown>, timeoutMs = 3000): Promise<{ readonly ok: boolean; readonly result?: T; readonly error?: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = '';
		let settled = false;
		const finish = (cb: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			cb();
		};
		const timer = setTimeout(() => {
			finish(() => reject(new Error('ADE control socket request timed out')));
		}, timeoutMs);
		socket.setEncoding('utf8');
		socket.on('connect', () => {
			socket.write(JSON.stringify(payload) + '\n');
		});
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				finish(() => {
					try {
						resolve(JSON.parse(line) as { readonly ok: boolean; readonly result?: T; readonly error?: string });
					} catch (err) {
						reject(err);
					}
				});
			}
		});
		socket.on('end', () => {
			if (!settled) {
				finish(() => {
					try {
						resolve(JSON.parse(buffer.trim()) as { readonly ok: boolean; readonly result?: T; readonly error?: string });
					} catch (err) {
						reject(err);
					}
				});
			}
		});
		socket.on('error', err => {
			finish(() => reject(err));
		});
	});
}

export async function mintSessionCapabilityToken(
	sessionId: string,
	rank: string,
	pure = false,
	env: NodeJS.ProcessEnv = process.env,
	missionNode = false,
): Promise<{ readonly token: string; readonly socketPath: string } | undefined> {
	const conn = await resolveMasterControlConnection(env);
	if (!conn) {
		return undefined;
	}
	const normalizedSid = sessionId.trim() || 'session';
	const normalizedRank = pure ? 'worker' : (rank.trim().toLowerCase() || 'worker');
	const cacheKey = `${conn.socketPath}|${normalizedSid}|${normalizedRank}|${pure ? '1' : '0'}|${missionNode ? '1' : '0'}`;
	const cached = mintedCapabilityTokenCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	try {
		const response = await requestControlSocket<{ readonly token?: string }>(conn.socketPath, {
			token: conn.token,
			action: ADE_MINT_SESSION_TOKEN_ACTION,
			params: {
				sessionId: normalizedSid,
				rank: normalizedRank,
				pure,
				...(missionNode ? { missionNode: true } : {}),
			},
		});
		const mintedToken = response.ok && typeof response.result?.token === 'string' && response.result.token.trim()
			? response.result.token.trim()
			: undefined;
		if (mintedToken) {
			const entry = { token: mintedToken, socketPath: conn.socketPath };
			if (mintedCapabilityTokenCache.size > 512) {
				mintedCapabilityTokenCache.clear();
			}
			mintedCapabilityTokenCache.set(cacheKey, entry);
			return entry;
		}
	} catch {
		// Fall back cleanly if the control socket is temporarily unavailable.
	}
	return undefined;
}

export async function prepareAgentChildEnv(
	identity?: AgentChildIdentity,
	baseEnv?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
	const isMissionNode = identity?.isMissionNode === true;
	const standalonePure = isPureWorkerIdentity(identity);
	const rawPure = isRawPureRole(identity);
	const sessionId = identity?.sessionId?.trim() || 'session';
	const rank = rawPure ? 'worker' : (identity?.callerRole?.trim().toLowerCase() || 'worker');
	const minted = await mintSessionCapabilityToken(sessionId, rank, rawPure, process.env, isMissionNode);
	const cliBinDirs = getBundledCliBinDirs();
	return buildAgentChildEnv({
		sessionId,
		callerRole: standalonePure ? undefined : rank,
		pureWorker: standalonePure,
		isMissionNode,
		baseEnv: baseEnv ?? process.env,
		cliBinDirs,
		socketPath: standalonePure ? undefined : (minted?.socketPath ?? process.env.AEXUS_ADE_SOCKET),
		sessionToken: minted?.token ?? (standalonePure ? ADE_PURE_WORKER_FALLBACK_DENY_TOKEN : undefined),
	});
}

export async function prepareRemoteAgentChildEnv(
	target: CloudHostTarget,
	identity?: AgentChildIdentity,
	env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
	// Standalone pure workers on Cloud Hosts stay 100% isolated with zero control tokens or tunnels.
	// Pure-rank Mission nodes (isMissionNode === true) receive a strictly token-scoped capability token & bridge.
	if (isPureWorkerIdentity(identity)) {
		return {};
	}
	const isMissionNode = identity?.isMissionNode === true;
	const rawPure = isRawPureRole(identity);
	const sessionId = identity?.sessionId?.trim() || 'session';
	const rank = rawPure ? 'worker' : (identity?.callerRole?.trim().toLowerCase() || 'worker');
	const conn = await resolveMasterControlConnection(env);
	if (!conn?.tcpPort) {
		return {};
	}
	const minted = await mintSessionCapabilityToken(sessionId, rank, rawPure, env, isMissionNode);
	if (!minted?.token) {
		return {};
	}
	try {
		const [bridge] = await Promise.all([
			ensureRemoteControlReverseBridge(target, conn.tcpPort),
			stageRemoteAdeCliShim(target, path.join(__dirname, 'adeCli.js')).catch(() => undefined),
		]);
		return {
			AEXUS_ADE_REMOTE_BRIDGE_PORT: String(bridge.remotePort),
			AEXUS_ADE_SESSION_TOKEN: minted.token,
		};
	} catch {
		return {};
	}
}

function getStandardCliDirectories(): string[] {
	const home = os.homedir();
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
		return [
			path.join(appData, 'npm'),
			path.join(home, '.local', 'bin'),
			path.join(home, '.local', 'node-current'),
			path.join(home, '.cargo', 'bin'),
			path.join(home, '.npm-global', 'bin'),
			path.join(home, '.gemini', 'bin'),
			path.join(home, '.opencode', 'bin'),
			path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
			path.join(localAppData, 'Programs', 'claude'),
			path.join(localAppData, 'Programs', 'DeepSeek Harness'),
			path.join(programFiles, 'nodejs'),
		];
	}
	return [
		path.join(home, '.npm-global', 'bin'),
		path.join(home, '.local', 'bin'),
		path.join(home, '.cargo', 'bin'),
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
		const trimmed = rawEntry.trim().replace(/^"+|"+$/g, '');
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

export interface EngineInstallGuide {
	readonly cliKey: string;
	readonly binaryName: string;
	readonly installCommand: string;
	readonly docsUrl: string;
}

export const ENGINE_INSTALL_GUIDES: Readonly<Record<string, EngineInstallGuide>> = {
	claude: {
		cliKey: 'claude',
		binaryName: 'claude',
		installCommand: 'npm install -g @anthropic-ai/claude-code',
		docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
	},
	codex: {
		cliKey: 'codex',
		binaryName: 'codex',
		installCommand: 'npm install -g @openai/codex',
		docsUrl: 'https://github.com/openai/codex',
	},
	kilo: {
		cliKey: 'kilo',
		binaryName: 'kilo',
		installCommand: 'npm install -g @kilocode/cli',
		docsUrl: 'https://kilocode.ai/docs',
	},
	opencode: {
		cliKey: 'opencode',
		binaryName: 'opencode',
		installCommand: 'npm install -g opencode-ai',
		docsUrl: 'https://opencode.ai/docs',
	},
	dsh: {
		cliKey: 'dsh',
		binaryName: 'dsh',
		installCommand: 'Configure "aexus.ade.cliPaths.dsh" or add DeepSeek Harness (dsh) to PATH',
		docsUrl: 'https://github.com/Daijunfan/Aexus-Code',
	},
	antigravity: {
		cliKey: 'agy',
		binaryName: 'agy',
		installCommand: 'Install Google Antigravity CLI (agy) or configure "aexus.ade.cliPaths.agy"',
		docsUrl: 'https://antigravity.google',
	},
	agy: {
		cliKey: 'agy',
		binaryName: 'agy',
		installCommand: 'Install Google Antigravity CLI (agy) or configure "aexus.ade.cliPaths.agy"',
		docsUrl: 'https://antigravity.google',
	},
	cline: {
		cliKey: 'cline',
		binaryName: 'cline',
		installCommand: 'npm install -g cline',
		docsUrl: 'https://docs.cline.bot',
	},
	pi: {
		cliKey: 'pi',
		binaryName: 'pi',
		installCommand: 'npm install -g @mariozechner/pi-coding-agent',
		docsUrl: 'https://github.com/badlogic/pi-mono',
	},
};

export async function findExecutable(name: string): Promise<string | undefined> {
	const cliPaths = vscode.workspace.getConfiguration('aexus.ade', null).get<Record<string, string>>('cliPaths', {});
	const configured = (cliPaths[name] || (name === 'agy' ? cliPaths.antigravity : undefined))?.trim();
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
	const rawPathEnv = process.env.PATH ?? (process.platform === 'win32' ? process.env.Path : undefined) ?? '';
	const directories = [
		...rawPathEnv.split(path.delimiter).map(d => d.trim().replace(/^"+|"+$/g, '')),
		...getStandardCliDirectories(),
	].filter(Boolean);
	const winSuffixes = (() => {
		const fromEnv = (process.env.PATHEXT ?? '')
			.split(';')
			.map(ext => ext.trim().toLowerCase())
			.filter(ext => ext.startsWith('.'));
		const ordered = ['.exe', '.cmd', '.bat', '.com', '.ps1'];
		for (const ext of fromEnv) {
			if (!ordered.includes(ext)) {
				ordered.push(ext);
			}
		}
		ordered.push('');
		return ordered;
	})();
	const suffixes = process.platform === 'win32' ? winSuffixes : [''];
	const isBareConfigured = Boolean(configured && !path.isAbsolute(configured) && !configured.includes('/') && !configured.includes('\\'));
	const candidates = configured
		? (isBareConfigured
			? directories.flatMap(directory => suffixes.map(suffix => path.join(directory, (/\.[a-z0-9]+$/i.test(configured) && suffix ? configured : configured + suffix))))
			: [configured])
		: directories.flatMap(directory => suffixes.map(suffix => path.join(directory, name + suffix)));
	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (!stat.isFile()) {
				continue;
			}
			if (process.platform !== 'win32') {
				await fs.access(candidate, fs.constants.X_OK);
			}
			return candidate;
		} catch { /* Try the next executable location. */ }
	}
	if (!configured) {
		return checkBundledExtensions();
	}
	return undefined;
}

export function spawnEngine(executable: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv, remoteTarget?: CloudHostTarget): cp.ChildProcessWithoutNullStreams {
	if (remoteTarget) {
		return spawnRemoteEngine(remoteTarget, executable, args, cwd, env);
	}
	const mergedEnv: NodeJS.ProcessEnv = env ? { ...env } : { ...process.env };
	const isPureEnv = isPureWorkerDenyToken(mergedEnv.AEXUS_ADE_SESSION_TOKEN);
	// Defense-in-depth: never leak master ADE credentials to spawned engine processes.
	delete mergedEnv.AEXUS_ADE_CONTROL_FILE;
	delete mergedEnv.AEXUS_ADE_TOKEN;
	if (isPureEnv || !env) {
		delete mergedEnv.AEXUS_ADE_SOCKET;
		delete mergedEnv.AEXUS_ADE_CALLER;
	}
	let existingPath: string | undefined;
	for (const key of Object.keys(mergedEnv)) {
		if (key.toLowerCase() === 'path') {
			if (existingPath === undefined && typeof mergedEnv[key] === 'string') {
				existingPath = mergedEnv[key];
			}
			delete mergedEnv[key];
		}
	}
	const canonicalPathKey = process.platform === 'win32' ? 'Path' : 'PATH';
	if (isPureEnv) {
		const mergedStandard = mergeCliPath(existingPath, undefined);
		mergedEnv[canonicalPathKey] = stripDirectoriesFromPath(mergedStandard, getBundledCliBinDirs());
	} else {
		mergedEnv[canonicalPathKey] = mergeCliPath(existingPath, cliBinDir);
	}
	if (process.platform !== 'win32') {
		mergedEnv.PATH = mergedEnv[canonicalPathKey];
	}
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

export async function capture(executable: string, args: readonly string[], token: vscode.CancellationToken, cwd?: string, env?: NodeJS.ProcessEnv, remoteTarget?: CloudHostTarget): Promise<string> {
	if (remoteTarget) {
		return captureRemoteEngine(remoteTarget, executable, args, token, cwd, env);
	}
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

	constructor(executable: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, remoteTarget?: CloudHostTarget) {
		this.child = spawnEngine(executable, args, cwd, env, remoteTarget);
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
