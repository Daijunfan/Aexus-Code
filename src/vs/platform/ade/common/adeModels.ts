/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Authoritative domain models, closed-set error codes (28), and wire envelopes
 * for the refactored ADE lightweight multi-agent orchestration system.
 *
 * Strictly pure TypeScript (zero Node.js imports) to satisfy `valid-layers-check`.
 */

export const ADE_REGISTERED_ENGINES = [
	'claude',
	'codex',
	'kilo',
	'opencode',
	'dsh',
	'antigravity',
	'cline',
	'pi',
] as const;

export type AdeEngineId = (typeof ADE_REGISTERED_ENGINES)[number];

export const ADE_EFFORT_LEVELS = [
	'none',
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'extra-high',
	'max',
	'ultra',
] as const;

export type AdeEffortLevel = (typeof ADE_EFFORT_LEVELS)[number];

export function isAdeEffortLevel(value: string): value is AdeEffortLevel {
	return (ADE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Closed set of 28 standard error codes across Ticket (9), Orchestration (11), and Whiteboard (8).
 */
export type AdeErrorCode =
	// 1. Ticket (9)
	| 'ERR_UNAUTHORIZED'
	| 'ERR_TICKET_NOT_FOUND'
	| 'ERR_FORBIDDEN'
	| 'ERR_CROSS_PROJECT'
	| 'ERR_LEVEL_EXCEEDED'
	| 'ERR_NOT_HOLDER'
	| 'ERR_RETURN_REQUIRED'
	| 'ERR_DETAIL_NOT_FOUND'
	| 'ERR_INVALID_ARGS'
	// 2. Orchestration (11)
	| 'ERR_FORBIDDEN_HIERARCHY'
	| 'ERR_CROSS_DEPT'
	| 'ERR_AGENT_NOT_FOUND'
	| 'ERR_ENGINE_LOCKED'
	| 'ERR_HAS_SUBORDINATES'
	| 'ERR_NOT_IN_DEPT_TREE'
	| 'ERR_BOARD_NOT_OWNER'
	| 'ERR_BOARD_NOT_IN_DEPT'
	| 'ERR_PEER_TICKET_FORBIDDEN'
	| 'ERR_TICKET_FROZEN'
	| 'ERR_IS_DEPT_ROOT'
	// 3. White Board (8)
	| 'ERR_BOARD_NOT_FOUND'
	| 'ERR_WB_FORBIDDEN'
	| 'ERR_WB_NOT_OWNER'
	| 'ERR_DEPT_BOARD_EXISTS'
	| 'ERR_INVALID_TAG'
	| 'ERR_ITEM_NOT_AUTHOR'
	| 'ERR_FILE_NOT_READABLE'
	| 'ERR_NOTE_TARGET_INVALID';

export const ADE_ERROR_CODES: readonly AdeErrorCode[] = [
	'ERR_UNAUTHORIZED',
	'ERR_TICKET_NOT_FOUND',
	'ERR_FORBIDDEN',
	'ERR_CROSS_PROJECT',
	'ERR_LEVEL_EXCEEDED',
	'ERR_NOT_HOLDER',
	'ERR_RETURN_REQUIRED',
	'ERR_DETAIL_NOT_FOUND',
	'ERR_INVALID_ARGS',
	'ERR_FORBIDDEN_HIERARCHY',
	'ERR_CROSS_DEPT',
	'ERR_AGENT_NOT_FOUND',
	'ERR_ENGINE_LOCKED',
	'ERR_HAS_SUBORDINATES',
	'ERR_NOT_IN_DEPT_TREE',
	'ERR_BOARD_NOT_OWNER',
	'ERR_BOARD_NOT_IN_DEPT',
	'ERR_PEER_TICKET_FORBIDDEN',
	'ERR_TICKET_FROZEN',
	'ERR_IS_DEPT_ROOT',
	'ERR_BOARD_NOT_FOUND',
	'ERR_WB_FORBIDDEN',
	'ERR_WB_NOT_OWNER',
	'ERR_DEPT_BOARD_EXISTS',
	'ERR_INVALID_TAG',
	'ERR_ITEM_NOT_AUTHOR',
	'ERR_FILE_NOT_READABLE',
	'ERR_NOTE_TARGET_INVALID',
] as const;

export class AdeError extends Error {
	readonly code: AdeErrorCode;

	constructor(
		code: AdeErrorCode,
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = 'AdeError';
	}
}

export function isAdeError(err: unknown): err is AdeError {
	return err instanceof AdeError || Boolean(
		err && typeof err === 'object' && Object.prototype.hasOwnProperty.call(err, 'code') && typeof (err as { code?: unknown }).code === 'string'
		&& (ADE_ERROR_CODES as readonly string[]).includes((err as { code: string }).code),
	);
}

/**
 * Exact system prefix head for Ticket delivery messages.
 * Full line 1 MUST be `"[系统提示词: 此消息是来自Agent {<from_id>}的Ticket] "` (note trailing single ASCII space!).
 */
export const ADE_TICKET_SYSTEM_PREFIX_HEAD = '[系统提示词: 此消息是来自Agent {';
export const ADE_TICKET_SYSTEM_PREFIX_TAIL = '}的Ticket] ';

export function buildAdeTicketSystemPrefix(fromAgentId: string): string {
	return `${ADE_TICKET_SYSTEM_PREFIX_HEAD}${fromAgentId}${ADE_TICKET_SYSTEM_PREFIX_TAIL}`;
}

export function collapseSingleLineSummary(raw: string): string {
	return raw.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function formatAdeTicketDeliveryPayload(input: {
	readonly fromId: string;
	readonly ticketId: string;
	readonly taskId: string;
	readonly taskType: string;
	readonly needReturn: boolean;
	readonly hasDetailRef: boolean;
	readonly hasHistoryRef: boolean;
	readonly taskTitle: string;
	readonly summary: string;
}): string {
	const prefix = buildAdeTicketSystemPrefix(input.fromId);
	const cleanTitle = collapseSingleLineSummary(input.taskTitle);
	const cleanSummary = collapseSingleLineSummary(input.summary);
	return [
		prefix,
		`ticket_id: ${input.ticketId} | task_id: ${input.taskId} | task_type: ${input.taskType} | need_return: ${input.needReturn ? 'true' : 'false'}`,
		`has_detail_ref: ${input.hasDetailRef ? 'true' : 'false'} | has_history_ref: ${input.hasHistoryRef ? 'true' : 'false'}`,
		`task_title: ${cleanTitle}`,
		`summary: ${cleanSummary}`,
	].join('\n');
}

export function formatLevelLabel(level: number): string {
	return `L${Math.max(1, Math.floor(level))}`;
}

export function parseLevelInput(raw: string | number): number {
	if (typeof raw === 'number') {
		if (!Number.isInteger(raw) || raw < 1) {
			throw new AdeError('ERR_INVALID_ARGS', 'level 必须为大于等于 1 的正整数');
		}
		return raw;
	}
	const trimmed = raw.trim();
	const m = /^[Ll]?([1-9]\d*)$/.exec(trimmed);
	if (!m) {
		throw new AdeError('ERR_INVALID_ARGS', `非法的职级格式: ${raw}`);
	}
	return Number.parseInt(m[1], 10);
}

export function canonicalEdgePairKey(agentA: string, agentB: string): string {
	return agentA < agentB ? `${agentA}<->${agentB}` : `${agentB}<->${agentA}`;
}

export type AdeLayoutDirection = 'TD' | 'LR' | 'RADIAL' | 'GRID';
export type AdeSessionPhase = 'unstarted' | 'starting' | 'started';
export type AdeTicketDeliveryMode = 'queue' | 'steer';
export type AdeOutboxDeliveryState = 'pending' | 'claimed' | 'acked' | 'failed' | 'blocked_cli';
export type AdeTicketLifecycleStatus = 'active' | 'frozen_orphan' | 'destroyed';
export type AdeBoardPermission = 'read' | 'write' | 'read_write';
export type AdeEffectiveBoardPermission = 'owner' | AdeBoardPermission | 'none';
export type AdeMigrationState = 'idle' | 'transferring' | 'completed' | 'failed';

export interface IAdeBlobPointer {
	readonly blob_id: string;
	readonly storage_host: string; // 'local' or cloud host IP
	readonly storage_path: string;
	readonly size_bytes: number;
	readonly sha256: string;
	readonly content_rev: number;
}

export interface IAdeWorkspaceFolder {
	readonly folder_id: string;
	readonly folder_uri: string;
	readonly display_name: string;
	readonly host: string; // 'local' or cloud host IP
	readonly sort_order: number;
	readonly collapsed: boolean;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeProjectSummaryItem {
	readonly project_id: string;
	readonly folder_id: string;
	readonly folder_uri: string;
	readonly name: string;
	readonly sort_order: number;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeCatalogSnapshot {
	readonly folders: readonly IAdeWorkspaceFolder[];
	readonly projects: readonly IAdeProjectSummaryItem[];
}

export interface IAdeProjectHostEntry {
	readonly host_id: string;
	readonly ip: string;
	readonly name: string;
	readonly ssh_alias: string;
	readonly os_kind: 'linux' | 'macos' | 'windows';
	readonly remote_home?: string;
}

export interface IAdeProjectMeta {
	readonly project_id: string;
	readonly folder_id: string;
	readonly folder_uri: string;
	readonly name: string;
	readonly cross_host_ticket_storage: string;
	readonly ticket_migration_epoch: number;
	readonly ticket_migration_state: AdeMigrationState;
	readonly layout_direction: AdeLayoutDirection;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeAgentNode {
	readonly agent_id: string;
	readonly project_id: string;
	readonly level: number;
	readonly is_top_role: boolean;
	readonly parent_id: string | null;
	readonly name: string;
	readonly role_summary: string;
	readonly host: string;
	readonly engine: string;
	readonly model: string;
	readonly effort: string;
	readonly session_phase: AdeSessionPhase;
	readonly session_started: boolean;
	readonly excluded_dept_ids: readonly string[];
	readonly session_resource?: string;
	readonly native_session_id?: string;
	readonly last_read_doc_rev: number;
	readonly token_gen: number;
	readonly canvas_x?: number;
	readonly canvas_y?: number;
	readonly color_token?: string;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeDeletedAgentArchive {
	readonly agent_id: string;
	readonly project_id: string;
	readonly name: string;
	readonly level: number;
	readonly role_summary: string;
	readonly host: string;
	readonly deleted_at: number;
}

export interface IAdeDepartment {
	readonly dept_id: string;
	readonly project_id: string;
	readonly name: string;
	readonly root_agent_id: string;
	readonly parent_dept_id: string | null;
	readonly board_permissions: Readonly<Record<string, AdeBoardPermission>>;
	readonly created_by: string;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeBoardGrant {
	readonly board_id: string;
	readonly agent_id: string;
	readonly permission: AdeBoardPermission;
	readonly granted_by: string;
	readonly updated_at: number;
}

export interface IAdeWhiteboard {
	readonly board_id: string;
	readonly project_id: string;
	readonly name: string;
	readonly owner_id: string | null;
	readonly dept_id: string | null;
	readonly storage_host: string;
	readonly tag_categories: readonly string[];
	readonly migration_epoch: number;
	readonly migration_state: AdeMigrationState;
	readonly migration_progress?: {
		readonly total_items: number;
		readonly completed_items: number;
		readonly last_error?: string;
	};
	readonly canvas_x?: number;
	readonly canvas_y?: number;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeBoardItemPublicSummary {
	readonly item_id: string;
	readonly item_type: 'msg' | 'file';
	readonly author_id: string;
	readonly summary: string;
	readonly stars: 1 | 2 | 3 | 4 | 5;
	readonly tags: readonly string[];
	readonly is_pinned: boolean;
	readonly has_detail: boolean;
	readonly file_meta: { readonly filename: string; readonly size_bytes: number } | null;
	readonly created_at: number;
}

export interface IAdeBoardNotePublicItem {
	readonly note_id: string;
	readonly from_id: string;
	readonly content_preview: string;
	readonly has_detail: boolean;
	readonly created_at: number;
}

export interface IAdeTicketTaskPublic {
	readonly task_id: string;
	readonly task_type: string;
	readonly task_title: string;
	readonly task_comment: {
		readonly summary: string;
		readonly has_detail_ref: boolean;
	};
}

/**
 * Exact 10-field public Ticket view mandated by Rebuild/Ticket.md (`ade_get`).
 */
export interface IAdeTicketPublicView {
	readonly ticket_id: string;
	readonly project_id: string;
	readonly creator_id: string;
	readonly ticket_level: number;
	readonly from_id: string;
	readonly to_id: string;
	readonly delivery_mode: AdeTicketDeliveryMode;
	readonly need_return: boolean;
	readonly current_task: IAdeTicketTaskPublic;
	readonly has_history_ref: boolean;
}

export interface IAdeTicketSummaryCard {
	readonly ticket_id: string;
	readonly creator_id: string;
	readonly peer_id: string;
	readonly ticket_level: number;
	readonly from_id: string;
	readonly to_id: string;
	readonly holder_id: string | null;
	readonly delivery_mode: AdeTicketDeliveryMode;
	readonly need_return: boolean;
	readonly current_task_id: string;
	readonly current_task_type: string;
	readonly current_task_title: string;
	readonly current_task_summary: string;
	readonly current_has_detail_ref: boolean;
	readonly has_history_ref: boolean;
	readonly status: AdeTicketLifecycleStatus;
	readonly created_at: number;
	readonly updated_at: number;
}

export interface IAdeProjectSnapshot {
	readonly meta: IAdeProjectMeta;
	readonly hosts: readonly IAdeProjectHostEntry[];
	readonly agents: readonly IAdeAgentNode[];
	readonly deleted_agents: readonly IAdeDeletedAgentArchive[];
	readonly departments: readonly IAdeDepartment[];
	readonly whiteboards: readonly IAdeWhiteboard[];
	readonly board_grants: readonly IAdeBoardGrant[];
	readonly tickets: readonly IAdeTicketSummaryCard[];
	readonly edge_latest_transfer_at: Readonly<Record<string, number>>;
}

export interface IAdeTicketTransferHop {
	readonly edge_pair_key: string;
	readonly hop_from_id: string;
	readonly hop_to_id: string;
	readonly hop_seq: number;
	readonly total_hops: number;
}

export interface IAdeTicketTransferAnimationEvent {
	readonly transfer_group_id: string;
	readonly project_id: string;
	readonly ticket_id: string;
	readonly task_id: string;
	readonly origin_from_id: string;
	readonly target_to_id: string;
	readonly transferred_at: number;
	readonly hops: readonly IAdeTicketTransferHop[];
}

export interface IAdeEdgeTransferRecord {
	readonly transfer_id: string;
	readonly project_id: string;
	readonly edge_pair_key: string;
	readonly hop_from_id: string;
	readonly hop_to_id: string;
	readonly hop_seq: number;
	readonly total_hops: number;
	readonly origin_from_id: string;
	readonly origin_from_name: string;
	readonly target_to_id: string;
	readonly target_to_name: string;
	readonly ticket_id: string;
	readonly task_id: string;
	readonly action_kind: 'create' | 'edit';
	readonly task_type: string;
	readonly task_title: string;
	readonly summary: string;
	readonly has_detail_ref: boolean;
	readonly ticket_status: AdeTicketLifecycleStatus;
	readonly transferred_at: number;
}

export interface IAdeUiTicketTaskRecord {
	readonly task_id: string;
	readonly seq: number;
	readonly is_archived: boolean;
	readonly from_id: string;
	readonly from_name: string;
	readonly to_id: string;
	readonly to_name: string;
	readonly delivery_mode: AdeTicketDeliveryMode;
	readonly need_return: boolean;
	readonly task_type: string;
	readonly task_title: string;
	readonly summary: string;
	readonly has_detail_ref: boolean;
	readonly detail_truncated: boolean;
	readonly created_at: number;
}

export interface IAdeUiCanvasLayoutPatch {
	readonly layoutDirection?: AdeLayoutDirection;
	readonly nodePositions?: Readonly<Record<string, { readonly x: number; readonly y: number; readonly color?: string }>>;
	readonly resetPinnedPositions?: boolean;
}

export interface IAdeUiTicketFullInspection {
	readonly public_ticket: IAdeTicketPublicView;
	readonly status: AdeTicketLifecycleStatus;
	readonly creator_name: string;
	readonly peer_id: string;
	readonly peer_name: string;
	readonly created_at: number;
	readonly updated_at: number;
	readonly frozen_at?: number;
	readonly destroyed_at?: number;
	readonly all_tasks: readonly IAdeUiTicketTaskRecord[];
}
