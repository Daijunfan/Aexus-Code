/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import * as vscode from 'vscode';
import { ROLE_INIT_MARKER, stripInjectedAdeContextFromUserTurn } from './roleBridgeShared';
import { capture, emitThinkingProgress, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineTurnTokenUsage, findExecutable, HistoryEntry, JsonLineClient, NativeSession, readJsonOutput, RpcPacket, withTimeout } from './runtime';

const execFile = promisify(cp.execFile);

interface AcpCapabilities {
	loadSession?: boolean;
	sessionCapabilities?: {
		list?: unknown;
		resume?: unknown;
		close?: unknown;
	};
}

interface AcpInitializeResult {
	protocolVersion?: number;
	agentCapabilities?: AcpCapabilities;
}

interface AcpContentBlock {
	type?: string;
	text?: string;
}

interface AcpSessionUpdate {
	sessionUpdate?: string;
	type?: string;
	content?: AcpContentBlock | AcpContentBlock[];
	text?: string;
	title?: string | null;
	updatedAt?: string | null;
	availableCommands?: Array<{ name?: string; description?: string }>;
	usage?: unknown;
}

function readTokenCount(record: Record<string, unknown>, ...keys: string[]): number {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}
	return 0;
}

function extractAcpTurnUsage(value: unknown, depth = 0): EngineTurnTokenUsage | undefined {
	if (!value || typeof value !== 'object' || depth > 3) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ['usage', 'tokenUsage', 'token_usage', 'tokens']) {
		const nested = record[key];
		if (nested && typeof nested === 'object') {
			const usage = extractAcpTurnUsage(nested, depth + 1);
			if (usage) {
				return usage;
			}
		}
	}
	const inputTokens = readTokenCount(record, 'inputTokens', 'input_tokens', 'input');
	const outputTokens = readTokenCount(record, 'outputTokens', 'output_tokens', 'output');
	const cacheReadTokens = readTokenCount(record, 'cacheReadTokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cacheRead');
	const cacheWriteTokens = readTokenCount(record, 'cacheWriteTokens', 'cache_creation_input_tokens', 'cacheWrite');
	const totalTokens = readTokenCount(record, 'totalTokens', 'total_tokens', 'total') || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
	if (totalTokens <= 0) {
		return undefined;
	}
	return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, estimated: false };
}

interface AcpSessionSetupResult {
	sessionId: string;
	models?: { availableModels?: Array<{ modelId?: string; id?: string; name?: string; description?: string }>; currentModelId?: string };
	modes?: { availableModes?: Array<{ id?: string; modeId?: string; name?: string; description?: string }>; currentModeId?: string };
	configOptions?: Array<{
		id?: string;
		name?: string;
		currentValue?: unknown;
		options?: Array<{
			value?: string;
			name?: string;
			description?: string;
			options?: Array<{ value?: string; name?: string; description?: string }>;
		}>;
	}>;
}

interface AcpPermissionOption {
	optionId: string;
	name?: string;
	kind: string;
}

interface AcpElicitationProperty {
	type?: string;
	title?: string;
	description?: string;
	enum?: string[];
	enumNames?: string[];
	oneOf?: { const: string; title?: string }[];
	items?: { enum?: string[]; anyOf?: { const: string; title?: string }[] };
	default?: unknown;
}

function extractAcpText(update: AcpSessionUpdate): string {
	if (typeof update.text === 'string') {
		return update.text;
	}
	const content = update.content;
	if (Array.isArray(content)) {
		return content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('');
	}
	if (content && typeof content === 'object' && (!content.type || content.type === 'text') && typeof content.text === 'string') {
		return content.text;
	}
	return '';
}

export abstract class AcpRuntime implements EngineRuntime {
	abstract readonly id: string;
	abstract readonly name: string;

	protected client: JsonLineClient | undefined;
	private ready: Promise<JsonLineClient> | undefined;
	protected agentCapabilities: AcpCapabilities | undefined;
	protected readonly openSessions = new Set<string>();
	protected readonly loadingSessions = new Set<string>();
	protected readonly knownSessions = new Map<string, NativeSession>();
	protected readonly changed = new vscode.EventEmitter<readonly NativeSession[]>();
	readonly onDidChangeSessions = this.changed.event;
	protected cachedDefaultModel: string | undefined;
	protected cachedModels: Array<{ id: string; name: string; description?: string }> = [];
	protected cachedModes: Array<{ id: string; name: string; description?: string }> = [];
	protected cachedCommands: Array<{ name: string; description?: string }> = [];
	protected cachedConfigOptionIds = new Set<string>();
	protected cachedModelConfigValues = new Set<string>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();

	consumeLastTurnUsage(sessionId: string): EngineTurnTokenUsage | undefined {
		const usage = this.lastTurnUsageBySession.get(sessionId);
		this.lastTurnUsageBySession.delete(sessionId);
		return usage;
	}

	constructor(
		protected readonly executable: string,
		private readonly args: readonly string[],
	) { }

	protected ingestSessionSetup(setup: Partial<AcpSessionSetupResult> | undefined): void {
		if (!setup) {
			return;
		}
		if (setup.models?.currentModelId?.trim()) {
			this.cachedDefaultModel = setup.models.currentModelId.trim();
		}
		let sawModelConfigOptions = false;
		if (Array.isArray(setup.configOptions)) {
			for (const opt of setup.configOptions) {
				const optId = (opt.id ?? '').trim();
				if (optId) {
					this.cachedConfigOptionIds.add(optId);
				}
				const flatOptions = (opt.options ?? []).flatMap(entry => Array.isArray(entry.options) ? entry.options : [entry]);
				if (optId === 'model') {
					const rawCur = typeof opt.currentValue === 'string' ? opt.currentValue.trim() : '';
					if (rawCur && !this.cachedDefaultModel) {
						try {
							const tuple = JSON.parse(rawCur) as unknown;
							this.cachedDefaultModel = Array.isArray(tuple) && typeof tuple[1] === 'string' ? tuple[1] : rawCur;
						} catch {
							this.cachedDefaultModel = rawCur;
						}
					}
					if (flatOptions.length > 0) {
						sawModelConfigOptions = true;
						const seen = new Set(this.cachedModels.map(m => m.id));
						for (const item of flatOptions) {
							const val = (item.value ?? '').trim();
							if (val) {
								this.cachedModelConfigValues.add(val);
								if (!seen.has(val)) {
									seen.add(val);
									this.cachedModels.push({ id: val, name: item.name?.trim() || val, description: item.description });
								}
							}
						}
					}
				} else if (optId === 'mode') {
					const seen = new Set(this.cachedModes.map(m => m.id));
					for (const item of flatOptions) {
						const val = (item.value ?? '').trim();
						if (val && !seen.has(val)) {
							seen.add(val);
							this.cachedModes.push({ id: val, name: item.name?.trim() || val, description: item.description });
						}
					}
				}
			}
		}
		if (!sawModelConfigOptions && Array.isArray(setup.models?.availableModels)) {
			const seen = new Set(this.cachedModels.map(m => m.id));
			for (const m of setup.models.availableModels) {
				const id = (m.modelId ?? m.id ?? '').trim();
				if (id && !seen.has(id)) {
					seen.add(id);
					this.cachedModels.push({ id, name: m.name?.trim() || id, description: m.description });
				}
			}
		}
		if (Array.isArray(setup.modes?.availableModes)) {
			const seen = new Set(this.cachedModes.map(m => m.id));
			for (const m of setup.modes.availableModes) {
				const id = (m.id ?? m.modeId ?? '').trim();
				if (id && !seen.has(id)) {
					seen.add(id);
					this.cachedModes.push({ id, name: m.name?.trim() || id, description: m.description });
				}
			}
		}
	}

