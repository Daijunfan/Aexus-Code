/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	captureRemoteEngine,
	CloudHostTarget,
	ensureRemoteControlReverseBridge,
	healAllRemoteControlBridges,
	onSystemResume,
	RemoteExecOptions,
	spawnRemoteEngine,
	stageRemoteAdeCliShim,
	terminateRemotePersistentSession,
} from './cloudTransport';
import {
	ADE_MINT_SESSION_TOKEN_ACTION,
	ADE_PURE_WORKER_FALLBACK_DENY_TOKEN,
	AgentChildIdentity,
	buildAgentChildEnv,
	computeAgentIdentityScopeKey,
	getOrEnsureAgentAuthFilePath,
	isPureWorkerDenyToken,
	isPureWorkerIdentity,
	isRawPureRole,
	SHARED_PURE_SCOPE_KEY,
	stripDirectoriesFromPath,
	writeSingleAgentAuthFile,
} from './roleBridgeShared';
import { registerSpawnedEngineChildForTracking, stopSpawnedEngineProcess } from './engineAdapterHelpers';
import { LineByteAccumulator } from './lineByteAccumulator';

export const DEFAULT_ENGINE_TURN_TIMEOUT_MS = Math.max(30_000, Number(process.env.AEXUS_ADE_TURN_TIMEOUT_MS) || 15 * 60 * 1000);
export const DEFAULT_ENGINE_IDLE_STALL_TIMEOUT_MS = Math.max(15_000, Number(process.env.AEXUS_ADE_IDLE_STALL_TIMEOUT_MS) || 3 * 60 * 1000);

export function getConfiguredEngineTurnTimeoutMs(): number {
	const envRaw = Number(process.env.AEXUS_ADE_TURN_TIMEOUT_MS);
	if (Number.isFinite(envRaw) && envRaw >= 30_000) {
		return Math.floor(envRaw);
	}
	try {
		const configured = vscode.workspace.getConfiguration('aexus.ade', null).get<number>('turnTimeoutMs');
		if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 30_000) {
			return Math.floor(configured);
		}
	} catch {
		// Headless/unit test context without workspace configuration.
	}
	return DEFAULT_ENGINE_TURN_TIMEOUT_MS;
}

export function getConfiguredEngineIdleStallTimeoutMs(): number | undefined {
	const envStr = process.env.AEXUS_ADE_IDLE_STALL_TIMEOUT_MS?.trim();
	if (envStr !== undefined && envStr !== '') {
		const envRaw = Number(envStr);
		if (envRaw === 0) {
			return undefined;
		}
		if (Number.isFinite(envRaw) && envRaw >= 15_000) {
			return Math.floor(envRaw);
		}
	}
	try {
		const configured = vscode.workspace.getConfiguration('aexus.ade', null).get<number>('idleStallTimeoutMs');
		if (configured === 0) {
			return undefined;
		}
		if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 15_000) {
			return Math.floor(configured);
		}
	} catch {
		// Headless/unit test context without workspace configuration.
	}
	return DEFAULT_ENGINE_IDLE_STALL_TIMEOUT_MS;
}

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
	/**
	 * When true (e.g. post-window-reload recovery), prefer attaching to an already-running remote
	 * persistent session for this agent instead of spawning a duplicate overlapping prompt turn.
	 */
	readonly preferReattach?: boolean;
	/** Standard `AbortSignal` raised by `TurnCoordinator` on preemption, `stop()`, or hard turn deadline. */
	readonly abortSignal?: AbortSignal;
	/** Optional explicit per-turn hard deadline in milliseconds. */
	readonly timeoutMs?: number;
	/** Invariant static role charter passed via `--append-system-prompt` on engines that support system-prompt flags (Claude, Pi) for KV-cache prefix stability. */
	readonly appendSystemPrompt?: string;
	/** Invoked on any live stdout/SSE/RPC protocol frame from the engine to keep the sliding stall watchdog & worker heartbeat alive. */
	readonly onStreamActivity?: () => void;
	/** Pauses sliding `idleStallTimeoutMs` while awaiting a tracked external tool execution or interactive permission/question prompt. */
	readonly onExternalWaitStart?: () => void;
	readonly onExternalWaitEnd?: () => void;
}

