/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';

/**
 * Pure, framework-free engine adapter & process-group containment helpers shared by
 * `runtime.ts`, `claude.ts`, and `codex.ts` so PGID termination, effort mappings, fallback cascades,
 * and safe 45-command `ade_*` CLI shell detection are deterministically unit-testable.
 */

const innerEngineProcessPids = new WeakMap<cp.ChildProcess, number>();

export function registerSpawnedEngineChildForTracking(child: cp.ChildProcess): void {
	child.on('message', (msg: unknown) => {
		if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'spawned') {
			const pid = (msg as { pid?: unknown }).pid;
			if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
				innerEngineProcessPids.set(child, pid);
			}
		}
	});
}

function killPosixGroupBestEffort(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
			return;
		}
	}
	try {
		process.kill(pid, signal);
	} catch { /* already exited */ }
}

/**
 * Terminates an `engineProcess.js` supervisor.
 * When `options.killTree === false` (used on `interruptTurn` / `steer` / UI Stop), signals ONLY the
 * immediate engine CLI PID without obliterating detached background training/compilation subtrees.
 * When `options.killTree !== false` (used on `disposeAgentRuntime` / session delete), terminates the entire PGID.
 */
export function stopSpawnedEngineProcess(
	child: cp.ChildProcess,
	signal: NodeJS.Signals = 'SIGTERM',
	options?: { readonly killTree?: boolean },
): void {
	const killTree = options?.killTree !== false;
	try {
		if (process.platform !== 'win32') {
			const innerPid = innerEngineProcessPids.get(child);
			if (!killTree) {
				if (child.connected) {
					try {
						child.send({ type: 'terminate', signal, killTree: false });
						if (innerPid) {
							try { process.kill(innerPid, signal); } catch { /* already exited */ }
						}
						return;
					} catch { /* fall through to direct PID signal */ }
				}
				if (innerPid) {
					try { process.kill(innerPid, signal); } catch { /* already exited */ }
					return;
				}
				if (child.pid) {
					try { process.kill(child.pid, signal); } catch { /* already exited */ }
				}
				return;
			}
			if (innerPid) {
				killPosixGroupBestEffort(innerPid, signal);
			}
			if (signal === 'SIGKILL') {
				if (child.connected) {
					try { child.send({ type: 'terminate', signal: 'SIGKILL', killTree: true }); } catch { /* ignore */ }
				}
				if (innerPid || !child.connected) {
					if (child.pid) {
						killPosixGroupBestEffort(child.pid, 'SIGKILL');
					}
				} else if (child.pid) {
					const wrapperPid = child.pid;
					const reapTimer = setTimeout(() => {
						const lateInnerPid = innerEngineProcessPids.get(child);
						if (lateInnerPid) {
							killPosixGroupBestEffort(lateInnerPid, 'SIGKILL');
						}
						killPosixGroupBestEffort(wrapperPid, 'SIGKILL');
					}, 80);
					reapTimer.unref?.();
				}
				return;
			}
			if (child.connected) {
				try {
					child.send({ type: 'terminate', signal, killTree: true });
					return;
				} catch { /* fall through to PGID signal */ }
			}
			if (child.pid) {
				killPosixGroupBestEffort(child.pid, signal);
				return;
			}
		}
		if (process.platform === 'win32') {
			if (!killTree && child.pid) {
				if (child.connected) {
					try {
						child.send({ type: 'terminate', signal, killTree: false });
						return;
					} catch { /* fall through */ }
				}
				try { child.kill(signal); } catch { /* ignore */ }
				return;
			}
			if (child.connected && signal !== 'SIGKILL') {
				try {
					child.send({ type: 'terminate', signal, killTree: true });
					return;
				} catch { /* fall through to taskkill */ }
			}
			if (child.pid) {
				const taskkill = cp.spawn(
					path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
					['/PID', String(child.pid), '/T', '/F'],
					{ windowsHide: true, stdio: 'ignore' },
				);
				taskkill.unref?.();
				taskkill.on('error', () => {
					try { child.kill(signal); } catch { /* ignore */ }
				});
				return;
			}
		}
		if (child.connected) {
			child.disconnect();
		} else {
			child.kill(signal);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
			throw error;
		}
	}
}

