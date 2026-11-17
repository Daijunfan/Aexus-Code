/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { IDragAndDropData } from '../../../../base/browser/dnd.js';
import { $, addDisposableListener, addStandardDisposableListener, append, clearNode, EventHelper, EventType } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { ListDragOverEffectPosition, ListDragOverEffectType } from '../../../../base/browser/ui/list/list.js';
import { ElementsDragAndDropData, ListViewTargetSector } from '../../../../base/browser/ui/list/listView.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { ITreeDragAndDrop, ITreeDragOverReaction, ITreeNode, ITreeRenderer, TreeDragOverBubble } from '../../../../base/browser/ui/tree/tree.js';
import { IAction, Separator, toAction } from '../../../../base/common/actions.js';
import { Sequencer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import Severity from '../../../../base/common/severity.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { createFileIconThemableTreeContainerScope, IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { InlineEditInputBox } from '../../../browser/parts/views/inlineEditInputBox.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IEditableData, IViewDescriptorService } from '../../../common/views.js';
import { IAdeEngineeringService, IAdeInboxService } from '../../../../platform/ade/common/adeEngineering.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ADE_DELETE_PROJECT_COMMAND_ID, ADE_OPEN_ENGINEERING_COMMAND_ID, ADE_REMOVE_PROJECT_COMMAND_ID, AdeSessionRank, getAdeRoleRankLevel, getNextLowerAdeRole, IAdeAgent, IAdeEditorService, IAdeProject, IAdeProjectsService, resolveAdeAgentRank } from '../common/ade.js';
import { AdeInboxPanel } from './adeInboxView.js';
import { IAdeSessionsService } from './adeSessionsService.js';

export type AdeTreeItem =
	| { readonly kind: 'project'; readonly project: IAdeProject }
	| { readonly kind: 'agent'; readonly agent: IAdeAgent };

function formatRoleBadgeLabel(rank: AdeSessionRank): string {
	switch (rank) {
		case 'governor':
			return localize('adeRoleGovernor', "Governor");
		case 'manager':
			return localize('adeRoleManager', "Manager");
		case 'employee':
			return localize('adeRoleEmployee', "Employee");
		case 'subordinate':
			return localize('adeRoleMember', "Member");
		case 'worker':
			return localize('adeRoleWorker', "Worker");
	}
}

function formatNewSubSessionLabel(childRank: AdeSessionRank): string {
	switch (childRank) {
		case 'manager':
			return localize('adeNewManagerSubSession', "New Manager Sub-Session...");
		case 'employee':
			return localize('adeNewEmployeeSubSession', "New Employee Sub-Session...");
		case 'worker':
			return localize('adeNewWorkerSubSession', "New Worker Sub-Session...");
		default:
			return localize('adeAddSubSessionAria', "New Sub-Session...");
	}
}

export class AdeProjectsDragAndDrop implements ITreeDragAndDrop<AdeTreeItem> {
	constructor(
		private readonly projects: IAdeProjectsService,
		private readonly navigation: IProjectNavigationService,
		private readonly onAgentReparented: (agentId: string) => void,
	) { }

	private canReorderProjects(): boolean {
		return !this.navigation.focusedProject;
	}

	getDragURI(item: AdeTreeItem): string | null {
		if (item.kind === 'project') {
			return this.canReorderProjects() ? item.project.uri.toString() : null;
		}
		if (this.projects.isLockedByWorkTree?.(item.agent.id)) {
			return null;
		}
		return `ade-agent:${item.agent.id}`;
	}

