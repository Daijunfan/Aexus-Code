/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	computeMissionAutoLayout,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionDagParseResult,
	IMissionNodePosition,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { formatCompactTokenCount, IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { formatFinOpsUsd } from '../../../../platform/ade/common/adeModelPricing.js';
import {
	findHighestRankStaffNode,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	computeOrchestrationAutoLayout,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	IOrchestrationGraphParseResult,
	OrchestrationLayoutMode,
	parseOrchestrationGraph,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { IAdeOrganizationConfig } from '../../../../platform/ade/common/adeRoleSchema.js';
import {
	ADE_SECRETARY_ID,
	AdeEngineeringViewMode,
	IAdeAgent,
	IAdeProjectsService,
} from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import type { IOrchDeptBounds } from './adeMissionCanvasEdgeRouter.js';
import type { IMissionMinimapSyncOptions } from './adeMissionMinimap.js';
import type { MissionInspectorTab } from './adeMissionNodeInspector.js';
import { getRenderedOrchestrationNodeSize } from './adeMissionOrchCardBuilder.js';
import type { IAdeMissionRecord } from './adeMissionStore.js';

export interface IEngineeringHistoryEntry {
	readonly viewMode: AdeEngineeringViewMode;
	readonly codeText: string;
	readonly positions: Record<string, IMissionNodePosition>;
	readonly nodePrompts: Record<string, string>;
	readonly label: string;
}

export interface IAdePendingMissionNodeFocus {
	readonly nodeId: string;
	readonly focusTokenId?: string;
	readonly highlightNodeIds?: readonly string[];
	readonly openPopover?: 'task' | 'token' | 'whiteboard';
	readonly whiteboardSection?: string;
	readonly inspectorTab?: MissionInspectorTab;
	readonly openAgentBeside?: boolean;
}

export interface IEngineeringViewportState {
	readonly panX: number;
	readonly panY: number;
	readonly zoom: number;
}

export interface IEngineeringCanvasMenuItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly danger?: boolean;
	readonly disabled?: boolean;
	readonly separatorBefore?: boolean;
	readonly run: () => void;
}

export interface IEngineeringConsoleFinOpsSummary {
	readonly visible: boolean;
	readonly text: string;
	readonly tooltip: string;
	readonly warningLevel: 'none' | 'warn' | 'tripped';
}

export interface IEngineeringWorldBounds {
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
}

const MAX_VIEWPORT_MEMORY_ENTRIES = 64;
const MAX_HISTORY_KEYS = 32;
const MAX_UNDO_HISTORY = 50;

/**
 * Bounded per-(missionId, viewMode) camera memory so toggling between Mission DAG
 * and Engineering View preserves each view's exact pan & zoom framing.
 */
export class EngineeringViewportMemory {
	private readonly states = new Map<string, IEngineeringViewportState>();

	private keyOf(missionId: string, viewMode: AdeEngineeringViewMode): string {
		return `${missionId}::${viewMode}`;
	}

	save(missionId: string, viewMode: AdeEngineeringViewMode, state: IEngineeringViewportState): void {
		if (!missionId || !Number.isFinite(state.panX) || !Number.isFinite(state.panY) || !Number.isFinite(state.zoom)) {
			return;
		}
		const key = this.keyOf(missionId, viewMode);
		this.states.delete(key);
		this.states.set(key, { panX: state.panX, panY: state.panY, zoom: state.zoom });
		if (this.states.size > MAX_VIEWPORT_MEMORY_ENTRIES) {
			const oldest = this.states.keys().next().value;
			if (oldest !== undefined) {
				this.states.delete(oldest);
			}
		}
	}

	get(missionId: string, viewMode: AdeEngineeringViewMode): IEngineeringViewportState | undefined {
		const key = this.keyOf(missionId, viewMode);
		const found = this.states.get(key);
		if (!found) {
			return undefined;
		}
		this.states.delete(key);
		this.states.set(key, found);
		return found;
	}

	clear(missionId?: string, viewMode?: AdeEngineeringViewMode): void {
		if (!missionId) {
			this.states.clear();
			return;
		}
		if (viewMode) {
			this.states.delete(this.keyOf(missionId, viewMode));
			return;
		}
		this.states.delete(this.keyOf(missionId, 'mission'));
		this.states.delete(this.keyOf(missionId, 'orchestration'));
	}
}

interface IScopedHistoryBucket {
	undo: IEngineeringHistoryEntry[];
	redo: IEngineeringHistoryEntry[];
	lastCoalescedAt: number;
}

/**
 * Per-(missionId, viewMode) Undo/Redo history store so switching views or opening
 * split tabs never discards or corrupts the other view's undo timeline.
 */
export class EngineeringHistoryStore {
	private readonly buckets = new Map<string, IScopedHistoryBucket>();

	private getOrCreate(key: string): IScopedHistoryBucket {
		let bucket = this.buckets.get(key);
		if (bucket) {
			this.buckets.delete(key);
			this.buckets.set(key, bucket);
			return bucket;
		}
		bucket = { undo: [], redo: [], lastCoalescedAt: 0 };
		this.buckets.set(key, bucket);
		if (this.buckets.size > MAX_HISTORY_KEYS) {
			const oldest = this.buckets.keys().next().value;
			if (oldest !== undefined) {
				this.buckets.delete(oldest);
			}
		}
		return bucket;
	}

	static keyFor(missionId: string, viewMode: AdeEngineeringViewMode): string {
		return `${missionId}::${viewMode}`;
	}

	push(key: string, entry: IEngineeringHistoryEntry, coalesceMs = 0): void {
		const bucket = this.getOrCreate(key);
		const now = Date.now();
		if (coalesceMs > 0 && bucket.undo.length > 0 && (now - bucket.lastCoalescedAt) < coalesceMs) {
			bucket.lastCoalescedAt = now;
			bucket.redo = [];
			return;
		}
		bucket.lastCoalescedAt = coalesceMs > 0 ? now : 0;
		bucket.undo.push(entry);
		if (bucket.undo.length > MAX_UNDO_HISTORY) {
			bucket.undo.shift();
		}
		bucket.redo = [];
	}

	popUndo(key: string, captureCurrent: (label: string) => IEngineeringHistoryEntry): IEngineeringHistoryEntry | undefined {
		const bucket = this.buckets.get(key);
		if (!bucket || bucket.undo.length === 0) {
			return undefined;
		}
		const prev = bucket.undo.pop()!;
		bucket.redo.push(captureCurrent(prev.label));
		return prev;
	}

	popRedo(key: string, captureCurrent: (label: string) => IEngineeringHistoryEntry): IEngineeringHistoryEntry | undefined {
		const bucket = this.buckets.get(key);
		if (!bucket || bucket.redo.length === 0) {
			return undefined;
		}
		const next = bucket.redo.pop()!;
		bucket.undo.push(captureCurrent(next.label));
		return next;
	}

	clear(key?: string): void {
		if (!key) {
			this.buckets.clear();
			return;
		}
		this.buckets.delete(key);
	}
}

/**
 * Infers which Engineering canvas view owns `nodeId` so deep-links from Inbox,
 * Sidebar, or cross-view chips never land on the wrong view and drop focus.
 */
export function inferEngineeringViewModeForNode(
	record: Pick<IAdeMissionRecord, 'mermaidText' | 'orchestrationText' | 'whiteboards'> | undefined,
	nodeId: string | undefined,
	fallback: AdeEngineeringViewMode = 'orchestration',
): AdeEngineeringViewMode {
	const id = nodeId?.trim();
	if (!id || !record) {
		return fallback;
	}
	const missionParsed = record.mermaidText ? parseMissionMermaidDag(record.mermaidText) : undefined;
	const inMission = Boolean(missionParsed && !missionParsed.error && missionParsed.nodes.some(n => n.id === id));

	const orchParsed = record.orchestrationText ? parseOrchestrationGraph(record.orchestrationText) : undefined;
	const inOrch = Boolean(
		(orchParsed && !orchParsed.error && orchParsed.nodes.some(n => n.id === id))
		|| (record.whiteboards && Object.prototype.hasOwnProperty.call(record.whiteboards, id)),
	);

	if (inMission && !inOrch) {
		return 'mission';
	}
	if (inOrch && !inMission) {
		return 'orchestration';
	}
	return fallback;
}

/**
 * Resolves the sibling-view node IDs linked to hovered/selected nodes so split-pane
 * Mission DAG and Engineering canvases illuminate counterpart cards in real time.
 */
export function resolveCrossViewLinkedNodeIds(
	record: IAdeMissionRecord | undefined,
	sourceView: AdeEngineeringViewMode,
	sourceNodeIds: readonly string[],
	orchNodes: readonly IOrchestrationGraphNode[],
	missionNodes: readonly IMissionDagNode[],
): string[] {
	if (!record || sourceNodeIds.length === 0) {
		return [];
	}
	const effectiveOrchNodes = orchNodes.length > 0
		? orchNodes
		: (record.orchestrationText ? parseOrchestrationGraph(record.orchestrationText).nodes : []);
	const effectiveMissionNodes = missionNodes.length > 0
		? missionNodes
		: (record.mermaidText ? parseMissionMermaidDag(record.mermaidText).nodes : []);

	const taskStatuses = record.taskStatuses ?? {};
	const tokens = Object.values(record.orchestrationRuntime?.tokens ?? {});
	const linked = new Set<string>();

	if (sourceView === 'mission') {
		const orchIdSet = new Set(effectiveOrchNodes.map(n => n.id));
		for (const taskId of sourceNodeIds) {
			const statusRec = taskStatuses[taskId];
			if (statusRec?.assigneeNodeId && orchIdSet.has(statusRec.assigneeNodeId)) {
				linked.add(statusRec.assigneeNodeId);
			}
			for (const tok of tokens) {
				if (tok.taskNodeId === taskId || tok.taskNodeIds?.includes(taskId)) {
					if (orchIdSet.has(tok.nodeId)) {
						linked.add(tok.nodeId);
					}
				}
			}
			const taskNode = effectiveMissionNodes.find(n => n.id === taskId);
			if (taskNode?.completionContract?.requiredWhiteboardIds) {
				for (const wbId of taskNode.completionContract.requiredWhiteboardIds) {
					if (orchIdSet.has(wbId)) {
						linked.add(wbId);
					}
				}
			}
			if (taskNode?.employeeKey || taskNode?.employeeName) {
				const empKey = taskNode.employeeKey?.toLowerCase();
				const empName = taskNode.employeeName?.toLowerCase();
				for (const oNode of effectiveOrchNodes) {
					if (oNode.kind !== 'staff') {
						continue;
					}
					if ((empKey && oNode.employeeKey?.toLowerCase() === empKey)
						|| (empName && (oNode.employeeName?.toLowerCase() === empName || oNode.label.toLowerCase() === empName || oNode.id.toLowerCase() === empName))) {
						linked.add(oNode.id);
					}
				}
			}
		}
		return [...linked];
	}

	// sourceView === 'orchestration' -> resolve linked Mission DAG task/gate IDs
	const missionIdSet = new Set(effectiveMissionNodes.map(n => n.id));
	for (const orchId of sourceNodeIds) {
		for (const [taskId, rec] of Object.entries(taskStatuses)) {
			if (rec.assigneeNodeId === orchId && missionIdSet.has(taskId)) {
				linked.add(taskId);
			}
		}
		for (const tok of tokens) {
			if (tok.nodeId !== orchId) {
				continue;
			}
			if (tok.taskNodeId && missionIdSet.has(tok.taskNodeId)) {
				linked.add(tok.taskNodeId);
			}
			for (const tid of tok.taskNodeIds ?? []) {
				if (missionIdSet.has(tid)) {
					linked.add(tid);
				}
			}
		}
		const oNode = effectiveOrchNodes.find(n => n.id === orchId);
		if (oNode?.kind === 'whiteboard') {
			for (const mNode of effectiveMissionNodes) {
				if (mNode.completionContract?.requiredWhiteboardIds?.includes(orchId)) {
					linked.add(mNode.id);
				}
			}
		} else if (oNode) {
			const empKey = oNode.employeeKey?.toLowerCase();
			const empName = (oNode.employeeName ?? oNode.label).toLowerCase();
			for (const mNode of effectiveMissionNodes) {
				if ((empKey && mNode.employeeKey?.toLowerCase() === empKey)
					|| (mNode.employeeName && mNode.employeeName.toLowerCase() === empName)) {
					linked.add(mNode.id);
				}
			}
		}
	}
	return [...linked];
}

/**
 * Resolves the assigned Orchestration Staff card & live tokens for a Mission Task pod
 * so the enriched Task Editor popover can display live badges and jump directly across views.
 */
export function resolveTaskAssigneeAndTokens(
	taskNode: IMissionDagNode,
	statusRec: IMissionTaskStatusRecord | undefined,
	orchRuntime: IOrchestrationRuntimeState | undefined,
	orchNodes: readonly IOrchestrationGraphNode[],
): {
	readonly assigneeNodeId?: string;
	readonly assigneeLabel?: string;
	readonly activeTokens: readonly IOrchestrationToken[];
} {
	const allTokens = Object.values(orchRuntime?.tokens ?? {});
	const boundTokens = allTokens.filter(tok =>
		(tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join')
		&& (tok.taskNodeId === taskNode.id || Boolean(tok.taskNodeIds?.includes(taskNode.id))),
	);
	let staffNode: IOrchestrationGraphNode | undefined;
	if (statusRec?.assigneeNodeId) {
		staffNode = orchNodes.find(n => n.id === statusRec.assigneeNodeId && n.kind === 'staff');
	}
	if (!staffNode && boundTokens.length > 0) {
		staffNode = orchNodes.find(n => n.id === boundTokens[0].nodeId && n.kind === 'staff');
	}
	if (!staffNode && (taskNode.employeeKey || taskNode.employeeName)) {
		const empKey = taskNode.employeeKey?.toLowerCase();
		const empName = taskNode.employeeName?.toLowerCase();
		staffNode = orchNodes.find(n => n.kind === 'staff' && (
			(empKey && n.employeeKey?.toLowerCase() === empKey)
			|| (empName && (n.employeeName?.toLowerCase() === empName || n.label.toLowerCase() === empName || n.id.toLowerCase() === empName))
		));
	}
	return {
		assigneeNodeId: staffNode?.id ?? statusRec?.assigneeNodeId ?? boundTokens[0]?.nodeId,
		assigneeLabel: staffNode?.label ?? taskNode.employeeName ?? statusRec?.assigneeNodeId,
		activeTokens: boundTokens,
	};
}

/**
 * Expanded reactive fingerprint for Mission Task DAG view covering Round-2
 * completion contracts, check receipts, nodeChecks, touchedFiles, rework counts,
 * and bound orchestration tokens.
 */
export function computeMissionTaskStatusesFingerprint(
	record: IAdeMissionRecord | undefined,
	orchRuntime: IOrchestrationRuntimeState | undefined,
): string {
	const statuses = record?.taskStatuses;
	const statusPart = statuses
		? Object.keys(statuses).sort().map(k => {
			const r = statuses[k];
			const rc = r.lastCheckReceipt;
			const rcSig = rc ? `${rc.passed ? 1 : 0}:${rc.checkedAt}:${rc.summary ?? ''}` : '';
			return `${k}:${r.status}:${r.completedAt ?? 0}:${r.assigneeNodeId ?? ''}:${r.activeTokenIds?.length ?? 0}:${r.artifactPtrs?.length ?? 0}:${r.touchedFiles?.length ?? 0}:${r.lastReworkAt ?? 0}:${r.note ?? ''}:${r.lastError ?? ''}:${rcSig}`;
		}).join('|')
		: '';
	const checks = record?.nodeChecks;
	const checksPart = checks
		? Object.keys(checks).sort().map(k => {
			const list = checks[k] ?? [];
			return `${k}:${list.map(c => `${c.id}:${c.enabled === false ? 0 : 1}`).join(',')}`;
		}).join('|')
		: '';
	const tokPart = orchRuntime
		? Object.values(orchRuntime.tokens)
			.filter(t => t.taskNodeId || (t.taskNodeIds && t.taskNodeIds.length > 0))
			.map(t => `${t.id}:${t.status}:${t.nodeId}:${t.taskNodeId ?? ''}:${t.taskNodeIds?.join('+') ?? ''}:${t.attemptNumber ?? 1}:${t.reworkCategory ?? ''}:${t.nudgeCount}`)
			.sort()
			.join(',')
		: '';
	return `${statusPart}#${checksPart}#${tokPart}`;
}

/**
 * Expanded reactive fingerprint for Engineering Orchestration view covering Round-2
 * whiteboard metadata, token attempts/rework/scope/tasks, join barrier SLAs/quorum/conflicts,
 * FinOps budget telemetry, layout mode, and linked task statuses.
 */
export function computeOrchestrationAuxiliaryFingerprint(
	record: IAdeMissionRecord | undefined,
	orchRuntime: IOrchestrationRuntimeState | undefined,
): string {
	const whiteboards = record?.whiteboards;
	const wbPart = whiteboards
		? Object.keys(whiteboards).sort().map(k => {
			const wb = whiteboards[k];
			return `${k}:${wb.version}:${wb.updatedAt}:${wb.title}:${wb.department}:${wb.updatedBy ?? ''}:${wb.content.length}`;
		}).join('|')
		: '';
	const rtPart = orchRuntime
		? [
			orchRuntime.status ?? 'running',
			orchRuntime.tokenSeq,
			orchRuntime.totalCostUsd ?? 0,
			orchRuntime.budgetLimitUsd ?? 0,
			orchRuntime.budgetCircuitTripped ? 1 : 0,
			orchRuntime.finOpsTelemetry ? `${orchRuntime.finOpsTelemetry.cacheHitRatePct ?? 0}:${orchRuntime.finOpsTelemetry.reworkTokens ?? 0}` : '',
			Object.values(orchRuntime.tokens).map(t =>
				`${t.id}:${t.nodeId}:${t.status}:${t.nudgeCount}:${t.attemptNumber ?? 1}:${t.reworkCategory ?? ''}:${t.dispatchKind ?? ''}:${t.taskNodeId ?? ''}:${t.taskNodeIds?.join('+') ?? ''}:${t.scopePaths?.join('+') ?? ''}:${t.contextRefs?.length ?? 0}:${t.whiteboardPointers?.length ?? 0}`
			).join(','),
			Object.values(orchRuntime.joinBarriers ?? {}).map(b =>
				`${b.id}:${b.status}:${b.mode ?? 'all'}:${b.quorumCount ?? 0}:${b.deadlineAt ?? 0}:${b.timedOut ? 1 : 0}:${Object.keys(b.settledChildren).length}:${b.fileConflicts?.length ?? 0}`
			).join(','),
		].join('~')
		: '';
	const taskPart = record?.taskStatuses
		? Object.keys(record.taskStatuses).sort().map(k => {
			const r = record.taskStatuses![k];
			return `${k}:${r.status}:${r.assigneeNodeId ?? ''}:${r.lastCheckReceipt?.passed === undefined ? '' : (r.lastCheckReceipt.passed ? 1 : 0)}`;
		}).join(',')
		: '';
	const layoutPart = `${record?.orchestrationLayoutMode ?? ''}:${Object.keys(record?.orchestrationPositions ?? {}).length}`;
	return `${wbPart}#${rtPart}#${taskPart}#${layoutPart}`;
}

export function computeActiveProjectsFingerprint(
	missionId: string | undefined,
	orchNodes: readonly IOrchestrationGraphNode[],
	agentByNodeId: ReadonlyMap<string, IAdeAgent>,
): string {
	if (!missionId) {
		return '';
	}
	const parts: string[] = [missionId];
	for (const oNode of orchNodes) {
		if (oNode.kind !== 'staff') {
			continue;
		}
		const a = agentByNodeId.get(oNode.id);
		parts.push(a
			? `${oNode.id}:${a.id}|${a.label}|${a.role ?? ''}|${a.session?.engineId ?? ''}|${a.preferredEngineId ?? ''}|${a.preferredModel ?? ''}|${a.preferredThinking ?? ''}`
			: `${oNode.id}:`);
	}
	return parts.join('\x1e');
}

export function buildOrchestrationAgentMap(
	missionId: string | undefined,
	orchDirection: 'LR' | 'TD',
	orchNodes: readonly IOrchestrationGraphNode[],
	orchEdges: readonly IOrchestrationGraphEdge[],
	orchDepartments: readonly IOrchestrationDepartmentGroup[],
	generatedEmployees: readonly IAdeAgent[],
	missionRec: IAdeMissionRecord | undefined,
	projectsService: IAdeProjectsService | undefined,
): Map<string, IAdeAgent> {
	const map = new Map<string, IAdeAgent>();
	if (!missionId) {
		return map;
	}
	const byTreeKey = new Map<string, IAdeAgent>();
	for (const emp of generatedEmployees) {
		if (emp.treeNodeId) {
			byTreeKey.set(emp.treeNodeId, emp);
		}
		for (const nid of emp.treeNodeIds ?? []) {
			map.set(nid, emp);
		}
	}
	const ownerAgent = missionRec?.ownerSessionId && missionRec.ownerSessionId !== ADE_SECRETARY_ID
		? projectsService?.getAgent(missionRec.ownerSessionId)
		: undefined;
	if (ownerAgent && orchNodes.length > 0) {
		const rootNode = findHighestRankStaffNode({
			direction: orchDirection,
			nodes: orchNodes,
			edges: orchEdges,
			departments: orchDepartments,
		});
		if (rootNode && !map.has(rootNode.id)) {
			map.set(rootNode.id, ownerAgent);
		}
	}
	for (const oNode of orchNodes) {
		if (oNode.kind !== 'staff' || map.has(oNode.id)) {
			continue;
		}
		if (oNode.agentId) {
			const direct = projectsService?.getAgent(oNode.agentId);
			if (direct) {
				map.set(oNode.id, direct);
				continue;
			}
		}
		const fallback = (oNode.employeeKey ? byTreeKey.get(`emp:${oNode.employeeKey}`) : undefined)
			?? byTreeKey.get(oNode.id);
		if (fallback) {
			map.set(oNode.id, fallback);
		}
	}
	return map;
}

/**
 * Computes Console Bar FinOps spend pill text, budget circuit warning state,
 * and detailed hover breakdown using both Orchestration FinOps telemetry and
 * legacy per-node telemetry fallback.
 */
export function computeEngineeringConsoleFinOps(
	orch: IOrchestrationRuntimeState | undefined,
	runtimeState: IMissionRuntimeState | undefined,
): IEngineeringConsoleFinOpsSummary {
	let legacyCostUsd = 0;
	let legacyTokens = 0;
	let anyEstimated = false;
	if (runtimeState?.nodeTelemetry) {
		for (const t of Object.values(runtimeState.nodeTelemetry)) {
			legacyCostUsd += t.costUsd ?? 0;
			legacyTokens += t.totalTokens ?? 0;
			if (t.costEstimated) {
				anyEstimated = true;
			}
		}
	}
	const orchFinOps = orch?.finOpsTelemetry;
	const orchCostUsd = orch?.totalCostUsd ?? 0;
	const orchTokens = orchFinOps ? ((orchFinOps.totalInputTokens ?? 0) + (orchFinOps.totalOutputTokens ?? 0)) : 0;
	const totalCostUsd = orchCostUsd > 0 ? orchCostUsd : legacyCostUsd;
	const totalTokens = orchTokens > 0 ? orchTokens : legacyTokens;
	const budgetLimitUsd = orch?.budgetLimitUsd;
	const budgetTripped = Boolean(orch?.budgetCircuitTripped);

	if (totalCostUsd <= 0 && totalTokens <= 0 && !budgetTripped && !(budgetLimitUsd && budgetLimitUsd > 0)) {
		return { visible: false, text: '', tooltip: '', warningLevel: 'none' };
	}

	const costText = totalCostUsd > 0 ? formatFinOpsUsd(totalCostUsd, { estimated: anyEstimated && orchCostUsd <= 0, compact: true }) : '$0';
	const budgetText = budgetLimitUsd && budgetLimitUsd > 0
		? `${costText} / ${formatFinOpsUsd(budgetLimitUsd, { compact: true })}`
		: costText;
	const tokText = totalTokens > 0 ? formatCompactTokenCount(totalTokens) : '';
	const text = budgetTripped
		? adeBi(localize('adeEngConsoleBudgetTripped', "Budget Limit · {0}", budgetText), '预算熔断 · {0}', budgetText)
		: (tokText ? `${budgetText} · ${tokText}` : budgetText);

	let warningLevel: 'none' | 'warn' | 'tripped' = 'none';
	if (budgetTripped) {
		warningLevel = 'tripped';
	} else if (budgetLimitUsd && budgetLimitUsd > 0 && totalCostUsd / budgetLimitUsd >= 0.85) {
		warningLevel = 'warn';
	}

	const tooltipParts: string[] = [
		adeBi(localize('adeEngFinOpsSpendTip', "Spend: {0}", budgetText), '消耗：{0}', budgetText),
	];
	if (tokText) {
		tooltipParts.push(adeBi(localize('adeEngFinOpsTokensTip', "Tokens: {0}", tokText), '令牌数：{0}', tokText));
	}
	if (orchFinOps?.cacheHitRatePct !== undefined && orchFinOps.cacheHitRatePct > 0) {
		tooltipParts.push(adeBi(
			localize('adeEngFinOpsCacheTip', "Cache hit: {0}%", Math.round(orchFinOps.cacheHitRatePct)),
			'缓存命中：{0}%',
			Math.round(orchFinOps.cacheHitRatePct),
		));
	}
	if (orchFinOps?.reworkTokens && orchFinOps.reworkTokens > 0) {
		tooltipParts.push(adeBi(
			localize('adeEngFinOpsReworkTip', "Rework tokens: {0}", formatCompactTokenCount(orchFinOps.reworkTokens)),
			'返工消耗：{0}',
			formatCompactTokenCount(orchFinOps.reworkTokens),
		));
	}
	if (budgetTripped) {
		tooltipParts.push(adeBi(
			localize('adeEngFinOpsTrippedTip', "Budget circuit breaker tripped — orchestration auto-paused"),
			'已触发预算熔断 — 编排已自动暂停',
		));
	}

	return {
		visible: true,
		text,
		tooltip: tooltipParts.join(' · '),
		warningLevel,
	};
}

/**
 * Computes world bounding box including Department Subgraph frames, header pills,
 * and empty groups so Fit View never clips department banners off-screen.
 */
export function computeGraphWorldBounds(
	viewMode: AdeEngineeringViewMode,
	activeNodeIds: readonly string[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	getNodeDimensions: (nodeId: string) => { readonly width: number; readonly height: number },
	orchDepartments: readonly IOrchestrationDepartmentGroup[],
	renderedDeptBounds?: readonly IOrchDeptBounds[],
): IEngineeringWorldBounds | undefined {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;

	const includeBox = (x1: number, y1: number, x2: number, y2: number) => {
		minX = Math.min(minX, x1);
		maxX = Math.max(maxX, x2);
		minY = Math.min(minY, y1);
		maxY = Math.max(maxY, y2);
	};

	for (const id of activeNodeIds) {
		const pos = positions.get(id);
		if (!pos) {
			continue;
		}
		const size = getNodeDimensions(id);
		includeBox(pos.x - size.width / 2, pos.y - size.height / 2, pos.x + size.width / 2, pos.y + size.height / 2);
	}

	if (viewMode === 'orchestration') {
		if (renderedDeptBounds && renderedDeptBounds.length > 0) {
			for (const b of renderedDeptBounds) {
				includeBox(b.minX, b.minY - 18, b.maxX, b.maxY);
			}
		} else {
			const deptPadX = 36;
			const deptPadTop = 60; // 44px container padTop + 16px header pill overhang
			const deptPadBottom = 30;
			const emptyW = 368;
			const emptyH = 184;
			const globalBaseMaxX = Number.isFinite(maxX) ? maxX : 0;
			const globalBaseMinY = Number.isFinite(minY) ? minY : 150;
			let emptyIdx = 0;

			for (const dept of orchDepartments) {
				let dMinX = Infinity;
				let dMaxX = -Infinity;
				let dMinY = Infinity;
				let dMaxY = -Infinity;
				const allMemberIds = new Set([...dept.nodeIds, ...(dept.whiteboardIds ?? [])]);
				for (const memberId of allMemberIds) {
					const pos = positions.get(memberId);
					if (!pos) {
						continue;
					}
					const size = getNodeDimensions(memberId);
					dMinX = Math.min(dMinX, pos.x - size.width / 2);
					dMaxX = Math.max(dMaxX, pos.x + size.width / 2);
					dMinY = Math.min(dMinY, pos.y - size.height / 2);
					dMaxY = Math.max(dMaxY, pos.y + size.height / 2);
				}
				if (Number.isFinite(dMinX)) {
					includeBox(dMinX - deptPadX, dMinY - deptPadTop, dMaxX + deptPadX, dMaxY + deptPadBottom);
				} else {
					const stored = positions.get(dept.id);
					const cx = stored ? stored.x : globalBaseMaxX + 260;
					const cy = stored ? stored.y : globalBaseMinY + 90 + emptyIdx * 222;
					emptyIdx++;
					includeBox(cx - emptyW / 2, cy - emptyH / 2 - 18, cx + emptyW / 2, cy + emptyH / 2);
				}
			}
		}
	}

	if (!Number.isFinite(minX)) {
		return undefined;
	}
	return { minX, maxX, minY, maxY };
}

export function expandLegacyOverlappingTaskPositions(
	nodes: readonly IMissionDagNode[],
	positions: Map<string, IMissionNodePosition>,
	isVertical: boolean,
	getNodeSize: (node: IMissionDagNode) => { readonly width: number; readonly height: number },
): void {
	const minClearanceX = isVertical ? 36 : 68;
	const minClearanceY = isVertical ? 60 : 32;
	let scaleX = 1;
	let scaleY = 1;
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		const pa = positions.get(a.id);
		if (!pa) {
			continue;
		}
		const sa = getNodeSize(a);
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			const pb = positions.get(b.id);
			if (!pb) {
				continue;
			}
			const sb = getNodeSize(b);
			const dx = Math.abs(pa.x - pb.x);
			const dy = Math.abs(pa.y - pb.y);
			const reqX = (sa.width + sb.width) / 2 + minClearanceX;
			const reqY = (sa.height + sb.height) / 2 + minClearanceY;
			if (dx < reqX && dy < reqY) {
				if (dx >= 48 && dy < (sa.height + sb.height) / 2) {
					scaleX = Math.max(scaleX, Math.min(1.65, reqX / dx));
				} else if (dy >= 48 && dx < (sa.width + sb.width) / 2) {
					scaleY = Math.max(scaleY, Math.min(1.65, reqY / dy));
				} else {
					scaleX = Math.max(scaleX, 1.38);
					scaleY = Math.max(scaleY, 1.24);
				}
			}
		}
	}
	if (scaleX <= 1.01 && scaleY <= 1.01) {
		return;
	}
	let minX = Infinity;
	let minY = Infinity;
	for (const pos of positions.values()) {
		minX = Math.min(minX, pos.x);
		minY = Math.min(minY, pos.y);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
		return;
	}
	for (const [id, pos] of positions.entries()) {
		positions.set(id, {
			x: Math.round(minX + (pos.x - minX) * scaleX),
			y: Math.round(minY + (pos.y - minY) * scaleY),
		});
	}
}

export function computeDefaultNewNodeWorldPos(
	activeNodeIds: readonly string[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
): IMissionNodePosition {
	if (activeNodeIds.length === 0) {
		return { x: 260, y: 200 };
	}
	let maxX = -Infinity;
	let sumY = 0;
	let count = 0;
	for (const id of activeNodeIds) {
		const pos = positions.get(id);
		if (!pos) {
			continue;
		}
		maxX = Math.max(maxX, pos.x);
		sumY += pos.y;
		count++;
	}
	if (count === 0 || !Number.isFinite(maxX)) {
		return { x: 260, y: 200 };
	}
	return { x: Math.round(maxX + 412), y: Math.round(sumY / count) };
}

export function findCanvasSearchMatches(
	rawQuery: string,
	viewMode: AdeEngineeringViewMode,
	orchNodes: readonly IOrchestrationGraphNode[],
	missionNodes: readonly IMissionDagNode[],
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>>,
	nodePrompts: Readonly<Record<string, string>>,
): string[] {
	const query = rawQuery.trim().toLowerCase();
	if (!query) {
		return [];
	}
	const matches: string[] = [];
	if (viewMode === 'orchestration') {
		for (const oNode of orchNodes) {
			const wb = whiteboards[oNode.id];
			const haystack = [
				oNode.id,
				oNode.label,
				oNode.employeeName ?? '',
				oNode.department ?? '',
				oNode.rankId ?? '',
				...(oNode.allowedPaths ?? []),
				wb?.title ?? '',
				wb?.content ?? '',
			].join('\n').toLowerCase();
			if (haystack.includes(query)) {
				matches.push(oNode.id);
			}
		}
	} else {
		for (const node of missionNodes) {
			const haystack = [
				node.id,
				node.label,
				node.department ?? '',
				node.employeeName ?? '',
				nodePrompts[node.id] ?? '',
			].join('\n').toLowerCase();
			if (haystack.includes(query)) {
				matches.push(node.id);
			}
		}
	}
	return matches;
}

/**
 * Removes whiteboard store entries for deleted `WB_*` nodes so stale whiteboard
 * payloads never linger in Mission records or canvas search results.
 */
export function pruneWhiteboardsForDeletedNodes(
	whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
	deletedNodeIds: readonly string[],
): Record<string, IOrchestrationWhiteboard> | undefined {
	if (!whiteboards || deletedNodeIds.length === 0) {
		return undefined;
	}
	let changed = false;
	const next: Record<string, IOrchestrationWhiteboard> = {};
	const removeSet = new Set(deletedNodeIds);
	for (const [id, wb] of Object.entries(whiteboards)) {
		if (removeSet.has(id)) {
			changed = true;
			continue;
		}
		next[id] = wb;
	}
	return changed ? next : undefined;
}

export function buildMinimapSyncPayload(
	viewMode: AdeEngineeringViewMode,
	orchNodes: readonly IOrchestrationGraphNode[],
	orchEdges: readonly IOrchestrationGraphEdge[],
	missionNodes: readonly IMissionDagNode[],
	missionEdges: readonly IMissionDagEdge[],
	orchRuntime: IOrchestrationRuntimeState | undefined,
	taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>>,
	extras?: {
		readonly departmentBounds?: readonly IOrchDeptBounds[];
		readonly orchConflictNodeIds?: ReadonlySet<string>;
		readonly dagDiagnostics?: {
			readonly criticalNodeIds: ReadonlySet<string>;
			readonly criticalEdgeKeys: ReadonlySet<string>;
			readonly readyNodeIds: ReadonlySet<string>;
		};
	},
): {
	readonly nodes: readonly IMissionDagNode[];
	readonly edges: readonly IMissionDagEdge[];
	readonly options: IMissionMinimapSyncOptions;
} {
	if (viewMode === 'orchestration') {
		const compatNodes: IMissionDagNode[] = orchNodes.map(n => ({
			id: n.id,
			label: n.label,
			kind: 'task' as const,
		}));
		const compatEdges: IMissionDagEdge[] = orchEdges.map(e => ({
			id: e.id,
			from: e.from,
			to: e.to,
			label: e.label,
		}));
		const sizeOverride = new Map<string, { readonly width: number; readonly height: number }>();
		const nodeColors: Record<string, string | undefined> = {};
		const whiteboardNodeIds = new Set<string>();
		for (const n of orchNodes) {
			sizeOverride.set(n.id, getRenderedOrchestrationNodeSize(n));
			if (n.color) {
				nodeColors[n.id] = n.color;
			}
			if (n.kind === 'whiteboard') {
				whiteboardNodeIds.add(n.id);
			}
		}
		return {
			nodes: compatNodes,
			edges: compatEdges,
			options: {
				nodeStates: orchRuntime?.nodeStates,
				nodeSizeOverride: sizeOverride,
				nodeColors,
				whiteboardNodeIds: whiteboardNodeIds.size > 0 ? whiteboardNodeIds : undefined,
				conflictNodeIds: extras?.orchConflictNodeIds && extras.orchConflictNodeIds.size > 0 ? extras.orchConflictNodeIds : undefined,
				departmentBounds: extras?.departmentBounds && extras.departmentBounds.length > 0 ? extras.departmentBounds : undefined,
			},
		};
	}

	const mappedStates: Record<string, string> = {};
	const nodeColors: Record<string, string | undefined> = {};
	for (const n of missionNodes) {
		if (n.color) {
			nodeColors[n.id] = n.color;
		}
	}
	for (const [nid, rec] of Object.entries(taskStatuses)) {
		mappedStates[nid] = rec.status === 'in_progress'
			? 'active'
			: rec.status === 'completed'
				? 'completed'
				: rec.status === 'blocked'
					? 'blocked'
					: 'idle';
	}
	const diag = extras?.dagDiagnostics;
	return {
		nodes: missionNodes,
		edges: missionEdges,
		options: {
			nodeStates: mappedStates,
			nodeColors,
			criticalNodeIds: diag && diag.criticalNodeIds.size > 0 ? diag.criticalNodeIds : undefined,
			criticalEdgeKeys: diag && diag.criticalEdgeKeys.size > 0 ? diag.criticalEdgeKeys : undefined,
			readyNodeIds: diag && diag.readyNodeIds.size > 0 ? diag.readyNodeIds : undefined,
		},
	};
}

export function resolveMissionLayoutPositions(
	parsed: IMissionDagParseResult,
	storedPos: Readonly<Record<string, IMissionNodePosition>>,
	existingPos: ReadonlyMap<string, IMissionNodePosition>,
	forceAutoLayout: boolean,
	getNodeSize: (node: IMissionDagNode) => { readonly width: number; readonly height: number },
): Map<string, IMissionNodePosition> {
	const isVertical = parsed.direction === 'TD';
	const autoPos = computeMissionAutoLayout(parsed, {
		horizontalGap: isVertical ? 336 : 384,
		verticalGap: isVertical ? 236 : 208,
		originX: 260,
		originY: isVertical ? 200 : 280,
	});
	const nextPositions = new Map<string, IMissionNodePosition>();
	let usedStoredCount = 0;
	for (const node of parsed.nodes) {
		const saved = !forceAutoLayout ? (storedPos[node.id] ?? existingPos.get(node.id)) : undefined;
		if (saved) {
			usedStoredCount++;
		}
		nextPositions.set(node.id, saved ?? autoPos.get(node.id) ?? { x: 260, y: 260 });
	}
	if (!forceAutoLayout && usedStoredCount >= 2) {
		expandLegacyOverlappingTaskPositions(parsed.nodes, nextPositions, isVertical, getNodeSize);
	}
	return nextPositions;
}

function expandAutoOrchestrationLayoutForWidescreen(
	nodes: readonly IOrchestrationGraphNode[],
	rawPos: Map<string, IMissionNodePosition>,
	layoutMode: OrchestrationLayoutMode,
): Map<string, IMissionNodePosition> {
	const pos = new Map<string, { x: number; y: number }>();
	for (const [id, p] of rawPos.entries()) {
		pos.set(id, { x: p.x, y: p.y });
	}
	if (nodes.length <= 1) {
		return pos;
	}
	const isRadial = layoutMode === 'radial';
	const scaleX = layoutMode === 'lr' ? 1.15 : 1.14;
	const scaleY = isRadial ? 1.06 : 1.04;
	let anchorX = isRadial ? 0 : Infinity;
	let anchorY = isRadial ? 0 : Infinity;
	let count = 0;
	for (const n of nodes) {
		const p = pos.get(n.id);
		if (!p) {
			continue;
		}
		if (isRadial) {
			anchorX += p.x;
			anchorY += p.y;
			count++;
		} else {
			anchorX = Math.min(anchorX, p.x);
			anchorY = Math.min(anchorY, p.y);
		}
	}
	if (isRadial) {
		if (count > 0) {
			anchorX /= count;
			anchorY /= count;
		}
	} else if (!Number.isFinite(anchorX)) {
		return pos;
	}
	for (const n of nodes) {
		const p = pos.get(n.id);
		if (p) {
			p.x = Math.round(anchorX + (p.x - anchorX) * scaleX);
			p.y = Math.round(anchorY + (p.y - anchorY) * scaleY);
		}
	}
	// Pairwise anti-overlap relaxation for 344x188 Staff & 276x164 Whiteboard breathing room
	const gapX = 64;
	const gapY = 54;
	const sizes = new Map(nodes.map(n => [n.id, getRenderedOrchestrationNodeSize(n)]));
	for (let iter = 0; iter < 4; iter++) {
		let moved = false;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i];
			const pa = pos.get(a.id);
			const sa = sizes.get(a.id);
			if (!pa || !sa) {
				continue;
			}
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j];
				const pb = pos.get(b.id);
				const sb = sizes.get(b.id);
				if (!pb || !sb) {
					continue;
				}
				const dx = pb.x - pa.x;
				const dy = pb.y - pa.y;
				const penX = (sa.width + sb.width) / 2 + gapX - Math.abs(dx);
				const penY = (sa.height + sb.height) / 2 + gapY - Math.abs(dy);
				if (penX > 0 && penY > 0) {
					moved = true;
					if (penX <= penY) {
						const push = Math.ceil(penX / 2) + 1;
						const dir = dx >= 0 ? 1 : -1;
						pa.x -= dir * push;
						pb.x += dir * push;
					} else {
						const push = Math.ceil(penY / 2) + 1;
						const dir = dy >= 0 ? 1 : -1;
						pa.y -= dir * push;
						pb.y += dir * push;
					}
				}
			}
		}
		if (!moved) {
			break;
		}
	}
	return pos;
}