	protected ingestAvailableCommands(commands: Array<{ name?: string; description?: string }> | undefined): void {
		if (!Array.isArray(commands)) {
			return;
		}
		const seen = new Set(this.cachedCommands.map(c => c.name.toLowerCase()));
		for (const cmd of commands) {
			const name = (cmd.name ?? '').trim().replace(/^\//, '');
			if (name && !seen.has(name.toLowerCase())) {
				seen.add(name.toLowerCase());
				this.cachedCommands.push({ name, description: cmd.description });
			}
		}
	}

	protected async buildSpawnEnv(): Promise<NodeJS.ProcessEnv | undefined> {
		return undefined;
	}

	protected ensureClient(): Promise<JsonLineClient> {
		if (this.client && !this.client.isClosed && this.ready) {
			return this.ready;
		}
		this.client?.dispose();
		this.client = undefined;
		this.openSessions.clear();
		this.loadingSessions.clear();
		this.ready = (async () => {
			const env = await this.buildSpawnEnv();
			const client = new JsonLineClient(this.executable, [...this.args], undefined, env);
			this.client = client;
			client.onPacket(packet => {
				if (packet.method === 'session/update') {
					const params = packet.params ?? {};
					const update = (params.update ?? params) as AcpSessionUpdate;
					if ((update.sessionUpdate ?? update.type) === 'available_commands_update') {
						this.ingestAvailableCommands(update.availableCommands);
					}
				}
			});
			const result = await client.request<AcpInitializeResult>('initialize', {
				protocolVersion: 1,
				clientInfo: { name: 'aexus-code', title: 'Aexus Code', version: '0.1.0' },
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
					elicitation: { form: {} },
				},
			});
			this.agentCapabilities = result?.agentCapabilities;
			return client;
		})();
		void this.ready.catch(() => {
			this.ready = undefined;
		});
		return this.ready;
	}

	protected async closeSession(sessionId: string): Promise<void> {
		if (!this.client || this.client.isClosed || !this.openSessions.has(sessionId)) {
			this.openSessions.delete(sessionId);
			return;
		}
		this.openSessions.delete(sessionId);
		await this.client.request('session/close', { sessionId }).catch(() => { });
	}

	protected async resetClient(): Promise<void> {
		const current = this.client;
		this.client = undefined;
		this.ready = undefined;
		this.openSessions.clear();
		this.loadingSessions.clear();
		if (current) {
			current.dispose();
			await current.waitForClose();
		}
	}

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		try {
			const created = await withTimeout((async () => {
				const client = await this.ensureClient();
				return client.request<AcpSessionSetupResult>('session/new', { cwd, mcpServers: [] });
			})(), 15000);
			this.ingestSessionSetup(created);
			const session: NativeSession = {
				id: created.sessionId,
				cwd,
				label: vscode.l10n.t('New {0} Session', this.name),
				created: now,
				updated: now,
				provisional: true,
			};
			this.openSessions.add(session.id);
			this.knownSessions.set(session.id, session);
			return session;
		} catch {
			void this.resetClient().catch(() => { });
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
		const client = await this.ensureClient();
		const created = await client.request<AcpSessionSetupResult>('session/new', { cwd: session.cwd, mcpServers: [] });
		this.ingestSessionSetup(created);
		session.id = created.sessionId;
		session.unmaterialized = false;
		this.openSessions.add(session.id);
		this.knownSessions.set(session.id, session);
	}

