/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	buildMissionContextReusePaths,
	computeOrthogonalRoundedEdgeRoute,
	getMissionEdgeKind,
	IMissionContextReuseAnchor,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionNodePosition,
	IMissionTaskCompletionContract,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { computeMissionDiagnostics } from '../../../../platform/ade/common/adeOrchestrationDiagnostics.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	computeOrchestrationAnchorPoint,
	IOrchestrationGraphNode,
	ORCHESTRATION_ANCHOR_SIDES,
	ORCHESTRATION_SLOTS_PER_SIDE,
	OrchestrationAnchorSide,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import { adeBi } from '../common/adeLocalization.js';
import { measureSvgPillWidth, svgEl } from './adeMissionCanvasEdgeRouter.js';
import { getRenderedOrchestrationNodeSize, sanitizeCssSlug } from './adeMissionOrchCardBuilder.js';

export const MISSION_TASK_CARD_WIDTH = 280;
export const MISSION_TASK_CARD_HEIGHT = 154;
export const MISSION_GATE_CARD_WIDTH = 264;
export const MISSION_GATE_CARD_HEIGHT = 142;

export function getMissionNodeSize(node: IMissionDagNode): { readonly width: number; readonly height: number } {
	return node.kind === 'gate'
		? { width: MISSION_GATE_CARD_WIDTH, height: MISSION_GATE_CARD_HEIGHT }
		: { width: MISSION_TASK_CARD_WIDTH, height: MISSION_TASK_CARD_HEIGHT };
}

export interface IMissionDagTopologySignals {
	readonly incomingById: ReadonlyMap<string, readonly string[]>;
	readonly outgoingById: ReadonlyMap<string, readonly string[]>;
	readonly stageById: ReadonlyMap<string, number>;
	readonly criticalNodeIds: ReadonlySet<string>;
	readonly criticalEdgeKeys: ReadonlySet<string>;
	readonly readyFrontierIds: ReadonlySet<string>;
	readonly activeTokensByTaskId: ReadonlyMap<string, readonly IOrchestrationToken[]>;
	readonly allTokensByTaskId: ReadonlyMap<string, readonly IOrchestrationToken[]>;
}

/**
 * Computes O(V + E) Task DAG topology signals, deterministic critical path, ready frontier
 * (tasks & human gates with all upstreams completed), and live `otok-*` token cross-index.
 */
export function computeMissionTaskDagSignals(
	nodes: readonly IMissionDagNode[],
	edges: readonly IMissionDagEdge[],
	direction: 'LR' | 'TD',
	taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	orchRuntime: IOrchestrationRuntimeState | undefined,
): IMissionDagTopologySignals {
	const incomingById = new Map<string, string[]>();
	const outgoingById = new Map<string, string[]>();
	const inDegLeft = new Map<string, number>();
	for (const n of nodes) {
		incomingById.set(n.id, []);
		outgoingById.set(n.id, []);
		inDegLeft.set(n.id, 0);
	}
	for (const e of edges) {
		if (getMissionEdgeKind(e) === 'fail') {
			outgoingById.get(e.from)?.push(e.to);
			continue;
		}
		incomingById.get(e.to)?.push(e.from);
		outgoingById.get(e.from)?.push(e.to);
		inDegLeft.set(e.to, (inDegLeft.get(e.to) ?? 0) + 1);
	}
	const stageById = new Map<string, number>();
	const bfsQueue: string[] = [];
	for (const n of nodes) {
		if ((inDegLeft.get(n.id) ?? 0) === 0) {
			stageById.set(n.id, 0);
			bfsQueue.push(n.id);
		}
	}
	for (let qi = 0; qi < bfsQueue.length; qi++) {
		const cur = bfsQueue[qi];
		const curStage = stageById.get(cur) ?? 0;
		for (const nxt of outgoingById.get(cur) ?? []) {
			const cand = curStage + 1;
			if (cand > (stageById.get(nxt) ?? 0)) {
				stageById.set(nxt, cand);
			}
			const rem = (inDegLeft.get(nxt) ?? 1) - 1;
			inDegLeft.set(nxt, rem);
			if (rem === 0) {
				bfsQueue.push(nxt);
			}
		}
	}

	const diagnostics = computeMissionDiagnostics({
		taskGraph: { direction, nodes, edges },
		taskStatuses,
		orchState: orchRuntime,
	});
	const criticalNodeIds = new Set<string>(diagnostics.criticalPath.nodeIds);
	const criticalEdgeKeys = new Set<string>();
	const critOrder = diagnostics.criticalPath.nodeIds;
	for (let i = 0; i < critOrder.length - 1; i++) {
		criticalEdgeKeys.add(`${critOrder[i]}->${critOrder[i + 1]}`);
	}

	const readyFrontierIds = new Set<string>(diagnostics.readyTaskIds);
	// Also mark ready human gates (all upstreams completed, status pending/not completed)
	for (const node of nodes) {
		if (node.kind !== 'gate') {
			continue;
		}
		const rec = taskStatuses?.[node.id];
		const st = rec?.status ?? 'pending';
		const preds = incomingById.get(node.id) ?? [];
		const allDone = preds.length === 0 || preds.every(pid => taskStatuses?.[pid]?.status === 'completed');
		if (st !== 'completed' && st !== 'in_progress' && allDone) {
			readyFrontierIds.add(node.id);
		}
	}

	const activeTokensByTaskId = new Map<string, IOrchestrationToken[]>();
	const allTokensByTaskId = new Map<string, IOrchestrationToken[]>();
	if (orchRuntime) {
		const isLive = (st: IOrchestrationToken['status']) => st === 'active' || st === 'blocked' || st === 'waiting_join';
		const statusRank = (st: IOrchestrationToken['status']) => st === 'active' ? 0 : st === 'blocked' ? 1 : st === 'waiting_join' ? 2 : 3;
		for (const tok of Object.values(orchRuntime.tokens)) {
			const boundIds = new Set<string>();
			if (tok.taskNodeId) {
				boundIds.add(tok.taskNodeId);
			}
			if (tok.taskNodeIds) {
				for (const tid of tok.taskNodeIds) {
					if (tid) {
						boundIds.add(tid);
					}
				}
			}
			for (const tid of boundIds) {
				const allArr = allTokensByTaskId.get(tid) ?? [];
				allArr.push(tok);
				allTokensByTaskId.set(tid, allArr);
				if (isLive(tok.status)) {
					const activeArr = activeTokensByTaskId.get(tid) ?? [];
					activeArr.push(tok);
					activeTokensByTaskId.set(tid, activeArr);
				}
			}
		}
		for (const arr of activeTokensByTaskId.values()) {
			arr.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.arrivedAt - a.arrivedAt);
		}
		for (const arr of allTokensByTaskId.values()) {
			arr.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.arrivedAt - a.arrivedAt);
		}
	}

	return {
		incomingById,
		outgoingById,
		stageById,
		criticalNodeIds,
		criticalEdgeKeys,
		readyFrontierIds,
		activeTokensByTaskId,
		allTokensByTaskId,
	};
}

interface IContractRequirementBadge {
	readonly glyph: string;
	readonly met: boolean;
	readonly label: string;
}

