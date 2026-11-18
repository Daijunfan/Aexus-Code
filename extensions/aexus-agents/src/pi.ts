/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineAttachment, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, emitThinkingProgress, HistoryEntry, NativeSession, spawnEngine, stopEngine, withTimeout } from './runtime';

interface PiContentPart {
	type?: string;
	text?: string;
}

interface PiEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	cwd?: string;
	name?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: string | PiContentPart[];
		stopReason?: string;
		errorMessage?: string;
	};
}

interface PiRpcPacket {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: Record<string, unknown>;
	name?: string;
	toolName?: string;
	method?: string;
	title?: string;
	message?: string;
	placeholder?: string;
	prefill?: string;
	options?: string[];
	messages?: { role?: string; stopReason?: string; errorMessage?: string }[];
	finalError?: string;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
		toolName?: string;
	};
	args?: Record<string, unknown>;
}

interface PiModelInfo { id: string; name: string; description?: string }
interface PiCommandInfo { name: string; description?: string }
interface PiToolMode { id: 'full' | 'readonly' | 'chat' }

const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function modelEntries(value: unknown): PiModelInfo[] {
	const container = Array.isArray(value) ? value : (asRecord(value)?.models ?? value);
	const models: PiModelInfo[] = [];
	const seen = new Set<string>();
	const add = (provider: string | undefined, rawId: string | undefined, rawName: string | undefined, description?: string): void => {
		if (!rawId) {
			return;
		}
		const id = provider && !rawId.includes('/') ? `${provider}/${rawId}` : rawId;
		if (seen.has(id)) {
			return;
		}
		seen.add(id);
		models.push({ id, name: rawName || rawId, description });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			if (typeof item === 'string') {
				add(undefined, item, item);
				continue;
			}
			const record = asRecord(item);
			add(stringValue(record?.provider), stringValue(record?.id) ?? stringValue(record?.model), stringValue(record?.name) ?? stringValue(record?.label), stringValue(record?.description));
		}
	} else {
		const record = asRecord(container);
		if (record) {
			for (const [id, item] of Object.entries(record)) {
				const entry = asRecord(item);
				add(stringValue(entry?.provider), stringValue(entry?.id) ?? id, stringValue(entry?.name) ?? id, stringValue(entry?.description));
			}
		}
	}
	return models;
}

function commandEntries(value: unknown): PiCommandInfo[] {
	const container = Array.isArray(value) ? value : (asRecord(value)?.commands ?? value);
	const commands: PiCommandInfo[] = [];
	const seen = new Set<string>();
	const add = (name: string | undefined, description?: string): void => {
		const normalized = name?.trim().replace(/^\//, '');
		if (!normalized || seen.has(normalized)) {
			return;
		}
		seen.add(normalized);
		commands.push({ name: normalized, description });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			if (typeof item === 'string') {
				add(item);
				continue;
			}
			const record = asRecord(item);
			add(stringValue(record?.name) ?? stringValue(record?.id), stringValue(record?.description));
		}
	} else {
		const record = asRecord(container);
		if (record) {
			for (const [name, item] of Object.entries(record)) {
				add(name, stringValue(asRecord(item)?.description));
			}
		}
	}
	return commands;
}

function forkEntries(value: unknown): Array<{ entryId?: string; text: string }> {
	const container = Array.isArray(value) ? value : (asRecord(value)?.messages ?? []);
	const entries: Array<{ entryId?: string; text: string }> = [];
	if (!Array.isArray(container)) {
		return entries;
	}
	for (const item of container) {
		if (typeof item === 'string') {
			entries.push({ text: item });
			continue;
		}
		const record = asRecord(item);
		const text = stringValue(record?.text) ?? stringValue(record?.preview) ?? stringValue(record?.message) ?? '';
		const role = stringValue(record?.role);
		entries.push({
			entryId: stringValue(record?.entryId) ?? stringValue(record?.id),
			text: role ? `${role}: ${text}` : text || '—',
		});
	}
	return entries;
}