export function resolveOrchestrationLayoutPositions(
	parsed: IOrchestrationGraphParseResult,
	layoutMode: OrchestrationLayoutMode,
	storedPos: Readonly<Record<string, IMissionNodePosition>>,
	existingPos: ReadonlyMap<string, IMissionNodePosition>,
	forceAutoLayout: boolean,
): Map<string, IMissionNodePosition> {
	const autoPos = expandAutoOrchestrationLayoutForWidescreen(
		parsed.nodes,
		computeOrchestrationAutoLayout(parsed, { layoutMode }),
		layoutMode,
	);
	const codePos = !forceAutoLayout ? (parsed.positions ?? {}) : {};
	const nextPositions = new Map<string, IMissionNodePosition>();
	for (const node of parsed.nodes) {
		const saved = !forceAutoLayout ? (storedPos[node.id] ?? codePos[node.id] ?? existingPos.get(node.id)) : undefined;
		nextPositions.set(node.id, saved ?? autoPos.get(node.id) ?? { x: 260, y: 240 });
	}
	for (const dept of parsed.departments) {
		const savedDept = !forceAutoLayout ? (storedPos[dept.id] ?? codePos[dept.id] ?? existingPos.get(dept.id)) : undefined;
		if (savedDept) {
			nextPositions.set(dept.id, savedDept);
		}
	}
	return nextPositions;
}

