/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath, relativePath, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	AEXUS_SSH_SCHEME,
	buildCloudProjectUri,
	formatProjectDisplayPath,
	IAdeCloudHostBackendService,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	AdeAgentRole,
	AdeSessionRank,
	IAdeSessionTreeNode,
	IAdeSessionTreeResult,
} from '../../../../platform/ade/common/adeControl.js';
import { buildSecretarySendEnvelope } from '../../../../platform/ade/common/adeControlPolicy.js';
import { AdeThinkingLevel, IAdeEngineeringBackendService } from '../../../../platform/ade/common/adeEngineering.js';
import {
	sanitizeAdeSystemEnvelopeHeaders,
	wrapRoleDirectMessageEnvelope,
	wrapUserDirectMessageEnvelope,
} from '../../../../platform/ade/common/adeMessageEnvelope.js';
import { ADE_SECRETARY_TIER_TAG, findRankByTierOrId, formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import {
	canRankSupervise,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	findRankDefinition,
	getDefaultPureLeafRank,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	isPureExecutionRank,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../platform/files/common/files.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IView } from '../../../common/views.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ISCMService } from '../../scm/common/scm.js';
import {
	ADE_PROJECTS_VIEW_ID,
	ADE_SECRETARY_ID,
	getNextLowerAdeRole,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { findProjectScmRepository, openScmResourceInAde } from './adeInspectorViews.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionRecord, IAdeMissionService } from './adeMissionStore.js';
import { reconcileIdeWorkspaceWithCatalog } from './adeProjectManagement.js';
import {
	buildControlStatus,
	buildProjectSummaries,
	findMatchingProject,
	resolveInGraphMissionBinding,
	toSessionSummary,
	toUri,
} from './adeRolePromptResolver.js';
import { AdeExtensionWebviewEditorInput, AdeSessionEditorInput } from './adeSessionEditor.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export const ADE_SESSION_AND_PROJECT_ACTIONS = new Set([
	'project.list',
	'project.select',
	'project.add',
	'project.remove',
	'project.delete',
	'project.focus',
	'project.home',
	'project.forward',
	'project.move',
	'project.changes',
	'project.files',
	'project.openFile',
	'project.openDiff',
	'engine.list',
	'engine.sessions',
	'session.list',
	'session.info',
	'session.get',
	'session.subordinates',
	'session.children',
	'session.tree',
	'session.subtree',
	'session.create',
	'session.attach',
	'session.connect',
	'session.open',
	'session.select',
	'session.close',
	'session.markRead',
	'session.draft',
	'session.reorder',
	'session.rename',
	'session.configure',
	'session.prefs',
	'session.setRole',
	'session.role',
	'session.reparent',
	'session.nest',
	'session.move',
	'session.send',
	'session.history',
	'session.stop',
	'session.archive',
	'session.remove',
	'session.detach',
	'session.delete',
	'secretary.status',
	'secretary.open',
	'secretary.configure',
	'secretary.engine',
	'secretary.setEngine',
	'secretary.reset',
	'secretary.send',
	'secretary.history',
	'secretary.stop',
	'secretary.draft',
	'secretary.markRead',
]);