	protected async ensureSessionOpen(client: JsonLineClient, session: NativeSession): Promise<void> {
		if (this.openSessions.has(session.id)) {
			return;
		}
		if (this.agentCapabilities?.sessionCapabilities?.resume) {
			await client.request('session/resume', { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
		} else if (this.agentCapabilities?.loadSession) {
			this.loadingSessions.add(session.id);
			try {
				await client.request('session/load', { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
			} finally {
				this.loadingSessions.delete(session.id);
			}
		}
		this.openSessions.add(session.id);
	}

	protected async loadReplayedHistory(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested) { return []; }
		const client = await this.ensureClient();
		if (!this.agentCapabilities?.loadSession) { return []; }
		const entries: HistoryEntry[] = [];
		const appendChunk = (role: 'user' | 'assistant', text: string) => {
			if (!text) { return; }
			const last = entries.at(-1);
			if (last && last.role === role) {
				last.text += text;
			} else {
				entries.push({ id: `replay-${entries.length}`, role, text });
			}
		};
		this.loadingSessions.add(session.id);
		const listener = client.onPacket(packet => {
			if (packet.method !== 'session/update') { return; }
			const params = packet.params ?? {};
			if (params.sessionId !== session.id) { return; }
			const update = (params.update ?? params) as AcpSessionUpdate;
			const kind = update.sessionUpdate ?? update.type;
			if (kind === 'user_message_chunk') {
				appendChunk('user', extractAcpText(update));
			} else if (kind === 'agent_message_chunk') {
				appendChunk('assistant', extractAcpText(update));
			}
		});
		try {
			await client.request('session/load', { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
			this.openSessions.add(session.id);
		} finally {
			listener.dispose();
			this.loadingSessions.delete(session.id);
		}
		return entries;
	}

	private async handleServerRequest(client: JsonLineClient, packet: RpcPacket, session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		const params = packet.params ?? {};
		if (packet.method === 'session/request_permission') {
			const options = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [];
			const allowOption = options.find(opt => opt.kind === 'allow_once') ?? options.find(opt => opt.kind === 'allow_always');
			const rejectOption = options.find(opt => opt.kind === 'reject_once') ?? options.find(opt => opt.kind === 'reject_always');
			const toolCall = params.toolCall as { title?: string; kind?: string } | undefined;
			const detail = toolCall?.title || toolCall?.kind || vscode.l10n.t('Tool execution');
			const allowLabel = allowOption?.name || vscode.l10n.t('Allow Once');
			const denyLabel = rejectOption?.name || vscode.l10n.t('Deny');
			const picked = await vscode.window.showQuickPick([allowLabel, denyLabel], {
				title: vscode.l10n.t('{0} requests permission', this.name),
				placeHolder: `${session.cwd}: ${detail}`,
				ignoreFocusOut: true,
			}, token);
			let outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
			if (picked === allowLabel && allowOption) {
				outcome = { outcome: 'selected', optionId: allowOption.optionId };
			} else if (picked === denyLabel && rejectOption) {
				outcome = { outcome: 'selected', optionId: rejectOption.optionId };
			} else {
				outcome = { outcome: 'cancelled' };
			}
			client.write({ jsonrpc: '2.0', id: packet.id, result: { outcome } });
			return;
		}
		if (packet.method === 'elicitation/create') {
			if (params.mode === 'url') {
				client.write({ jsonrpc: '2.0', id: packet.id, result: { action: 'cancel' } });
				return;
			}
			const promptMessage = typeof params.message === 'string' ? params.message : vscode.l10n.t('{0} requests input', this.name);
			const schema = params.requestedSchema as { properties?: Record<string, AcpElicitationProperty>; required?: string[] } | undefined;
			const properties = schema?.properties ? Object.entries(schema.properties) : [];
			const required = new Set(schema?.required ?? []);
			if (properties.length === 0) {
				const accept = vscode.l10n.t('Accept');
				const picked = await vscode.window.showQuickPick([accept, vscode.l10n.t('Cancel')], {
					title: vscode.l10n.t('{0}', this.name),
					placeHolder: `${session.label} (${session.cwd}): ${promptMessage}`,
					ignoreFocusOut: true,
				}, token);
				client.write({ jsonrpc: '2.0', id: packet.id, result: picked === accept ? { action: 'accept', content: {} } : { action: 'cancel' } });
				return;
			}
			const content: Record<string, unknown> = {};
			for (const [key, prop] of properties) {
				const header = prop.title || key;
				const description = prop.description || promptMessage;
				if (prop.type === 'boolean') {
					const yes = vscode.l10n.t('Yes');
					const no = vscode.l10n.t('No');
					const picked = await vscode.window.showQuickPick([yes, no], {
						title: vscode.l10n.t('{0} — {1}', this.name, header),
						placeHolder: description,
						ignoreFocusOut: true,
					}, token);
					if (picked === undefined) {
						client.write({ jsonrpc: '2.0', id: packet.id, result: { action: 'cancel' } });
						return;
					}
					content[key] = picked === yes;
				} else if (Array.isArray(prop.enum) || Array.isArray(prop.oneOf)) {
					const choices = Array.isArray(prop.oneOf)
						? prop.oneOf.map(item => ({ label: item.title || item.const, value: item.const }))
						: (prop.enum ?? []).map((val, idx) => ({ label: prop.enumNames?.[idx] || val, value: val }));
					const picked = await vscode.window.showQuickPick(choices, {
						title: vscode.l10n.t('{0} — {1}', this.name, header),
						placeHolder: description,
						ignoreFocusOut: true,
					}, token);
					if (!picked) {
						client.write({ jsonrpc: '2.0', id: packet.id, result: { action: 'cancel' } });
						return;
					}
					content[key] = picked.value;
				} else if (prop.type === 'array' && (Array.isArray(prop.items?.enum) || Array.isArray(prop.items?.anyOf))) {
					const choices = Array.isArray(prop.items?.anyOf)
						? prop.items.anyOf.map(item => ({ label: item.title || item.const, value: item.const }))
						: (prop.items?.enum ?? []).map(val => ({ label: val, value: val }));
					const picked = await vscode.window.showQuickPick(choices, {
						title: vscode.l10n.t('{0} — {1}', this.name, header),
						placeHolder: description,
						canPickMany: true,
						ignoreFocusOut: true,
					}, token);
					if (!picked) {
						client.write({ jsonrpc: '2.0', id: packet.id, result: { action: 'cancel' } });
						return;
					}
					content[key] = picked.map(item => item.value);
				} else {
					const value = await vscode.window.showInputBox({
						title: vscode.l10n.t('{0} — {1}', this.name, header),
						prompt: description,
						value: typeof prop.default === 'string' ? prop.default : undefined,
						ignoreFocusOut: true,
					}, token);
					if (value === undefined) {
						if (required.has(key) || token.isCancellationRequested) {
							client.write({ jsonrpc: '2.0', id: packet.id, result: { action: 'cancel' } });
							return;
						}
						continue;
					}
					content[key] = (prop.type === 'number' || prop.type === 'integer') ? Number(value) : value;
				}
			}
			client.write({ jsonrpc: '2.0', id: packet.id, result: { action: 'accept', content } });
			return;
		}
		client.write({ jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: vscode.l10n.t('This engine request is not supported: {0}', packet.method ?? '') } });
	}

	async killSession(session: NativeSession): Promise<void> {
		if (this.client && !this.client.isClosed) {
			try {
				this.client.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.id } });
			} catch { /* ignore */ }
			await this.closeSession(session.id);
		}
	}

	async getRuntimeCapabilities(cwd: string, session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		if (this.cachedModels.length === 0 && this.cachedModes.length === 0 && this.cachedCommands.length === 0 && session && !session.unmaterialized) {
			try {
				const client = await withTimeout(this.ensureClient(), 8000);
				if (!this.openSessions.has(session.id) && cwd) {
					await withTimeout(this.ensureSessionOpen(client, session), 8000).catch(() => { });
				}
			} catch { /* Non-fatal capability probe. */ }
		}
		return {
			defaultModel: this.cachedDefaultModel,
			models: this.cachedModels,
			modes: this.cachedModes,
			commands: this.cachedCommands,
		};
	}

	async executeCommand(session: NativeSession, command: string, _argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<boolean> {
		const cmd = command.trim().toLowerCase();
		if (cmd === 'mcp') {
			const configCandidates = [
				path.join(session.cwd, '.mcp.json'),
				path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
				path.join(os.homedir(), '.dsh', 'mcp.json'),
				path.join(os.homedir(), '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
			];
			const serverNames = new Set<string>();
			for (const candidate of configCandidates) {
				try {
					const raw = await fs.readFile(candidate, 'utf8');
					const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
					for (const name of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) {
						serverNames.add(name);
					}
				} catch { /* Ignore missing config. */ }
			}
			const listText = serverNames.size > 0
				? [...serverNames].map(s => `- \`${s}\``).join('\n')
				: '- *(No MCP servers configured)*';
			stream.markdown(`### ${this.name} — MCP Servers\n\n${listText}\n`);
			return true;
		}
		if (cmd === 'history' && this.id === 'cline') {
			const items = await this.list(token).catch(() => [] as NativeSession[]);
			const recent = items.slice(0, 10);
			const lines = recent.length > 0
				? recent.map(item => `- **${item.label}** (\`${item.id.slice(0, 8)}\` · \`${item.cwd}\`)`).join('\n')
				: '- *(No recorded Cline tasks yet)*';
			stream.markdown(`### Cline Recent Tasks\n\n${lines}\n\n- **Active Mode**: \`${options?.mode || 'yolo'}\`\n- **Active Model**: \`${options?.model || 'default'}\`\n`);
			return true;
		}
		return false;
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		const client = await this.ensureClient();
		await this.ensureSessionOpen(client, session);
		if (options?.model && options.model !== 'default') {
			let normalizedModel = options.model.trim();
			if (this.id === 'dsh' && !normalizedModel.startsWith('[')) {
				const matchedTuple = this.cachedModels.find(m => {
					if (m.id === normalizedModel || m.name.toLowerCase() === normalizedModel.toLowerCase()) {
						return true;
					}
					try {
						const parsed = JSON.parse(m.id) as unknown;
						return Array.isArray(parsed) && (parsed[1] === normalizedModel || `${parsed[0]}/${parsed[1]}` === normalizedModel);
					} catch {
						return false;
					}
				});
				if (matchedTuple) {
					normalizedModel = matchedTuple.id;
				} else if (normalizedModel.includes('/')) {
					const idx = normalizedModel.indexOf('/');
					normalizedModel = JSON.stringify([normalizedModel.slice(0, idx), normalizedModel.slice(idx + 1)]);
				} else {
					normalizedModel = JSON.stringify(['deepseek-official', normalizedModel]);
				}
			} else if (this.id === 'cline' && normalizedModel.includes('/')) {
				const suffix = normalizedModel.slice(normalizedModel.indexOf('/') + 1);
				if (this.cachedModels.some(m => m.id === suffix)) {
					normalizedModel = suffix;
				}
			}
			if (this.id === 'dsh') {
				await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }).catch(() => { });
			} else if (this.id === 'antigravity') {
				if (this.cachedModelConfigValues.has(normalizedModel)) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }).catch(() => { });
				} else {
					await client.request('session/set_model', { sessionId: session.id, modelId: normalizedModel }).catch(() => { });
					if (this.cachedConfigOptionIds.has('model')) {
						await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }).catch(() => { });
					}
				}
			} else {
				await client.request('session/set_model', { sessionId: session.id, modelId: normalizedModel }).catch(() => { });
				if (this.cachedConfigOptionIds.has('model')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }).catch(() => { });
				}
			}
		}
		const effectiveMode = options?.mode && options.mode !== 'default'
			? options.mode
			: (this.id === 'cline' ? 'yolo' : this.id === 'antigravity' ? 'auto' : undefined);
		if (effectiveMode) {
			if (this.id === 'cline') {
				const clineSessionMode = effectiveMode === 'plan' ? 'plan' : 'act';
				await client.request('session/set_mode', { sessionId: session.id, modeId: clineSessionMode }).catch(() => { });
				if (this.cachedConfigOptionIds.has('mode')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'mode', value: clineSessionMode }).catch(() => { });
				}
				if (this.cachedConfigOptionIds.has('auto_approve')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'auto_approve', value: effectiveMode === 'yolo' }).catch(() => { });
				}
			} else {
				await client.request('session/set_mode', { sessionId: session.id, modeId: effectiveMode }).catch(() => { });
				if (this.cachedConfigOptionIds.has('mode')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'mode', value: effectiveMode }).catch(() => { });
				}
			}
		}
		if (options?.thinking && options.thinking !== 'default') {
			const normalizedThinking = options.thinking === 'none' ? 'off' : options.thinking === 'xhigh' || options.thinking === 'extra-high' ? 'high' : options.thinking;
			if (this.cachedConfigOptionIds.has('thought_level')) {
				const agyLevel = normalizedThinking === 'off' ? 'low' : (normalizedThinking === 'max' ? 'high' : normalizedThinking);
				await client.request('session/set_config_option', { sessionId: session.id, configId: 'thought_level', value: agyLevel }).catch(() => { });
			}
			if (this.cachedConfigOptionIds.has('reasoning_effort')) {
				await client.request('session/set_config_option', { sessionId: session.id, configId: 'reasoning_effort', value: normalizedThinking }).catch(() => { });
			}
		}
		const autoApprove = Boolean(options?.automatedEngineering)
			|| (options?.permissionMode !== 'ask' && options?.mode !== 'ask' && options?.mode !== 'plan');
		this.knownSessions.set(session.id, session);
		const listener = client.onPacket(packet => {
			const params = packet.params ?? {};
			if (packet.id !== undefined && packet.method) {
				const targetSessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
				if (!targetSessionId || targetSessionId === session.id) {
					if (packet.method === 'session/request_permission' && autoApprove) {
						const permOpts = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [];
						const allowOpt = permOpts.find(opt => opt.kind === 'allow_always') ?? permOpts.find(opt => opt.kind === 'allow_once') ?? permOpts[0];
						if (allowOpt) {
							client.write({ jsonrpc: '2.0', id: packet.id, result: { outcome: { outcome: 'selected', optionId: allowOpt.optionId } } });
							return;
						}
					}
					void this.handleServerRequest(client, packet, session, token).catch(() => { });
				}
				return;
			}
			if (packet.method !== 'session/update' || params.sessionId !== session.id || this.loadingSessions.has(session.id)) {
				return;
			}
			const update = (params.update ?? params) as AcpSessionUpdate;
			const updateUsage = extractAcpTurnUsage(update.usage ?? params.usage);
			if (updateUsage) {
				this.lastTurnUsageBySession.set(session.id, updateUsage);
			}
			const kind = update.sessionUpdate ?? update.type;
			if (!token.isCancellationRequested && kind === 'agent_message_chunk') {
				const chunk = extractAcpText(update);
				if (chunk) { stream.markdown(chunk); }
			} else if (!token.isCancellationRequested && (kind === 'agent_thought_chunk' || kind === 'thought_chunk')) {
				const thought = extractAcpText(update);
				if (thought) { emitThinkingProgress(stream, thought, `${this.id}-thinking`); }
			} else if (!token.isCancellationRequested && (kind === 'tool_call' || kind === 'tool_call_update')) {
				const toolTitle = typeof update.title === 'string' && update.title.trim() ? update.title.trim() : undefined;
				if (toolTitle || kind === 'tool_call') {
					stream.progress(toolTitle ?? vscode.l10n.t('{0} is working…', this.name));
				}
			} else if (kind === 'available_commands_update') {
				this.ingestAvailableCommands(update.availableCommands);
			} else if (kind === 'session_info_update' && typeof update.title === 'string' && update.title.trim()) {
				session.label = update.title.trim();
				this.changed.fire([session]);
			}
		});
		const cancellation = token.onCancellationRequested(() => {
			try { client.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.id } }); } catch { /* Connection may already be closed. */ }
		});
		try {
			const promptParts: Array<Record<string, unknown>> = [];
			if (options?.attachments?.length) {
				for (const att of options.attachments) {
					if (att.kind === 'image') {
						try {
							const buf = await fs.readFile(att.filePath);
							promptParts.push({
								type: 'image',
								mimeType: att.mimeType || 'image/png',
								data: buf.toString('base64'),
							});
						} catch { /* Ignore unreadable attachment. */ }
					}
				}
			}
			let finalPromptText = text;
			if (this.id === 'cline' && options?.mode === 'plan' && !this.cachedModes.some(m => m.id === 'plan')) {
				finalPromptText = `[Mode: Plan Mode — Analyze the codebase and present a clear step-by-step plan without modifying files until confirmed.]\n\n${text}`;
			}
			promptParts.push({ type: 'text', text: finalPromptText });
			await client.request('session/prompt', { sessionId: session.id, prompt: promptParts });
			session.provisional = false;
		} finally {
			listener.dispose();
			cancellation.dispose();
		}
	}

	abstract list(token: vscode.CancellationToken): Promise<NativeSession[]>;
	abstract history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]>;
	abstract delete(session: NativeSession, token: vscode.CancellationToken): Promise<void>;

	dispose(): void {
		this.changed.dispose();
		this.client?.dispose();
		this.client = undefined;
	}
}

