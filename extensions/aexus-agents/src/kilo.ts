/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { capture, EngineRuntime, EngineSendOptions, HistoryEntry, NativeSession, readJsonOutput, spawnEngine, stopEngine, withTimeout } from './runtime';

interface KiloSession { id: string; parentID?: string; directory: string; title: string; time?: { created: number; updated: number }; created?: number; updated?: number }
interface KiloSessionListItem { id: string; directory: string; title: string; created: number; updated: number }
interface KiloPart { id: string; type: string; text?: string; sessionID?: string }
interface KiloMessage { info: { id: string; role: string; error?: { data?: { message?: string } } }; parts: KiloPart[] }
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
	info?: Partial<KiloSession> & { id: string; role?: string; sessionID?: string };
	questions?: { header: string; question: string; options: { label: string; description: string }[]; multiple?: boolean }[];
}
interface KiloEvent { type: string; properties?: KiloEventData; data?: KiloEventData }

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

	constructor(protected readonly executable: string) { }

	private getEndpoint(): Promise<string> {
		if (!this.endpoint) {
			this.endpoint = new Promise<string>((resolve, reject) => {
				const child = this.child = spawnEngine(this.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], undefined, {
					...process.env,
					[`${this.envPrefix}_SERVER_USERNAME`]: 'aexus',
					[`${this.envPrefix}_SERVER_PASSWORD`]: this.password,
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

	private async answer(event: KiloEvent, data: KiloEventData, session: NativeSession, token: vscode.CancellationToken): Promise<void> {
		if (event.type === 'permission.asked') {
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
					const event = JSON.parse(raw) as KiloEvent;
					const data = event.properties ?? event.data;
					if (event.type === 'session.created' && data?.info?.parentID) { this.changed.fire([this.session(data.info as KiloSession)]); }
					const sessionId = data?.sessionID ?? data?.part?.sessionID ?? data?.info?.sessionID;
					if (data && sessionId && (event.type === 'permission.asked' || event.type === 'question.asked') && this.belongsTo(sessionId, session.id)) {
						void this.answer(event, data, this.knownSessions.get(sessionId)!, token).catch(() => { });
					}
					if (!data || sessionId !== session.id) { continue; }
					if (event.type === 'message.updated' && data.info?.role) { roles.set(data.info.id, data.info.role); }
					if (event.type === 'message.part.updated' && data.part) { parts.set(data.part.id, data.part.type); }
					if (event.type === 'message.part.delta' && data.field === 'text' && data.delta && roles.get(data.messageID!) === 'assistant' && parts.get(data.partID!) === 'text') {
						streamed = true;
						stream.markdown(data.delta);
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
			const payloadBase: Record<string, unknown> = { parts: [{ type: 'text', text }] };
			if (options?.thinking) {
				payloadBase.variant = options.thinking;
			}
			let result: KiloMessage;
			try {
				result = await this.request<KiloMessage>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', payloadBase, abort.signal);
			} catch (err) {
				if (options?.thinking && !abort.signal.aborted) {
					result = await this.request<KiloMessage>(`/session/${encodeURIComponent(session.id)}/message`, session.cwd, 'POST', { parts: [{ type: 'text', text }] }, abort.signal);
				} else {
					throw err;
				}
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
