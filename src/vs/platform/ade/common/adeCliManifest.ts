/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AdeEngineId,
	AdeError,
	ADE_REGISTERED_ENGINES,
	IAdeBoardItemPublicSummary,
	IAdeBoardNotePublicItem,
	IAdeTicketPublicView,
} from './adeModels.js';

/**
 * Single source of truth for all 45 `ade_*` CLI executables across Modules 0–3:
 * - Module 0 (Base): 3 commands
 * - Module 1 (Ticket): 7 commands
 * - Module 2 (Orchestration): 15 commands
 * - Module 3 (White Board): 20 commands
 */
export const ADE_BASE_COMMANDS = [
	'ade_whoami',
	'ade_sysprompt_path',
	'ade_sysprompt_update',
] as const;

export const ADE_TICKET_COMMANDS = [
	'ade_create',
	'ade_destroy',
	'ade_edit',
	'ade_list',
	'ade_get',
	'ade_detail',
	'ade_history',
] as const;

export const ADE_ORCHESTRATION_COMMANDS = [
	'ade_host_list',
	'ade_engine_list',
	'ade_model_list',
	'ade_agent_list',
	'ade_agent_create',
	'ade_agent_edit',
	'ade_agent_move',
	'ade_agent_delete',
	'ade_dept_create',
	'ade_dept_edit',
	'ade_dept_delete',
	'ade_dept_member',
	'ade_dept_members',
	'ade_dept_info',
	'ade_wb_grant',
] as const;

export const ADE_WHITEBOARD_COMMANDS = [
	'ade_wb_list',
	'ade_wb_my_perm',
	'ade_wb_members',
	'ade_wb_create',
	'ade_wb_config',
	'ade_wb_delete',
	'ade_wb_tags',
	'ade_wb_tag_manage',
	'ade_wb_post_msg',
	'ade_wb_upload_file',
	'ade_wb_items',
	'ade_wb_get_msg',
	'ade_wb_download',
	'ade_wb_edit_item',
	'ade_wb_delete_item',
	'ade_wb_manage_item',
	'ade_wb_note_send',
	'ade_wb_note_unread',
	'ade_wb_note_detail',
	'ade_wb_unread_all',
] as const;

export const ADE_CLI_COMMANDS = [
	...ADE_BASE_COMMANDS,
	...ADE_TICKET_COMMANDS,
	...ADE_ORCHESTRATION_COMMANDS,
	...ADE_WHITEBOARD_COMMANDS,
] as const;

export type AdeCliCommandName = (typeof ADE_CLI_COMMANDS)[number];

const ADE_CLI_COMMAND_SET = new Set<string>(ADE_CLI_COMMANDS);

export function isAdeCliCommandName(value: string): value is AdeCliCommandName {
	return ADE_CLI_COMMAND_SET.has(value);
}

/**
 * The 17 single-whiteboard commands whose top-level JSON response MUST include `unread_count: number`
 * (every `ade_wb_*` command targeting `<board_id>` except `ade_wb_delete`; `ade_wb_list` and `ade_wb_unread_all` are global).
 */
export const ADE_WB_COMMANDS_WITH_UNREAD_COUNT: readonly AdeCliCommandName[] = [
	'ade_wb_my_perm',
	'ade_wb_members',
	'ade_wb_create',
	'ade_wb_config',
	'ade_wb_tags',
	'ade_wb_tag_manage',
	'ade_wb_post_msg',
	'ade_wb_upload_file',
	'ade_wb_items',
	'ade_wb_get_msg',
	'ade_wb_download',
	'ade_wb_edit_item',
	'ade_wb_delete_item',
	'ade_wb_manage_item',
	'ade_wb_note_send',
	'ade_wb_note_unread',
	'ade_wb_note_detail',
] as const;

/**
 * Read-only CLI commands safe for idempotent retries without ledger mutation replay.
 */
export const ADE_READONLY_CLI_COMMANDS = new Set<AdeCliCommandName>([
	'ade_whoami',
	'ade_sysprompt_path',
	'ade_list',
	'ade_get',
	'ade_detail',
	'ade_history',
	'ade_host_list',
	'ade_engine_list',
	'ade_model_list',
	'ade_agent_list',
	'ade_dept_members',
	'ade_dept_info',
	'ade_wb_list',
	'ade_wb_my_perm',
	'ade_wb_members',
	'ade_wb_tags',
	'ade_wb_items',
	'ade_wb_get_msg',
	'ade_wb_note_detail',
	'ade_wb_unread_all',
]);

