/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { $, addDisposableListener, append, clearNode, EventType, isHTMLTextAreaElement } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	AdeInboxSenderRank,
	AdeInboxSeverity,
	IAdeEngineeringService,
	IAdeInboxItem,
	IAdeInboxService,
	resolveAdeInboxSeverity,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	findRankDefinition,
	IAdeOrganizationConfig,
	resolveEffectiveRankDefinition,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import {
	AdeSessionRank,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	resolveAdeAgentRank,
} from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { resolveAdeRankCodicon } from './adeRoleStudioEditorPane.js';
import { IAdeSessionsService } from './adeSessionsService.js';

type AdeInboxLane = 'critical' | 'gate' | 'replies' | 'info' | 'resolved';

const ADE_INBOX_FORMAL_LANE_ORDER: readonly ('critical' | 'gate' | 'info' | 'resolved')[] = ['critical', 'gate', 'info', 'resolved'];
const ADE_INBOX_RENDER_LANE_ORDER: readonly AdeInboxLane[] = ['critical', 'gate', 'replies', 'info', 'resolved'];

export type AdeInboxRankFilter = 'all' | AdeInboxSenderRank;

export const ADE_INBOX_RANK_FILTERS: readonly AdeInboxRankFilter[] = ['all', 'governor', 'manager', 'employee', 'worker'];

const ADE_INBOX_RANK_PRIORITY: Readonly<Record<AdeInboxSenderRank, number>> = {
	governor: 0,
	manager: 1,
	employee: 2,
	worker: 3,
};

/** Message length beyond which a card is clamped to 3 lines with a "more" toggle. */
const ADE_INBOX_CLAMP_CHARS = 180;

export function normalizeAdeInboxRank(
	rank: AdeSessionRank | undefined,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): AdeInboxSenderRank {
	if (!rank) {
		return resolveEffectiveRankDefinition(config, undefined, false).id;
	}
	const found = findRankDefinition(config, rank);
	if (found) {
		return found.id;
	}
	switch (rank) {
		case 'governor':
			return 'governor';
		case 'manager':
			return 'manager';
		case 'employee':
		case 'subordinate':
			return 'employee';
		case 'worker':
			return 'worker';
		default:
			return String(rank);
	}
}

export function resolveAdeInboxItemRank(
	item: IAdeInboxItem,
	projects?: IAdeProjectsService,
	config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG,
): AdeInboxSenderRank {
	if (item.senderRank) {
		return normalizeAdeInboxRank(item.senderRank, config);
	}
	if (item.senderAgentId && projects) {
		const sender = projects.getAgent(item.senderAgentId);
		if (sender) {
			return normalizeAdeInboxRank(resolveAdeAgentRank(sender, projects.hasSubordinates(sender.id), config), config);
		}
	}
	return config.ranks[0]?.id ?? 'governor';
}

function getRankTierLabel(rank: AdeInboxSenderRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): string {
	const found = findRankDefinition(config, rank);
	if (found) {
		return `L${found.tier}`;
	}
	switch (rank) {
		case 'governor': return 'L1';
		case 'manager': return 'L2';
		case 'employee': return 'L3';
		case 'worker': return 'L4';
		default: return 'L*';
	}
}

function getRankShortLabel(rank: AdeInboxSenderRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): string {
	const found = findRankDefinition(config, rank);
	if (found) {
		return found.shortName;
	}
	switch (rank) {
		case 'governor': return localize('adeInboxRankGovShort', "Gov");
		case 'manager': return localize('adeInboxRankMgrShort', "Mgr");
		case 'employee': return localize('adeInboxRankEmpShort', "Emp");
		case 'worker': return localize('adeInboxRankWrkShort', "Wrk");
		default: return String(rank).slice(0, 4);
	}
}

function getRankFullLabel(rank: AdeInboxSenderRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): string {
	const found = findRankDefinition(config, rank);
	if (found) {
		return found.name;
	}
	switch (rank) {
		case 'governor': return localize('adeInboxRankGovFull', "Governor");
		case 'manager': return localize('adeInboxRankMgrFull', "Manager");
		case 'employee': return localize('adeInboxRankEmpFull', "Employee");
		case 'worker': return localize('adeInboxRankWrkFull', "Worker");
		default: return String(rank);
	}
}

