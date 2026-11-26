/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	canonicalEdgePairKey,
	IAdeTicketTransferAnimationEvent,
	IAdeTicketTransferHop,
} from '../../../../platform/ade/common/adeModels.js';
import { normalizeAdeNodeColor, resolveAdeNodeColorHex } from '../../../../platform/ade/common/adeNodeColors.js';
import {
	computeOrchestrationMultiAnchorRoutes,
	detourPolylineAroundPillBoxes,
	getOrchestrationNodeSize,
	IMissionEdgeObstacle,
	IMissionNodePosition,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	IOrchestrationRoutedEdge,
	ORCH_CORNER_RADIUS,
	ORCH_RIGID_STUB_LENGTH,
	OrchestrationDirection,
	OrchestrationLayoutMode,
	reanchorOrchestrationRoute,
} from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { adeBi } from '../common/adeLocalization.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Strict 3000ms Ticket transfer animation invariant (`plan.md` §0.1.4 & §8.3). */
export const ADE_TICKET_FLOW_DURATION_MS = 3_000;

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			el.setAttribute(k, v);
		}
	}
	return el;
}

export function boxesOverlap(a: IMissionEdgeObstacle, b: IMissionEdgeObstacle): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function computeRouteBbox(points: readonly { readonly x: number; readonly y: number }[], pad = 20): IMissionEdgeObstacle {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const pt of points) {
		if (pt.x < minX) { minX = pt.x; }
		if (pt.x > maxX) { maxX = pt.x; }
		if (pt.y < minY) { minY = pt.y; }
		if (pt.y > maxY) { maxY = pt.y; }
	}
	if (!Number.isFinite(minX)) {
		return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	}
	return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

export function computePolylineLength(points: readonly { readonly x: number; readonly y: number }[]): number {
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) {
		total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
	}
	return total;
}

export function samplePolylineAtArcLength(
	points: readonly { readonly x: number; readonly y: number }[],
	arcLen: number,
): { readonly x: number; readonly y: number } {
	if (points.length === 0) {
		return { x: 0, y: 0 };
	}
	if (points.length === 1) {
		return points[0];
	}
	let rem = Math.max(0, arcLen);
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const seg = Math.hypot(b.x - a.x, b.y - a.y);
		if (rem <= seg || i === points.length - 2) {
			const t = seg > 0.001 ? Math.max(0, Math.min(1, rem / seg)) : 0;
			return {
				x: a.x + (b.x - a.x) * t,
				y: a.y + (b.y - a.y) * t,
			};
		}
		rem -= seg;
	}
	return points[points.length - 1];
}

export function measureSvgPillWidth(text: string, padPx: number, minW: number, maxW: number): number {
	let px = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		px += code > 0x2e7f ? 13 : 7.2;
	}
	return Math.round(Math.max(minW, Math.min(maxW, px + padPx)));
}

export function resolveArrowMarkerUrlForColor(rawColor: string | undefined, fallbackId: string): string {
	const norm = normalizeAdeNodeColor(rawColor);
	if (norm && !norm.startsWith('#')) {
		return `url(#ade-mission-arrow-preset-${norm})`;
	}
	return `url(#${fallbackId})`;
}

// ============================================================================
// Strict 3000ms Arc-Length Proportional Multi-Hop Ticket Flow Particle Pool
// ============================================================================

export interface IAdeTicketFlowClock {
	now(): number;
	requestFrame(callback: (frameTime: number) => void): number;
	cancelFrame(handle: number): void;
}

export function createDefaultTicketFlowClock(): IAdeTicketFlowClock {
	return {
		now: () => Date.now(),
		requestFrame: cb => mainWindow.requestAnimationFrame(cb),
		cancelFrame: handle => mainWindow.cancelAnimationFrame(handle),
	};
}

/**
 * Splits total `3000ms` across tree-path segments $e_1, \dots, e_k$ strictly proportional to
 * each SVG `<path>`'s real geometric arc length $L_i$, satisfying $\sum_{i=1}^k \Delta t_i \equiv 3000\text{ ms}$.
 */
export function computeRelaySegmentDurations(
	segmentLengths: readonly number[],
	totalDurationMs = ADE_TICKET_FLOW_DURATION_MS,
): readonly number[] {
	if (segmentLengths.length === 0) {
		return [];
	}
	if (segmentLengths.length === 1) {
		return [totalDurationMs];
	}
	const safeLens = segmentLengths.map(l => (Number.isFinite(l) && l > 0 ? l : 1));
	const totalLen = safeLens.reduce((acc, v) => acc + v, 0);
	if (totalLen <= 0) {
		const eq = totalDurationMs / safeLens.length;
		const out = safeLens.map(() => eq);
		const prefixSum = out.slice(0, -1).reduce((a, b) => a + b, 0);
		out[out.length - 1] = totalDurationMs - prefixSum;
		return out;
	}
	const durations: number[] = [];
	let runningSum = 0;
	for (let i = 0; i < safeLens.length - 1; i++) {
		const dt = totalDurationMs * (safeLens[i] / totalLen);
		durations.push(dt);
		runningSum += dt;
	}
	durations.push(Math.max(0, totalDurationMs - runningSum));
	return durations;
}

export interface IRenderedEdgeHandle {
	readonly group: SVGGElement;
	readonly path: SVGPathElement;
	readonly hoverStreamPath: SVGPathElement;
	readonly hitPath: SVGPathElement;
	readonly haloPath: SVGPathElement;
	readonly edgeId: string;
	readonly edgePairKey: string;
	readonly fromId: string;
	readonly toId: string;
	readonly isWhiteboardLink: boolean;
	readonly isBidirectional: boolean;
	baseMarkerStart?: string;
	baseMarkerEnd?: string;
	staticAccentHex: string;
	route: IOrchestrationRoutedEdge;
	bbox: IMissionEdgeObstacle;
	cachedTotalLength?: number;
}

export interface IAdeActiveTicketTransferSnapshot {
	readonly transferId: string;
	readonly ticketId: string;
	readonly taskId: string;
	readonly transferredAt: number;
	readonly currentHopIndex: number;
	readonly currentEdgePairKey: string;
	readonly currentDirection: 'forward' | 'reverse';
	readonly progress: number;
	readonly x: number;
	readonly y: number;
	readonly segmentLengths: readonly number[];
	readonly segmentDurationsMs: readonly number[];
}

interface IActiveFlowParticleItem {
	readonly transferId: string;
	readonly event: IAdeTicketTransferAnimationEvent;
	readonly orderedHops: readonly IAdeTicketTransferHop[];
	readonly rootEl: SVGGElement;
	readonly trail2El: SVGCircleElement;
	readonly trail1El: SVGCircleElement;
	readonly bodyEl: SVGGElement;
	currentHopIndex: number;
	currentEdgePairKey: string;
	currentDirection: 'forward' | 'reverse';
	progress: number;
	x: number;
	y: number;
	segmentLengths: readonly number[];
	segmentDurationsMs: readonly number[];
}

