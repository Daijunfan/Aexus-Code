/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const ADE_CONTROL_CHANNEL_NAME = 'adeControl';
export const ADE_CONTROL_EXECUTE_COMMAND_ID = 'aexus.ade.control.execute';
export const ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID = 'aexus.ade.resolvePromptContext';
export const ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID = 'aexus.ade.getRoleSyncSnapshot';
export const ADE_BIND_NATIVE_SESSION_COMMAND_ID = 'aexus.ade.bindNativeSession';
export const ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID = 'aexus.ade.syncSessionPreferences';
export const ADE_SET_SESSION_GOAL_BANNER_COMMAND_ID = 'aexus.ade.setSessionGoalBanner';
export const ADE_SET_SESSION_INITIALIZING_COMMAND_ID = 'aexus.ade.setSessionInitializing';
export const ADE_GET_WINDOW_ID_COMMAND_ID = 'aexus.ade.getWindowId';

export const ADE_CONTROL_DIR_NAME = '.aexus-code';
export const ADE_CONTROL_SOCKET_NAME = 'ade-control.sock';
export const ADE_CONTROL_META_NAME = 'ade-control.json';
export const ADE_CAPABILITY_TOKEN_PREFIX = 'aexus-cap.';
export const ADE_MINT_SESSION_TOKEN_ACTION = 'auth.mintSessionToken';
export const ADE_REVOKE_SESSION_TOKEN_ACTION = 'auth.revokeSessionToken';

export const ADE_CONTROL_ENV_KEYS = [
	'AEXUS_ADE_CONTROL_FILE',
	'AEXUS_ADE_TOKEN',
	'AEXUS_ADE_SOCKET',
	'AEXUS_ADE_TCP_PORT',
	'AEXUS_ADE_SESSION_TOKEN',
	'AEXUS_ADE_CALLER',
	'AEXUS_ADE_WINDOW_ID',
] as const;

const ADE_CONTROL_ENV_KEY_SET = new Set<string>(ADE_CONTROL_ENV_KEYS);

/**
 * Returns a shallow copy of `env` with all local ADE control-plane credentials and
 * routing variables removed (case-insensitively for Windows compatibility).
 */
export function stripAdeControlEnv<T extends Record<string, string | undefined>>(env: T): T {
	const cleaned: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!ADE_CONTROL_ENV_KEY_SET.has(key.toUpperCase())) {
			cleaned[key] = value;
		}
	}
	return cleaned as T;
}

export type AdeBuiltInAgentRole = 'governor' | 'manager' | 'employee' | 'subordinate';
export type AdeAgentRole = AdeBuiltInAgentRole | (string & {});
export type AdeSessionRank = AdeAgentRole | 'worker';

export interface IAdeCapabilityTokenPayload {
	readonly sid: string;
	readonly rank: string;
	readonly pure?: boolean;
	readonly missionNode?: boolean;
	/** Originating workbench window ID pinned into this capability token at mint time. */
	readonly wid?: number;
	readonly iat: number;
	/** Optional absolute expiration timestamp (epoch ms) enforced by AdeControlServer. */
	readonly exp?: number;
}

export interface IAdeControlConnectionMetadata {
	readonly socketPath: string;
	readonly token: string;
	readonly pid: number;
	readonly tcpPort?: number;
}

export interface IAdeControlWireRequest {
	readonly token: string;
	readonly action: string;
	readonly params?: Record<string, unknown>;
	readonly windowId?: number;
	/** Optional client-generated idempotency key (`1..128` `[A-Za-z0-9._:-]+`) for safe at-most-once mutation retries. */
	readonly idempotencyKey?: string;
}

export interface IAdeControlWireResponse<T = unknown> {
	readonly ok: boolean;
	readonly result?: T;
	readonly error?: string;
	/** True when `result` was replayed from the control-plane idempotency ledger without re-executing the mutation. */
	readonly idempotentReplay?: boolean;
}

