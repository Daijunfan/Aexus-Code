/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
	buildRemotePersistentPrefix,
	CloudHostTarget,
	encodeClaudeProjectSlug,
	execRemoteShell,
	healAllRemoteControlBridges,
	inspectRemotePersistentSessionsByPrefix,
	joinRemotePath,
	posixQuote,
	psSingleQuote,
	readRemoteTextFile,
	readRemoteTextFilesBatch,
	resolveRemoteRealpath,
	terminateRemotePersistentSession,
	terminateRemotePersistentSessionsByPrefix,
} from './cloudTransport';
import { isPathWithinOrEqual, ROLE_INIT_MARKER, stripInjectedAdeContextFromUserTurn } from './roleBridgeShared';
import { capture, emitThinkingProgress, EngineAttachment, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineThinkingLevel, EngineTurnTokenUsage, HistoryEntry, isAutonomousModeEnabled, NativeSession, prepareAgentChildEnv, prepareRemoteAgentChildEnv, raceWithCancellation, REMOTE_REATTACH_BACKOFFS_MS, spawnEngine, stopEngine, stopEngineWithFallback, waitForBackoffOrResume } from './runtime';

interface ContentPart { type: string; text?: string; source?: { type: 'base64'; media_type: string; data: string } }
interface ContentBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }
interface UsagePayload { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
interface ClaudeEvent {
	type: string;
	parent_tool_use_id?: string | null;
	subtype?: string;
	sessionId?: string;
	agentId?: string;
	uuid?: string;
	isMeta?: boolean;
	cwd?: string;
	timestamp?: string;
	customTitle?: string;
	agentName?: string;
	message?: { content: string | ContentBlock[]; usage?: UsagePayload };
	event?: { type: string; delta?: { type?: string; text?: string; thinking?: string }; content_block?: ContentBlock };
	request_id?: string;
	request?: { subtype: string; tool_name: string; input: object };
	result?: string;
	is_error?: boolean;
	slash_commands?: unknown;
	skills?: unknown;
	agents?: unknown;
	mcp_servers?: unknown;
	model?: string;
	permissionMode?: string;
	total_cost_usd?: number;
	duration_ms?: number;
	num_turns?: number;
	usage?: UsagePayload;
}

interface ClaudeInitInfo {
	slashCommands: string[];
	skills: Array<{ name: string; description?: string }>;
	agents: string[];
	mcpServers: Array<{ name: string; status?: string }>;
	model?: string;
	permissionMode?: string;
}

interface ClaudeUsageStats {
	totalCostUsd?: number;
	durationMs?: number;
	numTurns?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	updatedAt: number;
}

function messageText(event: ClaudeEvent): string {
	const content = event.message?.content;
	return typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
}

export { encodeClaudeProjectSlug };

export function extractClaudeUserLabel(rawText: string): string | undefined {
	const cleaned = stripInjectedAdeContextFromUserTurn(rawText).trim();
	if (!cleaned || cleaned.startsWith(ROLE_INIT_MARKER)) {
		return undefined;
	}
	if (
		cleaned.startsWith('<local-command-caveat>')
		|| cleaned.startsWith('<command-name>')
		|| cleaned.startsWith('<system-reminder>')
		|| cleaned.startsWith('<task-notification>')
		|| cleaned.startsWith('[Request interrupted')
	) {
		return undefined;
	}
	const firstLine = cleaned.split(/\r?\n/).find(line => line.trim().length > 0)?.trim();
	return firstLine ? firstLine.slice(0, 100) : undefined;
}

function turnUsageFromPayload(usage: UsagePayload | undefined, durationMs?: number, costUsd?: number): EngineTurnTokenUsage {
	const inputTokens = usage?.input_tokens ?? 0;
	const outputTokens = usage?.output_tokens ?? 0;
	const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
	const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
		durationMs,
		costUsd,
		estimated: false,
	};
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(item => {
		if (typeof item === 'string') {
			return item;
		}
		if (item && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			for (const key of ['name', 'id', 'skill', 'command']) {
				if (typeof record[key] === 'string') {
					return record[key] as string;
				}
			}
		}
		return '';
	}).map(item => item.trim()).filter(Boolean);
}

function skillList(value: unknown): Array<{ name: string; description?: string }> {
	const names = stringList(value);
	return names.map(name => {
		let description: string | undefined;
		if (Array.isArray(value)) {
			const match = value.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).name === name) as Record<string, unknown> | undefined;
			if (typeof match?.description === 'string') {
				description = match.description;
			}
		}
		return { name, description };
	});
}

function mcpServerList(value: unknown): Array<{ name: string; status?: string }> {
	if (!Array.isArray(value)) {
		return [];
	}
	const servers: Array<{ name: string; status?: string }> = [];
	for (const item of value) {
		if (typeof item === 'string' && item.trim()) {
			servers.push({ name: item.trim() });
			continue;
		}
		if (item && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			const name = typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : '';
			if (!name) {
				continue;
			}
			const status = typeof record.status === 'string' ? record.status : typeof record.state === 'string' ? record.state : undefined;
			servers.push({ name, status });
		}
	}
	return servers;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shorten(value: string, max = 140): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function toolProgressText(name: string, input: unknown): string {
	const params = (input ?? {}) as Record<string, unknown>;
	const field = (key: string): string | undefined => {
		const value = params[key];
		return typeof value === 'string' && value.trim() ? value.trim() : undefined;
	};
	switch (name) {
		case 'Bash': {
			const command = field('command');
			return command ? vscode.l10n.t('Running command: {0}', shorten(command)) : vscode.l10n.t('Running a command…');
		}
		case 'Read': {
			const file = field('file_path');
			return file ? vscode.l10n.t('Reading file: {0}', file) : vscode.l10n.t('Reading a file…');
		}
		case 'Write': {
			const file = field('file_path');
			return file ? vscode.l10n.t('Writing file: {0}', file) : vscode.l10n.t('Writing a file…');
		}
		case 'Edit': {
			const file = field('file_path');
			return file ? vscode.l10n.t('Editing file: {0}', file) : vscode.l10n.t('Editing a file…');
		}
		case 'MultiEdit': {
			const file = field('file_path');
			return file ? vscode.l10n.t('Editing files: {0}', file) : vscode.l10n.t('Editing files…');
		}
		case 'NotebookEdit': {
			const file = field('notebook_path') ?? field('file_path');
			return file ? vscode.l10n.t('Editing notebook: {0}', file) : vscode.l10n.t('Editing a notebook…');
		}
		case 'Grep': {
			const pattern = field('pattern');
			return pattern ? vscode.l10n.t('Searching for: {0}', shorten(pattern)) : vscode.l10n.t('Searching the codebase…');
		}
		case 'Glob': {
			const pattern = field('pattern');
			return pattern ? vscode.l10n.t('Finding files: {0}', shorten(pattern)) : vscode.l10n.t('Finding files…');
		}
		case 'LS': {
			const directory = field('path');
			return directory ? vscode.l10n.t('Listing directory: {0}', directory) : vscode.l10n.t('Listing a directory…');
		}
		case 'Task': {
			const agent = field('description') ?? field('subagent_type');
			return agent ? vscode.l10n.t('Running subagent: {0}', agent) : vscode.l10n.t('Running a subagent…');
		}
		case 'WebFetch': {
			const url = field('url');
			return url ? vscode.l10n.t('Fetching: {0}', shorten(url)) : vscode.l10n.t('Fetching a web page…');
		}
		case 'WebSearch': {
			const query = field('query');
			return query ? vscode.l10n.t('Searching the web: {0}', shorten(query)) : vscode.l10n.t('Searching the web…');
		}
		case 'Skill': {
			const skill = field('skill') ?? field('command');
			return skill ? vscode.l10n.t('Invoking skill: {0}', skill) : vscode.l10n.t('Invoking a skill…');
		}
		default:
			return name.startsWith('mcp__')
				? vscode.l10n.t('Calling MCP tool: {0}', name.slice(5).replace(/__/g, ':'))
				: vscode.l10n.t('Calling tool: {0}', name);
	}
}

function imageMimeType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		case '.gif':
			return 'image/gif';
		case '.webp':
			return 'image/webp';
		default:
			return 'image/png';
	}
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function nameOfUsageReport(includeContext: boolean): string {
	return includeContext ? `### ${vscode.l10n.t('Claude context usage')}` : `### ${vscode.l10n.t('Claude session usage')}`;
}

function contextWindowLabel(model?: string): string {
	if (!model) {
		return vscode.l10n.t('Unknown');
	}
	const lower = model.toLowerCase();
	if (lower.includes('[1m]') || /(^|[^0-9])1m([^0-9]|$)/.test(lower)) {
		return '1,000,000 tokens';
	}
	return '200,000 tokens';
}

function isSafeAdeOrchestratorToolCall(
	callerRole: string | undefined,
	toolName: string | undefined,
	rawInput: object | undefined,
): boolean {
	const normalized = callerRole?.trim().toLowerCase();
	if (!normalized || normalized === 'worker' || normalized === 'pure-worker') {
		return false;
	}
	if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') {
		return true;
	}
	const input = (rawInput ?? {}) as Record<string, unknown>;
	if (toolName === 'Write' || toolName === 'Edit') {
		const fp = typeof input.file_path === 'string' ? input.file_path : '';
		if (!fp) { return false; }
		return fp.startsWith('/tmp/') || fp.startsWith('/private/tmp/') || isPathWithinOrEqual(fp, os.tmpdir());
	}
	if (toolName === 'Bash') {
		const cmd = typeof input.command === 'string' ? input.command.trim() : '';
		return /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*aexus-ade(?:\.(?:cmd|exe|ps1|bat))?(?:\s|$)/i.test(cmd);
	}
	return false;
}

export class ClaudeRuntime implements EngineRuntime {
	readonly id = 'claude';
	readonly name = 'Claude Code';
	private readonly running = new Set<ReturnType<typeof spawnEngine>>();
	private readonly runningBySession = new Map<string, Set<ReturnType<typeof spawnEngine>>>();
	private readonly activePersistentIdsBySession = new Map<string, Set<string>>();
	private readonly initBySession = new Map<string, ClaudeInitInfo>();
	private readonly usageBySession = new Map<string, ClaudeUsageStats>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private lastInit: ClaudeInitInfo | undefined;
	constructor(private readonly executable: string, readonly remoteTarget?: CloudHostTarget) { }

