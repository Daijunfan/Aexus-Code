/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	IAdeAgentNode,
	IAdeTicketSummaryCard,
	IAdeTicketTransferAnimationEvent,
	IAdeWhiteboard,
} from '../../../../platform/ade/common/adeModels.js';
import { ADE_NODE_COLOR_PRESETS, normalizeAdeNodeColor, resolveAdeNodeColorHex } from '../../../../platform/ade/common/adeNodeColors.js';
import {
	computeMissionWorldSize,
	getOrchestrationNodeSize,
	IMissionAlignGuide,
	IMissionNodePosition,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	OrchestrationAnchorSide,
	OrchestrationDirection,
	OrchestrationLayoutMode,
} from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { IAdeAgent } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import {
	AdeTicketFlowController,
	computeEmptyDeptFallbackPositions,
	IAdeTicketFlowClock,
	IOrchDeptBounds,
	IOrchDeptHandle,
	IOrchEdgesRenderContext,
	IRenderedEdgeHandle,
	renderOrchestrationDepartmentRegions,
	renderOrchestrationMultiAnchorEdges,
	svgEl,
} from './adeMissionCanvasEdgeRouter.js';
import { IAdeAgentContextUsage } from './adeContextUsageTracker.js';
import { AdeMissionHostCatalog } from './adeMissionHostCatalog.js';
import {
	buildOrchGraphDerivedIndex,
	buildOrchStaffCardDom,
	buildOrchWhiteboardCardDom,
	getRenderedOrchestrationNodeSize,
	IOrchCardBuildContext,
	IOrchStaffDomRefs,
	IOrchWhiteboardDomRefs,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	patchOrchStaffCardDom,
	patchOrchWhiteboardCardDom,
} from './adeMissionOrchCardBuilder.js';

export {
	ORCH_STAFF_CARD_WIDTH,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	getRenderedOrchestrationNodeSize,
};

export const ADE_CARD_INTERACTIVE_SELECTOR = [
	'button',
	'input',
	'textarea',
	'select',
	'a',
	'[role="button"]',
	'[contenteditable="true"]',
	'[data-ade-card-interactive="true"]',
	'.ade-mission-model-pill',
	'.ade-mission-thinking-tag',
	'.ade-mission-engine-pill',
	'.ade-mission-host-pill',
	'.ade-orch-card-edit-btn',
	'.ade-orch-open-chat-btn',
	'.ade-orch-wb-open-btn',
	'.ade-orch-anchor',
	'.ade-node-color-dot-btn',
	'.ade-glass-select-trigger',
	'.ade-glass-select-portal',
].join(', ');

const NODE_DRAG_THRESHOLD_PX = 5;
const CARD_DOUBLE_CLICK_WINDOW_MS = 320;
const CARD_DOUBLE_CLICK_MAX_JITTER_PX = 6;
const CARD_OPEN_DEDUP_MS = 200;

export interface IMissionCanvasRendererCallbacks {
	onHoverNode(nodeId: string | undefined): void;
	onOpenModelPopover(
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentModel?: string; readonly currentThinking?: string; readonly hostAlias?: string },
	): void;
	onOpenEffortPopover?(
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentThinking?: string; readonly hostAlias?: string },
	): void;
	onOpenEnginePopover(
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly hostAlias?: string; readonly currentModel?: string; readonly currentThinking?: string },
	): void;
	onOpenHostPopover?(
		nodeId: string,
		agent: IAdeAgent | undefined,
		rawHost: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly currentEngine?: string; readonly currentModel?: string; readonly currentThinking?: string },
	): void;
	onOpenStaffEditPopover?(node: IOrchestrationGraphNode, anchorEl: HTMLElement): void;
	onOpenAgentSession(agentId: string, openToSide: boolean): void;
	onStartNodeDrag(nodeId: string, e: PointerEvent): void;
	onDragNodeMove(nodeId: string, e: PointerEvent): void;
	onEndNodeDrag(nodeId: string, e: PointerEvent): void;
	getNodePosition(nodeId: string): IMissionNodePosition | undefined;
	getZoom(): number;
	onSelectNode?(nodeId: string | undefined, additive?: boolean): void;
	onHoverStaffEdge?(edgePairKey: string, clientX: number, clientY: number): void;
	onMoveStaffEdge?(edgePairKey: string, clientX: number, clientY: number): void;
	onLeaveStaffEdge?(edgePairKey: string): void;
	onClickStaffEdge?(edgePairKey: string, clientX: number, clientY: number): void;
	onRenameNode?(nodeId: string, nextTitle: string): void;
	onNodeContextMenu?(nodeId: string, label: string, kind: 'staff' | 'whiteboard', clientX: number, clientY: number): void;
	onOpenNodeColorPopover?(nodeId: string, label: string, currentColor: string | undefined, anchorEl: HTMLElement): void;
	onStartConnectDrag?(fromNodeId: string, e: PointerEvent, anchor?: { readonly side: OrchestrationAnchorSide; readonly slot: number }): void;
	onMoveConnectDrag?(e: PointerEvent): void;
	onEndConnectDrag?(e: PointerEvent): void;
	onOpenWhiteboardPopover?(whiteboard: IAdeWhiteboard, anchorEl: HTMLElement, options?: { readonly initialTag?: string }): void;
	onStartDepartmentDrag?(dept: IOrchestrationDepartmentGroup, memberNodeIds: readonly string[], e: PointerEvent, emptyCenter?: IMissionNodePosition): void;
	onMoveDepartmentDrag?(e: PointerEvent): void;
	onEndDepartmentDrag?(e: PointerEvent): void;
	onDepartmentContextMenu?(dept: IOrchestrationDepartmentGroup, clientX: number, clientY: number): void;
	onCreateSoleTopRoleFromEmptyHint?(): void;
}

