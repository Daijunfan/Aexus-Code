/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { AntigravityRuntime, ClineRuntime, DshRuntime } from './acp';
import {
	buildOptionGroupsForSession,
	DiscoveredOptionGroup,
	DiscoveredSlashCommand,
	discoverCustomizationFiles,
	discoverEngineModels,
	discoverSlashCommands,
	EngineId,
	readSkillOrCommandTemplate,
	SessionConfigState,
} from './capabilities';
import { ClaudeRuntime } from './claude';
import { CodexRuntime } from './codex';
import { KiloRuntime, OpenCodeRuntime } from './kilo';
import { installNativeRoleBridge } from './nativeRoleBridge';
import { PiRuntime } from './pi';
import {
	AEXUS_PREAMBLE_END_MARKER,
	filterAndCleanHistoryTurns,
	ROLE_INIT_MARKER,
	RoleSyncSnapshot,
} from './roleBridgeShared';
import {
	ENGINE_INSTALL_GUIDES,
	EngineAttachment,
	EngineRuntime,
	EngineRuntimeCapabilities,
	EngineSendOptions,
	EngineThinkingLevel,
	EngineTurnTokenUsage,
	findExecutable,
	HistoryEntry,
	NativeSession,
	setCliBinDirectory,
} from './runtime';

const execFileAsync = promisify(cp.execFile);
const roleBridge = installNativeRoleBridge({ distDir: __dirname });

interface RoleInitState {
	rank: string;
	engine: string;
	initializedAt: number;
}

interface RecordEntry extends NativeSession {
	engine: string;
	initialTitle?: string;
	customLabel?: boolean;
	resourceId?: string;
	sessionConfig?: SessionConfigState;
	activeGoal?: string;
	roleInit?: RoleInitState;
	cloudProjectUri?: string;
}

const CLOUD_PROJECT_SCHEME = 'aexus-ssh';

function sanitizeCloudWorkspaceSegment(raw: string): string {
	const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
	return cleaned || 'root';
}

function computeCloudBridgeDirectory(projectUri: vscode.Uri): string {
	const rawPath = projectUri.path || '/';
	const tailSlug = sanitizeCloudWorkspaceSegment(path.posix.basename(rawPath) || 'root').slice(0, 48);
	const pathHash = crypto.createHash('sha256').update(rawPath).digest('hex').slice(0, 12);
	return path.join(
		os.homedir(),
		'.aexus-code',
		'cloud-workspaces',
		sanitizeCloudWorkspaceSegment(projectUri.authority).slice(0, 64),
		`${tailSlug}-${pathHash}`,
	);
}

async function resolveProjectLocalCwd(projectUri: vscode.Uri): Promise<{ localCwd: string; cloudProjectUri?: string }> {
	if (projectUri.scheme === CLOUD_PROJECT_SCHEME) {
		const localCwd = computeCloudBridgeDirectory(projectUri);
		await fs.mkdir(localCwd, { recursive: true });
		return {
			localCwd,
			cloudProjectUri: projectUri.with({ path: projectUri.path.replace(/\/+$/, '') || '/' }).toString(),
		};
	}
	return { localCwd: projectUri.fsPath };
}

function recordProjectUri(record: RecordEntry): vscode.Uri {
	return record.cloudProjectUri ? vscode.Uri.parse(record.cloudProjectUri) : vscode.Uri.file(record.cwd);
}

function formatRecordProjectLabel(record: RecordEntry): string {
	if (record.cloudProjectUri) {
		const parsed = vscode.Uri.parse(record.cloudProjectUri);
		return `${parsed.authority}:${parsed.path || '/'}`;
	}
	return record.cwd;
}

interface SecretaryState {
	engine: string;
	recordKey: string;
	perEngineConfig?: Record<string, SessionConfigState>;
}

interface EngineDefinition {
	readonly id: string;
	readonly executable: string;
	readonly name: string;
	readonly type: EngineId;
	readonly themeIcon?: string;
	readonly svgIcon?: string;
	readonly create: (command: string) => EngineRuntime;
}

const SECRETARY_TYPE = 'aexus-secretary';
const SECRETARY_URI = vscode.Uri.from({ scheme: SECRETARY_TYPE, path: '/main' });
const GOAL_COMPLETE_MARKER = '<!-- GOAL_COMPLETE -->';
const ROLE_INIT_ACK = 'ADE_ROLE_READY';
const MAX_GOAL_ROUNDS = 6;

const ENGINE_ALIASES: Record<string, string> = {
	codex: 'codex',
	'aexus-codex': 'codex',
	claude: 'claude',
	'claude-code': 'claude',
	'aexus-claude': 'claude',
	kilo: 'kilo',
	kilocode: 'kilo',
	'kilo-code': 'kilo',
	'aexus-kilo': 'kilo',
	opencode: 'opencode',
	'aexus-opencode': 'opencode',
	dsh: 'dsh',
	deepseek: 'dsh',
	'deepseek-harness': 'dsh',
	'aexus-dsh': 'dsh',
	agy: 'antigravity',
	antigravity: 'antigravity',
	'google-antigravity': 'antigravity',
	'aexus-antigravity': 'antigravity',
	cline: 'cline',
	'aexus-cline': 'cline',
	pi: 'pi',
	'aexus-pi': 'pi',
};

const definitions: readonly EngineDefinition[] = [
	{ id: 'claude', executable: 'claude', name: 'Claude Code', type: 'aexus-claude', themeIcon: 'claude', svgIcon: 'claude', create: command => new ClaudeRuntime(command) },
	{ id: 'codex', executable: 'codex', name: 'Codex', type: 'aexus-codex', themeIcon: 'openai', svgIcon: 'codex', create: command => new CodexRuntime(command) },
	{ id: 'kilo', executable: 'kilo', name: 'Kilo Code', type: 'aexus-kilo', svgIcon: 'kilo', create: command => new KiloRuntime(command) },
	{ id: 'opencode', executable: 'opencode', name: 'OpenCode', type: 'aexus-opencode', svgIcon: 'opencode', create: command => new OpenCodeRuntime(command) },
	{ id: 'dsh', executable: 'dsh', name: 'DeepSeek Harness', type: 'aexus-dsh', svgIcon: 'dsh', create: command => new DshRuntime(command) },
	{ id: 'antigravity', executable: 'agy', name: 'Google Antigravity', type: 'aexus-antigravity', svgIcon: 'antigravity', create: command => new AntigravityRuntime(command) },
	{ id: 'cline', executable: 'cline', name: 'Cline', type: 'aexus-cline', svgIcon: 'cline', create: command => new ClineRuntime(command) },
	{ id: 'pi', executable: 'pi', name: 'Pi', type: 'aexus-pi', svgIcon: 'pi', create: command => new PiRuntime(command) },
];

const OPTION_GROUP_ICONS: Record<string, string> = {
	engine: 'server-process',
	model: 'sparkle',
	thinking: 'lightbulb',
	mode: 'layers',
	permissions: 'shield',
	sandbox: 'lock',
	webSearch: 'globe',
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

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

function toEngineType(shortOrFull: string): EngineId {
	const normalized = shortOrFull.startsWith('aexus-') ? shortOrFull : `aexus-${shortOrFull}`;
	const found = definitions.find(d => d.type === normalized);
	return found ? found.type : 'aexus-claude';
}

function toVsCodeOptionGroups(discovered: readonly DiscoveredOptionGroup[], sessionType: string): vscode.ChatSessionProviderOptionGroup[] {
	return discovered.map(group => {
		const iconId = OPTION_GROUP_ICONS[group.id];
		const items: vscode.ChatSessionProviderOptionItem[] = group.items.map(opt => ({
			id: opt.id,
			name: opt.name,
			description: opt.description,
			slashCommand: opt.slashCommand,
			tooltip: opt.tooltip ?? opt.description,
			...(iconId ? { icon: new vscode.ThemeIcon(iconId) } : {}),
		}));
		const selected = items.find(i => i.id === group.selectedId) ?? items[0];
		return {
			id: group.id,
			name: group.name,
			description: group.description,
			icon: iconId ? new vscode.ThemeIcon(iconId) : undefined,
			items,
			selected,
			...(group.id === 'model' ? {
				commands: [{
					command: 'aexus.agents.selectCustomModel',
					title: vscode.l10n.t('Enter Custom Model ID…'),
					tooltip: vscode.l10n.t('Enter any custom model identifier supported by the active engine'),
					arguments: [sessionType],
				}],
			} : {}),
		};
	});
}

function toSessionOptionsRecord(groups: readonly vscode.ChatSessionProviderOptionGroup[]): Record<string, vscode.ChatSessionProviderOptionItem> {
	const out: Record<string, vscode.ChatSessionProviderOptionItem> = {};
	for (const group of groups) {
		const selected = group.selected ?? group.items[0];
		if (selected) {
			out[group.id] = selected;
		}
	}
	return out;
}

function toSendOptions(cfg: SessionConfigState | undefined, extra: { pureWorker?: boolean; callerRole?: string; automatedEngineering?: boolean; attachments?: readonly EngineAttachment[] }): EngineSendOptions {
	return {
		model: cfg?.model && cfg.model !== 'default' ? cfg.model : undefined,
		thinking: cfg?.thinking && cfg.thinking !== 'default' ? cfg.thinking : undefined,
		mode: cfg?.mode && cfg.mode !== 'default' ? cfg.mode : undefined,
		permissionMode: cfg?.permissionMode && cfg.permissionMode !== 'default' ? cfg.permissionMode : undefined,
		sandboxMode: cfg?.sandboxMode && cfg.sandboxMode !== 'default' ? cfg.sandboxMode : undefined,
		webSearch: cfg?.webSearch,
		attachments: extra.attachments,
		pureWorker: extra.pureWorker,
		callerRole: extra.callerRole,
		automatedEngineering: extra.automatedEngineering,
	};
}

function resolveCompletedTurnUsage(engine: EngineRuntime, sessionId: string, promptText: string, replyText: string, startedAt: number): EngineTurnTokenUsage {
	const reported = engine.consumeLastTurnUsage?.(sessionId);
	if (reported && reported.totalTokens > 0) {
		return reported;
	}
	const inputTokens = Math.ceil(promptText.length / 4);
	const outputTokens = Math.ceil(replyText.length / 4);
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: inputTokens + outputTokens,
		durationMs: Math.max(0, Date.now() - startedAt),
		estimated: true,
	};
}

function extractAttachmentsAndRefs(references: readonly vscode.ChatPromptReference[]): { attachments: EngineAttachment[]; fileLines: string[] } {
	const attachments: EngineAttachment[] = [];
	const fileLines: string[] = [];
	const seenPaths = new Set<string>();
	for (const ref of references) {
		if (ref.value instanceof vscode.Uri && ref.value.scheme === 'file') {
			const fsPath = ref.value.fsPath;
			if (seenPaths.has(fsPath)) {
				continue;
			}
			seenPaths.add(fsPath);
			const ext = path.extname(fsPath).toLowerCase();
			const imageMime = IMAGE_MIME_BY_EXT[ext];
			if (imageMime) {
				attachments.push({ kind: 'image', filePath: fsPath, mimeType: imageMime });
			} else {
				attachments.push({ kind: 'file', filePath: fsPath });
			}
			fileLines.push(fsPath);
		} else if (ref.value instanceof vscode.Location && ref.value.uri.scheme === 'file') {
			const locText = `${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}`;
			attachments.push({ kind: 'file', filePath: ref.value.uri.fsPath, rangeText: locText });
			fileLines.push(locText);
		}
	}
	return { attachments, fileLines };
}

