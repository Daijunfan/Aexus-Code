/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	CliClientError,
	readStdinWithTimeoutAndTempBypass,
	sendAuthenticatedCliRpc,
} from './adeCliTransport.ts';

const ALL_45_COMMANDS = new Set<string>([
	'ade_whoami',
	'ade_sysprompt_path',
	'ade_sysprompt_update',
	'ade_create',
	'ade_destroy',
	'ade_edit',
	'ade_list',
	'ade_get',
	'ade_detail',
	'ade_history',
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
]);

function resolveCallerHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}

function expandTildePath(raw: string, homeDir: string): string {
	if (raw === '~') {
		return homeDir;
	}
	if (raw.startsWith('~/') || raw.startsWith('~\\')) {
		return path.join(homeDir, raw.slice(2));
	}
	return raw;
}

function expandLocalCallerPath(raw: string, env: NodeJS.ProcessEnv = process.env): { readonly absPath: string; readonly hasTrailingSlash: boolean } {
	if (!raw || typeof raw !== 'string' || !raw.trim()) {
		throw new CliClientError('ERR_INVALID_ARGS', '文件路径参数不能为空');
	}
	const trimmed = raw.trim();
	const hasTrailingSlash = trimmed.endsWith('/') || trimmed.endsWith('\\');
	const expanded = expandTildePath(trimmed, resolveCallerHome(env));
	return { absPath: path.resolve(process.cwd(), expanded), hasTrailingSlash };
}

interface IParsedArgTokens {
	readonly positionals: string[];
	readonly flags: Map<string, string | boolean>;
}

const BOOLEAN_STANDALONE_FLAGS = new Set<string>([
	'--detail-stdin',
	'--stdin',
]);

function tokenizeCliArgv(argv: readonly string[]): IParsedArgTokens {
	const positionals: string[] = [];
	const flags = new Map<string, string | boolean>();

	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (!tok.startsWith('--')) {
			if (tok.startsWith('-') && tok.length > 1) {
				throw new CliClientError('ERR_INVALID_ARGS', `不支持短选项参数: ${tok}`);
			}
			positionals.push(tok);
			continue;
		}
		const eqIdx = tok.indexOf('=');
		if (eqIdx > 2) {
			const flagName = tok.slice(0, eqIdx);
			const val = tok.slice(eqIdx + 1);
			if (BOOLEAN_STANDALONE_FLAGS.has(flagName)) {
				throw new CliClientError('ERR_INVALID_ARGS', `${flagName} 不接受等号赋值`);
			}
			if (flags.has(flagName)) {
				throw new CliClientError('ERR_INVALID_ARGS', `重复传入了参数: ${flagName}`);
			}
			flags.set(flagName, val);
			continue;
		}

		if (flags.has(tok)) {
			throw new CliClientError('ERR_INVALID_ARGS', `重复传入了参数: ${tok}`);
		}
		if (BOOLEAN_STANDALONE_FLAGS.has(tok)) {
			flags.set(tok, true);
			continue;
		}
		if (i + 1 >= argv.length) {
			throw new CliClientError('ERR_INVALID_ARGS', `参数 ${tok} 缺少取值`);
		}
		flags.set(tok, argv[++i]);
	}

	return { positionals, flags };
}

function assertOnlyFlags(flags: ReadonlyMap<string, string | boolean>, allowed: readonly string[]): void {
	const set = new Set(allowed);
	for (const key of flags.keys()) {
		if (!set.has(key)) {
			throw new CliClientError('ERR_INVALID_ARGS', `不支持的命令选项: ${key}`);
		}
	}
}

function assertExactPositionals(positionals: readonly string[], expectedCount: number, usageHint: string): void {
	if (positionals.length !== expectedCount) {
		throw new CliClientError('ERR_INVALID_ARGS', `位置参数数量不合法（预期 ${expectedCount} 个，收到 ${positionals.length} 个）：${usageHint}`);
	}
}

function getStringFlag(flags: ReadonlyMap<string, string | boolean>, name: string, required = false): string | undefined {
	const val = flags.get(name);
	if (val === undefined) {
		if (required) {
			throw new CliClientError('ERR_INVALID_ARGS', `缺少必填参数 ${name}`);
		}
		return undefined;
	}
	if (typeof val !== 'string') {
		throw new CliClientError('ERR_INVALID_ARGS', `参数 ${name} 需要传入字符串值`);
	}
	return val;
}

