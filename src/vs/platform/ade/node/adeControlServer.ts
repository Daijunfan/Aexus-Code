/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import {
	ADE_CAPABILITY_TOKEN_PREFIX,
	ADE_CONTROL_DIR_NAME,
	ADE_CONTROL_META_NAME,
	ADE_CONTROL_SOCKET_NAME,
	ADE_MINT_SESSION_TOKEN_ACTION,
	ADE_REVOKE_SESSION_TOKEN_ACTION,
	IAdeCapabilityTokenPayload,
	IAdeControlConnectionMetadata,
	IAdeControlDispatchRequest,
	IAdeControlWireRequest,
	IAdeControlWireResponse,
} from '../common/adeControl.js';
import { ADE_PURE_MISSION_NODE_ALLOWED_ACTIONS, parseOrchestrationLimitsRequest, validateIdempotencyKey } from '../common/adeControlPolicy.js';
import { AdeIdempotencyLedger } from './adeIdempotencyLedger.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 310_000;
const DEFAULT_HEADER_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
const DEFAULT_WAIT_EXECUTION_TIMEOUT_MS = 930_000;
const DEFAULT_MAX_CONCURRENT_SOCKETS = 256;
const DEFAULT_CAPABILITY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const POST_RESPONSE_DESTROY_DELAY_MS = 5_000;
const SOCKET_PROBE_TIMEOUT_MS = 300;
/** macOS limits AF_UNIX sun_path to 104 bytes (Linux 108); keep comfortable margin for `.pid.sock` suffixes. */
const MAX_UNIX_SOCKET_PATH_BYTES = 90;

function getSecureTmpFallbackDir(): string {
	const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
	return path.join('/tmp', `aexus-ade-${uid}`);
}

function normalizeUnixSocketPath(candidate: string): string {
	if (isWindows || Buffer.byteLength(candidate, 'utf8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
		return candidate;
	}
	const hash = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 12);
	return path.join(getSecureTmpFallbackDir(), `c-${hash}.sock`);
}
const PURE_WORKER_DENIED_ERROR = 'Permission denied: pure execution Worker sessions have no ADE control plane access.';
const PURE_MISSION_NODE_DENIED_ERROR = 'Permission denied: pure-execution Engineering staff sessions may only invoke token.{current,trace,read,history,handoff,return,complete,reject,block,fail}, mission.task.{list,get}, mission.diagnostics, mission.checkpoint.{list,diff}, orchestration.{get,status,validate,limits(read-only)}, whiteboard.{list,read,write}, mission.check.{list,get,run}, org.escalate, rank.{names,list,get,docs}, mission.docs, whoami, docs.read, or api.update.';

export interface IAdeControlDispatchOptions {
	/** When true, windowId came from a capability token pin rather than explicit `--window`, so gracefully fall back if that window closed. */
	readonly softWindowPin?: boolean;
	/** Aborted if the control request exceeds executionTimeoutMs or client disconnects. */
	readonly signal?: AbortSignal;
}

export type AdeControlDispatcher = (request: IAdeControlDispatchRequest, windowId?: number, options?: IAdeControlDispatchOptions) => Promise<unknown>;

export interface IAdeControlServerOptions {
	readonly controlDir?: string;
	readonly socketPath?: string;
	readonly metaPath?: string;
	readonly logService?: ILogService;
	readonly maxPayloadBytes?: number;
	readonly socketTimeoutMs?: number;
	/** Deadline (ms) to receive the complete newline-delimited request frame before dropping slowloris sockets. */
	readonly headerTimeoutMs?: number;
	/** Maximum simultaneous active sockets accepted before rejecting excess connections. */
	readonly maxConcurrentSockets?: number;
	/** Capability token lifetime (ms); defaults to 24h. */
	readonly capabilityTokenTtlMs?: number;
	/** Hard upper bound (ms) for awaiting the control action dispatcher before failing with a timeout error. */
	readonly executionTimeoutMs?: number;
	/** Optional 0o600 JSON file path for mutation idempotency deduplication across restarts. */
	readonly idempotencyLedgerPath?: string;
	/** Idempotency ledger entry TTL (ms); defaults to 15 minutes. */
	readonly idempotencyTtlMs?: number;
	/** Disable disk persistence for the idempotency ledger (useful for pure in-memory tests). */
	readonly persistIdempotencyLedger?: boolean;
	/** Optional clock override for deterministic TTL/revocation tests. */
	readonly now?: () => number;
	/** Optional callback notified whenever `revokeSession()` records a new cutoff (for bidirectional headless sync). */
	readonly onDidRevokeSession?: (sessionId: string, revokedAt: number) => void;
}