function evaluateContractBadges(
	node: IMissionDagNode,
	contract: IMissionTaskCompletionContract | undefined,
	statusRec: IMissionTaskStatusRecord | undefined,
	boundTokens: readonly IOrchestrationToken[],
): readonly IContractRequirementBadge[] {
	if (!contract) {
		return [];
	}
	const out: IContractRequirementBadge[] = [];
	const receipt = statusRec?.lastCheckReceipt;
	const isReceiptFresh = Boolean(receipt && (!statusRec?.lastReworkAt || receipt.checkedAt >= statusRec.lastReworkAt));
	if (contract.requireChecksPassed) {
		out.push({
			glyph: '✓',
			met: Boolean(receipt?.passed && isReceiptFresh),
			label: adeBi(localize('adeContractReqChecks', "Deterministic checks passed"), '门禁检查需通过'),
		});
	}
	if (contract.requireArtifact) {
		const hasArt = (statusRec?.artifactPtrs?.length ?? 0) > 0
			|| boundTokens.some(t => (t.contextRefs?.some(r => r.kind === 'artifact' || r.kind === 'decision')) ?? false);
		out.push({
			glyph: '◈',
			met: hasArt,
			label: adeBi(localize('adeContractReqArtifact', "Artifact or decision pointer required"), '需附带产物或决策指针'),
		});
	}
	if (contract.requireFiles) {
		const hasFiles = (statusRec?.touchedFiles?.length ?? 0) > 0
			|| boundTokens.some(t => (t.touchedFiles?.length ?? 0) > 0);
		out.push({
			glyph: '◫',
			met: hasFiles,
			label: adeBi(localize('adeContractReqFiles', "Modified files evidence required"), '需记录变更文件清单'),
		});
	}
	if (contract.requiredWhiteboardIds && contract.requiredWhiteboardIds.length > 0) {
		const wbSet = new Set<string>();
		for (const t of boundTokens) {
			for (const p of t.whiteboardPointers ?? []) {
				wbSet.add(p.whiteboardId);
			}
			for (const r of t.contextRefs ?? []) {
				if (r.kind === 'whiteboard') {
					wbSet.add(r.ptr.replace(/^wb:/, ''));
				}
			}
		}
		const allWbMet = contract.requiredWhiteboardIds.every(id => wbSet.has(id));
		out.push({
			glyph: `WB:${contract.requiredWhiteboardIds.length}`,
			met: allWbMet,
			label: adeBi(
				localize('adeContractReqWb', "Required whiteboards: {0}", contract.requiredWhiteboardIds.join(', ')),
				'需同步白板：{0}',
				contract.requiredWhiteboardIds.join(', '),
			),
		});
	}
	if (contract.minSummaryChars && contract.minSummaryChars > 0) {
		const summaryLen = (statusRec?.note ?? '').trim().length;
		out.push({
			glyph: `≥${contract.minSummaryChars}`,
			met: summaryLen >= contract.minSummaryChars || statusRec?.status === 'completed',
			label: adeBi(
				localize('adeContractReqSummary', "Minimum completion summary: {0} chars", contract.minSummaryChars),
				'验收总结至少 {0} 字符',
				contract.minSummaryChars,
			),
		});
	}
	return out;
}

export interface ITaskCardDomRefs {
	readonly rootEl: HTMLElement;
	readonly cardEl: HTMLElement;
	readonly idWrapEl: HTMLElement;
	readonly iconEl: HTMLElement;
	readonly roleTagEl?: HTMLElement;
	readonly colorTriggerWrapEl: HTMLElement;
	readonly headRightEl: HTMLElement;
	readonly statusPillEl: HTMLElement;
	readonly deptPillEl?: HTMLElement;
	readonly coreWellEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly promptPreviewEl: HTMLElement;
	readonly contractStripEl: HTMLElement;
	readonly footerLeftEl: HTMLElement;
	readonly footerRightEl: HTMLElement;
	readonly inPortEl: HTMLElement;
	readonly outPortEl: HTMLButtonElement;
	depBtnEl?: HTMLButtonElement;
	readonly dynamicDisposables: DisposableStore;
	lastColorKey: string;
	lastMetaSignature: string;
	lastDagRole: string;
	lastTaskStatus: string;
}

export interface ITaskCardBuildContext {
	readonly nodesLayerEl: HTMLElement;
	readonly graphDisposables: DisposableStore;
	readonly applyCustomNodeColor: (nodeEl: HTMLElement, rawColor: string | undefined) => void;
	readonly mountNodeColorTrigger: (parentEl: HTMLElement, nodeId: string, label: string, rawColor: string | undefined, store: DisposableStore) => void;
	readonly bindOutPortConnectDrag: (node: IMissionDagNode, outPortEl: HTMLButtonElement) => void;
	readonly startInlineNodeRename: (nodeId: string) => void;
	readonly getEffectiveNodeChecksCount?: (nodeId: string) => number;
	readonly resolveStaffLabel: (staffNodeId: string) => string;
	readonly onOpenMissionTaskPopover?: (node: IMissionDagNode, anchorEl: HTMLElement, options?: { readonly focusSection?: 'contract' | 'checks' }) => void;
	readonly onOpenOrchestrationTokenPopover?: (staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement, options?: { readonly focusSection?: 'barrier' | 'scope' | 'rework'; readonly staffNodeId?: string }) => void;
	readonly onJumpToOrchestrationStaff?: (staffNodeId: string, options?: { readonly focusTokenId?: string; readonly openPopover?: 'token' }) => void;
	readonly onToggleDepTrace: (nodeId: string) => void;
	readonly onHoverDepTrace: (nodeId: string | undefined) => void;
	readonly onRenameNodeAvailable: boolean;
}

export interface ITaskCardPatchInput {
	readonly node: IMissionDagNode;
	readonly pos: IMissionNodePosition;
	readonly rawDesc: string;
	readonly statusRec: IMissionTaskStatusRecord | undefined;
	readonly allTaskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
	readonly signals: IMissionDagTopologySignals;
	readonly pinnedDepTraceNodeId: string | undefined;
}

function resolveTaskStatusBadgeText(taskStatus: string, isGate: boolean, isReadyFrontier: boolean): string {
	if (taskStatus === 'completed') {
		return adeBi(localize('adeMissionTaskDoneBadge', "Completed ✓"), '已完成 ✓');
	}
	if (isGate && (taskStatus === 'in_progress' || isReadyFrontier)) {
		return adeBi(localize('adeMissionGateWaitingBadge', "Waiting Gate"), '等待审批');
	}
	if (taskStatus === 'in_progress') {
		return adeBi(localize('adeMissionTaskInProgBadge', "In Progress"), '进行中');
	}
	if (taskStatus === 'blocked') {
		return adeBi(localize('adeMissionTaskBlockedBadge', "Blocked"), '阻塞中');
	}
	if (isReadyFrontier) {
		return adeBi(localize('adeMissionTaskReadyBadge', "Ready"), '可执行');
	}
	return adeBi(localize('adeMissionTaskPendingBadge', "Pending"), '待完成');
}

function resolveTaskIconClass(taskStatus: string, isGate: boolean): string {
	return taskStatus === 'completed'
		? 'codicon-pass-filled'
		: taskStatus === 'in_progress'
			? 'codicon-sync'
			: taskStatus === 'blocked'
				? 'codicon-warning'
				: isGate
					? 'codicon-shield'
					: 'codicon-circle-large-outline';
}