export function truncateToolPreview(raw: string, maxChars = 240): string {
	const compact = raw.replace(/\s+/g, ' ').trim();
	return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}… [truncated]`;
}

/**
 * Redacts API keys, Bearer tokens, ADE session tokens, and inline credentials from engine error strings
 * before surfacing diagnostics to chat streams or session logs.
 */
export function sanitizeSensitiveErrorText(raw: string): string {
	if (!raw) {
		return '';
	}
	return raw
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
		.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
		.replace(/\bades1\.[A-Za-z0-9._-]{6,}\b/g, '[REDACTED]')
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED]')
		.replace(/("(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
		.replace(/\b((?:api[_-]?key|access[_-]?token|authorization|secret|token)\s*[=:]\s*)(['"]?)([^\s"',;}{]{8,})\2/gi, '$1$2[REDACTED]$2');
}

export function isOversizedClaudeUserEchoLine(line: string, minChars = 65_536): boolean {
	if (line.length < minChars) {
		return false;
	}
	return /^\s*\{\s*"type"\s*:\s*"user"/.test(line.slice(0, 128));
}

export function mapClaudeThinkingTokens(thinking?: string): string | undefined {
	switch (thinking?.trim().toLowerCase()) {
		case 'off':
		case 'none':
			return '0';
		case 'low':
		case 'minimal':
			return '4096';
		case 'medium':
			return '10000';
		case 'high':
			return '31999';
		case 'xhigh':
		case 'extra-high':
			return '48000';
		case 'max':
			return '64000';
		default:
			return undefined;
	}
}

export function mapClaudeEffortArg(thinking?: string): string | undefined {
	switch (thinking?.trim().toLowerCase()) {
		case 'minimal':
		case 'low':
			return 'low';
		case 'medium':
			return 'medium';
		case 'high':
		case 'xhigh':
		case 'extra-high':
			return 'high';
		case 'max':
			return 'max';
		default:
			return undefined;
	}
}

export function isClaudeEffortRejectedError(message: string): boolean {
	return /(?:unknown|invalid|unsupported|unrecognized)[ _-]*(?:option|argument|flag|value)?[^\n]*(?:--effort|\beffort\b)|--effort[^\n]*(?:not supported|invalid|unknown)/i.test(message);
}

export function mapCodexReasoningEffort(thinking?: string): string | undefined {
	switch (thinking?.trim().toLowerCase()) {
		case 'minimal':
			return 'minimal';
		case 'low':
			return 'low';
		case 'medium':
			return 'medium';
		case 'high':
			return 'high';
		case 'xhigh':
		case 'extra-high':
			return 'xhigh';
		case 'max':
			return 'max';
		case 'ultra':
			return 'ultra';
		case 'off':
		case 'none':
			return 'minimal';
		default:
			return undefined;
	}
}

export interface CodexTurnAttemptSpec {
	readonly model?: string;
	readonly effort?: string;
	readonly pinDefaultModel?: boolean;
}

function lowerCodexEffortLadder(mappedEffort: string | undefined): string[] {
	switch (mappedEffort) {
		case 'ultra':
			return ['max', 'xhigh', 'high'];
		case 'max':
			return ['xhigh', 'high'];
		case 'xhigh':
			return ['high'];
		default:
			return [];
	}
}

export function planCodexTurnFallbacks(
	requestedModel: string | undefined,
	mappedEffort: string | undefined,
	defaultModel: string | undefined,
	errorMessage: string,
): CodexTurnAttemptSpec[] {
	const modelExplicitlyMissing = /model_not_found|unknown[ _-]*model|model.*does not exist/i.test(errorMessage);
	const nonFallbackAuthOrRuntimeError = /\b(?:api[_ -]?key|auth(?:entication|orization)?|credential|token|rate[_ -]?limit|quota|billing|network|socket|timeout|timed out|permission|sandbox|cwd|directory|thread[ _-]*not[ _-]*found)\b/i.test(errorMessage);
	const effortRelated = /\beffort\b|reasoning[ _-]*effort/i.test(errorMessage)
		|| (!nonFallbackAuthOrRuntimeError && /not supported|invalid|unsupported|unknown[ _-]*(?:parameter|field|option|value)/i.test(errorMessage));
	if (!modelExplicitlyMissing && !effortRelated) {
		return [];
	}

	const attempts: CodexTurnAttemptSpec[] = [];
	const pushUnique = (spec: CodexTurnAttemptSpec) => {
		if (spec.model === requestedModel && spec.effort === mappedEffort) {
			return;
		}
		if (!attempts.some(a => a.model === spec.model && a.effort === spec.effort)) {
			attempts.push(spec);
		}
	};

	const ladder = lowerCodexEffortLadder(mappedEffort);
	const fallbackSafeEffort = ladder.length > 0 ? 'high' : mappedEffort;

	if (!modelExplicitlyMissing && requestedModel && mappedEffort) {
		for (const nextEffort of ladder) {
			pushUnique({ model: requestedModel, effort: nextEffort });
		}
		pushUnique({ model: requestedModel, effort: undefined });
	}
	if (mappedEffort && !requestedModel) {
		for (const nextEffort of ladder) {
			pushUnique({ model: undefined, effort: nextEffort });
		}
		pushUnique({ model: undefined, effort: undefined });
	}
	if (defaultModel && defaultModel !== requestedModel) {
		if (mappedEffort && !modelExplicitlyMissing) {
			pushUnique({ model: defaultModel, effort: fallbackSafeEffort, pinDefaultModel: true });
		}
		pushUnique({ model: defaultModel, effort: undefined, pinDefaultModel: true });
	} else if (requestedModel && modelExplicitlyMissing) {
		pushUnique({ model: undefined, effort: fallbackSafeEffort });
		pushUnique({ model: undefined, effort: undefined });
	}

	return attempts;
}

export const ADE_SAFE_CLI_COMMANDS = new Set<string>([
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

const SAFE_ENV_ASSIGN_PREFIX_RE = /^(?:(?:NO_COLOR|FORCE_COLOR|TERM|LANG|LC_ALL)=(?:"[^"`$\\]*"|'[^']*'|[A-Za-z0-9._:-]+)\s+)*/;