	private configDir(): string {
		return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	}

	private remoteHomePrefix(): string {
		if (this.remoteTarget?.remoteHome) {
			return joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.claude');
		}
		return this.remoteTarget?.os === 'windows' ? '.claude' : '$HOME/.claude';
	}

	private parseTranscriptLines(lines: Iterable<string>): HistoryEntry[] {
		const history: HistoryEntry[] = [];
		for (const line of lines) {
			if (!line) { continue; }
			let event: ClaudeEvent;
			try { event = JSON.parse(line) as ClaudeEvent; } catch { continue; }
			const text = messageText(event);
			if (text && (event.type === 'user' || event.type === 'assistant')) {
				history.push({ id: event.uuid, role: event.type, text, isSystemInitiated: event.isMeta });
			}
		}
		return history;
	}

	private async listRemote(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (!this.remoteTarget || token.isCancellationRequested) {
			return [];
		}
		const targetCwds: string[] = [];
		const targetSlugs: string[] = [];
		if (projectCwd?.trim()) {
			const canonical = projectCwd.trim();
			targetCwds.push(canonical);
			const realCwd = await resolveRemoteRealpath(this.remoteTarget, canonical, token).catch(() => undefined);
			if (realCwd && !targetCwds.includes(realCwd)) {
				targetCwds.push(realCwd);
			}
			for (const candidate of targetCwds) {
				const slug = encodeClaudeProjectSlug(candidate);
				if (slug && !targetSlugs.includes(slug)) {
					targetSlugs.push(slug);
				}
			}
		}

		const pyScript = [
			`import glob, json, os, sys`,
			`cfg = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")`,
			`if not os.path.isdir(cfg): sys.exit(0)`,
			`target_slugs = json.loads(sys.argv[1])`,
			`canonical_cwd = sys.argv[2]`,
			`files = []`,
			`if target_slugs:`,
			`    seen_fp = set()`,
			`    for slug in target_slugs:`,
			`        d = os.path.join(cfg, slug)`,
			`        if not os.path.isdir(d): continue`,
			`        for name in os.listdir(d):`,
			`            if not name.endswith(".jsonl"): continue`,
			`            fp = os.path.join(d, name)`,
			`            if fp in seen_fp or not os.path.isfile(fp): continue`,
			`            seen_fp.add(fp)`,
			`            try: st = os.stat(fp)`,
			`            except OSError: continue`,
			`            files.append((st.st_mtime, st.st_ctime, st.st_size, fp, True))`,
			`else:`,
			`    for fp in glob.glob(os.path.join(cfg, "*", "*.jsonl")):`,
			`        if not os.path.isfile(fp): continue`,
			`        try: st = os.stat(fp)`,
			`        except OSError: continue`,
			`        files.append((st.st_mtime, st.st_ctime, st.st_size, fp, False))`,
			`files.sort(key=lambda x: x[0], reverse=True)`,
			`B_CT = b'"custom-title"'`,
			`B_AN = b'"agent-name"'`,
			`B_SID = b'"sessionId"'`,
			`B_CWD = b'"cwd"'`,
			`B_U1 = b'"type":"user"'`,
			`B_U2 = b'"type": "user"'`,
			`SKIP_PFX = ("<local-command-caveat>", "<command-name>", "<system-reminder>", "<task-notification>", "[Request interrupted")`,
			`def parse_title_lines(buf):`,
			`    ct = None; an = None`,
			`    for raw in buf.splitlines():`,
			`        if B_CT not in raw and B_AN not in raw: continue`,
			`        try: ev = json.loads(raw.decode("utf-8", "replace"))`,
			`        except Exception: continue`,
			`        if not isinstance(ev, dict): continue`,
			`        t = ev.get("type")`,
			`        if t == "custom-title" and isinstance(ev.get("customTitle"), str) and ev["customTitle"].strip(): ct = ev["customTitle"].strip()`,
			`        elif t == "agent-name" and isinstance(ev.get("agentName"), str) and ev["agentName"].strip(): an = ev["agentName"].strip()`,
			`    return ct, an`,
			`for mtime, ctime, fsize, fp, in_target_slug in files[:200]:`,
			`    sid = None; first_cwd = None; custom_title = None; agent_name = None; raw_user = None; first_ts = None`,
			`    try:`,
			`        with open(fp, "rb") as f:`,
			`            head_end = 0`,
			`            for _ in range(150):`,
			`                raw = f.readline()`,
			`                if not raw: break`,
			`                head_end = f.tell()`,
			`                want = (B_CT in raw or B_AN in raw)`,
			`                if not want and (not sid or not first_cwd) and (B_SID in raw or B_CWD in raw): want = True`,
			`                if not want and not raw_user and len(raw) < 524288 and (B_U1 in raw or B_U2 in raw): want = True`,
			`                if not want: continue`,
			`                try: ev = json.loads(raw.decode("utf-8", "replace"))`,
			`                except Exception: continue`,
			`                if not isinstance(ev, dict): continue`,
			`                if not sid and isinstance(ev.get("sessionId"), str) and ev["sessionId"]: sid = ev["sessionId"]`,
			`                if not first_cwd and isinstance(ev.get("cwd"), str) and ev["cwd"]: first_cwd = ev["cwd"]`,
			`                if not first_ts and isinstance(ev.get("timestamp"), str) and ev["timestamp"]: first_ts = ev["timestamp"]`,
			`                t = ev.get("type")`,
			`                if t == "custom-title" and isinstance(ev.get("customTitle"), str) and ev["customTitle"].strip(): custom_title = ev["customTitle"].strip()`,
			`                elif t == "agent-name" and isinstance(ev.get("agentName"), str) and ev["agentName"].strip(): agent_name = ev["agentName"].strip()`,
			`                elif t == "user" and not raw_user and not ev.get("isMeta"):`,
			`                    msg = ev.get("message")`,
			`                    content = msg.get("content") if isinstance(msg, dict) else None`,
			`                    txt = content if isinstance(content, str) else ("\\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str)) if isinstance(content, list) else "")`,
			`                    ts_s = txt.strip()`,
			`                    if ts_s and not ts_s.startswith(SKIP_PFX): raw_user = ts_s[:2000]`,
			`                if head_end > 1048576 and sid and first_cwd and raw_user: break`,
			`            if head_end < fsize:`,
			`                tail_start = max(head_end, fsize - 262144)`,
			`                f.seek(tail_start)`,
			`                tail_buf = f.read()`,
			`                t_ct, t_an = (parse_title_lines(tail_buf) if (B_CT in tail_buf or B_AN in tail_buf) else (None, None))`,
			`                if t_ct or t_an:`,
			`                    if t_ct: custom_title = t_ct`,
			`                    if t_an: agent_name = t_an`,
			`                elif tail_start > head_end:`,
			`                    f.seek(head_end)`,
			`                    pos = head_end; rem = b""`,
			`                    while pos < tail_start:`,
			`                        chunk = f.read(min(4194304, tail_start - pos))`,
			`                        if not chunk: break`,
			`                        pos += len(chunk)`,
			`                        buf = rem + chunk`,
			`                        nl = buf.rfind(b"\\n")`,
			`                        if nl >= 0: body, rem = buf[:nl + 1], buf[nl + 1:]`,
			`                        else: rem = (b"" if len(buf) > 8388608 else buf); continue`,
			`                        if B_CT in body or B_AN in body:`,
			`                            m_ct, m_an = parse_title_lines(body)`,
			`                            if m_ct: custom_title = m_ct`,
			`                            if m_an: agent_name = m_an`,
			`                    if rem and (B_CT in rem or B_AN in rem):`,
			`                        m_ct, m_an = parse_title_lines(rem)`,
			`                        if m_ct: custom_title = m_ct`,
			`                        if m_an: agent_name = m_an`,
			`    except OSError:`,
			`        continue`,
			`    base_id = os.path.splitext(os.path.basename(fp))[0]`,
			`    eff_id = sid or (base_id if (custom_title or agent_name or raw_user) else None)`,
			`    eff_cwd = (canonical_cwd if (in_target_slug and canonical_cwd) else first_cwd)`,
			`    if eff_id and eff_cwd:`,
			`        print("__AEX_CLAUDE_J__\\t" + json.dumps({"id": eff_id, "cwd": eff_cwd, "title": custom_title or agent_name or "", "rawUser": raw_user or "", "mtime": int(mtime * 1000), "ctime": int(ctime * 1000), "ts": first_ts or "", "file": fp}, ensure_ascii=False))`,
		].join('\n');

		const slugsJson = JSON.stringify(targetSlugs);
		const canonicalArg = targetCwds[0] ?? '';
		const slugShellLoop = targetSlugs.length > 0
			? `for _slug in ${targetSlugs.map(posixQuote).join(' ')}; do for f in "$cfg/$_slug"/*.jsonl; do [ -f "$f" ] || continue; m=$(stat -c "%Y" "$f" 2>/dev/null || stat -f "%m" "$f" 2>/dev/null || echo 0); printf '%s\\t%s\\n' "$m" "$f"; done; done`
			: `for f in "$cfg"/*/*.jsonl; do [ -f "$f" ] || continue; m=$(stat -c "%Y" "$f" 2>/dev/null || stat -f "%m" "$f" 2>/dev/null || echo 0); printf '%s\\t%s\\n' "$m" "$f"; done`;

		const posixScript = [
			`if command -v python3 >/dev/null 2>&1; then`,
			`  python3 -c ${posixQuote(pyScript)} ${posixQuote(slugsJson)} ${posixQuote(canonicalArg)}`,
			`  exit $?`,
			`fi`,
			`cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"`,
			`[ -d "$cfg" ] || exit 0`,
			`${slugShellLoop} | sort -rn | head -n 120 | while IFS=$(printf '\\t') read -r m f; do`,
			`  [ -f "$f" ] || continue`,
			`  printf '__AEX_CLAUDE_F__\\t%s\\t%s\\n' "$m" "$f"`,
			`  head -n 80 -- "$f" 2>/dev/null || true`,
			`done`,
		].join('\n');

		const winSlugFilter = targetSlugs.length > 0
			? `@(${targetSlugs.map(psSingleQuote).join(', ')}) | ForEach-Object { $sd = Join-Path $cfg $_; if (Test-Path -LiteralPath $sd) { Get-ChildItem -LiteralPath $sd -Filter '*.jsonl' -File -ErrorAction SilentlyContinue } }`
			: `Get-ChildItem -LiteralPath $cfg -Directory -ErrorAction SilentlyContinue | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue }`;
		const winScript = [
			`$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }`,
			`$cfg = Join-Path $base 'projects'`,
			`if (Test-Path -LiteralPath $cfg) {`,
			`  ${winSlugFilter} | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 150 | ForEach-Object {`,
			`    $ms = [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()`,
			`    Write-Output ("__AEX_CLAUDE_F__" + [char]9 + $ms + [char]9 + $_.FullName)`,
			`    Get-Content -LiteralPath $_.FullName -TotalCount 80 -Encoding UTF8 -ErrorAction SilentlyContinue`,
			`    Get-Content -LiteralPath $_.FullName -Tail 30 -Encoding UTF8 -ErrorAction SilentlyContinue`,
			`  }`,
			`}`,
		].join('; ');

		const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 20_000, token }).catch(() => undefined);
		if (!res || res.code !== 0) {
			return [];
		}
		const sessions: NativeSession[] = [];
		const seenIds = new Set<string>();
		let curFile: string | undefined;
		let curMtime = Date.now();
		let foundId: string | undefined;
		let foundCwd: string | undefined;
		let foundCustomTitle: string | undefined;
		let foundAgentName: string | undefined;
		let foundUserLabel: string | undefined;
		const flushLegacy = () => {
			const effCwd = (targetSlugs.length > 0 && canonicalArg) ? canonicalArg : foundCwd;
			if (curFile && foundId && effCwd && !seenIds.has(foundId)) {
				seenIds.add(foundId);
				sessions.push({
					id: foundId,
					cwd: effCwd,
					label: foundCustomTitle || foundAgentName || foundUserLabel || vscode.l10n.t('Claude Session {0}', foundId.slice(0, 8)),
					created: curMtime,
					updated: curMtime,
					file: curFile,
					provisional: false,
				});
			}
		};
		for (const rawLine of res.stdout.toString('utf8').split(/\r?\n/)) {
			if (rawLine.startsWith('__AEX_CLAUDE_J__\t')) {
				try {
					const row = JSON.parse(rawLine.slice('__AEX_CLAUDE_J__\t'.length)) as {
						id?: string; cwd?: string; title?: string; rawUser?: string; mtime?: number; ctime?: number; ts?: string; file?: string;
					};
					if (row.id && row.cwd && !seenIds.has(row.id)) {
						seenIds.add(row.id);
						const mtime = typeof row.mtime === 'number' && row.mtime > 0 ? row.mtime : Date.now();
						const parsedTs = row.ts ? Date.parse(row.ts) : NaN;
						const created = Number.isFinite(parsedTs) ? parsedTs : (typeof row.ctime === 'number' && row.ctime > 0 ? row.ctime : mtime);
						const userLabel = row.rawUser ? extractClaudeUserLabel(row.rawUser) : undefined;
						sessions.push({
							id: row.id,
							cwd: row.cwd,
							label: row.title?.trim() || userLabel || vscode.l10n.t('Claude Session {0}', row.id.slice(0, 8)),
							created,
							updated: mtime,
							file: row.file,
							provisional: false,
						});
					}
				} catch { /* ignore malformed metadata line */ }
				continue;
			}
			if (rawLine.startsWith('__AEX_CLAUDE_F__\t')) {
				flushLegacy();
				const parts = rawLine.split('\t');
				const rawTs = Number(parts[1]) || 0;
				curMtime = rawTs > 1e11 ? rawTs : (rawTs > 0 ? rawTs * 1000 : Date.now());
				curFile = parts.slice(2).join('\t').trim() || undefined;
				foundId = undefined;
				foundCwd = undefined;
				foundCustomTitle = undefined;
				foundAgentName = undefined;
				foundUserLabel = undefined;
				continue;
			}
			if (!curFile) {
				continue;
			}
			let event: ClaudeEvent;
			try { event = JSON.parse(rawLine) as ClaudeEvent; } catch { continue; }
			if (event.sessionId) { foundId ??= event.sessionId; }
			if (event.cwd) { foundCwd ??= event.cwd; }
			if (event.type === 'custom-title' && typeof event.customTitle === 'string' && event.customTitle.trim()) {
				foundCustomTitle = event.customTitle.trim();
			} else if (event.type === 'agent-name' && typeof event.agentName === 'string' && event.agentName.trim()) {
				foundAgentName = event.agentName.trim();
			} else if (!foundUserLabel && event.type === 'user' && !event.isMeta) {
				foundUserLabel = extractClaudeUserLabel(messageText(event));
			}
		}
		flushLegacy();
		return sessions;
	}

	async list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (this.remoteTarget) {
			return this.listRemote(token, projectCwd);
		}
		const projects = path.join(this.configDir(), 'projects');
		let directories: string[];
		let canonicalProjectCwd: string | undefined;
		if (projectCwd?.trim()) {
			canonicalProjectCwd = projectCwd.trim();
			const realCwd = await fs.realpath(canonicalProjectCwd).catch(() => path.resolve(canonicalProjectCwd!));
			const slugs = [...new Set([encodeClaudeProjectSlug(canonicalProjectCwd), encodeClaudeProjectSlug(realCwd)].filter(Boolean))];
			directories = [];
			for (const slug of slugs) {
				try {
					const st = await fs.stat(path.join(projects, slug));
					if (st.isDirectory()) { directories.push(slug); }
				} catch { /* ignore absent slug dir */ }
			}
		} else {
			try { directories = await fs.readdir(projects); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
		}
		const candidates = (await Promise.all(directories.map(async directory => {
			const folder = path.join(projects, directory);
			try {
				return await Promise.all((await fs.readdir(folder)).filter(name => name.endsWith('.jsonl')).map(async name => ({ file: path.join(folder, name), stat: await fs.stat(path.join(folder, name)) })));
			} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOTDIR' || (error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
		}))).flat().sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
		const sessions: NativeSession[] = [];
		const seenIds = new Set<string>();
		for (const candidate of candidates.slice(0, 200)) {
			if (token.isCancellationRequested) { break; }
			const input = createReadStream(candidate.file);
			const lines = readline.createInterface({ input, crlfDelay: Infinity });
			try {
				let lineCount = 0;
				let foundId: string | undefined;
				let foundCwd: string | undefined;
				let foundCustomTitle: string | undefined;
				let foundAgentName: string | undefined;
				let foundUserLabel: string | undefined;
				for await (const line of lines) {
					lineCount++;
					const isTitleLine = line.includes('"custom-title"') || line.includes('"agent-name"');
					const wantParse = isTitleLine || (lineCount <= 120 && (!foundId || !foundCwd || !foundUserLabel));
					if (!wantParse) {
						continue;
					}
					let event: ClaudeEvent;
					try { event = JSON.parse(line) as ClaudeEvent; } catch { continue; }
					if (event.sessionId) { foundId ??= event.sessionId; }
					if (event.cwd) { foundCwd ??= event.cwd; }
					if (event.type === 'custom-title' && typeof event.customTitle === 'string' && event.customTitle.trim()) {
						foundCustomTitle = event.customTitle.trim();
					} else if (event.type === 'agent-name' && typeof event.agentName === 'string' && event.agentName.trim()) {
						foundAgentName = event.agentName.trim();
					} else if (!foundUserLabel && event.type === 'user' && !event.isMeta) {
						foundUserLabel = extractClaudeUserLabel(messageText(event));
					}
				}
				const baseId = path.basename(candidate.file, '.jsonl');
				const effId = foundId ?? ((foundCustomTitle || foundAgentName || foundUserLabel) ? baseId : undefined);
				const effCwd = canonicalProjectCwd ?? foundCwd;
				if (effId && effCwd && !seenIds.has(effId)) {
					seenIds.add(effId);
					sessions.push({
						id: effId,
						cwd: effCwd,
						label: foundCustomTitle || foundAgentName || foundUserLabel || vscode.l10n.t('Claude Session {0}', effId.slice(0, 8)),
						created: candidate.stat.birthtimeMs,
						updated: candidate.stat.mtimeMs,
						file: candidate.file,
						provisional: false,
					});
				}
			} finally { lines.close(); input.destroy(); }
		}
		return sessions;
	}

	async create(cwd: string): Promise<NativeSession> {
		return { id: randomUUID(), cwd, label: vscode.l10n.t('New Claude Code Session'), created: Date.now(), updated: Date.now(), provisional: true };
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		if (this.remoteTarget || session.readOnly || token.isCancellationRequested) { return []; }
		const file = session.file ?? (await this.list(token)).find(item => item.id === session.id)?.file;
		if (!file) { return []; }
		const directory = path.join(path.dirname(file), session.id, 'subagents');
		let entries: string[];
		try { entries = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
		const children: NativeSession[] = [];
		for (const name of entries.filter(name => name.startsWith('agent-') && name.endsWith('.jsonl'))) {
			if (token.isCancellationRequested) { break; }
			const transcript = path.join(directory, name);
			const input = createReadStream(transcript);
			const lines = readline.createInterface({ input, crlfDelay: Infinity });
			try {
				for await (const line of lines) {
					let event: ClaudeEvent;
					try { event = JSON.parse(line) as ClaudeEvent; } catch { continue; }
					if (event.agentId && event.sessionId === session.id && event.cwd) {
						const stat = await fs.stat(transcript);
						let label = messageText(event).split('\n')[0].slice(0, 100) || vscode.l10n.t('Claude Agent {0}', event.agentId);
						try {
							const meta = JSON.parse(await fs.readFile(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as { description?: string; agentType?: string };
							label = meta.description || meta.agentType || label;
						} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) { throw error; } }
						children.push({ id: `${session.id}/${event.agentId}`, parentId: session.id, cwd: event.cwd, label, created: stat.birthtimeMs, updated: stat.mtimeMs, file: transcript, readOnly: true });
						break;
					}
				}
			} finally { lines.close(); input.destroy(); }
		}
		return children;
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (session.provisional && !session.file) { return []; }
		if (this.remoteTarget) {
			const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, '');
			if (this.remoteTarget.os !== 'windows') {
				const pyHistory = [
					`import glob, json, os, sys`,
					`explicit = sys.argv[1]`,
					`sid = sys.argv[2]`,
					`target = explicit if (explicit and os.path.isfile(explicit)) else None`,
					`if not target and sid:`,
					`    cfg = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects")`,
					`    hits = glob.glob(os.path.join(cfg, "*", sid + ".jsonl"))`,
					`    if hits: target = hits[0]`,
					`if not target: sys.exit(2)`,
					`print("__AEX_PATH__:" + target)`,
					`entries = []`,
					`with open(target, "rb") as f:`,
					`    for raw in f:`,
					`        if b'"type":"user"' not in raw and b'"type":"assistant"' not in raw and b'"type": "user"' not in raw and b'"type": "assistant"' not in raw:`,
					`            continue`,
					`        try: ev = json.loads(raw.decode("utf-8", "replace"))`,
					`        except Exception: continue`,
					`        if not isinstance(ev, dict): continue`,
					`        role = ev.get("type")`,
					`        if role not in ("user", "assistant"): continue`,
					`        msg = ev.get("message")`,
					`        content = msg.get("content") if isinstance(msg, dict) else None`,
					`        text = ""`,
					`        if isinstance(content, str): text = content`,
					`        elif isinstance(content, list):`,
					`            text = "\\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str))`,
					`        if text:`,
					`            entries.append({"id": ev.get("uuid"), "role": role, "text": text, "isSystemInitiated": bool(ev.get("isMeta"))})`,
					`for item in entries[-400:]:`,
					`    print("__AEX_HIST__\\t" + json.dumps(item, ensure_ascii=False))`,
				].join('\n');
				const pyRes = await execRemoteShell(
					this.remoteTarget,
					`if command -v python3 >/dev/null 2>&1; then python3 -c ${posixQuote(pyHistory)} ${posixQuote(session.file ?? '')} ${posixQuote(safeId)}; else exit 127; fi`,
					'',
					{ timeoutMs: 25_000, token },
				).catch(() => undefined);
				if (pyRes && pyRes.code === 0) {
					const out: HistoryEntry[] = [];
					for (const line of pyRes.stdout.toString('utf8').split(/\r?\n/)) {
						if (line.startsWith('__AEX_PATH__:')) {
							session.file = line.slice('__AEX_PATH__:'.length).trim() || session.file;
						} else if (line.startsWith('__AEX_HIST__\t')) {
							try {
								const parsed = JSON.parse(line.slice('__AEX_HIST__\t'.length)) as { id?: string; role?: 'user' | 'assistant'; text?: string; isSystemInitiated?: boolean };
								if (parsed.text && (parsed.role === 'user' || parsed.role === 'assistant')) {
									out.push({ id: parsed.id, role: parsed.role, text: parsed.text, isSystemInitiated: parsed.isSystemInitiated || undefined });
								}
							} catch { /* ignore */ }
						}
					}
					return out;
				}
				if (pyRes && pyRes.code === 2) {
					return [];
				}
			}
			if (session.file) {
				const raw = await readRemoteTextFile(this.remoteTarget, session.file, { bypassCache: true, timeoutMs: 20_000, token });
				if (raw !== undefined) {
					return this.parseTranscriptLines(raw.split(/\r?\n/));
				}
			}
			if (!safeId) { return []; }
			const posixScript = `cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"; for f in "$cfg"/*/${posixQuote(`${safeId}.jsonl`)}; do if [ -f "$f" ]; then printf '__AEX_PATH__:%s\\n' "$f"; cat -- "$f"; exit 0; fi; done; exit 2`;
			const winScript = `$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }; $cfg = Join-Path $base 'projects'; $found = Get-ChildItem -LiteralPath $cfg -Recurse -Filter ${psSingleQuote(`${safeId}.jsonl`)} -File -ErrorAction SilentlyContinue | Select-Object -First 1; if ($found) { Write-Output ('__AEX_PATH__:' + $found.FullName); [Console]::Out.Write([IO.File]::ReadAllText($found.FullName, [Text.Encoding]::UTF8)); exit 0 }; exit 2`;
			const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 20_000, token }).catch(() => undefined);
			if (!res || res.code !== 0) {
				return [];
			}
			const allLines = res.stdout.toString('utf8').split(/\r?\n/);
			if (allLines[0]?.startsWith('__AEX_PATH__:')) {
				session.file = allLines[0].slice('__AEX_PATH__:'.length).trim() || session.file;
				allLines.shift();
			}
			return this.parseTranscriptLines(allLines);
		}
		const file = session.file ?? (await this.list(token)).find(item => item.id === session.id)?.file;
		if (!file) { throw new Error(vscode.l10n.t('This Claude Code conversation is no longer available.')); }
		const input = createReadStream(file);
		const lines = readline.createInterface({ input, crlfDelay: Infinity });
		const history: HistoryEntry[] = [];
		try {
			for await (const line of lines) {
				if (token.isCancellationRequested) { break; }
				let event: ClaudeEvent;
				try { event = JSON.parse(line) as ClaudeEvent; } catch { continue; }
				const text = messageText(event);
				if (text && (event.type === 'user' || event.type === 'assistant')) { history.push({ id: event.uuid, role: event.type, text, isSystemInitiated: event.isMeta }); }
			}
		} finally { lines.close(); input.destroy(); }
		return history;
	}

	private mapClaudeThinkingTokens(thinking?: EngineThinkingLevel): string | undefined {
		switch (thinking) {
			case 'off':
			case 'none':
				return '0';
			case 'low':
			case 'minimal':
				return '4096';
			case 'medium':
				return '10000';
			case 'high':
				return '20000';
			case 'xhigh':
			case 'extra-high':
				return '32000';
			case 'max':
				return '31999';
			default:
				return undefined;
		}
	}

	private mapClaudeEffortArg(thinking?: EngineThinkingLevel): string | undefined {
		switch (thinking) {
			case 'minimal':
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
			default:
				return undefined;
		}
	}

	private async resolvePermissionMode(options?: EngineSendOptions): Promise<string | undefined> {
		if (options?.automatedEngineering) {
			return 'bypassPermissions';
		}
		const requested = options?.permissionMode?.trim();
		switch (requested) {
			case 'ask':
			case 'manual':
				return 'default';
			case 'plan':
				return 'plan';
			case 'acceptEdits':
				return 'acceptEdits';
			case 'auto':
				return 'auto';
			case 'bypassPermissions':
			case 'danger-full-access':
			case 'never':
				return 'bypassPermissions';
			default:
				// Full Access (bypassPermissions) by default for local & cloud sessions unless Safe Mode is explicitly selected.
				return isAutonomousModeEnabled() ? 'bypassPermissions' : 'acceptEdits';
		}
	}

	private async buildUserMessage(text: string, attachments?: readonly EngineAttachment[]): Promise<string | ContentPart[]> {
		const fileNotes: string[] = [];
		const images: ContentPart[] = [];
		for (const attachment of attachments ?? []) {
			if (attachment.kind === 'image' && !attachment.remote) {
				try {
					const data = (await fs.readFile(attachment.filePath)).toString('base64');
					if (data) {
						images.push({ type: 'image', source: { type: 'base64', media_type: attachment.mimeType?.trim() || imageMimeType(attachment.filePath), data } });
						continue;
					}
				} catch { /* Fall back to a path reference when the image cannot be read. */ }
			}
			fileNotes.push(attachment.rangeText ? `- ${attachment.filePath} (${attachment.rangeText})` : `- ${attachment.filePath}`);
		}
		const fullText = fileNotes.length ? `${text}\n\n${vscode.l10n.t('Attached files:')}\n${fileNotes.join('\n')}` : text;
		return images.length === 0 ? fullText : [{ type: 'text', text: fullText }, ...images];
	}

	private recordInit(sessionId: string, event: ClaudeEvent): void {
		const previous = this.initBySession.get(sessionId) ?? this.lastInit;
		const slashCommands = stringList(event.slash_commands);
		const skills = skillList(event.skills);
		const agents = stringList(event.agents);
		const mcpServers = mcpServerList(event.mcp_servers);
		const info: ClaudeInitInfo = {
			slashCommands: slashCommands.length ? slashCommands : previous?.slashCommands ?? [],
			skills: skills.length ? skills : previous?.skills ?? [],
			agents: agents.length ? agents : previous?.agents ?? [],
			mcpServers: mcpServers.length ? mcpServers : previous?.mcpServers ?? [],
			model: typeof event.model === 'string' && event.model ? event.model : previous?.model,
			permissionMode: typeof event.permissionMode === 'string' && event.permissionMode ? event.permissionMode : previous?.permissionMode,
		};
		this.initBySession.set(sessionId, info);
		this.lastInit = info;
	}

	private recordUsage(sessionId: string, event: ClaudeEvent): void {
		this.usageBySession.set(sessionId, {
			totalCostUsd: numberOrUndefined(event.total_cost_usd),
			durationMs: numberOrUndefined(event.duration_ms),
			numTurns: numberOrUndefined(event.num_turns),
			inputTokens: numberOrUndefined(event.usage?.input_tokens),
			outputTokens: numberOrUndefined(event.usage?.output_tokens),
			cacheReadInputTokens: numberOrUndefined(event.usage?.cache_read_input_tokens),
			cacheCreationInputTokens: numberOrUndefined(event.usage?.cache_creation_input_tokens),
			updatedAt: Date.now(),
		});
	}

	consumeLastTurnUsage(sessionId: string): EngineTurnTokenUsage | undefined {
		const usage = this.lastTurnUsageBySession.get(sessionId);
		this.lastTurnUsageBySession.delete(sessionId);
		return usage;
	}

	async listConfiguredModels(): Promise<readonly { readonly id: string; readonly label: string }[]> {
		try {
			let rawText: string | undefined;
			if (this.remoteTarget) {
				const posixScript = `f="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; [ -f "$f" ] && cat -- "$f" || exit 2`;
				const winScript = `$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }; $f = Join-Path $base 'settings.json'; if (Test-Path -LiteralPath $f -PathType Leaf) { [Console]::Out.Write([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)) } else { exit 2 }`;
				const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 8000 }).catch(() => undefined);
				rawText = res && res.code === 0 ? res.stdout.toString('utf8') : undefined;
			} else {
				const settingsPath = path.join(this.configDir(), 'settings.json');
				rawText = await fs.readFile(settingsPath, 'utf8');
			}
			if (!rawText) {
				return [];
			}
			const raw = JSON.parse(rawText) as {
				model?: unknown;
				modelPicker?: { options?: Array<{ model?: unknown; label?: unknown }> };
			};
			const out: { id: string; label: string }[] = [];
			const seen = new Set<string>();
			const addModel = (idRaw: unknown, labelRaw?: unknown) => {
				const id = typeof idRaw === 'string' ? idRaw.trim() : '';
				if (!id || seen.has(id)) {
					return;
				}
				seen.add(id);
				const label = typeof labelRaw === 'string' && labelRaw.trim() ? `${labelRaw.trim()} (${id})` : id;
				out.push({ id, label });
			};
			if (Array.isArray(raw.modelPicker?.options)) {
				for (const opt of raw.modelPicker.options) {
					addModel(opt?.model, opt?.label);
				}
			}
			addModel(raw.model);
			return out;
		} catch {
			return [];
		}
	}

	private async resolveModelIdentifier(requestedModel?: string): Promise<string | undefined> {
		const trimmed = requestedModel?.trim();
		if (!trimmed) {
			return undefined;
		}
		const configured = await this.listConfiguredModels();
		if (configured.length === 0) {
			return trimmed;
		}
		const exact = configured.find(m => m.id === trimmed || m.id.toLowerCase() === trimmed.toLowerCase());
		if (exact) {
			return exact.id;
		}
		const lower = trimmed.toLowerCase();
		const byPrefix = configured.find(m => m.id.toLowerCase().startsWith(lower) || m.label.toLowerCase().includes(lower));
		return byPrefix ? byPrefix.id : trimmed;
	}

	private async hasPersistedTranscript(sessionId: string): Promise<boolean> {
		if (this.remoteTarget) {
			const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '');
			if (!safeId) { return false; }
			const posixScript = `for f in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"/*/${posixQuote(`${safeId}.jsonl`)}; do [ -f "$f" ] && exit 0; done; exit 1`;
			const winScript = `$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }; $cfg = Join-Path $base 'projects'; if ((Test-Path -LiteralPath $cfg) -and (Get-ChildItem -LiteralPath $cfg -Recurse -Filter ${psSingleQuote(`${safeId}.jsonl`)} -File -ErrorAction SilentlyContinue | Select-Object -First 1)) { exit 0 }; exit 1`;
			const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 6000 }).catch(() => undefined);
			return Boolean(res && res.code === 0);
		}
		try {
			const projectsRoot = path.join(this.configDir(), 'projects');
			const dirs = await fs.readdir(projectsRoot);
			for (const dir of dirs) {
				try {
					await fs.access(path.join(projectsRoot, dir, `${sessionId}.jsonl`));
					return true;
				} catch { /* check next project dir */ }
			}
		} catch { /* ignore */ }
		return false;
	}

	async killSession(session: NativeSession): Promise<void> {
		const procs = this.runningBySession.get(session.id);
		if (procs) {
			for (const child of procs) {
				stopEngine(child, 'SIGKILL');
			}
			this.runningBySession.delete(session.id);
		}
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			const trackedIds = this.activePersistentIdsBySession.get(session.id);
			this.activePersistentIdsBySession.delete(session.id);
			const prefix = buildRemotePersistentPrefix(this.id, session.id);
			const kills: Promise<void>[] = [
				terminateRemotePersistentSessionsByPrefix(this.remoteTarget, prefix, { killTree: true }),
			];
			if (trackedIds) {
				for (const pid of trackedIds) {
					if (!pid.startsWith(prefix)) {
						kills.push(terminateRemotePersistentSession(this.remoteTarget, pid, { killTree: true }));
					}
				}
			}
			await Promise.all(kills);
		}
	}

	private trackPersistentId(sessionId: string, persistentId: string | undefined): void {
		if (!persistentId) {
			return;
		}
		let set = this.activePersistentIdsBySession.get(sessionId);
		if (!set) {
			set = new Set();
			this.activePersistentIdsBySession.set(sessionId, set);
		}
		set.add(persistentId);
	}

	private untrackPersistentId(sessionId: string, persistentId: string | undefined): void {
		if (!persistentId) {
			return;
		}
		const set = this.activePersistentIdsBySession.get(sessionId);
		if (set) {
			set.delete(persistentId);
			if (set.size === 0) {
				this.activePersistentIdsBySession.delete(sessionId);
			}
		}
	}

	async reattachIfRunning(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<'reattached' | 'not_running'> {
		if (!this.remoteTarget || this.remoteTarget.os === 'windows' || token.isCancellationRequested) {
			return 'not_running';
		}
		const prefix = buildRemotePersistentPrefix(this.id, session.id);
		const candidates = await inspectRemotePersistentSessionsByPrefix(this.remoteTarget, prefix).catch(() => []);
		const liveOrUnread = candidates.find(c => c.alive || c.exitCode !== undefined);
		if (!liveOrUnread) {
			return 'not_running';
		}
		const permissionMode = await this.resolvePermissionMode(options);
		const bypassPermissions = permissionMode === 'bypassPermissions';
		const isAutoEng = Boolean(options?.automatedEngineering);
		const customEnv = await prepareRemoteAgentChildEnv(this.remoteTarget, {
			sessionId: options?.adeSessionId || session.id,
			callerRole: options?.callerRole,
			pureWorker: options?.pureWorker,
			isMissionNode: options?.isMissionNode,
		});
		const outcome = await this.streamPersistentClaudeRun(session, {
			args: [],
			customEnv,
			remotePersistentId: liveOrUnread.id,
			attachOnly: true,
			bypassPermissions,
			isAutoEng,
			stream,
			token,
			options,
		});
		return outcome.sessionMissing ? 'not_running' : 'reattached';
	}

	private async streamPersistentClaudeRun(
		session: NativeSession,
		params: {
			readonly args: string[];
			readonly customEnv: NodeJS.ProcessEnv;
			readonly remotePersistentId?: string;
			readonly attachOnly?: boolean;
			readonly userLinePayload?: string;
			readonly bypassPermissions: boolean;
			readonly isAutoEng: boolean;
			readonly stream: vscode.ChatResponseStream;
			readonly token: vscode.CancellationToken;
			readonly options?: EngineSendOptions;
		},
	): Promise<{ readonly sawResult: boolean; readonly interimUsage?: UsagePayload; readonly sessionMissing?: boolean }> {
		const { args, customEnv, remotePersistentId, attachOnly, userLinePayload, bypassPermissions, isAutoEng, stream, token, options } = params;
		this.trackPersistentId(session.id, remotePersistentId);
		let errorText = '';
		let resultError: string | undefined;
		let wroteText = false;
		let sawThinkingDelta = false;
		let sawResult = false;
		let sessionMissing = false;
		let interimUsage: UsagePayload | undefined;
		let lastInterimReportAt = 0;
		let lastInterimReportedTotal = 0;
		let stdoutBytesReceived = 0;
		let activeChild: ReturnType<typeof spawnEngine> | undefined;
		const seenToolUses = new Set<string>();

		const maxAttachAttempts = remotePersistentId ? REMOTE_REATTACH_BACKOFFS_MS.length + 1 : 1;
		try {
			for (let attachAttempt = 0; attachAttempt < maxAttachAttempts; attachAttempt++) {
				const isReattach = attachAttempt > 0 || Boolean(attachOnly);
				const child = spawnEngine(
					this.executable,
					args,
					session.cwd,
					customEnv,
					this.remoteTarget,
					remotePersistentId
						? {
							persistentSessionId: remotePersistentId,
							attachByteOffset: stdoutBytesReceived,
							...(isReattach ? { attachOnly: true } : {}),
						}
						: undefined,
				);
				activeChild = child;
				this.running.add(child);
				let sessionSet = this.runningBySession.get(session.id);
				if (!sessionSet) {
					sessionSet = new Set();
					this.runningBySession.set(session.id, sessionSet);
				}
				sessionSet.add(child);

				// Track exact UTF-8 bytes of COMPLETE newline-delimited lines only so reattaching after
				// a mid-line SSH cut starts cleanly at byte 0 of the interrupted JSON line without losing events.
				let stdoutByteCarry: Buffer = Buffer.alloc(0);
				const handleLine = (line: string) => {
					let event: ClaudeEvent;
					try { event = JSON.parse(line) as ClaudeEvent; } catch { return; }
					const fromChild = typeof event.parent_tool_use_id === 'string';
					if (!fromChild && event.type === 'system' && event.subtype === 'init') {
						session.provisional = false;
						this.recordInit(session.id, event);
					}
					if (!fromChild && (
						(event.type === 'system' && (event.subtype === 'compact_boundary' || event.subtype === 'context_compacted'))
						|| event.type === 'compact_boundary'
						|| event.type === 'context_compacted'
					)) {
						try {
							options?.onContextCompacted?.();
						} catch { /* Compaction callback must never break the turn. */ }
					}
					if (!fromChild && !token.isCancellationRequested && event.type === 'stream_event') {
						const delta = event.event?.delta;
						if (delta?.type === 'text_delta' && delta.text) {
							wroteText = true;
							stream.markdown(delta.text);
						}
						if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
							sawThinkingDelta = true;
							emitThinkingProgress(stream, delta.thinking, 'claude-thinking');
						}
						const block = event.event?.content_block;
						if (block?.type === 'tool_use' && block.name && block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0) {
							const key = block.id ?? `${block.name}:${seenToolUses.size}`;
							if (!seenToolUses.has(key)) {
								seenToolUses.add(key);
								stream.progress(toolProgressText(block.name, block.input));
							}
						}
					}
					if (!fromChild && !token.isCancellationRequested && event.type === 'assistant') {
						const assistantUsage = event.message?.usage;
						if (assistantUsage) {
							interimUsage = assistantUsage;
							const onInterimUsage = options?.onInterimUsage;
							if (onInterimUsage) {
								const snapshot = turnUsageFromPayload(assistantUsage);
								const now = Date.now();
								if (snapshot.totalTokens > lastInterimReportedTotal && now - lastInterimReportAt >= 1000) {
									lastInterimReportAt = now;
									lastInterimReportedTotal = snapshot.totalTokens;
									try {
										onInterimUsage(snapshot);
									} catch { /* Live usage reporting must never break the turn. */ }
								}
							}
						}
						const content = event.message?.content;
						if (Array.isArray(content)) {
							for (const block of content) {
								if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking && !sawThinkingDelta) {
									emitThinkingProgress(stream, block.thinking, 'claude-thinking');
								}
								if (block.type === 'tool_use' && block.name) {
									const key = block.id ?? `${block.name}:${JSON.stringify(block.input ?? {})}`;
									if (!seenToolUses.has(key)) {
										seenToolUses.add(key);
										stream.progress(toolProgressText(block.name, block.input));
									}
								}
							}
						}
						if (!wroteText) { const msg = messageText(event); if (msg) { stream.markdown(msg); } }
					}
					if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
						const request = event.request;
						if (bypassPermissions || isAutoEng || isSafeAdeOrchestratorToolCall(options?.callerRole, request.tool_name, request.input)) {
							if (!child.stdin.destroyed) {
								child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: request.input } } }) + '\n');
							}
							return;
						}
						const allow = vscode.l10n.t('Allow Once');
						void vscode.window.showQuickPick([allow, vscode.l10n.t('Deny')], { title: vscode.l10n.t('Claude Code requests permission'), placeHolder: `${session.cwd}: ${request.tool_name}: ${JSON.stringify(request.input)}`, ignoreFocusOut: true }, token).then(result => {
							const targetChild = activeChild;
							if (targetChild && !targetChild.stdin.destroyed) {
								targetChild.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: result === allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: vscode.l10n.t('Denied by the user.') } } }) + '\n');
							}
						});
					}
					if (!fromChild && event.type === 'result') {
						sawResult = true;
						this.recordUsage(session.id, event);
						this.lastTurnUsageBySession.set(session.id, turnUsageFromPayload(event.usage, numberOrUndefined(event.duration_ms), numberOrUndefined(event.total_cost_usd)));
						if (event.is_error) { resultError = event.result || vscode.l10n.t('Claude Code could not complete this request.'); }
						if (!event.is_error) { session.provisional = false; }
						child.stdin.end();
						if (remotePersistentId && this.remoteTarget) {
							// Graceful turn completion: stop Claude process only so intentionally detached
							// background jobs (e.g. `token block --watch-pid`) remain alive!
							void terminateRemotePersistentSession(this.remoteTarget, remotePersistentId, { killTree: false }).catch(() => undefined);
						}
					}
				};
				child.stdout.on('data', (chunk: Buffer | string) => {
					const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
					stdoutByteCarry = stdoutByteCarry.length > 0 ? Buffer.concat([stdoutByteCarry, buf]) : buf;
					let nlIdx: number;
					while ((nlIdx = stdoutByteCarry.indexOf(0x0a)) >= 0) {
						const lineBuf = stdoutByteCarry.subarray(0, nlIdx);
						stdoutByteCarry = stdoutByteCarry.subarray(nlIdx + 1);
						stdoutBytesReceived += nlIdx + 1;
						const rawLine = lineBuf.toString('utf8');
						handleLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
					}
				});
				child.stderr.on('data', data => errorText = (errorText + String(data)).slice(-8000));
				const stopChild = () => {
					stopEngineWithFallback(child, 'SIGINT', 1500);
					if (remotePersistentId && this.remoteTarget) {
						// Explicit cancellation / recall / stop: obliterate ENTIRE remote process group + descendants!
						void terminateRemotePersistentSession(this.remoteTarget, remotePersistentId, { killTree: true }).catch(() => undefined);
					}
				};
				const cancellation = token.onCancellationRequested(stopChild);
				if (token.isCancellationRequested) {
					stopChild();
				} else if (!isReattach && userLinePayload) {
					child.stdin.write(userLinePayload);
				}
				let closeCode: number | null = null;
				try {
					await raceWithCancellation(
						new Promise<void>((resolve, reject) => {
							child.on('error', reject);
							child.on('close', code => {
								closeCode = code;
								if (token.isCancellationRequested || sawResult) {
									if (resultError && !token.isCancellationRequested) {
										reject(new Error(resultError));
									} else {
										resolve();
									}
									return;
								}
								if (attachOnly && code === 44) {
									if (!sawResult) {
										sessionMissing = true;
									}
									resolve();
									return;
								}
								if (remotePersistentId && code === 255 && attachAttempt + 1 < maxAttachAttempts) {
									resolve();
									return;
								}
								if (resultError || code !== 0) {
									reject(new Error(resultError || errorText || vscode.l10n.t('Claude Code exited with code {0}.', String(code))));
								} else {
									resolve();
								}
							});
						}),
						token,
						2500,
						stopChild,
					).catch(err => {
						if (token.isCancellationRequested || err instanceof vscode.CancellationError) {
							stopEngine(child, 'SIGKILL');
							return;
						}
						throw err;
					});
				} finally {
					cancellation.dispose();
					if (stdoutByteCarry.length > 0 && closeCode === 0) {
						const tailLine = stdoutByteCarry.toString('utf8');
						stdoutBytesReceived += stdoutByteCarry.length;
						stdoutByteCarry = Buffer.alloc(0);
						handleLine(tailLine.endsWith('\r') ? tailLine.slice(0, -1) : tailLine);
					}
					this.running.delete(child);
					sessionSet.delete(child);
					if (sessionSet.size === 0) {
						this.runningBySession.delete(session.id);
					}
				}
				if (sawResult || token.isCancellationRequested || closeCode === 0 || (attachOnly && closeCode === 44) || !remotePersistentId || closeCode !== 255 || attachAttempt + 1 >= maxAttachAttempts) {
					break;
				}
				const backoffMs = REMOTE_REATTACH_BACKOFFS_MS[attachAttempt] ?? 60_000;
				stream.progress(vscode.l10n.t('SSH connection interrupted; reattaching to persistent remote Claude session…'));
				await waitForBackoffOrResume(backoffMs, token);
				if (token.isCancellationRequested) {
					break;
				}
				await healAllRemoteControlBridges().catch(() => undefined);
			}
		} finally {
			this.untrackPersistentId(session.id, remotePersistentId);
		}
		return { sawResult, interimUsage, sessionMissing };
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		const requestedModel = options?.model?.trim();
		const resolvedModel = requestedModel && requestedModel !== 'default' ? await this.resolveModelIdentifier(requestedModel) : undefined;
		const permissionMode = await this.resolvePermissionMode(options);
		const userMessage = await this.buildUserMessage(text, options?.attachments);
		if (token.isCancellationRequested) {
			return;
		}
		if (session.provisional && await this.hasPersistedTranscript(session.id)) {
			session.provisional = false;
		}

		const runOnce = async (useModelOverride: boolean, forceResume = false): Promise<void> => {
			if (token.isCancellationRequested) {
				return;
			}
			const useResume = forceResume || !session.provisional;
			const isAutoEng = Boolean(options?.automatedEngineering);
			const effortArg = this.mapClaudeEffortArg(options?.thinking);
			const bypassPermissions = permissionMode === 'bypassPermissions';
			const args = [
				'--print', '--verbose',
				'--input-format', 'stream-json',
				'--output-format', 'stream-json',
				'--include-partial-messages',
				...(permissionMode ? ['--permission-mode', permissionMode] : []),
				...(bypassPermissions ? ['--permission-prompts', 'none'] : ['--permission-prompts', 'host']),
				...(useModelOverride && resolvedModel ? ['--model', resolvedModel] : []),
				...(effortArg ? ['--effort', effortArg] : []),
				useResume ? '--resume' : '--session-id',
				session.id,
			];
			const thinkingTokens = this.mapClaudeThinkingTokens(options?.thinking);
			const customEnv: NodeJS.ProcessEnv = this.remoteTarget
				? await prepareRemoteAgentChildEnv(this.remoteTarget, {
					sessionId: options?.adeSessionId || session.id,
					callerRole: options?.callerRole,
					pureWorker: options?.pureWorker,
					isMissionNode: options?.isMissionNode,
				})
				: await prepareAgentChildEnv({
					sessionId: options?.adeSessionId || session.id,
					callerRole: options?.callerRole,
					pureWorker: options?.pureWorker,
					isMissionNode: options?.isMissionNode,
				});
			if (thinkingTokens !== undefined) {
				customEnv.MAX_THINKING_TOKENS = thinkingTokens;
			}
			if (options?.thinking === 'off' || options?.thinking === 'none') {
				customEnv.CLAUDE_CODE_DISABLE_THINKING = '1';
			}

			const remotePersistentId = this.remoteTarget && this.remoteTarget.os !== 'windows'
				? `${buildRemotePersistentPrefix(this.id, session.id)}-${randomUUID().slice(0, 8)}`
				: undefined;
			const userLinePayload = JSON.stringify({ type: 'user', session_id: session.id, parent_tool_use_id: null, message: { role: 'user', content: userMessage } }) + '\n';
			const { sawResult, interimUsage } = await this.streamPersistentClaudeRun(session, {
				args,
				customEnv,
				remotePersistentId,
				userLinePayload,
				bypassPermissions,
				isAutoEng,
				stream,
				token,
				options,
			});
			if (!sawResult && interimUsage) {
				const fallbackUsage = turnUsageFromPayload(interimUsage);
				if (fallbackUsage.totalTokens > 0) {
					this.lastTurnUsageBySession.set(session.id, fallbackUsage);
				}
			}
		};

		try {
			await runOnce(Boolean(resolvedModel));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (/already in use|already exists/i.test(msg)) {
				session.provisional = false;
				await runOnce(Boolean(resolvedModel), true);
				return;
			}
			if (resolvedModel && /(?:unknown|invalid|unsupported)[ _-]*model|model.*(?:not[ _-]?found|does not exist)/i.test(msg)) {
				stream.progress(vscode.l10n.t('Model "{0}" was rejected by Claude Code; retrying with default model…', resolvedModel));
				await runOnce(false);
				return;
			}
			throw error;
		}
	}

	async getRuntimeCapabilities(_cwd: string, session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		const sessionInit = session ? this.initBySession.get(session.id) : undefined;
		const init = sessionInit ?? this.lastInit;
		const commands: Array<{ name: string; description?: string }> = [];
		const seen = new Set<string>();
		const addCommand = (rawName: string, description?: string) => {
			const name = rawName.replace(/^\/+/, '').trim();
			if (name && !seen.has(name)) {
				seen.add(name);
				commands.push(description ? { name, description } : { name });
			}
		};
		for (const name of init?.slashCommands ?? []) {
			addCommand(name);
		}
		for (const skill of init?.skills ?? []) {
			addCommand(skill.name, skill.description);
		}
		const models: Array<{ id: string; name: string; description?: string }> = [];
		const seenModels = new Set<string>();
		for (const model of await this.listConfiguredModels()) {
			if (!seenModels.has(model.id)) {
				seenModels.add(model.id);
				models.push({ id: model.id, name: model.label });
			}
		}
		if (sessionInit?.model && !seenModels.has(sessionInit.model)) {
			models.push({ id: sessionInit.model, name: sessionInit.model });
		}
		return { commands, models };
	}

	async executeCommand(session: NativeSession, command: string, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<boolean> {
		if (token.isCancellationRequested) {
			return true;
		}
		const name = command.replace(/^\/+/, '').trim().toLowerCase();
		switch (name) {
			case 'cost':
			case 'usage':
			case 'context':
				this.renderUsage(session, stream, options, name === 'context');
				return true;
			case 'mcp':
				await this.renderMcp(session, stream);
				return true;
			case 'memory':
				if (argsText.trim()) {
					return false;
				}
				await this.renderMemory(session, stream);
				return true;
			case 'doctor':
				await this.renderDoctor(session, stream, token);
				return true;
			case 'agents':
				await this.renderAgents(session, stream);
				return true;
			case 'config':
				this.renderConfig(session, stream, options);
				return true;
			default:
				// Prompt/skill commands ('init', 'compact', 'review', 'security-review', 'verify', 'debug',
				// 'simplify', 'deep-research', 'recap', 'loop', …) run on Claude itself.
				return false;
		}
	}

	private renderUsage(session: NativeSession, stream: vscode.ChatResponseStream, options: EngineSendOptions | undefined, includeContext: boolean): void {
		const usage = this.usageBySession.get(session.id);
		const init = this.initBySession.get(session.id) ?? this.lastInit;
		const model = options?.model?.trim() && options.model.trim() !== 'default' ? options.model.trim() : init?.model;
		const rows: Array<[string, string]> = [];
		rows.push([vscode.l10n.t('Model'), model ?? vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Effort'), options?.thinking ?? vscode.l10n.t('Default')]);
		rows.push([vscode.l10n.t('Permission mode'), options?.permissionMode ?? init?.permissionMode ?? (isAutonomousModeEnabled() ? 'bypassPermissions' : 'acceptEdits')]);
		rows.push([vscode.l10n.t('Session'), session.id]);
		rows.push([vscode.l10n.t('Turns'), usage?.numTurns !== undefined ? String(usage.numTurns) : vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Duration'), usage?.durationMs !== undefined ? `${(usage.durationMs / 1000).toFixed(1)}s` : vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Total cost'), usage?.totalCostUsd !== undefined ? `$${usage.totalCostUsd.toFixed(4)}` : vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Input tokens'), usage?.inputTokens !== undefined ? usage.inputTokens.toLocaleString() : vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Output tokens'), usage?.outputTokens !== undefined ? usage.outputTokens.toLocaleString() : vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Cache read tokens'), usage?.cacheReadInputTokens !== undefined ? usage.cacheReadInputTokens.toLocaleString() : vscode.l10n.t('Not reported yet')]);
		rows.push([vscode.l10n.t('Cache write tokens'), usage?.cacheCreationInputTokens !== undefined ? usage.cacheCreationInputTokens.toLocaleString() : vscode.l10n.t('Not reported yet')]);
		if (includeContext) {
			rows.push([vscode.l10n.t('Context window'), contextWindowLabel(model)]);
			rows.push([vscode.l10n.t('Context used'), usage?.inputTokens !== undefined ? vscode.l10n.t('{0} input tokens in the last turn', usage.inputTokens.toLocaleString()) : vscode.l10n.t('Not reported yet')]);
		}
		stream.markdown(`${nameOfUsageReport(includeContext)}\n\n`);
		stream.markdown(`| ${vscode.l10n.t('Metric')} | ${vscode.l10n.t('Value')} |\n| --- | --- |\n`);
		for (const [metric, value] of rows) {
			stream.markdown(`| ${escapeTableCell(metric)} | ${escapeTableCell(value)} |\n`);
		}
		if (!usage) {
			stream.markdown(`\n${vscode.l10n.t('No usage has been recorded for this session yet. Send a message first.')}`);
		}
	}

	private async renderMcp(session: NativeSession, stream: vscode.ChatResponseStream): Promise<void> {
		const sources = this.remoteTarget
			? [
				{ label: vscode.l10n.t('Project .mcp.json'), file: joinRemotePath(this.remoteTarget.os, session.cwd, '.mcp.json') },
				...(this.remoteTarget.remoteHome ? [
					{ label: vscode.l10n.t('User ~/.claude.json'), file: joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.claude.json') },
					{ label: vscode.l10n.t('User settings.json'), file: joinRemotePath(this.remoteTarget.os, this.remoteHomePrefix(), 'settings.json') },
				] : []),
			]
			: [
				{ label: vscode.l10n.t('Project .mcp.json'), file: path.join(session.cwd, '.mcp.json') },
				{ label: vscode.l10n.t('User ~/.claude.json'), file: path.join(os.homedir(), '.claude.json') },
				{ label: vscode.l10n.t('User settings.json'), file: path.join(this.configDir(), 'settings.json') },
			];
		const rows: Array<[string, string, string]> = [];
		for (const source of sources) {
			const json = await this.readJsonObject(source.file);
			const servers = json?.mcpServers;
			if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
				continue;
			}
			for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
				const server = value && typeof value === 'object' ? value as Record<string, unknown> : {};
				const type = typeof server.type === 'string' ? server.type : typeof server.url === 'string' ? 'http' : typeof server.command === 'string' ? 'stdio' : vscode.l10n.t('unknown');
				rows.push([source.label, name, type]);
			}
		}
		stream.markdown(`### ${vscode.l10n.t('MCP servers')}\n\n`);
		if (rows.length === 0) {
			stream.markdown(`${vscode.l10n.t('No MCP servers are configured in the checked configuration files.')}\n`);
		} else {
			stream.markdown(`| ${vscode.l10n.t('Source')} | ${vscode.l10n.t('Server')} | ${vscode.l10n.t('Type')} |\n| --- | --- | --- |\n`);
			for (const [source, name, type] of rows) {
				stream.markdown(`| ${escapeTableCell(source)} | ${escapeTableCell(name)} | ${escapeTableCell(type)} |\n`);
			}
		}
		const init = this.initBySession.get(session.id) ?? this.lastInit;
		if (init?.mcpServers.length) {
			stream.markdown(`\n**${vscode.l10n.t('Last reported by Claude')}**\n\n`);
			for (const server of init.mcpServers) {
				stream.markdown(`- ${escapeTableCell(server.name)}${server.status ? ` — ${escapeTableCell(server.status)}` : ''}\n`);
			}
		}
	}

	private async renderMemory(session: NativeSession, stream: vscode.ChatResponseStream): Promise<void> {
		const files = this.remoteTarget
			? [
				joinRemotePath(this.remoteTarget.os, session.cwd, 'CLAUDE.md'),
				joinRemotePath(this.remoteTarget.os, session.cwd, '.claude', 'CLAUDE.md'),
				...(this.remoteTarget.remoteHome ? [joinRemotePath(this.remoteTarget.os, this.remoteHomePrefix(), 'CLAUDE.md')] : []),
			]
			: [
				path.join(session.cwd, 'CLAUDE.md'),
				path.join(session.cwd, '.claude', 'CLAUDE.md'),
				path.join(this.configDir(), 'CLAUDE.md'),
			];
		const rows: string[] = [];
		for (const file of files) {
			try {
				const content = this.remoteTarget
					? await readRemoteTextFile(this.remoteTarget, file)
					: await fs.readFile(file, 'utf8');
				if (content === undefined) {
					continue;
				}
				const size = Buffer.byteLength(content, 'utf8');
				const excerpt = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).slice(0, 3).join(' ').slice(0, 240);
				const label = this.remoteTarget ? `\`${file}\`` : `[${file}](${vscode.Uri.file(file).toString()})`;
				rows.push(`- ${label} — ${size.toLocaleString()} bytes${excerpt ? ` — ${escapeTableCell(excerpt)}` : ''}`);
			} catch { /* Missing memory files are expected. */ }
		}
		stream.markdown(`### ${vscode.l10n.t('Claude memory files')}\n\n`);
		if (rows.length === 0) {
			stream.markdown(`${vscode.l10n.t('No CLAUDE.md memory files were found for this project or user.')}\n`);
		} else {
			stream.markdown(`${rows.join('\n')}\n`);
		}
		stream.markdown(`\n${vscode.l10n.t('Run `/memory` with instructions to have Claude update its memory.')}`);
	}

	private async renderDoctor(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		stream.markdown(`### ${vscode.l10n.t('Claude Code doctor')}\n\n`);
		const check = async (label: string, probe: () => Promise<string | undefined>): Promise<void> => {
			try {
				const detail = await probe();
				stream.markdown(`- ✅ ${escapeTableCell(label)}${detail ? ` — ${escapeTableCell(detail)}` : ''}\n`);
			} catch (error) {
				stream.markdown(`- ⚠️ ${escapeTableCell(label)} — ${escapeTableCell(error instanceof Error ? error.message : String(error))}\n`);
			}
		};
		await check(vscode.l10n.t('Executable'), async () => {
			if (this.remoteTarget) {
				return `${this.executable} (${this.remoteTarget.alias})`;
			}
			await fs.access(this.executable);
			return this.executable;
		});
		await check(vscode.l10n.t('Version'), async () => (await capture(this.executable, ['--version'], token, session.cwd, undefined, this.remoteTarget)).trim().split('\n')[0]);
		const configDir = this.configDir();
		await check(vscode.l10n.t('Settings'), async () => {
			if (this.remoteTarget) {
				const remoteHome = this.remoteTarget.remoteHome;
				const base = remoteHome ? joinRemotePath(this.remoteTarget.os, remoteHome, '.claude') : undefined;
				if (!base) {
					return vscode.l10n.t('remote home unknown');
				}
				const batch = await readRemoteTextFilesBatch(this.remoteTarget, [
					joinRemotePath(this.remoteTarget.os, base, 'settings.json'),
					joinRemotePath(this.remoteTarget.os, base, 'settings.local.json'),
				]).catch(() => new Map<string, string | undefined>());
				const found = [...batch.entries()].filter(([, v]) => v !== undefined).map(([p]) => path.posix.basename(p.replace(/\\/g, '/')));
				return found.length ? found.join(', ') : vscode.l10n.t('none found');
			}
			const files = [path.join(configDir, 'settings.json'), path.join(configDir, 'settings.local.json')];
			const found: string[] = [];
			for (const file of files) {
				try {
					await fs.access(file);
					found.push(path.basename(file));
				} catch { /* Report the ones that exist. */ }
			}
			return found.length ? found.join(', ') : vscode.l10n.t('none found');
		});
		await check(vscode.l10n.t('MCP configuration'), async () => {
			const found: string[] = [];
			if (this.remoteTarget) {
				const remoteFiles = [joinRemotePath(this.remoteTarget.os, session.cwd, '.mcp.json')];
				if (this.remoteTarget.remoteHome) {
					remoteFiles.push(joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.claude.json'));
				}
				const batch = await readRemoteTextFilesBatch(this.remoteTarget, remoteFiles).catch(() => new Map<string, string | undefined>());
				for (const [file, content] of batch.entries()) {
					if (content !== undefined) {
						found.push(file);
					}
				}
			} else {
				const files = [path.join(session.cwd, '.mcp.json'), path.join(os.homedir(), '.claude.json')];
				for (const file of files) {
					try {
						await fs.access(file);
						found.push(file);
					} catch { /* Report the ones that exist. */ }
				}
			}
			const init = this.initBySession.get(session.id) ?? this.lastInit;
			if (init?.mcpServers.length) {
				found.push(vscode.l10n.t('{0} server(s) at last init', String(init.mcpServers.length)));
			}
			return found.length ? found.join(', ') : vscode.l10n.t('none found');
		});
		const init = this.initBySession.get(session.id) ?? this.lastInit;
		await check(vscode.l10n.t('Session initialization'), async () => init
			? vscode.l10n.t('{0} commands, {1} skills, {2} agents reported', String(init.slashCommands.length), String(init.skills.length), String(init.agents.length))
			: vscode.l10n.t('not reported yet'));
	}

	private async renderAgents(session: NativeSession, stream: vscode.ChatResponseStream): Promise<void> {
		const init = this.initBySession.get(session.id) ?? this.lastInit;
		stream.markdown(`### ${vscode.l10n.t('Claude agents')}\n\n`);
		const reported = init?.agents ?? [];
		stream.markdown(`**${vscode.l10n.t('Reported by Claude')}**\n\n`);
		stream.markdown(reported.length ? reported.map(agent => `- ${escapeTableCell(agent)}`).join('\n') + '\n' : `${vscode.l10n.t('None reported yet. Send a message first.')}\n`);
		if (this.remoteTarget) {
			return;
		}
		const directories = [path.join(session.cwd, '.claude', 'agents'), path.join(this.configDir(), 'agents')];
		const custom: string[] = [];
		for (const directory of directories) {
			let entries: string[];
			try {
				entries = (await fs.readdir(directory)).filter(name => name.endsWith('.md'));
			} catch {
				continue;
			}
			for (const entry of entries.sort()) {
				const file = path.join(directory, entry);
				let description: string | undefined;
				try {
					const content = await fs.readFile(file, 'utf8');
					description = /^---\s*\n[\s\S]*?^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
				} catch { /* Missing or unreadable agent files are skipped. */ }
				custom.push(`- [${entry}](${vscode.Uri.file(file).toString()})${description ? ` — ${escapeTableCell(description)}` : ''}`);
			}
		}
		stream.markdown(`\n**${vscode.l10n.t('Custom agent files')}**\n\n`);
		stream.markdown(custom.length ? custom.join('\n') + '\n' : `${vscode.l10n.t('No custom agents were found in .claude/agents.')}\n`);
	}

	private renderConfig(session: NativeSession, stream: vscode.ChatResponseStream, options: EngineSendOptions | undefined): void {
		const init = this.initBySession.get(session.id) ?? this.lastInit;
		const model = options?.model?.trim() && options.model.trim() !== 'default' ? options.model.trim() : init?.model;
		const rows: Array<[string, string]> = [
			[vscode.l10n.t('Model'), model ?? vscode.l10n.t('Claude default')],
			[vscode.l10n.t('Thinking'), options?.thinking ?? vscode.l10n.t('Default')],
			[vscode.l10n.t('Permission mode'), options?.permissionMode ?? init?.permissionMode ?? vscode.l10n.t('Configured')],
			[vscode.l10n.t('Working directory'), session.cwd],
			[vscode.l10n.t('Session ID'), session.id],
			[vscode.l10n.t('State'), session.provisional ? vscode.l10n.t('Provisional') : vscode.l10n.t('Started')],
		];
		stream.markdown(`### ${vscode.l10n.t('Claude session configuration')}\n\n| ${vscode.l10n.t('Setting')} | ${vscode.l10n.t('Value')} |\n| --- | --- |\n`);
		for (const [setting, value] of rows) {
			stream.markdown(`| ${escapeTableCell(setting)} | ${escapeTableCell(value)} |\n`);
		}
	}

	private async readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
		try {
			const raw = this.remoteTarget
				? await readRemoteTextFile(this.remoteTarget, file)
				: await fs.readFile(file, 'utf8');
			if (!raw) {
				return undefined;
			}
			const value: unknown = JSON.parse(raw);
			return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (this.remoteTarget) {
			const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, '');
			if (!safeId) { return; }
			const posixParts = [
				session.file ? `rm -f -- ${posixQuote(session.file)}` : '',
				`cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"`,
				`for f in "$cfg"/projects/*/${posixQuote(`${safeId}.jsonl`)}; do [ -e "$f" ] && rm -f -- "$f"; done`,
				`for d in "$cfg"/projects/*/${posixQuote(safeId)}; do [ -d "$d" ] && rm -rf -- "$d"; done`,
				`rm -rf -- "$cfg/session-env/${safeId}" "$cfg/file-history/${safeId}"`,
			].filter(Boolean).join('\n');
			const winParts = [
				`$base = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }`,
				session.file ? `Remove-Item -LiteralPath ${psSingleQuote(session.file)} -Force -ErrorAction SilentlyContinue` : '',
				`$proj = Join-Path $base 'projects'; if (Test-Path -LiteralPath $proj) { Get-ChildItem -LiteralPath $proj -Directory -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath (Join-Path $_.FullName ${psSingleQuote(`${safeId}.jsonl`)}) -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath (Join-Path $_.FullName ${psSingleQuote(safeId)}) -Recurse -Force -ErrorAction SilentlyContinue } }`,
				`Remove-Item -LiteralPath (Join-Path $base ${psSingleQuote(`session-env\\${safeId}`)}) -Recurse -Force -ErrorAction SilentlyContinue`,
				`Remove-Item -LiteralPath (Join-Path $base ${psSingleQuote(`file-history\\${safeId}`)}) -Recurse -Force -ErrorAction SilentlyContinue`,
			].filter(Boolean).join('; ');
			await execRemoteShell(this.remoteTarget, posixParts, winParts, { timeoutMs: 12_000, token }).catch(() => undefined);
			return;
		}
		if (session.readOnly && session.file) {
			await fs.rm(session.file, { force: true });
			await fs.rm(session.file.replace(/\.jsonl$/, '.meta.json'), { force: true });
			return;
		}
		const file = session.file ?? (!session.provisional ? (await this.list(token)).find(item => item.id === session.id)?.file : undefined);
		if (file) {
			await fs.rm(file, { force: true });
			await fs.rm(path.join(path.dirname(file), session.id), { recursive: true, force: true });
		}
		const configDir = this.configDir();
		await fs.rm(path.join(configDir, 'session-env', session.id), { recursive: true, force: true });
		await fs.rm(path.join(configDir, 'file-history', session.id), { recursive: true, force: true });
	}

	dispose(): void {
		for (const child of this.running) { stopEngine(child); }
		this.running.clear();
		this.runningBySession.clear();
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			for (const set of this.activePersistentIdsBySession.values()) {
				for (const pid of set) {
					void terminateRemotePersistentSession(this.remoteTarget, pid, { killTree: true }).catch(() => undefined);
				}
			}
		}
		this.activePersistentIdsBySession.clear();
	}
}