function getRankIcon(rank: AdeInboxSenderRank, config: IAdeOrganizationConfig = DEFAULT_ADE_ORGANIZATION_CONFIG): ThemeIcon {
	const found = findRankDefinition(config, rank);
	if (found) {
		return resolveAdeRankCodicon(found.icon);
	}
	switch (rank) {
		case 'governor': return Codicon.organization;
		case 'manager': return Codicon.briefcase;
		case 'employee': return Codicon.shield;
		case 'worker': return Codicon.tools;
		default: return Codicon.account;
	}
}

function formatLaneTitle(lane: AdeInboxLane): string {
	switch (lane) {
		case 'critical':
			return localize('adeInboxLaneCritical', "Critical");
		case 'gate':
			return localize('adeInboxLaneGate', "Needs Decision");
		case 'replies':
			return localize('adeInboxLaneReplies', "Unread Replies");
		case 'info':
			return localize('adeInboxLaneInfo', "Updates");
		case 'resolved':
			return localize('adeInboxLaneResolved', "Resolved");
	}
}

/** Groups formal inbox items into ordered triage lanes (Critical → Needs Decision → Updates → Resolved). */
export function groupAdeInboxItemsByLane(items: readonly IAdeInboxItem[]): Map<'critical' | 'gate' | 'info' | 'resolved', IAdeInboxItem[]> {
	const lanes = new Map<'critical' | 'gate' | 'info' | 'resolved', IAdeInboxItem[]>();
	for (const lane of ADE_INBOX_FORMAL_LANE_ORDER) {
		lanes.set(lane, []);
	}
	for (const item of items) {
		const lane: 'critical' | 'gate' | 'info' | 'resolved' = item.resolved ? 'resolved' : resolveAdeInboxSeverity(item);
		lanes.get(lane)!.push(item);
	}
	return lanes;
}

interface IUnreadReplyEntry {
	readonly agent: IAdeAgent;
	readonly rank: AdeInboxSenderRank;
}