export function updateEngineeringConsoleBarDom(
	dom: Pick<
		IEngineeringChromeDom,
		| 'consoleBarEl' | 'viewOrchBtnEl' | 'viewMissionBtnEl' | 'consoleTokensEl'
		| 'consoleSpendEl' | 'consolePauseBtnEl' | 'consoleAbortBtnEl' | 'consoleMinimapBtnEl'
	>,
	state: {
		readonly hasMission: boolean;
		readonly viewMode: AdeEngineeringViewMode;
		readonly orch: IOrchestrationRuntimeState | undefined;
		readonly runtimeState: IMissionRuntimeState | undefined;
		readonly hasRuntime: boolean;
		readonly isConfirmingAbort: boolean;
		readonly minimapVisible: boolean;
	},
): void {
	dom.consoleBarEl.hidden = !state.hasMission;
	if (!state.hasMission) {
		return;
	}
	const isOrch = state.viewMode === 'orchestration';
	dom.viewOrchBtnEl.classList.toggle('is-active', isOrch);
	dom.viewOrchBtnEl.setAttribute('aria-selected', String(isOrch));
	dom.viewMissionBtnEl.classList.toggle('is-active', !isOrch);
	dom.viewMissionBtnEl.setAttribute('aria-selected', String(!isOrch));

	const isPaused = state.orch?.status === 'paused';
	let activeCount = 0;
	let blockedCount = 0;
	let waitingJoinCount = 0;
	if (state.orch) {
		for (const tok of Object.values(state.orch.tokens)) {
			if (tok.status === 'active') {
				activeCount++;
			} else if (tok.status === 'blocked') {
				blockedCount++;
			} else if (tok.status === 'waiting_join') {
				waitingJoinCount++;
			}
		}
	}
	const inFlight = activeCount + blockedCount + waitingJoinCount;
	if (isPaused) {
		dom.consoleTokensEl.textContent = adeBi(localize('adeEngConsolePausedText', "PAUSED · {0} in-flight", inFlight), '已暂停 · {0} 在途', inFlight);
	} else if (inFlight > 0) {
		const detailParts: string[] = [];
		if (activeCount > 0) { detailParts.push(`${activeCount} active`); }
		if (blockedCount > 0) { detailParts.push(`${blockedCount} blk`); }
		if (waitingJoinCount > 0) { detailParts.push(`${waitingJoinCount} join`); }
		const isNarrowSplit = dom.consoleBarEl.clientWidth > 0 && dom.consoleBarEl.clientWidth < 680;
		const detailJoined = detailParts.join(' · ');
		dom.consoleTokensEl.textContent = isNarrowSplit
			? adeBi(detailJoined, '{0} 在途 ({1})', inFlight, detailJoined)
			: inFlight === 1
				? adeBi(localize('adeEngConsoleOneInFlightText', "1 token ({0})", detailJoined), '1 在途 ({0})', detailJoined)
				: adeBi(localize('adeEngConsoleInFlightText', "{0} tokens ({1})", inFlight, detailJoined), '{0} 在途 ({1})', inFlight, detailJoined);
	} else {
		dom.consoleTokensEl.textContent = adeBi(localize('adeEngConsoleIdleText', "0 in-flight"), '0 在途令牌');
	}
	dom.consoleTokensEl.classList.toggle('is-paused', isPaused);
	dom.consoleTokensEl.classList.toggle('is-active', !isPaused && inFlight > 0);

	const finOps = computeEngineeringConsoleFinOps(state.orch, state.runtimeState);
	if (finOps.visible) {
		dom.consoleSpendEl.textContent = finOps.text;
		dom.consoleSpendEl.title = finOps.tooltip;
		dom.consoleSpendEl.classList.toggle('is-budget-warn', finOps.warningLevel === 'warn');
		dom.consoleSpendEl.classList.toggle('is-budget-tripped', finOps.warningLevel === 'tripped');
		dom.consoleSpendEl.hidden = false;
	} else {
		dom.consoleSpendEl.hidden = true;
		dom.consoleSpendEl.classList.remove('is-budget-warn', 'is-budget-tripped');
		dom.consoleSpendEl.title = '';
	}

	dom.consolePauseBtnEl.disabled = !state.hasRuntime;
	dom.consolePauseBtnEl.classList.toggle('is-paused', isPaused);
	dom.consolePauseBtnEl.textContent = isPaused
		? adeBi(localize('adeEngConsoleResumeBtn', "Resume"), '恢复流转')
		: adeBi(localize('adeEngConsolePauseBtn', "Pause"), '暂停流转');
	dom.consolePauseBtnEl.title = isPaused
		? adeBi(localize('adeEngConsoleResumeTip', "Resume orchestration token dispatch"), '恢复整波令牌流转')
		: adeBi(localize('adeEngConsolePauseTip', "Pause orchestration token dispatch"), '一键暂停整波流转');

	dom.consoleAbortBtnEl.disabled = !state.hasRuntime || (inFlight === 0 && !isPaused);
	dom.consoleAbortBtnEl.classList.toggle('is-confirming', state.isConfirmingAbort);
	dom.consoleAbortBtnEl.textContent = state.isConfirmingAbort
		? adeBi(localize('adeEngConsoleAbortConfirmBtn', "Confirm Abort?"), '确认终止全部?')
		: adeBi(localize('adeEngConsoleAbortBtn', "Abort All"), '终止全部');
	dom.consoleAbortBtnEl.title = adeBi(localize('adeEngConsoleAbortTip', "Force-abort all active orchestration tokens (click twice to confirm)"), '强制终止全部在途令牌（点击两次确认）');
	dom.consoleMinimapBtnEl.classList.toggle('is-active', state.minimapVisible);
}

