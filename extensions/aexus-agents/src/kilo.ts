/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import {
	buildRemotePersistentPrefix,
	CloudHostTarget,
	execRemoteShell,
	normalizeRemoteCwdForCompare,
	openRemotePortForward,
	posixQuote,
	RemotePortForwardHandle,
	remotePathToFileUrl,
	resolveRemoteRealpath,
	spawnRemoteEngine,
	terminateRemotePersistentSession,
	terminateRemotePersistentSessionsByPrefix,
} from './cloudTransport';
import { AEXUS_INTERNAL_RUNTIME_HEADER, AgentChildIdentity, SHARED_PURE_SCOPE_KEY } from './roleBridgeShared';
import { agentIdentityScopeKey, capture, createTurnInterimUsageTracker, EngineAttachment, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineTurnTokenUsage, emitThinkingProgress, getConfiguredEngineTurnTimeoutMs, HistoryEntry, isAutonomousModeEnabled, NativeSession, prepareAgentChildEnv, prepareRemoteAgentChildEnv, raceWithCancellation, readJsonOutput, spawnEngine, stopEngine, stopEngineWithFallback, withTimeout } from './runtime';
import { createMultiStepTurnUsageAccumulator, normalizeProviderTokenUsage } from './usageTracker';

interface KiloSession { id: string; parentID?: string; directory: string; title: string; time?: { created: number; updated: number }; created?: number; updated?: number; share?: { url?: string } }
interface KiloSessionListItem { id: string; directory: string; title: string; created: number; updated: number }
interface KiloPart { id: string; type: string; text?: string; sessionID?: string; tool?: string; cost?: number; tokens?: KiloTokens; state?: { status?: string; title?: string } }
interface KiloMessage { info: { id: string; role: string; tokens?: KiloTokens; cost?: number; modelID?: string; providerID?: string; error?: { data?: { message?: string } } }; parts: KiloPart[] }
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
interface KiloTokens { input?: number; output?: number; total?: number; cache?: { read?: number; write?: number } }
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
	info?: Partial<KiloSession> & { id: string; role?: string; sessionID?: string; tokens?: KiloTokens; cost?: number; modelID?: string; providerID?: string };
	questions?: { header: string; question: string; options: { label: string; description: string }[]; multiple?: boolean }[];
}
interface KiloEvent { type: string; properties?: KiloEventData; data?: KiloEventData }

function formatKiloModelId(providerID?: string, modelID?: string): string | undefined {
	const m = modelID?.trim();
	if (!m) {
		return undefined;
	}
	const p = providerID?.trim();
	return p && !m.startsWith(`${p}/`) ? `${p}/${m}` : m;
}

function turnUsageFromKiloTokens(tokens: KiloTokens | undefined, costUsd?: number, model?: string): EngineTurnTokenUsage | undefined {
	if (!tokens) {
		return undefined;
	}
	const validCostUsd = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : undefined;
	const validModel = model?.trim() && model.trim().toLowerCase() !== 'default' ? model.trim() : undefined;
	return normalizeProviderTokenUsage(tokens, {
		costUsd: validCostUsd,
		model: validModel,
	});
}

const SHARED_PURE_SERVER_KEY = `${SHARED_PURE_SCOPE_KEY}:auto`;

function isSharedPureServerKey(key: string): boolean {
	return key === SHARED_PURE_SCOPE_KEY || key.startsWith(`${SHARED_PURE_SCOPE_KEY}:`);
}

interface SharedServerSlot {
	child?: ReturnType<typeof spawnEngine>;
	tunnel?: RemotePortForwardHandle;
	endpoint?: Promise<string>;
	remotePersistentId?: string;
	readonly password: string;
	readonly identity: AgentChildIdentity;
	readonly autoApprove: boolean;
	readonly cwd?: string;
}

abstract class SharedServerRuntime implements EngineRuntime {
	abstract readonly id: string;
	abstract readonly name: string;
	protected abstract readonly envPrefix: string;

	protected readonly servers = new Map<string, SharedServerSlot>();
	protected readonly sessionServerKeys = new Map<string, string>();
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

	constructor(protected readonly executable: string, readonly remoteTarget?: CloudHostTarget) { }

	private shouldAutoApprove(options?: EngineSendOptions): boolean {
		if (options?.automatedEngineering) {
			return true;
		}
		const perm = options?.permissionMode?.trim();
		if (perm === 'ask' || perm === 'manual') {
			return false;
		}
		if (perm === 'bypassPermissions' || perm === 'auto' || perm === 'never' || perm === 'danger-full-access') {
			return true;
		}
		return isAutonomousModeEnabled();
	}

