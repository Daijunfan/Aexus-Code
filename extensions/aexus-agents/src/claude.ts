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
import { EngineRuntime, EngineSendOptions, EngineThinkingLevel, HistoryEntry, NativeSession, spawnEngine, stopEngine } from './runtime';

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

function isSafeAdeOrchestratorToolCall(
	callerRole: string | undefined,
	toolName: string | undefined,
	rawInput: object | undefined,
): boolean {
	if (callerRole !== 'secretary' && callerRole !== 'governor' && callerRole !== 'manager' && callerRole !== 'employee') {
		return false;
	}
	if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep' || toolName === 'LS') {
		return true;
	}
	const input = (rawInput ?? {}) as Record<string, unknown>;
	if (toolName === 'Write' || toolName === 'Edit') {
		const fp = typeof input.file_path === 'string' ? input.file_path : '';
		return fp.startsWith('/tmp/') || fp.startsWith('/private/tmp/') || fp.startsWith(os.tmpdir());
	}
	if (toolName === 'Bash') {
		const cmd = typeof input.command === 'string' ? input.command.trim() : '';
		return /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*aexus-ade(?:\s|$)/.test(cmd);
	}
	return false;
}

export class ClaudeRuntime implements EngineRuntime {
	readonly id = 'claude';
	readonly name = 'Claude Code';
	private readonly running = new Set<ReturnType<typeof spawnEngine>>();
	private readonly runningBySession = new Map<string, Set<ReturnType<typeof spawnEngine>>>();
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

	private mapClaudeThinkingTokens(thinking?: EngineThinkingLevel): string | undefined {
		switch (thinking) {
			case 'off': return '0';
			case 'low': return '4096';
			case 'medium': return '10000';
			case 'high': return '20000';
			case 'max': return '31999';
			default: return undefined;
		}
	}

	private mapClaudeEffortArg(thinking?: EngineThinkingLevel): string | undefined {
		switch (thinking) {
			case 'off':
			case 'low':
				return 'low';
			case 'medium':
				return 'medium';
			case 'high':
				return 'high';
			case 'max':
				return 'max';
			default:
				return undefined;
		}
	}