/**
 * Local IPC control server for Aexus Code ADE.
 *
 * Exposes a newline-delimited JSON request/response protocol over a `0600` Unix
 * domain socket (or Windows named pipe) guarded by a 32-byte random hex token.
 *
 * Trust-boundary note: in the local single-OS-user desktop model, processes spawned
 * under the same OS user account share filesystem permissions on the `0600` master
 * control metadata file; per-session HMAC capability tokens enforce least-privilege
 * isolation across agent processes without OS-level containerization.
 */
export class AdeControlServer extends Disposable {

	private readonly _controlDir: string;
	private readonly _requestedSocketPath: string;
	private _activeSocketPath: string;
	private readonly _metaPath: string;
	private readonly _instanceMetaPath: string;
	private readonly _token: string;
	private readonly _capabilitySecret: Buffer;
	private readonly _logService: ILogService | undefined;
	private readonly _maxPayloadBytes: number;
	private readonly _socketTimeoutMs: number;
	private readonly _headerTimeoutMs: number;
	private readonly _maxConcurrentSockets: number;
	private readonly _capabilityTokenTtlMs: number;
	private readonly _executionTimeoutMs: number | undefined;
	private readonly _now: () => number;
	private _onDidRevokeSession: ((sessionId: string, revokedAt: number) => void) | undefined;
	private readonly _sockets = new Set<net.Socket>();
	private readonly _revokedSessionCutoffs = new Map<string, number>();
	private readonly _idempotencyLedger: AdeIdempotencyLedger;
	private readonly _readyPromise: Promise<void>;

	private _server: net.Server | undefined;
	private _tcpServer: net.Server | undefined;
	private _tcpPort: number | undefined;
	private _disposed = false;
	private _startupError: unknown;

	constructor(
		private readonly _dispatcher: AdeControlDispatcher,
		options?: IAdeControlServerOptions,
	) {
		super();

		this._controlDir = options?.controlDir || process.env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		const rawSocketPath = options?.socketPath
			|| process.env.AEXUS_ADE_SOCKET
			|| (isWindows
				? `\\\\.\\pipe\\aexus-ade-control-${process.pid}`
				: path.join(this._controlDir, ADE_CONTROL_SOCKET_NAME));
		this._requestedSocketPath = normalizeUnixSocketPath(rawSocketPath);
		this._activeSocketPath = this._requestedSocketPath;
		this._metaPath = options?.metaPath
			|| process.env.AEXUS_ADE_CONTROL_FILE
			|| path.join(this._controlDir, ADE_CONTROL_META_NAME);
		this._instanceMetaPath = path.join(path.dirname(this._metaPath), `ade-control.${process.pid}.json`);
		this._token = crypto.randomBytes(32).toString('hex');
		// Kept strictly in main-process memory and never persisted to disk.
		this._capabilitySecret = crypto.randomBytes(32);
		this._logService = options?.logService;
		this._maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
		this._socketTimeoutMs = options?.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
		this._headerTimeoutMs = options?.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
		this._maxConcurrentSockets = Math.max(1, options?.maxConcurrentSockets ?? DEFAULT_MAX_CONCURRENT_SOCKETS);
		this._capabilityTokenTtlMs = Math.max(100, options?.capabilityTokenTtlMs ?? DEFAULT_CAPABILITY_TOKEN_TTL_MS);
		this._executionTimeoutMs = options?.executionTimeoutMs;
		this._now = options?.now ?? (() => Date.now());
		this._onDidRevokeSession = options?.onDidRevokeSession;
		const ledgerPath = options?.persistIdempotencyLedger === false
			? undefined
			: (options?.idempotencyLedgerPath ?? path.join(this._controlDir, 'idempotency-ledger.json'));
		this._idempotencyLedger = this._register(new AdeIdempotencyLedger({
			storagePath: ledgerPath,
			ttlMs: options?.idempotencyTtlMs,
			now: this._now,
		}));

		this._readyPromise = this._start();
	}

	async flushIdempotencyLedger(): Promise<void> {
		await this._idempotencyLedger.flush();
	}

	get socketPath(): string {
		return this._activeSocketPath;
	}

	get metaPath(): string {
		return this._metaPath;
	}

	get instanceMetaPath(): string {
		return this._instanceMetaPath;
	}

	get token(): string {
		return this._token;
	}

	get tcpPort(): number | undefined {
		return this._tcpPort;
	}

