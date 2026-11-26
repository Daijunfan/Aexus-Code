/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AdeOsIconKind, resolveAdeOsIconKind } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	IAdeControlCenterService,
	IAdeUiWhiteboardInspection,
	IAdeWbItemsFilter,
} from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	IAdeBoardItemPublicSummary,
	IAdeProjectSnapshot,
	IAdeWhiteboard,
} from '../../../../platform/ade/common/adeModels.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { adeBi } from '../common/adeLocalization.js';
import { formatEdgeTransferTimestamp, renderUntrustedAdeMarkdown } from './adeEdgeTicketHistoryPopover.js';
import { AdeGlassSelect } from './adeGlassSelect.js';
import { AdeMissionHostCatalog } from './adeMissionHostCatalog.js';

type WhiteboardPopoverTab = 'items' | 'notes' | 'settings';

function formatBytesHuman(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 1024) {
		return `${Math.max(0, Math.round(bytes || 0))} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface IAdeWhiteboardPopoverDelegate {
	getProjectId(): string | undefined;
	getProjectSnapshot(): IAdeProjectSnapshot | undefined;
	onFeedback?(message: string, kind: 'ok' | 'error'): void;
	onDidMutateWhiteboard?(): void;
}

/**
 * New Whiteboard Multi-Dimensional Inspection, File Backup Download, Targeted Role Notes,
 * and Online Multi-Hop CAS Storage Migration Popover (`plan.md` §2.1, §5.5, §6.3).
 */
export class AdeWhiteboardPopover extends Disposable {
	readonly popoverEl: HTMLElement;
	private readonly viewDisposables = this._register(new DisposableStore());

	private openProjectId: string | undefined;
	private openBoardId: string | undefined;
	private activeTab: WhiteboardPopoverTab = 'items';
	private filterSort: 'time' | 'stars' = 'time';
	private filterType: 'all' | 'msg' | 'file' = 'all';
	private filterStars = '';
	private filterTag = '';
	private filterAuthor = '';
	private filterLimit = '';

	private inspection: IAdeUiWhiteboardInspection | undefined;
	private readonly expandedMsgDetails = new Map<string, string>();
	private readonly expandedNoteDetails = new Map<string, string>();
	private readonly loadingIds = new Set<string>();
	private statusBanner: { readonly text: string; readonly isError: boolean } | undefined;
	private loadSeq = 0;

	constructor(
		private readonly bodyEl: HTMLElement,
		private readonly controlCenterService: IAdeControlCenterService,
		private readonly hostCatalog: AdeMissionHostCatalog,
		private readonly markdownRendererService: IMarkdownRendererService | undefined,
		private readonly fileDialogService: IFileDialogService | undefined,
		private readonly delegate: IAdeWhiteboardPopoverDelegate,
	) {
		super();

		this.popoverEl = append(this.bodyEl, $('.ade-whiteboard-popover', {
			'data-ade-whiteboard-popover': 'true',
			role: 'dialog',
			tabIndex: -1,
		}));
		this.popoverEl.hidden = true;

		this._register(addDisposableListener(this.popoverEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this._register(addDisposableListener(this.popoverEl, EventType.WHEEL, e => e.stopPropagation(), { passive: false }));
		this._register(addDisposableListener(this.popoverEl, EventType.CLICK, e => e.stopPropagation()));
		this._register(addDisposableListener(this.popoverEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.close();
			}
		}));

		const win = getWindow(this.bodyEl);
		this._register(addDisposableListener(win.document, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!this.isOpen()) {
				return;
			}
			const target = e.target as Node | null;
			if (target && this.popoverEl.contains(target)) {
				return;
			}
			if (target instanceof Element && target.closest('[data-ade-select-portal="true"]')) {
				return;
			}
			if (target instanceof Element && (target.closest('.ade-mission-node.kind-whiteboard') || target.closest('.ade-mission-edge-group.is-whiteboard-link'))) {
				return;
			}
			this.close();
		}, true));
	}

	override dispose(): void {
		this.popoverEl.remove();
		super.dispose();
	}

	isOpen(): boolean {
		return !this.popoverEl.hidden && Boolean(this.openBoardId);
	}

	getOpenBoardId(): string | undefined {
		return this.isOpen() ? this.openBoardId : undefined;
	}

	async open(
		whiteboard: IAdeWhiteboard,
		anchorEl: HTMLElement,
		options?: { readonly initialTag?: string; readonly initialTab?: WhiteboardPopoverTab },
	): Promise<void> {
		const projectId = this.delegate.getProjectId() || whiteboard.project_id;
		if (!projectId) {
			return;
		}
		const isSameBoard = this.isOpen() && this.openProjectId === projectId && this.openBoardId === whiteboard.board_id;
		this.openProjectId = projectId;
		this.openBoardId = whiteboard.board_id;
		if (!isSameBoard) {
			this.activeTab = options?.initialTab ?? 'items';
			this.filterSort = 'time';
			this.filterType = 'all';
			this.filterStars = '';
			this.filterTag = options?.initialTag ?? '';
			this.filterAuthor = '';
			this.filterLimit = '';
			this.expandedMsgDetails.clear();
			this.expandedNoteDetails.clear();
			this.loadingIds.clear();
			this.statusBanner = undefined;
			this.positionNearAnchor(anchorEl);
		} else if (options?.initialTag !== undefined) {
			this.filterTag = options.initialTag;
			this.activeTab = 'items';
		}
		this.popoverEl.hidden = false;
		await this.reloadInspection();
		this.popoverEl.focus();
	}

	close(): void {
		if (this.popoverEl.hidden && !this.openBoardId) {
			return;
		}
		this.openProjectId = undefined;
		this.openBoardId = undefined;
		this.inspection = undefined;
		this.expandedMsgDetails.clear();
		this.expandedNoteDetails.clear();
		this.loadingIds.clear();
		this.statusBanner = undefined;
		this.viewDisposables.clear();
		clearNode(this.popoverEl);
		this.popoverEl.hidden = true;
	}

	notifyProjectSnapshotChanged(): void {
		if (!this.isOpen() || !this.openBoardId) {
			return;
		}
		const snap = this.delegate.getProjectSnapshot();
		if (snap && !snap.whiteboards.some(w => w.board_id === this.openBoardId)) {
			this.close();
			return;
		}
		void this.reloadInspection();
	}

	private positionNearAnchor(anchorEl: HTMLElement): void {
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const popW = 540;
		const popH = 480;
		let left = anchorRect.right - bodyRect.left + 12;
		if (left + popW > bodyRect.width - 12) {
			left = anchorRect.left - bodyRect.left - popW - 12;
		}
		left = Math.max(12, Math.min(Math.max(12, bodyRect.width - popW - 12), left));
		const top = Math.max(12, Math.min(Math.max(12, bodyRect.height - popH - 12), anchorRect.top - bodyRect.top));
		this.popoverEl.style.left = `${Math.round(left)}px`;
		this.popoverEl.style.top = `${Math.round(top)}px`;
	}

	private buildCurrentFilter(): IAdeWbItemsFilter {
		const parsedLimit = this.filterLimit.trim() ? Number.parseInt(this.filterLimit.trim(), 10) : NaN;
		return {
			sort: this.filterSort,
			type: this.filterType,
			...(this.filterStars ? { stars: this.filterStars } : {}),
			...(this.filterTag ? { tag: this.filterTag } : {}),
			...(this.filterAuthor ? { author: this.filterAuthor } : {}),
			...(Number.isInteger(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {}),
		};
	}

	private async reloadInspection(): Promise<void> {
		if (!this.openProjectId || !this.openBoardId) {
			return;
		}
		const seq = ++this.loadSeq;
		const projectId = this.openProjectId;
		const boardId = this.openBoardId;
		try {
			const res = await this.controlCenterService.uiInspectWhiteboard(projectId, boardId, this.buildCurrentFilter());
			if (seq !== this.loadSeq || !this.isOpen() || this.openBoardId !== boardId) {
				return;
			}
			if (!res) {
				this.close();
				return;
			}
			this.inspection = res;
			this.render();
		} catch (err) {
			if (seq === this.loadSeq && this.isOpen()) {
				this.statusBanner = { text: err instanceof Error ? err.message : String(err), isError: true };
				this.render();
			}
		}
	}

	private resolveAgentName(agentId: string | null | undefined): string {
		if (!agentId) {
			return adeBi(localize('adeWbCustodyOwner', "Unclaimed Custody"), '无主托管');
		}
		const snap = this.delegate.getProjectSnapshot();
		const live = snap?.agents.find(a => a.agent_id === agentId);
		if (live) {
			return `${live.name} (${agentId})`;
		}
		const del = snap?.deleted_agents.find(a => a.agent_id === agentId);
		if (del) {
			return `${del.name} (${agentId})`;
		}
		return agentId;
	}

	private render(): void {
		this.viewDisposables.clear();
		clearNode(this.popoverEl);
		const insp = this.inspection;
		if (!insp) {
			append(this.popoverEl, $('.ade-wb-pop-loading', {}, adeBi(localize('adeWbLoading', "Loading whiteboard…"), '正在加载白板…')));
			return;
		}
		const board = insp.board;
		const snap = this.delegate.getProjectSnapshot();
		const deptName = board.dept_id
			? (snap?.departments.find(d => d.dept_id === board.dept_id)?.name ?? board.dept_id)
			: adeBi(localize('adeWbPersonalScope', "Personal Whiteboard"), '个人白板');

		// Header
		const head = append(this.popoverEl, $('.ade-edge-history-head'));
		const titleWrap = append(head, $('.ade-edge-history-title-wrap'));
		append(titleWrap, $('span.codicon.codicon-notebook'));
		append(titleWrap, $('span.ade-edge-history-title', {}, board.name));
		append(titleWrap, $('span.ade-orch-wb-dept-chip', {}, deptName));
		append(titleWrap, $('span.ade-orch-wb-ptr-tag', {}, `@${board.storage_host}`));

		const closeBtn = append(head, $('button.ade-mission-icon-btn', {
			type: 'button',
			'data-ade-wb-pop-close': 'true',
			title: adeBi(localize('adeWbCloseTip', "Close (Esc)"), '关闭 (Esc)'),
		})) as HTMLButtonElement;
		append(closeBtn, $('span.codicon.codicon-close'));
		this.viewDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close()));

		// Live CAS Migration Banner when `migration_state === 'transferring' | 'failed'`
		if (board.migration_state === 'transferring' || board.migration_state === 'failed') {
			const prog = board.migration_progress;
			const migBar = append(this.popoverEl, $(`.ade-wb-migration-banner.state-${board.migration_state}`, {
				'data-ade-wb-migration-state': board.migration_state,
			}));
			const migText = board.migration_state === 'transferring'
				? adeBi(
					localize('adeWbCasMigratingText', "CAS Online Migration to {0}: {1}/{2} moved", board.storage_host, prog?.completed_items ?? 0, prog?.total_items ?? 0),
					'CAS 在线安全搬迁至 {0}：{1}/{2} 已完成',
					board.storage_host,
					prog?.completed_items ?? 0,
					prog?.total_items ?? 0,
				)
				: adeBi(
					localize('adeWbCasFailedText', "CAS Migration encountered errors: {0}", prog?.last_error ?? 'failed'),
					'CAS 存储搬迁异常：{0}',
					prog?.last_error ?? 'failed',
				);
			append(migBar, $('span', {}, migText));
		}

		if (this.statusBanner) {
			append(this.popoverEl, $(`.ade-wb-status-banner.${this.statusBanner.isError ? 'is-error' : 'is-ok'}`, {}, this.statusBanner.text));
		}

		// Tabs
		const unreadNotesCount = insp.notes.filter(n => !n.is_read).length;
		const tabBar = append(this.popoverEl, $('.ade-wb-pop-tabs'));
		const addTab = (tab: WhiteboardPopoverTab, label: string) => {
			const btn = append(tabBar, $(`button.ade-wb-pop-tab${this.activeTab === tab ? '.is-active' : ''}`, {
				type: 'button',
				'data-ade-wb-tab': tab,
			}, label)) as HTMLButtonElement;
			this.viewDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.activeTab = tab;
				this.render();
			}));
		};
		addTab('items', adeBi(localize('adeWbTabItems', "Items ({0})", insp.items.length), '共享条目 ({0})', insp.items.length));
		addTab(
			'notes',
			unreadNotesCount > 0
				? adeBi(localize('adeWbTabNotesUnread', "Notes ({0} · {1} unread)", insp.notes.length, unreadNotesCount), '定向留言 ({0} · 未读 {1})', insp.notes.length, unreadNotesCount)
				: adeBi(localize('adeWbTabNotes', "Notes ({0})", insp.notes.length), '定向留言 ({0})', insp.notes.length),
		);
		addTab('settings', adeBi(localize('adeWbTabSettings', "Access & Storage ({0})", insp.members.length), '权限与存储 ({0})', insp.members.length));

		const body = append(this.popoverEl, $('.ade-wb-pop-body'));
		if (this.activeTab === 'items') {
			this.renderItemsTab(body, insp);
		} else if (this.activeTab === 'notes') {
			this.renderNotesTab(body, insp);
		} else {
			this.renderSettingsTab(body, insp);
		}
	}

	private renderItemsTab(container: HTMLElement, insp: IAdeUiWhiteboardInspection): void {
		const snap = this.delegate.getProjectSnapshot();

		// Multi-dimensional filter bar (`sort`, `type`, `stars`, `tag`, `author`, `limit`)
		const filterBar = append(container, $('.ade-wb-filter-bar', { 'data-ade-wb-filters': 'true' }));

		const sortSel = this.viewDisposables.add(new AdeGlassSelect({
			container: filterBar,
			portalContainer: this.bodyEl,
			className: 'ade-mission-config-select',
			attributes: { 'data-ade-wb-filter-sort': 'true' },
			items: [
				{ value: 'time', label: adeBi(localize('adeWbSortTime', "Sort: Newest"), '排序：最新时间') },
				{ value: 'stars', label: adeBi(localize('adeWbSortStars', "Sort: Stars"), '排序：最高星级') },
			],
			value: this.filterSort,
			searchable: false,
		}));
		this.viewDisposables.add(sortSel.onDidChange(val => {
			this.filterSort = val === 'stars' ? 'stars' : 'time';
			void this.reloadInspection();
		}));

		const typeSel = this.viewDisposables.add(new AdeGlassSelect({
			container: filterBar,
			portalContainer: this.bodyEl,
			className: 'ade-mission-config-select',
			attributes: { 'data-ade-wb-filter-type': 'true' },
			items: [
				{ value: 'all', label: adeBi(localize('adeWbTypeAll', "Type: All"), '类型：全部') },
				{ value: 'msg', label: adeBi(localize('adeWbTypeMsg', "Messages"), '仅消息 (msg)') },
				{ value: 'file', label: adeBi(localize('adeWbTypeFile', "File Backups"), '仅备份文件 (file)') },
			],
			value: this.filterType,
			searchable: false,
		}));
		this.viewDisposables.add(typeSel.onDidChange(val => {
			this.filterType = (val as 'all' | 'msg' | 'file') || 'all';
			void this.reloadInspection();
		}));

		const starsSel = this.viewDisposables.add(new AdeGlassSelect({
			container: filterBar,
			portalContainer: this.bodyEl,
			className: 'ade-mission-config-select',
			attributes: { 'data-ade-wb-filter-stars': 'true' },
			items: [
				{ value: '', label: adeBi(localize('adeWbStarsAll', "Stars: All"), '星级：全部') },
				{ value: '5', label: '5 ★' },
				{ value: '4-5', label: '4-5 ★' },
				{ value: '3-5', label: '3-5 ★' },
				{ value: '1-2', label: '1-2 ★' },
			],
			value: this.filterStars,
			searchable: false,
		}));
		this.viewDisposables.add(starsSel.onDidChange(val => {
			this.filterStars = val;
			void this.reloadInspection();
		}));

		const tagSel = this.viewDisposables.add(new AdeGlassSelect({
			container: filterBar,
			portalContainer: this.bodyEl,
			className: 'ade-mission-config-select',
			attributes: { 'data-ade-wb-filter-tag': 'true' },
			items: [
				{ value: '', label: adeBi(localize('adeWbTagAll', "Tag: All"), '标签：全部') },
				...insp.board.tag_categories.map(tag => ({ value: tag, label: `# ${tag}` })),
			],
			value: this.filterTag,
		}));
		this.viewDisposables.add(tagSel.onDidChange(val => {
			this.filterTag = val;
			void this.reloadInspection();
		}));

		const authorSel = this.viewDisposables.add(new AdeGlassSelect({
			container: filterBar,
			portalContainer: this.bodyEl,
			className: 'ade-mission-config-select',
			attributes: { 'data-ade-wb-filter-author': 'true' },
			items: [
				{ value: '', label: adeBi(localize('adeWbAuthorAll', "Author: All"), '作者：全部') },
				...(snap?.agents ?? []).map(ag => ({ value: ag.agent_id, label: ag.name, icon: 'account' })),
			],
			value: this.filterAuthor,
		}));
		this.viewDisposables.add(authorSel.onDidChange(val => {
			this.filterAuthor = val;
			void this.reloadInspection();
		}));

		const limitInput = append(filterBar, $('input.ade-wb-limit-input', {
			type: 'number',
			min: '1',
			value: this.filterLimit,
			placeholder: adeBi(localize('adeWbLimitPh', "Limit"), '条数上限'),
			'data-ade-wb-filter-limit': 'true',
		})) as HTMLInputElement;
		this.viewDisposables.add(addDisposableListener(limitInput, EventType.CHANGE, () => {
			this.filterLimit = limitInput.value.trim();
			void this.reloadInspection();
		}));

		const listEl = append(container, $('.ade-wb-items-list'));
		if (insp.items.length === 0) {
			append(listEl, $('.ade-edge-history-empty', {}, adeBi(
				localize('adeWbNoMatchingItems', "No whiteboard items match the current filter."),
				'当前筛选条件下暂无白板条目。',
			)));
			return;
		}

		for (const item of insp.items) {
			this.renderBoardItemCard(listEl, insp.board, item);
		}
	}

	private renderBoardItemCard(listEl: HTMLElement, board: IAdeWhiteboard, item: IAdeBoardItemPublicSummary): void {
		const card = append(listEl, $(`.ade-wb-item-card${item.is_pinned ? '.is-pinned' : ''}`, {
			'data-ade-wb-item': item.item_id,
			'data-item-type': item.item_type,
		}));

		const top = append(card, $('.ade-wb-item-top'));
		const left = append(top, $('.ade-wb-item-badges'));
		if (item.is_pinned) {
			append(left, $('span.ade-wb-pin-badge', {}, '📌 PIN'));
		}
		append(left, $(`span.ade-wb-type-badge.type-${item.item_type}`, {}, item.item_type === 'file' ? 'FILE' : 'MSG'));
		append(left, $('span.ade-wb-stars-badge', {}, '★'.repeat(item.stars) + '☆'.repeat(Math.max(0, 5 - item.stars))));
		append(left, $('span.ade-wb-author-text', {}, this.resolveAgentName(item.author_id)));

		const right = append(top, $('.ade-wb-item-actions'));
		const pinBtn = append(right, $('button.ade-wb-mini-btn', {
			type: 'button',
			'data-ade-wb-pin-toggle': item.item_id,
		}, item.is_pinned
			? adeBi(localize('adeWbUnpinBtn', "Unpin"), '取消置顶')
			: adeBi(localize('adeWbPinBtn', "Pin"), '置顶'))) as HTMLButtonElement;
		this.viewDisposables.add(addDisposableListener(pinBtn, EventType.CLICK, () => {
			if (!this.openProjectId) {
				return;
			}
			void this.controlCenterService.uiManageWhiteboardItem({
				projectId: this.openProjectId,
				boardId: board.board_id,
				itemId: item.item_id,
				pin: !item.is_pinned,
			}).then(() => {
				this.delegate.onDidMutateWhiteboard?.();
				return this.reloadInspection();
			}).catch(err => {
				this.statusBanner = { text: err instanceof Error ? err.message : String(err), isError: true };
				this.render();
			});
		}));

		if (item.tags.length > 0) {
			const tagsRow = append(card, $('.ade-wb-item-tags'));
			for (const t of item.tags) {
				append(tagsRow, $('span.ade-orch-wb-toc-chip', {}, `# ${t}`));
			}
		}

		const summaryEl = append(card, $('.ade-wb-item-summary'));
		summaryEl.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, item.summary, this.viewDisposables));

		const foot = append(card, $('.ade-wb-item-foot'));
		append(foot, $('span.ade-edge-transfer-time', {}, formatEdgeTransferTimestamp(item.created_at)));

		if (item.item_type === 'file' && item.file_meta) {
			const fileRow = append(foot, $('.ade-wb-file-meta'));
			append(fileRow, $('span.codicon.codicon-file-binary'));
			append(fileRow, $('span', {}, `${item.file_meta.filename} (${formatBytesHuman(item.file_meta.size_bytes)})`));
			const dlBtn = append(fileRow, $('button.ade-edge-load-detail-btn', {
				type: 'button',
				'data-ade-wb-download': item.item_id,
			}, adeBi(localize('adeWbDownloadBtn', "Download Backup"), '下载备份文件'))) as HTMLButtonElement;
			this.viewDisposables.add(addDisposableListener(dlBtn, EventType.CLICK, () => {
				void this.handleDownloadFile(board.board_id, item);
			}));
		} else if (item.item_type === 'msg' && item.has_detail) {
			const loaded = this.expandedMsgDetails.get(item.item_id);
			const loading = this.loadingIds.has(item.item_id);
			const detailBtn = append(foot, $('button.ade-edge-load-detail-btn', {
				type: 'button',
				'data-ade-wb-msg-detail': item.item_id,
			}, loaded !== undefined
				? adeBi(localize('adeWbHideDetail', "Hide Detail"), '收起详述')
				: loading
					? adeBi(localize('adeWbLoadingDetail', "Loading…"), '加载中…')
					: adeBi(localize('adeWbReadDetail', "View Detail"), '查看完整正文'))) as HTMLButtonElement;
			detailBtn.disabled = loading;
			this.viewDisposables.add(addDisposableListener(detailBtn, EventType.CLICK, () => {
				if (this.expandedMsgDetails.has(item.item_id)) {
					this.expandedMsgDetails.delete(item.item_id);
					this.render();
				} else {
					void this.loadMsgDetail(board.board_id, item.item_id);
				}
			}));
			if (loaded !== undefined) {
				const detailBox = append(card, $('.ade-edge-task-detail-well', {
					'data-ade-wb-rendered-msg': item.item_id,
				}));
				detailBox.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, loaded, this.viewDisposables));
			}
		}
	}

	private async loadMsgDetail(boardId: string, itemId: string): Promise<void> {
		if (!this.openProjectId || this.loadingIds.has(itemId)) {
			return;
		}
		this.loadingIds.add(itemId);
		this.render();
		try {
			const detail = await this.controlCenterService.uiReadWhiteboardItemDetail(this.openProjectId, boardId, itemId);
			this.loadingIds.delete(itemId);
			if (!this.isOpen() || this.openBoardId !== boardId) {
				return;
			}
			this.expandedMsgDetails.set(itemId, detail ?? '');
			this.render();
		} catch (err) {
			this.loadingIds.delete(itemId);
			this.statusBanner = { text: err instanceof Error ? err.message : String(err), isError: true };
			this.render();
		}
	}

	private async handleDownloadFile(boardId: string, item: IAdeBoardItemPublicSummary): Promise<void> {
		if (!this.openProjectId || !item.file_meta) {
			return;
		}
		let destPath: string | undefined;
		if (this.fileDialogService) {
			const defaultDir = await this.fileDialogService.defaultFolderPath();
			const safeFilename = (item.file_meta.filename || 'download.bin').replace(/[\\/]+/g, '_').replace(/^\.+$/, 'download.bin');
			const defaultUri = URI.joinPath(defaultDir, safeFilename);
			const picked = await this.fileDialogService.showSaveDialog({
				title: adeBi(localize('adeWbSaveBackupTitle', "Save Whiteboard Backup File"), '保存白板备份文件'),
				defaultUri,
			});
			destPath = picked?.fsPath;
		}
		if (!destPath) {
			return;
		}
		try {
			const saved = await this.controlCenterService.uiDownloadWhiteboardFile(this.openProjectId, boardId, item.item_id, destPath);
			const okMsg = adeBi(localize('adeWbSavedFileMsg', "Saved backup to {0}", saved), '备份文件已保存至 {0}', saved);
			this.statusBanner = { text: okMsg, isError: false };
			this.delegate.onFeedback?.(okMsg, 'ok');
			this.render();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusBanner = { text: msg, isError: true };
			this.delegate.onFeedback?.(msg, 'error');
			this.render();
		}
	}

	private renderNotesTab(container: HTMLElement, insp: IAdeUiWhiteboardInspection): void {
		const listEl = append(container, $('.ade-wb-items-list'));
		if (insp.notes.length === 0) {
			append(listEl, $('.ade-edge-history-empty', {}, adeBi(
				localize('adeWbNoNotesText', "No targeted role notes on this whiteboard."),
				'该白板暂无定向角色留言。',
			)));
			return;
		}
		for (const note of insp.notes) {
			const card = append(listEl, $(`.ade-wb-item-card${!note.is_read ? '.is-unread' : ''}`, {
				'data-ade-wb-note': note.note_id,
			}));
			const top = append(card, $('.ade-wb-item-top'));
			const left = append(top, $('.ade-wb-item-badges'));
			append(left, $('span.ade-edge-history-dir', {}, `${this.resolveAgentName(note.from_id)} → ${this.resolveAgentName(note.to_id)}`));
			append(left, $(`span.ade-edge-status-badge.${note.is_read ? 'status-destroyed' : 'status-active'}`, {}, note.is_read
				? adeBi(localize('adeWbNoteRead', "Read"), '已读')
				: adeBi(localize('adeWbNoteUnread', "Unread"), '未读')));
			append(top, $('span.ade-edge-transfer-time', {}, formatEdgeTransferTimestamp(note.created_at)));

			const previewEl = append(card, $('.ade-wb-item-summary'));
			previewEl.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, note.content_preview, this.viewDisposables));

			if (note.has_detail) {
				const loaded = this.expandedNoteDetails.get(note.note_id);
				const loading = this.loadingIds.has(note.note_id);
				const btn = append(card, $('button.ade-edge-load-detail-btn', {
					type: 'button',
					'data-ade-wb-note-detail': note.note_id,
				}, loaded !== undefined
					? adeBi(localize('adeWbHideFullNote', "Hide Full Note"), '收起全文')
					: loading
						? adeBi(localize('adeWbLoadingNote', "Loading…"), '加载中…')
						: adeBi(localize('adeWbReadFullNote', "Read Full Note (>300 chars)"), '展开超 300 字完整留言'))) as HTMLButtonElement;
				btn.disabled = loading;
				this.viewDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					if (this.expandedNoteDetails.has(note.note_id)) {
						this.expandedNoteDetails.delete(note.note_id);
						this.render();
					} else {
						void this.loadNoteDetail(insp.board.board_id, note.note_id);
					}
				}));
				if (loaded !== undefined) {
					const fullEl = append(card, $('.ade-edge-task-detail-well', {
						'data-ade-wb-rendered-note': note.note_id,
					}));
					fullEl.appendChild(renderUntrustedAdeMarkdown(this.markdownRendererService, loaded, this.viewDisposables));
				}
			}
		}
	}

	private async loadNoteDetail(boardId: string, noteId: string): Promise<void> {
		if (!this.openProjectId || this.loadingIds.has(noteId)) {
			return;
		}
		this.loadingIds.add(noteId);
		this.render();
		try {
			const text = await this.controlCenterService.uiReadWhiteboardNoteDetail(this.openProjectId, boardId, noteId);
			this.loadingIds.delete(noteId);
			if (!this.isOpen() || this.openBoardId !== boardId) {
				return;
			}
			this.expandedNoteDetails.set(noteId, text ?? '');
			this.render();
		} catch (err) {
			this.loadingIds.delete(noteId);
			this.statusBanner = { text: err instanceof Error ? err.message : String(err), isError: true };
			this.render();
		}
	}

	private renderSettingsTab(container: HTMLElement, insp: IAdeUiWhiteboardInspection): void {
		const board = insp.board;
		const snap = this.delegate.getProjectSnapshot();

		// 1. Rename & Storage Host Online CAS Migration Form
		const formBox = append(container, $('.ade-wb-settings-section'));
		append(formBox, $('.ade-edge-section-label', {}, adeBi(
			localize('adeWbStorageConfigTitle', "Whiteboard Name & Storage Host (CAS Online Migration)"),
			'白板名称与物理存储主机（支持在线 CAS 搬迁并清理源端旧副本）',
		)));

		const nameRow = append(formBox, $('.ade-wb-form-row'));
		const nameInput = append(nameRow, $('input.ade-mission-emp-popover-input', {
			type: 'text',
			value: board.name,
			'data-ade-wb-name-input': 'true',
		})) as HTMLInputElement;

		const hostRow = append(formBox, $('.ade-wb-form-row'));
		const hostOptions = new Map<string, { readonly label: string; readonly osIcon: AdeOsIconKind }>();
		const localInfo = this.hostCatalog.resolveNodeHostAndOs('local');
		hostOptions.set('local', {
			label: adeBi(localize('adeWbHostLocal', "local (Local Mac)"), 'local（本地 Mac）'),
			osIcon: localInfo.osKind,
		});
		for (const h of snap?.hosts ?? []) {
			const catalogInfo = this.hostCatalog.resolveNodeHostAndOs(h.ssh_alias || h.ip);
			const osIcon = catalogInfo.osKind === 'kali'
				? 'kali'
				: resolveAdeOsIconKind({
					os: h.os_kind,
					hint: `${h.name ?? ''} ${h.ssh_alias ?? ''} ${h.ip}`,
				});
			const displayName = h.name || (catalogInfo.displayHost !== h.ip ? catalogInfo.displayHost : h.ssh_alias) || h.ip;
			hostOptions.set(h.ip, {
				label: `${displayName} (${h.ip})`,
				osIcon,
			});
		}
		for (const ch of this.hostCatalog.getKnownCloudHosts()) {
			const key = ch.hostName || ch.alias;
			if (key && !hostOptions.has(key)) {
				const osIcon = resolveAdeOsIconKind({
					os: ch.os,
					distribution: ch.lastTestStatus?.remoteUname,
					hint: `${ch.name ?? ''} ${ch.alias ?? ''} ${ch.user ?? ''} ${ch.hostName ?? ''} ${ch.notes ?? ''}`,
				});
				hostOptions.set(key, {
					label: `${ch.name || ch.alias} (${key})`,
					osIcon,
				});
			}
		}
		if (board.storage_host && !hostOptions.has(board.storage_host)) {
			const fallbackInfo = this.hostCatalog.resolveNodeHostAndOs(board.storage_host);
			hostOptions.set(board.storage_host, {
				label: fallbackInfo.displayHost && fallbackInfo.displayHost !== board.storage_host
					? `${fallbackInfo.displayHost} (${board.storage_host})`
					: board.storage_host,
				osIcon: fallbackInfo.osKind,
			});
		}
		const hostSel = this.viewDisposables.add(new AdeGlassSelect({
			container: hostRow,
			portalContainer: this.bodyEl,
			className: 'ade-mission-config-select full',
			attributes: { 'data-ade-wb-storage-host-select': 'true' },
			items: [...hostOptions.entries()].map(([val, meta]) => ({
				value: val,
				label: meta.label,
				osIcon: meta.osIcon,
			})),
			value: board.storage_host || 'local',
		}));

		const saveBtn = append(formBox, $('button.ade-mission-token-action-btn.primary', {
			type: 'button',
			'data-ade-wb-save-config': 'true',
		}, adeBi(localize('adeWbApplyConfigBtn', "Save & Migrate Storage"), '保存配置（异机自动后台 CAS 搬迁）'))) as HTMLButtonElement;

		this.viewDisposables.add(addDisposableListener(saveBtn, EventType.CLICK, () => {
			if (!this.openProjectId) {
				return;
			}
			const nextName = nameInput.value.trim();
			const nextHost = hostSel.value;
			saveBtn.disabled = true;
			void this.controlCenterService.uiConfigureWhiteboard({
				projectId: this.openProjectId,
				boardId: board.board_id,
				...(nextName && nextName !== board.name ? { name: nextName } : {}),
				...((nextHost !== board.storage_host || board.migration_state === 'idle' || board.migration_state === 'failed')
					? { targetStorageHost: nextHost }
					: {}),
			}).then(() => {
				this.statusBanner = {
					text: adeBi(localize('adeWbSavedConfigOk', "Whiteboard configuration updated."), '白板配置已更新。'),
					isError: false,
				};
				this.delegate.onDidMutateWhiteboard?.();
				return this.reloadInspection();
			}).catch(err => {
				saveBtn.disabled = false;
				this.statusBanner = { text: err instanceof Error ? err.message : String(err), isError: true };
				this.render();
			});
		}));

		// 2. Members & Merged Access Permissions
		const memBox = append(container, $('.ade-wb-settings-section'));
		append(memBox, $('.ade-edge-section-label', {}, adeBi(
			localize('adeWbMembersAccessTitle', "Effective Access Members ({0})", insp.members.length),
			'当前具备有效访问权限的员工列表（{0} 人）',
			insp.members.length,
		)));
		for (const m of insp.members) {
			const row = append(memBox, $('.ade-wb-member-row'));
			append(row, $('span', {}, `${m.name} (${m.agent_id})`));
			append(row, $('span.ade-edge-task-type', {}, m.permission));
		}

		// 3. Danger Zone: Delete Whiteboard
		const dangerBox = append(container, $('.ade-wb-settings-section'));
		const delBtn = append(dangerBox, $('button.ade-mission-token-action-btn.danger', {
			type: 'button',
			'data-ade-wb-delete-btn': board.board_id,
		}, adeBi(localize('adeWbDeleteBoardBtn', "Delete Whiteboard"), '删除白板并回收备份文件'))) as HTMLButtonElement;
		this.viewDisposables.add(addDisposableListener(delBtn, EventType.CLICK, () => {
			if (!this.openProjectId) {
				return;
			}
			delBtn.disabled = true;
			void this.controlCenterService.uiDeleteWhiteboard(this.openProjectId, board.board_id).then(() => {
				this.delegate.onDidMutateWhiteboard?.();
				this.close();
			}).catch(err => {
				delBtn.disabled = false;
				this.statusBanner = { text: err instanceof Error ? err.message : String(err), isError: true };
				this.render();
			});
		}));
	}
}
