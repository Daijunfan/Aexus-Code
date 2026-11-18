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
import { capture, emitThinkingProgress, EngineAttachment, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineThinkingLevel, EngineTurnTokenUsage, HistoryEntry, NativeSession, spawnEngine, stopEngine } from './runtime';

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
	if (callerRole !== 'secretary' && callerRole !== 'governor' && callerRole !== 'manager' && callerRole !== 'employee') {
		return false;
	}
	if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') {
		return true;
	}
	const input = (rawInput ?? {}) as Record<string, unknown>;
	if (toolName === 'Write' || toolName === 'Edit') {
		const fp = typeof input.file_path === 'string' ? input.file_path : '';
		return fp.startsWith('/tmp/') || fp.startsWith('/private/tmp/') || fp.startsWith(os.tmpdir());
	}
	if (toolName === 'Bash') {
		const cmd = typeof input.command === 'string' ? input.command.trim() : '';
		return /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*aexus-ade(?:\s|$)/.test(cmd);
	}
	return false;
}

export class ClaudeRuntime implements EngineRuntime {
	readonly id = 'claude';
	readonly name = 'Claude Code';
	private readonly running = new Set<ReturnType<typeof spawnEngine>>();
	private readonly runningBySession = new Map<string, Set<ReturnType<typeof spawnEngine>>>();
	private readonly initBySession = new Map<string, ClaudeInitInfo>();
	private readonly usageBySession = new Map<string, ClaudeUsageStats>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private lastInit: ClaudeInitInfo | undefined;
	constructor(private readonly executable: string) { }

	private configDir(): string {
		return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	}

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		const projects = path.join(this.configDir(), 'projects');
		let directories: string[];
		try { directories = await fs.readdir(projects); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
		const candidates = (await Promise.all(directories.map(async directory => {
			const folder = path.join(projects, directory);
			try {
				return await Promise.all((await fs.readdir(folder)).filter(name => name.endsWith('.jsonl')).map(async name => ({ file: path.join(folder, name), stat: await fs.stat(path.join(folder, name)) })));
			} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') { return []; } throw error; }
		}))).flat().sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
		const sessions: NativeSession[] = [];
		for (const candidate of candidates) {
			if (token.isCancellationRequested) { break; }
			const input = createReadStream(candidate.file);
			const lines = readline.createInterface({ input, crlfDelay: Infinity });
			try {
				let count = 0;
				for await (const line of lines) {
					let event: ClaudeEvent;
					try { event = JSON.parse(line) as ClaudeEvent; } catch { continue; }
					if (event.cwd && event.sessionId) {
						sessions.push({ id: event.sessionId, cwd: event.cwd, label: messageText(event).split('\n')[0].slice(0, 100) || vscode.l10n.t('Claude Session {0}', event.sessionId.slice(0, 8)), created: candidate.stat.birthtimeMs, updated: candidate.stat.mtimeMs, file: candidate.file, provisional: false });
						break;
					}
					if (++count >= 100) { break; }
				}
			} finally { lines.close(); input.destroy(); }
		}
		return sessions;
	}

