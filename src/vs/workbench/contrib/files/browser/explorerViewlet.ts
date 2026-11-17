/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/explorerviewlet.css';
import { localize, localize2 } from '../../../../nls.js';
import { mark } from '../../../../base/common/performance.js';
import { VIEWLET_ID, VIEW_ID, IFilesConfiguration, ExplorerViewletVisibleContext } from '../common/files.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ExplorerView } from './views/explorerView.js';
import { EmptyView } from './views/emptyView.js';
import { OpenEditorsView } from './views/openEditorsView.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IContextKeyService, IContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewsRegistry, IViewDescriptor, Extensions, ViewContainer, IViewContainersRegistry, ViewContainerLocation, IViewDescriptorService, ViewContentGroups } from '../../../common/views.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { KeyChord, KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { AddRootFolderAction } from '../../../browser/actions/workspaceActions.js';
import { ADD_ROOT_FOLDER_LABEL } from '../../../browser/actions/workspaceCommands.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { isMouseEvent } from '../../../../base/browser/dom.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { WorkbenchModeContext } from '../../../services/workbenchMode/common/workbenchMode.js';

const explorerViewIcon = registerIcon('explorer-view-icon', Codicon.files, localize('explorerViewIcon', 'View icon of the explorer view.'));
const openEditorsViewIcon = registerIcon('open-editors-view-icon', Codicon.book, localize('openEditorsIcon', 'View icon of the open editors view.'));

export class ExplorerViewletViewsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.explorerViewletViews';

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IProgressService progressService: IProgressService
	) {
		super();

		progressService.withProgress({ location: ProgressLocation.Explorer }, () => workspaceContextService.getCompleteWorkspace()).finally(() => {
			this.registerViews();

			this._register(workspaceContextService.onDidChangeWorkbenchState(() => this.registerViews()));
			this._register(workspaceContextService.onDidChangeWorkspaceFolders(() => this.registerViews()));
		});
	}

	private registerViews(): void {
		mark('code/willRegisterExplorerViews');

		const viewDescriptors = viewsRegistry.getViews(VIEW_CONTAINER);

		const viewDescriptorsToRegister: IViewDescriptor[] = [];
		const viewDescriptorsToDeregister: IViewDescriptor[] = [];

		const openEditorsViewDescriptor = this.createOpenEditorsViewDescriptor();
		if (!viewDescriptors.some(v => v.id === openEditorsViewDescriptor.id)) {
			viewDescriptorsToRegister.push(openEditorsViewDescriptor);
		}

		const explorerViewDescriptor = this.createExplorerViewDescriptor();
		const registeredExplorerViewDescriptor = viewDescriptors.find(v => v.id === explorerViewDescriptor.id);
		const emptyViewDescriptor = this.createEmptyViewDescriptor();
		const registeredEmptyViewDescriptor = viewDescriptors.find(v => v.id === emptyViewDescriptor.id);

		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY || this.workspaceContextService.getWorkspace().folders.length === 0) {
			if (registeredExplorerViewDescriptor) {
				viewDescriptorsToDeregister.push(registeredExplorerViewDescriptor);
			}
			if (!registeredEmptyViewDescriptor) {
				viewDescriptorsToRegister.push(emptyViewDescriptor);
			}
		} else {
			if (registeredEmptyViewDescriptor) {
				viewDescriptorsToDeregister.push(registeredEmptyViewDescriptor);
			}
			if (!registeredExplorerViewDescriptor) {
				viewDescriptorsToRegister.push(explorerViewDescriptor);
			}
		}

		if (viewDescriptorsToDeregister.length) {
			viewsRegistry.deregisterViews(viewDescriptorsToDeregister, VIEW_CONTAINER);
		}
		if (viewDescriptorsToRegister.length) {
			viewsRegistry.registerViews(viewDescriptorsToRegister, VIEW_CONTAINER);
		}

		mark('code/didRegisterExplorerViews');
	}

	private createOpenEditorsViewDescriptor(): IViewDescriptor {
		return {
			id: OpenEditorsView.ID,
			when: WorkbenchModeContext.isEqualTo('ide'),
			name: OpenEditorsView.NAME,
			ctorDescriptor: new SyncDescriptor(OpenEditorsView),
			containerIcon: openEditorsViewIcon,
			order: 0,
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: false,
			hideByDefault: true,
			focusCommand: {
				id: 'workbench.files.action.focusOpenEditorsView',
				keybindings: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyE) }
			}
		};
	}

	private createEmptyViewDescriptor(): IViewDescriptor {
		return {
			id: EmptyView.ID,
			when: WorkbenchModeContext.isEqualTo('ide'),
			name: EmptyView.NAME,
			containerIcon: explorerViewIcon,
			ctorDescriptor: new SyncDescriptor(EmptyView),
			order: 1,
			canMoveView: true,
			canToggleVisibility: true,
			focusCommand: {
				id: 'workbench.explorer.fileView.focus'
			}
		};
	}

	private createExplorerViewDescriptor(): IViewDescriptor {
		return {
			id: VIEW_ID,
			when: WorkbenchModeContext.isEqualTo('ide'),
			name: localize2('projects', "Projects"),
			containerIcon: explorerViewIcon,
			ctorDescriptor: new SyncDescriptor(ExplorerView),
			order: 1,
			canMoveView: true,
			canToggleVisibility: false,
			focusCommand: {
				id: 'workbench.explorer.fileView.focus'
			}
		};
	}
}