// ---------------------------------------------------------------------------
// DeepSeek Harness (dsh --profile acp)
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xFD2FB528;
const ZSTD_SKIPPABLE_MIN = 0x184D2A50;
const ZSTD_SKIPPABLE_MAX = 0x184D2A5F;

function findZstdFrameEnd(buffer: Buffer, start: number): number | undefined {
	let p = start + 4;
	if (p >= buffer.length) { return undefined; }
	const fhd = buffer[p++];
	const singleSegment = (fhd & 0x20) !== 0;
	const checksumFlag = (fhd & 0x04) !== 0;
	const dictIdFlag = fhd & 0x03;
	const fcsFlag = (fhd >> 6) & 0x03;
	if (!singleSegment) { p += 1; }
	p += [0, 1, 2, 4][dictIdFlag];
	p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : (1 << fcsFlag);
	while (true) {
		if (p + 3 > buffer.length) { return undefined; }
		const hdr = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
		p += 3;
		const lastBlock = hdr & 1;
		const blockType = (hdr >> 1) & 3;
		const blockSize = hdr >> 3;
		if (blockType === 3) { return undefined; }
		p += blockType === 1 ? 1 : blockSize;
		if (p > buffer.length) { return undefined; }
		if (lastBlock) { break; }
	}
	if (checksumFlag) { p += 4; }
	return p <= buffer.length ? p : undefined;
}

