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
import { parseAgyModelsOutput } from './capabilities';
import {
	buildRemotePersistentPrefix,
	captureRemoteEngine,
	CloudHostTarget,
	execRemoteShell,
	joinRemotePath,
	normalizeRemoteCwdForCompare,
	posixQuote,
	psSingleQuote,
	readRemoteTextFile,
	readRemoteTextFilesBatch,
	resolveRemoteRealpath,
	terminateRemotePersistentSessionsByPrefix,
} from './cloudTransport';
import { AgentChildIdentity, ROLE_INIT_MARKER, SHARED_PURE_SCOPE_KEY, stripAdeControlEnv, stripInjectedAdeContextFromUserTurn } from './roleBridgeShared';
import { agentIdentityScopeKey, capture, createTurnInterimUsageTracker, emitThinkingProgress, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineTurnTokenUsage, findExecutable, HistoryEntry, isAutonomousModeEnabled, JsonLineClient, NativeSession, prepareAgentChildEnv, prepareRemoteAgentChildEnv, raceWithCancellation, readJsonOutput, RpcPacket, withTimeout } from './runtime';

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
	configOptions?: AcpSessionSetupResult['configOptions'];
	models?: AcpSessionSetupResult['models'];
	modes?: AcpSessionSetupResult['modes'];
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

function readAcpPositiveCostUsd(record: Record<string, unknown>): number | undefined {
	for (const key of ['costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd', 'totalCost', 'cost']) {
		const val = record[key];
		if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
			return val;
		}
		if (val && typeof val === 'object') {
			const total = (val as Record<string, unknown>).total;
			if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
				return total;
			}
		}
	}
	return undefined;
}

function readAcpModelString(record: Record<string, unknown>): string | undefined {
	for (const key of ['model', 'modelId', 'model_id']) {
		const val = record[key];
		if (typeof val === 'string' && val.trim() && val.trim().toLowerCase() !== 'default') {
			return val.trim();
		}
	}
	return undefined;
}

