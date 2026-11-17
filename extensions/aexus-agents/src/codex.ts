/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { EngineRuntime, HistoryEntry, JsonLineClient, NativeSession, RpcPacket, withTimeout } from './runtime';

interface ThreadItem { type: string; text?: string; command?: string; content?: { type: string; text?: string }[] }
interface Turn { id: string; status: string; error?: { message: string }; items: ThreadItem[] }
interface Thread { id: string; parentThreadId?: string; agentNickname?: string; cwd: string; name?: string; preview: string; path?: string; createdAt: number; updatedAt: number; turns: Turn[] }
interface RolloutEntry { type: string; payload?: { type?: string; id?: string; content?: { type: string; text?: string }[]; cwd?: string; parent_thread_id?: string; multi_agent_version?: string; agent_nickname?: string; source?: { subagent?: { thread_spawn?: { parent_thread_id: string; agent_nickname?: string } } }; timestamp?: string; message?: string; item?: { type: string; id: string; content?: { type: string; text?: string }[] } } }
interface SessionIndexEntry { id: string; thread_name: string; updated_at: string }
interface Notification { threadId?: string; delta?: string; turn?: Turn; item?: ThreadItem; message?: string }
interface Question { id: string; header: string; question: string; options?: { label: string; description: string }[]; isSecret?: boolean }

export class CodexRuntime implements EngineRuntime {
	readonly id = 'codex';
	readonly name = 'Codex';
	private client!: JsonLineClient;
	private ready!: Promise<void>;
	private readonly loaded = new Set<string>();
	private codexHome!: string;
	private readonly changed = new vscode.EventEmitter<readonly NativeSession[]>();
	readonly onDidChangeSessions = this.changed.event;
	private sessionListener: vscode.Disposable | undefined;
	private readonly knownSessions = new Map<string, NativeSession>();
	private readonly supportedModels = new Set<string>();
	private readonly threadModelOverrides = new Map<string, string>();
	private defaultModel: string | undefined;

	constructor(private readonly executable: string) { this.connect(); }

	private connect(): void {
		this.loaded.clear();
		this.supportedModels.clear();
		this.defaultModel = undefined;
		const client = this.client = new JsonLineClient(this.executable, ['app-server']);
		this.sessionListener?.dispose();
		this.sessionListener = client.onPacket(packet => {
			if (packet.method === 'thread/started') {
				const thread = (packet.params as { thread: Thread }).thread;
				this.loaded.add(thread.id);
				if (thread.parentThreadId) { this.changed.fire([this.session(thread)]); }
			}
		});
		this.ready = client.request<{ codexHome: string }>('initialize', { clientInfo: { name: 'aexus-code', title: 'Aexus Code', version: '0.1.0' }, capabilities: { experimentalApi: true } }).then(async info => {
			this.codexHome = info.codexHome;
			client.write({ jsonrpc: '2.0', method: 'initialized' });
			try {
				const modelsResp = await withTimeout(client.request<{ data?: { id?: string; model?: string; isDefault?: boolean }[] }>('model/list', {}), 4000);
				for (const item of modelsResp?.data ?? []) {
					const name = item.model || item.id;
					if (name) {
						this.supportedModels.add(name);
						if (item.isDefault || !this.defaultModel) {
							this.defaultModel = name;
						}
					}
				}
			} catch { /* Keep CLI default model when model/list is unavailable. */ }
		});
		void this.ready.catch(() => {
			client.dispose();
		});
	}

	private recordThreadModelIfUnsupported(threadId: string, model?: string): void {
		if (this.defaultModel && this.supportedModels.size > 0 && model && !this.supportedModels.has(model)) {
			this.threadModelOverrides.set(threadId, this.defaultModel);
		}
	}

