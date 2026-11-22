/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IMissionDagEdge, IMissionDagNode, IMissionNodeCheckHook, MissionCheckOnFailAction } from '../../../../platform/ade/common/adeMissionDag.js';
import { MissionNodeRoleKind } from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	buildMissionRunArchiveSnapshot,
	compareMissionRuns,
	computeMissionFinOpsSummary,
	computeMissionNodeContextBreakdown,
	formatCompactTokenCount,
	IMissionFinOpsBucket,
	IMissionFinOpsSummary,
	IMissionRunArchive,
	IMissionRuntimeState,
	IMissionToken,
	inferModelContextWindowTokens,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import { formatFinOpsUsd } from '../../../../platform/ade/common/adeModelPricing.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import { IAdeAgent, IAdeProjectsService } from '../common/ade.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import {
	formatMissionBlockedRemaining,
	formatMissionTriggerShortLabel,
	formatMissionWaveTag,
	getMissionSupervisorColorIndex,
} from './adeMissionCanvasRenderer.js';
import { AdeMissionHostCatalog, MISSION_ENGINE_DEFAULT_MODELS } from './adeMissionHostCatalog.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';

export type MissionInspectorTab = 'overview' | 'token' | 'distill' | 'finops';

export interface IMissionNodeInspectorDelegate {
	getActiveMissionId(): string | undefined;
	getNodes(): readonly IMissionDagNode[];
	getEdges(): readonly IMissionDagEdge[];
	getAgentForNode(nodeId: string): IAdeAgent | undefined;
	getHostByNodeIdMap(): ReadonlyMap<string, string>;
	getFallbackOwnerEngineId(): string;
	getNodePrompt(missionId: string, nodeId: string): string;
	resolveSupervisorDisplay(supervisorId: string): { readonly label: string; readonly shortLabel: string; readonly tier: number };
	canSwitchAgentEngine(agent: IAdeAgent): boolean;
	onClose(): void;
	onSelectNodeFromInspector(nodeId: string): void;
	onOpenAgentBeside(agentId: string): void;
	onOpenAgentTab(agentId: string): void;
	onOpenEmployeePopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenSupervisorPopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenHostPopover(node: IMissionDagNode, currentHost: string, anchorEl: HTMLElement): void;
	onOpenModelPopover(nodeId: string, agent: IAdeAgent, engineId: string, anchorEl: HTMLElement): void;
	onOpenEnginePopover(nodeId: string, agent: IAdeAgent, engineId: string, anchorEl: HTMLElement): void;
	onOpenNodePromptPopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenTriggersPopover(preferredNodeId: string, anchorEl: HTMLElement): void;
	onOpenTokenInspectorPopover(node: IMissionDagNode, token: IMissionToken, allNodeTokens: readonly IMissionToken[], anchorEl: HTMLElement): void;
	onOpenGateDecisionPopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onQuickRetryNode(node: IMissionDagNode, token: IMissionToken, guidance?: string): void;
	onQuickRecallNode(node: IMissionDagNode, token: IMissionToken | undefined): void;
	onDistillNodeContext(node: IMissionDagNode, memo?: string): void;
	onRunNodeChecks(node: IMissionDagNode): void;
	onToggleNodeRoleKind?(node: IMissionDagNode, nextRoleKind: MissionNodeRoleKind): void;
	onUpsertNodeCheck?(nodeId: string, check: IMissionNodeCheckHook): void;
	onRemoveNodeCheck?(nodeId: string, checkId: string): void;
	onSetBudgetLimit(budgetLimitUsd: number | undefined): void;
	onRaiseAndResumeBudget(nextLimitUsd: number): void;
}

interface IShellHandles {
	readonly nodeIdBadgeEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly stateBadgeEl: HTMLElement;
	readonly tabBtns: ReadonlyMap<MissionInspectorTab, HTMLButtonElement>;
	readonly bodyScrollEl: HTMLElement;
}

interface IOverviewTabHandles {
	readonly kind: 'overview';
	node: IMissionDagNode;
	linkedAgent: IAdeAgent | undefined;
	engineId: string;
	currentHostAlias: string;
	currentRoleKind: MissionNodeRoleKind;
	primaryToken: IMissionToken | undefined;
	failedToken: IMissionToken | undefined;
	readonly chatBarEl: HTMLElement;
	readonly splitBtn?: HTMLButtonElement;
	readonly tabBtn?: HTMLButtonElement;
	readonly gateBtn?: HTMLButtonElement;
	readonly supRow?: HTMLButtonElement;
	readonly supValEl?: HTMLElement;
	lastSupSignature: string;
	readonly roleRow?: HTMLButtonElement;
	readonly roleChipEl?: HTMLElement;
	readonly empRow?: HTMLButtonElement;
	readonly empValEl?: HTMLElement;
	lastEmpSignature: string;
	readonly hostRow?: HTMLButtonElement;
	readonly hostValEl?: HTMLElement;
	readonly modelRow?: HTMLButtonElement;
	readonly modelValEl?: HTMLElement;
	readonly engRow?: HTMLButtonElement;
	readonly engValEl?: HTMLElement;
	readonly editPromptBtn?: HTMLButtonElement;
	readonly promptBlockEl?: HTMLElement;
	readonly trigSectionEl: HTMLElement;
	readonly trigTitleEl: HTMLElement;
	readonly trigEmptyHintEl: HTMLElement;
	readonly trigChipsEl: HTMLElement;
	lastTrigSignature: string;
	readonly inspectTokBtn: HTMLButtonElement;
	readonly telemetryLineEl: HTMLElement;
	readonly tokenMetaRowEl: HTMLElement;
	readonly waveChipEl: HTMLElement;
	readonly blockedChipEl: HTMLElement;
	readonly tokenSummaryEl: HTMLElement;
	readonly actRowEl: HTMLElement;
	readonly retryBtn: HTMLButtonElement;
	readonly distillShortcutBtn?: HTMLButtonElement;
	readonly recallBtn: HTMLButtonElement;
	readonly noLiveTokenHintEl: HTMLElement;
}

interface ITokenTabHandles {
	readonly kind: 'token';
	node: IMissionDagNode;
	selectedToken: IMissionToken | undefined;
	readonly emptyHintEl: HTMLElement;
	readonly contentWrapEl: HTMLElement;
	readonly waveSwitcherEl: HTMLElement;
	readonly waveDisposables: DisposableStore;
	lastWaveSignature: string;
	readonly metaRowEl: HTMLElement;
	lastMetaSignature: string;
	readonly blockedBoxEl: HTMLElement;
	readonly blockedCountdownEl: HTMLElement;
	readonly blockedReasonEl: HTMLElement;
	readonly blockedWatchRowEl: HTMLElement;
	lastBlockedWatchSignature: string;
	readonly failedBoxEl: HTMLElement;
	readonly failedReasonEl: HTMLElement;
	readonly lastSummaryEl: HTMLElement;
	readonly archivedChipEl: HTMLElement;
	readonly compressedHistoryEl: HTMLElement;
	readonly traceTitleEl: HTMLElement;
	readonly expandTraceBtn: HTMLButtonElement;
	readonly traceListEl: HTMLElement;
	lastTraceSignature: string;
	readonly guidanceInput: HTMLInputElement;
	readonly actRowEl: HTMLElement;
	readonly retryBtn: HTMLButtonElement;
	readonly recallBtn: HTMLButtonElement;
}

interface IDistillTabHandles {
	readonly kind: 'distill';
	node: IMissionDagNode;
	readonly pctBadgeEl: HTMLElement;
	readonly segInitEl: HTMLElement;
	readonly segTierEl: HTMLElement;
	readonly segSrcEl: HTMLElement;
	readonly segNoiseEl: HTMLElement;
	readonly initValEl: HTMLElement;
	readonly tierValEl: HTMLElement;
	readonly srcValEl: HTMLElement;
	readonly noiseValEl: HTMLElement;
	readonly memoInput?: HTMLInputElement;
	readonly chkTitleEl: HTMLElement;
	readonly runChkBtn: HTMLButtonElement;
	readonly chkListEl: HTMLElement;
	readonly chkListDisposables: DisposableStore;
	readonly noChecksHintEl: HTMLElement;
	lastChecksSignature: string;
	readonly lastCheckBoxEl: HTMLElement;
	readonly lastCheckBodyEl: HTMLElement;
}

interface IFinOpsBucketRowHandle {
	readonly key: string;
	readonly labelEl: HTMLElement;
	readonly valEl: HTMLElement;
	readonly fillEl: HTMLElement;
}

interface IFinOpsNodeRowHandle {
	readonly nodeId: string;
	readonly keyEl: HTMLElement;
	readonly valEl: HTMLElement;
}

interface IFinOpsTabHandles {
	readonly kind: 'finops';
	lastSummary: IMissionFinOpsSummary | undefined;
	readonly heroEl: HTMLElement;
	readonly heroSpendEl: HTMLElement;
	readonly heroLimitEl: HTMLElement;
	readonly heroEstBadgeEl: HTMLElement;
	readonly heroTokensEl: HTMLElement;
	readonly heroCacheEl: HTMLElement;
	readonly trippedAlertEl: HTMLElement;
	readonly sliderEl: HTMLInputElement;
	readonly numInputEl: HTMLInputElement;
	readonly tierEmptyEl: HTMLElement;
	readonly tierRowsWrapEl: HTMLElement;
	tierRows: IFinOpsBucketRowHandle[];
	readonly hostEmptyEl: HTMLElement;
	readonly hostRowsWrapEl: HTMLElement;
	hostRows: IFinOpsBucketRowHandle[];
	readonly topNodesSectionEl: HTMLElement;
	readonly topNodesListEl: HTMLElement;
	readonly topNodesDisposables: DisposableStore;
	topNodeRows: IFinOpsNodeRowHandle[];
	readonly runHistorySectionEl: HTMLElement;
	readonly runDeltaBannerEl: HTMLElement;
	readonly runHistoryListEl: HTMLElement;
	readonly runHistoryDisposables: DisposableStore;
	selectedBaselineRunNumber: number | undefined;
	lastRunHistorySignature: string;
}

type IActiveTabHandles = IOverviewTabHandles | ITokenTabHandles | IDistillTabHandles | IFinOpsTabHandles;

interface ICheckFormDraft {
	name: string;
	command: string;
	files: string;
	match: string;
	onFail: MissionCheckOnFailAction;
	retries: string;
}

function setTextIfChanged(el: HTMLElement, text: string): void {
	if (el.textContent !== text) {
		el.textContent = text;
	}
}

function formatMissionStateBadgeLabel(state: string): string {
	switch (state) {
		case 'idle':
			return adeBi(localize('adeMissionNiStateIdle', "Idle"), "待命");
		case 'active':
		case 'running':
			return adeBi(localize('adeMissionNiStateRunning', "Running"), '运行中');
		case 'queued':
			return adeBi(localize('adeMissionNiStateQueued', "Queued"), '排队中');
		case 'blocked':
			return adeBi(localize('adeMissionNiStateBlocked', "Blocked"), "阻塞等待");
		case 'waiting_gate':
			return adeBi(localize('adeMissionNiStateGate', "Awaiting Gate"), "等待审批");
		case 'waiting_join':
			return adeBi(localize('adeMissionNiStateJoin', "Awaiting Join"), "等待汇合");
		case 'completed':
			return adeBi(localize('adeMissionNiStateDone', "Completed"), "已完成");
		case 'frozen_failed':
		case 'failed':
			return adeBi(localize('adeMissionNiStateFailed', "Failed"), "已失败");
		case 'paused':
			return adeBi(localize('adeMissionNiStatePaused', "Paused"), "已暂停");
		case 'stopped':
			return adeBi(localize('adeMissionNiStateStopped', "Stopped"), "已停止");
		case 'recalled':
			return adeBi(localize('adeMissionNiStateRecalled', "Recalled"), "已撤回");
		default:
			return state;
	}
}

/**
 * 4-in-1 Docked Right-Side Mission Studio Inspector Drawer:
 * - Split into a **Persistent Shell + Static Form Skeleton Layer** (rebuilt ONLY on node/tab/mission switch)
 *   and an **In-Place Dynamic Telemetry Layer** (patches numbers, bars, badges, and summaries at 1Hz with zero DOM teardown).
 * - Never destroys focused `<input>` / `<textarea>` / `<select>` controls, active FinOps budget slider drags,
 *   or user scroll positions during live streaming updates.
 */
export class AdeMissionNodeInspector extends Disposable {
	private readonly panelEl: HTMLElement;
	private readonly shellDisposables = this._register(new DisposableStore());
	private readonly tabDisposables = this._register(new DisposableStore());
	private readonly sliderDragDisposables = this._register(new DisposableStore());

	private shell: IShellHandles | undefined;
	private activeTabHandles: IActiveTabHandles | undefined;
	private renderedTabKey = '';

	private selectedNodeId: string | undefined;
	private lastMissionId: string | undefined;
	private activeTab: MissionInspectorTab = 'overview';
	private isBudgetSliderDragging = false;
	private selectedTokenIdByNode = new Map<string, string>();
	private expandedTraceTokenIds = new Set<string>();
	private readonly retryGuidanceDraftByNode = new Map<string, string>();
	private readonly distillMemoDraftByNode = new Map<string, string>();
	private readonly checkFormDraftByNode = new Map<string, ICheckFormDraft>();

