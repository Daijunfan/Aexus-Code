/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	formatLevelLabel,
	IAdeEdgeTransferRecord,
	IAdeProjectSnapshot,
	IAdeUiTicketFullInspection,
	IAdeUiTicketTaskRecord,
} from '../../../../platform/ade/common/adeModels.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { adeBi } from '../common/adeLocalization.js';

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

export function formatEdgeTransferTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Renders untrusted Markdown strictly with `{ isTrusted: false, supportHtml: false }` via
 * `IMarkdownRendererService.render(md, ...)` (falling back to `renderMarkdown` in pure DOM unit tests)
 * to block HTML / script / command-URI XSS injection.
 */
export function renderUntrustedAdeMarkdown(
	markdownRendererService: IMarkdownRendererService | undefined,
	rawMarkdown: string,
	disposables: DisposableStore,
): HTMLElement {
	const md = new MarkdownString(rawMarkdown || '', {
		isTrusted: false,
		supportHtml: false,
	});
	const rendered = markdownRendererService
		? markdownRendererService.render(md)
		: renderMarkdown(md);
	disposables.add(rendered);
	rendered.element.classList.add('ade-safe-markdown');
	return rendered.element;
}

export interface IAdeEdgeTicketHistoryPopoverDelegate {
	getProjectId(): string | undefined;
	getProjectSnapshot(): IAdeProjectSnapshot | undefined;
	onDidDismissEdgeSelection?(): void;
}

/**
 * Edge Hover Timestamp Tip & Click Full Transfer History + Single-Ticket Drill-Down Popover (`plan.md` §8.4):
 * - Mounted directly on `AdeEngineeringEditorPane.bodyEl` (outside `viewportEl` CSS scale transform).
 * - Physically isolated from node popovers (`this.popovers`): canvas wheel zoom and topology refreshes NEVER close it.
 * - Hover state (`.ade-edge-hover-time-tip`, `pointer-events: none`) renders ONLY the latest transfer timestamp
 *   (`最近传递：YYYY-MM-DD HH:mm:ss` / `暂无 Ticket 传递记录`), zero ticket ID, title, or summary, and hides while Click popover is open.
 * - Click state intercepts `wheel` & `pointerdown` (`stopPropagation()`), supports two-stage `Escape` (detail -> list -> close),
 *   lists all transfers (`active`, archived hops, `frozen_orphan` with `deleted_agents` name restoration, `destroyed`, `[跨级途经 L1 → L3]`),
 *   and drills down into all 10 standard Ticket fields, `current_task`, `tasks` history chain, and full `detail` (including gunzipped destroyed tickets).
 */
export class AdeEdgeTicketHistoryPopover extends Disposable {
	readonly hoverTipEl: HTMLElement;
	readonly popoverEl: HTMLElement;

	private readonly viewDisposables = this._register(new DisposableStore());
	private readonly detailLoadDisposables = this._register(new DisposableStore());

	private hoveredEdgePairKey: string | undefined;
	private hoverRequestSeq = 0;

	private openProjectId: string | undefined;
	private openEdgePairKey: string | undefined;
	private cachedRecords: readonly IAdeEdgeTransferRecord[] = [];
	private selectedTicketId: string | undefined;
	private currentListEl: HTMLElement | undefined;
	private currentDetailScrollEl: HTMLElement | undefined;
	private cachedInspection: IAdeUiTicketFullInspection | undefined;
	private readonly expandedTaskDetails = new Map<string, string>();
	private readonly loadingTaskIds = new Set<string>();
	private listScrollTop = 0;
	private detailScrollTop = 0;
	private loadSeq = 0;

