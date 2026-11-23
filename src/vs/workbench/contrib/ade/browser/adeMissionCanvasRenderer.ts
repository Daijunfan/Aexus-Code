/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AdeThinkingLevel } from '../../../../platform/ade/common/adeEngineering.js';
import {
	buildMissionContextReusePaths,
	computeMissionEdgeLabelLayout,
	computeMissionWorldSize,
	computeNodeDragSnapAlignment,
	computeOrthogonalRoundedEdgeRoute,
	getEmployeeColorIndex,
	getMissionEdgeKind,
	IMissionAlignGuide,
	IMissionAlignRect,
	IMissionContextReuseAnchor,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionEdgeObstacle,
	IMissionNodePosition,
	MISSION_GATE_NODE_HEIGHT,
	MISSION_GATE_NODE_WIDTH,
	MISSION_TASK_NODE_HEIGHT,
	MISSION_TASK_NODE_WIDTH,
} from '../../../../platform/ade/common/adeMissionDag.js';
import {
	computeMissionNodeContextBreakdown,
	formatCompactTokenCount,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	inferModelContextWindowTokens,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import { formatFinOpsUsd } from '../../../../platform/ade/common/adeModelPricing.js';
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
	computeOrchestrationAnchorPoint,
	computeOrchestrationMultiAnchorRoutes,
	getOrchestrationAnchorFraction,
	getOrchestrationNodeSize,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	ORCHESTRATION_ANCHOR_SIDES,
	ORCHESTRATION_SLOTS_PER_SIDE,
	OrchestrationAnchorSide,
	OrchestrationLayoutMode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { IAdeOrganizationConfig, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import {
	ADE_LLM_PROVIDER_LABELS,
	renderAdeLlmIcon,
	resolveEffectiveAdeLlmProvider,
} from '../../../browser/adeLlmIcon.js';
import { renderAdeOsIcon } from '../../../browser/adeOsIcon.js';
import { AdeEngineeringViewMode, IAdeAgent } from '../common/ade.js';
import { adeBi } from '../common/adeLocalization.js';
import {
	AdeMissionHostCatalog,
	applyMissionEngineIcon,
	MISSION_ENGINE_DEFAULT_MODELS,
} from './adeMissionHostCatalog.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_DRAG_THRESHOLD_PX = 5;
const NODE_DRAG_EXCLUSION_SELECTOR = '.ade-mission-inline-rename-input, .ade-mission-port.port-out.is-connectable, .ade-orch-anchor.is-connectable';
const NODE_SUB_INTERACTIVE_SELECTOR = 'button:not(:disabled), .ade-mission-core-model-row.is-editable, input, textarea, select, [contenteditable="true"]';
export const MISSION_EDGE_TRANSIT_DURATION_MS = 800;
const EDGE_TRANSIT_MAX_FUTURE_SKEW_MS = 5_000;
const MAX_SEEN_TOKEN_HOPS = 500;

interface IEdgeTransitBurst {
	readonly edgeKey: string;
	readonly edgeId: string;
	readonly tokenId: string;
	readonly waveId: string;
	readonly isFail: boolean;
	readonly hopSignature: string;
	readonly expiresAt: number;
}

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

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			el.setAttribute(k, v);
		}
	}
	return el;
}