	constructor(
		bodyEl: HTMLElement,
		private readonly hostCatalog: AdeMissionHostCatalog,
		private readonly projectsService: IAdeProjectsService | undefined,
		private readonly missionRuntimeService: IAdeMissionRuntimeService | undefined,
		private readonly roleSchemaService: IAdeRoleSchemaService | undefined,
		private readonly delegate: IMissionNodeInspectorDelegate,
	) {
		super();
		this.panelEl = append(bodyEl, $('aside.ade-mission-node-inspector', {
			role: 'complementary',
			'aria-label': adeBi(localize('adeMissionNodeInspectorAria', "Mission Studio 4-in-1 Inspector"), "任务工坊四合一节点检视器"),
			'data-ade-mission-node-inspector': 'true',
		}));
		this.panelEl.hidden = true;
		this._register(addDisposableListener(this.panelEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this._register(addDisposableListener(this.panelEl, EventType.WHEEL, e => e.stopPropagation()));
		this._register(onDidChangeAdeLocale(() => {
			this.panelEl.setAttribute('aria-label', adeBi(localize('adeMissionNodeInspectorAria', "Mission Studio 4-in-1 Inspector"), "任务工坊四合一节点检视器"));
			if (this.isOpen()) {
				this.shell = undefined;
				this.activeTabHandles = undefined;
				this.renderedTabKey = '';
				this.refresh();
			}
		}));
		if (this.roleSchemaService) {
			this._register(this.roleSchemaService.onDidChangeSchema(() => {
				if (this.isOpen()) {
					this.refresh();
				}
			}));
		}
	}

	isOpen(): boolean {
		return !this.panelEl.hidden;
	}

	getSelectedNodeId(): string | undefined {
		return this.selectedNodeId;
	}

	getActiveTab(): MissionInspectorTab {
		return this.activeTab;
	}

	open(nodeId: string | undefined, tab?: MissionInspectorTab): void {
		if (nodeId !== undefined) {
			this.selectedNodeId = nodeId;
		} else if (!this.selectedNodeId) {
			this.selectedNodeId = this.delegate.getNodes()[0]?.id;
		}
		if (tab) {
			this.activeTab = tab;
		}
		this.panelEl.hidden = false;
		if (this.selectedNodeId) {
			this.panelEl.dataset.nodeId = this.selectedNodeId;
		} else {
			delete this.panelEl.dataset.nodeId;
		}
		this.panelEl.dataset.activeTab = this.activeTab;
		this.refresh();
	}

	close(notify = true): void {
		const wasOpen = this.isOpen();
		this.selectedNodeId = undefined;
		this.isBudgetSliderDragging = false;
		this.sliderDragDisposables.clear();
		this.tabDisposables.clear();
		this.shellDisposables.clear();
		this.activeTabHandles = undefined;
		this.shell = undefined;
		this.renderedTabKey = '';
		clearNode(this.panelEl);
		delete this.panelEl.dataset.nodeId;
		delete this.panelEl.dataset.activeTab;
		this.panelEl.hidden = true;
		if (wasOpen && notify) {
			this.delegate.onClose();
		}
	}

	/**
	 * Lightweight 1Hz countdown patcher called by the canvas blocked-timer loop without
	 * touching any other DOM nodes or form controls.
	 */
	patchBlockedCountdowns(rt: IMissionRuntimeState | undefined, now = Date.now()): void {
		if (this.panelEl.hidden || !rt || !this.activeTabHandles) {
			return;
		}
		if (this.activeTabHandles.kind === 'overview') {
			const tok = this.activeTabHandles.primaryToken;
			if (tok && tok.status === 'blocked' && tok.blocked) {
				const liveTok = rt.tokens[tok.id] ?? tok;
				if (liveTok.blocked) {
					const rem = formatMissionBlockedRemaining(liveTok.blocked.expiresAt, now);
					setTextIfChanged(this.activeTabHandles.blockedChipEl, `⏳ ${rem.text}`);
					this.activeTabHandles.blockedChipEl.hidden = false;
				}
			}
		} else if (this.activeTabHandles.kind === 'token') {
			const tok = this.activeTabHandles.selectedToken;
			if (tok && tok.status === 'blocked' && tok.blocked) {
				const liveTok = rt.tokens[tok.id] ?? tok;
				if (liveTok.blocked) {
					const rem = formatMissionBlockedRemaining(liveTok.blocked.expiresAt, now);
					setTextIfChanged(this.activeTabHandles.blockedCountdownEl, `⏳ ${rem.text}`);
				}
			}
		}
	}

	refresh(): void {
		if (this.panelEl.hidden) {
			return;
		}
		const missionId = this.delegate.getActiveMissionId();
		if (!missionId) {
			this.close(true);
			return;
		}
		if (this.lastMissionId && this.lastMissionId !== missionId) {
			this.selectedTokenIdByNode.clear();
			this.expandedTraceTokenIds.clear();
			this.retryGuidanceDraftByNode.clear();
			this.distillMemoDraftByNode.clear();
			this.checkFormDraftByNode.clear();
		}
		this.lastMissionId = missionId;
		const nodes = this.delegate.getNodes();
		let node = this.selectedNodeId ? nodes.find(n => n.id === this.selectedNodeId) : undefined;
		if (!node && this.activeTab !== 'finops') {
			node = nodes[0];
			this.selectedNodeId = node?.id;
		}
		if (this.selectedNodeId) {
			this.panelEl.dataset.nodeId = this.selectedNodeId;
		} else {
			delete this.panelEl.dataset.nodeId;
		}
		this.panelEl.dataset.activeTab = this.activeTab;

		const shell = this.ensureShell();
		const rt: IMissionRuntimeState | undefined = this.missionRuntimeService?.getRuntimeState(missionId);
		const nodeState = node ? (rt?.nodeStates[node.id] ?? 'idle') : (rt?.status ?? 'idle');
		const linkedAgent = node && node.kind !== 'gate' ? this.delegate.getAgentForNode(node.id) : undefined;
		const orgConfig = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const tokenStatusRank = (status: IMissionToken['status']): number => {
			switch (status) {
				case 'active': return 0;
				case 'waiting_gate': return 1;
				case 'blocked': return 2;
				case 'queued': return 3;
				case 'frozen_failed': return 4;
				case 'waiting_join': return 5;
				default: return 6;
			}
		};
		const nodeTokens = node && rt
			? Object.values(rt.tokens)
				.filter(t => t.nodeId === node!.id)
				.sort((a, b) => (tokenStatusRank(a.status) - tokenStatusRank(b.status)) || ((b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)))
			: [];
		const primaryToken = nodeTokens.find(t => tokenStatusRank(t.status) < 6) ?? nodeTokens[0];

		// 1. Patch Persistent Header & Segmented Tab Bar IN PLACE (zero teardown)
		if (node) {
			setTextIfChanged(shell.nodeIdBadgeEl, node.id);
			setTextIfChanged(shell.titleEl, node.label);
			if (shell.titleEl.title !== node.label) {
				shell.titleEl.title = node.label;
			}
		} else {
			setTextIfChanged(shell.nodeIdBadgeEl, 'FinOps');
			const ledgerTitle = adeBi(localize('adeMissionNiMissionLedgerTitle', "Mission Ledger"), "任务费用账本");
			setTextIfChanged(shell.titleEl, ledgerTitle);
			shell.titleEl.title = '';
		}
		const nextStateCls = `ade-mission-token-status-badge status-${nodeState.replace(/_/g, '-')}`;
		if (shell.stateBadgeEl.className !== nextStateCls) {
			shell.stateBadgeEl.className = nextStateCls;
		}
		shell.stateBadgeEl.dataset.adeNiState = nodeState;
		setTextIfChanged(shell.stateBadgeEl, formatMissionStateBadgeLabel(nodeState));

		for (const [tabId, btn] of shell.tabBtns.entries()) {
			const isActive = this.activeTab === tabId;
			btn.classList.toggle('active', isActive);
			btn.setAttribute('aria-selected', String(isActive));
		}

		// 2. Structural key: ONLY rebuild body skeleton when switching mission, tab, selected node, or node kind
		const nextTabKey = this.activeTab === 'finops'
			? `${missionId}\x1ffinops`
			: `${missionId}\x1f${this.activeTab}\x1f${node?.id ?? ''}\x1f${node?.kind ?? ''}`;

		if (nextTabKey !== this.renderedTabKey) {
			this.isBudgetSliderDragging = false;
			this.sliderDragDisposables.clear();
			this.tabDisposables.clear();
			this.activeTabHandles = undefined;
			clearNode(shell.bodyScrollEl);
			shell.bodyScrollEl.scrollTop = 0;
			this.renderedTabKey = nextTabKey;

			if (this.activeTab === 'finops') {
				this.activeTabHandles = this.mountFinOpsSkeleton(shell.bodyScrollEl);
			} else if (!node) {
				append(shell.bodyScrollEl, $('.ade-mission-ni-muted-hint', {}, adeBi(
					localize('adeMissionNiPickNodeHint', "Click any node on the Mission Canvas to inspect its state, tokens, and telemetry."),
					"点击画布上的任意节点，即可查看其运行状态、令牌轨迹与遥测指标。",
				)));
			} else if (this.activeTab === 'token') {
				this.activeTabHandles = this.mountTokenSkeleton(shell.bodyScrollEl, node);
			} else if (this.activeTab === 'distill') {
				this.activeTabHandles = this.mountDistillSkeleton(shell.bodyScrollEl, node);
			} else {
				this.activeTabHandles = this.mountOverviewSkeleton(shell.bodyScrollEl, node);
			}
		}

		// 3. Patch Dynamic Telemetry & Runtime Values IN PLACE (preserves form focus, drafts, slider drag & scrollTop)
		const h = this.activeTabHandles;
		if (!h) {
			return;
		}
		if (h.kind === 'finops') {
			this.patchFinOpsTab(h, rt, nodes);
		} else if (node) {
			if (h.kind === 'overview') {
				this.patchOverviewTab(h, missionId, node, nodeState, linkedAgent, orgConfig, rt, nodeTokens, primaryToken);
			} else if (h.kind === 'token') {
				this.patchTokenTab(h, missionId, node, nodeTokens, primaryToken);
			} else if (h.kind === 'distill') {
				this.patchDistillTab(h, missionId, node, rt, primaryToken);
			}
		}
	}

	private ensureShell(): IShellHandles {
		if (this.shell) {
			return this.shell;
		}
		this.shellDisposables.clear();
		clearNode(this.panelEl);

		const head = append(this.panelEl, $('.ade-mission-ni-head'));
		const titleWrap = append(head, $('.ade-mission-ni-title-wrap'));
		const nodeIdBadgeEl = append(titleWrap, $('span.ade-mission-ni-node-id'));
		const titleEl = append(titleWrap, $('span.ade-mission-ni-title'));
		const stateBadgeEl = append(head, $('span.ade-mission-token-status-badge'));
		const closeLabel = adeBi(localize('adeMissionNiClose', "Close Panel"), "关闭面板");
		const closeBtn = append(head, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: closeLabel,
			'aria-label': closeLabel,
			'data-ade-inspector-close': 'true',
		})) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		this.shellDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close(true)));

		const tabBar = append(this.panelEl, $('.ade-mission-ni-tabs', { role: 'tablist' }));
		const tabs: readonly { readonly id: MissionInspectorTab; readonly label: string }[] = [
			{ id: 'overview', label: adeBi(localize('adeMissionNiTabOverview', "Overview"), "概览") },
			{ id: 'token', label: adeBi(localize('adeMissionNiTabToken', "Token & Trace"), "令牌轨迹") },
			{ id: 'distill', label: adeBi(localize('adeMissionNiTabDistill', "Distill & Checks"), "提纯校验") },
			{ id: 'finops', label: adeBi(localize('adeMissionNiTabFinOps', "FinOps Ledger"), "费用账本") },
		];
		const tabBtns = new Map<MissionInspectorTab, HTMLButtonElement>();
		for (const t of tabs) {
			const tabBtn = append(tabBar, $('button.ade-mission-ni-tab', {
				type: 'button',
				role: 'tab',
				'aria-selected': 'false',
				'data-ade-inspector-tab': t.id,
			}, t.label)) as HTMLButtonElement;
			tabBtns.set(t.id, tabBtn);
			this.shellDisposables.add(addDisposableListener(tabBtn, EventType.CLICK, () => {
				if (this.activeTab !== t.id) {
					this.activeTab = t.id;
					this.refresh();
				}
			}));
		}

		const bodyScrollEl = append(this.panelEl, $('.ade-mission-ni-body'));
		this.shell = { nodeIdBadgeEl, titleEl, stateBadgeEl, tabBtns, bodyScrollEl };
		return this.shell;
	}

	private isControlFocused(el: HTMLElement): boolean {
		const activeEl = getWindow(this.panelEl).document.activeElement;
		return activeEl === el;
	}

	// =========================================================================
	// Tab 1: Overview — Static Skeleton + In-Place Telemetry Patcher
	// =========================================================================

	private mountOverviewSkeleton(body: HTMLElement, node: IMissionDagNode): IOverviewTabHandles {
		const chatBarEl = append(body, $('.ade-mission-ni-chat-bar'));
		chatBarEl.hidden = true;

		let splitBtn: HTMLButtonElement | undefined;
		let tabBtn: HTMLButtonElement | undefined;
		let gateBtn: HTMLButtonElement | undefined;

		let supRow: HTMLButtonElement | undefined;
		let supValEl: HTMLElement | undefined;
		let roleRow: HTMLButtonElement | undefined;
		let roleChipEl: HTMLElement | undefined;
		let empRow: HTMLButtonElement | undefined;
		let empValEl: HTMLElement | undefined;
		let hostRow: HTMLButtonElement | undefined;
		let hostValEl: HTMLElement | undefined;
		let modelRow: HTMLButtonElement | undefined;
		let modelValEl: HTMLElement | undefined;
		let engRow: HTMLButtonElement | undefined;
		let engValEl: HTMLElement | undefined;
		let editPromptBtn: HTMLButtonElement | undefined;
		let promptBlockEl: HTMLElement | undefined;

		if (node.kind === 'gate') {
			gateBtn = append(chatBarEl, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				'data-ade-inspector-open-gate': node.id,
			}, adeBi(localize('adeMissionNiReviewGate', "Approve / Reject Gate"), "审批通过 / 驳回"))) as HTMLButtonElement;
		} else {
			splitBtn = append(chatBarEl, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				title: adeBi(localize('adeMissionNiSplitChatTip', "Open Agent chat in a split pane beside the Mission Canvas"), "在任务画布旁分屏打开智能体对话"),
			})) as HTMLButtonElement;
			append(splitBtn, $('span.codicon.codicon-split-horizontal', { 'aria-hidden': 'true' }));
			append(splitBtn, $('span', {}, adeBi(localize('adeMissionNiSplitChat', "Split Chat Beside"), "分屏打开对话")));

			tabBtn = append(chatBarEl, $('button.ade-mission-ni-btn', {
				type: 'button',
				title: adeBi(localize('adeMissionNiOpenTabTip', "Switch directly to Agent chat tab (or double-click node)"), "直接切换至智能体对话标签页（或双击节点）"),
			})) as HTMLButtonElement;
			append(tabBtn, $('span.codicon.codicon-go-to-file', { 'aria-hidden': 'true' }));
			append(tabBtn, $('span', {}, adeBi(localize('adeMissionNiOpenTab', "Open Tab"), "打开标签页")));

			const cfgSection = append(body, $('.ade-mission-ni-section'));
			append(cfgSection, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiConfigTitle', "Node Assignment & Governance"), "节点指派与治理")));
			const cfgGrid = append(cfgSection, $('.ade-mission-ni-kv-list'));

			supRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-sup-btn': node.id,
			})) as HTMLButtonElement;
			append(supRow, $('span.ade-mission-ni-kv-key', {}, adeBi(localize('adeMissionNiSupKey', "Supervisor"), "所属监工")));
			supValEl = append(supRow, $('span.ade-mission-ni-kv-val'));
			append(supRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));

			roleRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-role-btn': node.id,
				title: adeBi(
					localize('adeMissionNiRoleToggleTip', "Click to toggle between Worker (executes task) and Reviewer (in-graph auditor that can reject tokens upstream)"),
					"点击切换执行角色：普通执行者（负责任务落地）或图内审稿员（可打回上游返工）",
				),
			})) as HTMLButtonElement;
			append(roleRow, $('span.ade-mission-ni-kv-key', {}, adeBi(localize('adeMissionNiRoleKey', "Node Role"), "节点角色")));
			const roleVal = append(roleRow, $('span.ade-mission-ni-kv-val'));
			roleChipEl = append(roleVal, $('span.ade-mission-token-meta-chip'));
			append(roleRow, $('span.codicon.codicon-arrow-swap.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));

			empRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-emp-btn': node.id,
			})) as HTMLButtonElement;
			append(empRow, $('span.ade-mission-ni-kv-key', {}, adeBi(localize('adeMissionNiEmpKey', "Employee"), "执行成员")));
			empValEl = append(empRow, $('span.ade-mission-ni-kv-val'));
			append(empRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));

			hostRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-host-btn': node.id,
			})) as HTMLButtonElement;
			append(hostRow, $('span.ade-mission-ni-kv-key', {}, adeBi(localize('adeMissionNiHostKey', "Host"), "运行主机")));
			hostValEl = append(hostRow, $('span.ade-mission-ni-kv-val'));
			append(hostRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));

			modelRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-model-btn': node.id,
			})) as HTMLButtonElement;
			append(modelRow, $('span.ade-mission-ni-kv-key', {}, adeBi(localize('adeMissionNiModelKey', "Model"), "模型配置")));
			modelValEl = append(modelRow, $('span.ade-mission-ni-kv-val'));
			append(modelRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));

			engRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-engine-btn': node.id,
			})) as HTMLButtonElement;
			append(engRow, $('span.ade-mission-ni-kv-key', {}, adeBi(localize('adeMissionNiEngineKey', "Engine / Rank"), "引擎与职级")));
			engValEl = append(engRow, $('span.ade-mission-ni-kv-val'));
			append(engRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));

			const promptSection = append(body, $('.ade-mission-ni-section'));
			const promptHead = append(promptSection, $('.ade-mission-ni-section-head'));
			append(promptHead, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiPromptTitle', "Pre-Prompt"), "节点提示词")));
			editPromptBtn = append(promptHead, $('button.ade-mission-ni-mini-btn', {
				type: 'button',
				'data-ade-inspector-prompt-btn': node.id,
			})) as HTMLButtonElement;
			promptBlockEl = append(promptSection, $('.ade-mission-token-text-block.scrollable'));
		}

		// Source Triggers Section
		const trigSectionEl = append(body, $('.ade-mission-ni-section'));
		trigSectionEl.hidden = true;
		const trigHead = append(trigSectionEl, $('.ade-mission-ni-section-head'));
		const trigTitleEl = append(trigHead, $('.ade-mission-ni-section-title'));
		const manageTrigBtn = append(trigHead, $('button.ade-mission-ni-mini-btn', {
			type: 'button',
			'data-ade-inspector-triggers-btn': node.id,
		}, adeBi(localize('adeMissionNiManageTriggers', "Manage"), "管理"))) as HTMLButtonElement;
		const trigEmptyHintEl = append(trigSectionEl, $('.ade-mission-ni-muted-hint', {}, adeBi(localize('adeMissionNiNoTriggers', "No automated schedule or event triggers attached yet."), "尚未挂载定时或事件触发器。")));
		const trigChipsEl = append(trigSectionEl, $('.ade-mission-ni-trigger-chips'));

		// Live Runtime & Quick Actions Section
		const runtimeSection = append(body, $('.ade-mission-ni-section'));
		const rtHead = append(runtimeSection, $('.ade-mission-ni-section-head'));
		append(rtHead, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiRuntimeTitle', "Runtime & Quick Actions"), "运行状态与快捷操作")));
		const inspectTokBtn = append(rtHead, $('button.ade-mission-ni-mini-btn', {
			type: 'button',
		}, adeBi(localize('adeMissionNiInspectToken', "Token & Trace →"), "令牌与轨迹 →"))) as HTMLButtonElement;
		inspectTokBtn.hidden = true;

		const telemetryLineEl = append(runtimeSection, $('.ade-mission-ni-telemetry-line'));
		telemetryLineEl.hidden = true;

		const tokenMetaRowEl = append(runtimeSection, $('.ade-mission-token-meta-row'));
		tokenMetaRowEl.hidden = true;
		const waveChipEl = append(tokenMetaRowEl, $('span.ade-mission-token-meta-chip.wave'));
		const blockedChipEl = append(tokenMetaRowEl, $('span.ade-mission-token-meta-chip.warn'));
		blockedChipEl.hidden = true;

		const tokenSummaryEl = append(runtimeSection, $('.ade-mission-token-text-block.scrollable'));
		tokenSummaryEl.hidden = true;

		const actRowEl = append(runtimeSection, $('.ade-mission-token-actions'));
		actRowEl.hidden = true;
		const retryBtn = append(actRowEl, $('button.ade-mission-token-action-btn.primary', {
			type: 'button',
			'data-ade-ni-retry': node.id,
		}, adeBi(localize('adeMissionNiRetry', "Retry Node"), "重试节点"))) as HTMLButtonElement;
		retryBtn.hidden = true;
		let distillShortcutBtn: HTMLButtonElement | undefined;
		if (node.kind !== 'gate') {
			distillShortcutBtn = append(actRowEl, $('button.ade-mission-token-action-btn', {
				type: 'button',
				'data-ade-ni-distill-tab-shortcut': node.id,
			}, adeBi(localize('adeMissionNiDistillShortcut', "Distill & Refresh"), "提纯换血"))) as HTMLButtonElement;
		}
		const recallBtn = append(actRowEl, $('button.ade-mission-token-action-btn.danger', {
			type: 'button',
			'data-ade-ni-recall': node.id,
		}, adeBi(localize('adeMissionNiRecall', "Recall"), "撤回"))) as HTMLButtonElement;
		recallBtn.hidden = true;

		const noLiveTokenHintEl = append(runtimeSection, $('.ade-mission-ni-muted-hint', {}, adeBi(localize('adeMissionNiNoLiveToken', "No token has visited this node yet."), "尚未有令牌流经该节点。")));

		const handle: IOverviewTabHandles = {
			kind: 'overview',
			node,
			linkedAgent: undefined,
			engineId: this.delegate.getFallbackOwnerEngineId(),
			currentHostAlias: 'local',
			currentRoleKind: 'worker',
			primaryToken: undefined,
			failedToken: undefined,
			chatBarEl,
			splitBtn,
			tabBtn,
			gateBtn,
			supRow,
			supValEl,
			lastSupSignature: '',
			roleRow,
			roleChipEl,
			empRow,
			empValEl,
			lastEmpSignature: '',
			hostRow,
			hostValEl,
			modelRow,
			modelValEl,
			engRow,
			engValEl,
			editPromptBtn,
			promptBlockEl,
			trigSectionEl,
			trigTitleEl,
			trigEmptyHintEl,
			trigChipsEl,
			lastTrigSignature: '',
			inspectTokBtn,
			telemetryLineEl,
			tokenMetaRowEl,
			waveChipEl,
			blockedChipEl,
			tokenSummaryEl,
			actRowEl,
			retryBtn,
			distillShortcutBtn,
			recallBtn,
			noLiveTokenHintEl,
		};

		if (splitBtn) {
			this.tabDisposables.add(addDisposableListener(splitBtn, EventType.CLICK, () => {
				if (handle.linkedAgent) {
					this.delegate.onOpenAgentBeside(handle.linkedAgent.id);
				}
			}));
		}
		if (tabBtn) {
			this.tabDisposables.add(addDisposableListener(tabBtn, EventType.CLICK, () => {
				if (handle.linkedAgent) {
					this.delegate.onOpenAgentTab(handle.linkedAgent.id);
				}
			}));
		}
		if (gateBtn) {
			this.tabDisposables.add(addDisposableListener(gateBtn, EventType.CLICK, () => {
				this.delegate.onOpenGateDecisionPopover(handle.node, gateBtn);
			}));
		}
		if (supRow) {
			this.tabDisposables.add(addDisposableListener(supRow, EventType.CLICK, () => {
				this.delegate.onOpenSupervisorPopover(handle.node, supRow);
			}));
		}
		if (roleRow) {
			this.tabDisposables.add(addDisposableListener(roleRow, EventType.CLICK, () => {
				const nextRole: MissionNodeRoleKind = handle.currentRoleKind === 'reviewer' ? 'worker' : 'reviewer';
				this.delegate.onToggleNodeRoleKind?.(handle.node, nextRole);
			}));
		}
		if (empRow) {
			this.tabDisposables.add(addDisposableListener(empRow, EventType.CLICK, () => {
				this.delegate.onOpenEmployeePopover(handle.node, empRow);
			}));
		}
		if (hostRow) {
			this.tabDisposables.add(addDisposableListener(hostRow, EventType.CLICK, () => {
				this.delegate.onOpenHostPopover(handle.node, handle.currentHostAlias, hostRow);
			}));
		}
		if (modelRow) {
			this.tabDisposables.add(addDisposableListener(modelRow, EventType.CLICK, () => {
				if (handle.linkedAgent) {
					this.delegate.onOpenModelPopover(handle.node.id, handle.linkedAgent, handle.engineId, modelRow);
				}
			}));
		}
		if (engRow) {
			this.tabDisposables.add(addDisposableListener(engRow, EventType.CLICK, () => {
				if (handle.linkedAgent && this.delegate.canSwitchAgentEngine(handle.linkedAgent)) {
					this.delegate.onOpenEnginePopover(handle.node.id, handle.linkedAgent, handle.engineId, engRow);
				}
			}));
		}
		if (editPromptBtn) {
			this.tabDisposables.add(addDisposableListener(editPromptBtn, EventType.CLICK, () => {
				this.delegate.onOpenNodePromptPopover(handle.node, editPromptBtn);
			}));
		}
		this.tabDisposables.add(addDisposableListener(manageTrigBtn, EventType.CLICK, () => {
			this.delegate.onOpenTriggersPopover(handle.node.id, manageTrigBtn);
		}));
		this.tabDisposables.add(addDisposableListener(inspectTokBtn, EventType.CLICK, () => {
			this.activeTab = 'token';
			this.refresh();
		}));
		this.tabDisposables.add(addDisposableListener(retryBtn, EventType.CLICK, () => {
			if (handle.failedToken) {
				this.delegate.onQuickRetryNode(handle.node, handle.failedToken);
			}
		}));
		if (distillShortcutBtn) {
			this.tabDisposables.add(addDisposableListener(distillShortcutBtn, EventType.CLICK, () => {
				this.activeTab = 'distill';
				this.refresh();
			}));
		}
		this.tabDisposables.add(addDisposableListener(recallBtn, EventType.CLICK, () => {
			this.delegate.onQuickRecallNode(handle.node, handle.primaryToken);
		}));

		return handle;
	}

	private patchOverviewTab(
		h: IOverviewTabHandles,
		missionId: string,
		node: IMissionDagNode,
		nodeState: string,
		linkedAgent: IAdeAgent | undefined,
		orgConfig: ReturnType<IAdeRoleSchemaService['getConfig']>,
		rt: IMissionRuntimeState | undefined,
		nodeTokens: readonly IMissionToken[],
		primaryToken: IMissionToken | undefined,
	): void {
		h.node = node;
		h.linkedAgent = linkedAgent;
		h.primaryToken = primaryToken;
		const failedTok = nodeTokens.find(t => t.status === 'frozen_failed');
		h.failedToken = failedTok;

		if (node.kind === 'gate') {
			h.chatBarEl.hidden = nodeState !== 'waiting_gate';
		} else {
			h.chatBarEl.hidden = !linkedAgent;
			if (linkedAgent && h.splitBtn && h.tabBtn) {
				h.splitBtn.setAttribute('data-ade-inspector-open-beside', linkedAgent.id);
				h.tabBtn.setAttribute('data-ade-inspector-open-tab', linkedAgent.id);
			}

			// Supervisor
			const boundSup = rt?.boundary.supervisors.find(s => s.managedNodeIds.includes(node.id));
			const supInfo = boundSup ? this.delegate.resolveSupervisorDisplay(boundSup.id) : undefined;
			const parentSupInfo = boundSup?.parentSupervisorId ? this.delegate.resolveSupervisorDisplay(boundSup.parentSupervisorId) : undefined;
			const supSig = boundSup && supInfo
				? `b:${boundSup.id}:${boundSup.tier}:${supInfo.label}:${parentSupInfo?.shortLabel ?? ''}`
				: 'auto';
			if (h.supValEl && h.lastSupSignature !== supSig) {
				h.lastSupSignature = supSig;
				clearNode(h.supValEl);
				if (boundSup && supInfo) {
					append(h.supValEl, $(`span.ade-mission-sup-dot.sup-color-${getMissionSupervisorColorIndex(boundSup.id)}`, { 'aria-hidden': 'true' }));
					const supText = parentSupInfo
						? `${supInfo.label} (${formatTierTag(boundSup.tier)}) ↑ ${parentSupInfo.shortLabel}`
						: `${supInfo.label} (${formatTierTag(boundSup.tier)})`;
					append(h.supValEl, $('span', {}, supText));
				} else {
					append(h.supValEl, $('span.is-muted', {}, adeBi(localize('adeMissionNiSupAuto', "Auto (Mission Owner)"), "自动（任务负责人）")));
				}
			}

			// Role
			const currentRoleKind: MissionNodeRoleKind = rt?.boundary.nodeAssignments[node.id]?.roleKind ?? 'worker';
			h.currentRoleKind = currentRoleKind;
			if (h.roleRow && h.roleChipEl) {
				h.roleRow.setAttribute('data-node-role-kind', currentRoleKind);
				const roleCls = `ade-mission-token-meta-chip${currentRoleKind === 'reviewer' ? ' wave' : ''}`;
				if (h.roleChipEl.className !== roleCls) {
					h.roleChipEl.className = roleCls;
				}
				setTextIfChanged(
					h.roleChipEl,
					currentRoleKind === 'reviewer'
						? adeBi(localize('adeMissionNiRoleReviewer', "Reviewer · In-Graph Audit"), "审稿员 · 图内审计")
						: adeBi(localize('adeMissionNiRoleWorker', "Worker · Executor"), "执行者 · 任务节点"),
				);
			}

			// Employee
			const empSig = node.employeeName
				? `e:${node.employeeName}:${node.employeeOccurrence ?? 0}:${node.employeeTotalOccurrences ?? 0}`
				: 'standalone';
			if (h.empValEl && h.lastEmpSignature !== empSig) {
				h.lastEmpSignature = empSig;
				clearNode(h.empValEl);
				if (node.employeeName) {
					const seq = (node.employeeTotalOccurrences ?? 0) > 1
						? ` (#${node.employeeOccurrence}/${node.employeeTotalOccurrences})`
						: '';
					append(h.empValEl, $('span', {}, `${node.employeeName}${seq}`));
				} else {
					append(h.empValEl, $('span.is-muted', {}, adeBi(localize('adeMissionNiEmpStandalone', "Standalone Step"), "独立步骤")));
				}
			}

			// Host
			const explicitHost = rt?.boundary.nodeAssignments[node.id]?.hostAlias;
			const hostInfo = this.hostCatalog.resolveNodeHostAndOs(explicitHost, linkedAgent);
			h.currentHostAlias = hostInfo.hostAlias;
			if (h.hostValEl) {
				setTextIfChanged(
					h.hostValEl,
					hostInfo.isRemote
						? `${hostInfo.displayHost} (${hostInfo.osLabel})`
						: adeBi(localize('adeMissionNiLocalHost', "Local · {0}", hostInfo.osLabel), "本机 · {0}", hostInfo.osLabel),
				);
			}

			// Model / Engine / Rank
			const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? this.delegate.getFallbackOwnerEngineId();
			h.engineId = engineId;
			const engineName = this.hostCatalog.getEngineDisplayName(engineId);
			const nodeTelemetry = rt?.nodeTelemetry?.[node.id];
			const resolvedModel = linkedAgent?.preferredModel || nodeTelemetry?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineId;
			const resolvedThinking = linkedAgent?.preferredThinking ?? 'medium';
			const rankDef = resolveEffectiveRankDefinition(orgConfig, linkedAgent?.role, linkedAgent ? (this.projectsService?.hasSubordinates(linkedAgent.id) ?? false) : false);
			const assignedTier = rt?.boundary.nodeAssignments[node.id]?.tier ?? rankDef.tier;

			if (h.modelRow && h.modelValEl) {
				setTextIfChanged(h.modelValEl, `${resolvedModel} · ${resolvedThinking}`);
				h.modelRow.disabled = !linkedAgent;
			}
			if (h.engRow && h.engValEl) {
				setTextIfChanged(h.engValEl, `${engineName} · ${formatTierTag(assignedTier)} ${rankDef.name}`);
				h.engRow.disabled = !(linkedAgent && this.delegate.canSwitchAgentEngine(linkedAgent));
			}

			// Pre-Prompt
			const promptText = this.delegate.getNodePrompt(missionId, node.id).trim();
			if (h.editPromptBtn) {
				setTextIfChanged(
					h.editPromptBtn,
					promptText
						? adeBi(localize('adeMissionNiEditBtn', "Edit"), "编辑")
						: adeBi(localize('adeMissionNiAddBtn', "+ Add"), "+ 添加"),
				);
			}
			if (h.promptBlockEl) {
				setTextIfChanged(h.promptBlockEl, promptText || adeBi(localize('adeMissionNiNoPrompt', "No pre-prompt configured for this node."), "该节点尚未配置提示词。"));
			}
		}

		// Source Triggers
		const edges = this.delegate.getEdges();
		const inDegree = edges.filter(e => e.to === node.id).length;
		const outDegree = edges.filter(e => e.from === node.id).length;
		const isEntryNode = inDegree === 0 && outDegree >= 1;
		h.trigSectionEl.hidden = !isEntryNode;
		if (isEntryNode) {
			const nodeTriggers = (rt?.triggers ?? []).filter(t => t.nodeId === node.id);
			setTextIfChanged(h.trigTitleEl, adeBi(localize('adeMissionNiTriggersTitle', "Source Triggers ({0})", nodeTriggers.length), "自动触发器 ({0})", nodeTriggers.length));
			h.trigEmptyHintEl.hidden = nodeTriggers.length > 0;
			h.trigChipsEl.hidden = nodeTriggers.length === 0;
			const trigSig = nodeTriggers.map(t => `${t.id}:${t.enabled ? 1 : 0}:${formatMissionTriggerShortLabel(t)}`).join('|');
			if (h.lastTrigSignature !== trigSig) {
				h.lastTrigSignature = trigSig;
				clearNode(h.trigChipsEl);
				const offSuffix = adeBi(localize('adeMissionNiTriggerOff', " (off)"), "（已停用）");
				for (const trig of nodeTriggers) {
					append(h.trigChipsEl, $(`span.ade-mission-token-meta-chip${trig.enabled ? '.wave' : ''}`, {}, `${formatMissionTriggerShortLabel(trig)}${trig.enabled ? '' : offSuffix}`));
				}
			}
		}

		// Runtime & Telemetry
		const telemetry = rt?.nodeTelemetry?.[node.id];
		if (telemetry) {
			const telEngineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? this.delegate.getFallbackOwnerEngineId();
			const telModel = linkedAgent?.preferredModel || telemetry.model || MISSION_ENGINE_DEFAULT_MODELS[telEngineId] || telEngineId;
			const ctx = computeMissionNodeContextBreakdown(telemetry, inferModelContextWindowTokens(telModel, { engineId: telEngineId }));
			h.telemetryLineEl.hidden = false;
			const costSuffix = telemetry.costUsd > 0
				? ` · ${formatFinOpsUsd(telemetry.costUsd, { estimated: telemetry.costEstimated })}${telemetry.costEstimated ? adeBi(localize('adeMissionNiTelemetryEstTag', " (est.)"), " (预估)") : ''}`
				: (telemetry.costLocalFree ? ` · ${adeBi(localize('adeMissionNiTelemetryLocalFree', "Local $0.00"), "本机 $0.00")}` : '');
			setTextIfChanged(h.telemetryLineEl, adeBi(
				localize(
					'adeMissionNiTelemetryLine',
					"Context: {0}/{1} ({2}%) · Turns: {3}{4}",
					formatCompactTokenCount(ctx.usedTokens),
					formatCompactTokenCount(ctx.maxTokens),
					ctx.usedPct,
					telemetry.turns,
					costSuffix,
				),
				"上下文：{0}/{1} ({2}%) · 轮次：{3}{4}",
				formatCompactTokenCount(ctx.usedTokens),
				formatCompactTokenCount(ctx.maxTokens),
				ctx.usedPct,
				telemetry.turns,
				costSuffix,
			));
		} else {
			h.telemetryLineEl.hidden = true;
		}

		if (primaryToken) {
			h.inspectTokBtn.hidden = false;
			h.inspectTokBtn.setAttribute('data-ade-inspector-token-btn', primaryToken.id);
			h.tokenMetaRowEl.hidden = false;
			setTextIfChanged(h.waveChipEl, `${formatMissionWaveTag(primaryToken.waveId)} · ${formatMissionStateBadgeLabel(primaryToken.status)}`);
			if (primaryToken.blocked) {
				const rem = formatMissionBlockedRemaining(primaryToken.blocked.expiresAt, Date.now());
				setTextIfChanged(h.blockedChipEl, `⏳ ${rem.text}`);
				h.blockedChipEl.hidden = false;
			} else if (primaryToken.status === 'queued' && primaryToken.queued) {
				const qLabel = primaryToken.queued.blockedBy === 'employee'
					? (node.employeeName ? `@${node.employeeName}` : primaryToken.queued.scopeKey)
					: primaryToken.queued.scopeKey;
				setTextIfChanged(h.blockedChipEl, `⏱ #${primaryToken.queued.position}/${primaryToken.queued.totalQueued} · ${qLabel} (${primaryToken.queued.activeSlots}/${primaryToken.queued.maxSlots})`);
				h.blockedChipEl.hidden = false;
			} else {
				h.blockedChipEl.hidden = true;
			}
			h.tokenSummaryEl.hidden = false;
			setTextIfChanged(
				h.tokenSummaryEl,
				primaryToken.status === 'queued' && primaryToken.queued
					? (primaryToken.queued.blockedBy === 'employee'
						? adeBi(
							localize(
								'adeMissionNiQueuedEmpSummary',
								"Exclusive Queue #{0}/{1} — waiting for {2} to finish its active/blocked step to prevent parallel context contamination.",
								primaryToken.queued.position,
								primaryToken.queued.totalQueued,
								node.employeeName ? `@${node.employeeName}` : primaryToken.queued.scopeKey,
							),
							'员工排他排队第 {0}/{1} 位 — 等待 {2} 完成当前进行/阻塞节点，防止并行会话上下文串台。',
							primaryToken.queued.position,
							primaryToken.queued.totalQueued,
							node.employeeName ? `@${node.employeeName}` : primaryToken.queued.scopeKey,
						)
						: adeBi(
							localize('adeMissionNiQueuedSummary', "Queued #{0}/{1} — waiting for free concurrency slot on {2} ({3}/{4} active).", primaryToken.queued.position, primaryToken.queued.totalQueued, primaryToken.queued.scopeKey, primaryToken.queued.activeSlots, primaryToken.queued.maxSlots),
							'并发排队第 {0}/{1} 位 — 等待 {2} 空闲槽位（当前 {3}/{4} 占用）。',
							primaryToken.queued.position,
							primaryToken.queued.totalQueued,
							primaryToken.queued.scopeKey,
							primaryToken.queued.activeSlots,
							primaryToken.queued.maxSlots,
						))
					: (primaryToken.failure?.reason || primaryToken.lastSummary?.trim() || adeBi(localize('adeMissionNiNoTokenSummary', "Token is active; awaiting step summary."), '令牌运行中，等待汇报阶段总结。')),
			);

			const canRecall = primaryToken.status === 'active' || primaryToken.status === 'queued' || primaryToken.status === 'blocked' || primaryToken.status === 'waiting_gate' || primaryToken.status === 'frozen_failed';
			h.retryBtn.hidden = !failedTok;
			h.recallBtn.hidden = !canRecall;
			h.actRowEl.hidden = !failedTok && !canRecall && !h.distillShortcutBtn;
			h.noLiveTokenHintEl.hidden = true;
		} else {
			h.inspectTokBtn.hidden = true;
			h.tokenMetaRowEl.hidden = true;
			h.tokenSummaryEl.hidden = true;
			h.actRowEl.hidden = true;
			h.noLiveTokenHintEl.hidden = false;
		}
	}

	// =========================================================================
	// Tab 2: Token & Trace — Static Retry Form + In-Place Telemetry Patcher
	// =========================================================================

	private mountTokenSkeleton(body: HTMLElement, node: IMissionDagNode): ITokenTabHandles {
		const emptyHintEl = append(body, $('.ade-mission-ni-muted-hint', {}, adeBi(
			localize('adeMissionNiTokenEmpty', "No tokens recorded on node {0} yet. Start the Mission to inspect live token summaries & trace pointers.", node.id),
			"节点 {0} 尚无令牌流转记录。启动任务后可实时查看令牌总结与轨迹指针。",
			node.id,
		)));
		emptyHintEl.hidden = true;

		const contentWrapEl = append(body, $('.ade-mission-ni-tab-wrap'));
		contentWrapEl.hidden = true;

		const waveSwitcherEl = append(contentWrapEl, $('.ade-mission-token-wave-switcher'));
		waveSwitcherEl.hidden = true;
		const waveDisposables = this.tabDisposables.add(new DisposableStore());

		const metaRowEl = append(contentWrapEl, $('.ade-mission-token-meta-row'));

		const blockedBoxEl = append(contentWrapEl, $('.ade-mission-token-box.is-blocked'));
		blockedBoxEl.hidden = true;
		const bHead = append(blockedBoxEl, $('.ade-mission-token-box-head'));
		append(bHead, $('span.ade-mission-token-box-label', {}, adeBi(localize('adeMissionNiBlockedHead', "Blocked Wait"), "阻塞等待中")));
		const blockedCountdownEl = append(bHead, $('span.ade-mission-token-countdown'));
		const blockedReasonEl = append(blockedBoxEl, $('.ade-mission-token-box-body'));
		const blockedWatchRowEl = append(blockedBoxEl, $('.ade-mission-token-watch-row'));

		const failedBoxEl = append(contentWrapEl, $('.ade-mission-token-box.is-failed'));
		failedBoxEl.hidden = true;
		append(failedBoxEl, $('.ade-mission-token-box-label', {}, adeBi(localize('adeMissionNiFailHead', "Failure & Escalation"), "失败与升级")));
		const failedReasonEl = append(failedBoxEl, $('.ade-mission-token-box-body'));

		// Layer 1: Verbatim lastSummary
		const s1 = append(contentWrapEl, $('.ade-mission-ni-section'));
		append(s1, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiLastSummaryLabel', "Last Step Summary"), "紧邻上一棒人话总结")));
		const lastSummaryEl = append(s1, $('.ade-mission-token-text-block.scrollable', {
			'data-ade-ni-last-summary': 'true',
		}));

		// Layer 2: Rolling compressedHistory
		const s2 = append(contentWrapEl, $('.ade-mission-ni-section'));
		const s2Head = append(s2, $('.ade-mission-ni-section-head'));
		append(s2Head, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiHistoryLabel', "Rolling Compressed History"), "滚动压缩历史")));
		const archivedChipEl = append(s2Head, $('span.ade-mission-token-meta-chip'));
		archivedChipEl.hidden = true;
		const compressedHistoryEl = append(s2, $('.ade-mission-token-text-block.scrollable', {
			'data-ade-ni-compressed-history': 'true',
		}));

		// Lazy trace_ptr expansion
		const s3 = append(contentWrapEl, $('.ade-mission-ni-section'));
		const s3Head = append(s3, $('.ade-mission-ni-section-head'));
		const traceTitleEl = append(s3Head, $('.ade-mission-ni-section-title'));
		const expandTraceBtn = append(s3Head, $('button.ade-mission-token-trace-btn', {
			type: 'button',
			'data-ade-ni-expand-trace': 'true',
		})) as HTMLButtonElement;
		const traceListEl = append(s3, $('.ade-mission-token-trace-list', {
			'data-ade-ni-trace-list': 'true',
		}));
		traceListEl.hidden = true;

		// Static Guided Retry Input & Action Buttons (NEVER destroyed during 1Hz telemetry ticks)
		const guidanceInput = append(contentWrapEl, $('input.ade-mission-emp-popover-input', {
			type: 'text',
			placeholder: adeBi(localize('adeMissionNiRetryGuidancePh', "Optional retry guidance..."), "可选：填写指导重试说明..."),
			'data-ade-ni-retry-guidance': 'true',
		})) as HTMLInputElement;
		guidanceInput.value = this.retryGuidanceDraftByNode.get(node.id) ?? '';
		guidanceInput.hidden = true;

		const actRowEl = append(contentWrapEl, $('.ade-mission-token-actions'));
		actRowEl.hidden = true;
		const retryBtn = append(actRowEl, $('button.ade-mission-token-action-btn.primary', {
			type: 'button',
		}, adeBi(localize('adeMissionNiTokenRetry', "Retry Node"), "重试节点"))) as HTMLButtonElement;
		retryBtn.hidden = true;
		const recallBtn = append(actRowEl, $('button.ade-mission-token-action-btn.danger', {
			type: 'button',
		}, adeBi(localize('adeMissionNiTokenRecall', "Recall"), "撤回"))) as HTMLButtonElement;
		recallBtn.hidden = true;

		const handle: ITokenTabHandles = {
			kind: 'token',
			node,
			selectedToken: undefined,
			emptyHintEl,
			contentWrapEl,
			waveSwitcherEl,
			waveDisposables,
			lastWaveSignature: '',
			metaRowEl,
			lastMetaSignature: '',
			blockedBoxEl,
			blockedCountdownEl,
			blockedReasonEl,
			blockedWatchRowEl,
			lastBlockedWatchSignature: '',
			failedBoxEl,
			failedReasonEl,
			lastSummaryEl,
			archivedChipEl,
			compressedHistoryEl,
			traceTitleEl,
			expandTraceBtn,
			traceListEl,
			lastTraceSignature: '',
			guidanceInput,
			actRowEl,
			retryBtn,
			recallBtn,
		};

		this.tabDisposables.add(addDisposableListener(guidanceInput, EventType.INPUT, () => {
			if (guidanceInput.value) {
				this.retryGuidanceDraftByNode.set(handle.node.id, guidanceInput.value);
			} else {
				this.retryGuidanceDraftByNode.delete(handle.node.id);
			}
		}));
		this.tabDisposables.add(addDisposableListener(guidanceInput, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
		}));
		this.tabDisposables.add(addDisposableListener(expandTraceBtn, EventType.CLICK, () => {
			const tok = handle.selectedToken;
			if (!tok) {
				return;
			}
			if (this.expandedTraceTokenIds.has(tok.id)) {
				this.expandedTraceTokenIds.delete(tok.id);
			} else {
				this.expandedTraceTokenIds.add(tok.id);
			}
			this.refresh();
		}));
		this.tabDisposables.add(addDisposableListener(retryBtn, EventType.CLICK, () => {
			const tok = handle.selectedToken;
			if (!tok) {
				return;
			}
			const guidance = guidanceInput.value.trim() || undefined;
			guidanceInput.value = '';
			this.retryGuidanceDraftByNode.delete(handle.node.id);
			this.delegate.onQuickRetryNode(handle.node, tok, guidance);
		}));
		this.tabDisposables.add(addDisposableListener(recallBtn, EventType.CLICK, () => {
			if (handle.selectedToken) {
				this.delegate.onQuickRecallNode(handle.node, handle.selectedToken);
			}
		}));

		return handle;
	}

	private patchTokenTab(
		h: ITokenTabHandles,
		missionId: string,
		node: IMissionDagNode,
		nodeTokens: readonly IMissionToken[],
		primaryToken: IMissionToken | undefined,
	): void {
		h.node = node;
		if (!primaryToken || nodeTokens.length === 0) {
			h.selectedToken = undefined;
			h.emptyHintEl.hidden = false;
			h.contentWrapEl.hidden = true;
			return;
		}
		h.emptyHintEl.hidden = true;
		h.contentWrapEl.hidden = false;

		const rememberedId = this.selectedTokenIdByNode.get(node.id);
		const selectedToken = nodeTokens.find(t => t.id === rememberedId) ?? primaryToken;
		h.selectedToken = selectedToken;

		// Wave switcher (rebuilt only when wave list or selection changes)
		h.waveSwitcherEl.hidden = nodeTokens.length <= 1;
		if (nodeTokens.length > 1) {
			const waveSig = nodeTokens.map(t => `${t.id}:${t.waveId}:${t.status}:${t.id === selectedToken.id ? 1 : 0}`).join('|');
			if (h.lastWaveSignature !== waveSig) {
				h.lastWaveSignature = waveSig;
				h.waveDisposables.clear();
				clearNode(h.waveSwitcherEl);
				for (const tok of nodeTokens) {
					const active = tok.id === selectedToken.id;
					const btn = append(h.waveSwitcherEl, $(`button.ade-mission-token-wave-btn${active ? '.active' : ''}`, {
						type: 'button',
						'data-ade-ni-wave-select': tok.id,
					}, `${formatMissionWaveTag(tok.waveId)} · ${formatMissionStateBadgeLabel(tok.status)}`)) as HTMLButtonElement;
					h.waveDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
						this.selectedTokenIdByNode.set(node.id, tok.id);
						this.refresh();
					}));
				}
			}
		}

		// Metadata chips
		const metaSig = `${selectedToken.id}|${selectedToken.waveId}|${selectedToken.fromNodeId ?? ''}|${selectedToken.returnToNodeId ?? ''}|${selectedToken.nudgeCount}`;
		if (h.lastMetaSignature !== metaSig) {
			h.lastMetaSignature = metaSig;
			clearNode(h.metaRowEl);
			append(h.metaRowEl, $('span.ade-mission-token-meta-chip', {}, selectedToken.id));
			append(h.metaRowEl, $('span.ade-mission-token-meta-chip.wave', {}, selectedToken.waveId));
			if (selectedToken.fromNodeId) {
				append(h.metaRowEl, $('span.ade-mission-token-meta-chip', {}, `← ${selectedToken.fromNodeId}`));
			}
			if (selectedToken.returnToNodeId) {
				append(h.metaRowEl, $('span.ade-mission-token-meta-chip.rework', {}, `↩ ${selectedToken.returnToNodeId}`));
			}
			if (selectedToken.nudgeCount > 0) {
				append(h.metaRowEl, $('span.ade-mission-token-meta-chip.warn', {}, adeBi(localize('adeMissionNiNudgesCount', "Nudges {0}", selectedToken.nudgeCount), "催办 {0} 次", selectedToken.nudgeCount)));
			}
		}

		// Blocked wait telemetry (countdown patched in place!)
		if (selectedToken.status === 'blocked' && selectedToken.blocked) {
			const b = selectedToken.blocked;
			const rem = formatMissionBlockedRemaining(b.expiresAt, Date.now());
			h.blockedBoxEl.hidden = false;
			setTextIfChanged(h.blockedCountdownEl, `⏳ ${rem.text}`);
			setTextIfChanged(h.blockedReasonEl, b.reason);
			const watchSig = `${b.watchPid ?? ''}|${b.watchFile ?? ''}|${b.hostAlias ?? ''}`;
			if (h.lastBlockedWatchSignature !== watchSig) {
				h.lastBlockedWatchSignature = watchSig;
				clearNode(h.blockedWatchRowEl);
				if (b.watchPid !== undefined) {
					append(h.blockedWatchRowEl, $('span.ade-mission-token-meta-chip', {}, `PID ${b.watchPid}`));
				}
				if (b.watchFile) {
					append(h.blockedWatchRowEl, $('span.ade-mission-token-meta-chip', { title: b.watchFile }, b.watchFile));
				}
				if (b.hostAlias) {
					append(h.blockedWatchRowEl, $('span.ade-mission-token-meta-chip', {}, `@${b.hostAlias}`));
				}
			}
		} else {
			h.blockedBoxEl.hidden = true;
		}

		// Failure box
		if (selectedToken.failure) {
			h.failedBoxEl.hidden = false;
			setTextIfChanged(h.failedReasonEl, selectedToken.failure.reason);
		} else {
			h.failedBoxEl.hidden = true;
		}

		// Dual-layer summaries (patched in place only when text actually changes)
		setTextIfChanged(h.lastSummaryEl, selectedToken.lastSummary?.trim() || adeBi(localize('adeMissionNiEmptySummary', "No step summary reported yet."), "尚未汇报本棒阶段总结。"));
		const archivedCount = selectedToken.historyState?.archivedCount ?? 0;
		if (archivedCount > 0) {
			h.archivedChipEl.hidden = false;
			setTextIfChanged(h.archivedChipEl, adeBi(localize('adeMissionNiArchivedHops', "{0} archived", archivedCount), "已归档 {0} 跳", archivedCount));
		} else {
			h.archivedChipEl.hidden = true;
		}
		setTextIfChanged(h.compressedHistoryEl, selectedToken.compressedHistory?.trim() || adeBi(localize('adeMissionNiEmptyHistory', "Entry wave — no prior compressed history."), "入口首棒，尚无历史压缩记录。"));

		// Trace expansion (only rebuild rows when expanded state or trace entries change)
		setTextIfChanged(h.traceTitleEl, adeBi(localize('adeMissionNiTraceHead', "Trace · {0}", selectedToken.tracePtr), "轨迹指针 · {0}", selectedToken.tracePtr));
		const isExpanded = this.expandedTraceTokenIds.has(selectedToken.id);
		setTextIfChanged(
			h.expandTraceBtn,
			isExpanded
				? adeBi(localize('adeMissionNiHideTrace', "Hide Trace"), "收起轨迹")
				: adeBi(localize('adeMissionNiExpandTrace', "Expand Trace"), "展开轨迹"),
		);
		h.traceListEl.hidden = !isExpanded;
		if (isExpanded) {
			const entries = this.missionRuntimeService?.expandTrace(missionId, selectedToken.tracePtr, 50) ?? [];
			const traceSig = `${selectedToken.tracePtr}|${entries.length}|${entries.map(e => `${e.event}:${e.nodeId}:${e.summary ?? ''}`).join('\x1f')}`;
			if (h.lastTraceSignature !== traceSig) {
				h.lastTraceSignature = traceSig;
				clearNode(h.traceListEl);
				if (entries.length === 0) {
					append(h.traceListEl, $('.ade-mission-token-trace-empty', {}, adeBi(localize('adeMissionNiTraceNone', "No trace entries found."), "暂无轨迹记录。")));
				} else {
					for (const entry of entries) {
						const row = append(h.traceListEl, $('.ade-mission-token-trace-row', {
							'data-trace-event': entry.event,
						}));
						append(row, $(`span.ade-mission-trace-event.evt-${entry.event.replace(/_/g, '-')}`, {}, entry.event));
						append(row, $('span.ade-mission-trace-node', {}, entry.nodeId));
						if (entry.summary) {
							append(row, $('span.ade-mission-trace-summary', { title: entry.summary }, entry.summary));
						}
					}
				}
			}
		} else {
			h.lastTraceSignature = '';
		}

		// Retry / Recall action visibility (NEVER hide or overwrite guidanceInput while focused!)
		const canRetry = selectedToken.status === 'frozen_failed' || selectedToken.status === 'recalled';
		const canRecall = selectedToken.status === 'active' || selectedToken.status === 'queued' || selectedToken.status === 'blocked' || selectedToken.status === 'waiting_gate' || selectedToken.status === 'waiting_join' || selectedToken.status === 'frozen_failed';
		if (!this.isControlFocused(h.guidanceInput)) {
			h.guidanceInput.hidden = !canRetry;
		}
		h.retryBtn.hidden = !canRetry;
		h.retryBtn.setAttribute('data-ade-ni-token-retry', selectedToken.id);
		h.recallBtn.hidden = !canRecall;
		h.recallBtn.setAttribute('data-ade-ni-token-recall', selectedToken.id);
		h.actRowEl.hidden = !canRetry && !canRecall;
	}

	// =========================================================================
	// Tab 3: Distill & Verification Hooks — Static Forms + In-Place Telemetry
	// =========================================================================

	private mountDistillSkeleton(body: HTMLElement, node: IMissionDagNode): IDistillTabHandles {
		// 1. Dynamic Telemetry Thermal Section (patched in place at 1Hz)
		const thermalSection = append(body, $('.ade-mission-ni-section'));
		const tHead = append(thermalSection, $('.ade-mission-ni-section-head'));
		append(tHead, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiThermalTitle', "Context Thermal Breakdown"), "上下文热成像切片")));
		const pctBadgeEl = append(tHead, $('span.ade-mission-token-status-badge'));

		const bigTrack = append(thermalSection, $('.ade-mission-ni-thermal-track'));
		const segInitEl = append(bigTrack, $('.ade-ctx-seg.seg-init'));
		const segTierEl = append(bigTrack, $('.ade-ctx-seg.seg-tier'));
		const segSrcEl = append(bigTrack, $('.ade-ctx-seg.seg-source'));
		const segNoiseEl = append(bigTrack, $('.ade-ctx-seg.seg-noise'));

		const legend = append(thermalSection, $('.ade-mission-ni-thermal-legend'));
		const makeLegendRow = (cls: string, label: string): HTMLElement => {
			const item = append(legend, $('.ade-mission-ni-thermal-item'));
			append(item, $(`span.ade-mission-ni-thermal-dot.${cls}`, { 'aria-hidden': 'true' }));
			append(item, $('span.ade-mission-ni-thermal-name', {}, label));
			return append(item, $('span.ade-mission-ni-thermal-val'));
		};
		const initValEl = makeLegendRow('seg-init', adeBi(localize('adeMissionSliceInit', "Initial Context"), "初始化背景"));
		const tierValEl = makeLegendRow('seg-tier', adeBi(localize('adeMissionSliceTier', "Contract Docs"), "单源契约文档"));
		const srcValEl = makeLegendRow('seg-source', adeBi(localize('adeMissionSliceSource', "Active Source"), "有效工作源码"));
		const noiseValEl = makeLegendRow('seg-noise', adeBi(localize('adeMissionSliceNoise', "Error / Rework Noise"), "报错/返工噪音"));

		// 2. Static One-Click Distill & Refresh Card (mounted ONCE per node; never torn down on telemetry ticks)
		let memoInput: HTMLInputElement | undefined;
		let distillBtn: HTMLButtonElement | undefined;
		if (node.kind !== 'gate') {
			const distillBox = append(body, $('.ade-mission-ni-distill-card'));
			append(distillBox, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionNiDistillCardTitle', "One-Click Distill & Refresh"), "一键提纯换血")));
			append(distillBox, $('.ade-mission-ni-muted-hint', {}, adeBi(
				localize('adeMissionNiDistillDesc', "Keep local/remote disk artifacts intact, distill past pitfalls into a high-signal memo, reset the bloated context window, and continue in a fresh session."),
				"保留本地/云端磁盘既有代码产物，将历史踩坑提炼为高信噪比备忘，重置臃肿上下文窗口并用干净会话继续执行。",
			)));
			memoInput = append(distillBox, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: adeBi(localize('adeMissionNiDistillMemoPh', "Optional: add pitfall memo or architecture notes..."), "可选：补充踩坑备忘或架构指令..."),
				'data-ade-ni-distill-memo': 'true',
			})) as HTMLInputElement;
			memoInput.value = this.distillMemoDraftByNode.get(node.id) ?? '';
			distillBtn = append(distillBox, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				'data-ade-ni-distill': node.id,
			})) as HTMLButtonElement;
			append(distillBtn, $('span.codicon.codicon-sparkle', { 'aria-hidden': 'true' }));
			append(distillBtn, $('span', {}, adeBi(localize('adeMissionNiDistillBtn', "Distill & Refresh"), "执行提纯换血")));
		}

		// 3. Deterministic Verification Checklist Section (list & form live in separate siblings!)
		const chkSection = append(body, $('.ade-mission-ni-section'));
		const chkHead = append(chkSection, $('.ade-mission-ni-section-head'));
		const chkTitleEl = append(chkHead, $('.ade-mission-ni-section-title'));
		const chkHeadActions = append(chkHead, $('.ade-mission-ni-head-actions'));
		const runChkBtn = append(chkHeadActions, $('button.ade-mission-ni-mini-btn', {
			type: 'button',
			'data-ade-ni-run-checks': node.id,
		}, adeBi(localize('adeMissionNiRunChecks', "Run Checks"), "立即验真"))) as HTMLButtonElement;
		runChkBtn.hidden = true;

		const chkListEl = append(chkSection, $('.ade-mission-ni-check-list'));
		const chkListDisposables = this.tabDisposables.add(new DisposableStore());
		const noChecksHintEl = append(chkSection, $('.ade-mission-ni-muted-hint', {}, adeBi(
			localize('adeMissionNiNoChecks', "No zero-token command or file verification hooks configured on this node."),
			"该节点未配置零 Token 确定性命令/文件校验钩子。",
		)));

		// Static Inline Add Check Hook Form (NEVER torn down or touched by telemetry ticks!)
		const draft = this.checkFormDraftByNode.get(node.id);
		if (node.kind !== 'gate' && this.delegate.onUpsertNodeCheck) {
			const form = append(chkSection, $('.ade-mission-check-add-form', {
				'data-ade-check-add-form': node.id,
			}));
			const nameInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: adeBi(localize('adeMissionChkNamePh', "Hook name (optional, e.g. unit-tests)"), "钩子名称（可选，如 unit-tests）"),
				'data-ade-check-name-input': 'true',
			})) as HTMLInputElement;
			const cmdInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: adeBi(localize('adeMissionChkCmdPh', "Check command (e.g. pnpm test or pytest -q)"), "校验命令（如 pnpm test 或 pytest -q）"),
				'data-ade-check-cmd-input': 'true',
			})) as HTMLInputElement;
			const filesInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: adeBi(localize('adeMissionChkFilesPh', "Required output files (optional, comma-separated, e.g. dist/out.js)"), "必检产物文件（可选，逗号分隔，如 dist/out.js）"),
				'data-ade-check-files-input': 'true',
			})) as HTMLInputElement;
			const matchInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: adeBi(localize('adeMissionChkMatchPh', "Output match keyword or /regex/ (optional)"), "输出匹配关键字或 /正则/（可选）"),
				'data-ade-check-match-input': 'true',
			})) as HTMLInputElement;
			const optsRow = append(form, $('.ade-mission-trigger-form-row'));
			const onFailSelect = append(optsRow, $('select.ade-mission-config-select', {
				'data-ade-check-onfail-select': 'true',
				title: adeBi(localize('adeMissionChkOnFailTip', "Action when verification fails"), "校验失败时的处理策略"),
			})) as HTMLSelectElement;
			append(onFailSelect, $('option', { value: 'bounce' }, adeBi(localize('adeMissionChkOnFailBounce', "Bounce to assignee (retry)"), "打回原员工重试")));
			append(onFailSelect, $('option', { value: 'fail' }, adeBi(localize('adeMissionChkOnFailFail', "Route failure edge (fail)"), "触发失败边")));
			append(onFailSelect, $('option', { value: 'escalate' }, adeBi(localize('adeMissionChkOnFailEscalate', "Escalate to supervisor"), "直接升级监工")));
			const retriesInput = append(optsRow, $('input.ade-mission-config-input', {
				type: 'number',
				min: '0',
				max: '5',
				value: draft?.retries ?? '2',
				title: adeBi(localize('adeMissionChkRetriesTip', "Max auto-retries before escalation (0..5)"), "升级监工前的最大自动重试次数 (0..5)"),
				'data-ade-check-retries-input': 'true',
			})) as HTMLInputElement;

			if (draft) {
				nameInput.value = draft.name;
				cmdInput.value = draft.command;
				filesInput.value = draft.files;
				matchInput.value = draft.match;
				onFailSelect.value = draft.onFail;
			}

			const saveCheckDraft = () => {
				const next: ICheckFormDraft = {
					name: nameInput.value,
					command: cmdInput.value,
					files: filesInput.value,
					match: matchInput.value,
					onFail: (onFailSelect.value as MissionCheckOnFailAction) || 'bounce',
					retries: retriesInput.value,
				};
				if (next.name || next.command || next.files || next.match || next.onFail !== 'bounce' || next.retries !== '2') {
					this.checkFormDraftByNode.set(node.id, next);
				} else {
					this.checkFormDraftByNode.delete(node.id);
				}
			};
			for (const ctrl of [nameInput, cmdInput, filesInput, matchInput, retriesInput]) {
				this.tabDisposables.add(addDisposableListener(ctrl, EventType.INPUT, saveCheckDraft));
				this.tabDisposables.add(addDisposableListener(ctrl, EventType.KEY_DOWN, (e: KeyboardEvent) => e.stopPropagation()));
			}
			this.tabDisposables.add(addDisposableListener(onFailSelect, EventType.CHANGE, saveCheckDraft));

			const errEl = append(form, $('.ade-mission-drawer-status.error'));
			errEl.hidden = true;
			const addBtn = append(form, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				'data-ade-check-submit': node.id,
			}, adeBi(localize('adeMissionChkSubmitBtn', "+ Add Verification Hook"), "+ 添加确定性校验钩子"))) as HTMLButtonElement;
			this.tabDisposables.add(addDisposableListener(addBtn, EventType.CLICK, () => {
				const command = cmdInput.value.trim() || undefined;
				const expectFiles = filesInput.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
				if (!command && expectFiles.length === 0) {
					errEl.textContent = adeBi(localize('adeMissionChkNeedCmdOrFile', "Provide at least a check command or a required output file path."), "请至少填写校验命令或必检产物文件路径。");
					errEl.hidden = false;
					return;
				}
				errEl.hidden = true;
				const name = nameInput.value.trim() || undefined;
				const expectOutputMatch = matchInput.value.trim() || undefined;
				const onFail = (onFailSelect.value as MissionCheckOnFailAction) || 'bounce';
				const maxAutoRetries = Math.max(0, Math.min(5, Number.parseInt(retriesInput.value || '2', 10) || 0));
				const hook: IMissionNodeCheckHook = {
					id: `ui-check-${Date.now().toString(36)}`,
					...(name ? { name } : {}),
					...(command ? { command } : {}),
					...(expectFiles.length > 0 ? { expectFiles } : {}),
					...(expectOutputMatch ? { expectOutputMatch } : {}),
					onFail,
					maxAutoRetries,
					enabled: true,
					source: 'config',
				};
				nameInput.value = '';
				cmdInput.value = '';
				filesInput.value = '';
				matchInput.value = '';
				this.checkFormDraftByNode.delete(node.id);
				this.delegate.onUpsertNodeCheck?.(node.id, hook);
			}));
		}

		const lastCheckBoxEl = append(chkSection, $('.ade-mission-token-box'));
		lastCheckBoxEl.hidden = true;
		const lastCheckBodyEl = append(lastCheckBoxEl, $('.ade-mission-token-box-body'));

		const handle: IDistillTabHandles = {
			kind: 'distill',
			node,
			pctBadgeEl,
			segInitEl,
			segTierEl,
			segSrcEl,
			segNoiseEl,
			initValEl,
			tierValEl,
			srcValEl,
			noiseValEl,
			memoInput,
			chkTitleEl,
			runChkBtn,
			chkListEl,
			chkListDisposables,
			noChecksHintEl,
			lastChecksSignature: '',
			lastCheckBoxEl,
			lastCheckBodyEl,
		};

		if (memoInput && distillBtn) {
			const inputEl = memoInput;
			this.tabDisposables.add(addDisposableListener(inputEl, EventType.INPUT, () => {
				if (inputEl.value) {
					this.distillMemoDraftByNode.set(handle.node.id, inputEl.value);
				} else {
					this.distillMemoDraftByNode.delete(handle.node.id);
				}
			}));
			this.tabDisposables.add(addDisposableListener(inputEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				e.stopPropagation();
			}));
			this.tabDisposables.add(addDisposableListener(distillBtn, EventType.CLICK, () => {
				const memo = inputEl.value.trim() || undefined;
				inputEl.value = '';
				this.distillMemoDraftByNode.delete(handle.node.id);
				this.delegate.onDistillNodeContext(handle.node, memo);
			}));
		}
		this.tabDisposables.add(addDisposableListener(runChkBtn, EventType.CLICK, () => {
			this.delegate.onRunNodeChecks(handle.node);
		}));

		return handle;
	}

	private patchDistillTab(
		h: IDistillTabHandles,
		missionId: string,
		node: IMissionDagNode,
		rt: IMissionRuntimeState | undefined,
		primaryToken: IMissionToken | undefined,
	): void {
		h.node = node;
		const tel = rt?.nodeTelemetry?.[node.id];
		const linkedAgent = this.delegate.getAgentForNode(node.id);
		const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? this.delegate.getFallbackOwnerEngineId();
		const resolvedModel = linkedAgent?.preferredModel || tel?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineId;
		const ctx = computeMissionNodeContextBreakdown(tel, inferModelContextWindowTokens(resolvedModel, { engineId }));

		// 1. In-place thermal telemetry patch (zero DOM teardown!)
		const pctCls = `ade-mission-token-status-badge ${ctx.severity === 'critical' ? 'status-frozen-failed' : ctx.severity === 'warn' ? 'status-blocked' : 'status-completed'}`;
		if (h.pctBadgeEl.className !== pctCls) {
			h.pctBadgeEl.className = pctCls;
		}
		h.pctBadgeEl.setAttribute('data-ade-distill-context-max', String(ctx.maxTokens));
		h.pctBadgeEl.setAttribute('data-ade-distill-noise-pct', String(Math.round(ctx.noisePct)));
		h.pctBadgeEl.title = `${formatCompactTokenCount(ctx.usedTokens)} / ${formatCompactTokenCount(ctx.maxTokens)} (${ctx.usedPct}%)`;
		setTextIfChanged(h.pctBadgeEl, `${ctx.usedPct}%`);
		h.segInitEl.style.width = `${ctx.initPct.toFixed(1)}%`;
		h.segTierEl.style.width = `${ctx.tierPct.toFixed(1)}%`;
		h.segSrcEl.style.width = `${ctx.sourcePct.toFixed(1)}%`;
		h.segNoiseEl.style.width = `${ctx.noisePct.toFixed(1)}%`;
		setTextIfChanged(h.initValEl, `${formatCompactTokenCount(tel?.contextInitTokens ?? 0)} (${Math.round(ctx.initPct)}%)`);
		setTextIfChanged(h.tierValEl, `${formatCompactTokenCount(tel?.contextTierDocTokens ?? 0)} (${Math.round(ctx.tierPct)}%)`);
		setTextIfChanged(h.srcValEl, `${formatCompactTokenCount(tel?.contextSourceTokens ?? 0)} (${Math.round(ctx.sourcePct)}%)`);
		setTextIfChanged(h.noiseValEl, `${formatCompactTokenCount(tel?.contextNoiseTokens ?? 0)} (${Math.round(ctx.noisePct)}%)`);

		// 2. Check hooks list (rebuilt ONLY when check hook definitions actually change; form sibling untouched!)
		const checks = this.missionRuntimeService?.getEffectiveNodeChecks(missionId, node.id)[node.id] ?? [];
		setTextIfChanged(h.chkTitleEl, adeBi(localize('adeMissionNiChecksTitle', "Verification Hooks ({0})", checks.length), "确定性验收钩子 ({0})", checks.length));
		h.runChkBtn.hidden = checks.length === 0;
		h.noChecksHintEl.hidden = checks.length > 0;
		h.chkListEl.hidden = checks.length === 0;

		const checksSig = checks.map(c => `${c.id}|${c.name ?? ''}|${c.command ?? ''}|${(c.expectFiles ?? []).join(',')}|${c.source ?? ''}`).join('\x1e');
		if (h.lastChecksSignature !== checksSig) {
			h.lastChecksSignature = checksSig;
			h.chkListDisposables.clear();
			clearNode(h.chkListEl);
			for (const chk of checks) {
				const row = append(h.chkListEl, $('.ade-mission-ni-check-row', {
					'data-ade-check-row': chk.id,
				}));
				append(row, $('span.ade-mission-token-meta-chip.wave', {}, chk.name || chk.id));
				append(row, $('span.ade-mission-trace-summary', { title: chk.command || '' }, chk.command || (chk.expectFiles ? `files: ${chk.expectFiles.join(', ')}` : 'check')));
				if (chk.source !== 'mermaid' && this.delegate.onRemoveNodeCheck) {
					const delBtn = append(row, $('button.ade-mission-icon-btn.danger', {
						type: 'button',
						title: adeBi(localize('adeMissionNiCheckDeleteTip', "Remove verification hook"), "移除校验钩子"),
						'data-ade-check-delete': chk.id,
					})) as HTMLButtonElement;
					delBtn.appendChild($('span.codicon.codicon-trash'));
					h.chkListDisposables.add(addDisposableListener(delBtn, EventType.CLICK, () => {
						this.delegate.onRemoveNodeCheck?.(node.id, chk.id);
					}));
				}
			}
		}

		// 3. Last check execution summary box
		if (tel?.lastCheckSummary || primaryToken?.lastCheckFailure) {
			const fail = tel?.lastCheckStatus === 'failed' || Boolean(primaryToken?.lastCheckFailure);
			const nextBoxCls = `ade-mission-token-box ${fail ? 'is-failed' : 'is-blocked'}`;
			if (h.lastCheckBoxEl.className !== nextBoxCls) {
				h.lastCheckBoxEl.className = nextBoxCls;
			}
			setTextIfChanged(h.lastCheckBodyEl, primaryToken?.lastCheckFailure?.summary || tel?.lastCheckSummary || '');
			h.lastCheckBoxEl.hidden = false;
		} else {
			h.lastCheckBoxEl.hidden = true;
		}
	}

	// =========================================================================
	// Tab 4: FinOps Ledger — Static Budget Controls + In-Place Spend Patcher
	// =========================================================================

	private mountFinOpsSkeleton(body: HTMLElement): IFinOpsTabHandles {
		const win = getWindow(this.panelEl);

		// 1. Hero Spend vs Budget Card
		const heroEl = append(body, $('.ade-mission-finops-hero', {
			'data-ade-finops-hero': 'true',
		}));
		const heroTop = append(heroEl, $('.ade-mission-finops-hero-top'));
		const heroSpendEl = append(heroTop, $('span.ade-mission-finops-hero-amount', {
			'data-ade-finops-hero-spend': 'true',
		}, '$0.00'));
		const heroLimitEl = append(heroTop, $('span.ade-mission-finops-hero-limit'));
		const heroEstBadgeEl = append(heroTop, $('span.ade-mission-finops-est-badge', {
			'data-ade-finops-estimated-badge': 'true',
			title: adeBi(
				localize(
					'adeMissionFinOpsEstimatedBadgeTip',
					"One or more engines did not report direct USD billing; spend is automatically estimated from built-in/custom per-million-token rates and enforces the budget circuit-breaker. Override rates or mark zero-cost local models in aexus.ade.finOps.modelPricingOverrides.",
				),
				"部分或全部引擎未直接上报美元账单，当前花费按内置/自定义模型 Token 单价自动折算并驱动预算熔断。可在设置 aexus.ade.finOps.modelPricingOverrides 中覆盖单价或标记本地零成本模型。",
			),
		}, adeBi(localize('adeMissionFinOpsEstimatedBadge', "Est."), "预估")));
		heroEstBadgeEl.hidden = true;

		const heroMeta = append(heroEl, $('.ade-mission-finops-hero-meta'));
		const heroTokensEl = append(heroMeta, $('span'));
		const heroCacheEl = append(heroMeta, $('span'));

		const trippedAlertEl = append(heroEl, $('.ade-mission-token-box.is-failed'));
		trippedAlertEl.hidden = true;
		append(trippedAlertEl, $('.ade-mission-token-box-body', {}, adeBi(
			localize('adeMissionFinOpsTrippedMsg', "Budget circuit-breaker tripped: Mission is paused and new token dispatches are blocked. Raise the budget cap to resume."),
			"预算熔断已触发：任务已自动暂停并阻止新令牌派发。请上调预算上限后恢复运行。",
		)));
		const raiseResumeBtn = append(trippedAlertEl, $('button.ade-mission-token-action-btn.primary', {
			type: 'button',
			'data-ade-finops-raise-resume': 'true',
		}, adeBi(localize('adeMissionFinOpsRaiseResumeBtn', "Raise Cap (+$5) & Resume"), "上调额度 (+$5) 并恢复"))) as HTMLButtonElement;

		// 2. Static Interactive Budget Circuit-Breaker Slider & USD Input (NEVER rebuilt during 1Hz ticks!)
		const sliderSection = append(body, $('.ade-mission-ni-section'));
		const slHead = append(sliderSection, $('.ade-mission-ni-section-head'));
		append(slHead, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionFinOpsSliderTitle', "Budget Circuit-Breaker Cap ($USD)"), "预算熔断上限 ($USD)")));
		const unlimitedBtn = append(slHead, $('button.ade-mission-ni-mini-btn', {
			type: 'button',
			'data-ade-finops-budget-unlimited': 'true',
		}, adeBi(localize('adeMissionFinOpsSetUnlimited', "Unlimited"), "不设上限"))) as HTMLButtonElement;

		const sliderRow = append(sliderSection, $('.ade-mission-finops-slider-row'));
		const sliderEl = append(sliderRow, $('input.ade-mission-finops-slider', {
			type: 'range',
			min: '0.5',
			max: '50',
			step: '0.5',
			value: '10',
			'data-ade-finops-budget-slider': 'true',
		})) as HTMLInputElement;
		const numInputEl = append(sliderRow, $('input.ade-mission-config-input', {
			type: 'number',
			min: '0',
			step: '0.5',
			placeholder: '∞',
			'data-ade-finops-budget-input': 'true',
		})) as HTMLInputElement;

		// 3. Per-Rank Breakdown
		const tierSection = append(body, $('.ade-mission-ni-section', { 'data-ade-finops-by-tier': 'true' }));
		append(tierSection, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionFinOpsByTierTitle', "Spend by Dynamic Rank (L1..LN)"), "按动态职级拆解账单 (L1..LN)")));
		const tierEmptyEl = append(tierSection, $('.ade-mission-ni-muted-hint', {}, adeBi(localize('adeMissionFinOpsNoSpend', "No runtime spend recorded yet."), "尚无运行花费记录。")));
		const tierRowsWrapEl = append(tierSection, $('.ade-mission-finops-rows-wrap'));

		// 4. Per-Host Breakdown
		const hostSection = append(body, $('.ade-mission-ni-section', { 'data-ade-finops-by-host': 'true' }));
		append(hostSection, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionFinOpsByHostTitle', "Spend by Cloud / Local Host"), "按跨云/本机算力拆解")));
		const hostEmptyEl = append(hostSection, $('.ade-mission-ni-muted-hint', {}, adeBi(localize('adeMissionFinOpsNoHostSpend', "No host spend recorded yet."), "尚无主机算力花费记录。")));
		const hostRowsWrapEl = append(hostSection, $('.ade-mission-finops-rows-wrap'));

		// 5. Top Spender Nodes
		const topNodesSectionEl = append(body, $('.ade-mission-ni-section'));
		topNodesSectionEl.hidden = true;
		append(topNodesSectionEl, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionFinOpsTopNodesTitle', "Top Spender Nodes"), '节点花费排行')));
		const topNodesListEl = append(topNodesSectionEl, $('.ade-mission-finops-rows-wrap'));
		const topNodesDisposables = this.tabDisposables.add(new DisposableStore());

		// 6. Multi-Run Archived Ledger & Comparison (Audit #18)
		const runHistorySectionEl = append(body, $('.ade-mission-ni-section', { 'data-ade-finops-run-history': 'true' }));
		runHistorySectionEl.hidden = true;
		append(runHistorySectionEl, $('.ade-mission-ni-section-title', {}, adeBi(localize('adeMissionFinOpsRunHistoryTitle', "Run History & Multi-Run Comparison"), '历次运行账本与多轮对比')));
		const runDeltaBannerEl = append(runHistorySectionEl, $('.ade-mission-finops-delta-banner', { 'data-ade-finops-run-delta': 'true' }));
		const runHistoryListEl = append(runHistorySectionEl, $('.ade-mission-finops-run-list', { 'data-ade-finops-run-list': 'true' }));
		const runHistoryDisposables = this.tabDisposables.add(new DisposableStore());

		const handle: IFinOpsTabHandles = {
			kind: 'finops',
			lastSummary: undefined,
			heroEl,
			heroSpendEl,
			heroLimitEl,
			heroEstBadgeEl,
			heroTokensEl,
			heroCacheEl,
			trippedAlertEl,
			sliderEl,
			numInputEl,
			tierEmptyEl,
			tierRowsWrapEl,
			tierRows: [],
			hostEmptyEl,
			hostRowsWrapEl,
			hostRows: [],
			topNodesSectionEl,
			topNodesListEl,
			topNodesDisposables,
			topNodeRows: [],
			runHistorySectionEl,
			runDeltaBannerEl,
			runHistoryListEl,
			runHistoryDisposables,
			selectedBaselineRunNumber: undefined,
			lastRunHistorySignature: '',
		};

		this.tabDisposables.add(addDisposableListener(raiseResumeBtn, EventType.CLICK, () => {
			this.isBudgetSliderDragging = false;
			this.sliderDragDisposables.clear();
			sliderEl.blur();
			numInputEl.blur();
			const s = handle.lastSummary;
			const nextLimit = Math.max(s?.totalCostUsd ?? 0, s?.budgetLimitUsd ?? 0) + 5;
			this.delegate.onRaiseAndResumeBudget(Math.ceil(nextLimit * 100) / 100);
		}));
		this.tabDisposables.add(addDisposableListener(unlimitedBtn, EventType.CLICK, () => {
			this.isBudgetSliderDragging = false;
			this.sliderDragDisposables.clear();
			sliderEl.blur();
			numInputEl.blur();
			numInputEl.value = '';
			this.delegate.onSetBudgetLimit(undefined);
		}));

		const endSliderDrag = () => {
			if (!this.isBudgetSliderDragging) {
				return;
			}
			this.isBudgetSliderDragging = false;
			this.sliderDragDisposables.clear();
		};
		this.tabDisposables.add(addDisposableListener(sliderEl, EventType.POINTER_DOWN, () => {
			this.isBudgetSliderDragging = true;
			this.sliderDragDisposables.clear();
			this.sliderDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, endSliderDrag));
			this.sliderDragDisposables.add(addDisposableListener(win, 'pointercancel', endSliderDrag));
			this.sliderDragDisposables.add(addDisposableListener(win, EventType.BLUR, endSliderDrag));
		}));
		this.tabDisposables.add(addDisposableListener(sliderEl, EventType.INPUT, () => {
			numInputEl.value = sliderEl.value;
		}));
		this.tabDisposables.add(addDisposableListener(sliderEl, EventType.CHANGE, () => {
			endSliderDrag();
			const val = Number.parseFloat(sliderEl.value);
			if (Number.isFinite(val) && val > 0) {
				this.delegate.onSetBudgetLimit(val);
			}
		}));
		this.tabDisposables.add(addDisposableListener(numInputEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
		}));
		this.tabDisposables.add(addDisposableListener(numInputEl, EventType.CHANGE, () => {
			const raw = numInputEl.value.trim();
			if (!raw) {
				this.delegate.onSetBudgetLimit(undefined);
				return;
			}
			const val = Number.parseFloat(raw);
			this.delegate.onSetBudgetLimit(Number.isFinite(val) && val > 0 ? val : undefined);
		}));

		return handle;
	}

	private patchBucketRows(
		wrapEl: HTMLElement,
		existingRows: IFinOpsBucketRowHandle[],
		buckets: readonly IMissionFinOpsBucket[],
		fillKind: 'tier' | 'host',
	): IFinOpsBucketRowHandle[] {
		const formatBucketLabel = (b: IMissionFinOpsBucket) => adeBi(
			localize('adeMissionFinOpsBucketLabel', "{0} · {1} node(s)", b.label, b.nodeCount),
			"{0} · {1} 个节点",
			b.label,
			b.nodeCount,
		);
		const sameKeys = existingRows.length === buckets.length
			&& existingRows.every((r, idx) => r.key === buckets[idx].key);
		if (sameKeys) {
			for (let i = 0; i < buckets.length; i++) {
				const b = buckets[i];
				const row = existingRows[i];
				setTextIfChanged(row.labelEl, formatBucketLabel(b));
				setTextIfChanged(row.valEl, `${formatFinOpsUsd(b.costUsd, { estimated: b.hasEstimatedCost })} · ${formatCompactTokenCount(b.tokens)} (${b.pct}%)`);
				row.fillEl.style.width = `${Math.max(3, b.pct)}%`;
			}
			return existingRows;
		}
		clearNode(wrapEl);
		const nextRows: IFinOpsBucketRowHandle[] = [];
		for (const b of buckets) {
			const row = append(wrapEl, $('.ade-mission-finops-bar-row'));
			const metaRow = append(row, $('.ade-mission-finops-bar-meta'));
			const labelEl = append(metaRow, $('span.ade-mission-finops-bar-label', {}, formatBucketLabel(b)));
			const valEl = append(metaRow, $('span.ade-mission-finops-bar-val', {}, `${formatFinOpsUsd(b.costUsd, { estimated: b.hasEstimatedCost })} · ${formatCompactTokenCount(b.tokens)} (${b.pct}%)`));
			const track = append(row, $('.ade-mission-finops-ledger-track'));
			const fillEl = append(track, $(`.ade-mission-finops-ledger-fill.${fillKind}`));
			fillEl.style.width = `${Math.max(3, b.pct)}%`;
			nextRows.push({ key: b.key, labelEl, valEl, fillEl });
		}
		return nextRows;
	}

	private patchFinOpsTab(
		h: IFinOpsTabHandles,
		rt: IMissionRuntimeState | undefined,
		nodes: readonly IMissionDagNode[],
	): void {
		const summary = computeMissionFinOpsSummary(rt, nodes, this.delegate.getHostByNodeIdMap());
		h.lastSummary = summary;

		const heroCls = `ade-mission-finops-hero severity-${summary.severity}`;
		if (h.heroEl.className !== heroCls) {
			h.heroEl.className = heroCls;
		}
		setTextIfChanged(h.heroSpendEl, formatFinOpsUsd(summary.totalCostUsd, { estimated: summary.hasEstimatedCost }));
		h.heroEstBadgeEl.hidden = !summary.hasEstimatedCost;
		setTextIfChanged(
			h.heroLimitEl,
			summary.budgetLimitUsd !== undefined
				? `/ $${summary.budgetLimitUsd.toFixed(2)}`
				: adeBi(localize('adeMissionFinOpsUnlimitedTag', "/ Unlimited"), "/ 不设上限"),
		);
		setTextIfChanged(
			h.heroTokensEl,
			adeBi(
				localize('adeMissionFinOpsTokensCount', "{0} tokens", formatCompactTokenCount(summary.totalTokens)),
				"{0} 令牌",
				formatCompactTokenCount(summary.totalTokens),
			),
		);
		setTextIfChanged(
			h.heroCacheEl,
			adeBi(localize('adeMissionFinOpsCacheDetail', "Cache Saved {0}%", summary.cacheSavingsPct), "缓存节省 {0}%", summary.cacheSavingsPct),
		);

		h.trippedAlertEl.hidden = !summary.budgetCircuitTripped;
		if (summary.budgetCircuitTripped) {
			h.trippedAlertEl.setAttribute('data-ade-finops-tripped-banner', 'true');
		} else {
			h.trippedAlertEl.removeAttribute('data-ade-finops-tripped-banner');
		}

		// Sync slider & USD number input ONLY when user is NOT actively dragging or editing them!
		const editingBudget = this.isBudgetSliderDragging
			|| this.isControlFocused(h.sliderEl)
			|| this.isControlFocused(h.numInputEl);
		if (!editingBudget) {
			const sliderMax = Math.max(50, Math.ceil((summary.budgetLimitUsd ?? summary.totalCostUsd + 10) * 2));
			const currentVal = summary.budgetLimitUsd ?? 10;
			const maxStr = String(sliderMax);
			if (h.sliderEl.max !== maxStr) {
				h.sliderEl.max = maxStr;
			}
			const valStr = String(currentVal);
			if (h.sliderEl.value !== valStr) {
				h.sliderEl.value = valStr;
			}
			const numStr = summary.budgetLimitUsd !== undefined ? String(summary.budgetLimitUsd) : '';
			if (h.numInputEl.value !== numStr) {
				h.numInputEl.value = numStr;
			}
		}

		// Per-Rank & Per-Host Breakdown (in-place patching when bucket keys match)
		h.tierEmptyEl.hidden = summary.byTier.length > 0;
		h.tierRowsWrapEl.hidden = summary.byTier.length === 0;
		h.tierRows = this.patchBucketRows(h.tierRowsWrapEl, h.tierRows, summary.byTier, 'tier');

		h.hostEmptyEl.hidden = summary.byHost.length > 0;
		h.hostRowsWrapEl.hidden = summary.byHost.length === 0;
		h.hostRows = this.patchBucketRows(h.hostRowsWrapEl, h.hostRows, summary.byHost, 'host');

		// Top Spender Nodes
		const topItems = summary.byNode.slice(0, 8);
		h.topNodesSectionEl.hidden = topItems.length === 0;
		const sameTopNodes = h.topNodeRows.length === topItems.length
			&& h.topNodeRows.every((r, idx) => r.nodeId === topItems[idx].nodeId);
		const formatNodeSpend = (item: IMissionFinOpsSummary['byNode'][number]) => {
			const costText = item.costLocalFree && item.costUsd === 0
				? adeBi(localize('adeMissionNiTelemetryLocalFree', "Local $0.00"), "本机 $0.00")
				: formatFinOpsUsd(item.costUsd, { estimated: item.costEstimated });
			return `${costText} (${formatCompactTokenCount(item.tokens)})`;
		};
		if (sameTopNodes) {
			for (let i = 0; i < topItems.length; i++) {
				const item = topItems[i];
				setTextIfChanged(h.topNodeRows[i].keyEl, `${item.nodeId} · ${item.label}`);
				setTextIfChanged(h.topNodeRows[i].valEl, formatNodeSpend(item));
			}
		} else {
			h.topNodesDisposables.clear();
			clearNode(h.topNodesListEl);
			const nextNodeRows: IFinOpsNodeRowHandle[] = [];
			for (const item of topItems) {
				const rowBtn = append(h.topNodesListEl, $('button.ade-mission-ni-kv-row', {
					type: 'button',
					'data-ade-finops-node-row': item.nodeId,
				})) as HTMLButtonElement;
				const keyEl = append(rowBtn, $('span.ade-mission-ni-kv-key', {}, `${item.nodeId} · ${item.label}`));
				const valEl = append(rowBtn, $('span.ade-mission-ni-kv-val', {}, formatNodeSpend(item)));
				h.topNodesDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, () => {
					this.activeTab = 'overview';
					this.delegate.onSelectNodeFromInspector(item.nodeId);
				}));
				nextNodeRows.push({ nodeId: item.nodeId, keyEl, valEl });
			}
			h.topNodeRows = nextNodeRows;
		}

		// 6. Multi-Run Archived Ledger & Comparison (in-place update, zero focus/scroll disruption)
		this.patchFinOpsRunHistory(h, rt, nodes);
	}

	private formatRunDurationShort(durationMs: number): string {
		const sec = Math.max(0, durationMs) / 1000;
		if (sec < 60) {
			return `${sec.toFixed(sec >= 10 ? 0 : 1)}s`;
		}
		const mins = Math.floor(sec / 60);
		const remSec = Math.round(sec % 60);
		return `${mins}m${remSec.toString().padStart(2, '0')}s`;
	}

	private formatSignedDeltaUsd(delta: number, pct?: number): string {
		const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
		const base = `${sign}$${Math.abs(delta).toFixed(2)}`;
		return pct !== undefined ? `${base} (${pct > 0 ? '+' : ''}${pct}%)` : base;
	}

	private formatSignedDeltaDuration(deltaMs: number, pct?: number): string {
		const sign = deltaMs > 0 ? '+' : deltaMs < 0 ? '-' : '';
		const base = `${sign}${this.formatRunDurationShort(Math.abs(deltaMs))}`;
		return pct !== undefined ? `${base} (${pct > 0 ? '+' : ''}${pct}%)` : base;
	}

	private patchFinOpsRunHistory(
		h: IFinOpsTabHandles,
		rt: IMissionRuntimeState | undefined,
		nodes: readonly IMissionDagNode[],
	): void {
		const archivedRuns = rt?.runHistory ?? [];
		if (!rt || archivedRuns.length === 0) {
			h.runHistorySectionEl.hidden = true;
			h.lastRunHistorySignature = '';
			return;
		}
		h.runHistorySectionEl.hidden = false;

		const hasLiveRun = rt.startedAt !== undefined;
		const currentRun: IMissionRunArchive = hasLiveRun
			? buildMissionRunArchiveSnapshot(rt, nodes, {
				runNumber: Math.max(rt.runSeq ?? 0, archivedRuns[archivedRuns.length - 1].runNumber + 1),
				hostByNodeId: this.delegate.getHostByNodeIdMap(),
				now: rt.completedAt ?? rt.updatedAt ?? Date.now(),
			})
			: archivedRuns[archivedRuns.length - 1];

		const candidateBaselines = hasLiveRun
			? archivedRuns
			: archivedRuns.slice(0, archivedRuns.length - 1);
		let baselineRun = h.selectedBaselineRunNumber !== undefined
			? candidateBaselines.find(r => r.runNumber === h.selectedBaselineRunNumber)
			: undefined;
		if (!baselineRun && candidateBaselines.length > 0) {
			baselineRun = candidateBaselines[candidateBaselines.length - 1];
			h.selectedBaselineRunNumber = baselineRun.runNumber;
		}

		if (baselineRun) {
			const delta = compareMissionRuns(currentRun, baselineRun);
			const costText = this.formatSignedDeltaUsd(delta.costDeltaUsd, delta.costDeltaPct);
			const durText = this.formatSignedDeltaDuration(delta.durationDeltaMs, delta.durationDeltaPct);
			const tokSign = delta.tokensDelta > 0 ? '+' : delta.tokensDelta < 0 ? '-' : '';
			const tokText = `${tokSign}${formatCompactTokenCount(Math.abs(delta.tokensDelta))}`;
			const bannerText = adeBi(
				localize(
					'adeMissionFinOpsRunDeltaText',
					"Run #{0} vs Run #{1}: {2} · {3} · {4} tok",
					delta.currentRunNumber,
					delta.baselineRunNumber,
					costText,
					durText,
					tokText,
				),
				'第 {0} 轮 对比 第 {1} 轮：{2} · {3} · {4} 令牌',
				delta.currentRunNumber,
				delta.baselineRunNumber,
				costText,
				durText,
				tokText,
			);
			setTextIfChanged(h.runDeltaBannerEl, bannerText);
			const bannerCls = delta.costDeltaUsd <= 0 && delta.durationDeltaMs <= 0
				? 'ade-mission-finops-delta-banner is-better'
				: delta.costDeltaUsd > 0
					? 'ade-mission-finops-delta-banner is-worse'
					: 'ade-mission-finops-delta-banner';
			if (h.runDeltaBannerEl.className !== bannerCls) {
				h.runDeltaBannerEl.className = bannerCls;
			}
			h.runDeltaBannerEl.hidden = false;
		} else {
			h.runDeltaBannerEl.hidden = true;
		}

		const displayRuns = [...archivedRuns].reverse();
		const sig = [
			hasLiveRun ? `live:${currentRun.runNumber}:${currentRun.totalCostUsd}:${Math.round(currentRun.durationMs / 1000)}:${currentRun.totalTokens}` : 'nolive',
			`base:${baselineRun?.runNumber ?? -1}`,
			...displayRuns.map(r => `${r.runNumber}:${r.outcome}:${r.totalCostUsd}:${r.durationMs}:${r.totalTokens}`),
		].join('|');
		if (h.lastRunHistorySignature === sig) {
			return;
		}
		h.lastRunHistorySignature = sig;
		h.runHistoryDisposables.clear();
		clearNode(h.runHistoryListEl);

		const formatOutcomeLabel = (outcome: IMissionRunArchive['outcome'], isLive: boolean): string => {
			if (isLive && (rt.status === 'running' || rt.status === 'paused')) {
				return rt.status === 'paused'
					? adeBi(localize('adeMissionFinOpsRunPaused', "Paused"), '已暂停')
					: adeBi(localize('adeMissionFinOpsRunLive', "Current"), '当前轮');
			}
			if (outcome === 'completed') {
				return adeBi(localize('adeMissionFinOpsRunDone', "Done"), '已完成');
			}
			if (outcome === 'failed') {
				return adeBi(localize('adeMissionFinOpsRunFailed', "Failed"), '失败');
			}
			return adeBi(localize('adeMissionFinOpsRunStopped', "Stopped"), '已停止');
		};

		if (hasLiveRun) {
			const liveRow = append(h.runHistoryListEl, $('.ade-mission-finops-run-row.is-live-run', {
				'data-ade-finops-run-row': String(currentRun.runNumber),
				'data-ade-finops-live-run': 'true',
			}));
			const meta = append(liveRow, $('.ade-mission-finops-run-meta'));
			append(meta, $('strong', {}, `#${currentRun.runNumber}`));
			append(meta, $('span', {}, formatOutcomeLabel(currentRun.outcome, true)));
			append(liveRow, $('.ade-mission-finops-run-vals', {}, `${formatFinOpsUsd(currentRun.totalCostUsd, { estimated: currentRun.hasEstimatedCost })} · ${this.formatRunDurationShort(currentRun.durationMs)} · ${formatCompactTokenCount(currentRun.totalTokens)}`));
		}

		for (const run of displayRuns) {
			const isSelected = baselineRun?.runNumber === run.runNumber;
			const rowBtn = append(h.runHistoryListEl, $('button.ade-mission-finops-run-row', {
				type: 'button',
				'data-ade-finops-run-row': String(run.runNumber),
				...(isSelected ? { 'data-selected-baseline': 'true' } : {}),
			})) as HTMLButtonElement;
			const meta = append(rowBtn, $('.ade-mission-finops-run-meta'));
			append(meta, $('strong', {}, `#${run.runNumber}`));
			append(meta, $('span', {}, formatOutcomeLabel(run.outcome, false)));
			append(rowBtn, $('.ade-mission-finops-run-vals', {}, `${formatFinOpsUsd(run.totalCostUsd, { estimated: run.hasEstimatedCost })} · ${this.formatRunDurationShort(run.durationMs)} · ${formatCompactTokenCount(run.totalTokens)}`));
			h.runHistoryDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, () => {
				h.selectedBaselineRunNumber = run.runNumber;
				h.lastRunHistorySignature = '';
				this.patchFinOpsRunHistory(h, rt, nodes);
			}));
		}
	}
}