function measureSvgPathLength(pathEl: SVGPathElement, fallbackPoints: readonly { readonly x: number; readonly y: number }[]): number {
	try {
		if (typeof pathEl.getTotalLength === 'function') {
			const len = pathEl.getTotalLength();
			if (Number.isFinite(len) && len > 0.05) {
				return len;
			}
		}
	} catch {
		// Fall back to exact polyline length if browser/DOM environment hasn't laid out SVG geometry
	}
	return Math.max(1, computePolylineLength(fallbackPoints));
}

export function getOrMeasureEdgeTotalLength(handle: IRenderedEdgeHandle): number {
	if (typeof handle.cachedTotalLength === 'number' && Number.isFinite(handle.cachedTotalLength) && handle.cachedTotalLength > 0.05) {
		return handle.cachedTotalLength;
	}
	const measured = measureSvgPathLength(handle.path, handle.route.points);
	handle.cachedTotalLength = measured;
	return measured;
}

function sampleSvgPathAtLength(
	pathEl: SVGPathElement,
	arcLen: number,
	totalLen: number,
	fallbackPoints: readonly { readonly x: number; readonly y: number }[],
): { readonly x: number; readonly y: number } {
	const safeTotal = Number.isFinite(totalLen) && totalLen > 0 ? totalLen : 0;
	const clamped = Math.max(0, Math.min(safeTotal, arcLen));
	try {
		if (safeTotal > 0.05 && typeof pathEl.getPointAtLength === 'function') {
			const pt = pathEl.getPointAtLength(clamped);
			if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
				return { x: pt.x, y: pt.y };
			}
		}
	} catch {
		// Fallback below
	}
	return samplePolylineAtArcLength(fallbackPoints, clamped);
}

/**
 * Shared single-`requestAnimationFrame` SVG world-coordinate Ticket flow particle pool:
 * - Renders `<g class="ade-ticket-flow-layer">` on `edgesSvgEl` top layer.
 * - Strictly enforces $\sum_{i=1}^k \Delta t_i \equiv 3000\text{ ms}$ along single-hop or multi-hop reporting tree paths.
 * - Supports concurrent multi-particle forward (`parent -> child`) and reverse (`child -> parent`) flows on the same edge.
 * - Dynamically tracks dragged card polylines on the next frame and reconciles wall-clock elapsed time on tab visibility recovery.
 * - Recycles expired DOM at `elapsed >= 3000` and cancels `rAF` immediately when pool is empty (`zero idle CPU`).
 */
export class AdeTicketFlowController extends Disposable {
	readonly layerEl: SVGGElement;
	private readonly activeTransfers = new Map<string, IActiveFlowParticleItem>();
	private readonly highlightedEdgePairKeys = new Set<string>();
	private rafHandle: number | undefined;
	private seqCounter = 0;
	private clock: IAdeTicketFlowClock;

	constructor(
		edgesSvgEl: SVGSVGElement,
		private readonly resolveEdgeByPairKey: (edgePairKey: string) => IRenderedEdgeHandle | undefined,
		_getAllEdgeHandles?: () => Iterable<IRenderedEdgeHandle>,
		clock?: IAdeTicketFlowClock,
	) {
		super();
		this.clock = clock ?? createDefaultTicketFlowClock();
		this.layerEl = svgEl('g', {
			class: 'ade-ticket-flow-layer',
			'data-ade-ticket-flow-layer': 'true',
		});
		edgesSvgEl.appendChild(this.layerEl);

		const doc = edgesSvgEl.ownerDocument ?? mainWindow.document;
		this._register(addDisposableListener(doc, 'visibilitychange', () => {
			if (doc.hidden) {
				this.stopFrameLoop();
			} else {
				this.reconcileNow();
			}
		}));
	}

	setClock(clock: IAdeTicketFlowClock): void {
		this.stopFrameLoop();
		this.clock = clock;
		if (this.activeTransfers.size > 0) {
			this.ensureFrameLoop();
		}
	}

	isFrameLoopRunning(): boolean {
		return this.rafHandle !== undefined;
	}

	getActiveCount(): number {
		return this.activeTransfers.size;
	}

	getActiveSnapshots(): readonly IAdeActiveTicketTransferSnapshot[] {
		const out: IAdeActiveTicketTransferSnapshot[] = [];
		for (const item of this.activeTransfers.values()) {
			out.push({
				transferId: item.transferId,
				ticketId: item.event.ticket_id,
				taskId: item.event.task_id,
				transferredAt: item.event.transferred_at,
				currentHopIndex: item.currentHopIndex,
				currentEdgePairKey: item.currentEdgePairKey,
				currentDirection: item.currentDirection,
				progress: item.progress,
				x: item.x,
				y: item.y,
				segmentLengths: item.segmentLengths,
				segmentDurationsMs: item.segmentDurationsMs,
			});
		}
		return out;
	}