export function getMissionNodeSize(node: IMissionDagNode): { readonly width: number; readonly height: number } {
	return node.kind === 'gate'
		? { width: MISSION_GATE_NODE_WIDTH, height: MISSION_GATE_NODE_HEIGHT }
		: { width: MISSION_TASK_NODE_WIDTH, height: MISSION_TASK_NODE_HEIGHT };
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
	onOpenMissionTaskPopover?(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenWhiteboardPopover?(whiteboard: IOrchestrationWhiteboard, anchorEl: HTMLElement): void;
	onOpenOrchestrationTokenPopover?(staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement): void;
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
	readonly node: IMissionDagNode;
	readonly rootEl: HTMLElement;
	readonly idWrapEl: HTMLElement;
	readonly titleEl: HTMLElement;
	readonly roleBadgeEl?: HTMLElement;
	readonly checksBadgeEl?: HTMLElement;
	readonly hostAlias?: string;
	readonly displayHost?: string;
	readonly osKind?: string;
	readonly osLabel?: string;
	readonly isRemoteHost?: boolean;
	linkedAgent: IAdeAgent | undefined;
	engineId: string;
	canSwitchEngine: boolean;
	canSwitchModel: boolean;
	lastRoleKind?: string;
	lastChecksCount?: number;
	stateDotEl: HTMLElement | undefined;
	nodeState: string;
	primaryToken: IMissionToken | undefined;
	allTokens: readonly IMissionToken[];
	boundSupervisorId: string | undefined;
	readonly supBtnEl?: HTMLButtonElement;
	readonly supDotEl?: HTMLElement;
	readonly supNameEl?: HTMLElement;
	readonly coreIconTileEl?: HTMLButtonElement;
	readonly coreLlmGlyphEl?: HTMLElement;
	readonly modelRowEl?: HTMLElement;
	readonly modelNameEl?: HTMLElement;
	readonly thinkingTagEl?: HTMLElement;
	readonly engineBadgeEl?: HTMLButtonElement;
	readonly engineIconEl?: HTMLElement;
	readonly engineNameEl?: HTMLElement;
	engineWarnDotEl?: HTMLElement;
	lastModel?: string;
	lastThinking?: AdeThinkingLevel;
	lastLlmProvider?: string;
	lastEngineBadgeKey?: string;
	readonly pacemakerPortEl?: HTMLButtonElement;
	readonly triggerBadgeEl: HTMLButtonElement;
	readonly triggerBadgeLabelEl: HTMLElement;
	readonly tokenPuckEl: HTMLButtonElement;
	readonly tokenPuckIconEl: HTMLElement;
	readonly tokenPuckLabelEl: HTMLElement;
	readonly tokenPuckExtraEl: HTMLElement;
	readonly joinCapsuleEl: HTMLElement;
	readonly joinDotsEl: HTMLElement;
	readonly joinCountEl: HTMLElement;
	lastJoinSignature: string;
	readonly bottomDockEl: HTMLElement;
	readonly blockedStripEl: HTMLButtonElement;
	readonly blockedWaveEl: HTMLElement;
	readonly blockedCountdownEl: HTMLElement;
	readonly blockedPidEl: HTMLElement;
	readonly blockedFileEl: HTMLElement;
	readonly blockedHostEl: HTMLElement;
	readonly failedStripEl: HTMLButtonElement;
	readonly failedWaveEl: HTMLElement;
	readonly failedReasonEl: HTMLElement;
	readonly recoveryBarEl: HTMLElement;
	readonly checkFailChipEl: HTMLButtonElement;
	readonly retryBtnEl: HTMLButtonElement;
	readonly guidedRetryBtnEl: HTMLButtonElement;
	readonly recallBtnEl: HTMLButtonElement;
	readonly gateMetaEl?: HTMLElement;
	readonly gateInlineActionsEl?: HTMLElement;
	readonly gateApproveBtnEl?: HTMLButtonElement;
	readonly gateApproveLabelEl?: HTMLElement;
	readonly gateRejectBtnEl?: HTMLButtonElement;
	readonly gateRejectLabelEl?: HTMLElement;
	readonly contextSummaryEl?: HTMLElement;
	readonly promptBtnEl?: HTMLButtonElement;
	readonly promptPreviewEl?: HTMLElement;
	readonly promptTagEl?: HTMLElement;
	readonly ctxRowEl?: HTMLElement;
	readonly ctxSegInitEl?: HTMLElement;
	readonly ctxSegTierEl?: HTMLElement;
	readonly ctxSegSourceEl?: HTMLElement;
	readonly ctxSegNoiseEl?: HTMLElement;
	readonly ctxTokensEl?: HTMLElement;
	readonly ctxCostEl?: HTMLElement;
	readonly ctxPctEl?: HTMLElement;
	readonly whiteboard?: IOrchestrationWhiteboard;
}

export function getMissionSupervisorColorIndex(supervisorId: string): number {
	let hash = 0;
	for (let i = 0; i < supervisorId.length; i++) {
		hash = ((hash << 5) - hash + supervisorId.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 6;
}

export function getMissionWaveColorIndex(waveId: string): number {
	const numMatch = /(\d+)$/.exec(waveId.trim());
	if (numMatch) {
		const parsed = Number.parseInt(numMatch[1], 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return (parsed - 1) % 6;
		}
	}
	let hash = 0;
	for (let i = 0; i < waveId.length; i++) {
		hash = ((hash << 5) - hash + waveId.charCodeAt(i)) | 0;
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
		return trigger.fireAt ? `Once` : 'Once';
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

export function formatMissionWaveTag(waveId: string): string {
	const trimmed = waveId.trim();
	const numMatch = /(\d+)$/.exec(trimmed);
	if (numMatch) {
		return `W${numMatch[1]}`;
	}
	return trimmed.length > 6 ? trimmed.slice(0, 6) : (trimmed || 'W?');
}

export function formatMissionBlockedRemaining(expiresAt: number, now: number): { readonly text: string; readonly isOverdue: boolean } {
	const remMs = expiresAt - now;
	if (!Number.isFinite(remMs) || remMs <= 0) {
		return { text: localize('adeMissionBlockedOverdue', "Overdue"), isOverdue: true };
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

export function extractMissionWatchFileBasename(filePath: string): string {
	const normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	const idx = normalized.lastIndexOf('/');
	const base = idx >= 0 ? normalized.slice(idx + 1) : normalized;
	return base.length > 24 ? `${base.slice(0, 21)}...` : base;
}

interface IRenderedEdgeHandle {
	readonly group: SVGGElement;
	readonly path: SVGPathElement;
	readonly hitPath: SVGPathElement;
	readonly labelBg?: SVGRectElement;
	readonly labelText?: SVGTextElement;
	readonly pillW: number;
	readonly edge: IMissionDagEdge;
	readonly isCrossHost: boolean;
	midX: number;
	midY: number;
	bbox: IMissionEdgeObstacle;
	lastFlowHopSignature?: string;
}

function boxesOverlap(a: IMissionEdgeObstacle, b: IMissionEdgeObstacle): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function computeRouteBbox(points: readonly { readonly x: number; readonly y: number }[], pad = 20): IMissionEdgeObstacle {
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

function samplePolylinePointAtFraction(
	points: readonly { readonly x: number; readonly y: number }[],
	fraction: number,
): { readonly x: number; readonly y: number } {
	if (points.length === 0) {
		return { x: 0, y: 0 };
	}
	if (points.length === 1) {
		return points[0];
	}
	const segLens: number[] = [];
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
		segLens.push(len);
		total += len;
	}
	if (total <= 0.01) {
		return points[0];
	}
	const clamped = Math.max(0.05, Math.min(0.95, fraction));
	let target = total * clamped;
	for (let i = 0; i < segLens.length; i++) {
		const len = segLens[i];
		if (target <= len || i === segLens.length - 1) {
			const t = len > 0.001 ? Math.max(0, Math.min(1, target / len)) : 0;
			return {
				x: Math.round((points[i].x + (points[i + 1].x - points[i].x) * t) * 10) / 10,
				y: Math.round((points[i].y + (points[i + 1].y - points[i].y) * t) * 10) / 10,
			};
		}
		target -= len;
	}
	return points[points.length - 1];
}

function resolveArrowMarkerUrlForColor(rawColor: string | undefined, fallbackId: string): string {
	const norm = normalizeAdeNodeColor(rawColor);
	if (norm && !norm.startsWith('#')) {
		return `url(#ade-mission-arrow-preset-${norm})`;
	}
	return `url(#${fallbackId})`;
}

/**
 * High-performance Mission DAG SVG & Armored Pod DOM renderer:
 * - Diff-tracks a structural graph key so live runtime/telemetry ticks patch node states,
 *   context progress bars, summary text, and pre-prompts IN PLACE (zero DOM teardown!).
 * - Updates SVG edge `<path d>` and label coordinates IN PLACE during node dragging
 *   without clearing or recreating SVG `<g>` subtrees.
 */
export class AdeMissionCanvasRenderer extends Disposable {
	private readonly graphDisposables = this._register(new DisposableStore());
	private readonly edgeDisposables = this._register(new DisposableStore());
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
	private readonly tokenGliderHandles = new Map<string, { readonly group: SVGGElement; readonly text: SVGTextElement; waveClass: string; hopSignature: string }>();
	private readonly seenTokenHopSignatures = new Set<string>();
	private readonly activeEdgeTransits = new Map<string, IEdgeTransitBurst>();
	private edgeTransitCleanupTimer: number | undefined;
	private trackedMissionId: string | undefined;
	private trackedMissionStartedAt: number | undefined;
	private trackedMissionTokenSeq = 0;
	private animationsPaused = false;
	private readonly lastNodeObstacleById = new Map<string, IMissionEdgeObstacle>();
	private lastEdgeStructureKey = '';
	private lastDirection: 'LR' | 'TD' = 'LR';
	private lastViewMode: AdeEngineeringViewMode = 'mission';
	private lastOrchNodes: readonly IOrchestrationGraphNode[] = [];
	private lastOrchEdges: readonly IOrchestrationGraphEdge[] = [];
	private readonly deptDisposables = this._register(new DisposableStore());
	private readonly deptPillRectById = new Map<string, { readonly dept: IOrchestrationDepartmentGroup; readonly x: number; readonly y: number; readonly w: number }>();
	private lastOrchDepartments: readonly IOrchestrationDepartmentGroup[] = [];
	private lastOrchLayoutMode: OrchestrationLayoutMode | undefined;
	private lastOrchRuntime: IOrchestrationRuntimeState | undefined;
	private lastTaskStatuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined;
	private readonly orchAnchorButtons = new Map<string, HTMLButtonElement>();
	private readonly orchNodeSizeById = new Map<string, { readonly width: number; readonly height: number }>();
	private hoveredNodeId: string | undefined;
	private selectedNodeIds = new Set<string>();
	private selectedEdgeKey: string | undefined;
	private searchMatchNodeIds: ReadonlySet<string> | undefined;
	private hoveredTraceEdgeKeys: ReadonlySet<string> | undefined;
	private lastRuntimeState: IMissionRuntimeState | undefined;
	private showCloudTerritories = true;
	private previewAddedNodeIds: ReadonlySet<string> | undefined;
	private focusPulseNodeId: string | undefined;
	private focusPulseTimer: ReturnType<typeof setTimeout> | undefined;

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
		this._register({
			dispose: () => {
				this.clearInlineEdgeEditor();
				this.clearAlignGuides();
				this.clearEdgeTransitTimer();
				this.activeEdgeTransits.clear();
				this.seenTokenHopSignatures.clear();
				if (this.focusPulseTimer !== undefined) {
					clearTimeout(this.focusPulseTimer);
					this.focusPulseTimer = undefined;
				}
			},
		});
	}

	private clearEdgeTransitTimer(): void {
		if (this.edgeTransitCleanupTimer !== undefined) {
			getWindow(this.worldEl).clearTimeout(this.edgeTransitCleanupTimer);
			this.edgeTransitCleanupTimer = undefined;
		}
	}

	private clearGliderDom(): void {
		this.tokenGliderHandles.clear();
		while (this.tokenGliderLayerEl.firstChild) {
			this.tokenGliderLayerEl.removeChild(this.tokenGliderLayerEl.firstChild);
		}
	}

	setAnimationsPaused(paused: boolean): void {
		if (this.animationsPaused === paused) {
			return;
		}
		this.animationsPaused = paused;
		if (paused) {
			this.clearEdgeTransitTimer();
		} else if (this.edgeHandles.size > 0) {
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
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
			// Razor-crisp tapered aerospace dart chevron
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
		this.graphDisposables.add(addDisposableListener(btn, EventType.CLICK, e => {
			e.stopPropagation();
			this.callbacks.onOpenNodeColorPopover?.(nodeId, label, rawColor, btn);
		}));
	}

	invalidateStructure(): void {
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

	/**
	 * Synchronizes the canvas DOM with the latest graph & runtime snapshot.
	 * Uses O(N) in-place DOM patching when graph topology & node metadata are unchanged,
	 * avoiding full DOM teardown during live Mission execution telemetry updates.
	 */
	syncGraph(snapshot: IMissionCanvasRenderSnapshot, forceFullRebuild = false): void {
		const viewMode: AdeEngineeringViewMode = snapshot.viewMode ?? 'mission';
		const isOrch = viewMode === 'orchestration';
		const effectiveCount = isOrch
			? ((snapshot.orchestrationNodes?.length ?? 0) + (snapshot.orchestrationDepartments?.length ?? 0))
			: snapshot.nodes.length;
		const hasNodes = effectiveCount > 0;
		this.emptyHintEl.hidden = hasNodes;

		const worldSize = computeMissionWorldSize([...snapshot.positions.values()]);
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
			this.lastOrchNodes = [];
			this.lastOrchEdges = [];
			this.lastOrchDepartments = [];
			this.lastOrchRuntime = undefined;
			this.orchAnchorButtons.clear();
			this.orchNodeSizeById.clear();
			this.clearAllDom();
			return;
		}

		this.lastRuntimeState = snapshot.runtimeState;
		const nextDirection = snapshot.direction ?? 'LR';
		this.lastDirection = nextDirection;
		this.worldEl.classList.toggle('dir-td', nextDirection === 'TD');
		this.worldEl.dataset.dagDirection = nextDirection;

		if (isOrch) {
			this.lastOrchNodes = snapshot.orchestrationNodes ?? [];
			this.lastOrchEdges = snapshot.orchestrationEdges ?? [];
			this.lastOrchDepartments = snapshot.orchestrationDepartments ?? [];
			this.lastOrchRuntime = snapshot.orchestrationRuntime;
			this.rebuildOrchestrationGraphDom(snapshot);
			return;
		}

		// Mission Task DAG mode (pure Task nodes, zero employee/runtime clutter)
		this.lastOrchNodes = [];
		this.lastOrchEdges = [];
		this.lastOrchDepartments = [];
		this.lastOrchRuntime = undefined;
		this.orchAnchorButtons.clear();
		this.orchNodeSizeById.clear();
		void modeChanged;
		void forceFullRebuild;
		this.rebuildMissionTaskGraphDom(snapshot);
	}

	setTraceHighlightEdges(edgeKeys: ReadonlySet<string> | undefined): void {
		this.hoveredTraceEdgeKeys = edgeKeys && edgeKeys.size > 0 ? edgeKeys : undefined;
		this.worldEl.classList.toggle('has-trace-hover', Boolean(this.hoveredTraceEdgeKeys));
		this.patchEdgeRuntimeStates(this.lastRuntimeState);
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
			}
		}
		if (!edgeKey) {
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
		}
	}

	setSearchMatches(matchNodeIds: ReadonlySet<string> | undefined, activeMatchNodeId: string | undefined): void {
		this.searchMatchNodeIds = matchNodeIds && matchNodeIds.size > 0 ? matchNodeIds : undefined;
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
			placeholder: localize('adeMissionInlineEdgeLabelPlaceholder', "边标签 (如 fail / spec，留空清除)"),
			'data-ade-inline-edge-rename': `${edge.from}->${edge.to}`,
			'aria-label': localize('adeMissionInlineEdgeRenameAria', "Edit label for edge {0} to {1}", edge.from, edge.to),
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
		if (this.focusPulseTimer !== undefined) {
			clearTimeout(this.focusPulseTimer);
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
		this.focusPulseTimer = setTimeout(() => {
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
			'aria-label': localize('adeMissionInlineRenameAria', "Rename node {0}", nodeId),
		})) as HTMLInputElement;
		let done = false;
		const finish = (commit: boolean) => {
			if (done) {
				return;
			}
			done = true;
			this.inlineRenameDisposables.clear();
			const nextVal = input.value.trim();
			clearNode(titleEl);
			titleEl.textContent = originalLabel;
			titleEl.title = originalLabel;
			if (commit && nextVal && nextVal !== originalLabel) {
				this.callbacks.onRenameNode?.(nodeId, nextVal);
			}
		};
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
		const supAnchorPos = new Map<string, { readonly x: number; readonly y: number; readonly tier: number }>();
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
			const colorIdx = getMissionSupervisorColorIndex(sup.id);
			const disp = resolveSupervisorDisplay?.(sup.id) ?? { label: sup.id, shortLabel: sup.id, tier: sup.tier };
			let anchorX = Math.round(sumX / managedBoxes.length);
			for (const prevX of usedAnchorXs) {
				if (Math.abs(anchorX - prevX) < 176) {
					anchorX = prevX + 184;
				}
			}
			usedAnchorXs.push(anchorX);
			const anchorY = Math.max(66, Math.min(minY - 72, (Number.isFinite(globalMinY) ? globalMinY : minY) - 62));
			supAnchorPos.set(sup.id, { x: anchorX, y: anchorY, tier: sup.tier });

			const supGroup = svgEl('g', {
				class: `ade-mission-sup-xray-group sup-color-${colorIdx}`,
				'data-supervisor-xray': sup.id,
			});

			// Jurisdiction Cluster Halo around all managed nodes
			const padX = 18;
			const padY = 18;
			supGroup.appendChild(svgEl('rect', {
				class: 'ade-mission-sup-cluster-halo',
				x: String(Math.round(minX - padX)),
				y: String(Math.round(minY - padY)),
				width: String(Math.round(maxX - minX + padX * 2)),
				height: String(Math.round(maxY - minY + padY * 2)),
				rx: '16',
				ry: '16',
			}));

			// Dashed X-Ray Command Beams from off-graph Supervisor anchor to each managed node
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
				supGroup.appendChild(svgEl('circle', {
					class: 'ade-mission-sup-beam-dot',
					cx: String(targetX),
					cy: String(targetY),
					r: '3.5',
				}));
			}

			// Floating Off-Graph Supervisor Crown Pill (includes parentSupervisorId indicator when chained)
			const parentDisp = sup.parentSupervisorId
				? (resolveSupervisorDisplay?.(sup.parentSupervisorId) ?? { label: sup.parentSupervisorId, shortLabel: sup.parentSupervisorId, tier: supById.get(sup.parentSupervisorId)?.tier ?? 0 })
				: undefined;
			const badgeLabel = parentDisp
				? `👑 ${formatTierTag(sup.tier)} ${disp.shortLabel} ↑ ${parentDisp.shortLabel}`
				: `👑 ${formatTierTag(sup.tier)} ${disp.shortLabel} (${managedBoxes.length})`;
			const pillW = Math.max(132, Math.min(280, badgeLabel.length * 7.6 + 22));
			supGroup.appendChild(svgEl('rect', {
				class: 'ade-mission-sup-anchor-bg',
				x: String(Math.round(anchorX - pillW / 2)),
				y: String(Math.round(anchorY - 13)),
				width: String(Math.round(pillW)),
				height: '26',
				rx: '13',
			}));
			const anchorText = svgEl('text', {
				class: 'ade-mission-sup-anchor-text',
				x: String(anchorX),
				y: String(anchorY + 0.5),
			});
			anchorText.textContent = badgeLabel;
			supGroup.appendChild(anchorText);
			this.supervisorBeamsLayerEl.appendChild(supGroup);
		}

		// Render upper parentSupervisorId crown pills (for parent-only off-graph supervisors) + hierarchy beams!
		const usedParentXs: number[] = [];
		for (const sup of boundSups) {
			if (!sup.parentSupervisorId) {
				continue;
			}
			const childPos = supAnchorPos.get(sup.id);
			if (!childPos) {
				continue;
			}
			let parentPos = supAnchorPos.get(sup.parentSupervisorId);
			if (!parentPos) {
				const parentSup = supById.get(sup.parentSupervisorId);
				const pTier = parentSup?.tier ?? 0;
				const pDisp = resolveSupervisorDisplay?.(sup.parentSupervisorId) ?? { label: sup.parentSupervisorId, shortLabel: sup.parentSupervisorId, tier: pTier };
				const pColorIdx = getMissionSupervisorColorIndex(sup.parentSupervisorId);
				let px = childPos.x;
				for (const prevX of usedParentXs) {
					if (Math.abs(px - prevX) < 180) {
						px = prevX + 188;
					}
				}
				usedParentXs.push(px);
				const py = Math.max(20, childPos.y - 46);
				parentPos = { x: px, y: py, tier: pTier };
				supAnchorPos.set(sup.parentSupervisorId, parentPos);

				const pGroup = svgEl('g', {
					class: `ade-mission-sup-xray-group sup-color-${pColorIdx} is-parent-supervisor`,
					'data-supervisor-xray': sup.parentSupervisorId,
				});
				const pLabel = `👑 ${formatTierTag(pTier)} ${pDisp.shortLabel} (上级监工)`;
				const pW = Math.max(140, Math.min(260, pLabel.length * 7.8 + 22));
				pGroup.appendChild(svgEl('rect', {
					class: 'ade-mission-sup-anchor-bg',
					x: String(Math.round(px - pW / 2)),
					y: String(Math.round(py - 13)),
					width: String(Math.round(pW)),
					height: '26',
					rx: '13',
				}));
				const pText = svgEl('text', {
					class: 'ade-mission-sup-anchor-text',
					x: String(px),
					y: String(py + 0.5),
				});
				pText.textContent = pLabel;
				pGroup.appendChild(pText);
				this.supervisorBeamsLayerEl.appendChild(pGroup);
			}

			const linkGroup = svgEl('g', {
				class: 'ade-mission-sup-xray-group is-hierarchy-link',
			});
			const midX = Math.round((parentPos.x + childPos.x) / 2);
			const midY = Math.round((parentPos.y + childPos.y) / 2);
			linkGroup.appendChild(svgEl('path', {
				class: 'ade-mission-sup-parent-beam',
				'data-supervisor-parent-beam': `${sup.id}->${sup.parentSupervisorId}`,
				d: `M ${parentPos.x} ${parentPos.y + 13} Q ${midX} ${midY} ${childPos.x} ${childPos.y - 13}`,
			}));
			this.supervisorBeamsLayerEl.appendChild(linkGroup);
		}
	}

	patchBlockedCountdowns(runtimeState: IMissionRuntimeState | undefined, now = Date.now()): void {
		this.lastRuntimeState = runtimeState;
		if (!runtimeState) {
			return;
		}
		for (const handle of this.nodeHandles.values()) {
			const tok = handle.primaryToken;
			if (!tok || tok.status !== 'blocked' || !tok.blocked) {
				continue;
			}
			const rem = formatMissionBlockedRemaining(tok.blocked.expiresAt, now);
			const stripText = `⏳ ${rem.text}`;
			if (handle.blockedCountdownEl.textContent !== stripText) {
				handle.blockedCountdownEl.textContent = stripText;
			}
			handle.blockedCountdownEl.classList.toggle('is-overdue', rem.isOverdue);
			const waveTag = formatMissionWaveTag(tok.waveId);
			const puckText = `${waveTag} · ${rem.text}`;
			if (handle.tokenPuckLabelEl.textContent !== puckText) {
				handle.tokenPuckLabelEl.textContent = puckText;
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
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.tokenGliderHandles.clear();
		this.lastNodeObstacleById.clear();
		this.lastEdgeStructureKey = '';
		this.hoveredNodeId = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.searchMatchNodeIds = undefined;
		this.hoveredTraceEdgeKeys = undefined;
		this.worldEl.classList.remove('has-node-hover', 'has-trace-hover', 'has-supervisor-highlight', 'is-tab-spotlight-active', 'has-search-filter');
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl, this.tokenGliderLayerEl, this.alignGuidesLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}
	}

	private patchEdgeRuntimeStates(runtimeState: IMissionRuntimeState | undefined, now = Date.now()): void {
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
			const { group, path, edge, isCrossHost } = handle;
			const key = `${edge.from}->${edge.to}`;
			const burst = flowingEdgeBurstByKey.get(key);
			const isFlowing = flowingEdgeKeys.has(key);
			const isFailTaken = failTakenEdgeKeys.has(key);
			const isJoinArrived = joinArrivedEdgeKeys.has(key);
			const isSkipped = skippedEdgeKeys.has(key) && !isFlowing && !isJoinArrived;
			const isTraceHit = Boolean(traceKeys?.has(key));

			if (isFlowing && burst) {
				if (handle.lastFlowHopSignature !== burst.hopSignature && group.classList.contains('is-token-flowing')) {
					// Restart one-shot 800ms edge flow dash when a subsequent wave crosses the same edge mid-flight.
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

			// Trace hover takes arrow marker priority over node hover; otherwise preserve node-hover markers.
			const isNodeHoverConnected = Boolean(this.hoveredNodeId && (edge.to === this.hoveredNodeId || edge.from === this.hoveredNodeId));
			if (isSelectedEdge) {
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				raisedGroups.push(group);
			} else if (isTraceHit) {
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-trace)');
				raisedGroups.push(group);
			} else if (!isNodeHoverConnected) {
				if (isFailTaken || getMissionEdgeKind(edge) === 'fail') {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-fail)');
				} else if (isFlowing) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				} else if (isCrossHost) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-cloud)');
				} else {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-default)');
				}
			}
		}

		for (const g of raisedGroups) {
			this.edgesLayerEl.appendChild(g);
		}
		this.patchTokenGliders(flowingEdgeBurstByKey, now);
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
				// New hop across the same edge: recreate SVG group so the 800ms one-shot animation restarts cleanly.
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
				group.appendChild(svgEl('circle', {
					class: 'ade-mission-edge-puck-glow',
					cx: '0',
					cy: '0',
					r: '12',
				}));
				group.appendChild(svgEl('rect', {
					class: 'ade-mission-edge-puck-pill',
					x: '-15',
					y: '-8',
					width: '30',
					height: '16',
					rx: '8',
				}));
				const text = svgEl('text', {
					class: 'ade-mission-edge-puck-text',
					x: '0',
					y: '0.5',
				});
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
		while (this.cloudTerritoriesLayerEl.firstChild) {
			this.cloudTerritoriesLayerEl.removeChild(this.cloudTerritoriesLayerEl.firstChild);
		}
		if (!this.showCloudTerritories) {
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
			const handle = this.nodeHandles.get(node.id);
			const pos = positions.get(node.id);
			if (!handle || !pos || !handle.hostAlias) {
				continue;
			}
			const key = handle.hostAlias.toLowerCase();
			let grp = groups.get(key);
			if (!grp) {
				grp = {
					hostAlias: handle.hostAlias,
					displayHost: handle.displayHost ?? handle.hostAlias,
					osKind: handle.osKind ?? 'linux',
					osLabel: handle.osLabel ?? 'Linux',
					isRemote: Boolean(handle.isRemoteHost),
					members: [],
				};
				groups.set(key, grp);
			}
			const sz = getMissionNodeSize(node);
			grp.members.push({ x: pos.x, y: pos.y, w: sz.width, h: sz.height });
		}
		const hasAnyRemote = [...groups.values()].some(g => g.isRemote);
		if (!hasAnyRemote) {
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
			const padX = 32;
			const padTop = 40;
			const padBottom = 26;
			const boxX = Math.round(minX - padX);
			const boxY = Math.round(minY - padTop);
			const boxW = Math.round(maxX - minX + padX * 2);
			const boxH = Math.round(maxY - minY + padTop + padBottom);
			const territory = svgEl('g', {
				class: `ade-mission-cloud-territory os-${grp.osKind}${grp.isRemote ? ' is-remote' : ' is-local'}`,
				'data-cloud-territory': grp.hostAlias,
				'data-cloud-remote': String(grp.isRemote),
			});
			territory.appendChild(svgEl('rect', {
				class: 'ade-mission-cloud-contour',
				x: String(boxX),
				y: String(boxY),
				width: String(boxW),
				height: String(boxH),
				rx: '18',
				ry: '18',
			}));
			const titleText = grp.isRemote
				? `☁ @${grp.displayHost} · ${grp.osLabel} (${grp.members.length})`
				: `💻 Local · ${grp.osLabel} (${grp.members.length})`;
			const pillW = Math.max(118, Math.min(280, titleText.length * 6.9 + 22));
			territory.appendChild(svgEl('rect', {
				class: 'ade-mission-cloud-title-bg',
				x: String(boxX + 14),
				y: String(boxY - 11),
				width: String(Math.round(pillW)),
				height: '22',
				rx: '11',
			}));
			const labelEl = svgEl('text', {
				class: 'ade-mission-cloud-title-text',
				x: String(boxX + 25),
				y: String(boxY + 0.5),
			});
			labelEl.textContent = titleText;
			territory.appendChild(labelEl);
			this.cloudTerritoriesLayerEl.appendChild(territory);
		}
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
				: adeBi(localize('adeMissionTaskEmptyDescHint', "Click to view & edit task description…"), '点击查看并编辑任务详细描述…');
			if (handle.promptPreviewEl.textContent !== nextPreview) {
				handle.promptPreviewEl.textContent = nextPreview;
			}
			handle.promptPreviewEl.classList.toggle('is-empty', !hasPrompt);
			if (handle.promptBtnEl) {
				handle.promptBtnEl.classList.toggle('has-prompt', hasPrompt);
				handle.promptBtnEl.setAttribute('data-has-prompt', String(hasPrompt));
			}
		}
	}

	private bindOutPortConnectDrag(node: IMissionDagNode, outPortEl: HTMLButtonElement): void {
		this.graphDisposables.add(addDisposableListener(outPortEl, EventType.POINTER_DOWN, (downEv: PointerEvent) => {
			if (downEv.button !== 0 || !this.callbacks.onConnectNodes || this.callbacks.isRevisionPreview?.()) {
				return;
			}
			downEv.preventDefault();
			downEv.stopPropagation();
			const win = getWindow(outPortEl);
			const sourcePos = this.callbacks.getNodePosition(node.id);
			if (!sourcePos) {
				return;
			}
			const sourceSize = this.orchNodeSizeById.get(node.id) ?? getMissionNodeSize(node);
			const isVertical = this.lastDirection === 'TD';
			const startX = isVertical ? sourcePos.x : (sourcePos.x + sourceSize.width / 2);
			const startY = isVertical ? (sourcePos.y + sourceSize.height / 2) : sourcePos.y;
			let hoveredTargetId: string | undefined;

			const clientToWorld = (clientX: number, clientY: number): { readonly x: number; readonly y: number } => {
				const rect = this.worldEl.getBoundingClientRect();
				const zoom = Math.max(0.1, this.callbacks.getZoom());
				return {
					x: (clientX - rect.left) / zoom,
					y: (clientY - rect.top) / zoom,
				};
			};

			const hitTestTargetNode = (worldPt: { readonly x: number; readonly y: number }): string | undefined => {
				for (const [candidateId, candidateHandle] of this.nodeHandles.entries()) {
					if (candidateId === node.id) {
						continue;
					}
					const pos = this.callbacks.getNodePosition(candidateId);
					if (!pos) {
						continue;
					}
					const sz = this.orchNodeSizeById.get(candidateId) ?? getMissionNodeSize(candidateHandle.node);
					const pad = 16;
					if (
						worldPt.x >= pos.x - sz.width / 2 - pad
						&& worldPt.x <= pos.x + sz.width / 2 + pad
						&& worldPt.y >= pos.y - sz.height / 2 - pad
						&& worldPt.y <= pos.y + sz.height / 2 + pad
					) {
						return candidateId;
					}
				}
				return undefined;
			};

			const setTargetHighlight = (nextId: string | undefined): void => {
				if (hoveredTargetId === nextId) {
					return;
				}
				if (hoveredTargetId) {
					this.nodeHandles.get(hoveredTargetId)?.rootEl.classList.remove('is-connect-target');
				}
				hoveredTargetId = nextId;
				if (hoveredTargetId) {
					this.nodeHandles.get(hoveredTargetId)?.rootEl.classList.add('is-connect-target');
				}
			};

			const updatePreview = (clientX: number, clientY: number, isFail: boolean): void => {
				const pt = clientToWorld(clientX, clientY);
				const targetId = hitTestTargetNode(pt);
				setTargetHighlight(targetId);
				let endX = pt.x;
				let endY = pt.y;
				if (targetId) {
					const tPos = this.callbacks.getNodePosition(targetId);
					const tHandle = this.nodeHandles.get(targetId);
					if (tPos && tHandle) {
						const tSz = getMissionNodeSize(tHandle.node);
						endX = isVertical ? tPos.x : (tPos.x - tSz.width / 2 - 4);
						endY = isVertical ? (tPos.y - tSz.height / 2 - 4) : tPos.y;
					}
				}
				const route = computeOrthogonalRoundedEdgeRoute(startX, startY, endX, endY, {
					cornerRadius: 12,
					minStub: 20,
					orientation: isVertical ? 'vertical' : 'horizontal',
				});
				this.connectPreviewPathEl.setAttribute('d', route.path);
				this.connectPreviewPathEl.classList.toggle('is-fail', isFail);
				this.connectPreviewPathEl.setAttribute('marker-end', isFail ? 'url(#ade-mission-arrow-fail)' : 'url(#ade-mission-arrow-active)');
				this.connectPreviewPathEl.style.display = '';
			};

			this.connectDragDisposables.clear();
			this.worldEl.classList.add('is-connecting-edge');
			updatePreview(downEv.clientX, downEv.clientY, downEv.shiftKey);

			const cleanup = () => {
				setTargetHighlight(undefined);
				this.worldEl.classList.remove('is-connecting-edge');
				this.connectPreviewPathEl.style.display = 'none';
				this.connectDragDisposables.clear();
			};
			this.connectDragDisposables.add(addDisposableListener(win, EventType.POINTER_MOVE, (mv: PointerEvent) => {
				updatePreview(mv.clientX, mv.clientY, mv.shiftKey);
			}));
			const finishConnect = (upEv: PointerEvent) => {
				const pt = clientToWorld(upEv.clientX, upEv.clientY);
				const finalTarget = hoveredTargetId ?? hitTestTargetNode(pt);
				const asFail = upEv.shiftKey;
				cleanup();
				if (finalTarget && finalTarget !== node.id) {
					this.callbacks.onConnectNodes?.(node.id, finalTarget, { fail: asFail });
				}
			};
			this.connectDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, finishConnect));
			this.connectDragDisposables.add(addDisposableListener(win, 'pointercancel', () => cleanup()));
			this.connectDragDisposables.add(addDisposableListener(win, EventType.BLUR, () => cleanup()));
			this.connectDragDisposables.add(addDisposableListener(win, EventType.KEY_DOWN, (kev: KeyboardEvent) => {
				if (kev.key === 'Escape') {
					kev.preventDefault();
					cleanup();
				}
			}));
		}));
	}

	private bindNodeInteractions(
		handle: IRenderedNodeHandle,
	): void {
		const { node, rootEl: nodeEl } = handle;
		const win = getWindow(nodeEl);
		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!this.callbacks.onNodeContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.callbacks.onNodeContextMenu(node, e.clientX, e.clientY);
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerenter', () => {
			this.callbacks.onHoverNode(node.id);
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerleave', () => {
			if (this.hoveredNodeId === node.id) {
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
		let dragGroupIds: readonly string[] = [node.id];
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

		this.graphDisposables.add({ dispose: () => clearSuppressNextClick() });

		// Capture-phase click guard: suppresses the trailing browser-synthesized click after
		// a drag that started on an inner button/pill so dragging never opens a popover or action.
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
				const movedPx = endEv ? Math.hypot(endEv.clientX - startClientX, endEv.clientY - startClientY) : NODE_DRAG_THRESHOLD_PX;
				armSuppressNextClick();
				const effectiveMoved = Math.max(NODE_DRAG_THRESHOLD_PX, movedPx);
				if (this.callbacks.onEndNodesDrag) {
					this.callbacks.onEndNodesDrag(finishedGroup, effectiveMoved);
				} else {
					this.callbacks.onEndNodeDrag(node.id, effectiveMoved);
				}
				return;
			}
			if (!cancelled && !startedOnSubInteractive) {
				if (startedWithMultiModifier && this.callbacks.onSelectNode) {
					this.callbacks.onSelectNode(node, nodeEl, { toggleMulti: true });
					return;
				}
				if (this.lastViewMode === 'mission' && this.callbacks.onOpenMissionTaskPopover) {
					this.callbacks.onSelectNode?.(node, nodeEl);
					this.callbacks.onOpenMissionTaskPopover(node, nodeEl);
					return;
				}
				if (this.lastViewMode === 'orchestration' && handle.whiteboard && this.callbacks.onOpenWhiteboardPopover) {
					this.callbacks.onSelectNode?.(node, nodeEl);
					this.callbacks.onOpenWhiteboardPopover(handle.whiteboard, nodeEl);
					return;
				}
				// Clean single-click keeps user on the Canvas
				if (node.kind === 'gate' && handle.nodeState === 'waiting_gate') {
					this.callbacks.onOpenGateDecisionPopover(node, nodeEl);
				} else if (this.callbacks.onSelectNode) {
					this.callbacks.onSelectNode(node, nodeEl);
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
			dragGroupIds = [node.id];
			dragStartPosById.clear();
			dragSizeById.clear();
			stationaryAlignRects = [];

			this.nodeDragDisposables.add({
				dispose: () => {
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
							this.callbacks.onEndNodeDrag(node.id, 0);
						}
					} else {
						pendingDrag = false;
					}
				},
			});

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
					const requestedGroup = this.callbacks.getDragGroupNodeIds?.(node.id);
					dragGroupIds = requestedGroup && requestedGroup.length > 0 && requestedGroup.includes(node.id)
						? [...requestedGroup]
						: [node.id];
					const movingSet = new Set(dragGroupIds);
					dragStartPosById.clear();
					dragSizeById.clear();
					for (const id of dragGroupIds) {
						const h = this.nodeHandles.get(id);
						const pos = this.callbacks.getNodePosition(id) ?? { x: 240, y: 240 };
						dragStartPosById.set(id, { x: pos.x, y: pos.y });
						dragSizeById.set(id, this.orchNodeSizeById.get(id) ?? (h ? getMissionNodeSize(h.node) : getMissionNodeSize(node)));
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
						const osz = this.orchNodeSizeById.get(otherId) ?? getMissionNodeSize(otherHandle.node);
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
					const nextPos: IMissionNodePosition = {
						x: sp.x + appliedDx,
						y: sp.y + appliedDy,
					};
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

		if (node.kind !== 'gate') {
			this.graphDisposables.add(addDisposableListener(nodeEl, EventType.DBLCLICK, e => {
				const targetEl = resolveEventTargetElement(e.target);
				if (targetEl?.closest(NODE_SUB_INTERACTIVE_SELECTOR)) {
					return;
				}
				if (!handle.linkedAgent) {
					return;
				}
				e.stopPropagation();
				this.callbacks.onDoubleClickNode?.(node, handle.linkedAgent.id);
			}));
		}
	}

	/**
	 * Renders or patches SVG orthogonal edge paths.
	 * When edge topology & cross-host metadata match existing SVG handles (e.g. during dragging),
	 * updates `<path d>` and label coordinates IN PLACE with zero DOM creation or removal!
	 * When `options.movedNodeId` is supplied during an interactive drag frame, only edges incident
	 * to `movedNodeId` or intersecting its previous/current obstacle footprint are re-routed,
	 * and per-edge obstacle checks are culled by corridor bounding box.
	 */
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
			});
			return;
		}
		const direction = options?.direction ?? this.lastDirection;
		const isVertical = direction === 'TD';
		if (edges.length === 0) {
			this.edgeDisposables.clear();
			this.edgeHandles.clear();
			this.tokenGliderHandles.clear();
			this.lastNodeObstacleById.clear();
			this.lastEdgeStructureKey = '';
			while (this.edgesLayerEl.firstChild) {
				this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
			}
			while (this.tokenGliderLayerEl.firstChild) {
				this.tokenGliderLayerEl.removeChild(this.tokenGliderLayerEl.firstChild);
			}
			this.renderCloudTerritories(nodes, positions);
			return;
		}

		const nodeById = new Map(nodes.map(n => [n.id, n]));
		const allObstacles: { readonly id: string; readonly box: IMissionEdgeObstacle }[] = [];
		const currentObstacleById = new Map<string, IMissionEdgeObstacle>();
		for (const node of nodes) {
			const pos = positions.get(node.id);
			if (!pos) {
				continue;
			}
			const size = this.orchNodeSizeById.get(node.id) ?? getMissionNodeSize(node);
			const pad = 12;
			const box: IMissionEdgeObstacle = {
				minX: pos.x - size.width / 2 - pad,
				maxX: pos.x + size.width / 2 + pad,
				minY: pos.y - size.height / 2 - pad,
				maxY: pos.y + size.height / 2 + pad,
			};
			allObstacles.push({ id: node.id, box });
			currentObstacleById.set(node.id, box);
		}

		const edgeDescriptors = edges.map(edge => {
			const edgeKind = getMissionEdgeKind(edge);
			const fromHost = this.nodeHandles.get(edge.from)?.rootEl.getAttribute('data-node-host') ?? '';
			const toHost = this.nodeHandles.get(edge.to)?.rootEl.getAttribute('data-node-host') ?? '';
			const isCrossHost = Boolean(fromHost && toHost && fromHost.toLowerCase() !== toHost.toLowerCase());
			const fromSt = this.lastTaskStatuses?.[edge.from]?.status ?? '';
			const toSt = this.lastTaskStatuses?.[edge.to]?.status ?? '';
			const toCol = nodeById.get(edge.to)?.color ?? nodeById.get(edge.from)?.color ?? '';
			return { edge, edgeKind, isCrossHost, fromSt, toSt, toCol };
		});
		const nextEdgeStructureKey = `${direction}\x1e` + edgeDescriptors
			.map(d => `${d.edge.id}\x1f${d.edge.from}\x1f${d.edge.to}\x1f${d.edge.label ?? ''}\x1f${d.edgeKind}\x1f${d.isCrossHost ? '1' : '0'}\x1f${d.fromSt}\x1f${d.toSt}\x1f${d.toCol}`)
			.join('\x1e');

		const canPatchInPlace = nextEdgeStructureKey === this.lastEdgeStructureKey && this.edgeHandles.size > 0;
		if (!canPatchInPlace) {
			this.edgeDisposables.clear();
			this.edgeHandles.clear();
			this.clearGliderDom();
			this.lastNodeObstacleById.clear();
			while (this.edgesLayerEl.firstChild) {
				this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
			}
			this.lastEdgeStructureKey = nextEdgeStructureKey;
		}

		const movedNodeId = canPatchInPlace ? options?.movedNodeId : undefined;
		let movedDirtyBox: IMissionEdgeObstacle | undefined;
		if (movedNodeId) {
			const prevBox = this.lastNodeObstacleById.get(movedNodeId);
			const currBox = currentObstacleById.get(movedNodeId);
			const margin = 28;
			if (prevBox && currBox) {
				movedDirtyBox = {
					minX: Math.min(prevBox.minX, currBox.minX) - margin,
					maxX: Math.max(prevBox.maxX, currBox.maxX) + margin,
					minY: Math.min(prevBox.minY, currBox.minY) - margin,
					maxY: Math.max(prevBox.maxY, currBox.maxY) + margin,
				};
			} else if (currBox ?? prevBox) {
				const b = (currBox ?? prevBox)!;
				movedDirtyBox = {
					minX: b.minX - margin,
					maxX: b.maxX + margin,
					minY: b.minY - margin,
					maxY: b.maxY + margin,
				};
			}
		}

		for (const { edge, edgeKind, isCrossHost } of edgeDescriptors) {
			const existing = canPatchInPlace ? this.edgeHandles.get(edge.id) : undefined;
			if (movedNodeId && existing) {
				const isIncident = edge.from === movedNodeId || edge.to === movedNodeId;
				const intersectsMoved = movedDirtyBox ? boxesOverlap(existing.bbox, movedDirtyBox) : true;
				if (!isIncident && !intersectsMoved) {
					continue;
				}
			}

			const fromNode = nodeById.get(edge.from);
			const toNode = nodeById.get(edge.to);
			const fromPos = positions.get(edge.from);
			const toPos = positions.get(edge.to);
			if (!fromNode || !toNode || !fromPos || !toPos) {
				continue;
			}
			const fromSize = this.orchNodeSizeById.get(edge.from) ?? getMissionNodeSize(fromNode);
			const toSize = this.orchNodeSizeById.get(edge.to) ?? getMissionNodeSize(toNode);
			const x1 = isVertical ? fromPos.x : (fromPos.x + fromSize.width / 2);
			const y1 = isVertical ? (fromPos.y + fromSize.height / 2) : fromPos.y;
			const x2 = isVertical ? toPos.x : (toPos.x - toSize.width / 2 - 4);
			const y2 = isVertical ? (toPos.y - toSize.height / 2 - 4) : toPos.y;

			// Cull obstacles to the edge's routing corridor so per-edge routing stays O(local_k) instead of O(N).
			const corridorPadX = isVertical ? 96 : 48;
			const corridorPadY = isVertical ? 48 : 96;
			const corridor: IMissionEdgeObstacle = {
				minX: Math.min(x1, x2) - corridorPadX,
				maxX: Math.max(x1, x2) + corridorPadX,
				minY: Math.min(y1, y2) - corridorPadY,
				maxY: Math.max(y1, y2) + corridorPadY,
			};
			const obstacles: IMissionEdgeObstacle[] = [];
			for (const o of allObstacles) {
				if (o.id !== edge.from && o.id !== edge.to && boxesOverlap(o.box, corridor)) {
					obstacles.push(o.box);
				}
			}

			const route = computeOrthogonalRoundedEdgeRoute(x1, y1, x2, y2, {
				cornerRadius: this.lastViewMode === 'mission' ? 18 : 14,
				minStub: 24,
				orientation: isVertical ? 'vertical' : 'horizontal',
				obstacles,
			});
			const routeBbox = computeRouteBbox(route.points);

			if (existing) {
				existing.bbox = routeBbox;
				existing.midX = route.midX;
				existing.midY = route.midY;
				if (existing.path.getAttribute('d') !== route.path) {
					existing.path.setAttribute('d', route.path);
					existing.hitPath.setAttribute('d', route.path);
					const haloEl = existing.group.querySelector<SVGPathElement>('.ade-orch-edge-halo');
					if (haloEl) { haloEl.setAttribute('d', route.path); }
					const flowEl = existing.group.querySelector<SVGPathElement>('.ade-orch-edge-flow-stream');
					if (flowEl) { flowEl.setAttribute('d', route.path); }
					const glider = this.tokenGliderHandles.get(edge.id);
					if (glider) {
						glider.group.style.offsetPath = `path("${route.path}")`;
						glider.group.style.setProperty('offset-rotate', '0deg');
					}
				}
				if (existing.labelBg) {
					existing.labelBg.setAttribute('x', String(route.midX - existing.pillW / 2));
					existing.labelBg.setAttribute('y', String(route.midY - 10));
				}
				if (existing.labelText) {
					existing.labelText.setAttribute('x', String(route.midX));
					existing.labelText.setAttribute('y', String(route.midY));
				}
				continue;
			}

			const edgeClasses = ['ade-mission-edge-group'];
			if (edgeKind === 'fail') {
				edgeClasses.push('is-fail-edge');
			} else if (isCrossHost) {
				edgeClasses.push('is-cross-host');
			}
			const fromTaskStatus = this.lastTaskStatuses?.[edge.from]?.status;
			const toTaskStatus = this.lastTaskStatuses?.[edge.to]?.status;
			const isTaskCompletedFlow = edgeKind !== 'fail' && fromTaskStatus === 'completed' && toTaskStatus === 'completed';
			const isTaskLiveFlow = edgeKind !== 'fail' && fromTaskStatus === 'completed' && toTaskStatus === 'in_progress';
			const isTaskBlockedFlow = edgeKind !== 'fail' && (fromTaskStatus === 'blocked' || toTaskStatus === 'blocked');
			if (isTaskCompletedFlow) {
				edgeClasses.push('is-task-edge-completed');
			} else if (isTaskLiveFlow) {
				edgeClasses.push('is-task-edge-live');
			} else if (isTaskBlockedFlow) {
				edgeClasses.push('is-task-edge-blocked');
			}
			const edgeKey = `${edge.from}->${edge.to}`;
			if (this.selectedEdgeKey && this.selectedEdgeKey === edgeKey) {
				edgeClasses.push('is-selected');
			}
			const targetCustomHex = resolveAdeNodeColorHex(toNode.color ?? fromNode.color);
			const group = svgEl('g', {
				class: edgeClasses.join(' '),
				'data-edge-id': edge.id,
				'data-edge-kind': edgeKind,
				'data-cross-host': String(isCrossHost),
				'data-from': edge.from,
				'data-to': edge.to,
				...(this.selectedEdgeKey && this.selectedEdgeKey === edgeKey ? { 'data-edge-selected': 'true' } : {}),
			});
			const taskEdgeAccent = isTaskLiveFlow
				? (targetCustomHex ?? '#38bdf8')
				: isTaskCompletedFlow
					? '#34d399'
					: isTaskBlockedFlow
						? '#fbbf24'
						: targetCustomHex;
			if (taskEdgeAccent && edgeKind !== 'fail') {
				group.style.setProperty('--edge-accent', taskEdgeAccent);
			}

			const hitPath = svgEl('path', {
				class: 'ade-mission-edge-hit',
				d: route.path,
			});
			group.appendChild(hitPath);

			if (isTaskCompletedFlow || isTaskLiveFlow || isTaskBlockedFlow || targetCustomHex) {
				group.appendChild(svgEl('path', {
					class: `ade-orch-edge-halo${isTaskLiveFlow ? ' is-live' : ''}`,
					d: route.path,
				}));
			}

			const path = svgEl('path', {
				class: 'ade-mission-edge-path',
				d: route.path,
				'marker-end': this.selectedEdgeKey === edgeKey
					? 'url(#ade-mission-arrow-active)'
					: edgeKind === 'fail'
						? 'url(#ade-mission-arrow-fail)'
						: isTaskLiveFlow
							? resolveArrowMarkerUrlForColor(toNode.color ?? fromNode.color, 'ade-mission-arrow-active')
							: isTaskCompletedFlow
								? 'url(#ade-mission-arrow-out)'
								: isTaskBlockedFlow
									? 'url(#ade-mission-arrow-cycle)'
									: targetCustomHex
										? resolveArrowMarkerUrlForColor(toNode.color ?? fromNode.color, 'ade-mission-arrow-default')
										: isCrossHost
											? 'url(#ade-mission-arrow-cloud)'
											: 'url(#ade-mission-arrow-default)',
			});
			group.appendChild(path);
			if (isTaskLiveFlow) {
				group.appendChild(svgEl('path', {
					class: 'ade-orch-edge-flow-stream',
					d: route.path,
				}));
				// Render crisp luminous live-sync pulse beacon on active Mission DAG handoff edges
				const toRec = this.lastTaskStatuses?.[edge.to];
				const tokBadge = toRec?.activeTokenIds?.[0] ? `⚡ ${toRec.activeTokenIds[0]}` : `⚡ ${edge.to}`;
				const puckW = Math.max(54, Math.min(96, Math.round(tokBadge.length * 6.2 + 20)));
				const halfW = puckW / 2;
				const beaconFrac = edge.label ? 0.74 : 0.56;
				const pt = samplePolylinePointAtFraction(route.points, beaconFrac);
				const puckColor = taskEdgeAccent ?? '#38bdf8';
				const puckGroup = svgEl('g', {
					class: 'ade-orch-live-puck is-task-dag-beacon',
					'data-ade-task-live-beacon': edge.id,
				});
				puckGroup.style.setProperty('--puck-color', puckColor);
				if (this.animationsPaused) {
					puckGroup.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
				} else {
					puckGroup.style.offsetPath = `path("${route.path}")`;
					puckGroup.style.setProperty('offset-rotate', '0deg');
					puckGroup.style.animationDelay = `${-(beaconFrac * 3.4).toFixed(2)}s`;
				}
				puckGroup.appendChild(svgEl('rect', {
					class: 'ade-orch-live-puck-bloom',
					x: String(-halfW - 4),
					y: '-12',
					width: String(puckW + 8),
					height: '24',
					rx: '12',
				}));
				puckGroup.appendChild(svgEl('rect', {
					class: 'ade-orch-live-puck-pill',
					x: String(-halfW),
					y: '-9.5',
					width: String(puckW),
					height: '19',
					rx: '9.5',
				}));
				puckGroup.appendChild(svgEl('circle', {
					class: 'ade-orch-live-puck-dot',
					cx: String(-halfW + 8),
					cy: '0',
					r: '2.4',
				}));
				const bText = svgEl('text', {
					class: 'ade-orch-live-puck-text',
					x: '3.5',
					y: '0.5',
				});
				bText.textContent = tokBadge;
				puckGroup.appendChild(bText);
				this.tokenGliderLayerEl.appendChild(puckGroup);
			}
			this.edgeDisposables.add(addDisposableListener(group, EventType.POINTER_DOWN, (e: PointerEvent) => {
				if (e.button === 0) {
					e.stopPropagation();
				}
			}));
			this.edgeDisposables.add(addDisposableListener(group, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				this.callbacks.onSelectEdge?.(edge);
			}));
			this.edgeDisposables.add(addDisposableListener(group, EventType.DBLCLICK, (e: MouseEvent) => {
				if (!this.callbacks.onRenameEdgeLabel || this.callbacks.isRevisionPreview?.()) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.startInlineEdgeLabelEdit(edge.id);
			}));
			this.edgeDisposables.add(addDisposableListener(group, EventType.CONTEXT_MENU, (e: MouseEvent) => {
				if (!this.callbacks.onEdgeContextMenu) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.callbacks.onEdgeContextMenu(edge, e.clientX, e.clientY);
			}));

			let labelBg: SVGRectElement | undefined;
			let labelText: SVGTextElement | undefined;
			let pillW = 0;
			if (edge.label) {
				const labelLayout = computeMissionEdgeLabelLayout(edge.label);
				pillW = labelLayout.pillWidth;
				labelBg = svgEl('rect', {
					class: 'ade-mission-edge-label-bg',
					x: String(route.midX - pillW / 2),
					y: String(route.midY - 10),
					width: String(pillW),
					height: '20',
					rx: '6',
				});
				labelText = svgEl('text', {
					class: 'ade-mission-edge-label-text',
					x: String(route.midX),
					y: String(route.midY),
				});
				labelText.textContent = labelLayout.displayText;
				if (labelLayout.displayText !== edge.label.trim()) {
					const titleEl = svgEl('title');
					titleEl.textContent = edge.label;
					group.appendChild(titleEl);
				}
				group.appendChild(labelBg);
				group.appendChild(labelText);
			}

			this.edgesLayerEl.appendChild(group);
			this.edgeHandles.set(edge.id, { group, path, hitPath, labelBg, labelText, pillW, edge, isCrossHost, midX: route.midX, midY: route.midY, bbox: routeBbox });
		}

		// Record latest obstacle footprints so subsequent incremental drag frames know prior bounds.
		if (movedNodeId) {
			const updatedBox = currentObstacleById.get(movedNodeId);
			if (updatedBox) {
				this.lastNodeObstacleById.set(movedNodeId, updatedBox);
			}
		} else {
			this.lastNodeObstacleById.clear();
			for (const [id, box] of currentObstacleById) {
				this.lastNodeObstacleById.set(id, box);
			}
		}

		// Re-apply runtime edge state styling after edge topology rebuilds
		if (!canPatchInPlace) {
			this.patchEdgeRuntimeStates(this.lastRuntimeState);
		}

		// Keep Cross-Cloud Compute Territory contour halos tightly synced as nodes move
		this.renderCloudTerritories(nodes, positions);

		// During an in-place drag frame, edge classes/markers are unchanged; only re-run hover highlight
		// when SVG topology was rebuilt or a multi-step employee context-reuse chain is actively displayed.
		if (this.hoveredNodeId && (!canPatchInPlace || !movedNodeId || this.contextLinksLayerEl.childElementCount > 0)) {
			this.applyHoverHighlight(this.hoveredNodeId, nodes, positions);
		}
	}

	applyHoverHighlight(
		nodeId: string | undefined,
		nodes: readonly IMissionDagNode[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
	): void {
		this.hoveredNodeId = nodeId;
		this.worldEl.classList.toggle('has-node-hover', Boolean(nodeId));

		const upstreamIds = new Set<string>();
		const downstreamIds = new Set<string>();
		const raisedGroups: SVGGElement[] = [];

		for (const { group, path, edge, isCrossHost } of this.edgeHandles.values()) {
			const isIncoming = Boolean(nodeId && edge.to === nodeId);
			const isOutgoing = Boolean(nodeId && edge.from === nodeId);
			const isConnected = isIncoming || isOutgoing;

			group.classList.toggle('is-hover-flow', isConnected);
			group.classList.toggle('is-incoming', isIncoming);
			group.classList.toggle('is-outgoing', isOutgoing);

			if (isIncoming) {
				upstreamIds.add(edge.from);
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-in)');
				raisedGroups.push(group);
			} else if (isOutgoing) {
				downstreamIds.add(edge.to);
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-out)');
				raisedGroups.push(group);
			} else {
				const key = `${edge.from}->${edge.to}`;
				if (this.hoveredTraceEdgeKeys?.has(key)) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-trace)');
				} else if (group.classList.contains('is-whiteboard-link')) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-whiteboard)');
				} else if (group.classList.contains('is-cycle-back')) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-cycle)');
				} else if (group.classList.contains('is-bidirectional')) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-bidir)');
				} else if (group.classList.contains('is-fail-taken') || getMissionEdgeKind(edge) === 'fail') {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-fail)');
				} else if (group.classList.contains('is-token-flowing')) {
					path.setAttribute('marker-end', 'url(#ade-mission-arrow-active)');
				} else {
					path.setAttribute('marker-end', isCrossHost
						? 'url(#ade-mission-arrow-cloud)'
						: 'url(#ade-mission-arrow-default)');
				}
			}
		}

		for (const g of raisedGroups) {
			this.edgesLayerEl.appendChild(g);
		}

		while (this.contextLinksLayerEl.firstChild) {
			this.contextLinksLayerEl.removeChild(this.contextLinksLayerEl.firstChild);
		}
		const hoveredNode = nodeId ? nodes.find(n => n.id === nodeId) : undefined;
		const sameEmployeeIds = new Set<string>();
		const reuseChainIds = new Set<string>();
		let reuseRouteBelow = false;

		if (hoveredNode?.employeeKey && (hoveredNode.employeeTotalOccurrences ?? 0) > 1) {
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
				this.contextLinksLayerEl.appendChild(svgEl('path', {
					class: 'ade-mission-context-edge',
					'data-context-link': `${hop.fromId}->${hop.toId}`,
					d: hop.path,
					'marker-end': 'url(#ade-mission-arrow-ctx)',
				}));
			}
		}

		for (const [id, handle] of this.nodeHandles.entries()) {
			const isHovered = Boolean(nodeId && id === nodeId);
			const isUp = upstreamIds.has(id);
			const isDown = downstreamIds.has(id);
			const isSameEmp = sameEmployeeIds.has(id);
			const inReuse = reuseChainIds.has(id);
			handle.rootEl.classList.toggle('is-hovered', isHovered);
			handle.rootEl.classList.toggle('is-neighbor', isUp || isDown);
			handle.rootEl.classList.toggle('is-upstream', isUp);
			handle.rootEl.classList.toggle('is-downstream', isDown);
			handle.rootEl.classList.toggle('is-same-employee', isSameEmp);
			handle.rootEl.classList.toggle('has-ctx-port-top', inReuse && !reuseRouteBelow);
			handle.rootEl.classList.toggle('has-ctx-port-bottom', inReuse && reuseRouteBelow);
		}
	}

	// =========================================================================
	// Engineering View 1: Minimalist Mission Task DAG Renderer
	// =========================================================================

	private rebuildMissionTaskGraphDom(snapshot: IMissionCanvasRenderSnapshot): void {
		this.nodeDragDisposables.clear();
		this.graphDisposables.clear();
		this.edgeDisposables.clear();
		this.connectDragDisposables.clear();
		this.inlineRenameDisposables.clear();
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.tokenGliderHandles.clear();
		this.orchAnchorButtons.clear();
		this.orchNodeSizeById.clear();
		this.lastEdgeStructureKey = '';
		if (this.hoveredNodeId && !snapshot.nodes.some(n => n.id === this.hoveredNodeId)) {
			this.hoveredNodeId = undefined;
		}
		this.hoveredTraceEdgeKeys = undefined;
		this.worldEl.classList.remove('has-node-hover', 'has-trace-hover');
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl, this.tokenGliderLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}

		this.lastTaskStatuses = snapshot.taskStatuses;
		for (const node of snapshot.nodes) {
			const pos = snapshot.positions.get(node.id) ?? { x: 270, y: 260 };
			const statusRec = snapshot.taskStatuses?.[node.id];
			const taskStatus = statusRec?.status ?? 'pending';
			const rawDesc = (snapshot.nodePrompts[node.id] ?? '').trim();

			const nodeEl = append(this.nodesLayerEl, $(`.ade-mission-node.kind-mission-task.is-circular-task.task-status-${taskStatus.replace(/_/g, '-')}`, {
				'data-node-id': node.id,
				'data-node-kind': 'mission-task',
				'data-node-shape': 'circle',
				'data-task-status': taskStatus,
			}));
			nodeEl.style.left = `${pos.x}px`;
			nodeEl.style.top = `${pos.y}px`;
			this.applyCustomNodeColor(nodeEl, node.color);
			this.orchNodeSizeById.set(node.id, { width: MISSION_TASK_NODE_WIDTH, height: MISSION_TASK_NODE_HEIGHT });

			const card = append(nodeEl, $('.ade-mission-node-card.is-task-card.is-circular-task'));

			const topRow = append(card, $('.ade-mission-node-top.is-task-top'));
			const idWrap = append(topRow, $('span.ade-mission-node-id-wrap'));
			const taskIconCls = taskStatus === 'completed'
				? 'codicon-pass-filled'
				: taskStatus === 'in_progress'
					? 'codicon-sync'
					: taskStatus === 'blocked'
						? 'codicon-warning'
						: 'codicon-circle-outline';
			append(idWrap, $(`span.codicon.${taskIconCls}.ade-mission-task-ico`, { 'aria-hidden': 'true' }));
			append(idWrap, $('span.ade-mission-node-id', {}, node.id));
			this.mountNodeColorTrigger(idWrap, node.id, node.label, node.color);

			const circleCore = append(card, $('.ade-mission-task-circle-core'));
			const titleEl = append(circleCore, $('.ade-mission-node-title.is-task-title', { title: node.label }, node.label));

			const hasDoneFooter = taskStatus === 'completed' && Boolean(statusRec?.completedByLabel);
			const hasLiveMeta = !hasDoneFooter && Boolean(
				statusRec?.assigneeLabel
				|| statusRec?.assigneeNodeId
				|| (statusRec?.activeTokenIds?.length ?? 0) > 0
				|| (statusRec?.artifactPtrs?.length ?? 0) > 0
				|| statusRec?.lastError
				|| node.ownerNodeId,
			);
			const promptPreviewEl = append(circleCore, $('.ade-mission-task-desc-preview', {
				'data-ade-node-prompt-preview': node.id,
				...(rawDesc ? { title: rawDesc } : {}),
			}, rawDesc
				? rawDesc.replace(/\s+/g, ' ')
				: adeBi(localize('adeMissionTaskEmptyDescHint', "Click to edit details…"), '点击编辑任务详情…')));
			if (!rawDesc) {
				promptPreviewEl.classList.add('is-empty');
			}
			if (hasDoneFooter || hasLiveMeta) {
				promptPreviewEl.classList.add('is-compact-sub');
			}

			if (hasDoneFooter && statusRec?.completedByLabel) {
				append(circleCore, $('.ade-mission-task-done-footer', {
					title: adeBi(
						localize('adeMissionTaskDoneBy', "Verified by {0}", statusRec.completedByLabel),
						'已由 {0} 验收标注完成',
						statusRec.completedByLabel,
					),
				}, `✓ ${statusRec.completedByLabel}`));
			} else if (hasLiveMeta) {
				const liveRow = append(circleCore, $('.ade-mission-task-live-meta', {
					'data-ade-task-live-meta': node.id,
				}));
				const execLabel = statusRec?.assigneeLabel || statusRec?.assigneeNodeId || node.ownerNodeId;
				if (execLabel) {
					append(liveRow, $('span.ade-mission-task-live-chip.is-assignee', {
						title: adeBi(localize('adeMissionTaskAssigneeTip', "Bound staff: {0}", execLabel), '当前负责员工：{0}', execLabel),
					}, `@${execLabel}`));
				}
				const activeTokCnt = statusRec?.activeTokenIds?.length ?? 0;
				if (activeTokCnt > 0) {
					append(liveRow, $('span.ade-mission-task-live-chip.is-tokens', {}, `${activeTokCnt} tok`));
				}
				const artCnt = statusRec?.artifactPtrs?.length ?? 0;
				if (artCnt > 0) {
					append(liveRow, $('span.ade-mission-task-live-chip.is-artifacts', {}, `${artCnt} ptr`));
				}
				if (statusRec?.durationMs && statusRec.durationMs >= 1000) {
					const sec = Math.round(statusRec.durationMs / 1000);
					const durText = sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`;
					append(liveRow, $('span.ade-mission-task-live-chip.is-duration', {}, durText));
				}
				if (statusRec?.lastError) {
					append(liveRow, $('span.ade-mission-task-live-chip.is-error', { title: statusRec.lastError }, 'ERR'));
				}
			}

			const statusLabel = taskStatus === 'completed'
				? adeBi(localize('adeMissionTaskDoneBadge', "Completed ✓"), '已完成 ✓')
				: taskStatus === 'in_progress'
					? adeBi(localize('adeMissionTaskInProgBadge', "In Progress"), '进行中')
					: taskStatus === 'blocked'
						? adeBi(localize('adeMissionTaskBlockedBadge', "Blocked"), '阻塞中')
						: adeBi(localize('adeMissionTaskPendingBadge', "Pending"), '待完成');
			append(card, $(`span.ade-mission-task-status-pill.status-${taskStatus.replace(/_/g, '-')}`, {
				'data-ade-task-status-pill': node.id,
			}, statusLabel));

			append(card, $('.ade-mission-port.port-in', { 'aria-hidden': 'true' }));
			const outPortEl = append(card, $('button.ade-mission-port.port-out.is-connectable', {
				type: 'button',
				'data-ade-connect-port': node.id,
				title: adeBi(localize('adeMissionTaskConnectTip', "Drag to another task node to create a dependency edge"), '拖拽到另一个任务节点建立有向依赖边'),
			})) as HTMLButtonElement;
			this.bindOutPortConnectDrag(node, outPortEl);

			const dummy = $('span');
			const dummyBtn = $('button', { type: 'button' }) as HTMLButtonElement;
			const handle: IRenderedNodeHandle = {
				node,
				rootEl: nodeEl,
				idWrapEl: idWrap,
				titleEl,
				linkedAgent: undefined,
				engineId: snapshot.fallbackOwnerEngineId,
				canSwitchEngine: false,
				canSwitchModel: false,
				stateDotEl: undefined,
				nodeState: taskStatus,
				primaryToken: undefined,
				allTokens: [],
				boundSupervisorId: undefined,
				triggerBadgeEl: dummyBtn,
				triggerBadgeLabelEl: dummy,
				tokenPuckEl: dummyBtn,
				tokenPuckIconEl: dummy,
				tokenPuckLabelEl: dummy,
				tokenPuckExtraEl: dummy,
				joinCapsuleEl: dummy,
				joinDotsEl: dummy,
				joinCountEl: dummy,
				lastJoinSignature: '',
				bottomDockEl: dummy,
				blockedStripEl: dummyBtn,
				blockedWaveEl: dummy,
				blockedCountdownEl: dummy,
				blockedPidEl: dummy,
				blockedFileEl: dummy,
				blockedHostEl: dummy,
				failedStripEl: dummyBtn,
				failedWaveEl: dummy,
				failedReasonEl: dummy,
				recoveryBarEl: dummy,
				checkFailChipEl: dummyBtn,
				retryBtnEl: dummyBtn,
				guidedRetryBtnEl: dummyBtn,
				recallBtnEl: dummyBtn,
				promptPreviewEl,
			};

			const isSelectedNode = this.selectedNodeIds.has(node.id);
			nodeEl.classList.toggle('is-selected', isSelectedNode);
			if (isSelectedNode) {
				nodeEl.setAttribute('data-node-selected', 'true');
			}
			this.graphDisposables.add(addDisposableListener(titleEl, EventType.DBLCLICK, e => {
				if (!this.callbacks.onRenameNode) {
					return;
				}
				e.stopPropagation();
				this.startInlineNodeRename(node.id);
			}));

			this.nodeHandles.set(node.id, handle);
			this.bindNodeInteractions(handle);
		}

		this.updateEdgesSvg(snapshot.nodes, snapshot.edges, snapshot.positions, { direction: snapshot.direction ?? this.lastDirection });
	}

	// =========================================================================
	// Engineering View 2: All-Staff Cyclic Orchestration + Multi-Anchor Renderer
	// =========================================================================

	private rebuildOrchestrationGraphDom(snapshot: IMissionCanvasRenderSnapshot): void {
		const orchNodes = snapshot.orchestrationNodes ?? [];
		const orchEdges = snapshot.orchestrationEdges ?? [];
		const departments = snapshot.orchestrationDepartments ?? [];
		const whiteboards = snapshot.whiteboards ?? {};
		const orchRuntime = snapshot.orchestrationRuntime;

		this.nodeDragDisposables.clear();
		this.graphDisposables.clear();
		this.edgeDisposables.clear();
		this.connectDragDisposables.clear();
		this.inlineRenameDisposables.clear();
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.tokenGliderHandles.clear();
		this.orchAnchorButtons.clear();
		this.orchNodeSizeById.clear();
		this.lastEdgeStructureKey = '';
		if (this.hoveredNodeId && !orchNodes.some(n => n.id === this.hoveredNodeId)) {
			this.hoveredNodeId = undefined;
		}
		this.hoveredTraceEdgeKeys = undefined;
		this.worldEl.classList.remove('has-node-hover', 'has-trace-hover');
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl, this.tokenGliderLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}

		const activeTokensByNode = new Map<string, IOrchestrationToken[]>();
		if (orchRuntime) {
			const statusRank = (s: IOrchestrationToken['status']) => s === 'active' ? 0 : s === 'waiting_join' ? 1 : 2;
			for (const tok of Object.values(orchRuntime.tokens)) {
				if (tok.status !== 'active' && tok.status !== 'blocked' && tok.status !== 'waiting_join') {
					continue;
				}
				const arr = activeTokensByNode.get(tok.nodeId) ?? [];
				arr.push(tok);
				activeTokensByNode.set(tok.nodeId, arr);
			}
			for (const arr of activeTokensByNode.values()) {
				arr.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.arrivedAt - a.arrivedAt);
			}
		}

		for (const oNode of orchNodes) {
			const pos = snapshot.positions.get(oNode.id) ?? { x: 280, y: 260 };
			const nodeSz = getOrchestrationNodeSize(oNode);
			this.orchNodeSizeById.set(oNode.id, nodeSz);

			const compatDagNode: IMissionDagNode = {
				id: oNode.id,
				label: oNode.label,
				kind: 'task',
				employeeName: oNode.employeeName,
				employeeKey: oNode.employeeKey,
			};

			const mountMultiAnchors = (cardEl: HTMLElement) => {
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
						this.orchAnchorButtons.set(`${oNode.id}:${side}:${slot}`, anchorBtn);
						this.bindMultiAnchorConnectDrag(oNode, anchorBtn, side, slot);
					}
				}
			};

			const dummy = $('span');
			const dummyBtn = $('button', { type: 'button' }) as HTMLButtonElement;

			if (oNode.kind === 'whiteboard') {
				const wb: IOrchestrationWhiteboard = whiteboards[oNode.id] ?? {
					id: oNode.id,
					title: oNode.label,
					department: oNode.department || 'General',
					content: '',
					version: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				};
				const nodeEl = append(this.nodesLayerEl, $('.ade-mission-node.kind-whiteboard', {
					'data-node-id': oNode.id,
					'data-node-kind': 'whiteboard',
					'data-whiteboard-id': wb.id,
					'data-department': wb.department,
				}));
				nodeEl.style.left = `${pos.x}px`;
				nodeEl.style.top = `${pos.y}px`;
				this.applyCustomNodeColor(nodeEl, oNode.color);

				const card = append(nodeEl, $('.ade-mission-node-card.is-whiteboard-card'));
				append(card, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
				append(card, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
				append(card, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
				append(card, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));
				const topRow = append(card, $('.ade-mission-node-top'));
				const idWrap = append(topRow, $('span.ade-mission-node-id-wrap'));
				append(idWrap, $('span.codicon.codicon-notebook.ade-orch-wb-ico', { 'aria-hidden': 'true' }));
				append(idWrap, $('span.ade-mission-node-id', {}, wb.id));
				this.mountNodeColorTrigger(idWrap, oNode.id, wb.title, oNode.color);
				append(topRow, $('span.ade-orch-wb-dept-chip', {}, wb.department));

				const wbWell = append(card, $('.ade-mission-core-well.wb-well'));
				const titleEl = append(wbWell, $('.ade-mission-node-title.is-wb-title', { title: wb.title }, wb.title));
				const excerpt = wb.content.trim()
					? wb.content.trim().replace(/\s+/g, ' ').slice(0, 120)
					: adeBi(localize('adeOrchWbEmptyExcerpt', "Department shared whiteboard — click to read or write…"), '部门共享白板 — 点击查看或编辑共享内容…');
				const excerptEl = append(wbWell, $('.ade-orch-wb-excerpt', {}, excerpt));
				if (!wb.content.trim()) {
					excerptEl.classList.add('is-empty');
				}

				const foot = append(card, $('.ade-orch-wb-footer'));
				append(foot, $('span.ade-orch-wb-ptr-tag', {}, `ptr:${wb.id}`));
				append(foot, $('span.ade-orch-wb-ver-tag', {}, `v${wb.version}`));

				mountMultiAnchors(card);

				const handle: IRenderedNodeHandle = {
					node: compatDagNode,
					rootEl: nodeEl,
					idWrapEl: idWrap,
					titleEl,
					linkedAgent: undefined,
					engineId: snapshot.fallbackOwnerEngineId,
					canSwitchEngine: false,
					canSwitchModel: false,
					stateDotEl: undefined,
					nodeState: 'idle',
					primaryToken: undefined,
					allTokens: [],
					boundSupervisorId: undefined,
					triggerBadgeEl: dummyBtn,
					triggerBadgeLabelEl: dummy,
					tokenPuckEl: dummyBtn,
					tokenPuckIconEl: dummy,
					tokenPuckLabelEl: dummy,
					tokenPuckExtraEl: dummy,
					joinCapsuleEl: dummy,
					joinDotsEl: dummy,
					joinCountEl: dummy,
					lastJoinSignature: '',
					bottomDockEl: dummy,
					blockedStripEl: dummyBtn,
					blockedWaveEl: dummy,
					blockedCountdownEl: dummy,
					blockedPidEl: dummy,
					blockedFileEl: dummy,
					blockedHostEl: dummy,
					failedStripEl: dummyBtn,
					failedWaveEl: dummy,
					failedReasonEl: dummy,
					recoveryBarEl: dummy,
					checkFailChipEl: dummyBtn,
					retryBtnEl: dummyBtn,
					guidedRetryBtnEl: dummyBtn,
					recallBtnEl: dummyBtn,
					whiteboard: wb,
				};

				this.nodeHandles.set(oNode.id, handle);
				this.bindNodeInteractions(handle);
				continue;
			}

			// All-Staff Employee Card (NO off-graph wall, NO +Sup pill, 12 perimeter multi-anchors!)
			const linkedAgent = snapshot.agentByNodeId.get(oNode.id);
			const explicitHostAlias = snapshot.runtimeState?.boundary?.nodeAssignments?.[oNode.id]?.hostAlias ?? oNode.hostAlias;
			const hostInfo = this.hostCatalog.resolveNodeHostAndOs(explicitHostAlias, linkedAgent);
			const rankDef = oNode.rankId || oNode.tier !== undefined
				? (snapshot.orgConfig.ranks.find(r => (oNode.rankId && r.id === oNode.rankId) || (oNode.tier !== undefined && r.tier === oNode.tier))
					?? resolveEffectiveRankDefinition(snapshot.orgConfig, linkedAgent?.role, linkedAgent ? snapshot.hasSubordinates(linkedAgent.id) : false))
				: resolveEffectiveRankDefinition(snapshot.orgConfig, linkedAgent?.role, linkedAgent ? snapshot.hasSubordinates(linkedAgent.id) : false);
			const tierNum = oNode.tier ?? rankDef.tier;
			const nodeState = orchRuntime?.nodeStates[oNode.id] ?? 'idle';
			const stateClass = nodeState !== 'idle' ? `.state-${nodeState.replace(/_/g, '-')}` : '';
			const hostModifiers = `${hostInfo.isRemote ? '.is-remote-host' : '.is-local-host'}.os-${hostInfo.osKind}`;
			const liveTokens = activeTokensByNode.get(oNode.id) ?? [];
			const primaryOrchTok = liveTokens[0];

			const nodeEl = append(this.nodesLayerEl, $(`.ade-mission-node.kind-staff${stateClass}${hostModifiers}`, {
				'data-node-id': oNode.id,
				'data-node-kind': 'staff',
				'data-node-state': nodeState,
				'data-node-tier': String(tierNum),
				'data-node-rank': rankDef.id,
				'data-node-os': hostInfo.osKind,
				'data-node-host': hostInfo.hostAlias,
				...(oNode.department ? { 'data-department': oNode.department } : {}),
				...(oNode.employeeKey ? { 'data-employee-key': oNode.employeeKey } : {}),
			}));
			nodeEl.style.left = `${pos.x}px`;
			nodeEl.style.top = `${pos.y}px`;
			this.applyCustomNodeColor(nodeEl, oNode.color);

			const card = append(nodeEl, $('.ade-mission-node-card.is-staff-card'));
			append(card, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
			append(card, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
			append(card, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
			append(card, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));
			const topRow = append(card, $('.ade-mission-node-top'));
			const idWrap = append(topRow, $('span.ade-mission-node-id-wrap'));
			let stateDotEl: HTMLElement | undefined;
			if (nodeState !== 'idle') {
				stateDotEl = append(idWrap, $('span.ade-mission-state-dot', { 'aria-hidden': 'true', title: nodeState }));
			}
			append(idWrap, $('span.ade-mission-node-id', {}, oNode.id));
			const clampedTier = Math.max(1, Math.min(4, tierNum));
			append(idWrap, $(`span.ade-mission-rank-pill.tier-${clampedTier}`, {}, `${formatTierTag(tierNum)} ${rankDef.name}`));
			this.mountNodeColorTrigger(idWrap, oNode.id, oNode.label, oNode.color);

			const topRight = append(topRow, $('.ade-mission-top-pills'));
			if (oNode.department) {
				append(topRight, $('span.ade-orch-dept-pill', {}, oNode.department));
			}
			const empColorIdx = getEmployeeColorIndex(oNode.employeeKey ?? oNode.id);
			const empChip = append(topRight, $(`span.ade-mission-emp-pill.emp-color-${empColorIdx}`, {
				title: adeBi(localize('adeOrchUniqueEmpTip', "Unique Staff Member: {0}", oNode.employeeName ?? oNode.label), '唯一在场员工：{0}', oNode.employeeName ?? oNode.label),
			}));
			append(empChip, $('span.ade-mission-emp-dot', { 'aria-hidden': 'true' }));
			append(empChip, $('span.ade-mission-emp-name', {}, oNode.employeeName ?? oNode.label));

			const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? oNode.engineId ?? snapshot.fallbackOwnerEngineId;
			const engineName = this.hostCatalog.getEngineDisplayName(engineId);
			const engineIcon = this.hostCatalog.getEngineIcon(engineId);
			const nodeTelemetry = snapshot.runtimeState?.nodeTelemetry?.[oNode.id];
			const resolvedModel = linkedAgent?.preferredModel || oNode.model || nodeTelemetry?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineName.toLowerCase();
			const llmProvider = resolveEffectiveAdeLlmProvider(resolvedModel, engineId, this.hostCatalog.getModelCategoryOverrides());
			const llmProviderLabel = ADE_LLM_PROVIDER_LABELS[llmProvider];
			const resolvedThinking: AdeThinkingLevel = (linkedAgent?.preferredThinking ?? (oNode.thinking as AdeThinkingLevel | undefined) ?? 'medium');
			const canSwitchModel = Boolean(snapshot.canSwitchModel);
			const canSwitchEngine = Boolean(snapshot.canSwitchModel);
			const modelContextFallback = inferModelContextWindowTokens(resolvedModel, { engineId });
			const ctxBreakdown = computeMissionNodeContextBreakdown(nodeTelemetry, modelContextFallback);

			const coreWell = append(card, $('.ade-mission-core-well'));
			const coreHead = append(coreWell, $('.ade-mission-core-head'));
			const coreIconTile = append(coreHead, $(`button.ade-mission-core-icon-well.llm-${llmProvider}${canSwitchModel ? '.is-editable' : ''}`, {
				type: 'button',
				'data-llm-provider': llmProvider,
				title: canSwitchModel
					? localize('adeMissionLlmIconSwitchTip', "Driving LLM: {0} ({1}) — Click to switch model & thinking", llmProviderLabel, resolvedModel)
					: localize('adeMissionLlmIconTip', "Driving LLM: {0} ({1})", llmProviderLabel, resolvedModel),
			})) as HTMLButtonElement;
			const coreLlmGlyph = append(coreIconTile, $('span.ade-mission-llm-icon', { 'aria-hidden': 'true' }));
			renderAdeLlmIcon(coreLlmGlyph, llmProvider, { baseClass: 'ade-mission-llm-icon', prefix: 'ade-llm', tooltip: `${llmProviderLabel} · ${resolvedModel}` });
			if (!canSwitchModel) {
				coreIconTile.disabled = true;
			}

			const coreMeta = append(coreHead, $('.ade-mission-core-meta'));
			const coreTitleRow = append(coreMeta, $('.ade-mission-core-title-row'));
			const titleEl = append(coreTitleRow, $('.ade-mission-node-title', { title: oNode.label }, oNode.label));
			const modelRow = append(coreMeta, $(`.ade-mission-core-model-row${canSwitchModel ? '.is-editable' : ''}`, {
				'data-node-model': resolvedModel,
				'data-node-thinking': resolvedThinking,
			}));
			append(modelRow, $('span.ade-mission-model-name', {}, resolvedModel));
			append(modelRow, $('span.ade-mission-model-sep', { 'aria-hidden': 'true' }, '·'));
			append(modelRow, $(`span.ade-mission-thinking-tag.level-${resolvedThinking}`, {}, resolvedThinking));

			const summaryText = primaryOrchTok
				? primaryOrchTok.lastSummary
				: adeBi(localize('adeOrchStaffStandby', "Context prewarmed · Awaiting baton"), '上下文已预热 · 待接力唤醒');
			append(coreWell, $('.ade-mission-core-context', { title: summaryText }, summaryText));

			// Recessed Baton / Directive Status Strip inside Core Well (preserves original Armored Pod vertical rhythm!)
			const hasLiveBaton = Boolean(primaryOrchTok);
			const staffDirectiveBar = append(coreWell, $(`button.ade-mission-node-prompt-bar${hasLiveBaton ? '.has-prompt' : ''}`, {
				type: 'button',
				'data-ade-orch-directive-bar': oNode.id,
			})) as HTMLButtonElement;
			append(staffDirectiveBar, $(`span.codicon.${hasLiveBaton ? 'codicon-pass-filled' : 'codicon-note'}.ade-mission-node-prompt-ico`, { 'aria-hidden': 'true' }));
			const batonRefCount = primaryOrchTok?.contextRefs?.length ?? primaryOrchTok?.whiteboardPointers?.length ?? 0;
			const batonStripPreview = primaryOrchTok
				? (primaryOrchTok.lastSummary || primaryOrchTok.id)
				: adeBi(localize('adeOrchStandbyHint', "Persistent staff · re-wakes on baton arrival"), '持久在场员工 · 收到令牌即唤醒');
			append(staffDirectiveBar, $('span.ade-mission-node-prompt-preview', {}, batonStripPreview));
			append(staffDirectiveBar, $('span.ade-mission-node-prompt-tag', {}, primaryOrchTok
				? (batonRefCount > 0 ? `${primaryOrchTok.id} · ${batonRefCount} ptr` : primaryOrchTok.id)
				: adeBi(localize('adeOrchIdleTag', "Standby"), '待命')));
			if (primaryOrchTok) {
				this.graphDisposables.add(addDisposableListener(staffDirectiveBar, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenOrchestrationTokenPopover?.(oNode.label, primaryOrchTok, staffDirectiveBar);
				}));
			} else {
				staffDirectiveBar.disabled = true;
			}

			// Original 4-Segment Context Window Usage Progress Bar
			const staffCostUsd = nodeTelemetry?.costUsd ?? 0;
			const staffCostEstimated = Boolean(nodeTelemetry?.costEstimated);
			const staffCostLocalFree = Boolean(nodeTelemetry?.costLocalFree && staffCostUsd === 0 && ((nodeTelemetry?.totalTokens ?? 0) > 0 || (nodeTelemetry?.turns ?? 0) > 0));
			const ctxRowEl = append(card, $(`.ade-mission-ctx-row.severity-${ctxBreakdown.severity}`, {
				'data-node-context-pct': String(ctxBreakdown.usedPct),
				'data-node-context-used': String(ctxBreakdown.usedTokens),
				'data-node-context-max': String(ctxBreakdown.maxTokens),
			}));
			const ctxTrack = append(ctxRowEl, $('.ade-mission-ctx-track'));
			const ctxSegInitEl = append(ctxTrack, $('.ade-ctx-seg.seg-init'));
			const ctxSegTierEl = append(ctxTrack, $('.ade-ctx-seg.seg-tier'));
			const ctxSegSourceEl = append(ctxTrack, $('.ade-ctx-seg.seg-source'));
			const ctxSegNoiseEl = append(ctxTrack, $('.ade-ctx-seg.seg-noise'));
			ctxSegInitEl.style.width = `${ctxBreakdown.initPct.toFixed(1)}%`;
			ctxSegTierEl.style.width = `${ctxBreakdown.tierPct.toFixed(1)}%`;
			ctxSegSourceEl.style.width = `${ctxBreakdown.sourcePct.toFixed(1)}%`;
			ctxSegNoiseEl.style.width = `${ctxBreakdown.noisePct.toFixed(1)}%`;
			const ctxStats = append(ctxRowEl, $('.ade-mission-ctx-stats'));
			append(ctxStats, $('span.ade-mission-ctx-tokens', {}, `${formatCompactTokenCount(ctxBreakdown.usedTokens)}/${formatCompactTokenCount(ctxBreakdown.maxTokens)}`));
			const staffCostLabel = staffCostUsd > 0
				? formatFinOpsUsd(staffCostUsd, { estimated: staffCostEstimated, compact: true })
				: (staffCostLocalFree ? 'Local $0' : '');
			if (staffCostLabel) {
				append(ctxStats, $('span.ade-mission-ctx-cost', {}, staffCostLabel));
			}
			append(ctxStats, $('span.ade-mission-ctx-pct', {}, `${ctxBreakdown.usedPct}%`));

			const footer = append(card, $('.ade-mission-node-footer'));
			const engineBadge = append(footer, $(`button.ade-mission-engine-pill${canSwitchEngine ? '.is-editable' : ''}`, {
				type: 'button',
				'data-node-engine-id': engineId,
			})) as HTMLButtonElement;
			const engIconEl = append(engineBadge, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
			applyMissionEngineIcon(engIconEl, engineIcon);
			append(engineBadge, $('span.ade-mission-engine-name', {}, engineName));
			if (!canSwitchEngine) {
				engineBadge.disabled = true;
			}

			const hostPill = append(footer, $(`button.ade-mission-host-pill.os-${hostInfo.osKind}${hostInfo.isRemote ? '.is-remote' : '.is-local'}${snapshot.canSwitchHost ? '.is-editable' : ''}`, {
				type: 'button',
				'data-node-host': hostInfo.hostAlias,
				'data-node-os': hostInfo.osKind,
			})) as HTMLButtonElement;
			const osIconEl = append(hostPill, $('span.ade-mission-os-icon', { 'aria-hidden': 'true' }));
			renderAdeOsIcon(osIconEl, hostInfo.osKind, { baseClass: 'ade-mission-os-icon', prefix: 'ade-os' });
			append(hostPill, $('span.ade-mission-host-name', {}, hostInfo.isRemote ? hostInfo.displayHost : `Local · ${hostInfo.osLabel}`));
			if (!snapshot.canSwitchHost) {
				hostPill.disabled = true;
			}

			// Live Orchestration Baton Token Puck (shows wave, waiting-join barrier, 5m silence reminder count, & pointer count)
			const puckStatusCls = (primaryOrchTok?.status ?? 'idle').replace(/_/g, '-');
			const orchTokenBtn = append(nodeEl, $(`button.ade-mission-token-puck.status-${puckStatusCls}${primaryOrchTok ? `.wave-color-${getMissionWaveColorIndex(primaryOrchTok.waveId)}` : ''}`, {
				type: 'button',
				'data-ade-orch-token-puck': oNode.id,
				...(primaryOrchTok ? { 'data-token-id': primaryOrchTok.id, 'data-token-status': primaryOrchTok.status } : {}),
			})) as HTMLButtonElement;
			if (primaryOrchTok) {
				const ptrCount = primaryOrchTok.contextRefs?.length ?? primaryOrchTok.whiteboardPointers?.length ?? 0;
				const iconCls = primaryOrchTok.status === 'blocked'
					? 'codicon-watch'
					: primaryOrchTok.status === 'waiting_join'
						? 'codicon-git-merge'
						: 'codicon-pass-filled';
				append(orchTokenBtn, $(`span.codicon.${iconCls}.ade-orch-puck-ico`, { 'aria-hidden': 'true' }));
				const barrier = primaryOrchTok.status === 'waiting_join' && primaryOrchTok.joinBarrierId
					? orchRuntime?.joinBarriers?.[primaryOrchTok.joinBarrierId]
					: undefined;
				const joinInfo = barrier
					? ` · Join ${Object.keys(barrier.settledChildren).length}/${barrier.childTokenIds.length}`
					: '';
				append(orchTokenBtn, $('span.ade-mission-token-puck-label', {}, `${formatMissionWaveTag(primaryOrchTok.waveId)}${joinInfo}`));
				if (primaryOrchTok.nudgeCount > 0) {
					const nudgeChip = append(orchTokenBtn, $('span.ade-orch-puck-chip.is-nudge'));
					append(nudgeChip, $('span.codicon.codicon-bell', { 'aria-hidden': 'true' }));
					append(nudgeChip, $('span', {}, String(primaryOrchTok.nudgeCount)));
				}
				if (ptrCount > 0) {
					const ptrChip = append(orchTokenBtn, $('span.ade-orch-puck-chip.is-ptr'));
					append(ptrChip, $('span.codicon.codicon-link', { 'aria-hidden': 'true' }));
					append(ptrChip, $('span', {}, `${ptrCount}`));
				}
				if (liveTokens.length > 1) {
					append(orchTokenBtn, $('span.ade-mission-token-puck-extra', {}, `+${liveTokens.length - 1}`));
				}
				this.graphDisposables.add(addDisposableListener(orchTokenBtn, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenOrchestrationTokenPopover?.(oNode.label, primaryOrchTok, orchTokenBtn);
				}));
			} else {
				orchTokenBtn.hidden = true;
			}

			// Mount 12 Perimeter Multi-Anchor Connection Ports (4 sides × 3 slots)
			mountMultiAnchors(card);

			if (canSwitchModel) {
				this.graphDisposables.add(addDisposableListener(coreIconTile, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenModelPopover(oNode.id, linkedAgent, engineId, coreIconTile, {
						currentModel: resolvedModel,
						currentThinking: resolvedThinking,
						hostAlias: hostInfo.hostAlias,
					});
				}));
				this.graphDisposables.add(addDisposableListener(modelRow, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenModelPopover(oNode.id, linkedAgent, engineId, modelRow, {
						currentModel: resolvedModel,
						currentThinking: resolvedThinking,
						hostAlias: hostInfo.hostAlias,
					});
				}));
			}
			if (canSwitchEngine) {
				this.graphDisposables.add(addDisposableListener(engineBadge, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenEnginePopover(oNode.id, linkedAgent, engineId, engineBadge, {
						staffLabel: oNode.label,
						hostAlias: hostInfo.hostAlias,
					});
				}));
			}
			if (snapshot.canSwitchHost) {
				this.graphDisposables.add(addDisposableListener(hostPill, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenHostPopover(compatDagNode, hostInfo.hostAlias, hostPill);
				}));
			}
			this.graphDisposables.add(addDisposableListener(titleEl, EventType.DBLCLICK, e => {
				if (!this.callbacks.onRenameNode) {
					return;
				}
				e.stopPropagation();
				this.startInlineNodeRename(oNode.id);
			}));

			const handle: IRenderedNodeHandle = {
				node: compatDagNode,
				rootEl: nodeEl,
				idWrapEl: idWrap,
				titleEl,
				hostAlias: hostInfo.hostAlias,
				displayHost: hostInfo.displayHost,
				osKind: hostInfo.osKind,
				osLabel: hostInfo.osLabel,
				isRemoteHost: hostInfo.isRemote,
				linkedAgent,
				engineId,
				canSwitchEngine,
				canSwitchModel,
				stateDotEl,
				nodeState,
				primaryToken: undefined,
				allTokens: [],
				boundSupervisorId: undefined,
				triggerBadgeEl: dummyBtn,
				triggerBadgeLabelEl: dummy,
				tokenPuckEl: orchTokenBtn,
				tokenPuckIconEl: dummy,
				tokenPuckLabelEl: dummy,
				tokenPuckExtraEl: dummy,
				joinCapsuleEl: dummy,
				joinDotsEl: dummy,
				joinCountEl: dummy,
				lastJoinSignature: '',
				bottomDockEl: dummy,
				blockedStripEl: dummyBtn,
				blockedWaveEl: dummy,
				blockedCountdownEl: dummy,
				blockedPidEl: dummy,
				blockedFileEl: dummy,
				blockedHostEl: dummy,
				failedStripEl: dummyBtn,
				failedWaveEl: dummy,
				failedReasonEl: dummy,
				recoveryBarEl: dummy,
				checkFailChipEl: dummyBtn,
				retryBtnEl: dummyBtn,
				guidedRetryBtnEl: dummyBtn,
				recallBtnEl: dummyBtn,
			};

			const isSelectedNode = this.selectedNodeIds.has(oNode.id);
			nodeEl.classList.toggle('is-selected', isSelectedNode);
			if (isSelectedNode) {
				nodeEl.setAttribute('data-node-selected', 'true');
			}
			this.nodeHandles.set(oNode.id, handle);
			this.bindNodeInteractions(handle);
		}

		this.lastOrchLayoutMode = snapshot.orchestrationLayoutMode;
		this.updateOrchestrationEdgesSvg(orchNodes, orchEdges, departments, snapshot.positions, {
			direction: snapshot.direction ?? this.lastDirection,
			layoutMode: snapshot.orchestrationLayoutMode,
		});
	}

	private renderOrchestrationDepartmentRegions(
		nodes: readonly IOrchestrationGraphNode[],
		departments: readonly IOrchestrationDepartmentGroup[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
	): void {
		this.deptDisposables.clear();
		this.deptPillRectById.clear();
		while (this.cloudTerritoriesLayerEl.firstChild) {
			this.cloudTerritoriesLayerEl.removeChild(this.cloudTerritoriesLayerEl.firstChild);
		}
		if (departments.length === 0) {
			return;
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
		let emptyIndex = 0;

		for (let idx = 0; idx < departments.length; idx++) {
			const dept = departments[idx];
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

			const isEmptyGroup = count === 0 || !Number.isFinite(minX);
			let boxX: number;
			let boxY: number;
			let boxW: number;
			let boxH: number;
			let emptyCenter: IMissionNodePosition | undefined;
			if (isEmptyGroup) {
				const emptyW = 340;
				const emptyH = 168;
				const explicitPos = positions.get(dept.id);
				emptyCenter = explicitPos ?? {
					x: Math.round((hasPlacedNode ? globalMaxX + 260 : 340)),
					y: Math.round((hasPlacedNode ? globalMinY + 90 : 220) + emptyIndex * (emptyH + 54)),
				};
				emptyIndex++;
				boxX = Math.round(emptyCenter.x - emptyW / 2);
				boxY = Math.round(emptyCenter.y - emptyH / 2);
				boxW = emptyW;
				boxH = emptyH;
			} else {
				const padX = 34;
				const padTop = 44;
				const padBottom = 28;
				boxX = Math.round(minX - padX);
				boxY = Math.round(minY - padTop);
				boxW = Math.round(maxX - minX + padX * 2);
				boxH = Math.round(maxY - minY + padTop + padBottom);
			}
			const colorIdx = idx % 5;
			// Harmonize department region accent with its highest-rank colored member (e.g. L2 department lead!)
			const deptColoredStaff = dept.nodeIds
				.map(nid => nodeById.get(nid))
				.filter((n): n is IOrchestrationGraphNode => Boolean(n && resolveAdeNodeColorHex(n.color)))
				.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
			const deptAccentHex = resolveAdeNodeColorHex(deptColoredStaff[0]?.color);

			const g = svgEl('g', {
				class: `ade-orch-dept-region dept-color-${colorIdx}${deptAccentHex ? ' has-custom-dept-accent' : ''}${isEmptyGroup ? ' is-empty-group' : ''}`,
				'data-ade-dept-region': dept.name,
				'data-ade-dept-id': dept.id,
			});
			if (deptAccentHex) {
				g.style.setProperty('--ade-dept-accent', deptAccentHex);
			}
			g.appendChild(svgEl('rect', {
				class: 'ade-orch-dept-frame',
				x: String(boxX),
				y: String(boxY),
				width: String(boxW),
				height: String(boxH),
				rx: '20',
				ry: '20',
			}));
			if (isEmptyGroup) {
				const hintText = svgEl('text', {
					class: 'ade-orch-dept-empty-hint',
					x: String(Math.round(boxX + boxW / 2)),
					y: String(Math.round(boxY + boxH / 2 + 4)),
				});
				hintText.textContent = adeBi(localize('adeOrchEmptyGroupHint', "Empty Group · Right-click pill to add staff or whiteboard"), '空分组 · 右键标题可添加员工或白板');
				g.appendChild(hintText);
			}

			const staffCount = dept.nodeIds.length;
			const wbPart = dept.whiteboardIds.length > 0 ? ` · ${dept.whiteboardIds.length} WB` : '';
			const titleText = `${dept.name} (${staffCount}${wbPart})`;
			const pillW = Math.max(122, Math.min(284, titleText.length * 7.2 + 38));
			const pillX = boxX + 16;
			const pillY = boxY - 12;

			const pillGroup = svgEl('g', {
				class: 'ade-orch-dept-pill-group',
				'data-ade-dept-pill': dept.id,
				'data-ade-dept-name': dept.name,
			});
			const titleEl = svgEl('title');
			titleEl.textContent = adeBi(
				localize('adeOrchDeptPillTooltip', "Drag to move group · Double-click to rename · Right-click for group options"),
				'拖拽整体移动分组 · 双击重命名分组 · 右键打开分组菜单',
			);
			pillGroup.appendChild(titleEl);
			pillGroup.appendChild(svgEl('rect', {
				class: 'ade-orch-dept-pill-bg',
				x: String(pillX),
				y: String(pillY),
				width: String(Math.round(pillW)),
				height: '24',
				rx: '12',
			}));
			// Subtle 6-dot drag grip handle inside pill
			for (let r = 0; r < 3; r++) {
				for (let c = 0; c < 2; c++) {
					pillGroup.appendChild(svgEl('circle', {
						class: 'ade-orch-dept-grip',
						cx: String(pillX + 12 + c * 4),
						cy: String(pillY + 8 + r * 4),
						r: '1.05',
					}));
				}
			}
			const label = svgEl('text', {
				class: 'ade-orch-dept-pill-text',
				x: String(pillX + 24),
				y: String(boxY + 1),
			});
			label.textContent = titleText;
			pillGroup.appendChild(label);
			g.appendChild(pillGroup);
			this.cloudTerritoriesLayerEl.appendChild(g);
			this.deptPillRectById.set(dept.id, { dept, x: pillX, y: boxY, w: pillW });

			this.bindDepartmentPillInteractions(pillGroup, dept, allDeptMemberIds, emptyCenter);
		}
	}

	private bindDepartmentPillInteractions(
		pillGroup: SVGGElement,
		dept: IOrchestrationDepartmentGroup,
		memberIds: readonly string[],
		emptyCenter: IMissionNodePosition | undefined,
	): void {
		const win = getWindow(this.worldEl);
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			if (!this.callbacks.onGroupContextMenu) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.callbacks.onGroupContextMenu(dept, e.clientX, e.clientY);
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.DBLCLICK, (e: MouseEvent) => {
			if (!this.callbacks.onRenameGroup || this.callbacks.isRevisionPreview?.()) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this.startInlineGroupRename(dept.id);
		}));
		this.deptDisposables.add(addDisposableListener(pillGroup, EventType.POINTER_DOWN, (downEv: PointerEvent) => {
			if (downEv.button !== 0 || this.callbacks.isRevisionPreview?.()) {
				return;
			}
			downEv.stopPropagation();
			downEv.preventDefault();
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
			const cleanup = (endEv: PointerEvent | undefined) => {
				this.nodeDragDisposables.clear();
				if (!activeDrag) {
					return;
				}
				activeDrag = false;
				for (const id of dragIds) {
					this.nodeHandles.get(id)?.rootEl.classList.remove('dragging');
				}
				const movedPx = endEv ? Math.max(NODE_DRAG_THRESHOLD_PX, Math.hypot(endEv.clientX - startClientX, endEv.clientY - startClientY)) : NODE_DRAG_THRESHOLD_PX;
				if (this.callbacks.onEndNodesDrag) {
					this.callbacks.onEndNodesDrag(dragIds, movedPx);
				} else if (dragIds.length > 0) {
					this.callbacks.onEndNodeDrag(dragIds[0], movedPx);
				}
			};
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
			this.nodeDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, upEv => cleanup(upEv)));
			this.nodeDragDisposables.add(addDisposableListener(win, 'pointercancel', cancelEv => cleanup(cancelEv)));
			this.nodeDragDisposables.add(addDisposableListener(win, EventType.BLUR, () => cleanup(undefined)));
		}));
	}

	private updateOrchestrationEdgesSvg(
		nodes: readonly IOrchestrationGraphNode[],
		edges: readonly IOrchestrationGraphEdge[],
		departments: readonly IOrchestrationDepartmentGroup[],
		positions: ReadonlyMap<string, IMissionNodePosition>,
		options?: { readonly direction?: 'LR' | 'TD'; readonly layoutMode?: OrchestrationLayoutMode },
	): void {
		this.renderOrchestrationDepartmentRegions(nodes, departments, positions);

		this.edgeDisposables.clear();
		this.edgeHandles.clear();
		this.clearGliderDom();
		while (this.edgesLayerEl.firstChild) {
			this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
		}
		for (const btn of this.orchAnchorButtons.values()) {
			btn.classList.remove('is-occupied', 'is-bidir-anchor', 'is-cycle-anchor', 'is-wb-anchor');
		}
		if (edges.length === 0) {
			return;
		}

		const nodeById = new Map(nodes.map(n => [n.id, n]));
		const routeById = computeOrchestrationMultiAnchorRoutes(nodes, edges, positions, {
			cornerRadius: 16,
			direction: options?.direction ?? this.lastDirection,
			layoutMode: options?.layoutMode ?? this.lastOrchLayoutMode,
		});
		const renderedBidirLabelKeys = new Set<string>();

		// Collect ALL live token-passing edges (active dispatches, waiting_join fan-outs, and recent returns)
		// so every live baton wire glows with luminous animated flow & gliding baton packet capsules!
		interface ILiveOrchEdgeFlow {
			readonly tokenId: string;
			readonly waveId: string;
			readonly kind: 'dispatch' | 'return';
			readonly label: string;
			readonly colorHex?: string;
		}
		const liveFlowByEdgeKey = new Map<string, ILiveOrchEdgeFlow>();
		const edgeKeySet = new Set(edges.map(e => `${e.from}->${e.to}`));
		if (this.lastOrchRuntime) {
			const allTokens = Object.values(this.lastOrchRuntime.tokens);
			const activeParentIds = new Set(
				allTokens
					.filter(t => t.status === 'waiting_join' || t.status === 'active')
					.map(t => t.id),
			);
			for (const tok of allTokens) {
				if ((tok.status === 'active' || tok.status === 'blocked' || tok.status === 'waiting_join') && tok.fromNodeId && tok.fromNodeId !== tok.nodeId) {
					const fwdKey = `${tok.fromNodeId}->${tok.nodeId}`;
					const destNode = nodeById.get(tok.nodeId);
					const srcNode = nodeById.get(tok.fromNodeId);
					const destHex = resolveAdeNodeColorHex(destNode?.color ?? srcNode?.color);
					if (edgeKeySet.has(fwdKey)) {
						liveFlowByEdgeKey.set(fwdKey, {
							tokenId: tok.id,
							waveId: tok.waveId,
							kind: 'dispatch',
							label: `⚡ ${tok.id}`,
							colorHex: destHex,
						});
					}
				}
				// Highlight completed child tokens returning results upstream into a live waiting_join parent!
				const hopLog = tok.hopLog;
				if (tok.status === 'completed' && tok.parentTokenId && activeParentIds.has(tok.parentTokenId) && hopLog && hopLog.length > 0) {
					const lastHop = hopLog[hopLog.length - 1];
					if (lastHop.event === 'return' && lastHop.fromNodeId && lastHop.toNodeId && lastHop.fromNodeId !== lastHop.toNodeId) {
						const retKey = `${lastHop.fromNodeId}->${lastHop.toNodeId}`;
						if (edgeKeySet.has(retKey) && !liveFlowByEdgeKey.has(retKey)) {
							liveFlowByEdgeKey.set(retKey, {
								tokenId: tok.id,
								waveId: tok.waveId,
								kind: 'return',
								label: `↩ ${tok.id}`,
								colorHex: '#34d399',
							});
						}
					}
				}
			}
		}

		let liveGliderIndex = 0;

		for (const edge of edges) {
			const route = routeById.get(edge.id);
			if (!route) {
				continue;
			}
			const fromNode = nodeById.get(edge.from);
			const toNode = nodeById.get(edge.to);
			const isWhiteboardLink = fromNode?.kind === 'whiteboard' || toNode?.kind === 'whiteboard';
			// Bidirectional `<-->` partner edges stay cyan/harmonized; true multi-hop feedback cycles stand out in solar amber!
			const isTrueCycle = route.isCycleBackEdge && !route.isBidirectional;
			const edgeKey = `${edge.from}->${edge.to}`;
			const liveFlow = liveFlowByEdgeKey.get(edgeKey);

			// Compute harmonic jewel color for this wire:
			// - Whiteboard pointer link -> whiteboard custom color or Nebula Violet
			// - Multi-hop review cycle -> Solar Amber
			// - Downward tier fan-out (e.g. L1 -> L2 wing lead) -> destination wing jewel color!
			// - Otherwise -> source custom color -> target custom color -> crisp default cyan
			const isDownwardTier = fromNode?.kind === 'staff' && toNode?.kind === 'staff'
				&& (fromNode.tier ?? 99) < (toNode.tier ?? 99);
			const preferredColorToken = isWhiteboardLink
				? (toNode?.kind === 'whiteboard' ? (toNode.color ?? fromNode?.color) : (fromNode?.color ?? toNode?.color))
				: isTrueCycle
					? 'amber'
					: isDownwardTier
						? (toNode?.color ?? fromNode?.color)
						: (fromNode?.color ?? toNode?.color);
			const edgeAccentHex = isTrueCycle
				? '#f59e0b'
				: resolveAdeNodeColorHex(preferredColorToken) ?? (isWhiteboardLink ? '#a78bfa' : route.isBidirectional ? '#38bdf8' : '#34d399');

			// Mark occupied multi-anchor slots on source & target cards with edge-matched luminous terminal pins
			const fromPin = this.orchAnchorButtons.get(`${edge.from}:${route.fromAnchor.side}:${route.fromAnchor.slot}`);
			const toPin = this.orchAnchorButtons.get(`${edge.to}:${route.toAnchor.side}:${route.toAnchor.slot}`);
			for (const pin of [fromPin, toPin]) {
				if (!pin) {
					continue;
				}
				pin.classList.add('is-occupied');
				pin.style.setProperty('--pin-accent', edgeAccentHex);
				if (isWhiteboardLink) {
					pin.classList.add('is-wb-anchor');
				} else if (isTrueCycle) {
					pin.classList.add('is-cycle-anchor');
				} else if (route.isBidirectional) {
					pin.classList.add('is-bidir-anchor');
				}
			}
			const isSelected = Boolean(this.selectedEdgeKey && this.selectedEdgeKey === edgeKey);

			const edgeClasses = ['ade-mission-edge-group', 'is-orch-edge'];
			if (route.isBidirectional) {
				edgeClasses.push('is-bidirectional');
			}
			if (isTrueCycle) {
				edgeClasses.push('is-cycle-back');
			}
			if (isWhiteboardLink) {
				edgeClasses.push('is-whiteboard-link');
			}
			if (edge.dashed) {
				edgeClasses.push('is-dashed');
			}
			if (isSelected) {
				edgeClasses.push('is-selected');
			}
			if (liveFlow) {
				edgeClasses.push('is-orch-live-flow', liveFlow.kind === 'return' ? 'is-return-flow' : 'is-dispatch-flow');
			}

			const group = svgEl('g', {
				class: edgeClasses.join(' '),
				'data-edge-id': edge.id,
				'data-from': edge.from,
				'data-to': edge.to,
				'data-from-anchor': `${route.fromAnchor.side}:${route.fromAnchor.slot}`,
				'data-to-anchor': `${route.toAnchor.side}:${route.toAnchor.slot}`,
				'data-bidirectional': String(route.isBidirectional),
				'data-cycle-back': String(route.isCycleBackEdge),
				...(liveFlow ? { 'data-live-token-id': liveFlow.tokenId, 'data-live-flow-kind': liveFlow.kind } : {}),
				...(isSelected ? { 'data-edge-selected': 'true' } : {}),
			});
			group.style.setProperty('--edge-accent', liveFlow?.colorHex ?? edgeAccentHex);

			const hitPath = svgEl('path', { class: 'ade-mission-edge-hit', d: route.path });
			group.appendChild(hitPath);

			// Ambient outer glow halo behind every luminous orchestration wire
			group.appendChild(svgEl('path', {
				class: `ade-orch-edge-halo${liveFlow ? ' is-live' : ''}`,
				d: route.path,
			}));

			const markerEnd = isSelected
				? 'url(#ade-mission-arrow-active)'
				: liveFlow?.kind === 'return'
					? 'url(#ade-mission-arrow-preset-emerald)'
					: isTrueCycle
						? 'url(#ade-mission-arrow-cycle)'
						: isWhiteboardLink
							? resolveArrowMarkerUrlForColor(preferredColorToken, 'ade-mission-arrow-whiteboard')
							: resolveArrowMarkerUrlForColor(preferredColorToken, route.isBidirectional ? 'ade-mission-arrow-bidir' : 'ade-mission-arrow-default');

			const path = svgEl('path', {
				class: 'ade-mission-edge-path',
				d: route.path,
				'marker-end': markerEnd,
			});
			group.appendChild(path);

			// Animated luminous energy stream overlay for every active token wire!
			if (liveFlow) {
				group.appendChild(svgEl('path', {
					class: `ade-orch-edge-flow-stream${liveFlow.kind === 'return' ? ' is-return' : ''}`,
					d: route.path,
				}));
			}

			const compatEdge: IMissionDagEdge = {
				id: edge.id,
				from: edge.from,
				to: edge.to,
				...(edge.label ? { label: edge.label } : {}),
			};
			this.edgeDisposables.add(addDisposableListener(group, EventType.POINTER_DOWN, (e: PointerEvent) => {
				if (e.button === 0) {
					e.stopPropagation();
				}
			}));
			this.edgeDisposables.add(addDisposableListener(group, EventType.CLICK, (e: MouseEvent) => {
				e.stopPropagation();
				this.callbacks.onSelectEdge?.(compatEdge);
			}));
			this.edgeDisposables.add(addDisposableListener(group, EventType.DBLCLICK, (e: MouseEvent) => {
				if (!this.callbacks.onRenameEdgeLabel) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.startInlineEdgeLabelEdit(edge.id);
			}));
			this.edgeDisposables.add(addDisposableListener(group, EventType.CONTEXT_MENU, (e: MouseEvent) => {
				if (!this.callbacks.onEdgeContextMenu) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				this.callbacks.onEdgeContextMenu(compatEdge, e.clientX, e.clientY);
			}));

			let labelBg: SVGRectElement | undefined;
			let labelText: SVGTextElement | undefined;
			let pillW = 0;
			let shouldRenderLabel = Boolean(edge.label);
			if (shouldRenderLabel && route.isBidirectional && edge.label) {
				const pairId = edge.from < edge.to ? `${edge.from}<->${edge.to}` : `${edge.to}<->${edge.from}`;
				const bidirLabelKey = `${pairId}|${edge.label.trim()}`;
				if (renderedBidirLabelKeys.has(bidirLabelKey)) {
					shouldRenderLabel = false;
				} else {
					renderedBidirLabelKeys.add(bidirLabelKey);
				}
			}
			if (shouldRenderLabel && edge.label) {
				const labelLayout = computeMissionEdgeLabelLayout(edge.label);
				pillW = labelLayout.pillWidth;
				labelBg = svgEl('rect', {
					class: 'ade-mission-edge-label-bg',
					x: String(route.midX - pillW / 2),
					y: String(route.midY - 10),
					width: String(pillW),
					height: '20',
					rx: '6',
				});
				labelText = svgEl('text', {
					class: 'ade-mission-edge-label-text',
					x: String(route.midX),
					y: String(route.midY),
				});
				labelText.textContent = labelLayout.displayText;
				group.appendChild(labelBg);
				group.appendChild(labelText);
			}

			this.edgesLayerEl.appendChild(group);
			this.edgeHandles.set(edge.id, {
				group,
				path,
				hitPath,
				labelBg,
				labelText,
				pillW,
				edge: compatEdge,
				isCrossHost: false,
				midX: route.midX,
				midY: route.midY,
				bbox: computeRouteBbox(route.points),
			});

			// Mount sleek persistent glowing Baton Token Packet Comet on live token delivery/return edges!
			if (liveFlow) {
				const puckColor = liveFlow.colorHex ?? edgeAccentHex;
				const puckText = liveFlow.label;
				const puckW = Math.max(58, Math.min(118, Math.round(puckText.length * 6.4 + 22)));
				const halfW = puckW / 2;
				// Choose clean deterministic fraction (avoiding exact 0.50 midpoint when edge has a text label!)
				const hasTextLabel = Boolean(labelBg);
				const staticFrac = hasTextLabel
					? (liveGliderIndex % 2 === 0 ? 0.28 : 0.72)
					: (0.42 + (liveGliderIndex % 3) * 0.08);
				const anchorPt = samplePolylinePointAtFraction(route.points, staticFrac);

				const puckGroup = svgEl('g', {
					class: `ade-orch-live-puck wave-color-${getMissionWaveColorIndex(liveFlow.waveId)}${liveFlow.kind === 'return' ? ' is-return' : ''}`,
					'data-ade-orch-live-puck': edge.id,
					'data-token-id': liveFlow.tokenId,
					'data-wave-id': liveFlow.waveId,
					'data-flow-kind': liveFlow.kind,
				});
				puckGroup.style.setProperty('--puck-color', puckColor);
				if (this.animationsPaused) {
					puckGroup.setAttribute('transform', `translate(${anchorPt.x}, ${anchorPt.y})`);
				} else {
					puckGroup.style.offsetPath = `path("${route.path}")`;
					puckGroup.style.setProperty('offset-rotate', '0deg');
					// Stagger phase along the 3.4s glide cycle so multiple batons travel gracefully across wings
					const delaySec = -(staticFrac * 3.4);
					puckGroup.style.animationDelay = `${delaySec.toFixed(2)}s`;
				}
				puckGroup.appendChild(svgEl('rect', {
					class: 'ade-orch-live-puck-bloom',
					x: String(-halfW - 4),
					y: '-13',
					width: String(puckW + 8),
					height: '26',
					rx: '13',
				}));
				puckGroup.appendChild(svgEl('rect', {
					class: 'ade-orch-live-puck-pill',
					x: String(-halfW),
					y: '-10',
					width: String(puckW),
					height: '20',
					rx: '10',
				}));
				puckGroup.appendChild(svgEl('circle', {
					class: 'ade-orch-live-puck-dot',
					cx: String(-halfW + 8.5),
					cy: '0',
					r: '2.6',
				}));
				const textEl = svgEl('text', {
					class: 'ade-orch-live-puck-text',
					x: '4',
					y: '0.5',
				});
				textEl.textContent = puckText;
				puckGroup.appendChild(textEl);
				this.tokenGliderLayerEl.appendChild(puckGroup);
				liveGliderIndex++;
			}
		}

		// Also trigger one-shot 800ms burst animation on brand-new handoffs when not already covered by a live comet
		if (this.lastOrchRuntime && !this.animationsPaused) {
			const now = Date.now();
			const bursts = new Map<string, IEdgeTransitBurst>();
			for (const tok of Object.values(this.lastOrchRuntime.tokens)) {
				if (tok.status !== 'active' || !tok.fromNodeId) {
					continue;
				}
				const key = `${tok.fromNodeId}->${tok.nodeId}`;
				if (liveFlowByEdgeKey.has(key)) {
					continue;
				}
				const age = now - tok.arrivedAt;
				if (age >= -EDGE_TRANSIT_MAX_FUTURE_SKEW_MS && age < MISSION_EDGE_TRANSIT_DURATION_MS) {
					const eh = [...this.edgeHandles.values()].find(h => `${h.edge.from}->${h.edge.to}` === key);
					if (eh) {
						eh.group.classList.add('is-token-flowing');
						bursts.set(key, {
							edgeKey: key,
							edgeId: eh.edge.id,
							tokenId: tok.id,
							waveId: tok.waveId,
							isFail: false,
							hopSignature: `${tok.id}|${key}|${tok.arrivedAt}`,
							expiresAt: now + Math.max(1, MISSION_EDGE_TRANSIT_DURATION_MS - Math.max(0, age)),
						});
					}
				}
			}
			if (bursts.size > 0) {
				this.patchTokenGliders(bursts, now);
			}
		}
	}

	private bindMultiAnchorConnectDrag(
		oNode: IOrchestrationGraphNode,
		anchorEl: HTMLButtonElement,
		side: OrchestrationAnchorSide,
		slot: number,
	): void {
		this.graphDisposables.add(addDisposableListener(anchorEl, EventType.POINTER_DOWN, (downEv: PointerEvent) => {
			if (downEv.button !== 0 || !this.callbacks.onConnectNodes) {
				return;
			}
			downEv.preventDefault();
			downEv.stopPropagation();
			const win = getWindow(anchorEl);
			const sourcePos = this.callbacks.getNodePosition(oNode.id);
			if (!sourcePos) {
				return;
			}
			const sourceSize = getOrchestrationNodeSize(oNode);
			const startAnchor = computeOrchestrationAnchorPoint(sourcePos, sourceSize, side, slot, ORCHESTRATION_SLOTS_PER_SIDE);
			let hoveredTargetId: string | undefined;

			const clientToWorld = (clientX: number, clientY: number): { readonly x: number; readonly y: number } => {
				const rect = this.worldEl.getBoundingClientRect();
				const zoom = Math.max(0.1, this.callbacks.getZoom());
				return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
			};

			const hitTestTarget = (pt: { readonly x: number; readonly y: number }): string | undefined => {
				for (const candidate of this.lastOrchNodes) {
					if (candidate.id === oNode.id) {
						continue;
					}
					const pos = this.callbacks.getNodePosition(candidate.id);
					if (!pos) {
						continue;
					}
					const sz = getOrchestrationNodeSize(candidate);
					const pad = 16;
					if (pt.x >= pos.x - sz.width / 2 - pad && pt.x <= pos.x + sz.width / 2 + pad
						&& pt.y >= pos.y - sz.height / 2 - pad && pt.y <= pos.y + sz.height / 2 + pad) {
						return candidate.id;
					}
				}
				return undefined;
			};

			const setTargetHighlight = (nextId: string | undefined) => {
				if (hoveredTargetId === nextId) {
					return;
				}
				if (hoveredTargetId) {
					this.nodeHandles.get(hoveredTargetId)?.rootEl.classList.remove('is-connect-target');
				}
				hoveredTargetId = nextId;
				if (hoveredTargetId) {
					this.nodeHandles.get(hoveredTargetId)?.rootEl.classList.add('is-connect-target');
				}
			};

			const updatePreview = (clientX: number, clientY: number, bidir: boolean) => {
				const pt = clientToWorld(clientX, clientY);
				const targetId = hitTestTarget(pt);
				setTargetHighlight(targetId);
				const route = computeOrthogonalRoundedEdgeRoute(startAnchor.x, startAnchor.y, pt.x, pt.y, {
					cornerRadius: 12,
					minStub: 20,
					orientation: (side === 'top' || side === 'bottom') ? 'vertical' : 'horizontal',
				});
				this.connectPreviewPathEl.setAttribute('d', route.path);
				this.connectPreviewPathEl.classList.toggle('is-fail', false);
				this.connectPreviewPathEl.setAttribute('marker-end', bidir ? 'url(#ade-mission-arrow-bidir)' : 'url(#ade-mission-arrow-active)');
				this.connectPreviewPathEl.style.display = '';
			};

			this.connectDragDisposables.clear();
			this.worldEl.classList.add('is-connecting-edge');
			updatePreview(downEv.clientX, downEv.clientY, downEv.shiftKey);

			const cleanup = () => {
				setTargetHighlight(undefined);
				this.worldEl.classList.remove('is-connecting-edge');
				this.connectPreviewPathEl.style.display = 'none';
				this.connectDragDisposables.clear();
			};
			this.connectDragDisposables.add(addDisposableListener(win, EventType.POINTER_MOVE, (mv: PointerEvent) => {
				updatePreview(mv.clientX, mv.clientY, mv.shiftKey);
			}));
			this.connectDragDisposables.add(addDisposableListener(win, EventType.POINTER_UP, (upEv: PointerEvent) => {
				const pt = clientToWorld(upEv.clientX, upEv.clientY);
				const finalTarget = hoveredTargetId ?? hitTestTarget(pt);
				const bidirectional = upEv.shiftKey;
				cleanup();
				if (finalTarget && finalTarget !== oNode.id) {
					this.callbacks.onConnectNodes?.(oNode.id, finalTarget, { bidirectional });
				}
			}));
			this.connectDragDisposables.add(addDisposableListener(win, 'pointercancel', () => cleanup()));
			this.connectDragDisposables.add(addDisposableListener(win, EventType.BLUR, () => cleanup()));
			this.connectDragDisposables.add(addDisposableListener(win, EventType.KEY_DOWN, (kev: KeyboardEvent) => {
				if (kev.key === 'Escape') {
					kev.preventDefault();
					cleanup();
				}
			}));
		}));
	}
}
