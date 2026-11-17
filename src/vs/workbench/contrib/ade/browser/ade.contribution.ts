/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './ade.css';
import { formatAdeAgentSubtreeLines } from './adeControlHandler.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ActiveEditorContext, FocusedViewContext, WorkspaceFolderCountContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService, WorkbenchModeContext, WorkbenchModeViewContainers } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ChatSessionStatus, IChatSessionsService } from '../../chat/common/chatSessionsService.js';
import { DELETE_ROOT_FOLDER_COMMAND_ID } from '../../files/browser/fileConstants.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import {
	ADE_CHANGES_VIEW_ID,
	ADE_DELETE_PROJECT_COMMAND_ID,
	ADE_FILES_VIEW_ID,
	ADE_INSPECTOR_CONTAINER_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_REMOVE_PROJECT_COMMAND_ID,
	AdeAgentRole,
	AdeSessionRank,
	getAdeRoleRankLevel,
	getNextLowerAdeRole,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { AdeEditorService } from './adeEditorService.js';
import { AdeChangesView, AdeFilesView } from './adeInspectorViews.js';
import { deleteProjectsWithModePrompt, reconcileIdeWorkspaceWithCatalog, removeProjectsSynchronized } from './adeProjectManagement.js';
import { AdeProjectsService } from './adeProjectsService.js';
import { AdeProjectsView } from './adeProjectsView.js';
import {
	AdeExtensionWebviewEditorInput,
	AdeExtensionWebviewEditorPane,
	AdeExtensionWebviewEditorSerializer,
	AdeSessionEditor,
	AdeSessionEditorInput,
	AdeSessionEditorSerializer,
} from './adeSessionEditor.js';
import { AdeSessionsService, IAdeEngine, IAdeEngineSession, IAdeSessionsService } from './adeSessionsService.js';

registerSingleton(IAdeProjectsService, AdeProjectsService, InstantiationType.Delayed);
registerSingleton(IAdeEditorService, AdeEditorService, InstantiationType.Delayed);
registerSingleton(IAdeSessionsService, AdeSessionsService, InstantiationType.Delayed);

class AdeEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeEditor';

	constructor(
		@IAdeEditorService editors: IAdeEditorService,
		@IAdeProjectsService projects: IAdeProjectsService,
		@IChatSessionsService sessions: IChatSessionsService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IUriIdentityService uriIdentity: IUriIdentityService,
		@IFileService fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(sessions.onDidChangeSessionItems(delta => {
			for (const item of delta.addedOrUpdated ?? []) {
				const status = item.status === ChatSessionStatus.InProgress
					? 'working'
					: item.status === ChatSessionStatus.NeedsInput
						? 'pending'
						: 'idle';
				projects.syncSessionItem(item.resource, { label: item.label, status }, editors.isSessionActive(item.resource));
			}
		}));
		if (projects.onDidRemoveAgents) {
			this._register(projects.onDidRemoveAgents(removedAgents => {
				if (removedAgents.length > 0) {
					void editors.closeAgents(removedAgents);
				}
			}));
		}
		const reconcileWorkspace = () => {
			const [workspaceEditing, environmentService] = instantiationService.invokeFunction(accessor => {
				let editing: IWorkspaceEditingService | undefined;
				let env: IWorkbenchEnvironmentService | undefined;
				try {
					editing = accessor.get(IWorkspaceEditingService);
				} catch {
					editing = undefined;
				}
				try {
					env = accessor.get(IWorkbenchEnvironmentService);
				} catch {
					env = undefined;
				}
				return [editing, env] as const;
			});
			void reconcileIdeWorkspaceWithCatalog({
				projects,
				contextService,
				workspaceEditing,
				environmentService,
				fileService,
				uriIdentity,
			});
		};
		projects.ensureCatalogPersisted?.();
		reconcileWorkspace();
		this._register(projects.onDidChange(kind => {
			if (kind !== 'order') {
				reconcileWorkspace();
			}
		}));
	}
}

registerWorkbenchContribution2(AdeEditorContribution.ID, AdeEditorContribution, WorkbenchPhase.AfterRestored);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);

const sidebarContainer = viewContainersRegistry.registerViewContainer({
	id: WorkbenchModeViewContainers.ade,
	title: localize2('adeSessionsContainer', "Sessions"),
	icon: Codicon.commentDiscussion,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [WorkbenchModeViewContainers.ade, { mergeViewWithContainerWhenSingleView: true }]),
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.Sidebar);