	async listConfiguredModels(): Promise<readonly { readonly id: string; readonly label: string }[]> {
		try {
			const settingsPath = path.join(this.configDir(), 'settings.json');
			const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
				model?: unknown;
				modelPicker?: { options?: Array<{ model?: unknown; label?: unknown }> };
			};
			const out: { id: string; label: string }[] = [];
			const seen = new Set<string>();
			const addModel = (idRaw: unknown, labelRaw?: unknown) => {
				const id = typeof idRaw === 'string' ? idRaw.trim() : '';
				if (!id || seen.has(id)) {
					return;
				}
				seen.add(id);
				const label = typeof labelRaw === 'string' && labelRaw.trim() ? `${labelRaw.trim()} (${id})` : id;
				out.push({ id, label });
			};
			if (Array.isArray(raw.modelPicker?.options)) {
				for (const opt of raw.modelPicker.options) {
					addModel(opt?.model, opt?.label);
				}
			}
			addModel(raw.model);
			return out;
		} catch {
			return [];
		}
	}

	private async resolveModelIdentifier(requestedModel?: string): Promise<string | undefined> {
		const trimmed = requestedModel?.trim();
		if (!trimmed) {
			return undefined;
		}
		const configured = await this.listConfiguredModels();
		if (configured.length === 0) {
			return trimmed;
		}
		const exact = configured.find(m => m.id === trimmed || m.id.toLowerCase() === trimmed.toLowerCase());
		if (exact) {
			return exact.id;
		}
		const lower = trimmed.toLowerCase();
		const byPrefix = configured.find(m => m.id.toLowerCase().startsWith(lower) || m.label.toLowerCase().includes(lower));
		return byPrefix ? byPrefix.id : trimmed;
	}

	private async hasPersistedTranscript(sessionId: string): Promise<boolean> {
		try {
			const projectsRoot = path.join(this.configDir(), 'projects');
			const dirs = await fs.readdir(projectsRoot);
			for (const dir of dirs) {
				try {
					await fs.access(path.join(projectsRoot, dir, `${sessionId}.jsonl`));
					return true;
				} catch { /* check next project dir */ }
			}
		} catch { /* ignore */ }
		return false;
	}

	async killSession(session: NativeSession): Promise<void> {
		const procs = this.runningBySession.get(session.id);
		if (procs) {
			for (const child of procs) {
				stopEngine(child, 'SIGKILL');
			}
			this.runningBySession.delete(session.id);
		}
	}

	async send(session: NativeSession, text: string, stream: vscode.ChatResponseStream, token: vscode.CancellationToken, options?: EngineSendOptions): Promise<void> {
		const resolvedModel = await this.resolveModelIdentifier(options?.model);
		if (session.provisional && await this.hasPersistedTranscript(session.id)) {
			session.provisional = false;
		}

		const runOnce = async (useModelOverride: boolean, forceResume = false): Promise<void> => {
			const useResume = forceResume || !session.provisional;
			const isAutoEng = Boolean(options?.automatedEngineering);
			const effortArg = this.mapClaudeEffortArg(options?.thinking);
			const args = [
				'--print', '--verbose',
				'--input-format', 'stream-json',
				'--output-format', 'stream-json',
				'--include-partial-messages',
				...(isAutoEng
					? ['--permission-mode', 'bypassPermissions', '--permission-prompts', 'none']
					: ['--permission-prompts', 'host']),
				...(useModelOverride && resolvedModel ? ['--model', resolvedModel] : []),
				...(effortArg ? ['--effort', effortArg] : []),
				useResume ? '--resume' : '--session-id',
				session.id,
			];
			const thinkingTokens = this.mapClaudeThinkingTokens(options?.thinking);
			const customEnv: NodeJS.ProcessEnv = { ...process.env };
			if (thinkingTokens !== undefined) {
				customEnv.MAX_THINKING_TOKENS = thinkingTokens;
			}
			if (options?.thinking === 'off') {
				customEnv.CLAUDE_CODE_DISABLE_THINKING = '1';
			}
			if (options?.pureWorker) {
				delete customEnv.AEXUS_ADE_CALLER;
			} else if (options?.callerRole) {
				customEnv.AEXUS_ADE_CALLER = options.callerRole;
			}

			const child = spawnEngine(this.executable, args, session.cwd, customEnv);
			this.running.add(child);
			let sessionSet = this.runningBySession.get(session.id);
			if (!sessionSet) {
				sessionSet = new Set();
				this.runningBySession.set(session.id, sessionSet);
			}
			sessionSet.add(child);

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
				if (!fromChild && !token.isCancellationRequested && event.type === 'assistant' && !wroteText) { const msg = messageText(event); if (msg) { stream.markdown(msg); } }
				if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
					const request = event.request;
					if (isAutoEng || isSafeAdeOrchestratorToolCall(options?.callerRole, request.tool_name, request.input)) {
						if (!child.stdin.destroyed) {
							child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: { behavior: 'allow', updatedInput: request.input } } }) + '\n');
						}
						return;
					}
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
			} finally {
				cancellation.dispose();
				lines.close();
				this.running.delete(child);
				sessionSet.delete(child);
				if (sessionSet.size === 0) {
					this.runningBySession.delete(session.id);
				}
			}
		};

		try {
			await runOnce(Boolean(resolvedModel));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (/already in use|already exists/i.test(msg)) {
				session.provisional = false;
				await runOnce(Boolean(resolvedModel), true);
				return;
			}
			if (resolvedModel && /model|not_found|invalid/i.test(msg)) {
				await runOnce(false);
				return;
			}
			throw error;
		}
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
