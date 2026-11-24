/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AdeThinkingLevel } from '../../../../platform/ade/common/adeEngineering.js';
import { getEmployeeColorIndex, IMissionDagNode, IMissionNodePosition } from '../../../../platform/ade/common/adeMissionDag.js';
import {
	computeMissionNodeContextBreakdown,
	formatCompactTokenCount,
	IMissionRuntimeState,
	inferModelContextWindowTokens,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import { formatFinOpsUsd } from '../../../../platform/ade/common/adeModelPricing.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationJoinBarrier,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	computeOrchestrationAnchorPoint,
	getOrchestrationAnchorFraction,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	IOrchestrationRoutedEdge,
	ORCHESTRATION_ANCHOR_SIDES,
	ORCHESTRATION_SLOTS_PER_SIDE,
	OrchestrationAnchorSide,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { parseWhiteboardSections } from '../../../../platform/ade/common/adeOrchestrationWhiteboards.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import { IAdeOrganizationConfig, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import {
	ADE_LLM_PROVIDER_LABELS,
	renderAdeLlmIcon,
	resolveEffectiveAdeLlmProvider,
} from '../../../browser/adeLlmIcon.js';
import { renderAdeOsIcon } from '../../../browser/adeOsIcon.js';
import { IAdeAgent } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import {
	AdeMissionHostCatalog,
	applyMissionEngineIcon,
	MISSION_ENGINE_DEFAULT_MODELS,
} from './adeMissionHostCatalog.js';

export const ORCH_STAFF_CARD_WIDTH = 344;
export const ORCH_STAFF_CARD_HEIGHT = 188;
export const ORCH_WHITEBOARD_CARD_WIDTH = 276;
export const ORCH_WHITEBOARD_CARD_HEIGHT = 164;

export function getRenderedOrchestrationNodeSize(
	node: Pick<IOrchestrationGraphNode, 'kind'>,
): { readonly width: number; readonly height: number } {
	return node.kind === 'whiteboard'
		? { width: ORCH_WHITEBOARD_CARD_WIDTH, height: ORCH_WHITEBOARD_CARD_HEIGHT }
		: { width: ORCH_STAFF_CARD_WIDTH, height: ORCH_STAFF_CARD_HEIGHT };
}

function simplifyOrchRoutePoints(pts: readonly { readonly x: number; readonly y: number }[]): { readonly x: number; readonly y: number }[] {
	const d: { x: number; y: number }[] = [];
	for (const p of pts) {
		const prev = d[d.length - 1];
		if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) {
			d.push({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
		}
	}
	if (d.length <= 2) {
		return d;
	}
	const out: { x: number; y: number }[] = [d[0]];
	for (let i = 1; i < d.length - 1; i++) {
		const a = out[out.length - 1];
		const b = d[i];
		const c = d[i + 1];
		if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)) {
			continue;
		}
		out.push(b);
	}
	out.push(d[d.length - 1]);
	return out;
}

export function reanchorOrchestrationRoute(
	edge: IOrchestrationGraphEdge,
	raw: IOrchestrationRoutedEdge,
	nodeById: ReadonlyMap<string, IOrchestrationGraphNode>,
	positions: ReadonlyMap<string, IMissionNodePosition>,
	toSvgPath: (points: readonly { readonly x: number; readonly y: number }[], cornerRadius: number) => string,
	samplePoint: (points: readonly { readonly x: number; readonly y: number }[], fraction: number) => { readonly x: number; readonly y: number },
): IOrchestrationRoutedEdge {
	const fNode = nodeById.get(edge.from);
	const tNode = nodeById.get(edge.to);
	const fPos = positions.get(edge.from);
	const tPos = positions.get(edge.to);
	if (!fNode || !tNode || !fPos || !tPos || raw.points.length < 2) {
		return raw;
	}
	const fa = computeOrchestrationAnchorPoint(fPos, getRenderedOrchestrationNodeSize(fNode), raw.fromAnchor.side, raw.fromAnchor.slot, ORCHESTRATION_SLOTS_PER_SIDE, 0);
	const ta = computeOrchestrationAnchorPoint(tPos, getRenderedOrchestrationNodeSize(tNode), raw.toAnchor.side, raw.toAnchor.slot, ORCHESTRATION_SLOTS_PER_SIDE, 4);
	const pts = raw.points.map(p => ({ x: p.x, y: p.y }));
	const n = pts.length;
	const fH = fa.nx !== 0;
	const tH = ta.nx !== 0;
	let next: { x: number; y: number }[];
	if (n === 2) {
		if (fH && tH && Math.abs(fa.y - ta.y) >= 1) {
			const mx = Math.round((fa.x + ta.x) / 2);
			next = [fa, { x: mx, y: fa.y }, { x: mx, y: ta.y }, ta];
		} else if (!fH && !tH && Math.abs(fa.x - ta.x) >= 1) {
			const my = Math.round((fa.y + ta.y) / 2);
			next = [fa, { x: fa.x, y: my }, { x: ta.x, y: my }, ta];
		} else {
			next = [fa, ta];
		}
	} else if (n === 3 && fH !== tH) {
		const c = fH ? { x: ta.x, y: fa.y } : { x: fa.x, y: ta.y };
		const ok = (fH ? (c.x - fa.x) * fa.nx : (c.y - fa.y) * fa.ny) >= 12 && (tH ? (c.x - ta.x) * ta.nx : (c.y - ta.y) * ta.ny) >= 12;
		if (ok) {
			next = [fa, c, ta];
		} else {
			const s1 = { x: fa.x + fa.nx * 20, y: fa.y + fa.ny * 20 };
			const e1 = { x: ta.x + ta.nx * 20, y: ta.y + ta.ny * 20 };
			next = [fa, s1, fH ? { x: s1.x, y: e1.y } : { x: e1.x, y: s1.y }, e1, ta];
		}
	} else {
		const firstH = Math.abs(pts[0].y - pts[1].y) < 1;
		const lastH = Math.abs(pts[n - 1].y - pts[n - 2].y) < 1;
		pts[0] = { x: fa.x, y: fa.y };
		pts[n - 1] = { x: ta.x, y: ta.y };
		if (fH && firstH) { pts[1].y = fa.y; } else if (!fH && !firstH) { pts[1].x = fa.x; }
		if (tH && lastH) { pts[n - 2].y = ta.y; } else if (!tH && !lastH) { pts[n - 2].x = ta.x; }
		if (n === 4 && fa.side === ta.side) {
			if (fH) {
				const cx = fa.nx > 0 ? Math.max(pts[1].x, Math.max(fa.x, ta.x) + 28) : Math.min(pts[1].x, Math.min(fa.x, ta.x) - 28);
				pts[1].x = pts[2].x = cx;
			} else {
				const cy = fa.ny > 0 ? Math.max(pts[1].y, Math.max(fa.y, ta.y) + 28) : Math.min(pts[1].y, Math.min(fa.y, ta.y) - 28);
				pts[1].y = pts[2].y = cy;
			}
		} else {
			const clampStub = (idx: number, adj: number, a: { x: number; y: number; nx: number; ny: number }, opp: { x: number; y: number; nx: number; ny: number }, horiz: boolean, segH: boolean, oppH: boolean) => {
				if (horiz && segH) {
					const minOut = a.x + a.nx * 16;
					if ((pts[idx].x - minOut) * a.nx < 0) {
						const v = n === 4 && oppH && a.nx === -opp.nx ? Math.round((a.x + opp.x) / 2) : minOut;
						const share = n >= 4 && Math.abs(pts[idx].x - pts[adj].x) < 1;
						pts[idx].x = v;
						if (share) { pts[adj].x = v; }
					}
				} else if (!horiz && !segH) {
					const minOut = a.y + a.ny * 16;
					if ((pts[idx].y - minOut) * a.ny < 0) {
						const v = n === 4 && !oppH && a.ny === -opp.ny ? Math.round((a.y + opp.y) / 2) : minOut;
						const share = n >= 4 && Math.abs(pts[idx].y - pts[adj].y) < 1;
						pts[idx].y = v;
						if (share) { pts[adj].y = v; }
					}
				}
			};
			clampStub(1, 2, fa, ta, fH, firstH, tH);
			clampStub(n - 2, n - 3, ta, fa, tH, lastH, fH);
		}
		next = pts;
	}
	const clean = simplifyOrchRoutePoints(next);
	const mid = samplePoint(clean, raw.isBidirectional ? (edge.from < edge.to ? 0.38 : 0.62) : 0.5);
	return { ...raw, fromAnchor: fa, toAnchor: ta, points: clean, path: toSvgPath(clean, 16), midX: mid.x, midY: mid.y };
}

export function sanitizeCssSlug(raw: string): string {
	const cleaned = String(raw || '').trim().replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '');
	return cleaned || 'default';
}