const inspectorContainer = viewContainersRegistry.registerViewContainer({
	id: ADE_INSPECTOR_CONTAINER_ID,
	title: localize2('adeInspector', "Project Inspector"),
	icon: Codicon.diff,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ADE_INSPECTOR_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
	hideIfEmpty: true,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar);

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

viewsRegistry.registerViews([{
	id: ADE_PROJECTS_VIEW_ID,
	name: localize2('agentSessionsView', "Sessions"),
	ctorDescriptor: new SyncDescriptor(AdeProjectsView),
	when: WorkbenchModeContext.isEqualTo('ade'),
	canToggleVisibility: false,
	canMoveView: false,
}], sidebarContainer);

viewsRegistry.registerViews([
	{
		id: ADE_CHANGES_VIEW_ID,
		name: localize2('adeChangesView', "Changes"),
		ctorDescriptor: new SyncDescriptor(AdeChangesView),
		when: WorkbenchModeContext.isEqualTo('ade'),
		canToggleVisibility: true,
		canMoveView: false,
		order: 0,
	},
	{
		id: ADE_FILES_VIEW_ID,
		name: localize2('adeFilesView', "Files"),
		ctorDescriptor: new SyncDescriptor(AdeFilesView),
		when: WorkbenchModeContext.isEqualTo('ade'),
		canToggleVisibility: true,
		canMoveView: false,
		order: 1,
	},
], inspectorContainer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeSessionEditor, AdeSessionEditor.ID, localize('agentConversation', "Agent Conversation")),
	[new SyncDescriptor(AdeSessionEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeSessionEditorInput.ID, AdeSessionEditorSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeExtensionWebviewEditorPane, AdeExtensionWebviewEditorPane.ID, localize('agentNativeExtensionEditor', "Agent Native Session")),
	[new SyncDescriptor(AdeExtensionWebviewEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeExtensionWebviewEditorInput.ID, AdeExtensionWebviewEditorSerializer);

const viewTitleMenu = { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: 'navigation' };

async function pickEngine(quickInput: IQuickInputService, sessions: IAdeSessionsService, title: string): Promise<IAdeEngine | undefined> {
	const engines = await sessions.getEngines();
	const picked = await quickInput.pick(engines.map(engine => ({
		label: engine.name,
		description: engine.description,
		engine,
		iconClass: ThemeIcon.isThemeIcon(engine.icon) ? ThemeIcon.asClassName(engine.icon) : undefined,
		iconPath: URI.isUri(engine.icon) ? { dark: engine.icon, light: engine.icon } : undefined,
	})), {
		title,
		placeHolder: engines.length
			? localize('chooseAgentEngine', "Choose a Coding Agent engine")
			: localize('noAgentEngines', "Install a Coding Agent CLI or a session provider to continue"),
	});
	return picked?.engine;
}

async function resolveTargetProjectUri(accessor: ServicesAccessor, explicitUri?: URI, requireLocalFile = false): Promise<URI | undefined> {
	if (URI.isUri(explicitUri)) {
		return removeTrailingPathSeparator(explicitUri);
	}
	const navigation = accessor.get(IProjectNavigationService);
	const projects = accessor.get(IAdeProjectsService);
	const quickInput = accessor.get(IQuickInputService);
	const dialogs = accessor.get(IFileDialogService);

	if (navigation.focusedProject) {
		return navigation.focusedProject.uri;
	}
	const candidates = projects.projects.filter(project => !requireLocalFile || project.uri.scheme === Schemas.file);
	if (candidates.length >= 1) {
		const active = projects.selectedProject;
		const sorted = active
			? [...candidates].sort((a, b) => Number(b.uri.toString() === active.uri.toString()) - Number(a.uri.toString() === active.uri.toString()))
			: candidates;
		const items: (IQuickPickItem & { uri?: URI; browse?: boolean })[] = [
			...sorted.map(project => ({
				label: project.name,
				description: project.uri.fsPath,
				iconClass: ThemeIcon.asClassName(Codicon.folder),
				uri: project.uri,
			})),
			{
				label: localize('adeBrowseProjectFolder', "Browse Folder..."),
				description: localize('adeBrowseProjectFolderDesc', "Select another project folder on disk"),
				iconClass: ThemeIcon.asClassName(Codicon.folderOpened),
				browse: true,
			},
		];
		const chosen = await quickInput.pick(items, {
			title: localize('adeChooseProjectTitle', "Select Project for Session"),
			placeHolder: localize('adeChooseProjectForSession', "Select a project folder for this session"),
			matchOnDescription: true,
		});
		if (!chosen) {
			return undefined;
		}
		if (chosen.uri) {
			return chosen.uri;
		}
	}
	const scheme = requireLocalFile ? Schemas.file : undefined;
	const opened = await dialogs.showOpenDialog({
		title: localize('adeSelectProjectFolderBrowse', "Select Project Folder"),
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		availableFileSystems: scheme ? [scheme] : undefined,
		defaultUri: await dialogs.defaultFolderPath(scheme),
	});
	return opened?.[0] ? removeTrailingPathSeparator(opened[0]) : undefined;
}

function tryGetOptionalService<T>(accessor: ServicesAccessor, identifier: { (...args: unknown[]): unknown; toString(): string }): T | undefined {
	try {
		return accessor.get(identifier as never);
	} catch {
		return undefined;
	}
}

function sessionPicker(accessor: ServicesAccessor): (projectUri?: URI, mode?: 'create' | 'existing', customTitle?: string) => Promise<IAdeEngineSession | undefined> {
	const quickInput = accessor.get(IQuickInputService);
	const sessions = accessor.get(IAdeSessionsService);
	const dialogs = accessor.get(IFileDialogService);
	const projects = accessor.get(IAdeProjectsService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const fileService = tryGetOptionalService<IFileService>(accessor, IFileService);
	const contextService = tryGetOptionalService<IWorkspaceContextService>(accessor, IWorkspaceContextService);
	const workspaceEditing = tryGetOptionalService<IWorkspaceEditingService>(accessor, IWorkspaceEditingService);
	const environmentService = tryGetOptionalService<IWorkbenchEnvironmentService>(accessor, IWorkbenchEnvironmentService);

	return async (projectUri, mode, customTitle) => {
		let create: boolean;
		if (mode === 'create') {
			create = true;
		} else if (mode === 'existing') {
			create = false;
		} else {
			const operation = await quickInput.pick([
				{ label: localize('newEngineConversation', "New Conversation"), description: localize('newEngineConversationDescription', "Start a session with a Coding Agent"), create: true },
				{ label: localize('existingEngineConversation', "Open Existing Conversation"), description: localize('existingEngineConversationDescription', "Continue a session from its engine history"), create: false },
			], {
				title: customTitle ?? localize('addAgentConversation', "Add Agent Conversation"),
				placeHolder: localize('chooseConversationOperation', "Create a conversation or open an existing one"),
			});
			if (!operation) {
				return undefined;
			}
			create = operation.create;
		}

		const engine = await pickEngine(
			quickInput,
			sessions,
			customTitle ?? (create ? localize('newEngineConversation', "New Conversation") : localize('existingEngineConversation', "Open Existing Conversation")),
		);
		if (!engine) {
			return undefined;
		}

		if (create) {
			const scheme = engine.id.startsWith('aexus-') ? Schemas.file : undefined;
			const folder = projectUri ?? (await dialogs.showOpenDialog({
				title: localize('selectAgentProject', "Select Agent Project Folder"),
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				availableFileSystems: scheme ? [scheme] : undefined,
				defaultUri: await dialogs.defaultFolderPath(scheme),
			}))?.[0];
			if (!folder) {
				return undefined;
			}
			const normalized = removeTrailingPathSeparator(folder);
			projects.registerProject(normalized, basename(normalized));
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			return sessions.create(engine.id, normalized);
		}

		const conversations = sessions.list(engine.id, projectUri).then(items => items.map(session => ({
			label: session.label,
			description: session.projectUri.fsPath,
			session,
		})));
		const chosen = await quickInput.pick(conversations, {
			title: engine.name,
			placeHolder: localize('chooseExistingConversation', "Choose a conversation from the engine history"),
			matchOnDescription: true,
		});
		if (chosen?.session) {
			const normalized = removeTrailingPathSeparator(chosen.session.projectUri);
			projects.registerProject(normalized, basename(normalized));
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		}
		return chosen?.session;
	};
}

async function pickAgent(accessor: ServicesAccessor, id?: string): Promise<IAdeAgent | undefined> {
	const projects = accessor.get(IAdeProjectsService);
	const views = accessor.get(IViewsService);
	const quickInput = accessor.get(IQuickInputService);
	const view = views.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
	return (id && projects.getAgent(id))
		|| view?.selectedAgent
		|| (await quickInput.pick(projects.agents.map(agent => ({
			label: agent.label,
			description: agent.projectUri.fsPath,
			agent,
		})), { placeHolder: localize('selectParentAgent', "Select an Agent conversation") }))?.agent;
}

interface IRolePickItem extends IQuickPickItem {
	readonly role: AdeAgentRole | undefined;
	readonly rank: AdeSessionRank;
}

function formatRoleLabel(rank: AdeSessionRank): string {
	switch (rank) {
		case 'governor':
			return localize('roleLabelGovernor', "Governor");
		case 'manager':
			return localize('roleLabelManager', "Manager");
		case 'employee':
			return localize('roleLabelEmployee', "Employee");
		case 'subordinate':
			return localize('roleLabelSubordinate', "Member");
		case 'worker':
			return localize('roleLabelWorker', "Worker");
	}
}

function buildAllRolePickItems(): IRolePickItem[] {
	return [
		{
			label: localize('rolePickGovernor', "Governor"),
			description: localize('rolePickGovernorRankDesc', "L1 Top Rank · Team orchestrator (manages Manager / Employee / Worker)"),
			iconClass: ThemeIcon.asClassName(Codicon.organization),
			role: 'governor',
			rank: 'governor',
		},
		{
			label: localize('rolePickManager', "Manager"),
			description: localize('rolePickManagerRankDesc', "L2 Lead Rank · Module / domain lead (manages Employee / Worker)"),
			iconClass: ThemeIcon.asClassName(Codicon.briefcase),
			role: 'manager',
			rank: 'manager',
		},
		{
			label: localize('rolePickEmployee', "Employee"),
			description: localize('rolePickEmployeeRankDesc', "L3 Staff Rank · Specialist contributor (manages leaf Worker)"),
			iconClass: ThemeIcon.asClassName(Codicon.account),
			role: 'employee',
			rank: 'employee',
		},
		{
			label: localize('rolePickWorker', "Worker"),
			description: localize('rolePickWorkerRankDesc', "L4 Lowest Rank · Pure native Coding Agent (100% clean context, no role injection)"),
			iconClass: ThemeIcon.asClassName(Codicon.terminal),
			role: undefined,
			rank: 'worker',
		},
	];
}

async function pickSessionRole(
	quickInput: IQuickInputService,
	options: {
		readonly title: string;
		readonly placeHolder?: string;
		readonly prioritizeWorker?: boolean;
		readonly allowedRanks?: ReadonlySet<AdeSessionRank>;
		readonly currentRank?: AdeSessionRank;
	},
): Promise<IRolePickItem | undefined> {
	let items = buildAllRolePickItems();
	if (options.allowedRanks) {
		items = items.filter(item => options.allowedRanks!.has(item.rank));
	}
	if (options.prioritizeWorker) {
		items = [...items].sort((a, b) => Number(b.rank === 'worker') - Number(a.rank === 'worker'));
	}
	if (options.currentRank) {
		items = items.map(item => item.rank === options.currentRank
			? { ...item, description: `${item.description} (${localize('adeCurrentRoleTag', "Current")})` }
			: item);
	}
	return quickInput.pick(items, {
		title: options.title,
		placeHolder: options.placeHolder ?? localize('adeSelectRolePlaceholder', "Choose the organizational rank for this Coding Agent session"),
		matchOnDescription: true,
	});
}

registerAction2(class AddAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.addProjectFolder',
			title: localize2('adeAddProjectFolderTitle', "Add Project Folder..."),
			icon: Codicon.add,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			menu: { ...viewTitleMenu, order: 0 },
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI | readonly URI[]): Promise<void> {
		const dialogs = accessor.get(IFileDialogService);
		const projects = accessor.get(IAdeProjectsService);
		const modes = accessor.get(IWorkbenchModeService);
		const uriIdentity = accessor.get(IUriIdentityService);
		const fileService = tryGetOptionalService<IFileService>(accessor, IFileService);
		const contextService = tryGetOptionalService<IWorkspaceContextService>(accessor, IWorkspaceContextService);
		const workspaceEditing = tryGetOptionalService<IWorkspaceEditingService>(accessor, IWorkspaceEditingService);
		const environmentService = tryGetOptionalService<IWorkbenchEnvironmentService>(accessor, IWorkbenchEnvironmentService);

		const folders = URI.isUri(uri)
			? [uri]
			: Array.isArray(uri) && uri.some(item => URI.isUri(item))
				? uri.filter((item): item is URI => URI.isUri(item))
				: (await dialogs.showOpenDialog({
					title: localize('adeSelectProjectFolderDialog', "Add Project Folder"),
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: true,
					defaultUri: await dialogs.defaultFolderPath(),
				})) ?? [];
		if (folders.length === 0) {
			return;
		}
		let lastNormalized: URI | undefined;
		for (const folder of folders) {
			const normalized = removeTrailingPathSeparator(folder);
			projects.registerProject(normalized, basename(normalized));
			lastNormalized = normalized;
		}
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		if (lastNormalized) {
			projects.selectProject(lastNormalized);
		}
		modes.setMode('ade');
	}
});

registerAction2(class RemoveAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_REMOVE_PROJECT_COMMAND_ID,
			title: localize2('adeRemoveProjectFolderTitle', "Remove Project"),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI | readonly URI[]): Promise<void> {
		await removeProjectsSynchronized(accessor, uri);
	}
});