export interface EngineRuntimeCapabilities {
	readonly defaultModel?: string;
	readonly models?: Array<{ id: string; name: string; description?: string }>;
	readonly modes?: Array<{ id: string; name: string; description?: string }>;
	readonly commands?: Array<{ name: string; description?: string }>;
}

export interface HistoryEntry { id?: string; role: 'user' | 'assistant'; text: string; isSystemInitiated?: boolean }

import {
	createTurnInterimUsageTracker,
	EngineTurnTokenUsage,
	ensureNonCachedTokenUsage,
	estimateTextTokens,
	normalizeProviderTokenUsage,
	ProviderTokenUsageHints,
	TurnInterimUsageTracker,
} from './usageTracker';
export {
	createTurnInterimUsageTracker,
	EngineTurnTokenUsage,
	ensureNonCachedTokenUsage,
	estimateTextTokens,
	normalizeProviderTokenUsage,
	ProviderTokenUsageHints,
	TurnInterimUsageTracker,
};

export interface EngineRuntime extends vscode.Disposable {
	readonly id: string;
	readonly name: string;
	readonly remoteTarget?: CloudHostTarget;
	readonly onDidChangeSessions?: vscode.Event<readonly NativeSession[]>;
	list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]>;
	children?(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]>;
	create(cwd: string): Promise<NativeSession>;
	prepareSession?(session: NativeSession, options?: EngineSendOptions, token?: vscode.CancellationToken): Promise<void>;
	history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]>;
	send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void>;
	/**
	 * Attempts to reattach to a still-running (or freshly finished) remote persistent session after
	 * an IDE window reload without sending a duplicate prompt. Returns `'reattached'` when handled.
	 */
	reattachIfRunning?(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<'reattached' | 'not_running'>;
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
		const effective = inspected?.globalValue ?? inspected?.defaultValue ?? cfg.get<boolean>('autonomousMode', true);
		return effective !== false;
	} catch {
		return true;
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

const CAPABILITY_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const mintedCapabilityTokenCache = new Map<string, { readonly specKey: string; readonly token: string; readonly socketPath: string; readonly mintedAt: number }>();
let hostWindowId: number | undefined;
let hostWindowIdPromise: Promise<number | undefined> | undefined;

export function setHostWindowId(windowId: number | undefined): void {
	if (typeof windowId === 'number' && Number.isInteger(windowId) && windowId > 0) {
		hostWindowId = windowId;
	} else {
		hostWindowId = undefined;
	}
}

async function resolveHostWindowId(env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
	const envRaw = env.AEXUS_ADE_WINDOW_ID?.trim();
	if (envRaw && /^\d+$/.test(envRaw)) {
		const parsed = Number.parseInt(envRaw, 10);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
	}
	if (typeof hostWindowId === 'number' && Number.isInteger(hostWindowId) && hostWindowId > 0) {
		return hostWindowId;
	}
	if (!hostWindowIdPromise) {
		hostWindowIdPromise = Promise.resolve()
			.then(() => typeof vscode.commands?.executeCommand === 'function'
				? vscode.commands.executeCommand<number>('aexus.ade.getWindowId')
				: undefined)
			.then(wid => {
				if (typeof wid === 'number' && Number.isInteger(wid) && wid > 0) {
					hostWindowId = wid;
					return wid;
				}
				return undefined;
			})
			.catch(() => undefined)
			.finally(() => {
				hostWindowIdPromise = undefined;
			});
	}
	return hostWindowIdPromise;
}

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
	explicitWindowId?: number,
): Promise<{ readonly token: string; readonly socketPath: string } | undefined> {
	const conn = await resolveMasterControlConnection(env);
	if (!conn) {
		return undefined;
	}
	const normalizedSid = sessionId.trim() || 'session';
	const normalizedRank = pure ? 'worker' : (rank.trim().toLowerCase() || 'worker');
	const resolvedWindowId = typeof explicitWindowId === 'number' && Number.isInteger(explicitWindowId) && explicitWindowId > 0
		? explicitWindowId
		: await resolveHostWindowId(env);
	const specKey = `${conn.socketPath}|${normalizedSid}|${normalizedRank}|${pure ? '1' : '0'}|${missionNode ? '1' : '0'}|${resolvedWindowId ?? ''}`;
	const cached = mintedCapabilityTokenCache.get(normalizedSid);
	if (cached && cached.specKey === specKey && Date.now() - cached.mintedAt < CAPABILITY_TOKEN_CACHE_TTL_MS) {
		return { token: cached.token, socketPath: cached.socketPath };
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
				...(resolvedWindowId !== undefined ? { windowId: resolvedWindowId } : {}),
			},
		});
		const mintedToken = response.ok && typeof response.result?.token === 'string' && response.result.token.trim()
			? response.result.token.trim()
			: undefined;
		if (mintedToken) {
			const entry = { specKey, token: mintedToken, socketPath: conn.socketPath, mintedAt: Date.now() };
			if (mintedCapabilityTokenCache.size > 512) {
				mintedCapabilityTokenCache.clear();
			}
			mintedCapabilityTokenCache.set(normalizedSid, entry);
			return { token: entry.token, socketPath: entry.socketPath };
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
	const effectiveBaseEnv = baseEnv ?? process.env;
	const minted = await mintSessionCapabilityToken(sessionId, rank, rawPure, effectiveBaseEnv, isMissionNode);
	const cliBinDirs = getBundledCliBinDirs();
	let agentAuthFile: string | undefined;
	if (!standalonePure && minted?.token) {
		const adeHome = effectiveBaseEnv.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), '.aexus-code');
		const scopeId = effectiveBaseEnv.AEXUS_ADE_WINDOW_KEY?.trim() || String(process.pid);
		const candidatePath = getOrEnsureAgentAuthFilePath(path.join(adeHome, 'role-bridge'), scopeId, sessionId);
		const wrote = await writeSingleAgentAuthFile(candidatePath, {
			version: 1,
			mode: 'ade',
			agentId: sessionId,
			isOrchestrated: !rawPure,
			isMissionNode,
			sessionToken: minted.token,
			controlSocketPath: minted.socketPath,
		}).then(() => true, () => false);
		if (wrote) {
			agentAuthFile = candidatePath;
		}
	}
	return buildAgentChildEnv({
		sessionId,
		callerRole: standalonePure ? undefined : rank,
		pureWorker: standalonePure,
		isMissionNode,
		baseEnv: effectiveBaseEnv,
		cliBinDirs,
		socketPath: standalonePure ? undefined : (minted?.socketPath ?? process.env.AEXUS_ADE_SOCKET),
		sessionToken: minted?.token ?? ADE_PURE_WORKER_FALLBACK_DENY_TOKEN,
		agentAuthFile,
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
			...(bridge.remoteSocketPath ? { AEXUS_ADE_REMOTE_BRIDGE_SOCKET: bridge.remoteSocketPath } : {}),
			...(bridge.remotePort > 0 ? { AEXUS_ADE_REMOTE_BRIDGE_PORT: String(bridge.remotePort) } : {}),
			...(bridge.remoteBridgeMetaPath ? { AEXUS_ADE_REMOTE_BRIDGE_FILE: bridge.remoteBridgeMetaPath } : {}),
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

export function spawnEngine(executable: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv, remoteTarget?: CloudHostTarget, remoteOptions?: RemoteExecOptions): cp.ChildProcessWithoutNullStreams {
	if (remoteTarget) {
		return spawnRemoteEngine(remoteTarget, executable, args, cwd, env, remoteOptions);
	}
	const mergedEnv: NodeJS.ProcessEnv = env ? { ...env } : { ...process.env };
	const isPureEnv = isPureWorkerDenyToken(mergedEnv.AEXUS_ADE_SESSION_TOKEN);
	// Defense-in-depth: never leak master ADE credentials to spawned engine processes.
	delete mergedEnv.AEXUS_ADE_CONTROL_FILE;
	delete mergedEnv.AEXUS_ADE_TOKEN;
	if (isPureEnv || !env) {
		delete mergedEnv.AEXUS_ADE_SOCKET;
		delete mergedEnv.AEXUS_ADE_CALLER;
		delete mergedEnv.AEXUS_ADE_WINDOW_ID;
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
	registerSpawnedEngineChildForTracking(child);
	return child;
}

export { registerSpawnedEngineChildForTracking };

export function stopEngine(child: cp.ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
	stopSpawnedEngineProcess(child, signal);
}

const stoppingChildren = new WeakSet<cp.ChildProcess>();

export function stopEngineWithFallback(child: cp.ChildProcess, initialSignal: NodeJS.Signals = 'SIGTERM', escalateMs = 1500): void {
	try { stopEngine(child, initialSignal); } catch { /* ignore */ }
	if (child.exitCode !== null || child.signalCode !== null || stoppingChildren.has(child)) {
		return;
	}
	stoppingChildren.add(child);
	const timers: ReturnType<typeof setTimeout>[] = [];
	const clearTimers = () => {
		for (const t of timers) { clearTimeout(t); }
		timers.length = 0;
	};
	child.once('exit', clearTimers);
	child.once('close', clearTimers);
	if (initialSignal === 'SIGINT' && escalateMs > 400) {
		const termTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				try { stopEngine(child, 'SIGTERM'); } catch { /* ignore */ }
			}
		}, Math.floor(escalateMs / 2));
		termTimer.unref?.();
		timers.push(termTimer);
	}
	const killTimer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			try { stopEngine(child, 'SIGKILL'); } catch { /* ignore */ }
		}
	}, Math.max(100, escalateMs));
	killTimer.unref?.();
	timers.push(killTimer);
}