export interface IAdeControlDispatchRequest {
	readonly action: string;
	readonly params?: Record<string, unknown>;
	readonly idempotencyKey?: string;
}

export interface IAdeProjectSummary {
	readonly name: string;
	readonly path: string;
	readonly uri: string;
	readonly focused: boolean;
	readonly selected: boolean;
	readonly activeSessionCount: number;
}

export interface IAdeSessionSummary {
	readonly id: string;
	readonly parentId?: string;
	readonly projectPath: string;
	readonly projectName: string;
	readonly label: string;
	readonly role?: AdeAgentRole;
	readonly rank: AdeSessionRank;
	readonly isOrchestrated: boolean;
	readonly engineId?: string;
	readonly engineName?: string;
	readonly preferredModel?: string;
	readonly preferredThinking?: string;
	readonly resource?: string;
	readonly draft?: string;
	readonly status: 'idle' | 'working' | 'pending' | 'draft';
	readonly unread: boolean;
	readonly archived: boolean;
	readonly childrenIds: readonly string[];
	readonly treeType?: 'engineering' | 'research' | 'mission';
	readonly treeGovernorId?: string;
	readonly treeSegmentId?: string;
	readonly treeNodeId?: string;
	readonly treeNodeIds?: readonly string[];
	readonly lockedByWorkTree?: boolean;
}

export interface IAdeSessionTreeNode {
	readonly session: IAdeSessionSummary;
	readonly depth: number;
	readonly children: readonly IAdeSessionTreeNode[];
}

export interface IAdeSessionTreeResult {
	readonly root: IAdeSessionTreeNode;
	readonly directCount: number;
	readonly totalSubordinates: number;
	readonly maxDepth: number;
}

export interface IAdeControlStatus {
	readonly mode: 'ade' | 'ide';
	readonly showArchived: boolean;
	readonly navigation: {
		readonly isFocused: boolean;
		readonly focusedProject?: { readonly name: string; readonly path: string; readonly uri: string };
		readonly canGoForward: boolean;
	};
	readonly selectedProject?: { readonly name: string; readonly path: string; readonly uri: string };
	readonly selectedSession?: IAdeSessionSummary;
	readonly activeEditor?: {
		readonly kind: 'secretary' | 'session' | 'engineering' | 'file' | 'other';
		readonly agentId?: string;
		readonly governorSessionId?: string;
		readonly label: string;
		readonly resource?: string;
		readonly role?: AdeAgentRole;
		readonly rank?: AdeSessionRank;
		readonly engineId?: string;
	};
	readonly secretary: {
		readonly configured: boolean;
		readonly engineId?: string;
		readonly label: string;
		readonly status: 'idle' | 'working' | 'draft';
		readonly resource?: string;
	};
	readonly counts: {
		readonly projects: number;
		readonly activeRootSessions: number;
		readonly totalActiveSessions: number;
		readonly archived: number;
	};
}

export interface IAdeRoleSyncAgentEntry {
	readonly id: string;
	readonly label: string;
	readonly projectPath: string;
	readonly engineId?: string;
	readonly resource?: string;
	readonly nativeSessionId?: string;
	readonly rank: AdeSessionRank;
	readonly isOrchestrated: boolean;
	readonly isWorkTree?: boolean;
	readonly isMissionNode?: boolean;
	readonly rolePrompt?: string;
	/** KV-cache invariant static role charter prefix (omits volatile session title / draft engine labels). */
	readonly staticRoleCharter?: string;
	/** Stable hash computed exclusively over `staticRoleCharter` for prompt-cache-friendly role initialization. */
	readonly staticRoleHash?: string;
	readonly preferredModel?: string;
	readonly preferredThinking?: string;
}

export interface IAdeRoleSyncSnapshot {
	readonly mode: 'ade' | 'ide';
	readonly activeAgentId?: string;
	readonly selectedAgentId?: string;
	readonly agents: readonly IAdeRoleSyncAgentEntry[];
}
