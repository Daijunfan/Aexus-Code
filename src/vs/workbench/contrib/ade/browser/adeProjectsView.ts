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
import { IAsyncDataTreeViewState } from '../../../../base/browser/ui/tree/asyncDataTree.js';
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
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { createFileIconThemableTreeContainerScope, IResourceLabel, ResourceLabels } from '../../../browser/labels.js';
import { renderAdeOsIcon, resolveLocalOsIconKind } from '../../../browser/adeOsIcon.js';
import { InlineEditInputBox } from '../../../browser/parts/views/inlineEditInputBox.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IEditableData, IViewDescriptorService } from '../../../common/views.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ChatEditorInput } from '../../chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ADE_OS_ICON_LABELS, AdeOsIconKind, formatProjectDisplayPath, IAdeCloudHost, IAdeCloudHostBackendService, isCloudProjectUri, resolveAdeOsIconKind } from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeEngineeringService, IAdeInboxService, resolveAdeInboxSeverity } from '../../../../platform/ade/common/adeEngineering.js';
import { IProjectNavigationService } from '../../files/browser/projectNavigationService.js';
import { ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, ADE_DELETE_PROJECT_COMMAND_ID, ADE_SECRETARY_ID, ADE_OPEN_ENGINEERING_COMMAND_ID, ADE_OPEN_RESEARCH_COMMAND_ID, ADE_REMOVE_PROJECT_COMMAND_ID, ADE_RENAME_PROJECT_COMMAND_ID, AdeSessionRank, getAdeRoleRankLevel, getNextLowerAdeRole, IAdeAgent, IAdeEditorService, IAdeProject, IAdeProjectsService, resolveAdeAgentRank } from '../common/ade.js';
import { AdeInboxPanel } from './adeInboxView.js';
import { AdeSessionEditorInput } from './adeSessionEditor.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import './media/adeSidebarDeck.css';

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

/** Org-chart tier monogram for a rank (L1 Governor … L4 Worker). */
export function getAdeRankTier(rank: AdeSessionRank): 'L1' | 'L2' | 'L3' | 'L4' {
	switch (rank) {
		case 'governor':
			return 'L1';
		case 'manager':
			return 'L2';
		case 'employee':
		case 'subordinate':
			return 'L3';
		case 'worker':
			return 'L4';
	}
}

function getAdeRankIcon(rank: AdeSessionRank): ThemeIcon {
	switch (rank) {
		case 'governor':
			return Codicon.organization;
		case 'manager':
			return Codicon.briefcase;
		case 'employee':
			return Codicon.shield;
		case 'subordinate':
			return Codicon.person;
		case 'worker':
			return Codicon.tools;
	}
}

function formatChildRankPreview(childRank: AdeSessionRank): string {
	return localize('adeDropChildRankPreview', "→ {0}", formatRoleBadgeLabel(childRank));
}

/** Removes every `rank-*` / `depth-*` modifier so recycled rows never leak state between elements. */
function resetAdeRowModifiers(row: HTMLElement): void {
	for (const cls of [...row.classList]) {
		if (cls.startsWith('rank-') || cls.startsWith('depth-')) {
			row.classList.remove(cls);
		}
	}
}

