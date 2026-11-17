/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { $, addDisposableListener, append, EventHelper, EventType } from '../../../../base/browser/dom.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeNode, ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { Separator, toAction } from '../../../../base/common/actions.js';
import { Sequencer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, joinPath, relativePath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { RedoCommand, UndoCommand } from '../../../../editor/browser/editorExtensions.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultCountBadgeStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { createFileIconThemableTreeContainerScope, IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { API_OPEN_DIFF_EDITOR_COMMAND_ID, API_OPEN_EDITOR_COMMAND_ID } from '../../../browser/parts/editor/editorCommands.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ISCMRepository, ISCMResource, ISCMResourceGroup, ISCMService } from '../../scm/common/scm.js';
import { IAdeEditorService, IAdeProject, IAdeProjectsService } from '../common/ade.js';
import { AdeFileActions } from './adeFileActions.js';

export function findProjectScmRepository(scmService: ISCMService, uriIdentityService: IUriIdentityService, projectUri: URI): ISCMRepository | undefined {
	let best: ISCMRepository | undefined;
	let bestLength = -1;
	for (const repo of scmService.repositories) {
		const rootUri = repo.provider.rootUri;
		if (rootUri && uriIdentityService.extUri.isEqualOrParent(projectUri, rootUri)) {
			if (rootUri.path.length > bestLength) {
				best = repo;
				bestLength = rootUri.path.length;
			}
		}
	}
	return best;
}

export async function openScmResourceInAde(adeEditors: IAdeEditorService, resource: ISCMResource, projectUri: URI, options?: IEditorOptions): Promise<void> {
	const command = resource.command;
	const args = command?.arguments;
	if ((command?.id === API_OPEN_DIFF_EDITOR_COMMAND_ID || command?.id === 'vscode.diff') && Array.isArray(args) && args.length >= 2 && args[0] && args[1]) {
		const original = URI.revive(args[0] as UriComponents);
		const modified = URI.revive(args[1] as UriComponents);
		const rawTitle = args[2];
		const titleCandidate = rawTitle && typeof rawTitle === 'object' ? (rawTitle as { readonly label?: unknown }).label : undefined;
		const label = typeof rawTitle === 'string'
			? rawTitle
			: (typeof titleCandidate === 'string' ? titleCandidate : undefined);
		await adeEditors.openDiff(original, modified, label, projectUri, options);
		return;
	}
	if ((command?.id === API_OPEN_EDITOR_COMMAND_ID || command?.id === 'vscode.open') && Array.isArray(args) && args[0]) {
		const target = URI.revive(args[0] as UriComponents);
		await adeEditors.openFile(target, projectUri, options);
		return;
	}
	if (resource.multiDiffEditorOriginalUri && resource.multiDiffEditorModifiedUri) {
		await adeEditors.openDiff(resource.multiDiffEditorOriginalUri, resource.multiDiffEditorModifiedUri, undefined, projectUri, options);
		return;
	}
	const original = await resource.resourceGroup.provider.getOriginalResource(resource.sourceUri);
	if (original && !resource.decorations.strikeThrough) {
		await adeEditors.openDiff(original, resource.sourceUri, localize('adeWorkingTreeDiff', "{0} (Working Tree)", basename(resource.sourceUri)), projectUri, options);
		return;
	}
	if (original && resource.decorations.strikeThrough) {
		await adeEditors.openFile(original, projectUri, options);
		return;
	}
	await adeEditors.openFile(resource.sourceUri, projectUri, options);
}

type AdeChangeTreeItem =
	| { readonly kind: 'group'; readonly group: ISCMResourceGroup; readonly resources: readonly ISCMResource[] }
	| { readonly kind: 'resource'; readonly resource: ISCMResource; readonly projectUri: URI };

interface IChangeGroupTemplate {
	readonly label: HTMLElement;
	readonly badge: CountBadge;
}

interface IChangeResourceTemplate {
	readonly row: HTMLElement;
	readonly fileLabel: IResourceLabel;
	readonly openFileButton: HTMLElement;
	readonly decorationIcon: HTMLElement;
	readonly elementDisposables: DisposableStore;
	readonly templateDisposables: DisposableStore;
}