export function raceWithCancellation<T>(
	promise: Promise<T>,
	token?: vscode.CancellationToken,
	cancelGraceMs = 0,
	onCancel?: () => void,
): Promise<T> {
	if (!token) {
		return promise;
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let cancelDisposable: vscode.Disposable | undefined;
		const cleanup = () => {
			if (graceTimer !== undefined) {
				clearTimeout(graceTimer);
				graceTimer = undefined;
			}
			cancelDisposable?.dispose();
			cancelDisposable = undefined;
		};
		const finishResolve = (value: T) => {
			if (settled) { return; }
			settled = true;
			cleanup();
			resolve(value);
		};
		const finishReject = (err: unknown) => {
			if (settled) { return; }
			settled = true;
			cleanup();
			reject(err);
		};
		const triggerCancel = () => {
			try { onCancel?.(); } catch { /* ignore */ }
			if (cancelGraceMs <= 0) {
				finishReject(new vscode.CancellationError());
				return;
			}
			if (graceTimer === undefined) {
				graceTimer = setTimeout(() => finishReject(new vscode.CancellationError()), cancelGraceMs);
				graceTimer.unref?.();
			}
		};
		promise.then(finishResolve, finishReject);
		if (token.isCancellationRequested) {
			triggerCancel();
		} else {
			cancelDisposable = token.onCancellationRequested(triggerCancel);
		}
	});
}

