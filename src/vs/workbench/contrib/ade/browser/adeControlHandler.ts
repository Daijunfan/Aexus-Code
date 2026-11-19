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
	ADE_SET_SESSION_GOAL_BANNER_COMMAND_ID,
	ADE_SET_SESSION_INITIALIZING_COMMAND_ID,
	ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID,
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
import {
	AdeThinkingLevel,
	AdeWorkTreeType,
	AdeWorkspaceIsolationMode,
	IAdeEngineeringService,
	IAdeInboxService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { detectSharedWorkspaceScopeConflicts, normalizeThinkingLevel, parseEngineeringBlueprint, serializeEngineeringBlueprint } from '../../../../platform/ade/common/adeEngineeringBlueprint.js';
import { AdeBlueprintTemplatePreset, buildBlueprintFromTemplate, listBlueprintTemplates } from '../../../../platform/ade/common/adeBlueprintTemplates.js';
import {
	ADE_PRICING_CONFIG_KEY,
	ADE_PRICING_SUBSCRIPTION_MODE_CONFIG_KEY,
	AdeCustomPricingMap,
	computeTreeFinancialSummary,
	IAdePricingOptions,
} from '../../../../platform/ade/common/adePricing.js';
import { buildEngineeringDagSvg, buildEngineeringRunReportMarkdown } from '../../../../platform/ade/common/adeRunReport.js';
import { synthesizeBlueprintFromPrompt } from '../../../../platform/ade/common/adePromptToDag.js';
import {
	ADE_ORGANIZATION_PRESETS,
	ADE_PRIMITIVE_APIS,
	checkAdeApiPermission,
	compileAdeRolePrompt,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	findRankDefinition,
	formatOrganizationLadder,
	getDefaultPureLeafRank,
	getTopRankDefinition,
	IAdeOrganizationConfig,
	isPureExecutionRank,
	normalizeAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
	resolveWorkTreeSlotRank,
} from '../../../../platform/ade/common/adeRoleSchema.js';
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
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ISCMService } from '../../scm/common/scm.js';
import {
	ADE_CHANGES_VIEW_ID,
	ADE_ENGINEERING_SCHEME,
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
import { IAdeRoleSchemaService, readTrustedApplicationConfigValue } from '../common/adeRoleSchemaService.js';
import { findProjectScmRepository, openScmResourceInAde } from './adeInspectorViews.js';
import { reconcileIdeWorkspaceWithCatalog } from './adeProjectManagement.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput } from './adeSessionEditor.js';
import {
	AdeCloudHostOs,
	AEXUS_SSH_SCHEME,
	buildCloudProjectUri,
	formatProjectDisplayPath,
	IAdeCloudHostBackendService,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeSessionsService } from './adeSessionsService.js';

function tryGetService<T>(accessor: ServicesAccessor, id: ServiceIdentifier<T>): T | undefined {
	try {
		return accessor.get(id);
	} catch {
		return undefined;
	}
}

function readAdePricingOptions(configurationService: IConfigurationService | undefined): IAdePricingOptions | undefined {
	if (!configurationService) {
		return undefined;
	}
	const rawCustom = readTrustedApplicationConfigValue<unknown>(configurationService, ADE_PRICING_CONFIG_KEY);
	const customPricing = rawCustom && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
		? rawCustom as AdeCustomPricingMap
		: undefined;
	const subscriptionMode = readTrustedApplicationConfigValue<boolean>(configurationService, ADE_PRICING_SUBSCRIPTION_MODE_CONFIG_KEY) === true;
	if (!customPricing && !subscriptionMode) {
		return undefined;
	}
	return {
		...(customPricing ? { customPricing } : {}),
		...(subscriptionMode ? { subscriptionMode: true } : {}),
	};
}

function formatRoleTitle(rank: AdeSessionRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): string {
	const def = findRankDefinition(config, rank);
	if (def) {
		return def.name;
	}
	switch (rank) {
		case 'governor':
			return 'Governor';
		case 'manager':
			return 'Manager';
		case 'employee':
		case 'subordinate':
			return 'Employee';
		case 'worker':
			return 'Worker';
		default:
			return String(rank);
	}
}

const MAX_PROMPT_SUBTREE_LINES = 24;
const MAX_SECRETARY_SESSION_LINES = 40;

export function formatAdeAgentSubtreeLines(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	rootAgentId: string,
	maxLines = MAX_PROMPT_SUBTREE_LINES,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): string[] {
	const tree = projects.getAgentTree(rootAgentId);
	if (!tree) {
		return [];
	}
	const lines: string[] = [];
	let omitted = 0;
	const visit = (node: IAdeAgentTreeNode, depth: number) => {
		if (lines.length >= maxLines) {
			omitted++;
			for (const child of node.children) {
				visit(child, depth + 1);
			}
			return;
		}
		const hasSubs = node.children.length > 0;
		const rankTitle = formatRoleTitle(resolveAdeAgentRank(node.agent, hasSubs, config), config);
		const engineName = node.agent.session ? (sessions?.getEngineName(node.agent.session.engineId) ?? node.agent.session.engineId) : 'Draft';
		const indent = '  '.repeat(depth + 1);
		// Keep role prompt cache-stable: omit volatile live status (idle/working); query live state via CLI when needed.
		lines.push(`${indent}- [${rankTitle}] ${node.agent.label} (id: ${node.agent.id}, engine: ${engineName} [${node.agent.session?.engineId ?? 'draft'}])`);
		for (const child of node.children) {
			visit(child, depth + 1);
		}
	};
	for (const child of tree.children) {
		visit(child, 0);
	}
	if (omitted > 0) {
		lines.push(`  - ... (+${omitted} more subordinates; run \`aexus-ade session tree ${rootAgentId} --json\` for full live tree)`);
	}
	return lines;
}

function buildSessionTreeResult(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	rootAgent: IAdeAgent,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
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
			session: toSessionSummary(projects, sessions, agent, config),
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

function parseRole(raw: unknown, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): AdeAgentRole | undefined {
	if (raw === undefined || raw === null || raw === '' || raw === 'none' || raw === 'worker' || raw === 'pure-worker') {
		return undefined;
	}
	const str = String(raw).trim().toLowerCase();
	if (!str || str === 'none' || str === 'worker' || str === 'pure-worker') {
		return undefined;
	}
	if (str === 'member') {
		return 'subordinate';
	}
	const configured = findRankDefinition(config, str);
	if (configured) {
		const defaultLeaf = getDefaultPureLeafRank(config);
		if (configured.pureExecution && configured.id === defaultLeaf.id) {
			return undefined;
		}
		return configured.id;
	}
	if (str === 'governor' || str === 'manager' || str === 'employee' || str === 'subordinate') {
		return str;
	}
	throw new Error(localize('adeInvalidRole', "Invalid ADE agent role: {0}", String(raw)));
}

function parseRankFilter(raw: unknown, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): AdeSessionRank | undefined {
	if (raw === undefined || raw === null || raw === '') {
		return undefined;
	}
	const lower = String(raw).trim().toLowerCase();
	if (lower === 'worker' || lower === 'pure-worker' || lower === 'none') {
		return getDefaultPureLeafRank(config).id;
	}
	if (lower === 'member') {
		return 'subordinate';
	}
	const configured = findRankDefinition(config, lower);
	if (configured) {
		return configured.id;
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
		if (/^ssh:\/\/([^/]+)(\/.*)?$/i.test(trimmed)) {
			const m = /^ssh:\/\/([^/]+)(\/.*)?$/i.exec(trimmed)!;
			const rawPath = m[2] || '/';
			return buildCloudProjectUri(m[1], rawPath, /^\/?[a-zA-Z]:[\\/]/.test(rawPath) ? 'windows' : undefined);
		}
		if (/^[A-Za-z0-9._@-]{2,}:(?:\/(?!\/)|[a-zA-Z]:[\\/])(.*)$/.test(trimmed) && !/^(file|aexus-ssh|vscode-remote|http|https):/i.test(trimmed)) {
			const colonIdx = trimmed.indexOf(':');
			const hostPart = trimmed.slice(0, colonIdx);
			const pathPart = trimmed.slice(colonIdx + 1);
			return buildCloudProjectUri(hostPart, pathPart, /^\/?[a-zA-Z]:[\\/]/.test(pathPart) ? 'windows' : undefined);
		}
		if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(trimmed)) {
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
		path: formatProjectDisplayPath(project.uri),
		uri: project.uri.toString(),
		focused: Boolean(focusedUri && uriIdentity.extUri.isEqual(focusedUri, project.uri)),
		selected: Boolean(activeUri && uriIdentity.extUri.isEqual(activeUri, project.uri)),
		activeSessionCount: projects.agents.filter(agent => !projects.isArchived(agent.id) && uriIdentity.extUri.isEqual(agent.projectUri, project.uri)).length,
	}));
}

function toSessionSummary(
	projects: IAdeProjectsService,
	sessions: IAdeSessionsService | undefined,
	agent: IAdeAgent,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): IAdeSessionSummary {
	const hasSubs = projects.hasSubordinates(agent.id);
	const effectiveEngineId = agent.session?.engineId ?? agent.preferredEngineId;
	const lockedByWorkTree = Boolean(projects.isLockedByWorkTree?.(agent.id));
	return {
		id: agent.id,
		parentId: agent.parentId,
		projectPath: formatProjectDisplayPath(agent.projectUri),
		projectName: projects.getProjectName(agent.projectUri),
		label: agent.label,
		role: agent.role,
		rank: resolveAdeAgentRank(agent, hasSubs, config),
		isOrchestrated: projects.isOrchestrated(agent),
		engineId: effectiveEngineId,
		engineName: effectiveEngineId ? (sessions?.getEngineName(effectiveEngineId) ?? effectiveEngineId) : undefined,
		resource: agent.session?.resource.toString(),
		...(agent.draft ? { draft: agent.draft } : {}),
		status: !agent.session ? 'draft' : (agent.status ?? 'idle'),
		unread: Boolean(agent.unread),
		archived: projects.isArchived(agent.id),
		childrenIds: projects.getDirectSubordinates(agent.id).map(child => child.id),
		...(agent.treeType ? { treeType: agent.treeType } : {}),
		...(agent.treeGovernorId ? { treeGovernorId: agent.treeGovernorId } : {}),
		...(agent.treeSegmentId ? { treeSegmentId: agent.treeSegmentId } : {}),
		...(agent.treeNodeId ? { treeNodeId: agent.treeNodeId } : {}),
		...(lockedByWorkTree ? { lockedByWorkTree: true } : {}),
	};
}