export interface IEngineeringCanvasInteractionHost {
	readonly rootEl: HTMLElement;
	readonly viewportEl: HTMLElement;
	readonly marqueeBoxEl: HTMLElement;
	readonly searchBarEl: HTMLElement;
	readonly searchInputEl: HTMLInputElement;
	readonly minZoom: number;
	readonly maxZoom: number;
	readonly panClickThresholdPx: number;
	getPanZoom(): IEngineeringViewportState;
	setPanZoom(panX: number, panY: number, zoom: number, immediate: boolean): void;
	cancelCameraAnimation(): void;
	closePopovers(): void;
	isPopoverOpen(): boolean;
	isFileDrawerOpen(): boolean;
	closeFileDrawer(): void;
	isCanvasShortcutActive(): boolean;
	getActiveNodeIds(): readonly string[];
	getNodePosition(nodeId: string): IMissionNodePosition | undefined;
	getNodeDimensions(nodeId: string): { readonly width: number; readonly height: number };
	clientToWorldPos(clientX: number, clientY: number): IMissionNodePosition;
	getSelectedNodeIds(): ReadonlySet<string>;
	hasSelection(): boolean;
	previewSelectedNodeIds(ids: ReadonlySet<string>): void;
	selectNode(nodeId: string | undefined): void;
	selectNodes(nodeIds: Iterable<string>, options?: { readonly additive?: boolean }): void;
	clearEdgeSelection(): void;
	openBlankCanvasContextMenu(clientX: number, clientY: number): void;
	openSearch(): void;
	closeSearch(restoreFocus: boolean): void;
	undo(): void;
	redo(): void;
	deleteSelected(): void;
	syncAnimationPauseState(): void;
}