const ADE_MAX_STYLED_DEPTH = 6;

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
	readonly cloudBadge: HTMLElement;
	readonly countBadge: HTMLElement;
	readonly addSessionBtn: HTMLElement;
	readonly workTreeBadge: HTMLElement;
	readonly roleBadge: HTMLElement;
	readonly lockGlyph: HTMLElement;
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
		private readonly getCloudHostMeta: (authority: string) => IAdeCloudHost | undefined,
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
		const cloudBadge = append(trailing, $('span.ade-cloud-host-badge'));
		cloudBadge.hidden = true;
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
		const lockGlyph = append(trailing, $('span.ade-lock-glyph', { 'aria-hidden': 'true' }));
		lockGlyph.classList.add(...ThemeIcon.asClassNameArray(Codicon.lock));
		lockGlyph.hidden = true;
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
			cloudBadge,
			countBadge,
			addSessionBtn,
			workTreeBadge,
			roleBadge,
			lockGlyph,
			statusIndicator,
			editDisposables: new DisposableStore(),
			templateDisposables,
		};
	}

	private applyItemIcon(iconNode: HTMLElement, icon: ThemeIcon | URI): void {
		delete iconNode.dataset.os;
		iconNode.removeAttribute('aria-label');
		iconNode.title = '';
		if (iconNode.firstChild) {
			iconNode.replaceChildren();
		}
		if (URI.isUri(icon)) {
			iconNode.className = 'ade-tree-item-icon ade-tree-item-icon-svg';
			iconNode.style.backgroundImage = asCSSUrl(icon);
		} else {
			iconNode.className = `ade-tree-item-icon ${ThemeIcon.asClassName(icon)}`;
			iconNode.style.backgroundImage = '';
		}
	}

	private applyProjectOsIcon(iconNode: HTMLElement, project: IAdeProject): void {
		const isCloud = isCloudProjectUri(project.uri);
		let osKind: AdeOsIconKind;
		let tooltip: string;
		if (isCloud) {
			const host = this.getCloudHostMeta(project.uri.authority);
			osKind = resolveAdeOsIconKind({
				os: host?.os,
				distribution: host?.lastTestStatus?.remoteUname,
				hint: `${host?.name ?? ''} ${host?.alias ?? ''} ${host?.user ?? ''} ${project.uri.authority} ${project.name}`,
			});
			tooltip = `${ADE_OS_ICON_LABELS[osKind]} · ${project.uri.authority}`;
		} else {
			osKind = resolveLocalOsIconKind(project.name);
			tooltip = ADE_OS_ICON_LABELS[osKind];
		}
		renderAdeOsIcon(iconNode, osKind, {
			baseClass: 'ade-tree-item-icon ade-tree-item-icon-os',
			prefix: 'ade-os',
			tooltip,
		});
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
		template.row.classList.remove('editing', 'ade-orchestrated-agent', 'ade-pure-worker', 'ade-project-row', 'ade-agent-row', 'ade-worktree-locked', 'ade-cloud-project', 'is-working', 'is-idle');
		resetAdeRowModifiers(template.row);
		template.row.removeAttribute('data-child-rank');
		template.row.removeAttribute('data-child-label');
		template.lockGlyph.hidden = true;

		const item = node.element;
		if (item.kind === 'project') {
			template.row.classList.add('ade-project-row', 'depth-0');
			template.workTreeBadge.hidden = true;
			template.workTreeBadge.textContent = '';
			template.workTreeBadge.className = 'ade-worktree-badge';
			template.roleBadge.hidden = true;
			template.roleBadge.textContent = '';
			template.roleBadge.className = 'ade-role-badge';
			template.roleBadge.removeAttribute('data-tier');
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

			const isCloud = isCloudProjectUri(item.project.uri);
			this.applyProjectOsIcon(template.iconNode, item.project);
			template.row.setAttribute('data-child-rank', 'governor');
			template.row.setAttribute('data-child-label', localize('adeDropTopLevelPreview', "→ Top-Level"));
			if (isCloud) {
				template.row.classList.add('ade-cloud-project');
				template.cloudBadge.textContent = item.project.uri.authority;
				template.cloudBadge.prepend($('span.ade-cloud-host-dot', { 'aria-hidden': 'true' }));
				template.cloudBadge.hidden = false;
				template.editDisposables.add(this.hoverService.setupManagedHover(
					getDefaultHoverDelegate('mouse'),
					template.cloudBadge,
					localize('adeCloudProjectTooltip', "SSH Cloud Host Project ({0})", formatProjectDisplayPath(item.project.uri)),
				));
			} else {
				template.cloudBadge.textContent = '';
				template.cloudBadge.hidden = true;
			}
			template.label.setResource({
				resource: item.project.uri,
				name: item.project.name,
			}, {
				hideIcon: true,
				fileKind: FileKind.FOLDER,
				title: formatProjectDisplayPath(item.project.uri),
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

		template.cloudBadge.textContent = '';
		template.cloudBadge.hidden = true;
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
		template.row.classList.add(orchestrated ? 'ade-orchestrated-agent' : 'ade-pure-worker', 'ade-agent-row', `rank-${rank}`, `depth-${Math.min(Math.max(1, node.depth - 1), ADE_MAX_STYLED_DEPTH)}`);
		template.row.classList.add(agent.status === 'working' ? 'is-working' : 'is-idle');
		if (isLocked) {
			template.row.classList.add('ade-worktree-locked');
			template.lockGlyph.hidden = false;
		}
		if (nextLower.canSpawnSubSession) {
			template.row.setAttribute('data-child-rank', nextLower.childRank);
			template.row.setAttribute('data-child-label', formatChildRankPreview(nextLower.childRank));
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
			title: `${engineTitle} (${badgeLabel}${!session && agent.preferredEngineId ? ' · Lazy' : ''}) • ${formatProjectDisplayPath(agent.projectUri)}`,
			extraClasses: ['explorer-item', 'ade-agent-session-row'],
		});

		if (!agent.parentId && agent.treeType) {
			const isRes = agent.treeType === 'research';
			template.workTreeBadge.textContent = isRes ? localize('adeBadgeResearch', "Research") : localize('adeBadgeEngineering', "Engineering");
			template.workTreeBadge.className = `ade-worktree-badge type-${agent.treeType}`;
			const treeIcon = $('span.ade-worktree-badge-icon', { 'aria-hidden': 'true' });
			treeIcon.classList.add(...ThemeIcon.asClassNameArray(isRes ? Codicon.beaker : Codicon.typeHierarchy));
			template.workTreeBadge.prepend(treeIcon);
			template.workTreeBadge.setAttribute('role', 'button');
			template.workTreeBadge.setAttribute('tabindex', '0');
			template.workTreeBadge.hidden = false;
			const treeTooltip = localize('adeOpenEngineeringBadgeTooltip', "Open {0} DAG Canvas", template.workTreeBadge.textContent);
			template.editDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.workTreeBadge, treeTooltip));
			template.editDisposables.add(addDisposableListener(template.workTreeBadge, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onOpenEngineering(agent.id);
			}));
			template.editDisposables.add(addDisposableListener(template.workTreeBadge, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter' || event.key === ' ') {
					EventHelper.stop(event, true);
					this.onOpenEngineering(agent.id);
				}
			}));
		} else {
			template.workTreeBadge.hidden = true;
		}

		template.roleBadge.textContent = badgeLabel;
		template.roleBadge.className = `ade-role-badge role-${rank}${isLocked ? ' locked' : ''}`;
		template.roleBadge.setAttribute('data-tier', getAdeRankTier(rank));
		const rankIcon = $('span.ade-role-badge-icon', { 'aria-hidden': 'true' });
		rankIcon.classList.add(...ThemeIcon.asClassNameArray(getAdeRankIcon(rank)));
		template.roleBadge.prepend(rankIcon);
		template.roleBadge.hidden = false;
		const roleTooltip = isLocked
			? localize('adeLockedRoleBadgeTooltip', "Role: {0} (Locked by Engineering Blueprint)", badgeLabel)
			: rank === 'worker'
				? localize('adeWorkerBadgeTooltip', "Role: Worker (Clean Native Context) — Click to change role")
				: localize('adeStaffBadgeTooltip', "Role: {0} — Click to change role", badgeLabel);
		template.editDisposables.add(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), template.roleBadge, roleTooltip));
		if (!isLocked) {
			template.roleBadge.setAttribute('role', 'button');
			template.roleBadge.setAttribute('tabindex', '0');
			template.editDisposables.add(addDisposableListener(template.roleBadge, EventType.CLICK, event => {
				EventHelper.stop(event, true);
				this.onSetAgentRole(agent.id);
			}));
			template.editDisposables.add(addDisposableListener(template.roleBadge, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (event.key === 'Enter' || event.key === ' ') {
					EventHelper.stop(event, true);
					this.onSetAgentRole(agent.id);
				}
			}));
		} else {
			template.roleBadge.removeAttribute('role');
			template.roleBadge.removeAttribute('tabindex');
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
			template.lockGlyph.hidden = true;
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
	private secretaryStatusChip: HTMLElement | undefined;
	private secretaryStatusChipLabel: HTMLElement | undefined;
	private controlsBar: HTMLElement | undefined;
	private focusBanner: HTMLElement | undefined;
	private focusBannerName: HTMLElement | undefined;
	private focusBannerHost: HTMLElement | undefined;
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
	private readonly notificationService: INotificationService | undefined;
	private readonly workbenchEditorService: IEditorService | undefined;
	private readonly cloudHostBackend: IAdeCloudHostBackendService | undefined;
	private readonly cloudHostMetaByAuthority = new Map<string, IAdeCloudHost>();
	private emptyStateHost: HTMLElement | undefined;
	private emptyStateMessage: HTMLElement | undefined;
	private readonly emptyActionDisposables = this._register(new DisposableStore());
	private readonly refreshQueue = new Sequencer();
	private readonly autoExpandedProjects = new Set<string>();
	private lastTreeScopeKey: string | undefined;
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
			if (change === 'selection') {
				return;
			}
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

		const [engSvc, inbSvc, notifSvc, editorSvc, cloudSvc] = instantiationService.invokeFunction(accessor => {
			let eng: IAdeEngineeringService | undefined;
			let inb: IAdeInboxService | undefined;
			let notif: INotificationService | undefined;
			let edit: IEditorService | undefined;
			let cloud: IAdeCloudHostBackendService | undefined;
			try { eng = accessor.get(IAdeEngineeringService); } catch { eng = undefined; }
			try { inb = accessor.get(IAdeInboxService); } catch { inb = undefined; }
			try { notif = accessor.get(INotificationService); } catch { notif = undefined; }
			try { edit = accessor.get(IEditorService); } catch { edit = undefined; }
			try { cloud = accessor.get(IAdeCloudHostBackendService); } catch { cloud = undefined; }
			return [eng, inb, notif, edit, cloud] as const;
		});
		this.engineeringService = engSvc;
		this.inboxService = inbSvc;
		this.notificationService = notifSvc;
		this.workbenchEditorService = editorSvc;
		this.cloudHostBackend = cloudSvc;
		if (this.cloudHostBackend) {
			void this.refreshCloudHostMeta();
			this._register(this.cloudHostBackend.onDidChangeHosts(() => {
				void this.refreshCloudHostMeta();
			}));
		}
		if (this.inboxService) {
			this._register(this.inboxService.onDidChange(() => this.updateHeaderControls()));
		}
		const onDidActiveEditorChange = this.workbenchEditorService?.onDidActiveEditorChange;
		if (onDidActiveEditorChange) {
			this._register(onDidActiveEditorChange(() => this.updateSecretaryActiveState()));
		}
	}

	get selectedAgent(): IAdeAgent | undefined {
		const selected = this.tree?.getFocus()[0] ?? this.tree?.getSelection()[0];
		return selected?.kind === 'agent' ? selected.agent : undefined;
	}

	get isEditing(): boolean {
		return this.editingAgentId !== undefined;
	}

	private async refreshCloudHostMeta(): Promise<void> {
		if (!this.cloudHostBackend) {
			return;
		}
		try {
			const hosts = await this.cloudHostBackend.listHosts();
			this.cloudHostMetaByAuthority.clear();
			for (const h of hosts) {
				this.cloudHostMetaByAuthority.set(h.alias, h);
				this.cloudHostMetaByAuthority.set(h.alias.toLowerCase(), h);
			}
			this.refreshAgentIcons();
		} catch {
			// Best-effort OS metadata lookup; fallback uses authority/name hints.
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('ade-projects-view-body');

		this.renderSecretaryBanner(container);
		this.renderControlsToolbar(container);
		this.renderFocusBanner(container);

		const contentArea = append(container, $('.ade-projects-content'));
		if (this.inboxService && this.engineeringService) {
			this.inboxPanel = this._register(new AdeInboxPanel(
				contentArea,
				this.inboxService,
				this.engineeringService,
				this.editors,
				msg => this.notificationService?.error(msg),
			));
			this.inboxPanel.setVisible(false);
		}

		const treeContainer = this.treeHost = append(contentArea, $('.ade-projects-tree.explorer-folders-view'));
		this.emptyStateHost = append(contentArea, $('.ade-projects-empty'));
		this.emptyStateMessage = append(this.emptyStateHost, $('p.ade-projects-empty-text'));
		this.emptyStateHost.hidden = true;
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
					authority => this.cloudHostMetaByAuthority.get(authority) ?? this.cloudHostMetaByAuthority.get(authority.toLowerCase()),
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
				stickyScrollToggleOnClick: item => item.kind === 'project',
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
				return;
			}
			if (focused.kind === 'agent' && (event.equals(KeyCode.Delete) || (isMacintosh && event.metaKey && event.keyCode === KeyCode.Backspace))) {
				event.preventDefault();
				event.stopPropagation();
				void this.commandService.executeCommand('workbench.action.ade.deleteAgentPermanently', focused.agent.id);
			}
		}));

		this._register(tree.onDidChangeSelection(event => {
			const item = event.elements[0];
			if (item) {
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

		this._register(tree.onDidChangeCollapseState(event => {
			const element = event.node.element?.element;
			if (element && !Array.isArray(element) && tree.hasNode(element)) {
				tree.rerender(element);
			}
		}));

		this._register(tree.onMouseClick(event => {
			const item = event.element;
			if (!item) {
				return;
			}
			if (item.kind === 'project') {
				if (!event.browserEvent.shiftKey && !event.browserEvent.metaKey && !event.browserEvent.ctrlKey) {
					const selection = tree.getSelection();
					if (selection.length !== 1 || selection[0] !== item) {
						tree.setSelection([item]);
					}
				}
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
		this.updateEmptyState(
			this.projects.projects.map(project => ({ kind: 'project' as const, project })),
		);
		void this.refresh().then(() => this.sessions.getEngines()).then(() => {
			this.updateHeaderControls();
			this.refreshAgentIcons();
		}).catch(() => {
			this.updateHeaderControls();
		});
	}

	private renderSecretaryBanner(container: HTMLElement): void {
		const bar = this.secretaryBar = append(container, $('.ade-secretary-bar', {
			role: 'button',
			tabindex: 0,
			'aria-label': localize('adeOpenSecretaryAria', "Open Secretary"),
		}));

		const main = append(bar, $('.ade-secretary-main'));
		const iconWrap = append(main, $('span.ade-secretary-icon-wrap'));
		append(iconWrap, $.SVG<SVGSVGElement>('svg', {
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
		append(main, $('span.ade-secretary-spark', { 'aria-hidden': 'true' }, '\u2726'));
		append(main, $('span.ade-secretary-title', {}, localize('adeSecretaryTitle', "Secretary")));
		const chip = this.secretaryStatusChip = append(main, $('span.ade-secretary-status-chip', { role: 'status' }));
		const chipIcon = append(chip, $('span.ade-secretary-status-chip-icon', { 'aria-hidden': 'true' }));
		chipIcon.classList.add(...ThemeIcon.asClassNameArray(ThemeIcon.modify(Codicon.loading, 'spin')));
		this.secretaryStatusChipLabel = append(chip, $('span.ade-secretary-status-chip-label'));
		chip.hidden = true;
		this.secretaryContextPill = append(main, $('span.ade-secretary-context'));
		this.secretaryStatusDot = append(main, $('span.ade-status-dot'));

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

	private renderFocusBanner(container: HTMLElement): void {
		const banner = this.focusBanner = append(container, $('.ade-focus-banner', { role: 'status' }));
		banner.hidden = true;
		const glyph = append(banner, $('span.ade-focus-banner-glyph', { 'aria-hidden': 'true' }));
		glyph.classList.add(...ThemeIcon.asClassNameArray(Codicon.target));
		append(banner, $('span.ade-focus-banner-label', {}, localize('adeFocusBannerLabel', "Focused")));
		append(banner, $('span.ade-focus-banner-sep', { 'aria-hidden': 'true' }, '\u00b7'));
		this.focusBannerName = append(banner, $('span.ade-focus-banner-name'));
		this.focusBannerHost = append(banner, $('span.ade-focus-banner-host'));
		this.focusBannerHost.hidden = true;
		const exitLabel = localize('adeFocusBannerExit', "Exit");
		const exitTooltip = localize('adeFocusBannerExitTooltip', "Exit Focus and show all projects");
		const exit = append(banner, $('button.ade-focus-banner-exit', { type: 'button', 'aria-label': exitTooltip }));
		const exitIcon = append(exit, $('span', { 'aria-hidden': 'true' }));
		exitIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowLeft));
		append(exit, $('span', {}, exitLabel));
		this._register(this.hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), exit, exitTooltip));
		this._register(addDisposableListener(exit, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			this.projectNavigation.goHome();
		}));
	}

	private updateFocusBanner(): void {
		const banner = this.focusBanner;
		if (!banner || !this.focusBannerName || !this.focusBannerHost) {
			return;
		}
		const focused = this.projectNavigation.focusedProject;
		const wasHidden = banner.hidden;
		banner.hidden = !focused;
		if (focused) {
			this.focusBannerName.textContent = focused.name;
			this.focusBannerName.title = formatProjectDisplayPath(focused.uri);
			const isCloud = isCloudProjectUri(focused.uri);
			this.focusBannerHost.hidden = !isCloud;
			this.focusBannerHost.textContent = isCloud ? localize('adeFocusBannerCloudHost', "Cloud: {0}", focused.uri.authority) : '';
		}
		if (wasHidden !== banner.hidden) {
			this.layoutTree();
		}
	}

	private isSecretaryEditor(editor: EditorInput | undefined): boolean {
		if (!editor) {
			return false;
		}
		if (editor instanceof AdeSessionEditorInput) {
			return editor.agentId === ADE_SECRETARY_ID;
		}
		if (editor instanceof ChatEditorInput) {
			const resource = editor.sessionResource;
			return resource?.scheme === 'aexus-secretary'
				|| (Boolean(resource) && resource?.toString() === this.projects.secretary.session?.resource.toString());
		}
		return false;
	}

	private updateSecretaryActiveState(): void {
		this.secretaryBar?.classList.toggle('is-active', this.isSecretaryEditor(this.workbenchEditorService?.activeEditor ?? undefined));
	}

	private renderControlsToolbar(container: HTMLElement): void {
		const controls = this.controlsBar = append(container, $('.ade-sidebar-controls'));

		if (this.inboxService) {
			const segTabs = append(controls, $('.ade-sidebar-seg-tabs', { role: 'tablist' }));
			const projTab = this.projectsTabBtn = append(segTabs, $('button.ade-sidebar-seg-btn.active', {
				type: 'button',
				role: 'tab',
				'aria-selected': 'true',
			}));
			this.sectionTitleLabel = append(projTab, $('span.ade-sidebar-section-title', {}, localize('adeProjectsSectionTitle', "Projects")));

			const inbTab = this.inboxTabBtn = append(segTabs, $('button.ade-sidebar-seg-btn', {
				type: 'button',
				role: 'tab',
				'aria-selected': 'false',
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
		this.projectsTabBtn?.setAttribute('aria-selected', String(mode === 'projects'));
		this.inboxTabBtn?.classList.toggle('active', mode === 'inbox');
		this.inboxTabBtn?.setAttribute('aria-selected', String(mode === 'inbox'));
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
		const isWorking = secretary.status === 'working';
		if (this.secretaryStatusChip && this.secretaryStatusChipLabel) {
			this.secretaryStatusChip.hidden = !isWorking;
			this.secretaryStatusChip.classList.toggle('working', isWorking);
			this.secretaryStatusChipLabel.textContent = isWorking ? localize('adeSecretaryStatusWorking', "Working…") : '';
		}
		if (this.secretaryStatusDot) {
			if (secretary.unread) {
				this.secretaryStatusDot.hidden = false;
				this.secretaryStatusDot.className = 'ade-status-dot unread ade-secretary-unread';
			} else {
				this.secretaryStatusDot.hidden = true;
				this.secretaryStatusDot.className = 'ade-status-dot';
			}
		}
		if (this.secretaryBar) {
			this.secretaryBar.classList.toggle('is-working', isWorking);
			this.secretaryBar.classList.toggle('has-unread', Boolean(secretary.unread));
		}
		this.updateSecretaryActiveState();
		this.updateFocusBanner();

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
			const critical = this.inboxService.items.filter(item => !item.resolved && resolveAdeInboxSeverity(item) === 'critical').length;
			const shown = Math.max(unread, critical);
			this.inboxBadgeEl.textContent = String(shown);
			this.inboxBadgeEl.hidden = shown <= 0;
			this.inboxBadgeEl.classList.toggle('critical', critical > 0);
			this.inboxTabBtn?.classList.toggle('has-critical', critical > 0);
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
			...(isCloudProjectUri(project.uri) ? [
				toAction({
					id: 'ade.project.configureCloudHost',
					label: localize('adeConfigureCloudHostMenu', "Configure Cloud Host ({0})...", project.uri.authority),
					run: () => this.commandService.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID, project.uri.authority),
				}),
			] : []),
			new Separator(),
			toAction({
				id: 'ade.project.rename',
				label: localize('adeRenameProjectDisplay', "Rename Display Name..."),
				run: () => this.commandService.executeCommand(ADE_RENAME_PROJECT_COMMAND_ID, project.uri),
			}),
			toAction({
				id: 'ade.project.refresh',
				label: localize('adeRefreshProjectView', "Refresh"),
				run: () => this.refresh(),
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
				...(agent.treeType !== 'research' ? [toAction({
					id: 'ade.engineering',
					label: agent.treeType === 'engineering'
						? localize('adeOpenEngineeringMenu', "Open Engineering")
						: localize('adeEnableEngineeringMenu', "Engineering"),
					run: () => this.commandService.executeCommand(ADE_OPEN_ENGINEERING_COMMAND_ID, agentId),
				})] : []),
				...(agent.treeType !== 'engineering' ? [toAction({
					id: 'ade.research',
					label: agent.treeType === 'research'
						? localize('adeOpenResearchMenu', "Open Research")
						: localize('adeEnableResearchMenu', "Research"),
					run: () => this.commandService.executeCommand(ADE_OPEN_RESEARCH_COMMAND_ID, agentId),
				})] : []),
				new Separator(),
			] : []),
			...(isLocked && agent.parentId && workTreeGov ? [
				toAction({
					id: 'ade.openOwningEngineering',
					label: workTreeGov.treeType === 'research'
						? localize('adeOpenOwningResearchMenu', "Open Research Canvas")
						: localize('adeOpenOwningEngineeringMenu', "Open Engineering Canvas"),
					run: () => this.commandService.executeCommand(
						workTreeGov.treeType === 'research' ? ADE_OPEN_RESEARCH_COMMAND_ID : ADE_OPEN_ENGINEERING_COMMAND_ID,
						workTreeGov.id,
					),
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
			...(!isLocked || !agent.parentId ? (() => {
				const descendantCount = Math.max(0, this.projects.getSubtree(agentId).length - 1);
				return [
					new Separator(),
					toAction({
						id: 'ade.detach',
						label: descendantCount > 0
							? localize('adeRemoveWithSubordinatesFromSidebar', "Remove from Sidebar (with {0} Subordinates)", descendantCount)
							: localize('adeRemoveFromSidebar', "Remove from Sidebar"),
						run: () => this.commandService.executeCommand('workbench.action.ade.removeAgent', agentId),
					}),
					toAction({
						id: 'ade.deletePermanently',
						label: descendantCount > 0
							? localize('adeDeleteWithSubordinatesPermanently', "Delete Permanently (with {0} Subordinates)...", descendantCount)
							: localize('adeDeletePermanently', "Delete Permanently..."),
						run: () => this.commandService.executeCommand('workbench.action.ade.deleteAgentPermanently', agentId),
					}),
				];
			})() : []),
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

		const focused = this.projectNavigation.focusedProject;
		const focusedHasNoSessions = Boolean(focused && !this.projects.showArchived && this.getProjectRootAgents(focused.uri).length === 0);
		if (roots.length > 0 && !focusedHasNoSessions) {
			this.emptyStateHost.hidden = true;
			this.treeHost.hidden = false;
			return;
		}

		this.emptyStateHost.hidden = false;
		this.treeHost.hidden = roots.length === 0;

		if (this.projects.showArchived) {
			this.emptyStateMessage.textContent = focused
				? localize('adeArchivedEmptyFocused', "No archived sessions in {0}.", focused.name)
				: localize('adeArchivedEmpty', "No archived sessions.");
			const showActiveBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, { ...defaultButtonStyles, secondary: true }));
			showActiveBtn.label = localize('adeBackToActiveProjectsBtn', "Back to Active Projects");
			this.emptyActionDisposables.add(showActiveBtn.onDidClick(() => {
				this.projects.setShowArchived(false);
			}));
			return;
		}

		if (!focused && this.projects.projects.length === 0) {
			this.emptyStateMessage.textContent = localize('adeNoProjectsWelcome', "Add a local project folder or connect an SSH Cloud Host workspace to orchestrate Coding Agents across 4 organizational tiers.");
			const addProjectBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, defaultButtonStyles));
			addProjectBtn.label = localize('adeAddProjectFolderButton', "Add Project Folder...");
			this.emptyActionDisposables.add(addProjectBtn.onDidClick(() => {
				void this.commandService.executeCommand('workbench.action.ade.addProjectFolder');
			}));
			const cloudHostsBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, { ...defaultButtonStyles, secondary: true }));
			cloudHostsBtn.label = localize('adeManageCloudHostsEmptyBtn', "Manage SSH Cloud Hosts...");
			this.emptyActionDisposables.add(cloudHostsBtn.onDidClick(() => {
				void this.commandService.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID);
			}));
			const openSecBtn = this.emptyActionDisposables.add(new Button(this.emptyStateHost, { ...defaultButtonStyles, secondary: true }));
			openSecBtn.label = localize('adeOpenSecretaryEmptyBtn', "Open Secretary");
			this.emptyActionDisposables.add(openSecBtn.onDidClick(() => {
				void this.commandService.executeCommand('workbench.action.ade.openSecretary');
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
			const scopeKey = `${focused ? this.uriIdentityService.extUri.getComparisonKey(focused.uri) : 'home'}:${this.projects.showArchived ? 'archived' : 'active'}`;
			const scopeChanged = scopeKey !== this.lastTreeScopeKey;
			if (scopeChanged && tree.getInput() && this.lastTreeScopeKey === 'home:active') {
				this.saveTreeState();
			}
			this.lastTreeScopeKey = scopeKey;

			let state: IAsyncDataTreeViewState | undefined;
			const hadLiveInput = Boolean(tree.getInput()) && !scopeChanged;
			if (hadLiveInput) {
				state = tree.getViewState();
			} else if (!focused && !this.projects.showArchived) {
				state = this.storageService.getObject<IAsyncDataTreeViewState>('aexus.ade.treeState', StorageScope.PROFILE);
				if (state?.expanded) {
					for (const root of roots) {
						if (root.kind === 'project' && this.getProjectRootAgents(root.project.uri).length > 0) {
							this.autoExpandedProjects.add(this.uriIdentityService.extUri.getComparisonKey(root.project.uri));
						}
					}
				}
			}
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
		const headerHeight = (this.secretaryBar?.offsetHeight ?? 0)
			+ (this.controlsBar?.offsetHeight ?? 0)
			+ (this.focusBanner && !this.focusBanner.hidden ? this.focusBanner.offsetHeight : 0);
		const bodyH = Math.max(0, this.lastHeight - headerHeight);
		if (this.sidebarMode === 'inbox') {
			this.inboxPanel?.layout(bodyH);
			return;
		}
		if (this.treeHost && !this.treeHost.hidden && this.emptyStateHost && !this.emptyStateHost.hidden) {
			this.tree?.layout(28, this.lastWidth);
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