function buildControlStatus(
	modes: IWorkbenchModeService,
	projects: IAdeProjectsService,
	navigation: IProjectNavigationService,
	editors: IAdeEditorService,
	sessions?: IAdeSessionsService,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
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
				rank: agent ? resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config) : undefined,
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
			rank: agent ? resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config) : undefined,
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
					rank: resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config),
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
				rank: resolveAdeAgentRank(mappedAgent, projects.hasSubordinates(mappedAgent.id), config),
				engineId: mappedAgent.session?.engineId,
			};
		} else if (activeInput?.resource?.scheme === ADE_ENGINEERING_SCHEME) {
			const govId = activeInput.resource.path.replace(/^\/+/, '');
			activeEditor = {
				kind: 'engineering',
				governorSessionId: govId,
				label: activeInput.getName(),
				resource: activeInput.resource.toString(),
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
			focusedProject: focused ? { name: focused.name, path: formatProjectDisplayPath(focused.uri), uri: focused.uri.toString() } : undefined,
			canGoForward: navigation.canGoForward,
		},
		selectedProject: selected ? { name: selected.name, path: formatProjectDisplayPath(selected.uri), uri: selected.uri.toString() } : undefined,
		...(selectedAgent ? { selectedSession: toSessionSummary(projects, sessions, selectedAgent, config) } : {}),
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
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): string | undefined {
	const subordinates = projects.getDirectSubordinates(agent.id);
	if (!agent.role && subordinates.length === 0) {
		return undefined;
	}

	const rankDef = resolveEffectiveRankDefinition(config, agent.role, subordinates.length > 0);
	if (rankDef.pureExecution && subordinates.length === 0) {
		return undefined;
	}

	const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
	const ownEngineName = agent.session ? (sessions?.getEngineName(agent.session.engineId) ?? agent.session.engineId) : 'Draft';
	const isWorkTree = agent.treeType === 'engineering' || agent.treeType === 'research';
	const supervisorRankName = supervisor
		? formatRoleTitle(resolveAdeAgentRank(supervisor, true, config), config)
		: undefined;
	const workTreeSlot = !isWorkTree
		? undefined
		: !agent.parentId
			? 'orchestrator' as const
			: agent.treeNodeId
				? 'reviewer' as const
				: agent.treeSegmentId
					? 'segment_owner' as const
					: 'orchestrator' as const;

	return compileAdeRolePrompt({
		config,
		rank: rankDef,
		agentId: agent.id,
		agentLabel: agent.label,
		engineDisplay: ownEngineName,
		engineId: agent.session?.engineId ?? 'draft',
		projectName: projects.getProjectName(agent.projectUri),
		projectPath: formatProjectDisplayPath(agent.projectUri),
		supervisor: supervisor && supervisorRankName
			? { id: supervisor.id, label: supervisor.label, rankName: supervisorRankName }
			: undefined,
		subtreeLines: !isWorkTree && subordinates.length > 0
			? formatAdeAgentSubtreeLines(projects, sessions, agent.id, MAX_PROMPT_SUBTREE_LINES, config)
			: undefined,
		workTree: isWorkTree
			? {
				treeType: agent.treeType === 'research' ? 'research' : 'engineering',
				governorId: agent.treeGovernorId ?? agent.id,
				segmentId: agent.treeSegmentId,
				nodeId: agent.treeNodeId,
				slot: workTreeSlot,
			}
			: undefined,
	});
}