registerAction2(class DeleteAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_DELETE_PROJECT_COMMAND_ID,
			title: localize2('adeDeleteProjectFolderTitle', "Delete Project..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 2 },
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI | readonly URI[], options?: { permanent?: boolean }): Promise<void> {
		await deleteProjectsWithModePrompt(accessor, 'ade', uri, options);
	}
});

registerAction2(class DeleteIdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: DELETE_ROOT_FOLDER_COMMAND_ID,
			title: localize2('ideDeleteProjectFolderTitle', "Delete Project..."),
			f1: true,
			precondition: ContextKeyExpr.and(WorkbenchModeContext.isEqualTo('ide'), WorkspaceFolderCountContext.notEqualsTo('0')),
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI | readonly URI[], options?: { permanent?: boolean }): Promise<void> {
		await deleteProjectsWithModePrompt(accessor, 'ide', uri, options);
	}
});

registerAction2(class NewAdeSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.newSession',
			title: localize2('adeNewSessionTitle', "New Session..."),
			icon: Codicon.add,
			f1: true,
			menu: {
				id: MenuId.EditorTitle,
				group: 'navigation',
				order: 1,
				when: ContextKeyExpr.and(WorkbenchModeContext.isEqualTo('ade'), ActiveEditorContext.isEqualTo(ChatEditorInput.EditorID)),
			},
		});
	}

	async run(accessor: ServicesAccessor, projectUri?: URI): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const modes = accessor.get(IWorkbenchModeService);
		const views = accessor.get(IViewsService);
		const quickInput = accessor.get(IQuickInputService);
		const chooseSession = sessionPicker(accessor);
		const resolvedFolder = await resolveTargetProjectUri(accessor, projectUri);
		if (!resolvedFolder) {
			return;
		}
		const pickedRole = await pickSessionRole(quickInput, {
			title: localize('adeNewSessionRoleTitle', "New Session in '{0}' — Select Agent Role", basename(resolvedFolder)),
		});
		if (!pickedRole) {
			return;
		}
		const session = await chooseSession(
			resolvedFolder,
			'create',
			localize('adeNewRoleEngineTitle', "New {0} Session — Choose Coding Agent", pickedRole.label),
		);
		if (!session) {
			return;
		}
		const agent = projects.addSession(session.projectUri, session, session.label, {
			role: pickedRole.role,
		});
		modes.setMode('ade');
		await editors.openAgent(agent.id);
		await (await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID))?.revealAgent(agent.id);
	}
});

