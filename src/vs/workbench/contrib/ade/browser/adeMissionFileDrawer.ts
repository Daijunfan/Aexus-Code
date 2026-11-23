/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IMissionDagNode } from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionTaskStatusRecord } from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import { OrchestrationLayoutMode } from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { AdeEngineeringViewMode } from '../common/ade.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';

const MISSION_MERMAID_PLACEHOLDER = [
	'flowchart LR',
	'  T1["Architecture Design"] --> T2["Backend API"]',
	'  T1 --> T3["Frontend UI"]',
	'  T2 --> T4["Integration & QA"]',
	'  T3 --> T4',
].join('\n');

const ORCHESTRATION_CODE_PLACEHOLDER = [
	'flowchart LR',
	'  CEO["CEO @Alice"] <--> BE_Lead["Backend Lead @Bob"]',
	'  CEO <--> FE_Lead["Frontend Lead @Carol"]',
	'  subgraph Backend["Backend Dept"]',
	'    BE_Lead <--> Dev1["API Engineer @Dave"]',
	'    WB_BE[("Whiteboard: Backend Spec")]',
	'  end',
	'  %% staff CEO [tier=1, rank=governor]',
	'  %% staff BE_Lead [tier=2, rank=manager, dept=Backend]',
	'  %% staff FE_Lead [tier=2, rank=manager, dept=Frontend]',
	'  %% staff Dev1 [tier=3, rank=employee, dept=Backend]',
].join('\n');

export interface IMissionFileDrawerDelegate {
	getActiveMissionId(): string | undefined;
	getViewMode(): AdeEngineeringViewMode;
	getCodeText(): string;
	getMissionTaskNodes(): readonly IMissionDagNode[];
	getTaskDescriptions(): Readonly<Record<string, string>>;
	getTaskStatuses(): Readonly<Record<string, IMissionTaskStatusRecord>>;
	getOrchestrationLayoutMode?(): OrchestrationLayoutMode;
	onChangeOrchestrationLayoutMode?(mode: OrchestrationLayoutMode): void;
	onCodeDraftChange(nextText: string): void;
	onTaskDescriptionEdit(nodeId: string, nextVal: string): void;
	onDrawerOpenChanged?(isOpen: boolean): void;
}

/**
 * Ultra-clean minimalist Engineering source drawer:
 * - Canvas chrome contains STRICTLY ONE top-left button (`data-ade-mission-file-btn="true"`).
 * - In `mission` view: expands to ONLY TWO refined areas:
 *     (a) Mermaid Task DAG code editor;
 *     (b) All task nodes' individual task descriptions display & editor.
 * - In `orchestration` view: expands to ONLY ONE single-pane declarative code editor
 *     bidirectionally synced in real time with the cyclic all-staff canvas.
 */
export class AdeMissionFileDrawer extends Disposable {
	private readonly topBarSlotEl: HTMLElement;
	private readonly topBarEl: HTMLElement;
	private readonly fileBtnEl: HTMLButtonElement;
	private readonly fileDotEl: HTMLElement;
	private readonly layoutBtnEl: HTMLButtonElement;
	private readonly layoutMenuEl: HTMLElement;
	private readonly layoutMenuItemByMode = new Map<OrchestrationLayoutMode, HTMLButtonElement>();
	private readonly fileDrawerEl: HTMLElement;
	private readonly drawerFilenameEl: HTMLElement;
	private readonly drawerMetaEl: HTMLElement;
	private readonly closeBtnEl: HTMLButtonElement;
	private readonly splitBodyEl: HTMLElement;
	private readonly leftPaneTitleEl: HTMLElement;
	private readonly codeTextareaEl: HTMLTextAreaElement;
	private readonly rightPaneEl: HTMLElement;
	private readonly rightPaneTitleEl: HTMLElement;
	private readonly taskCountPillEl: HTMLElement;
	private readonly tasksListEl: HTMLElement;
	private readonly drawerStatusEl: HTMLElement;

