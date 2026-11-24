/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { discoverSlashCommands, SessionConfigState } from './capabilities';
import { CloudHostTarget, execRemoteShell, posixQuote, psSingleQuote } from './cloudTransport';
import {
	buildSlashHelpMarkdown,
	ENGINE_ALIASES,
	EngineDefinition,
	RecordEntry,
	SECRETARY_TYPE,
	SECRETARY_URI,
	toEngineType,
	toSendOptions,
} from './extensionSessionHelpers';
import { EngineRuntime, EngineRuntimeCapabilities } from './runtime';

const execFileAsync = promisify(cp.execFile);

export interface SlashCommandHandlerDeps {
	readonly available: ReadonlyArray<EngineDefinition & { command: string | undefined }>;
	readonly opened: ReadonlyMap<string, { changed: vscode.EventEmitter<vscode.ChatSession['history']> }>;
	identity(record: RecordEntry): string;
	getSessionConfig(record: RecordEntry, isSecretary: boolean): SessionConfigState;
	fetchRuntimeCaps(shortEngine: string, cwd: string, record?: RecordEntry): Promise<{ readonly caps: EngineRuntimeCapabilities }>;
	computeOptionGroupsForResource(sessionType: string, sessionUri: vscode.Uri): Promise<readonly vscode.ChatSessionProviderOptionGroup[]>;
	applyOptionUpdates(sessionType: string, sessionUri: vscode.Uri, updates: readonly { optionId: string; value: string | vscode.ChatSessionProviderOptionItem }[]): Promise<void>;
	ensureSecretaryRecord(rawEngineId?: string, project?: vscode.Uri, forceReset?: boolean): Promise<RecordEntry>;
	runtimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget }>;
	tryRuntimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget } | undefined>;
	resolveShortEngine(rawEngine: string): string;
	setGoalBannerInUi(sessionUri: vscode.Uri, goalText: string | undefined): void;
	save(): Promise<void>;
}