	triggerTransfer(event: IAdeTicketTransferAnimationEvent): boolean {
		if (!event.hops || event.hops.length === 0) {
			return false;
		}
		const now = this.clock.now();
		const elapsed = now - event.transferred_at;
		if (elapsed >= ADE_TICKET_FLOW_DURATION_MS) {
			return false;
		}

		const orderedHops = [...event.hops].sort((a, b) => a.hop_seq - b.hop_seq);
		// Verify at least one hop exists on the current canvas
		const hasAnyRenderedEdge = orderedHops.some(h => Boolean(this.resolveEdgeByPairKey(h.edge_pair_key)));
		if (!hasAnyRenderedEdge) {
			return false;
		}

		const baseId = event.transfer_group_id?.trim() || `${event.ticket_id}:${event.task_id}:${event.transferred_at}`;
		const transferId = this.activeTransfers.has(baseId)
			? `${baseId}#${++this.seqCounter}`
			: baseId;

		// Determine visual color: downward (`parent -> child`) = sky cyan, upward (`child -> parent`) = emerald
		const firstHop = orderedHops[0];
		const firstEdge = this.resolveEdgeByPairKey(firstHop.edge_pair_key);
		const isReverseInitial = Boolean(firstEdge && firstHop.hop_from_id === firstEdge.toId);

		const rootEl = svgEl('g', {
			class: `ade-ticket-flow-particle${isReverseInitial ? ' is-return is-reverse' : ' is-dispatch'}`,
			'data-transfer-id': transferId,
			'data-ticket-id': event.ticket_id,
			'data-task-id': event.task_id,
			'data-transit-duration-ms': String(ADE_TICKET_FLOW_DURATION_MS),
		});
		this.syncParticleDirectionStyle(rootEl, isReverseInitial);

		const trail2El = svgEl('circle', {
			class: 'ade-ticket-flow-trail is-outer',
			r: '3.2',
			cx: '0',
			cy: '0',
		});
		const trail1El = svgEl('circle', {
			class: 'ade-ticket-flow-trail is-inner',
			r: '4.6',
			cx: '0',
			cy: '0',
		});
		const bodyEl = svgEl('g', { class: 'ade-ticket-flow-head' });
		const bloomEl = svgEl('circle', {
			class: 'ade-ticket-flow-bloom',
			r: '9.5',
			cx: '0',
			cy: '0',
		});
		const coreRingEl = svgEl('circle', {
			class: 'ade-ticket-flow-core-ring',
			r: '5.5',
			cx: '0',
			cy: '0',
		});
		const coreDotEl = svgEl('circle', {
			class: 'ade-ticket-flow-core',
			r: '2.8',
			cx: '0',
			cy: '0',
		});
		bodyEl.appendChild(bloomEl);
		bodyEl.appendChild(coreRingEl);
		bodyEl.appendChild(coreDotEl);

		rootEl.appendChild(trail2El);
		rootEl.appendChild(trail1El);
		rootEl.appendChild(bodyEl);
		this.layerEl.appendChild(rootEl);

		const item: IActiveFlowParticleItem = {
			transferId,
			event,
			orderedHops,
			rootEl,
			trail2El,
			trail1El,
			bodyEl,
			currentHopIndex: 0,
			currentEdgePairKey: firstHop.edge_pair_key,
			currentDirection: isReverseInitial ? 'reverse' : 'forward',
			progress: 0,
			x: 0,
			y: 0,
			segmentLengths: [],
			segmentDurationsMs: [],
		};
		this.activeTransfers.set(transferId, item);
		this.stepAllParticles(now);
		if (this.activeTransfers.size > 0) {
			this.ensureFrameLoop();
		}
		return true;
	}

	/**
	 * Immediately reconciles all active particles against `clock.now()` (used after tab visibility
	 * restore, card drag route updates, or topology refreshes).
	 */
	reconcileNow(): void {
		const now = this.clock.now();
		this.stepAllParticles(now);
		if (this.activeTransfers.size === 0) {
			this.stopFrameLoop();
		} else {
			this.ensureFrameLoop();
		}
	}

	invalidateEdgeDomHandles(): void {
		this.highlightedEdgePairKeys.clear();
	}

	clearAll(): void {
		this.stopFrameLoop();
		for (const item of this.activeTransfers.values()) {
			item.rootEl.remove();
		}
		this.activeTransfers.clear();
		this.syncActiveEdgeHighlights(new Set());
		this.highlightedEdgePairKeys.clear();
	}

	override dispose(): void {
		this.clearAll();
		this.layerEl.remove();
		super.dispose();
	}

	private ensureFrameLoop(): void {
		if (this.rafHandle !== undefined || this.activeTransfers.size === 0) {
			return;
		}
		this.rafHandle = this.clock.requestFrame(() => {
			this.rafHandle = undefined;
			const now = this.clock.now();
			this.stepAllParticles(now);
			if (this.activeTransfers.size > 0) {
				this.ensureFrameLoop();
			}
		});
	}

	private stopFrameLoop(): void {
		if (this.rafHandle !== undefined) {
			this.clock.cancelFrame(this.rafHandle);
			this.rafHandle = undefined;
		}
	}

	private syncParticleDirectionStyle(rootEl: SVGGElement, isReverse: boolean): void {
		rootEl.classList.toggle('is-return', isReverse);
		rootEl.classList.toggle('is-reverse', isReverse);
		rootEl.classList.toggle('is-dispatch', !isReverse);
		const isLightTheme = Boolean(this.layerEl.closest('.monaco-workbench.vs, .monaco-workbench.hc-light'));
		const color = isLightTheme
			? (isReverse ? '#059669' : '#0284c7')
			: (isReverse ? '#34d399' : '#38bdf8');
		rootEl.style.setProperty('--flow-color', color);
		rootEl.style.setProperty('--puck-color', color);
	}

	private stepAllParticles(now: number): void {
		const liveEdgePairKeys = new Set<string>();

		for (const [transferId, item] of [...this.activeTransfers.entries()]) {
			const elapsed = now - item.event.transferred_at;
			if (elapsed >= ADE_TICKET_FLOW_DURATION_MS) {
				item.rootEl.remove();
				this.activeTransfers.delete(transferId);
				continue;
			}

			// Measure real SVG `<path>` lengths across the entire single-parent tree relay path
			const resolvedSegments: Array<{
				readonly hop: IAdeTicketTransferHop;
				readonly handle: IRenderedEdgeHandle;
				readonly length: number;
			}> = [];
			for (const hop of item.orderedHops) {
				const handle = this.resolveEdgeByPairKey(hop.edge_pair_key);
				if (!handle) {
					continue;
				}
				const len = getOrMeasureEdgeTotalLength(handle);
				resolvedSegments.push({ hop, handle, length: len });
			}

			if (resolvedSegments.length === 0) {
				// All edges along this path were deleted from topology -> recycle cleanly
				item.rootEl.remove();
				this.activeTransfers.delete(transferId);
				continue;
			}

			const segLengths = resolvedSegments.map(s => s.length);
			const segDurations = computeRelaySegmentDurations(segLengths, ADE_TICKET_FLOW_DURATION_MS);
			const totalLength = segLengths.reduce((a, b) => a + b, 0);

			const clampedElapsed = Math.max(0, elapsed);
			const u = Math.min(1, clampedElapsed / ADE_TICKET_FLOW_DURATION_MS);
			const targetGlobalArc = u * totalLength;

			let accLen = 0;
			let activeIdx = resolvedSegments.length - 1;
			let segOffset = resolvedSegments[activeIdx].length;
			for (let i = 0; i < resolvedSegments.length; i++) {
				const segLen = resolvedSegments[i].length;
				if (targetGlobalArc <= accLen + segLen || i === resolvedSegments.length - 1) {
					activeIdx = i;
					segOffset = Math.max(0, Math.min(segLen, targetGlobalArc - accLen));
					break;
				}
				accLen += segLen;
			}

			const activeSeg = resolvedSegments[activeIdx];
			const isReverse = activeSeg.hop.hop_from_id === activeSeg.handle.toId;
			const localArc = isReverse
				? Math.max(0, activeSeg.length - segOffset)
				: segOffset;
			const wakeSign = isReverse ? 1 : -1;
			const trail1Arc = Math.max(0, Math.min(activeSeg.length, localArc + wakeSign * 11));
			const trail2Arc = Math.max(0, Math.min(activeSeg.length, localArc + wakeSign * 22));

			const headPt = sampleSvgPathAtLength(activeSeg.handle.path, localArc, activeSeg.length, activeSeg.handle.route.points);
			const t1Pt = sampleSvgPathAtLength(activeSeg.handle.path, trail1Arc, activeSeg.length, activeSeg.handle.route.points);
			const t2Pt = sampleSvgPathAtLength(activeSeg.handle.path, trail2Arc, activeSeg.length, activeSeg.handle.route.points);

			item.bodyEl.setAttribute('transform', `translate(${headPt.x.toFixed(2)}, ${headPt.y.toFixed(2)})`);
			item.trail1El.setAttribute('cx', t1Pt.x.toFixed(2));
			item.trail1El.setAttribute('cy', t1Pt.y.toFixed(2));
			item.trail2El.setAttribute('cx', t2Pt.x.toFixed(2));
			item.trail2El.setAttribute('cy', t2Pt.y.toFixed(2));

			const direction: 'forward' | 'reverse' = isReverse ? 'reverse' : 'forward';
			item.currentHopIndex = activeIdx;
			item.currentEdgePairKey = activeSeg.hop.edge_pair_key;
			item.currentDirection = direction;
			item.progress = u;
			item.x = headPt.x;
			item.y = headPt.y;
			item.segmentLengths = segLengths;
			item.segmentDurationsMs = segDurations;

			item.rootEl.setAttribute('data-hop-index', String(activeIdx));
			item.rootEl.setAttribute('data-edge-pair-key', activeSeg.hop.edge_pair_key);
			item.rootEl.setAttribute('data-direction', direction);
			this.syncParticleDirectionStyle(item.rootEl, isReverse);

			liveEdgePairKeys.add(activeSeg.hop.edge_pair_key);
		}

		this.syncActiveEdgeHighlights(liveEdgePairKeys);
	}

