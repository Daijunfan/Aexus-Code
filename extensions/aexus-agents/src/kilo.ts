/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import { capture, EngineAttachment, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineTurnTokenUsage, emitThinkingProgress, HistoryEntry, NativeSession, readJsonOutput, spawnEngine, stopEngine, withTimeout } from './runtime';

interface KiloSession { id: string; parentID?: string; directory: string; title: string; time?: { created: number; updated: number }; created?: number; updated?: number; share?: { url?: string } }
interface KiloSessionListItem { id: string; directory: string; title: string; created: number; updated: number }
interface KiloPart { id: string; type: string; text?: string; sessionID?: string; tool?: string; state?: { status?: string; title?: string } }
interface KiloMessage { info: { id: string; role: string; error?: { data?: { message?: string } } }; parts: KiloPart[] }
interface KiloModelInfo { id: string; name: string; description?: string }
interface KiloModeInfo { id: string; name: string; description?: string }
interface KiloCommandInfo { name: string; description?: string }
interface KiloModelSelection { providerID: string; modelID: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function tableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function providerEntries(value: unknown): Array<{ id: string; provider: Record<string, unknown> }> {
	const container = Array.isArray(value) ? value : (asRecord(value)?.providers ?? value);
	const entries: Array<{ id: string; provider: Record<string, unknown> }> = [];
	if (Array.isArray(container)) {
		for (const item of container) {
			const provider = asRecord(item);
			const id = stringValue(provider?.id) ?? stringValue(provider?.name);
			if (provider && id) {
				entries.push({ id, provider });
			}
		}
		return entries;
	}
	const record = asRecord(container);
	if (record) {
		for (const [id, item] of Object.entries(record)) {
			const provider = asRecord(item);
			if (provider) {
				entries.push({ id, provider });
			}
		}
	}
	return entries;
}

function extractProviderModels(value: unknown): KiloModelInfo[] {
	const models: KiloModelInfo[] = [];
	const seen = new Set<string>();
	for (const { id: providerID, provider } of providerEntries(value)) {
		const rawModels = provider.models;
		const addModel = (modelID: string, raw: unknown): void => {
			const id = `${providerID}/${modelID}`;
			if (seen.has(id)) {
				return;
			}
			seen.add(id);
			const record = asRecord(raw);
			models.push({
				id,
				name: stringValue(record?.name) ?? modelID,
				description: stringValue(record?.description),
			});
		};
		if (Array.isArray(rawModels)) {
			for (const item of rawModels) {
				const record = asRecord(item);
				const modelID = stringValue(record?.id) ?? stringValue(record?.name);
				if (modelID) {
					addModel(modelID, record);
				}
			}
		} else {
			const record = asRecord(rawModels);
			if (record) {
				for (const [modelID, item] of Object.entries(record)) {
					addModel(modelID, item);
				}
			}
		}
	}
	return models;
}

function extractModes(value: unknown): KiloModeInfo[] {
	const container = asRecord(value)?.agents ?? value;
	const modes: KiloModeInfo[] = [];
	const seen = new Set<string>();
	const add = (id: string, record: Record<string, unknown> | undefined): void => {
		if (!id || seen.has(id)) {
			return;
		}
		if (record?.hidden === true || record?.disable === true || stringValue(record?.mode) === 'subagent') {
			return;
		}
		seen.add(id);
		modes.push({ id, name: stringValue(record?.name) ?? id, description: stringValue(record?.description) });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			const record = asRecord(item);
			add(stringValue(record?.id) ?? stringValue(record?.name) ?? '', record);
		}
	} else {
		const record = asRecord(container);
		if (record) {
			for (const [id, item] of Object.entries(record)) {
				add(id, asRecord(item));
			}
		}
	}
	return modes;
}

