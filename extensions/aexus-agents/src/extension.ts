/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AntigravityRuntime, ClineRuntime, DshRuntime } from './acp';
import { ClaudeRuntime } from './claude';
import { CodexRuntime } from './codex';
import { KiloRuntime, OpenCodeRuntime } from './kilo';
import { installNativeRoleBridge } from './nativeRoleBridge';
import { PiRuntime } from './pi';
import { RoleSyncSnapshot } from './roleBridgeShared';
import { EngineRuntime, EngineThinkingLevel, findExecutable, HistoryEntry, NativeSession, setCliBinDirectory } from './runtime';

const roleBridge = installNativeRoleBridge({ distDir: __dirname });

interface RecordEntry extends NativeSession {
	engine: string;
	initialTitle?: string;
	customLabel?: boolean;
	resourceId?: string;
}

interface SecretaryState {
	engine: string;
	recordKey: string;
}

interface EngineDefinition {
	readonly id: string;
	readonly executable: string;
	readonly name: string;
	readonly type: string;
	readonly themeIcon?: string;
	readonly svgIcon?: string;
	readonly create: (command: string) => EngineRuntime;
}

const SECRETARY_TYPE = 'aexus-secretary';
const SECRETARY_URI = vscode.Uri.from({ scheme: SECRETARY_TYPE, path: '/main' });

const ENGINE_ALIASES: Record<string, string> = {
	codex: 'codex',
	'aexus-codex': 'codex',
	claude: 'claude',
	'claude-code': 'claude',
	'aexus-claude': 'claude',
	kilo: 'kilo',
	kilocode: 'kilo',
	'aexus-kilo': 'kilo',
	opencode: 'opencode',
	'aexus-opencode': 'opencode',
	dsh: 'dsh',
	deepseek: 'dsh',
	'aexus-dsh': 'dsh',
	agy: 'antigravity',
	antigravity: 'antigravity',
	'aexus-antigravity': 'antigravity',
	cline: 'cline',
	'aexus-cline': 'cline',
	pi: 'pi',
	'aexus-pi': 'pi',
};

const definitions: readonly EngineDefinition[] = [
	{ id: 'claude', executable: 'claude', name: 'Claude Code', type: 'aexus-claude', themeIcon: 'claude', create: command => new ClaudeRuntime(command) },
	{ id: 'codex', executable: 'codex', name: 'Codex', type: 'aexus-codex', themeIcon: 'openai', create: command => new CodexRuntime(command) },
	{ id: 'kilo', executable: 'kilo', name: 'Kilo Code', type: 'aexus-kilo', svgIcon: 'kilo', create: command => new KiloRuntime(command) },
	{ id: 'opencode', executable: 'opencode', name: 'OpenCode', type: 'aexus-opencode', svgIcon: 'opencode', create: command => new OpenCodeRuntime(command) },
	{ id: 'dsh', executable: 'dsh', name: 'DeepSeek Harness', type: 'aexus-dsh', svgIcon: 'dsh', create: command => new DshRuntime(command) },
	{ id: 'antigravity', executable: 'agy', name: 'Google Antigravity', type: 'aexus-antigravity', svgIcon: 'antigravity', create: command => new AntigravityRuntime(command) },
	{ id: 'cline', executable: 'cline', name: 'Cline', type: 'aexus-cline', svgIcon: 'cline', create: command => new ClineRuntime(command) },
	{ id: 'pi', executable: 'pi', name: 'Pi', type: 'aexus-pi', svgIcon: 'pi', create: command => new PiRuntime(command) },
];

async function resolveCliBinDir(extensionPath: string): Promise<string> {
	const binName = process.platform === 'win32' ? 'aexus-ade.cmd' : 'aexus-ade';
	const appBinDir = path.join(vscode.env.appRoot, 'bin');
	try {
		await fs.access(path.join(appBinDir, binName));
		return appBinDir;
	} catch {
		return path.join(extensionPath, 'bin');
	}
}

async function discoverCustomCommandsAndSkills(cwd: string): Promise<{ name: string; source: string }[]> {
	const found: { name: string; source: string }[] = [];
	const seen = new Set<string>();
	const scanMdCommands = async (dir: string, sourceLabel: string) => {
		try {
			for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
				if (entry.isFile() && entry.name.endsWith('.md')) {
					const name = entry.name.slice(0, -3);
					if (!seen.has(name)) {
						seen.add(name);
						found.push({ name: `/${name}`, source: sourceLabel });
					}
				}
			}
		} catch { /* Directory may not exist. */ }
	};
	const scanSkills = async (dir: string, sourceLabel: string) => {
		try {
			for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
				if (entry.isDirectory() && !seen.has(entry.name)) {
					try {
						await fs.access(path.join(dir, entry.name, 'SKILL.md'));
						seen.add(entry.name);
						found.push({ name: entry.name, source: sourceLabel });
					} catch { /* Not a skill folder. */ }
				}
			}
		} catch { /* Directory may not exist. */ }
	};

	await scanMdCommands(path.join(cwd, '.claude', 'commands'), 'Project (.claude/commands)');
	await scanSkills(path.join(cwd, '.agents', 'skills'), 'Project (.agents/skills)');
	await scanSkills(path.join(cwd, '.claude', 'skills'), 'Project (.claude/skills)');
	await scanMdCommands(path.join(os.homedir(), '.claude', 'commands'), 'User (~/.claude/commands)');
	await scanSkills(path.join(os.homedir(), '.agents', 'skills'), 'User (~/.agents/skills)');
	return found;
}