	private syncActiveEdgeHighlights(liveEdgePairKeys: ReadonlySet<string>): void {
		for (const prevKey of [...this.highlightedEdgePairKeys]) {
			if (!liveEdgePairKeys.has(prevKey)) {
				this.highlightedEdgePairKeys.delete(prevKey);
				const handle = this.resolveEdgeByPairKey(prevKey);
				if (handle && !handle.isWhiteboardLink) {
					handle.group.classList.remove('is-orch-live-flow');
					handle.haloPath.classList.remove('is-live');
				}
			}
		}
		for (const nextKey of liveEdgePairKeys) {
			if (!this.highlightedEdgePairKeys.has(nextKey)) {
				const handle = this.resolveEdgeByPairKey(nextKey);
				if (handle && !handle.isWhiteboardLink) {
					handle.group.classList.add('is-orch-live-flow');
					handle.haloPath.classList.add('is-live');
					this.highlightedEdgePairKeys.add(nextKey);
				}
			}
		}
	}
}

// ============================================================================
// Nested Department Bounding Regions & Forced Bidirectional Edge Router
// ============================================================================

export interface IOrchDeptHandle {
	dept: IOrchestrationDepartmentGroup;
	readonly group: SVGGElement;
	readonly frameRect: SVGRectElement;
	readonly pillGroup: SVGGElement;
	readonly pillBg: SVGRectElement;
	readonly pillText: SVGTextElement;
	readonly grips: readonly SVGCircleElement[];
	emptyHint?: SVGTextElement;
	memberIds: readonly string[];
	emptyCenter?: IMissionNodePosition;
	boxX: number;
	boxY: number;
	boxW: number;
	boxH: number;
	x: number;
	y: number;
	w: number;
}

export interface IOrchDeptBounds {
	readonly id: string;
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
	readonly colorHex?: string;
}

export function computeEmptyDeptFallbackPositions(
	nodes: readonly IOrchestrationGraphNode[],
	departments: readonly IOrchestrationDepartmentGroup[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
): readonly IMissionNodePosition[] {
	if (departments.length === 0) {
		return [];
	}
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	let globalMaxX = 120;
	let globalMinY = 140;
	let hasPlacedNode = false;
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (!p) {
			continue;
		}
		const sz = getOrchestrationNodeSize(n);
		globalMaxX = Math.max(globalMaxX, p.x + sz.width / 2);
		globalMinY = hasPlacedNode ? Math.min(globalMinY, p.y - sz.height / 2) : (p.y - sz.height / 2);
		hasPlacedNode = true;
	}
	const extras: IMissionNodePosition[] = [];
	let emptyIndex = 0;
	for (const dept of departments) {
		const allIds = [...new Set([...dept.nodeIds, ...dept.whiteboardIds])];
		const hasMemberPos = allIds.some(nid => nodeById.has(nid) && positions.has(nid));
		if (hasMemberPos) {
			continue;
		}
		const emptyH = 184;
		const center = positions.get(dept.id) ?? {
			x: Math.round(hasPlacedNode ? globalMaxX + 260 : 340),
			y: Math.round((hasPlacedNode ? globalMinY + 90 : 220) + emptyIndex * (emptyH + 54)),
		};
		emptyIndex++;
		extras.push(center, { x: center.x + 200, y: center.y + 120 });
	}
	return extras;
}

export interface IOrchDeptRenderContext {
	readonly cloudTerritoriesLayerEl: SVGGElement;
	readonly deptDisposables: DisposableStore;
	readonly deptHandles: Map<string, IOrchDeptHandle>;
	readonly deptPillRectById: Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>;
	readonly activeStaffNodeIds?: ReadonlySet<string>;
	readonly bindDepartmentPillInteractions: (
		pillGroup: SVGGElement,
		getDept: () => IOrchestrationDepartmentGroup,
		getMemberIds: () => readonly string[],
		getEmptyCenter: () => IMissionNodePosition | undefined,
	) => void;
}