function extractAcpTurnUsage(value: unknown, depth = 0): EngineTurnTokenUsage | undefined {
	if (!value || typeof value !== 'object' || depth > 3) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const outerCostUsd = readAcpPositiveCostUsd(record);
	const outerModel = readAcpModelString(record);
	for (const key of ['usage', 'tokenUsage', 'token_usage', 'tokens']) {
		const nested = record[key];
		if (nested && typeof nested === 'object') {
			const usage = extractAcpTurnUsage(nested, depth + 1);
			if (usage) {
				return {
					...usage,
					...(usage.costUsd === undefined && outerCostUsd !== undefined ? { costUsd: outerCostUsd } : {}),
					...(usage.model === undefined && outerModel !== undefined ? { model: outerModel } : {}),
				};
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
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		...(outerCostUsd !== undefined ? { costUsd: outerCostUsd } : {}),
		...(outerModel !== undefined ? { model: outerModel } : {}),
		estimated: false,
	};
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

interface AcpClientSlot {
	client?: JsonLineClient;
	ready?: Promise<JsonLineClient>;
	readonly openSessions: Set<string>;
	readonly loadingSessions: Set<string>;
}

export abstract class AcpRuntime implements EngineRuntime {
	abstract readonly id: string;
	abstract readonly name: string;

	protected readonly clientPool = new Map<string, AcpClientSlot>();
	protected readonly sessionScopeKeys = new Map<string, string>();
	protected agentCapabilities: AcpCapabilities | undefined;
	protected readonly knownSessions = new Map<string, NativeSession>();
	protected readonly changed = new vscode.EventEmitter<readonly NativeSession[]>();
	readonly onDidChangeSessions = this.changed.event;
	protected cachedDefaultModel: string | undefined;
	protected cachedModels: Array<{ id: string; name: string; description?: string }> = [];
	protected cachedModes: Array<{ id: string; name: string; description?: string }> = [];
	protected cachedCommands: Array<{ name: string; description?: string }> = [];
	protected cachedConfigOptionIds = new Set<string>();
	protected cachedModelConfigValues = new Set<string>();
	protected hasReceivedModels = false;
	protected hasReceivedModes = false;
	protected hasReceivedCommands = false;
	protected readonly probedSessionTimestamps = new Map<string, number>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private readonly lastRawSessionUsageBySession = new Map<string, EngineTurnTokenUsage>();

	protected get client(): JsonLineClient | undefined {
		return this.clientPool.get(SHARED_PURE_SCOPE_KEY)?.client;
	}

	consumeLastTurnUsage(sessionId: string): EngineTurnTokenUsage | undefined {
		const usage = this.lastTurnUsageBySession.get(sessionId);
		this.lastTurnUsageBySession.delete(sessionId);
		return usage;
	}

	constructor(
		protected readonly executable: string,
		private readonly args: readonly string[],
		readonly remoteTarget?: CloudHostTarget,
	) { }

	protected upsertCachedModel(id: string, name?: string, description?: string): void {
		const trimmedId = id.trim();
		if (!trimmedId) {
			return;
		}
		const trimmedName = name?.trim() || trimmedId;
		const trimmedDesc = description?.trim() || undefined;
		const existing = this.cachedModels.find(m => m.id === trimmedId);
		if (existing) {
			if (trimmedName !== trimmedId && (existing.name === existing.id || !existing.name)) {
				existing.name = trimmedName;
			}
			if (trimmedDesc && !existing.description) {
				existing.description = trimmedDesc;
			}
			return;
		}
		this.hasReceivedModels = true;
		this.cachedModels.push({ id: trimmedId, name: trimmedName, description: trimmedDesc });
	}

	protected ingestSessionSetup(setup: Partial<AcpSessionSetupResult> | undefined): void {
		if (!setup) {
			return;
		}
		if (setup.models?.currentModelId?.trim()) {
			this.cachedDefaultModel = setup.models.currentModelId.trim();
		}
		if (Array.isArray(setup.configOptions)) {
			for (const opt of setup.configOptions) {
				const optId = (opt.id ?? '').trim();
				if (optId) {
					this.cachedConfigOptionIds.add(optId);
				}
				const flatOptions = (opt.options ?? []).flatMap(entry => Array.isArray(entry.options) ? entry.options : [entry]);
				if (optId === 'model') {
					const rawCur = typeof opt.currentValue === 'string' ? opt.currentValue.trim() : '';
					if (rawCur) {
						try {
							const tuple = JSON.parse(rawCur) as unknown;
							this.cachedDefaultModel = Array.isArray(tuple) && typeof tuple[1] === 'string' ? tuple[1] : rawCur;
						} catch {
							this.cachedDefaultModel = rawCur;
						}
					}
					for (const item of flatOptions) {
						const val = (item.value ?? '').trim();
						if (val) {
							this.cachedModelConfigValues.add(val);
							this.upsertCachedModel(val, item.name, item.description);
						}
					}
				} else if (optId === 'mode') {
					if (flatOptions.length > 0) {
						this.hasReceivedModes = true;
					}
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
		if (Array.isArray(setup.models?.availableModels)) {
			this.hasReceivedModels = true;
			for (const m of setup.models.availableModels) {
				const id = (m.modelId ?? m.id ?? '').trim();
				if (id) {
					this.upsertCachedModel(id, m.name, m.description);
				}
			}
		}
		if (Array.isArray(setup.modes?.availableModes)) {
			this.hasReceivedModes = true;
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
		const next: Array<{ name: string; description?: string }> = [];
		const seen = new Set<string>();
		for (const cmd of commands) {
			const name = (cmd.name ?? '').trim().replace(/^\//, '');
			if (name && !seen.has(name.toLowerCase())) {
				seen.add(name.toLowerCase());
				next.push({ name, description: cmd.description });
			}
		}
		this.hasReceivedCommands = true;
		this.cachedCommands = next;
	}

	protected ingestSessionUpdateMetadata(update: AcpSessionUpdate): void {
		const kind = update.sessionUpdate ?? update.type;
		if (kind === 'available_commands_update') {
			this.ingestAvailableCommands(update.availableCommands);
		} else if (kind === 'config_option_update' || kind === 'config_options_update' || Array.isArray(update.configOptions) || update.models || update.modes) {
			this.ingestSessionSetup({
				configOptions: update.configOptions,
				models: update.models,
				modes: update.modes,
			});
		}
	}

	protected async buildSpawnEnv(): Promise<NodeJS.ProcessEnv | undefined> {
		return undefined;
	}

	protected ensureClientSlot(scopeKey = SHARED_PURE_SCOPE_KEY, identity?: AgentChildIdentity, cwd?: string, persistentOwnerId?: string): Promise<{ readonly slot: AcpClientSlot; readonly client: JsonLineClient }> {
		let slot = this.clientPool.get(scopeKey);
		if (slot?.client && !slot.client.isClosed && slot.ready) {
			const existingSlot = slot;
			return slot.ready.then(client => ({ slot: existingSlot, client }));
		}
		slot?.client?.dispose();
		slot = {
			openSessions: new Set<string>(),
			loadingSessions: new Set<string>(),
		};
		this.clientPool.set(scopeKey, slot);
		const currentSlot = slot;
		currentSlot.ready = (async () => {
			const baseEnv = await this.buildSpawnEnv();
			const childEnv = this.remoteTarget
				? { ...(baseEnv ?? {}), ...(await prepareRemoteAgentChildEnv(this.remoteTarget, identity ?? { sessionId: `${this.id}-pure`, pureWorker: true })) }
				: await prepareAgentChildEnv(identity ?? { sessionId: `${this.id}-pure`, pureWorker: true }, baseEnv);
			const persistentKey = scopeKey === SHARED_PURE_SCOPE_KEY
				? `${buildRemotePersistentPrefix(this.id, SHARED_PURE_SCOPE_KEY)}-${randomUUID().slice(0, 8)}`
				: `${buildRemotePersistentPrefix(this.id, persistentOwnerId || scopeKey)}-${randomUUID().slice(0, 8)}`;
			const client = new JsonLineClient(
				this.executable,
				[...this.args],
				cwd,
				childEnv,
				this.remoteTarget,
				this.remoteTarget && this.remoteTarget.os !== 'windows'
					? { persistentSessionId: persistentKey }
					: undefined,
			);
			if (this.clientPool.get(scopeKey) !== currentSlot) {
				client.dispose();
				throw new Error('ACP client slot was reset during startup.');
			}
			currentSlot.client = client;
			client.onPacket(packet => {
				if (packet.method === 'session/update') {
					const params = packet.params ?? {};
					const update = (params.update ?? params) as AcpSessionUpdate;
					this.ingestSessionUpdateMetadata(update);
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
			}, { timeoutMs: 25_000 });
			if (this.clientPool.get(scopeKey) !== currentSlot) {
				client.dispose();
				throw new Error('ACP client slot was reset during initialization.');
			}
			this.agentCapabilities = result?.agentCapabilities;
			return client;
		})();
		void currentSlot.ready.catch(() => {
			if (this.clientPool.get(scopeKey) === currentSlot) {
				currentSlot.ready = undefined;
				currentSlot.client?.dispose();
				currentSlot.client = undefined;
			}
		});
		return currentSlot.ready.then(client => ({ slot: currentSlot, client }));
	}

	protected ensureClient(scopeKey = SHARED_PURE_SCOPE_KEY, identity?: AgentChildIdentity, cwd?: string): Promise<JsonLineClient> {
		return this.ensureClientSlot(scopeKey, identity, cwd).then(res => res.client);
	}

	protected resolveLiveScopeKey(sessionId: string): string {
		const existingKey = this.sessionScopeKeys.get(sessionId);
		if (existingKey) {
			const slot = this.clientPool.get(existingKey);
			if (slot?.client && !slot.client.isClosed && slot.ready) {
				return existingKey;
			}
		}
		return SHARED_PURE_SCOPE_KEY;
	}

	protected async retireStaleSessionSlot(sessionId: string, nextScopeKey: string): Promise<void> {
		const prevScopeKey = this.sessionScopeKeys.get(sessionId);
		if (!prevScopeKey || prevScopeKey === nextScopeKey) {
			return;
		}
		const prevSlot = this.clientPool.get(prevScopeKey);
		if (prevSlot) {
			if (prevSlot.client && !prevSlot.client.isClosed && prevSlot.openSessions.has(sessionId)) {
				await prevSlot.client.request('session/close', { sessionId }, { timeoutMs: 2500 }).catch(() => { });
			}
			prevSlot.openSessions.delete(sessionId);
			if (prevScopeKey !== SHARED_PURE_SCOPE_KEY) {
				await this.resetClient(prevScopeKey);
			}
		}
	}

	protected async closeSession(sessionId: string): Promise<void> {
		const scopeKey = this.sessionScopeKeys.get(sessionId);
		const keys = scopeKey ? [scopeKey] : [...this.clientPool.keys()];
		let closeFailedOnShared = false;
		for (const key of keys) {
			const slot = this.clientPool.get(key);
			if (!slot || !slot.client || slot.client.isClosed || !slot.openSessions.has(sessionId)) {
				slot?.openSessions.delete(sessionId);
				continue;
			}
			slot.openSessions.delete(sessionId);
			await slot.client.request('session/close', { sessionId }, { timeoutMs: 2500 }).catch(() => {
				if (key === SHARED_PURE_SCOPE_KEY) {
					closeFailedOnShared = true;
				}
			});
		}
		this.sessionScopeKeys.delete(sessionId);
		this.probedSessionTimestamps.delete(sessionId);
		if (scopeKey && scopeKey !== SHARED_PURE_SCOPE_KEY) {
			await this.resetClient(scopeKey);
		} else if (closeFailedOnShared) {
			const sharedSlot = this.clientPool.get(SHARED_PURE_SCOPE_KEY);
			if (sharedSlot && sharedSlot.openSessions.size === 0 && sharedSlot.loadingSessions.size === 0) {
				await this.resetClient(SHARED_PURE_SCOPE_KEY);
			}
		}
	}

	protected async resetClient(scopeKey?: string): Promise<void> {
		const keys = scopeKey ? [scopeKey] : [...this.clientPool.keys()];
		for (const key of keys) {
			const slot = this.clientPool.get(key);
			this.clientPool.delete(key);
			if (!slot) {
				continue;
			}
			const current = slot.client;
			slot.client = undefined;
			slot.ready = undefined;
			slot.openSessions.clear();
			slot.loadingSessions.clear();
			if (current) {
				await current.disposeAsync().catch(() => undefined);
				await current.waitForClose();
			}
		}
		this.probedSessionTimestamps.clear();
	}

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		try {
			const { slot, created } = await withTimeout((async () => {
				const ensured = await this.ensureClientSlot(SHARED_PURE_SCOPE_KEY, { sessionId: `${this.id}-pure`, pureWorker: true });
				const result = await ensured.client.request<AcpSessionSetupResult>('session/new', { cwd, mcpServers: [] });
				return { slot: ensured.slot, created: result };
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
			slot.openSessions.add(session.id);
			this.sessionScopeKeys.set(session.id, SHARED_PURE_SCOPE_KEY);
			this.knownSessions.set(session.id, session);
			return session;
		} catch {
			void this.resetClient(SHARED_PURE_SCOPE_KEY).catch(() => { });
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

	async prepareSession(session: NativeSession, options?: EngineSendOptions, token?: vscode.CancellationToken): Promise<void> {
		if (token?.isCancellationRequested) {
			return;
		}
		const scopeKey = options
			? agentIdentityScopeKey(session.id, options, session.cwd)
			: this.resolveLiveScopeKey(session.id);
		const identity: AgentChildIdentity = options
			? { sessionId: options.adeSessionId || session.id, callerRole: options.callerRole, pureWorker: options.pureWorker, isMissionNode: options.isMissionNode }
			: { sessionId: session.id, pureWorker: true };
		await this.retireStaleSessionSlot(session.id, scopeKey);
		if (!session.unmaterialized || token?.isCancellationRequested) {
			return;
		}
		const { slot, client } = await raceWithCancellation(
			this.ensureClientSlot(scopeKey, identity, scopeKey === SHARED_PURE_SCOPE_KEY ? undefined : session.cwd),
			token,
		);
		if (token?.isCancellationRequested) {
			return;
		}
		const created = await client.request<AcpSessionSetupResult>('session/new', { cwd: session.cwd, mcpServers: [] }, { timeoutMs: 25_000, token });
		this.ingestSessionSetup(created);
		session.id = created.sessionId;
		session.unmaterialized = false;
		const resolvedScopeKey = options ? agentIdentityScopeKey(session.id, options, session.cwd) : scopeKey;
		if (resolvedScopeKey !== scopeKey && this.clientPool.get(scopeKey) === slot && !this.clientPool.has(resolvedScopeKey)) {
			this.clientPool.delete(scopeKey);
			this.clientPool.set(resolvedScopeKey, slot);
		}
		slot.openSessions.add(session.id);
		this.sessionScopeKeys.set(session.id, resolvedScopeKey);
		this.knownSessions.set(session.id, session);
	}

	protected async ensureSessionOpen(slot: AcpClientSlot, client: JsonLineClient, session: NativeSession, token?: vscode.CancellationToken): Promise<void> {
		if (slot.openSessions.has(session.id) || token?.isCancellationRequested) {
			return;
		}
		try {
			if (this.agentCapabilities?.sessionCapabilities?.resume) {
				const resumed = await client.request<Partial<AcpSessionSetupResult> | undefined>('session/resume', { sessionId: session.id, cwd: session.cwd, mcpServers: [] }, { timeoutMs: 25_000, token });
				this.ingestSessionSetup(resumed);
			} else if (this.agentCapabilities?.loadSession) {
				slot.loadingSessions.add(session.id);
				try {
					const loaded = await client.request<Partial<AcpSessionSetupResult> | undefined>('session/load', { sessionId: session.id, cwd: session.cwd, mcpServers: [] }, { timeoutMs: 25_000, token });
					this.ingestSessionSetup(loaded);
				} finally {
					slot.loadingSessions.delete(session.id);
				}
			} else if (session.provisional) {
				const created = await client.request<AcpSessionSetupResult>('session/new', { cwd: session.cwd, mcpServers: [] }, { timeoutMs: 25_000, token });
				this.ingestSessionSetup(created);
				session.id = created.sessionId;
				this.knownSessions.set(session.id, session);
			}
			slot.openSessions.add(session.id);
		} catch (error) {
			if (token?.isCancellationRequested || error instanceof vscode.CancellationError) {
				return;
			}
			if (!session.provisional) {
				throw error;
			}
			const created = await client.request<AcpSessionSetupResult>('session/new', { cwd: session.cwd, mcpServers: [] }, { timeoutMs: 25_000, token });
			this.ingestSessionSetup(created);
			session.id = created.sessionId;
			slot.openSessions.add(session.id);
			this.knownSessions.set(session.id, session);
		}
	}

	protected async loadReplayedHistory(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested) { return []; }
		const scopeKey = this.resolveLiveScopeKey(session.id);
		const { slot, client } = await this.ensureClientSlot(scopeKey);
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
		slot.loadingSessions.add(session.id);
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
			const loaded = await client.request<Partial<AcpSessionSetupResult> | undefined>('session/load', { sessionId: session.id, cwd: session.cwd, mcpServers: [] });
			this.ingestSessionSetup(loaded);
			slot.openSessions.add(session.id);
		} finally {
			listener.dispose();
			slot.loadingSessions.delete(session.id);
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
		const scopeKey = this.sessionScopeKeys.get(session.id);
		const keys = scopeKey ? [scopeKey] : [...this.clientPool.keys()];
		for (const key of keys) {
			const slot = this.clientPool.get(key);
			if (slot?.client && !slot.client.isClosed) {
				try {
					slot.client.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.id } });
				} catch { /* ignore */ }
			}
		}
		await this.closeSession(session.id);
		// If this session was the only open session on the shared slot, recycle the client
		// so a wedged ACP process (e.g. `agy acp` ignoring `session/cancel`) cannot poison future turns.
		const sharedSlot = this.clientPool.get(SHARED_PURE_SCOPE_KEY);
		if (sharedSlot && sharedSlot.openSessions.size === 0 && sharedSlot.loadingSessions.size === 0) {
			await this.resetClient(SHARED_PURE_SCOPE_KEY);
		}
		// Guarantee full remote process-group + descendant termination even after an Electron window reload.
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			await terminateRemotePersistentSessionsByPrefix(
				this.remoteTarget,
				buildRemotePersistentPrefix(this.id, session.id),
				{ killTree: true },
			);
		}
	}

	protected snapshotRuntimeCapabilities(): EngineRuntimeCapabilities {
		return {
			defaultModel: this.cachedDefaultModel,
			models: this.hasReceivedModels ? this.cachedModels.map(m => ({ ...m })) : undefined,
			modes: this.hasReceivedModes ? this.cachedModes.map(m => ({ ...m })) : undefined,
			commands: this.hasReceivedCommands ? this.cachedCommands.map(c => ({ ...c })) : undefined,
		};
	}

	async getRuntimeCapabilities(cwd: string, session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		const lastProbeAt = session ? (this.probedSessionTimestamps.get(session.id) ?? 0) : 0;
		const cooldownElapsed = Date.now() - lastProbeAt >= 30_000;
		const needsProbe = (this.cachedModels.length === 0 || !this.cachedDefaultModel)
			&& Boolean(session && !session.unmaterialized && !session.provisional && cooldownElapsed);
		if (needsProbe && session) {
			if (this.probedSessionTimestamps.size > 256) {
				this.probedSessionTimestamps.clear();
			}
			this.probedSessionTimestamps.set(session.id, Date.now());
			try {
				const scopeKey = this.resolveLiveScopeKey(session.id);
				const { slot, client } = await withTimeout(this.ensureClientSlot(scopeKey), 5000);
				if (!slot.openSessions.has(session.id) && cwd) {
					await withTimeout(this.ensureSessionOpen(slot, client, session), 5000).catch(() => { });
				}
			} catch { /* Retry allowed after cooldown. */ }
		}
		return this.snapshotRuntimeCapabilities();
	}

	async executeCommand(session: NativeSession, command: string, _argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<boolean> {
		const cmd = command.trim().toLowerCase();
		if (cmd === 'mcp') {
			const serverNames = new Set<string>();
			if (this.remoteTarget) {
				const rHome = this.remoteTarget.remoteHome;
				const remoteCandidates = [
					joinRemotePath(this.remoteTarget.os, session.cwd, '.mcp.json'),
					...(rHome ? [
						joinRemotePath(this.remoteTarget.os, rHome, '.gemini', 'config', 'mcp_config.json'),
						joinRemotePath(this.remoteTarget.os, rHome, '.dsh', 'mcp.json'),
						joinRemotePath(this.remoteTarget.os, rHome, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
					] : []),
				];
				const files = await readRemoteTextFilesBatch(this.remoteTarget, remoteCandidates);
				for (const raw of files.values()) {
					if (!raw) { continue; }
					try {
						const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
						for (const name of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) {
							serverNames.add(name);
						}
					} catch { /* Ignore invalid JSON. */ }
				}
			} else {
				const configCandidates = [
					path.join(session.cwd, '.mcp.json'),
					path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'),
					path.join(os.homedir(), '.dsh', 'mcp.json'),
					path.join(os.homedir(), '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
				];
				for (const candidate of configCandidates) {
					try {
						const raw = await fs.readFile(candidate, 'utf8');
						const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
						for (const name of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) {
							serverNames.add(name);
						}
					} catch { /* Ignore missing config. */ }
				}
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
			stream.markdown(`### Cline Recent Tasks\n\n${lines}\n\n- **Active Mode**: \`${options?.mode || (isAutonomousModeEnabled() ? 'yolo' : 'ask')}\`\n- **Active Model**: \`${options?.model || 'default'}\`\n`);
			return true;
		}
		return false;
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		const scopeKey = agentIdentityScopeKey(session.id, options, session.cwd);
		await this.retireStaleSessionSlot(session.id, scopeKey);
		if (token.isCancellationRequested) {
			return;
		}
		const { slot, client } = await raceWithCancellation(
			this.ensureClientSlot(scopeKey, {
				sessionId: options?.adeSessionId || session.id,
				callerRole: options?.callerRole,
				pureWorker: options?.pureWorker,
				isMissionNode: options?.isMissionNode,
			}, session.cwd, session.id),
			token,
		);
		if (token.isCancellationRequested) {
			return;
		}
		await this.ensureSessionOpen(slot, client, session, token);
		if (token.isCancellationRequested) {
			return;
		}
		this.sessionScopeKeys.set(session.id, scopeKey);
		const cfgReqOpts = { timeoutMs: 8_000, token };
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
				await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }, cfgReqOpts).catch(() => { });
			} else if (this.id === 'antigravity') {
				if (this.cachedModelConfigValues.has(normalizedModel)) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }, cfgReqOpts).catch(() => { });
				} else {
					await client.request('session/set_model', { sessionId: session.id, modelId: normalizedModel }, cfgReqOpts).catch(() => { });
					if (this.cachedConfigOptionIds.has('model')) {
						await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }, cfgReqOpts).catch(() => { });
					}
				}
			} else {
				await client.request('session/set_model', { sessionId: session.id, modelId: normalizedModel }, cfgReqOpts).catch(() => { });
				if (this.cachedConfigOptionIds.has('model')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'model', value: normalizedModel }, cfgReqOpts).catch(() => { });
				}
			}
		}
		if (token.isCancellationRequested) {
			return;
		}
		const autonomous = Boolean(options?.automatedEngineering) || isAutonomousModeEnabled();
		const effectiveMode = options?.mode && options.mode !== 'default'
			? options.mode
			: (this.id === 'cline' ? (autonomous ? 'yolo' : 'ask') : this.id === 'antigravity' ? (autonomous ? 'auto' : 'ask') : undefined);
		if (effectiveMode) {
			if (this.id === 'cline') {
				const clineSessionMode = effectiveMode === 'plan' ? 'plan' : 'act';
				await client.request('session/set_mode', { sessionId: session.id, modeId: clineSessionMode }, cfgReqOpts).catch(() => { });
				if (this.cachedConfigOptionIds.has('mode')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'mode', value: clineSessionMode }, cfgReqOpts).catch(() => { });
				}
				if (this.cachedConfigOptionIds.has('auto_approve')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'auto_approve', value: effectiveMode === 'yolo' || Boolean(options?.automatedEngineering) }, cfgReqOpts).catch(() => { });
				}
			} else {
				await client.request('session/set_mode', { sessionId: session.id, modeId: effectiveMode }, cfgReqOpts).catch(() => { });
				if (this.cachedConfigOptionIds.has('mode')) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: 'mode', value: effectiveMode }, cfgReqOpts).catch(() => { });
				}
			}
		}
		if (token.isCancellationRequested) {
			return;
		}
		if (options?.thinking && options.thinking !== 'default') {
			const rawThinking = options.thinking.trim().toLowerCase();
			const isExtraHigh = rawThinking === 'xhigh' || rawThinking === 'extra-high' || rawThinking === 'max';
			const normalizedThinking = rawThinking === 'none' ? 'off' : isExtraHigh ? 'xhigh' : rawThinking;
			if (this.cachedConfigOptionIds.has('thought_level')) {
				const agyLevel = normalizedThinking === 'off' ? 'low' : normalizedThinking;
				await client.request('session/set_config_option', { sessionId: session.id, configId: 'thought_level', value: agyLevel }, cfgReqOpts).catch(async () => {
					if (agyLevel === 'xhigh' && !token.isCancellationRequested) {
						await client.request('session/set_config_option', { sessionId: session.id, configId: 'thought_level', value: 'high' }, cfgReqOpts).catch(() => { });
					}
				});
			}
			if (this.cachedConfigOptionIds.has('reasoning_effort')) {
				await client.request('session/set_config_option', { sessionId: session.id, configId: 'reasoning_effort', value: normalizedThinking }, cfgReqOpts).catch(async () => {
					if (normalizedThinking === 'xhigh' && !token.isCancellationRequested) {
						await client.request('session/set_config_option', { sessionId: session.id, configId: 'reasoning_effort', value: 'high' }, cfgReqOpts).catch(() => { });
					}
				});
			}
		}
		if (token.isCancellationRequested) {
			return;
		}
		const requestedPerm = options?.permissionMode?.trim();
		const requestedMode = options?.mode?.trim();
		const explicitAskOrPlan = requestedPerm === 'ask' || requestedPerm === 'manual' || requestedMode === 'ask' || requestedMode === 'plan';
		const explicitBypass = requestedPerm === 'bypassPermissions'
			|| requestedPerm === 'auto'
			|| requestedPerm === 'never'
			|| requestedPerm === 'danger-full-access'
			|| requestedMode === 'yolo'
			|| (this.id === 'antigravity' && requestedMode === 'auto');
		const autoApprove = Boolean(options?.automatedEngineering)
			|| (!explicitAskOrPlan && (explicitBypass || isAutonomousModeEnabled()));
		if (this.id === 'dsh') {
			const effectiveDshPerm = requestedPerm && requestedPerm !== 'default'
				? requestedPerm
				: (autoApprove ? 'danger-full-access' : 'ask');
			for (const cfgId of ['permission_mode', 'sandbox', 'approval_mode'] as const) {
				if (this.cachedConfigOptionIds.has(cfgId)) {
					await client.request('session/set_config_option', { sessionId: session.id, configId: cfgId, value: effectiveDshPerm }, cfgReqOpts).catch(() => { });
				}
			}
		}
		if (token.isCancellationRequested) {
			return;
		}
		this.knownSessions.set(session.id, session);
		const activeAcpModel = (options?.model && options.model !== 'default' ? options.model.trim() : undefined) ?? this.cachedDefaultModel;
		const usageTracker = createTurnInterimUsageTracker(text, options?.onInterimUsage, {
			preTurnBaseline: this.lastRawSessionUsageBySession.get(session.id),
			model: activeAcpModel,
		});
		const listener = client.onPacket(packet => {
			const params = packet.params ?? {};
			if (packet.id !== undefined && packet.method) {
				const targetSessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
				if (!targetSessionId || targetSessionId === session.id) {
					if (packet.method === 'session/request_permission' && autoApprove) {
						const permOpts = Array.isArray(params.options) ? (params.options as AcpPermissionOption[]) : [];
						const allowOpt = permOpts.find(opt => opt.kind === 'allow_always')
							?? permOpts.find(opt => opt.kind === 'allow_once')
							?? permOpts.find(opt => typeof opt.kind === 'string' && !opt.kind.startsWith('reject'));
						if (allowOpt) {
							client.write({ jsonrpc: '2.0', id: packet.id, result: { outcome: { outcome: 'selected', optionId: allowOpt.optionId } } });
							return;
						}
					}
					void this.handleServerRequest(client, packet, session, token).catch(() => { });
				}
				return;
			}
			if (packet.method !== 'session/update' || params.sessionId !== session.id || slot.loadingSessions.has(session.id)) {
				return;
			}
			const update = (params.update ?? params) as AcpSessionUpdate;
			const updateUsage = extractAcpTurnUsage(update.usage ?? params.usage);
			if (updateUsage) {
				const normalized = usageTracker.recordRealUsage(updateUsage, { cumulativeAcrossThread: true });
				this.lastRawSessionUsageBySession.set(session.id, updateUsage);
				this.lastTurnUsageBySession.set(session.id, normalized);
			}
			const kind = update.sessionUpdate ?? update.type;
			if (kind === 'compact_boundary' || kind === 'context_compacted') {
				try {
					options?.onContextCompacted?.();
				} catch { /* Compaction callback must never break the turn. */ }
			}
			if (!token.isCancellationRequested && kind === 'agent_message_chunk') {
				const chunk = extractAcpText(update);
				if (chunk) {
					stream.markdown(chunk);
					usageTracker.recordStreamDelta(chunk);
				}
			} else if (!token.isCancellationRequested && (kind === 'agent_thought_chunk' || kind === 'thought_chunk')) {
				const thought = extractAcpText(update);
				if (thought) {
					emitThinkingProgress(stream, thought, `${this.id}-thinking`);
					usageTracker.recordStreamDelta(thought, { skipToolErrorScan: true });
				}
			} else if (!token.isCancellationRequested && (kind === 'tool_call' || kind === 'tool_call_update')) {
				const toolTitle = typeof update.title === 'string' && update.title.trim() ? update.title.trim() : undefined;
				if (toolTitle || kind === 'tool_call') {
					stream.progress(toolTitle ?? vscode.l10n.t('{0} is working…', this.name));
				}
			} else if (kind === 'available_commands_update' || kind === 'config_option_update' || kind === 'config_options_update') {
				this.ingestSessionUpdateMetadata(update);
			} else if (kind === 'session_info_update' && typeof update.title === 'string' && update.title.trim()) {
				session.label = update.title.trim();
				this.changed.fire([session]);
			}
		});
		const sendCancelNotification = () => {
			try { client.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.id } }); } catch { /* Connection may already be closed. */ }
		};
		try {
			const promptParts: Array<Record<string, unknown>> = [];
			if (options?.attachments?.length) {
				for (const att of options.attachments) {
					if (att.kind === 'image' && !att.remote) {
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
			if (token.isCancellationRequested) {
				return;
			}
			try {
				await client.request('session/prompt', { sessionId: session.id, prompt: promptParts }, {
					token,
					cancelGraceMs: 1500,
					onCancel: sendCancelNotification,
				});
				session.provisional = false;
			} catch (err) {
				if (token.isCancellationRequested || err instanceof vscode.CancellationError) {
					// If the ACP server did not settle `session/prompt` within the cancel grace window,
					// recycle this session/client so the next prompt never collides with a wedged turn.
					slot.openSessions.delete(session.id);
					const stillOwnsSlot = this.clientPool.get(scopeKey) === slot && slot.client === client;
					if (stillOwnsSlot) {
						if (scopeKey !== SHARED_PURE_SCOPE_KEY || (slot.openSessions.size === 0 && slot.loadingSessions.size === 0)) {
							await this.resetClient(scopeKey).catch(() => { });
						} else {
							await client.request('session/close', { sessionId: session.id }, { timeoutMs: 1000 }).catch(() => { });
						}
					}
					return;
				}
				throw err;
			}
		} finally {
			listener.dispose();
		}
	}

	abstract list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]>;
	abstract history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]>;
	abstract delete(session: NativeSession, token: vscode.CancellationToken): Promise<void>;

	dispose(): void {
		this.changed.dispose();
		for (const slot of this.clientPool.values()) {
			slot.client?.dispose();
			slot.client = undefined;
			slot.ready = undefined;
			slot.openSessions.clear();
			slot.loadingSessions.clear();
		}
		this.clientPool.clear();
		this.sessionScopeKeys.clear();
		this.lastTurnUsageBySession.clear();
		this.lastRawSessionUsageBySession.clear();
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

	constructor(executable: string, remoteTarget?: CloudHostTarget) {
		super(executable, ['--profile', 'acp'], remoteTarget);
	}

	private dshHome(): string {
		return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
	}

	private async scanRemoteSessions(token: vscode.CancellationToken, projectCwd?: string): Promise<DshDiscoveredSession[]> {
		if (!this.remoteTarget || token.isCancellationRequested) {
			return [];
		}
		const targetCwds: string[] = [];
		if (projectCwd?.trim()) {
			targetCwds.push(normalizeRemoteCwdForCompare(projectCwd, this.remoteTarget.os));
			const realCwd = await resolveRemoteRealpath(this.remoteTarget, projectCwd, token).catch(() => undefined);
			if (realCwd) {
				const realNorm = normalizeRemoteCwdForCompare(realCwd, this.remoteTarget.os);
				if (!targetCwds.includes(realNorm)) {
					targetCwds.push(realNorm);
				}
			}
		}

		const pyDsh = [
			`import json, os, sys`,
			`target_cwds = set(json.loads(sys.argv[1]))`,
			`pdir = os.path.join(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh"), "storages", "session_projcache", "sessions")`,
			`if not os.path.isdir(pdir): sys.exit(0)`,
			`def norm(p):`,
			`    p = os.path.normpath((p or "").strip())`,
			`    return p[:-1] if len(p) > 1 and p.endswith("/") else p`,
			`files = []`,
			`for fn in os.listdir(pdir):`,
			`    if not fn.endswith(".json"): continue`,
			`    fp = os.path.join(pdir, fn)`,
			`    try: files.append((os.path.getmtime(fp), fn[:-5], fp))`,
			`    except OSError: pass`,
			`files.sort(key=lambda x: x[0], reverse=True)`,
			`for mtime, sid, fp in files[:200]:`,
			`    try:`,
			`        with open(fp, "r", encoding="utf-8", errors="replace") as f: parsed = json.load(f)`,
			`    except Exception: continue`,
			`    if not isinstance(parsed, dict): continue`,
			`    proj = parsed.get("record") if isinstance(parsed.get("record"), dict) else parsed`,
			`    identity = proj.get("identity") if isinstance(proj.get("identity"), dict) else {}`,
			`    rows = proj.get("rows") if isinstance(proj.get("rows"), dict) else {}`,
			`    wd_val = (rows.get("workingDirectory") or {}).get("val") if isinstance(rows.get("workingDirectory"), dict) else None`,
			`    cwd = (wd_val if isinstance(wd_val, str) else (wd_val.get("cwd") if isinstance(wd_val, dict) else None)) or identity.get("cwd") or proj.get("cwd")`,
			`    if not cwd or not sid: continue`,
			`    if target_cwds and norm(str(cwd)) not in target_cwds: continue`,
			`    t_val = (rows.get("title") or {}).get("val") if isinstance(rows.get("title"), dict) else None`,
			`    title = (t_val if isinstance(t_val, str) else (t_val.get("title") if isinstance(t_val, dict) else None)) or proj.get("title") or ""`,
			`    sub_val = (rows.get("subagent") or {}).get("val") if isinstance(rows.get("subagent"), dict) else {}`,
			`    if not isinstance(sub_val, dict): sub_val = {}`,
			`    lm_val = (rows.get("sessionListMetadata") or {}).get("val") if isinstance(rows.get("sessionListMetadata"), dict) else {}`,
			`    if not isinstance(lm_val, dict): lm_val = {}`,
			`    parent_id = identity.get("parentSessionId") or identity.get("parentId") or sub_val.get("parentSessionId") or sub_val.get("parentId") or lm_val.get("parentSessionId") or lm_val.get("parentId") or proj.get("parentSessionId") or proj.get("parentId")`,
			`    origin = identity.get("origin") or sub_val.get("origin") or lm_val.get("origin") or proj.get("origin") or ("subagent" if parent_id else None)`,
			`    mtime_ms = int(mtime * 1000)`,
			`    created = identity.get("createdAt") or proj.get("createdAt") or mtime_ms`,
			`    updated = max(mtime_ms, lm_val.get("lastPromptAt") or 0, proj.get("updatedAt") or 0, proj.get("updated") or 0) or created`,
			`    print("__AEX_DSH_J__\\t" + json.dumps({"id": sid, "cwd": str(cwd), "title": str(title), "created": created, "updated": updated, "parentId": parent_id, "origin": origin}, ensure_ascii=False))`,
		].join('\n');

		const posixScript = [
			`if command -v python3 >/dev/null 2>&1; then`,
			`  python3 -c ${posixQuote(pyDsh)} ${posixQuote(JSON.stringify(targetCwds))}`,
			`  exit $?`,
			`fi`,
			`pdir="\${DSH_HOME:-$HOME/.dsh}/storages/session_projcache/sessions"`,
			`[ -d "$pdir" ] || exit 0`,
			`for f in "$pdir"/*.json; do`,
			`  [ -f "$f" ] || continue`,
			`  m=$(stat -c "%Y" "$f" 2>/dev/null || stat -f "%m" "$f" 2>/dev/null || echo 0)`,
			`  printf '%s\\t%s\\n' "$m" "$f"`,
			`done | sort -rn | head -n 120 | while IFS=$(printf '\\t') read -r m f; do`,
			`  [ -f "$f" ] || continue`,
			`  sz=$(wc -c < "$f" 2>/dev/null || echo 0)`,
			`  [ "$sz" -le 524288 ] || continue`,
			`  b=$(base64 < "$f" | tr -d '\\r\\n')`,
			`  printf '%s\\t%s\\t%s\\n' "$m" "$(basename -- "$f" .json)" "$b"`,
			`done`,
		].join('\n');
		const winScript = [
			`$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }`,
			`$pdir = Join-Path $homeDir 'storages\\session_projcache\\sessions'`,
			`if (Test-Path -LiteralPath $pdir) {`,
			`  Get-ChildItem -LiteralPath $pdir -Filter '*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.Length -le 524288 } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 120 | ForEach-Object {`,
			`    $ms = [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()`,
			`    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))`,
			`    Write-Output ($ms.ToString() + [char]9 + [IO.Path]::GetFileNameWithoutExtension($_.Name) + [char]9 + $b64)`,
			`  }`,
			`}`,
		].join('; ');
		const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 18_000, token }).catch(() => undefined);
		if (!res || res.code !== 0) {
			return [];
		}
		const discovered: DshDiscoveredSession[] = [];
		for (const rawLine of res.stdout.toString('utf8').split(/\r?\n/)) {
			if (!rawLine.trim()) { continue; }
			if (rawLine.startsWith('__AEX_DSH_J__\t')) {
				try {
					const row = JSON.parse(rawLine.slice('__AEX_DSH_J__\t'.length)) as {
						id?: string; cwd?: string; title?: string; created?: number; updated?: number; parentId?: string; origin?: string;
					};
					if (!row.id || !row.cwd) { continue; }
					const session: DshDiscoveredSession = {
						id: row.id,
						parentId: row.parentId || undefined,
						readOnly: row.origin === 'subagent' || !!row.parentId,
						cwd: row.cwd,
						label: row.title?.trim() || vscode.l10n.t('DeepSeek Harness {0}', row.id.replace(/^session-/, '').slice(0, 8)),
						created: typeof row.created === 'number' && Number.isFinite(row.created) ? row.created : Date.now(),
						updated: typeof row.updated === 'number' && Number.isFinite(row.updated) ? row.updated : Date.now(),
						provisional: false,
						origin: row.origin ?? (row.parentId ? 'subagent' : undefined),
					};
					this.knownSessions.set(session.id, session);
					discovered.push(session);
				} catch { /* ignore */ }
				continue;
			}
			const parts = rawLine.split('\t');
			if (parts.length < 3) { continue; }
			const rawTs = Number(parts[0]) || 0;
			const mtime = rawTs > 1e11 ? rawTs : (rawTs > 0 ? rawTs * 1000 : Date.now());
			const id = parts[1].trim();
			let parsed: DshProjCacheFile;
			try {
				parsed = JSON.parse(Buffer.from(parts[2].trim(), 'base64').toString('utf8')) as DshProjCacheFile;
			} catch { continue; }
			const proj = parsed.record ?? (parsed as DshProjCacheFile['record']);
			const identity = proj?.identity;
			const rows = proj?.rows;
			const workDirVal = rows?.workingDirectory?.val;
			const titleVal = rows?.title?.val;
			const subagentVal = rows?.subagent?.val;
			const listMetaVal = rows?.sessionListMetadata?.val;
			const cwd = (typeof workDirVal === 'string' ? workDirVal : workDirVal?.cwd) || identity?.cwd || proj?.cwd;
			if (!cwd || !id) { continue; }
			const title = (typeof titleVal === 'string' ? titleVal : titleVal?.title) || proj?.title;
			const created = identity?.createdAt ?? proj?.createdAt ?? mtime;
			const updated = Math.max(mtime, listMetaVal?.lastPromptAt ?? 0, proj?.updatedAt ?? 0, proj?.updated ?? 0) || created;
			const parentId = identity?.parentSessionId ?? identity?.parentId ?? subagentVal?.parentSessionId ?? subagentVal?.parentId ?? listMetaVal?.parentSessionId ?? listMetaVal?.parentId ?? proj?.parentSessionId ?? proj?.parentId;
			const origin = identity?.origin ?? subagentVal?.origin ?? listMetaVal?.origin ?? proj?.origin ?? (parentId ? 'subagent' : undefined);
			const session: DshDiscoveredSession = {
				id,
				parentId,
				readOnly: origin === 'subagent' || !!parentId,
				cwd,
				label: title?.trim() || vscode.l10n.t('DeepSeek Harness {0}', id.replace(/^session-/, '').slice(0, 8)),
				created,
				updated,
				provisional: false,
				origin: origin ?? (parentId ? 'subagent' : undefined),
			};
			this.knownSessions.set(session.id, session);
			discovered.push(session);
		}
		return discovered.sort((a, b) => b.updated - a.updated);
	}

	private async scanSessions(token: vscode.CancellationToken, projectCwd?: string): Promise<DshDiscoveredSession[]> {
		if (this.remoteTarget) {
			return this.scanRemoteSessions(token, projectCwd);
		}
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

	async list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		const all = await this.scanSessions(token, projectCwd);
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
		if (token.isCancellationRequested || session.unmaterialized || (session.provisional && !session.file)) { return []; }
		if (this.remoteTarget) {
			const replayed = await this.loadReplayedHistory(session, token).catch(() => [] as HistoryEntry[]);
			if (replayed.length > 0) {
				return replayed;
			}
			const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, '');
			if (!safeId) { return []; }
			const posixScript = `root="\${DSH_HOME:-$HOME/.dsh}/sessions"; for f in "$root"/*/${posixQuote(safeId)}/*.jsonl.zstd "$root"/*/${posixQuote(safeId)}/*.jsonl; do if [ -f "$f" ]; then base64 < "$f" | tr -d '\\r\\n'; exit 0; fi; done; exit 2`;
			const winScript = `$h = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }; $root = Join-Path $h 'sessions'; $found = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $sd = Join-Path $_.FullName ${psSingleQuote(safeId)}; if (Test-Path -LiteralPath $sd) { Get-ChildItem -LiteralPath $sd -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*.jsonl.zstd' -or $_.Name -like '*.jsonl' } } } | Select-Object -First 1; if ($found) { [Console]::Out.Write([Convert]::ToBase64String([IO.File]::ReadAllBytes($found.FullName))); exit 0 }; exit 2`;
			const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 20_000, token }).catch(() => undefined);
			if (!res || res.code !== 0) { return []; }
			const b64 = res.stdout.toString('utf8').trim();
			if (!b64) { return []; }
			const text = decodeDshLogBuffer(Buffer.from(b64, 'base64'));
			const entries: HistoryEntry[] = [];
			for (const line of text.split('\n')) {
				if (token.isCancellationRequested || !line) { continue; }
				let event: DshEvent;
				try { event = JSON.parse(line) as DshEvent; } catch { continue; }
				if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
					const content = event.data.content ?? event.data.message?.content ?? [];
					const body = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n').trim();
					if (body) { entries.push({ id: event.data.id ?? `user-${entries.length}`, role: 'user', text: body }); }
				} else if (event.type === 'assistant/message') {
					const content = event.data?.message?.content ?? event.data?.content ?? [];
					const body = content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text ?? '').join('\n').trim();
					if (body) { entries.push({ id: event.data?.message?.id ?? event.data?.id ?? `assistant-${entries.length}`, role: 'assistant', text: body }); }
				}
			}
			return entries;
		}
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
		if (this.remoteTarget) {
			await this.closeSession(session.id);
			this.knownSessions.delete(session.id);
			const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, '');
			if (safeId) {
				const posixScript = `h="\${DSH_HOME:-$HOME/.dsh}"; for d in "$h"/sessions/*/${posixQuote(safeId)}; do [ -d "$d" ] && rm -rf -- "$d"; done; rm -f -- "$h/storages/session_projcache/sessions/${safeId}.json"`;
				const winScript = `$h = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }; $s = Join-Path $h 'sessions'; if (Test-Path -LiteralPath $s) { Get-ChildItem -LiteralPath $s -Directory -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath (Join-Path $_.FullName ${psSingleQuote(safeId)}) -Recurse -Force -ErrorAction SilentlyContinue } }; Remove-Item -LiteralPath (Join-Path $h ${psSingleQuote(`storages\\session_projcache\\sessions\\${safeId}.json`)}) -Force -ErrorAction SilentlyContinue`;
				await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 12_000, token }).catch(() => undefined);
			}
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
	private cliModelsAttemptedAt = 0;
	private cliModelsLastSucceeded = false;
	private cliModelsPromise: Promise<void> | undefined;

	constructor(executable: string, remoteTarget?: CloudHostTarget) {
		super(executable, ['acp', '--app_data_dir=antigravity'], remoteTarget);
	}

	private async fetchCliModels(): Promise<void> {
		const cooldownMs = this.cliModelsLastSucceeded ? 60_000 : 30_000;
		if (this.cliModelsAttemptedAt > 0 && Date.now() - this.cliModelsAttemptedAt < cooldownMs) {
			return;
		}
		if (this.cliModelsPromise) {
			return this.cliModelsPromise;
		}
		this.cliModelsPromise = (async () => {
			let succeeded = false;
			try {
				const stdout = this.remoteTarget
					? await captureRemoteEngine(this.remoteTarget, this.executable, ['models'], undefined, undefined, undefined, 10_000)
					: (await execFile(this.executable, ['models'], {
						timeout: 10000,
						windowsHide: true,
						env: stripAdeControlEnv(process.env),
					})).stdout;
				const parsed = parseAgyModelsOutput(stdout);
				if (parsed.length > 0) {
					const prevDescById = new Map(this.cachedModels.map(m => [m.id, m.description] as const));
					this.cachedModels = parsed.map(item => {
						const desc = prevDescById.get(item.id);
						return desc ? { id: item.id, name: item.name, description: desc } : { id: item.id, name: item.name };
					});
					this.hasReceivedModels = true;
					succeeded = true;
				}
			} catch { /* Non-fatal CLI model listing probe. */ } finally {
				this.cliModelsLastSucceeded = succeeded;
				this.cliModelsAttemptedAt = Date.now();
			}
		})().finally(() => {
			this.cliModelsPromise = undefined;
		});
		return this.cliModelsPromise;
	}

	override async getRuntimeCapabilities(cwd: string, session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		await Promise.all([
			this.fetchCliModels(),
			super.getRuntimeCapabilities(cwd, session),
		]);
		return this.snapshotRuntimeCapabilities();
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

	private async resolveSqliteExecutable(): Promise<string> {
		return (await findExecutable('sqlite3')) ?? 'sqlite3';
	}

	private async listFromSqlite(): Promise<NativeSession[]> {
		const seen = new Set<string>();
		const result: NativeSession[] = [];
		const query = 'SELECT conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time FROM conversation_summaries WHERE parent_conversation_id = \'\' AND killed = 0 ORDER BY last_modified_time DESC;';
		const sqliteBin = await this.resolveSqliteExecutable();
		const sqliteEnv = stripAdeControlEnv(process.env);
		for (const home of this.agyHomes()) {
			const dbPath = path.join(home, 'conversation_summaries.db');
			try {
				await fs.access(dbPath);
			} catch {
				continue;
			}
			try {
				const { stdout } = await execFile(sqliteBin, ['-json', dbPath, query], { windowsHide: true, env: sqliteEnv });
				if (!stdout.trim()) { continue; }
				const rows = JSON.parse(stdout) as AgySummaryRow[];
				for (const row of rows) {
					if (seen.has(row.conversation_id)) { continue; }
					seen.add(row.conversation_id);
					let cwd = os.homedir();
					try {
						const uris = JSON.parse(row.workspace_uris) as string[];
						if (uris.length > 0) {
							const rawUri = uris[0];
							cwd = (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(rawUri) ? vscode.Uri.file(rawUri) : vscode.Uri.parse(rawUri)).fsPath || cwd;
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

	private async listRemoteFromSqlite(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[] | undefined> {
		if (!this.remoteTarget || this.remoteTarget.os === 'windows' || token.isCancellationRequested) {
			return undefined;
		}
		const targetCwds: string[] = [];
		if (projectCwd?.trim()) {
			targetCwds.push(normalizeRemoteCwdForCompare(projectCwd, this.remoteTarget.os));
			const realCwd = await resolveRemoteRealpath(this.remoteTarget, projectCwd, token).catch(() => undefined);
			if (realCwd) {
				const realNorm = normalizeRemoteCwdForCompare(realCwd, this.remoteTarget.os);
				if (!targetCwds.includes(realNorm)) {
					targetCwds.push(realNorm);
				}
			}
		}
		const pyAgy = [
			`import json, os, sqlite3, sys, urllib.parse`,
			`target_cwds = set(json.loads(sys.argv[1]))`,
			`homes = [os.path.expanduser("~/.gemini/antigravity"), os.path.expanduser("~/.gemini/antigravity-cli")]`,
			`def norm(p):`,
			`    p = os.path.normpath((p or "").strip())`,
			`    return p[:-1] if len(p) > 1 and p.endswith("/") else p`,
			`def uri_to_path(raw):`,
			`    if not isinstance(raw, str) or not raw: return ""`,
			`    if raw.startswith("file://"):`,
			`        return urllib.parse.unquote(urllib.parse.urlparse(raw).path)`,
			`    return raw`,
			`seen = set(); out = []`,
			`for home in homes:`,
			`    db = os.path.join(home, "conversation_summaries.db")`,
			`    if not os.path.isfile(db): continue`,
			`    try:`,
			`        con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=3.0)`,
			`        cur = con.cursor()`,
			`        rows = cur.execute("SELECT conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time FROM conversation_summaries WHERE parent_conversation_id = '' AND killed = 0 ORDER BY last_modified_time DESC LIMIT 200").fetchall()`,
			`        con.close()`,
			`    except Exception: continue`,
			`    for cid, title, preview, lmt, wuris, _pcid, luit in rows:`,
			`        if not cid or cid in seen: continue`,
			`        cwd = ""`,
			`        try:`,
			`            arr = json.loads(wuris or "[]")`,
			`            if isinstance(arr, list) and arr: cwd = uri_to_path(arr[0])`,
			`        except Exception: pass`,
			`        if not cwd: cwd = os.path.expanduser("~")`,
			`        if target_cwds and norm(cwd) not in target_cwds: continue`,
			`        seen.add(cid)`,
			`        out.append({"id": str(cid), "cwd": cwd, "title": str(title or ""), "preview": str(preview or ""), "lmt": str(lmt or ""), "luit": str(luit or "")})`,
			`print(json.dumps(out, ensure_ascii=False))`,
		].join('\n');
		const res = await execRemoteShell(
			this.remoteTarget,
			`if command -v python3 >/dev/null 2>&1; then python3 -c ${posixQuote(pyAgy)} ${posixQuote(JSON.stringify(targetCwds))}; else exit 127; fi`,
			'',
			{ timeoutMs: 8_000, token },
		).catch(() => undefined);
		if (!res || res.code !== 0) {
			return undefined;
		}
		try {
			const rows = JSON.parse(res.stdout.toString('utf8').trim() || '[]') as Array<{
				id?: string; cwd?: string; title?: string; preview?: string; lmt?: string; luit?: string;
			}>;
			const now = Date.now();
			return rows.filter(r => r.id && r.cwd).map(row => {
				const updated = this.parseTimestamp(row.lmt, this.parseTimestamp(row.luit, now));
				const cleanedTitle = stripInjectedAdeContextFromUserTurn(row.title || row.preview || '');
				const label = (cleanedTitle.trimStart().startsWith(ROLE_INIT_MARKER) ? '' : cleanedTitle).split('\n')[0].slice(0, 100)
					|| vscode.l10n.t('Antigravity Session {0}', row.id!.slice(0, 8));
				const session: NativeSession = { id: row.id!, cwd: row.cwd!, label, created: updated, updated, provisional: false };
				this.knownSessions.set(session.id, session);
				return session;
			});
		} catch {
			return undefined;
		}
	}

	async list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (token.isCancellationRequested) { return []; }
		if (this.remoteTarget && this.clientPool.size === 0) {
			const fastRemote = await this.listRemoteFromSqlite(token, projectCwd);
			if (fastRemote !== undefined) {
				return fastRemote;
			}
		}
		try {
			const client = await withTimeout(this.ensureClient(), 6000);
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
							cwd: item.cwd || (this.remoteTarget?.remoteHome || os.homedir()),
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
		if (this.remoteTarget) {
			return [];
		}
		return this.listFromSqlite();
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested || session.unmaterialized) { return []; }
		if (this.remoteTarget) {
			if (session.provisional) { return []; }
			return this.loadReplayedHistory(session, token).catch(() => []);
		}
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
		this.knownSessions.delete(session.id);
		if (this.remoteTarget) {
			return;
		}
		const sqliteBin = await this.resolveSqliteExecutable();
		const sqliteEnv = stripAdeControlEnv(process.env);
		for (const root of this.agyHomes()) {
			const convBase = path.join(root, 'conversations', session.id);
			await Promise.all([
				fs.rm(`${convBase}.db`, { force: true, maxRetries: 3, retryDelay: 100 }),
				fs.rm(`${convBase}.db-wal`, { force: true, maxRetries: 3, retryDelay: 100 }),
				fs.rm(`${convBase}.db-shm`, { force: true, maxRetries: 3, retryDelay: 100 }),
				fs.rm(path.join(root, 'brain', session.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
			]);
			const dbPath = path.join(root, 'conversation_summaries.db');
			if (/^[0-9a-f-]+$/i.test(session.id)) {
				await execFile(sqliteBin, ['-bail', dbPath, `DELETE FROM conversation_summaries WHERE conversation_id = '${session.id}';`], { windowsHide: true, env: sqliteEnv }).catch(() => { });
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

	constructor(executable: string, remoteTarget?: CloudHostTarget) {
		super(executable, ['--acp'], remoteTarget);
	}

	private clineDataDir(): string {
		const clineHome = process.env.CLINE_DIR?.trim() || path.join(os.homedir(), '.cline');
		return path.join(clineHome, 'data');
	}

	protected override async buildSpawnEnv(): Promise<NodeJS.ProcessEnv | undefined> {
		try {
			let raw: string | undefined;
			if (this.remoteTarget) {
				const remoteHome = this.remoteTarget.remoteHome;
				if (!remoteHome) {
					return undefined;
				}
				const providersPath = joinRemotePath(this.remoteTarget.os, remoteHome, '.cline', 'data', 'settings', 'providers.json');
				raw = await readRemoteTextFile(this.remoteTarget, providersPath);
			} else {
				raw = await fs.readFile(path.join(this.clineDataDir(), 'settings', 'providers.json'), 'utf8');
			}
			if (!raw) {
				return undefined;
			}
			const parsed = JSON.parse(raw) as ClineProvidersFile;
			const providerId = parsed.lastUsedProvider?.trim();
			if (!providerId || ['cline', 'cline-pass', 'openai-codex'].includes(providerId)) {
				return undefined;
			}
			const settings = parsed.providers?.[providerId]?.settings;
			if (!settings?.apiKey?.trim()) {
				return undefined;
			}
			const env: NodeJS.ProcessEnv = this.remoteTarget
				? {
					CLINE_PROVIDER: settings.provider?.trim() || providerId,
					CLINE_API_KEY: settings.apiKey,
				}
				: {
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
		const output = await withTimeout(capture(this.executable, ['history', '--json', '--limit', '500'], token, undefined, undefined, this.remoteTarget), 12000);
		const parsed = readJsonOutput<ClineHistoryItem[] | { sessions?: ClineHistoryItem[]; items?: ClineHistoryItem[] }>(output);
		return Array.isArray(parsed) ? parsed : (parsed.sessions ?? parsed.items ?? []);
	}

	private toNativeSession(item: ClineHistoryItem): NativeSession {
		const created = item.startedAt ? Date.parse(item.startedAt) : Date.now();
		const updated = (item.updatedAt ? Date.parse(item.updatedAt) : undefined) || (item.endedAt ? Date.parse(item.endedAt) : undefined) || created;
		const parentId = item.parentSessionId ?? item.metadata?.parentSessionId;
		const cleanedPrompt = stripInjectedAdeContextFromUserTurn(unwrapClineUserInput(item.prompt ?? ''));
		const rawTitle = item.metadata?.title || (cleanedPrompt.trimStart().startsWith(ROLE_INIT_MARKER) ? '' : cleanedPrompt);
		const fallbackCwd = this.remoteTarget
			? (this.remoteTarget.remoteHome || (this.remoteTarget.os === 'windows' ? 'C:\\' : '/'))
			: os.homedir();
		const fallbackFile = this.remoteTarget
			? (this.remoteTarget.remoteHome
				? joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.cline', 'data', 'sessions', item.sessionId, `${item.sessionId}.messages.json`)
				: undefined)
			: path.join(this.clineDataDir(), 'sessions', item.sessionId, `${item.sessionId}.messages.json`);
		const session: NativeSession = {
			id: item.sessionId,
			parentId,
			readOnly: !!item.isSubagent || !!parentId,
			cwd: item.cwd || item.workspaceRoot || fallbackCwd,
			label: rawTitle.split('\n')[0].slice(0, 100) || vscode.l10n.t('Cline Session {0}', item.sessionId.slice(0, 8)),
			created: Number.isFinite(created) ? created : Date.now(),
			updated: Number.isFinite(updated) ? updated : Date.now(),
			file: item.messagesPath || fallbackFile,
			provisional: false,
		};
		this.knownSessions.set(session.id, session);
		return session;
	}

	async list(token: vscode.CancellationToken, _projectCwd?: string): Promise<NativeSession[]> {
		const items = await this.fetchHistoryItems(token);
		return items.filter(item => !item.isSubagent).map(item => this.toNativeSession(item));
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		const items = await this.fetchHistoryItems(token);
		return items.filter(item => (item.parentSessionId ?? item.metadata?.parentSessionId) === session.id).map(item => this.toNativeSession(item));
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (token.isCancellationRequested || session.unmaterialized || (session.provisional && !session.file)) { return []; }
		let raw: string | undefined;
		if (this.remoteTarget) {
			const remoteFile = session.file ?? (this.remoteTarget.remoteHome
				? joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.cline', 'data', 'sessions', session.id, `${session.id}.messages.json`)
				: undefined);
			if (remoteFile) {
				raw = await readRemoteTextFile(this.remoteTarget, remoteFile, { bypassCache: true, timeoutMs: 20_000, token });
			}
			if (!raw) {
				return this.loadReplayedHistory(session, token).catch(() => []);
			}
		} else {
			const file = session.file ?? path.join(this.clineDataDir(), 'sessions', session.id, `${session.id}.messages.json`);
			try {
				raw = await fs.readFile(file, 'utf8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
				throw error;
			}
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
				await capture(this.executable, ['history', 'delete', '--session-id', session.id], token, undefined, undefined, this.remoteTarget);
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
				if (!message.includes('not found') && !message.includes('does not exist') && !message.includes('no session')) {
					throw error;
				}
			}
		}
		if (this.remoteTarget) {
			const safeId = session.id.replace(/[^A-Za-z0-9._-]/g, '');
			if (safeId) {
				await execRemoteShell(
					this.remoteTarget,
					`rm -rf -- "\${CLINE_DIR:-$HOME/.cline}/data/sessions/${safeId}"`,
					`$h = if ($env:CLINE_DIR) { $env:CLINE_DIR } else { Join-Path $env:USERPROFILE '.cline' }; Remove-Item -LiteralPath (Join-Path $h ${psSingleQuote(`data\\sessions\\${safeId}`)}) -Recurse -Force -ErrorAction SilentlyContinue`,
					{ timeoutMs: 12_000, token },
				).catch(() => undefined);
			}
			return;
		}
		await fs.rm(path.join(this.clineDataDir(), 'sessions', session.id), { recursive: true, force: true });
	}
}