async function applyDetailOptionToPayload(
	flags: ReadonlyMap<string, string | boolean>,
	out: Record<string, unknown>,
	env: NodeJS.ProcessEnv = process.env,
	createdTempFiles?: string[],
): Promise<void> {
	const hasInline = flags.has('--detail');
	const hasStdin = flags.get('--detail-stdin') === true;
	const hasFile = flags.has('--detail-file');
	if (Number(hasInline) + Number(hasStdin) + Number(hasFile) > 1) {
		throw new CliClientError('ERR_INVALID_ARGS', '--detail、--detail-stdin 与 --detail-file 最多只能三选一');
	}
	if (hasInline) {
		out.detail = String(flags.get('--detail') ?? '');
		return;
	}
	if (hasFile) {
		const rawPath = getStringFlag(flags, '--detail-file', true)!;
		out.detailFile = expandLocalCallerPath(rawPath, env).absPath;
		return;
	}
	if (hasStdin) {
		const readRes = await readStdinWithTimeoutAndTempBypass();
		if (readRes.tempFilePath) {
			createdTempFiles?.push(readRes.tempFilePath);
			out.detailTempFile = readRes.tempFilePath;
		} else {
			out.detail = readRes.inlineText ?? '';
		}
	}
}

async function buildRpcArgsForCommand(
	cmd: string,
	rawArgs: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	createdTempFiles?: string[],
): Promise<{ readonly rpcArgs: Record<string, unknown>; readonly idempotencyKey?: string }> {
	const { positionals, flags } = tokenizeCliArgv(rawArgs);
	const out: Record<string, unknown> = {};

	switch (cmd) {
		// ---------------- Module 0: Base ----------------
		case 'ade_whoami': {
			assertExactPositionals(positionals, 0, 'ade_whoami');
			assertOnlyFlags(flags, []);
			return { rpcArgs: out };
		}
		case 'ade_sysprompt_path': {
			assertExactPositionals(positionals, 0, 'ade_sysprompt_path [--module <all|ticket|orchestration|whiteboard>]');
			assertOnlyFlags(flags, ['--module']);
			const mod = getStringFlag(flags, '--module');
			if (mod !== undefined) { out.module = mod; }
			return { rpcArgs: out };
		}
		case 'ade_sysprompt_update': {
			assertExactPositionals(positionals, 0, 'ade_sysprompt_update [--since <rev>]');
			assertOnlyFlags(flags, ['--since']);
			const since = getStringFlag(flags, '--since');
			if (since !== undefined) { out.since = since; }
			return { rpcArgs: out };
		}

		// ---------------- Module 1: Ticket ----------------
		case 'ade_create': {
			assertExactPositionals(positionals, 0, 'ade_create --to <id> --type <type> --title "<title>" --summary "<summary>" --need-return <true|false>');
			assertOnlyFlags(flags, ['--to', '--type', '--title', '--summary', '--need-return', '--mode', '--detail', '--detail-stdin', '--detail-file']);
			out.to = getStringFlag(flags, '--to', true);
			out.type = getStringFlag(flags, '--type', true);
			out.title = getStringFlag(flags, '--title', true);
			out.summary = getStringFlag(flags, '--summary', true);
			out.needReturn = getStringFlag(flags, '--need-return', true);
			const mode = getStringFlag(flags, '--mode');
			if (mode !== undefined) { out.mode = mode; }
			await applyDetailOptionToPayload(flags, out, env, createdTempFiles);
			return { rpcArgs: out };
		}
		case 'ade_destroy': {
			assertExactPositionals(positionals, 1, 'ade_destroy <ticket_id>');
			assertOnlyFlags(flags, []);
			out.ticketId = positionals[0];
			return { rpcArgs: out };
		}
		case 'ade_edit': {
			assertExactPositionals(positionals, 1, 'ade_edit <ticket_id> --type <type> --title "<title>" --summary "<summary>" --need-return <true|false>');
			assertOnlyFlags(flags, ['--type', '--title', '--summary', '--need-return', '--mode', '--detail', '--detail-stdin', '--detail-file']);
			out.ticketId = positionals[0];
			out.type = getStringFlag(flags, '--type', true);
			out.title = getStringFlag(flags, '--title', true);
			out.summary = getStringFlag(flags, '--summary', true);
			out.needReturn = getStringFlag(flags, '--need-return', true);
			const mode = getStringFlag(flags, '--mode');
			if (mode !== undefined) { out.mode = mode; }
			await applyDetailOptionToPayload(flags, out, env, createdTempFiles);
			return { rpcArgs: out };
		}
		case 'ade_list': {
			assertExactPositionals(positionals, 0, 'ade_list');
			assertOnlyFlags(flags, []);
			return { rpcArgs: out };
		}
		case 'ade_get': {
			assertExactPositionals(positionals, 1, 'ade_get <ticket_id>');
			assertOnlyFlags(flags, []);
			out.ticketId = positionals[0];
			return { rpcArgs: out };
		}
		case 'ade_detail': {
			assertExactPositionals(positionals, 2, 'ade_detail <ticket_id> <task_id>');
			assertOnlyFlags(flags, []);
			out.ticketId = positionals[0];
			out.taskId = positionals[1];
			return { rpcArgs: out };
		}
		case 'ade_history': {
			assertExactPositionals(positionals, 1, 'ade_history <ticket_id>');
			assertOnlyFlags(flags, []);
			out.ticketId = positionals[0];
			return { rpcArgs: out };
		}

		// ---------------- Module 2: Orchestration ----------------
		case 'ade_host_list': {
			assertExactPositionals(positionals, 0, 'ade_host_list');
			assertOnlyFlags(flags, []);
			return { rpcArgs: out };
		}
		case 'ade_engine_list': {
			assertExactPositionals(positionals, 0, 'ade_engine_list --host <local|ip>');
			assertOnlyFlags(flags, ['--host']);
			out.host = getStringFlag(flags, '--host', true);
			return { rpcArgs: out };
		}
		case 'ade_model_list': {
			assertExactPositionals(positionals, 0, 'ade_model_list --host <local|ip> --engine <engine>');
			assertOnlyFlags(flags, ['--host', '--engine']);
			out.host = getStringFlag(flags, '--host', true);
			out.engine = getStringFlag(flags, '--engine', true);
			return { rpcArgs: out };
		}
		case 'ade_agent_list': {
			assertExactPositionals(positionals, 0, 'ade_agent_list [--depth <N>] [--depts <d1,d2,...>]');
			assertOnlyFlags(flags, ['--depth', '--depts']);
			const depth = getStringFlag(flags, '--depth');
			const depts = getStringFlag(flags, '--depts');
			if (depth !== undefined) { out.depth = depth; }
			if (depts !== undefined) { out.depts = depts; }
			return { rpcArgs: out };
		}
		case 'ade_agent_create': {
			assertExactPositionals(positionals, 0, 'ade_agent_create --host <local|ip> --engine <eng> --model <mdl> --effort <eff> --level <LN> --name "<name>" --role "<summary>" [--parent <pid>]');
			assertOnlyFlags(flags, ['--host', '--engine', '--model', '--effort', '--level', '--name', '--role', '--parent']);
			out.host = getStringFlag(flags, '--host', true);
			out.engine = getStringFlag(flags, '--engine', true);
			out.model = getStringFlag(flags, '--model', true);
			out.effort = getStringFlag(flags, '--effort', true);
			out.level = getStringFlag(flags, '--level', true);
			out.name = getStringFlag(flags, '--name', true);
			out.role = getStringFlag(flags, '--role', true);
			const parent = getStringFlag(flags, '--parent');
			if (parent !== undefined) { out.parent = parent; }
			return { rpcArgs: out };
		}
		case 'ade_agent_edit': {
			assertExactPositionals(positionals, 1, 'ade_agent_edit <agent_id> [...]');
			assertOnlyFlags(flags, ['--name', '--role', '--engine', '--model', '--effort']);
			out.agentId = positionals[0];
			for (const [f, k] of [['--name', 'name'], ['--role', 'role'], ['--engine', 'engine'], ['--model', 'model'], ['--effort', 'effort']] as const) {
				const v = getStringFlag(flags, f);
				if (v !== undefined) { out[k] = v; }
			}
			return { rpcArgs: out };
		}
		case 'ade_agent_move': {
			assertExactPositionals(positionals, 1, 'ade_agent_move <agent_id> --to-parent <new_parent_id>');
			assertOnlyFlags(flags, ['--to-parent']);
			out.agentId = positionals[0];
			out.toParent = getStringFlag(flags, '--to-parent', true);
			return { rpcArgs: out };
		}
		case 'ade_agent_delete': {
			assertExactPositionals(positionals, 1, 'ade_agent_delete <agent_id>');
			assertOnlyFlags(flags, []);
			out.agentId = positionals[0];
			return { rpcArgs: out };
		}
		case 'ade_dept_create': {
			assertExactPositionals(positionals, 0, 'ade_dept_create --root <agent_id> --name "<name>"');
			assertOnlyFlags(flags, ['--root', '--name']);
			out.root = getStringFlag(flags, '--root', true);
			out.name = getStringFlag(flags, '--name', true);
			return { rpcArgs: out };
		}
		case 'ade_dept_edit': {
			assertExactPositionals(positionals, 1, 'ade_dept_edit <dept_id> [--name "<name>"] [--board <id> --perm <perm>]');
			assertOnlyFlags(flags, ['--name', '--board', '--perm']);
			out.deptId = positionals[0];
			const name = getStringFlag(flags, '--name');
			const board = getStringFlag(flags, '--board');
			const perm = getStringFlag(flags, '--perm');
			if (name !== undefined) { out.name = name; }
			if (board !== undefined) { out.board = board; }
			if (perm !== undefined) { out.perm = perm; }
			return { rpcArgs: out };
		}
		case 'ade_dept_delete': {
			assertExactPositionals(positionals, 1, 'ade_dept_delete <dept_id>');
			assertOnlyFlags(flags, []);
			out.deptId = positionals[0];
			return { rpcArgs: out };
		}
		case 'ade_dept_member': {
			assertExactPositionals(positionals, 1, 'ade_dept_member <dept_id> --agent <agent_id> --action <out|in>');
			assertOnlyFlags(flags, ['--agent', '--action']);
			out.deptId = positionals[0];
			out.agent = getStringFlag(flags, '--agent', true);
			out.action = getStringFlag(flags, '--action', true);
			return { rpcArgs: out };
		}
		case 'ade_dept_members': {
			if (positionals.length > 1) {
				throw new CliClientError('ERR_INVALID_ARGS', 'ade_dept_members 最多接受 1 个可选 <dept_id> 位置参数');
			}
			assertOnlyFlags(flags, ['--depts']);
			if (positionals[0]) { out.deptId = positionals[0]; }
			const depts = getStringFlag(flags, '--depts');
			if (depts !== undefined) { out.depts = depts; }
			return { rpcArgs: out };
		}
		case 'ade_dept_info': {
			assertExactPositionals(positionals, 0, 'ade_dept_info [--agent <subordinate_id>]');
			assertOnlyFlags(flags, ['--agent']);
			const ag = getStringFlag(flags, '--agent');
			if (ag !== undefined) { out.agent = ag; }
			return { rpcArgs: out };
		}
		case 'ade_wb_grant': {
			assertExactPositionals(positionals, 1, 'ade_wb_grant <board_id> --to <agent_id> --perm <read|write|read_write|none>');
			assertOnlyFlags(flags, ['--to', '--perm']);
			out.boardId = positionals[0];
			out.to = getStringFlag(flags, '--to', true);
			out.perm = getStringFlag(flags, '--perm', true);
			return { rpcArgs: out };
		}

		// ---------------- Module 3: White Board ----------------
		case 'ade_wb_list': {
			assertExactPositionals(positionals, 0, 'ade_wb_list');
			assertOnlyFlags(flags, []);
			return { rpcArgs: out };
		}
		case 'ade_wb_my_perm':
		case 'ade_wb_members':
		case 'ade_wb_delete':
		case 'ade_wb_tags':
		case 'ade_wb_note_unread': {
			assertExactPositionals(positionals, 1, `${cmd} <board_id>`);
			assertOnlyFlags(flags, []);
			out.boardId = positionals[0];
			return { rpcArgs: out };
		}
		case 'ade_wb_create': {
			assertExactPositionals(positionals, 0, 'ade_wb_create --name "<name>" [--dept <id>] [--host <local|ip>] [--tags <t1,t2,...>]');
			assertOnlyFlags(flags, ['--name', '--dept', '--host', '--tags']);
			out.name = getStringFlag(flags, '--name', true);
			for (const [f, k] of [['--dept', 'dept'], ['--host', 'host'], ['--tags', 'tags']] as const) {
				const v = getStringFlag(flags, f);
				if (v !== undefined) { out[k] = v; }
			}
			return { rpcArgs: out };
		}
		case 'ade_wb_config': {
			assertExactPositionals(positionals, 1, 'ade_wb_config <board_id> [--name "<name>"] [--host <local|ip>]');
			assertOnlyFlags(flags, ['--name', '--host']);
			out.boardId = positionals[0];
			const name = getStringFlag(flags, '--name');
			const host = getStringFlag(flags, '--host');
			if (name !== undefined) { out.name = name; }
			if (host !== undefined) { out.host = host; }
			return { rpcArgs: out };
		}
		case 'ade_wb_tag_manage': {
			assertExactPositionals(positionals, 1, 'ade_wb_tag_manage <board_id> --action <add|remove> --tags <t1,t2,...>');
			assertOnlyFlags(flags, ['--action', '--tags']);
			out.boardId = positionals[0];
			out.action = getStringFlag(flags, '--action', true);
			out.tags = getStringFlag(flags, '--tags', true);
			return { rpcArgs: out };
		}
		case 'ade_wb_post_msg': {
			assertExactPositionals(positionals, 1, 'ade_wb_post_msg <board_id> --summary "<summary>" --stars <1..5> [...]');
			assertOnlyFlags(flags, ['--summary', '--stars', '--tags', '--detail', '--detail-stdin', '--detail-file']);
			out.boardId = positionals[0];
			out.summary = getStringFlag(flags, '--summary', true);
			out.stars = getStringFlag(flags, '--stars', true);
			const tags = getStringFlag(flags, '--tags');
			if (tags !== undefined) { out.tags = tags; }
			await applyDetailOptionToPayload(flags, out, env, createdTempFiles);
			return { rpcArgs: out };
		}
		case 'ade_wb_upload_file': {
			assertExactPositionals(positionals, 1, 'ade_wb_upload_file <board_id> --file <path> --summary "<summary>" --stars <1..5> [--tags <...>]');
			assertOnlyFlags(flags, ['--file', '--summary', '--stars', '--tags']);
			out.boardId = positionals[0];
			out.file = expandLocalCallerPath(getStringFlag(flags, '--file', true)!, env).absPath;
			out.summary = getStringFlag(flags, '--summary', true);
			out.stars = getStringFlag(flags, '--stars', true);
			const tags = getStringFlag(flags, '--tags');
			if (tags !== undefined) { out.tags = tags; }
			return { rpcArgs: out };
		}
		case 'ade_wb_items': {
			assertExactPositionals(positionals, 1, 'ade_wb_items <board_id> [...]');
			assertOnlyFlags(flags, ['--sort', '--limit', '--author', '--tag', '--type', '--stars']);
			out.boardId = positionals[0];
			for (const [f, k] of [['--sort', 'sort'], ['--limit', 'limit'], ['--author', 'author'], ['--tag', 'tag'], ['--type', 'type'], ['--stars', 'stars']] as const) {
				const v = getStringFlag(flags, f);
				if (v !== undefined) { out[k] = v; }
			}
			return { rpcArgs: out };
		}
		case 'ade_wb_get_msg':
		case 'ade_wb_delete_item': {
			assertExactPositionals(positionals, 2, `${cmd} <board_id> <item_id>`);
			assertOnlyFlags(flags, []);
			out.boardId = positionals[0];
			out.itemId = positionals[1];
			return { rpcArgs: out };
		}
		case 'ade_wb_download': {
			assertExactPositionals(positionals, 2, 'ade_wb_download <board_id> <item_id> --dest <path>');
			assertOnlyFlags(flags, ['--dest']);
			out.boardId = positionals[0];
			out.itemId = positionals[1];
			const resolved = expandLocalCallerPath(getStringFlag(flags, '--dest', true)!, env);
			out.dest = resolved.absPath;
			if (resolved.hasTrailingSlash) {
				out.destIsDirHint = true;
			}
			return { rpcArgs: out };
		}
		case 'ade_wb_edit_item': {
			assertExactPositionals(positionals, 2, 'ade_wb_edit_item <board_id> <item_id> [...]');
			assertOnlyFlags(flags, ['--summary', '--stars', '--tags', '--detail', '--detail-stdin', '--detail-file', '--file']);
			out.boardId = positionals[0];
			out.itemId = positionals[1];
			const summary = getStringFlag(flags, '--summary');
			const stars = getStringFlag(flags, '--stars');
			const tags = getStringFlag(flags, '--tags');
			const fileRaw = getStringFlag(flags, '--file');
			if (summary !== undefined) { out.summary = summary; }
			if (stars !== undefined) { out.stars = stars; }
			if (tags !== undefined) { out.tags = tags; }
			if (fileRaw !== undefined) { out.file = expandLocalCallerPath(fileRaw, env).absPath; }
			await applyDetailOptionToPayload(flags, out, env, createdTempFiles);
			return { rpcArgs: out };
		}
		case 'ade_wb_manage_item': {
			assertExactPositionals(positionals, 2, 'ade_wb_manage_item <board_id> <item_id> [--pin <true|false>] [--stars <1..5>] [--tags <...>]');
			assertOnlyFlags(flags, ['--pin', '--stars', '--tags']);
			out.boardId = positionals[0];
			out.itemId = positionals[1];
			const pin = getStringFlag(flags, '--pin');
			const stars = getStringFlag(flags, '--stars');
			const tags = getStringFlag(flags, '--tags');
			if (pin !== undefined) { out.pin = pin; }
			if (stars !== undefined) { out.stars = stars; }
			if (tags !== undefined) { out.tags = tags; }
			return { rpcArgs: out };
		}
		case 'ade_wb_note_send': {
			assertExactPositionals(positionals, 1, 'ade_wb_note_send <board_id> --to <agent_id> (--text "<text>" | --stdin)');
			assertOnlyFlags(flags, ['--to', '--text', '--stdin']);
			out.boardId = positionals[0];
			out.to = getStringFlag(flags, '--to', true);
			const hasText = flags.has('--text');
			const hasStdin = flags.get('--stdin') === true;
			if ((hasText && hasStdin) || (!hasText && !hasStdin)) {
				throw new CliClientError('ERR_INVALID_ARGS', 'ade_wb_note_send 必须且仅能传入 --text 或 --stdin 之一');
			}
			if (hasText) {
				out.text = getStringFlag(flags, '--text', true);
			} else {
				const readRes = await readStdinWithTimeoutAndTempBypass();
				if (readRes.tempFilePath) {
					createdTempFiles?.push(readRes.tempFilePath);
					out.stdinTempFile = readRes.tempFilePath;
				} else {
					out.text = readRes.inlineText ?? '';
				}
			}
			return { rpcArgs: out };
		}
		case 'ade_wb_note_detail': {
			assertExactPositionals(positionals, 2, 'ade_wb_note_detail <board_id> <note_id>');
			assertOnlyFlags(flags, []);
			out.boardId = positionals[0];
			out.noteId = positionals[1];
			return { rpcArgs: out };
		}
		case 'ade_wb_unread_all': {
			assertExactPositionals(positionals, 0, 'ade_wb_unread_all');
			assertOnlyFlags(flags, []);
			return { rpcArgs: out };
		}
		default:
			throw new CliClientError('ERR_INVALID_ARGS', `未知的 ADE 命令: ${cmd}`);
	}
}

