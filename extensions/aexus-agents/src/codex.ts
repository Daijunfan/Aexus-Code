/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
	buildRemotePersistentPrefix,
	CloudHostTarget,
	execRemoteShell,
	joinRemotePath,
	normalizeRemoteCwdForCompare,
	posixQuote,
	psSingleQuote,
	readRemoteTextFile,
	resolveRemoteRealpath,
	stageLocalFileToRemote,
	terminateRemotePersistentSessionsByPrefix,
} from './cloudTransport';
import { mapCodexReasoningEffort, planCodexTurnFallbacks } from './engineAdapterHelpers';
import { AgentChildIdentity, CodexSandboxMode, resolveCodexSandboxMode, SHARED_PURE_SCOPE_KEY } from './roleBridgeShared';
import { agentIdentityScopeKey, createTurnInterimUsageTracker, emitThinkingProgress, EngineRuntime, EngineRuntimeCapabilities, EngineSendOptions, EngineThinkingLevel, EngineTurnTokenUsage, HistoryEntry, isAutonomousModeEnabled, JsonLineClient, NativeSession, normalizeProviderTokenUsage, prepareAgentChildEnv, prepareRemoteAgentChildEnv, raceWithCancellation, RpcPacket, withTimeout } from './runtime';

interface ThreadItem {
	id?: string;
	type: string;
	status?: string;
	exitCode?: number | null;
	exit_code?: number | null;
	error?: unknown;
	isError?: boolean;
	text?: string;
	command?: string;
	server?: string;
	tool?: string;
	query?: string;
	content?: { type: string; text?: string }[];
}
interface Turn { id: string; status: string; error?: { message: string }; items: ThreadItem[]; usage?: unknown }
interface Thread { id: string; parentThreadId?: string; agentNickname?: string; cwd: string; name?: string; preview: string; path?: string; createdAt: number; updatedAt: number; turns: Turn[] }
interface RolloutEntry { type: string; payload?: { type?: string; id?: string; session_id?: string; role?: string; content?: { type: string; text?: string }[]; cwd?: string; parent_thread_id?: string; multi_agent_version?: string; agent_nickname?: string; source?: { subagent?: { thread_spawn?: { parent_thread_id: string; agent_nickname?: string } } }; timestamp?: string; message?: string; item?: { type: string; id: string; content?: { type: string; text?: string }[] } } }
interface SessionIndexEntry { id: string; thread_name: string; updated_at: string }
interface Notification { threadId?: string; delta?: string; turn?: Turn; item?: ThreadItem; message?: string; usage?: unknown; tokenUsage?: unknown }
interface Question { id: string; header: string; question: string; options?: { label: string; description: string }[]; isSecret?: boolean }
interface SkillEntry { name?: string; id?: string; skill?: string; description?: string; path?: string }
interface SessionRuntimeSettings { model?: string; effort?: string; approvalPolicy: string; sandbox?: string; webSearch?: string }

type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
type SandboxMode = CodexSandboxMode;

function shorten(value: string, max = 140): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function extractTurnTokenUsage(value: unknown): EngineTurnTokenUsage | undefined {
	return normalizeProviderTokenUsage(value, { inputIncludesCacheRead: true });
}

function extractSkillEntries(value: unknown, depth = 0): SkillEntry[] {
	if (depth > 4 || value === null || value === undefined) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.flatMap(item => extractSkillEntries(item, depth + 1));
	}
	if (typeof value !== 'object') {
		return [];
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name === 'string' || typeof record.path === 'string' || typeof record.skill === 'string') {
		return [record as SkillEntry];
	}
	const collected: SkillEntry[] = [];
	for (const key of ['data', 'skills', 'cwds', 'items']) {
		const child = record[key];
		if (child !== undefined) {
			collected.push(...extractSkillEntries(child, depth + 1));
		}
	}
	return collected;
}

function extractReviewText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	for (const key of ['output', 'review', 'summary', 'text', 'message']) {
		const candidate = record[key];
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate.trim();
		}
		if (candidate && typeof candidate === 'object') {
			const nested = extractReviewText(candidate);
			if (nested) {
				return nested;
			}
		}
	}
	const turn = record.turn as Turn | undefined;
	const text = turn?.items?.filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n').trim();
	return text || undefined;
}

