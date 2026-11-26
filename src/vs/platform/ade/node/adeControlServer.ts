/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ILogService } from '../../log/common/log.js';
import {
	ADE_AGENT_TOKEN_PREFIX,
	ADE_CONTROL_DIR_NAME,
	ADE_CONTROL_SOCKET_PREFIX,
	IAdeCliWireRequestPayload,
	IAdeHmacClientRequestFrame,
	IAdeHmacServerChallengeFrame,
	IAdeHmacServerResponseFrame,
} from '../common/adeControl.js';
import { ADE_READONLY_CLI_COMMANDS, AdeCliCommandName, isAdeCliCommandName } from '../common/adeCliManifest.js';
import { IAdeVerifiedCliCaller } from '../common/adeControlCenterIpc.js';
import { AdeErrorCode, isAdeError } from '../common/adeModels.js';
import { AdeIdempotencyConflictError, AdeIdempotencyLedger, validateIdempotencyKey } from './adeIdempotencyLedger.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_SOCKET_TIMEOUT_MS = 310_000;
const DEFAULT_HEADER_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONCURRENT_SOCKETS = 256;
const POST_RESPONSE_DESTROY_DELAY_MS = 5_000;
const SOCKET_PROBE_TIMEOUT_MS = 300;
const MAX_UNIX_SOCKET_PATH_BYTES = 90;

function getSecureTmpFallbackDir(): string {
	const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
	return path.join('/tmp', `ade-ctrl-${uid}`);
}

function normalizeUnixSocketPath(candidate: string): string {
	if (isWindows || Buffer.byteLength(candidate, 'utf8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
		return candidate;
	}
	const hash = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 12);
	return path.join(getSecureTmpFallbackDir(), `c-${hash}.sock`);
}

export interface IAdeAgentSessionCredential {
	readonly jti: string;
	readonly secret: Buffer;
	readonly projectId: string;
	readonly agentId: string;
	/** `'local'` or canonical cloud host IP */
	readonly host: string;
	readonly tokenGen: number;
	readonly issuedAt: number;
}

export type AdeCliExecutionHandler = (
	caller: IAdeVerifiedCliCaller,
	command: AdeCliCommandName,
	args: Readonly<Record<string, unknown>>,
	idempotencyKey?: string,
) => Promise<Record<string, unknown>>;

export interface IAdeControlServerOptions {
	readonly controlDir?: string;
	readonly socketPath?: string;
	readonly logService?: ILogService;
	readonly maxPayloadBytes?: number;
	readonly socketTimeoutMs?: number;
	readonly headerTimeoutMs?: number;
	readonly maxConcurrentSockets?: number;
	readonly executionTimeoutMs?: number;
	readonly idempotencyLedgerPath?: string;
	readonly idempotencyTtlMs?: number;
	readonly persistIdempotencyLedger?: boolean;
	readonly now?: () => number;
}

interface IHostBoundLoopbackListener {
	readonly canonicalHostKey: string;
	readonly server: net.Server;
	readonly port: number;
}

export function computeAdeHmacRequestProof(secret: Buffer, nonce: string, jti: string, payloadJson: string): string {
	return crypto.createHmac('sha256', secret).update(`req:${nonce}:${jti}:${payloadJson}`, 'utf8').digest('hex');
}

export function computeAdeHmacResponseProof(secret: Buffer, nonce: string, jti: string, responseJson: string): string {
	return crypto.createHmac('sha256', secret).update(`res:${nonce}:${jti}:${responseJson}`, 'utf8').digest('hex');
}

/**
 * Full-duplex mutual HMAC-SHA256 IPC control server for ADE.
 *
 * Security invariants:
 * - Zero plaintext master token file on disk (`ade-control.json` eliminated).
 * - Local UDS bound at `0600` (`~/.aexus-code/run/ade-control-<uid>.sock`, `boundCanonicalHostKey = 'local'`).
 * - Each remote SSH cloud host gets an isolated loopback TCP target (`127.0.0.1:0`, `boundCanonicalHostKey = <hostIp>`)
 *   forwarded via `ssh -R <remoteStreamLocalSock>:127.0.0.1:<port>`, strictly enforcing `session.host === listener.boundCanonicalHostKey`.
 * - 3-step challenge-response (`challenge(nonce)` -> `request(jti, payloadJson, reqProof)` -> `response(responseJson, resProof)`):
 *   `secret` never crosses the wire, and `timingSafeEqual` verifies every frame.
 */