/**
 * Installs pan, Shift-drag marquee, blank-canvas context menu, wheel zoom/pan,
 * visibility pause, and Split-Pane-isolated window keyboard shortcuts.
 */
export function installEngineeringCanvasInteractions(
	disposables: DisposableStore,
	host: IEngineeringCanvasInteractionHost,
): void {
	let panning = false;
	let panMoved = false;
	let marqueeSelecting = false;
	let marqueeAdditive = false;
	let startClientX = 0;
	let startClientY = 0;
	let startPanX = 0;
	let startPanY = 0;

	const computeMarqueeHitIds = (c1x: number, c1y: number, c2x: number, c2y: number): string[] => {
		const w1 = host.clientToWorldPos(Math.min(c1x, c2x), Math.min(c1y, c2y));
		const w2 = host.clientToWorldPos(Math.max(c1x, c2x), Math.max(c1y, c2y));
		const hits: string[] = [];
		for (const id of host.getActiveNodeIds()) {
			const pos = host.getNodePosition(id);
			if (!pos) {
				continue;
			}
			const sz = host.getNodeDimensions(id);
			if (pos.x - sz.width / 2 <= w2.x && pos.x + sz.width / 2 >= w1.x && pos.y - sz.height / 2 <= w2.y && pos.y + sz.height / 2 >= w1.y) {
				hits.push(id);
			}
		}
		return hits;
	};

	const updateMarqueeBoxDom = (curX: number, curY: number): void => {
		const vpRect = host.viewportEl.getBoundingClientRect();
		host.marqueeBoxEl.style.left = `${Math.round(Math.min(startClientX, curX) - vpRect.left)}px`;
		host.marqueeBoxEl.style.top = `${Math.round(Math.min(startClientY, curY) - vpRect.top)}px`;
		host.marqueeBoxEl.style.width = `${Math.round(Math.abs(curX - startClientX))}px`;
		host.marqueeBoxEl.style.height = `${Math.round(Math.abs(curY - startClientY))}px`;
	};

	disposables.add(addDisposableListener(host.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
		if (e.button !== 0 && e.button !== 1) {
			return;
		}
		host.cancelCameraAnimation();
		host.closePopovers();
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName;
		if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
			host.rootEl.focus({ preventScroll: true });
		}
		if (e.button === 0 && e.shiftKey) {
			e.preventDefault();
			host.clearEdgeSelection();
			marqueeSelecting = true;
			marqueeAdditive = Boolean(e.metaKey || e.ctrlKey);
			startClientX = e.clientX;
			startClientY = e.clientY;
			host.marqueeBoxEl.hidden = false;
			updateMarqueeBoxDom(e.clientX, e.clientY);
			host.viewportEl.classList.add('is-marquee-selecting');
			try { host.viewportEl.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
			return;
		}
		const vp = host.getPanZoom();
		panning = true;
		panMoved = false;
		startClientX = e.clientX;
		startClientY = e.clientY;
		startPanX = vp.panX;
		startPanY = vp.panY;
		host.viewportEl.classList.add('panning');
		try { host.viewportEl.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
	}));

	disposables.add(addDisposableListener(host.viewportEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
		if (marqueeSelecting) {
			updateMarqueeBoxDom(e.clientX, e.clientY);
			const hits = computeMarqueeHitIds(startClientX, startClientY, e.clientX, e.clientY);
			const previewIds = marqueeAdditive ? new Set([...host.getSelectedNodeIds(), ...hits]) : new Set(hits);
			host.previewSelectedNodeIds(previewIds);
			return;
		}
		if (!panning) {
			return;
		}
		const dx = e.clientX - startClientX;
		const dy = e.clientY - startClientY;
		if (!panMoved && Math.hypot(dx, dy) >= host.panClickThresholdPx) {
			panMoved = true;
		}
		host.setPanZoom(startPanX + dx, startPanY + dy, host.getPanZoom().zoom, false);
	}));

	const stopViewportDrag = (e: PointerEvent, cancelled = false) => {
		if (marqueeSelecting) {
			marqueeSelecting = false;
			host.marqueeBoxEl.hidden = true;
			host.viewportEl.classList.remove('is-marquee-selecting');
			try { host.viewportEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
			if (!cancelled) {
				const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
				if (dist >= 4) {
					host.selectNodes(computeMarqueeHitIds(startClientX, startClientY, e.clientX, e.clientY), { additive: marqueeAdditive });
				} else if (!marqueeAdditive) {
					host.selectNode(undefined);
				}
			} else {
				host.previewSelectedNodeIds(host.getSelectedNodeIds());
			}
			return;
		}
		if (!panning) {
			return;
		}
		const wasMoved = panMoved || Math.hypot(e.clientX - startClientX, e.clientY - startClientY) >= host.panClickThresholdPx;
		panning = false;
		panMoved = false;
		host.viewportEl.classList.remove('panning');
		const vp = host.getPanZoom();
		host.setPanZoom(vp.panX, vp.panY, vp.zoom, true);
		try { host.viewportEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
		if (!cancelled && !wasMoved) {
			host.clearEdgeSelection();
			if (host.getSelectedNodeIds().size > 0) {
				host.selectNode(undefined);
			}
		}
	};
	disposables.add(addDisposableListener(host.viewportEl, EventType.POINTER_UP, e => stopViewportDrag(e, false)));
	disposables.add(addDisposableListener(host.viewportEl, 'pointercancel', e => stopViewportDrag(e, true)));

	disposables.add(addDisposableListener(host.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
		const target = e.target as HTMLElement | null;
		if (target?.closest('.ade-mission-node, .ade-mission-edge-group, .ade-orch-dept-pill-group')) {
			return;
		}
		e.preventDefault();
		host.openBlankCanvasContextMenu(e.clientX, e.clientY);
	}));

	disposables.add(addDisposableListener(host.viewportEl, EventType.WHEEL, (e: WheelEvent) => {
		e.preventDefault();
		host.cancelCameraAnimation();
		if (host.isPopoverOpen()) {
			host.closePopovers();
		}
		const vp = host.getPanZoom();
		let { panX, panY, zoom } = vp;
		if (e.ctrlKey || e.metaKey) {
			const rect = host.viewportEl.getBoundingClientRect();
			const cursorX = e.clientX - rect.left;
			const cursorY = e.clientY - rect.top;
			const worldX = (cursorX - panX) / zoom;
			const worldY = (cursorY - panY) / zoom;
			const factor = e.deltaY < 0 ? 1.08 : 0.92;
			zoom = Math.round(Math.min(host.maxZoom, Math.max(host.minZoom, zoom * factor)) * 100) / 100;
			panX = cursorX - worldX * zoom;
			panY = cursorY - worldY * zoom;
		} else {
			panX -= e.deltaX;
			panY -= e.deltaY;
		}
		host.setPanZoom(panX, panY, zoom, true);
	}, { passive: false }));

	const win = getWindow(host.rootEl);
	disposables.add(addDisposableListener(win, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		const target = e.target as HTMLElement | null;
		const tag = target?.tagName;
		const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable);
		const canvasActive = host.isCanvasShortcutActive();
		const hasPrimaryMod = (e.metaKey || e.ctrlKey) && !e.altKey;
		const lowerKey = e.key.toLowerCase();

		if (hasPrimaryMod && !e.shiftKey && lowerKey === 'f' && canvasActive && !host.isFileDrawerOpen()) {
			const typingOutsideSearch = isTyping && target !== host.searchInputEl;
			if (!typingOutsideSearch) {
				e.preventDefault();
				e.stopImmediatePropagation();
				host.openSearch();
				return;
			}
		}

		if (hasPrimaryMod && !isTyping && canvasActive && !host.isPopoverOpen()) {
			if (lowerKey === 'z') {
				e.preventDefault();
				e.stopImmediatePropagation();
				if (e.shiftKey) {
					host.redo();
				} else {
					host.undo();
				}
				return;
			}
			if (lowerKey === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey) {
				e.preventDefault();
				e.stopImmediatePropagation();
				host.redo();
				return;
			}
			if (lowerKey === 'a' && !e.shiftKey && !host.isFileDrawerOpen() && host.getActiveNodeIds().length > 0) {
				e.preventDefault();
				e.stopImmediatePropagation();
				host.selectNodes(host.getActiveNodeIds());
				return;
			}
		}

		if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
			if (!isTyping && canvasActive && !host.isFileDrawerOpen() && !host.isPopoverOpen() && host.hasSelection()) {
				e.preventDefault();
				e.stopImmediatePropagation();
				host.deleteSelected();
				return;
			}
		}

		if (e.key === 'Escape' && canvasActive) {
			if (!host.searchBarEl.hidden) {
				host.closeSearch(true);
			} else if (host.isPopoverOpen()) {
				host.closePopovers();
			} else if (host.isFileDrawerOpen()) {
				host.closeFileDrawer();
			} else if (host.hasSelection()) {
				host.selectNode(undefined);
			}
		}
	}));
	disposables.add(addDisposableListener(win.document, 'visibilitychange', () => {
		host.syncAnimationPauseState();
	}));
	host.syncAnimationPauseState();
}

