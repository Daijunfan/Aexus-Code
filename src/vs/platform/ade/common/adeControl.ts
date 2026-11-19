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

export const ADE_CONTROL_DIR_NAME = '.aexus-code';
export const ADE_CONTROL_SOCKET_NAME = 'ade-control.sock';
export const ADE_CONTROL_META_NAME = 'ade-control.json';

export type AdeBuiltInAgentRole = 'governor' | 'manager' | 'employee' | 'subordinate';
export type AdeAgentRole = AdeBuiltInAgentRole | (string & {});
export type AdeSessionRank = AdeAgentRole | 'worker';

export interface IAdeControlConnectionMetadata {
	readonly socketPath: string;
	readonly token: string;
	readonly pid: number;
}

export interface IAdeControlWireRequest {
	readonly token: string;
	readonly action: string;
	readonly params?: Record<string, unknown>;
	readonly windowId?: number;
}

export interface IAdeControlWireResponse<T = unknown> {
	readonly ok: boolean;
	readonly result?: T;
	readonly error?: string;
}

export interface IAdeControlDispatchRequest {
	readonly action: string;
	readonly params?: Record<string, unknown>;
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
	readonly resource?: string;
	readonly draft?: string;
	readonly status: 'idle' | 'working' | 'pending' | 'draft';
	readonly unread: boolean;
	readonly archived: boolean;
	readonly childrenIds: readonly string[];
	readonly treeType?: 'engineering' | 'research';
	readonly treeGovernorId?: string;
	readonly treeSegmentId?: string;
	readonly treeNodeId?: string;
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
	readonly rolePrompt?: string;
	readonly preferredModel?: string;
	readonly preferredThinking?: string;
}

export interface IAdeRoleSyncSnapshot {
	readonly mode: 'ade' | 'ide';
	readonly activeAgentId?: string;
	readonly selectedAgentId?: string;
	readonly agents: readonly IAdeRoleSyncAgentEntry[];
}