export class AdeControlServer extends Disposable {
	private readonly _controlDir: string;
	private readonly _requestedSocketPath: string;
	private _activeSocketPath: string;
	private readonly _logService?: ILogService;
	private readonly _maxPayloadBytes: number;
	private readonly _socketTimeoutMs: number;
	private readonly _headerTimeoutMs: number;
	private readonly _maxConcurrentSockets: number;
	private readonly _executionTimeoutMs: number;
	private readonly _now: () => number;
	private readonly _sockets = new Set<net.Socket>();
	private readonly _inflightRequests = new Set<Promise<void>>();
	private readonly _sessionsByJti = new Map<string, IAdeAgentSessionCredential>();
	private readonly _jtiByAgentKey = new Map<string, Set<string>>();
	private readonly _hostListeners = new Map<string, Promise<IHostBoundLoopbackListener>>();
	private readonly _resolvedHostListeners = new Map<string, IHostBoundLoopbackListener>();
	private readonly _idempotencyLedger: AdeIdempotencyLedger;
	private readonly _readyPromise: Promise<void>;

	private _localServer: net.Server | undefined;
	private _stopPromise: Promise<void> | undefined;
	private _disposed = false;
	private _startupError: unknown;

	constructor(
		private readonly _handler: AdeCliExecutionHandler,
		options?: IAdeControlServerOptions,
	) {
		super();
		this._controlDir = options?.controlDir || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
		const uidTag = typeof process.getuid === 'function' ? String(process.getuid()) : String(process.pid);
		const defaultSock = isWindows
			? `\\\\.\\pipe\\${ADE_CONTROL_SOCKET_PREFIX}-${process.pid}`
			: path.join(this._controlDir, 'run', `${ADE_CONTROL_SOCKET_PREFIX}-${uidTag}.sock`);
		this._requestedSocketPath = normalizeUnixSocketPath(options?.socketPath || defaultSock);
		this._activeSocketPath = this._requestedSocketPath;
		this._logService = options?.logService;
		this._maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
		this._socketTimeoutMs = options?.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
		this._headerTimeoutMs = options?.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
		this._maxConcurrentSockets = Math.max(1, options?.maxConcurrentSockets ?? DEFAULT_MAX_CONCURRENT_SOCKETS);
		this._executionTimeoutMs = Math.max(100, options?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS);
		this._now = options?.now ?? (() => Date.now());

		const ledgerPath = options?.persistIdempotencyLedger === false
			? undefined
			: (options?.idempotencyLedgerPath ?? path.join(this._controlDir, 'control-center', 'idempotency-ledger.json'));
		this._idempotencyLedger = this._register(new AdeIdempotencyLedger({
			storagePath: ledgerPath,
			ttlMs: options?.idempotencyTtlMs,
			now: this._now,
		}));

		this._readyPromise = this._start();
	}

	get socketPath(): string {
		return this._activeSocketPath;
	}

	get localEndpoint(): string {
		return isWindows ? `pipe:${this._activeSocketPath}` : `unix:${this._activeSocketPath}`;
	}

	async whenReady(): Promise<void> {
		await this._readyPromise;
		if (this._startupError) {
			throw this._startupError;
		}
	}

	async flushIdempotencyLedger(): Promise<void> {
		await this._idempotencyLedger.flush();
	}

	get activeSessionCredentialCount(): number {
		return this._sessionsByJti.size;
	}

