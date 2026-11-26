/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './ade.css';
import './adeColors.js';
import './adeControlHandler.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, IAction2Options, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import {
	formatProjectDisplayPath,
	IAdeCloudHostBackendService,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { WorkspaceFolderCountContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService, WorkbenchModeContext, WorkbenchModeViewContainers } from '../../../services/workbenchMode/common/workbenchMode.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { ChatSessionStatus, IChatSessionsService } from '../../chat/common/chatSessionsService.js';
import { DELETE_ROOT_FOLDER_COMMAND_ID } from '../../files/browser/fileConstants.js';
import {
	ADE_ADD_CLOUD_PROJECT_COMMAND_ID,
	ADE_ADD_PROJECT_FOLDER_COMMAND_ID,
	ADE_CHANGES_VIEW_ID,
	ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID,
	ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID,
	ADE_CREATE_PROJECT_PAGE_COMMAND_ID,
	ADE_DELETE_PROJECT_COMMAND_ID,
	ADE_DELETE_PROJECT_PAGE_COMMAND_ID,
	ADE_FILES_VIEW_ID,
	ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID,
	ADE_INSPECTOR_CONTAINER_ID,
	ADE_OPEN_PROJECT_PAGE_COMMAND_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_REMOVE_PROJECT_COMMAND_ID,
	ADE_RENAME_PROJECT_COMMAND_ID,
	ADE_RENAME_PROJECT_PAGE_COMMAND_ID,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
} from '../common/ade.js';
import {
	ADE_DISPLAY_LANGUAGE_CONFIG_KEY,
	adeBi,
	getAdeDisplayLanguageSetting,
	setAdeDisplayLanguageOverride,
} from '../common/adeLocalization.js';
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
	AdePageVisibilityAnimationGuard,
} from './adeEngineeringEditorPane.js';
import { AdeChangesView, AdeFilesView } from './adeInspectorViews.js';
import { AdeMissionStoreService, IAdeMissionService } from './adeMissionStore.js';
import { deleteProjectsWithModePrompt, reconcileIdeWorkspaceWithCatalog, removeProjectsSynchronized } from './adeProjectManagement.js';
import { AdeProjectsService } from './adeProjectsService.js';
import {
	AdeProjectsView,
	configureAdeProjectTicketStorage,
	confirmAndDeleteAdeProjectPage,
	promptRenameAdeProjectPage,
	resolveTargetProjectPageId,
} from './adeProjectsView.js';
import {
	AdeExtensionWebviewEditorInput,
	AdeExtensionWebviewEditorPane,
	AdeExtensionWebviewEditorSerializer,
	AdeSessionEditor,
	AdeSessionEditorInput,
	AdeSessionEditorSerializer,
} from './adeSessionEditor.js';
import { AdeSessionsService, IAdeSessionsService } from './adeSessionsService.js';

function readTrustedApplicationConfigValue<T>(configurationService: IConfigurationService, key: string): T | undefined {
	const inspected = configurationService.inspect<T>(key);
	return inspected.policyValue ?? inspected.applicationValue ?? inspected.userLocalValue ?? inspected.userValue ?? inspected.defaultValue;
}

function tryGetOptionalService<T>(accessor: ServicesAccessor, identifier: { (...args: unknown[]): unknown; toString(): string }): T | undefined {
	try {
		return accessor.get(identifier as never);
	} catch {
		return undefined;
	}
}

/**
 * Registers an `Action2` safely even if its command ID was already registered in `CommandsRegistry`
 * by a companion view module (`adeProjectsView.ts`), attaching its menu and Command Palette entries
 * without throwing a duplicate command error.
 */
function registerAction2Safe(ctor: { new(): Action2 }): void {
	const probe = new ctor();
	const desc: IAction2Options = probe.desc;
	if (!CommandsRegistry.getCommand(desc.id)) {
		registerAction2(ctor);
		return;
	}
	const { f1, menu, keybinding: _kb, ...command } = desc;
	const menus = Array.isArray(menu) ? menu : (menu ? [menu] : []);
	for (const item of menus) {
		MenuRegistry.appendMenuItem(item.id, {
			command: { ...command, precondition: item.precondition === null ? undefined : command.precondition },
			...item,
		});
	}
	if (f1) {
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command,
			when: command.precondition,
		});
	}
}