function stripSafeHeredocBody(command: string): string | undefined {
	const firstNl = command.indexOf('\n');
	const headerLine = firstNl >= 0 ? command.slice(0, firstNl).replace(/\r$/, '') : command;

	let inSingle = false;
	let inDouble = false;
	let heredocStart = -1;
	for (let i = 0; i < headerLine.length; i++) {
		const ch = headerLine[i];
		if (ch === '\\' && !inSingle) {
			i++;
			continue;
		}
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && ch === '<' && headerLine[i + 1] === '<') {
			if (headerLine[i + 2] === '<') {
				return undefined;
			}
			heredocStart = i;
			break;
		}
	}

	if (heredocStart < 0) {
		return command;
	}

	const afterOperator = headerLine.slice(heredocStart);
	const quotedMatch = /^<<-?\s*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|\\([A-Za-z0-9_]+))(.*)$/.exec(afterOperator);
	if (!quotedMatch) {
		return undefined;
	}
	const delimiter = quotedMatch[1] ?? quotedMatch[2] ?? quotedMatch[3];
	const restOfHeader = quotedMatch[4] ?? '';
	if (restOfHeader.includes('<<') || firstNl < 0) {
		return undefined;
	}

	const bodyLines = command.slice(firstNl + 1).split(/\r?\n/);
	const closingIdx = bodyLines.findIndex(l => l.trim() === delimiter);
	if (closingIdx < 0) {
		return undefined;
	}
	const trailingLines = bodyLines.slice(closingIdx + 1).join('\n').trim();
	if (trailingLines.length > 0) {
		return undefined;
	}
	return `${headerLine.slice(0, heredocStart)}${restOfHeader}`;
}

function hasUnsafeShellSyntaxOutsideQuotes(header: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < header.length; i++) {
		const ch = header[i];
		if (ch === '\n' || ch === '\r' || ch === '\0') {
			return true;
		}
		if (ch === '\\' && !inSingle) {
			if (i + 1 >= header.length || header[i + 1] === '\n' || header[i + 1] === '\r') {
				return true;
			}
			i++;
			continue;
		}
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle) {
			// Block backticks and ALL unquoted/double-quoted `$` expansions (`$()`, `${}`, `$VAR`, `$'...'`, `$"..."`)
			if (ch === '`' || ch === '$') {
				return true;
			}
		}
		if (!inSingle && !inDouble) {
			// Strictly block `;`, `&&`, `||`, `&`, subshells `(...)`, and file redirects `>` / `<`
			if (ch === ';' || ch === '&' || ch === '(' || ch === ')' || ch === '>' || ch === '<' || ch === '\n') {
				return true;
			}
			if (ch === '|' && header[i + 1] === '|') {
				return true;
			}
		}
	}
	return inSingle || inDouble;
}