	/**
	 * Mints or reuses a pure in-memory `ADE_AGENT_TOKEN="ades1.<jti>.<secret_b64url>"` bound to `(projectId, agentId, host, tokenGen)`.
	 * Reuses an existing live credential when `(projectId, agentId, host, tokenGen)` matches and evicts superseded `jti` entries.
	 */
	issueAgentSessionToken(input: {
		readonly projectId: string;
		readonly agentId: string;
		readonly host: string;
		readonly tokenGen: number;
	}): string {
		const normHost = input.host.trim() || 'local';
		const agentScopeKey = `${input.projectId}:${input.agentId}`;
		let reusableCred: IAdeAgentSessionCredential | undefined;
		const existingJtis = this._jtiByAgentKey.get(agentScopeKey);
		if (existingJtis) {
			for (const oldJti of [...existingJtis]) {
				const rec = this._sessionsByJti.get(oldJti);
				if (!rec || rec.tokenGen !== input.tokenGen || rec.host !== normHost) {
					this._sessionsByJti.delete(oldJti);
					existingJtis.delete(oldJti);
				} else if (!reusableCred) {
					reusableCred = rec;
				} else {
					this._sessionsByJti.delete(oldJti);
					existingJtis.delete(oldJti);
				}
			}
			if (existingJtis.size === 0) {
				this._jtiByAgentKey.delete(agentScopeKey);
			}
		}
		if (reusableCred) {
			return `${ADE_AGENT_TOKEN_PREFIX}${reusableCred.jti}.${reusableCred.secret.toString('base64url')}`;
		}

		const jti = crypto.randomBytes(12).toString('hex');
		const secret = crypto.randomBytes(32);
		const cred: IAdeAgentSessionCredential = {
			jti,
			secret,
			projectId: input.projectId,
			agentId: input.agentId,
			host: normHost,
			tokenGen: input.tokenGen,
			issuedAt: this._now(),
		};
		this._sessionsByJti.set(jti, cred);
		let set = this._jtiByAgentKey.get(agentScopeKey);
		if (!set) {
			set = new Set();
			this._jtiByAgentKey.set(agentScopeKey, set);
		}
		set.add(jti);
		return `${ADE_AGENT_TOKEN_PREFIX}${jti}.${secret.toString('base64url')}`;
	}

	revokeAgentTokens(projectId: string, agentId?: string): void {
		if (agentId !== undefined) {
			const key = `${projectId}:${agentId}`;
			const jtis = this._jtiByAgentKey.get(key);
			if (jtis) {
				for (const jti of jtis) {
					this._sessionsByJti.delete(jti);
				}
				this._jtiByAgentKey.delete(key);
			}
			return;
		}
		const prefix = `${projectId}:`;
		for (const [key, jtis] of [...this._jtiByAgentKey.entries()]) {
			if (key.startsWith(prefix)) {
				for (const jti of jtis) {
					this._sessionsByJti.delete(jti);
				}
				this._jtiByAgentKey.delete(key);
			}
		}
	}

	/**
	 * Allocates an isolated loopback listener (`127.0.0.1:0`) bound strictly to `canonicalHostKey` (cloud host IP)
	 * so `ssh -R <remoteSock>:127.0.0.1:<port>` cannot be replayed across different hosts.
	 */
	async ensureHostLoopbackPort(canonicalHostKey: string): Promise<number> {
		await this.whenReady();
		const normKey = canonicalHostKey.trim();
		if (!normKey || normKey === 'local') {
			throw new Error('ensureHostLoopbackPort requires a non-local canonical host IP');
		}
		let pending = this._hostListeners.get(normKey);
		if (!pending) {
			pending = this._createHostLoopbackListener(normKey).catch(err => {
				this._hostListeners.delete(normKey);
				throw err;
			});
			this._hostListeners.set(normKey, pending);
		}
		const listener = await pending;
		return listener.port;
	}

	private async _createHostLoopbackListener(canonicalHostKey: string): Promise<IHostBoundLoopbackListener> {
		if (this._disposed) {
			throw new Error('AdeControlServer is disposed');
		}
		const server = net.createServer({ allowHalfOpen: true }, socket => this._handleConnection(socket, canonicalHostKey));
		await new Promise<void>((resolve, reject) => {
			const onErr = (err: Error) => {
				server.removeListener('listening', onListen);
				reject(err);
			};
			const onListen = () => {
				server.removeListener('error', onErr);
				resolve();
			};
			server.once('error', onErr);
			server.once('listening', onListen);
			server.listen(0, '127.0.0.1');
		});
		const addr = server.address();
		if (this._disposed || !addr || typeof addr !== 'object' || addr.port <= 0) {
			server.close();
			throw new Error(`Failed to bind loopback port for host ${canonicalHostKey}`);
		}
		server.on('error', err => this._logService?.error(`[AdeControlServer] Loopback listener error (${canonicalHostKey})`, err));
		const rec: IHostBoundLoopbackListener = { canonicalHostKey, server, port: addr.port };
		this._resolvedHostListeners.set(canonicalHostKey, rec);
		return rec;
	}