	constructor(
		private readonly bodyEl: HTMLElement,
		private readonly controlCenterService: IAdeControlCenterService,
		private readonly markdownRendererService: IMarkdownRendererService | undefined,
		private readonly delegate: IAdeEdgeTicketHistoryPopoverDelegate,
	) {
		super();

		this.hoverTipEl = append(this.bodyEl, $('.ade-edge-hover-time-tip', {
			'data-ade-edge-hover-tip': 'true',
		}));
		this.hoverTipEl.style.pointerEvents = 'none';
		this.hoverTipEl.hidden = true;

		this.popoverEl = append(this.bodyEl, $('.ade-edge-history-popover', {
			'data-ade-edge-history-popover': 'true',
			role: 'dialog',
			tabIndex: -1,
		}));
		this.popoverEl.hidden = true;

		// Prevent canvas pan/zoom/outside-dismissal when interacting or scrolling inside the popover!
		this._register(addDisposableListener(this.popoverEl, EventType.POINTER_DOWN, e => {
			e.stopPropagation();
		}));
		this._register(addDisposableListener(this.popoverEl, EventType.WHEEL, e => {
			e.stopPropagation();
		}, { passive: false }));
		this._register(addDisposableListener(this.popoverEl, EventType.CLICK, e => {
			e.stopPropagation();
		}));
		this._register(addDisposableListener(this.popoverEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.handleEscapeKey();
			}
		}));

		// Outside click on canvas background closes Click popover cleanly (but NEVER on wheel or topology sync!)
		const win = getWindow(this.bodyEl);
		this._register(addDisposableListener(win.document, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!this.isClickPopoverOpen()) {
				return;
			}
			const target = e.target as Node | null;
			if (target && this.popoverEl.contains(target)) {
				return;
			}
			if (target instanceof Element && target.closest('[data-ade-select-portal="true"]')) {
				return;
			}
			if (target instanceof Element && target.closest('.ade-mission-edge-group:not(.is-whiteboard-link)')) {
				return;
			}
			this.closeClickPopover();
		}, true));
	}

	override dispose(): void {
		this.hoverTipEl.remove();
		this.popoverEl.remove();
		super.dispose();
	}

	isHoverVisible(): boolean {
		return !this.hoverTipEl.hidden;
	}

	isClickPopoverOpen(): boolean {
		return !this.popoverEl.hidden && Boolean(this.openEdgePairKey);
	}

	getOpenEdgePairKey(): string | undefined {
		return this.isClickPopoverOpen() ? this.openEdgePairKey : undefined;
	}

	isInDetailView(): boolean {
		return this.isClickPopoverOpen() && Boolean(this.selectedTicketId);
	}

	/**
	 * Two-stage `Escape`:
	 * 1. If viewing single-Ticket detail, return to Level-1 transfer list.
	 * 2. If on Level-1 transfer list, close the popover.
	 */
	handleEscapeKey(): boolean {
		if (!this.isClickPopoverOpen()) {
			return false;
		}
		if (this.selectedTicketId !== undefined) {
			this.selectedTicketId = undefined;
			this.cachedInspection = undefined;
			this.expandedTaskDetails.clear();
			this.loadingTaskIds.clear();
			this.renderListView();
			return true;
		}
		this.closeClickPopover();
		return true;
	}

	// =========================================================================
	// Hover State: Strict Timestamp-Only Tip (`.ade-edge-hover-time-tip`)
	// =========================================================================

	showHover(edgePairKey: string, clientX: number, clientY: number): void {
		this.hoveredEdgePairKey = edgePairKey;
		if (this.isClickPopoverOpen()) {
			this.hoverTipEl.hidden = true;
			return;
		}
		const projectId = this.delegate.getProjectId();
		if (!projectId) {
			return;
		}
		const snap = this.delegate.getProjectSnapshot();
		const cachedTs = snap?.edge_latest_transfer_at?.[edgePairKey];
		this.renderHoverTimestampText(cachedTs);
		this.positionHoverTip(clientX, clientY);
		this.hoverTipEl.hidden = false;

		const seq = ++this.hoverRequestSeq;
		void this.controlCenterService.getEdgeLatestTransferTime(projectId, edgePairKey).then(freshTs => {
			if (seq !== this.hoverRequestSeq || this.hoveredEdgePairKey !== edgePairKey || this.isClickPopoverOpen()) {
				return;
			}
			this.renderHoverTimestampText(freshTs ?? undefined);
		}).catch(() => undefined);
	}

	moveHover(edgePairKey: string, clientX: number, clientY: number): void {
		if (this.hoveredEdgePairKey !== edgePairKey || this.isClickPopoverOpen()) {
			this.hoverTipEl.hidden = true;
			return;
		}
		this.positionHoverTip(clientX, clientY);
	}

	hideHover(edgePairKey?: string): void {
		if (edgePairKey && this.hoveredEdgePairKey && this.hoveredEdgePairKey !== edgePairKey) {
			return;
		}
		this.hoveredEdgePairKey = undefined;
		this.hoverRequestSeq++;
		this.hoverTipEl.hidden = true;
	}

	private renderHoverTimestampText(latestTs: number | null | undefined): void {
		if (typeof latestTs === 'number' && Number.isFinite(latestTs) && latestTs > 0) {
			const formatted = formatEdgeTransferTimestamp(latestTs);
			this.hoverTipEl.textContent = adeBi(
				localize('adeEdgeHoverLatestTransfer', "Latest transfer: {0}", formatted),
				'最近传递：{0}',
				formatted,
			);
		} else {
			this.hoverTipEl.textContent = adeBi(
				localize('adeEdgeHoverNoTransfers', "No Ticket transfer records"),
				'暂无 Ticket 传递记录',
			);
		}
	}

	private positionHoverTip(clientX: number, clientY: number): void {
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const relX = clientX - bodyRect.left + 12;
		const relY = clientY - bodyRect.top - 30;
		const maxLeft = Math.max(8, bodyRect.width - 250);
		const maxTop = Math.max(8, bodyRect.height - 36);
		this.hoverTipEl.style.left = `${Math.round(Math.max(8, Math.min(maxLeft, relX)))}px`;
		this.hoverTipEl.style.top = `${Math.round(Math.max(8, Math.min(maxTop, relY)))}px`;
	}

	// =========================================================================
	// Click State: Full Edge Transfer History & 10-Field Ticket Detail Popover
	// =========================================================================

	async openForEdge(edgePairKey: string, clientX: number, clientY: number): Promise<void> {
		const projectId = this.delegate.getProjectId();
		if (!projectId) {
			return;
		}
		// Auto-hide Hover tip immediately while Click popover is open!
		this.hoverTipEl.hidden = true;

		const isSameEdge = this.isClickPopoverOpen() && this.openProjectId === projectId && this.openEdgePairKey === edgePairKey;
		this.openProjectId = projectId;
		this.openEdgePairKey = edgePairKey;
		if (!isSameEdge) {
			this.selectedTicketId = undefined;
			this.cachedInspection = undefined;
			this.expandedTaskDetails.clear();
			this.loadingTaskIds.clear();
			this.listScrollTop = 0;
			this.positionClickPopover(clientX, clientY);
		}
		this.popoverEl.hidden = false;
		await this.reloadRecordsInPlace();
		this.popoverEl.focus();
	}

	closeClickPopover(): void {
		if (this.popoverEl.hidden && !this.openEdgePairKey) {
			return;
		}
		const hadOpen = Boolean(this.openEdgePairKey);
		this.openProjectId = undefined;
		this.openEdgePairKey = undefined;
		this.selectedTicketId = undefined;
		this.currentListEl = undefined;
		this.cachedRecords = [];
		this.cachedInspection = undefined;
		this.expandedTaskDetails.clear();
		this.loadingTaskIds.clear();
		this.viewDisposables.clear();
		this.detailLoadDisposables.clear();
		clearNode(this.popoverEl);
		this.popoverEl.hidden = true;
		if (hadOpen) {
			this.delegate.onDidDismissEdgeSelection?.();
		}
	}

	/**
	 * Called when topology snapshot updates or a new `onDidTransferTicket` arrives:
	 * - NEVER closes the popover if the edge still exists!
	 * - Incrementally refreshes the transfer list (or open Ticket detail) in-place!
	 */
	notifyTopologyOrTransferUpdated(activeEdgePairKeys: ReadonlySet<string>): void {
		if (!this.isClickPopoverOpen() || !this.openEdgePairKey) {
			return;
		}
		const currentProjectId = this.delegate.getProjectId();
		if (!currentProjectId || currentProjectId !== this.openProjectId || !activeEdgePairKeys.has(this.openEdgePairKey)) {
			this.closeClickPopover();
			return;
		}
		void this.reloadRecordsInPlace();
	}

	private positionClickPopover(clientX: number, clientY: number): void {
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const popW = 480;
		const popH = 440;
		const rawLeft = clientX - bodyRect.left + 14;
		const rawTop = clientY - bodyRect.top - 24;
		const maxLeft = Math.max(12, bodyRect.width - popW - 12);
		const maxTop = Math.max(12, bodyRect.height - popH - 12);
		this.popoverEl.style.left = `${Math.round(Math.max(12, Math.min(maxLeft, rawLeft)))}px`;
		this.popoverEl.style.top = `${Math.round(Math.max(12, Math.min(maxTop, rawTop)))}px`;
	}

	private async reloadRecordsInPlace(): Promise<void> {
		if (!this.openProjectId || !this.openEdgePairKey) {
			return;
		}
		const reqSeq = ++this.loadSeq;
		const projectId = this.openProjectId;
		const edgePairKey = this.openEdgePairKey;
		try {
			const records = await this.controlCenterService.listEdgeTicketTransfers(projectId, edgePairKey);
			if (reqSeq !== this.loadSeq || !this.isClickPopoverOpen() || this.openEdgePairKey !== edgePairKey) {
				return;
			}
			// Sort strictly by `transferred_at` DESC
			this.cachedRecords = [...records].sort((a, b) => b.transferred_at - a.transferred_at);
			if (this.selectedTicketId) {
				const insp = await this.controlCenterService.inspectTicketFullDetailForUi(projectId, this.selectedTicketId);
				if (reqSeq !== this.loadSeq || !this.isClickPopoverOpen()) {
					return;
				}
				this.cachedInspection = insp ?? undefined;
				if (insp) {
					this.renderDetailView(insp);
				} else {
					this.selectedTicketId = undefined;
					this.renderListView();
				}
			} else {
				this.renderListView();
			}
		} catch {
			if (reqSeq === this.loadSeq && this.isClickPopoverOpen()) {
				this.renderListView();
			}
		}
	}

	private resolveAgentDisplay(agentId: string, fallbackName?: string): { readonly name: string; readonly levelLabel?: string; readonly isDeleted: boolean } {
		const snap = this.delegate.getProjectSnapshot();
		const live = snap?.agents.find(a => a.agent_id === agentId);
		if (live) {
			return {
				name: live.name,
				levelLabel: formatLevelLabel(live.level),
				isDeleted: false,
			};
		}
		const archived = snap?.deleted_agents.find(d => d.agent_id === agentId);
		if (archived) {
			return {
				name: archived.name,
				levelLabel: formatLevelLabel(archived.level),
				isDeleted: true,
			};
		}
		return {
			name: fallbackName?.trim() || agentId,
			isDeleted: false,
		};
	}

	private formatLifecycleBadge(status: 'active' | 'frozen_orphan' | 'destroyed'): { readonly text: string; readonly cls: string } {
		switch (status) {
			case 'active':
				return {
					text: adeBi(localize('adeEdgeTicketActive', "Active"), '在传'),
					cls: 'status-active',
				};
			case 'frozen_orphan':
				return {
					text: adeBi(localize('adeEdgeTicketFrozen', "Frozen Orphan"), '已冻结孤儿单'),
					cls: 'status-frozen-orphan',
				};
			case 'destroyed':
				return {
					text: adeBi(localize('adeEdgeTicketDestroyed', "Destroyed"), '已销毁'),
					cls: 'status-destroyed',
				};
		}
	}

	private renderListView(): void {
		if (this.currentListEl) {
			this.listScrollTop = this.currentListEl.scrollTop;
		}
		this.currentListEl = undefined;
		this.viewDisposables.clear();
		clearNode(this.popoverEl);

		const pairKey = this.openEdgePairKey ?? '';
		const [idA = '', idB = ''] = pairKey.split('<->');
		const infoA = this.resolveAgentDisplay(idA);
		const infoB = this.resolveAgentDisplay(idB);

		const header = append(this.popoverEl, $('.ade-edge-history-head'));
		const titleWrap = append(header, $('.ade-edge-history-title-wrap'));
		append(titleWrap, $('span.codicon.codicon-arrow-swap'));
		append(titleWrap, $('span.ade-edge-history-title', {}, `${infoA.name} ↔ ${infoB.name}`));
		append(titleWrap, $('span.ade-edge-history-count-pill', {}, String(this.cachedRecords.length)));

		const closeBtn = append(header, $('button.ade-mission-icon-btn', {
			type: 'button',
			'data-ade-edge-pop-close': 'true',
			title: adeBi(localize('adeEdgePopCloseTip', "Close (Esc)"), '关闭 (Esc)'),
		})) as HTMLButtonElement;
		append(closeBtn, $('span.codicon.codicon-close'));
		this.viewDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeClickPopover()));

		const listEl = append(this.popoverEl, $('.ade-edge-history-list', {
			'data-ade-edge-transfer-list': 'true',
		}));
		this.currentListEl = listEl;
		this.viewDisposables.add(addDisposableListener(listEl, EventType.SCROLL, () => {
			this.listScrollTop = listEl.scrollTop;
		}));

		if (this.cachedRecords.length === 0) {
			append(listEl, $('.ade-edge-history-empty', {}, adeBi(
				localize('adeEdgeHistoryEmptyText', "No Ticket transfers have traversed this link yet."),
				'该上下级连线暂无历史 Ticket 传递记录。',
			)));
			return;
		}

		for (const rec of this.cachedRecords) {
			const row = append(listEl, $('.ade-edge-history-item', {
				'data-ade-transfer-id': rec.transfer_id,
				'data-ade-ticket-id': rec.ticket_id,
				'data-ade-task-id': rec.task_id,
				'data-ticket-status': rec.ticket_status,
				tabIndex: 0,
				role: 'button',
			}));

			const topLine = append(row, $('.ade-edge-history-item-top'));
			const lookupRecFallbackName = (id: string): string | undefined => id === rec.origin_from_id
				? rec.origin_from_name
				: (id === rec.target_to_id ? rec.target_to_name : undefined);
			const hopFrom = this.resolveAgentDisplay(rec.hop_from_id, lookupRecFallbackName(rec.hop_from_id));
			const hopTo = this.resolveAgentDisplay(rec.hop_to_id, lookupRecFallbackName(rec.hop_to_id));
			append(topLine, $('span.ade-edge-history-dir', {}, `${hopFrom.name} → ${hopTo.name}`));

			const badgesWrap = append(topLine, $('.ade-edge-history-badges'));
			const originInfo = this.resolveAgentDisplay(rec.origin_from_id, rec.origin_from_name);
			const targetInfo = this.resolveAgentDisplay(rec.target_to_id, rec.target_to_name);
			if (rec.total_hops > 1) {
				const oLbl = originInfo.levelLabel ?? originInfo.name;
				const tLbl = targetInfo.levelLabel ?? targetInfo.name;
				append(badgesWrap, $('span.ade-edge-relay-badge', {
					'data-ade-relay-badge': 'true',
					title: `${originInfo.name} → ${targetInfo.name}`,
				}, adeBi(
					localize('adeEdgeRelayTag', "[Relay {0} → {1}]", oLbl, tLbl),
					'[跨级途经 {0} → {1}]',
					oLbl,
					tLbl,
				)));
			} else if (rec.origin_from_id !== rec.hop_from_id || rec.target_to_id !== rec.hop_to_id) {
				append(badgesWrap, $('span.ade-edge-relay-badge', {
					'data-ade-origin-pair': 'true',
				}, `[${originInfo.name} → ${targetInfo.name}]`));
			}
			const stBadge = this.formatLifecycleBadge(rec.ticket_status);
			append(badgesWrap, $(`span.ade-edge-status-badge.${stBadge.cls}`, {}, stBadge.text));

			const midLine = append(row, $('.ade-edge-history-item-mid'));
			append(midLine, $('span.ade-edge-ticket-code', {}, `${rec.ticket_id} · ${rec.task_id}`));
			append(midLine, $('span.ade-edge-task-type', {}, rec.task_type));
			append(midLine, $('span.ade-edge-task-title', {}, rec.task_title));

			const summaryWrap = append(row, $('.ade-edge-history-item-summary'));
			summaryWrap.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, rec.summary, this.viewDisposables));

			const footLine = append(row, $('.ade-edge-history-item-foot'));
			append(footLine, $('span.ade-edge-transfer-time', {}, formatEdgeTransferTimestamp(rec.transferred_at)));
			append(footLine, $('span.ade-edge-action-tag', {}, rec.action_kind === 'create'
				? adeBi(localize('adeEdgeActCreate', "ade_create"), '首次派发')
				: adeBi(localize('adeEdgeActEdit', "ade_edit"), '接力流转')));
			if (rec.has_detail_ref) {
				append(footLine, $('span.ade-edge-detail-flag', {}, adeBi(localize('adeEdgeHasDetailBadge', "Has Detail"), '含详细正文')));
			}

			const openDetail = () => {
				void this.openTicketDetail(rec.ticket_id, rec.has_detail_ref ? rec.task_id : undefined);
			};
			this.viewDisposables.add(addDisposableListener(row, EventType.CLICK, e => {
				e.stopPropagation();
				openDetail();
			}));
			this.viewDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					e.stopPropagation();
					openDetail();
				}
			}));
		}

		listEl.scrollTop = this.listScrollTop;
	}

	async openTicketDetail(ticketId: string, autoLoadTaskId?: string): Promise<void> {
		if (!this.openProjectId) {
			return;
		}
		this.detailScrollTop = 0;
		this.selectedTicketId = ticketId;
		this.expandedTaskDetails.clear();
		this.loadingTaskIds.clear();

		const reqSeq = ++this.loadSeq;
		const projectId = this.openProjectId;
		const insp = await this.controlCenterService.inspectTicketFullDetailForUi(projectId, ticketId);
		if (reqSeq !== this.loadSeq || !this.isClickPopoverOpen() || this.selectedTicketId !== ticketId) {
			return;
		}
		if (!insp) {
			this.selectedTicketId = undefined;
			this.renderListView();
			return;
		}
		this.cachedInspection = insp;
		this.renderDetailView(insp);

		if (autoLoadTaskId) {
			const matchingTask = insp.all_tasks.find(t => t.task_id === autoLoadTaskId);
			if (matchingTask?.has_detail_ref) {
				await this.loadTaskDetailBody(ticketId, autoLoadTaskId);
			}
		}
	}

	private async loadTaskDetailBody(ticketId: string, taskId: string): Promise<void> {
		if (!this.openProjectId || this.loadingTaskIds.has(taskId)) {
			return;
		}
		this.loadingTaskIds.add(taskId);
		if (this.cachedInspection && this.selectedTicketId === ticketId) {
			this.renderDetailView(this.cachedInspection);
		}
		const projectId = this.openProjectId;
		try {
			const res = await this.controlCenterService.readTicketTaskDetailForUi(projectId, ticketId, taskId);
			this.loadingTaskIds.delete(taskId);
			if (!this.isClickPopoverOpen() || this.selectedTicketId !== ticketId) {
				return;
			}
			this.expandedTaskDetails.set(taskId, res || adeBi(
				localize('adeEdgeDetailUnavailable', "(Detail payload unavailable)"),
				'（未找到详细正文内容）',
			));
			if (this.cachedInspection) {
				this.renderDetailView(this.cachedInspection);
			}
		} catch (err) {
			this.loadingTaskIds.delete(taskId);
			if (!this.isClickPopoverOpen() || this.selectedTicketId !== ticketId) {
				return;
			}
			this.expandedTaskDetails.set(taskId, err instanceof Error ? err.message : String(err));
			if (this.cachedInspection) {
				this.renderDetailView(this.cachedInspection);
			}
		}
	}

	private renderDetailView(insp: IAdeUiTicketFullInspection): void {
		if (this.currentDetailScrollEl) {
			this.detailScrollTop = this.currentDetailScrollEl.scrollTop;
		}
		this.currentDetailScrollEl = undefined;
		this.currentListEl = undefined;
		this.viewDisposables.clear();
		clearNode(this.popoverEl);

		const pub = insp.public_ticket;
		const stBadge = this.formatLifecycleBadge(insp.status);
		const lookupInspectionAgentName = (agentId: string): string | undefined => {
			if (agentId === pub.creator_id && insp.creator_name) {
				return insp.creator_name;
			}
			if (agentId === insp.peer_id && insp.peer_name) {
				return insp.peer_name;
			}
			for (const t of insp.all_tasks) {
				if (t.from_id === agentId && t.from_name) {
					return t.from_name;
				}
				if (t.to_id === agentId && t.to_name) {
					return t.to_name;
				}
			}
			return undefined;
		};
		const creatorInfo = this.resolveAgentDisplay(pub.creator_id, insp.creator_name || lookupInspectionAgentName(pub.creator_id));
		const peerInfo = this.resolveAgentDisplay(insp.peer_id, insp.peer_name || lookupInspectionAgentName(insp.peer_id));
		const curTaskMatch = insp.all_tasks.find(t => t.task_id === pub.current_task.task_id);
		const fromFallback = curTaskMatch?.from_name || lookupInspectionAgentName(pub.from_id);
		const toFallback = curTaskMatch?.to_name || lookupInspectionAgentName(pub.to_id);
		const fromInfo = this.resolveAgentDisplay(pub.from_id, fromFallback);
		const toInfo = this.resolveAgentDisplay(pub.to_id, toFallback);

		const header = append(this.popoverEl, $('.ade-edge-history-head'));
		const leftWrap = append(header, $('.ade-edge-history-title-wrap'));
		const backBtn = append(leftWrap, $('button.ade-edge-back-btn', {
			type: 'button',
			'data-ade-edge-back': 'true',
			title: adeBi(localize('adeEdgeBackToListTip', "Back to transfer history (Esc)"), '返回传递记录列表 (Esc)'),
		})) as HTMLButtonElement;
		append(backBtn, $('span.codicon.codicon-arrow-left'));
		append(backBtn, $('span', {}, adeBi(localize('adeEdgeBackBtnLabel', "Back"), '返回')));
		this.viewDisposables.add(addDisposableListener(backBtn, EventType.CLICK, () => {
			this.handleEscapeKey();
		}));

		append(leftWrap, $('span.ade-edge-history-title', {}, pub.ticket_id));
		append(leftWrap, $(`span.ade-edge-status-badge.${stBadge.cls}`, {}, stBadge.text));
		append(leftWrap, $('span.ade-edge-history-subtitle', {
			'data-ade-ticket-bound-pair': 'true',
		}, `${creatorInfo.name} ↔ ${peerInfo.name}`));

		const closeBtn = append(header, $('button.ade-mission-icon-btn', {
			type: 'button',
			'data-ade-edge-pop-close': 'true',
			title: adeBi(localize('adeEdgeDetailCloseTip', "Close"), '关闭'),
		})) as HTMLButtonElement;
		append(closeBtn, $('span.codicon.codicon-close'));
		this.viewDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeClickPopover()));

		const bodyScroll = append(this.popoverEl, $('.ade-edge-detail-scroll', {
			'data-ade-ticket-detail-view': pub.ticket_id,
		}));
		this.currentDetailScrollEl = bodyScroll;
		this.viewDisposables.add(addDisposableListener(bodyScroll, EventType.SCROLL, () => {
			this.detailScrollTop = bodyScroll.scrollTop;
		}));

		// Section 1: Strict 10 Standard Public Ticket Fields (`Rebuild/Ticket.md:37-52` & `plan.md` §8.4.2)
		const fieldsCard = append(bodyScroll, $('.ade-edge-fields-grid', {
			'data-ade-ticket-ten-fields': 'true',
		}));
		const addField = (key: string, val: string) => {
			const cell = append(fieldsCard, $('.ade-edge-field-cell', { 'data-ticket-field': key }));
			append(cell, $('span.ade-edge-field-key', {}, key));
			append(cell, $('span.ade-edge-field-val', { title: val }, val));
		};
		addField('ticket_id', pub.ticket_id);
		addField('project_id', pub.project_id);
		addField('creator_id', `${pub.creator_id} (${creatorInfo.name}${creatorInfo.isDeleted ? ' · 已删归档' : ''})`);
		addField('ticket_level', `${pub.ticket_level} (${formatLevelLabel(pub.ticket_level)})`);
		addField('from_id', `${pub.from_id} (${fromInfo.name})`);
		addField('to_id', `${pub.to_id} (${toInfo.name})`);
		addField('delivery_mode', pub.delivery_mode);
		addField('need_return', String(pub.need_return));
		addField('current_task', `${pub.current_task.task_id} (${pub.current_task.task_type}) · ${pub.current_task.task_title}`);
		addField('has_history_ref', String(pub.has_history_ref));

		// Section 2: `current_task`
		const curSection = append(bodyScroll, $('.ade-edge-task-section', {
			'data-ade-current-task': pub.current_task.task_id,
		}));
		append(curSection, $('.ade-edge-section-label', {}, adeBi(
			localize('adeEdgeCurrentTaskHeading', "Current Task (current_task)"),
			'当前最新任务棒（current_task）',
		)));
		const curMatchingRecord: IAdeUiTicketTaskRecord = curTaskMatch ?? {
			task_id: pub.current_task.task_id,
			seq: insp.all_tasks.length,
			is_archived: false,
			from_id: pub.from_id,
			from_name: fromInfo.name,
			to_id: pub.to_id,
			to_name: toInfo.name,
			delivery_mode: pub.delivery_mode,
			need_return: pub.need_return,
			task_type: pub.current_task.task_type,
			task_title: pub.current_task.task_title,
			summary: pub.current_task.task_comment.summary,
			has_detail_ref: pub.current_task.task_comment.has_detail_ref,
			detail_truncated: false,
			created_at: insp.updated_at,
		};
		this.renderTaskCard(curSection, pub.ticket_id, curMatchingRecord);

		// Section 3: Full `tasks` Historical Chain (archived hops in chronological sequence)
		const archivedTasks = insp.all_tasks.filter(t => t.is_archived);
		const histSection = append(bodyScroll, $('.ade-edge-task-section', {
			'data-ade-history-tasks': 'true',
		}));
		append(histSection, $('.ade-edge-section-label', {}, adeBi(
			localize('adeEdgeHistoryChainHeading', "Archived Task History Chain (tasks · {0})", archivedTasks.length),
			'已归档历史任务链（tasks · {0} 棒）',
			archivedTasks.length,
		)));
		if (archivedTasks.length === 0) {
			append(histSection, $('.ade-edge-history-muted', {}, adeBi(
				localize('adeEdgeNoArchivedTasks', "No archived task hops yet (first hop active)."),
				'暂无已归档旧棒（当前处于首棒）。',
			)));
		} else {
			for (const taskRec of archivedTasks) {
				this.renderTaskCard(histSection, pub.ticket_id, taskRec);
			}
		}
		bodyScroll.scrollTop = this.detailScrollTop;
	}

	private renderTaskCard(container: HTMLElement, ticketId: string, task: IAdeUiTicketTaskRecord): void {
		const box = append(container, $('.ade-edge-task-card', {
			'data-ade-task-card': task.task_id,
		}));
		const head = append(box, $('.ade-edge-task-card-head'));
		append(head, $('span.ade-edge-ticket-code', {}, `#${task.seq} · ${task.task_id}`));
		append(head, $('span.ade-edge-task-type', {}, task.task_type));
		append(head, $('span.ade-edge-history-dir', {}, `${this.resolveAgentDisplay(task.from_id, task.from_name).name} → ${this.resolveAgentDisplay(task.to_id, task.to_name).name}`));
		append(head, $('span.ade-edge-transfer-time', {}, formatEdgeTransferTimestamp(task.created_at)));

		append(box, $('.ade-edge-task-card-title', {}, task.task_title));

		const sumEl = append(box, $('.ade-edge-task-card-summary'));
		sumEl.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, task.summary, this.viewDisposables));

		if (task.has_detail_ref) {
			const loadedBody = this.expandedTaskDetails.get(task.task_id);
			const isLoading = this.loadingTaskIds.has(task.task_id);
			const actionRow = append(box, $('.ade-edge-task-card-actions'));
			const toggleBtn = append(actionRow, $('button.ade-edge-load-detail-btn', {
				type: 'button',
				'data-ade-load-task-detail': task.task_id,
			}, loadedBody !== undefined
				? adeBi(localize('adeEdgeHideDetailBtn', "Hide Full Detail"), '收起详细正文')
				: isLoading
					? adeBi(localize('adeEdgeLoadingDetailBtn', "Loading Detail…"), '正在加载详细正文…')
					: adeBi(localize('adeEdgeReadDetailBtn', "Read Full Detail (detail)"), '查看完整详细正文 (detail)'))) as HTMLButtonElement;
			toggleBtn.disabled = isLoading;
			this.viewDisposables.add(addDisposableListener(toggleBtn, EventType.CLICK, e => {
				e.stopPropagation();
				if (this.expandedTaskDetails.has(task.task_id)) {
					this.expandedTaskDetails.delete(task.task_id);
					if (this.cachedInspection) {
						this.renderDetailView(this.cachedInspection);
					}
				} else {
					void this.loadTaskDetailBody(ticketId, task.task_id);
				}
			}));

			if (loadedBody !== undefined) {
				const detailWell = append(box, $('.ade-edge-task-detail-well', {
					'data-ade-rendered-detail': task.task_id,
				}));
				detailWell.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, loadedBody, this.viewDisposables));
			}
		}
	}
}