registerAction2(class OpenExistingAdeSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.openExistingSession',
			title: localize2('adeOpenExistingSessionTitle', "Open Existing Session..."),
			icon: Codicon.history,
			f1: true,
			menu: { ...viewTitleMenu, order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, projectUri?: URI): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const modes = accessor.get(IWorkbenchModeService);
		const views = accessor.get(IViewsService);
		const navigation = accessor.get(IProjectNavigationService);
		const quickInput = accessor.get(IQuickInputService);
		const scopedUri = URI.isUri(projectUri) ? projectUri : navigation.focusedProject?.uri;
		const session = await sessionPicker(accessor)(scopedUri, 'existing');
		if (!session) {
			return;
		}
		const pickedRole = await pickSessionRole(quickInput, {
			title: localize('adeAttachSessionRoleTitle', "Attach '{0}' — Select Agent Role", session.label),
			prioritizeWorker: true,
		});
		if (!pickedRole) {
			return;
		}
		const agent = projects.addSession(session.projectUri, session, session.label, {
			role: pickedRole.role,
		});
		modes.setMode('ade');
		await editors.openAgent(agent.id);
		await (await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID))?.revealAgent(agent.id);
	}
});

registerAction2(class AddProjectAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.addProject',
			title: localize2('addProjectAgent', "Add Agent Conversation..."),
			icon: Codicon.commentDiscussion,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, projectUri?: URI): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const modes = accessor.get(IWorkbenchModeService);
		const views = accessor.get(IViewsService);
		const quickInput = accessor.get(IQuickInputService);
		const session = await sessionPicker(accessor)(URI.isUri(projectUri) ? projectUri : undefined);
		if (session) {
			const pickedRole = await pickSessionRole(quickInput, {
				title: localize('adeAttachSessionRoleTitle', "Attach '{0}' — Select Agent Role", session.label),
				prioritizeWorker: true,
			});
			if (!pickedRole) {
				return;
			}
			const agent = projects.addSession(session.projectUri, session, session.label, {
				role: pickedRole.role,
			});
			modes.setMode('ade');
			await editors.openAgent(agent.id);
			await (await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID))?.revealAgent(agent.id);
		}
	}
});