export function buildMissionTaskCardDom(
	input: ITaskCardPatchInput,
	ctx: ITaskCardBuildContext,
): ITaskCardDomRefs {
	const { node, pos, statusRec, signals } = input;
	const isGate = node.kind === 'gate';
	const preds = signals.incomingById.get(node.id) ?? [];
	const succs = signals.outgoingById.get(node.id) ?? [];
	const inDeg = preds.length;
	const outDeg = succs.length;
	const dagRole = inDeg === 0 && outDeg > 0
		? 'entry'
		: inDeg >= 2
			? 'join'
			: outDeg === 0 && inDeg > 0
				? 'terminal'
				: 'step';
	const taskStatus = statusRec?.status ?? 'pending';
	const statusSlug = sanitizeCssSlug(taskStatus.replace(/_/g, '-'));

	const nodeClasses = [
		'ade-mission-node',
		'kind-mission-task',
		'is-sculpted-task',
		isGate ? 'is-gate-task' : '',
		`dag-role-${dagRole}`,
		`task-status-${statusSlug}`,
	].filter(Boolean).join('.');

	const nodeEl = append(ctx.nodesLayerEl, $(`.${nodeClasses}`, {
		'data-node-id': node.id,
		'data-node-kind': 'mission-task',
		'data-dag-node-kind': node.kind,
		'data-node-shape': isGate ? 'gate-card' : 'sculpted-card',
		'data-task-status': taskStatus,
		'data-dag-in-degree': String(inDeg),
		'data-dag-out-degree': String(outDeg),
	}));
	nodeEl.style.left = `${pos.x}px`;
	nodeEl.style.top = `${pos.y}px`;
	ctx.applyCustomNodeColor(nodeEl, node.color);

	const cardEl = append(nodeEl, $(`.ade-mission-node-card.is-task-card.is-sculpted-task${isGate ? '.is-gate-card' : ''}`));
	append(cardEl, $('.ade-mission-task-accent-rail', { 'aria-hidden': 'true' }));

	// 1. Precision Header Bar
	const topRow = append(cardEl, $('.ade-mission-node-top.is-task-top'));
	const idWrapEl = append(topRow, $('span.ade-mission-node-id-wrap'));
	const iconEl = append(idWrapEl, $(`span.codicon.${resolveTaskIconClass(taskStatus, isGate)}.ade-mission-task-ico`, { 'aria-hidden': 'true' }));
	append(idWrapEl, $('span.ade-mission-node-id', { title: node.id }, node.id));
	let roleTagEl: HTMLElement | undefined;
	if (isGate) {
		roleTagEl = append(idWrapEl, $('span.ade-mission-task-role-tag.is-gate-tag', {}, adeBi(localize('adeMissionGateShortTag', "GATE"), '门禁')));
	} else {
		roleTagEl = append(idWrapEl, $('span.ade-mission-task-role-tag'));
		roleTagEl.hidden = true;
	}
	const colorTriggerWrapEl = append(idWrapEl, $('span.ade-node-color-trigger-slot'));

	const headRightEl = append(topRow, $('span.ade-mission-task-head-right'));
	let deptPillEl: HTMLElement | undefined;
	if (node.department) {
		deptPillEl = append(headRightEl, $('span.ade-mission-task-dept-pill', {
			'data-ade-task-dept': node.id,
			title: node.department,
		}, node.department));
	}
	const statusPillEl = append(headRightEl, $(`span.ade-mission-task-status-pill.status-${statusSlug}`, {
		'data-ade-task-status-pill': node.id,
	}, ''));

	// 2. Recessed Core Well (Title + Spec Preview + Compact Round-2 Contract/Evidence Strip)
	const coreWellEl = append(cardEl, $(`.ade-mission-task-well${isGate ? '.is-gate-well' : ''}`));
	if (isGate) {
		for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
			append(coreWellEl, $(`.ade-mission-clamp.${corner}`, { 'aria-hidden': 'true' }));
		}
	}
	const titleEl = append(coreWellEl, $('.ade-mission-node-title.is-task-title', { title: node.label }, node.label));
	const promptPreviewEl = append(coreWellEl, $('.ade-mission-task-desc-preview', {
		'data-ade-node-prompt-preview': node.id,
	}));
	const contractStripEl = append(coreWellEl, $('.ade-mission-contract-strip'));
	contractStripEl.hidden = true;

	// 3. Structured Footer Bar
	const footerRow = append(cardEl, $('.ade-mission-task-footer'));
	const footerLeftEl = append(footerRow, $('.ade-mission-task-footer-left'));
	const footerRightEl = append(footerRow, $('.ade-mission-task-footer-right'));

	// 4. Perimeter Connection Sockets
	const inPortEl = append(cardEl, $('.ade-mission-port.port-in', { 'aria-hidden': 'true' }));
	const outPortEl = append(cardEl, $('button.ade-mission-port.port-out.is-connectable', {
		type: 'button',
		'data-ade-connect-port': node.id,
		title: adeBi(localize('adeMissionTaskConnectTip', "Drag to another task node to create a dependency edge"), '拖拽到另一个任务节点建立有向依赖边'),
	})) as HTMLButtonElement;
	ctx.bindOutPortConnectDrag(node, outPortEl);

	if (ctx.onRenameNodeAvailable) {
		ctx.graphDisposables.add(addDisposableListener(titleEl, EventType.DBLCLICK, e => {
			e.stopPropagation();
			ctx.startInlineNodeRename(node.id);
		}));
	}

	const dynamicDisposables = ctx.graphDisposables.add(new DisposableStore());
	const refs: ITaskCardDomRefs = {
		rootEl: nodeEl,
		cardEl,
		idWrapEl,
		iconEl,
		roleTagEl,
		colorTriggerWrapEl,
		headRightEl,
		statusPillEl,
		deptPillEl,
		coreWellEl,
		titleEl,
		promptPreviewEl,
		contractStripEl,
		footerLeftEl,
		footerRightEl,
		inPortEl,
		outPortEl,
		dynamicDisposables,
		lastColorKey: '',
		lastMetaSignature: '',
		lastDagRole: dagRole,
		lastTaskStatus: taskStatus,
	};

	patchMissionTaskCardDom(refs, input, ctx);
	return refs;
}

