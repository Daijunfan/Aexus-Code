/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { $, addDisposableListener, append, clearNode, EventHelper, EventType } from '../../../../base/browser/dom.js';
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
import {
	AEXUS_SSH_GIT_HEAD_SCHEME,
	AEXUS_SSH_SCHEME,
	formatProjectDisplayPath,
	IAdeCloudHostBackendService,
	IAdeRemoteScmStatusEntry,
} from '../../../../platform/ade/common/adeCloudHosts.js';
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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ISCMRepository, ISCMResource, ISCMResourceGroup, ISCMService } from '../../scm/common/scm.js';
import { ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, ADE_FILES_VIEW_ID, IAdeEditorService, IAdeProject, IAdeProjectsService } from '../common/ade.js';
import { AdeFileActions } from './adeFileActions.js';

function resolveInspectorActiveProject(
	adeEditors: IAdeEditorService,
	adeProjects: IAdeProjectsService,
	projectNavigation: IProjectNavigationService,
): IAdeProject | undefined {
	const activeFolderUri = adeEditors.getActiveFolderUri?.();
	if (activeFolderUri) {
		return {
			uri: activeFolderUri,
			name: adeProjects.getProjectName(activeFolderUri),
		};
	}
	const selectedAde = adeProjects.selectedProject;
	if (selectedAde) {
		return { uri: selectedAde.uri, name: selectedAde.name };
	}
	const fallback = projectNavigation.focusedProject ?? projectNavigation.selectedProject;
	return fallback ? { uri: fallback.uri, name: fallback.name } : undefined;
}

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

/** Git status letter shown as a decoration pill on each changed file. */
export type AdeChangeLetter = 'A' | 'M' | 'D' | 'R' | 'U' | 'C';

const ADE_CHANGE_LETTER_PATTERNS: readonly [RegExp, AdeChangeLetter][] = [
	[/conflict/i, 'C'],
	[/untracked/i, 'U'],
	[/renamed|copied/i, 'R'],
	[/deleted/i, 'D'],
	[/added/i, 'A'],
	[/modified|changed/i, 'M'],
];

/** Derives the status letter for a local SCM resource from its decorations (tooltip first, then strike-through). */
export function resolveAdeChangeLetter(resource: Pick<ISCMResource, 'decorations'>): AdeChangeLetter {
	const tooltip = resource.decorations.tooltip ?? '';
	for (const [pattern, letter] of ADE_CHANGE_LETTER_PATTERNS) {
		if (pattern.test(tooltip)) {
			return letter;
		}
	}
	return resource.decorations.strikeThrough ? 'D' : 'M';
}

function normalizeRemoteLetter(status: IAdeRemoteScmStatusEntry['status']): AdeChangeLetter {
	switch (status) {
		case 'A':
		case 'D':
		case 'R':
		case 'U':
			return status;
		default:
			return 'M';
	}
}

export interface IAdeChangesSummary {
	readonly total: number;
	readonly added: number;
	readonly modified: number;
	readonly deleted: number;
}

/** Summarizes change letters into `N files · A · M · D` counts (untracked counts as added, renamed/conflicted as modified). */
export function summarizeAdeChangeLetters(letters: Iterable<AdeChangeLetter>): IAdeChangesSummary {
	let total = 0, added = 0, modified = 0, deleted = 0;
	for (const letter of letters) {
		total++;
		if (letter === 'A' || letter === 'U') {
			added++;
		} else if (letter === 'D') {
			deleted++;
		} else {
			modified++;
		}
	}
	return { total, added, modified, deleted };
}

type AdeChangeTreeItem =
	| { readonly kind: 'group'; readonly group: ISCMResourceGroup; readonly resources: readonly ISCMResource[] }
	| { readonly kind: 'resource'; readonly resource: ISCMResource; readonly projectUri: URI }
	| { readonly kind: 'remote-group'; readonly groupId: string; readonly label: string; readonly entries: readonly IAdeRemoteScmStatusEntry[]; readonly projectUri: URI }
	| { readonly kind: 'remote-resource'; readonly entry: IAdeRemoteScmStatusEntry; readonly projectUri: URI };

interface IChangeGroupTemplate {
	readonly label: HTMLElement;
	readonly badge: CountBadge;
}