export { ALL_45_COMMANDS, buildRpcArgsForCommand };

function resolveInvokedCommandAndArgs(argv: readonly string[], env: NodeJS.ProcessEnv): { readonly cmd: string; readonly rest: readonly string[] } {
	const fromEnv = env.ADE_INVOKED_CMD?.trim() || env.ADE_CLI_CMD?.trim();
	if (fromEnv && ALL_45_COMMANDS.has(fromEnv)) {
		return { cmd: fromEnv, rest: argv.slice(2) };
	}
	const argv1Base = path.basename(argv[1] ?? '').replace(/\.(?:cmd|bat|exe|js|mjs)$/i, '');
	if (ALL_45_COMMANDS.has(argv1Base)) {
		return { cmd: argv1Base, rest: argv.slice(2) };
	}
	const argv2 = (argv[2] ?? '').trim();
	if (ALL_45_COMMANDS.has(argv2)) {
		return { cmd: argv2, rest: argv.slice(3) };
	}
	throw new CliClientError('ERR_INVALID_ARGS', `无法识别所调用的 ade_* 命令 (${argv1Base || argv2 || 'empty'})`);
}

function normalizeSyspromptLocalPathsIfNeeded(cmd: string, result: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
	if (cmd !== 'ade_sysprompt_path' || result.ok !== true || typeof result.doc_rev !== 'number') {
		return result;
	}
	const callerHome = resolveCallerHome(env);
	const isRemote = Boolean(env.ADE_CONTROL_BRIDGE_FILE?.trim());
	const adeRoot = isRemote
		? path.join(callerHome, '.ade_store')
		: (env.AEXUS_ADE_HOME?.trim() ? expandTildePath(env.AEXUS_ADE_HOME.trim(), callerHome) : path.join(callerHome, '.aexus-code'));
	const realBaseDir = isRemote
		? path.join(adeRoot, 'sysprompts', `v${result.doc_rev}`)
		: (typeof result.base_dir === 'string' && result.base_dir.trim()
			? path.resolve(expandTildePath(result.base_dir.trim(), callerHome))
			: path.join(adeRoot, 'sysprompts', `v${result.doc_rev}`));
	const rawFiles = (result.files && typeof result.files === 'object') ? result.files as Record<string, string> : {};
	const nextFiles: Record<string, string> = {};
	for (const [modKey, rawPath] of Object.entries(rawFiles)) {
		if (!isRemote && typeof rawPath === 'string' && rawPath.trim()) {
			nextFiles[modKey] = path.resolve(expandTildePath(rawPath.trim(), callerHome));
		} else {
			nextFiles[modKey] = path.join(realBaseDir, `${modKey}.md`);
		}
	}
	return {
		ok: true,
		doc_rev: result.doc_rev,
		base_dir: realBaseDir,
		files: nextFiles,
	};
}