export interface IMissionCanvasRenderSnapshot {
	readonly direction: OrchestrationDirection;
	readonly layoutMode?: OrchestrationLayoutMode;
	readonly nodes: readonly IOrchestrationGraphNode[];
	readonly edges: readonly IOrchestrationGraphEdge[];
	readonly departments: readonly IOrchestrationDepartmentGroup[];
	readonly positions: ReadonlyMap<string, IMissionNodePosition>;
	readonly agentNodesById: ReadonlyMap<string, IAdeAgentNode>;
	readonly whiteboardsById: ReadonlyMap<string, IAdeWhiteboard>;
	readonly tickets: readonly IAdeTicketSummaryCard[];
	readonly linkedAgentsById?: ReadonlyMap<string, IAdeAgent>;
	readonly liveChatStateByAgentId?: ReadonlyMap<string, 'idle' | 'working' | 'pending'>;
	readonly contextUsageByAgentId?: ReadonlyMap<string, IAdeAgentContextUsage>;
}

/**
 * Project Orchestration Canvas DOM & SVG Renderer:
 * - Preserves `344×188` staff cards, `276×164` whiteboard cards, nested department frames, and frosted-glass theme styling.
 * - Uses `markerUnits="userSpaceOnUse"` (`8.5×8.5`, `refX="8.8"`, `refY="5"`, `orient="auto-start-reverse"`)
 *   so dual arrowheads never inflate on selection and sit at `+5.66px` outside `344×188` card borders.
 * - Hosts `AdeTicketFlowController` (`<g class="ade-ticket-flow-layer">`) for strict 3000ms arc-length relay animations.
 */
export class AdeMissionCanvasRenderer extends Disposable {
	private readonly edgesSvgEl: SVGSVGElement;
	private readonly defsEl: SVGDefsElement;
	private readonly cloudTerritoriesLayerEl: SVGGElement;
	private readonly edgesLayerEl: SVGGElement;
	private readonly alignGuidesLayerEl: SVGGElement;
	private readonly connectPreviewPathEl: SVGPathElement;
	private readonly nodesLayerEl: HTMLElement;
	readonly ticketFlow: AdeTicketFlowController;

	private readonly graphDisposables = this._register(new DisposableStore());
	private readonly deptDisposables = this._register(new DisposableStore());
	private readonly edgeDisposables = this._register(new DisposableStore());
	private readonly inlineEditDisposables = this._register(new DisposableStore());
	private readonly emptyHintDisposables = this._register(new DisposableStore());

	private readonly orchStaffHandles = new Map<string, IOrchStaffDomRefs>();
	private readonly orchWbHandles = new Map<string, IOrchWhiteboardDomRefs>();
	private readonly orchAnchorButtons = new Map<string, HTMLButtonElement>();
	private readonly edgeHandles = new Map<string, IRenderedEdgeHandle>();
	private readonly edgeHandleByPairKey = new Map<string, IRenderedEdgeHandle>();
	private readonly deptHandles = new Map<string, IOrchDeptHandle>();
	private readonly deptPillRectById = new Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>();

	private lastStructureKey = '';
	private lastDepartmentBounds: readonly IOrchDeptBounds[] = [];
	private currentNodes: readonly IOrchestrationGraphNode[] = [];
	private currentEdges: readonly IOrchestrationGraphEdge[] = [];
	private currentDepartments: readonly IOrchestrationDepartmentGroup[] = [];
	private currentDirection: OrchestrationDirection = 'TD';
	private currentLayoutMode: OrchestrationLayoutMode | undefined;
	private readonly livePositions = new Map<string, IMissionNodePosition>();

	private selectedNodeIds = new Set<string>();
	private selectedEdgePairKey: string | undefined;
	private hoveredNodeId: string | undefined;
	private connectTargetNodeId: string | undefined;

	constructor(
		private readonly worldEl: HTMLElement,
		private readonly emptyHintEl: HTMLElement,
		private readonly hostCatalog: AdeMissionHostCatalog,
		private readonly callbacks: IMissionCanvasRendererCallbacks,
		flowClock?: IAdeTicketFlowClock,
	) {
		super();

		this.edgesSvgEl = svgEl('svg', {
			class: 'ade-mission-edges-svg',
			width: '1280',
			height: '820',
		});
		this.defsEl = this.buildSvgMarkers();
		this.edgesSvgEl.appendChild(this.defsEl);

		this.cloudTerritoriesLayerEl = svgEl('g', { class: 'ade-mission-cloud-territories' });
		this.edgesSvgEl.appendChild(this.cloudTerritoriesLayerEl);

		this.edgesLayerEl = svgEl('g', { class: 'ade-mission-edges-layer' });
		this.edgesSvgEl.appendChild(this.edgesLayerEl);

		// Top-level `<g class="ade-ticket-flow-layer">` particle pool — never cleared during topology incremental syncs!
		this.ticketFlow = this._register(new AdeTicketFlowController(
			this.edgesSvgEl,
			pairKey => this.edgeHandleByPairKey.get(pairKey),
			() => this.edgeHandles.values(),
			flowClock,
		));

		this.alignGuidesLayerEl = svgEl('g', { class: 'ade-mission-align-guides-layer' });
		this.edgesSvgEl.appendChild(this.alignGuidesLayerEl);

		this.connectPreviewPathEl = svgEl('path', {
			class: 'ade-mission-connect-preview',
			d: '',
		});
		this.connectPreviewPathEl.style.display = 'none';
		this.edgesSvgEl.appendChild(this.connectPreviewPathEl);

		this.worldEl.appendChild(this.edgesSvgEl);
		this.nodesLayerEl = append(this.worldEl, $('.ade-mission-nodes-layer'));
	}

