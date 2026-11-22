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
	IMissionJoinBarrier,
	IMissionRuntimeState,
	IMissionSourceTrigger,
	IMissionToken,
	inferModelContextWindowTokens,
	MissionTokenStatus,
} from '../../../../platform/ade/common/adeMissionEngine.js';
import { formatFinOpsUsd } from '../../../../platform/ade/common/adeModelPricing.js';
import { IAdeOrganizationConfig, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
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
	serializeMissionEngineIconKey,
} from './adeMissionHostCatalog.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_DRAG_THRESHOLD_PX = 5;
const NODE_DRAG_EXCLUSION_SELECTOR = '.ade-mission-inline-rename-input, .ade-mission-port.port-out.is-connectable';
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
	readonly direction?: 'LR' | 'TD';
	readonly nodes: readonly IMissionDagNode[];
	readonly edges: readonly IMissionDagEdge[];
	readonly positions: ReadonlyMap<string, IMissionNodePosition>;
	readonly runtimeState: IMissionRuntimeState | undefined;
	readonly nodePrompts: Readonly<Record<string, string>>;
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
	onOpenEmployeePopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenSupervisorPopover?(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenModelPopover(nodeId: string, agent: IAdeAgent, engineId: string, anchorEl: HTMLElement): void;
	onOpenEnginePopover(nodeId: string, agent: IAdeAgent, engineId: string, anchorEl: HTMLElement): void;
	onOpenHostPopover(node: IMissionDagNode, currentHost: string, anchorEl: HTMLElement): void;
	onOpenNodePromptPopover(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenNodeTriggersPopover?(node: IMissionDagNode, anchorEl: HTMLElement): void;
	onOpenGateDecisionPopover(node: IMissionDagNode, anchorEl: HTMLElement, preferredTokenId?: string, options?: { readonly focusReject?: boolean }): void;
	onQuickGateApprove?(node: IMissionDagNode, token: IMissionToken | undefined, anchorEl: HTMLElement): void;
	onOpenTokenInspectorPopover?(node: IMissionDagNode, token: IMissionToken, allNodeTokens: readonly IMissionToken[], anchorEl: HTMLElement): void;
	onQuickRetryNode?(node: IMissionDagNode, token: IMissionToken): void;
	onOpenGuidedRetryPopover?(node: IMissionDagNode, token: IMissionToken, anchorEl: HTMLElement): void;
	onQuickRecallNode?(node: IMissionDagNode, token: IMissionToken | undefined): void;
	onRenameNode?(nodeId: string, nextLabel: string): void;
	onRenameEdgeLabel?(fromId: string, toId: string, nextLabel: string): void;
	onConnectNodes?(fromNodeId: string, toNodeId: string, options?: { readonly fail?: boolean }): void;
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

const TOKEN_STATUS_PRIORITY: Readonly<Record<MissionTokenStatus, number>> = {
	active: 7,
	blocked: 6,
	waiting_gate: 5,
	queued: 4,
	frozen_failed: 3,
	waiting_join: 2,
	completed: 1,
	recalled: 0,
};

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

function isLiveMissionTokenStatus(status: MissionTokenStatus): boolean {
	return status === 'active'
		|| status === 'queued'
		|| status === 'blocked'
		|| status === 'waiting_gate'
		|| status === 'waiting_join'
		|| status === 'frozen_failed';
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
	private lastStructureKey = '';
	private lastEdgeStructureKey = '';
	private lastDirection: 'LR' | 'TD' = 'LR';
	private hoveredNodeId: string | undefined;
	private selectedNodeIds = new Set<string>();
	private selectedEdgeKey: string | undefined;
	private searchMatchNodeIds: ReadonlySet<string> | undefined;
	private activeSearchNodeId: string | undefined;
	private highlightedSupervisorId: string | undefined;
	private hoveredTraceEdgeKeys: ReadonlySet<string> | undefined;
	private lastRuntimeState: IMissionRuntimeState | undefined;
	private showCloudTerritories = true;
	private tabSpotlightActive = false;
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
				refX: '8.5',
				refY: '5',
				markerWidth: '6.5',
				markerHeight: '6.5',
				orient: 'auto',
			});
			marker.appendChild(svgEl('path', { d: 'M 0 1.4 L 9 5 L 0 8.6 z', fill: color }));
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
		this.edgesSvgEl.appendChild(defs);
	}

	invalidateStructure(): void {
		this.lastStructureKey = '';
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
		const hasNodes = snapshot.nodes.length > 0;
		this.emptyHintEl.hidden = hasNodes;

		const worldSize = computeMissionWorldSize([...snapshot.positions.values()]);
		this.worldEl.style.width = `${worldSize.width}px`;
		this.worldEl.style.height = `${worldSize.height}px`;
		this.edgesSvgEl.setAttribute('width', String(worldSize.width));
		this.edgesSvgEl.setAttribute('height', String(worldSize.height));

		if (!hasNodes) {
			this.clearAllDom();
			return;
		}

		this.lastRuntimeState = snapshot.runtimeState;
		const nextDirection = snapshot.direction ?? 'LR';
		this.lastDirection = nextDirection;
		this.worldEl.classList.toggle('dir-td', nextDirection === 'TD');
		this.worldEl.dataset.dagDirection = nextDirection;

		const nextStructureKey = this.computeStructureKey(snapshot);
		if (!forceFullRebuild && nextStructureKey === this.lastStructureKey && this.nodeHandles.size === snapshot.nodes.length) {
			this.patchDynamicNodes(snapshot);
			return;
		}

		this.lastStructureKey = nextStructureKey;
		this.rebuildFullGraphDom(snapshot);
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
		this.activeSearchNodeId = activeMatchNodeId;
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
		this.highlightedSupervisorId = supervisorId;
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
		this.tabSpotlightActive = active;
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
		this.lastStructureKey = '';
		this.lastEdgeStructureKey = '';
		this.hoveredNodeId = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.searchMatchNodeIds = undefined;
		this.activeSearchNodeId = undefined;
		this.highlightedSupervisorId = undefined;
		this.hoveredTraceEdgeKeys = undefined;
		this.tabSpotlightActive = false;
		this.worldEl.classList.remove('has-node-hover', 'has-trace-hover', 'has-supervisor-highlight', 'is-tab-spotlight-active', 'has-search-filter');
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.supervisorBeamsLayerEl, this.tokenGliderLayerEl, this.alignGuidesLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}
	}

	private computeStructureKey(snapshot: IMissionCanvasRenderSnapshot): string {
		const { nodes, edges, runtimeState, agentByNodeId, fallbackOwnerEngineId, orgConfig } = snapshot;
		const parts: string[] = [
			snapshot.direction ?? 'LR',
			snapshot.canSwitchModel ? 'm1' : 'm0',
			snapshot.canSwitchHost ? 'h1' : 'h0',
		];

		for (const node of nodes) {
			const linkedAgent = node.kind !== 'gate' ? agentByNodeId.get(node.id) : undefined;
			const explicitHost = runtimeState?.boundary.nodeAssignments[node.id]?.hostAlias;
			const hostInfo = node.kind !== 'gate'
				? this.hostCatalog.resolveNodeHostAndOs(explicitHost, linkedAgent)
				: undefined;
			const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? fallbackOwnerEngineId;
			const rankDef = node.kind !== 'gate'
				? resolveEffectiveRankDefinition(orgConfig, linkedAgent?.role, linkedAgent ? snapshot.hasSubordinates(linkedAgent.id) : false)
				: undefined;
			const assignedTier = runtimeState?.boundary.nodeAssignments[node.id]?.tier ?? rankDef?.tier ?? '';

			// Intentionally excludes volatile runtime fields (mission live/idle status,
			// nodeTelemetry.model, resolvedModel/thinking/llmProvider, canSwitchEngine,
			// host engine availability) so live execution ticks patch node cards IN PLACE
			// without clearing DOM nodes or destroying hover/popover anchors.
			parts.push([
				node.id,
				node.kind,
				node.label,
				node.employeeKey ?? '',
				node.employeeName ?? '',
				node.employeeOccurrence ?? 0,
				node.employeeTotalOccurrences ?? 0,
				linkedAgent?.id ?? '',
				engineId,
				this.hostCatalog.getEngineDisplayName(engineId),
				rankDef?.id ?? '',
				rankDef?.name ?? '',
				assignedTier,
				hostInfo?.hostAlias ?? '',
				hostInfo?.osKind ?? '',
			].join('\x1f'));
		}

		for (const edge of edges) {
			parts.push(`${edge.id}\x1f${edge.from}\x1f${edge.to}\x1f${edge.label ?? ''}\x1f${getMissionEdgeKind(edge)}`);
		}
		return parts.join('\x1e');
	}

	private collectTokensByNode(runtimeState: IMissionRuntimeState | undefined): Map<string, IMissionToken[]> {
		const map = new Map<string, IMissionToken[]>();
		if (!runtimeState) {
			return map;
		}
		for (const tok of Object.values(runtimeState.tokens)) {
			let list = map.get(tok.nodeId);
			if (!list) {
				list = [];
				map.set(tok.nodeId, list);
			}
			list.push(tok);
		}
		for (const list of map.values()) {
			list.sort((a, b) => {
				const prioDiff = TOKEN_STATUS_PRIORITY[b.status] - TOKEN_STATUS_PRIORITY[a.status];
				if (prioDiff !== 0) {
					return prioDiff;
				}
				const actDiff = (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
				if (actDiff !== 0) {
					return actDiff;
				}
				return (b.arrivedAt ?? 0) - (a.arrivedAt ?? 0);
			});
		}
		return map;
	}

	private collectJoinBarriersByNode(runtimeState: IMissionRuntimeState | undefined): Map<string, IMissionJoinBarrier[]> {
		const map = new Map<string, IMissionJoinBarrier[]>();
		if (!runtimeState) {
			return map;
		}
		for (const barrier of Object.values(runtimeState.joinBarriers)) {
			let list = map.get(barrier.targetNodeId);
			if (!list) {
				list = [];
				map.set(barrier.targetNodeId, list);
			}
			list.push(barrier);
		}
		for (const list of map.values()) {
			list.sort((a, b) => Object.keys(b.arrivedByFrom).length - Object.keys(a.arrivedByFrom).length);
		}
		return map;
	}

	private collectTriggersByNode(runtimeState: IMissionRuntimeState | undefined): Map<string, IMissionSourceTrigger[]> {
		const map = new Map<string, IMissionSourceTrigger[]>();
		if (!runtimeState) {
			return map;
		}
		for (const trig of runtimeState.triggers) {
			let list = map.get(trig.nodeId);
			if (!list) {
				list = [];
				map.set(trig.nodeId, list);
			}
			list.push(trig);
		}
		return map;
	}

	private collectSupervisorByNode(runtimeState: IMissionRuntimeState | undefined): Map<string, { readonly id: string; readonly tier: number }> {
		const map = new Map<string, { readonly id: string; readonly tier: number }>();
		if (!runtimeState) {
			return map;
		}
		for (const sup of runtimeState.boundary.supervisors) {
			for (const nid of sup.managedNodeIds) {
				if (!map.has(nid)) {
					map.set(nid, { id: sup.id, tier: sup.tier });
				}
			}
		}
		return map;
	}

	private patchNodeRuntimeAccessories(
		handle: IRenderedNodeHandle,
		tokens: readonly IMissionToken[],
		barriers: readonly IMissionJoinBarrier[],
		triggers: readonly IMissionSourceTrigger[],
		boundSupervisor: { readonly id: string; readonly tier: number } | undefined,
		resolveSupervisorDisplay: IMissionCanvasRenderSnapshot['resolveSupervisorDisplay'],
		now: number,
		isMissionRunning: boolean,
	): void {
		const primary = tokens[0];
		handle.primaryToken = primary;
		handle.allTokens = tokens;

		if (handle.pacemakerPortEl) {
			const hasEnabledTrigger = triggers.some(t => t.enabled);
			const armed = hasEnabledTrigger || isMissionRunning;
			handle.pacemakerPortEl.classList.toggle('is-armed', armed);
			handle.pacemakerPortEl.classList.toggle('has-triggers', triggers.length > 0);
			handle.pacemakerPortEl.setAttribute('data-pacemaker-armed', String(armed));
		}

		// 0. Off-Graph Supervisor Badge & Canvas Jurisdiction Color Indicator (always visible, zero opacity:0!)
		handle.boundSupervisorId = boundSupervisor?.id;
		if (boundSupervisor) {
			const colorIdx = getMissionSupervisorColorIndex(boundSupervisor.id);
			const disp = resolveSupervisorDisplay?.(boundSupervisor.id) ?? { label: boundSupervisor.id, shortLabel: boundSupervisor.id, tier: boundSupervisor.tier };
			handle.rootEl.setAttribute('data-node-supervisor-id', boundSupervisor.id);
			handle.rootEl.setAttribute('data-node-supervisor-color', String(colorIdx));
			if (handle.supBtnEl && handle.supDotEl && handle.supNameEl) {
				const cls = `ade-mission-sup-pill is-bound sup-color-${colorIdx}`;
				if (handle.supBtnEl.className !== cls) {
					handle.supBtnEl.className = cls;
				}
				handle.supBtnEl.setAttribute('data-node-supervisor-id', boundSupervisor.id);
				handle.supDotEl.hidden = false;
				if (handle.supNameEl.textContent !== disp.shortLabel) {
					handle.supNameEl.textContent = disp.shortLabel;
				}
				handle.supBtnEl.title = localize(
					'adeMissionSupBoundTooltip',
					"Off-graph Supervisor: {0} ({1}) — Hover to highlight managed nodes; click to change",
					disp.label,
					formatTierTag(boundSupervisor.tier),
				);
			}
		} else {
			handle.rootEl.removeAttribute('data-node-supervisor-id');
			handle.rootEl.removeAttribute('data-node-supervisor-color');
			if (handle.supBtnEl && handle.supDotEl && handle.supNameEl) {
				const cls = 'ade-mission-sup-pill is-auto';
				if (handle.supBtnEl.className !== cls) {
					handle.supBtnEl.className = cls;
				}
				handle.supBtnEl.removeAttribute('data-node-supervisor-id');
				handle.supDotEl.hidden = true;
				const autoTxt = localize('adeMissionSupAutoShort', "+ Sup");
				if (handle.supNameEl.textContent !== autoTxt) {
					handle.supNameEl.textContent = autoTxt;
				}
				handle.supBtnEl.title = localize('adeMissionSupUnboundTooltip', "Off-graph Supervisor: Auto (Mission Owner) — Click to bind supervisor");
			}
		}
		handle.rootEl.classList.toggle('is-supervised-highlight', Boolean(this.highlightedSupervisorId && handle.boundSupervisorId === this.highlightedSupervisorId));
		handle.rootEl.classList.toggle('is-tab-supervised', this.tabSpotlightActive && Boolean(handle.boundSupervisorId));

		// 0b. On-Canvas Source Trigger Badge (top-left rim on entry nodes — never collides with Join Barrier)
		if (triggers.length === 0) {
			handle.triggerBadgeEl.hidden = true;
			handle.triggerBadgeEl.removeAttribute('data-trigger-count');
		} else {
			const enabledList = triggers.filter(t => t.enabled);
			const lead = enabledList[0] ?? triggers[0];
			const anyEnabled = enabledList.length > 0;
			const extra = triggers.length > 1 ? ` +${triggers.length - 1}` : '';
			const labelText = `⚡ ${formatMissionTriggerShortLabel(lead)}${extra}`;
			handle.triggerBadgeEl.hidden = false;
			handle.triggerBadgeEl.classList.toggle('is-disabled', !anyEnabled);
			handle.triggerBadgeEl.setAttribute('data-trigger-count', String(triggers.length));
			if (handle.triggerBadgeLabelEl.textContent !== labelText) {
				handle.triggerBadgeLabelEl.textContent = labelText;
			}
			const trigTipLines = triggers.map(t => `${t.enabled ? '●' : '○'} ${t.kind}: ${formatMissionTriggerShortLabel(t)}${t.targetPath ? ` (${t.targetPath})` : ''}${t.hostAlias ? ` @${t.hostAlias}` : ''}`);
			handle.triggerBadgeEl.title = `${localize('adeMissionNodeTriggerBadgeTip', "Source Triggers ({0}) — Click to manage", triggers.length)}\n${trigTipLines.join('\n')}`;
		}

		// 1. Floating Token Puck (top-right of node, with physical wave-color ring & concurrency queue rank)
		if (!primary) {
			handle.tokenPuckEl.hidden = true;
			handle.tokenPuckEl.removeAttribute('data-token-id');
			handle.tokenPuckEl.removeAttribute('data-token-status');
			handle.tokenPuckEl.removeAttribute('data-wave-id');
			handle.tokenPuckEl.removeAttribute('data-live-token-count');
			handle.tokenPuckEl.removeAttribute('data-queue-position');
			handle.rootEl.removeAttribute('data-node-queue-position');
			handle.rootEl.removeAttribute('data-node-queue-total');
			handle.rootEl.removeAttribute('data-node-queue-scope');
			handle.rootEl.removeAttribute('data-node-queue-reason');
		} else {
			const liveCount = tokens.filter(t => isLiveMissionTokenStatus(t.status)).length;
			const statusClass = `status-${primary.status.replace(/_/g, '-')}`;
			const waveColorClass = `wave-color-${getMissionWaveColorIndex(primary.waveId)}`;
			const desiredPuckClass = `ade-mission-token-puck ${statusClass} ${waveColorClass}`;
			if (handle.tokenPuckEl.className !== desiredPuckClass) {
				handle.tokenPuckEl.className = desiredPuckClass;
			}
			handle.tokenPuckEl.hidden = false;
			handle.tokenPuckEl.setAttribute('data-token-id', primary.id);
			handle.tokenPuckEl.setAttribute('data-token-status', primary.status);
			handle.tokenPuckEl.setAttribute('data-wave-id', primary.waveId);
			handle.tokenPuckEl.setAttribute('data-live-token-count', String(liveCount));

			const waveTag = formatMissionWaveTag(primary.waveId);
			let iconGlyph = '🪙';
			let puckLabel = waveTag;
			if (primary.status === 'blocked' && primary.blocked) {
				iconGlyph = '⏳';
				puckLabel = `${waveTag} · ${formatMissionBlockedRemaining(primary.blocked.expiresAt, now).text}`;
			} else if (primary.status === 'queued' && primary.queued) {
				iconGlyph = '⏱';
				puckLabel = `${waveTag} · #${primary.queued.position}/${primary.queued.totalQueued}`;
			} else if (primary.status === 'waiting_gate') {
				iconGlyph = '◆';
				puckLabel = `${waveTag} · Gate`;
			} else if (primary.status === 'waiting_join') {
				iconGlyph = '⫴';
				puckLabel = `${waveTag} · Join`;
			} else if (primary.status === 'frozen_failed') {
				iconGlyph = '⚠';
				puckLabel = `${waveTag} · Failed`;
			} else if (primary.status === 'completed') {
				iconGlyph = '✓';
				puckLabel = waveTag;
			} else if (primary.status === 'recalled') {
				iconGlyph = '↩';
				puckLabel = waveTag;
			}
			if (primary.status === 'queued' && primary.queued) {
				handle.tokenPuckEl.setAttribute('data-queue-position', String(primary.queued.position));
				handle.rootEl.setAttribute('data-node-queue-position', String(primary.queued.position));
				handle.rootEl.setAttribute('data-node-queue-total', String(primary.queued.totalQueued));
				handle.rootEl.setAttribute('data-node-queue-scope', primary.queued.scopeKey);
				handle.rootEl.setAttribute('data-node-queue-reason', primary.queued.blockedBy);
			} else {
				handle.tokenPuckEl.removeAttribute('data-queue-position');
				handle.rootEl.removeAttribute('data-node-queue-position');
				handle.rootEl.removeAttribute('data-node-queue-total');
				handle.rootEl.removeAttribute('data-node-queue-scope');
				handle.rootEl.removeAttribute('data-node-queue-reason');
			}
			if (handle.tokenPuckIconEl.textContent !== iconGlyph) {
				handle.tokenPuckIconEl.textContent = iconGlyph;
			}
			if (handle.tokenPuckLabelEl.textContent !== puckLabel) {
				handle.tokenPuckLabelEl.textContent = puckLabel;
			}
			const extraCount = liveCount > 1 ? liveCount - 1 : 0;
			if (extraCount > 0) {
				handle.tokenPuckExtraEl.hidden = false;
				const extraTxt = `+${extraCount}`;
				if (handle.tokenPuckExtraEl.textContent !== extraTxt) {
					handle.tokenPuckExtraEl.textContent = extraTxt;
				}
			} else {
				handle.tokenPuckExtraEl.hidden = true;
			}
			const queueScopeLabel = primary.status === 'queued' && primary.queued?.blockedBy === 'employee'
				? (handle.node.employeeName ? `@${handle.node.employeeName}` : primary.queued.scopeKey)
				: (primary.queued?.scopeKey ?? '');
			const queueTip = primary.status === 'queued' && primary.queued
				? (primary.queued.blockedBy === 'employee'
					? adeBi(
						localize(
							'adeMissionTokenPuckQueuedEmpTip',
							"Exclusive Queue #{0}/{1} — waiting for {2} to finish its active/blocked step (prevents parallel context contamination)",
							primary.queued.position,
							primary.queued.totalQueued,
							queueScopeLabel,
						),
						'员工排他排队第 {0}/{1} 位 — 等待 {2} 完成当前进行/阻塞节点（防止并行上下文串台）',
						primary.queued.position,
						primary.queued.totalQueued,
						queueScopeLabel,
					)
					: adeBi(
						localize(
							'adeMissionTokenPuckQueuedTip',
							"Queued #{0}/{1} — waiting for concurrency slot on {2} ({3}/{4} active)",
							primary.queued.position,
							primary.queued.totalQueued,
							primary.queued.scopeKey,
							primary.queued.activeSlots,
							primary.queued.maxSlots,
						),
						'并发排队第 {0}/{1} 位 — 等待 {2} 槽位（当前 {3}/{4} 占用）',
						primary.queued.position,
						primary.queued.totalQueued,
						primary.queued.scopeKey,
						primary.queued.activeSlots,
						primary.queued.maxSlots,
					))
				: undefined;
			const tipParts = [
				`${primary.id} (${primary.waveId}) · ${primary.status}`,
				queueTip,
				primary.lastSummary ? primary.lastSummary : undefined,
				localize('adeMissionTokenPuckInspectTip', "Click to inspect token summary, history & trace_ptr; hover to trace ancestry"),
			].filter((v): v is string => Boolean(v));
			handle.tokenPuckEl.title = tipParts.join('\n');
		}

		// 2. Join Barrier Progress Capsule (top-left of multi-inDegree node)
		const primaryBarrier = barriers[0];
		if (!primaryBarrier || primaryBarrier.expectedFromNodeIds.length === 0) {
			handle.joinCapsuleEl.hidden = true;
			handle.lastJoinSignature = '';
		} else {
			const arrivedIds = primaryBarrier.expectedFromNodeIds.filter(id => Boolean(primaryBarrier.arrivedByFrom[id]));
			const skippedSet = new Set(primaryBarrier.skippedFromNodeIds);
			const pendingIds = primaryBarrier.expectedFromNodeIds.filter(id => !primaryBarrier.arrivedByFrom[id] && !skippedSet.has(id));
			const activeTotal = Math.max(1, primaryBarrier.expectedFromNodeIds.length - skippedSet.size);
			const sig = [
				primaryBarrier.waveId,
				barriers.length,
				...primaryBarrier.expectedFromNodeIds.map(id => primaryBarrier.arrivedByFrom[id] ? `a:${id}` : skippedSet.has(id) ? `s:${id}` : `p:${id}`),
			].join('|');

			handle.joinCapsuleEl.hidden = false;
			handle.joinCapsuleEl.setAttribute('data-join-arrived', String(arrivedIds.length));
			handle.joinCapsuleEl.setAttribute('data-join-total', String(activeTotal));
			handle.joinCapsuleEl.setAttribute('data-join-skipped', String(skippedSet.size));
			handle.joinCapsuleEl.setAttribute('data-join-wave', primaryBarrier.waveId);

			if (handle.lastJoinSignature !== sig) {
				handle.lastJoinSignature = sig;
				clearNode(handle.joinDotsEl);
				for (const fromId of primaryBarrier.expectedFromNodeIds) {
					const isArrived = Boolean(primaryBarrier.arrivedByFrom[fromId]);
					const isSkipped = skippedSet.has(fromId);
					const stateCls = isArrived ? '.is-arrived' : isSkipped ? '.is-skipped' : '.is-pending';
					const glyph = isArrived ? '●' : isSkipped ? '⊘' : '○';
					append(handle.joinDotsEl, $(`span.ade-mission-join-dot${stateCls}`, {
						'data-join-from': fromId,
						'data-join-state': isArrived ? 'arrived' : isSkipped ? 'skipped' : 'pending',
					}, glyph));
				}
				const extraWaves = barriers.length > 1 ? ` +${barriers.length - 1}w` : '';
				handle.joinCountEl.textContent = `${arrivedIds.length}/${activeTotal}${extraWaves}`;
				const tooltipLines = [
					localize('adeMissionJoinBarrierTipHead', "Join Barrier ({0}): {1}/{2} branches arrived", primaryBarrier.waveId, arrivedIds.length, activeTotal),
					arrivedIds.length > 0 ? localize('adeMissionJoinArrived', "Arrived: {0}", arrivedIds.join(', ')) : undefined,
					pendingIds.length > 0 ? localize('adeMissionJoinPending', "Waiting: {0}", pendingIds.join(', ')) : undefined,
					skippedSet.size > 0 ? localize('adeMissionJoinSkipped', "Skipped: {0}", [...skippedSet].join(', ')) : undefined,
				].filter((v): v is string => Boolean(v));
				handle.joinCapsuleEl.title = tooltipLines.join('\n');
			}
		}

		// 3. Gate card inline queued summary subtitle & inline quick Approve / Reject bar
		const waitingGateTokens = handle.node.kind === 'gate'
			? tokens.filter(t => t.status === 'waiting_gate').sort((a, b) => a.arrivedAt - b.arrivedAt)
			: [];
		if (handle.gateMetaEl) {
			if (waitingGateTokens.length > 0) {
				const lead = waitingGateTokens[0];
				const summarySnippet = lead.lastSummary?.trim();
				const gateText = waitingGateTokens.length > 1
					? adeBi(
						localize('adeMissionGateMetaMulti', "{0} waves waiting · Click to review", waitingGateTokens.length),
						'{0} 个波次待审批 · 点击详情',
						waitingGateTokens.length,
					)
					: (summarySnippet
						? summarySnippet
						: adeBi(localize('adeMissionGateMetaSingle', "Waiting human sign-off · Click to review"), '等待人工审批 · 点击查看详情'));
				handle.gateMetaEl.hidden = false;
				if (handle.gateMetaEl.textContent !== gateText) {
					handle.gateMetaEl.textContent = gateText;
					handle.gateMetaEl.title = summarySnippet || gateText;
				}
			} else {
				handle.gateMetaEl.hidden = true;
			}
		}
		const showGateInline = Boolean(handle.gateInlineActionsEl && waitingGateTokens.length > 0);
		if (handle.gateInlineActionsEl) {
			handle.gateInlineActionsEl.hidden = !showGateInline;
			if (handle.gateApproveLabelEl) {
				const approveLabel = adeBi(localize('adeMissionGateCardApprove', "Approve"), '通过');
				if (handle.gateApproveLabelEl.textContent !== approveLabel) {
					handle.gateApproveLabelEl.textContent = approveLabel;
				}
			}
			if (handle.gateRejectLabelEl) {
				const rejectLabel = adeBi(localize('adeMissionGateCardReject', "Reject…"), '打回…');
				if (handle.gateRejectLabelEl.textContent !== rejectLabel) {
					handle.gateRejectLabelEl.textContent = rejectLabel;
				}
			}
		}

		// 4. Bottom Dock: Blocked Watch Strip + Failure Summary Strip + Check-Failure Chip + Quick/Guided Retry & Recall Bar
		const isBlocked = Boolean(primary && primary.status === 'blocked' && primary.blocked);
		if (isBlocked && primary?.blocked) {
			const info = primary.blocked;
			const rem = formatMissionBlockedRemaining(info.expiresAt, now);
			handle.blockedStripEl.hidden = false;
			const waveTxt = formatMissionWaveTag(primary.waveId);
			if (handle.blockedWaveEl.textContent !== waveTxt) {
				handle.blockedWaveEl.textContent = waveTxt;
			}
			const countdownText = `⏳ ${rem.text}`;
			if (handle.blockedCountdownEl.textContent !== countdownText) {
				handle.blockedCountdownEl.textContent = countdownText;
			}
			handle.blockedCountdownEl.classList.toggle('is-overdue', rem.isOverdue);

			if (info.watchPid !== undefined) {
				handle.blockedPidEl.hidden = false;
				const pidText = `PID ${info.watchPid}`;
				if (handle.blockedPidEl.textContent !== pidText) {
					handle.blockedPidEl.textContent = pidText;
				}
			} else {
				handle.blockedPidEl.hidden = true;
			}

			if (info.watchFile) {
				handle.blockedFileEl.hidden = false;
				const fileBase = extractMissionWatchFileBasename(info.watchFile);
				if (handle.blockedFileEl.textContent !== fileBase) {
					handle.blockedFileEl.textContent = fileBase;
				}
				handle.blockedFileEl.title = info.watchFile;
			} else {
				handle.blockedFileEl.hidden = true;
			}

			if (info.hostAlias && info.hostAlias !== 'local') {
				handle.blockedHostEl.hidden = false;
				const hostText = `@${info.hostAlias}`;
				if (handle.blockedHostEl.textContent !== hostText) {
					handle.blockedHostEl.textContent = hostText;
				}
			} else {
				handle.blockedHostEl.hidden = true;
			}

			const blockedTip = [
				`${primary.waveId} · ${localize('adeMissionBlockedReasonTip', "Blocked: {0}", info.reason)}`,
				info.watchPid !== undefined ? `PID: ${info.watchPid}` : undefined,
				info.watchFile ? `File: ${info.watchFile}` : undefined,
				info.hostAlias ? `Host: ${info.hostAlias}` : undefined,
			].filter((v): v is string => Boolean(v)).join('\n');
			handle.blockedStripEl.title = blockedTip;
		} else {
			handle.blockedStripEl.hidden = true;
		}

		const failedToken = tokens.find(t => t.status === 'frozen_failed');
		if (failedToken) {
			const waveTxt = `⚠ ${formatMissionWaveTag(failedToken.waveId)}`;
			const reasonTxt = failedToken.failure?.reason?.trim()
				|| failedToken.lastCheckFailure?.summary?.trim()
				|| failedToken.lastSummary?.trim()
				|| localize('adeMissionNodeFailedFallback', "Execution failed — click to inspect or retry");
			handle.failedStripEl.hidden = false;
			if (handle.failedWaveEl.textContent !== waveTxt) {
				handle.failedWaveEl.textContent = waveTxt;
			}
			if (handle.failedReasonEl.textContent !== reasonTxt) {
				handle.failedReasonEl.textContent = reasonTxt;
			}
			handle.failedStripEl.title = `${failedToken.waveId} (${failedToken.id})\n${reasonTxt}`;
		} else {
			handle.failedStripEl.hidden = true;
		}

		const isActiveTok = Boolean(primary && primary.status === 'active');
		const isQueuedTok = Boolean(primary && primary.status === 'queued');
		const hasActiveCheckFail = Boolean(primary && primary.status === 'active' && primary.lastCheckFailure);
		const showRetry = Boolean(failedToken);
		const showRecall = Boolean(failedToken || isBlocked || isActiveTok || isQueuedTok);
		if (hasActiveCheckFail && primary?.lastCheckFailure) {
			handle.checkFailChipEl.hidden = false;
			const chkText = localize('adeMissionCheckFailChip', "Check {0}/{1}", primary.lastCheckFailure.attempt, primary.lastCheckFailure.maxAutoRetries);
			if (handle.checkFailChipEl.textContent !== chkText) {
				handle.checkFailChipEl.textContent = chkText;
			}
			handle.checkFailChipEl.title = primary.lastCheckFailure.summary;
		} else {
			handle.checkFailChipEl.hidden = true;
		}
		handle.retryBtnEl.hidden = !showRetry;
		handle.guidedRetryBtnEl.hidden = !showRetry;
		handle.recallBtnEl.hidden = !showRecall;
		const showRecoveryBar = showRetry || showRecall || hasActiveCheckFail;
		handle.recoveryBarEl.hidden = !showRecoveryBar;
		handle.bottomDockEl.hidden = !isBlocked && !failedToken && !showRecoveryBar && !showGateInline;
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

	private formatContextSummary(
		node: IMissionDagNode,
		nodeState: string,
		telemetrySummary: string | undefined,
		tokenSummary: string | undefined,
		failureReason?: string,
		waveId?: string,
		queued?: IMissionToken['queued'],
	): string {
		if (nodeState === 'failed' && failureReason?.trim()) {
			const wavePrefix = waveId ? `${formatMissionWaveTag(waveId)} · ` : '';
			return `⚠ ${wavePrefix}${failureReason.trim()}`;
		}
		if (nodeState === 'queued' && queued) {
			if (queued.blockedBy === 'employee') {
				const empLabel = node.employeeName ? `@${node.employeeName}` : queued.scopeKey;
				return adeBi(
					localize(
						'adeMissionCtxSummaryQueuedEmp',
						"Exclusive Queue #{0}/{1} · Waiting for {2}",
						queued.position,
						queued.totalQueued,
						empLabel,
					),
					'排他排队 #{0}/{1} · 等待 {2} 释放会话',
					queued.position,
					queued.totalQueued,
					empLabel,
				);
			}
			return adeBi(
				localize(
					'adeMissionCtxSummaryQueued',
					"Queued #{0}/{1} · Waiting for {2} ({3}/{4})",
					queued.position,
					queued.totalQueued,
					queued.scopeKey,
					queued.activeSlots,
					queued.maxSlots,
				),
				'排队 #{0}/{1} · 等待 {2} 槽位 ({3}/{4})',
				queued.position,
				queued.totalQueued,
				queued.scopeKey,
				queued.activeSlots,
				queued.maxSlots,
			);
		}
		const isReused = Boolean((node.employeeTotalOccurrences ?? 0) > 1);
		return telemetrySummary
			|| tokenSummary
			|| (nodeState === 'active'
				? adeBi(localize('adeMissionCtxSummaryActive', "Running · Live context sync"), '执行中 · 实时上下文同步')
				: nodeState === 'completed'
					? adeBi(localize('adeMissionCtxSummaryDone', "✓ Deliverables handed off"), '✓ 阶段产物已交付上游/下游')
					: isReused && node.employeeOccurrence && node.employeeTotalOccurrences
						? adeBi(localize('adeMissionCtxSummaryReuse', "Context reuse #{0}/{1} · Ready", node.employeeOccurrence, node.employeeTotalOccurrences), '上下文复用 #{0}/{1} · 准备就绪', node.employeeOccurrence, node.employeeTotalOccurrences)
						: adeBi(localize('adeMissionCtxSummaryReady', "Context warm · Standby"), '上下文已预热 · 待派发'));
	}

	/**
	 * O(N) zero-teardown dynamic patching for runtime ticks:
	 * updates positions, node states, state dot, summary text, 4-segment context bar, and prompts in place.
	 */
	private patchDynamicNodes(snapshot: IMissionCanvasRenderSnapshot): void {
		const tokensByNode = this.collectTokensByNode(snapshot.runtimeState);
		const barriersByNode = this.collectJoinBarriersByNode(snapshot.runtimeState);
		const triggersByNode = this.collectTriggersByNode(snapshot.runtimeState);
		const supervisorByNode = this.collectSupervisorByNode(snapshot.runtimeState);
		const now = Date.now();
		let anyPositionChanged = false;

		for (const node of snapshot.nodes) {
			const handle = this.nodeHandles.get(node.id);
			if (!handle) {
				continue;
			}
			const pos = snapshot.positions.get(node.id) ?? { x: 270, y: 300 };
			const leftCss = `${pos.x}px`;
			const topCss = `${pos.y}px`;
			if (handle.rootEl.style.left !== leftCss || handle.rootEl.style.top !== topCss) {
				handle.rootEl.style.left = leftCss;
				handle.rootEl.style.top = topCss;
				anyPositionChanged = true;
			}

			const nextState = snapshot.runtimeState?.nodeStates[node.id] ?? 'idle';
			if (handle.nodeState !== nextState) {
				if (handle.nodeState !== 'idle') {
					handle.rootEl.classList.remove(`state-${handle.nodeState.replace(/_/g, '-')}`);
				}
				if (nextState !== 'idle') {
					handle.rootEl.classList.add(`state-${nextState.replace(/_/g, '-')}`);
				}
				handle.rootEl.setAttribute('data-node-state', nextState);
				handle.nodeState = nextState;

				if (nextState !== 'idle') {
					if (!handle.stateDotEl) {
						handle.stateDotEl = $('span.ade-mission-state-dot', { 'aria-hidden': 'true', title: nextState });
						handle.idWrapEl.insertBefore(handle.stateDotEl, handle.idWrapEl.firstChild);
					} else {
						handle.stateDotEl.title = nextState;
					}
				} else if (handle.stateDotEl) {
					handle.stateDotEl.remove();
					handle.stateDotEl = undefined;
				}
			}

			const nodeTokens = tokensByNode.get(node.id) ?? [];
			const nodeBarriers = barriersByNode.get(node.id) ?? [];
			const nodeTriggers = triggersByNode.get(node.id) ?? [];
			const boundSup = supervisorByNode.get(node.id);
			const isMissionRunning = snapshot.runtimeState?.status === 'running';
			this.patchNodeRuntimeAccessories(handle, nodeTokens, nodeBarriers, nodeTriggers, boundSup, snapshot.resolveSupervisorDisplay, now, isMissionRunning);

			if (node.kind === 'gate') {
				continue;
			}

			const linkedAgent = snapshot.agentByNodeId.get(node.id);
			const explicitHost = snapshot.runtimeState?.boundary.nodeAssignments[node.id]?.hostAlias;
			const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? snapshot.fallbackOwnerEngineId;
			const engineName = this.hostCatalog.getEngineDisplayName(engineId);
			const nodeTelemetry = snapshot.runtimeState?.nodeTelemetry?.[node.id];
			const resolvedModel = linkedAgent?.preferredModel || nodeTelemetry?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineName.toLowerCase();
			const llmProvider = resolveEffectiveAdeLlmProvider(resolvedModel, engineId, this.hostCatalog.getModelCategoryOverrides());
			const llmProviderLabel = ADE_LLM_PROVIDER_LABELS[llmProvider];
			const resolvedThinking: AdeThinkingLevel = linkedAgent?.preferredThinking ?? 'medium';
			const canSwitchModel = Boolean(linkedAgent && snapshot.canSwitchModel);
			const canSwitchEngine = Boolean(linkedAgent && snapshot.canSwitchEngine(linkedAgent));
			const isMissionLive = snapshot.runtimeState?.status === 'running' || snapshot.runtimeState?.status === 'paused';
			const effectiveProbeUri = linkedAgent ? this.hostCatalog.resolveEffectiveNodeProbeUri(explicitHost, linkedAgent) : undefined;
			const cachedHostProbe = effectiveProbeUri ? this.hostCatalog.getCachedHostEngines(effectiveProbeUri) : undefined;
			const isAssignedEngineUnavailable = Boolean(cachedHostProbe && !cachedHostProbe.availableIds.has(engineId));

			handle.linkedAgent = linkedAgent;
			handle.engineId = engineId;
			handle.canSwitchModel = canSwitchModel;
			handle.canSwitchEngine = canSwitchEngine;

			if (handle.lastModel !== resolvedModel || handle.lastThinking !== resolvedThinking || handle.lastLlmProvider !== llmProvider) {
				const providerChanged = handle.lastLlmProvider !== llmProvider;
				const modelChanged = handle.lastModel !== resolvedModel;
				handle.lastModel = resolvedModel;
				handle.lastThinking = resolvedThinking;
				handle.lastLlmProvider = llmProvider;
				if (handle.coreIconTileEl) {
					const tileCls = `ade-mission-core-icon-well llm-${llmProvider}${canSwitchModel ? ' is-editable' : ''}`;
					if (handle.coreIconTileEl.className !== tileCls) {
						handle.coreIconTileEl.className = tileCls;
					}
					handle.coreIconTileEl.setAttribute('data-llm-provider', llmProvider);
					handle.coreIconTileEl.disabled = !canSwitchModel;
					handle.coreIconTileEl.title = canSwitchModel
						? localize('adeMissionLlmIconSwitchTip', "Driving LLM: {0} ({1}) — Click to switch model & thinking", llmProviderLabel, resolvedModel)
						: localize('adeMissionLlmIconTip', "Driving LLM: {0} ({1})", llmProviderLabel, resolvedModel);
				}
				if (handle.coreLlmGlyphEl && (providerChanged || modelChanged)) {
					clearNode(handle.coreLlmGlyphEl);
					renderAdeLlmIcon(handle.coreLlmGlyphEl, llmProvider, {
						baseClass: 'ade-mission-llm-icon',
						prefix: 'ade-llm',
						tooltip: `${llmProviderLabel} · ${resolvedModel}`,
					});
				}
				if (handle.modelRowEl) {
					const rowCls = `ade-mission-core-model-row${canSwitchModel ? ' is-editable' : ''}`;
					if (handle.modelRowEl.className !== rowCls) {
						handle.modelRowEl.className = rowCls;
					}
					handle.modelRowEl.setAttribute('data-node-model', resolvedModel);
					handle.modelRowEl.setAttribute('data-node-thinking', resolvedThinking);
					handle.modelRowEl.title = canSwitchModel
						? localize('adeMissionModelThinkingSwitchTip', "Model: {0} · Thinking Effort: {1} — Click to switch", resolvedModel, resolvedThinking)
						: localize('adeMissionModelThinkingTip', "Model: {0} · Thinking Effort: {1}", resolvedModel, resolvedThinking);
				}
				if (handle.modelNameEl && handle.modelNameEl.textContent !== resolvedModel) {
					handle.modelNameEl.textContent = resolvedModel;
				}
				if (handle.thinkingTagEl) {
					const thinkCls = `ade-mission-thinking-tag level-${resolvedThinking}`;
					if (handle.thinkingTagEl.className !== thinkCls) {
						handle.thinkingTagEl.className = thinkCls;
					}
					if (handle.thinkingTagEl.textContent !== resolvedThinking) {
						handle.thinkingTagEl.textContent = resolvedThinking;
					}
				}
			}

			const engineLocked = Boolean(linkedAgent && !canSwitchEngine);
			const engineIcon = this.hostCatalog.getEngineIcon(engineId);
			const engineIconKey = serializeMissionEngineIconKey(engineIcon);
			const nextEngineBadgeKey = `${engineId}|${engineName}|${engineIconKey}|${canSwitchEngine ? 1 : 0}|${engineLocked ? 1 : 0}|${isAssignedEngineUnavailable ? 1 : 0}|${isMissionLive ? 1 : 0}`;
			if (handle.engineBadgeEl && handle.lastEngineBadgeKey !== nextEngineBadgeKey) {
				handle.lastEngineBadgeKey = nextEngineBadgeKey;
				const hostNameForTip = handle.isRemoteHost ? (handle.displayHost ?? handle.hostAlias ?? '') : localize('adeMissionLocalHostShort', "Local");
				const badgeCls = `ade-mission-engine-pill${canSwitchEngine ? ' is-editable' : ''}${engineLocked ? ' is-locked' : ''}${isAssignedEngineUnavailable ? ' is-engine-unavailable' : ''}`;
				if (handle.engineBadgeEl.className !== badgeCls) {
					handle.engineBadgeEl.className = badgeCls;
				}
				handle.engineBadgeEl.disabled = !canSwitchEngine;
				handle.engineBadgeEl.setAttribute('data-node-engine-id', engineId);
				handle.engineBadgeEl.setAttribute('data-engine-locked', String(engineLocked));
				handle.engineBadgeEl.setAttribute('data-engine-available', String(!isAssignedEngineUnavailable));
				if (handle.engineIconEl) {
					applyMissionEngineIcon(handle.engineIconEl, engineIcon);
				}
				if (handle.engineNameEl && handle.engineNameEl.textContent !== engineName) {
					handle.engineNameEl.textContent = engineName;
				}
				handle.engineBadgeEl.title = isAssignedEngineUnavailable
					? localize('adeMissionEngineUnavailablePillTooltip', "{0} is not installed on {1} — Click to switch to an available Agent engine", engineName, hostNameForTip)
					: canSwitchEngine
						? localize('adeMissionEngineSwitchOnlyTooltip', "Agent Engine: {0} — Click to switch Agent engine", engineName)
						: isMissionLive
							? localize('adeMissionEngineLockedLiveTooltip', "Agent Engine: {0} (Locked while Mission is running — click the LLM icon above to switch model)", engineName)
							: localize('adeMissionEngineLockedSessionTooltip', "Agent Engine: {0} (Engine locked once session starts — click the LLM icon above to switch model)", engineName);
				if (isAssignedEngineUnavailable) {
					if (!handle.engineWarnDotEl) {
						handle.engineWarnDotEl = append(handle.engineBadgeEl, $('span.ade-mission-engine-warn-dot', { 'aria-hidden': 'true' }));
					}
				} else if (handle.engineWarnDotEl) {
					handle.engineWarnDotEl.remove();
					handle.engineWarnDotEl = undefined;
				}
			}

			const tokInfo = nodeTokens[0];
			const roleKind = snapshot.runtimeState?.boundary.nodeAssignments[node.id]?.roleKind ?? 'worker';
			if (handle.lastRoleKind !== roleKind) {
				handle.lastRoleKind = roleKind;
				const isReviewer = roleKind === 'reviewer';
				handle.rootEl.classList.toggle('is-reviewer-node', isReviewer);
				handle.rootEl.setAttribute('data-node-role-kind', roleKind);
				if (handle.roleBadgeEl) {
					handle.roleBadgeEl.hidden = !isReviewer;
				}
			}
			const checksCount = this.callbacks.getEffectiveNodeChecksCount?.(node.id) ?? (node.checks?.length ?? 0);
			if (handle.lastChecksCount !== checksCount && handle.checksBadgeEl) {
				handle.lastChecksCount = checksCount;
				handle.checksBadgeEl.hidden = checksCount <= 0;
				handle.checksBadgeEl.setAttribute('data-node-checks-count', String(checksCount));
				handle.checksBadgeEl.textContent = `✓ ${checksCount}`;
				handle.checksBadgeEl.title = localize('adeMissionNodeChecksBadgeTip', "{0} deterministic verification check hook(s) active", checksCount);
			}
			const nextSummary = this.formatContextSummary(
				node,
				nextState,
				nodeTelemetry?.summary,
				tokInfo?.lastSummary,
				tokInfo?.failure?.reason,
				tokInfo?.waveId,
				tokInfo?.queued,
			);
			if (handle.contextSummaryEl && handle.contextSummaryEl.textContent !== nextSummary) {
				handle.contextSummaryEl.textContent = nextSummary;
				handle.contextSummaryEl.title = nextSummary;
			}

			if (handle.ctxRowEl) {
				const modelContextFallback = inferModelContextWindowTokens(resolvedModel, { engineId });
				const ctxBreakdown = computeMissionNodeContextBreakdown(nodeTelemetry, modelContextFallback);
				handle.ctxRowEl.className = `ade-mission-ctx-row severity-${ctxBreakdown.severity}`;
				handle.ctxRowEl.setAttribute('data-node-context-pct', String(ctxBreakdown.usedPct));
				handle.ctxRowEl.setAttribute('data-node-context-used', String(ctxBreakdown.usedTokens));
				handle.ctxRowEl.setAttribute('data-node-context-max', String(ctxBreakdown.maxTokens));
				handle.ctxRowEl.setAttribute('data-node-context-noise-pct', String(Math.round(ctxBreakdown.noisePct)));
				const costUsd = nodeTelemetry?.costUsd ?? 0;
				const costEstimated = Boolean(nodeTelemetry?.costEstimated);
				const costLocalFree = Boolean(nodeTelemetry?.costLocalFree && costUsd === 0 && ((nodeTelemetry?.totalTokens ?? 0) > 0 || (nodeTelemetry?.turns ?? 0) > 0));
				const tooltipNoiseSuffix = ctxBreakdown.noisePct > 0
					? ` · ${adeBi(localize('adeMissionCtxTooltipNoiseTag', "Rework Noise {0}%", Math.round(ctxBreakdown.noisePct)), '返工噪音 {0}%', Math.round(ctxBreakdown.noisePct))}`
					: '';
				const tooltipCostSuffix = costUsd > 0
					? ` · ${formatFinOpsUsd(costUsd, { estimated: costEstimated })}${costEstimated ? localize('adeMissionCtxTooltipEstTag', " (预估)") : ''}`
					: (costLocalFree ? ` · ${localize('adeMissionCtxTooltipLocalFree', "Local $0.00")}` : '');
				handle.ctxRowEl.title = localize(
					'adeMissionCtxTooltip',
					"Context Window: {0} / {1} ({2}%) · Init {3}% · Contract {4}% · Workspace {5}%{6}",
					formatCompactTokenCount(ctxBreakdown.usedTokens),
					formatCompactTokenCount(ctxBreakdown.maxTokens),
					ctxBreakdown.usedPct,
					Math.round(ctxBreakdown.initPct),
					Math.round(ctxBreakdown.tierPct),
					Math.round(ctxBreakdown.sourcePct),
					`${tooltipNoiseSuffix}${tooltipCostSuffix}`,
				);
				if (handle.ctxSegInitEl) { handle.ctxSegInitEl.style.width = `${ctxBreakdown.initPct.toFixed(1)}%`; }
				if (handle.ctxSegTierEl) { handle.ctxSegTierEl.style.width = `${ctxBreakdown.tierPct.toFixed(1)}%`; }
				if (handle.ctxSegSourceEl) { handle.ctxSegSourceEl.style.width = `${ctxBreakdown.sourcePct.toFixed(1)}%`; }
				if (handle.ctxSegNoiseEl) { handle.ctxSegNoiseEl.style.width = `${ctxBreakdown.noisePct.toFixed(1)}%`; }
				const tokensLabel = `${formatCompactTokenCount(ctxBreakdown.usedTokens)}/${formatCompactTokenCount(ctxBreakdown.maxTokens)}`;
				const pctLabel = `${ctxBreakdown.usedPct}%`;
				if (handle.ctxTokensEl && handle.ctxTokensEl.textContent !== tokensLabel) {
					handle.ctxTokensEl.textContent = tokensLabel;
				}
				if (handle.ctxCostEl) {
					if (costUsd > 0) {
						handle.ctxCostEl.hidden = false;
						handle.ctxCostEl.setAttribute('data-node-cost-usd', costUsd.toFixed(4));
						if (costEstimated) {
							handle.ctxCostEl.setAttribute('data-node-cost-estimated', 'true');
							handle.ctxCostEl.title = localize('adeMissionNodeCostEstTip', "按内置/自定义模型单价预估费用（可在设置 aexus.ade.finOps.modelPricingOverrides 中覆盖）");
						} else {
							handle.ctxCostEl.removeAttribute('data-node-cost-estimated');
							handle.ctxCostEl.title = '';
						}
						handle.ctxCostEl.removeAttribute('data-node-cost-local');
						const costTxt = formatFinOpsUsd(costUsd, { estimated: costEstimated, compact: true });
						if (handle.ctxCostEl.textContent !== costTxt) {
							handle.ctxCostEl.textContent = costTxt;
						}
					} else if (costLocalFree) {
						handle.ctxCostEl.hidden = false;
						handle.ctxCostEl.setAttribute('data-node-cost-usd', '0');
						handle.ctxCostEl.removeAttribute('data-node-cost-estimated');
						handle.ctxCostEl.setAttribute('data-node-cost-local', 'true');
						handle.ctxCostEl.title = localize('adeMissionNodeCostLocalFreeTip', "本地/自托管零成本模型 ($0.00)");
						const localTxt = 'Local $0';
						if (handle.ctxCostEl.textContent !== localTxt) {
							handle.ctxCostEl.textContent = localTxt;
						}
					} else {
						handle.ctxCostEl.hidden = true;
						handle.ctxCostEl.setAttribute('data-node-cost-usd', '0');
						handle.ctxCostEl.removeAttribute('data-node-cost-estimated');
						handle.ctxCostEl.removeAttribute('data-node-cost-local');
						handle.ctxCostEl.title = '';
					}
				}
				if (handle.ctxPctEl && handle.ctxPctEl.textContent !== pctLabel) {
					handle.ctxPctEl.textContent = pctLabel;
				}
			}
		}

		this.syncNodePromptPreviews(snapshot.nodePrompts);
		if (anyPositionChanged) {
			this.updateEdgesSvg(snapshot.nodes, snapshot.edges, snapshot.positions, { direction: snapshot.direction ?? this.lastDirection });
		}
		this.patchEdgeRuntimeStates(snapshot.runtimeState);
	}

	syncNodePromptPreviews(prompts: Readonly<Record<string, string>>): void {
		for (const [nodeId, handle] of this.nodeHandles.entries()) {
			if (!handle.promptBtnEl || !handle.promptPreviewEl || !handle.promptTagEl) {
				continue;
			}
			const raw = prompts[nodeId] ?? '';
			const trimmed = raw.trim();
			const hasPrompt = trimmed.length > 0;
			const singleLine = hasPrompt ? trimmed.replace(/\s+/g, ' ') : '';
			handle.promptBtnEl.classList.toggle('has-prompt', hasPrompt);
			handle.promptBtnEl.setAttribute('data-has-prompt', String(hasPrompt));
			handle.promptBtnEl.title = hasPrompt
				? localize('adeMissionNodePromptBtnTip', "节点 {0} 提示词（点击编辑）：\n{1}", nodeId, raw)
				: localize('adeMissionNodePromptBtnEmptyTip', "点击编写节点 {0} 的任务说明", nodeId);
			const nextPreview = hasPrompt
				? singleLine
				: localize('adeMissionNodePromptEmptyPreview', "点击添加节点任务说明…");
			if (handle.promptPreviewEl.textContent !== nextPreview) {
				handle.promptPreviewEl.textContent = nextPreview;
			}
			const nextTag = hasPrompt
				? localize('adeMissionNodePromptTagEdit', "提示词")
				: localize('adeMissionNodePromptTagAdd', "+ 提示词");
			if (handle.promptTagEl.textContent !== nextTag) {
				handle.promptTagEl.textContent = nextTag;
			}
		}
	}

	private rebuildFullGraphDom(snapshot: IMissionCanvasRenderSnapshot): void {
		this.nodeDragDisposables.clear();
		this.graphDisposables.clear();
		this.edgeDisposables.clear();
		this.connectDragDisposables.clear();
		this.inlineRenameDisposables.clear();
		this.nodeHandles.clear();
		this.edgeHandles.clear();
		this.tokenGliderHandles.clear();
		this.lastEdgeStructureKey = '';
		if (this.hoveredNodeId && !snapshot.nodes.some(n => n.id === this.hoveredNodeId)) {
			this.hoveredNodeId = undefined;
		}
		this.hoveredTraceEdgeKeys = undefined;
		this.worldEl.classList.remove('has-node-hover', 'has-trace-hover');
		clearNode(this.nodesLayerEl);
		for (const layer of [this.cloudTerritoriesLayerEl, this.edgesLayerEl, this.contextLinksLayerEl, this.tokenGliderLayerEl]) {
			while (layer.firstChild) {
				layer.removeChild(layer.firstChild);
			}
		}

		const tokensByNode = this.collectTokensByNode(snapshot.runtimeState);
		const barriersByNode = this.collectJoinBarriersByNode(snapshot.runtimeState);
		const triggersByNode = this.collectTriggersByNode(snapshot.runtimeState);
		const supervisorByNode = this.collectSupervisorByNode(snapshot.runtimeState);
		const inDegreeByNode = new Map<string, number>();
		const outDegreeByNode = new Map<string, number>();
		for (const edge of snapshot.edges) {
			outDegreeByNode.set(edge.from, (outDegreeByNode.get(edge.from) ?? 0) + 1);
			inDegreeByNode.set(edge.to, (inDegreeByNode.get(edge.to) ?? 0) + 1);
		}
		const now = Date.now();
		const isMissionLive = snapshot.runtimeState?.status === 'running' || snapshot.runtimeState?.status === 'paused';
		const isMissionRunning = snapshot.runtimeState?.status === 'running';

		for (const node of snapshot.nodes) {
			const pos = snapshot.positions.get(node.id) ?? { x: 270, y: 300 };
			const nodeState = snapshot.runtimeState?.nodeStates[node.id] ?? 'idle';
			const stateClass = nodeState !== 'idle' ? `.state-${nodeState.replace(/_/g, '-')}` : '';
			const linkedAgent = node.kind !== 'gate' ? snapshot.agentByNodeId.get(node.id) : undefined;
			const explicitHost = snapshot.runtimeState?.boundary.nodeAssignments[node.id]?.hostAlias;
			const hostInfo = node.kind !== 'gate'
				? this.hostCatalog.resolveNodeHostAndOs(explicitHost, linkedAgent)
				: undefined;
			const hostModifiers = hostInfo
				? `${hostInfo.isRemote ? '.is-remote-host' : '.is-local-host'}.os-${hostInfo.osKind}`
				: '';

			const rankDef = node.kind !== 'gate'
				? resolveEffectiveRankDefinition(snapshot.orgConfig, linkedAgent?.role, linkedAgent ? snapshot.hasSubordinates(linkedAgent.id) : false)
				: undefined;
			const assignedTier = snapshot.runtimeState?.boundary.nodeAssignments[node.id]?.tier ?? rankDef?.tier;
			const rankBadgeLabel = rankDef
				? `${formatTierTag(assignedTier ?? rankDef.tier)} ${rankDef.name}`
				: (assignedTier !== undefined ? formatTierTag(assignedTier) : undefined);

			const nodeEl = append(this.nodesLayerEl, $(`.ade-mission-node.kind-${node.kind}${stateClass}${hostModifiers}`, {
				'data-node-id': node.id,
				'data-node-state': nodeState,
				...(hostInfo ? { 'data-node-os': hostInfo.osKind, 'data-node-host': hostInfo.hostAlias } : {}),
				...(rankDef ? { 'data-node-rank': rankDef.id, 'data-node-tier': String(assignedTier ?? rankDef.tier) } : {}),
				...(node.employeeKey ? { 'data-employee-key': node.employeeKey } : {}),
			}));
			nodeEl.style.left = `${pos.x}px`;
			nodeEl.style.top = `${pos.y}px`;

			const card = append(nodeEl, $('.ade-mission-node-card'));
			append(card, $('span.ade-mission-clamp.tl', { 'aria-hidden': 'true' }));
			append(card, $('span.ade-mission-clamp.tr', { 'aria-hidden': 'true' }));
			append(card, $('span.ade-mission-clamp.bl', { 'aria-hidden': 'true' }));
			append(card, $('span.ade-mission-clamp.br', { 'aria-hidden': 'true' }));

			const topRow = append(card, $('.ade-mission-node-top'));
			const idWrap = append(topRow, $('span.ade-mission-node-id-wrap'));
			let stateDotEl: HTMLElement | undefined;
			if (nodeState !== 'idle') {
				stateDotEl = append(idWrap, $('span.ade-mission-state-dot', {
					'aria-hidden': 'true',
					title: nodeState,
				}));
			}
			append(idWrap, $('span.ade-mission-node-id', {}, node.id));

			let gateMetaEl: HTMLElement | undefined;
			let titleEl!: HTMLElement;
			let roleBadgeEl: HTMLElement | undefined;
			let checksBadgeEl: HTMLElement | undefined;
			let handleLastRoleKind: string | undefined;
			let handleLastChecksCount: number | undefined;
			let supBtnEl: HTMLButtonElement | undefined;
			let supDotEl: HTMLElement | undefined;
			let supNameEl: HTMLElement | undefined;
			let coreIconTileEl: HTMLButtonElement | undefined;
			let coreLlmGlyphEl: HTMLElement | undefined;
			let modelRowEl: HTMLElement | undefined;
			let modelNameEl: HTMLElement | undefined;
			let thinkingTagEl: HTMLElement | undefined;
			let engineBadgeEl: HTMLButtonElement | undefined;
			let engineIconEl: HTMLElement | undefined;
			let engineNameEl: HTMLElement | undefined;
			let engineWarnDotEl: HTMLElement | undefined;
			let handleEngineId = snapshot.fallbackOwnerEngineId;
			let handleCanSwitchEngine = false;
			let handleCanSwitchModel = false;
			let handleLastModel: string | undefined;
			let handleLastThinking: AdeThinkingLevel | undefined;
			let handleLastLlmProvider: string | undefined;
			let handleLastEngineBadgeKey: string | undefined;
			let contextSummaryEl: HTMLElement | undefined;
			let promptBtnEl: HTMLButtonElement | undefined;
			let promptPreviewEl: HTMLElement | undefined;
			let promptTagEl: HTMLElement | undefined;
			let ctxRowEl: HTMLElement | undefined;
			let ctxSegInitEl: HTMLElement | undefined;
			let ctxSegTierEl: HTMLElement | undefined;
			let ctxSegSourceEl: HTMLElement | undefined;
			let ctxSegNoiseEl: HTMLElement | undefined;
			let ctxTokensEl: HTMLElement | undefined;
			let ctxCostEl: HTMLElement | undefined;
			let ctxPctEl: HTMLElement | undefined;

			if (node.kind === 'gate') {
				append(topRow, $('span.ade-mission-node-kind-tag', {}, localize('adeMissionGateTag', "Gate")));
				const gateWell = append(card, $('.ade-mission-core-well.gate-well'));
				titleEl = append(gateWell, $('.ade-mission-node-title', { title: node.label }, node.label));
				gateMetaEl = append(gateWell, $('.ade-mission-gate-meta', { 'data-ade-gate-meta': node.id }));
				gateMetaEl.hidden = true;
			} else {
				if (rankBadgeLabel) {
					const tierNum = Math.max(1, Math.min(4, assignedTier ?? rankDef?.tier ?? 2));
					append(idWrap, $(`span.ade-mission-rank-pill.tier-${tierNum}`, {
						title: localize('adeMissionNodeRankTooltip', "Organization Rank: {0}", rankBadgeLabel),
					}, rankBadgeLabel));
				}
				const initRoleKind = snapshot.runtimeState?.boundary.nodeAssignments[node.id]?.roleKind ?? 'worker';
				const isInitReviewer = initRoleKind === 'reviewer';
				handleLastRoleKind = initRoleKind;
				nodeEl.classList.toggle('is-reviewer-node', isInitReviewer);
				nodeEl.setAttribute('data-node-role-kind', initRoleKind);

				const initChecksCount = this.callbacks.getEffectiveNodeChecksCount?.(node.id) ?? (node.checks?.length ?? 0);
				handleLastChecksCount = initChecksCount;

				const topPills = append(topRow, $('.ade-mission-top-pills'));
				supBtnEl = append(topPills, $('button.ade-mission-sup-pill.is-auto', {
					type: 'button',
					'data-node-sup-btn': node.id,
				})) as HTMLButtonElement;
				supDotEl = append(supBtnEl, $('span.ade-mission-sup-dot', { 'aria-hidden': 'true' }));
				supDotEl.hidden = true;
				append(supBtnEl, $('span.codicon.codicon-shield.ade-mission-sup-ico', { 'aria-hidden': 'true' }));
				supNameEl = append(supBtnEl, $('span.ade-mission-sup-name', {}, localize('adeMissionSupAutoShort', "+ Sup")));
				this.graphDisposables.add(addDisposableListener(supBtnEl, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenSupervisorPopover?.(node, supBtnEl!);
				}));

				const isAssigned = Boolean(node.employeeName && node.employeeKey);
				const isReused = Boolean((node.employeeTotalOccurrences ?? 0) > 1);
				const colorCls = isAssigned ? `.emp-color-${getEmployeeColorIndex(node.employeeKey!)}` : '.unassigned';
				const empBtn = append(topPills, $(`button.ade-mission-emp-pill${colorCls}${isReused ? '.is-reused' : ''}`, {
					type: 'button',
					'data-node-emp-btn': node.id,
					title: isAssigned
						? (isReused
							? localize('adeMissionEmpReusedTooltip', "Employee {0} (step #{1} of {2}, shared context) — Click to reassign", node.employeeName!, node.employeeOccurrence!, node.employeeTotalOccurrences!)
							: localize('adeMissionEmpAssignedTooltip', "Employee {0} — Click to reuse across steps or reassign", node.employeeName!))
						: localize('adeMissionEmpAssignTooltip', "Assign or reuse an employee for this step"),
				})) as HTMLButtonElement;
				if (isAssigned) {
					append(empBtn, $('span.ade-mission-emp-dot', { 'aria-hidden': 'true' }));
					append(empBtn, $('span.ade-mission-emp-name', {}, node.employeeName!));
					if (isReused && node.employeeOccurrence && node.employeeTotalOccurrences) {
						append(empBtn, $('span.ade-mission-emp-seq', {}, `#${node.employeeOccurrence}/${node.employeeTotalOccurrences}`));
					}
				} else {
					append(empBtn, $('span.codicon.codicon-person-add', { 'aria-hidden': 'true' }));
					append(empBtn, $('span.ade-mission-emp-name', {}, localize('adeMissionEmpAssignShort', "Assign")));
				}
				this.graphDisposables.add(addDisposableListener(empBtn, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenEmployeePopover(node, empBtn);
				}));

				const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? snapshot.fallbackOwnerEngineId;
				const engineName = this.hostCatalog.getEngineDisplayName(engineId);
				const engineIcon = this.hostCatalog.getEngineIcon(engineId);
				const nodeTelemetry = snapshot.runtimeState?.nodeTelemetry?.[node.id];
				const resolvedModel = linkedAgent?.preferredModel || nodeTelemetry?.model || MISSION_ENGINE_DEFAULT_MODELS[engineId] || engineName.toLowerCase();
				const llmProvider = resolveEffectiveAdeLlmProvider(resolvedModel, engineId, this.hostCatalog.getModelCategoryOverrides());
				const llmProviderLabel = ADE_LLM_PROVIDER_LABELS[llmProvider];
				const resolvedThinking: AdeThinkingLevel = linkedAgent?.preferredThinking ?? 'medium';
				const canSwitchModel = Boolean(linkedAgent && snapshot.canSwitchModel);
				const canSwitchEngine = Boolean(linkedAgent && snapshot.canSwitchEngine(linkedAgent));
				const modelContextFallback = inferModelContextWindowTokens(resolvedModel, { engineId });
				const ctxBreakdown = computeMissionNodeContextBreakdown(nodeTelemetry, modelContextFallback);
				const effectiveProbeUri = linkedAgent ? this.hostCatalog.resolveEffectiveNodeProbeUri(explicitHost, linkedAgent) : undefined;
				const cachedHostProbe = effectiveProbeUri ? this.hostCatalog.getCachedHostEngines(effectiveProbeUri) : undefined;
				const isAssignedEngineUnavailable = Boolean(cachedHostProbe && !cachedHostProbe.availableIds.has(engineId));

				handleEngineId = engineId;
				handleCanSwitchEngine = canSwitchEngine;
				handleCanSwitchModel = canSwitchModel;
				handleLastModel = resolvedModel;
				handleLastThinking = resolvedThinking;
				handleLastLlmProvider = llmProvider;

				const coreWell = append(card, $('.ade-mission-core-well'));
				const coreHead = append(coreWell, $('.ade-mission-core-head'));
				const coreIconTile = append(coreHead, $(`button.ade-mission-core-icon-well.llm-${llmProvider}${canSwitchModel ? '.is-editable' : ''}`, {
					type: 'button',
					'data-llm-provider': llmProvider,
					title: canSwitchModel
						? localize('adeMissionLlmIconSwitchTip', "Driving LLM: {0} ({1}) — Click to switch model & thinking", llmProviderLabel, resolvedModel)
						: localize('adeMissionLlmIconTip', "Driving LLM: {0} ({1})", llmProviderLabel, resolvedModel),
				})) as HTMLButtonElement;
				coreIconTileEl = coreIconTile;
				const coreLlmGlyph = append(coreIconTile, $('span.ade-mission-llm-icon', { 'aria-hidden': 'true' }));
				coreLlmGlyphEl = coreLlmGlyph;
				renderAdeLlmIcon(coreLlmGlyph, llmProvider, {
					baseClass: 'ade-mission-llm-icon',
					prefix: 'ade-llm',
					tooltip: `${llmProviderLabel} · ${resolvedModel}`,
				});
				if (!canSwitchModel) {
					coreIconTile.disabled = true;
				}

				const coreMeta = append(coreHead, $('.ade-mission-core-meta'));
				const coreTitleRow = append(coreMeta, $('.ade-mission-core-title-row'));
				titleEl = append(coreTitleRow, $('.ade-mission-node-title', { title: node.label }, node.label));
				roleBadgeEl = append(coreTitleRow, $('span.ade-mission-reviewer-pill', {
					'data-node-role-badge': node.id,
					title: localize('adeMissionReviewerPillTip', "In-Graph Reviewer Node — audits upstream deliverables and can reject back upstream"),
				}, localize('adeMissionReviewerPillLabel', "Reviewer")));
				roleBadgeEl.hidden = !isInitReviewer;
				checksBadgeEl = append(coreTitleRow, $('span.ade-mission-checks-pill', {
					'data-node-checks-count': String(initChecksCount),
					title: localize('adeMissionNodeChecksBadgeTip', "{0} deterministic verification check hook(s) active", initChecksCount),
				}, `✓ ${initChecksCount}`));
				checksBadgeEl.hidden = initChecksCount <= 0;
				const modelRow = append(coreMeta, $(`.ade-mission-core-model-row${canSwitchModel ? '.is-editable' : ''}`, {
					'data-node-model': resolvedModel,
					'data-node-thinking': resolvedThinking,
					title: canSwitchModel
						? localize('adeMissionModelThinkingSwitchTip', "Model: {0} · Thinking Effort: {1} — Click to switch", resolvedModel, resolvedThinking)
						: localize('adeMissionModelThinkingTip', "Model: {0} · Thinking Effort: {1}", resolvedModel, resolvedThinking),
				}));
				modelRowEl = modelRow;
				modelNameEl = append(modelRow, $('span.ade-mission-model-name', {}, resolvedModel));
				append(modelRow, $('span.ade-mission-model-sep', { 'aria-hidden': 'true' }, '·'));
				thinkingTagEl = append(modelRow, $(`span.ade-mission-thinking-tag.level-${resolvedThinking}`, {}, resolvedThinking));

				const tokInfo = (tokensByNode.get(node.id) ?? [])[0];
				const contextSummaryText = this.formatContextSummary(
					node,
					nodeState,
					nodeTelemetry?.summary,
					tokInfo?.lastSummary,
					tokInfo?.failure?.reason,
					tokInfo?.waveId,
					tokInfo?.queued,
				);
				contextSummaryEl = append(coreWell, $('.ade-mission-core-context', { title: contextSummaryText }, contextSummaryText));

				// Per-Node Pre-Prompt preview bar & direct edit button
				const rawNodePrompt = snapshot.nodePrompts[node.id] ?? '';
				const trimmedNodePrompt = rawNodePrompt.trim();
				const hasNodePrompt = trimmedNodePrompt.length > 0;
				promptBtnEl = append(coreWell, $(`button.ade-mission-node-prompt-bar${hasNodePrompt ? '.has-prompt' : ''}`, {
					type: 'button',
					'data-ade-node-prompt-btn': node.id,
					'data-has-prompt': String(hasNodePrompt),
					title: hasNodePrompt
						? localize('adeMissionNodePromptBtnTip', "节点 {0} 提示词（点击编辑）：\n{1}", node.id, rawNodePrompt)
						: localize('adeMissionNodePromptBtnEmptyTip', "点击编写节点 {0} 的任务说明", node.id),
				})) as HTMLButtonElement;
				append(promptBtnEl, $('span.codicon.codicon-note.ade-mission-node-prompt-ico', { 'aria-hidden': 'true' }));
				promptPreviewEl = append(promptBtnEl, $('span.ade-mission-node-prompt-preview', {
					'data-ade-node-prompt-preview': node.id,
				}, hasNodePrompt
					? trimmedNodePrompt.replace(/\s+/g, ' ')
					: localize('adeMissionNodePromptEmptyPreview', "点击添加节点任务说明…")));
				promptTagEl = append(promptBtnEl, $('span.ade-mission-node-prompt-tag', {}, hasNodePrompt
					? localize('adeMissionNodePromptTagEdit', "提示词")
					: localize('adeMissionNodePromptTagAdd', "+ 提示词")));
				this.graphDisposables.add(addDisposableListener(promptBtnEl, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenNodePromptPopover(node, promptBtnEl!);
				}));

				// 4-Segment Context Window Usage Progress Bar
				const initCostUsd = nodeTelemetry?.costUsd ?? 0;
				const initCostEstimated = Boolean(nodeTelemetry?.costEstimated);
				const initCostLocalFree = Boolean(nodeTelemetry?.costLocalFree && initCostUsd === 0 && ((nodeTelemetry?.totalTokens ?? 0) > 0 || (nodeTelemetry?.turns ?? 0) > 0));
				const initNoiseTooltipSuffix = ctxBreakdown.noisePct > 0
					? ` · ${adeBi(localize('adeMissionCtxTooltipNoiseTag', "Rework Noise {0}%", Math.round(ctxBreakdown.noisePct)), '返工噪音 {0}%', Math.round(ctxBreakdown.noisePct))}`
					: '';
				const initCostTooltipSuffix = initCostUsd > 0
					? ` · ${formatFinOpsUsd(initCostUsd, { estimated: initCostEstimated })}${initCostEstimated ? localize('adeMissionCtxTooltipEstTag', " (预估)") : ''}`
					: (initCostLocalFree ? ` · ${localize('adeMissionCtxTooltipLocalFree', "Local $0.00")}` : '');
				const ctxTooltip = localize(
					'adeMissionCtxTooltip',
					"Context Window: {0} / {1} ({2}%) · Init {3}% · Contract {4}% · Workspace {5}%{6}",
					formatCompactTokenCount(ctxBreakdown.usedTokens),
					formatCompactTokenCount(ctxBreakdown.maxTokens),
					ctxBreakdown.usedPct,
					Math.round(ctxBreakdown.initPct),
					Math.round(ctxBreakdown.tierPct),
					Math.round(ctxBreakdown.sourcePct),
					`${initNoiseTooltipSuffix}${initCostTooltipSuffix}`,
				);
				ctxRowEl = append(card, $(`.ade-mission-ctx-row.severity-${ctxBreakdown.severity}`, {
					title: ctxTooltip,
					'data-node-context-pct': String(ctxBreakdown.usedPct),
					'data-node-context-used': String(ctxBreakdown.usedTokens),
					'data-node-context-max': String(ctxBreakdown.maxTokens),
					'data-node-context-noise-pct': String(Math.round(ctxBreakdown.noisePct)),
				}));
				const ctxTrack = append(ctxRowEl, $('.ade-mission-ctx-track'));
				ctxSegInitEl = append(ctxTrack, $('.ade-ctx-seg.seg-init'));
				ctxSegTierEl = append(ctxTrack, $('.ade-ctx-seg.seg-tier'));
				ctxSegSourceEl = append(ctxTrack, $('.ade-ctx-seg.seg-source'));
				ctxSegNoiseEl = append(ctxTrack, $('.ade-ctx-seg.seg-noise'));
				ctxSegInitEl.style.width = `${ctxBreakdown.initPct.toFixed(1)}%`;
				ctxSegTierEl.style.width = `${ctxBreakdown.tierPct.toFixed(1)}%`;
				ctxSegSourceEl.style.width = `${ctxBreakdown.sourcePct.toFixed(1)}%`;
				ctxSegNoiseEl.style.width = `${ctxBreakdown.noisePct.toFixed(1)}%`;

				const ctxStats = append(ctxRowEl, $('.ade-mission-ctx-stats'));
				ctxTokensEl = append(ctxStats, $('span.ade-mission-ctx-tokens', {}, `${formatCompactTokenCount(ctxBreakdown.usedTokens)}/${formatCompactTokenCount(ctxBreakdown.maxTokens)}`));
				const initCostAttrs: Record<string, string> = {
					'data-node-cost-usd': initCostUsd > 0 ? initCostUsd.toFixed(4) : '0',
				};
				if (initCostUsd > 0 && initCostEstimated) {
					initCostAttrs['data-node-cost-estimated'] = 'true';
					initCostAttrs.title = localize('adeMissionNodeCostEstTip', "按内置/自定义模型单价预估费用（可在设置 aexus.ade.finOps.modelPricingOverrides 中覆盖）");
				} else if (initCostLocalFree) {
					initCostAttrs['data-node-cost-local'] = 'true';
					initCostAttrs.title = localize('adeMissionNodeCostLocalFreeTip', "本地/自托管零成本模型 ($0.00)");
				}
				const initCostLabel = initCostUsd > 0
					? formatFinOpsUsd(initCostUsd, { estimated: initCostEstimated, compact: true })
					: (initCostLocalFree ? 'Local $0' : '');
				ctxCostEl = append(ctxStats, $('span.ade-mission-ctx-cost', initCostAttrs, initCostLabel));
				ctxCostEl.hidden = initCostUsd <= 0 && !initCostLocalFree;
				ctxPctEl = append(ctxStats, $('span.ade-mission-ctx-pct', {}, `${ctxBreakdown.usedPct}%`));

				// Bottom Telemetry Footer: Agent Engine Pill (left) + Colorful OS & Host Pill (right)
				const footer = append(card, $('.ade-mission-node-footer'));
				const engineLocked = Boolean(linkedAgent && !canSwitchEngine);
				handleLastEngineBadgeKey = `${canSwitchEngine ? 1 : 0}|${engineLocked ? 1 : 0}|${isAssignedEngineUnavailable ? 1 : 0}|${isMissionLive ? 1 : 0}`;
				const hostNameForTip = hostInfo?.isRemote ? hostInfo.displayHost : localize('adeMissionLocalHostShort', "Local");
				const engineBadge = append(footer, $(`button.ade-mission-engine-pill${canSwitchEngine ? '.is-editable' : ''}${engineLocked ? '.is-locked' : ''}${isAssignedEngineUnavailable ? '.is-engine-unavailable' : ''}`, {
					type: 'button',
					'data-node-engine-id': engineId,
					'data-engine-locked': String(engineLocked),
					'data-engine-available': String(!isAssignedEngineUnavailable),
					title: isAssignedEngineUnavailable
						? localize('adeMissionEngineUnavailablePillTooltip', "{0} is not installed on {1} — Click to switch to an available Agent engine", engineName, hostNameForTip)
						: canSwitchEngine
							? localize('adeMissionEngineSwitchOnlyTooltip', "Agent Engine: {0} — Click to switch Agent engine", engineName)
							: isMissionLive
								? localize('adeMissionEngineLockedLiveTooltip', "Agent Engine: {0} (Locked while Mission is running — click the LLM icon above to switch model)", engineName)
								: localize('adeMissionEngineLockedSessionTooltip', "Agent Engine: {0} (Engine locked once session starts — click the LLM icon above to switch model)", engineName),
				})) as HTMLButtonElement;
				engineBadgeEl = engineBadge;
				const iconEl = append(engineBadge, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
				applyMissionEngineIcon(iconEl, engineIcon);
				engineIconEl = iconEl;
				engineNameEl = append(engineBadge, $('span.ade-mission-engine-name', {}, engineName));
				handleLastEngineBadgeKey = `${engineId}|${engineName}|${serializeMissionEngineIconKey(engineIcon)}|${canSwitchEngine ? 1 : 0}|${engineLocked ? 1 : 0}|${isAssignedEngineUnavailable ? 1 : 0}|${isMissionLive ? 1 : 0}`;
				if (isAssignedEngineUnavailable) {
					engineWarnDotEl = append(engineBadge, $('span.ade-mission-engine-warn-dot', { 'aria-hidden': 'true' }));
				}
				if (!canSwitchEngine) {
					engineBadge.disabled = true;
				}

				if (hostInfo) {
					const hostPill = append(footer, $(`button.ade-mission-host-pill.os-${hostInfo.osKind}${hostInfo.isRemote ? '.is-remote' : '.is-local'}${snapshot.canSwitchHost ? '.is-editable' : ''}`, {
						type: 'button',
						title: hostInfo.isRemote
							? localize('adeMissionRemoteOsHostTip', "{0} · Cloud Host: {1} — Click to switch execution host", hostInfo.osLabel, hostInfo.displayHost)
							: localize('adeMissionLocalOsHostTip', "{0} · Local Machine — Click to bind a Cloud Host", hostInfo.osLabel),
						'data-node-host': hostInfo.hostAlias,
						'data-node-os': hostInfo.osKind,
					})) as HTMLButtonElement;
					const osIconEl = append(hostPill, $('span.ade-mission-os-icon', { 'aria-hidden': 'true' }));
					renderAdeOsIcon(osIconEl, hostInfo.osKind, {
						baseClass: 'ade-mission-os-icon',
						prefix: 'ade-os',
						tooltip: `${hostInfo.osLabel} · ${hostInfo.displayHost}`,
					});
					const hostDisplayLabel = hostInfo.isRemote ? hostInfo.displayHost : `Local · ${hostInfo.osLabel}`;
					append(hostPill, $('span.ade-mission-host-name', {}, hostDisplayLabel));
					if (snapshot.canSwitchHost) {
						this.graphDisposables.add(addDisposableListener(hostPill, EventType.CLICK, e => {
							e.stopPropagation();
							this.callbacks.onOpenHostPopover(node, hostInfo.hostAlias, hostPill);
						}));
					} else {
						hostPill.disabled = true;
					}
				}
			}

			const inDeg = inDegreeByNode.get(node.id) ?? 0;
			const outDeg = outDegreeByNode.get(node.id) ?? 0;
			const nodeTriggers = triggersByNode.get(node.id) ?? [];
			const isSourcePacemaker = node.kind !== 'gate' && inDeg === 0 && (outDeg >= 1 || nodeTriggers.length > 0);
			let pacemakerPortEl: HTMLButtonElement | undefined;
			if (isSourcePacemaker) {
				pacemakerPortEl = append(card, $('button.ade-mission-port.port-in.is-pacemaker', {
					type: 'button',
					'data-ade-pacemaker-port': node.id,
					title: localize('adeMissionPacemakerPortTip', "Source Generator Pacemaker — Click to configure interval, cron, file, git, or GPU-idle triggers"),
					'aria-label': localize('adeMissionPacemakerPortAria', "Configure Source Triggers for {0}", node.id),
				})) as HTMLButtonElement;
				append(pacemakerPortEl, $('span.ade-mission-pacemaker-ring.ring-1', { 'aria-hidden': 'true' }));
				append(pacemakerPortEl, $('span.ade-mission-pacemaker-ring.ring-2', { 'aria-hidden': 'true' }));
				this.graphDisposables.add(addDisposableListener(pacemakerPortEl, EventType.CLICK, e => {
					e.stopPropagation();
					this.callbacks.onOpenNodeTriggersPopover?.(node, pacemakerPortEl!);
				}));
			} else {
				append(card, $('.ade-mission-port.port-in', { 'aria-hidden': 'true' }));
			}
			const outPortEl = append(card, $('button.ade-mission-port.port-out.is-connectable', {
				type: 'button',
				'data-ade-connect-port': node.id,
				title: localize('adeMissionOutPortConnectTip', "Drag to another node to connect an edge (hold Shift to create an on_fail branch)"),
				'aria-label': localize('adeMissionOutPortConnectAria', "Drag to connect from {0}", node.id),
			})) as HTMLButtonElement;
			this.bindOutPortConnectDrag(node, outPortEl);
			append(card, $('.ade-mission-port.port-ctx-top', { 'aria-hidden': 'true' }));
			append(card, $('.ade-mission-port.port-ctx-bottom', { 'aria-hidden': 'true' }));

			// Floating Runtime Accessories (mounted outside fixed-height card to preserve edge port geometry)
			const joinCapsuleEl = append(nodeEl, $('.ade-mission-join-capsule', {
				'data-ade-join-progress': node.id,
			}));
			joinCapsuleEl.hidden = true;
			const joinDotsEl = append(joinCapsuleEl, $('span.ade-mission-join-dots', { 'aria-hidden': 'true' }));
			const joinCountEl = append(joinCapsuleEl, $('span.ade-mission-join-count'));

			const triggerBadgeEl = append(nodeEl, $('button.ade-mission-trigger-badge', {
				type: 'button',
				'data-ade-node-trigger-badge': node.id,
			})) as HTMLButtonElement;
			triggerBadgeEl.hidden = true;
			const triggerBadgeLabelEl = append(triggerBadgeEl, $('span.ade-mission-trigger-badge-label'));

			const tokenPuckEl = append(nodeEl, $('button.ade-mission-token-puck', {
				type: 'button',
				'data-ade-token-puck': node.id,
			})) as HTMLButtonElement;
			tokenPuckEl.hidden = true;
			const tokenPuckIconEl = append(tokenPuckEl, $('span.ade-mission-token-puck-icon', { 'aria-hidden': 'true' }));
			const tokenPuckLabelEl = append(tokenPuckEl, $('span.ade-mission-token-puck-label'));
			const tokenPuckExtraEl = append(tokenPuckEl, $('span.ade-mission-token-puck-extra'));
			tokenPuckExtraEl.hidden = true;

			const bottomDockEl = append(nodeEl, $('.ade-mission-node-bottom-dock'));
			bottomDockEl.hidden = true;

			const blockedStripEl = append(bottomDockEl, $('button.ade-mission-blocked-strip', {
				type: 'button',
				'data-ade-blocked-strip': node.id,
			})) as HTMLButtonElement;
			blockedStripEl.hidden = true;
			const blockedWaveEl = append(blockedStripEl, $('span.ade-mission-blocked-wave', {
				'data-ade-blocked-wave': node.id,
			}));
			const blockedCountdownEl = append(blockedStripEl, $('span.ade-mission-blocked-countdown', {
				'data-ade-blocked-countdown': node.id,
			}));
			const blockedPidEl = append(blockedStripEl, $('span.ade-mission-blocked-chip.pid', {
				'data-ade-blocked-pid': node.id,
			}));
			blockedPidEl.hidden = true;
			const blockedFileEl = append(blockedStripEl, $('span.ade-mission-blocked-chip.file', {
				'data-ade-blocked-file': node.id,
			}));
			blockedFileEl.hidden = true;
			const blockedHostEl = append(blockedStripEl, $('span.ade-mission-blocked-chip.host', {
				'data-ade-blocked-host': node.id,
			}));
			blockedHostEl.hidden = true;

			const failedStripEl = append(bottomDockEl, $('button.ade-mission-failed-strip', {
				type: 'button',
				'data-ade-failed-strip': node.id,
			})) as HTMLButtonElement;
			failedStripEl.hidden = true;
			const failedWaveEl = append(failedStripEl, $('span.ade-mission-failed-wave', {
				'data-ade-failed-wave': node.id,
			}));
			const failedReasonEl = append(failedStripEl, $('span.ade-mission-failed-reason', {
				'data-ade-failed-reason': node.id,
			}));

			const recoveryBarEl = append(bottomDockEl, $('.ade-mission-node-recovery-bar', {
				'data-ade-node-recovery': node.id,
			}));
			recoveryBarEl.hidden = true;
			const checkFailChipEl = append(recoveryBarEl, $('button.ade-mission-recovery-btn.check-fail', {
				type: 'button',
				'data-ade-node-check-fail': node.id,
			})) as HTMLButtonElement;
			checkFailChipEl.hidden = true;
			const retryBtnEl = append(recoveryBarEl, $('button.ade-mission-recovery-btn.retry', {
				type: 'button',
				'data-ade-node-retry': node.id,
				title: localize('adeMissionNodeRetryBtnTip', "Retry this failed node in place"),
			})) as HTMLButtonElement;
			append(retryBtnEl, $('span.codicon.codicon-refresh', { 'aria-hidden': 'true' }));
			append(retryBtnEl, $('span', {}, localize('adeMissionNodeRetryBtn', "Retry")));
			retryBtnEl.hidden = true;

			const guidedRetryBtnEl = append(recoveryBarEl, $('button.ade-mission-recovery-btn.guided-retry', {
				type: 'button',
				'data-ade-node-retry-guided': node.id,
				title: localize('adeMissionNodeGuidedRetryBtnTip', "Retry with custom guidance instructions for this node"),
			})) as HTMLButtonElement;
			append(guidedRetryBtnEl, $('span.codicon.codicon-comment-discussion', { 'aria-hidden': 'true' }));
			append(guidedRetryBtnEl, $('span', {}, localize('adeMissionNodeGuidedRetryBtn', "指导重试")));
			guidedRetryBtnEl.hidden = true;

			const recallBtnEl = append(recoveryBarEl, $('button.ade-mission-recovery-btn.recall', {
				type: 'button',
				'data-ade-node-recall': node.id,
				title: localize('adeMissionNodeRecallBtnTip', "Recall active/stuck token on this node"),
			})) as HTMLButtonElement;
			append(recallBtnEl, $('span.codicon.codicon-discard', { 'aria-hidden': 'true' }));
			append(recallBtnEl, $('span', {}, localize('adeMissionNodeRecallBtn', "Recall")));
			recallBtnEl.hidden = true;

			let gateInlineActionsEl: HTMLElement | undefined;
			let gateApproveBtnEl: HTMLButtonElement | undefined;
			let gateApproveLabelEl: HTMLElement | undefined;
			let gateRejectBtnEl: HTMLButtonElement | undefined;
			let gateRejectLabelEl: HTMLElement | undefined;
			if (node.kind === 'gate') {
				gateInlineActionsEl = append(bottomDockEl, $('.ade-mission-gate-inline-bar', {
					'data-ade-gate-inline-actions': node.id,
				}));
				gateInlineActionsEl.hidden = true;
				gateApproveBtnEl = append(gateInlineActionsEl, $('button.ade-mission-gate-inline-btn.approve', {
					type: 'button',
					'data-ade-gate-card-approve': node.id,
					title: adeBi(localize('adeMissionGateCardApproveTip', "Approve waiting token on {0} immediately", node.id), '一键通过 {0} 当前待审批波次', node.id),
				})) as HTMLButtonElement;
				append(gateApproveBtnEl, $('span.codicon.codicon-check', { 'aria-hidden': 'true' }));
				gateApproveLabelEl = append(gateApproveBtnEl, $('span', {}, adeBi(localize('adeMissionGateCardApprove', "Approve"), '通过')));

				gateRejectBtnEl = append(gateInlineActionsEl, $('button.ade-mission-gate-inline-btn.reject', {
					type: 'button',
					'data-ade-gate-card-reject': node.id,
					title: adeBi(localize('adeMissionGateCardRejectTip', "Reject and choose an upstream rollback target node"), '驳回并指定上游打回目标节点'),
				})) as HTMLButtonElement;
				append(gateRejectBtnEl, $('span.codicon.codicon-discard', { 'aria-hidden': 'true' }));
				gateRejectLabelEl = append(gateRejectBtnEl, $('span', {}, adeBi(localize('adeMissionGateCardReject', "Reject…"), '打回…')));
			}

			const handle: IRenderedNodeHandle = {
				node,
				rootEl: nodeEl,
				idWrapEl: idWrap,
				titleEl,
				roleBadgeEl,
				checksBadgeEl,
				hostAlias: hostInfo?.hostAlias,
				displayHost: hostInfo?.displayHost,
				osKind: hostInfo?.osKind,
				osLabel: hostInfo?.osLabel,
				isRemoteHost: hostInfo?.isRemote,
				linkedAgent,
				engineId: handleEngineId,
				canSwitchEngine: handleCanSwitchEngine,
				canSwitchModel: handleCanSwitchModel,
				lastRoleKind: handleLastRoleKind,
				lastChecksCount: handleLastChecksCount,
				stateDotEl,
				nodeState,
				primaryToken: undefined,
				allTokens: [],
				boundSupervisorId: undefined,
				supBtnEl,
				supDotEl,
				supNameEl,
				coreIconTileEl,
				coreLlmGlyphEl,
				modelRowEl,
				modelNameEl,
				thinkingTagEl,
				engineBadgeEl,
				engineIconEl,
				engineNameEl,
				engineWarnDotEl,
				lastModel: handleLastModel,
				lastThinking: handleLastThinking,
				lastLlmProvider: handleLastLlmProvider,
				lastEngineBadgeKey: handleLastEngineBadgeKey,
				pacemakerPortEl,
				triggerBadgeEl,
				triggerBadgeLabelEl,
				tokenPuckEl,
				tokenPuckIconEl,
				tokenPuckLabelEl,
				tokenPuckExtraEl,
				joinCapsuleEl,
				joinDotsEl,
				joinCountEl,
				lastJoinSignature: '',
				bottomDockEl,
				blockedStripEl,
				blockedWaveEl,
				blockedCountdownEl,
				blockedPidEl,
				blockedFileEl,
				blockedHostEl,
				failedStripEl,
				failedWaveEl,
				failedReasonEl,
				recoveryBarEl,
				checkFailChipEl,
				retryBtnEl,
				guidedRetryBtnEl,
				recallBtnEl,
				gateMetaEl,
				gateInlineActionsEl,
				gateApproveBtnEl,
				gateApproveLabelEl,
				gateRejectBtnEl,
				gateRejectLabelEl,
				contextSummaryEl,
				promptBtnEl,
				promptPreviewEl,
				promptTagEl,
				ctxRowEl,
				ctxSegInitEl,
				ctxSegTierEl,
				ctxSegSourceEl,
				ctxSegNoiseEl,
				ctxTokensEl,
				ctxCostEl,
				ctxPctEl,
			};
			this.patchNodeRuntimeAccessories(
				handle,
				tokensByNode.get(node.id) ?? [],
				barriersByNode.get(node.id) ?? [],
				nodeTriggers,
				supervisorByNode.get(node.id),
				snapshot.resolveSupervisorDisplay,
				now,
				isMissionRunning,
			);
			if (gateApproveBtnEl) {
				const approveAnchor = gateApproveBtnEl;
				this.graphDisposables.add(addDisposableListener(approveAnchor, EventType.CLICK, e => {
					e.stopPropagation();
					const waitingTok = handle.allTokens
						.filter(t => t.status === 'waiting_gate')
						.sort((a, b) => a.arrivedAt - b.arrivedAt)[0];
					if (this.callbacks.onQuickGateApprove) {
						this.callbacks.onQuickGateApprove(node, waitingTok, approveAnchor);
					} else {
						this.callbacks.onOpenGateDecisionPopover(node, approveAnchor, waitingTok?.id);
					}
				}));
			}
			if (gateRejectBtnEl) {
				const rejectAnchor = gateRejectBtnEl;
				this.graphDisposables.add(addDisposableListener(rejectAnchor, EventType.CLICK, e => {
					e.stopPropagation();
					const waitingTok = handle.allTokens
						.filter(t => t.status === 'waiting_gate')
						.sort((a, b) => a.arrivedAt - b.arrivedAt)[0];
					this.callbacks.onOpenGateDecisionPopover(node, rejectAnchor, waitingTok?.id, { focusReject: true });
				}));
			}
			const isSelectedNode = this.selectedNodeIds.has(node.id);
			nodeEl.classList.toggle('is-selected', isSelectedNode);
			nodeEl.classList.toggle('is-multi-selected', isSelectedNode && this.selectedNodeIds.size > 1);
			if (isSelectedNode) {
				nodeEl.setAttribute('data-node-selected', 'true');
			}
			const isSearchMatch = Boolean(this.searchMatchNodeIds?.has(node.id));
			const isSearchActive = Boolean(this.activeSearchNodeId && this.activeSearchNodeId === node.id);
			nodeEl.classList.toggle('is-search-match', isSearchMatch);
			nodeEl.classList.toggle('is-search-active', isSearchActive);
			if (isSearchMatch) {
				nodeEl.setAttribute('data-search-match', 'true');
			}
			if (isSearchActive) {
				nodeEl.setAttribute('data-search-active', 'true');
			}
			const isRevAdded = Boolean(this.previewAddedNodeIds?.has(node.id));
			nodeEl.classList.toggle('is-revision-added', isRevAdded);
			if (isRevAdded) {
				nodeEl.setAttribute('data-revision-added', 'true');
			}

			this.graphDisposables.add(addDisposableListener(titleEl, EventType.DBLCLICK, e => {
				if (!this.callbacks.onRenameNode || this.callbacks.isRevisionPreview?.()) {
					return;
				}
				e.stopPropagation();
				this.startInlineNodeRename(node.id);
			}));
			this.graphDisposables.add(addDisposableListener(failedStripEl, EventType.CLICK, e => {
				e.stopPropagation();
				const failedTok = handle.allTokens.find(t => t.status === 'frozen_failed') ?? handle.primaryToken;
				if (failedTok) {
					this.callbacks.onOpenTokenInspectorPopover?.(node, failedTok, handle.allTokens, failedStripEl);
				}
			}));
			this.graphDisposables.add(addDisposableListener(guidedRetryBtnEl, EventType.CLICK, e => {
				e.stopPropagation();
				const failedTok = handle.allTokens.find(t => t.status === 'frozen_failed') ?? handle.primaryToken;
				if (failedTok) {
					this.callbacks.onOpenGuidedRetryPopover?.(node, failedTok, guidedRetryBtnEl);
				}
			}));
			if (coreIconTileEl) {
				this.graphDisposables.add(addDisposableListener(coreIconTileEl, EventType.CLICK, e => {
					if (!handle.canSwitchModel || !handle.linkedAgent) {
						return;
					}
					e.stopPropagation();
					this.callbacks.onOpenModelPopover(node.id, handle.linkedAgent, handle.engineId, coreIconTileEl!);
				}));
			}
			if (modelRowEl) {
				this.graphDisposables.add(addDisposableListener(modelRowEl, EventType.CLICK, e => {
					if (!handle.canSwitchModel || !handle.linkedAgent) {
						return;
					}
					e.stopPropagation();
					this.callbacks.onOpenModelPopover(node.id, handle.linkedAgent, handle.engineId, modelRowEl!);
				}));
			}
			if (engineBadgeEl) {
				this.graphDisposables.add(addDisposableListener(engineBadgeEl, EventType.CLICK, e => {
					if (!handle.canSwitchEngine || !handle.linkedAgent) {
						return;
					}
					e.stopPropagation();
					this.callbacks.onOpenEnginePopover(node.id, handle.linkedAgent, handle.engineId, engineBadgeEl!);
				}));
			}
			if (supBtnEl) {
				this.graphDisposables.add(addDisposableListener(supBtnEl, 'pointerenter', () => {
					if (handle.boundSupervisorId) {
						this.callbacks.onHoverSupervisor?.(handle.boundSupervisorId);
					}
				}));
				this.graphDisposables.add(addDisposableListener(supBtnEl, 'pointerleave', () => {
					this.callbacks.onHoverSupervisor?.(undefined);
				}));
			}
			this.graphDisposables.add(addDisposableListener(triggerBadgeEl, EventType.CLICK, e => {
				e.stopPropagation();
				this.callbacks.onOpenNodeTriggersPopover?.(node, triggerBadgeEl);
			}));
			this.graphDisposables.add(addDisposableListener(tokenPuckEl, EventType.CLICK, e => {
				e.stopPropagation();
				if (handle.primaryToken) {
					this.callbacks.onOpenTokenInspectorPopover?.(node, handle.primaryToken, handle.allTokens, tokenPuckEl);
				}
			}));
			this.graphDisposables.add(addDisposableListener(tokenPuckEl, 'pointerenter', () => {
				if (handle.primaryToken) {
					this.callbacks.onHoverToken?.(handle.primaryToken);
				}
			}));
			this.graphDisposables.add(addDisposableListener(tokenPuckEl, 'pointerleave', () => {
				this.callbacks.onHoverToken?.(undefined);
			}));
			this.graphDisposables.add(addDisposableListener(blockedStripEl, EventType.CLICK, e => {
				e.stopPropagation();
				if (handle.primaryToken) {
					this.callbacks.onOpenTokenInspectorPopover?.(node, handle.primaryToken, handle.allTokens, blockedStripEl);
				}
			}));
			this.graphDisposables.add(addDisposableListener(checkFailChipEl, EventType.CLICK, e => {
				e.stopPropagation();
				if (handle.primaryToken) {
					this.callbacks.onOpenTokenInspectorPopover?.(node, handle.primaryToken, handle.allTokens, checkFailChipEl);
				}
			}));
			this.graphDisposables.add(addDisposableListener(retryBtnEl, EventType.CLICK, e => {
				e.stopPropagation();
				const failedTok = handle.allTokens.find(t => t.status === 'frozen_failed') ?? handle.primaryToken;
				if (failedTok) {
					this.callbacks.onQuickRetryNode?.(node, failedTok);
				}
			}));
			this.graphDisposables.add(addDisposableListener(recallBtnEl, EventType.CLICK, e => {
				e.stopPropagation();
				this.callbacks.onQuickRecallNode?.(node, handle.primaryToken);
			}));

			this.nodeHandles.set(node.id, handle);
			this.bindNodeInteractions(handle);
		}

		this.updateEdgesSvg(snapshot.nodes, snapshot.edges, snapshot.positions, { direction: snapshot.direction ?? this.lastDirection });
		this.patchEdgeRuntimeStates(snapshot.runtimeState);
		this.renderCloudTerritories(snapshot.nodes, snapshot.positions);
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
			const sourceSize = getMissionNodeSize(node);
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
					const sz = getMissionNodeSize(candidateHandle.node);
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
				// Clean single-click keeps user on the Mission Canvas (opens Gate sign-off or in-canvas Node Command Inspector)
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
						dragSizeById.set(id, h ? getMissionNodeSize(h.node) : getMissionNodeSize(node));
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
						const osz = getMissionNodeSize(otherHandle.node);
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
			const size = getMissionNodeSize(node);
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
			return { edge, edgeKind, isCrossHost };
		});
		const nextEdgeStructureKey = `${direction}\x1e` + edgeDescriptors
			.map(d => `${d.edge.id}\x1f${d.edge.from}\x1f${d.edge.to}\x1f${d.edge.label ?? ''}\x1f${d.edgeKind}\x1f${d.isCrossHost ? '1' : '0'}`)
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
			const fromSize = getMissionNodeSize(fromNode);
			const toSize = getMissionNodeSize(toNode);
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
				cornerRadius: 14,
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
			const edgeKey = `${edge.from}->${edge.to}`;
			if (this.selectedEdgeKey && this.selectedEdgeKey === edgeKey) {
				edgeClasses.push('is-selected');
			}
			const group = svgEl('g', {
				class: edgeClasses.join(' '),
				'data-edge-id': edge.id,
				'data-edge-kind': edgeKind,
				'data-cross-host': String(isCrossHost),
				'data-from': edge.from,
				'data-to': edge.to,
				...(this.selectedEdgeKey && this.selectedEdgeKey === edgeKey ? { 'data-edge-selected': 'true' } : {}),
			});

			const hitPath = svgEl('path', {
				class: 'ade-mission-edge-hit',
				d: route.path,
			});
			group.appendChild(hitPath);

			const path = svgEl('path', {
				class: 'ade-mission-edge-path',
				d: route.path,
				'marker-end': this.selectedEdgeKey === edgeKey
					? 'url(#ade-mission-arrow-active)'
					: edgeKind === 'fail'
						? 'url(#ade-mission-arrow-fail)'
						: isCrossHost
							? 'url(#ade-mission-arrow-cloud)'
							: 'url(#ade-mission-arrow-default)',
			});
			group.appendChild(path);
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
}