function extractCommands(value: unknown): KiloCommandInfo[] {
	const container = Array.isArray(value) ? value : (asRecord(value)?.commands ?? value);
	const commands: KiloCommandInfo[] = [];
	const seen = new Set<string>();
	const add = (name: string, description?: string): void => {
		if (!name || seen.has(name)) {
			return;
		}
		seen.add(name);
		commands.push({ name, description });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			if (typeof item === 'string') {
				add(item);
				continue;
			}
			const record = asRecord(item);
			add(stringValue(record?.name) ?? stringValue(record?.id) ?? '', stringValue(record?.description));
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

function extractMcpServers(value: unknown): Array<{ name: string; status: string; detail?: string }> {
	const container = Array.isArray(value) ? value : (asRecord(value)?.servers ?? value);
	const servers: Array<{ name: string; status: string; detail?: string }> = [];
	const push = (name: string, item: unknown): void => {
		if (!name) {
			return;
		}
		if (typeof item === 'string') {
			servers.push({ name, status: item });
			return;
		}
		const record = asRecord(item);
		const status = stringValue(record?.status) ?? (record?.enabled === false ? 'disabled' : undefined) ?? 'unknown';
		const detail = stringValue(record?.url) ?? stringValue(record?.command) ?? stringValue(record?.type);
		servers.push({ name, status, detail });
	};
	if (Array.isArray(container)) {
		for (const item of container) {
			const record = asRecord(item);
			push(stringValue(record?.name) ?? stringValue(record?.id) ?? '', item);
		}
	} else {
		const record = asRecord(container);
		if (record) {
			for (const [name, item] of Object.entries(record)) {
				push(name, item);
			}
		}
	}
	return servers;
}
interface KiloTokens { input?: number; output?: number; cache?: { read?: number; write?: number } }
interface KiloEventData {
	id?: string;
	sessionID?: string;
	messageID?: string;
	partID?: string;
	delta?: string;
	field?: string;
	permission?: string;
	patterns?: string[];
	part?: KiloPart;
	info?: Partial<KiloSession> & { id: string; role?: string; sessionID?: string; tokens?: KiloTokens };
	questions?: { header: string; question: string; options: { label: string; description: string }[]; multiple?: boolean }[];
}
interface KiloEvent { type: string; properties?: KiloEventData; data?: KiloEventData }

function turnUsageFromKiloTokens(tokens: KiloTokens | undefined): EngineTurnTokenUsage | undefined {
	if (!tokens) {
		return undefined;
	}
	const inputTokens = tokens.input ?? 0;
	const outputTokens = tokens.output ?? 0;
	const cacheReadTokens = tokens.cache?.read ?? 0;
	const cacheWriteTokens = tokens.cache?.write ?? 0;
	const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
	if (totalTokens <= 0) {
		return undefined;
	}
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, estimated: false };
}

abstract class SharedServerRuntime implements EngineRuntime {
	abstract readonly id: string;
	abstract readonly name: string;
	protected abstract readonly envPrefix: string;

	protected child: ReturnType<typeof spawnEngine> | undefined;
	protected endpoint: Promise<string> | undefined;
	private readonly password = randomBytes(24).toString('hex');
	private readonly changed = new vscode.EventEmitter<readonly NativeSession[]>();
	readonly onDidChangeSessions = this.changed.event;
	protected readonly knownSessions = new Map<string, NativeSession>();
	private readonly capabilityCache = new Map<string, { expiresAt: number; value: EngineRuntimeCapabilities }>();
	private readonly capabilityPending = new Map<string, Promise<EngineRuntimeCapabilities>>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();

	consumeLastTurnUsage(sessionId: string): EngineTurnTokenUsage | undefined {
		const usage = this.lastTurnUsageBySession.get(sessionId);
		this.lastTurnUsageBySession.delete(sessionId);
		return usage;
	}

	constructor(protected readonly executable: string) { }

	private async tryRequest<T>(route: string, cwd: string, timeoutMs = 4000): Promise<T | undefined> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await this.request<T>(route, cwd, 'GET', undefined, controller.signal);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
			if (!controller.signal.aborted) {
				controller.abort();
			}
		}
	}

	private async serverInfo(cwd: string): Promise<EngineRuntimeCapabilities> {
		const cached = this.capabilityCache.get(cwd);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.value;
		}
		const pending = this.capabilityPending.get(cwd);
		if (pending) {
			return pending;
		}
		const load = (async (): Promise<EngineRuntimeCapabilities> => {
			const [providers, agents, commands] = await Promise.all([
				this.tryRequest<unknown>('/config/providers', cwd),
				this.tryRequest<unknown>('/agent', cwd),
				this.tryRequest<unknown>('/command', cwd),
			]);
			const value: EngineRuntimeCapabilities = {
				models: extractProviderModels(providers),
				modes: extractModes(agents),
				commands: extractCommands(commands),
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

	async getRuntimeCapabilities(cwd: string, _session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		return this.serverInfo(cwd);
	}

	private async resolveModel(requested: string | undefined, cwd: string): Promise<KiloModelSelection | undefined> {
		const value = requested?.trim();
		if (!value || value === 'default') {
			return undefined;
		}
		const separator = value.indexOf('/');
		if (separator > 0 && separator < value.length - 1) {
			return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
		}
		const info = await this.serverInfo(cwd);
		const match = (info.models ?? []).find(model => model.id === value || model.id.endsWith(`/${value}`));
		if (!match) {
			return undefined;
		}
		const index = match.id.indexOf('/');
		return index > 0 ? { providerID: match.id.slice(0, index), modelID: match.id.slice(index + 1) } : undefined;
	}

	private async currentModel(cwd: string, requested: string | undefined): Promise<KiloModelSelection | undefined> {
		const resolved = await this.resolveModel(requested, cwd);
		if (resolved) {
			return resolved;
		}
		const info = await this.serverInfo(cwd);
		const first = info.models?.[0]?.id;
		if (!first) {
			return undefined;
		}
		const index = first.indexOf('/');
		return index > 0 ? { providerID: first.slice(0, index), modelID: first.slice(index + 1) } : undefined;
	}

	private modeAliases(mode: string): string[] {
		if (this.id === 'kilo') {
			if (mode === 'architect') {
				return ['architect', 'plan'];
			}
			if (mode === 'plan') {
				return ['plan', 'architect'];
			}
		}
		return [mode];
	}

	private async resolveMode(requested: string | undefined, cwd: string): Promise<string | undefined> {
		const value = requested?.trim();
		if (!value || value === 'default') {
			return undefined;
		}
		const info = await this.serverInfo(cwd);
		const available = (info.modes ?? []).map(mode => mode.id);
		for (const alias of this.modeAliases(value.toLowerCase())) {
			const match = available.find(id => id.toLowerCase() === alias);
			if (match) {
				return match;
			}
		}
		return value;
	}

	private resolveVariant(thinking: string | undefined): string | undefined {
		const value = thinking?.trim();
		if (!value || value === 'default') {
			return undefined;
		}
		return this.id === 'kilo' && value === 'off' ? 'none' : value;
	}

	private messageParts(text: string, attachments?: readonly EngineAttachment[]): object[] {
		const parts: object[] = [{ type: 'text', text }];
		for (const attachment of attachments ?? []) {
			const isImage = attachment.kind === 'image' || Boolean(attachment.mimeType?.startsWith('image/'));
			if (isImage) {
				parts.push({ type: 'file', mime: attachment.mimeType || 'image/png', url: pathToFileURL(attachment.filePath).href });
			} else if (attachment.rangeText) {
				parts.push({ type: 'text', text: `${attachment.filePath}\n${attachment.rangeText}` });
			} else {
				parts.push({ type: 'file', mime: attachment.mimeType || 'text/plain', url: pathToFileURL(attachment.filePath).href });
			}
		}
		return parts;
	}

	private reportToolProgress(stream: vscode.ChatResponseStream, part: KiloPart, seen: Set<string>): void {
		if (!part.tool || !part.id) {
			return;
		}
		const status = part.state?.status ?? 'running';
		if (status !== 'running' && status !== 'pending') {
			return;
		}
		const key = `${part.id}:${status}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		stream.progress(vscode.l10n.t('{0} is running {1}…', this.name, part.tool));
	}

	private async compactSession(session: NativeSession, stream: vscode.ChatResponseStream, options: EngineSendOptions | undefined, signal: AbortSignal): Promise<void> {
		if (session.unmaterialized) {
			stream.markdown(vscode.l10n.t('This session has no messages to compact yet.'));
			return;
		}
		const messages = await this.request<KiloMessage[]>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'GET', undefined, signal).catch(() => [] as KiloMessage[]);
		if (messages.length === 0) {
			stream.markdown(vscode.l10n.t('This session has no messages to compact yet.'));
			return;
		}
		const model = await this.currentModel(session.cwd, options?.model);
		try {
			await this.request(`/session/${encodeURIComponent(session.id)}/summarize`, session.cwd, 'POST', model ? { providerID: model.providerID, modelID: model.modelID } : {}, signal);
			stream.markdown(vscode.l10n.t('Compacted the conversation to free up context.'));
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			const payload: Record<string, unknown> = { parts: [{ type: 'text', text: vscode.l10n.t('Summarize this conversation so far, keeping the decisions, open tasks, and important context.') }] };
			if (model) {
				payload.model = model;
			}
			await this.request(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', payload, signal);
			stream.markdown(vscode.l10n.t('Compacted the conversation to free up context.'));
		}
	}

	private async undoSession(session: NativeSession, stream: vscode.ChatResponseStream, signal: AbortSignal): Promise<void> {
		if (session.unmaterialized) {
			stream.markdown(vscode.l10n.t('There is nothing to undo in this session yet.'));
			return;
		}
		const messages = await this.request<KiloMessage[]>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'GET', undefined, signal);
		const last = messages.at(-1);
		if (!last) {
			stream.markdown(vscode.l10n.t('There is nothing to undo in this session yet.'));
			return;
		}
		await this.request(`/session/${encodeURIComponent(session.id)}/revert`, session.cwd, 'POST', { messageID: last.info.id }, signal);
		stream.markdown(vscode.l10n.t('Reverted the last message ({0}).', last.info.id.slice(0, 8)));
	}

	private async showMcpServers(session: NativeSession, stream: vscode.ChatResponseStream, signal: AbortSignal): Promise<void> {
		const servers = extractMcpServers(await this.request<unknown>('/mcp', session.cwd, 'GET', undefined, signal));
		if (servers.length === 0) {
			stream.markdown(vscode.l10n.t('No MCP servers are configured for this workspace.'));
			return;
		}
		const header = `| ${vscode.l10n.t('Server')} | ${vscode.l10n.t('Status')} | ${vscode.l10n.t('Details')} |`;
		const divider = '| --- | --- | --- |';
		const rows = servers.map(server => `| ${tableCell(server.name)} | ${tableCell(server.status)} | ${tableCell(server.detail ?? '—')} |`);
		stream.markdown([header, divider, ...rows].join('\n'));
	}

	private cancellationSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		return { signal: controller.signal, dispose: () => subscription.dispose() };
	}

	async executeCommand(session: NativeSession, command: string, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<boolean> {
		const name = command.trim().replace(/^\//, '').toLowerCase();
		const supported = ['compact', 'summarize', 'undo', 'redo', 'share', 'unshare', 'mcp'];
		if (!supported.includes(name)) {
			return false;
		}
		if (token.isCancellationRequested) {
			return true;
		}
		const cancellation = this.cancellationSignal(token);
		const sessionId = encodeURIComponent(session.id);
		try {
			switch (name) {
				case 'compact':
				case 'summarize': {
					if (argsText.trim()) {
						stream.markdown(vscode.l10n.t('Compaction ignores additional instructions; compacting the conversation now.'));
					}
					await this.compactSession(session, stream, options, cancellation.signal);
					return true;
				}
				case 'undo': {
					await this.undoSession(session, stream, cancellation.signal);
					return true;
				}
				case 'redo': {
					if (session.unmaterialized) {
						stream.markdown(vscode.l10n.t('There is nothing to redo in this session yet.'));
						return true;
					}
					await this.request(`/session/${sessionId}/unrevert`, session.cwd, 'POST', {}, cancellation.signal);
					stream.markdown(vscode.l10n.t('Restored the most recently reverted messages.'));
					return true;
				}
				case 'share': {
					if (session.unmaterialized) {
						stream.markdown(vscode.l10n.t('Send a message before sharing this session.'));
						return true;
					}
					const shared = await this.request<KiloSession>(`/session/${sessionId}/share`, session.cwd, 'POST', {}, cancellation.signal);
					const url = shared?.share?.url;
					stream.markdown(url
						? vscode.l10n.t('This session is shared at {0}', url)
						: vscode.l10n.t('This session is now shared.'));
					return true;
				}
				case 'unshare': {
					if (session.unmaterialized) {
						stream.markdown(vscode.l10n.t('This session is not shared.'));
						return true;
					}
					await this.request(`/session/${sessionId}/share`, session.cwd, 'DELETE', undefined, cancellation.signal);
					stream.markdown(vscode.l10n.t('Stopped sharing this session.'));
					return true;
				}
				case 'mcp': {
					await this.showMcpServers(session, stream, cancellation.signal);
					return true;
				}
			}
			return false;
		} finally {
			cancellation.dispose();
		}
	}

	private getEndpoint(): Promise<string> {
		if (!this.endpoint) {
			this.endpoint = new Promise<string>((resolve, reject) => {
				const child = this.child = spawnEngine(this.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], undefined, {
					...process.env,
					[`${this.envPrefix}_SERVER_USERNAME`]: 'aexus',
					[`${this.envPrefix}_SERVER_PASSWORD`]: this.password,
					[`${this.envPrefix}_PERMISSION`]: '{"*":"allow"}',
				});
				let output = '';
				const inspect = (data: Buffer) => {
					output = (output + String(data)).slice(-8000);
					const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
					if (address) { resolve(address); }
				};
				child.stdout.on('data', inspect);
				child.stderr.on('data', inspect);
				child.on('error', reject);
				child.on('exit', code => {
					this.endpoint = undefined;
					this.child = undefined;
					reject(new Error(vscode.l10n.t('{0} ended before its local connection was ready ({1}).', this.name, String(code))));
				});
			});
		}
		return this.endpoint;
	}

	protected async request<T>(route: string, cwd: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const url = new URL(route, await this.getEndpoint());
				url.searchParams.set('directory', cwd);
				const response = await fetch(url, {
					method,
					headers: { Authorization: `Basic ${Buffer.from(`aexus:${this.password}`).toString('base64')}`, 'Content-Type': 'application/json' },
					body: body ? JSON.stringify(body) : undefined,
					signal,
				});
				if (!response.ok) {
					throw new Error(vscode.l10n.t('{0} returned {1}: {2}', this.name, String(response.status), (await response.text()).slice(0, 2000)));
				}
				return response.status === 204 ? undefined as T : await response.json() as T;
			} catch (error) {
				lastError = error;
				if (attempt === 0 && !signal?.aborted) {
					if (this.child) {
						stopEngine(this.child);
						this.child = undefined;
					}
					this.endpoint = undefined;
					continue;
				}
				throw error;
			}
		}
		throw lastError;
	}

	protected session(item: KiloSession): NativeSession {
		const created = item.time?.created ?? item.created ?? Date.now();
		const updated = item.time?.updated ?? item.updated ?? created;
		const session: NativeSession = {
			id: item.id,
			parentId: item.parentID,
			cwd: item.directory,
			label: item.title || vscode.l10n.t('{0} Session {1}', this.name, item.id.slice(0, 8)),
			created,
			updated,
		};
		this.knownSessions.set(session.id, session);
		return session;
	}

	private belongsTo(id: string, parent: string): boolean {
		let session = this.knownSessions.get(id);
		while (session?.parentId && session.id !== parent) { session = this.knownSessions.get(session.parentId); }
		return session?.id === parent;
	}

	abstract list(token: vscode.CancellationToken): Promise<NativeSession[]>;

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		try {
			return await withTimeout(
				(async () => ({ ...this.session(await this.request<KiloSession>('/session', cwd, 'POST', {})), provisional: true }))(),
				6000,
			);
		} catch {
			return {
				id: randomUUID(),
				cwd,
				label: vscode.l10n.t('New {0} Session', this.name),
				created: now,
				updated: now,
				provisional: true,
				unmaterialized: true,
			};
		}
	}

	async prepareSession(session: NativeSession): Promise<void> {
		if (!session.unmaterialized) {
			return;
		}
		const created = this.session(await this.request<KiloSession>('/session', session.cwd, 'POST', {}));
		session.id = created.id;
		session.unmaterialized = false;
		session.provisional = false;
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		if (token.isCancellationRequested || session.unmaterialized) { return []; }
		return (await this.request<KiloSession[]>(`/session/${encodeURIComponent(session.id)}/children`, session.cwd)).map(child => this.session(child));
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested || session.unmaterialized) { return []; }
		const messages = await this.request<KiloMessage[]>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd);
		return messages.flatMap((message): HistoryEntry[] => message.info.role === 'user' || message.info.role === 'assistant'
			? [{ id: message.info.id, role: message.info.role, text: message.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n') }]
			: []);
	}

	private async answer(event: KiloEvent, data: KiloEventData, session: NativeSession, token: vscode.CancellationToken, autoApprove: boolean): Promise<void> {
		if (event.type === 'permission.asked') {
			if (autoApprove) {
				try {
					await this.request(`/permission/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { reply: 'always' });
				} catch {
					await this.request(`/permission/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { reply: 'once' });
				}
				return;
			}
			const allow = vscode.l10n.t('Allow Once');
			const picked = await vscode.window.showQuickPick([allow, vscode.l10n.t('Deny')], {
				title: vscode.l10n.t('{0} requests permission', this.name),
				placeHolder: `${session.cwd}: ${data.permission}: ${(data.patterns ?? []).join(', ')}`,
				ignoreFocusOut: true,
			}, token);
			await this.request(`/permission/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { reply: picked === allow ? 'once' : 'reject' });
		}
		if (event.type === 'question.asked') {
			const answers: string[][] = [];
			for (const question of data.questions ?? []) {
				if (question.multiple) {
					answers.push((await vscode.window.showQuickPick(question.options, {
						title: vscode.l10n.t('{0} — {1}', this.name, question.header),
						placeHolder: `${session.label} (${session.cwd}): ${question.question}`,
						canPickMany: true,
						ignoreFocusOut: true,
					}, token) ?? []).map(option => option.label));
				} else {
					const answer = await vscode.window.showQuickPick(question.options, {
						title: vscode.l10n.t('{0} — {1}', this.name, question.header),
						placeHolder: `${session.label} (${session.cwd}): ${question.question}`,
						ignoreFocusOut: true,
					}, token);
					answers.push(answer ? [answer.label] : []);
				}
			}
			await this.request(`/question/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { answers });
		}
	}

	async killSession(session: NativeSession): Promise<void> {
		if (this.endpoint) {
			await this.request(`/session/${encodeURIComponent(session.id)}/abort`, session.cwd, 'POST').catch(() => { });
		}
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		this.knownSessions.set(session.id, session);
		const abort = new AbortController();
		const url = new URL('/event', await this.getEndpoint());
		url.searchParams.set('directory', session.cwd);
		const response = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`aexus:${this.password}`).toString('base64')}` }, signal: abort.signal });
		if (!response.ok || !response.body) { throw new Error(vscode.l10n.t('{0} could not open its response stream.', this.name)); }
		let streamed = false;
		const parts = new Map<string, string>();
		const roles = new Map<string, string>();
		const reportedTools = new Set<string>();
		const reasoningText = new Map<string, string>();
		const emitReasoningDelta = (partId: string, delta: string): void => {
			if (!partId) { return; }
			reasoningText.set(partId, (reasoningText.get(partId) ?? '') + delta);
			emitThinkingProgress(stream, delta, `${this.id}-thinking`);
		};
		const emitReasoningSnapshot = (partId: string, text: string): void => {
			if (!partId) { return; }
			const previous = reasoningText.get(partId) ?? '';
			if (text.startsWith(previous)) {
				reasoningText.set(partId, text);
				if (text.length > previous.length) {
					emitThinkingProgress(stream, text.slice(previous.length), `${this.id}-thinking`);
				}
			} else if (!previous.startsWith(text)) {
				reasoningText.set(partId, text);
				emitThinkingProgress(stream, text, `${this.id}-thinking`);
			}
		};
		const reader = response.body.getReader();
		const events = (async () => {
			const decoder = new TextDecoder();
			let buffer = '';
			while (!abort.signal.aborted) {
				const chunk = await reader.read();
				if (chunk.done) { break; }
				buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
				let end: number;
				while ((end = buffer.indexOf('\n\n')) >= 0) {
					const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
					const raw = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
					if (!raw) { continue; }
					let event: KiloEvent;
					try {
						event = JSON.parse(raw) as KiloEvent;
					} catch {
						continue;
					}
					const data = event.properties ?? event.data;
					if (event.type === 'session.created' && data?.info?.parentID) { this.changed.fire([this.session(data.info as KiloSession)]); }
					const sessionId = data?.sessionID ?? data?.part?.sessionID ?? data?.info?.sessionID;
					if (sessionId && data?.info?.tokens) {
						const usage = turnUsageFromKiloTokens(data.info.tokens);
						if (usage) {
							this.lastTurnUsageBySession.set(sessionId, usage);
						}
					}
					if (data && sessionId && (event.type === 'permission.asked' || event.type === 'question.asked') && this.belongsTo(sessionId, session.id)) {
						const autoApprove = Boolean(options?.automatedEngineering) || options?.permissionMode !== 'ask';
						const targetSession = this.knownSessions.get(sessionId) ?? session;
						void this.answer(event, data, targetSession, token, autoApprove).catch(() => { });
					}
					if (!data || sessionId !== session.id) { continue; }
					if (event.type === 'message.updated' && data.info?.role) { roles.set(data.info.id, data.info.role); }
					if (event.type === 'message.part.updated' && data.part) {
						parts.set(data.part.id, data.part.type);
						if (data.part.type === 'tool') {
							this.reportToolProgress(stream, data.part, reportedTools);
						} else if (data.part.type === 'reasoning' && data.part.text) {
							emitReasoningSnapshot(data.part.id, data.part.text);
						}
					}
					if (event.type === 'message.part.delta' && data.field === 'text' && data.delta && roles.get(data.messageID!) === 'assistant') {
						const partType = parts.get(data.partID!);
						if (partType === 'text') {
							streamed = true;
							stream.markdown(data.delta);
						} else if (partType === 'reasoning') {
							emitReasoningDelta(data.partID!, data.delta);
						}
					}
				}
			}
		})();
		void events.catch(() => { });
		const cancellation = token.onCancellationRequested(() => {
			void this.request(`/session/${encodeURIComponent(session.id)}/abort`, session.cwd, 'POST').catch(() => { });
			abort.abort();
		});
		try {
			stream.progress(vscode.l10n.t('{0} is working…', this.name));
			const messageParts = this.messageParts(text, options?.attachments);
			const payloadBase: Record<string, unknown> = { parts: messageParts };
			const model = await this.resolveModel(options?.model, session.cwd);
			if (model) {
				payloadBase.model = model;
			}
			const agent = await this.resolveMode(options?.mode, session.cwd);
			if (agent) {
				payloadBase.agent = agent;
			}
			const variant = this.resolveVariant(options?.thinking);
			if (variant) {
				payloadBase.variant = variant;
			}
			let result: KiloMessage;
			try {
				result = await this.request<KiloMessage>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', payloadBase, abort.signal);
			} catch (err) {
				const hasOptionalFields = payloadBase.model !== undefined || payloadBase.agent !== undefined || payloadBase.variant !== undefined;
				if (!hasOptionalFields || abort.signal.aborted) {
					throw err;
				}
				// Retry once without optional routing fields (older servers reject unknown fields), keeping the prompt and attachments.
				result = await this.request<KiloMessage>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', { parts: messageParts }, abort.signal);
			}
			if (result.info.error) { throw new Error(result.info.error.data?.message || vscode.l10n.t('{0} could not complete this request.', this.name)); }
			if (!streamed) { for (const part of result.parts) { if (part.type === 'text' && part.text) { stream.markdown(part.text); } } }
		} finally {
			cancellation.dispose();
			abort.abort();
			await reader.cancel().catch(() => { });
		}
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (session.unmaterialized) {
			this.knownSessions.delete(session.id);
			return;
		}
		try {
			if (this.endpoint) {
				await this.request(`/session/${encodeURIComponent(session.id)}`, session.cwd, 'DELETE');
			} else {
				await capture(this.executable, ['session', 'delete', session.id], token);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (!message.includes('404') && !message.includes('not found') && !message.includes('does not exist')) {
				throw error;
			}
		}
		this.knownSessions.delete(session.id);
		for (const [id, entry] of [...this.knownSessions.entries()]) {
			if (entry.parentId === session.id) {
				this.knownSessions.delete(id);
			}
		}
	}

	dispose(): void { this.changed.dispose(); if (this.child) { stopEngine(this.child); } }
}

