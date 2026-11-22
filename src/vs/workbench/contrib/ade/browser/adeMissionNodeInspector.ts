/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IMissionDagEdge, IMissionDagNode, IMissionNodeCheckHook, MissionCheckOnFailAction } from '../../../../platform/ade/common/adeMissionDag.js';
import { MissionNodeRoleKind } from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	computeMissionFinOpsSummary,
	computeMissionNodeContextBreakdown,
	formatCompactTokenCount,
	IMissionRuntimeState,
	IMissionToken,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import { IAdeAgent, IAdeProjectsService } from '../common/ade.js';
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

/**
 * 4-in-1 Docked Right-Side Mission Studio Inspector Drawer:
 * 1. `overview` — Node command, supervisor/host/employee/model/pre-prompt/trigger controls, Split/Tab chat launch.
 * 2. `token`    — Dual-layer token summary (`lastSummary` + `compressedHistory`), blocked/failure telemetry, lazy `trace_ptr` expansion, Retry/Recall.
 * 3. `distill`  — Enlarged 4-segment context thermal breakdown, one-click 「提纯换血」 session refresh, deterministic check runner.
 * 4. `finops`   — Real-time FinOps spend vs budget circuit-breaker slider, per-tier (`L1..LN`) and per-host (`@Local`/`@cloud`) cost ledgers.
 */