registerSingleton(IAdeProjectsService, AdeProjectsService, InstantiationType.Delayed);
registerSingleton(IAdeEditorService, AdeEditorService, InstantiationType.Delayed);
registerSingleton(IAdeSessionsService, AdeSessionsService, InstantiationType.Delayed);
registerSingleton(IAdeMissionService, AdeMissionStoreService, InstantiationType.Delayed);

class AdeEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adeEditor';

	constructor(
		@IAdeEditorService editors: IAdeEditorService,
		@IAdeProjectsService projects: IAdeProjectsService,
		@IAdeMissionService _missions: IAdeMissionService,
		@IChatSessionsService sessions: IChatSessionsService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IUriIdentityService uriIdentity: IUriIdentityService,
		@IFileService fileService: IFileService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		setAdeDisplayLanguageOverride(configurationService.getValue<string>(ADE_DISPLAY_LANGUAGE_CONFIG_KEY));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ADE_DISPLAY_LANGUAGE_CONFIG_KEY)) {
				setAdeDisplayLanguageOverride(configurationService.getValue<string>(ADE_DISPLAY_LANGUAGE_CONFIG_KEY));
			}
		}));
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

		const maybeWithRemovalEvent = projects as IAdeProjectsService & {
			readonly onDidRemoveAgents?: (listener: (removed: readonly IAdeAgent[]) => void) => { dispose(): void };
			readonly onDidRemoveProjects?: (listener: (removedProjectIds: readonly string[]) => void) => { dispose(): void };
		};
		const maybeProjectScopedEditors = editors as IAdeEditorService & {
			readonly closeEditorsForProject?: (projectId: string) => Promise<void>;
		};
		if (typeof maybeWithRemovalEvent.onDidRemoveProjects === 'function') {
			this._register(maybeWithRemovalEvent.onDidRemoveProjects(removedProjectIds => {
				for (const pid of removedProjectIds) {
					if (typeof maybeProjectScopedEditors.closeEditorsForProject === 'function') {
						void maybeProjectScopedEditors.closeEditorsForProject(pid);
					} else {
						void editors.closeProjectPageEditors(pid);
					}
				}
			}));
		}
		if (typeof maybeWithRemovalEvent.onDidRemoveAgents === 'function') {
			this._register(maybeWithRemovalEvent.onDidRemoveAgents(removedAgents => {
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
			if (kind !== 'order' && kind !== 'selection') {
				reconcileWorkspace();
			}
		}));
	}
}

export const ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID = 'workbench.action.ade.toggleAutonomousMode';
export const ADE_SWITCH_DISPLAY_LANGUAGE_COMMAND_ID = 'workbench.action.ade.switchDisplayLanguage';

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
		const autonomous = readTrustedApplicationConfigValue<boolean>(this.configurationService, 'aexus.ade.autonomousMode') !== false;
		if (autonomous) {
			return {
				name: localize('adeStatusModeName', "Aexus ADE Permission Mode"),
				text: `$(flame) ${localize('adeStatusAutonomousText', "ADE: Autonomous")}`,
				ariaLabel: localize('adeStatusAutonomousAria', "Aexus ADE Permission Mode: Full Access (Autonomous). Click to switch to Safe Mode."),
				tooltip: localize('adeStatusAutonomousTooltip', "Aexus ADE is in Full Access / Autonomous Mode (aexus.ade.autonomousMode = true). Click to switch to Safe Mode."),
				command: ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID,
				kind: 'warning',
			};
		}
		return {
			name: localize('adeStatusModeName', "Aexus ADE Permission Mode"),
			text: `$(shield) ${localize('adeStatusSafeText', "ADE: Safe Mode")}`,
			ariaLabel: localize('adeStatusSafeAria', "Aexus ADE Permission Mode: Safe Mode. Click to switch to Full Access (Autonomous)."),
			tooltip: localize('adeStatusSafeTooltip', "Aexus ADE is in Safe Mode (aexus.ade.autonomousMode = false). Click to switch to Full Access (Autonomous Mode)."),
			command: ADE_TOGGLE_AUTONOMOUS_MODE_COMMAND_ID,
			kind: 'standard',
		};
	}
}

