/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ADE_SAFE_CLI_COMMANDS } from './engineAdapterHelpers.ts';

export interface UriLike {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	toString(): string;
}

export interface ParsedCloudProjectUri {
	readonly scheme: typeof CLOUD_PROJECT_SCHEME;
	readonly authority: string;
	readonly path: string;
	readonly raw: string;
}

export interface CancellationTokenLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => unknown): { dispose(): void };
}

export interface CloudHostSshContext {
	readonly effectiveSshConfigPath?: string;
	readonly alias?: string;
	readonly os?: string;
	readonly strictHostKeyChecking?: 'yes' | 'accept-new' | 'no';
	readonly remoteHome?: string;
	readonly sshExecutable?: string;
}

export interface CloudTransportBridge {
	getCloudHostSshContext?: (authority: string) => Promise<CloudHostSshContext | undefined>;
	getConfiguredSshExecutable?: () => string | undefined;
	getConfiguredRemoteCliPaths?: () => Record<string, Record<string, string>> | undefined;
	createCancellationError?: () => Error;
}

let cloudTransportBridge: CloudTransportBridge = {};

export function registerCloudTransportBridge(bridge: CloudTransportBridge): void {
	cloudTransportBridge = bridge;
}

const ADE_CONTROL_ENV_KEY_SET = new Set<string>([
	'ADE_AGENT_TOKEN',
	'ADE_CONTROL_SOCKET',
	'ADE_CONTROL_ENDPOINT',
	'ADE_CONTROL_BRIDGE_FILE',
	'ADE_REMOTE_CLI_BIN_DIR',
	'ADE_CLI_CMD',
]);

function stripLocalAdeControlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		const upper = k.toUpperCase();
		if (!ADE_CONTROL_ENV_KEY_SET.has(upper) && !upper.startsWith('AEXUS_ADE_') && !upper.startsWith('ADE_CONTROL_')) {
			cleaned[k] = v;
		}
	}
	return cleaned;
}

function makeCancellationError(): Error {
	if (cloudTransportBridge.createCancellationError) {
		return cloudTransportBridge.createCancellationError();
	}
	const err = new Error('Canceled');
	err.name = 'Canceled';
	return err;
}

export type CloudHostOs = 'linux' | 'macos' | 'windows';

export interface CloudHostTarget {
	readonly authority: string;
	readonly alias: string;
	readonly os: CloudHostOs;
	readonly effectiveSshConfigPath?: string;
	readonly strictHostKeyChecking?: 'yes' | 'accept-new' | 'no';
	readonly remoteHome?: string;
	readonly sshExecutable?: string;
}

export interface RemoteEngineProbeResult {
	readonly target: CloudHostTarget;
	readonly ok: boolean;
	readonly os: CloudHostOs;
	readonly remoteHome?: string;
	/** Maps engine short id (e.g. 'claude', 'codex', 'antigravity') to its resolved remote executable path. */
	readonly executables: Readonly<Record<string, string>>;
	readonly checkedAt: number;
	readonly error?: string;
}

export interface RemotePortForwardHandle {
	readonly localPort: number;
	readonly localUrl: string;
	dispose(): void;
}

export const CLOUD_PROJECT_SCHEME = 'aexus-ssh';

/** Known Coding Agent binary names keyed by short engine id. */
export const REMOTE_ENGINE_BINARIES: Readonly<Record<string, string>> = {
	claude: 'claude',
	codex: 'codex',
	kilo: 'kilo',
	opencode: 'opencode',
	dsh: 'dsh',
	antigravity: 'agy',
	cline: 'cline',
	pi: 'pi',
};

/** Env keys that are safe and intentional to forward from an engine runtime to a remote agent process. */
const FORWARDABLE_REMOTE_ENV_KEYS = new Set<string>([
	'MAX_THINKING_TOKENS',
	'CLAUDE_CODE_DISABLE_THINKING',
	'KILO_SERVER_USERNAME',
	'KILO_SERVER_PASSWORD',
	'KILO_PERMISSION',
	'OPENCODE_SERVER_USERNAME',
	'OPENCODE_SERVER_PASSWORD',
	'OPENCODE_PERMISSION',
	'CLINE_PROVIDER',
	'CLINE_API_KEY',
	'CLINE_MODEL',
	'NO_COLOR',
	'TERM',
]);

const HOST_CONTEXT_TTL_MS = 15_000;
const ENGINE_PROBE_OK_TTL_MS = 30_000;
const ENGINE_PROBE_ERR_TTL_MS = 4_000;
const REMOTE_FILE_CACHE_TTL_MS = 12_000;
const REMOTE_REALPATH_CACHE_TTL_MS = 30_000;

interface CacheItem<T> {
	readonly value: T;
	readonly expiresAt: number;
}

const hostTargetCache = new Map<string, CacheItem<CloudHostTarget>>();
const remoteProbeCache = new Map<string, CacheItem<RemoteEngineProbeResult>>();
const remoteProbePending = new Map<string, Promise<RemoteEngineProbeResult>>();
const remoteFileCache = new Map<string, CacheItem<string | undefined>>();
const remoteRealpathCache = new Map<string, CacheItem<string | undefined>>();
let cacheEpoch = 0;

export function normalizeCloudAuthority(authority: string): string {
	return authority.trim().toLowerCase();
}

export function normalizeCloudProjectUriString(uri: UriLike): string {
	const cleanedPath = (uri.path || '/').replace(/\/+$/, '') || '/';
	const withFn = (uri as UriLike & { with?: (change: { path?: string }) => UriLike }).with;
	if (typeof withFn === 'function') {
		return withFn.call(uri, { path: cleanedPath }).toString();
	}
	const encodedPath = cleanedPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
	return `${uri.scheme}://${uri.authority}${encodedPath.startsWith('/') ? encodedPath : `/${encodedPath}`}`;
}

export function isCloudUri<T extends UriLike>(uri: T | undefined): uri is T & { readonly scheme: typeof CLOUD_PROJECT_SCHEME } {
	return Boolean(uri && uri.scheme === CLOUD_PROJECT_SCHEME && uri.authority.trim().length > 0);
}

export function parseCloudProjectUri(raw: string | undefined): ParsedCloudProjectUri | undefined {
	if (!raw?.trim()) {
		return undefined;
	}
	try {
		const url = new URL(raw);
		if (url.protocol !== `${CLOUD_PROJECT_SCHEME}:` || !url.host.trim()) {
			return undefined;
		}
		let decodedPath: string;
		try {
			decodedPath = decodeURIComponent(url.pathname || '/');
		} catch {
			decodedPath = url.pathname || '/';
		}
		return {
			scheme: CLOUD_PROJECT_SCHEME,
			authority: url.host,
			path: decodedPath || '/',
			raw,
		};
	} catch {
		return undefined;
	}
}

export function isLegacyCloudBridgeCwd(cwd: string | undefined): boolean {
	if (!cwd) {
		return false;
	}
	const normalized = cwd.replace(/\\/g, '/');
	return normalized.includes('/.aexus-code/cloud-workspaces/');
}

export function posixQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function psSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

export function encodePowerShellCommand(script: string): string {
	const utf8NoBomSetup = `$utf8=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $OutputEncoding=$utf8;`;
	return Buffer.from(`${utf8NoBomSetup} ${script}`, 'utf16le').toString('base64');
}

