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
	'AEXUS_ADE_CONTROL_FILE',
	'AEXUS_ADE_TOKEN',
	'AEXUS_ADE_SOCKET',
	'AEXUS_ADE_TCP_PORT',
	'AEXUS_ADE_REMOTE_BRIDGE_PORT',
	'AEXUS_ADE_SESSION_TOKEN',
	'AEXUS_ADE_CALLER',
]);

function stripLocalAdeControlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (!ADE_CONTROL_ENV_KEY_SET.has(k.toUpperCase())) {
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

interface CacheItem<T> {
	readonly value: T;
	readonly expiresAt: number;
}

const hostTargetCache = new Map<string, CacheItem<CloudHostTarget>>();
const remoteProbeCache = new Map<string, CacheItem<RemoteEngineProbeResult>>();
const remoteProbePending = new Map<string, Promise<RemoteEngineProbeResult>>();
const remoteFileCache = new Map<string, CacheItem<string | undefined>>();
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
		`for _aex_d in "$HOME/.aexus-code/remote-bin" "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/.claude/local" "$HOME/.cargo/bin" "$HOME/.gemini/bin" "$HOME/.opencode/bin" "$HOME/.bun/bin" "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims" "/opt/homebrew/bin" "/usr/local/bin"; do`,
		`  [ -d "$_aex_d" ] && case ":$PATH:" in *":$_aex_d:"*) ;; *) PATH="$_aex_d:$PATH" ;; esac`,
		`done`,
		`if [ -d "$HOME/.nvm/versions/node" ]; then`,
		`  _aex_nvm=$(ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | sort -V 2>/dev/null | tail -n 1 || ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -n 1)`,
		`  [ -n "$_aex_nvm" ] && [ -d "$_aex_nvm" ] && case ":$PATH:" in *":$_aex_nvm:"*) ;; *) PATH="$_aex_nvm:$PATH" ;; esac`,
		`fi`,
		`export PATH`,
	].join('\n');
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
	options?: { readonly killOnStdinClose?: boolean },
): string {
	const lines: string[] = [buildPosixPathAugmentSnippet()];
	if (extraEnv) {
		for (const [k, v] of Object.entries(extraEnv)) {
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
				lines.push(`export ${k}=${posixQuote(v)}`);
			}
		}
	}
	if (cwd?.trim()) {
		const qCwd = posixQuote(cwd.trim());
		lines.push(`cd -- ${qCwd} || { printf 'Remote directory not found or inaccessible: %s\\n' ${qCwd} >&2; exit 66; }`);
	}
	const cmdTokens = [posixQuote(executable), ...args.map(posixQuote)].join(' ');
	if (options?.killOnStdinClose) {
		// Used for long-lived HTTP server engines (kilo/opencode serve) whose own stdin isn't consumed:
		// when the SSH client disconnects, stdin hits EOF and the watchdog terminates the remote server cleanly.
		lines.push(
			`${cmdTokens} </dev/null &`,
			`_aex_pid=$!`,
			// POSIX shells redirect a background job's stdin from /dev/null before explicit redirections,
			// so duplicate the real SSH stdin to fd 3 first; otherwise the watchdog below would see EOF instantly.
			`exec 3<&0`,
			`trap 'kill $_aex_pid 2>/dev/null || true' EXIT TERM INT HUP`,
			`(cat <&3 >/dev/null 2>&1; kill $_aex_pid 2>/dev/null || true) &`,
			`_aex_watch=$!`,
			`wait $_aex_pid`,
			`_aex_rc=$?`,
			`kill $_aex_watch 2>/dev/null || true`,
			`exit $_aex_rc`,
		);
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
		`  (Join-Path $env:USERPROFILE '.aexus-code\\remote-bin'),`,
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
	options?: { readonly killOnStdinClose?: boolean },
): cp.ChildProcessWithoutNullStreams {
	const remoteEnv: Record<string, string> = { ...extractForwardableRemoteEnv(env) };
	// Explicitly forward reverse-bridge control credentials ONLY when paired with a verified
	// remote reverse-tunnel port (never inherited from local process.env or pure cloud workers).
	if (env?.AEXUS_ADE_REMOTE_BRIDGE_PORT && /^\d+$/.test(env.AEXUS_ADE_REMOTE_BRIDGE_PORT.trim()) && env.AEXUS_ADE_SESSION_TOKEN?.trim()) {
		remoteEnv.AEXUS_ADE_TCP_PORT = env.AEXUS_ADE_REMOTE_BRIDGE_PORT.trim();
		remoteEnv.AEXUS_ADE_SESSION_TOKEN = env.AEXUS_ADE_SESSION_TOKEN.trim();
	}
	const remoteCmd = target.os === 'windows'
		? buildWindowsRemoteExecCommand(executable, args, cwd, remoteEnv, options)
		: buildPosixRemoteExecCommand(executable, args, cwd, remoteEnv, options);
	const sshExe = target.sshExecutable || resolveDefaultSshExecutable();
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
	if (cachedSecureMuxDir) {
		sshArgs.push(
			'-o', 'ControlMaster=auto',
			'-o', `ControlPath=${cachedSecureMuxDir}/%C`,
			'-o', 'ControlPersist=120s',
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

		child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
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
	// Explicitly forward reverse-bridge control credentials ONLY when paired with a verified
	// remote reverse-tunnel port (never inherited from local process.env or pure cloud workers).
	if (env?.AEXUS_ADE_REMOTE_BRIDGE_PORT && /^\d+$/.test(env.AEXUS_ADE_REMOTE_BRIDGE_PORT.trim()) && env.AEXUS_ADE_SESSION_TOKEN?.trim()) {
		remoteEnv.AEXUS_ADE_TCP_PORT = env.AEXUS_ADE_REMOTE_BRIDGE_PORT.trim();
		remoteEnv.AEXUS_ADE_SESSION_TOKEN = env.AEXUS_ADE_SESSION_TOKEN.trim();
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
	readonly remotePort: number;
	readonly localPort: number;
	readonly isAlive: () => boolean;
	dispose(): void;
}

const activeReverseControlBridges = new Map<string, RemoteControlReverseBridgeHandle>();
const pendingReverseControlBridges = new Map<string, Promise<RemoteControlReverseBridgeHandle>>();
const stagedRemoteCliShims = new Map<string, string>();

/**
 * Opens an SSH reverse port forward (`127.0.0.1:<remotePort>` on the Cloud Host ->
 * `127.0.0.1:<localControlTcpPort>` on the local machine) so pure cloud-native Coding Agents
 * can invoke `aexus-ade` directly against the single local AdeControlServer & single local doc store.
 */
export async function openRemoteControlReverseBridge(
	target: CloudHostTarget,
	localControlTcpPort: number,
	options?: { readonly preferredRemotePort?: number; readonly timeoutMs?: number },
): Promise<RemoteControlReverseBridgeHandle> {
	const timeoutMs = options?.timeoutMs ?? 8_000;
	const requestedRemotePort = options?.preferredRemotePort ?? 0;
	const sshExe = target.sshExecutable || resolveDefaultSshExecutable();
	const sshArgs = await buildSshBaseArgs(target, [
		'-N',
		'-o', 'ExitOnForwardFailure=yes',
		'-R', `127.0.0.1:${requestedRemotePort}:127.0.0.1:${localControlTcpPort}`,
	], { useMux: false });
	sshArgs.push('--', target.alias);

	const tunnelChild = cp.spawn(sshExe, sshArgs, {
		windowsHide: true,
		stdio: ['ignore', 'ignore', 'pipe'],
		env: buildLocalSshEnv(),
	});
	let exited = false;
	let stderr = '';
	let allocatedPort: number | undefined = requestedRemotePort > 0 ? requestedRemotePort : undefined;

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
			const allocMatch = /Allocated port (\d+) for remote forward/i.exec(stderr);
			if (allocMatch) {
				allocatedPort = Number.parseInt(allocMatch[1], 10);
				if (allocatedPort > 0 && allocatedPort <= 65535) {
					finish(() => resolve(allocatedPort!));
				}
			}
		});
		tunnelChild.once('exit', code => {
			exited = true;
			finish(() => reject(new Error(stderr.trim() || `SSH reverse control bridge exited with code ${code ?? 1}`)));
		});
		tunnelChild.once('error', err => {
			exited = true;
			finish(() => reject(err));
		});
		// When an explicit non-zero port is requested, wait briefly to ensure ExitOnForwardFailure doesn't abort it.
		if (requestedRemotePort > 0) {
			const readyTimer = setTimeout(() => {
				if (!exited) {
					finish(() => resolve(requestedRemotePort));
				}
			}, 450);
			readyTimer.unref?.();
		}
	});

	return {
		remotePort,
		localPort: localControlTcpPort,
		isAlive: () => !exited && tunnelChild.exitCode === null && tunnelChild.signalCode === null,
		dispose: terminateTunnel,
	};
}

