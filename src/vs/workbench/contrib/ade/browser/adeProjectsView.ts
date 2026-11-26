/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/adeSidebarDeck.css';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { $, addDisposableListener, addStandardDisposableListener, append, clearNode, EventHelper, EventType } from '../../../../base/browser/dom.js';
import { IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../base/browser/ui/list/listView.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer, TreeDragOverBubble } from '../../../../base/browser/ui/tree/tree.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Sequencer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Event } from '../../../../base/common/event.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { basename, removeTrailingPathSeparator } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	ADE_OS_ICON_LABELS,
	formatProjectDisplayPath,
	IAdeCloudHost,
	IAdeCloudHostBackendService,
	isCloudProjectUri,
	resolveAdeOsIconKind,
} from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServiceIdentifier, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { renderAdeOsIcon, resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { createFileIconThemableTreeContainerScope, IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { InlineEditInputBox } from '../../../browser/parts/views/inlineEditInputBox.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import {
	ADE_ADD_CLOUD_PROJECT_COMMAND_ID,
	ADE_ADD_PROJECT_FOLDER_COMMAND_ID,
	ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID,
	ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID,
	ADE_CREATE_PROJECT_PAGE_COMMAND_ID,
	ADE_DELETE_PROJECT_COMMAND_ID,
	ADE_DELETE_PROJECT_PAGE_COMMAND_ID,
	ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID,
	ADE_OPEN_PROJECT_PAGE_COMMAND_ID,
	ADE_PROJECTS_VIEW_ID,
	ADE_REMOVE_PROJECT_COMMAND_ID,
	ADE_RENAME_PROJECT_COMMAND_ID,
	ADE_RENAME_PROJECT_PAGE_COMMAND_ID,
	IAdeEditorService,
	IAdeProject,
	IAdeProjectPageItem,
	IAdeProjectsService,
} from '../common/ade.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';
import { pickCloudHostProjectFolder, pickProjectFoldersWithCloudOption } from './adeCloudHostFileSystemProvider.js';
import { deleteProjectsWithModePrompt, reconcileIdeWorkspaceWithCatalog, removeProjectsSynchronized } from './adeProjectManagement.js';
import { asAdeProjectsSelectionRouting } from './adeProjectsService.js';

export type AdeTreeItem =
	| { readonly kind: 'folder'; readonly folder: IAdeProject }
	| { readonly kind: 'projectPage'; readonly page: IAdeProjectPageItem; readonly folder: IAdeProject };

function tryGetService<T>(accessor: ServicesAccessor, id: ServiceIdentifier<T>): T | undefined {
	try {
		return accessor.get(id);
	} catch {
		return undefined;
	}
}

export function resolveTargetProjectPageId(
	projects: IAdeProjectsService,
	editors: IAdeEditorService | undefined,
	rawProjectId?: unknown,
): string | undefined {
	if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
		return rawProjectId.trim();
	}
	return projects.selectedProjectPageId ?? editors?.getActiveProjectPageId?.();
}

/**
 * View-independent helper for renaming a Project Page via `IQuickInputService.input` (or explicit `rawNextName`),
 * falling back to `editors.getActiveProjectPageId()` when `projects.selectedProjectPageId` is `undefined`
 * and the left `AdeProjectsView` sidebar is collapsed (`Cmd+B`) or unmounted.
 */
export async function promptRenameAdeProjectPage(
	accessor: ServicesAccessor,
	rawProjectId?: unknown,
	rawNextName?: unknown,
): Promise<string | undefined> {
	const projects = accessor.get(IAdeProjectsService);
	const editors = tryGetService(accessor, IAdeEditorService);
	const quickInput = tryGetService(accessor, IQuickInputService);
	const views = tryGetService(accessor, IViewsService);
	const projectId = resolveTargetProjectPageId(projects, editors, rawProjectId);
	if (!projectId) {
		return undefined;
	}
	const current = projects.getProjectPage(projectId);
	if (!current) {
		return undefined;
	}
	const nextName = typeof rawNextName === 'string' && rawNextName.trim()
		? rawNextName.trim()
		: (await quickInput?.input({
			value: current.name,
			prompt: adeBi(localize('adeRenameProjectPagePrompt', "Enter new Project Page name"), '输入新的 Project 页面名称'),
		}))?.trim();
	if (!nextName) {
		return undefined;
	}
	await projects.renameProjectPage(projectId, nextName);
	const activeView = views?.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
	if (activeView) {
		await activeView.refresh();
	}
	return nextName;
}

/**
 * View-independent helper for configuring cross-host Ticket storage on a Project Page.
 * Works identically whether the left `AdeProjectsView` sidebar is expanded, collapsed (`Cmd+B`), or unmounted.
 */
export async function configureAdeProjectTicketStorage(
	accessor: ServicesAccessor,
	rawProjectId?: unknown,
	rawTargetHost?: unknown,
): Promise<string | undefined> {
	const projects = accessor.get(IAdeProjectsService);
	const editors = tryGetService(accessor, IAdeEditorService);
	const controlCenter = tryGetService(accessor, IAdeControlCenterService);
	const projectId = resolveTargetProjectPageId(projects, editors, rawProjectId);
	if (!projectId || !controlCenter) {
		return undefined;
	}
	if (typeof rawTargetHost === 'string' && rawTargetHost.trim()) {
		const explicitHost = rawTargetHost.trim();
		await controlCenter.uiConfigureProjectTicketStorage(projectId, explicitHost);
		return explicitHost;
	}
	const quickInputService = tryGetService(accessor, IQuickInputService);
	if (!quickInputService) {
		return undefined;
	}
	const cloudHostService = tryGetService(accessor, IAdeCloudHostBackendService);
	const notificationService = tryGetService(accessor, INotificationService);
	const [snap, cloudHosts] = await Promise.all([
		controlCenter.getProjectSnapshot(projectId).catch(() => undefined),
		cloudHostService ? cloudHostService.listHosts().catch(() => [] as readonly IAdeCloudHost[]) : Promise.resolve([] as readonly IAdeCloudHost[]),
	]);
	if (!snap) {
		return undefined;
	}
	const currentHost = snap.meta.cross_host_ticket_storage || 'local';
	type StoragePickItem = IQuickPickItem & { readonly targetHost: string };
	const items: StoragePickItem[] = [
		{
			label: adeBi(localize('adeStorageLocalMac', "Local (This Mac)"), '本机 (Local Mac)'),
			description: currentHost === 'local' ? adeBi(localize('adeCurrentDefaultBadge', "(Current)"), '(当前默认)') : '~/.aexus-code/ade-store',
			iconClass: ThemeIcon.asClassName(Codicon.deviceDesktop),
			targetHost: 'local',
		},
	];
	const seenIps = new Set<string>(['local']);
	for (const h of cloudHosts) {
		const ip = h.hostName.trim();
		if (!ip || seenIps.has(ip)) {
			continue;
		}
		seenIps.add(ip);
		items.push({
			label: `${h.name || h.alias} (${ip})`,
			description: currentHost === ip ? adeBi(localize('adeCurrentDefaultBadge', "(Current)"), '(当前默认)') : `${h.alias} · ~/.ade_store`,
			iconClass: ThemeIcon.asClassName(Codicon.remote),
			targetHost: ip,
		});
	}
	for (const h of snap.hosts) {
		if (!h.ip || seenIps.has(h.ip)) {
			continue;
		}
		seenIps.add(h.ip);
		items.push({
			label: `${h.name || h.ssh_alias} (${h.ip})`,
			description: currentHost === h.ip ? adeBi(localize('adeCurrentDefaultBadge', "(Current)"), '(当前默认)') : `${h.ssh_alias} · ~/.ade_store`,
			iconClass: ThemeIcon.asClassName(Codicon.remote),
			targetHost: h.ip,
		});
	}

	const picked = await quickInputService.pick(items, {
		title: adeBi(
			localize('adeConfigureCrossHostStorageTitle', "Cross-Host Ticket Storage — {0}", snap.meta.name),
			'跨机 Ticket 默认存储主机 — {0}',
			snap.meta.name,
		),
		placeHolder: adeBi(
			localize('adeConfigureCrossHostStoragePh', "Choose where cross-host Ticket details are stored (migrates active items safely in background)"),
			'选择跨主机传递 Ticket 详述的默认存储位置（存量活跃条目将自动执行安全 CAS 搬迁）',
		),
		matchOnDescription: true,
	});
	if (!picked || picked.targetHost === currentHost) {
		return undefined;
	}
	await controlCenter.uiConfigureProjectTicketStorage(projectId, picked.targetHost);
	notificationService?.info(adeBi(
		localize('adeConfiguredCrossHostStorageToast', "Updated cross-host Ticket storage for '{0}' to '{1}'.", snap.meta.name, picked.targetHost),
		'已将「{0}」的跨机 Ticket 默认存储切换至 {1}。',
		snap.meta.name,
		picked.targetHost,
	));
	return picked.targetHost;
}