registerWorkbenchContribution2(AdeCloudHostWorkbenchContribution.ID, AdeCloudHostWorkbenchContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AdeEditorContribution.ID, AdeEditorContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AdeAutonomousModeStatusContribution.ID, AdeAutonomousModeStatusContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AdePageVisibilityAnimationGuard.ID, AdePageVisibilityAnimationGuard, WorkbenchPhase.AfterRestored);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);

const sidebarContainer = viewContainersRegistry.registerViewContainer({
	id: WorkbenchModeViewContainers.ade,
	title: localize2('adeProjectsSidebarContainer', "Projects"),
	icon: Codicon.organization,
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
	name: localize2('adeProjectsViewTitle', "Projects"),
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
	EditorPaneDescriptor.create(AdeEngineeringEditorPane, AdeEngineeringEditorPane.ID, localize('adeEngineeringEditorPaneTitle', "ADE Project Canvas")),
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
	title: localize('adeEngineeringConfigurationTitle', "Aexus ADE"),
	type: 'object',
	properties: {
		'aexus.ade.autonomousMode': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			restricted: true,
			description: localize('adeAutonomousModeDesc', "Application-scoped toggle controlling whether local and cloud ADE agent sessions default to Full Access / autonomous execution flags (enabled by default). Restricted to prevent repository settings from modifying it."),
		},
		[ADE_DISPLAY_LANGUAGE_CONFIG_KEY]: {
			type: 'string',
			enum: ['auto', 'en', 'zh-cn'],
			enumDescriptions: [
				localize('adeDisplayLanguageAutoDesc', "Follow VS Code's active display language (pure English for non-Chinese locales, pure Simplified Chinese for Chinese locales)."),
				localize('adeDisplayLanguageEnDesc', "Render Aexus ADE Project Canvases, Popovers, Session Headers, and Projects View in pure English."),
				localize('adeDisplayLanguageZhDesc', "Render Aexus ADE Project Canvases, Popovers, Session Headers, and Projects View in pure Simplified Chinese."),
			],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('adeDisplayLanguageConfigDesc', "Display language for Aexus ADE surfaces."),
		},
	},
});

const viewTitleMenu = { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: 'navigation' };