	private readonly taskCardsDisposables = this._register(new DisposableStore());
	private readonly taskCardById = new Map<string, {
		readonly cardEl: HTMLElement;
		readonly titleEl: HTMLElement;
		readonly statusEl: HTMLElement;
		readonly textareaEl: HTMLTextAreaElement;
	}>();

	private viewMode: AdeEngineeringViewMode = 'mission';
	private layoutMode: OrchestrationLayoutMode = 'lr';
	private layoutMenuOpen = false;
	private drawerOpen = false;
	private focusedTaskNodeId: string | undefined;
	private parseTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		bodyEl: HTMLElement,
		private readonly delegate: IMissionFileDrawerDelegate,
	) {
		super();

		this.topBarSlotEl = append(bodyEl, $('.ade-mission-top-bar-slot', {
			'data-ade-mission-top-bar-slot': 'true',
		}));
		this.topBarEl = append(this.topBarSlotEl, $('.ade-mission-top-bar', {
			'data-ade-mission-top-bar': 'true',
		}));

		// STRICTLY ONE button in the top-left corner of the canvas
		this.fileBtnEl = append(this.topBarEl, $('button.ade-mission-file-btn', {
			type: 'button',
			title: adeBi(localize('adeEngCodeBtnTooltip', "Open Blueprint Source Drawer"), '展开编排源码面板'),
			'aria-label': adeBi(localize('adeEngCodeBtnAria', "Open Blueprint Source Drawer"), '展开编排源码面板'),
			'aria-expanded': 'false',
			'data-ade-mission-file-btn': 'true',
		})) as HTMLButtonElement;
		const iconEl = append(this.fileBtnEl, $('span', { 'aria-hidden': 'true' }));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		this.fileDotEl = append(this.fileBtnEl, $('span.ade-mission-file-dot', { 'aria-hidden': 'true' }));
		this.fileDotEl.hidden = true;

		this._register(addDisposableListener(this.fileBtnEl, EventType.CLICK, () => {
			this.toggleLayoutMenu(false);
			this.toggle();
		}));

		// Orchestration-only single additional button: visual layout presentation switcher (LR / TD / Radial / Grid)
		this.layoutBtnEl = $('button.ade-mission-file-btn.ade-orch-layout-btn', {
			type: 'button',
			title: adeBi(localize('adeOrchLayoutBtnTooltip', "Switch Orchestration Layout"), '切换编排展示视图'),
			'aria-label': adeBi(localize('adeOrchLayoutBtnAria', "Switch Orchestration Layout"), '切换编排展示视图'),
			'aria-expanded': 'false',
			'aria-haspopup': 'menu',
			'data-ade-orch-layout-btn': 'true',
		}) as HTMLButtonElement;
		const layoutIconEl = append(this.layoutBtnEl, $('span', { 'aria-hidden': 'true' }));
		layoutIconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.layout));
		this._register(addDisposableListener(this.layoutBtnEl, EventType.CLICK, e => {
			e.stopPropagation();
			this.toggleLayoutMenu();
		}));

		this.layoutMenuEl = append(bodyEl, $('.ade-orch-layout-menu', {
			role: 'menu',
			'aria-label': adeBi(localize('adeOrchLayoutMenuAria', "Orchestration Presentation Layouts"), '编排展示方式'),
			'data-ade-orch-layout-menu': 'true',
		}));
		this.layoutMenuEl.hidden = true;
		this._register(addDisposableListener(this.layoutMenuEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.rebuildLayoutMenuItems();

		const doc = getWindow(bodyEl).document;
		this._register(addDisposableListener(doc, EventType.POINTER_DOWN, e => {
			if (!this.layoutMenuOpen) {
				return;
			}
			const target = e.target as Node | null;
			if (target && (this.layoutMenuEl.contains(target) || this.layoutBtnEl.contains(target))) {
				return;
			}
			this.toggleLayoutMenu(false);
		}));
		this._register(addDisposableListener(doc, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (this.layoutMenuOpen && e.key === 'Escape') {
				this.toggleLayoutMenu(false);
			}
		}));

		this.fileDrawerEl = append(bodyEl, $('.ade-mission-file-drawer', {
			role: 'dialog',
			'aria-label': adeBi(localize('adeEngDrawerAria', "Engineering Source Drawer"), '工程编排源码面板'),
			'data-ade-mission-drawer': 'true',
		}));
		this.fileDrawerEl.hidden = true;
		this._register(addDisposableListener(this.fileDrawerEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

		const header = append(this.fileDrawerEl, $('.ade-mission-drawer-header'));
		const titleWrap = append(header, $('.ade-mission-drawer-title'));
		const titleIcon = append(titleWrap, $('span', { 'aria-hidden': 'true' }));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		this.drawerFilenameEl = append(titleWrap, $('span.ade-mission-drawer-filename', {}, 'mission.mmd'));
		this.drawerMetaEl = append(titleWrap, $('span.ade-mission-drawer-meta', {}, adeBi(localize('adeMissionDrawerMetaEmpty', "Empty"), '空画布')));

		const actions = append(header, $('.ade-mission-drawer-actions'));
		this.closeBtnEl = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭'),
			'aria-label': adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭'),
			'data-ade-drawer-close': 'true',
		})) as HTMLButtonElement;
		this.closeBtnEl.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(this.closeBtnEl, EventType.CLICK, () => {
			this.toggle(false);
		}));

		this.splitBodyEl = append(this.fileDrawerEl, $('.ade-mission-drawer-split', {
			'data-ade-mission-drawer-split': 'true',
		}));

		// Area 1: Declarative Code Editor (Mission: Mermaid DAG; Orchestration: Cyclic Staff Topology — ONLY area!)
		const leftPane = append(this.splitBodyEl, $('.ade-mission-drawer-left', {
			'data-ade-mission-mermaid-pane': 'true',
		}));
		const leftHead = append(leftPane, $('.ade-mission-drawer-pane-head'));
		append(leftHead, $('span.codicon.codicon-code', { 'aria-hidden': 'true' }));
		this.leftPaneTitleEl = append(leftHead, $('span', {}, adeBi(localize('adeMissionDagCodeTitle', "Mermaid Task DAG"), 'Mermaid 任务有向无环图')));

		this.codeTextareaEl = append(leftPane, $('textarea.ade-mission-mermaid-input', {
			spellcheck: 'false',
			placeholder: MISSION_MERMAID_PLACEHOLDER,
			'aria-label': adeBi(localize('adeMissionMermaidInputAria', "Mermaid Definition"), 'Mermaid 编排代码'),
			'data-ade-mission-mermaid-input': 'true',
		})) as HTMLTextAreaElement;

		this._register(addDisposableListener(this.codeTextareaEl, EventType.INPUT, () => {
			const nextText = this.codeTextareaEl.value;
			this.clearParseTimer();
			this.parseTimer = setTimeout(() => {
				this.parseTimer = undefined;
				this.delegate.onCodeDraftChange(nextText);
			}, 90);
		}));
		this._register(addDisposableListener(this.codeTextareaEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key !== 'Escape') {
				e.stopPropagation();
			}
		}));

		// Area 2 (Mission view ONLY): All Task Nodes' Descriptions Display & Direct Editor
		this.rightPaneEl = append(this.splitBodyEl, $('.ade-mission-drawer-right', {
			'data-ade-mission-prompts-pane': 'true',
			'data-ade-mission-tasks-pane': 'true',
		}));
		const rightHead = append(this.rightPaneEl, $('.ade-mission-drawer-pane-head'));
		append(rightHead, $('span.codicon.codicon-checklist', { 'aria-hidden': 'true' }));
		this.rightPaneTitleEl = append(rightHead, $('span', {}, adeBi(localize('adeMissionTaskDescsTitle', "Task Descriptions"), '全部任务节点描述')));
		this.taskCountPillEl = append(rightHead, $('span.ade-mission-drawer-prompt-pill', {
			'data-ade-mission-prompt-count': 'true',
		}, '0'));

		this.tasksListEl = append(this.rightPaneEl, $('.ade-mission-all-tasks-list', {
			'data-ade-mission-all-tasks-list': 'true',
		}));

		const footer = append(this.fileDrawerEl, $('.ade-mission-drawer-footer'));
		this.drawerStatusEl = append(footer, $('span.ade-mission-drawer-status', {}, adeBi(
			localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes"),
			'编写 Mermaid 语法以实时渲染画布',
		)));

		this._register(onDidChangeAdeLocale(() => this.applyViewModeUi(true)));
		this.applyViewModeUi(false);
	}

	override dispose(): void {
		this.clearParseTimer();
		super.dispose();
	}

	setViewMode(mode: AdeEngineeringViewMode): void {
		if (this.viewMode === mode) {
			return;
		}
		this.viewMode = mode;
		this.toggleLayoutMenu(false);
		this.applyViewModeUi(true);
	}

	setLayoutMode(mode: OrchestrationLayoutMode): void {
		this.layoutMode = mode;
		for (const [m, btn] of this.layoutMenuItemByMode.entries()) {
			const active = m === mode;
			btn.classList.toggle('is-active', active);
			btn.setAttribute('aria-checked', String(active));
		}
	}

	toggleLayoutMenu(forceOpen?: boolean): void {
		if (this.viewMode !== 'orchestration') {
			this.layoutMenuOpen = false;
			this.layoutMenuEl.hidden = true;
			this.layoutBtnEl.classList.remove('active');
			this.layoutBtnEl.setAttribute('aria-expanded', 'false');
			return;
		}
		const nextOpen = forceOpen ?? !this.layoutMenuOpen;
		this.layoutMenuOpen = nextOpen;
		this.layoutMenuEl.hidden = !nextOpen;
		this.layoutBtnEl.classList.toggle('active', nextOpen);
		this.layoutBtnEl.setAttribute('aria-expanded', String(nextOpen));
		if (nextOpen) {
			this.setLayoutMode(this.delegate.getOrchestrationLayoutMode?.() ?? this.layoutMode);
		}
	}

	private rebuildLayoutMenuItems(): void {
		clearNode(this.layoutMenuEl);
		this.layoutMenuItemByMode.clear();
		append(this.layoutMenuEl, $('.ade-orch-layout-menu-header', {}, adeBi(
			localize('adeOrchLayoutMenuTitle', "Display Layout (Code Unchanged)"),
			'编排展示方式（不改动编排代码）',
		)));
		const options: readonly {
			readonly mode: OrchestrationLayoutMode;
			readonly icon: ThemeIcon;
			readonly title: string;
			readonly desc: string;
		}[] = [
			{
				mode: 'lr',
				icon: Codicon.arrowRight,
				title: adeBi(localize('adeOrchLayoutLrTitle', "Left → Right Hierarchy"), '从左到右层级流'),
				desc: adeBi(localize('adeOrchLayoutLrDesc', "Highest rank on left, cascading rightward by department"), '最高职级居左，按部门向右逐级展开'),
			},
			{
				mode: 'td',
				icon: Codicon.arrowDown,
				title: adeBi(localize('adeOrchLayoutTdTitle', "Top → Down Org Tree"), '从上到下组织树'),
				desc: adeBi(localize('adeOrchLayoutTdDesc', "Highest rank on top, departments cascading downward"), '最高职级居顶，各部门向下展开'),
			},
			{
				mode: 'radial',
				icon: Codicon.target,
				title: adeBi(localize('adeOrchLayoutRadialTitle', "Core-Centered Radial"), '核心居中四周辐射'),
				desc: adeBi(localize('adeOrchLayoutRadialDesc', "Core leader in center, departments radiating 360° around"), '核心角色居正中，多部门环绕四周'),
			},
			{
				mode: 'grid',
				icon: Codicon.layoutPanel,
				title: adeBi(localize('adeOrchLayoutGridTitle', "Department Matrix"), '部门矩阵总览'),
				desc: adeBi(localize('adeOrchLayoutGridDesc', "Compact multi-column grid for large multi-dept orgs"), '多部门方阵排布，适合大型工程全景查看'),
			},
		];
		for (const opt of options) {
			const itemBtn = append(this.layoutMenuEl, $('button.ade-orch-layout-item', {
				type: 'button',
				role: 'menuitemradio',
				'aria-checked': String(this.layoutMode === opt.mode),
				'data-ade-orch-layout-option': opt.mode,
			})) as HTMLButtonElement;
			itemBtn.classList.toggle('is-active', this.layoutMode === opt.mode);
			const ico = append(itemBtn, $('span.ade-orch-layout-item-ico', { 'aria-hidden': 'true' }));
			ico.classList.add(...ThemeIcon.asClassNameArray(opt.icon));
			const textCol = append(itemBtn, $('.ade-orch-layout-item-text'));
			append(textCol, $('span.ade-orch-layout-item-title', {}, opt.title));
			append(textCol, $('span.ade-orch-layout-item-desc', {}, opt.desc));
			const check = append(itemBtn, $('span.ade-orch-layout-item-check', { 'aria-hidden': 'true' }));
			check.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
			this._register(addDisposableListener(itemBtn, EventType.CLICK, e => {
				e.stopPropagation();
				this.setLayoutMode(opt.mode);
				this.toggleLayoutMenu(false);
				this.delegate.onChangeOrchestrationLayoutMode?.(opt.mode);
			}));
			this.layoutMenuItemByMode.set(opt.mode, itemBtn);
		}
	}

	private applyViewModeUi(refreshCards: boolean): void {
		const isOrch = this.viewMode === 'orchestration';
		this.fileDrawerEl.classList.toggle('mode-orchestration', isOrch);
		this.fileDrawerEl.classList.toggle('mode-mission', !isOrch);
		this.fileDrawerEl.dataset.viewMode = this.viewMode;
		this.splitBodyEl.classList.toggle('single-pane', isOrch);
		this.rightPaneEl.hidden = isOrch;
		if (isOrch) {
			if (this.layoutBtnEl.parentElement !== this.topBarEl) {
				this.topBarEl.appendChild(this.layoutBtnEl);
			}
			this.layoutBtnEl.hidden = false;
		} else {
			this.layoutBtnEl.remove();
			this.toggleLayoutMenu(false);
		}
		const layoutTip = adeBi(localize('adeOrchLayoutBtnTooltip', "Switch Orchestration Layout"), '切换编排展示视图');
		this.layoutBtnEl.title = layoutTip;
		this.layoutBtnEl.setAttribute('aria-label', layoutTip);
		this.rebuildLayoutMenuItems();

		const btnTip = isOrch
			? adeBi(localize('adeOrchCodeBtnTooltip', "Orchestration Topology Code"), '展开员工编排代码')
			: adeBi(localize('adeMissionCodeBtnTooltip', "Mission Mermaid & Task Descriptions"), '展开任务图代码与节点描述');
		this.fileBtnEl.title = btnTip;
		this.fileBtnEl.setAttribute('aria-label', btnTip);
		this.closeBtnEl.title = adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭');
		this.closeBtnEl.setAttribute('aria-label', adeBi(localize('adeMissionCloseDrawer', "Close"), '关闭'));

		this.drawerFilenameEl.textContent = isOrch ? 'orchestration.mmd' : 'mission.mmd';
		this.leftPaneTitleEl.textContent = isOrch
			? adeBi(localize('adeOrchCodePaneTitle', "Declarative Staff Topology (Cycles & Bidirectional Supported)"), '声明式员工编排代码（支持双向与回路 · 实时双向同步）')
			: adeBi(localize('adeMissionDagCodeTitle', "Mermaid Task DAG (Strictly Acyclic)"), 'Mermaid 任务流图（严格无环 DAG）');
		this.rightPaneTitleEl.textContent = adeBi(localize('adeMissionTaskDescsTitle', "Task Descriptions"), '全部任务节点描述');
		this.codeTextareaEl.placeholder = isOrch ? ORCHESTRATION_CODE_PLACEHOLDER : MISSION_MERMAID_PLACEHOLDER;
		if (isOrch) {
			this.codeTextareaEl.setAttribute('data-ade-orchestration-code-input', 'true');
		} else {
			this.codeTextareaEl.removeAttribute('data-ade-orchestration-code-input');
		}

		if (isOrch) {
			this.taskCardsDisposables.clear();
			this.taskCardById.clear();
			clearNode(this.tasksListEl);
			this.taskCountPillEl.textContent = '';
		} else if (refreshCards) {
			this.syncTaskDescriptionsPane(true);
		}
	}

	clearParseTimer(): void {
		if (this.parseTimer !== undefined) {
			clearTimeout(this.parseTimer);
			this.parseTimer = undefined;
		}
	}

	isOpen(): boolean {
		return this.drawerOpen;
	}

	setSelectedTaskNodeId(nodeId: string | undefined): void {
		this.focusedTaskNodeId = nodeId;
	}

	setCodeValue(text: string): void {
		this.clearParseTimer();
		if (this.codeTextareaEl.value !== text) {
			this.codeTextareaEl.value = text;
		}
	}

	setFileDotVisible(visible: boolean): void {
		this.fileDotEl.hidden = !visible;
	}

	setMeta(text: string): void {
		if (this.drawerMetaEl.textContent !== text) {
			this.drawerMetaEl.textContent = text;
		}
	}

	setStatus(text: string, kind?: 'ok' | 'error'): void {
		this.drawerStatusEl.textContent = text;
		this.drawerStatusEl.className = kind ? `ade-mission-drawer-status ${kind}` : 'ade-mission-drawer-status';
	}

	toggle(forceOpen?: boolean, focusNodeId?: string): void {
		const nextOpen = forceOpen ?? !this.drawerOpen;
		const changed = nextOpen !== this.drawerOpen;
		this.drawerOpen = nextOpen;
		if (focusNodeId) {
			this.focusedTaskNodeId = focusNodeId;
		}
		this.fileDrawerEl.hidden = !this.drawerOpen;
		this.fileBtnEl.classList.toggle('active', this.drawerOpen);
		this.fileBtnEl.setAttribute('aria-expanded', String(this.drawerOpen));
		if (this.drawerOpen) {
			if (this.viewMode === 'mission') {
				this.syncTaskDescriptionsPane(false);
				const targetCard = focusNodeId ? this.taskCardById.get(focusNodeId) : undefined;
				if (targetCard) {
					targetCard.cardEl.scrollIntoView({ block: 'nearest' });
					targetCard.textareaEl.focus();
				} else {
					this.codeTextareaEl.focus();
				}
			} else {
				this.codeTextareaEl.focus();
			}
		}
		if (changed) {
			this.delegate.onDrawerOpenChanged?.(this.drawerOpen);
		}
	}

	syncTaskDescriptionsPane(preserveActiveTextarea = false): void {
		if (this.viewMode !== 'mission') {
			return;
		}
		const tasks = this.delegate.getMissionTaskNodes();
		const descriptions = this.delegate.getTaskDescriptions();
		const statuses = this.delegate.getTaskStatuses();

		const completedCount = tasks.filter(t => statuses[t.id]?.status === 'completed').length;
		const pillText = adeBi(
			localize('adeMissionTasksDonePill', "{0}/{1} Done", completedCount, tasks.length),
			'{0}/{1} 已完成',
			completedCount,
			tasks.length,
		);
		if (this.taskCountPillEl.textContent !== pillText) {
			this.taskCountPillEl.textContent = pillText;
		}
		this.taskCountPillEl.classList.toggle('has-prompts', completedCount > 0);

		if (tasks.length === 0) {
			this.taskCardsDisposables.clear();
			this.taskCardById.clear();
			clearNode(this.tasksListEl);
			append(this.tasksListEl, $('.ade-mission-prompt-empty', {}, adeBi(
				localize('adeMissionNoTasksInDrawer', "Add task nodes in the Mermaid DAG on the left to edit their descriptions here."),
				'在左侧编写 Mermaid 任务节点后，即可在此统一查看和编辑每个任务的详细描述。',
			)));
			return;
		}

		const formatStatusBadge = (nodeId: string): { readonly label: string; readonly cls: string } => {
			const st = statuses[nodeId]?.status ?? 'pending';
			if (st === 'completed') {
				return { label: adeBi(localize('adeTaskStatusDone', "Completed"), '已完成'), cls: 'status-completed' };
			}
			if (st === 'in_progress') {
				return { label: adeBi(localize('adeTaskStatusInProgress', "In Progress"), '进行中'), cls: 'status-in-progress' };
			}
			if (st === 'blocked') {
				return { label: adeBi(localize('adeTaskStatusBlocked', "Blocked"), '阻塞中'), cls: 'status-blocked' };
			}
			return { label: adeBi(localize('adeTaskStatusPending', "Pending"), '待完成'), cls: 'status-pending' };
		};

		const existingIds = Array.from(this.taskCardById.keys());
		const sameOrder = existingIds.length === tasks.length && existingIds.every((id, i) => id === tasks[i].id);

		if (sameOrder) {
			for (const task of tasks) {
				const entry = this.taskCardById.get(task.id)!;
				if (entry.titleEl.textContent !== task.label) {
					entry.titleEl.textContent = task.label;
					entry.titleEl.title = task.label;
				}
				const badge = formatStatusBadge(task.id);
				entry.statusEl.className = `ade-mission-task-desc-status ${badge.cls}`;
				if (entry.statusEl.textContent !== badge.label) {
					entry.statusEl.textContent = badge.label;
				}
				const nextDesc = descriptions[task.id] ?? '';
				const isFocused = document.activeElement === entry.textareaEl;
				if ((!preserveActiveTextarea || !isFocused) && entry.textareaEl.value !== nextDesc) {
					entry.textareaEl.value = nextDesc;
				}
				entry.cardEl.classList.toggle('is-focused', this.focusedTaskNodeId === task.id);
			}
			return;
		}

		this.taskCardsDisposables.clear();
		this.taskCardById.clear();
		clearNode(this.tasksListEl);

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			const badge = formatStatusBadge(task.id);
			const descText = descriptions[task.id] ?? '';
			const cardEl = append(this.tasksListEl, $(`.ade-mission-task-desc-card${this.focusedTaskNodeId === task.id ? '.is-focused' : ''}`, {
				'data-ade-mission-task-desc-card': task.id,
			}));
			const headEl = append(cardEl, $('.ade-mission-task-desc-head'));
			append(headEl, $('span.ade-mission-task-desc-id', {}, task.id));
			const titleEl = append(headEl, $('span.ade-mission-task-desc-title', { title: task.label }, task.label));
			const statusEl = append(headEl, $(`span.ade-mission-task-desc-status.${badge.cls}`, {
				'data-task-status': statuses[task.id]?.status ?? 'pending',
			}, badge.label));

			const textareaEl = append(cardEl, $('textarea.ade-mission-task-desc-input', {
				rows: '3',
				spellcheck: 'false',
				placeholder: adeBi(
					localize('adeMissionTaskDescPlaceholder', "Write detailed task goals, deliverables, and acceptance criteria for {0}…", task.label),
					'填写任务「{0}」的详细目标、交付物与验收标准…',
					task.label,
				),
				'aria-label': adeBi(localize('adeMissionTaskDescAria', "Description for task {0}", task.id), '任务 {0} 详细描述', task.id),
				'data-ade-task-desc-input': task.id,
				...(i === 0 ? { 'data-ade-node-prompt-input': 'true' } : {}),
			})) as HTMLTextAreaElement;
			textareaEl.value = descText;

			this.taskCardsDisposables.add(addDisposableListener(textareaEl, EventType.INPUT, () => {
				this.focusedTaskNodeId = task.id;
				this.delegate.onTaskDescriptionEdit(task.id, textareaEl.value);
			}));
			this.taskCardsDisposables.add(addDisposableListener(textareaEl, EventType.FOCUS, () => {
				this.focusedTaskNodeId = task.id;
				for (const [id, entry] of this.taskCardById.entries()) {
					entry.cardEl.classList.toggle('is-focused', id === task.id);
				}
			}));
			this.taskCardsDisposables.add(addDisposableListener(textareaEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key !== 'Escape') {
					e.stopPropagation();
				}
			}));

			this.taskCardById.set(task.id, { cardEl, titleEl, statusEl, textareaEl });
		}
	}
}
