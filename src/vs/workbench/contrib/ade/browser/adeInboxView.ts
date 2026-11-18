/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import {
	IAdeEngineeringService,
	IAdeInboxItem,
	IAdeInboxService,
} from '../../../../platform/ade/common/adeEngineering.js';
import { IAdeEditorService } from '../common/ade.js';

export class AdeInboxPanel extends Disposable {
	readonly element: HTMLElement;
	private readonly filterBarEl: HTMLElement;
	private readonly listEl: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private showResolved = false;
	private expandedRollbackIds = new Set<string>();
	private rollbackFeedbackDrafts = new Map<string, string>();
	private rollbackTargetDrafts = new Map<string, string>();
	private inFlightItemIds = new Set<string>();

	private formatRelativeAge(ts: number): string {
		const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		if (diffSec < 45) {
			return localize('adeInboxJustNow', "just now");
		}
		if (diffSec < 3600) {
			return localize('adeInboxMinutesAgo', "{0}m ago", Math.floor(diffSec / 60));
		}
		if (diffSec < 86400) {
			return localize('adeInboxHoursAgo', "{0}h ago", Math.floor(diffSec / 3600));
		}
		return localize('adeInboxDaysAgo', "{0}d ago", Math.floor(diffSec / 86400));
	}

	constructor(
		container: HTMLElement,
		private readonly inbox: IAdeInboxService,
		private readonly engineering: IAdeEngineeringService,
		private readonly editors: IAdeEditorService,
	) {
		super();
		this.element = append(container, $('.ade-inbox-panel'));
		this.filterBarEl = append(this.element, $('.ade-inbox-toolbar'));
		this.listEl = append(this.element, $('.ade-inbox-list'));

		this._register(this.inbox.onDidChange(() => this.render()));
		this.render();
	}

	setVisible(visible: boolean): void {
		this.element.hidden = !visible;
		if (visible) {
			this.render();
		}
	}

	layout(height: number): void {
		const barH = this.filterBarEl.offsetHeight || 28;
		this.listEl.style.maxHeight = `${Math.max(80, height - barH)}px`;
	}

	render(): void {
		const prevScrollTop = this.listEl.scrollTop;
		this.renderDisposables.clear();
		clearNode(this.filterBarEl);
		clearNode(this.listEl);

		const leftGroup = append(this.filterBarEl, $('.ade-inbox-toolbar-left'));
		const pendingToggle = append(leftGroup, $(`button.ade-inbox-filter-btn${!this.showResolved ? '.active' : ''}`, {
			type: 'button',
			'aria-pressed': String(!this.showResolved),
		}, localize('adeInboxPendingFilter', "Pending")));
		const allToggle = append(leftGroup, $(`button.ade-inbox-filter-btn${this.showResolved ? '.active' : ''}`, {
			type: 'button',
			'aria-pressed': String(this.showResolved),
		}, localize('adeInboxAllFilter', "All")));

		this.renderDisposables.add(addDisposableListener(pendingToggle, EventType.CLICK, () => {
			this.showResolved = false;
			this.render();
		}));
		this.renderDisposables.add(addDisposableListener(allToggle, EventType.CLICK, () => {
			this.showResolved = true;
			this.render();
		}));

		if (this.inbox.unreadCount > 0) {
			const markReadBtn = append(this.filterBarEl, $('button.ade-inbox-link-btn', {
				type: 'button',
			}, localize('adeInboxMarkAllRead', "Mark all read")));
			this.renderDisposables.add(addDisposableListener(markReadBtn, EventType.CLICK, () => {
				void this.inbox.markRead();
			}));
		}

		const items = this.inbox.list({ includeResolved: this.showResolved });
		if (items.length === 0) {
			const empty = append(this.listEl, $('.ade-inbox-empty'));
			const ico = append(empty, $('span.ade-inbox-empty-icon'));
			ico.classList.add(...ThemeIcon.asClassNameArray(Codicon.inbox));
			append(empty, $('p', {}, this.showResolved
				? localize('adeInboxEmptyAll', "No messages or approval gates in ADE Inbox.")
				: localize('adeInboxEmptyPending', "All clear — no pending User Acceptance Gates or Governor escalations.")));
			return;
		}

		for (const item of items) {
			this.renderCard(item);
		}
		this.listEl.scrollTop = prevScrollTop;
	}

