/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as cp from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildAgyRolePromptProtoSuffix,
	createWsFrameTransformer,
	escapeWinCmdToken,
	extractAgyCascadeIdFromProto,
	injectAgyConnectJsonRolePrompt,
	injectLlmPayloadSystemPrompt,
	injectSessionServerSystemField,
	isNativeRoleBridgeDisabledByEnv,
	isPathWithinOrEqual,
	isPureWorkerDenyToken,
	mergeRolePromptIntoText,
	observeAgyConnectWsServerMessage,
	readRoleSyncSnapshotSync,
	resolveActiveEngineAgent,
	resolveDshDirectSpawn,
	ROLE_STATE_ENV_KEY,
	RoleSyncAgentEntry,
	RoleSyncSnapshot,
	stripDirectoriesFromPath,
	transformAgyConnectWsClientMessage,
} from './roleBridgeShared';

export interface NativeRoleBridgeOptions {
	readonly distDir?: string;
	readonly bridgeDir?: string;
	readonly pid?: number;
	readonly scopeId?: string;
	readonly follower?: boolean;
	readonly enabled?: boolean;
	readonly env?: NodeJS.ProcessEnv;
	readonly onNativeSessionBound?: (shortEngine: string, agentId: string, nativeSessionId: string) => void;
	readonly childProcessModule?: { spawn: typeof cp.spawn };
	readonly fetchHost?: { fetch: typeof globalThis.fetch };
}

export interface ExternalNativeBinding {
	readonly shortEngine: string;
	readonly agentId: string;
	readonly nativeSessionId: string;
}

export interface NativeRoleBridgeController {
	readonly stateFilePath: string;
	readonly agyHooksWorkspaceDir: string;
	readonly agyBindingsFilePath: string;
	readonly externalBindingsFilePath: string;
	updateSnapshot(snapshot: RoleSyncSnapshot): Promise<void>;
	getSnapshot(): RoleSyncSnapshot;
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
	setOnNativeSessionBound(cb: ((shortEngine: string, agentId: string, nativeSessionId: string) => void) | undefined): void;
	promoteToPrimary(options?: { onNativeSessionBound?: (shortEngine: string, agentId: string, nativeSessionId: string) => void }): void;
	readAgyBindings(): Promise<Record<string, string>>;
	readExternalNativeBindings(): Promise<ExternalNativeBinding[]>;
	/** Event-driven filesystem watcher on the role-bridge directory for agy & external native binding changes (zero idle polling). */
	watchExternalBindings(onChange: () => void): () => void;
	dispose(): void;
}

const SINGLETON_GUARD = Symbol.for('aexus.nativeRoleBridge.controller');

function readExecutableBasename(command: string): string {
	return path.basename(command).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
}

function isExecutableMatch(command: string, names: readonly string[]): boolean {
	const base = readExecutableBasename(command);
	return names.includes(base);
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === flag && i + 1 < args.length && !args[i + 1].startsWith('-')) {
			return args[i + 1];
		}
		if (arg.startsWith(`${flag}=`)) {
			return arg.slice(flag.length + 1);
		}
	}
	return undefined;
}

function toCwdString(cwd: string | URL | undefined): string | undefined {
	if (!cwd) {
		return undefined;
	}
	if (cwd instanceof URL) {
		try {
			return fileURLToPath(cwd);
		} catch {
			return cwd.pathname;
		}
	}
	return cwd;
}

function isLikelyLlmEndpointUrl(urlStr: string): boolean {
	return /(?:\/v\d+\/(?:messages|chat\/completions|responses)|\/chat\/completions|\/responses|generateContent|streamGenerateContent)/i.test(urlStr);
}

function splitWriteArgs(
	encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
	maybeCb?: (error?: Error | null) => void,
): { readonly encoding?: BufferEncoding; readonly cb?: (error?: Error | null) => void } {
	if (typeof encodingOrCb === 'function') {
		return { cb: encodingOrCb };
	}
	return { encoding: encodingOrCb, cb: maybeCb };
}

function shellQuoteArg(value: string): string {
	if (process.platform === 'win32') {
		return `"${value.replace(/"/g, '\\"')}"`;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
		const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
		await fs.rename(tmp, filePath);
	} catch {
		// Best-effort local state sync.
	}
}

