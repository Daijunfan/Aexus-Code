/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { getMissionEdgeKind, IMissionDagEdge, IMissionDagNode, IMissionNodePosition } from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { resolveAdeNodeColorHex } from '../../../../platform/ade/common/adeNodeColors.js';
import { IOrchDeptBounds, svgEl } from './adeMissionCanvasEdgeRouter.js';
import { sanitizeCssSlug } from './adeMissionOrchCardBuilder.js';
import { getMissionNodeSize } from './adeMissionTaskCardBuilder.js';

const MINIMAP_VB_W = 200;
const MINIMAP_VB_H = 120;
const MINIMAP_PAD_WORLD = 140;

export interface IMissionMinimapCallbacks {
	onNavigateToWorldCenter(worldX: number, worldY: number): void;
}

export interface IMissionMinimapSyncOptions {
	readonly nodeStates?: Readonly<Record<string, string>>;
	readonly nodeSizeOverride?: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
	readonly nodeColors?: Readonly<Record<string, string | undefined>>;
	readonly criticalNodeIds?: ReadonlySet<string>;
	readonly criticalEdgeKeys?: ReadonlySet<string>;
	readonly readyNodeIds?: ReadonlySet<string>;
	readonly conflictNodeIds?: ReadonlySet<string>;
	readonly whiteboardNodeIds?: ReadonlySet<string>;
	readonly departmentBounds?: readonly IOrchDeptBounds[];
}

/**
 * Interactive bottom-right Mission DAG & Orchestration Minimap:
 * - Renders lightweight color-coded SVG overview of department regions, nodes, and edges.
 * - Uses incremental in-place DOM patching so live state/selection ticks avoid full SVG rebuilds.
 * - Tracks visible canvas viewport in O(1), hides phantom off-map boxes, and preserves grab-offset
 *   when dragging from inside the viewport frame.
 */
export class AdeMissionMinimap extends Disposable {
	private readonly containerEl: HTMLElement;
	private readonly svgEl: SVGSVGElement;
	private readonly deptsLayerEl: SVGGElement;
	private readonly edgesLayerEl: SVGGElement;
	private readonly nodesLayerEl: SVGGElement;
	private readonly viewportRectEl: SVGRectElement;
	private readonly dragDisposables = this._register(new DisposableStore());

	private readonly deptRectById = new Map<string, SVGRectElement>();
	private readonly edgeLineById = new Map<string, SVGLineElement>();
	private readonly nodeRectById = new Map<string, SVGRectElement>();

