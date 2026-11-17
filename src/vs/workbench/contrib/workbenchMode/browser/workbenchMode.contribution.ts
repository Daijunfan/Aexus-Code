/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ExtensionIdentifier, ExtensionIdentifierSet } from '../../../../platform/extensions/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions, ICustomViewDescriptor, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { isCodingAgentExtension, isKnownCodingAgentId } from '../../../services/extensions/common/codingAgentExtensions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchModeService, WorkbenchModeViewContainers } from '../../../services/workbenchMode/common/workbenchMode.js';
import { ADE_INSPECTOR_CONTAINER_ID, IAdeProjectsService } from '../../ade/common/ade.js';
import { ChatViewId } from '../../chat/browser/chat.js';
import { ExtensionState, IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';

const primaryViews = new Set(['workbench.explorer.fileView', 'workbench.explorer.emptyView', 'workbench.explorer.openEditorsView']);
const selectPluginProjectCommand = 'workbench.action.aexus.selectPluginProject';

function getActivePluginOwner(descriptors: IViewDescriptorService, panes: IPaneCompositePartService): ExtensionIdentifier | undefined {
	const active = panes.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
	const container = active && descriptors.getViewContainerById(active.getId());
	return container?.extensionId ?? (container ? descriptors.getViewContainerModel(container).activeViewDescriptors
		.map(view => (view as ICustomViewDescriptor).extensionId).find(owner => !!owner) : undefined);
}

/** Shows the current plugin's real project binding alongside the shared plugin switcher. */
export class PluginSidebarProjectContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.aexusPluginSidebarProject';
	private readonly projectMenu = this._register(new MutableDisposable());

	constructor(
		@IProjectNavigationService private readonly projects: IProjectNavigationService,
		@IAdeProjectsService private readonly adeProjects: IAdeProjectsService,
		@IWorkbenchModeService private readonly modes: IWorkbenchModeService,
		@IPaneCompositePartService private readonly panes: IPaneCompositePartService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IWorkbenchEnvironmentService environment: IWorkbenchEnvironmentService,
	) {
		super();
		if (environment.isSessionsWindow) {
			return;
		}
		this._register(Event.any(
			projects.onDidChangeSelectedProject,
			projects.onDidChangeProject,
			projects.onDidBindCodingAgentProject,
			projects.onDidChangeProjectOrder,
			adeProjects.onDidChange,
			modes.onDidChangeMode,
			panes.onDidPaneCompositeOpen,
			panes.onDidPaneCompositeClose,
		)(() => this.updateProject()));
		this.updateProject();
	}

	private updateProject(): void {
		const owner = getActivePluginOwner(this.descriptors, this.panes);
		const binding = owner && this.projects.codingAgentProjects.get(ExtensionIdentifier.toKey(owner));
		const ideProject = binding ? this.projects.orderedProjects.find(project => project.uri.toString() === binding.toString()) : this.projects.selectedProject;
		const project = this.modes.mode === 'ide'
			? ideProject && { name: ideProject.name, uri: ideProject.uri }
			: (this.projects.focusedProject ?? this.adeProjects.selectedProject ?? this.projects.selectedProject);
		this.projectMenu.value = MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {
			command: {
				id: selectPluginProjectCommand,
				title: project?.name ?? localize('noPluginProject', "No Project"),
				tooltip: project
					? localize('pluginProject', "Plugin Project: {0}\n{1}\nSelect Project", project.name, project.uri.fsPath)
					: localize('selectPluginProject', "Select a project for the plugin sidebar"),
			},
			group: 'navigation',
			order: -1,
			when: IsSessionsWindowContext.negate(),
		});
	}
}

registerWorkbenchContribution2(PluginSidebarProjectContribution.ID, PluginSidebarProjectContribution, WorkbenchPhase.AfterRestored);