function buildSlashHelpMarkdown(
	isSecretary: boolean,
	engineName: string,
	cfg: SessionConfigState | undefined,
	activeGoal: string | undefined,
	commandsList: readonly DiscoveredSlashCommand[],
): string {
	const lines: string[] = [
		`### ${isSecretary ? `Secretary · ${engineName}` : engineName} — Unified Capabilities & Slash Commands`,
		'',
		`- **Model**: \`${cfg?.model || 'default'}\` · **Thinking**: \`${cfg?.thinking || 'default'}\`${cfg?.mode ? ` · **Mode**: \`${cfg.mode}\`` : ''}${cfg?.permissionMode ? ` · **Permissions**: \`${cfg.permissionMode}\`` : ''}${cfg?.sandboxMode ? ` · **Sandbox**: \`${cfg.sandboxMode}\`` : ''}`,
		...(activeGoal ? [`- **Active Goal**: ${activeGoal}`] : []),
		'',
	];

	const macros = commandsList.filter(c => c.kind === 'macro');
	if (macros.length > 0) {
		lines.push('#### Secretary ADE Macro Commands');
		for (const c of macros) {
			lines.push(`- \`/${c.name}\` — ${c.description}`);
		}
		lines.push('');
	}

	const builtins = commandsList.filter(c => c.kind === 'command' && !c.filePath);
	if (builtins.length > 0) {
		lines.push(`#### ${engineName} Slash Commands (${builtins.length})`);
		for (const c of builtins) {
			lines.push(`- \`/${c.name}\` — ${c.description}`);
		}
		lines.push('');
	}

	const customs = commandsList.filter(c => Boolean(c.filePath) || c.kind === 'skill' || c.kind === 'workflow' || c.kind === 'prompt');
	if (customs.length > 0) {
		lines.push(`#### Discovered Skills, Workflows & Custom Commands (${customs.length})`);
		for (const c of customs) {
			lines.push(`- \`/${c.name}\` — ${c.description} *(${c.source})*`);
		}
	}
	return lines.join('\n');
}