export function toRemoteNativePath(rawUriPath: string, hostOs: CloudHostOs, remoteHome?: string): string {
	let cleaned = (rawUriPath || '/').trim();
	if (!cleaned) {
		cleaned = '/';
	}
	// Expand leading `~` or `/~` when remoteHome is known
	if (remoteHome?.trim()) {
		const homeNorm = remoteHome.trim().replace(/\\/g, '/').replace(/\/+$/, '');
		if (cleaned === '~' || cleaned === '/~') {
			cleaned = homeNorm.startsWith('/') ? homeNorm : `/${homeNorm}`;
		} else if (cleaned.startsWith('~/') || cleaned.startsWith('/~/')) {
			const tail = cleaned.startsWith('/~/') ? cleaned.slice(3) : cleaned.slice(2);
			const prefix = homeNorm.startsWith('/') ? homeNorm : `/${homeNorm}`;
			cleaned = `${prefix}/${tail}`;
		}
	}
	if (hostOs === 'windows') {
		const fwd = cleaned.replace(/\\/g, '/');
		if (fwd === '/') {
			return 'C:\\';
		}
		if (/^\/\/[^/]+/.test(fwd)) {
			return fwd.replace(/\//g, '\\');
		}
		const m = /^\/?([A-Za-z]:(?:\/.*)?)$/.exec(fwd);
		if (m) {
			const body = m[1].length === 2 ? `${m[1]}/` : m[1];
			return body.replace(/\//g, '\\');
		}
		return fwd.replace(/\//g, '\\');
	}
	const posixNorm = path.posix.normalize(cleaned.startsWith('/') ? cleaned : `/${cleaned}`);
	return posixNorm.length > 1 && posixNorm.endsWith('/') ? posixNorm.slice(0, -1) : posixNorm;
}

export function normalizeRemoteCwdForCompare(cwd: string, hostOs: CloudHostOs): string {
	const trimmed = cwd.trim();
	if (hostOs === 'windows') {
		const normalized = trimmed.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
		return /^[a-z]:$/.test(normalized) ? `${normalized}\\` : normalized;
	}
	const posixNorm = path.posix.normalize(trimmed.replace(/\\/g, '/'));
	return posixNorm.length > 1 && posixNorm.endsWith('/') ? posixNorm.slice(0, -1) : posixNorm;
}

/**
 * Encodes a project working directory into Claude Code's canonical `~/.claude/projects/<slug>` folder name.
 */
export function encodeClaudeProjectSlug(cwd: string): string {
	const trimmed = cwd.trim().replace(/[\\/]+$/, '') || (cwd.includes('\\') ? cwd.trim() : '/');
	return trimmed.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Encodes a project working directory into Pi's canonical `~/.pi/agent/sessions/--<slug>--` folder name.
 */
export function encodePiProjectSlug(cwd: string): string {
	const stripped = cwd.trim().replace(/[\\/]+$/, '').replace(/^[\\/]+/, '');
	return `--${stripped.replace(/[\\/:]/g, '-')}--`;
}

export function joinRemotePath(hostOs: CloudHostOs, ...segments: string[]): string {
	if (hostOs === 'windows') {
		return path.win32.join(...segments);
	}
	return path.posix.join(...segments);
}

export function remotePathToFileUrl(remoteNativePath: string, hostOs: CloudHostOs): string {
	const encodeSegments = (p: string): string => p.split('/').map((seg, idx) => (idx === 1 && hostOs === 'windows' && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');
	if (hostOs === 'windows') {
		const fwd = remoteNativePath.replace(/\\/g, '/');
		const prefixed = fwd.startsWith('/') ? fwd : `/${fwd}`;
		return `file://${encodeSegments(prefixed)}`;
	}
	const posixPath = remoteNativePath.startsWith('/') ? remoteNativePath : `/${remoteNativePath}`;
	return `file://${encodeSegments(posixPath)}`;
}

let cachedWinSshExecutable: string | undefined;
let cachedSecureMuxDir: string | undefined;

async function ensureSecureMuxDir(): Promise<string | undefined> {
	if (process.platform === 'win32') {
		return undefined;
	}
	if (cachedSecureMuxDir) {
		return cachedSecureMuxDir;
	}
	const myUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
	const uidTag = myUid !== undefined ? String(myUid) : 'u';
	// Reuse the exact same mux directory as AdeCloudHostNodeService so agent calls piggyback on warm SSH tunnels!
	const muxDir = `/tmp/aexus-cm-${uidTag}`;
	try {
		await fs.mkdir(muxDir, { recursive: true, mode: 0o700 });
		const st = await fs.lstat(muxDir);
		if (st.isDirectory() && !st.isSymbolicLink() && (myUid === undefined || st.uid === myUid)) {
			await fs.chmod(muxDir, 0o700).catch(() => undefined);
			cachedSecureMuxDir = muxDir;
			return muxDir;
		}
	} catch { /* Proceed without ControlMaster if muxDir cannot be secured. */ }
	return undefined;
}

async function detectDefaultSshExecutableAsync(): Promise<string> {
	try {
		const configured = cloudTransportBridge.getConfiguredSshExecutable?.()?.trim();
		if (configured) {
			return configured;
		}
	} catch { /* Unit test / standalone environment without bridge config. */ }
	if (process.platform !== 'win32') {
		return 'ssh';
	}
	if (cachedWinSshExecutable) {
		return cachedWinSshExecutable;
	}
	const sysRoot = process.env['SystemRoot'] || 'C:\\Windows';
	const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
	const progFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
	const candidates = [
		path.win32.join(sysRoot, 'System32', 'OpenSSH', 'ssh.exe'),
		path.win32.join(sysRoot, 'Sysnative', 'OpenSSH', 'ssh.exe'),
		path.win32.join(progFiles, 'OpenSSH', 'ssh.exe'),
		path.win32.join(progFiles, 'Git', 'usr', 'bin', 'ssh.exe'),
		path.win32.join(progFiles86, 'Git', 'usr', 'bin', 'ssh.exe'),
	];
	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
			cachedWinSshExecutable = candidate;
			return candidate;
		} catch { /* continue */ }
	}
	return 'ssh';
}

export function resolveDefaultSshExecutable(): string {
	try {
		const configured = cloudTransportBridge.getConfiguredSshExecutable?.()?.trim();
		if (configured) {
			return configured;
		}
	} catch { /* Unit test / standalone environment without bridge config. */ }
	if (process.platform === 'win32' && cachedWinSshExecutable) {
		return cachedWinSshExecutable;
	}
	return 'ssh';
}

export function clearCloudTransportCaches(authority?: string): void {
	cacheEpoch++;
	disposeAllRemoteControlBridges(authority);
	if (!authority) {
		hostTargetCache.clear();
		remoteProbeCache.clear();
		remoteProbePending.clear();
		remoteFileCache.clear();
		remoteRealpathCache.clear();
		return;
	}
	const norm = normalizeCloudAuthority(authority);
	hostTargetCache.delete(norm);
	remoteProbeCache.delete(norm);
	remoteProbePending.delete(norm);
	for (const cacheKey of [...remoteFileCache.keys()]) {
		if (cacheKey.startsWith(`${norm}|`)) {
			remoteFileCache.delete(cacheKey);
		}
	}
	for (const cacheKey of [...remoteRealpathCache.keys()]) {
		if (cacheKey.startsWith(`${norm}|`)) {
			remoteRealpathCache.delete(cacheKey);
		}
	}
}

export async function resolveCloudHostTarget(authority: string, forceRefresh = false): Promise<CloudHostTarget> {
	const norm = normalizeCloudAuthority(authority);
	const now = Date.now();
	const epochAtStart = cacheEpoch;
	if (!forceRefresh) {
		const cached = hostTargetCache.get(norm);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}
	}
	let sshInfo: CloudHostSshContext | undefined;
	try {
		sshInfo = await cloudTransportBridge.getCloudHostSshContext?.(authority);
	} catch {
		sshInfo = undefined;
	}
	const osKind: CloudHostOs = sshInfo?.os === 'windows' || sshInfo?.os === 'macos' || sshInfo?.os === 'linux'
		? sshInfo.os
		: 'linux';
	const sshExecutable = sshInfo?.sshExecutable?.trim() || await detectDefaultSshExecutableAsync();
	void ensureSecureMuxDir();
	const target: CloudHostTarget = {
		authority: norm,
		alias: sshInfo?.alias?.trim() || authority.trim(),
		os: osKind,
		effectiveSshConfigPath: sshInfo?.effectiveSshConfigPath?.trim() || undefined,
		strictHostKeyChecking: sshInfo?.strictHostKeyChecking,
		remoteHome: sshInfo?.remoteHome?.trim() || undefined,
		sshExecutable,
	};
	if (cacheEpoch === epochAtStart) {
		hostTargetCache.set(norm, { value: target, expiresAt: Date.now() + HOST_CONTEXT_TTL_MS });
	}
	return target;
}

export function extractForwardableRemoteEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!env) {
		return out;
	}
	for (const key of FORWARDABLE_REMOTE_ENV_KEYS) {
		const val = env[key];
		if (typeof val === 'string' && val.length > 0) {
			out[key] = val;
		}
	}
	return out;
}

/**
 * Builds POSIX remote PATH augmentation script fragment so user-installed CLIs
 * (npm-global, ~/.local/bin, nvm, volta, mise, cargo, opencode, homebrew) are
 * always discoverable even in non-interactive SSH shells.
 */
export function buildPosixPathAugmentSnippet(): string {
	return [
		`for _aex_d in "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/bin" "$HOME/.claude/local" "$HOME/.cargo/bin" "$HOME/.gemini/bin" "$HOME/.opencode/bin" "$HOME/.bun/bin" "$HOME/.local/share/pnpm" "$HOME/.yarn/bin" "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "/opt/homebrew/bin" "/usr/local/bin"; do`,
		`  [ -d "$_aex_d" ] && case ":$PATH:" in *":$_aex_d:"*) ;; *) PATH="$_aex_d:$PATH" ;; esac`,
		`done`,
		`if [ -d "$HOME/.nvm/versions/node" ]; then`,
		`  _aex_nvm=$(ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | sort -V 2>/dev/null | tail -n 1 || ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -n 1)`,
		`  [ -n "$_aex_nvm" ] && [ -d "$_aex_nvm" ] && case ":$PATH:" in *":$_aex_nvm:"*) ;; *) PATH="$_aex_nvm:$PATH" ;; esac`,
		`fi`,
		`export PATH`,
	].join('\n');
}

export interface RemoteExecOptions {
	readonly killOnStdinClose?: boolean;
	/**
	 * When set on a POSIX Cloud Host, hosts the remote agent inside a SIGHUP-immune persistent
	 * session (`tmux` when installed, falling back to detached `nohup`) with its own isolated
	 * POSIX session/process group (`setsid`) under `~/.aexus-code/remote-sessions/<id>` so laptop
	 * sleep or brief Wi-Fi/SSH drops do NOT terminate the running remote agent. Re-spawning with
	 * the same ID reattaches to its live output stream without launching a duplicate process.
	 */
	readonly persistentSessionId?: string;
	/**
	 * When true alongside `persistentSessionId`, only attaches to an already-existing live or
	 * recently finished persistent session without spawning a new process (exits with code 44 if
	 * no matching session exists on the remote host).
	 */
	readonly attachOnly?: boolean;
	/**
	 * 0-based byte offset into `out.log` when reattaching to an existing persistent remote session
	 * so already-delivered stdout lines are not replayed.
	 */
	readonly attachByteOffset?: number;
	/** Optional SSH ServerAliveInterval override in seconds (defaults to 20 for long-running engines). */
	readonly sshServerAliveIntervalSec?: number;
	/** Optional SSH ServerAliveCountMax override (defaults to 6 for long-running engines). */
	readonly sshServerAliveCountMax?: number;
}

export interface RemotePersistentSessionInfo {
	readonly id: string;
	readonly alive: boolean;
	readonly pid?: number;
	readonly pgid?: number;
	readonly exitCode?: number;
	readonly outBytes: number;
	readonly startedAt?: number;
}

export interface TerminateRemoteSessionOptions {
	/**
	 * When true (default — used on Recall / Stop / Cancel / Dispose), kills the ENTIRE remote
	 * process group (`-PGID`) AND walks all descendant processes recursively (`SIGTERM` -> `SIGKILL`)
	 * so GPU training / build / subshell child processes NEVER become runaway cloud zombies.
	 * When false (used on graceful turn completion), only stops the agent process itself so
	 * intentionally detached background jobs (e.g. `token block --watch-pid`) remain alive.
	 */
	readonly killTree?: boolean;
}

const systemResumeListeners = new Set<() => void>();

/**
 * Subscribe to OS resume / network recovery notifications forwarded from Electron main `powerMonitor`
 * so sleeping SSH reattach loops wake immediately instead of waiting out backoff intervals.
 */
export function onSystemResume(listener: () => void): { dispose(): void } {
	systemResumeListeners.add(listener);
	return {
		dispose: () => {
			systemResumeListeners.delete(listener);
		},
	};
}

/**
 * Wakes all sleeping SSH reattach loops and triggers immediate healing of any dropped
 * SSH reverse control bridges.
 */
export function notifySystemResume(): void {
	for (const listener of Array.from(systemResumeListeners)) {
		try {
			listener();
		} catch { /* Never let one listener break others. */ }
	}
	void healAllRemoteControlBridges();
}

export function sanitizePersistentSessionId(raw: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
	return (cleaned || 'session').slice(0, 64);
}

function fnv1aHash32Hex(input: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Computes a collision-resistant, deterministic, POSIX/tmux-safe session prefix shared identically
 * between the Electron renderer (Watchdog snapshots) and the extension host (SSH persistent sessions),
 * enabling post-reload reattach AND guaranteed full process-tree kill on Recall / Stop.
 */
export function buildRemotePersistentPrefix(engineId: string, scopeOrSessionId: string): string {
	const normEngine = engineId.trim().toLowerCase().replace(/^aexus-/, '').replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'agent';
	const rawKey = scopeOrSessionId.trim() || 'session';
	const safeHead = rawKey.replace(/[^A-Za-z0-9]+/g, '').slice(0, 10) || 's';
	const h1 = fnv1aHash32Hex(rawKey, 0x811c9dc5);
	const h2 = fnv1aHash32Hex(`${normEngine}:${rawKey}`, 0x9e3779b9);
	return sanitizePersistentSessionId(`${normEngine}-${safeHead}-${h1}${h2.slice(0, 4)}`);
}

/**
 * Pure POSIX sh helper functions that isolate a spawned command in its own process group (`setsid`
 * with `python3` / `perl` fallbacks for macOS & minimal Linux) and surgically kill a full process
 * group + recursive descendant tree without ever signalling the cleanup shell itself.
 */
function buildPosixProcessTreeHelpers(): string[] {
	return [
		`_aex_my_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' \\t\\r\\n' || true)`,
		`_aex_collect_tree() {`,
		`  _queue="$*"`,
		`  _seen=""`,
		`  _table=$(ps -eo pid=,ppid= 2>/dev/null || ps -o pid,ppid 2>/dev/null | tail -n +2 || true)`,
		`  while [ -n "$_queue" ]; do`,
		`    _next=""`,
		`    for _p in $_queue; do`,
		`      case "$_p" in ''|*[!0-9]*) continue ;; esac`,
		`      [ "$_p" = "$$" ] && continue`,
		`      case " $_seen " in *" $_p "*) continue ;; esac`,
		`      _seen="$_seen $_p"`,
		`      _kids=$(printf '%s\\n' "$_table" | while read -r _cp _cpp; do [ "$_cpp" = "$_p" ] && printf '%s ' "$_cp"; done)`,
		`      for _k in $_kids; do`,
		`        case " $_seen $_next " in *" $_k "*) continue ;; esac`,
		`        _next="$_next $_k"`,
		`      done`,
		`    done`,
		`    _queue="$_next"`,
		`  done`,
		`  printf '%s' "$_seen"`,
		`}`,
		`_aex_kill_pgid_and_tree() {`,
		`  _sig="$1"; shift`,
		`  _pgid="$1"; shift`,
		`  _roots="$*"`,
		`  if [ -n "$_pgid" ]; then`,
		`    case "$_pgid" in ''|*[!0-9]*) ;; *)`,
		`      if [ "$_pgid" -gt 1 ] 2>/dev/null && [ "$_pgid" != "$_aex_my_pgid" ]; then`,
		`        kill "-$_sig" -- "-$_pgid" 2>/dev/null || kill "-$_sig" "-$_pgid" 2>/dev/null || true`,
		`      fi`,
		`    ;; esac`,
		`  fi`,
		`  _tree=$(_aex_collect_tree $_roots)`,
		`  for _tp in $_tree $_roots; do`,
		`    case "$_tp" in ''|*[!0-9]*) continue ;; esac`,
		`    [ "$_tp" = "$$" ] && continue`,
		`    kill "-$_sig" "$_tp" 2>/dev/null || true`,
		`  done`,
		`}`,
		`_aex_any_alive() {`,
		`  for _ap in $*; do`,
		`    case "$_ap" in ''|*[!0-9]*) continue ;; esac`,
		`    [ "$_ap" = "$$" ] && continue`,
		`    if kill -0 "$_ap" 2>/dev/null; then return 0; fi`,
		`  done`,
		`  return 1`,
		`}`,
		`_aex_terminate_session_dir() {`,
		`  _sd="$1"`,
		`  _tm="$2"`,
		`  _kt="$3"`,
		`  _pid=""`,
		`  _pgid=""`,
		`  _rpid=""`,
		`  [ -f "$_sd/agent.pid" ] && _pid=$(tr -d ' \\t\\r\\n' < "$_sd/agent.pid" 2>/dev/null || true)`,
		`  [ -f "$_sd/agent.pgid" ] && _pgid=$(tr -d ' \\t\\r\\n' < "$_sd/agent.pgid" 2>/dev/null || true)`,
		`  [ -f "$_sd/runner.pid" ] && _rpid=$(tr -d ' \\t\\r\\n' < "$_sd/runner.pid" 2>/dev/null || true)`,
		`  if [ -n "$_pid" ]; then`,
		`    _live_pgid=$(ps -o pgid= -p "$_pid" 2>/dev/null | tr -d ' \\t\\r\\n' || true)`,
		`    if [ -n "$_live_pgid" ]; then _pgid="$_live_pgid"; fi`,
		`  fi`,
		`  if [ "$_kt" = "1" ]; then`,
		`    _aex_kill_pgid_and_tree TERM "$_pgid" $_pid $_rpid`,
		`    command -v tmux >/dev/null 2>&1 && [ -n "$_tm" ] && tmux kill-session -t "$_tm" 2>/dev/null || true`,
		`    _w=0`,
		`    while [ "$_w" -lt 4 ]; do`,
		`      _rem=$(_aex_collect_tree $_pid $_rpid)`,
		`      if ! _aex_any_alive $_rem $_pid $_rpid; then break; fi`,
		`      sleep 0.1`,
		`      _w=$((_w + 1))`,
		`    done`,
		`    _aex_kill_pgid_and_tree KILL "$_pgid" $_pid $_rpid`,
		`  else`,
		`    if [ -n "$_pid" ]; then`,
		`      kill -TERM "$_pid" 2>/dev/null || true`,
		`      _w=0`,
		`      while [ "$_w" -lt 3 ]; do`,
		`        kill -0 "$_pid" 2>/dev/null || break`,
		`        sleep 0.1`,
		`        _w=$((_w + 1))`,
		`      done`,
		`      kill -KILL "$_pid" 2>/dev/null || true`,
		`    fi`,
		`    [ -n "$_rpid" ] && kill -TERM "$_rpid" 2>/dev/null || true`,
		`    command -v tmux >/dev/null 2>&1 && [ -n "$_tm" ] && tmux kill-session -t "$_tm" 2>/dev/null || true`,
		`  fi`,
		`  rm -rf "$_sd" 2>/dev/null || true`,
		`}`,
	];
}

/**
 * Builds a POSIX `sh -c '...'` command that changes into `cwd`, augments PATH,
 * sets intentional env vars, and execs the remote agent CLI cleanly with zero
 * stdout pollution so stdio JSON-RPC / NDJSON framing stays pristine.
 */
export function buildPosixRemoteExecCommand(
	executable: string,
	args: readonly string[],
	cwd?: string,
	extraEnv?: Readonly<Record<string, string>>,
	options?: RemoteExecOptions,
): string {
	const lines: string[] = [buildPosixPathAugmentSnippet()];
	if (extraEnv) {
		for (const [k, v] of Object.entries(extraEnv)) {
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
				lines.push(`export ${k}=${posixQuote(v)}`);
			}
		}
		if (extraEnv.ADE_AGENT_TOKEN && extraEnv.ADE_REMOTE_CLI_BIN_DIR) {
			lines.push(`[ -d "$ADE_REMOTE_CLI_BIN_DIR" ] && export PATH="$ADE_REMOTE_CLI_BIN_DIR:$PATH"`);
		}
	}
	if (cwd?.trim()) {
		const qCwd = posixQuote(cwd.trim());
		lines.push(`cd -- ${qCwd} || { printf 'Remote directory not found or inaccessible: %s\\n' ${qCwd} >&2; exit 66; }`);
	}
	const cmdTokens = [posixQuote(executable), ...args.map(posixQuote)].join(' ');
	if (options?.killOnStdinClose) {
		// Isolate the remote child in its own process group (`setsid` with python3/perl fallback) so
		// when the SSH channel disconnects or stdin hits EOF, the ENTIRE process tree (not just the
		// top PID) is cleanly terminated with SIGTERM -> SIGKILL, preventing cloud zombie leaks.
		lines.push(
			...buildPosixProcessTreeHelpers(),
			`_aex_isolated=0`,
			`if command -v setsid >/dev/null 2>&1; then`,
			`  setsid ${cmdTokens} </dev/null &`,
			`  _aex_isolated=1`,
			`elif command -v python3 >/dev/null 2>&1; then`,
			`  python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' ${cmdTokens} </dev/null &`,
			`  _aex_isolated=1`,
			`elif command -v perl >/dev/null 2>&1; then`,
			`  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die $!' -- ${cmdTokens} </dev/null &`,
			`  _aex_isolated=1`,
			`else`,
			`  ${cmdTokens} </dev/null &`,
			`fi`,
			`_aex_pid=$!`,
			`if [ "$_aex_isolated" = "1" ]; then`,
			`  _aex_pgid="$_aex_pid"`,
			`else`,
			`  _aex_pgid=$(ps -o pgid= -p "$_aex_pid" 2>/dev/null | tr -d ' \\t\\r\\n' || true)`,
			`  [ -n "$_aex_pgid" ] || _aex_pgid="$_aex_pid"`,
			`fi`,
			`_aex_cleanup() { _live_pg=$(ps -o pgid= -p "$_aex_pid" 2>/dev/null | tr -d ' \\t\\r\\n' || true); _pg="\${_live_pg:-$_aex_pgid}"; _aex_kill_pgid_and_tree TERM "$_pg" "$_aex_pid"; sleep 0.25; _aex_kill_pgid_and_tree KILL "$_pg" "$_aex_pid"; }`,
			// POSIX shells redirect a background job's stdin from /dev/null before explicit redirections,
			// so duplicate the real SSH stdin to fd 3 first; otherwise the watchdog below would see EOF instantly.
			`exec 3<&0`,
			`trap '_aex_cleanup' EXIT TERM INT HUP`,
			`(cat <&3 >/dev/null 2>&1; _aex_cleanup) &`,
			`_aex_watch=$!`,
			`wait $_aex_pid`,
			`_aex_rc=$?`,
			`kill $_aex_watch 2>/dev/null || true`,
			`exit $_aex_rc`,
		);
	} else if (options?.persistentSessionId?.trim()) {
		// Persistent SIGHUP-immune remote session (tmux when available, detached nohup fallback) with
		// dedicated process-group isolation (`setsid`):
		// - SSH disconnects / laptop sleep tear down only the attach helpers while the remote agent
		//   keeps running uninterrupted.
		// - Re-invoking with the same persistentSessionId reattaches cleanly at `attachByteOffset`.
		// - Explicit Recall / Stop terminates the ENTIRE process group (`-PGID`) + recursive descendants.
		const safeId = sanitizePersistentSessionId(options.persistentSessionId);
		const byteStart = Math.max(0, Math.floor(options.attachByteOffset ?? 0)) + 1;
		const runnerLines: string[] = [
			'#!/bin/sh',
			`trap '' HUP`,
			`_aex_dir="$1"`,
			`printf '%s\\n' "$$" > "$_aex_dir/runner.pid"`,
			`date +%s > "$_aex_dir/started.at" 2>/dev/null || true`,
			buildPosixPathAugmentSnippet(),
		];
		if (extraEnv) {
			for (const [k, v] of Object.entries(extraEnv)) {
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
					runnerLines.push(`export ${k}=${posixQuote(v)}`);
				}
			}
			if (extraEnv.ADE_AGENT_TOKEN && extraEnv.ADE_REMOTE_CLI_BIN_DIR) {
				runnerLines.push(`[ -d "$ADE_REMOTE_CLI_BIN_DIR" ] && export PATH="$ADE_REMOTE_CLI_BIN_DIR:$PATH"`);
			}
		}
		if (cwd?.trim()) {
			const qCwd = posixQuote(cwd.trim());
			runnerLines.push(`cd -- ${qCwd} || { printf 'Remote directory not found or inaccessible: %s\\n' ${qCwd} >> "$_aex_dir/err.log"; printf '66\\n' > "$_aex_dir/exit.code.tmp" && mv -f "$_aex_dir/exit.code.tmp" "$_aex_dir/exit.code"; exit 66; }`);
		}
		runnerLines.push(
			`exec 4<>"$_aex_dir/in.fifo"`,
			`_aex_isolated=0`,
			`if command -v setsid >/dev/null 2>&1; then`,
			`  setsid ${cmdTokens} <&4 4>&- >> "$_aex_dir/out.log" 2>> "$_aex_dir/err.log" &`,
			`  _aex_isolated=1`,
			`elif command -v python3 >/dev/null 2>&1; then`,
			`  python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' ${cmdTokens} <&4 4>&- >> "$_aex_dir/out.log" 2>> "$_aex_dir/err.log" &`,
			`  _aex_isolated=1`,
			`elif command -v perl >/dev/null 2>&1; then`,
			`  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die $!' -- ${cmdTokens} <&4 4>&- >> "$_aex_dir/out.log" 2>> "$_aex_dir/err.log" &`,
			`  _aex_isolated=1`,
			`else`,
			`  ${cmdTokens} <&4 4>&- >> "$_aex_dir/out.log" 2>> "$_aex_dir/err.log" &`,
			`fi`,
			`_aex_child=$!`,
			`printf '%s\\n' "$_aex_child" > "$_aex_dir/agent.pid"`,
			`if [ "$_aex_isolated" = "1" ]; then`,
			`  _aex_pgid="$_aex_child"`,
			`else`,
			`  _aex_pgid=$(ps -o pgid= -p "$_aex_child" 2>/dev/null | tr -d ' \\t\\r\\n' || true)`,
			`  [ -n "$_aex_pgid" ] || _aex_pgid="$_aex_child"`,
			`fi`,
			`printf '%s\\n' "$_aex_pgid" > "$_aex_dir/agent.pgid"`,
			`wait "$_aex_child"`,
			`_aex_rc=$?`,
			`printf '%s\\n' "$_aex_rc" > "$_aex_dir/exit.code.tmp" && mv -f "$_aex_dir/exit.code.tmp" "$_aex_dir/exit.code"`,
			`exec 4>&- 2>/dev/null || true`,
			`exit "$_aex_rc"`,
		);
		const runnerScript = runnerLines.join('\n') + '\n';
		const attachEnvLines: string[] = [];
		if (extraEnv) {
			for (const [k, v] of Object.entries(extraEnv)) {
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
					attachEnvLines.push(`export ${k}=${posixQuote(v)}`);
				}
			}
		}
		const attachLines: string[] = [
			buildPosixPathAugmentSnippet(),
			...attachEnvLines,
			`_aex_base="\${AEXUS_REMOTE_SESSION_DIR:-$HOME/.aexus-code/remote-sessions}"`,
			`_aex_sdir="$_aex_base/${safeId}"`,
			`_aex_tmux="aex_${safeId}"`,
			`_aex_alive=0`,
			`if [ -f "$_aex_sdir/agent.pid" ]; then`,
			`  _aex_oldpid=$(tr -d ' \\t\\r\\n' < "$_aex_sdir/agent.pid" 2>/dev/null || true)`,
			`  if [ -n "$_aex_oldpid" ] && kill -0 "$_aex_oldpid" 2>/dev/null; then _aex_alive=1; fi`,
			`fi`,
			...(options.attachOnly
				? [
					`if [ "$_aex_alive" -eq 0 ] && [ ! -f "$_aex_sdir/exit.code" ]; then`,
					`  exit 44`,
					`fi`,
				]
				: [
					`mkdir -p "$_aex_sdir"`,
					`if [ "$_aex_alive" -eq 0 ] && [ ! -f "$_aex_sdir/exit.code" ]; then`,
					`  rm -f "$_aex_sdir/in.fifo" "$_aex_sdir/out.log" "$_aex_sdir/err.log" "$_aex_sdir/exit.code" "$_aex_sdir/exit.code.tmp" "$_aex_sdir/agent.pid" "$_aex_sdir/agent.pgid" "$_aex_sdir/runner.pid" "$_aex_sdir/started.at" "$_aex_sdir/run.sh"`,
					`  mkfifo "$_aex_sdir/in.fifo"`,
					`  : > "$_aex_sdir/out.log"`,
					`  : > "$_aex_sdir/err.log"`,
					`  printf '%s' ${posixQuote(runnerScript)} > "$_aex_sdir/run.sh"`,
					`  chmod 700 "$_aex_sdir/run.sh"`,
					`  command -v tmux >/dev/null 2>&1 && tmux kill-session -t "$_aex_tmux" 2>/dev/null || true`,
					`  if command -v tmux >/dev/null 2>&1 && tmux new-session -d -s "$_aex_tmux" -- sh "$_aex_sdir/run.sh" "$_aex_sdir" >/dev/null 2>&1; then`,
					`    :`,
					`  else`,
					`    nohup sh "$_aex_sdir/run.sh" "$_aex_sdir" </dev/null >/dev/null 2>&1 &`,
					`  fi`,
					`fi`,
				]),
			// Fast-path when reattaching to a persistent session that already completed while SSH was disconnected:
			// flush remaining bytes cleanly without opening in.fifo or spawning tail -f, and only delete $_aex_sdir
			// if stdout delivery actually succeeded (never lose undelivered output on broken SSH pipe!).
			`if [ -f "$_aex_sdir/exit.code" ]; then`,
			`  _aex_flush_ok=1`,
			`  if [ -f "$_aex_sdir/out.log" ]; then tail -c +${byteStart} "$_aex_sdir/out.log" || _aex_flush_ok=0; fi`,
			`${byteStart <= 1 ? `  [ -f "$_aex_sdir/err.log" ] && cat "$_aex_sdir/err.log" >&2 2>/dev/null || true` : `  :`}`,
			`  _aex_rc=$(tr -d ' \\t\\r\\n' < "$_aex_sdir/exit.code" 2>/dev/null || printf '0')`,
			`  if [ "$_aex_flush_ok" = "1" ]; then rm -rf "$_aex_sdir" 2>/dev/null || true; fi`,
			`  exit "\${_aex_rc:-0}"`,
			`fi`,
			`printf '%s\\n' "$$" > "$_aex_sdir/attach.pid" 2>/dev/null || true`,
			`[ -p "$_aex_sdir/in.fifo" ] || mkfifo "$_aex_sdir/in.fifo" 2>/dev/null || true`,
			`[ -f "$_aex_sdir/out.log" ] || : > "$_aex_sdir/out.log"`,
			`[ -f "$_aex_sdir/err.log" ] || : > "$_aex_sdir/err.log"`,
			`exec 3<&0`,
			`_aex_tout=""`,
			`_aex_terr=""`,
			`_aex_tin=""`,
			`trap 'kill $_aex_tout $_aex_terr $_aex_tin 2>/dev/null || true' EXIT TERM INT HUP`,
			`tail -c +${byteStart} -f "$_aex_sdir/out.log" &`,
			`_aex_tout=$!`,
			`${byteStart > 1 ? `tail -n 0 -f "$_aex_sdir/err.log" >&2 &` : `tail -c +1 -f "$_aex_sdir/err.log" >&2 &`}`,
			`_aex_terr=$!`,
			`(cat <&3 > "$_aex_sdir/in.fifo" 2>/dev/null) >/dev/null 2>&1 &`,
			`_aex_tin=$!`,
			`_aex_wait_ticks=0`,
			`_aex_boot_ticks=0`,
			`_aex_detached=0`,
			`while [ ! -f "$_aex_sdir/exit.code" ]; do`,
			`  if ! kill -0 "$_aex_tout" 2>/dev/null; then`,
			`    _aex_detached=1`,
			`    break`,
			`  fi`,
			`  if [ -f "$_aex_sdir/agent.pid" ]; then`,
			`    _aex_curpid=$(tr -d ' \\t\\r\\n' < "$_aex_sdir/agent.pid" 2>/dev/null || true)`,
			`    if [ -n "$_aex_curpid" ] && ! kill -0 "$_aex_curpid" 2>/dev/null && [ ! -f "$_aex_sdir/exit.code" ]; then`,
			`      _aex_wait_ticks=$((_aex_wait_ticks + 1))`,
			`      [ "$_aex_wait_ticks" -ge 10 ] && break`,
			`    fi`,
			`  else`,
			`    _aex_boot_ticks=$((_aex_boot_ticks + 1))`,
			`    [ "$_aex_boot_ticks" -ge 100 ] && break`,
			`  fi`,
			`  sleep 0.1`,
			`done`,
			`sleep 0.15`,
			`_aex_tout_alive=0`,
			`kill -0 "$_aex_tout" 2>/dev/null && _aex_tout_alive=1`,
			`kill $_aex_tout $_aex_terr $_aex_tin 2>/dev/null || true`,
			`kill -9 $_aex_tin 2>/dev/null || true`,
			`wait $_aex_tout $_aex_terr 2>/dev/null || true`,
			`_aex_rc=0`,
			`[ -f "$_aex_sdir/exit.code" ] && _aex_rc=$(tr -d ' \\t\\r\\n' < "$_aex_sdir/exit.code" 2>/dev/null || printf '0')`,
			`_aex_cur_attach=$(tr -d ' \\t\\r\\n' < "$_aex_sdir/attach.pid" 2>/dev/null || true)`,
			// Only remove $_aex_sdir when stdout tail was still alive (no SIGPIPE drop) AND this attach still owns attach.pid!
			`if [ "$_aex_detached" = "0" ] && [ "$_aex_tout_alive" = "1" ] && [ "$_aex_cur_attach" = "$$" ]; then`,
			`  rm -rf "$_aex_sdir" 2>/dev/null || true`,
			`fi`,
			`exit "\${_aex_rc:-0}"`,
		];
		return `sh -c ${posixQuote(attachLines.join('\n'))}`;
	} else {
		lines.push(`exec ${cmdTokens}`);
	}
	return `sh -c ${posixQuote(lines.join('\n'))}`;
}