function isCodingAgentContainer(container: ViewContainer, descriptors: IViewDescriptorService, codingAgents: ExtensionIdentifierSet): boolean {
	if (container.extensionId && codingAgents.has(container.extensionId)) {
		return true;
	}
	const views = descriptors.getViewContainerModel(container).allViewDescriptors;
	if (views.some(view => view.id === ChatViewId)) {
		return true;
	}
	return views.length > 0 && views.every(view => {
		const extensionId = (view as ICustomViewDescriptor).extensionId;
		return !!extensionId && codingAgents.has(extensionId);
	});
}

export class WorkbenchModeLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.aexusWorkbenchMode';
	private routing = false;
	private lastIdeAuxiliaryContainerId: string | undefined;

	constructor(
		@IWorkbenchModeService private readonly modeService: IWorkbenchModeService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IProjectNavigationService projects: IProjectNavigationService,
	) {
		super();
		if (environmentService.isSessionsWindow) {
			return;
		}
		this.routePluginViews();
		this._register(viewDescriptorService.onDidChangeViewContainers(() => this.routePluginViews()));
		this._register(Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).onViewsRegistered(() => this.routePluginViews()));
		this._register(modeService.onDidChangeMode(() => this.showProjectView()));
		this._register(viewsService.onDidChangeViewVisibility(({ id, visible }) => {
			const owner = (viewDescriptorService.getViewDescriptorById(id) as ICustomViewDescriptor | undefined)?.extensionId;
			if (!visible || modeService.mode !== 'ide' || !owner || projects.codingAgentProjects.has(ExtensionIdentifier.toKey(owner))) {
				return;
			}
			if (extensionService.extensions.some(extension => ExtensionIdentifier.equals(extension.identifier, owner) && isCodingAgentExtension(extension))) {
				projects.bindCodingAgentProject(ExtensionIdentifier.toKey(owner));
			}
		}));
		extensionService.whenInstalledExtensionsRegistered().then(() => this.routePluginViews());
		this.showProjectView();
		if (modeService.mode !== 'ade' && !paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)) {
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		}
	}

	private routePluginViews(): void {
		if (this.routing) {
			return;
		}
		this.routing = true;
		try {
			for (const container of this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Sidebar)) {
				if (container.id === WorkbenchModeViewContainers.ade) {
					continue;
				}
				if (container.id !== WorkbenchModeViewContainers.ide) {
					this.viewDescriptorService.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, WorkbenchModeLayoutContribution.ID);
					continue;
				}
				for (const view of this.viewDescriptorService.getViewContainerModel(container).allViewDescriptors) {
					if (!primaryViews.has(view.id)) {
						this.viewDescriptorService.moveViewToLocation(view, ViewContainerLocation.AuxiliaryBar, WorkbenchModeLayoutContribution.ID);
					}
				}
			}
		} finally {
			this.routing = false;
		}
	}

	private showProjectView(): void {
		this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		const active = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		const activeId = active?.getId();
		if (this.modeService.mode === 'ade') {
			if (activeId && activeId !== ADE_INSPECTOR_CONTAINER_ID) {
				this.lastIdeAuxiliaryContainerId = activeId;
			}
			const container = activeId ? this.viewDescriptorService.getViewContainerById(activeId) : undefined;
			const codingAgents = new ExtensionIdentifierSet(this.extensionService.extensions.filter(isCodingAgentExtension).map(extension => extension.identifier));
			if (!activeId || activeId === ADE_INSPECTOR_CONTAINER_ID || (container && isCodingAgentContainer(container, this.viewDescriptorService, codingAgents))) {
				this.layoutService.setPartHidden(false, Parts.AUXILIARYBAR_PART);
				void this.viewsService.openViewContainer(ADE_INSPECTOR_CONTAINER_ID, false);
			}
		} else {
			if (activeId === ADE_INSPECTOR_CONTAINER_ID) {
				if (this.lastIdeAuxiliaryContainerId) {
					void this.viewsService.openViewContainer(this.lastIdeAuxiliaryContainerId, false);
				} else {
					this.paneCompositeService.hideActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
				}
			}
		}
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		void this.viewsService.openViewContainer(WorkbenchModeViewContainers[this.modeService.mode], false);
	}
}

