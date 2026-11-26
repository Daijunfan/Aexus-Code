/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AdeCliCommandName } from './adeCliManifest.js';
import { AdeErrorCode } from './adeModels.js';

export const ADE_CONTROL_CHANNEL_NAME = 'adeControl';
export const ADE_CONTROL_EXECUTE_COMMAND_ID = 'aexus.ade.control.execute';
export const ADE_BIND_NATIVE_SESSION_COMMAND_ID = 'aexus.ade.bindNativeSession';
export const ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID = 'aexus.ade.syncSessionPreferences';
export const ADE_GET_WINDOW_ID_COMMAND_ID = 'aexus.ade.getWindowId';
export const ADE_DISPATCH_TICKET_TURN_COMMAND_ID = 'aexus.ade.dispatchTicketTurn';
export const ADE_CANCEL_TICKET_TURNS_COMMAND_ID = 'aexus.ade.cancelTicketTurns';
export const ADE_DISPOSE_AGENT_RUNTIME_COMMAND_ID = 'aexus.ade.disposeAgentRuntime';

export const ADE_CONTROL_DIR_NAME = '.aexus-code';
export const ADE_REMOTE_STORE_DIR_NAME = '.ade_store';
export const ADE_CONTROL_SOCKET_PREFIX = 'ade-control';

export const ADE_AGENT_TOKEN_PREFIX = 'ades1.';
export const ADE_AGENT_TOKEN_ENV_KEY = 'ADE_AGENT_TOKEN';
export const ADE_CONTROL_ENDPOINT_ENV_KEY = 'ADE_CONTROL_ENDPOINT';
export const ADE_CONTROL_BRIDGE_FILE_ENV_KEY = 'ADE_CONTROL_BRIDGE_FILE';
export const ADE_CLI_CMD_ENV_KEY = 'ADE_CLI_CMD';
export const ADE_NODE_EXEC_ENV_KEY = 'ADE_NODE_EXEC';
export const ADE_ELECTRON_EXEC_ENV_KEY = 'ADE_ELECTRON_EXEC';

/**
 * All ADE control-plane & legacy environment keys that MUST be stripped from non-ADE IDE sessions.
 */
export const ADE_CONTROL_ENV_KEYS = [
	ADE_AGENT_TOKEN_ENV_KEY,
	ADE_CONTROL_ENDPOINT_ENV_KEY,
	ADE_CONTROL_BRIDGE_FILE_ENV_KEY,
	ADE_CLI_CMD_ENV_KEY,
	ADE_NODE_EXEC_ENV_KEY,
	ADE_ELECTRON_EXEC_ENV_KEY,
	'AEXUS_ADE_CONTROL_FILE',
	'AEXUS_ADE_TOKEN',
	'AEXUS_ADE_SOCKET',
	'AEXUS_ADE_TCP_PORT',
	'AEXUS_ADE_SESSION_TOKEN',
	'AEXUS_ADE_CALLER',
	'AEXUS_ADE_WINDOW_ID',
	'AEXUS_ADE_WINDOW_KEY',
	'AEXUS_ADE_AGENTS_DIST_DIR',
] as const;

const ADE_CONTROL_ENV_KEY_SET = new Set<string>(ADE_CONTROL_ENV_KEYS.map(k => k.toUpperCase()));

/**
 * Returns a shallow copy of `env` with all ADE control-plane credentials and routing variables removed
 * (case-insensitively for Windows compatibility).
 */
export function stripAdeControlEnv<T extends Record<string, string | undefined>>(env: T): T {
	const cleaned: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		const upper = key.toUpperCase();
		if (!ADE_CONTROL_ENV_KEY_SET.has(upper) && !upper.startsWith('AEXUS_ADE_')) {
			cleaned[key] = value;
		}
	}
	return cleaned as T;
}

/**
 * Token-free remote bridge endpoint pointer file (`0600` on remote host: `$HOME/.ade_store/_run/bridge-<hash>.json`).
 * NEVER contains any secret or token.
 */
export interface IAdeRemoteBridgePointer {
	readonly endpoint: string; // e.g. `unix:/home/user/.ade_store/_run/b-xxx.sock` or `tcp:127.0.0.1:54321`
	readonly updatedAt: number;
}

/**
 * Step 1 of full-duplex mutual HMAC-SHA256 handshake: server sends a 256-bit random nonce immediately upon connection.
 */
export interface IAdeHmacServerChallengeFrame {
	readonly type: 'challenge';
	readonly nonce: string; // 64-char hex (32 random bytes)
	readonly serverTime: number;
}

/**
 * Step 2 of full-duplex mutual HMAC-SHA256 handshake: client sends `jti` + request body + `reqProof`
 * (`HMAC-SHA256(secret, "req:" + nonce + ":" + jti + ":" + rawPayloadJson)`). The secret NEVER crosses the wire.
 */
export interface IAdeHmacClientRequestFrame {
	readonly type: 'request';
	readonly jti: string;
	readonly payloadJson: string;
	readonly reqProof: string; // hex
}

export interface IAdeCliWireRequestPayload {
	readonly command: AdeCliCommandName;
	readonly args: Readonly<Record<string, unknown>>;
	readonly cwd?: string;
	readonly idempotencyKey?: string;
}

/**
 * Step 3 of full-duplex mutual HMAC-SHA256 handshake: server replies with response JSON + `resProof`
 * (`HMAC-SHA256(secret, "res:" + nonce + ":" + jti + ":" + rawResponseJson)`).
 */
export interface IAdeHmacServerResponseFrame {
	readonly type: 'response';
	readonly responseJson: string;
	readonly resProof?: string; // present whenever `jti` resolved a valid secret
}

export interface IAdeControlWireResponse<T = Record<string, unknown>> {
	readonly ok: boolean;
	readonly result?: T;
	readonly code?: AdeErrorCode;
	readonly error?: string;
	readonly idempotentReplay?: boolean;
}

export interface IAdeControlDispatchRequest {
	readonly action: string;
	readonly params?: Record<string, unknown>;
	readonly idempotencyKey?: string;
}