/**
 * View-independent helper that ALWAYS requires secondary `IDialogService.confirm` confirmation
 * (unless `skipConfirm === true`) before closing Project editors and deleting the Project Page,
 * even when triggered from the Command Palette while the left sidebar is collapsed (`Cmd+B`).
 */
export async function confirmAndDeleteAdeProjectPage(
	accessor: ServicesAccessor,
	rawProjectId?: unknown,
	skipConfirm = false,
): Promise<boolean> {
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const dialogService = tryGetService(accessor, IDialogService);
	const views = tryGetService(accessor, IViewsService);
	const projectId = resolveTargetProjectPageId(projects, editors, rawProjectId);
	if (!projectId) {
		return false;
	}
	const page = projects.getProjectPage(projectId);
	if (!page) {
		return false;
	}
	if (!skipConfirm) {
		if (!dialogService) {
			return false;
		}
		const res = await dialogService.confirm({
			type: 'warning',
			message: adeBi(
				localize('adeConfirmDeleteProjectPageTitle', "Delete Project Page '{0}'?", page.name),
				'确定删除 Project 页面「{0}」吗？',
				page.name,
			),
			detail: adeBi(
				localize('adeConfirmDeleteProjectPageDetail', "This permanently deletes this Project's orchestration state, employee sessions, whiteboards, and Ticket store. Workspace source files in '{0}' are never deleted, and the folder stays in the sidebar.", formatProjectDisplayPath(page.folderUri)),
				'此操作将销毁该 Project 页面的编排拓扑、员工会话进程、白板与 Ticket 存储文件；工作区源码目录「{0}」绝不会被改动，文件夹也将继续保留在左栏。',
				formatProjectDisplayPath(page.folderUri),
			),
			primaryButton: adeBi(localize('adeConfirmDeleteProjectPageBtn', "&&Delete Project Page"), '删除 Project 页面(&&D)'),
		});
		if (!res.confirmed) {
			return false;
		}
	}
	await editors.closeProjectPageEditors(projectId);
	await projects.deleteProjectPage(projectId);
	const activeView = views?.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
	if (activeView) {
		await activeView.refresh();
	}
	return true;
}

export class AdeProjectsDragAndDrop implements ITreeDragAndDrop<AdeTreeItem> {
	constructor(
		private readonly projects: IAdeProjectsService,
		private readonly navigation: IProjectNavigationService,
		private readonly uriIdentity: IUriIdentityService,
	) { }

	private canReorderFolders(): boolean {
		return !this.navigation.focusedProject;
	}

	getDragURI(item: AdeTreeItem): string | null {
		if (item.kind === 'folder') {
			return this.canReorderFolders() ? item.folder.uri.toString() : null;
		}
		return `ade-project-page:${item.page.projectId}`;
	}

	getDragLabel(items: AdeTreeItem[]): string | undefined {
		const first = items[0];
		if (!first) {
			return undefined;
		}
		return first.kind === 'folder' ? first.folder.name : first.page.name;
	}

	private getDraggedItem(data: IDragAndDropData): AdeTreeItem | undefined {
		if (!(data instanceof ElementsDragAndDropData) || data.elements.length !== 1) {
			return undefined;
		}
		return data.elements[0] as AdeTreeItem;
	}

	onDragOver(data: IDragAndDropData, target: AdeTreeItem | undefined, _targetIndex: number | undefined, sector: ListViewTargetSector | undefined): boolean | ITreeDragOverReaction {
		const dragged = this.getDraggedItem(data);
		if (!dragged) {
			return false;
		}

		if (dragged.kind === 'folder') {
			if (!this.canReorderFolders()) {
				return false;
			}
			if (target && (target.kind !== 'folder' || this.uriIdentity.extUri.isEqual(target.folder.uri, dragged.folder.uri))) {
				return false;
			}
			const after = !target || sector === ListViewTargetSector.CENTER_BOTTOM || sector === ListViewTargetSector.BOTTOM;
			return {
				accept: true,
				bubble: TreeDragOverBubble.Down,
				effect: {
					type: ListDragOverEffectType.Move,
					position: after ? ListDragOverEffectPosition.After : ListDragOverEffectPosition.Before,
				},
			};
		}

		// Intra-folder Project Page drag-and-drop reorder only
		if (!target || target.kind !== 'projectPage') {
			return false;
		}
		if (target.page.projectId === dragged.page.projectId) {
			return false;
		}
		if (!this.uriIdentity.extUri.isEqual(target.folder.uri, dragged.folder.uri)) {
			return false;
		}
		const after = sector === ListViewTargetSector.CENTER_BOTTOM || sector === ListViewTargetSector.BOTTOM;
		return {
			accept: true,
			bubble: TreeDragOverBubble.Down,
			effect: {
				type: ListDragOverEffectType.Move,
				position: after ? ListDragOverEffectPosition.After : ListDragOverEffectPosition.Before,
			},
		};
	}

	drop(data: IDragAndDropData, target: AdeTreeItem | undefined, _targetIndex: number | undefined, sector: ListViewTargetSector | undefined): void {
		const dragged = this.getDraggedItem(data);
		if (!dragged) {
			return;
		}
		if (dragged.kind === 'folder') {
			if (!this.canReorderFolders()) {
				return;
			}
			const after = !target || sector === ListViewTargetSector.CENTER_BOTTOM || sector === ListViewTargetSector.BOTTOM;
			this.projects.moveProjectFolder(dragged.folder.uri, target?.kind === 'folder' ? target.folder.uri : undefined, after);
			return;
		}
		if (target && target.kind === 'projectPage' && this.uriIdentity.extUri.isEqual(target.folder.uri, dragged.folder.uri)) {
			const after = sector === ListViewTargetSector.CENTER_BOTTOM || sector === ListViewTargetSector.BOTTOM;
			void this.projects.reorderProjectPage(dragged.page.projectId, target.page.projectId, after);
		}
	}

	dispose(): void { }
}