export class AdeMissionNodeInspector extends Disposable {
	private readonly panelEl: HTMLElement;
	private readonly contentDisposables = this._register(new DisposableStore());
	private bodyScrollEl: HTMLElement | undefined;
	private selectedNodeId: string | undefined;
	private activeTab: MissionInspectorTab = 'overview';
	private selectedTokenIdByNode = new Map<string, string>();
	private expandedTraceTokenIds = new Set<string>();

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
			'aria-label': localize('adeMissionNodeInspectorAria', "Mission Studio 4-in-1 Inspector"),
			'data-ade-mission-node-inspector': 'true',
		}));
		this.panelEl.hidden = true;
		this._register(addDisposableListener(this.panelEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this._register(addDisposableListener(this.panelEl, EventType.WHEEL, e => e.stopPropagation()));
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
		this.bodyScrollEl = undefined;
		this.contentDisposables.clear();
		clearNode(this.panelEl);
		delete this.panelEl.dataset.nodeId;
		delete this.panelEl.dataset.activeTab;
		this.panelEl.hidden = true;
		if (wasOpen && notify) {
			this.delegate.onClose();
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

		const prevScrollTop = this.bodyScrollEl?.scrollTop ?? 0;
		this.bodyScrollEl = undefined;
		this.contentDisposables.clear();
		clearNode(this.panelEl);

		const rt: IMissionRuntimeState | undefined = this.missionRuntimeService?.getRuntimeState(missionId);
		const nodeState = node ? (rt?.nodeStates[node.id] ?? 'idle') : (rt?.status ?? 'idle');
		const linkedAgent = node && node.kind !== 'gate' ? this.delegate.getAgentForNode(node.id) : undefined;
		const orgConfig = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const nodeTokens = node && rt
			? Object.values(rt.tokens)
				.filter(t => t.nodeId === node!.id)
				.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
			: [];
		const primaryToken = nodeTokens.find(t => t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_gate' || t.status === 'frozen_failed' || t.status === 'waiting_join')
			?? nodeTokens[0];

		// 1. Header
		const head = append(this.panelEl, $('.ade-mission-ni-head'));
		const titleWrap = append(head, $('.ade-mission-ni-title-wrap'));
		if (node) {
			append(titleWrap, $('span.ade-mission-ni-node-id', {}, node.id));
			append(titleWrap, $('span.ade-mission-ni-title', { title: node.label }, node.label));
		} else {
			append(titleWrap, $('span.ade-mission-ni-node-id', {}, 'FinOps'));
			append(titleWrap, $('span.ade-mission-ni-title', {}, localize('adeMissionNiMissionLedgerTitle', "Mission Ledger")));
		}
		append(head, $(`span.ade-mission-token-status-badge.status-${nodeState.replace(/_/g, '-')}`, {
			'data-ade-ni-state': nodeState,
		}, nodeState));
		const closeBtn = append(head, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: localize('adeMissionNiClose', "Close Panel"),
			'aria-label': localize('adeMissionNiClose', "Close Panel"),
			'data-ade-inspector-close': 'true',
		})) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		this.contentDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.close(true)));

		// 2. 4-in-1 Segmented Tab Bar
		const tabBar = append(this.panelEl, $('.ade-mission-ni-tabs', { role: 'tablist' }));
		const tabs: readonly { readonly id: MissionInspectorTab; readonly label: string }[] = [
			{ id: 'overview', label: localize('adeMissionNiTabOverview', "概览") },
			{ id: 'token', label: localize('adeMissionNiTabToken', "令牌指针") },
			{ id: 'distill', label: localize('adeMissionNiTabDistill', "换血/遥测") },
			{ id: 'finops', label: localize('adeMissionNiTabFinOps', "额度账本") },
		];
		for (const t of tabs) {
			const isActive = this.activeTab === t.id;
			const tabBtn = append(tabBar, $(`button.ade-mission-ni-tab${isActive ? '.active' : ''}`, {
				type: 'button',
				role: 'tab',
				'aria-selected': String(isActive),
				'data-ade-inspector-tab': t.id,
			}, t.label)) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(tabBtn, EventType.CLICK, () => {
				if (this.activeTab !== t.id) {
					this.activeTab = t.id;
					this.refresh();
				}
			}));
		}

		const body = append(this.panelEl, $('.ade-mission-ni-body'));
		this.bodyScrollEl = body;

		if (this.activeTab === 'finops') {
			this.renderFinOpsTab(body, missionId, rt, nodes);
		} else if (!node) {
			append(body, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionNiPickNodeHint', "Click any node on the Mission Canvas to inspect its state, tokens, and telemetry.")));
		} else if (this.activeTab === 'token') {
			this.renderTokenTab(body, missionId, node, nodeTokens, primaryToken);
		} else if (this.activeTab === 'distill') {
			this.renderDistillTab(body, missionId, node, rt, primaryToken);
		} else {
			this.renderOverviewTab(body, missionId, node, nodeState, linkedAgent, orgConfig, rt, nodeTokens, primaryToken);
		}

		if (prevScrollTop > 0) {
			body.scrollTop = prevScrollTop;
		}
	}

	private renderOverviewTab(
		body: HTMLElement,
		missionId: string,
		node: IMissionDagNode,
		nodeState: string,
		linkedAgent: IAdeAgent | undefined,
		orgConfig: ReturnType<IAdeRoleSchemaService['getConfig']>,
		rt: IMissionRuntimeState | undefined,
		nodeTokens: readonly IMissionToken[],
		primaryToken: IMissionToken | undefined,
	): void {
		// Command-Center Chat Actions (single-click stays on canvas; explicit Split or Full Tab)
		if (linkedAgent) {
			const chatRow = append(body, $('.ade-mission-ni-chat-bar'));
			const splitBtn = append(chatRow, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				title: localize('adeMissionNiSplitChatTip', "Open Agent chat in a split pane beside the Mission Canvas"),
				'data-ade-inspector-open-beside': linkedAgent.id,
			})) as HTMLButtonElement;
			append(splitBtn, $('span.codicon.codicon-split-horizontal', { 'aria-hidden': 'true' }));
			append(splitBtn, $('span', {}, localize('adeMissionNiSplitChat', "Split Chat Beside")));
			this.contentDisposables.add(addDisposableListener(splitBtn, EventType.CLICK, () => {
				this.delegate.onOpenAgentBeside(linkedAgent.id);
			}));

			const tabBtn = append(chatRow, $('button.ade-mission-ni-btn', {
				type: 'button',
				title: localize('adeMissionNiOpenTabTip', "Switch directly to Agent chat tab (or double-click node)"),
				'data-ade-inspector-open-tab': linkedAgent.id,
			})) as HTMLButtonElement;
			append(tabBtn, $('span.codicon.codicon-go-to-file', { 'aria-hidden': 'true' }));
			append(tabBtn, $('span', {}, localize('adeMissionNiOpenTab', "Open Tab")));
			this.contentDisposables.add(addDisposableListener(tabBtn, EventType.CLICK, () => {
				this.delegate.onOpenAgentTab(linkedAgent.id);
			}));
		} else if (node.kind === 'gate' && nodeState === 'waiting_gate') {
			const gateRow = append(body, $('.ade-mission-ni-chat-bar'));
			const gateBtn = append(gateRow, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				'data-ade-inspector-open-gate': node.id,
			}, localize('adeMissionNiReviewGate', "Approve / Reject Gate"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(gateBtn, EventType.CLICK, () => {
				this.delegate.onOpenGateDecisionPopover(node, gateBtn);
			}));
		}

		// Quick Configuration Grid (Employee, Off-Graph Supervisor, Execution Host, Engine/Model)
		if (node.kind !== 'gate') {
			const cfgSection = append(body, $('.ade-mission-ni-section'));
			append(cfgSection, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiConfigTitle', "Node Assignment & Governance")));
			const cfgGrid = append(cfgSection, $('.ade-mission-ni-kv-list'));

			// Off-Graph Supervisor (with parentSupervisorId escalation chain visibility)
			const boundSup = rt?.boundary.supervisors.find(s => s.managedNodeIds.includes(node.id));
			const supInfo = boundSup ? this.delegate.resolveSupervisorDisplay(boundSup.id) : undefined;
			const parentSupInfo = boundSup?.parentSupervisorId ? this.delegate.resolveSupervisorDisplay(boundSup.parentSupervisorId) : undefined;
			const supRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-sup-btn': node.id,
			})) as HTMLButtonElement;
			append(supRow, $('span.ade-mission-ni-kv-key', {}, localize('adeMissionNiSupKey', "Supervisor")));
			const supVal = append(supRow, $('span.ade-mission-ni-kv-val'));
			if (boundSup && supInfo) {
				append(supVal, $(`span.ade-mission-sup-dot.sup-color-${getMissionSupervisorColorIndex(boundSup.id)}`, { 'aria-hidden': 'true' }));
				const supText = parentSupInfo
					? `${supInfo.label} (${formatTierTag(boundSup.tier)}) ↑ ${parentSupInfo.shortLabel}`
					: `${supInfo.label} (${formatTierTag(boundSup.tier)})`;
				append(supVal, $('span', {}, supText));
			} else {
				append(supVal, $('span.is-muted', {}, localize('adeMissionNiSupAuto', "Auto (Mission Owner)")));
			}
			append(supRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));
			this.contentDisposables.add(addDisposableListener(supRow, EventType.CLICK, () => {
				this.delegate.onOpenSupervisorPopover(node, supRow);
			}));

			// In-Graph Node Role: Worker vs Reviewer (reviews upstream deliverables & can token.reject)
			const currentRoleKind: MissionNodeRoleKind = rt?.boundary.nodeAssignments[node.id]?.roleKind ?? 'worker';
			const nextRoleKind: MissionNodeRoleKind = currentRoleKind === 'reviewer' ? 'worker' : 'reviewer';
			const roleRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-role-btn': node.id,
				'data-node-role-kind': currentRoleKind,
				title: localize('adeMissionNiRoleToggleTip', "Click to toggle between Worker (executes task) and Reviewer (in-graph auditor that can reject tokens upstream)"),
			})) as HTMLButtonElement;
			append(roleRow, $('span.ade-mission-ni-kv-key', {}, localize('adeMissionNiRoleKey', "节点角色")));
			const roleVal = append(roleRow, $('span.ade-mission-ni-kv-val'));
			append(roleVal, $(`span.ade-mission-token-meta-chip${currentRoleKind === 'reviewer' ? '.wave' : ''}`, {},
				currentRoleKind === 'reviewer'
					? localize('adeMissionNiRoleReviewer', "Reviewer · 图内审稿")
					: localize('adeMissionNiRoleWorker', "Worker · 执行员工"),
			));
			append(roleRow, $('span.codicon.codicon-arrow-swap.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));
			this.contentDisposables.add(addDisposableListener(roleRow, EventType.CLICK, () => {
				this.delegate.onToggleNodeRoleKind?.(node, nextRoleKind);
			}));

			// Employee Reuse
			const empRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-emp-btn': node.id,
			})) as HTMLButtonElement;
			append(empRow, $('span.ade-mission-ni-kv-key', {}, localize('adeMissionNiEmpKey', "Employee")));
			const empVal = append(empRow, $('span.ade-mission-ni-kv-val'));
			if (node.employeeName) {
				const seq = (node.employeeTotalOccurrences ?? 0) > 1
					? ` (#${node.employeeOccurrence}/${node.employeeTotalOccurrences})`
					: '';
				append(empVal, $('span', {}, `${node.employeeName}${seq}`));
			} else {
				append(empVal, $('span.is-muted', {}, localize('adeMissionNiEmpStandalone', "Standalone Step")));
			}
			append(empRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));
			this.contentDisposables.add(addDisposableListener(empRow, EventType.CLICK, () => {
				this.delegate.onOpenEmployeePopover(node, empRow);
			}));

			// Execution Host
			const explicitHost = rt?.boundary.nodeAssignments[node.id]?.hostAlias;
			const hostInfo = this.hostCatalog.resolveNodeHostAndOs(explicitHost, linkedAgent);
			const hostRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-host-btn': node.id,
			})) as HTMLButtonElement;
			append(hostRow, $('span.ade-mission-ni-kv-key', {}, localize('adeMissionNiHostKey', "Host")));
			append(hostRow, $('span.ade-mission-ni-kv-val', {}, hostInfo.isRemote ? `${hostInfo.displayHost} (${hostInfo.osLabel})` : `Local · ${hostInfo.osLabel}`));
			append(hostRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));
			this.contentDisposables.add(addDisposableListener(hostRow, EventType.CLICK, () => {
				this.delegate.onOpenHostPopover(node, hostInfo.hostAlias, hostRow);
			}));

			// Engine / Model / Rank
			const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? this.delegate.getFallbackOwnerEngineId();
			const engineName = this.hostCatalog.getEngineDisplayName(engineId);
			const nodeTelemetry = rt?.nodeTelemetry?.[node.id];
			const resolvedModel = linkedAgent?.preferredModel || nodeTelemetry?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineId;
			const resolvedThinking = linkedAgent?.preferredThinking ?? 'medium';
			const rankDef = resolveEffectiveRankDefinition(orgConfig, linkedAgent?.role, linkedAgent ? (this.projectsService?.hasSubordinates(linkedAgent.id) ?? false) : false);
			const assignedTier = rt?.boundary.nodeAssignments[node.id]?.tier ?? rankDef.tier;

			const modelRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-model-btn': node.id,
			})) as HTMLButtonElement;
			append(modelRow, $('span.ade-mission-ni-kv-key', {}, localize('adeMissionNiModelKey', "Model")));
			append(modelRow, $('span.ade-mission-ni-kv-val', {}, `${resolvedModel} · ${resolvedThinking}`));
			append(modelRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));
			if (linkedAgent) {
				this.contentDisposables.add(addDisposableListener(modelRow, EventType.CLICK, () => {
					this.delegate.onOpenModelPopover(node.id, linkedAgent, engineId, modelRow);
				}));
			} else {
				modelRow.disabled = true;
			}

			const engRow = append(cfgGrid, $('button.ade-mission-ni-kv-row', {
				type: 'button',
				'data-ade-inspector-engine-btn': node.id,
			})) as HTMLButtonElement;
			append(engRow, $('span.ade-mission-ni-kv-key', {}, localize('adeMissionNiEngineKey', "Engine / Rank")));
			append(engRow, $('span.ade-mission-ni-kv-val', {}, `${engineName} · ${formatTierTag(assignedTier)} ${rankDef.name}`));
			append(engRow, $('span.codicon.codicon-chevron-right.ade-mission-ni-kv-arrow', { 'aria-hidden': 'true' }));
			if (linkedAgent && this.delegate.canSwitchAgentEngine(linkedAgent)) {
				this.contentDisposables.add(addDisposableListener(engRow, EventType.CLICK, () => {
					this.delegate.onOpenEnginePopover(node.id, linkedAgent, engineId, engRow);
				}));
			} else {
				engRow.disabled = true;
			}

			// Pre-Prompt Peek
			const promptText = this.delegate.getNodePrompt(missionId, node.id).trim();
			const promptSection = append(body, $('.ade-mission-ni-section'));
			const promptHead = append(promptSection, $('.ade-mission-ni-section-head'));
			append(promptHead, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiPromptTitle', "Pre-Prompt")));
			const editPromptBtn = append(promptHead, $('button.ade-mission-ni-mini-btn', {
				type: 'button',
				'data-ade-inspector-prompt-btn': node.id,
			}, promptText ? localize('adeMissionNiEditBtn', "Edit") : localize('adeMissionNiAddBtn', "+ Add"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(editPromptBtn, EventType.CLICK, () => {
				this.delegate.onOpenNodePromptPopover(node, editPromptBtn);
			}));
			append(promptSection, $('.ade-mission-token-text-block.scrollable', {}, promptText || localize('adeMissionNiNoPrompt', "No pre-prompt configured for this node.")));
		}

		// Source Triggers (only for valid entry generator nodes: inDegree === 0 && outDegree >= 1)
		const edges = this.delegate.getEdges();
		const inDegree = edges.filter(e => e.to === node.id).length;
		const outDegree = edges.filter(e => e.from === node.id).length;
		if (inDegree === 0 && outDegree >= 1) {
			const nodeTriggers = (rt?.triggers ?? []).filter(t => t.nodeId === node.id);
			const trigSection = append(body, $('.ade-mission-ni-section'));
			const trigHead = append(trigSection, $('.ade-mission-ni-section-head'));
			append(trigHead, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiTriggersTitle', "Source Triggers ({0})", nodeTriggers.length)));
			const manageTrigBtn = append(trigHead, $('button.ade-mission-ni-mini-btn', {
				type: 'button',
				'data-ade-inspector-triggers-btn': node.id,
			}, localize('adeMissionNiManageTriggers', "Manage"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(manageTrigBtn, EventType.CLICK, () => {
				this.delegate.onOpenTriggersPopover(node.id, manageTrigBtn);
			}));
			if (nodeTriggers.length === 0) {
				append(trigSection, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionNiNoTriggers', "No automated schedule or event triggers attached yet.")));
			} else {
				const trigList = append(trigSection, $('.ade-mission-ni-trigger-chips'));
				for (const trig of nodeTriggers) {
					append(trigList, $(`span.ade-mission-token-meta-chip${trig.enabled ? '.wave' : ''}`, {}, `${formatMissionTriggerShortLabel(trig)}${trig.enabled ? '' : ' (off)'}`));
				}
			}
		}

		// Live Runtime & Quick Recovery Summary
		const runtimeSection = append(body, $('.ade-mission-ni-section'));
		const rtHead = append(runtimeSection, $('.ade-mission-ni-section-head'));
		append(rtHead, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiRuntimeTitle', "Runtime & Quick Actions")));
		if (primaryToken) {
			const inspectTokBtn = append(rtHead, $('button.ade-mission-ni-mini-btn', {
				type: 'button',
				'data-ade-inspector-token-btn': primaryToken.id,
			}, localize('adeMissionNiInspectToken', "Token & Trace →"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(inspectTokBtn, EventType.CLICK, () => {
				this.activeTab = 'token';
				this.refresh();
			}));
		}

		const telemetry = rt?.nodeTelemetry?.[node.id];
		if (telemetry) {
			const ctx = computeMissionNodeContextBreakdown(telemetry);
			append(runtimeSection, $('.ade-mission-ni-telemetry-line', {}, localize(
				'adeMissionNiTelemetryLine',
				"Context: {0}/{1} ({2}%) · Turns: {3}{4}",
				formatCompactTokenCount(ctx.usedTokens),
				formatCompactTokenCount(ctx.maxTokens),
				ctx.usedPct,
				telemetry.turns,
				telemetry.costUsd > 0 ? ` · $${telemetry.costUsd.toFixed(2)}` : '',
			)));
		}

		if (primaryToken) {
			const meta = append(runtimeSection, $('.ade-mission-token-meta-row'));
			append(meta, $('span.ade-mission-token-meta-chip.wave', {}, `${formatMissionWaveTag(primaryToken.waveId)} · ${primaryToken.status}`));
			if (primaryToken.blocked) {
				const rem = formatMissionBlockedRemaining(primaryToken.blocked.expiresAt, Date.now());
				append(meta, $('span.ade-mission-token-meta-chip.warn', {}, `⏳ ${rem.text}`));
			}
			append(runtimeSection, $('.ade-mission-token-text-block.scrollable', {}, primaryToken.failure?.reason || primaryToken.lastSummary?.trim() || localize('adeMissionNiNoTokenSummary', "Token is active; awaiting step summary.")));

			const failedTok = nodeTokens.find(t => t.status === 'frozen_failed');
			const canRecall = primaryToken.status === 'active' || primaryToken.status === 'blocked' || primaryToken.status === 'waiting_gate' || primaryToken.status === 'frozen_failed';
			const actRow = append(runtimeSection, $('.ade-mission-token-actions'));
			if (failedTok) {
				const retryBtn = append(actRow, $('button.ade-mission-token-action-btn.primary', {
					type: 'button',
					'data-ade-ni-retry': node.id,
				}, localize('adeMissionNiRetry', "Retry Node"))) as HTMLButtonElement;
				this.contentDisposables.add(addDisposableListener(retryBtn, EventType.CLICK, () => {
					this.delegate.onQuickRetryNode(node, failedTok);
				}));
			}
			if (node.kind !== 'gate') {
				const distillShortcut = append(actRow, $('button.ade-mission-token-action-btn', {
					type: 'button',
					'data-ade-ni-distill-tab-shortcut': node.id,
				}, localize('adeMissionNiDistillShortcut', "✨ 提纯换血"))) as HTMLButtonElement;
				this.contentDisposables.add(addDisposableListener(distillShortcut, EventType.CLICK, () => {
					this.activeTab = 'distill';
					this.refresh();
				}));
			}
			if (canRecall) {
				const recallBtn = append(actRow, $('button.ade-mission-token-action-btn.danger', {
					type: 'button',
					'data-ade-ni-recall': node.id,
				}, localize('adeMissionNiRecall', "Recall"))) as HTMLButtonElement;
				this.contentDisposables.add(addDisposableListener(recallBtn, EventType.CLICK, () => {
					this.delegate.onQuickRecallNode(node, primaryToken);
				}));
			}
		} else {
			append(runtimeSection, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionNiNoLiveToken', "No token has visited this node yet.")));
		}
	}

	private renderTokenTab(
		body: HTMLElement,
		missionId: string,
		node: IMissionDagNode,
		nodeTokens: readonly IMissionToken[],
		primaryToken: IMissionToken | undefined,
	): void {
		if (!primaryToken || nodeTokens.length === 0) {
			append(body, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionNiTokenEmpty', "No tokens recorded on node {0} yet. Start the Mission to inspect live token summaries & trace pointers.", node.id)));
			return;
		}
		const rememberedId = this.selectedTokenIdByNode.get(node.id);
		const selectedToken = nodeTokens.find(t => t.id === rememberedId) ?? primaryToken;

		if (nodeTokens.length > 1) {
			const switcher = append(body, $('.ade-mission-token-wave-switcher'));
			for (const tok of nodeTokens) {
				const active = tok.id === selectedToken.id;
				const btn = append(switcher, $(`button.ade-mission-token-wave-btn${active ? '.active' : ''}`, {
					type: 'button',
					'data-ade-ni-wave-select': tok.id,
				}, `${formatMissionWaveTag(tok.waveId)} · ${tok.status}`)) as HTMLButtonElement;
				this.contentDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					this.selectedTokenIdByNode.set(node.id, tok.id);
					this.refresh();
				}));
			}
		}

		const meta = append(body, $('.ade-mission-token-meta-row'));
		append(meta, $('span.ade-mission-token-meta-chip', {}, selectedToken.id));
		append(meta, $('span.ade-mission-token-meta-chip.wave', {}, selectedToken.waveId));
		if (selectedToken.fromNodeId) {
			append(meta, $('span.ade-mission-token-meta-chip', {}, `← ${selectedToken.fromNodeId}`));
		}
		if (selectedToken.returnToNodeId) {
			append(meta, $('span.ade-mission-token-meta-chip.rework', {}, `↩ ${selectedToken.returnToNodeId}`));
		}
		if (selectedToken.nudgeCount > 0) {
			append(meta, $('span.ade-mission-token-meta-chip.warn', {}, `Nudges ${selectedToken.nudgeCount}`));
		}

		if (selectedToken.status === 'blocked' && selectedToken.blocked) {
			const b = selectedToken.blocked;
			const rem = formatMissionBlockedRemaining(b.expiresAt, Date.now());
			const box = append(body, $('.ade-mission-token-box.is-blocked'));
			const bHead = append(box, $('.ade-mission-token-box-head'));
			append(bHead, $('span.ade-mission-token-box-label', {}, localize('adeMissionNiBlockedHead', "Blocked Wait")));
			append(bHead, $('span.ade-mission-token-countdown', {}, `⏳ ${rem.text}`));
			append(box, $('.ade-mission-token-box-body', {}, b.reason));
			const wRow = append(box, $('.ade-mission-token-watch-row'));
			if (b.watchPid !== undefined) {
				append(wRow, $('span.ade-mission-token-meta-chip', {}, `PID ${b.watchPid}`));
			}
			if (b.watchFile) {
				append(wRow, $('span.ade-mission-token-meta-chip', { title: b.watchFile }, b.watchFile));
			}
			if (b.hostAlias) {
				append(wRow, $('span.ade-mission-token-meta-chip', {}, `@${b.hostAlias}`));
			}
		}

		if (selectedToken.failure) {
			const fBox = append(body, $('.ade-mission-token-box.is-failed'));
			append(fBox, $('.ade-mission-token-box-label', {}, localize('adeMissionNiFailHead', "Failure & Escalation")));
			append(fBox, $('.ade-mission-token-box-body', {}, selectedToken.failure.reason));
		}

		// Layer 1: Verbatim lastSummary
		const s1 = append(body, $('.ade-mission-ni-section'));
		append(s1, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiLastSummaryLabel', "紧邻上一棒人话总结 (lastSummary)")));
		append(s1, $('.ade-mission-token-text-block.scrollable', {
			'data-ade-ni-last-summary': 'true',
		}, selectedToken.lastSummary?.trim() || localize('adeMissionNiEmptySummary', "No step summary reported yet.")));

		// Layer 2: Rolling compressedHistory
		const s2 = append(body, $('.ade-mission-ni-section'));
		const s2Head = append(s2, $('.ade-mission-ni-section-head'));
		append(s2Head, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiHistoryLabel', "滚动压缩历史 (compressedHistory)")));
		if (selectedToken.historyState && selectedToken.historyState.archivedCount > 0) {
			append(s2Head, $('span.ade-mission-token-meta-chip', {}, localize('adeMissionNiArchivedHops', "{0} archived", selectedToken.historyState.archivedCount)));
		}
		append(s2, $('.ade-mission-token-text-block.scrollable', {
			'data-ade-ni-compressed-history': 'true',
		}, selectedToken.compressedHistory?.trim() || localize('adeMissionNiEmptyHistory', "Entry wave — no prior compressed history.")));

		// Lazy trace_ptr expansion
		const s3 = append(body, $('.ade-mission-ni-section'));
		const s3Head = append(s3, $('.ade-mission-ni-section-head'));
		append(s3Head, $('.ade-mission-ni-section-title', {}, `Trace · ${selectedToken.tracePtr}`));
		const isExpanded = this.expandedTraceTokenIds.has(selectedToken.id);
		const expandBtn = append(s3Head, $('button.ade-mission-token-trace-btn', {
			type: 'button',
			'data-ade-ni-expand-trace': 'true',
		}, isExpanded ? localize('adeMissionNiHideTrace', "Hide Trace") : localize('adeMissionNiExpandTrace', "Expand trace_ptr"))) as HTMLButtonElement;
		this.contentDisposables.add(addDisposableListener(expandBtn, EventType.CLICK, () => {
			if (this.expandedTraceTokenIds.has(selectedToken.id)) {
				this.expandedTraceTokenIds.delete(selectedToken.id);
			} else {
				this.expandedTraceTokenIds.add(selectedToken.id);
			}
			this.refresh();
		}));
		const traceList = append(s3, $('.ade-mission-token-trace-list', {
			'data-ade-ni-trace-list': 'true',
		}));
		traceList.hidden = !isExpanded;
		if (isExpanded) {
			const entries = this.missionRuntimeService?.expandTrace(missionId, selectedToken.tracePtr, 50) ?? [];
			if (entries.length === 0) {
				append(traceList, $('.ade-mission-token-trace-empty', {}, localize('adeMissionNiTraceNone', "No trace entries found.")));
			} else {
				for (const entry of entries) {
					const row = append(traceList, $('.ade-mission-token-trace-row', {
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

		// Inline Retry (with guidance) & Recall
		const canRetry = selectedToken.status === 'frozen_failed' || selectedToken.status === 'recalled';
		const canRecall = selectedToken.status === 'active' || selectedToken.status === 'blocked' || selectedToken.status === 'waiting_gate' || selectedToken.status === 'waiting_join' || selectedToken.status === 'frozen_failed';
		let guidanceInput: HTMLInputElement | undefined;
		if (canRetry) {
			guidanceInput = append(body, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionNiRetryGuidancePh', "Optional retry guidance..."),
			})) as HTMLInputElement;
		}
		if (canRetry || canRecall) {
			const actRow = append(body, $('.ade-mission-token-actions'));
			if (canRetry) {
				const retryBtn = append(actRow, $('button.ade-mission-token-action-btn.primary', {
					type: 'button',
					'data-ade-ni-token-retry': selectedToken.id,
				}, localize('adeMissionNiTokenRetry', "Retry Node"))) as HTMLButtonElement;
				this.contentDisposables.add(addDisposableListener(retryBtn, EventType.CLICK, () => {
					this.delegate.onQuickRetryNode(node, selectedToken, guidanceInput?.value.trim() || undefined);
				}));
			}
			if (canRecall) {
				const recallBtn = append(actRow, $('button.ade-mission-token-action-btn.danger', {
					type: 'button',
					'data-ade-ni-token-recall': selectedToken.id,
				}, localize('adeMissionNiTokenRecall', "Recall"))) as HTMLButtonElement;
				this.contentDisposables.add(addDisposableListener(recallBtn, EventType.CLICK, () => {
					this.delegate.onQuickRecallNode(node, selectedToken);
				}));
			}
		}
	}

	private renderDistillTab(
		body: HTMLElement,
		missionId: string,
		node: IMissionDagNode,
		rt: IMissionRuntimeState | undefined,
		primaryToken: IMissionToken | undefined,
	): void {
		const tel = rt?.nodeTelemetry?.[node.id];
		const ctx = computeMissionNodeContextBreakdown(tel);

		// Thermal Context Window Breakdown
		const thermalSection = append(body, $('.ade-mission-ni-section'));
		const tHead = append(thermalSection, $('.ade-mission-ni-section-head'));
		append(tHead, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiThermalTitle', "上下文热成像切片")));
		append(tHead, $(`span.ade-mission-token-status-badge${ctx.severity === 'critical' ? '.status-frozen-failed' : ctx.severity === 'warn' ? '.status-blocked' : '.status-completed'}`, {}, `${ctx.usedPct}%`));

		const bigTrack = append(thermalSection, $('.ade-mission-ni-thermal-track'));
		const segInit = append(bigTrack, $('.ade-ctx-seg.seg-init'));
		const segTier = append(bigTrack, $('.ade-ctx-seg.seg-tier'));
		const segSrc = append(bigTrack, $('.ade-ctx-seg.seg-source'));
		const segNoise = append(bigTrack, $('.ade-ctx-seg.seg-noise'));
		segInit.style.width = `${ctx.initPct.toFixed(1)}%`;
		segTier.style.width = `${ctx.tierPct.toFixed(1)}%`;
		segSrc.style.width = `${ctx.sourcePct.toFixed(1)}%`;
		segNoise.style.width = `${ctx.noisePct.toFixed(1)}%`;

		const legend = append(thermalSection, $('.ade-mission-ni-thermal-legend'));
		const slices = [
			{ cls: 'seg-init', label: localize('adeMissionSliceInit', "初始化背景"), pct: ctx.initPct, tokens: tel?.contextInitTokens ?? 0 },
			{ cls: 'seg-tier', label: localize('adeMissionSliceTier', "单源契约文档"), pct: ctx.tierPct, tokens: tel?.contextTierDocTokens ?? 0 },
			{ cls: 'seg-source', label: localize('adeMissionSliceSource', "有效工作源码"), pct: ctx.sourcePct, tokens: tel?.contextSourceTokens ?? 0 },
			{ cls: 'seg-noise', label: localize('adeMissionSliceNoise', "报错/返工噪音"), pct: ctx.noisePct, tokens: tel?.contextNoiseTokens ?? 0 },
		];
		for (const sl of slices) {
			const item = append(legend, $('.ade-mission-ni-thermal-item'));
			append(item, $(`span.ade-mission-ni-thermal-dot.${sl.cls}`, { 'aria-hidden': 'true' }));
			append(item, $('span.ade-mission-ni-thermal-name', {}, sl.label));
			append(item, $('span.ade-mission-ni-thermal-val', {}, `${formatCompactTokenCount(sl.tokens)} (${Math.round(sl.pct)}%)`));
		}

		// One-Click 「提纯换血」 Card
		if (node.kind !== 'gate') {
			const distillBox = append(body, $('.ade-mission-ni-distill-card'));
			append(distillBox, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiDistillCardTitle', "一键提纯换血 (Distill & Refresh Agent)")));
			append(distillBox, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionNiDistillDesc', "保留本地/云端磁盘既有代码产物，将历史踩坑提炼为高信噪比备忘，重置臃肿上下文窗口并用干净会话继续执行。")));
			const memoInput = append(distillBox, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionNiDistillMemoPh', "可选：补充踩坑备忘或架构指令..."),
				'data-ade-ni-distill-memo': 'true',
			})) as HTMLInputElement;
			const distillBtn = append(distillBox, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				'data-ade-ni-distill': node.id,
			})) as HTMLButtonElement;
			append(distillBtn, $('span.codicon.codicon-sparkle', { 'aria-hidden': 'true' }));
			append(distillBtn, $('span', {}, localize('adeMissionNiDistillBtn', "执行提纯换血")));
			this.contentDisposables.add(addDisposableListener(distillBtn, EventType.CLICK, () => {
				this.delegate.onDistillNodeContext(node, memoInput.value.trim() || undefined);
			}));
		}

		// Deterministic Verification Checklist (Full CRUD UI for Reviewer Check Hooks)
		const checks = this.missionRuntimeService?.getEffectiveNodeChecks(missionId, node.id)[node.id] ?? [];
		const chkSection = append(body, $('.ade-mission-ni-section'));
		const chkHead = append(chkSection, $('.ade-mission-ni-section-head'));
		append(chkHead, $('.ade-mission-ni-section-title', {}, localize('adeMissionNiChecksTitle', "确定性验收钩子 ({0})", checks.length)));
		const chkHeadActions = append(chkHead, $('.ade-mission-ni-head-actions'));
		if (checks.length > 0) {
			const runChkBtn = append(chkHeadActions, $('button.ade-mission-ni-mini-btn', {
				type: 'button',
				'data-ade-ni-run-checks': node.id,
			}, localize('adeMissionNiRunChecks', "立即验真"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(runChkBtn, EventType.CLICK, () => {
				this.delegate.onRunNodeChecks(node);
			}));
		}
		if (checks.length > 0) {
			for (const chk of checks) {
				const row = append(chkSection, $('.ade-mission-ni-check-row', {
					'data-ade-check-row': chk.id,
				}));
				append(row, $('span.ade-mission-token-meta-chip.wave', {}, chk.name || chk.id));
				append(row, $('span.ade-mission-trace-summary', { title: chk.command || '' }, chk.command || (chk.expectFiles ? `files: ${chk.expectFiles.join(', ')}` : 'check')));
				if (chk.source !== 'mermaid' && this.delegate.onRemoveNodeCheck) {
					const delBtn = append(row, $('button.ade-mission-icon-btn.danger', {
						type: 'button',
						title: localize('adeMissionNiCheckDeleteTip', "Remove verification hook"),
						'data-ade-check-delete': chk.id,
					})) as HTMLButtonElement;
					delBtn.appendChild($('span.codicon.codicon-trash'));
					this.contentDisposables.add(addDisposableListener(delBtn, EventType.CLICK, () => {
						this.delegate.onRemoveNodeCheck?.(node.id, chk.id);
					}));
				}
			}
		} else {
			append(chkSection, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionNiNoChecks', "该节点未配置零 Token 确定性命令/文件校验钩子。")));
		}

		// Inline Add Deterministic Check Hook Form (for task nodes)
		if (node.kind !== 'gate' && this.delegate.onUpsertNodeCheck) {
			const form = append(chkSection, $('.ade-mission-check-add-form', {
				'data-ade-check-add-form': node.id,
			}));
			const nameInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionChkNamePh', "钩子名称（可选，如 unit-tests）"),
				'data-ade-check-name-input': 'true',
			})) as HTMLInputElement;
			const cmdInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionChkCmdPh', "校验命令（如 pnpm test 或 pytest -q）"),
				'data-ade-check-cmd-input': 'true',
			})) as HTMLInputElement;
			const filesInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionChkFilesPh', "必检产物文件（可选，逗号分隔，如 dist/out.js）"),
				'data-ade-check-files-input': 'true',
			})) as HTMLInputElement;
			const matchInput = append(form, $('input.ade-mission-emp-popover-input', {
				type: 'text',
				placeholder: localize('adeMissionChkMatchPh', "输出匹配关键字或 /正则/（可选）"),
				'data-ade-check-match-input': 'true',
			})) as HTMLInputElement;
			const optsRow = append(form, $('.ade-mission-trigger-form-row'));
			const onFailSelect = append(optsRow, $('select.ade-mission-config-select', {
				'data-ade-check-onfail-select': 'true',
				title: localize('adeMissionChkOnFailTip', "Action when verification fails"),
			})) as HTMLSelectElement;
			append(onFailSelect, $('option', { value: 'bounce' }, localize('adeMissionChkOnFailBounce', "打回原员工重试 (bounce)")));
			append(onFailSelect, $('option', { value: 'fail' }, localize('adeMissionChkOnFailFail', "触发失败边 (fail)")));
			append(onFailSelect, $('option', { value: 'escalate' }, localize('adeMissionChkOnFailEscalate', "直接升级监工 (escalate)")));
			const retriesInput = append(optsRow, $('input.ade-mission-config-input', {
				type: 'number',
				min: '0',
				max: '5',
				value: '2',
				title: localize('adeMissionChkRetriesTip', "Max auto-retries before escalation (0..5)"),
				'data-ade-check-retries-input': 'true',
			})) as HTMLInputElement;
			const errEl = append(form, $('.ade-mission-drawer-status.error', { hidden: 'true' }));
			const addBtn = append(form, $('button.ade-mission-ni-btn.primary', {
				type: 'button',
				'data-ade-check-submit': node.id,
			}, localize('adeMissionChkSubmitBtn', "+ 添加确定性校验钩子"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(addBtn, EventType.CLICK, () => {
				const command = cmdInput.value.trim() || undefined;
				const expectFiles = filesInput.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
				if (!command && expectFiles.length === 0) {
					errEl.textContent = localize('adeMissionChkNeedCmdOrFile', "请至少填写校验命令或必检产物文件路径。");
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
				this.delegate.onUpsertNodeCheck?.(node.id, hook);
			}));
		}
		if (tel?.lastCheckSummary || primaryToken?.lastCheckFailure) {
			const fail = tel?.lastCheckStatus === 'failed' || Boolean(primaryToken?.lastCheckFailure);
			const box = append(chkSection, $(`.ade-mission-token-box${fail ? '.is-failed' : '.is-blocked'}`));
			append(box, $('.ade-mission-token-box-body', {}, primaryToken?.lastCheckFailure?.summary || tel?.lastCheckSummary || ''));
		}
	}

	private renderFinOpsTab(
		body: HTMLElement,
		_missionId: string,
		rt: IMissionRuntimeState | undefined,
		nodes: readonly IMissionDagNode[],
	): void {
		const summary = computeMissionFinOpsSummary(rt, nodes, this.delegate.getHostByNodeIdMap());

		// Hero Spend vs Budget Card
		const hero = append(body, $(`.ade-mission-finops-hero.severity-${summary.severity}`, {
			'data-ade-finops-hero': 'true',
		}));
		const heroTop = append(hero, $('.ade-mission-finops-hero-top'));
		append(heroTop, $('span.ade-mission-finops-hero-amount', {
			'data-ade-finops-hero-spend': 'true',
		}, `$${summary.totalCostUsd.toFixed(2)}`));
		append(heroTop, $('span.ade-mission-finops-hero-limit', {}, summary.budgetLimitUsd !== undefined
			? `/ $${summary.budgetLimitUsd.toFixed(2)}`
			: localize('adeMissionFinOpsUnlimitedTag', "/ Unlimited")));

		const heroMeta = append(hero, $('.ade-mission-finops-hero-meta'));
		append(heroMeta, $('span', {}, `${formatCompactTokenCount(summary.totalTokens)} tokens`));
		append(heroMeta, $('span', {}, localize('adeMissionFinOpsCacheDetail', "Cache Saved {0}%", summary.cacheSavingsPct)));

		if (summary.budgetCircuitTripped) {
			const alertBox = append(hero, $('.ade-mission-token-box.is-failed', {
				'data-ade-finops-tripped-banner': 'true',
			}));
			append(alertBox, $('.ade-mission-token-box-body', {}, localize('adeMissionFinOpsTrippedMsg', "预算熔断已触发：Mission 已自动暂停并阻止新令牌派发。请上调预算上限后恢复运行。")));
			const raiseResumeBtn = append(alertBox, $('button.ade-mission-token-action-btn.primary', {
				type: 'button',
				'data-ade-finops-raise-resume': 'true',
			}, localize('adeMissionFinOpsRaiseResumeBtn', "上调额度 (+$5) 并恢复"))) as HTMLButtonElement;
			this.contentDisposables.add(addDisposableListener(raiseResumeBtn, EventType.CLICK, () => {
				const nextLimit = Math.max(summary.totalCostUsd, summary.budgetLimitUsd ?? 0) + 5;
				this.delegate.onRaiseAndResumeBudget(Math.ceil(nextLimit * 100) / 100);
			}));
		}

		// Interactive Budget Circuit-Breaker Slider & Exact USD Input
		const sliderSection = append(body, $('.ade-mission-ni-section'));
		const slHead = append(sliderSection, $('.ade-mission-ni-section-head'));
		append(slHead, $('.ade-mission-ni-section-title', {}, localize('adeMissionFinOpsSliderTitle', "预算熔断上限 ($USD)")));
		const unlimitedBtn = append(slHead, $('button.ade-mission-ni-mini-btn', {
			type: 'button',
			'data-ade-finops-budget-unlimited': 'true',
		}, localize('adeMissionFinOpsSetUnlimited', "不设上限"))) as HTMLButtonElement;
		this.contentDisposables.add(addDisposableListener(unlimitedBtn, EventType.CLICK, () => {
			this.delegate.onSetBudgetLimit(undefined);
		}));

		const sliderRow = append(sliderSection, $('.ade-mission-finops-slider-row'));
		const sliderMax = Math.max(50, Math.ceil((summary.budgetLimitUsd ?? summary.totalCostUsd + 10) * 2));
		const currentVal = summary.budgetLimitUsd ?? 10;
		const slider = append(sliderRow, $('input.ade-mission-finops-slider', {
			type: 'range',
			min: '0.5',
			max: String(sliderMax),
			step: '0.5',
			value: String(currentVal),
			'data-ade-finops-budget-slider': 'true',
		})) as HTMLInputElement;
		const numInput = append(sliderRow, $('input.ade-mission-config-input', {
			type: 'number',
			min: '0',
			step: '0.5',
			value: summary.budgetLimitUsd !== undefined ? String(summary.budgetLimitUsd) : '',
			placeholder: '∞',
			'data-ade-finops-budget-input': 'true',
		})) as HTMLInputElement;

		this.contentDisposables.add(addDisposableListener(slider, EventType.INPUT, () => {
			numInput.value = slider.value;
		}));
		this.contentDisposables.add(addDisposableListener(slider, EventType.CHANGE, () => {
			const val = Number.parseFloat(slider.value);
			if (Number.isFinite(val) && val > 0) {
				this.delegate.onSetBudgetLimit(val);
			}
		}));
		this.contentDisposables.add(addDisposableListener(numInput, EventType.CHANGE, () => {
			const raw = numInput.value.trim();
			if (!raw) {
				this.delegate.onSetBudgetLimit(undefined);
				return;
			}
			const val = Number.parseFloat(raw);
			this.delegate.onSetBudgetLimit(Number.isFinite(val) && val > 0 ? val : undefined);
		}));

		// Per-Rank (L1..LN) Breakdown
		const tierSection = append(body, $('.ade-mission-ni-section', { 'data-ade-finops-by-tier': 'true' }));
		append(tierSection, $('.ade-mission-ni-section-title', {}, localize('adeMissionFinOpsByTierTitle', "按职级拆解账单 (L1..LN)")));
		if (summary.byTier.length === 0) {
			append(tierSection, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionFinOpsNoSpend', "尚无运行花费记录。")));
		} else {
			for (const bucket of summary.byTier) {
				const row = append(tierSection, $('.ade-mission-finops-bar-row'));
				const metaRow = append(row, $('.ade-mission-finops-bar-meta'));
				append(metaRow, $('span.ade-mission-finops-bar-label', {}, `${bucket.label} · ${bucket.nodeCount} node(s)`));
				append(metaRow, $('span.ade-mission-finops-bar-val', {}, `$${bucket.costUsd.toFixed(2)} · ${formatCompactTokenCount(bucket.tokens)} (${bucket.pct}%)`));
				const track = append(row, $('.ade-mission-finops-ledger-track'));
				const fill = append(track, $('.ade-mission-finops-ledger-fill.tier'));
				fill.style.width = `${Math.max(3, bucket.pct)}%`;
			}
		}

		// Per-Host (@Local / @Cloud) Breakdown
		const hostSection = append(body, $('.ade-mission-ni-section', { 'data-ade-finops-by-host': 'true' }));
		append(hostSection, $('.ade-mission-ni-section-title', {}, localize('adeMissionFinOpsByHostTitle', "按跨云/本机算力拆解")));
		if (summary.byHost.length === 0) {
			append(hostSection, $('.ade-mission-ni-muted-hint', {}, localize('adeMissionFinOpsNoHostSpend', "尚无主机算力花费记录。")));
		} else {
			for (const bucket of summary.byHost) {
				const row = append(hostSection, $('.ade-mission-finops-bar-row'));
				const metaRow = append(row, $('.ade-mission-finops-bar-meta'));
				append(metaRow, $('span.ade-mission-finops-bar-label', {}, `${bucket.label} · ${bucket.nodeCount} node(s)`));
				append(metaRow, $('span.ade-mission-finops-bar-val', {}, `$${bucket.costUsd.toFixed(2)} · ${formatCompactTokenCount(bucket.tokens)} (${bucket.pct}%)`));
				const track = append(row, $('.ade-mission-finops-ledger-track'));
				const fill = append(track, $('.ade-mission-finops-ledger-fill.host'));
				fill.style.width = `${Math.max(3, bucket.pct)}%`;
			}
		}

		// Top Spender Nodes (clickable to jump straight to node overview)
		if (summary.byNode.length > 0) {
			const nodeSection = append(body, $('.ade-mission-ni-section'));
			append(nodeSection, $('.ade-mission-ni-section-title', {}, localize('adeMissionFinOpsTopNodesTitle', "节点花费排行")));
			for (const item of summary.byNode.slice(0, 8)) {
				const rowBtn = append(nodeSection, $('button.ade-mission-ni-kv-row', {
					type: 'button',
					'data-ade-finops-node-row': item.nodeId,
				})) as HTMLButtonElement;
				append(rowBtn, $('span.ade-mission-ni-kv-key', {}, `${item.nodeId} · ${item.label}`));
				append(rowBtn, $('span.ade-mission-ni-kv-val', {}, `$${item.costUsd.toFixed(2)} (${formatCompactTokenCount(item.tokens)})`));
				this.contentDisposables.add(addDisposableListener(rowBtn, EventType.CLICK, () => {
					this.activeTab = 'overview';
					this.delegate.onSelectNodeFromInspector(item.nodeId);
				}));
			}
		}
	}
}