/**
 * Builds a Windows PowerShell `-EncodedCommand` invocation that sets UTF-8
 * (without BOM) stdio, augments PATH with standard Windows CLI locations,
 * unwraps npm `.cmd` Node shims (preventing cmd.exe newline truncation),
 * sets `cwd`, and runs the native Windows CLI directly.
 */
export function buildWindowsRemoteExecCommand(
	executable: string,
	args: readonly string[],
	cwd?: string,
	extraEnv?: Readonly<Record<string, string>>,
	options?: { readonly killOnStdinClose?: boolean },
): string {
	const psLines: string[] = [
		`$ErrorActionPreference = 'Stop'`,
		`$_dirs = @(`,
		`  (Join-Path $env:APPDATA 'npm'),`,
		`  (Join-Path $env:USERPROFILE '.local\\bin'),`,
		`  (Join-Path $env:USERPROFILE '.npm-global\\bin'),`,
		`  (Join-Path $env:USERPROFILE '.cargo\\bin'),`,
		`  (Join-Path $env:USERPROFILE '.gemini\\bin'),`,
		`  (Join-Path $env:USERPROFILE '.opencode\\bin'),`,
		`  (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links'),`,
		`  (Join-Path $env:LOCALAPPDATA 'Programs\\claude'),`,
		`  (Join-Path $env:LOCALAPPDATA 'Programs\\DeepSeek Harness'),`,
		`  (Join-Path $env:ProgramFiles 'nodejs')`,
		`) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }`,
		`if ($_dirs.Count -gt 0) { $env:Path = (($_dirs -join ';') + ';' + $env:Path) }`,
	];
	if (extraEnv) {
		for (const [k, v] of Object.entries(extraEnv)) {
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
				psLines.push(`$env:${k} = ${psSingleQuote(v)}`);
			}
		}
		if (extraEnv.ADE_AGENT_TOKEN && extraEnv.ADE_REMOTE_CLI_BIN_DIR) {
			psLines.push(`if (Test-Path -LiteralPath $env:ADE_REMOTE_CLI_BIN_DIR) { $env:Path = "$env:ADE_REMOTE_CLI_BIN_DIR;$env:Path" }`);
		}
	}
	if (cwd?.trim()) {
		psLines.push(`Set-Location -LiteralPath ${psSingleQuote(cwd.trim())}`);
	}
	if (options?.killOnStdinClose) {
		// Background watcher terminates the process tree cleanly if the SSH channel disconnects
		psLines.push(
			`[void][Threading.Tasks.Task]::Run([Action]{ try { $s = [Console]::OpenStandardInput(); $b = New-Object byte[] 256; while ($s.Read($b, 0, $b.Length) -gt 0) {} } catch {} try { [Diagnostics.Process]::GetCurrentProcess().Kill($true) } catch { [Environment]::Exit(0) } })`,
		);
	}
	const psArgsArray = args.length > 0
		? `@(${args.map(psSingleQuote).join(', ')})`
		: '@()';
	psLines.push(
		`$_exe = ${psSingleQuote(executable)}`,
		`$_args = ${psArgsArray}`,
		`if (-not [IO.Path]::IsPathRooted($_exe)) {`,
		`  $_cmd = Get-Command $_exe -ErrorAction SilentlyContinue | Select-Object -First 1`,
		`  if ($_cmd -and $_cmd.Source) { $_exe = $_cmd.Source }`,
		`}`,
		`if ($_exe -match '\\.(cmd|bat)$' -and (Test-Path -LiteralPath $_exe)) {`,
		`  $_raw = Get-Content -LiteralPath $_exe -Raw -ErrorAction SilentlyContinue`,
		`  if ($_raw -match '"%(?:~)?dp0%?\\\\([^"]+\\.(?:c|m)?js)"\\s+%\\*') {`,
		`    $_js = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $_exe) $Matches[1]))`,
		`    if (Test-Path -LiteralPath $_js) {`,
		`      $_sibNode = Join-Path (Split-Path -Parent $_exe) 'node.exe'`,
		`      $_node = if (Test-Path -LiteralPath $_sibNode) { $_sibNode } else { (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source }`,
		`      if ($_node) { & $_node $_js @_args; exit $LASTEXITCODE }`,
		`    }`,
		`  }`,
		`}`,
		`& $_exe @_args`,
		`exit $LASTEXITCODE`,
	);
	return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(psLines.join('; '))}`;
}

export async function buildSshBaseArgs(
	target: CloudHostTarget,
	extraArgs: readonly string[] = [],
	options?: { readonly useMux?: boolean },
): Promise<string[]> {
	const sshArgs: string[] = [];
	if (target.effectiveSshConfigPath) {
		sshArgs.push('-F', target.effectiveSshConfigPath);
	}
	sshArgs.push(
		'-T',
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=10',
		'-o', 'ServerAliveInterval=15',
		'-o', 'ServerAliveCountMax=3',
		'-o', 'TCPKeepAlive=yes',
	);
	if (options?.useMux === false) {
		sshArgs.push('-o', 'ControlMaster=no');
	} else {
		const muxDir = await ensureSecureMuxDir();
		if (muxDir) {
			sshArgs.push(
				'-o', 'ControlMaster=auto',
				'-o', `ControlPath=${muxDir}/%C`,
				'-o', 'ControlPersist=120s',
			);
		}
	}
	if (target.strictHostKeyChecking === 'yes' || target.strictHostKeyChecking === 'accept-new' || target.strictHostKeyChecking === 'no') {
		sshArgs.push('-o', `StrictHostKeyChecking=${target.strictHostKeyChecking}`);
	}
	if (extraArgs.length > 0) {
		sshArgs.push(...extraArgs);
	}
	return sshArgs;
}

function buildLocalSshEnv(): NodeJS.ProcessEnv {
	return {
		...stripLocalAdeControlEnv(process.env),
		SSH_ASKPASS_REQUIRE: 'never',
		DISPLAY: '',
	};
}

/**
 * Spawns a Coding Agent CLI natively on the remote SSH Cloud Host, returning a
 * standard `ChildProcessWithoutNullStreams` whose stdin/stdout/stderr stream
 * directly to and from the remote process (via `engineProcess.js` so IPC crash
 * teardown cleans up the SSH channel automatically).
 */
export function spawnRemoteEngine(
	target: CloudHostTarget,
	executable: string,
	args: readonly string[],
	cwd?: string,
	env?: NodeJS.ProcessEnv,
	options?: RemoteExecOptions,
): cp.ChildProcessWithoutNullStreams {
	const remoteEnv: Record<string, string> = { ...extractForwardableRemoteEnv(env) };
	if (env?.ADE_AGENT_TOKEN?.trim()) {
		const endpoint = env.ADE_CONTROL_ENDPOINT?.trim();
		const bridgeFile = env.ADE_CONTROL_BRIDGE_FILE?.trim();
		const remoteBinDir = env.ADE_REMOTE_CLI_BIN_DIR?.trim();
		if (endpoint || bridgeFile) {
			remoteEnv.ADE_AGENT_TOKEN = env.ADE_AGENT_TOKEN.trim();
			if (endpoint) { remoteEnv.ADE_CONTROL_ENDPOINT = endpoint; }
			if (bridgeFile) { remoteEnv.ADE_CONTROL_BRIDGE_FILE = bridgeFile; }
			if (remoteBinDir) { remoteEnv.ADE_REMOTE_CLI_BIN_DIR = remoteBinDir; }
		}
	}
	const remoteCmd = target.os === 'windows'
		? buildWindowsRemoteExecCommand(executable, args, cwd, remoteEnv, options)
		: buildPosixRemoteExecCommand(executable, args, cwd, remoteEnv, options);
	const sshExe = target.sshExecutable || resolveDefaultSshExecutable();
	const sshArgs: string[] = [];
	if (target.effectiveSshConfigPath) {
		sshArgs.push('-F', target.effectiveSshConfigPath);
	}
	const aliveInterval = Math.max(5, Math.min(120, Math.round(options?.sshServerAliveIntervalSec ?? 20)));
	const aliveCountMax = Math.max(3, Math.min(60, Math.round(options?.sshServerAliveCountMax ?? 6)));
	sshArgs.push(
		'-T',
		'-o', 'BatchMode=yes',
		'-o', 'ConnectTimeout=15',
		'-o', `ServerAliveInterval=${aliveInterval}`,
		'-o', `ServerAliveCountMax=${aliveCountMax}`,
		'-o', 'TCPKeepAlive=yes',
	);
	if (cachedSecureMuxDir) {
		sshArgs.push(
			'-o', 'ControlMaster=auto',
			'-o', `ControlPath=${cachedSecureMuxDir}/%C`,
			'-o', 'ControlPersist=600s',
		);
	} else {
		void ensureSecureMuxDir();
	}
	if (target.strictHostKeyChecking === 'yes' || target.strictHostKeyChecking === 'accept-new' || target.strictHostKeyChecking === 'no') {
		sshArgs.push('-o', `StrictHostKeyChecking=${target.strictHostKeyChecking}`);
	}
	sshArgs.push('--', target.alias, remoteCmd);

	return cp.spawn(process.execPath, [path.join(__dirname, 'engineProcess.js'), sshExe, ...sshArgs], {
		cwd: os.homedir(),
		env: { ...buildLocalSshEnv(), ELECTRON_RUN_AS_NODE: '1' },
		windowsHide: true,
		detached: process.platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
	}) as cp.ChildProcessWithoutNullStreams;
}

/**
 * Explicitly terminates a persistent remote POSIX session (`tmux` or detached `nohup`)
 * created via `spawnRemoteEngine(..., { persistentSessionId })` and cleans up its session directory.
 *
 * By default (`killTree: true`), kills the ENTIRE remote process group (`-PGID`) AND all recursive
 * descendants (`SIGTERM` -> `SIGKILL`) so GPU training / build / subshell child processes cannot
 * survive Recall or Stop as runaway cloud zombies. Pass `{ killTree: false }` on normal turn
 * completion so intentionally detached background jobs (e.g. `token block --watch-pid`) survive.
 */
export async function terminateRemotePersistentSession(
	target: CloudHostTarget,
	persistentSessionId: string,
	options?: TerminateRemoteSessionOptions,
): Promise<void> {
	if (target.os === 'windows' || !persistentSessionId.trim()) {
		return;
	}
	const safeId = sanitizePersistentSessionId(persistentSessionId);
	const killTreeFlag = options?.killTree === false ? '0' : '1';
	const script = [
		buildPosixPathAugmentSnippet(),
		...buildPosixProcessTreeHelpers(),
		`_aex_base="\${AEXUS_REMOTE_SESSION_DIR:-$HOME/.aexus-code/remote-sessions}"`,
		`_aex_sdir="$_aex_base/${safeId}"`,
		`_aex_tmux="aex_${safeId}"`,
		`_aex_terminate_session_dir "$_aex_sdir" "$_aex_tmux" ${killTreeFlag}`,
	].join('\n');
	await runSshCommand(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 12_000 }).catch(() => undefined);
}

/**
 * Terminates EVERY persistent remote POSIX session whose ID starts with `idPrefix` (e.g. from
 * `buildRemotePersistentPrefix(engineId, sessionId)`), including its full process group and
 * descendant tree. Works cleanly even after an Electron window reload when ephemeral local turn
 * IDs are no longer in memory!
 */
export async function terminateRemotePersistentSessionsByPrefix(
	target: CloudHostTarget,
	idPrefix: string,
	options?: TerminateRemoteSessionOptions,
): Promise<void> {
	if (target.os === 'windows' || !idPrefix.trim()) {
		return;
	}
	const safePrefix = sanitizePersistentSessionId(idPrefix);
	if (safePrefix.length < 4) {
		return;
	}
	const killTreeFlag = options?.killTree === false ? '0' : '1';
	const script = [
		buildPosixPathAugmentSnippet(),
		...buildPosixProcessTreeHelpers(),
		`_aex_base="\${AEXUS_REMOTE_SESSION_DIR:-$HOME/.aexus-code/remote-sessions}"`,
		`if [ -d "$_aex_base" ]; then`,
		`  for _aex_d in "$_aex_base/${safePrefix}" "$_aex_base/${safePrefix}"-*; do`,
		`    [ -d "$_aex_d" ] || continue`,
		`    _aex_name=$(basename "$_aex_d")`,
		`    _aex_terminate_session_dir "$_aex_d" "aex_$_aex_name" ${killTreeFlag}`,
		`  done`,
		`fi`,
		`if command -v tmux >/dev/null 2>&1; then`,
		`  for _aex_ts in $(tmux list-sessions -F '#{session_name}' 2>/dev/null || true); do`,
		`    case "$_aex_ts" in`,
		`      "aex_${safePrefix}"|"aex_${safePrefix}"-*) tmux kill-session -t "$_aex_ts" 2>/dev/null || true ;;`,
		`    esac`,
		`  done`,
		`fi`,
	].join('\n');
	await runSshCommand(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 12_000 }).catch(() => undefined);
}

/**
 * Probes all remote persistent sessions matching `idPrefix` (`<prefix>` or `<prefix>-*`) on a POSIX
 * Cloud Host, returning liveness, PID/PGID, exit code (if finished while disconnected), and `out.log`
 * byte size so window reload recovery can seamlessly reattach instead of spawning duplicate work.
 */
export async function inspectRemotePersistentSessionsByPrefix(
	target: CloudHostTarget,
	idPrefix: string,
): Promise<readonly RemotePersistentSessionInfo[]> {
	if (target.os === 'windows' || !idPrefix.trim()) {
		return [];
	}
	const safePrefix = sanitizePersistentSessionId(idPrefix);
	if (safePrefix.length < 4) {
		return [];
	}
	const script = [
		`_aex_base="\${AEXUS_REMOTE_SESSION_DIR:-$HOME/.aexus-code/remote-sessions}"`,
		`[ -d "$_aex_base" ] || exit 0`,
		`for _aex_d in "$_aex_base/${safePrefix}" "$_aex_base/${safePrefix}"-*; do`,
		`  [ -d "$_aex_d" ] || continue`,
		`  _id=$(basename "$_aex_d")`,
		`  _pid=""`,
		`  _pgid=""`,
		`  _rc=""`,
		`  _started=""`,
		`  _alive=0`,
		`  [ -f "$_aex_d/agent.pid" ] && _pid=$(tr -d ' \\t\\r\\n' < "$_aex_d/agent.pid" 2>/dev/null || true)`,
		`  [ -f "$_aex_d/agent.pgid" ] && _pgid=$(tr -d ' \\t\\r\\n' < "$_aex_d/agent.pgid" 2>/dev/null || true)`,
		`  [ -f "$_aex_d/exit.code" ] && _rc=$(tr -d ' \\t\\r\\n' < "$_aex_d/exit.code" 2>/dev/null || true)`,
		`  [ -f "$_aex_d/started.at" ] && _started=$(tr -d ' \\t\\r\\n' < "$_aex_d/started.at" 2>/dev/null || true)`,
		`  if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then _alive=1; fi`,
		`  _bytes=0`,
		`  if [ -f "$_aex_d/out.log" ]; then _bytes=$(wc -c < "$_aex_d/out.log" 2>/dev/null | tr -d ' \\t\\r\\n' || printf '0'); fi`,
		`  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$_id" "$_alive" "$_pid" "$_pgid" "$_rc" "\${_bytes:-0}" "$_started"`,
		`done`,
	].join('\n');
	const res = await runSshCommand(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 8_000 }).catch(() => undefined);
	if (!res || res.code !== 0) {
		return [];
	}
	const out: RemotePersistentSessionInfo[] = [];
	for (const line of res.stdout.toString('utf8').split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		const [id, aliveStr, pidStr, pgidStr, rcStr, bytesStr, startedStr] = line.split('\t');
		if (!id) {
			continue;
		}
		const pid = pidStr && /^\d+$/.test(pidStr) ? Number.parseInt(pidStr, 10) : undefined;
		const pgid = pgidStr && /^\d+$/.test(pgidStr) ? Number.parseInt(pgidStr, 10) : undefined;
		const exitCode = rcStr && /^-?\d+$/.test(rcStr) ? Number.parseInt(rcStr, 10) : undefined;
		const outBytes = bytesStr && /^\d+$/.test(bytesStr) ? Number.parseInt(bytesStr, 10) : 0;
		const startedAt = startedStr && /^\d+$/.test(startedStr) ? Number.parseInt(startedStr, 10) * 1000 : undefined;
		out.push({
			id,
			alive: aliveStr === '1',
			...(pid !== undefined ? { pid } : {}),
			...(pgid !== undefined ? { pgid } : {}),
			...(exitCode !== undefined ? { exitCode } : {}),
			outBytes,
			...(startedAt !== undefined ? { startedAt } : {}),
		});
	}
	// Prefer alive sessions first, then newest startedAt
	out.sort((a, b) => Number(b.alive) - Number(a.alive) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
	return out;
}