interface IFolderRowTemplate {
	readonly root: HTMLElement;
	readonly osIconEl: HTMLElement;
	readonly labelHost: HTMLElement;
	readonly resourceLabel: IResourceLabel;
	readonly cloudBadgeEl: HTMLElement;
	readonly countEl: HTMLElement;
	readonly addBtn: HTMLButtonElement;
	readonly rowDisposables: DisposableStore;
	readonly templateDisposables: DisposableStore;
}

interface IProjectPageRowTemplate {
	readonly root: HTMLElement;
	readonly iconEl: HTMLElement;
	readonly labelHost: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly editHost: HTMLElement;
	readonly actionsEl: HTMLElement;
	readonly renameBtn: HTMLButtonElement;
	readonly deleteBtn: HTMLButtonElement;
	readonly rowDisposables: DisposableStore;
}

class AdeFolderRowRenderer implements ITreeRenderer<AdeTreeItem, FuzzyScore, IFolderRowTemplate> {
	static readonly TEMPLATE_ID = 'ade-folder-row';
	readonly templateId = AdeFolderRowRenderer.TEMPLATE_ID;

	constructor(
		private readonly labels: ResourceLabels,
		private readonly projects: IAdeProjectsService,
		private readonly getCloudHostMeta: (authority: string) => IAdeCloudHost | undefined,
		private readonly onAddProjectPage: (folderUri: URI) => void,
	) { }

	renderTemplate(container: HTMLElement): IFolderRowTemplate {
		const templateDisposables = new DisposableStore();
		const rowDisposables = templateDisposables.add(new DisposableStore());
		const root = append(container, $('.ade-tree-row.ade-folder-row'));
		const osIconEl = append(root, $('span.ade-folder-os-icon', { 'aria-hidden': 'true' }));
		const labelHost = append(root, $('div.ade-tree-label-host'));
		const resourceLabel = templateDisposables.add(this.labels.create(labelHost, { supportHighlights: true }));
		const cloudBadgeEl = append(root, $('span.ade-cloud-host-badge'));
		const countEl = append(root, $('span.ade-project-count'));
		const addBtn = append(root, $('button.ade-icon-button.ade-add-page-btn', {
			type: 'button',
			'data-action': 'create-project-page',
		})) as HTMLButtonElement;
		const addIco = append(addBtn, $('span', { 'aria-hidden': 'true' }));
		addIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));

		return {
			root,
			osIconEl,
			labelHost,
			resourceLabel,
			cloudBadgeEl,
			countEl,
			addBtn,
			rowDisposables,
			templateDisposables,
		};
	}

	renderElement(node: ITreeNode<AdeTreeItem, FuzzyScore>, _index: number, template: IFolderRowTemplate): void {
		template.rowDisposables.clear();
		if (node.element.kind !== 'folder') {
			return;
		}
		const { folder } = node.element;
		const isCloud = isCloudProjectUri(folder.uri);
		const pages = this.projects.getProjectPagesForFolder(folder.uri);
		template.root.dataset.folderUri = folder.uri.toString();
		template.root.classList.toggle('is-cloud', isCloud);
		template.root.classList.toggle('is-empty-folder', pages.length === 0);

		const savedHost = isCloud ? this.getCloudHostMeta(folder.uri.authority) : undefined;
		const osKind = isCloud
			? resolveAdeOsIconKind({
				os: savedHost?.os,
				distribution: savedHost?.lastTestStatus?.remoteUname,
				hint: `${savedHost?.name ?? ''} ${savedHost?.alias ?? ''} ${folder.uri.authority} ${folder.uri.path}`,
			})
			: resolveLocalOsIconKind();
		renderAdeOsIcon(template.osIconEl, osKind, {
			baseClass: 'ade-folder-os-icon',
			prefix: 'ade-os',
			tooltip: ADE_OS_ICON_LABELS[osKind],
		});

		template.resourceLabel.setFile(folder.uri, {
			fileKind: FileKind.ROOT_FOLDER,
			hidePath: true,
			hideIcon: true,
			title: formatProjectDisplayPath(folder.uri),
		});

		if (isCloud) {
			template.cloudBadgeEl.textContent = savedHost?.alias ?? folder.uri.authority;
			template.cloudBadgeEl.hidden = false;
		} else {
			template.cloudBadgeEl.textContent = '';
			template.cloudBadgeEl.hidden = true;
		}

		template.countEl.textContent = String(pages.length);
		template.countEl.hidden = pages.length === 0;
		template.countEl.title = adeBi(
			localize('adeFolderPageCountTip', "{0} Project page(s)", pages.length),
			'{0} 个 Project 页面',
			pages.length,
		);

		const addTitle = adeBi(
			localize('adeCreateProjectPageInFolderTip', "New Project Page in {0}", folder.name),
			'在 {0} 下新建 Project 页面',
			folder.name,
		);
		template.addBtn.title = addTitle;
		template.addBtn.setAttribute('aria-label', addTitle);
		template.rowDisposables.add(addDisposableListener(template.addBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.onAddProjectPage(folder.uri);
		}));
		template.rowDisposables.add(addDisposableListener(template.addBtn, EventType.MOUSE_DOWN, e => {
			e.stopPropagation();
		}));
	}

	disposeTemplate(template: IFolderRowTemplate): void {
		template.templateDisposables.dispose();
	}
}

class AdeProjectPageRowRenderer implements ITreeRenderer<AdeTreeItem, FuzzyScore, IProjectPageRowTemplate> {
	static readonly TEMPLATE_ID = 'ade-project-page-row';
	readonly templateId = AdeProjectPageRowRenderer.TEMPLATE_ID;

	constructor(
		private readonly instantiationService: IInstantiationService,
		private readonly getEditingProjectId: () => string | undefined,
		private readonly isProjectActiveInEditor: (projectId: string) => boolean,
		private readonly onFinishInlineRename: (projectId: string, nextName: string | undefined) => void,
		private readonly onRequestInlineRename: (projectId: string) => void,
		private readonly onRequestDeletePage: (projectId: string) => void,
		private readonly onOpenProjectPage: (projectId: string, sideBySide: boolean) => void,
	) { }

