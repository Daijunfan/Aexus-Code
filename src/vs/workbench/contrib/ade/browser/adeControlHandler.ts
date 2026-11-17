/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath, relativePath, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	ADE_CONTROL_EXECUTE_COMMAND_ID,
	ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID,
	ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID,
	AdeAgentRole,
	AdeSessionRank,
	IAdeControlDispatchRequest,
	IAdeControlStatus,
	IAdeProjectSummary,
	IAdeRoleSyncAgentEntry,
	IAdeRoleSyncSnapshot,
	IAdeSessionSummary,
	IAdeSessionTreeNode,
	IAdeSessionTreeResult,
} from '../../../../platform/ade/common/adeControl.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { ServiceIdentifier, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IView } from '../../../common/views.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ISCMService } from '../../scm/common/scm.js';
import {
	ADE_CHANGES_VIEW_ID,
	ADE_FILES_VIEW_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_SECRETARY_ID,
	getNextLowerAdeRole,
	IAdeAgent,
	IAdeAgentTreeNode,
	IAdeEditorService,
	IAdeProject,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { findProjectScmRepository, openScmResourceInAde } from './adeInspectorViews.js';
import { reconcileIdeWorkspaceWithCatalog } from './adeProjectManagement.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput } from './adeSessionEditor.js';
import { IAdeSessionsService } from './adeSessionsService.js';

function tryGetService<T>(accessor: ServicesAccessor, id: ServiceIdentifier<T>): T | undefined {
	try {
		return accessor.get(id);
	} catch {
		return undefined;
	}
}

function formatRoleTitle(rank: AdeSessionRank): string {
	switch (rank) {
		case 'governor':
			return 'Governor';
		case 'manager':
			return 'Manager';
		case 'employee':
			return 'Employee';
		case 'subordinate':
			return 'Subordinate';
		case 'worker':
			return 'Worker';
	}
}

function formatRoleCharterDescription(rank: AdeSessionRank): string {
	switch (rank) {
		case 'governor':
			return 'L1 Top Rank / 最高管理职级（Governor · 项目总负责人）：You are the project-level executive orchestrator in Aexus Code ADE, overseeing Manager, Employee, and Worker subordinates.';
		case 'manager':
			return 'L2 Lead Rank / 中层管理职级（Manager · 领域与模块主管）：You are a mid-level team lead in Aexus Code ADE, coordinating Employee and Worker subordinates and reporting to your supervisor (if assigned).';
		case 'employee':
			return 'L3 Staff Rank / 骨干员工职级（Employee · 专业研发角色）：You are an orchestrated staff contributor in Aexus Code ADE who executes tasks and may supervise leaf Worker sessions.';
		case 'subordinate':
			return 'Orchestrated Member / 编排成员角色（Subordinate）：You are an orchestrated member session in Aexus Code ADE.';
		case 'worker':
			return 'L4 Lowest Rank (Worker).';
	}
}

export function formatAdeAgentSubtreeLines(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	rootAgentId: string,
): string[] {
	const tree = projects.getAgentTree(rootAgentId);
	if (!tree) {
		return [];
	}
	const lines: string[] = [];
	const visit = (node: IAdeAgentTreeNode, depth: number) => {
		const hasSubs = node.children.length > 0;
		const rankTitle = formatRoleTitle(resolveAdeAgentRank(node.agent, hasSubs));
		const engineName = node.agent.session ? (sessions?.getEngineName(node.agent.session.engineId) ?? node.agent.session.engineId) : 'Draft';
		const status = !node.agent.session ? 'draft' : (node.agent.status ?? 'idle');
		const indent = '  '.repeat(depth + 1);
		lines.push(`${indent}- [${rankTitle}] ${node.agent.label} (id: ${node.agent.id}, engine: ${engineName} [${node.agent.session?.engineId ?? 'draft'}], status: ${status})`);
		for (const child of node.children) {
			visit(child, depth + 1);
		}
	};
	for (const child of tree.children) {
		visit(child, 0);
	}
	return lines;
}

function buildSessionTreeResult(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	rootAgent: IAdeAgent,
): IAdeSessionTreeResult {
	let totalSubordinates = 0;
	let maxDepth = 0;
	const visited = new Set<string>();

	const buildNode = (agent: IAdeAgent, depth: number): IAdeSessionTreeNode => {
		visited.add(agent.id);
		if (depth > 0) {
			totalSubordinates++;
			if (depth > maxDepth) {
				maxDepth = depth;
			}
		}
		const children = projects.getDirectSubordinates(agent.id)
			.filter(child => !visited.has(child.id))
			.map(child => buildNode(child, depth + 1));
		return {
			session: toSessionSummary(projects, sessions, agent),
			depth,
			children,
		};
	};

	const root = buildNode(rootAgent, 0);
	return {
		root,
		directCount: root.children.length,
		totalSubordinates,
		maxDepth,
	};
}

function parseRole(raw: unknown): AdeAgentRole | undefined {
	if (raw === undefined || raw === null || raw === '' || raw === 'none' || raw === 'worker' || raw === 'pure-worker') {
		return undefined;
	}
	if (raw === 'governor' || raw === 'manager' || raw === 'employee' || raw === 'subordinate') {
		return raw;
	}
	if (raw === 'member') {
		return 'subordinate';
	}
	throw new Error(localize('adeInvalidRole', "Invalid ADE agent role: {0}", String(raw)));
}

function parseRankFilter(raw: unknown): AdeSessionRank | undefined {
	if (raw === undefined || raw === null || raw === '') {
		return undefined;
	}
	const lower = String(raw).trim().toLowerCase();
	if (lower === 'worker' || lower === 'pure-worker' || lower === 'none') {
		return 'worker';
	}
	if (lower === 'member') {
		return 'subordinate';
	}
	if (lower === 'governor' || lower === 'manager' || lower === 'employee' || lower === 'subordinate') {
		return lower;
	}
	throw new Error(localize('adeInvalidRole', "Invalid ADE agent role: {0}", String(raw)));
}

function toUri(raw: unknown): URI | undefined {
	if (!raw) {
		return undefined;
	}
	if (URI.isUri(raw)) {
		return raw;
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
			return URI.parse(trimmed);
		}
		return URI.file(trimmed);
	}
	if (typeof raw === 'object') {
		return URI.revive(raw as UriComponents);
	}
	return undefined;
}

function buildProjectSummaries(
	projects: IAdeProjectsService,
	navigation: IProjectNavigationService,
	uriIdentity: IUriIdentityService,
): IAdeProjectSummary[] {
	const focusedUri = navigation.focusedProject?.uri;
	const activeUri = focusedUri ?? projects.selectedProject?.uri ?? navigation.selectedProject?.uri;
	return projects.projects.map(project => ({
		name: project.name,
		path: project.uri.fsPath,
		uri: project.uri.toString(),
		focused: Boolean(focusedUri && uriIdentity.extUri.isEqual(focusedUri, project.uri)),
		selected: Boolean(activeUri && uriIdentity.extUri.isEqual(activeUri, project.uri)),
		activeSessionCount: projects.agents.filter(agent => !projects.isArchived(agent.id) && uriIdentity.extUri.isEqual(agent.projectUri, project.uri)).length,
	}));
}

function toSessionSummary(projects: IAdeProjectsService, sessions: IAdeSessionsService | undefined, agent: IAdeAgent): IAdeSessionSummary {
	const hasSubs = projects.hasSubordinates(agent.id);
	return {
		id: agent.id,
		parentId: agent.parentId,
		projectPath: agent.projectUri.fsPath,
		projectName: projects.getProjectName(agent.projectUri),
		label: agent.label,
		role: agent.role,
		rank: resolveAdeAgentRank(agent, hasSubs),
		isOrchestrated: projects.isOrchestrated(agent),
		engineId: agent.session?.engineId,
		engineName: agent.session ? (sessions?.getEngineName(agent.session.engineId) ?? agent.session.engineId) : undefined,
		resource: agent.session?.resource.toString(),
		...(agent.draft ? { draft: agent.draft } : {}),
		status: !agent.session ? 'draft' : (agent.status ?? 'idle'),
		unread: Boolean(agent.unread),
		archived: projects.isArchived(agent.id),
		childrenIds: projects.getDirectSubordinates(agent.id).map(child => child.id),
	};
}