export function createSlashCommandHandlers(deps: SlashCommandHandlerDeps) {
	const selectOrPromptOption = async (
		sessionType: string,
		sessionUri: vscode.Uri,
		groupId: string,
		groupTitle: string,
		argText: string,
		stream: vscode.ChatResponseStream,
	): Promise<boolean> => {
		const groups = await deps.computeOptionGroupsForResource(sessionType, sessionUri);
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
			await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: groupId, value: chosenId }]);
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
			await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: groupId, value: picked.itemId }]);
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
		cloudTarget?: CloudHostTarget,
	): Promise<boolean> => {
		const sessionType = isSecretary ? SECRETARY_TYPE : `aexus-${record.engine}`;
		const engineType = toEngineType(record.engine);
		const engineDef = deps.available.find(entry => entry.id === record.engine);
		const engineName = engineDef?.name ?? record.engine;
		const cfg = deps.getSessionConfig(record, isSecretary);
		const { caps } = await deps.fetchRuntimeCaps(record.engine, record.cwd, record);
		const allCommands = await discoverSlashCommands(isSecretary ? 'secretary' : engineType, engineType, record.cwd, caps.commands, cloudTarget);

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
			deps.setGoalBannerInUi(sessionUri, undefined);
			if (isSecretary) {
				const rotated = await deps.ensureSecretaryRecord(record.engine, vscode.Uri.file(record.cwd), true);
				await Promise.resolve(vscode.commands.executeCommand('aexus.ade.control.execute', {
					action: 'secretary.configure',
					params: { engine: `aexus-${rotated.engine}`, resource: SECRETARY_URI.toString(), open: false },
				})).catch(() => undefined);
				stream.markdown(`Secretary conversation context has been reset (**${engineName}**).`);
			} else {
				const preservedConfig = record.sessionConfig;
				const preservedCloudUri = record.cloudProjectUri;
				const { engine: activeEngine } = await deps.runtimeForRecord(record);
				const fresh = await activeEngine.create(record.cwd);
				Object.assign(record, fresh, {
					label: record.label,
					customLabel: record.customLabel,
					resourceId: record.resourceId ?? record.id,
					sessionConfig: preservedConfig,
					cloudProjectUri: preservedCloudUri,
					activeGoal: undefined,
					roleInit: undefined,
					lastDeltaContext: undefined,
				});
				await deps.save();
				const openEntry = deps.opened.get(deps.identity(record));
				openEntry?.changed.fire([]);
				stream.markdown(`Conversation context cleared (**${engineName}**).`);
			}
			return true;
		}

		if (cmd === 'diff' && !argText.trim()) {
			try {
				let statusText = '';
				let statText = '';
				let rawPatch = '';
				if (cloudTarget) {
					const qCwd = posixQuote(record.cwd);
					const pCwd = psSingleQuote(record.cwd);
					const posixScript = [
						`cd -- ${qCwd} || exit 1`,
						`git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 2`,
						`printf '__AEX_STATUS__\\n'`,
						`git status --short --branch`,
						`printf '\\n__AEX_STAT__\\n'`,
						`git diff --stat`,
						`printf '\\n__AEX_PATCH__\\n'`,
						`git diff --no-color | head -c 65536`,
					].join('\n');
					const winScript = [
						`Set-Location -LiteralPath ${pCwd}`,
						`git rev-parse --is-inside-work-tree 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { exit 2 }`,
						`Write-Output '__AEX_STATUS__'`,
						`git status --short --branch`,
						`Write-Output '__AEX_STAT__'`,
						`git diff --stat`,
						`Write-Output '__AEX_PATCH__'`,
						`$d = (git diff --no-color) -join "\`n"; if ($d.Length -gt 65536) { $d = $d.Substring(0, 65536) }; Write-Output $d`,
					].join('; ');
					const res = await execRemoteShell(cloudTarget, posixScript, winScript, { timeoutMs: 12_000, token });
					if (res.code !== 0) {
						throw new Error(res.stderr || 'git diff failed on cloud host');
					}
					const out = res.stdout.toString('utf8');
					const statMarker = out.indexOf('__AEX_STAT__');
					const patchMarker = out.indexOf('__AEX_PATCH__');
					if (statMarker >= 0 && patchMarker > statMarker) {
						statusText = out.slice(out.indexOf('__AEX_STATUS__') + '__AEX_STATUS__'.length, statMarker).trim() || '(clean working tree)';
						statText = out.slice(statMarker + '__AEX_STAT__'.length, patchMarker).trim();
						rawPatch = out.slice(patchMarker + '__AEX_PATCH__'.length).trim();
					} else {
						statusText = out.trim() || '(clean working tree)';
					}
				} else {
					const [statusRes, statRes, diffRes] = await Promise.all([
						execFileAsync('git', ['status', '--short', '--branch'], { cwd: record.cwd, timeout: 6000, windowsHide: true }),
						execFileAsync('git', ['diff', '--stat'], { cwd: record.cwd, timeout: 6000, windowsHide: true }),
						execFileAsync('git', ['diff', '--no-color'], { cwd: record.cwd, timeout: 6000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }),
					]);
					statusText = statusRes.stdout.trim() || '(clean working tree)';
					statText = statRes.stdout.trim();
					rawPatch = diffRes.stdout.trim();
				}
				const patchPreview = rawPatch.length > 6000 ? `${rawPatch.slice(0, 6000)}\n... (diff truncated)` : rawPatch;
				stream.markdown([
					`### Git Working Tree Diff (\`${cloudTarget ? `${cloudTarget.alias}:${record.cwd}` : record.cwd}\`)`,
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
				await deps.applyOptionUpdates(sessionType, sessionUri, [
					{ optionId: 'permissions', value: 'never' },
					{ optionId: 'sandbox', value: 'danger-full-access' },
				]);
				stream.markdown('Updated **Approval** to **Never Ask** (`never`) and **Sandbox** to **Full Access** (`danger-full-access`).');
			} else if (engineType === 'aexus-dsh') {
				await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'permissions', value: 'danger-full-access' }]);
				stream.markdown('Updated **Permissions** to **Full Access** (`danger-full-access`).');
			} else if (engineType === 'aexus-cline') {
				await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'yolo' }]);
				stream.markdown('Updated **Mode** to **Auto-Approve YOLO** (`yolo`).');
			} else if (engineType === 'aexus-antigravity') {
				await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'auto' }]);
				stream.markdown('Updated **Mode** to **Auto** (`auto`).');
			} else {
				await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'permissions', value: 'bypassPermissions' }]);
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
			await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'act' }]);
			stream.markdown('Switched Cline to **Act Mode** (`act`).');
			return true;
		}
		if (cmd === 'yolo' && engineType === 'aexus-cline' && !argText.trim()) {
			await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: 'yolo' }]);
			stream.markdown('Switched Cline to **Auto-Approve YOLO Mode** (`yolo`).');
			return true;
		}
		if (cmd === 'plan' && !argText.trim()) {
			const groups = await deps.computeOptionGroupsForResource(sessionType, sessionUri);
			const modeGroup = groups.find(g => g.id === 'mode');
			const permGroup = groups.find(g => g.id === 'permissions');
			const planModeItem = modeGroup?.items.find(i => i.id === 'plan' || i.id === 'architect');
			if (planModeItem) {
				await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'mode', value: planModeItem.id }]);
				stream.markdown(`Switched **Mode** to **${planModeItem.name}** (\`${planModeItem.id}\`). Send your task to generate a plan.`);
				return true;
			}
			const planPermItem = permGroup?.items.find(i => i.id === 'plan');
			if (planPermItem) {
				await deps.applyOptionUpdates(sessionType, sessionUri, [{ optionId: 'permissions', value: 'plan' }]);
				stream.markdown('Switched **Permissions** to **Plan Mode** (`plan`). Send your task to generate a plan.');
				return true;
			}
		}

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
			if (cmd === 'mission' || cmd === 'missions') {
				const missions = await vscode.commands.executeCommand<{
					readonly id: string;
					readonly title: string;
					readonly ownerSessionId?: string;
					readonly ownerTierTag?: string;
					readonly status?: string;
					readonly nodeCount: number;
					readonly edgeCount: number;
					readonly generatedEmployeeCount?: number;
					readonly activeTokenCount?: number;
				}[]>('aexus.ade.control.execute', { action: 'mission.list' });
				if (!missions?.length) {
					stream.markdown('No ADE Missions initialized yet. Run `aexus-ade mission init --open` or click the Mission button in the ADE sidebar.');
				} else {
					stream.markdown([
						`### ADE Missions (${missions.length})`,
						...missions.map(m => {
							const ownerPart = m.ownerTierTag ? ` · owner: \`${m.ownerTierTag}\`` : '';
							const statusPart = m.status ?? 'idle';
							const empCount = m.generatedEmployeeCount ?? 0;
							const activeTok = m.activeTokenCount ? `, **${m.activeTokenCount}** active token(s)` : '';
							return `- **${m.title}** (\`${m.id}\`${ownerPart}) — status: \`${statusPart}\`, **${m.nodeCount}** node(s), **${m.edgeCount}** edge(s), **${empCount}** employee(s)${activeTok}`;
						}),
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
				const nextShort = deps.resolveShortEngine(argText);
				const nextDef = deps.available.find(entry => entry.id === nextShort && entry.command);
				if (!nextDef || !nextShort || nextDef.id !== (ENGINE_ALIASES[argText.trim().toLowerCase()] ?? argText.trim().toLowerCase())) {
					stream.markdown(`Unknown or uninstalled engine \`${argText}\`. Try \`/engine\` to list installed engines.`);
					return true;
				}
				await deps.applyOptionUpdates(SECRETARY_TYPE, SECRETARY_URI, [{ optionId: 'engine', value: nextDef.type }]);
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

		const resolvedEng = await deps.tryRuntimeForRecord(record);
		const eng = resolvedEng?.engine;
		if (eng?.executeCommand) {
			const normalizedRuntimeCmd = cmd === 'smol' ? 'compact' : cmd;
			const handledByRuntime = await eng.executeCommand(record, normalizedRuntimeCmd, argText, stream, token, toSendOptions(cfg, {}));
			if (handledByRuntime) {
				if (normalizedRuntimeCmd === 'compact') {
					record.roleInit = undefined;
					record.lastDeltaContext = undefined;
				}
				await deps.save();
				return true;
			}
		}

		return false;
	};

	return {
		selectOrPromptOption,
		handleDirectSlashCommand,
	};
}