	renderTemplate(container: HTMLElement): IProjectPageRowTemplate {
		const rowDisposables = new DisposableStore();
		const root = append(container, $('.ade-tree-row.ade-project-page-row'));
		const iconEl = append(root, $('span.ade-project-page-icon', { 'aria-hidden': 'true' }));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.organization));
		const labelHost = append(root, $('div.ade-tree-label-host'));
		const nameEl = append(labelHost, $('span.ade-project-page-name'));
		const editHost = append(root, $('div.ade-tree-edit-host'));
		editHost.hidden = true;
		const actionsEl = append(root, $('div.ade-project-page-actions'));

		const renameBtn = append(actionsEl, $('button.ade-icon-button.ade-rename-page-btn', {
			type: 'button',
			'data-action': 'rename-project-page',
		})) as HTMLButtonElement;
		append(renameBtn, $('span', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));

		const deleteBtn = append(actionsEl, $('button.ade-icon-button.ade-delete-page-btn', {
			type: 'button',
			'data-action': 'delete-project-page',
		})) as HTMLButtonElement;
		append(deleteBtn, $('span', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.trash));

		return {
			root,
			iconEl,
			labelHost,
			nameEl,
			editHost,
			actionsEl,
			renameBtn,
			deleteBtn,
			rowDisposables,
		};
	}

	renderElement(node: ITreeNode<AdeTreeItem, FuzzyScore>, _index: number, template: IProjectPageRowTemplate): void {
		template.rowDisposables.clear();
		clearNode(template.editHost);
		if (node.element.kind !== 'projectPage') {
			return;
		}
		const { page, folder } = node.element;
		const isEditing = this.getEditingProjectId() === page.projectId;
		const isActive = this.isProjectActiveInEditor(page.projectId);

		template.root.dataset.projectId = page.projectId;
		template.root.dataset.folderUri = folder.uri.toString();
		template.root.classList.toggle('is-active', isActive);
		template.root.classList.toggle('is-editing', isEditing);

		template.nameEl.textContent = page.name;
		template.nameEl.title = `${page.name} — ${formatProjectDisplayPath(folder.uri)}`;

		if (isEditing) {
			template.labelHost.hidden = true;
			template.actionsEl.hidden = true;
			template.editHost.hidden = false;

			const editBox = template.rowDisposables.add(this.instantiationService.createInstance(
				InlineEditInputBox,
				template.editHost,
				{
					startingValue: page.name,
					placeholder: adeBi(localize('adeProjectPageNamePh', "Enter Project page name"), '输入 Project 页面名称'),
					validationMessage: val => {
						if (!val.trim()) {
							return {
								content: adeBi(localize('adeProjectPageNameEmptyErr', "Project name cannot be empty."), 'Project 名称不能为空。'),
								severity: Severity.Error,
							};
						}
						return null;
					},
					onFinish: async (value, success) => {
						this.onFinishInlineRename(page.projectId, success ? value.trim() : undefined);
					},
				},
				{
					ariaLabel: adeBi(localize('adeRenameProjectPageAria', "Rename Project Page"), '重命名 Project 页面'),
					value: page.name,
				},
			));
			editBox.inputBox.inputElement.classList.add('ade-inline-rename-input');
			template.rowDisposables.add(addDisposableListener(editBox.inputBox.inputElement, EventType.CLICK, e => e.stopPropagation()));
			template.rowDisposables.add(addDisposableListener(editBox.inputBox.inputElement, EventType.MOUSE_DOWN, e => e.stopPropagation()));
			return;
		}

		template.labelHost.hidden = false;
		template.actionsEl.hidden = false;
		template.editHost.hidden = true;

		const renameLabel = adeBi(localize('adeRenameProjectPageTip', "Rename Project Page (F2)"), '重命名 Project 页面 (F2)');
		template.renameBtn.title = renameLabel;
		template.renameBtn.setAttribute('aria-label', renameLabel);
		template.rowDisposables.add(addDisposableListener(template.renameBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.onRequestInlineRename(page.projectId);
		}));
		template.rowDisposables.add(addDisposableListener(template.renameBtn, EventType.MOUSE_DOWN, e => e.stopPropagation()));

		const delLabel = adeBi(localize('adeDeleteProjectPageTip', "Delete Project Page"), '删除 Project 页面');
		template.deleteBtn.title = delLabel;
		template.deleteBtn.setAttribute('aria-label', delLabel);
		template.rowDisposables.add(addDisposableListener(template.deleteBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.onRequestDeletePage(page.projectId);
		}));
		template.rowDisposables.add(addDisposableListener(template.deleteBtn, EventType.MOUSE_DOWN, e => e.stopPropagation()));
		template.rowDisposables.add(addDisposableListener(template.root, EventType.CLICK, e => {
			if (this.getEditingProjectId() === page.projectId) {
				return;
			}
			this.onOpenProjectPage(page.projectId, Boolean(e.ctrlKey || e.metaKey || e.altKey));
		}));
	}

	disposeTemplate(template: IProjectPageRowTemplate): void {
		template.rowDisposables.dispose();
	}
}

export class AdeProjectsView extends ViewPane {
	private rootContainer: HTMLElement | undefined;
	private focusBannerEl: HTMLElement | undefined;
	private focusBannerNameEl: HTMLElement | undefined;
	private focusBannerHostEl: HTMLElement | undefined;
	private emptyStateEl: HTMLElement | undefined;
	private treeContainer: HTMLElement | undefined;
	private tree: WorkbenchAsyncDataTree<null, AdeTreeItem, FuzzyScore> | undefined;

	private readonly refreshQueue = new Sequencer();
	private readonly cloudHostService: IAdeCloudHostBackendService | undefined;
	private readonly editorService: IEditorService | undefined;

	private cloudHostsByAlias = new Map<string, IAdeCloudHost>();
	private editingProjectId: string | undefined;
	private suppressCollapseSync = false;
	private suppressTreeSelectionSync = false;
	private treeInputInitialized = false;
	private lastBodyHeight = 0;
	private lastBodyWidth = 0;

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
		@IAdeProjectsService private readonly adeProjects: IAdeProjectsService,
		@IAdeEditorService private readonly adeEditors: IAdeEditorService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		const opt = <T>(id: ServiceIdentifier<T>): T | undefined => instantiationService.invokeFunction(acc => tryGetService(acc, id));
		this.cloudHostService = opt(IAdeCloudHostBackendService);
		this.editorService = opt(IEditorService);

		if (this.cloudHostService) {
			const reloadHosts = () => {
				void this.cloudHostService?.listHosts().then(hosts => {
					const map = new Map<string, IAdeCloudHost>();
					const exactKeys = new Set<string>();
					for (const h of hosts) {
						const aliasKey = h.alias?.trim().toLowerCase();
						if (aliasKey) {
							exactKeys.add(aliasKey);
							map.set(aliasKey, h);
						}
						const idKey = h.id?.trim().toLowerCase();
						if (idKey) {
							exactKeys.add(idKey);
							map.set(idKey, h);
						}
						const hostLower = h.hostName?.trim().toLowerCase();
						if (hostLower) {
							const hp = `${hostLower}:${h.port || 22}`;
							exactKeys.add(hp);
							map.set(hp, h);
						}
					}
					for (const h of hosts) {
						const hostLower = h.hostName?.trim().toLowerCase();
						if (!hostLower || exactKeys.has(hostLower)) {
							continue;
						}
						const prev = map.get(hostLower);
						const isKali = resolveAdeOsIconKind({
							os: h.os,
							distribution: h.lastTestStatus?.remoteUname,
							hint: `${h.name ?? ''} ${h.alias ?? ''} ${h.user ?? ''} ${h.notes ?? ''}`,
						}) === 'kali';
						if (!prev || isKali) {
							map.set(hostLower, h);
						}
					}
					this.cloudHostsByAlias = map;
					void this.refresh();
				}).catch(() => undefined);
			};
			reloadHosts();
			if (this.cloudHostService.onDidChangeHosts) {
				this._register(this.cloudHostService.onDidChangeHosts(() => reloadHosts()));
			}
		}

