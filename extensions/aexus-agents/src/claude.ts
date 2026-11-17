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
import { EngineRuntime, HistoryEntry, NativeSession, spawnEngine, stopEngine } from './runtime';

interface ContentPart { type: string; text?: string }
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
	message?: { content: string | ContentPart[] };
	event?: { type: string; delta?: { type: string; text?: string } };
	request_id?: string;
	request?: { subtype: string; tool_name: string; input: object };
	result?: string;
	is_error?: boolean;
}

function messageText(event: ClaudeEvent): string {
	const content = event.message?.content;
	return typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
}

export class ClaudeRuntime implements EngineRuntime {
	readonly id = 'claude';
	readonly name = 'Claude Code';
	private readonly running = new Set<ReturnType<typeof spawnEngine>>();
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

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--permission-prompts', 'host', session.provisional ? '--session-id' : '--resume', session.id];
		const child = spawnEngine(this.executable, args, session.cwd);
		this.running.add(child);
		const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
		let errorText = '';
		let resultError: string | undefined;
		let wroteText = false;
		child.stderr.on('data', data => errorText = (errorText + String(data)).slice(-8000));
		lines.on('line', line => {
			let event: ClaudeEvent;
			try { event = JSON.parse(line) as ClaudeEvent; } catch { return; }
			const fromChild = typeof event.parent_tool_use_id === 'string';
			if (event.type === 'system' && event.subtype === 'init') { session.provisional = false; }
			if (!fromChild && !token.isCancellationRequested && event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && event.event.delta.text) {
				wroteText = true;
				stream.markdown(event.event.delta.text);
			}
			if (!fromChild && !token.isCancellationRequested && event.type === 'assistant' && !wroteText) { const text = messageText(event); if (text) { stream.markdown(text); } }
			if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
				const request = event.request;
				const allow = vscode.l10n.t('Allow Once');
				void vscode.window.showQuickPick([allow, vscode.l10n.t('Deny')], { title: vscode.l10n.t('Claude Code requests permission'), placeHolder: `${session.cwd}: ${request.tool_name}: ${JSON.stringify(request.input)}`, ignoreFocusOut: true }, token).then(result => {
					if (!child.stdin.destroyed) {
						child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: result === allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: vscode.l10n.t('Denied by the user.') } } }) + '\n');
					}
				});
			}
			if (!fromChild && event.type === 'result') {
				if (event.is_error) { resultError = event.result || vscode.l10n.t('Claude Code could not complete this request.'); }
				if (!event.is_error) { session.provisional = false; }
				child.stdin.end();
			}
		});
		const cancellation = token.onCancellationRequested(() => stopEngine(child, 'SIGINT'));
		child.stdin.write(JSON.stringify({ type: 'user', session_id: session.id, parent_tool_use_id: null, message: { role: 'user', content: text } }) + '\n');
		try {
			await new Promise<void>((resolve, reject) => {
				child.on('error', reject);
				child.on('close', code => token.isCancellationRequested ? resolve() : resultError || code !== 0 ? reject(new Error(resultError || errorText || vscode.l10n.t('Claude Code exited with code {0}.', String(code)))) : resolve());
			});
		} finally { cancellation.dispose(); lines.close(); this.running.delete(child); }
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
