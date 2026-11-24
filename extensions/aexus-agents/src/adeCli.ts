/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	parseMissionDocsCommand,
	parseRankGroupCommand,
	RANK_SUBCOMMANDS,
} from './adeCliRankMission.mjs';
import {
	parseApiCommand,
	parseDocsCommand,
	parseMissionRuntimeSubcommand,
	parseOrgCommandIfRuntime,
	parseTokenGroupCommand,
	parseWhoamiCommand,
} from './adeCliMissionRuntime.mjs';
import {
	parseOrchestrationGroupCommand,
	parseWhiteboardGroupCommand,
} from './adeCliOrchestration.mjs';
import {
	ADE_CLI_SCHEMA_VERSION,
	ADE_CLI_VERSION,
	ADE_CONTROL_DIR_NAME,
	ADE_CONTROL_META_NAME,
	ADE_ENGINE_BASELINE,
	buildCompletionScript,
	computeDoctorExitCode,
	createColorizer,
	formatDoctorHuman,
	formatHumanOutput,
	formatRawBlueprintOutput,
	HELP_TEXT,
	isIdempotentReadRequest,
	MISSION_SUBCOMMANDS,
	ORCHESTRATION_SUBCOMMANDS,
	ORG_SUBCOMMANDS,
	resolveConnection,
	ROLE_SUBCOMMANDS,
	runDoctorDiagnostics,
	sendControlRequestWithRetry,
	SESSION_SUBCOMMANDS,
	shouldUseColor,
	TOKEN_SUBCOMMANDS,
	TOP_LEVEL_COMMANDS,
	WHITEBOARD_SUBCOMMANDS,
	type CompletionShell,
	type DoctorCheckStatus,
	type IAdeControlConnectionMetadata,
	type IAdeControlWireRequest,
	type IAdeControlWireResponse,
	type IDoctorCheck,
	type IDoctorReport,
} from './adeCliRuntimeSupport.mjs';

export {
	ADE_CLI_SCHEMA_VERSION,
	ADE_CLI_VERSION,
	ADE_CONTROL_DIR_NAME,
	ADE_CONTROL_META_NAME,
	ADE_ENGINE_BASELINE,
	buildCompletionScript,
	computeDoctorExitCode,
	HELP_TEXT,
	MISSION_SUBCOMMANDS,
	ORCHESTRATION_SUBCOMMANDS,
	ORG_SUBCOMMANDS,
	RANK_SUBCOMMANDS,
	ROLE_SUBCOMMANDS,
	SESSION_SUBCOMMANDS,
	TOKEN_SUBCOMMANDS,
	TOP_LEVEL_COMMANDS,
	WHITEBOARD_SUBCOMMANDS,
	type CompletionShell,
	type DoctorCheckStatus,
	type IAdeControlConnectionMetadata,
	type IAdeControlWireRequest,
	type IAdeControlWireResponse,
	type IDoctorCheck,
	type IDoctorReport,
};

export type AdeAgentRole = 'governor' | 'manager' | 'employee' | 'subordinate' | (string & {});

export interface AdeCliIo {
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
	readonly stdin?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	/** Overrides the TTY detection used for color and JSON indentation (defaults to `process.stdout.isTTY`). */
	readonly stdoutIsTTY?: boolean;
}

export interface ParsedCliInvocation {
	readonly help: boolean;
	readonly json: boolean;
	readonly pretty?: boolean;
	readonly version?: boolean;
	readonly completion?: CompletionShell;
	readonly windowId?: number;
	readonly idempotencyKey?: string;
	readonly action?: string;
	readonly fallbackAction?: string;
	readonly params?: Record<string, unknown>;
}

const ROLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidRoleSlug(val: string | undefined): val is string {
	return Boolean(val && ROLE_SLUG_RE.test(val.trim()));
}

function validateIdempotencyKey(raw: string, sourceLabel: string): string {
	const trimmed = raw.trim();
	if (!IDEMPOTENCY_KEY_RE.test(trimmed)) {
		throw new CliUsageError(`Invalid ${sourceLabel} "${raw}". Expected 1..128 characters matching [A-Za-z0-9._:-]+.`);
	}
	return trimmed;
}

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

function isCloudOrUriSpec(value: string): boolean {
	const trimmed = value.trim();
	if (/^(aexus-ssh|ssh|vscode-remote|file):\/\//i.test(trimmed)) {
		return true;
	}
	if (/^[A-Za-z0-9._@-]{2,}:\/(?!\/)(.*)$/.test(trimmed)) {
		return true;
	}
	return false;
}

function resolvePathIfRelative(value: string, cwd: string): string {
	if (isCloudOrUriSpec(value)) { return value.trim(); }
	if (value === '~') { return os.homedir(); }
	if (value.startsWith('~/') || value.startsWith('~\\')) { return path.join(os.homedir(), value.slice(2)); }
	if (value === '.' || value === '..' || value.startsWith('./') || value.startsWith('../') || value.startsWith('.\\') || value.startsWith('..\\')) {
		return path.resolve(cwd, value);
	}
	return value;
}