	/**
	 * Strictly constant world-pixel bidirectional arrowheads (`plan.md` §8.2.1):
	 * - `markerUnits="userSpaceOnUse"`, `viewBox="0 0 10 10"`, `markerWidth="8.5"`, `markerHeight="8.5"`,
	 *   `refX="8.8"`, `refY="5"`, `orient="auto-start-reverse"`.
	 * - Tip protrudes `0.34px` past endpoint (`outset = 6` -> `+5.66px` from `344×188` card border, `+1.66px` outside `+4.0px` ring).
	 * - Never inflates when selected stroke widens from `1.75px` to `2.8px`.
	 */
	private buildSvgMarkers(): SVGDefsElement {
		const defs = svgEl('defs');
		const specs: readonly { readonly id: string; readonly color: string }[] = [
			{ id: 'ade-mission-arrow-default', color: '#38bdf8' },
			{ id: 'ade-mission-arrow-bidir', color: '#38bdf8' },
			{ id: 'ade-mission-arrow-active', color: '#38bdf8' },
			{ id: 'ade-mission-arrow-out', color: '#34d399' },
			...ADE_NODE_COLOR_PRESETS.map(p => ({
				id: `ade-mission-arrow-preset-${p.id}`,
				color: p.hex,
			})),
		];
		for (const spec of specs) {
			const marker = svgEl('marker', {
				id: spec.id,
				viewBox: '0 0 10 10',
				refX: '8.8',
				refY: '5',
				markerUnits: 'userSpaceOnUse',
				markerWidth: '8.5',
				markerHeight: '8.5',
				orient: 'auto-start-reverse',
			});
			marker.appendChild(svgEl('path', {
				d: 'M 0.6 1.3 L 9.2 5 L 0.6 8.7 L 2.5 5 z',
				fill: spec.color,
			}));
			defs.appendChild(marker);
		}
		return defs;
	}

	getEdgesSvgElement(): SVGSVGElement {
		return this.edgesSvgEl;
	}

	getEdgeHandleByPairKey(edgePairKey: string): IRenderedEdgeHandle | undefined {
		return this.edgeHandleByPairKey.get(edgePairKey);
	}

	getAllEdgeHandles(): readonly IRenderedEdgeHandle[] {
		return [...this.edgeHandles.values()];
	}

	getCardElement(nodeId: string): HTMLElement | undefined {
		return this.orchStaffHandles.get(nodeId)?.cardEl ?? this.orchWbHandles.get(nodeId)?.cardEl;
	}

	getLastDepartmentBounds(): readonly IOrchDeptBounds[] {
		return this.lastDepartmentBounds;
	}

	triggerTicketTransferAnimation(event: IAdeTicketTransferAnimationEvent): boolean {
		return this.ticketFlow.triggerTransfer(event);
	}

	setSelectedState(nodeIds: ReadonlySet<string>, edgePairKey: string | undefined): void {
		this.selectedNodeIds = new Set(nodeIds);
		this.selectedEdgePairKey = edgePairKey;
		for (const [id, refs] of this.orchStaffHandles) {
			const sel = this.selectedNodeIds.has(id);
			refs.rootEl.classList.toggle('is-selected', sel);
			if (sel) {
				refs.rootEl.setAttribute('data-node-selected', 'true');
			} else {
				refs.rootEl.removeAttribute('data-node-selected');
			}
		}
		for (const [id, refs] of this.orchWbHandles) {
			const sel = this.selectedNodeIds.has(id);
			refs.rootEl.classList.toggle('is-selected', sel);
			if (sel) {
				refs.rootEl.setAttribute('data-node-selected', 'true');
			} else {
				refs.rootEl.removeAttribute('data-node-selected');
			}
		}
		for (const handle of this.edgeHandles.values()) {
			if (handle.isWhiteboardLink) {
				continue;
			}
			const isSel = Boolean(edgePairKey && handle.edgePairKey === edgePairKey);
			handle.group.classList.toggle('is-selected', isSel);
			if (isSel) {
				handle.group.setAttribute('data-edge-selected', 'true');
				handle.path.setAttribute('marker-start', 'url(#ade-mission-arrow-active)');
				handle.path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
			} else {
				handle.group.removeAttribute('data-edge-selected');
				if (handle.baseMarkerStart) {
					handle.path.setAttribute('marker-start', handle.baseMarkerStart);
				}
				if (handle.baseMarkerEnd) {
					handle.path.setAttribute('marker-end', handle.baseMarkerEnd);
				}
			}
		}
	}

	setHoveredNode(nodeId: string | undefined): void {
		this.hoveredNodeId = nodeId;
		this.worldEl.classList.toggle('has-node-hover', Boolean(nodeId));
		const neighborNodeIds = new Set<string>();
		const upstreamNodeIds = new Set<string>();
		const downstreamNodeIds = new Set<string>();
		if (nodeId) {
			for (const e of this.currentEdges) {
				if (e.from === nodeId) {
					neighborNodeIds.add(e.to);
					downstreamNodeIds.add(e.to);
				} else if (e.to === nodeId) {
					neighborNodeIds.add(e.from);
					upstreamNodeIds.add(e.from);
				}
			}
		}
		for (const [id, refs] of this.orchStaffHandles) {
			refs.rootEl.classList.toggle('is-hovered', id === nodeId);
			refs.rootEl.classList.toggle('is-neighbor', neighborNodeIds.has(id));
			refs.rootEl.classList.toggle('is-upstream', upstreamNodeIds.has(id));
			refs.rootEl.classList.toggle('is-downstream', downstreamNodeIds.has(id));
		}
		for (const [id, refs] of this.orchWbHandles) {
			refs.rootEl.classList.toggle('is-hovered', id === nodeId);
			refs.rootEl.classList.toggle('is-wb-neighbor', neighborNodeIds.has(id));
		}
		for (const handle of this.edgeHandles.values()) {
			const isOutgoing = Boolean(nodeId && handle.fromId === nodeId);
			const isIncoming = Boolean(nodeId && handle.toId === nodeId);
			const connected = isOutgoing || isIncoming;
			handle.group.classList.toggle('is-hover-path', connected);
			handle.group.classList.toggle('is-hover-flow', connected);
			handle.group.classList.toggle('is-outgoing', isOutgoing);
			handle.group.classList.toggle('is-incoming', isIncoming && !isOutgoing);
			if (connected && handle.group.parentNode === this.edgesLayerEl && this.edgesLayerEl.lastElementChild !== handle.group) {
				this.edgesLayerEl.appendChild(handle.group);
			}
		}
	}