	private ensureReady(): Promise<void> {
		if (this.client.isClosed) { this.client.dispose(); this.connect(); }
		return this.ready;
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

	async list(token: vscode.CancellationToken): Promise<NativeSession[]> {
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
				let event: RolloutEntry;
				try { event = JSON.parse(line) as RolloutEntry; } catch { continue; }
				if (!session && event.type === 'session_meta' && event.payload?.id && event.payload.cwd) {
					const meta = event.payload;
					const named = index.get(meta.id!);
					const stat = await fs.stat(file);
					session = { id: meta.id!, parentId: meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id, readOnly: meta.multi_agent_version === 'v2' && !!meta.parent_thread_id, cwd: meta.cwd!, file, label: named?.thread_name || meta.agent_nickname || meta.source?.subagent?.thread_spawn?.agent_nickname || vscode.l10n.t('Codex Session {0}', meta.id!.slice(0, 8)), created: meta.timestamp ? Date.parse(meta.timestamp) : stat.birthtimeMs, updated: named?.updated_at ? Date.parse(named.updated_at) : stat.mtimeMs, provisional: false };
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

	async create(cwd: string): Promise<NativeSession> {
		const now = Date.now();
		try {
			return await withTimeout((async () => {
				await this.ensureReady();
				const result = await this.client.request<{ thread: Thread; model?: string }>('thread/start', { cwd, ephemeral: false });
				this.loaded.add(result.thread.id);
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

	async prepareSession(session: NativeSession): Promise<void> {
		await this.ensureReady();
		if (session.unmaterialized) {
			const result = await this.client.request<{ thread: Thread; model?: string }>('thread/start', { cwd: session.cwd, ephemeral: false });
			this.loaded.add(result.thread.id);
			this.recordThreadModelIfUnsupported(result.thread.id, result.model);
			Object.assign(session, this.session(result.thread), { provisional: true, unmaterialized: false });
			return;
		}
		if (session.parentId && !this.loaded.has(session.parentId)) {
			const parent = await this.client.request<{ thread: Thread }>('thread/read', { threadId: session.parentId, includeTurns: false });
			await this.prepareSession(this.session(parent.thread));
		}
		if (this.loaded.has(session.id)) { return; }
		try {
			const result = await this.client.request<{ thread: Thread; model?: string }>('thread/resume', { threadId: session.id, cwd: session.cwd, excludeTurns: true });
			this.loaded.add(session.id);
			this.recordThreadModelIfUnsupported(session.id, result.model);
			session.file = result.thread.path;
			session.provisional = false;
		} catch (error) {
			// Empty native threads have no rollout until their first user message.
			if (!session.provisional || !(error instanceof Error) || !error.message.includes('no rollout found')) { throw error; }
			Object.assign(session, await this.create(session.cwd));
		}
	}

	async history(session: NativeSession, token: vscode.CancellationToken): Promise<HistoryEntry[]> {
		if (session.unmaterialized) { return []; }
		if (session.provisional || !session.file) { await this.prepareSession(session); }
		if (session.provisional || token.isCancellationRequested) { return []; }
		if (!session.file) { throw new Error(vscode.l10n.t('Codex did not report the native conversation history path.')); }
		const input = createReadStream(session.file);
		const lines = readline.createInterface({ input, crlfDelay: Infinity });
		const entries = new Map<string, HistoryEntry>();
		try {
			for await (const line of lines) {
				if (token.isCancellationRequested) { break; }
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

	private async handleRequest(client: JsonLineClient, packet: RpcPacket, session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		const params = packet.params ?? {};
		if (packet.method?.endsWith('/requestApproval')) {
			const command = typeof params.command === 'string' ? params.command : typeof params.reason === 'string' ? params.reason : packet.method;
			const allow = vscode.l10n.t('Allow Once');
			const result = await vscode.window.showQuickPick([allow, vscode.l10n.t('Deny')], { title: vscode.l10n.t('Codex requests permission'), placeHolder: `${session.cwd}: ${command}`, ignoreFocusOut: true }, token);
			client.write({ jsonrpc: '2.0', id: packet.id, result: packet.method === 'item/permissions/requestApproval' ? { permissions: result === allow ? params.permissions : {}, scope: 'turn' } : { decision: result === allow ? 'accept' : 'decline' } });
			return;
		}
		if (packet.method === 'item/tool/requestUserInput') {
			const answers: Record<string, { answers: string[] }> = {};
			for (const question of params.questions as Question[]) {
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

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		await this.prepareSession(session);
		this.knownSessions.set(session.id, session);
		const client = this.client;
		let turnId: string | undefined;
		const runSingleTurn = async (modelOverride?: string): Promise<void> => {
			let finish!: () => void;
			let fail!: (error: Error) => void;
			const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
			void completed.catch(() => { });
			const listener = client.onPacket(packet => {
				if (packet.method === 'aexus/connectionClosed') { fail(new Error(String(packet.params?.message))); return; }
				const params = packet.params as Notification | undefined;
				if (packet.id !== undefined && params?.threadId && this.belongsTo(params.threadId, session.id)) { void this.handleRequest(client, packet, this.knownSessions.get(params.threadId)!, token).catch(fail); return; }
				if (params?.threadId !== session.id) { return; }
				if (!token.isCancellationRequested && packet.method === 'item/agentMessage/delta' && params.delta) { stream.markdown(params.delta); }
				if (!token.isCancellationRequested && packet.method === 'item/started' && params.item?.type !== 'agentMessage' && params.item?.type !== 'userMessage') {
					stream.progress(params.item?.command || vscode.l10n.t('Codex is working…'));
				}
				if (packet.method === 'turn/completed' && params.turn) {
					if (params.turn.error) { fail(new Error(params.turn.error.message)); } else { finish(); }
				}
			});
			const cancellation = token.onCancellationRequested(() => { if (turnId) { void client.request('turn/interrupt', { threadId: session.id, turnId }).catch(() => { }); } });
			try {
				const started = await client.request<{ turn: Turn }>('turn/start', {
					threadId: session.id,
					input: [{ type: 'text', text, text_elements: [] }],
					...(modelOverride ? { model: modelOverride } : {}),
				});
				turnId = started.turn.id;
				session.provisional = false;
				if (token.isCancellationRequested) { await client.request('turn/interrupt', { threadId: session.id, turnId }); }
				await completed;
			} finally {
				listener.dispose();
				cancellation.dispose();
			}
		};

		const initialOverride = this.threadModelOverrides.get(session.id);
		try {
			await runSingleTurn(initialOverride);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (!initialOverride && this.defaultModel && /model_not_found|not supported when using Codex/i.test(msg)) {
				this.threadModelOverrides.set(session.id, this.defaultModel);
				await runSingleTurn(this.defaultModel);
				return;
			}
			throw error;
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
		await this.ensureReady();
		if (session.provisional) {
			await this.client.request('thread/unsubscribe', { threadId: session.id }).catch(() => { });
		} else {
			try {
				await this.client.request('thread/delete', { threadId: session.id });
			} catch (error) {
				const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
				if (message.includes('no rollout found') || message.includes('not found')) {
					await this.client.request('thread/unsubscribe', { threadId: session.id }).catch(() => { });
				} else {
					throw error;
				}
			}
		}
		this.loaded.delete(session.id);
		this.knownSessions.delete(session.id);
		if (session.file) {
			await fs.rm(session.file, { force: true });
		}
	}

	dispose(): void { this.sessionListener?.dispose(); this.changed.dispose(); this.client.dispose(); }
}