export async function capture(executable: string, args: readonly string[], token: vscode.CancellationToken, cwd?: string, env?: NodeJS.ProcessEnv, remoteTarget?: CloudHostTarget): Promise<string> {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
	if (remoteTarget) {
		return captureRemoteEngine(remoteTarget, executable, args, token, cwd, env);
	}
	const child = spawnEngine(executable, args, cwd, env);
	let output = '';
	let error = '';
	child.stdout.on('data', data => output += String(data));
	child.stderr.on('data', data => error = (error + String(data)).slice(-8000));
	const cancellation = token.onCancellationRequested(() => stopEngineWithFallback(child, 'SIGTERM', 1500));
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

export interface JsonLineRequestOptions {
	readonly timeoutMs?: number;
	readonly token?: vscode.CancellationToken;
	readonly cancelGraceMs?: number;
	readonly onCancel?: () => void;
}

/**
 * Extended SSH reattach backoff schedule (~5.5 minutes total tolerance) so laptop lid-close sleep
 * and transient Wi-Fi/VPN drops reattach cleanly to still-running remote persistent sessions.
 */
export const REMOTE_REATTACH_BACKOFFS_MS: readonly number[] = [
	2_000,
	4_000,
	8_000,
	15_000,
	30_000,
	30_000,
	60_000,
	60_000,
	60_000,
	60_000,
];

/**
 * Sleeps for `delayMs`, waking immediately if `token` cancels OR if OS power-resume fires.
 */
export function waitForBackoffOrResume(delayMs: number, token?: vscode.CancellationToken): Promise<void> {
	if (delayMs <= 0 || token?.isCancellationRequested) {
		return Promise.resolve();
	}
	return new Promise<void>(resolve => {
		let settled = false;
		const finish = () => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			cancelSub?.dispose();
			resumeSub.dispose();
			resolve();
		};
		const timer = setTimeout(finish, delayMs);
		timer.unref?.();
		const cancelSub = token?.onCancellationRequested(finish);
		const resumeSub = onSystemResume(finish);
	});
}