export class ExplorerViewPaneContainer extends ViewPaneContainer {

	private viewletVisibleContextKey: IContextKey<boolean>;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@ILogService logService: ILogService,
	) {

		super(VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }, instantiationService, configurationService, layoutService, contextMenuService, telemetryService, extensionService, themeService, storageService, contextService, viewDescriptorService, logService);

		this.viewletVisibleContextKey = ExplorerViewletVisibleContext.bindTo(contextKeyService);
		this._register(this.contextService.onDidChangeWorkspaceName(e => this.updateTitleArea()));
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		parent.classList.add('explorer-viewlet');
	}

	protected override createView(viewDescriptor: IViewDescriptor, options: IViewletViewOptions): ViewPane {
		if (viewDescriptor.id === VIEW_ID) {
			return this.instantiationService.createInstance(ExplorerView, {
				...options, delegate: {
					willOpenElement: e => {
						if (!isMouseEvent(e)) {
							return; // only delay when user clicks
						}

						const openEditorsView = this.getOpenEditorsView();
						if (openEditorsView) {
							let delay = 0;

							const config = this.configurationService.getValue<IFilesConfiguration>();
							if (config.workbench?.editor?.enablePreview) {
								// delay open editors view when preview is enabled
								// to accomodate for the user doing a double click
								// to pin the editor.
								// without this delay a double click would be not
								// possible because the next element would move
								// under the mouse after the first click.
								delay = 250;
							}

							openEditorsView.setStructuralRefreshDelay(delay);
						}
					},
					didOpenElement: e => {
						if (!isMouseEvent(e)) {
							return; // only delay when user clicks
						}

						const openEditorsView = this.getOpenEditorsView();
						openEditorsView?.setStructuralRefreshDelay(0);
					}
				}
			});
		}
		return super.createView(viewDescriptor, options);
	}

	getExplorerView(): ExplorerView {
		return <ExplorerView>this.getView(VIEW_ID);
	}

	getOpenEditorsView(): OpenEditorsView {
		return <OpenEditorsView>this.getView(OpenEditorsView.ID);
	}

	override setVisible(visible: boolean): void {
		this.viewletVisibleContextKey.set(visible);
		super.setVisible(visible);
	}

	override focus(): void {
		const explorerView = this.getView(VIEW_ID);
		if (explorerView && this.panes.every(p => !p.isExpanded())) {
			explorerView.setExpanded(true);
		}
		if (explorerView?.isExpanded()) {
			explorerView.focus();
		} else {
			super.focus();
		}
	}
}

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);

/**
 * Explorer viewlet container.
 */
export const VIEW_CONTAINER: ViewContainer = viewContainerRegistry.registerViewContainer({
	id: VIEWLET_ID,
	title: localize2('projects', "Projects"),
	ctorDescriptor: new SyncDescriptor(ExplorerViewPaneContainer),
	storageId: 'workbench.explorer.views.state',
	icon: explorerViewIcon,
	alwaysUseContainerInfo: true,
	hideIfEmpty: true,
	order: 0,
	openCommandActionDescriptor: {
		id: VIEWLET_ID,
		title: localize2('projects', "Projects"),
		mnemonicTitle: localize({ key: 'miViewProjects', comment: ['&& denotes a mnemonic'] }, "&&Projects"),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE },
		order: 0
	},
}, ViewContainerLocation.Sidebar, { isDefault: true });

for (const view of [VIEW_ID, EmptyView.ID]) {
	MenuRegistry.appendMenuItem(MenuId.ViewTitle, {
		command: { id: AddRootFolderAction.ID, title: ADD_ROOT_FOLDER_LABEL, icon: Codicon.add },
		when: ContextKeyExpr.equals('view', view),
		group: 'navigation',
		order: 0
	});
}

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
viewsRegistry.registerViewWelcomeContent(EmptyView.ID, {
	content: localize({ key: 'noProjectsHelp', comment: ['Please do not translate the word "command", it is part of our internal syntax which must not change'] },
		"Add project folders here, then expand any project to start working.\n{0}", `[${localize('addProjects', "Add Projects")}](command:${AddRootFolderAction.ID})`),
	group: ViewContentGroups.Open,
	order: 1
});