registerAction2(class NewSubSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.newSubSession',
			title: localize2('adeNewSubSessionTitle', "New Sub-Session..."),
			icon: Codicon.add,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, parentId?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const modes = accessor.get(IWorkbenchModeService);
		const views = accessor.get(IViewsService);
		const quickInput = accessor.get(IQuickInputService);
		const chooseSession = sessionPicker(accessor);

		const parent = await pickAgent(accessor, parentId);
		if (!parent) {
			return;
		}
		const hasSubs = projects.hasSubordinates(parent.id);
		let nextLower = getNextLowerAdeRole(parent.role, hasSubs);
		if (!nextLower.canSpawnSubSession) {
			const promoted = await pickSessionRole(quickInput, {
				title: localize('adePromoteWorkerBeforeSubTitle', "'{0}' is a lowest-rank Worker — Promote Parent Role First", parent.label),
				placeHolder: localize('adePromoteWorkerPlaceholder', "Promote this Worker to Governor, Manager, or Employee to manage sub-sessions"),
				allowedRanks: new Set<AdeSessionRank>(['governor', 'manager', 'employee']),
			});
			if (!promoted) {
				return;
			}
			projects.setAgentRole(parent.id, promoted.role);
			nextLower = getNextLowerAdeRole(promoted.role, false);
		} else if (!parent.role && hasSubs) {
			projects.setAgentRole(parent.id, 'governor');
		}
		const childRankTitle = formatRoleLabel(nextLower.childRank);
		const session = await chooseSession(
			parent.projectUri,
			'create',
			localize('adeNewSubSessionEngineTitle', "New {0} Sub-Session (under '{1}')", childRankTitle, parent.label),
		);
		if (!session) {
			return;
		}
		const agent = projects.addSession(parent.projectUri, session, session.label, {
			parentId: parent.id,
			role: nextLower.childRole,
		});
		modes.setMode('ade');
		await editors.openAgent(agent.id);
		await (await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID))?.revealAgent(agent.id);
	}
});