export function getMissionWaveColorIndex(waveId: string | undefined): number {
	const safe = typeof waveId === 'string' ? waveId.trim() : '';
	if (!safe) {
		return 0;
	}
	const numMatch = /(\d+)$/.exec(safe);
	if (numMatch) {
		const parsed = Number.parseInt(numMatch[1], 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return (parsed - 1) % 6;
		}
	}
	let hash = 0;
	for (let i = 0; i < safe.length; i++) {
		hash = ((hash << 5) - hash + safe.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 6;
}

export function formatMissionWaveTag(waveId: string | undefined): string {
	const trimmed = typeof waveId === 'string' ? waveId.trim() : '';
	if (!trimmed) {
		return 'W?';
	}
	const numMatch = /(\d+)$/.exec(trimmed);
	if (numMatch) {
		return `W${numMatch[1]}`;
	}
	return trimmed.length > 6 ? trimmed.slice(0, 6) : trimmed;
}

export function formatMissionBlockedRemaining(expiresAt: number, now: number): { readonly text: string; readonly isOverdue: boolean } {
	const remMs = expiresAt - now;
	if (!Number.isFinite(remMs) || remMs <= 0) {
		return { text: adeBi(localize('adeMissionBlockedOverdue', "Overdue"), '已超时'), isOverdue: true };
	}
	const totalSec = Math.ceil(remMs / 1000);
	if (totalSec >= 3600) {
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		return { text: `${h}h ${String(m).padStart(2, '0')}m`, isOverdue: false };
	}
	if (totalSec >= 60) {
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return { text: `${m}m ${String(s).padStart(2, '0')}s`, isOverdue: false };
	}
	return { text: `${totalSec}s`, isOverdue: false };
}

function formatCompactChars(len: number): string {
	if (len >= 1000) {
		return `${(len / 1000).toFixed(1)}k`;
	}
	return `${len}c`;
}

function resolveSafeOrchTokenSummary(tok: IOrchestrationToken | undefined): string {
	if (!tok) {
		return '';
	}
	const raw = typeof tok.lastSummary === 'string'
		? tok.lastSummary
		: typeof (tok as { readonly summary?: unknown }).summary === 'string'
			? String((tok as { readonly summary?: unknown }).summary)
			: '';
	return raw.trim();
}

function computeTokenPointerCount(tok: IOrchestrationToken | undefined): number {
	if (!tok) {
		return 0;
	}
	const refCount = tok.contextRefs?.length ?? 0;
	const wbCount = tok.whiteboardPointers?.length ?? 0;
	if (refCount > 0 && wbCount > 0) {
		// Deduplicate wb:<id> if present in both contextRefs and whiteboardPointers
		const wbInRefs = new Set<string>();
		for (const r of tok.contextRefs ?? []) {
			if (r.kind === 'whiteboard') {
				wbInRefs.add(r.ptr.replace(/^wb:/, ''));
			}
		}
		let extraWb = 0;
		for (const wp of tok.whiteboardPointers ?? []) {
			if (!wbInRefs.has(wp.whiteboardId)) {
				extraWb++;
			}
		}
		return refCount + extraWb;
	}
	return refCount + wbCount;
}

export interface IOrchGraphDerivedIndex {
	readonly activeTokensByNode: ReadonlyMap<string, readonly IOrchestrationToken[]>;
	readonly boundTaskIdsByStaff: ReadonlyMap<string, readonly string[]>;
	readonly conflictCountByStaff: ReadonlyMap<string, number>;
	readonly conflictPathsByStaff: ReadonlyMap<string, readonly string[]>;
	readonly wbLinkCountById: ReadonlyMap<string, number>;
	readonly wbActiveReadersById: ReadonlyMap<string, ReadonlySet<string>>;
	readonly activeBarrierByOwner: ReadonlyMap<string, IOrchestrationJoinBarrier>;
}

export function buildOrchGraphDerivedIndex(
	orchEdges: readonly IOrchestrationGraphEdge[],
	dagNodes: readonly IMissionDagNode[],
	taskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined,
	orchRuntime: IOrchestrationRuntimeState | undefined,
): IOrchGraphDerivedIndex {
	const activeTokensByNode = new Map<string, IOrchestrationToken[]>();
	const boundTaskSetByStaff = new Map<string, Set<string>>();
	const conflictPathsSetByStaff = new Map<string, Set<string>>();
	const wbLinkCountById = new Map<string, number>();
	const wbActiveReadersById = new Map<string, Set<string>>();
	const activeBarrierByOwner = new Map<string, IOrchestrationJoinBarrier>();

	const addTaskForStaff = (staffId: string | undefined, taskId: string | undefined) => {
		if (!staffId || !taskId) {
			return;
		}
		const set = boundTaskSetByStaff.get(staffId) ?? new Set<string>();
		set.add(taskId);
		boundTaskSetByStaff.set(staffId, set);
	};

	for (const e of orchEdges) {
		wbLinkCountById.set(e.from, (wbLinkCountById.get(e.from) ?? 0) + 1);
		wbLinkCountById.set(e.to, (wbLinkCountById.get(e.to) ?? 0) + 1);
	}

	// Static + live task assignments from DAG
	for (const dn of dagNodes) {
		const rec = taskStatuses?.[dn.id];
		if (rec?.status === 'completed') {
			continue;
		}
		addTaskForStaff(rec?.assigneeNodeId ?? dn.assigneeNodeId ?? dn.ownerNodeId, dn.id);
	}

	if (orchRuntime) {
		const statusRank = (s: IOrchestrationToken['status']) => s === 'active' ? 0 : s === 'waiting_join' ? 1 : 2;
		const allTokens = Object.values(orchRuntime.tokens);
		for (const tok of allTokens) {
			if (tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join') {
				const arr = activeTokensByNode.get(tok.nodeId) ?? [];
				arr.push(tok);
				activeTokensByNode.set(tok.nodeId, arr);

				if (tok.taskNodeId) {
					addTaskForStaff(tok.nodeId, tok.taskNodeId);
				}
				for (const tid of tok.taskNodeIds ?? []) {
					addTaskForStaff(tok.nodeId, tid);
				}
				for (const wp of tok.whiteboardPointers ?? []) {
					const set = wbActiveReadersById.get(wp.whiteboardId) ?? new Set<string>();
					set.add(tok.nodeId);
					wbActiveReadersById.set(wp.whiteboardId, set);
				}
				for (const ref of tok.contextRefs ?? []) {
					if (ref.kind === 'whiteboard') {
						const wbId = ref.ptr.replace(/^wb:/, '');
						const set = wbActiveReadersById.get(wbId) ?? new Set<string>();
						set.add(tok.nodeId);
						wbActiveReadersById.set(wbId, set);
					}
				}
			}
		}
		for (const arr of activeTokensByNode.values()) {
			arr.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.arrivedAt - a.arrivedAt);
		}

		// Index active join barriers and fileConflicts back to owner + touched child staff nodes
		for (const barrier of Object.values(orchRuntime.joinBarriers ?? {})) {
			if (barrier.status === 'waiting') {
				activeBarrierByOwner.set(barrier.ownerNodeId, barrier);
			}
			const conflicts = barrier.fileConflicts ?? [];
			if (conflicts.length > 0) {
				const ownerSet = conflictPathsSetByStaff.get(barrier.ownerNodeId) ?? new Set<string>();
				for (const cf of conflicts) {
					ownerSet.add(cf.path);
					for (const fromStaffId of cf.fromNodeIds ?? []) {
						if (fromStaffId) {
							const childSet = conflictPathsSetByStaff.get(fromStaffId) ?? new Set<string>();
							childSet.add(cf.path);
							conflictPathsSetByStaff.set(fromStaffId, childSet);
						}
					}
					for (const childTokId of cf.tokenIds) {
						const childTok = orchRuntime.tokens[childTokId];
						if (childTok?.nodeId) {
							const childSet = conflictPathsSetByStaff.get(childTok.nodeId) ?? new Set<string>();
							childSet.add(cf.path);
							conflictPathsSetByStaff.set(childTok.nodeId, childSet);
						}
					}
				}
				conflictPathsSetByStaff.set(barrier.ownerNodeId, ownerSet);
			}
		}
	}

	const boundTaskIdsByStaff = new Map<string, readonly string[]>();
	for (const [staffId, set] of boundTaskSetByStaff.entries()) {
		boundTaskIdsByStaff.set(staffId, [...set]);
	}
	const conflictCountByStaff = new Map<string, number>();
	const conflictPathsByStaff = new Map<string, readonly string[]>();
	for (const [staffId, set] of conflictPathsSetByStaff.entries()) {
		conflictCountByStaff.set(staffId, set.size);
		conflictPathsByStaff.set(staffId, [...set]);
	}

	return {
		activeTokensByNode,
		boundTaskIdsByStaff,
		conflictCountByStaff,
		conflictPathsByStaff,
		wbLinkCountById,
		wbActiveReadersById,
		activeBarrierByOwner,
	};
}

export interface IOrchWhiteboardDomRefs {
	readonly kind: 'whiteboard';
	readonly rootEl: HTMLElement;
	readonly cardEl: HTMLElement;
	readonly idWrapEl: HTMLElement;
	readonly colorTriggerWrapEl: HTMLElement;
	readonly deptChipEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly bodySlotEl: HTMLElement;
	readonly ptrTagEl: HTMLElement;
	readonly linkCountEl: HTMLElement;
	readonly metaTagEl: HTMLElement;
	readonly verTagEl: HTMLElement;
	readonly dynamicDisposables: DisposableStore;
	whiteboard: IOrchestrationWhiteboard;
	lastSignature: string;
}

export interface IOrchStaffDomRefs {
	readonly kind: 'staff';
	readonly rootEl: HTMLElement;
	readonly cardEl: HTMLElement;
	readonly idWrapEl: HTMLElement;
	readonly stateDotEl: HTMLElement;
	readonly rankPillEl: HTMLElement;
	readonly colorTriggerWrapEl: HTMLElement;
	readonly topRightEl: HTMLElement;
	readonly coreIconTileEl: HTMLButtonElement;
	readonly coreLlmGlyphEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly modelRowEl: HTMLElement;
	readonly modelNameEl: HTMLElement;
	readonly thinkingTagEl: HTMLElement;
	readonly contextSummaryEl: HTMLElement;
	readonly metaStripEl: HTMLElement;
	readonly directiveBarEl: HTMLButtonElement;
	readonly directiveIcoEl: HTMLElement;
	readonly directivePreviewEl: HTMLElement;
	readonly directiveTagEl: HTMLElement;
	readonly ctxRowEl: HTMLElement;
	readonly ctxSegInitEl: HTMLElement;
	readonly ctxSegTierEl: HTMLElement;
	readonly ctxSegSourceEl: HTMLElement;
	readonly ctxSegNoiseEl: HTMLElement;
	readonly ctxTokensEl: HTMLElement;
	readonly ctxCacheEl: HTMLElement;
	readonly ctxCostEl: HTMLElement;
	readonly ctxPctEl: HTMLElement;
	readonly engineBadgeEl: HTMLButtonElement;
	readonly engineIconEl: HTMLElement;
	readonly engineNameEl: HTMLElement;
	readonly hostPillEl: HTMLButtonElement;
	readonly hostOsIconEl: HTMLElement;
	readonly hostNameEl: HTMLElement;
	readonly tokenPuckEl: HTMLButtonElement;
	readonly dynamicDisposables: DisposableStore;
	// Live 1Hz countdown refs for both blocked tokens and waiting_join deadlineAt SLA
	countdownEl?: HTMLElement;
	countdownTargetAt?: number;
	countdownMode?: 'blocked' | 'barrier';
	primaryOrchToken?: IOrchestrationToken;
	linkedAgent?: IAdeAgent;
	engineId: string;
	canSwitchEngine: boolean;
	canSwitchModel: boolean;
	hostAlias: string;
	displayHost: string;
	osKind: string;
	osLabel: string;
	lastOsSlug: string;
	isRemoteHost: boolean;
	nodeState: string;
	lastHeaderSig: string;
	lastModelSig: string;
	lastRuntimeSig: string;
}

export interface IOrchCardBuildContext {
	readonly nodesLayerEl: HTMLElement;
	readonly graphDisposables: DisposableStore;
	readonly hostCatalog: AdeMissionHostCatalog;
	readonly orchAnchorButtons: Map<string, HTMLButtonElement>;
	readonly applyCustomNodeColor: (nodeEl: HTMLElement, rawColor: string | undefined) => void;
	readonly mountNodeColorTrigger: (parentEl: HTMLElement, nodeId: string, label: string, rawColor: string | undefined, store: DisposableStore) => void;
	readonly bindMultiAnchorConnectDrag: (oNode: IOrchestrationGraphNode, anchorEl: HTMLButtonElement, side: OrchestrationAnchorSide, slot: number) => void;
	readonly startInlineNodeRename: (nodeId: string) => void;
	readonly onOpenWhiteboardPopover?: (whiteboard: IOrchestrationWhiteboard, anchorEl: HTMLElement, options?: { readonly initialSection?: string }) => void;
	readonly onOpenOrchestrationTokenPopover?: (staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement, options?: { readonly focusSection?: 'barrier' | 'scope' | 'rework'; readonly staffNodeId?: string }) => void;
	readonly onOpenModelPopover: (
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentModel?: string; readonly currentThinking?: AdeThinkingLevel; readonly hostAlias?: string },
	) => void;
	readonly onOpenEnginePopover: (
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly hostAlias?: string },
	) => void;
	readonly onOpenHostPopover: (node: IMissionDagNode, currentHost: string, anchorEl: HTMLElement) => void;
	readonly onJumpToMissionTask?: (taskNodeId: string) => void;
	readonly onRenameNodeAvailable: boolean;
}

