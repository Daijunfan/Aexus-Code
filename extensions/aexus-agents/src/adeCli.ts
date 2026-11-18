/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export const ADE_CONTROL_DIR_NAME = '.aexus-code';
export const ADE_CONTROL_META_NAME = 'ade-control.json';

export type AdeAgentRole = 'governor' | 'manager' | 'employee' | 'subordinate';

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

export interface AdeCliIo {
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
}

export interface ParsedCliInvocation {
	readonly help: boolean;
	readonly json: boolean;
	readonly windowId?: number;
	readonly action?: string;
	readonly fallbackAction?: string;
	readonly params?: Record<string, unknown>;
}

const VALID_ROLES = new Set<string>(['governor', 'manager', 'employee', 'subordinate', 'worker']);

const HELP_TEXT = `Usage: aexus-ade [options] <command> [args]

Control the running Aexus Code ADE workbench over its local control socket.

Global Options:
  -h, --help                Show this help message and exit
  --json                    Print structured JSON output
  --window <id>             Target a specific workbench window ID

Organizational Ranks (governor [L1] > manager [L2] > employee [L3] > worker [L4] — IMPORTANT: employee != worker):
  governor  (L1)  Top executive orchestrator; oversees manager/employee/worker and designs Engineering DAG blueprints.
  manager   (L2)  Module / segment lead overseeing employee & worker; performs segment-level secondary review.
  employee  (L3)  Orchestrated supervisory & acceptance-review rank ABOVE worker (Employee IS NOT Worker / Employee != Worker):
                  holds full aexus-ade subordinate control APIs over leaf workers; in Engineering trees, strictly audits
                  worker diffs & writes incremental node reports (never writes business code itself).
  worker    (L4)  Lowest pure execution leaf rank BELOW employee: cannot have subordinates and runs with 100% clean
                  native Coding Agent context (zero ADE role/API prompt injection) to execute actual coding tasks.

Commands:
  status
  view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh]

  project list
  project add <path...> [--name <label>]
  project select <target>
  project remove <target>
  project delete <target> [--sessions] [--files] [--permanent]
  project focus <target>
  project home
  project forward
  project move <source> (--before <target> | --after <target>)
  project changes [target]
  project files [target] [--path <subpath>] [--depth <n>]
  project open-file <file> [--project <target>] [--side]
  project open-diff <file> [--project <target>]

  engine list
  engine sessions <engine> [--project <target>] [--limit <n>]

  session list [--project <p>] [--parent <id|root>] [--role <governor|manager|employee|worker>] [--engine <e>] [--status <idle|working|pending|draft>] [--unread] [--archived] [--all]
  session info <id>
  session subordinates [id] [--recursive]
  session tree [id]
  session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <governor|manager|employee|worker>] [--draft [text]] [--side] [--no-open]
  session attach --engine <e> --native-id <nativeId> [--project <p>] [--title <t>] [--parent <id>] [--role <governor|manager|employee|worker>] [--side] [--no-open]
  session connect <id> --engine <e> [--native-id <nativeId>] [--side] [--no-open]
  session open <id> [--side]
  session select <id>
  session close <id>
  session mark-read (<id> | --all)
  session draft <id> [<text> | --clear]
  session rename <id> <title>
  session role <id> <governor|manager|employee|worker|none>
  session move <id> <parentId|none> [--project <p>]
  session nest <id> <parentId|none> [--project <p>]
  session reorder <id> (--before <targetId> | --after <targetId>)
  session send <id> <prompt> [--wait]
  session history <id> [--limit <n>]
  session stop <id>
  session archive <id>
  session unarchive <id>
  session detach|remove <id>
  session delete <id> [--force]

  secretary [status]
  secretary open [--side]
  secretary engine <e>
  secretary reset [--engine <e>]
  secretary send <prompt> [--wait]
  secretary history [--limit <n>]
  secretary stop
  secretary draft [<text> | --clear]
  secretary mark-read

  engineering init --governor <id> [--on-children <relocate|delete> [--target <id>]] [--tree-type <engineering|research>]
  engineering list [--project <path>] [--tree-type <engineering|research>]
  engineering open --governor <id> [--side]
  engineering blueprint get --governor <id>
  engineering blueprint apply --governor <id> (--file <path> | --text <markdown>) [--force-stop-running]
  engineering run --governor <id>
  engineering pause --governor <id>
  engineering resume --governor <id>
  engineering stop --governor <id>
  engineering status --governor <id> [--node <nodeId>]
  engineering review --governor <id> --node <nodeId> --role <employee|manager> --verdict <pass|reject|guidance> [--report <text>] [--feedback <text>]
  engineering gate --governor <id> --node <nodeId> --verdict <pass|rollback> [--target-node <upstreamNodeId>] [--feedback <text>]
  engineering watchdog-action --governor <id> --node <nodeId> --action <remind|kill-restart> [--message <text>]

  inbox list [--unread-only] [--governor <id>]
  inbox post --from <governorId> --message <text> [--title <title>] [--node <nodeId>]
  inbox resolve --id <msgId> [--resolution <text>]
  inbox mark-read [--id <msgId> | --all]
`;

class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CliUsageError';
	}
}

function parseBooleanValue(raw: string, flagName: string): boolean {
	const normalized = raw.trim().toLowerCase();
	if (normalized === 'true' || normalized === '1' || normalized === 'yes') { return true; }
	if (normalized === 'false' || normalized === '0' || normalized === 'no') { return false; }
	throw new CliUsageError(`Invalid boolean value for ${flagName}: ${raw} (expected true or false).`);
}

function resolvePathIfRelative(value: string, cwd: string): string {
	if (value === '~') { return os.homedir(); }
	if (value.startsWith('~/') || value.startsWith('~\\')) { return path.join(os.homedir(), value.slice(2)); }
	if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../') || value.startsWith('.\\') || value.startsWith('..\\')) {
		return path.resolve(cwd, value);
	}
	return value;
}

async function canonicalizeParamsPaths(params: Record<string, unknown> | undefined): Promise<Record<string, unknown> | undefined> {
	if (!params) {
		return params;
	}
	const canonicalizeStr = async (val: string): Promise<string> => {
		if (!path.isAbsolute(val)) {
			return val;
		}
		try {
			return await fs.realpath(val);
		} catch {
			return val;
		}
	};
	const out: Record<string, unknown> = { ...params };
	for (const key of ['target', 'project', 'source', 'before', 'after', 'file', 'path']) {
		if (typeof out[key] === 'string') {
			out[key] = await canonicalizeStr(out[key] as string);
		}
	}
	if (Array.isArray(out.paths)) {
		out.paths = await Promise.all((out.paths as unknown[]).map(item => typeof item === 'string' ? canonicalizeStr(item) : Promise.resolve(item)));
	}
	return out;
}

