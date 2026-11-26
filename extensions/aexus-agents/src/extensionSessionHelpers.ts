/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AntigravityRuntime, ClineRuntime, DshRuntime } from './acp';
import {
	DiscoveredOptionGroup,
	DiscoveredSlashCommand,
	EngineId,
	SessionConfigState,
} from './capabilities';
import { ClaudeRuntime } from './claude';
import {
	CLOUD_PROJECT_SCHEME,
	CloudHostTarget,
	normalizeCloudAuthority,
	normalizeCloudProjectUriString,
	parseCloudProjectUri,
	toRemoteNativePath,
} from './cloudTransport';
import { CodexRuntime } from './codex';
import { KiloRuntime, OpenCodeRuntime } from './kilo';
import { PiRuntime } from './pi';
import {
	ENGINE_INSTALL_GUIDES,
	EngineAttachment,
	EngineRuntime,
	EngineSendOptions,
	EngineTurnTokenUsage,
	estimateTextTokens,
	isAutonomousModeEnabled,
	NativeSession,
} from './runtime';

export interface RecordEntry extends NativeSession {
	engine: string;
	initialTitle?: string;
	customLabel?: boolean;
	resourceId?: string;
	nativeId?: string;
	sessionConfig?: SessionConfigState;
	cloudProjectUri?: string;
	adeProjectId?: string;
	adeAgentId?: string;
	adeHost?: string;
	/** Transient in-memory guard while a session is inside `prepareSession()` / `send()` (never persisted to `state.vscdb`). */
	preparingOrSending?: boolean;
}

export interface EngineDefinition {
	readonly id: string;
	readonly executable: string;
	readonly name: string;
	readonly type: EngineId;
	readonly themeIcon?: string;
	readonly svgIcon?: string;
	readonly create: (command: string, remoteTarget?: CloudHostTarget) => EngineRuntime;
}