registerAction2(class RecruitSubordinateAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.addAgent',
			title: localize2('recruitSubordinateAgent', "Recruit Subordinate Agent..."),
			icon: Codicon.organization,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, parentId?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const quickInput = accessor.get(IQuickInputService);
		const views = accessor.get(IViewsService);
		const chooseSession = sessionPicker(accessor);

		const parent = await pickAgent(accessor, parentId);
		if (!parent) {
			return;
		}
		const hasSubs = projects.hasSubordinates(parent.id);
		let parentRankLevel = getAdeRoleRankLevel(parent.role, hasSubs);
		if (parentRankLevel === 0) {
			const promoted = await pickSessionRole(quickInput, {
				title: localize('adePromoteWorkerBeforeSubTitle', "'{0}' is a lowest-rank Worker — Promote Parent Role First", parent.label),
				placeHolder: localize('adePromoteWorkerPlaceholder', "Promote this Worker to Governor, Manager, or Employee to manage sub-sessions"),
				allowedRanks: new Set<AdeSessionRank>(['governor', 'manager', 'employee']),
			});
			if (!promoted) {
				return;
			}
			projects.setAgentRole(parent.id, promoted.role);
			parentRankLevel = getAdeRoleRankLevel(promoted.role, false);
		} else if (!parent.role && hasSubs) {
			projects.setAgentRole(parent.id, 'governor');
		}
		const allowedRanks = new Set<AdeSessionRank>(
			(['governor', 'manager', 'employee', 'worker'] as const).filter(rank =>
				getAdeRoleRankLevel(rank === 'worker' ? undefined : rank) < parentRankLevel,
			),
		);
		const rolePick = await pickSessionRole(quickInput, {
			title: localize('adeChooseSubordinateRoleTitle', "Recruit Subordinate Agent (under '{0}')", parent.label),
			placeHolder: localize('adeChooseSubordinateRolePlaceholder', "Choose a lower organizational rank for this subordinate Agent"),
			allowedRanks,
		});
		if (!rolePick) {
			return;
		}
		const session = await chooseSession(
			parent.projectUri,
			undefined,
			localize('adeRecruitEngineTitle', "Recruit {0} (under '{1}') — Choose Coding Agent", rolePick.label, parent.label),
		);
		if (!session) {
			return;
		}
		const agent = projects.addSession(parent.projectUri, session, session.label, {
			parentId: parent.id,
			role: rolePick.role,
		});
		await editors.openAgent(agent.id);
		await (await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID))?.revealAgent(agent.id);
	}
});

registerAction2(class SetAgentRoleAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.setRole',
			title: localize2('adeSetRoleTitle', "Set Agent Role..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const quickInput = accessor.get(IQuickInputService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		const subs = projects.getDirectSubordinates(agent.id);
		const hasSubs = subs.length > 0;
		const minRankLevel = hasSubs
			? Math.max(1, ...subs.map(child => getAdeRoleRankLevel(child.role, projects.hasSubordinates(child.id)) + 1))
			: 0;
		const parent = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
		const maxRankLevel = parent
			? getAdeRoleRankLevel(parent.role, true) - 1
			: 3;
		const allowedRanks = new Set<AdeSessionRank>(
			(['governor', 'manager', 'employee', 'worker'] as const).filter(rank => {
				const level = getAdeRoleRankLevel(rank === 'worker' ? undefined : rank);
				return level >= minRankLevel && level <= maxRankLevel;
			}),
		);
		const picked = await pickSessionRole(quickInput, {
			title: localize('adeSetRolePickerTitle', "Set Role for '{0}'", agent.label),
			placeHolder: localize('adeSetRolePickerPlaceholder', "Select an organizational role (rank)"),
			allowedRanks,
			currentRank: resolveAdeAgentRank(agent, hasSubs),
		});
		if (!picked) {
			return;
		}
		projects.setAgentRole(agent.id, picked.role);
	}
});

registerAction2(class ReparentAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.reparentAgent',
			title: localize2('adeReparentAgentTitle', "Move Session / Change Supervisor..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const views = accessor.get(IViewsService);
		const quickInput = accessor.get(IQuickInputService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		interface ISupervisorPickItem extends IQuickPickItem {
			readonly parentId: string | undefined;
			readonly projectUri?: URI;
		}
		const items: ISupervisorPickItem[] = [];
		if (projects.canReparentAgent(agent.id, undefined, agent.projectUri)) {
			items.push({
				label: localize('adeMoveToTopLevelPick', "Top-Level Session (No Supervisor)"),
				description: projects.getProjectName(agent.projectUri),
				iconClass: ThemeIcon.asClassName(Codicon.folder),
				parentId: undefined,
				projectUri: agent.projectUri,
			});
		}
		for (const candidate of projects.agents) {
			if (!projects.canReparentAgent(agent.id, candidate.id)) {
				continue;
			}
			const candidateRank = formatRoleLabel(resolveAdeAgentRank(candidate, projects.hasSubordinates(candidate.id)));
			items.push({
				label: candidate.label,
				description: `${candidateRank} • ${projects.getProjectName(candidate.projectUri)}`,
				iconClass: ThemeIcon.asClassName(Codicon.organization),
				parentId: candidate.id,
			});
		}
		const picked = await quickInput.pick(items, {
			title: localize('adeReparentPickerTitle', "Move '{0}' — Select New Supervisor", agent.label),
			placeHolder: localize('adeReparentPickerPlaceholder', "Select a target supervisor session or promote to top-level"),
			matchOnDescription: true,
		});
		if (!picked) {
			return;
		}
		if (projects.reparentAgent(agent.id, picked.parentId, picked.projectUri)) {
			await (await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID))?.revealAgent(agent.id);
		}
	}
});

