/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as path from 'node:path';

/**
 * Pure, framework-free engine adapter & process-group containment helpers shared by
 * `runtime.ts`, `claude.ts`, and `codex.ts` so PGID termination, effort mappings, fallback cascades,
 * and safe `aexus-ade` shell detection are deterministically unit-testable under `node --test`.
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
 * Terminates an `engineProcess.js` supervisor AND its dedicated inner CLI process group (`PGID_2`)
 * without leaving orphaned grandchildren even on immediate `SIGKILL`.
 */
export function stopSpawnedEngineProcess(child: cp.ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
	try {
		if (process.platform !== 'win32') {
			const innerPid = innerEngineProcessPids.get(child);
			if (innerPid) {
				killPosixGroupBestEffort(innerPid, signal);
			}
			if (signal === 'SIGKILL') {
				if (child.connected) {
					try { child.send({ type: 'terminate', signal: 'SIGKILL' }); } catch { /* ignore */ }
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
					child.send({ type: 'terminate', signal });
					return;
				} catch { /* fall through to PGID signal */ }
			}
			if (child.pid) {
				killPosixGroupBestEffort(child.pid, signal);
				return;
			}
		}
		if (process.platform === 'win32') {
			if (child.connected && signal !== 'SIGKILL') {
				try {
					child.send({ type: 'terminate', signal });
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
		case 'max':
			return 'xhigh';
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

/**
 * Builds an ordered fallback cascade when a Codex `turn/start` call rejects a model/effort pair:
 * - If an effort level (e.g. `xhigh`) was rejected on a valid `requestedModel`, downgrade effort
 *   (`high` -> `undefined`) BEFORE discarding `requestedModel`!
 * - Only fall back to `defaultModel` if `requestedModel` itself fails or is unsupported.
 */
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

	if (!modelExplicitlyMissing && requestedModel && mappedEffort) {
		if (mappedEffort === 'xhigh') {
			pushUnique({ model: requestedModel, effort: 'high' });
		}
		pushUnique({ model: requestedModel, effort: undefined });
	}
	if (mappedEffort && !requestedModel) {
		if (mappedEffort === 'xhigh') {
			pushUnique({ model: undefined, effort: 'high' });
		}
		pushUnique({ model: undefined, effort: undefined });
	}
	if (defaultModel && defaultModel !== requestedModel) {
		if (mappedEffort && !modelExplicitlyMissing) {
			pushUnique({ model: defaultModel, effort: mappedEffort === 'xhigh' ? 'high' : mappedEffort, pinDefaultModel: true });
		}
		pushUnique({ model: defaultModel, effort: undefined, pinDefaultModel: true });
	} else if (requestedModel && modelExplicitlyMissing) {
		pushUnique({ model: undefined, effort: mappedEffort === 'xhigh' ? 'high' : mappedEffort });
		pushUnique({ model: undefined, effort: undefined });
	}

	return attempts;
}

/**
 * Strict safe environment variable prefix allowlist for auto-approved `aexus-ade` Bash invocations.
 * Blocks `NODE_OPTIONS`, `PATH`, `LD_*`, `DYLD_*`, and `AEXUS_ADE_TOKEN`/`SOCKET`/`CONTROL_FILE` overrides!
 */
const SAFE_ENV_ASSIGN_PREFIX_RE = /^(?:(?:NO_COLOR|FORCE_COLOR|TERM|LANG|LC_ALL|AEXUS_ADE_WINDOW_ID|AEXUS_ADE_IDEMPOTENCY_KEY)=(?:"[^"`$\\]*"|'[^']*'|[A-Za-z0-9._:-]+)\s+)*/;
const ADE_BIN_INVOKE_RE = /^(?:"(?:\/[\w./ -]+|[A-Za-z]:[\\/][\w.\\/ -]+)\/aexus-ade(?:\.(?:cmd|exe|ps1|bat))?"|'(?:\/[\w./ -]+|[A-Za-z]:[\\/][\w.\\/ -]+)\/aexus-ade(?:\.(?:cmd|exe|ps1|bat))?'|(?:(?:\/(?:[\w./-]|\\ )+|[A-Za-z]:[\\/](?:[\w.\\/-]|\\ )+)\/)?aexus-ade(?:\.(?:cmd|exe|ps1|bat))?)(?:\s|$)/i;

/**
 * Quote-aware top-level heredoc stripper:
 * - Only recognizes `<<'DELIM'`, `<<"DELIM"`, `<<\DELIM` (and `<<-` variants) when `<<` occurs OUTSIDE quotes on line 1.
 * - Rejects unquoted `<<DELIM` outside quotes (which performs `$(...)` shell expansion inside the body).
 * - Never matches `<<'EOF'` embedded inside a quoted flag value (preventing multiline fake-heredoc command injection).
 */
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
				// Disallow bash here-strings `<<<` (expands variables/command substitutions).
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
		// Unquoted heredoc delimiter (`<<EOF`) or malformed heredoc -> unsafe!
		return undefined;
	}
	const delimiter = quotedMatch[1] ?? quotedMatch[2] ?? quotedMatch[3];
	const restOfHeader = quotedMatch[4] ?? '';
	// Allow either nothing/stderr-merge or `| aexus-ade ...` after `cat <<'EOF'` on the header line,
	// as long as there is no second heredoc on the same line.
	if (restOfHeader.includes('<<')) {
		return undefined;
	}
	if (firstNl < 0) {
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
		if (!inSingle) {
			// Command substitution (`...` or `$(...)`) is unsafe both unquoted and inside double quotes.
			if (ch === '`' || (ch === '$' && header[i + 1] === '(')) {
				return true;
			}
		}
		if (!inSingle && !inDouble) {
			// Disallow arbitrary `;`, background `&`, subshells `(...)`, or file redirects `>` / `<`
			if (ch === ';' || ch === '(' || ch === ')' || ch === '>' || ch === '<' || ch === '\n') {
				return true;
			}
			if (ch === '&' && header[i + 1] !== '&') {
				return true;
			}
			if (ch === '&' && header[i + 1] === '&') {
				i++;
				continue;
			}
			if (ch === '|' && header[i + 1] === '|') {
				return true;
			}
		}
	}
	return inSingle || inDouble;
}

function splitTopLevelOperator(header: string, op: '&&' | '|'): string[] {
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
		} else if (!inSingle && !inDouble) {
			if (op === '&&' && ch === '&' && header[i + 1] === '&') {
				parts.push(header.slice(start, i).trim());
				i++;
				start = i + 1;
			} else if (op === '|' && ch === '|' && header[i + 1] !== '|') {
				parts.push(header.slice(start, i).trim());
				start = i + 1;
			}
		}
	}
	parts.push(header.slice(start).trim());
	return parts;
}

/**
 * Recognizes safe `aexus-ade` invocations in orchestrator Bash tool calls, including:
 * - Direct calls: `aexus-ade token split ...`
 * - Working-directory prefixes: `cd /repo && aexus-ade ...`
 * - Quoted-heredoc stdin: `aexus-ade whiteboard write wb --content - <<'EOF'\n...\nEOF`
 * - Safe stdin feeders: `cat <<'EOF' | aexus-ade ...` or `printf '%s' '...' | aexus-ade ...`
 * While strictly rejecting command substitution, unquoted heredocs, file redirects, `;`, or arbitrary commands.
 */
export function isSafeAdeBashCommand(rawCommand: string): boolean {
	const trimmed = rawCommand.trim();
	if (!trimmed) {
		return false;
	}
	const strippedHeader = stripSafeHeredocBody(trimmed);
	if (strippedHeader === undefined) {
		return false;
	}
	// Strip safe trailing `2>&1` stderr merge if present before checking redirects.
	const normalizedHeader = strippedHeader.replace(/\s+2>&1\s*$/, '').trim();
	if (!normalizedHeader || hasUnsafeShellSyntaxOutsideQuotes(normalizedHeader)) {
		return false;
	}

	const andClauses = splitTopLevelOperator(normalizedHeader, '&&');
	if (andClauses.length === 0 || andClauses.length > 2) {
		return false;
	}
	let mainClause = andClauses[0];
	if (andClauses.length === 2) {
		const cdClause = andClauses[0];
		if (!/^cd\s+(?:"[^"`$\\]+"|'[^']+'|[\w./~-]+)$/.test(cdClause)) {
			return false;
		}
		mainClause = andClauses[1];
	}

	const pipeStages = splitTopLevelOperator(mainClause, '|');
	if (pipeStages.length === 0 || pipeStages.length > 2) {
		return false;
	}
	let adeStage = pipeStages[0];
	if (pipeStages.length === 2) {
		const feeder = pipeStages[0];
		// Allow bare `cat` (heredoc stdin only — never `cat /arbitrary/file`!) or literal `printf`/`echo`.
		if (!/^(?:cat|printf\b.*|echo\b.*)$/.test(feeder)) {
			return false;
		}
		adeStage = pipeStages[1];
	}

	const withoutEnv = adeStage.replace(SAFE_ENV_ASSIGN_PREFIX_RE, '').trimStart();
	return ADE_BIN_INVOKE_RE.test(withoutEnv);
}