export class KiloRuntime extends SharedServerRuntime {
	readonly id = 'kilo';
	readonly name = 'Kilo Code';
	protected readonly envPrefix = 'KILO';

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		const output = await capture(this.executable, ['session', 'list', '--all', '--format', 'json'], token);
		return readJsonOutput<KiloSessionListItem[]>(output).map(item => {
			const entry: NativeSession = { id: item.id, cwd: item.directory, label: item.title, created: item.created, updated: item.updated };
			this.knownSessions.set(entry.id, entry);
			return entry;
		});
	}
}

export class OpenCodeRuntime extends SharedServerRuntime {
	readonly id = 'opencode';
	readonly name = 'OpenCode';
	protected readonly envPrefix = 'OPENCODE';

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		if (token.isCancellationRequested) { return []; }
		try {
			const items = await this.request<KiloSession[]>('/experimental/session?roots=true&limit=200', os.homedir());
			return items.map(item => this.session(item));
		} catch {
			const sql = 'SELECT id, directory, title, time_created AS created, time_updated AS updated FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_updated DESC';
			const output = await capture(this.executable, ['db', sql, '--format', 'json'], token);
			return readJsonOutput<KiloSessionListItem[]>(output).map(item => {
				const entry: NativeSession = { id: item.id, cwd: item.directory, label: item.title || vscode.l10n.t('OpenCode Session {0}', item.id.slice(0, 8)), created: item.created, updated: item.updated };
				this.knownSessions.set(entry.id, entry);
				return entry;
			});
		}
	}
}