class AdeChangeGroupRenderer implements ITreeRenderer<AdeChangeTreeItem, FuzzyScore, IChangeGroupTemplate> {
	readonly templateId = 'ade-change-group';

	renderTemplate(container: HTMLElement): IChangeGroupTemplate {
		const row = append(container, $('.ade-scm-group-row'));
		const label = append(row, $('span.ade-scm-group-name'));
		const badgeHost = append(row, $('span.ade-scm-group-count'));
		const badge = new CountBadge(badgeHost, {}, defaultCountBadgeStyles);
		return { label, badge };
	}

	renderElement(node: ITreeNode<AdeChangeTreeItem, FuzzyScore>, _index: number, template: IChangeGroupTemplate): void {
		if (node.element.kind !== 'group') {
			return;
		}
		template.label.textContent = node.element.group.label;
		template.badge.setCount(node.element.resources.length);
	}

	disposeTemplate(template: IChangeGroupTemplate): void {
		template.badge.dispose();
	}
}

class AdeChangeResourceRenderer implements ITreeRenderer<AdeChangeTreeItem, FuzzyScore, IChangeResourceTemplate> {
	readonly templateId = 'ade-change-resource';

	constructor(
		private readonly labels: ResourceLabels,
		private readonly themeService: IThemeService,
		private readonly hoverService: IHoverService,
		private readonly onOpenFile: (resource: ISCMResource, projectUri: URI) => void,
	) { }

	renderTemplate(container: HTMLElement): IChangeResourceTemplate {
		const templateDisposables = new DisposableStore();
		const row = append(container, $('.ade-scm-resource-row'));
		const labelHost = append(row, $('.ade-scm-resource-label'));
		const fileLabel = templateDisposables.add(this.labels.create(labelHost, { supportHighlights: true, supportDescriptionHighlights: true }));
		const openFileButton = append(row, $('button.ade-icon-button.ade-scm-open-file', {
			type: 'button',
			'aria-label': localize('adeOpenChangedFile', "Open File"),
		}));
		openFileButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.goToFile));
		templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), openFileButton, localize('adeOpenChangedFile', "Open File")));
		const decorationIcon = append(row, $('span.ade-scm-decoration-icon'));
		return {
			row,
			fileLabel,
			openFileButton,
			decorationIcon,
			elementDisposables: new DisposableStore(),
			templateDisposables,
		};
	}

	renderElement(node: ITreeNode<AdeChangeTreeItem, FuzzyScore>, _index: number, template: IChangeResourceTemplate): void {
		template.elementDisposables.clear();
		if (node.element.kind !== 'resource') {
			return;
		}
		const { resource, projectUri } = node.element;
		const uri = resource.sourceUri;
		const rel = relativePath(projectUri, uri);
		const relDir = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined;
		const theme = this.themeService.getColorTheme();
		const icon = isDark(theme.type) ? (resource.decorations.iconDark ?? resource.decorations.icon) : resource.decorations.icon;
		const tooltip = resource.decorations.tooltip ?? '';

		template.row.classList.toggle('faded', Boolean(resource.decorations.faded));
		template.fileLabel.setResource({
			resource: uri,
			name: basename(uri),
			description: relDir,
		}, {
			fileKind: FileKind.FILE,
			strikethrough: resource.decorations.strikeThrough,
			title: tooltip ? `${uri.fsPath} • ${tooltip}` : uri.fsPath,
			fileDecorations: { colors: false, badges: !icon },
		});

		template.elementDisposables.add(addDisposableListener(template.openFileButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.onOpenFile(resource, projectUri);
		}));

		if (icon) {
			if (ThemeIcon.isThemeIcon(icon)) {
				template.decorationIcon.className = `ade-scm-decoration-icon ${ThemeIcon.asClassName(icon)}`;
				template.decorationIcon.style.color = icon.color ? (theme.getColor(icon.color.id)?.toString() ?? '') : '';
				template.decorationIcon.style.backgroundImage = '';
			} else {
				template.decorationIcon.className = 'ade-scm-decoration-icon';
				template.decorationIcon.style.color = '';
				template.decorationIcon.style.backgroundImage = asCSSUrl(icon);
			}
			template.decorationIcon.style.display = '';
			template.elementDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.decorationIcon, tooltip));
		} else {
			template.decorationIcon.className = 'ade-scm-decoration-icon';
			template.decorationIcon.style.color = '';
			template.decorationIcon.style.backgroundImage = '';
			template.decorationIcon.style.display = 'none';
		}
	}

	disposeElement(_node: ITreeNode<AdeChangeTreeItem, FuzzyScore>, _index: number, template: IChangeResourceTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: IChangeResourceTemplate): void {
		template.elementDisposables.dispose();
		template.templateDisposables.dispose();
	}
}