function mountMultiAnchors(
	oNode: IOrchestrationGraphNode,
	cardEl: HTMLElement,
	ctx: IOrchCardBuildContext,
): void {
	for (const side of ORCHESTRATION_ANCHOR_SIDES) {
		for (let slot = 0; slot < ORCHESTRATION_SLOTS_PER_SIDE; slot++) {
			const pct = Math.round(getOrchestrationAnchorFraction(slot, ORCHESTRATION_SLOTS_PER_SIDE) * 100);
			const anchorBtn = append(cardEl, $(`button.ade-orch-anchor.side-${side}.slot-${slot}.is-connectable`, {
				type: 'button',
				'data-ade-connect-port': oNode.id,
				'data-anchor-side': side,
				'data-anchor-slot': String(slot),
				title: adeBi(
					localize('adeOrchAnchorTip', "Drag from this anchor to connect (hold Shift for bidirectional <-->)"),
					'从此锚点拖拽连线至任意节点（按住 Shift 创建双向连线 <-->）',
				),
			})) as HTMLButtonElement;
			if (side === 'top' || side === 'bottom') {
				anchorBtn.style.left = `${pct}%`;
			} else {
				anchorBtn.style.top = `${pct}%`;
			}
			ctx.orchAnchorButtons.set(`${oNode.id}:${side}:${slot}`, anchorBtn);
			ctx.bindMultiAnchorConnectDrag(oNode, anchorBtn, side, slot);
		}
	}
}

export interface IOrchWhiteboardPatchInput {
	readonly oNode: IOrchestrationGraphNode;
	readonly pos: IMissionNodePosition;
	readonly wb: IOrchestrationWhiteboard;
	readonly derived: IOrchGraphDerivedIndex;
}

export function buildOrchWhiteboardCardDom(
	input: IOrchWhiteboardPatchInput,
	ctx: IOrchCardBuildContext,
): IOrchWhiteboardDomRefs {
	const { oNode, pos, wb } = input;
	const nodeEl = append(ctx.nodesLayerEl, $('.ade-mission-node.kind-whiteboard', {
		'data-node-id': oNode.id,
		'data-node-kind': 'whiteboard',
		'data-whiteboard-id': wb.id,
		'data-department': wb.department,
	}));
	nodeEl.style.left = `${pos.x}px`;
	nodeEl.style.top = `${pos.y}px`;
	ctx.applyCustomNodeColor(nodeEl, oNode.color);

	const cardEl = append(nodeEl, $('.ade-mission-node-card.is-whiteboard-card'));
	append(cardEl, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));

	const topRow = append(cardEl, $('.ade-mission-node-top'));
	const idWrapEl = append(topRow, $('span.ade-mission-node-id-wrap'));
	append(idWrapEl, $('span.codicon.codicon-notebook.ade-orch-wb-ico', { 'aria-hidden': 'true' }));
	append(idWrapEl, $('span.ade-mission-node-id', { title: wb.id }, wb.id));
	const colorTriggerWrapEl = append(idWrapEl, $('span.ade-node-color-trigger-slot'));
	const deptChipEl = append(topRow, $('span.ade-orch-wb-dept-chip', { title: wb.department }, wb.department));

	const wbWell = append(cardEl, $('.ade-mission-core-well.wb-well'));
	const titleEl = append(wbWell, $('.ade-mission-node-title.is-wb-title', { title: wb.title }, wb.title));
	const bodySlotEl = append(wbWell, $('.ade-orch-wb-body-slot'));

	const foot = append(cardEl, $('.ade-orch-wb-footer'));
	const footLeft = append(foot, $('.ade-orch-wb-footer-left'));
	const ptrTagEl = append(footLeft, $('span.ade-orch-wb-ptr-tag', {}, `ptr:${wb.id}`));
	const linkCountEl = append(footLeft, $('span.ade-orch-wb-links-tag'));
	linkCountEl.hidden = true;
	const footRight = append(foot, $('.ade-orch-wb-footer-right'));
	const metaTagEl = append(footRight, $('span.ade-orch-wb-meta-tag'));
	metaTagEl.hidden = true;
	// Strictly preserve exact `'v0'` / `'v1'` / `'v2'` text inside `.ade-orch-wb-ver-tag`!
	const verTagEl = append(footRight, $('span.ade-orch-wb-ver-tag', {}, `v${wb.version}`));

	mountMultiAnchors(oNode, cardEl, ctx);

	const dynamicDisposables = ctx.graphDisposables.add(new DisposableStore());
	const refs: IOrchWhiteboardDomRefs = {
		kind: 'whiteboard',
		rootEl: nodeEl,
		cardEl,
		idWrapEl,
		colorTriggerWrapEl,
		deptChipEl,
		titleEl,
		bodySlotEl,
		ptrTagEl,
		linkCountEl,
		metaTagEl,
		verTagEl,
		dynamicDisposables,
		whiteboard: wb,
		lastSignature: '',
	};

	patchOrchWhiteboardCardDom(refs, input, ctx);
	return refs;
}