	private resolveServerDescriptor(sessionId?: string, options?: EngineSendOptions, cwd?: string): { readonly key: string; readonly identity: AgentChildIdentity; readonly autoApprove: boolean; readonly cwd?: string } {
		const autoApprove = this.shouldAutoApprove(options);
		if (!sessionId || !options) {
			return {
				key: `${SHARED_PURE_SCOPE_KEY}:${autoApprove ? 'auto' : 'ask'}`,
				identity: { sessionId: `${this.id}-pure`, pureWorker: true },
				autoApprove,
			};
		}
		const effectiveSid = options.adeSessionId || sessionId;
		const identityScope = agentIdentityScopeKey(effectiveSid, options, cwd);
		const isPure = identityScope.startsWith('pure:');
		const identity: AgentChildIdentity = isPure
			? { sessionId: effectiveSid, pureWorker: true }
			: { sessionId: effectiveSid, callerRole: options.callerRole, pureWorker: options.pureWorker, isMissionNode: options.isMissionNode };
		return {
			key: `${identityScope}:${autoApprove ? 'auto' : 'ask'}`,
			identity,
			autoApprove,
			cwd,
		};
	}

	private disposeSlotRemote(slot: SharedServerSlot | undefined): void {
		if (!slot?.remotePersistentId || !this.remoteTarget || this.remoteTarget.os === 'windows') {
			return;
		}
		const pid = slot.remotePersistentId;
		slot.remotePersistentId = undefined;
		void terminateRemotePersistentSession(this.remoteTarget, pid, { killTree: true }).catch(() => undefined);
	}

	private retireStaleServerSlot(sessionId: string, nextServerKey: string): void {
		const prevKey = this.sessionServerKeys.get(sessionId);
		if (!prevKey || prevKey === nextServerKey || isSharedPureServerKey(prevKey)) {
			return;
		}
		const prevSlot = this.servers.get(prevKey);
		if (prevSlot) {
			prevSlot.tunnel?.dispose();
			prevSlot.tunnel = undefined;
			if (prevSlot.child) {
				stopEngine(prevSlot.child);
			}
			this.disposeSlotRemote(prevSlot);
			this.servers.delete(prevKey);
		}
	}