	getDragLabel(items: AdeTreeItem[]): string | undefined {
		const first = items[0];
		if (!first) {
			return undefined;
		}
		return first.kind === 'project' ? first.project.name : first.agent.label;
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

		if (dragged.kind === 'project') {
			if (!this.canReorderProjects() || (target && (target.kind !== 'project' || target.project.uri.toString() === dragged.project.uri.toString()))) {
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

		// Dragging an agent session: drop onto any non-Worker session (same or different project) to hot-swap supervisors, or onto any project folder to move to top-level!
		const sourceAgent = dragged.agent;
		if (!target) {
			return false;
		}
		if (target.kind === 'agent') {
			if (!this.projects.canReparentAgent(sourceAgent.id, target.agent.id)) {
				return false;
			}
			return {
				accept: true,
				bubble: TreeDragOverBubble.Down,
				autoExpand: true,
				effect: {
					type: ListDragOverEffectType.Move,
					position: ListDragOverEffectPosition.Over,
				},
			};
		}

		// Target is a project folder row: allow dropping a nested child (or another project's agent) onto a project folder
		if (this.projects.canReparentAgent(sourceAgent.id, undefined, target.project.uri)) {
			return {
				accept: true,
				bubble: TreeDragOverBubble.Down,
				autoExpand: true,
				effect: {
					type: ListDragOverEffectType.Move,
					position: ListDragOverEffectPosition.Over,
				},
			};
		}
		return false;
	}

	drop(data: IDragAndDropData, target: AdeTreeItem | undefined, targetIndex: number | undefined, sector: ListViewTargetSector | undefined): void {
		if (!this.onDragOver(data, target, targetIndex, sector)) {
			return;
		}
		const dragged = this.getDraggedItem(data);
		if (!dragged) {
			return;
		}
		if (dragged.kind === 'project') {
			const after = !target || sector === ListViewTargetSector.CENTER_BOTTOM || sector === ListViewTargetSector.BOTTOM;
			this.projects.moveProjectFolder(dragged.project.uri, target?.kind === 'project' ? target.project.uri : undefined, after);
			return;
		}

		if (!target) {
			return;
		}
		const newParentId = target.kind === 'agent' ? target.agent.id : undefined;
		const targetProjectUri = target.kind === 'project' ? target.project.uri : undefined;
		if (this.projects.reparentAgent(dragged.agent.id, newParentId, targetProjectUri)) {
			this.onAgentReparented(dragged.agent.id);
		}
	}

	dispose(): void { }
}

interface IAdeTreeTemplate {
	readonly row: HTMLElement;
	readonly iconNode: HTMLElement;
	readonly labelHost: HTMLElement;
	readonly label: IResourceLabel;
	readonly editHost: HTMLElement;
	readonly countBadge: HTMLElement;
	readonly addSessionBtn: HTMLElement;
	readonly workTreeBadge: HTMLElement;
	readonly roleBadge: HTMLElement;
	readonly statusIndicator: HTMLElement;
	readonly editDisposables: DisposableStore;
	readonly templateDisposables: DisposableStore;
}

class AdeTreeRenderer implements ITreeRenderer<AdeTreeItem, FuzzyScore, IAdeTreeTemplate> {
	readonly templateId = 'ade-project-item';

	constructor(
		private readonly labels: ResourceLabels,
		private readonly projects: IAdeProjectsService,
		private readonly sessions: IAdeSessionsService,
		private readonly uriIdentity: IUriIdentityService,
		private readonly instantiationService: IInstantiationService,
		private readonly hoverService: IHoverService,
		private readonly onNewProjectSession: (projectUri: URI) => void,
		private readonly onNewSubSession: (parentId: string) => void,
		private readonly onSetAgentRole: (agentId: string) => void,
		private readonly onOpenEngineering: (governorId: string) => void,
		private readonly getEditableData: (agent: IAdeAgent) => IEditableData | undefined,
	) { }

	renderTemplate(container: HTMLElement): IAdeTreeTemplate {
		const templateDisposables = new DisposableStore();
		const row = append(container, $('.ade-tree-row'));
		const iconNode = append(row, $('span.ade-tree-item-icon'));
		const labelHost = append(row, $('.ade-tree-label-host'));
		const label = this.labels.create(labelHost, { supportHighlights: true, supportDescriptionHighlights: true });
		const editHost = append(row, $('.ade-tree-edit-host'));
		editHost.hidden = true;
		const trailing = append(row, $('.ade-tree-trailing'));
		const countBadge = append(trailing, $('span.ade-project-count'));
		countBadge.hidden = true;
		const addSessionBtn = append(trailing, $('button.ade-icon-button.ade-project-add-btn', {
			type: 'button',
			'aria-label': localize('adeNewProjectSessionBtn', "New Session in Project..."),
		}));
		addSessionBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		addSessionBtn.hidden = true;
		const workTreeBadge = append(trailing, $('span.ade-worktree-badge'));
		workTreeBadge.hidden = true;
		const roleBadge = append(trailing, $('span.ade-role-badge'));
		roleBadge.hidden = true;
		const statusIndicator = append(trailing, $('span.ade-status-dot'));
		statusIndicator.hidden = true;
		return {
			row,
			iconNode,
			labelHost,
			label,
			editHost,
			countBadge,
			addSessionBtn,
			workTreeBadge,
			roleBadge,
			statusIndicator,
			editDisposables: new DisposableStore(),
			templateDisposables,
		};
	}

	private applyItemIcon(iconNode: HTMLElement, icon: ThemeIcon | URI): void {
		if (URI.isUri(icon)) {
			iconNode.className = 'ade-tree-item-icon ade-tree-item-icon-svg';
			iconNode.style.backgroundImage = asCSSUrl(icon);
		} else {
			iconNode.className = `ade-tree-item-icon ${ThemeIcon.asClassName(icon)}`;
			iconNode.style.backgroundImage = '';
		}
	}

	private applyStatusIndicator(element: HTMLElement, kind: 'working' | 'pending' | 'unread' | 'none', isBubble = false): void {
		if (kind === 'none') {
			element.hidden = true;
			element.className = 'ade-status-dot';
			return;
		}
		element.hidden = false;
		if (kind === 'working' && !isBubble) {
			element.className = `ade-status-dot working ${ThemeIcon.asClassName(ThemeIcon.modify(Codicon.loading, 'spin'))}`;
		} else {
			element.className = `ade-status-dot ${kind}${isBubble ? ' bubble' : ''}`;
		}
	}

	renderElement(node: ITreeNode<AdeTreeItem, FuzzyScore>, _index: number, template: IAdeTreeTemplate): void {
		template.editDisposables.clear();
		template.editHost.hidden = true;
		template.labelHost.hidden = false;
		template.row.classList.remove('editing', 'ade-orchestrated-agent', 'ade-pure-worker', 'ade-project-row');

		const item = node.element;
		if (item.kind === 'project') {
			template.row.classList.add('ade-project-row');
			template.workTreeBadge.hidden = true;
			template.roleBadge.hidden = true;
			const addProjectLabel = localize('adeNewProjectSessionBtn', "New Session in Project...");
			template.addSessionBtn.hidden = false;
			template.addSessionBtn.setAttribute('aria-label', addProjectLabel);
			template.editDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.addSessionBtn, addProjectLabel));
			template.editDisposables.add(addDisposableListener(template.addSessionBtn, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onNewProjectSession(item.project.uri);
			}));

			const rootCount = this.projects.agents.filter(agent =>
				!agent.parentId
				&& this.uriIdentity.extUri.isEqual(agent.projectUri, item.project.uri)
				&& Boolean(agent.archived) === this.projects.showArchived
			).length;
			if (rootCount > 0) {
				template.countBadge.textContent = String(rootCount);
				template.countBadge.hidden = false;
			} else {
				template.countBadge.hidden = true;
			}

			this.applyItemIcon(template.iconNode, Codicon.folder);
			template.label.setResource({
				resource: item.project.uri,
				name: item.project.name,
			}, {
				hideIcon: true,
				fileKind: FileKind.FOLDER,
				title: item.project.uri.fsPath,
				extraClasses: ['explorer-item', 'ade-project-folder-row'],
			});

			if (node.collapsed) {
				const projectAgents = this.projects.agents.filter(agent => !this.projects.isArchived(agent.id) && this.uriIdentity.extUri.isEqual(agent.projectUri, item.project.uri));
				const hasWorking = projectAgents.some(agent => agent.status === 'working');
				const hasPending = !hasWorking && projectAgents.some(agent => agent.status === 'pending');
				const hasUnread = !hasWorking && !hasPending && projectAgents.some(agent => Boolean(agent.unread));
				this.applyStatusIndicator(template.statusIndicator, hasWorking ? 'working' : hasPending ? 'pending' : hasUnread ? 'unread' : 'none', true);
			} else {
				this.applyStatusIndicator(template.statusIndicator, 'none');
			}
			return;
		}

		template.countBadge.hidden = true;

