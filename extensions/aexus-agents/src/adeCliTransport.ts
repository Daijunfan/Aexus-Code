/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';

export const STDIN_TEMP_BYPASS_THRESHOLD_BYTES = 64 * 1024;
export const EMPTY_PIPE_FIRST_BYTE_TIMEOUT_MS = 3_000;
const CONTROL_RPC_TIMEOUT_MS = 60_000;

export class CliClientError extends Error {
	readonly code: string;

	constructor(
		code: string,
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = 'CliClientError';
	}
}

export interface IParsedAgentToken {
	readonly jti: string;
	readonly secret: Buffer;
}

export function parseAgentTokenFromEnv(env: NodeJS.ProcessEnv = process.env): IParsedAgentToken {
	const raw = env.ADE_AGENT_TOKEN?.trim();
	if (!raw || !raw.startsWith('ades1.')) {
		throw new CliClientError('ERR_UNAUTHORIZED', '未检测到合法的 ADE_AGENT_TOKEN 会话环境变量凭证');
	}
	const parts = raw.split('.');
	if (parts.length !== 3 || !parts[1] || !parts[2]) {
		throw new CliClientError('ERR_UNAUTHORIZED', 'ADE_AGENT_TOKEN 凭证格式非法');
	}
	let secret: Buffer;
	try {
		secret = Buffer.from(parts[2], 'base64url');
	} catch {
		throw new CliClientError('ERR_UNAUTHORIZED', 'ADE_AGENT_TOKEN 密钥解码失败');
	}
	if (secret.byteLength < 16) {
		throw new CliClientError('ERR_UNAUTHORIZED', 'ADE_AGENT_TOKEN 密钥长度不足');
	}
	return { jti: parts[1], secret };
}

export interface IResolvedControlEndpoint {
	readonly kind: 'unix' | 'tcp';
	readonly socketPath?: string;
	readonly host?: string;
	readonly port?: number;
}

export function parseEndpointString(raw: string): IResolvedControlEndpoint | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.startsWith('unix:')) {
		const sp = trimmed.slice('unix:'.length).trim();
		return sp ? { kind: 'unix', socketPath: sp } : undefined;
	}
	const tcpMatch = /^tcp:(?:\/\/)?([^/:]+):(\d+)$/i.exec(trimmed);
	if (tcpMatch) {
		const port = Number.parseInt(tcpMatch[2], 10);
		if (Number.isInteger(port) && port > 0 && port <= 65535) {
			return { kind: 'tcp', host: tcpMatch[1], port };
		}
	}
	if (trimmed.startsWith('/') || trimmed.startsWith('\\\\.\\pipe\\')) {
		return { kind: 'unix', socketPath: trimmed };
	}
	return undefined;
}

export async function resolveControlEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<IResolvedControlEndpoint> {
	// 1. Zero-secret `bridge.json` pointer takes priority on remote cloud hosts so reconnected SSH tunnels self-heal!
	const bridgeFile = env.ADE_CONTROL_BRIDGE_FILE?.trim();
	if (bridgeFile) {
		try {
			const raw = await fs.readFile(bridgeFile, 'utf8');
			const parsed = JSON.parse(raw) as { endpoint?: unknown; socketPath?: unknown; tcpPort?: unknown };
			if (typeof parsed.endpoint === 'string') {
				const ep = parseEndpointString(parsed.endpoint);
				if (ep) {
					return ep;
				}
			}
			if (typeof parsed.socketPath === 'string' && parsed.socketPath.trim()) {
				return { kind: 'unix', socketPath: parsed.socketPath.trim() };
			}
			if (typeof parsed.tcpPort === 'number' && Number.isInteger(parsed.tcpPort) && parsed.tcpPort > 0) {
				return { kind: 'tcp', host: '127.0.0.1', port: parsed.tcpPort };
			}
		} catch {
			// Fall back to explicit env vars below
		}
	}

	const explicitEndpoint = env.ADE_CONTROL_ENDPOINT?.trim();
	if (explicitEndpoint) {
		const parsed = parseEndpointString(explicitEndpoint);
		if (parsed) {
			return parsed;
		}
	}

	const explicitSocket = env.ADE_CONTROL_SOCKET?.trim();
	if (explicitSocket) {
		return { kind: 'unix', socketPath: explicitSocket };
	}

	if (process.platform !== 'win32') {
		const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
		const defaultSock = path.join(os.homedir(), '.aexus-code', 'run', `ade-control-${uid}.sock`);
		return { kind: 'unix', socketPath: defaultSock };
	}

	throw new CliClientError('ERR_UNAUTHORIZED', '未找到可用的 ADE 控制中心通信端点');
}