/** A dedicated stdio client; it never restarts or terminates another engine process. */
export class JsonLineClient implements vscode.Disposable {
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly listeners = new Set<(packet: RpcPacket) => void>();
	private child: cp.ChildProcessWithoutNullStreams;
	private readonly closedPromise: Promise<void>;
	private resolveClosed!: () => void;
	private readonly failConnection: (error: Error) => void;
	private readonly executable: string;
	private readonly args: readonly string[];
	private readonly cwd?: string;
	private readonly env?: NodeJS.ProcessEnv;
	private readonly remoteTarget?: CloudHostTarget;
	private readonly remoteOptions?: RemoteExecOptions;
	private readonly remotePersistentSessionId?: string;
	private nextId = 0;
	private error = '';
	private closedError: Error | undefined;
	private disposed = false;
	private reattaching = false;
	private reattachAttempt = 0;
	private stdoutBytesReceived = 0;
	private readonly stdoutLineAcc = new LineByteAccumulator();
	private readonly queuedWrites: string[] = [];
	private queuedWriteBytes = 0;
	get isClosed(): boolean { return !!this.closedError; }

	constructor(executable: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, remoteTarget?: CloudHostTarget, remoteOptions?: RemoteExecOptions) {
		this.executable = executable;
		this.args = [...args];
		this.cwd = cwd;
		this.env = env;
		this.remoteTarget = remoteTarget;
		this.remoteOptions = remoteOptions;
		this.remotePersistentSessionId = remoteOptions?.persistentSessionId;
		this.closedPromise = new Promise<void>(resolve => {
			this.resolveClosed = resolve;
		});
		const fail = (error: Error) => {
			if (this.closedError) { return; }
			this.closedError = error;
			this.queuedWrites.length = 0;
			this.queuedWriteBytes = 0;
			for (const entry of this.pending.values()) { entry.reject(error); }
			this.pending.clear();
			for (const listener of this.listeners) { listener({ method: 'aexus/connectionClosed', params: { message: error.message } }); }
			this.resolveClosed();
		};
		this.failConnection = fail;
		this.child = this.spawnAndBind(false);
	}

