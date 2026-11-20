/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './ade.css';
import './adeColors.js';
import { buildAdeAgentRoleContext } from './adeControlHandler.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
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
	IAdeInboxService,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	ADE_ORGANIZATION_CONFIG_KEY,
	ADE_ORGANIZATION_JSON_SCHEMA,
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	findRankDefinition,
	getDefaultPureLeafRank,
	getMissionDisplayName,
	getTopRankDefinition,
	IAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
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
	ADE_OPEN_CONFIG_COMMAND_ID,
	ADE_OPEN_ENGINEERING_COMMAND_ID,
	ADE_OPEN_MISSION_COMMAND_ID,
	ADE_OPEN_RESEARCH_COMMAND_ID,
	ADE_OPEN_ROLE_STUDIO_COMMAND_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_REMOVE_MISSION_COMMAND_ID,
	ADE_REMOVE_PROJECT_COMMAND_ID,
	ADE_RENAME_PROJECT_COMMAND_ID,
	ADE_SECRETARY_ID,
	AdeAgentRole,
	AdeSessionRank,
	getAdeRoleRankLevel,
	getNextLowerAdeRole,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { AdeRoleSchemaService, IAdeRoleSchemaService, readTrustedApplicationConfigValue } from '../common/adeRoleSchemaService.js';
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
import {
	AdeConfigEditorInput,
	AdeConfigEditorPane,
	AdeConfigEditorSerializer,
} from './adeConfigEditorPane.js';
import { AdeEditorService } from './adeEditorService.js';
import {
	AdeEngineeringEditorInput,
	AdeEngineeringEditorPane,
	AdeEngineeringEditorSerializer,
} from './adeEngineeringEditorPane.js';
import { AdeInboxService } from './adeInboxService.js';
import { AdeMissionStoreService, IAdeMissionService } from './adeMissionStore.js';
import { AdeChangesView, AdeFilesView } from './adeInspectorViews.js';
import { deleteProjectsWithModePrompt, reconcileIdeWorkspaceWithCatalog, removeProjectsSynchronized } from './adeProjectManagement.js';
import { AdeProjectsService } from './adeProjectsService.js';
import { AdeProjectsView } from './adeProjectsView.js';
import {
	AdeRoleStudioEditorInput,
	AdeRoleStudioEditorPane,
	AdeRoleStudioEditorSerializer,
	resolveAdeRankCodicon,
} from './adeRoleStudioEditorPane.js';
import {
	AdeExtensionWebviewEditorInput,
	AdeExtensionWebviewEditorPane,
	AdeExtensionWebviewEditorSerializer,
	AdeSessionEditor,
	AdeSessionEditorInput,
	AdeSessionEditorSerializer,
} from './adeSessionEditor.js';
import { AdeSessionsService, IAdeEngine, IAdeEngineSession, IAdeSessionsService } from './adeSessionsService.js';

registerSingleton(IAdeRoleSchemaService, AdeRoleSchemaService, InstantiationType.Delayed);
registerSingleton(IAdeProjectsService, AdeProjectsService, InstantiationType.Delayed);
registerSingleton(IAdeEditorService, AdeEditorService, InstantiationType.Delayed);
registerSingleton(IAdeSessionsService, AdeSessionsService, InstantiationType.Delayed);
registerSingleton(IAdeInboxService, AdeInboxService, InstantiationType.Delayed);
registerSingleton(IAdeMissionService, AdeMissionStoreService, InstantiationType.Delayed);

class AdeEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeEditor';

	constructor(
		@IAdeEditorService editors: IAdeEditorService,
		@IAdeProjectsService projects: IAdeProjectsService,
		@IAdeMissionService _missions: IAdeMissionService,
		@IAdeInboxService _inbox: IAdeInboxService,
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

export const ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID = 'workbench.action.ade.toggleAutonomousMode';
export const ADE_MANAGE_TRUSTED_VERIFY_COMMAND_ID = 'workbench.action.ade.manageTrustedVerifyCommands';
export const ADE_TOGGLE_PROMPT_TO_DAG_COMMAND_ID = 'workbench.action.ade.togglePromptToDagBar';

export class AdeAutonomousModeStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeAutonomousModeStatus';
	private readonly entryAccessor: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.entryAccessor = this._register(statusbarService.addEntry(
			this.buildEntry(),
			'status.aexus.ade.autonomousMode',
			StatusbarAlignment.RIGHT,
			90,
		));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('aexus.ade.autonomousMode')) {
				this.entryAccessor.update(this.buildEntry());
			}
		}));
	}

	private buildEntry(): IStatusbarEntry {
		const autonomous = readTrustedApplicationConfigValue<boolean>(this.configurationService, 'aexus.ade.autonomousMode') === true;
		if (autonomous) {
			return {
				name: localize('adeStatusModeName', "Aexus ADE Permission Mode"),
				text: `$(flame) ${localize('adeStatusAutonomousText', "ADE: Autonomous")}`,
				ariaLabel: localize('adeStatusAutonomousAria', "Aexus ADE Permission Mode: Autonomous. Click to toggle back to Safe Mode."),
				tooltip: localize('adeStatusAutonomousTooltip', "Aexus ADE is in Autonomous Mode (aexus.ade.autonomousMode = true). Click to switch back to Safe Mode."),
				command: ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID,
				kind: 'warning',
			};
		}
		return {
			name: localize('adeStatusModeName', "Aexus ADE Permission Mode"),
			text: `$(shield) ${localize('adeStatusSafeText', "ADE: Safe Mode")}`,
			ariaLabel: localize('adeStatusSafeAria', "Aexus ADE Permission Mode: Safe Mode. Click to toggle Autonomous Mode."),
			tooltip: localize('adeStatusSafeTooltip', "Aexus ADE is in Safe Mode (aexus.ade.autonomousMode = false). Click to switch to Autonomous Mode."),
			command: ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID,
			kind: 'standard',
		};
	}
}