	mintSessionCapabilityToken(sessionId: string, rank: string, pure = false, missionNode = false, windowId?: number): string {
		const normalizedSid = sessionId.trim() || 'session';
		const normalizedRank = pure ? 'worker' : (rank.trim().toLowerCase() || 'worker');
		const normalizedWid = typeof windowId === 'number' && Number.isInteger(windowId) && windowId > 0 ? windowId : undefined;
		const prevCutoff = this._revokedSessionCutoffs.get(normalizedSid);
		const rawNow = this._now();
		const iat = prevCutoff !== undefined && rawNow <= prevCutoff ? prevCutoff + 1 : rawNow;
		const payload: IAdeCapabilityTokenPayload = {
			sid: normalizedSid,
			rank: normalizedRank,
			...(pure ? { pure: true } : {}),
			...(missionNode ? { missionNode: true } : {}),
			...(normalizedWid !== undefined ? { wid: normalizedWid } : {}),
			iat,
			exp: iat + this._capabilityTokenTtlMs,
		};
		const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
		const signatureHex = crypto.createHmac('sha256', this._capabilitySecret).update(encodedPayload, 'utf8').digest('hex');
		return `${ADE_CAPABILITY_TOKEN_PREFIX}${encodedPayload}.${signatureHex}`;
	}

	setOnDidRevokeSession(callback: ((sessionId: string, revokedAt: number) => void) | undefined): void {
		this._onDidRevokeSession = callback;
	}

	/**
	 * Immediately revokes all capability tokens previously minted for `sessionId` (with `iat <= revokedAt`).
	 * Called when a session is archived, deleted, stopped, or demoted so headless/live sockets reject stale tokens.
	 */
	revokeSession(sessionId: string, revokedAt = this._now(), options?: { readonly skipNotify?: boolean }): number {
		const normalizedSid = sessionId.trim();
		if (!normalizedSid) {
			return 0;
		}
		const prev = this._revokedSessionCutoffs.get(normalizedSid) ?? -1;
		const nextCutoff = Math.max(prev, revokedAt);
		this._revokedSessionCutoffs.set(normalizedSid, nextCutoff);
		// Bound revocation map size for long-lived main processes.
		if (this._revokedSessionCutoffs.size > 4096) {
			const cutoffExpiry = this._now() - this._capabilityTokenTtlMs;
			for (const [sid, ts] of this._revokedSessionCutoffs) {
				if (ts < cutoffExpiry) {
					this._revokedSessionCutoffs.delete(sid);
				}
			}
		}
		if (!options?.skipNotify && nextCutoff > prev) {
			this._onDidRevokeSession?.(normalizedSid, nextCutoff);
		}
		return nextCutoff;
	}

	async whenReady(): Promise<void> {
		await this._readyPromise;
		if (this._startupError) {
			throw this._startupError;
		}
	}

	private async _start(): Promise<void> {
		try {
			await this._doStart();
		} catch (err) {
			this._startupError = err;
			this._logService?.error('[AdeControlServer] Failed to start ADE control server', err);
		}
	}

	private async _doStart(): Promise<void> {
		await fs.promises.mkdir(this._controlDir, { recursive: true, mode: 0o700 });
		if (!isWindows) {
			const socketDir = path.dirname(this._requestedSocketPath);
			if (socketDir !== this._controlDir) {
				await fs.promises.mkdir(socketDir, { recursive: true, mode: 0o700 });
			}
		}
		const metaDir = path.dirname(this._metaPath);
		if (metaDir !== this._controlDir) {
			await fs.promises.mkdir(metaDir, { recursive: true, mode: 0o700 });
		}

		if (this._disposed) {
			return;
		}

		let listenPath = this._requestedSocketPath;
		let writeGlobalMeta = true;

		if (!isWindows && await this._pathExists(listenPath)) {
			const probeResult = await this._probeUnixSocket(listenPath);
			if (this._disposed) {
				return;
			}

			if (probeResult === 'live') {
				listenPath = normalizeUnixSocketPath(path.join(path.dirname(listenPath), `ade-control.${process.pid}.sock`));
				if (listenPath === this._requestedSocketPath) {
					const hash = crypto.createHash('sha256').update(`${this._requestedSocketPath}:${process.pid}`, 'utf8').digest('hex').slice(0, 12);
					listenPath = path.join(getSecureTmpFallbackDir(), `c-${hash}.sock`);
				}
				writeGlobalMeta = false;
				this._logService?.info(`[AdeControlServer] Live ADE control socket already bound at ${this._requestedSocketPath}; falling back to ${listenPath}`);
				if (await this._pathExists(listenPath)) {
					await this._unlinkQuietly(listenPath);
				}
			} else {
				await this._unlinkQuietly(listenPath);
			}
		}

		if (this._disposed) {
			return;
		}

		if (!isWindows) {
			const activeDir = path.dirname(listenPath);
			await fs.promises.mkdir(activeDir, { recursive: true, mode: 0o700 });
			await fs.promises.chmod(activeDir, 0o700).catch(() => undefined);
		}

		this._activeSocketPath = listenPath;

		const server = net.createServer({ allowHalfOpen: true }, socket => this._handleConnection(socket));
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				server.removeListener('listening', onListening);
				reject(err);
			};
			const onListening = () => {
				server.removeListener('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(listenPath);
		});