export function buildAdeRoleSyncSnapshot(
	modes: IWorkbenchModeService,
	projects: IAdeProjectsService,
	editors: IAdeEditorService,
	sessions: IAdeSessionsService | undefined,
	explicitActiveAgentId?: string,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): IAdeRoleSyncSnapshot {
	const rawActiveAgentId = explicitActiveAgentId ?? editors.getAgentIdForEditor?.(editors.activeEditor);
	const activeAgentId = rawActiveAgentId && projects.getAgent(rawActiveAgentId) ? rawActiveAgentId : undefined;
	const selectedAgentId = projects.selectedAgentId && projects.getAgent(projects.selectedAgentId) ? projects.selectedAgentId : undefined;
	const agents: IAdeRoleSyncAgentEntry[] = projects.agents.map(agent => {
		const hasSubs = projects.hasSubordinates(agent.id);
		const isOrchestrated = Boolean(hasSubs || (agent.role && !isPureExecutionRank(config, agent.role)));
		const rank = resolveAdeAgentRank(agent, hasSubs, config);
		return {
			id: agent.id,
			label: agent.label,
			projectPath: formatProjectDisplayPath(agent.projectUri),
			engineId: agent.session?.engineId ?? agent.preferredEngineId,
			resource: agent.session?.resource.toString(),
			rank,
			isOrchestrated,
			isWorkTree: Boolean(agent.treeType),
			rolePrompt: isOrchestrated ? buildAdeAgentRoleContext(projects, sessions, agent, config) : undefined,
			preferredModel: agent.preferredModel,
			preferredThinking: agent.preferredThinking,
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
	let compactDeltaMode = false;
	if (rawResource && typeof rawResource === 'object' && !URI.isUri(rawResource) && (Object.hasOwn(rawResource, 'agentId') || Object.hasOwn(rawResource, 'resource') || Object.hasOwn(rawResource, 'mode'))) {
		const targetObj = rawResource as { agentId?: unknown; resource?: unknown; mode?: unknown };
		if (typeof targetObj.agentId === 'string' && targetObj.agentId.trim()) {
			explicitAgentId = targetObj.agentId.trim();
		}
		if (targetObj.mode === 'delta') {
			compactDeltaMode = true;
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
	const engineering = tryGetService(accessor, IAdeEngineeringService);
	const inbox = tryGetService(accessor, IAdeInboxService);
	const roleConfig = tryGetService(accessor, IAdeRoleSchemaService)?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;

	const secretaryResource = projects.secretary.session?.resource;
	if (sessionResource && (sessionResource.scheme === 'aexus-secretary' || (secretaryResource && (uriIdentity.extUri.isEqual(sessionResource, secretaryResource) || sessionResource.toString() === secretaryResource.toString())))) {
		const status = buildControlStatus(modes, projects, navigation, editors, sessions, roleConfig);
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
				: status.activeEditor.kind === 'engineering'
					? `Engineering DAG Canvas (governor=${status.activeEditor.governorSessionId})`
					: status.activeEditor.kind === 'session'
						? `Session "${status.activeEditor.label}" (id=${status.activeEditor.agentId}, role=${status.activeEditor.rank ?? status.activeEditor.role ?? 'worker'}, engine=${status.activeEditor.engineId ?? 'draft'})`
						: `${status.activeEditor.kind}: ${status.activeEditor.label}${status.activeEditor.resource ? ` (${status.activeEditor.resource})` : ''}`;

		const projectLines = summaries.length
			? summaries.map(project => `  - ${project.name} (${project.path})${project.focused ? ' [FOCUSED]' : project.selected ? ' [SELECTED]' : ''}: ${project.activeSessionCount} active session(s)`).join('\n')
			: '  (No projects registered)';

		const activeRoots = projects.agents.filter(agent => !agent.parentId && !projects.isArchived(agent.id));
		const sessionLines: string[] = [];
		let omittedSessions = 0;
		const renderSessionLine = (agent: IAdeAgent, depth: number) => {
			if (sessionLines.length >= MAX_SECRETARY_SESSION_LINES) {
				omittedSessions++;
				for (const child of projects.getDirectSubordinates(agent.id)) {
					renderSessionLine(child, depth + 1);
				}
				return;
			}
			const hasSubs = projects.hasSubordinates(agent.id);
			const rankTitle = formatRoleTitle(resolveAdeAgentRank(agent, hasSubs, roleConfig), roleConfig);
			const engId = agent.session?.engineId ?? agent.preferredEngineId;
			const eng = engId ? (sessions?.getEngineName(engId) ?? engId) : 'Draft';
			const st = !agent.session ? 'lazy' : (agent.status ?? 'idle');
			const isWorkTreeRoot = !agent.parentId && Boolean(agent.treeType);
			const treeBadge = isWorkTreeRoot ? ` [${agent.treeType!.toUpperCase()}]` : '';
			if (isWorkTreeRoot) {
				const managedCount = Math.max(0, projects.getSubtree(agent.id).length - 1);
				const managedSuffix = managedCount > 0 ? `, +${managedCount} managed tree node(s) — see ADE Engineering Trees above` : '';
				sessionLines.push(`${'  '.repeat(depth + 1)}- [${rankTitle}]${treeBadge} "${agent.label}" (id: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)}, engine: ${eng} [${engId ?? 'draft'}], status: ${st}${agent.unread ? ', UNREAD' : ''}${managedSuffix})`);
				return;
			}
			sessionLines.push(`${'  '.repeat(depth + 1)}- [${rankTitle}] "${agent.label}" (id: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)}, engine: ${eng} [${engId ?? 'draft'}], status: ${st}${agent.unread ? ', UNREAD' : ''})`);
			for (const child of projects.getDirectSubordinates(agent.id)) {
				renderSessionLine(child, depth + 1);
			}
		};
		for (const root of activeRoots) {
			renderSessionLine(root, 0);
		}
		if (omittedSessions > 0) {
			sessionLines.push(`  - ... (+${omittedSessions} more sessions; run \`aexus-ade session list --json\`)`);
		}
		const hierarchyBlock = sessionLines.length ? sessionLines.join('\n') : '  (No active ADE sessions)';

		const engTrees = engineering?.listTrees() ?? [];
		const engBlock = engTrees.length
			? engTrees.map(t => `  - [${t.treeType.toUpperCase()}] "${t.governorLabel}" (governor: ${t.governorSessionId}, project: ${t.projectName}, status: ${t.runStatus}, progress: ${t.completedNodes}/${t.totalNodes} nodes, managers: ${t.managerCount}${t.waitingGates > 0 ? `, waiting_gates: ${t.waitingGates}` : ''}${t.failedNodes > 0 ? `, failed: ${t.failedNodes}` : ''})`).join('\n')
			: '  (No active Engineering trees)';

		const activeInboxItems = inbox?.list({ includeResolved: false }) ?? [];
		const inboxBlock = activeInboxItems.length
			? activeInboxItems.map(item => `  - [${item.kind.toUpperCase()}] id=${item.id} (governor=${item.governorSessionId}${item.nodeId ? `, node=${item.nodeId}` : ''}${item.unread ? ', UNREAD' : ''}): ${item.title} — ${item.message.split('\n')[0]}`).join('\n')
			: '  (ADE Inbox empty)';

		if (compactDeltaMode) {
			return [
				'[ADE Live Viewport State]',
				`- Focus: ${focusLine} | Selected Project: ${selectedLine} | Active Editor: ${activeEditorLine}`,
				`- Live Counts: ${status.counts.projects} project(s), ${status.counts.totalActiveSessions} active session(s), ${engTrees.length} engineering tree(s), ${inbox?.unreadCount ?? 0} unread inbox item(s)`,
			].join('\n');
		}

		const hasDefaultEmpAndWorker = roleConfig.ranks.some(r => r.id === 'employee') && roleConfig.ranks.some(r => r.id === 'worker');
		const rankHeaderLine = hasDefaultEmpAndWorker
			? '- Organizational Rank System (CRITICAL DISTINCTION: `Employee` IS NOT `Worker` / `Employee [L3] ≠ Worker [L4]`):'
			: '- Organizational Rank System (User-Customizable via ADE Organization & Roles Studio):';
		const rankLines = roleConfig.ranks.map(r => {
			const apiList = r.pureExecution ? 'none (100% pure native context)' : (r.allowedApis.length > 0 ? r.allowedApis.join(', ') : 'none');
			return `  - \`${r.id}\` (L${r.tier} · ${r.name}): ${r.summary} [APIs: ${apiList}]`;
		});

		return [
			'[Aexus ADE Live Viewport & Macro Control Context]',
			'You are the global **Secretary** in **Aexus Code ADE**, with complete macro-control authority over EVERYTHING inside ADE.',
			'- Scope & Boundary Rule: Operate STRICTLY inside **ADE** (Agentic Development Environment). Do NOT switch workbench mode to IDE and do NOT manipulate IDE-only views or features.',
			`- Focus State: ${focusLine}`,
			`- Selected Project: ${selectedLine}`,
			`- Sidebar State: showArchived=${status.showArchived}`,
			`- Active ADE Editor: ${activeEditorLine}`,
			`- Counts: ${status.counts.projects} project(s), ${status.counts.activeRootSessions} root session(s), ${status.counts.totalActiveSessions} total active session(s), ${status.counts.archived} archived, ${engTrees.length} engineering tree(s), ${inbox?.unreadCount ?? 0} unread inbox item(s)`,
			'- ADE Projects:',
			projectLines,
			'- ADE Engineering Trees:',
			engBlock,
			'- ADE Inbox (Pending Gates & Governor Escalations):',
			inboxBlock,
			'- Live ADE Session Hierarchy:',
			hierarchyBlock,
			rankHeaderLine,
			`  - Strict Rank Order: ${formatOrganizationLadder(roleConfig)}.`,
			...rankLines,
			'- Complete ADE Macro Control CLI (`aexus-ade` is directly on your PATH; pass `--json` for structured output):',
			'  - Viewport & Inspector: `aexus-ade status --json` | `aexus-ade view [status | --archived <true|false|toggle> | --inspector <changes|files|hide> | --refresh] --json`',
			'  - Organization, Custom Ranks & Primitive APIs: `aexus-ade role list --json` | `aexus-ade role apis --json` | `aexus-ade role presets --json` | `aexus-ade role studio`',
			'  - Projects & Git/Files Inspector: `aexus-ade project list` | `aexus-ade project add <path...> [--name <label>]` | `aexus-ade project select <target>` | `aexus-ade project remove <target>` | `aexus-ade project delete <target> [--sessions] [--files] [--permanent]` | `aexus-ade project focus <target>` | `aexus-ade project home` | `aexus-ade project forward` | `aexus-ade project move <source> (--before <target> | --after <target>)` | `aexus-ade project changes [target]` | `aexus-ade project files [target] [--path <subpath>] [--depth <n>]` | `aexus-ade project open-file <file> [--project <target>] [--side]` | `aexus-ade project open-diff <file> [--project <target>]`',
			'  - Coding Agent Engines (claude, codex, kilo, opencode, dsh, agy, cline, pi): `aexus-ade engine list` | `aexus-ade engine sessions <engine> [--project <target>] [--limit <n>]`',
			'  - Sessions & Ranks: `aexus-ade session list [--project <p>] [--parent <id|root>] [--role <r>] [--engine <e>] [--status <s>] [--unread] [--archived] [--all]` | `aexus-ade session info <id>` | `aexus-ade session subordinates [id] [--recursive]` | `aexus-ade session tree [id]` | `aexus-ade session create [--project <p>] [--engine <e>] [--title <t>] [--parent <id>] [--role <r>] [--draft [text]] [--side] [--no-open]` | `aexus-ade session attach --engine <e> --native-id <nid> [--project <p>] [--title <t>] [--parent <id>] [--role <r>] [--side] [--no-open]` | `aexus-ade session connect <id> --engine <e> [--native-id <nid>] [--side] [--no-open]` | `aexus-ade session open <id> [--side]` | `aexus-ade session select <id>` | `aexus-ade session close <id>` | `aexus-ade session mark-read <id|--all>` | `aexus-ade session draft <id> [text|--clear]` | `aexus-ade session rename <id> <title>` | `aexus-ade session role <id> <rankId|worker|none>` | `aexus-ade session move <id> <parentId|none> [--project <p>]` | `aexus-ade session reorder <id> (--before <targetId> | --after <targetId>)` | `aexus-ade session send <id> <prompt> [--wait]` | `aexus-ade session history <id> [--limit <n>]` | `aexus-ade session stop <id>` | `aexus-ade session archive <id>` | `aexus-ade session unarchive <id>` | `aexus-ade session detach <id>` | `aexus-ade session delete <id> [--force]`',
			'  - Engineering DAG Orchestration: `aexus-ade engineering init --governor <id> [--on-children <relocate|delete> --target <id>] [--open]` | `aexus-ade engineering list [--project <path>]` | `aexus-ade engineering open --governor <id> [--side]` | `aexus-ade engineering blueprint get --governor <id> [--raw]` | `aexus-ade engineering blueprint validate (--file <path> | --text <md>)` | `aexus-ade engineering blueprint apply --governor <id> --file <path> [--force-stop-running]` | `aexus-ade engineering configure --governor <id> [--node <nodeId>|--all] [--role <worker|employee|manager|all>] [--engine <e>] [--model <m>] [--thinking <off|low|medium|high|max>] [--isolation <shared|worktree>]` | `aexus-ade engineering run --governor <id>` | `aexus-ade engineering pause --governor <id>` | `aexus-ade engineering resume --governor <id>` | `aexus-ade engineering stop --governor <id>` | `aexus-ade engineering reset --governor <id> [--node <nodeId>] [--keep-completed]` | `aexus-ade engineering remove --governor <id>` | `aexus-ade engineering status --governor <id> [--node <nodeId>]` | `aexus-ade engineering diff --governor <id> --node <nodeId>` | `aexus-ade engineering reports --governor <id>` | `aexus-ade engineering review --governor <id> --node <nodeId> --role <employee|manager> --verdict <pass|reject|guidance> [--report <text>] [--feedback <text>]` | `aexus-ade engineering gate --governor <id> --node <nodeId> --verdict <pass|rollback> [--target-node <upstreamNodeId>] [--feedback <text>]` | `aexus-ade engineering watchdog-action --governor <id> --node <nodeId> --action <remind|kill-restart> [--message <text>]`',
			'  - ADE Inbox: `aexus-ade inbox list [--unread-only] [--governor <id>]` | `aexus-ade inbox post --from <governorId> --message <text>` | `aexus-ade inbox mark-read (<id>|--all)` | `aexus-ade inbox resolve --id <msgId>`',
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

	if (compactDeltaMode) {
		// Work-tree topology is locked by blueprint.md, so subsequent turns need zero delta hierarchy overhead.
		if (agent.treeType === 'engineering' || agent.treeType === 'research') {
			return undefined;
		}
		const subordinates = projects.getDirectSubordinates(agent.id);
		if (!agent.role && subordinates.length === 0) {
			return undefined;
		}
		const rankDef = resolveEffectiveRankDefinition(roleConfig, agent.role, subordinates.length > 0);
		if (rankDef.pureExecution && subordinates.length === 0) {
			return undefined;
		}
		const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
		if (!supervisor && subordinates.length === 0) {
			return undefined;
		}
		const subSummary = subordinates.length > 0
			? subordinates.map(c => `${c.label} (${c.id}, ${formatRoleTitle(resolveAdeAgentRank(c, projects.hasSubordinates(c.id), roleConfig), roleConfig)})`).join(', ')
			: 'None';
		return [
			'[ADE Live Hierarchy State]',
			`- Role: ${rankDef.name} (session: ${agent.id}, project: ${projects.getProjectName(agent.projectUri)})`,
			...(supervisor ? [`- Supervisor: ${supervisor.label} (${supervisor.id})`] : []),
			`- Direct Subordinates: ${subSummary}`,
		].join('\n');
	}

	return buildAdeAgentRoleContext(projects, sessions, agent, roleConfig);
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
	'claude-code': 'aexus-claude',
	kilo: 'aexus-kilo',
	kilocode: 'aexus-kilo',
	'kilo-code': 'aexus-kilo',
	opencode: 'aexus-opencode',
	dsh: 'aexus-dsh',
	deepseek: 'aexus-dsh',
	'deepseek-harness': 'aexus-dsh',
	agy: 'aexus-antigravity',
	antigravity: 'aexus-antigravity',
	'google-antigravity': 'aexus-antigravity',
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
	const engineeringService = tryGetService(accessor, IAdeEngineeringService);
	const inboxService = tryGetService(accessor, IAdeInboxService);
	const cloudHosts = tryGetService(accessor, IAdeCloudHostBackendService);
	const roleSchemaService = tryGetService(accessor, IAdeRoleSchemaService);
	const roleConfig = roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;

	// Fixed Aexus-Code Kernel Primitive API Authorization Gate:
	// User-customizable rank schemas control WHO may call WHICH fixed core primitive API.
	const permission = checkAdeApiPermission(roleConfig, params.caller, action);
	if (!permission.allowed) {
		throw new Error(permission.reason ?? localize('adeApiPermissionDenied', "Permission denied for action '{0}'.", String(action)));
	}

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
		if (/^[A-Za-z0-9._@-]{2,}:(?:\/(?!\/)|[a-zA-Z]:[\\/])(.*)$/.test(trimmed) && !/^(file|aexus-ssh|vscode-remote|http|https):/i.test(trimmed)) {
			const colonIdx = trimmed.indexOf(':');
			const hostPart = trimmed.slice(0, colonIdx);
			const pathPart = trimmed.slice(colonIdx + 1);
			return buildCloudProjectUri(hostPart, pathPart, /^\/?[a-zA-Z]:[\\/]/.test(pathPart) ? 'windows' : undefined);
		}
		if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
			return URI.parse(trimmed);
		}
		if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
			if (projectUri.scheme === AEXUS_SSH_SCHEME) {
				const inferredOs = (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || /^\/[a-zA-Z]:\//.test(projectUri.path)) ? 'windows' : undefined;
				return buildCloudProjectUri(projectUri.authority, trimmed, inferredOs);
			}
			return URI.file(trimmed);
		}
		return joinPath(projectUri, trimmed);
	};

	switch (action) {
		case 'status':
			return buildControlStatus(modes, projects, navigation, editors, sessions, roleConfig);

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
				path: formatProjectDisplayPath(normalized),
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
				projects.registerProject(uri, idx === 0 && customName ? customName : (basename(uri) || uri.authority || 'project'));
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
				name: customName || basename(uris[0]) || uris[0].authority || 'project',
				path: formatProjectDisplayPath(uris[0]),
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
			if (engineeringService) {
				await engineeringService.whenReady().catch(() => undefined);
				for (const rootGov of projectAgents.filter(a => !a.parentId && (engineeringService.hasTree(a.id) || Boolean(a.treeType)))) {
					await engineeringService.removeTree(rootGov.id).catch(() => undefined);
				}
			}
			await editors.closeAgents(projectAgents);
			if (navigation.focusedProject && uriIdentity.extUri.isEqual(navigation.focusedProject.uri, targetUri)) {
				navigation.goHome();
			}
			projects.removeProject(targetUri);
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			return { removed: formatProjectDisplayPath(targetUri), uri: targetUri.toString() };
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
			if (deleteSessions && engineeringService) {
				await engineeringService.whenReady().catch(() => undefined);
				for (const rootGov of projectAgents.filter(a => !a.parentId && (engineeringService.hasTree(a.id) || Boolean(a.treeType)))) {
					await engineeringService.removeTree(rootGov.id).catch(() => undefined);
				}
			}
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
				deleted: formatProjectDisplayPath(targetUri),
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
				projectPath: formatProjectDisplayPath(projectUri),
				repositoryRoot: repository?.provider.rootUri ? formatProjectDisplayPath(repository.provider.rootUri) : undefined,
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
						path: formatProjectDisplayPath(child.resource),
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
				projectPath: formatProjectDisplayPath(projectUri),
				directory: formatProjectDisplayPath(rootDirUri),
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
				opened: formatProjectDisplayPath(fileUri),
				project: projects.getProjectName(projectUri),
				projectPath: formatProjectDisplayPath(projectUri),
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
				openedDiff: formatProjectDisplayPath(fileUri),
				project: projects.getProjectName(projectUri),
				projectPath: formatProjectDisplayPath(projectUri),
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
				projectPath: formatProjectDisplayPath(item.projectUri),
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
			const rankFilter = parseRankFilter(params.rank ?? params.role, roleConfig);
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
					if (rankFilter && resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), roleConfig) !== rankFilter) {
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
				.map(agent => toSessionSummary(projects, sessions, agent, roleConfig));
		}

		case 'session.info':
		case 'session.get': {
			const agent = resolveAgentFromParams(projects, params);
			const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
			const subordinates = projects.getDirectSubordinates(agent.id);
			return {
				session: toSessionSummary(projects, sessions, agent, roleConfig),
				...(supervisor ? { supervisor: toSessionSummary(projects, sessions, supervisor, roleConfig) } : {}),
				subordinates: subordinates.map(child => toSessionSummary(projects, sessions, child, roleConfig)),
			};
		}

		case 'session.subordinates':
		case 'session.children': {
			const agent = resolveSupervisorOrSession(projects, editors, params);
			const subordinates = params.recursive === true
				? projects.getSubtree(agent.id).slice(1)
				: projects.getDirectSubordinates(agent.id);
			return {
				supervisor: toSessionSummary(projects, sessions, agent, roleConfig),
				count: subordinates.length,
				subordinates: subordinates.map(child => toSessionSummary(projects, sessions, child, roleConfig)),
			};
		}

		case 'session.tree':
		case 'session.subtree': {
			const agent = resolveSupervisorOrSession(projects, editors, params);
			return buildSessionTreeResult(projects, sessions, agent, roleConfig);
		}

		case 'session.create': {
			const rawParentId = params.parentId ?? params.parent;
			const parent = typeof rawParentId === 'string' && rawParentId.trim()
				? resolveAgentFromParams(projects, { id: rawParentId })
				: undefined;
			if (parent && projects.isLockedByWorkTree?.(parent.id)) {
				throw new Error(localize('adeLockedByEngineeringCreate', "Session '{0}' is locked by an Engineering tree. Modify topology via the Engineering canvas or 'aexus-ade engineering blueprint apply'.", parent.label));
			}

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
			const topRankId = getTopRankDefinition(roleConfig).id;
			if (parent) {
				const parentHasSubs = projects.hasSubordinates(parent.id);
				const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parent.role, parentHasSubs);
				if (parent.parentId && (parentRankDef.pureExecution || !parentRankDef.canHaveSubordinates) && !parentHasSubs) {
					throw new Error(localize('adeWorkerCannotSpawnSubordinates', "Rank '{0}' cannot have subordinate sessions. Promote its role first.", parentRankDef.name));
				}
				if (params.role !== undefined) {
					role = parseRole(params.role, roleConfig);
					if (!parent.parentId && !parent.role) {
						projects.setAgentRole(parent.id, topRankId);
					}
				} else if (!parent.parentId && !parent.role && !parentHasSubs) {
					projects.setAgentRole(parent.id, topRankId);
					role = getNextLowerAdeRole(topRankId, true, roleConfig).childRole;
				} else {
					role = getNextLowerAdeRole(parent.role, parentHasSubs, roleConfig).childRole;
				}
			} else {
				role = parseRole(params.role, roleConfig);
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
			return toSessionSummary(projects, sessions, projects.getAgent(createdAgent.id)!, roleConfig);
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
			if (parent && projects.isLockedByWorkTree?.(parent.id)) {
				throw new Error(localize('adeLockedByEngineeringCreate', "Session '{0}' is locked by an Engineering tree. Modify topology via the Engineering canvas or 'aexus-ade engineering blueprint apply'.", parent.label));
			}
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
			const topRankId = getTopRankDefinition(roleConfig).id;
			if (parent) {
				const parentHasSubs = projects.hasSubordinates(parent.id);
				const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parent.role, parentHasSubs);
				if (parent.parentId && (parentRankDef.pureExecution || !parentRankDef.canHaveSubordinates) && !parentHasSubs) {
					throw new Error(localize('adeWorkerCannotSpawnSubordinates', "Rank '{0}' cannot have subordinate sessions. Promote its role first.", parentRankDef.name));
				}
				if (params.role !== undefined) {
					role = parseRole(params.role, roleConfig);
					if (!parent.parentId && !parent.role) {
						projects.setAgentRole(parent.id, topRankId);
					}
				} else if (!parent.parentId && !parent.role && !parentHasSubs) {
					projects.setAgentRole(parent.id, topRankId);
					role = getNextLowerAdeRole(topRankId, true, roleConfig).childRole;
				} else {
					role = getNextLowerAdeRole(parent.role, parentHasSubs, roleConfig).childRole;
				}
			} else {
				role = parseRole(params.role, roleConfig);
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
			return toSessionSummary(projects, sessions, projects.getAgent(createdAgent.id)!, roleConfig);
		}

		case 'session.connect': {
			const agent = resolveAgentFromParams(projects, params);
			if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByEngineeringConnect', "Subordinate session '{0}' is locked by an Engineering tree. Update its engine via Engineering blueprint or 'aexus-ade engineering configure'.", agent.label));
			}
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
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByEngineeringRole', "Session '{0}' is locked by an Engineering tree and its role cannot be changed manually.", agent.label));
			}
			const nextRole = parseRole(params.role, roleConfig);
			const nextIsPure = !nextRole || isPureExecutionRank(roleConfig, nextRole);
			if (nextIsPure && projects.hasSubordinates(agent.id)) {
				throw new Error(localize('adeCannotClearRoleWithSubordinates', "Cannot clear role while session has subordinate agents."));
			}
			projects.setAgentRole(agent.id, nextRole);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!, roleConfig);
		}

		case 'session.reparent':
		case 'session.nest':
		case 'session.move': {
			const agent = resolveAgentFromParams(projects, params);
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByEngineeringMove', "Session '{0}' belongs to a locked Engineering tree and cannot be reparented manually.", agent.label));
			}
			const rawParent = params.parentId ?? params.parent;
			const clearParent = rawParent === undefined || rawParent === null || rawParent === '' || rawParent === 'none' || rawParent === 'root';
			const parentAgent = clearParent ? undefined : resolveAgentFromParams(projects, { id: rawParent });
			if (parentAgent && projects.isLockedByWorkTree?.(parentAgent.id)) {
				throw new Error(localize('adeLockedByEngineeringTarget', "Target supervisor '{0}' belongs to a locked Engineering tree.", parentAgent.label));
			}
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const targetProjectUri = rawProject !== undefined
				? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject))
				: undefined;
			const moved = projects.reparentAgent(agent.id, parentAgent?.id, targetProjectUri);
			if (!moved) {
				throw new Error(localize('adeCannotNestSession', "Cannot move session '{0}' under the requested target.", agent.label));
			}
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!, roleConfig);
		}

		case 'session.send': {
			const agent = resolveAgentFromParams(projects, params);
			const rawMessage = params.message ?? params.prompt ?? params.text;
			if (typeof rawMessage !== 'string' || !rawMessage.trim()) {
				throw new Error(localize('adeMissingMessage', "Message text is required."));
			}
			const rank = resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), roleConfig);
			if (!agent.session) {
				projects.setDraft(agent.id, rawMessage);
				return { id: agent.id, label: agent.label, rank, status: 'draft', draft: rawMessage };
			}
			const wait = Boolean(params.wait);
			const dispatchKind = await sendMessageToSessionResource(chatService, agent.session.resource, rawMessage, wait);
			let reply: string | undefined;
			if (wait) {
				projects.setAgentStatus(agent.id, 'idle', true);
			}
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
			const rank = resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), roleConfig);
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
			if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByEngineeringArchive', "Subordinate session '{0}' is locked by an Engineering tree and cannot archive the tree on its own.", agent.label));
			}
			const root = projects.getRootAgent(agent.id) ?? agent;
			const targetArchived = params.restore === true ? false : (typeof params.archived === 'boolean' ? params.archived : true);
			const subtree = projects.getSubtree(root.id);
			projects.setArchived(root.id, targetArchived);
			if (targetArchived) {
				await editors.closeAgents(subtree);
			}
			return toSessionSummary(projects, sessions, projects.getAgent(root.id)!);
		}

		case 'session.remove':
		case 'session.detach': {
			const agent = resolveAgentFromParams(projects, params);
			if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByEngineeringDetach', "Subordinate session '{0}' is locked by an Engineering tree. Remove or edit nodes via Engineering blueprint.", agent.label));
			}
			await engineeringService?.whenReady().catch(() => undefined);
			const initialSubtree = projects.getSubtree(agent.id);
			if (!agent.parentId && (engineeringService?.hasTree(agent.id) || Boolean(agent.treeType))) {
				await engineeringService?.removeTree(agent.id).catch(() => undefined);
			}
			const mergedMap = new Map<string, IAdeAgent>(initialSubtree.map(item => [item.id, item]));
			for (const item of projects.getSubtree(agent.id)) {
				mergedMap.set(item.id, item);
			}
			const subtree = [...mergedMap.values()];
			for (const member of subtree) {
				if (member.session) {
					await sessions.stop?.(member.session).catch(() => undefined);
				}
			}
			projects.removeAgent(agent.id);
			for (const member of subtree) {
				if (projects.getAgent(member.id)) {
					projects.removeAgent(member.id);
				}
			}
			await editors.closeAgents(subtree);
			return { detached: agent.id, removedIds: subtree.map(item => item.id), count: subtree.length };
		}

		case 'session.delete': {
			const agent = resolveAgentFromParams(projects, params);
			if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByEngineeringDelete', "Subordinate session '{0}' is locked by an Engineering tree. Remove or edit nodes via Engineering blueprint.", agent.label));
			}
			await engineeringService?.whenReady().catch(() => undefined);
			const initialSubtree = projects.getSubtree(agent.id);
			if (!agent.parentId && (engineeringService?.hasTree(agent.id) || Boolean(agent.treeType))) {
				await engineeringService?.removeTree(agent.id).catch(() => undefined);
			}
			const mergedMap = new Map<string, IAdeAgent>(initialSubtree.map(item => [item.id, item]));
			for (const item of projects.getSubtree(agent.id)) {
				mergedMap.set(item.id, item);
			}
			const subtree = [...mergedMap.values()];
			for (const member of subtree) {
				if (member.session) {
					await sessions.stop?.(member.session).catch(() => undefined);
					await sessions.delete(member.session).catch(() => undefined);
				}
			}
			await editors.closeAgents(subtree);
			projects.removeAgent(agent.id);
			for (const member of subtree) {
				if (projects.getAgent(member.id)) {
					projects.removeAgent(member.id);
				}
			}
			return { deleted: agent.id, deletedIds: subtree.map(item => item.id), count: subtree.length };
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

		case 'engineering.init': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const onChildren = params.onChildren === 'relocate' || params.onChildren === 'delete'
				? params.onChildren
				: undefined;
			const relocateTarget = typeof params.relocateTargetParentId === 'string' && params.relocateTargetParentId.trim()
				? resolveAgentFromParams(projects, { id: params.relocateTargetParentId }).id
				: undefined;
			const treeType: AdeWorkTreeType = params.treeType === 'research' ? 'research' : 'engineering';
			const snap = await engineeringService.initTree({
				governorSessionId: gov.id,
				treeType,
				onChildren,
				relocateTargetParentId: relocateTarget,
			});
			if (params.open === true) {
				await engineeringService.openEngineeringEditor(gov.id, { side: Boolean(params.side) });
			}
			return {
				governorSessionId: snap.governorSessionId,
				governorLabel: snap.governorLabel,
				treeType: snap.treeType,
				runStatus: snap.state.runStatus,
				managers: snap.blueprint.managers,
				progress: snap.progress,
			};
		}

		case 'engineering.list': {
			if (!engineeringService) {
				return [];
			}
			await engineeringService.whenReady();
			const rawProject = params.project ?? params.projectPath ?? params.path;
			const matchedProject = rawProject ? findMatchingProject(projects, uriIdentity, rawProject) : undefined;
			const projectPath = matchedProject?.uri.fsPath ?? (typeof rawProject === 'string' && rawProject.trim() ? toUri(rawProject)?.fsPath : undefined);
			const treeType = params.treeType === 'research' ? 'research' : (params.treeType === 'engineering' ? 'engineering' : undefined);
			return engineeringService.listTrees(projectPath, treeType);
		}

		case 'engineering.open': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			if (!engineeringService.hasTree(gov.id)) {
				await engineeringService.initTree({ governorSessionId: gov.id });
			}
			await engineeringService.openEngineeringEditor(gov.id, { side: Boolean(params.side) });
			return { opened: gov.id, label: gov.label };
		}

		case 'engineering.blueprint.get': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			await engineeringService.whenReady();
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const text = engineeringService.getBlueprintText(gov.id);
			if (text === undefined) {
				throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", gov.id));
			}
			return params.raw === true ? text : { governorSessionId: gov.id, blueprint: text };
		}

		case 'engineering.blueprint.validate': {
			let blueprintText = typeof params.text === 'string' ? params.text : undefined;
			if (blueprintText === undefined && typeof params.file === 'string' && params.file.trim()) {
				if (!fileService) {
					throw new Error('File service is unavailable to read blueprint file.');
				}
				const fileUri = toUri(params.file);
				if (!fileUri) {
					throw new Error(`Invalid blueprint file path: ${params.file}`);
				}
				const rawBytes = await fileService.readFile(fileUri);
				blueprintText = rawBytes.value.toString();
			}
			if (!blueprintText || !blueprintText.trim()) {
				throw new Error('Blueprint markdown content (--file or --text) is required.');
			}
			const parsed = parseEngineeringBlueprint(blueprintText);
			const scopeConflictWarnings = detectSharedWorkspaceScopeConflicts(parsed);
			return {
				valid: true,
				treeType: parsed.metadata.treeType,
				workspaceIsolation: parsed.metadata.workspaceIsolation,
				...(scopeConflictWarnings.length > 0 ? { scopeConflictWarnings } : {}),
				nodeCount: parsed.nodes.length,
				edgeCount: parsed.edges.length,
				managers: parsed.managers,
			};
		}

		case 'engineering.blueprint.apply': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			let blueprintText = typeof params.text === 'string' ? params.text : undefined;
			if (blueprintText === undefined && typeof params.file === 'string' && params.file.trim()) {
				if (!fileService) {
					throw new Error('File service is unavailable to read blueprint file.');
				}
				const fileUri = toUri(params.file);
				if (!fileUri) {
					throw new Error(`Invalid blueprint file path: ${params.file}`);
				}
				const rawBytes = await fileService.readFile(fileUri);
				blueprintText = rawBytes.value.toString();
			}
			if (!blueprintText || !blueprintText.trim()) {
				throw new Error('Blueprint markdown content (--file or --text) is required.');
			}
			if (!engineeringService.hasTree(gov.id)) {
				await engineeringService.initTree({ governorSessionId: gov.id });
			}
			const snap = await engineeringService.applyBlueprint({
				governorSessionId: gov.id,
				blueprintText,
				forceStopRunning: params.forceStopRunning === true,
				caller: typeof params.caller === 'string' ? params.caller : undefined,
			});
			return {
				governorSessionId: snap.governorSessionId,
				runStatus: snap.state.runStatus,
				managers: snap.blueprint.managers,
				nodeCount: snap.blueprint.nodes.length,
				edgeCount: snap.blueprint.edges.length,
				progress: snap.progress,
			};
		}

		case 'engineering.run': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const caller = typeof params.caller === 'string' ? params.caller : 'secretary';
			const snap = await engineeringService.runTree(gov.id, caller);
			return {
				governorSessionId: snap.governorSessionId,
				runStatus: snap.state.runStatus,
				progress: snap.progress,
			};
		}

		case 'engineering.pause': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const snap = await engineeringService.pauseTree(gov.id);
			return { governorSessionId: snap.governorSessionId, runStatus: snap.state.runStatus, progress: snap.progress };
		}

		case 'engineering.resume': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const caller = typeof params.caller === 'string' ? params.caller : 'secretary';
			const snap = await engineeringService.resumeTree(gov.id, caller);
			return { governorSessionId: snap.governorSessionId, runStatus: snap.state.runStatus, progress: snap.progress };
		}

		case 'engineering.stop': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const snap = await engineeringService.stopTree(gov.id);
			return { governorSessionId: snap.governorSessionId, runStatus: snap.state.runStatus, progress: snap.progress };
		}

		case 'engineering.configure': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const rawRole = typeof params.role === 'string' ? params.role.trim().toLowerCase() : 'all';
			const role: 'worker' | 'employee' | 'manager' | 'all' = (rawRole === 'worker' || rawRole === 'employee' || rawRole === 'manager') ? rawRole : 'all';
			const rawIso = typeof params.isolation === 'string' ? params.isolation : (typeof params.workspaceIsolation === 'string' ? params.workspaceIsolation : undefined);
			const workspaceIsolation: AdeWorkspaceIsolationMode | undefined = rawIso === 'worktree' ? 'worktree' : (rawIso === 'shared' ? 'shared' : undefined);
			const rawThinking = typeof params.thinking === 'string' && params.thinking.trim()
				? normalizeThinkingLevel(params.thinking.trim(), 'high')
				: undefined;
			const rawModel = typeof params.model === 'string' ? params.model.trim() : undefined;
			const clearModel = params.clearModel === true || rawModel === 'default' || rawModel === 'none';
			const rawNode = params.all === true ? undefined : (typeof params.node === 'string' ? params.node.trim() : (typeof params.nodeId === 'string' ? params.nodeId.trim() : undefined));
			const rawBudget = params.maxBudgetUsd !== undefined ? Number(params.maxBudgetUsd) : undefined;
			const clearBudget = params.clearBudget === true || rawBudget === 0;
			const snap = await engineeringService.configureTree({
				governorSessionId: gov.id,
				nodeId: rawNode || undefined,
				role,
				engine: typeof params.engine === 'string' && params.engine.trim() ? params.engine.trim() : undefined,
				model: clearModel ? undefined : rawModel,
				clearModel,
				thinking: rawThinking,
				workspaceIsolation,
				maxBudgetUsd: (!clearBudget && typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0) ? rawBudget : undefined,
				clearBudget,
				forceStopRunning: params.forceStopRunning === true,
			});
			return {
				governorSessionId: snap.governorSessionId,
				runStatus: snap.state.runStatus,
				workspaceIsolation: snap.blueprint.metadata.workspaceIsolation,
				maxBudgetUsd: snap.blueprint.metadata.maxBudgetUsd,
				managers: snap.blueprint.managers,
				nodes: snap.blueprint.nodes.map(n => ({ id: n.id, title: n.title, type: n.type, worker: n.worker, employee: n.employee })),
			};
		}

		case 'engineering.reset': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const rawNode = params.node ?? params.nodeId;
			const snap = await engineeringService.resetTree({
				governorSessionId: gov.id,
				nodeId: typeof rawNode === 'string' && rawNode.trim() ? rawNode.trim() : undefined,
				keepCompleted: params.keepCompleted === true,
			});
			return {
				governorSessionId: snap.governorSessionId,
				runStatus: snap.state.runStatus,
				progress: snap.progress,
				tokenUsage: snap.tokenUsage,
			};
		}

		case 'engineering.diff': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			await engineeringService.whenReady();
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const snap = engineeringService.getTreeSnapshot(gov.id);
			if (!snap) {
				throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", gov.id));
			}
			const rawNode = typeof params.node === 'string' ? params.node.trim() : (typeof params.nodeId === 'string' ? params.nodeId.trim() : '');
			if (!rawNode) {
				throw new Error('Specify --node <nodeId> to inspect Worker diff.');
			}
			const found = snap.nodes.find(n => n.node.id === rawNode);
			if (!found) {
				throw new Error(`Node '${rawNode}' not found in Engineering tree '${gov.id}'.`);
			}
			return {
				governorSessionId: gov.id,
				nodeId: rawNode,
				nodeTitle: found.node.title,
				phase: found.runtime.phase,
				touchedFiles: found.runtime.lastChanges?.touchedFiles ?? [],
				combinedDiff: found.runtime.lastChanges?.combinedDiff ?? '',
				capturedAt: found.runtime.lastChanges?.capturedAt,
				truncated: found.runtime.lastChanges?.truncated,
			};
		}

		case 'engineering.reports': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			await engineeringService.whenReady();
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const snap = engineeringService.getTreeSnapshot(gov.id);
			if (!snap) {
				throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", gov.id));
			}
			const includeStale = params.includeStale === true;
			const reports = Object.values(snap.state.reports).filter(r => includeStale || !r.stale);
			return {
				governorSessionId: gov.id,
				runStatus: snap.state.runStatus,
				reports,
			};
		}

		case 'engineering.remove': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			await engineeringService.removeTree(gov.id);
			return { removed: gov.id };
		}

		case 'engineering.status': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			await engineeringService.whenReady();
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const snap = engineeringService.getTreeSnapshot(gov.id);
			if (!snap) {
				throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", gov.id));
			}
			const rawNode = params.node ?? params.nodeId;
			if (typeof rawNode === 'string' && rawNode.trim()) {
				const nodeStatus = snap.nodes.find(n => n.node.id === rawNode.trim());
				if (!nodeStatus) {
					throw new Error(`Node '${rawNode}' not found in Engineering tree '${gov.id}'.`);
				}
				return {
					governorSessionId: snap.governorSessionId,
					runStatus: snap.state.runStatus,
					tokenUsage: snap.tokenUsage,
					node: nodeStatus,
				};
			}
			return {
				governorSessionId: snap.governorSessionId,
				governorLabel: snap.governorLabel,
				projectPath: snap.projectPath,
				treeType: snap.treeType,
				runStatus: snap.state.runStatus,
				progress: snap.progress,
				tokenUsage: snap.tokenUsage,
				financials: computeTreeFinancialSummary(snap, readAdePricingOptions(configurationService)),
				managers: snap.blueprint.managers,
				nodes: snap.nodes,
				edges: snap.edges,
				reports: snap.state.reports,
				recentEvents: snap.state.events.slice(-20),
			};
		}

		case 'engineering.review': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const rawNode = params.node ?? params.nodeId;
			const nodeId = typeof rawNode === 'string' ? rawNode.trim() : '';
			if (!nodeId) {
				throw new Error('Node ID (--node <nodeId>) is required for engineering review.');
			}
			const rawRole = typeof params.role === 'string' ? params.role.trim().toLowerCase() : '';
			const reviewerSlotId = resolveWorkTreeSlotRank(roleConfig, 'reviewer').id.toLowerCase();
			const segmentOwnerSlotId = resolveWorkTreeSlotRank(roleConfig, 'segment_owner').id.toLowerCase();
			let role: 'employee' | 'manager' | undefined;
			if (rawRole === 'employee') {
				role = 'employee';
			} else if (rawRole === 'manager') {
				role = 'manager';
			} else if (rawRole && rawRole === reviewerSlotId && rawRole === segmentOwnerSlotId) {
				// Collapsed 2-tier preset (e.g. flat-swarm coordinator): disambiguate using active node phase.
				const currentSnap = engineeringService.getTreeSnapshot(gov.id);
				const currentPhase = currentSnap?.nodes.find(n => n.node.id === nodeId)?.runtime.phase;
				role = currentPhase === 'manager_review' ? 'manager' : 'employee';
			} else if (rawRole && rawRole === reviewerSlotId) {
				role = 'employee';
			} else if (rawRole && rawRole === segmentOwnerSlotId) {
				role = 'manager';
			}
			if (!role) {
				throw new Error(`Invalid review role '${String(params.role)}': expected 'employee', 'manager', '${reviewerSlotId}', or '${segmentOwnerSlotId}'.`);
			}
			if (params.verdict !== 'pass' && params.verdict !== 'reject' && params.verdict !== 'guidance') {
				throw new Error(`Invalid review verdict '${String(params.verdict)}': expected 'pass', 'reject', or 'guidance'.`);
			}
			const verdict = params.verdict;
			const reportText = typeof params.report === 'string'
				? params.report
				: (typeof params.summary === 'string' ? params.summary : undefined);
			const snap = await engineeringService.submitReview({
				governorSessionId: gov.id,
				nodeId,
				role,
				verdict,
				report: reportText,
				feedback: typeof params.feedback === 'string' ? params.feedback : undefined,
			});
			const updatedNode = snap.nodes.find(n => n.node.id === nodeId);
			return {
				governorSessionId: snap.governorSessionId,
				runStatus: snap.state.runStatus,
				node: updatedNode,
				progress: snap.progress,
			};
		}

		case 'engineering.gate': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const rawNode = params.node ?? params.nodeId;
			const nodeId = typeof rawNode === 'string' ? rawNode.trim() : '';
			const verdict = params.verdict === 'rollback' ? 'rollback' : 'pass';
			const rawTargetNode = params.targetNode ?? params.targetNodeId;
			const snap = await engineeringService.submitGateVerdict({
				governorSessionId: gov.id,
				nodeId,
				verdict,
				targetNodeId: typeof rawTargetNode === 'string' ? rawTargetNode : undefined,
				feedback: typeof params.feedback === 'string' ? params.feedback : undefined,
			});
			return snap;
		}

		case 'engineering.watchdogAction':
		case 'engineering.watchdog-action': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const rawNode = params.node ?? params.nodeId;
			const nodeId = typeof rawNode === 'string' ? rawNode.trim() : '';
			const rawAction = params.watchdogAction ?? params.action;
			const watchdogAction = rawAction === 'kill-restart' ? 'kill-restart' : 'remind';
			const snap = await engineeringService.executeWatchdogAction({
				governorSessionId: gov.id,
				nodeId,
				action: watchdogAction,
				message: typeof params.message === 'string' ? params.message : undefined,
			});
			return snap;
		}

		case 'engineering.templates.list': {
			const rawType = typeof params.treeType === 'string' ? params.treeType.trim().toLowerCase() : undefined;
			const treeType: AdeWorkTreeType | undefined = rawType === 'research' ? 'research' : (rawType === 'engineering' ? 'engineering' : undefined);
			return listBlueprintTemplates(treeType);
		}

		case 'engineering.templates.apply': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const templateId = typeof params.template === 'string' ? params.template.trim() : (typeof params.templateId === 'string' ? params.templateId.trim() : '');
			if (!templateId) {
				throw new Error('Specify --template <templateId> to apply a blueprint template.');
			}
			const rawPreset = typeof params.preset === 'string' ? params.preset.trim().toLowerCase() : 'balanced';
			const preset: AdeBlueprintTemplatePreset = rawPreset === 'max-quality' || rawPreset === 'fast-economy' ? rawPreset : 'balanced';
			const rawIso = typeof params.isolation === 'string' ? params.isolation : (typeof params.workspaceIsolation === 'string' ? params.workspaceIsolation : undefined);
			const workspaceIsolation: AdeWorkspaceIsolationMode | undefined = rawIso === 'worktree' ? 'worktree' : (rawIso === 'shared' ? 'shared' : undefined);
			const rawBudget = params.maxBudgetUsd !== undefined ? Number(params.maxBudgetUsd) : undefined;
			const existing = engineeringService.getTreeSnapshot(gov.id);
			const bp = buildBlueprintFromTemplate(templateId, {
				governorSessionId: gov.id,
				defaultEngine: typeof params.engine === 'string' && params.engine.trim() ? params.engine.trim() : (gov.preferredEngineId ?? gov.session?.engineId),
				secondaryEngine: typeof params.secondaryEngine === 'string' && params.secondaryEngine.trim() ? params.secondaryEngine.trim() : undefined,
				treeType: existing?.treeType,
				preset,
				workspaceIsolation,
				maxBudgetUsd: typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : undefined,
			});
			const snap = await engineeringService.applyBlueprint({
				governorSessionId: gov.id,
				blueprintText: serializeEngineeringBlueprint(bp),
				forceStopRunning: params.forceStopRunning === true,
				caller: typeof params.caller === 'string' ? params.caller : undefined,
			});
			return {
				governorSessionId: snap.governorSessionId,
				templateId,
				preset,
				treeType: snap.treeType,
				workspaceIsolation: snap.blueprint.metadata.workspaceIsolation,
				maxBudgetUsd: snap.blueprint.metadata.maxBudgetUsd,
				nodeCount: snap.blueprint.nodes.length,
				managerCount: snap.blueprint.managers.length,
			};
		}

		case 'engineering.report': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			await engineeringService.whenReady();
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			const snap = engineeringService.getTreeSnapshot(gov.id);
			if (!snap) {
				throw new Error(localize('adeEngineeringNotInitialized', "Governor '{0}' has not initialized an Engineering tree yet.", gov.id));
			}
			return {
				governorSessionId: snap.governorSessionId,
				treeType: snap.treeType,
				financials: computeTreeFinancialSummary(snap, readAdePricingOptions(configurationService)),
				markdown: buildEngineeringRunReportMarkdown(snap),
				svg: buildEngineeringDagSvg(snap),
			};
		}

		case 'engineering.demo': {
			if (!engineeringService?.startDemoSimulation) {
				throw new Error('ADE Engineering interactive demo is not available.');
			}
			await engineeringService.whenReady();
			modes.setMode('ade');
			const explicitGov = params.governor ?? params.governorSessionId ?? params.id;
			let govId: string;
			if (typeof explicitGov === 'string' && explicitGov.trim()) {
				const gov = resolveAgentFromParams(projects, { id: explicitGov });
				govId = gov.id;
			} else {
				const projectUri = projects.selectedProject?.uri ?? projects.projects[0]?.uri;
				if (!projectUri) {
					throw new Error('Add or select a project folder first before starting the interactive demo.');
				}
				const demoLabel = 'Interactive Demo · Feature Ship';
				let demoGov = projects.agents.find(a => !a.parentId && a.label === demoLabel && a.projectUri.toString() === projectUri.toString());
				if (!demoGov) {
					const orchestratorRankId = resolveWorkTreeSlotRank(roleConfig, 'orchestrator').id;
					demoGov = projects.addSession(
						projectUri,
						{ engineId: 'aexus-claude', resource: URI.parse(`aexus-claude://aexus-demo/${Date.now()}`) },
						demoLabel,
						{ role: orchestratorRankId },
					);
				}
				govId = demoGov.id;
			}
			if (!engineeringService.hasTree(govId)) {
				await engineeringService.initTree({ governorSessionId: govId, treeType: 'engineering' });
			}
			await engineeringService.openEngineeringEditor(govId);
			const snap = await engineeringService.startDemoSimulation(govId);
			return {
				governorSessionId: govId,
				demo: true,
				nodeCount: snap.blueprint.nodes.length,
				managerCount: snap.blueprint.managers.length,
			};
		}

		case 'engineering.generate': {
			if (!engineeringService) {
				throw new Error('ADE Engineering service is not available.');
			}
			await engineeringService.whenReady();
			const promptText = typeof params.prompt === 'string' ? params.prompt.trim() : '';
			if (!promptText) {
				throw new Error('Provide a non-empty prompt to synthesize a DAG blueprint.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			if (!engineeringService.hasTree(gov.id)) {
				await engineeringService.initTree({ governorSessionId: gov.id, treeType: 'engineering' });
			}
			const synth = synthesizeBlueprintFromPrompt(promptText, {
				governorSessionId: gov.id,
				defaultEngine: typeof params.engine === 'string' ? params.engine : (gov.preferredEngineId ?? gov.session?.engineId ?? 'claude-code'),
				secondaryEngine: typeof params.secondaryEngine === 'string' ? params.secondaryEngine : undefined,
				maxBudgetUsd: typeof params.maxBudgetUsd === 'number' ? params.maxBudgetUsd : undefined,
			});
			const blueprintText = serializeEngineeringBlueprint(synth.blueprint);
			const snap = await engineeringService.applyBlueprint({
				governorSessionId: gov.id,
				blueprintText,
				forceStopRunning: Boolean(params.forceStopRunning),
				caller: typeof params.caller === 'string' ? params.caller : undefined,
			});
			if (params.open !== false) {
				modes.setMode('ade');
				await engineeringService.openEngineeringEditor(gov.id);
			}
			return {
				governorSessionId: gov.id,
				archetype: synth.archetype,
				treeType: synth.treeType,
				tracks: synth.tracks,
				nodeCount: snap.blueprint.nodes.length,
				managerCount: snap.blueprint.managers.length,
				maxBudgetUsd: snap.blueprint.metadata.maxBudgetUsd,
			};
		}

		case 'engineering.worktrees.merge': {
			if (!engineeringService?.mergeTreeWorktrees) {
				throw new Error('ADE Engineering worktree merge is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			return engineeringService.mergeTreeWorktrees(gov.id);
		}

		case 'engineering.worktrees.cleanup': {
			if (!engineeringService?.cleanupTreeWorktrees) {
				throw new Error('ADE Engineering worktree cleanup is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.governor ?? params.governorSessionId ?? params.id });
			await engineeringService.cleanupTreeWorktrees(gov.id);
			return { ok: true, governorSessionId: gov.id };
		}

		case 'inbox.list': {
			if (!inboxService) {
				return [];
			}
			const rawGov = params.governor ?? params.governorId;
			const govFilter = typeof rawGov === 'string' && rawGov.trim()
				? resolveAgentFromParams(projects, { id: rawGov }).id
				: undefined;
			return inboxService.list({
				unreadOnly: params.unreadOnly === true,
				governorSessionId: govFilter,
				includeResolved: params.includeResolved !== false,
			});
		}

		case 'inbox.post': {
			if (!inboxService) {
				throw new Error('ADE Inbox service is not available.');
			}
			const gov = resolveAgentFromParams(projects, { id: params.from ?? params.governor ?? params.governorId ?? params.id });
			const message = typeof params.message === 'string' ? params.message.trim() : '';
			if (!message) {
				throw new Error('Inbox message text is required.');
			}
			const rawNode = params.node ?? params.nodeId;
			const resolvedRank = resolveAdeAgentRank(gov, projects.hasSubordinates(gov.id), roleConfig);
			const senderRank = resolvedRank === 'subordinate' ? 'employee' : resolvedRank;
			return inboxService.postGovernorMessage({
				governorSessionId: gov.id,
				message,
				title: typeof params.title === 'string' ? params.title : undefined,
				nodeId: typeof rawNode === 'string' ? rawNode : undefined,
				senderRank,
				senderAgentId: gov.id,
			});
		}

		case 'inbox.resolve': {
			if (!inboxService) {
				throw new Error('ADE Inbox service is not available.');
			}
			const id = typeof params.id === 'string' ? params.id.trim() : '';
			if (!id) {
				throw new Error('Inbox message ID (--id) is required.');
			}
			const resolved = await inboxService.resolveItem(id, typeof params.resolution === 'string' ? params.resolution : undefined);
			if (!resolved) {
				throw new Error(`Inbox item not found: ${id}`);
			}
			return resolved;
		}

		case 'inbox.markRead': {
			if (!inboxService) {
				throw new Error('ADE Inbox service is not available.');
			}
			if (params.all === true) {
				await inboxService.markRead();
				return { unreadCount: inboxService.unreadCount };
			}
			const id = typeof params.id === 'string' ? params.id.trim() : '';
			await inboxService.markRead(id || undefined);
			return { unreadCount: inboxService.unreadCount };
		}

		case 'host.list': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			return cloudHosts.listHosts();
		}

		case 'host.get': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.id ?? params.alias ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host ID or alias is required.');
			}
			const found = await cloudHosts.getHost(rawTarget);
			if (!found) {
				throw new Error(`Cloud Host not found: ${rawTarget}`);
			}
			return found;
		}

		case 'host.upsert': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const lookupKey = String(params.id ?? params.alias ?? params.target ?? '').trim();
			const existing = lookupKey ? await cloudHosts.getHost(lookupKey) : undefined;
			const hostName = String(params.hostName ?? params.host ?? existing?.hostName ?? '').trim();
			if (!hostName) {
				throw new Error('Cloud Host address (--host) is required.');
			}
			const rawOs = typeof params.os === 'string' ? params.os.trim().toLowerCase() : undefined;
			const osKind: AdeCloudHostOs | undefined = rawOs === 'windows' || rawOs === 'macos' || rawOs === 'linux' ? rawOs : existing?.os;
			const rawStrict = typeof params.strictHostKeyChecking === 'string' ? params.strictHostKeyChecking.trim() : undefined;
			const strictCheck = rawStrict === 'yes' || rawStrict === 'accept-new' || rawStrict === 'no' ? rawStrict : existing?.strictHostKeyChecking;
			return cloudHosts.upsertHost({
				id: typeof params.id === 'string' && params.id.trim() ? params.id.trim() : existing?.id,
				name: (typeof params.name === 'string' && params.name.trim() ? params.name.trim() : existing?.name) ?? hostName,
				alias: typeof params.alias === 'string' && params.alias.trim() ? params.alias.trim() : existing?.alias,
				hostName,
				user: typeof params.user === 'string' ? (params.user.trim() || undefined) : existing?.user,
				port: typeof params.port === 'number' ? params.port : (typeof params.port === 'string' && /^\d+$/.test(params.port) ? Number(params.port) : existing?.port),
				os: osKind,
				identityFile: typeof params.identityFile === 'string' ? params.identityFile : existing?.identityFile,
				proxyJump: typeof params.proxyJump === 'string' ? params.proxyJump : existing?.proxyJump,
				strictHostKeyChecking: strictCheck,
				defaultDirectory: typeof params.defaultDirectory === 'string' ? params.defaultDirectory : existing?.defaultDirectory,
				notes: typeof params.notes === 'string' ? params.notes : existing?.notes,
			});
		}

		case 'host.delete': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.id ?? params.alias ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host ID or alias is required.');
			}
			const ok = await cloudHosts.deleteHost(rawTarget);
			if (!ok) {
				throw new Error(`Cloud Host not found: ${rawTarget}`);
			}
			return { deleted: rawTarget };
		}

		case 'host.test': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.id ?? params.alias ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host ID or alias is required.');
			}
			return cloudHosts.testConnection(rawTarget);
		}

		case 'host.browse': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			const rawTarget = String(params.target ?? params.host ?? params.alias ?? '').trim();
			if (!rawTarget) {
				throw new Error('Cloud Host alias is required.');
			}
			const matched = await cloudHosts.getHost(rawTarget);
			const authority = matched?.alias ?? rawTarget;
			const remotePath = typeof params.path === 'string' && params.path.trim()
				? params.path.trim()
				: (matched?.defaultDirectory || matched?.recentDirectories[0] || '/');
			const entries = await cloudHosts.remoteReadDir(authority, remotePath);
			return { host: authority, path: remotePath, entries };
		}

		case 'host.import': {
			if (!cloudHosts) {
				throw new Error('Cloud Host backend service is not available.');
			}
			return cloudHosts.importFromVsCodeAndSshConfig();
		}

		case 'host.open': {
			const target = typeof params.target === 'string' && params.target.trim() ? params.target.trim() : undefined;
			await editors.openCloudHosts?.(target);
			return { opened: true, ...(target ? { target } : {}) };
		}

		case 'role.schema.get':
			return roleConfig;

		case 'role.apis':
			return ADE_PRIMITIVE_APIS.map(api => ({
				id: api.id,
				category: api.category,
				label: api.label,
				description: api.description,
				actions: api.actions,
				dangerous: Boolean(api.dangerous),
			}));

		case 'role.presets':
			return ADE_ORGANIZATION_PRESETS.map(preset => ({
				id: preset.id,
				name: preset.name,
				description: preset.description,
				ranks: preset.config.ranks.map(r => ({ id: r.id, name: r.name, tier: r.tier, pureExecution: Boolean(r.pureExecution) })),
			}));

		case 'role.schema.set': {
			if (!roleSchemaService) {
				throw new Error('ADE Role Schema service is not available.');
			}
			if (typeof params.presetId === 'string' && params.presetId.trim()) {
				return roleSchemaService.applyPreset(params.presetId.trim());
			}
			const rawConfig = params.config ?? params.schema;
			if (!rawConfig || typeof rawConfig !== 'object') {
				throw new Error('Expected config object or presetId for role.schema.set.');
			}
			return roleSchemaService.updateConfig(normalizeAdeOrganizationConfig(rawConfig));
		}

		case 'role.schema.reset': {
			if (!roleSchemaService) {
				throw new Error('ADE Role Schema service is not available.');
			}
			return roleSchemaService.resetToDefault();
		}

		case 'role.studio.open': {
			const rankId = typeof params.rankId === 'string' && params.rankId.trim() ? params.rankId.trim() : undefined;
			await editors.openRoleStudio?.(rankId);
			return { opened: true, ...(rankId ? { rankId } : {}) };
		}

		default:
			throw new Error(localize('adeUnknownControlAction', "Unknown ADE control action: {0}", String(action)));
	}
}

