/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { getMissionEdgeKind, IMissionDagEdge, IMissionDagNode, IMissionNodePosition } from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { getMissionNodeSize, svgEl } from './adeMissionCanvasRenderer.js';

const MINIMAP_VB_W = 200;
const MINIMAP_VB_H = 120;
const MINIMAP_PAD_WORLD = 140;

export interface IMissionMinimapCallbacks {
	onNavigateToWorldCenter(worldX: number, worldY: number): void;
}

/**
 * Interactive bottom-right Mission DAG Minimap:
 * - Renders lightweight color-coded SVG overview of nodes (live runtime states) and edges.
 * - Tracks the live visible canvas viewport rectangle in O(1) during pan/zoom/fit.
 * - Supports click and drag navigation directly on the overview map.
 */
export class AdeMissionMinimap extends Disposable {
	private readonly containerEl: HTMLElement;
	private readonly svgEl: SVGSVGElement;
	private readonly edgesLayerEl: SVGGElement;
	private readonly nodesLayerEl: SVGGElement;
	private readonly viewportRectEl: SVGRectElement;

	private userVisible = true;
	private hasGraphNodes = false;
	private dragging = false;

	// Current world-to-minimap projection bounds
	private boundsMinX = 0;
	private boundsMinY = 0;
	private boundsScale = 1;
	private boundsOffsetX = 0;
	private boundsOffsetY = 0;

	private lastPanX = 0;
	private lastPanY = 0;
	private lastZoom = 1;
	private lastViewportW = 0;
	private lastViewportH = 0;

	constructor(
		bodyEl: HTMLElement,
		private readonly callbacks: IMissionMinimapCallbacks,
	) {
		super();
		this.containerEl = append(bodyEl, $('.ade-mission-minimap', {
			role: 'region',
			'aria-label': localize('adeMissionMinimapAria', "Mission Canvas Minimap"),
			'data-ade-mission-minimap': 'true',
		}));
		this.containerEl.hidden = true;

		this.svgEl = svgEl('svg', {
			class: 'ade-mission-minimap-svg',
			viewBox: `0 0 ${MINIMAP_VB_W} ${MINIMAP_VB_H}`,
			preserveAspectRatio: 'none',
		});
		this.edgesLayerEl = svgEl('g', { class: 'ade-mission-minimap-edges' });
		this.nodesLayerEl = svgEl('g', { class: 'ade-mission-minimap-nodes' });
		this.viewportRectEl = svgEl('rect', {
			class: 'ade-mission-minimap-viewport',
			'data-ade-minimap-viewport': 'true',
			x: '0',
			y: '0',
			width: '0',
			height: '0',
			rx: '3',
		});
		this.svgEl.appendChild(this.edgesLayerEl);
		this.svgEl.appendChild(this.nodesLayerEl);
		this.svgEl.appendChild(this.viewportRectEl);
		this.containerEl.appendChild(this.svgEl);

		const navigateAtClientPoint = (clientX: number, clientY: number): void => {
			const rect = this.svgEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0 || this.boundsScale <= 0) {
				return;
			}
			const vbX = Math.max(0, Math.min(MINIMAP_VB_W, ((clientX - rect.left) / rect.width) * MINIMAP_VB_W));
			const vbY = Math.max(0, Math.min(MINIMAP_VB_H, ((clientY - rect.top) / rect.height) * MINIMAP_VB_H));
			const worldX = this.boundsMinX + (vbX - this.boundsOffsetX) / this.boundsScale;
			const worldY = this.boundsMinY + (vbY - this.boundsOffsetY) / this.boundsScale;
			this.callbacks.onNavigateToWorldCenter(worldX, worldY);
		};