export function renderOrchestrationDepartmentRegions(
	nodes: readonly IOrchestrationGraphNode[],
	departments: readonly IOrchestrationDepartmentGroup[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	ctx: IOrchDeptRenderContext,
	forceRebuild = false,
): readonly IOrchDeptBounds[] {
	if (departments.length === 0) {
		ctx.deptDisposables.clear();
		ctx.deptHandles.clear();
		ctx.deptPillRectById.clear();
		while (ctx.cloudTerritoriesLayerEl.firstChild) {
			ctx.cloudTerritoriesLayerEl.removeChild(ctx.cloudTerritoriesLayerEl.firstChild);
		}
		return [];
	}

	// Compute nesting depth (`innermost = 0`, outer parents get extra padding so nested department frames never overlap!)
	const childDeptsByParent = new Map<string, string[]>();
	for (const d of departments) {
		if (d.parentDeptId) {
			const arr = childDeptsByParent.get(d.parentDeptId) ?? [];
			arr.push(d.id);
			childDeptsByParent.set(d.parentDeptId, arr);
		}
	}
	const nestLevelMemo = new Map<string, number>();
	const computeNestPaddingLevel = (deptId: string, seen = new Set<string>()): number => {
		if (nestLevelMemo.has(deptId)) {
			return nestLevelMemo.get(deptId)!;
		}
		if (seen.has(deptId)) {
			return 0;
		}
		seen.add(deptId);
		const children = childDeptsByParent.get(deptId) ?? [];
		let maxChild = -1;
		for (const cid of children) {
			maxChild = Math.max(maxChild, computeNestPaddingLevel(cid, seen));
		}
		const lvl = maxChild + 1;
		nestLevelMemo.set(deptId, lvl);
		return lvl;
	};
	for (const d of departments) {
		computeNestPaddingLevel(d.id);
	}

	const canPatchInPlace = !forceRebuild
		&& ctx.deptHandles.size === departments.length
		&& departments.every(d => ctx.deptHandles.has(d.id));

	if (!canPatchInPlace) {
		ctx.deptDisposables.clear();
		ctx.deptHandles.clear();
		ctx.deptPillRectById.clear();
		while (ctx.cloudTerritoriesLayerEl.firstChild) {
			ctx.cloudTerritoriesLayerEl.removeChild(ctx.cloudTerritoriesLayerEl.firstChild);
		}
	}

	const nodeById = new Map(nodes.map(n => [n.id, n]));
	let globalMaxX = 120;
	let globalMinY = 140;
	let hasPlacedNode = false;
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (!p) {
			continue;
		}
		const sz = getOrchestrationNodeSize(n);
		globalMaxX = Math.max(globalMaxX, p.x + sz.width / 2);
		globalMinY = hasPlacedNode ? Math.min(globalMinY, p.y - sz.height / 2) : (p.y - sz.height / 2);
		hasPlacedNode = true;
	}

	const allBounds: IOrchDeptBounds[] = [];
	const boundsByDeptId = new Map<string, IOrchDeptBounds>();
	let emptyIndex = 0;

	// Compute bounds inner-to-outer first so outer department frames cleanly wrap inner sub-department frames!
	const innerFirstOrder = [...departments].sort(
		(a, b) => (nestLevelMemo.get(a.id) ?? 0) - (nestLevelMemo.get(b.id) ?? 0),
	);
	const computedBoxByDept = new Map<string, {
		readonly boxX: number;
		readonly boxY: number;
		readonly boxW: number;
		readonly boxH: number;
		readonly isEmptyGroup: boolean;
		readonly emptyCenter?: IMissionNodePosition;
		readonly allDeptMemberIds: readonly string[];
	}>();

	for (const dept of innerFirstOrder) {
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		let count = 0;
		const allDeptMemberIds = [...new Set([...dept.nodeIds, ...dept.whiteboardIds])];
		for (const nid of allDeptMemberIds) {
			const n = nodeById.get(nid);
			const p = positions.get(nid);
			if (!n || !p) {
				continue;
			}
			const sz = getOrchestrationNodeSize(n);
			minX = Math.min(minX, p.x - sz.width / 2);
			maxX = Math.max(maxX, p.x + sz.width / 2);
			minY = Math.min(minY, p.y - sz.height / 2);
			maxY = Math.max(maxY, p.y + sz.height / 2);
			count++;
		}
		for (const childDeptId of childDeptsByParent.get(dept.id) ?? []) {
			const childBox = boundsByDeptId.get(childDeptId);
			if (childBox) {
				minX = Math.min(minX, childBox.minX);
				maxX = Math.max(maxX, childBox.maxX);
				minY = Math.min(minY, childBox.minY);
				maxY = Math.max(maxY, childBox.maxY);
				count++;
			}
		}

		const isEmptyGroup = count === 0 || !Number.isFinite(minX);
		let boxX: number;
		let boxY: number;
		let boxW: number;
		let boxH: number;
		let emptyCenter: IMissionNodePosition | undefined;
		if (isEmptyGroup) {
			const emptyW = 368;
			const emptyH = 184;
			const explicitPos = positions.get(dept.id);
			emptyCenter = explicitPos ?? {
				x: Math.round(hasPlacedNode ? globalMaxX + 260 : 340),
				y: Math.round((hasPlacedNode ? globalMinY + 90 : 220) + emptyIndex * (emptyH + 54)),
			};
			emptyIndex++;
			boxX = Math.round(emptyCenter.x - emptyW / 2);
			boxY = Math.round(emptyCenter.y - emptyH / 2);
			boxW = emptyW;
			boxH = emptyH;
		} else {
			const hasNestedChildren = (childDeptsByParent.get(dept.id)?.length ?? 0) > 0;
			const padX = hasNestedChildren ? 26 : 36;
			const padTop = hasNestedChildren ? 38 : 44;
			const padBottom = hasNestedChildren ? 24 : 30;
			boxX = Math.round(minX - padX);
			boxY = Math.round(minY - padTop);
			boxW = Math.round(maxX - minX + padX * 2);
			boxH = Math.round(maxY - minY + padTop + padBottom);
		}

		boundsByDeptId.set(dept.id, {
			id: dept.id,
			minX: boxX,
			minY: boxY,
			maxX: boxX + boxW,
			maxY: boxY + boxH,
		});
		computedBoxByDept.set(dept.id, {
			boxX,
			boxY,
			boxW,
			boxH,
			isEmptyGroup,
			emptyCenter,
			allDeptMemberIds,
		});
	}

	// Render outer-to-inner (`departments` is already sorted outer-to-inner)
	for (let idx = 0; idx < departments.length; idx++) {
		const dept = departments[idx];
		const geom = computedBoxByDept.get(dept.id)!;
		const { boxX, boxY, boxW, boxH, isEmptyGroup, emptyCenter, allDeptMemberIds } = geom;

		const colorIdx = idx % 5;
		const deptColoredStaff = dept.nodeIds
			.map(nid => nodeById.get(nid))
			.filter((n): n is IOrchestrationGraphNode => Boolean(n && resolveAdeNodeColorHex(n.color)))
			.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
		const deptAccentHex = resolveAdeNodeColorHex(dept.color) ?? resolveAdeNodeColorHex(deptColoredStaff[0]?.color);

		let activeStaffCount = 0;
		for (const nid of dept.nodeIds) {
			if (ctx.activeStaffNodeIds?.has(nid)) {
				activeStaffCount++;
			}
		}

		const staffCount = dept.nodeIds.length;
		const wbPart = dept.whiteboardIds.length > 0 ? ` · ${dept.whiteboardIds.length} WB` : '';
		const activePart = activeStaffCount > 0
			? ` · ${adeBi(localize('adeOrchDeptActiveCount', "{0} active", activeStaffCount), '{0} 活跃', activeStaffCount)}`
			: '';
		const titleText = `${dept.name} (${staffCount}${wbPart}${activePart})`;
		const pillW = measureSvgPillWidth(titleText, 40, 124, 340);
		const pillX = boxX + 16;
		const pillY = boxY - 12;

		allBounds.push({
			id: dept.id,
			minX: boxX,
			minY: boxY,
			maxX: boxX + boxW,
			maxY: boxY + boxH,
			colorHex: deptAccentHex,
		});

		const existing = canPatchInPlace ? ctx.deptHandles.get(dept.id) : undefined;
		if (existing) {
			existing.dept = dept;
			existing.memberIds = allDeptMemberIds;
			existing.emptyCenter = emptyCenter;
			existing.boxX = boxX;
			existing.boxY = boxY;
			existing.boxW = boxW;
			existing.boxH = boxH;
			existing.x = pillX;
			existing.y = boxY;
			existing.w = pillW;
			existing.group.setAttribute('data-ade-dept-region', dept.name);
			existing.group.setAttribute('data-ade-dept-id', dept.id);
			existing.group.classList.toggle('has-custom-dept-accent', Boolean(deptAccentHex));
			existing.group.classList.toggle('is-empty-group', isEmptyGroup);
			existing.group.classList.toggle('has-active-staff', activeStaffCount > 0);
			if (deptAccentHex) {
				existing.group.style.setProperty('--ade-dept-accent', deptAccentHex);
			} else {
				existing.group.style.removeProperty('--ade-dept-accent');
			}
			existing.frameRect.setAttribute('x', String(boxX));
			existing.frameRect.setAttribute('y', String(boxY));
			existing.frameRect.setAttribute('width', String(boxW));
			existing.frameRect.setAttribute('height', String(boxH));
			existing.pillGroup.setAttribute('data-ade-dept-name', dept.name);
			existing.pillGroup.setAttribute('data-ade-dept-id', dept.id);
			existing.pillBg.setAttribute('x', String(pillX));
			existing.pillBg.setAttribute('y', String(pillY));
			existing.pillBg.setAttribute('width', String(pillW));
			let gi = 0;
			for (let r = 0; r < 3; r++) {
				for (let c = 0; c < 2; c++) {
					const dot = existing.grips[gi++];
					if (dot) {
						dot.setAttribute('cx', String(pillX + 12 + c * 4));
						dot.setAttribute('cy', String(pillY + 8 + r * 4));
					}
				}
			}
			existing.pillText.setAttribute('x', String(pillX + 24));
			existing.pillText.setAttribute('y', String(boxY + 1));
			if (existing.pillText.textContent !== titleText) {
				existing.pillText.textContent = titleText;
			}
			if (isEmptyGroup) {
				if (!existing.emptyHint) {
					const hintText = svgEl('text', {
						class: 'ade-orch-dept-empty-hint',
						x: String(Math.round(boxX + boxW / 2)),
						y: String(Math.round(boxY + boxH / 2 + 4)),
					});
					hintText.textContent = adeBi(localize('adeOrchEmptyGroupHint', "Empty Department"), '空部门');
					existing.group.insertBefore(hintText, existing.pillGroup);
					existing.emptyHint = hintText;
				} else {
					existing.emptyHint.setAttribute('x', String(Math.round(boxX + boxW / 2)));
					existing.emptyHint.setAttribute('y', String(Math.round(boxY + boxH / 2 + 4)));
				}
			} else if (existing.emptyHint) {
				existing.emptyHint.remove();
				existing.emptyHint = undefined;
			}
			ctx.deptPillRectById.set(dept.id, { dept, x: pillX, y: boxY, w: pillW });
			continue;
		}

		const group = svgEl('g', {
			class: `ade-orch-dept-region dept-color-${colorIdx}${deptAccentHex ? ' has-custom-dept-accent' : ''}${isEmptyGroup ? ' is-empty-group' : ''}${activeStaffCount > 0 ? ' has-active-staff' : ''}`,
			'data-ade-dept-region': dept.name,
			'data-ade-dept-id': dept.id,
		});
		if (deptAccentHex) {
			group.style.setProperty('--ade-dept-accent', deptAccentHex);
		}
		const frameRect = svgEl('rect', {
			class: 'ade-orch-dept-frame',
			x: String(boxX),
			y: String(boxY),
			width: String(boxW),
			height: String(boxH),
			rx: '18',
		});
		group.appendChild(frameRect);

		let emptyHint: SVGTextElement | undefined;
		if (isEmptyGroup) {
			emptyHint = svgEl('text', {
				class: 'ade-orch-dept-empty-hint',
				x: String(Math.round(boxX + boxW / 2)),
				y: String(Math.round(boxY + boxH / 2 + 4)),
			});
			emptyHint.textContent = adeBi(localize('adeOrchEmptyGroupHint', "Empty Department"), '空部门');
			group.appendChild(emptyHint);
		}

		const pillGroup = svgEl('g', {
			class: 'ade-orch-dept-pill-group',
			'data-ade-dept-pill': dept.id,
			'data-ade-dept-name': dept.name,
			'data-ade-dept-id': dept.id,
		});
		const pillBg = svgEl('rect', {
			class: 'ade-orch-dept-pill-bg',
			x: String(pillX),
			y: String(pillY),
			width: String(pillW),
			height: '24',
			rx: '12',
		});
		pillGroup.appendChild(pillBg);

		const grips: SVGCircleElement[] = [];
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 2; c++) {
				const dot = svgEl('circle', {
					class: 'ade-orch-dept-grip',
					cx: String(pillX + 12 + c * 4),
					cy: String(pillY + 8 + r * 4),
					r: '1.1',
				});
				pillGroup.appendChild(dot);
				grips.push(dot);
			}
		}

		const pillText = svgEl('text', {
			class: 'ade-orch-dept-pill-text',
			x: String(pillX + 24),
			y: String(boxY + 1),
		});
		pillText.textContent = titleText;
		pillGroup.appendChild(pillText);
		group.appendChild(pillGroup);
		ctx.cloudTerritoriesLayerEl.appendChild(group);

		const handle: IOrchDeptHandle = {
			dept,
			group,
			frameRect,
			pillGroup,
			pillBg,
			pillText,
			grips,
			emptyHint,
			memberIds: allDeptMemberIds,
			emptyCenter,
			boxX,
			boxY,
			boxW,
			boxH,
			x: pillX,
			y: boxY,
			w: pillW,
		};
		ctx.deptHandles.set(dept.id, handle);
		ctx.deptPillRectById.set(dept.id, { dept, x: pillX, y: boxY, w: pillW });
		ctx.bindDepartmentPillInteractions(
			pillGroup,
			() => handle.dept,
			() => handle.memberIds,
			() => handle.emptyCenter,
		);
	}

	return allBounds;
}