export class AdeChangesView extends ViewPane {
	private tree: WorkbenchAsyncDataTree<AdeChangeTreeItem[], AdeChangeTreeItem, FuzzyScore> | undefined;
	private treeContainer: HTMLElement | undefined;
	private emptyContainer: HTMLElement | undefined;
	private readonly repoDisposables = this._register(new DisposableStore());
	private readonly triedGitOpen = new Set<string>();
	private readonly refreshQueue = new Sequencer();
	private currentRepository: ISCMRepository | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IAdeProjectsService private readonly adeProjects: IAdeProjectsService,
		@IAdeEditorService private readonly adeEditors: IAdeEditorService,
		@ISCMService private readonly scmService: ISCMService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ILabelService private readonly labelService: ILabelService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(Event.any(
			projectNavigation.onDidChangeProject,
			projectNavigation.onDidChangeSelectedProject,
			adeProjects.onDidChange,
			scmService.onDidAddRepository,
			scmService.onDidRemoveRepository,
			themeService.onDidColorThemeChange,
		)(() => {
			void this.refresh();
		}));
	}

	private getActiveProject(): IAdeProject | undefined {
		const active = this.projectNavigation.focusedProject
			?? this.projectNavigation.selectedProject
			?? this.adeProjects.selectedProject;
		return active ? { uri: active.uri, name: active.name } : undefined;
	}

	private async openBackingFile(resource: ISCMResource, projectUri: URI): Promise<void> {
		if (resource.decorations.strikeThrough && !(await this.fileService.exists(resource.sourceUri))) {
			const original = await resource.resourceGroup.provider.getOriginalResource(resource.sourceUri);
			if (original) {
				await this.adeEditors.openFile(original, projectUri);
				return;
			}
		}
		await this.adeEditors.openFile(resource.sourceUri, projectUri);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-inspector-view-body');
		this.emptyContainer = append(container, $('.ade-inspector-empty'));
		const treeContainer = this.treeContainer = append(container, $('.ade-changes-tree.explorer-folders-view'));
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));
		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));

		const tree = this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<AdeChangeTreeItem[], AdeChangeTreeItem, FuzzyScore>,
			'AdeChanges',
			treeContainer,
			{
				getHeight: () => 22,
				getTemplateId: item => item.kind === 'group' ? 'ade-change-group' : 'ade-change-resource',
			},
			[
				new AdeChangeGroupRenderer(),
				new AdeChangeResourceRenderer(labels, this.themeService, this.hoverService, (resource, projectUri) => {
					void this.openBackingFile(resource, projectUri);
				}),
			],
			{
				hasChildren: item => Array.isArray(item) || item.kind === 'group',
				getChildren: item => Array.isArray(item)
					? item
					: item.kind === 'group'
						? item.resources.map(resource => ({ kind: 'resource' as const, resource, projectUri: this.getActiveProject()?.uri ?? resource.sourceUri }))
						: [],
			},
			{
				identityProvider: {
					getId: item => item.kind === 'group'
						? `group:${item.group.provider.id}:${item.group.id}`
						: `resource:${item.resource.resourceGroup.provider.id}:${item.resource.resourceGroup.id}:${item.resource.sourceUri.toString()}`,
				},
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('adeChangesAria', "Project Changes"),
					getAriaLabel: item => item.kind === 'group' ? item.group.label : basename(item.resource.sourceUri),
				},
				renderIndentGuides: RenderIndentGuides.Always,
				indent: 12,
				multipleSelectionSupport: false,
			},
		));

		this._register(tree.onDidOpen(event => {
			if (event.element?.kind === 'resource') {
				void openScmResourceInAde(this.adeEditors, event.element.resource, event.element.projectUri, event.editorOptions);
			}
		}));

		this._register(tree.onContextMenu(event => {
			if (event.element?.kind !== 'resource') {
				return;
			}
			const { resource, projectUri } = event.element;
			tree.setFocus([event.element]);
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.anchor,
				getActions: () => [
					toAction({
						id: 'ade.changes.openDiff',
						label: localize('adeOpenChanges', "Open Changes"),
						run: () => openScmResourceInAde(this.adeEditors, resource, projectUri),
					}),
					toAction({
						id: 'ade.changes.openFile',
						label: localize('adeOpenFile', "Open File"),
						run: () => this.openBackingFile(resource, projectUri),
					}),
					new Separator(),
					toAction({
						id: 'ade.changes.copyPath',
						label: localize('copyPath', "Copy Path"),
						run: () => this.clipboardService.writeText(this.labelService.getUriLabel(resource.sourceUri, { noPrefix: true })),
					}),
					toAction({
						id: 'ade.changes.copyRelativePath',
						label: localize('copyRelativePath', "Copy Relative Path"),
						run: () => this.clipboardService.writeText(relativePath(projectUri, resource.sourceUri) ?? basename(resource.sourceUri)),
					}),
				],
			});
		}));

		void this.refresh();
	}

	private bindRepositoryListeners(repository: ISCMRepository | undefined): void {
		if (this.currentRepository === repository) {
			return;
		}
		this.currentRepository = repository;
		this.repoDisposables.clear();
		if (!repository) {
			return;
		}
		const bindGroups = () => {
			for (const group of repository.provider.groups) {
				this.repoDisposables.add(group.onDidChange(() => { void this.refresh(); }));
				this.repoDisposables.add(group.onDidChangeResources(() => { void this.refresh(); }));
			}
		};
		this.repoDisposables.add(repository.provider.onDidChangeResourceGroups(() => {
			this.currentRepository = undefined;
			this.bindRepositoryListeners(repository);
			void this.refresh();
		}));
		this.repoDisposables.add(repository.provider.onDidChangeResources(() => { void this.refresh(); }));
		bindGroups();
	}

	async refresh(): Promise<void> {
		await this.refreshQueue.queue(async () => {
			if (!this.tree || !this.emptyContainer || !this.treeContainer) {
				return;
			}
			const project = this.getActiveProject();
			if (!project) {
				this.bindRepositoryListeners(undefined);
				this.emptyContainer.textContent = localize('adeSelectProjectForChanges', "Select a project to view changes");
				this.emptyContainer.hidden = false;
				this.treeContainer.hidden = true;
				await this.tree.setInput([]);
				return;
			}

			let repository = findProjectScmRepository(this.scmService, this.uriIdentityService, project.uri);
			if (!repository && project.uri.scheme === Schemas.file) {
				const key = this.uriIdentityService.extUri.getComparisonKey(project.uri);
				if (!this.triedGitOpen.has(key)) {
					this.triedGitOpen.add(key);
					void this.extensionService.whenInstalledExtensionsRegistered().then(async () => {
						try {
							await this.commandService.executeCommand('git.openRepository', project.uri.fsPath);
						} catch {
							// Git extension may not be installed or folder may not be a repository.
						}
					});
				}
			}

			repository = findProjectScmRepository(this.scmService, this.uriIdentityService, project.uri);
			this.bindRepositoryListeners(repository);

			const groups: AdeChangeTreeItem[] = [];
			let totalResources = 0;
			for (const group of repository?.provider.groups ?? []) {
				const resources = group.resources.filter(item => this.uriIdentityService.extUri.isEqualOrParent(item.sourceUri, project.uri));
				totalResources += resources.length;
				if (resources.length > 0 || !group.hideWhenEmpty) {
					groups.push({ kind: 'group', group, resources });
				}
			}

			if (totalResources === 0) {
				this.emptyContainer.textContent = localize('adeNoChangesInProject', "No changes in {0}", project.name);
				this.emptyContainer.hidden = false;
				this.treeContainer.hidden = true;
				await this.tree.setInput([]);
				return;
			}

			this.emptyContainer.hidden = true;
			this.treeContainer.hidden = false;
			await this.tree.setInput(groups);
			for (const group of groups) {
				await this.tree.expand(group);
			}
		});
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override focus(): void {
		this.tree?.domFocus();
	}
}