export function buildMissionNodeContextMenuItems(
	node: IMissionDagNode,
	isDone: boolean,
	handlers: {
		readonly onEditTask: () => void;
		readonly onRename: () => void;
		readonly onToggleComplete: () => void;
		readonly onDelete: () => void;
	},
): IEngineeringCanvasMenuItem[] {
	return [
		{
			id: 'edit-task',
			label: adeBi(localize('adeMissionCtxEditTask', "Edit Task Details"), '编辑任务详情'),
			icon: 'note',
			run: handlers.onEditTask,
		},
		{
			id: 'rename-node',
			label: adeBi(localize('adeMissionCtxRenameNode', "Rename"), '重命名'),
			icon: 'edit',
			run: handlers.onRename,
		},
		{
			id: 'toggle-complete',
			label: isDone
				? adeBi(localize('adeMissionCtxReopenTask', "Reopen Task"), '重置为待完成')
				: adeBi(localize('adeMissionCtxCompleteTask', "Mark Completed ✓"), '标注为已完成 ✓'),
			icon: isDone ? 'discard' : 'check',
			run: handlers.onToggleComplete,
		},
		{
			id: 'delete-node',
			label: adeBi(localize('adeMissionCtxDeleteNode', "Delete {0}", node.id), '删除 {0}', node.id),
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			run: handlers.onDelete,
		},
	];
}

export function buildWhiteboardNodeContextMenuItems(
	nodeId: string,
	handlers: {
		readonly onEditWhiteboard: () => void;
		readonly onRename: () => void;
		readonly onMoveToGroup: () => void;
		readonly onDelete: () => void;
	},
): IEngineeringCanvasMenuItem[] {
	return [
		{
			id: 'edit-whiteboard',
			label: adeBi(localize('adeOrchCtxEditWb', "Edit Whiteboard"), '编辑共享白板'),
			icon: 'notebook',
			run: handlers.onEditWhiteboard,
		},
		{
			id: 'rename-node',
			label: adeBi(localize('adeMissionCtxRenameNode', "Rename"), '重命名'),
			icon: 'edit',
			run: handlers.onRename,
		},
		{
			id: 'move-to-group',
			label: adeBi(localize('adeOrchCtxMoveToGroup', "Move to Group…"), '移动至分组…'),
			icon: 'folder',
			run: handlers.onMoveToGroup,
		},
		{
			id: 'delete-node',
			label: adeBi(localize('adeMissionCtxDeleteNode', "Delete {0}", nodeId), '删除 {0}', nodeId),
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			run: handlers.onDelete,
		},
	];
}

export function buildStaffNodeContextMenuItems(
	node: IMissionDagNode,
	oNode: IOrchestrationGraphNode | undefined,
	linkedAgent: IAdeAgent | undefined,
	org: IAdeOrganizationConfig,
	handlers: {
		readonly canOpenChat: boolean;
		readonly canResetSwitchEngine: boolean;
		readonly onOpenChat: () => void;
		readonly onResetSwitchEngine: () => void;
		readonly onCreateSubordinate: (minTier: number) => void;
		readonly onDispatchRequirement: () => void;
		readonly onRename: () => void;
		readonly onMoveToGroup: () => void;
		readonly onDelete: () => void;
	},
): IEngineeringCanvasMenuItem[] {
	const items: IEngineeringCanvasMenuItem[] = [];
	if (linkedAgent && handlers.canOpenChat) {
		items.push({
			id: 'open-agent-chat',
			label: adeBi(localize('adeOrchCtxOpenChat', "Open Employee Chat"), '打开员工会话'),
			icon: 'comment-discussion',
			run: handlers.onOpenChat,
		});
	}
	if (oNode && handlers.canResetSwitchEngine) {
		items.push({
			id: 'reset-session-switch-engine',
			label: adeBi(localize('adeOrchCtxResetSwitchEngine', "Reset Session & Switch Engine…"), '重置会话并切换引擎…'),
			icon: 'refresh',
			run: handlers.onResetSwitchEngine,
		});
	}
	const maxTier = org.ranks.reduce((m, r) => Math.max(m, r.tier), 1);
	const parentTier = oNode?.tier ?? 1;
	const parentRankDef = org.ranks.find(r => r.tier === parentTier);
	if (oNode && parentTier < maxTier && (!parentRankDef || parentRankDef.canHaveSubordinates)) {
		items.push({
			id: 'create-subordinate',
			label: adeBi(localize('adeOrchCtxCreateSub', "Create Subordinate…"), '动态创建下级员工…'),
			icon: 'person-add',
			run: () => handlers.onCreateSubordinate(parentTier + 1),
		});
	}
	items.push(
		{
			id: 'dispatch-requirement',
			label: adeBi(localize('adeOrchCtxDispatch', "Dispatch Requirement…"), '下达任务需求…'),
			icon: 'send',
			run: handlers.onDispatchRequirement,
		},
		{
			id: 'rename-node',
			label: adeBi(localize('adeMissionCtxRenameNode', "Rename"), '重命名'),
			icon: 'edit',
			run: handlers.onRename,
		},
		...(oNode ? [{
			id: 'move-to-group',
			label: adeBi(localize('adeOrchCtxMoveToGroup', "Move to Group…"), '移动至分组…'),
			icon: 'folder',
			run: handlers.onMoveToGroup,
		}] : []),
		{
			id: 'delete-node',
			label: adeBi(localize('adeMissionCtxDeleteNode', "Delete {0}", node.id), '删除 {0}', node.id),
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			run: handlers.onDelete,
		},
	);
	return items;
}