export async function runAdeCliMain(
	argv: readonly string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
	rpcOptions?: {
		readonly connectStream?: (endpoint: import('./adeCliTransport.ts').IResolvedControlEndpoint) => import('node:stream').Duplex;
		readonly writeStdout?: (line: string) => void;
	},
): Promise<number> {
	const writeOut = rpcOptions?.writeStdout ?? ((line: string) => { process.stdout.write(line); });
	const createdTempFiles: string[] = [];
	let serverConsumedTempFiles = false;
	try {
		const { cmd, rest } = resolveInvokedCommandAndArgs(argv, env);
		const { rpcArgs, idempotencyKey } = await buildRpcArgsForCommand(cmd, rest, env, createdTempFiles);
		const rawResponse = await sendAuthenticatedCliRpc(cmd, rpcArgs, {
			env,
			idempotencyKey,
			connectStream: rpcOptions?.connectStream,
		});
		const finalPayload = normalizeSyspromptLocalPathsIfNeeded(cmd, rawResponse, env);
		serverConsumedTempFiles = finalPayload.ok === true;
		writeOut(JSON.stringify(finalPayload) + '\n');
		return finalPayload.ok === true ? 0 : 1;
	} catch (err) {
		const code = err instanceof CliClientError ? err.code : 'ERR_INVALID_ARGS';
		const message = err instanceof Error ? err.message : String(err);
		writeOut(JSON.stringify({ ok: false, code, error: message }) + '\n');
		return 1;
	} finally {
		if (!serverConsumedTempFiles) {
			for (const tempFilePath of createdTempFiles) {
				await fs.unlink(tempFilePath).catch(() => undefined);
			}
		}
	}
}

if (typeof require !== 'undefined' && require.main === module) {
	void runAdeCliMain().then(exitCode => {
		process.exitCode = exitCode;
	});
}