registerAction2Safe(class ToggleAdeIdeModeAction extends Action2 {
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

registerAction2Safe(class SwitchToAdeModeAction extends Action2 {
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

registerAction2Safe(class SwitchToIdeModeAction extends Action2 {
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

registerAction2Safe(class AddAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_ADD_PROJECT_FOLDER_COMMAND_ID,
			title: localize2('adeAddProjectFolderTitle', "Add Workspace Folder..."),
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
					title: localize('adeSelectProjectFolderDialog', "Add Workspace Folder"),
				})) ?? [];
		if (folders.length === 0) {
			return;
		}
		let lastNormalized: URI | undefined;
		for (const folder of folders) {
			const normalized = removeTrailingPathSeparator(folder);
			if (projects.registerWorkspaceFolderAsync) {
				await projects.registerWorkspaceFolderAsync(normalized, basename(normalized) || normalized.authority || 'project');
			} else {
				projects.registerProject(normalized, basename(normalized) || normalized.authority || 'project');
			}
			lastNormalized = normalized;
		}
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		if (lastNormalized) {
			projects.selectProject(lastNormalized);
		}
		modes.setMode('ade');
	}
});

registerAction2Safe(class CreateAdeProjectPageAction extends Action2 {
	constructor() {
		super({
			id: ADE_CREATE_PROJECT_PAGE_COMMAND_ID,
			title: localize2('adeCreateProjectPageTitle', "New Project Page..."),
			icon: Codicon.organization,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			menu: { ...viewTitleMenu, order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, rawFolderUri?: URI, rawName?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const targetFolder = URI.isUri(rawFolderUri)
			? rawFolderUri
			: (projects.selectedProject?.uri ?? projects.projects[0]?.uri);
		if (!targetFolder) {
			return;
		}
		const snap = await projects.createProjectPage(targetFolder, rawName);
		await editors.openProjectPage(snap.meta.project_id);
	}
});

registerAction2Safe(class OpenAdeProjectPageAction extends Action2 {
	constructor() {
		super({
			id: ADE_OPEN_PROJECT_PAGE_COMMAND_ID,
			title: localize2('adeOpenProjectPageTitle', "Open Project Page..."),
			icon: Codicon.typeHierarchySub,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, projectId?: string): Promise<void> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = accessor.get(IAdeEditorService);
		const quickInput = accessor.get(IQuickInputService);
		if (typeof projectId === 'string' && projectId.trim()) {
			await editors.openProjectPage(projectId.trim());
			return;
		}
		const pages = projects.projectPages;
		if (pages.length === 0) {
			return;
		}
		if (pages.length === 1) {
			await editors.openProjectPage(pages[0].projectId);
			return;
		}
		const picked = await quickInput.pick(pages.map(p => ({
			label: p.name,
			description: formatProjectDisplayPath(p.folderUri),
			projectId: p.projectId,
		})), {
			placeHolder: localize('adePickProjectPagePlaceholder', "Select a Project Page to open"),
			matchOnDescription: true,
		});
		if (picked) {
			await editors.openProjectPage(picked.projectId);
		}
	}
});

registerAction2Safe(class RenameAdeProjectPageAction extends Action2 {
	constructor() {
		super({
			id: ADE_RENAME_PROJECT_PAGE_COMMAND_ID,
			title: localize2('adeRenameProjectPageTitle', "Rename Project Page..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, projectId?: string, nextName?: string): Promise<string | undefined> {
		const projects = accessor.get(IAdeProjectsService);
		const editors = tryGetOptionalService<IAdeEditorService>(accessor, IAdeEditorService);
		const targetId = resolveTargetProjectPageId(projects, editors, projectId);
		if (!targetId) {
			return undefined;
		}
		return promptRenameAdeProjectPage(accessor, targetId, nextName);
	}
});

registerAction2Safe(class DeleteAdeProjectPageAction extends Action2 {
	constructor() {
		super({
			id: ADE_DELETE_PROJECT_PAGE_COMMAND_ID,
			title: localize2('adeDeleteProjectPageTitle', "Delete Project Page..."),
			icon: Codicon.trash,
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, projectId?: string, skipConfirm?: boolean): Promise<boolean> {
		return confirmAndDeleteAdeProjectPage(accessor, projectId, skipConfirm === true);
	}
});

registerAction2Safe(class ConfigureAdeProjectStorageAction extends Action2 {
	constructor() {
		super({
			id: ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID,
			title: localize2('adeConfigureProjectStorageTitle', "Configure Cross-Host Ticket Storage..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
		});
	}

	async run(accessor: ServicesAccessor, projectId?: string, targetHost?: string): Promise<string | undefined> {
		return configureAdeProjectTicketStorage(accessor, projectId, targetHost);
	}
});

registerAction2Safe(class RenameAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_RENAME_PROJECT_COMMAND_ID,
			title: localize2('adeRenameProjectFolderTitle', "Rename Workspace Folder Display Name..."),
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
			title: localize('adeRenameProjectTitle', "Rename Workspace Folder Display Name"),
			prompt: localize('adeRenameProjectPrompt', "Enter a custom display name for {0}", formatProjectDisplayPath(targetUri)),
			value: currentName,
		});
		if (!nextName?.trim() || nextName.trim() === currentName) {
			return;
		}
		if (projects.registerWorkspaceFolderAsync) {
			await projects.registerWorkspaceFolderAsync(targetUri, nextName.trim());
		} else {
			projects.registerProject(targetUri, nextName.trim());
		}
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
	}
});

registerAction2Safe(class RemoveAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_REMOVE_PROJECT_COMMAND_ID,
			title: localize2('adeRemoveProjectFolderTitle', "Remove Workspace Folder"),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI | readonly URI[]): Promise<void> {
		await removeProjectsSynchronized(accessor, uri);
	}
});

registerAction2Safe(class DeleteAdeProjectFolderAction extends Action2 {
	constructor() {
		super({
			id: ADE_DELETE_PROJECT_COMMAND_ID,
			title: localize2('adeDeleteProjectFolderTitle', "Delete Workspace Folder..."),
			f1: true,
			precondition: WorkbenchModeContext.isEqualTo('ade'),
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ADE_PROJECTS_VIEW_ID), group: '2_workspace', order: 2 },
		});
	}

	async run(accessor: ServicesAccessor, uri?: URI | readonly URI[], options?: { permanent?: boolean }): Promise<void> {
		await deleteProjectsWithModePrompt(accessor, 'ade', uri, options);
	}
});

registerAction2Safe(class DeleteIdeProjectFolderAction extends Action2 {
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

registerAction2Safe(class RefreshAgentProjectsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.ade.refresh',
			title: localize2('refreshAdeProjects', "Refresh Projects"),
			icon: Codicon.refresh,
			menu: { ...viewTitleMenu, order: 2 },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const view = accessor.get(IViewsService).getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
		if (view) {
			await view.refresh();
			return;
		}
		await accessor.get(IAdeProjectsService).refreshCatalog();
	}
});

if (!CommandsRegistry.getCommand('workbench.action.aexusCloudHosts.pickProjectFolders')) {
	CommandsRegistry.registerCommand(
		'workbench.action.aexusCloudHosts.pickProjectFolders',
		async (accessor: ServicesAccessor, options?: { readonly title?: string }) => {
			return pickProjectFoldersWithCloudOption(accessor, options);
		},
	);
}

registerAction2Safe(class ManageAdeCloudHostsAction extends Action2 {
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

registerAction2Safe(class AddAdeCloudProjectFolderAction extends Action2 {
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
		if (projects.registerWorkspaceFolderAsync) {
			await projects.registerWorkspaceFolderAsync(normalized, basename(normalized) || normalized.authority || 'project');
		} else {
			projects.registerProject(normalized, basename(normalized) || normalized.authority || 'project');
		}
		await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
		projects.selectProject(normalized);
	}
});

registerAction2Safe(class ImportVsCodeCloudHostsAction extends Action2 {
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

registerAction2Safe(class ToggleAdeAutonomousModeAction extends Action2 {
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
		const current = readTrustedApplicationConfigValue<boolean>(configurationService, 'aexus.ade.autonomousMode') !== false;
		const next = !current;
		await configurationService.updateValue('aexus.ade.autonomousMode', next, ConfigurationTarget.USER);
		notifications.info(next
			? localize('adeAutonomousModeEnabledNotice', "Aexus ADE switched to Full Access / Autonomous Mode (aexus.ade.autonomousMode = true).")
			: localize('adeSafeModeEnabledNotice', "Aexus ADE switched to Safe Mode (aexus.ade.autonomousMode = false)."));
	}
});

registerAction2Safe(class SwitchAdeDisplayLanguageAction extends Action2 {
	constructor() {
		super({
			id: ADE_SWITCH_DISPLAY_LANGUAGE_COMMAND_ID,
			title: localize2('adeSwitchDisplayLanguageTitle', "Switch ADE Display Language (Auto / English / Simplified Chinese)"),
			category: localize2('adeCategory', "Aexus ADE"),
			icon: Codicon.globe,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);
		const notifications = accessor.get(INotificationService);
		const current = getAdeDisplayLanguageSetting();
		const picked = await quickInput.pick([
			{
				value: 'auto' as const,
				label: adeBi(localize('adeLangPickAuto', "Auto (Follow VS Code Display Language)"), '自动（跟随 VS Code 显示语言）'),
				description: current === 'auto' ? adeBi(localize('adeLangCurrent', "Current"), '当前') : 'auto',
			},
			{
				value: 'en' as const,
				label: 'English (Pure English)',
				description: current === 'en' ? adeBi(localize('adeLangCurrent', "Current"), '当前') : 'en',
			},
			{
				value: 'zh-cn' as const,
				label: '简体中文 (Pure Simplified Chinese)',
				description: current === 'zh-cn' ? adeBi(localize('adeLangCurrent', "Current"), '当前') : 'zh-cn',
			},
		], {
			title: adeBi(localize('adeSwitchLangQuickTitle', "Aexus ADE Display Language"), 'Aexus ADE 界面显示语言'),
			placeHolder: adeBi(localize('adeSwitchLangQuickPh', "Choose pure English, pure Simplified Chinese, or follow VS Code locale"), '选择纯英文、纯简体中文，或自动跟随 VS Code 语言设置'),
		});
		if (!picked) {
			return;
		}
		setAdeDisplayLanguageOverride(picked.value);
		await configurationService.updateValue(ADE_DISPLAY_LANGUAGE_CONFIG_KEY, picked.value, ConfigurationTarget.USER);
		notifications.info(adeBi(
			localize('adeSwitchLangDone', "Aexus ADE display language updated to '{0}'."),
			'Aexus ADE 界面语言已切换为「{0}」。',
			picked.label,
		));
	}
});