function buildSlashHelpMarkdown(isSecretary: boolean, engineName: string, discovered: readonly { name: string; source: string }[]): string {
	const lines: string[] = [];
	if (isSecretary) {
		lines.push(
			`### Secretary ADE Commands (Current Engine: **${engineName}**)`,
			'- `/status` — Show live ADE viewport, Focus state, Secretary engine, and session counts',
			'- `/projects` — List all ADE projects and active session counts',
			'- `/sessions` — List ADE sessions, ranks, engines, and hierarchy',
			'- `/engineering` — List ADE Engineering DAG trees and progress',
			'- `/inbox` — Show pending ADE Inbox user gates and Governor escalations',
			'- `/focus <project>` — Focus a project in ADE',
			'- `/home` — Exit Focus back to ADE Home overview',
			'- `/new [engine] [title]` — Create and open a new ADE Agent session',
			'- `/engine [name]` — View or switch Secretary\'s underlying Coding Agent engine',
			'- `/reset` — Reset Secretary conversation context',
			'',
		);
	}
	lines.push(
		`### Native Engine Slash Commands (**${engineName}**)`,
		'- `/init` — Initialize or update project instructions (`CLAUDE.md` / `AGENTS.md`)',
		'- `/compact` — Compact conversation context',
		'- `/review` — Review uncommitted code changes',
		'- `/plan` — Draft an implementation plan before editing',
		'- `/clear` — Clear engine conversation history and start fresh',
		'- `/model` — Inspect or switch model in the engine',
		'- `/mcp` — Inspect configured MCP servers & tools',
		'- `/memory` — View or update persistent memory',
		'- `/cost` — Show token usage & session cost',
		'- `/doctor` — Run engine diagnostics',
		'- `/diff` — Summarize uncommitted Git changes',
		'- `/skills` — List discovered custom project/user commands & skills',
	);
	if (discovered.length > 0) {
		lines.push('', '### Discovered Custom Commands & Skills');
		for (const item of discovered) {
			lines.push(`- \`${item.name}\` — *${item.source}*`);
		}
	}
	return lines.join('\n');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const cliBinDir = await resolveCliBinDir(context.extensionPath);
	setCliBinDirectory(cliBinDir);
	const currentEnvPath = process.env.PATH ?? '';
	if (!currentEnvPath.split(path.delimiter).includes(cliBinDir)) {
		process.env.PATH = currentEnvPath ? `${cliBinDir}${path.delimiter}${currentEnvPath}` : cliBinDir;
	}
	context.environmentVariableCollection.prepend('PATH', cliBinDir + path.delimiter);

	const records = new Map<string, RecordEntry>(Object.entries(context.globalState.get<Record<string, RecordEntry>>('nativeSessions', {})));
	for (const record of records.values()) {
		record.resourceId ??= record.id;
		if ((record.engine === 'codex' || record.engine === 'cline') && record.provisional === undefined && record.initialTitle && record.label === record.initialTitle) {
			record.provisional = true;
		}
	}
	let secretaryState = context.globalState.get<SecretaryState>('secretaryState');

	const runtimes = new Map<string, EngineRuntime>();
	const controllers = new Map<string, vscode.ChatSessionItemController>();
	const busy = new Set<string>();
	const activeTurns = new Map<string, vscode.CancellationTokenSource>();
	const lastTurnReplies = new Map<string, string>();
	const lastTurnErrors = new Map<string, string>();
	const opened = new Map<string, { changed: vscode.EventEmitter<vscode.ChatSession['history']>; cancellation: vscode.CancellationTokenSource }>();
	const available = await Promise.all(definitions.map(async definition => ({ ...definition, command: await findExecutable(definition.executable) })));

	const key = (engine: string, id: string) => `${engine}:${id}`;
	const identity = (record: RecordEntry) => key(record.engine, record.resourceId ?? record.id);
	const resource = (record: RecordEntry) => vscode.Uri.from({ scheme: `aexus-${record.engine}`, path: `/${record.resourceId ?? record.id}` });
	const parentResource = (record: RecordEntry) => record.parentId
		? resource([...records.values()].find(parent => parent.engine === record.engine && parent.id === record.parentId) ?? { ...record, id: record.parentId, resourceId: record.parentId })
		: undefined;
	const describe = (record: RecordEntry) => ({
		engineId: `aexus-${record.engine}`,
		resource: resource(record),
		parentResource: parentResource(record),
		projectUri: vscode.Uri.file(record.cwd),
		label: record.label,
		updated: record.updated,
		nativeId: record.id,
		provisional: Boolean(record.provisional),
	});
	const save = async () => {
		await context.globalState.update('nativeSessions', Object.fromEntries(records));
		await context.globalState.update('secretaryState', secretaryState);
	};

	// eslint-disable-next-line prefer-const
	let secretaryController: vscode.ChatSessionItemController | undefined;
	const refreshSecretaryItem = () => {
		if (!secretaryController) { return; }
		const record = secretaryState ? records.get(secretaryState.recordKey) : undefined;
		const secBusy = record ? busy.has(identity(record)) : false;
		const engineDef = available.find(entry => entry.id === secretaryState?.engine);
		const secItem = secretaryController.createChatSessionItem(SECRETARY_URI, 'Secretary');
		secItem.description = engineDef?.name ?? 'Secretary';
		secItem.metadata = {
			workingDirectoryPath: record?.cwd ?? os.homedir(),
			nativeSessionId: record?.id ?? 'secretary',
			provisional: record?.provisional ?? true,
			secretaryEngine: secretaryState?.engine ? `aexus-${secretaryState.engine}` : undefined,
		};
		secItem.timing = { created: record?.created ?? Date.now(), lastRequestEnded: secBusy ? undefined : (record?.updated ?? Date.now()) };
		secItem.status = secBusy ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
		secretaryController.items.replace([secItem]);
	};
	secretaryController = vscode.chat.createChatSessionItemController(SECRETARY_TYPE, async () => refreshSecretaryItem());

	const resolveShortEngine = (raw?: string): string | undefined => {
		if (raw) {
			const normalized = raw.trim().toLowerCase();
			const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
			const match = available.find(entry => entry.id === aliased && entry.command);
			if (match) { return match.id; }
		}
		return available.find(entry => entry.command)?.id;
	};

	const accept = (engine: string, session: NativeSession): RecordEntry => {
		const sessionKey = key(engine, session.id);
		const existing = records.get(sessionKey) ?? [...records.values()].find(record => record.engine === engine && record.id === session.id);
		if (existing) {
			const label = existing.customLabel ? existing.label : session.label;
			if (!existing.customLabel && session.label !== existing.initialTitle) { existing.initialTitle = undefined; }
			Object.assign(existing, session, { label, provisional: session.provisional ?? existing.provisional });
			return existing;
		}
		const record: RecordEntry = { ...session, engine };
		records.set(sessionKey, record);
		return record;
	};

	const item = (record: RecordEntry): vscode.ChatSessionItem => {
		const result = controllers.get(record.engine)!.createChatSessionItem(resource(record), record.label);
		result.description = record.cwd;
		result.metadata = {
			workingDirectoryPath: record.cwd,
			nativeSessionId: record.id,
			provisional: record.provisional ?? false,
			aexusParentSessionResource: parentResource(record)?.toString(),
			aexusSessionReadOnly: record.readOnly ?? false,
		};
		result.timing = { created: record.created, lastRequestEnded: busy.has(identity(record)) ? undefined : record.updated };
		result.status = busy.has(identity(record)) ? vscode.ChatSessionStatus.InProgress : vscode.ChatSessionStatus.Completed;
		return result;
	};

	const refresh = (engine: string) => {
		const controller = controllers.get(engine);
		if (controller) {
			controller.items.replace([...records.values()].filter(record => record.engine === engine).map(item));
		}
		if (secretaryState?.engine === engine) {
			refreshSecretaryItem();
		}
	};

	const runtime = (engine: string): EngineRuntime => {
		const definition = available.find(entry => entry.id === engine);
		if (!definition?.command) {
			throw new Error(vscode.l10n.t('{0} is not installed. Configure ADE CLI Paths or install the engine first.', definition?.name ?? engine));
		}
		let result = runtimes.get(engine);
		if (!result) {
			result = definition.create(definition.command);
			runtimes.set(engine, result);
			context.subscriptions.push(result);
			if (result.onDidChangeSessions) {
				context.subscriptions.push(result.onDidChangeSessions(sessions => {
					const controller = controllers.get(engine);
					for (const session of sessions) {
						const record = accept(engine, session);
						if (controller) { controller.items.add(item(record)); }
						void publishHistory(record).catch(error => console.warn(error));
					}
					void save();
				}));
			}
		}
		return result;
	};

	const ensureSecretaryRecord = async (preferredEngine?: string, preferredProject?: vscode.Uri, forceNew = false): Promise<RecordEntry> => {
		const targetEngine = resolveShortEngine(preferredEngine ?? secretaryState?.engine);
		if (!targetEngine) {
			throw new Error(vscode.l10n.t('No Coding Agent CLI is installed. Install Claude Code, Codex, Kilo, OpenCode, DSH, Antigravity, Cline, or Pi first.'));
		}
		if (!forceNew && secretaryState && secretaryState.engine === targetEngine) {
			const existing = records.get(secretaryState.recordKey);
			if (existing) {
				if (preferredProject?.scheme === 'file') {
					existing.cwd = preferredProject.fsPath;
				}
				return existing;
			}
		}
		const cwd = preferredProject?.scheme === 'file'
			? preferredProject.fsPath
			: (vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file' ? vscode.workspace.workspaceFolders[0].uri.fsPath : os.homedir());
		const native = await runtime(targetEngine).create(cwd);
		const recordKey = key(targetEngine, native.id);
		const record: RecordEntry = {
			...native,
			engine: targetEngine,
			label: 'Secretary',
			customLabel: true,
			resourceId: native.id,
		};
		records.set(recordKey, record);
		secretaryState = { engine: targetEngine, recordKey };
		await save();
		refreshSecretaryItem();
		const secOpened = opened.get(SECRETARY_TYPE);
		if (secOpened) {
			secOpened.changed.fire([]);
		}
		return record;
	};

	const list = async (engine: string, token: vscode.CancellationToken): Promise<RecordEntry[]> => {
		for (const session of await runtime(engine).list(token)) {
			accept(engine, session);
		}
		refresh(engine);
		return [...records.values()].filter(record => record.engine === engine).sort((a, b) => b.updated - a.updated);
	};

	const findCachedRecord = (uri: vscode.Uri): RecordEntry | undefined => {
		if (uri.scheme === SECRETARY_TYPE) {
			return secretaryState ? records.get(secretaryState.recordKey) : undefined;
		}
		const engine = uri.scheme.slice('aexus-'.length);
		const id = uri.path.slice(1);
		return records.get(key(engine, id)) ?? [...records.values()].find(entry => entry.engine === engine && (entry.resourceId === id || entry.id === id));
	};

	const getRecord = async (uri: vscode.Uri, token: vscode.CancellationToken): Promise<RecordEntry> => {
		if (uri.scheme === SECRETARY_TYPE) {
			return ensureSecretaryRecord();
		}
		const engine = uri.scheme.slice('aexus-'.length);
		const id = uri.path.slice(1);
		let record = findCachedRecord(uri);
		if (!record) {
			record = (await list(engine, token)).find(entry => entry.id === id || entry.resourceId === id);
		}
		if (!record) { throw new Error(vscode.l10n.t('This engine conversation is no longer available.')); }
		return record;
	};

	const history = (turns: HistoryEntry[], participant: string): readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] => turns.filter(turn => turn.text).map(turn => turn.role === 'user'
		? new vscode.ChatRequestTurn2(turn.text, undefined, [], participant, [], undefined, turn.id, undefined, undefined, turn.isSystemInitiated)
		: new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(turn.text)], {}, participant));

	const publishHistory = async (record: RecordEntry): Promise<void> => {
		const entry = opened.get(identity(record));
		if (entry && !busy.has(identity(record))) {
			const turns = await runtime(record.engine).history(record, entry.cancellation.token);
			if (opened.get(identity(record)) === entry) {
				entry.changed.fire(history(turns, `aexus-${record.engine}`));
			}
		}
		if (secretaryState && records.get(secretaryState.recordKey) === record) {
			const secEntry = opened.get(SECRETARY_TYPE);
			if (secEntry && !busy.has(identity(record))) {
				const turns = await runtime(record.engine).history(record, secEntry.cancellation.token);
				if (opened.get(SECRETARY_TYPE) === secEntry) {
					secEntry.changed.fire(history(turns, SECRETARY_TYPE));
				}
			}
		}
	};

	const handleDirectSlashCommand = async (
		cmd: string,
		argText: string,
		record: RecordEntry,
		isSecretary: boolean,
		stream: vscode.ChatResponseStream,
	): Promise<boolean> => {
		const engineDef = available.find(entry => entry.id === record.engine);
		const engineName = engineDef?.name ?? record.engine;

		if (cmd === 'help') {
			const discovered = await discoverCustomCommandsAndSkills(record.cwd);
			stream.markdown(buildSlashHelpMarkdown(isSecretary, engineName, discovered));
			return true;
		}

		if (cmd === 'skills') {
			const discovered = await discoverCustomCommandsAndSkills(record.cwd);
			if (discovered.length === 0) {
				stream.markdown(`No custom commands or skills found in \`${record.cwd}\` (\`.claude/commands\`, \`.agents/skills\`) or \`~/.claude/commands\`.`);
			} else {
				stream.markdown([
					`### Discovered Commands & Skills (${discovered.length})`,
					...discovered.map(s => `- \`${s.name}\` — *${s.source}*`),
				].join('\n'));
			}
			return true;
		}

		if (cmd === 'clear' || (isSecretary && cmd === 'reset')) {
			if (isSecretary) {
				const rotated = await ensureSecretaryRecord(record.engine, vscode.Uri.file(record.cwd), true);
				await Promise.resolve(vscode.commands.executeCommand('aexus.ade.control.execute', {
					action: 'secretary.configure',
					params: { engine: `aexus-${rotated.engine}`, resource: SECRETARY_URI.toString(), open: false },
				})).catch(() => undefined);
				stream.markdown(`Secretary context has been reset (**${engineName}**).`);
			} else {
				const fresh = await runtime(record.engine).create(record.cwd);
				Object.assign(record, fresh, { label: record.label, customLabel: record.customLabel, resourceId: record.resourceId ?? record.id });
				await save();
				const openEntry = opened.get(identity(record));
				openEntry?.changed.fire([]);
				stream.markdown(`Conversation context cleared (**${engineName}**).`);
			}
			return true;
		}

		if (!isSecretary) {
			return false;
		}

		if (cmd === 'status') {
			const status = await vscode.commands.executeCommand<Record<string, unknown>>('aexus.ade.control.execute', { action: 'status' });
			stream.markdown(`### ADE Live Status\n\`\`\`json\n${JSON.stringify(status, null, 2)}\n\`\`\``);
			return true;
		}

		if (cmd === 'focus') {
			if (!argText) {
				const listRes = await vscode.commands.executeCommand<{ name: string; path: string; focused: boolean }[]>('aexus.ade.control.execute', { action: 'project.list' });
				stream.markdown([
					'Usage: `/focus <project-name-or-path>`',
					'',
					...(listRes ?? []).map(p => `- **${p.name}** (\`${p.path}\`)${p.focused ? ' *(Focused)*' : ''}`),
				].join('\n'));
				return true;
			}
			const nav = await vscode.commands.executeCommand<{ focusedProject?: { name: string; path: string } }>('aexus.ade.control.execute', {
				action: 'project.focus',
				params: { target: argText },
			});
			stream.markdown(`Focused project: **${nav?.focusedProject?.name ?? argText}** (\`${nav?.focusedProject?.path ?? ''}\`).`);
			return true;
		}

		if (cmd === 'home') {
			await vscode.commands.executeCommand('aexus.ade.control.execute', { action: 'project.home' });
			stream.markdown('Returned to **ADE Home** (all projects overview).');
			return true;
		}

		if (cmd === 'projects') {
			const listRes = await vscode.commands.executeCommand<{ name: string; path: string; focused: boolean; selected: boolean; activeSessionCount: number }[]>('aexus.ade.control.execute', { action: 'project.list' });
			if (!listRes?.length) {
				stream.markdown('No ADE projects registered.');
			} else {
				stream.markdown([
					`### ADE Projects (${listRes.length})`,
					...listRes.map(p => `- **${p.name}** (\`${p.path}\`) — ${p.activeSessionCount} active session(s)${p.focused ? ' *(Focused)*' : p.selected ? ' *(Selected)*' : ''}`),
				].join('\n'));
			}
			return true;
		}

		if (cmd === 'sessions') {
			const sessionsRes = await vscode.commands.executeCommand<{ id: string; label: string; rank: string; engineName?: string; projectName: string; status: string; parentId?: string }[]>('aexus.ade.control.execute', { action: 'session.list' });
			if (!sessionsRes?.length) {
				stream.markdown('No active ADE sessions.');
			} else {
				stream.markdown([
					`### Active ADE Sessions (${sessionsRes.length})`,
					...sessionsRes.map(s => `- **[${s.rank.toUpperCase()}]** **${s.label}** (\`${s.id}\`) — ${s.engineName ?? 'Draft'} in **${s.projectName}** *(status: ${s.status}${s.parentId ? `, supervisor: ${s.parentId}` : ''})*`),
				].join('\n'));
			}
			return true;
		}

		if (cmd === 'engineering') {
			const trees = await vscode.commands.executeCommand<{ governorSessionId: string; governorLabel: string; projectName: string; runStatus: string; completedNodes: number; totalNodes: number; managerCount: number }[]>('aexus.ade.control.execute', { action: 'engineering.list' });
			if (!trees?.length) {
				stream.markdown('No ADE Engineering trees initialized yet.');
			} else {
				stream.markdown([
					`### ADE Engineering Trees (${trees.length})`,
					...trees.map(t => `- **${t.governorLabel}** (\`${t.governorSessionId}\`) in **${t.projectName}** — status: \`${t.runStatus}\`, progress: **${t.completedNodes}/${t.totalNodes}** nodes (${t.managerCount} Manager segments)`),
				].join('\n'));
			}
			return true;
		}

		if (cmd === 'inbox') {
			const items = await vscode.commands.executeCommand<{ id: string; kind: string; title: string; message: string; unread: boolean; resolved: boolean }[]>('aexus.ade.control.execute', { action: 'inbox.list', params: { includeResolved: false } });
			if (!items?.length) {
				stream.markdown('ADE Inbox has no pending items.');
			} else {
				stream.markdown([
					`### Pending ADE Inbox Items (${items.length})`,
					...items.map(it => `- **[${it.kind.toUpperCase()}]** **${it.title}** (\`${it.id}\`${it.unread ? ' · *UNREAD*' : ''})\n  ${it.message.split('\n')[0]}`),
				].join('\n'));
			}
			return true;
		}

		if (cmd === 'ide') {
			stream.markdown('Secretary operates strictly within **ADE** and does not switch to or manipulate **IDE** mode.');
			return true;
		}

		if (cmd === 'ade') {
			await vscode.commands.executeCommand('aexus.ade.control.execute', { action: 'mode.set', params: { mode: 'ade' } });
			stream.markdown('Active in **ADE** mode.');
			return true;
		}

		if (cmd === 'engine') {
			if (!argText) {
				const installed = available.filter(entry => entry.command);
				stream.markdown([
					`Current Secretary engine: **${engineName}** (\`${record.engine}\`)`,
					'',
					'Switch with `/engine <name>`. Installed engines:',
					...installed.map(e => `- \`${e.id}\` — ${e.name}${e.id === record.engine ? ' *(active)*' : ''}`),
				].join('\n'));
				return true;
			}
			const nextShort = resolveShortEngine(argText);
			const nextDef = available.find(entry => entry.id === nextShort && entry.command);
			if (!nextDef || !nextShort || nextDef.id !== (ENGINE_ALIASES[argText.trim().toLowerCase()] ?? argText.trim().toLowerCase())) {
				stream.markdown(`Unknown or uninstalled engine \`${argText}\`. Try \`/engine\` to list installed engines.`);
				return true;
			}
			await ensureSecretaryRecord(nextDef.id, vscode.Uri.file(record.cwd), true);
			await Promise.resolve(vscode.commands.executeCommand('aexus.ade.control.execute', {
				action: 'secretary.configure',
				params: { engine: nextDef.type, resource: SECRETARY_URI.toString(), open: false },
			})).catch(() => undefined);
			stream.markdown(`Switched Secretary engine to **${nextDef.name}** (\`${nextDef.id}\`).`);
			return true;
		}

		if (cmd === 'new') {
			const tokens = argText.split(/\s+/).filter(Boolean);
			const maybeEngine = tokens[0] ? ENGINE_ALIASES[tokens[0].toLowerCase()] : undefined;
			const title = (maybeEngine ? tokens.slice(1) : tokens).join(' ') || undefined;
			const created = await vscode.commands.executeCommand<{ id: string; label: string; projectName: string; engineId?: string }>('aexus.ade.control.execute', {
				action: 'session.create',
				params: {
					...(maybeEngine ? { engine: maybeEngine } : {}),
					...(title ? { title } : {}),
					open: true,
				},
			});
			stream.markdown(`Created session **${created?.label ?? 'New Session'}** in project **${created?.projectName ?? ''}**.`);
			return true;
		}

		return false;
	};

	const send = async (
		record: RecordEntry,
		sessionUri: vscode.Uri,
		isSecretary: boolean,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<vscode.ChatResult> => {
		if (record.readOnly) { throw new Error(vscode.l10n.t('Continue this subagent from its parent conversation.')); }
		const recordKey = identity(record);
		if (busy.has(recordKey)) { throw new Error(vscode.l10n.t('This conversation is already working. Stop or wait for its current response.')); }

		const trimmedPrompt = request.prompt.trim();
		let parsedCmd = request.command?.trim().toLowerCase();
		let cmdArgText = trimmedPrompt;
		if (!parsedCmd && /^\/[a-zA-Z][\w-]*(?:\s|$)/.test(trimmedPrompt)) {
			const spaceIdx = trimmedPrompt.indexOf(' ');
			parsedCmd = (spaceIdx === -1 ? trimmedPrompt.slice(1) : trimmedPrompt.slice(1, spaceIdx)).toLowerCase();
			cmdArgText = spaceIdx === -1 ? '' : trimmedPrompt.slice(spaceIdx + 1).trim();
		}

		if (parsedCmd) {
			const handledDirectly = await handleDirectSlashCommand(parsedCmd, cmdArgText, record, isSecretary, stream);
			if (handledDirectly) {
				return {};
			}
		}

		const turnCancellation = new vscode.CancellationTokenSource();
		const link = token.onCancellationRequested(() => turnCancellation.cancel());
		busy.add(recordKey);
		activeTurns.set(recordKey, turnCancellation);
		controllers.get(record.engine)?.items.add(item(record));
		if (isSecretary) {
			refreshSecretaryItem();
		}

		const effectiveUserPrompt = request.command
			? `/${request.command}${trimmedPrompt ? ` ${trimmedPrompt}` : ''}`
			: request.prompt;

		const references = request.references.flatMap(reference => reference.value instanceof vscode.Uri
			? [reference.value.fsPath]
			: reference.value instanceof vscode.Location
				? [`${reference.value.uri.fsPath}:${reference.value.range.start.line + 1}`]
				: []);
		const basePrompt = references.length ? `${effectiveUserPrompt}\n\n${vscode.l10n.t('Attached files:')}\n${references.join('\n')}` : effectiveUserPrompt;
		const injected = await Promise.resolve(vscode.commands.executeCommand<string | undefined>('aexus.ade.resolvePromptContext', sessionUri)).catch(() => undefined);
		const prompt = injected?.trim() ? `${injected.trim()}\n\n${basePrompt}` : basePrompt;

		try {
			const engine = runtime(record.engine);
			const prevId = record.id;
			if (engine.prepareSession) {
				await engine.prepareSession(record);
				if (record.id !== prevId) {
					records.delete(key(record.engine, prevId));
					records.set(key(record.engine, record.id), record);
				}
				await save();
			}
			let streamedMarkdown = '';
			let lastHeartbeatSent = 0;
			const emitHeartbeat = () => {
				const now = Date.now();
				if (now - lastHeartbeatSent >= 1500) {
					lastHeartbeatSent = now;
					void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.workerHeartbeat', sessionUri.toString(), now)).catch(() => undefined);
				}
			};
			const proxyTarget: vscode.ChatResponseStream = Object.create(null);
			const wrappedStream: vscode.ChatResponseStream = new Proxy(proxyTarget, {
				get(_dummy, prop) {
					if (prop === 'markdown') {
						return (value: string | vscode.MarkdownString) => {
							const chunkText = typeof value === 'string' ? value : value.value;
							if (chunkText) {
								streamedMarkdown += chunkText;
								emitHeartbeat();
							}
							stream.markdown(value);
						};
					}
					if (prop === 'progress') {
						return (value: string) => {
							emitHeartbeat();
							stream.progress(value);
						};
					}
					const val = Reflect.get(stream, prop, stream);
					return typeof val === 'function' ? val.bind(stream) : val;
				},
			});
			lastTurnErrors.delete(identity(record));
			if (isSecretary) {
				lastTurnErrors.delete(SECRETARY_TYPE);
			}
			const snapEntry = roleBridge.getSnapshot().agents.find(a => a.resource === sessionUri.toString());
			const callerRole = isSecretary
				? 'secretary'
				: (!snapEntry?.isOrchestrated ? undefined : snapEntry.rank);
			await engine.send(record, prompt, wrappedStream, turnCancellation.token, {
				pureWorker: !isSecretary && !snapEntry?.isOrchestrated,
				callerRole,
			});
			if (streamedMarkdown.trim()) {
				lastTurnReplies.set(identity(record), streamedMarkdown.trim());
				if (isSecretary) {
					lastTurnReplies.set(SECRETARY_TYPE, streamedMarkdown.trim());
				}
			}
			record.updated = Date.now();
			if (!isSecretary && !record.customLabel && record.initialTitle && record.label === record.initialTitle) {
				record.label = effectiveUserPrompt.split('\n')[0].slice(0, 100) || record.label;
			}
			return {};
		} catch (error) {
			if (token.isCancellationRequested || turnCancellation.token.isCancellationRequested) { return {}; }
			const errText = error instanceof Error ? error.message : String(error);
			lastTurnErrors.set(identity(record), errText);
			if (isSecretary) {
				lastTurnErrors.set(SECRETARY_TYPE, errText);
			}
			throw error;
		} finally {
			link.dispose();
			turnCancellation.dispose();
			activeTurns.delete(recordKey);
			busy.delete(recordKey);
			if (records.has(key(record.engine, record.id)) || [...records.values()].includes(record)) {
				controllers.get(record.engine)?.items.add(item(record));
			}
			if (isSecretary) {
				refreshSecretaryItem();
			}
			await save();
		}
	};

	// Register unified Secretary participant & session provider with Aexus App Icon
	const aexusAppIconUri = vscode.Uri.joinPath(context.extensionUri, 'resources/aexus-icon.svg');
	const secretaryParticipant = vscode.chat.createChatParticipant(SECRETARY_TYPE, async (request, _chatContext, stream, token) => {
		const secRecord = await ensureSecretaryRecord();
		return send(secRecord, SECRETARY_URI, true, request, stream, token);
	});
	secretaryParticipant.iconPath = { light: aexusAppIconUri, dark: aexusAppIconUri };
	secretaryController.getChatSessionInputState = () => secretaryController.createChatSessionInputState([]);
	context.subscriptions.push(
		secretaryParticipant,
		secretaryController,
		vscode.chat.registerChatSessionContentProvider(SECRETARY_TYPE, {
			provideChatSessionContent: async (_uri, token) => {
				const secRecord = await ensureSecretaryRecord();
				const turns = await runtime(secRecord.engine).history(secRecord, token);
				await save();
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(SECRETARY_TYPE, entry);
				return {
					title: 'Secretary',
					history: history(turns, SECRETARY_TYPE),
					onDidChangeHistory: entry.changed.event,
					requestHandler: async (request, _chatContext, stream, reqToken) => {
						const liveRecord = await ensureSecretaryRecord();
						return send(liveRecord, SECRETARY_URI, true, request, stream, reqToken);
					},
					dispose: () => {
						entry.cancellation.cancel();
						entry.cancellation.dispose();
						entry.changed.dispose();
						if (opened.get(SECRETARY_TYPE) === entry) { opened.delete(SECRETARY_TYPE); }
					},
				};
			},
		}, secretaryParticipant, { supportsInterruptions: true }),
	);
	refreshSecretaryItem();

	// Register all 8 Coding Agent engine participants & session providers
	for (const definition of available.filter(entry => entry.command)) {
		const participantId = definition.type;
		const participant = vscode.chat.createChatParticipant(participantId, async (request, chatContext, stream, token) => {
			if (!chatContext.chatSessionContext) { throw new Error(vscode.l10n.t('Open an ADE engine conversation first.')); }
			const uri = chatContext.chatSessionContext.chatSessionItem.resource;
			return send(await getRecord(uri, token), uri, false, request, stream, token);
		});
		participant.iconPath = definition.svgIcon
			? {
				light: vscode.Uri.joinPath(context.extensionUri, `resources/${definition.svgIcon}-light.svg`),
				dark: vscode.Uri.joinPath(context.extensionUri, `resources/${definition.svgIcon}-dark.svg`),
			}
			: new vscode.ThemeIcon(definition.themeIcon!);
		const controller = vscode.chat.createChatSessionItemController(definition.type, async () => refresh(definition.id));
		controllers.set(definition.id, controller);
		controller.getChatSessionInputState = () => controller.createChatSessionInputState([]);
		context.subscriptions.push(participant, controller, vscode.chat.registerChatSessionContentProvider(definition.type, {
			provideChatSessionContent: async (uri, token) => {
				const record = await getRecord(uri, token);
				const turns = await runtime(record.engine).history(record, token);
				await save();
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(identity(record), entry);
				return {
					title: record.label,
					history: history(turns, participantId),
					onDidChangeHistory: entry.changed.event,
					requestHandler: record.readOnly ? undefined : (request, _chatContext, stream, reqToken) => send(record, uri, false, request, stream, reqToken),
					dispose: () => {
						entry.cancellation.cancel();
						entry.cancellation.dispose();
						entry.changed.dispose();
						if (opened.get(identity(record)) === entry) { opened.delete(identity(record)); }
					},
				};
			},
		}, participant, { supportsInterruptions: true }));
		refresh(definition.id);
	}

	const deleteRecordAndDescendants = async (record: RecordEntry, token: vscode.CancellationToken, deletedKeys: Set<string>): Promise<number> => {
		const recordKey = key(record.engine, record.id);
		if (deletedKeys.has(recordKey) || recordKey === secretaryState?.recordKey) {
			return 0;
		}
		activeTurns.get(identity(record))?.cancel();
		opened.get(identity(record))?.cancellation.cancel();
		if (available.some(entry => entry.id === record.engine && entry.command)) {
			await runtime(record.engine).delete(record, token).catch(() => { });
		}
		const removedIds = new Set<string>([record.id]);
		if (record.resourceId) { removedIds.add(record.resourceId); }
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const candidate of records.values()) {
				const candidateKey = key(candidate.engine, candidate.id);
				if (candidateKey === secretaryState?.recordKey) { continue; }
				if (candidate.engine === record.engine && candidate.parentId && removedIds.has(candidate.parentId) && !removedIds.has(candidate.id)) {
					removedIds.add(candidate.id);
					if (candidate.resourceId) { removedIds.add(candidate.resourceId); }
					expanded = true;
				}
			}
		}
		let count = 0;
		const controller = controllers.get(record.engine);
		for (const [entryKey, candidate] of [...records.entries()]) {
			if (entryKey === secretaryState?.recordKey) { continue; }
			if (candidate.engine === record.engine && (removedIds.has(candidate.id) || (candidate.resourceId && removedIds.has(candidate.resourceId)))) {
				deletedKeys.add(entryKey);
				activeTurns.get(identity(candidate))?.cancel();
				opened.get(identity(candidate))?.cancellation.cancel();
				records.delete(entryKey);
				controller?.items.delete(resource(candidate));
				count++;
			}
		}
		return count;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('aexus.agentEngines.list', () => available.map(definition => ({ id: definition.type, name: definition.name, available: !!definition.command }))),
		vscode.commands.registerCommand('aexus.agentEngines.ensureSecretary', async (rawEngineId?: string, project?: vscode.Uri, forceReset?: boolean) => {
			const secRecord = await ensureSecretaryRecord(rawEngineId, project, Boolean(forceReset));
			return {
				engineId: `aexus-${secRecord.engine}`,
				resource: SECRETARY_URI,
			};
		}),
		vscode.commands.registerCommand('aexus.agentEngines.create', async (engineId: string, project: vscode.Uri) => {
			const engine = engineId.slice('aexus-'.length);
			const native = await runtime(engine).create(project.fsPath);
			const record: RecordEntry = { ...native, engine, initialTitle: native.label, resourceId: native.id };
			records.set(key(engine, native.id), record);
			await save();
			refresh(engine);
			return describe(record);
		}),
		vscode.commands.registerCommand('aexus.agentEngines.attach', async (engineId: string, nativeId: string, project?: vscode.Uri) => {
			const engine = engineId.startsWith('aexus-') ? engineId.slice('aexus-'.length) : (ENGINE_ALIASES[engineId.toLowerCase()] ?? engineId);
			const token = new vscode.CancellationTokenSource();
			try {
				const sessions = await list(engine, token.token);
				let record = sessions.find(entry => entry.id === nativeId || entry.resourceId === nativeId || entry.id.startsWith(nativeId));
				if (!record) {
					if (!project || project.scheme !== 'file') {
						throw new Error(vscode.l10n.t('Conversation {0} was not found in {1}.', nativeId, engine));
					}
					const now = Date.now();
					record = accept(engine, {
						id: nativeId,
						cwd: project.fsPath,
						label: vscode.l10n.t('{0} Session {1}', engine, nativeId.slice(0, 8)),
						created: now,
						updated: now,
						provisional: false,
					});
					record.resourceId ??= record.id;
					await save();
					refresh(engine);
				}
				return describe(record);
			} finally {
				token.dispose();
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.sessions', async (engineId: string, project?: vscode.Uri) => {
			const engine = engineId.slice('aexus-'.length);
			const token = new vscode.CancellationTokenSource();
			let sessions: RecordEntry[];
			try { sessions = await list(engine, token.token); } finally { token.dispose(); }
			const canonical = async (cwd: string) => fs.realpath(cwd).catch(() => path.resolve(cwd));
			const requested = project ? await canonical(project.fsPath) : undefined;
			const result = [];
			for (const record of sessions) {
				if (record.parentId) { continue; }
				if (!requested || requested === await canonical(record.cwd)) { result.push(describe(record)); }
			}
			return result;
		}),
		vscode.commands.registerCommand('aexus.agentEngines.children', async (uri: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const parent = await getRecord(uri, token.token);
				const children = await runtime(parent.engine).children?.(parent, token.token) ?? [];
				const result = children.map(child => accept(parent.engine, child));
				for (const child of result) { await publishHistory(child); }
				await save();
				return result.map(describe);
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.info', async (uri: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const record = await getRecord(uri, token.token);
				await save();
				return {
					projectUri: vscode.Uri.file(record.cwd),
					label: record.label,
					nativeId: record.id,
					provisional: Boolean(record.provisional),
					unmaterialized: Boolean(record.unmaterialized),
					engine: record.engine,
				};
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.history', async (uri: vscode.Uri, limit?: number) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const record = await getRecord(uri, token.token);
				const turns = await runtime(record.engine).history(record, token.token).catch(() => [] as HistoryEntry[]);
				const messages = turns.map(entry => ({ role: entry.role, text: entry.text }));
				const cachedLast = uri.scheme === SECRETARY_TYPE
					? (lastTurnReplies.get(SECRETARY_TYPE) ?? lastTurnReplies.get(identity(record)))
					: lastTurnReplies.get(identity(record));
				if (cachedLast && !messages.some(m => m.role === 'assistant' && m.text === cachedLast)) {
					messages.push({ role: 'assistant', text: cachedLast });
				}
				const cachedError = uri.scheme === SECRETARY_TYPE
					? (lastTurnErrors.get(SECRETARY_TYPE) ?? lastTurnErrors.get(identity(record)))
					: lastTurnErrors.get(identity(record));
				const slice = typeof limit === 'number' && limit > 0 ? messages.slice(-Math.floor(limit)) : messages;
				return {
					engine: record.engine,
					nativeId: record.id,
					messages: slice,
					...(cachedError ? { lastError: cachedError } : {}),
				};
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.stop', (uri: vscode.Uri) => {
			const record = findCachedRecord(uri);
			if (!record) {
				return { stopped: false };
			}
			const active = activeTurns.get(identity(record));
			if (active) {
				active.cancel();
				return { stopped: true };
			}
			return { stopped: false };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.killSession', async (uri: vscode.Uri) => {
			const record = findCachedRecord(uri);
			if (!record) {
				return { killed: false };
			}
			activeTurns.get(identity(record))?.cancel();
			activeTurns.delete(identity(record));
			busy.delete(identity(record));
			if (available.some(entry => entry.id === record.engine && entry.command)) {
				await runtime(record.engine).killSession?.(record).catch(() => undefined);
			}
			controllers.get(record.engine)?.items.add(item(record));
			return { killed: true };
		}),
		vscode.commands.registerCommand('aexus.agentEngines.listConfiguredModels', async (): Promise<Record<string, readonly { readonly id: string; readonly label: string }[]>> => {
			const out: Record<string, readonly { readonly id: string; readonly label: string }[]> = {};
			try {
				const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
				const raw = JSON.parse(await fs.readFile(path.join(claudeConfigDir, 'settings.json'), 'utf8')) as {
					model?: unknown;
					modelPicker?: { options?: Array<{ model?: unknown; label?: unknown }> };
				};
				const listModels: { id: string; label: string }[] = [];
				const seen = new Set<string>();
				const add = (idRaw: unknown, labelRaw?: unknown) => {
					const id = typeof idRaw === 'string' ? idRaw.trim() : '';
					if (!id || seen.has(id)) { return; }
					seen.add(id);
					const label = typeof labelRaw === 'string' && labelRaw.trim() ? `${labelRaw.trim()} (${id})` : id;
					listModels.push({ id, label });
				};
				if (Array.isArray(raw.modelPicker?.options)) {
					for (const opt of raw.modelPicker.options) {
						add(opt?.model, opt?.label);
					}
				}
				add(raw.model);
				if (listModels.length > 0) {
					out['claude-code'] = listModels;
				}
			} catch { /* ignore */ }

			try {
				const codexToml = await fs.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
				const match = codexToml.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
				if (match?.[1]?.trim()) {
					out.codex = [{ id: match[1].trim(), label: match[1].trim() }];
				}
			} catch { /* ignore */ }

			return out;
		}),
		vscode.commands.registerCommand('aexus.agentEngines.dispatchEngineeringTurn', async (
			uri: vscode.Uri,
			rawPrompt: string,
			rawOptions?: {
				agentId?: string;
				model?: string;
				thinking?: EngineThinkingLevel;
				pureWorker?: boolean;
				callerRole?: string;
			},
		) => {
			const lookupToken = new vscode.CancellationTokenSource();
			let record: RecordEntry;
			try {
				record = await getRecord(uri, lookupToken.token);
			} finally {
				lookupToken.dispose();
			}

			const recordKey = identity(record);
			if (busy.has(recordKey)) {
				activeTurns.get(recordKey)?.cancel();
				await new Promise(resolve => setTimeout(resolve, 120));
			}

			const turnCancellation = new vscode.CancellationTokenSource();
			busy.add(recordKey);
			activeTurns.set(recordKey, turnCancellation);
			controllers.get(record.engine)?.items.add(item(record));

			const isPureWorker = Boolean(rawOptions?.pureWorker);
			let finalPrompt = rawPrompt;
			let callerRole: string | undefined;
			if (!isPureWorker) {
				const injected = await Promise.resolve(vscode.commands.executeCommand<string | undefined>(
					'aexus.ade.resolvePromptContext',
					rawOptions?.agentId ? { agentId: rawOptions.agentId, resource: uri } : uri,
				)).catch(() => undefined);
				if (injected?.trim()) {
					finalPrompt = `${injected.trim()}\n\n${rawPrompt}`;
				}
				const snapEntry = roleBridge.getSnapshot().agents.find(a => a.id === rawOptions?.agentId || a.resource === uri.toString());
				callerRole = rawOptions?.callerRole ?? snapEntry?.rank;
			}

			let streamedMarkdown = '';
			let lastHeartbeatSent = 0;
			const emitHeartbeat = () => {
				const now = Date.now();
				if (now - lastHeartbeatSent >= 1000) {
					lastHeartbeatSent = now;
					void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.workerHeartbeat', uri.toString(), now)).catch(() => undefined);
				}
			};

			const headlessStreamTarget: vscode.ChatResponseStream = Object.create(null);
			const headlessStream: vscode.ChatResponseStream = new Proxy(headlessStreamTarget, {
				get(_dummy, prop) {
					if (prop === 'markdown') {
						return (value: string | vscode.MarkdownString) => {
							const textChunk = typeof value === 'string' ? value : value.value;
							if (textChunk) {
								streamedMarkdown += textChunk;
								emitHeartbeat();
							}
						};
					}
					if (prop === 'progress') {
						return () => {
							emitHeartbeat();
						};
					}
					return () => { };
				},
			});

			try {
				const engine = runtime(record.engine);
				const prevId = record.id;
				if (engine.prepareSession) {
					await engine.prepareSession(record);
					if (record.id !== prevId) {
						records.delete(key(record.engine, prevId));
						records.set(key(record.engine, record.id), record);
					}
					await save();
				}
				lastTurnErrors.delete(recordKey);
				await engine.send(record, finalPrompt, headlessStream, turnCancellation.token, {
					model: rawOptions?.model,
					thinking: rawOptions?.thinking,
					pureWorker: isPureWorker,
					callerRole,
					automatedEngineering: true,
				});
				if (streamedMarkdown.trim()) {
					lastTurnReplies.set(identity(record), streamedMarkdown.trim());
				}
				record.updated = Date.now();
				return {
					reply: streamedMarkdown.trim(),
					nativeId: record.id,
					stopped: turnCancellation.token.isCancellationRequested,
				};
			} catch (error) {
				if (turnCancellation.token.isCancellationRequested) {
					return { reply: streamedMarkdown.trim(), nativeId: record.id, stopped: true };
				}
				const errText = error instanceof Error ? error.message : String(error);
				lastTurnErrors.set(identity(record), errText);
				throw error;
			} finally {
				turnCancellation.dispose();
				activeTurns.delete(recordKey);
				busy.delete(recordKey);
				if (records.has(key(record.engine, record.id)) || [...records.values()].includes(record)) {
					controllers.get(record.engine)?.items.add(item(record));
				}
				await publishHistory(record).catch(() => undefined);
				await save();
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.delete', async (uri: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				let record: RecordEntry | undefined = findCachedRecord(uri);
				if (!record) {
					record = await getRecord(uri, token.token).catch(() => undefined);
				}
				if (!record) {
					return true;
				}
				await deleteRecordAndDescendants(record, token.token, new Set<string>());
				await save();
				return true;
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.deleteProjectSessions', async (project: vscode.Uri) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const canonical = async (cwd: string) => fs.realpath(cwd).catch(() => path.resolve(cwd));
				const targetCwd = await canonical(project.fsPath);
				await Promise.allSettled(
					available
						.filter(entry => entry.command)
						.map(entry => Promise.race([
							list(entry.id, token.token).catch(() => []),
							new Promise<RecordEntry[]>(resolve => setTimeout(() => resolve([]), 3000)),
						])),
				);
				const matching: RecordEntry[] = [];
				for (const candidate of records.values()) {
					if (key(candidate.engine, candidate.id) === secretaryState?.recordKey) { continue; }
					if (await canonical(candidate.cwd) === targetCwd) {
						matching.push(candidate);
					}
				}
				const deletedKeys = new Set<string>();
				let deletedCount = 0;
				for (const candidate of matching) {
					deletedCount += await deleteRecordAndDescendants(candidate, token.token, deletedKeys);
				}
				if (deletedCount > 0) {
					await save();
				}
				return deletedCount;
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.rename', async (uri: vscode.Uri, label: string) => {
			const record = findCachedRecord(uri);
			if (!record) { return; }
			record.label = label;
			record.customLabel = true;
			record.initialTitle = undefined;
			const controller = controllers.get(record.engine);
			if (controller) { controller.items.add(item(record)); }
			await save();
		}),
	);

	const bindNativeRecord = (agentResource: string | undefined, realNativeId: string) => {
		if (!agentResource || !realNativeId) { return; }
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(agentResource);
		} catch {
			return;
		}
		const record = findCachedRecord(uri);
		if (!record) { return; }
		if (record.id === realNativeId && !record.provisional && !record.unmaterialized) { return; }

		const oldKey = key(record.engine, record.id);
		const nextKey = key(record.engine, realNativeId);
		const existingReal = records.get(nextKey);
		record.resourceId ??= record.id;
		if (existingReal && existingReal !== record) {
			record.file ??= existingReal.file;
			record.created ||= existingReal.created;
			record.updated = Math.max(record.updated, existingReal.updated);
		}
		if (oldKey !== nextKey && records.get(oldKey) === record) {
			records.delete(oldKey);
		}
		record.id = realNativeId;
		record.provisional = false;
		record.unmaterialized = false;
		records.set(nextKey, record);
		controllers.get(record.engine)?.items.add(item(record));
		void save();
	};

	const enrichRoleSnapshot = async (raw: RoleSyncSnapshot): Promise<RoleSyncSnapshot> => {
		const [agyBindings, externalBindings] = await Promise.all([
			roleBridge.readAgyBindings(),
			roleBridge.readExternalNativeBindings(),
		]);
		const agyAgentToConv = new Map<string, string>();
		for (const [conversationId, agentId] of Object.entries(agyBindings)) {
			agyAgentToConv.set(agentId, conversationId);
		}
		const externalByKey = new Map<string, string>();
		for (const binding of externalBindings) {
			externalByKey.set(`${binding.shortEngine}:${binding.agentId}`, binding.nativeSessionId);
		}
		return {
			...raw,
			agents: raw.agents.map(entry => {
				let nativeSessionId = entry.nativeSessionId;
				if (!nativeSessionId && entry.resource) {
					try {
						const record = findCachedRecord(vscode.Uri.parse(entry.resource));
						if (record && !record.provisional && !record.unmaterialized) {
							nativeSessionId = record.id;
						}
					} catch { /* Ignore invalid resource URI. */ }
				}
				if (entry.engineId?.startsWith('aexus-')) {
					const shortEngine = entry.engineId.slice('aexus-'.length);
					const extNativeId = externalByKey.get(`${shortEngine}:${entry.id}`);
					if (extNativeId) {
						nativeSessionId ??= extNativeId;
						if (entry.resource) {
							bindNativeRecord(entry.resource, extNativeId);
						}
					}
				}
				if (entry.engineId === 'aexus-antigravity') {
					const agyConvId = agyAgentToConv.get(entry.id);
					if (agyConvId) {
						nativeSessionId ??= agyConvId;
						if (entry.resource) {
							bindNativeRecord(entry.resource, agyConvId);
						}
					}
				}
				return nativeSessionId ? { ...entry, nativeSessionId } : entry;
			}),
		};
	};

	roleBridge.setOnNativeSessionBound((_shortEngine, agentId, realNativeId) => {
		const agent = roleBridge.getSnapshot().agents.find(entry => entry.id === agentId);
		if (agent?.resource) {
			bindNativeRecord(agent.resource, realNativeId);
		}
	});

	const syncExternalBindingsIntoSnapshot = async () => {
		const current = roleBridge.getSnapshot();
		if (!current.agents.length) {
			return;
		}
		const enriched = await enrichRoleSnapshot(current);
		const changed = enriched.agents.some((entry, idx) => entry.nativeSessionId !== current.agents[idx]?.nativeSessionId);
		if (changed) {
			await roleBridge.updateSnapshot(enriched);
		}
	};

	const bindingSyncTimer = setInterval(() => {
		void syncExternalBindingsIntoSnapshot();
	}, 1000);
	bindingSyncTimer.unref?.();

	context.subscriptions.push(
		{
			dispose: () => {
				clearInterval(bindingSyncTimer);
				roleBridge.dispose();
			},
		},
		vscode.commands.registerCommand('aexus.agentEngines.syncRoleContext', async (rawSnapshot?: RoleSyncSnapshot) => {
			if (!rawSnapshot || typeof rawSnapshot !== 'object' || !Array.isArray(rawSnapshot.agents)) {
				return;
			}
			await roleBridge.updateSnapshot(await enrichRoleSnapshot(rawSnapshot));
		}),
	);

	void Promise.resolve(vscode.commands.executeCommand<RoleSyncSnapshot>('aexus.ade.getRoleSyncSnapshot'))
		.then(async initialSnapshot => {
			if (initialSnapshot && typeof initialSnapshot === 'object' && Array.isArray(initialSnapshot.agents)) {
				await roleBridge.updateSnapshot(await enrichRoleSnapshot(initialSnapshot));
			}
		})
		.catch(() => undefined);
}