export function patchMissionTaskCardDom(
	refs: ITaskCardDomRefs,
	input: ITaskCardPatchInput,
	ctx: ITaskCardBuildContext,
): void {
	const { node, pos, rawDesc, statusRec, allTaskStatuses, signals, pinnedDepTraceNodeId } = input;
	const isGate = node.kind === 'gate';
	const taskStatus = statusRec?.status ?? 'pending';
	const statusSlug = sanitizeCssSlug(taskStatus.replace(/_/g, '-'));

	const preds = signals.incomingById.get(node.id) ?? [];
	const succs = signals.outgoingById.get(node.id) ?? [];
	const inDeg = preds.length;
	const outDeg = succs.length;

	// Position update (skip if dragging so we never fight active pointer movement)
	if (!refs.rootEl.classList.contains('dragging')) {
		const leftStr = `${pos.x}px`;
		const topStr = `${pos.y}px`;
		if (refs.rootEl.style.left !== leftStr) {
			refs.rootEl.style.left = leftStr;
		}
		if (refs.rootEl.style.top !== topStr) {
			refs.rootEl.style.top = topStr;
		}
	}

	// Custom color & color button
	const nextColorKey = `${node.color ?? ''}|${node.label}`;
	if (refs.lastColorKey !== nextColorKey) {
		refs.lastColorKey = nextColorKey;
		ctx.applyCustomNodeColor(refs.rootEl, node.color);
	}

	// Title (preserve active inline-rename input!)
	if (refs.titleEl.firstElementChild?.tagName !== 'INPUT') {
		if (refs.titleEl.textContent !== node.label) {
			refs.titleEl.textContent = node.label;
		}
		if (refs.titleEl.title !== node.label) {
			refs.titleEl.title = node.label;
		}
	}

	// Description preview
	const singleLineDesc = rawDesc ? rawDesc.replace(/\s+/g, ' ') : '';
	const descDisplay = singleLineDesc || adeBi(localize('adeMissionTaskEmptyDescShortHint', "Click to edit details…"), '点击编辑任务详情…');
	if (refs.promptPreviewEl.textContent !== descDisplay) {
		refs.promptPreviewEl.textContent = descDisplay;
	}
	refs.promptPreviewEl.classList.toggle('is-empty', !rawDesc);
	if (rawDesc) {
		if (refs.promptPreviewEl.title !== rawDesc) {
			refs.promptPreviewEl.title = rawDesc;
		}
	} else {
		refs.promptPreviewEl.removeAttribute('title');
	}

	// Diagnostics: Critical Path & Ready Frontier
	const isCritical = signals.criticalNodeIds.has(node.id);
	const isReadyFrontier = signals.readyFrontierIds.has(node.id);
	refs.rootEl.classList.toggle('is-critical-path', isCritical);
	if (isCritical) {
		refs.rootEl.setAttribute('data-critical-path', 'true');
	} else {
		refs.rootEl.removeAttribute('data-critical-path');
	}
	refs.rootEl.classList.toggle('is-ready-frontier', isReadyFrontier);
	if (isReadyFrontier) {
		refs.rootEl.setAttribute('data-ready-frontier', 'true');
	} else {
		refs.rootEl.removeAttribute('data-ready-frontier');
	}

	// Status classes & header icon/pill
	if (refs.lastTaskStatus !== taskStatus) {
		refs.rootEl.classList.remove(`task-status-${sanitizeCssSlug(refs.lastTaskStatus.replace(/_/g, '-'))}`);
		refs.rootEl.classList.add(`task-status-${statusSlug}`);
		refs.rootEl.setAttribute('data-task-status', taskStatus);
		refs.lastTaskStatus = taskStatus;
	}
	const nextIconCls = `codicon ${resolveTaskIconClass(taskStatus, isGate)} ade-mission-task-ico`;
	if (refs.iconEl.className !== nextIconCls) {
		refs.iconEl.className = nextIconCls;
	}
	const nextStatusText = resolveTaskStatusBadgeText(taskStatus, isGate, isReadyFrontier);
	const isGateWaiting = isGate && (isReadyFrontier || taskStatus === 'in_progress');
	const nextStatusPillCls = `ade-mission-task-status-pill status-${statusSlug}${isReadyFrontier && !isGate ? ' is-ready-frontier' : ''}${isGateWaiting ? ' is-needs-approval' : ''}`;
	if (refs.statusPillEl.className !== nextStatusPillCls) {
		refs.statusPillEl.className = nextStatusPillCls;
	}
	if (refs.statusPillEl.textContent !== nextStatusText) {
		refs.statusPillEl.textContent = nextStatusText;
	}

	// Update degree & role attributes
	refs.rootEl.setAttribute('data-dag-in-degree', String(inDeg));
	refs.rootEl.setAttribute('data-dag-out-degree', String(outDeg));
	const dagRole = inDeg === 0 && outDeg > 0
		? 'entry'
		: inDeg >= 2
			? 'join'
			: outDeg === 0 && inDeg > 0
				? 'terminal'
				: 'step';
	if (refs.lastDagRole !== dagRole) {
		refs.rootEl.classList.remove(`dag-role-${refs.lastDagRole}`);
		refs.rootEl.classList.add(`dag-role-${dagRole}`);
		refs.lastDagRole = dagRole;
	}
	if (!isGate && refs.roleTagEl) {
		if (dagRole === 'entry') {
			refs.roleTagEl.hidden = false;
			refs.roleTagEl.className = 'ade-mission-task-role-tag is-entry-tag';
			refs.roleTagEl.textContent = adeBi(localize('adeMissionEntryShortTag', "START"), '起点');
		} else if (dagRole === 'terminal') {
			refs.roleTagEl.hidden = false;
			refs.roleTagEl.className = 'ade-mission-task-role-tag is-terminal-tag';
			refs.roleTagEl.textContent = adeBi(localize('adeMissionFinalShortTag', "FINAL"), '终验');
		} else {
			refs.roleTagEl.hidden = true;
			refs.roleTagEl.textContent = '';
		}
	}

	// Department pill text sync
	if (refs.deptPillEl && node.department && refs.deptPillEl.textContent !== node.department) {
		refs.deptPillEl.textContent = node.department;
		refs.deptPillEl.title = node.department;
	}

	let doneUpCount = 0;
	let upstreamArtCount = 0;
	for (const pid of preds) {
		const upRec = allTaskStatuses?.[pid];
		if (upRec?.status === 'completed') {
			doneUpCount++;
		}
		upstreamArtCount += upRec?.artifactPtrs?.length ?? 0;
	}
	const allUpstreamReady = inDeg >= 1 && doneUpCount === inDeg;

	// Sync in-port socket states
	refs.inPortEl.classList.toggle('is-source-entry', inDeg === 0);
	refs.inPortEl.classList.toggle('is-join-socket', inDeg >= 2);
	refs.inPortEl.classList.toggle('is-deps-ready', allUpstreamReady);

	// Resolve bound live tokens & checks receipt & contract
	const liveTokens = signals.activeTokensByTaskId.get(node.id) ?? [];
	const allBoundTokens = signals.allTokensByTaskId.get(node.id) ?? [];
	const primaryTok = liveTokens[0];
	const checksCount = ctx.getEffectiveNodeChecksCount?.(node.id) ?? (node.checks?.length ?? 0);
	const receipt = statusRec?.lastCheckReceipt;
	const isReceiptFresh = Boolean(receipt && (!statusRec?.lastReworkAt || receipt.checkedAt >= statusRec.lastReworkAt));
	const checkState: 'pass' | 'fail' | 'configured' = receipt && isReceiptFresh
		? (receipt.passed ? 'pass' : 'fail')
		: 'configured';
	const contractBadges = evaluateContractBadges(node, node.completionContract, statusRec, allBoundTokens);
	const touchedFiles = statusRec?.touchedFiles ?? [];
	const artCnt = statusRec?.artifactPtrs?.length ?? 0;
	const activeTokCnt = Math.max(liveTokens.length, statusRec?.activeTokenIds?.length ?? 0);
	const assigneeNodeId = primaryTok?.nodeId
		|| statusRec?.assigneeNodeId
		|| node.assigneeNodeId
		|| node.ownerNodeId;
	const execLabel = (primaryTok ? ctx.resolveStaffLabel(primaryTok.nodeId) : undefined)
		|| statusRec?.assigneeLabel
		|| (assigneeNodeId ? ctx.resolveStaffLabel(assigneeNodeId) : undefined)
		|| node.employeeName;
	const maxAttempt = liveTokens.reduce((mx, t) => Math.max(mx, t.attemptNumber ?? 1), 1);
	const reworkCat = primaryTok?.reworkCategory ?? liveTokens.find(t => t.reworkCategory)?.reworkCategory;
	const isDepPinned = pinnedDepTraceNodeId === node.id;

	const metaSig = JSON.stringify([
		node.color ?? '',
		node.label,
		node.department ?? '',
		taskStatus,
		doneUpCount,
		inDeg,
		upstreamArtCount,
		checksCount,
		checkState,
		receipt?.summary ?? '',
		receipt?.checkCount ?? 0,
		contractBadges.map(b => `${b.glyph}:${b.met ? 1 : 0}:${b.label}`),
		node.checks?.map(c => `${c.id}:${c.name ?? ''}:${c.command ?? ''}`).join('|') ?? '',
		touchedFiles.join(','),
		artCnt,
		activeTokCnt,
		primaryTok?.id ?? '',
		primaryTok?.status ?? '',
		assigneeNodeId ?? '',
		execLabel ?? '',
		statusRec?.completedByLabel ?? '',
		statusRec?.durationMs ?? 0,
		statusRec?.lastError ?? '',
		maxAttempt,
		reworkCat ?? '',
		node.minCompleterTier ?? '',
		isDepPinned,
		signals.stageById.get(node.id) ?? 0,
	]);

	if (refs.lastMetaSignature === metaSig) {
		return;
	}
	refs.lastMetaSignature = metaSig;

	// Clear & re-bind dynamic chip listeners cleanly (zero leaks!)
	refs.dynamicDisposables.clear();
	// Re-mount color trigger into dynamic store so its listener stays alive
	clearNode(refs.colorTriggerWrapEl);
	ctx.mountNodeColorTrigger(refs.colorTriggerWrapEl, node.id, node.label, node.color, refs.dynamicDisposables);

	// 1. Compact Round-2 Contract / Evidence Micro-Strip inside Core Well
	clearNode(refs.contractStripEl);
	const showContractStrip = contractBadges.length > 0
		|| (isGate && upstreamArtCount > 0)
		|| touchedFiles.length > 0
		|| maxAttempt > 1
		|| Boolean(reworkCat);

	if (showContractStrip) {
		refs.contractStripEl.hidden = false;
		refs.promptPreviewEl.classList.add('is-compact-line');

		if (contractBadges.length > 0) {
			const metCount = contractBadges.filter(b => b.met).length;
			const allMet = metCount === contractBadges.length;
			const contractBtn = append(refs.contractStripEl, $(`button.ade-mission-contract-pill${allMet ? '.is-met' : '.is-pending'}`, {
				type: 'button',
				'data-ade-task-contract': node.id,
				'data-contract-status': allMet ? 'met' : 'pending',
				title: contractBadges.map(b => `${b.met ? '✓' : '○'} ${b.label}`).join('\n'),
			})) as HTMLButtonElement;
			for (const badge of contractBadges) {
				append(contractBtn, $(`span.ade-mission-contract-glyph${badge.met ? '.is-met' : ''}`, {}, badge.glyph));
			}
			refs.dynamicDisposables.add(addDisposableListener(contractBtn, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onOpenMissionTaskPopover?.(node, contractBtn, { focusSection: 'contract' });
			}));
		} else if (isGate && upstreamArtCount > 0) {
			append(refs.contractStripEl, $('span.ade-mission-contract-pill.is-gate-evidence', {
				title: upstreamArtCount === 1
					? adeBi(localize('adeGateUpstreamOneEvidenceTip', "1 upstream artifact ready for review"), '已有 1 份上游产物等待审批')
					: adeBi(localize('adeGateUpstreamEvidenceTip', "{0} upstream artifacts ready for review", upstreamArtCount), '已有 {0} 份上游产物等待审批', upstreamArtCount),
			}, upstreamArtCount === 1
				? adeBi(localize('adeGateUpstreamOneEvidenceChip', "◈ 1 artifact"), '◈ 1 份产物')
				: adeBi(localize('adeGateUpstreamEvidenceChip', "◈ {0} artifacts", upstreamArtCount), '◈ {0} 份产物', upstreamArtCount)));
		}

		if (touchedFiles.length > 0) {
			const filesBtn = append(refs.contractStripEl, $('button.ade-mission-contract-pill.is-files', {
				type: 'button',
				'data-ade-task-files': node.id,
				title: touchedFiles.slice(0, 8).join('\n') + (touchedFiles.length > 8 ? `\n+${touchedFiles.length - 8}…` : ''),
			}, `◫ ${touchedFiles.length}f`)) as HTMLButtonElement;
			refs.dynamicDisposables.add(addDisposableListener(filesBtn, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onOpenMissionTaskPopover?.(node, filesBtn, { focusSection: 'checks' });
			}));
		}

		if (maxAttempt > 1 || reworkCat) {
			const reworkText = reworkCat ? `↻ #${maxAttempt} · ${reworkCat}` : `↻ #${maxAttempt}`;
			const reworkBtn = append(refs.contractStripEl, $('button.ade-mission-contract-pill.is-rework', {
				type: 'button',
				'data-ade-task-rework': node.id,
				title: primaryTok?.rejectionReason || primaryTok?.failureReason || adeBi(
					localize('adeTaskReworkTip', "Attempt #{0} — click to inspect rework history", maxAttempt),
					'第 {0} 次返工尝试 — 点击查看返工记录',
					maxAttempt,
				),
			}, reworkText)) as HTMLButtonElement;
			refs.dynamicDisposables.add(addDisposableListener(reworkBtn, EventType.CLICK, e => {
				e.stopPropagation();
				if (primaryTok && ctx.onOpenOrchestrationTokenPopover) {
					ctx.onOpenOrchestrationTokenPopover(ctx.resolveStaffLabel(primaryTok.nodeId), primaryTok, reworkBtn, {
						focusSection: 'rework',
						staffNodeId: primaryTok.nodeId,
					});
				} else {
					ctx.onOpenMissionTaskPopover?.(node, reworkBtn, { focusSection: 'checks' });
				}
			}));
		}
	} else {
		refs.contractStripEl.hidden = true;
		refs.promptPreviewEl.classList.remove('is-compact-line');
	}

	// 2. Structured Footer Left
	clearNode(refs.footerLeftEl);
	const hasDoneFooter = taskStatus === 'completed' && Boolean(statusRec?.completedByLabel);
	const hasDuration = Boolean(statusRec?.durationMs && statusRec.durationMs >= 1000);
	const hasLiveMeta = !hasDoneFooter && Boolean(
		execLabel
		|| activeTokCnt > 0
		|| artCnt > 0
		|| hasDuration
		|| statusRec?.lastError,
	);
	const liveMetaContainer = hasLiveMeta
		? append(refs.footerLeftEl, $('.ade-mission-task-live-meta', { 'data-ade-task-live-meta': node.id }))
		: refs.footerLeftEl;

	if (hasDoneFooter && statusRec?.completedByLabel) {
		const doneBtn = assigneeNodeId && ctx.onJumpToOrchestrationStaff
			? append(refs.footerLeftEl, $('button.ade-mission-task-done-footer.is-clickable', {
				type: 'button',
				'data-ade-jump-staff': assigneeNodeId,
				title: adeBi(
					localize('adeMissionTaskDoneByJump', "Verified by {0} — click to jump to Staff card", statusRec.completedByLabel),
					'已由 {0} 验收标注完成 — 点击定位到员工节点',
					statusRec.completedByLabel,
				),
			}, `✓ ${statusRec.completedByLabel}`)) as HTMLButtonElement
			: append(refs.footerLeftEl, $('.ade-mission-task-done-footer', {
				title: adeBi(
					localize('adeMissionTaskDoneBy', "Verified by {0}", statusRec.completedByLabel),
					'已由 {0} 验收标注完成',
					statusRec.completedByLabel,
				),
			}, `✓ ${statusRec.completedByLabel}`));
		if (assigneeNodeId && ctx.onJumpToOrchestrationStaff) {
			refs.dynamicDisposables.add(addDisposableListener(doneBtn, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onJumpToOrchestrationStaff?.(assigneeNodeId);
			}));
		}
	} else if (execLabel) {
		const isLiveHeld = Boolean(primaryTok);
		if (assigneeNodeId && ctx.onJumpToOrchestrationStaff) {
			const jumpBtn = append(liveMetaContainer, $(`button.ade-mission-task-live-chip.is-assignee${isLiveHeld ? '.is-live-holder' : ''}`, {
				type: 'button',
				'data-ade-jump-staff': assigneeNodeId,
				title: adeBi(
					localize('adeMissionTaskJumpStaffTip', "Bound staff: {0} — click to jump to Engineering View", execLabel),
					'负责员工：{0} — 点击跳转至工程视图',
					execLabel,
				),
			}, isLiveHeld ? `● @${execLabel}` : `@${execLabel}`)) as HTMLButtonElement;
			refs.dynamicDisposables.add(addDisposableListener(jumpBtn, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onJumpToOrchestrationStaff?.(assigneeNodeId, primaryTok ? { focusTokenId: primaryTok.id } : undefined);
			}));
		} else {
			append(liveMetaContainer, $('span.ade-mission-task-live-chip.is-assignee', {
				title: adeBi(localize('adeMissionTaskAssigneeTip', "Bound staff: {0}", execLabel), '当前负责员工：{0}', execLabel),
			}, `@${execLabel}`));
		}
	} else {
		const stageIdx = (signals.stageById.get(node.id) ?? 0) + 1;
		append(refs.footerLeftEl, $('span.ade-mission-task-step-tag', {}, adeBi(localize('adeMissionTaskStageTag', "Stage {0}", stageIdx), '阶段 {0}', stageIdx)));
	}

	if (node.minCompleterTier !== undefined) {
		append(refs.footerLeftEl, $('span.ade-mission-task-tier-pill', {
			title: adeBi(localize('adeMissionTaskMinTierTip', "Completable by tier <= L{0}", node.minCompleterTier), '允许 ≤L{0} 职级验收结单', node.minCompleterTier),
		}, `≤L${node.minCompleterTier}`));
	}

	if (hasLiveMeta) {
		if (activeTokCnt > 0) {
			const tokStatusMod = primaryTok?.status === 'blocked'
				? '.is-tok-blocked'
				: primaryTok?.status === 'waiting_join'
					? '.is-tok-join'
					: '';
			const tokLabel = primaryTok?.status === 'blocked'
				? `⏳⚡${activeTokCnt}`
				: `⚡${activeTokCnt}`;
			const tokBtn = append(liveMetaContainer, $(`button.ade-mission-task-live-chip.is-tokens${tokStatusMod}`, {
				type: 'button',
				'data-ade-task-tokens': node.id,
				title: primaryTok
					? adeBi(
						localize('adeMissionTaskActiveTokTip', "Active baton {0} on {1} — click to inspect", primaryTok.id, ctx.resolveStaffLabel(primaryTok.nodeId)),
						'活跃接力棒 {0}（{1}）— 点击查看详情',
						primaryTok.id,
						ctx.resolveStaffLabel(primaryTok.nodeId),
					)
					: adeBi(localize('adeMissionTaskTokCountTip', "{0} active batons", activeTokCnt), '{0} 个活跃接力棒', activeTokCnt),
			}, tokLabel)) as HTMLButtonElement;
			refs.dynamicDisposables.add(addDisposableListener(tokBtn, EventType.CLICK, e => {
				e.stopPropagation();
				if (primaryTok && ctx.onOpenOrchestrationTokenPopover) {
					ctx.onOpenOrchestrationTokenPopover(ctx.resolveStaffLabel(primaryTok.nodeId), primaryTok, tokBtn, {
						staffNodeId: primaryTok.nodeId,
					});
				} else if (assigneeNodeId && ctx.onJumpToOrchestrationStaff) {
					ctx.onJumpToOrchestrationStaff(assigneeNodeId, { openPopover: 'token' });
				} else {
					ctx.onOpenMissionTaskPopover?.(node, tokBtn);
				}
			}));
		}
		if (artCnt > 0) {
			append(liveMetaContainer, $('span.ade-mission-task-live-chip.is-artifacts', {
				title: adeBi(localize('adeMissionTaskArtsTip', "{0} artifact pointers", artCnt), '{0} 份产物指针', artCnt),
			}, `${artCnt}p`));
		}
		if (hasDuration && statusRec?.durationMs && (activeTokCnt === 0 || artCnt === 0)) {
			const sec = Math.round(statusRec.durationMs / 1000);
			const durText = sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
			append(liveMetaContainer, $('span.ade-mission-task-live-chip.is-duration', {}, durText));
		}
		if (statusRec?.lastError) {
			append(liveMetaContainer, $('span.ade-mission-task-live-chip.is-error', { title: statusRec.lastError }, 'ERR'));
		}
	}

	// 3. Structured Footer Right (Check Receipt Pill + Upstream Dependency Pill)
	clearNode(refs.footerRightEl);
	const displayChecksCount = checksCount || (receipt?.checkCount ?? 0);
	if (displayChecksCount > 0 || receipt) {
		const checkIcon = checkState === 'fail' ? '✕' : checkState === 'pass' ? '✓' : '○';
		const checkText = displayChecksCount > 0 ? `${checkIcon}${displayChecksCount}` : checkIcon;
		const checkTip = receipt
			? `${checkState === 'pass' ? 'PASS' : checkState === 'fail' ? 'FAIL' : 'STALE'}: ${receipt.summary}`
			: adeBi(localize('adeMissionTaskChecksTip', "{0} deterministic verification checks — click to inspect", displayChecksCount), '{0} 项确定性门禁检查 — 点击查看', displayChecksCount);
		const checksBtn = append(refs.footerRightEl, $(`button.ade-mission-checks-pill.is-checks-${checkState}`, {
			type: 'button',
			'data-ade-task-checks': node.id,
			'data-check-state': checkState,
			title: checkTip,
		}, checkText)) as HTMLButtonElement;
		refs.dynamicDisposables.add(addDisposableListener(checksBtn, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenMissionTaskPopover?.(node, checksBtn, { focusSection: 'checks' });
		}));
	}
	refs.depBtnEl = undefined;
	if (inDeg >= 1) {
		const depCls = allUpstreamReady ? 'is-ready' : doneUpCount > 0 ? 'is-partial' : 'is-waiting';
		const depBtn = append(refs.footerRightEl, $(`button.ade-mission-task-dep-pill.${depCls}${isDepPinned ? '.is-trace-pinned' : ''}`, {
			type: 'button',
			'data-ade-task-deps': node.id,
			title: adeBi(
				localize('adeMissionTaskDepsTraceTip', "Upstream dependencies completed: {0}/{1} — click to trace dependency chain", doneUpCount, inDeg),
				'前置依赖完成进度：{0}/{1} — 点击高亮完整依赖链',
				doneUpCount,
				inDeg,
			),
		}, `${allUpstreamReady ? '●' : '◐'} ${doneUpCount}/${inDeg}`)) as HTMLButtonElement;
		refs.depBtnEl = depBtn;
		refs.dynamicDisposables.add(addDisposableListener(depBtn, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onToggleDepTrace(node.id);
		}));
		let isDepHovered = false;
		refs.dynamicDisposables.add(toDisposable(() => {
			if (isDepHovered) {
				isDepHovered = false;
				ctx.onHoverDepTrace(undefined);
			}
		}));
		refs.dynamicDisposables.add(addDisposableListener(depBtn, 'pointerenter', () => {
			isDepHovered = true;
			ctx.onHoverDepTrace(node.id);
		}));
		refs.dynamicDisposables.add(addDisposableListener(depBtn, 'pointerleave', () => {
			if (isDepHovered) {
				isDepHovered = false;
				ctx.onHoverDepTrace(undefined);
			}
		}));
	}
}