		this._register(addDisposableListener(this.containerEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.stopPropagation();
			this.dragging = true;
			try {
				this.containerEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic events */ }
			navigateAtClientPoint(e.clientX, e.clientY);
		}));
		this._register(addDisposableListener(this.containerEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!this.dragging) {
				return;
			}
			e.stopPropagation();
			navigateAtClientPoint(e.clientX, e.clientY);
		}));
		const stopDrag = (e: PointerEvent) => {
			if (!this.dragging) {
				return;
			}
			this.dragging = false;
			try {
				this.containerEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
		};
		this._register(addDisposableListener(this.containerEl, EventType.POINTER_UP, stopDrag));
		this._register(addDisposableListener(this.containerEl, 'pointercancel', stopDrag));
		this._register(addDisposableListener(this.containerEl, 'lostpointercapture', () => {
			this.dragging = false;
		}));
	}

	isUserVisible(): boolean {
		return this.userVisible;
	}

	setUserVisible(visible: boolean): void {
		this.userVisible = visible;
		this.containerEl.hidden = !this.userVisible || !this.hasGraphNodes;
	}

	setInspectorOpen(open: boolean): void {
		this.containerEl.classList.toggle('has-inspector-open', open);
	}

	syncGraph(
		nodes: readonly IMissionDagNode[],
		edges: readonly IMissionDagEdge[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
		runtimeState: IMissionRuntimeState | undefined,
		selectedNodeId: string | undefined,
	): void {
		this.hasGraphNodes = nodes.length > 0;
		this.containerEl.hidden = !this.userVisible || !this.hasGraphNodes;

		while (this.edgesLayerEl.firstChild) {
			this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
		}
		while (this.nodesLayerEl.firstChild) {
			this.nodesLayerEl.removeChild(this.nodesLayerEl.firstChild);
		}
		if (!this.hasGraphNodes) {
			return;
		}

		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		const sizeById = new Map<string, { readonly width: number; readonly height: number }>();
		for (const node of nodes) {
			const pos = positions.get(node.id);
			if (!pos) {
				continue;
			}
			const sz = getMissionNodeSize(node);
			sizeById.set(node.id, sz);
			minX = Math.min(minX, pos.x - sz.width / 2);
			maxX = Math.max(maxX, pos.x + sz.width / 2);
			minY = Math.min(minY, pos.y - sz.height / 2);
			maxY = Math.max(maxY, pos.y + sz.height / 2);
		}
		if (!Number.isFinite(minX)) {
			this.hasGraphNodes = false;
			this.containerEl.hidden = true;
			return;
		}

		this.boundsMinX = minX - MINIMAP_PAD_WORLD;
		this.boundsMinY = minY - MINIMAP_PAD_WORLD;
		const spanW = Math.max(400, (maxX - minX) + MINIMAP_PAD_WORLD * 2);
		const spanH = Math.max(240, (maxY - minY) + MINIMAP_PAD_WORLD * 2);
		this.boundsScale = Math.min((MINIMAP_VB_W - 8) / spanW, (MINIMAP_VB_H - 8) / spanH);
		this.boundsOffsetX = (MINIMAP_VB_W - spanW * this.boundsScale) / 2;
		this.boundsOffsetY = (MINIMAP_VB_H - spanH * this.boundsScale) / 2;

		const toX = (wx: number) => this.boundsOffsetX + (wx - this.boundsMinX) * this.boundsScale;
		const toY = (wy: number) => this.boundsOffsetY + (wy - this.boundsMinY) * this.boundsScale;

		for (const edge of edges) {
			const fp = positions.get(edge.from);
			const tp = positions.get(edge.to);
			if (!fp || !tp) {
				continue;
			}
			const isFail = getMissionEdgeKind(edge) === 'fail';
			this.edgesLayerEl.appendChild(svgEl('line', {
				class: `ade-mission-minimap-edge${isFail ? ' is-fail' : ''}`,
				x1: toX(fp.x).toFixed(1),
				y1: toY(fp.y).toFixed(1),
				x2: toX(tp.x).toFixed(1),
				y2: toY(tp.y).toFixed(1),
			}));
		}

		for (const node of nodes) {
			const pos = positions.get(node.id);
			const sz = sizeById.get(node.id);
			if (!pos || !sz) {
				continue;
			}
			const st = runtimeState?.nodeStates[node.id] ?? 'idle';
			const cls = [
				'ade-mission-minimap-node',
				`kind-${node.kind}`,
				`state-${st.replace(/_/g, '-')}`,
				selectedNodeId === node.id ? 'is-selected' : '',
			].filter(Boolean).join(' ');
			const w = Math.max(5, sz.width * this.boundsScale);
			const h = Math.max(4, sz.height * this.boundsScale);
			this.nodesLayerEl.appendChild(svgEl('rect', {
				class: cls,
				'data-minimap-node': node.id,
				x: (toX(pos.x) - w / 2).toFixed(1),
				y: (toY(pos.y) - h / 2).toFixed(1),
				width: w.toFixed(1),
				height: h.toFixed(1),
				rx: node.kind === 'gate' ? '3' : '2',
			}));
		}

		this.updateViewport(this.lastPanX, this.lastPanY, this.lastZoom, this.lastViewportW, this.lastViewportH);
	}

	updateViewport(panX: number, panY: number, zoom: number, viewportWidth: number, viewportHeight: number): void {
		this.lastPanX = panX;
		this.lastPanY = panY;
		this.lastZoom = zoom;
		this.lastViewportW = viewportWidth;
		this.lastViewportH = viewportHeight;

		if (!this.hasGraphNodes || zoom <= 0 || viewportWidth <= 0 || viewportHeight <= 0 || this.boundsScale <= 0) {
			this.viewportRectEl.setAttribute('width', '0');
			this.viewportRectEl.setAttribute('height', '0');
			return;
		}
		const worldLeft = -panX / zoom;
		const worldTop = -panY / zoom;
		const worldW = viewportWidth / zoom;
		const worldH = viewportHeight / zoom;

		const rawX = this.boundsOffsetX + (worldLeft - this.boundsMinX) * this.boundsScale;
		const rawY = this.boundsOffsetY + (worldTop - this.boundsMinY) * this.boundsScale;
		const rawW = worldW * this.boundsScale;
		const rawH = worldH * this.boundsScale;

		const clampedX = Math.max(1, Math.min(MINIMAP_VB_W - 7, rawX));
		const clampedY = Math.max(1, Math.min(MINIMAP_VB_H - 7, rawY));
		const clampedW = Math.max(6, Math.min(MINIMAP_VB_W - clampedX - 1, rawW - Math.max(0, clampedX - rawX)));
		const clampedH = Math.max(6, Math.min(MINIMAP_VB_H - clampedY - 1, rawH - Math.max(0, clampedY - rawY)));

		this.viewportRectEl.setAttribute('x', clampedX.toFixed(1));
		this.viewportRectEl.setAttribute('y', clampedY.toFixed(1));
		this.viewportRectEl.setAttribute('width', clampedW.toFixed(1));
		this.viewportRectEl.setAttribute('height', clampedH.toFixed(1));
	}
}