		this._register(Event.any(
			this.adeProjects.onDidChange,
			this.projectNavigation.onDidChangeProject ?? Event.None,
			this.editorService?.onDidActiveEditorChange ?? Event.None,
			onDidChangeAdeLocale,
		)(() => {
			void this.refresh();
		}));
	}

	private getCloudHostMeta(authority: string): IAdeCloudHost | undefined {
		return this.cloudHostsByAlias.get(authority.toLowerCase());
	}

	private getVisibleFolders(): readonly IAdeProject[] {
		const focused = this.projectNavigation.focusedProject;
		if (focused) {
			const matched = this.adeProjects.projects.find(p => this.uriIdentityService.extUri.isEqual(p.uri, focused.uri));
			return matched ? [matched] : [{ uri: focused.uri, name: focused.name }];
		}
		return this.adeProjects.projects;
	}

	getRenderedFolderUris(): readonly string[] {
		return this.getVisibleFolders().map(f => f.uri.toString());
	}

	getRenderedProjectPages(folderUri?: URI): readonly IAdeProjectPageItem[] {
		if (folderUri) {
			return this.adeProjects.getProjectPagesForFolder(folderUri);
		}
		return this.adeProjects.projectPages;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-projects-view-body');
		this.rootContainer = append(container, $('.ade-sidebar-deck'));

		// Top quick-action bar
		const toolbar = this.controlsBarEl = append(this.rootContainer, $('.ade-sidebar-controls'));
		const addFolderBtn = append(toolbar, $('button.ade-deck-action-btn', {
			type: 'button',
			'data-action': 'add-workspace-folder',
			title: adeBi(localize('adeAddFolderBtnTip', "Add Local or SSH Cloud Host Folder"), '添加本地或 SSH 云主机工程文件夹'),
		})) as HTMLButtonElement;
		append(addFolderBtn, $('span', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.newFolder));
		append(addFolderBtn, $('span', {}, adeBi(localize('adeAddFolderBtnLabel', "Add Folder"), '添加文件夹')));
		this._register(addDisposableListener(addFolderBtn, EventType.CLICK, () => {
			void this.commandService.executeCommand(ADE_ADD_PROJECT_FOLDER_COMMAND_ID);
		}));

		const newPageBtn = append(toolbar, $('button.ade-deck-action-btn.primary', {
			type: 'button',
			'data-action': 'new-project-page',
			title: adeBi(localize('adeNewProjectPageBtnTip', "Create a new Project Page in the selected folder"), '在当前文件夹下新建 Project 页面'),
		})) as HTMLButtonElement;
		append(newPageBtn, $('span', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(newPageBtn, $('span', {}, adeBi(localize('adeNewProjectPageBtnLabel', "New Project"), '新建 Project')));
		this._register(addDisposableListener(newPageBtn, EventType.CLICK, () => {
			void this.createProjectPageForFolder(this.adeProjects.selectedProject?.uri);
		}));

		const hostsBtn = append(toolbar, $('button.ade-deck-action-btn.icon-only', {
			type: 'button',
			'data-action': 'manage-cloud-hosts',
			title: adeBi(localize('adeManageCloudHostsBtnTip', "Manage SSH Cloud Hosts"), '管理 SSH 云主机'),
			'aria-label': adeBi(localize('adeManageCloudHostsBtnTip', "Manage SSH Cloud Hosts"), '管理 SSH 云主机'),
		})) as HTMLButtonElement;
		append(hostsBtn, $('span', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.remote));
		this._register(addDisposableListener(hostsBtn, EventType.CLICK, () => {
			void this.commandService.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID);
		}));

		// Focus banner (hidden unless single-project focus mode is active)
		const banner = this.focusBannerEl = append(this.rootContainer, $('.ade-focus-banner'));
		banner.hidden = true;
		append(banner, $('span.ade-focus-banner-glyph', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.target));
		append(banner, $('span.ade-focus-banner-label', {}, adeBi(localize('adeFocusedLabel', "Focused"), '聚焦')));
		append(banner, $('span.ade-focus-banner-sep', { 'aria-hidden': 'true' }, '·'));
		this.focusBannerNameEl = append(banner, $('span.ade-focus-banner-name'));
		this.focusBannerHostEl = append(banner, $('span.ade-focus-banner-host'));
		const exitFocusBtn = append(banner, $('button.ade-icon-button', {
			type: 'button',
			title: adeBi(localize('adeExitFocusTip', "Show all folders"), '显示全部文件夹'),
		})) as HTMLButtonElement;
		append(exitFocusBtn, $('span', { 'aria-hidden': 'true' })).classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this._register(addDisposableListener(exitFocusBtn, EventType.CLICK, () => {
			this.projectNavigation.goHome();
		}));

		// Empty state (only when 0 workspace folders exist)
		const empty = this.emptyStateEl = append(this.rootContainer, $('.ade-sidebar-empty'));
		empty.hidden = true;
		append(empty, $('div.ade-sidebar-empty-title', {}, adeBi(
			localize('adeNoFoldersEmptyTitle', "No Workspace Folders Yet"),
			'尚未添加工程文件夹',
		)));
		append(empty, $('div.ade-sidebar-empty-desc', {}, adeBi(
			localize('adeNoFoldersEmptyDesc', "Add a local folder or connect an SSH Cloud Host folder, then create 1..N Project canvases inside it."),
			'添加本机目录或 SSH 云主机目录，即可在其下创建任意多个 Project 编排画布页面。',
		)));
		const emptyAddBtn = append(empty, $('button.ade-deck-action-btn.primary', { type: 'button' }, $('span', {}, adeBi(
			localize('adeEmptyAddFolderAction', "Add Workspace Folder..."),
			'添加工程文件夹...',
		))));
		this._register(addDisposableListener(emptyAddBtn, EventType.CLICK, () => {
			void this.commandService.executeCommand(ADE_ADD_PROJECT_FOLDER_COMMAND_ID);
		}));

		// 2-level Tree: Workspace Folder -> 0..N Project Pages
		const treeContainer = this.treeContainer = append(this.rootContainer, $('.ade-projects-tree.explorer-folders-view'));
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));
		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));
		const dnd = this._register(new AdeProjectsDragAndDrop(this.adeProjects, this.projectNavigation, this.uriIdentityService));

		const folderRenderer = new AdeFolderRowRenderer(
			labels,
			this.adeProjects,
			authority => this.getCloudHostMeta(authority),
			folderUri => { void this.createProjectPageForFolder(folderUri); },
		);
		let recentOpenKey = '';
		const openPageDedup = (projectId: string, sideBySide: boolean) => {
			if (this.editingProjectId === projectId) {
				return;
			}
			const key = `${projectId}:${sideBySide ? 1 : 0}`;
			if (recentOpenKey === key) {
				return;
			}
			recentOpenKey = key;
			queueMicrotask(() => {
				if (recentOpenKey === key) {
					recentOpenKey = '';
				}
			});
			this.adeProjects.selectProjectPage(projectId);
			void this.adeEditors.openProjectPage(projectId, { side: sideBySide });
		};

		const pageRenderer = new AdeProjectPageRowRenderer(
			this.instantiationService,
			() => this.editingProjectId,
			projectId => this.adeEditors.getActiveProjectPageId() === projectId,
			(projectId, nextName) => { void this.commitInlineRename(projectId, nextName); },
			projectId => this.startInlineRename(projectId),
			projectId => { void this.deleteProjectPageWithConfirm(projectId); },
			(projectId, sideBySide) => openPageDedup(projectId, sideBySide),
		);

		const tree = this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<null, AdeTreeItem, FuzzyScore>,
			'AdeProjectsTree',
			treeContainer,
			{
				getHeight: () => 26,
				getTemplateId: item => item.kind === 'folder' ? AdeFolderRowRenderer.TEMPLATE_ID : AdeProjectPageRowRenderer.TEMPLATE_ID,
			},
			[folderRenderer, pageRenderer],
			{
				hasChildren: element => {
					if (element === null) {
						return true;
					}
					if (element.kind === 'folder') {
						return this.adeProjects.getProjectPagesForFolder(element.folder.uri).length > 0;
					}
					return false;
				},
				getChildren: async element => {
					if (element === null) {
						return this.getVisibleFolders().map((folder): AdeTreeItem => ({ kind: 'folder', folder }));
					}
					if (element.kind === 'folder') {
						return this.adeProjects
							.getProjectPagesForFolder(element.folder.uri)
							.map((page): AdeTreeItem => ({ kind: 'projectPage', page, folder: element.folder }));
					}
					return [];
				},
			},
			{
				identityProvider: {
					getId: item => item.kind === 'folder'
						? `folder:${item.folder.uri.toString()}`
						: `page:${item.page.projectId}`,
				},
				dnd,
				accessibilityProvider: {
					getWidgetAriaLabel: () => adeBi(localize('adeProjectsTreeAria', "ADE Workspace Folders and Project Pages"), 'ADE 工作区文件夹与 Project 页面'),
					getAriaLabel: item => item.kind === 'folder'
						? `${item.folder.name} (${formatProjectDisplayPath(item.folder.uri)})`
						: item.page.name,
				},
				renderIndentGuides: RenderIndentGuides.Always,
				expandOnlyOnTwistieClick: false,
				indent: 14,
				multipleSelectionSupport: false,
			},
		));

		this._register(tree.onDidChangeCollapseState(event => {
			if (this.suppressCollapseSync) {
				return;
			}
			const el = event.node.element?.element;
			if (el && el.kind === 'folder') {
				void this.adeProjects.setFolderCollapsed?.(el.folder.uri, event.node.collapsed);
			}
		}));

		this._register(tree.onDidChangeSelection(event => {
			if (this.suppressTreeSelectionSync || this.suppressCollapseSync) {
				return;
			}
			const item = event.elements[0];
			if (!item) {
				return;
			}
			const routing = asAdeProjectsSelectionRouting(this.adeProjects);
			if (item.kind === 'folder') {
				this.adeProjects.selectProjectPage(undefined);
				this.adeProjects.selectAgent(undefined);
				this.adeProjects.selectProject(item.folder.uri);
				routing?.setSelectionSource('sidebar');
				return;
			}
			this.adeProjects.selectAgent(undefined);
			this.adeProjects.selectProjectPage(item.page.projectId);
			routing?.setSelectionSource('sidebar');
		}));

		this._register(tree.onDidOpen(event => {
			const item = event.element;
			if (!item) {
				return;
			}
			const routing = asAdeProjectsSelectionRouting(this.adeProjects);
			if (item.kind === 'folder') {
				this.adeProjects.selectProjectPage(undefined);
				this.adeProjects.selectAgent(undefined);
				this.adeProjects.selectProject(item.folder.uri);
				routing?.setSelectionSource('sidebar');
				return;
			}
			openPageDedup(item.page.projectId, Boolean(event.sideBySide));
		}));

		this._register(addStandardDisposableListener(treeContainer, EventType.KEY_DOWN, (e: IKeyboardEvent) => {
			if (this.editingProjectId) {
				return;
			}
			const focused = tree.getFocus()[0] ?? tree.getSelection()[0];
			if (!focused) {
				return;
			}
			if (e.equals(KeyCode.F2) && focused.kind === 'projectPage') {
				e.preventDefault();
				e.stopPropagation();
				this.startInlineRename(focused.page.projectId);
				return;
			}
			if ((e.equals(KeyCode.Delete) || (isMacintosh && e.metaKey && e.keyCode === KeyCode.Backspace)) && focused.kind === 'projectPage') {
				e.preventDefault();
				e.stopPropagation();
				void this.deleteProjectPageWithConfirm(focused.page.projectId);
			}
		}));

		this._register(tree.onContextMenu(event => {
			const item = event.element;
			if (!item) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => event.anchor,
					getActions: () => [
						toAction({
							id: 'ade.ctx.addFolder',
							label: adeBi(localize('adeCtxAddFolder', "Add Workspace Folder..."), '添加工程文件夹...'),
							run: () => this.commandService.executeCommand(ADE_ADD_PROJECT_FOLDER_COMMAND_ID),
						}),
						toAction({
							id: 'ade.ctx.manageCloudHosts',
							label: adeBi(localize('adeCtxManageCloudHosts', "Manage SSH Cloud Hosts..."), '管理 SSH 云主机...'),
							run: () => this.commandService.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID),
						}),
					],
				});
				return;
			}

			const routing = asAdeProjectsSelectionRouting(this.adeProjects);
			tree.setFocus([item]);
			if (item.kind === 'folder') {
				this.adeProjects.selectProjectPage(undefined);
				this.adeProjects.selectAgent(undefined);
				this.adeProjects.selectProject(item.folder.uri);
				routing?.setSelectionSource('sidebar');
				const isCloud = isCloudProjectUri(item.folder.uri);
				const actions: IAction[] = [
					toAction({
						id: 'ade.folder.newProjectPage',
						label: adeBi(localize('adeCtxNewProjectPage', "New Project Page"), '新建 Project 页面'),
						run: () => this.createProjectPageForFolder(item.folder.uri),
					}),
					new Separator(),
					toAction({
						id: 'ade.folder.openTerminal',
						label: localize('openInTerminal', "Open in Integrated Terminal"),
						run: () => this.commandService.executeCommand('workbench.action.terminal.new', { cwd: item.folder.uri }),
					}),
					...(isCloud ? [
						toAction({
							id: 'ade.folder.manageCloudHost',
							label: adeBi(localize('adeCtxManageHostForFolder', "Manage Cloud Host ({0})...", item.folder.uri.authority), '管理云主机 ({0})...', item.folder.uri.authority),
							run: () => this.commandService.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, item.folder.uri.authority),
						}),
					] : []),
					new Separator(),
					toAction({
						id: 'ade.folder.remove',
						label: adeBi(localize('adeCtxRemoveFolder', "Remove Folder from Workspace"), '从工作区移除文件夹'),
						run: () => this.commandService.executeCommand(ADE_REMOVE_PROJECT_COMMAND_ID, item.folder.uri),
					}),
					toAction({
						id: 'ade.folder.delete',
						label: adeBi(localize('adeCtxDeleteFolder', "Delete Folder..."), '删除文件夹...'),
						run: () => this.commandService.executeCommand(ADE_DELETE_PROJECT_COMMAND_ID, item.folder.uri),
					}),
				];
				this.contextMenuService.showContextMenu({
					getAnchor: () => event.anchor,
					getActions: () => actions,
				});
				return;
			}

			// Project Page context menu
			this.adeProjects.selectAgent(undefined);
			this.adeProjects.selectProjectPage(item.page.projectId);
			routing?.setSelectionSource('sidebar');
			const pageActions: IAction[] = [
				toAction({
					id: 'ade.page.open',
					label: adeBi(localize('adeCtxOpenProjectCanvas', "Open Project Canvas"), '打开 Project 编排画布'),
					run: () => this.adeEditors.openProjectPage(item.page.projectId),
				}),
				toAction({
					id: 'ade.page.openSide',
					label: adeBi(localize('adeCtxOpenProjectSide', "Open to the Side"), '在侧边分屏打开'),
					run: () => this.adeEditors.openProjectPage(item.page.projectId, { side: true, preferExistingGroup: false }),
				}),
				new Separator(),
				toAction({
					id: 'ade.page.openTerminal',
					label: localize('openInTerminal', "Open in Integrated Terminal"),
					run: () => this.commandService.executeCommand('workbench.action.terminal.new', { cwd: item.folder.uri }),
				}),
				new Separator(),
				toAction({
					id: 'ade.page.rename',
					label: adeBi(localize('adeCtxRenameProjectPage', "Rename Project Page (F2)"), '重命名 Project 页面 (F2)'),
					run: () => this.startInlineRename(item.page.projectId),
				}),
				toAction({
					id: 'ade.page.configureStorage',
					label: adeBi(localize('adeCtxConfigureTicketStorage', "Configure Cross-Host Ticket Storage..."), '配置默认跨机 Ticket 存储主机...'),
					run: () => this.configureProjectTicketStorage(item.page.projectId),
				}),
				new Separator(),
				toAction({
					id: 'ade.page.delete',
					label: adeBi(localize('adeCtxDeleteProjectPage', "Delete Project Page..."), '删除 Project 页面...'),
					run: () => this.deleteProjectPageWithConfirm(item.page.projectId),
				}),
			];
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.anchor,
				getActions: () => pageActions,
			});
		}));

		void this.adeProjects.whenReady().then(() => this.refresh());
		void this.refresh();
	}

	async createProjectPageForFolder(targetFolderUri?: URI, explicitName?: string): Promise<IAdeProjectPageItem | undefined> {
		let folderUri = targetFolderUri ?? this.adeProjects.selectedProject?.uri;
		if (!folderUri) {
			const picked = await this.instantiationService.invokeFunction(acc => pickProjectFoldersWithCloudOption(acc, {
				title: adeBi(localize('adePickFolderForNewPage', "Select Workspace Folder for New Project Page"), '选择要创建 Project 页面的工程文件夹'),
			}));
			folderUri = picked?.[0];
			if (!folderUri) {
				return undefined;
			}
			const norm = removeTrailingPathSeparator(folderUri);
			await (this.adeProjects.registerWorkspaceFolderAsync
				? this.adeProjects.registerWorkspaceFolderAsync(norm, basename(norm) || norm.authority || 'workspace')
				: Promise.resolve(this.adeProjects.registerProject(norm, basename(norm) || norm.authority || 'workspace')));
			folderUri = norm;
		}
		if (this.adeProjects.setFolderCollapsed) {
			await this.adeProjects.setFolderCollapsed(folderUri, false);
		}
		const snap = await this.adeProjects.createProjectPage(folderUri, explicitName);
		await Promise.all([
			this.adeEditors.openProjectPage(snap.meta.project_id),
			this.refresh(),
		]);
		return this.adeProjects.getProjectPage(snap.meta.project_id);
	}

	async startInlineRename(projectId: string): Promise<void> {
		if (!this.adeProjects.getProjectPage(projectId)) {
			return;
		}
		this.editingProjectId = projectId;
		await this.refresh();
	}

	private async commitInlineRename(projectId: string, nextName: string | undefined): Promise<void> {
		if (this.editingProjectId !== projectId) {
			return;
		}
		this.editingProjectId = undefined;
		const existing = this.adeProjects.getProjectPage(projectId);
		if (nextName && existing && nextName !== existing.name) {
			await this.adeProjects.renameProjectPage(projectId, nextName);
		}
		await this.refresh();
	}

	async configureProjectTicketStorage(projectId: string, targetHost?: string): Promise<string | undefined> {
		return this.instantiationService.invokeFunction(acc => configureAdeProjectTicketStorage(acc, projectId, targetHost));
	}

	async deleteProjectPageWithConfirm(projectId: string, skipConfirm = false): Promise<boolean> {
		const deleted = await this.instantiationService.invokeFunction(acc => confirmAndDeleteAdeProjectPage(acc, projectId, skipConfirm));
		if (deleted) {
			await this.refresh();
		}
		return deleted;
	}

	private updateFocusBanner(): void {
		if (!this.focusBannerEl || !this.focusBannerNameEl || !this.focusBannerHostEl) {
			return;
		}
		const focused = this.projectNavigation.focusedProject;
		if (!focused) {
			this.focusBannerEl.hidden = true;
			return;
		}
		this.focusBannerEl.hidden = false;
		this.focusBannerNameEl.textContent = focused.name;
		if (isCloudProjectUri(focused.uri)) {
			this.focusBannerHostEl.textContent = focused.uri.authority;
			this.focusBannerHostEl.hidden = false;
		} else {
			this.focusBannerHostEl.textContent = '';
			this.focusBannerHostEl.hidden = true;
		}
	}

	async refresh(): Promise<void> {
		await this.refreshQueue.queue(async () => {
			this.updateFocusBanner();
			if (!this.tree || !this.treeContainer || !this.emptyStateEl) {
				return;
			}
			const folders = this.getVisibleFolders();
			if (folders.length === 0) {
				this.emptyStateEl.hidden = false;
				this.treeContainer.hidden = true;
				return;
			}
			this.emptyStateEl.hidden = true;
			this.treeContainer.hidden = false;

			this.suppressCollapseSync = true;
			this.suppressTreeSelectionSync = true;
			try {
				if (!this.treeInputInitialized) {
					this.treeInputInitialized = true;
					await this.tree.setInput(null);
				} else {
					await this.tree.updateChildren(null, true, false);
				}
				const rootChildren = [...this.tree.getNode(null).children];
				for (const childNode of rootChildren) {
					const elem = childNode.element;
					if (!elem || elem.kind !== 'folder') {
						continue;
					}
					const pages = this.adeProjects.getProjectPagesForFolder(elem.folder.uri);
					if (pages.length === 0) {
						await this.tree.updateChildren(elem, false, false);
						continue;
					}
					if (elem.folder.collapsed) {
						this.tree.collapse(elem, false);
					} else {
						await this.tree.updateChildren(elem, false, false);
						await this.tree.expand(elem, false);
					}
				}
			} finally {
				this.suppressTreeSelectionSync = false;
				this.suppressCollapseSync = false;
			}
			this.layoutTree();
		});
	}

	private controlsBarEl: HTMLElement | undefined;

	private layoutTree(): void {
		if (!this.tree || !this.rootContainer || this.lastBodyHeight <= 0) {
			return;
		}
		const controlsH = this.controlsBarEl?.offsetHeight ?? 32;
		const bannerH = this.focusBannerEl && !this.focusBannerEl.hidden ? this.focusBannerEl.offsetHeight : 0;
		this.tree.layout(Math.max(0, this.lastBodyHeight - controlsH - bannerH), this.lastBodyWidth);
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

function registerCommandSafe(id: string, handler: (accessor: ServicesAccessor, ...args: unknown[]) => unknown): void {
	if (!CommandsRegistry.getCommand(id)) {
		CommandsRegistry.registerCommand(id, handler);
	}
}

registerCommandSafe(ADE_ADD_PROJECT_FOLDER_COMMAND_ID, async (accessor: ServicesAccessor, explicitUri?: unknown) => {
	const projects = accessor.get(IAdeProjectsService);
	const instantiationService = accessor.get(IInstantiationService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const contextService = tryGetService(accessor, IWorkspaceContextService);
	const workspaceEditing = tryGetService(accessor, IWorkspaceEditingService);
	const environmentService = tryGetService(accessor, IWorkbenchEnvironmentService);
	const fileService = tryGetService(accessor, IFileService);

	const uris: URI[] = URI.isUri(explicitUri)
		? [explicitUri]
		: (await instantiationService.invokeFunction(acc => pickProjectFoldersWithCloudOption(acc))) ?? [];
	if (uris.length === 0) {
		return undefined;
	}
	let lastAdded: IAdeProject | undefined;
	for (const raw of uris) {
		const norm = removeTrailingPathSeparator(raw);
		const name = basename(norm) || norm.authority || 'workspace';
		lastAdded = projects.registerWorkspaceFolderAsync
			? await projects.registerWorkspaceFolderAsync(norm, name)
			: projects.registerProject(norm, name);
	}
	await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
	if (lastAdded) {
		projects.selectProject(lastAdded.uri);
	}
	return lastAdded;
});

registerCommandSafe(ADE_ADD_CLOUD_PROJECT_COMMAND_ID, async (accessor: ServicesAccessor, hostAlias?: unknown) => {
	const instantiationService = accessor.get(IInstantiationService);
	const projects = accessor.get(IAdeProjectsService);
	const uriIdentity = accessor.get(IUriIdentityService);
	const contextService = tryGetService(accessor, IWorkspaceContextService);
	const workspaceEditing = tryGetService(accessor, IWorkspaceEditingService);
	const environmentService = tryGetService(accessor, IWorkbenchEnvironmentService);
	const fileService = tryGetService(accessor, IFileService);

	const picked = await instantiationService.invokeFunction(acc =>
		pickCloudHostProjectFolder(acc, typeof hostAlias === 'string' ? hostAlias : undefined),
	);
	if (!picked) {
		return undefined;
	}
	const norm = removeTrailingPathSeparator(picked);
	const name = basename(norm) || norm.authority || 'workspace';
	const added = projects.registerWorkspaceFolderAsync
		? await projects.registerWorkspaceFolderAsync(norm, name)
		: projects.registerProject(norm, name);
	await reconcileIdeWorkspaceWithCatalog({ projects, contextService, workspaceEditing, environmentService, fileService, uriIdentity });
	projects.selectProject(added.uri);
	return added;
});

registerCommandSafe(ADE_CREATE_PROJECT_PAGE_COMMAND_ID, async (accessor: ServicesAccessor, rawFolderUri?: unknown, rawName?: unknown) => {
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const views = tryGetService(accessor, IViewsService);
	const view = views?.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
	const folderUri = URI.isUri(rawFolderUri)
		? rawFolderUri
		: (typeof rawFolderUri === 'string' && rawFolderUri.trim() ? URI.parse(rawFolderUri) : projects.selectedProject?.uri);
	const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
	if (view) {
		return view.createProjectPageForFolder(folderUri, name);
	}
	if (!folderUri) {
		return undefined;
	}
	const snap = await projects.createProjectPage(folderUri, name);
	await editors.openProjectPage(snap.meta.project_id);
	return projects.getProjectPage(snap.meta.project_id);
});

registerCommandSafe(ADE_OPEN_PROJECT_PAGE_COMMAND_ID, async (accessor: ServicesAccessor, rawProjectId?: unknown) => {
	const projects = accessor.get(IAdeProjectsService);
	const editors = accessor.get(IAdeEditorService);
	const quickInput = tryGetService(accessor, IQuickInputService);
	if (typeof rawProjectId === 'string' && rawProjectId.trim()) {
		await editors.openProjectPage(rawProjectId.trim());
		return;
	}
	const pages = projects.projectPages;
	if (pages.length === 0) {
		if (projects.selectedProject) {
			const snap = await projects.createProjectPage(projects.selectedProject.uri);
			await editors.openProjectPage(snap.meta.project_id);
		}
		return;
	}
	if (!quickInput || pages.length === 1) {
		await editors.openProjectPage(pages[0].projectId);
		return;
	}
	const picked = await quickInput.pick(
		pages.map(p => ({
			label: p.name,
			description: formatProjectDisplayPath(p.folderUri),
			projectId: p.projectId,
		})),
		{
			placeHolder: adeBi(localize('adePickProjectPageToOpen', "Select a Project Page to open"), '选择要打开的 Project 页面'),
			matchOnDescription: true,
		},
	);
	if (picked) {
		await editors.openProjectPage(picked.projectId);
	}
});

registerCommandSafe(ADE_RENAME_PROJECT_PAGE_COMMAND_ID, async (accessor: ServicesAccessor, rawProjectId?: unknown, rawNextName?: unknown) => {
	const projects = accessor.get(IAdeProjectsService);
	const editors = tryGetService(accessor, IAdeEditorService);
	const views = tryGetService(accessor, IViewsService);
	const projectId = resolveTargetProjectPageId(projects, editors, rawProjectId);
	if (!projectId) {
		return undefined;
	}
	if (typeof rawNextName === 'string' && rawNextName.trim()) {
		return promptRenameAdeProjectPage(accessor, projectId, rawNextName);
	}
	const view = views?.getActiveViewWithId<AdeProjectsView>(ADE_PROJECTS_VIEW_ID);
	if (view) {
		await view.startInlineRename(projectId);
		return undefined;
	}
	return promptRenameAdeProjectPage(accessor, projectId);
});

registerCommandSafe(ADE_DELETE_PROJECT_PAGE_COMMAND_ID, (accessor: ServicesAccessor, rawProjectId?: unknown, rawSkipConfirm?: unknown) => {
	return confirmAndDeleteAdeProjectPage(accessor, rawProjectId, rawSkipConfirm === true);
});

registerCommandSafe(ADE_CONFIGURE_PROJECT_STORAGE_COMMAND_ID, (accessor: ServicesAccessor, rawProjectId?: unknown, rawTargetHost?: unknown) => {
	return configureAdeProjectTicketStorage(accessor, rawProjectId, rawTargetHost);
});

registerCommandSafe(ADE_REMOVE_PROJECT_COMMAND_ID, (accessor: ServicesAccessor, rawTargets?: unknown) => {
	const normalized = URI.isUri(rawTargets) || Array.isArray(rawTargets) ? rawTargets as URI | readonly URI[] : undefined;
	return removeProjectsSynchronized(accessor, normalized);
});

registerCommandSafe(ADE_DELETE_PROJECT_COMMAND_ID, (accessor: ServicesAccessor, rawTargets?: unknown) => {
	const normalized = URI.isUri(rawTargets) || Array.isArray(rawTargets) ? rawTargets as URI | readonly URI[] : undefined;
	return deleteProjectsWithModePrompt(accessor, 'ade', normalized);
});

registerCommandSafe(ADE_RENAME_PROJECT_COMMAND_ID, async (accessor: ServicesAccessor, rawUri?: unknown, rawName?: unknown) => {
	const projects = accessor.get(IAdeProjectsService);
	const quickInput = tryGetService(accessor, IQuickInputService);
	const targetUri = URI.isUri(rawUri) ? rawUri : projects.selectedProject?.uri;
	if (!targetUri) {
		return;
	}
	const nextName = typeof rawName === 'string' && rawName.trim()
		? rawName.trim()
		: await quickInput?.input({
			value: projects.getProjectName(targetUri),
			prompt: adeBi(localize('adeRenameFolderPrompt', "Enter folder display name"), '输入文件夹显示名称'),
		});
	if (nextName?.trim()) {
		if (projects.registerWorkspaceFolderAsync) {
			await projects.registerWorkspaceFolderAsync(targetUri, nextName.trim());
		} else {
			projects.registerProject(targetUri, nextName.trim());
		}
	}
});

registerCommandSafe(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, async (accessor: ServicesAccessor, hostIdOrAlias?: unknown) => {
	const editors = accessor.get(IAdeEditorService);
	await editors.openCloudHosts?.(typeof hostIdOrAlias === 'string' ? hostIdOrAlias : undefined);
});

registerCommandSafe(ADE_IMPORT_VSCODE_CLOUD_HOSTS_COMMAND_ID, async (accessor: ServicesAccessor) => {
	const backend = tryGetService(accessor, IAdeCloudHostBackendService);
	const notifications = tryGetService(accessor, INotificationService);
	if (!backend) {
		return undefined;
	}
	const res = await backend.importFromVsCodeAndSshConfig();
	notifications?.info(localize(
		'adeImportedCloudHostsDone',
		"Synced {0} Cloud Host(s) ({1} new, {2} updated).",
		res.totalHosts,
		res.importedCount,
		res.updatedCount,
	));
	return res;
});