	setConnectPreview(
		pathD: string | undefined,
		targetNodeId?: string,
	): void {
		if (this.connectTargetNodeId && this.connectTargetNodeId !== targetNodeId) {
			const prev = this.orchStaffHandles.get(this.connectTargetNodeId)?.rootEl
				?? this.orchWbHandles.get(this.connectTargetNodeId)?.rootEl;
			prev?.classList.remove('is-connect-target');
		}
		this.connectTargetNodeId = targetNodeId;
		if (targetNodeId) {
			const next = this.orchStaffHandles.get(targetNodeId)?.rootEl
				?? this.orchWbHandles.get(targetNodeId)?.rootEl;
			next?.classList.add('is-connect-target');
		}
		if (pathD) {
			this.worldEl.classList.add('is-connecting-edge');
			this.connectPreviewPathEl.setAttribute('d', pathD);
			this.connectPreviewPathEl.style.display = '';
		} else {
			this.worldEl.classList.remove('is-connecting-edge');
			this.connectPreviewPathEl.setAttribute('d', '');
			this.connectPreviewPathEl.style.display = 'none';
		}
	}

	renderSnapGuides(guides: readonly IMissionAlignGuide[]): void {
		while (this.alignGuidesLayerEl.firstChild) {
			this.alignGuidesLayerEl.removeChild(this.alignGuidesLayerEl.firstChild);
		}
		for (const g of guides) {
			const line = svgEl('line', {
				class: 'ade-mission-align-guide',
				x1: String(g.axis === 'x' ? g.coord : g.start),
				y1: String(g.axis === 'x' ? g.start : g.coord),
				x2: String(g.axis === 'x' ? g.coord : g.end),
				y2: String(g.axis === 'x' ? g.end : g.coord),
			});
			this.alignGuidesLayerEl.appendChild(line);
		}
	}

	/**
	 * Fast O(degree) incremental card & route update during interactive dragging.
	 * Active 3000ms Ticket flow particles immediately adhere to the updated path on the exact same frame!
	 */
	updateDraggedNodesPositions(updatedPositions: ReadonlyMap<string, IMissionNodePosition>, primaryMovedNodeId?: string): void {
		for (const [id, pos] of updatedPositions.entries()) {
			this.livePositions.set(id, pos);
			const staff = this.orchStaffHandles.get(id);
			if (staff) {
				staff.rootEl.style.left = `${pos.x}px`;
				staff.rootEl.style.top = `${pos.y}px`;
			}
			const wb = this.orchWbHandles.get(id);
			if (wb) {
				wb.rootEl.style.left = `${pos.x}px`;
				wb.rootEl.style.top = `${pos.y}px`;
			}
		}

		this.syncWorldCanvasBounds();
		this.lastDepartmentBounds = renderOrchestrationDepartmentRegions(
			this.currentNodes,
			this.currentDepartments,
			this.livePositions,
			{
				cloudTerritoriesLayerEl: this.cloudTerritoriesLayerEl,
				deptDisposables: this.deptDisposables,
				deptHandles: this.deptHandles,
				deptPillRectById: this.deptPillRectById,
				bindDepartmentPillInteractions: (pg, gd, gm, ge) => this.bindDepartmentPillInteractions(pg, gd, gm, ge),
			},
			false,
		);
		renderOrchestrationMultiAnchorEdges(
			this.currentNodes,
			this.currentEdges,
			this.livePositions,
			this.currentDirection,
			this.currentLayoutMode,
			this.createEdgesRenderContext(),
			{
				forceRebuild: false,
				movedNodeId: updatedPositions.size === 1 ? primaryMovedNodeId : undefined,
			},
		);
		if (this.hoveredNodeId) {
			this.setHoveredNode(this.hoveredNodeId);
		}
		if (this.ticketFlow.getActiveCount() > 0) {
			this.ticketFlow.reconcileNow();
		}
	}