const REGISTERED_ENGINE_SET = new Set<string>(ADE_REGISTERED_ENGINES);

/**
 * Normalizes CLI engine aliases (such as `"claude-code"` -> `"claude"`) to the 8 canonical registered engines.
 */
export function normalizeAdeEngineId(raw: string): AdeEngineId {
	const cleaned = raw.trim().toLowerCase();
	if (cleaned === 'claude-code') {
		return 'claude';
	}
	if (REGISTERED_ENGINE_SET.has(cleaned)) {
		return cleaned as AdeEngineId;
	}
	throw new AdeError('ERR_INVALID_ARGS', `不支持的引擎标识: ${raw}（可用引擎: ${ADE_REGISTERED_ENGINES.join(', ')}）`);
}

/**
 * Strict field whitelist projection for `ade_get` (exact 10 top-level Ticket fields per Rebuild/Ticket.md).
 */
export function projectTicketPublicView(source: {
	readonly ticket_id: string;
	readonly project_id: string;
	readonly creator_id: string;
	readonly ticket_level: number;
	readonly from_id: string;
	readonly to_id: string;
	readonly delivery_mode: 'queue' | 'steer';
	readonly need_return: boolean;
	readonly current_task_id: string;
	readonly current_task_type: string;
	readonly current_task_title: string;
	readonly current_task_summary: string;
	readonly current_has_detail_ref: boolean;
	readonly has_history_ref: boolean;
}): IAdeTicketPublicView {
	return {
		ticket_id: source.ticket_id,
		project_id: source.project_id,
		creator_id: source.creator_id,
		ticket_level: source.ticket_level,
		from_id: source.from_id,
		to_id: source.to_id,
		delivery_mode: source.delivery_mode,
		need_return: source.need_return,
		current_task: {
			task_id: source.current_task_id,
			task_type: source.current_task_type,
			task_title: source.current_task_title,
			task_comment: {
				summary: source.current_task_summary,
				has_detail_ref: source.current_has_detail_ref,
			},
		},
		has_history_ref: source.has_history_ref,
	};
}

/**
 * Strict 10-field whitelist projection for `ade_wb_items` (never leaks `updated_at` or internal storage fields).
 */
export function projectBoardItemPublicSummary(source: {
	readonly item_id: string;
	readonly item_type: 'msg' | 'file';
	readonly author_id: string;
	readonly summary: string;
	readonly stars: number;
	readonly tags: readonly string[];
	readonly is_pinned: boolean;
	readonly has_detail: boolean;
	readonly file_filename?: string | null;
	readonly file_size?: number | null;
	readonly created_at: number;
}): IAdeBoardItemPublicSummary {
	return {
		item_id: source.item_id,
		item_type: source.item_type,
		author_id: source.author_id,
		summary: source.summary,
		stars: Math.max(1, Math.min(5, Math.round(source.stars))) as 1 | 2 | 3 | 4 | 5,
		tags: [...source.tags],
		is_pinned: Boolean(source.is_pinned),
		has_detail: source.item_type === 'msg' ? Boolean(source.has_detail) : false,
		file_meta: source.item_type === 'file' && source.file_filename !== undefined && source.file_filename !== null
			? { filename: source.file_filename, size_bytes: Number(source.file_size ?? 0) }
			: null,
		created_at: source.created_at,
	};
}

/**
 * Strict 5-field whitelist projection for `ade_wb_note_unread` items (never leaks `to_id`).
 */
export function projectBoardNoteUnreadItem(source: {
	readonly note_id: string;
	readonly from_id: string;
	readonly content_preview: string;
	readonly has_detail: boolean;
	readonly created_at: number;
}): IAdeBoardNotePublicItem {
	return {
		note_id: source.note_id,
		from_id: source.from_id,
		content_preview: source.content_preview,
		has_detail: Boolean(source.has_detail),
		created_at: source.created_at,
	};
}