export function parseCliCommand(argv: readonly string[], cwd = process.cwd()): ParsedCliInvocation {
	let help = false;
	let json = false;
	let windowId: number | undefined;
	const rest: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--') {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (arg === '-h' || arg === '--help') {
			help = true;
		} else if (arg === '--json') {
			json = true;
		} else if (arg === '--window') {
			const next = argv[++i];
			if (!next || !/^\d+$/.test(next)) {
				throw new CliUsageError('Option --window requires a numeric window ID.');
			}
			windowId = Number(next);
		} else if (arg.startsWith('--window=')) {
			const val = arg.slice('--window='.length);
			if (!val || !/^\d+$/.test(val)) {
				throw new CliUsageError('Option --window requires a numeric window ID.');
			}
			windowId = Number(val);
		} else {
			rest.push(arg);
		}
	}

	if (help || rest.length === 0 || rest[0] === 'help') {
		return { help: true, json, windowId };
	}

	const [group, ...tail] = rest;

	if (group === 'status') {
		if (tail.length > 0) { throw new CliUsageError(`Unexpected arguments for status: ${tail.join(' ')}`); }
		return { help: false, json, windowId, action: 'status', params: {} };
	}

	if (group === 'mode') {
		if (tail.length === 0 || (tail.length === 1 && tail[0] === 'get')) {
			return { help: false, json, windowId, action: 'mode.get', params: {} };
		}
		const modeArg = tail[0] === 'set' ? tail[1] : tail[0];
		const extra = tail[0] === 'set' ? tail.slice(2) : tail.slice(1);
		if (!modeArg || (modeArg !== 'ade' && modeArg !== 'ide') || extra.length > 0) {
			throw new CliUsageError('Usage: aexus-ade mode [get | set <ade|ide>]');
		}
		return { help: false, json, windowId, action: 'mode.set', params: { mode: modeArg } };
	}

	if (group === 'view') {
		if (tail.length === 0 || (tail.length === 1 && (tail[0] === 'status' || tail[0] === 'get'))) {
			return { help: false, json, windowId, action: 'view.get', params: {} };
		}
		if (tail.length === 1 && tail[0] === 'refresh') {
			return { help: false, json, windowId, action: 'view.refresh', params: {} };
		}
		let archived: boolean | 'toggle' | undefined;
		let inspector: string | undefined;
		let refresh = false;
		for (let i = 0; i < tail.length; i++) {
			const arg = tail[i];
			if (arg === '--archived') {
				const next = tail[i + 1];
				if (next !== undefined && !next.startsWith('--')) {
					const val = tail[++i];
					archived = val.trim().toLowerCase() === 'toggle' ? 'toggle' : parseBooleanValue(val, '--archived');
				} else {
					archived = true;
				}
			} else if (arg.startsWith('--archived=')) {
				const val = arg.slice('--archived='.length);
				archived = val.trim().toLowerCase() === 'toggle' ? 'toggle' : parseBooleanValue(val, '--archived');
			} else if (arg === '--no-archived') {
				archived = false;
			} else if (arg === '--inspector') {
				inspector = tail[++i];
				if (!inspector) { throw new CliUsageError('Option --inspector requires changes, files, or hide.'); }
			} else if (arg.startsWith('--inspector=')) {
				inspector = arg.slice('--inspector='.length);
			} else if (arg === '--refresh') {
				refresh = true;
			} else {
				throw new CliUsageError(`Unknown option for view: ${arg}`);
			}
		}
		if (archived === undefined && inspector === undefined && !refresh) {
			throw new CliUsageError('Usage: aexus-ade view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh]');
		}
		const params: Record<string, unknown> = {};
		if (archived !== undefined) { params.archived = archived; }
		if (inspector !== undefined) { params.inspector = inspector; }
		if (refresh) { params.refresh = true; }
		return { help: false, json, windowId, action: 'view.set', params };
	}

	if (group === 'project') {
		const sub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (sub === 'list') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for project list: ${args.join(' ')}`); }
			return { help: false, json, windowId, action: 'project.list', params: {} };
		}
		if (sub === 'add') {
			let customName: string | undefined;
			const rawPaths: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--name' || arg === '--label') {
					customName = args[++i];
					if (!customName) { throw new CliUsageError(`Option ${arg} requires a value.`); }
				} else if (arg.startsWith('--name=')) {
					customName = arg.slice('--name='.length);
				} else if (!arg.startsWith('-')) {
					rawPaths.push(arg);
				} else {
					throw new CliUsageError(`Unknown option for project add: ${arg}`);
				}
			}
			if (rawPaths.length === 0) { throw new CliUsageError('Usage: aexus-ade project add <path...> [--name <label>]'); }
			const paths = rawPaths.map(item => path.resolve(cwd, item.startsWith('~/') ? path.join(os.homedir(), item.slice(2)) : item === '~' ? os.homedir() : item));
			return { help: false, json, windowId, action: 'project.add', params: customName ? { paths, name: customName } : { paths } };
		}
		if (sub === 'select') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade project select <target>'); }
			return { help: false, json, windowId, action: 'project.select', params: { target: resolvePathIfRelative(args[0], cwd) } };
		}
		if (sub === 'remove') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade project remove <target>'); }
			return { help: false, json, windowId, action: 'project.remove', params: { target: resolvePathIfRelative(args[0], cwd) } };
		}
		if (sub === 'delete') {
			let target: string | undefined;
			let deleteSessions = false;
			let deleteFiles = false;
			let permanent = false;
			for (const arg of args) {
				if (arg === '--sessions') { deleteSessions = true; }
				else if (arg === '--files') { deleteFiles = true; }
				else if (arg === '--permanent') { permanent = true; }
				else if (!arg.startsWith('-') && target === undefined) { target = arg; }
				else { throw new CliUsageError(`Unknown argument for project delete: ${arg}`); }
			}
			if (!target) { throw new CliUsageError('Usage: aexus-ade project delete <target> [--sessions] [--files]'); }
			if (!deleteSessions && !deleteFiles) {
				deleteSessions = true;
			}
			return {
				help: false,
				json,
				windowId,
				action: 'project.delete',
				params: { target: resolvePathIfRelative(target, cwd), deleteSessions, deleteFiles, ...(permanent ? { permanent: true } : {}) },
			};
		}
		if (sub === 'focus') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade project focus <target>'); }
			return { help: false, json, windowId, action: 'project.focus', params: { target: resolvePathIfRelative(args[0], cwd) } };
		}
		if (sub === 'home') {
			if (args.length > 0) { throw new CliUsageError('Usage: aexus-ade project home'); }
			return { help: false, json, windowId, action: 'project.home', params: {} };
		}
		if (sub === 'forward') {
			if (args.length > 0) { throw new CliUsageError('Usage: aexus-ade project forward'); }
			return { help: false, json, windowId, action: 'project.forward', params: {} };
		}
		if (sub === 'move') {
			let source: string | undefined;
			let before: string | undefined;
			let after: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--before') {
					before = args[++i];
					if (!before) { throw new CliUsageError('Option --before requires a target project.'); }
				} else if (arg.startsWith('--before=')) {
					before = arg.slice('--before='.length);
				} else if (arg === '--after') {
					after = args[++i];
					if (!after) { throw new CliUsageError('Option --after requires a target project.'); }
				} else if (arg.startsWith('--after=')) {
					after = arg.slice('--after='.length);
				} else if (!arg.startsWith('-') && source === undefined) {
					source = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for project move: ${arg}`);
				}
			}
			if (!source || (before === undefined && after === undefined) || (before !== undefined && after !== undefined)) {
				throw new CliUsageError('Usage: aexus-ade project move <source> (--before <target> | --after <target>)');
			}
			const resolvedSource = resolvePathIfRelative(source, cwd);
			if (before !== undefined) {
				const resolvedTarget = resolvePathIfRelative(before, cwd);
				return { help: false, json, windowId, action: 'project.move', params: { source: resolvedSource, before: resolvedTarget, target: resolvedTarget, position: 'before' } };
			}
			const resolvedTarget = resolvePathIfRelative(after!, cwd);
			return { help: false, json, windowId, action: 'project.move', params: { source: resolvedSource, after: resolvedTarget, target: resolvedTarget, position: 'after' } };
		}
		if (sub === 'changes') {
			if (args.length > 1) { throw new CliUsageError('Usage: aexus-ade project changes [target]'); }
			const params: Record<string, unknown> = {};
			if (args[0]) { params.target = resolvePathIfRelative(args[0], cwd); }
			return { help: false, json, windowId, action: 'project.changes', params };
		}
		if (sub === 'files') {
			let target: string | undefined;
			let subpath: string | undefined;
			let depth: number | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--path' || arg === '--subpath') {
					subpath = args[++i];
					if (!subpath) { throw new CliUsageError(`Option ${arg} requires a relative path.`); }
				} else if (arg.startsWith('--path=')) {
					subpath = arg.slice('--path='.length);
				} else if (arg === '--depth') {
					const val = args[++i];
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) { throw new CliUsageError('Option --depth requires a positive integer.'); }
					depth = Number(val);
				} else if (arg.startsWith('--depth=')) {
					const val = arg.slice('--depth='.length);
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) { throw new CliUsageError('Option --depth requires a positive integer.'); }
					depth = Number(val);
				} else if (!arg.startsWith('-') && target === undefined) {
					target = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for project files: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (target !== undefined) { params.target = resolvePathIfRelative(target, cwd); }
			if (subpath !== undefined) { params.subpath = subpath; }
			if (depth !== undefined) { params.depth = depth; }
			return { help: false, json, windowId, action: 'project.files', params };
		}
		if (sub === 'open-file' || sub === 'openFile') {
			let file: string | undefined;
			let project: string | undefined;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--side') {
					side = true;
				} else if (!arg.startsWith('-') && file === undefined) {
					file = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for project ${sub}: ${arg}`);
				}
			}
			if (!file) { throw new CliUsageError('Usage: aexus-ade project open-file <file> [--project <target>] [--side]'); }
			const params: Record<string, unknown> = { file: resolvePathIfRelative(file, cwd) };
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			if (side) { params.side = true; }
			return { help: false, json, windowId, action: 'project.openFile', params };
		}
		if (sub === 'open-diff' || sub === 'openDiff' || sub === 'diff') {
			let file: string | undefined;
			let project: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (!arg.startsWith('-') && file === undefined) {
					file = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for project ${sub}: ${arg}`);
				}
			}
			if (!file) { throw new CliUsageError('Usage: aexus-ade project open-diff <file> [--project <target>]'); }
			const params: Record<string, unknown> = { file: resolvePathIfRelative(file, cwd) };
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			return { help: false, json, windowId, action: 'project.openDiff', params };
		}
		throw new CliUsageError(`Unknown project subcommand: ${sub}`);
	}

	if (group === 'engine') {
		const sub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (sub === 'list') {
			if (args.length > 0) {
				throw new CliUsageError('Usage: aexus-ade engine list');
			}
			return { help: false, json, windowId, action: 'engine.list', params: {} };
		}
		if (sub === 'sessions') {
			let engine: string | undefined;
			let project: string | undefined;
			let limit: number | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--limit' || arg === '-n') {
					const val = args[++i];
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) { throw new CliUsageError('Option --limit requires a positive integer.'); }
					limit = Number(val);
				} else if (arg.startsWith('--limit=')) {
					const val = arg.slice('--limit='.length);
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) { throw new CliUsageError('Option --limit requires a positive integer.'); }
					limit = Number(val);
				} else if (!arg.startsWith('-') && engine === undefined) {
					engine = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for engine sessions: ${arg}`);
				}
			}
			if (!engine) { throw new CliUsageError('Usage: aexus-ade engine sessions <engine> [--project <target>] [--limit <n>]'); }
			const params: Record<string, unknown> = { engine };
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			if (limit !== undefined) { params.limit = limit; }
			return { help: false, json, windowId, action: 'engine.sessions', params };
		}
		throw new CliUsageError('Usage: aexus-ade engine <list | sessions <engine>>');
	}

	if (group === 'session') {
		const sub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (sub === 'list') {
			let project: string | undefined;
			let parent: string | undefined;
			let role: string | undefined;
			let engine: string | undefined;
			let status: string | undefined;
			let unread = false;
			let archived = false;
			let archivedOnly = false;
			let all = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--parent') {
					parent = args[++i];
					if (!parent) { throw new CliUsageError('Option --parent requires a parent session ID or "root".'); }
				} else if (arg.startsWith('--parent=')) {
					parent = arg.slice('--parent='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!val || !VALID_ROLES.has(val)) {
						throw new CliUsageError('Option --role must be one of: governor, manager, employee, subordinate, worker.');
					}
					role = val;
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!VALID_ROLES.has(val)) {
						throw new CliUsageError('Option --role must be one of: governor, manager, employee, subordinate, worker.');
					}
					role = val;
				} else if (arg === '--engine') {
					engine = args[++i];
					if (!engine) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--status') {
					status = args[++i];
					if (!status) { throw new CliUsageError('Option --status requires idle, working, pending, or draft.'); }
				} else if (arg.startsWith('--status=')) {
					status = arg.slice('--status='.length);
				} else if (arg === '--unread') {
					unread = true;
				} else if (arg === '--archived') {
					archived = true;
				} else if (arg === '--archived-only') {
					archivedOnly = true;
				} else if (arg === '--all') {
					all = true;
				} else {
					throw new CliUsageError(`Unknown option for session list: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			if (parent !== undefined) { params.parent = parent; }
			if (role !== undefined) { params.role = role; }
			if (engine !== undefined) { params.engine = engine; }
			if (status !== undefined) { params.status = status; }
			if (unread) { params.unread = true; }
			if (archived) { params.archived = true; }
			if (archivedOnly) { params.archivedOnly = true; }
			if (all) { params.all = true; }
			return { help: false, json, windowId, action: 'session.list', params };
		}
		if (sub === 'info' || sub === 'get' || sub === 'show') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError(`Usage: aexus-ade session ${sub} <id>`);
			}
			return { help: false, json, windowId, action: 'session.info', params: { id: args[0] } };
		}
		if (sub === 'subordinates' || sub === 'children') {
			let id: string | undefined;
			let recursive = false;
			for (const arg of args) {
				if (arg === '--recursive' || arg === '-r') { recursive = true; }
				else if (!arg.startsWith('-') && id === undefined) { id = arg; }
				else { throw new CliUsageError(`Unexpected argument for session ${sub}: ${arg}`); }
			}
			const params: Record<string, unknown> = {};
			if (id !== undefined) { params.id = id; }
			if (recursive) { params.recursive = true; }
			return { help: false, json, windowId, action: 'session.subordinates', params };
		}
		if (sub === 'tree' || sub === 'subtree') {
			let id: string | undefined;
			for (const arg of args) {
				if (!arg.startsWith('-') && id === undefined) { id = arg; }
				else { throw new CliUsageError(`Unexpected argument for session ${sub}: ${arg}`); }
			}
			return { help: false, json, windowId, action: 'session.tree', params: id !== undefined ? { id } : {} };
		}
		if (sub === 'create') {
			let project: string | undefined;
			let engine: string | undefined;
			let title: string | undefined;
			let parent: string | undefined;
			let role: string | undefined;
			let draftOnly = false;
			let draftText: string | undefined;
			let noOpen = false;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a value.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--engine') {
					engine = args[++i];
					if (!engine) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--title') {
					title = args[++i];
					if (title === undefined) { throw new CliUsageError('Option --title requires a value.'); }
				} else if (arg.startsWith('--title=')) {
					title = arg.slice('--title='.length);
				} else if (arg === '--parent') {
					parent = args[++i];
					if (!parent) { throw new CliUsageError('Option --parent requires a parent session ID.'); }
				} else if (arg.startsWith('--parent=')) {
					parent = arg.slice('--parent='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!val || !VALID_ROLES.has(val)) {
						throw new CliUsageError('Option --role must be one of: governor, manager, employee, subordinate, worker.');
					}
					role = val;
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!VALID_ROLES.has(val)) {
						throw new CliUsageError('Option --role must be one of: governor, manager, employee, subordinate, worker.');
					}
					role = val;
				} else if (arg === '--draft') {
					const next = args[i + 1];
					if (next !== undefined && !next.startsWith('--')) {
						draftText = args[++i];
					} else {
						draftOnly = true;
					}
				} else if (arg.startsWith('--draft=')) {
					draftText = arg.slice('--draft='.length);
				} else if (arg === '--no-open') {
					noOpen = true;
				} else if (arg === '--side') {
					side = true;
				} else {
					throw new CliUsageError(`Unknown option for session create: ${arg}`);
				}
			}
			const params: Record<string, unknown> = { open: !noOpen };
			if (noOpen) { params.noOpen = true; }
			if (side) { params.side = true; }
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			if (engine !== undefined) { params.engine = engine; }
			if (title !== undefined) { params.title = title; }
			if (parent !== undefined) { params.parent = parent; params.parentId = parent; }
			if (role !== undefined) { params.role = role; }
			if (draftOnly) { params.draft = true; }
			if (draftText !== undefined) { params.draftText = draftText; if (engine === undefined) { params.draft = true; } }
			return { help: false, json, windowId, action: 'session.create', params };
		}
		if (sub === 'attach' || sub === 'import') {
			let project: string | undefined;
			let engine: string | undefined;
			let nativeId: string | undefined;
			let title: string | undefined;
			let parent: string | undefined;
			let role: string | undefined;
			let noOpen = false;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a value.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--engine') {
					engine = args[++i];
					if (!engine) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--native-id' || arg === '--session-id') {
					nativeId = args[++i];
					if (!nativeId) { throw new CliUsageError(`Option ${arg} requires a native conversation ID.`); }
				} else if (arg.startsWith('--native-id=')) {
					nativeId = arg.slice('--native-id='.length);
				} else if (arg === '--title') {
					title = args[++i];
					if (title === undefined) { throw new CliUsageError('Option --title requires a value.'); }
				} else if (arg.startsWith('--title=')) {
					title = arg.slice('--title='.length);
				} else if (arg === '--parent') {
					parent = args[++i];
					if (!parent) { throw new CliUsageError('Option --parent requires a parent session ID.'); }
				} else if (arg.startsWith('--parent=')) {
					parent = arg.slice('--parent='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!val || !VALID_ROLES.has(val)) {
						throw new CliUsageError('Option --role must be one of: governor, manager, employee, subordinate, worker.');
					}
					role = val;
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!VALID_ROLES.has(val)) {
						throw new CliUsageError('Option --role must be one of: governor, manager, employee, subordinate, worker.');
					}
					role = val;
				} else if (arg === '--no-open') {
					noOpen = true;
				} else if (arg === '--side') {
					side = true;
				} else {
					throw new CliUsageError(`Unknown option for session attach: ${arg}`);
				}
			}
			if (!engine || !nativeId) {
				throw new CliUsageError('Usage: aexus-ade session attach --engine <e> --native-id <nativeId> [--project <p>] [--title <t>] [--parent <id>] [--role <r>] [--side] [--no-open]');
			}
			const params: Record<string, unknown> = { engine, nativeId, open: !noOpen };
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			if (title !== undefined) { params.title = title; }
			if (parent !== undefined) { params.parentId = parent; }
			if (role !== undefined) { params.role = role; }
			if (side) { params.side = true; }
			return { help: false, json, windowId, action: 'session.attach', params };
		}
		if (sub === 'connect') {
			let id: string | undefined;
			let engine: string | undefined;
			let nativeId: string | undefined;
			let noOpen = false;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--engine') {
					engine = args[++i];
					if (!engine) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--native-id' || arg === '--session-id') {
					nativeId = args[++i];
					if (!nativeId) { throw new CliUsageError(`Option ${arg} requires a native conversation ID.`); }
				} else if (arg.startsWith('--native-id=')) {
					nativeId = arg.slice('--native-id='.length);
				} else if (arg === '--no-open') {
					noOpen = true;
				} else if (arg === '--side') {
					side = true;
				} else if (!arg.startsWith('-') && id === undefined) {
					id = arg;
				} else {
					throw new CliUsageError(`Unknown argument for session connect: ${arg}`);
				}
			}
			if (!id || !engine) {
				throw new CliUsageError('Usage: aexus-ade session connect <id> --engine <e> [--native-id <nativeId>] [--side] [--no-open]');
			}
			const params: Record<string, unknown> = { id, engine, open: !noOpen };
			if (nativeId !== undefined) { params.nativeId = nativeId; }
			if (side) { params.side = true; }
			return { help: false, json, windowId, action: 'session.connect', params };
		}
		if (sub === 'open') {
			let id: string | undefined;
			let side = false;
			for (const arg of args) {
				if (arg === '--side') { side = true; }
				else if (!arg.startsWith('-') && id === undefined) { id = arg; }
				else { throw new CliUsageError(`Unexpected argument for session open: ${arg}`); }
			}
			if (!id) { throw new CliUsageError('Usage: aexus-ade session open <id> [--side]'); }
			return { help: false, json, windowId, action: 'session.open', params: side ? { id, side: true } : { id } };
		}
		if (sub === 'select') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session select <id>');
			}
			return { help: false, json, windowId, action: 'session.select', params: { id: args[0] } };
		}
		if (sub === 'close') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session close <id>');
			}
			return { help: false, json, windowId, action: 'session.close', params: { id: args[0] } };
		}
		if (sub === 'mark-read' || sub === 'markRead') {
			if (args.length === 1 && args[0] === '--all') {
				return { help: false, json, windowId, action: 'session.markRead', params: { all: true } };
			}
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session mark-read (<id> | --all)');
			}
			return { help: false, json, windowId, action: 'session.markRead', params: { id: args[0] } };
		}
		if (sub === 'draft') {
			let id: string | undefined;
			let clear = false;
			const textParts: string[] = [];
			for (const arg of args) {
				if (arg === '--clear') { clear = true; }
				else if (id === undefined && !arg.startsWith('-')) { id = arg; }
				else { textParts.push(arg); }
			}
			if (!id) { throw new CliUsageError('Usage: aexus-ade session draft <id> [<text> | --clear]'); }
			const params: Record<string, unknown> = { id };
			if (clear) { params.clear = true; }
			else if (textParts.length > 0) { params.draft = textParts.join(' '); }
			return { help: false, json, windowId, action: 'session.draft', params };
		}
		if (sub === 'reorder') {
			let id: string | undefined;
			let before: string | undefined;
			let after: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--before') {
					before = args[++i];
					if (!before) { throw new CliUsageError('Option --before requires a target session ID.'); }
				} else if (arg.startsWith('--before=')) {
					before = arg.slice('--before='.length);
				} else if (arg === '--after') {
					after = args[++i];
					if (!after) { throw new CliUsageError('Option --after requires a target session ID.'); }
				} else if (arg.startsWith('--after=')) {
					after = arg.slice('--after='.length);
				} else if (!arg.startsWith('-') && id === undefined) {
					id = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for session reorder: ${arg}`);
				}
			}
			if (!id || (before === undefined && after === undefined) || (before !== undefined && after !== undefined)) {
				throw new CliUsageError('Usage: aexus-ade session reorder <id> (--before <targetId> | --after <targetId>)');
			}
			return {
				help: false,
				json,
				windowId,
				action: 'session.reorder',
				params: before !== undefined
					? { id, before, target: before, position: 'before' }
					: { id, after, target: after, position: 'after' },
			};
		}
		if (sub === 'rename') {
			if (args.length < 2) { throw new CliUsageError('Usage: aexus-ade session rename <id> <title>'); }
			const id = args[0];
			const title = args.slice(1).join(' ');
			return { help: false, json, windowId, action: 'session.rename', params: { id, title } };
		}
		if (sub === 'role') {
			if (args.length !== 2) { throw new CliUsageError('Usage: aexus-ade session role <id> <governor|manager|employee|worker|none>'); }
			const [id, roleArg] = args;
			if (roleArg !== 'none' && !VALID_ROLES.has(roleArg)) {
				throw new CliUsageError('Role must be one of: governor, manager, employee, subordinate, worker, none.');
			}
			return { help: false, json, windowId, action: 'session.setRole', params: { id, role: roleArg === 'none' || roleArg === 'worker' ? null : roleArg } };
		}
		if (sub === 'send') {
			let wait = false;
			const positional: string[] = [];
			for (const arg of args) {
				if (arg === '--wait') { wait = true; }
				else { positional.push(arg); }
			}
			if (positional.length < 2) { throw new CliUsageError('Usage: aexus-ade session send <id> <prompt> [--wait]'); }
			const id = positional[0];
			const prompt = positional.slice(1).join(' ');
			return { help: false, json, windowId, action: 'session.send', params: wait ? { id, prompt, wait: true } : { id, prompt } };
		}
		if (sub === 'history' || sub === 'messages') {
			let id: string | undefined;
			let limit: number | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--limit' || arg === '-n') {
					const val = args[++i];
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) {
						throw new CliUsageError('Option --limit requires a positive integer.');
					}
					limit = Number(val);
				} else if (arg.startsWith('--limit=')) {
					const val = arg.slice('--limit='.length);
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) {
						throw new CliUsageError('Option --limit requires a positive integer.');
					}
					limit = Number(val);
				} else if (!arg.startsWith('-') && id === undefined) {
					id = arg;
				} else {
					throw new CliUsageError(`Unknown argument for session ${sub}: ${arg}`);
				}
			}
			if (!id) { throw new CliUsageError(`Usage: aexus-ade session ${sub} <id> [--limit <n>]`); }
			return { help: false, json, windowId, action: 'session.history', params: limit !== undefined ? { id, limit } : { id } };
		}
		if (sub === 'stop' || sub === 'cancel') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError(`Usage: aexus-ade session ${sub} <id>`);
			}
			return { help: false, json, windowId, action: 'session.stop', params: { id: args[0] } };
		}
		if (sub === 'nest' || sub === 'reparent' || sub === 'move') {
			let project: string | undefined;
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (!arg.startsWith('-')) {
					positional.push(arg);
				} else {
					throw new CliUsageError(`Unknown option for session ${sub}: ${arg}`);
				}
			}
			if (positional.length !== 2) { throw new CliUsageError(`Usage: aexus-ade session ${sub} <id> <parentId|none> [--project <p>]`); }
			const [id, parentArg] = positional;
			const params: Record<string, unknown> = {
				id,
				parentId: parentArg === 'none' || parentArg === 'root' ? null : parentArg,
			};
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			return { help: false, json, windowId, action: 'session.reparent', params };
		}
		if (sub === 'archive' || sub === 'unarchive' || sub === 'restore') {
			if (args.length !== 1) { throw new CliUsageError(`Usage: aexus-ade session ${sub} <id>`); }
			return { help: false, json, windowId, action: 'session.archive', params: { id: args[0], archived: sub === 'archive' } };
		}
		if (sub === 'detach' || sub === 'remove') {
			if (args.length !== 1) { throw new CliUsageError(`Usage: aexus-ade session ${sub} <id>`); }
			return { help: false, json, windowId, action: 'session.detach', params: { id: args[0] } };
		}
		if (sub === 'delete') {
			const filtered = args.filter(arg => arg !== '--force' && arg !== '-f');
			if (filtered.length !== 1) { throw new CliUsageError('Usage: aexus-ade session delete <id> [--force]'); }
			return { help: false, json, windowId, action: 'session.delete', params: { id: filtered[0] } };
		}
		throw new CliUsageError(`Unknown session subcommand: ${sub}`);
	}

	if (group === 'secretary') {
		const sub = tail[0] ?? 'status';
		const args = tail.slice(1);
		if (sub === 'status' || sub === 'info') {
			if (args.length > 0) { throw new CliUsageError(`Usage: aexus-ade secretary [${sub}]`); }
			return { help: false, json, windowId, action: 'secretary.status', params: {} };
		}
		if (sub === 'open') {
			let side = false;
			for (const arg of args) {
				if (arg === '--side') { side = true; }
				else { throw new CliUsageError(`Unknown option for secretary open: ${arg}`); }
			}
			return { help: false, json, windowId, action: 'secretary.open', params: side ? { side: true } : {} };
		}
		if (sub === 'engine') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade secretary engine <e>'); }
			return { help: false, json, windowId, action: 'secretary.engine', fallbackAction: 'secretary.setEngine', params: { engine: args[0] } };
		}
		if (sub === 'reset') {
			let engine: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--engine') {
					engine = args[++i];
					if (!engine) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else {
					throw new CliUsageError(`Unknown option for secretary reset: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'secretary.reset', params: engine !== undefined ? { engine } : {} };
		}
		if (sub === 'send') {
			let wait = false;
			const positional: string[] = [];
			for (const arg of args) {
				if (arg === '--wait') { wait = true; }
				else { positional.push(arg); }
			}
			if (positional.length === 0) { throw new CliUsageError('Usage: aexus-ade secretary send <prompt> [--wait]'); }
			const prompt = positional.join(' ');
			return { help: false, json, windowId, action: 'secretary.send', params: wait ? { prompt, wait: true } : { prompt } };
		}
		if (sub === 'history' || sub === 'messages') {
			let limit: number | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--limit' || arg === '-n') {
					const val = args[++i];
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) {
						throw new CliUsageError('Option --limit requires a positive integer.');
					}
					limit = Number(val);
				} else if (arg.startsWith('--limit=')) {
					const val = arg.slice('--limit='.length);
					if (!val || !/^\d+$/.test(val) || Number(val) <= 0) {
						throw new CliUsageError('Option --limit requires a positive integer.');
					}
					limit = Number(val);
				} else {
					throw new CliUsageError(`Unknown option for secretary ${sub}: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'secretary.history', params: limit !== undefined ? { limit } : {} };
		}
		if (sub === 'stop' || sub === 'cancel') {
			if (args.length > 0) { throw new CliUsageError(`Usage: aexus-ade secretary ${sub}`); }
			return { help: false, json, windowId, action: 'secretary.stop', params: {} };
		}
		if (sub === 'draft') {
			let clear = false;
			const textParts: string[] = [];
			for (const arg of args) {
				if (arg === '--clear') { clear = true; }
				else { textParts.push(arg); }
			}
			const params: Record<string, unknown> = {};
			if (clear) { params.clear = true; }
			else if (textParts.length > 0) { params.draft = textParts.join(' '); }
			return { help: false, json, windowId, action: 'secretary.draft', params };
		}
		if (sub === 'mark-read' || sub === 'markRead') {
			if (args.length > 0) { throw new CliUsageError(`Usage: aexus-ade secretary ${sub}`); }
			return { help: false, json, windowId, action: 'secretary.markRead', params: {} };
		}
		throw new CliUsageError(`Unknown secretary subcommand: ${sub}`);
	}

	if (group === 'engineering') {
		const sub = tail[0] ?? 'list';
		const args = tail.slice(1);

		const takeOptionVal = (iRef: { i: number }, flagName: string, list: readonly string[]): string => {
			const cur = list[iRef.i];
			const eqIdx = cur.indexOf('=');
			if (eqIdx >= 0) {
				const val = cur.slice(eqIdx + 1);
				if (!val) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
				return val;
			}
			const next = list[++iRef.i];
			if (next === undefined) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
			return next;
		};

		if (sub === 'init') {
			let governor: string | undefined;
			let onChildren: string | undefined;
			let targetParentId: string | undefined;
			let treeType: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (arg === '--on-children' || arg.startsWith('--on-children=')) {
					onChildren = takeOptionVal(ref, '--on-children', args).toLowerCase();
					if (onChildren !== 'relocate' && onChildren !== 'delete') {
						throw new CliUsageError('Option --on-children must be relocate or delete.');
					}
				} else if (arg === '--target' || arg.startsWith('--target=')) {
					targetParentId = takeOptionVal(ref, '--target', args);
				} else if (arg === '--tree-type' || arg.startsWith('--tree-type=')) {
					treeType = takeOptionVal(ref, '--tree-type', args).toLowerCase();
				} else if (!arg.startsWith('-') && !governor) {
					governor = arg;
				} else {
					throw new CliUsageError(`Unknown option for engineering init: ${arg}`);
				}
			}
			if (!governor) {
				throw new CliUsageError('Usage: aexus-ade engineering init --governor <id> [--on-children <relocate|delete> --target <id>]');
			}
			const params: Record<string, unknown> = { governor };
			if (onChildren) { params.onChildren = onChildren; }
			if (targetParentId) { params.relocateTargetParentId = targetParentId; }
			if (treeType) { params.treeType = treeType; }
			return { help: false, json, windowId, action: 'engineering.init', params };
		}

		if (sub === 'list') {
			let project: string | undefined;
			let treeType: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--project' || arg.startsWith('--project=')) {
					project = resolvePathIfRelative(takeOptionVal(ref, '--project', args), cwd);
				} else if (arg === '--tree-type' || arg.startsWith('--tree-type=')) {
					treeType = takeOptionVal(ref, '--tree-type', args).toLowerCase();
				} else {
					throw new CliUsageError(`Unknown option for engineering list: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (project) { params.project = project; }
			if (treeType) { params.treeType = treeType; }
			return { help: false, json, windowId, action: 'engineering.list', params };
		}

		if (sub === 'open') {
			let governor: string | undefined;
			let side = false;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (arg === '--side') {
					side = true;
				} else if (!arg.startsWith('-') && !governor) {
					governor = arg;
				} else {
					throw new CliUsageError(`Unknown option for engineering open: ${arg}`);
				}
			}
			if (!governor) {
				throw new CliUsageError('Usage: aexus-ade engineering open --governor <id> [--side]');
			}
			return { help: false, json, windowId, action: 'engineering.open', params: side ? { governor, side: true } : { governor } };
		}

		if (sub === 'blueprint') {
			const bpSub = args[0];
			const bpArgs = args.slice(1);
			if (bpSub === 'get') {
				let governor: string | undefined;
				for (const ref = { i: 0 }; ref.i < bpArgs.length; ref.i++) {
					const arg = bpArgs[ref.i];
					if (arg === '--governor' || arg.startsWith('--governor=')) {
						governor = takeOptionVal(ref, '--governor', bpArgs);
					} else if (!arg.startsWith('-') && !governor) {
						governor = arg;
					} else {
						throw new CliUsageError(`Unknown option for engineering blueprint get: ${arg}`);
					}
				}
				if (!governor) {
					throw new CliUsageError('Usage: aexus-ade engineering blueprint get --governor <id>');
				}
				return { help: false, json, windowId, action: 'engineering.blueprint.get', params: { governor } };
			}
			if (bpSub === 'apply') {
				let governor: string | undefined;
				let file: string | undefined;
				let text: string | undefined;
				let forceStopRunning = false;
				for (const ref = { i: 0 }; ref.i < bpArgs.length; ref.i++) {
					const arg = bpArgs[ref.i];
					if (arg === '--governor' || arg.startsWith('--governor=')) {
						governor = takeOptionVal(ref, '--governor', bpArgs);
					} else if (arg === '--file' || arg.startsWith('--file=')) {
						file = resolvePathIfRelative(takeOptionVal(ref, '--file', bpArgs), cwd);
					} else if (arg === '--text' || arg.startsWith('--text=')) {
						text = takeOptionVal(ref, '--text', bpArgs);
					} else if (arg === '--force-stop-running') {
						forceStopRunning = true;
					} else {
						throw new CliUsageError(`Unknown option for engineering blueprint apply: ${arg}`);
					}
				}
				if (!governor || (!file && text === undefined)) {
					throw new CliUsageError('Usage: aexus-ade engineering blueprint apply --governor <id> (--file <path> | --text <markdown>) [--force-stop-running]');
				}
				const params: Record<string, unknown> = { governor };
				if (file) { params.file = file; }
				if (text !== undefined) { params.text = text; }
				if (forceStopRunning) { params.forceStopRunning = true; }
				return { help: false, json, windowId, action: 'engineering.blueprint.apply', params };
			}
			throw new CliUsageError('Usage: aexus-ade engineering blueprint <get | apply> ...');
		}

		if (sub === 'run' || sub === 'pause' || sub === 'resume' || sub === 'stop' || sub === 'remove') {
			let governor: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (!arg.startsWith('-') && !governor) {
					governor = arg;
				} else {
					throw new CliUsageError(`Unknown option for engineering ${sub}: ${arg}`);
				}
			}
			if (!governor) {
				throw new CliUsageError(`Usage: aexus-ade engineering ${sub} --governor <id>`);
			}
			return { help: false, json, windowId, action: `engineering.${sub}`, params: { governor } };
		}

		if (sub === 'status') {
			let governor: string | undefined;
			let node: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else if (!arg.startsWith('-') && !governor) {
					governor = arg;
				} else {
					throw new CliUsageError(`Unknown option for engineering status: ${arg}`);
				}
			}
			if (!governor) {
				throw new CliUsageError('Usage: aexus-ade engineering status --governor <id> [--node <nodeId>]');
			}
			const params: Record<string, unknown> = { governor };
			if (node) { params.node = node; }
			return { help: false, json, windowId, action: 'engineering.status', params };
		}

		if (sub === 'review') {
			let governor: string | undefined;
			let node: string | undefined;
			let role: string | undefined;
			let verdict: string | undefined;
			let report: string | undefined;
			let feedback: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else if (arg === '--role' || arg.startsWith('--role=')) {
					role = takeOptionVal(ref, '--role', args).toLowerCase();
					if (role !== 'employee' && role !== 'manager') {
						throw new CliUsageError('Option --role must be employee or manager.');
					}
				} else if (arg === '--verdict' || arg.startsWith('--verdict=')) {
					verdict = takeOptionVal(ref, '--verdict', args).toLowerCase();
					if (verdict !== 'pass' && verdict !== 'reject' && verdict !== 'guidance') {
						throw new CliUsageError('Option --verdict must be pass, reject, or guidance.');
					}
				} else if (arg === '--report' || arg.startsWith('--report=')) {
					report = takeOptionVal(ref, '--report', args);
				} else if (arg === '--feedback' || arg.startsWith('--feedback=')) {
					feedback = takeOptionVal(ref, '--feedback', args);
				} else {
					throw new CliUsageError(`Unknown option for engineering review: ${arg}`);
				}
			}
			if (!governor || !node || !role || !verdict) {
				throw new CliUsageError('Usage: aexus-ade engineering review --governor <id> --node <nodeId> --role <employee|manager> --verdict <pass|reject|guidance> [--report <text>] [--feedback <text>]');
			}
			const params: Record<string, unknown> = { governor, node, role, verdict };
			if (report !== undefined) { params.report = report; }
			if (feedback !== undefined) { params.feedback = feedback; }
			return { help: false, json, windowId, action: 'engineering.review', params };
		}

		if (sub === 'gate') {
			let governor: string | undefined;
			let node: string | undefined;
			let verdict: string | undefined;
			let targetNode: string | undefined;
			let feedback: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else if (arg === '--verdict' || arg.startsWith('--verdict=')) {
					verdict = takeOptionVal(ref, '--verdict', args).toLowerCase();
					if (verdict !== 'pass' && verdict !== 'rollback') {
						throw new CliUsageError('Option --verdict must be pass or rollback.');
					}
				} else if (arg === '--target-node' || arg.startsWith('--target-node=')) {
					targetNode = takeOptionVal(ref, '--target-node', args);
				} else if (arg === '--feedback' || arg.startsWith('--feedback=')) {
					feedback = takeOptionVal(ref, '--feedback', args);
				} else {
					throw new CliUsageError(`Unknown option for engineering gate: ${arg}`);
				}
			}
			if (!governor || !node || !verdict) {
				throw new CliUsageError('Usage: aexus-ade engineering gate --governor <id> --node <nodeId> --verdict <pass|rollback> [--target-node <upstreamNodeId>] [--feedback <text>]');
			}
			const params: Record<string, unknown> = { governor, node, verdict };
			if (targetNode) { params.targetNode = targetNode; }
			if (feedback !== undefined) { params.feedback = feedback; }
			return { help: false, json, windowId, action: 'engineering.gate', params };
		}

		if (sub === 'watchdog-action') {
			let governor: string | undefined;
			let node: string | undefined;
			let watchdogAction: string | undefined;
			let message: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else if (arg === '--action' || arg.startsWith('--action=')) {
					watchdogAction = takeOptionVal(ref, '--action', args).toLowerCase();
					if (watchdogAction !== 'remind' && watchdogAction !== 'kill-restart') {
						throw new CliUsageError('Option --action must be remind or kill-restart.');
					}
				} else if (arg === '--message' || arg.startsWith('--message=')) {
					message = takeOptionVal(ref, '--message', args);
				} else {
					throw new CliUsageError(`Unknown option for engineering watchdog-action: ${arg}`);
				}
			}
			if (!governor || !node || !watchdogAction) {
				throw new CliUsageError('Usage: aexus-ade engineering watchdog-action --governor <id> --node <nodeId> --action <remind|kill-restart> [--message <text>]');
			}
			const params: Record<string, unknown> = { governor, node, watchdogAction };
			if (message !== undefined) { params.message = message; }
			return { help: false, json, windowId, action: 'engineering.watchdogAction', params };
		}

		throw new CliUsageError(`Unknown engineering subcommand: ${sub}`);
	}

	if (group === 'inbox') {
		const sub = tail[0] ?? 'list';
		const args = tail.slice(1);

		const takeOptionVal = (iRef: { i: number }, flagName: string, list: readonly string[]): string => {
			const cur = list[iRef.i];
			const eqIdx = cur.indexOf('=');
			if (eqIdx >= 0) {
				const val = cur.slice(eqIdx + 1);
				if (!val) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
				return val;
			}
			const next = list[++iRef.i];
			if (next === undefined) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
			return next;
		};

		if (sub === 'list') {
			let unreadOnly = false;
			let governor: string | undefined;
			let includeResolved = true;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--unread-only' || arg === '--unread') {
					unreadOnly = true;
				} else if (arg === '--active-only') {
					includeResolved = false;
				} else if (arg === '--governor' || arg.startsWith('--governor=')) {
					governor = takeOptionVal(ref, '--governor', args);
				} else {
					throw new CliUsageError(`Unknown option for inbox list: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (unreadOnly) { params.unreadOnly = true; }
			if (!includeResolved) { params.includeResolved = false; }
			if (governor) { params.governor = governor; }
			return { help: false, json, windowId, action: 'inbox.list', params };
		}

		if (sub === 'post') {
			let fromGov: string | undefined;
			let message: string | undefined;
			let title: string | undefined;
			let node: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--from' || arg.startsWith('--from=') || arg === '--governor' || arg.startsWith('--governor=')) {
					fromGov = takeOptionVal(ref, '--from', args);
				} else if (arg === '--message' || arg.startsWith('--message=')) {
					message = takeOptionVal(ref, '--message', args);
				} else if (arg === '--title' || arg.startsWith('--title=')) {
					title = takeOptionVal(ref, '--title', args);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else {
					throw new CliUsageError(`Unknown option for inbox post: ${arg}`);
				}
			}
			if (!fromGov || !message) {
				throw new CliUsageError('Usage: aexus-ade inbox post --from <governorId> --message <text> [--title <title>]');
			}
			const params: Record<string, unknown> = { from: fromGov, message };
			if (title) { params.title = title; }
			if (node) { params.node = node; }
			return { help: false, json, windowId, action: 'inbox.post', params };
		}

		if (sub === 'resolve') {
			let id: string | undefined;
			let resolution: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--id' || arg.startsWith('--id=')) {
					id = takeOptionVal(ref, '--id', args);
				} else if (arg === '--resolution' || arg.startsWith('--resolution=') || arg === '--note' || arg.startsWith('--note=')) {
					resolution = takeOptionVal(ref, '--resolution', args);
				} else if (!arg.startsWith('-') && !id) {
					id = arg;
				} else {
					throw new CliUsageError(`Unknown option for inbox resolve: ${arg}`);
				}
			}
			if (!id) {
				throw new CliUsageError('Usage: aexus-ade inbox resolve --id <msgId> [--resolution <text>]');
			}
			const params: Record<string, unknown> = { id };
			if (resolution) { params.resolution = resolution; }
			return { help: false, json, windowId, action: 'inbox.resolve', params };
		}

		if (sub === 'mark-read' || sub === 'markRead') {
			let id: string | undefined;
			let all = false;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--all') {
					all = true;
				} else if (arg === '--id' || arg.startsWith('--id=')) {
					id = takeOptionVal(ref, '--id', args);
				} else if (!arg.startsWith('-') && !id) {
					id = arg;
				} else {
					throw new CliUsageError(`Unknown option for inbox mark-read: ${arg}`);
				}
			}
			return { help: false, json, windowId, action: 'inbox.markRead', params: all ? { all: true } : { id } };
		}

		throw new CliUsageError(`Unknown inbox subcommand: ${sub}`);
	}

	throw new CliUsageError(`Unknown command: ${group}`);
}

async function resolveConnection(env: NodeJS.ProcessEnv): Promise<{ socketPath: string; token: string }> {
	const socketOverride = env.AEXUS_ADE_SOCKET?.trim();
	const tokenOverride = env.AEXUS_ADE_TOKEN?.trim();
	if (socketOverride && tokenOverride !== undefined) {
		return { socketPath: socketOverride, token: tokenOverride };
	}
	const adeHomeDir = env.AEXUS_ADE_HOME?.trim() || path.join(os.homedir(), ADE_CONTROL_DIR_NAME);
	const controlFile = env.AEXUS_ADE_CONTROL_FILE?.trim() || path.join(adeHomeDir, ADE_CONTROL_META_NAME);
	let meta: Partial<IAdeControlConnectionMetadata> | undefined;
	try {
		meta = JSON.parse(await fs.readFile(controlFile, 'utf8')) as Partial<IAdeControlConnectionMetadata>;
	} catch (error) {
		if (!socketOverride) {
			const detail = (error as NodeJS.ErrnoException).code === 'ENOENT'
				? `Control metadata file not found at ${controlFile}. Is Aexus Code running?`
				: `Could not read ${controlFile}: ${(error as Error).message}`;
			throw new Error(detail);
		}
	}
	const socketPath = socketOverride || meta?.socketPath;
	const token = tokenOverride ?? meta?.token ?? '';
	if (!socketPath) {
		throw new Error(`No socketPath found in ${controlFile}.`);
	}
	return { socketPath, token };
}

function sendSocketRequest(socketPath: string, payload: IAdeControlWireRequest): Promise<IAdeControlWireResponse> {
	return new Promise<IAdeControlWireResponse>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = '';
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) { return; }
			settled = true;
			socket.destroy();
			fn();
		};
		socket.setEncoding('utf8');
		socket.on('connect', () => {
			socket.write(JSON.stringify(payload) + '\n');
		});
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				finish(() => {
					try {
						resolve(JSON.parse(line) as IAdeControlWireResponse);
					} catch (error) {
						reject(new Error(`Invalid JSON response from ADE socket: ${(error as Error).message}`));
					}
				});
			}
		});
		socket.on('end', () => {
			if (!settled && buffer.trim()) {
				finish(() => {
					try {
						resolve(JSON.parse(buffer.trim()) as IAdeControlWireResponse);
					} catch (error) {
						reject(new Error(`Invalid JSON response from ADE socket: ${(error as Error).message}`));
					}
				});
			} else if (!settled) {
				finish(() => reject(new Error('ADE control socket closed without sending a response.')));
			}
		});
		socket.on('error', error => {
			finish(() => reject(new Error(`Could not connect to ADE control socket (${socketPath}): ${error.message}`)));
		});
	});
}

function formatHumanOutput(action: string | undefined, result: unknown): string {
	if (result === undefined || result === null) {
		return 'OK';
	}
	if (typeof result !== 'object') {
		return String(result);
	}
	const record = result as Record<string, unknown>;
	const id = typeof record.detached === 'string' ? record.detached : typeof record.deleted === 'string' ? record.deleted : undefined;
	const count = record.count;
	if (id !== undefined && typeof count === 'number') {
		const verb = action === 'session.delete' ? 'Deleted' : 'Detached';
		const subordinates = count - 1;
		if (subordinates > 0) {
			return `${verb} session '${id}' and removed ${subordinates} subordinate session${subordinates === 1 ? '' : 's'}.`;
		}
		return `${verb} session '${id}'.`;
	}
	const tokenSummary = formatEngineeringTokenSummary(action, result);
	const json = JSON.stringify(result, null, 2);
	return tokenSummary ? `${json}\n${tokenSummary}` : json;
}

function recordTokenTotal(value: unknown): number | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const tokenUsage = (value as Record<string, unknown>).tokenUsage;
	if (!tokenUsage || typeof tokenUsage !== 'object') {
		return undefined;
	}
	const usage = tokenUsage as Record<string, unknown>;
	if (typeof usage.totalTokens === 'number') {
		return usage.totalTokens;
	}
	const total = usage.total;
	if (total && typeof total === 'object' && typeof (total as Record<string, unknown>).totalTokens === 'number') {
		return (total as Record<string, unknown>).totalTokens as number;
	}
	return undefined;
}

function formatEngineeringTokenSummary(action: string | undefined, result: unknown): string | undefined {
	if (action !== 'engineering.list' && action !== 'engineering.status') {
		return undefined;
	}
	if (Array.isArray(result)) {
		const totals = result.map(recordTokenTotal).filter((value): value is number => typeof value === 'number');
		if (totals.length === 0) {
			return undefined;
		}
		const total = totals.reduce((sum, value) => sum + value, 0);
		return `Token usage: ${total} token${total === 1 ? '' : 's'} across ${totals.length} item${totals.length === 1 ? '' : 's'}.`;
	}
	const total = recordTokenTotal(result);
	return total === undefined ? undefined : `Token usage: ${total} token${total === 1 ? '' : 's'}.`;
}

export async function runCli(argv: readonly string[], io: AdeCliIo = {}): Promise<number> {
	const writeOut = io.stdout ?? (text => process.stdout.write(text));
	const writeErr = io.stderr ?? (text => process.stderr.write(text));
	const env = io.env ?? process.env;
	const cwd = io.cwd ?? process.cwd();

	let parsed: ParsedCliInvocation;
	try {
		parsed = parseCliCommand(argv, cwd);
	} catch (error) {
		writeErr(`Error: ${(error as Error).message}\n`);
		return 1;
	}

	if (parsed.help) {
		writeOut(HELP_TEXT);
		return 0;
	}

	try {
		const { socketPath, token } = await resolveConnection(env);
		const normalizedParams = await canonicalizeParamsPaths(parsed.params);
		if (parsed.action === 'engineering.blueprint.apply' && normalizedParams && typeof normalizedParams.file === 'string' && normalizedParams.text === undefined) {
			normalizedParams.text = await fs.readFile(normalizedParams.file, 'utf8');
		}
		const caller = env.AEXUS_ADE_CALLER?.trim();
		const effectiveParams = caller
			? { ...(normalizedParams ?? {}), caller }
			: normalizedParams;
		const makeRequest = (action: string): IAdeControlWireRequest => ({
			token,
			action,
			params: effectiveParams,
			...(parsed.windowId !== undefined ? { windowId: parsed.windowId } : {}),
		});
		let response = await sendSocketRequest(socketPath, makeRequest(parsed.action!));
		if (!response.ok && parsed.fallbackAction && /unknown|unsupported/i.test(response.error ?? '')) {
			response = await sendSocketRequest(socketPath, makeRequest(parsed.fallbackAction));
		}
		if (!response.ok) {
			if (parsed.json) {
				writeOut(JSON.stringify(response, null, 2) + '\n');
			} else {
				writeErr(`Error: ${response.error || 'ADE control command failed.'}\n`);
			}
			return 1;
		}
		if (parsed.json) {
			writeOut(JSON.stringify(response.result ?? { ok: true }, null, 2) + '\n');
		} else {
			writeOut(formatHumanOutput(parsed.action, response.result) + '\n');
		}
		return 0;
	} catch (error) {
		if (parsed.json) {
			writeOut(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2) + '\n');
		} else {
			writeErr(`Error: ${(error as Error).message}\n`);
		}
		return 1;
	}
}

const isDirectExecution = typeof require !== 'undefined' && typeof module !== 'undefined'
	? require.main === module
	: Boolean(process.argv[1] && /(?:^|[\\/])adeCli\.(?:[cm]?ts|[cm]?js)$/.test(process.argv[1]));

if (isDirectExecution) {
	void runCli(process.argv.slice(2)).then(code => {
		process.exitCode = code;
	});
}