registerWorkbenchContribution2(WorkbenchModeLayoutContribution.ID, WorkbenchModeLayoutContribution, WorkbenchPhase.AfterRestored);

const panelLessAgentLaunchCommands = new Map<string, string>([
	['sst-dev.opencode', 'opencode.openNewTerminal'],
	['pi0.pi-vscode', 'pi-vscode.open'],
]);

registerAction2(class ShowPluginsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.aexus.showPlugins',
			title: localize2('plugins', "Plugins"),
			icon: Codicon.extensions,
			f1: true,
			menu: [
				{ id: MenuId.TitleBar, group: TitleBarLeadingActionsGroup, order: 0 },
				{ id: MenuId.AuxiliaryBarTitle, group: 'navigation', order: 0, when: IsSessionsWindowContext.negate() },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const descriptors = accessor.get(IViewDescriptorService);
		const viewsService = accessor.get(IViewsService);
		const quickInputService = accessor.get(IQuickInputService);
		const modeService = accessor.get(IWorkbenchModeService);
		const extensionService = accessor.get(IExtensionService);
		const extensionsWorkbenchService = accessor.get(IExtensionsWorkbenchService);
		const projects = accessor.get(IProjectNavigationService);
		const adeProjects = accessor.get(IAdeProjectsService);
		const commandService = accessor.get(ICommandService);
		const [installed] = await Promise.all([extensionsWorkbenchService.queryLocal(), extensionService.whenInstalledExtensionsRegistered()]);
		const codingAgents = new ExtensionIdentifierSet(extensionService.extensions.filter(isCodingAgentExtension).map(extension => extension.identifier));
		const containersRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
		const seen = new ExtensionIdentifierSet();
		const picks = installed
			.filter(extension => !extension.isBuiltin && extension.state === ExtensionState.Installed)
			.filter(extension => {
				if (seen.has(extension.identifier.id)) {
					return false;
				}
				seen.add(extension.identifier.id);
				return true;
			})
			.map(extension => {
				const containers = descriptors.viewContainers.filter(container =>
					(container.extensionId && ExtensionIdentifier.equals(container.extensionId, extension.identifier.id))
					|| descriptors.getViewContainerModel(container).allViewDescriptors.some(view => ExtensionIdentifier.equals((view as ICustomViewDescriptor).extensionId, extension.identifier.id))
				);
				containers.sort((a, b) => Number(descriptors.getViewContainerModel(b).activeViewDescriptors.length > 0) - Number(descriptors.getViewContainerModel(a).activeViewDescriptors.length > 0)
					|| Number(containersRegistry.getViewContainerLocation(b) === ViewContainerLocation.AuxiliaryBar) - Number(containersRegistry.getViewContainerLocation(a) === ViewContainerLocation.AuxiliaryBar)
					|| Number(descriptors.getViewContainerLocation(b) === ViewContainerLocation.AuxiliaryBar) - Number(descriptors.getViewContainerLocation(a) === ViewContainerLocation.AuxiliaryBar));
				const container = containers[0];
				const isAgent = codingAgents.has(extension.identifier.id) || isKnownCodingAgentId(extension.identifier.id);
				const icon = container ? descriptors.getViewContainerModel(container).icon : Codicon.extensions;
				const iconUri = extension.iconUrl ? URI.parse(extension.iconUrl) : URI.isUri(icon) ? icon : undefined;
				return {
					label: extension.displayName || extension.name,
					description: isAgent
						? localize('codingAgentPluginDescription', "Coding Agent · {0}", extension.identifier.id)
						: extension.identifier.id,
					extension,
					container,
					isAgent,
					iconClass: !iconUri && ThemeIcon.isThemeIcon(icon) ? ThemeIcon.asClassName(icon) : undefined,
					iconPath: iconUri ? { dark: iconUri, light: iconUri } : undefined,
				};
			})
			.sort((a, b) =>
				Number(b.isAgent) - Number(a.isAgent)
				|| (a.isAgent ? Number(Boolean(b.container)) - Number(Boolean(a.container)) : 0)
				|| a.label.localeCompare(b.label)
			);
		const project = modeService.mode === 'ide' ? projects.selectedProject?.name : adeProjects.selectedProject?.name;
		const pick = await quickInputService.pick(picks, {
			placeHolder: project
				? localize('openInstalledPluginForProject', "Open an installed plugin for {0}", project)
				: localize('openInstalledPlugin', "Open an installed plugin"),
			matchOnDescription: true,
		});
		if (pick) {
			if (!pick.container) {
				const launchCmd = panelLessAgentLaunchCommands.get(pick.extension.identifier.id.toLowerCase());
				if (launchCmd && (CommandsRegistry.getCommand(launchCmd) || extensionService.extensions.some(ext => ExtensionIdentifier.equals(ext.identifier, pick.extension.identifier.id)))) {
					if (modeService.mode === 'ide' && pick.isAgent) {
						projects.bindCodingAgentProject(pick.extension.identifier.id.toLowerCase());
					}
					await commandService.executeCommand(launchCmd);
					return;
				}
				await extensionsWorkbenchService.open(pick.extension);
				return;
			}
			if (modeService.mode === 'ide' && pick.isAgent) {
				projects.bindCodingAgentProject(pick.extension.identifier.id.toLowerCase());
			}
			if (pick.container.extensionId && ExtensionIdentifier.equals(pick.container.extensionId, pick.extension.identifier.id)) {
				descriptors.moveViewContainerToLocation(pick.container, ViewContainerLocation.AuxiliaryBar, undefined, 'workbench.action.aexus.showPlugins');
				await viewsService.openViewContainer(pick.container.id, true);
			} else {
				const view = descriptors.getViewContainerModel(pick.container).allViewDescriptors.find(item => ExtensionIdentifier.equals((item as ICustomViewDescriptor).extensionId, pick.extension.identifier.id));
				if (view) {
					descriptors.moveViewToLocation(view, ViewContainerLocation.AuxiliaryBar, 'workbench.action.aexus.showPlugins');
					await viewsService.openView(view.id, true);
				}
			}
		}
	}
});