	private async _start(): Promise<void> {
		try {
			await this._doStart();
		} catch (err) {
			this._startupError = err;
			this._logService?.error('[AdeControlServer] Startup error', err);
		}
	}

	private async _doStart(): Promise<void> {
		await fs.promises.mkdir(this._controlDir, { recursive: true, mode: 0o700 });
		let listenPath = this._requestedSocketPath;

		if (!isWindows) {
			const socketDir = path.dirname(listenPath);
			await fs.promises.mkdir(socketDir, { recursive: true, mode: 0o700 });
			await fs.promises.chmod(socketDir, 0o700).catch(() => undefined);

			if (await this._pathExists(listenPath)) {
				const state = await this._probeUnixSocket(listenPath);
				if (this._disposed) {
					return;
				}
				if (state === 'live') {
					listenPath = normalizeUnixSocketPath(path.join(socketDir, `${ADE_CONTROL_SOCKET_PREFIX}-${process.pid}.sock`));
					if (await this._pathExists(listenPath)) {
						await this._unlinkQuietly(listenPath);
					}
				} else {
					await this._unlinkQuietly(listenPath);
				}
			}
			const finalDir = path.dirname(listenPath);
			await fs.promises.mkdir(finalDir, { recursive: true, mode: 0o700 });
			await fs.promises.chmod(finalDir, 0o700).catch(() => undefined);
		}

		if (this._disposed) {
			return;
		}
		this._activeSocketPath = listenPath;

		const server = net.createServer({ allowHalfOpen: true }, socket => this._handleConnection(socket, 'local'));
		await new Promise<void>((resolve, reject) => {
			const onErr = (err: Error) => {
				server.removeListener('listening', onListen);
				reject(err);
			};
			const onListen = () => {
				server.removeListener('error', onErr);
				resolve();
			};
			server.once('error', onErr);
			server.once('listening', onListen);
			server.listen(listenPath);
		});
		server.on('error', err => this._logService?.error('[AdeControlServer] Local socket server error', err));
		this._localServer = server;

		if (this._disposed) {
			server.close();
			this._localServer = undefined;
			if (!isWindows) {
				await this._unlinkQuietly(listenPath);
			}
			return;
		}
		if (!isWindows) {
			await fs.promises.chmod(listenPath, 0o600);
		}
	}

