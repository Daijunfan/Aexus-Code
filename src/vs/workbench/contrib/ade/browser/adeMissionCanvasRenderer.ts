/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AdeThinkingLevel } from '../../../../platform/ade/common/adeEngineering.js';
import {
	computeMissionWorldSize,
	computeNodeDragSnapAlignment,
	getMissionEdgeKind,
	IMissionAlignGuide,
	IMissionAlignRect,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionEdgeObstacle,
	IMissionNodePosition,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	ADE_NODE_COLOR_PRESETS,
	normalizeAdeNodeColor,
	resolveAdeNodeColorHex,
} from '../../../../platform/ade/common/adeNodeColors.js';
import {
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	OrchestrationAnchorSide,
	OrchestrationLayoutMode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { IAdeOrganizationConfig } from '../../../../platform/ade/common/adeRoleSchema.js';
import { AdeEngineeringViewMode, IAdeAgent } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import { AdeMissionHostCatalog } from './adeMissionHostCatalog.js';
import {
	computeEmptyDeptFallbackPositions,
	IEdgeTransitBurst,
	ILivePuckHandle,
	IOrchDeptBounds,
	IOrchDeptHandle,
	IRenderedEdgeHandle,
	renderOrchestrationDepartmentRegions,
	svgEl,
	syncMissionEdgesSvg,
	syncOrchestrationEdgesSvg,
} from './adeMissionCanvasEdgeRouter.js';
import {
	buildOrchGraphDerivedIndex,
	buildOrchStaffCardDom,
	buildOrchWhiteboardCardDom,
	formatMissionBlockedRemaining,
	formatMissionWaveTag,
	getMissionWaveColorIndex,
	getRenderedOrchestrationNodeSize,
	IOrchCardBuildContext,
	IOrchGraphDerivedIndex,
	IOrchStaffDomRefs,
	IOrchWhiteboardDomRefs,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	patchOrchStaffCardDom,
	patchOrchWhiteboardCardDom,
} from './adeMissionOrchCardBuilder.js';
import {
	bindMissionOutPortConnectDrag,
	bindOrchMultiAnchorConnectDrag,
	buildMissionTaskCardDom,
	computeMissionTaskDagSignals,
	getMissionNodeSize,
	IConnectDragHost,
	IMissionDagTopologySignals,
	ITaskCardBuildContext,
	ITaskCardDomRefs,
	MISSION_GATE_CARD_HEIGHT,
	MISSION_GATE_CARD_WIDTH,
	MISSION_TASK_CARD_HEIGHT,
	MISSION_TASK_CARD_WIDTH,
	patchMissionTaskCardDom,
	renderMissionCloudTerritoriesSvg,
	renderSameEmployeeContextReuseOverlay,
	renderSupervisorXRayBeamsSvg,
} from './adeMissionTaskCardBuilder.js';

export {
	formatMissionBlockedRemaining,
	formatMissionWaveTag,
	getMissionNodeSize,
	getMissionWaveColorIndex,
	getRenderedOrchestrationNodeSize,
	MISSION_GATE_CARD_HEIGHT,
	MISSION_GATE_CARD_WIDTH,
	MISSION_TASK_CARD_HEIGHT,
	MISSION_TASK_CARD_WIDTH,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	ORCH_WHITEBOARD_CARD_HEIGHT,
	ORCH_WHITEBOARD_CARD_WIDTH,
	svgEl,
};

const NODE_DRAG_THRESHOLD_PX = 5;
const NODE_DRAG_EXCLUSION_SELECTOR = '.ade-mission-inline-rename-input, .ade-mission-port.port-out.is-connectable, .ade-orch-anchor.is-connectable';
const NODE_SUB_INTERACTIVE_SELECTOR = 'button:not(:disabled), .ade-mission-core-model-row.is-editable, input, textarea, select, [contenteditable="true"]';
export const MISSION_EDGE_TRANSIT_DURATION_MS = 800;
const EDGE_TRANSIT_MAX_FUTURE_SKEW_MS = 5_000;
const MAX_SEEN_TOKEN_HOPS = 500;

function resolveEventTargetElement(target: EventTarget | null): Element | null {
	if (!target || typeof target !== 'object') {
		return null;
	}
	const node = target as Partial<Node>;
	if (typeof node.nodeType !== 'number') {
		return null;
	}
	return node.nodeType === 1 ? (target as Element) : (node.parentElement ?? null);
}

export interface IMissionCanvasRenderSnapshot {
	readonly viewMode?: AdeEngineeringViewMode;
	readonly direction?: 'LR' | 'TD';
	readonly nodes: readonly IMissionDagNode[];
	readonly edges: readonly IMissionDagEdge[];
	readonly positions: ReadonlyMap<string, IMissionNodePosition>;
	readonly runtimeState: IMissionRuntimeState | undefined;
	readonly nodePrompts: Readonly<Record<string, string>>;
	readonly taskStatuses?: Readonly<Record<string, IMissionTaskStatusRecord>>;
	readonly orchestrationNodes?: readonly IOrchestrationGraphNode[];
	readonly orchestrationEdges?: readonly IOrchestrationGraphEdge[];
	readonly orchestrationDepartments?: readonly IOrchestrationDepartmentGroup[];
	readonly orchestrationLayoutMode?: OrchestrationLayoutMode;
	readonly whiteboards?: Readonly<Record<string, IOrchestrationWhiteboard>>;
	readonly orchestrationRuntime?: IOrchestrationRuntimeState;
	readonly agentByNodeId: ReadonlyMap<string, IAdeAgent>;
	readonly fallbackOwnerEngineId: string;
	readonly orgConfig: IAdeOrganizationConfig;
	readonly resolveSupervisorDisplay?: (supervisorId: string) => { readonly label: string; readonly shortLabel: string; readonly tier: number };
	readonly hasSubordinates: (agentId: string) => boolean;
	readonly canSwitchEngine: (agent: IAdeAgent) => boolean;
	readonly canSwitchModel: boolean;
	readonly canSwitchHost: boolean;
}

export interface IMissionCanvasNodeCallbacks {
	onHoverNode(nodeId: string | undefined): void;
	onHoverToken?(token: IMissionToken | undefined): void;
	onHoverSupervisor?(supervisorId: string | undefined): void;
	onSelectNode?(node: IMissionDagNode, anchorEl: HTMLElement, options?: { readonly toggleMulti?: boolean }): void;
	onSelectEdge?(edge: IMissionDagEdge | undefined): void;
	onDoubleClickNode?(node: IMissionDagNode, agentId: string): void;
	onOpenMissionTaskPopover?(node: IMissionDagNode, anchorEl: HTMLElement, options?: { readonly focusSection?: 'contract' | 'checks' }): void;
	onOpenWhiteboardPopover?(whiteboard: IOrchestrationWhiteboard, anchorEl: HTMLElement, options?: { readonly initialSection?: string }): void;
	onOpenOrchestrationTokenPopover?(staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement, options?: { readonly focusSection?: 'barrier' | 'scope' | 'rework'; readonly staffNodeId?: string }): void;
	onJumpToOrchestrationStaff?(staffNodeId: string, options?: { readonly focusTokenId?: string; readonly openPopover?: 'token' }): void;
	onJumpToMissionTask?(taskNodeId: string): void;
	onJumpToWhiteboard?(whiteboardId: string, options?: { readonly initialSection?: string }): void;
	onOpenEmployeePopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenSupervisorPopover?(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenModelPopover(
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly currentModel?: string; readonly currentThinking?: AdeThinkingLevel; readonly hostAlias?: string },
	): void;
	onOpenEnginePopover(
		nodeId: string,
		agent: IAdeAgent | undefined,
		engineId: string,
		anchorEl: HTMLElement,
		options?: { readonly staffLabel?: string; readonly hostAlias?: string },
	): void;
	onOpenHostPopover(node: IMissionDagNode, currentHost: string, anchorEl: HTMLElement): void;
	onOpenNodePromptPopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenNodeColorPopover?(nodeId: string, label: string, currentColor: string | undefined, anchorEl: HTMLElement): void;
	onOpenNodeTriggersPopover?(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenGateDecisionPopover(node: IMissionDagNode, anchorEl: HTMLElement, preferredTokenId?: string, options?: { readonly focusReject?: boolean }): void;
	onQuickGateApprove?(node: IMissionDagNode, token: IMissionToken | undefined, anchorEl: HTMLElement): void;
	onOpenTokenInspectorPopover?(node: IMissionDagNode, token: IMissionToken, allNodeTokens: readonly IMissionToken[], anchorEl: HTMLElement): void;
	onQuickRetryNode?(node: IMissionDagNode, token: IMissionToken): void;
	onOpenGuidedRetryPopover?(node: IMissionDagNode, token: IMissionToken, anchorEl: HTMLElement): void;
	onQuickRecallNode?(node: IMissionDagNode, token: IMissionToken | undefined): void;
	onRenameNode?(nodeId: string, nextLabel: string): void;
	onRenameEdgeLabel?(fromId: string, toId: string, nextLabel: string): void;
	onRenameGroup?(groupId: string, nextName: string): void;
	onGroupContextMenu?(group: IOrchestrationDepartmentGroup, clientX: number, clientY: number): void;
	onConnectNodes?(fromNodeId: string, toNodeId: string, options?: { readonly fail?: boolean; readonly bidirectional?: boolean }): void;
	onNodeContextMenu?(node: IMissionDagNode, clientX: number, clientY: number): void;
	onEdgeContextMenu?(edge: IMissionDagEdge, clientX: number, clientY: number): void;
	getEffectiveNodeChecksCount?(nodeId: string): number;
	isRevisionPreview?(): boolean;
	onOpenAgentSession(agentId: string): void;
	getDragGroupNodeIds?(anchorNodeId: string): readonly string[];
	onStartNodeDrag(): void;
	onDragNodeMove(nodeId: string, nextPos: IMissionNodePosition): void;
	onDragNodesMove?(moves: ReadonlyArray<{ readonly nodeId: string; readonly pos: IMissionNodePosition }>): void;
	onEndNodeDrag(nodeId: string, movedPx: number): void;
	onEndNodesDrag?(movedNodeIds: readonly string[], movedPx: number): void;
	getNodePosition(nodeId: string): IMissionNodePosition | undefined;
	getZoom(): number;
}

interface IRenderedNodeHandle {
	node: IMissionDagNode;
	readonly rootEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly promptPreviewEl?: HTMLElement;
	readonly taskRefs?: ITaskCardDomRefs;
	readonly wbRefs?: IOrchWhiteboardDomRefs;
	readonly staffRefs?: IOrchStaffDomRefs;
	linkedAgent?: IAdeAgent;
	nodeState: string;
	boundSupervisorId?: string;
	assigneeStaffId?: string;
	whiteboard?: IOrchestrationWhiteboard;
}

export function getMissionSupervisorColorIndex(supervisorId: string): number {
	let hash = 0;
	for (let i = 0; i < supervisorId.length; i++) {
		hash = ((hash << 5) - hash + supervisorId.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 6;
}

export function formatMissionTriggerShortLabel(trigger: IMissionSourceTrigger): string {
	if (trigger.kind === 'interval' && trigger.intervalMs) {
		const sec = Math.round(trigger.intervalMs / 1000);
		if (sec >= 3600 && sec % 3600 === 0) {
			return `Every ${sec / 3600}h`;
		}
		if (sec >= 60 && sec % 60 === 0) {
			return `Every ${sec / 60}m`;
		}
		return `Every ${sec}s`;
	}
	if (trigger.kind === 'cron' && trigger.cronExpr) {
		return trigger.cronExpr;
	}
	if (trigger.kind === 'once') {
		return 'Once';
	}
	if (trigger.kind === 'event') {
		if (trigger.eventType === 'gpu_idle') {
			return `GPU≤${trigger.gpuUtilThresholdPct ?? 10}%`;
		}
		if (trigger.eventType === 'git_updated') {
			return 'git';
		}
		if (trigger.eventType === 'file_created') {
			return trigger.targetPath ? `+${extractMissionWatchFileBasename(trigger.targetPath)}` : 'file+';
		}
		if (trigger.eventType === 'file_changed') {
			return trigger.targetPath ? `~${extractMissionWatchFileBasename(trigger.targetPath)}` : 'file~';
		}
		return trigger.eventType ?? 'event';
	}
	return trigger.kind;
}

export function extractMissionWatchFileBasename(filePath: string): string {
	const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	const idx = normalized.lastIndexOf('/');
	const base = idx >= 0 ? normalized.slice(idx + 1) : normalized;
	return base.length > 24 ? `${base.slice(0, 21)}...` : base;
}

/**
 * High-performance Mission Task DAG & Engineering Orchestration Canvas Renderer:
 * - True O(N) structural-keyed in-place DOM & SVG patching across both views (zero teardown on live status/FinOps ticks!).
 * - Zero `setAttribute('d')` calls on distant edges during interactive node drags in both views.
 * - Full Round-2 governance data surfacing, bidirectional DAG <-> Engineering linkage, 2-tier + WB hover spotlight,
 *   and live 1Hz countdown ticking for blocked tokens and join-barrier SLA deadlines.
 */
export class AdeMissionCanvasRenderer extends Disposable {
	private readonly graphDisposables = this._register(new DisposableStore());
	private readonly edgeDisposables = this._register(new DisposableStore());
	private readonly deptDisposables = this._register(new DisposableStore());
	private readonly nodeDragDisposables = this._register(new DisposableStore());
	private readonly connectDragDisposables = this._register(new DisposableStore());
	private readonly inlineRenameDisposables = this._register(new DisposableStore());

	private readonly edgesSvgEl: SVGSVGElement;
	private readonly cloudTerritoriesLayerEl: SVGGElement;
	private readonly edgesLayerEl: SVGGElement;
	private readonly contextLinksLayerEl: SVGGElement;
	private readonly supervisorBeamsLayerEl: SVGGElement;
	private readonly tokenGliderLayerEl: SVGGElement;
	private readonly alignGuidesLayerEl: SVGGElement;
	private readonly connectPreviewPathEl: SVGPathElement;
	private readonly nodesLayerEl: HTMLElement;
	private inlineEdgeEditorEl: HTMLElement | undefined;

	private readonly nodeHandles = new Map<string, IRenderedNodeHandle>();
	private readonly edgeHandles = new Map<string, IRenderedEdgeHandle>();
	private readonly deptHandles = new Map<string, IOrchDeptHandle>();
	private readonly tokenGliderHandles = new Map<string, { readonly group: SVGGElement; readonly text: SVGTextElement; waveClass: string; hopSignature: string }>();
	private readonly livePuckHandles = new Map<string, ILivePuckHandle>();
	private readonly seenTokenHopSignatures = new Set<string>();
	private readonly activeEdgeTransits = new Map<string, IEdgeTransitBurst>();
	private edgeTransitCleanupTimer: number | undefined;
	private trackedMissionId: string | undefined;
	private trackedMissionStartedAt: number | undefined;
	private trackedMissionTokenSeq = 0;
	private animationsPaused = false;

	private readonly lastNodeObstacleById = new Map<string, IMissionEdgeObstacle>();
	private lastGraphStructureKey = '';
	private lastEdgeStructureKey = '';
	private lastDirection: 'LR' | 'TD' = 'LR';
	private lastViewMode: AdeEngineeringViewMode = 'mission';
	private lastDagNodes: readonly IMissionDagNode[] = [];
	private lastOrchNodes: readonly IOrchestrationGraphNode[] = [];
	private lastOrchEdges: readonly IOrchestrationGraphEdge[] = [];
	private lastOrchDepartments: readonly IOrchestrationDepartmentGroup[] = [];
	private lastOrchDeptBounds: readonly IOrchDeptBounds[] = [];
	private lastOrchLayoutMode: OrchestrationLayoutMode | undefined;
	private lastOrchRuntime: IOrchestrationRuntimeState | undefined;
	private lastTaskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
	private lastDagSignals: IMissionDagTopologySignals | undefined;
	private lastOrchDerived: IOrchGraphDerivedIndex | undefined;
	private readonly deptPillRectById = new Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>();
	private readonly orchAnchorButtons = new Map<string, HTMLButtonElement>();
	private readonly orchNodeSizeById = new Map<string, { readonly width: number; readonly height: number }>();

	private hoveredNodeId: string | undefined;
	private hoveredDepTraceNodeId: string | undefined;
	private pinnedDepTraceNodeId: string | undefined;
	private selectedNodeIds = new Set<string>();
	private selectedEdgeKey: string | undefined;
	private searchMatchNodeIds: ReadonlySet<string> | undefined;
	private activeSearchMatchNodeId: string | undefined;
	private hoveredTraceEdgeKeys: ReadonlySet<string> | undefined;
	private crossViewLinkedNodeIds: ReadonlySet<string> | undefined;
	private lastRuntimeState: IMissionRuntimeState | undefined;
	private showCloudTerritories = true;
	private previewAddedNodeIds: ReadonlySet<string> | undefined;
	private focusPulseNodeId: string | undefined;
	private focusPulseTimer: number | undefined;

	constructor(
		private readonly worldEl: HTMLElement,
		private readonly emptyHintEl: HTMLElement,
		private readonly hostCatalog: AdeMissionHostCatalog,
		private readonly callbacks: IMissionCanvasNodeCallbacks,
	) {
		super();
		this.edgesSvgEl = svgEl('svg', { class: 'ade-mission-edges-svg' });
		this.buildSvgMarkers();
		this.cloudTerritoriesLayerEl = svgEl('g', { class: 'ade-mission-cloud-territories-layer' });
		this.edgesLayerEl = svgEl('g', { class: 'ade-mission-edges-layer' });
		this.contextLinksLayerEl = svgEl('g', { class: 'ade-mission-context-layer' });
		this.supervisorBeamsLayerEl = svgEl('g', { class: 'ade-mission-supervisor-beams-layer' });
		this.tokenGliderLayerEl = svgEl('g', { class: 'ade-mission-token-gliders-layer' });
		this.alignGuidesLayerEl = svgEl('g', { class: 'ade-mission-align-guides-layer' });
		this.connectPreviewPathEl = svgEl('path', {
			class: 'ade-mission-connect-preview',
			'marker-end': 'url(#ade-mission-arrow-active)',
		});
		this.connectPreviewPathEl.style.display = 'none';
		this.edgesSvgEl.appendChild(this.cloudTerritoriesLayerEl);
		this.edgesSvgEl.appendChild(this.edgesLayerEl);
		this.edgesSvgEl.appendChild(this.contextLinksLayerEl);
		this.edgesSvgEl.appendChild(this.supervisorBeamsLayerEl);
		this.edgesSvgEl.appendChild(this.tokenGliderLayerEl);
		this.edgesSvgEl.appendChild(this.alignGuidesLayerEl);
		this.edgesSvgEl.appendChild(this.connectPreviewPathEl);
		this.worldEl.appendChild(this.edgesSvgEl);
		this.nodesLayerEl = append(this.worldEl, $('.ade-mission-nodes-layer'));

		this._register(toDisposable(() => {
			this.clearInlineEdgeEditor();
			this.clearAlignGuides();
			this.clearEdgeTransitTimer();
			this.activeEdgeTransits.clear();
			this.seenTokenHopSignatures.clear();
			if (this.focusPulseTimer !== undefined) {
				getWindow(this.worldEl).clearTimeout(this.focusPulseTimer);
				this.focusPulseTimer = undefined;
			}
		}));
	}

	private clearEdgeTransitTimer(): void {
		if (this.edgeTransitCleanupTimer !== undefined) {
			getWindow(this.worldEl).clearTimeout(this.edgeTransitCleanupTimer);
			this.edgeTransitCleanupTimer = undefined;
		}
	}

	private clearGliderDom(): void {
		this.tokenGliderHandles.clear();
		this.livePuckHandles.clear();
		while (this.tokenGliderLayerEl.firstChild) {
			this.tokenGliderLayerEl.removeChild(this.tokenGliderLayerEl.firstChild);
		}
	}

	getLastDepartmentBounds(): readonly IOrchDeptBounds[] {
		return this.lastOrchDeptBounds;
	}

	getLastDagDiagnosticsSummary(): { readonly criticalNodeIds: ReadonlySet<string>; readonly criticalEdgeKeys: ReadonlySet<string>; readonly readyNodeIds: ReadonlySet<string> } {
		return {
			criticalNodeIds: this.lastDagSignals?.criticalNodeIds ?? new Set<string>(),
			criticalEdgeKeys: this.lastDagSignals?.criticalEdgeKeys ?? new Set<string>(),
			readyNodeIds: this.lastDagSignals?.readyFrontierIds ?? new Set<string>(),
		};
	}

	getLastOrchConflictNodeIds(): ReadonlySet<string> {
		const out = new Set<string>();
		if (this.lastOrchDerived) {
			for (const [id, cnt] of this.lastOrchDerived.conflictCountByStaff.entries()) {
				if (cnt > 0) {
					out.add(id);
				}
			}
		}
		return out;
	}

	setAnimationsPaused(paused: boolean): void {
		if (this.animationsPaused === paused) {
			return;
		}
		this.animationsPaused = paused;
		if (paused) {
			this.clearEdgeTransitTimer();
		} else if (this.edgeHandles.size > 0) {
			if (this.lastViewMode === 'mission') {
				this.patchEdgeRuntimeStates(this.lastRuntimeState);
			}
			// Restore offset-path animation on live beacons/comets rendered while paused in a background tab!
			for (const [edgeId, puck] of this.livePuckHandles.entries()) {
				const d = this.edgeHandles.get(edgeId)?.path.getAttribute('d');
				if (d) {
					puck.group.removeAttribute('transform');
					puck.group.style.offsetPath = `path("${d}")`;
					puck.group.style.setProperty('offset-rotate', '0deg');
					puck.group.style.animationDelay = `${-(puck.staticFrac * 3.4).toFixed(2)}s`;
				}
			}
		}
	}

	resetTransitTracking(): void {
		this.clearEdgeTransitTimer();
		this.activeEdgeTransits.clear();
		this.seenTokenHopSignatures.clear();
		this.trackedMissionId = undefined;
		this.trackedMissionStartedAt = undefined;
		this.trackedMissionTokenSeq = 0;
		this.clearGliderDom();
		for (const handle of this.edgeHandles.values()) {
			handle.group.classList.remove('is-token-flowing');
			handle.lastFlowHopSignature = undefined;
		}
	}

	private buildSvgMarkers(): void {
		const defs = svgEl('defs');
		const createArrow = (id: string, color: string) => {
			const marker = svgEl('marker', {
				id,
				viewBox: '0 0 10 10',
				refX: '8.4',
				refY: '5',
				markerWidth: '7',
				markerHeight: '7',
				orient: 'auto',
			});
			marker.appendChild(svgEl('path', { d: 'M 0.6 1.3 L 9.2 5 L 0.6 8.7 L 2.5 5 z', fill: color }));
			defs.appendChild(marker);
		};
		createArrow('ade-mission-arrow-default', '#52b788');
		createArrow('ade-mission-arrow-cloud', '#22d3ee');
		createArrow('ade-mission-arrow-fail', '#f87171');
		createArrow('ade-mission-arrow-in', '#38bdf8');
		createArrow('ade-mission-arrow-out', '#34d399');
		createArrow('ade-mission-arrow-ctx', '#a78bfa');
		createArrow('ade-mission-arrow-active', '#38bdf8');
		createArrow('ade-mission-arrow-trace', '#fbbf24');
		createArrow('ade-mission-arrow-bidir', '#38bdf8');
		createArrow('ade-mission-arrow-cycle', '#f59e0b');
		createArrow('ade-mission-arrow-whiteboard', '#a78bfa');
		createArrow('ade-mission-arrow-flow', '#7dd3fc');
		for (const preset of ADE_NODE_COLOR_PRESETS) {
			createArrow(`ade-mission-arrow-preset-${preset.id}`, preset.hex);
		}
		this.edgesSvgEl.appendChild(defs);
	}

	private applyCustomNodeColor(nodeEl: HTMLElement, rawColor: string | undefined): void {
		const norm = normalizeAdeNodeColor(rawColor);
		const hex = resolveAdeNodeColorHex(norm);
		if (norm && hex) {
			nodeEl.classList.add('has-custom-color');
			nodeEl.setAttribute('data-node-color', norm);
			nodeEl.style.setProperty('--ade-node-custom-color', hex);
		} else {
			nodeEl.classList.remove('has-custom-color');
			nodeEl.removeAttribute('data-node-color');
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
		const btn = append(parentEl, $(`button.ade-node-color-trigger${hex ? '.has-color' : ''}`, {
			type: 'button',
			'data-ade-node-color-btn': nodeId,
			title: adeBi(localize('adeNodeColorBtnTip', "Change node color"), '选择节点颜色'),
			'aria-label': adeBi(localize('adeNodeColorBtnAria', "Change color for {0}", label), '设置 {0} 的颜色', label),
		})) as HTMLButtonElement;
		if (hex) {
			btn.style.setProperty('--trigger-swatch-hex', hex);
		}
		store.add(addDisposableListener(btn, EventType.CLICK, e => {
			e.stopPropagation();
			this.callbacks.onOpenNodeColorPopover?.(nodeId, label, rawColor, btn);
		}));
	}

	private resolveStaffLabel(staffNodeId: string): string {
		const found = this.lastOrchNodes.find(n => n.id === staffNodeId);
		return found?.label ?? found?.employeeName ?? staffNodeId;
	}

	invalidateStructure(): void {
		this.lastGraphStructureKey = '';
		this.lastEdgeStructureKey = '';
		this.lastNodeObstacleById.clear();
	}

	getHoveredNodeId(): string | undefined {
		return this.hoveredNodeId;
	}

	setNodePositionDom(nodeId: string, pos: IMissionNodePosition): void {
		const handle = this.nodeHandles.get(nodeId);
		if (handle) {
			handle.rootEl.style.left = `${pos.x}px`;
			handle.rootEl.style.top = `${pos.y}px`;
		}
	}

	setCrossViewLinkedNodeIds(nodeIds: ReadonlySet<string> | undefined): void {
		this.crossViewLinkedNodeIds = nodeIds && nodeIds.size > 0 ? nodeIds : undefined;
		for (const [id, handle] of this.nodeHandles.entries()) {
			handle.rootEl.classList.toggle('is-cross-view-linked', Boolean(this.crossViewLinkedNodeIds?.has(id)));
		}
	}

	/**
	 * Synchronizes the canvas DOM with the latest graph & runtime snapshot.
	 * Uses true O(N) structural-keyed in-place DOM patching when graph topology is unchanged,
	 * avoiding DOM teardown, preserving active drags/inline renames/hover spotlight/CSS animations!
	 */
	syncGraph(snapshot: IMissionCanvasRenderSnapshot, forceFullRebuild = false): void {
		const viewMode: AdeEngineeringViewMode = snapshot.viewMode ?? 'mission';
		const isOrch = viewMode === 'orchestration';
		const orchNodes = snapshot.orchestrationNodes ?? [];
		const orchDepts = snapshot.orchestrationDepartments ?? [];
		const effectiveCount = isOrch ? (orchNodes.length + orchDepts.length) : snapshot.nodes.length;
		const hasNodes = effectiveCount > 0;
		this.emptyHintEl.hidden = hasNodes;

		// Include empty department fallback bounds in world size so empty groups never clip!
		const worldPositions: IMissionNodePosition[] = [...snapshot.positions.values()];
		if (isOrch && orchDepts.length > 0) {
			worldPositions.push(...computeEmptyDeptFallbackPositions(orchNodes, orchDepts, snapshot.positions));
		}
		const worldSize = computeMissionWorldSize(worldPositions);
		this.worldEl.style.width = `${worldSize.width}px`;
		this.worldEl.style.height = `${worldSize.height}px`;
		this.edgesSvgEl.setAttribute('width', String(worldSize.width));
		this.edgesSvgEl.setAttribute('height', String(worldSize.height));

		const modeChanged = this.lastViewMode !== viewMode;
		this.lastViewMode = viewMode;
		this.worldEl.dataset.viewMode = viewMode;
		this.worldEl.classList.toggle('mode-mission', !isOrch);
		this.worldEl.classList.toggle('mode-orchestration', isOrch);

		if (!hasNodes) {
			this.lastDagNodes = [];
			this.lastOrchNodes = [];
			this.lastOrchEdges = [];
			this.lastOrchDepartments = [];
			this.lastOrchDeptBounds = [];
			this.lastOrchRuntime = undefined;
			this.lastDagSignals = undefined;
			this.lastOrchDerived = undefined;
			this.orchAnchorButtons.clear();
			this.orchNodeSizeById.clear();
			this.clearAllDom();
			return;
		}

		this.lastRuntimeState = snapshot.runtimeState;
		this.lastDagNodes = snapshot.nodes;
		this.lastTaskStatuses = snapshot.taskStatuses;
		this.lastOrchRuntime = snapshot.orchestrationRuntime;
		const nextDirection = snapshot.direction ?? 'LR';
		this.lastDirection = nextDirection;
		this.worldEl.classList.toggle('dir-td', nextDirection === 'TD');
		this.worldEl.dataset.dagDirection = nextDirection;

		if (isOrch) {
			this.lastOrchNodes = orchNodes;
			this.lastOrchEdges = snapshot.orchestrationEdges ?? [];
			this.lastOrchDepartments = orchDepts;
			this.lastOrchLayoutMode = snapshot.orchestrationLayoutMode;
			this.syncOrchestrationGraphDom(snapshot, forceFullRebuild || modeChanged);
			return;
		}

		// Preserve lastOrchNodes metadata if supplied so Mission cards can resolve `@Staff` display labels!
		if (snapshot.orchestrationNodes && snapshot.orchestrationNodes.length > 0) {
			this.lastOrchNodes = snapshot.orchestrationNodes;
		}
		this.lastOrchEdges = [];
		this.lastOrchDepartments = [];
		this.lastOrchDeptBounds = [];
		this.orchAnchorButtons.clear();
		this.syncMissionTaskGraphDom(snapshot, forceFullRebuild || modeChanged);
	}

	private reapplyTransientNodeOverlays(): void {
		const isMulti = this.selectedNodeIds.size > 1;
		for (const [id, handle] of this.nodeHandles.entries()) {
			const isSelected = this.selectedNodeIds.has(id);
			handle.rootEl.classList.toggle('is-selected', isSelected);
			handle.rootEl.classList.toggle('is-multi-selected', isSelected && isMulti);
			if (isSelected) {
				handle.rootEl.setAttribute('data-node-selected', 'true');
			} else {
				handle.rootEl.removeAttribute('data-node-selected');
			}
			const isMatch = Boolean(this.searchMatchNodeIds?.has(id));
			const isActiveMatch = Boolean(this.activeSearchMatchNodeId && id === this.activeSearchMatchNodeId);
			handle.rootEl.classList.toggle('is-search-match', isMatch);
			handle.rootEl.classList.toggle('is-search-active', isActiveMatch);
			if (isMatch) {
				handle.rootEl.setAttribute('data-search-match', 'true');
			} else {
				handle.rootEl.removeAttribute('data-search-match');
			}
			if (isActiveMatch) {
				handle.rootEl.setAttribute('data-search-active', 'true');
			} else {
				handle.rootEl.removeAttribute('data-search-active');
			}
			const isAdded = Boolean(this.previewAddedNodeIds?.has(id));
			handle.rootEl.classList.toggle('is-revision-added', isAdded);
			if (isAdded) {
				handle.rootEl.setAttribute('data-revision-added', 'true');
			} else {
				handle.rootEl.removeAttribute('data-revision-added');
			}
			const isFocused = Boolean(this.focusPulseNodeId && id === this.focusPulseNodeId);
			handle.rootEl.classList.toggle('is-inbox-focused', isFocused);
			if (isFocused) {
				handle.rootEl.setAttribute('data-inbox-focused', 'true');
			} else {
				handle.rootEl.removeAttribute('data-inbox-focused');
			}
			handle.rootEl.classList.toggle('is-cross-view-linked', Boolean(this.crossViewLinkedNodeIds?.has(id)));
		}
		this.worldEl.classList.toggle('has-search-filter', Boolean(this.searchMatchNodeIds));
	}

	setTraceHighlightEdges(edgeKeys: ReadonlySet<string> | undefined): void {
		this.hoveredTraceEdgeKeys = edgeKeys && edgeKeys.size > 0 ? edgeKeys : undefined;
		this.worldEl.classList.toggle('has-trace-hover', Boolean(this.hoveredTraceEdgeKeys));
		if (this.lastViewMode === 'mission') {
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
		}
	}

	setSelectedNodeId(nodeId: string | undefined): void {
		this.setSelectedNodeIds(nodeId ? [nodeId] : []);
	}

	setSelectedNodeIds(nodeIds: Iterable<string>): void {
		this.selectedNodeIds = new Set(nodeIds);
		const isMulti = this.selectedNodeIds.size > 1;
		for (const [id, handle] of this.nodeHandles.entries()) {
			const isSelected = this.selectedNodeIds.has(id);
			handle.rootEl.classList.toggle('is-selected', isSelected);
			handle.rootEl.classList.toggle('is-multi-selected', isSelected && isMulti);
			if (isSelected) {
				handle.rootEl.setAttribute('data-node-selected', 'true');
			} else {
				handle.rootEl.removeAttribute('data-node-selected');
			}
		}
	}

	setSelectedEdgeKey(edgeKey: string | undefined): void {
		this.selectedEdgeKey = edgeKey;
		for (const handle of this.edgeHandles.values()) {
			const key = `${handle.edge.from}->${handle.edge.to}`;
			const isSelected = Boolean(edgeKey && key === edgeKey);
			handle.group.classList.toggle('is-selected', isSelected);
			if (isSelected) {
				handle.group.setAttribute('data-edge-selected', 'true');
				handle.path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				this.edgesLayerEl.appendChild(handle.group);
			} else {
				handle.group.removeAttribute('data-edge-selected');
				// Restore exact cached canonical marker (fixes previous marker leak on A -> B edge selection switch!)
				handle.path.setAttribute('marker-end', handle.baseMarkerEnd);
			}
		}
		if (!edgeKey && this.lastViewMode === 'mission') {
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
		}
	}

	setSearchMatches(matchNodeIds: ReadonlySet<string> | undefined, activeMatchNodeId: string | undefined): void {
		this.searchMatchNodeIds = matchNodeIds && matchNodeIds.size > 0 ? matchNodeIds : undefined;
		this.activeSearchMatchNodeId = activeMatchNodeId;
		this.worldEl.classList.toggle('has-search-filter', Boolean(this.searchMatchNodeIds));
		for (const [id, handle] of this.nodeHandles.entries()) {
			const isMatch = Boolean(this.searchMatchNodeIds?.has(id));
			const isActive = Boolean(activeMatchNodeId && id === activeMatchNodeId);
			handle.rootEl.classList.toggle('is-search-match', isMatch);
			handle.rootEl.classList.toggle('is-search-active', isActive);
			if (isMatch) {
				handle.rootEl.setAttribute('data-search-match', 'true');
			} else {
				handle.rootEl.removeAttribute('data-search-match');
			}
			if (isActive) {
				handle.rootEl.setAttribute('data-search-active', 'true');
			} else {
				handle.rootEl.removeAttribute('data-search-active');
			}
		}
	}

	private clearAlignGuides(): void {
		while (this.alignGuidesLayerEl.firstChild) {
			this.alignGuidesLayerEl.removeChild(this.alignGuidesLayerEl.firstChild);
		}
	}

	private renderAlignGuides(guides: readonly IMissionAlignGuide[]): void {
		this.clearAlignGuides();
		for (const guide of guides) {
			const attrs: Record<string, string> = guide.axis === 'x'
				? {
					class: 'ade-mission-align-guide is-vertical',
					'data-ade-align-guide': 'x',
					'data-guide-coord': String(guide.coord),
					x1: String(guide.coord),
					y1: String(guide.start),
					x2: String(guide.coord),
					y2: String(guide.end),
				}
				: {
					class: 'ade-mission-align-guide is-horizontal',
					'data-ade-align-guide': 'y',
					'data-guide-coord': String(guide.coord),
					x1: String(guide.start),
					y1: String(guide.coord),
					x2: String(guide.end),
					y2: String(guide.coord),
				};
			this.alignGuidesLayerEl.appendChild(svgEl('line', attrs));
		}
	}

	private clearInlineEdgeEditor(): void {
		if (this.inlineEdgeEditorEl) {
			this.inlineEdgeEditorEl.remove();
			this.inlineEdgeEditorEl = undefined;
		}
	}

	startInlineEdgeLabelEdit(edgeId: string): void {
		if (!this.callbacks.onRenameEdgeLabel || this.callbacks.isRevisionPreview?.()) {
			return;
		}
		const handle = this.edgeHandles.get(edgeId)
			?? [...this.edgeHandles.values()].find(h => `${h.edge.from}->${h.edge.to}` === edgeId);
		if (!handle) {
			return;
		}
		this.inlineRenameDisposables.clear();
		this.clearInlineEdgeEditor();
		const { edge, midX, midY } = handle;
		const originalLabel = (edge.label ?? '').trim();
		const wrap = append(this.worldEl, $('.ade-mission-inline-edge-editor', {
			'data-ade-inline-edge-editor': `${edge.from}->${edge.to}`,
		}));
		wrap.style.left = `${Math.round(midX)}px`;
		wrap.style.top = `${Math.round(midY)}px`;
		this.inlineEdgeEditorEl = wrap;

		const input = append(wrap, $('input.ade-mission-inline-edge-input', {
			type: 'text',
			value: originalLabel,
			placeholder: adeBi(
				localize('adeMissionInlineEdgeLabelPlaceholder', "Edge label (e.g. fail / spec, empty to clear)"),
				'边标签 (如 fail / spec，留空清除)',
			),
			'data-ade-inline-edge-rename': `${edge.from}->${edge.to}`,
			'aria-label': adeBi(
				localize('adeMissionInlineEdgeRenameAria', "Edit label for edge {0} to {1}", edge.from, edge.to),
				'编辑连线 {0} 到 {1} 的标签',
				edge.from,
				edge.to,
			),
		})) as HTMLInputElement;

		let done = false;
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			this.inlineRenameDisposables.clear();
			const nextVal = input.value.trim();
			this.clearInlineEdgeEditor();
			if (commit && nextVal !== originalLabel) {
				this.callbacks.onRenameEdgeLabel?.(edge.from, edge.to, nextVal);
			}
		};
		this.inlineRenameDisposables.add(toDisposable(() => this.clearInlineEdgeEditor()));
		this.inlineRenameDisposables.add(addDisposableListener(wrap, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.CLICK, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.DBLCLICK, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				finish(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(false);
			}
		}));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.BLUR, () => finish(true)));
		input.focus();
		input.select();
	}

	startInlineGroupRename(groupId: string): void {
		if (!this.callbacks.onRenameGroup || this.callbacks.isRevisionPreview?.()) {
			return;
		}
		const rect = this.deptPillRectById.get(groupId);
		if (!rect) {
			return;
		}
		this.inlineRenameDisposables.clear();
		this.clearInlineEdgeEditor();
		const originalName = rect.dept.name.trim();
		const wrap = append(this.worldEl, $('.ade-mission-inline-edge-editor.is-group-rename', {
			'data-ade-inline-group-editor': rect.dept.id,
		}));
		wrap.style.left = `${Math.round(rect.x + rect.w / 2)}px`;
		wrap.style.top = `${Math.round(rect.y)}px`;
		this.inlineEdgeEditorEl = wrap;

		const input = append(wrap, $('input.ade-mission-inline-edge-input.is-group-rename', {
			type: 'text',
			value: originalName,
			placeholder: adeBi(localize('adeOrchInlineGroupRenamePh', "Group / Department name…"), '分组 / 部门名称…'),
			'data-ade-inline-group-rename': rect.dept.id,
			'aria-label': adeBi(localize('adeOrchInlineGroupRenameAria', "Rename group {0}", originalName), '重命名分组 {0}', originalName),
		})) as HTMLInputElement;

		let done = false;
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			this.inlineRenameDisposables.clear();
			const nextVal = input.value.trim();
			this.clearInlineEdgeEditor();
			if (commit && nextVal && nextVal !== originalName) {
				this.callbacks.onRenameGroup?.(rect.dept.id, nextVal);
			}
		};
		this.inlineRenameDisposables.add(toDisposable(() => this.clearInlineEdgeEditor()));
		this.inlineRenameDisposables.add(addDisposableListener(wrap, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.CLICK, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.DBLCLICK, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				finish(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(false);
			}
		}));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.BLUR, () => finish(true)));
		input.focus();
		input.select();
	}

	pulseFocusNode(nodeId: string, durationMs = 3600): void {
		const win = getWindow(this.worldEl);
		if (this.focusPulseTimer !== undefined) {
			win.clearTimeout(this.focusPulseTimer);
			this.focusPulseTimer = undefined;
		}
		if (this.focusPulseNodeId) {
			const prev = this.nodeHandles.get(this.focusPulseNodeId);
			prev?.rootEl.classList.remove('is-inbox-focused');
			prev?.rootEl.removeAttribute('data-inbox-focused');
		}
		this.focusPulseNodeId = nodeId;
		const handle = this.nodeHandles.get(nodeId);
		if (!handle) {
			return;
		}
		handle.rootEl.classList.add('is-inbox-focused');
		handle.rootEl.setAttribute('data-inbox-focused', 'true');
		this.focusPulseTimer = win.setTimeout(() => {
			this.focusPulseTimer = undefined;
			const cur = this.nodeHandles.get(nodeId);
			cur?.rootEl.classList.remove('is-inbox-focused');
			cur?.rootEl.removeAttribute('data-inbox-focused');
			if (this.focusPulseNodeId === nodeId) {
				this.focusPulseNodeId = undefined;
			}
		}, durationMs);
	}

	startInlineNodeRename(nodeId: string): void {
		const handle = this.nodeHandles.get(nodeId);
		if (!handle || !this.callbacks.onRenameNode || this.callbacks.isRevisionPreview?.()) {
			return;
		}
		const titleEl = handle.titleEl;
		if (titleEl.firstElementChild?.tagName === 'INPUT') {
			return;
		}
		const originalLabel = handle.node.label;
		this.inlineRenameDisposables.clear();
		clearNode(titleEl);
		const input = append(titleEl, $('input.ade-mission-inline-rename-input', {
			type: 'text',
			value: originalLabel,
			'data-ade-inline-rename': nodeId,
			'aria-label': adeBi(localize('adeMissionInlineRenameAria', "Rename node {0}", nodeId), '重命名节点 {0}', nodeId),
		})) as HTMLInputElement;
		let done = false;
		const restoreTitle = () => {
			if (titleEl.firstElementChild === input) {
				clearNode(titleEl);
				titleEl.textContent = originalLabel;
				titleEl.title = originalLabel;
			}
		};
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			this.inlineRenameDisposables.clear();
			const nextVal = input.value.trim();
			restoreTitle();
			if (commit && nextVal && nextVal !== originalLabel) {
				this.callbacks.onRenameNode?.(nodeId, nextVal);
			}
		};
		this.inlineRenameDisposables.add(toDisposable(() => restoreTitle()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.CLICK, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.DBLCLICK, e => e.stopPropagation()));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				finish(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				finish(false);
			}
		}));
		this.inlineRenameDisposables.add(addDisposableListener(input, EventType.BLUR, () => finish(true)));
		input.focus();
		input.select();
	}

	setHighlightedSupervisorId(supervisorId: string | undefined): void {
		this.worldEl.classList.toggle('has-supervisor-highlight', Boolean(supervisorId));
		for (const handle of this.nodeHandles.values()) {
			handle.rootEl.classList.toggle('is-supervised-highlight', Boolean(supervisorId && handle.boundSupervisorId === supervisorId));
		}
	}

	isCloudTerritoriesVisible(): boolean {
		return this.showCloudTerritories;
	}

	setShowCloudTerritories(
		visible: boolean,
		nodes: readonly IMissionDagNode[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
	): void {
		this.showCloudTerritories = visible;
		// Never wipe Orchestration department regions sharing `cloudTerritoriesLayerEl`!
		if (this.lastViewMode !== 'mission') {
			return;
		}
		this.renderCloudTerritories(nodes, positions);
	}

	setPreviewAddedNodeIds(ids: ReadonlySet<string> | undefined): void {
		this.previewAddedNodeIds = ids && ids.size > 0 ? ids : undefined;
		for (const [id, handle] of this.nodeHandles.entries()) {
			const isAdded = Boolean(this.previewAddedNodeIds?.has(id));
			handle.rootEl.classList.toggle('is-revision-added', isAdded);
			if (isAdded) {
				handle.rootEl.setAttribute('data-revision-added', 'true');
			} else {
				handle.rootEl.removeAttribute('data-revision-added');
			}
		}
	}

	setTabSpotlightActive(
		active: boolean,
		nodes: readonly IMissionDagNode[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
		runtimeState: IMissionRuntimeState | undefined,
		resolveSupervisorDisplay?: IMissionCanvasRenderSnapshot['resolveSupervisorDisplay'],
	): void {
		while (this.supervisorBeamsLayerEl.firstChild) {
			this.supervisorBeamsLayerEl.removeChild(this.supervisorBeamsLayerEl.firstChild);
		}
		this.worldEl.classList.toggle('is-tab-spotlight-active', active);
		for (const handle of this.nodeHandles.values()) {
			handle.rootEl.classList.toggle('is-tab-supervised', active && Boolean(handle.boundSupervisorId));
		}
		if (!active || !runtimeState) {
			return;
		}
		renderSupervisorXRayBeamsSvg(
			this.supervisorBeamsLayerEl,
			nodes,
			positions,
			runtimeState,
			getMissionSupervisorColorIndex,
			resolveSupervisorDisplay,
		);
	}

	/**
	 * Live 1Hz countdown ticker updating both Orchestration `blocked` timers and `waiting_join` `deadlineAt` SLA chips IN PLACE!
	 */
	patchBlockedCountdowns(runtimeState: IMissionRuntimeState | undefined, now = Date.now()): void {
		this.lastRuntimeState = runtimeState;
		for (const handle of this.nodeHandles.values()) {
			const staff = handle.staffRefs;
			if (!staff || !staff.countdownEl || !staff.countdownTargetAt) {
				continue;
			}
			const rem = formatMissionBlockedRemaining(staff.countdownTargetAt, now);
			if (staff.countdownMode === 'blocked') {
				const txt = `⏳ ${rem.text}`;
				if (staff.countdownEl.textContent !== txt) {
					staff.countdownEl.textContent = txt;
				}
				staff.countdownEl.classList.toggle('is-overdue', rem.isOverdue);
			} else if (staff.countdownMode === 'barrier') {
				const isUrgent = rem.isOverdue || (staff.countdownTargetAt - now) < 120_000;
				const txt = rem.isOverdue ? '⏱ SLA' : `⏱ ${rem.text}`;
				if (staff.countdownEl.textContent !== txt) {
					staff.countdownEl.textContent = txt;
				}
				staff.countdownEl.classList.toggle('is-urgent', isUrgent);
				staff.countdownEl.classList.toggle('is-overdue', rem.isOverdue);
			}
		}
	}

	private clearAllDom(): void {
		this.nodeDragDisposables.clear();
		this.connectDragDisposables.clear();
		this.inlineRenameDisposables.clear();
		this.clearInlineEdgeEditor();
		this.clearAlignGuides();
		this.clearEdgeTransitTimer();
		this.activeEdgeTransits.clear();
		this.seenTokenHopSignatures.clear();
		this.trackedMissionId = undefined;
		this.trackedMissionStartedAt = undefined;
		this.trackedMissionTokenSeq = 0;
		this.graphDisposables.clear();
		this.edgeDisposables.clear();
		this.deptDisposables.clear();
		this.deptHandles.clear();
		this.deptPillRectById.clear();
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.tokenGliderHandles.clear();
		this.livePuckHandles.clear();
		this.lastNodeObstacleById.clear();
		this.lastGraphStructureKey = '';
		this.lastEdgeStructureKey = '';
		this.hoveredNodeId = undefined;
		this.hoveredDepTraceNodeId = undefined;
		this.pinnedDepTraceNodeId = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.searchMatchNodeIds = undefined;
		this.activeSearchMatchNodeId = undefined;
		this.hoveredTraceEdgeKeys = undefined;
		this.worldEl.classList.remove('has-node-hover', 'has-trace-hover', 'has-supervisor-highlight', 'is-tab-spotlight-active', 'has-search-filter', 'is-connecting-edge');
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl, this.tokenGliderLayerEl, this.alignGuidesLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}
	}

	private patchEdgeRuntimeStates(runtimeState: IMissionRuntimeState | undefined, now = Date.now()): void {
		// Strictly guard Mission runtime edge patching so it NEVER corrupts Orchestration arrowheads!
		if (this.lastViewMode !== 'mission') {
			this.cleanupExpiredOrchBursts(now);
			return;
		}

		const flowingEdgeKeys = new Set<string>();
		const flowingEdgeBurstByKey = new Map<string, IEdgeTransitBurst>();
		const failTakenEdgeKeys = new Set<string>();
		const joinArrivedEdgeKeys = new Set<string>();
		const skippedEdgeKeys = new Set<string>();

		const edgeByKey = new Map<string, IRenderedEdgeHandle>();
		const edgeKindByKey = new Map<string, string>();
		for (const h of this.edgeHandles.values()) {
			const edgeKey = `${h.edge.from}->${h.edge.to}`;
			edgeByKey.set(edgeKey, h);
			edgeKindByKey.set(edgeKey, getMissionEdgeKind(h.edge));
		}

		if (!runtimeState) {
			this.clearEdgeTransitTimer();
			this.activeEdgeTransits.clear();
			this.seenTokenHopSignatures.clear();
			this.trackedMissionId = undefined;
			this.trackedMissionStartedAt = undefined;
			this.trackedMissionTokenSeq = 0;
		} else {
			const missionReset = runtimeState.missionId !== this.trackedMissionId
				|| runtimeState.startedAt !== this.trackedMissionStartedAt
				|| runtimeState.tokenSeq < this.trackedMissionTokenSeq;
			if (missionReset) {
				this.clearEdgeTransitTimer();
				this.activeEdgeTransits.clear();
				this.seenTokenHopSignatures.clear();
				this.trackedMissionId = runtimeState.missionId;
				this.trackedMissionStartedAt = runtimeState.startedAt;
				this.trackedMissionTokenSeq = runtimeState.tokenSeq;
			} else if (runtimeState.tokenSeq > this.trackedMissionTokenSeq) {
				this.trackedMissionTokenSeq = runtimeState.tokenSeq;
			}

			if (this.seenTokenHopSignatures.size > MAX_SEEN_TOKEN_HOPS) {
				for (const sig of [...this.seenTokenHopSignatures]) {
					const sep = sig.indexOf('|');
					const tokId = sep >= 0 ? sig.slice(0, sep) : sig;
					if (!runtimeState.tokens[tokId]) {
						this.seenTokenHopSignatures.delete(sig);
					}
				}
			}

			if (runtimeState.status === 'idle' || runtimeState.status === 'stopped') {
				this.activeEdgeTransits.clear();
			} else {
				for (const [edgeKey, burst] of [...this.activeEdgeTransits.entries()]) {
					const liveTok = runtimeState.tokens[burst.tokenId];
					if (now >= burst.expiresAt || !liveTok || liveTok.status === 'recalled' || !edgeByKey.has(edgeKey)) {
						this.activeEdgeTransits.delete(edgeKey);
					}
				}
			}

			for (const tok of Object.values(runtimeState.tokens)) {
				if (!tok.fromNodeId) {
					continue;
				}
				const key = `${tok.fromNodeId}->${tok.nodeId}`;
				const isFailEdge = edgeKindByKey.get(key) === 'fail';
				if (isFailEdge) {
					failTakenEdgeKeys.add(key);
				}
				const hopSignature = `${tok.id}|${key}|${tok.arrivedAt}`;
				if (!this.seenTokenHopSignatures.has(hopSignature)) {
					this.seenTokenHopSignatures.add(hopSignature);
					const edgeHandle = edgeByKey.get(key);
					const isArrivalLiveStatus = tok.status === 'active'
						|| tok.status === 'queued'
						|| tok.status === 'blocked'
						|| tok.status === 'waiting_gate'
						|| tok.status === 'waiting_join';
					if (
						edgeHandle
						&& isArrivalLiveStatus
						&& runtimeState.status !== 'idle'
						&& runtimeState.status !== 'stopped'
						&& !this.animationsPaused
					) {
						const ageMs = now - tok.arrivedAt;
						if (ageMs >= -EDGE_TRANSIT_MAX_FUTURE_SKEW_MS && ageMs < MISSION_EDGE_TRANSIT_DURATION_MS) {
							const remainingMs = Math.max(1, MISSION_EDGE_TRANSIT_DURATION_MS - Math.max(0, ageMs));
							const expiresAt = now + remainingMs;
							const existing = this.activeEdgeTransits.get(key);
							if (!existing || expiresAt >= existing.expiresAt) {
								this.activeEdgeTransits.set(key, {
									edgeKey: key,
									edgeId: edgeHandle.edge.id,
									tokenId: tok.id,
									waveId: tok.waveId,
									isFail: isFailEdge,
									hopSignature,
									expiresAt,
								});
							}
						}
					}
				}
			}

			for (const trace of Object.values(runtimeState.traces)) {
				if (trace.event !== 'fail_route') {
					continue;
				}
				for (const parentPtr of trace.parentPtrs) {
					const parentTrace = runtimeState.traces[parentPtr];
					if (parentTrace && parentTrace.nodeId !== trace.nodeId) {
						failTakenEdgeKeys.add(`${parentTrace.nodeId}->${trace.nodeId}`);
					}
				}
			}

			for (const barrier of Object.values(runtimeState.joinBarriers)) {
				for (const fromId of Object.keys(barrier.arrivedByFrom)) {
					joinArrivedEdgeKeys.add(`${fromId}->${barrier.targetNodeId}`);
				}
				for (const skippedId of barrier.skippedFromNodeIds) {
					skippedEdgeKeys.add(`${skippedId}->${barrier.targetNodeId}`);
				}
			}

			for (const [key, burst] of this.activeEdgeTransits.entries()) {
				flowingEdgeKeys.add(key);
				flowingEdgeBurstByKey.set(key, {
					...burst,
					isFail: burst.isFail || failTakenEdgeKeys.has(key),
				});
			}
		}

		const traceKeys = this.hoveredTraceEdgeKeys;
		const raisedGroups: SVGGElement[] = [];
		for (const handle of this.edgeHandles.values()) {
			const { group, path, edge } = handle;
			const key = `${edge.from}->${edge.to}`;
			const burst = flowingEdgeBurstByKey.get(key);
			const isFlowing = flowingEdgeKeys.has(key);
			const isFailTaken = failTakenEdgeKeys.has(key);
			const isJoinArrived = joinArrivedEdgeKeys.has(key);
			const isSkipped = skippedEdgeKeys.has(key) && !isFlowing && !isJoinArrived;
			const isTraceHit = Boolean(traceKeys?.has(key));

			if (isFlowing && burst) {
				if (handle.lastFlowHopSignature !== burst.hopSignature && group.classList.contains('is-token-flowing')) {
					group.classList.remove('is-token-flowing');
					void path.getBoundingClientRect();
				}
				group.classList.add('is-token-flowing');
				handle.lastFlowHopSignature = burst.hopSignature;
			} else {
				group.classList.remove('is-token-flowing');
				handle.lastFlowHopSignature = undefined;
			}
			group.classList.toggle('is-fail-taken', isFailTaken);
			group.classList.toggle('is-join-arrived', isJoinArrived);
			group.classList.toggle('is-branch-skipped', isSkipped);
			group.classList.toggle('is-trace-highlighted', isTraceHit);

			const isSelectedEdge = Boolean(this.selectedEdgeKey && key === this.selectedEdgeKey);
			group.classList.toggle('is-selected', isSelectedEdge);
			if (isSelectedEdge) {
				group.setAttribute('data-edge-selected', 'true');
			} else {
				group.removeAttribute('data-edge-selected');
			}

			const isNodeHoverConnected = Boolean(this.hoveredNodeId && (edge.to === this.hoveredNodeId || edge.from === this.hoveredNodeId));
			if (isSelectedEdge) {
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				raisedGroups.push(group);
			} else if (isTraceHit) {
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-trace)');
				raisedGroups.push(group);
			} else if (!isNodeHoverConnected) {
				if (isFailTaken) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-fail)');
				} else if (isFlowing) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				} else {
					path.setAttribute('marker-end', handle.baseMarkerEnd);
				}
			}
		}

		for (const g of raisedGroups) {
			this.edgesLayerEl.appendChild(g);
		}
		this.patchTokenGliders(flowingEdgeBurstByKey, now);
		this.scheduleEdgeTransitCleanup(now);
	}

	private cleanupExpiredOrchBursts(now: number): void {
		const liveBursts = new Map<string, IEdgeTransitBurst>();
		for (const [edgeKey, burst] of [...this.activeEdgeTransits.entries()]) {
			if (now >= burst.expiresAt) {
				this.activeEdgeTransits.delete(edgeKey);
				const eh = this.edgeHandles.get(burst.edgeId);
				if (eh) {
					eh.group.classList.remove('is-token-flowing');
					const isSelected = Boolean(this.selectedEdgeKey && edgeKey === this.selectedEdgeKey);
					const isIncoming = Boolean(this.hoveredNodeId && eh.edge.to === this.hoveredNodeId);
					const isOutgoing = Boolean(this.hoveredNodeId && eh.edge.from === this.hoveredNodeId);
					if (isSelected) {
						eh.path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
					} else if (isIncoming) {
						eh.path.setAttribute('marker-end', eh.isWhiteboardLink ? 'url(#ade-mission-arrow-whiteboard)' : 'url(#ade-mission-arrow-in)');
					} else if (isOutgoing) {
						eh.path.setAttribute('marker-end', eh.isWhiteboardLink ? 'url(#ade-mission-arrow-whiteboard)' : 'url(#ade-mission-arrow-out)');
					} else {
						eh.path.setAttribute('marker-end', eh.baseMarkerEnd);
					}
				}
			} else {
				liveBursts.set(edgeKey, burst);
			}
		}
		this.patchTokenGliders(liveBursts, now);
		this.scheduleEdgeTransitCleanup(now);
	}

	private registerOrchBurst(burst: IEdgeTransitBurst, now: number): void {
		this.activeEdgeTransits.set(burst.edgeKey, burst);
		this.patchTokenGliders(this.activeEdgeTransits, now);
		this.scheduleEdgeTransitCleanup(now);
	}

	private scheduleEdgeTransitCleanup(now: number): void {
		this.clearEdgeTransitTimer();
		if (this.animationsPaused || this.activeEdgeTransits.size === 0) {
			return;
		}
		let earliestExpiry = Infinity;
		for (const burst of this.activeEdgeTransits.values()) {
			if (burst.expiresAt < earliestExpiry) {
				earliestExpiry = burst.expiresAt;
			}
		}
		if (!Number.isFinite(earliestExpiry)) {
			return;
		}
		const delayMs = Math.max(0, earliestExpiry - now) + 4;
		this.edgeTransitCleanupTimer = getWindow(this.worldEl).setTimeout(() => {
			this.edgeTransitCleanupTimer = undefined;
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
		}, delayMs);
	}

	private patchTokenGliders(
		flowingEdgeBurstByKey: ReadonlyMap<string, IEdgeTransitBurst>,
		now: number,
	): void {
		const activeEdgeIds = new Set<string>();
		for (const handle of this.edgeHandles.values()) {
			const key = `${handle.edge.from}->${handle.edge.to}`;
			const burst = flowingEdgeBurstByKey.get(key);
			if (!burst) {
				continue;
			}
			activeEdgeIds.add(handle.edge.id);
			const d = handle.path.getAttribute('d') ?? '';
			const waveColorClass = `wave-color-${getMissionWaveColorIndex(burst.waveId)}`;
			const isFail = burst.isFail;
			const waveLabel = formatMissionWaveTag(burst.waveId);
			let glider = this.tokenGliderHandles.get(handle.edge.id);
			if (glider && glider.hopSignature !== burst.hopSignature) {
				glider.group.remove();
				this.tokenGliderHandles.delete(handle.edge.id);
				glider = undefined;
			}
			if (!glider) {
				const group = svgEl('g', {
					class: `ade-mission-edge-puck ${waveColorClass}${isFail ? ' is-fail' : ''}`,
					'data-ade-edge-puck': handle.edge.id,
					'data-wave-id': burst.waveId,
					'data-token-id': burst.tokenId,
					'data-transit-once': 'true',
					'data-transit-duration-ms': String(MISSION_EDGE_TRANSIT_DURATION_MS),
				});
				const elapsedMs = Math.max(0, Math.min(MISSION_EDGE_TRANSIT_DURATION_MS - 1, now - (burst.expiresAt - MISSION_EDGE_TRANSIT_DURATION_MS)));
				if (elapsedMs >= 20) {
					group.style.animationDelay = `-${Math.round(elapsedMs)}ms`;
				}
				group.appendChild(svgEl('circle', { class: 'ade-mission-edge-puck-glow', cx: '0', cy: '0', r: '12' }));
				group.appendChild(svgEl('rect', { class: 'ade-mission-edge-puck-pill', x: '-15', y: '-8', width: '30', height: '16', rx: '8' }));
				const text = svgEl('text', { class: 'ade-mission-edge-puck-text', x: '0', y: '0.5' });
				text.textContent = waveLabel;
				group.appendChild(text);
				this.tokenGliderLayerEl.appendChild(group);
				glider = { group, text, waveClass: waveColorClass, hopSignature: burst.hopSignature };
				this.tokenGliderHandles.set(handle.edge.id, glider);
			} else {
				const desiredCls = `ade-mission-edge-puck ${waveColorClass}${isFail ? ' is-fail' : ''}`;
				if (glider.group.getAttribute('class') !== desiredCls) {
					glider.group.setAttribute('class', desiredCls);
					glider.waveClass = waveColorClass;
				}
				glider.group.setAttribute('data-wave-id', burst.waveId);
				glider.group.setAttribute('data-token-id', burst.tokenId);
				if (glider.text.textContent !== waveLabel) {
					glider.text.textContent = waveLabel;
				}
			}
			const nextOffsetPath = d ? `path("${d}")` : 'none';
			if (glider.group.style.offsetPath !== nextOffsetPath) {
				glider.group.style.offsetPath = nextOffsetPath;
				glider.group.style.setProperty('offset-rotate', '0deg');
			}
		}

		for (const [edgeId, glider] of [...this.tokenGliderHandles.entries()]) {
			if (!activeEdgeIds.has(edgeId)) {
				glider.group.remove();
				this.tokenGliderHandles.delete(edgeId);
			}
		}
	}

	private renderCloudTerritories(
		nodes: readonly IMissionDagNode[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
	): void {
		if (this.lastViewMode !== 'mission') {
			return;
		}
		renderMissionCloudTerritoriesSvg(
			this.cloudTerritoriesLayerEl,
			this.showCloudTerritories,
			nodes,
			positions,
			nodeId => {
				const s = this.nodeHandles.get(nodeId)?.staffRefs;
				return s
					? { hostAlias: s.hostAlias, displayHost: s.displayHost, osKind: s.osKind, osLabel: s.osLabel, isRemoteHost: s.isRemoteHost }
					: undefined;
			},
		);
	}

	syncNodePromptPreviews(prompts: Readonly<Record<string, string>>): void {
		for (const [nodeId, handle] of this.nodeHandles.entries()) {
			if (!handle.promptPreviewEl) {
				continue;
			}
			const raw = prompts[nodeId] ?? '';
			const trimmed = raw.trim();
			const hasPrompt = trimmed.length > 0;
			const singleLine = hasPrompt ? trimmed.replace(/\s+/g, ' ') : '';
			const nextPreview = hasPrompt
				? singleLine
				: adeBi(localize('adeMissionTaskEmptyDescShortHint', "Click to edit details…"), '点击编辑任务详情…');
			if (handle.promptPreviewEl.textContent !== nextPreview) {
				handle.promptPreviewEl.textContent = nextPreview;
			}
			handle.promptPreviewEl.classList.toggle('is-empty', !hasPrompt);
		}
	}

	private getRenderedNodeSize(nodeId: string, fallbackNode?: IMissionDagNode): { readonly width: number; readonly height: number } {
		const cached = this.orchNodeSizeById.get(nodeId);
		if (cached) {
			return cached;
		}
		if (fallbackNode) {
			return getMissionNodeSize(fallbackNode);
		}
		const handle = this.nodeHandles.get(nodeId);
		return handle ? getMissionNodeSize(handle.node) : { width: MISSION_TASK_CARD_WIDTH, height: MISSION_TASK_CARD_HEIGHT };
	}

	private getConnectDragHost(): IConnectDragHost {
		return {
			worldEl: this.worldEl,
			connectPreviewPathEl: this.connectPreviewPathEl,
			graphDisposables: this.graphDisposables,
			connectDragDisposables: this.connectDragDisposables,
			orchAnchorButtons: this.orchAnchorButtons,
			getDirection: () => this.lastDirection,
			getZoom: () => this.callbacks.getZoom(),
			getNodePosition: id => this.callbacks.getNodePosition(id),
			getRenderedNodeSize: (id, fb) => this.getRenderedNodeSize(id, fb),
			getNodeRootEl: id => this.nodeHandles.get(id)?.rootEl,
			getCandidateNodeEntries: () => [...this.nodeHandles.entries()].map(([id, h]) => [id, h.node] as const),
			getOrchNodes: () => this.lastOrchNodes,
			isRevisionPreview: this.callbacks.isRevisionPreview,
			onConnectNodes: this.callbacks.onConnectNodes,
		};
	}

	private bindOutPortConnectDrag(node: IMissionDagNode, outPortEl: HTMLButtonElement): void {
		bindMissionOutPortConnectDrag(node, outPortEl, this.getConnectDragHost());
	}

	private bindMultiAnchorConnectDrag(
		oNode: IOrchestrationGraphNode,
		anchorEl: HTMLButtonElement,
		side: OrchestrationAnchorSide,
		slot: number,
	): void {
		bindOrchMultiAnchorConnectDrag(oNode, anchorEl, side, slot, this.getConnectDragHost());
	}

	private bindNodeInteractions(handle: IRenderedNodeHandle): void {
		const nodeEl = handle.rootEl;
		const win = getWindow(nodeEl);
		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!this.callbacks.onNodeContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.callbacks.onNodeContextMenu(handle.node, e.clientX, e.clientY);
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerenter', () => {
			this.callbacks.onHoverNode(handle.node.id);
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerleave', () => {
			if (this.hoveredNodeId === handle.node.id) {
				this.callbacks.onHoverNode(undefined);
			}
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.DRAG_START, (e: DragEvent) => {
			const targetEl = resolveEventTargetElement(e.target);
			if (targetEl?.closest('.ade-mission-inline-rename-input')) {
				return;
			}
			e.preventDefault();
		}));

		let pendingDrag = false;
		let activeDrag = false;
		let startedOnSubInteractive = false;
		let startedWithMultiModifier = false;
		let activePointerId = 0;
		let startClientX = 0;
		let startClientY = 0;
		let dragGroupIds: readonly string[] = [handle.node.id];
		const dragStartPosById = new Map<string, IMissionNodePosition>();
		const dragSizeById = new Map<string, { readonly width: number; readonly height: number }>();
		let stationaryAlignRects: IMissionAlignRect[] = [];
		let suppressNextClick = false;
		let suppressClickTimer: number | undefined;

		const clearSuppressNextClick = () => {
			suppressNextClick = false;
			if (suppressClickTimer !== undefined) {
				win.clearTimeout(suppressClickTimer);
				suppressClickTimer = undefined;
			}
		};
		const armSuppressNextClick = () => {
			clearSuppressNextClick();
			suppressNextClick = true;
			suppressClickTimer = win.setTimeout(() => {
				suppressClickTimer = undefined;
				suppressNextClick = false;
			}, 0);
		};
		this.graphDisposables.add(toDisposable(() => clearSuppressNextClick()));

		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.CLICK, (e: MouseEvent) => {
			if (!suppressNextClick) {
				return;
			}
			clearSuppressNextClick();
			e.preventDefault();
			e.stopPropagation();
		}, true));

		const clearDraggingClasses = () => {
			for (const id of dragGroupIds) {
				this.nodeHandles.get(id)?.rootEl.classList.remove('dragging');
			}
		};

		const restoreCancelledPositions = () => {
			const restores: Array<{ readonly nodeId: string; readonly pos: IMissionNodePosition }> = [];
			for (const [id, sp] of dragStartPosById.entries()) {
				const h = this.nodeHandles.get(id);
				if (h) {
					h.rootEl.style.left = `${sp.x}px`;
					h.rootEl.style.top = `${sp.y}px`;
				}
				restores.push({ nodeId: id, pos: sp });
			}
			if (restores.length > 0) {
				if (this.callbacks.onDragNodesMove) {
					this.callbacks.onDragNodesMove(restores);
				} else {
					this.callbacks.onDragNodeMove(restores[0].nodeId, restores[0].pos);
				}
			}
		};

		const finishInteraction = (endEv: PointerEvent | undefined, cancelled: boolean) => {
			if (!pendingDrag) {
				return;
			}
			pendingDrag = false;
			const wasActiveDrag = activeDrag;
			activeDrag = false;
			const pointerId = activePointerId;
			const finishedGroup = dragGroupIds;
			this.nodeDragDisposables.clear();
			this.clearAlignGuides();
			if (wasActiveDrag) {
				clearDraggingClasses();
				try {
					if (nodeEl.hasPointerCapture?.(pointerId)) {
						nodeEl.releasePointerCapture(pointerId);
					}
				} catch { /* ignore */ }
				armSuppressNextClick();
				if (cancelled) {
					// Restore pre-drag coordinates on pointercancel/blur so cancelled gestures never jump to (0,0)!
					restoreCancelledPositions();
					if (this.callbacks.onEndNodesDrag) {
						this.callbacks.onEndNodesDrag(finishedGroup, 0);
					} else {
						this.callbacks.onEndNodeDrag(handle.node.id, 0);
					}
					return;
				}
				const movedPx = endEv ? Math.hypot(endEv.clientX - startClientX, endEv.clientY - startClientY) : NODE_DRAG_THRESHOLD_PX;
				const effectiveMoved = Math.max(NODE_DRAG_THRESHOLD_PX, movedPx);
				if (this.callbacks.onEndNodesDrag) {
					this.callbacks.onEndNodesDrag(finishedGroup, effectiveMoved);
				} else {
					this.callbacks.onEndNodeDrag(handle.node.id, effectiveMoved);
				}
				return;
			}
			if (!cancelled && !startedOnSubInteractive) {
				const curNode = handle.node;
				if (startedWithMultiModifier && this.callbacks.onSelectNode) {
					this.callbacks.onSelectNode(curNode, nodeEl, { toggleMulti: true });
					return;
				}
				if (this.lastViewMode === 'mission') {
					// Route Gate pods with active waiting_gate token to Gate Decision Popover (previously dead code!)
					const hasWaitingGateToken = curNode.kind === 'gate' && (
						handle.nodeState === 'waiting_gate'
						|| Object.values(this.lastRuntimeState?.tokens ?? {}).some(t => t.nodeId === curNode.id && t.status === 'waiting_gate')
					);
					if (hasWaitingGateToken) {
						this.callbacks.onSelectNode?.(curNode, nodeEl);
						this.callbacks.onOpenGateDecisionPopover(curNode, nodeEl);
						return;
					}
					if (this.callbacks.onOpenMissionTaskPopover) {
						this.callbacks.onSelectNode?.(curNode, nodeEl);
						this.callbacks.onOpenMissionTaskPopover(curNode, nodeEl);
						return;
					}
				}
				if (this.lastViewMode === 'orchestration' && handle.whiteboard && this.callbacks.onOpenWhiteboardPopover) {
					this.callbacks.onSelectNode?.(curNode, nodeEl);
					this.callbacks.onOpenWhiteboardPopover(handle.whiteboard, nodeEl);
					return;
				}
				if (curNode.kind === 'gate' && handle.nodeState === 'waiting_gate') {
					this.callbacks.onOpenGateDecisionPopover(curNode, nodeEl);
				} else if (this.callbacks.onSelectNode) {
					this.callbacks.onSelectNode(curNode, nodeEl);
				} else if (handle.linkedAgent) {
					this.callbacks.onOpenAgentSession(handle.linkedAgent.id);
				}
			}
		};

		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 || this.callbacks.isRevisionPreview?.()) {
				return;
			}
			const targetEl = resolveEventTargetElement(e.target);
			if (targetEl?.closest(NODE_DRAG_EXCLUSION_SELECTOR)) {
				return;
			}
			e.stopPropagation();
			clearSuppressNextClick();
			this.nodeDragDisposables.clear();

			pendingDrag = true;
			activeDrag = false;
			startedOnSubInteractive = Boolean(targetEl?.closest(NODE_SUB_INTERACTIVE_SELECTOR));
			startedWithMultiModifier = Boolean(e.shiftKey || e.metaKey || e.ctrlKey);
			activePointerId = e.pointerId;
			startClientX = e.clientX;
			startClientY = e.clientY;
			dragGroupIds = [handle.node.id];
			dragStartPosById.clear();
			dragSizeById.clear();
			stationaryAlignRects = [];

			this.nodeDragDisposables.add(toDisposable(() => {
				this.clearAlignGuides();
				if (activeDrag) {
					activeDrag = false;
					pendingDrag = false;
					clearDraggingClasses();
					try {
						if (nodeEl.hasPointerCapture?.(activePointerId)) {
							nodeEl.releasePointerCapture(activePointerId);
						}
					} catch { /* ignore */ }
					if (this.callbacks.onEndNodesDrag) {
						this.callbacks.onEndNodesDrag(dragGroupIds, 0);
					} else {
						this.callbacks.onEndNodeDrag(handle.node.id, 0);
					}
				} else {
					pendingDrag = false;
				}
			}));

			this.nodeDragDisposables.add(addDisposableListener(win, EventType.POINTER_MOVE, (mv: PointerEvent) => {
				if (!pendingDrag || mv.pointerId !== activePointerId) {
					return;
				}
				const dx = mv.clientX - startClientX;
				const dy = mv.clientY - startClientY;
				if (!activeDrag) {
					if (Math.hypot(dx, dy) < NODE_DRAG_THRESHOLD_PX) {
						return;
					}
					activeDrag = true;
					const requestedGroup = this.callbacks.getDragGroupNodeIds?.(handle.node.id);
					dragGroupIds = requestedGroup && requestedGroup.length > 0 && requestedGroup.includes(handle.node.id)
						? [...requestedGroup]
						: [handle.node.id];
					const movingSet = new Set(dragGroupIds);
					dragStartPosById.clear();
					dragSizeById.clear();
					for (const id of dragGroupIds) {
						const h = this.nodeHandles.get(id);
						const pos = this.callbacks.getNodePosition(id) ?? { x: 240, y: 240 };
						dragStartPosById.set(id, { x: pos.x, y: pos.y });
						dragSizeById.set(id, this.getRenderedNodeSize(id, h?.node ?? handle.node));
						h?.rootEl.classList.add('dragging');
					}
					stationaryAlignRects = [];
					for (const [otherId, otherHandle] of this.nodeHandles.entries()) {
						if (movingSet.has(otherId)) {
							continue;
						}
						const otherPos = this.callbacks.getNodePosition(otherId);
						if (!otherPos) {
							continue;
						}
						const osz = this.getRenderedNodeSize(otherId, otherHandle.node);
						stationaryAlignRects.push({
							id: otherId,
							minX: otherPos.x - osz.width / 2,
							maxX: otherPos.x + osz.width / 2,
							minY: otherPos.y - osz.height / 2,
							maxY: otherPos.y + osz.height / 2,
						});
					}
					this.callbacks.onStartNodeDrag();
					try {
						nodeEl.setPointerCapture(activePointerId);
					} catch { /* synthetic events */ }
				}
				const zoom = this.callbacks.getZoom();
				const rawDx = dx / zoom;
				const rawDy = dy / zoom;

				let snapDx = 0;
				let snapDy = 0;
				if (!mv.altKey && stationaryAlignRects.length > 0) {
					let minX = Infinity;
					let maxX = -Infinity;
					let minY = Infinity;
					let maxY = -Infinity;
					for (const id of dragGroupIds) {
						const sp = dragStartPosById.get(id);
						const sz = dragSizeById.get(id);
						if (!sp || !sz) {
							continue;
						}
						const nx = sp.x + rawDx;
						const ny = sp.y + rawDy;
						minX = Math.min(minX, nx - sz.width / 2);
						maxX = Math.max(maxX, nx + sz.width / 2);
						minY = Math.min(minY, ny - sz.height / 2);
						maxY = Math.max(maxY, ny + sz.height / 2);
					}
					if (Number.isFinite(minX)) {
						const snap = computeNodeDragSnapAlignment({ minX, maxX, minY, maxY }, stationaryAlignRects, 8);
						snapDx = snap.dx;
						snapDy = snap.dy;
						this.renderAlignGuides(snap.guides);
					} else {
						this.clearAlignGuides();
					}
				} else {
					this.clearAlignGuides();
				}

				const appliedDx = Math.round(rawDx + snapDx);
				const appliedDy = Math.round(rawDy + snapDy);
				const moves: Array<{ readonly nodeId: string; readonly pos: IMissionNodePosition }> = [];
				for (const id of dragGroupIds) {
					const sp = dragStartPosById.get(id) ?? { x: 240, y: 240 };
					const nextPos: IMissionNodePosition = { x: sp.x + appliedDx, y: sp.y + appliedDy };
					const h = this.nodeHandles.get(id);
					if (h) {
						h.rootEl.style.left = `${nextPos.x}px`;
						h.rootEl.style.top = `${nextPos.y}px`;
					}
					moves.push({ nodeId: id, pos: nextPos });
				}
				if (this.callbacks.onDragNodesMove) {
					this.callbacks.onDragNodesMove(moves);
				} else if (moves.length > 0) {
					this.callbacks.onDragNodeMove(moves[0].nodeId, moves[0].pos);
				}
			}));

			this.nodeDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, (upEv: PointerEvent) => {
				if (!pendingDrag || upEv.pointerId !== activePointerId) {
					return;
				}
				finishInteraction(upEv, false);
			}));
			this.nodeDragDisposables.add(addDisposableListener(win, 'pointercancel', (cancelEv: PointerEvent) => {
				if (!pendingDrag || cancelEv.pointerId !== activePointerId) {
					return;
				}
				finishInteraction(cancelEv, true);
			}));
			this.nodeDragDisposables.add(addDisposableListener(nodeEl, 'lostpointercapture', (capEv: PointerEvent) => {
				if (!pendingDrag || !activeDrag || capEv.pointerId !== activePointerId) {
					return;
				}
				finishInteraction(capEv, true);
			}));
			this.nodeDragDisposables.add(addDisposableListener(win, EventType.BLUR, () => {
				if (!pendingDrag) {
					return;
				}
				finishInteraction(undefined, true);
			}));
		}));

		if (handle.node.kind !== 'gate') {
			this.graphDisposables.add(addDisposableListener(nodeEl, EventType.DBLCLICK, e => {
				const targetEl = resolveEventTargetElement(e.target);
				if (targetEl?.closest(NODE_SUB_INTERACTIVE_SELECTOR)) {
					return;
				}
				if (handle.linkedAgent) {
					e.stopPropagation();
					this.callbacks.onDoubleClickNode?.(handle.node, handle.linkedAgent.id);
				} else if (this.lastViewMode === 'mission' && handle.assigneeStaffId && this.callbacks.onJumpToOrchestrationStaff) {
					e.stopPropagation();
					this.callbacks.onJumpToOrchestrationStaff(handle.assigneeStaffId);
				}
			}));
		}
	}

	updateEdgesSvg(
		nodes: readonly IMissionDagNode[],
		edges: readonly IMissionDagEdge[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
		options?: { readonly movedNodeId?: string; readonly direction?: 'LR' | 'TD' },
	): void {
		if (this.lastViewMode === 'orchestration') {
			this.updateOrchestrationEdgesSvg(this.lastOrchNodes, this.lastOrchEdges, this.lastOrchDepartments, positions, {
				direction: options?.direction ?? this.lastDirection,
				layoutMode: this.lastOrchLayoutMode,
				movedNodeId: options?.movedNodeId,
			});
			return;
		}
		const direction = options?.direction ?? this.lastDirection;
		const edgeCtx = {
			edgesLayerEl: this.edgesLayerEl,
			tokenGliderLayerEl: this.tokenGliderLayerEl,
			edgeDisposables: this.edgeDisposables,
			edgeHandles: this.edgeHandles,
			tokenGliderHandles: this.tokenGliderHandles,
			livePuckHandles: this.livePuckHandles,
			lastNodeObstacleById: this.lastNodeObstacleById,
			orchNodeSizeById: this.orchNodeSizeById,
			getNodeHostAttr: (nodeId: string) => this.nodeHandles.get(nodeId)?.rootEl.getAttribute('data-node-host') ?? '',
			lastTaskStatuses: this.lastTaskStatuses,
			orchRuntime: this.lastOrchRuntime,
			criticalEdgeKeys: this.lastDagSignals?.criticalEdgeKeys ?? new Set<string>(),
			selectedEdgeKey: this.selectedEdgeKey,
			animationsPaused: this.animationsPaused,
			clearGliderDom: () => this.clearGliderDom(),
			onSelectEdge: this.callbacks.onSelectEdge,
			onRenameEdgeLabel: this.callbacks.onRenameEdgeLabel,
			onEdgeContextMenu: this.callbacks.onEdgeContextMenu,
			isRevisionPreview: this.callbacks.isRevisionPreview,
			startInlineEdgeLabelEdit: (edgeId: string) => this.startInlineEdgeLabelEdit(edgeId),
			onOpenOrchestrationTokenPopover: this.callbacks.onOpenOrchestrationTokenPopover,
			getLiveOrchToken: (tokenId: string) => this.lastOrchRuntime?.tokens?.[tokenId],
			resolveStaffLabel: (staffId: string) => this.resolveStaffLabel(staffId),
			lastEdgeStructureKey: this.lastEdgeStructureKey,
		};
		const { rebuilt } = syncMissionEdgesSvg(nodes, edges, positions, direction, options?.movedNodeId, edgeCtx);
		this.lastEdgeStructureKey = edgeCtx.lastEdgeStructureKey;

		if (rebuilt) {
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
		}
		this.renderCloudTerritories(nodes, positions);

		if (this.hoveredNodeId && (rebuilt || !options?.movedNodeId || this.contextLinksLayerEl.childElementCount > 0)) {
			this.applyHoverHighlight(this.hoveredNodeId, nodes, positions);
		} else if (this.pinnedDepTraceNodeId || this.hoveredDepTraceNodeId) {
			this.applyDepChainTraceHighlight();
		}
	}

	private computeTransitiveTrace(rootId: string): { readonly ancestorIds: Set<string>; readonly descendantIds: Set<string>; readonly traceEdgeKeys: Set<string> } {
		const ancestorIds = new Set<string>();
		const descendantIds = new Set<string>();
		const traceEdgeKeys = new Set<string>();

		const incoming = new Map<string, string[]>();
		const outgoing = new Map<string, string[]>();
		for (const h of this.edgeHandles.values()) {
			const inc = incoming.get(h.edge.to) ?? [];
			inc.push(h.edge.from);
			incoming.set(h.edge.to, inc);
			const out = outgoing.get(h.edge.from) ?? [];
			out.push(h.edge.to);
			outgoing.set(h.edge.from, out);
		}

		// Upstream BFS
		const upQ = [rootId];
		while (upQ.length > 0) {
			const cur = upQ.shift()!;
			for (const prev of incoming.get(cur) ?? []) {
				traceEdgeKeys.add(`${prev}->${cur}`);
				if (prev !== rootId && !ancestorIds.has(prev)) {
					ancestorIds.add(prev);
					upQ.push(prev);
				}
			}
		}
		// Downstream BFS
		const downQ = [rootId];
		while (downQ.length > 0) {
			const cur = downQ.shift()!;
			for (const nxt of outgoing.get(cur) ?? []) {
				traceEdgeKeys.add(`${cur}->${nxt}`);
				if (nxt !== rootId && !descendantIds.has(nxt)) {
					descendantIds.add(nxt);
					downQ.push(nxt);
				}
			}
		}
		return { ancestorIds, descendantIds, traceEdgeKeys };
	}

	private togglePinnedDepTrace(nodeId: string): void {
		this.pinnedDepTraceNodeId = this.pinnedDepTraceNodeId === nodeId ? undefined : nodeId;
		this.applyDepChainTraceHighlight();
		for (const [id, h] of this.nodeHandles.entries()) {
			h.taskRefs?.depBtnEl?.classList.toggle('is-trace-pinned', this.pinnedDepTraceNodeId === id);
		}
	}

	private setHoveredDepTrace(nodeId: string | undefined): void {
		this.hoveredDepTraceNodeId = nodeId;
		this.applyDepChainTraceHighlight();
	}

	private applyDepChainTraceHighlight(): void {
		const targetId = this.hoveredDepTraceNodeId ?? this.pinnedDepTraceNodeId;
		if (!targetId) {
			this.worldEl.classList.remove('has-dep-trace');
			for (const h of this.nodeHandles.values()) {
				h.rootEl.classList.remove('is-ancestor', 'is-descendant', 'is-trace-highlighted');
			}
			for (const h of this.edgeHandles.values()) {
				if (!this.hoveredTraceEdgeKeys?.has(`${h.edge.from}->${h.edge.to}`)) {
					h.group.classList.remove('is-trace-highlighted');
				}
			}
			return;
		}
		const { ancestorIds, descendantIds, traceEdgeKeys } = this.computeTransitiveTrace(targetId);
		this.worldEl.classList.add('has-dep-trace');
		for (const [id, h] of this.nodeHandles.entries()) {
			const isAnc = ancestorIds.has(id);
			const isDesc = descendantIds.has(id);
			h.rootEl.classList.toggle('is-ancestor', isAnc);
			h.rootEl.classList.toggle('is-descendant', isDesc);
			h.rootEl.classList.toggle('is-trace-highlighted', id === targetId || isAnc || isDesc);
		}
		for (const h of this.edgeHandles.values()) {
			const key = `${h.edge.from}->${h.edge.to}`;
			const hit = traceEdgeKeys.has(key) || Boolean(this.hoveredTraceEdgeKeys?.has(key));
			h.group.classList.toggle('is-trace-highlighted', hit);
		}
	}

	applyHoverHighlight(
		nodeId: string | undefined,
		nodes: readonly IMissionDagNode[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
	): void {
		this.hoveredNodeId = nodeId;
		this.worldEl.classList.toggle('has-node-hover', Boolean(nodeId));

		const hoveredHandle = nodeId ? this.nodeHandles.get(nodeId) : undefined;
		const isHoveredWhiteboard = Boolean(hoveredHandle?.wbRefs);
		const upstreamIds = new Set<string>();
		const downstreamIds = new Set<string>();
		const wbNeighborIds = new Set<string>();
		const raisedGroups: SVGGElement[] = [];

		// Optional 2-tier transitive ancestors/descendants for Task DAG clarity (direct 1-hop remains brightest!)
		const transitive = (nodeId && this.lastViewMode === 'mission') ? this.computeTransitiveTrace(nodeId) : undefined;

		for (const handle of this.edgeHandles.values()) {
			const { group, path, edge } = handle;
			const isIncoming = Boolean(nodeId && edge.to === nodeId);
			const isOutgoing = Boolean(nodeId && edge.from === nodeId);
			const isConnected = isIncoming || isOutgoing;
			const key = `${edge.from}->${edge.to}`;
			const isTransitiveEdge = Boolean(!isConnected && transitive?.traceEdgeKeys.has(key));

			group.classList.toggle('is-hover-flow', isConnected);
			group.classList.toggle('is-incoming', isIncoming);
			group.classList.toggle('is-outgoing', isOutgoing);
			group.classList.toggle('is-hover-path', isTransitiveEdge);

			if (isIncoming) {
				upstreamIds.add(edge.from);
				if (isHoveredWhiteboard || handle.isWhiteboardLink) {
					wbNeighborIds.add(edge.from);
				}
				path.setAttribute('marker-end', handle.isWhiteboardLink ? 'url(#ade-mission-arrow-whiteboard)' : 'url(#ade-mission-arrow-in)');
				raisedGroups.push(group);
			} else if (isOutgoing) {
				downstreamIds.add(edge.to);
				if (isHoveredWhiteboard || handle.isWhiteboardLink) {
					wbNeighborIds.add(edge.to);
				}
				path.setAttribute('marker-end', handle.isWhiteboardLink ? 'url(#ade-mission-arrow-whiteboard)' : 'url(#ade-mission-arrow-out)');
				raisedGroups.push(group);
			} else {
				const isSelected = Boolean(this.selectedEdgeKey && key === this.selectedEdgeKey);
				if (isSelected) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				} else if (this.hoveredTraceEdgeKeys?.has(key)) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-trace)');
				} else if (group.classList.contains('is-fail-taken')) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-fail)');
				} else if (group.classList.contains('is-token-flowing')) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				} else {
					// Restore exact cached canonical marker (preserves status & custom preset colors!)
					path.setAttribute('marker-end', handle.baseMarkerEnd);
				}
			}
		}

		// When hovering a Whiteboard, also illuminate any Staff currently referencing `wb:<id>` via live tokens!
		if (isHoveredWhiteboard && nodeId && this.lastOrchDerived) {
			for (const readerStaffId of this.lastOrchDerived.wbActiveReadersById.get(nodeId) ?? []) {
				wbNeighborIds.add(readerStaffId);
			}
		}

		for (const g of raisedGroups) {
			this.edgesLayerEl.appendChild(g);
		}

		while (this.contextLinksLayerEl.firstChild) {
			this.contextLinksLayerEl.removeChild(this.contextLinksLayerEl.firstChild);
		}

		let sameEmployeeIds: ReadonlySet<string> = new Set<string>();
		let reuseChainIds: ReadonlySet<string> = new Set<string>();
		let reuseRouteBelow = false;

		if (this.lastViewMode === 'mission' && nodeId) {
			const reuseRes = renderSameEmployeeContextReuseOverlay(this.contextLinksLayerEl, nodeId, nodes, positions);
			sameEmployeeIds = reuseRes.sameEmployeeIds;
			reuseChainIds = reuseRes.reuseChainIds;
			reuseRouteBelow = reuseRes.reuseRouteBelow;
		}

		for (const [id, handle] of this.nodeHandles.entries()) {
			const isHovered = Boolean(nodeId && id === nodeId);
			const isUp = upstreamIds.has(id);
			const isDown = downstreamIds.has(id);
			const isWbNeighbor = wbNeighborIds.has(id);
			const isAnc = Boolean(!isUp && transitive?.ancestorIds.has(id));
			const isDesc = Boolean(!isDown && transitive?.descendantIds.has(id));
			const isSameEmp = sameEmployeeIds.has(id);
			const inReuse = reuseChainIds.has(id);
			handle.rootEl.classList.toggle('is-hovered', isHovered);
			handle.rootEl.classList.toggle('is-neighbor', isUp || isDown || isWbNeighbor);
			handle.rootEl.classList.toggle('is-upstream', isUp);
			handle.rootEl.classList.toggle('is-downstream', isDown);
			handle.rootEl.classList.toggle('is-wb-neighbor', isWbNeighbor);
			handle.rootEl.classList.toggle('is-ancestor', isAnc);
			handle.rootEl.classList.toggle('is-descendant', isDesc);
			handle.rootEl.classList.toggle('is-same-employee', isSameEmp);
			handle.rootEl.classList.toggle('has-ctx-port-top', inReuse && !reuseRouteBelow);
			handle.rootEl.classList.toggle('has-ctx-port-bottom', inReuse && reuseRouteBelow);
		}

		// Preserve pinned or hovered dependency-chain trace after leaving a hovered node!
		if (!nodeId && (this.pinnedDepTraceNodeId || this.hoveredDepTraceNodeId)) {
			this.applyDepChainTraceHighlight();
		}
	}

	// =========================================================================
	// View 1: Sculpted Mission Task DAG (O(N) In-Place Diff + Structural Rebuild)
	// =========================================================================

	private syncMissionTaskGraphDom(snapshot: IMissionCanvasRenderSnapshot, forceRebuild: boolean): void {
		const direction = snapshot.direction ?? this.lastDirection;
		const signals = computeMissionTaskDagSignals(
			snapshot.nodes,
			snapshot.edges,
			direction,
			snapshot.taskStatuses,
			snapshot.orchestrationRuntime,
		);
		this.lastDagSignals = signals;

		const nextStructureKey = `mission\x1e` + snapshot.nodes
			.map(n => `${n.id}\x1f${n.kind}\x1f${n.department ? '1' : '0'}`)
			.join('\x1e');

		const canPatchInPlace = !forceRebuild
			&& nextStructureKey === this.lastGraphStructureKey
			&& this.nodeHandles.size === snapshot.nodes.length
			&& snapshot.nodes.every(n => Boolean(this.nodeHandles.get(n.id)?.taskRefs));

		const taskBuildCtx: ITaskCardBuildContext = {
			nodesLayerEl: this.nodesLayerEl,
			graphDisposables: this.graphDisposables,
			applyCustomNodeColor: (el, c) => this.applyCustomNodeColor(el, c),
			mountNodeColorTrigger: (p, id, lbl, c, st) => this.mountNodeColorTrigger(p, id, lbl, c, st),
			bindOutPortConnectDrag: (n, outPort) => this.bindOutPortConnectDrag(n, outPort),
			startInlineNodeRename: id => this.startInlineNodeRename(id),
			getEffectiveNodeChecksCount: this.callbacks.getEffectiveNodeChecksCount,
			resolveStaffLabel: id => this.resolveStaffLabel(id),
			onOpenMissionTaskPopover: this.callbacks.onOpenMissionTaskPopover,
			onOpenOrchestrationTokenPopover: this.callbacks.onOpenOrchestrationTokenPopover,
			onJumpToOrchestrationStaff: this.callbacks.onJumpToOrchestrationStaff,
			onToggleDepTrace: id => this.togglePinnedDepTrace(id),
			onHoverDepTrace: id => this.setHoveredDepTrace(id),
			onRenameNodeAvailable: Boolean(this.callbacks.onRenameNode),
		};

		if (canPatchInPlace) {
			for (const node of snapshot.nodes) {
				const handle = this.nodeHandles.get(node.id)!;
				const pos = snapshot.positions.get(node.id) ?? { x: 270, y: 260 };
				const statusRec = snapshot.taskStatuses?.[node.id];
				const liveToks = signals.activeTokensByTaskId.get(node.id) ?? [];
				handle.node = node;
				handle.nodeState = statusRec?.status ?? 'pending';
				handle.assigneeStaffId = liveToks[0]?.nodeId ?? statusRec?.assigneeNodeId ?? node.assigneeNodeId ?? node.ownerNodeId;
				handle.linkedAgent = handle.assigneeStaffId ? snapshot.agentByNodeId.get(handle.assigneeStaffId) : snapshot.agentByNodeId.get(node.id);
				this.orchNodeSizeById.set(node.id, getMissionNodeSize(node));
				patchMissionTaskCardDom(handle.taskRefs!, {
					node,
					pos,
					rawDesc: (snapshot.nodePrompts[node.id] ?? '').trim(),
					statusRec,
					allTaskStatuses: snapshot.taskStatuses,
					signals,
					pinnedDepTraceNodeId: this.pinnedDepTraceNodeId,
				}, taskBuildCtx);
			}
			this.updateEdgesSvg(snapshot.nodes, snapshot.edges, snapshot.positions, { direction });
			return;
		}

		// Structural rebuild (only when viewMode or node topology changed!)
		this.nodeDragDisposables.clear();
		this.graphDisposables.clear();
		this.edgeDisposables.clear();
		this.deptDisposables.clear();
		this.deptHandles.clear();
		this.deptPillRectById.clear();
		this.connectDragDisposables.clear();
		this.inlineRenameDisposables.clear();
		this.clearInlineEdgeEditor();
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.clearGliderDom();
		this.orchAnchorButtons.clear();
		this.orchNodeSizeById.clear();
		this.lastEdgeStructureKey = '';
		this.lastGraphStructureKey = nextStructureKey;
		if (this.hoveredNodeId && !snapshot.nodes.some(n => n.id === this.hoveredNodeId)) {
			this.hoveredNodeId = undefined;
		}
		if (this.pinnedDepTraceNodeId && !snapshot.nodes.some(n => n.id === this.pinnedDepTraceNodeId)) {
			this.pinnedDepTraceNodeId = undefined;
		}
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}

		for (const node of snapshot.nodes) {
			const pos = snapshot.positions.get(node.id) ?? { x: 270, y: 260 };
			const statusRec = snapshot.taskStatuses?.[node.id];
			const liveToks = signals.activeTokensByTaskId.get(node.id) ?? [];
			const assigneeStaffId = liveToks[0]?.nodeId ?? statusRec?.assigneeNodeId ?? node.assigneeNodeId ?? node.ownerNodeId;
			this.orchNodeSizeById.set(node.id, getMissionNodeSize(node));
			const taskRefs = buildMissionTaskCardDom({
				node,
				pos,
				rawDesc: (snapshot.nodePrompts[node.id] ?? '').trim(),
				statusRec,
				allTaskStatuses: snapshot.taskStatuses,
				signals,
				pinnedDepTraceNodeId: this.pinnedDepTraceNodeId,
			}, taskBuildCtx);

			const handle: IRenderedNodeHandle = {
				node,
				rootEl: taskRefs.rootEl,
				titleEl: taskRefs.titleEl,
				promptPreviewEl: taskRefs.promptPreviewEl,
				taskRefs,
				linkedAgent: assigneeStaffId ? snapshot.agentByNodeId.get(assigneeStaffId) : snapshot.agentByNodeId.get(node.id),
				assigneeStaffId,
				nodeState: statusRec?.status ?? 'pending',
			};
			this.nodeHandles.set(node.id, handle);
			this.bindNodeInteractions(handle);
		}

		this.reapplyTransientNodeOverlays();
		this.updateEdgesSvg(snapshot.nodes, snapshot.edges, snapshot.positions, { direction });
		if (this.hoveredNodeId) {
			this.applyHoverHighlight(this.hoveredNodeId, snapshot.nodes, snapshot.positions);
		}
	}

	// =========================================================================
	// View 2: All-Staff Engineering Orchestration + Whiteboards (O(N) In-Place)
	// =========================================================================

	private syncOrchestrationGraphDom(snapshot: IMissionCanvasRenderSnapshot, forceRebuild: boolean): void {
		const orchNodes = snapshot.orchestrationNodes ?? [];
		const orchEdges = snapshot.orchestrationEdges ?? [];
		const departments = snapshot.orchestrationDepartments ?? [];
		const whiteboards = snapshot.whiteboards ?? {};
		const orchRuntime = snapshot.orchestrationRuntime;

		const derived = buildOrchGraphDerivedIndex(orchEdges, snapshot.nodes, snapshot.taskStatuses, orchRuntime);
		this.lastOrchDerived = derived;

		const nextStructureKey = `orch\x1e` + orchNodes.map(n => `${n.id}\x1f${n.kind}`).join('\x1e');
		const canPatchInPlace = !forceRebuild
			&& nextStructureKey === this.lastGraphStructureKey
			&& this.nodeHandles.size === orchNodes.length
			&& orchNodes.every(n => {
				const h = this.nodeHandles.get(n.id);
				return Boolean(h && (n.kind === 'whiteboard' ? h.wbRefs : h.staffRefs));
			});

		const orchBuildCtx: IOrchCardBuildContext = {
			nodesLayerEl: this.nodesLayerEl,
			graphDisposables: this.graphDisposables,
			hostCatalog: this.hostCatalog,
			orchAnchorButtons: this.orchAnchorButtons,
			applyCustomNodeColor: (el, c) => this.applyCustomNodeColor(el, c),
			mountNodeColorTrigger: (p, id, lbl, c, st) => this.mountNodeColorTrigger(p, id, lbl, c, st),
			bindMultiAnchorConnectDrag: (on, btn, side, slot) => this.bindMultiAnchorConnectDrag(on, btn, side, slot),
			startInlineNodeRename: id => this.startInlineNodeRename(id),
			onOpenWhiteboardPopover: this.callbacks.onOpenWhiteboardPopover,
			onOpenOrchestrationTokenPopover: this.callbacks.onOpenOrchestrationTokenPopover,
			onOpenModelPopover: (nid, ag, eid, el, o) => this.callbacks.onOpenModelPopover(nid, ag, eid, el, o),
			onOpenEnginePopover: (nid, ag, eid, el, o) => this.callbacks.onOpenEnginePopover(nid, ag, eid, el, o),
			onOpenHostPopover: (n, host, el) => this.callbacks.onOpenHostPopover(n, host, el),
			onJumpToMissionTask: this.callbacks.onJumpToMissionTask,
			onRenameNodeAvailable: Boolean(this.callbacks.onRenameNode),
		};

		const makeCompatDagNode = (oNode: IOrchestrationGraphNode): IMissionDagNode => ({
			id: oNode.id,
			label: oNode.label,
			kind: 'task',
			employeeName: oNode.employeeName,
			employeeKey: oNode.employeeKey,
		});

		const resolveWb = (oNode: IOrchestrationGraphNode): IOrchestrationWhiteboard => whiteboards[oNode.id] ?? {
			id: oNode.id,
			title: oNode.label,
			department: oNode.department || 'General',
			content: '',
			version: oNode.whiteboardVersion ?? 0,
			createdAt: 0,
			updatedAt: 0,
		};

		if (canPatchInPlace) {
			for (const oNode of orchNodes) {
				const handle = this.nodeHandles.get(oNode.id)!;
				const pos = snapshot.positions.get(oNode.id) ?? { x: 280, y: 260 };
				const compatDagNode = makeCompatDagNode(oNode);
				handle.node = compatDagNode;
				this.orchNodeSizeById.set(oNode.id, getRenderedOrchestrationNodeSize(oNode));
				if (oNode.kind === 'whiteboard' && handle.wbRefs) {
					const wb = resolveWb(oNode);
					handle.whiteboard = wb;
					patchOrchWhiteboardCardDom(handle.wbRefs, { oNode, pos, wb, derived }, orchBuildCtx);
				} else if (handle.staffRefs) {
					const linkedAgent = snapshot.agentByNodeId.get(oNode.id);
					handle.linkedAgent = linkedAgent;
					handle.nodeState = orchRuntime?.nodeStates[oNode.id] ?? 'idle';
					patchOrchStaffCardDom(handle.staffRefs, {
						oNode,
						pos,
						compatDagNode,
						linkedAgent,
						runtimeState: snapshot.runtimeState,
						orchRuntime,
						fallbackOwnerEngineId: snapshot.fallbackOwnerEngineId,
						orgConfig: snapshot.orgConfig,
						hasSubordinates: snapshot.hasSubordinates,
						canSwitchEngineFn: snapshot.canSwitchEngine,
						canSwitchModel: snapshot.canSwitchModel,
						canSwitchHost: snapshot.canSwitchHost,
						derived,
						resolveNodeLabel: id => this.resolveStaffLabel(id),
					}, orchBuildCtx);
				}
			}
			this.updateOrchestrationEdgesSvg(orchNodes, orchEdges, departments, snapshot.positions, {
				direction: snapshot.direction ?? this.lastDirection,
				layoutMode: snapshot.orchestrationLayoutMode,
			});
			return;
		}

		// Structural rebuild (only when viewMode or orchestration node IDs/kinds changed!)
		this.nodeDragDisposables.clear();
		this.graphDisposables.clear();
		this.edgeDisposables.clear();
		this.deptDisposables.clear();
		this.deptHandles.clear();
		this.deptPillRectById.clear();
		this.connectDragDisposables.clear();
		this.inlineRenameDisposables.clear();
		this.clearInlineEdgeEditor();
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.clearGliderDom();
		this.orchAnchorButtons.clear();
		this.orchNodeSizeById.clear();
		this.lastEdgeStructureKey = '';
		this.lastGraphStructureKey = nextStructureKey;
		if (this.hoveredNodeId && !orchNodes.some(n => n.id === this.hoveredNodeId)) {
			this.hoveredNodeId = undefined;
		}
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}

		for (const oNode of orchNodes) {
			const pos = snapshot.positions.get(oNode.id) ?? { x: 280, y: 260 };
			const compatDagNode = makeCompatDagNode(oNode);
			this.orchNodeSizeById.set(oNode.id, getRenderedOrchestrationNodeSize(oNode));

			if (oNode.kind === 'whiteboard') {
				const wb = resolveWb(oNode);
				const wbRefs = buildOrchWhiteboardCardDom({ oNode, pos, wb, derived }, orchBuildCtx);
				const handle: IRenderedNodeHandle = {
					node: compatDagNode,
					rootEl: wbRefs.rootEl,
					titleEl: wbRefs.titleEl,
					wbRefs,
					nodeState: 'idle',
					whiteboard: wb,
				};
				this.nodeHandles.set(oNode.id, handle);
				this.bindNodeInteractions(handle);
			} else {
				const linkedAgent = snapshot.agentByNodeId.get(oNode.id);
				const staffRefs = buildOrchStaffCardDom({
					oNode,
					pos,
					compatDagNode,
					linkedAgent,
					runtimeState: snapshot.runtimeState,
					orchRuntime,
					fallbackOwnerEngineId: snapshot.fallbackOwnerEngineId,
					orgConfig: snapshot.orgConfig,
					hasSubordinates: snapshot.hasSubordinates,
					canSwitchEngineFn: snapshot.canSwitchEngine,
					canSwitchModel: snapshot.canSwitchModel,
					canSwitchHost: snapshot.canSwitchHost,
					derived,
					resolveNodeLabel: id => this.resolveStaffLabel(id),
				}, orchBuildCtx);
				const handle: IRenderedNodeHandle = {
					node: compatDagNode,
					rootEl: staffRefs.rootEl,
					titleEl: staffRefs.titleEl,
					staffRefs,
					linkedAgent,
					nodeState: staffRefs.nodeState,
				};
				this.nodeHandles.set(oNode.id, handle);
				this.bindNodeInteractions(handle);
			}
		}

		this.reapplyTransientNodeOverlays();
		this.updateOrchestrationEdgesSvg(orchNodes, orchEdges, departments, snapshot.positions, {
			direction: snapshot.direction ?? this.lastDirection,
			layoutMode: snapshot.orchestrationLayoutMode,
		});
	}

	private updateOrchestrationEdgesSvg(
		nodes: readonly IOrchestrationGraphNode[],
		edges: readonly IOrchestrationGraphEdge[],
		departments: readonly IOrchestrationDepartmentGroup[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
		options?: { readonly direction?: 'LR' | 'TD'; readonly layoutMode?: OrchestrationLayoutMode; readonly movedNodeId?: string },
	): void {
		this.lastOrchDeptBounds = renderOrchestrationDepartmentRegions(nodes, departments, positions, {
			cloudTerritoriesLayerEl: this.cloudTerritoriesLayerEl,
			deptDisposables: this.deptDisposables,
			deptHandles: this.deptHandles,
			deptPillRectById: this.deptPillRectById,
			orchRuntime: this.lastOrchRuntime,
			bindDepartmentPillInteractions: (pillGroup, getDept, getMemberIds, getEmptyCenter) => {
				this.bindDepartmentPillInteractions(pillGroup, getDept, getMemberIds, getEmptyCenter);
			},
		});

		const orchEdgeCtx = {
			edgesLayerEl: this.edgesLayerEl,
			tokenGliderLayerEl: this.tokenGliderLayerEl,
			edgeDisposables: this.edgeDisposables,
			edgeHandles: this.edgeHandles,
			livePuckHandles: this.livePuckHandles,
			orchAnchorButtons: this.orchAnchorButtons,
			deptHandles: this.deptHandles,
			deptPillRectById: this.deptPillRectById,
			lastNodeObstacleById: this.lastNodeObstacleById,
			orchRuntime: this.lastOrchRuntime,
			selectedEdgeKey: this.selectedEdgeKey,
			animationsPaused: this.animationsPaused,
			clearGliderDom: () => this.clearGliderDom(),
			onSelectEdge: this.callbacks.onSelectEdge,
			onRenameEdgeLabel: this.callbacks.onRenameEdgeLabel,
			onEdgeContextMenu: this.callbacks.onEdgeContextMenu,
			startInlineEdgeLabelEdit: (edgeId: string) => this.startInlineEdgeLabelEdit(edgeId),
			onOpenOrchestrationTokenPopover: this.callbacks.onOpenOrchestrationTokenPopover,
			getLiveOrchToken: (tokenId: string) => this.lastOrchRuntime?.tokens?.[tokenId],
			resolveStaffLabel: (staffId: string) => this.resolveStaffLabel(staffId),
			seenTokenHopSignatures: this.seenTokenHopSignatures,
			registerOrchBurst: (burst: IEdgeTransitBurst, now: number) => this.registerOrchBurst(burst, now),
			lastEdgeStructureKey: this.lastEdgeStructureKey,
		};
		const { rebuilt } = syncOrchestrationEdgesSvg(
			nodes,
			edges,
			positions,
			options?.direction ?? this.lastDirection,
			options?.layoutMode ?? this.lastOrchLayoutMode,
			options?.movedNodeId,
			orchEdgeCtx,
		);
		this.lastEdgeStructureKey = orchEdgeCtx.lastEdgeStructureKey;

		// Preserve Engineering hover spotlight across live runtime ticks & edge rebuilds!
		if (this.hoveredNodeId && (rebuilt || !options?.movedNodeId)) {
			this.applyHoverHighlight(this.hoveredNodeId, this.lastDagNodes, positions);
		}
	}

	private bindDepartmentPillInteractions(
		pillGroup: SVGGElement,
		getDept: () => IOrchestrationDepartmentGroup,
		getMemberIds: () => readonly string[],
		getEmptyCenter: () => IMissionNodePosition | undefined,
	): void {
		const win = getWindow(this.worldEl);
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!this.callbacks.onGroupContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.callbacks.onGroupContextMenu(getDept(), e.clientX, e.clientY);
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.DBLCLICK, (e: MouseEvent) => {
			if (!this.callbacks.onRenameGroup || this.callbacks.isRevisionPreview?.()) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.startInlineGroupRename(getDept().id);
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.POINTER_DOWN, (downEv: PointerEvent) => {
			if (downEv.button !== 0 || this.callbacks.isRevisionPreview?.()) {
				return;
			}
			downEv.stopPropagation();
			downEv.preventDefault();
			const dept = getDept();
			const memberIds = getMemberIds();
			const emptyCenter = getEmptyCenter();
			const dragIds = memberIds.length > 0 ? [...memberIds] : [dept.id];
			const startClientX = downEv.clientX;
			const startClientY = downEv.clientY;
			const startPositions = new Map<string, IMissionNodePosition>();
			for (const id of dragIds) {
				const existingPos = this.callbacks.getNodePosition(id);
				if (existingPos) {
					startPositions.set(id, { x: existingPos.x, y: existingPos.y });
				} else if (id === dept.id && emptyCenter) {
					startPositions.set(id, { x: emptyCenter.x, y: emptyCenter.y });
				}
			}
			if (startPositions.size === 0) {
				return;
			}
			let activeDrag = false;
			this.nodeDragDisposables.clear();

			const clearDeptDragging = () => {
				for (const id of dragIds) {
					this.nodeHandles.get(id)?.rootEl.classList.remove('dragging');
				}
			};
			const restoreCancelled = () => {
				const restores: Array<{ readonly nodeId: string; readonly pos: IMissionNodePosition }> = [];
				for (const [id, sp] of startPositions.entries()) {
					const h = this.nodeHandles.get(id);
					if (h) {
						h.rootEl.style.left = `${sp.x}px`;
						h.rootEl.style.top = `${sp.y}px`;
					}
					restores.push({ nodeId: id, pos: sp });
				}
				if (this.callbacks.onDragNodesMove) {
					this.callbacks.onDragNodesMove(restores);
				} else {
					for (const m of restores) {
						this.callbacks.onDragNodeMove(m.nodeId, m.pos);
					}
				}
			};
			const cleanup = (endEv: PointerEvent | undefined, cancelled: boolean) => {
				const wasActive = activeDrag;
				activeDrag = false;
				this.nodeDragDisposables.clear();
				if (!wasActive) {
					return;
				}
				clearDeptDragging();
				if (cancelled) {
					restoreCancelled();
					if (this.callbacks.onEndNodesDrag) {
						this.callbacks.onEndNodesDrag(dragIds, 0);
					} else if (dragIds.length > 0) {
						this.callbacks.onEndNodeDrag(dragIds[0], 0);
					}
					return;
				}
				const movedPx = endEv ? Math.max(NODE_DRAG_THRESHOLD_PX, Math.hypot(endEv.clientX - startClientX, endEv.clientY - startClientY)) : NODE_DRAG_THRESHOLD_PX;
				if (this.callbacks.onEndNodesDrag) {
					this.callbacks.onEndNodesDrag(dragIds, movedPx);
				} else if (dragIds.length > 0) {
					this.callbacks.onEndNodeDrag(dragIds[0], movedPx);
				}
			};

			// Always register disposable cleanup hook so interrupted dept drags never leak `.dragging`!
			this.nodeDragDisposables.add(toDisposable(() => {
				if (activeDrag) {
					activeDrag = false;
					clearDeptDragging();
					if (this.callbacks.onEndNodesDrag) {
						this.callbacks.onEndNodesDrag(dragIds, 0);
					} else if (dragIds.length > 0) {
						this.callbacks.onEndNodeDrag(dragIds[0], 0);
					}
				}
			}));

			this.nodeDragDisposables.add(addDisposableListener(win, EventType.POINTER_MOVE, (mv: PointerEvent) => {
				const dist = Math.hypot(mv.clientX - startClientX, mv.clientY - startClientY);
				if (!activeDrag) {
					if (dist < NODE_DRAG_THRESHOLD_PX) {
						return;
					}
					activeDrag = true;
					this.callbacks.onStartNodeDrag();
					for (const id of dragIds) {
						this.nodeHandles.get(id)?.rootEl.classList.add('dragging');
					}
				}
				const zoom = Math.max(0.1, this.callbacks.getZoom());
				const dx = Math.round((mv.clientX - startClientX) / zoom);
				const dy = Math.round((mv.clientY - startClientY) / zoom);
				const moves: Array<{ readonly nodeId: string; readonly pos: IMissionNodePosition }> = [];
				for (const [id, sp] of startPositions.entries()) {
					const nextPos = { x: sp.x + dx, y: sp.y + dy };
					moves.push({ nodeId: id, pos: nextPos });
					const handle = this.nodeHandles.get(id);
					if (handle) {
						handle.rootEl.style.left = `${nextPos.x}px`;
						handle.rootEl.style.top = `${nextPos.y}px`;
					}
				}
				if (this.callbacks.onDragNodesMove) {
					this.callbacks.onDragNodesMove(moves);
				} else {
					for (const m of moves) {
						this.callbacks.onDragNodeMove(m.nodeId, m.pos);
					}
				}
			}));
			this.nodeDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, upEv => cleanup(upEv, false)));
			this.nodeDragDisposables.add(addDisposableListener(win, 'pointercancel', cancelEv => cleanup(cancelEv, true)));
			this.nodeDragDisposables.add(addDisposableListener(win, EventType.BLUR, () => cleanup(undefined, true)));
		}));
	}
}