export async function runSshCommand(
	target: CloudHostTarget,
	remoteCommand: string,
	options?: {
		readonly stdin?: Buffer | string;
		readonly timeoutMs?: number;
		readonly token?: CancellationTokenLike;
		readonly useMux?: boolean;
	},
): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> {
	const timeoutMs = options?.timeoutMs ?? 20_000;
	const sshExe = target.sshExecutable || resolveDefaultSshExecutable();
	const sshArgs = await buildSshBaseArgs(target, [], { useMux: options?.useMux });
	sshArgs.push('--', target.alias, remoteCommand);

	return new Promise((resolve, reject) => {
		if (options?.token?.isCancellationRequested) {
			reject(makeCancellationError());
			return;
		}
		const child = cp.spawn(sshExe, sshArgs, {
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: buildLocalSshEnv(),
		});
		child.stdin.on('error', () => { /* Ignore EPIPE if SSH exits early. */ });

		const outChunks: Buffer[] = [];
		let outBytes = 0;
		const maxOutputBytes = 32 * 1024 * 1024;
		let stderr = '';
		let settled = false;

		const cleanup = () => {
			clearTimeout(timer);
			cancelDisp?.dispose();
		};

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				cleanup();
				try { child.kill('SIGKILL'); } catch { /* ignore */ }
				reject(new Error(`SSH command timed out after ${timeoutMs}ms (${target.alias})`));
			}
		}, timeoutMs);

		const cancelDisp = options?.token?.onCancellationRequested(() => {
			if (!settled) {
				settled = true;
				cleanup();
				try { child.kill('SIGTERM'); } catch { /* ignore */ }
				reject(makeCancellationError());
			}
		});

		child.stdout.on('data', (chunk: Buffer) => {
			if (outBytes < maxOutputBytes) {
				const remaining = maxOutputBytes - outBytes;
				const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
				outChunks.push(slice);
				outBytes += slice.length;
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });

		child.once('error', err => {
			if (!settled) {
				settled = true;
				cleanup();
				reject(err);
			}
		});

		child.once('close', code => {
			if (!settled) {
				settled = true;
				cleanup();
				resolve({
					code: code ?? 1,
					stdout: Buffer.concat(outChunks),
					stderr: stderr.trim(),
				});
			}
		});

		if (options?.stdin !== undefined) {
			child.stdin.end(options.stdin);
		} else {
			child.stdin.end();
		}
	});
}