		server.on('error', err => {
			this._logService?.error('[AdeControlServer] Socket server error', err);
		});
		this._server = server;

		if (this._disposed) {
			server.close();
			this._server = undefined;
			if (!isWindows) {
				await this._unlinkQuietly(listenPath);
			}
			return;
		}

		if (!isWindows) {
			await fs.promises.chmod(listenPath, 0o600);
		}

		// Bind a loopback-only TCP listener (127.0.0.1:0) guarded by the exact same
		// token / HMAC capability verification so remote SSH Cloud Host agents can
		// reach this single local control plane over `ssh -R`.
		if (!this._disposed) {
			try {
				const tcpServer = net.createServer({ allowHalfOpen: true }, socket => this._handleConnection(socket));
				await new Promise<void>((resolve, reject) => {
					const onErr = (err: Error) => {
						tcpServer.removeListener('listening', onListen);
						reject(err);
					};
					const onListen = () => {
						tcpServer.removeListener('error', onErr);
						resolve();
					};
					tcpServer.once('error', onErr);
					tcpServer.once('listening', onListen);
					tcpServer.listen(0, '127.0.0.1');
				});
				const addr = tcpServer.address();
				if (this._disposed) {
					tcpServer.close();
				} else if (addr && typeof addr === 'object' && addr.port > 0) {
					tcpServer.on('error', err => {
						this._logService?.error('[AdeControlServer] Loopback TCP server error', err);
					});
					this._tcpServer = tcpServer;
					this._tcpPort = addr.port;
				} else {
					tcpServer.close();
				}
			} catch (err) {
				this._logService?.warn('[AdeControlServer] Loopback TCP bridge unavailable; continuing with local socket only', err);
			}
		}