	syncGraph(snapshot: IMissionCanvasRenderSnapshot, forceRebuild = false): void {
		const {
			direction,
			layoutMode,
			nodes,
			edges,
			departments,
			positions,
			agentNodesById,
			whiteboardsById,
			tickets,
			linkedAgentsById,
			liveChatStateByAgentId,
			contextUsageByAgentId,
		} = snapshot;

		this.currentNodes = nodes;
		this.currentEdges = edges;
		this.currentDepartments = departments;
		this.currentDirection = direction;
		this.currentLayoutMode = layoutMode;
		this.livePositions.clear();
		for (const [id, p] of positions.entries()) {
			this.livePositions.set(id, p);
		}

		this.worldEl.classList.toggle('dir-td', direction === 'TD');
		this.worldEl.classList.toggle('dir-lr', direction === 'LR');

		const staffCount = nodes.filter(n => n.kind === 'staff').length;
		if (nodes.length === 0) {
			this.clearCanvasDom();
			this.renderEmptySoleL1Hint();
			return;
		}
		if (staffCount === 0) {
			this.renderEmptySoleL1Hint();
		} else {
			this.emptyHintDisposables.clear();
			this.emptyHintEl.hidden = true;
			clearNode(this.emptyHintEl);
		}

		const nextStructureKey = JSON.stringify({
			direction,
			layoutMode: layoutMode ?? '',
			nodes: nodes.map(n => `${n.id}:${n.kind}`),
			edges: edges.map(e => `${e.id}:${e.from}->${e.to}:${Boolean(e.isWhiteboardLink)}`),
			depts: departments.map(d => d.id),
		});
		const mustRebuildNodes = forceRebuild || nextStructureKey !== this.lastStructureKey;
		this.lastStructureKey = nextStructureKey;

		if (mustRebuildNodes) {
			this.inlineEditDisposables.clear();
			this.graphDisposables.clear();
			this.orchStaffHandles.clear();
			this.orchWbHandles.clear();
			this.orchAnchorButtons.clear();
			clearNode(this.nodesLayerEl);
		}

		this.syncWorldCanvasBounds();

		const derived = buildOrchGraphDerivedIndex(edges, tickets);
		const activeStaffNodeIds = new Set<string>();
		for (const n of nodes) {
			if (n.kind === 'staff') {
				const chatSt = liveChatStateByAgentId?.get(n.id);
				if (chatSt === 'working' || (derived.heldTicketsByAgent.get(n.id)?.length ?? 0) > 0) {
					activeStaffNodeIds.add(n.id);
				}
			}
		}

		// 1. Nested Department Regions
		this.lastDepartmentBounds = renderOrchestrationDepartmentRegions(
			nodes,
			departments,
			this.livePositions,
			{
				cloudTerritoriesLayerEl: this.cloudTerritoriesLayerEl,
				deptDisposables: this.deptDisposables,
				deptHandles: this.deptHandles,
				deptPillRectById: this.deptPillRectById,
				activeStaffNodeIds,
				bindDepartmentPillInteractions: (pg, gd, gm, ge) => this.bindDepartmentPillInteractions(pg, gd, gm, ge),
			},
			mustRebuildNodes,
		);

		// 2. Staff (`344×188`) & Whiteboard (`276×164`) Cards
		const cardBuildCtx = this.createCardBuildContext();
		for (const oNode of nodes) {
			const pos = this.livePositions.get(oNode.id) ?? { x: 340, y: 240 };
			if (oNode.kind === 'whiteboard') {
				const wb = whiteboardsById.get(oNode.id) ?? {
					board_id: oNode.id,
					project_id: '',
					name: oNode.label,
					owner_id: oNode.ownerId ?? null,
					dept_id: oNode.departmentId ?? null,
					storage_host: oNode.storageHost ?? 'local',
					migration_state: 'idle',
					migration_epoch: 0,
					tag_categories: oNode.tagCategories ?? [],
					created_at: 0,
					updated_at: 0,
				};
				const existingWb = !mustRebuildNodes ? this.orchWbHandles.get(oNode.id) : undefined;
				if (existingWb) {
					patchOrchWhiteboardCardDom(existingWb, { oNode, pos, wb, derived }, cardBuildCtx);
				} else {
					const created = buildOrchWhiteboardCardDom({ oNode, pos, wb, derived }, cardBuildCtx);
					this.bindCardCommonInteractions(created.rootEl, created.cardEl, oNode);
					this.orchWbHandles.set(oNode.id, created);
				}
			} else {
				const agentNode = agentNodesById.get(oNode.id);
				const linkedAgent = linkedAgentsById?.get(oNode.id);
				const liveChatState = liveChatStateByAgentId?.get(oNode.id);
				const contextUsage = contextUsageByAgentId?.get(oNode.id);
				const existingStaff = !mustRebuildNodes ? this.orchStaffHandles.get(oNode.id) : undefined;
				if (existingStaff) {
					patchOrchStaffCardDom(existingStaff, { oNode, pos, agentNode, linkedAgent, liveChatState, contextUsage, derived }, cardBuildCtx);
				} else {
					const created = buildOrchStaffCardDom({ oNode, pos, agentNode, linkedAgent, liveChatState, contextUsage, derived }, cardBuildCtx);
					this.bindCardCommonInteractions(created.rootEl, created.cardEl, oNode);
					this.orchStaffHandles.set(oNode.id, created);
				}
			}
		}

		// 3. Forced Bidirectional Multi-Anchor Edges (`outset = 6` + `22px` rigid stubs)
		const edgeRenderResult = renderOrchestrationMultiAnchorEdges(
			nodes,
			edges,
			this.livePositions,
			direction,
			layoutMode,
			this.createEdgesRenderContext(),
			{ forceRebuild: mustRebuildNodes },
		);

		this.setSelectedState(this.selectedNodeIds, this.selectedEdgePairKey);
		if (this.hoveredNodeId) {
			this.setHoveredNode(this.hoveredNodeId);
		}
		if (edgeRenderResult.rebuilt) {
			this.ticketFlow.invalidateEdgeDomHandles();
		}
		if (this.ticketFlow.getActiveCount() > 0) {
			this.ticketFlow.reconcileNow();
		}
	}

	private renderEmptySoleL1Hint(): void {
		this.emptyHintDisposables.clear();
		clearNode(this.emptyHintEl);
		this.emptyHintEl.hidden = false;

		const card = append(this.emptyHintEl, $('.ade-empty-l1-onboarding-card', {
			'data-ade-empty-l1-guide': 'true',
		}));
		const iconWrap = append(card, $('.ade-empty-l1-icon-wrap'));
		append(iconWrap, $('span.codicon.codicon-organization'));

		append(card, $('.ade-empty-l1-title', {}, adeBi(
			localize('adeEmptyCanvasL1Title', "Initialize Project Organization Tree"),
			'初始化项目组织树（创建唯一顶层 L1 负责人）',
		)));
		append(card, $('.ade-empty-l1-desc', {}, adeBi(
			localize(
				'adeEmptyCanvasL1Desc',
				"Every Project starts with a single top-level L1 Lead (is_top_role = true). Select Host → Engine → Model → Effort → Name & Role Summary to bootstrap the reporting tree.",
			),
			'每个 Project 画布以唯一顶层 L1 负责人（is_top_role = true）为单父汇报树根节点。请按「主机 → 引擎 → 模型 → 思考档位 → 姓名与职责」五步创建 L1 节点，随后即可招募下属、划分部门与创建共享白板。',
		)));

		if (this.callbacks.onCreateSoleTopRoleFromEmptyHint) {
			const createBtn = append(card, $('button.ade-mission-token-action-btn.primary.ade-empty-l1-create-btn', {
				type: 'button',
				'data-ade-create-sole-l1': 'true',
			}, adeBi(
				localize('adeEmptyCanvasCreateL1Btn', "+ Create Top-Level L1 Lead"),
				'+ 创建唯一顶层 L1 负责人',
			))) as HTMLButtonElement;
			this.emptyHintDisposables.add(addDisposableListener(createBtn, EventType.POINTER_DOWN, e => e.stopPropagation()));
			this.emptyHintDisposables.add(addDisposableListener(createBtn, EventType.CLICK, e => {
				e.stopPropagation();
				this.callbacks.onCreateSoleTopRoleFromEmptyHint?.();
			}));
		}
	}