export function renderSupervisorXRayBeamsSvg(
	supervisorBeamsLayerEl: SVGGElement,
	nodes: readonly IMissionDagNode[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	runtimeState: IMissionRuntimeState,
	getSupervisorColorIndex: (supervisorId: string) => number,
	resolveSupervisorDisplay?: (supervisorId: string) => { readonly label: string; readonly shortLabel: string; readonly tier: number },
): void {
	const boundSups = runtimeState.boundary.supervisors.filter(s => s.managedNodeIds.length > 0);
	if (boundSups.length === 0) {
		return;
	}
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	let globalMinY = Infinity;
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (p) {
			globalMinY = Math.min(globalMinY, p.y - getMissionNodeSize(n).height / 2);
		}
	}
	const usedAnchorXs: number[] = [];
	const supById = new Map(runtimeState.boundary.supervisors.map(s => [s.id, s]));

	for (const sup of boundSups) {
		const managedBoxes: Array<{ readonly nodeId: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }> = [];
		for (const nid of sup.managedNodeIds) {
			const n = nodeById.get(nid);
			const p = positions.get(nid);
			if (n && p) {
				const sz = getMissionNodeSize(n);
				managedBoxes.push({ nodeId: nid, x: p.x, y: p.y, w: sz.width, h: sz.height });
			}
		}
		if (managedBoxes.length === 0) {
			continue;
		}
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		let sumX = 0;
		for (const b of managedBoxes) {
			minX = Math.min(minX, b.x - b.w / 2);
			maxX = Math.max(maxX, b.x + b.w / 2);
			minY = Math.min(minY, b.y - b.h / 2);
			maxY = Math.max(maxY, b.y + b.h / 2);
			sumX += b.x;
		}
		const colorIdx = getSupervisorColorIndex(sup.id);
		const disp = resolveSupervisorDisplay?.(sup.id) ?? { label: sup.id, shortLabel: sup.id, tier: sup.tier };
		let anchorX = Math.round(sumX / managedBoxes.length);
		for (const prevX of usedAnchorXs) {
			if (Math.abs(anchorX - prevX) < 176) {
				anchorX = prevX + 184;
			}
		}
		usedAnchorXs.push(anchorX);
		const anchorY = Math.max(66, Math.min(minY - 72, (Number.isFinite(globalMinY) ? globalMinY : minY) - 62));

		const supGroup = svgEl('g', {
			class: `ade-mission-sup-xray-group sup-color-${colorIdx}`,
			'data-supervisor-xray': sup.id,
		});
		supGroup.appendChild(svgEl('rect', {
			class: 'ade-mission-sup-cluster-halo',
			x: String(Math.round(minX - 18)),
			y: String(Math.round(minY - 18)),
			width: String(Math.round(maxX - minX + 36)),
			height: String(Math.round(maxY - minY + 36)),
			rx: '16',
			ry: '16',
		}));
		for (const b of managedBoxes) {
			const targetX = Math.round(b.x);
			const targetY = Math.round(b.y - b.h / 2 - 4);
			const ctrlX = Math.round((anchorX + targetX) / 2);
			const ctrlY = Math.round(anchorY + Math.max(24, (targetY - anchorY) * 0.42));
			supGroup.appendChild(svgEl('path', {
				class: 'ade-mission-sup-beam',
				'data-supervisor-beam': sup.id,
				'data-target-node': b.nodeId,
				d: `M ${anchorX} ${anchorY + 13} Q ${ctrlX} ${ctrlY} ${targetX} ${targetY}`,
			}));
			supGroup.appendChild(svgEl('circle', { class: 'ade-mission-sup-beam-dot', cx: String(targetX), cy: String(targetY), r: '3.5' }));
		}
		const parentDisp = sup.parentSupervisorId
			? (resolveSupervisorDisplay?.(sup.parentSupervisorId) ?? { label: sup.parentSupervisorId, shortLabel: sup.parentSupervisorId, tier: supById.get(sup.parentSupervisorId)?.tier ?? 0 })
			: undefined;
		const badgeLabel = parentDisp
			? `👑 ${formatTierTag(sup.tier)} ${disp.shortLabel} ↑ ${parentDisp.shortLabel}`
			: `👑 ${formatTierTag(sup.tier)} ${disp.shortLabel} (${managedBoxes.length})`;
		const pillW = Math.max(132, Math.min(280, badgeLabel.length * 7.6 + 22));
		supGroup.appendChild(svgEl('rect', { class: 'ade-mission-sup-anchor-bg', x: String(Math.round(anchorX - pillW / 2)), y: String(Math.round(anchorY - 13)), width: String(Math.round(pillW)), height: '26', rx: '13' }));
		const anchorText = svgEl('text', { class: 'ade-mission-sup-anchor-text', x: String(anchorX), y: String(anchorY + 0.5) });
		anchorText.textContent = badgeLabel;
		supGroup.appendChild(anchorText);
		supervisorBeamsLayerEl.appendChild(supGroup);
	}
}