function buildControlStatus(
	modes: IWorkbenchModeService,
	projects: IAdeProjectsService,
	navigation: IProjectNavigationService,
	editors: IAdeEditorService,
	sessions?: IAdeSessionsService,
): IAdeControlStatus {
	const focused = navigation.focusedProject;
	const selected = focused ?? projects.selectedProject ?? navigation.selectedProject;
	const activeInput = editors.activeEditor;
	const secretary = projects.secretary;
	const secretaryResource = secretary.session?.resource.toString();

	let activeEditor: IAdeControlStatus['activeEditor'];
	if (activeInput instanceof AdeSessionEditorInput) {
		if (activeInput.agentId === ADE_SECRETARY_ID) {
			activeEditor = {
				kind: 'secretary',
				label: secretary.label,
				resource: secretaryResource,
				engineId: secretary.session?.engineId,
			};
		} else {
			const agent = projects.getAgent(activeInput.agentId);
			activeEditor = {
				kind: 'session',
				agentId: activeInput.agentId,
				label: agent?.label ?? activeInput.getName(),
				role: agent?.role,
				rank: agent ? resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id)) : undefined,
				engineId: agent?.session?.engineId,
			};
		}
	} else if (activeInput instanceof AdeExtensionWebviewEditorInput) {
		const agent = projects.getAgent(activeInput.agentId);
		activeEditor = {
			kind: 'session',
			agentId: activeInput.agentId,
			label: agent?.label ?? activeInput.getName(),
			resource: agent?.session?.resource.toString(),
			role: agent?.role,
			rank: agent ? resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id)) : undefined,
			engineId: agent?.session?.engineId ?? activeInput.engineId,
		};
	} else if (activeInput instanceof ChatEditorInput) {
		const sessionKey = activeInput.sessionResource?.toString();
		if (secretaryResource && sessionKey === secretaryResource) {
			activeEditor = {
				kind: 'secretary',
				label: secretary.label,
				resource: secretaryResource,
				engineId: secretary.session?.engineId,
			};
		} else {
			const agent = projects.agents.find(item => item.session?.resource.toString() === sessionKey);
			if (agent) {
				activeEditor = {
					kind: 'session',
					agentId: agent.id,
					label: agent.label,
					resource: sessionKey,
					role: agent.role,
					rank: resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id)),
					engineId: agent.session?.engineId,
				};
			} else {
				activeEditor = {
					kind: 'other',
					label: activeInput.getName(),
					resource: sessionKey,
				};
			}
		}
	} else {
		const mappedAgentId = activeInput ? editors.getAgentIdForEditor?.(activeInput) : undefined;
		const mappedAgent = mappedAgentId ? projects.getAgent(mappedAgentId) : undefined;
		if (mappedAgent) {
			activeEditor = {
				kind: 'session',
				agentId: mappedAgent.id,
				label: mappedAgent.label,
				resource: mappedAgent.session?.resource.toString(),
				role: mappedAgent.role,
				rank: resolveAdeAgentRank(mappedAgent, projects.hasSubordinates(mappedAgent.id)),
				engineId: mappedAgent.session?.engineId,
			};
		} else if (activeInput?.resource) {
			activeEditor = {
				kind: 'file',
				label: activeInput.getName(),
				resource: activeInput.resource.toString(),
			};
		} else if (activeInput) {
			activeEditor = {
				kind: 'other',
				label: activeInput.getName(),
			};
		}
	}

	const selectedAgent = projects.selectedAgentId ? projects.getAgent(projects.selectedAgentId) : undefined;

	return {
		mode: modes.mode,
		showArchived: projects.showArchived,
		navigation: {
			isFocused: Boolean(focused),
			focusedProject: focused ? { name: focused.name, path: focused.uri.fsPath, uri: focused.uri.toString() } : undefined,
			canGoForward: navigation.canGoForward,
		},
		selectedProject: selected ? { name: selected.name, path: selected.uri.fsPath, uri: selected.uri.toString() } : undefined,
		...(selectedAgent ? { selectedSession: toSessionSummary(projects, sessions, selectedAgent) } : {}),
		activeEditor,
		secretary: {
			configured: Boolean(secretary.session),
			engineId: secretary.session?.engineId,
			label: secretary.label,
			status: secretary.session ? secretary.status : 'draft',
			resource: secretaryResource,
		},
		counts: {
			projects: projects.projects.length,
			activeRootSessions: projects.agents.filter(agent => !agent.parentId && !projects.isArchived(agent.id)).length,
			totalActiveSessions: projects.agents.filter(agent => !projects.isArchived(agent.id)).length,
			archived: projects.agents.filter(agent => !agent.parentId && Boolean(agent.archived)).length,
		},
	};
}

export function buildAdeAgentRoleContext(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	agent: IAdeAgent,
): string | undefined {
	const subordinates = projects.getDirectSubordinates(agent.id);
	if (!agent.role && subordinates.length === 0) {
		return undefined;
	}

	const effectiveRole = resolveAdeAgentRank(agent, subordinates.length > 0);
	const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
	const ownEngineName = agent.session ? (sessions?.getEngineName(agent.session.engineId) ?? agent.session.engineId) : 'Draft';
	const lines = [
		'[Aexus Orchestrated Role Context]',
		'You ARE an official orchestrated organizational agent session in **Aexus Code ADE**.',
		`- Rank / Position: ${formatRoleCharterDescription(effectiveRole)}`,
		`- Role: ${formatRoleTitle(effectiveRole)}`,
		`- Session: ${agent.label} (id: ${agent.id})`,
		`- Engine: ${ownEngineName} (${agent.session?.engineId ?? 'draft'})`,
		`- Project: ${projects.getProjectName(agent.projectUri)} (${agent.projectUri.fsPath})`,
	];
	if (supervisor) {
		lines.push(`- Supervisor: ${supervisor.label} (id: ${supervisor.id}, role: ${formatRoleTitle(resolveAdeAgentRank(supervisor, true))})`);
	}
	if (subordinates.length > 0) {
		lines.push('- Direct Subordinates:');
		for (const child of subordinates) {
			const childRank = resolveAdeAgentRank(child, projects.hasSubordinates(child.id));
			const childEngineName = child.session ? (sessions?.getEngineName(child.session.engineId) ?? child.session.engineId) : 'Draft';
			lines.push(`  - ${child.label} (id: ${child.id}, role: ${formatRoleTitle(childRank)}, engine: ${childEngineName} [${child.session?.engineId ?? 'draft'}], status: ${child.status ?? 'idle'})`);
		}
		lines.push('- Subtree Rooted at You:');
		lines.push(...formatAdeAgentSubtreeLines(projects, sessions, agent.id));
	} else {
		lines.push('- Direct Subordinates: None');
	}
	lines.push(
		`- Identity & Rank Rule: When asked about your identity, role, or rank (e.g., "你的身份?", "你是什么角色？职级", "What is your role/rank?"), ALWAYS state your Aexus Code ADE organizational rank (${formatRoleTitle(effectiveRole)}), session title and ID (${agent.id}), project (${projects.getProjectName(agent.projectUri)}), supervisor (${supervisor ? `${supervisor.label} [${formatRoleTitle(resolveAdeAgentRank(supervisor, true))}]` : 'None'}), and your current subordinates. NEVER claim that you are "not an employee", "have no rank", or "have no management authority".`,
		`- Dynamic Hot-Swap Rule: Supervisors and subordinates can be reassigned (hot-swapped) dynamically at any time. Before answering questions about your live subordinates or delegating tasks, run \`aexus-ade session info ${agent.id} --json\` and \`aexus-ade session tree ${agent.id} --json\` to get live hierarchy state.`,
		'- Subordinate Control API (`aexus-ade` is on your PATH):',
		`  - List your direct subordinates: \`aexus-ade session subordinates ${agent.id} --json\``,
		`  - View your full subtree: \`aexus-ade session tree ${agent.id} --json\``,
		`  - Inspect session & hierarchy: \`aexus-ade session info ${agent.id} --json\``,
		'  - Send task to a subordinate & wait for reply: `aexus-ade session send <subordinate-id> "<message>" --wait --json`',
		'  - Read subordinate conversation history: `aexus-ade session history <subordinate-id> --limit 10 --json`',
		`  - Spawn a lower-rank subordinate: \`aexus-ade session create --parent ${agent.id} --engine <claude|codex|kilo|opencode|dsh|agy|cline|pi> --title "<title>" --no-open --json\``,
		'  - Reassign / hot-swap a subordinate to another supervisor: `aexus-ade session move <subordinate-id> <new-parent-id|none> --json`',
		'  - Stop an active subordinate turn: `aexus-ade session stop <subordinate-id>`',
	);
	return lines.join('\n');
}

export function buildAdeRoleSyncSnapshot(
	modes: IWorkbenchModeService,
	projects: IAdeProjectsService,
	editors: IAdeEditorService,
	sessions: IAdeSessionsService | undefined,
	explicitActiveAgentId?: string,
): IAdeRoleSyncSnapshot {
	const rawActiveAgentId = explicitActiveAgentId ?? editors.getAgentIdForEditor?.(editors.activeEditor);
	const activeAgentId = rawActiveAgentId && projects.getAgent(rawActiveAgentId) ? rawActiveAgentId : undefined;
	const selectedAgentId = projects.selectedAgentId && projects.getAgent(projects.selectedAgentId) ? projects.selectedAgentId : undefined;
	const agents: IAdeRoleSyncAgentEntry[] = projects.agents.map(agent => {
		const hasSubs = projects.hasSubordinates(agent.id);
		const isOrchestrated = Boolean(agent.role || hasSubs);
		const rank = resolveAdeAgentRank(agent, hasSubs);
		return {
			id: agent.id,
			label: agent.label,
			projectPath: agent.projectUri.fsPath,
			engineId: agent.session?.engineId,
			resource: agent.session?.resource.toString(),
			rank,
			isOrchestrated,
			rolePrompt: isOrchestrated ? buildAdeAgentRoleContext(projects, sessions, agent) : undefined,
		};
	});
	return {
		mode: modes.mode,
		activeAgentId,
		selectedAgentId,
		agents,
	};
}