registerAction2(class CopyAgentRolePromptAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.copyRolePrompt',
			title: localize2('adeCopyRolePromptTitle', "Copy Role & Subordinate API Prompt"),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const sessions = accessor.get(IAdeSessionsService);
		const clipboard = accessor.get(IClipboardService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		const subs = projects.getDirectSubordinates(agent.id);
		const rank = resolveAdeAgentRank(agent, subs.length > 0);
		const rankLabel = formatRoleLabel(rank);
		if (rank === 'worker') {
			await clipboard.writeText([
				`[Aexus Session Info]`,
				`- Role: Worker (Lowest Rank · Clean Native Context)`,
				`- Session: ${agent.label} (id: ${agent.id})`,
				`- Project: ${projects.getProjectName(agent.projectUri)} (${agent.projectUri.fsPath})`,
			].join('\n'));
			return;
		}
		const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
		const lines = [
			`[Aexus Orchestrated Role Context]`,
			`- Role: ${rankLabel}`,
			`- Session: ${agent.label} (id: ${agent.id})`,
			`- Project: ${projects.getProjectName(agent.projectUri)} (${agent.projectUri.fsPath})`,
		];
		if (supervisor) {
			const supRank = formatRoleLabel(resolveAdeAgentRank(supervisor, true));
			lines.push(`- Supervisor: ${supervisor.label} (id: ${supervisor.id}, role: ${supRank})`);
		}
		if (subs.length > 0) {
			lines.push(`- Direct Subordinates:`);
			for (const child of subs) {
				const childRank = formatRoleLabel(resolveAdeAgentRank(child, projects.hasSubordinates(child.id)));
				const childEngineName = child.session ? sessions.getEngineName(child.session.engineId) : 'Draft';
				lines.push(`  - ${child.label} (id: ${child.id}, role: ${childRank}, engine: ${childEngineName} [${child.session?.engineId ?? 'draft'}], status: ${child.status ?? 'idle'})`);
			}
			lines.push(`- Subtree Rooted at You:`);
			lines.push(...formatAdeAgentSubtreeLines(projects, sessions, agent.id));
		} else {
			lines.push(`- Direct Subordinates: None`);
		}
		lines.push(
			`- Subordinate Control API (\`aexus-ade\`, fallback \`/Applications/Aexus Code.app/Contents/Resources/app/bin/aexus-ade\`):`,
			`  - List direct subordinates: \`aexus-ade session subordinates ${agent.id} --json\``,
			`  - View full subtree rooted at you: \`aexus-ade session tree ${agent.id} --json\``,
			`  - Inspect hierarchy & engines: \`aexus-ade session info ${agent.id} --json\``,
			`  - Send task & wait for reply: \`aexus-ade session send <subordinate-id> "<task>" --wait --json\``,
			`  - Read subordinate history: \`aexus-ade session history <subordinate-id> --limit 10 --json\``,
			`  - Spawn lower-rank sub-session: \`aexus-ade session create --parent ${agent.id} --engine <claude|codex|kilo|opencode|dsh|agy|cline|pi> --title "<title>" --no-open --json\``,
			`  - Move subordinate to another supervisor: \`aexus-ade session move <subordinate-id> <new-parent-id|none> --json\``,
			`  - Stop active subordinate turn: \`aexus-ade session stop <subordinate-id>\``,
		);
		await clipboard.writeText(lines.join('\n'));
	}
});

registerAction2(class ConnectAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.connectAgent',
			title: localize2('connectAgent', "Connect Agent Conversation..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const agent = projects.getAgent(id);
		if (!agent || agent.session) {
			return;
		}
		const session = await sessionPicker(accessor)(agent.projectUri);
		if (session) {
			projects.bindSession(agent.id, session);
			await editors.openAgent(agent.id);
		}
	}
});

registerAction2(class RenameAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.renameAgent',
			title: localize2('renameAgent', "Rename Conversation..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: FocusedViewContext.isEqualTo(ADE_PROJECTS_VIEW_ID),
				primary: KeyCode.F2,
			},
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const views = accessor.get(IViewsService);
		const quickInput = accessor.get(IQuickInputService);
		const sessions = accessor.get(IAdeSessionsService);
		const view = views.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (view) {
			await view.startInlineRename(agent.id);
			return;
		}
		const label = await quickInput.input({ value: agent.label, prompt: localize('agentName', "Conversation Name") });
		if (label?.trim()) {
			const trimmed = label.trim();
			projects.renameAgent(agent.id, trimmed);
			if (agent.session) {
				await sessions.rename(agent.session, trimmed).catch(() => { });
			}
		}
	}
});

registerAction2(class ArchiveAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.archiveAgent',
			title: localize2('adeArchiveAgentTitle', "Archive Conversation"),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		const root = projects.getRootAgent(agent.id) ?? agent;
		const subtree = projects.getSubtree(root.id);
		projects.setArchived(root.id, true);
		await editors.closeAgents(subtree);
	}
});