interface IChangeResourceTemplate {
	readonly row: HTMLElement;
	readonly fileLabel: IResourceLabel;
	readonly openDiffButton: HTMLElement;
	readonly openFileButton: HTMLElement;
	readonly letterPill: HTMLElement;
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
		if (node.element.kind === 'group') {
			template.label.textContent = node.element.group.label;
			template.badge.setCount(node.element.resources.length);
			return;
		}
		if (node.element.kind === 'remote-group') {
			template.label.textContent = node.element.label;
			template.badge.setCount(node.element.entries.length);
		}
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
		private readonly onOpenRemoteEntry: (entry: IAdeRemoteScmStatusEntry, projectUri: URI) => void,
		private readonly onOpenDiff: (resource: ISCMResource, projectUri: URI) => void,
		private readonly onOpenRemoteDiff: (entry: IAdeRemoteScmStatusEntry, projectUri: URI) => void,
	) { }

	private applyLetter(pill: HTMLElement, letter: AdeChangeLetter, tooltip: string): void {
		pill.textContent = letter;
		pill.className = `ade-scm-letter letter-${letter}`;
		pill.setAttribute('aria-label', tooltip || letter);
	}

	renderTemplate(container: HTMLElement): IChangeResourceTemplate {
		const templateDisposables = new DisposableStore();
		const row = append(container, $('.ade-scm-resource-row'));
		const labelHost = append(row, $('.ade-scm-resource-label'));
		const fileLabel = templateDisposables.add(this.labels.create(labelHost, { supportHighlights: true, supportDescriptionHighlights: true }));
		const openDiffButton = append(row, $('button.ade-icon-button.ade-scm-open-diff', {
			type: 'button',
			'aria-label': localize('adeOpenChangedDiff', "Open Changes"),
		}));
		openDiffButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.diff));
		templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), openDiffButton, localize('adeOpenChangedDiff', "Open Changes")));
		const openFileButton = append(row, $('button.ade-icon-button.ade-scm-open-file', {
			type: 'button',
			'aria-label': localize('adeOpenChangedFile', "Open File"),
		}));
		openFileButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.goToFile));
		templateDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), openFileButton, localize('adeOpenChangedFile', "Open File")));
		const decorationIcon = append(row, $('span.ade-scm-decoration-icon'));
		const letterPill = append(row, $('span.ade-scm-letter'));
		return {
			row,
			fileLabel,
			openDiffButton,
			openFileButton,
			letterPill,
			decorationIcon,
			elementDisposables: new DisposableStore(),
			templateDisposables,
		};
	}

	renderElement(node: ITreeNode<AdeChangeTreeItem, FuzzyScore>, _index: number, template: IChangeResourceTemplate): void {
		template.elementDisposables.clear();
		if (node.element.kind === 'remote-resource') {
			const { entry, projectUri } = node.element;
			const uri = joinPath(projectUri, entry.relativePath);
			const relDir = entry.relativePath.includes('/') ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/')) : undefined;
			const statusTooltip = entry.status === 'A'
				? localize('adeRemoteAdded', "Added")
				: entry.status === 'D'
					? localize('adeRemoteDeleted', "Deleted")
					: entry.status === 'U'
						? localize('adeRemoteUntracked', "Untracked")
						: entry.status === 'R'
							? localize('adeRemoteRenamed', "Renamed")
							: localize('adeRemoteModified', "Modified");
			template.row.classList.toggle('faded', false);
			template.fileLabel.setResource({
				resource: uri,
				name: basename(uri),
				description: relDir,
			}, {
				fileKind: FileKind.FILE,
				strikethrough: entry.status === 'D',
				title: `${formatProjectDisplayPath(uri)} • ${statusTooltip}`,
				fileDecorations: { colors: false, badges: false },
			});
			template.elementDisposables.add(addDisposableListener(template.openFileButton, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onOpenRemoteEntry(entry, projectUri);
			}));
			template.elementDisposables.add(addDisposableListener(template.openDiffButton, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onOpenRemoteDiff(entry, projectUri);
			}));
			this.applyLetter(template.letterPill, normalizeRemoteLetter(entry.status), statusTooltip);
			template.elementDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.letterPill, statusTooltip));
			const statusIcon = entry.status === 'A' || entry.status === 'U'
				? Codicon.diffAdded
				: entry.status === 'D'
					? Codicon.diffRemoved
					: Codicon.diffModified;
			template.decorationIcon.className = `ade-scm-decoration-icon ${ThemeIcon.asClassName(statusIcon)}`;
			template.decorationIcon.style.color = '';
			template.decorationIcon.style.backgroundImage = '';
			template.decorationIcon.style.display = '';
			template.elementDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.decorationIcon, statusTooltip));
			return;
		}
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
		const displayPath = formatProjectDisplayPath(uri);

		template.row.classList.toggle('faded', Boolean(resource.decorations.faded));
		template.fileLabel.setResource({
			resource: uri,
			name: basename(uri),
			description: relDir,
		}, {
			fileKind: FileKind.FILE,
			strikethrough: resource.decorations.strikeThrough,
			title: tooltip ? `${displayPath} • ${tooltip}` : displayPath,
			fileDecorations: { colors: false, badges: !icon },
		});

		template.elementDisposables.add(addDisposableListener(template.openFileButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.onOpenFile(resource, projectUri);
		}));
		template.elementDisposables.add(addDisposableListener(template.openDiffButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.onOpenDiff(resource, projectUri);
		}));
		this.applyLetter(template.letterPill, resolveAdeChangeLetter(resource), tooltip);

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
	private emptyActions: HTMLElement | undefined;
	private summaryContainer: HTMLElement | undefined;
	private lastBodyHeight = 0;
	private lastBodyWidth = 0;
	private readonly repoDisposables = this._register(new DisposableStore());
	private readonly triedGitOpen = new Set<string>();
	private readonly refreshQueue = new Sequencer();
	private currentRepository: ISCMRepository | undefined;
	private currentProjectKey: string | undefined;
	private readonly cloudHosts: IAdeCloudHostBackendService | undefined;
	private readonly viewsService: IViewsService | undefined;
	private readonly editorService: IEditorService | undefined;

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
		[this.cloudHosts, this.viewsService, this.editorService] = instantiationService.invokeFunction(accessor => {
			let cloud: IAdeCloudHostBackendService | undefined;
			let views: IViewsService | undefined;
			let editors: IEditorService | undefined;
			try { cloud = accessor.get(IAdeCloudHostBackendService); } catch { cloud = undefined; }
			try { views = accessor.get(IViewsService); } catch { views = undefined; }
			try { editors = accessor.get(IEditorService); } catch { editors = undefined; }
			return [cloud, views, editors] as const;
		});
		const syncActiveProjectIfChanged = () => {
			const next = this.getActiveProject();
			const nextKey = next ? this.uriIdentityService.extUri.getComparisonKey(next.uri) : undefined;
			if (nextKey === this.currentProjectKey && nextKey !== undefined) {
				return;
			}
			void this.refresh();
		};
		this._register(Event.any(
			projectNavigation.onDidChangeProject,
			projectNavigation.onDidChangeSelectedProject,
			this.editorService?.onDidActiveEditorChange ?? Event.None,
		)(() => {
			syncActiveProjectIfChanged();
		}));
		this._register(adeProjects.onDidChange(kind => {
			if (kind === 'selection' || kind === 'order') {
				syncActiveProjectIfChanged();
				return;
			}
			void this.refresh();
		}));
		this._register(Event.any(
			scmService.onDidAddRepository,
			scmService.onDidRemoveRepository,
			themeService.onDidColorThemeChange,
		)(() => {
			void this.refresh();
		}));
		this._register(fileService.onDidFilesChange(e => {
			const active = this.getActiveProject();
			if (active && active.uri.scheme === AEXUS_SSH_SCHEME && e.affects(active.uri)) {
				void this.refresh();
			}
		}));
	}

	private getActiveProject(): IAdeProject | undefined {
		return resolveInspectorActiveProject(this.adeEditors, this.adeProjects, this.projectNavigation);
	}

	get activeProjectUri(): URI | undefined {
		return this.getActiveProject()?.uri;
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

	private async openRemoteScmDiff(entry: IAdeRemoteScmStatusEntry, projectUri: URI, options?: IEditorOptions): Promise<void> {
		const modifiedUri = joinPath(projectUri, entry.relativePath);
		const headQuery = new URLSearchParams({
			root: projectUri.path || '/',
			rel: entry.relativePath,
		}).toString();
		const headUri = URI.from({
			scheme: AEXUS_SSH_GIT_HEAD_SCHEME,
			authority: projectUri.authority,
			path: `/${entry.relativePath.replace(/^\/+/, '')}`,
			query: headQuery,
		});
		if (entry.status === 'U' || entry.status === 'A') {
			await this.adeEditors.openFile(modifiedUri, projectUri, options);
			return;
		}
		if (entry.status === 'D') {
			await this.adeEditors.openFile(headUri, projectUri, options);
			return;
		}
		await this.adeEditors.openDiff(
			headUri,
			modifiedUri,
			localize('adeWorkingTreeDiff', "{0} (Working Tree)", basename(modifiedUri)),
			projectUri,
			options,
		);
	}

	private async openRemoteBackingFile(entry: IAdeRemoteScmStatusEntry, projectUri: URI): Promise<void> {
		if (entry.status === 'D') {
			await this.openRemoteScmDiff(entry, projectUri);
			return;
		}
		await this.adeEditors.openFile(joinPath(projectUri, entry.relativePath), projectUri);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-inspector-view-body');
		this.emptyContainer = append(container, $('.ade-inspector-empty.ade-changes-empty'));
		this.emptyActions = this.renderEmptyActions(container);
		this.summaryContainer = append(container, $('.ade-changes-summary', { role: 'status' }));
		this.summaryContainer.hidden = true;
		const treeContainer = this.treeContainer = append(container, $('.ade-changes-tree.explorer-folders-view'));
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));
		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));

		const tree = this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<AdeChangeTreeItem[], AdeChangeTreeItem, FuzzyScore>,
			'AdeChanges',
			treeContainer,
			{
				getHeight: () => 22,
				getTemplateId: item => (item.kind === 'group' || item.kind === 'remote-group') ? 'ade-change-group' : 'ade-change-resource',
			},
			[
				new AdeChangeGroupRenderer(),
				new AdeChangeResourceRenderer(
					labels,
					this.themeService,
					this.hoverService,
					(resource, projectUri) => {
						void this.openBackingFile(resource, projectUri);
					},
					(entry, projectUri) => {
						void this.openRemoteBackingFile(entry, projectUri);
					},
					(resource, projectUri) => {
						void openScmResourceInAde(this.adeEditors, resource, projectUri);
					},
					(entry, projectUri) => {
						void this.openRemoteScmDiff(entry, projectUri);
					},
				),
			],
			{
				hasChildren: item => Array.isArray(item) || item.kind === 'group' || item.kind === 'remote-group',
				getChildren: item => Array.isArray(item)
					? item
					: item.kind === 'group'
						? item.resources.map(resource => ({ kind: 'resource' as const, resource, projectUri: this.getActiveProject()?.uri ?? resource.sourceUri }))
						: item.kind === 'remote-group'
							? item.entries.map(entry => ({ kind: 'remote-resource' as const, entry, projectUri: item.projectUri }))
							: [],
			},
			{
				identityProvider: {
					getId: item => item.kind === 'group'
						? `group:${item.group.provider.id}:${item.group.id}`
						: item.kind === 'remote-group'
							? `remote-group:${item.projectUri.toString()}:${item.groupId}`
							: item.kind === 'remote-resource'
								? `remote-resource:${item.projectUri.toString()}:${item.entry.staged ? 'staged' : 'wt'}:${item.entry.relativePath}`
								: `resource:${item.resource.resourceGroup.provider.id}:${item.resource.resourceGroup.id}:${item.resource.sourceUri.toString()}`,
				},
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('adeChangesAria', "Project Changes"),
					getAriaLabel: item => item.kind === 'group'
						? item.group.label
						: item.kind === 'remote-group'
							? item.label
							: item.kind === 'remote-resource'
								? basename(joinPath(item.projectUri, item.entry.relativePath))
								: basename(item.resource.sourceUri),
				},
				renderIndentGuides: RenderIndentGuides.Always,
				expandOnlyOnTwistieClick: false,
				indent: 12,
				multipleSelectionSupport: false,
			},
		));

		this._register(tree.onDidOpen(event => {
			if (event.element?.kind === 'resource') {
				void openScmResourceInAde(this.adeEditors, event.element.resource, event.element.projectUri, event.editorOptions);
			} else if (event.element?.kind === 'remote-resource') {
				void this.openRemoteScmDiff(event.element.entry, event.element.projectUri, event.editorOptions);
			}
		}));

		this._register(tree.onContextMenu(event => {
			if (event.element?.kind === 'remote-resource') {
				const { entry, projectUri } = event.element;
				const uri = joinPath(projectUri, entry.relativePath);
				tree.setFocus([event.element]);
				this.contextMenuService.showContextMenu({
					getAnchor: () => event.anchor,
					getActions: () => [
						toAction({
							id: 'ade.changes.openRemoteDiff',
							label: localize('adeOpenChanges', "Open Changes"),
							run: () => this.openRemoteScmDiff(entry, projectUri),
						}),
						toAction({
							id: 'ade.changes.openRemoteFile',
							label: localize('adeOpenFile', "Open File"),
							run: () => this.openRemoteBackingFile(entry, projectUri),
						}),
						new Separator(),
						toAction({
							id: 'ade.changes.copyRemotePath',
							label: localize('copyPath', "Copy Path"),
							run: () => this.clipboardService.writeText(formatProjectDisplayPath(uri)),
						}),
						toAction({
							id: 'ade.changes.copyRemoteRelativePath',
							label: localize('copyRelativePath', "Copy Relative Path"),
							run: () => this.clipboardService.writeText(entry.relativePath),
						}),
					],
				});
				return;
			}
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

	private renderEmptyActions(container: HTMLElement): HTMLElement {
		const actions = append(container, $('.ade-inspector-empty-actions'));
		actions.hidden = true;
		const addAction = (icon: ThemeIcon, label: string, run: () => void) => {
			const btn = append(actions, $('button.ade-inspector-empty-action', { type: 'button' }));
			const ico = append(btn, $('span', { 'aria-hidden': 'true' }));
			ico.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(btn, $('span', {}, label));
			this._register(addDisposableListener(btn, EventType.CLICK, run));
		};
		addAction(Codicon.files, localize('adeChangesOpenFiles', "Open Files"), () => {
			if (this.viewsService) {
				void this.viewsService.openView(ADE_FILES_VIEW_ID, true);
			} else {
				void this.commandService.executeCommand(`${ADE_FILES_VIEW_ID}.focus`).catch(() => undefined);
			}
		});
		addAction(Codicon.refresh, localize('adeChangesRefresh', "Refresh"), () => {
			void this.refresh();
		});
		return actions;
	}

	private showEmpty(message: string, withActions: boolean): void {
		if (!this.emptyContainer || !this.treeContainer) {
			return;
		}
		this.emptyContainer.textContent = message;
		this.emptyContainer.hidden = false;
		this.emptyContainer.classList.toggle('no-project', !withActions);
		if (this.emptyActions) {
			this.emptyActions.hidden = !withActions;
		}
		this.treeContainer.hidden = true;
		this.updateSummary(undefined);
	}

	private showTree(): void {
		if (!this.emptyContainer || !this.treeContainer) {
			return;
		}
		this.emptyContainer.hidden = true;
		if (this.emptyActions) {
			this.emptyActions.hidden = true;
		}
		this.treeContainer.hidden = false;
	}

	private updateSummary(summary: IAdeChangesSummary | undefined): void {
		const host = this.summaryContainer;
		const hadSummary = Boolean(host && !host.hidden);
		this.updateTitleDescription(summary && summary.total > 0 ? String(summary.total) : undefined);
		if (!host) {
			return;
		}
		clearNode(host);
		host.hidden = !summary || summary.total === 0;
		if (summary && summary.total > 0) {
			append(host, $('span.ade-changes-summary-total', {}, summary.total === 1
				? localize('adeChangesOneFile', "1 file")
				: localize('adeChangesFiles', "{0} files", summary.total)));
			const addCount = (letter: AdeChangeLetter, count: number, label: string) => {
				if (count <= 0) {
					return;
				}
				append(host, $('span.ade-changes-summary-sep', { 'aria-hidden': 'true' }, '\u00b7'));
				const part = append(host, $(`span.ade-changes-summary-part.letter-${letter}`, { title: label, 'aria-label': `${label}: ${count}` }));
				append(part, $(`span.ade-scm-letter.letter-${letter}`, { 'aria-hidden': 'true' }, letter));
				append(part, $('span.ade-changes-summary-count', {}, String(count)));
			};
			addCount('A', summary.added, localize('adeChangesAdded', "Added"));
			addCount('M', summary.modified, localize('adeChangesModified', "Modified"));
			addCount('D', summary.deleted, localize('adeChangesDeleted', "Deleted"));
		}
		if (hadSummary !== Boolean(!host.hidden)) {
			this.layoutTree();
		}
	}

	private layoutTree(): void {
		if (this.lastBodyHeight <= 0) {
			return;
		}
		const summaryHeight = this.summaryContainer && !this.summaryContainer.hidden ? this.summaryContainer.offsetHeight : 0;
		this.tree?.layout(Math.max(0, this.lastBodyHeight - summaryHeight), this.lastBodyWidth);
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
				this.currentProjectKey = undefined;
				this.bindRepositoryListeners(undefined);
				this.showEmpty(localize('adeSelectProjectForChanges', "Select a project to view changes"), false);
				await this.tree.setInput([]);
				return;
			}
			this.currentProjectKey = this.uriIdentityService.extUri.getComparisonKey(project.uri);

			if (project.uri.scheme === AEXUS_SSH_SCHEME && this.cloudHosts) {
				this.bindRepositoryListeners(undefined);
				let entries: readonly IAdeRemoteScmStatusEntry[] = [];
				try {
					entries = await this.cloudHosts.remoteGitStatus(project.uri.authority, project.uri.path || '/');
				} catch {
					entries = [];
				}
				if (entries.length === 0) {
					this.showEmpty(localize('adeNoChangesInProject', "No changes in {0}", project.name), true);
					await this.tree.setInput([]);
					return;
				}
				const staged = entries.filter(e => e.staged);
				const working = entries.filter(e => !e.staged);
				const remoteGroups: AdeChangeTreeItem[] = [];
				if (staged.length > 0) {
					remoteGroups.push({
						kind: 'remote-group',
						groupId: 'staged',
						label: localize('adeRemoteStagedChanges', "Staged Changes"),
						entries: staged,
						projectUri: project.uri,
					});
				}
				if (working.length > 0) {
					remoteGroups.push({
						kind: 'remote-group',
						groupId: 'changes',
						label: localize('adeRemoteWorkingChanges', "Changes"),
						entries: working,
						projectUri: project.uri,
					});
				}
				this.showTree();
				this.updateSummary(summarizeAdeChangeLetters(entries.map(entry => normalizeRemoteLetter(entry.status))));
				await this.tree.setInput(remoteGroups);
				for (const g of remoteGroups) {
					await this.tree.expand(g);
				}
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
			const letters = new Map<string, AdeChangeLetter>();
			let totalResources = 0;
			for (const group of repository?.provider.groups ?? []) {
				const resources = group.resources.filter(item => this.uriIdentityService.extUri.isEqualOrParent(item.sourceUri, project.uri));
				totalResources += resources.length;
				for (const resource of resources) {
					const key = resource.sourceUri.toString();
					if (!letters.has(key)) {
						letters.set(key, resolveAdeChangeLetter(resource));
					}
				}
				if (resources.length > 0 || !group.hideWhenEmpty) {
					groups.push({ kind: 'group', group, resources });
				}
			}

			if (totalResources === 0) {
				this.showEmpty(localize('adeNoChangesInProject', "No changes in {0}", project.name), true);
				await this.tree.setInput([]);
				return;
			}

			this.showTree();
			this.updateSummary(summarizeAdeChangeLetters(letters.values()));
			await this.tree.setInput(groups);
			for (const group of groups) {
				await this.tree.expand(group);
			}
		});
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastBodyHeight = height;
		this.lastBodyWidth = width;
		this.layoutTree();
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
	private emptyActions: HTMLElement | undefined;
	private readonly watchers = this._register(new DisposableMap<string, DisposableStore>());
	private readonly refreshQueue = new Sequencer();
	private readonly fileActions: AdeFileActions;
	private readonly commandService: ICommandService | undefined;
	private readonly editorService: IEditorService | undefined;
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
		[this.commandService, this.editorService] = instantiationService.invokeFunction(accessor => {
			let cmd: ICommandService | undefined;
			let editors: IEditorService | undefined;
			try { cmd = accessor.get(ICommandService); } catch { cmd = undefined; }
			try { editors = accessor.get(IEditorService); } catch { editors = undefined; }
			return [cmd, editors] as const;
		});

		const syncActiveProjectIfChanged = () => {
			const next = this.getActiveProject();
			const nextKey = next ? this.uriIdentityService.extUri.getComparisonKey(next.uri) : undefined;
			if (
				next
				&& nextKey === this.currentProjectKey
				&& this.tree?.getInput()
				&& this.uriIdentityService.extUri.isEqual(this.tree.getInput(), next.uri)
			) {
				this.updateTitleDescription(next.name);
				return;
			}
			void this.refresh();
		};

		this._register(Event.any(
			projectNavigation.onDidChangeProject,
			projectNavigation.onDidChangeSelectedProject,
			this.editorService?.onDidActiveEditorChange ?? Event.None,
		)(() => {
			syncActiveProjectIfChanged();
		}));
		this._register(adeProjects.onDidChange(kind => {
			if (kind === 'selection' || kind === 'order') {
				syncActiveProjectIfChanged();
				return;
			}
			void this.refresh();
		}));

		let cloudRefreshTimer: ReturnType<typeof setTimeout> | undefined;
		this._register({ dispose: () => { if (cloudRefreshTimer) { clearTimeout(cloudRefreshTimer); } } });
		this._register(fileService.onDidFilesChange(e => {
			const active = this.getActiveProject();
			if (active && active.uri.scheme === AEXUS_SSH_SCHEME && e.affects(active.uri)) {
				if (cloudRefreshTimer) {
					clearTimeout(cloudRefreshTimer);
				}
				cloudRefreshTimer = setTimeout(() => {
					cloudRefreshTimer = undefined;
					void this.refresh();
				}, 300);
			}
		}));

		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('explorer.decorations')) {
				void this.refresh();
			}
		}));
	}

	private getActiveProject(): IAdeProject | undefined {
		return resolveInspectorActiveProject(this.adeEditors, this.adeProjects, this.projectNavigation);
	}

	get activeProjectUri(): URI | undefined {
		return this.getActiveProject()?.uri;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-inspector-view-body');
		this.emptyContainer = append(container, $('.ade-inspector-empty.ade-files-empty'));
		this.emptyActions = this.renderFilesEmptyActions(container);
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
				expandOnlyOnTwistieClick: false,
				indent: 12,
				multipleSelectionSupport: false,
			},
		));

		this._register(UndoCommand.addImplementation(110, 'ade-files', () => tree.isDOMFocused() ? this.fileActions.undo() : false));
		this._register(RedoCommand.addImplementation(110, 'ade-files', () => tree.isDOMFocused() ? this.fileActions.redo() : false));

		this._register(tree.onDidChangeCollapseState(event => {
			const element = event.node.element?.element;
			if (event.node.collapsed && element && !URI.isUri(element) && element.kind === 'folder') {
				this.pruneWatchers(element.resource);
			}
		}));

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

	private renderFilesEmptyActions(container: HTMLElement): HTMLElement {
		const actions = append(container, $('.ade-inspector-empty-actions'));
		actions.hidden = true;
		const addAction = (icon: ThemeIcon, label: string, run: () => void) => {
			const btn = append(actions, $('button.ade-inspector-empty-action', { type: 'button' }));
			const ico = append(btn, $('span', { 'aria-hidden': 'true' }));
			ico.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(btn, $('span', {}, label));
			this._register(addDisposableListener(btn, EventType.CLICK, run));
		};
		addAction(Codicon.folderOpened, localize('adeFilesAddProjectFolder', "Add Project Folder..."), () => {
			void this.commandService?.executeCommand('workbench.action.ade.addProjectFolder').catch(() => undefined);
		});
		addAction(Codicon.remote, localize('adeFilesManageCloudHosts', "Cloud Hosts..."), () => {
			void this.commandService?.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID).catch(() => undefined);
		});
		return actions;
	}

	/** Disposes the watchers of a collapsed folder and all of its descendants. */
	private pruneWatchers(folder: URI): void {
		const prefix = folder.toString();
		const descendantPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
		for (const key of [...this.watchers.keys()]) {
			if (key === prefix || key.startsWith(descendantPrefix)) {
				this.watchers.deleteAndDispose(key);
			}
		}
	}

	get watchedFolderCount(): number {
		return [...this.watchers.keys()].length;
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
				this.emptyContainer.classList.add('no-project');
				if (this.emptyActions) {
					this.emptyActions.hidden = false;
				}
				this.treeContainer.hidden = true;
				this.updateTitleDescription(undefined);
				return;
			}

			const nextKey = this.uriIdentityService.extUri.getComparisonKey(project.uri);
			if (this.currentProjectKey !== nextKey) {
				this.currentProjectKey = nextKey;
				this.watchers.clearAndDisposeAll();
			}

			this.emptyContainer.hidden = true;
			if (this.emptyActions) {
				this.emptyActions.hidden = true;
			}
			this.treeContainer.hidden = false;
			this.updateTitleDescription(project.name);
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