function isUnsupportedMethod(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes('method not found') || message.includes('not supported') || message.includes('unknown method');
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mapReasoningEffort(thinking?: EngineThinkingLevel): string | undefined {
	return mapCodexReasoningEffort(thinking);
}

interface CodexClientSlot {
	client?: JsonLineClient;
	ready: Promise<JsonLineClient>;
	readonly loaded: Set<string>;
	readonly handledRequestIds: Set<string | number>;
	sessionListener?: vscode.Disposable;
}

export class CodexRuntime implements EngineRuntime {
	readonly id = 'codex';
	readonly name = 'Codex';
	private readonly clientSlots = new Map<string, CodexClientSlot>();
	private readonly sessionScopeKeys = new Map<string, string>();
	private readonly scopeIdentities = new Map<string, { readonly identity: AgentChildIdentity; readonly cwd?: string; readonly persistentOwnerId?: string }>();
	private codexHome!: string;
	private readonly changed = new vscode.EventEmitter<readonly NativeSession[]>();
	readonly onDidChangeSessions = this.changed.event;
	private readonly knownSessions = new Map<string, NativeSession>();
	private readonly supportedModels = new Set<string>();
	private cachedModelList: Array<{ id: string; name: string; description?: string }> = [];
	private readonly threadModelOverrides = new Map<string, string>();
	private readonly sessionSettings = new Map<string, SessionRuntimeSettings>();
	private readonly capabilitiesCache = new Map<string, { value: EngineRuntimeCapabilities; expiresAt: number }>();
	private readonly capabilitiesPending = new Map<string, Promise<EngineRuntimeCapabilities>>();
	private readonly lastTurnUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private readonly lastRawThreadUsageBySession = new Map<string, EngineTurnTokenUsage>();
	private defaultModel: string | undefined;

	constructor(private readonly executable: string, readonly remoteTarget?: CloudHostTarget) { }

	private async fetchModelList(client: JsonLineClient, timeoutMs = 4500): Promise<Array<{ id: string; name: string; description?: string }>> {
		type ModelListItem = { id?: string; model?: string; displayName?: string; description?: string; isDefault?: boolean; hidden?: boolean };
		const models: Array<{ id: string; name: string; description?: string }> = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		let defaultCandidate: string | undefined;
		for (let page = 0; page < 10; page++) {
			const params: Record<string, unknown> = { includeHidden: false };
			if (cursor) {
				params.cursor = cursor;
			}
			const response = await withTimeout(
				client.request<{ data?: ModelListItem[]; nextCursor?: string | null }>('model/list', params),
				timeoutMs,
			);
			for (const item of response?.data ?? []) {
				if (item.hidden) {
					continue;
				}
				const id = (item.model || item.id || '').trim();
				if (!id || seen.has(id)) {
					continue;
				}
				seen.add(id);
				this.supportedModels.add(id);
				if (item.isDefault) {
					defaultCandidate = id;
				}
				const name = item.displayName?.trim() || id;
				const desc = item.description?.trim();
				models.push(desc ? { id, name, description: desc } : { id, name });
			}
			const next = typeof response?.nextCursor === 'string' && response.nextCursor.trim() ? response.nextCursor.trim() : undefined;
			if (!next || next === cursor) {
				break;
			}
			cursor = next;
		}
		if (defaultCandidate) {
			this.defaultModel = defaultCandidate;
		} else if (!this.defaultModel && models.length > 0) {
			this.defaultModel = models[0].id;
		}
		if (models.length > 0) {
			this.cachedModelList = models.map(m => ({ ...m }));
		}
		return models;
	}

	private disposeSlot(scopeKey: string): void {
		const slot = this.clientSlots.get(scopeKey);
		if (!slot) {
			return;
		}
		this.clientSlots.delete(scopeKey);
		slot.sessionListener?.dispose();
		slot.client?.dispose();
		slot.loaded.clear();
	}

	private async disposeSlotAsync(scopeKey: string): Promise<void> {
		const slot = this.clientSlots.get(scopeKey);
		if (!slot) {
			return;
		}
		this.clientSlots.delete(scopeKey);
		slot.sessionListener?.dispose();
		const client = slot.client;
		slot.loaded.clear();
		if (client) {
			await client.disposeAsync().catch(() => undefined);
		}
	}

	private async ensureSlot(scopeKey = SHARED_PURE_SCOPE_KEY, identity?: AgentChildIdentity, cwd?: string, persistentOwnerId?: string): Promise<{ readonly client: JsonLineClient; readonly loaded: Set<string>; readonly handledRequestIds: Set<string | number> }> {
		if (scopeKey !== SHARED_PURE_SCOPE_KEY && identity) {
			this.scopeIdentities.set(scopeKey, { identity, cwd, persistentOwnerId });
		}
		const storedMeta = scopeKey !== SHARED_PURE_SCOPE_KEY ? this.scopeIdentities.get(scopeKey) : undefined;
		const effectiveIdentity = identity ?? storedMeta?.identity;
		const effectiveCwd = cwd ?? storedMeta?.cwd;
		const effectiveOwnerId = persistentOwnerId ?? storedMeta?.persistentOwnerId;

		const existing = this.clientSlots.get(scopeKey);
		if (existing && (!existing.client || !existing.client.isClosed)) {
			const client = await existing.ready;
			if (!client.isClosed) {
				return { client, loaded: existing.loaded, handledRequestIds: existing.handledRequestIds };
			}
		}
		this.disposeSlot(scopeKey);

		const loaded = new Set<string>();
		const handledRequestIds = new Set<string | number>();
		const slot: CodexClientSlot = {
			loaded,
			handledRequestIds,
			ready: Promise.resolve(undefined as unknown as JsonLineClient),
		};
		slot.ready = (async () => {
			const childEnv = this.remoteTarget
				? await prepareRemoteAgentChildEnv(this.remoteTarget, effectiveIdentity ?? { sessionId: 'codex-pure', pureWorker: true })
				: await prepareAgentChildEnv(effectiveIdentity ?? { sessionId: 'codex-pure', pureWorker: true });
			const persistentKey = scopeKey !== SHARED_PURE_SCOPE_KEY
				? `${buildRemotePersistentPrefix('codex', effectiveOwnerId || scopeKey)}-${randomUUID().slice(0, 8)}`
				: undefined;
			const client = new JsonLineClient(
				this.executable,
				['app-server'],
				effectiveCwd,
				childEnv,
				this.remoteTarget,
				this.remoteTarget && this.remoteTarget.os !== 'windows'
					? (persistentKey ? { persistentSessionId: persistentKey } : { killOnStdinClose: true })
					: undefined,
			);
			slot.client = client;
			slot.sessionListener = client.onPacket(packet => {
				if (packet.method === 'thread/started') {
					const thread = (packet.params as { thread: Thread }).thread;
					loaded.add(thread.id);
					if (thread.parentThreadId) { this.changed.fire([this.session(thread)]); }
				}
			});
			const info = await client.request<{ codexHome: string }>('initialize', {
				clientInfo: { name: 'aexus-code', title: 'Aexus Code', version: '0.1.0' },
				capabilities: { experimentalApi: true },
			}, { timeoutMs: 25_000 });
			this.codexHome = info.codexHome;
			client.write({ jsonrpc: '2.0', method: 'initialized' });
			if (this.supportedModels.size === 0) {
				try {
					await this.fetchModelList(client, 4000);
				} catch { /* Keep CLI default model when model/list is unavailable. */ }
			}
			return client;
		})();
		this.clientSlots.set(scopeKey, slot);
		void slot.ready.catch(() => {
			if (this.clientSlots.get(scopeKey) === slot) {
				this.disposeSlot(scopeKey);
			}
		});
		const client = await slot.ready;
		return { client, loaded, handledRequestIds };
	}

	consumeLastTurnUsage(sessionId: string): EngineTurnTokenUsage | undefined {
		const usage = this.lastTurnUsageBySession.get(sessionId);
		this.lastTurnUsageBySession.delete(sessionId);
		return usage;
	}

	private recordThreadModelIfUnsupported(threadId: string, model?: string): void {
		if (this.defaultModel && this.supportedModels.size > 0 && model && !this.supportedModels.has(model)) {
			this.threadModelOverrides.set(threadId, this.defaultModel);
		}
	}

	private requestedModel(options?: EngineSendOptions): string | undefined {
		const model = options?.model?.trim();
		if (!model || model === 'default') {
			return undefined;
		}
		return model;
	}

	private approvalPolicy(options?: EngineSendOptions, explicitPermissionMode?: string): ApprovalPolicy {
		if (options?.automatedEngineering) {
			return 'never';
		}
		switch ((explicitPermissionMode ?? options?.permissionMode)?.trim()) {
			case 'untrusted':
				return 'untrusted';
			case 'on-request':
				return 'on-request';
			case 'never':
			case 'bypassPermissions':
			case 'danger-full-access':
			case 'auto':
				return 'never';
			default:
				// Full Access (never ask) by default for local & cloud sessions unless Safe Mode is explicitly selected.
				return isAutonomousModeEnabled() ? 'never' : 'on-request';
		}
	}

	private async retireStaleSessionSlot(sessionId: string, nextScopeKey: string): Promise<void> {
		const prevScopeKey = this.sessionScopeKeys.get(sessionId);
		if (!prevScopeKey || prevScopeKey === nextScopeKey) {
			return;
		}
		const prevSlot = this.clientSlots.get(prevScopeKey);
		if (prevSlot) {
			if (prevSlot.client && !prevSlot.client.isClosed) {
				await prevSlot.client.request('thread/unsubscribe', { threadId: sessionId }, { timeoutMs: 2500 }).catch(() => { });
			}
			prevSlot.loaded.delete(sessionId);
			if (prevScopeKey !== SHARED_PURE_SCOPE_KEY) {
				this.disposeSlot(prevScopeKey);
			}
		}
	}

	private resolveLiveScopeKey(sessionId: string): string {
		const existingKey = this.sessionScopeKeys.get(sessionId);
		if (existingKey) {
			const slot = this.clientSlots.get(existingKey);
			if ((slot && (!slot.client || !slot.client.isClosed)) || this.scopeIdentities.has(existingKey)) {
				return existingKey;
			}
		}
		return SHARED_PURE_SCOPE_KEY;
	}

	private sandboxMode(options?: EngineSendOptions, explicitSandboxMode?: string): SandboxMode {
		return resolveCodexSandboxMode(options, explicitSandboxMode, isAutonomousModeEnabled());
	}

	private threadStartParams(cwd: string, options?: EngineSendOptions): Record<string, unknown> {
		const params: Record<string, unknown> = {
			cwd,
			ephemeral: false,
			approvalPolicy: this.approvalPolicy(options),
		};
		const model = this.requestedModel(options);
		if (model) {
			params.model = model;
		}
		const sandbox = this.sandboxMode(options);
		if (sandbox) {
			params.sandbox = sandbox;
		}
		if (options?.webSearch === 'disabled') {
			params.config = { tools: { web_search: false } };
		}
		return params;
	}

	private describeItem(item: ThreadItem): string {
		switch (item.type) {
			case 'commandExecution':
				return item.command ? vscode.l10n.t('Running command: {0}', shorten(item.command)) : vscode.l10n.t('Running a command…');
			case 'fileChange':
				return vscode.l10n.t('Applying file changes…');
			case 'mcpToolCall': {
				const name = [item.server, item.tool].filter(Boolean).join(':') || vscode.l10n.t('MCP tool');
				return vscode.l10n.t('Calling MCP tool: {0}', name);
			}
			case 'webSearch':
				return item.query ? vscode.l10n.t('Searching the web: {0}', shorten(item.query)) : vscode.l10n.t('Searching the web…');
			default:
				return vscode.l10n.t('Codex is working…');
		}
	}

	private async ensureReady(scopeKey = SHARED_PURE_SCOPE_KEY, identity?: AgentChildIdentity, cwd?: string): Promise<JsonLineClient> {
		const { client } = await this.ensureSlot(scopeKey, identity, cwd);
		return client;
	}

	private session(thread: Thread): NativeSession {
		const session = { id: thread.id, parentId: thread.parentThreadId, readOnly: !!thread.parentThreadId, cwd: thread.cwd, label: thread.name || thread.agentNickname || thread.preview.split('\n')[0].slice(0, 100) || vscode.l10n.t('New Codex Session'), created: thread.createdAt * 1000, updated: thread.updatedAt * 1000, file: thread.path };
		this.knownSessions.set(session.id, session);
		return session;
	}

	private belongsTo(id: string, parent: string): boolean {
		let session = this.knownSessions.get(id);
		while (session?.parentId && session.id !== parent) { session = this.knownSessions.get(session.parentId); }
		return session?.id === parent;
	}

	private parseRolloutHistory(lines: Iterable<string>, session: NativeSession, token?: vscode.CancellationToken): HistoryEntry[] {
		const entries = new Map<string, HistoryEntry>();
		for (const line of lines) {
			if (token?.isCancellationRequested) { break; }
			if (!line) { continue; }
			let event: RolloutEntry;
			try { event = JSON.parse(line) as RolloutEntry; } catch { continue; }
			if (event.type === 'session_meta' && event.payload?.id === session.id) { session.readOnly = !!session.parentId && event.payload.multi_agent_version === 'v2'; }
			if (session.parentId && event.type === 'response_item' && event.payload?.type === 'agent_message') {
				const text = (event.payload.content ?? []).filter(part => part.type === 'input_text' || part.type === 'text').map(part => part.text ?? '').join('\n').split('\nPayload:\n').at(-1)?.trim();
				const id = event.payload.id ?? `agent-message-${entries.size}`;
				entries.set(id, { id, role: 'user', text: text || vscode.l10n.t('Agent message'), isSystemInitiated: true });
				continue;
			}
			if (event.type !== 'event_msg') { continue; }
			const item = event.payload?.type === 'item_completed' ? event.payload.item : undefined;
			if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
				const text = (item.content ?? []).filter(part => part.type.toLowerCase() === 'text').map(part => part.text ?? '').join('\n');
				if (text) { entries.set(item.id, { id: item.id, role: item.type === 'UserMessage' ? 'user' : 'assistant', text }); }
			} else if (event.payload?.message && (event.payload.type === 'user_message' || event.payload.type === 'agent_message')) {
				const id = `legacy-${entries.size}`;
				entries.set(id, { id, role: event.payload.type === 'user_message' ? 'user' : 'assistant', text: event.payload.message });
			}
		}
		return [...entries.values()];
	}

	private historyFromTurns(turns: readonly Turn[] | undefined): HistoryEntry[] {
		const out: HistoryEntry[] = [];
		for (const turn of turns ?? []) {
			for (const item of turn.items ?? []) {
				if (item.type === 'userMessage' || item.type === 'UserMessage') {
					const text = (item.text ?? (item.content ?? []).map(p => p.text ?? '').join('\n')).trim();
					if (text) { out.push({ id: `${turn.id}-u-${out.length}`, role: 'user', text }); }
				} else if (item.type === 'agentMessage' || item.type === 'AgentMessage') {
					const text = (item.text ?? (item.content ?? []).map(p => p.text ?? '').join('\n')).trim();
					if (text) { out.push({ id: `${turn.id}-a-${out.length}`, role: 'assistant', text }); }
				}
			}
		}
		return out;
	}

	private async listRemote(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
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

		const byId = new Map<string, NativeSession>();
		const homeRoot = this.codexHome || (this.remoteTarget.remoteHome ? joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.codex') : undefined);

		// Fast read-only remote scan first on POSIX (handles .jsonl AND .jsonl.zst + session_index.jsonl without booting app-server!)
		if (this.remoteTarget.os !== 'windows') {
			const pyCodex = [
				`import json, os, subprocess, sys`,
				`root = sys.argv[1] or os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")`,
				`target_cwds = set(json.loads(sys.argv[2]))`,
				`sdir = os.path.join(root, "sessions")`,
				`if not os.path.isdir(sdir): sys.exit(0)`,
				`idx = {}`,
				`idx_path = os.path.join(root, "session_index.jsonl")`,
				`if os.path.isfile(idx_path):`,
				`    try:`,
				`        with open(idx_path, "r", encoding="utf-8", errors="replace") as f:`,
				`            for line in f:`,
				`                try: d = json.loads(line)`,
				`                except Exception: continue`,
				`                if isinstance(d, dict) and d.get("id"): idx[str(d["id"])] = d`,
				`    except OSError: pass`,
				`files = []`,
				`for dirpath, _, filenames in os.walk(sdir):`,
				`    for fn in filenames:`,
				`        if fn.startswith("rollout-") and (fn.endswith(".jsonl") or fn.endswith(".jsonl.zst")):`,
				`            fp = os.path.join(dirpath, fn)`,
				`            try: files.append((os.path.getmtime(fp), fp))`,
				`            except OSError: pass`,
				`files.sort(key=lambda x: x[0], reverse=True)`,
				`def norm_cwd(p):`,
				`    p = os.path.normpath((p or "").strip())`,
				`    return p[:-1] if len(p) > 1 and p.endswith("/") else p`,
				`def read_head_lines(fp, limit=40):`,
				`    lines = []`,
				`    if fp.endswith(".zst"):`,
				`        proc = None`,
				`        try:`,
				`            proc = subprocess.Popen(["zstd", "-dc", fp], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)`,
				`            for raw in proc.stdout:`,
				`                lines.append(raw.decode("utf-8", errors="replace"))`,
				`                if len(lines) >= limit: break`,
				`        except Exception: pass`,
				`        finally:`,
				`            if proc:`,
				`                try: proc.stdout.close()`,
				`                except Exception: pass`,
				`                try: proc.terminate()`,
				`                except Exception: pass`,
				`                try: proc.wait(timeout=1)`,
				`                except Exception: pass`,
				`    else:`,
				`        try:`,
				`            with open(fp, "r", encoding="utf-8", errors="replace") as f:`,
				`                for raw in f:`,
				`                    lines.append(raw)`,
				`                    if len(lines) >= limit: break`,
				`        except OSError: pass`,
				`    return lines`,
				`for mtime, fp in files[:200]:`,
				`    meta = None; label = ""`,
				`    for line in read_head_lines(fp, 45):`,
				`        try: ev = json.loads(line)`,
				`        except Exception: continue`,
				`        if not isinstance(ev, dict): continue`,
				`        pl = ev.get("payload")`,
				`        if not isinstance(pl, dict): continue`,
				`        if meta is None and ev.get("type") == "session_meta":`,
				`            sid = pl.get("id") or pl.get("session_id")`,
				`            cwd = pl.get("cwd")`,
				`            if sid and cwd:`,
				`                if target_cwds and norm_cwd(str(cwd)) not in target_cwds:`,
				`                    meta = False`,
				`                    break`,
				`                src = pl.get("source") if isinstance(pl.get("source"), dict) else {}`,
				`                sub = src.get("subagent") if isinstance(src.get("subagent"), dict) else {}`,
				`                ts = sub.get("thread_spawn") if isinstance(sub.get("thread_spawn"), dict) else {}`,
				`                parent_id = pl.get("parent_thread_id") or ts.get("parent_thread_id")`,
				`                nick = pl.get("agent_nickname") or ts.get("agent_nickname") or ""`,
				`                named = idx.get(str(sid)) or {}`,
				`                meta = {"id": str(sid), "cwd": str(cwd), "parentId": parent_id, "readOnly": bool(pl.get("multi_agent_version") == "v2" and parent_id), "nick": nick, "threadName": named.get("thread_name") or "", "updatedAt": named.get("updated_at") or "", "ts": pl.get("timestamp") or "", "mtime": int(mtime * 1000), "file": fp}`,
				`                if meta["threadName"] or nick: break`,
				`        elif meta and ev.get("type") == "event_msg":`,
				`            pt = pl.get("type")`,
				`            if pt == "item_completed":`,
				`                item = pl.get("item") if isinstance(pl.get("item"), dict) else {}`,
				`                if item.get("type") == "UserMessage":`,
				`                    parts = [c.get("text", "") for c in (item.get("content") or []) if isinstance(c, dict) and str(c.get("type", "")).lower() == "text"]`,
				`                    t = "\\n".join(parts).strip()`,
				`                    if t: label = t.splitlines()[0][:100]; break`,
				`            elif pt == "user_message" and isinstance(pl.get("message"), str) and pl["message"].strip():`,
				`                label = pl["message"].strip().splitlines()[0][:100]; break`,
				`        elif meta and not label and ev.get("type") == "response_item" and pl.get("role") == "user":`,
				`            parts = [c.get("text", "") for c in (pl.get("content") or []) if isinstance(c, dict) and c.get("type") in ("input_text", "text")]`,
				`            t = "\\n".join(parts).strip()`,
				`            if t and not t.startswith("#") and not t.startswith("<environment_context>"):`,
				`                label = t.splitlines()[0][:100]`,
				`    if isinstance(meta, dict):`,
				`        meta["userLabel"] = label`,
				`        print("__AEX_CDX_J__\\t" + json.dumps(meta, ensure_ascii=False))`,
			].join('\n');
			const pyRes = await execRemoteShell(
				this.remoteTarget,
				`if command -v python3 >/dev/null 2>&1; then python3 -c ${posixQuote(pyCodex)} ${posixQuote(homeRoot ?? '')} ${posixQuote(JSON.stringify(targetCwds))}; else exit 127; fi`,
				'',
				{ timeoutMs: 20_000, token },
			).catch(() => undefined);
			if (pyRes && pyRes.code === 0) {
				for (const line of pyRes.stdout.toString('utf8').split(/\r?\n/)) {
					if (!line.startsWith('__AEX_CDX_J__\t')) { continue; }
					try {
						const row = JSON.parse(line.slice('__AEX_CDX_J__\t'.length)) as {
							id: string; cwd: string; parentId?: string; readOnly?: boolean; nick?: string; threadName?: string; userLabel?: string; updatedAt?: string; ts?: string; mtime?: number; file?: string;
						};
						if (!row.id || !row.cwd) { continue; }
						const created = row.ts && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : (row.mtime || Date.now());
						const updated = row.updatedAt && Number.isFinite(Date.parse(row.updatedAt)) ? Math.max(Date.parse(row.updatedAt), row.mtime || 0) : (row.mtime || created);
						const session: NativeSession = {
							id: row.id,
							parentId: row.parentId || undefined,
							readOnly: Boolean(row.readOnly),
							cwd: row.cwd,
							file: row.file,
							label: row.threadName?.trim() || row.nick?.trim() || row.userLabel?.trim() || vscode.l10n.t('Codex Session {0}', row.id.slice(0, 8)),
							created,
							updated,
							provisional: false,
						};
						this.knownSessions.set(session.id, session);
						byId.set(session.id, session);
					} catch { /* ignore */ }
				}
				// Merge any live threads from already-running app-server slots without spinning up a cold daemon
				if (this.clientSlots.size > 0) {
					try {
						const client = await withTimeout(this.ensureReady(), 4000);
						const resp = await withTimeout(client.request<{ data?: Thread[]; threads?: Thread[] }>('thread/list', { limit: 100 }), 4000);
						for (const thread of resp?.data ?? resp?.threads ?? []) {
							if (!thread?.id) { continue; }
							if (targetCwds.length > 0 && !targetCwds.includes(normalizeRemoteCwdForCompare(thread.cwd || '', this.remoteTarget.os))) { continue; }
							byId.set(thread.id, this.session(thread));
						}
					} catch { /* keep disk scan results */ }
				}
				return [...byId.values()].sort((a, b) => b.updated - a.updated);
			}
		}

		try {
			const client = await withTimeout(this.ensureReady(), 8000);
			const rpcSessions: NativeSession[] = [];
			const seen = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; page < 10 && !token.isCancellationRequested; page++) {
				const resp = await withTimeout(
					client.request<{ data?: Thread[]; threads?: Thread[]; nextCursor?: string | null }>('thread/list', cursor ? { cursor, limit: 100 } : { limit: 100 }),
					5000,
				);
				const batch = resp?.data ?? resp?.threads ?? [];
				for (const thread of batch) {
					if (!thread?.id || seen.has(thread.id)) { continue; }
					seen.add(thread.id);
					const s = this.session(thread);
					if (targetCwds.length === 0 || targetCwds.includes(normalizeRemoteCwdForCompare(s.cwd, this.remoteTarget.os))) {
						rpcSessions.push(s);
					}
				}
				const next = typeof resp?.nextCursor === 'string' && resp.nextCursor.trim() ? resp.nextCursor.trim() : undefined;
				if (!next || next === cursor) { break; }
				cursor = next;
			}
			if (rpcSessions.length > 0) {
				return rpcSessions;
			}
		} catch { /* Fall back to scanning remote codexHome sessions over SSH. */ }

		const posixScript = [
			`root=${homeRoot ? posixQuote(homeRoot) : '"${CODEX_HOME:-$HOME/.codex}"'}`,
			`[ -d "$root/sessions" ] || exit 0`,
			`find "$root/sessions" -type f -name 'rollout-*.jsonl' 2>/dev/null | head -n 120 | while IFS= read -r f; do`,
			`  m=$(stat -c "%Y" "$f" 2>/dev/null || stat -f "%m" "$f" 2>/dev/null || echo 0)`,
			`  printf '__AEX_CDX__\\t%s\\t%s\\n' "$m" "$f"`,
			`  head -n 30 -- "$f" 2>/dev/null || true`,
			`done`,
		].join('\n');
		const winScript = [
			`$root = ${homeRoot ? psSingleQuote(homeRoot) : '(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" })'}`,
			`$sdir = Join-Path $root 'sessions'`,
			`if (Test-Path -LiteralPath $sdir) {`,
			`  Get-ChildItem -LiteralPath $sdir -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 120 | ForEach-Object {`,
			`    $ms = [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()`,
			`    Write-Output ("__AEX_CDX__" + [char]9 + $ms + [char]9 + $_.FullName)`,
			`    Get-Content -LiteralPath $_.FullName -TotalCount 30 -Encoding UTF8 -ErrorAction SilentlyContinue`,
			`  }`,
			`}`,
		].join('; ');
		const res = await execRemoteShell(this.remoteTarget, posixScript, winScript, { timeoutMs: 20_000, token }).catch(() => undefined);
		if (!res || res.code !== 0) {
			return [];
		}
		const sessions: NativeSession[] = [];
		let curFile: string | undefined;
		let curMtime = Date.now();
		let current: NativeSession | undefined;
		const flush = () => {
			if (current) {
				this.knownSessions.set(current.id, current);
				sessions.push(current);
			}
		};
		for (const rawLine of res.stdout.toString('utf8').split(/\r?\n/)) {
			if (rawLine.startsWith('__AEX_CDX__\t')) {
				flush();
				const parts = rawLine.split('\t');
				const rawTs = Number(parts[1]) || 0;
				curMtime = rawTs > 1e11 ? rawTs : (rawTs > 0 ? rawTs * 1000 : Date.now());
				curFile = parts.slice(2).join('\t').trim() || undefined;
				current = undefined;
				continue;
			}
			if (!curFile) { continue; }
			let event: RolloutEntry;
			try { event = JSON.parse(rawLine) as RolloutEntry; } catch { continue; }
			const metaId = event.payload?.id || event.payload?.session_id;
			if (!current && event.type === 'session_meta' && metaId && event.payload?.cwd) {
				const meta = event.payload;
				current = {
					id: metaId,
					parentId: meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id,
					readOnly: meta.multi_agent_version === 'v2' && !!meta.parent_thread_id,
					cwd: meta.cwd!,
					file: curFile,
					label: meta.agent_nickname || meta.source?.subagent?.thread_spawn?.agent_nickname || vscode.l10n.t('Codex Session {0}', metaId.slice(0, 8)),
					created: meta.timestamp ? Date.parse(meta.timestamp) : curMtime,
					updated: curMtime,
					provisional: false,
				};
			} else if (current && event.type === 'event_msg' && event.payload?.type === 'item_completed' && event.payload.item?.type === 'UserMessage') {
				const labelText = (event.payload.item.content ?? []).filter(part => part.type.toLowerCase() === 'text').map(part => part.text ?? '').join('\n').split('\n')[0].slice(0, 100);
				if (labelText) { current.label = labelText; }
			} else if (current && event.type === 'event_msg' && event.payload?.type === 'user_message' && event.payload.message) {
				current.label = event.payload.message.split('\n')[0].slice(0, 100);
			}
		}
		flush();
		return sessions;
	}

	async list(token: vscode.CancellationToken, projectCwd?: string): Promise<NativeSession[]> {
		if (this.remoteTarget) {
			return this.listRemote(token, projectCwd);
		}
		await this.ensureReady();
		const index = new Map<string, SessionIndexEntry>();
		try {
			for (const line of (await fs.readFile(path.join(this.codexHome, 'session_index.jsonl'), 'utf8')).split('\n')) {
				try { const entry = JSON.parse(line) as SessionIndexEntry; index.set(entry.id, entry); } catch { /* The last append may still be incomplete. */ }
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		let files: string[];
		try {
			files = (await fs.readdir(path.join(this.codexHome, 'sessions'), { recursive: true, withFileTypes: true }))
				.filter(entry => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')).map(entry => path.join(entry.parentPath, entry.name));
		} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
		const sessions: NativeSession[] = [];
		for (let offset = 0; offset < files.length && !token.isCancellationRequested; offset += 16) {
			const batch = await Promise.all(files.slice(offset, offset + 16).map(file => this.readSession(file, index, token)));
			sessions.push(...batch.filter((session): session is NativeSession => !!session));
		}
		return sessions;
	}

	private async readSession(file: string, index: ReadonlyMap<string, SessionIndexEntry>, token: vscode.CancellationToken): Promise<NativeSession | undefined> {
		const input = createReadStream(file);
		const lines = readline.createInterface({ input, crlfDelay: Infinity });
		let session: NativeSession | undefined;
		try {
			for await (const line of lines) {
				if (token.isCancellationRequested) { break; }
				// Fast pre-parse skip over tool_call, reasoning, and token_count rollout lines.
				if (!line.includes('"event_msg"') && !line.includes('"session_meta"')) {
					continue;
				}
				let event: RolloutEntry;
				try { event = JSON.parse(line) as RolloutEntry; } catch { continue; }
				const metaId = event.payload?.id || event.payload?.session_id;
				if (!session && event.type === 'session_meta' && metaId && event.payload?.cwd) {
					const meta = event.payload;
					const named = index.get(metaId);
					const stat = await fs.stat(file);
					session = { id: metaId, parentId: meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id, readOnly: meta.multi_agent_version === 'v2' && !!meta.parent_thread_id, cwd: meta.cwd!, file, label: named?.thread_name || meta.agent_nickname || meta.source?.subagent?.thread_spawn?.agent_nickname || vscode.l10n.t('Codex Session {0}', metaId.slice(0, 8)), created: meta.timestamp ? Date.parse(meta.timestamp) : stat.birthtimeMs, updated: named?.updated_at ? Date.parse(named.updated_at) : stat.mtimeMs, provisional: false };
					if (named?.thread_name || meta.agent_nickname) { break; }
				}
				if (session && event.type === 'event_msg' && event.payload?.type === 'item_completed' && event.payload.item?.type === 'UserMessage') {
					session.label = (event.payload.item.content ?? []).filter(part => part.type.toLowerCase() === 'text').map(part => part.text ?? '').join('\n').split('\n')[0].slice(0, 100) || session.label;
					break;
				}
				if (session && event.type === 'event_msg' && event.payload?.type === 'user_message' && event.payload.message) { session.label = event.payload.message.split('\n')[0].slice(0, 100); break; }
			}
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		finally { lines.close(); input.destroy(); }
		if (session) { this.knownSessions.set(session.id, session); }
		return session;
	}

	async children(session: NativeSession, token: vscode.CancellationToken): Promise<NativeSession[]> {
		return (await this.list(token)).filter(child => child.parentId === session.id);
	}

	async create(cwd: string, options?: EngineSendOptions): Promise<NativeSession> {
		const now = Date.now();
		try {
			return await withTimeout((async () => {
				const { client, loaded } = await this.ensureSlot(SHARED_PURE_SCOPE_KEY, { sessionId: 'codex-pure', pureWorker: true });
				const result = await client.request<{ thread: Thread; model?: string }>('thread/start', this.threadStartParams(cwd, options));
				loaded.add(result.thread.id);
				this.sessionScopeKeys.set(result.thread.id, SHARED_PURE_SCOPE_KEY);
				this.recordThreadModelIfUnsupported(result.thread.id, result.model);
				return { ...this.session(result.thread), provisional: true };
			})(), 6000);
		} catch {
			return {
				id: randomUUID(),
				cwd,
				label: vscode.l10n.t('New Codex Session'),
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
		if (token?.isCancellationRequested) {
			return;
		}
		const { client, loaded } = await raceWithCancellation(
			this.ensureSlot(scopeKey, identity, scopeKey === SHARED_PURE_SCOPE_KEY ? undefined : session.cwd),
			token,
		);
		if (token?.isCancellationRequested) {
			return;
		}
		this.sessionScopeKeys.set(session.id, scopeKey);
		const reqOpts = { timeoutMs: 25_000, token };
		if (session.unmaterialized) {
			const result = await client.request<{ thread: Thread; model?: string }>('thread/start', this.threadStartParams(session.cwd, options), reqOpts);
			loaded.add(result.thread.id);
			this.sessionScopeKeys.set(result.thread.id, scopeKey);
			this.recordThreadModelIfUnsupported(result.thread.id, result.model);
			Object.assign(session, this.session(result.thread), { provisional: true, unmaterialized: false });
			return;
		}
		if (session.parentId && !loaded.has(session.parentId)) {
			const parent = await client.request<{ thread: Thread }>('thread/read', { threadId: session.parentId, includeTurns: false }, reqOpts);
			await this.prepareSession(this.session(parent.thread), options, token);
		}
		if (loaded.has(session.id) || token?.isCancellationRequested) { return; }
		try {
			const result = await client.request<{ thread: Thread; model?: string }>('thread/resume', { threadId: session.id, cwd: session.cwd, excludeTurns: true }, reqOpts);
			loaded.add(session.id);
			this.recordThreadModelIfUnsupported(session.id, result.model);
			session.file = result.thread.path;
			session.provisional = false;
		} catch (error) {
			if (token?.isCancellationRequested || error instanceof vscode.CancellationError) { return; }
			// Empty native threads have no rollout until their first user message.
			if (!session.provisional || !(error instanceof Error) || !error.message.includes('no rollout found')) { throw error; }
			const started = await client.request<{ thread: Thread; model?: string }>('thread/start', this.threadStartParams(session.cwd, options), reqOpts);
			loaded.add(started.thread.id);
			this.sessionScopeKeys.set(started.thread.id, scopeKey);
			this.recordThreadModelIfUnsupported(started.thread.id, started.model);
			Object.assign(session, this.session(started.thread), { provisional: true, unmaterialized: false });
		}
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (session.unmaterialized || (session.provisional && !session.file)) { return []; }
		if (this.remoteTarget) {
			if (token.isCancellationRequested) { return []; }
			try {
				const scopeKey = this.resolveLiveScopeKey(session.id);
				const { client } = await this.ensureSlot(scopeKey, undefined, session.cwd);
				const read = await withTimeout(client.request<{ thread?: Thread }>('thread/read', { threadId: session.id, includeTurns: true }), 8000);
				if (read?.thread?.path) {
					session.file = read.thread.path;
				}
				const fromRpc = this.historyFromTurns(read?.thread?.turns);
				if (fromRpc.length > 0) {
					return fromRpc;
				}
			} catch { /* Fall back to reading remote rollout file if available. */ }
			if (!session.file) {
				return [];
			}
			if (this.remoteTarget.os !== 'windows' && session.file.endsWith('.zst')) {
				const res = await execRemoteShell(this.remoteTarget, `zstd -dc -- ${posixQuote(session.file)} 2>/dev/null`, '', { timeoutMs: 20_000, token }).catch(() => undefined);
				return res && res.code === 0 ? this.parseRolloutHistory(res.stdout.toString('utf8').split(/\r?\n/), session, token) : [];
			}
			const raw = await readRemoteTextFile(this.remoteTarget, session.file, { bypassCache: true, timeoutMs: 20_000, token });
			return raw ? this.parseRolloutHistory(raw.split(/\r?\n/), session, token) : [];
		}
		if (session.provisional || !session.file) { await this.prepareSession(session); }
		if (session.provisional || token.isCancellationRequested) { return []; }
		if (!session.file) { throw new Error(vscode.l10n.t('Codex did not report the native conversation history path.')); }
		const input = createReadStream(session.file);
		const lines = readline.createInterface({ input, crlfDelay: Infinity });
		const entries = new Map<string, HistoryEntry>();
		try {
			for await (const line of lines) {
				if (token.isCancellationRequested) { break; }
				// Fast pre-parse skip over tool_call, reasoning, and token_count rollout lines.
				if (!line.includes('"event_msg"') && !line.includes('"session_meta"') && (!session.parentId || !line.includes('"response_item"'))) {
					continue;
				}
				let event: RolloutEntry;
				try { event = JSON.parse(line) as RolloutEntry; } catch { continue; }
				if (event.type === 'session_meta' && event.payload?.id === session.id) { session.readOnly = !!session.parentId && event.payload.multi_agent_version === 'v2'; }
				if (session.parentId && event.type === 'response_item' && event.payload?.type === 'agent_message') {
					const text = (event.payload.content ?? []).filter(part => part.type === 'input_text' || part.type === 'text').map(part => part.text ?? '').join('\n').split('\nPayload:\n').at(-1)?.trim();
					const id = event.payload.id ?? `agent-message-${entries.size}`;
					entries.set(id, { id, role: 'user', text: text || vscode.l10n.t('Agent message'), isSystemInitiated: true });
					continue;
				}
				if (event.type !== 'event_msg') { continue; }
				const item = event.payload?.type === 'item_completed' ? event.payload.item : undefined;
				if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
					const text = (item.content ?? []).filter(part => part.type.toLowerCase() === 'text').map(part => part.text ?? '').join('\n');
					if (text) { entries.set(item.id, { id: item.id, role: item.type === 'UserMessage' ? 'user' : 'assistant', text }); }
				} else if (event.payload?.message && (event.payload.type === 'user_message' || event.payload.type === 'agent_message')) {
					const id = `legacy-${entries.size}`;
					entries.set(id, { id, role: event.payload.type === 'user_message' ? 'user' : 'assistant', text: event.payload.message });
				}
			}
		} finally { lines.close(); input.destroy(); }
		return [...entries.values()];
	}

	private async handleRequest(client: JsonLineClient, packet: RpcPacket, session: NativeSession, token: vscode.CancellationToken, approvalPolicy: ApprovalPolicy): Promise<void> {
		const params = packet.params ?? {};
		if (packet.method?.endsWith('/requestApproval')) {
			if (approvalPolicy === 'never') {
				client.write({ jsonrpc: '2.0', id: packet.id, result: packet.method === 'item/permissions/requestApproval' ? { permissions: params.permissions ?? {}, scope: 'turn' } : { decision: 'accept' } });
				return;
			}
			const command = typeof params.command === 'string' ? params.command : typeof params.reason === 'string' ? params.reason : packet.method;
			const allow = vscode.l10n.t('Allow Once');
			const result = await vscode.window.showQuickPick([allow, vscode.l10n.t('Deny')], { title: vscode.l10n.t('Codex requests permission'), placeHolder: `${session.cwd}: ${command}`, ignoreFocusOut: true }, token);
			client.write({ jsonrpc: '2.0', id: packet.id, result: packet.method === 'item/permissions/requestApproval' ? { permissions: result === allow ? params.permissions : {}, scope: 'turn' } : { decision: result === allow ? 'accept' : 'decline' } });
			return;
		}
		if (packet.method === 'item/tool/requestUserInput') {
			const questions = Array.isArray(params.questions) ? (params.questions as Question[]) : [];
			const answers: Record<string, { answers: string[] }> = {};
			if (approvalPolicy === 'never') {
				for (const question of questions) {
					const defaultChoice = question.options?.[0]?.label;
					answers[question.id] = { answers: [defaultChoice || 'Proceed autonomously with best judgment.'] };
				}
				client.write({ jsonrpc: '2.0', id: packet.id, result: { answers } });
				return;
			}
			for (const question of questions) {
				const answer = question.options?.length
					? (await vscode.window.showQuickPick(question.options, { title: vscode.l10n.t('Codex — {0}', question.header), placeHolder: `${session.label} (${session.cwd}): ${question.question}`, ignoreFocusOut: true }, token))?.label
					: await vscode.window.showInputBox({ title: vscode.l10n.t('Codex — {0}', question.header), prompt: `${session.label} (${session.cwd}): ${question.question}`, password: question.isSecret, ignoreFocusOut: true }, token);
				answers[question.id] = { answers: answer === undefined ? [] : [answer] };
			}
			client.write({ jsonrpc: '2.0', id: packet.id, result: { answers } });
			return;
		}
		client.write({ jsonrpc: '2.0', id: packet.id, error: { code: -32601, message: vscode.l10n.t('This engine request is not supported: {0}', packet.method ?? '') } });
	}

	async killSession(session: NativeSession): Promise<void> {
		const scopeKey = this.sessionScopeKeys.get(session.id);
		const keys = scopeKey ? [scopeKey] : [...this.clientSlots.keys()];
		for (const key of keys) {
			const slot = this.clientSlots.get(key);
			let unsubscribeFailed = false;
			if (slot?.client && !slot.client.isClosed) {
				await slot.client.request('thread/unsubscribe', { threadId: session.id }, { timeoutMs: 2500 }).catch(() => {
					unsubscribeFailed = true;
				});
				slot.loaded.delete(session.id);
			}
			if ((key !== SHARED_PURE_SCOPE_KEY && key.includes(`:${session.id}`)) || (key === SHARED_PURE_SCOPE_KEY && slot && slot.loaded.size === 0 && unsubscribeFailed)) {
				if (key !== SHARED_PURE_SCOPE_KEY) {
					this.scopeIdentities.delete(key);
				}
				await this.disposeSlotAsync(key);
			}
		}
		this.sessionScopeKeys.delete(session.id);
		// Guarantee full remote process-group + descendant kill even after an Electron window reload
		// when `this.clientSlots` is empty.
		if (this.remoteTarget && this.remoteTarget.os !== 'windows') {
			await terminateRemotePersistentSessionsByPrefix(
				this.remoteTarget,
				buildRemotePersistentPrefix('codex', session.id),
				{ killTree: true },
			);
		}
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		await this.prepareSession(session, options, token);
		if (token.isCancellationRequested) {
			return;
		}
		this.knownSessions.set(session.id, session);
		const scopeKey = agentIdentityScopeKey(session.id, options, session.cwd);
		await this.retireStaleSessionSlot(session.id, scopeKey);
		if (token.isCancellationRequested) {
			return;
		}
		const { client, handledRequestIds } = await raceWithCancellation(
			this.ensureSlot(scopeKey, {
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
		this.sessionScopeKeys.set(session.id, scopeKey);
		let turnId: string | undefined;
		let turnDispatched = false;
		const mappedEffort = mapReasoningEffort(options?.thinking);
		const approvalPolicy = this.approvalPolicy(options);
		const sandboxMode = this.sandboxMode(options);
		this.sessionSettings.set(session.id, { model: this.requestedModel(options), effort: mappedEffort, approvalPolicy, sandbox: sandboxMode, webSearch: options?.webSearch });
		const input: Array<Record<string, unknown>> = [{ type: 'text', text, text_elements: [] }];
		for (const attachment of options?.attachments ?? []) {
			if (attachment.kind === 'image') {
				let imgPath = attachment.filePath;
				if (this.remoteTarget && !attachment.remote) {
					const staged = await stageLocalFileToRemote(this.remoteTarget, attachment.filePath, token);
					if (!staged) {
						continue;
					}
					imgPath = staged;
				}
				input.push({ type: 'localImage', path: imgPath });
			}
		}
		const runSingleTurn = async (modelOverride?: string, effortOverride?: string): Promise<void> => {
			let finish!: () => void;
			let fail!: (error: Error) => void;
			const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
			void completed.catch(() => { });
			const preTurnBaseline = this.lastRawThreadUsageBySession.get(session.id);
			const activeModel = modelOverride ?? this.sessionSettings.get(session.id)?.model ?? this.defaultModel;
			const usageTracker = createTurnInterimUsageTracker(text, options?.onInterimUsage, {
				preTurnBaseline,
				model: activeModel,
			});
			const seenFailedItemIds = new Set<string>();
			const activeExternalItemIds = new Set<string>();
			const listener = client.onPacket(packet => {
				if (packet.method === 'aexus/connectionClosed') { fail(new Error(String(packet.params?.message))); return; }
				const params = packet.params as (Notification & { type?: string }) | undefined;
				// Handle JSON-RPC server requests even when `codex app-server` omits `params.threadId` (#95 P1-7),
				// deduplicating `packet.id` across concurrent pure-worker listeners sharing a client slot (#123 #5).
				if (packet.id !== undefined && packet.method) {
					if (!params?.threadId || this.belongsTo(params.threadId, session.id)) {
						if (handledRequestIds.has(packet.id)) {
							return;
						}
						if (handledRequestIds.size >= 512) {
							const oldest = handledRequestIds.values().next().value;
							if (oldest !== undefined) {
								handledRequestIds.delete(oldest);
							}
						}
						handledRequestIds.add(packet.id);
						try { options?.onStreamActivity?.(); } catch { /* ignore */ }
						const targetSession = (params?.threadId ? this.knownSessions.get(params.threadId) : undefined) ?? session;
						const needsInteractiveWait = approvalPolicy !== 'never';
						if (needsInteractiveWait) {
							try { options?.onExternalWaitStart?.(); } catch { /* ignore */ }
						}
						void this.handleRequest(client, packet, targetSession, token, approvalPolicy)
							.catch(fail)
							.finally(() => {
								if (needsInteractiveWait) {
									try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
								}
							});
					}
					return;
				}
				if (params?.threadId !== session.id) { return; }
				try { options?.onStreamActivity?.(); } catch { /* ignore */ }
				if (packet.method === 'turn/started' || packet.method === 'item/started' || packet.method === 'item/agentMessage/delta') {
					turnDispatched = true;
				}
				if (packet.method === 'item/started' && params.item && params.item.type !== 'agentMessage' && params.item.type !== 'userMessage' && params.item.type !== 'reasoning') {
					if (typeof params.item.id === 'string' && params.item.id && !activeExternalItemIds.has(params.item.id)) {
						activeExternalItemIds.add(params.item.id);
						try { options?.onExternalWaitStart?.(); } catch { /* ignore */ }
					}
				}
				if (packet.method === 'item/completed' && params.item && params.item.type !== 'agentMessage' && params.item.type !== 'userMessage' && params.item.type !== 'reasoning') {
					if (typeof params.item.id === 'string' && activeExternalItemIds.delete(params.item.id)) {
						try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
					}
					const item = params.item;
					const exitCode = typeof item.exitCode === 'number' ? item.exitCode : (typeof item.exit_code === 'number' ? item.exit_code : undefined);
					const itemFailed = (exitCode !== undefined && exitCode !== 0)
						|| item.status === 'failed'
						|| item.status === 'error'
						|| item.isError === true
						|| Boolean(item.error);
					if (itemFailed) {
						const itemKey = typeof item.id === 'string' && item.id ? item.id : undefined;
						if (!itemKey || !seenFailedItemIds.has(itemKey)) {
							if (itemKey) {
								seenFailedItemIds.add(itemKey);
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
				}
				if (packet.method === 'thread/tokenUsage/updated' || packet.method === 'turn/completed') {
					const rawUsage = extractTurnTokenUsage(params.tokenUsage ?? params.usage ?? params.turn?.usage);
					if (rawUsage) {
						const isCumulative = packet.method === 'thread/tokenUsage/updated';
						const normalized = usageTracker.recordRealUsage(rawUsage, {
							cumulativeAcrossThread: isCumulative,
						});
						if (isCumulative) {
							this.lastRawThreadUsageBySession.set(session.id, rawUsage);
						}
						this.lastTurnUsageBySession.set(session.id, normalized);
					}
				}
				const isCompactionEvent = packet.method === 'thread/compacted'
					|| packet.method === 'context/compacted'
					|| packet.method === 'context_compacted'
					|| packet.method === 'turn/compacted'
					|| params.type === 'context_compacted'
					|| params.type === 'compact_boundary'
					|| ((packet.method === 'item/started' || packet.method === 'item/completed') && (
						params.item?.type === 'contextCompaction'
						|| params.item?.type === 'context_compacted'
						|| params.item?.type === 'compaction'
					));
				if (isCompactionEvent) {
					try {
						options?.onContextCompacted?.();
					} catch { /* Compaction callback must never break the turn. */ }
				}
				if (!token.isCancellationRequested && packet.method === 'item/agentMessage/delta' && params.delta) {
					stream.markdown(params.delta);
					usageTracker.recordStreamDelta(params.delta);
				}
				if (!token.isCancellationRequested && (packet.method === 'item/reasoning/summaryTextDelta' || packet.method === 'item/reasoning/textDelta')) {
					const reasoningDelta = String(packet.params?.delta ?? '');
					emitThinkingProgress(stream, reasoningDelta, 'codex-thinking');
					usageTracker.recordStreamDelta(reasoningDelta, { skipToolErrorScan: true });
				}
				if (!token.isCancellationRequested && packet.method === 'item/started' && params.item && params.item.type !== 'agentMessage' && params.item.type !== 'userMessage' && params.item.type !== 'reasoning') {
					stream.progress(this.describeItem(params.item));
				}
				if (packet.method === 'turn/completed' && params.turn) {
					if (params.turn.error) { fail(new Error(params.turn.error.message)); } else { finish(); }
				}
			});
			let interruptAcked = false;
			let interruptPromise: Promise<void> | undefined;
			const sendInterrupt = () => {
				if (turnId && !interruptPromise) {
					interruptPromise = client.request('turn/interrupt', { threadId: session.id, turnId }, { timeoutMs: 2500 })
						.then(() => { interruptAcked = true; })
						.catch(() => { });
				}
			};
			const onAbort = () => sendInterrupt();
			options?.abortSignal?.addEventListener('abort', onAbort, { once: true });
			try {
				let turnSettled = false;
				try {
					const started = await client.request<{ turn: Turn }>('turn/start', {
						threadId: session.id,
						input,
						approvalPolicy,
						...(modelOverride ? { model: modelOverride } : {}),
						...(effortOverride ? { effort: effortOverride } : {}),
					}, { token, cancelGraceMs: 1500 });
					turnId = started.turn.id;
					turnDispatched = true;
					session.provisional = false;
					if (token.isCancellationRequested || options?.abortSignal?.aborted) {
						sendInterrupt();
					}
					await raceWithCancellation(completed.then(() => { turnSettled = true; }), token, 1500, sendInterrupt);
				} catch (err) {
					if (token.isCancellationRequested || options?.abortSignal?.aborted || err instanceof vscode.CancellationError) {
						sendInterrupt();
						if (interruptPromise && !turnSettled && !interruptAcked) {
							await Promise.race([
								interruptPromise,
								new Promise<void>(resolve => setTimeout(resolve, 400)),
							]);
						}
						// Keep `codex app-server` warm when `turn/interrupt` cleanly settled the turn;
						// only tear down the daemon if the turn ignored interrupt and stayed wedged!
						if (!turnSettled && !interruptAcked) {
							await this.killSession(session).catch(() => { });
						}
						return;
					}
					throw err;
				}
			} finally {
				for (let rem = activeExternalItemIds.size; rem > 0; rem--) {
					try { options?.onExternalWaitEnd?.(); } catch { /* ignore */ }
				}
				activeExternalItemIds.clear();
				options?.abortSignal?.removeEventListener('abort', onAbort);
				listener.dispose();
			}
		};

		const requestedModel = this.requestedModel(options) ?? this.threadModelOverrides.get(session.id);
		try {
			await runSingleTurn(requestedModel, mappedEffort);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			// Never replay `turn/start` if the turn already started executing on the thread (#95 P1-7).
			const fallbacks = !turnDispatched
				? planCodexTurnFallbacks(requestedModel, mappedEffort, this.defaultModel, msg)
				: [];
			if (fallbacks.length > 0) {
				let lastFallbackErr: unknown = error;
				for (const attempt of fallbacks) {
					if (token.isCancellationRequested || turnDispatched) {
						break;
					}
					try {
						await runSingleTurn(attempt.model, attempt.effort);
						if (attempt.pinDefaultModel && attempt.model) {
							this.threadModelOverrides.set(session.id, attempt.model);
						}
						return;
					} catch (retryErr) {
						lastFallbackErr = retryErr;
						if (turnDispatched) {
							break;
						}
					}
				}
				throw lastFallbackErr;
			}
			throw error;
		}
	}

	async getRuntimeCapabilities(cwd: string, _session?: NativeSession): Promise<EngineRuntimeCapabilities> {
		const cached = this.capabilitiesCache.get(cwd);
		if (cached && cached.expiresAt > Date.now()) {
			return {
				defaultModel: cached.value.defaultModel,
				models: cached.value.models?.map(m => ({ ...m })),
				commands: cached.value.commands?.map(c => ({ ...c })),
			};
		}
		const pending = this.capabilitiesPending.get(cwd);
		if (pending) {
			return pending;
		}
		const load = (async (): Promise<EngineRuntimeCapabilities> => {
			let client: JsonLineClient | undefined;
			try {
				client = await withTimeout(this.ensureReady(), 6000);
			} catch {
				return {
					defaultModel: this.defaultModel,
					models: this.cachedModelList.length > 0 ? this.cachedModelList.map(m => ({ ...m })) : undefined,
					commands: undefined,
				};
			}
			let models: Array<{ id: string; name: string; description?: string }> | undefined;
			try {
				models = await this.fetchModelList(client, 4500);
			} catch {
				models = this.cachedModelList.length > 0 ? this.cachedModelList.map(m => ({ ...m })) : undefined;
			}
			if (models && models.length === 0 && this.cachedModelList.length > 0) {
				models = this.cachedModelList.map(m => ({ ...m }));
			}
			let commands: Array<{ name: string; description?: string }> | undefined;
			try {
				const response = await withTimeout(client.request<unknown>('skills/list', { cwds: [cwd] }), 4000);
				commands = [];
				const seen = new Set<string>();
				for (const entry of extractSkillEntries(response)) {
					const raw = entry.name ?? entry.skill ?? entry.id ?? (entry.path ? path.basename(entry.path).replace(/\.(md|json)$/i, '') : '');
					const name = raw.replace(/^\/+/, '').trim();
					if (name && !seen.has(name)) {
						seen.add(name);
						commands.push(entry.description ? { name, description: entry.description } : { name });
					}
				}
			} catch { /* skills/list is optional; keep undefined on failure. */ }
			const value: EngineRuntimeCapabilities = {
				defaultModel: this.defaultModel,
				models: models?.map(m => ({ ...m })),
				commands: commands?.map(c => ({ ...c })),
			};
			const ttl = (models && models.length > 0) || (commands && commands.length > 0) ? 30_000 : 2_000;
			this.capabilitiesCache.set(cwd, { value, expiresAt: Date.now() + ttl });
			return {
				defaultModel: value.defaultModel,
				models: value.models?.map(m => ({ ...m })),
				commands: value.commands?.map(c => ({ ...c })),
			};
		})();
		this.capabilitiesPending.set(cwd, load);
		try {
			return await load;
		} finally {
			this.capabilitiesPending.delete(cwd);
		}
	}

	async executeCommand(session: NativeSession, command: string, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<boolean> {
		if (token.isCancellationRequested) {
			return true;
		}
		switch (command.replace(/^\/+/, '').trim().toLowerCase()) {
			case 'compact':
				return this.executeCompact(session, stream, token);
			case 'review':
				return this.executeReview(session, argsText, stream, token);
			case 'fork':
				return this.executeFork(session, stream, token);
			case 'status':
			case 'mcp':
				return this.executeStatus(session, stream, options);
			default:
				return false;
		}
	}

	private async materializeForCommand(session: NativeSession): Promise<{ readonly client: JsonLineClient; readonly loaded: Set<string> }> {
		const scopeKey = this.resolveLiveScopeKey(session.id);
		const slot = await this.ensureSlot(scopeKey);
		if (session.unmaterialized || session.provisional) {
			await this.prepareSession(session);
		}
		return slot;
	}

	private async executeCompact(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<boolean> {
		try {
			const { client } = await this.materializeForCommand(session);
			if (token.isCancellationRequested) {
				return true;
			}
			await client.request('thread/compact/start', { threadId: session.id });
			stream.markdown(`**${vscode.l10n.t('Compaction started')}**\n\n${vscode.l10n.t('Codex will summarize the conversation history for thread `{0}`.', session.id)}`);
			return true;
		} catch (error) {
			stream.markdown(`**${vscode.l10n.t('Compaction unavailable')}**\n\n${vscode.l10n.t('Codex could not start compaction: {0}', error instanceof Error ? error.message : String(error))}`);
			return false;
		}
	}

	private async executeReview(session: NativeSession, argsText: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<boolean> {
		const instructions = argsText.trim();
		try {
			const { client } = await this.materializeForCommand(session);
			if (token.isCancellationRequested) {
				return true;
			}
			const result = await client.request<Record<string, unknown>>('review/start', {
				threadId: session.id,
				target: instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' },
			});
			const text = extractReviewText(result);
			stream.markdown(`**${vscode.l10n.t('Codex review')}**\n\n${text ?? vscode.l10n.t('Codex started the review.')}`);
			return true;
		} catch (error) {
			if (isUnsupportedMethod(error)) {
				return false;
			}
			stream.markdown(`**${vscode.l10n.t('Review unavailable')}**\n\n${vscode.l10n.t('Codex could not start the review: {0}', error instanceof Error ? error.message : String(error))}`);
			return true;
		}
	}

	private async executeFork(session: NativeSession, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<boolean> {
		if (session.provisional) {
			stream.markdown(vscode.l10n.t('This Codex thread has not started yet, so there is nothing to fork. Send a message first.'));
			return true;
		}
		try {
			const scopeKey = this.resolveLiveScopeKey(session.id);
			const { client, loaded } = await this.ensureSlot(scopeKey);
			if (token.isCancellationRequested) {
				return true;
			}
			const result = await client.request<{ thread?: Thread; threadId?: string }>('thread/fork', { threadId: session.id, cwd: session.cwd });
			const forkedId = result.thread?.id ?? result.threadId;
			if (forkedId) {
				loaded.add(forkedId);
				this.sessionScopeKeys.set(forkedId, scopeKey);
				if (result.thread) {
					this.changed.fire([this.session(result.thread)]);
				}
				stream.markdown(vscode.l10n.t('Forked thread `{0}` from `{1}`.', forkedId, session.id));
			} else {
				stream.markdown(vscode.l10n.t('Codex forked the thread but did not report the new thread ID.'));
			}
			return true;
		} catch (error) {
			stream.markdown(vscode.l10n.t('Codex could not fork this thread: {0}', error instanceof Error ? error.message : String(error)));
			return true;
		}
	}

	private async executeStatus(session: NativeSession, stream: vscode.ChatResponseStream, options?: EngineSendOptions): Promise<boolean> {
		const settings = this.sessionSettings.get(session.id);
		const model = this.requestedModel(options) ?? settings?.model ?? this.defaultModel ?? vscode.l10n.t('Unknown');
		const effort = options?.thinking ?? settings?.effort ?? vscode.l10n.t('Default');
		const approval = this.approvalPolicy(options, options?.permissionMode ?? settings?.approvalPolicy);
		const sandbox = this.sandboxMode(options, options?.sandboxMode ?? settings?.sandbox);
		const webSearch = options?.webSearch ?? settings?.webSearch ?? 'enabled';
		const mcpServers = await this.readMcpServerNames();
		const rows: Array<[string, string]> = [
			[vscode.l10n.t('Thread ID'), session.id],
			[vscode.l10n.t('State'), session.provisional ? vscode.l10n.t('Provisional') : vscode.l10n.t('Started')],
			[vscode.l10n.t('Model'), model],
			[vscode.l10n.t('Reasoning effort'), effort],
			[vscode.l10n.t('Approval policy'), approval],
			[vscode.l10n.t('Sandbox mode'), sandbox],
			[vscode.l10n.t('Web search'), webSearch],
			[vscode.l10n.t('MCP servers'), mcpServers.length ? mcpServers.join(', ') : vscode.l10n.t('none configured')],
		];
		stream.markdown(`### ${vscode.l10n.t('Codex session status')}\n\n| ${vscode.l10n.t('Setting')} | ${vscode.l10n.t('Value')} |\n| --- | --- |\n`);
		for (const [setting, value] of rows) {
			stream.markdown(`| ${escapeTableCell(setting)} | ${escapeTableCell(value)} |\n`);
		}
		return true;
	}

	private async readMcpServerNames(): Promise<string[]> {
		try {
			let toml: string | undefined;
			if (this.remoteTarget) {
				const remoteRoot = this.codexHome || (this.remoteTarget.remoteHome ? joinRemotePath(this.remoteTarget.os, this.remoteTarget.remoteHome, '.codex') : undefined);
				if (remoteRoot) {
					toml = await readRemoteTextFile(this.remoteTarget, joinRemotePath(this.remoteTarget.os, remoteRoot, 'config.toml'));
				}
			} else {
				const configFile = path.join(this.codexHome || path.join(os.homedir(), '.codex'), 'config.toml');
				toml = await fs.readFile(configFile, 'utf8');
			}
			if (!toml) {
				return [];
			}
			const names = new Set<string>();
			for (const match of toml.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\]/gm)) {
				const name = (match[1] ?? match[2] ?? match[3] ?? '').trim();
				if (name) {
					names.add(name);
				}
			}
			return [...names];
		} catch {
			return [];
		}
	}

	async delete(session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (session.unmaterialized) {
			this.knownSessions.delete(session.id);
			return;
		}
		for (const child of await this.children(session, token)) {
			await this.delete(child, token);
		}
		const scopeKey = this.resolveLiveScopeKey(session.id);
		const { client, loaded } = await this.ensureSlot(scopeKey);
		if (session.provisional) {
			await client.request('thread/unsubscribe', { threadId: session.id }).catch(() => { });
		} else {
			try {
				await client.request('thread/delete', { threadId: session.id });
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
				if (message.includes('no rollout found') || message.includes('not found')) {
					await client.request('thread/unsubscribe', { threadId: session.id }).catch(() => { });
				} else {
					throw error;
				}
			}
		}
		loaded.delete(session.id);
		this.sessionScopeKeys.delete(session.id);
		if (scopeKey !== SHARED_PURE_SCOPE_KEY) {
			this.scopeIdentities.delete(scopeKey);
			this.disposeSlot(scopeKey);
		}
		this.knownSessions.delete(session.id);
		this.lastTurnUsageBySession.delete(session.id);
		this.lastRawThreadUsageBySession.delete(session.id);
		if (session.file && !this.remoteTarget) {
			await fs.rm(session.file, { force: true });
		}
	}

	dispose(): void {
		for (const key of [...this.clientSlots.keys()]) {
			this.disposeSlot(key);
		}
		this.sessionScopeKeys.clear();
		this.scopeIdentities.clear();
		this.lastTurnUsageBySession.clear();
		this.lastRawThreadUsageBySession.clear();
		this.changed.dispose();
	}
}