		const agent = item.agent;
		const isLocked = Boolean(this.projects.isLockedByWorkTree?.(agent.id));
		const hasSubs = this.projects.hasSubordinates(agent.id);
		const rank = resolveAdeAgentRank(agent, hasSubs);
		const nextLower = getNextLowerAdeRole(agent.role, hasSubs);
		if (nextLower.canSpawnSubSession && !isLocked) {
			const subLabel = formatNewSubSessionLabel(nextLower.childRank);
			template.addSessionBtn.hidden = false;
			template.addSessionBtn.setAttribute('aria-label', subLabel);
			template.editDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.addSessionBtn, subLabel));
			template.editDisposables.add(addDisposableListener(template.addSessionBtn, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onNewSubSession(agent.id);
			}));
		} else {
			template.addSessionBtn.hidden = true;
		}
		const session = agent.session;
		const effectiveEngineId = session?.engineId ?? agent.preferredEngineId;
		const orchestrated = this.projects.isOrchestrated(agent);
		template.row.classList.add(orchestrated ? 'ade-orchestrated-agent' : 'ade-pure-worker');
		if (isLocked) {
			template.row.classList.add('ade-worktree-locked');
		}

		const icon = effectiveEngineId ? (this.sessions.getIcon(effectiveEngineId) ?? Codicon.commentDiscussion) : Codicon.comment;
		const engineTitle = effectiveEngineId ? this.sessions.getEngineName(effectiveEngineId) : localize('adeDraftSession', "Draft");
		const badgeLabel = formatRoleBadgeLabel(rank);

		this.applyItemIcon(template.iconNode, icon);
		template.label.setResource({
			name: agent.label,
			resource: session?.resource ?? agent.projectUri,
		}, {
			hideIcon: true,
			fileKind: FileKind.FILE,
			title: `${engineTitle} (${badgeLabel}${!session && agent.preferredEngineId ? ' · Lazy' : ''}) • ${agent.projectUri.fsPath}`,
			extraClasses: ['explorer-item', 'ade-agent-session-row'],
		});

		if (!agent.parentId && agent.treeType) {
			const isRes = agent.treeType === 'research';
			template.workTreeBadge.textContent = isRes ? localize('adeBadgeResearch', "Research") : localize('adeBadgeEngineering', "Engineering");
			template.workTreeBadge.className = `ade-worktree-badge type-${agent.treeType}`;
			template.workTreeBadge.hidden = false;
			const treeTooltip = localize('adeOpenEngineeringBadgeTooltip', "Open {0} DAG Canvas", template.workTreeBadge.textContent);
			template.editDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.workTreeBadge, treeTooltip));
			template.editDisposables.add(addDisposableListener(template.workTreeBadge, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onOpenEngineering(agent.id);
			}));
		} else {
			template.workTreeBadge.hidden = true;
		}

		template.roleBadge.textContent = badgeLabel;
		template.roleBadge.className = `ade-role-badge role-${rank}${isLocked ? ' locked' : ''}`;
		template.roleBadge.hidden = false;
		const roleTooltip = isLocked
			? localize('adeLockedRoleBadgeTooltip', "Role: {0} (Locked by Engineering Blueprint)", badgeLabel)
			: rank === 'worker'
				? localize('adeWorkerBadgeTooltip', "Role: Worker (Clean Native Context) — Click to change role")
				: localize('adeStaffBadgeTooltip', "Role: {0} — Click to change role", badgeLabel);
		template.editDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.roleBadge, roleTooltip));
		if (!isLocked) {
			template.editDisposables.add(addDisposableListener(template.roleBadge, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onSetAgentRole(agent.id);
			}));
		}

		const ownStatus = agent.status === 'working' ? 'working'
			: agent.status === 'pending' ? 'pending'
				: agent.unread ? 'unread'
					: 'none';
		if (ownStatus !== 'none') {
			this.applyStatusIndicator(template.statusIndicator, ownStatus, false);
		} else if (node.collapsed) {
			const descendants = this.projects.getSubtree(agent.id).slice(1);
			const descWorking = descendants.some(child => child.status === 'working');
			const descPending = !descWorking && descendants.some(child => child.status === 'pending');
			const descUnread = !descWorking && !descPending && descendants.some(child => Boolean(child.unread));
			this.applyStatusIndicator(template.statusIndicator, descWorking ? 'working' : descPending ? 'pending' : descUnread ? 'unread' : 'none', true);
		} else {
			this.applyStatusIndicator(template.statusIndicator, 'none');
		}

		const editableData = this.getEditableData(agent);
		if (editableData) {
			template.row.classList.add('editing');
			template.labelHost.hidden = true;
			template.workTreeBadge.hidden = true;
			template.roleBadge.hidden = true;
			template.editHost.hidden = false;
			clearNode(template.editHost);
			template.editDisposables.add(this.instantiationService.createInstance(InlineEditInputBox, template.editHost, {
				...editableData,
				onFinish: async (value, success) => {
					template.row.classList.remove('editing');
					template.editHost.hidden = true;
					template.labelHost.hidden = false;
					template.editDisposables.clear();
					await editableData.onFinish(value, success);
				},
			}, {
				value: agent.label,
				ariaLabel: localize('adeInlineRenameAria', "Type conversation name. Press Enter to confirm or Escape to cancel."),
			}));
		}
	}

	disposeElement(_node: ITreeNode<AdeTreeItem, FuzzyScore>, _index: number, template: IAdeTreeTemplate): void {
		template.editDisposables.clear();
	}

	disposeTemplate(template: IAdeTreeTemplate): void {
		template.editDisposables.dispose();
		template.templateDisposables.dispose();
		template.label.dispose();
	}
}

export class AdeProjectsView extends ViewPane {
	private tree: WorkbenchAsyncDataTree<AdeTreeItem[], AdeTreeItem, FuzzyScore> | undefined;
	private secretaryBar: HTMLElement | undefined;
	private secretaryContextPill: HTMLElement | undefined;
	private secretaryStatusDot: HTMLElement | undefined;
	private controlsBar: HTMLElement | undefined;
	private sectionTitleLabel: HTMLElement | undefined;
	private projectsTabBtn: HTMLElement | undefined;
	private inboxTabBtn: HTMLElement | undefined;
	private inboxBadgeEl: HTMLElement | undefined;
	private archivedToggleButton: HTMLElement | undefined;
	private treeHost: HTMLElement | undefined;
	private inboxPanel: AdeInboxPanel | undefined;
	private sidebarMode: 'projects' | 'inbox' = 'projects';
	private readonly engineeringService: IAdeEngineeringService | undefined;
	private readonly inboxService: IAdeInboxService | undefined;
	private emptyStateHost: HTMLElement | undefined;
	private emptyStateMessage: HTMLElement | undefined;
	private readonly emptyActionDisposables = this._register(new DisposableStore());
	private readonly refreshQueue = new Sequencer();
	private readonly autoExpandedProjects = new Set<string>();
	private editingAgentId: string | undefined;
	private pendingRefresh = false;
	private lastHeight = 0;
	private lastWidth = 0;

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
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IAdeEditorService private readonly editors: IAdeEditorService,
		@IProjectNavigationService private readonly projectNavigation: IProjectNavigationService,
		@IStorageService private readonly storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IAdeSessionsService private readonly sessions: IAdeSessionsService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(projects.onDidChange(change => {
			this.updateHeaderControls();
			void this.refresh(change === 'order');
		}));
		this._register(projectNavigation.onDidChangeProject(() => {
			this.updateHeaderControls();
			void this.refresh();
		}));
		this._register(themeService.onDidColorThemeChange(() => this.refreshAgentIcons()));
		this._register(sessions.onDidChangeEngines(() => {
			this.updateHeaderControls();
			this.refreshAgentIcons();
		}));