export function decodeDshLogBuffer(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): string {
	if (buffer.length < 4) {
		return buffer.toString('utf8');
	}
	const firstMagic = buffer.readUInt32LE(0);
	if (firstMagic !== ZSTD_MAGIC && (firstMagic < ZSTD_SKIPPABLE_MIN || firstMagic > ZSTD_SKIPPABLE_MAX)) {
		return buffer.toString('utf8');
	}
	const chunks: Buffer[] = [];
	let offset = 0;
	let frames = 0;
	while (offset + 4 <= buffer.length && frames < maxFrames) {
		const magic = buffer.readUInt32LE(offset);
		if (magic >= ZSTD_SKIPPABLE_MIN && magic <= ZSTD_SKIPPABLE_MAX) {
			if (offset + 8 > buffer.length) { break; }
			const skip = buffer.readUInt32LE(offset + 4);
			offset += 8 + skip;
			continue;
		}
		if (magic !== ZSTD_MAGIC) { break; }
		const frameEnd = findZstdFrameEnd(buffer, offset);
		if (frameEnd === undefined) {
			if (chunks.length === 0) {
				try { return zlib.zstdDecompressSync(buffer).toString('utf8'); } catch { return ''; }
			}
			break;
		}
		try {
			chunks.push(zlib.zstdDecompressSync(buffer.subarray(offset, frameEnd)));
			frames++;
		} catch {
			if (chunks.length === 0) {
				try { return zlib.zstdDecompressSync(buffer).toString('utf8'); } catch { return ''; }
			}
			break;
		}
		offset = frameEnd;
	}
	return Buffer.concat(chunks).toString('utf8');
}

interface DshProjCacheRow<T = unknown> {
	val?: T;
}

interface DshProjCacheFile {
	record?: {
		identity?: {
			createdAt?: number;
			cwd?: string;
			origin?: string;
			parentSessionId?: string;
			parentId?: string;
		};
		rows?: {
			title?: DshProjCacheRow<string | { title?: string }>;
			workingDirectory?: DshProjCacheRow<string | { cwd?: string }>;
			subagent?: DshProjCacheRow<{ origin?: string; parentSessionId?: string; parentId?: string }>;
			sessionListMetadata?: DshProjCacheRow<{ origin?: string; parentSessionId?: string; parentId?: string; lastPromptAt?: number }>;
		};
		cwd?: string;
		title?: string;
		createdAt?: number;
		updatedAt?: number;
		updated?: number;
		origin?: string;
		parentSessionId?: string;
		parentId?: string;
	};
}

interface DshEvent {
	type?: string;
	id?: string;
	cwd?: string;
	createdAt?: number;
	origin?: string;
	parentSessionId?: string;
	parentId?: string;
	data?: {
		id?: string;
		title?: string;
		origin?: string;
		parentSessionId?: string;
		parentId?: string;
		source?: { kind?: string };
		content?: { type?: string; text?: string }[];
		message?: {
			id?: string;
			role?: string;
			content?: { type?: string; text?: string }[];
		};
	};
}

interface DshDiscoveredSession extends NativeSession {
	origin?: string;
}

export class DshRuntime extends AcpRuntime {
	readonly id = 'dsh';
	readonly name = 'DeepSeek Harness';

	constructor(executable: string) {
		super(executable, ['--profile', 'acp']);
	}

	private dshHome(): string {
		return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
	}

