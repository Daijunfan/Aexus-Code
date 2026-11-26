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
	EngineDefinition,
	RecordEntry,
	toEngineType,
	toSendOptions,
} from './extensionSessionHelpers';
import { EngineRuntime, EngineRuntimeCapabilities } from './runtime';

const execFileAsync = promisify(cp.execFile);

export interface SlashCommandHandlerDeps {
	readonly available: ReadonlyArray<EngineDefinition & { command: string | undefined }>;
	readonly opened: ReadonlyMap<string, { changed: vscode.EventEmitter<vscode.ChatSession['history']> }>;
	identity(record: RecordEntry): string;
	getSessionConfig(record: RecordEntry): SessionConfigState;
	fetchRuntimeCaps(shortEngine: string, cwd: string, record?: RecordEntry): Promise<{ readonly caps: EngineRuntimeCapabilities }>;
	computeOptionGroupsForResource(sessionType: string, sessionUri: vscode.Uri): Promise<readonly vscode.ChatSessionProviderOptionGroup[]>;
	applyOptionUpdates(sessionType: string, sessionUri: vscode.Uri, updates: readonly { optionId: string; value: string | vscode.ChatSessionProviderOptionItem }[]): Promise<void>;
	runtimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget }>;
	tryRuntimeForRecord(record: RecordEntry): Promise<{ readonly engine: EngineRuntime; readonly remoteTarget?: CloudHostTarget } | undefined>;
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
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
		cloudTarget?: CloudHostTarget,
	): Promise<boolean> => {
		const sessionType = `aexus-${record.engine}`;
		const engineType = toEngineType(record.engine);
		const engineDef = deps.available.find(entry => entry.id === record.engine);
		const engineName = engineDef?.name ?? record.engine;
		const cfg = deps.getSessionConfig(record);
		const { caps } = await deps.fetchRuntimeCaps(record.engine, record.cwd, record);
		const allCommands = await discoverSlashCommands(engineType, record.cwd, caps.commands, cloudTarget);

		if (cmd === 'help') {
			stream.markdown(buildSlashHelpMarkdown(engineName, cfg, allCommands));
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

		if (cmd === 'clear' || cmd === 'newtask' || cmd === 'new') {
			const preservedConfig = record.sessionConfig;
			const preservedCloudUri = record.cloudProjectUri;
			const preservedProjectId = record.adeProjectId;
			const preservedAgentId = record.adeAgentId;
			const { engine: activeEngine } = await deps.runtimeForRecord(record);
			const fresh = await activeEngine.create(record.cwd);
			Object.assign(record, fresh, {
				label: record.label,
				customLabel: record.customLabel,
				resourceId: record.resourceId ?? record.id,
				sessionConfig: preservedConfig,
				cloudProjectUri: preservedCloudUri,
				adeProjectId: preservedProjectId,
				adeAgentId: preservedAgentId,
			});
			await deps.save();
			const openEntry = deps.opened.get(deps.identity(record));
			openEntry?.changed.fire([]);
			stream.markdown(`Conversation context cleared (**${engineName}**).`);
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

		const resolvedEng = await deps.tryRuntimeForRecord(record);
		const eng = resolvedEng?.engine;
		if (eng?.executeCommand) {
			const normalizedRuntimeCmd = cmd === 'smol' ? 'compact' : cmd;
			const handledByRuntime = await eng.executeCommand(record, normalizedRuntimeCmd, argText, stream, token, toSendOptions(cfg, {}));
			if (handledByRuntime) {
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