	private handleLine(line: string): void {
		if (!line) { return; }
		let packet: RpcPacket;
		try { packet = JSON.parse(line) as RpcPacket; } catch { return; }
		if (typeof packet.id === 'number' && !packet.method) {
			const entry = this.pending.get(packet.id);
			this.pending.delete(packet.id);
			if (packet.error) { entry?.reject(new Error(packet.error.message)); } else { entry?.resolve(packet.result); }
		} else {
			for (const listener of this.listeners) { listener(packet); }
		}
	}

	private spawnAndBind(isReattach: boolean): cp.ChildProcessWithoutNullStreams {
		const opts: RemoteExecOptions | undefined = this.remotePersistentSessionId
			? {
				...this.remoteOptions,
				persistentSessionId: this.remotePersistentSessionId,
				attachByteOffset: this.stdoutBytesReceived,
				...(isReattach ? { attachOnly: true } : {}),
			}
			: this.remoteOptions;
		const child = spawnEngine(this.executable, [...this.args], this.cwd, this.env, this.remoteTarget, opts);
		this.stdoutLineAcc.reset();
		child.stderr.on('data', data => this.error = (this.error + String(data)).slice(-8000));
		child.stdout.on('data', (chunk: Buffer | string) => {
			this.stdoutLineAcc.push(
				chunk,
				(line, rawBytes) => {
					this.stdoutBytesReceived += rawBytes;
					this.handleLine(line);
				},
				droppedBytes => {
					this.stdoutBytesReceived += droppedBytes;
				},
			);
			// Reset backoff once real stream traffic resumes after reattach.
			if (this.reattachAttempt > 0) {
				this.reattachAttempt = 0;
			}
		});
		child.on('error', err => {
			if (this.child !== child || this.disposed) { return; }
			if (!this.tryScheduleReattach(255)) {
				this.failConnection(err);
			}
		});
		child.stdin.on('error', () => {
			// Handled cleanly by the child close/reattach lifecycle so transient EPIPE during SSH
			// disconnects never tears down an active remote persistent session.
		});
		child.on('close', code => {
			if (this.child !== child) { return; }
			if (this.stdoutLineAcc.pendingBytes > 0 && code === 0) {
				this.stdoutLineAcc.flushTail(
					(tail, rawBytes) => {
						this.stdoutBytesReceived += rawBytes;
						this.handleLine(tail);
					},
					droppedBytes => {
						this.stdoutBytesReceived += droppedBytes;
					},
				);
			}
			if (this.disposed) {
				this.resolveClosed();
				return;
			}
			if (code === 255 && this.tryScheduleReattach(code)) {
				return;
			}
			this.failConnection(new Error(this.error || vscode.l10n.t('The engine connection ended ({0}).', String(code))));
		});
		return child;
	}