export function resolveAdePromptContext(accessor: ServicesAccessor, rawResource: unknown): string | undefined {
	let explicitAgentId: string | undefined;
	let candidateResource = rawResource;
	if (rawResource && typeof rawResource === 'object' && !URI.isUri(rawResource) && (Object.hasOwn(rawResource, 'agentId') || Object.hasOwn(rawResource, 'resource'))) {
		const targetObj = rawResource as { agentId?: unknown; resource?: unknown };
		if (typeof targetObj.agentId === 'string' && targetObj.agentId.trim()) {
			explicitAgentId = targetObj.agentId.trim();
		}
		candidateResource = targetObj.resource;
	}
	const sessionResource = toUri(candidateResource);
	if (!sessionResource && !explicitAgentId) {
		return undefined;
	}
	const projects = accessor.get(IAdeProjectsService);
	const navigation = accessor.get(IProjectNavigationService);
	const modes = accessor.get(IWorkbenchModeService);
	const editors = accessor.get(IAdeEditorService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const sessions = tryGetService(accessor, IAdeSessionsService);

	const secretaryResource = projects.secretary.session?.resource;
	if (sessionResource && (sessionResource.scheme === 'aexus-secretary' || (secretaryResource && (uriIdentity.extUri.isEqual(sessionResource, secretaryResource) || sessionResource.toString() === secretaryResource.toString())))) {
		const status = buildControlStatus(modes, projects, navigation, editors, sessions);
		const summaries = buildProjectSummaries(projects, navigation, uriIdentity);
		const focusLine = status.navigation.isFocused && status.navigation.focusedProject
			? `Focused Project: ${status.navigation.focusedProject.name} (${status.navigation.focusedProject.path})`
			: `Home (All Projects Overview)${status.navigation.canGoForward ? ' [Forward available]' : ''}`;
		const selectedLine = status.selectedProject
			? `${status.selectedProject.name} (${status.selectedProject.path})`
			: 'None';
		const activeEditorLine = !status.activeEditor
			? 'None'
			: status.activeEditor.kind === 'secretary'
				? `Secretary (${status.activeEditor.engineId ?? 'draft'})`
				: status.activeEditor.kind === 'session'
					? `Session "${status.activeEditor.label}" (id=${status.activeEditor.agentId}, role=${status.activeEditor.rank ?? status.activeEditor.role ?? 'worker'}, engine=${status.activeEditor.engineId ?? 'draft'})`
					: `${status.activeEditor.kind}: ${status.activeEditor.label}${status.activeEditor.resource ? ` (${status.activeEditor.resource})` : ''}`;

		const projectLines = summaries.length
			? summaries.map(project => `  - ${project.name} (${project.path})${project.focused ? ' [FOCUSED]' : project.selected ? ' [SELECTED]' : ''}: ${project.activeSessionCount} active session(s)`).join('\n')
			: '  (No projects registered)';

		const activeRoots = projects.agents.filter(agent => !agent.parentId && !projects.isArchived(agent.id));
		const sessionLines: string[] = [];
		const renderSessionLine = (agent: IAdeAgent, depth: number) => {
			const hasSubs = projects.hasSubordinates(agent.id);
			const rankTitle = formatRoleTitle(resolveAdeAgentRank(agent, hasSubs));
			const eng = agent.session ? (sessions?.getEngineName(agent.session.engineId) ?? agent.session.engineId) : 'Draft';
			const st = !agent.session ? 'draft' : (agent.status ?? 'idle');
			sessionLines.push(`${'  '.repeat(depth + 1)}- [${rankTitle}] "${agent.label}" (id: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)}, engine: ${eng} [${agent.session?.engineId ?? 'draft'}], status: ${st}${agent.unread ? ', UNREAD' : ''})`);
			for (const child of projects.getDirectSubordinates(agent.id)) {
				renderSessionLine(child, depth + 1);
			}
		};
		for (const root of activeRoots) {
			renderSessionLine(root, 0);
		}
		const hierarchyBlock = sessionLines.length ? sessionLines.join('\n') : '  (No active ADE sessions)';

		return [
			'[Aexus ADE Live Viewport & Macro Control Context]',
			'You are the global **Secretary** in **Aexus Code ADE**, with complete macro-control authority over EVERYTHING inside ADE.',
			'- Scope & Boundary Rule: Operate STRICTLY inside **ADE** (Agentic Development Environment). Do NOT switch workbench mode to IDE and do NOT manipulate IDE-only views or features.',
			`- Focus State: ${focusLine}`,
			`- Selected Project: ${selectedLine}`,
			`- Sidebar State: showArchived=${status.showArchived}`,
			`- Active ADE Editor: ${activeEditorLine}`,
			`- Counts: ${status.counts.projects} project(s), ${status.counts.activeRootSessions} root session(s), ${status.counts.totalActiveSessions} total active session(s), ${status.counts.archived} archived`,
			'- ADE Projects:',
			projectLines,
			'- Live ADE Session Hierarchy:',
			hierarchyBlock,
			'- Complete ADE Macro Control CLI (`aexus-ade` is directly on your PATH; pass `--json` for structured output):',
			'  - Viewport & Inspector: `aexus-ade status --json` | `aexus-ade view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh] --json`',
			'  - Projects & Git/Files Inspector: `aexus-ade project list` | `aexus-ade project add <path...> [--name <label>]` | `aexus-ade project select <target>` | `aexus-ade project remove <target>` | `aexus-ade project delete <target> [--sessions] [--files] [--permanent]` | `aexus-ade project focus <target>` | `aexus-ade project home` | `aexus-ade project forward` | `aexus-ade project move <source> (--before <target> | --after <target>)` | `aexus-ade project changes [target]` | `aexus-ade project files [target] [--path <subpath>] [--depth <n>]` | `aexus-ade project open-file <file> [--project <target>] [--side]` | `aexus-ade project open-diff <file> [--project <target>]`',
			'  - Coding Agent Engines (claude, codex, kilo, opencode, dsh, agy, cline, pi): `aexus-ade engine list` | `aexus-ade engine sessions <engine> [--project <target>] [--limit <n>]`',
			'  - Sessions & Ranks (governor > manager > employee > worker): `aexus-ade session list [--project <p>] [--parent <id|root>] [--role <r>] [--engine <e>] [--status <s>] [--unread] [--archived] [--all]` | `aexus-ade session info <id>` | `aexus-ade session subordinates [id] [--recursive]` | `aexus-ade session tree [id]` | `aexus-ade session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <r>] [--draft [text]] [--side] [--no-open]` | `aexus-ade session attach --engine <e> --native-id <nid> [--project <p>] [--title <t>] [--parent <id>] [--role <r>] [--side] [--no-open]` | `aexus-ade session connect <id> --engine <e> [--native-id <nid>] [--side] [--no-open]` | `aexus-ade session open <id> [--side]` | `aexus-ade session select <id>` | `aexus-ade session close <id>` | `aexus-ade session mark-read <id|--all>` | `aexus-ade session draft <id> [text|--clear]` | `aexus-ade session rename <id> <title>` | `aexus-ade session role <id> <governor|manager|employee|worker|none>` | `aexus-ade session move <id> <parentId|none> [--project <p>]` | `aexus-ade session reorder <id> (--before <targetId> | --after <targetId>)` | `aexus-ade session send <id> <prompt> [--wait]` | `aexus-ade session history <id> [--limit <n>]` | `aexus-ade session stop <id>` | `aexus-ade session archive <id>` | `aexus-ade session unarchive <id>` | `aexus-ade session detach <id>` | `aexus-ade session delete <id> [--force]`',
			'  - Secretary Self-Management: `aexus-ade secretary [status | open [--side] | engine <e> | reset [--engine <e>] | send <prompt> [--wait] | history [--limit <n>] | stop | draft [text|--clear] | mark-read]`',
		].join('\n');
	}

	const agent = (explicitAgentId ? projects.getAgent(explicitAgentId) : undefined)
		?? (sessionResource ? projects.agents.find(entry => entry.session && (
			uriIdentity.extUri.isEqual(entry.session.resource, sessionResource)
			|| entry.session.resource.toString() === sessionResource.toString()
		)) : undefined);
	if (!agent) {
		return undefined;
	}

	return buildAdeAgentRoleContext(projects, sessions, agent);
}

function findMatchingProject(projects: IAdeProjectsService, uriIdentity: IUriIdentityService, rawTarget: unknown): IAdeProject | undefined {
	if (typeof rawTarget === 'string' && rawTarget.trim()) {
		const trimmed = rawTarget.trim();
		const byName = projects.projects.find(project => project.name === trimmed || project.name.toLowerCase() === trimmed.toLowerCase());
		if (byName) {
			return byName;
		}
	}
	const candidateUri = toUri(rawTarget);
	if (!candidateUri) {
		return undefined;
	}
	const normalized = removeTrailingPathSeparator(candidateUri);
	return projects.projects.find(project => uriIdentity.extUri.isEqual(project.uri, normalized));
}

function resolveAgentFromParams(projects: IAdeProjectsService, params: Record<string, unknown> | undefined): IAdeAgent {
	const rawId = params?.id ?? params?.agentId ?? params?.sessionId;
	if (typeof rawId !== 'string' || !rawId.trim()) {
		throw new Error(localize('adeMissingSessionId', "Session ID is required."));
	}
	const target = rawId.trim();
	const exact = projects.getAgent(target);
	if (exact) {
		return exact;
	}
	const prefixMatches = projects.agents.filter(agent => agent.id.startsWith(target));
	if (prefixMatches.length === 1) {
		return prefixMatches[0];
	}
	const labelMatches = projects.agents.filter(agent => agent.label === target);
	if (labelMatches.length === 1) {
		return labelMatches[0];
	}
	throw new Error(localize('adeSessionNotFound', "ADE session not found: {0}", target));
}

function resolveSupervisorOrSession(projects: IAdeProjectsService, editors: IAdeEditorService, params: Record<string, unknown> | undefined): IAdeAgent {
	const rawId = params?.id ?? params?.agentId ?? params?.sessionId;
	if (typeof rawId === 'string' && rawId.trim()) {
		return resolveAgentFromParams(projects, params);
	}
	const activeInput = editors.activeEditor;
	if (activeInput instanceof AdeSessionEditorInput && activeInput.agentId && activeInput.agentId !== ADE_SECRETARY_ID) {
		const activeAgent = projects.getAgent(activeInput.agentId);
		if (activeAgent) {
			return activeAgent;
		}
	}
	if (activeInput instanceof AdeExtensionWebviewEditorInput) {
		const activeAgent = projects.getAgent(activeInput.agentId);
		if (activeAgent) {
			return activeAgent;
		}
	}
	if (activeInput instanceof ChatEditorInput && activeInput.sessionResource) {
		const sessionKey = activeInput.sessionResource.toString();
		const activeAgent = projects.agents.find(item => item.session?.resource.toString() === sessionKey);
		if (activeAgent) {
			return activeAgent;
		}
	}
	if (projects.selectedAgentId) {
		const selected = projects.getAgent(projects.selectedAgentId);
		if (selected) {
			return selected;
		}
	}
	throw new Error(localize('adeMissingSessionId', "Session ID is required."));
}

const SHORT_ENGINE_ALIASES: Record<string, string> = {
	codex: 'aexus-codex',
	claude: 'aexus-claude',
	kilo: 'aexus-kilo',
	kilocode: 'aexus-kilo',
	opencode: 'aexus-opencode',
	dsh: 'aexus-dsh',
	deepseek: 'aexus-dsh',
	agy: 'aexus-antigravity',
	antigravity: 'aexus-antigravity',
	cline: 'aexus-cline',
	pi: 'aexus-pi',
};

async function resolveEngineId(sessions: IAdeSessionsService, rawEngine: unknown): Promise<string | undefined> {
	const available = await sessions.getEngines();
	if (typeof rawEngine !== 'string' || !rawEngine.trim()) {
		return available[0]?.id;
	}
	const trimmed = rawEngine.trim();
	const lower = trimmed.toLowerCase();
	const aliased = SHORT_ENGINE_ALIASES[lower];
	if (aliased) {
		return aliased;
	}
	const exact = available.find(item => item.id === trimmed || item.id.toLowerCase() === lower || item.name.toLowerCase() === lower);
	if (exact) {
		return exact.id;
	}
	if (!trimmed.includes('-') && available.some(item => item.id === `aexus-${lower}`)) {
		return `aexus-${lower}`;
	}
	return trimmed;
}

async function sendMessageToSessionResource(chatService: IChatService | undefined, resource: URI, message: string, wait = false): Promise<string> {
	if (!chatService) {
		throw new Error(localize('adeChatServiceUnavailable', "Chat service is not available."));
	}
	const existing = chatService.getSession?.(resource);
	const loadedRef = !existing && chatService.acquireOrLoadSession
		? await chatService.acquireOrLoadSession(resource, ChatAgentLocation.Chat, CancellationToken.None, 'adeControl')
		: undefined;
	try {
		const result = await chatService.sendRequest(resource, message);
		if (result.kind === 'rejected') {
			loadedRef?.dispose();
			throw new Error(result.reason);
		}
		if (result.kind === 'sent') {
			if (wait) {
				await result.data.responseCompletePromise.finally(() => loadedRef?.dispose());
			} else {
				void result.data.responseCompletePromise.finally(() => loadedRef?.dispose());
			}
		} else {
			if (wait) {
				await result.deferred.finally(() => loadedRef?.dispose());
			} else {
				void result.deferred.finally(() => loadedRef?.dispose());
			}
		}
		return result.kind;
	} catch (error) {
		loadedRef?.dispose();
		throw error;
	}
}

export async function executeAdeControlRequest(
	accessor: ServicesAccessor,
	arg1: IAdeControlDispatchRequest | string,
	arg2?: Record<string, unknown>,
): Promise<unknown> {
	const request: IAdeControlDispatchRequest = typeof arg1 === 'string'
		? { action: arg1, params: arg2 }
		: arg1;
	const action = request?.action;
	const params = request?.params ?? {};

	const modes = accessor.get(IWorkbenchModeService);
	const projects = accessor.get(IAdeProjectsService);
	const navigation = accessor.get(IProjectNavigationService);
	const editors = accessor.get(IAdeEditorService);
	const sessions = accessor.get(IAdeSessionsService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const commandService = accessor.get(ICommandService);
	const workspaceEditing = tryGetService(accessor, IWorkspaceEditingService);
	const contextService = tryGetService(accessor, IWorkspaceContextService);
	const environmentService = tryGetService(accessor, IWorkbenchEnvironmentService);
	const fileService = tryGetService(accessor, IFileService);
	const configurationService = tryGetService(accessor, IConfigurationService);
	const pathService = tryGetService(accessor, IPathService);
	const chatService = tryGetService(accessor, IChatService);
	const scmService = tryGetService(accessor, ISCMService);
	const viewsService = tryGetService(accessor, IViewsService);
	const layoutService = tryGetService(accessor, IWorkbenchLayoutService);

	const resolveActiveOrTargetProjectUri = (rawTarget: unknown): URI => {
		if (rawTarget !== undefined && rawTarget !== null && String(rawTarget).trim()) {
			const matched = findMatchingProject(projects, uriIdentity, rawTarget);
			const uri = matched?.uri ?? toUri(rawTarget);
			if (uri) {
				return removeTrailingPathSeparator(uri);
			}
		}
		const fallback = navigation.focusedProject?.uri
			?? projects.selectedProject?.uri
			?? navigation.selectedProject?.uri
			?? projects.projects[0]?.uri;
		if (!fallback) {
			throw new Error(localize('adeNoActiveProject', "No ADE project is selected or registered."));
		}
		return removeTrailingPathSeparator(fallback);
	};

	const resolveProjectFileUri = (rawFile: unknown, projectUri: URI): URI => {
		if (typeof rawFile !== 'string' || !rawFile.trim()) {
			throw new Error(localize('adeMissingFilePath', "A file path is required."));
		}
		const trimmed = rawFile.trim();
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
			return URI.parse(trimmed);
		}
		if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
			return URI.file(trimmed);
		}
		return joinPath(projectUri, trimmed);
	};

	switch (action) {
		case 'status':
			return buildControlStatus(modes, projects, navigation, editors, sessions);

		case 'mode.get':
			return { mode: modes.mode };

		case 'mode.set': {
			const nextMode = params.mode;
			if (nextMode !== 'ade' && nextMode !== 'ide') {
				throw new Error(localize('adeInvalidMode', "Expected mode 'ade' or 'ide', received '{0}'.", String(nextMode)));
			}
			if (nextMode === 'ide' && params.caller === 'secretary') {
				throw new Error(localize('adeSecretaryIdeForbidden', "Secretary operates strictly inside ADE and does not switch to IDE mode."));
			}
			modes.setMode(nextMode);
			return { mode: modes.mode };
		}

		case 'view.get':
			return {
				showArchived: projects.showArchived,
				inspector: {
					changesVisible: Boolean(viewsService?.isViewVisible(ADE_CHANGES_VIEW_ID)),
					filesVisible: Boolean(viewsService?.isViewVisible(ADE_FILES_VIEW_ID)),
					auxiliaryBarVisible: Boolean(layoutService?.isVisible(Parts.AUXILIARYBAR_PART)),
				},
			};

		case 'view.refresh':
			await commandService.executeCommand('workbench.action.ade.refresh').catch(() => undefined);
			return { refreshed: true, showArchived: projects.showArchived };

		case 'view.set': {
			const rawArchived = params.showArchived ?? params.archived;
			if (typeof rawArchived === 'boolean') {
				projects.setShowArchived(rawArchived);
			} else if (rawArchived === 'toggle') {
				projects.setShowArchived(!projects.showArchived);
			}
			if (typeof params.inspector === 'string') {
				const inspectorTarget = params.inspector.trim().toLowerCase();
				modes.setMode('ade');
				if (inspectorTarget === 'changes') {
					await viewsService?.openView(ADE_CHANGES_VIEW_ID, true);
				} else if (inspectorTarget === 'files') {
					await viewsService?.openView(ADE_FILES_VIEW_ID, true);
				} else if (inspectorTarget === 'hide' || inspectorTarget === 'close') {
					layoutService?.setPartHidden(true, Parts.AUXILIARYBAR_PART);
				} else {
					throw new Error(localize('adeInvalidInspectorView', "Expected inspector 'changes', 'files', or 'hide', received '{0}'.", params.inspector));
				}
			}
			if (params.refresh === true) {
				await commandService.executeCommand('workbench.action.ade.refresh').catch(() => undefined);
			}
			return {
				showArchived: projects.showArchived,
				...(typeof params.inspector === 'string' ? {
					inspector: {
						changesVisible: Boolean(viewsService?.isViewVisible(ADE_CHANGES_VIEW_ID)),
						filesVisible: Boolean(viewsService?.isViewVisible(ADE_FILES_VIEW_ID)),
						auxiliaryBarVisible: Boolean(layoutService?.isVisible(Parts.AUXILIARYBAR_PART)),
					},
				} : {}),
			};
		}

		case 'project.list':
			return buildProjectSummaries(projects, navigation, uriIdentity);

		case 'project.select': {
			const rawTarget = params.path ?? params.projectPath ?? params.uri ?? params.target ?? params.name;
			const matched = findMatchingProject(projects, uriIdentity, rawTarget);
			const targetUri = matched?.uri ?? toUri(rawTarget);
			if (!targetUri) {
				throw new Error(localize('adeProjectNotFound', "Project not found: {0}", String(rawTarget ?? '')));
			}
			const normalized = removeTrailingPathSeparator(targetUri);
			projects.selectProject(normalized);
			navigation.selectProject(normalized);
			const summaries = buildProjectSummaries(projects, navigation, uriIdentity);
			return summaries.find(item => uriIdentity.extUri.isEqual(URI.parse(item.uri), normalized)) ?? {
				name: projects.getProjectName(normalized),
				path: normalized.fsPath,
				uri: normalized.toString(),
				focused: Boolean(navigation.focusedProject && uriIdentity.extUri.isEqual(navigation.focusedProject.uri, normalized)),
				selected: true,
				activeSessionCount: projects.agents.filter(agent => !projects.isArchived(agent.id) && uriIdentity.extUri.isEqual(agent.projectUri, normalized)).length,
			};
		}

		case 'project.add': {
			const rawList = Array.isArray(params.paths)
				? params.paths
				: [params.path ?? params.projectPath ?? params.uri ?? params.target];
			const uris = rawList.map(entry => toUri(entry)).filter((uri): uri is URI => Boolean(uri)).map(uri => removeTrailingPathSeparator(uri));
			if (uris.length === 0) {
				throw new Error(localize('adeMissingProjectPath', "Project path is required."));
			}
			const customName = uris.length === 1 && typeof (params.name ?? params.label) === 'string'
				? String(params.name ?? params.label).trim()
				: undefined;
			for (let idx = 0; idx < uris.length; idx++) {
				const uri = uris[idx];
				projects.registerProject(uri, idx === 0 && customName ? customName : basename(uri));
			}
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			const lastUri = uris[uris.length - 1];
			if (params.select !== false) {
				projects.selectProject(lastUri);
			}
			const summaries = buildProjectSummaries(projects, navigation, uriIdentity);
			if (Array.isArray(params.paths)) {
				return summaries.filter(item => uris.some(uri => uriIdentity.extUri.isEqual(URI.parse(item.uri), uri)));
			}
			return summaries.find(item => uriIdentity.extUri.isEqual(URI.parse(item.uri), uris[0])) ?? {
				name: customName || basename(uris[0]),
				path: uris[0].fsPath,
				uri: uris[0].toString(),
				focused: false,
				selected: true,
				activeSessionCount: 0,
			};
		}

		case 'project.remove': {
			const rawTarget = params.path ?? params.projectPath ?? params.uri ?? params.target ?? params.name;
			const matched = findMatchingProject(projects, uriIdentity, rawTarget);
			const targetUri = matched?.uri ?? toUri(rawTarget);
			if (!targetUri) {
				throw new Error(localize('adeProjectNotFound', "Project not found: {0}", String(rawTarget ?? '')));
			}
			const projectAgents = projects.agents.filter(agent => uriIdentity.extUri.isEqual(agent.projectUri, targetUri));
			await editors.closeAgents(projectAgents);
			if (navigation.focusedProject && uriIdentity.extUri.isEqual(navigation.focusedProject.uri, targetUri)) {
				navigation.goHome();
			}
			projects.removeProject(targetUri);
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			return { removed: targetUri.fsPath, uri: targetUri.toString() };
		}

		case 'project.delete': {
			const rawTarget = params.path ?? params.projectPath ?? params.uri ?? params.target ?? params.name;
			const matched = findMatchingProject(projects, uriIdentity, rawTarget);
			const targetUri = matched?.uri ?? toUri(rawTarget);
			if (!targetUri) {
				throw new Error(localize('adeProjectNotFound', "Project not found: {0}", String(rawTarget ?? '')));
			}
			const explicitSessions = typeof params.deleteSessions === 'boolean' ? params.deleteSessions : undefined;
			const explicitFiles = typeof params.deleteFiles === 'boolean' ? params.deleteFiles : undefined;
			const deleteSessions = explicitSessions ?? (explicitFiles === undefined ? true : false);
			const deleteFiles = explicitFiles ?? false;
			if (!deleteSessions && !deleteFiles) {
				throw new Error(localize('adeDeleteProjectNothingSelected', "Specify deleteSessions and/or deleteFiles when deleting a project."));
			}
			const projectAgents = projects.agents.filter(agent => uriIdentity.extUri.isEqual(agent.projectUri, targetUri));
			if (deleteSessions) {
				for (const member of projectAgents) {
					if (member.session) {
						await sessions.delete(member.session).catch(() => { });
					}
				}
				await sessions.deleteProjectSessions?.(targetUri).catch(() => 0);
			}
			await editors.closeAgents(projectAgents);
			if (deleteFiles && fileService && await fileService.exists(targetUri)) {
				const useTrash = params.permanent !== true
					&& fileService.hasCapability(targetUri, FileSystemProviderCapabilities.Trash)
					&& Boolean(configurationService?.getValue<boolean>('files.enableTrash'));
				await fileService.del(targetUri, { recursive: true, useTrash });
			}
			if (navigation.focusedProject && uriIdentity.extUri.isEqual(navigation.focusedProject.uri, targetUri)) {
				navigation.goHome();
			}
			projects.removeProject(targetUri);
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			return {
				deleted: targetUri.fsPath,
				uri: targetUri.toString(),
				deletedSessions: deleteSessions,
				deletedFiles: deleteFiles,
			};
		}

		case 'project.focus': {
			const rawTarget = params.path ?? params.projectPath ?? params.uri ?? params.target ?? params.name;
			const matched = findMatchingProject(projects, uriIdentity, rawTarget);
			const targetUri = matched?.uri ?? toUri(rawTarget);
			if (!targetUri) {
				throw new Error(localize('adeFocusTargetRequired', "Target project path or name is required."));
			}
			navigation.enterProject(targetUri);
			projects.selectProject(targetUri);
			return buildControlStatus(modes, projects, navigation, editors).navigation;
		}

		case 'project.home':
			navigation.goHome();
			return buildControlStatus(modes, projects, navigation, editors).navigation;

		case 'project.forward':
			navigation.goForward();
			return buildControlStatus(modes, projects, navigation, editors).navigation;

		case 'project.move': {
			const rawSource = params.source ?? params.sourcePath ?? params.path ?? params.uri;
			const sourceProject = findMatchingProject(projects, uriIdentity, rawSource);
			if (!sourceProject) {
				throw new Error(localize('adeMoveSourceNotFound', "Source project not found: {0}", String(rawSource ?? '')));
			}
			const rawTarget = params.target ?? params.targetPath ?? params.targetUri;
			const targetProject = rawTarget !== undefined ? findMatchingProject(projects, uriIdentity, rawTarget) : undefined;
			const after = params.after === true || params.position === 'after';
			projects.moveProjectFolder(sourceProject.uri, targetProject?.uri, after);
			return buildProjectSummaries(projects, navigation, uriIdentity);
		}

		case 'project.changes': {
			const projectUri = resolveActiveOrTargetProjectUri(params.target ?? params.project ?? params.path ?? params.name);
			let repository = scmService ? findProjectScmRepository(scmService, uriIdentity, projectUri) : undefined;
			if (!repository && scmService && projectUri.scheme === Schemas.file) {
				await commandService.executeCommand('git.openRepository', projectUri.fsPath).catch(() => undefined);
				repository = findProjectScmRepository(scmService, uriIdentity, projectUri);
			}
			const groups = (repository?.provider.groups ?? []).map(group => {
				const resources = group.resources
					.filter(item => uriIdentity.extUri.isEqualOrParent(item.sourceUri, projectUri))
					.map(item => ({
						path: item.sourceUri.fsPath,
						relativePath: relativePath(projectUri, item.sourceUri) ?? basename(item.sourceUri),
						status: item.decorations.tooltip ?? group.label,
						deleted: Boolean(item.decorations.strikeThrough),
					}));
				return {
					id: group.id,
					label: group.label,
					count: resources.length,
					resources,
				};
			}).filter(group => group.count > 0);
			const totalChanges = groups.reduce((acc, g) => acc + g.count, 0);
			return {
				project: projects.getProjectName(projectUri),
				projectPath: projectUri.fsPath,
				repositoryRoot: repository?.provider.rootUri?.fsPath,
				totalChanges,
				groups,
			};
		}

		case 'project.files': {
			if (!fileService) {
				throw new Error(localize('adeFileServiceUnavailable', "File service is not available."));
			}
			const projectUri = resolveActiveOrTargetProjectUri(params.target ?? params.project ?? params.projectPath ?? params.name);
			const rawSubpath = typeof params.subpath === 'string' && params.subpath.trim()
				? params.subpath.trim()
				: (typeof params.path === 'string' && params.target !== undefined && params.path.trim() ? params.path.trim() : undefined);
			const rootDirUri = rawSubpath ? resolveProjectFileUri(rawSubpath, projectUri) : projectUri;
			const maxDepth = typeof params.depth === 'number' && params.depth >= 1 ? Math.min(4, Math.floor(params.depth)) : 1;
			const entries: Array<{ name: string; path: string; relativePath: string; kind: 'file' | 'folder' }> = [];
			const walk = async (dirUri: URI, depth: number) => {
				const stat = await fileService.resolve(dirUri);
				const children = [...(stat.children ?? [])].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
				for (const child of children) {
					if (child.name === '.git' || child.name === 'node_modules' || child.name === '.DS_Store') {
						continue;
					}
					entries.push({
						name: child.name,
						path: child.resource.fsPath,
						relativePath: relativePath(projectUri, child.resource) ?? child.name,
						kind: child.isDirectory ? 'folder' : 'file',
					});
					if (child.isDirectory && depth < maxDepth && entries.length < 500) {
						await walk(child.resource, depth + 1);
					}
					if (entries.length >= 500) {
						break;
					}
				}
			};
			await walk(rootDirUri, 1);
			return {
				project: projects.getProjectName(projectUri),
				projectPath: projectUri.fsPath,
				directory: rootDirUri.fsPath,
				count: entries.length,
				entries,
			};
		}

		case 'project.openFile': {
			const projectUri = resolveActiveOrTargetProjectUri(params.project ?? params.projectPath ?? params.target);
			const fileUri = resolveProjectFileUri(params.file ?? params.path ?? params.uri, projectUri);
			modes.setMode('ade');
			await editors.openFile(fileUri, projectUri);
			return {
				opened: fileUri.fsPath,
				project: projects.getProjectName(projectUri),
				projectPath: projectUri.fsPath,
			};
		}

		case 'project.openDiff': {
			const projectUri = resolveActiveOrTargetProjectUri(params.project ?? params.projectPath ?? params.target);
			const fileUri = resolveProjectFileUri(params.file ?? params.path ?? params.uri, projectUri);
			modes.setMode('ade');
			const repository = scmService ? findProjectScmRepository(scmService, uriIdentity, projectUri) : undefined;
			const matchedScm = repository?.provider.groups
				.flatMap(g => g.resources)
				.find(res => uriIdentity.extUri.isEqual(res.sourceUri, fileUri));
			if (matchedScm) {
				await openScmResourceInAde(editors, matchedScm, projectUri);
			} else if (repository) {
				const original = await repository.provider.getOriginalResource(fileUri);
				if (original) {
					await editors.openDiff(original, fileUri, `${basename(fileUri)} (Working Tree)`, projectUri);
				} else {
					await editors.openFile(fileUri, projectUri);
				}
			} else {
				await editors.openFile(fileUri, projectUri);
			}
			return {
				openedDiff: fileUri.fsPath,
				project: projects.getProjectName(projectUri),
				projectPath: projectUri.fsPath,
			};
		}

		case 'engine.list': {
			const engines = await sessions.getEngines();
			return engines.map(engine => ({
				id: engine.id,
				shortId: engine.id.startsWith('aexus-') ? engine.id.slice('aexus-'.length) : engine.id,
				name: engine.name,
				description: engine.description,
				available: true,
			}));
		}

		case 'engine.sessions': {
			const rawEngine = params.engineId ?? params.engine;
			const engineId = await resolveEngineId(sessions, rawEngine);
			if (!engineId) {
				throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
			}
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.target;
			const projectUri = rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined;
			const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 50;
			const items = await sessions.list(engineId, projectUri);
			return items.slice(0, limit).map(item => ({
				engineId: item.engineId,
				engineName: sessions.getEngineName(item.engineId),
				nativeId: item.resource.path.startsWith('/') ? item.resource.path.slice(1) : item.resource.path,
				resource: item.resource.toString(),
				label: item.label,
				projectPath: item.projectUri.fsPath,
				updated: item.updated,
			}));
		}

		case 'session.list': {
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const projectFilter = rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined;
			const includeArchived = params.includeArchived === true || params.archived === true || params.all === true;
			const archivedOnly = params.archivedOnly === true;
			const unreadOnly = params.unread === true;
			const statusFilter = typeof params.status === 'string' && params.status.trim() ? params.status.trim().toLowerCase() : undefined;
			const engineFilter = typeof (params.engine ?? params.engineId) === 'string' && String(params.engine ?? params.engineId).trim()
				? await resolveEngineId(sessions, params.engine ?? params.engineId)
				: undefined;
			const rawParent = params.parentId ?? params.parent;
			let rootOnly = false;
			let parentFilter: IAdeAgent | undefined;
			if (rawParent !== undefined && rawParent !== null && rawParent !== '') {
				if (rawParent === 'root' || rawParent === 'none') {
					rootOnly = true;
				} else {
					parentFilter = resolveAgentFromParams(projects, { id: rawParent });
				}
			}
			const rankFilter = parseRankFilter(params.rank ?? params.role);
			return projects.agents
				.filter(agent => {
					const isArch = projects.isArchived(agent.id);
					if (archivedOnly && !isArch) {
						return false;
					}
					if (!includeArchived && !archivedOnly && isArch) {
						return false;
					}
					if (projectFilter && !uriIdentity.extUri.isEqual(agent.projectUri, projectFilter)) {
						return false;
					}
					if (rootOnly && agent.parentId) {
						return false;
					}
					if (parentFilter && agent.parentId !== parentFilter.id) {
						return false;
					}
					if (rankFilter && resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id)) !== rankFilter) {
						return false;
					}
					if (engineFilter && agent.session?.engineId !== engineFilter) {
						return false;
					}
					if (unreadOnly && !agent.unread) {
						return false;
					}
					if (statusFilter) {
						const effectiveStatus = !agent.session ? 'draft' : (agent.status ?? 'idle');
						if (effectiveStatus !== statusFilter) {
							return false;
						}
					}
					return true;
				})
				.map(agent => toSessionSummary(projects, sessions, agent));
		}

		case 'session.info':
		case 'session.get': {
			const agent = resolveAgentFromParams(projects, params);
			const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
			const subordinates = projects.getDirectSubordinates(agent.id);
			return {
				session: toSessionSummary(projects, sessions, agent),
				...(supervisor ? { supervisor: toSessionSummary(projects, sessions, supervisor) } : {}),
				subordinates: subordinates.map(child => toSessionSummary(projects, sessions, child)),
			};
		}

		case 'session.subordinates':
		case 'session.children': {
			const agent = resolveSupervisorOrSession(projects, editors, params);
			const subordinates = params.recursive === true
				? projects.getSubtree(agent.id).slice(1)
				: projects.getDirectSubordinates(agent.id);
			return {
				supervisor: toSessionSummary(projects, sessions, agent),
				count: subordinates.length,
				subordinates: subordinates.map(child => toSessionSummary(projects, sessions, child)),
			};
		}

		case 'session.tree':
		case 'session.subtree': {
			const agent = resolveSupervisorOrSession(projects, editors, params);
			return buildSessionTreeResult(projects, sessions, agent);
		}

		case 'session.create': {
			const rawParentId = params.parentId ?? params.parent;
			const parent = typeof rawParentId === 'string' && rawParentId.trim()
				? resolveAgentFromParams(projects, { id: rawParentId })
				: undefined;

			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const resolvedProjectUri = parent?.projectUri
				?? (rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined)
				?? navigation.focusedProject?.uri
				?? projects.selectedProject?.uri
				?? navigation.selectedProject?.uri
				?? projects.projects[0]?.uri;
			if (!resolvedProjectUri) {
				throw new Error(localize('adeSessionCreateNeedsProject', "No project available. Add or specify a project folder first."));
			}

			const projectUri = removeTrailingPathSeparator(resolvedProjectUri);
			projects.registerProject(projectUri, basename(projectUri));
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });

			let role: AdeAgentRole | undefined;
			if (parent) {
				const parentHasSubs = projects.hasSubordinates(parent.id);
				if (parent.parentId && !parent.role && !parentHasSubs) {
					throw new Error(localize('adeWorkerCannotSpawnSubordinates', "Worker is the lowest rank and cannot have subordinate sessions. Promote its role first."));
				}
				if (params.role !== undefined) {
					role = parseRole(params.role);
					if (!parent.parentId && !parent.role) {
						projects.setAgentRole(parent.id, 'governor');
					}
				} else if (!parent.parentId && !parent.role && !parentHasSubs) {
					projects.setAgentRole(parent.id, 'governor');
					role = 'manager';
				} else {
					role = getNextLowerAdeRole(parent.role, parentHasSubs).childRole;
				}
			} else {
				role = parseRole(params.role);
			}

			const rawLabel = params.label ?? params.title ?? params.name;
			const customLabel = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : undefined;
			const draftText = typeof params.draftText === 'string'
				? params.draftText
				: (typeof params.draft === 'string' ? params.draft : undefined);
			const isDraftOnly = params.draft === true || (draftText !== undefined && params.engine === undefined && params.engineId === undefined && params.draftOnly !== false);

			let createdAgent: IAdeAgent;
			if (isDraftOnly) {
				if (parent) {
					createdAgent = projects.addAgent(parent.id, customLabel ?? localize('adeSubordinateDraft', "Subordinate Agent"), role);
				} else {
					createdAgent = projects.addProject(projectUri, customLabel ?? basename(projectUri));
					if (role) {
						projects.setAgentRole(createdAgent.id, role);
					}
				}
			} else {
				const rawEngine = params.engineId ?? params.engine;
				const engineId = await resolveEngineId(sessions, rawEngine);
				if (!engineId) {
					throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
				}
				const engineSession = await sessions.create(engineId, projectUri);
				createdAgent = projects.addSession(
					projectUri,
					engineSession,
					customLabel ?? engineSession.label,
					{
						parentId: parent?.id,
						role,
						labelIsCustom: Boolean(customLabel),
					},
				);
			}
			if (draftText !== undefined) {
				projects.setDraft(createdAgent.id, draftText);
			}

			if (params.open !== false) {
				modes.setMode('ade');
				await editors.openAgent(createdAgent.id, { side: Boolean(params.side) });
			}
			return toSessionSummary(projects, sessions, projects.getAgent(createdAgent.id)!);
		}

		case 'session.attach': {
			const rawEngine = params.engineId ?? params.engine;
			const engineId = await resolveEngineId(sessions, rawEngine);
			if (!engineId) {
				throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
			}
			const rawNativeId = params.nativeId ?? params.nativeSessionId ?? params.conversationId;
			if (typeof rawNativeId !== 'string' || !rawNativeId.trim()) {
				throw new Error(localize('adeMissingNativeId', "Native conversation ID is required for session attach."));
			}
			const nativeId = rawNativeId.trim();
			const rawParentId = params.parentId ?? params.parent;
			const parent = typeof rawParentId === 'string' && rawParentId.trim()
				? resolveAgentFromParams(projects, { id: rawParentId })
				: undefined;
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const fallbackProjectUri = parent?.projectUri
				?? (rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined)
				?? navigation.focusedProject?.uri
				?? projects.selectedProject?.uri
				?? navigation.selectedProject?.uri
				?? projects.projects[0]?.uri;

			const attached = sessions.attach
				? await sessions.attach(engineId, nativeId, fallbackProjectUri)
				: (await sessions.list(engineId, fallbackProjectUri)).find(item => item.resource.path.endsWith(`/${nativeId}`) || item.resource.toString().includes(nativeId));
			if (!attached) {
				throw new Error(localize('adeAttachNotFound', "Could not find native conversation '{0}' in engine '{1}'.", nativeId, engineId));
			}
			const projectUri = removeTrailingPathSeparator(parent?.projectUri ?? attached.projectUri);
			projects.registerProject(projectUri, basename(projectUri));
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });

			let role: AdeAgentRole | undefined;
			if (parent) {
				const parentHasSubs = projects.hasSubordinates(parent.id);
				if (parent.parentId && !parent.role && !parentHasSubs) {
					throw new Error(localize('adeWorkerCannotSpawnSubordinates', "Worker is the lowest rank and cannot have subordinate sessions. Promote its role first."));
				}
				if (params.role !== undefined) {
					role = parseRole(params.role);
					if (!parent.parentId && !parent.role) {
						projects.setAgentRole(parent.id, 'governor');
					}
				} else if (!parent.parentId && !parent.role && !parentHasSubs) {
					projects.setAgentRole(parent.id, 'governor');
					role = 'manager';
				} else {
					role = getNextLowerAdeRole(parent.role, parentHasSubs).childRole;
				}
			} else {
				role = parseRole(params.role);
			}

			const rawLabel = params.label ?? params.title ?? params.name;
			const customLabel = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : undefined;
			const createdAgent = projects.addSession(projectUri, attached, customLabel ?? attached.label, {
				parentId: parent?.id,
				role,
				labelIsCustom: Boolean(customLabel),
			});
			if (params.open !== false) {
				modes.setMode('ade');
				await editors.openAgent(createdAgent.id, { side: Boolean(params.side) });
			}
			return toSessionSummary(projects, sessions, projects.getAgent(createdAgent.id)!);
		}

		case 'session.connect': {
			const agent = resolveAgentFromParams(projects, params);
			const rawEngine = params.engineId ?? params.engine;
			const engineId = await resolveEngineId(sessions, rawEngine);
			if (!engineId) {
				throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
			}
			const rawNativeId = params.nativeId ?? params.nativeSessionId;
			let targetSession;
			if (typeof rawNativeId === 'string' && rawNativeId.trim()) {
				const nativeId = rawNativeId.trim();
				targetSession = sessions.attach
					? await sessions.attach(engineId, nativeId, agent.projectUri)
					: (await sessions.list(engineId, agent.projectUri)).find(item => item.resource.path.endsWith(`/${nativeId}`) || item.resource.toString().includes(nativeId));
				if (!targetSession) {
					throw new Error(localize('adeAttachNotFound', "Could not find native conversation '{0}' in engine '{1}'.", nativeId, engineId));
				}
			} else {
				targetSession = await sessions.create(engineId, agent.projectUri);
			}
			projects.bindSession(agent.id, targetSession);
			if (params.open !== false) {
				modes.setMode('ade');
				await editors.openAgent(agent.id, { side: Boolean(params.side) });
			}
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.open': {
			const agent = resolveAgentFromParams(projects, params);
			modes.setMode('ade');
			await editors.openAgent(agent.id, { side: Boolean(params.side) });
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.select': {
			const agent = resolveAgentFromParams(projects, params);
			projects.selectAgent(agent.id);
			projects.selectProject(agent.projectUri);
			const view = viewsService?.getActiveViewWithId<IView & { revealAgent?: (id: string) => Promise<void> }>(ADE_PROJECTS_VIEW_ID);
			await view?.revealAgent?.(agent.id);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.close': {
			const agent = resolveAgentFromParams(projects, params);
			await editors.closeAgents([agent]);
			return { closed: agent.id };
		}

		case 'session.markRead': {
			if (params.all === true) {
				for (const item of projects.agents) {
					projects.markRead(item.id);
				}
				projects.markSecretaryRead();
				return { markedRead: 'all', count: projects.agents.length };
			}
			const agent = resolveAgentFromParams(projects, params);
			projects.markRead(agent.id);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.draft': {
			const agent = resolveAgentFromParams(projects, params);
			if (params.clear === true) {
				projects.setDraft(agent.id, '');
			} else if (typeof (params.draft ?? params.text ?? params.message) === 'string') {
				projects.setDraft(agent.id, String(params.draft ?? params.text ?? params.message));
			}
			const updated = projects.getAgent(agent.id)!;
			return { id: updated.id, label: updated.label, draft: updated.draft };
		}

		case 'session.reorder': {
			const agent = resolveAgentFromParams(projects, params);
			const rawTarget = params.target ?? params.before ?? params.after;
			const targetAgent = typeof rawTarget === 'string' && rawTarget.trim()
				? resolveAgentFromParams(projects, { id: rawTarget })
				: undefined;
			const after = params.position === 'after' || (params.after !== undefined && params.before === undefined);
			projects.moveProject(agent.id, targetAgent?.id, after);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.rename': {
			const agent = resolveAgentFromParams(projects, params);
			const rawLabel = params.label ?? params.title ?? params.name;
			if (typeof rawLabel !== 'string' || !rawLabel.trim()) {
				throw new Error(localize('adeMissingSessionLabel', "A non-empty session title is required."));
			}
			const trimmed = rawLabel.trim();
			projects.renameAgent(agent.id, trimmed);
			if (agent.session) {
				await sessions.rename(agent.session, trimmed).catch(() => { });
			}
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.setRole':
		case 'session.role': {
			const agent = resolveAgentFromParams(projects, params);
			const nextRole = parseRole(params.role);
			if (!nextRole && projects.hasSubordinates(agent.id)) {
				throw new Error(localize('adeCannotClearRoleWithSubordinates', "Cannot clear role while session has subordinate agents."));
			}
			projects.setAgentRole(agent.id, nextRole);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.reparent':
		case 'session.nest':
		case 'session.move': {
			const agent = resolveAgentFromParams(projects, params);
			const rawParent = params.parentId ?? params.parent;
			const clearParent = rawParent === undefined || rawParent === null || rawParent === '' || rawParent === 'none' || rawParent === 'root';
			const parentAgent = clearParent ? undefined : resolveAgentFromParams(projects, { id: rawParent });
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const targetProjectUri = rawProject !== undefined
				? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject))
				: undefined;
			const moved = projects.reparentAgent(agent.id, parentAgent?.id, targetProjectUri);
			if (!moved) {
				throw new Error(localize('adeCannotNestSession', "Cannot move session '{0}' under the requested target.", agent.label));
			}
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.send': {
			const agent = resolveAgentFromParams(projects, params);
			const rawMessage = params.message ?? params.prompt ?? params.text;
			if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
				throw new Error(localize('adeMissingMessage', "Message text is required."));
			}
			const rank = resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id));
			if (!agent.session) {
				projects.setDraft(agent.id, rawMessage);
				return { id: agent.id, label: agent.label, rank, status: 'draft', draft: rawMessage };
			}
			const wait = Boolean(params.wait);
			const dispatchKind = await sendMessageToSessionResource(chatService, agent.session.resource, rawMessage, wait);
			let reply: string | undefined;
			if (wait && agent.session.engineId.startsWith('aexus-')) {
				const historyRes = await commandService.executeCommand<{ messages?: Array<{ role: string; text: string }>; lastError?: string }>(
					'aexus.agentEngines.history',
					agent.session.resource,
					4,
				).catch(() => undefined);
				if (historyRes?.lastError) {
					throw new Error(historyRes.lastError);
				}
				const lastAssistant = historyRes?.messages?.filter(entry => entry.role === 'assistant').pop();
				reply = lastAssistant?.text;
			}
			return {
				id: agent.id,
				label: agent.label,
				rank,
				engineId: agent.session.engineId,
				engineName: sessions.getEngineName(agent.session.engineId),
				status: 'sent',
				dispatchKind,
				resource: agent.session.resource.toString(),
				...(reply !== undefined ? { reply } : {}),
			};
		}

		case 'session.history': {
			const agent = resolveAgentFromParams(projects, params);
			const rank = resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id));
			const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 20;
			if (!agent.session) {
				return { id: agent.id, label: agent.label, rank, status: 'draft', messages: [] };
			}
			const historyRes = agent.session.engineId.startsWith('aexus-')
				? await commandService.executeCommand<{ messages?: Array<{ role: 'user' | 'assistant'; text: string }> }>(
					'aexus.agentEngines.history',
					agent.session.resource,
					limit,
				).catch(() => undefined)
				: undefined;
			return {
				id: agent.id,
				label: agent.label,
				rank,
				engineId: agent.session.engineId,
				engineName: sessions.getEngineName(agent.session.engineId),
				status: agent.status ?? 'idle',
				messages: historyRes?.messages ?? [],
			};
		}

		case 'session.stop': {
			const agent = resolveAgentFromParams(projects, params);
			const stopRes = agent.session?.engineId.startsWith('aexus-')
				? await commandService.executeCommand<{ stopped?: boolean }>('aexus.agentEngines.stop', agent.session.resource).catch(() => undefined)
				: undefined;
			projects.setAgentStatus(agent.id, 'idle');
			return {
				id: agent.id,
				stopped: Boolean(stopRes?.stopped),
			};
		}

		case 'session.archive': {
			const agent = resolveAgentFromParams(projects, params);
			const root = projects.getRootAgent(agent.id) ?? agent;
			const targetArchived = params.restore === true ? false : (typeof params.archived === 'boolean' ? params.archived : true);
			const subtree = projects.getSubtree(root.id);
			projects.setArchived(root.id, targetArchived);
			if (targetArchived) {
				await editors.closeAgents(subtree);
			}
			return toSessionSummary(projects, sessions, projects.getAgent(root.id)!);
		}

		case 'session.detach': {
			const agent = resolveAgentFromParams(projects, params);
			const subtree = projects.getSubtree(agent.id);
			projects.removeAgent(agent.id);
			await editors.closeAgents(subtree);
			return { detached: agent.id, count: subtree.length };
		}

		case 'session.delete': {
			const agent = resolveAgentFromParams(projects, params);
			const subtree = projects.getSubtree(agent.id);
			for (const member of subtree) {
				if (member.session) {
					await sessions.delete(member.session);
				}
			}
			await editors.closeAgents(subtree);
			projects.removeAgent(agent.id);
			return { deleted: agent.id, count: subtree.length };
		}

		case 'secretary.status':
			return {
				...buildControlStatus(modes, projects, navigation, editors, sessions).secretary,
				draft: projects.secretary.draft,
				unread: Boolean(projects.secretary.unread),
			};

		case 'secretary.open':
			modes.setMode('ade');
			await editors.openSecretary({ side: Boolean(params.side) });
			return buildControlStatus(modes, projects, navigation, editors, sessions).secretary;

		case 'secretary.configure':
		case 'secretary.engine':
		case 'secretary.setEngine': {
			const rawEngine = params.engineId ?? params.engine;
			const explicitResource = toUri(params.resource);
			if (typeof rawEngine === 'string' && rawEngine.trim() && explicitResource) {
				const resolvedExplicit = await resolveEngineId(sessions, rawEngine) ?? rawEngine.trim();
				projects.configureSecretary({ engineId: resolvedExplicit, resource: explicitResource });
			} else {
				const engineId = await resolveEngineId(sessions, rawEngine);
				if (!engineId) {
					throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
				}
				const localProject = [
					toUri(params.project ?? params.projectPath ?? params.path),
					navigation.focusedProject?.uri,
					projects.selectedProject?.uri,
					navigation.selectedProject?.uri,
					...projects.projects.map(project => project.uri),
				].find((uri): uri is URI => Boolean(uri && uri.scheme === Schemas.file));
				const cwd = localProject ?? pathService?.userHome({ preferLocal: true }) ?? URI.file('/');
				const created = (await sessions.ensureSecretary?.(engineId, cwd, true)) ?? (await sessions.create(engineId, cwd));
				projects.configureSecretary({ engineId: created.engineId, resource: created.resource });
			}
			if (params.open !== false) {
				modes.setMode('ade');
				await editors.openSecretary({ side: Boolean(params.side) });
			}
			return buildControlStatus(modes, projects, navigation, editors, sessions).secretary;
		}

		case 'secretary.reset': {
			const requestedEngine = params.engineId ?? params.engine;
			const targetEngine = requestedEngine !== undefined
				? await resolveEngineId(sessions, requestedEngine)
				: projects.secretary.session?.engineId;
			if (targetEngine && params.unbind !== true && params.clearEngine !== true) {
				const localProject = [
					navigation.focusedProject?.uri,
					projects.selectedProject?.uri,
					navigation.selectedProject?.uri,
					...projects.projects.map(project => project.uri),
				].find((uri): uri is URI => Boolean(uri && uri.scheme === Schemas.file));
				const cwd = localProject ?? pathService?.userHome({ preferLocal: true }) ?? URI.file('/');
				const fresh = (await sessions.ensureSecretary?.(targetEngine, cwd, true).catch(() => undefined))
					?? (await sessions.create(targetEngine, cwd).catch(() => undefined));
				projects.resetSecretary(fresh ? { engineId: fresh.engineId, resource: fresh.resource } : undefined);
			} else {
				projects.resetSecretary(undefined);
			}
			if (params.open === true) {
				await editors.openSecretary({ side: Boolean(params.side) });
			}
			return buildControlStatus(modes, projects, navigation, editors, sessions).secretary;
		}

		case 'secretary.send': {
			const rawMessage = params.message ?? params.prompt ?? params.text;
			if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
				throw new Error(localize('adeMissingMessage', "Message text is required."));
			}
			if (!projects.secretary.session) {
				projects.setSecretaryDraft(rawMessage);
				return { status: 'draft', draft: rawMessage };
			}
			const wait = Boolean(params.wait);
			const dispatchKind = await sendMessageToSessionResource(chatService, projects.secretary.session.resource, rawMessage, wait);
			let reply: string | undefined;
			if (wait) {
				const historyRes = await commandService.executeCommand<{ messages?: Array<{ role: string; text: string }> }>(
					'aexus.agentEngines.history',
					projects.secretary.session.resource,
					4,
				).catch(() => undefined);
				reply = historyRes?.messages?.filter(entry => entry.role === 'assistant').pop()?.text;
			}
			return {
				status: 'sent',
				dispatchKind,
				resource: projects.secretary.session.resource.toString(),
				...(reply !== undefined ? { reply } : {}),
			};
		}

		case 'secretary.history': {
			const limit = typeof params.limit === 'number' && params.limit > 0 ? Math.floor(params.limit) : 20;
			if (!projects.secretary.session) {
				return { configured: false, status: 'draft', messages: [] };
			}
			const historyRes = await commandService.executeCommand<{ messages?: Array<{ role: 'user' | 'assistant'; text: string }> }>(
				'aexus.agentEngines.history',
				projects.secretary.session.resource,
				limit,
			).catch(() => undefined);
			return {
				configured: true,
				engineId: projects.secretary.session.engineId,
				status: projects.secretary.status,
				messages: historyRes?.messages ?? [],
			};
		}

		case 'secretary.stop': {
			const stopRes = projects.secretary.session
				? await commandService.executeCommand<{ stopped?: boolean }>('aexus.agentEngines.stop', projects.secretary.session.resource).catch(() => undefined)
				: undefined;
			return { stopped: Boolean(stopRes?.stopped) };
		}

		case 'secretary.draft': {
			if (params.clear === true) {
				projects.setSecretaryDraft('');
			} else if (typeof (params.draft ?? params.text ?? params.message) === 'string') {
				projects.setSecretaryDraft(String(params.draft ?? params.text ?? params.message));
			}
			return { draft: projects.secretary.draft };
		}

		case 'secretary.markRead':
			projects.markSecretaryRead();
			return { unread: Boolean(projects.secretary.unread) };

		default:
			throw new Error(localize('adeUnknownControlAction', "Unknown ADE control action: {0}", String(action)));
	}
}

CommandsRegistry.registerCommand(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown) => {
	return resolveAdePromptContext(accessor, rawResource);
});

CommandsRegistry.registerCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID, (accessor: ServicesAccessor, explicitActiveAgentId?: unknown) => {
	const modes = accessor.get(IWorkbenchModeService);
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const sessions = tryGetService(accessor, IAdeSessionsService);
	const activeId = typeof explicitActiveAgentId === 'string' && explicitActiveAgentId.trim() ? explicitActiveAgentId.trim() : undefined;
	return buildAdeRoleSyncSnapshot(modes, projects, editors, sessions, activeId);
});

CommandsRegistry.registerCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, (accessor: ServicesAccessor, arg1: IAdeControlDispatchRequest | string, arg2?: Record<string, unknown>) => {
	return executeAdeControlRequest(accessor, arg1, arg2);
});