	private clearCanvasDom(): void {
		this.lastStructureKey = '';
		this.lastDepartmentBounds = [];
		this.inlineEditDisposables.clear();
		this.graphDisposables.clear();
		this.deptDisposables.clear();
		this.edgeDisposables.clear();
		this.orchStaffHandles.clear();
		this.orchWbHandles.clear();
		this.orchAnchorButtons.clear();
		this.edgeHandles.clear();
		this.edgeHandleByPairKey.clear();
		this.deptHandles.clear();
		this.deptPillRectById.clear();
		this.ticketFlow.clearAll();
		clearNode(this.nodesLayerEl);
		while (this.cloudTerritoriesLayerEl.firstChild) {
			this.cloudTerritoriesLayerEl.removeChild(this.cloudTerritoriesLayerEl.firstChild);
		}
		while (this.edgesLayerEl.firstChild) {
			this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
		}
	}

	private syncWorldCanvasBounds(): void {
		const combined = new Map<string, IMissionNodePosition>(this.livePositions);
		const emptyExtras = computeEmptyDeptFallbackPositions(this.currentNodes, this.currentDepartments, this.livePositions);
		emptyExtras.forEach((pt, idx) => combined.set(`__empty_dept_${idx}`, pt));
		const worldSize = computeMissionWorldSize(combined);
		this.worldEl.style.width = `${worldSize.width}px`;
		this.worldEl.style.height = `${worldSize.height}px`;
		this.edgesSvgEl.setAttribute('width', String(worldSize.width));
		this.edgesSvgEl.setAttribute('height', String(worldSize.height));
	}

	private applyCustomNodeColor(nodeEl: HTMLElement, rawColor: string | undefined): void {
		const norm = normalizeAdeNodeColor(rawColor);
		const hex = resolveAdeNodeColorHex(norm);
		if (hex) {
			nodeEl.classList.add('has-custom-color');
			nodeEl.style.setProperty('--ade-node-custom-color', hex);
		} else {
			nodeEl.classList.remove('has-custom-color');
			nodeEl.style.removeProperty('--ade-node-custom-color');
		}
	}

	private mountNodeColorTrigger(
		parentEl: HTMLElement,
		nodeId: string,
		label: string,
		rawColor: string | undefined,
		store: DisposableStore,
	): void {
		if (!this.callbacks.onOpenNodeColorPopover) {
			return;
		}
		const hex = resolveAdeNodeColorHex(rawColor);
		const btn = append(parentEl, $('button.ade-node-color-dot-btn', {
			type: 'button',
			'data-ade-card-interactive': 'true',
			'data-ade-node-color-btn': nodeId,
			title: adeBi(localize('adeNodeColorBtnTip', "Customize card accent color"), '自定义卡片主题颜色'),
		})) as HTMLButtonElement;
		if (hex) {
			btn.style.setProperty('--dot-color', hex);
			btn.classList.add('has-color');
		}
		store.add(addDisposableListener(btn, EventType.POINTER_DOWN, e => e.stopPropagation()));
		store.add(addDisposableListener(btn, EventType.DBLCLICK, e => e.stopPropagation()));
		store.add(addDisposableListener(btn, EventType.CLICK, e => {
			e.stopPropagation();
			this.callbacks.onOpenNodeColorPopover?.(nodeId, label, rawColor, btn);
		}));
	}