export function patchOrchWhiteboardCardDom(
	refs: IOrchWhiteboardDomRefs,
	input: IOrchWhiteboardPatchInput,
	ctx: IOrchCardBuildContext,
): void {
	const { oNode, pos, wb, derived } = input;
	refs.whiteboard = wb;

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

	const linkCount = derived.wbLinkCountById.get(wb.id) ?? 0;
	const activeReaders = derived.wbActiveReadersById.get(wb.id)?.size ?? 0;
	const sig = JSON.stringify([
		wb.title,
		wb.department,
		wb.version,
		wb.updatedAt,
		wb.content,
		wb.updatedByLabel ?? '',
		oNode.color ?? '',
		linkCount,
		activeReaders,
	]);
	if (refs.lastSignature === sig) {
		return;
	}
	refs.lastSignature = sig;

	ctx.applyCustomNodeColor(refs.rootEl, oNode.color);
	refs.rootEl.setAttribute('data-department', wb.department);
	refs.deptChipEl.textContent = wb.department;
	refs.deptChipEl.title = wb.department;
	if (refs.titleEl.firstElementChild?.tagName !== 'INPUT') {
		refs.titleEl.textContent = wb.title;
		refs.titleEl.title = wb.title;
	}
	refs.verTagEl.textContent = `v${wb.version}`;
	refs.ptrTagEl.textContent = `ptr:${wb.id}`;

	refs.dynamicDisposables.clear();
	clearNode(refs.colorTriggerWrapEl);
	ctx.mountNodeColorTrigger(refs.colorTriggerWrapEl, oNode.id, wb.title, oNode.color, refs.dynamicDisposables);

	// Body: Markdown TOC heading chips (max 3) when headings exist, else crisp excerpt
	clearNode(refs.bodySlotEl);
	const sections = parseWhiteboardSections(wb.content);
	if (sections.length > 0) {
		const tocEl = append(refs.bodySlotEl, $('.ade-orch-wb-toc'));
		const visibleSections = sections.slice(0, 3);
		for (const sec of visibleSections) {
			const chipBtn = append(tocEl, $('button.ade-orch-wb-toc-chip', {
				type: 'button',
				'data-ade-wb-section': sec.title,
				title: adeBi(
					localize('adeOrchWbTocChipTip', "Jump to section \"{0}\" (line {1})", sec.title, sec.startLine),
					'跳转到章节「{0}」（第 {1} 行）',
					sec.title,
					sec.startLine,
				),
			}, `§ ${sec.title}`)) as HTMLButtonElement;
			refs.dynamicDisposables.add(addDisposableListener(chipBtn, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onOpenWhiteboardPopover?.(refs.whiteboard, chipBtn, { initialSection: sec.title });
			}));
		}
		if (sections.length > 3) {
			append(tocEl, $('span.ade-orch-wb-toc-more', {
				title: sections.slice(3).map(s => `§ ${s.title}`).join('\n'),
			}, `+${sections.length - 3}`));
		}
	} else {
		const trimmed = wb.content.trim();
		const excerpt = trimmed
			? trimmed.replace(/\s+/g, ' ').slice(0, 120)
			: adeBi(localize('adeOrchWbEmptyExcerpt', "Department shared whiteboard — click to read or write…"), '部门共享白板 — 点击查看或编辑共享内容…');
		const excerptEl = append(refs.bodySlotEl, $('.ade-orch-wb-excerpt', {}, excerpt));
		if (!trimmed) {
			excerptEl.classList.add('is-empty');
		}
	}

	// Footer link/ref counter + compact metadata tag (sibling to exact `.ade-orch-wb-ver-tag`)
	const totalRefIndicator = Math.max(linkCount, activeReaders);
	if (totalRefIndicator > 0) {
		refs.linkCountEl.hidden = false;
		refs.linkCountEl.textContent = activeReaders > 0 ? `⇄ ${totalRefIndicator} · ⚡${activeReaders}` : `⇄ ${totalRefIndicator}`;
		refs.linkCountEl.title = adeBi(
			localize('adeOrchWbLinksTip', "{0} connected links, {1} active staff reading", linkCount, activeReaders),
			'{0} 条关联连线，{1} 位活跃员工正在引用',
			linkCount,
			activeReaders,
		);
	} else {
		refs.linkCountEl.hidden = true;
	}

	const charLen = wb.content.trim().length;
	if (charLen > 0 || sections.length > 0 || wb.updatedByLabel) {
		const parts: string[] = [];
		if (charLen > 0) {
			parts.push(formatCompactChars(charLen));
		}
		if (sections.length > 0) {
			parts.push(`${sections.length}§`);
		}
		refs.metaTagEl.hidden = parts.length === 0;
		refs.metaTagEl.textContent = parts.join(' · ');
		refs.metaTagEl.title = wb.updatedByLabel
			? adeBi(
				localize('adeOrchWbUpdatedByTip', "Last updated by {0} ({1} chars, {2} sections)", wb.updatedByLabel, charLen, sections.length),
				'最近编辑：{0}（{1} 字符，{2} 章节）',
				wb.updatedByLabel,
				charLen,
				sections.length,
			)
			: `${charLen} chars · ${sections.length} sections`;
	} else {
		refs.metaTagEl.hidden = true;
	}
}

export interface IOrchStaffPatchInput {
	readonly oNode: IOrchestrationGraphNode;
	readonly pos: IMissionNodePosition;
	readonly compatDagNode: IMissionDagNode;
	readonly linkedAgent: IAdeAgent | undefined;
	readonly runtimeState: IMissionRuntimeState | undefined;
	readonly orchRuntime: IOrchestrationRuntimeState | undefined;
	readonly fallbackOwnerEngineId: string;
	readonly orgConfig: IAdeOrganizationConfig;
	readonly hasSubordinates: (agentId: string) => boolean;
	readonly canSwitchEngineFn: (agent: IAdeAgent) => boolean;
	readonly canSwitchModel: boolean;
	readonly canSwitchHost: boolean;
	readonly derived: IOrchGraphDerivedIndex;
	readonly resolveNodeLabel: (nodeId: string) => string;
}