export async function captureRemoteEngine(
	target: CloudHostTarget,
	executable: string,
	args: readonly string[],
	token?: CancellationTokenLike,
	cwd?: string,
	env?: NodeJS.ProcessEnv,
	timeoutMs = 20_000,
): Promise<string> {
	const remoteEnv: Record<string, string> = { ...extractForwardableRemoteEnv(env) };
	if (env?.ADE_AGENT_TOKEN?.trim()) {
		const endpoint = env.ADE_CONTROL_ENDPOINT?.trim();
		const bridgeFile = env.ADE_CONTROL_BRIDGE_FILE?.trim();
		const remoteBinDir = env.ADE_REMOTE_CLI_BIN_DIR?.trim();
		if (endpoint || bridgeFile) {
			remoteEnv.ADE_AGENT_TOKEN = env.ADE_AGENT_TOKEN.trim();
			if (endpoint) { remoteEnv.ADE_CONTROL_ENDPOINT = endpoint; }
			if (bridgeFile) { remoteEnv.ADE_CONTROL_BRIDGE_FILE = bridgeFile; }
			if (remoteBinDir) { remoteEnv.ADE_REMOTE_CLI_BIN_DIR = remoteBinDir; }
		}
	}
	const remoteCmd = target.os === 'windows'
		? buildWindowsRemoteExecCommand(executable, args, cwd, remoteEnv)
		: buildPosixRemoteExecCommand(executable, args, cwd, remoteEnv);
	const res = await runSshCommand(target, remoteCmd, { token, timeoutMs });
	if (res.code !== 0) {
		throw new Error(res.stderr || `Remote ${executable} on ${target.alias} exited with code ${res.code}`);
	}
	return res.stdout.toString('utf8');
}

export async function execRemoteShell(
	target: CloudHostTarget,
	posixScript: string,
	windowsPsScript: string,
	options?: {
		readonly stdin?: Buffer | string;
		readonly timeoutMs?: number;
		readonly token?: CancellationTokenLike;
	},
): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> {
	const remoteCmd = target.os === 'windows'
		? `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(windowsPsScript)}`
		: `sh -c ${posixQuote(`${buildPosixPathAugmentSnippet()}\n${posixScript}`)}`;
	return runSshCommand(target, remoteCmd, options);
}

function getConfiguredRemoteCliPaths(target: CloudHostTarget): Record<string, string> {
	try {
		const all = cloudTransportBridge.getConfiguredRemoteCliPaths?.() ?? {};
		const match = all?.[target.alias] ?? all?.[target.authority] ?? Object.entries(all ?? {}).find(([k]) => k.toLowerCase() === target.authority)?.[1];
		return match && typeof match === 'object' ? match : {};
	} catch {
		return {};
	}
}

export function parseRemoteEngineProbeOutput(raw: string, fallbackOs: CloudHostOs): {
	os: CloudHostOs;
	remoteHome?: string;
	executables: Record<string, string>;
} {
	let osKind: CloudHostOs = fallbackOs;
	let remoteHome: string | undefined;
	const executables: Record<string, string> = {};
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith('OS=')) {
			const val = line.slice(3).trim().toLowerCase();
			if (val.includes('windows')) {
				osKind = 'windows';
			} else if (val.includes('darwin') || val.includes('macos')) {
				osKind = 'macos';
			} else if (val.includes('linux')) {
				osKind = 'linux';
			}
		} else if (line.startsWith('HOME=')) {
			const val = line.slice(5).trim();
			if (val) {
				remoteHome = val;
			}
		} else if (line.startsWith('BIN:')) {
			const eq = line.indexOf('=');
			if (eq > 4) {
				const id = line.slice(4, eq).trim();
				const binPath = line.slice(eq + 1).trim();
				if (id && binPath) {
					executables[id] = binPath;
				}
			}
		}
	}
	return { os: osKind, remoteHome, executables };
}

/**
 * Probes ALL 8 Coding Agent CLIs on a Cloud Host in a single fast multiplexed SSH call.
 */
export async function probeRemoteEngines(
	target: CloudHostTarget,
	forceRefresh = false,
): Promise<RemoteEngineProbeResult> {
	const cacheKey = target.authority;
	const now = Date.now();
	if (!forceRefresh) {
		const cached = remoteProbeCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}
	}
	const pending = remoteProbePending.get(cacheKey);
	if (pending && !forceRefresh) {
		return pending;
	}

	const overrides = getConfiguredRemoteCliPaths(target);
	const pairs = Object.entries(REMOTE_ENGINE_BINARIES).map(([id, defaultBin]) => ({
		id,
		bin: overrides[id]?.trim() || (id === 'antigravity' ? overrides.agy?.trim() : undefined) || defaultBin,
	}));

	const posixProbe = [
		buildPosixPathAugmentSnippet(),
		`printf 'OS=%s\\n' "$(uname -s 2>/dev/null || echo Linux)"`,
		`printf 'HOME=%s\\n' "$HOME"`,
		...pairs.map(({ id, bin }) => {
			const qBin = posixQuote(bin);
			return `if [ -x ${qBin} ] && [ ! -d ${qBin} ]; then printf 'BIN:${id}=%s\\n' ${qBin}; else _p=$(command -v ${qBin} 2>/dev/null || true); [ -n "$_p" ] && printf 'BIN:${id}=%s\\n' "$_p" || true; fi`;
		}),
		`exit 0`,
	].join('\n');

	const winProbe = [
		`$ErrorActionPreference='SilentlyContinue'`,
		`$_dirs = @((Join-Path $env:APPDATA 'npm'), (Join-Path $env:USERPROFILE '.local\\bin'), (Join-Path $env:USERPROFILE '.npm-global\\bin'), (Join-Path $env:USERPROFILE '.cargo\\bin'), (Join-Path $env:USERPROFILE '.gemini\\bin'), (Join-Path $env:USERPROFILE '.opencode\\bin'), (Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links'), (Join-Path $env:LOCALAPPDATA 'Programs\\claude'), (Join-Path $env:LOCALAPPDATA 'Programs\\DeepSeek Harness'), (Join-Path $env:ProgramFiles 'nodejs')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }`,
		`if ($_dirs.Count -gt 0) { $env:Path = (($_dirs -join ';') + ';' + $env:Path) }`,
		`Write-Output 'OS=windows'`,
		`Write-Output ('HOME=' + $env:USERPROFILE)`,
		...pairs.map(({ id, bin }) => {
			const q = psSingleQuote(bin);
			return `if ([IO.Path]::IsPathRooted(${q}) -and (Test-Path -LiteralPath ${q} -PathType Leaf)) { Write-Output ('BIN:${id}=' + ${q}) } else { $_c = Get-Command ${q} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($_c -and $_c.Source) { Write-Output ('BIN:${id}=' + $_c.Source) } }`;
		}),
		`exit 0`,
	].join('; ');

	const epochAtStart = cacheEpoch;
	const task = (async (): Promise<RemoteEngineProbeResult> => {
		try {
			const primaryCmd = target.os === 'windows'
				? `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(winProbe)}`
				: `sh -c ${posixQuote(posixProbe)}`;
			let res = await runSshCommand(target, primaryCmd, { timeoutMs: 12_000 });
			// If OS metadata was stale/wrong (e.g. Windows host marked as linux), try alternate shell cleanly
			if (res.code !== 0 && !/permission denied|connection refused|timed out|could not resolve|no route to host|host key verification failed|operation timed out/i.test(res.stderr)) {
				const altCmd = target.os === 'windows'
					? `sh -c ${posixQuote(posixProbe)}`
					: `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(winProbe)}`;
				const altRes = await runSshCommand(target, altCmd, { timeoutMs: 10_000 });
				if (altRes.code === 0) {
					res = altRes;
				}
			}
			if (res.code !== 0) {
				const errResult: RemoteEngineProbeResult = {
					target,
					ok: false,
					os: target.os,
					remoteHome: target.remoteHome,
					executables: {},
					checkedAt: Date.now(),
					error: res.stderr || `SSH exited with code ${res.code}`,
				};
				if (cacheEpoch === epochAtStart) {
					remoteProbeCache.set(cacheKey, { value: errResult, expiresAt: Date.now() + ENGINE_PROBE_ERR_TTL_MS });
				}
				return errResult;
			}
			const parsed = parseRemoteEngineProbeOutput(res.stdout.toString('utf8'), target.os);
			const updatedTarget: CloudHostTarget = {
				...target,
				os: parsed.os,
				remoteHome: parsed.remoteHome ?? target.remoteHome,
			};
			if (cacheEpoch === epochAtStart) {
				hostTargetCache.set(cacheKey, { value: updatedTarget, expiresAt: Date.now() + HOST_CONTEXT_TTL_MS });
			}
			const okResult: RemoteEngineProbeResult = {
				target: updatedTarget,
				ok: true,
				os: parsed.os,
				remoteHome: updatedTarget.remoteHome,
				executables: parsed.executables,
				checkedAt: Date.now(),
			};
			if (cacheEpoch === epochAtStart) {
				remoteProbeCache.set(cacheKey, { value: okResult, expiresAt: Date.now() + ENGINE_PROBE_OK_TTL_MS });
			}
			return okResult;
		} catch (error) {
			const errResult: RemoteEngineProbeResult = {
				target,
				ok: false,
				os: target.os,
				remoteHome: target.remoteHome,
				executables: {},
				checkedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			};
			if (cacheEpoch === epochAtStart) {
				remoteProbeCache.set(cacheKey, { value: errResult, expiresAt: Date.now() + ENGINE_PROBE_ERR_TTL_MS });
			}
			return errResult;
		}
	})().finally(() => {
		if (remoteProbePending.get(cacheKey) === task) {
			remoteProbePending.delete(cacheKey);
		}
	});

	remoteProbePending.set(cacheKey, task);
	return task;
}