	async create(cwd: string): Promise<NativeSession> {
		return { id: randomUUID(), cwd, label: vscode.l10n.t('New Claude Code Session'), created: Date.now(), updated: Date.now(), provisional: true };
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		if (session.readOnly || token.isCancellationRequested) { return []; }
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
			default:
				// Highest permissions by default across all Aexus sessions unless the user explicitly selected Ask/Plan/Auto-Edit/Auto.
				return 'bypassPermissions';
		}
	}

	private async buildUserMessage(text: string, attachments?: readonly EngineAttachment[]): Promise<string | ContentPart[]> {
		const fileNotes: string[] = [];
		const images: ContentPart[] = [];
		for (const attachment of attachments ?? []) {
			if (attachment.kind === 'image') {
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
			const settingsPath = path.join(this.configDir(), 'settings.json');
			const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
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
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		const requestedModel = options?.model?.trim();
		const resolvedModel = requestedModel && requestedModel !== 'default' ? await this.resolveModelIdentifier(requestedModel) : undefined;
		const permissionMode = await this.resolvePermissionMode(options);
		const userMessage = await this.buildUserMessage(text, options?.attachments);
		if (session.provisional && await this.hasPersistedTranscript(session.id)) {
			session.provisional = false;
		}

		const runOnce = async (useModelOverride: boolean, forceResume = false): Promise<void> => {
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
			const customEnv: NodeJS.ProcessEnv = { ...process.env };
			if (thinkingTokens !== undefined) {
				customEnv.MAX_THINKING_TOKENS = thinkingTokens;
			}
			if (options?.thinking === 'off' || options?.thinking === 'none') {
				customEnv.CLAUDE_CODE_DISABLE_THINKING = '1';
			}
			if (options?.pureWorker) {
				delete customEnv.AEXUS_ADE_CALLER;
			} else if (options?.callerRole) {
				customEnv.AEXUS_ADE_CALLER = options.callerRole;
			}

			const child = spawnEngine(this.executable, args, session.cwd, customEnv);
			this.running.add(child);
			let sessionSet = this.runningBySession.get(session.id);
			if (!sessionSet) {
				sessionSet = new Set();
				this.runningBySession.set(session.id, sessionSet);
			}
			sessionSet.add(child);

			const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
			let errorText = '';
			let resultError: string | undefined;
			let wroteText = false;
			let sawThinkingDelta = false;
			let sawResult = false;
			let interimUsage: UsagePayload | undefined;
			let lastInterimReportAt = 0;
			let lastInterimReportedTotal = 0;
			const seenToolUses = new Set<string>();
			child.stderr.on('data', data => errorText = (errorText + String(data)).slice(-8000));
			lines.on('line', line => {
				let event: ClaudeEvent;
				try { event = JSON.parse(line) as ClaudeEvent; } catch { return; }
				const fromChild = typeof event.parent_tool_use_id === 'string';
				if (!fromChild && event.type === 'system' && event.subtype === 'init') {
					session.provisional = false;
					this.recordInit(session.id, event);
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
						if (!child.stdin.destroyed) {
							child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: result === allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: vscode.l10n.t('Denied by the user.') } } }) + '\n');
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
				}
			});
			const cancellation = token.onCancellationRequested(() => stopEngine(child, 'SIGINT'));
			child.stdin.write(JSON.stringify({ type: 'user', session_id: session.id, parent_tool_use_id: null, message: { role: 'user', content: userMessage } }) + '\n');
			try {
				await new Promise<void>((resolve, reject) => {
					child.on('error', reject);
					child.on('close', code => token.isCancellationRequested ? resolve() : resultError || code !== 0 ? reject(new Error(resultError || errorText || vscode.l10n.t('Claude Code exited with code {0}.', String(code)))) : resolve());
				});
				if (!sawResult && interimUsage) {
					const fallbackUsage = turnUsageFromPayload(interimUsage);
					if (fallbackUsage.totalTokens > 0) {
						this.lastTurnUsageBySession.set(session.id, fallbackUsage);
					}
				}
			} finally {
				cancellation.dispose();
				lines.close();
				this.running.delete(child);
				sessionSet.delete(child);
				if (sessionSet.size === 0) {
					this.runningBySession.delete(session.id);
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
			if (resolvedModel && /model|not_found|invalid/i.test(msg)) {
				await runOnce(false);
				return;
			}
			throw error;
		}
	}

	async getRuntimeCapabilities(_cwd: string, session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		const init = (session ? this.initBySession.get(session.id) : undefined) ?? this.lastInit;
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
		if (init?.model && !seenModels.has(init.model)) {
			models.push({ id: init.model, name: init.model });
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
		rows.push([vscode.l10n.t('Permission mode'), options?.permissionMode ?? init?.permissionMode ?? 'bypassPermissions']);
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
		const sources = [
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
		const files = [
			path.join(session.cwd, 'CLAUDE.md'),
			path.join(session.cwd, '.claude', 'CLAUDE.md'),
			path.join(this.configDir(), 'CLAUDE.md'),
		];
		const rows: string[] = [];
		for (const file of files) {
			try {
				const stat = await fs.stat(file);
				const content = await fs.readFile(file, 'utf8');
				const excerpt = content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).slice(0, 3).join(' ').slice(0, 240);
				const link = `[${file}](${vscode.Uri.file(file).toString()})`;
				rows.push(`- ${link} — ${stat.size.toLocaleString()} bytes${excerpt ? ` — ${escapeTableCell(excerpt)}` : ''}`);
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
			await fs.access(this.executable);
			return this.executable;
		});
		await check(vscode.l10n.t('Version'), async () => (await capture(this.executable, ['--version'], token, session.cwd)).trim().split('\n')[0]);
		const configDir = this.configDir();
		await check(vscode.l10n.t('Settings'), async () => {
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
			const files = [path.join(session.cwd, '.mcp.json'), path.join(os.homedir(), '.claude.json')];
			const found: string[] = [];
			for (const file of files) {
				try {
					await fs.access(file);
					found.push(file);
				} catch { /* Report the ones that exist. */ }
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
			const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
			return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
		} catch {
			return undefined;
		}
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
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

	dispose(): void { for (const child of this.running) { stopEngine(child); } this.running.clear(); }
}