function expandBuiltInWorkflowPrompt(cmd: string, argsText: string, engineId: EngineId): string | undefined {
	const task = argsText.trim();
	switch (cmd) {
		case 'compact':
		case 'smol':
		case 'summarize':
			return task
				? `Compact and summarize our conversation context so far with special focus on: ${task}\nPreserve all critical architectural decisions, file paths, unresolved issues, and next steps concisely.`
				: 'Compact and summarize our conversation context so far concisely, preserving all key decisions, modified files, constraints, and next steps.';
		case 'plan':
		case 'deep-planning':
			return task
				? `[Planning Mode] Analyze the codebase thoroughly and produce a clear, step-by-step implementation plan before making destructive edits.\n\nTask: ${task}`
				: '[Planning Mode] Analyze the current task and workspace, then outline a concrete step-by-step implementation plan with files, risks, and verification steps.';
		case 'review':
			return task
				? `Perform a rigorous code review focused on bugs, regressions, security, edge cases, and maintainability: ${task}`
				: 'Inspect uncommitted Git changes (`git status` and `git diff`) in this workspace and perform a thorough code review covering correctness, regressions, edge cases, and code quality.';
		case 'security-review':
			return task
				? `Perform a thorough security audit (injection, auth, secrets exposure, path traversal, privilege boundaries) focused on: ${task}`
				: 'Perform a security review of uncommitted changes in this workspace, checking for secrets, injection risks, auth/permission flaws, and unsafe inputs.';
		case 'init':
			return engineId === 'aexus-claude'
				? `Analyze this repository's structure, build/test commands, and conventions, then initialize or update \`CLAUDE.md\` concisely.${task ? `\n\nAdditional instructions: ${task}` : ''}`
				: `Analyze this repository's structure, build/test commands, and conventions, then initialize or update \`AGENTS.md\` concisely.${task ? `\n\nAdditional instructions: ${task}` : ''}`;
		case 'grill-me':
			return `Interview me interactively with sharp, high-leverage design questions to resolve ambiguities and stress-test our plan${task ? ` for: ${task}` : '.'}`;
		case 'boost':
			return `[Deep Strategic Analysis & Verification] Reason deeply from multiple perspectives, verify assumptions against actual code, and execute rigorously${task ? `:\n\n${task}` : '.'}`;
		case 'teamwork':
			return `Coordinate parallel workstreams cleanly across modules/subagents and synthesize verified results${task ? ` for:\n\n${task}` : '.'}`;
		case 'learn':
			return `Distill the key lessons, setup fixes, or conventions from our recent work so they can be persisted cleanly into project instructions/skills${task ? `:\n\n${task}` : '.'}`;
		case 'verify':
			return `Run end-to-end verification (build, lint, tests, and runtime checks) to prove the implementation works cleanly${task ? `:\n\n${task}` : '.'}`;
		case 'debug':
			return `Systematically reproduce, isolate root cause, and fix the issue${task ? `:\n\n${task}` : '.'}`;
		case 'simplify':
			return `Review recent changes for opportunities to simplify logic, remove duplication, and improve clarity without changing behavior${task ? `:\n\n${task}` : '.'}`;
		case 'recap':
			return `Provide a concise recap of what has been accomplished in this session, current workspace state, and remaining next steps${task ? ` (${task})` : '.'}`;
		case 'deep-research':
			return `Conduct a thorough, evidence-backed technical investigation across the codebase and available tools${task ? ` on:\n\n${task}` : '.'}`;
		default:
			return undefined;
	}
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
	const runtimeCapsCache = new Map<string, EngineRuntimeCapabilities>();
	const controllers = new Map<string, vscode.ChatSessionItemController>();
	const optionChangeEmitters = new Map<string, vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>>();
	const providerOptionsChangeEmitters = new Map<string, vscode.EventEmitter<void>>();
	const inputStatesByType = new Map<string, Set<vscode.ChatSessionInputState>>();
	const customizationChangedEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(customizationChangedEmitter);

	const busy = new Set<string>();
	const activeTurns = new Map<string, vscode.CancellationTokenSource>();
	const lastTurnReplies = new Map<string, string>();
	const lastTurnErrors = new Map<string, string>();
	const opened = new Map<string, { changed: vscode.EventEmitter<vscode.ChatSession['history']>; cancellation: vscode.CancellationTokenSource }>();
	const available: Array<EngineDefinition & { command: string | undefined }> = await Promise.all(
		definitions.map(async definition => ({ ...definition, command: await findExecutable(definition.executable) })),
	);

	const ensureEngineCommand = async (shortEngine: string): Promise<string | undefined> => {
		const entry = available.find(candidate => candidate.id === shortEngine);
		if (!entry) {
			return undefined;
		}
		if (entry.command) {
			return entry.command;
		}
		const discovered = await findExecutable(entry.executable);
		if (discovered) {
			entry.command = discovered;
		}
		return entry.command;
	};

	const refreshAvailableEngines = async (): Promise<void> => {
		await Promise.all(available.map(async entry => {
			const nextCmd = await findExecutable(entry.executable);
			if (entry.command !== nextCmd) {
				entry.command = nextCmd;
				const prevRuntime = runtimes.get(entry.id);
				if (prevRuntime) {
					prevRuntime.dispose();
					runtimes.delete(entry.id);
				}
			}
		}));
	};

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('aexus.ade.cliPaths')) {
			void refreshAvailableEngines();
		}
	}));

	const promptConfigureCliPaths = (message: string) => {
		const configureLabel = vscode.l10n.t('Configure CLI Paths…');
		void vscode.window.showWarningMessage(message, configureLabel).then(choice => {
			if (choice === configureLabel) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'aexus.ade.cliPaths');
			}
		});
	};

	const formatMissingEngineMessage = (shortEngine: string): string => {
		const def = available.find(entry => entry.id === shortEngine);
		const guide = ENGINE_INSTALL_GUIDES[shortEngine];
		const displayName = def?.name ?? shortEngine;
		const installCmd = guide?.installCommand ?? `Install ${displayName} CLI`;
		const cliKey = guide?.cliKey ?? def?.executable ?? shortEngine;
		return vscode.l10n.t('{0} CLI is not installed ({1}). Configure "aexus.ade.cliPaths.{2}" in Settings or install the CLI first.', displayName, installCmd, cliKey);
	};

	const buildMissingEngineMarkdown = (shortEngine: string): string => {
		const def = available.find(entry => entry.id === shortEngine);
		const guide = ENGINE_INSTALL_GUIDES[shortEngine];
		const displayName = def?.name ?? shortEngine;
		const cliKey = guide?.cliKey ?? def?.executable ?? shortEngine;
		const settingsCmdUri = `command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify(['aexus.ade.cliPaths']))}`;
		return [
			`### ${displayName} CLI Not Found`,
			'',
			`**Aexus Code** could not locate the \`${def?.executable ?? shortEngine}\` executable on your \`PATH\` or in \`aexus.ade.cliPaths.${cliKey}\`.`,
			'',
			...(guide ? [`1. **Install CLI**: \`${guide.installCommand}\` ([Documentation](${guide.docsUrl}))`] : []),
			`2. **Or Configure Custom Binary Path**: [Open \`aexus.ade.cliPaths\` in Settings](${settingsCmdUri})`,
			'',
			`_Once installed or configured, send your message again — no restart required._`,
		].join('\n');
	};

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
		projectUri: recordProjectUri(record),
		label: record.label,
		updated: record.updated,
		nativeId: record.id,
		provisional: Boolean(record.provisional),
	});
	const save = async () => {
		await context.globalState.update('nativeSessions', Object.fromEntries(records));
		await context.globalState.update('secretaryState', secretaryState);
	};

	const getSessionConfig = (record: RecordEntry, isSecretary: boolean): SessionConfigState => {
		if (isSecretary) {
			secretaryState ??= { engine: record.engine, recordKey: key(record.engine, record.id), perEngineConfig: {} };
			secretaryState.perEngineConfig ??= {};
			const perEng = secretaryState.perEngineConfig[record.engine] ?? record.sessionConfig ?? {};
			secretaryState.perEngineConfig[record.engine] = perEng;
			return {
				...perEng,
				secretaryEngineId: toEngineType(record.engine),
			};
		}
		record.sessionConfig ??= {};
		return record.sessionConfig;
	};

	const setGoalBannerInUi = (sessionUri: vscode.Uri, goalText: string | undefined) => {
		void Promise.resolve(vscode.commands.executeCommand('aexus.ade.setSessionGoalBanner', sessionUri, goalText)).catch(() => undefined);
	};

	const setSessionInitializingInUi = (sessionUri: vscode.Uri, message: string | undefined) => {
		void Promise.resolve(vscode.commands.executeCommand('aexus.ade.setSessionInitializing', sessionUri, message)).catch(() => undefined);
	};

	const inFlightRoleInits = new Map<string, Promise<void>>();

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

	const resolveShortEngine = (raw?: string, strict = false): string | undefined => {
		if (raw) {
			const normalized = raw.trim().toLowerCase();
			const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
			const match = available.find(entry => entry.id === aliased && entry.command);
			if (match) { return match.id; }
			if (strict) { return undefined; }
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
		result.description = formatRecordProjectLabel(record);
		result.metadata = {
			workingDirectoryPath: record.cwd,
			...(record.cloudProjectUri ? { aexusProjectUri: record.cloudProjectUri } : {}),
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
			const msg = formatMissingEngineMessage(engine);
			promptConfigureCliPaths(msg);
			throw new Error(msg);
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

	const capsSignature = (c: EngineRuntimeCapabilities | undefined): string =>
		`${c?.defaultModel ?? ''}:${(c?.models ?? []).map(m => m.id).join(',')}:${(c?.modes ?? []).map(m => m.id).join(',')}:${c?.commands?.length ?? 0}`;

	const fetchRuntimeCaps = async (shortEngine: string, cwd: string, record?: RecordEntry): Promise<{ caps: EngineRuntimeCapabilities; changed: boolean }> => {
		const cacheKey = `${shortEngine}:${cwd}`;
		const prev = runtimeCapsCache.get(cacheKey);
		const prevSig = capsSignature(prev);
		const def = available.find(entry => entry.id === shortEngine && entry.command);
		if (!def) {
			return { caps: prev ?? {}, changed: false };
		}
		try {
			const eng = runtime(shortEngine);
			if (eng.getRuntimeCapabilities) {
				const caps = await Promise.race([
					eng.getRuntimeCapabilities(cwd, record),
					new Promise<EngineRuntimeCapabilities>(resolve => setTimeout(() => resolve(prev ?? {}), 12000)),
				]);
				runtimeCapsCache.set(cacheKey, caps);
				runtimeCapsCache.set(`${shortEngine}:*`, caps);
				const nextSig = capsSignature(caps);
				return { caps, changed: nextSig !== prevSig };
			}
		} catch { /* Fall back to cached or empty runtime capabilities. */ }
		return { caps: prev ?? {}, changed: false };
	};

	const ensureSecretaryRecord = async (preferredEngine?: string, preferredProject?: vscode.Uri, forceNew = false): Promise<RecordEntry> => {
		if (preferredEngine) {
			const normalized = preferredEngine.trim().toLowerCase();
			const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
			await ensureEngineCommand(aliased);
		} else if (!available.some(entry => entry.command)) {
			await refreshAvailableEngines();
		}
		const targetEngine = preferredEngine
			? resolveShortEngine(preferredEngine, true)
			: resolveShortEngine(secretaryState?.engine);
		if (!targetEngine) {
			if (preferredEngine) {
				const normalized = preferredEngine.trim().toLowerCase();
				const aliased = ENGINE_ALIASES[normalized] ?? (normalized.startsWith('aexus-') ? normalized.slice('aexus-'.length) : normalized);
				const msg = formatMissingEngineMessage(aliased);
				promptConfigureCliPaths(msg);
				throw new Error(msg);
			}
			const noCliMsg = vscode.l10n.t('No Coding Agent CLI is installed. Install Claude Code, Codex, Kilo, OpenCode, DSH, Antigravity, Cline, or Pi, or configure "aexus.ade.cliPaths" in Settings.');
			promptConfigureCliPaths(noCliMsg);
			throw new Error(noCliMsg);
		}
		const prevPerEngineConfig = secretaryState?.perEngineConfig ?? {};
		if (!forceNew && secretaryState && secretaryState.engine === targetEngine) {
			const existing = records.get(secretaryState.recordKey);
			if (existing) {
				if (preferredProject?.scheme === 'file') {
					existing.cwd = preferredProject.fsPath;
				}
				return existing;
			}
		}
		if (!forceNew) {
			const previousForTarget = [...records.values()]
				.filter(r => r.engine === targetEngine && r.label === 'Secretary' && r.customLabel)
				.sort((a, b) => b.updated - a.updated)[0];
			if (previousForTarget) {
				if (preferredProject?.scheme === 'file') {
					previousForTarget.cwd = preferredProject.fsPath;
				}
				secretaryState = { engine: targetEngine, recordKey: key(targetEngine, previousForTarget.id), perEngineConfig: prevPerEngineConfig };
				await save();
				refreshSecretaryItem();
				const secOpened = opened.get(SECRETARY_TYPE);
				if (secOpened) {
					const turns = await runtime(targetEngine).history(previousForTarget, secOpened.cancellation.token).catch(() => [] as HistoryEntry[]);
					secOpened.changed.fire(history(turns, SECRETARY_TYPE));
				}
				return previousForTarget;
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
			sessionConfig: prevPerEngineConfig[targetEngine] ?? {},
		};
		records.set(recordKey, record);
		secretaryState = { engine: targetEngine, recordKey, perEngineConfig: prevPerEngineConfig };
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

	const defaultCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file'
		? vscode.workspace.workspaceFolders[0].uri.fsPath
		: os.homedir();

	const collectCustomModelsForEngine = (shortEng: string, baseModels: EngineRuntimeCapabilities['models']): Array<{ id: string; name: string; description?: string }> => {
		const merged = [...(baseModels ?? [])];
		const seen = new Set(merged.map(m => m.id));
		const addCustom = (m?: string) => {
			const trimmed = m?.trim();
			if (trimmed && trimmed !== 'default' && !seen.has(trimmed)) {
				seen.add(trimmed);
				merged.push({ id: trimmed, name: trimmed, description: 'Custom model' });
			}
		};
		for (const rec of records.values()) {
			if (rec.engine === shortEng) {
				addCustom(rec.sessionConfig?.model);
			}
		}
		addCustom(secretaryState?.perEngineConfig?.[shortEng]?.model);
		return merged;
	};

	const computeOptionGroupsForResource = async (sessionType: string, sessionUri?: vscode.Uri): Promise<vscode.ChatSessionProviderOptionGroup[]> => {
		const isSecretary = sessionType === SECRETARY_TYPE || sessionUri?.scheme === SECRETARY_TYPE;
		if (isSecretary) {
			const secRecord = findCachedRecord(SECRETARY_URI) ?? await ensureSecretaryRecord().catch(() => undefined);
			const shortEng = secRecord?.engine ?? resolveShortEngine() ?? 'claude';
			const cwd = secRecord?.cwd ?? defaultCwd();
			const rawCaps = runtimeCapsCache.get(`${shortEng}:${cwd}`) ?? runtimeCapsCache.get(`${shortEng}:*`);
			const caps: EngineRuntimeCapabilities = {
				...rawCaps,
				models: collectCustomModelsForEngine(shortEng, rawCaps?.models),
			};
			const cfg = secRecord ? getSessionConfig(secRecord, true) : { secretaryEngineId: toEngineType(shortEng) };
			return toVsCodeOptionGroups(await buildOptionGroupsForSession('secretary', cfg, cwd, caps), SECRETARY_TYPE);
		}
		const engineType = toEngineType(sessionType);
		const shortEng = engineType.slice('aexus-'.length);
		const rec = sessionUri ? findCachedRecord(sessionUri) : undefined;
		const cwd = rec?.cwd ?? defaultCwd();
		const rawCaps = runtimeCapsCache.get(`${shortEng}:${cwd}`) ?? runtimeCapsCache.get(`${shortEng}:*`);
		const caps: EngineRuntimeCapabilities = {
			...rawCaps,
			models: collectCustomModelsForEngine(shortEng, rawCaps?.models),
		};
		const cfg = rec ? getSessionConfig(rec, false) : {};
		return toVsCodeOptionGroups(await buildOptionGroupsForSession(engineType, cfg, cwd, caps), engineType);
	};

	const trackInputState = (sessionType: string, controller: vscode.ChatSessionItemController, groups: vscode.ChatSessionProviderOptionGroup[]): vscode.ChatSessionInputState => {
		const state = controller.createChatSessionInputState(groups);
		let set = inputStatesByType.get(sessionType);
		if (!set) {
			set = new Set();
			inputStatesByType.set(sessionType, set);
		}
		set.add(state);
		state.onDidDispose(() => set?.delete(state));
		return state;
	};

	const lastNotifiedOptionsSig = new Map<string, string>();
	const notifySessionOptionsUpdated = async (sessionType: string, sessionUri: vscode.Uri, refreshGroups = false) => {
		const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
		const optionsMap = toSessionOptionsRecord(groups);
		const sig = `${sessionType}:${groups.map(g => `${g.id}=${g.selected?.id ?? ''}[${g.items.length}]`).join('|')}`;
		const resourceKey = sessionUri.toString();
		if (!refreshGroups && lastNotifiedOptionsSig.get(resourceKey) === sig) {
			return;
		}
		lastNotifiedOptionsSig.set(resourceKey, sig);
		if (refreshGroups) {
			providerOptionsChangeEmitters.get(sessionType)?.fire();
		}
		optionChangeEmitters.get(sessionType)?.fire({
			resource: sessionUri,
			updates: Object.entries(optionsMap).map(([optionId, value]) => ({ optionId, value })),
		});
		const tracked = inputStatesByType.get(sessionType);
		if (tracked) {
			for (const inputState of tracked) {
				if (!inputState.sessionResource || inputState.sessionResource.toString() === resourceKey) {
					inputState.groups = groups;
				}
			}
		}
	};

	const applyOptionUpdates = async (
		sessionType: string,
		sessionUri: vscode.Uri,
		updates: ReadonlyArray<{ optionId: string; value: string | undefined }>,
		syncToAde = true,
		fromUiPicker = false,
	): Promise<void> => {
		const isSecretary = sessionType === SECRETARY_TYPE || sessionUri.scheme === SECRETARY_TYPE;
		let record = findCachedRecord(sessionUri);
		if (!record && isSecretary) {
			record = await ensureSecretaryRecord();
		}
		if (!record) {
			return;
		}

		let anyChanged = false;
		let engineSwitched = false;

		for (const { optionId, value } of updates) {
			if (isSecretary && optionId === 'engine' && value) {
				const nextShort = resolveShortEngine(value);
				if (nextShort && nextShort !== record.engine) {
					record = await ensureSecretaryRecord(nextShort, vscode.Uri.file(record.cwd), false);
					engineSwitched = true;
					anyChanged = true;
					void fetchRuntimeCaps(nextShort, record.cwd, record).then(({ changed }) => {
						if (changed) {
							void notifySessionOptionsUpdated(SECRETARY_TYPE, SECRETARY_URI, true);
						}
					});
					if (syncToAde) {
						void Promise.resolve(vscode.commands.executeCommand('aexus.ade.syncSessionPreferences', {
							resource: SECRETARY_URI.toString(),
							engineId: `aexus-${nextShort}`,
						})).catch(() => undefined);
					}
					customizationChangedEmitter.fire();
					if (opened.has(SECRETARY_TYPE)) {
						void ensureRoleInitialized(record, SECRETARY_URI, true);
					}
				}
				continue;
			}

			const targetCfg = isSecretary
				? ((secretaryState ??= { engine: record.engine, recordKey: key(record.engine, record.id), perEngineConfig: {} }),
					(secretaryState.perEngineConfig ??= {}),
					(secretaryState.perEngineConfig[record.engine] ??= {}))
				: (record.sessionConfig ??= {});

			const engineType = toEngineType(record.engine);
			const defaultModeForEngine = engineType === 'aexus-cline' ? 'yolo'
				: engineType === 'aexus-antigravity' ? 'auto'
					: engineType === 'aexus-pi' ? 'full'
						: undefined;
			const defaultPermissionsForEngine = engineType === 'aexus-codex' ? 'never'
				: engineType === 'aexus-dsh' ? 'danger-full-access'
					: 'bypassPermissions';
			const defaultSandboxForEngine = 'danger-full-access';

			switch (optionId) {
				case 'model': {
					const next = value || 'default';
					if ((targetCfg.model || 'default') !== next) {
						targetCfg.model = next;
						anyChanged = true;
					}
					break;
				}
				case 'thinking': {
					const next = value || 'default';
					if ((targetCfg.thinking || 'default') !== next) {
						targetCfg.thinking = next;
						anyChanged = true;
					}
					break;
				}
				case 'mode': {
					const next = value || defaultModeForEngine;
					const prev = targetCfg.mode && targetCfg.mode !== 'default' ? targetCfg.mode : defaultModeForEngine;
					if (prev !== next) {
						targetCfg.mode = next;
						anyChanged = true;
					}
					break;
				}
				case 'permissions': {
					const next = value || defaultPermissionsForEngine;
					const prev = targetCfg.permissionMode && targetCfg.permissionMode !== 'default' ? targetCfg.permissionMode : defaultPermissionsForEngine;
					if (prev !== next) {
						targetCfg.permissionMode = next;
						anyChanged = true;
					}
					break;
				}
				case 'sandbox': {
					const next = value || defaultSandboxForEngine;
					const prev = targetCfg.sandboxMode && targetCfg.sandboxMode !== 'default' ? targetCfg.sandboxMode : defaultSandboxForEngine;
					if (prev !== next) {
						targetCfg.sandboxMode = next;
						anyChanged = true;
					}
					break;
				}
				case 'webSearch': {
					const next = value || 'enabled';
					if ((targetCfg.webSearch || 'enabled') !== next) {
						targetCfg.webSearch = next;
						anyChanged = true;
					}
					break;
				}
			}
		}

		if (!anyChanged && !engineSwitched) {
			return;
		}

		record.sessionConfig = isSecretary
			? { ...(secretaryState?.perEngineConfig?.[record.engine] ?? {}) }
			: record.sessionConfig;
		await save();

		if (!fromUiPicker || engineSwitched) {
			await notifySessionOptionsUpdated(sessionType, sessionUri, true);
		} else {
			providerOptionsChangeEmitters.get(sessionType)?.fire();
			// Record current signature so subsequent checks don't re-emit stale diff
			const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
			lastNotifiedOptionsSig.set(
				sessionUri.toString(),
				`${sessionType}:${groups.map(g => `${g.id}=${g.selected?.id ?? ''}[${g.items.length}]`).join('|')}`,
			);
		}

		if (syncToAde && !isSecretary) {
			const cfg = record.sessionConfig ?? {};
			void Promise.resolve(vscode.commands.executeCommand('aexus.ade.syncSessionPreferences', {
				resource: sessionUri.toString(),
				model: cfg.model,
				thinking: cfg.thinking,
			})).catch(() => undefined);
		}
	};

	const history = (turns: HistoryEntry[], participant: string): readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] => filterAndCleanHistoryTurns(turns).map(turn => turn.role === 'user'
		? new vscode.ChatRequestTurn2(turn.text, undefined, [], participant, [], undefined, turn.id, undefined, undefined, turn.isSystemInitiated)
		: new vscode.ChatResponseTurn2([new vscode.ChatResponseMarkdownPart(turn.text)], {}, participant));

	const ensureRoleInitialized = async (record: RecordEntry, sessionUri: vscode.Uri, isSecretary: boolean): Promise<void> => {
		if (record.readOnly) {
			return;
		}
		const snapEntry = isSecretary ? undefined : roleBridge.getSnapshot().agents.find(a => a.resource === sessionUri.toString());
		if (!isSecretary && !snapEntry?.isOrchestrated) {
			return;
		}
		const targetRank = isSecretary ? 'secretary' : (snapEntry?.rank ?? 'governor');
		if (record.roleInit && record.roleInit.engine === record.engine && record.roleInit.rank === targetRank) {
			return;
		}
		const recordKey = identity(record);
		const existingInit = inFlightRoleInits.get(recordKey);
		if (existingInit) {
			return existingInit;
		}
		if (busy.has(recordKey)) {
			return;
		}
		if (!await ensureEngineCommand(record.engine)) {
			return;
		}

		const roleDisplay = isSecretary ? 'Secretary' : targetRank.charAt(0).toUpperCase() + targetRank.slice(1);
		const bannerMessage = vscode.l10n.t('Initializing {0} role & ADE control-plane context…', roleDisplay);

		const runInit = (async () => {
			const initCts = new vscode.CancellationTokenSource();
			busy.add(recordKey);
			activeTurns.set(recordKey, initCts);
			controllers.get(record.engine)?.items.add(item(record));
			if (isSecretary) {
				refreshSecretaryItem();
			}
			setSessionInitializingInUi(sessionUri, bannerMessage);
			// Re-apply shortly after in case the editor tab widget is still mounting
			const remountTimer = setTimeout(() => {
				if (inFlightRoleInits.has(recordKey)) {
					setSessionInitializingInUi(sessionUri, bannerMessage);
				}
			}, 180);

			try {
				const roleDocs = await Promise.resolve(vscode.commands.executeCommand<string | undefined>('aexus.ade.resolvePromptContext', sessionUri)).catch(() => undefined);
				if (!roleDocs?.trim()) {
					return;
				}
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

				const initPrompt = [
					ROLE_INIT_MARKER,
					`You are initializing as **${roleDisplay}** in **Aexus Code ADE**.`,
					`Read and internalize your organizational rank, identity override rules, responsibilities, and the \`aexus-ade\` CLI API documentation below so you are immediately ready when the user sends their first message.`,
					`STRICT INITIALIZATION RULE: Do NOT execute any shell commands, file operations, or tools during this initialization step. Simply internalize the specifications below and reply with the exact single token: ${ROLE_INIT_ACK}`,
					'',
					roleDocs.trim(),
				].join('\n');

				const silentTarget: vscode.ChatResponseStream = Object.create(null);
				const silentStream: vscode.ChatResponseStream = new Proxy(silentTarget, {
					get() { return () => { }; },
				});
				const cfg = getSessionConfig(record, isSecretary);
				const effectiveInitModel = (cfg.model && cfg.model !== 'default') ? cfg.model : snapEntry?.preferredModel;
				const effectiveInitThinking: EngineThinkingLevel = (cfg.thinking === 'off' || snapEntry?.preferredThinking === 'off') ? 'off' : 'low';
				const initStartedAt = Date.now();
				await engine.send(record, initPrompt, silentStream, initCts.token, toSendOptions(
					{ ...cfg, ...(effectiveInitModel ? { model: effectiveInitModel } : {}), thinking: effectiveInitThinking },
					{ pureWorker: false, callerRole: targetRank, automatedEngineering: true },
				));
				if (!isSecretary) {
					const initUsage = resolveCompletedTurnUsage(engine, record.id, initPrompt, ROLE_INIT_ACK, initStartedAt);
					if (initUsage.totalTokens > 0) {
						void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.recordTurnUsage', {
							sessionResource: sessionUri.toString(),
							usage: initUsage,
						})).catch(() => undefined);
					}
				}

				if (!initCts.token.isCancellationRequested) {
					record.roleInit = {
						rank: targetRank,
						engine: record.engine,
						initializedAt: Date.now(),
					};
					record.updated = Date.now();
					await save();
				}
			} catch {
				// Non-fatal: if initialization fails (e.g. offline), the first user turn falls back to full context injection.
			} finally {
				clearTimeout(remountTimer);
				initCts.dispose();
				inFlightRoleInits.delete(recordKey);
				activeTurns.delete(recordKey);
				busy.delete(recordKey);
				setSessionInitializingInUi(sessionUri, undefined);
				if (records.has(key(record.engine, record.id)) || [...records.values()].includes(record)) {
					controllers.get(record.engine)?.items.add(item(record));
				}
				if (isSecretary) {
					refreshSecretaryItem();
				}
				await publishHistory(record).catch(() => undefined);
			}
		})();

		inFlightRoleInits.set(recordKey, runInit);
		return runInit;
	};

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

	const selectOrPromptOption = async (
		sessionType: string,
		sessionUri: vscode.Uri,
		groupId: string,
		groupTitle: string,
		argText: string,
		stream: vscode.ChatResponseStream,
	): Promise<boolean> => {
		const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
		const group = groups.find(g => g.id === groupId);
		if (!group || group.items.length === 0) {
			return false;
		}
		const trimmed = argText.trim();
		if (trimmed) {
			const lower = trimmed.toLowerCase();
			const matched = group.items.find(i => i.id.toLowerCase() === lower || i.name.toLowerCase() === lower)
				?? group.items.find(i => i.id.toLowerCase().includes(lower) || i.name.toLowerCase().includes(lower));
			const chosenId = matched ? matched.id : (groupId === 'model' ? trimmed : undefined);
			if (!chosenId) {
				stream.markdown([
					`Unknown ${groupTitle.toLowerCase()} \`${trimmed}\`. Available options:`,
					...group.items.map(i => `- \`${i.id}\` — ${i.name}${i.description ? ` *(${i.description})*` : ''}`),
				].join('\n'));
				return true;
			}
			await applyOptionUpdates(sessionType, sessionUri, [{ optionId: groupId, value: chosenId }]);
			stream.markdown(`Updated **${groupTitle}** to **${matched?.name ?? chosenId}** (\`${chosenId}\`).`);
			return true;
		}

		const currentId = group.selected?.id;
		const picked = await vscode.window.showQuickPick(
			group.items.map(i => ({
				label: i.id === currentId ? `$(check) ${i.name}` : i.name,
				description: i.id,
				detail: i.description,
				itemId: i.id,
				itemName: i.name,
			})),
			{
				title: `Select ${groupTitle}`,
				placeHolder: `Current: ${group.selected?.name ?? 'Default'}`,
			},
		);
		if (picked) {
			await applyOptionUpdates(sessionType, sessionUri, [{ optionId: groupId, value: picked.itemId }]);
			stream.markdown(`Updated **${groupTitle}** to **${picked.itemName}** (\`${picked.itemId}\`).`);
		} else {
			stream.markdown([
				`### ${groupTitle} (Current: **${group.selected?.name ?? 'Default'}**)`,
				...group.items.map(i => `- \`${i.id}\` — ${i.name}${i.id === currentId ? ' *(active)*' : ''}${i.description ? ` · ${i.description}` : ''}`),
			].join('\n'));
		}
		return true;
	};

	const handleDirectSlashCommand = async (
		cmd: string,
		argText: string,
		record: RecordEntry,
		sessionUri: vscode.Uri,
		isSecretary: boolean,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<boolean> => {
		const sessionType = isSecretary ? SECRETARY_TYPE : `aexus-${record.engine}`;
		const engineType = toEngineType(record.engine);
		const engineDef = available.find(entry => entry.id === record.engine);
		const engineName = engineDef?.name ?? record.engine;
		const cfg = getSessionConfig(record, isSecretary);
		const { caps } = await fetchRuntimeCaps(record.engine, record.cwd, record);
		const allCommands = await discoverSlashCommands(isSecretary ? 'secretary' : engineType, engineType, record.cwd, caps.commands);

		if (cmd === 'help') {
			stream.markdown(buildSlashHelpMarkdown(isSecretary, engineName, cfg, record.activeGoal, allCommands));
			return true;
		}

		if (cmd === 'skills') {
			const skillsAndWorkflows = allCommands.filter(c => c.kind === 'skill' || c.kind === 'workflow' || c.kind === 'prompt' || Boolean(c.filePath));
			if (skillsAndWorkflows.length === 0) {
				stream.markdown(`No custom skills, prompts, or workflows found in \`${record.cwd}\` or user agent directories.`);
			} else {
				stream.markdown([
					`### Discovered Skills, Prompts & Workflows (${skillsAndWorkflows.length})`,
					...skillsAndWorkflows.map(s => `- \`/${s.name}\` — ${s.description} *(${s.source})*`),
				].join('\n'));
			}
			return true;
		}

		if (cmd === 'clear' || cmd === 'newtask' || (!isSecretary && cmd === 'new') || (isSecretary && cmd === 'reset')) {
			record.activeGoal = undefined;
			setGoalBannerInUi(sessionUri, undefined);
			if (isSecretary) {
				const rotated = await ensureSecretaryRecord(record.engine, vscode.Uri.file(record.cwd), true);
				await Promise.resolve(vscode.commands.executeCommand('aexus.ade.control.execute', {
					action: 'secretary.configure',
					params: { engine: `aexus-${rotated.engine}`, resource: SECRETARY_URI.toString(), open: false },
				})).catch(() => undefined);
				stream.markdown(`Secretary conversation context has been reset (**${engineName}**).`);
				void ensureRoleInitialized(rotated, SECRETARY_URI, true);
			} else {
				const preservedConfig = record.sessionConfig;
				const fresh = await runtime(record.engine).create(record.cwd);
				Object.assign(record, fresh, {
					label: record.label,
					customLabel: record.customLabel,
					resourceId: record.resourceId ?? record.id,
					sessionConfig: preservedConfig,
					activeGoal: undefined,
					roleInit: undefined,
				});
				await save();
				const openEntry = opened.get(identity(record));
				openEntry?.changed.fire([]);
				stream.markdown(`Conversation context cleared (**${engineName}**).`);
				void ensureRoleInitialized(record, sessionUri, false);
			}
			return true;
		}

		if (cmd === 'diff' && !argText.trim()) {
			try {
				const [statusRes, statRes, diffRes] = await Promise.all([
					execFileAsync('git', ['status', '--short', '--branch'], { cwd: record.cwd, timeout: 6000, windowsHide: true }),
					execFileAsync('git', ['diff', '--stat'], { cwd: record.cwd, timeout: 6000, windowsHide: true }),
					execFileAsync('git', ['diff', '--no-color'], { cwd: record.cwd, timeout: 6000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }),
				]);
				const statusText = statusRes.stdout.trim() || '(clean working tree)';
				const statText = statRes.stdout.trim();
				const rawPatch = diffRes.stdout.trim();
				const patchPreview = rawPatch.length > 6000 ? `${rawPatch.slice(0, 6000)}\n... (diff truncated)` : rawPatch;
				stream.markdown([
					`### Git Working Tree Diff (\`${record.cwd}\`)`,
					'```text',
					statusText,
					...(statText ? ['', statText] : []),
					'```',
					...(patchPreview ? ['```diff', patchPreview, '```'] : ['*(No unstaged line diffs)*']),
				].join('\n'));
				return true;
			} catch {
				// Fall through to let the engine inspect the workspace if git is unavailable.
			}
		}

		if (cmd === 'model' || cmd === 'models') {
			return selectOrPromptOption(sessionType, sessionUri, 'model', 'Model', argText, stream);
		}
		if (cmd === 'effort' || cmd === 'thinking') {
			return selectOrPromptOption(sessionType, sessionUri, 'thinking', 'Thinking Effort', argText, stream);
		}
		if (cmd === 'permissions') {
			return selectOrPromptOption(sessionType, sessionUri, 'permissions', 'Permissions', argText, stream);
		}
		if (cmd === 'bypass') {
			if (engineType === 'aexus-codex') {
				await applyOptionUpdates(sessionType, sessionUri, [
					{ optionId: 'permissions', value: 'never' },
					{ optionId: 'sandbox', value: 'danger-full-access' },
				]);
				stream.markdown('Updated **Approval** to **Never Ask** (`never`) and **Sandbox** to **Full Access** (`danger-full-access`).');
			} else if (engineType === 'aexus-dsh') {
				await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'permissions', value: 'danger-full-access' }]);
				stream.markdown('Updated **Permissions** to **Full Access** (`danger-full-access`).');
			} else if (engineType === 'aexus-cline') {
				await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'yolo' }]);
				stream.markdown('Updated **Mode** to **Auto-Approve YOLO** (`yolo`).');
			} else if (engineType === 'aexus-antigravity') {
				await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'auto' }]);
				stream.markdown('Updated **Mode** to **Auto** (`auto`).');
			} else {
				await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'permissions', value: 'bypassPermissions' }]);
				stream.markdown('Updated **Permissions** to **Bypass All** (`bypassPermissions`).');
			}
			return true;
		}
		if (cmd === 'sandbox') {
			return selectOrPromptOption(sessionType, sessionUri, 'sandbox', 'Sandbox Policy', argText, stream);
		}
		if (cmd === 'search' && (engineType === 'aexus-codex' && (!argText.trim() || ['on', 'off', 'enabled', 'disabled', 'true', 'false'].includes(argText.trim().toLowerCase())))) {
			const norm = argText.trim().toLowerCase();
			const mapped = norm === 'on' || norm === 'true' ? 'enabled' : norm === 'off' || norm === 'false' ? 'disabled' : norm;
			return selectOrPromptOption(sessionType, sessionUri, 'webSearch', 'Web Search', mapped, stream);
		}
		if (cmd === 'mode' || (cmd === 'agent' && engineType === 'aexus-opencode')) {
			return selectOrPromptOption(sessionType, sessionUri, 'mode', engineType === 'aexus-opencode' ? 'Agent' : 'Mode', argText, stream);
		}
		if (cmd === 'act' && engineType === 'aexus-cline' && !argText.trim()) {
			await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'act' }]);
			stream.markdown('Switched Cline to **Act Mode** (`act`).');
			return true;
		}
		if (cmd === 'yolo' && engineType === 'aexus-cline' && !argText.trim()) {
			await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'yolo' }]);
			stream.markdown('Switched Cline to **Auto-Approve YOLO Mode** (`yolo`).');
			return true;
		}
		if (cmd === 'plan' && !argText.trim()) {
			const groups = await computeOptionGroupsForResource(sessionType, sessionUri);
			const modeGroup = groups.find(g => g.id === 'mode');
			const permGroup = groups.find(g => g.id === 'permissions');
			const planModeItem = modeGroup?.items.find(i => i.id === 'plan' || i.id === 'architect');
			if (planModeItem) {
				await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: planModeItem.id }]);
				stream.markdown(`Switched **Mode** to **${planModeItem.name}** (\`${planModeItem.id}\`). Send your task to generate a plan.`);
				return true;
			}
			const planPermItem = permGroup?.items.find(i => i.id === 'plan');
			if (planPermItem) {
				await applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'permissions', value: 'plan' }]);
				stream.markdown('Switched **Permissions** to **Plan Mode** (`plan`). Send your task to generate a plan.');
				return true;
			}
		}

		//Secretary-exclusive ADE macro commands
		if (isSecretary) {
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
					return selectOrPromptOption(SECRETARY_TYPE, SECRETARY_URI, 'engine', 'Secretary Engine', '', stream);
				}
				const nextShort = resolveShortEngine(argText);
				const nextDef = available.find(entry => entry.id === nextShort && entry.command);
				if (!nextDef || !nextShort || nextDef.id !== (ENGINE_ALIASES[argText.trim().toLowerCase()] ?? argText.trim().toLowerCase())) {
					stream.markdown(`Unknown or uninstalled engine \`${argText}\`. Try \`/engine\` to list installed engines.`);
					return true;
				}
				await applyOptionUpdates(SECRETARY_TYPE, SECRETARY_URI, [{ optionId: 'engine', value: nextDef.type }]);
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
		}

		// Delegate native RPC/HTTP/CLI inspection & session commands directly to the active runtime
		const eng = runtime(record.engine);
		if (eng.executeCommand) {
			const normalizedRuntimeCmd = cmd === 'smol' ? 'compact' : cmd;
			const handledByRuntime = await eng.executeCommand(record, normalizedRuntimeCmd, argText, stream, token, toSendOptions(cfg, {}));
			if (handledByRuntime) {
				await save();
				return true;
			}
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
		const initialRecordKey = identity(record);
		const pendingInit = inFlightRoleInits.get(initialRecordKey);
		if (pendingInit) {
			stream.progress(vscode.l10n.t('Waiting for role & API initialization to finish…'));
			await pendingInit;
		}
		const recordKey = identity(record);
		if (busy.has(recordKey)) { throw new Error(vscode.l10n.t('This conversation is already working. Stop or wait for its current response.')); }

		const trimmedPrompt = request.prompt.trim();
		let parsedCmd = request.command?.trim().toLowerCase();
		let cmdArgText = trimmedPrompt;
		if (!parsedCmd && /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(trimmedPrompt)) {
			const spaceIdx = trimmedPrompt.indexOf(' ');
			parsedCmd = (spaceIdx === -1 ? trimmedPrompt.slice(1) : trimmedPrompt.slice(1, spaceIdx)).toLowerCase();
			cmdArgText = spaceIdx === -1 ? '' : trimmedPrompt.slice(spaceIdx + 1).trim();
		}

		// Handle /goal status & /goal clear immediately before starting a turn
		if (parsedCmd === 'goal') {
			const goalArg = cmdArgText.trim();
			if (!goalArg) {
				if (record.activeGoal) {
					setGoalBannerInUi(sessionUri, record.activeGoal);
					stream.markdown(`### Active Session Goal\n\n> ${record.activeGoal}\n\n- Clear with \`/goal clear\` or set a new goal with \`/goal <condition>\`.`);
				} else {
					stream.markdown('### Autonomous Goal Mode (`/goal`)\n\n- **Set & execute a verified goal**: `/goal <objective or completion condition>`\n- **Clear active goal**: `/goal clear`\n\nWhen active, the session verifies all goal requirements before stopping until `<!-- GOAL_COMPLETE -->` is confirmed.');
				}
				return {};
			}
			if (['clear', 'off', 'none', 'cancel'].includes(goalArg.toLowerCase())) {
				record.activeGoal = undefined;
				setGoalBannerInUi(sessionUri, undefined);
				await save();
				stream.markdown('Cleared active session goal.');
				return {};
			}
			record.activeGoal = goalArg;
			setGoalBannerInUi(sessionUri, goalArg);
			await save();
		}

		if (parsedCmd && parsedCmd !== 'goal') {
			const handledDirectly = await handleDirectSlashCommand(parsedCmd, cmdArgText, record, sessionUri, isSecretary, stream, token);
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

		const engineType = toEngineType(record.engine);
		const cfg = getSessionConfig(record, isSecretary);
		const caps = runtimeCapsCache.get(`${record.engine}:${record.cwd}`);
		const discoveredCommands = await discoverSlashCommands(isSecretary ? 'secretary' : engineType, engineType, record.cwd, caps?.commands);

		let effectiveUserPrompt: string;
		if (parsedCmd === 'goal') {
			effectiveUserPrompt = cmdArgText;
		} else if (parsedCmd) {
			const matchedTemplateCmd = discoveredCommands.find(c => c.name.toLowerCase() === parsedCmd && c.filePath);
			const expandedTemplate = matchedTemplateCmd ? await readSkillOrCommandTemplate(matchedTemplateCmd, cmdArgText) : undefined;
			const expandedBuiltin = !expandedTemplate ? expandBuiltInWorkflowPrompt(parsedCmd, cmdArgText, engineType) : undefined;
			if (expandedTemplate) {
				effectiveUserPrompt = expandedTemplate;
			} else if (expandedBuiltin) {
				effectiveUserPrompt = expandedBuiltin;
			} else {
				effectiveUserPrompt = `/${parsedCmd}${cmdArgText ? ` ${cmdArgText}` : ''}`;
			}
		} else {
			effectiveUserPrompt = request.prompt;
		}

		const { attachments, fileLines } = extractAttachmentsAndRefs(request.references);
		const userPromptWithRefs = fileLines.length
			? `${effectiveUserPrompt}\n\n${vscode.l10n.t('Attached files:')}\n${fileLines.join('\n')}`
			: effectiveUserPrompt;

		const preambleSections: string[] = [];
		const snapForContext = isSecretary ? undefined : roleBridge.getSnapshot().agents.find(a => a.resource === sessionUri.toString());
		const currentRankForContext = isSecretary ? 'secretary' : (snapForContext?.isOrchestrated ? snapForContext.rank : undefined);
		const alreadyInitializedForRank = Boolean(
			currentRankForContext
			&& record.roleInit
			&& record.roleInit.engine === record.engine
			&& record.roleInit.rank === currentRankForContext,
		);
		const injected = !currentRankForContext
			? undefined
			: await Promise.resolve(vscode.commands.executeCommand<string | undefined>(
				'aexus.ade.resolvePromptContext',
				alreadyInitializedForRank ? { resource: sessionUri, mode: 'delta' } : sessionUri,
			)).catch(() => undefined);
		if (injected?.trim()) {
			preambleSections.push(injected.trim());
		}

		if (record.cloudProjectUri) {
			const parsedCloud = vscode.Uri.parse(record.cloudProjectUri);
			const sshInfo = await Promise.resolve(vscode.commands.executeCommand<{ effectiveSshConfigPath?: string; os?: string } | undefined>(
				'aexus.ade.getCloudHostSshContext',
				parsedCloud.authority,
			)).catch(() => undefined);
			const sshCfgFlag = sshInfo?.effectiveSshConfigPath ? `-F "${sshInfo.effectiveSshConfigPath}" ` : '';
			const remotePath = parsedCloud.path || '/';
			const quotedRemotePath = `'${remotePath.replace(/'/g, `'\\''`)}'`;
			preambleSections.push([
				`[Aexus Cloud Host Project Context]`,
				`- Active Project is on SSH Cloud Host \`${parsedCloud.authority}\` at remote directory \`${remotePath}\` (URI: \`${record.cloudProjectUri}\`, OS: \`${sshInfo?.os ?? 'linux'}\`).`,
				`- Local harness staging directory on this Mac: \`${record.cwd}\`.`,
				`- Execute shell commands, builds, tests, and file edits on the Cloud Host via SSH: \`ssh ${sshCfgFlag}${parsedCloud.authority} "cd -- ${quotedRemotePath} && <command>"\` (or \`scp\`/\`rsync\` when transferring artifacts).`,
			].join('\n'));
		}

		if (record.activeGoal) {
			preambleSections.push([
				`[Autonomous Session Goal Active]`,
				`Goal Condition: ${record.activeGoal}`,
				`- Execute thoroughly and verify all requirements end-to-end before stopping.`,
				`- Only when EVERY requirement of the goal is 100% complete and verified, output the exact completion marker \`${GOAL_COMPLETE_MARKER}\` at the very end of your response.`,
			].join('\n'));
		}

		const initialFullPrompt = preambleSections.length > 0
			? `${preambleSections.join('\n\n')}\n\n${AEXUS_PREAMBLE_END_MARKER}\n\n${userPromptWithRefs}`
			: userPromptWithRefs;

		try {
			if (!await ensureEngineCommand(record.engine)) {
				stream.markdown(buildMissingEngineMarkdown(record.engine));
				promptConfigureCliPaths(formatMissingEngineMessage(record.engine));
				return {};
			}
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
			let roundMarkdown = '';
			let pendingGoalText = '';
			let lastHeartbeatSent = 0;
			const emitHeartbeat = () => {
				const now = Date.now();
				if (now - lastHeartbeatSent >= 1500) {
					lastHeartbeatSent = now;
					void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.workerHeartbeat', sessionUri.toString(), now)).catch(() => undefined);
				}
			};
			const findMarkerPrefixTailLength = (text: string): number => {
				const maxLen = Math.min(text.length, GOAL_COMPLETE_MARKER.length);
				for (let len = maxLen; len >= 1; len--) {
					const suffix = text.slice(text.length - len);
					if (GOAL_COMPLETE_MARKER.startsWith(suffix)) {
						return len;
					}
				}
				return 0;
			};
			const flushPendingGoalText = (finalFlush: boolean) => {
				if (!pendingGoalText) {
					return;
				}
				pendingGoalText = pendingGoalText.replace(new RegExp(`\\n*${GOAL_COMPLETE_MARKER}\\s*`, 'g'), '');
				if (!pendingGoalText) {
					return;
				}
				if (finalFlush || !record.activeGoal) {
					const out = pendingGoalText;
					pendingGoalText = '';
					if (out) {
						streamedMarkdown += out;
						stream.markdown(out);
					}
					return;
				}
				const holdLen = findMarkerPrefixTailLength(pendingGoalText);
				// Also hold up to 2 preceding newlines right before a partial marker prefix so trailing blank lines strip cleanly
				let totalHold = holdLen;
				if (holdLen > 0) {
					while (totalHold < pendingGoalText.length && totalHold - holdLen < 2 && pendingGoalText[pendingGoalText.length - totalHold - 1] === '\n') {
						totalHold++;
					}
				}
				const safeLen = pendingGoalText.length - totalHold;
				if (safeLen > 0) {
					const safeOut = pendingGoalText.slice(0, safeLen);
					pendingGoalText = pendingGoalText.slice(safeLen);
					streamedMarkdown += safeOut;
					stream.markdown(safeOut);
				}
			};
			const proxyTarget: vscode.ChatResponseStream = Object.create(null);
			const wrappedStream: vscode.ChatResponseStream = new Proxy(proxyTarget, {
				get(_dummy, prop) {
					if (prop === 'markdown') {
						return (value: string | vscode.MarkdownString) => {
							const chunkText = typeof value === 'string' ? value : value.value;
							if (chunkText) {
								roundMarkdown += chunkText;
								emitHeartbeat();
							}
							if (!record.activeGoal) {
								if (chunkText) {
									streamedMarkdown += chunkText;
								}
								stream.markdown(value);
								return;
							}
							if (typeof value === 'string') {
								pendingGoalText += value;
								flushPendingGoalText(false);
							} else {
								flushPendingGoalText(true);
								const cleaned = value.value.replace(new RegExp(`\\n*${GOAL_COMPLETE_MARKER}\\s*`, 'g'), '');
								if (cleaned) {
									streamedMarkdown += cleaned;
									const copy = new vscode.MarkdownString(cleaned, value.supportThemeIcons);
									copy.isTrusted = value.isTrusted;
									copy.supportHtml = value.supportHtml;
									copy.baseUri = value.baseUri;
									stream.markdown(copy);
								}
							}
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
			const sendOptions = toSendOptions(cfg, {
				attachments,
				pureWorker: !isSecretary && !snapEntry?.isOrchestrated,
				callerRole,
			});

			const turnStartedAt = Date.now();
			await engine.send(record, initialFullPrompt, wrappedStream, turnCancellation.token, sendOptions);
			flushPendingGoalText(true);

			// Autonomous /goal verification & continuation stop-hook loop
			let goalRound = 1;
			while (
				record.activeGoal
				&& !turnCancellation.token.isCancellationRequested
				&& !roundMarkdown.includes(GOAL_COMPLETE_MARKER)
				&& goalRound < MAX_GOAL_ROUNDS
			) {
				goalRound++;
				const currentGoal = record.activeGoal;
				stream.progress(`Verifying autonomous goal completion (Round ${goalRound}/${MAX_GOAL_ROUNDS})…`);
				stream.markdown(`\n\n---\n*Goal Check (Round ${goalRound}/${MAX_GOAL_ROUNDS})*\n\n`);
				roundMarkdown = '';
				const continuationPrompt = [
					...(injected?.trim() ? [injected.trim(), ''] : []),
					`[Autonomous Goal Stop-Check — Round ${goalRound}/${MAX_GOAL_ROUNDS}]`,
					`Active Goal: ${currentGoal}`,
					`You stopped without emitting \`${GOAL_COMPLETE_MARKER}\`.`,
					`1. Audit every requirement of the Active Goal against actual workspace state and verification results.`,
					`2. If ANY work, edge case, or verification remains incomplete, complete it right now.`,
					`3. Once 100% of the Active Goal is verified complete, summarize the final verified state and end with \`${GOAL_COMPLETE_MARKER}\`.`,
				].join('\n');
				await engine.send(record, continuationPrompt, wrappedStream, turnCancellation.token, {
					...sendOptions,
					attachments: undefined,
				});
				flushPendingGoalText(true);
			}

			if (record.activeGoal && roundMarkdown.includes(GOAL_COMPLETE_MARKER)) {
				record.activeGoal = undefined;
				setGoalBannerInUi(sessionUri, undefined);
			}

			const turnUsage = resolveCompletedTurnUsage(engine, record.id, initialFullPrompt, streamedMarkdown, turnStartedAt);
			if (!isSecretary && turnUsage.totalTokens > 0) {
				void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.recordTurnUsage', { sessionResource: sessionUri.toString(), usage: turnUsage })).catch(() => undefined);
			}

			if (streamedMarkdown.trim()) {
				lastTurnReplies.set(identity(record), streamedMarkdown.trim());
				if (isSecretary) {
					lastTurnReplies.set(SECRETARY_TYPE, streamedMarkdown.trim());
				}
			}
			if (!alreadyInitializedForRank && currentRankForContext) {
				record.roleInit = {
					rank: currentRankForContext,
					engine: record.engine,
					initializedAt: Date.now(),
				};
			}
			record.updated = Date.now();
			if (!isSecretary && !record.customLabel && record.initialTitle && record.label === record.initialTitle) {
				const titleSource = parsedCmd === 'goal' ? `/goal ${cmdArgText}` : effectiveUserPrompt;
				record.label = titleSource.split('\n')[0].slice(0, 100) || record.label;
			}
			// Refresh runtime capabilities asynchronously after turn (captures newly discovered init commands/models)
			void fetchRuntimeCaps(record.engine, record.cwd, record).then(({ changed }) => {
				if (changed) {
					void notifySessionOptionsUpdated(isSecretary ? SECRETARY_TYPE : engineType, sessionUri, true);
					customizationChangedEmitter.fire();
				}
			});
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

	const registerCustomizationProviderForType = (sessionType: string, label: string, iconId?: string) => {
		const api = vscode.chat as typeof vscode.chat & {
			registerChatSessionCustomizationProvider?: (
				chatSessionType: string,
				metadata: vscode.ChatSessionCustomizationProviderMetadata,
				provider: vscode.ChatSessionCustomizationProvider,
			) => vscode.Disposable;
		};
		if (typeof api.registerChatSessionCustomizationProvider !== 'function') {
			return;
		}
		const mapCustomizationType = (rawType: string): vscode.ChatSessionCustomizationType => {
			switch (rawType) {
				case 'skill': return vscode.ChatSessionCustomizationType.Skill;
				case 'agent': return vscode.ChatSessionCustomizationType.Agent;
				case 'instructions': return vscode.ChatSessionCustomizationType.Instructions;
				case 'hook': return vscode.ChatSessionCustomizationType.Hook;
				case 'plugin': return vscode.ChatSessionCustomizationType.Plugins;
				default: return vscode.ChatSessionCustomizationType.Prompt;
			}
		};
		context.subscriptions.push(api.registerChatSessionCustomizationProvider(
			sessionType,
			{
				label,
				iconId,
				supportedTypes: [
					vscode.ChatSessionCustomizationType.Skill,
					vscode.ChatSessionCustomizationType.Prompt,
					vscode.ChatSessionCustomizationType.Agent,
					vscode.ChatSessionCustomizationType.Instructions,
					vscode.ChatSessionCustomizationType.Hook,
					vscode.ChatSessionCustomizationType.Plugins,
				],
			},
			{
				onDidChange: customizationChangedEmitter.event,
				provideChatSessionCustomizations: async (sessionResource, _token) => {
					const isSec = sessionType === SECRETARY_TYPE || sessionResource.scheme === SECRETARY_TYPE;
					const rec = findCachedRecord(sessionResource) ?? (isSec ? await ensureSecretaryRecord().catch(() => undefined) : undefined);
					const shortEng = rec?.engine ?? (isSec ? (resolveShortEngine() ?? 'claude') : sessionType.slice('aexus-'.length));
					const effectiveEngineType = toEngineType(shortEng);
					const cwd = rec?.cwd ?? defaultCwd();
					const { caps } = await fetchRuntimeCaps(shortEng, cwd, rec);
					const files = await discoverCustomizationFiles(effectiveEngineType, cwd, caps.commands);
					return files.map((entry): vscode.ChatSessionCustomizationItem => ({
						uri: entry.uriPath.startsWith('agent-builtin://') ? vscode.Uri.parse(entry.uriPath) : vscode.Uri.file(entry.uriPath),
						type: mapCustomizationType(entry.type),
						name: entry.name,
						description: entry.description,
						source: entry.source,
						userInvocable: entry.userInvocable ?? (entry.type === 'skill' || entry.type === 'prompt'),
					}));
				},
			},
		));
	};

	// Register unified Secretary participant, customization provider & session provider with Aexus App Icon
	const aexusAppIconUri = vscode.Uri.joinPath(context.extensionUri, 'resources/aexus-icon.svg');
	const secretaryOptEmitter = new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
	const secretaryProviderOptEmitter = new vscode.EventEmitter<void>();
	optionChangeEmitters.set(SECRETARY_TYPE, secretaryOptEmitter);
	providerOptionsChangeEmitters.set(SECRETARY_TYPE, secretaryProviderOptEmitter);
	context.subscriptions.push(secretaryOptEmitter, secretaryProviderOptEmitter);

	const secretaryParticipant = vscode.chat.createChatParticipant(SECRETARY_TYPE, async (request, _chatContext, stream, token) => {
		const secRecord = await ensureSecretaryRecord();
		return send(secRecord, SECRETARY_URI, true, request, stream, token);
	});
	secretaryParticipant.iconPath = { light: aexusAppIconUri, dark: aexusAppIconUri };
	secretaryController.getChatSessionInputState = async sessionResource => {
		const groups = await computeOptionGroupsForResource(SECRETARY_TYPE, sessionResource ?? SECRETARY_URI);
		return trackInputState(SECRETARY_TYPE, secretaryController!, groups);
	};
	registerCustomizationProviderForType(SECRETARY_TYPE, 'Secretary', 'hubot');
	context.subscriptions.push(
		secretaryParticipant,
		secretaryController,
		vscode.chat.registerChatSessionContentProvider(SECRETARY_TYPE, {
			onDidChangeChatSessionOptions: secretaryOptEmitter.event,
			onDidChangeChatSessionProviderOptions: secretaryProviderOptEmitter.event,
			provideChatSessionProviderOptions: async () => {
				const groups = await computeOptionGroupsForResource(SECRETARY_TYPE, SECRETARY_URI);
				return {
					optionGroups: groups,
					newSessionOptions: toSessionOptionsRecord(groups),
				};
			},
			provideHandleOptionsChange: (uri, updates) => {
				void applyOptionUpdates(SECRETARY_TYPE, uri, updates, true, true);
			},
			provideChatSessionContent: async (_uri, token) => {
				const secRecord = await ensureSecretaryRecord();
				const turns = (await ensureEngineCommand(secRecord.engine))
					? await runtime(secRecord.engine).history(secRecord, token).catch(() => [] as HistoryEntry[])
					: [];
				await save();
				void fetchRuntimeCaps(secRecord.engine, secRecord.cwd, secRecord).then(({ changed }) => {
					if (changed) {
						void notifySessionOptionsUpdated(SECRETARY_TYPE, SECRETARY_URI, true);
					}
				});
				const groups = await computeOptionGroupsForResource(SECRETARY_TYPE, SECRETARY_URI);
				if (secRecord.activeGoal) {
					setTimeout(() => setGoalBannerInUi(SECRETARY_URI, secRecord.activeGoal), 80);
				}
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(SECRETARY_TYPE, entry);
				if ((secRecord.provisional || secRecord.unmaterialized) && turns.length === 0 && !secRecord.roleInit) {
					void ensureRoleInitialized(secRecord, SECRETARY_URI, true);
				} else if (inFlightRoleInits.has(identity(secRecord))) {
					setSessionInitializingInUi(SECRETARY_URI, vscode.l10n.t('Initializing {0} role & ADE control-plane context…', 'Secretary'));
				}
				return {
					title: 'Secretary',
					options: toSessionOptionsRecord(groups),
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

	// Register all 8 Coding Agent engine participants, customization providers & session providers
	for (const definition of available) {
		const participantId = definition.type;
		const optEmitter = new vscode.EventEmitter<vscode.ChatSessionOptionChangeEvent>();
		const providerOptEmitter = new vscode.EventEmitter<void>();
		optionChangeEmitters.set(participantId, optEmitter);
		providerOptionsChangeEmitters.set(participantId, providerOptEmitter);
		context.subscriptions.push(optEmitter, providerOptEmitter);

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
		controller.getChatSessionInputState = async sessionResource => {
			const groups = await computeOptionGroupsForResource(definition.type, sessionResource);
			return trackInputState(definition.type, controller, groups);
		};
		registerCustomizationProviderForType(definition.type, definition.name, definition.themeIcon);

		context.subscriptions.push(participant, controller, vscode.chat.registerChatSessionContentProvider(definition.type, {
			onDidChangeChatSessionOptions: optEmitter.event,
			onDidChangeChatSessionProviderOptions: providerOptEmitter.event,
			provideChatSessionProviderOptions: async () => {
				const groups = await computeOptionGroupsForResource(definition.type);
				return {
					optionGroups: groups,
					newSessionOptions: toSessionOptionsRecord(groups),
				};
			},
			provideHandleOptionsChange: (uri, updates) => {
				void applyOptionUpdates(definition.type, uri, updates, true, true);
			},
			provideChatSessionContent: async (uri, token) => {
				const record = await getRecord(uri, token);
				const turns = (await ensureEngineCommand(record.engine))
					? await runtime(record.engine).history(record, token).catch(() => [] as HistoryEntry[])
					: [];
				await save();
				void fetchRuntimeCaps(record.engine, record.cwd, record).then(({ changed }) => {
					if (changed) {
						void notifySessionOptionsUpdated(definition.type, uri, true);
					}
				});
				const groups = await computeOptionGroupsForResource(definition.type, uri);
				if (record.activeGoal) {
					setTimeout(() => setGoalBannerInUi(uri, record.activeGoal), 80);
				}
				const entry = { changed: new vscode.EventEmitter<vscode.ChatSession['history']>(), cancellation: new vscode.CancellationTokenSource() };
				opened.set(identity(record), entry);
				const snapOnOpen = roleBridge.getSnapshot().agents.find(a => a.resource === uri.toString());
				if (snapOnOpen?.isOrchestrated && (record.provisional || record.unmaterialized) && turns.length === 0 && !record.roleInit) {
					void ensureRoleInitialized(record, uri, false);
				} else if (inFlightRoleInits.has(identity(record))) {
					const roleTitle = (snapOnOpen?.rank ?? 'governor').charAt(0).toUpperCase() + (snapOnOpen?.rank ?? 'governor').slice(1);
					setSessionInitializingInUi(uri, vscode.l10n.t('Initializing {0} role & ADE control-plane context…', roleTitle));
				}
				return {
					title: record.label,
					options: toSessionOptionsRecord(groups),
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

	context.subscriptions.push(vscode.commands.registerCommand('aexus.agents.selectCustomModel', async (firstArg?: unknown, secondArg?: unknown) => {
		const sessionUri = firstArg instanceof vscode.Uri ? firstArg : undefined;
		const fallbackType = typeof firstArg === 'string' ? firstArg : typeof secondArg === 'string' ? secondArg : undefined;
		const sessionType = sessionUri
			? (sessionUri.scheme === SECRETARY_TYPE ? SECRETARY_TYPE : toEngineType(sessionUri.scheme))
			: (fallbackType ?? SECRETARY_TYPE);
		const targetUri = sessionUri ?? SECRETARY_URI;
		const isSec = sessionType === SECRETARY_TYPE || targetUri.scheme === SECRETARY_TYPE;
		const rec = findCachedRecord(targetUri) ?? (isSec ? await ensureSecretaryRecord().catch(() => undefined) : undefined);
		const currentCfg = rec ? getSessionConfig(rec, isSec) : undefined;
		const entered = await vscode.window.showInputBox({
			title: vscode.l10n.t('Enter Custom Model ID'),
			prompt: vscode.l10n.t('Enter the exact model identifier supported by the active Coding Agent engine (leave "default" to use engine default)'),
			value: currentCfg?.model && currentCfg.model !== 'default' ? currentCfg.model : '',
			placeHolder: vscode.l10n.t('e.g. gpt-6.1-sol, deepseek-v4-pro, group-openai/gpt-6'),
			ignoreFocusOut: true,
		});
		if (entered === undefined) {
			return;
		}
		const normalized = entered.trim() || 'default';
		await applyOptionUpdates(sessionType, targetUri, [{ optionId: 'model', value: normalized }], true, false);
	}));

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
				activeTurns.delete(identity(candidate));
				busy.delete(identity(candidate));
				opened.get(identity(candidate))?.cancellation.cancel();
				if (candidate !== record && available.some(entry => entry.id === candidate.engine && entry.command)) {
					await runtime(candidate.engine).killSession?.(candidate).catch(() => { });
					await runtime(candidate.engine).delete(candidate, token).catch(() => { });
				}
				records.delete(entryKey);
				controller?.items.delete(resource(candidate));
				count++;
			}
		}
		return count;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('aexus.agentEngines.clearSessionGoal', async (rawUri?: vscode.Uri | string) => {
			if (!rawUri) {
				return;
			}
			const uri = typeof rawUri === 'string' ? vscode.Uri.parse(rawUri) : rawUri;
			const rec = findCachedRecord(uri);
			if (rec && rec.activeGoal) {
				rec.activeGoal = undefined;
				await save();
			}
		}),
		vscode.commands.registerCommand('aexus.agentEngines.list', async () => {
			if (available.some(entry => !entry.command)) {
				await refreshAvailableEngines();
			}
			return available.map(definition => ({ id: definition.type, name: definition.name, available: !!definition.command }));
		}),
		vscode.commands.registerCommand('aexus.agentEngines.ensureSecretary', async (rawEngineId?: string, project?: vscode.Uri, forceReset?: boolean) => {
			const secRecord = await ensureSecretaryRecord(rawEngineId, project, Boolean(forceReset));
			void notifySessionOptionsUpdated(SECRETARY_TYPE, SECRETARY_URI);
			customizationChangedEmitter.fire();
			return {
				engineId: `aexus-${secRecord.engine}`,
				resource: SECRETARY_URI,
			};
		}),
		vscode.commands.registerCommand('aexus.agentEngines.create', async (engineId: string, project: vscode.Uri) => {
			const engine = engineId.slice('aexus-'.length);
			await ensureEngineCommand(engine);
			const { localCwd, cloudProjectUri } = await resolveProjectLocalCwd(project);
			const native = await runtime(engine).create(localCwd);
			const record: RecordEntry = {
				...native,
				engine,
				initialTitle: native.label,
				resourceId: native.id,
				sessionConfig: {},
				...(cloudProjectUri ? { cloudProjectUri } : {}),
			};
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
					if (!project || (project.scheme !== 'file' && project.scheme !== CLOUD_PROJECT_SCHEME)) {
						throw new Error(vscode.l10n.t('Conversation {0} was not found in {1}.', nativeId, engine));
					}
					const { localCwd, cloudProjectUri } = await resolveProjectLocalCwd(project);
					const now = Date.now();
					record = accept(engine, {
						id: nativeId,
						cwd: localCwd,
						label: vscode.l10n.t('{0} Session {1}', engine, nativeId.slice(0, 8)),
						created: now,
						updated: now,
						provisional: false,
					});
					if (cloudProjectUri) {
						record.cloudProjectUri = cloudProjectUri;
					}
					record.resourceId ??= record.id;
					await save();
					refresh(engine);
				} else if (project?.scheme === CLOUD_PROJECT_SCHEME && !record.cloudProjectUri) {
					const { cloudProjectUri } = await resolveProjectLocalCwd(project);
					record.cloudProjectUri = cloudProjectUri;
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
			const requestedCloud = project?.scheme === CLOUD_PROJECT_SCHEME
				? project.with({ path: project.path.replace(/\/+$/, '') || '/' }).toString()
				: undefined;
			const requestedCwd = project
				? await canonical(project.scheme === CLOUD_PROJECT_SCHEME ? computeCloudBridgeDirectory(project) : project.fsPath)
				: undefined;
			const result = [];
			for (const record of sessions) {
				if (record.parentId) { continue; }
				if (!project) {
					result.push(describe(record));
					continue;
				}
				if (requestedCloud && record.cloudProjectUri === requestedCloud) {
					result.push(describe(record));
					continue;
				}
				if (requestedCwd && requestedCwd === await canonical(record.cwd)) {
					result.push(describe(record));
				}
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
					projectUri: recordProjectUri(record),
					label: record.label,
					nativeId: record.id,
					provisional: Boolean(record.provisional),
					unmaterialized: Boolean(record.unmaterialized),
					engine: record.engine,
					sessionConfig: record.sessionConfig,
					activeGoal: record.activeGoal,
				};
			} finally { token.dispose(); }
		}),
		vscode.commands.registerCommand('aexus.agentEngines.history', async (uri: vscode.Uri, limit?: number) => {
			const token = new vscode.CancellationTokenSource();
			try {
				const record = await getRecord(uri, token.token);
				const rawTurns = (await ensureEngineCommand(record.engine))
					? await runtime(record.engine).history(record, token.token).catch(() => [] as HistoryEntry[])
					: [];
				const turns = filterAndCleanHistoryTurns(rawTurns);
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
			const cwd = defaultCwd();
			const legacyKeys: Record<EngineId, string[]> = {
				'aexus-claude': ['claude-code', 'aexus-claude'],
				'aexus-codex': ['codex', 'aexus-codex'],
				'aexus-kilo': ['kilo', 'aexus-kilo'],
				'aexus-opencode': ['opencode', 'aexus-opencode'],
				'aexus-dsh': ['dsh', 'aexus-dsh'],
				'aexus-antigravity': ['antigravity', 'aexus-antigravity'],
				'aexus-cline': ['cline', 'aexus-cline'],
				'aexus-pi': ['pi', 'aexus-pi'],
			};
			for (const def of definitions) {
				const caps = runtimeCapsCache.get(`${def.id}:${cwd}`);
				const items = (await discoverEngineModels(def.type, cwd, caps?.models))
					.filter(m => m.id !== 'default')
					.map(m => ({ id: m.id, label: m.name !== m.id ? `${m.name} (${m.id})` : m.id }));
				if (items.length > 0) {
					for (const aliasKey of legacyKeys[def.type]) {
						out[aliasKey] = items;
					}
				}
			}
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

			const initialEngRecordKey = identity(record);
			const pendingEngInit = inFlightRoleInits.get(initialEngRecordKey);
			if (pendingEngInit) {
				await pendingEngInit;
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
				const snapEntry = roleBridge.getSnapshot().agents.find(a => a.id === rawOptions?.agentId || a.resource === uri.toString());
				callerRole = rawOptions?.callerRole ?? snapEntry?.rank;
				const alreadyInit = Boolean(
					callerRole
					&& record.roleInit
					&& record.roleInit.engine === record.engine
					&& record.roleInit.rank === callerRole,
				);
				const injected = await Promise.resolve(vscode.commands.executeCommand<string | undefined>(
					'aexus.ade.resolvePromptContext',
					alreadyInit
						? { ...(rawOptions?.agentId ? { agentId: rawOptions.agentId } : {}), resource: uri, mode: 'delta' }
						: (rawOptions?.agentId ? { agentId: rawOptions.agentId, resource: uri } : uri),
				)).catch(() => undefined);
				if (injected?.trim()) {
					finalPrompt = `${injected.trim()}\n\n${AEXUS_PREAMBLE_END_MARKER}\n\n${rawPrompt}`;
				}
				if (!alreadyInit && callerRole) {
					record.roleInit = { rank: callerRole, engine: record.engine, initializedAt: Date.now() };
				}
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

			const turnStartedAt = Date.now();
			const reportedSoFar = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
			let lastInterimReportAt = 0;
			const reportInterimUsage = (cumulative: EngineTurnTokenUsage) => {
				const now = Date.now();
				if (now - lastInterimReportAt < 1200) {
					return;
				}
				const delta = {
					inputTokens: Math.max(0, cumulative.inputTokens - reportedSoFar.inputTokens),
					outputTokens: Math.max(0, cumulative.outputTokens - reportedSoFar.outputTokens),
					cacheReadTokens: Math.max(0, (cumulative.cacheReadTokens ?? 0) - reportedSoFar.cacheReadTokens),
					cacheWriteTokens: Math.max(0, (cumulative.cacheWriteTokens ?? 0) - reportedSoFar.cacheWriteTokens),
					totalTokens: Math.max(0, cumulative.totalTokens - reportedSoFar.totalTokens),
				};
				if (delta.totalTokens === 0 && delta.inputTokens === 0 && delta.outputTokens === 0) {
					return;
				}
				lastInterimReportAt = now;
				reportedSoFar.inputTokens += delta.inputTokens;
				reportedSoFar.outputTokens += delta.outputTokens;
				reportedSoFar.cacheReadTokens += delta.cacheReadTokens;
				reportedSoFar.cacheWriteTokens += delta.cacheWriteTokens;
				reportedSoFar.totalTokens += delta.totalTokens;
				void Promise.resolve(vscode.commands.executeCommand('aexus.ade.engineering.recordTurnUsage', {
					sessionResource: uri.toString(),
					agentId: rawOptions?.agentId,
					usage: { ...delta, turns: 0 },
				})).catch(() => undefined);
			};
			const finalizeTurnUsage = (engine: EngineRuntime, replyText: string) => {
				const finalUsage = resolveCompletedTurnUsage(engine, record.id, finalPrompt, replyText, turnStartedAt);
				return {
					inputTokens: Math.max(0, finalUsage.inputTokens - reportedSoFar.inputTokens),
					outputTokens: Math.max(0, finalUsage.outputTokens - reportedSoFar.outputTokens),
					cacheReadTokens: Math.max(0, (finalUsage.cacheReadTokens ?? 0) - reportedSoFar.cacheReadTokens),
					cacheWriteTokens: Math.max(0, (finalUsage.cacheWriteTokens ?? 0) - reportedSoFar.cacheWriteTokens),
					totalTokens: Math.max(0, finalUsage.totalTokens - reportedSoFar.totalTokens),
					durationMs: finalUsage.durationMs,
					costUsd: finalUsage.costUsd,
					turns: 1,
					estimated: finalUsage.estimated,
				};
			};
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
				const cfg = record.sessionConfig ?? {};
				await engine.send(record, finalPrompt, headlessStream, turnCancellation.token, {
					model: rawOptions?.model ?? (cfg.model && cfg.model !== 'default' ? cfg.model : undefined),
					thinking: rawOptions?.thinking ?? (cfg.thinking && cfg.thinking !== 'default' ? cfg.thinking : undefined),
					mode: cfg.mode && cfg.mode !== 'default' ? cfg.mode : undefined,
					permissionMode: cfg.permissionMode && cfg.permissionMode !== 'default' ? cfg.permissionMode : undefined,
					sandboxMode: cfg.sandboxMode && cfg.sandboxMode !== 'default' ? cfg.sandboxMode : undefined,
					webSearch: cfg.webSearch,
					pureWorker: isPureWorker,
					callerRole,
					automatedEngineering: true,
					onInterimUsage: reportInterimUsage,
				});
				if (streamedMarkdown.trim()) {
					lastTurnReplies.set(identity(record), streamedMarkdown.trim());
				}
				record.updated = Date.now();
				return {
					reply: streamedMarkdown.trim(),
					nativeId: record.id,
					stopped: turnCancellation.token.isCancellationRequested,
					usage: finalizeTurnUsage(engine, streamedMarkdown),
				};
			} catch (error) {
				if (turnCancellation.token.isCancellationRequested) {
					return {
						reply: streamedMarkdown.trim(),
						nativeId: record.id,
						stopped: true,
						usage: finalizeTurnUsage(runtime(record.engine), streamedMarkdown),
					};
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
				const targetCloud = project.scheme === CLOUD_PROJECT_SCHEME
					? project.with({ path: project.path.replace(/\/+$/, '') || '/' }).toString()
					: undefined;
				const targetCwd = await canonical(project.scheme === CLOUD_PROJECT_SCHEME ? computeCloudBridgeDirectory(project) : project.fsPath);
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
					if ((targetCloud && candidate.cloudProjectUri === targetCloud) || await canonical(candidate.cwd) === targetCwd) {
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

	const syncPreferencesFromSnapshot = (snapshot: RoleSyncSnapshot) => {
		let dirty = false;
		for (const agentEntry of snapshot.agents) {
			if (!agentEntry.resource) {
				continue;
			}
			let uri: vscode.Uri;
			try {
				uri = vscode.Uri.parse(agentEntry.resource);
			} catch {
				continue;
			}
			const rec = findCachedRecord(uri);
			if (!rec) {
				continue;
			}
			const cfg = (rec.sessionConfig ??= {});
			let recUpdated = false;
			if (agentEntry.preferredModel && (!cfg.model || cfg.model === 'default') && cfg.model !== agentEntry.preferredModel) {
				cfg.model = agentEntry.preferredModel;
				recUpdated = true;
			}
			if (agentEntry.preferredThinking && (!cfg.thinking || cfg.thinking === 'default')) {
				const mappedThinking = agentEntry.preferredThinking === 'none' ? 'off' : agentEntry.preferredThinking;
				if (cfg.thinking !== mappedThinking) {
					cfg.thinking = mappedThinking;
					recUpdated = true;
				}
			}
			if (recUpdated) {
				dirty = true;
				void notifySessionOptionsUpdated(`aexus-${rec.engine}`, uri);
			}
		}
		if (dirty) {
			void save();
		}
	};

	const enrichRoleSnapshot = async (raw: RoleSyncSnapshot): Promise<RoleSyncSnapshot> => {
		syncPreferencesFromSnapshot(raw);
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
			const enriched = await enrichRoleSnapshot(rawSnapshot);
			await roleBridge.updateSnapshot(enriched);
			if (enriched.mode === 'ade') {
				for (const agentEntry of enriched.agents) {
					if (!agentEntry.isOrchestrated || !agentEntry.resource || !agentEntry.engineId?.startsWith('aexus-')) {
						continue;
					}
					try {
						const agentUri = vscode.Uri.parse(agentEntry.resource);
						const rec = findCachedRecord(agentUri);
						if (rec && (rec.provisional || rec.unmaterialized) && !rec.roleInit) {
							void ensureRoleInitialized(rec, agentUri, false);
						}
					} catch { /* Ignore malformed URI. */ }
				}
			}
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