export async function resolveRemoteRealpath(
	target: CloudHostTarget,
	remotePath: string,
	token?: CancellationTokenLike,
): Promise<string | undefined> {
	const cleaned = remotePath.trim();
	if (!cleaned) {
		return undefined;
	}
	const cacheKey = `${target.authority}|${cleaned}`;
	const now = Date.now();
	const cached = remoteRealpathCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.value;
	}
	const posixScript = [
		`p=${posixQuote(cleaned)}`,
		`if command -v python3 >/dev/null 2>&1; then`,
		`  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null && exit 0`,
		`fi`,
		`readlink -f -- "$p" 2>/dev/null && exit 0`,
		`(cd -- "$p" 2>/dev/null && pwd -P) && exit 0`,
		`printf '%s\\n' "$p"`,
	].join('\n');
	const winScript = [
		`$p = ${psSingleQuote(cleaned)}`,
		`try {`,
		`  $item = Get-Item -LiteralPath $p -ErrorAction Stop`,
		`  if ($item.LinkType -and $item.Target) { Write-Output ([IO.Path]::GetFullPath(($item.Target | Select-Object -First 1))) } else { Write-Output $item.FullName }`,
		`} catch { Write-Output $p }`,
	].join('; ');
	try {
		const res = await execRemoteShell(target, posixScript, winScript, { timeoutMs: 8_000, token });
		const resolved = res.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop()?.trim() || undefined : undefined;
		if (remoteRealpathCache.size > 500) {
			remoteRealpathCache.clear();
		}
		remoteRealpathCache.set(cacheKey, { value: resolved, expiresAt: Date.now() + REMOTE_REALPATH_CACHE_TTL_MS });
		return resolved;
	} catch {
		return undefined;
	}
}

export async function readRemoteTextFile(
	target: CloudHostTarget,
	remotePath: string,
	options?: { readonly bypassCache?: boolean; readonly timeoutMs?: number; readonly token?: CancellationTokenLike },
): Promise<string | undefined> {
	const cacheKey = `${target.authority}|${remotePath}`;
	const now = Date.now();
	if (!options?.bypassCache) {
		const cached = remoteFileCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}
	}
	const posixScript = `p=${posixQuote(remotePath)}; [ -f "$p" ] && cat -- "$p" || exit 2`;
	const winScript = `$p=${psSingleQuote(remotePath)}; if (Test-Path -LiteralPath $p -PathType Leaf) { [Console]::Out.Write([IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)) } else { exit 2 }`;
	try {
		const res = await execRemoteShell(target, posixScript, winScript, {
			timeoutMs: options?.timeoutMs ?? 12_000,
			token: options?.token,
		});
		const val = res.code === 0 ? res.stdout.toString('utf8') : undefined;
		if (remoteFileCache.size > 500) {
			remoteFileCache.clear();
		}
		remoteFileCache.set(cacheKey, { value: val, expiresAt: Date.now() + REMOTE_FILE_CACHE_TTL_MS });
		return val;
	} catch {
		return undefined;
	}
}

/**
 * Reads multiple small config/text files from the Cloud Host in a single SSH round-trip
 * using base64-framed records (max 512 KiB per file).
 */
export async function readRemoteTextFilesBatch(
	target: CloudHostTarget,
	remotePaths: readonly string[],
	timeoutMs = 10_000,
): Promise<Map<string, string | undefined>> {
	const result = new Map<string, string | undefined>();
	const uncached: string[] = [];
	const now = Date.now();
	for (const p of remotePaths) {
		const cached = remoteFileCache.get(`${target.authority}|${p}`);
		if (cached && cached.expiresAt > now) {
			result.set(p, cached.value);
		} else if (!uncached.includes(p)) {
			uncached.push(p);
		}
	}
	if (uncached.length === 0) {
		return result;
	}

	const posixLines = uncached.map((p, idx) => {
		const q = posixQuote(p);
		return `if [ -f ${q} ]; then _b=$(head -c 524288 ${q} | base64 | tr -d '\\r\\n'); printf '${idx}\\t%s\\n' "$_b"; fi`;
	});
	const winLines = uncached.map((p, idx) => {
		const q = psSingleQuote(p);
		return `if (Test-Path -LiteralPath ${q} -PathType Leaf) { $_bytes=[IO.File]::ReadAllBytes(${q}); if ($_bytes.Length -gt 524288) { $_bytes=$_bytes[0..524287] }; Write-Output ('${idx}' + [char]9 + [Convert]::ToBase64String($_bytes)) }`;
	});

	for (const p of uncached) {
		result.set(p, undefined);
	}
	try {
		const res = await execRemoteShell(target, `${posixLines.join('\n')}\nexit 0`, `${winLines.join('; ')}; exit 0`, { timeoutMs });
		if (res.code === 0) {
			for (const line of res.stdout.toString('utf8').split(/\r?\n/)) {
				const tab = line.indexOf('\t');
				if (tab <= 0) {
					continue;
				}
				const idx = Number(line.slice(0, tab));
				if (Number.isInteger(idx) && idx >= 0 && idx < uncached.length) {
					const text = Buffer.from(line.slice(tab + 1).trim(), 'base64').toString('utf8');
					result.set(uncached[idx], text);
				}
			}
		}
	} catch { /* Keep undefined entries on failure. */ }

	const expiresAt = Date.now() + REMOTE_FILE_CACHE_TTL_MS;
	if (remoteFileCache.size > 500) {
		remoteFileCache.clear();
	}
	for (const p of uncached) {
		remoteFileCache.set(`${target.authority}|${p}`, { value: result.get(p), expiresAt });
	}
	return result;
}

/**
 * Stages a local attachment file (such as a clipboard screenshot from the desktop)
 * into a private temporary directory on the Cloud Host so remote CLIs that accept
 * file paths (Codex, Kilo, OpenCode, ACP) can read it natively.
 */
export async function stageLocalFileToRemote(
	target: CloudHostTarget,
	localFilePath: string,
	token?: CancellationTokenLike,
): Promise<string | undefined> {
	let raw: Buffer;
	try {
		raw = await fs.readFile(localFilePath);
	} catch {
		return undefined;
	}
	const ext = path.extname(localFilePath).replace(/[^A-Za-z0-9.]/g, '').slice(0, 12) || '.bin';
	const fileName = `aexus-${crypto.randomUUID()}${ext}`;
	if (target.os === 'windows') {
		const b64 = raw.toString('base64');
		const ps = [
			`$ErrorActionPreference='Stop'`,
			`$dir = Join-Path $env:TEMP 'aexus-att'`,
			`New-Item -ItemType Directory -Path $dir -Force | Out-Null`,
			`Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddHours(-6) } | Remove-Item -Force -ErrorAction SilentlyContinue`,
			`$dest = Join-Path $dir ${psSingleQuote(fileName)}`,
			`$b64 = [Console]::In.ReadToEnd().Trim()`,
			`[IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($b64))`,
			`Write-Output $dest`,
		].join('; ');
		const res = await execRemoteShell(target, '', ps, { stdin: Buffer.from(b64, 'utf8'), timeoutMs: 25_000, token });
		return res.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop() || undefined : undefined;
	}
	const remoteDest = `/tmp/aexus-att-${crypto.createHash('sha1').update(target.alias).digest('hex').slice(0, 8)}/${fileName}`;
	const posixScript = `dir=$(dirname -- ${posixQuote(remoteDest)}); mkdir -p -m 700 -- "$dir" && (find "$dir" -maxdepth 1 -type f -mmin +360 -delete 2>/dev/null || true) && cat > ${posixQuote(remoteDest)} && printf '%s\\n' ${posixQuote(remoteDest)}`;
	const res = await execRemoteShell(target, posixScript, '', { stdin: raw, timeoutMs: 25_000, token });
	return res.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop() || undefined : undefined;
}

async function allocateFreeLocalPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(err => err ? reject(err) : resolve(port));
		});
	});
}

async function waitForLocalPortReady(port: number, timeoutMs: number, isAborted: () => boolean): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (isAborted()) {
			throw new Error('SSH port forward exited before becoming ready.');
		}
		const connected = await new Promise<boolean>(resolve => {
			const socket = net.createConnection({ host: '127.0.0.1', port });
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => { socket.destroy(); resolve(false); });
			socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
		});
		if (connected) {
			return;
		}
		await new Promise(r => setTimeout(r, 80));
	}
	throw new Error(`Timed out waiting for SSH port forward on 127.0.0.1:${port}`);
}

/**
 * Opens an SSH local port forward (`127.0.0.1:<localPort>` -> `127.0.0.1:<remotePort>`)
 * so HTTP+SSE Coding Agent servers (Kilo Code / OpenCode) running natively on the Cloud Host
 * can be driven seamlessly over local loopback HTTP.
 */
export async function openRemotePortForward(
	target: CloudHostTarget,
	remotePort: number,
): Promise<RemotePortForwardHandle> {
	const localPort = await allocateFreeLocalPort();
	const sshExe = target.sshExecutable || resolveDefaultSshExecutable();
	const sshArgs = await buildSshBaseArgs(target, [
		'-N',
		'-o', 'ExitOnForwardFailure=yes',
		'-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
	], { useMux: false });
	sshArgs.push('--', target.alias);

	const tunnelChild = cp.spawn(sshExe, sshArgs, {
		windowsHide: true,
		stdio: ['ignore', 'ignore', 'pipe'],
		env: buildLocalSshEnv(),
	});
	let exited = false;
	let stderr = '';
	tunnelChild.stderr?.setEncoding('utf8');
	tunnelChild.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
	tunnelChild.once('exit', () => { exited = true; });
	tunnelChild.once('error', () => { exited = true; });

	const terminateTunnel = () => {
		if (exited) {
			return;
		}
		exited = true;
		tunnelChild.stderr?.removeAllListeners();
		try { tunnelChild.kill('SIGTERM'); } catch { /* ignore */ }
		const killTimer = setTimeout(() => {
			if (tunnelChild.exitCode === null && tunnelChild.signalCode === null) {
				try { tunnelChild.kill('SIGKILL'); } catch { /* ignore */ }
			}
		}, 1500);
		killTimer.unref?.();
	};

	try {
		await waitForLocalPortReady(localPort, 8000, () => exited);
	} catch (error) {
		terminateTunnel();
		throw new Error(stderr.trim() || (error instanceof Error ? error.message : String(error)));
	}

	return {
		localPort,
		localUrl: `http://127.0.0.1:${localPort}`,
		dispose: terminateTunnel,
	};
}

export interface RemoteControlReverseBridgeHandle {
	/** Allocated remote loopback TCP port (`0` when running over fixed remote Unix Domain Socket). */
	readonly remotePort: number;
	/** Fixed remote Unix Domain Socket path (`-R <remoteSocketPath>:127.0.0.1:<localPort>`) when supported by remote sshd. */
	readonly remoteSocketPath?: string;
	/** Remote JSON pointer file (`$HOME/.ade_store/_run/bridge-<hash>.json`) updated atomically on every connect/heal (zero secrets: `{ endpoint, updatedAt }`). */
	readonly remoteBridgeMetaPath?: string;
	readonly localPort: number;
	readonly isAlive: () => boolean;
	dispose(): void;
}

interface ReverseBridgeAutoHealEntry {
	target: CloudHostTarget;
	readonly localControlTcpPort: number;
	readonly explicitRemoteBridgeMetaPath?: string;
	lastRemotePort?: number;
	lastRemoteSocketPath?: string;
	lastRemoteBridgeMetaPath?: string;
	preferUnixSocket: boolean;
	disposed: boolean;
	healTimer?: ReturnType<typeof setTimeout>;
	healthyTimer?: ReturnType<typeof setTimeout>;
	healAttempts: number;
}

const activeReverseControlBridges = new Map<string, RemoteControlReverseBridgeHandle>();
const pendingReverseControlBridges = new Map<string, Promise<RemoteControlReverseBridgeHandle>>();
const reverseBridgeAutoHealRegistry = new Map<string, ReverseBridgeAutoHealEntry>();
const stagedRemoteCliShims = new Map<string, string>();
const REVERSE_BRIDGE_HEAL_BACKOFFS_MS = [1_500, 3_000, 6_000, 12_000, 20_000, 30_000, 60_000];
const MAX_REVERSE_BRIDGE_HEAL_ATTEMPTS = 20;
const REMOTE_BRIDGE_READY_SENTINEL = '__ADE_BRIDGE_READY__';

/**
 * Resolves the fixed remote Unix Domain Socket path (<= 92 bytes for `sockaddr_un`) and
 * atomic zero-secret bridge pointer metadata path (`$HOME/.ade_store/_run/bridge-<hash>.json`) on a Cloud Host.
 */