export function buildGroupContextMenuItems(
	group: IOrchestrationDepartmentGroup,
	handlers: {
		readonly onRenameGroup: () => void;
		readonly onAddStaffToGroup: () => void;
		readonly onAddWbToGroup: () => void;
		readonly onUngroup: () => void;
		readonly onDeleteGroupMembers: () => void;
	},
): IEngineeringCanvasMenuItem[] {
	return [
		{
			id: 'rename-group',
			label: adeBi(localize('adeOrchCtxRenameGroup', "Rename Group"), '重命名分组'),
			icon: 'edit',
			run: handlers.onRenameGroup,
		},
		{
			id: 'add-staff-to-group',
			label: adeBi(localize('adeOrchCtxAddStaffToGroup', "Add Staff to '{0}'…", group.name), '在「{0}」中新建员工…', group.name),
			icon: 'person-add',
			run: handlers.onAddStaffToGroup,
		},
		{
			id: 'add-wb-to-group',
			label: adeBi(localize('adeOrchCtxAddWbToGroup', "Add Whiteboard to '{0}'…", group.name), '在「{0}」中新建白板…', group.name),
			icon: 'notebook',
			run: handlers.onAddWbToGroup,
		},
		{
			id: 'ungroup',
			label: adeBi(localize('adeOrchCtxUngroup', "Ungroup (Keep Members)"), '解散分组（保留成员）'),
			icon: 'ungroup-by-ref-type',
			separatorBefore: true,
			run: handlers.onUngroup,
		},
		{
			id: 'delete-group-members',
			label: adeBi(localize('adeOrchCtxDeleteGroup', "Delete Group & Members"), '删除分组及全部成员'),
			icon: 'trash',
			danger: true,
			run: handlers.onDeleteGroupMembers,
		},
	];
}

export function buildEdgeContextMenuItems(
	viewMode: AdeEngineeringViewMode,
	hasReverse: boolean,
	handlers: {
		readonly onEditLabel: () => void;
		readonly onToggleBidirectional: () => void;
		readonly onDeleteEdge: () => void;
	},
): IEngineeringCanvasMenuItem[] {
	if (viewMode === 'orchestration') {
		return [
			{
				id: 'edit-edge-label',
				label: adeBi(localize('adeMissionCtxEditEdgeLabel', "Edit Label"), '编辑连线标签'),
				icon: 'edit',
				run: handlers.onEditLabel,
			},
			{
				id: 'toggle-bidir',
				label: hasReverse
					? adeBi(localize('adeOrchCtxToUnidir', "Make One-Way (-->)"), '切换为单向 (-->)')
					: adeBi(localize('adeOrchCtxToBidir', "Make Bidirectional (<-->)"), '切换为双向 (<-->)'),
				icon: 'arrow-swap',
				run: handlers.onToggleBidirectional,
			},
			{
				id: 'delete-edge',
				label: adeBi(localize('adeMissionCtxDeleteEdge', "Delete Edge"), '删除连线'),
				icon: 'trash',
				danger: true,
				separatorBefore: true,
				run: handlers.onDeleteEdge,
			},
		];
	}
	return [
		{
			id: 'edit-edge-label',
			label: adeBi(localize('adeMissionCtxEditEdgeLabel', "Edit Label"), '编辑连线标签'),
			icon: 'edit',
			run: handlers.onEditLabel,
		},
		{
			id: 'delete-edge',
			label: adeBi(localize('adeMissionCtxDeleteEdge', "Delete Edge"), '删除连线'),
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			run: handlers.onDeleteEdge,
		},
	];
}

export function buildBlankCanvasContextMenuItems(
	viewMode: AdeEngineeringViewMode,
	hasNodes: boolean,
	topStaffLabel: string | undefined,
	handlers: {
		readonly onAddGroup: () => void;
		readonly onAddStaff: () => void;
		readonly onAddWhiteboard: () => void;
		readonly onDispatchTopStaff: () => void;
		readonly onAddTask: () => void;
		readonly onFitView: () => void;
		readonly onAutoLayout: () => void;
	},
): IEngineeringCanvasMenuItem[] {
	if (viewMode === 'orchestration') {
		return [
			{
				id: 'add-group',
				label: adeBi(localize('adeOrchCtxAddGroup', "New Group / Department…"), '新建部门分组 (Group)…'),
				icon: 'folder',
				run: handlers.onAddGroup,
			},
			{
				id: 'add-staff',
				label: adeBi(localize('adeOrchCtxAddStaff', "New Staff Node…"), '新建员工节点…'),
				icon: 'person-add',
				run: handlers.onAddStaff,
			},
			{
				id: 'add-whiteboard',
				label: adeBi(localize('adeOrchCtxAddWhiteboard', "New Department Whiteboard…"), '新建部门共享白板…'),
				icon: 'notebook',
				run: handlers.onAddWhiteboard,
			},
			...(topStaffLabel ? [{
				id: 'dispatch-requirement',
				label: adeBi(localize('adeOrchCtxDispatchTop', "Dispatch Requirement to {0}…", topStaffLabel), '向最高职级 {0} 下达需求…', topStaffLabel),
				icon: 'send',
				separatorBefore: true,
				run: handlers.onDispatchTopStaff,
			}] : []),
			{
				id: 'fit-view',
				label: adeBi(localize('adeMissionCtxFitView', "Fit View"), '适配视口'),
				icon: 'screen-full',
				separatorBefore: true,
				disabled: !hasNodes,
				run: handlers.onFitView,
			},
			{
				id: 'auto-layout',
				label: adeBi(localize('adeMissionCtxAutoLayout', "Auto Layout"), '自动排版'),
				icon: 'layout',
				disabled: !hasNodes,
				run: handlers.onAutoLayout,
			},
		];
	}
	return [
		{
			id: 'add-task',
			label: adeBi(localize('adeMissionCtxAddTaskNode', "New Task Node"), '新建任务节点'),
			icon: 'add',
			run: handlers.onAddTask,
		},
		{
			id: 'fit-view',
			label: adeBi(localize('adeMissionCtxFitView', "Fit View"), '适配视口'),
			icon: 'screen-full',
			separatorBefore: true,
			disabled: !hasNodes,
			run: handlers.onFitView,
		},
		{
			id: 'auto-layout',
			label: adeBi(localize('adeMissionCtxAutoLayout', "Auto Layout"), '自动排版'),
			icon: 'layout',
			disabled: !hasNodes,
			run: handlers.onAutoLayout,
		},
	];
}

/**
 * Workbench-wide page-visibility animation guardrail for all ADE views.
 * Toggles `html.ade-page-hidden` on every registered VS Code window so ALL
 * infinite CSS animations pause when a window is minimized, hidden, or occluded.
 */
export class AdePageVisibilityAnimationGuard extends Disposable {
	static readonly ID = 'workbench.contrib.adePageVisibilityAnimationGuard';

	constructor() {
		super();
		const attachToWindow = (win: Window, store: DisposableStore) => {
			const doc = win.document;
			const sync = () => {
				const hidden = Boolean(doc.hidden || doc.visibilityState === 'hidden');
				doc.documentElement.classList.toggle('ade-page-hidden', hidden);
			};
			sync();
			store.add(addDisposableListener(doc, 'visibilitychange', sync));
			store.add({
				dispose: () => {
					if (!doc.hidden && doc.visibilityState !== 'hidden') {
						doc.documentElement.classList.remove('ade-page-hidden');
					}
				},
			});
		};

		for (const { window: win, disposables } of getWindows()) {
			const localStore = this._register(new DisposableStore());
			disposables.add(localStore);
			attachToWindow(win, localStore);
		}
		this._register(onDidRegisterWindow(({ window: win, disposables }) => {
			const localStore = this._register(new DisposableStore());
			disposables.add(localStore);
			attachToWindow(win, localStore);
		}));
	}
}

export interface IEngineeringChromeDom {
	readonly consoleBarEl: HTMLElement;
	readonly viewOrchBtnEl: HTMLButtonElement;
	readonly viewMissionBtnEl: HTMLButtonElement;
	readonly consoleTokensEl: HTMLElement;
	readonly consoleSpendEl: HTMLElement;
	readonly consolePauseBtnEl: HTMLButtonElement;
	readonly consoleAbortBtnEl: HTMLButtonElement;
	readonly consoleMinimapBtnEl: HTMLButtonElement;
	readonly searchBarEl: HTMLElement;
	readonly searchInputEl: HTMLInputElement;
	readonly searchCountEl: HTMLElement;
	readonly selectionHudEl: HTMLElement;
	readonly selectionHudLabelEl: HTMLElement;
	readonly canvasAlertEl: HTMLElement;
	readonly canvasAlertIconEl: HTMLElement;
	readonly canvasAlertTextEl: HTMLElement;
	readonly canvasAlertOpenFileBtn: HTMLButtonElement;
	readonly emptyHintEl: HTMLElement;
	readonly emptyHintTitleEl: HTMLElement;
	readonly emptyHintSubEl: HTMLElement;
}

export interface IEngineeringChromeHandlers {
	readonly onChromePointerDown: () => void;
	readonly onSwitchViewMode: (targetMode: AdeEngineeringViewMode, side: boolean) => void;
	readonly onTogglePause: () => void;
	readonly onAbortAll: () => void;
	readonly onToggleMinimap: () => void;
	readonly onSearchInput: () => void;
	readonly onSearchStep: (delta: 1 | -1) => void;
	readonly onSearchClose: () => void;
	readonly onBatchDelete: () => void;
	readonly onClearSelection: () => void;
	readonly onAlertOpenFile: () => void;
	readonly onAlertDismiss: () => void;
}

/**
 * Mounts the existing Engineering canvas HUD overlays (Global Console Bar,
 * Search Bar, Multi-Select HUD, Alert Toast, and minimalist Empty Hint).
 * Strictly preserves all `#160` DOM attributes and zero-new-button invariants.
 */