interface IAdeFileTreeItem {
	readonly kind: 'file' | 'folder';
	readonly resource: URI;
	readonly projectUri: URI;
}

class AdeFilesTreeRenderer implements ITreeRenderer<IAdeFileTreeItem, FuzzyScore, IResourceLabel> {
	readonly templateId = 'ade-inspector-file';

	constructor(
		private readonly labels: ResourceLabels,
		private readonly configurationService: IConfigurationService,
	) { }

	renderTemplate(container: HTMLElement): IResourceLabel {
		return this.labels.create(container, { supportHighlights: true });
	}

	renderElement(node: ITreeNode<IAdeFileTreeItem, FuzzyScore>, _index: number, label: IResourceLabel): void {
		const fileDecorations = this.configurationService.getValue<{ colors: boolean; badges: boolean }>('explorer.decorations');
		label.setFile(node.element.resource, {
			fileKind: node.element.kind === 'folder' ? FileKind.FOLDER : FileKind.FILE,
			hidePath: true,
			fileDecorations,
			extraClasses: ['explorer-item'],
		});
	}

	disposeTemplate(label: IResourceLabel): void {
		label.dispose();
	}
}

export class AdeFilesView extends ViewPane {
	private tree: WorkbenchAsyncDataTree<URI, IAdeFileTreeItem, FuzzyScore> | undefined;
	private treeContainer: HTMLElement | undefined;
	private emptyContainer: HTMLElement | undefined;
	private readonly watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly refreshQueue = new Sequencer();
	private readonly fileActions: AdeFileActions;
	private currentProjectKey: string | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IAdeProjectsService private readonly adeProjects: IAdeProjectsService,
		@IAdeEditorService private readonly adeEditors: IAdeEditorService,
		@IFileService private readonly fileService: IFileService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.fileActions = instantiationService.createInstance(AdeFileActions);