export function renderSameEmployeeContextReuseOverlay(
	contextLinksLayerEl: SVGGElement,
	hoveredNodeId: string,
	nodes: readonly IMissionDagNode[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
): { readonly sameEmployeeIds: ReadonlySet<string>; readonly reuseChainIds: ReadonlySet<string>; readonly reuseRouteBelow: boolean } {
	const sameEmployeeIds = new Set<string>();
	const reuseChainIds = new Set<string>();
	let reuseRouteBelow = false;

	const hoveredNode = nodes.find(n => n.id === hoveredNodeId);
	if (!hoveredNode?.employeeKey || (hoveredNode.employeeTotalOccurrences ?? 0) <= 1) {
		return { sameEmployeeIds, reuseChainIds, reuseRouteBelow };
	}

	const sequenceNodes = nodes
		.filter(n => n.employeeKey === hoveredNode.employeeKey)
		.sort((a, b) => (a.employeeOccurrence ?? 0) - (b.employeeOccurrence ?? 0));
	for (const peer of sequenceNodes) {
		reuseChainIds.add(peer.id);
		if (peer.id !== hoveredNode.id) {
			sameEmployeeIds.add(peer.id);
		}
	}

	let minTopY = Infinity;
	let maxBottomY = -Infinity;
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (p) {
			const sz = getMissionNodeSize(n);
			minTopY = Math.min(minTopY, p.y - sz.height / 2);
			maxBottomY = Math.max(maxBottomY, p.y + sz.height / 2);
		}
	}
	const hasNodeVertically = (target: IMissionDagNode, side: 'above' | 'below'): boolean => {
		const tp = positions.get(target.id);
		if (!tp) {
			return false;
		}
		return nodes.some(other => {
			if (other.id === target.id) {
				return false;
			}
			const op = positions.get(other.id);
			if (!op) {
				return false;
			}
			const osz = getMissionNodeSize(other);
			const horizOverlap = Math.abs(op.x - tp.x) < osz.width / 2 + 16;
			return horizOverlap && (side === 'above' ? op.y < tp.y - 10 : op.y > tp.y + 10);
		});
	};
	const aboveBlockedCount = sequenceNodes.filter(n => hasNodeVertically(n, 'above')).length;
	const belowBlockedCount = sequenceNodes.filter(n => hasNodeVertically(n, 'below')).length;
	reuseRouteBelow = aboveBlockedCount > belowBlockedCount;

	const anchors: IMissionContextReuseAnchor[] = [];
	for (const seqNode of sequenceNodes) {
		const p = positions.get(seqNode.id);
		if (!p) {
			continue;
		}
		const sz = getMissionNodeSize(seqNode);
		anchors.push({
			id: seqNode.id,
			x: p.x,
			borderY: reuseRouteBelow ? (p.y + sz.height / 2) : (p.y - sz.height / 2),
		});
	}
	const laneY = reuseRouteBelow
		? (Math.max(maxBottomY, ...anchors.map(a => a.borderY)) + 32)
		: (Math.min(minTopY, ...anchors.map(a => a.borderY)) - 32);
	const reuseHops = buildMissionContextReusePaths(anchors, laneY, reuseRouteBelow, 12);
	for (const hop of reuseHops) {
		contextLinksLayerEl.appendChild(svgEl('path', {
			class: 'ade-mission-context-edge',
			'data-context-link': `${hop.fromId}->${hop.toId}`,
			d: hop.path,
			'marker-end': 'url(#ade-mission-arrow-ctx)',
		}));
	}

	return { sameEmployeeIds, reuseChainIds, reuseRouteBelow };
}