	private async scanSessions(token: vscode.CancellationToken): Promise<DshDiscoveredSession[]> {
		const home = this.dshHome();
		const projDir = path.join(home, 'storages', 'session_projcache', 'sessions');
		const sessionsRoot = path.join(home, 'sessions');

		const projMap = new Map<string, DshProjCacheFile['record']>();
		try {
			const projEntries = await fs.readdir(projDir);
			await Promise.all(projEntries.filter(name => name.endsWith('.json')).map(async name => {
				try {
					const raw = JSON.parse(await fs.readFile(path.join(projDir, name), 'utf8')) as DshProjCacheFile;
					const id = name.slice(0, -'.json'.length);
					projMap.set(id, raw.record ?? (raw as DshProjCacheFile['record']));
				} catch { /* Ignore unreadable cache entry. */ }
			}));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		}

		const dirLocations = new Map<string, { dir: string; logFile?: string; mtimeMs: number; birthtimeMs: number }>();
		try {
			const workspaces = await fs.readdir(sessionsRoot, { withFileTypes: true });
			for (const ws of workspaces) {
				if (token.isCancellationRequested) { break; }
				if (!ws.isDirectory()) { continue; }
				const wsPath = path.join(sessionsRoot, ws.name);
				let sessionDirs: import('node:fs').Dirent[];
				try { sessionDirs = await fs.readdir(wsPath, { withFileTypes: true }); } catch { continue; }
				for (const entry of sessionDirs) {
					if (!entry.isDirectory()) { continue; }
					const sessionDir = path.join(wsPath, entry.name);
					try {
						const files = await fs.readdir(sessionDir);
						const logName = files.find(f => f.endsWith('.jsonl.zstd')) ?? files.find(f => f.endsWith('.jsonl'));
						const targetPath = logName ? path.join(sessionDir, logName) : sessionDir;
						const stat = await fs.stat(targetPath);
						dirLocations.set(entry.name, {
							dir: sessionDir,
							logFile: logName ? path.join(sessionDir, logName) : undefined,
							mtimeMs: stat.mtimeMs,
							birthtimeMs: stat.birthtimeMs,
						});
					} catch { /* Ignore transient session directory race. */ }
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
		}

		const allIds = new Set<string>([...dirLocations.keys(), ...projMap.keys()]);
		const discovered: DshDiscoveredSession[] = [];
		for (const id of allIds) {
			if (token.isCancellationRequested) { break; }
			const loc = dirLocations.get(id);
			const proj = projMap.get(id);
			if (!loc?.logFile && !proj) { continue; }

			const identity = proj?.identity;
			const rows = proj?.rows;
			const workDirVal = rows?.workingDirectory?.val;
			const titleVal = rows?.title?.val;
			const subagentVal = rows?.subagent?.val;
			const listMetaVal = rows?.sessionListMetadata?.val;

			let cwd = (typeof workDirVal === 'string' ? workDirVal : workDirVal?.cwd) || identity?.cwd || proj?.cwd;
			let title = (typeof titleVal === 'string' ? titleVal : titleVal?.title) || proj?.title;
			let created = identity?.createdAt ?? proj?.createdAt ?? loc?.birthtimeMs ?? Date.now();
			const updated = Math.max(loc?.mtimeMs ?? 0, listMetaVal?.lastPromptAt ?? 0, proj?.updatedAt ?? 0, proj?.updated ?? 0) || created;
			let parentId = identity?.parentSessionId ?? identity?.parentId ?? subagentVal?.parentSessionId ?? subagentVal?.parentId ?? listMetaVal?.parentSessionId ?? listMetaVal?.parentId ?? proj?.parentSessionId ?? proj?.parentId;
			let origin = identity?.origin ?? subagentVal?.origin ?? listMetaVal?.origin ?? proj?.origin ?? (parentId ? 'subagent' : undefined);

			if ((!cwd || !title) && loc?.logFile) {
				try {
					const decoded = decodeDshLogBuffer(await fs.readFile(loc.logFile), 8);
					for (const line of decoded.split('\n')) {
						if (!line) { continue; }
						let event: DshEvent;
						try { event = JSON.parse(line) as DshEvent; } catch { continue; }
						if (event.type === 'session') {
							cwd ||= event.cwd;
							created = event.createdAt ?? created;
							origin ||= event.origin ?? event.data?.origin;
							parentId ||= event.parentSessionId ?? event.parentId ?? event.data?.parentSessionId ?? event.data?.parentId;
						} else if (!title && event.type === 'session/title' && event.data?.title) {
							title = event.data.title;
						} else if (!title && event.type === 'user/message' && event.data?.source?.kind === 'user') {
							const userText = (event.data.content ?? []).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text ?? '').join('\n').trim();
							if (userText) { title = userText.split('\n')[0].slice(0, 100); }
						}
					}
				} catch { /* Ignore unreadable log frames. */ }
			}

			if (!cwd) { continue; }
			const session: DshDiscoveredSession = {
				id,
				parentId,
				readOnly: origin === 'subagent' || !!parentId,
				cwd,
				label: title?.trim() || vscode.l10n.t('DeepSeek Harness {0}', id.replace(/^session-/, '').slice(0, 8)),
				created,
				updated,
				file: loc?.logFile,
				provisional: false,
				origin: origin ?? (parentId ? 'subagent' : undefined),
			};
			this.knownSessions.set(session.id, session);
			discovered.push(session);
		}
		return discovered.sort((a, b) => b.updated - a.updated);
	}

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		const all = await this.scanSessions(token);
		return all.filter(session => session.origin !== 'subagent' && !session.parentId);
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		const all = await this.scanSessions(token);
		return all.filter(item => item.origin === 'subagent' && item.parentId === session.id);
	}

	private async findLogFile(sessionId: string): Promise<string | undefined> {
		const sessionsRoot = path.join(this.dshHome(), 'sessions');
		try {
			for (const ws of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
				if (!ws.isDirectory()) { continue; }
				const candidateDir = path.join(sessionsRoot, ws.name, sessionId);
				try {
					const files = await fs.readdir(candidateDir);
					const logName = files.find(f => f.endsWith('.jsonl.zstd')) ?? files.find(f => f.endsWith('.jsonl'));
					if (logName) { return path.join(candidateDir, logName); }
				} catch { /* Check next workspace directory. */ }
			}
		} catch { /* Sessions root does not exist yet. */ }
		return undefined;
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested || session.unmaterialized) { return []; }
		const file = session.file ?? await this.findLogFile(session.id);
		if (!file) { return []; }
		session.file = file;
		let buffer: Buffer;
		try {
			buffer = await fs.readFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
			throw error;
		}
		const text = decodeDshLogBuffer(buffer);
		const entries: HistoryEntry[] = [];
		for (const line of text.split('\n')) {
			if (token.isCancellationRequested) { break; }
			if (!line) { continue; }
			let event: DshEvent;
			try { event = JSON.parse(line) as DshEvent; } catch { continue; }
			if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
				const content = event.data.content ?? event.data.message?.content ?? [];
				const body = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n').trim();
				if (body) {
					entries.push({ id: event.data.id ?? `user-${entries.length}`, role: 'user', text: body });
				}
			} else if (event.type === 'assistant/message') {
				const content = event.data?.message?.content ?? event.data?.content ?? [];
				const body = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n').trim();
				if (body) {
					entries.push({ id: event.data?.message?.id ?? event.data?.id ?? `assistant-${entries.length}`, role: 'assistant', text: body });
				}
			}
		}
		return entries;
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (session.unmaterialized) {
			this.knownSessions.delete(session.id);
			return;
		}
		for (const child of await this.children(session, token)) {
			await this.delete(child, token);
		}
		await this.closeSession(session.id);
		this.knownSessions.delete(session.id);
		const home = this.dshHome();
		if (session.file) {
			await fs.rm(path.dirname(session.file), { recursive: true, force: true });
		}
		const sessionsRoot = path.join(home, 'sessions');
		try {
			for (const ws of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
				if (ws.isDirectory()) {
					await fs.rm(path.join(sessionsRoot, ws.name, session.id), { recursive: true, force: true });
				}
			}
		} catch { /* Ignore missing sessions root. */ }
		await fs.rm(path.join(home, 'storages', 'session_projcache', 'sessions', `${session.id}.json`), { force: true });
	}
}

// ---------------------------------------------------------------------------
// Google Antigravity (agy acp)
// ---------------------------------------------------------------------------

interface AgyListResponse {
	sessions?: {
		sessionId: string;
		cwd: string;
		title?: string | null;
		updatedAt?: string | null;
	}[];
	nextCursor?: string | null;
}

interface AgySummaryRow {
	conversation_id: string;
	title: string;
	preview: string;
	last_modified_time: string;
	workspace_uris: string;
	parent_conversation_id: string;
	last_user_input_time: string;
}

interface AgyTranscriptStep {
	step_index?: number;
	source?: string;
	type?: string;
	content?: string;
}

export class AntigravityRuntime extends AcpRuntime {
	readonly id = 'antigravity';
	readonly name = 'Google Antigravity';

	constructor(executable: string) {
		super(executable, ['acp', '--app_data_dir=antigravity']);
	}