async function resolveRemoteBridgePaths(
	target: CloudHostTarget,
	localControlTcpPort: number,
	explicitMetaPath?: string,
): Promise<{ readonly remoteSocketPath?: string; readonly remoteBridgeMetaPath?: string }> {
	const bridgeTag = crypto.createHash('sha256').update(`${normalizeCloudAuthority(target.authority)}:${localControlTcpPort}`).digest('hex').slice(0, 10);
	if (target.os === 'windows') {
		if (explicitMetaPath?.trim()) {
			return { remoteBridgeMetaPath: explicitMetaPath.trim() };
		}
		const home = target.remoteHome?.trim();
		if (home) {
			return { remoteBridgeMetaPath: `${home.replace(/[\\/]+$/, '')}\\.ade_store\\_run\\bridge-${bridgeTag}.json` };
		}
		const res = await execRemoteShell(target, '', 'Write-Output $env:USERPROFILE', { timeoutMs: 6_000 }).catch(() => undefined);
		const detectedHome = res?.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop()?.trim() : undefined;
		return detectedHome ? { remoteBridgeMetaPath: `${detectedHome.replace(/[\\/]+$/, '')}\\.ade_store\\_run\\bridge-${bridgeTag}.json` } : {};
	}
	let home = target.remoteHome?.trim();
	let uid = '';
	let fstype = '';
	const probeRes = await runSshCommand(
		target,
		`sh -c 'printf "%s|%s|%s\\n" "$HOME" "$(id -u 2>/dev/null || echo u)" "$(df -T "$HOME" 2>/dev/null | awk "NR==2{print \\$2}" || true)"'`,
		{ timeoutMs: 6_000 },
	).catch(() => undefined);
	const line = probeRes?.code === 0 ? probeRes.stdout.toString('utf8').trim().split(/\r?\n/).pop() : undefined;
	if (line) {
		const [h, u, fsKind] = line.split('|');
		home = home || h?.trim() || undefined;
		uid = u?.trim() || '';
		fstype = (fsKind?.trim() || '').toLowerCase();
	}
	if (!home) {
		return explicitMetaPath?.trim() ? { remoteBridgeMetaPath: explicitMetaPath.trim() } : {};
	}
	const cleanHome = home.replace(/\/+$/, '');
	const metaPath = explicitMetaPath?.trim()
		? explicitMetaPath.trim().replace(/^~(?=\/|$)/, cleanHome)
		: `${cleanHome}/.ade_store/_run/bridge-${bridgeTag}.json`;
	const homeSock = `${cleanHome}/.ade_store/_run/b-${bridgeTag}.sock`;
	const isNetworkFs = fstype.includes('nfs') || fstype.includes('cifs') || fstype.includes('smb') || fstype.includes('lustre') || fstype.includes('ceph');
	if (!isNetworkFs && Buffer.byteLength(homeSock, 'utf8') <= 92) {
		return { remoteSocketPath: homeSock, remoteBridgeMetaPath: metaPath };
	}
	// Fallback when $HOME exceeds 92 bytes or resides on NFS: private 0700 `/tmp/ade-<uid>/b-<hash>.sock`
	const uidTag = uid || crypto.createHash('sha256').update(cleanHome).digest('hex').slice(0, 8);
	return { remoteSocketPath: `/tmp/ade-${uidTag}/b-${bridgeTag}.sock`, remoteBridgeMetaPath: metaPath };
}

/**
 * Atomically updates `$HOME/.ade_store/_run/bridge-<hash>.json` (0600, `{ endpoint, updatedAt }`, zero secrets)
 * on the Cloud Host so already-running remote agents ALWAYS discover the freshest healed UDS path or TCP endpoint.
 */
async function writeRemoteBridgeMetadataFile(
	target: CloudHostTarget,
	metaPath: string | undefined,
	endpoint: { readonly socketPath?: string; readonly tcpPort?: number },
): Promise<void> {
	if (!metaPath) {
		return;
	}
	const endpointStr = endpoint.socketPath
		? endpoint.socketPath
		: (endpoint.tcpPort && endpoint.tcpPort > 0 ? `tcp:127.0.0.1:${endpoint.tcpPort}` : '');
	if (!endpointStr) {
		return;
	}
	const payload = JSON.stringify({
		endpoint: endpointStr,
		...(endpoint.socketPath ? { socketPath: endpoint.socketPath } : {}),
		...(endpoint.tcpPort && endpoint.tcpPort > 0 ? { tcpPort: endpoint.tcpPort } : {}),
		updatedAt: Date.now(),
	});
	if (target.os === 'windows') {
		const b64 = Buffer.from(payload, 'utf8').toString('base64');
		const ps = [
			`$ErrorActionPreference='Stop'`,
			`$p=${psSingleQuote(metaPath)}`,
			`$d=Split-Path -Parent $p; if ($d) { New-Item -ItemType Directory -Path $d -Force | Out-Null }`,
			`$tmp="$p.tmp.$PID"`,
			`[IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String(${psSingleQuote(b64)}))`,
			`Move-Item -LiteralPath $tmp -Destination $p -Force`,
		].join('; ');
		await execRemoteShell(target, '', ps, { timeoutMs: 8_000 }).catch(() => undefined);
		return;
	}
	const qMeta = posixQuote(metaPath);
	const script = [
		`p=${qMeta}`,
		`case "$p" in "~/"*) p="$HOME/\${p#~/}" ;; esac`,
		`d=$(dirname -- "$p")`,
		`mkdir -p -m 700 -- "$d"`,
		`tmp="$p.tmp.$$"`,
		`printf '%s\\n' ${posixQuote(payload)} > "$tmp" && chmod 600 "$tmp" && mv -f -- "$tmp" "$p"`,
	].join('\n');
	await runSshCommand(target, `sh -c ${posixQuote(script)}`, { timeoutMs: 8_000 }).catch(() => undefined);
}

function scheduleReverseBridgeHeal(key: string): void {
	const entry = reverseBridgeAutoHealRegistry.get(key);
	if (!entry || entry.disposed || entry.healTimer || entry.healAttempts >= MAX_REVERSE_BRIDGE_HEAL_ATTEMPTS) {
		return;
	}
	const delayMs = REVERSE_BRIDGE_HEAL_BACKOFFS_MS[Math.min(entry.healAttempts, REVERSE_BRIDGE_HEAL_BACKOFFS_MS.length - 1)] ?? 60_000;
	entry.healAttempts++;
	entry.healTimer = setTimeout(() => {
		entry.healTimer = undefined;
		if (entry.disposed) {
			return;
		}
		const existing = activeReverseControlBridges.get(key);
		if (existing?.isAlive()) {
			return;
		}
		void ensureRemoteControlReverseBridge(entry.target, entry.localControlTcpPort, entry.explicitRemoteBridgeMetaPath)
			.catch(() => {
				scheduleReverseBridgeHeal(key);
			});
	}, delayMs);
	entry.healTimer.unref?.();
}

/**
 * Immediately revives any dropped SSH reverse control bridges (e.g. right after macOS wakes from
 * laptop sleep or Wi-Fi reconnects), resetting retry backoff and re-binding each host's fixed UDS
 * socket (or updating its remote bridge pointer file) so already-running remote agents seamlessly
 * regain `ade_*` CLI connectivity with zero port drift.
 */
export async function healAllRemoteControlBridges(): Promise<void> {
	const tasks: Promise<void>[] = [];
	for (const [key, entry] of Array.from(reverseBridgeAutoHealRegistry.entries())) {
		if (entry.disposed) {
			continue;
		}
		if (entry.healTimer) {
			clearTimeout(entry.healTimer);
			entry.healTimer = undefined;
		}
		entry.healAttempts = 0;
		const existing = activeReverseControlBridges.get(key);
		if (existing?.isAlive()) {
			continue;
		}
		tasks.push(
			ensureRemoteControlReverseBridge(entry.target, entry.localControlTcpPort, entry.explicitRemoteBridgeMetaPath)
				.then(() => undefined)
				.catch(() => { scheduleReverseBridgeHeal(key); }),
		);
	}
	if (tasks.length > 0) {
		await Promise.all(tasks);
	}
}

/**
 * Opens an SSH reverse control bridge to `127.0.0.1:<localControlTcpPort>`:
 * - When `remoteSocketPath` is provided on POSIX, forwards a **fixed remote Unix Domain Socket**
 *   (`-o StreamLocalBindMask=0177 -R <remoteSocketPath>:127.0.0.1:<localControlTcpPort>`) after
 *   verifying non-symlink directory ownership and unlinking any stale socket.
 * - Otherwise forwards loopback TCP (`-R 127.0.0.1:<port>:127.0.0.1:<localControlTcpPort>`).
 */
export async function openRemoteControlReverseBridge(
	target: CloudHostTarget,
	localControlTcpPort: number,
	options?: {
		readonly remoteSocketPath?: string;
		readonly preferredRemotePort?: number;
		readonly timeoutMs?: number;
		readonly onUnexpectedExit?: () => void;
	},
): Promise<RemoteControlReverseBridgeHandle> {
	const timeoutMs = options?.timeoutMs ?? 8_000;
	const remoteSocketPath = target.os !== 'windows' ? options?.remoteSocketPath?.trim() || undefined : undefined;
	const requestedRemotePort = remoteSocketPath ? 0 : (options?.preferredRemotePort ?? 0);

	if (remoteSocketPath) {
		const prepScript = [
			`s=${posixQuote(remoteSocketPath)}`,
			`d=$(dirname -- "$s")`,
			`mkdir -p -m 700 -- "$d" && chmod 700 -- "$d" 2>/dev/null || true`,
			`if [ ! -d "$d" ] || [ -L "$d" ] || [ ! -O "$d" ]; then exit 43; fi`,
			`rm -f -- "$s"`,
		].join('\n');
		const prepRes = await runSshCommand(target, `sh -c ${posixQuote(prepScript)}`, { timeoutMs: 6_000 }).catch(() => undefined);
		if (prepRes && prepRes.code === 43) {
			throw new Error(`Remote socket directory ownership check failed for ${remoteSocketPath} (administratively prohibited)`);
		}
	}

	const sshExe = target.sshExecutable || resolveDefaultSshExecutable();
	const forwardSpec = remoteSocketPath
		? `${remoteSocketPath}:127.0.0.1:${localControlTcpPort}`
		: `127.0.0.1:${requestedRemotePort}:127.0.0.1:${localControlTcpPort}`;
	const extraSshFlags = [
		'-N',
		'-o', 'ExitOnForwardFailure=yes',
		...(!remoteSocketPath && requestedRemotePort === 0 ? ['-o', 'LogLevel=INFO'] : []),
		...(remoteSocketPath ? ['-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=yes'] : []),
		'-R', forwardSpec,
	];
	const sshArgs = await buildSshBaseArgs(target, extraSshFlags, { useMux: false });
	sshArgs.push('--', target.alias);

	const tunnelChild = cp.spawn(sshExe, sshArgs, {
		windowsHide: true,
		stdio: ['ignore', 'ignore', 'pipe'],
		env: buildLocalSshEnv(),
	});
	let exited = false;
	let disposedByCaller = false;
	let stderr = '';
	let allocatedPort: number | undefined = !remoteSocketPath && requestedRemotePort > 0 ? requestedRemotePort : undefined;

	const terminateTunnel = () => {
		disposedByCaller = true;
		if (exited) {
			return;
		}
		exited = true;
		tunnelChild.stderr?.removeAllListeners();
		try { tunnelChild.kill('SIGTERM'); } catch { /* ignore */ }
		const killTimer = setTimeout(() => {
			if (tunnelChild.exitCode === null && tunnelChild.signalCode === null) {
				try { tunnelChild.kill('SIGKILL'); } catch { /* ignore */ }
			}
		}, 1500);
		killTimer.unref?.();
	};

	const remotePort = await new Promise<number>((resolve, reject) => {
		let settled = false;
		const finish = (cb: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			cb();
		};
		const timer = setTimeout(() => {
			if (allocatedPort && !exited) {
				finish(() => resolve(allocatedPort!));
			} else {
				terminateTunnel();
				finish(() => reject(new Error(stderr.trim() || `Timed out establishing SSH reverse control bridge (${target.alias})`)));
			}
		}, timeoutMs);

		tunnelChild.stderr?.setEncoding('utf8');
		tunnelChild.stderr?.on('data', (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
			if (!remoteSocketPath) {
				const allocMatch = /Allocated port (\d+) for remote forward/i.exec(stderr);
				if (allocMatch) {
					allocatedPort = Number.parseInt(allocMatch[1], 10);
					if (allocatedPort > 0 && allocatedPort <= 65535) {
						finish(() => resolve(allocatedPort!));
					}
				}
			}
		});
		tunnelChild.once('exit', code => {
			exited = true;
			if (settled && !disposedByCaller) {
				options?.onUnexpectedExit?.();
			}
			finish(() => reject(new Error(stderr.trim() || `SSH reverse control bridge exited with code ${code ?? 1}`)));
		});
		tunnelChild.once('error', err => {
			exited = true;
			if (settled && !disposedByCaller) {
				options?.onUnexpectedExit?.();
			}
			finish(() => reject(err));
		});

		if (remoteSocketPath) {
			void (async () => {
				const probeScript = `s=${posixQuote(remoteSocketPath)}; for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if [ -S "$s" ]; then chmod 600 "$s" 2>/dev/null || true; printf '${REMOTE_BRIDGE_READY_SENTINEL}\\n'; exit 0; fi; sleep 0.08 2>/dev/null || sleep 1; done; exit 1`;
				const deadline = Date.now() + timeoutMs;
				while (!settled && !exited && Date.now() < deadline) {
					const rem = Math.max(400, Math.min(2_500, deadline - Date.now()));
					const res = await runSshCommand(target, `sh -c ${posixQuote(probeScript)}`, { timeoutMs: rem }).catch(() => undefined);
					if (settled || exited) {
						return;
					}
					if (res && res.code === 0 && res.stdout.toString('utf8').includes(REMOTE_BRIDGE_READY_SENTINEL)) {
						finish(() => resolve(0));
						return;
					}
					await new Promise<void>(r => {
						const t = setTimeout(r, 80);
						t.unref?.();
					});
				}
			})();
		} else if (requestedRemotePort > 0) {
			void (async () => {
				const safePort = Math.floor(Number(requestedRemotePort));
				const posixPortProbe = `if command -v python3 >/dev/null 2>&1; then python3 -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1', ${safePort}))==0 else 1)"; elif command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 ${safePort} >/dev/null 2>&1; else exit 2; fi && printf '${REMOTE_BRIDGE_READY_SENTINEL}\\n'`;
				const winPortProbe = `$c=New-Object Net.Sockets.TcpClient; try { $ar=$c.BeginConnect('127.0.0.1',${safePort},$null,$null); if ($ar.AsyncWaitHandle.WaitOne(400) -and $c.Connected) { Write-Output '${REMOTE_BRIDGE_READY_SENTINEL}'; exit 0 } } finally { $c.Close() }; exit 1`;
				const deadline = Date.now() + timeoutMs;
				let attempts = 0;
				while (!settled && !exited && Date.now() < deadline) {
					attempts++;
					const rem = Math.max(500, Math.min(2_500, deadline - Date.now()));
					const res = await execRemoteShell(target, posixPortProbe, winPortProbe, { timeoutMs: rem }).catch(() => undefined);
					if (settled || exited) {
						return;
					}
					if (res && res.code === 0 && res.stdout.toString('utf8').includes(REMOTE_BRIDGE_READY_SENTINEL)) {
						finish(() => resolve(requestedRemotePort));
						return;
					}
					if (res?.code === 2 && attempts >= 2 && !exited) {
						finish(() => resolve(requestedRemotePort));
						return;
					}
					await new Promise<void>(r => {
						const t = setTimeout(r, 100);
						t.unref?.();
					});
				}
			})();
		}
	});

	return {
		remotePort,
		...(remoteSocketPath ? { remoteSocketPath } : {}),
		localPort: localControlTcpPort,
		isAlive: () => !exited && tunnelChild.exitCode === null && tunnelChild.signalCode === null,
		dispose: terminateTunnel,
	};
}