	private bindMultiAnchorConnectDrag(
		oNode: IOrchestrationGraphNode,
		anchorEl: HTMLButtonElement,
		side: OrchestrationAnchorSide,
		slot: number,
	): void {
		this.graphDisposables.add(addDisposableListener(anchorEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 || !this.callbacks.onStartConnectDrag) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			try {
				anchorEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic event */ }
			this.callbacks.onStartConnectDrag(oNode.id, e, { side, slot });
		}));
		this.graphDisposables.add(addDisposableListener(anchorEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			this.callbacks.onMoveConnectDrag?.(e);
		}));
		this.graphDisposables.add(addDisposableListener(anchorEl, EventType.POINTER_UP, (e: PointerEvent) => {
			try {
				if (anchorEl.hasPointerCapture?.(e.pointerId)) {
					anchorEl.releasePointerCapture(e.pointerId);
				}
			} catch { /* ignore */ }
			this.callbacks.onEndConnectDrag?.(e);
		}));
	}

	private bindDepartmentPillInteractions(
		pillGroup: SVGGElement,
		getDept: () => IOrchestrationDepartmentGroup,
		getMemberIds: () => readonly string[],
		getEmptyCenter: () => IMissionNodePosition | undefined,
	): void {
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 || !this.callbacks.onStartDepartmentDrag) {
				return;
			}
			e.stopPropagation();
			try {
				(pillGroup as unknown as Element).setPointerCapture?.(e.pointerId);
			} catch { /* ignore */ }
			this.callbacks.onStartDepartmentDrag(getDept(), getMemberIds(), e, getEmptyCenter());
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.POINTER_MOVE, (e: PointerEvent) => {
			this.callbacks.onMoveDepartmentDrag?.(e);
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.POINTER_UP, (e: PointerEvent) => {
			try {
				(pillGroup as unknown as Element).releasePointerCapture?.(e.pointerId);
			} catch { /* ignore */ }
			this.callbacks.onEndDepartmentDrag?.(e);
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!this.callbacks.onDepartmentContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.callbacks.onDepartmentContextMenu(getDept(), e.clientX, e.clientY);
		}));
	}

	private bindCardCommonInteractions(
		nodeEl: HTMLElement,
		cardEl: HTMLElement,
		oNode: IOrchestrationGraphNode,
	): void {
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerenter', () => {
			this.callbacks.onHoverNode(oNode.id);
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerleave', () => {
			if (this.hoveredNodeId === oNode.id) {
				this.callbacks.onHoverNode(undefined);
			}
		}));

		const gestureDisposables = this.graphDisposables.add(new DisposableStore());
		let downEvent: PointerEvent | undefined;
		let downClientX = 0;
		let downClientY = 0;
		let dragStarted = false;
		let movedDuringPress = false;
		let pointerSelectedThisGesture = false;
		let lastPrimaryClickAt = 0;
		let lastPrimaryClickX = 0;
		let lastPrimaryClickY = 0;
		let lastOpenedAt = 0;

		const openPrimaryCardTarget = (e: MouseEvent): void => {
			const now = Date.now();
			if (now - lastOpenedAt < CARD_OPEN_DEDUP_MS) {
				return;
			}
			lastOpenedAt = now;
			lastPrimaryClickAt = 0;
			if (oNode.kind === 'whiteboard') {
				const wbRef = this.orchWbHandles.get(oNode.id);
				if (wbRef) {
					this.callbacks.onOpenWhiteboardPopover?.(wbRef.whiteboard, cardEl);
				}
			} else {
				this.callbacks.onOpenAgentSession(oNode.id, Boolean(e.altKey || e.metaKey || e.ctrlKey));
			}
		};

		this.graphDisposables.add(addDisposableListener(cardEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			const target = e.target instanceof Element ? e.target : null;
			if (target?.closest(ADE_CARD_INTERACTIVE_SELECTOR)) {
				return;
			}
			e.stopPropagation();
			gestureDisposables.clear();
			downEvent = e;
			downClientX = e.clientX;
			downClientY = e.clientY;
			dragStarted = false;
			movedDuringPress = false;
			pointerSelectedThisGesture = true;
			this.callbacks.onSelectNode?.(oNode.id, e.shiftKey || e.metaKey || e.ctrlKey);

			const targetWin = getWindow(cardEl);
			const onPointerMove = (ev: PointerEvent) => {
				if (!downEvent || ev.pointerId !== downEvent.pointerId) {
					return;
				}
				const dist = Math.hypot(ev.clientX - downClientX, ev.clientY - downClientY);
				if (!dragStarted) {
					if (dist < NODE_DRAG_THRESHOLD_PX) {
						return;
					}
					dragStarted = true;
					movedDuringPress = true;
					lastPrimaryClickAt = 0;
					nodeEl.classList.add('dragging');
					try {
						cardEl.setPointerCapture(ev.pointerId);
					} catch { /* synthetic */ }
					this.callbacks.onStartNodeDrag(oNode.id, downEvent);
				}
				this.callbacks.onDragNodeMove(oNode.id, ev);
			};

			const finishGesture = (ev: PointerEvent) => {
				if (!downEvent || ev.pointerId !== downEvent.pointerId) {
					return;
				}
				gestureDisposables.clear();
				const wasDragging = dragStarted;
				dragStarted = false;
				downEvent = undefined;
				if (ev.type === 'pointercancel' || wasDragging) {
					pointerSelectedThisGesture = false;
				}
				if (!wasDragging) {
					return;
				}
				nodeEl.classList.remove('dragging');
				try {
					if (cardEl.hasPointerCapture?.(ev.pointerId)) {
						cardEl.releasePointerCapture(ev.pointerId);
					}
				} catch { /* ignore */ }
				this.callbacks.onEndNodeDrag(oNode.id, ev);
			};

			gestureDisposables.add(addDisposableListener(targetWin, EventType.POINTER_MOVE, onPointerMove));
			gestureDisposables.add(addDisposableListener(targetWin, EventType.POINTER_UP, finishGesture));
			gestureDisposables.add(addDisposableListener(targetWin, 'pointercancel', finishGesture));
		}));

		this.graphDisposables.add(addDisposableListener(cardEl, EventType.CLICK, (e: MouseEvent) => {
			const wasPointerSelected = pointerSelectedThisGesture;
			pointerSelectedThisGesture = false;
			if (movedDuringPress) {
				movedDuringPress = false;
				lastPrimaryClickAt = 0;
				return;
			}
			const target = e.target instanceof Element ? e.target : null;
			if (target?.closest(ADE_CARD_INTERACTIVE_SELECTOR)) {
				lastPrimaryClickAt = 0;
				return;
			}
			e.stopPropagation();
			const isAdditive = Boolean(e.shiftKey || e.metaKey || e.ctrlKey);
			if (!wasPointerSelected) {
				this.callbacks.onSelectNode?.(oNode.id, isAdditive);
			}
			if (isAdditive) {
				lastPrimaryClickAt = 0;
				return;
			}
			const now = Date.now();
			const isRapidSecondClick = lastPrimaryClickAt > 0
				&& (now - lastPrimaryClickAt <= CARD_DOUBLE_CLICK_WINDOW_MS)
				&& (Math.hypot(e.clientX - lastPrimaryClickX, e.clientY - lastPrimaryClickY) <= CARD_DOUBLE_CLICK_MAX_JITTER_PX);
			if (e.detail >= 2 || isRapidSecondClick) {
				openPrimaryCardTarget(e);
				return;
			}
			lastPrimaryClickAt = now;
			lastPrimaryClickX = e.clientX;
			lastPrimaryClickY = e.clientY;
		}));

		this.graphDisposables.add(addDisposableListener(cardEl, EventType.DBLCLICK, (e: MouseEvent) => {
			const target = e.target instanceof Element ? e.target : null;
			if (target?.closest(ADE_CARD_INTERACTIVE_SELECTOR)) {
				e.stopPropagation();
				return;
			}
			e.stopPropagation();
			openPrimaryCardTarget(e);
		}));

		this.graphDisposables.add(addDisposableListener(cardEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!this.callbacks.onNodeContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const curLabel = (oNode.kind === 'whiteboard'
				? this.orchWbHandles.get(oNode.id)?.whiteboard.name
				: this.orchStaffHandles.get(oNode.id)?.agentNode?.name) ?? oNode.label;
			this.callbacks.onNodeContextMenu(oNode.id, curLabel, oNode.kind, e.clientX, e.clientY);
		}));
	}

	startInlineNodeRename(nodeId: string): void {
		if (!this.callbacks.onRenameNode) {
			return;
		}
		const staffRef = this.orchStaffHandles.get(nodeId);
		const wbRef = this.orchWbHandles.get(nodeId);
		const titleEl = staffRef?.titleEl ?? wbRef?.titleEl;
		const currentLabel = staffRef?.agentNode?.name ?? wbRef?.whiteboard.name ?? this.currentNodes.find(n => n.id === nodeId)?.label;
		if (!titleEl || currentLabel === undefined) {
			return;
		}

		this.inlineEditDisposables.clear();
		clearNode(titleEl);
		const input = append(titleEl, $('input.ade-mission-inline-rename-input', {
			type: 'text',
			value: currentLabel,
			'data-ade-inline-rename': nodeId,
		})) as HTMLInputElement;

		let finished = false;
		const commit = (apply: boolean) => {
			if (finished) {
				return;
			}
			finished = true;
			const nextVal = input.value.trim();
			this.inlineEditDisposables.clear();
			titleEl.textContent = apply && nextVal ? nextVal : currentLabel;
			titleEl.title = titleEl.textContent;
			if (apply && nextVal && nextVal !== currentLabel) {
				this.callbacks.onRenameNode?.(nodeId, nextVal);
			}
		};

		this.inlineEditDisposables.add(addDisposableListener(input, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.inlineEditDisposables.add(addDisposableListener(input, EventType.CLICK, e => e.stopPropagation()));
		this.inlineEditDisposables.add(addDisposableListener(input, EventType.DBLCLICK, e => e.stopPropagation()));
		this.inlineEditDisposables.add(addDisposableListener(input, EventType.BLUR, () => commit(true)));
		this.inlineEditDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				commit(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				commit(false);
			}
		}));
		input.focus();
		input.select();
	}

	private createCardBuildContext(): IOrchCardBuildContext {
		return {
			nodesLayerEl: this.nodesLayerEl,
			graphDisposables: this.graphDisposables,
			hostCatalog: this.hostCatalog,
			orchAnchorButtons: this.orchAnchorButtons,
			applyCustomNodeColor: (el, c) => this.applyCustomNodeColor(el, c),
			mountNodeColorTrigger: (p, id, lbl, c, s) => this.mountNodeColorTrigger(p, id, lbl, c, s),
			bindMultiAnchorConnectDrag: (n, a, s, sl) => this.bindMultiAnchorConnectDrag(n, a, s, sl),
			startInlineNodeRename: id => this.startInlineNodeRename(id),
			onOpenWhiteboardPopover: this.callbacks.onOpenWhiteboardPopover,
			onOpenModelPopover: (id, ag, eng, anc, opts) => this.callbacks.onOpenModelPopover(id, ag, eng, anc, opts),
			onOpenEffortPopover: (id, ag, eng, anc, opts) => this.callbacks.onOpenEffortPopover?.(id, ag, eng, anc, opts),
			onOpenEnginePopover: (id, ag, eng, anc, opts) => this.callbacks.onOpenEnginePopover(id, ag, eng, anc, opts),
			onOpenHostPopover: (id, ag, host, anc, opts) => this.callbacks.onOpenHostPopover?.(id, ag, host, anc, opts),
			onOpenStaffEditPopover: this.callbacks.onOpenStaffEditPopover,
			onOpenAgentSession: (id, side) => this.callbacks.onOpenAgentSession(id, side),
			onRenameNodeAvailable: Boolean(this.callbacks.onRenameNode),
		};
	}

	private createEdgesRenderContext(): IOrchEdgesRenderContext {
		return {
			edgesLayerEl: this.edgesLayerEl,
			edgeDisposables: this.edgeDisposables,
			edgeHandles: this.edgeHandles,
			edgeHandleByPairKey: this.edgeHandleByPairKey,
			orchAnchorButtons: this.orchAnchorButtons,
			deptPillRectById: this.deptPillRectById,
			selectedEdgePairKey: this.selectedEdgePairKey,
			layoutMode: (this.currentLayoutMode === 'lr' || this.currentDirection === 'LR') ? 'LR' : 'TD',
			onHoverStaffEdge: this.callbacks.onHoverStaffEdge,
			onMoveStaffEdge: this.callbacks.onMoveStaffEdge,
			onLeaveStaffEdge: this.callbacks.onLeaveStaffEdge,
			onClickStaffEdge: this.callbacks.onClickStaffEdge,
			onClickWhiteboardLink: (boardId: string) => {
				const wbRef = this.orchWbHandles.get(boardId);
				if (wbRef) {
					this.callbacks.onOpenWhiteboardPopover?.(wbRef.whiteboard, wbRef.cardEl);
				}
			},
		};
	}
}

export function getMissionNodeSize(node: Pick<IOrchestrationGraphNode, 'kind'>): { readonly width: number; readonly height: number } {
	return getOrchestrationNodeSize(node);
}