/**
 * Reads standard input with a strict 3000ms first-byte timeout on non-TTY pipes (preventing LLM hang when `--stdin` / `--detail-stdin` is passed without piped data).
 * When payload exceeds 64KB, writes to a `0700` local temp file and returns `{ tempFilePath }` so control frames remain tiny (<4KB JSON).
 */
export async function readStdinWithTimeoutAndTempBypass(options?: {
	readonly alwaysTempFile?: boolean;
	readonly firstByteTimeoutMs?: number;
	readonly tempDirOverride?: string;
}): Promise<{ readonly inlineText?: string; readonly tempFilePath?: string; readonly byteLength: number }> {
	if (process.stdin.isTTY) {
		throw new CliClientError('ERR_INVALID_ARGS', '指定了标准输入参数，但当前终端未通过管道提供任何输入数据');
	}
	const firstByteTimeoutMs = options?.firstByteTimeoutMs ?? EMPTY_PIPE_FIRST_BYTE_TIMEOUT_MS;

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	await new Promise<void>((resolve, reject) => {
		let gotFirstChunkOrEof = false;
		let settled = false;

		const cleanup = () => {
			clearTimeout(firstByteTimer);
			process.stdin.off('data', onData);
			process.stdin.off('end', onEnd);
			process.stdin.off('error', onErr);
		};

		const firstByteTimer = setTimeout(() => {
			if (!gotFirstChunkOrEof && !settled) {
				settled = true;
				cleanup();
				try { process.stdin.pause(); } catch { /* ignore */ }
				reject(new CliClientError('ERR_INVALID_ARGS', `标准输入管道在 ${firstByteTimeoutMs}ms 内未收到任何字节或 EOF`));
			}
		}, firstByteTimeoutMs);

		const onData = (chunk: Buffer | string) => {
			gotFirstChunkOrEof = true;
			clearTimeout(firstByteTimer);
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
			totalBytes += buf.byteLength;
			chunks.push(buf);
		};

		const onEnd = () => {
			gotFirstChunkOrEof = true;
			if (!settled) {
				settled = true;
				cleanup();
				resolve();
			}
		};

		const onErr = (err: Error) => {
			if (!settled) {
				settled = true;
				cleanup();
				reject(new CliClientError('ERR_INVALID_ARGS', `读取标准输入失败: ${err.message}`));
			}
		};

		process.stdin.on('data', onData);
		process.stdin.once('end', onEnd);
		process.stdin.once('error', onErr);
		process.stdin.resume();
	});

	const fullBuf = Buffer.concat(chunks, totalBytes);
	if (!options?.alwaysTempFile && fullBuf.byteLength <= STDIN_TEMP_BYPASS_THRESHOLD_BYTES) {
		return { inlineText: fullBuf.toString('utf8'), byteLength: fullBuf.byteLength };
	}

	const baseTmpRoot = options?.tempDirOverride ?? path.join(os.tmpdir(), `ade-cli-${typeof process.getuid === 'function' ? process.getuid() : 'u'}`);
	await fs.mkdir(baseTmpRoot, { recursive: true, mode: 0o700 });
	if (process.platform !== 'win32') {
		try { await fs.chmod(baseTmpRoot, 0o700); } catch { /* ignore */ }
	}
	const tempFilePath = path.join(baseTmpRoot, `stdin-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
	await fs.writeFile(tempFilePath, fullBuf, { mode: 0o600 });
	return { tempFilePath, byteLength: fullBuf.byteLength };
}

export function computeCliHmacRequestProof(secret: Buffer, nonce: string, jti: string, payloadJson: string): string {
	return crypto.createHmac('sha256', secret).update(`req:${nonce}:${jti}:${payloadJson}`, 'utf8').digest('hex');
}

export function computeCliHmacResponseProof(secret: Buffer, nonce: string, jti: string, responseJson: string): string {
	return crypto.createHmac('sha256', secret).update(`res:${nonce}:${jti}:${responseJson}`, 'utf8').digest('hex');
}

/**
 * Executes a full-duplex mutual HMAC-SHA256 RPC call over UDS or SSH reverse bridge:
 * 1. Server sends `{ type: "challenge", nonce, serverTime }`
 * 2. Client writes `{ type: "request", jti, payloadJson, reqProof }` via `socket.write()` (NEVER `socket.end()` before response, avoiding OpenSSH `-R` `CHANNEL_EOF` truncation!)
 * 3. Server replies `{ type: "response", responseJson, resProof }`; client verifies `resProof` before returning!
 */
export async function sendAuthenticatedCliRpc(
	command: string,
	argsObj: Readonly<Record<string, unknown>>,
	options?: {
		readonly env?: NodeJS.ProcessEnv;
		readonly cwd?: string;
		readonly idempotencyKey?: string;
		readonly timeoutMs?: number;
		readonly connectStream?: (endpoint: IResolvedControlEndpoint) => Duplex;
	},
): Promise<Record<string, unknown>> {
	const env = options?.env ?? process.env;
	const { jti, secret } = parseAgentTokenFromEnv(env);
	const endpoint = await resolveControlEndpointFromEnv(env);
	const idempKey = options?.idempotencyKey?.trim() ?? '';
	const payloadJson = JSON.stringify({
		command,
		args: argsObj,
		cwd: options?.cwd ?? process.cwd(),
		...(idempKey ? { idempotencyKey: idempKey } : {}),
	});
	const timeoutMs = options?.timeoutMs ?? CONTROL_RPC_TIMEOUT_MS;

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		let settled = false;
		let stage: 'await_challenge' | 'await_response' = 'await_challenge';
		let receivedNonce = '';
		let lineBuffer = '';

		const socket: Duplex = options?.connectStream
			? options.connectStream(endpoint)
			: (endpoint.kind === 'unix'
				? net.createConnection({ path: endpoint.socketPath! })
				: net.createConnection({ host: endpoint.host ?? '127.0.0.1', port: endpoint.port! }));

		const finish = (fn: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			try { socket.destroy(); } catch { /* ignore */ }
			fn();
		};

		const timer = setTimeout(() => {
			finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', `连接 ADE 控制中心超时 (${timeoutMs}ms)`)));
		}, timeoutMs);

		socket.setEncoding('utf8');

		socket.on('error', err => {
			finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', `无法连接 ADE 控制中心通道: ${err.message}`)));
		});

		socket.on('close', () => {
			if (!settled) {
				finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', 'ADE 控制中心连接在收到完整响应前意外关闭')));
			}
		});

		const handleFrameLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) {
				return;
			}
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '收到损坏的控制中心帧 JSON')));
				return;
			}

			if (stage === 'await_challenge') {
				if (frame.type !== 'challenge' || typeof frame.nonce !== 'string' || frame.nonce.length < 16) {
					finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '未收到合法的控制中心握手挑战帧')));
					return;
				}
				receivedNonce = frame.nonce;
				const reqProof = computeCliHmacRequestProof(secret, receivedNonce, jti, payloadJson);
				stage = 'await_response';
				const reqFrame = {
					type: 'request',
					jti,
					payloadJson,
					reqProof,
				};
				socket.write(JSON.stringify(reqFrame) + '\n');
				return;
			}

			if (frame.type !== 'response' || typeof frame.responseJson !== 'string') {
				finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '控制中心返回了非法响应帧结构')));
				return;
			}

			let parsedBody: Record<string, unknown>;
			try {
				parsedBody = JSON.parse(frame.responseJson) as Record<string, unknown>;
			} catch {
				finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '控制中心响应正文 JSON 解析失败')));
				return;
			}

			// Require mutual HMAC `resProof` on every response except pre-auth handshake/framing rejections!
			const hasResProof = typeof frame.resProof === 'string' && frame.resProof.length > 0;
			const isPreAuthRejection = parsedBody.ok === false
				&& (parsedBody.code === 'ERR_UNAUTHORIZED' || parsedBody.code === 'ERR_INVALID_ARGS');
			if (!hasResProof && !isPreAuthRejection) {
				finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '控制中心响应缺少双向 HMAC 签名')));
				return;
			}
			if (hasResProof) {
				if (!/^[0-9a-f]{64}$/i.test(frame.resProof as string)) {
					finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '控制中心响应双向 HMAC 签名格式非法')));
					return;
				}
				const expectedProof = computeCliHmacResponseProof(secret, receivedNonce, jti, frame.responseJson);
				const actualBuf = Buffer.from(frame.resProof as string, 'hex');
				const expectedBuf = Buffer.from(expectedProof, 'hex');
				if (actualBuf.byteLength !== expectedBuf.byteLength || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
					finish(() => reject(new CliClientError('ERR_UNAUTHORIZED', '控制中心响应双向 HMAC 签名校验失败')));
					return;
				}
			}

			finish(() => resolve(parsedBody));
		};

		socket.on('data', (chunk: string) => {
			lineBuffer += chunk;
			let nlIdx = lineBuffer.indexOf('\n');
			while (nlIdx !== -1 && !settled) {
				const line = lineBuffer.slice(0, nlIdx);
				lineBuffer = lineBuffer.slice(nlIdx + 1);
				handleFrameLine(line);
				nlIdx = lineBuffer.indexOf('\n');
			}
		});
	});
}