		const [engSvc, inbSvc] = instantiationService.invokeFunction(accessor => {
			let eng: IAdeEngineeringService | undefined;
			let inb: IAdeInboxService | undefined;
			try { eng = accessor.get(IAdeEngineeringService); } catch { eng = undefined; }
			try { inb = accessor.get(IAdeInboxService); } catch { inb = undefined; }
			return [eng, inb] as const;
		});
		this.engineeringService = engSvc;
		this.inboxService = inbSvc;
		if (this.inboxService) {
			this._register(this.inboxService.onDidChange(() => this.updateHeaderControls()));
		}
	}

	get selectedAgent(): IAdeAgent | undefined {
		const selected = this.tree?.getFocus()[0] ?? this.tree?.getSelection()[0];
		return selected?.kind === 'agent' ? selected.agent : undefined;
	}

	get isEditing(): boolean {
		return this.editingAgentId !== undefined;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-projects-view-body');

		this.renderSecretaryBanner(container);
		this.renderControlsToolbar(container);

		const contentArea = append(container, $('.ade-projects-content'));
		this.emptyStateHost = append(contentArea, $('.ade-projects-empty'));
		this.emptyStateMessage = append(this.emptyStateHost, $('p.ade-projects-empty-text'));
		this.emptyStateHost.hidden = true;

		if (this.inboxService && this.engineeringService) {
			this.inboxPanel = this._register(new AdeInboxPanel(contentArea, this.inboxService, this.engineeringService, this.editors));
			this.inboxPanel.setVisible(false);
		}

		const treeContainer = this.treeHost = append(contentArea, $('.ade-projects-tree.explorer-folders-view'));
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));
		const labels = this._register(this.instantiationService.createInstance(ResourceLabels, { onDidChangeVisibility: this.onDidChangeBodyVisibility }));

		const tree = this.tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<AdeTreeItem[], AdeTreeItem, FuzzyScore>,
			'AdeProjects',
			treeContainer,
			{ getHeight: () => 22, getTemplateId: () => 'ade-project-item' },
			[
				new AdeTreeRenderer(
					labels,
					this.projects,
					this.sessions,
					this.uriIdentityService,
					this.instantiationService,
					this.hoverService,
					projectUri => void this.commandService.executeCommand('workbench.action.ade.newSession', projectUri),
					parentId => void this.commandService.executeCommand('workbench.action.ade.newSubSession', parentId),
					agentId => void this.commandService.executeCommand('workbench.action.ade.setRole', agentId),
					governorId => void this.commandService.executeCommand(ADE_OPEN_ENGINEERING_COMMAND_ID, governorId),
					agent => this.getEditableData(agent),
				),
			],
			{
				hasChildren: item => {
					if (Array.isArray(item)) {
						return true;
					}
					if (item.kind === 'project') {
						return this.getProjectRootAgents(item.project.uri).length > 0;
					}
					return this.projects.getDirectSubordinates(item.agent.id).length > 0;
				},
				getChildren: item => this.getChildren(item),
			},
			{
				dnd: new AdeProjectsDragAndDrop(
					this.projects,
					this.projectNavigation,
					agentId => void this.revealAgent(agentId),
				),
				sorter: {
					compare: (a, b) => {
						if (a.kind === 'project' && b.kind === 'project') {
							const list = this.projects.projects;
							const idxA = list.findIndex(project => this.uriIdentityService.extUri.isEqual(project.uri, a.project.uri));
							const idxB = list.findIndex(project => this.uriIdentityService.extUri.isEqual(project.uri, b.project.uri));
							return idxA - idxB;
						}
						return 0;
					},
				},
				identityProvider: {
					getId: item => item.kind === 'project'
						? `project:${this.uriIdentityService.extUri.getComparisonKey(item.project.uri)}`
						: `agent:${item.agent.id}`,
				},
				accessibilityProvider: {
					getWidgetAriaLabel: () => localize('agentProjects', "Agent Projects"),
					getAriaLabel: item => item.kind === 'project' ? item.project.name : item.agent.label,
				},
				expandOnlyOnTwistieClick: item => item.kind === 'agent',
				hideTwistiesOfChildlessElements: false,
				renderIndentGuides: RenderIndentGuides.Always,
				indent: 12,
				multipleSelectionSupport: false,
			},
		));

		this._register(this.themeService.onDidColorThemeChange(() => void this.refresh()));

		this._register(addStandardDisposableListener(treeContainer, EventType.KEY_DOWN, event => {
			if (this.editingAgentId) {
				return;
			}
			const focused = tree.getFocus()[0];
			if (!focused) {
				return;
			}
			if (event.equals(KeyCode.F2) && focused.kind === 'agent') {
				event.preventDefault();
				event.stopPropagation();
				void this.startInlineRename(focused.agent.id);
				return;
			}
			if (focused.kind === 'project' && (event.equals(KeyCode.Delete) || (isMacintosh && event.metaKey && event.keyCode === KeyCode.Backspace))) {
				event.preventDefault();
				event.stopPropagation();
				void this.commandService.executeCommand(ADE_DELETE_PROJECT_COMMAND_ID, focused.project.uri);
			}
		}));

		this._register(tree.onDidChangeSelection(event => {
			const item = event.elements[0];
			if (event.browserEvent && item) {
				if (item.kind === 'project') {
					this.projects.selectProject(item.project.uri);
				} else {
					this.projects.selectAgent(item.agent.id);
				}
			}
		}));

		this._register(tree.onDidOpen(event => {
			if (this.editingAgentId) {
				return;
			}
			if (event.element?.kind === 'agent') {
				void this.editors.openAgent(event.element.agent.id, { side: event.sideBySide });
			} else if (event.element?.kind === 'project') {
				this.projects.selectProject(event.element.project.uri);
			}
		}));

		this._register(tree.onMouseClick(event => {
			const item = event.element;
			if (!item) {
				return;
			}
			if (item.kind === 'project') {
				this.projects.selectProject(item.project.uri);
			} else {
				this.projects.selectAgent(item.agent.id);
			}
		}));

		this._register(tree.onContextMenu(event => {
			if (!event.element) {
				return;
			}
			tree.setFocus([event.element]);
			if (event.element.kind === 'project') {
				const project = event.element.project;
				this.projects.selectProject(project.uri);
				this.contextMenuService.showContextMenu({
					getAnchor: () => event.anchor,
					getActions: () => this.getProjectContextActions(project),
				});
				return;
			}
			const agent = event.element.agent;
			this.projects.selectAgent(agent.id);
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.anchor,
				getActions: () => this.getAgentContextActions(agent),
			});
		}));

		this._register(this.storageService.onWillSaveState(() => this.saveTreeState()));

		this.updateHeaderControls();
		void this.refresh().then(() => this.sessions.getEngines()).then(() => {
			this.updateHeaderControls();
			this.refreshAgentIcons();
		});
	}

	private renderSecretaryBanner(container: HTMLElement): void {
		const bar = this.secretaryBar = append(container, $('.ade-secretary-bar', {
			role: 'button',
			tabindex: 0,
			'aria-label': localize('adeOpenSecretaryAria', "Open Secretary"),
		}));

		const main = append(bar, $('.ade-secretary-main'));
		append(main, $.SVG<SVGSVGElement>('svg', {
			viewBox: '0 0 1024 1024',
			width: '16',
			height: '16',
			class: 'ade-secretary-app-icon',
			'aria-hidden': 'true',
			focusable: 'false',
		},
			$.SVG<SVGRectElement>('rect', {
				x: '64',
				y: '64',
				width: '896',
				height: '896',
				rx: '200',
				fill: '#000',
				stroke: 'rgba(255,255,255,0.18)',
				'stroke-width': '36',
			}),
			$.SVG<SVGPathElement>('path', {
				transform: 'translate(212 212) scale(6)',
				fill: '#fff',
				'fill-rule': 'evenodd',
				d: 'M70.9119 99.5723C72.4869 100.189 74.2828 100.15 75.8725 99.3807L96.4604 89.4231C98.624 88.3771 100 86.1762 100 83.7616V16.2392C100 13.8247 98.624 11.6238 96.4604 10.5774L75.8725 0.619067C73.7862 -0.389991 71.3446 -0.142885 69.5135 1.19527C69.252 1.38636 69.0028 1.59985 68.769 1.83502L29.3551 37.9795L12.1872 24.88C10.5891 23.6607 8.35365 23.7606 6.86938 25.1178L1.36302 30.1525C-0.452603 31.8127 -0.454583 34.6837 1.35854 36.3466L16.2471 50.0001L1.35854 63.6536C-0.454583 65.3164 -0.452603 68.1876 1.36302 69.8477L6.86938 74.8824C8.35365 76.2395 10.5891 76.34 12.1872 75.1201L29.3551 62.0207L68.769 98.1651C69.3925 98.7923 70.1246 99.2645 70.9119 99.5723ZM75.0152 27.1813L45.1092 50.0001L75.0152 72.8189V27.1813Z',
			}),
		));
		append(main, $('span.ade-secretary-title', {}, localize('adeSecretaryTitle', "Secretary")));
		this.secretaryStatusDot = append(main, $('span.ade-status-dot'));
		this.secretaryContextPill = append(main, $('span.ade-secretary-context'));

		const actions = append(bar, $('.ade-secretary-actions'));
		const addIconAction = (icon: ThemeIcon, tooltip: string, hoverOnly: boolean, onClick: () => void) => {
			const button = append(actions, $('button.ade-icon-button', {
				type: 'button',
				'aria-label': tooltip,
			}));
			button.classList.add(...ThemeIcon.asClassNameArray(icon));
			if (hoverOnly) {
				button.classList.add('ade-secretary-hover-action');
			}
			this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), button, tooltip));
			this._register(addDisposableListener(button, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				onClick();
			}));
		};

		addIconAction(Codicon.gear, localize('adeSecretarySwitchEngine', "Switch Secretary Engine..."), true, () => {
			void this.commandService.executeCommand('workbench.action.ade.configureSecretary');
		});
		addIconAction(Codicon.splitHorizontal, localize('adeSecretaryOpenSide', "Open to the Side"), false, () => {
			void this.editors.openSecretary({ side: true });
		});

		this._register(addDisposableListener(bar, EventType.CLICK, () => {
			void this.editors.openSecretary();
		}));
		this._register(addStandardDisposableListener(bar, EventType.CONTEXT_MENU, event => {
			EventHelper.stop(event, true);
			this.contextMenuService.showContextMenu({
				getAnchor: () => event,
				getActions: () => [
					toAction({
						id: 'ade.secretary.open',
						label: localize('adeOpenSecretaryMenu', "Open Secretary"),
						run: () => this.editors.openSecretary(),
					}),
					toAction({
						id: 'ade.secretary.openSide',
						label: localize('adeOpenSecretarySideMenu', "Open to the Side"),
						run: () => this.editors.openSecretary({ side: true }),
					}),
					new Separator(),
					toAction({
						id: 'ade.secretary.switchEngine',
						label: localize('adeSecretarySwitchEngineMenu', "Switch Secretary Engine..."),
						run: () => this.commandService.executeCommand('workbench.action.ade.configureSecretary'),
					}),
					toAction({
						id: 'ade.secretary.reset',
						label: localize('adeSecretaryResetMenu', "Reset Secretary Context"),
						run: () => this.commandService.executeCommand('workbench.action.ade.resetSecretary'),
					}),
				],
			});
		}));
		this._register(addStandardDisposableListener(bar, EventType.KEY_DOWN, event => {
			if (event.target === bar && (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space))) {
				event.preventDefault();
				void this.editors.openSecretary();
			}
		}));
	}

	private renderControlsToolbar(container: HTMLElement): void {
		const controls = this.controlsBar = append(container, $('.ade-sidebar-controls'));

		if (this.inboxService) {
			const segTabs = append(controls, $('.ade-sidebar-seg-tabs'));
			const projTab = this.projectsTabBtn = append(segTabs, $('button.ade-sidebar-seg-btn.active', {
				type: 'button',
			}));
			this.sectionTitleLabel = append(projTab, $('span.ade-sidebar-section-title', {}, localize('adeProjectsSectionTitle', "Projects")));

			const inbTab = this.inboxTabBtn = append(segTabs, $('button.ade-sidebar-seg-btn', {
				type: 'button',
			}));
			append(inbTab, $('span', {}, localize('adeInboxTabTitle', "Inbox")));
			this.inboxBadgeEl = append(inbTab, $('span.ade-inbox-count-badge'));
			this.inboxBadgeEl.hidden = true;

			this._register(addDisposableListener(projTab, EventType.CLICK, () => this.setSidebarMode('projects')));
			this._register(addDisposableListener(inbTab, EventType.CLICK, () => this.setSidebarMode('inbox')));
		} else {
			this.sectionTitleLabel = append(controls, $('span.ade-sidebar-section-title'));
		}

		const actions = append(controls, $('.ade-sidebar-actions'));

		const archivedBtn = this.archivedToggleButton = append(actions, $('button.ade-icon-button', {
			type: 'button',
			'aria-label': localize('adeToggleArchived', "Toggle Archived Sessions"),
			'aria-pressed': String(this.projects.showArchived),
		}));
		archivedBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.archive));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), archivedBtn, localize('adeToggleArchived', "Toggle Archived Sessions")));
		this._register(addDisposableListener(archivedBtn, EventType.CLICK, () => {
			if (this.sidebarMode !== 'projects') {
				this.setSidebarMode('projects');
			}
			this.projects.setShowArchived(!this.projects.showArchived);
		}));
	}

	setSidebarMode(mode: 'projects' | 'inbox'): void {
		this.sidebarMode = mode;
		this.projectsTabBtn?.classList.toggle('active', mode === 'projects');
		this.inboxTabBtn?.classList.toggle('active', mode === 'inbox');
		if (this.archivedToggleButton) {
			this.archivedToggleButton.hidden = mode === 'inbox';
		}
		if (mode === 'inbox') {
			if (this.treeHost) { this.treeHost.hidden = true; }
			if (this.emptyStateHost) { this.emptyStateHost.hidden = true; }
			this.inboxPanel?.setVisible(true);
		} else {
			this.inboxPanel?.setVisible(false);
			void this.refresh();
		}
		this.layoutTree();
	}

	private updateHeaderControls(): void {
		const secretary = this.projects.secretary;
		if (this.secretaryContextPill) {
			const focused = this.projectNavigation.focusedProject;
			const engineName = secretary.session ? this.sessions.getEngineName(secretary.session.engineId) : undefined;
			let summaryText: string;
			if (focused) {
				summaryText = engineName
					? localize('adeSecretaryEngineAndFocus', "{0} · {1}", engineName, focused.name)
					: localize('adeFocusPill', "Focus: {0}", focused.name);
			} else {
				summaryText = engineName ?? localize('adeHomePill', "Home");
			}
			this.secretaryContextPill.textContent = summaryText;
			this.secretaryContextPill.title = summaryText;
			this.secretaryContextPill.classList.toggle('focused', Boolean(focused));
		}
		if (this.secretaryStatusDot) {
			if (secretary.status === 'working') {
				this.secretaryStatusDot.hidden = false;
				this.secretaryStatusDot.className = `ade-status-dot working ${ThemeIcon.asClassName(ThemeIcon.modify(Codicon.loading, 'spin'))}`;
			} else if (secretary.unread) {
				this.secretaryStatusDot.hidden = false;
				this.secretaryStatusDot.className = 'ade-status-dot unread';
			} else {
				this.secretaryStatusDot.hidden = true;
				this.secretaryStatusDot.className = 'ade-status-dot';
			}
		}

		if (this.sectionTitleLabel) {
			this.sectionTitleLabel.textContent = this.projects.showArchived
				? localize('adeProjectsArchivedSectionTitle', "Projects (Archived)")
				: localize('adeProjectsSectionTitle', "Projects");
			this.sectionTitleLabel.classList.toggle('archived', this.projects.showArchived);
		}

		if (this.archivedToggleButton) {
			this.archivedToggleButton.classList.toggle('active', this.projects.showArchived);
			this.archivedToggleButton.setAttribute('aria-pressed', String(this.projects.showArchived));
		}

		if (this.inboxBadgeEl && this.inboxService) {
			const unread = this.inboxService.unreadCount;
			this.inboxBadgeEl.textContent = String(unread);
			this.inboxBadgeEl.hidden = unread <= 0;
		}
	}

	private getProjectRootAgents(projectUri: URI): readonly IAdeAgent[] {
		return this.projects.agents.filter(agent =>
			!agent.parentId
			&& this.uriIdentityService.extUri.isEqual(agent.projectUri, projectUri)
			&& Boolean(agent.archived) === this.projects.showArchived
		);
	}

	getProjectContextActions(project: IAdeProject): IAction[] {
		const actions: IAction[] = [];
		if (!this.projectNavigation.focusedProject) {
			actions.push(toAction({
				id: 'ade.project.focus',
				label: localize('adeFocusProject', "Focus"),
				run: () => this.projectNavigation.enterProject(project.uri),
			}));
			actions.push(new Separator());
		}
		actions.push(
			toAction({
				id: 'ade.project.newConversation',
				label: localize('adeProjectNewConversation', "New Conversation..."),
				run: () => this.commandService.executeCommand('workbench.action.ade.newSession', project.uri),
			}),
			toAction({
				id: 'ade.project.openExistingConversation',
				label: localize('adeProjectOpenExisting', "Open Existing Conversation..."),
				run: () => this.commandService.executeCommand('workbench.action.ade.openExistingSession', project.uri),
			}),
			new Separator(),
			toAction({
				id: 'ade.project.openInTerminal',
				label: localize('openInTerminal', "Open in Integrated Terminal"),
				run: () => this.commandService.executeCommand('workbench.action.terminal.new', { cwd: project.uri }),
			}),
			new Separator(),
			toAction({
				id: 'ade.project.remove',
				label: localize('adeRemoveProject', "Remove Project"),
				run: () => this.commandService.executeCommand(ADE_REMOVE_PROJECT_COMMAND_ID, project.uri),
			}),
			toAction({
				id: 'ade.project.delete',
				label: localize('adeDeleteProject', "Delete Project..."),
				run: () => this.commandService.executeCommand(ADE_DELETE_PROJECT_COMMAND_ID, project.uri),
			}),
		);
		return actions;
	}

	getAgentContextActions(agent: IAdeAgent): IAction[] {
		const agentId = agent.id;
		const isArchived = this.projects.isArchived(agentId);
		const hasSubs = this.projects.hasSubordinates(agentId);
		const rank = resolveAdeAgentRank(agent, hasSubs);
		const isLocked = Boolean(this.projects.isLockedByWorkTree?.(agentId));
		const workTreeGov = this.projects.getWorkTreeGovernor?.(agentId);
		const nextLower = getNextLowerAdeRole(agent.role, hasSubs);
		const orchestrated = this.projects.isOrchestrated(agent);

		const isTopGovernor = !agent.parentId && rank === 'governor';

		return [
			...(isTopGovernor ? [
				toAction({
					id: 'ade.engineering',
					label: agent.treeType === 'engineering'
						? localize('adeOpenEngineeringMenu', "Open Engineering")
						: localize('adeEnableEngineeringMenu', "Engineering"),
					run: () => this.commandService.executeCommand(ADE_OPEN_ENGINEERING_COMMAND_ID, agentId),
				}),
				new Separator(),
			] : []),
			...(isLocked && agent.parentId && workTreeGov ? [
				toAction({
					id: 'ade.openOwningEngineering',
					label: localize('adeOpenOwningEngineeringMenu', "Open Engineering Canvas"),
					run: () => this.commandService.executeCommand(ADE_OPEN_ENGINEERING_COMMAND_ID, workTreeGov.id),
				}),
				new Separator(),
			] : []),
			...(nextLower.canSpawnSubSession && !isLocked ? [toAction({
				id: 'ade.newSubSession',
				label: formatNewSubSessionLabel(nextLower.childRank),
				run: () => this.commandService.executeCommand('workbench.action.ade.newSubSession', agentId),
			})] : []),
			toAction({
				id: 'ade.agent.openSide',
				label: localize('adeOpenSessionSide', "Open to the Side"),
				run: () => this.editors.openAgent(agentId, { side: true }),
			}),
			...(agent.parentId ? [
				toAction({
					id: 'ade.openParent',
					label: localize('openParentAgent', "Open Parent Conversation"),
					run: async () => {
						await this.editors.openAgent(agent.parentId!);
						await this.revealAgent(agent.parentId!);
					},
				}),
				...(!isLocked ? [toAction({
					id: 'ade.promoteToRoot',
					label: localize('adeMoveToTopLevel', "Move to Top-Level Session"),
					run: () => {
						this.projects.reparentAgent(agentId, undefined);
					},
				})] : []),
			] : []),
			...(!agent.session && !agent.preferredEngineId ? [toAction({
				id: 'ade.connect',
				label: localize('connectAgent', "Connect Agent Conversation..."),
				run: () => this.commandService.executeCommand('workbench.action.ade.connectAgent', agentId),
			})] : []),
			...(!isLocked ? [
				new Separator(),
				...(getAdeRoleRankLevel(agent.role, hasSubs) >= 2 ? [toAction({
					id: 'ade.recruitSubordinate',
					label: localize('adeRecruitSubordinate', "Recruit Subordinate Agent..."),
					run: () => this.commandService.executeCommand('workbench.action.ade.addAgent', agentId),
				})] : []),
				toAction({
					id: 'ade.setRole',
					label: localize('adeSetAgentRole', "Set Agent Role..."),
					run: () => this.commandService.executeCommand('workbench.action.ade.setRole', agentId),
				}),
				toAction({
					id: 'ade.reparentAgent',
					label: localize('adeChangeSupervisor', "Change Supervisor..."),
					run: () => this.commandService.executeCommand('workbench.action.ade.reparentAgent', agentId),
				}),
			] : []),
			...(orchestrated ? [toAction({
				id: 'ade.copyRolePrompt',
				label: localize('adeCopyRolePromptMenu', "Copy Role & Subordinate API Prompt"),
				run: () => this.commandService.executeCommand('workbench.action.ade.copyRolePrompt', agentId),
			})] : []),
			new Separator(),
			toAction({
				id: 'ade.rename',
				label: localize('adeRenameSessionMenu', "Rename..."),
				run: () => this.startInlineRename(agentId),
			}),
			...(!agent.parentId ? [toAction({
				id: isArchived ? 'ade.restore' : 'ade.archive',
				label: isArchived
					? localize('adeRestoreConversation', "Restore Conversation")
					: localize('adeArchiveConversation', "Archive Conversation"),
				run: () => this.commandService.executeCommand(isArchived ? 'workbench.action.ade.restoreAgent' : 'workbench.action.ade.archiveAgent', agentId),
			})] : []),
			...(!isLocked || !agent.parentId ? [
				new Separator(),
				toAction({
					id: 'ade.detach',
					label: localize('adeRemoveFromSidebar', "Remove from Sidebar"),
					run: () => this.commandService.executeCommand('workbench.action.ade.removeAgent', agentId),
				}),
				toAction({
					id: 'ade.deletePermanently',
					label: localize('adeDeletePermanently', "Delete Permanently..."),
					run: () => this.commandService.executeCommand('workbench.action.ade.deleteAgentPermanently', agentId),
				}),
			] : []),
		];
	}

	private getEditableData(agent: IAdeAgent): IEditableData | undefined {
		if (this.editingAgentId !== agent.id) {
			return undefined;
		}
		return {
			startingValue: agent.label,
			validationMessage: value => !value.trim()
				? { content: localize('adeSessionNameRequired', "A conversation name must be provided."), severity: Severity.Error }
				: null,
			onFinish: async (value, success) => {
				this.editingAgentId = undefined;
				const trimmed = value.trim();
				if (success && trimmed && trimmed !== agent.label) {
					this.projects.renameAgent(agent.id, trimmed);
					if (agent.session?.engineId.startsWith('aexus-')) {
						void this.commandService.executeCommand('aexus.agentEngines.rename', agent.session.resource, trimmed).catch(() => { });
					}
				} else {
					this.rerenderAgent(agent.id);
				}
				if (this.pendingRefresh) {
					this.pendingRefresh = false;
					await this.refresh();
				}
				this.tree?.domFocus();
			},
		};
	}

	async startInlineRename(agentId: string): Promise<void> {
		const agent = this.projects.getAgent(agentId);
		if (!agent || !this.tree) {
			return;
		}
		await this.revealAgent(agentId);
		this.editingAgentId = agentId;
		this.rerenderAgent(agentId);
	}

	private rerenderAgent(agentId: string): void {
		const tree = this.tree;
		if (!tree?.getInput()) {
			return;
		}
		const nodes = [...tree.getNode().children];
		while (nodes.length) {
			const node = nodes.pop()!;
			nodes.push(...node.children);
			if (!Array.isArray(node.element) && node.element.kind === 'agent' && node.element.agent.id === agentId) {
				tree.rerender(node.element);
			}
		}
	}

	private refreshAgentIcons(): void {
		const tree = this.tree;
		if (!tree?.getInput() || this.editingAgentId) {
			return;
		}
		const nodes = [...tree.getNode().children];
		while (nodes.length) {
			const node = nodes.pop()!;
			nodes.push(...node.children);
			if (!Array.isArray(node.element)) {
				tree.rerender(node.element);
			}
		}
	}

	private updateEmptyState(roots: AdeTreeItem[]): void {
		if (!this.emptyStateHost || !this.emptyStateMessage || !this.treeHost) {
			return;
		}
		this.emptyActionDisposables.clear();
		for (const child of [...this.emptyStateHost.children]) {
			if (child !== this.emptyStateMessage) {
				child.remove();
			}
		}

		if (this.sidebarMode === 'inbox') {
			this.emptyStateHost.hidden = true;
			this.treeHost.hidden = true;
			return;
		}

		if (roots.length > 0) {
			this.emptyStateHost.hidden = true;
			this.treeHost.hidden = false;
			return;
		}

		this.emptyStateHost.hidden = false;
		this.treeHost.hidden = true;

		const focused = this.projectNavigation.focusedProject;
		if (this.projects.showArchived) {
			this.emptyStateMessage.textContent = focused
				? localize('adeArchivedEmptyFocused', "No archived sessions in {0}.", focused.name)
				: localize('adeArchivedEmpty', "No archived sessions.");
			return;
		}

		if (!focused && this.projects.projects.length === 0) {
			this.emptyStateMessage.textContent = localize('adeNoProjectsWelcome', "Add a project folder here, then add Coding Agent sessions under any project.");
			const addProjectBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, defaultButtonStyles));
			addProjectBtn.label = localize('adeAddProjectFolderButton', "Add Project Folder...");
			this.emptyActionDisposables.add(addProjectBtn.onDidClick(() => {
				void this.commandService.executeCommand('workbench.action.ade.addProjectFolder');
			}));
			return;
		}

		this.emptyStateMessage.textContent = focused
			? localize('adeNoSessionsFocusedWelcome', "No Agent sessions in {0} yet.", focused.name)
			: localize('adeNoSessionsWelcome', "Start a new Agent session or open an existing conversation.");

		const newSessionBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, defaultButtonStyles));
		newSessionBtn.label = localize('adeNewSessionButton', "New Session...");
		this.emptyActionDisposables.add(newSessionBtn.onDidClick(() => {
			void this.commandService.executeCommand('workbench.action.ade.newSession', focused?.uri);
		}));

		const openExistingBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, { ...defaultButtonStyles, secondary: true }));
		openExistingBtn.label = localize('adeOpenExistingButton', "Open Existing Session...");
		this.emptyActionDisposables.add(openExistingBtn.onDidClick(() => {
			void this.commandService.executeCommand('workbench.action.ade.openExistingSession', focused?.uri);
		}));
	}

	async refresh(orderOnly = false): Promise<void> {
		if (this.editingAgentId) {
			this.pendingRefresh = true;
			return;
		}
		await this.refreshQueue.queue(async () => {
			if (this.editingAgentId) {
				this.pendingRefresh = true;
				return;
			}
			const tree = this.tree;
			if (!tree) {
				return;
			}
			if (orderOnly && !this.projectNavigation.focusedProject && tree.getInput()) {
				tree.resort(undefined, false);
				return;
			}

			let roots: AdeTreeItem[];
			const focused = this.projectNavigation.focusedProject;
			if (this.projects.showArchived) {
				if (focused) {
					roots = this.getProjectRootAgents(focused.uri).length > 0
						? [{ kind: 'project', project: { uri: focused.uri, name: focused.name } }]
						: [];
				} else {
					roots = this.projects.projects
						.filter(project => this.getProjectRootAgents(project.uri).length > 0)
						.map(project => ({ kind: 'project' as const, project }));
				}
			} else if (focused) {
				roots = [{ kind: 'project', project: { uri: focused.uri, name: focused.name } }];
			} else {
				roots = this.projects.projects.map(project => ({ kind: 'project' as const, project }));
			}

			this.updateEmptyState(roots);
			const state = tree.getInput() ? undefined : this.storageService.getObject('aexus.ade.treeState', StorageScope.PROFILE);
			await tree.setInput(roots, state);
			for (const root of roots) {
				if (root.kind === 'project' && this.getProjectRootAgents(root.project.uri).length > 0) {
					const key = this.uriIdentityService.extUri.getComparisonKey(root.project.uri);
					if (focused || !this.autoExpandedProjects.has(key)) {
						this.autoExpandedProjects.add(key);
						await tree.expand(root);
					}
				}
			}
			this.layoutTree();
		});
	}

	async revealAgent(id: string): Promise<void> {
		const target = this.projects.getAgent(id);
		if (!target) {
			return;
		}
		await this.refresh();
		const tree = this.tree;
		if (!tree) {
			return;
		}

		const projectNode = tree.getNode().children.find(child =>
			!Array.isArray(child.element)
			&& child.element.kind === 'project'
			&& this.uriIdentityService.extUri.isEqual(child.element.project.uri, target.projectUri)
		)?.element;
		if (!projectNode || Array.isArray(projectNode)) {
			return;
		}
		await tree.expand(projectNode);

		const path: string[] = [];
		for (let cursor: IAdeAgent | undefined = target; cursor; cursor = cursor.parentId ? this.projects.getAgent(cursor.parentId) : undefined) {
			path.unshift(cursor.id);
		}
		let children = tree.getNode(projectNode).children;
		for (const stepId of path) {
			const match = children.find(child => !Array.isArray(child.element) && child.element.kind === 'agent' && child.element.agent.id === stepId)?.element;
			if (!match || Array.isArray(match)) {
				return;
			}
			if (stepId === id) {
				tree.setSelection([match]);
				tree.setFocus([match]);
				tree.reveal(match);
			} else {
				await tree.expand(match);
				children = tree.getNode(match).children;
			}
		}
	}

	private async getChildren(item: AdeTreeItem[] | AdeTreeItem): Promise<Iterable<AdeTreeItem>> {
		if (Array.isArray(item)) {
			return item;
		}
		if (item.kind === 'project') {
			return this.getProjectRootAgents(item.project.uri).map(agent => ({ kind: 'agent' as const, agent }));
		}
		return this.projects.getDirectSubordinates(item.agent.id).map(agent => ({ kind: 'agent' as const, agent }));
	}

	private layoutTree(): void {
		if (this.lastHeight <= 0) {
			return;
		}
		const headerHeight = (this.secretaryBar?.offsetHeight ?? 0) + (this.controlsBar?.offsetHeight ?? 0);
		const bodyH = Math.max(0, this.lastHeight - headerHeight);
		if (this.sidebarMode === 'inbox') {
			this.inboxPanel?.layout(bodyH);
			return;
		}
		this.tree?.layout(bodyH, this.lastWidth);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.lastHeight = height;
		this.lastWidth = width;
		this.layoutTree();
	}

	override focus(): void {
		this.tree?.domFocus();
	}

	private saveTreeState(): void {
		if (this.tree?.getInput() && !this.projectNavigation.focusedProject) {
			this.storageService.store('aexus.ade.treeState', JSON.stringify(this.tree.getViewState()), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
	}

	override setVisible(visible: boolean): void {
		if (!visible) {
			this.saveTreeState();
		}
		super.setVisible(visible);
	}

	override dispose(): void {
		this.saveTreeState();
		super.dispose();
	}
}