function displayValue(value: unknown): string {
	if (value === undefined || value === null || value === '') {
		return '—';
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	try {
		return JSON.stringify(value).slice(0, 160);
	} catch {
		return String(value);
	}
}

function modelName(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	const record = asRecord(value);
	return record ? stringValue(record.id) ?? stringValue(record.name) ?? stringValue(record.model) : undefined;
}

function piThinkingLevel(thinking: string | undefined): string | undefined {
	if (!thinking || thinking === 'default') {
		return undefined;
	}
	if (thinking === 'max' || thinking === 'extra-high') {
		return 'xhigh';
	}
	if (thinking === 'none') {
		return 'off';
	}
	return PI_THINKING_LEVELS.has(thinking) ? thinking : undefined;
}

function toolDetail(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) {
		return undefined;
	}
	for (const key of ['command', 'path', 'filePath', 'file', 'pattern', 'query', 'url', 'name']) {
		const value = stringValue(args[key]);
		if (value) {
			return value.length > 120 ? `${value.slice(0, 117)}…` : value;
		}
	}
	return undefined;
}

function piMessageText(content: string | PiContentPart[] | undefined): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n');
	}
	return '';
}

export class PiRuntime implements EngineRuntime {
	readonly id = 'pi';
	readonly name = 'Pi';
	private readonly running = new Map<string, Set<ReturnType<typeof spawnEngine>>>();
	private readonly toolModes = new Map<string, PiToolMode['id']>();
	private readonly capabilityCache = new Map<string, { expiresAt: number; value: EngineRuntimeCapabilities }>();
	private readonly capabilityPending = new Map<string, Promise<EngineRuntimeCapabilities>>();

	constructor(private readonly executable: string) { }

	private sessionsDir(): string {
		const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
		return path.join(agentDir, 'sessions');
	}

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		const root = this.sessionsDir();
		let groups: string[];
		try {
			groups = await fs.readdir(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
			throw error;
		}

		const files: { file: string; mtimeMs: number; birthtimeMs: number }[] = [];
		for (const group of groups) {
			if (token.isCancellationRequested) { break; }
			const groupPath = path.join(root, group);
			try {
				const groupStat = await fs.stat(groupPath);
				if (!groupStat.isDirectory()) { continue; }
				const entries = await fs.readdir(groupPath);
				for (const entry of entries) {
					if (!entry.endsWith('.jsonl')) { continue; }
					const filePath = path.join(groupPath, entry);
					try {
						const stat = await fs.stat(filePath);
						if (stat.isFile()) {
							files.push({ file: filePath, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
						}
					} catch { /* Ignore broken symlink or transient file. */ }
				}
			} catch { /* Ignore non-directory or broken symlink. */ }
		}

		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const sessions: NativeSession[] = [];
		for (const candidate of files) {
			if (token.isCancellationRequested) { break; }
			let content: string;
			try {
				content = await fs.readFile(candidate.file, 'utf8');
			} catch {
				continue;
			}
			let id: string | undefined;
			let cwd: string | undefined;
			let created = candidate.birthtimeMs;
			let sessionName: string | undefined;
			let firstUserText: string | undefined;
			for (const rawLine of content.split('\n')) {
				const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				if (!line) { continue; }
				let entry: PiEntry;
				try { entry = JSON.parse(line) as PiEntry; } catch { continue; }
				if (entry.type === 'session' && entry.id && entry.cwd) {
					id = entry.id;
					cwd = entry.cwd;
					if (entry.timestamp) {
						const parsed = Date.parse(entry.timestamp);
						if (Number.isFinite(parsed)) { created = parsed; }
					}
				} else if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
					sessionName = entry.name.trim();
				} else if (!firstUserText && entry.type === 'message' && entry.message?.role === 'user') {
					const text = piMessageText(entry.message.content).trim();
					if (text) { firstUserText = text.split('\n')[0].slice(0, 100); }
				}
			}
			if (id && cwd) {
				sessions.push({
					id,
					cwd,
					label: sessionName || firstUserText || vscode.l10n.t('Pi Session {0}', id.slice(0, 8)),
					created,
					updated: candidate.mtimeMs,
					file: candidate.file,
					provisional: false,
				});
			}
		}
		return sessions;
	}

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		return {
			id: randomUUID(),
			cwd,
			label: vscode.l10n.t('New Pi Session'),
			created: now,
			updated: now,
			provisional: true,
		};
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested) { return []; }
		if (session.provisional && !session.file) { return []; }
		const file = session.file ?? (await this.list(token)).find(item => item.id === session.id)?.file;
		if (!file) { return []; }
		session.file = file;
		let content: string;
		try {
			content = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
			throw error;
		}