export function renderMissionCloudTerritoriesSvg(
	cloudTerritoriesLayerEl: SVGGElement,
	showCloudTerritories: boolean,
	nodes: readonly IMissionDagNode[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	getHostMeta: (nodeId: string) => { readonly hostAlias?: string; readonly displayHost?: string; readonly osKind?: string; readonly osLabel?: string; readonly isRemoteHost?: boolean } | undefined,
): void {
	while (cloudTerritoriesLayerEl.firstChild) {
		cloudTerritoriesLayerEl.removeChild(cloudTerritoriesLayerEl.firstChild);
	}
	if (!showCloudTerritories) {
		return;
	}
	interface IHostGroup {
		readonly hostAlias: string;
		readonly displayHost: string;
		readonly osKind: string;
		readonly osLabel: string;
		readonly isRemote: boolean;
		readonly members: Array<{ readonly x: number; readonly y: number; readonly w: number; readonly h: number }>;
	}
	const groups = new Map<string, IHostGroup>();
	for (const node of nodes) {
		if (node.kind === 'gate') {
			continue;
		}
		const meta = getHostMeta(node.id);
		const pos = positions.get(node.id);
		if (!meta || !pos || !meta.hostAlias) {
			continue;
		}
		const key = meta.hostAlias.toLowerCase();
		let grp = groups.get(key);
		if (!grp) {
			grp = {
				hostAlias: meta.hostAlias,
				displayHost: meta.displayHost ?? meta.hostAlias,
				osKind: meta.osKind ?? 'linux',
				osLabel: meta.osLabel ?? 'Linux',
				isRemote: Boolean(meta.isRemoteHost),
				members: [],
			};
			groups.set(key, grp);
		}
		const sz = getMissionNodeSize(node);
		grp.members.push({ x: pos.x, y: pos.y, w: sz.width, h: sz.height });
	}
	if (![...groups.values()].some(g => g.isRemote)) {
		return;
	}
	for (const grp of groups.values()) {
		if (grp.members.length === 0) {
			continue;
		}
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const m of grp.members) {
			minX = Math.min(minX, m.x - m.w / 2);
			maxX = Math.max(maxX, m.x + m.w / 2);
			minY = Math.min(minY, m.y - m.h / 2);
			maxY = Math.max(maxY, m.y + m.h / 2);
		}
		const boxX = Math.round(minX - 32);
		const boxY = Math.round(minY - 40);
		const boxW = Math.round(maxX - minX + 64);
		const boxH = Math.round(maxY - minY + 66);
		const territory = svgEl('g', {
			class: `ade-mission-cloud-territory os-${sanitizeCssSlug(grp.osKind)}${grp.isRemote ? ' is-remote' : ' is-local'}`,
			'data-cloud-territory': grp.hostAlias,
			'data-cloud-remote': String(grp.isRemote),
		});
		territory.appendChild(svgEl('rect', { class: 'ade-mission-cloud-contour', x: String(boxX), y: String(boxY), width: String(boxW), height: String(boxH), rx: '18', ry: '18' }));
		const titleText = grp.isRemote ? `☁ @${grp.displayHost} · ${grp.osLabel} (${grp.members.length})` : `💻 Local · ${grp.osLabel} (${grp.members.length})`;
		const pillW = measureSvgPillWidth(titleText, 24, 118, 280);
		territory.appendChild(svgEl('rect', { class: 'ade-mission-cloud-title-bg', x: String(boxX + 14), y: String(boxY - 11), width: String(pillW), height: '22', rx: '11' }));
		const labelEl = svgEl('text', { class: 'ade-mission-cloud-title-text', x: String(boxX + 25), y: String(boxY + 0.5) });
		labelEl.textContent = titleText;
		territory.appendChild(labelEl);
		cloudTerritoriesLayerEl.appendChild(territory);
	}
}

export interface IConnectDragHost {
	readonly worldEl: HTMLElement;
	readonly connectPreviewPathEl: SVGPathElement;
	readonly graphDisposables: DisposableStore;
	readonly connectDragDisposables: DisposableStore;
	readonly orchAnchorButtons: ReadonlyMap<string, HTMLButtonElement>;
	readonly getDirection: () => 'LR' | 'TD';
	readonly getZoom: () => number;
	readonly getNodePosition: (nodeId: string) => IMissionNodePosition | undefined;
	readonly getRenderedNodeSize: (nodeId: string, fallbackNode?: IMissionDagNode) => { readonly width: number; readonly height: number };
	readonly getNodeRootEl: (nodeId: string) => HTMLElement | undefined;
	readonly getCandidateNodeEntries: () => Iterable<readonly [string, IMissionDagNode]>;
	readonly getOrchNodes: () => readonly IOrchestrationGraphNode[];
	readonly isRevisionPreview?: () => boolean;
	readonly onConnectNodes?: (fromNodeId: string, toNodeId: string, options?: { readonly fail?: boolean; readonly bidirectional?: boolean }) => void;
}