registerWorkbenchContribution2(AdeCloudHostWorkbenchContribution.ID, AdeCloudHostWorkbenchContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AdeEditorContribution.ID, AdeEditorContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AdeAutonomousModeStatusContribution.ID, AdeAutonomousModeStatusContribution, WorkbenchPhase.AfterRestored);

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
	EditorPaneDescriptor.create(AdeEngineeringEditorPane, AdeEngineeringEditorPane.ID, localize('adeMissionEditorPaneTitle', "ADE Mission")),
	[new SyncDescriptor(AdeEngineeringEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeEngineeringEditorInput.ID, AdeEngineeringEditorSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeCloudHostsEditorPane, AdeCloudHostsEditorPane.ID, localize('adeCloudHostsEditorPaneTitle', "Cloud Hosts (SSH)")),
	[new SyncDescriptor(AdeCloudHostsEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeCloudHostsEditorInput.ID, AdeCloudHostsEditorSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeRoleStudioEditorPane, AdeRoleStudioEditorPane.ID, localize('adeRoleStudioEditorPaneTitle', "Organization & Roles Studio")),
	[new SyncDescriptor(AdeRoleStudioEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeRoleStudioEditorInput.ID, AdeRoleStudioEditorSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AdeConfigEditorPane, AdeConfigEditorPane.ID, localize('adeConfigEditorPaneTitle', "ADE config")),
	[new SyncDescriptor(AdeConfigEditorInput)],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AdeConfigEditorInput.ID, AdeConfigEditorSerializer);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'aexusAdeEngineering',
	title: localize('adeMissionConfigurationTitle', "ADE Mission & Organization"),
	type: 'object',
	properties: {
		[ADE_ORGANIZATION_CONFIG_KEY]: {
			...ADE_ORGANIZATION_JSON_SCHEMA,
			default: DEFAULT_ADE_ORGANIZATION_CONFIG,
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			markdownDescription: localize(
				'adeOrganizationConfigDesc',
				"Customizable ADE rank hierarchy (L1..LN + L0 Secretary) and Mission display alias. Configure visually in [ADE config](command:workbench.action.ade.openConfig).",
			),
		},
		'aexus.ade.autonomousMode': {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			description: localize('adeAutonomousModeDesc', "Application-scoped toggle controlling whether ADE sessions may run with elevated autonomous execution flags. Restricted to prevent repository settings from enabling autonomous mode."),
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
				description: localize('adeBrowseProjectFolderDesc', "Select another local project folder on this machine"),
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

function getRoleConfig(accessor: ServicesAccessor): IAdeOrganizationConfig {
	return tryGetOptionalService<IAdeRoleSchemaService>(accessor, IAdeRoleSchemaService)?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
}

function formatRoleLabel(rank: AdeSessionRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): string {
	const def = findRankDefinition(config, rank);
	if (def) {
		return def.name;
	}
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
		default:
			return String(rank);
	}
}

function buildAllRolePickItems(config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): IRolePickItem[] {
	const defaultLeaf = getDefaultPureLeafRank(config);
	return config.ranks.map(rankDef => {
		const isDefaultPure = Boolean(rankDef.pureExecution && rankDef.id === defaultLeaf.id);
		const apiTag = rankDef.pureExecution
			? localize('adeRolePickPureTag', "Pure Leaf · 0 ADE APIs")
			: localize('adeRolePickApiCountTag', "{0} APIs", rankDef.allowedApis.length);
		return {
			label: rankDef.name,
			description: `L${rankDef.tier} · ${apiTag} · ${rankDef.summary}`,
			iconClass: ThemeIcon.asClassName(resolveAdeRankCodicon(rankDef.icon)),
			role: isDefaultPure ? undefined : rankDef.id,
			rank: rankDef.id,
		};
	});
}

async function pickSessionRole(
	quickInput: IQuickInputService,
	options: {
		readonly title: string;
		readonly placeHolder?: string;
		readonly prioritizeWorker?: boolean;
		readonly allowedRanks?: ReadonlySet<AdeSessionRank>;
		readonly currentRank?: AdeSessionRank;
		readonly config?: IAdeOrganizationConfig;
	},
): Promise<IRolePickItem | undefined> {
	const config = options.config ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	const defaultLeafId = getDefaultPureLeafRank(config).id;
	let items = buildAllRolePickItems(config);
	if (options.allowedRanks) {
		items = items.filter(item => options.allowedRanks!.has(item.rank));
	}
	if (options.prioritizeWorker) {
		items = [...items].sort((a, b) => Number(b.rank === defaultLeafId) - Number(a.rank === defaultLeafId));
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
		const roleConfig = getRoleConfig(accessor);
		const chooseSession = sessionPicker(accessor);
		const resolvedFolder = await resolveTargetProjectUri(accessor, projectUri);
		if (!resolvedFolder) {
			return;
		}
		const pickedRole = await pickSessionRole(quickInput, {
			title: localize('adeNewSessionRoleTitle', "New Session in '{0}' — Select Agent Role", basename(resolvedFolder)),
			config: roleConfig,
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
		const roleConfig = getRoleConfig(accessor);
		const scopedUri = URI.isUri(projectUri) ? projectUri : navigation.focusedProject?.uri;
		const session = await sessionPicker(accessor)(scopedUri, 'existing');
		if (!session) {
			return;
		}
		const pickedRole = await pickSessionRole(quickInput, {
			title: localize('adeAttachSessionRoleTitle', "Attach '{0}' — Select Agent Role", session.label),
			prioritizeWorker: true,
			config: roleConfig,
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
		const roleConfig = getRoleConfig(accessor);
		const session = await sessionPicker(accessor)(URI.isUri(projectUri) ? projectUri : undefined);
		if (session) {
			const pickedRole = await pickSessionRole(quickInput, {
				title: localize('adeAttachSessionRoleTitle', "Attach '{0}' — Select Agent Role", session.label),
				prioritizeWorker: true,
				config: roleConfig,
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

async function openOrCreateMissionCanvas(
	accessor: ServicesAccessor,
	targetIdOrProject?: string | URI,
): Promise<void> {
	const missions = accessor.get(IAdeMissionService);
	const projects = accessor.get(IAdeProjectsService);
	const roleConfig = getRoleConfig(accessor);
	const missionAlias = getMissionDisplayName(roleConfig);

	if (URI.isUri(targetIdOrProject)) {
		const projName = projects.getProjectName(targetIdOrProject);
		const created = missions.createMission({
			title: projName || missionAlias,
			ownerTier: -1,
			ownerRankId: 'user',
			projectUri: targetIdOrProject.toString(),
			mermaidText: '',
		});
		await missions.openMissionEditor(created.id);
		return;
	}

	if (typeof targetIdOrProject === 'string' && targetIdOrProject.trim()) {
		const id = targetIdOrProject.trim();
		const existing = missions.getMission(id) ?? missions.getMissionByLinkedSession(id);
		if (existing) {
			await missions.openMissionEditor(existing.id);
			return;
		}
		if (id === ADE_SECRETARY_ID) {
			const selectedProjUri = projects.selectedProject?.uri ?? projects.projects[0]?.uri;
			const created = missions.createMission({
				id: ADE_SECRETARY_ID,
				title: localize('adeSecretaryMissionTitle', "Secretary"),
				ownerSessionId: ADE_SECRETARY_ID,
				ownerTier: 0,
				ownerRankId: 'secretary',
				linkedSessionId: ADE_SECRETARY_ID,
				projectUri: selectedProjUri?.toString(),
				mermaidText: '',
			});
			await missions.openMissionEditor(created.id);
			return;
		}
		const linkedAgent = projects.getAgent(id);
		if (linkedAgent && projects.isLockedByWorkTree?.(linkedAgent.id)) {
			// Locked Mermaid-generated employees cannot spawn nested Missions; jump straight to their owning Mission!
			const owningId = linkedAgent.treeGovernorId ?? projects.getWorkTreeGovernor?.(linkedAgent.id)?.id;
			if (owningId) {
				await missions.openMissionEditor(owningId);
				return;
			}
		}
		if (linkedAgent) {
			const ownerRankDef = resolveEffectiveRankDefinition(roleConfig, linkedAgent.role, projects.hasSubordinates(linkedAgent.id));
			const created = missions.createMission({
				id: linkedAgent.id,
				title: linkedAgent.label,
				ownerSessionId: linkedAgent.id,
				ownerTier: ownerRankDef.tier,
				ownerRankId: ownerRankDef.id,
				linkedSessionId: linkedAgent.id,
				projectUri: linkedAgent.projectUri.toString(),
				mermaidText: '',
			});
			await missions.openMissionEditor(created.id);
			return;
		}
		const created = missions.createMission({
			id,
			title: missionAlias,
			ownerTier: -1,
			ownerRankId: 'user',
			mermaidText: '',
		});
		await missions.openMissionEditor(created.id);
		return;
	}

	const created = missions.createMission({
		title: `${missionAlias} ${missions.listMissions().length + 1}`,
		ownerTier: -1,
		ownerRankId: 'user',
		mermaidText: '',
	});
	await missions.openMissionEditor(created.id);
}

registerAction2(class ToggleAdeIdeModeAction extends Action2 {
	constructor() {
		super({
			id: 'aexus.toggleWorkbenchMode',
			title: localize2('aexusToggleModeTitle', "Aexus: Toggle ADE ⇄ IDE Mode"),
			icon: Codicon.arrowSwap,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const modes = accessor.get(IWorkbenchModeService);
		modes.setMode(modes.mode === 'ade' ? 'ide' : 'ade');
	}
});

registerAction2(class SwitchToAdeModeAction extends Action2 {
	constructor() {
		super({
			id: 'aexus.switchToAdeMode',
			title: localize2('aexusSwitchToAdeModeTitle', "Aexus: Switch to ADE Mode (Agent Development Environment)"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchModeService).setMode('ade');
	}
});

registerAction2(class SwitchToIdeModeAction extends Action2 {
	constructor() {
		super({
			id: 'aexus.switchToIdeMode',
			title: localize2('aexusSwitchToIdeModeTitle', "Aexus: Switch to IDE Mode"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IWorkbenchModeService).setMode('ide');
	}
});

registerAction2(class OpenAdeMissionAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_MISSION_COMMAND_ID,
			title: localize2('adeOpenMissionActionTitle', "New / Open ADE Mission"),
			icon: Codicon.typeHierarchySub,
			f1: true,
			menu: [
				{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: 'navigation', order: 2 },
			],
		});
	}

	async run(accessor: ServicesAccessor, target?: string | URI): Promise<void> {
		accessor.get(IWorkbenchModeService).setMode('ade');
		await openOrCreateMissionCanvas(accessor, target);
	}
});

registerAction2(class RemoveAdeMissionAction extends Action2 {
	constructor() {
		super({
			id: ADE_REMOVE_MISSION_COMMAND_ID,
			title: localize2('adeRemoveMissionActionTitle', "Remove ADE Mission & All Employees..."),
			icon: Codicon.trash,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, idOrOwnerId?: string, options?: { readonly force?: boolean; readonly deleteEngineHistory?: boolean }): Promise<void> {
		const missions = accessor.get(IAdeMissionService);
		const dialogs = accessor.get(IDialogService);
		const roleConfig = getRoleConfig(accessor);
		const missionAlias = getMissionDisplayName(roleConfig);
		const rawId = typeof idOrOwnerId === 'string' && idOrOwnerId.trim() ? idOrOwnerId.trim() : undefined;
		const mission = rawId ? (missions.getMission(rawId) ?? missions.getMissionByLinkedSession(rawId)) : undefined;
		if (!mission) {
			return;
		}
		const generatedCount = missions.getGeneratedEmployees(mission.id).length;
		if (!options?.force) {
			const confirmation = await dialogs.confirm({
				type: 'warning',
				message: localize('adeConfirmRemoveMissionTitle', "Remove {0} '{1}' and all generated employees?", missionAlias, mission.title),
				detail: generatedCount > 0
					? localize('adeConfirmRemoveMissionDetailWithEmployees', "This will remove the {0} canvas and all {1} locked Mermaid-generated employee session(s) together.", missionAlias, generatedCount)
					: localize('adeConfirmRemoveMissionDetailEmpty', "This will remove the {0} canvas and unlock its owner session.", missionAlias),
				primaryButton: localize('adeRemoveMissionPrimaryBtn', "&&Remove {0}", missionAlias),
			});
			if (!confirmation.confirmed) {
				return;
			}
		}
		await missions.removeMissionWithEmployees(mission.id, { deleteEngineHistory: options?.deleteEngineHistory });
	}
});

registerAction2(class OpenAdeEngineeringAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_ENGINEERING_COMMAND_ID,
			title: localize2('adeOpenEngineeringActionTitle', "Open ADE Mission (Legacy Engineering Alias)"),
			icon: Codicon.typeHierarchySub,
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, target?: string | URI): Promise<void> {
		accessor.get(IWorkbenchModeService).setMode('ade');
		await openOrCreateMissionCanvas(accessor, target);
	}
});

registerAction2(class OpenAdeResearchAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_RESEARCH_COMMAND_ID,
			title: localize2('adeOpenResearchActionTitle', "Open ADE Mission (Legacy Research Alias)"),
			icon: Codicon.typeHierarchySub,
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, target?: string | URI): Promise<void> {
		accessor.get(IWorkbenchModeService).setMode('ade');
		await openOrCreateMissionCanvas(accessor, target);
	}
});

registerAction2(class OpenAdeInboxAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.openInbox',
			title: localize2('adeOpenInboxActionTitle', "Open ADE Inbox"),
			icon: Codicon.inbox,
			f1: true,
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
		const roleConfig = getRoleConfig(accessor);
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
		let nextLower = getNextLowerAdeRole(parent.role, hasSubs, roleConfig);
		if (!nextLower.canSpawnSubSession) {
			const supervisoryRanks = new Set<AdeSessionRank>(
				roleConfig.ranks.filter(r => !r.pureExecution && r.canHaveSubordinates).map(r => r.id),
			);
			const promoted = await pickSessionRole(quickInput, {
				title: localize('adePromoteWorkerBeforeSubTitle', "'{0}' is a leaf rank — Promote Parent Role First", parent.label),
				placeHolder: localize('adePromoteWorkerPlaceholder', "Promote this session to a supervisory rank to manage sub-sessions"),
				allowedRanks: supervisoryRanks,
				config: roleConfig,
			});
			if (!promoted) {
				return;
			}
			projects.setAgentRole(parent.id, promoted.role);
			nextLower = getNextLowerAdeRole(promoted.role, false, roleConfig);
		} else if (!parent.role && hasSubs) {
			projects.setAgentRole(parent.id, getTopRankDefinition(roleConfig).id);
		}
		const childRankTitle = formatRoleLabel(nextLower.childRank, roleConfig);
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
		const roleConfig = getRoleConfig(accessor);
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
		let parentRankLevel = getAdeRoleRankLevel(parent.role, hasSubs, roleConfig);
		if (parentRankLevel === 0) {
			const supervisoryRanks = new Set<AdeSessionRank>(
				roleConfig.ranks.filter(r => !r.pureExecution && r.canHaveSubordinates).map(r => r.id),
			);
			const promoted = await pickSessionRole(quickInput, {
				title: localize('adePromoteWorkerBeforeSubTitle', "'{0}' is a leaf rank — Promote Parent Role First", parent.label),
				placeHolder: localize('adePromoteWorkerPlaceholder', "Promote this session to a supervisory rank to manage sub-sessions"),
				allowedRanks: supervisoryRanks,
				config: roleConfig,
			});
			if (!promoted) {
				return;
			}
			projects.setAgentRole(parent.id, promoted.role);
			parentRankLevel = getAdeRoleRankLevel(promoted.role, false, roleConfig);
		} else if (!parent.role && hasSubs) {
			projects.setAgentRole(parent.id, getTopRankDefinition(roleConfig).id);
		}
		const allowedRanks = new Set<AdeSessionRank>(
			roleConfig.ranks
				.filter(r => getAdeRoleRankLevel(r.id, false, roleConfig) < parentRankLevel)
				.map(r => r.id),
		);
		const rolePick = await pickSessionRole(quickInput, {
			title: localize('adeChooseSubordinateRoleTitle', "Recruit Subordinate Agent (under '{0}')", parent.label),
			placeHolder: localize('adeChooseSubordinateRolePlaceholder', "Choose a lower organizational rank for this subordinate Agent"),
			allowedRanks,
			config: roleConfig,
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
		const roleConfig = getRoleConfig(accessor);
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
			? Math.max(1, ...subs.map(child => getAdeRoleRankLevel(child.role, projects.hasSubordinates(child.id), roleConfig) + 1))
			: 0;
		const parent = agent.parentId ? projects.getAgent(agent.parentId) : undefined;
		const topLevel = getAdeRoleRankLevel(getTopRankDefinition(roleConfig).id, true, roleConfig);
		const maxRankLevel = parent
			? getAdeRoleRankLevel(parent.role, true, roleConfig) - 1
			: topLevel;
		const allowedRanks = new Set<AdeSessionRank>(
			roleConfig.ranks
				.filter(rankDef => {
					const level = getAdeRoleRankLevel(rankDef.id, false, roleConfig);
					if (hasSubs && (rankDef.pureExecution || !rankDef.canHaveSubordinates)) {
						return false;
					}
					return level >= minRankLevel && level <= maxRankLevel;
				})
				.map(r => r.id),
		);
		const picked = await pickSessionRole(quickInput, {
			title: localize('adeSetRolePickerTitle', "Set Role for '{0}'", agent.label),
			placeHolder: localize('adeSetRolePickerPlaceholder', "Select an organizational role (rank)"),
			allowedRanks,
			currentRank: resolveAdeAgentRank(agent, hasSubs, roleConfig),
			config: roleConfig,
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
		const roleConfig = getRoleConfig(accessor);
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
			const candidateRank = formatRoleLabel(resolveAdeAgentRank(candidate, projects.hasSubordinates(candidate.id), roleConfig), roleConfig);
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
		const roleConfig = getRoleConfig(accessor);
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		const compiled = buildAdeAgentRoleContext(projects, sessions, agent, roleConfig);
		if (!compiled) {
			const rankDef = resolveEffectiveRankDefinition(roleConfig, agent.role, projects.hasSubordinates(agent.id));
			await clipboard.writeText([
				`[Aexus Session Info]`,
				`- Role: ${rankDef.name} (L${rankDef.tier} Pure Execution Leaf · 100% Clean Native Context)`,
				`- Session: ${agent.label} (id: ${agent.id})`,
				`- Project: ${projects.getProjectName(agent.projectUri)} (${formatProjectDisplayPath(agent.projectUri)})`,
			].join('\n'));
			return;
		}
		await clipboard.writeText(compiled);
	}
});

registerAction2(class OpenAdeConfigAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_CONFIG_COMMAND_ID,
			title: localize2('adeOpenConfigTitle', "ADE config"),
			f1: true,
			menu: [
				{ id: MenuId.GlobalActivity, group: '2_configuration', order: 1 },
				{ id: MenuId.MenubarPreferencesMenu, group: '2_configuration', order: 1 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editors = accessor.get(IAdeEditorService);
		await editors.openAdeConfig?.();
	}
});

registerAction2(class OpenAdeRoleStudioAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_ROLE_STUDIO_COMMAND_ID,
			title: localize2('adeOpenRoleStudioTitle', "ADE: Customize Organization, Ranks & API Permissions..."),
			icon: Codicon.organization,
			f1: true,
			menu: [
				{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 1 },
			],
		});
	}

	async run(accessor: ServicesAccessor, focusRankId?: string): Promise<void> {
		const editors = accessor.get(IAdeEditorService);
		await editors.openRoleStudio?.(typeof focusRankId === 'string' ? focusRankId : undefined);
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
		const notifications = accessor.get(INotificationService);
		const missionAlias = getMissionDisplayName(getRoleConfig(accessor));
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(agent.id)) {
			notifications.info(localize('adeLockedByMissionArchiveUi', "'{0}' is locked by a {1} and cannot be archived individually. Remove the entire {1} and all its employees together instead.", agent.label, missionAlias));
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
		const notifications = accessor.get(INotificationService);
		const missions = tryGetOptionalService<IAdeMissionService>(accessor, IAdeMissionService);
		const missionAlias = getMissionDisplayName(getRoleConfig(accessor));
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(agent.id)) {
			notifications.info(localize('adeLockedByMissionRemoveUi', "'{0}' is locked by a {1} and cannot be removed individually. Remove the entire {1} and all its employees together instead.", agent.label, missionAlias));
			return;
		}
		const initialSubtree = projects.getSubtree(agent.id);
		if (missions) {
			for (const member of initialSubtree) {
				const owned = missions.getMissionByLinkedSession(member.id);
				if (owned) {
					await missions.removeMissionWithEmployees(owned.id);
				}
			}
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
		const dialogs = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);
		const missions = tryGetOptionalService<IAdeMissionService>(accessor, IAdeMissionService);
		const missionAlias = getMissionDisplayName(getRoleConfig(accessor));
		const agent = await pickAgent(accessor, id);
		if (!agent) {
			return;
		}
		if (projects.isLockedByWorkTree?.(agent.id)) {
			notifications.info(localize('adeLockedByMissionDeleteUi', "'{0}' is locked by a {1} and cannot be deleted individually. Remove the entire {1} and all its employees together instead.", agent.label, missionAlias));
			return;
		}
		const initialSubtree = projects.getSubtree(agent.id);
		const ownedMissions = missions
			? initialSubtree.map(m => missions.getMissionByLinkedSession(m.id)).filter((m): m is NonNullable<typeof m> => Boolean(m))
			: [];
		if (!options?.force) {
			const confirmation = await dialogs.confirm({
				type: 'warning',
				message: localize('adeConfirmDeletePermanent', "Permanently delete '{0}' and its conversation history from the Coding Agent engine?", agent.label),
				detail: ownedMissions.length > 0
					? localize('adeConfirmDeleteMissionOwnerDetail', "This will also remove {0} {1} and permanently delete {2} subordinate/generated employee conversation(s). This action cannot be undone.", ownedMissions.length, missionAlias, Math.max(0, initialSubtree.length - 1))
					: initialSubtree.length > 1
						? localize('adeConfirmDeleteSubtreeDetail', "This will also permanently delete {0} subordinate conversation(s). This action cannot be undone.", initialSubtree.length - 1)
						: localize('adeConfirmDeleteSingleDetail', "This action cannot be undone."),
				primaryButton: localize('adeDeletePermanentlyBtn', "&&Delete Permanently"),
			});
			if (!confirmation.confirmed) {
				return;
			}
		}
		if (missions) {
			for (const owned of ownedMissions) {
				await missions.removeMissionWithEmployees(owned.id, { deleteEngineHistory: true });
			}
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

registerAction2(class ToggleAdeAutonomousModeAction extends Action2 {
	constructor() {
		super({
			id: ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID,
			title: localize2('adeToggleAutonomousModeTitle', "Toggle Safe / Autonomous Permission Mode"),
			category: localize2('adeCategory', "Aexus ADE"),
			icon: Codicon.shield,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		const current = readTrustedApplicationConfigValue<boolean>(configurationService, 'aexus.ade.autonomousMode') === true;
		const next = !current;
		await configurationService.updateValue('aexus.ade.autonomousMode', next, ConfigurationTarget.USER);
		notifications.info(next
			? localize('adeAutonomousModeEnabledNotice', "Aexus ADE switched to Autonomous Mode (aexus.ade.autonomousMode = true).")
			: localize('adeSafeModeEnabledNotice', "Aexus ADE switched to Safe Mode (aexus.ade.autonomousMode = false)."));
	}
});

registerAction2(class ToggleAdeMissionFileAction extends Action2 {
	constructor() {
		super({
			id: ADE_TOGGLE_PROMPT_TO_DAG_COMMAND_ID,
			title: localize2('adeToggleMissionFileTitle', "Toggle Mission Mermaid File"),
			category: localize2('adeCategory', "Aexus ADE"),
			icon: Codicon.fileCode,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ActiveEditorContext.isEqualTo(AdeEngineeringEditorPane.ID),
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		const pane = editorService.activeEditorPane;
		if (pane instanceof AdeEngineeringEditorPane) {
			pane.toggleFileDrawer();
		}
	}
});