	private agyHomes(): string[] {
		return [
			path.join(os.homedir(), '.gemini', 'antigravity'),
			path.join(os.homedir(), '.gemini', 'antigravity-cli'),
		];
	}

	private parseTimestamp(value: string | null | undefined, fallback: number): number {
		if (!value) { return fallback; }
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) && parsed > 946684800000 ? parsed : fallback;
	}

	private async listFromSqlite(): Promise<NativeSession[]> {
		const seen = new Set<string>();
		const result: NativeSession[] = [];
		const query = 'SELECT conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time FROM conversation_summaries WHERE parent_conversation_id = \'\' AND killed = 0 ORDER BY last_modified_time DESC;';
		const sqliteBin = process.platform === 'darwin'
			? '/usr/bin/sqlite3'
			: (await findExecutable('sqlite3') ?? 'sqlite3');
		for (const home of this.agyHomes()) {
			const dbPath = path.join(home, 'conversation_summaries.db');
			try {
				await fs.access(dbPath);
			} catch {
				continue;
			}
			try {
				const { stdout } = await execFile(sqliteBin, ['-json', dbPath, query]);
				if (!stdout.trim()) { continue; }
				const rows = JSON.parse(stdout) as AgySummaryRow[];
				for (const row of rows) {
					if (seen.has(row.conversation_id)) { continue; }
					seen.add(row.conversation_id);
					let cwd = os.homedir();
					try {
						const uris = JSON.parse(row.workspace_uris) as string[];
						if (uris.length > 0) {
							cwd = vscode.Uri.parse(uris[0]).fsPath || cwd;
						}
					} catch { /* Keep home directory fallback. */ }
					const now = Date.now();
					const updated = this.parseTimestamp(row.last_modified_time, this.parseTimestamp(row.last_user_input_time, now));
					const cleanedTitle = stripInjectedAdeContextFromUserTurn(row.title || row.preview || '');
					const label = (cleanedTitle.trimStart().startsWith(ROLE_INIT_MARKER) ? '' : cleanedTitle).split('\n')[0].slice(0, 100)
						|| vscode.l10n.t('Antigravity Session {0}', row.conversation_id.slice(0, 8));
					const session: NativeSession = { id: row.conversation_id, cwd, label, created: updated, updated, provisional: false };
					this.knownSessions.set(session.id, session);
					result.push(session);
				}
			} catch { /* Ignore unreadable index database in one data root. */ }
		}
		return result.sort((a, b) => b.updated - a.updated);
	}

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		if (token.isCancellationRequested) { return []; }
		try {
			const client = await this.ensureClient();
			if (this.agentCapabilities?.sessionCapabilities?.list) {
				const sessions: NativeSession[] = [];
				const seenCursors = new Set<string>();
				let cursor: string | undefined;
				do {
					if (token.isCancellationRequested) { break; }
					const page = await client.request<AcpListResponse>('session/list', cursor ? { cursor } : {});
					for (const item of page.sessions ?? []) {
						const updated = this.parseTimestamp(item.updatedAt, Date.now());
						const entry: NativeSession = {
							id: item.sessionId,
							cwd: item.cwd || os.homedir(),
							label: item.title?.trim() || vscode.l10n.t('Antigravity Session {0}', item.sessionId.slice(0, 8)),
							created: updated,
							updated,
							provisional: false,
						};
						this.knownSessions.set(entry.id, entry);
						sessions.push(entry);
					}
					const next = page.nextCursor ?? undefined;
					if (!next || seenCursors.has(next)) { break; }
					seenCursors.add(next);
					cursor = next;
				} while (cursor);
				return sessions;
			}
		} catch { /* Fall back to local SQLite summary index without invoking authenticate. */ }
		return this.listFromSqlite();
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested || session.unmaterialized) { return []; }
		let raw: string | undefined;
		for (const home of this.agyHomes()) {
			const logsDir = path.join(home, 'brain', session.id, '.system_generated', 'logs');
			for (const filename of ['transcript_full.jsonl', 'transcript.jsonl']) {
				try {
					raw = await fs.readFile(path.join(logsDir, filename), 'utf8');
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
				}
			}
			if (raw !== undefined) { break; }
		}
		if (raw !== undefined) {
			const entries: HistoryEntry[] = [];
			for (const line of raw.split('\n')) {
				if (!line) { continue; }
				let step: AgyTranscriptStep;
				try { step = JSON.parse(line) as AgyTranscriptStep; } catch { continue; }
				if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT' && typeof step.content === 'string') {
					const unwrapped = step.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
					const text = (unwrapped ? unwrapped[1] : step.content).trim();
					if (text) {
						entries.push({ id: `step-${step.step_index ?? entries.length}`, role: 'user', text });
					}
				} else if (step.type === 'PLANNER_RESPONSE' && typeof step.content === 'string' && step.content.trim()) {
					entries.push({ id: `step-${step.step_index ?? entries.length}`, role: 'assistant', text: step.content.trim() });
				}
			}
			return entries;
		}
		if (session.provisional) { return []; }
		return this.loadReplayedHistory(session, token).catch(() => []);
	}

	private async cleanJsonCacheFile(filePath: string, sessionId: string): Promise<void> {
		let content: string;
		try {
			content = await fs.readFile(filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
			throw error;
		}
		let data: Record<string, unknown>;
		try { data = JSON.parse(content) as Record<string, unknown>; } catch { return; }
		let dirty = false;
		if (Object.hasOwn(data, sessionId)) {
			delete data[sessionId];
			dirty = true;
		}
		if (data.conversations && typeof data.conversations === 'object' && !Array.isArray(data.conversations)) {
			const conversations = data.conversations as Record<string, unknown>;
			if (Object.hasOwn(conversations, sessionId)) {
				delete conversations[sessionId];
				dirty = true;
			}
		}
		for (const [key, value] of Object.entries(data)) {
			if (value === sessionId) {
				delete data[key];
				dirty = true;
			}
		}
		if (dirty) {
			await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
		}
	}

	async delete(session: NativeSession, _token: vscode.CancellationToken): Promise<void> {
		if (session.unmaterialized) {
			this.knownSessions.delete(session.id);
			return;
		}
		await this.closeSession(session.id);
		if (this.client && !this.client.isClosed) {
			await this.resetClient();
		}
		this.knownSessions.delete(session.id);
		for (const root of this.agyHomes()) {
			const convBase = path.join(root, 'conversations', session.id);
			await Promise.all([
				fs.rm(`${convBase}.db`, { force: true }),
				fs.rm(`${convBase}.db-wal`, { force: true }),
				fs.rm(`${convBase}.db-shm`, { force: true }),
				fs.rm(path.join(root, 'brain', session.id), { recursive: true, force: true }),
			]);
			const dbPath = path.join(root, 'conversation_summaries.db');
			if (/^[0-9a-f-]+$/i.test(session.id)) {
				await execFile('/usr/bin/sqlite3', ['-bail', dbPath, `DELETE FROM conversation_summaries WHERE conversation_id = '${session.id}';`]).catch(() => { });
			}
			await Promise.all([
				this.cleanJsonCacheFile(path.join(root, 'cache', 'conversation_metadata.json'), session.id),
				this.cleanJsonCacheFile(path.join(root, 'cache', 'last_conversations.json'), session.id),
			]);
		}
	}
}