		const byId = new Map<string, PiEntry>();
		const ordered: PiEntry[] = [];
		for (const rawLine of content.split('\n')) {
			const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
			if (!line) { continue; }
			let entry: PiEntry;
			try { entry = JSON.parse(line) as PiEntry; } catch { continue; }
			if (entry.type === 'session') { continue; }
			ordered.push(entry);
			if (entry.id) {
				byId.set(entry.id, entry);
			}
		}

		if (ordered.length === 0) { return []; }
		let branch: PiEntry[];
		if (ordered.some(entry => Boolean(entry.parentId))) {
			branch = [];
			const visited = new Set<string>();
			let current: PiEntry | undefined = ordered.at(-1);
			while (current) {
				if (current.id) {
					if (visited.has(current.id)) { break; }
					visited.add(current.id);
				}
				branch.push(current);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			branch.reverse();
		} else {
			branch = ordered;
		}

		const history: HistoryEntry[] = [];
		for (const entry of branch) {
			if (entry.type !== 'message') { continue; }
			const role = entry.message?.role;
			if (role !== 'user' && role !== 'assistant') { continue; }
			const text = piMessageText(entry.message?.content).trim();
			if (text) {
				history.push({ id: entry.id, role, text });
			}
		}
		return history;
	}

	private sessionArgs(session: NativeSession): string[] {
		return session.file ? ['--session', session.file] : ['--session-id', session.id];
	}