async function canonicalizeParamsPaths(params: Record<string, unknown> | undefined, action?: string): Promise<Record<string, unknown> | undefined> {
	if (!params) {
		return params;
	}
	if (action?.startsWith('host.')) {
		return params;
	}
	const hostSpec = typeof params.hostAlias === 'string'
		? params.hostAlias.trim()
		: (typeof params.host === 'string' ? params.host.trim() : '');
	if (hostSpec && hostSpec.toLowerCase() !== 'local') {
		return params;
	}
	const canonicalizeStr = async (val: string): Promise<string> => {
		if (val === '-' || isCloudOrUriSpec(val) || !path.isAbsolute(val)) {
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

/** Flags whose next token is opaque user text and must never be treated as a global flag or positional. */
const FREEFORM_VALUE_FLAGS = new Set<string>([
	'--message', '--report', '--feedback', '--text', '--summary', '--detail', '--body',
	'--artifact', '--decision', '--reason', '--mermaid', '--json-text', '--note', '--notes', '--evidence', '--wave-summary',
	'--prompt', '--guidance', '--pre-prompt', '--description', '--desc', '--content', '--append',
	'--title', '--name', '--label', '--edge-label', '--whiteboard-title', '--wb-title',
	'--department', '--dept', '--new-department', '--new-dept', '--group', '--new-name',
	'--branches-json', '--branches', '--branch', '--cmd', '--command', '--match', '--expect-output', '--expect-match',
	'--resolution', '--role-prompt', '--persona', '--alias', '--short', '--short-name',
]);

/** Non-freeform flags that consume a separate option argument so `positionalCount` never counts flag values. */
const KNOWN_OPTION_VALUE_FLAGS = new Set<string>([
	'--mission', '--mission-id', '--governor', '--project', '--parent', '--engine', '--engine-id',
	'--model', '--thinking', '--effort', '--role', '--rank', '--tier', '--status', '--state',
	'--limit', '-n', '--before', '--after', '--from', '--to', '--target', '--targets', '--id',
	'--node', '--node-id', '--token', '--token-id', '--task', '--task-id', '--task-node', '--tasks', '--task-ids',
	'--owner', '--owner-node', '--assignee', '--assignee-node', '--min-tier', '--completer-tier',
	'--completers', '--allowed-completers', '--host', '--host-alias', '--hostname',
	'--path', '--subpath', '--remote-path', '--target-path', '--depth', '--since', '--rev', '--revision',
	'--scope', '--format', '--view', '--file', '-f', '--out', '-o', '--detail-file', '--body-file',
	'--branches-file', '--append-file', '--prompt-file', '--message-file',
	'--whiteboard', '--whiteboards', '--wb', '--ref', '--refs', '--ptr', '--ptrs', '--trace-ptr',
	'--files', '--modified-files', '--changed-files', '--duration', '--max', '--max-duration',
	'--watch-pid', '--wake-on-pid-exit', '--pid', '--watch-file', '--wake-on-file',
	'--timeout', '--timeout-ms', '--minutes', '--silence-timeout', '--kind', '--type',
	'--fire-at', '--delay', '--interval', '--cron', '--event-type', '--event', '--gpu-threshold',
	'--trigger', '--trigger-id', '--check', '--check-id', '--cwd', '--dir', '--expect-file', '--expect-files',
	'--expect-exit', '--exit-code', '--on-fail', '--onfail', '--max-retries', '--retries',
	'--color', '--accent', '--expected-version', '--if-version', '--max-hops', '--maxHops', '--hops',
	'--budget', '--budget-limit', '--limit-usd', '--usd', '--total-cost', '--total-cost-usd',
	'--silence', '--silence-minutes', '--silence-reminder', '--silence-reminder-minutes',
	'--mode', '--layout', '--quorum', '--quorum-count', '--deadline', '--deadline-at',
	'--allowed-paths', '--allowed-path', '--allow-path', '--allow-paths', '--paths',
	'--scope-paths', '--scope-path', '--conflict-policy', '--category', '--section', '--heading',
	'--max-chars', '--maxChars', '--offset', '--tail', '--tail-chars', '--tailChars',
	'--checkpoint', '--checkpoint-id', '--against', '--base',
	'--require-whiteboard', '--require-whiteboards', '--require-wb', '--min-summary', '--min-summary-chars',
	'--handoff-token', '--mint-token', '--join-mode', '--verdict', '--rollback', '--target-node',
	'--user', '--port', '--os', '--identity', '--identity-file', '--jump', '--proxy-jump', '--default-dir',
	'--inspector', '--native-id', '--session-id', '--agent', '--agent-id', '--role-kind', '--node-role',
	'--off-graph-max-tier', '--cutoff', '--max-tier', '--supervisors-json', '--assignments-json',
	'--nodes', '--node-ids', '--branch-root', '--from-node', '--origin', '--creator', '--supervisor', '--employee',
]);

export function parseCliCommand(argv: readonly string[], cwd = process.cwd()): ParsedCliInvocation {
	let help = false;
	let json = false;
	let pretty = false;
	let version = false;
	let windowId: number | undefined;
	let idempotencyKey: string | undefined;
	const rest: string[] = [];
	let activeGroup: string | undefined;
	let sub: string | undefined;
	let positionalCount = 0;

	const isGlobalFlag = (arg: string): boolean =>
		arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version'
		|| arg === '--json' || arg === '--pretty'
		|| arg === '--window' || arg.startsWith('--window=')
		|| arg === '--window-id' || arg.startsWith('--window-id=')
		|| arg === '--idempotency-key' || arg.startsWith('--idempotency-key=');

	const isTrailingFreeTextGlobalFlag = (arg: string): boolean =>
		arg === '--json' || arg === '--pretty'
		|| arg.startsWith('--window=') || arg.startsWith('--window-id=')
		|| arg.startsWith('--idempotency-key=');

	const consumeGlobalFlag = (arg: string, index: number): number => {
		if (arg === '-h' || arg === '--help') {
			help = true;
		} else if (arg === '-v' || arg === '--version') {
			version = true;
		} else if (arg === '--json') {
			json = true;
		} else if (arg === '--pretty') {
			pretty = true;
		} else if (arg === '--idempotency-key') {
			const next = argv[++index];
			if (!next || next.startsWith('--')) {
				throw new CliUsageError('Option --idempotency-key requires a value (1..128 [A-Za-z0-9._:-]+).');
			}
			idempotencyKey = validateIdempotencyKey(next, '--idempotency-key');
		} else if (arg.startsWith('--idempotency-key=')) {
			idempotencyKey = validateIdempotencyKey(arg.slice('--idempotency-key='.length), '--idempotency-key');
		} else if (arg === '--window' || arg === '--window-id') {
			const next = argv[++index];
			if (!next || !/^\d+$/.test(next)) {
				throw new CliUsageError(`Option ${arg} requires a numeric window ID.`);
			}
			windowId = Number(next);
		} else {
			const prefix = arg.startsWith('--window-id=') ? '--window-id=' : '--window=';
			const val = arg.slice(prefix.length);
			if (!val || !/^\d+$/.test(val)) {
				throw new CliUsageError(`Option ${prefix.slice(0, -1)} requires a numeric window ID.`);
			}
			windowId = Number(val);
		}
		return index;
	};

	const withPretty = <T extends ParsedCliInvocation>(inv: T): T => ({
		...inv,
		...(pretty ? { pretty: true } : {}),
		...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
	});

	const inFreeTextPayload = (): boolean => {
		if (activeGroup === 'secretary' && sub === 'send' && positionalCount >= 1) {
			return true;
		}
		if (activeGroup === 'session' && (sub === 'send' || sub === 'draft') && positionalCount >= 1) {
			return true;
		}
		if (activeGroup === 'org' && sub === 'send' && positionalCount >= 1) {
			return true;
		}
		return false;
	};

	// Compute start index of any contiguous trailing suffix of safe global flags before `--`
	// so `session send s1 "hello" --idempotency-key=k1 --json` or `--idempotency-key k1 --pretty`
	// consumes every trailing global flag without leaking into `params.prompt` (#124 #3).
	const ddIdx = argv.indexOf('--');
	const scanEnd = ddIdx >= 0 ? ddIdx : argv.length;
	let trailingGlobalSuffixStart = scanEnd;
	while (trailingGlobalSuffixStart > 0) {
		const candidate = argv[trailingGlobalSuffixStart - 1];
		if (isTrailingFreeTextGlobalFlag(candidate)) {
			trailingGlobalSuffixStart -= 1;
			continue;
		}
		if (trailingGlobalSuffixStart >= 2) {
			const prev = argv[trailingGlobalSuffixStart - 2];
			if ((prev === '--window' || prev === '--window-id') && /^\d+$/.test(candidate)) {
				trailingGlobalSuffixStart -= 2;
				continue;
			}
			if (prev === '--idempotency-key' && !candidate.startsWith('--')) {
				trailingGlobalSuffixStart -= 2;
				continue;
			}
		}
		break;
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--') {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (!activeGroup) {
			if (isGlobalFlag(arg)) {
				i = consumeGlobalFlag(arg, i);
				continue;
			}
			activeGroup = arg;
			rest.push(arg);
			continue;
		}
		if (inFreeTextPayload()) {
			if ((activeGroup === 'session' || activeGroup === 'secretary' || activeGroup === 'org') && sub === 'send') {
				if (arg === '--wait') {
					rest.push(arg);
					continue;
				}
				if (
					arg === '--prompt-file' || arg === '--message-file' || arg === '--file'
					|| arg.startsWith('--prompt-file=') || arg.startsWith('--message-file=') || arg.startsWith('--file=')
				) {
					rest.push(arg);
					if (!arg.includes('=') && i + 1 < argv.length) {
						rest.push(argv[++i]);
					}
					continue;
				}
			}
			// Consume any contiguous trailing suffix of safe global flags (`--json`, `--pretty`, `--window`, `--idempotency-key`);
			// `--help`/`-v` stay part of the sent message!
			if (i >= trailingGlobalSuffixStart && isGlobalFlag(arg) && arg !== '-h' && arg !== '--help' && arg !== '-v' && arg !== '--version') {
				i = consumeGlobalFlag(arg, i);
				continue;
			}
			rest.push(arg);
			continue;
		}
		if (arg === '--draft') {
			rest.push(arg);
			if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
				rest.push(argv[++i]);
			}
			continue;
		}
		const eqIdx = arg.indexOf('=');
		const flagBase = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
		if (FREEFORM_VALUE_FLAGS.has(flagBase)) {
			rest.push(arg);
			if (eqIdx < 0 && i + 1 < argv.length) {
				rest.push(argv[++i]);
			}
			continue;
		}
		if (isGlobalFlag(arg)) {
			i = consumeGlobalFlag(arg, i);
			continue;
		}
		if (sub === undefined && !arg.startsWith('-')) {
			sub = arg;
			rest.push(arg);
			continue;
		}
		if (eqIdx < 0 && KNOWN_OPTION_VALUE_FLAGS.has(arg)) {
			rest.push(arg);
			if (i + 1 < argv.length && !isGlobalFlag(argv[i + 1]) && !argv[i + 1].startsWith('--')) {
				rest.push(argv[++i]);
			}
			continue;
		}
		if (!arg.startsWith('-')) {
			positionalCount++;
		}
		rest.push(arg);
	}

	if (version) {
		return withPretty({ help: false, json, version: true, windowId });
	}

	if (help || rest.length === 0 || rest[0] === 'help') {
		return withPretty({ help: true, json, windowId });
	}

	const [group, ...tail] = rest;

	if (group === 'version') {
		if (tail.length > 0) { throw new CliUsageError(`Unexpected arguments for version: ${tail.join(' ')}`); }
		return withPretty({ help: false, json, version: true, windowId });
	}

	if (group === 'completion') {
		const rawShell = tail[0]?.trim().toLowerCase();
		const shell: CompletionShell | undefined = rawShell === 'pwsh'
			? 'powershell'
			: (rawShell === 'bash' || rawShell === 'zsh' || rawShell === 'fish' || rawShell === 'powershell' ? rawShell : undefined);
		if (!shell || tail.length > 1) {
			throw new CliUsageError('Usage: aexus-ade completion <bash|zsh|fish|powershell>');
		}
		return withPretty({ help: false, json, completion: shell, windowId });
	}

	if (group === 'status') {
		if (tail.length > 0) { throw new CliUsageError(`Unexpected arguments for status: ${tail.join(' ')}`); }
		return withPretty({ help: false, json, windowId, action: 'status', params: {} });
	}

	if (group === 'whoami') {
		return withPretty(parseWhoamiCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'docs' || group === 'doc') {
		return withPretty(parseDocsCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'api') {
		return withPretty(parseApiCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'token' || group === 'tokens') {
		return withPretty(parseTokenGroupCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'orchestration' || group === 'orch') {
		return withPretty(parseOrchestrationGroupCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'whiteboard' || group === 'whiteboards' || group === 'wb') {
		return withPretty(parseWhiteboardGroupCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'doctor') {
		let projectPath = cwd;
		let strict = false;
		for (let i = 0; i < tail.length; i++) {
			const arg = tail[i];
			if (arg === '--project') {
				const next = tail[++i];
				if (!next || next.startsWith('--')) { throw new CliUsageError('Option --project requires a path.'); }
				projectPath = resolvePathIfRelative(next, cwd);
			} else if (arg.startsWith('--project=')) {
				const next = arg.slice('--project='.length);
				if (!next) { throw new CliUsageError('Option --project requires a path.'); }
				projectPath = resolvePathIfRelative(next, cwd);
			} else if (arg === '--strict') {
				strict = true;
			} else if (!arg.startsWith('-')) {
				projectPath = resolvePathIfRelative(arg, cwd);
			} else {
				throw new CliUsageError(`Unknown option for doctor: ${arg}`);
			}
		}
		return withPretty({ help: false, json, windowId, action: 'doctor', params: strict ? { projectPath, strict: true } : { projectPath } });
	}

	if (group === 'mode') {
		if (tail.length === 0 || (tail.length === 1 && tail[0] === 'get')) {
			return withPretty({ help: false, json, windowId, action: 'mode.get', params: {} });
		}
		const modeArg = tail[0] === 'set' ? tail[1] : tail[0];
		const extra = tail[0] === 'set' ? tail.slice(2) : tail.slice(1);
		if (!modeArg || (modeArg !== 'ade' && modeArg !== 'ide') || extra.length > 0) {
			throw new CliUsageError('Usage: aexus-ade mode [get | set <ade|ide>]');
		}
		return withPretty({ help: false, json, windowId, action: 'mode.set', params: { mode: modeArg } });
	}

	if (group === 'view') {
		if (tail.length === 0 || (tail.length === 1 && (tail[0] === 'status' || tail[0] === 'get'))) {
			return withPretty({ help: false, json, windowId, action: 'view.get', params: {} });
		}
		if (tail.length === 1 && tail[0] === 'refresh') {
			return withPretty({ help: false, json, windowId, action: 'view.refresh', params: {} });
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
				if (!inspector || inspector.startsWith('--')) { throw new CliUsageError('Option --inspector requires changes, files, or hide.'); }
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
		return withPretty({ help: false, json, windowId, action: 'view.set', params });
	}

	if (group === 'project') {
		const pSub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (pSub === 'list') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for project list: ${args.join(' ')}`); }
			return withPretty({ help: false, json, windowId, action: 'project.list', params: {} });
		}
		if (pSub === 'add') {
			let customName: string | undefined;
			const rawPaths: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--name' || arg === '--label') {
					customName = args[++i];
					if (!customName) { throw new CliUsageError(`Option ${arg} requires a value.`); }
				} else if (arg.startsWith('--name=')) {
					customName = arg.slice('--name='.length);
				} else if (arg.startsWith('--label=')) {
					customName = arg.slice('--label='.length);
				} else if (!arg.startsWith('-')) {
					rawPaths.push(arg);
				} else {
					throw new CliUsageError(`Unknown option for project add: ${arg}`);
				}
			}
			if (rawPaths.length === 0) { throw new CliUsageError('Usage: aexus-ade project add <path...> [--name <label>]'); }
			const paths = rawPaths.map(item => {
				if (isCloudOrUriSpec(item)) {
					return item.trim();
				}
				const expanded = (item.startsWith('~/') || item.startsWith('~\\'))
					? path.join(os.homedir(), item.slice(2))
					: item === '~'
						? os.homedir()
						: item;
				return path.resolve(cwd, expanded);
			});
			return withPretty({ help: false, json, windowId, action: 'project.add', params: customName ? { paths, name: customName } : { paths } });
		}
		if (pSub === 'select') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade project select <target>'); }
			return withPretty({ help: false, json, windowId, action: 'project.select', params: { target: resolvePathIfRelative(args[0], cwd) } });
		}
		if (pSub === 'remove') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade project remove <target>'); }
			return withPretty({ help: false, json, windowId, action: 'project.remove', params: { target: resolvePathIfRelative(args[0], cwd) } });
		}
		if (pSub === 'delete') {
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
			return withPretty({
				help: false,
				json,
				windowId,
				action: 'project.delete',
				params: { target: resolvePathIfRelative(target, cwd), deleteSessions, deleteFiles, ...(permanent ? { permanent: true } : {}) },
			});
		}
		if (pSub === 'focus') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade project focus <target>'); }
			return withPretty({ help: false, json, windowId, action: 'project.focus', params: { target: resolvePathIfRelative(args[0], cwd) } });
		}
		if (pSub === 'home') {
			if (args.length > 0) { throw new CliUsageError('Usage: aexus-ade project home'); }
			return withPretty({ help: false, json, windowId, action: 'project.home', params: {} });
		}
		if (pSub === 'forward') {
			if (args.length > 0) { throw new CliUsageError('Usage: aexus-ade project forward'); }
			return withPretty({ help: false, json, windowId, action: 'project.forward', params: {} });
		}
		if (pSub === 'move') {
			let source: string | undefined;
			let before: string | undefined;
			let after: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--before') {
					before = args[++i];
					if (!before || before.startsWith('--')) { throw new CliUsageError('Option --before requires a target project.'); }
				} else if (arg.startsWith('--before=')) {
					before = arg.slice('--before='.length);
				} else if (arg === '--after') {
					after = args[++i];
					if (!after || after.startsWith('--')) { throw new CliUsageError('Option --after requires a target project.'); }
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
				return withPretty({ help: false, json, windowId, action: 'project.move', params: { source: resolvedSource, before: resolvedTarget, target: resolvedTarget, position: 'before' } });
			}
			const resolvedTarget = resolvePathIfRelative(after!, cwd);
			return withPretty({ help: false, json, windowId, action: 'project.move', params: { source: resolvedSource, after: resolvedTarget, target: resolvedTarget, position: 'after' } });
		}
		if (pSub === 'changes') {
			if (args.length > 1) { throw new CliUsageError('Usage: aexus-ade project changes [target]'); }
			const params: Record<string, unknown> = {};
			if (args[0]) { params.target = resolvePathIfRelative(args[0], cwd); }
			return withPretty({ help: false, json, windowId, action: 'project.changes', params });
		}
		if (pSub === 'files') {
			let target: string | undefined;
			let subpath: string | undefined;
			let depth: number | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--path' || arg === '--subpath') {
					subpath = args[++i];
					if (!subpath || subpath.startsWith('--')) { throw new CliUsageError(`Option ${arg} requires a relative path.`); }
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
			return withPretty({ help: false, json, windowId, action: 'project.files', params });
		}
		if (pSub === 'open-file' || pSub === 'openFile') {
			let file: string | undefined;
			let project: string | undefined;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--side') {
					side = true;
				} else if (!arg.startsWith('-') && file === undefined) {
					file = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for project ${pSub}: ${arg}`);
				}
			}
			if (!file) { throw new CliUsageError('Usage: aexus-ade project open-file <file> [--project <target>] [--side]'); }
			const params: Record<string, unknown> = { file: resolvePathIfRelative(file, cwd) };
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			if (side) { params.side = true; }
			return withPretty({ help: false, json, windowId, action: 'project.openFile', params });
		}
		if (pSub === 'open-diff' || pSub === 'openDiff' || pSub === 'diff') {
			let file: string | undefined;
			let project: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (!arg.startsWith('-') && file === undefined) {
					file = arg;
				} else {
					throw new CliUsageError(`Unexpected argument for project ${pSub}: ${arg}`);
				}
			}
			if (!file) { throw new CliUsageError('Usage: aexus-ade project open-diff <file> [--project <target>]'); }
			const params: Record<string, unknown> = { file: resolvePathIfRelative(file, cwd) };
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			return withPretty({ help: false, json, windowId, action: 'project.openDiff', params });
		}
		throw new CliUsageError(`Unknown project subcommand: ${pSub}`);
	}

	if (group === 'engine') {
		const eSub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (eSub === 'list') {
			if (args.length > 0) {
				throw new CliUsageError('Usage: aexus-ade engine list');
			}
			return withPretty({ help: false, json, windowId, action: 'engine.list', params: {} });
		}
		if (eSub === 'sessions') {
			let engine: string | undefined;
			let project: string | undefined;
			let limit: number | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a target project.'); }
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
			return withPretty({ help: false, json, windowId, action: 'engine.sessions', params });
		}
		throw new CliUsageError('Usage: aexus-ade engine <list | sessions <engine>>');
	}

	if (group === 'session') {
		const sSub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (sSub === 'list') {
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
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--parent') {
					parent = args[++i];
					if (!parent || parent.startsWith('--')) { throw new CliUsageError('Option --parent requires a parent session ID or "root".'); }
				} else if (arg.startsWith('--parent=')) {
					parent = arg.slice('--parent='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID (e.g. governor, manager, employee, worker, or custom rank ID).');
					}
					role = val.trim().toLowerCase();
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID (e.g. governor, manager, employee, worker, or custom rank ID).');
					}
					role = val.trim().toLowerCase();
				} else if (arg === '--engine') {
					engine = args[++i];
					if (!engine || engine.startsWith('--')) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--status') {
					status = args[++i];
					if (!status || status.startsWith('--')) { throw new CliUsageError('Option --status requires idle, working, pending, or draft.'); }
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
			return withPretty({ help: false, json, windowId, action: 'session.list', params });
		}
		if (sSub === 'info' || sSub === 'get' || sSub === 'show') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError(`Usage: aexus-ade session ${sSub} <id>`);
			}
			return withPretty({ help: false, json, windowId, action: 'session.info', params: { id: args[0] } });
		}
		if (sSub === 'subordinates' || sSub === 'children') {
			let id: string | undefined;
			let recursive = false;
			for (const arg of args) {
				if (arg === '--recursive' || arg === '-r') { recursive = true; }
				else if (!arg.startsWith('-') && id === undefined) { id = arg; }
				else { throw new CliUsageError(`Unexpected argument for session ${sSub}: ${arg}`); }
			}
			const params: Record<string, unknown> = {};
			if (id !== undefined) { params.id = id; }
			if (recursive) { params.recursive = true; }
			return withPretty({ help: false, json, windowId, action: 'session.subordinates', params });
		}
		if (sSub === 'tree' || sSub === 'subtree') {
			let id: string | undefined;
			for (const arg of args) {
				if (!arg.startsWith('-') && id === undefined) { id = arg; }
				else { throw new CliUsageError(`Unexpected argument for session ${sSub}: ${arg}`); }
			}
			return withPretty({ help: false, json, windowId, action: 'session.tree', params: id !== undefined ? { id } : {} });
		}
		if (sSub === 'create') {
			let project: string | undefined;
			let engine: string | undefined;
			let title: string | undefined;
			let parent: string | undefined;
			let role: string | undefined;
			let model: string | undefined;
			let thinking: string | undefined;
			let draftOnly = false;
			let draftText: string | undefined;
			let noOpen = false;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a value.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--engine') {
					engine = args[++i];
					if (!engine || engine.startsWith('--')) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--title') {
					title = args[++i];
					if (title === undefined) { throw new CliUsageError('Option --title requires a value.'); }
				} else if (arg.startsWith('--title=')) {
					title = arg.slice('--title='.length);
				} else if (arg === '--parent') {
					parent = args[++i];
					if (!parent || parent.startsWith('--')) { throw new CliUsageError('Option --parent requires a parent session ID.'); }
				} else if (arg.startsWith('--parent=')) {
					parent = arg.slice('--parent='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID (e.g. governor, manager, employee, worker, or custom rank ID).');
					}
					role = val.trim().toLowerCase();
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID (e.g. governor, manager, employee, worker, or custom rank ID).');
					}
					role = val.trim().toLowerCase();
				} else if (arg === '--draft') {
					const next = args[i + 1];
					if (next !== undefined && !next.startsWith('--')) {
						draftText = args[++i];
					} else {
						draftOnly = true;
					}
				} else if (arg.startsWith('--draft=')) {
					draftText = arg.slice('--draft='.length);
				} else if (arg === '--model') {
					const val = args[++i];
					if (!val || val.startsWith('--')) { throw new CliUsageError('Option --model requires a model ID.'); }
					model = val;
				} else if (arg.startsWith('--model=')) {
					model = arg.slice('--model='.length);
				} else if (arg === '--thinking' || arg === '--effort') {
					const val = args[++i];
					if (!val || val.startsWith('--')) { throw new CliUsageError(`Option ${arg} requires a thinking level (off|low|medium|high|xhigh|max).`); }
					thinking = val;
				} else if (arg.startsWith('--thinking=')) {
					thinking = arg.slice('--thinking='.length);
				} else if (arg.startsWith('--effort=')) {
					thinking = arg.slice('--effort='.length);
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
			if (model !== undefined) { params.model = model; }
			if (thinking !== undefined) { params.thinking = thinking; }
			if (draftOnly) { params.draft = true; }
			if (draftText !== undefined) { params.draftText = draftText; if (engine === undefined) { params.draft = true; } }
			return withPretty({ help: false, json, windowId, action: 'session.create', params });
		}
		if (sSub === 'configure' || sSub === 'prefs') {
			let id: string | undefined;
			let engine: string | undefined;
			let model: string | undefined;
			let thinking: string | undefined;
			let role: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--engine') {
					engine = args[++i];
					if (!engine || engine.startsWith('--')) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--model') {
					model = args[++i];
					if (model === undefined || model.startsWith('--')) { throw new CliUsageError('Option --model requires a model ID.'); }
				} else if (arg.startsWith('--model=')) {
					model = arg.slice('--model='.length);
				} else if (arg === '--thinking' || arg === '--effort') {
					thinking = args[++i];
					if (!thinking || thinking.startsWith('--')) { throw new CliUsageError(`Option ${arg} requires a thinking level.`); }
				} else if (arg.startsWith('--thinking=')) {
					thinking = arg.slice('--thinking='.length);
				} else if (arg.startsWith('--effort=')) {
					thinking = arg.slice('--effort='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID.');
					}
					role = val.trim().toLowerCase();
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID.');
					}
					role = val.trim().toLowerCase();
				} else if (!arg.startsWith('-') && id === undefined) {
					id = arg;
				} else {
					throw new CliUsageError(`Unknown option for session configure: ${arg}`);
				}
			}
			if (!id) {
				throw new CliUsageError('Usage: aexus-ade session configure <id> [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|xhigh|max>] [--role <r>]');
			}
			const params: Record<string, unknown> = { id };
			if (engine !== undefined) { params.engine = engine; }
			if (model !== undefined) { params.model = model; }
			if (thinking !== undefined) { params.thinking = thinking; }
			if (role !== undefined) { params.role = role; }
			return withPretty({ help: false, json, windowId, action: 'session.configure', params });
		}
		if (sSub === 'attach' || sSub === 'import') {
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
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a value.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (arg === '--engine') {
					engine = args[++i];
					if (!engine || engine.startsWith('--')) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--native-id' || arg === '--session-id') {
					nativeId = args[++i];
					if (!nativeId || nativeId.startsWith('--')) { throw new CliUsageError(`Option ${arg} requires a native conversation ID.`); }
				} else if (arg.startsWith('--native-id=')) {
					nativeId = arg.slice('--native-id='.length);
				} else if (arg === '--title') {
					title = args[++i];
					if (title === undefined) { throw new CliUsageError('Option --title requires a value.'); }
				} else if (arg.startsWith('--title=')) {
					title = arg.slice('--title='.length);
				} else if (arg === '--parent') {
					parent = args[++i];
					if (!parent || parent.startsWith('--')) { throw new CliUsageError('Option --parent requires a parent session ID.'); }
				} else if (arg.startsWith('--parent=')) {
					parent = arg.slice('--parent='.length);
				} else if (arg === '--role') {
					const val = args[++i];
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID (e.g. governor, manager, employee, worker, or custom rank ID).');
					}
					role = val.trim().toLowerCase();
				} else if (arg.startsWith('--role=')) {
					const val = arg.slice('--role='.length);
					if (!isValidRoleSlug(val)) {
						throw new CliUsageError('Option --role requires a valid rank ID (e.g. governor, manager, employee, worker, or custom rank ID).');
					}
					role = val.trim().toLowerCase();
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
			return withPretty({ help: false, json, windowId, action: 'session.attach', params });
		}
		if (sSub === 'connect') {
			let id: string | undefined;
			let engine: string | undefined;
			let nativeId: string | undefined;
			let noOpen = false;
			let side = false;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--engine') {
					engine = args[++i];
					if (!engine || engine.startsWith('--')) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else if (arg === '--native-id' || arg === '--session-id') {
					nativeId = args[++i];
					if (!nativeId || nativeId.startsWith('--')) { throw new CliUsageError(`Option ${arg} requires a native conversation ID.`); }
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
			return withPretty({ help: false, json, windowId, action: 'session.connect', params });
		}
		if (sSub === 'open') {
			let id: string | undefined;
			let side = false;
			for (const arg of args) {
				if (arg === '--side') { side = true; }
				else if (!arg.startsWith('-') && id === undefined) { id = arg; }
				else { throw new CliUsageError(`Unexpected argument for session open: ${arg}`); }
			}
			if (!id) { throw new CliUsageError('Usage: aexus-ade session open <id> [--side]'); }
			return withPretty({ help: false, json, windowId, action: 'session.open', params: side ? { id, side: true } : { id } });
		}
		if (sSub === 'select') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session select <id>');
			}
			return withPretty({ help: false, json, windowId, action: 'session.select', params: { id: args[0] } });
		}
		if (sSub === 'close') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session close <id>');
			}
			return withPretty({ help: false, json, windowId, action: 'session.close', params: { id: args[0] } });
		}
		if (sSub === 'mark-read' || sSub === 'markRead') {
			if (args.length === 1 && args[0] === '--all') {
				return withPretty({ help: false, json, windowId, action: 'session.markRead', params: { all: true } });
			}
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session mark-read (<id> | --all)');
			}
			return withPretty({ help: false, json, windowId, action: 'session.markRead', params: { id: args[0] } });
		}
		if (sSub === 'draft') {
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
			return withPretty({ help: false, json, windowId, action: 'session.draft', params });
		}
		if (sSub === 'reorder') {
			let id: string | undefined;
			let before: string | undefined;
			let after: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--before') {
					before = args[++i];
					if (!before || before.startsWith('--')) { throw new CliUsageError('Option --before requires a target session ID.'); }
				} else if (arg.startsWith('--before=')) {
					before = arg.slice('--before='.length);
				} else if (arg === '--after') {
					after = args[++i];
					if (!after || after.startsWith('--')) { throw new CliUsageError('Option --after requires a target session ID.'); }
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
			return withPretty({
				help: false,
				json,
				windowId,
				action: 'session.reorder',
				params: before !== undefined
					? { id, before, target: before, position: 'before' }
					: { id, after, target: after, position: 'after' },
			});
		}
		if (sSub === 'rename') {
			if (args.length < 2) { throw new CliUsageError('Usage: aexus-ade session rename <id> <title>'); }
			const id = args[0];
			const title = args.slice(1).join(' ');
			return withPretty({ help: false, json, windowId, action: 'session.rename', params: { id, title } });
		}
		if (sSub === 'role') {
			if (args.length !== 2) { throw new CliUsageError('Usage: aexus-ade session role <id> <rankId|worker|none>'); }
			const [id, rawRoleArg] = args;
			const roleArg = rawRoleArg.trim().toLowerCase();
			if (roleArg !== 'none' && !isValidRoleSlug(roleArg)) {
				throw new CliUsageError('Role must be a valid rank ID (e.g. governor, manager, employee, worker, custom rank ID, or none).');
			}
			return withPretty({ help: false, json, windowId, action: 'session.setRole', params: { id, role: roleArg === 'none' || roleArg === 'worker' ? null : roleArg } });
		}
		if (sSub === 'send') {
			let wait = false;
			let promptFile: string | undefined;
			let explicitPrompt: string | undefined;
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--wait') {
					wait = true;
				} else if (arg === '--prompt-file' || arg === '--message-file' || arg === '--file') {
					promptFile = args[++i];
					if (!promptFile) { throw new CliUsageError(`Option ${arg} requires a file path or "-".`); }
				} else if (arg.startsWith('--prompt-file=') || arg.startsWith('--message-file=') || arg.startsWith('--file=')) {
					promptFile = arg.slice(arg.indexOf('=') + 1);
					if (!promptFile) { throw new CliUsageError('Option --prompt-file requires a file path or "-".'); }
				} else if (arg === '--prompt' || arg === '--message') {
					explicitPrompt = args[++i];
					if (explicitPrompt === undefined) { throw new CliUsageError(`Option ${arg} requires a value.`); }
				} else if (arg.startsWith('--prompt=') || arg.startsWith('--message=')) {
					explicitPrompt = arg.slice(arg.indexOf('=') + 1);
				} else {
					positional.push(arg);
				}
			}
			const id = positional[0];
			const prompt = explicitPrompt !== undefined ? explicitPrompt : positional.slice(1).join(' ');
			if (!id || (!prompt && !promptFile)) {
				throw new CliUsageError('Usage: aexus-ade session send <id> (<prompt> | --prompt-file <path|->) [--wait]');
			}
			const params: Record<string, unknown> = { id };
			if (prompt) { params.prompt = prompt; }
			if (promptFile) { params.promptFile = promptFile; }
			if (wait) { params.wait = true; }
			return withPretty({ help: false, json, windowId, action: 'session.send', params });
		}
		if (sSub === 'history' || sSub === 'messages') {
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
					throw new CliUsageError(`Unknown argument for session ${sSub}: ${arg}`);
				}
			}
			if (!id) { throw new CliUsageError(`Usage: aexus-ade session ${sSub} <id> [--limit <n>]`); }
			return withPretty({ help: false, json, windowId, action: 'session.history', params: limit !== undefined ? { id, limit } : { id } });
		}
		if (sSub === 'stop' || sSub === 'cancel') {
			if (args.length !== 1 || args[0].startsWith('-')) {
				throw new CliUsageError(`Usage: aexus-ade session ${sSub} <id>`);
			}
			return withPretty({ help: false, json, windowId, action: 'session.stop', params: { id: args[0] } });
		}
		if (sSub === 'nest' || sSub === 'reparent' || sSub === 'move') {
			let project: string | undefined;
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--project') {
					project = args[++i];
					if (!project || project.startsWith('--')) { throw new CliUsageError('Option --project requires a target project.'); }
				} else if (arg.startsWith('--project=')) {
					project = arg.slice('--project='.length);
				} else if (!arg.startsWith('-')) {
					positional.push(arg);
				} else {
					throw new CliUsageError(`Unknown option for session ${sSub}: ${arg}`);
				}
			}
			if (positional.length !== 2) { throw new CliUsageError(`Usage: aexus-ade session ${sSub} <id> <parentId|none> [--project <p>]`); }
			const [id, parentArg] = positional;
			const params: Record<string, unknown> = {
				id,
				parentId: parentArg === 'none' || parentArg === 'root' ? null : parentArg,
			};
			if (project !== undefined) { params.project = resolvePathIfRelative(project, cwd); }
			return withPretty({ help: false, json, windowId, action: 'session.reparent', params });
		}
		if (sSub === 'archive' || sSub === 'unarchive' || sSub === 'restore') {
			if (args.length !== 1) { throw new CliUsageError(`Usage: aexus-ade session ${sSub} <id>`); }
			return withPretty({ help: false, json, windowId, action: 'session.archive', params: { id: args[0], archived: sSub === 'archive' } });
		}
		if (sSub === 'detach' || sSub === 'remove') {
			if (args.length !== 1) { throw new CliUsageError(`Usage: aexus-ade session ${sSub} <id>`); }
			return withPretty({ help: false, json, windowId, action: 'session.detach', params: { id: args[0] } });
		}
		if (sSub === 'delete') {
			const force = args.some(arg => arg === '--force' || arg === '-f');
			const filtered = args.filter(arg => arg !== '--force' && arg !== '-f');
			if (filtered.length !== 1 || filtered[0].startsWith('-')) {
				throw new CliUsageError('Usage: aexus-ade session delete <id> [--force]');
			}
			return withPretty({
				help: false,
				json,
				windowId,
				action: 'session.delete',
				params: force ? { id: filtered[0], force: true } : { id: filtered[0] },
			});
		}
		throw new CliUsageError(`Unknown session subcommand: ${sSub}`);
	}

	if (group === 'secretary') {
		const secSub = tail[0] ?? 'status';
		const args = tail.slice(1);
		if (secSub === 'status' || secSub === 'info') {
			if (args.length > 0) { throw new CliUsageError(`Usage: aexus-ade secretary [${secSub}]`); }
			return withPretty({ help: false, json, windowId, action: 'secretary.status', params: {} });
		}
		if (secSub === 'open') {
			let side = false;
			for (const arg of args) {
				if (arg === '--side') { side = true; }
				else { throw new CliUsageError(`Unknown option for secretary open: ${arg}`); }
			}
			return withPretty({ help: false, json, windowId, action: 'secretary.open', params: side ? { side: true } : {} });
		}
		if (secSub === 'engine') {
			if (args.length !== 1) { throw new CliUsageError('Usage: aexus-ade secretary engine <e>'); }
			return withPretty({ help: false, json, windowId, action: 'secretary.engine', fallbackAction: 'secretary.setEngine', params: { engine: args[0] } });
		}
		if (secSub === 'reset') {
			let engine: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--engine') {
					engine = args[++i];
					if (!engine || engine.startsWith('--')) { throw new CliUsageError('Option --engine requires an engine ID.'); }
				} else if (arg.startsWith('--engine=')) {
					engine = arg.slice('--engine='.length);
				} else {
					throw new CliUsageError(`Unknown option for secretary reset: ${arg}`);
				}
			}
			return withPretty({ help: false, json, windowId, action: 'secretary.reset', params: engine !== undefined ? { engine } : {} });
		}
		if (secSub === 'send') {
			let wait = false;
			let promptFile: string | undefined;
			let explicitPrompt: string | undefined;
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === '--wait') {
					wait = true;
				} else if (arg === '--prompt-file' || arg === '--message-file' || arg === '--file') {
					promptFile = args[++i];
					if (!promptFile) { throw new CliUsageError(`Option ${arg} requires a file path or "-".`); }
				} else if (arg.startsWith('--prompt-file=') || arg.startsWith('--message-file=') || arg.startsWith('--file=')) {
					promptFile = arg.slice(arg.indexOf('=') + 1);
					if (!promptFile) { throw new CliUsageError('Option --prompt-file requires a file path or "-".'); }
				} else if (arg === '--prompt' || arg === '--message') {
					explicitPrompt = args[++i];
					if (explicitPrompt === undefined) { throw new CliUsageError(`Option ${arg} requires a value.`); }
				} else if (arg.startsWith('--prompt=') || arg.startsWith('--message=')) {
					explicitPrompt = arg.slice(arg.indexOf('=') + 1);
				} else {
					positional.push(arg);
				}
			}
			const prompt = explicitPrompt !== undefined ? explicitPrompt : positional.join(' ');
			if (!prompt && !promptFile) {
				throw new CliUsageError('Usage: aexus-ade secretary send (<prompt> | --prompt-file <path|->) [--wait]');
			}
			const params: Record<string, unknown> = {};
			if (prompt) { params.prompt = prompt; }
			if (promptFile) { params.promptFile = promptFile; }
			if (wait) { params.wait = true; }
			return withPretty({ help: false, json, windowId, action: 'secretary.send', params });
		}
		if (secSub === 'history' || secSub === 'messages') {
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
					throw new CliUsageError(`Unknown option for secretary ${secSub}: ${arg}`);
				}
			}
			return withPretty({ help: false, json, windowId, action: 'secretary.history', params: limit !== undefined ? { limit } : {} });
		}
		if (secSub === 'stop' || secSub === 'cancel') {
			if (args.length > 0) { throw new CliUsageError(`Usage: aexus-ade secretary ${secSub}`); }
			return withPretty({ help: false, json, windowId, action: 'secretary.stop', params: {} });
		}
		if (secSub === 'draft') {
			let clear = false;
			const textParts: string[] = [];
			for (const arg of args) {
				if (arg === '--clear') { clear = true; }
				else { textParts.push(arg); }
			}
			const params: Record<string, unknown> = {};
			if (clear) { params.clear = true; }
			else if (textParts.length > 0) { params.draft = textParts.join(' '); }
			return withPretty({ help: false, json, windowId, action: 'secretary.draft', params });
		}
		if (secSub === 'mark-read' || secSub === 'markRead') {
			if (args.length > 0) { throw new CliUsageError(`Usage: aexus-ade secretary ${secSub}`); }
			return withPretty({ help: false, json, windowId, action: 'secretary.markRead', params: {} });
		}
		throw new CliUsageError(`Unknown secretary subcommand: ${secSub}`);
	}

	if (group === 'rank' || group === 'ranks') {
		return withPretty(parseRankGroupCommand(tail, json, windowId, msg => new CliUsageError(msg)));
	}

	if (group === 'mission') {
		const missionDocs = parseMissionDocsCommand(tail, json, windowId);
		if (missionDocs) {
			return withPretty(missionDocs);
		}
		const missionRuntimeCmd = parseMissionRuntimeSubcommand(tail, json, windowId, msg => new CliUsageError(msg));
		if (missionRuntimeCmd) {
			return withPretty(missionRuntimeCmd);
		}

		const mSub = tail[0] ?? 'list';
		const args = tail.slice(1);

		const takeOptionVal = (iRef: { i: number }, flagName: string, list: readonly string[], allowDash = false): string => {
			const cur = list[iRef.i];
			const eqIdx = cur.indexOf('=');
			if (eqIdx >= 0) {
				const val = cur.slice(eqIdx + 1);
				if (!val) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
				return val;
			}
			const next = list[++iRef.i];
			if (next === undefined) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
			if (!allowDash && next.startsWith('--')) {
				throw new CliUsageError(`Option ${flagName} requires a value, got ${next}.`);
			}
			return next;
		};

		if (mSub === 'init') {
			let owner: string | undefined;
			let title: string | undefined;
			let project: string | undefined;
			let open = false;
			let side = false;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--owner' || arg.startsWith('--owner=')) {
					owner = takeOptionVal(ref, '--owner', args);
				} else if (arg === '--title' || arg.startsWith('--title=')) {
					title = takeOptionVal(ref, '--title', args, true);
				} else if (arg === '--project' || arg.startsWith('--project=')) {
					project = resolvePathIfRelative(takeOptionVal(ref, '--project', args), cwd);
				} else if (arg === '--open') {
					open = true;
				} else if (arg === '--side') {
					side = true;
				} else if (!arg.startsWith('-') && !owner) {
					owner = arg;
				} else {
					throw new CliUsageError(`Unknown option for mission init: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (owner) { params.owner = owner; }
			if (title) { params.title = title; }
			if (project) { params.project = project; }
			if (open) { params.open = true; }
			if (side) { params.side = true; }
			return withPretty({ help: false, json, windowId, action: 'mission.init', params });
		}

		if (mSub === 'rename' || mSub === 'set-title') {
			let missionId: string | undefined;
			let title: string | undefined;
			const posTitleParts: string[] = [];
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=') || arg === '--id' || arg.startsWith('--id=')) {
					missionId = takeOptionVal(ref, '--mission', args);
				} else if (arg === '--title' || arg.startsWith('--title=') || arg === '--name' || arg.startsWith('--name=')) {
					title = takeOptionVal(ref, '--title', args, true);
				} else if (!arg.startsWith('-') && !missionId) {
					missionId = arg;
				} else if (!arg.startsWith('-')) {
					posTitleParts.push(arg);
				} else {
					throw new CliUsageError(`Unknown option for mission rename: ${arg}`);
				}
			}
			const resolvedTitle = (title ?? posTitleParts.join(' ')).trim();
			if (!missionId || !resolvedTitle) {
				throw new CliUsageError('Usage: aexus-ade mission rename <missionId> "<newTitle>"');
			}
			return withPretty({
				help: false,
				json,
				windowId,
				action: 'mission.rename',
				params: { missionId, title: resolvedTitle },
			});
		}

		if (mSub === 'list') {
			let project: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--project' || arg.startsWith('--project=')) {
					project = resolvePathIfRelative(takeOptionVal(ref, '--project', args), cwd);
				} else {
					throw new CliUsageError(`Unknown option for mission list: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (project) { params.project = project; }
			return withPretty({ help: false, json, windowId, action: 'mission.list', params });
		}

		if (mSub === 'open') {
			let missionId: string | undefined;
			let view: string | undefined;
			let side = false;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=')) {
					missionId = takeOptionVal(ref, '--mission', args);
				} else if (arg === '--view' || arg.startsWith('--view=')) {
					view = takeOptionVal(ref, '--view', args).toLowerCase();
					if (view !== 'mission' && view !== 'orchestration' && view !== 'both') {
						throw new CliUsageError('Option --view must be mission, orchestration, or both.');
					}
				} else if (arg === '--side') {
					side = true;
				} else if (!arg.startsWith('-') && !missionId) {
					missionId = arg;
				} else {
					throw new CliUsageError(`Unknown option for mission open: ${arg}`);
				}
			}
			if (!missionId) {
				throw new CliUsageError('Usage: aexus-ade mission open --mission <id> [--view <mission|orchestration|both>] [--side]');
			}
			const params: Record<string, unknown> = { missionId };
			if (view) { params.view = view; }
			if (side) { params.side = true; }
			return withPretty({ help: false, json, windowId, action: 'mission.open', params });
		}

		if (mSub === 'blueprint') {
			const bpSub = args[0];
			const bpArgs = args.slice(1);
			if (bpSub === 'get') {
				let missionId: string | undefined;
				let raw = false;
				for (const ref = { i: 0 }; ref.i < bpArgs.length; ref.i++) {
					const arg = bpArgs[ref.i];
					if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=')) {
						missionId = takeOptionVal(ref, '--mission', bpArgs);
					} else if (arg === '--raw') {
						raw = true;
					} else if (!arg.startsWith('-') && !missionId) {
						missionId = arg;
					} else {
						throw new CliUsageError(`Unknown option for mission blueprint get: ${arg}`);
					}
				}
				if (!missionId) {
					throw new CliUsageError('Usage: aexus-ade mission blueprint get --mission <id> [--raw]');
				}
				return withPretty({ help: false, json, windowId, action: 'mission.blueprint.get', params: raw ? { missionId, raw: true } : { missionId } });
			}
			if (bpSub === 'apply') {
				let missionId: string | undefined;
				let file: string | undefined;
				let text: string | undefined;
				for (const ref = { i: 0 }; ref.i < bpArgs.length; ref.i++) {
					const arg = bpArgs[ref.i];
					if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=')) {
						missionId = takeOptionVal(ref, '--mission', bpArgs);
					} else if (arg === '--file' || arg.startsWith('--file=') || arg === '-f') {
						const rawFile = takeOptionVal(ref, '--file', bpArgs, true);
						file = rawFile.trim() === '-' ? '-' : resolvePathIfRelative(rawFile, cwd);
					} else if (arg === '--text' || arg.startsWith('--text=')) {
						text = takeOptionVal(ref, '--text', bpArgs, true);
					} else if (!arg.startsWith('-') && !missionId) {
						missionId = arg;
					} else {
						throw new CliUsageError(`Unknown option for mission blueprint apply: ${arg}`);
					}
				}
				if (!missionId || (!file && text === undefined)) {
					throw new CliUsageError('Usage: aexus-ade mission blueprint apply --mission <id> (--file <path|-> | --text <mermaid>)');
				}
				const params: Record<string, unknown> = { missionId };
				if (file) { params.file = file; }
				if (text !== undefined) { params.text = text; }
				return withPretty({ help: false, json, windowId, action: 'mission.blueprint.apply', params });
			}
			if (bpSub === 'validate') {
				let file: string | undefined;
				let text: string | undefined;
				for (const ref = { i: 0 }; ref.i < bpArgs.length; ref.i++) {
					const arg = bpArgs[ref.i];
					if (arg === '--file' || arg.startsWith('--file=') || arg === '-f') {
						const rawFile = takeOptionVal(ref, '--file', bpArgs, true);
						file = rawFile.trim() === '-' ? '-' : resolvePathIfRelative(rawFile, cwd);
					} else if (arg === '--text' || arg.startsWith('--text=')) {
						text = takeOptionVal(ref, '--text', bpArgs, true);
					} else if (!arg.startsWith('-') && !file) {
						file = resolvePathIfRelative(arg, cwd);
					} else {
						throw new CliUsageError(`Unknown option for mission blueprint validate: ${arg}`);
					}
				}
				if (!file && text === undefined) {
					throw new CliUsageError('Usage: aexus-ade mission blueprint validate (--file <path|-> | --text <mermaid>)');
				}
				const params: Record<string, unknown> = {};
				if (file) { params.file = file; }
				if (text !== undefined) { params.text = text; }
				return withPretty({ help: false, json, windowId, action: 'mission.blueprint.validate', params });
			}
			throw new CliUsageError('Usage: aexus-ade mission blueprint <get | apply | validate> ...');
		}

		if (mSub === 'run' || mSub === 'pause' || mSub === 'resume' || mSub === 'stop' || mSub === 'remove') {
			let missionId: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=')) {
					missionId = takeOptionVal(ref, '--mission', args);
				} else if (!arg.startsWith('-') && !missionId) {
					missionId = arg;
				} else {
					throw new CliUsageError(`Unknown option for mission ${mSub}: ${arg}`);
				}
			}
			if (!missionId && mSub === 'remove') {
				throw new CliUsageError('Usage: aexus-ade mission remove --mission <id>');
			}
			const params: Record<string, unknown> = {};
			if (missionId) { params.missionId = missionId; }
			return withPretty({ help: false, json, windowId, action: `mission.${mSub}`, params });
		}

		if (mSub === 'status') {
			let missionId: string | undefined;
			let full = false;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=')) {
					missionId = takeOptionVal(ref, '--mission', args);
				} else if (arg === '--full' || arg === '--verbose') {
					full = true;
				} else if (!arg.startsWith('-') && !missionId) {
					missionId = arg;
				} else {
					throw new CliUsageError(`Unknown option for mission status: ${arg}`);
				}
			}
			const params: Record<string, unknown> = {};
			if (missionId) { params.missionId = missionId; }
			if (full) { params.full = true; }
			return withPretty({ help: false, json, windowId, action: 'mission.status', params });
		}

		if (mSub === 'gate') {
			let missionId: string | undefined;
			let node: string | undefined;
			let tokenId: string | undefined;
			let verdict: string | undefined;
			let targetNode: string | undefined;
			let feedback: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--governor' || arg.startsWith('--governor=') || arg === '--mission' || arg.startsWith('--mission=') || arg === '--mission-id' || arg.startsWith('--mission-id=')) {
					missionId = takeOptionVal(ref, '--mission', args);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else if (arg === '--token' || arg.startsWith('--token=') || arg === '--token-id' || arg.startsWith('--token-id=')) {
					tokenId = takeOptionVal(ref, '--token', args);
				} else if (arg === '--decision' || arg.startsWith('--decision=') || arg === '--verdict' || arg.startsWith('--verdict=')) {
					verdict = takeOptionVal(ref, '--decision', args, true).toLowerCase();
					if (verdict !== 'approve' && verdict !== 'reject' && verdict !== 'pass' && verdict !== 'rollback') {
						throw new CliUsageError('Option --decision must be approve or reject (aliases: pass, rollback).');
					}
				} else if (arg === '--rollback' || arg.startsWith('--rollback=') || arg === '--target-node' || arg.startsWith('--target-node=')) {
					targetNode = takeOptionVal(ref, '--rollback', args);
				} else if (arg === '--note' || arg.startsWith('--note=') || arg === '--feedback' || arg.startsWith('--feedback=') || arg === '--reason' || arg.startsWith('--reason=')) {
					feedback = takeOptionVal(ref, '--note', args, true);
				} else if (!arg.startsWith('-') && !verdict && (arg.toLowerCase() === 'approve' || arg.toLowerCase() === 'reject' || arg.toLowerCase() === 'pass' || arg.toLowerCase() === 'rollback')) {
					verdict = arg.toLowerCase();
				} else {
					throw new CliUsageError(`Unknown option for mission gate: ${arg}`);
				}
			}
			if (!node || !verdict) {
				throw new CliUsageError('Usage: aexus-ade mission gate <approve|reject> [--mission <id>] --node <nodeId> [--token <tokenId>] [--note "<text>"] [--rollback <upstreamNodeId>]');
			}
			const decision = (verdict === 'pass' || verdict === 'approve') ? 'approve' : 'reject';
			const params: Record<string, unknown> = { node, decision };
			if (missionId) { params.missionId = missionId; }
			if (tokenId) { params.tokenId = tokenId; }
			if (targetNode) { params.rollback = targetNode; }
			if (feedback !== undefined) { params.note = feedback; }
			return withPretty({ help: false, json, windowId, action: 'mission.gate', params });
		}

		throw new CliUsageError(`Unknown mission subcommand: ${mSub}`);
	}

	if (group === 'inbox') {
		const iSub = tail[0] ?? 'list';
		const args = tail.slice(1);

		const takeOptionVal = (iRef: { i: number }, flagName: string, list: readonly string[], allowDash = false): string => {
			const cur = list[iRef.i];
			const eqIdx = cur.indexOf('=');
			if (eqIdx >= 0) {
				const val = cur.slice(eqIdx + 1);
				if (!val) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
				return val;
			}
			const next = list[++iRef.i];
			if (next === undefined) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
			if (!allowDash && next.startsWith('--')) {
				throw new CliUsageError(`Option ${flagName} requires a value, got ${next}.`);
			}
			return next;
		};

		if (iSub === 'list') {
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
			return withPretty({ help: false, json, windowId, action: 'inbox.list', params });
		}

		if (iSub === 'post') {
			let fromGov: string | undefined;
			let message: string | undefined;
			let messageFile: string | undefined;
			let title: string | undefined;
			let node: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--from' || arg.startsWith('--from=') || arg === '--governor' || arg.startsWith('--governor=')) {
					fromGov = takeOptionVal(ref, '--from', args);
				} else if (arg === '--message' || arg.startsWith('--message=')) {
					message = takeOptionVal(ref, '--message', args, true);
				} else if (arg === '--message-file' || arg.startsWith('--message-file=') || arg === '--file' || arg.startsWith('--file=')) {
					messageFile = takeOptionVal(ref, '--message-file', args, true);
				} else if (arg === '--title' || arg.startsWith('--title=')) {
					title = takeOptionVal(ref, '--title', args, true);
				} else if (arg === '--node' || arg.startsWith('--node=')) {
					node = takeOptionVal(ref, '--node', args);
				} else {
					throw new CliUsageError(`Unknown option for inbox post: ${arg}`);
				}
			}
			if (!fromGov || (!message && !messageFile)) {
				throw new CliUsageError('Usage: aexus-ade inbox post --from <governorId> (--message <text> | --message-file <path|->) [--title <title>]');
			}
			const params: Record<string, unknown> = { from: fromGov };
			if (message) { params.message = message; }
			if (messageFile) { params.messageFile = messageFile; }
			if (title) { params.title = title; }
			if (node) { params.node = node; }
			return withPretty({ help: false, json, windowId, action: 'inbox.post', params });
		}

		if (iSub === 'resolve') {
			let id: string | undefined;
			let resolution: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--id' || arg.startsWith('--id=')) {
					id = takeOptionVal(ref, '--id', args);
				} else if (arg === '--resolution' || arg.startsWith('--resolution=') || arg === '--note' || arg.startsWith('--note=')) {
					resolution = takeOptionVal(ref, '--resolution', args, true);
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
			return withPretty({ help: false, json, windowId, action: 'inbox.resolve', params });
		}

		if (iSub === 'mark-read' || iSub === 'markRead') {
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
			if (!id && !all) {
				throw new CliUsageError('Usage: aexus-ade inbox mark-read (<id> | --all)');
			}
			return withPretty({ help: false, json, windowId, action: 'inbox.markRead', params: all ? { all: true } : { id } });
		}

		throw new CliUsageError(`Unknown inbox subcommand: ${iSub}`);
	}

	if (group === 'host' || group === 'cloud-host') {
		const hSub = tail[0] ?? 'list';
		const args = tail.slice(1);
		const takeVal = (iRef: { i: number }, flagName: string, allowDash = false): string => {
			const cur = args[iRef.i];
			const eqIdx = cur.indexOf('=');
			if (eqIdx >= 0) {
				const val = cur.slice(eqIdx + 1);
				if (!val) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
				return val;
			}
			const next = args[++iRef.i];
			if (next === undefined) { throw new CliUsageError(`Option ${flagName} requires a value.`); }
			if (!allowDash && next.startsWith('--')) {
				throw new CliUsageError(`Option ${flagName} requires a value, got ${next}.`);
			}
			return next;
		};

		if (hSub === 'list') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for host list: ${args.join(' ')}`); }
			return withPretty({ help: false, json, windowId, action: 'host.list', params: {} });
		}
		if (hSub === 'info' || hSub === 'get') {
			if (args.length !== 1 || args[0].startsWith('-')) { throw new CliUsageError('Usage: aexus-ade host info <alias|id>'); }
			return withPretty({ help: false, json, windowId, action: 'host.get', params: { target: args[0] } });
		}
		if (hSub === 'remove' || hSub === 'delete' || hSub === 'rm') {
			if (args.length !== 1 || args[0].startsWith('-')) { throw new CliUsageError('Usage: aexus-ade host remove <alias|id>'); }
			return withPretty({ help: false, json, windowId, action: 'host.delete', params: { target: args[0] } });
		}
		if (hSub === 'test' || hSub === 'ping') {
			if (args.length !== 1 || args[0].startsWith('-')) { throw new CliUsageError('Usage: aexus-ade host test <alias|id>'); }
			return withPretty({ help: false, json, windowId, action: 'host.test', params: { target: args[0] } });
		}
		if (hSub === 'import-vscode' || hSub === 'import' || hSub === 'sync') {
			if (args.length > 0) { throw new CliUsageError('Usage: aexus-ade host import-vscode'); }
			return withPretty({ help: false, json, windowId, action: 'host.import', params: {} });
		}
		if (hSub === 'open') {
			if (args.length > 1) { throw new CliUsageError('Usage: aexus-ade host open [alias|id]'); }
			return withPretty({ help: false, json, windowId, action: 'host.open', params: args[0] ? { target: args[0] } : {} });
		}
		if (hSub === 'browse' || hSub === 'ls') {
			let target: string | undefined;
			let remotePath: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--path' || arg.startsWith('--path=')) {
					remotePath = takeVal(ref, '--path');
				} else if (!arg.startsWith('-') && !target) {
					target = arg;
				} else {
					throw new CliUsageError(`Unknown option for host browse: ${arg}`);
				}
			}
			if (!target) { throw new CliUsageError('Usage: aexus-ade host browse <alias|id> [--path <remotePath>]'); }
			return withPretty({ help: false, json, windowId, action: 'host.browse', params: remotePath ? { target, path: remotePath } : { target } });
		}
		if (hSub === 'add' || hSub === 'upsert' || hSub === 'update' || hSub === 'edit') {
			const params: Record<string, unknown> = {};
			let targetPositional: string | undefined;
			for (const ref = { i: 0 }; ref.i < args.length; ref.i++) {
				const arg = args[ref.i];
				if (arg === '--id' || arg.startsWith('--id=')) {
					params.id = takeVal(ref, '--id');
				} else if (arg === '--host' || arg === '--hostname' || arg.startsWith('--host=') || arg.startsWith('--hostname=')) {
					params.hostName = takeVal(ref, '--host');
				} else if (arg === '--name' || arg.startsWith('--name=')) {
					params.name = takeVal(ref, '--name', true);
				} else if (arg === '--alias' || arg.startsWith('--alias=')) {
					params.alias = takeVal(ref, '--alias', true);
				} else if (arg === '--user' || arg.startsWith('--user=')) {
					params.user = takeVal(ref, '--user');
				} else if (arg === '--port' || arg.startsWith('--port=')) {
					const val = takeVal(ref, '--port');
					if (!/^\d+$/.test(val) || Number(val) < 1 || Number(val) > 65535) {
						throw new CliUsageError('Option --port requires an integer between 1 and 65535.');
					}
					params.port = Number(val);
				} else if (arg === '--os' || arg.startsWith('--os=')) {
					const val = takeVal(ref, '--os').toLowerCase();
					if (val !== 'linux' && val !== 'macos' && val !== 'windows') {
						throw new CliUsageError('Option --os must be linux, macos, or windows.');
					}
					params.os = val;
				} else if (arg === '--identity' || arg === '--identity-file' || arg.startsWith('--identity=') || arg.startsWith('--identity-file=')) {
					params.identityFile = takeVal(ref, '--identity');
				} else if (arg === '--jump' || arg === '--proxy-jump' || arg.startsWith('--jump=') || arg.startsWith('--proxy-jump=')) {
					params.proxyJump = takeVal(ref, '--jump');
				} else if (arg === '--default-dir' || arg.startsWith('--default-dir=')) {
					params.defaultDirectory = takeVal(ref, '--default-dir');
				} else if (arg === '--notes' || arg.startsWith('--notes=')) {
					params.notes = takeVal(ref, '--notes', true);
				} else if (!arg.startsWith('-') && !targetPositional) {
					targetPositional = arg;
				} else {
					throw new CliUsageError(`Unknown option for host ${hSub}: ${arg}`);
				}
			}
			if ((hSub === 'update' || hSub === 'edit') && targetPositional && !params.id && !params.alias) {
				params.alias = targetPositional.trim();
			} else if ((hSub === 'add' || hSub === 'upsert') && targetPositional) {
				if (params.hostName) {
					if (!params.alias) {
						params.alias = targetPositional.trim();
					}
				} else {
					let spec = targetPositional.trim();
					if (spec.includes('@')) {
						const idx = spec.lastIndexOf('@');
						if (!params.user) { params.user = spec.slice(0, idx); }
						spec = spec.slice(idx + 1);
					}
					const pm = /^([^:]+):(\d+)$/.exec(spec);
					if (pm) {
						params.hostName = pm[1];
						if (!params.port) { params.port = Number(pm[2]); }
					} else {
						params.hostName = spec;
					}
				}
			}
			if (!params.hostName && (hSub === 'add' || hSub === 'upsert')) {
				throw new CliUsageError('Usage: aexus-ade host add ([alias] --host <addr> | <user@host[:port]>) [--name <label>] [--alias <alias>] [--os <linux|macos|windows>]');
			}
			return withPretty({ help: false, json, windowId, action: 'host.upsert', params });
		}

		throw new CliUsageError(`Unknown host subcommand: ${hSub}`);
	}

	if (group === 'org') {
		const orgRuntimeCmd = parseOrgCommandIfRuntime(tail, json, windowId, msg => new CliUsageError(msg));
		if (orgRuntimeCmd) {
			return withPretty(orgRuntimeCmd);
		}
	}

	if (group === 'role' || group === 'roles' || group === 'org') {
		const rSub = tail[0] ?? 'list';
		const args = tail.slice(1);
		if (rSub === 'list' || rSub === 'schema' || rSub === 'get') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for role ${rSub}: ${args.join(' ')}`); }
			return withPretty({ help: false, json, windowId, action: 'role.schema.get', params: {} });
		}
		if (rSub === 'apis' || rSub === 'primitives') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for role ${rSub}: ${args.join(' ')}`); }
			return withPretty({ help: false, json, windowId, action: 'role.apis', params: {} });
		}
		if (rSub === 'presets') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for role presets: ${args.join(' ')}`); }
			return withPretty({ help: false, json, windowId, action: 'role.presets', params: {} });
		}
		if (rSub === 'preset' || rSub === 'apply-preset') {
			const presetId = args[0]?.trim();
			if (!presetId || presetId.startsWith('-') || args.length > 1) {
				throw new CliUsageError('Usage: aexus-ade role apply-preset <presetId>');
			}
			return withPretty({ help: false, json, windowId, action: 'role.schema.set', params: { presetId } });
		}
		if (rSub === 'set-tier') {
			if (args.length !== 2) {
				throw new CliUsageError('Usage: aexus-ade role set-tier <sessionId> <rankId|worker|none>');
			}
			const [id, rawRoleArg] = args;
			const roleArg = rawRoleArg.trim().toLowerCase();
			if (roleArg !== 'none' && !isValidRoleSlug(roleArg)) {
				throw new CliUsageError('Role must be a valid rank ID (e.g. governor, manager, employee, worker, custom rank ID, or none).');
			}
			return withPretty({ help: false, json, windowId, action: 'session.setRole', params: { id, role: roleArg === 'none' || roleArg === 'worker' ? null : roleArg } });
		}
		if (rSub === 'reset') {
			if (args.length > 0) { throw new CliUsageError(`Unexpected arguments for role reset: ${args.join(' ')}`); }
			return withPretty({ help: false, json, windowId, action: 'role.schema.reset', params: {} });
		}
		if (rSub === 'studio' || rSub === 'open') {
			if (args.length > 1 || (args[0] && args[0].startsWith('-'))) {
				throw new CliUsageError('Usage: aexus-ade role studio [rankId]');
			}
			const rankId = args[0]?.trim();
			return withPretty({ help: false, json, windowId, action: 'role.studio.open', params: rankId ? { rankId } : {} });
		}
		throw new CliUsageError(`Unknown role subcommand: ${rSub}`);
	}

	throw new CliUsageError(`Unknown command: ${group}`);
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

	const effectiveJsonTTY = io.stdoutIsTTY !== undefined
		? io.stdoutIsTTY
		: (io.stdout ? false : Boolean(process.stdout.isTTY));
	const prettyJson = Boolean(parsed.pretty || effectiveJsonTTY);
	const formatJsonLine = (value: unknown): string =>
		`${prettyJson ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;

	if (parsed.version) {
		if (parsed.json) {
			writeOut(formatJsonLine({ schemaVersion: ADE_CLI_SCHEMA_VERSION, cli: 'aexus-ade', version: ADE_CLI_VERSION, engineBaseline: ADE_ENGINE_BASELINE }));
		} else {
			writeOut(`aexus-ade ${ADE_CLI_VERSION} (Aexus Code / Code - OSS ${ADE_ENGINE_BASELINE})\n`);
		}
		return 0;
	}

	if (parsed.help) {
		writeOut(HELP_TEXT);
		return 0;
	}

	if (parsed.completion) {
		writeOut(buildCompletionScript(parsed.completion));
		return 0;
	}

	if (parsed.action === 'doctor') {
		const projectPath = typeof parsed.params?.projectPath === 'string' ? parsed.params.projectPath : cwd;
		const strict = parsed.params?.strict === true;
		const report = await runDoctorDiagnostics(projectPath, env);
		if (parsed.json) {
			writeOut(formatJsonLine(report));
		} else {
			const isTTY = io.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
			writeOut(formatDoctorHuman(report, createColorizer(shouldUseColor(env, isTTY))) + '\n');
		}
		return computeDoctorExitCode(report, strict);
	}

	try {
		let stdinConsumedBy: string | undefined;
		const readTextInputOnce = async (fileOrDash: string, label: string): Promise<string> => {
			if (fileOrDash.trim() === '-') {
				if (stdinConsumedBy) {
					throw new CliUsageError(`Standard input ("-") cannot be consumed by multiple options (${stdinConsumedBy} and ${label}) in one command.`);
				}
				if (io.stdin === undefined && Boolean(process.stdin.isTTY)) {
					throw new CliUsageError(`Standard input ("-") was requested for ${label}, but stdin is an interactive TTY. Pipe input (e.g. <<'EOF') or pass a file path.`);
				}
				stdinConsumedBy = label;
				if (io.stdin !== undefined) {
					return io.stdin;
				}
				const chunks: Buffer[] = [];
				for await (const chunk of process.stdin) {
					chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
				}
				return Buffer.concat(chunks).toString('utf8');
			}
			return fs.readFile(path.resolve(cwd, fileOrDash), 'utf8');
		};

		const normalizedParams = await canonicalizeParamsPaths(parsed.params, parsed.action);
		let exportOutputFile: string | undefined;
		if (
			(parsed.action === 'orchestration.export' || parsed.action === 'mission.export')
			&& normalizedParams && typeof normalizedParams.outputFile === 'string' && normalizedParams.outputFile.trim()
		) {
			exportOutputFile = path.resolve(cwd, normalizedParams.outputFile.trim());
			delete normalizedParams.outputFile;
		}
		if (normalizedParams) {
			if (typeof normalizedParams.detailFile === 'string' && normalizedParams.detail === undefined) {
				normalizedParams.detail = await readTextInputOnce(normalizedParams.detailFile, '--detail-file');
				delete normalizedParams.detailFile;
			} else if (normalizedParams.detail === '-') {
				normalizedParams.detail = await readTextInputOnce('-', '--detail');
			}
			if (
				(parsed.action === 'token.mint' || parsed.action === 'token.split')
				&& typeof normalizedParams.branchesFile === 'string' && normalizedParams.branchesJson === undefined
			) {
				normalizedParams.branchesJson = await readTextInputOnce(normalizedParams.branchesFile, '--branches-file');
				delete normalizedParams.branchesFile;
			} else if (
				(parsed.action === 'token.mint' || parsed.action === 'token.split')
				&& normalizedParams.branchesJson === '-'
			) {
				normalizedParams.branchesJson = await readTextInputOnce('-', '--branches-json');
			}
			if (typeof normalizedParams.promptFile === 'string' && normalizedParams.prompt === undefined) {
				normalizedParams.prompt = await readTextInputOnce(normalizedParams.promptFile, '--prompt-file');
				delete normalizedParams.promptFile;
			} else if (
				(parsed.action === 'session.send' || parsed.action === 'secretary.send' || parsed.action === 'orchestration.dispatch')
				&& normalizedParams.prompt === '-'
			) {
				normalizedParams.prompt = await readTextInputOnce('-', '--prompt');
			}
			if (typeof normalizedParams.messageFile === 'string' && normalizedParams.message === undefined) {
				normalizedParams.message = await readTextInputOnce(normalizedParams.messageFile, '--message-file');
				delete normalizedParams.messageFile;
			} else if (
				(parsed.action === 'org.send' || parsed.action === 'inbox.post')
				&& normalizedParams.message === '-'
			) {
				normalizedParams.message = await readTextInputOnce('-', '--message');
			}
			if (
				(parsed.action === 'orchestration.validate' || parsed.action === 'orchestration.load')
				&& typeof normalizedParams.file === 'string' && normalizedParams.manifest === undefined && normalizedParams.text === undefined
			) {
				if (normalizedParams.file.trim() === '-') {
					const rawText = await readTextInputOnce('-', '--file');
					delete normalizedParams.file;
					if (rawText.trimStart().startsWith('{')) {
						normalizedParams.manifest = JSON.parse(rawText);
					} else {
						normalizedParams.text = rawText;
						if (parsed.action === 'orchestration.load') {
							parsed = { ...parsed, action: 'orchestration.apply' };
						}
					}
				} else {
					const resolvedFile = path.resolve(cwd, normalizedParams.file);
					const ext = path.extname(resolvedFile).toLowerCase();
					if (ext === '.json') {
						normalizedParams.manifest = JSON.parse(await fs.readFile(resolvedFile, 'utf8'));
					} else if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
						// eslint-disable-next-line no-restricted-syntax -- dynamic user manifest (.mjs/.js/.cjs) loader
						const mod = await import(pathToFileURL(resolvedFile).href) as { default?: unknown; manifest?: unknown };
						const candidate = mod.default ?? mod.manifest ?? mod;
						normalizedParams.manifest = typeof candidate === 'function' ? await (candidate as () => unknown)() : candidate;
					} else {
						const rawText = await fs.readFile(resolvedFile, 'utf8');
						if (rawText.trimStart().startsWith('{')) {
							normalizedParams.manifest = JSON.parse(rawText);
						} else {
							normalizedParams.text = rawText;
							if (parsed.action === 'orchestration.load') {
								parsed = { ...parsed, action: 'orchestration.apply' };
							}
						}
					}
				}
			}
			if (
				(parsed.action === 'mission.blueprint.apply' || parsed.action === 'mission.blueprint.validate' || parsed.action === 'orchestration.apply' || parsed.action === 'orchestration.import' || parsed.action === 'mission.import')
			) {
				if (typeof normalizedParams.file === 'string' && normalizedParams.text === undefined) {
					normalizedParams.text = await readTextInputOnce(normalizedParams.file, '--file');
					if (normalizedParams.file.trim() === '-') {
						delete normalizedParams.file;
					}
				} else if (normalizedParams.text === '-') {
					normalizedParams.text = await readTextInputOnce('-', '--text');
				}
			}
			if (parsed.action === 'mission.patch') {
				if (typeof normalizedParams.file === 'string' && normalizedParams.mermaid === undefined) {
					normalizedParams.mermaid = await readTextInputOnce(normalizedParams.file, '--file');
					if (normalizedParams.file.trim() === '-') {
						delete normalizedParams.file;
					}
				} else if (normalizedParams.mermaid === '-') {
					normalizedParams.mermaid = await readTextInputOnce('-', '--mermaid');
				}
			}
			if (
				parsed.action === 'mission.prompt.set'
				&& normalizedParams.clear !== true
			) {
				if (typeof normalizedParams.file === 'string' && normalizedParams.prompt === undefined) {
					normalizedParams.prompt = await readTextInputOnce(normalizedParams.file, '--file');
					if (normalizedParams.file.trim() === '-') {
						delete normalizedParams.file;
					}
				} else if (normalizedParams.prompt === '-') {
					normalizedParams.prompt = await readTextInputOnce('-', '--prompt');
				}
			}
			if (parsed.action === 'mission.task.create' || parsed.action === 'mission.task.set' || parsed.action === 'mission.task.update') {
				if (typeof normalizedParams.file === 'string' && normalizedParams.description === undefined) {
					normalizedParams.description = await readTextInputOnce(normalizedParams.file, '--file');
					if (normalizedParams.file.trim() === '-') {
						delete normalizedParams.file;
					}
				} else if (normalizedParams.description === '-') {
					normalizedParams.description = await readTextInputOnce('-', '--description');
				}
			}
			if (parsed.action === 'whiteboard.create' || parsed.action === 'whiteboard.write') {
				if (typeof normalizedParams.appendFile === 'string' && normalizedParams.appendContent === undefined) {
					normalizedParams.appendContent = await readTextInputOnce(normalizedParams.appendFile, '--append-file');
					delete normalizedParams.appendFile;
				} else if (normalizedParams.appendContent === '-') {
					normalizedParams.appendContent = await readTextInputOnce('-', '--append');
				}
				if (typeof normalizedParams.file === 'string' && normalizedParams.content === undefined && normalizedParams.appendContent === undefined) {
					normalizedParams.content = await readTextInputOnce(normalizedParams.file, '--file');
					delete normalizedParams.file;
				} else if (normalizedParams.content === '-') {
					normalizedParams.content = await readTextInputOnce('-', '--content');
				}
			}
		}

		const { socketPath, token, usingSessionToken } = await resolveConnection(env);
		let effectiveParams: Record<string, unknown> | undefined = normalizedParams;
		if (usingSessionToken) {
			if (effectiveParams) {
				const sanitized: Record<string, unknown> = { ...effectiveParams };
				delete sanitized.caller;
				delete sanitized._verifiedCaller;
				delete sanitized._callerSessionId;
				effectiveParams = sanitized;
			}
		} else {
			const caller = env.AEXUS_ADE_CALLER?.trim();
			if (effectiveParams && (Object.prototype.hasOwnProperty.call(effectiveParams, '_verifiedCaller') || Object.prototype.hasOwnProperty.call(effectiveParams, '_callerSessionId'))) {
				const sanitized: Record<string, unknown> = { ...effectiveParams };
				delete sanitized._verifiedCaller;
				delete sanitized._callerSessionId;
				effectiveParams = sanitized;
			}
			if (caller) {
				effectiveParams = { ...(effectiveParams ?? {}), caller };
			}
		}
		const envWindowIdRaw = env.AEXUS_ADE_WINDOW_ID?.trim();
		const envWindowId = envWindowIdRaw && /^\d+$/.test(envWindowIdRaw) && Number(envWindowIdRaw) > 0
			? Number(envWindowIdRaw)
			: undefined;
		const effectiveWindowId = parsed.windowId ?? envWindowId;
		const envIdempotencyRaw = env.AEXUS_ADE_IDEMPOTENCY_KEY?.trim();
		const explicitIdempotencyKey = parsed.idempotencyKey
			?? (envIdempotencyRaw ? validateIdempotencyKey(envIdempotencyRaw, 'AEXUS_ADE_IDEMPOTENCY_KEY') : undefined);
		const primaryIdempotencyKey = explicitIdempotencyKey
			?? (!isIdempotentReadRequest(parsed.action, effectiveParams) ? crypto.randomUUID() : undefined);
		const makeRequest = (action: string, isFallback = false): IAdeControlWireRequest => {
			let reqKey = primaryIdempotencyKey;
			if (isFallback && reqKey) {
				reqKey = reqKey.length <= 125 ? `${reqKey}:fb` : `${reqKey.slice(0, 125)}:fb`;
			}
			return {
				token,
				action,
				params: effectiveParams,
				...(effectiveWindowId !== undefined ? { windowId: effectiveWindowId } : {}),
				...(reqKey !== undefined ? { idempotencyKey: reqKey } : {}),
			};
		};
		const allowBridgeRetry = Boolean(usingSessionToken && (env.AEXUS_ADE_REMOTE_BRIDGE_FILE?.trim() || env.AEXUS_ADE_TCP_PORT?.trim() || env.AEXUS_ADE_SOCKET?.trim()));
		let response = await sendControlRequestWithRetry(env, socketPath, makeRequest(parsed.action!, false), allowBridgeRetry);
		if (!response.ok && parsed.fallbackAction && /unknown|unsupported/i.test(response.error ?? '')) {
			response = await sendControlRequestWithRetry(env, socketPath, makeRequest(parsed.fallbackAction, true), allowBridgeRetry);
		}
		if (!response.ok) {
			if (parsed.json) {
				writeOut(formatJsonLine(response));
			} else {
				writeErr(`Error: ${response.error || 'ADE control command failed.'}\n`);
			}
			return 1;
		}
		const outputPayload = parsed.action === 'status' && response.result && typeof response.result === 'object' && !Array.isArray(response.result)
			? { schemaVersion: ADE_CLI_SCHEMA_VERSION, ...(response.result as Record<string, unknown>) }
			: response.result;
		if (exportOutputFile) {
			await fs.mkdir(path.dirname(exportOutputFile), { recursive: true });
			const payloadObj = outputPayload && typeof outputPayload === 'object' && !Array.isArray(outputPayload)
				? outputPayload as Record<string, unknown>
				: undefined;
			const isMarkdownMissionExport = parsed.action === 'mission.export'
				&& (
					parsed.params?.format === 'markdown'
					|| parsed.params?.format === 'md'
					|| payloadObj?.format === 'markdown'
				);
			const fileContent = parsed.action === 'orchestration.export'
				? (typeof outputPayload === 'string'
					? outputPayload
					: (payloadObj?.manifest
						? (JSON.stringify(payloadObj.manifest, null, 2) + '\n')
						: String(payloadObj?.orchestrationText ?? '')))
				: isMarkdownMissionExport
					? (typeof outputPayload === 'string'
						? outputPayload
						: String(payloadObj?.content ?? payloadObj?.markdown ?? payloadObj?.text ?? ''))
					: (JSON.stringify(outputPayload ?? {}, null, 2) + '\n');
			await fs.writeFile(exportOutputFile, fileContent.endsWith('\n') ? fileContent : `${fileContent}\n`, 'utf8');
			const summary = {
				ok: true,
				action: parsed.action,
				file: exportOutputFile,
				bytes: Buffer.byteLength(fileContent, 'utf8'),
				...(outputPayload && typeof outputPayload === 'object' && !Array.isArray(outputPayload)
					? {
						missionId: (outputPayload as Record<string, unknown>).missionId,
						title: (outputPayload as Record<string, unknown>).title,
					}
					: {}),
			};
			if (parsed.json) {
				writeOut(formatJsonLine(summary));
			} else {
				writeOut(`Exported to ${exportOutputFile} (${summary.bytes} bytes)\n`);
			}
			return 0;
		}
		if (parsed.json) {
			writeOut(formatJsonLine(outputPayload ?? { ok: true }));
		} else if (parsed.action === 'docs.read' && outputPayload && typeof outputPayload === 'object' && typeof (outputPayload as Record<string, unknown>).content === 'string') {
			const content = (outputPayload as Record<string, unknown>).content as string;
			writeOut(content.endsWith('\n') ? content : `${content}\n`);
		} else if (
			(parsed.action === 'mission.blueprint.get' || parsed.action === 'orchestration.get' || parsed.action === 'orchestration.export')
			&& parsed.params?.raw === true
		) {
			writeOut(formatRawBlueprintOutput(outputPayload));
		} else {
			writeOut(formatHumanOutput(parsed.action, outputPayload) + '\n');
		}
		return 0;
	} catch (error) {
		if (parsed.json && !(error instanceof CliUsageError)) {
			writeOut(formatJsonLine({ ok: false, error: (error as Error).message }));
		} else if (parsed.json && error instanceof CliUsageError) {
			writeOut(formatJsonLine({ ok: false, error: error.message }));
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