CommandsRegistry.registerCommand('aexus.ade.getCloudHostSshContext', async (accessor: ServicesAccessor, rawAlias?: unknown) => {
	const cloudHosts = tryGetService(accessor, IAdeCloudHostBackendService);
	if (!cloudHosts) {
		return undefined;
	}
	const alias = typeof rawAlias === 'string' ? rawAlias.trim() : '';
	const [effectiveSshConfigPath, matched] = await Promise.all([
		cloudHosts.getEffectiveSshConfigPath().catch(() => undefined),
		alias ? cloudHosts.getHost(alias).catch(() => undefined) : Promise.resolve(undefined),
	]);
	return {
		effectiveSshConfigPath,
		os: matched?.os ?? 'linux',
	};
});

CommandsRegistry.registerCommand(ADE_RESOLVE_PROMPT_CONTEXT_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown) => {
	return resolveAdePromptContext(accessor, rawResource);
});

CommandsRegistry.registerCommand(ADE_GET_ROLE_SYNC_SNAPSHOT_COMMAND_ID, (accessor: ServicesAccessor, explicitActiveAgentId?: unknown) => {
	const modes = accessor.get(IWorkbenchModeService);
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const sessions = tryGetService(accessor, IAdeSessionsService);
	const roleConfig = tryGetService(accessor, IAdeRoleSchemaService)?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	const activeId = typeof explicitActiveAgentId === 'string' && explicitActiveAgentId.trim() ? explicitActiveAgentId.trim() : undefined;
	return buildAdeRoleSyncSnapshot(modes, projects, editors, sessions, activeId, roleConfig);
});