		this._register(Event.any(
			projectNavigation.onDidChangeProject,
			projectNavigation.onDidChangeSelectedProject,
			adeProjects.onDidChange,
		)(() => {
			void this.refresh();
		}));

		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('explorer.decorations')) {
				void this.refresh();
			}
		}));
	}

	private getActiveProject(): IAdeProject | undefined {
		const active = this.projectNavigation.focusedProject
			?? this.projectNavigation.selectedProject
			?? this.adeProjects.selectedProject;
		return active ? { uri: active.uri, name: active.name } : undefined;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-inspector-view-body');
		this.emptyContainer = append(container, $('.ade-inspector-empty'));
		const treeContainer = this.treeContainer = append(container, $('.ade-files-tree.explorer-folders-view'));
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));
		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));

		const tree = this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<URI, IAdeFileTreeItem, FuzzyScore>,
			'AdeFiles',
			treeContainer,
			{ getHeight: () => 22, getTemplateId: () => 'ade-inspector-file' },
			[new AdeFilesTreeRenderer(labels, this.configurationService)],
			{
				hasChildren: element => URI.isUri(element) || element.kind === 'folder',
				getChildren: element => this.getChildren(element),
			},
			{
				identityProvider: { getId: item => item.resource.toString() },
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('adeFilesAria', "Project Files"),
					getAriaLabel: item => basename(item.resource),
				},
				renderIndentGuides: RenderIndentGuides.Always,
				indent: 12,
				multipleSelectionSupport: false,
			},
		));

		this._register(UndoCommand.addImplementation(110, 'ade-files', () => tree.isDOMFocused() ? this.fileActions.undo() : false));
		this._register(RedoCommand.addImplementation(110, 'ade-files', () => tree.isDOMFocused() ? this.fileActions.redo() : false));

		this._register(tree.onDidOpen(event => {
			if (event.element?.kind === 'file') {
				void this.adeEditors.openFile(event.element.resource, event.element.projectUri, event.editorOptions);
			}
		}));

		this._register(tree.onContextMenu(event => {
			const project = this.getActiveProject();
			if (!project) {
				return;
			}
			const item = event.element;
			if (item) {
				tree.setFocus([item]);
			}
			const targetResource = item ? item.resource : project.uri;
			const isFolder = item ? item.kind === 'folder' : true;
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.anchor,
				getActions: () => this.fileActions.getActions(targetResource, isFolder, project.uri, resource => this.refresh(resource)),
			});
		}));

		void this.refresh();
	}

	private async getChildren(element: URI | IAdeFileTreeItem): Promise<IAdeFileTreeItem[]> {
		const resource = URI.isUri(element) ? element : element.resource;
		const projectUri = URI.isUri(element) ? element : element.projectUri;
		const key = resource.toString();
		if (!this.watchers.has(key)) {
			const store = new DisposableStore();
			this.watchers.set(key, store);
			const watcher = store.add(this.fileService.createWatcher(resource, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(() => { void this.refresh(); }));
		}
		try {
			const folder = await this.fileService.resolve(resource);
			const children = (folder.children ?? []).filter(child => child.name !== '.git' && child.name !== '.DS_Store');
			children.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
			return children.map(child => ({
				kind: child.isDirectory ? 'folder' as const : 'file' as const,
				resource: child.resource,
				projectUri,
			}));
		} catch {
			return [];
		}
	}

	async refresh(revealResource?: URI): Promise<void> {
		await this.refreshQueue.queue(async () => {
			if (!this.tree || !this.emptyContainer || !this.treeContainer) {
				return;
			}
			const project = this.getActiveProject();
			if (!project) {
				this.currentProjectKey = undefined;
				this.watchers.clearAndDisposeAll();
				this.emptyContainer.textContent = localize('adeSelectProjectForFiles', "Select a project to view files");
				this.emptyContainer.hidden = false;
				this.treeContainer.hidden = true;
				return;
			}

			const nextKey = this.uriIdentityService.extUri.getComparisonKey(project.uri);
			if (this.currentProjectKey !== nextKey) {
				this.currentProjectKey = nextKey;
				this.watchers.clearAndDisposeAll();
			}

			this.emptyContainer.hidden = true;
			this.treeContainer.hidden = false;
			if (this.tree.getInput() && this.uriIdentityService.extUri.isEqual(this.tree.getInput(), project.uri)) {
				await this.tree.updateChildren();
			} else {
				await this.tree.setInput(project.uri);
			}
			if (revealResource) {
				await this.revealResource(project.uri, revealResource);
			}
		});
	}

	private async revealResource(projectUri: URI, resource: URI): Promise<void> {
		const tree = this.tree;
		if (!tree) {
			return;
		}
		const rel = relativePath(projectUri, resource);
		if (!rel) {
			return;
		}
		const targets: URI[] = [];
		let cursor = projectUri;
		for (const segment of rel.split('/').filter(Boolean)) {
			cursor = joinPath(cursor, segment);
			targets.push(cursor);
		}
		let children = tree.getNode().children;
		for (const target of targets) {
			const match = children.find(node => !URI.isUri(node.element) && this.uriIdentityService.extUri.isEqual(node.element.resource, target))?.element;
			if (!match || URI.isUri(match)) {
				return;
			}
			if (this.uriIdentityService.extUri.isEqual(target, resource)) {
				tree.setSelection([match]);
				tree.setFocus([match]);
				tree.reveal(match);
				return;
			}
			await tree.expand(match);
			children = tree.getNode(match).children;
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	override focus(): void {
		this.tree?.domFocus();
	}
}