export interface IOrchEdgesRenderContext {
	readonly edgesLayerEl: SVGGElement;
	readonly edgeDisposables: DisposableStore;
	readonly edgeHandles: Map<string, IRenderedEdgeHandle>;
	readonly edgeHandleByPairKey: Map<string, IRenderedEdgeHandle>;
	readonly orchAnchorButtons: ReadonlyMap<string, HTMLButtonElement>;
	readonly deptPillRectById: ReadonlyMap<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>;
	readonly selectedEdgePairKey: string | undefined;
	readonly layoutMode?: 'TD' | 'LR';
	readonly onHoverStaffEdge?: (edgePairKey: string, clientX: number, clientY: number) => void;
	readonly onMoveStaffEdge?: (edgePairKey: string, clientX: number, clientY: number) => void;
	readonly onLeaveStaffEdge?: (edgePairKey: string) => void;
	readonly onClickStaffEdge?: (edgePairKey: string, clientX: number, clientY: number) => void;
	readonly onClickWhiteboardLink?: (boardId: string, anchorEl: SVGElement) => void;
}

/**
 * Renders single-parent reporting tree edges and whiteboard dashed links:
 * - Every staff parent-child edge is STRICTLY bidirectional (`marker-start` AND `marker-end` bound simultaneously).
 * - Every whiteboard attachment edge is dashed with `outset = 0` and ZERO arrowheads.
 * - ZERO `<title>` elements on edges (`plan.md` §8.4.1).
 * - Preserves existing DOM handles in-place during card drag or incremental updates so active 3000ms animations never reset!
 */