CommandsRegistry.registerCommand(ADE_CONTROL_EXECUTE_COMMAND_ID, (accessor: ServicesAccessor, arg1: IAdeControlDispatchRequest | string, arg2?: Record<string, unknown>) => {
	return executeAdeControlRequest(accessor, arg1, arg2);
});

CommandsRegistry.registerCommand(ADE_SYNC_SESSION_PREFERENCES_COMMAND_ID, (accessor: ServicesAccessor, rawPayload: unknown) => {
	if (!rawPayload || typeof rawPayload !== 'object') {
		return;
	}
	const payload = rawPayload as {
		resource?: unknown;
		engineId?: unknown;
		model?: unknown;
		thinking?: unknown;
	};
	const sessionResource = toUri(payload.resource);
	if (!sessionResource) {
		return;
	}
	const projects = accessor.get(IAdeProjectsService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const secretaryResource = projects.secretary.session?.resource;
	if (sessionResource.scheme === 'aexus-secretary' || (secretaryResource && (uriIdentity.extUri.isEqual(sessionResource, secretaryResource) || sessionResource.toString() === secretaryResource.toString()))) {
		if (typeof payload.engineId === 'string' && payload.engineId.trim()) {
			projects.configureSecretary({ engineId: payload.engineId.trim(), resource: secretaryResource ?? sessionResource });
		}
		return;
	}
	const agent = projects.agents.find(entry => entry.session && (
		uriIdentity.extUri.isEqual(entry.session.resource, sessionResource)
		|| entry.session.resource.toString() === sessionResource.toString()
	));
	if (!agent) {
		return;
	}
	const prefs: { preferredModel?: string; preferredThinking?: AdeThinkingLevel } = {};
	if (Object.hasOwn(payload, 'model')) {
		prefs.preferredModel = typeof payload.model === 'string' && payload.model.trim() && payload.model !== 'default'
			? payload.model.trim()
			: undefined;
	}
	if (Object.hasOwn(payload, 'thinking')) {
		const rawThinking = typeof payload.thinking === 'string' ? payload.thinking.trim() : '';
		const mapped: AdeThinkingLevel | undefined = rawThinking === 'off' || rawThinking === 'none'
			? 'off'
			: rawThinking === 'low' || rawThinking === 'minimal'
				? 'low'
				: rawThinking === 'medium'
					? 'medium'
					: rawThinking === 'max'
						? 'max'
						: rawThinking === 'high' || rawThinking === 'xhigh' || rawThinking === 'extra-high'
							? 'high'
							: undefined;
		prefs.preferredThinking = mapped;
	}
	if (projects.updateAgentEnginePreferences) {
		projects.updateAgentEnginePreferences(agent.id, prefs);
	}
});

const initializingSessionsByResource = new Map<string, string>();
const observedWidgetsForInit = new WeakSet<object>();

function bindWidgetInitializingObserver(chatWidgetService: IChatWidgetService): void {
	if (observedWidgetsForInit.has(chatWidgetService)) {
		return;
	}
	observedWidgetsForInit.add(chatWidgetService);
	const attachWidget = (widget: { readonly viewModel?: { readonly sessionResource: URI }; readonly onDidChangeViewModel: (cb: () => void) => unknown; setSessionInitializingState?: (msg: string | undefined) => void }) => {
		if (observedWidgetsForInit.has(widget)) {
			return;
		}
		observedWidgetsForInit.add(widget);
		const sync = () => {
			const res = widget.viewModel?.sessionResource;
			const msg = res ? initializingSessionsByResource.get(res.toString()) : undefined;
			widget.setSessionInitializingState?.(msg);
		};
		widget.onDidChangeViewModel(() => sync());
		sync();
	};
	for (const w of chatWidgetService.getAllWidgets()) {
		attachWidget(w);
	}
	chatWidgetService.onDidAddWidget(w => attachWidget(w));
}

CommandsRegistry.registerCommand(ADE_SET_SESSION_INITIALIZING_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown, rawMessage: unknown) => {
	const sessionResource = toUri(rawResource);
	if (!sessionResource) {
		return;
	}
	const message = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.trim() : undefined;
	const key = sessionResource.toString();
	if (message) {
		initializingSessionsByResource.set(key, message);
	} else {
		initializingSessionsByResource.delete(key);
	}
	const chatWidgetService = tryGetService(accessor, IChatWidgetService);
	if (chatWidgetService) {
		bindWidgetInitializingObserver(chatWidgetService);
		const widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
		widget?.setSessionInitializingState?.(message);
	}
});

CommandsRegistry.registerCommand(ADE_SET_SESSION_GOAL_BANNER_COMMAND_ID, (accessor: ServicesAccessor, rawResource: unknown, rawGoalText: unknown) => {
	const sessionResource = toUri(rawResource);
	if (!sessionResource) {
		return;
	}
	const chatWidgetService = tryGetService(accessor, IChatWidgetService);
	const commandService = tryGetService(accessor, ICommandService);
	const widget = chatWidgetService?.getWidgetBySessionResource(sessionResource);
	const goalText = typeof rawGoalText === 'string' && rawGoalText.trim() ? rawGoalText.trim() : undefined;
	if (widget?.setPinnedGoalBanner) {
		widget.setPinnedGoalBanner(goalText, () => {
			void commandService?.executeCommand('aexus.agentEngines.clearSessionGoal', sessionResource).catch(() => undefined);
		});
	}
});
