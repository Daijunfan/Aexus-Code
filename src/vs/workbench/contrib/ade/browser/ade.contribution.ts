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
import {
	AEXUS_SSH_SCHEME,
	formatProjectDisplayPath,
	IAdeCloudHostBackendService,
	isCloudProjectUri,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	ADE_WATCHDOG_TIMEOUT_CONFIG_KEY,
	DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
	IAdeEngineeringService,
	IAdeInboxService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
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
	ADE_ADD_CLOUD_PROJECT_COMMAND_ID,
	ADE_CHANGES_VIEW_ID,
	ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID,
	ADE_DELETE_PROJECT_COMMAND_ID,
	ADE_FILES_VIEW_ID,
	ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID,
	ADE_INSPECTOR_CONTAINER_ID,
	ADE_OPEN_ENGINEERING_COMMAND_ID,
	ADE_OPEN_RESEARCH_COMMAND_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_REMOVE_PROJECT_COMMAND_ID,
	ADE_RENAME_PROJECT_COMMAND_ID,
	AdeAgentRole,
	AdeSessionRank,
	getAdeRoleRankLevel,
	getNextLowerAdeRole,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import {
	AdeCloudHostWorkbenchContribution,
	browseRemoteFolderOnCloudHost,
	pickCloudHostProjectFolder,
	pickProjectFoldersWithCloudOption,
} from './adeCloudHostFileSystemProvider.js';
import {
	AdeCloudHostsEditorInput,
	AdeCloudHostsEditorPane,
	AdeCloudHostsEditorSerializer,
} from './adeCloudHostsEditorPane.js';
import { AdeEditorService } from './adeEditorService.js';
import {
	AdeEngineeringEditorInput,
	AdeEngineeringEditorPane,
	AdeEngineeringEditorSerializer,
} from './adeEngineeringEditorPane.js';
import { AdeEngineeringWorkbenchService, AdeInboxService } from './adeEngineeringWorkbenchService.js';
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
registerSingleton(IAdeInboxService, AdeInboxService, InstantiationType.Delayed);
registerSingleton(IAdeEngineeringService, AdeEngineeringWorkbenchService, InstantiationType.Delayed);

class AdeEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeEditor';

	constructor(
		@IAdeEditorService editors: IAdeEditorService,
		@IAdeProjectsService projects: IAdeProjectsService,
		@IAdeEngineeringService engineering: IAdeEngineeringService,
		@IAdeInboxService _inbox: IAdeInboxService,
		@IChatSessionsService sessions: IChatSessionsService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IUriIdentityService uriIdentity: IUriIdentityService,
		@IFileService fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		void engineering.whenReady();
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

registerWorkbenchContribution2(AdeCloudHostWorkbenchContribution.ID, AdeCloudHostWorkbenchContribution, WorkbenchPhase.BlockRestore);
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

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeEngineeringEditorPane, AdeEngineeringEditorPane.ID, localize('adeEngineeringEditorPaneTitle', "ADE Engineering Workflow")),
	[new SyncDescriptor(AdeEngineeringEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeEngineeringEditorInput.ID, AdeEngineeringEditorSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeCloudHostsEditorPane, AdeCloudHostsEditorPane.ID, localize('adeCloudHostsEditorPaneTitle', "Cloud Hosts (SSH)")),
	[new SyncDescriptor(AdeCloudHostsEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeCloudHostsEditorInput.ID, AdeCloudHostsEditorSerializer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'aexusAdeEngineering',
	title: localize('adeEngineeringConfigurationTitle', "ADE Engineering"),
	type: 'object',
	properties: {
		[ADE_WATCHDOG_TIMEOUT_CONFIG_KEY]: {
			type: 'number',
			default: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
			minimum: 1,
			maximum: 240,
			description: localize('adeWatchdogTimeoutMinutesDesc', "Minutes of Worker execution inactivity before the ADE Engineering Watchdog wakes the Segment Manager to remind or kill-restart the stalled Worker."),
		},
	},
});

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
	const instantiationService = accessor.get(IInstantiationService);
	const navigation = accessor.get(IProjectNavigationService);
	const projects = accessor.get(IAdeProjectsService);
	const quickInput = accessor.get(IQuickInputService);
	const dialogs = accessor.get(IFileDialogService);

	if (navigation.focusedProject && (!requireLocalFile || navigation.focusedProject.uri.scheme === Schemas.file)) {
		return navigation.focusedProject.uri;
	}
	const candidates = projects.projects.filter(project => !requireLocalFile || project.uri.scheme === Schemas.file);
	if (candidates.length >= 1 || !requireLocalFile) {
		const active = projects.selectedProject;
		const sorted = active
			? [...candidates].sort((a, b) => Number(b.uri.toString() === active.uri.toString()) - Number(a.uri.toString() === active.uri.toString()))
			: candidates;
		const items: (IQuickPickItem & { uri?: URI; browse?: 'local' | 'cloud' })[] = [
			...sorted.map(project => ({
				label: project.name,
				description: formatProjectDisplayPath(project.uri),
				iconClass: ThemeIcon.asClassName(isCloudProjectUri(project.uri) ? Codicon.remote : Codicon.folder),
				uri: project.uri,
			})),
			{
				label: localize('adeBrowseProjectFolder', "Browse Local Folder..."),
				description: localize('adeBrowseProjectFolderDesc', "Select another project folder on this Mac"),
				iconClass: ThemeIcon.asClassName(Codicon.folderOpened),
				browse: 'local',
			},
			...(!requireLocalFile ? [{
				label: localize('adeBrowseCloudProjectFolder', "Cloud Host Folder (SSH)..."),
				description: localize('adeBrowseCloudProjectFolderDesc', "Select a remote project folder on a saved or VS Code Cloud Host"),
				iconClass: ThemeIcon.asClassName(Codicon.remote),
				browse: 'cloud' as const,
			}] : []),
		];
		const chosen = await quickInput.pick(items, {
			title: localize('adeChooseProjectTitle', "Select Project for Session"),
			placeHolder: localize('adeChooseProjectForSession', "Select a local or Cloud Host project folder for this session"),
			matchOnDescription: true,
		});
		if (!chosen) {
			return undefined;
		}
		if (chosen.uri) {
			return chosen.uri;
		}
		if (chosen.browse === 'cloud') {
			const cloudUri = await instantiationService.invokeFunction(acc => pickCloudHostProjectFolder(acc));
			return cloudUri ? removeTrailingPathSeparator(cloudUri) : undefined;
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
	const instantiationService = accessor.get(IInstantiationService);
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
			let folder = projectUri;
			if (!folder) {
				const pickedFolders = await instantiationService.invokeFunction(acc => pickProjectFoldersWithCloudOption(acc, {
					title: localize('selectAgentProject', "Select Agent Project Folder"),
				}));
				folder = pickedFolders?.[0];
			}
			if (!folder) {
				return undefined;
			}
			const normalized = removeTrailingPathSeparator(folder);
			if (engine.id.startsWith('aexus-') && normalized.scheme !== Schemas.file && normalized.scheme !== AEXUS_SSH_SCHEME) {
				const fallback = (await dialogs.showOpenDialog({
					title: localize('selectAgentProject', "Select Agent Project Folder"),
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					availableFileSystems: [Schemas.file],
					defaultUri: await dialogs.defaultFolderPath(Schemas.file),
				}))?.[0];
				if (!fallback) {
					return undefined;
				}
				const localNormalized = removeTrailingPathSeparator(fallback);
				projects.registerProject(localNormalized, basename(localNormalized));
				await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
				return sessions.create(engine.id, localNormalized);
			}
			projects.registerProject(normalized, basename(normalized) || normalized.authority || 'project');
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
			return sessions.create(engine.id, normalized);
		}

		const conversations = sessions.list(engine.id, projectUri).then(items => items.map(session => ({
			label: session.label,
			description: formatProjectDisplayPath(session.projectUri),
			session,
		})));
		const chosen = await quickInput.pick(conversations, {
			title: engine.name,
			placeHolder: localize('chooseExistingConversation', "Choose a conversation from the engine history"),
			matchOnDescription: true,
		});
		if (chosen?.session) {
			const normalized = removeTrailingPathSeparator(chosen.session.projectUri);
			projects.registerProject(normalized, basename(normalized) || normalized.authority || 'project');
			await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		}
		return chosen?.session;
	};
}

async function pickAgent(accessor: ServicesAccessor, id?: string): Promise<IAdeAgent | undefined> {
	const projects = accessor.get(IAdeProjectsService);
	if (id) {
		const direct = projects.getAgent(id);
		if (direct) {
			return direct;
		}
	}
	const views = tryGetOptionalService<IViewsService>(accessor, IViewsService);
	const quickInput = accessor.get(IQuickInputService);
	const view = views?.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
	if (view?.selectedAgent) {
		return view.selectedAgent;
	}
	if (projects.agents.length === 0) {
		return undefined;
	}
	return (await quickInput.pick(projects.agents.map(agent => ({
		label: agent.label,
		description: formatProjectDisplayPath(agent.projectUri),
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
			description: localize('rolePickEmployeeRankDesc', "L3 Supervisory & Review Rank (NOT Worker) · Orchestrates & reviews leaf Worker (L4)"),
			iconClass: ThemeIcon.asClassName(Codicon.account),
			role: 'employee',
			rank: 'employee',
		},
		{
			label: localize('rolePickWorker', "Worker"),
			description: localize('rolePickWorkerRankDesc', "L4 Lowest Pure Execution Rank (below Employee) · 100% clean native Coding Agent context, no subordinates"),
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
				: (await pickProjectFoldersWithCloudOption(accessor, {
					title: localize('adeSelectProjectFolderDialog', "Add Project Folder"),
				})) ?? [];
		if (folders.length === 0) {
			return;
		}
		let lastNormalized: URI | undefined;
		for (const folder of folders) {
			const normalized = removeTrailingPathSeparator(folder);
			projects.registerProject(normalized, basename(normalized) || normalized.authority || 'project');
			lastNormalized = normalized;
		}
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		if (lastNormalized) {
			projects.selectProject(lastNormalized);
		}
		modes.setMode('ade');
	}
});

registerAction2(class RenameAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_RENAME_PROJECT_COMMAND_ID,
			title: localize2('adeRenameProjectFolderTitle', "Rename Project Display Name..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const quickInput = accessor.get(IQuickInputService);
		const uriIdentity = accessor.get(IUriIdentityService);
		const fileService = tryGetOptionalService<IFileService>(accessor, IFileService);
		const contextService = tryGetOptionalService<IWorkspaceContextService>(accessor, IWorkspaceContextService);
		const workspaceEditing = tryGetOptionalService<IWorkspaceEditingService>(accessor, IWorkspaceEditingService);
		const environmentService = tryGetOptionalService<IWorkbenchEnvironmentService>(accessor, IWorkbenchEnvironmentService);

		const targetUri = URI.isUri(uri) ? uri : projects.selectedProject?.uri;
		if (!targetUri) {
			return;
		}
		const currentName = projects.getProjectName(targetUri);
		const nextName = await quickInput.input({
			title: localize('adeRenameProjectTitle', "Rename Project Display Name"),
			prompt: localize('adeRenameProjectPrompt', "Enter a custom display name for {0}", formatProjectDisplayPath(targetUri)),
			value: currentName,
		});
		if (!nextName?.trim() || nextName.trim() === currentName) {
			return;
		}
		projects.registerProject(targetUri, nextName.trim());
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
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

async function openOrInitializeWorkTree(
	accessor: ServicesAccessor,
	requestedTreeType: 'engineering' | 'research',
	governorId?: string,
): Promise<void> {
	const projects = accessor.get(IAdeProjectsService);
	const engineering = accessor.get(IAdeEngineeringService);
	const dialogs = accessor.get(IDialogService);
	const notifications = accessor.get(INotificationService);
	const modes = accessor.get(IWorkbenchModeService);

	const target = await pickAgent(accessor, governorId);
	if (!target) {
		return;
	}
	const modeLabel = requestedTreeType === 'research' ? 'Research' : 'Engineering';
	if (target.parentId) {
		notifications.warn(localize('adeEngRequiresRootGovernor', "Only a top-level Governor session can own an ADE {0} workflow tree.", modeLabel));
		return;
	}
	const rank = resolveAdeAgentRank(target, projects.hasSubordinates(target.id));
	if (rank !== 'governor') {
		notifications.warn(localize('adeEngMustBeGovernorRank', "Promote '{0}' to Governor first before enabling ADE {1}.", target.label, modeLabel));
		return;
	}

	await engineering.whenReady();
	if (engineering.hasTree(target.id) || target.treeType === requestedTreeType) {
		modes.setMode('ade');
		await engineering.openEngineeringEditor(target.id);
		return;
	}

	let onChildren: 'relocate' | 'delete' | undefined;
	const existingSubs = projects.getDirectSubordinates(target.id);
	if (existingSubs.length > 0) {
		const promptRes = await dialogs.prompt<'relocate' | 'delete'>({
			type: 'warning',
			message: localize(
				'adeEngExistingChildrenPromptTitle',
				"Governor '{0}' already has {1} subordinate session(s). How should ADE {2} handle them?",
				target.label,
				existingSubs.length,
				modeLabel,
			),
			detail: localize(
				'adeEngExistingChildrenPromptDetail',
				"A structured DAG work tree strictly manages its own 4-tier topology (Governor → Manager → Employee → Worker) and cannot mix with free-form subordinate sessions.",
			),
			buttons: [
				{
					label: localize('adeEngRelocateChildrenBtn', "&&Move Out to Independent Sessions"),
					run: () => 'relocate',
				},
				{
					label: localize('adeEngDeleteChildrenBtn', "&&Delete Existing Subordinates"),
					run: () => 'delete',
				},
			],
			cancelButton: true,
			custom: true,
		});
		if (!promptRes.result) {
			return;
		}
		onChildren = promptRes.result;
	}

	try {
		await engineering.initTree({
			governorSessionId: target.id,
			treeType: requestedTreeType,
			onChildren,
		});
		modes.setMode('ade');
		await engineering.openEngineeringEditor(target.id);
	} catch (err) {
		notifications.error(err instanceof Error ? err.message : String(err));
	}
}

registerAction2(class OpenAdeEngineeringAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_ENGINEERING_COMMAND_ID,
			title: localize2('adeOpenEngineeringActionTitle', "Open ADE Engineering..."),
			icon: Codicon.typeHierarchySub,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, governorId?: string): Promise<void> {
		await openOrInitializeWorkTree(accessor, 'engineering', governorId);
	}
});

registerAction2(class OpenAdeResearchAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_RESEARCH_COMMAND_ID,
			title: localize2('adeOpenResearchActionTitle', "Open ADE Research..."),
			icon: Codicon.beaker,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, governorId?: string): Promise<void> {
		await openOrInitializeWorkTree(accessor, 'research', governorId);
	}
});

registerAction2(class OpenAdeInboxAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.openInbox',
			title: localize2('adeOpenInboxActionTitle', "Open ADE Inbox"),
			icon: Codicon.inbox,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const views = accessor.get(IViewsService);
		const modes = accessor.get(IWorkbenchModeService);
		modes.setMode('ade');
		const view = await views.openView<AdeProjectsView>(ADE_PROJECTS_VIEW_ID, true);
		view?.setSidebarMode('inbox');
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
		const notifications = accessor.get(INotificationService);
		const chooseSession = sessionPicker(accessor);

		const parent = await pickAgent(accessor, parentId);
		if (!parent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(parent.id)) {
			notifications.info(localize('adeLockedByWorkTreeSubSession', "'{0}' belongs to a locked ADE Engineering tree. Edit its DAG topology on the Engineering canvas.", parent.label));
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
		const notifications = accessor.get(INotificationService);
		const chooseSession = sessionPicker(accessor);

		const parent = await pickAgent(accessor, parentId);
		if (!parent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(parent.id)) {
			notifications.info(localize('adeLockedByWorkTreeRecruit', "'{0}' belongs to a locked ADE Engineering tree. Edit its DAG topology on the Engineering canvas.", parent.label));
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
		const notifications = accessor.get(INotificationService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(agent.id)) {
			notifications.info(localize('adeLockedByWorkTreeSetRole', "'{0}' has a fixed organizational rank in an ADE Engineering tree and cannot be changed manually.", agent.label));
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
		const notifications = accessor.get(INotificationService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(agent.id)) {
			notifications.info(localize('adeLockedByWorkTreeReparent', "'{0}' belongs to a locked ADE Engineering tree and cannot be moved.", agent.label));
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
				`- Role: Worker (L4 Lowest Pure Execution Rank · Below Employee [L3], NOT Employee · 100% Clean Native Context)`,
				`- Session: ${agent.label} (id: ${agent.id})`,
				`- Project: ${projects.getProjectName(agent.projectUri)} (${formatProjectDisplayPath(agent.projectUri)})`,
			].join('\n'));
			return;
		}
		const supervisor = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
		const lines = [
			`[Aexus Orchestrated Role Context]`,
			`- Role: ${rankLabel}`,
			`- Rank Rule: Governor (L1) > Manager (L2) > Employee (L3) > Worker (L4) — Employee (L3) IS NOT Worker (L4)! Employee is an orchestrated supervisory/review rank above pure leaf Worker.`,
			`- Session: ${agent.label} (id: ${agent.id})`,
			`- Project: ${projects.getProjectName(agent.projectUri)} (${formatProjectDisplayPath(agent.projectUri)})`,
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

function collectMergedSubtree(projects: IAdeProjectsService, rootId: string, initialSubtree: readonly IAdeAgent[]): IAdeAgent[] {
	const merged = new Map<string, IAdeAgent>();
	for (const item of initialSubtree) {
		merged.set(item.id, item);
	}
	for (const item of projects.getSubtree(rootId)) {
		merged.set(item.id, item);
	}
	return [...merged.values()];
}

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
		const sessions = accessor.get(IAdeSessionsService);
		const engineering = accessor.get(IAdeEngineeringService);
		const notifications = accessor.get(INotificationService);
		const agent = await pickAgent(accessor, id);
		if (agent) {
			if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
				notifications.info(localize('adeLockedByWorkTreeRemoveChild', "'{0}' is managed by an ADE Engineering DAG. Delete or edit its node on the Engineering canvas instead.", agent.label));
				return;
			}
			const initialSubtree = projects.getSubtree(agent.id);
			await engineering.whenReady().catch(() => undefined);
			if (!agent.parentId && (engineering.hasTree(agent.id) || Boolean(agent.treeType))) {
				await engineering.removeTree(agent.id).catch(() => undefined);
			}
			const subtree = collectMergedSubtree(projects, agent.id, initialSubtree);
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

	async run(accessor: ServicesAccessor, id?: string, options?: { readonly force?: boolean }): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const sessions = accessor.get(IAdeSessionsService);
		const engineering = accessor.get(IAdeEngineeringService);
		const dialogs = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (agent.parentId && projects.isLockedByWorkTree?.(agent.id)) {
			notifications.info(localize('adeLockedByWorkTreeDeleteChild', "'{0}' is managed by an ADE Engineering DAG. Delete or edit its node on the Engineering canvas instead.", agent.label));
			return;
		}
		await engineering.whenReady().catch(() => undefined);
		const initialSubtree = projects.getSubtree(agent.id);
		if (!options?.force) {
			const confirmation = await dialogs.confirm({
				type: 'warning',
				message: localize('adeConfirmDeletePermanent', "Permanently delete '{0}' and its conversation history from the Coding Agent engine?", agent.label),
				detail: initialSubtree.length > 1
					? localize('adeConfirmDeleteSubtreeDetail', "This will also permanently delete {0} subordinate conversation(s). This action cannot be undone.", initialSubtree.length - 1)
					: localize('adeConfirmDeleteSingleDetail', "This action cannot be undone."),
				primaryButton: localize('adeDeletePermanentlyBtn', "&&Delete Permanently"),
			});
			if (!confirmation.confirmed) {
				return;
			}
		}
		if (!agent.parentId && (engineering.hasTree(agent.id) || Boolean(agent.treeType))) {
			await engineering.removeTree(agent.id).catch(() => undefined);
		}
		const subtree = collectMergedSubtree(projects, agent.id, initialSubtree);
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

CommandsRegistry.registerCommand(
	'workbench.action.aexusCloudHosts.pickProjectFolders',
	async (accessor: ServicesAccessor, options?: { readonly title?: string }) => {
		return pickProjectFoldersWithCloudOption(accessor, options);
	},
);

registerAction2(class ManageAdeCloudHostsAction extends Action2 {
	constructor() {
		super({
			id: ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID,
			title: localize2('adeManageCloudHostsTitle', "Cloud Hosts: Manage Saved Cloud Hosts..."),
			icon: Codicon.remote,
			f1: true,
			menu: [
				{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 0 },
				{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', 'workbench.explorer.fileView'), group: '2_workspace', order: 0 },
			],
		});
	}

	async run(accessor: ServicesAccessor, focusHostTarget?: string): Promise<void> {
		const editors = accessor.get(IAdeEditorService);
		await editors.openCloudHosts?.(typeof focusHostTarget === 'string' ? focusHostTarget : undefined);
	}
});

registerAction2(class AddAdeCloudProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_ADD_CLOUD_PROJECT_COMMAND_ID,
			title: localize2('adeAddCloudProjectFolderTitle', "Cloud Hosts: Add Cloud Host Project Folder..."),
			icon: Codicon.cloudDownload,
			f1: true,
			menu: [
				{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 0.5 },
				{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', 'workbench.explorer.fileView'), group: '2_workspace', order: 0.5 },
			],
		});
	}

	async run(accessor: ServicesAccessor, hostTarget?: string): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const projects = accessor.get(IAdeProjectsService);
		const uriIdentity = accessor.get(IUriIdentityService);
		const backend = tryGetOptionalService<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService);
		const fileService = tryGetOptionalService<IFileService>(accessor, IFileService);
		const contextService = tryGetOptionalService<IWorkspaceContextService>(accessor, IWorkspaceContextService);
		const workspaceEditing = tryGetOptionalService<IWorkspaceEditingService>(accessor, IWorkspaceEditingService);
		const environmentService = tryGetOptionalService<IWorkbenchEnvironmentService>(accessor, IWorkbenchEnvironmentService);

		let cloudUri: URI | undefined;
		if (typeof hostTarget === 'string' && hostTarget.trim() && backend) {
			const matched = await backend.getHost(hostTarget.trim());
			if (matched) {
				cloudUri = await instantiationService.invokeFunction(acc => browseRemoteFolderOnCloudHost(acc, matched));
			}
		}
		if (!cloudUri) {
			cloudUri = await instantiationService.invokeFunction(acc => pickCloudHostProjectFolder(acc));
		}
		if (!cloudUri) {
			return;
		}
		const normalized = removeTrailingPathSeparator(cloudUri);
		projects.registerProject(normalized, basename(normalized) || normalized.authority || 'project');
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		projects.selectProject(normalized);
	}
});

registerAction2(class ImportVsCodeCloudHostsAction extends Action2 {
	constructor() {
		super({
			id: ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID,
			title: localize2('adeImportVsCodeCloudHostsTitle', "Cloud Hosts: Migrate / Sync Cloud Hosts from VS Code & SSH Config"),
			icon: Codicon.sync,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const backend = tryGetOptionalService<IAdeCloudHostBackendService>(accessor, IAdeCloudHostBackendService);
		const notifications = accessor.get(INotificationService);
		const editors = accessor.get(IAdeEditorService);
		if (!backend) {
			notifications.warn(localize('adeCloudHostBackendUnavailable', "Cloud Host backend is unavailable in this environment."));
			return;
		}
		const res = await backend.importFromVsCodeAndSshConfig();
		notifications.info(localize(
			'adeImportVsCodeCloudHostsDone',
			"Migrated & synced {0} Cloud Host(s) ({1} new, {2} recent folders) from VS Code and ~/.ssh/config.",
			res.totalHosts,
			res.importedCount,
			res.importedRecentFolders,
		));
		await editors.openCloudHosts?.();
	}
});