function splitTopLevelPipe(header: string): string[] {
	const parts: string[] = [];
	let inSingle = false;
	let inDouble = false;
	let start = 0;
	for (let i = 0; i < header.length; i++) {
		const ch = header[i];
		if (ch === '\\' && !inSingle) {
			i++;
			continue;
		}
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (!inSingle && !inDouble && ch === '|' && header[i + 1] !== '|') {
			parts.push(header.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(header.slice(start).trim());
	return parts;
}

function readFirstShellWord(input: string): string | undefined {
	const trimmed = input.trimStart();
	if (!trimmed) {
		return undefined;
	}
	const winDriveUnquoted = /^([A-Za-z]:\\[^\s"']+)(?:\s|$)/.exec(trimmed);
	if (winDriveUnquoted) {
		return winDriveUnquoted[1];
	}
	let out = '';
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (inSingle) {
			if (ch === '\'') {
				inSingle = false;
			} else {
				out += ch;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === '\\' && i + 1 < trimmed.length && (trimmed[i + 1] === '"' || trimmed[i + 1] === '\\')) {
				out += trimmed[i + 1];
				i++;
			} else {
				out += ch;
			}
			continue;
		}
		if (/\s/.test(ch)) {
			break;
		}
		if (ch === '\'') {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '\\') {
			if (i + 1 >= trimmed.length) {
				return undefined;
			}
			out += trimmed[i + 1];
			i++;
			continue;
		}
		out += ch;
	}
	if (inSingle || inDouble || !out) {
		return undefined;
	}
	return out;
}

function validateInvokedAdeExecutablePath(rawExe: string): string | undefined {
	if (!rawExe) {
		return undefined;
	}
	const normExe = rawExe.replace(/\\/g, '/');
	if (normExe.includes('/')) {
		// Only allow bare command names (via trusted PATH) or trusted ADE bundled/_bin paths; reject ./, ../, or arbitrary dirs
		if (normExe.startsWith('./') || normExe.startsWith('../') || normExe.includes('/../') || normExe.includes('/./')) {
			return undefined;
		}
		if (!/(?:^|\/)(\.ade_store\/_bin|extensions\/aexus-agents\/bin|Resources\/app\/bin|resources\/app\/bin|(?:Aexus[\s_-]?Code[^/]*|aexus-code)\/bin)\/[A-Za-z0-9_.-]+$/i.test(normExe)) {
			return undefined;
		}
	} else if (/\s/.test(normExe)) {
		return undefined;
	}
	const base = path.posix.basename(normExe).replace(/\.(?:cmd|exe|bat|ps1)$/i, '');
	return ADE_SAFE_CLI_COMMANDS.has(base) ? base : undefined;
}

function extractInvokedAdeCliCommand(stage: string): string | undefined {
	const withoutEnv = stage.replace(SAFE_ENV_ASSIGN_PREFIX_RE, '').trimStart();
	const rawExe = readFirstShellWord(withoutEnv);
	if (!rawExe) {
		return undefined;
	}
	return validateInvokedAdeExecutablePath(rawExe);
}

/**
 * Matches ONLY the exact 45 `ade_*` CLI commands (either standalone or fed via a pure stdin pipe
 * `cat <<'EOF' | ade_* ...` / `printf ... | ade_* ...`), rejecting `;`, `&&`, `||`, `` ` ``, `$()`, and file redirects.
 */
export function isSafeAdeCliBashCommand(rawCommand: string): boolean {
	const trimmed = rawCommand.trim();
	if (!trimmed) {
		return false;
	}
	const strippedHeader = stripSafeHeredocBody(trimmed);
	if (strippedHeader === undefined) {
		return false;
	}
	const normalizedHeader = strippedHeader.replace(/\s+2>&1\s*$/, '').trim();
	if (!normalizedHeader || hasUnsafeShellSyntaxOutsideQuotes(normalizedHeader)) {
		return false;
	}
	const pipeStages = splitTopLevelPipe(normalizedHeader);
	if (pipeStages.length === 0 || pipeStages.length > 2) {
		return false;
	}
	let adeStage = pipeStages[0];
	if (pipeStages.length === 2) {
		const feeder = pipeStages[0];
		if (!/^(?:cat|printf\b.*|echo\b.*)$/.test(feeder)) {
			return false;
		}
		adeStage = pipeStages[1];
	}
	return Boolean(extractInvokedAdeCliCommand(adeStage));
}

export const isSafeAdeBashCommand = isSafeAdeCliBashCommand;

export function hasAdeEmployeeIdentity(optionsOrIdentity?: {
	readonly pureWorker?: boolean;
	readonly adeAgentToken?: string;
	readonly adeProjectId?: string;
	readonly adeAgentId?: string;
	readonly agentToken?: string;
	readonly projectId?: string;
	readonly agentId?: string;
}): boolean {
	if (!optionsOrIdentity || optionsOrIdentity.pureWorker) {
		return false;
	}
	if (typeof optionsOrIdentity.adeAgentToken === 'string' && optionsOrIdentity.adeAgentToken.trim().length > 0) {
		return true;
	}
	if (typeof optionsOrIdentity.agentToken === 'string' && optionsOrIdentity.agentToken.trim().length > 0) {
		return true;
	}
	const projId = optionsOrIdentity.adeProjectId ?? optionsOrIdentity.projectId;
	const agId = optionsOrIdentity.adeAgentId ?? optionsOrIdentity.agentId;
	return Boolean(projId && projId.trim() && agId && agId.trim());
}

function unwrapShellLauncherCommand(raw: string): string {
	const trimmed = raw.trim();
	const prefixMatch = /^(?:\/[A-Za-z0-9._/-]+\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(trimmed);
	if (!prefixMatch) {
		return raw;
	}
	const rest = prefixMatch[1].trim();
	if (!rest) {
		return raw;
	}
	// Reject any outer shell expansion (`$()`, `${}`, `$VAR`, backticks) or chained operators outside quotes
	if (hasUnsafeShellSyntaxOutsideQuotes(rest.replace(/[\r\n]/g, ' '))) {
		return raw;
	}
	let out = '';
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	for (; i < rest.length; i++) {
		const ch = rest[i];
		if (inSingle) {
			if (ch === '\'') {
				inSingle = false;
			} else {
				out += ch;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === '\\' && i + 1 < rest.length && (rest[i + 1] === '"' || rest[i + 1] === '\\')) {
				out += rest[i + 1];
				i++;
			} else {
				out += ch;
			}
			continue;
		}
		if (/\s/.test(ch)) {
			break;
		}
		if (ch === '\'') {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '\\') {
			if (i + 1 >= rest.length) {
				return raw;
			}
			out += rest[i + 1];
			i++;
			continue;
		}
		out += ch;
	}
	if (inSingle || inDouble || rest.slice(i).trim().length > 0) {
		return raw;
	}
	return out;
}

export function isSafeAdeCliCommandInput(cmdInput: unknown): boolean {
	if (typeof cmdInput === 'string') {
		if (isSafeAdeCliBashCommand(cmdInput)) {
			return true;
		}
		const unwrapped = unwrapShellLauncherCommand(cmdInput);
		return unwrapped !== cmdInput && isSafeAdeCliBashCommand(unwrapped);
	}
	if (Array.isArray(cmdInput) && cmdInput.length > 0 && cmdInput.every((item): item is string => typeof item === 'string')) {
		if (
			cmdInput.length === 3
			&& /^(?:\/[A-Za-z0-9._/-]+\/)?(?:ba|z|da)?sh$/.test(cmdInput[0].trim())
			&& (cmdInput[1] === '-c' || cmdInput[1] === '-lc')
		) {
			return isSafeAdeCliBashCommand(cmdInput[2]);
		}
		const firstExe = cmdInput[0].trim();
		if (
			!firstExe
			|| /^(?:\/[A-Za-z0-9._/-]+\/)?(?:ba|z|da|k|c|tc|fi)?sh$/i.test(firstExe)
			|| /(?:^|[\\/])(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(firstExe)
		) {
			return false;
		}
		if (cmdInput.some(arg => arg.includes('\0'))) {
			return false;
		}
		const unquotedFirst = (
			(firstExe.startsWith('"') && firstExe.endsWith('"') && firstExe.length >= 2)
			|| (firstExe.startsWith('\'') && firstExe.endsWith('\'') && firstExe.length >= 2)
		)
			? firstExe.slice(1, -1)
			: firstExe;
		return Boolean(validateInvokedAdeExecutablePath(unquotedFirst));
	}
	return false;
}

function asPlainObject(val: unknown): Record<string, unknown> | undefined {
	return typeof val === 'object' && val !== null && !Array.isArray(val) ? (val as Record<string, unknown>) : undefined;
}

export function isSafeCodexAdeApprovalRequest(
	hasAdeIdentity: boolean,
	method: string | undefined,
	params: Record<string, unknown> | undefined,
): boolean {
	if (!hasAdeIdentity || !method || !method.endsWith('/requestApproval') || !params) {
		return false;
	}
	const lowerMethod = method.toLowerCase();
	if (lowerMethod.includes('filechange') || lowerMethod.includes('applypatch')) {
		return false;
	}
	if (method === 'item/permissions/requestApproval') {
		return params.command !== undefined && isSafeAdeCliCommandInput(params.command);
	}
	const itemObj = asPlainObject(params.item);
	const candidate = params.command ?? itemObj?.command ?? params.parsedCmd;
	return candidate !== undefined && isSafeAdeCliCommandInput(candidate);
}

export function isSafeKiloAdePermissionRequest(
	hasAdeIdentity: boolean,
	data: Record<string, unknown> | undefined,
): boolean {
	if (!hasAdeIdentity || !data) {
		return false;
	}
	const perm = typeof data.permission === 'string' ? data.permission.trim().toLowerCase() : '';
	if (!perm || !['bash', 'shell', 'command', 'exec', 'execute', 'terminal'].includes(perm)) {
		return false;
	}
	const candidates: unknown[] = [];
	if (Array.isArray(data.patterns)) {
		for (const p of data.patterns) {
			candidates.push(p);
		}
	}
	if (data.command !== undefined) {
		candidates.push(data.command);
	}
	const meta = asPlainObject(data.metadata);
	if (meta?.command !== undefined) {
		candidates.push(meta.command);
	}
	if (meta?.cmd !== undefined) {
		candidates.push(meta.cmd);
	}
	return candidates.length > 0 && candidates.every(c => isSafeAdeCliCommandInput(c));
}

export function isSafeAcpAdePermissionRequest(
	hasAdeIdentity: boolean,
	params: Record<string, unknown> | undefined,
): boolean {
	if (!hasAdeIdentity || !params) {
		return false;
	}
	const toolCall = asPlainObject(params.toolCall);
	const kind = typeof toolCall?.kind === 'string' ? toolCall.kind.trim().toLowerCase() : '';
	if (kind && ['edit', 'write', 'delete', 'move', 'fetch', 'read_external'].includes(kind)) {
		return false;
	}

	let hasStructuredInput = false;
	const structuredCandidates: unknown[] = [];
	for (const src of [toolCall?.rawInput, toolCall?.input, toolCall?.arguments, toolCall?.args]) {
		if (src !== undefined && src !== null) {
			hasStructuredInput = true;
			if (typeof src === 'string' || Array.isArray(src)) {
				structuredCandidates.push(src);
			} else {
				const rec = asPlainObject(src);
				if (rec) {
					for (const field of ['command', 'cmd', 'commandLine'] as const) {
						if (rec[field] !== undefined) {
							structuredCandidates.push(rec[field]);
						}
					}
				}
			}
		}
	}
	for (const directCmd of [toolCall?.command, params.command]) {
		if (directCmd !== undefined) {
			hasStructuredInput = true;
			structuredCandidates.push(directCmd);
		}
	}
	if (hasStructuredInput) {
		return structuredCandidates.length > 0 && structuredCandidates.every(c => isSafeAdeCliCommandInput(c));
	}

	return false;
}
