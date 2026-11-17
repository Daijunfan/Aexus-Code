/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineRuntime, EngineSendOptions, HistoryEntry, NativeSession, spawnEngine, stopEngine } from './runtime';

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
		const args = [
			'--mode', 'rpc',
			...(options?.model ? ['--model', options.model] : []),
			...(session.file ? ['--session', session.file] : ['--session-id', session.id]),
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
					} else if (ame?.type === 'toolcall_start' && typeof ame.toolName === 'string') {
						stream.progress(ame.toolName);
					}
				} else if (packet.type === 'tool_execution_start' && !token.isCancellationRequested) {
					stream.progress(typeof packet.toolName === 'string' && packet.toolName ? packet.toolName : vscode.l10n.t('Pi is working…'));
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
			if (options?.thinking) {
				const piLevel = options.thinking === 'max' ? 'xhigh' : options.thinking;
				await sendCommand({ type: 'set_thinking_level', level: piLevel }).catch(() => undefined);
			}
			await sendCommand({ type: 'prompt', message: text });
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