function runConnectDragSession(
	triggerEl: HTMLElement,
	downEv: PointerEvent,
	host: IConnectDragHost,
	startX: number,
	startY: number,
	orientation: 'horizontal' | 'vertical',
	resolveTarget: (pt: { readonly x: number; readonly y: number }) => { readonly targetId?: string; readonly endX: number; readonly endY: number; readonly snapAnchor?: HTMLButtonElement },
	isFailMode: boolean,
	onCommit: (targetId: string, shiftKey: boolean) => void,
): void {
	const win = getWindow(triggerEl);
	let hoveredTargetId: string | undefined;
	let snappedAnchorEl: HTMLButtonElement | undefined;

	const clientToWorld = (clientX: number, clientY: number) => {
		const rect = host.worldEl.getBoundingClientRect();
		const zoom = Math.max(0.1, host.getZoom());
		return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
	};
	const clearSnap = () => {
		snappedAnchorEl?.classList.remove('is-snap-target');
		snappedAnchorEl = undefined;
	};
	const setHighlight = (nextId: string | undefined) => {
		if (hoveredTargetId === nextId) {
			return;
		}
		if (hoveredTargetId) {
			host.getNodeRootEl(hoveredTargetId)?.classList.remove('is-connect-target');
		}
		hoveredTargetId = nextId;
		if (hoveredTargetId) {
			host.getNodeRootEl(hoveredTargetId)?.classList.add('is-connect-target');
		}
	};
	const updatePreview = (clientX: number, clientY: number, shiftKey: boolean) => {
		const res = resolveTarget(clientToWorld(clientX, clientY));
		setHighlight(res.targetId);
		clearSnap();
		if (res.snapAnchor) {
			snappedAnchorEl = res.snapAnchor;
			snappedAnchorEl.classList.add('is-snap-target');
		}
		const route = computeOrthogonalRoundedEdgeRoute(startX, startY, res.endX, res.endY, { cornerRadius: 12, minStub: 20, orientation });
		host.connectPreviewPathEl.setAttribute('d', route.path);
		host.connectPreviewPathEl.classList.toggle('is-fail', isFailMode && shiftKey);
		host.connectPreviewPathEl.setAttribute(
			'marker-end',
			isFailMode
				? (shiftKey ? 'url(#ade-mission-arrow-fail)' : 'url(#ade-mission-arrow-active)')
				: (shiftKey ? 'url(#ade-mission-arrow-bidir)' : 'url(#ade-mission-arrow-active)'),
		);
		host.connectPreviewPathEl.style.display = '';
	};

	let cleaned = false;
	const cleanupDom = () => {
		if (cleaned) {
			return;
		}
		cleaned = true;
		setHighlight(undefined);
		clearSnap();
		host.worldEl.classList.remove('is-connecting-edge');
		host.connectPreviewPathEl.style.display = 'none';
	};
	const cleanup = () => {
		cleanupDom();
		host.connectDragDisposables.clear();
	};

	host.connectDragDisposables.clear();
	host.worldEl.classList.add('is-connecting-edge');
	host.connectDragDisposables.add(toDisposable(cleanupDom));
	updatePreview(downEv.clientX, downEv.clientY, downEv.shiftKey);

	host.connectDragDisposables.add(addDisposableListener(win, EventType.POINTER_MOVE, (mv: PointerEvent) => updatePreview(mv.clientX, mv.clientY, mv.shiftKey)));
	host.connectDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, (upEv: PointerEvent) => {
		const finalTarget = hoveredTargetId ?? resolveTarget(clientToWorld(upEv.clientX, upEv.clientY)).targetId;
		const shift = upEv.shiftKey;
		cleanup();
		if (finalTarget) {
			onCommit(finalTarget, shift);
		}
	}));
	host.connectDragDisposables.add(addDisposableListener(win, 'pointercancel', cleanup));
	host.connectDragDisposables.add(addDisposableListener(win, EventType.BLUR, cleanup));
	host.connectDragDisposables.add(addDisposableListener(win, EventType.KEY_DOWN, (kev: KeyboardEvent) => {
		if (kev.key === 'Escape') {
			kev.preventDefault();
			cleanup();
		}
	}));
}

export function bindMissionOutPortConnectDrag(
	node: IMissionDagNode,
	outPortEl: HTMLButtonElement,
	host: IConnectDragHost,
): void {
	host.graphDisposables.add(addDisposableListener(outPortEl, EventType.POINTER_DOWN, (downEv: PointerEvent) => {
		if (downEv.button !== 0 || !host.onConnectNodes || host.isRevisionPreview?.()) {
			return;
		}
		downEv.preventDefault();
		downEv.stopPropagation();
		const sourcePos = host.getNodePosition(node.id);
		if (!sourcePos) {
			return;
		}
		const sourceSize = host.getRenderedNodeSize(node.id, node);
		const isVertical = host.getDirection() === 'TD';
		const startX = isVertical ? sourcePos.x : (sourcePos.x + sourceSize.width / 2);
		const startY = isVertical ? (sourcePos.y + sourceSize.height / 2) : sourcePos.y;
		runConnectDragSession(outPortEl, downEv, host, startX, startY, isVertical ? 'vertical' : 'horizontal', pt => {
			for (const [cid, cNode] of host.getCandidateNodeEntries()) {
				if (cid === node.id) {
					continue;
				}
				const pos = host.getNodePosition(cid);
				if (!pos) {
					continue;
				}
				const sz = host.getRenderedNodeSize(cid, cNode);
				if (pt.x >= pos.x - sz.width / 2 - 16 && pt.x <= pos.x + sz.width / 2 + 16
					&& pt.y >= pos.y - sz.height / 2 - 16 && pt.y <= pos.y + sz.height / 2 + 16) {
					return { targetId: cid, endX: isVertical ? pos.x : (pos.x - sz.width / 2 - 4), endY: isVertical ? (pos.y - sz.height / 2 - 4) : pos.y };
				}
			}
			return { endX: pt.x, endY: pt.y };
		}, true, (targetId, asFail) => {
			if (targetId !== node.id) {
				host.onConnectNodes?.(node.id, targetId, { fail: asFail });
			}
		});
	}));
}

export function bindOrchMultiAnchorConnectDrag(
	oNode: IOrchestrationGraphNode,
	anchorEl: HTMLButtonElement,
	side: OrchestrationAnchorSide,
	slot: number,
	host: IConnectDragHost,
): void {
	host.graphDisposables.add(addDisposableListener(anchorEl, EventType.POINTER_DOWN, (downEv: PointerEvent) => {
		if (downEv.button !== 0 || !host.onConnectNodes || host.isRevisionPreview?.()) {
			return;
		}
		downEv.preventDefault();
		downEv.stopPropagation();
		const sourcePos = host.getNodePosition(oNode.id);
		if (!sourcePos) {
			return;
		}
		const startAnchor = computeOrchestrationAnchorPoint(sourcePos, getRenderedOrchestrationNodeSize(oNode), side, slot, ORCHESTRATION_SLOTS_PER_SIDE);
		runConnectDragSession(anchorEl, downEv, host, startAnchor.x, startAnchor.y, (side === 'top' || side === 'bottom') ? 'vertical' : 'horizontal', pt => {
			for (const candidate of host.getOrchNodes()) {
				if (candidate.id === oNode.id) {
					continue;
				}
				const pos = host.getNodePosition(candidate.id);
				if (!pos) {
					continue;
				}
				const sz = getRenderedOrchestrationNodeSize(candidate);
				if (pt.x >= pos.x - sz.width / 2 - 16 && pt.x <= pos.x + sz.width / 2 + 16
					&& pt.y >= pos.y - sz.height / 2 - 16 && pt.y <= pos.y + sz.height / 2 + 16) {
					let bestDist = Infinity;
					let bestPt = pt;
					let snapAnchor: HTMLButtonElement | undefined;
					for (const tSide of ORCHESTRATION_ANCHOR_SIDES) {
						for (let tSlot = 0; tSlot < ORCHESTRATION_SLOTS_PER_SIDE; tSlot++) {
							const ap = computeOrchestrationAnchorPoint(pos, sz, tSide, tSlot, ORCHESTRATION_SLOTS_PER_SIDE);
							const d = Math.hypot(ap.x - pt.x, ap.y - pt.y);
							if (d < bestDist) {
								bestDist = d;
								bestPt = ap;
								snapAnchor = host.orchAnchorButtons.get(`${candidate.id}:${tSide}:${tSlot}`);
							}
						}
					}
					return { targetId: candidate.id, endX: bestPt.x, endY: bestPt.y, snapAnchor };
				}
			}
			return { endX: pt.x, endY: pt.y };
		}, false, (targetId, bidirectional) => {
			if (targetId !== oNode.id) {
				host.onConnectNodes?.(oNode.id, targetId, { bidirectional });
			}
		});
	}));
}