// Re-alias internal page interface name used above for strict typing
type AcpListResponse = AgyListResponse;

// ---------------------------------------------------------------------------
// Cline (cline --acp)
// ---------------------------------------------------------------------------

interface ClineProvidersFile {
	lastUsedProvider?: string;
	providers?: Record<string, {
		settings?: {
			provider?: string;
			apiKey?: string;
			model?: string;
		};
	}>;
}

interface ClineHistoryItem {
	sessionId: string;
	cwd?: string;
	workspaceRoot?: string;
	startedAt?: string;
	updatedAt?: string;
	endedAt?: string;
	isSubagent?: boolean;
	parentSessionId?: string;
	prompt?: string;
	messagesPath?: string;
	metadata?: {
		title?: string;
		parentSessionId?: string;
	};
}

interface ClineMessageBlock {
	type?: string;
	text?: string;
}

interface ClineStoredMessage {
	role?: string;
	content?: string | ClineMessageBlock[];
}

function unwrapClineUserInput(raw: string): string {
	const match = raw.match(/<user_input[^>]*>([\s\S]*?)<\/user_input>/);
	if (match) {
		return match[1].trim();
	}
	return raw.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '').trim();
}

export class ClineRuntime extends AcpRuntime {
	readonly id = 'cline';
	readonly name = 'Cline';

	constructor(executable: string) {
		super(executable, ['--acp']);
	}

	private clineDataDir(): string {
		const clineHome = process.env.CLINE_DIR?.trim() || path.join(os.homedir(), '.cline');
		return path.join(clineHome, 'data');
	}

	protected override async buildSpawnEnv(): Promise<NodeJS.ProcessEnv | undefined> {
		try {
			const raw = await fs.readFile(path.join(this.clineDataDir(), 'settings', 'providers.json'), 'utf8');
			const parsed = JSON.parse(raw) as ClineProvidersFile;
			const providerId = parsed.lastUsedProvider?.trim();
			if (!providerId || ['cline', 'cline-pass', 'openai-codex'].includes(providerId)) {
				return undefined;
			}
			const settings = parsed.providers?.[providerId]?.settings;
			if (!settings?.apiKey?.trim()) {
				return undefined;
			}
			const env: NodeJS.ProcessEnv = {
				...process.env,
				CLINE_PROVIDER: settings.provider?.trim() || providerId,
				CLINE_API_KEY: settings.apiKey,
			};
			if (settings.model?.trim()) {
				env.CLINE_MODEL = settings.model.trim();
			}
			return env;
		} catch {
			return undefined;
		}
	}

	override async create(cwd: string): Promise<NativeSession> {
		const session = await super.create(cwd);
		session.provisional = true;
		return session;
	}

	private async fetchHistoryItems(token: vscode.CancellationToken): Promise<ClineHistoryItem[]> {
		const output = await withTimeout(capture(this.executable, ['history', '--json', '--limit', '500'], token), 8000);
		const parsed = readJsonOutput<ClineHistoryItem[] | { sessions?: ClineHistoryItem[]; items?: ClineHistoryItem[] }>(output);
		return Array.isArray(parsed) ? parsed : (parsed.sessions ?? parsed.items ?? []);
	}

	private toNativeSession(item: ClineHistoryItem): NativeSession {
		const created = item.startedAt ? Date.parse(item.startedAt) : Date.now();
		const updated = (item.updatedAt ? Date.parse(item.updatedAt) : undefined) || (item.endedAt ? Date.parse(item.endedAt) : undefined) || created;
		const parentId = item.parentSessionId ?? item.metadata?.parentSessionId;
		const cleanedPrompt = stripInjectedAdeContextFromUserTurn(unwrapClineUserInput(item.prompt ?? ''));
		const rawTitle = item.metadata?.title || (cleanedPrompt.trimStart().startsWith(ROLE_INIT_MARKER) ? '' : cleanedPrompt);
		const session: NativeSession = {
			id: item.sessionId,
			parentId,
			readOnly: !!item.isSubagent || !!parentId,
			cwd: item.cwd || item.workspaceRoot || os.homedir(),
			label: rawTitle.split('\n')[0].slice(0, 100) || vscode.l10n.t('Cline Session {0}', item.sessionId.slice(0, 8)),
			created: Number.isFinite(created) ? created : Date.now(),
			updated: Number.isFinite(updated) ? updated : Date.now(),
			file: item.messagesPath || path.join(this.clineDataDir(), 'sessions', item.sessionId, `${item.sessionId}.messages.json`),
			provisional: false,
		};
		this.knownSessions.set(session.id, session);
		return session;
	}

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
		const items = await this.fetchHistoryItems(token);
		return items.filter(item => !item.isSubagent).map(item => this.toNativeSession(item));
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		const items = await this.fetchHistoryItems(token);
		return items.filter(item => (item.parentSessionId ?? item.metadata?.parentSessionId) === session.id).map(item => this.toNativeSession(item));
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested || session.unmaterialized) { return []; }
		const file = session.file ?? path.join(this.clineDataDir(), 'sessions', session.id, `${session.id}.messages.json`);
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
			throw error;
		}
		const parsed = JSON.parse(raw) as ClineStoredMessage[] | { messages?: ClineStoredMessage[] };
		const messages = Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
		const entries: HistoryEntry[] = [];
		for (const msg of messages) {
			if (msg.role !== 'user' && msg.role !== 'assistant') { continue; }
			if (msg.role === 'user') {
				let text = '';
				if (typeof msg.content === 'string') {
					text = unwrapClineUserInput(msg.content);
				} else if (Array.isArray(msg.content)) {
					const tagged = msg.content.find(part => part.type === 'text' && typeof part.text === 'string' && /<user_input[^>]*>/.test(part.text));
					if (tagged?.text) {
						text = unwrapClineUserInput(tagged.text);
					} else {
						const hasToolResult = msg.content.some(part => part.type === 'tool_result');
						if (!hasToolResult) {
							text = unwrapClineUserInput(msg.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n'));
						}
					}
				}
				if (text) {
					entries.push({ id: `msg-${entries.length}`, role: 'user', text });
				}
			} else {
				const text = typeof msg.content === 'string'
					? msg.content.trim()
					: (msg.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n').trim();
				if (text) {
					entries.push({ id: `msg-${entries.length}`, role: 'assistant', text });
				}
			}
		}
		return entries;
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (session.unmaterialized) {
			this.knownSessions.delete(session.id);
			return;
		}
		await this.closeSession(session.id);
		this.knownSessions.delete(session.id);
		if (!session.provisional) {
			try {
				await capture(this.executable, ['history', 'delete', '--session-id', session.id], token);
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
				if (!message.includes('not found') && !message.includes('does not exist') && !message.includes('no session')) {
					throw error;
				}
			}
		}
		await fs.rm(path.join(this.clineDataDir(), 'sessions', session.id), { recursive: true, force: true });
	}
}