export const ENGINE_ALIASES: Record<string, string> = {
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

export const definitions: readonly EngineDefinition[] = [
	{ id: 'claude', executable: 'claude', name: 'Claude Code', type: 'aexus-claude', themeIcon: 'claude', svgIcon: 'claude', create: (command, remoteTarget) => new ClaudeRuntime(command, remoteTarget) },
	{ id: 'codex', executable: 'codex', name: 'Codex', type: 'aexus-codex', themeIcon: 'openai', svgIcon: 'codex', create: (command, remoteTarget) => new CodexRuntime(command, remoteTarget) },
	{ id: 'kilo', executable: 'kilo', name: 'Kilo Code', type: 'aexus-kilo', svgIcon: 'kilo', create: (command, remoteTarget) => new KiloRuntime(command, remoteTarget) },
	{ id: 'opencode', executable: 'opencode', name: 'OpenCode', type: 'aexus-opencode', svgIcon: 'opencode', create: (command, remoteTarget) => new OpenCodeRuntime(command, remoteTarget) },
	{ id: 'dsh', executable: 'dsh', name: 'DeepSeek Harness', type: 'aexus-dsh', svgIcon: 'dsh', create: (command, remoteTarget) => new DshRuntime(command, remoteTarget) },
	{ id: 'antigravity', executable: 'agy', name: 'Google Antigravity', type: 'aexus-antigravity', svgIcon: 'antigravity', create: (command, remoteTarget) => new AntigravityRuntime(command, remoteTarget) },
	{ id: 'cline', executable: 'cline', name: 'Cline', type: 'aexus-cline', svgIcon: 'cline', create: (command, remoteTarget) => new ClineRuntime(command, remoteTarget) },
	{ id: 'pi', executable: 'pi', name: 'Pi', type: 'aexus-pi', svgIcon: 'pi', create: (command, remoteTarget) => new PiRuntime(command, remoteTarget) },
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

export function resolveDefaultModeForEngine(engineType: EngineId, autonomous: boolean): string | undefined {
	if (engineType === 'aexus-cline') {
		return autonomous ? 'yolo' : 'ask';
	}
	if (engineType === 'aexus-antigravity') {
		return autonomous ? 'auto' : 'ask';
	}
	if (engineType === 'aexus-pi') {
		return 'full';
	}
	return undefined;
}

export function resolveDefaultPermissionsForEngine(engineType: EngineId, autonomous: boolean): string {
	if (engineType === 'aexus-codex') {
		return autonomous ? 'never' : 'on-request';
	}
	if (engineType === 'aexus-claude') {
		return autonomous ? 'bypassPermissions' : 'acceptEdits';
	}
	if (engineType === 'aexus-dsh') {
		return autonomous ? 'danger-full-access' : 'ask';
	}
	return autonomous ? 'bypassPermissions' : 'ask';
}

export function resolveDefaultSandboxForEngine(autonomous: boolean): string {
	return autonomous ? 'danger-full-access' : 'workspace-write';
}

export function withSafeDefaultConfig(engineType: EngineId, cfg: SessionConfigState): SessionConfigState {
	const autonomous = isAutonomousModeEnabled();
	if (autonomous) {
		return cfg;
	}
	const defaultMode = resolveDefaultModeForEngine(engineType, false);
	const defaultPerm = resolveDefaultPermissionsForEngine(engineType, false);
	const defaultSandbox = resolveDefaultSandboxForEngine(false);
	return {
		...cfg,
		...(defaultMode && (!cfg.mode || cfg.mode === 'default') ? { mode: defaultMode } : {}),
		...((!cfg.permissionMode || cfg.permissionMode === 'default') ? { permissionMode: defaultPerm } : {}),
		...(engineType === 'aexus-codex' && (!cfg.sandboxMode || cfg.sandboxMode === 'default') ? { sandboxMode: defaultSandbox } : {}),
	};
}

export function recordProjectUri(record: RecordEntry): vscode.Uri {
	return record.cloudProjectUri ? vscode.Uri.parse(record.cloudProjectUri) : vscode.Uri.file(record.cwd);
}

export function recordCloudAuthority(record: Pick<RecordEntry, 'cloudProjectUri'> | undefined): string | undefined {
	const parsed = parseCloudProjectUri(record?.cloudProjectUri);
	return parsed ? normalizeCloudAuthority(parsed.authority) : undefined;
}

export function remoteNativePathToCloudUri(alias: string, remotePath: string, hostOs: CloudHostTarget['os']): string {
	const cleaned = (remotePath || '/').trim();
	let uriPath: string;
	if (hostOs === 'windows') {
		const fwd = cleaned.replace(/\\/g, '/');
		uriPath = fwd.startsWith('/') ? fwd : `/${fwd}`;
	} else {
		uriPath = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
	}
	return normalizeCloudProjectUriString(vscode.Uri.from({ scheme: CLOUD_PROJECT_SCHEME, authority: alias, path: uriPath }));
}

export function parseOptionalUri(raw: vscode.Uri | string | undefined): vscode.Uri | undefined {
	if (!raw) {
		return undefined;
	}
	if (raw instanceof vscode.Uri) {
		return raw;
	}
	if (typeof raw === 'string' && raw.trim()) {
		try {
			return vscode.Uri.parse(raw);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function formatRecordProjectLabel(record: RecordEntry): string {
	if (record.cloudProjectUri) {
		const parsed = vscode.Uri.parse(record.cloudProjectUri);
		return `${parsed.authority}:${parsed.path || '/'}`;
	}
	return record.cwd;
}

export async function resolveCliBinDir(extensionPath: string): Promise<string> {
	const binName = process.platform === 'win32' ? 'ade_whoami.cmd' : 'ade_whoami';
	const candidates = [
		path.join(vscode.env.appRoot, 'bin'),
		path.resolve(vscode.env.appRoot, '..', '..', 'bin'),
		path.resolve(vscode.env.appRoot, '..', '..', '..', 'bin'),
		path.join(path.dirname(process.execPath), 'bin'),
	];
	for (const candidate of candidates) {
		try {
			await fs.access(path.join(candidate, binName));
			return candidate;
		} catch {
			// continue
		}
	}
	return path.join(extensionPath, 'bin');
}

export function parseAdeAgentResourceIds(resourceId: string | undefined): { readonly projectId: string; readonly agentId: string } | undefined {
	if (!resourceId) {
		return undefined;
	}
	const withoutScheme = resourceId.trim().replace(/^aexus-[a-z0-9_-]+:\/*/i, '');
	const cleaned = withoutScheme.replace(/^\/+/, '');
	if (!cleaned.startsWith('ade-')) {
		return undefined;
	}
	const rest = cleaned.slice('ade-'.length);
	if (!rest || rest.includes('/')) {
		return undefined;
	}
	// Backward compatibility for legacy `ade-${projectId}::${agentId}` records
	const legacySepIdx = rest.indexOf('::');
	if (legacySepIdx > 0 && legacySepIdx + 2 < rest.length) {
		const projectId = rest.slice(0, legacySepIdx);
		const agentId = rest.slice(legacySepIdx + 2);
		return projectId && agentId ? { projectId, agentId } : undefined;
	}
	// Backward compatibility for legacy double-hyphen `ade-${projectId}--${agentId}` records
	const doubleDashIdx = rest.indexOf('--');
	if (doubleDashIdx > 0 && doubleDashIdx + 2 < rest.length) {
		const projectId = rest.slice(0, doubleDashIdx);
		const agentId = rest.slice(doubleDashIdx + 2);
		if (projectId && agentId && !projectId.endsWith('-') && !agentId.startsWith('-')) {
			return { projectId, agentId };
		}
	}
	// Canonical single-hyphen URI aligned with `parseAdeEmployeeSessionUri` (`ade.ts`)
	const agentIdx = rest.lastIndexOf('-agent_');
	if (agentIdx > 0 && agentIdx < rest.length - 1) {
		return {
			projectId: rest.slice(0, agentIdx),
			agentId: rest.slice(agentIdx + 1),
		};
	}
	const projPrefixMatch = /^(proj_[A-Za-z0-9_]+)-(.+)$/.exec(rest);
	if (projPrefixMatch && projPrefixMatch[1] && projPrefixMatch[2]) {
		return {
			projectId: projPrefixMatch[1],
			agentId: projPrefixMatch[2],
		};
	}
	const sep = rest.indexOf('-');
	if (sep > 0 && sep < rest.length - 1) {
		return {
			projectId: rest.slice(0, sep),
			agentId: rest.slice(sep + 1),
		};
	}
	return undefined;
}

export function toEngineType(shortOrFull: string): EngineId {
	const normalized = shortOrFull.startsWith('aexus-') ? shortOrFull : `aexus-${shortOrFull}`;
	const found = definitions.find(d => d.type === normalized);
	return found ? found.type : 'aexus-claude';
}

export function toVsCodeOptionGroups(discovered: readonly DiscoveredOptionGroup[], sessionType: string): vscode.ChatSessionProviderOptionGroup[] {
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

export function toSessionOptionsRecord(groups: readonly vscode.ChatSessionProviderOptionGroup[]): Record<string, vscode.ChatSessionProviderOptionItem> {
	const out: Record<string, vscode.ChatSessionProviderOptionItem> = {};
	for (const group of groups) {
		const selected = group.selected ?? group.items[0];
		if (selected) {
			out[group.id] = selected;
		}
	}
	return out;
}

export function toSendOptions(cfg: SessionConfigState | undefined, extra: {
	pureWorker?: boolean;
	adeProjectId?: string;
	adeAgentId?: string;
	adeSessionResource?: string;
	adeAgentToken?: string;
	adeControlSocketPath?: string;
	adeRemoteControlEndpoint?: string;
	adeRemoteBridgeFile?: string;
	automatedEngineering?: boolean;
	attachments?: readonly EngineAttachment[];
	onInterimUsage?: (cumulativeTurnUsage: EngineTurnTokenUsage) => void;
	onContextCompacted?: () => void;
	abortSignal?: AbortSignal;
	timeoutMs?: number;
	onStreamActivity?: () => void;
	onExternalWaitStart?: () => void;
	onExternalWaitEnd?: () => void;
}): EngineSendOptions {
	return {
		model: cfg?.model && cfg.model !== 'default' ? cfg.model : undefined,
		thinking: cfg?.thinking && cfg.thinking !== 'default' ? cfg.thinking : undefined,
		mode: cfg?.mode && cfg.mode !== 'default' ? cfg.mode : undefined,
		permissionMode: cfg?.permissionMode && cfg.permissionMode !== 'default' ? cfg.permissionMode : undefined,
		sandboxMode: cfg?.sandboxMode && cfg.sandboxMode !== 'default' ? cfg.sandboxMode : undefined,
		webSearch: cfg?.webSearch,
		attachments: extra.attachments,
		pureWorker: extra.pureWorker,
		adeProjectId: extra.adeProjectId,
		adeAgentId: extra.adeAgentId,
		adeSessionResource: extra.adeSessionResource,
		adeAgentToken: extra.adeAgentToken,
		adeControlSocketPath: extra.adeControlSocketPath,
		adeRemoteControlEndpoint: extra.adeRemoteControlEndpoint,
		adeRemoteBridgeFile: extra.adeRemoteBridgeFile,
		automatedEngineering: extra.automatedEngineering,
		onInterimUsage: extra.onInterimUsage,
		onContextCompacted: extra.onContextCompacted,
		abortSignal: extra.abortSignal,
		timeoutMs: extra.timeoutMs,
		onStreamActivity: extra.onStreamActivity,
		onExternalWaitStart: extra.onExternalWaitStart,
		onExternalWaitEnd: extra.onExternalWaitEnd,
	};
}

export function resolveCompletedTurnUsage(engine: EngineRuntime, sessionId: string, promptText: string, replyText: string, startedAt: number): EngineTurnTokenUsage {
	const reported = engine.consumeLastTurnUsage?.(sessionId);
	if (reported && reported.totalTokens > 0) {
		return reported;
	}
	const inputTokens = estimateTextTokens(promptText);
	const outputTokens = estimateTextTokens(replyText);
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

export function extractAttachmentsAndRefs(
	references: readonly vscode.ChatPromptReference[],
	cloudTarget?: CloudHostTarget,
): { attachments: EngineAttachment[]; fileLines: string[] } {
	const attachments: EngineAttachment[] = [];
	const fileLines: string[] = [];
	const seenPaths = new Set<string>();
	for (const ref of references) {
		if (ref.value instanceof vscode.Uri) {
			if (ref.value.scheme === CLOUD_PROJECT_SCHEME && cloudTarget && normalizeCloudAuthority(ref.value.authority) === cloudTarget.authority) {
				const remotePath = toRemoteNativePath(ref.value.path || '/', cloudTarget.os, cloudTarget.remoteHome);
				if (seenPaths.has(remotePath)) {
					continue;
				}
				seenPaths.add(remotePath);
				const ext = path.posix.extname(ref.value.path || '').toLowerCase();
				const imageMime = IMAGE_MIME_BY_EXT[ext];
				attachments.push({ kind: imageMime ? 'image' : 'file', filePath: remotePath, mimeType: imageMime, remote: true });
				fileLines.push(remotePath);
			} else if (ref.value.scheme === 'file') {
				const fsPath = ref.value.fsPath;
				if (seenPaths.has(fsPath)) {
					continue;
				}
				seenPaths.add(fsPath);
				const ext = path.extname(fsPath).toLowerCase();
				const imageMime = IMAGE_MIME_BY_EXT[ext];
				if (imageMime) {
					attachments.push({ kind: imageMime ? 'image' : 'file', filePath: fsPath, mimeType: imageMime, remote: false });
					if (!cloudTarget) {
						fileLines.push(fsPath);
					}
				} else if (!cloudTarget) {
					attachments.push({ kind: 'file', filePath: fsPath, remote: false });
					fileLines.push(fsPath);
				}
			}
		} else if (ref.value instanceof vscode.Location) {
			if (ref.value.uri.scheme === CLOUD_PROJECT_SCHEME && cloudTarget && normalizeCloudAuthority(ref.value.uri.authority) === cloudTarget.authority) {
				const remotePath = toRemoteNativePath(ref.value.uri.path || '/', cloudTarget.os, cloudTarget.remoteHome);
				const locText = `${remotePath}:${ref.value.range.start.line + 1}`;
				attachments.push({ kind: 'file', filePath: remotePath, rangeText: locText, remote: true });
				fileLines.push(locText);
			} else if (ref.value.uri.scheme === 'file' && !cloudTarget) {
				const locText = `${ref.value.uri.fsPath}:${ref.value.range.start.line + 1}`;
				attachments.push({ kind: 'file', filePath: ref.value.uri.fsPath, rangeText: locText, remote: false });
				fileLines.push(locText);
			}
		}
	}
	return { attachments, fileLines };
}

export function buildSlashHelpMarkdown(
	engineName: string,
	cfg: SessionConfigState | undefined,
	commandsList: readonly DiscoveredSlashCommand[],
): string {
	const lines: string[] = [
		`### ${engineName} — Capabilities & Slash Commands`,
		'',
		`- **Model**: \`${cfg?.model || 'default'}\` · **Thinking**: \`${cfg?.thinking || 'default'}\`${cfg?.mode ? ` · **Mode**: \`${cfg.mode}\`` : ''}${cfg?.permissionMode ? ` · **Permissions**: \`${cfg.permissionMode}\`` : ''}${cfg?.sandboxMode ? ` · **Sandbox**: \`${cfg.sandboxMode}\`` : ''}`,
		'',
	];

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

export function formatMissingEngineMessage(
	shortEngine: string,
	available: ReadonlyArray<Pick<EngineDefinition, 'id' | 'name' | 'executable'>>,
): string {
	const def = available.find(entry => entry.id === shortEngine);
	const guide = ENGINE_INSTALL_GUIDES[shortEngine];
	const displayName = def?.name ?? shortEngine;
	const installCmd = guide?.installCommand ?? `Install ${displayName} CLI`;
	const cliKey = guide?.cliKey ?? def?.executable ?? shortEngine;
	return vscode.l10n.t('{0} CLI is not installed ({1}). Configure "aexus.ade.cliPaths.{2}" in Settings or install the CLI first.', displayName, installCmd, cliKey);
}

export function formatMissingRemoteEngineMessage(
	shortEngine: string,
	hostAlias: string,
	available: ReadonlyArray<Pick<EngineDefinition, 'id' | 'name' | 'executable'>>,
	probeError?: string,
): string {
	if (probeError) {
		return vscode.l10n.t('Cannot connect to Cloud Host "{0}" via SSH: {1}', hostAlias, probeError);
	}
	const def = available.find(entry => entry.id === shortEngine);
	const guide = ENGINE_INSTALL_GUIDES[shortEngine];
	const displayName = def?.name ?? shortEngine;
	const installCmd = guide?.installCommand ?? `Install ${displayName} CLI`;
	return vscode.l10n.t('{0} CLI is not installed on Cloud Host "{1}" ({2}). Install it on the remote host or configure "aexus.ade.remoteCliPaths".', displayName, hostAlias, installCmd);
}

export function buildMissingEngineMarkdown(
	shortEngine: string,
	available: ReadonlyArray<Pick<EngineDefinition, 'id' | 'name' | 'executable'>>,
): string {
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
}

export function buildMissingRemoteEngineMarkdown(
	shortEngine: string,
	hostAlias: string,
	available: ReadonlyArray<Pick<EngineDefinition, 'id' | 'name' | 'executable'>>,
	probeError?: string,
): string {
	const def = available.find(entry => entry.id === shortEngine);
	const guide = ENGINE_INSTALL_GUIDES[shortEngine];
	const displayName = def?.name ?? shortEngine;
	const manageHostsUri = `command:workbench.action.aexusCloudHosts.manage?${encodeURIComponent(JSON.stringify([hostAlias]))}`;
	const remoteCliSettingsUri = `command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify(['aexus.ade.remoteCliPaths']))}`;
	if (probeError) {
		return [
			`### Cannot Connect to Cloud Host \`${hostAlias}\``,
			'',
			`**Aexus Code** failed to reach \`${hostAlias}\` over SSH to launch **${displayName}** natively on the cloud host:`,
			'',
			'```text',
			probeError,
			'```',
			'',
			`- [Check SSH Settings in Cloud Hosts Manager](${manageHostsUri})`,
			`- Verify passwordless SSH key authentication works non-interactively (\`ssh -o BatchMode=yes ${hostAlias} echo ok\`).`,
			'',
			`_Once SSH connectivity is restored, send your message again._`,
		].join('\n');
	}
	return [
		`### ${displayName} CLI Not Installed on Cloud Host \`${hostAlias}\``,
		'',
		`**Aexus Code** runs Cloud Agents natively on the Cloud Host, but could not find \`${def?.executable ?? shortEngine}\` on \`${hostAlias}\`.`,
		'',
		...(guide ? [`1. **Install on \`${hostAlias}\`**: \`${guide.installCommand}\` ([Documentation](${guide.docsUrl}))`] : []),
		`2. **Or Specify Remote Binary Path**: [Open \`aexus.ade.remoteCliPaths\` in Settings](${remoteCliSettingsUri}) and set \`"${hostAlias}": { "${shortEngine}": "/path/to/${def?.executable ?? shortEngine}" }\``,
		`3. **Manage Cloud Host**: [Open Cloud Hosts Manager](${manageHostsUri})`,
		'',
		`_Once installed or configured on \`${hostAlias}\`, send your message again — no restart required._`,
	].join('\n');
}