registerAction2(class SelectPluginProjectAction extends Action2 {
	constructor() {
		super({ id: selectPluginProjectCommand, title: localize2('selectPluginProjectTitle', "Select Plugin Project"), f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const projects = accessor.get(IProjectNavigationService);
		const modes = accessor.get(IWorkbenchModeService);
		const ide = modes.mode === 'ide';
		const adeProjects = accessor.get(IAdeProjectsService);
		const descriptors = accessor.get(IViewDescriptorService);
		const panes = accessor.get(IPaneCompositePartService);
		const extensions = accessor.get(IExtensionService);
		const quickInput = accessor.get(IQuickInputService);
		const picks = ide
			? projects.orderedProjects.map(project => ({ label: project.name, description: project.uri.fsPath, uri: project.uri }))
			: adeProjects.projects.map(project => ({ label: project.name, description: project.uri.fsPath, uri: project.uri }));
		const pick = await quickInput.pick(picks, { placeHolder: localize('selectPluginProjectPicker', "Select the project for the plugin sidebar"), matchOnDescription: true });
		if (!pick) {
			return;
		}
		if (!ide) {
			if (projects.focusedProject) {
				projects.enterProject(pick.uri);
			}
			adeProjects.selectProject(pick.uri);
			return;
		}
		if (projects.focusedProject) {
			projects.enterProject(pick.uri);
		} else {
			projects.selectProject(pick.uri);
		}
		const owner = getActivePluginOwner(descriptors, panes);
		if (owner && extensions.extensions.some(extension => ExtensionIdentifier.equals(extension.identifier, owner) && isCodingAgentExtension(extension))) {
			projects.bindCodingAgentProject(ExtensionIdentifier.toKey(owner));
		}
	}
});