export function createEngineeringChromeDom(
	bodyEl: HTMLElement,
	viewportEl: HTMLElement,
	disposables: DisposableStore,
	handlers: IEngineeringChromeHandlers,
): IEngineeringChromeDom {
	const consoleBarEl = append(bodyEl, $('.ade-eng-console-bar', {
		role: 'toolbar',
		'aria-label': adeBi(localize('adeEngConsoleBarAria', "Engineering Global Console"), '工程编排全局控制台'),
		'data-ade-eng-console-bar': 'true',
	}));
	disposables.add(addDisposableListener(consoleBarEl, EventType.POINTER_DOWN, e => {
		handlers.onChromePointerDown();
		e.stopPropagation();
	}));

	const viewSwitch = append(consoleBarEl, $('.ade-eng-view-switch', {
		role: 'tablist',
		'aria-label': adeBi(localize('adeEngViewSwitchAria', "Switch Engineering View"), '切换工程视图'),
	}));
	const viewOrchBtnEl = append(viewSwitch, $('button.ade-eng-view-btn', {
		type: 'button',
		role: 'tab',
		'data-ade-eng-view-btn': 'orchestration',
		title: adeBi(localize('adeEngViewOrchTip', "Orchestration · All-Staff Cyclic Topology"), '员工自由编排拓扑视图'),
	})) as HTMLButtonElement;
	append(viewOrchBtnEl, $('span.codicon.codicon-organization', { 'aria-hidden': 'true' }));
	append(viewOrchBtnEl, $('span', {}, adeBi(localize('adeEngViewOrchLabel', "Staff"), '员工拓扑')));
	disposables.add(addDisposableListener(viewOrchBtnEl, EventType.CLICK, (e: MouseEvent) => handlers.onSwitchViewMode('orchestration', Boolean(e.altKey || e.metaKey || e.ctrlKey))));

	const viewMissionBtnEl = append(viewSwitch, $('button.ade-eng-view-btn', {
		type: 'button',
		role: 'tab',
		'data-ade-eng-view-btn': 'mission',
		title: adeBi(localize('adeEngViewMissionTip', "Mission · Acyclic Task DAG"), '任务有向无环图 (DAG) 视图'),
	})) as HTMLButtonElement;
	append(viewMissionBtnEl, $('span.codicon.codicon-type-hierarchy-sub', { 'aria-hidden': 'true' }));
	append(viewMissionBtnEl, $('span', {}, adeBi(localize('adeEngViewMissionLabel', "Task DAG"), '任务 DAG')));
	disposables.add(addDisposableListener(viewMissionBtnEl, EventType.CLICK, (e: MouseEvent) => handlers.onSwitchViewMode('mission', Boolean(e.altKey || e.metaKey || e.ctrlKey))));

	append(consoleBarEl, $('span.ade-eng-console-sep', { 'aria-hidden': 'true' }));

	const consoleTokensEl = append(consoleBarEl, $('span.ade-eng-console-pill.is-tokens', {
		'data-ade-eng-console-tokens': 'true',
	}));
	const consoleSpendEl = append(consoleBarEl, $('span.ade-eng-console-pill.is-spend', {
		'data-ade-eng-console-spend': 'true',
	}));
	consoleSpendEl.hidden = true;

	append(consoleBarEl, $('span.ade-eng-console-sep', { 'aria-hidden': 'true' }));

	const consolePauseBtnEl = append(consoleBarEl, $('button.ade-eng-console-btn.is-pause', {
		type: 'button',
		'data-ade-eng-pause-btn': 'true',
	})) as HTMLButtonElement;
	disposables.add(addDisposableListener(consolePauseBtnEl, EventType.CLICK, () => handlers.onTogglePause()));

	const consoleAbortBtnEl = append(consoleBarEl, $('button.ade-eng-console-btn.is-danger', {
		type: 'button',
		'data-ade-eng-abort-btn': 'true',
	})) as HTMLButtonElement;
	disposables.add(addDisposableListener(consoleAbortBtnEl, EventType.CLICK, () => handlers.onAbortAll()));

	const consoleMinimapBtnEl = append(consoleBarEl, $('button.ade-eng-console-btn.is-minimap', {
		type: 'button',
		'data-ade-eng-minimap-btn': 'true',
		title: adeBi(localize('adeEngMinimapToggleTip', "Toggle Minimap Overview"), '显示/隐藏拓扑小地图'),
	})) as HTMLButtonElement;
	append(consoleMinimapBtnEl, $('span.codicon.codicon-map', { 'aria-hidden': 'true' }));
	disposables.add(addDisposableListener(consoleMinimapBtnEl, EventType.CLICK, () => handlers.onToggleMinimap()));

	const searchBarEl = append(bodyEl, $('.ade-mission-search-bar', {
		role: 'search',
		'aria-label': adeBi(localize('adeMissionSearchAria', "Search Canvas Nodes"), '搜索画布节点'),
		'data-ade-canvas-search': 'true',
	}));
	searchBarEl.hidden = true;
	disposables.add(addDisposableListener(searchBarEl, EventType.POINTER_DOWN, e => {
		handlers.onChromePointerDown();
		e.stopPropagation();
	}));
	append(searchBarEl, $('span.codicon.codicon-search.ade-mission-search-ico', { 'aria-hidden': 'true' }));
	const searchInputEl = append(searchBarEl, $('input.ade-mission-search-input', {
		type: 'text',
		placeholder: adeBi(localize('adeMissionSearchPlaceholder', "Search nodes… (Enter next)"), '搜索节点 ID / 名称 / 描述… (Enter 下一个)'),
		'aria-label': localize('adeMissionSearchInputAria', "Filter nodes"),
		'data-ade-canvas-search-input': 'true',
	})) as HTMLInputElement;
	const searchCountEl = append(searchBarEl, $('span.ade-mission-search-count', {
		'data-ade-canvas-search-count': 'true',
	}, ''));
	const searchPrevBtn = append(searchBarEl, $('button.ade-mission-vp-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionSearchPrevTip', "Previous match (Shift+Enter)"), '上一个匹配 (Shift+Enter)'),
		'data-ade-canvas-search-prev': 'true',
	})) as HTMLButtonElement;
	searchPrevBtn.appendChild($('span.codicon.codicon-arrow-up'));
	const searchNextBtn = append(searchBarEl, $('button.ade-mission-vp-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionSearchNextTip', "Next match (Enter)"), '下一个匹配 (Enter)'),
		'data-ade-canvas-search-next': 'true',
	})) as HTMLButtonElement;
	searchNextBtn.appendChild($('span.codicon.codicon-arrow-down'));
	const searchCloseBtn = append(searchBarEl, $('button.ade-mission-vp-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionSearchCloseTip', "Close search (Esc)"), '关闭搜索 (Esc)'),
		'data-ade-canvas-search-close': 'true',
	})) as HTMLButtonElement;
	searchCloseBtn.appendChild($('span.codicon.codicon-close'));
	disposables.add(addDisposableListener(searchInputEl, EventType.INPUT, () => handlers.onSearchInput()));
	disposables.add(addDisposableListener(searchInputEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			handlers.onSearchStep(e.shiftKey ? -1 : 1);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			handlers.onSearchStep(1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			handlers.onSearchStep(-1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			handlers.onSearchClose();
		}
	}));
	disposables.add(addDisposableListener(searchPrevBtn, EventType.CLICK, () => handlers.onSearchStep(-1)));
	disposables.add(addDisposableListener(searchNextBtn, EventType.CLICK, () => handlers.onSearchStep(1)));
	disposables.add(addDisposableListener(searchCloseBtn, EventType.CLICK, () => handlers.onSearchClose()));

	const selectionHudEl = append(bodyEl, $('.ade-mission-selection-hud', {
		role: 'status',
		'aria-live': 'polite',
		'data-ade-selection-hud': 'true',
	}));
	selectionHudEl.hidden = true;
	disposables.add(addDisposableListener(selectionHudEl, EventType.POINTER_DOWN, e => {
		handlers.onChromePointerDown();
		e.stopPropagation();
	}));
	const selectionHudLabelEl = append(selectionHudEl, $('span.ade-mission-selection-hud-label', {
		'data-ade-selection-hud-label': 'true',
	}));
	const batchDelBtn = append(selectionHudEl, $('button.ade-mission-selection-hud-btn.danger', {
		type: 'button',
		title: adeBi(localize('adeMissionBatchDeleteTip', "Delete selected nodes (Delete / Backspace)"), '删除全部选中节点 (Delete / Backspace)'),
		'data-ade-selection-batch-delete': 'true',
	})) as HTMLButtonElement;
	batchDelBtn.appendChild($('span.codicon.codicon-trash'));
	append(batchDelBtn, $('span', {}, adeBi(localize('adeMissionBatchDeleteLabel', "Delete"), '删除')));
	disposables.add(addDisposableListener(batchDelBtn, EventType.CLICK, () => handlers.onBatchDelete()));
	const clearSelBtn = append(selectionHudEl, $('button.ade-mission-selection-hud-btn', {
		type: 'button',
		title: adeBi(localize('adeMissionClearSelectionTip', "Clear selection (Esc)"), '取消多选 (Esc)'),
		'data-ade-selection-clear': 'true',
	})) as HTMLButtonElement;
	clearSelBtn.appendChild($('span.codicon.codicon-close'));
	disposables.add(addDisposableListener(clearSelBtn, EventType.CLICK, () => handlers.onClearSelection()));

	const canvasAlertEl = append(bodyEl, $('.ade-mission-canvas-alert', {
		role: 'alert',
		'aria-live': 'assertive',
		'data-ade-mission-canvas-alert': 'true',
	}));
	canvasAlertEl.hidden = true;
	const canvasAlertIconEl = append(canvasAlertEl, $('span.codicon.codicon-error.ade-mission-canvas-alert-icon', { 'aria-hidden': 'true' }));
	const canvasAlertTextEl = append(canvasAlertEl, $('span.ade-mission-canvas-alert-text', {
		'data-ade-mission-canvas-alert-text': 'true',
	}));
	const canvasAlertOpenFileBtn = append(canvasAlertEl, $('button.ade-mission-canvas-alert-action', {
		type: 'button',
		'data-ade-mission-canvas-alert-open-file': 'true',
	}, adeBi(localize('adeEngAlertOpenSource', "Open Code"), '打开源码'))) as HTMLButtonElement;
	canvasAlertOpenFileBtn.hidden = true;
	disposables.add(addDisposableListener(canvasAlertOpenFileBtn, EventType.CLICK, () => handlers.onAlertOpenFile()));
	const alertDismissBtn = append(canvasAlertEl, $('button.ade-mission-canvas-alert-close', {
		type: 'button',
		title: adeBi(localize('adeMissionAlertDismiss', "Dismiss"), '关闭'),
		'aria-label': adeBi(localize('adeMissionAlertDismiss', "Dismiss"), '关闭'),
		'data-ade-mission-canvas-alert-dismiss': 'true',
	})) as HTMLButtonElement;
	alertDismissBtn.appendChild($('span.codicon.codicon-close'));
	disposables.add(addDisposableListener(alertDismissBtn, EventType.CLICK, () => handlers.onAlertDismiss()));

	const emptyHintEl = append(viewportEl, $('.ade-mission-empty-hint.is-minimal', {
		'data-ade-mission-empty-onboarding': 'true',
	}));
	const emptyHero = append(emptyHintEl, $('.ade-mission-empty-hero'));
	append(emptyHero, $('span.codicon.codicon-type-hierarchy-sub', { 'aria-hidden': 'true' }));
	const emptyHintTitleEl = append(emptyHero, $('.ade-mission-empty-hint-title'));
	const emptyHintSubEl = append(emptyHero, $('.ade-mission-empty-hint-sub'));

	return {
		consoleBarEl,
		viewOrchBtnEl,
		viewMissionBtnEl,
		consoleTokensEl,
		consoleSpendEl,
		consolePauseBtnEl,
		consoleAbortBtnEl,
		consoleMinimapBtnEl,
		searchBarEl,
		searchInputEl,
		searchCountEl,
		selectionHudEl,
		selectionHudLabelEl,
		canvasAlertEl,
		canvasAlertIconEl,
		canvasAlertTextEl,
		canvasAlertOpenFileBtn,
		emptyHintEl,
		emptyHintTitleEl,
		emptyHintSubEl,
	};
}