export class AdeInboxPanel extends Disposable {
	readonly element: HTMLElement;
	private readonly filterBarEl: HTMLElement;
	private readonly rankBarEl: HTMLElement;
	private readonly listEl: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private showResolved = false;
	private selectedRank: AdeInboxRankFilter = 'all';
	private expandedRollbackIds = new Set<string>();
	private rollbackFeedbackDrafts = new Map<string, string>();
	private rollbackTargetDrafts = new Map<string, string>();
	private inFlightItemIds = new Set<string>();
	private expandedMessageIds = new Set<string>();
	private resolvedLaneExpanded = false;
	private errorBannerText: string | undefined;

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
		private readonly onError?: (message: string) => void,
		private readonly projects?: IAdeProjectsService,
		private readonly sessions?: IAdeSessionsService,
		private readonly roleSchema?: IAdeRoleSchemaService,
	) {
		super();
		this.element = append(container, $('.ade-inbox-panel'));
		this.filterBarEl = append(this.element, $('.ade-inbox-toolbar'));
		this.rankBarEl = append(this.element, $('.ade-inbox-rank-bar', {
			role: 'toolbar',
			'aria-label': localize('adeInboxRankFilterAria', "Filter Inbox by Agent Rank"),
		}));
		this.listEl = append(this.element, $('.ade-inbox-list'));

		this._register(this.inbox.onDidChange(() => {
			if (!this.element.hidden) {
				this.render();
			}
		}));
		if (this.projects) {
			this._register(this.projects.onDidChange(() => {
				if (!this.element.hidden) {
					this.render();
				}
			}));
		}
		if (this.sessions) {
			this._register(this.sessions.onDidChangeEngines(() => {
				if (!this.element.hidden) {
					this.render();
				}
			}));
		}
		if (this.roleSchema) {
			this._register(this.roleSchema.onDidChangeSchema(() => {
				const cfg = this.roleSchema!.getConfig();
				if (this.selectedRank !== 'all' && !cfg.ranks.some(r => r.id === this.selectedRank)) {
					this.selectedRank = 'all';
				}
				if (!this.element.hidden) {
					this.render();
				}
			}));
		}
		this.render();
	}

	private getRoleConfig(): IAdeOrganizationConfig {
		return this.roleSchema?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
	}

	setVisible(visible: boolean): void {
		this.element.hidden = !visible;
		if (visible) {
			this.render();
		}
	}

	setRankFilter(rank: AdeInboxRankFilter): void {
		if (this.selectedRank === rank) {
			return;
		}
		this.selectedRank = rank;
		this.render();
	}

	layout(height: number): void {
		const barH = (this.filterBarEl.offsetHeight || 28) + (this.rankBarEl.offsetHeight || 28);
		this.listEl.style.maxHeight = `${Math.max(80, height - barH)}px`;
	}

	private collectUnreadReplies(): IUnreadReplyEntry[] {
		if (!this.projects) {
			return [];
		}
		const projects = this.projects;
		const config = this.getRoleConfig();
		const entries: IUnreadReplyEntry[] = [];
		for (const agent of projects.agents) {
			if (projects.isArchived(agent.id) || !agent.unread) {
				continue;
			}
			const rank = normalizeAdeInboxRank(resolveAdeAgentRank(agent, projects.hasSubordinates(agent.id), config), config);
			entries.push({ agent, rank });
		}
		const tierOf = (r: string) => findRankDefinition(config, r)?.tier ?? (ADE_INBOX_RANK_PRIORITY[r] ?? 99);
		entries.sort((a, b) => tierOf(a.rank) - tierOf(b.rank));
		return entries;
	}

	render(): void {
		const prevScrollTop = this.listEl.scrollTop;
		const activeEl = this.element.ownerDocument.activeElement;
		const activeRollbackCardId = isHTMLTextAreaElement(activeEl)
			? (activeEl.closest('[data-inbox-id]')?.getAttribute('data-inbox-id') ?? undefined)
			: undefined;
		const activeSelectionStart = isHTMLTextAreaElement(activeEl) ? activeEl.selectionStart : null;
		const activeSelectionEnd = isHTMLTextAreaElement(activeEl) ? activeEl.selectionEnd : null;

		this.renderDisposables.clear();
		clearNode(this.filterBarEl);
		clearNode(this.rankBarEl);
		clearNode(this.listEl);

		const roleConfig = this.getRoleConfig();
		const rankFilters: AdeInboxRankFilter[] = ['all', ...roleConfig.ranks.map(r => r.id)];
		const allFormalItems = this.inbox.list({ includeResolved: this.showResolved });
		const allUnreadReplies = this.collectUnreadReplies();

		// Compute per-rank counts across visible formal items + unread session replies
		const rankCounts: Record<string, number> = {
			all: allFormalItems.length + allUnreadReplies.length,
		};
		for (const r of roleConfig.ranks) {
			rankCounts[r.id] = 0;
		}
		for (const item of allFormalItems) {
			const r = resolveAdeInboxItemRank(item, this.projects, roleConfig);
			rankCounts[r] = (rankCounts[r] ?? 0) + 1;
		}
		for (const entry of allUnreadReplies) {
			rankCounts[entry.rank] = (rankCounts[entry.rank] ?? 0) + 1;
		}

		const filteredFormalItems = this.selectedRank === 'all'
			? allFormalItems
			: allFormalItems.filter(item => resolveAdeInboxItemRank(item, this.projects, roleConfig) === this.selectedRank);
		const filteredUnreadReplies = this.selectedRank === 'all'
			? allUnreadReplies
			: allUnreadReplies.filter(entry => entry.rank === this.selectedRank);

		const unreadFormalMatching = filteredFormalItems.filter(item => item.unread && !item.resolved);
		const hasMarkableUnread = unreadFormalMatching.length > 0 || filteredUnreadReplies.length > 0;

		if (this.errorBannerText) {
			const errBanner = append(this.listEl, $('.ade-inbox-card.ade-inbox-error-banner.sev-critical', { role: 'alert' }));
			const errTop = append(errBanner, $('.ade-inbox-card-top'));
			const errIco = append(errTop, $('span.ade-inbox-error-icon', { 'aria-hidden': 'true' }));
			errIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.error));
			append(errTop, $('span.ade-inbox-card-title', {}, localize('adeInboxActionFailed', "Action failed")));
			const dismissErr = append(errTop, $('button.ade-inbox-link-btn.ade-inbox-error-dismiss', { type: 'button' }, localize('adeInboxDismissError', "Dismiss")));
			this.renderDisposables.add(addDisposableListener(dismissErr, EventType.CLICK, () => {
				this.errorBannerText = undefined;
				this.render();
			}));
			append(errBanner, $('div.ade-inbox-card-message', {}, this.errorBannerText));
		}

		// Row 1: Pending / All toggle + Mark all read
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

		if (hasMarkableUnread) {
			const markReadBtn = append(this.filterBarEl, $('button.ade-inbox-link-btn', {
				type: 'button',
			}, localize('adeInboxMarkAllRead', "Mark all read")));
			this.renderDisposables.add(addDisposableListener(markReadBtn, EventType.CLICK, () => {
				if (this.selectedRank === 'all') {
					void this.inbox.markRead();
				} else {
					for (const item of unreadFormalMatching) {
						void this.inbox.markRead(item.id);
					}
				}
				if (this.projects) {
					for (const entry of filteredUnreadReplies) {
						this.projects.markRead(entry.agent.id);
					}
				}
			}));
		}

		// Row 2: Rank filter bar (dynamic from configured org schema — default All / Gov / Mgr / Emp / Wrk)
		for (const rank of rankFilters) {
			const isActive = this.selectedRank === rank;
			const count = rankCounts[rank] ?? 0;
			const chipTooltip = rank === 'all'
				? localize('adeInboxRankAllTooltip', "Show messages from all agent ranks")
				: localize('adeInboxRankSingleTooltip', "Show only {0} {1} messages", getRankTierLabel(rank, roleConfig), getRankFullLabel(rank, roleConfig));
			const chip = append(this.rankBarEl, $(`button.ade-inbox-rank-chip.rank-${rank}${isActive ? '.active' : ''}${count > 0 ? '.has-items' : ''}`, {
				type: 'button',
				'data-rank': rank,
				'aria-pressed': String(isActive),
				title: chipTooltip,
			}));
			if (rank === 'all') {
				append(chip, $('span.ade-inbox-rank-chip-label', {}, localize('adeInboxRankAllLabel', "All")));
			} else {
				append(chip, $('span.ade-inbox-rank-chip-label', {}, getRankShortLabel(rank, roleConfig)));
			}
			if (count > 0) {
				append(chip, $('span.ade-inbox-rank-count', {}, String(count)));
			}
			this.renderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				this.setRankFilter(rank);
			}));
		}

		if (filteredFormalItems.length === 0 && filteredUnreadReplies.length === 0) {
			this.renderEmptyState(rankCounts.all > 0);
			return;
		}

		const formalLanes = groupAdeInboxItemsByLane(filteredFormalItems);
		for (const lane of ADE_INBOX_RENDER_LANE_ORDER) {
			if (lane === 'replies') {
				if (filteredUnreadReplies.length === 0) {
					continue;
				}
				this.renderLaneHeader('replies', filteredUnreadReplies.length, false);
				for (const entry of filteredUnreadReplies) {
					this.renderUnreadReplyCard(entry);
				}
				continue;
			}
			const laneItems = formalLanes.get(lane) ?? [];
			if (laneItems.length === 0) {
				continue;
			}
			const collapsed = lane === 'resolved' && !this.resolvedLaneExpanded;
			this.renderLaneHeader(lane, laneItems.length, collapsed);
			if (collapsed) {
				continue;
			}
			for (const item of laneItems) {
				this.renderCard(item, activeRollbackCardId, activeSelectionStart, activeSelectionEnd);
			}
		}
		this.listEl.scrollTop = prevScrollTop;
	}

	private renderEmptyState(hasItemsInOtherRanks: boolean): void {
		const empty = append(this.listEl, $('.ade-inbox-empty'));
		const ico = append(empty, $('span.ade-inbox-empty-icon', { 'aria-hidden': 'true' }));
		ico.classList.add(...ThemeIcon.asClassNameArray(this.showResolved || hasItemsInOtherRanks ? Codicon.inbox : Codicon.passFilled));
		if (this.selectedRank !== 'all') {
			const rankLabel = `${getRankTierLabel(this.selectedRank)} ${getRankFullLabel(this.selectedRank)}`;
			append(empty, $('h3.ade-inbox-empty-title', {}, localize('adeInboxEmptyRankTitle', "No {0} messages", rankLabel)));
			append(empty, $('p', {}, hasItemsInOtherRanks
				? localize('adeInboxEmptyRankOther', "Other ranks have active items in your Inbox.")
				: localize('adeInboxEmptyRankNone', "All clear for {0}.", rankLabel)));
			const resetBtn = append(empty, $('button.ade-inbox-link-btn.ade-inbox-empty-link', { type: 'button' }, localize('adeInboxShowAllRanks', "Show All Ranks")));
			this.renderDisposables.add(addDisposableListener(resetBtn, EventType.CLICK, () => {
				this.setRankFilter('all');
			}));
			return;
		}
		append(empty, $('h3.ade-inbox-empty-title', {}, this.showResolved
			? localize('adeInboxEmptyAllTitle', "Inbox is empty")
			: localize('adeInboxEmptyPendingTitle', "All clear")));
		append(empty, $('p', {}, this.showResolved
			? localize('adeInboxEmptyAll', "No messages, unread replies, or approval gates in ADE Inbox.")
			: localize('adeInboxEmptyPending', "All clear — no unread agent replies, User Acceptance Gates, or escalations.")));
		const trees = typeof this.engineering.listTrees === 'function' ? this.engineering.listTrees() : [];
		const latestTree = [...trees].sort((a, b) => b.updatedAt - a.updatedAt)[0];
		if (latestTree) {
			const link = append(empty, $('button.ade-inbox-link-btn.ade-inbox-empty-link', { type: 'button' }, localize('adeInboxOpenCanvases', "Open Engineering Canvas")));
			this.renderDisposables.add(addDisposableListener(link, EventType.CLICK, () => {
				void this.engineering.openEngineeringEditor(latestTree.governorSessionId);
			}));
		}
	}

	private renderLaneHeader(lane: AdeInboxLane, count: number, collapsed: boolean): void {
		const header = append(this.listEl, $(`div.ade-inbox-lane-header.lane-${lane}`, {
			role: 'heading',
			'aria-level': '3',
		}));
		const collapsible = lane === 'resolved';
		if (collapsible) {
			header.classList.add('collapsible');
			header.setAttribute('tabindex', '0');
			header.setAttribute('aria-expanded', String(!collapsed));
			const chevron = append(header, $('span.ade-inbox-lane-chevron', { 'aria-hidden': 'true' }));
			chevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		}
		append(header, $('span.ade-inbox-lane-rail', { 'aria-hidden': 'true' }));
		append(header, $('span.ade-inbox-lane-title', {}, formatLaneTitle(lane)));
		append(header, $('span.ade-inbox-lane-count', {}, String(count)));
		if (collapsible) {
			const toggle = () => {
				this.resolvedLaneExpanded = !this.resolvedLaneExpanded;
				this.render();
			};
			this.renderDisposables.add(addDisposableListener(header, EventType.CLICK, toggle));
			this.renderDisposables.add(addDisposableListener(header, EventType.KEY_DOWN, (ev: KeyboardEvent) => {
				if (ev.key === 'Enter' || ev.key === ' ') {
					ev.preventDefault();
					toggle();
				}
			}));
		}
	}

	private renderUnreadReplyCard(entry: IUnreadReplyEntry): void {
		const { agent, rank } = entry;
		const card = append(this.listEl, $(`div.ade-inbox-card.kind-agent_reply.rank-${rank}.unread`, {
			'data-inbox-agent-id': agent.id,
			'data-rank': rank,
			tabindex: '0',
		}));

		const openReply = () => {
			this.projects?.markRead(agent.id);
			void this.editors.openAgent(agent.id);
		};

		this.renderDisposables.add(addDisposableListener(card, EventType.CLICK, () => openReply()));
		this.renderDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, (ev: KeyboardEvent) => {
			if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === card) {
				ev.preventDefault();
				openReply();
			}
		}));

		const topRow = append(card, $('.ade-inbox-card-top'));
		const rankPill = append(topRow, $(`span.ade-inbox-rank-pill.rank-${rank}`, { 'data-tier': getRankTierLabel(rank) }));
		const rankIco = append(rankPill, $('span.ade-inbox-rank-pill-icon', { 'aria-hidden': 'true' }));
		const roleConfig = this.getRoleConfig();
		rankIco.classList.add(...ThemeIcon.asClassNameArray(getRankIcon(rank, roleConfig)));
		append(rankPill, $('span', {}, `${getRankTierLabel(rank, roleConfig)} ${getRankFullLabel(rank, roleConfig)}`));

		const projectName = this.projects?.getProjectName(agent.projectUri) ?? '';
		if (projectName) {
			append(topRow, $('span.ade-inbox-project-pill', { title: agent.projectUri.fsPath }, projectName));
		}
		append(topRow, $('span.ade-inbox-unread-dot.reply-dot', { 'aria-label': localize('adeInboxUnreadReplyDot', "Unread reply") }));

		const titleRow = append(card, $('.ade-inbox-agent-title-row'));
		const effectiveEngineId = agent.session?.engineId ?? agent.preferredEngineId;
		const icon = effectiveEngineId ? (this.sessions?.getIcon(effectiveEngineId) ?? Codicon.commentDiscussion) : Codicon.comment;
		const iconEl = append(titleRow, $('span.ade-inbox-agent-icon', { 'aria-hidden': 'true' }));
		if (URI.isUri(icon)) {
			iconEl.classList.add('ade-tree-item-icon-svg');
			iconEl.style.backgroundImage = asCSSUrl(icon);
		} else {
			iconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
		}
		append(titleRow, $('div.ade-inbox-card-title', {}, agent.label));

		const engineName = effectiveEngineId ? (this.sessions?.getEngineName(effectiveEngineId) ?? effectiveEngineId) : localize('adeInboxDraftEngine', "Session");
		const parent = agent.parentId ? this.projects?.getAgent(agent.parentId) : undefined;
		if (parent) {
			const metaLine = append(card, $('.ade-inbox-card-meta.ade-inbox-reply-meta'));
			append(metaLine, $('span.ade-inbox-reply-parent', {}, parent.label));
			append(metaLine, $('span.ade-inbox-lineage-sep', { 'aria-hidden': 'true' }, '\u25B8'));
			append(metaLine, $('span', {}, localize('adeInboxReplyMetaEngine', "{0} · Unread reply", engineName)));
		} else {
			append(card, $('.ade-inbox-card-meta.ade-inbox-reply-meta', {}, localize('adeInboxReplyMetaEngine', "{0} · Unread reply", engineName)));
		}

		const actionsRow = append(card, $('.ade-inbox-card-actions'));
		const openBtn = append(actionsRow, $('button.ade-inbox-btn.primary', {
			type: 'button',
		}, localize('adeInboxOpenShortBtn', "Open ↗")));
		this.renderDisposables.add(addDisposableListener(openBtn, EventType.CLICK, e => {
			e.stopPropagation();
			openReply();
		}));

		if (agent.treeGovernorId) {
			const govId = agent.treeGovernorId;
			const canvasBtn = append(actionsRow, $('button.ade-inbox-btn.ghost', {
				type: 'button',
			}, localize('adeInboxOpenCanvasBtn', "Canvas ↗")));
			this.renderDisposables.add(addDisposableListener(canvasBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.engineering.openEngineeringEditor(govId);
			}));
		}

		const markReadBtn = append(actionsRow, $('button.ade-inbox-btn.secondary', {
			type: 'button',
		}, localize('adeInboxMarkSingleReadBtn', "Mark Read")));
		this.renderDisposables.add(addDisposableListener(markReadBtn, EventType.CLICK, e => {
			e.stopPropagation();
			this.projects?.markRead(agent.id);
		}));
	}

	private formatKindLabel(item: IAdeInboxItem, severity: AdeInboxSeverity): string {
		if (item.kind === 'user_gate') {
			return localize('adeInboxKindGate', "User Gate");
		}
		return severity === 'critical'
			? localize('adeInboxKindCircuit', "Circuit Breaker")
			: localize('adeInboxKindGov', "Governor Alert");
	}

	private renderCard(
		item: IAdeInboxItem,
		restoreFocusCardId?: string,
		restoreSelectionStart?: number | null,
		restoreSelectionEnd?: number | null,
	): void {
		const roleConfig = this.getRoleConfig();
		const severity = resolveAdeInboxSeverity(item);
		const itemRank = resolveAdeInboxItemRank(item, this.projects, roleConfig);
		const card = append(this.listEl, $(`div.ade-inbox-card.kind-${item.kind}.sev-${severity}.rank-${itemRank}${item.unread ? '.unread' : ''}${item.resolved ? '.resolved' : ''}`, {
			'data-inbox-id': item.id,
			'data-severity': severity,
			'data-rank': itemRank,
			tabindex: '0',
		}));

		this.renderDisposables.add(addDisposableListener(card, EventType.CLICK, () => {
			if (item.unread) {
				void this.inbox.markRead(item.id).catch(() => undefined);
			}
		}));
		this.renderDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, (ev: KeyboardEvent) => {
			if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === card && item.unread) {
				ev.preventDefault();
				void this.inbox.markRead(item.id).catch(() => undefined);
			}
		}));

		const topRow = append(card, $('.ade-inbox-card-top'));
		const badge = append(topRow, $(`span.ade-inbox-kind-pill.kind-${item.kind}`));
		badge.classList.add(`sev-${severity}`);
		const badgeIco = append(badge, $('span'));
		badgeIco.classList.add(...ThemeIcon.asClassNameArray(item.kind === 'user_gate' ? Codicon.verifiedFilled : severity === 'critical' ? Codicon.error : Codicon.warning));
		append(badge, $('span', {}, this.formatKindLabel(item, severity)));

		append(topRow, $(`span.ade-inbox-rank-pill.compact.rank-${itemRank}`, {
			title: `${getRankTierLabel(itemRank, roleConfig)} ${getRankFullLabel(itemRank, roleConfig)}`,
		}, getRankTierLabel(itemRank, roleConfig)));

		if (item.projectName) {
			append(topRow, $('span.ade-inbox-project-pill', { title: item.projectPath }, item.projectName));
		}
		append(topRow, $('span.ade-inbox-age', {}, this.formatRelativeAge(item.createdAt)));
		if (item.unread) {
			append(topRow, $('span.ade-inbox-unread-dot'));
		}

		append(card, $('div.ade-inbox-card-title', {}, item.title));
		const lineageTooltip = item.nodeId
			? localize('adeInboxLineageJumpNode', "Jump to node [{0}] on the canvas", item.nodeId)
			: localize('adeInboxLineageJumpCanvas', "Open the Governor's canvas");
		const lineage = append(card, $('button.ade-inbox-card-meta.ade-inbox-lineage', {
			type: 'button',
			title: lineageTooltip,
			'aria-label': lineageTooltip,
		}));
		append(lineage, $('span.ade-inbox-lineage-gov', {}, item.governorLabel));
		if (item.nodeId) {
			append(lineage, $('span.ade-inbox-lineage-sep', { 'aria-hidden': 'true' }, '\u25B8'));
			append(lineage, $('span.ade-inbox-lineage-node', {}, item.nodeTitle ? `[${item.nodeId}] ${item.nodeTitle}` : `[${item.nodeId}]`));
		}
		this.renderDisposables.add(addDisposableListener(lineage, EventType.CLICK, e => {
			e.stopPropagation();
			void this.engineering.openEngineeringEditor(item.governorSessionId);
		}));

		const isLong = item.message.length > ADE_INBOX_CLAMP_CHARS || item.message.split('\n').length > 3;
		const expanded = this.expandedMessageIds.has(item.id);
		append(card, $(`div.ade-inbox-card-message${isLong && !expanded ? '.clamped' : ''}`, {}, item.message));
		if (isLong) {
			const moreBtn = append(card, $('button.ade-inbox-link-btn.ade-inbox-more', { type: 'button', 'aria-expanded': String(expanded) }, expanded
				? localize('adeInboxShowLess', "Show less")
				: localize('adeInboxShowMore', "More")));
			this.renderDisposables.add(addDisposableListener(moreBtn, EventType.CLICK, e => {
				e.stopPropagation();
				if (this.expandedMessageIds.has(item.id)) {
					this.expandedMessageIds.delete(item.id);
				} else {
					this.expandedMessageIds.add(item.id);
				}
				this.render();
			}));
		}

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
			})) as HTMLButtonElement;
			const approveIco = append(approveBtn, $('span.ade-inbox-btn-icon', { 'aria-hidden': 'true' }));
			approveIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
			append(approveBtn, $('span', {}, localize('adeInboxGateApproveBtn', "Approve")));
			this.renderDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, e => {
				e.stopPropagation();
				if (this.inFlightItemIds.has(item.id)) {
					return;
				}
				this.inFlightItemIds.add(item.id);
				this.errorBannerText = undefined;
				approveBtn.disabled = true;
				void this.engineering.submitGateVerdict({
					governorSessionId: item.governorSessionId,
					nodeId,
					verdict: 'pass',
				}).catch(err => {
					const msg = err instanceof Error ? err.message : String(err);
					this.errorBannerText = msg;
					this.onError?.(msg);
				}).finally(() => {
					this.inFlightItemIds.delete(item.id);
					this.render();
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

			const dismissGateBtn = append(actionsRow, $('button.ade-inbox-btn.secondary.overflow', {
				type: 'button',
			}, localize('adeInboxDismissBtn', "Dismiss")));
			this.renderDisposables.add(addDisposableListener(dismissGateBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.inbox.resolveItem(item.id, localize('adeInboxDismissedResolution', "Dismissed from Inbox")).catch(() => undefined);
			}));

			if (this.expandedRollbackIds.has(item.id) && candidates.length > 0) {
				const rbBox = append(card, $('.ade-inbox-rollback-box'));
				const selectEl = append(rbBox, $('select.ade-eng-select', {
					'aria-label': localize('adeInboxRollbackTargetAria', "Rollback Target Node"),
				})) as HTMLSelectElement;
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
					'aria-label': localize('adeInboxRollbackFeedbackAria', "Rollback Feedback Instructions"),
				})) as HTMLTextAreaElement;
				fbArea.value = this.rollbackFeedbackDrafts.get(item.id) ?? '';
				if (restoreFocusCardId === item.id) {
					fbArea.focus();
					if (typeof restoreSelectionStart === 'number' && typeof restoreSelectionEnd === 'number') {
						fbArea.setSelectionRange(restoreSelectionStart, restoreSelectionEnd);
					}
				}
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
					this.errorBannerText = undefined;
					confirmRbBtn.disabled = true;
					const chosenTarget = selectEl.value || undefined;
					const chosenFeedback = fbArea.value.trim() || undefined;
					void this.engineering.submitGateVerdict({
						governorSessionId: item.governorSessionId,
						nodeId,
						verdict: 'rollback',
						targetNodeId: chosenTarget,
						feedback: chosenFeedback,
					}).then(() => {
						this.expandedRollbackIds.delete(item.id);
						this.rollbackFeedbackDrafts.delete(item.id);
						this.rollbackTargetDrafts.delete(item.id);
					}).catch(err => {
						const msg = err instanceof Error ? err.message : String(err);
						this.errorBannerText = msg;
						this.onError?.(msg);
					}).finally(() => {
						this.inFlightItemIds.delete(item.id);
						this.render();
					});
				}));
			}
		} else if (severity === 'critical' && !item.resolved) {
			const openNodeBtn = append(actionsRow, $('button.ade-inbox-btn.danger', {
				type: 'button',
			}, item.nodeId
				? localize('adeInboxOpenNodeBtn', "Open Node ↗")
				: localize('adeInboxOpenCanvasCriticalBtn', "Open Canvas ↗")));
			this.renderDisposables.add(addDisposableListener(openNodeBtn, EventType.CLICK, e => {
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
			const ackBtn = append(actionsRow, $('button.ade-inbox-btn.secondary', {
				type: 'button',
			}, localize('adeInboxAcknowledgeBtn', "Acknowledge")));
			this.renderDisposables.add(addDisposableListener(ackBtn, EventType.CLICK, e => {
				e.stopPropagation();
				void this.inbox.resolveItem(item.id, localize('adeInboxResolvedAck', "Acknowledged"));
			}));
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