export function buildOrchStaffCardDom(
	input: IOrchStaffPatchInput,
	ctx: IOrchCardBuildContext,
): IOrchStaffDomRefs {
	const { oNode, pos } = input;
	const nodeEl = append(ctx.nodesLayerEl, $('.ade-mission-node.kind-staff', {
		'data-node-id': oNode.id,
		'data-node-kind': 'staff',
		...(oNode.department ? { 'data-department': oNode.department } : {}),
		...(oNode.employeeKey ? { 'data-employee-key': oNode.employeeKey } : {}),
	}));
	nodeEl.style.left = `${pos.x}px`;
	nodeEl.style.top = `${pos.y}px`;

	const cardEl = append(nodeEl, $('.ade-mission-node-card.is-staff-card'));
	append(cardEl, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
	append(cardEl, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));

	const topRow = append(cardEl, $('.ade-mission-node-top'));
	const idWrapEl = append(topRow, $('span.ade-mission-node-id-wrap'));
	const stateDotEl = append(idWrapEl, $('span.ade-mission-state-dot', { 'aria-hidden': 'true' }));
	stateDotEl.hidden = true;
	append(idWrapEl, $('span.ade-mission-node-id', { title: oNode.id }, oNode.id));
	const rankPillEl = append(idWrapEl, $('span.ade-mission-rank-pill'));
	const colorTriggerWrapEl = append(idWrapEl, $('span.ade-node-color-trigger-slot'));
	const topRightEl = append(topRow, $('.ade-mission-top-pills'));

	// Recessed Core Well
	const coreWellEl = append(cardEl, $('.ade-mission-core-well'));
	const coreHead = append(coreWellEl, $('.ade-mission-core-head'));
	const coreIconTileEl = append(coreHead, $('button.ade-mission-core-icon-well', { type: 'button' })) as HTMLButtonElement;
	const coreLlmGlyphEl = append(coreIconTileEl, $('span.ade-mission-llm-icon', { 'aria-hidden': 'true' }));

	const coreMeta = append(coreHead, $('.ade-mission-core-meta'));
	const coreTitleRow = append(coreMeta, $('.ade-mission-core-title-row'));
	const titleEl = append(coreTitleRow, $('.ade-mission-node-title', { title: oNode.label }, oNode.label));
	const modelRowEl = append(coreMeta, $('.ade-mission-core-model-row'));
	const modelNameEl = append(modelRowEl, $('span.ade-mission-model-name'));
	append(modelRowEl, $('span.ade-mission-model-sep', { 'aria-hidden': 'true' }, '·'));
	const thinkingTagEl = append(modelRowEl, $('span.ade-mission-thinking-tag'));

	const contextSummaryEl = append(coreWellEl, $('.ade-mission-core-context'));
	// Round-2 Governance & Linkage Strip (bound Task jump, Scope/Conflict, Rework attempt)
	const metaStripEl = append(coreWellEl, $('.ade-orch-staff-meta-strip'));
	metaStripEl.hidden = true;

	// Recessed Baton / Directive Status Strip (de-duplicated from `.ade-mission-core-context`!)
	const directiveBarEl = append(coreWellEl, $('button.ade-mission-node-prompt-bar', {
		type: 'button',
		'data-ade-orch-directive-bar': oNode.id,
	})) as HTMLButtonElement;
	const directiveIcoEl = append(directiveBarEl, $('span.codicon.codicon-note.ade-mission-node-prompt-ico', { 'aria-hidden': 'true' }));
	const directivePreviewEl = append(directiveBarEl, $('span.ade-mission-node-prompt-preview'));
	const directiveTagEl = append(directiveBarEl, $('span.ade-mission-node-prompt-tag'));

	// 4-Segment Context Window Usage Progress Bar
	const ctxRowEl = append(cardEl, $('.ade-mission-ctx-row'));
	const ctxTrack = append(ctxRowEl, $('.ade-mission-ctx-track'));
	const ctxSegInitEl = append(ctxTrack, $('.ade-ctx-seg.seg-init'));
	const ctxSegTierEl = append(ctxTrack, $('.ade-ctx-seg.seg-tier'));
	const ctxSegSourceEl = append(ctxTrack, $('.ade-ctx-seg.seg-source'));
	const ctxSegNoiseEl = append(ctxTrack, $('.ade-ctx-seg.seg-noise'));
	const ctxStats = append(ctxRowEl, $('.ade-mission-ctx-stats'));
	const ctxTokensEl = append(ctxStats, $('span.ade-mission-ctx-tokens'));
	const ctxCacheEl = append(ctxStats, $('span.ade-mission-ctx-cache'));
	ctxCacheEl.hidden = true;
	const ctxCostEl = append(ctxStats, $('span.ade-mission-ctx-cost'));
	ctxCostEl.hidden = true;
	const ctxPctEl = append(ctxStats, $('span.ade-mission-ctx-pct'));

	// Engine + OS Host Footer
	const footer = append(cardEl, $('.ade-mission-node-footer'));
	const engineBadgeEl = append(footer, $('button.ade-mission-engine-pill', { type: 'button' })) as HTMLButtonElement;
	const engineIconEl = append(engineBadgeEl, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
	const engineNameEl = append(engineBadgeEl, $('span.ade-mission-engine-name'));

	const hostPillEl = append(footer, $('button.ade-mission-host-pill', { type: 'button' })) as HTMLButtonElement;
	const hostOsIconEl = append(hostPillEl, $('span.ade-mission-os-icon', { 'aria-hidden': 'true' }));
	const hostNameEl = append(hostPillEl, $('span.ade-mission-host-name'));

	// Floating Baton Token Puck
	const tokenPuckEl = append(nodeEl, $('button.ade-mission-token-puck', {
		type: 'button',
		'data-ade-orch-token-puck': oNode.id,
	})) as HTMLButtonElement;
	tokenPuckEl.hidden = true;

	// Mount 20 Perimeter Multi-Anchor Connection Ports (4 sides × 5 slots)
	mountMultiAnchors(oNode, cardEl, ctx);

	if (ctx.onRenameNodeAvailable) {
		ctx.graphDisposables.add(addDisposableListener(titleEl, EventType.DBLCLICK, e => {
			e.stopPropagation();
			ctx.startInlineNodeRename(oNode.id);
		}));
	}

	const dynamicDisposables = ctx.graphDisposables.add(new DisposableStore());
	const refs: IOrchStaffDomRefs = {
		kind: 'staff',
		rootEl: nodeEl,
		cardEl,
		idWrapEl,
		stateDotEl,
		rankPillEl,
		colorTriggerWrapEl,
		topRightEl,
		coreIconTileEl,
		coreLlmGlyphEl,
		titleEl,
		modelRowEl,
		modelNameEl,
		thinkingTagEl,
		contextSummaryEl,
		metaStripEl,
		directiveBarEl,
		directiveIcoEl,
		directivePreviewEl,
		directiveTagEl,
		ctxRowEl,
		ctxSegInitEl,
		ctxSegTierEl,
		ctxSegSourceEl,
		ctxSegNoiseEl,
		ctxTokensEl,
		ctxCacheEl,
		ctxCostEl,
		ctxPctEl,
		engineBadgeEl,
		engineIconEl,
		engineNameEl,
		hostPillEl,
		hostOsIconEl,
		hostNameEl,
		tokenPuckEl,
		dynamicDisposables,
		linkedAgent: input.linkedAgent,
		engineId: input.fallbackOwnerEngineId,
		canSwitchEngine: false,
		canSwitchModel: false,
		hostAlias: 'local',
		displayHost: 'Local',
		osKind: 'macos',
		osLabel: 'macOS',
		lastOsSlug: '',
		isRemoteHost: false,
		nodeState: 'idle',
		lastHeaderSig: '',
		lastModelSig: '',
		lastRuntimeSig: '',
	};

	patchOrchStaffCardDom(refs, input, ctx);
	return refs;
}

export function patchOrchStaffCardDom(
	refs: IOrchStaffDomRefs,
	input: IOrchStaffPatchInput,
	ctx: IOrchCardBuildContext,
): void {
	const {
		oNode,
		pos,
		compatDagNode,
		linkedAgent,
		runtimeState,
		orchRuntime,
		fallbackOwnerEngineId,
		orgConfig,
		hasSubordinates,
		canSwitchEngineFn,
		canSwitchModel,
		canSwitchHost,
		derived,
		resolveNodeLabel,
	} = input;

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

	const explicitHostAlias = runtimeState?.boundary?.nodeAssignments?.[oNode.id]?.hostAlias ?? oNode.hostAlias;
	const hostInfo = ctx.hostCatalog.resolveNodeHostAndOs(explicitHostAlias, linkedAgent);
	const rankDef = oNode.rankId || oNode.tier !== undefined
		? (orgConfig.ranks.find(r => (oNode.rankId && r.id === oNode.rankId) || (oNode.tier !== undefined && r.tier === oNode.tier))
			?? resolveEffectiveRankDefinition(orgConfig, linkedAgent?.role, linkedAgent ? hasSubordinates(linkedAgent.id) : false))
		: resolveEffectiveRankDefinition(orgConfig, linkedAgent?.role, linkedAgent ? hasSubordinates(linkedAgent.id) : false);
	const tierNum = oNode.tier ?? rankDef.tier;
	const nodeState = orchRuntime?.nodeStates[oNode.id] ?? 'idle';
	const liveTokens = derived.activeTokensByNode.get(oNode.id) ?? [];
	const primaryOrchTok = liveTokens[0];
	const conflictCount = derived.conflictCountByStaff.get(oNode.id) ?? 0;
	const conflictPaths = derived.conflictPathsByStaff.get(oNode.id) ?? [];

	refs.linkedAgent = linkedAgent;
	refs.primaryOrchToken = primaryOrchTok;
	refs.nodeState = nodeState;
	refs.hostAlias = hostInfo.hostAlias;
	refs.displayHost = hostInfo.displayHost;
	refs.osKind = hostInfo.osKind;
	refs.osLabel = hostInfo.osLabel;
	refs.isRemoteHost = hostInfo.isRemote;

	// Root classes & attributes
	const stateSlug = sanitizeCssSlug(nodeState.replace(/_/g, '-'));
	const osSlug = sanitizeCssSlug(hostInfo.osKind);
	refs.rootEl.setAttribute('data-node-state', nodeState);
	refs.rootEl.setAttribute('data-node-tier', String(tierNum));
	refs.rootEl.setAttribute('data-node-rank', rankDef.id);
	refs.rootEl.setAttribute('data-node-os', hostInfo.osKind);
	refs.rootEl.setAttribute('data-node-host', hostInfo.hostAlias);
	if (oNode.department) {
		refs.rootEl.setAttribute('data-department', oNode.department);
	} else {
		refs.rootEl.removeAttribute('data-department');
	}
	if (oNode.employeeKey) {
		refs.rootEl.setAttribute('data-employee-key', oNode.employeeKey);
	} else {
		refs.rootEl.removeAttribute('data-employee-key');
	}
	refs.rootEl.classList.toggle('is-remote-host', hostInfo.isRemote);
	refs.rootEl.classList.toggle('is-local-host', !hostInfo.isRemote);
	refs.rootEl.classList.toggle('has-conflict', conflictCount > 0);
	for (const st of ['active', 'blocked', 'waiting-join']) {
		refs.rootEl.classList.toggle(`state-${st}`, nodeState !== 'idle' && stateSlug === st);
	}
	if (refs.lastOsSlug !== osSlug) {
		if (refs.lastOsSlug) {
			refs.rootEl.classList.remove(`os-${refs.lastOsSlug}`);
		}
		refs.rootEl.classList.add(`os-${osSlug}`);
		refs.lastOsSlug = osSlug;
	}

	// Title (preserve active inline rename)
	if (refs.titleEl.firstElementChild?.tagName !== 'INPUT') {
		if (refs.titleEl.textContent !== oNode.label) {
			refs.titleEl.textContent = oNode.label;
		}
		if (refs.titleEl.title !== oNode.label) {
			refs.titleEl.title = oNode.label;
		}
	}

	// State dot
	refs.stateDotEl.hidden = nodeState === 'idle';
	if (nodeState !== 'idle') {
		refs.stateDotEl.title = nodeState;
	}

	// Engine / Model / Host / Permissions
	const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? oNode.engineId ?? fallbackOwnerEngineId;
	const engineName = ctx.hostCatalog.getEngineDisplayName(engineId);
	const engineIcon = ctx.hostCatalog.getEngineIcon(engineId);
	const nodeTelemetry = runtimeState?.nodeTelemetry?.[oNode.id];
	const resolvedModel = linkedAgent?.preferredModel || oNode.model || nodeTelemetry?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineName.toLowerCase();
	const llmProvider = resolveEffectiveAdeLlmProvider(resolvedModel, engineId, ctx.hostCatalog.getModelCategoryOverrides());
	const llmProviderLabel = ADE_LLM_PROVIDER_LABELS[llmProvider];
	const resolvedThinking: AdeThinkingLevel = (linkedAgent?.preferredThinking ?? (oNode.thinking as AdeThinkingLevel | undefined) ?? 'medium');
	const effCanSwitchModel = Boolean(canSwitchModel);
	// Respect snapshot.canSwitchEngine(linkedAgent) once bound; remain unlocked pre-launch when no linkedAgent exists
	const effCanSwitchEngine = linkedAgent ? Boolean(canSwitchEngineFn(linkedAgent)) : Boolean(canSwitchModel);
	refs.engineId = engineId;
	refs.canSwitchModel = effCanSwitchModel;
	refs.canSwitchEngine = effCanSwitchEngine;

	// 1. Header pills & custom color
	const empDisplay = (oNode.employeeName ?? oNode.label).trim();
	const showEmpPill = Boolean(empDisplay) && empDisplay.toLowerCase() !== oNode.label.trim().toLowerCase();
	const clampedTier = Math.max(1, Math.min(4, tierNum));
	const headerSig = JSON.stringify([tierNum, rankDef.name, oNode.department ?? '', oNode.employeeKey ?? '', empDisplay, showEmpPill, oNode.color ?? '', oNode.label]);
	if (refs.lastHeaderSig !== headerSig) {
		refs.lastHeaderSig = headerSig;
		ctx.applyCustomNodeColor(refs.rootEl, oNode.color);
		// Compact `L1..L4` rank tag keeps header airy (full rank name in tooltip)
		refs.rankPillEl.className = `ade-mission-rank-pill tier-${clampedTier}`;
		refs.rankPillEl.textContent = formatTierTag(tierNum);
		refs.rankPillEl.title = `${formatTierTag(tierNum)} ${rankDef.name}`;

		clearNode(refs.topRightEl);
		if (oNode.department) {
			append(refs.topRightEl, $('span.ade-orch-dept-pill', { title: oNode.department }, oNode.department));
		}
		if (showEmpPill) {
			const empColorIdx = getEmployeeColorIndex(oNode.employeeKey ?? oNode.id);
			const empChip = append(refs.topRightEl, $(`span.ade-mission-emp-pill.emp-color-${empColorIdx}`, {
				title: adeBi(localize('adeOrchUniqueEmpTip', "Unique Staff Member: {0}", empDisplay), '唯一在场员工：{0}', empDisplay),
			}));
			append(empChip, $('span.ade-mission-emp-dot', { 'aria-hidden': 'true' }));
			append(empChip, $('span.ade-mission-emp-name', {}, empDisplay));
		}
	}

	// 2. Model / Engine / Host interactive controls
	const modelSig = JSON.stringify([
		engineId,
		engineName,
		resolvedModel,
		llmProvider,
		resolvedThinking,
		effCanSwitchModel,
		effCanSwitchEngine,
		canSwitchHost,
		hostInfo.hostAlias,
		hostInfo.displayHost,
		hostInfo.osKind,
		hostInfo.osLabel,
		hostInfo.isRemote,
		linkedAgent?.id ?? '',
	]);
	if (refs.lastModelSig !== modelSig) {
		refs.lastModelSig = modelSig;
		refs.coreIconTileEl.className = `ade-mission-core-icon-well llm-${sanitizeCssSlug(llmProvider)}${effCanSwitchModel ? ' is-editable' : ''}`;
		refs.coreIconTileEl.setAttribute('data-llm-provider', llmProvider);
		refs.coreIconTileEl.title = effCanSwitchModel
			? adeBi(
				localize('adeMissionLlmIconSwitchTip', "Driving LLM: {0} ({1}) — Click to switch model & thinking", llmProviderLabel, resolvedModel),
				'驱动模型：{0}（{1}）— 点击切换模型与思考等级',
				llmProviderLabel,
				resolvedModel,
			)
			: adeBi(
				localize('adeMissionLlmIconTip', "Driving LLM: {0} ({1})", llmProviderLabel, resolvedModel),
				'驱动模型：{0}（{1}）',
				llmProviderLabel,
				resolvedModel,
			);
		refs.coreIconTileEl.disabled = !effCanSwitchModel;
		clearNode(refs.coreLlmGlyphEl);
		renderAdeLlmIcon(refs.coreLlmGlyphEl, llmProvider, { baseClass: 'ade-mission-llm-icon', prefix: 'ade-llm', tooltip: `${llmProviderLabel} · ${resolvedModel}` });

		refs.modelRowEl.className = `ade-mission-core-model-row${effCanSwitchModel ? ' is-editable' : ''}`;
		refs.modelRowEl.setAttribute('data-node-model', resolvedModel);
		refs.modelRowEl.setAttribute('data-node-thinking', resolvedThinking);
		refs.modelNameEl.textContent = resolvedModel;
		refs.thinkingTagEl.className = `ade-mission-thinking-tag level-${sanitizeCssSlug(resolvedThinking)}`;
		refs.thinkingTagEl.textContent = resolvedThinking;

		const hostDisplayLabel = hostInfo.isRemote ? hostInfo.displayHost : `Local · ${hostInfo.osLabel}`;
		refs.engineBadgeEl.className = `ade-mission-engine-pill${effCanSwitchEngine ? ' is-editable' : ''}`;
		refs.engineBadgeEl.setAttribute('data-node-engine-id', engineId);
		refs.engineBadgeEl.disabled = !effCanSwitchEngine;
		refs.engineBadgeEl.title = effCanSwitchEngine
			? adeBi(localize('adeOrchEngineSwitchTip', "Engine: {0} — Click to switch engine", engineName), '执行引擎：{0} — 点击切换引擎', engineName)
			: adeBi(localize('adeOrchEngineTip', "Engine: {0}", engineName), '执行引擎：{0}', engineName);
		clearNode(refs.engineIconEl);
		applyMissionEngineIcon(refs.engineIconEl, engineIcon);
		refs.engineNameEl.textContent = engineName;

		refs.hostPillEl.className = `ade-mission-host-pill os-${osSlug}${hostInfo.isRemote ? ' is-remote' : ' is-local'}${canSwitchHost ? ' is-editable' : ''}`;
		refs.hostPillEl.setAttribute('data-node-host', hostInfo.hostAlias);
		refs.hostPillEl.setAttribute('data-node-os', hostInfo.osKind);
		refs.hostPillEl.disabled = !canSwitchHost;
		refs.hostPillEl.title = canSwitchHost
			? adeBi(localize('adeOrchHostSwitchTip', "Host: {0} ({1}) — Click to switch host", hostDisplayLabel, hostInfo.osLabel), '运行主机：{0}（{1}）— 点击切换主机', hostDisplayLabel, hostInfo.osLabel)
			: adeBi(localize('adeOrchHostTip', "Host: {0} ({1})", hostDisplayLabel, hostInfo.osLabel), '运行主机：{0}（{1}）', hostDisplayLabel, hostInfo.osLabel);
		clearNode(refs.hostOsIconEl);
		renderAdeOsIcon(refs.hostOsIconEl, hostInfo.osKind, { baseClass: 'ade-mission-os-icon', prefix: 'ade-os' });
		refs.hostNameEl.textContent = hostDisplayLabel;
	}

	// 3. Context Window Bar + FinOps Cache Hit & Cost
	const modelContextFallback = inferModelContextWindowTokens(resolvedModel, { engineId });
	const ctxBreakdown = computeMissionNodeContextBreakdown(nodeTelemetry, modelContextFallback);
	refs.ctxRowEl.className = `ade-mission-ctx-row severity-${ctxBreakdown.severity}`;
	refs.ctxRowEl.setAttribute('data-node-context-pct', String(ctxBreakdown.usedPct));
	refs.ctxRowEl.setAttribute('data-node-context-used', String(ctxBreakdown.usedTokens));
	refs.ctxRowEl.setAttribute('data-node-context-max', String(ctxBreakdown.maxTokens));
	refs.ctxSegInitEl.style.width = `${ctxBreakdown.initPct.toFixed(1)}%`;
	refs.ctxSegTierEl.style.width = `${ctxBreakdown.tierPct.toFixed(1)}%`;
	refs.ctxSegSourceEl.style.width = `${ctxBreakdown.sourcePct.toFixed(1)}%`;
	refs.ctxSegNoiseEl.style.width = `${ctxBreakdown.noisePct.toFixed(1)}%`;
	refs.ctxTokensEl.textContent = `${formatCompactTokenCount(ctxBreakdown.usedTokens)}/${formatCompactTokenCount(ctxBreakdown.maxTokens)}`;

	const cacheRead = nodeTelemetry?.cacheReadTokens ?? 0;
	const cacheDenom = (nodeTelemetry?.inputTokens ?? 0) + cacheRead;
	const cacheHitPct = cacheDenom > 0 && cacheRead > 0 ? Math.round((cacheRead / cacheDenom) * 100) : undefined;
	if (cacheHitPct !== undefined && cacheHitPct > 0) {
		refs.ctxCacheEl.hidden = false;
		refs.ctxCacheEl.textContent = `⚡${cacheHitPct}%`;
		refs.ctxCacheEl.title = adeBi(
			localize('adeOrchCacheHitTip', "Prompt cache hit rate: {0}%", cacheHitPct),
			'提示词缓存命中率：{0}%',
			cacheHitPct,
		);
	} else {
		refs.ctxCacheEl.hidden = true;
	}

	const staffCostUsd = nodeTelemetry?.costUsd ?? 0;
	const staffCostEstimated = Boolean(nodeTelemetry?.costEstimated);
	const staffCostLocalFree = Boolean(nodeTelemetry?.costLocalFree && staffCostUsd === 0 && ((nodeTelemetry?.totalTokens ?? 0) > 0 || (nodeTelemetry?.turns ?? 0) > 0));
	const staffCostLabel = staffCostUsd > 0
		? formatFinOpsUsd(staffCostUsd, { estimated: staffCostEstimated, compact: true })
		: (staffCostLocalFree ? 'Local $0' : '');
	if (staffCostLabel) {
		refs.ctxCostEl.hidden = false;
		refs.ctxCostEl.textContent = staffCostLabel;
	} else {
		refs.ctxCostEl.hidden = true;
	}
	refs.ctxPctEl.textContent = `${ctxBreakdown.usedPct}%`;

	// 4. Runtime Summary, Meta Strip, Directive Strip & Baton Token Puck
	const boundTaskIds = derived.boundTaskIdsByStaff.get(oNode.id) ?? [];
	const scopePaths = (primaryOrchTok?.scopePaths && primaryOrchTok.scopePaths.length > 0)
		? primaryOrchTok.scopePaths
		: (oNode.allowedPaths ?? []);
	const barrier = primaryOrchTok?.status === 'waiting_join' && primaryOrchTok.joinBarrierId
		? orchRuntime?.joinBarriers?.[primaryOrchTok.joinBarrierId]
		: derived.activeBarrierByOwner.get(oNode.id);
	const barrierSettled = barrier ? Object.keys(barrier.settledChildren).length : 0;
	const barrierTotal = barrier ? barrier.childTokenIds.length : 0;
	const barrierConflicts = barrier?.fileConflicts?.length ?? 0;
	const safeSummary = resolveSafeOrchTokenSummary(primaryOrchTok);
	const ptrCount = computeTokenPointerCount(primaryOrchTok);

	const runtimeSig = JSON.stringify([
		primaryOrchTok?.id ?? '',
		primaryOrchTok?.status ?? '',
		primaryOrchTok?.waveId ?? '',
		primaryOrchTok?.fromNodeId ?? '',
		primaryOrchTok?.dispatchKind ?? '',
		safeSummary,
		ptrCount,
		primaryOrchTok?.nudgeCount ?? 0,
		primaryOrchTok?.attemptNumber ?? 1,
		primaryOrchTok?.reworkCategory ?? '',
		primaryOrchTok?.reworkHistory?.length ?? 0,
		primaryOrchTok?.blocked?.expiresAt ?? 0,
		primaryOrchTok?.blocked?.watchPid ?? 0,
		primaryOrchTok?.blocked?.watchFile ?? '',
		primaryOrchTok?.blocked?.reason ?? '',
		primaryOrchTok?.rejectionReason ?? '',
		primaryOrchTok?.failureReason ?? '',
		liveTokens.length,
		boundTaskIds,
		scopePaths,
		conflictCount,
		conflictPaths.join(','),
		barrier?.id ?? '',
		barrier?.mode ?? '',
		barrier?.quorumCount ?? 0,
		barrier?.failFast ?? false,
		barrier?.deadlineAt ?? 0,
		barrier?.timedOut ?? false,
		barrierSettled,
		barrierTotal,
		barrierConflicts,
		modelSig,
		oNode.color ?? '',
		oNode.label,
	]);

	if (refs.lastRuntimeSig === runtimeSig) {
		return;
	}
	refs.lastRuntimeSig = runtimeSig;

	// Re-bind all dynamic listeners cleanly in one DisposableStore!
	refs.dynamicDisposables.clear();
	clearNode(refs.colorTriggerWrapEl);
	ctx.mountNodeColorTrigger(refs.colorTriggerWrapEl, oNode.id, oNode.label, oNode.color, refs.dynamicDisposables);

	if (effCanSwitchModel) {
		refs.dynamicDisposables.add(addDisposableListener(refs.coreIconTileEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenModelPopover(oNode.id, linkedAgent, engineId, refs.coreIconTileEl, {
				currentModel: resolvedModel,
				currentThinking: resolvedThinking,
				hostAlias: hostInfo.hostAlias,
			});
		}));
		refs.dynamicDisposables.add(addDisposableListener(refs.modelRowEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenModelPopover(oNode.id, linkedAgent, engineId, refs.modelRowEl, {
				currentModel: resolvedModel,
				currentThinking: resolvedThinking,
				hostAlias: hostInfo.hostAlias,
			});
		}));
	}
	if (effCanSwitchEngine) {
		refs.dynamicDisposables.add(addDisposableListener(refs.engineBadgeEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenEnginePopover(oNode.id, linkedAgent, engineId, refs.engineBadgeEl, {
				staffLabel: oNode.label,
				hostAlias: hostInfo.hostAlias,
			});
		}));
	}
	if (canSwitchHost) {
		refs.dynamicDisposables.add(addDisposableListener(refs.hostPillEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenHostPopover(compatDagNode, hostInfo.hostAlias, refs.hostPillEl);
		}));
	}

	// Clean summary line (NEVER literal "undefined"!)
	const standbyText = adeBi(localize('adeOrchStaffStandby', "Context prewarmed · Awaiting baton"), '上下文已预热 · 待接力唤醒');
	const displaySummary = primaryOrchTok
		? (safeSummary || adeBi(
			localize('adeOrchBatonActiveFallback', "Executing baton {0}", primaryOrchTok.id),
			'正在执行令牌 {0}',
			primaryOrchTok.id,
		))
		: standbyText;
	refs.contextSummaryEl.textContent = displaySummary;
	refs.contextSummaryEl.title = displaySummary;

	// Round-2 Governance & Cross-View Meta Strip (bound Task jump, Scope/Conflict, Rework)
	clearNode(refs.metaStripEl);
	let metaChipsAdded = 0;

	if (boundTaskIds.length > 0) {
		const primaryTaskId = boundTaskIds[0];
		const taskLabel = boundTaskIds.length > 1 ? `↗ ${primaryTaskId} +${boundTaskIds.length - 1}` : `↗ ${primaryTaskId}`;
		const taskBtn = append(refs.metaStripEl, $('button.ade-orch-meta-chip.is-task-jump', {
			type: 'button',
			'data-ade-jump-task': primaryTaskId,
			title: adeBi(
				localize('adeOrchJumpTaskTip', "Jump to bound task {0} in Mission DAG", boundTaskIds.join(', ')),
				'跳转到任务 DAG 中的绑定任务：{0}',
				boundTaskIds.join(', '),
			),
		}, taskLabel)) as HTMLButtonElement;
		refs.dynamicDisposables.add(addDisposableListener(taskBtn, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onJumpToMissionTask?.(primaryTaskId);
		}));
		metaChipsAdded++;
	}

	if (conflictCount > 0 || scopePaths.length > 0) {
		const isConflict = conflictCount > 0;
		const scopeLabel = isConflict
			? adeBi(localize('adeOrchConflictChip', "⚠ {0} conflict", conflictCount), '⚠ {0} 冲突', conflictCount)
			: scopePaths.length === 1
				? `◫ ${scopePaths[0].length > 22 ? `${scopePaths[0].slice(0, 20)}…` : scopePaths[0]}`
				: adeBi(localize('adeOrchScopeCountChip', "◫ {0} scopes", scopePaths.length), '◫ {0} 目录锁', scopePaths.length);
		const scopeTip = isConflict
			? adeBi(
				localize('adeOrchConflictChipTip', "File merge conflicts:\n{0}", conflictPaths.join('\n')),
				'并行文件冲突：\n{0}',
				conflictPaths.join('\n'),
			)
			: adeBi(
				localize('adeOrchScopeChipTip', "Write scope paths:\n{0}", scopePaths.join('\n')),
				'写权限目录范围：\n{0}',
				scopePaths.join('\n'),
			);
		const scopeEl = primaryOrchTok
			? append(refs.metaStripEl, $(`button.ade-orch-meta-chip.is-scope${isConflict ? '.is-conflict' : ''}`, {
				type: 'button',
				'data-ade-staff-scope': oNode.id,
				title: scopeTip,
			}, scopeLabel))
			: append(refs.metaStripEl, $(`span.ade-orch-meta-chip.is-scope${isConflict ? '.is-conflict' : ''}`, {
				'data-ade-staff-scope': oNode.id,
				title: scopeTip,
			}, scopeLabel));
		if (primaryOrchTok) {
			refs.dynamicDisposables.add(addDisposableListener(scopeEl, EventType.CLICK, e => {
				e.stopPropagation();
				ctx.onOpenOrchestrationTokenPopover?.(oNode.label, primaryOrchTok, scopeEl, {
					focusSection: 'scope',
					staffNodeId: oNode.id,
				});
			}));
		}
		metaChipsAdded++;
	}

	const attemptNum = primaryOrchTok?.attemptNumber ?? 1;
	const reworkCat = primaryOrchTok?.reworkCategory;
	const hasRework = Boolean(primaryOrchTok && (attemptNum > 1 || reworkCat || (primaryOrchTok.reworkHistory?.length ?? 0) > 0));
	if (hasRework && primaryOrchTok) {
		const rwLabel = reworkCat ? `↻ #${attemptNum} · ${reworkCat}` : `↻ #${attemptNum}`;
		const rwBtn = append(refs.metaStripEl, $('button.ade-orch-rework-pill', {
			type: 'button',
			'data-ade-staff-rework': oNode.id,
			title: primaryOrchTok.rejectionReason || primaryOrchTok.failureReason || adeBi(
				localize('adeOrchReworkChipTip', "Attempt #{0} — click to inspect rework history", attemptNum),
				'第 {0} 次返工 — 点击查看返工记忆',
				attemptNum,
			),
		}, rwLabel)) as HTMLButtonElement;
		refs.dynamicDisposables.add(addDisposableListener(rwBtn, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenOrchestrationTokenPopover?.(oNode.label, primaryOrchTok, rwBtn, {
				focusSection: 'rework',
				staffNodeId: oNode.id,
			});
		}));
		metaChipsAdded++;
	}
	refs.metaStripEl.hidden = metaChipsAdded === 0;

	// De-duplicated Recessed Baton / Directive Strip (NO duplicate lastSummary!)
	const now = Date.now();
	refs.countdownEl = undefined;
	refs.countdownTargetAt = undefined;
	refs.countdownMode = undefined;

	const hasLiveBaton = Boolean(primaryOrchTok);
	refs.directiveBarEl.className = `ade-mission-node-prompt-bar${hasLiveBaton ? ' has-prompt' : ''}${primaryOrchTok?.status === 'blocked' ? ' is-blocked' : ''}${primaryOrchTok?.status === 'waiting_join' ? ' is-waiting-join' : ''}`;
	refs.directiveBarEl.disabled = !hasLiveBaton;

	if (primaryOrchTok) {
		const isBlocked = primaryOrchTok.status === 'blocked';
		const isWaitingJoin = primaryOrchTok.status === 'waiting_join';
		const dirIco = isBlocked
			? 'codicon-watch'
			: isWaitingJoin
				? 'codicon-git-merge'
				: primaryOrchTok.dispatchKind === 'reject'
					? 'codicon-debug-restart'
					: 'codicon-pass-filled';
		refs.directiveIcoEl.className = `codicon ${dirIco} ade-mission-node-prompt-ico`;

		let stripText: string;
		if (isBlocked && primaryOrchTok.blocked) {
			const watchTag = primaryOrchTok.blocked.watchPid
				? `PID ${primaryOrchTok.blocked.watchPid}`
				: primaryOrchTok.blocked.watchFile
					? primaryOrchTok.blocked.watchFile
					: (primaryOrchTok.blocked.reason || '');
			stripText = watchTag
				? adeBi(localize('adeOrchBlockedWatchLine', "Waiting · {0}", watchTag), '等待中 · {0}', watchTag)
				: adeBi(localize('adeOrchBlockedGenericLine', "Blocked · awaiting trigger"), '阻塞中 · 等待唤醒');
		} else if (isWaitingJoin && barrier) {
			const modeText = barrier.mode === 'quorum'
				? `Quorum ${barrierSettled}/${barrier.quorumCount ?? barrierTotal}`
				: barrier.mode === 'any'
					? `Any ${barrierSettled}/${barrierTotal}`
					: `Join ${barrierSettled}/${barrierTotal}`;
			stripText = barrier.timedOut
				? `${modeText} · SLA`
				: barrier.failFast
					? `${modeText} · ⚡FF`
					: modeText;
		} else if (primaryOrchTok.fromNodeId && primaryOrchTok.fromNodeId !== oNode.id) {
			const fromLabel = resolveNodeLabel(primaryOrchTok.fromNodeId);
			stripText = primaryOrchTok.dispatchKind === 'reject'
				? adeBi(localize('adeOrchFromReject', "Rework ← {0}", fromLabel), '退回返工 ← {0}', fromLabel)
				: adeBi(localize('adeOrchFromHandoff', "From {0}", fromLabel), '接力自 {0}', fromLabel);
		} else {
			stripText = adeBi(
				localize('adeOrchActiveBatonLine', "Wave {0} · active baton", formatMissionWaveTag(primaryOrchTok.waveId)),
				'波次 {0} · 执行中',
				formatMissionWaveTag(primaryOrchTok.waveId),
			);
		}
		refs.directivePreviewEl.textContent = stripText;
		refs.directiveTagEl.textContent = ptrCount > 0 ? `${primaryOrchTok.id} · ${ptrCount} ptr` : primaryOrchTok.id;

		refs.dynamicDisposables.add(addDisposableListener(refs.directiveBarEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenOrchestrationTokenPopover?.(oNode.label, primaryOrchTok, refs.directiveBarEl, {
				focusSection: isWaitingJoin ? 'barrier' : undefined,
				staffNodeId: oNode.id,
			});
		}));
	} else {
		refs.directiveIcoEl.className = 'codicon codicon-note ade-mission-node-prompt-ico';
		refs.directivePreviewEl.textContent = adeBi(localize('adeOrchStandbyHint', "Persistent staff · re-wakes on baton arrival"), '持久在场员工 · 收到令牌即唤醒');
		refs.directiveTagEl.textContent = adeBi(localize('adeOrchIdleTag', "Standby"), '待命');
	}

	// 5. Floating Baton Token Puck (mode-aware Join / Quorum / Any + failFast + live SLA/blocked countdown + conflict badge!)
	clearNode(refs.tokenPuckEl);
	if (primaryOrchTok) {
		refs.tokenPuckEl.hidden = false;
		const puckStatusCls = sanitizeCssSlug(primaryOrchTok.status.replace(/_/g, '-'));
		const waveIdx = getMissionWaveColorIndex(primaryOrchTok.waveId);
		refs.tokenPuckEl.className = `ade-mission-token-puck status-${puckStatusCls} wave-color-${waveIdx}`;
		refs.tokenPuckEl.setAttribute('data-token-id', primaryOrchTok.id);
		refs.tokenPuckEl.setAttribute('data-token-status', primaryOrchTok.status);

		const iconCls = primaryOrchTok.status === 'blocked'
			? 'codicon-watch'
			: primaryOrchTok.status === 'waiting_join'
				? 'codicon-git-merge'
				: 'codicon-pass-filled';
		append(refs.tokenPuckEl, $(`span.codicon.${iconCls}.ade-orch-puck-ico`, { 'aria-hidden': 'true' }));

		const waveTag = formatMissionWaveTag(primaryOrchTok.waveId);
		let puckMainLabel = waveTag;
		if (primaryOrchTok.status === 'waiting_join' && barrier) {
			const modeTag = barrier.mode === 'quorum'
				? `Quorum ${barrierSettled}/${barrier.quorumCount ?? barrierTotal}`
				: barrier.mode === 'any'
					? `Any ${barrierSettled}/${barrierTotal}`
					: `Join ${barrierSettled}/${barrierTotal}`;
			puckMainLabel = `${waveTag} · ${modeTag}${barrier.failFast ? ' ⚡FF' : ''}`;
		}
		const labelSpan = append(refs.tokenPuckEl, $('span.ade-mission-token-puck-label', {}, puckMainLabel));

		// Live 1Hz countdown chip for `blocked` or `waiting_join` `deadlineAt` SLA!
		if (primaryOrchTok.status === 'blocked' && primaryOrchTok.blocked?.expiresAt) {
			const rem = formatMissionBlockedRemaining(primaryOrchTok.blocked.expiresAt, now);
			const cdChip = append(refs.tokenPuckEl, $(`span.ade-orch-barrier-chip.is-blocked-timer${rem.isOverdue ? '.is-overdue' : ''}`, {}, `⏳ ${rem.text}`));
			refs.countdownEl = cdChip;
			refs.countdownTargetAt = primaryOrchTok.blocked.expiresAt;
			refs.countdownMode = 'blocked';
		} else if (primaryOrchTok.status === 'waiting_join' && barrier?.deadlineAt) {
			const rem = formatMissionBlockedRemaining(barrier.deadlineAt, now);
			const isUrgent = barrier.timedOut || rem.isOverdue || (barrier.deadlineAt - now) < 120_000;
			const slaText = (barrier.timedOut || rem.isOverdue) ? '⏱ SLA' : `⏱ ${rem.text}`;
			const slaChip = append(refs.tokenPuckEl, $(`span.ade-orch-barrier-chip.is-sla${isUrgent ? '.is-urgent' : ''}${barrier.timedOut || rem.isOverdue ? '.is-overdue' : ''}`, {}, slaText));
			refs.countdownEl = slaChip;
			refs.countdownTargetAt = barrier.deadlineAt;
			refs.countdownMode = 'barrier';
		}
		void labelSpan;

		if (barrierConflicts > 0) {
			append(refs.tokenPuckEl, $('span.ade-orch-barrier-chip.is-conflict', {
				title: adeBi(localize('adeOrchBarrierConflictPuckTip', "{0} file conflicts in join barrier", barrierConflicts), '汇聚屏障存在 {0} 处文件冲突', barrierConflicts),
			}, `⚠ ${barrierConflicts}`));
		}
		if (primaryOrchTok.nudgeCount > 0) {
			const nudgeChip = append(refs.tokenPuckEl, $('span.ade-orch-puck-chip.is-nudge'));
			append(nudgeChip, $('span.codicon.codicon-bell', { 'aria-hidden': 'true' }));
			append(nudgeChip, $('span', {}, String(primaryOrchTok.nudgeCount)));
		}
		if (ptrCount > 0) {
			const ptrChip = append(refs.tokenPuckEl, $('span.ade-orch-puck-chip.is-ptr'));
			append(ptrChip, $('span.codicon.codicon-link', { 'aria-hidden': 'true' }));
			append(ptrChip, $('span', {}, String(ptrCount)));
		}
		if (liveTokens.length > 1) {
			append(refs.tokenPuckEl, $('span.ade-mission-token-puck-extra', {}, `+${liveTokens.length - 1}`));
		}

		refs.dynamicDisposables.add(addDisposableListener(refs.tokenPuckEl, EventType.CLICK, e => {
			e.stopPropagation();
			ctx.onOpenOrchestrationTokenPopover?.(oNode.label, primaryOrchTok, refs.tokenPuckEl, {
				focusSection: primaryOrchTok.status === 'waiting_join' ? 'barrier' : undefined,
				staffNodeId: oNode.id,
			});
		}));
	} else {
		refs.tokenPuckEl.hidden = true;
		refs.tokenPuckEl.removeAttribute('data-token-id');
		refs.tokenPuckEl.removeAttribute('data-token-status');
	}
}