	private userVisible = true;
	private hasGraphNodes = false;
	private dragging = false;
	private dragGrabOffsetWorldX = 0;
	private dragGrabOffsetWorldY = 0;

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
			preserveAspectRatio: 'xMidYMid meet',
		});
		this.deptsLayerEl = svgEl('g', { class: 'ade-mission-minimap-depts' });
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
		this.svgEl.appendChild(this.deptsLayerEl);
		this.svgEl.appendChild(this.edgesLayerEl);
		this.svgEl.appendChild(this.nodesLayerEl);
		this.svgEl.appendChild(this.viewportRectEl);
		this.containerEl.appendChild(this.svgEl);

		const clientPointToWorld = (clientX: number, clientY: number): { readonly worldX: number; readonly worldY: number; readonly vbX: number; readonly vbY: number } | undefined => {
			const rect = this.svgEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0 || this.boundsScale <= 0) {
				return undefined;
			}
			// Exact inverse projection for `preserveAspectRatio="xMidYMid meet"`
			const fitScale = Math.min(rect.width / MINIMAP_VB_W, rect.height / MINIMAP_VB_H);
			if (fitScale <= 0) {
				return undefined;
			}
			const renderedW = MINIMAP_VB_W * fitScale;
			const renderedH = MINIMAP_VB_H * fitScale;
			const padLeft = (rect.width - renderedW) / 2;
			const padTop = (rect.height - renderedH) / 2;
			const vbX = Math.max(0, Math.min(MINIMAP_VB_W, (clientX - rect.left - padLeft) / fitScale));
			const vbY = Math.max(0, Math.min(MINIMAP_VB_H, (clientY - rect.top - padTop) / fitScale));
			const worldX = this.boundsMinX + (vbX - this.boundsOffsetX) / this.boundsScale;
			const worldY = this.boundsMinY + (vbY - this.boundsOffsetY) / this.boundsScale;
			return { worldX, worldY, vbX, vbY };
		};

		const navigateAtClientPoint = (clientX: number, clientY: number, applyGrabOffset: boolean): void => {
			const pt = clientPointToWorld(clientX, clientY);
			if (!pt) {
				return;
			}
			const wx = applyGrabOffset ? (pt.worldX - this.dragGrabOffsetWorldX) : pt.worldX;
			const wy = applyGrabOffset ? (pt.worldY - this.dragGrabOffsetWorldY) : pt.worldY;
			this.callbacks.onNavigateToWorldCenter(wx, wy);
		};

		const stopDrag = (e?: PointerEvent) => {
			if (!this.dragging) {
				return;
			}
			this.dragging = false;
			this.dragGrabOffsetWorldX = 0;
			this.dragGrabOffsetWorldY = 0;
			this.dragDisposables.clear();
			if (e) {
				try {
					if (this.containerEl.hasPointerCapture?.(e.pointerId)) {
						this.containerEl.releasePointerCapture(e.pointerId);
					}
				} catch { /* ignore */ }
			}
		};

		this._register(addDisposableListener(this.containerEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.stopPropagation();
			const pt = clientPointToWorld(e.clientX, e.clientY);
			if (!pt) {
				return;
			}
			this.dragging = true;
			this.dragGrabOffsetWorldX = 0;
			this.dragGrabOffsetWorldY = 0;

			// If pointer lands inside the existing viewport rect, preserve grab offset like Figma/xyflow!
			if (this.lastZoom > 0 && this.lastViewportW > 0 && this.lastViewportH > 0) {
				const curCenterX = (-this.lastPanX + this.lastViewportW / 2) / this.lastZoom;
				const curCenterY = (-this.lastPanY + this.lastViewportH / 2) / this.lastZoom;
				const halfW = (this.lastViewportW / this.lastZoom) / 2;
				const halfH = (this.lastViewportH / this.lastZoom) / 2;
				if (
					pt.worldX >= curCenterX - halfW
					&& pt.worldX <= curCenterX + halfW
					&& pt.worldY >= curCenterY - halfH
					&& pt.worldY <= curCenterY + halfH
				) {
					this.dragGrabOffsetWorldX = pt.worldX - curCenterX;
					this.dragGrabOffsetWorldY = pt.worldY - curCenterY;
				} else {
					this.callbacks.onNavigateToWorldCenter(pt.worldX, pt.worldY);
				}
			} else {
				this.callbacks.onNavigateToWorldCenter(pt.worldX, pt.worldY);
			}

			try {
				this.containerEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic events */ }

			// Window-level fallback ensures drag never gets stuck even if pointer capture is unsupported!
			const win = getWindow(this.containerEl);
			this.dragDisposables.clear();
			this.dragDisposables.add(addDisposableListener(win, EventType.POINTER_MOVE, (mv: PointerEvent) => {
				if (!this.dragging) {
					return;
				}
				mv.stopPropagation();
				navigateAtClientPoint(mv.clientX, mv.clientY, true);
			}));
			this.dragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, (upEv: PointerEvent) => stopDrag(upEv)));
			this.dragDisposables.add(addDisposableListener(win, 'pointercancel', (cEv: PointerEvent) => stopDrag(cEv)));
			this.dragDisposables.add(addDisposableListener(win, EventType.BLUR, () => stopDrag()));
		}));
		this._register(addDisposableListener(this.containerEl, 'lostpointercapture', () => stopDrag()));
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
		options?: IMissionMinimapSyncOptions,
	): void {
		this.hasGraphNodes = nodes.length > 0;
		this.containerEl.hidden = !this.userVisible || !this.hasGraphNodes;

		if (!this.hasGraphNodes) {
			this.clearLayers();
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
			const sz = options?.nodeSizeOverride?.get(node.id) ?? getMissionNodeSize(node);
			sizeById.set(node.id, sz);
			minX = Math.min(minX, pos.x - sz.width / 2);
			maxX = Math.max(maxX, pos.x + sz.width / 2);
			minY = Math.min(minY, pos.y - sz.height / 2);
			maxY = Math.max(maxY, pos.y + sz.height / 2);
		}
		for (const dept of options?.departmentBounds ?? []) {
			minX = Math.min(minX, dept.minX);
			maxX = Math.max(maxX, dept.maxX);
			minY = Math.min(minY, dept.minY);
			maxY = Math.max(maxY, dept.maxY);
		}
		if (!Number.isFinite(minX)) {
			this.hasGraphNodes = false;
			this.containerEl.hidden = true;
			this.clearLayers();
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

		// 1. Subtle department bounding frames (in-place diff)
		const seenDepts = new Set<string>();
		for (const dept of options?.departmentBounds ?? []) {
			seenDepts.add(dept.id);
			let rect = this.deptRectById.get(dept.id);
			if (!rect) {
				rect = svgEl('rect', { class: 'ade-mission-minimap-dept', 'data-minimap-dept': dept.id, rx: '3', ry: '3' });
				this.deptsLayerEl.appendChild(rect);
				this.deptRectById.set(dept.id, rect);
			}
			const x = toX(dept.minX);
			const y = toY(dept.minY);
			const w = Math.max(4, (dept.maxX - dept.minX) * this.boundsScale);
			const h = Math.max(4, (dept.maxY - dept.minY) * this.boundsScale);
			rect.setAttribute('x', x.toFixed(1));
			rect.setAttribute('y', y.toFixed(1));
			rect.setAttribute('width', w.toFixed(1));
			rect.setAttribute('height', h.toFixed(1));
			if (dept.colorHex) {
				rect.style.stroke = dept.colorHex;
			} else {
				rect.style.removeProperty('stroke');
			}
		}
		for (const [id, el] of [...this.deptRectById.entries()]) {
			if (!seenDepts.has(id)) {
				el.remove();
				this.deptRectById.delete(id);
			}
		}

		// 2. Edges (in-place diff)
		const seenEdges = new Set<string>();
		for (const edge of edges) {
			const fp = positions.get(edge.from);
			const tp = positions.get(edge.to);
			if (!fp || !tp) {
				continue;
			}
			seenEdges.add(edge.id);
			const isFail = getMissionEdgeKind(edge) === 'fail';
			const isCritical = Boolean(options?.criticalEdgeKeys?.has(`${edge.from}->${edge.to}`));
			const cls = `ade-mission-minimap-edge${isFail ? ' is-fail' : ''}${isCritical ? ' is-critical' : ''}`;
			let line = this.edgeLineById.get(edge.id);
			if (!line) {
				line = svgEl('line', { class: cls });
				this.edgesLayerEl.appendChild(line);
				this.edgeLineById.set(edge.id, line);
			} else if (line.getAttribute('class') !== cls) {
				line.setAttribute('class', cls);
			}
			line.setAttribute('x1', toX(fp.x).toFixed(1));
			line.setAttribute('y1', toY(fp.y).toFixed(1));
			line.setAttribute('x2', toX(tp.x).toFixed(1));
			line.setAttribute('y2', toY(tp.y).toFixed(1));
		}
		for (const [id, el] of [...this.edgeLineById.entries()]) {
			if (!seenEdges.has(id)) {
				el.remove();
				this.edgeLineById.delete(id);
			}
		}

		// 3. Nodes (in-place diff; strictly preserves `data-minimap-shape="rect"` on non-gate cards!)
		const seenNodes = new Set<string>();
		for (const node of nodes) {
			const pos = positions.get(node.id);
			const sz = sizeById.get(node.id);
			if (!pos || !sz) {
				continue;
			}
			seenNodes.add(node.id);
			const isWhiteboard = Boolean(options?.whiteboardNodeIds?.has(node.id));
			const isReady = Boolean(options?.readyNodeIds?.has(node.id));
			const isCritical = Boolean(options?.criticalNodeIds?.has(node.id));
			const isConflict = Boolean(options?.conflictNodeIds?.has(node.id));
			const rawState = options?.nodeStates?.[node.id] ?? runtimeState?.nodeStates[node.id] ?? 'idle';
			const effState = (rawState === 'idle' || rawState === 'pending') && isReady ? 'ready' : rawState;
			const cls = [
				'ade-mission-minimap-node',
				isWhiteboard ? 'kind-whiteboard' : `kind-${sanitizeCssSlug(node.kind)}`,
				`state-${sanitizeCssSlug(effState.replace(/_/g, '-'))}`,
				isCritical ? 'is-critical' : '',
				isConflict ? 'is-conflict' : '',
				selectedNodeId === node.id ? 'is-selected' : '',
			].filter(Boolean).join(' ');
			const w = Math.max(7, sz.width * this.boundsScale);
			const h = Math.max(4.5, sz.height * this.boundsScale);
			const customHex = resolveAdeNodeColorHex(options?.nodeColors?.[node.id] ?? node.color);
			const minimapShape = node.kind === 'gate' ? 'gate' : 'rect';
			const rxVal = node.kind === 'gate' ? '3' : '2.2';

			let rect = this.nodeRectById.get(node.id);
			if (!rect) {
				rect = svgEl('rect', {
					class: cls,
					'data-minimap-node': node.id,
					'data-minimap-shape': minimapShape,
					rx: rxVal,
					ry: rxVal,
				});
				this.nodesLayerEl.appendChild(rect);
				this.nodeRectById.set(node.id, rect);
			} else {
				if (rect.getAttribute('class') !== cls) {
					rect.setAttribute('class', cls);
				}
				if (rect.getAttribute('data-minimap-shape') !== minimapShape) {
					rect.setAttribute('data-minimap-shape', minimapShape);
				}
			}
			if (isWhiteboard) {
				rect.setAttribute('data-minimap-kind', 'whiteboard');
			} else {
				rect.removeAttribute('data-minimap-kind');
			}
			rect.setAttribute('x', (toX(pos.x) - w / 2).toFixed(1));
			rect.setAttribute('y', (toY(pos.y) - h / 2).toFixed(1));
			rect.setAttribute('width', w.toFixed(1));
			rect.setAttribute('height', h.toFixed(1));
			if (customHex) {
				rect.style.fill = customHex;
				rect.style.fillOpacity = effState === 'active' || effState === 'completed' ? '0.92' : '0.68';
				rect.style.stroke = customHex;
			} else {
				rect.style.removeProperty('fill');
				rect.style.removeProperty('fill-opacity');
				rect.style.removeProperty('stroke');
			}
		}
		for (const [id, el] of [...this.nodeRectById.entries()]) {
			if (!seenNodes.has(id)) {
				el.remove();
				this.nodeRectById.delete(id);
			}
		}

		this.updateViewport(this.lastPanX, this.lastPanY, this.lastZoom, this.lastViewportW, this.lastViewportH);
	}

	private clearLayers(): void {
		this.deptRectById.clear();
		this.edgeLineById.clear();
		this.nodeRectById.clear();
		for (const layer of [this.deptsLayerEl, this.edgesLayerEl, this.nodesLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}
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

		// Hide viewport indicator cleanly when viewport has zero intersection with minimap bounds (no phantom border box!)
		if (rawX + rawW <= 0 || rawX >= MINIMAP_VB_W || rawY + rawH <= 0 || rawY >= MINIMAP_VB_H) {
			this.viewportRectEl.setAttribute('width', '0');
			this.viewportRectEl.setAttribute('height', '0');
			return;
		}

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