	private renderCard(item: IAdeInboxItem): void {
		const card = append(this.listEl, $(`div.ade-inbox-card.kind-${item.kind}${item.unread ? '.unread' : ''}${item.resolved ? '.resolved' : ''}`, {
			'data-inbox-id': item.id,
		}));

		this.renderDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
			if (item.unread) {
				void this.inbox.markRead(item.id);
			}
		}));

		const topRow = append(card, $('.ade-inbox-card-top'));
		const badge = append(topRow, $(`span.ade-inbox-kind-pill.kind-${item.kind}`));
		const badgeIco = append(badge, $('span'));
		badgeIco.classList.add(...ThemeIcon.asClassNameArray(item.kind === 'user_gate' ? Codicon.verifiedFilled : Codicon.warning));
		append(badge, $('span', {}, item.kind === 'user_gate'
			? localize('adeInboxKindGate', "User Gate")
			: localize('adeInboxKindGov', "Governor Alert")));

		if (item.projectName) {
			append(topRow, $('span.ade-inbox-project-pill', { title: item.projectPath }, item.projectName));
		}
		append(topRow, $('span.ade-inbox-age', {}, this.formatRelativeAge(item.createdAt)));
		if (item.unread) {
			append(topRow, $('span.ade-inbox-unread-dot'));
		}

		append(card, $('div.ade-inbox-card-title', {}, item.title));
		append(card, $('div.ade-inbox-card-meta', {}, item.nodeTitle ? `${item.governorLabel} · [${item.nodeId}] ${item.nodeTitle}` : `${item.governorLabel}`));
		append(card, $('div.ade-inbox-card-message', {}, item.message));

		if (item.upstreamSummary && item.upstreamSummary.trim() && !item.upstreamSummary.startsWith('(None')) {
			const details = append(card, $('details.ade-inbox-upstream-details'));
			append(details, $('summary', {}, localize('adeInboxUpstreamSummaryToggle', "Upstream Incremental Reports")));
			append(details, $('pre.ade-inbox-upstream-pre', {}, item.upstreamSummary));
		}

		if (item.resolved) {
			append(card, $('div.ade-inbox-resolved-tag', {}, item.resolution
				? localize('adeInboxResolvedWithNote', "Resolved: {0}", item.resolution)
				: localize('adeInboxResolvedLabel', "Resolved")));
		}

		const actionsRow = append(card, $('.ade-inbox-card-actions'));
		const isBusy = this.inFlightItemIds.has(item.id);

		if (item.kind === 'user_gate' && !item.resolved && item.nodeId) {
			const nodeId = item.nodeId;
			const approveBtn = append(actionsRow, $('button.ade-inbox-btn.primary', {
				type: 'button',
				...(isBusy ? { disabled: 'disabled' } : {}),
			}, localize('adeInboxGateApproveBtn', "Approve"))) as HTMLButtonElement;
			this.renderDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, e => {
				e.stopPropagation();
				if (this.inFlightItemIds.has(item.id)) {
					return;
				}
				this.inFlightItemIds.add(item.id);
				approveBtn.disabled = true;
				void this.engineering.submitGateVerdict({
					governorSessionId: item.governorSessionId,
					nodeId,
					verdict: 'pass',
				}).finally(() => {
					this.inFlightItemIds.delete(item.id);
				});
			}));

			const candidates = item.rollbackCandidates ?? [];
			if (candidates.length > 0) {
				const rbToggleBtn = append(actionsRow, $('button.ade-inbox-btn.danger-outline', {
					type: 'button',
					...(isBusy ? { disabled: 'disabled' } : {}),
				}, localize('adeInboxGateRollbackToggleBtn', "Roll Back...")));
				this.renderDisposables.add(addDisposableListener(rbToggleBtn, EventType.CLICK, e => {
					e.stopPropagation();
					if (this.expandedRollbackIds.has(item.id)) {
						this.expandedRollbackIds.delete(item.id);
					} else {
						this.expandedRollbackIds.add(item.id);
					}
					this.render();
				}));
			}

			const openCanvasBtn = append(actionsRow, $('button.ade-inbox-btn.ghost', {
				type: 'button',
			}, localize('adeInboxOpenCanvasBtn', "Canvas ↗")));
			this.renderDisposables.add(addDisposableListener(openCanvasBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.engineering.openEngineeringEditor(item.governorSessionId);
			}));

			if (this.expandedRollbackIds.has(item.id) && candidates.length > 0) {
				const rbBox = append(card, $('.ade-inbox-rollback-box'));
				const selectEl = append(rbBox, $('select.ade-eng-select')) as HTMLSelectElement;
				const savedTarget = this.rollbackTargetDrafts.get(item.id) ?? candidates[candidates.length - 1]?.id;
				for (const c of candidates) {
					const opt = append(selectEl, $('option', { value: c.id }, `[${c.id}] ${c.title}`)) as HTMLOptionElement;
					if (c.id === savedTarget) {
						opt.selected = true;
					}
				}
				this.renderDisposables.add(addDisposableListener(selectEl, EventType.CHANGE, () => {
					this.rollbackTargetDrafts.set(item.id, selectEl.value);
				}));
				const fbArea = append(rbBox, $('textarea.ade-eng-textarea', {
					rows: 2,
					placeholder: localize('adeInboxRollbackFeedbackHint', "Feedback instructions for rework…"),
				})) as HTMLTextAreaElement;
				fbArea.value = this.rollbackFeedbackDrafts.get(item.id) ?? '';
				this.renderDisposables.add(addDisposableListener(fbArea, EventType.INPUT, () => {
					this.rollbackFeedbackDrafts.set(item.id, fbArea.value);
				}));
				const confirmRbBtn = append(rbBox, $('button.ade-inbox-btn.danger', {
					type: 'button',
					...(isBusy ? { disabled: 'disabled' } : {}),
				}, localize('adeInboxConfirmRollbackBtn', "Confirm Partial Rollback"))) as HTMLButtonElement;
				this.renderDisposables.add(addDisposableListener(confirmRbBtn, EventType.CLICK, e => {
					e.stopPropagation();
					if (this.inFlightItemIds.has(item.id)) {
						return;
					}
					this.inFlightItemIds.add(item.id);
					confirmRbBtn.disabled = true;
					const chosenTarget = selectEl.value || undefined;
					const chosenFeedback = fbArea.value.trim() || undefined;
					this.expandedRollbackIds.delete(item.id);
					this.rollbackFeedbackDrafts.delete(item.id);
					this.rollbackTargetDrafts.delete(item.id);
					void this.engineering.submitGateVerdict({
						governorSessionId: item.governorSessionId,
						nodeId,
						verdict: 'rollback',
						targetNodeId: chosenTarget,
						feedback: chosenFeedback,
					}).finally(() => {
						this.inFlightItemIds.delete(item.id);
					});
				}));
			}
		} else {
			const openEngBtn = append(actionsRow, $('button.ade-inbox-btn.ghost', {
				type: 'button',
			}, localize('adeInboxJumpEngineeringBtn', "Engineering ↗")));
			this.renderDisposables.add(addDisposableListener(openEngBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.engineering.openEngineeringEditor(item.governorSessionId);
			}));

			const openGovBtn = append(actionsRow, $('button.ade-inbox-btn.ghost', {
				type: 'button',
			}, localize('adeInboxJumpGovernorBtn', "Governor ↗")));
			this.renderDisposables.add(addDisposableListener(openGovBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.editors.openAgent(item.governorSessionId);
			}));

			if (!item.resolved) {
				const resolveBtn = append(actionsRow, $('button.ade-inbox-btn.secondary', {
					type: 'button',
				}, localize('adeInboxResolveBtn', "Resolve")));
				this.renderDisposables.add(addDisposableListener(resolveBtn, EventType.CLICK, e => {
					e.stopPropagation();
					void this.inbox.resolveItem(item.id, localize('adeInboxResolvedAck', "Acknowledged"));
				}));
			}
		}
	}
}