async function readFetchBodyText(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<string | undefined> {
	if (typeof init?.body === 'string') {
		return init.body;
	}
	if (init?.body instanceof Uint8Array || Buffer.isBuffer(init?.body)) {
		return Buffer.from(init.body).toString('utf8');
	}
	if (init?.body === undefined && typeof Request !== 'undefined' && input instanceof Request) {
		try {
			return await input.clone().text();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function createNativeRoleBridgeController(options?: NativeRoleBridgeOptions): NativeRoleBridgeController {
	const envSource = options?.env ?? process.env;
	const disabledByEnv = isNativeRoleBridgeDisabledByEnv(envSource);
	let bridgeEnabled = !disabledByEnv && options?.enabled !== false;

	const distDir = options?.distDir ?? __dirname;
	const bridgeDir = options?.bridgeDir ?? path.join(os.homedir(), '.aexus-code', 'role-bridge');
	const envWindowKey = envSource.AEXUS_ADE_WINDOW_KEY?.trim();
	const scopeId = options?.scopeId?.trim() || (options?.pid !== undefined ? String(options.pid) : (envWindowKey || String(process.pid)));
	const stateFilePath = path.join(bridgeDir, `role-state-${scopeId}.json`);
	const agyBindingsFilePath = path.join(bridgeDir, `agy-bindings-${scopeId}.json`);
	const agyInjectedFilePath = path.join(bridgeDir, `agy-injected-${scopeId}.json`);
	const externalBindingsFilePath = path.join(bridgeDir, `native-bindings-${scopeId}.json`);
	const agyHooksWorkspaceDir = path.join(bridgeDir, 'agy-hooks');
	const dshPreloadPath = path.join(distDir, 'dshRolePreload.js');
	const agyHookPath = path.join(distDir, 'agyRoleHook.js');
	const adeCliBinDir = path.resolve(distDir, '..', 'bin');
	/* eslint-disable local/code-no-sync-fs -- one-time check during extension-host preload initialization */
	const hasAdeCliBin = fsSync.existsSync(path.join(adeCliBinDir, process.platform === 'win32' ? 'aexus-ade.cmd' : 'aexus-ade'));
	/* eslint-enable local/code-no-sync-fs */
	if (bridgeEnabled && hasAdeCliBin) {
		const envPathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? (process.platform === 'win32' ? 'Path' : 'PATH');
		const curEnvPath = process.env[envPathKey] ?? '';
		const alreadyHasDir = curEnvPath
			.split(path.delimiter)
			.some(seg => process.platform === 'win32' ? seg.trim().toLowerCase() === adeCliBinDir.toLowerCase() : seg.trim() === adeCliBinDir);
		if (!alreadyHasDir) {
			process.env[envPathKey] = curEnvPath ? `${adeCliBinDir}${path.delimiter}${curEnvPath}` : adeCliBinDir;
		}
	}

	const cpModule = options?.childProcessModule ?? (require('node:child_process') as typeof cp);
	const fetchHost = options?.fetchHost ?? globalThis;

	let isFollower = Boolean(options?.follower);
	let onNativeSessionBound = options?.onNativeSessionBound;
	let snapshot: RoleSyncSnapshot = { mode: 'ide', agents: [] };
	const nativeKeyToAgentId = new Map<string, string>();
	const agentIdToNativeId = new Map<string, string>();
	const externalBindingsMap: Record<string, string> = {};
	const agyBindingsMap: Record<string, string> = {};
	const freePortPool: number[] = [];
	const activeDisposables = new Set<() => void>();
	let injectSeq = 0;
	let agyHooksReady = false;
	let hasDshPreload = false;
	let disposed = false;
	let writeQueue = Promise.resolve();
	let externalWriteQueue = Promise.resolve();
	let agyBindingsWriteQueue = Promise.resolve();
	let lastSeenStateMtimeMs = -1;
	let stateRefreshPromise: Promise<void> | undefined;
	let followerWatcher: fsSync.FSWatcher | undefined;
	let followerStarting = false;
	let followerDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	let followerFallbackTimer: ReturnType<typeof setInterval> | undefined;
	const externalBindingWatchDisposables = new Set<() => void>();

	const probeEphemeralPort = (): void => {
		if (disposed || !bridgeEnabled || freePortPool.length >= 2) {
			return;
		}
		const srv = net.createServer();
		srv.unref?.();
		srv.once('error', () => {
			try { srv.close(); } catch { }
		});
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => {
				if (!disposed && bridgeEnabled && port > 0 && !freePortPool.includes(port)) {
					freePortPool.push(port);
				}
				if (!disposed && bridgeEnabled && freePortPool.length < 2) {
					probeEphemeralPort();
				}
			});
		});
	};
	if (bridgeEnabled) {
		probeEphemeralPort();
	}

	const allocateUpstreamPortSync = (avoidPort: number): number => {
		while (freePortPool.length > 0) {
			const candidate = freePortPool.shift()!;
			if (candidate !== avoidPort) {
				probeEphemeralPort();
				return candidate;
			}
		}
		probeEphemeralPort();
		let fallback = 49152 + Math.floor(Math.random() * 14000);
		if (fallback === avoidPort) {
			fallback = fallback < 63000 ? fallback + 1 : fallback - 1;
		}
		return fallback;
	};

	const persistState = (): Promise<void> => {
		if (isFollower) {
			return writeQueue;
		}
		const currentSnapshot = snapshot;
		writeQueue = writeQueue.then(async () => {
			if (!disposed && !isFollower) {
				await writeJsonAtomic(stateFilePath, currentSnapshot);
			}
		});
		return writeQueue;
	};

	const recordExternalBinding = (shortEngine: string, agentId: string, nativeSessionId: string) => {
		const compositeKey = `${shortEngine}:${nativeSessionId}`;
		if (externalBindingsMap[compositeKey] === agentId) {
			return;
		}
		externalBindingsMap[compositeKey] = agentId;
		externalWriteQueue = externalWriteQueue.then(async () => {
			if (!disposed) {
				await writeJsonAtomic(externalBindingsFilePath, { ...externalBindingsMap });
			}
		});
	};

	const recordAgyBinding = (conversationId: string, agentId: string) => {
		if (!conversationId || !agentId) {
			return;
		}
		if (agyBindingsMap[conversationId] !== agentId) {
			agyBindingsMap[conversationId] = agentId;
			agyBindingsWriteQueue = agyBindingsWriteQueue.then(async () => {
				if (!disposed) {
					await writeJsonAtomic(agyBindingsFilePath, { ...agyBindingsMap });
				}
			});
		}
		bindNativeSession('antigravity', agentId, conversationId);
	};

	const buildAgyHooksConfig = () => {
		const command = process.platform === 'win32'
			? `set ELECTRON_RUN_AS_NODE=1&& set "${ROLE_STATE_ENV_KEY}=${stateFilePath}"&& "${process.execPath}" "${agyHookPath}"`
			: `ELECTRON_RUN_AS_NODE=1 ${ROLE_STATE_ENV_KEY}=${shellQuoteArg(stateFilePath)} ${shellQuoteArg(process.execPath)} ${shellQuoteArg(agyHookPath)}`;
		return {
			'aexus-ade-role-bridge': {
				PreInvocation: [
					{
						type: 'command',
						command,
						timeout: 5,
					},
				],
			},
		};
	};

	/* eslint-disable local/code-no-sync-fs -- agy --hub reads .agents/hooks.json immediately on process startup */
	const ensureAgyHooksWorkspaceSync = (): void => {
		if (agyHooksReady || disposed) {
			return;
		}
		try {
			if (!fsSync.existsSync(agyHookPath)) {
				return;
			}
			const agentsDir = path.join(agyHooksWorkspaceDir, '.agents');
			fsSync.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
			const target = path.join(agentsDir, 'hooks.json');
			const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
			fsSync.writeFileSync(tmp, JSON.stringify(buildAgyHooksConfig(), null, 2), { encoding: 'utf8', mode: 0o600 });
			fsSync.renameSync(tmp, target);
			agyHooksReady = true;
		} catch {
			// Best-effort hook creation only.
		}
	};
	/* eslint-enable local/code-no-sync-fs */

	const ensureAgyHooksWorkspace = async (): Promise<void> => {
		if (agyHooksReady || disposed) {
			return;
		}
		try {
			await fs.access(agyHookPath);
		} catch {
			return;
		}
		try {
			const agentsDir = path.join(agyHooksWorkspaceDir, '.agents');
			await fs.mkdir(agentsDir, { recursive: true, mode: 0o700 });
			const target = path.join(agentsDir, 'hooks.json');
			const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(buildAgyHooksConfig(), null, 2), { encoding: 'utf8', mode: 0o600 });
			await fs.rename(tmp, target);
			agyHooksReady = true;
		} catch {
			// Best-effort hook creation only.
		}
	};

	const applySnapshotToMemory = (next: RoleSyncSnapshot): void => {
		snapshot = next;
		const validAgentIds = new Set(next.agents.map(entry => entry.id));
		for (const [key, agentId] of nativeKeyToAgentId) {
			if (!validAgentIds.has(agentId)) {
				nativeKeyToAgentId.delete(key);
			}
		}
		for (const agentId of agentIdToNativeId.keys()) {
			if (!validAgentIds.has(agentId)) {
				agentIdToNativeId.delete(agentId);
			}
		}
		for (const entry of next.agents) {
			if (entry.engineId?.startsWith('aexus-') && entry.nativeSessionId) {
				const shortEngine = entry.engineId.slice('aexus-'.length);
				nativeKeyToAgentId.set(`${shortEngine}:${entry.nativeSessionId}`, entry.id);
				agentIdToNativeId.set(entry.id, entry.nativeSessionId);
			}
		}
	};

	const refreshFromStateFileSync = (): void => {
		if (disposed || !isFollower) {
			return;
		}
		const updated = readRoleSyncSnapshotSync(stateFilePath, lastSeenStateMtimeMs);
		if (updated) {
			lastSeenStateMtimeMs = updated.mtimeMs;
			applySnapshotToMemory(updated.snapshot);
		}
	};

	const refreshFromStateFile = async (): Promise<void> => {
		if (disposed || !isFollower) {
			return;
		}
		if (stateRefreshPromise) {
			return stateRefreshPromise;
		}
		stateRefreshPromise = (async () => {
			try {
				const stat = await fs.stat(stateFilePath);
				if (stat.mtimeMs === lastSeenStateMtimeMs) {
					return;
				}
				const raw = await fs.readFile(stateFilePath, 'utf8');
				const parsed = JSON.parse(raw) as unknown;
				if (parsed && typeof parsed === 'object' && Array.isArray((parsed as RoleSyncSnapshot).agents)) {
					lastSeenStateMtimeMs = stat.mtimeMs;
					applySnapshotToMemory(parsed as RoleSyncSnapshot);
				}
			} catch {
				// Ignore missing or concurrently replaced state file.
			} finally {
				stateRefreshPromise = undefined;
			}
		})();
		return stateRefreshPromise;
	};

	const stopFollowerWatcher = (): void => {
		followerStarting = false;
		if (followerDebounceTimer) {
			clearTimeout(followerDebounceTimer);
			followerDebounceTimer = undefined;
		}
		if (followerWatcher) {
			try { followerWatcher.close(); } catch { }
			followerWatcher = undefined;
		}
		if (followerFallbackTimer) {
			clearInterval(followerFallbackTimer);
			followerFallbackTimer = undefined;
		}
	};

	const startDirectoryFileWatcher = (
		targetBasenames: ReadonlySet<string>,
		debounceMs: number,
		onMatch: () => void,
		fallbackPollMs: number,
	): (() => void) => {
		let closed = false;
		let watcher: fsSync.FSWatcher | undefined;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let fallbackTimer: ReturnType<typeof setInterval> | undefined;

		const scheduleTrigger = () => {
			if (closed || disposed) {
				return;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				if (!closed && !disposed) {
					onMatch();
				}
			}, debounceMs);
			debounceTimer.unref?.();
		};

		const startFallbackPolling = () => {
			if (closed || disposed || fallbackTimer) {
				return;
			}
			fallbackTimer = setInterval(() => {
				if (!closed && !disposed) {
					onMatch();
				}
			}, fallbackPollMs);
			fallbackTimer.unref?.();
		};

		const attachWatcher = () => {
			if (closed || disposed) {
				return;
			}
			try {
				watcher = fsSync.watch(bridgeDir, { persistent: false }, (_eventType, filename) => {
					if (closed || disposed) {
						return;
					}
					if (!filename) {
						scheduleTrigger();
						return;
					}
					const base = path.basename(String(filename));
					if (targetBasenames.has(base)) {
						scheduleTrigger();
					}
				});
				watcher.on('error', () => {
					try { watcher?.close(); } catch { }
					watcher = undefined;
					startFallbackPolling();
				});
			} catch {
				startFallbackPolling();
			}
		};

		void fs.mkdir(bridgeDir, { recursive: true, mode: 0o700 }).then(async () => {
			attachWatcher();
			if (closed || disposed) {
				return;
			}
			// Reconcile once if any watched binding file already appeared during the tiny window before fs.watch attached.
			for (const base of targetBasenames) {
				try {
					await fs.access(path.join(bridgeDir, base));
					scheduleTrigger();
					break;
				} catch {
					// File not yet present — stay completely idle
				}
			}
		}, () => {
			startFallbackPolling();
		});

		return () => {
			if (closed) {
				return;
			}
			closed = true;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
			if (watcher) {
				try { watcher.close(); } catch { }
				watcher = undefined;
			}
			if (fallbackTimer) {
				clearInterval(fallbackTimer);
				fallbackTimer = undefined;
			}
		};
	};

	const startFollowerTimer = (): void => {
		if (disposed || !bridgeEnabled || !isFollower || followerStarting || followerWatcher || followerFallbackTimer) {
			return;
		}
		followerStarting = true;
		const targetBase = path.basename(stateFilePath);
		const scheduleRefresh = () => {
			if (disposed || !isFollower) {
				return;
			}
			if (followerDebounceTimer) {
				clearTimeout(followerDebounceTimer);
			}
			followerDebounceTimer = setTimeout(() => {
				followerDebounceTimer = undefined;
				void refreshFromStateFile();
			}, 30);
			followerDebounceTimer.unref?.();
		};
		const startFallback = () => {
			if (disposed || !isFollower || followerFallbackTimer) {
				return;
			}
			followerFallbackTimer = setInterval(() => {
				void refreshFromStateFile();
			}, 5_000);
			followerFallbackTimer.unref?.();
		};
		void fs.mkdir(bridgeDir, { recursive: true, mode: 0o700 }).then(() => {
			followerStarting = false;
			if (disposed || !bridgeEnabled || !isFollower || followerWatcher) {
				return;
			}
			try {
				followerWatcher = fsSync.watch(bridgeDir, { persistent: false }, (_ev, filename) => {
					if (!filename || path.basename(String(filename)) === targetBase) {
						scheduleRefresh();
					}
				});
				followerWatcher.on('error', () => {
					try { followerWatcher?.close(); } catch { }
					followerWatcher = undefined;
					startFallback();
				});
				// Re-check state file right after attaching so updates written during mkdir/startup are never missed.
				void refreshFromStateFile();
			} catch {
				startFallback();
			}
		}, () => {
			followerStarting = false;
			startFallback();
		});
	};
	startFollowerTimer();

	const initPromise = bridgeEnabled
		? Promise.all([
			fs.access(dshPreloadPath).then(() => { hasDshPreload = true; }, () => { }),
			ensureAgyHooksWorkspace(),
			fs.readFile(agyBindingsFilePath, 'utf8').then(raw => {
				const parsed = JSON.parse(raw) as unknown;
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					for (const [convId, agentId] of Object.entries(parsed as Record<string, unknown>)) {
						if (typeof agentId === 'string' && agentId && !agyBindingsMap[convId]) {
							agyBindingsMap[convId] = agentId;
						}
					}
				}
			}, () => { }),
			isFollower ? refreshFromStateFile() : persistState(),
		])
		: Promise.resolve();

	const bindNativeSession = (shortEngine: string, agentId: string, nativeSessionId: string) => {
		if (!agentId || !nativeSessionId) {
			return;
		}
		const nativeKey = `${shortEngine}:${nativeSessionId}`;
		const alreadyMapped = nativeKeyToAgentId.get(nativeKey) === agentId && agentIdToNativeId.get(agentId) === nativeSessionId;
		nativeKeyToAgentId.set(nativeKey, agentId);
		agentIdToNativeId.set(agentId, nativeSessionId);
		if (!alreadyMapped) {
			if (isFollower) {
				recordExternalBinding(shortEngine, agentId, nativeSessionId);
			}
			onNativeSessionBound?.(shortEngine, agentId, nativeSessionId);
		}
	};

	const resolveAgentForEngine = (
		shortEngine: string,
		nativeSessionId?: string,
		cwd?: string,
	): RoleSyncAgentEntry | undefined => {
		const expectedEngineId = `aexus-${shortEngine}`;
		if (nativeSessionId) {
			const mappedAgentId = nativeKeyToAgentId.get(`${shortEngine}:${nativeSessionId}`);
			if (mappedAgentId) {
				const mappedAgent = snapshot.agents.find(entry => entry.id === mappedAgentId && entry.engineId === expectedEngineId);
				if (mappedAgent) {
					return mappedAgent;
				}
			}
			const direct = snapshot.agents.find(entry => entry.engineId === expectedEngineId && entry.nativeSessionId === nativeSessionId);
			if (direct) {
				nativeKeyToAgentId.set(`${shortEngine}:${nativeSessionId}`, direct.id);
				agentIdToNativeId.set(direct.id, nativeSessionId);
				return direct;
			}
		}

		const candidate = resolveActiveEngineAgent(snapshot, shortEngine, cwd);
		if (!candidate) {
			return undefined;
		}
		const existingBoundId = candidate.nativeSessionId ?? agentIdToNativeId.get(candidate.id);
		if (nativeSessionId && existingBoundId && existingBoundId !== nativeSessionId) {
			const isExplicitlyActiveOrSelected = candidate.id === snapshot.activeAgentId || candidate.id === snapshot.selectedAgentId;
			const sameEngineCount = snapshot.agents.filter(entry => entry.engineId === expectedEngineId).length;
			if (!isExplicitlyActiveOrSelected && sameEngineCount > 1) {
				const unboundMatch = snapshot.agents.find(entry => {
					if (entry.engineId !== expectedEngineId) {
						return false;
					}
					if (entry.nativeSessionId || agentIdToNativeId.has(entry.id)) {
						return false;
					}
					if (cwd && entry.projectPath) {
						return isPathWithinOrEqual(cwd, entry.projectPath);
					}
					return true;
				});
				return unboundMatch;
			}
		}
		if (cwd && candidate.projectPath && snapshot.activeAgentId !== candidate.id && snapshot.selectedAgentId !== candidate.id) {
			if (!isPathWithinOrEqual(cwd, candidate.projectPath)) {
				return undefined;
			}
		}
		return candidate;
	};

	const updateSnapshot = async (next: RoleSyncSnapshot): Promise<void> => {
		applySnapshotToMemory(next);
		await initPromise;
		await persistState();
	};

	const resolveAgyAgentForCascade = (cascadeId: string | undefined): RoleSyncAgentEntry | undefined => {
		if (cascadeId) {
			const mappedAgentId = agyBindingsMap[cascadeId] ?? nativeKeyToAgentId.get(`antigravity:${cascadeId}`);
			if (mappedAgentId) {
				const mapped = snapshot.agents.find(entry => entry.id === mappedAgentId && entry.engineId === 'aexus-antigravity');
				if (mapped) {
					return mapped;
				}
			}
			const byNative = snapshot.agents.find(entry => entry.engineId === 'aexus-antigravity' && entry.nativeSessionId === cascadeId);
			if (byNative) {
				return byNative;
			}
		}
		return resolveAgentForEngine('antigravity', cascadeId);
	};

	const startAgyHubProxy = (child: cp.ChildProcess, targetPort: number, upstreamPort: number): void => {
		let stopped = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let proxyServer: http.Server | undefined;
		const openSockets = new Set<net.Socket>();

		const cleanup = () => {
			if (stopped) {
				return;
			}
			stopped = true;
			activeDisposables.delete(cleanup);
			if (pollTimer) {
				clearTimeout(pollTimer);
				pollTimer = undefined;
			}
			for (const sock of openSockets) {
				try { sock.destroy(); } catch { }
			}
			openSockets.clear();
			if (proxyServer) {
				const srv = proxyServer;
				proxyServer = undefined;
				try { srv.closeAllConnections?.(); } catch { }
				try { srv.close(); } catch { }
			}
		};
		activeDisposables.add(cleanup);
		child.once?.('exit', cleanup);
		child.once?.('error', cleanup);

		const readReqBuffer = (req: http.IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			req.once('end', () => resolve(Buffer.concat(chunks)));
			req.once('error', reject);
		});

		const launchProxyServer = () => {
			if (stopped || disposed) {
				return;
			}
			const srv = http.createServer(async (req, res) => {
				refreshFromStateFileSync();
				const rawUrl = req.url ?? '/';
				const pathname = rawUrl.split('?')[0];
				const method = (req.method ?? 'GET').toUpperCase();
				const isStartCascade = method === 'POST' && pathname.endsWith('/StartCascade');
				const isSendCascade = method === 'POST' && pathname.endsWith('/SendUserCascadeMessage');

				const forwardHeaders: http.OutgoingHttpHeaders = { ...req.headers };
				if (isStartCascade) {
					delete forwardHeaders['accept-encoding'];
				}

				if (isSendCascade) {
					try {
						let bodyBuf = await readReqBuffer(req);
						const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
						if (contentType.includes('json')) {
							const text = bodyBuf.toString('utf8');
							if (text.trimStart().startsWith('{')) {
								const parsed = JSON.parse(text) as Record<string, unknown>;
								const cascadeId = typeof parsed.cascadeId === 'string' && parsed.cascadeId.trim()
									? parsed.cascadeId.trim()
									: (typeof parsed.cascade_id === 'string' && parsed.cascade_id.trim() ? parsed.cascade_id.trim() : undefined);
								const agent = resolveAgyAgentForCascade(cascadeId);
								if (agent && cascadeId) {
									recordAgyBinding(cascadeId, agent.id);
								}
								if (agent?.isOrchestrated && agent.rolePrompt && injectAgyConnectJsonRolePrompt(parsed, agent.rolePrompt)) {
									bodyBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
								}
							}
						} else if (!contentType.includes('connect+')) {
							const cascadeId = extractAgyCascadeIdFromProto(bodyBuf);
							const agent = resolveAgyAgentForCascade(cascadeId);
							if (agent && cascadeId) {
								recordAgyBinding(cascadeId, agent.id);
							}
							if (agent?.isOrchestrated && agent.rolePrompt) {
								const suffix = buildAgyRolePromptProtoSuffix(agent.rolePrompt);
								if (suffix.length > 0) {
									bodyBuf = Buffer.concat([bodyBuf, suffix]);
								}
							}
						}
						forwardHeaders['content-length'] = String(bodyBuf.length);
						const upReq = http.request({
							hostname: '127.0.0.1',
							port: upstreamPort,
							path: rawUrl,
							method,
							headers: forwardHeaders,
						}, upRes => {
							res.writeHead(upRes.statusCode ?? 502, upRes.headers);
							upRes.pipe(res);
						});
						upReq.on('error', () => {
							if (!res.headersSent) { res.writeHead(502); }
							res.end();
						});
						upReq.end(bodyBuf);
						return;
					} catch {
						if (!res.headersSent) { res.writeHead(502); }
						res.end();
						return;
					}
				}

				const upReq = http.request({
					hostname: '127.0.0.1',
					port: upstreamPort,
					path: rawUrl,
					method,
					headers: forwardHeaders,
				}, upRes => {
					const respContentType = String(upRes.headers['content-type'] ?? '').toLowerCase();
					if (isStartCascade && (upRes.statusCode ?? 0) >= 200 && (upRes.statusCode ?? 0) < 300) {
						const chunks: Buffer[] = [];
						upRes.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
						upRes.once('end', () => {
							const respBuf = Buffer.concat(chunks);
							try {
								refreshFromStateFileSync();
								let cascadeId: string | undefined;
								if (respContentType.includes('json')) {
									const parsed = JSON.parse(respBuf.toString('utf8')) as { cascadeId?: unknown; cascade_id?: unknown };
									if (typeof parsed.cascadeId === 'string') { cascadeId = parsed.cascadeId.trim(); }
									else if (typeof parsed.cascade_id === 'string') { cascadeId = parsed.cascade_id.trim(); }
								} else if (!respContentType.includes('connect+')) {
									cascadeId = extractAgyCascadeIdFromProto(respBuf);
								}
								const agent = resolveAgyAgentForCascade(cascadeId);
								if (agent && cascadeId) {
									recordAgyBinding(cascadeId, agent.id);
								}
							} catch { }
							const outHeaders: http.OutgoingHttpHeaders = { ...upRes.headers, 'content-length': String(respBuf.length) };
							delete outHeaders['transfer-encoding'];
							res.writeHead(upRes.statusCode ?? 200, outHeaders);
							res.end(respBuf);
						});
						upRes.once('error', () => res.end());
						return;
					}
					res.writeHead(upRes.statusCode ?? 502, upRes.headers);
					upRes.pipe(res);
				});
				upReq.on('error', () => {
					if (!res.headersSent) { res.writeHead(502); }
					res.end();
				});
				req.pipe(upReq);
			});

			srv.on('connection', sock => {
				openSockets.add(sock);
				sock.once('close', () => openSockets.delete(sock));
			});

			srv.on('upgrade', (req, clientSocket, head) => {
				const sock = clientSocket as net.Socket;
				openSockets.add(sock);
				sock.once('close', () => openSockets.delete(sock));
				const upgradePathname = (req.url ?? '/').split('?')[0];
				const isConnectWs = upgradePathname.endsWith('/connect-websocket');
				const upHeaders: http.OutgoingHttpHeaders = { ...req.headers };
				if (isConnectWs) {
					for (const headerName of Object.keys(upHeaders)) {
						if (headerName.toLowerCase() === 'sec-websocket-extensions') {
							delete upHeaders[headerName];
						}
					}
				}
				const upReq = http.request({
					hostname: '127.0.0.1',
					port: upstreamPort,
					path: req.url ?? '/',
					method: req.method ?? 'GET',
					headers: upHeaders,
				});
				if (!isConnectWs && head.length > 0) {
					upReq.write(head);
				}
				upReq.on('upgrade', (upRes, upSocket, upHead) => {
					openSockets.add(upSocket);
					upSocket.once('close', () => openSockets.delete(upSocket));
					let statusLine = `HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}\r\n`;
					for (const [k, v] of Object.entries(upRes.headers)) {
						if (v !== undefined) {
							statusLine += `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`;
						}
					}
					statusLine += '\r\n';
					sock.write(statusLine);

					const negotiatedCompression = Boolean(upRes.headers['sec-websocket-extensions']);
					if (!isConnectWs || negotiatedCompression) {
						if (isConnectWs && head.length > 0) {
							upSocket.write(head);
						}
						if (upHead.length > 0) {
							sock.write(upHead);
						}
						upSocket.pipe(sock);
						sock.pipe(upSocket);
					} else {
						const startCascadeStreams = new Set<string>();
						const serverObserver = createWsFrameTransformer({
							shouldDecodeText: () => startCascadeStreams.size > 0,
							onTextMessage: text => {
								observeAgyConnectWsServerMessage(text, startCascadeStreams, cascadeId => {
									refreshFromStateFileSync();
									const agent = resolveAgyAgentForCascade(cascadeId);
									if (agent) {
										recordAgyBinding(cascadeId, agent.id);
									}
								});
								return undefined;
							},
						});
						const clientTransformer = createWsFrameTransformer({
							onTextMessage: text => transformAgyConnectWsClientMessage(text, startCascadeStreams, cascadeId => {
								refreshFromStateFileSync();
								const agent = resolveAgyAgentForCascade(cascadeId);
								if (agent && cascadeId) {
									recordAgyBinding(cascadeId, agent.id);
								}
								return agent;
							}),
							onChunkOut: out => {
								if (!upSocket.destroyed) {
									upSocket.write(out);
								}
							},
						});
						if (upHead.length > 0) {
							sock.write(upHead);
							serverObserver.push(upHead);
						}
						upSocket.on('data', chunk => {
							serverObserver.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
						});
						upSocket.pipe(sock);
						if (head.length > 0) {
							clientTransformer.push(head);
						}
						sock.on('data', chunk => {
							clientTransformer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
						});
					}

					sock.on('error', () => upSocket.destroy());
					upSocket.on('error', () => sock.destroy());
					sock.on('close', () => upSocket.destroy());
					upSocket.on('close', () => sock.destroy());
				});
				upReq.on('error', () => sock.destroy());
				upReq.end();
			});

			srv.on('error', () => cleanup());
			proxyServer = srv;
			srv.listen(targetPort, '127.0.0.1');
			srv.unref?.();
		};

		let attempts = 0;
		const checkUpstreamReady = () => {
			if (stopped || disposed) {
				return;
			}
			const probe = net.createConnection({ host: '127.0.0.1', port: upstreamPort });
			probe.unref?.();
			probe.once('connect', () => {
				probe.destroy();
				launchProxyServer();
			});
			probe.once('error', () => {
				probe.destroy();
				if (stopped || disposed || ++attempts > 1200) {
					cleanup();
					return;
				}
				pollTimer = setTimeout(checkUpstreamReady, 25);
				pollTimer.unref?.();
			});
		};
		checkUpstreamReady();
	};

	const wrapClaudeChild = (
		child: cp.ChildProcess,
		cliSessionId: string | undefined,
		initialRolePrompt: string | undefined,
		_isResume: boolean,
		spawnedAgentId?: string,
		cwdStr?: string,
		overrideEngine: 'claude' | 'cline' = 'claude',
	) => {
		const expectedEngineId = `aexus-${overrideEngine}`;
		let discoveredSessionId = cliSessionId;
		let pinnedAgentId = spawnedAgentId;
		let lastInjectedPrompt = initialRolePrompt;

		const resolveClaudeAgent = (sid: string | undefined): RoleSyncAgentEntry | undefined => {
			if (overrideEngine === 'cline') {
				if (pinnedAgentId) {
					const pinned = snapshot.agents.find(entry => entry.id === pinnedAgentId && entry.engineId === expectedEngineId);
					if (pinned) {
						return pinned;
					}
				}
				return resolveActiveEngineAgent(snapshot, 'cline', cwdStr);
			}
			if (sid) {
				const mappedId = nativeKeyToAgentId.get(`claude:${sid}`);
				if (mappedId) {
					const found = snapshot.agents.find(entry => entry.id === mappedId && entry.engineId === 'aexus-claude');
					if (found) {
						pinnedAgentId = found.id;
						return found;
					}
				}
			}
			if (pinnedAgentId) {
				const pinned = snapshot.agents.find(entry => entry.id === pinnedAgentId && entry.engineId === 'aexus-claude');
				if (pinned) {
					return pinned;
				}
			}
			const resolved = resolveAgentForEngine('claude', sid, cwdStr);
			if (resolved) {
				pinnedAgentId = resolved.id;
			}
			return resolved;
		};

		if (child.stdout) {
			let outBuf = '';
			const onOutData = (chunk: Buffer | string) => {
				outBuf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
				let idx: number;
				while ((idx = outBuf.indexOf('\n')) >= 0) {
					const line = outBuf.slice(0, idx).trim();
					outBuf = outBuf.slice(idx + 1);
					if (!line || !line.startsWith('{')) {
						continue;
					}
					try {
						const pkt = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string; sessionId?: string };
						if (pkt.type === 'system' && pkt.subtype === 'init') {
							const sid = pkt.session_id || pkt.sessionId;
							if (typeof sid === 'string' && sid.trim()) {
								refreshFromStateFileSync();
								discoveredSessionId = sid.trim();
								const resolved = resolveClaudeAgent(discoveredSessionId);
								if (resolved && overrideEngine === 'claude') {
									bindNativeSession('claude', resolved.id, discoveredSessionId);
									if (!lastInjectedPrompt && initialRolePrompt && resolved.isOrchestrated) {
										lastInjectedPrompt = initialRolePrompt;
									}
								}
							}
						}
					} catch {
						// Ignore non-JSON stdout lines.
					}
				}
			};
			child.stdout.on('data', onOutData);
		}

		if (child.stdin) {
			const origWrite = child.stdin.write.bind(child.stdin) as (...writeArgs: unknown[]) => boolean;
			let inBuf = '';
			const transformClaudeLine = (line: string): string => {
				if (!line.trimStart().startsWith('{')) {
					return line;
				}
				try {
					const pkt = JSON.parse(line) as Record<string, unknown>;
					// Anthropic Claude Agent SDK sends `control_request` `{ subtype: "initialize", systemPrompt, appendSystemPrompt }`
					// on stdin immediately after spawn, which overwrites CLI `--append-system-prompt`!
					if (pkt.type === 'control_request' && pkt.request && typeof pkt.request === 'object') {
						const req = pkt.request as Record<string, unknown>;
						if (req.subtype === 'initialize') {
							refreshFromStateFileSync();
							const liveAgent = resolveClaudeAgent(discoveredSessionId);
							if (liveAgent?.isOrchestrated && liveAgent.rolePrompt) {
								let injectedIntoInit = false;
								if (req.systemPrompt && typeof req.systemPrompt === 'object' && !Array.isArray(req.systemPrompt)) {
									const presetObj = { ...(req.systemPrompt as Record<string, unknown>) };
									const merged = mergeRolePromptIntoText(typeof presetObj.append === 'string' ? presetObj.append : undefined, liveAgent.rolePrompt);
									presetObj.append = merged.text;
									req.systemPrompt = presetObj;
									injectedIntoInit = true;
								} else if (Array.isArray(req.systemPrompt)) {
									req.systemPrompt = [...req.systemPrompt, liveAgent.rolePrompt];
									injectedIntoInit = true;
								}
								const mergedAppend = mergeRolePromptIntoText(typeof req.appendSystemPrompt === 'string' ? req.appendSystemPrompt : undefined, liveAgent.rolePrompt);
								req.appendSystemPrompt = mergedAppend.text;
								injectedIntoInit = true;
								if (injectedIntoInit) {
									lastInjectedPrompt = liveAgent.rolePrompt;
									return JSON.stringify(pkt);
								}
							}
							// SDK initialize replaced CLI --append-system-prompt without role context -> force injection on first user turn!
							lastInjectedPrompt = undefined;
							return line;
						}
					}
					if (pkt.type === 'user' && pkt.message && typeof pkt.message === 'object') {
						refreshFromStateFileSync();
						const sid = (typeof pkt.session_id === 'string' && pkt.session_id.trim())
							? pkt.session_id.trim()
							: discoveredSessionId;
						const liveAgent = resolveClaudeAgent(sid);
						if (liveAgent && sid && overrideEngine === 'claude') {
							bindNativeSession('claude', liveAgent.id, sid);
						}
						if (liveAgent?.isOrchestrated && liveAgent.rolePrompt) {
							const msg = pkt.message as Record<string, unknown>;
							const firstText = typeof msg.content === 'string'
								? msg.content
								: Array.isArray(msg.content)
									? String((msg.content.find(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') as { text?: string } | undefined)?.text ?? '')
									: '';
							const isCompactCmd = /^\s*\/(?:compact|smol)\b/i.test(firstText);
							const alreadyHasRoleHeader = firstText.trimStart().startsWith('[Aexus Orchestrated Role Context');
							if (isCompactCmd) {
								// Let compaction run cleanly, then re-establish role context on the following turn.
								lastInjectedPrompt = undefined;
								return line;
							}
							if (alreadyHasRoleHeader) {
								lastInjectedPrompt = liveAgent.rolePrompt;
								return line;
							}
							if (lastInjectedPrompt !== liveAgent.rolePrompt) {
								const prefix = `[Aexus Orchestrated Role Context Updated]\n${liveAgent.rolePrompt}\n\n`;
								if (typeof msg.content === 'string') {
									msg.content = `${prefix}${msg.content}`;
									lastInjectedPrompt = liveAgent.rolePrompt;
									return JSON.stringify(pkt);
								}
								if (Array.isArray(msg.content)) {
									msg.content = [{ type: 'text', text: prefix.trimEnd() }, ...msg.content];
									lastInjectedPrompt = liveAgent.rolePrompt;
									return JSON.stringify(pkt);
								}
							}
						} else if (liveAgent && !liveAgent.isOrchestrated && lastInjectedPrompt !== undefined) {
							lastInjectedPrompt = undefined;
							const msg = pkt.message as Record<string, unknown>;
							const resetNotice = '[Aexus Role Cleared: You are now a pure Worker session with no organizational rank or subordinates.]\n\n';
							if (typeof msg.content === 'string') {
								msg.content = `${resetNotice}${msg.content}`;
								return JSON.stringify(pkt);
							}
							if (Array.isArray(msg.content)) {
								msg.content = [{ type: 'text', text: resetNotice.trimEnd() }, ...msg.content];
								return JSON.stringify(pkt);
							}
						}
					}
				} catch {
					// Preserve non-JSON input verbatim.
				}
				return line;
			};

			child.stdin.write = function (chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((error?: Error | null) => void), maybeCb?: (error?: Error | null) => void): boolean {
				const { encoding, cb } = splitWriteArgs(encodingOrCb, maybeCb);
				const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
				inBuf += text;
				let idx: number;
				let out = '';
				while ((idx = inBuf.indexOf('\n')) >= 0) {
					const rawLine = inBuf.slice(0, idx);
					inBuf = inBuf.slice(idx + 1);
					const clean = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
					out += transformClaudeLine(clean) + '\n';
				}
				if (!out) {
					cb?.();
					return true;
				}
				return cb ? origWrite(out, 'utf8', cb) : origWrite(out, 'utf8');
			} as typeof child.stdin.write;
		}
	};

	const prefixCodexTurnInputWithRole = (rawTurnLine: string, rolePrompt: string): string => {
		try {
			const pkt = JSON.parse(rawTurnLine) as { params?: Record<string, unknown> };
			const params = pkt.params;
			if (!params || typeof params !== 'object') {
				return rawTurnLine;
			}
			const prefixText = `[Aexus Orchestrated Role Context]\n${rolePrompt}`;
			if (Array.isArray(params.input)) {
				params.input = [{ type: 'text', text: prefixText }, ...params.input];
				return JSON.stringify(pkt);
			}
			if (typeof params.text === 'string') {
				params.text = `${prefixText}\n\n${params.text}`;
				return JSON.stringify(pkt);
			}
		} catch {
			// Keep original payload if unexpected shape.
		}
		return rawTurnLine;
	};

	const wrapCodexChild = (child: cp.ChildProcess) => {
		const ephemeralReqIds = new Set<string>();
		const ephemeralThreadIds = new Set<string>();
		const injectedPromptByThread = new Map<string, string>();
		const pendingThreadResumes = new Map<string, { readonly tid: string; readonly rolePrompt: string }>();
		const pendingInjectBarriers = new Map<string, {
			readonly rawTurnLine: string;
			readonly tid: string;
			readonly rolePrompt: string;
			readonly cb?: (error?: Error | null) => void;
			readonly timer: ReturnType<typeof setTimeout>;
		}>();

		if (!child.stdin || !child.stdout) {
			return;
		}

		const origWrite = child.stdin.write.bind(child.stdin) as (...writeArgs: unknown[]) => boolean;

		const flushBarrier = (injectId: string, hadInjectError = false) => {
			const barrier = pendingInjectBarriers.get(injectId);
			if (!barrier) {
				return;
			}
			clearTimeout(barrier.timer);
			pendingInjectBarriers.delete(injectId);
			let outPayload = barrier.rawTurnLine + '\n';
			if (hadInjectError) {
				outPayload = prefixCodexTurnInputWithRole(barrier.rawTurnLine, barrier.rolePrompt) + '\n';
			}
			injectedPromptByThread.set(barrier.tid, barrier.rolePrompt);
			if (!child.stdin?.destroyed) {
				if (barrier.cb) {
					origWrite(outPayload, 'utf8', barrier.cb);
				} else {
					origWrite(outPayload, 'utf8');
				}
			} else {
				barrier.cb?.(new Error('Codex stdin stream closed before turn flush.'));
			}
		};

		const cleanupBarriers = () => {
			for (const injectId of [...pendingInjectBarriers.keys()]) {
				flushBarrier(injectId, false);
			}
		};
		child.once('close', cleanupBarriers);

		// Intercept stdout.push so synthetic thread/inject_items acks are stripped before openai.chatgpt sees them
		const stdout = child.stdout;
		const origPush = stdout.push.bind(stdout);
		let outBuf = '';
		const processStdoutLine = (line: string): string | undefined => {
			if (!line.trimStart().startsWith('{')) {
				return line;
			}
			try {
				const pkt = JSON.parse(line) as {
					id?: string | number;
					method?: string;
					error?: unknown;
					params?: { thread?: { id?: string; ephemeral?: boolean } };
					result?: { thread?: { id?: string } };
				};
				if (typeof pkt.id === 'string' && pkt.id.startsWith('__aexus_codex_inject_')) {
					flushBarrier(pkt.id, Boolean(pkt.error));
					return undefined;
				}
				if (pkt.id !== undefined) {
					const idKey = String(pkt.id);
					if (ephemeralReqIds.has(idKey)) {
						ephemeralReqIds.delete(idKey);
						const tid = pkt.result?.thread?.id;
						if (typeof tid === 'string') {
							ephemeralThreadIds.add(tid);
						}
					}
					const resumeMeta = pendingThreadResumes.get(idKey);
					if (resumeMeta) {
						pendingThreadResumes.delete(idKey);
						if (!pkt.error) {
							injectedPromptByThread.set(resumeMeta.tid, resumeMeta.rolePrompt);
						}
					}
				}
				if (pkt.method === 'thread/started' && pkt.params?.thread?.ephemeral === true && typeof pkt.params.thread.id === 'string') {
					ephemeralThreadIds.add(pkt.params.thread.id);
				}
			} catch {
				// Preserve non-JSON lines unchanged.
			}
			return line;
		};

		stdout.push = function (chunk: Buffer | string | null, _encoding?: BufferEncoding): boolean {
			if (chunk === null) {
				if (outBuf.length > 0) {
					const kept = processStdoutLine(outBuf);
					outBuf = '';
					if (kept !== undefined) {
						origPush(Buffer.from(kept, 'utf8'));
					}
				}
				return origPush(null);
			}
			outBuf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
			let idx: number;
			let keptOut = '';
			while ((idx = outBuf.indexOf('\n')) >= 0) {
				const rawLine = outBuf.slice(0, idx);
				outBuf = outBuf.slice(idx + 1);
				const clean = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				const kept = processStdoutLine(clean);
				if (kept !== undefined) {
					keptOut += kept + '\n';
				}
			}
			if (!keptOut) {
				return true;
			}
			return origPush(Buffer.from(keptOut, 'utf8'));
		} as typeof stdout.push;

		let inBuf = '';
		child.stdin.write = function (chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((error?: Error | null) => void), maybeCb?: (error?: Error | null) => void): boolean {
			refreshFromStateFileSync();
			const { encoding, cb } = splitWriteArgs(encodingOrCb, maybeCb);
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
			inBuf += text;
			let idx: number;
			let immediateOut = '';
			let deferred = false;

			while ((idx = inBuf.indexOf('\n')) >= 0) {
				const rawLine = inBuf.slice(0, idx);
				inBuf = inBuf.slice(idx + 1);
				const clean = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				if (!clean.trimStart().startsWith('{')) {
					immediateOut += clean + '\n';
					continue;
				}
				try {
					const pkt = JSON.parse(clean) as {
						id?: string | number;
						method?: string;
						params?: Record<string, unknown>;
					};
					const params = pkt.params;

					if ((pkt.method === 'thread/start' || pkt.method === 'thread/startAeon' || pkt.method === 'thread/fork') && params?.ephemeral === true && pkt.id !== undefined) {
						ephemeralReqIds.add(String(pkt.id));
						immediateOut += clean + '\n';
						continue;
					}

					if (pkt.method === 'thread/resume' && typeof params?.threadId === 'string') {
						const tid = params.threadId;
						if (!ephemeralThreadIds.has(tid)) {
							const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
							const agent = resolveAgentForEngine('codex', tid, cwd);
							if (agent) {
								bindNativeSession('codex', agent.id, tid);
								if (agent.isOrchestrated && agent.rolePrompt) {
									const merged = mergeRolePromptIntoText(typeof params.developerInstructions === 'string' ? params.developerInstructions : undefined, agent.rolePrompt);
									params.developerInstructions = merged.text;
									if (pkt.id !== undefined) {
										pendingThreadResumes.set(String(pkt.id), { tid, rolePrompt: agent.rolePrompt });
									} else {
										injectedPromptByThread.set(tid, agent.rolePrompt);
									}
									immediateOut += JSON.stringify(pkt) + '\n';
									continue;
								}
							}
						}
						immediateOut += clean + '\n';
						continue;
					}

					if ((pkt.method === 'turn/start' || pkt.method === 'turn/addUserMessage' || pkt.method === 'turn/steer') && typeof params?.threadId === 'string') {
						const tid = params.threadId;
						if (!ephemeralThreadIds.has(tid)) {
							const inputItems = Array.isArray(params.input) ? params.input : [];
							const firstInputText = String((inputItems.find(it => it && typeof it === 'object' && typeof (it as { text?: unknown }).text === 'string') as { text?: string } | undefined)?.text ?? '');
							if (/^\s*\/(?:compact|smol)\b/i.test(firstInputText)) {
								injectedPromptByThread.delete(tid);
								immediateOut += clean + '\n';
								continue;
							}
							const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
							const agent = resolveAgentForEngine('codex', tid, cwd);
							if (agent) {
								bindNativeSession('codex', agent.id, tid);
							}
							if (agent?.isOrchestrated && agent.rolePrompt && injectedPromptByThread.get(tid) !== agent.rolePrompt) {
								const injectId = `__aexus_codex_inject_${++injectSeq}`;
								const injectPacket = JSON.stringify({
									id: injectId,
									method: 'thread/inject_items',
									params: {
										threadId: tid,
										items: [
											{
												type: 'message',
												role: 'developer',
												content: [{ type: 'input_text', text: agent.rolePrompt }],
											},
										],
									},
								}) + '\n';
								if (immediateOut) {
									origWrite(immediateOut, 'utf8');
									immediateOut = '';
								}
								origWrite(injectPacket, 'utf8');
								const timer = setTimeout(() => flushBarrier(injectId, false), 1500);
								pendingInjectBarriers.set(injectId, {
									rawTurnLine: clean,
									tid,
									rolePrompt: agent.rolePrompt,
									cb,
									timer,
								});
								deferred = true;
								continue;
							}
						}
					}
				} catch {
					// Preserve non-JSON lines verbatim.
				}
				immediateOut += clean + '\n';
			}

			if (immediateOut) {
				if (!deferred && cb) {
					return origWrite(immediateOut, 'utf8', cb);
				}
				return origWrite(immediateOut, 'utf8');
			}
			if (!deferred) {
				cb?.();
			}
			return true;
		} as typeof child.stdin.write;
	};

	const wrapPiChild = (
		child: cp.ChildProcess,
		initialRolePrompt: string | undefined,
		spawnedAgentId?: string,
		cliSessionId?: string,
		cwdStr?: string,
	) => {
		if (!child.stdin) {
			return;
		}
		const origWrite = child.stdin.write.bind(child.stdin) as (...writeArgs: unknown[]) => boolean;
		let lastInjectedPrompt = initialRolePrompt;
		let pinnedAgentId = spawnedAgentId;
		let currentPiSessionId = cliSessionId;
		let inBuf = '';

		const resolveLivePiAgent = (): RoleSyncAgentEntry | undefined => {
			if (currentPiSessionId) {
				const mappedId = nativeKeyToAgentId.get(`pi:${currentPiSessionId}`);
				if (mappedId) {
					const found = snapshot.agents.find(entry => entry.id === mappedId && entry.engineId === 'aexus-pi');
					if (found) {
						pinnedAgentId = found.id;
						return found;
					}
				}
			}
			const activeCandidate = resolveActiveEngineAgent(snapshot, 'pi', cwdStr);
			if (activeCandidate && (activeCandidate.id === snapshot.activeAgentId || activeCandidate.id === snapshot.selectedAgentId)) {
				pinnedAgentId = activeCandidate.id;
				return activeCandidate;
			}
			if (pinnedAgentId) {
				const pinned = snapshot.agents.find(entry => entry.id === pinnedAgentId && entry.engineId === 'aexus-pi');
				if (pinned) {
					return pinned;
				}
			}
			const resolved = resolveAgentForEngine('pi', currentPiSessionId, cwdStr);
			if (resolved) {
				pinnedAgentId = resolved.id;
			}
			return resolved;
		};

		child.stdin.write = function (chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((error?: Error | null) => void), maybeCb?: (error?: Error | null) => void): boolean {
			refreshFromStateFileSync();
			const { encoding, cb } = splitWriteArgs(encodingOrCb, maybeCb);
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
			inBuf += text;
			let idx: number;
			let out = '';
			while ((idx = inBuf.indexOf('\n')) >= 0) {
				const rawLine = inBuf.slice(0, idx);
				inBuf = inBuf.slice(idx + 1);
				const clean = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				if (!clean.trimStart().startsWith('{')) {
					out += clean + '\n';
					continue;
				}
				try {
					const pkt = JSON.parse(clean) as { type?: string; message?: unknown; sessionPath?: unknown; sessionId?: unknown };
					if (pkt.type === 'new_session' || pkt.type === 'switch_session' || pkt.type === 'fork') {
						lastInjectedPrompt = undefined;
						const nextSid = typeof pkt.sessionId === 'string' && pkt.sessionId.trim()
							? pkt.sessionId.trim()
							: (typeof pkt.sessionPath === 'string' && pkt.sessionPath.trim() ? pkt.sessionPath.trim() : undefined);
						currentPiSessionId = nextSid;
						const nextAgent = resolveLivePiAgent();
						if (nextAgent && nextSid) {
							bindNativeSession('pi', nextAgent.id, nextSid);
						}
						out += clean + '\n';
						continue;
					}
					if ((pkt.type === 'prompt' || pkt.type === 'steer' || pkt.type === 'follow_up') && typeof pkt.message === 'string') {
						const liveAgent = resolveLivePiAgent();
						if (liveAgent && currentPiSessionId) {
							bindNativeSession('pi', liveAgent.id, currentPiSessionId);
						}
						if (/^\s*\/(?:compact|smol)\b/i.test(pkt.message)) {
							lastInjectedPrompt = undefined;
							out += clean + '\n';
							continue;
						}
						if (liveAgent?.isOrchestrated && liveAgent.rolePrompt) {
							if (pkt.message.trimStart().startsWith('[Aexus Orchestrated Role Context')) {
								lastInjectedPrompt = liveAgent.rolePrompt;
								out += clean + '\n';
								continue;
							}
							if (lastInjectedPrompt !== liveAgent.rolePrompt) {
								pkt.message = `[Aexus Orchestrated Role Context Updated]\n${liveAgent.rolePrompt}\n\n${pkt.message}`;
								lastInjectedPrompt = liveAgent.rolePrompt;
								out += JSON.stringify(pkt) + '\n';
								continue;
							}
						} else if (liveAgent && !liveAgent.isOrchestrated && lastInjectedPrompt !== undefined) {
							lastInjectedPrompt = undefined;
							pkt.message = `[Aexus Role Cleared: You are now a pure Worker session with no organizational rank or subordinates.]\n\n${pkt.message}`;
							out += JSON.stringify(pkt) + '\n';
							continue;
						}
					}
				} catch {
					// Preserve non-JSON lines unchanged.
				}
				out += clean + '\n';
			}
			if (!out) {
				cb?.();
				return true;
			}
			return cb ? origWrite(out, 'utf8', cb) : origWrite(out, 'utf8');
		} as typeof child.stdin.write;
	};

	const origSpawn = cpModule.spawn;
	const wrappedSpawn = function (
		command: string,
		argsOrOptions?: readonly string[] | cp.SpawnOptions,
		maybeOptions?: cp.SpawnOptions,
	): cp.ChildProcess {
		refreshFromStateFileSync();
		let nextCommand = command;
		let nextArgs = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
		let nextOptions = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as cp.SpawnOptions | undefined;

		// Skip internal aexus-agents engineProcess.js workers and SSH transports; they already go through resolvePromptContext.
		if (nextArgs.some(arg => path.basename(arg) === 'engineProcess.js') || isExecutableMatch(nextCommand, ['ssh'])) {
			return origSpawn.call(cpModule, nextCommand, nextArgs, nextOptions ?? {});
		}

		const cwdStr = toCwdString(nextOptions?.cwd);
		const spawnStack = new Error().stack ?? '';
		const spawnCallerIsCline = spawnStack.includes('claude-dev');

		const isClaudeStream = !nextArgs.includes('--append-system-prompt')
			&& !nextArgs.includes('--append-system-prompt-file')
			&& nextArgs.includes('--input-format')
			&& nextArgs.includes('--output-format')
			&& nextArgs.includes('stream-json')
			&& (isExecutableMatch(nextCommand, ['claude']) || nextArgs.some(a => /(?:^|[\\/])claude(?:-code)?(?:[\\/]cli\.js|\.js|\.cjs|\.mjs|\.exe)?$/i.test(a)));

		const cmdBase = readExecutableBasename(nextCommand);
		const isCodexAppServer = nextArgs.includes('app-server')
			&& (isExecutableMatch(nextCommand, ['codex']) || /^codex(?:[-_.]|$)/i.test(cmdBase) || nextArgs.some(a => /(?:^|[\\/])codex(?:[-_.][\w.-]+)?(?:\.exe)?$/i.test(a)));

		const piModeIdx = nextArgs.indexOf('--mode');
		const isPiScriptArg = (arg: string): boolean =>
			/(?:^|[\\/])pi(?:\.js|\.cjs|\.mjs|\.exe)?$/i.test(arg)
			|| /(?:^|[\\/])pi(?:-coding-agent)?[\\/].*\bcli\.(?:c|m)?js$/i.test(arg)
			|| /@[\w.-]+[\\/]pi-coding-agent[\\/].*\bcli\.(?:c|m)?js$/i.test(arg);
		const isPiRpc = piModeIdx >= 0
			&& nextArgs[piModeIdx + 1] === 'rpc'
			&& (isExecutableMatch(nextCommand, ['pi']) || /^pi(?:[-_.]|$)/i.test(cmdBase) || nextArgs.some(isPiScriptArg));

		const dshProfileIdx = nextArgs.indexOf('--profile');
		const dshScriptArgIdx = nextArgs.findIndex(a => /(?:^|[\\/])@deepseek-ai[\\/]dsh(?:[\\/]lib[\\/]bin\.js)?$/i.test(a));
		const isDshCommandDirect = isExecutableMatch(nextCommand, ['dsh', 'deepseek harness'])
			|| /(?:^|[\\/])@deepseek-ai[\\/]dsh(?:[\\/]lib[\\/]bin\.js)?$/i.test(nextCommand);
		const isDshWeb = (isDshCommandDirect || (isExecutableMatch(nextCommand, ['node', 'bun']) && dshScriptArgIdx >= 0))
			&& !nextArgs.includes('--version')
			&& !nextArgs.includes('--help')
			&& !nextArgs.includes('-h')
			&& !nextArgs.includes('-V')
			&& !nextArgs.includes('--dump-config')
			&& !nextArgs.includes('--dump-config-schema')
			&& !nextArgs.includes('--dump-default-config')
			&& !(dshProfileIdx >= 0 && nextArgs[dshProfileIdx + 1] === 'acp');

		const isAgyHub = nextArgs.includes('--hub')
			&& (isExecutableMatch(nextCommand, ['agy', 'language_server_macos_arm', 'language_server_macos_x64', 'language_server_linux_x64', 'language_server']) || nextArgs.some(a => a.startsWith('--app_data_dir=')));

		let claudeCliSid: string | undefined;
		let claudeInitialPrompt: string | undefined;
		let claudeIsResume = false;
		let claudeSpawnedAgentId: string | undefined;
		let claudeOverrideEngine: 'claude' | 'cline' = 'claude';
		let piCliSid: string | undefined;
		let piInitialPrompt: string | undefined;
		let piSpawnedAgentId: string | undefined;
		let agyProxyTargetPort: number | undefined;
		let agyProxyUpstreamPort: number | undefined;

		if (isClaudeStream) {
			const resumeSid = readFlagValue(nextArgs, '--resume');
			const explicitSid = readFlagValue(nextArgs, '--session-id');
			claudeCliSid = resumeSid ?? explicitSid;
			claudeIsResume = Boolean(resumeSid);
			if (spawnCallerIsCline) {
				claudeOverrideEngine = 'cline';
				const clineAgent = resolveActiveEngineAgent(snapshot, 'cline', cwdStr);
				if (clineAgent) {
					claudeSpawnedAgentId = clineAgent.id;
					if (clineAgent.isOrchestrated && clineAgent.rolePrompt) {
						nextArgs.push('--append-system-prompt', clineAgent.rolePrompt);
						claudeInitialPrompt = clineAgent.rolePrompt;
					}
				}
			} else {
				const agent = resolveAgentForEngine('claude', claudeCliSid, cwdStr);
				if (agent) {
					claudeSpawnedAgentId = agent.id;
					if (claudeCliSid) {
						bindNativeSession('claude', agent.id, claudeCliSid);
					}
					if (agent.isOrchestrated && agent.rolePrompt) {
						nextArgs.push('--append-system-prompt', agent.rolePrompt);
						claudeInitialPrompt = agent.rolePrompt;
					}
				}
			}
		} else if (isPiRpc) {
			piCliSid = readFlagValue(nextArgs, '--session-id') ?? readFlagValue(nextArgs, '--session');
			const agent = resolveAgentForEngine('pi', piCliSid, cwdStr);
			if (agent) {
				piSpawnedAgentId = agent.id;
				if (piCliSid) {
					bindNativeSession('pi', agent.id, piCliSid);
				}
				if (agent.isOrchestrated && agent.rolePrompt && !nextArgs.includes('--append-system-prompt')) {
					nextArgs.push('--append-system-prompt', agent.rolePrompt);
					piInitialPrompt = agent.rolePrompt;
				}
			}
		} else if (isDshWeb) {
			if (isExecutableMatch(nextCommand, ['node', 'bun']) && dshScriptArgIdx >= 0 && hasDshPreload && !nextArgs.includes(dshPreloadPath)) {
				nextArgs.splice(dshScriptArgIdx, 0, '--require', dshPreloadPath);
				nextOptions = {
					...(nextOptions ?? {}),
					env: { ...(nextOptions?.env ?? process.env), [ROLE_STATE_ENV_KEY]: stateFilePath },
				};
			} else {
				const directSpec = resolveDshDirectSpawn(nextCommand, nextArgs, nextOptions?.env, dshPreloadPath, stateFilePath);
				if (directSpec) {
					nextCommand = directSpec.command;
					nextArgs = directSpec.args;
					nextOptions = { ...(nextOptions ?? {}), env: directSpec.env };
				}
			}
		} else if (isAgyHub) {
			ensureAgyHooksWorkspaceSync();
			void ensureAgyHooksWorkspace();
			nextOptions = {
				...(nextOptions ?? {}),
				env: {
					...(nextOptions?.env ?? process.env),
					[ROLE_STATE_ENV_KEY]: stateFilePath,
				},
			};
			if (!nextArgs.some(arg => arg === `--add-dir=${agyHooksWorkspaceDir}`)) {
				nextArgs.push(`--add-dir=${agyHooksWorkspaceDir}`);
			}
			const rawHubPort = readFlagValue(nextArgs, '--hub-port');
			const parsedPort = rawHubPort && /^\d+$/.test(rawHubPort) ? Number(rawHubPort) : 0;
			if (parsedPort > 0 && parsedPort < 65536) {
				const upstreamPort = allocateUpstreamPortSync(parsedPort);
				agyProxyTargetPort = parsedPort;
				agyProxyUpstreamPort = upstreamPort;
				nextArgs = nextArgs.map((arg, idx) => {
					if (arg === `--hub-port=${rawHubPort}`) {
						return `--hub-port=${upstreamPort}`;
					}
					if (idx > 0 && nextArgs[idx - 1] === '--hub-port' && arg === rawHubPort) {
						return String(upstreamPort);
					}
					return arg;
				});
			}
		}

		if (hasAdeCliBin && nextOptions?.env) {
			const pathKey = Object.keys(nextOptions.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
			const rawPath = nextOptions.env[pathKey] ?? '';
			if (isPureWorkerDenyToken(nextOptions.env.AEXUS_ADE_SESSION_TOKEN)) {
				// Never re-inject the bundled ADE CLI bin dir into a pure Worker child's PATH.
				nextOptions = {
					...nextOptions,
					env: {
						...nextOptions.env,
						[pathKey]: stripDirectoriesFromPath(rawPath, [adeCliBinDir]),
					},
				};
			} else if (!rawPath.split(path.delimiter).includes(adeCliBinDir)) {
				nextOptions = {
					...nextOptions,
					env: {
						...nextOptions.env,
						[pathKey]: rawPath ? `${adeCliBinDir}${path.delimiter}${rawPath}` : adeCliBinDir,
					},
				};
			}
		}

		let finalSpawnCommand = nextCommand;
		let finalSpawnArgs = nextArgs;
		let finalSpawnOptions: cp.SpawnOptions = nextOptions ?? {};
		if (process.platform === 'win32' && !finalSpawnOptions.shell && /\.(cmd|bat)$/i.test(finalSpawnCommand)) {
			const comspec = (finalSpawnOptions.env?.ComSpec || process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'));
			const innerCmd = [escapeWinCmdToken(finalSpawnCommand, true), ...finalSpawnArgs.map(a => escapeWinCmdToken(a, false))].join(' ');
			finalSpawnCommand = comspec;
			finalSpawnArgs = ['/d', '/s', '/c', `"${innerCmd}"`];
			finalSpawnOptions = {
				...finalSpawnOptions,
				windowsHide: finalSpawnOptions.windowsHide ?? true,
				windowsVerbatimArguments: true,
			};
		}

		const child = origSpawn.call(cpModule, finalSpawnCommand, finalSpawnArgs, finalSpawnOptions);

		if (isClaudeStream) {
			wrapClaudeChild(child, claudeCliSid, claudeInitialPrompt, claudeIsResume, claudeSpawnedAgentId, cwdStr, claudeOverrideEngine);
		} else if (isCodexAppServer) {
			wrapCodexChild(child);
		} else if (isPiRpc) {
			wrapPiChild(child, piInitialPrompt, piSpawnedAgentId, piCliSid, cwdStr);
		} else if (isAgyHub && agyProxyTargetPort !== undefined && agyProxyUpstreamPort !== undefined) {
			startAgyHubProxy(child, agyProxyTargetPort, agyProxyUpstreamPort);
		}

		return child;
	};

	const origFetchRef = fetchHost.fetch;
	const origFetch = origFetchRef.bind(fetchHost);
	const wrappedFetch = async function (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
		const urlStr = typeof input === 'string'
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
		const method = (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();

		if (method === 'POST') {
			if (isFollower) {
				await refreshFromStateFile();
			}
			const sessionMatch = urlStr.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/session\/([^/?#]+)\/(?:prompt_async|message|command)(?:[?#]|$)/i);
			const stack = sessionMatch || resolveActiveEngineAgent(snapshot, 'cline')?.isOrchestrated ? (new Error().stack ?? '') : '';

			if (sessionMatch) {
				const sessionID = decodeURIComponent(sessionMatch[1]);
				let queryDirectory: string | undefined;
				try {
					queryDirectory = new URL(urlStr).searchParams.get('directory') ?? undefined;
				} catch {
					queryDirectory = undefined;
				}
				let shortEngine: 'kilo' | 'opencode' | 'cline' | undefined;
				if (stack.includes('claude-dev')) {
					shortEngine = 'cline';
				} else if (stack.includes('kilo-code') || stack.includes('kilocode')) {
					shortEngine = 'kilo';
				} else if (stack.includes('opencode-vscode-ui') || stack.includes('opencode')) {
					shortEngine = 'opencode';
				} else if (nativeKeyToAgentId.has(`kilo:${sessionID}`)) {
					shortEngine = 'kilo';
				} else if (nativeKeyToAgentId.has(`opencode:${sessionID}`)) {
					shortEngine = 'opencode';
				} else {
					const activeKilo = resolveActiveEngineAgent(snapshot, 'kilo', queryDirectory);
					const activeOpenCode = resolveActiveEngineAgent(snapshot, 'opencode', queryDirectory);
					if (activeKilo && !activeOpenCode) {
						shortEngine = 'kilo';
					} else if (activeOpenCode && !activeKilo) {
						shortEngine = 'opencode';
					} else if (snapshot.activeAgentId) {
						const active = snapshot.agents.find(a => a.id === snapshot.activeAgentId);
						if (active?.engineId === 'aexus-kilo') {
							shortEngine = 'kilo';
						} else if (active?.engineId === 'aexus-opencode') {
							shortEngine = 'opencode';
						}
					}
				}

				if (shortEngine) {
					const rawBody = await readFetchBodyText(input, init);
					if (rawBody && rawBody.trimStart().startsWith('{')) {
						try {
							const parsed = JSON.parse(rawBody) as Record<string, unknown>;
							if (parsed.noReply !== true) {
								const agent = shortEngine === 'cline'
									? resolveActiveEngineAgent(snapshot, 'cline', queryDirectory)
									: resolveAgentForEngine(shortEngine, sessionID, queryDirectory);
								if (agent) {
									if (shortEngine !== 'cline') {
										bindNativeSession(shortEngine, agent.id, sessionID);
									}
									if (agent.isOrchestrated && agent.rolePrompt && injectSessionServerSystemField(parsed, agent.rolePrompt)) {
										const nextBody = JSON.stringify(parsed);
										if (typeof Request !== 'undefined' && input instanceof Request && init?.body === undefined) {
											const nextHeaders = new Headers(input.headers);
											nextHeaders.delete('content-length');
											return origFetch(input.url, {
												method: input.method,
												headers: nextHeaders,
												body: nextBody,
												signal: init?.signal ?? input.signal,
											});
										}
										const nextHeaders = new Headers(init?.headers);
										nextHeaders.delete('content-length');
										return origFetch(input, { ...init, headers: nextHeaders, body: nextBody });
									}
								}
							}
						} catch {
							// Leave invalid JSON untouched.
						}
					}
				}
			} else {
				const activeCline = resolveActiveEngineAgent(snapshot, 'cline');
				const stackHasOther = stack.includes('kilo-code') || stack.includes('opencode-vscode-ui') || stack.includes('chatgpt') || stack.includes('claude-code') || stack.includes('google-antigravity') || stack.includes('pi-coding-agent');
				const stackHasCline = stack.includes('claude-dev');
				if (activeCline?.isOrchestrated && activeCline.rolePrompt && !stackHasOther && (stackHasCline || isLikelyLlmEndpointUrl(urlStr))) {
					const rawBody = await readFetchBodyText(input, init);
					if (rawBody && rawBody.trimStart().startsWith('{')) {
						try {
							const parsed = JSON.parse(rawBody) as Record<string, unknown>;
							if (injectLlmPayloadSystemPrompt(urlStr, parsed, activeCline.rolePrompt)) {
								const nextBody = JSON.stringify(parsed);
								if (typeof Request !== 'undefined' && input instanceof Request && init?.body === undefined) {
									const nextHeaders = new Headers(input.headers);
									nextHeaders.delete('content-length');
									return origFetch(input.url, {
										method: input.method,
										headers: nextHeaders,
										body: nextBody,
										signal: init?.signal ?? input.signal,
									});
								}
								const nextHeaders = new Headers(init?.headers);
								nextHeaders.delete('content-length');
								return origFetch(input, { ...init, headers: nextHeaders, body: nextBody });
							}
						} catch {
							// Leave non-JSON bodies untouched.
						}
					}
				}
			}
		}

		return origFetch(input, init);
	};

	const applyHooksState = (): void => {
		if (disposed) {
			return;
		}
		if (bridgeEnabled) {
			if (cpModule.spawn !== wrappedSpawn) {
				cpModule.spawn = wrappedSpawn as typeof cpModule.spawn;
			}
			if (fetchHost.fetch !== wrappedFetch) {
				fetchHost.fetch = wrappedFetch;
			}
			probeEphemeralPort();
			startFollowerTimer();
		} else {
			if (cpModule.spawn === wrappedSpawn) {
				cpModule.spawn = origSpawn;
			}
			if (fetchHost.fetch === wrappedFetch) {
				fetchHost.fetch = origFetchRef;
			}
			stopFollowerWatcher();
			for (const cleanup of [...activeDisposables]) {
				cleanup();
			}
			activeDisposables.clear();
		}
	};

	if (bridgeEnabled) {
		applyHooksState();
	}

	return {
		stateFilePath,
		agyHooksWorkspaceDir,
		agyBindingsFilePath,
		externalBindingsFilePath,
		updateSnapshot: async next => {
			if (!bridgeEnabled) {
				if (!disposed) {
					applySnapshotToMemory(next);
				}
				return;
			}
			await updateSnapshot(next);
		},
		getSnapshot: () => snapshot,
		isEnabled: () => bridgeEnabled && !disposed,
		setEnabled: enabled => {
			if (disposed) {
				return;
			}
			const nextEnabled = !disabledByEnv && Boolean(enabled);
			if (nextEnabled === bridgeEnabled) {
				return;
			}
			bridgeEnabled = nextEnabled;
			applyHooksState();
			if (bridgeEnabled && !isFollower) {
				void persistState();
			}
		},
		setOnNativeSessionBound: cb => { onNativeSessionBound = cb; },
		promoteToPrimary: promoteOpts => {
			isFollower = false;
			stopFollowerWatcher();
			if (promoteOpts?.onNativeSessionBound) {
				onNativeSessionBound = promoteOpts.onNativeSessionBound;
			}
			void persistState();
		},
		watchExternalBindings: onChange => {
			if (disposed) {
				return () => { };
			}
			const watchedNames = new Set<string>([
				path.basename(agyBindingsFilePath),
				path.basename(externalBindingsFilePath),
			]);
			const stop = startDirectoryFileWatcher(watchedNames, 60, onChange, 15_000);
			const cleanup = () => {
				externalBindingWatchDisposables.delete(cleanup);
				stop();
			};
			externalBindingWatchDisposables.add(cleanup);
			return cleanup;
		},
		readAgyBindings: async () => {
			try {
				const raw = await fs.readFile(agyBindingsFilePath, 'utf8');
				const parsed = JSON.parse(raw) as unknown;
				return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
			} catch {
				return {};
			}
		},
		readExternalNativeBindings: async () => {
			try {
				const raw = await fs.readFile(externalBindingsFilePath, 'utf8');
				const parsed = JSON.parse(raw) as unknown;
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					return [];
				}
				const result: ExternalNativeBinding[] = [];
				for (const [compositeKey, agentId] of Object.entries(parsed)) {
					if (typeof agentId !== 'string' || !agentId) {
						continue;
					}
					const sep = compositeKey.indexOf(':');
					if (sep <= 0 || sep >= compositeKey.length - 1) {
						continue;
					}
					result.push({
						shortEngine: compositeKey.slice(0, sep),
						nativeSessionId: compositeKey.slice(sep + 1),
						agentId,
					});
				}
				return result;
			} catch {
				return [];
			}
		},
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const cleanup of [...activeDisposables]) {
				cleanup();
			}
			activeDisposables.clear();
			for (const cleanup of [...externalBindingWatchDisposables]) {
				cleanup();
			}
			externalBindingWatchDisposables.clear();
			stopFollowerWatcher();
			if (cpModule.spawn === wrappedSpawn) {
				cpModule.spawn = origSpawn;
			}
			if (fetchHost.fetch === wrappedFetch) {
				fetchHost.fetch = origFetchRef;
			}
			if (!isFollower) {
				for (const file of [stateFilePath, agyBindingsFilePath, agyInjectedFilePath, externalBindingsFilePath]) {
					void fs.rm(file, { force: true }).catch(() => { });
				}
			}
		},
	};
}

export function installNativeRoleBridge(options?: NativeRoleBridgeOptions): NativeRoleBridgeController {
	const g = globalThis as unknown as Record<symbol, NativeRoleBridgeController | undefined>;
	let existing = g[SINGLETON_GUARD];
	if (!existing) {
		existing = createNativeRoleBridgeController(options);
		g[SINGLETON_GUARD] = existing;
		return existing;
	}
	if (!options?.follower) {
		existing.promoteToPrimary({ onNativeSessionBound: options?.onNativeSessionBound });
	}
	return existing;
}