/**
 * Ensures one shared, live, auto-healing SSH reverse control bridge per `(cloudHost, localControlTcpPort)`:
 * 1. On POSIX Cloud Hosts, prefers a **fixed remote Unix Domain Socket** (`$HOME/.ade_store/_run/b-<hash>.sock`,
 *    falling back to `/tmp/ade-<uid>/b-<hash>.sock` when `>92B` or NFS) so reconnects NEVER suffer port drift.
 * 2. On Windows or restricted sshd (`AllowStreamLocalForwarding no`), falls back cleanly to TCP `-R`
 *    and atomically updates `$HOME/.ade_store/_run/bridge-<hash>.json` (zero secrets) on EVERY connect & heal.
 */
export async function ensureRemoteControlReverseBridge(
	target: CloudHostTarget,
	localControlTcpPort: number,
	explicitRemoteBridgeMetaPath?: string,
): Promise<RemoteControlReverseBridgeHandle> {
	const key = `${normalizeCloudAuthority(target.authority)}|${localControlTcpPort}`;
	let autoHealEntry = reverseBridgeAutoHealRegistry.get(key);
	if (!autoHealEntry) {
		autoHealEntry = {
			target,
			localControlTcpPort,
			explicitRemoteBridgeMetaPath,
			preferUnixSocket: target.os !== 'windows',
			disposed: false,
			healAttempts: 0,
		};
		reverseBridgeAutoHealRegistry.set(key, autoHealEntry);
	} else {
		autoHealEntry.target = target;
		autoHealEntry.disposed = false;
	}

	const existing = activeReverseControlBridges.get(key);
	if (existing && existing.isAlive()) {
		return existing;
	}
	const previousRemotePort = existing?.remotePort || autoHealEntry.lastRemotePort;
	activeReverseControlBridges.delete(key);

	const inflight = pendingReverseControlBridges.get(key);
	if (inflight) {
		return inflight;
	}

	const armHealthyReset = (handle: RemoteControlReverseBridgeHandle) => {
		if (autoHealEntry!.healthyTimer) {
			clearTimeout(autoHealEntry!.healthyTimer);
		}
		autoHealEntry!.healthyTimer = setTimeout(() => {
			autoHealEntry!.healthyTimer = undefined;
			if (!autoHealEntry!.disposed && handle.isAlive()) {
				autoHealEntry!.healAttempts = 0;
			}
		}, 5_000);
		autoHealEntry!.healthyTimer.unref?.();
	};

	const onUnexpectedExit = () => {
		if (autoHealEntry!.healthyTimer) {
			clearTimeout(autoHealEntry!.healthyTimer);
			autoHealEntry!.healthyTimer = undefined;
		}
		const cur = activeReverseControlBridges.get(key);
		if (cur && !cur.isAlive()) {
			activeReverseControlBridges.delete(key);
		}
		scheduleReverseBridgeHeal(key);
	};

	const finalizeHandle = async (
		rawHandle: RemoteControlReverseBridgeHandle,
		metaPath: string | undefined,
	): Promise<RemoteControlReverseBridgeHandle> => {
		if (autoHealEntry!.disposed) {
			rawHandle.dispose();
			throw new Error(`Reverse control bridge for ${target.alias} was disposed during connect`);
		}
		const handle: RemoteControlReverseBridgeHandle = metaPath
			? { ...rawHandle, remoteBridgeMetaPath: metaPath }
			: rawHandle;
		autoHealEntry!.lastRemotePort = handle.remotePort > 0 ? handle.remotePort : autoHealEntry!.lastRemotePort;
		autoHealEntry!.lastRemoteSocketPath = handle.remoteSocketPath ?? autoHealEntry!.lastRemoteSocketPath;
		autoHealEntry!.lastRemoteBridgeMetaPath = metaPath ?? autoHealEntry!.lastRemoteBridgeMetaPath;
		activeReverseControlBridges.set(key, handle);
		armHealthyReset(handle);
		await writeRemoteBridgeMetadataFile(target, metaPath, {
			socketPath: handle.remoteSocketPath,
			tcpPort: handle.remotePort > 0 ? handle.remotePort : undefined,
		});
		if (autoHealEntry!.disposed) {
			activeReverseControlBridges.delete(key);
			rawHandle.dispose();
			throw new Error(`Reverse control bridge for ${target.alias} was disposed during metadata sync`);
		}
		return handle;
	};

	const task = (async () => {
		const paths = autoHealEntry!.lastRemoteBridgeMetaPath
			? { remoteSocketPath: autoHealEntry!.lastRemoteSocketPath, remoteBridgeMetaPath: autoHealEntry!.lastRemoteBridgeMetaPath }
			: await resolveRemoteBridgePaths(target, localControlTcpPort, explicitRemoteBridgeMetaPath ?? autoHealEntry!.explicitRemoteBridgeMetaPath);
		const metaPath = paths.remoteBridgeMetaPath;

		if (target.os !== 'windows' && autoHealEntry!.preferUnixSocket && paths.remoteSocketPath) {
			try {
				const udsHandle = await openRemoteControlReverseBridge(target, localControlTcpPort, {
					remoteSocketPath: paths.remoteSocketPath,
					timeoutMs: 6_000,
					onUnexpectedExit,
				});
				return await finalizeHandle(udsHandle, metaPath);
			} catch (udsErr) {
				const msg = udsErr instanceof Error ? udsErr.message : String(udsErr);
				if (/administratively prohibited|forwarding failed|unsupported|not permitted|invalid/i.test(msg)) {
					autoHealEntry!.preferUnixSocket = false;
				}
			}
		}

		if (previousRemotePort && Number.isInteger(previousRemotePort) && previousRemotePort > 0) {
			try {
				const reused = await openRemoteControlReverseBridge(target, localControlTcpPort, {
					preferredRemotePort: previousRemotePort,
					timeoutMs: 6_000,
					onUnexpectedExit,
				});
				return await finalizeHandle(reused, metaPath);
			} catch {
				// Allocate fresh port and update zero-secret bridge metadata pointer.
			}
		}
		try {
			const handle = await openRemoteControlReverseBridge(target, localControlTcpPort, { onUnexpectedExit });
			return await finalizeHandle(handle, metaPath);
		} catch (firstErr) {
			const fallbackPort = 39000 + crypto.randomInt(18000);
			try {
				const handle = await openRemoteControlReverseBridge(target, localControlTcpPort, {
					preferredRemotePort: fallbackPort,
					timeoutMs: 6_000,
					onUnexpectedExit,
				});
				return await finalizeHandle(handle, metaPath);
			} catch {
				throw firstErr;
			}
		}
	})().finally(() => {
		if (pendingReverseControlBridges.get(key) === task) {
			pendingReverseControlBridges.delete(key);
		}
	});

	pendingReverseControlBridges.set(key, task);
	return task;
}

/**
 * Stages the self-contained `adeCli.<hash>.js` bundle, `_ade_runner` (solidifying `NODE_BIN`),
 * `.manifest`, and all 45 standalone `ade_*` symlinks (or Windows `.cmd` shims) into
 * `$HOME/.ade_store/_bin/` on the Cloud Host (cached by content hash).
 */
export async function stageRemoteAdeCliShim(
	target: CloudHostTarget,
	localAdeCliJsPath: string,
): Promise<string | undefined> {
	let raw: Buffer;
	try {
		raw = await fs.readFile(localAdeCliJsPath);
	} catch {
		return undefined;
	}
	const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
	const cacheKey = `${normalizeCloudAuthority(target.authority)}|${hash}`;
	const cached = stagedRemoteCliShims.get(cacheKey);
	if (cached) {
		return cached;
	}

	const cmdListSpaceSeparated = [...ADE_SAFE_CLI_COMMANDS].join(' ');
	if (target.os === 'windows') {
		const b64 = raw.toString('base64');
		const psCmdArray = [...ADE_SAFE_CLI_COMMANDS].map(psSingleQuote).join(', ');
		const ps = [
			`$ErrorActionPreference='Stop'`,
			`$dir = Join-Path $env:USERPROFILE '.ade_store\\_bin'`,
			`New-Item -ItemType Directory -Path $dir -Force | Out-Null`,
			`$js = Join-Path $dir 'adeCli.${hash}.js'`,
			`$b64 = [Console]::In.ReadToEnd().Trim()`,
			`if (-not (Test-Path -LiteralPath $js -PathType Leaf)) { [IO.File]::WriteAllBytes($js, [Convert]::FromBase64String($b64)) }`,
			`$_nl = [Environment]::NewLine`,
			`foreach ($name in @(${psCmdArray})) {`,
			`  $cmdPath = Join-Path $dir ($name + '.cmd')`,
			`  $body = '@echo off' + $_nl + 'set "ADE_CLI_CMD=' + $name + '"' + $_nl + 'node "%~dp0adeCli.${hash}.js" %*' + $_nl`,
			`  [IO.File]::WriteAllText($cmdPath, $body, [Text.Encoding]::ASCII)`,
			`}`,
			`[IO.File]::WriteAllText((Join-Path $dir '.manifest'), '${hash}', [Text.Encoding]::UTF8)`,
			`Write-Output $dir`,
		].join('; ');
		const res = await execRemoteShell(target, '', ps, { stdin: Buffer.from(b64, 'utf8'), timeoutMs: 25_000 });
		const dir = res.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop() || undefined : undefined;
		if (dir) {
			stagedRemoteCliShims.set(cacheKey, dir);
		}
		return dir;
	}

	const qHash = posixQuote(hash);
	const posixScript = [
		`set -e`,
		`sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }`,
		`h=${qHash}`,
		`dir="$HOME/.ade_store/_bin"`,
		`mkdir -p -m 700 -- "$dir"`,
		`js="$dir/adeCli.$h.js"`,
		`if [ ! -f "$js" ]; then cat > "$js.tmp.$$" && chmod 600 "$js.tmp.$$" && mv -f "$js.tmp.$$" "$js"; else cat >/dev/null; fi`,
		`node_bin=$(command -v node 2>/dev/null || true)`,
		`q_node=$(sq "\${node_bin:-node}")`,
		`q_js=$(sq "$js")`,
		`runner="$dir/_ade_runner"`,
		`{`,
		`  printf '#!/bin/sh\\n'`,
		`  printf 'NODE_BIN=%s\\n' "$q_node"`,
		`  printf 'if [ ! -x "$NODE_BIN" ]; then NODE_BIN=$(command -v node 2>/dev/null || echo node); fi\\n'`,
		`  printf 'export ADE_CLI_CMD="$(basename "$0")"\\n'`,
		`  printf 'exec "$NODE_BIN" %s "$@"\\n' "$q_js"`,
		`} > "$runner.tmp.$$"`,
		`chmod 755 "$runner.tmp.$$" && mv -f "$runner.tmp.$$" "$runner"`,
		`for _cmd in ${cmdListSpaceSeparated}; do`,
		`  ln -sf "_ade_runner" "$dir/$_cmd.tmp.$$" && mv -f "$dir/$_cmd.tmp.$$" "$dir/$_cmd"`,
		`done`,
		`printf '%s\\n' "$h" > "$dir/.manifest.tmp.$$" && mv -f "$dir/.manifest.tmp.$$" "$dir/.manifest"`,
		`printf '%s\\n' "$dir"`,
	].join('\n');
	const res = await execRemoteShell(target, posixScript, '', { stdin: raw, timeoutMs: 25_000 });
	const dir = res.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop() || undefined : undefined;
	if (dir) {
		stagedRemoteCliShims.set(cacheKey, dir);
	}
	return dir;
}

export function disposeAllRemoteControlBridges(authority?: string): void {
	const norm = authority ? normalizeCloudAuthority(authority) : undefined;
	for (const [key, entry] of Array.from(reverseBridgeAutoHealRegistry.entries())) {
		if (!norm || key.startsWith(`${norm}|`)) {
			entry.disposed = true;
			if (entry.healTimer) {
				clearTimeout(entry.healTimer);
				entry.healTimer = undefined;
			}
			if (entry.healthyTimer) {
				clearTimeout(entry.healthyTimer);
				entry.healthyTimer = undefined;
			}
			reverseBridgeAutoHealRegistry.delete(key);
		}
	}
	for (const [key, handle] of Array.from(activeReverseControlBridges.entries())) {
		if (!norm || key.startsWith(`${norm}|`)) {
			try { handle.dispose(); } catch { /* ignore */ }
			activeReverseControlBridges.delete(key);
		}
	}
	for (const key of Array.from(stagedRemoteCliShims.keys())) {
		if (!norm || key.startsWith(`${norm}|`)) {
			stagedRemoteCliShims.delete(key);
		}
	}
}