	private ensureServerSlot(key: string, identity: AgentChildIdentity, autoApprove: boolean, cwd?: string): SharedServerSlot {
		let slot = this.servers.get(key);
		if (!slot) {
			slot = { password: randomBytes(24).toString('hex'), identity, autoApprove, cwd };
			this.servers.set(key, slot);
		}
		return slot;
	}

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
				this.tryRequest<unknown>('/config/providers', cwd, 8000),
				this.tryRequest<unknown>('/agent', cwd, 6000),
				this.tryRequest<unknown>('/command', cwd, 6000),
			]);
			const models = providers !== undefined ? extractProviderModels(providers) : undefined;
			const modes = agents !== undefined ? extractModes(agents) : undefined;
			const cmds = commands !== undefined ? extractCommands(commands) : undefined;
			const defaultMap = asRecord(asRecord(providers)?.default);
			let defaultModel: string | undefined;
			if (defaultMap) {
				for (const [providerID, rawModel] of Object.entries(defaultMap)) {
					const modelID = stringValue(rawModel);
					if (modelID) {
						defaultModel = modelID.startsWith(`${providerID}/`) ? modelID : `${providerID}/${modelID}`;
						break;
					}
				}
			}
			const value: EngineRuntimeCapabilities = {
				defaultModel,
				models: models?.map(m => ({ ...m })),
				modes: modes?.map(m => ({ ...m })),
				commands: cmds?.map(c => ({ ...c })),
			};
			const hasData = Boolean((models && models.length > 0) || (modes && modes.length > 0) || (cmds && cmds.length > 0));
			const ttl = hasData ? 15_000 : 2_000;
			this.capabilityCache.set(cwd, { expiresAt: Date.now() + ttl, value });
			return {
				defaultModel: value.defaultModel,
				models: value.models?.map(m => ({ ...m })),
				modes: value.modes?.map(m => ({ ...m })),
				commands: value.commands?.map(c => ({ ...c })),
			};
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

	private async messageParts(text: string, attachments?: readonly EngineAttachment[]): Promise<object[]> {
		const parts: object[] = [{ type: 'text', text }];
		for (const attachment of attachments ?? []) {
			const isImage = attachment.kind === 'image' || Boolean(attachment.mimeType?.startsWith('image/'));
			if (this.remoteTarget) {
				if (isImage && !attachment.remote) {
					try {
						const data = (await fs.readFile(attachment.filePath)).toString('base64');
						if (data) {
							parts.push({ type: 'file', mime: attachment.mimeType || 'image/png', url: `data:${attachment.mimeType || 'image/png'};base64,${data}` });
							continue;
						}
					} catch { /* Fall back to text reference. */ }
				}
				if (attachment.rangeText) {
					parts.push({ type: 'text', text: `${attachment.filePath}\n${attachment.rangeText}` });
				} else if (attachment.remote) {
					parts.push({ type: 'file', mime: attachment.mimeType || (isImage ? 'image/png' : 'text/plain'), url: remotePathToFileUrl(attachment.filePath, this.remoteTarget.os) });
				} else {
					parts.push({ type: 'text', text: attachment.filePath });
				}
				continue;
			}
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

	private getEndpoint(serverKey = SHARED_PURE_SERVER_KEY, identity?: AgentChildIdentity, autoApprove = isAutonomousModeEnabled(), cwd?: string): Promise<{ readonly url: string; readonly password: string }> {
		const slot = this.ensureServerSlot(
			serverKey,
			identity ?? { sessionId: `${this.id}-pure`, pureWorker: true },
			autoApprove,
			cwd,
		);
		if (!slot.endpoint) {
			slot.endpoint = (async () => {
				const childEnv = this.remoteTarget
					? await prepareRemoteAgentChildEnv(this.remoteTarget, slot.identity)
					: await prepareAgentChildEnv(slot.identity);
				const serverEnv: NodeJS.ProcessEnv = {
					...childEnv,
					[`${this.envPrefix}_SERVER_USERNAME`]: 'aexus',
					[`${this.envPrefix}_SERVER_PASSWORD`]: slot.password,
					[`${this.envPrefix}_PERMISSION`]: slot.autoApprove ? '{"*":"allow"}' : '{"*":"ask"}',
				};
				const remoteTarget = this.remoteTarget;
				const remotePersistentId = remoteTarget && remoteTarget.os !== 'windows' && serverKey !== SHARED_PURE_SERVER_KEY
					? `${buildRemotePersistentPrefix(this.id, slot.identity.sessionId || serverKey)}-${randomUUID().slice(0, 8)}`
					: undefined;
				slot.remotePersistentId = remotePersistentId;
				const boundAddress = await new Promise<string>((resolve, reject) => {
					const child = slot.child = remoteTarget
						? spawnRemoteEngine(
							remoteTarget,
							this.executable,
							['serve', '--hostname', '127.0.0.1', '--port', '0'],
							slot.cwd,
							serverEnv,
							remotePersistentId ? { persistentSessionId: remotePersistentId } : { killOnStdinClose: true },
						)
						: spawnEngine(this.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], slot.cwd, serverEnv);
					let output = '';
					let settled = false;
					const inspect = (data: Buffer) => {
						if (settled) { return; }
						output = (output + String(data)).slice(-8000);
						const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
						if (address) {
							settled = true;
							resolve(address);
						}
					};
					child.stdout.on('data', inspect);
					child.stderr.on('data', inspect);
					child.on('error', err => {
						if (!settled) { settled = true; reject(err); }
					});
					child.on('exit', code => {
						slot.tunnel?.dispose();
						slot.tunnel = undefined;
						slot.endpoint = undefined;
						slot.child = undefined;
						if (!settled) {
							settled = true;
							reject(new Error(vscode.l10n.t('{0} ended before its local connection was ready ({1}).', this.name, String(code))));
						}
					});
				});
				if (remoteTarget) {
					const remotePort = Number(new URL(boundAddress).port);
					if (!Number.isInteger(remotePort) || remotePort <= 0) {
						throw new Error(`Could not determine remote port for ${this.name} on ${remoteTarget.alias}: ${boundAddress}`);
					}
					const tunnel = await openRemotePortForward(remoteTarget, remotePort);
					if (this.servers.get(serverKey) !== slot || !slot.child || slot.child.killed || slot.child.exitCode !== null) {
						tunnel.dispose();
						throw new Error(vscode.l10n.t('{0} on {1} exited while opening port forward.', this.name, remoteTarget.alias));
					}
					slot.tunnel?.dispose();
					slot.tunnel = tunnel;
					return tunnel.localUrl;
				}
				return boundAddress;
			})();
		}
		return slot.endpoint.then(url => ({ url, password: slot.password }));
	}

	protected async request<T>(route: string, cwd: string, method = 'GET', body?: object, signal?: AbortSignal, serverKey = SHARED_PURE_SERVER_KEY, identity?: AgentChildIdentity, autoApprove = isAutonomousModeEnabled()): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			let receivedHttpResponse = false;
			try {
				const ep = await this.getEndpoint(serverKey, identity, autoApprove, serverKey === SHARED_PURE_SERVER_KEY ? undefined : cwd);
				const url = new URL(route, ep.url);
				url.searchParams.set('directory', cwd);
				const response = await fetch(url, {
					method,
					headers: {
						Authorization: `Basic ${Buffer.from(`aexus:${ep.password}`).toString('base64')}`,
						'Content-Type': 'application/json',
						[AEXUS_INTERNAL_RUNTIME_HEADER]: '1',
					},
					body: body ? JSON.stringify(body) : undefined,
					signal,
				});
				receivedHttpResponse = true;
				if (!response.ok) {
					const httpErr = new Error(vscode.l10n.t('{0} returned {1}: {2}', this.name, String(response.status), (await response.text()).slice(0, 2000))) as Error & { httpStatus?: number };
					httpErr.httpStatus = response.status;
					throw httpErr;
				}
				return response.status === 204 ? undefined as T : await response.json() as T;
			} catch (error) {
				lastError = error;
				// Never tear down a live server (especially shared pure auto/ask pools) on an application-level HTTP 4xx/5xx status!
				const slot = this.servers.get(serverKey);
				if (attempt === 0 && !receivedHttpResponse && !signal?.aborted && slot) {
					if (!isSharedPureServerKey(serverKey) || !slot.child || slot.child.exitCode !== null || slot.child.killed) {
						slot.tunnel?.dispose();
						slot.tunnel = undefined;
						if (slot.child) {
							stopEngineWithFallback(slot.child, 'SIGTERM', 1500);
							slot.child = undefined;
						}
						this.disposeSlotRemote(slot);
						slot.endpoint = undefined;
					}
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

	abstract list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]>;

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		if (this.remoteTarget) {
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

	async prepareSession(session: NativeSession, options?: EngineSendOptions): Promise<void> {
		const desc = this.resolveServerDescriptor(session.id, options, session.cwd);
		this.retireStaleServerSlot(session.id, desc.key);
		if (!session.unmaterialized) {
			return;
		}
		const created = this.session(await this.request<KiloSession>('/session', session.cwd, 'POST', {}, undefined, desc.key, desc.identity, desc.autoApprove));
		const prevId = session.id;
		session.id = created.id;
		session.unmaterialized = false;
		session.provisional = false;
		const resolvedDesc = this.resolveServerDescriptor(session.id, options, session.cwd);
		if (resolvedDesc.key !== desc.key && this.servers.has(desc.key) && !this.servers.has(resolvedDesc.key)) {
			const moved = this.servers.get(desc.key)!;
			this.servers.delete(desc.key);
			this.servers.set(resolvedDesc.key, moved);
		}
		this.sessionServerKeys.delete(prevId);
		this.sessionServerKeys.set(session.id, resolvedDesc.key);
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

	private async answer(event: KiloEvent, data: KiloEventData, session: NativeSession, token: vscode.CancellationToken, autoApprove: boolean, serverKey: string, identity: AgentChildIdentity): Promise<void> {
		if (event.type === 'permission.asked') {
			if (autoApprove) {
				try {
					await this.request(`/permission/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { reply: 'always' }, undefined, serverKey, identity, autoApprove);
				} catch {
					await this.request(`/permission/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { reply: 'once' }, undefined, serverKey, identity, autoApprove);
				}
				return;
			}
			const allow = vscode.l10n.t('Allow Once');
			const picked = await vscode.window.showQuickPick([allow, vscode.l10n.t('Deny')], {
				title: vscode.l10n.t('{0} requests permission', this.name),
				placeHolder: `${session.cwd}: ${data.permission}: ${(data.patterns ?? []).join(', ')}`,
				ignoreFocusOut: true,
			}, token);
			await this.request(`/permission/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { reply: picked === allow ? 'once' : 'reject' }, undefined, serverKey, identity, autoApprove);
		}
		if (event.type === 'question.asked') {
			if (autoApprove) {
				const autoAnswers = (data.questions ?? []).map(q => q.options?.[0]?.label ? [q.options[0].label] : []);
				await this.request(`/question/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { answers: autoAnswers }, undefined, serverKey, identity, autoApprove);
				return;
			}
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
			await this.request(`/question/${encodeURIComponent(data.id!)}/reply`, session.cwd, 'POST', { answers }, undefined, serverKey, identity, autoApprove);
		}
	}

	async killSession(session: NativeSession): Promise<void> {
		const serverKey = this.sessionServerKeys.get(session.id) ?? SHARED_PURE_SERVER_KEY;
		const slot = this.servers.get(serverKey);
		if (slot?.endpoint) {
			await this.request(`/session/${encodeURIComponent(session.id)}/abort`, session.cwd, 'POST', undefined, undefined, serverKey, slot.identity, slot.autoApprove).catch(() => { });
		}
		this.sessionServerKeys.delete(session.id);
		const persistentIdToKill = !isSharedPureServerKey(serverKey) ? slot?.remotePersistentId : undefined;
		if (!isSharedPureServerKey(serverKey) && slot) {
			slot.tunnel?.dispose();
			slot.tunnel = undefined;
			if (slot.child) { stopEngineWithFallback(slot.child, 'SIGTERM', 1500); }
			this.servers.delete(serverKey);
		}
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			const kills: Promise<void>[] = [
				terminateRemotePersistentSessionsByPrefix(this.remoteTarget, buildRemotePersistentPrefix(this.id, session.id), { killTree: true }),
			];
			if (persistentIdToKill) {
				kills.push(terminateRemotePersistentSession(this.remoteTarget, persistentIdToKill, { killTree: true }));
			}
			await Promise.all(kills);
		}
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		this.knownSessions.set(session.id, session);
		const desc = this.resolveServerDescriptor(session.id, options, session.cwd);
		this.retireStaleServerSlot(session.id, desc.key);
		this.sessionServerKeys.set(session.id, desc.key);
		const abort = new AbortController();
		const earlyCancel = token.onCancellationRequested(() => abort.abort());
		const onCoordinatorAbort = () => {
			void this.request(`/session/${encodeURIComponent(session.id)}/abort`, session.cwd, 'POST', undefined, undefined, desc.key, desc.identity, desc.autoApprove).catch(() => { });
			abort.abort(options?.abortSignal?.reason);
		};
		if (options?.abortSignal?.aborted) {
			abort.abort(options.abortSignal.reason);
		} else {
			options?.abortSignal?.addEventListener('abort', onCoordinatorAbort, { once: true });
		}
		let ep: { url: string; password: string };
		let response: Response;
		try {
			try {
				ep = await raceWithCancellation(
					withTimeout(this.getEndpoint(desc.key, desc.identity, desc.autoApprove, desc.cwd), 25_000),
					token,
				);
			} catch (error) {
				if (token.isCancellationRequested || error instanceof vscode.CancellationError) {
					return;
				}
				const failedSlot = this.servers.get(desc.key);
				if (failedSlot && (!isSharedPureServerKey(desc.key) || !failedSlot.child || failedSlot.child.exitCode !== null)) {
					this.servers.delete(desc.key);
					failedSlot.tunnel?.dispose();
					failedSlot.tunnel = undefined;
					if (failedSlot.child) {
						stopEngineWithFallback(failedSlot.child, 'SIGTERM', 1500);
						failedSlot.child = undefined;
					}
					this.disposeSlotRemote(failedSlot);
					failedSlot.endpoint = undefined;
				}
				throw error;
			}
			if (token.isCancellationRequested) {
				return;
			}
			const url = new URL('/event', ep.url);
			url.searchParams.set('directory', session.cwd);
			response = await fetch(url, {
				headers: {
					Authorization: `Basic ${Buffer.from(`aexus:${ep.password}`).toString('base64')}`,
					[AEXUS_INTERNAL_RUNTIME_HEADER]: '1',
				},
				signal: abort.signal,
			});
		} catch (error) {
			options?.abortSignal?.removeEventListener('abort', onCoordinatorAbort);
			if (token.isCancellationRequested || abort.signal.aborted) {
				return;
			}
			throw error;
		} finally {
			earlyCancel.dispose();
		}
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
		const requestedModelStr = options?.model && options.model !== 'default' ? options.model.trim() : undefined;
		const usageTracker = createTurnInterimUsageTracker(text, options?.onInterimUsage, {
			model: requestedModelStr,
		});
		const stepUsageAccumulator = createMultiStepTurnUsageAccumulator();
		const seenFailedPartIds = new Set<string>();
		const effectiveTimeoutMs = options?.timeoutMs ?? getConfiguredEngineTurnTimeoutMs();
		const turnDeadlineTimer = setTimeout(() => {
			if (!abort.signal.aborted) {
				void this.request(`/session/${encodeURIComponent(session.id)}/abort`, session.cwd, 'POST', undefined, undefined, desc.key, desc.identity, desc.autoApprove).catch(() => { });
				abort.abort(new Error(`${this.name} turn timed out after ${effectiveTimeoutMs}ms`));
			}
		}, effectiveTimeoutMs);
		turnDeadlineTimer.unref?.();
		const reader = response.body.getReader();
		const events = (async () => {
			const decoder = new TextDecoder();
			let buffer = '';
			while (!abort.signal.aborted) {
				const chunk = await reader.read();
				if (chunk.done) { break; }
				const decoded = decoder.decode(chunk.value, { stream: true });
				buffer += decoded.includes('\r') ? decoded.replace(/\r\n/g, '\n') : decoded;
				if (buffer.length > 32 * 1024 * 1024 && !buffer.includes('\n\n')) {
					buffer = '';
					continue;
				}
				let scanStart = 0;
				let end: number;
				while ((end = buffer.indexOf('\n\n', scanStart)) >= 0) {
					const packet = buffer.slice(scanStart, end);
					scanStart = end + 2;
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
					if (sessionId && this.belongsTo(sessionId, session.id)) {
						try { options?.onStreamActivity?.(); } catch { /* ignore */ }
					}
					if (sessionId && data?.info?.tokens && data.info.role !== 'user') {
						const infoModel = formatKiloModelId(data.info.providerID, data.info.modelID) ?? requestedModelStr;
						const usage = turnUsageFromKiloTokens(data.info.tokens, data.info.cost, infoModel);
						if (usage) {
							if (sessionId === session.id) {
								const aggregated = stepUsageAccumulator.recordStep(data.info.id || '__kilo_step', usage);
								const normalized = usageTracker.recordRealUsage(aggregated, { cumulativeAcrossThread: false });
								this.lastTurnUsageBySession.set(sessionId, normalized);
							} else {
								this.lastTurnUsageBySession.set(sessionId, usage);
							}
						}
					}
					if (data && sessionId && (event.type === 'permission.asked' || event.type === 'question.asked') && this.belongsTo(sessionId, session.id)) {
						const targetSession = this.knownSessions.get(sessionId) ?? session;
						if (!desc.autoApprove) {
							try { options?.onExternalWaitStart?.(); } catch { /* ignore */ }
						}
						void this.answer(event, data, targetSession, token, desc.autoApprove, desc.key, desc.identity)
							.catch(() => { })
							.finally(() => {
								if (!desc.autoApprove) {
									try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
								}
							});
					}
					if (!data || sessionId !== session.id) { continue; }
					if (event.type === 'message.updated' && data.info?.role) { roles.set(data.info.id, data.info.role); }
					if (event.type === 'message.part.updated' && data.part) {
						parts.set(data.part.id, data.part.type);
						if (data.part.type === 'tool') {
							if (data.part.state?.status === 'error' || data.part.state?.status === 'failed') {
								const partKey = data.part.id || undefined;
								if (!partKey || !seenFailedPartIds.has(partKey)) {
									if (partKey) {
										seenFailedPartIds.add(partKey);
									}
									usageTracker.recordToolError();
									const currentUsage = this.lastTurnUsageBySession.get(session.id);
									if (currentUsage) {
										this.lastTurnUsageBySession.set(session.id, {
											...currentUsage,
											hadToolError: true,
											toolErrorCount: Math.max(currentUsage.toolErrorCount ?? 0, usageTracker.getToolErrorCount()),
										});
									}
								}
							}
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
							usageTracker.recordStreamDelta(data.delta);
						} else if (partType === 'reasoning') {
							emitReasoningDelta(data.partID!, data.delta);
							usageTracker.recordStreamDelta(data.delta, { skipToolErrorScan: true });
						}
					}
				}
				if (scanStart > 0) {
					buffer = buffer.slice(scanStart);
				}
			}
		})();
		void events.catch(() => { });
		const cancellation = token.onCancellationRequested(() => {
			void this.request(`/session/${encodeURIComponent(session.id)}/abort`, session.cwd, 'POST', undefined, undefined, desc.key, desc.identity, desc.autoApprove).catch(() => { });
			abort.abort();
		});
		try {
			stream.progress(vscode.l10n.t('{0} is working…', this.name));
			const messageParts = await this.messageParts(text, options?.attachments);
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
				result = await this.request<KiloMessage>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', payloadBase, abort.signal, desc.key, desc.identity, desc.autoApprove);
			} catch (err) {
				const status = (err as { httpStatus?: number } | undefined)?.httpStatus;
				const canDropModelOrVariant = payloadBase.model !== undefined || payloadBase.variant !== undefined;
				const isValidationRejection = status === 400 || status === 422;
				if (!canDropModelOrVariant || !isValidationRejection || streamed || abort.signal.aborted || token.isCancellationRequested) {
					throw err;
				}
				// Retry once on pre-stream HTTP 400/422 validation rejection by dropping unsupported `variant`/`model`
				// while strictly preserving `agent` (never silently downgrading read-only `plan`/`architect` mode!).
				const fallbackPayload: Record<string, unknown> = {
					parts: messageParts,
					...(payloadBase.agent !== undefined ? { agent: payloadBase.agent } : {}),
				};
				result = await this.request<KiloMessage>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', fallbackPayload, abort.signal, desc.key, desc.identity, desc.autoApprove);
			}
			if (result.info.error) { throw new Error(result.info.error.data?.message || vscode.l10n.t('{0} could not complete this request.', this.name)); }
			for (const part of result.parts ?? []) {
				if (part.type === 'tool' && (part.state?.status === 'error' || part.state?.status === 'failed')) {
					const partKey = part.id || undefined;
					if (!partKey || !seenFailedPartIds.has(partKey)) {
						if (partKey) {
							seenFailedPartIds.add(partKey);
						}
						usageTracker.recordToolError();
					}
				}
			}
			if (result.info.tokens) {
				const resolvedModelStr = formatKiloModelId(result.info.providerID ?? model?.providerID, result.info.modelID ?? model?.modelID) ?? requestedModelStr;
				const resultUsage = turnUsageFromKiloTokens(result.info.tokens, result.info.cost, resolvedModelStr);
				if (resultUsage) {
					const aggregated = stepUsageAccumulator.recordStep(result.info.id || '__kilo_final', resultUsage);
					const normalized = usageTracker.recordRealUsage(aggregated, { cumulativeAcrossThread: false });
					this.lastTurnUsageBySession.set(session.id, normalized);
				}
			} else if (usageTracker.getToolErrorCount() > 0) {
				const prevUsage = this.lastTurnUsageBySession.get(session.id);
				if (prevUsage) {
					this.lastTurnUsageBySession.set(session.id, {
						...prevUsage,
						hadToolError: true,
						toolErrorCount: Math.max(prevUsage.toolErrorCount ?? 0, usageTracker.getToolErrorCount()),
					});
				}
			}
			if (!streamed) { for (const part of result.parts) { if (part.type === 'text' && part.text) { stream.markdown(part.text); } } }
		} finally {
			clearTimeout(turnDeadlineTimer);
			options?.abortSignal?.removeEventListener('abort', onCoordinatorAbort);
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
		const serverKey = this.sessionServerKeys.get(session.id) ?? SHARED_PURE_SERVER_KEY;
		const slot = this.servers.get(serverKey);
		try {
			if (slot?.endpoint) {
				await this.request(`/session/${encodeURIComponent(session.id)}`, session.cwd, 'DELETE', undefined, undefined, serverKey, slot.identity, slot.autoApprove);
			} else {
				await capture(this.executable, ['session', 'delete', session.id], token, undefined, undefined, this.remoteTarget);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (!message.includes('404') && !message.includes('not found') && !message.includes('does not exist')) {
				throw error;
			}
		}
		this.sessionServerKeys.delete(session.id);
		if (!isSharedPureServerKey(serverKey) && slot) {
			slot.tunnel?.dispose();
			slot.tunnel = undefined;
			if (slot.child) { stopEngineWithFallback(slot.child, 'SIGTERM', 1500); }
			if (this.remoteTarget && slot.remotePersistentId) {
				await terminateRemotePersistentSession(this.remoteTarget, slot.remotePersistentId, { killTree: true }).catch(() => undefined);
			}
			this.servers.delete(serverKey);
		}
		this.knownSessions.delete(session.id);
		for (const [id, entry] of [...this.knownSessions.entries()]) {
			if (entry.parentId === session.id) {
				this.knownSessions.delete(id);
			}
		}
	}

	dispose(): void {
		this.changed.dispose();
		for (const slot of this.servers.values()) {
			slot.tunnel?.dispose();
			slot.tunnel = undefined;
			if (slot.child) { stopEngine(slot.child); }
			if (this.remoteTarget && slot.remotePersistentId) {
				void terminateRemotePersistentSession(this.remoteTarget, slot.remotePersistentId, { killTree: true }).catch(() => undefined);
			}
		}
		this.servers.clear();
		this.sessionServerKeys.clear();
	}
}

export class KiloRuntime extends SharedServerRuntime {
	readonly id = 'kilo';
	readonly name = 'Kilo Code';
	protected readonly envPrefix = 'KILO';

	async list(token: vscode.CancellationToken, _projectCwd?: string): Promise<NativeSession[]> {
		const output = await capture(this.executable, ['session', 'list', '--all', '--format', 'json'], token, undefined, undefined, this.remoteTarget);
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

	async list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (token.isCancellationRequested) { return []; }
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
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
			const pyOpenCode = [
				`import json, os, sqlite3, sys`,
				`target_cwds = set(json.loads(sys.argv[1]))`,
				`xdg = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")`,
				`db = os.path.join(xdg, "opencode", "opencode.db")`,
				`if not os.path.isfile(db): sys.exit(2)`,
				`def norm(p):`,
				`    p = os.path.normpath((p or "").strip())`,
				`    return p[:-1] if len(p) > 1 and p.endswith("/") else p`,
				`con = sqlite3.connect("file:" + db + "?mode=ro", uri=True, timeout=3.0)`,
				`try:`,
				`    cur = con.cursor()`,
				`    rows = cur.execute("SELECT id, directory, title, time_created, time_updated FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 300").fetchall()`,
				`    out = []`,
				`    for sid, directory, title, created, updated in rows:`,
				`        if not sid or not directory: continue`,
				`        if target_cwds and norm(str(directory)) not in target_cwds: continue`,
				`        out.append({"id": str(sid), "directory": str(directory), "title": str(title or ""), "created": int(created or 0), "updated": int(updated or 0)})`,
				`    print(json.dumps(out, ensure_ascii=False))`,
				`finally:`,
				`    con.close()`,
			].join('\n');
			const pyRes = await execRemoteShell(
				this.remoteTarget,
				`if command -v python3 >/dev/null 2>&1; then python3 -c ${posixQuote(pyOpenCode)} ${posixQuote(JSON.stringify(targetCwds))}; else exit 127; fi`,
				'',
				{ timeoutMs: 12_000, token },
			).catch(() => undefined);
			if (pyRes && pyRes.code === 0) {
				try {
					const items = JSON.parse(pyRes.stdout.toString('utf8').trim() || '[]') as KiloSessionListItem[];
					return items.map(item => {
						const entry: NativeSession = {
							id: item.id,
							cwd: item.directory,
							label: item.title || vscode.l10n.t('OpenCode Session {0}', item.id.slice(0, 8)),
							created: item.created,
							updated: item.updated,
						};
						this.knownSessions.set(entry.id, entry);
						return entry;
					});
				} catch { /* fall through to RPC / CLI */ }
			}
		}
		try {
			const listCwd = projectCwd?.trim() || (this.remoteTarget ? (this.remoteTarget.remoteHome || (this.remoteTarget.os === 'windows' ? 'C:\\' : '/')) : os.homedir());
			const items = await this.request<KiloSession[]>('/experimental/session?roots=true&limit=200', listCwd);
			return items.map(item => this.session(item));
		} catch {
			const sql = 'SELECT id, directory, title, time_created AS created, time_updated AS updated FROM session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_updated DESC';
			const output = await capture(this.executable, ['db', sql, '--format', 'json'], token, undefined, undefined, this.remoteTarget);
			return readJsonOutput<KiloSessionListItem[]>(output).map(item => {
				const entry: NativeSession = { id: item.id, cwd: item.directory, label: item.title || vscode.l10n.t('OpenCode Session {0}', item.id.slice(0, 8)), created: item.created, updated: item.updated };
				this.knownSessions.set(entry.id, entry);
				return entry;
			});
		}
	}
}