	private async _pathExists(targetPath: string): Promise<boolean> {
		try {
			await fs.promises.lstat(targetPath);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code !== 'ENOENT';
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
		return new Promise(resolve => {
			let settled = false;
			const finish = (s: 'live' | 'stale') => {
				if (!settled) {
					settled = true;
					probe.destroy();
					resolve(s);
				}
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

	private _handleConnection(socket: net.Socket, boundCanonicalHostKey: string): void {
		if (this._disposed) {
			socket.destroy();
			return;
		}
		if (this._sockets.size >= this._maxConcurrentSockets) {
			this._sendResponseFrame(socket, { ok: false, code: 'ERR_UNAUTHORIZED', error: '控制中心并发连接已满' });
			return;
		}

		this._sockets.add(socket);
		socket.setNoDelay(true);
		const nonce = crypto.randomBytes(32).toString('hex');

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
			this._sendResponseFrame(socket, { ok: false, code: 'ERR_INVALID_ARGS', error: '控制通道等待超时' });
			socket.destroy();
		});
		socket.on('error', () => {
			clearHeaderTimer();
			socket.destroy();
		});

		// Step 1: Immediately emit 256-bit challenge frame
		const challenge: IAdeHmacServerChallengeFrame = {
			type: 'challenge',
			nonce,
			serverTime: this._now(),
		};
		socket.write(`${JSON.stringify(challenge)}\n`, 'utf8');

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let handled = false;

		headerTimer = setTimeout(() => {
			if (!handled) {
				handled = true;
				this._sendResponseFrame(socket, { ok: false, code: 'ERR_UNAUTHORIZED', error: '握手请求超时' });
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
			const nl = chunk.indexOf(0x0a);
			if (nl !== -1) {
				const slice = chunk.subarray(0, nl);
				if (totalBytes + slice.byteLength > this._maxPayloadBytes) {
					handled = true;
					clearHeaderTimer();
					this._sendResponseFrame(socket, { ok: false, code: 'ERR_INVALID_ARGS', error: '控制请求帧超出 2MB 上限' });
					return;
				}
				chunks.push(slice);
				handled = true;
				clearHeaderTimer();
				socket.setTimeout(0);
				const rawLine = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
				if (this._disposed) {
					socket.destroy();
					return;
				}
				const reqPromise = this._processAuthenticatedLine(socket, boundCanonicalHostKey, nonce, rawLine)
					.catch(err => {
						this._logService?.warn('[AdeControlServer] Unhandled error in _processAuthenticatedLine', err);
					})
					.finally(() => {
						this._inflightRequests.delete(reqPromise);
					});
				this._inflightRequests.add(reqPromise);
				return;
			}
			totalBytes += chunk.byteLength;
			if (totalBytes > this._maxPayloadBytes) {
				handled = true;
				clearHeaderTimer();
				this._sendResponseFrame(socket, { ok: false, code: 'ERR_INVALID_ARGS', error: '控制请求帧超出 2MB 上限' });
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
					this._sendResponseFrame(socket, { ok: false, code: 'ERR_INVALID_ARGS', error: '请求帧缺少换行符' });
				}
			}
		});
	}

	private async _processAuthenticatedLine(
		socket: net.Socket,
		boundCanonicalHostKey: string,
		nonce: string,
		rawLine: string,
	): Promise<void> {
		let frame: Partial<IAdeHmacClientRequestFrame>;
		try {
			frame = JSON.parse(rawLine) as Partial<IAdeHmacClientRequestFrame>;
		} catch {
			this._sendResponseFrame(socket, { ok: false, code: 'ERR_UNAUTHORIZED', error: '非法的握手请求格式' });
			return;
		}
		if (
			!frame
			|| frame.type !== 'request'
			|| typeof frame.jti !== 'string'
			|| !frame.jti
			|| typeof frame.payloadJson !== 'string'
			|| typeof frame.reqProof !== 'string'
			|| !/^[0-9a-f]{64}$/i.test(frame.reqProof)
		) {
			this._sendResponseFrame(socket, { ok: false, code: 'ERR_UNAUTHORIZED', error: '缺失或损坏的会话鉴权凭证' });
			return;
		}

		const cred = this._sessionsByJti.get(frame.jti);
		if (!cred) {
			this._sendResponseFrame(socket, { ok: false, code: 'ERR_UNAUTHORIZED', error: 'ADE_AGENT_TOKEN 无效或已被吊销' });
			return;
		}

		// Constant-time HMAC verification (`secret` never crossed the wire)
		const expectedProofHex = computeAdeHmacRequestProof(cred.secret, nonce, frame.jti, frame.payloadJson);
		const expectedBuf = Buffer.from(expectedProofHex, 'hex');
		const providedBuf = Buffer.from(frame.reqProof, 'hex');
		if (expectedBuf.byteLength !== providedBuf.byteLength || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
			this._sendResponseFrame(socket, { ok: false, code: 'ERR_UNAUTHORIZED', error: '双向 HMAC 请求签名校验失败' });
			return;
		}

		// Strict host-channel binding (`session.host === listener.boundCanonicalHostKey`)
		if (cred.host !== boundCanonicalHostKey) {
			this._sendResponseFrame(
				socket,
				{ ok: false, code: 'ERR_UNAUTHORIZED', error: '禁止跨主机通道重放其他主机的会话令牌' },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
			return;
		}

		let payload: Partial<IAdeCliWireRequestPayload>;
		try {
			payload = JSON.parse(frame.payloadJson) as Partial<IAdeCliWireRequestPayload>;
		} catch {
			this._sendResponseFrame(
				socket,
				{ ok: false, code: 'ERR_INVALID_ARGS', error: '非法的命令负载 JSON' },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
			return;
		}

		if (!payload || typeof payload.command !== 'string' || !isAdeCliCommandName(payload.command)) {
			this._sendResponseFrame(
				socket,
				{ ok: false, code: 'ERR_INVALID_ARGS', error: `未知的 CLI 命令: ${String(payload?.command ?? '')}` },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
			return;
		}
		if (payload.args !== undefined && (typeof payload.args !== 'object' || payload.args === null || Array.isArray(payload.args))) {
			this._sendResponseFrame(
				socket,
				{ ok: false, code: 'ERR_INVALID_ARGS', error: '命令参数表必须为对象' },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
			return;
		}

		const idempCheck = validateIdempotencyKey(payload.idempotencyKey);
		if (!idempCheck.ok) {
			this._sendResponseFrame(
				socket,
				{ ok: false, code: 'ERR_INVALID_ARGS', error: idempCheck.error },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
			return;
		}

		const caller: IAdeVerifiedCliCaller = {
			projectId: cred.projectId,
			agentId: cred.agentId,
			host: cred.host,
			tokenGen: cred.tokenGen,
		};
		const cmd = payload.command;
		const cmdArgs = payload.args ?? {};
		const idempKey = idempCheck.key;
		const useLedger = Boolean(idempKey && !ADE_READONLY_CLI_COMMANDS.has(cmd));

		try {
			const runOnce = () => this._handler(caller, cmd, cmdArgs, idempKey);
			const outcome = useLedger
				? await this._idempotencyLedger.execute(
					{
						principalId: `${cred.projectId}:${cred.agentId}:${cred.tokenGen}`,
						action: cmd,
						idempotencyKey: idempKey!,
						params: cmdArgs,
						timeoutMs: this._executionTimeoutMs,
					},
					runOnce,
				)
				: { result: await runOnce(), replayed: false };

			this._sendResponseFrame(
				socket,
				{ ok: true, ...outcome.result },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
		} catch (err) {
			let code: AdeErrorCode = 'ERR_INVALID_ARGS';
			let message = err instanceof Error ? err.message : String(err);
			if (isAdeError(err)) {
				code = err.code;
				message = err.message;
			} else if (err instanceof AdeIdempotencyConflictError) {
				code = err.code;
				message = err.message;
			}
			this._sendResponseFrame(
				socket,
				{ ok: false, code, error: message },
				{ secret: cred.secret, nonce, jti: cred.jti },
			);
		}
	}

	private _sendResponseFrame(
		socket: net.Socket,
		responseObj: Record<string, unknown>,
		signWith?: { readonly secret: Buffer; readonly nonce: string; readonly jti: string },
	): void {
		if (socket.destroyed || !socket.writable) {
			return;
		}
		const responseJson = JSON.stringify(responseObj);
		const frame: IAdeHmacServerResponseFrame = signWith
			? {
				type: 'response',
				responseJson,
				resProof: computeAdeHmacResponseProof(signWith.secret, signWith.nonce, signWith.jti, responseJson),
			}
			: {
				type: 'response',
				responseJson,
			};
		socket.end(`${JSON.stringify(frame)}\n`, 'utf8');
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

	stopAndClose(): Promise<void> {
		if (!this._stopPromise) {
			this._disposed = true;
			this._stopPromise = (async () => {
				for (const s of this._sockets) {
					s.destroy();
				}
				this._sockets.clear();

				const closeServer = (srv: net.Server | undefined) => new Promise<void>(resolve => {
					if (!srv) {
						resolve();
						return;
					}
					try {
						srv.close(() => resolve());
					} catch {
						resolve();
					}
				});

				await closeServer(this._localServer);
				this._localServer = undefined;

				if (this._hostListeners.size > 0) {
					await Promise.allSettled([...this._hostListeners.values()]);
				}
				const hostSrvs = [...this._resolvedHostListeners.values()].map(l => l.server);
				this._resolvedHostListeners.clear();
				this._hostListeners.clear();
				await Promise.all(hostSrvs.map(closeServer));

				while (this._inflightRequests.size > 0) {
					await Promise.allSettled([...this._inflightRequests]);
				}

				if (!isWindows && this._activeSocketPath) {
					await this._unlinkQuietly(this._activeSocketPath).catch(() => undefined);
				}
				await this._idempotencyLedger.flush().catch(() => undefined);
			})();
		}
		return this._stopPromise;
	}

	override dispose(): void {
		void this.stopAndClose();
		super.dispose();
	}
}