		if (!this._disposed) {
			const metadata: IAdeControlConnectionMetadata = {
				socketPath: listenPath,
				token: this._token,
				pid: process.pid,
				...(this._tcpPort ? { tcpPort: this._tcpPort } : {}),
			};
			// Always persist a per-instance 0600 metadata file so secondary Aexus Code instances route to their own socket.
			await this._writeMetadataFile(this._instanceMetaPath, metadata);
			if (writeGlobalMeta && !this._disposed && this._metaPath !== this._instanceMetaPath) {
				await this._writeMetadataFile(this._metaPath, metadata);
			}
		}
	}

	private async _writeMetadataFile(targetPath: string, metadata: IAdeControlConnectionMetadata): Promise<void> {
		const tmpMetaPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
		await fs.promises.writeFile(tmpMetaPath, JSON.stringify(metadata, null, '\t') + '\n', { encoding: 'utf8', mode: 0o600 });
		if (!isWindows) {
			await fs.promises.chmod(tmpMetaPath, 0o600);
		}
		if (this._disposed) {
			await this._unlinkQuietly(tmpMetaPath);
			return;
		}
		await fs.promises.rename(tmpMetaPath, targetPath);
	}

	private async _pathExists(targetPath: string): Promise<boolean> {
		try {
			await fs.promises.lstat(targetPath);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return false;
			}
			return true;
		}
	}

	private async _unlinkQuietly(targetPath: string): Promise<void> {
		try {
			await fs.promises.unlink(targetPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw err;
			}
		}
	}

	private _probeUnixSocket(socketPath: string): Promise<'live' | 'stale'> {
		return new Promise<'live' | 'stale'>(resolve => {
			let settled = false;
			const finish = (state: 'live' | 'stale') => {
				if (settled) {
					return;
				}
				settled = true;
				probe.destroy();
				resolve(state);
			};

			const probe = net.createConnection({ path: socketPath });
			probe.setTimeout(SOCKET_PROBE_TIMEOUT_MS);
			probe.once('connect', () => finish('live'));
			probe.once('timeout', () => finish('live'));
			probe.once('error', (err: NodeJS.ErrnoException) => {
				if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'ENOTSOCK') {
					finish('stale');
				} else {
					finish('live');
				}
			});
		});
	}

	private _handleConnection(socket: net.Socket): void {
		if (this._disposed) {
			socket.destroy();
			return;
		}
		if (this._sockets.size >= this._maxConcurrentSockets) {
			this._writeResponse(socket, { ok: false, error: `Too many concurrent ADE control connections (limit ${this._maxConcurrentSockets})` });
			return;
		}

		this._sockets.add(socket);
		socket.setNoDelay(true);
		let headerTimer: ReturnType<typeof setTimeout> | undefined;
		const clearHeaderTimer = () => {
			if (headerTimer !== undefined) {
				clearTimeout(headerTimer);
				headerTimer = undefined;
			}
		};
		socket.once('close', () => {
			clearHeaderTimer();
			this._sockets.delete(socket);
		});

		socket.setTimeout(this._socketTimeoutMs);
		socket.once('timeout', () => {
			clearHeaderTimer();
			this._writeResponse(socket, { ok: false, error: 'Control socket request timed out' });
			socket.destroy();
		});
		socket.on('error', err => {
			clearHeaderTimer();
			this._logService?.debug('[AdeControlServer] Client socket error', err);
			socket.destroy();
		});

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let handled = false;

		headerTimer = setTimeout(() => {
			if (!handled) {
				handled = true;
				this._writeResponse(socket, { ok: false, error: `Control request header deadline exceeded (${this._headerTimeoutMs}ms)` });
				socket.destroy();
			}
		}, this._headerTimeoutMs);
		if (typeof (headerTimer as { unref?: () => void }).unref === 'function') {
			(headerTimer as { unref?: () => void }).unref!();
		}

		socket.on('data', (chunk: Buffer) => {
			if (handled) {
				return;
			}

			const newlineIndex = chunk.indexOf(0x0a);
			if (newlineIndex !== -1) {
				const slice = chunk.subarray(0, newlineIndex);
				if (totalBytes + slice.byteLength > this._maxPayloadBytes) {
					handled = true;
					clearHeaderTimer();
					this._writeResponse(socket, { ok: false, error: `Request exceeds maximum payload size (${this._maxPayloadBytes} bytes)` });
					return;
				}
				chunks.push(slice);
				handled = true;
				clearHeaderTimer();
				socket.setTimeout(0);
				const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
				void this._processRequestLine(socket, line);
				return;
			}

			totalBytes += chunk.byteLength;
			if (totalBytes > this._maxPayloadBytes) {
				handled = true;
				clearHeaderTimer();
				this._writeResponse(socket, { ok: false, error: `Request exceeds maximum payload size (${this._maxPayloadBytes} bytes)` });
				return;
			}
			chunks.push(chunk);
		});

		socket.once('end', () => {
			clearHeaderTimer();
			if (!handled) {
				handled = true;
				if (totalBytes === 0) {
					socket.end();
				} else {
					this._writeResponse(socket, { ok: false, error: 'Malformed request: missing newline delimiter' });
				}
			}
		});
	}

	private async _processRequestLine(socket: net.Socket, rawLine: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawLine);
		} catch {
			this._writeResponse(socket, { ok: false, error: 'Invalid JSON request' });
			return;
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			this._writeResponse(socket, { ok: false, error: 'Invalid request object' });
			return;
		}

		const req = parsed as Partial<IAdeControlWireRequest>;
		if (typeof req.token !== 'string' || req.token.length === 0) {
			this._writeResponse(socket, { ok: false, error: 'Unauthorized: invalid control token' });
			return;
		}

		let isMasterToken = false;
		let capabilityPayload: IAdeCapabilityTokenPayload | undefined;
		if (req.token.startsWith(ADE_CAPABILITY_TOKEN_PREFIX)) {
			capabilityPayload = this._verifyCapabilityToken(req.token);
			if (!capabilityPayload) {
				this._writeResponse(socket, { ok: false, error: 'Unauthorized: invalid or tampered capability token' });
				return;
			}
		} else if (this._isValidToken(req.token)) {
			isMasterToken = true;
		} else {
			this._writeResponse(socket, { ok: false, error: 'Unauthorized: invalid control token' });
			return;
		}

		if (typeof req.action !== 'string' || req.action.trim().length === 0) {
			this._writeResponse(socket, { ok: false, error: 'Invalid request: action must be a non-empty string' });
			return;
		}

		if (req.params !== undefined && (typeof req.params !== 'object' || req.params === null || Array.isArray(req.params))) {
			this._writeResponse(socket, { ok: false, error: 'Invalid request: params must be an object' });
			return;
		}

		if (req.windowId !== undefined && (typeof req.windowId !== 'number' || !Number.isInteger(req.windowId))) {
			this._writeResponse(socket, { ok: false, error: 'Invalid request: windowId must be an integer' });
			return;
		}

		if (req.action === ADE_MINT_SESSION_TOKEN_ACTION) {
			if (!isMasterToken) {
				this._writeResponse(socket, { ok: false, error: 'Forbidden: auth.mintSessionToken requires master control token authentication' });
				return;
			}
			const rawSessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId.trim() : '';
			const pure = req.params?.pure === true;
			const missionNode = req.params?.missionNode === true;
			const rawRank = typeof req.params?.rank === 'string' ? req.params.rank.trim() : '';
			const paramWindowId = req.params?.windowId;
			const rawWindowId = typeof paramWindowId === 'number' && Number.isInteger(paramWindowId) && paramWindowId > 0
				? paramWindowId
				: (typeof req.windowId === 'number' && Number.isInteger(req.windowId) && req.windowId > 0 ? req.windowId : undefined);
			if (!rawSessionId || (!pure && !rawRank)) {
				this._writeResponse(socket, { ok: false, error: 'Invalid request: auth.mintSessionToken requires sessionId and rank' });
				return;
			}
			const token = this.mintSessionCapabilityToken(rawSessionId, rawRank || 'worker', pure, missionNode, rawWindowId);
			this._writeResponse(socket, { ok: true, result: { token } });
			return;
		}
		if (req.action === ADE_REVOKE_SESSION_TOKEN_ACTION) {
			if (!isMasterToken) {
				this._writeResponse(socket, { ok: false, error: 'Permission denied: auth.revokeSessionToken requires master control token' });
				return;
			}
			const rawSessionId = typeof req.params?.sessionId === 'string' ? req.params.sessionId.trim() : '';
			if (!rawSessionId) {
				this._writeResponse(socket, { ok: false, error: 'Invalid request: auth.revokeSessionToken requires sessionId' });
				return;
			}
			this.revokeSession(rawSessionId);
			this._writeResponse(socket, { ok: true, result: { revoked: true, sessionId: rawSessionId } });
			return;
		}

		const topIdemp = validateIdempotencyKey(req.idempotencyKey);
		if (!topIdemp.ok) {
			this._writeResponse(socket, { ok: false, error: topIdemp.error });
			return;
		}
		const paramIdemp = validateIdempotencyKey(req.params?.idempotencyKey);
		if (!paramIdemp.ok) {
			this._writeResponse(socket, { ok: false, error: paramIdemp.error });
			return;
		}
		if (topIdemp.key && paramIdemp.key && topIdemp.key !== paramIdemp.key) {
			this._writeResponse(socket, { ok: false, error: 'INVALID_IDEMPOTENCY_KEY: top-level idempotencyKey and params.idempotencyKey must match when both are provided.' });
			return;
		}
		const idempotencyKey = topIdemp.key ?? paramIdemp.key;

		let effectiveParams = req.params;
		if (capabilityPayload) {
			if (capabilityPayload.pure === true) {
				if (capabilityPayload.missionNode !== true) {
					this._writeResponse(socket, { ok: false, error: PURE_WORKER_DENIED_ERROR });
					return;
				}
				const isReadOnlyLimits = req.action === 'orchestration.limits'
					&& parseOrchestrationLimitsRequest(req.params ?? {}, { isHumanUser: false }).isReadOnlyQuery;
				if (!ADE_PURE_MISSION_NODE_ALLOWED_ACTIONS.has(req.action) && !isReadOnlyLimits) {
					this._writeResponse(socket, { ok: false, error: PURE_MISSION_NODE_DENIED_ERROR });
					return;
				}
			}
			effectiveParams = {
				...(req.params ?? {}),
				caller: capabilityPayload.rank,
				_verifiedCaller: true,
				_callerSessionId: capabilityPayload.sid,
				_callerTokenIat: capabilityPayload.iat,
			};
		} else if (req.params && (
			Object.prototype.hasOwnProperty.call(req.params, '_verifiedCaller')
			|| Object.prototype.hasOwnProperty.call(req.params, '_callerSessionId')
			|| Object.prototype.hasOwnProperty.call(req.params, '_callerTokenIat')
		)) {
			const sanitized: Record<string, unknown> = { ...req.params };
			delete sanitized._verifiedCaller;
			delete sanitized._callerSessionId;
			delete sanitized._callerTokenIat;
			effectiveParams = sanitized;
		}

		const isWaitAction = Boolean(effectiveParams && effectiveParams.wait === true);
		const requestedWaitTimeoutMs = isWaitAction
			&& effectiveParams
			&& typeof effectiveParams.timeoutMs === 'number'
			&& Number.isFinite(effectiveParams.timeoutMs)
			&& effectiveParams.timeoutMs > 0
			? effectiveParams.timeoutMs + 30_000
			: 0;
		const rawTimeoutMs = this._executionTimeoutMs !== undefined
			? this._executionTimeoutMs
			: (isWaitAction ? Math.max(DEFAULT_WAIT_EXECUTION_TIMEOUT_MS, requestedWaitTimeoutMs) : DEFAULT_EXECUTION_TIMEOUT_MS);
		const executionTimeoutMs = Number.isFinite(rawTimeoutMs)
			? Math.max(50, Math.min(2_147_483_647, Math.floor(rawTimeoutMs)))
			: DEFAULT_WAIT_EXECUTION_TIMEOUT_MS;

		let execTimer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const abortController = new AbortController();
		const onSocketClose = () => {
			if (!abortController.signal.aborted) {
				abortController.abort(new Error('ADE control client disconnected'));
			}
		};
		// For idempotent requests, decouple the shared in-flight execution from Request 1's socket
		// lifecycle so a concurrent retry coalescing onto the same idempotencyKey is not aborted
		// when Request 1 disconnects.
		if (!idempotencyKey) {
			socket.once('close', onSocketClose);
		}
		try {
			const effectiveWindowId = req.windowId ?? capabilityPayload?.wid;
			const isSoftPin = req.windowId === undefined && capabilityPayload?.wid !== undefined;
			const dispatchOptions: IAdeControlDispatchOptions = isSoftPin
				? { softWindowPin: true, signal: abortController.signal }
				: { signal: abortController.signal };
			const dispatchReq: IAdeControlDispatchRequest = {
				action: req.action,
				params: effectiveParams,
			};
			const principalId = capabilityPayload ? `cap:${capabilityPayload.sid}` : 'master';
			const executePromise: Promise<{ readonly result: unknown; readonly replayed: boolean }> = idempotencyKey
				? this._idempotencyLedger.execute(
					{
						principalId,
						action: req.action,
						idempotencyKey,
						params: effectiveParams,
						// Hash only explicit caller-requested --window, never soft-pinned token wid
						// which changes across window reloads and would trigger false IDEMPOTENCY_CONFLICT.
						windowId: req.windowId,
						timeoutMs: executionTimeoutMs,
					},
					() => this._dispatcher(dispatchReq, effectiveWindowId, dispatchOptions),
				)
				: this._dispatcher(dispatchReq, effectiveWindowId, dispatchOptions).then(result => ({ result, replayed: false }));
			// Prevent unhandled rejection if dispatcher rejects after timeout already settled the socket.
			executePromise.catch(() => undefined);
			const outcome = await new Promise<{ readonly result: unknown; readonly replayed: boolean }>((resolve, reject) => {
				execTimer = setTimeout(() => {
					timedOut = true;
					const timeoutErr = new Error(`ADE control action "${req.action}" timed out after ${executionTimeoutMs}ms`);
					abortController.abort(timeoutErr);
					reject(timeoutErr);
				}, executionTimeoutMs);
				if (typeof (execTimer as { unref?: () => void }).unref === 'function') {
					(execTimer as { unref?: () => void }).unref!();
				}
				executePromise.then(resolve, reject);
			});
			if (execTimer !== undefined) {
				clearTimeout(execTimer);
			}
			if (!timedOut) {
				this._writeResponse(socket, {
					ok: true,
					result: outcome.result,
					...(outcome.replayed ? { idempotentReplay: true } : {}),
				});
			}
		} catch (err) {
			if (execTimer !== undefined) {
				clearTimeout(execTimer);
			}
			const message = err instanceof Error && err.message ? err.message : toErrorMessage(err, false);
			this._writeResponse(socket, { ok: false, error: message });
			if (timedOut) {
				const forceCloseTimer = setTimeout(() => {
					if (!socket.destroyed) {
						socket.destroy();
					}
				}, 1000);
				if (typeof (forceCloseTimer as { unref?: () => void }).unref === 'function') {
					(forceCloseTimer as { unref?: () => void }).unref!();
				}
			}
		} finally {
			socket.removeListener('close', onSocketClose);
		}
	}

	private _verifyCapabilityToken(candidate: string): IAdeCapabilityTokenPayload | undefined {
		if (!candidate.startsWith(ADE_CAPABILITY_TOKEN_PREFIX)) {
			return undefined;
		}
		const body = candidate.slice(ADE_CAPABILITY_TOKEN_PREFIX.length);
		const dotIdx = body.indexOf('.');
		if (dotIdx <= 0 || dotIdx !== body.lastIndexOf('.') || dotIdx === body.length - 1) {
			return undefined;
		}
		const encodedPayload = body.slice(0, dotIdx);
		const providedSigHex = body.slice(dotIdx + 1);
		if (!/^[0-9a-f]{64}$/i.test(providedSigHex)) {
			return undefined;
		}
		const expectedSig = crypto.createHmac('sha256', this._capabilitySecret).update(encodedPayload, 'utf8').digest();
		const providedSig = Buffer.from(providedSigHex, 'hex');
		if (expectedSig.byteLength !== providedSig.byteLength || !crypto.timingSafeEqual(expectedSig, providedSig)) {
			return undefined;
		}
		try {
			const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
			const parsed = JSON.parse(decoded) as Partial<IAdeCapabilityTokenPayload>;
			if (
				!parsed
				|| typeof parsed !== 'object'
				|| Array.isArray(parsed)
				|| typeof parsed.sid !== 'string'
				|| parsed.sid.trim().length === 0
				|| typeof parsed.rank !== 'string'
				|| parsed.rank.trim().length === 0
				|| (parsed.pure !== undefined && typeof parsed.pure !== 'boolean')
				|| (parsed.missionNode !== undefined && typeof parsed.missionNode !== 'boolean')
				|| (parsed.wid !== undefined && (typeof parsed.wid !== 'number' || !Number.isInteger(parsed.wid) || parsed.wid <= 0))
				|| (parsed.exp !== undefined && (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)))
			) {
				return undefined;
			}
			const sid = parsed.sid.trim();
			const iat = typeof parsed.iat === 'number' && Number.isFinite(parsed.iat) ? parsed.iat : 0;
			const now = this._now();
			if (parsed.exp !== undefined && now > parsed.exp) {
				return undefined;
			}
			if (iat > 0 && now - iat > this._capabilityTokenTtlMs) {
				return undefined;
			}
			const revokedCutoff = this._revokedSessionCutoffs.get(sid);
			if (revokedCutoff !== undefined && iat <= revokedCutoff) {
				return undefined;
			}
			return {
				sid,
				rank: parsed.rank.trim().toLowerCase(),
				...(parsed.pure === true ? { pure: true } : {}),
				...(parsed.missionNode === true ? { missionNode: true } : {}),
				...(typeof parsed.wid === 'number' ? { wid: parsed.wid } : {}),
				iat,
				...(typeof parsed.exp === 'number' ? { exp: parsed.exp } : {}),
			};
		} catch {
			return undefined;
		}
	}

	private _isValidToken(candidate: string): boolean {
		const expectedBytes = Buffer.from(this._token, 'utf8');
		const candidateBytes = Buffer.from(candidate, 'utf8');
		if (expectedBytes.byteLength !== candidateBytes.byteLength) {
			return false;
		}
		return crypto.timingSafeEqual(expectedBytes, candidateBytes);
	}

	private _writeResponse(socket: net.Socket, response: IAdeControlWireResponse): void {
		if (socket.destroyed || !socket.writable) {
			return;
		}
		let payload: string;
		try {
			payload = JSON.stringify(response) + '\n';
		} catch (err) {
			const fallback: IAdeControlWireResponse = {
				ok: false,
				error: `Failed to serialize ADE response: ${err instanceof Error ? err.message : String(err)}`,
			};
			payload = JSON.stringify(fallback) + '\n';
		}
		socket.end(payload, 'utf8');
		const destroyTimer = setTimeout(() => {
			if (!socket.destroyed) {
				socket.destroy();
			}
		}, POST_RESPONSE_DESTROY_DELAY_MS);
		if (typeof (destroyTimer as { unref?: () => void }).unref === 'function') {
			(destroyTimer as { unref?: () => void }).unref!();
		}
		socket.once('close', () => clearTimeout(destroyTimer));
	}

	override dispose(): void {
		if (!this._disposed) {
			this._disposed = true;

			for (const socket of this._sockets) {
				socket.destroy();
			}
			this._sockets.clear();

			if (this._server) {
				try {
					this._server.close();
				} catch {
					// ignore
				}
				this._server = undefined;
			}

			if (this._tcpServer) {
				try {
					this._tcpServer.close();
				} catch {
					// ignore
				}
				this._tcpServer = undefined;
				this._tcpPort = undefined;
			}

			if (!isWindows && this._activeSocketPath) {
				try {
					// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must unlink the Unix domain socket before process exit.
					fs.unlinkSync(this._activeSocketPath);
				} catch {
					// ignore ENOENT
				}
			}

			const metaPathsToClean = this._instanceMetaPath === this._metaPath
				? [this._metaPath]
				: [this._instanceMetaPath, this._metaPath];
			for (const candidateMetaPath of metaPathsToClean) {
				try {
					// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must verify PID ownership before removing metadata on shutdown.
					const raw = fs.readFileSync(candidateMetaPath, 'utf8');
					const parsed = JSON.parse(raw) as Partial<IAdeControlConnectionMetadata>;
					if (parsed && parsed.pid === process.pid && (parsed.socketPath === undefined || parsed.socketPath === this._activeSocketPath)) {
						// eslint-disable-next-line local/code-no-sync-fs -- IDisposable.dispose() is synchronous and must remove owned metadata file before process exit.
						fs.unlinkSync(candidateMetaPath);
					}
				} catch {
					// ignore ENOENT or malformed metadata
				}
			}
		}

		super.dispose();
	}
}