export function renderOrchestrationMultiAnchorEdges(
	nodes: readonly IOrchestrationGraphNode[],
	edges: readonly IOrchestrationGraphEdge[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	direction: OrchestrationDirection,
	layoutMode: OrchestrationLayoutMode | undefined,
	ctx: IOrchEdgesRenderContext,
	options?: {
		readonly forceRebuild?: boolean;
		readonly movedNodeId?: string;
	},
): { readonly rebuilt: boolean } {
	for (const pin of ctx.orchAnchorButtons.values()) {
		pin.classList.remove('is-occupied', 'is-bidir-anchor', 'is-wb-anchor');
		pin.style.removeProperty('--pin-accent');
	}

	if (edges.length === 0) {
		ctx.edgeDisposables.clear();
		ctx.edgeHandles.clear();
		ctx.edgeHandleByPairKey.clear();
		while (ctx.edgesLayerEl.firstChild) {
			ctx.edgesLayerEl.removeChild(ctx.edgesLayerEl.firstChild);
		}
		return { rebuilt: true };
	}

	const canPatchInPlace = !options?.forceRebuild
		&& ctx.edgeHandles.size === edges.length
		&& edges.every(e => ctx.edgeHandles.has(e.id));

	if (!canPatchInPlace) {
		ctx.edgeDisposables.clear();
		ctx.edgeHandles.clear();
		ctx.edgeHandleByPairKey.clear();
		while (ctx.edgesLayerEl.firstChild) {
			ctx.edgesLayerEl.removeChild(ctx.edgesLayerEl.firstChild);
		}
	}

	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const allObstacles: Array<{ readonly id: string; readonly box: IMissionEdgeObstacle }> = [];
	const rawCardBoxes: IMissionEdgeObstacle[] = [];
	for (const n of nodes) {
		const p = positions.get(n.id);
		if (!p) {
			continue;
		}
		const sz = getOrchestrationNodeSize(n);
		rawCardBoxes.push({
			minX: p.x - sz.width / 2,
			maxX: p.x + sz.width / 2,
			minY: p.y - sz.height / 2,
			maxY: p.y + sz.height / 2,
		});
		allObstacles.push({
			id: n.id,
			box: {
				minX: p.x - sz.width / 2 - 10,
				maxX: p.x + sz.width / 2 + 10,
				minY: p.y - sz.height / 2 - 10,
				maxY: p.y + sz.height / 2 + 10,
			},
		});
	}

	const deptPillBoxes: IMissionEdgeObstacle[] = [];
	for (const p of ctx.deptPillRectById.values()) {
		deptPillBoxes.push({
			minX: p.x - 4,
			maxX: p.x + p.w + 4,
			minY: p.y - 14,
			maxY: p.y + 14,
		});
	}

	// During single-node drag, re-anchor existing routes cleanly with `reanchorOrchestrationRoute`;
	// otherwise compute full multi-anchor slot routing.
	const rawRoutes = (canPatchInPlace && options?.movedNodeId)
		? undefined
		: computeOrchestrationMultiAnchorRoutes(nodes, edges, positions, {
			direction,
			cornerRadius: ORCH_CORNER_RADIUS,
			layoutMode,
		});

	for (const edge of edges) {
		const fromNode = nodeById.get(edge.from);
		const toNode = nodeById.get(edge.to);
		if (!fromNode || !toNode) {
			continue;
		}
		const isWhiteboardLink = Boolean(edge.isWhiteboardLink || fromNode.kind === 'whiteboard' || toNode.kind === 'whiteboard');
		const existing = canPatchInPlace ? ctx.edgeHandles.get(edge.id) : undefined;

		let baseRoute: IOrchestrationRoutedEdge | undefined;
		if (existing && options?.movedNodeId) {
			if (edge.from === options.movedNodeId || edge.to === options.movedNodeId) {
				const reanchorMode: 'TD' | 'LR' = (ctx.layoutMode === 'LR' || layoutMode === 'lr' || direction === 'LR') ? 'LR' : 'TD';
				baseRoute = reanchorOrchestrationRoute(edge, existing.route, nodeById, positions, allObstacles, reanchorMode);
			} else {
				baseRoute = existing.route;
			}
		} else {
			baseRoute = rawRoutes?.get(edge.id);
		}
		if (!baseRoute) {
			continue;
		}

		const rigidStub = isWhiteboardLink ? 14 : ORCH_RIGID_STUB_LENGTH;
		const cornerRadius = isWhiteboardLink ? 12 : ORCH_CORNER_RADIUS;
		const detoured = detourPolylineAroundPillBoxes(baseRoute.points, deptPillBoxes, cornerRadius, rigidStub, rawCardBoxes);
		const route: IOrchestrationRoutedEdge = detoured.path
			? {
				...baseRoute,
				points: detoured.points,
				path: detoured.path,
				midX: detoured.midX ?? baseRoute.midX,
				midY: detoured.midY ?? baseRoute.midY,
			}
			: baseRoute;

		const preferredColorToken = isWhiteboardLink
			? (toNode.kind === 'whiteboard' ? (toNode.color ?? fromNode.color) : (fromNode.color ?? toNode.color))
			: (toNode.color ?? fromNode.color);
		const staticAccentHex = resolveAdeNodeColorHex(preferredColorToken) ?? (isWhiteboardLink ? '#a78bfa' : '#38bdf8');

		// Mark occupied perimeter anchor pins
		const fromPin = ctx.orchAnchorButtons.get(`${edge.from}:${route.fromAnchor.side}:${route.fromAnchor.slot}`);
		const toPin = ctx.orchAnchorButtons.get(`${edge.to}:${route.toAnchor.side}:${route.toAnchor.slot}`);
		for (const pin of [fromPin, toPin]) {
			if (!pin) {
				continue;
			}
			pin.classList.add('is-occupied');
			pin.style.setProperty('--pin-accent', staticAccentHex);
			pin.classList.add(isWhiteboardLink ? 'is-wb-anchor' : 'is-bidir-anchor');
		}

		const edgePairKey = isWhiteboardLink
			? edge.id
			: (edge.edgePairKey ?? canonicalEdgePairKey(edge.from, edge.to));
		const isSelected = !isWhiteboardLink && ctx.selectedEdgePairKey === edgePairKey;

		// Mandatory dual-arrowheads on ALL staff parent-child edges; ZERO arrowheads on whiteboard links!
		const baseMarker = isWhiteboardLink
			? undefined
			: resolveArrowMarkerUrlForColor(preferredColorToken, 'ade-mission-arrow-bidir');
		const activeMarker = isSelected ? 'url(#ade-mission-arrow-active)' : baseMarker;

		if (existing) {
			existing.route = route;
			existing.bbox = computeRouteBbox(route.points);
			existing.staticAccentHex = staticAccentHex;
			existing.baseMarkerStart = baseMarker;
			existing.baseMarkerEnd = baseMarker;
			existing.group.style.setProperty('--edge-accent', staticAccentHex);
			existing.group.classList.toggle('is-selected', isSelected);
			if (isSelected) {
				existing.group.setAttribute('data-edge-selected', 'true');
			} else {
				existing.group.removeAttribute('data-edge-selected');
			}
			existing.group.setAttribute('data-from-anchor', `${route.fromAnchor.side}:${route.fromAnchor.slot}`);
			existing.group.setAttribute('data-to-anchor', `${route.toAnchor.side}:${route.toAnchor.slot}`);
			if (existing.path.getAttribute('d') !== route.path) {
				existing.path.setAttribute('d', route.path);
				existing.hoverStreamPath.setAttribute('d', route.path);
				existing.hitPath.setAttribute('d', route.path);
				existing.haloPath.setAttribute('d', route.path);
				existing.cachedTotalLength = undefined;
			}
			if (activeMarker) {
				existing.path.setAttribute('marker-start', activeMarker);
				existing.path.setAttribute('marker-end', activeMarker);
			} else {
				existing.path.removeAttribute('marker-start');
				existing.path.removeAttribute('marker-end');
			}
			if (!isWhiteboardLink) {
				ctx.edgeHandleByPairKey.set(edgePairKey, existing);
			}
			continue;
		}

		const edgeClasses = ['ade-mission-edge-group', 'is-orch-edge'];
		if (isWhiteboardLink) {
			edgeClasses.push('is-whiteboard-link', 'is-dashed');
		} else {
			edgeClasses.push('is-bidirectional');
		}
		if (isSelected) {
			edgeClasses.push('is-selected');
		}

		const group = svgEl('g', {
			class: edgeClasses.join(' '),
			'data-edge-id': edge.id,
			'data-edge-pair-key': edgePairKey,
			'data-from': edge.from,
			'data-to': edge.to,
			'data-from-anchor': `${route.fromAnchor.side}:${route.fromAnchor.slot}`,
			'data-to-anchor': `${route.toAnchor.side}:${route.toAnchor.slot}`,
			'data-bidirectional': String(!isWhiteboardLink),
			...(isSelected ? { 'data-edge-selected': 'true' } : {}),
		});
		group.style.setProperty('--edge-accent', staticAccentHex);

		const hitPath = svgEl('path', {
			class: 'ade-mission-edge-hit',
			d: route.path,
		});
		group.appendChild(hitPath);

		const haloPath = svgEl('path', {
			class: 'ade-orch-edge-halo',
			d: route.path,
		});
		group.appendChild(haloPath);

		const pathAttrs: Record<string, string> = {
			class: 'ade-mission-edge-path',
			d: route.path,
		};
		if (activeMarker) {
			pathAttrs['marker-start'] = activeMarker;
			pathAttrs['marker-end'] = activeMarker;
		}
		const path = svgEl('path', pathAttrs);
		group.appendChild(path);

		const hoverStreamPath = svgEl('path', {
			class: 'ade-mission-edge-hover-stream',
			d: route.path,
		});
		group.appendChild(hoverStreamPath);

		ctx.edgeDisposables.add(addDisposableListener(group, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button === 0) {
				e.stopPropagation();
			}
		}));

		if (isWhiteboardLink) {
			const wbId = toNode.kind === 'whiteboard' ? toNode.id : fromNode.id;
			ctx.edgeDisposables.add(addDisposableListener(group, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				ctx.onClickWhiteboardLink?.(wbId, group);
			}));
		} else {
			ctx.edgeDisposables.add(addDisposableListener(group, 'pointerenter', (e: PointerEvent) => {
				ctx.onHoverStaffEdge?.(edgePairKey, e.clientX, e.clientY);
			}));
			ctx.edgeDisposables.add(addDisposableListener(group, EventType.POINTER_MOVE, (e: PointerEvent) => {
				ctx.onMoveStaffEdge?.(edgePairKey, e.clientX, e.clientY);
			}));
			ctx.edgeDisposables.add(addDisposableListener(group, 'pointerleave', () => {
				ctx.onLeaveStaffEdge?.(edgePairKey);
			}));
			ctx.edgeDisposables.add(addDisposableListener(group, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				ctx.onClickStaffEdge?.(edgePairKey, e.clientX, e.clientY);
			}));
		}

		ctx.edgesLayerEl.appendChild(group);
		const handle: IRenderedEdgeHandle = {
			group,
			path,
			hoverStreamPath,
			hitPath,
			haloPath,
			edgeId: edge.id,
			edgePairKey,
			fromId: edge.from,
			toId: edge.to,
			isWhiteboardLink,
			isBidirectional: !isWhiteboardLink,
			baseMarkerStart: baseMarker,
			baseMarkerEnd: baseMarker,
			staticAccentHex,
			route,
			bbox: computeRouteBbox(route.points),
		};
		ctx.edgeHandles.set(edge.id, handle);
		if (!isWhiteboardLink) {
			ctx.edgeHandleByPairKey.set(edgePairKey, handle);
		}
	}

	return { rebuilt: !canPatchInPlace };
}