	private tryScheduleReattach(code: number | null): boolean {
		if (
			this.disposed
			|| this.closedError
			|| !this.remoteTarget
			|| this.remoteTarget.os === 'windows'
			|| !this.remotePersistentSessionId
			|| code !== 255
			|| this.reattachAttempt >= REMOTE_REATTACH_BACKOFFS_MS.length
		) {
			return false;
		}
		if (this.reattaching) {
			return true;
		}
		this.reattaching = true;
		const delayMs = REMOTE_REATTACH_BACKOFFS_MS[this.reattachAttempt++] ?? 60_000;
		void (async () => {
			await waitForBackoffOrResume(delayMs);
			if (this.disposed || this.closedError) {
				this.reattaching = false;
				return;
			}
			await healAllRemoteControlBridges().catch(() => undefined);
			if (this.disposed || this.closedError) {
				this.reattaching = false;
				return;
			}
			this.reattaching = false;
			this.child = this.spawnAndBind(true);
			while (this.queuedWrites.length > 0 && !this.disposed && !this.closedError) {
				const payload = this.queuedWrites.shift()!;
				this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - Buffer.byteLength(payload, 'utf8'));
				try {
					this.child.stdin.write(payload);
				} catch {
					this.queuedWrites.unshift(payload);
					this.queuedWriteBytes += Buffer.byteLength(payload, 'utf8');
					break;
				}
			}
		})();
		return true;
	}

	request<T>(method: string, params: object, options?: JsonLineRequestOptions): Promise<T> {
		if (this.closedError) { return Promise.reject(this.closedError); }
		if (options?.token?.isCancellationRequested) {
			try { options.onCancel?.(); } catch { /* ignore */ }
			return Promise.reject(new vscode.CancellationError());
		}
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined;
			let cancelSub: vscode.Disposable | undefined;
			const cleanup = () => {
				this.pending.delete(id);
				if (timeoutTimer !== undefined) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
				if (cancelGraceTimer !== undefined) {
					clearTimeout(cancelGraceTimer);
					cancelGraceTimer = undefined;
				}
				cancelSub?.dispose();
				cancelSub = undefined;
			};
			const finishResolve = (value: unknown) => {
				if (settled) { return; }
				settled = true;
				cleanup();
				resolve(value as T);
			};
			const finishReject = (err: Error) => {
				if (settled) { return; }
				settled = true;
				cleanup();
				reject(err);
			};
			this.pending.set(id, { resolve: finishResolve, reject: finishReject });
			if (options?.timeoutMs && options.timeoutMs > 0) {
				timeoutTimer = setTimeout(() => {
					finishReject(new Error(`RPC request "${method}" timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
				timeoutTimer.unref?.();
			}
			if (options?.token) {
				const onCancelled = () => {
					try { options.onCancel?.(); } catch { /* ignore */ }
					const graceMs = options.cancelGraceMs ?? 0;
					if (graceMs <= 0) {
						finishReject(new vscode.CancellationError());
						return;
					}
					if (cancelGraceTimer === undefined) {
						cancelGraceTimer = setTimeout(() => finishReject(new vscode.CancellationError()), graceMs);
						cancelGraceTimer.unref?.();
					}
				};
				if (options.token.isCancellationRequested) {
					onCancelled();
				} else {
					cancelSub = options.token.onCancellationRequested(onCancelled);
				}
			}
			try {
				this.write({ jsonrpc: '2.0', id, method, params });
			} catch (err) {
				finishReject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	write(packet: object): void {
		if (this.closedError) { throw this.closedError; }
		const payload = JSON.stringify(packet) + '\n';
		const enqueueIfPersistent = (): boolean => {
			if (!this.remotePersistentSessionId || this.disposed) {
				return false;
			}
			const bytes = Buffer.byteLength(payload, 'utf8');
			if (this.queuedWrites.length >= 256 || this.queuedWriteBytes + bytes > 8 * 1024 * 1024) {
				throw new Error('Remote engine write queue overflow while disconnected.');
			}
			this.queuedWrites.push(payload);
			this.queuedWriteBytes += bytes;
			return true;
		};
		if (this.reattaching || this.child.stdin.destroyed || !this.child.stdin.writable) {
			if (enqueueIfPersistent()) {
				return;
			}
		}
		try {
			this.child.stdin.write(payload);
		} catch (err) {
			if (!enqueueIfPersistent()) {
				throw err;
			}
		}
	}

	waitForClose(timeoutMs = 1500): Promise<void> {
		return Promise.race([
			this.closedPromise,
			new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
		]);
	}

	onPacket(listener: (packet: RpcPacket) => void): vscode.Disposable { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }

	async disposeAsync(): Promise<void> {
		this.disposed = true;
		this.failConnection(new Error(vscode.l10n.t('The engine connection was closed.')));
		try { this.child.stdin.end(); } catch { /* ignore */ }
		stopEngineWithFallback(this.child, 'SIGTERM', 1500);
		if (this.remoteTarget && this.remotePersistentSessionId) {
			await terminateRemotePersistentSession(this.remoteTarget, this.remotePersistentSessionId, { killTree: true }).catch(() => undefined);
		}
	}

	dispose(): void {
		void this.disposeAsync();
	}
}