	/**
	 * Runs a short-lived RPC worker and sends each command once, returning the response data in order.
	 * Commands that fail or time out resolve to `undefined` so callers can degrade gracefully.
	 */
	private async runRpc(cwd: string, extraArgs: readonly string[], commands: ReadonlyArray<Record<string, unknown>>, timeoutMs: number, token?: vscode.CancellationToken): Promise<Array<Record<string, unknown> | undefined>> {
		const results: Array<Record<string, unknown> | undefined> = commands.map(() => undefined);
		if (token?.isCancellationRequested) {
			return results;
		}
		const child = spawnEngine(this.executable, ['--mode', 'rpc', ...extraArgs], cwd);
		const pending = new Map<string, (data: Record<string, unknown> | undefined) => void>();
		let buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
				const rawLine = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				if (!line) { continue; }
				let packet: PiRpcPacket;
				try { packet = JSON.parse(line) as PiRpcPacket; } catch { continue; }
				if (packet.type !== 'response' || !packet.id) { continue; }
				const resolve = pending.get(packet.id);
				if (resolve) {
					pending.delete(packet.id);
					resolve(packet.success ? packet.data : undefined);
				}
			}
		});
		const settleAll = () => {
			const waiting = [...pending.values()];
			pending.clear();
			for (const resolve of waiting) { resolve(undefined); }
		};
		child.on('error', settleAll);
		child.on('close', settleAll);
		const subscription = token?.onCancellationRequested(() => {
			stopEngine(child, 'SIGKILL');
			settleAll();
		});
		const requests = commands.map((command, index) => new Promise<void>(resolve => {
			const id = `rpc-${index}`;
			pending.set(id, data => {
				results[index] = data;
				resolve();
			});
			if (child.stdin.destroyed) {
				pending.delete(id);
				resolve();
				return;
			}
			try {
				child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
			} catch {
				pending.delete(id);
				resolve();
			}
		}));
		try {
			await withTimeout(Promise.all(requests), timeoutMs);
		} catch { /* Time out or exit; return whatever completed. */ }
		finally {
			subscription?.dispose();
			if (!child.stdin.destroyed) { child.stdin.end(); }
			stopEngine(child, 'SIGKILL');
		}
		return results;
	}

	async getRuntimeCapabilities(cwd: string, _session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		const cached = this.capabilityCache.get(cwd);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value;
		}
		const pending = this.capabilityPending.get(cwd);
		if (pending) {
			return pending;
		}
		const load = (async (): Promise<EngineRuntimeCapabilities> => {
			const [models, commands] = await this.runRpc(cwd, [], [{ type: 'get_available_models' }, { type: 'get_commands' }], 8000);
			const value: EngineRuntimeCapabilities = {
				models: modelEntries(models),
				commands: commandEntries(commands),
			};
			this.capabilityCache.set(cwd, { expiresAt: Date.now() + 15000, value });
			return value;
		})();
		this.capabilityPending.set(cwd, load);
		try {
			return await load;
		} finally {
			this.capabilityPending.delete(cwd);
		}
	}

	private async readImages(attachments?: readonly EngineAttachment[]): Promise<Array<{ type: string; mimeType: string; data: string }>> {
		const images: Array<{ type: string; mimeType: string; data: string }> = [];
		for (const attachment of attachments ?? []) {
			const isImage = attachment.kind === 'image' || Boolean(attachment.mimeType?.startsWith('image/'));
			if (!isImage) {
				continue;
			}
			try {
				const data = await fs.readFile(attachment.filePath);
				images.push({ type: 'image', mimeType: attachment.mimeType || 'image/png', data: data.toString('base64') });
			} catch { /* Skip attachments that cannot be read. */ }
		}
		return images;
	}

	private describeToolCall(packet: PiRpcPacket): string {
		const toolName = stringValue(packet.toolName) ?? this.name;
		const detail = toolDetail(packet.args);
		return detail ? `${toolName}: ${detail}` : toolName;
	}

	private async compactSession(session: NativeSession, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		if (session.provisional && !session.file) {
			stream.markdown(vscode.l10n.t('This session has no messages to compact yet.'));
			return;
		}
		const customInstructions = argsText.trim();
		const [data] = await this.runRpc(session.cwd, this.sessionArgs(session), [{ type: 'compact', ...(customInstructions ? { customInstructions } : {}) }], 90000, token);
		if (!data) {
			stream.markdown(vscode.l10n.t('Pi did not report a compaction summary. The conversation may still be compacted.'));
			return;
		}
		const summary = stringValue(data.summary) ?? stringValue(data.text) ?? stringValue(data.result);
		stream.markdown(summary
			? vscode.l10n.t('Compacted the conversation.\n\n{0}', summary)
			: vscode.l10n.t('Compacted the conversation to free up context.'));
	}

	private async showStats(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const [statsData, stateData] = await this.runRpc(session.cwd, this.sessionArgs(session), [{ type: 'get_session_stats' }, { type: 'get_state' }], 20000, token);
		const stats = asRecord(statsData) ?? {};
		const state = asRecord(stateData) ?? {};
		const tokenTotals = asRecord(stats.tokens);
		const messages = stats.messageCount ?? stats.totalMessages ?? stats.message_count ?? (Array.isArray(stats.messages) ? stats.messages.length : undefined);
		const tokens = stats.totalTokens ?? stats.tokenCount ?? tokenTotals?.total;
		const cost = stats.cost ?? stats.totalCost;
		const model = modelName(state.model) ?? modelName(stats.model);
		const thinking = state.thinkingLevel ?? state.thinking;
		const autoCompaction = state.autoCompaction ?? state.autoCompactionEnabled;
		const costText = typeof cost === 'number' ? `$${cost.toFixed(4)}` : displayValue(cost);
		const rows = [
			`| ${vscode.l10n.t('Messages')} | ${displayValue(messages)} |`,
			`| ${vscode.l10n.t('Tokens')} | ${displayValue(tokens)} |`,
			`| ${vscode.l10n.t('Cost')} | ${costText} |`,
			`| ${vscode.l10n.t('Model')} | ${displayValue(model)} |`,
			`| ${vscode.l10n.t('Thinking level')} | ${displayValue(thinking)} |`,
			`| ${vscode.l10n.t('Auto compaction')} | ${displayValue(autoCompaction)} |`,
		];
		stream.markdown([`| ${vscode.l10n.t('Metric')} | ${vscode.l10n.t('Value')} |`, '| --- | --- |', ...rows].join('\n'));
	}

	private async showTree(session: NativeSession, fork: boolean, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const [forkData] = await this.runRpc(session.cwd, this.sessionArgs(session), [{ type: 'get_fork_messages' }], 15000, token);
		const entries = forkEntries(forkData);
		if (entries.length === 0) {
			stream.markdown(vscode.l10n.t('This session has no messages to show yet.'));
			return;
		}
		if (!fork) {
			const lines = entries.map((entry, index) => entry.entryId
				? `${index + 1}. ${entry.text} (${entry.entryId})`
				: `${index + 1}. ${entry.text}`);
			stream.markdown([`### ${vscode.l10n.t('Conversation tree')}`, '', ...lines].join('\n'));
			return;
		}
		const requested = argsText.trim();
		const entryId = requested || [...entries].reverse().find(entry => entry.entryId)?.entryId;
		if (!entryId) {
			stream.markdown(vscode.l10n.t('There is no message to fork from yet.'));
			return;
		}
		const [forked] = await this.runRpc(session.cwd, this.sessionArgs(session), [{ type: 'fork', entryId }], 30000, token);
		if (!forked) {
			stream.markdown(vscode.l10n.t('Pi could not fork the conversation at {0}.', entryId));
			return;
		}
		const newSession = stringValue(forked.sessionId) ?? stringValue(forked.newSessionId) ?? stringValue(forked.sessionFile) ?? stringValue(forked.file);
		stream.markdown(newSession
			? vscode.l10n.t('Forked the conversation into {0}.', newSession)
			: vscode.l10n.t('Forked the conversation.'));
	}

	async executeCommand(session: NativeSession, command: string, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, _options?: EngineSendOptions): Promise<boolean> {
		const name = command.trim().replace(/^\//, '').toLowerCase();
		if (!['compact', 'stats', 'cost', 'tree', 'fork', 'reload'].includes(name)) {
			return false;
		}
		if (token.isCancellationRequested) {
			return true;
		}
		switch (name) {
			case 'compact':
				await this.compactSession(session, argsText, stream, token);
				return true;
			case 'stats':
			case 'cost':
				await this.showStats(session, stream, token);
				return true;
			case 'tree':
				await this.showTree(session, false, argsText, stream, token);
				return true;
			case 'fork':
				await this.showTree(session, true, argsText, stream, token);
				return true;
			case 'reload': {
				await this.killSession(session);
				const [state] = await this.runRpc(session.cwd, this.sessionArgs(session), [{ type: 'get_state' }], 10000, token);
				stream.markdown(state
					? vscode.l10n.t('Reloaded Pi. Skills, extensions, and settings will be picked up by the next message.')
					: vscode.l10n.t('Restarted Pi, but the fresh worker did not report its state. The next message will retry the connection.'));
				return true;
			}
		}
		return false;
	}

	private async handleUiRequest(child: ReturnType<typeof spawnEngine>, packet: PiRpcPacket, session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (!packet.id || child.stdin.destroyed) { return; }
		const respond = (payload: Record<string, unknown>) => {
			if (!child.stdin.destroyed) {
				child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: packet.id, ...payload }) + '\n');
			}
		};
		const title = packet.title ? vscode.l10n.t('Pi — {0}', packet.title) : 'Pi';
		if (packet.method === 'select') {
			const picked = await vscode.window.showQuickPick(packet.options ?? [], {
				title,
				placeHolder: `${session.label} (${session.cwd})`,
				ignoreFocusOut: true,
			}, token);
			respond(picked !== undefined ? { value: picked } : { cancelled: true });
		} else if (packet.method === 'confirm') {
			const confirmLabel = vscode.l10n.t('Allow Once');
			const picked = await vscode.window.showQuickPick([confirmLabel, vscode.l10n.t('Deny')], {
				title,
				placeHolder: packet.message ? `${session.cwd}: ${packet.message}` : session.cwd,
				ignoreFocusOut: true,
			}, token);
			respond(picked !== undefined ? { confirmed: picked === confirmLabel } : { cancelled: true });
		} else if (packet.method === 'input' || packet.method === 'editor') {
			const value = await vscode.window.showInputBox({
				title,
				prompt: packet.placeholder || `${session.label} (${session.cwd})`,
				value: packet.prefill,
				ignoreFocusOut: true,
			}, token);
			respond(value !== undefined ? { value } : { cancelled: true });
		}
	}

	async killSession(session: NativeSession): Promise<void> {
		const active = this.running.get(session.id);
		if (active) {
			for (const child of active) {
				stopEngine(child, 'SIGKILL');
			}
			this.running.delete(session.id);
		}
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		if (!session.provisional && !session.file) {
			session.file = (await this.list(token)).find(item => item.id === session.id)?.file;
		}
		const requestedMode = options?.mode?.trim().toLowerCase();
		const toolMode: PiToolMode['id'] = requestedMode === 'readonly' || requestedMode === 'chat' ? requestedMode : 'full';
		const previousMode = this.toolModes.get(session.id);
		this.toolModes.set(session.id, toolMode);
		if (previousMode && previousMode !== toolMode) {
			// The tool mode is fixed at worker start, so an in-flight worker from the old mode must be replaced.
			const stale = this.running.get(session.id);
			if (stale) {
				for (const child of stale) { stopEngine(child, 'SIGKILL'); }
				this.running.delete(session.id);
			}
		}
		const modelOption = options?.model && options.model !== 'default' ? options.model : undefined;
		const args = [
			'--mode', 'rpc',
			...(modelOption ? ['--model', modelOption] : []),
			...(toolMode === 'readonly' ? ['--tools', 'read,grep,find,ls'] : toolMode === 'chat' ? ['--no-tools'] : []),
			...this.sessionArgs(session),
		];
		const customEnv: NodeJS.ProcessEnv = { ...process.env };
		if (options?.pureWorker) {
			delete customEnv.AEXUS_ADE_CALLER;
		} else if (options?.callerRole) {
			customEnv.AEXUS_ADE_CALLER = options.callerRole;
		}
		const child = spawnEngine(this.executable, args, session.cwd, customEnv);
		let sessionProcs = this.running.get(session.id);
		if (!sessionProcs) {
			sessionProcs = new Set();
			this.running.set(session.id, sessionProcs);
		}
		sessionProcs.add(child);

		let nextReqId = 0;
		const pending = new Map<string, { resolve: (data: Record<string, unknown> | undefined) => void; reject: (error: Error) => void }>();
		const sendCommand = <T extends Record<string, unknown> | undefined = Record<string, unknown> | undefined>(command: Record<string, unknown>): Promise<T> => {
			if (child.stdin.destroyed) {
				return Promise.reject(new Error(vscode.l10n.t('Pi connection closed unexpectedly.')));
			}
			const id = `req-${++nextReqId}`;
			return new Promise<T>((resolve, reject) => {
				pending.set(id, { resolve: data => resolve(data as T), reject });
				child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
			});
		};

		let stderrText = '';
		let turnError: string | undefined;
		let settleResolve!: () => void;
		let settleReject!: (error: Error) => void;
		const settled = new Promise<void>((resolve, reject) => {
			settleResolve = resolve;
			settleReject = reject;
		});
		void settled.catch(() => { });

		child.stderr.on('data', data => stderrText = (stderrText + String(data)).slice(-8000));

		// Strict LF framing (do NOT use readline because U+2028 / U+2029 are valid in JSON strings).
		let stdoutBuffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			stdoutBuffer += chunk;
			let newlineIndex: number;
			while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
				const rawLine = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
				if (!line) { continue; }
				let packet: PiRpcPacket;
				try { packet = JSON.parse(line) as PiRpcPacket; } catch { continue; }

				if (packet.type === 'response' && packet.id) {
					const req = pending.get(packet.id);
					if (req) {
						pending.delete(packet.id);
						if (packet.success) {
							req.resolve(packet.data);
						} else {
							req.reject(new Error(packet.error || vscode.l10n.t('Pi command {0} failed.', packet.command ?? '')));
						}
					}
					continue;
				}

				if (packet.type === 'message_update' && !token.isCancellationRequested) {
					const ame = packet.assistantMessageEvent;
					if (ame?.type === 'text_delta' && typeof ame.delta === 'string' && ame.delta) {
						stream.markdown(ame.delta);
					} else if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta) {
						emitThinkingProgress(stream, ame.delta, 'pi-thinking');
					} else if (ame?.type === 'toolcall_start' && typeof ame.toolName === 'string') {
						stream.progress(ame.toolName);
					}
				} else if (packet.type === 'tool_execution_start' && !token.isCancellationRequested) {
					stream.progress(this.describeToolCall(packet));
				} else if (packet.type === 'session_info_changed' && typeof packet.name === 'string' && packet.name.trim()) {
					session.label = packet.name.trim();
				} else if (packet.type === 'extension_ui_request') {
					void this.handleUiRequest(child, packet, session, token).catch(() => { });
				} else if (packet.type === 'agent_end' && Array.isArray(packet.messages)) {
					const lastMsg = packet.messages.at(-1);
					if (lastMsg?.stopReason === 'error' && lastMsg.errorMessage) {
						turnError = lastMsg.errorMessage;
					}
				} else if (packet.type === 'auto_retry_end' && packet.success === false && packet.finalError) {
					turnError = packet.finalError;
				} else if (packet.type === 'agent_settled') {
					session.provisional = false;
					if (turnError && !token.isCancellationRequested) {
						settleReject(new Error(turnError));
					} else {
						settleResolve();
					}
				}
			}
		});

		const failAll = (error: Error) => {
			for (const req of pending.values()) { req.reject(error); }
			pending.clear();
			settleReject(error);
		};
		child.on('error', failAll);
		child.on('close', code => {
			if (token.isCancellationRequested) {
				settleResolve();
			} else {
				failAll(new Error(turnError || stderrText || vscode.l10n.t('Pi exited before finishing ({0}).', String(code))));
			}
		});

		const cancellation = token.onCancellationRequested(() => {
			void sendCommand({ type: 'clear_queue' }).catch(() => { });
			void sendCommand({ type: 'abort' }).catch(() => { stopEngine(child); });
		});

		try {
			if (session.provisional || !session.file) {
				const state = await sendCommand<{ sessionFile?: string }>({ type: 'get_state' }).catch(() => undefined);
				if (state && typeof state.sessionFile === 'string' && state.sessionFile) {
					session.file = state.sessionFile;
				}
			}
			if (modelOption) {
				let provider: string | undefined;
				let modelId: string | undefined;
				const separator = modelOption.indexOf('/');
				if (separator > 0 && separator < modelOption.length - 1) {
					provider = modelOption.slice(0, separator);
					modelId = modelOption.slice(separator + 1);
				} else {
					const listing = await sendCommand<Record<string, unknown> | undefined>({ type: 'get_available_models' }).catch(() => undefined);
					const match = modelEntries(listing).find(model => model.id === modelOption || model.id.endsWith(`/${modelOption}`) || model.name === modelOption);
					const matchSeparator = match ? match.id.indexOf('/') : -1;
					if (match && matchSeparator > 0) {
						provider = match.id.slice(0, matchSeparator);
						modelId = match.id.slice(matchSeparator + 1);
					}
				}
				if (provider && modelId) {
					await sendCommand({ type: 'set_model', provider, modelId }).catch(() => undefined);
				}
			}
			const piLevel = piThinkingLevel(options?.thinking);
			if (piLevel) {
				await sendCommand({ type: 'set_thinking_level', level: piLevel }).catch(() => undefined);
			}
			const images = await this.readImages(options?.attachments);
			await sendCommand({ type: 'prompt', message: text, ...(images.length > 0 ? { images } : {}) });
			if (token.isCancellationRequested) {
				await sendCommand({ type: 'clear_queue' }).catch(() => { });
				await sendCommand({ type: 'abort' }).catch(() => { });
			}
			await settled;
			if (!session.file) {
				const state = await sendCommand<{ sessionFile?: string }>({ type: 'get_state' }).catch(() => undefined);
				if (state && typeof state.sessionFile === 'string' && state.sessionFile) {
					session.file = state.sessionFile;
				}
			}
		} finally {
			cancellation.dispose();
			child.stdin.end();
			stopEngine(child);
			sessionProcs.delete(child);
			if (sessionProcs.size === 0) {
				this.running.delete(session.id);
			}
		}
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		this.toolModes.delete(session.id);
		const active = this.running.get(session.id);
		if (active) {
			for (const child of active) { stopEngine(child); }
			this.running.delete(session.id);
		}
		const file = session.file ?? (!session.provisional ? (await this.list(token)).find(item => item.id === session.id)?.file : undefined);
		if (file) {
			await fs.rm(file, { force: true });
		}
	}

	dispose(): void {
		for (const procs of this.running.values()) {
			for (const child of procs) { stopEngine(child); }
		}
		this.running.clear();
	}
}