registerAction2(class RestoreAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.restoreAgent',
			title: localize2('adeRestoreAgentTitle', "Restore Conversation"),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		const root = projects.getRootAgent(agent.id) ?? agent;
		projects.setArchived(root.id, false);
	}
});

registerAction2(class RemoveAgentAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.removeAgent',
			title: localize2('removeAgent', "Remove from Sidebar"),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const agent = await pickAgent(accessor, id);
		if (agent) {
			const subtree = projects.getSubtree(agent.id);
			projects.removeAgent(agent.id);
			await editors.closeAgents(subtree);
		}
	}
});

registerAction2(class DeleteAgentPermanentlyAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.deleteAgentPermanently',
			title: localize2('adeDeleteAgentPermanentlyTitle', "Delete Permanently..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, id?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const sessions = accessor.get(IAdeSessionsService);
		const dialogs = accessor.get(IDialogService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		const subtree = projects.getSubtree(agent.id);
		const confirmation = await dialogs.confirm({
			type: 'warning',
			message: localize('adeConfirmDeletePermanent', "Permanently delete '{0}' and its conversation history from the Coding Agent engine?", agent.label),
			detail: subtree.length > 1
				? localize('adeConfirmDeleteSubtreeDetail', "This will also permanently delete {0} subordinate conversation(s). This action cannot be undone.", subtree.length - 1)
				: localize('adeConfirmDeleteSingleDetail', "This action cannot be undone."),
			primaryButton: localize('adeDeletePermanentlyBtn', "&&Delete Permanently"),
		});
		if (!confirmation.confirmed) {
			return;
		}
		for (const member of subtree) {
			if (member.session) {
				await sessions.delete(member.session);
			}
		}
		await editors.closeAgents(subtree);
		projects.removeAgent(agent.id);
	}
});

registerAction2(class OpenSecretaryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.openSecretary',
			title: localize2('adeOpenSecretaryTitle', "Open Secretary"),
			icon: Codicon.sparkle,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, options?: { side?: boolean }): Promise<void> {
		const modes = accessor.get(IWorkbenchModeService);
		const editors = accessor.get(IAdeEditorService);
		modes.setMode('ade');
		await editors.openSecretary(options);
	}
});

registerAction2(class ConfigureSecretaryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.configureSecretary',
			title: localize2('adeConfigureSecretaryTitle', "Switch Secretary Engine..."),
			icon: Codicon.gear,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const sessions = accessor.get(IAdeSessionsService);
		const editors = accessor.get(IAdeEditorService);
		const quickInput = accessor.get(IQuickInputService);
		const navigation = accessor.get(IProjectNavigationService);
		const pathService = accessor.get(IPathService);

		const engine = await pickEngine(quickInput, sessions, localize('adeConfigureSecretaryPicker', "Configure Secretary Engine"));
		if (!engine) {
			return;
		}
		const localProject = [
			navigation.focusedProject?.uri,
			projects.selectedProject?.uri,
			navigation.selectedProject?.uri,
			...projects.projects.map(project => project.uri),
		].find((uri): uri is URI => Boolean(uri && uri.scheme === Schemas.file));
		const cwd = localProject ?? pathService.userHome({ preferLocal: true });
		const created = (await sessions.ensureSecretary?.(engine.id, cwd, true)) ?? (await sessions.create(engine.id, cwd));
		projects.configureSecretary({ engineId: created.engineId, resource: created.resource });
		await editors.openSecretary();
	}
});

registerAction2(class ResetSecretaryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.resetSecretary',
			title: localize2('adeResetSecretaryTitle', "Reset Secretary Context"),
			icon: Codicon.clearAll,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const sessions = accessor.get(IAdeSessionsService);
		const editors = accessor.get(IAdeEditorService);
		const navigation = accessor.get(IProjectNavigationService);
		const pathService = accessor.get(IPathService);

		const currentEngine = projects.secretary.session?.engineId;
		if (currentEngine) {
			const localProject = [
				navigation.focusedProject?.uri,
				projects.selectedProject?.uri,
				navigation.selectedProject?.uri,
				...projects.projects.map(project => project.uri),
			].find((uri): uri is URI => Boolean(uri && uri.scheme === Schemas.file));
			const cwd = localProject ?? pathService.userHome({ preferLocal: true });
			const fresh = (await sessions.ensureSecretary?.(currentEngine, cwd, true).catch(() => undefined))
				?? (await sessions.create(currentEngine, cwd).catch(() => undefined));
			projects.resetSecretary(fresh ? { engineId: fresh.engineId, resource: fresh.resource } : undefined);
		} else {
			projects.resetSecretary(undefined);
		}
		await editors.openSecretary();
	}
});

registerAction2(class RefreshAgentProjectsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.refresh',
			title: localize2('refreshAgentSessions', "Refresh Sessions"),
			icon: Codicon.refresh,
			menu: { ...viewTitleMenu, order: 2 },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const view = accessor.get(IViewsService).getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
		await view?.refresh();
	}
});