export interface IAdeSessionControlActionContext {
	readonly modes: IWorkbenchModeService;
	readonly projects: IAdeProjectsService;
	readonly navigation: IProjectNavigationService;
	readonly editors: IAdeEditorService;
	readonly editorService: IEditorService | undefined;
	readonly sessions: IAdeSessionsService;
	readonly uriIdentity: IUriIdentityService;
	readonly commandService: ICommandService;
	readonly workspaceEditing: IWorkspaceEditingService | undefined;
	readonly contextService: IWorkspaceContextService | undefined;
	readonly environmentService: IWorkbenchEnvironmentService | undefined;
	readonly fileService: IFileService | undefined;
	readonly configurationService: IConfigurationService | undefined;
	readonly pathService: IPathService | undefined;
	readonly chatService: IChatService | undefined;
	readonly scmService: ISCMService | undefined;
	readonly viewsService: IViewsService | undefined;
	readonly missionService: IAdeMissionService | undefined;
	readonly missionRuntime: IAdeMissionRuntimeService | undefined;
	readonly engineeringBackend: IAdeEngineeringBackendService | undefined;
	readonly cloudHosts: IAdeCloudHostBackendService | undefined;
	readonly roleConfig: IAdeOrganizationConfig;
	readonly isHumanUser: boolean;
	readonly isSecretaryCaller: boolean;
	readonly isHumanOrSecretary: boolean;
	readonly rawCallerStr: string;
	readonly rawCallerSessionId: string | undefined;
	readonly callerAgent: IAdeAgent | undefined;
	readonly topRankDef: IAdeRankDefinition;
	readonly effectiveCallerDef: IAdeRankDefinition | undefined;
	readonly assertCanOperateMission: (mission: IAdeMissionRecord) => void;
	readonly assertCanSuperviseRank: (targetRankId: string, targetHasSubs: boolean, actionLabel: string) => void;
	readonly assertTargetInCallerSubtree: (target: IAdeAgent, actionLabel: string, allowSelf?: boolean) => void;
	readonly assertCanManageTarget: (target: IAdeAgent, actionLabel: string) => void;
	readonly assertCanDestroyTreeIfPresent: (target: IAdeAgent) => void;
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
	const configured = findRankByTierOrId(config, str) ?? findRankDefinition(config, str);
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
	const configured = findRankByTierOrId(config, lower) ?? findRankDefinition(config, lower);
	if (configured) {
		return configured.id;
	}
	if (lower === 'governor' || lower === 'manager' || lower === 'employee' || lower === 'subordinate') {
		return lower;
	}
	throw new Error(localize('adeInvalidRole', "Invalid ADE agent role: {0}", String(raw)));
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

export function resolveAgentFromParams(projects: IAdeProjectsService, params: Record<string, unknown> | undefined): IAdeAgent {
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

async function resolveEngineId(sessions: IAdeSessionsService, rawEngine: unknown, projectUri?: URI): Promise<string | undefined> {
	const available = await sessions.getEngines(projectUri);
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

export async function executeAdeSessionOrProjectControlAction(
	action: string,
	params: Record<string, unknown>,
	ctx: IAdeSessionControlActionContext,
): Promise<unknown> {
	const {
		modes,
		projects,
		navigation,
		editors,
		editorService,
		sessions,
		uriIdentity,
		commandService,
		workspaceEditing,
		contextService,
		environmentService,
		fileService,
		configurationService,
		pathService,
		chatService,
		scmService,
		viewsService,
		missionService,
		missionRuntime,
		engineeringBackend,
		cloudHosts,
		roleConfig,
		isHumanUser,
		isSecretaryCaller,
		isHumanOrSecretary,
		rawCallerStr,
		rawCallerSessionId,
		callerAgent,
		topRankDef,
		effectiveCallerDef,
		assertCanOperateMission,
		assertCanSuperviseRank,
		assertTargetInCallerSubtree,
		assertCanManageTarget,
		assertCanDestroyTreeIfPresent,
	} = ctx;

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
			const parsedUris = rawList.map(entry => toUri(entry)).filter((uri): uri is URI => Boolean(uri)).map(uri => removeTrailingPathSeparator(uri));
			const uris: URI[] = [];
			for (let uri of parsedUris) {
				if (uri.scheme === AEXUS_SSH_SCHEME && cloudHosts && (uri.path === '/~' || uri.path === '~' || uri.path.startsWith('/~/') || uri.path.startsWith('~/'))) {
					const host = await cloudHosts.getHost(uri.authority).catch(() => undefined);
					const remoteHome = host?.lastTestStatus?.remoteHome?.trim();
					if (remoteHome) {
						const normHome = remoteHome.replace(/\\/g, '/').replace(/\/+$/, '');
						const prefix = normHome.startsWith('/') ? normHome : `/${normHome}`;
						const tail = uri.path.replace(/^\/?~\/?/, '');
						uri = removeTrailingPathSeparator(uri.with({ path: tail ? `${prefix}/${tail}` : prefix }));
					}
				}
				uris.push(uri);
			}
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
			if (missionService) {
				for (const m of missionService.listMissions()) {
					const matchesProject = m.projectUri ? uriIdentity.extUri.isEqual(URI.parse(m.projectUri), targetUri) : false;
					const ownedByProjectAgent = Boolean(m.ownerSessionId && projectAgents.some(a => a.id === m.ownerSessionId));
					if (matchesProject || ownedByProjectAgent) {
						await missionService.removeMissionWithEmployees(m.id);
					}
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
			if (missionService) {
				for (const m of missionService.listMissions()) {
					const matchesProject = m.projectUri ? uriIdentity.extUri.isEqual(URI.parse(m.projectUri), targetUri) : false;
					const ownedByProjectAgent = Boolean(m.ownerSessionId && projectAgents.some(a => a.id === m.ownerSessionId));
					if (matchesProject || ownedByProjectAgent) {
						await missionService.removeMissionWithEmployees(m.id, { deleteEngineHistory: deleteSessions });
					}
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
			if (projectUri.scheme === AEXUS_SSH_SCHEME && cloudHosts) {
				const entries = await cloudHosts.remoteGitStatus(projectUri.authority, projectUri.path || '/').catch(() => []);
				const stagedResources = entries.filter(e => e.staged).map(e => ({
					path: formatProjectDisplayPath(joinPath(projectUri, e.relativePath)),
					relativePath: e.relativePath,
					status: e.status,
					deleted: e.status === 'D',
				}));
				const workingResources = entries.filter(e => !e.staged).map(e => ({
					path: formatProjectDisplayPath(joinPath(projectUri, e.relativePath)),
					relativePath: e.relativePath,
					status: e.status,
					deleted: e.status === 'D',
				}));
				const groups = [
					...(stagedResources.length > 0 ? [{ id: 'index', label: 'Staged Changes', count: stagedResources.length, resources: stagedResources }] : []),
					...(workingResources.length > 0 ? [{ id: 'workingTree', label: 'Changes', count: workingResources.length, resources: workingResources }] : []),
				];
				return {
					project: projects.getProjectName(projectUri),
					projectPath: formatProjectDisplayPath(projectUri),
					repositoryRoot: formatProjectDisplayPath(projectUri),
					totalChanges: entries.length,
					groups,
				};
			}
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
			const openSide = Boolean(params.side);
			modes.setMode('ade');
			if (openSide && editorService) {
				projects.selectProject(projectUri);
				await editorService.openEditor({ resource: fileUri, options: { pinned: true } }, SIDE_GROUP);
			} else {
				await editors.openFile(fileUri, projectUri);
			}
			return {
				opened: formatProjectDisplayPath(fileUri),
				project: projects.getProjectName(projectUri),
				projectPath: formatProjectDisplayPath(projectUri),
				...(openSide ? { side: true } : {}),
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
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri ?? params.target;
			const projectUri = rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined;
			const forceRefresh = params.forceRefresh === true || params.refresh === true;
			const engines = await sessions.getEngines(projectUri, forceRefresh ? { forceRefresh: true } : undefined);
			return engines.map(engine => ({
				id: engine.id,
				shortId: engine.id.startsWith('aexus-') ? engine.id.slice('aexus-'.length) : engine.id,
				name: engine.name,
				description: engine.description,
				available: true,
				...(engine.remoteHost ? { remoteHost: engine.remoteHost } : {}),
				...(engine.remoteOs ? { remoteOs: engine.remoteOs } : {}),
			}));
		}

		case 'engine.sessions': {
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.target;
			const projectUri = rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined;
			const rawEngine = params.engineId ?? params.engine;
			const engineId = await resolveEngineId(sessions, rawEngine, projectUri);
			if (!engineId) {
				throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
			}
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
			const callerVisibleIds = !isHumanOrSecretary && callerAgent
				? new Set<string>(projects.getSubtree(callerAgent.id).map(a => a.id))
				: undefined;
			return projects.agents
				.filter(agent => {
					if (callerVisibleIds && !callerVisibleIds.has(agent.id)) {
						return false;
					}
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
			assertTargetInCallerSubtree(agent, action, true);
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
			assertTargetInCallerSubtree(agent, action, true);
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
			assertTargetInCallerSubtree(agent, action, true);
			return buildSessionTreeResult(projects, sessions, agent, roleConfig);
		}

		case 'session.create': {
			const rawParentId = params.parentId ?? params.parent;
			const parent = typeof rawParentId === 'string' && rawParentId.trim()
				? resolveAgentFromParams(projects, { id: rawParentId })
				: undefined;
			if (!isHumanOrSecretary) {
				if (!parent) {
					if (callerAgent || effectiveCallerDef!.tier > topRankDef.tier) {
						throw new Error(localize('adeSessionCreateRequiresParent', "Permission denied: orchestrated sessions must specify '--parent' within their own subordinate subtree."));
					}
				} else {
					assertTargetInCallerSubtree(parent, 'session.create', true);
					if (callerAgent && parent.id !== callerAgent.id) {
						assertCanManageTarget(parent, 'spawn a subordinate under');
					} else if (!callerAgent) {
						const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parent.role, projects.hasSubordinates(parent.id));
						if (parentRankDef.tier < effectiveCallerDef!.tier) {
							throw new Error(localize('adeSessionCreateParentHigherRank', "Permission denied: cannot spawn a session under a higher-tier supervisor ('{0}').", parentRankDef.name));
						}
					}
				}
			}
			if (parent && projects.isLockedByWorkTree?.(parent.id)) {
				throw new Error(localize('adeLockedByMissionCreate', "Session '{0}' is locked by a Mission. Native 'aexus-ade session create|attach' manages regular ADE employee sessions outside Engineering; to add a new employee node inside this Engineering canvas, use 'aexus-ade orchestration staff create --mission <id> ...' (or edit the Orchestration canvas).", parent.label));
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

			let role: AdeAgentRole | undefined;
			const topRankId = topRankDef.id;
			let promoteUnrankedRootParent = false;
			if (parent) {
				const parentHasSubs = projects.hasSubordinates(parent.id);
				const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parent.role, parentHasSubs);
				if (parent.parentId && (parentRankDef.pureExecution || !parentRankDef.canHaveSubordinates) && !parentHasSubs) {
					throw new Error(localize('adeWorkerCannotSpawnSubordinates', "Rank '{0}' cannot have subordinate sessions. Promote its role first.", parentRankDef.name));
				}
				if (params.role !== undefined) {
					role = parseRole(params.role, roleConfig);
					if (!parent.parentId && !parent.role) {
						promoteUnrankedRootParent = true;
					}
				} else if (!parent.parentId && !parent.role && !parentHasSubs) {
					promoteUnrankedRootParent = true;
					role = getNextLowerAdeRole(topRankId, true, roleConfig).childRole;
				} else {
					role = getNextLowerAdeRole(parent.role, parentHasSubs, roleConfig).childRole;
				}
			} else {
				role = parseRole(params.role, roleConfig);
			}

			if (!isHumanOrSecretary) {
				const createdRankDef = resolveEffectiveRankDefinition(roleConfig, role, false);
				assertCanSuperviseRank(createdRankDef.id, false, 'create');
				if (parent) {
					const parentHasSubs = projects.hasSubordinates(parent.id);
					const effectiveParentRole = promoteUnrankedRootParent ? topRankId : parent.role;
					if (!canRankSupervise(roleConfig, effectiveParentRole, parentHasSubs || promoteUnrankedRootParent, createdRankDef.id, false)) {
						throw new Error(localize(
							'adeParentCannotSuperviseChild',
							"Permission denied: parent '{0}' cannot supervise a new '{1}' session.",
							parent.label,
							createdRankDef.name,
						));
					}
				}
			}

			const projectUri = removeTrailingPathSeparator(resolvedProjectUri);
			projects.registerProject(projectUri, basename(projectUri));
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			if (parent && promoteUnrankedRootParent) {
				projects.setAgentRole(parent.id, topRankId);
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
				const engineId = await resolveEngineId(sessions, rawEngine, projectUri);
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
			const rawModel = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : undefined;
			const rawThinkingCreate = typeof params.thinking === 'string' && params.thinking.trim() ? params.thinking.trim().toLowerCase() : undefined;
			const mappedCreateThinking: AdeThinkingLevel | undefined = rawThinkingCreate === 'off' || rawThinkingCreate === 'none'
				? 'off'
				: rawThinkingCreate === 'low' || rawThinkingCreate === 'minimal'
					? 'low'
					: rawThinkingCreate === 'medium'
						? 'medium'
						: rawThinkingCreate === 'high'
							? 'high'
							: rawThinkingCreate === 'max' || rawThinkingCreate === 'xhigh' || rawThinkingCreate === 'extra-high'
								? 'max'
								: undefined;
			if ((rawModel || mappedCreateThinking) && projects.updateAgentEnginePreferences) {
				projects.updateAgentEnginePreferences(createdAgent.id, {
					...(rawModel ? { preferredModel: rawModel } : {}),
					...(mappedCreateThinking ? { preferredThinking: mappedCreateThinking } : {}),
				});
			}

			if (params.open !== false) {
				modes.setMode('ade');
				await editors.openAgent(createdAgent.id, { side: Boolean(params.side) });
			}
			return toSessionSummary(projects, sessions, projects.getAgent(createdAgent.id)!, roleConfig);
		}

		case 'session.attach': {
			const rawEngine = params.engineId ?? params.engine;
			const rawNativeId = params.nativeId ?? params.nativeSessionId ?? params.conversationId;
			if (typeof rawNativeId !== 'string' || !rawNativeId.trim()) {
				throw new Error(localize('adeMissingNativeId', "Native conversation ID is required for session attach."));
			}
			const nativeId = rawNativeId.trim();
			const rawParentId = params.parentId ?? params.parent;
			const parent = typeof rawParentId === 'string' && rawParentId.trim()
				? resolveAgentFromParams(projects, { id: rawParentId })
				: undefined;
			if (!isHumanOrSecretary) {
				if (!parent) {
					if (callerAgent || effectiveCallerDef!.tier > topRankDef.tier) {
						throw new Error(localize('adeSessionAttachRequiresParent', "Permission denied: orchestrated sessions must specify '--parent' within their own subordinate subtree when attaching."));
					}
				} else {
					assertTargetInCallerSubtree(parent, 'session.attach', true);
					if (callerAgent && parent.id !== callerAgent.id) {
						assertCanManageTarget(parent, 'attach a subordinate under');
					}
				}
			}
			if (parent && projects.isLockedByWorkTree?.(parent.id)) {
				throw new Error(localize('adeLockedByMissionCreate', "Session '{0}' is locked by a Mission. Native 'aexus-ade session create|attach' manages regular ADE employee sessions outside Engineering; to add a new employee node inside this Engineering canvas, use 'aexus-ade orchestration staff create --mission <id> ...' (or edit the Orchestration canvas).", parent.label));
			}
			const rawProject = params.project ?? params.projectPath ?? params.path ?? params.uri;
			const fallbackProjectUri = parent?.projectUri
				?? (rawProject ? (findMatchingProject(projects, uriIdentity, rawProject)?.uri ?? toUri(rawProject)) : undefined)
				?? navigation.focusedProject?.uri
				?? projects.selectedProject?.uri
				?? navigation.selectedProject?.uri
				?? projects.projects[0]?.uri;
			const engineId = await resolveEngineId(sessions, rawEngine, fallbackProjectUri);
			if (!engineId) {
				throw new Error(localize('adeNoEngineAvailable', "No Coding Agent engines are available."));
			}

			const attached = sessions.attach
				? await sessions.attach(engineId, nativeId, fallbackProjectUri)
				: (await sessions.list(engineId, fallbackProjectUri)).find(item => item.resource.path.endsWith(`/${nativeId}`) || item.resource.toString().includes(nativeId));
			if (!attached) {
				throw new Error(localize('adeAttachNotFound', "Could not find native conversation '{0}' in engine '{1}'.", nativeId, engineId));
			}

			let role: AdeAgentRole | undefined;
			const topRankId = topRankDef.id;
			let promoteUnrankedRootParent = false;
			if (parent) {
				const parentHasSubs = projects.hasSubordinates(parent.id);
				const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parent.role, parentHasSubs);
				if (parent.parentId && (parentRankDef.pureExecution || !parentRankDef.canHaveSubordinates) && !parentHasSubs) {
					throw new Error(localize('adeWorkerCannotSpawnSubordinates', "Rank '{0}' cannot have subordinate sessions. Promote its role first.", parentRankDef.name));
				}
				if (params.role !== undefined) {
					role = parseRole(params.role, roleConfig);
					if (!parent.parentId && !parent.role) {
						promoteUnrankedRootParent = true;
					}
				} else if (!parent.parentId && !parent.role && !parentHasSubs) {
					promoteUnrankedRootParent = true;
					role = getNextLowerAdeRole(topRankId, true, roleConfig).childRole;
				} else {
					role = getNextLowerAdeRole(parent.role, parentHasSubs, roleConfig).childRole;
				}
			} else {
				role = parseRole(params.role, roleConfig);
			}
			if (!isHumanOrSecretary) {
				const createdRankDef = resolveEffectiveRankDefinition(roleConfig, role, false);
				assertCanSuperviseRank(createdRankDef.id, false, 'attach');
				if (parent) {
					const parentEffective = resolveEffectiveRankDefinition(roleConfig, promoteUnrankedRootParent ? topRankId : parent.role, true);
					if (!canRankSupervise(roleConfig, parentEffective.id, true, createdRankDef.id, false)) {
						throw new Error(localize(
							'adeParentCannotSuperviseAttached',
							"Permission denied: parent rank '{0}' cannot supervise attached child rank '{1}'.",
							parentEffective.name,
							createdRankDef.name,
						));
					}
				}
			}
			const projectUri = removeTrailingPathSeparator(parent?.projectUri ?? attached.projectUri);
			projects.registerProject(projectUri, basename(projectUri));
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			if (parent && promoteUnrankedRootParent) {
				projects.setAgentRole(parent.id, topRankId);
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
			assertCanManageTarget(agent, 'connect');
			if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByMissionConnect', "Subordinate session '{0}' is locked by a Mission. Update its engine via the Engineering canvas or 'aexus-ade orchestration staff config --mission <id> --node <nodeId> --engine <e>'.", agent.label));
			}
			const rawEngine = params.engineId ?? params.engine;
			const engineId = await resolveEngineId(sessions, rawEngine, agent.projectUri);
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
			assertTargetInCallerSubtree(agent, 'session.open', true);
			modes.setMode('ade');
			await editors.openAgent(agent.id, { side: Boolean(params.side) });
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.select': {
			const agent = resolveAgentFromParams(projects, params);
			assertTargetInCallerSubtree(agent, 'session.select', true);
			projects.selectAgent(agent.id);
			projects.selectProject(agent.projectUri);
			const view = viewsService?.getActiveViewWithId<IView & { revealAgent?: (id: string) => Promise<void> }>(ADE_PROJECTS_VIEW_ID);
			await view?.revealAgent?.(agent.id);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.close': {
			const agent = resolveAgentFromParams(projects, params);
			assertCanManageTarget(agent, 'close');
			await editors.closeAgents([agent]);
			return { closed: agent.id };
		}

		case 'session.markRead': {
			if (params.all === true) {
				if (!isHumanOrSecretary) {
					throw new Error(localize('adeMarkReadAllForbidden', "Permission denied: only User (L-1) or Secretary (L0) can mark all ADE sessions read."));
				}
				for (const item of projects.agents) {
					projects.markRead(item.id);
				}
				projects.markSecretaryRead();
				return { markedRead: 'all', count: projects.agents.length };
			}
			const agent = resolveAgentFromParams(projects, params);
			assertTargetInCallerSubtree(agent, 'session.markRead', true);
			projects.markRead(agent.id);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.draft': {
			const agent = resolveAgentFromParams(projects, params);
			assertCanManageTarget(agent, 'edit draft of');
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
			assertCanManageTarget(agent, 'reorder');
			const rawTarget = params.target ?? params.before ?? params.after;
			const targetAgent = typeof rawTarget === 'string' && rawTarget.trim()
				? resolveAgentFromParams(projects, { id: rawTarget })
				: undefined;
			if (targetAgent) {
				assertTargetInCallerSubtree(targetAgent, 'session.reorder target', true);
			}
			const after = params.position === 'after' || (params.after !== undefined && params.before === undefined);
			projects.moveProject(agent.id, targetAgent?.id, after);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!);
		}

		case 'session.rename': {
			const agent = resolveAgentFromParams(projects, params);
			assertCanManageTarget(agent, 'rename');
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

		case 'session.configure':
		case 'session.prefs': {
			const agent = resolveAgentFromParams(projects, params);
			assertCanManageTarget(agent, 'configure');
			const prefs: {
				preferredEngineId?: string;
				preferredModel?: string;
				preferredThinking?: AdeThinkingLevel;
			} = {};
			if (typeof (params.engine ?? params.engineId) === 'string' && String(params.engine ?? params.engineId).trim()) {
				const requestedEngineRaw = String(params.engine ?? params.engineId).trim();
				const resolvedEngine = await resolveEngineId(sessions, requestedEngineRaw, agent.projectUri) ?? requestedEngineRaw;
				const currentEngineId = agent.session?.engineId ?? agent.preferredEngineId;
				const activeMissionInfo = missionRuntime?.findMissionForAgent(agent.id);
				const missionLive = activeMissionInfo?.runtime.status === 'running' || activeMissionInfo?.runtime.status === 'paused';
				if ((agent.session || missionLive) && resolvedEngine !== currentEngineId) {
					throw new Error(localize('adeSessionEngineLockedRuntime', "Engine cannot be switched while Mission is running or after session has started; switch model/thinking instead."));
				}
				if (!agent.session && !missionLive) {
					prefs.preferredEngineId = resolvedEngine;
				}
			}
			if (typeof params.model === 'string') {
				const trimmedModel = params.model.trim();
				prefs.preferredModel = trimmedModel && trimmedModel !== 'default' ? trimmedModel : undefined;
			}
			if (typeof params.thinking === 'string') {
				const rawT = params.thinking.trim().toLowerCase();
				prefs.preferredThinking = rawT === 'off' || rawT === 'none'
					? 'off'
					: rawT === 'low' || rawT === 'minimal'
						? 'low'
						: rawT === 'medium'
							? 'medium'
							: rawT === 'high'
								? 'high'
								: rawT === 'max' || rawT === 'xhigh' || rawT === 'extra-high'
									? 'max'
									: undefined;
			}
			if (projects.updateAgentEnginePreferences) {
				projects.updateAgentEnginePreferences(agent.id, prefs);
			}
			if (params.role !== undefined) {
				const activeMissionInfo = missionRuntime?.findMissionForAgent(agent.id);
				const missionLive = activeMissionInfo?.runtime.status === 'running' || activeMissionInfo?.runtime.status === 'paused';
				if (missionLive) {
					throw new Error(localize('adeSessionRoleLockedLive', "Role cannot be changed while Mission is running."));
				}
				const nextRole = parseRole(params.role, roleConfig);
				const agentHasSubs = projects.hasSubordinates(agent.id);
				if (!isHumanOrSecretary) {
					const nextRankDef = resolveEffectiveRankDefinition(roleConfig, nextRole, agentHasSubs);
					assertCanSuperviseRank(nextRankDef.id, agentHasSubs, 'assign role');
				}
				const nextIsPure = !nextRole || isPureExecutionRank(roleConfig, nextRole);
				if (nextIsPure && agentHasSubs) {
					throw new Error(localize('adeCannotClearRoleWithSubordinates', "Cannot clear role while session has subordinate agents."));
				}
				if (activeMissionInfo && !activeMissionInfo.isOrchestrationStaff) {
					const nextTier = resolveEffectiveRankDefinition(roleConfig, nextRole, false).tier;
					if (nextTier <= activeMissionInfo.runtime.boundary.offGraphMaxTier) {
						throw new Error(localize('adeSessionRoleViolatesFactoryWall', "In-graph Mission node role tier (L{0}) must stay strictly below off-graph cutoff (L{1}).", nextTier, activeMissionInfo.runtime.boundary.offGraphMaxTier));
					}
				}
				projects.setAgentRole(agent.id, nextRole, { allowLockedMissionEmployee: Boolean(activeMissionInfo) });
				void engineeringBackend?.revokeSession?.(agent.id).catch(() => undefined);
			}
			const updated = projects.getAgent(agent.id)!;
			return {
				...toSessionSummary(projects, sessions, updated, roleConfig),
				preferredEngineId: updated.preferredEngineId,
				preferredModel: updated.preferredModel,
				preferredThinking: updated.preferredThinking,
			};
		}

		case 'session.setRole':
		case 'session.role': {
			const agent = resolveAgentFromParams(projects, params);
			assertCanManageTarget(agent, 'change role of');
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByMissionRole', "Session '{0}' is locked by a Mission and its role cannot be changed manually.", agent.label));
			}
			const nextRole = parseRole(params.role, roleConfig);
			const agentHasSubs = projects.hasSubordinates(agent.id);
			if (!isHumanOrSecretary) {
				const nextRankDef = resolveEffectiveRankDefinition(roleConfig, nextRole, agentHasSubs);
				assertCanSuperviseRank(nextRankDef.id, agentHasSubs, 'assign role');
			}
			const nextIsPure = !nextRole || isPureExecutionRank(roleConfig, nextRole);
			if (nextIsPure && agentHasSubs) {
				throw new Error(localize('adeCannotClearRoleWithSubordinates', "Cannot clear role while session has subordinate agents."));
			}
			projects.setAgentRole(agent.id, nextRole);
			void engineeringBackend?.revokeSession?.(agent.id).catch(() => undefined);
			return toSessionSummary(projects, sessions, projects.getAgent(agent.id)!, roleConfig);
		}

		case 'session.reparent':
		case 'session.nest':
		case 'session.move': {
			const agent = resolveAgentFromParams(projects, params);
			assertCanManageTarget(agent, 'move');
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByMissionMove', "Session '{0}' belongs to a locked Mission and cannot be reparented manually.", agent.label));
			}
			const rawParent = params.parentId ?? params.parent;
			const clearParent = rawParent === undefined || rawParent === null || rawParent === '' || rawParent === 'none' || rawParent === 'root';
			const parentAgent = clearParent ? undefined : resolveAgentFromParams(projects, { id: rawParent });
			if (!isHumanOrSecretary) {
				if (!parentAgent) {
					throw new Error(localize('adeCannotDetachToRoot', "Permission denied: orchestrated sessions cannot move a subordinate to top-level root."));
				}
				assertTargetInCallerSubtree(parentAgent, 'session.move target supervisor', true);
				if (callerAgent && parentAgent.id !== callerAgent.id) {
					assertCanManageTarget(parentAgent, 'assign as supervisor');
				} else if (!callerAgent) {
					const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parentAgent.role, projects.hasSubordinates(parentAgent.id));
					if (parentRankDef.tier < effectiveCallerDef!.tier) {
						throw new Error(localize('adeMoveTargetHigherRank', "Permission denied: cannot move a session under higher-tier supervisor '{0}'.", parentRankDef.name));
					}
				}
				const targetRankDef = resolveEffectiveRankDefinition(roleConfig, agent.role, projects.hasSubordinates(agent.id));
				const parentRankDef = resolveEffectiveRankDefinition(roleConfig, parentAgent.role, true);
				if (!canRankSupervise(roleConfig, parentRankDef.id, true, targetRankDef.id, projects.hasSubordinates(agent.id))) {
					throw new Error(localize(
						'adeMoveParentCannotSupervise',
						"Permission denied: target supervisor '{0}' cannot supervise rank '{1}'.",
						parentRankDef.name,
						targetRankDef.name,
					));
				}
			}
			if (parentAgent && projects.isLockedByWorkTree?.(parentAgent.id)) {
				throw new Error(localize('adeLockedByMissionTarget', "Target supervisor '{0}' belongs to a locked Mission.", parentAgent.label));
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
			if (!isHumanOrSecretary) {
				if (callerAgent && agent.id === callerAgent.id) {
					throw new Error(localize('adeCannotSendToSelf', "Permission denied: a session cannot send messages to itself."));
				}
				// Strictly top-down messaging only (no upward direct-parent exemption).
				assertCanManageTarget(agent, 'send messages to');
			}
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
			const targetHasSubs = projects.hasSubordinates(agent.id);
			const targetRankDef = resolveEffectiveRankDefinition(roleConfig, agent.role, targetHasSubs);
			const targetInEngineering = Boolean(resolveInGraphMissionBinding(agent, missionRuntime, missionService) || missionRuntime?.findMissionForAgent(agent.id) || agent.treeType);
			const targetIsStandalonePureWorker = Boolean(targetRankDef.pureExecution && !targetHasSubs && !targetInEngineering);
			let envelopedMessage = !isHumanUser ? sanitizeAdeSystemEnvelopeHeaders(rawMessage) : rawMessage;
			if (!targetIsStandalonePureWorker) {
				if (isHumanUser) {
					const interactiveRoot = missionRuntime?.beginInteractiveTurn?.(agent.id, {
						userPrompt: rawMessage,
						isDirectUserChat: true,
					});
					const rootBaton = interactiveRoot?.autoMintedRootToken && interactiveRoot.tokenId
						? { tokenId: interactiveRoot.tokenId, missionId: interactiveRoot.missionId, nodeId: interactiveRoot.nodeId }
						: undefined;
					envelopedMessage = wrapUserDirectMessageEnvelope(rawMessage, 'session.send', {
						usePreambleSentinel: true,
						...(rootBaton ? { rootBaton } : {}),
					});
				} else if (isSecretaryCaller) {
					envelopedMessage = wrapRoleDirectMessageEnvelope({
						senderLabel: projects.secretary.label || 'Secretary',
						senderTierTag: ADE_SECRETARY_TIER_TAG,
						senderRankName: 'Secretary',
						senderSessionId: ADE_SECRETARY_ID,
						channel: 'session.send',
						message: rawMessage,
					});
				} else {
					const callerRankDef = resolveEffectiveRankDefinition(roleConfig, callerAgent?.role ?? rawCallerStr, true);
					envelopedMessage = wrapRoleDirectMessageEnvelope({
						senderLabel: callerAgent?.label ?? rawCallerSessionId ?? callerRankDef.name,
						senderTierTag: formatTierTag(callerRankDef.tier),
						senderRankName: callerRankDef.name,
						senderSessionId: callerAgent?.id ?? rawCallerSessionId,
						channel: 'session.send',
						message: rawMessage,
					});
				}
			}
			const dispatchKind = await sendMessageToSessionResource(chatService, agent.session.resource, envelopedMessage, wait);
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
			assertTargetInCallerSubtree(agent, 'session.history', true);
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
			assertCanManageTarget(agent, 'stop');
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
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByMissionArchive', "Session '{0}' is locked by a Mission and cannot be archived individually. Remove the entire Mission and all its employees together instead.", agent.label));
			}
			const root = projects.getRootAgent(agent.id) ?? agent;
			assertCanManageTarget(agent, 'archive');
			if (root.id !== agent.id) {
				assertCanManageTarget(root, 'archive');
			}
			assertCanDestroyTreeIfPresent(agent);
			if (root.id !== agent.id) {
				assertCanDestroyTreeIfPresent(root);
			}
			const targetArchived = params.restore === true ? false : (typeof params.archived === 'boolean' ? params.archived : true);
			const subtree = projects.getSubtree(root.id);
			projects.setArchived(root.id, targetArchived);
			if (targetArchived) {
				for (const member of subtree) {
					void engineeringBackend?.revokeSession?.(member.id).catch(() => undefined);
				}
				await editors.closeAgents(subtree);
			}
			return toSessionSummary(projects, sessions, projects.getAgent(root.id)!);
		}

		case 'session.remove':
		case 'session.detach': {
			const agent = resolveAgentFromParams(projects, params);
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByMissionDetach', "Session '{0}' is locked by a Mission and cannot be removed with native 'session' commands. Use 'aexus-ade orchestration staff remove --mission <id> --node <nodeId>' to remove a single Engineering canvas node, or remove the entire Mission instead.", agent.label));
			}
			assertCanManageTarget(agent, 'detach');
			assertCanDestroyTreeIfPresent(agent);
			const initialSubtree = projects.getSubtree(agent.id);
			if (missionService) {
				const ownedMissions = new Map<string, IAdeMissionRecord>();
				for (const member of initialSubtree) {
					const m = missionService.getMissionByLinkedSession(member.id);
					if (m) {
						ownedMissions.set(m.id, m);
					}
				}
				for (const m of ownedMissions.values()) {
					assertCanOperateMission(m);
				}
				for (const m of ownedMissions.values()) {
					await missionService.removeMissionWithEmployees(m.id);
				}
			}
			const mergedMap = new Map<string, IAdeAgent>(initialSubtree.map(item => [item.id, item]));
			for (const item of projects.getSubtree(agent.id)) {
				mergedMap.set(item.id, item);
			}
			const subtree = [...mergedMap.values()];
			for (const member of subtree) {
				void engineeringBackend?.revokeSession?.(member.id).catch(() => undefined);
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
			if (projects.isLockedByWorkTree?.(agent.id)) {
				throw new Error(localize('adeLockedByMissionDelete', "Session '{0}' is locked by a Mission and cannot be deleted with native 'session' commands. Use 'aexus-ade orchestration staff remove --mission <id> --node <nodeId>' to remove a single Engineering canvas node, or remove the entire Mission instead.", agent.label));
			}
			assertCanManageTarget(agent, 'delete');
			assertCanDestroyTreeIfPresent(agent);
			const initialSubtree = projects.getSubtree(agent.id);
			if (missionService) {
				const ownedMissions = new Map<string, IAdeMissionRecord>();
				for (const member of initialSubtree) {
					const m = missionService.getMissionByLinkedSession(member.id);
					if (m) {
						ownedMissions.set(m.id, m);
					}
				}
				for (const m of ownedMissions.values()) {
					assertCanOperateMission(m);
				}
				for (const m of ownedMissions.values()) {
					await missionService.removeMissionWithEmployees(m.id, { deleteEngineHistory: true });
				}
			}
			const mergedMap = new Map<string, IAdeAgent>(initialSubtree.map(item => [item.id, item]));
			for (const item of projects.getSubtree(agent.id)) {
				mergedMap.set(item.id, item);
			}
			const subtree = [...mergedMap.values()];
			for (const member of subtree) {
				void engineeringBackend?.revokeSession?.(member.id).catch(() => undefined);
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
			const callerRankDefForSec = !isHumanUser && !isSecretaryCaller
				? resolveEffectiveRankDefinition(roleConfig, callerAgent?.role ?? rawCallerStr, true)
				: undefined;
			const envelopedSecretaryMessage = buildSecretarySendEnvelope({
				rawMessage,
				isHumanUser,
				isSecretaryCaller,
				secretaryLabel: projects.secretary.label || 'Secretary',
				secretaryId: ADE_SECRETARY_ID,
				senderLabel: callerAgent?.label ?? rawCallerSessionId ?? callerRankDefForSec?.name,
				senderTierTag: callerRankDefForSec ? formatTierTag(callerRankDefForSec.tier) : undefined,
				senderRankName: callerRankDefForSec?.name,
				senderSessionId: callerAgent?.id ?? rawCallerSessionId,
			});
			const dispatchKind = await sendMessageToSessionResource(chatService, projects.secretary.session.resource, envelopedSecretaryMessage, wait);
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