/**
 * Ensures one shared, live SSH reverse control bridge per `(cloudHost, localControlTcpPort)`.
 * Multiple Mission agents on the same Cloud Host share this single tunnel while each authenticates
 * independently via its own per-session HMAC-signed `AEXUS_ADE_SESSION_TOKEN`.
 */
export async function ensureRemoteControlReverseBridge(
	target: CloudHostTarget,
	localControlTcpPort: number,
): Promise<RemoteControlReverseBridgeHandle> {
	const key = `${normalizeCloudAuthority(target.authority)}|${localControlTcpPort}`;
	const existing = activeReverseControlBridges.get(key);
	if (existing && existing.isAlive()) {
		return existing;
	}
	const previousRemotePort = existing?.remotePort;
	activeReverseControlBridges.delete(key);

	const inflight = pendingReverseControlBridges.get(key);
	if (inflight) {
		return inflight;
	}

	const task = (async () => {
		// When re-establishing after a tunnel drop, re-bind the previous remote port first so
		// already-running remote agents holding AEXUS_ADE_REMOTE_BRIDGE_PORT stay seamlessly connected.
		if (previousRemotePort && Number.isInteger(previousRemotePort) && previousRemotePort > 0) {
			try {
				const reused = await openRemoteControlReverseBridge(target, localControlTcpPort, { preferredRemotePort: previousRemotePort, timeoutMs: 6_000 });
				activeReverseControlBridges.set(key, reused);
				return reused;
			} catch {
				// Previous port is busy or unavailable; fall back to normal allocation below.
			}
		}
		try {
			const handle = await openRemoteControlReverseBridge(target, localControlTcpPort);
			activeReverseControlBridges.set(key, handle);
			return handle;
		} catch (firstErr) {
			// Fallback for older sshd instances that don't print `Allocated port` on `-R 0`: try an explicit high loopback port once.
			const fallbackPort = 39000 + crypto.randomInt(18000);
			try {
				const handle = await openRemoteControlReverseBridge(target, localControlTcpPort, { preferredRemotePort: fallbackPort, timeoutMs: 6_000 });
				activeReverseControlBridges.set(key, handle);
				return handle;
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
 * Stages the single self-contained `adeCli.js` bundle and an `aexus-ade` executable wrapper
 * into `~/.aexus-code/remote-bin/` on the Cloud Host (cached by content hash so repeated turns
 * incur zero file upload overhead).
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

	if (target.os === 'windows') {
		const b64 = raw.toString('base64');
		const ps = [
			`$ErrorActionPreference='Stop'`,
			`$dir = Join-Path $env:USERPROFILE '.aexus-code\\remote-bin'`,
			`New-Item -ItemType Directory -Path $dir -Force | Out-Null`,
			`$js = Join-Path $dir 'adeCli.${hash}.js'`,
			`$b64 = [Console]::In.ReadToEnd().Trim()`,
			`if (-not (Test-Path -LiteralPath $js -PathType Leaf)) { [IO.File]::WriteAllBytes($js, [Convert]::FromBase64String($b64)) }`,
			`$cmd = Join-Path $dir 'aexus-ade.cmd'`,
			`Set-Content -LiteralPath $cmd -Encoding ASCII -Value "@echo off\`r\`nnode \`"%~dp0adeCli.${hash}.js\`" %*"`,
			`Write-Output $dir`,
		].join('; ');
		const res = await execRemoteShell(target, '', ps, { stdin: Buffer.from(b64, 'utf8'), timeoutMs: 25_000 });
		const dir = res.code === 0 ? res.stdout.toString('utf8').trim().split(/\r?\n/).pop() || undefined : undefined;
		if (dir) {
			stagedRemoteCliShims.set(cacheKey, dir);
		}
		return dir;
	}

	const posixScript = [
		`set -e`,
		`dir="$HOME/.aexus-code/remote-bin"`,
		`mkdir -p -m 700 -- "$dir"`,
		`js="$dir/adeCli.${hash}.js"`,
		`if [ ! -f "$js" ]; then cat > "$js.tmp.$$" && chmod 600 "$js.tmp.$$" && mv -f "$js.tmp.$$" "$js"; else cat >/dev/null; fi`,
		`bin="$dir/aexus-ade"`,
		`printf '#!/usr/bin/env sh\\nexec node "%s" "$@"\\n' "$js" > "$bin.tmp.$$"`,
		`chmod 700 "$bin.tmp.$$" && mv -f "$bin.tmp.$$" "$bin"`,
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
