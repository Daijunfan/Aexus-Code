/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { $, addDisposableListener, append, clearNode, Dimension, EventHelper, EventType, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	AdeEngineeringEdgeVisualStatus,
	AdeThinkingLevel,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintEdge,
	IAdeEngineeringBlueprintNode,
	IAdeEngineeringEventLogEntry,
	IAdeEngineeringNodeRuntimeState,
	IAdeEngineeringService,
	IAdeEngineeringTreeSnapshot,
	IAdeTokenUsage,
	formatCompactTokenCount,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	AdeBlueprintValidationError,
	buildUpstreamReportChain,
	computeAutoLayoutPositions,
	computeEdgeVisualStatus,
	computeNodeVisualStatus,
	listUpstreamTaskAncestors,
	normalizeBlueprintEngine,
	normalizeThinkingLevel,
	partitionEngineeringManagers,
	serializeEngineeringBlueprint,
	toAdeEngineId,
	topologicalSortNodes,
} from '../../../../platform/ade/common/adeEngineeringBlueprint.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_ENGINEERING_SCHEME, IAdeProjectsService } from '../common/ade.js';
import { AdeRunningNodesAffectedError } from './adeEngineeringWorkbenchService.js';
import { IAdeSessionsService } from './adeSessionsService.js';

const ENGINE_OPTIONS: readonly { readonly value: string; readonly label: string; readonly shortLabel: string; readonly compact: string }[] = [
	{ value: 'claude-code', label: 'Claude Code', shortLabel: 'Claude Code', compact: 'claude' },
	{ value: 'codex', label: 'Codex', shortLabel: 'Codex', compact: 'codex' },
	{ value: 'antigravity', label: 'Google Antigravity', shortLabel: 'Antigravity', compact: 'agy' },
	{ value: 'kilo', label: 'Kilo Code', shortLabel: 'Kilo Code', compact: 'kilo' },
	{ value: 'opencode', label: 'OpenCode', shortLabel: 'OpenCode', compact: 'opencode' },
	{ value: 'dsh', label: 'DeepSeek Harness', shortLabel: 'DeepSeek', compact: 'dsh' },
	{ value: 'cline', label: 'Cline', shortLabel: 'Cline', compact: 'cline' },
	{ value: 'pi', label: 'Pi', shortLabel: 'Pi', compact: 'pi' },
];

const THINKING_OPTIONS: readonly { readonly value: AdeThinkingLevel; readonly label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'low', label: 'Low' },
	{ value: 'medium', label: 'Med' },
	{ value: 'high', label: 'High' },
	{ value: 'max', label: 'Max' },
];

const TASK_POD_WIDTH = 252;
const TASK_POD_HEIGHT = 156;
const GATE_NODE_WIDTH = 220;
const GATE_NODE_HEIGHT = 96;
const POPOVER_WIDTH = 304;
const MAX_UNDO_STACK = 40;
const MINIMAP_WIDTH = 164;
const MINIMAP_HEIGHT = 104;

type PopoverTabKind = 'worker' | 'employee' | 'manager' | 'task' | 'report';
type SheetTabKind = 'blueprint' | 'events';
type EventFilterKind = 'all' | 'worker' | 'employee' | 'manager' | 'gates';

function formatElapsedCompact(startedAt: number | undefined, now = Date.now()): string {
	if (!startedAt) {
		return '0s';
	}
	const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
	if (sec < 60) {
		return `${sec}s`;
	}
	const m = Math.floor(sec / 60);
	const rem = sec % 60;
	return `${m}m${rem > 0 ? `${rem}s` : ''}`;
}

function compactEngineTag(engine: string | undefined): string {
	const norm = normalizeBlueprintEngine(engine ?? 'claude-code');
	return ENGINE_OPTIONS.find(o => o.value === norm)?.compact ?? norm;
}

function compactModelShort(rawModel: string | undefined): string {
	if (!rawModel) {
		return '';
	}
	const stripped = rawModel
		.replace(/\[.*\]$/, '')
		.replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i, '$1-$2.$3')
		.replace(/^claude-/i, '')
		.replace(/^deepseek-/i, '');
	return stripped.length > 15 ? `${stripped.slice(0, 14)}…` : stripped;
}

function formatRoleConfigCompact(cfg: { readonly engine?: string; readonly model?: string; readonly thinking?: string } | undefined, fallbackThinking = 'high'): string {
	const eng = compactEngineTag(cfg?.engine);
	const shortModel = compactModelShort(cfg?.model);
	const think = cfg?.thinking ?? fallbackThinking;
	return shortModel ? `${eng} · ${shortModel} · ${think}` : `${eng} · ${think}`;
}

function cloneBlueprint(bp: IAdeEngineeringBlueprint): IAdeEngineeringBlueprint {
	return {
		metadata: { ...bp.metadata },
		managers: bp.managers.map(m => ({
			segmentId: m.segmentId,
			nodeIds: [...m.nodeIds],
			config: { ...m.config },
		})),
		nodes: bp.nodes.map(n => ({
			...n,
			employee: n.employee ? { ...n.employee } : undefined,
			worker: n.worker ? { ...n.worker } : undefined,
			position: n.position ? { ...n.position } : undefined,
		})),
		edges: bp.edges.map(e => ({ ...e })),
	};
}

export class AdeEngineeringEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeEngineering';
	override readonly resource: URI;

	constructor(
		readonly governorSessionId: string,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
	) {
		super();
		this.resource = URI.from({ scheme: ADE_ENGINEERING_SCHEME, path: `/${governorSessionId}` });
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return AdeEngineeringEditorInput.ID;
	}

	override getName(): string {
		const gov = this.projects.getAgent(this.governorSessionId);
		const base = gov?.label ?? localize('adeEngineeringFallbackGov', "Governor");
		return gov?.treeType === 'research'
			? localize('adeResearchTabTitle', "{0} · Research", base)
			: localize('adeEngineeringTabTitle', "{0} · Engineering", base);
	}

	override getIcon(): ThemeIcon {
		const gov = this.projects.getAgent(this.governorSessionId);
		return gov?.treeType === 'research' ? Codicon.beaker : Codicon.typeHierarchySub;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeEngineeringEditorInput && other.governorSessionId === this.governorSessionId;
	}
}

export class AdeEngineeringEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeEngineeringEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeEngineeringEditorInput ? input.governorSessionId : undefined;
	}

	deserialize(instantiationService: IInstantiationService, governorSessionId: string): EditorInput | undefined {
		if (!governorSessionId) {
			return undefined;
		}
		return instantiationService.createInstance(AdeEngineeringEditorInput, governorSessionId);
	}
}

export class AdeEngineeringEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeEngineering';
	private static nextInstanceUid = 1;
	private readonly instanceUid = AdeEngineeringEditorPane.nextInstanceUid++;

	private rootEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private segmentsLayerEl!: HTMLElement;
	private edgesSvgEl!: SVGSVGElement;
	private edgesDefsEl!: SVGDefsElement;
	private guidesGroupEl!: SVGGElement;
	private edgesGroupEl!: SVGGElement;
	private rubberBandPathEl!: SVGPathElement;
	private nodesLayerEl!: HTMLElement;
	private emptyStateEl!: HTMLElement;
	private connectHintEl!: HTMLElement;
	private minimapEl!: HTMLElement;
	private minimapSvgEl!: SVGSVGElement;
	private minimapLensEl!: HTMLElement;
	private tokenAnalyticsEl!: HTMLElement;
	private hudEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private popoverContentEl!: HTMLElement;
	private sheetEl!: HTMLElement;
	private sheetContentEl!: HTMLElement;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly toolbarRenderDisposables = this._register(new DisposableStore());
	private readonly hudRenderDisposables = this._register(new DisposableStore());
	private readonly canvasRenderDisposables = this._register(new DisposableStore());
	private readonly popoverRenderDisposables = this._register(new DisposableStore());
	private readonly sheetRenderDisposables = this._register(new DisposableStore());
	private readonly tokenAnalyticsDisposables = this._register(new DisposableStore());
	private readonly bannerDisposables = this._register(new DisposableStore());

	private activeGovernorId: string | undefined;
	private snapshot: IAdeEngineeringTreeSnapshot | undefined;
	private draftBlueprint: IAdeEngineeringBlueprint | undefined;
	private isDraftDirty = false;
	private undoStack: IAdeEngineeringBlueprint[] = [];
	private redoStack: IAdeEngineeringBlueprint[] = [];
	private lastCoalesceKey: string | undefined;
	private lastCoalesceTime = 0;

	private connectMode = false;
	private connectSourceNodeId: string | undefined;
	private spacePressed = false;
	private showMinimap = true;
	private showTokenAnalytics = false;
	private activeEventFilter: EventFilterKind = 'all';
	private pendingInitialFit = false;
	private liveTickTimer: number | undefined;
	private cameraAnimFrame: number | undefined;
	private livePhasePillRefs: { readonly pill: HTMLElement; readonly startedAt: number; readonly phaseLabel: string }[] = [];
	private popoverTokensCardEl: HTMLElement | undefined;
	private popoverTelemetryEl: HTMLElement | undefined;
	private undoBtnEl: HTMLButtonElement | undefined;
	private blueprintSheetBtnEl: HTMLElement | undefined;
	private eventsSheetBtnEl: HTMLElement | undefined;
	private sheetEventsBodyEl: HTMLElement | undefined;

	private panX = 48;
	private panY = 36;
	private zoom = 1;
	private lastDimension: Dimension | undefined;
	private minimapBounds = { minX: 0, minY: 0, width: 1000, height: 700 };

	private activePopoverNodeId: string | undefined;
	private activePopoverSegmentId: string | undefined;
	private activePopoverTab: PopoverTabKind = 'worker';
	private activeAnchorKind: 'worker' | 'employee' | 'manager' | 'gate' = 'worker';
	private activeSheetTab: SheetTabKind | undefined;
	private expandedDiffFiles = new Set<string>();
	private gateSubmitting = false;

	private nodeDomById = new Map<string, HTMLElement>();
	private nodeTitleDomById = new Map<string, HTMLElement>();
	private nodeAnchorsById = new Map<string, {
		readonly worker?: HTMLElement;
		readonly employee?: HTMLElement;
		readonly gate?: HTMLElement;
	}>();
	private segmentHaloDomById = new Map<string, HTMLElement>();
	private segmentHeaderDomById = new Map<string, HTMLElement>();
	private configuredModelsByEngine: Record<string, readonly { readonly id: string; readonly label: string }[]> = {};
	private nextDatalistId = 1;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAdeEngineeringService private readonly engineering: IAdeEngineeringService,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IAdeSessionsService private readonly sessions: IAdeSessionsService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AdeEngineeringEditorPane.ID, group, telemetryService, storageService ? themeService : themeService, storageService);
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.renderCanvas();
			if (this.activePopoverNodeId && !this.isFocusInsideEditableControl(this.popoverEl)) {
				this.renderPopover();
			}
		}));
		void this.refreshConfiguredModels();
	}

	private async refreshConfiguredModels(): Promise<void> {
		try {
			const fetched = await this.commandService.executeCommand<Record<string, readonly { readonly id: string; readonly label: string }[]>>(
				'aexus.agentEngines.listConfiguredModels',
			);
			if (fetched && typeof fetched === 'object') {
				this.configuredModelsByEngine = fetched;
				if (this.activePopoverNodeId && !this.isFocusInsideEditableControl(this.popoverEl)) {
					this.renderPopover();
				}
			}
		} catch {
			// Command may not be registered in standalone unit-test harnesses.
		}
	}

	override dispose(): void {
		this.stopLivePhaseTicker();
		this.cancelCameraAnimation();
		super.dispose();
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-eng-editor', { tabindex: 0 }));
		this.toolbarEl = append(this.rootEl, $('.ade-eng-toolbar'));
		this.bannerEl = append(this.rootEl, $('.ade-eng-banner', { role: 'status', 'aria-live': 'polite' }));
		this.bannerEl.hidden = true;

		this.bodyEl = append(this.rootEl, $('.ade-eng-body'));
		this.viewportEl = append(this.bodyEl, $('.ade-eng-viewport'));
		this.worldEl = append(this.viewportEl, $('.ade-eng-world'));
		this.segmentsLayerEl = append(this.worldEl, $('.ade-eng-segments-layer'));

		this.edgesSvgEl = this.worldEl.appendChild($.SVG<SVGSVGElement>('svg', {
			class: 'ade-eng-edges-svg',
			width: '4800',
			height: '3600',
			viewBox: '0 0 4800 3600',
		}));
		this.edgesDefsEl = this.edgesSvgEl.appendChild($.SVG<SVGDefsElement>('defs'));
		this.buildSvgMarkers();
		this.guidesGroupEl = this.edgesSvgEl.appendChild($.SVG<SVGGElement>('g', { class: 'ade-eng-guides-group' }));
		this.edgesGroupEl = this.edgesSvgEl.appendChild($.SVG<SVGGElement>('g', { class: 'ade-eng-edges-group' }));
		this.rubberBandPathEl = this.edgesSvgEl.appendChild($.SVG<SVGPathElement>('path', {
			class: 'ade-eng-edge-path rubber-band',
			d: '',
		}));
		this.rubberBandPathEl.style.display = 'none';

		this.nodesLayerEl = append(this.worldEl, $('.ade-eng-nodes-layer'));

		// Empty-state onboarding card & Connect-mode floating guide banner
		this.emptyStateEl = append(this.bodyEl, $('.ade-eng-empty-canvas'));
		this.emptyStateEl.hidden = true;
		this.connectHintEl = append(this.bodyEl, $('.ade-eng-connect-banner'));
		this.connectHintEl.hidden = true;

		// Interactive Bottom-Left Live Minimap
		this.minimapEl = append(this.bodyEl, $('.ade-eng-minimap', {
			title: localize('adeEngMinimapTooltip', "Live DAG Minimap — Click or drag to navigate"),
		}));
		const minimapHeader = append(this.minimapEl, $('.ade-eng-minimap-head'));
		append(minimapHeader, $('span.ade-eng-minimap-title', {}, localize('adeEngMinimapLabel', "DAG MAP")));
		this.minimapSvgEl = this.minimapEl.appendChild($.SVG<SVGSVGElement>('svg', {
			class: 'ade-eng-minimap-svg',
			viewBox: `0 0 ${MINIMAP_WIDTH} ${MINIMAP_HEIGHT}`,
			width: String(MINIMAP_WIDTH),
			height: String(MINIMAP_HEIGHT),
		}));
		this.minimapLensEl = append(this.minimapEl, $('.ade-eng-minimap-lens'));

		// Tree Token & 4-Tier Analytics Popover
		this.tokenAnalyticsEl = append(this.bodyEl, $('.ade-eng-token-analytics-card'));
		this.tokenAnalyticsEl.hidden = true;

		// Floating Bottom-Right Canvas Controls HUD
		this.hudEl = append(this.bodyEl, $('.ade-eng-canvas-hud'));

		// Anchored Floating Option Popover right adjacent to right-clicked / gear-clicked node (NEVER auto-popup on hover!)
		this.popoverEl = append(this.bodyEl, $('.ade-eng-popover', { 'aria-hidden': 'true', role: 'dialog' }));
		this.popoverEl.inert = true;
		this.popoverContentEl = append(this.popoverEl, $('.ade-eng-popover-inner'));

		// Floating Blueprint & Live Event Log Overlay Sheet
		this.sheetEl = append(this.bodyEl, $('.ade-eng-sheet', { 'aria-hidden': 'true', role: 'dialog' }));
		this.sheetEl.inert = true;
		this.sheetContentEl = append(this.sheetEl, $('.ade-eng-sheet-inner'));

		this.installViewportInteractions();
		this.installMinimapInteractions();
		this.installPopoverDismissal();
	}

	private markerId(status: string): string {
		return `ade-arrow-${status}-${this.instanceUid}`;
	}

	private buildSvgMarkers(): void {
		this.edgesDefsEl.replaceChildren();
		const createArrow = (status: string, colorVar: string) => {
			const marker = $.SVG<SVGMarkerElement>('marker', {
				id: this.markerId(status),
				viewBox: '0 0 10 10',
				refX: '8.5',
				refY: '5',
				markerWidth: '6.5',
				markerHeight: '6.5',
				orient: 'auto-start-reverse',
			});
			marker.appendChild($.SVG<SVGPathElement>('path', {
				d: 'M 0 1.5 L 9 5 L 0 8.5 z',
				fill: colorVar,
			}));
			this.edgesDefsEl.appendChild(marker);
		};
		createArrow('pending', 'var(--ade-eng-edge-pending, #6e7681)');
		createArrow('running', 'var(--ade-eng-green, #3fb950)');
		createArrow('completed', 'var(--ade-eng-green, #2ea043)');
		createArrow('blocked', 'var(--ade-eng-edge-blocked, #6e7681)');
	}

	private cancelCameraAnimation(): void {
		if (this.cameraAnimFrame !== undefined && this.rootEl) {
			getWindow(this.rootEl).cancelAnimationFrame(this.cameraAnimFrame);
			this.cameraAnimFrame = undefined;
		}
	}

	private animateViewportTo(targetPanX: number, targetPanY: number, targetZoom: number, animate: boolean): void {
		this.cancelCameraAnimation();
		if (!animate || !this.rootEl) {
			this.panX = targetPanX;
			this.panY = targetPanY;
			this.zoom = targetZoom;
			this.applyWorldTransform();
			this.renderHud();
			return;
		}
		const win = getWindow(this.rootEl);
		const startPanX = this.panX;
		const startPanY = this.panY;
		const startZoom = this.zoom;
		const startTime = win.performance.now();
		const duration = 210;

		const step = (now: number) => {
			const t = Math.min(1, (now - startTime) / duration);
			const ease = 1 - Math.pow(1 - t, 3);
			this.panX = startPanX + (targetPanX - startPanX) * ease;
			this.panY = startPanY + (targetPanY - startPanY) * ease;
			this.zoom = Math.round((startZoom + (targetZoom - startZoom) * ease) * 100) / 100;
			this.applyWorldTransform();
			if (t < 1) {
				this.cameraAnimFrame = win.requestAnimationFrame(step);
			} else {
				this.cameraAnimFrame = undefined;
				this.panX = targetPanX;
				this.panY = targetPanY;
				this.zoom = targetZoom;
				this.applyWorldTransform();
				this.renderHud();
			}
		};
		this.cameraAnimFrame = win.requestAnimationFrame(step);
	}

	private zoomAroundViewportCenter(delta: number): void {
		const vw = this.viewportEl.clientWidth || (this.lastDimension?.width ?? 960);
		const vh = this.viewportEl.clientHeight || ((this.lastDimension?.height ?? 640) - 44);
		const centerX = vw / 2;
		const centerY = vh / 2;
		const worldX = (centerX - this.panX) / this.zoom;
		const worldY = (centerY - this.panY) / this.zoom;
		const nextZoom = Math.min(2.1, Math.max(0.35, Math.round((this.zoom + delta) * 100) / 100));
		if (nextZoom === this.zoom) {
			return;
		}
		this.cancelCameraAnimation();
		this.zoom = nextZoom;
		this.panX = Math.round(centerX - worldX * this.zoom);
		this.panY = Math.round(centerY - worldY * this.zoom);
		this.applyWorldTransform();
		this.renderHud();
	}

	private installViewportInteractions(): void {
		let panning = false;
		let startClientX = 0;
		let startClientY = 0;
		let startPanX = 0;
		let startPanY = 0;

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (!this.spacePressed && target && (
				target.closest('.ade-eng-node')
				|| target.closest('.ade-eng-edge-hit')
				|| target.closest('.ade-eng-segment-header')
			)) {
				return;
			}
			if (e.button !== 0 && e.button !== 1) {
				return;
			}
			this.cancelCameraAnimation();
			if (this.connectSourceNodeId) {
				this.connectSourceNodeId = undefined;
				this.rubberBandPathEl.style.display = 'none';
				this.renderCanvas();
			}
			this.closePopover();
			this.closeTokenAnalytics();
			panning = true;
			startClientX = e.clientX;
			startClientY = e.clientY;
			startPanX = this.panX;
			startPanY = this.panY;
			this.viewportEl.classList.add('panning');
			try {
				this.viewportEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic test events */ }
		}));

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!panning) {
				return;
			}
			this.panX = startPanX + (e.clientX - startClientX);
			this.panY = startPanY + (e.clientY - startClientY);
			this.applyWorldTransform();
		}));

		const stopPan = (e: PointerEvent) => {
			if (!panning) {
				return;
			}
			panning = false;
			this.viewportEl.classList.remove('panning');
			try {
				this.viewportEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
		};
		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_UP, stopPan));
		this._register(addDisposableListener(this.viewportEl, 'pointercancel', stopPan));

		this._register(addDisposableListener(this.viewportEl, EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			this.cancelCameraAnimation();
			if (e.ctrlKey || e.metaKey) {
				const rect = this.viewportEl.getBoundingClientRect();
				const cursorX = e.clientX - rect.left;
				const cursorY = e.clientY - rect.top;
				const worldX = (cursorX - this.panX) / this.zoom;
				const worldY = (cursorY - this.panY) / this.zoom;
				const factor = e.deltaY < 0 ? 1.08 : 0.92;
				const nextZoom = Math.min(2.1, Math.max(0.35, this.zoom * factor));
				this.zoom = Math.round(nextZoom * 100) / 100;
				this.panX = cursorX - worldX * this.zoom;
				this.panY = cursorY - worldY * this.zoom;
				this.applyWorldTransform();
				this.renderHud();
			} else {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.applyWorldTransform();
			}
		}, { passive: false }));
	}

	private installMinimapInteractions(): void {
		let draggingMap = false;
		const panFromMinimapEvent = (e: PointerEvent) => {
			const rect = this.minimapSvgEl.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				return;
			}
			const rx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			const ry = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
			const worldTargetX = this.minimapBounds.minX + rx * this.minimapBounds.width;
			const worldTargetY = this.minimapBounds.minY + ry * this.minimapBounds.height;
			const vw = this.viewportEl.clientWidth || (this.lastDimension?.width ?? 960);
			const vh = this.viewportEl.clientHeight || ((this.lastDimension?.height ?? 640) - 44);
			this.cancelCameraAnimation();
			this.panX = Math.round(vw / 2 - worldTargetX * this.zoom);
			this.panY = Math.round(vh / 2 - worldTargetY * this.zoom);
			this.applyWorldTransform();
		};

		this._register(addDisposableListener(this.minimapEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			EventHelper.stop(e, true);
			draggingMap = true;
			try {
				this.minimapEl.setPointerCapture(e.pointerId);
			} catch { /* ignore */ }
			panFromMinimapEvent(e);
		}));
		this._register(addDisposableListener(this.minimapEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (draggingMap) {
				panFromMinimapEvent(e);
			}
		}));
		const stopMapDrag = (e: PointerEvent) => {
			if (!draggingMap) {
				return;
			}
			draggingMap = false;
			try {
				this.minimapEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
		};
		this._register(addDisposableListener(this.minimapEl, EventType.POINTER_UP, stopMapDrag));
		this._register(addDisposableListener(this.minimapEl, 'pointercancel', stopMapDrag));
	}

	private isFocusInsideEditableControl(container: HTMLElement): boolean {
		const active = getWindow(this.rootEl).document.activeElement;
		return Boolean(active && container.contains(active) && (
			active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT'
		));
	}

	private installPopoverDismissal(): void {
		this._register(addDisposableListener(this.rootEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (this.activePopoverNodeId && !target?.closest('.ade-eng-popover') && !target?.closest('.ade-eng-node-cfg-btn') && !target?.closest('.ade-eng-seg-cfg-ico')) {
				this.closePopover();
			}
			if (this.showTokenAnalytics && !target?.closest('.ade-eng-token-analytics-card') && !target?.closest('.ade-eng-tokens-pill')) {
				this.closeTokenAnalytics();
			}
			if (this.activeSheetTab && !target?.closest('.ade-eng-sheet') && !target?.closest('.ade-eng-sheet-toggle') && !target?.closest('.ade-eng-tokens-pill') && !target?.closest('.ade-eng-token-analytics-card')) {
				this.closeSheet();
			}
		}, true));

		this._register(addDisposableListener(this.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-eng-node, .ade-eng-segment-header, .ade-eng-popover, .ade-eng-edge-item')) {
				return;
			}
			EventHelper.stop(e, true);
			this.closePopover();
		}));

		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const targetEl = e.target as HTMLElement | null;
			const inInput = Boolean(targetEl && (targetEl.tagName === 'INPUT' || targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'SELECT' || targetEl.isContentEditable));

			if (e.code === 'Space' && !inInput) {
				this.spacePressed = true;
				this.viewportEl.classList.add('space-pan');
			}

			if (e.key === 'Escape') {
				if (this.connectMode || this.connectSourceNodeId) {
					EventHelper.stop(e, true);
					this.connectMode = false;
					this.connectSourceNodeId = undefined;
					this.rubberBandPathEl.style.display = 'none';
					this.renderToolbar();
					this.renderCanvas();
					return;
				}
				if (this.showTokenAnalytics) {
					EventHelper.stop(e, true);
					this.closeTokenAnalytics();
					return;
				}
				if (this.activeSheetTab) {
					EventHelper.stop(e, true);
					this.closeSheet();
					return;
				}
				if (this.activePopoverNodeId) {
					EventHelper.stop(e, true);
					this.closePopover();
					return;
				}
			}

			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
				if (this.isDraftDirty) {
					EventHelper.stop(e, true);
					void this.confirmDraftChanges();
				}
				return;
			}

			if (!inInput && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
				EventHelper.stop(e, true);
				if (e.shiftKey) {
					this.redoDraft();
				} else {
					this.undoDraft();
				}
				return;
			}

			if (!inInput && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'y') {
				EventHelper.stop(e, true);
				this.redoDraft();
				return;
			}

			if (inInput) {
				return;
			}

			if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
				if (this.activePopoverNodeId && !this.isNodeCompletedLocked(this.activePopoverNodeId)) {
					EventHelper.stop(e, true);
					this.deleteDraftNode(this.activePopoverNodeId);
				}
				return;
			}

			if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === '0' || e.key.toLowerCase() === 'f')) {
				EventHelper.stop(e, true);
				this.fitViewportToGraph(true);
				return;
			}

			if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'l') {
				EventHelper.stop(e, true);
				this.runAutoLayoutDraft();
			}
		}));

		this._register(addDisposableListener(this.rootEl, EventType.KEY_UP, (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				this.spacePressed = false;
				this.viewportEl.classList.remove('space-pan');
			}
		}));
	}

	private pushUndoSnapshot(coalesceKey?: string): void {
		if (!this.draftBlueprint) {
			return;
		}
		const now = Date.now();
		if (coalesceKey && this.lastCoalesceKey === coalesceKey && now - this.lastCoalesceTime < 1400) {
			this.lastCoalesceTime = now;
			return;
		}
		this.lastCoalesceKey = coalesceKey;
		this.lastCoalesceTime = now;
		this.undoStack.push(cloneBlueprint(this.draftBlueprint));
		if (this.undoStack.length > MAX_UNDO_STACK) {
			this.undoStack.shift();
		}
		this.redoStack.length = 0;
	}

	private undoDraft(): void {
		if (this.undoStack.length === 0 || !this.draftBlueprint) {
			return;
		}
		const prev = this.undoStack.pop()!;
		this.redoStack.push(cloneBlueprint(this.draftBlueprint));
		this.lastCoalesceKey = undefined;
		this.draftBlueprint = prev;
		this.isDraftDirty = this.undoStack.length > 0 || this.hasBlueprintDiffFromSnapshot(prev);
		if (!this.isDraftDirty) {
			this.hideBanner();
		}
		this.renderToolbar();
		this.renderCanvas();
		if (this.activePopoverNodeId) {
			if (this.draftBlueprint.nodes.some(n => n.id === this.activePopoverNodeId)) {
				this.renderPopover();
			} else {
				this.closePopover();
			}
		}
	}

	private redoDraft(): void {
		if (this.redoStack.length === 0 || !this.draftBlueprint) {
			return;
		}
		const next = this.redoStack.pop()!;
		this.undoStack.push(cloneBlueprint(this.draftBlueprint));
		this.lastCoalesceKey = undefined;
		this.draftBlueprint = next;
		this.isDraftDirty = true;
		this.renderToolbar();
		this.renderCanvas();
		if (this.activePopoverNodeId && this.draftBlueprint.nodes.some(n => n.id === this.activePopoverNodeId)) {
			this.renderPopover();
		}
	}

	private hasBlueprintDiffFromSnapshot(candidate: IAdeEngineeringBlueprint): boolean {
		if (!this.snapshot) {
			return false;
		}
		return serializeEngineeringBlueprint(candidate) !== serializeEngineeringBlueprint(this.snapshot.blueprint);
	}

	private toggleTokenAnalytics(): void {
		if (this.showTokenAnalytics) {
			this.closeTokenAnalytics();
			return;
		}
		this.showTokenAnalytics = true;
		this.renderTokenAnalytics();
		this.tokenAnalyticsEl.hidden = false;
	}

	private closeTokenAnalytics(): void {
		if (!this.showTokenAnalytics) {
			return;
		}
		this.showTokenAnalytics = false;
		this.tokenAnalyticsEl.hidden = true;
		this.tokenAnalyticsDisposables.clear();
	}

	private renderTokenAnalytics(): void {
		this.tokenAnalyticsDisposables.clear();
		clearNode(this.tokenAnalyticsEl);
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const tu = snap.tokenUsage;
		const total = Math.max(1, tu.total.totalTokens);

		const head = append(this.tokenAnalyticsEl, $('.ade-eng-ta-head'));
		append(head, $('span.ade-eng-ta-title', {}, localize('adeEngTokenAnalyticsTitle', "4-Tier Token & Telemetry Breakdown")));
		const closeBtn = append(head, $('button.ade-eng-pop-icon-btn.close', { type: 'button', title: localize('adeEngClosePopoverTooltip', "Close (Esc)") }));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.tokenAnalyticsDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeTokenAnalytics()));

		const kpiGrid = append(this.tokenAnalyticsEl, $('.ade-eng-ta-kpis'));
		const addKpi = (label: string, val: string) => {
			const cell = append(kpiGrid, $('.ade-eng-ta-kpi'));
			append(cell, $('span.ade-eng-ta-kpi-label', {}, label));
			append(cell, $('span.ade-eng-ta-kpi-val', {}, val));
		};
		addKpi(localize('adeEngTaTotal', "Total"), `${tu.total.totalTokens.toLocaleString()} tok`);
		addKpi(localize('adeEngTaTurns', "Turns"), String(tu.total.turns));
		addKpi(localize('adeEngTaInput', "Input"), formatCompactTokenCount(tu.total.inputTokens));
		addKpi(localize('adeEngTaOutput', "Output"), formatCompactTokenCount(tu.total.outputTokens));
		addKpi(localize('adeEngTaCacheRead', "Cache Read"), formatCompactTokenCount(tu.total.cacheReadTokens));
		addKpi(localize('adeEngTaCacheWrite', "Cache Write"), formatCompactTokenCount(tu.total.cacheWriteTokens));

		const rolesWrap = append(this.tokenAnalyticsEl, $('.ade-eng-ta-roles'));
		const tiers: { readonly label: string; readonly usage: IAdeTokenUsage; readonly cls: string }[] = [
			{ label: localize('adeEngTierWrk', "Worker · L4 (Executor)"), usage: tu.worker, cls: 'wrk' },
			{ label: localize('adeEngTierEmp', "Employee · L3 (Reviewer)"), usage: tu.employee, cls: 'emp' },
			{ label: localize('adeEngTierMgr', "Manager · L2 (Segment)"), usage: tu.manager, cls: 'mgr' },
			{ label: localize('adeEngTierGov', "Governor · L1 (Architect)"), usage: tu.governor, cls: 'gov' },
		];
		for (const tier of tiers) {
			const pct = tu.total.totalTokens > 0 ? Math.round((tier.usage.totalTokens / total) * 100) : 0;
			const row = append(rolesWrap, $('.ade-eng-ta-role-row'));
			const top = append(row, $('.ade-eng-ta-role-top'));
			append(top, $(`span.ade-eng-ta-role-name.${tier.cls}`, {}, tier.label));
			append(top, $('span.ade-eng-ta-role-val', {}, `${tier.usage.totalTokens.toLocaleString()} (${pct}%)`));
			const track = append(row, $('.ade-eng-ta-bar-track'));
			const fill = append(track, $(`div.ade-eng-ta-bar-fill.${tier.cls}`));
			fill.style.width = `${Math.max(tier.usage.totalTokens > 0 ? 4 : 0, pct)}%`;
		}
	}

	private openPopoverForTarget(params: {
		readonly nodeId: string;
		readonly anchorKind: 'worker' | 'employee' | 'manager' | 'gate';
		readonly tab?: PopoverTabKind;
		readonly segmentId?: string;
	}): void {
		if (this.activeSheetTab) {
			this.closeSheet();
		}
		this.closeTokenAnalytics();
		const targetTab: PopoverTabKind = params.tab ?? (params.anchorKind === 'gate' ? 'task' : params.anchorKind);
		const sameState = this.activePopoverNodeId === params.nodeId
			&& this.activeAnchorKind === params.anchorKind
			&& this.activePopoverTab === targetTab
			&& this.activePopoverSegmentId === params.segmentId
			&& this.popoverEl.classList.contains('open');

		this.activePopoverNodeId = params.nodeId;
		this.activeAnchorKind = params.anchorKind;
		this.activePopoverTab = targetTab;
		this.activePopoverSegmentId = params.segmentId;
		this.popoverEl.inert = false;
		this.popoverEl.removeAttribute('aria-hidden');
		this.popoverEl.classList.add('open');

		for (const [id, el] of this.nodeDomById) {
			el.classList.toggle('inspected', id === params.nodeId);
		}
		if (!sameState) {
			this.renderPopover();
		} else {
			this.positionPopoverNearAnchor();
		}
	}

	private closePopover(): void {
		this.activePopoverNodeId = undefined;
		this.activePopoverSegmentId = undefined;
		this.popoverEl.classList.remove('open', 'flipped-left', 'placed-below', 'placed-above');
		this.popoverEl.inert = true;
		this.popoverEl.setAttribute('aria-hidden', 'true');
		this.popoverEl.style.maxHeight = '';
		for (const el of this.nodeDomById.values()) {
			el.classList.remove('inspected');
		}
	}

	private syncSheetToggleActiveState(): void {
		this.blueprintSheetBtnEl?.classList.toggle('active', this.activeSheetTab === 'blueprint');
		this.eventsSheetBtnEl?.classList.toggle('active', this.activeSheetTab === 'events');
	}

	private toggleSheet(tab: SheetTabKind): void {
		if (this.activeSheetTab === tab && this.sheetEl.classList.contains('open')) {
			this.closeSheet();
			return;
		}
		if (this.activePopoverNodeId) {
			this.closePopover();
		}
		this.activeSheetTab = tab;
		this.sheetEl.inert = false;
		this.sheetEl.removeAttribute('aria-hidden');
		this.sheetEl.classList.add('open');
		this.syncSheetToggleActiveState();
		this.renderSheet();
	}

	private closeSheet(): void {
		if (!this.activeSheetTab && !this.sheetEl?.classList.contains('open')) {
			return;
		}
		this.activeSheetTab = undefined;
		this.sheetEl.classList.remove('open');
		this.sheetEl.inert = true;
		this.sheetEl.setAttribute('aria-hidden', 'true');
		this.syncSheetToggleActiveState();
	}

	private resolveAnchorViewportRect(): { left: number; right: number; top: number; bottom: number; centerY: number } | undefined {
		if (!this.activePopoverNodeId) {
			return undefined;
		}
		const bodyRect = this.bodyEl.getBoundingClientRect();
		let anchorDom: HTMLElement | null | undefined;

		if (this.activeAnchorKind === 'manager' && this.activePopoverSegmentId) {
			anchorDom = this.segmentHeaderDomById.get(this.activePopoverSegmentId);
		}
		if (!anchorDom) {
			const anchors = this.nodeAnchorsById.get(this.activePopoverNodeId);
			if (anchors) {
				if (this.activeAnchorKind === 'employee') {
					anchorDom = anchors.employee ?? anchors.worker;
				} else if (this.activeAnchorKind === 'gate') {
					anchorDom = anchors.gate;
				} else {
					anchorDom = anchors.worker;
				}
			}
		}

		if (anchorDom) {
			const r = anchorDom.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				const left = r.left - bodyRect.left;
				const right = r.right - bodyRect.left;
				const top = r.top - bodyRect.top;
				const bottom = r.bottom - bodyRect.top;
				return { left, right, top, bottom, centerY: (top + bottom) / 2 };
			}
		}

		const node = this.draftBlueprint?.nodes.find(n => n.id === this.activePopoverNodeId);
		if (!node) {
			return undefined;
		}
		const cx = (node.position?.x ?? 196) * this.zoom + this.panX;
		const cy = (node.position?.y ?? 256) * this.zoom + this.panY;
		const halfW = ((node.type === 'user_gate' ? GATE_NODE_WIDTH : TASK_POD_WIDTH) / 2) * this.zoom;
		const halfH = ((node.type === 'user_gate' ? GATE_NODE_HEIGHT : TASK_POD_HEIGHT) / 2) * this.zoom;
		return {
			left: cx - halfW,
			right: cx + halfW,
			top: cy - halfH,
			bottom: cy + halfH,
			centerY: cy,
		};
	}

	private positionPopoverNearAnchor(): void {
		if (!this.activePopoverNodeId || !this.popoverEl.classList.contains('open')) {
			return;
		}
		const anchor = this.resolveAnchorViewportRect();
		if (!anchor) {
			return;
		}
		const bodyW = this.bodyEl.clientWidth || (this.lastDimension?.width ?? 960);
		const bodyH = Math.max(160, this.bodyEl.clientHeight || ((this.lastDimension?.height ?? 640) - 44));
		this.popoverEl.style.maxHeight = `${Math.max(140, bodyH - 20)}px`;
		const popW = Math.min(bodyW - 20, this.popoverEl.offsetWidth || POPOVER_WIDTH);
		const popH = Math.min(bodyH - 20, this.popoverEl.offsetHeight || 290);
		const gap = 12;

		let left = anchor.right + gap;
		let top = Math.max(10, Math.min(bodyH - popH - 10, anchor.centerY - Math.min(110, popH * 0.36)));
		let flippedLeft = false;
		let placedBelow = false;
		let placedAbove = false;

		if (anchor.right + gap + popW <= bodyW - 10) {
			left = anchor.right + gap;
		} else if (anchor.left - gap - popW >= 10) {
			left = anchor.left - gap - popW;
			flippedLeft = true;
		} else {
			const anchorCenterX = (anchor.left + anchor.right) / 2;
			left = Math.max(10, Math.min(bodyW - popW - 10, anchorCenterX - popW / 2));
			const spaceBelow = bodyH - anchor.bottom - gap - 10;
			const spaceAbove = anchor.top - gap - 10;
			if (spaceBelow >= Math.min(popH, 220) || spaceBelow >= spaceAbove) {
				placedBelow = true;
				top = Math.max(10, Math.min(bodyH - 130, anchor.bottom + gap));
				this.popoverEl.style.maxHeight = `${Math.max(120, bodyH - top - 10)}px`;
			} else {
				placedAbove = true;
				const maxAboveH = Math.max(120, Math.min(bodyH - 20, anchor.top - gap - 10));
				this.popoverEl.style.maxHeight = `${maxAboveH}px`;
				const clampedH = Math.min(popH, maxAboveH);
				top = Math.max(10, anchor.top - gap - clampedH);
			}
		}

		this.popoverEl.classList.toggle('flipped-left', flippedLeft);
		this.popoverEl.classList.toggle('placed-below', placedBelow);
		this.popoverEl.classList.toggle('placed-above', placedAbove);
		this.popoverEl.style.left = `${Math.round(left)}px`;
		this.popoverEl.style.top = `${Math.round(top)}px`;
	}

	override async setInput(input: AdeEngineeringEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();
		const switchingGovernor = this.activeGovernorId !== input.governorSessionId;
		this.activeGovernorId = input.governorSessionId;
		this.isDraftDirty = false;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.lastCoalesceKey = undefined;
		this.connectMode = false;
		this.connectSourceNodeId = undefined;
		this.hideBanner();
		this.closePopover();
		this.closeTokenAnalytics();
		this.closeSheet();
		if (switchingGovernor) {
			this.pendingInitialFit = true;
		}
		void this.refreshConfiguredModels();

		await this.engineering.whenReady();
		if (token.isCancellationRequested) {
			return;
		}
		const govAgent = this.projects.getAgent(input.governorSessionId);
		if (!this.engineering.hasTree(input.governorSessionId) && govAgent) {
			await this.engineering.initTree({
				governorSessionId: input.governorSessionId,
				treeType: govAgent.treeType === 'research' ? 'research' : 'engineering',
			}).catch(err => {
				this.showBanner(err instanceof Error ? err.message : String(err), 'error');
			});
		}

		this.reloadFromService(true);

		this.inputDisposables.add(this.engineering.onDidChangeTree(changedGovId => {
			if (!changedGovId || changedGovId === this.activeGovernorId) {
				this.reloadFromService(false);
			}
		}));
		this.inputDisposables.add(this.projects.onDidChange(() => {
			this.renderToolbar();
		}));
	}

	override clearInput(): void {
		this.stopLivePhaseTicker();
		this.cancelCameraAnimation();
		this.inputDisposables.clear();
		this.toolbarRenderDisposables.clear();
		this.hudRenderDisposables.clear();
		this.canvasRenderDisposables.clear();
		this.popoverRenderDisposables.clear();
		this.sheetRenderDisposables.clear();
		this.tokenAnalyticsDisposables.clear();
		this.activeGovernorId = undefined;
		this.snapshot = undefined;
		this.draftBlueprint = undefined;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.pendingInitialFit = false;
		this.hideBanner();
		this.closePopover();
		this.closeTokenAnalytics();
		this.closeSheet();
		super.clearInput();
	}

	private stopLivePhaseTicker(): void {
		if (this.liveTickTimer !== undefined) {
			getWindow(this.rootEl).clearInterval(this.liveTickTimer);
			this.liveTickTimer = undefined;
		}
	}

	private syncLivePhaseTicker(): void {
		const isRunning = this.snapshot?.state.runStatus === 'running';
		if (isRunning && this.liveTickTimer === undefined && this.rootEl) {
			const win = getWindow(this.rootEl);
			this.liveTickTimer = win.setInterval(() => {
				if (this.snapshot?.state.runStatus !== 'running') {
					this.stopLivePhaseTicker();
					return;
				}
				const now = Date.now();
				for (const item of this.livePhasePillRefs) {
					item.pill.textContent = `${item.phaseLabel} · ${formatElapsedCompact(item.startedAt, now)}`;
				}
			}, 1000);
		} else if (!isRunning && this.liveTickTimer !== undefined) {
			this.stopLivePhaseTicker();
		}
	}

	private reloadFromService(resetDraft: boolean): void {
		if (!this.activeGovernorId) {
			return;
		}
		const snap = this.engineering.getTreeSnapshot(this.activeGovernorId);
		this.snapshot = snap;
		this.syncLivePhaseTicker();
		if (snap && (resetDraft || !this.isDraftDirty || !this.draftBlueprint)) {
			const cloned = cloneBlueprint(snap.blueprint);
			const autoPos = computeAutoLayoutPositions(cloned);
			this.draftBlueprint = {
				...cloned,
				nodes: cloned.nodes.map(n => n.position ? n : { ...n, position: autoPos.get(n.id) ?? { x: 196, y: 256 } }),
			};
			if (resetDraft) {
				this.isDraftDirty = false;
				this.undoStack.length = 0;
				this.redoStack.length = 0;
				this.lastCoalesceKey = undefined;
			}
		}
		this.renderToolbar();
		this.renderCanvas();
		this.renderHud();
		if (this.showTokenAnalytics) {
			this.renderTokenAnalytics();
		}
		if (this.pendingInitialFit && this.lastDimension && this.lastDimension.width > 0 && this.draftBlueprint && this.draftBlueprint.nodes.length > 0) {
			this.pendingInitialFit = false;
			this.fitViewportToGraph(false);
		}
		if (this.activePopoverNodeId) {
			if (this.draftBlueprint?.nodes.some(n => n.id === this.activePopoverNodeId)) {
				if (this.isFocusInsideEditableControl(this.popoverEl)) {
					this.refreshOpenPopoverTelemetryInPlace();
				} else {
					this.renderPopover();
				}
			} else {
				this.closePopover();
			}
		}
		if (this.activeSheetTab === 'events' && this.sheetEl.classList.contains('open')) {
			const prevScroll = this.sheetEventsBodyEl?.scrollTop ?? 0;
			this.renderSheet();
			if (this.sheetEventsBodyEl) {
				this.sheetEventsBodyEl.scrollTop = prevScroll;
			}
		}
	}

	private refreshOpenPopoverTelemetryInPlace(): void {
		if (!this.activePopoverNodeId || !this.snapshot) {
			return;
		}
		const runtime = this.snapshot.state.nodes[this.activePopoverNodeId];
		if (!runtime) {
			return;
		}
		const existingCard = this.popoverTokensCardEl;
		if (existingCard && existingCard.parentElement) {
			const tmp = $('div');
			this.renderNodeTokenUsageCard(tmp, runtime);
			const freshCard = tmp.firstElementChild as HTMLElement | null;
			if (freshCard) {
				existingCard.replaceWith(freshCard);
				this.popoverTokensCardEl = freshCard;
			}
		}
		if (this.popoverTelemetryEl) {
			this.popoverTelemetryEl.textContent = `Phase: ${runtime.phase} · Rework ${runtime.employeeRejectCount}/3 · Fail ${runtime.formalFailureCount}/3`;
		}
	}

	private markDraftModified(
		nextBp: IAdeEngineeringBlueprint,
		options?: { readonly skipPopoverRebuild?: boolean; readonly skipCanvasRebuild?: boolean; readonly coalesceKey?: string; readonly skipUndoPush?: boolean },
	): void {
		if (!options?.skipUndoPush) {
			this.pushUndoSnapshot(options?.coalesceKey);
		}
		let recomputedManagers = nextBp.managers;
		try {
			recomputedManagers = partitionEngineeringManagers(
				nextBp.nodes,
				nextBp.edges,
				nextBp.managers,
				nextBp.nodes.find(n => n.worker)?.worker?.engine ?? 'claude-code',
			);
			this.hideBanner();
		} catch (err) {
			if (err instanceof AdeBlueprintValidationError) {
				this.showBanner(err.message, 'error');
			}
		}
		this.draftBlueprint = {
			...nextBp,
			managers: recomputedManagers,
		};
		this.isDraftDirty = true;
		this.renderToolbar();
		if (!options?.skipCanvasRebuild) {
			this.renderCanvas();
		}
		if (this.activePopoverNodeId && !options?.skipPopoverRebuild) {
			const nextSeg = recomputedManagers.find(m => m.nodeIds.includes(this.activePopoverNodeId!));
			if (this.activeAnchorKind === 'manager' && nextSeg) {
				this.activePopoverSegmentId = nextSeg.segmentId;
			}
			this.renderPopover();
		}
	}

	private applyRolePresetToAllUnlocked(preset: { readonly engine: string; readonly model?: string; readonly thinking: AdeThinkingLevel }): void {
		if (!this.draftBlueprint) {
			return;
		}
		const nextNodes = this.draftBlueprint.nodes.map(n => {
			if (n.type !== 'task' || this.isNodeCompletedLocked(n.id)) {
				return n;
			}
			const cleanCfg = {
				engine: preset.engine,
				...(preset.model ? { model: preset.model } : {}),
				thinking: preset.thinking,
			};
			return {
				...n,
				worker: { ...cleanCfg },
				employee: { ...cleanCfg },
			};
		});
		const nextManagers = this.draftBlueprint.managers.map(m => {
			const allLocked = m.nodeIds.every(id => this.isNodeCompletedLocked(id));
			if (allLocked) {
				return m;
			}
			return {
				...m,
				config: {
					engine: preset.engine,
					...(preset.model ? { model: preset.model } : {}),
					thinking: preset.thinking,
				},
			};
		});
		this.markDraftModified({
			...this.draftBlueprint,
			nodes: nextNodes,
			managers: nextManagers,
		});
	}

	private showBanner(message: string, kind: 'info' | 'warn' | 'error'): void {
		this.bannerDisposables.clear();
		clearNode(this.bannerEl);
		append(this.bannerEl, $('span.ade-eng-banner-text', {}, message));
		const dismissBtn = append(this.bannerEl, $('button.ade-eng-banner-dismiss', {
			type: 'button',
			title: localize('adeEngDismissBanner', "Dismiss"),
		}, '×'));
		this.bannerDisposables.add(addDisposableListener(dismissBtn, EventType.CLICK, () => {
			this.hideBanner();
		}));
		this.bannerEl.className = `ade-eng-banner ${kind}`;
		this.bannerEl.hidden = false;
	}

	private hideBanner(): void {
		this.bannerDisposables.clear();
		this.bannerEl.hidden = true;
	}

	private isNodeCompletedLocked(nodeId: string): boolean {
		return Boolean(this.snapshot?.state.nodes[nodeId]?.completed);
	}

	private applyWorldTransform(): void {
		this.viewportEl.scrollLeft = 0;
		this.viewportEl.scrollTop = 0;
		this.worldEl.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px) scale(${this.zoom})`;
		this.viewportEl.style.backgroundPosition = `${Math.round(this.panX)}px ${Math.round(this.panY)}px`;
		const gridSize = Math.max(12, Math.round(24 * this.zoom));
		this.viewportEl.style.backgroundSize = `${gridSize}px ${gridSize}px`;
		this.viewportEl.classList.toggle('zoom-compact', this.zoom < 0.58);
		this.updateMinimapLens();
		this.positionPopoverNearAnchor();
	}

	private fitViewportToGraph(animate = false): void {
		if (!this.draftBlueprint || this.draftBlueprint.nodes.length === 0 || !this.lastDimension) {
			this.animateViewportTo(48, 36, 1, animate);
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of this.draftBlueprint.nodes) {
			const x = n.position?.x ?? 196;
			const y = n.position?.y ?? 256;
			minX = Math.min(minX, x - 156);
			minY = Math.min(minY, y - 122);
			maxX = Math.max(maxX, x + 168);
			maxY = Math.max(maxY, y + 118);
		}
		const availW = Math.max(320, this.lastDimension.width - 76);
		const availH = Math.max(240, this.lastDimension.height - 104);
		const graphW = Math.max(240, maxX - minX);
		const graphH = Math.max(180, maxY - minY);
		const scale = Math.min(1.08, Math.max(0.38, Math.min(availW / graphW, availH / graphH)));
		const targetZoom = Math.round(scale * 100) / 100;
		const targetPanX = Math.round((availW - graphW * targetZoom) / 2 - minX * targetZoom + 38);
		const targetPanY = Math.round((availH - graphH * targetZoom) / 2 - minY * targetZoom + 24);
		this.animateViewportTo(targetPanX, targetPanY, targetZoom, animate);
	}

	private focusNodeOnCanvas(nodeId: string, openInspector = false): void {
		const target = this.draftBlueprint?.nodes.find(n => n.id === nodeId);
		if (!target) {
			return;
		}
		if (this.lastDimension && target.position) {
			const targetZoom = Math.max(0.75, Math.min(1.08, this.zoom));
			const targetPanX = Math.round(this.lastDimension.width * (openInspector ? 0.36 : 0.5) - target.position.x * targetZoom);
			const targetPanY = Math.round((this.lastDimension.height - 44) * 0.5 - target.position.y * targetZoom);
			this.animateViewportTo(targetPanX, targetPanY, targetZoom, true);
		}
		if (openInspector) {
			this.openPopoverForTarget({
				nodeId: target.id,
				anchorKind: target.type === 'user_gate' ? 'gate' : 'worker',
				tab: target.type === 'user_gate' ? 'task' : 'worker',
			});
		}
	}

	private focusWaitingGateNode(): void {
		if (!this.draftBlueprint || !this.snapshot) {
			return;
		}
		const waitingGate = this.draftBlueprint.nodes.find(
			n => n.type === 'user_gate' && this.snapshot?.state.nodes[n.id]?.phase === 'waiting_user_gate',
		);
		if (!waitingGate) {
			return;
		}
		if (this.lastDimension && waitingGate.position) {
			const targetPanX = Math.round(this.lastDimension.width * 0.36 - waitingGate.position.x * this.zoom);
			const targetPanY = Math.round((this.lastDimension.height - 44) * 0.5 - waitingGate.position.y * this.zoom);
			this.animateViewportTo(targetPanX, targetPanY, this.zoom, false);
		}
		this.openPopoverForTarget({
			nodeId: waitingGate.id,
			anchorKind: 'gate',
			tab: 'task',
		});
	}

	private async handleResetTreeClicked(): Promise<void> {
		if (!this.activeGovernorId || !this.snapshot) {
			return;
		}
		if (this.snapshot.state.runStatus === 'completed' || this.snapshot.progress.completedNodes > 0) {
			const confirmed = await this.dialogService.confirm({
				type: 'question',
				message: localize('adeEngConfirmResetTreeTitle', "Reset Engineering execution state for '{0}'?", this.snapshot.governorLabel),
				detail: localize('adeEngConfirmResetTreeDetail', "All nodes will unlock and return to Standby so you can edit or re-run the workflow from scratch. Workspace files are preserved."),
				primaryButton: localize('adeEngConfirmResetTreeBtn', "&&Reset State"),
				custom: true,
			});
			if (!confirmed.confirmed) {
				return;
			}
		}
		try {
			await this.engineering.resetTree({ governorSessionId: this.activeGovernorId });
			this.reloadFromService(true);
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private renderToolbar(): void {
		this.toolbarRenderDisposables.clear();
		clearNode(this.toolbarEl);
		this.undoBtnEl = undefined;
		this.blueprintSheetBtnEl = undefined;
		this.eventsSheetBtnEl = undefined;
		const snap = this.snapshot;
		const bp = this.draftBlueprint;
		if (!snap || !bp) {
			append(this.toolbarEl, $('span.ade-eng-toolbar-title', {}, localize('adeEngLoading', "ADE Engineering")));
			return;
		}

		// Left Cluster: Title + Mode Pill + Status + Rich Progress Bar + Interactive Token Analytics + Quick Node Jump
		const left = append(this.toolbarEl, $('.ade-eng-toolbar-group.left'));
		const titleIcon = append(left, $('span.ade-eng-title-icon'));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchySub));
		append(left, $('span.ade-eng-toolbar-title', { title: snap.governorLabel }, snap.governorLabel));
		append(left, $('span.ade-eng-tree-pill', {
			title: localize('adeEngTierLegendTooltip', "4-Tier Architecture: Governor (L1) → Segment Manager (L2 Lane) → Outer Employee Shell (L3 Reviewer) → Inner Worker Core (L4 Executor)"),
		}, snap.treeType === 'research' ? localize('adeEngTreeResearch', "Research") : localize('adeEngTreeEngineering', "Engineering")));

		const statusPill = append(left, $(`span.ade-eng-run-pill.status-${snap.state.runStatus}`));
		append(statusPill, $('span.ade-eng-run-dot'));
		const statusLabelMap: Record<string, string> = {
			idle: localize('adeEngStatusIdle', "Standby"),
			running: localize('adeEngStatusRunning', "Running"),
			paused: localize('adeEngStatusPaused', "Paused"),
			waiting_gate: localize('adeEngStatusWaitingGate', "Awaiting Gate"),
			circuit_broken: localize('adeEngStatusCircuitBroken', "Circuit Broken"),
			completed: localize('adeEngStatusCompleted', "Completed"),
		};
		append(statusPill, $('span', {}, statusLabelMap[snap.state.runStatus] ?? snap.state.runStatus));

		const pctDone = snap.progress.totalNodes > 0 ? Math.round((snap.progress.completedNodes / snap.progress.totalNodes) * 100) : 0;
		const progressPill = append(left, $('span.ade-eng-progress-pill', {
			title: localize(
				'adeEngProgressDetailTooltip',
				"Completed: {0}/{1} nodes ({2}%) · Active: {3} · Waiting Gates: {4} · Failed: {5} · Manager Segments: {6}",
				snap.progress.completedNodes,
				snap.progress.totalNodes,
				pctDone,
				snap.progress.runningNodes,
				snap.progress.waitingGates,
				snap.progress.failedNodes,
				bp.managers.length,
			),
		}));
		const progTrack = append(progressPill, $('span.ade-eng-progress-mini-bar'));
		const progFill = append(progTrack, $('span.ade-eng-progress-mini-fill'));
		progFill.style.width = `${pctDone}%`;
		append(progressPill, $('span', {}, `${snap.progress.completedNodes}/${snap.progress.totalNodes} · ${bp.managers.length} Mgr`));

		const treeTokens = snap.tokenUsage.total;
		const tokenTooltipLines = [
			localize(
				'adeEngTokensTotalTooltip',
				"Total Token Consumption: {0} tokens ({1} turns) — Click for 4-tier chart",
				treeTokens.totalTokens.toLocaleString(),
				treeTokens.turns,
			),
			localize(
				'adeEngTokensIoTooltip',
				"Input: {0} · Output: {1} · Cache Read: {2} · Cache Write: {3}",
				treeTokens.inputTokens.toLocaleString(),
				treeTokens.outputTokens.toLocaleString(),
				treeTokens.cacheReadTokens.toLocaleString(),
				treeTokens.cacheWriteTokens.toLocaleString(),
			),
			localize(
				'adeEngTokensByRoleTooltip',
				"By Role — Worker (L4): {0} · Employee (L3): {1} · Manager (L2): {2} · Governor (L1): {3}",
				snap.tokenUsage.worker.totalTokens.toLocaleString(),
				snap.tokenUsage.employee.totalTokens.toLocaleString(),
				snap.tokenUsage.manager.totalTokens.toLocaleString(),
				snap.tokenUsage.governor.totalTokens.toLocaleString(),
			),
		];
		const tokensPill = append(left, $(`span.ade-eng-tokens-pill${treeTokens.totalTokens > 0 ? '.has-usage' : ''}${this.showTokenAnalytics ? '.active' : ''}`, {
			title: tokenTooltipLines.join('\n'),
			role: 'button',
			tabindex: '0',
		}));
		const tokIco = append(tokensPill, $('span.ade-eng-tokens-ico'));
		tokIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.pulse));
		append(tokensPill, $('span', {}, `${formatCompactTokenCount(treeTokens.totalTokens)} tok`));
		this.toolbarRenderDisposables.add(addDisposableListener(tokensPill, EventType.CLICK, () => {
			this.toggleTokenAnalytics();
		}));

		if (bp.nodes.length > 1) {
			const jumpSelect = append(left, $('select.ade-eng-node-jumper', {
				title: localize('adeEngJumpToNodeTooltip', "Jump camera to any node in the DAG"),
			})) as HTMLSelectElement;
			append(jumpSelect, $('option', { value: '' }, localize('adeEngJumpPlaceholder', "Jump ({0})…", bp.nodes.length)));
			for (const n of bp.nodes) {
				append(jumpSelect, $('option', { value: n.id }, `[${n.id}] ${n.title}`));
			}
			this.toolbarRenderDisposables.add(addDisposableListener(jumpSelect, EventType.CHANGE, () => {
				const chosen = jumpSelect.value;
				jumpSelect.value = '';
				if (chosen) {
					this.focusNodeOnCanvas(chosen, false);
				}
			}));
		}

		// Right Cluster: Undo/Redo + Authoring Tools + Sheet Toggles + Draft Guard + Execution Controls
		const right = append(this.toolbarEl, $('.ade-eng-toolbar-group.right'));

		const undoBtn = append(right, $('button.ade-eng-icon-btn.ade-eng-undo-btn', {
			type: 'button',
			title: localize('adeEngUndoTooltip', "Undo Blueprint Edit (Cmd/Ctrl+Z)"),
			...(this.undoStack.length === 0 ? { disabled: 'disabled' } : {}),
		})) as HTMLButtonElement;
		this.undoBtnEl = undoBtn;
		undoBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.discard));
		this.toolbarRenderDisposables.add(addDisposableListener(undoBtn, EventType.CLICK, () => this.undoDraft()));

		const redoBtn = append(right, $('button.ade-eng-icon-btn.ade-eng-redo-btn', {
			type: 'button',
			title: localize('adeEngRedoTooltip', "Redo Blueprint Edit (Cmd/Ctrl+Shift+Z)"),
			...(this.redoStack.length === 0 ? { disabled: 'disabled' } : {}),
		}));
		redoBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.redo));
		this.toolbarRenderDisposables.add(addDisposableListener(redoBtn, EventType.CLICK, () => this.redoDraft()));

		const makeToolBtn = (icon: ThemeIcon, label: string, onClick: () => void, extraClass = '') => {
			const btn = append(right, $(`button.ade-eng-tool-btn${extraClass ? `.${extraClass}` : ''}`, {
				type: 'button',
				title: label,
			}));
			const ico = append(btn, $('span.ade-eng-tool-ico'));
			ico.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(btn, $('span.ade-eng-tool-label', {}, label));
			this.toolbarRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, onClick));
			return btn;
		};

		const addTaskBtn = makeToolBtn(Codicon.add, localize('adeEngAddTaskBtn', "Task"), () => this.addDraftNode('task'));
		addTaskBtn.title = localize('adeEngAddTaskTooltip', "Add Dual-Layer Task Node (Outer Employee L3 + Inner Worker L4)");

		const addGateBtn = makeToolBtn(Codicon.verified, localize('adeEngAddGateBtn', "User Gate"), () => this.addDraftNode('user_gate'));
		addGateBtn.title = localize('adeEngAddGateTooltip', "Add Human Acceptance Checkpoint Gate");

		const connectBtn = makeToolBtn(
			Codicon.arrowRight,
			localize('adeEngConnectBtn', "Connect"),
			() => {
				this.connectMode = !this.connectMode;
				this.connectSourceNodeId = undefined;
				this.renderToolbar();
				this.renderCanvas();
			},
			this.connectMode ? 'active' : '',
		);
		connectBtn.title = localize('adeEngConnectTooltip', "Toggle Edge Wiring Mode (or drag directly from any node's right port)");

		const isolationBtn = makeToolBtn(
			bp.metadata.workspaceIsolation === 'worktree' ? Codicon.gitBranch : Codicon.folder,
			bp.metadata.workspaceIsolation === 'worktree'
				? localize('adeEngWorktreeBadge', "Worktree")
				: localize('adeEngSharedBadge', "Shared Root"),
			() => {
				const nextIso = bp.metadata.workspaceIsolation === 'worktree' ? 'shared' : 'worktree';
				this.markDraftModified({
					...bp,
					metadata: { ...bp.metadata, workspaceIsolation: nextIso },
				});
			},
		);
		isolationBtn.title = localize('adeEngIsolationTooltip', "Toggle Workspace Parallel Strategy: Shared Root vs Git Worktree Sandbox");

		const bpBtn = makeToolBtn(
			Codicon.fileCode,
			localize('adeEngBlueprintSheetBtn', "Blueprint"),
			() => this.toggleSheet('blueprint'),
			`ade-eng-sheet-toggle${this.activeSheetTab === 'blueprint' ? '.active' : ''}`,
		);
		bpBtn.title = localize('adeEngBlueprintSheetTooltip', "View or edit raw Blueprint Markdown");
		this.blueprintSheetBtnEl = bpBtn;

		const logsBtn = makeToolBtn(
			Codicon.history,
			localize('adeEngEventsSheetBtn', "Logs"),
			() => this.toggleSheet('events'),
			`ade-eng-sheet-toggle${this.activeSheetTab === 'events' ? '.active' : ''}`,
		);
		logsBtn.title = localize('adeEngEventsSheetTooltip', "Inspect live Engineering timeline & execution logs ({0})", snap.state.events.length);
		this.eventsSheetBtnEl = logsBtn;

		append(right, $('span.ade-eng-toolbar-sep'));

		if (this.isDraftDirty) {
			append(right, $('span.ade-eng-draft-badge', {
				title: localize('adeEngDraftShortcutHint', "Unsaved Blueprint changes (Cmd/Ctrl+S to Confirm)"),
			}, localize('adeEngDraftUnsaved', "Draft")));

			const cancelBtn = append(right, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
			}, localize('adeEngCancelDraftBtn', "Cancel")));
			this.toolbarRenderDisposables.add(addDisposableListener(cancelBtn, EventType.CLICK, () => {
				this.hideBanner();
				this.reloadFromService(true);
			}));

			const confirmBtn = append(right, $('button.ade-eng-action-btn.confirm', {
				type: 'button',
				title: localize('adeEngConfirmShortcutHint', "Apply Blueprint changes (Cmd/Ctrl+S)"),
			}, localize('adeEngConfirmDraftBtn', "Confirm")));
			this.toolbarRenderDisposables.add(addDisposableListener(confirmBtn, EventType.CLICK, () => {
				void this.confirmDraftChanges();
			}));
		}

		const runStatus = snap.state.runStatus;
		if (runStatus === 'running') {
			const pauseBtn = append(right, $('button.ade-eng-action-btn.secondary', { type: 'button' }));
			const pauseIco = append(pauseBtn, $('span'));
			pauseIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugPause));
			append(pauseBtn, $('span', {}, localize('adeEngPauseBtn', "Pause")));
			this.toolbarRenderDisposables.add(addDisposableListener(pauseBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.pauseTree(this.activeGovernorId).catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				}
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.danger', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.toolbarRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.stopTree(this.activeGovernorId).catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				}
			}));
		} else if (runStatus === 'waiting_gate') {
			const gateBtn = append(right, $('button.ade-eng-action-btn.gate', {
				type: 'button',
				title: localize('adeEngReviewGateTooltip', "Jump to the waiting User Gate to approve or roll back"),
			}));
			const gateIco = append(gateBtn, $('span'));
			gateIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.verifiedFilled));
			append(gateBtn, $('span', {}, localize('adeEngReviewGateBtn', "Review Gate")));
			this.toolbarRenderDisposables.add(addDisposableListener(gateBtn, EventType.CLICK, () => {
				this.focusWaitingGateNode();
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.secondary', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.toolbarRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.stopTree(this.activeGovernorId).catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				}
			}));
		} else if (runStatus === 'paused') {
			const resumeBtn = append(right, $('button.ade-eng-action-btn.run', { type: 'button' }));
			const resumeIco = append(resumeBtn, $('span'));
			resumeIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.play));
			append(resumeBtn, $('span', {}, localize('adeEngResumeBtn', "Resume")));
			this.toolbarRenderDisposables.add(addDisposableListener(resumeBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.resumeTree(this.activeGovernorId, 'user').catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				}
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.secondary', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.toolbarRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.stopTree(this.activeGovernorId).catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				}
			}));
		} else {
			if (runStatus === 'completed' || runStatus === 'circuit_broken' || snap.progress.completedNodes > 0) {
				const resetBtn = append(right, $('button.ade-eng-action-btn.secondary', {
					type: 'button',
					title: localize('adeEngResetTreeTooltip', "Unlock completed/failed nodes and reset execution state to Standby"),
				}));
				const resetIco = append(resetBtn, $('span'));
				resetIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugRestart));
				append(resetBtn, $('span', {}, localize('adeEngResetBtn', "Reset")));
				this.toolbarRenderDisposables.add(addDisposableListener(resetBtn, EventType.CLICK, () => {
					void this.handleResetTreeClicked();
				}));
			}

			const runBtn = append(right, $('button.ade-eng-action-btn.run', {
				type: 'button',
				...(this.isDraftDirty ? { title: localize('adeEngConfirmBeforeRunHint', "Confirm & run updated Blueprint") } : {}),
			}));
			const playIco = append(runBtn, $('span'));
			playIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.play));
			append(runBtn, $('span', {}, localize('adeEngRunBtn', "Run")));
			this.toolbarRenderDisposables.add(addDisposableListener(runBtn, EventType.CLICK, () => {
				void this.handleRunClicked();
			}));
		}
	}

	private renderHud(): void {
		this.hudRenderDisposables.clear();
		clearNode(this.hudEl);

		const mapToggleBtn = append(this.hudEl, $(`button.ade-eng-hud-icon-btn.ade-eng-minimap-toggle${this.showMinimap ? '.active' : ''}`, {
			type: 'button',
			title: localize('adeEngToggleMinimapTooltip', "Toggle DAG Minimap"),
		}));
		mapToggleBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.map));
		this.hudRenderDisposables.add(addDisposableListener(mapToggleBtn, EventType.CLICK, () => {
			this.showMinimap = !this.showMinimap;
			this.minimapEl.classList.toggle('collapsed', !this.showMinimap);
			this.renderHud();
		}));

		append(this.hudEl, $('span.ade-eng-hud-sep'));

		const autoLayoutBtn = append(this.hudEl, $('button.ade-eng-hud-btn', {
			type: 'button',
			title: localize('adeEngAutoLayoutTooltip', "Auto-arrange DAG nodes cleanly (L)"),
		}));
		const layoutIco = append(autoLayoutBtn, $('span'));
		layoutIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.layout));
		append(autoLayoutBtn, $('span', {}, localize('adeEngAutoLayoutBtn', "Auto Layout")));
		this.hudRenderDisposables.add(addDisposableListener(autoLayoutBtn, EventType.CLICK, () => this.runAutoLayoutDraft()));

		const fitBtn = append(this.hudEl, $('button.ade-eng-hud-icon-btn', {
			type: 'button',
			title: localize('adeEngFitViewBtnTooltip', "Fit Entire DAG in Viewport (F or 0)"),
		}));
		fitBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.screenFull));
		this.hudRenderDisposables.add(addDisposableListener(fitBtn, EventType.CLICK, () => this.fitViewportToGraph(true)));

		append(this.hudEl, $('span.ade-eng-hud-sep'));

		const zoomOutBtn = append(this.hudEl, $('button.ade-eng-hud-icon-btn', { type: 'button', title: localize('adeEngZoomOut', "Zoom Out") }));
		zoomOutBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomOut));
		this.hudRenderDisposables.add(addDisposableListener(zoomOutBtn, EventType.CLICK, () => {
			this.zoomAroundViewportCenter(-0.12);
		}));

		const zoomLabelBtn = append(this.hudEl, $('button.ade-eng-zoom-readout', {
			type: 'button',
			title: localize('adeEngFitView', "Fit Graph in Viewport (0 or F)"),
		}, `${Math.round(this.zoom * 100)}%`));
		this.hudRenderDisposables.add(addDisposableListener(zoomLabelBtn, EventType.CLICK, () => this.fitViewportToGraph(true)));

		const zoomInBtn = append(this.hudEl, $('button.ade-eng-hud-icon-btn', { type: 'button', title: localize('adeEngZoomIn', "Zoom In") }));
		zoomInBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomIn));
		this.hudRenderDisposables.add(addDisposableListener(zoomInBtn, EventType.CLICK, () => {
			this.zoomAroundViewportCenter(0.12);
		}));
	}

	private async handleRunClicked(): Promise<void> {
		if (!this.activeGovernorId) {
			return;
		}
		if (this.isDraftDirty) {
			const applied = await this.confirmDraftChanges();
			if (!applied) {
				return;
			}
		}
		try {
			await this.engineering.runTree(this.activeGovernorId, 'user');
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}

	private async applyRawBlueprintWithSafety(blueprintText: string): Promise<boolean> {
		if (!this.activeGovernorId) {
			return false;
		}
		try {
			await this.engineering.applyBlueprint({
				governorSessionId: this.activeGovernorId,
				blueprintText,
				forceStopRunning: false,
			});
			this.isDraftDirty = false;
			this.hideBanner();
			this.reloadFromService(true);
			return true;
		} catch (err) {
			if (err instanceof AdeRunningNodesAffectedError) {
				const confirmed = await this.dialogService.confirm({
					type: 'warning',
					message: localize(
						'adeEngConfirmForceStopTitle',
						"Node(s) [{0}] are currently in progress. Stop active Worker(s) and apply the new DAG?",
						err.affectedNodeIds.join(', '),
					),
					detail: localize(
						'adeEngConfirmForceStopDetail',
						"Confirming will immediately stop the affected active Worker turn(s), re-partition Manager segments for the updated DAG, and refresh the locked sidebar hierarchy.",
					),
					primaryButton: localize('adeEngForceStopConfirmBtn', "&&Stop Running Node(s) & Apply"),
					custom: true,
				});
				if (!confirmed.confirmed) {
					return false;
				}
				await this.engineering.applyBlueprint({
					governorSessionId: this.activeGovernorId,
					blueprintText,
					forceStopRunning: true,
				});
				this.isDraftDirty = false;
				this.hideBanner();
				this.reloadFromService(true);
				return true;
			}
			throw err;
		}
	}

	private async confirmDraftChanges(): Promise<boolean> {
		if (!this.activeGovernorId || !this.draftBlueprint) {
			return false;
		}
		try {
			topologicalSortNodes(this.draftBlueprint.nodes, this.draftBlueprint.edges);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.showBanner(msg, 'error');
			return false;
		}

		const serialized = serializeEngineeringBlueprint(this.draftBlueprint);
		try {
			return await this.applyRawBlueprintWithSafety(serialized);
		} catch (err) {
			this.showBanner(err instanceof Error ? err.message : String(err), 'error');
			return false;
		}
	}

	private addDraftNode(type: 'task' | 'user_gate', fromSourceNodeId?: string): void {
		if (!this.draftBlueprint) {
			return;
		}
		const existingIds = new Set(this.draftBlueprint.nodes.map(n => n.id));
		const prefix = type === 'user_gate' ? 'U' : 'N';
		let index = this.draftBlueprint.nodes.length + 1;
		while (existingIds.has(`${prefix}${index}`)) {
			index++;
		}
		const newId = `${prefix}${index}`;

		let pos: { x: number; y: number };
		const sourceNode = fromSourceNodeId ? this.draftBlueprint.nodes.find(n => n.id === fromSourceNodeId) : undefined;
		if (sourceNode?.position) {
			const existingDownstreamCount = this.draftBlueprint.edges.filter(e => e.from === sourceNode.id).length;
			const offsetY = existingDownstreamCount === 0 ? 0 : (existingDownstreamCount % 2 === 1 ? 1 : -1) * Math.ceil(existingDownstreamCount / 2) * 220;
			pos = {
				x: sourceNode.position.x + 356,
				y: Math.max(150, sourceNode.position.y + offsetY),
			};
		} else {
			const maxX = this.draftBlueprint.nodes.reduce((acc, n) => Math.max(acc, n.position?.x ?? 196), 100);
			pos = {
				x: this.draftBlueprint.nodes.length === 0 ? 196 : maxX + 340,
				y: 256 + ((index % 3) - 1) * 90,
			};
		}

		const sampleTask = (sourceNode?.type === 'task' ? sourceNode : undefined) ?? this.draftBlueprint.nodes.find(n => n.worker);
		const defaultEngine = sampleTask?.worker?.engine ?? 'claude-code';
		const defaultEmpEngine = sampleTask?.employee?.engine ?? defaultEngine;
		const defaultModel = sampleTask?.worker?.model;
		const defaultEmpModel = sampleTask?.employee?.model;
		const newNode: IAdeEngineeringBlueprintNode = type === 'user_gate'
			? {
				id: newId,
				title: localize('adeEngNewGateDefaultTitle', "User Acceptance Gate {0}", index),
				type: 'user_gate',
				critical: false,
				description: localize('adeEngNewGateDefaultDesc', "Inspect upstream deliverables and approve or roll back to a specific task."),
				position: pos,
			}
			: {
				id: newId,
				title: localize('adeEngNewTaskDefaultTitle', "Task {0}", index),
				type: 'task',
				critical: false,
				employee: { engine: defaultEmpEngine, ...(defaultEmpModel ? { model: defaultEmpModel } : {}), thinking: sampleTask?.employee?.thinking ?? 'medium' },
				worker: { engine: defaultEngine, ...(defaultModel ? { model: defaultModel } : {}), thinking: sampleTask?.worker?.thinking ?? 'high' },
				goal: localize('adeEngNewTaskDefaultGoal', "Implement task {0} cleanly in the workspace.", newId),
				acceptance: localize('adeEngNewTaskDefaultAcceptance', "1. Implementation passes static checks and unit tests."),
				position: pos,
			};

		const nextEdges = sourceNode
			? [...this.draftBlueprint.edges, { from: sourceNode.id, to: newId }]
			: this.draftBlueprint.edges;

		this.markDraftModified({
			...this.draftBlueprint,
			nodes: [...this.draftBlueprint.nodes, newNode],
			edges: nextEdges,
		});

		// Ensure newly added node is visible inside viewport if currently off-screen
		if (this.lastDimension && this.lastDimension.width > 0) {
			const screenX = pos.x * this.zoom + this.panX;
			const screenY = pos.y * this.zoom + this.panY;
			if (screenX > this.lastDimension.width - 140 || screenX < 100 || screenY > this.lastDimension.height - 120 || screenY < 80) {
				const targetPanX = Math.round(this.lastDimension.width * 0.42 - pos.x * this.zoom);
				const targetPanY = Math.round((this.lastDimension.height - 44) * 0.5 - pos.y * this.zoom);
				this.animateViewportTo(targetPanX, targetPanY, this.zoom, false);
			}
		}

		this.openPopoverForTarget({
			nodeId: newId,
			anchorKind: type === 'user_gate' ? 'gate' : 'worker',
			tab: type === 'user_gate' ? 'task' : 'worker',
		});
	}

	private deleteDraftNode(nodeId: string): void {
		if (!this.draftBlueprint || this.isNodeCompletedLocked(nodeId)) {
			return;
		}
		const remainingNodes = this.draftBlueprint.nodes.filter(n => n.id !== nodeId);
		const remainingEdges = this.draftBlueprint.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
		if (this.activePopoverNodeId === nodeId) {
			this.closePopover();
		}
		this.markDraftModified({
			...this.draftBlueprint,
			nodes: remainingNodes,
			edges: remainingEdges,
		});
	}

	private tryAddDraftEdge(fromId: string, toId: string): void {
		if (!this.draftBlueprint || fromId === toId) {
			return;
		}
		if (this.isNodeCompletedLocked(toId)) {
			this.showBanner(localize('adeEngLockedEdgeTarget', "Completed node '{0}' is locked; cannot alter its incoming prerequisites.", toId), 'warn');
			return;
		}
		if (this.draftBlueprint.edges.some(e => e.from === fromId && e.to === toId)) {
			return;
		}
		const nextEdges: IAdeEngineeringBlueprintEdge[] = [...this.draftBlueprint.edges, { from: fromId, to: toId }];
		try {
			topologicalSortNodes(this.draftBlueprint.nodes, nextEdges);
		} catch (err) {
			this.showBanner(err instanceof Error ? err.message : String(err), 'error');
			return;
		}
		this.markDraftModified({
			...this.draftBlueprint,
			edges: nextEdges,
		});
	}

	private removeDraftEdge(fromId: string, toId: string): void {
		if (!this.draftBlueprint) {
			return;
		}
		if (this.isNodeCompletedLocked(toId)) {
			this.showBanner(localize('adeEngLockedEdgeRemove', "Completed node '{0}' is locked; cannot remove its incoming edge.", toId), 'warn');
			return;
		}
		this.markDraftModified({
			...this.draftBlueprint,
			edges: this.draftBlueprint.edges.filter(e => !(e.from === fromId && e.to === toId)),
		});
	}

	private runAutoLayoutDraft(): void {
		if (!this.draftBlueprint) {
			return;
		}
		try {
			const positions = computeAutoLayoutPositions(this.draftBlueprint);
			this.markDraftModified({
				...this.draftBlueprint,
				nodes: this.draftBlueprint.nodes.map(n => ({
					...n,
					position: positions.get(n.id) ?? n.position,
				})),
			});
			this.fitViewportToGraph(true);
		} catch (err) {
			this.showBanner(err instanceof Error ? err.message : String(err), 'error');
		}
	}

	private applyEngineIconToElement(el: HTMLElement, blueprintEngine: string | undefined): void {
		const adeEngineId = toAdeEngineId(blueprintEngine, 'aexus-claude');
		const icon = this.sessions.getIcon(adeEngineId) ?? Codicon.hubot;
		if (URI.isUri(icon)) {
			el.className = 'ade-eng-engine-glyph svg-icon';
			el.style.backgroundImage = asCSSUrl(icon);
		} else {
			el.className = `ade-eng-engine-glyph ${ThemeIcon.asClassName(icon)}`;
			el.style.backgroundImage = '';
		}
	}

	private getNodePorts(node: IAdeEngineeringBlueprintNode): { inX: number; inY: number; outX: number; outY: number } {
		const cx = node.position?.x ?? 196;
		const cy = node.position?.y ?? 256;
		if (node.type === 'user_gate') {
			return {
				inX: cx - GATE_NODE_WIDTH / 2 - 4,
				inY: cy,
				outX: cx + GATE_NODE_WIDTH / 2 + 4,
				outY: cy,
			};
		}
		const halfW = TASK_POD_WIDTH / 2;
		return {
			inX: cx - halfW - 4,
			inY: cy,
			outX: cx + halfW + 4,
			outY: cy,
		};
	}

	private buildBezierPath(x1: number, y1: number, x2: number, y2: number): string {
		const dx = Math.abs(x2 - x1);
		const controlOffset = Math.max(60, Math.min(190, dx * 0.5));
		const c1x = x1 + controlOffset;
		const c2x = x2 - controlOffset;
		return `M ${Math.round(x1)} ${Math.round(y1)} C ${Math.round(c1x)} ${Math.round(y1)}, ${Math.round(c2x)} ${Math.round(y2)}, ${Math.round(x2)} ${Math.round(y2)}`;
	}

	private computeSegmentBounds(segNodes: readonly IAdeEngineeringBlueprintNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of segNodes) {
			const cx = n.position?.x ?? 204;
			const cy = n.position?.y ?? 260;
			const padX = n.type === 'user_gate' ? 128 : 144;
			minX = Math.min(minX, cx - padX);
			minY = Math.min(minY, cy - 104);
			maxX = Math.max(maxX, cx + padX + 6);
			maxY = Math.max(maxY, cy + 100);
		}
		return { minX, minY, maxX, maxY };
	}

	private updateSegmentHalosInPlace(): void {
		if (!this.draftBlueprint) {
			return;
		}
		const nodeById = new Map(this.draftBlueprint.nodes.map(n => [n.id, n]));
		for (const seg of this.draftBlueprint.managers) {
			const halo = this.segmentHaloDomById.get(seg.segmentId);
			if (!halo) {
				continue;
			}
			const segNodes = seg.nodeIds.map(id => nodeById.get(id)).filter((n): n is IAdeEngineeringBlueprintNode => Boolean(n));
			if (segNodes.length === 0) {
				continue;
			}
			const b = this.computeSegmentBounds(segNodes);
			halo.style.left = `${Math.round(b.minX)}px`;
			halo.style.top = `${Math.round(b.minY)}px`;
			halo.style.width = `${Math.round(b.maxX - b.minX)}px`;
			halo.style.height = `${Math.round(b.maxY - b.minY)}px`;
		}
	}

	private renderAlignmentGuides(guides: readonly { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[]): void {
		this.guidesGroupEl.replaceChildren();
		for (const g of guides) {
			this.guidesGroupEl.appendChild($.SVG<SVGLineElement>('line', {
				class: 'ade-eng-align-guide',
				x1: String(Math.round(g.x1)),
				y1: String(Math.round(g.y1)),
				x2: String(Math.round(g.x2)),
				y2: String(Math.round(g.y2)),
			}));
		}
	}

	private renderMinimap(): void {
		this.minimapSvgEl.replaceChildren();
		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!bp || !snap || bp.nodes.length === 0) {
			this.minimapEl.hidden = true;
			return;
		}
		this.minimapEl.hidden = false;
		this.minimapEl.classList.toggle('collapsed', !this.showMinimap);

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of bp.nodes) {
			const cx = n.position?.x ?? 196;
			const cy = n.position?.y ?? 256;
			minX = Math.min(minX, cx - 180);
			minY = Math.min(minY, cy - 140);
			maxX = Math.max(maxX, cx + 180);
			maxY = Math.max(maxY, cy + 140);
		}
		const worldW = Math.max(520, maxX - minX);
		const worldH = Math.max(360, maxY - minY);
		this.minimapBounds = { minX, minY, width: worldW, height: worldH };

		const sx = (x: number) => ((x - minX) / worldW) * MINIMAP_WIDTH;
		const sy = (y: number) => ((y - minY) / worldH) * MINIMAP_HEIGHT;
		const nodeById = new Map(bp.nodes.map(n => [n.id, n]));

		for (const seg of bp.managers) {
			const segNodes = seg.nodeIds.map(id => nodeById.get(id)).filter((n): n is IAdeEngineeringBlueprintNode => Boolean(n));
			if (segNodes.length === 0) {
				continue;
			}
			const b = this.computeSegmentBounds(segNodes);
			this.minimapSvgEl.appendChild($.SVG<SVGRectElement>('rect', {
				class: 'ade-eng-minimap-seg',
				x: String(Math.max(1, sx(b.minX)).toFixed(1)),
				y: String(Math.max(1, sy(b.minY)).toFixed(1)),
				width: String(Math.max(8, ((b.maxX - b.minX) / worldW) * MINIMAP_WIDTH).toFixed(1)),
				height: String(Math.max(6, ((b.maxY - b.minY) / worldH) * MINIMAP_HEIGHT).toFixed(1)),
				rx: '3',
			}));
		}

		for (const edge of bp.edges) {
			const src = nodeById.get(edge.from);
			const dst = nodeById.get(edge.to);
			if (!src || !dst) {
				continue;
			}
			this.minimapSvgEl.appendChild($.SVG<SVGLineElement>('line', {
				class: 'ade-eng-minimap-edge',
				x1: String(sx(src.position?.x ?? 196).toFixed(1)),
				y1: String(sy(src.position?.y ?? 256).toFixed(1)),
				x2: String(sx(dst.position?.x ?? 196).toFixed(1)),
				y2: String(sy(dst.position?.y ?? 256).toFixed(1)),
			}));
		}

		for (const n of bp.nodes) {
			const rt = snap.state.nodes[n.id];
			const status = computeNodeVisualStatus(n, rt);
			const w = Math.max(10, ((n.type === 'user_gate' ? GATE_NODE_WIDTH : TASK_POD_WIDTH) / worldW) * MINIMAP_WIDTH);
			const h = Math.max(7, ((n.type === 'user_gate' ? GATE_NODE_HEIGHT : TASK_POD_HEIGHT) / worldH) * MINIMAP_HEIGHT);
			this.minimapSvgEl.appendChild($.SVG<SVGRectElement>('rect', {
				class: `ade-eng-minimap-node status-${status}${n.type === 'user_gate' ? ' gate' : ''}`,
				x: String((sx(n.position?.x ?? 196) - w / 2).toFixed(1)),
				y: String((sy(n.position?.y ?? 256) - h / 2).toFixed(1)),
				width: String(w.toFixed(1)),
				height: String(h.toFixed(1)),
				rx: n.type === 'user_gate' ? '3' : '2',
			}));
		}

		this.updateMinimapLens();
	}

	private updateMinimapLens(): void {
		if (!this.minimapLensEl || this.minimapEl.hidden || !this.showMinimap) {
			return;
		}
		const vw = this.viewportEl.clientWidth || (this.lastDimension?.width ?? 960);
		const vh = this.viewportEl.clientHeight || ((this.lastDimension?.height ?? 640) - 44);
		const viewWorldLeft = -this.panX / this.zoom;
		const viewWorldTop = -this.panY / this.zoom;
		const viewWorldW = vw / this.zoom;
		const viewWorldH = vh / this.zoom;

		const { minX, minY, width, height } = this.minimapBounds;
		const headOffset = 20;
		const left = Math.max(2, Math.min(MINIMAP_WIDTH - 12, ((viewWorldLeft - minX) / width) * MINIMAP_WIDTH));
		const top = headOffset + Math.max(1, Math.min(MINIMAP_HEIGHT - 10, ((viewWorldTop - minY) / height) * MINIMAP_HEIGHT));
		const lensW = Math.max(14, Math.min(MINIMAP_WIDTH - left + 4, (viewWorldW / width) * MINIMAP_WIDTH));
		const lensH = Math.max(10, Math.min(MINIMAP_HEIGHT - (top - headOffset) + 4, (viewWorldH / height) * MINIMAP_HEIGHT));

		this.minimapLensEl.style.left = `${Math.round(left)}px`;
		this.minimapLensEl.style.top = `${Math.round(top)}px`;
		this.minimapLensEl.style.width = `${Math.round(lensW)}px`;
		this.minimapLensEl.style.height = `${Math.round(lensH)}px`;
	}

	private renderCanvas(): void {
		this.canvasRenderDisposables.clear();
		clearNode(this.segmentsLayerEl);
		this.guidesGroupEl.replaceChildren();
		this.edgesGroupEl.replaceChildren();
		clearNode(this.nodesLayerEl);
		this.nodeDomById.clear();
		this.nodeTitleDomById.clear();
		this.nodeAnchorsById.clear();
		this.segmentHaloDomById.clear();
		this.segmentHeaderDomById.clear();
		this.livePhasePillRefs = [];

		this.applyWorldTransform();

		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!bp || !snap) {
			this.emptyStateEl.hidden = true;
			this.connectHintEl.hidden = true;
			this.minimapEl.hidden = true;
			return;
		}

		// Connect Mode Floating Instruction Banner
		if (this.connectMode) {
			clearNode(this.connectHintEl);
			append(
				this.connectHintEl,
				$('span', {}, this.connectSourceNodeId
					? localize('adeEngConnectPickTarget', "Wiring from [{0}] → Click a target node to connect (Esc to cancel)", this.connectSourceNodeId)
					: localize('adeEngConnectPickSource', "Connect Mode: Click source node → then click downstream target node (Esc to exit)")),
			);
			this.connectHintEl.hidden = false;
		} else {
			this.connectHintEl.hidden = true;
		}

		// Empty Blueprint Onboarding CTA
		if (bp.nodes.length === 0) {
			clearNode(this.emptyStateEl);
			append(this.emptyStateEl, $('div.ade-eng-empty-title', {}, localize('adeEngEmptyCanvasTitle', "Design Your Engineering DAG")));
			append(this.emptyStateEl, $('div.ade-eng-empty-desc', {}, localize('adeEngEmptyCanvasDesc', "Each Task Node wraps an inner Worker (L4 Executor) inside an outer Employee (L3 Reviewer) shell, supervised by Segment Managers (L2).")));
			const ctaBtn = append(this.emptyStateEl, $('button.ade-eng-action-btn.run', { type: 'button' }, localize('adeEngEmptyCreateFirstBtn', "+ Create First Task Node")));
			this.canvasRenderDisposables.add(addDisposableListener(ctaBtn, EventType.CLICK, () => this.addDraftNode('task')));
			this.emptyStateEl.hidden = false;
			this.minimapEl.hidden = true;
			return;
		}
		this.emptyStateEl.hidden = true;

		const nodeById = new Map(bp.nodes.map(n => [n.id, n]));
		const runtimes = snap.state.nodes;

		// 1. Render Auto-Partitioned Manager (L2) Segment Enclosures
		for (const seg of bp.managers) {
			const segNodes = seg.nodeIds.map(id => nodeById.get(id)).filter((n): n is IAdeEngineeringBlueprintNode => Boolean(n));
			if (segNodes.length === 0) {
				continue;
			}
			const bounds = this.computeSegmentBounds(segNodes);
			let isManagerActive = false;
			let segDoneCount = 0;
			let segTokens = 0;
			for (const n of segNodes) {
				const rt = runtimes[n.id];
				const ph = rt?.phase;
				if (ph === 'manager_review' || ph === 'manager_escalation') {
					isManagerActive = true;
				}
				if (rt?.completed) {
					segDoneCount++;
				}
				segTokens += rt?.tokenUsage?.total.totalTokens ?? 0;
			}

			const halo = append(this.segmentsLayerEl, $(`div.ade-eng-segment-halo${isManagerActive ? '.role-active' : ''}`, {
				'data-segment-id': seg.segmentId,
			}));
			halo.style.left = `${Math.round(bounds.minX)}px`;
			halo.style.top = `${Math.round(bounds.minY)}px`;
			halo.style.width = `${Math.round(bounds.maxX - bounds.minX)}px`;
			halo.style.height = `${Math.round(bounds.maxY - bounds.minY)}px`;
			this.segmentHaloDomById.set(seg.segmentId, halo);

			const header = append(halo, $(`button.ade-eng-segment-header${isManagerActive ? '.role-active' : ''}`, {
				type: 'button',
				'data-segment-id': seg.segmentId,
				title: localize('adeEngManagerHeaderTooltip', "Manager · L2 [{0}] — Click to open Manager session · Right-click or click ⚙ to configure", seg.segmentId),
			}));
			this.segmentHeaderDomById.set(seg.segmentId, header);

			append(header, $('span.ade-eng-role-tag.mgr', {}, localize('adeEngMgrTierBadge', "MGR · L2")));
			const mgrGlyph = append(header, $('span'));
			this.applyEngineIconToElement(mgrGlyph, seg.config.engine);
			append(header, $('span.ade-eng-segment-label', {}, `[${seg.segmentId}] ${formatRoleConfigCompact(seg.config, 'medium')}`));
			append(header, $('span.ade-eng-segment-stat', {}, `${segDoneCount}/${segNodes.length}`));
			if (segTokens > 0) {
				append(header, $('span.ade-eng-segment-tok', {}, formatCompactTokenCount(segTokens)));
			}
			const segGear = append(header, $('span.ade-eng-seg-cfg-ico', {
				title: localize('adeEngConfigureMgrBtnTooltip', "Configure Segment Manager [{0}]", seg.segmentId),
			}));
			segGear.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));

			const openMgrPopover = (e: Event) => {
				EventHelper.stop(e, true);
				if (segNodes[0]) {
					this.openPopoverForTarget({
						nodeId: segNodes[0].id,
						anchorKind: 'manager',
						tab: 'manager',
						segmentId: seg.segmentId,
					});
				}
			};
			this.canvasRenderDisposables.add(addDisposableListener(header, EventType.CONTEXT_MENU, openMgrPopover));
			this.canvasRenderDisposables.add(addDisposableListener(segGear, EventType.CLICK, openMgrPopover));
			this.canvasRenderDisposables.add(addDisposableListener(header, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				this.closePopover();
				if (this.activeGovernorId && segNodes[0]) {
					void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, segNodes[0].id, 'manager').catch(err => {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					});
				}
			}));
		}

		// 2. Render Directed Edges
		this.renderEdgesOnly();

		// 3. Render Nodes: Unmistakable Nested Dual-Shell Task Pods (Outer Employee L3 wrapping Inner Worker L4) + Shield User Gates
		const now = Date.now();
		for (const node of bp.nodes) {
			const runtime: IAdeEngineeringNodeRuntimeState | undefined = runtimes[node.id];
			const visualStatus = computeNodeVisualStatus(node, runtime);
			const isLocked = Boolean(runtime?.completed);
			const isAwaitingGate = node.type === 'user_gate' && runtime?.phase === 'waiting_user_gate';
			const workerActive = runtime?.phase === 'worker_running';
			const empActive = runtime?.phase === 'employee_review';

			const cx = node.position?.x ?? 196;
			const cy = node.position?.y ?? 256;

			const nodeEl = append(
				this.nodesLayerEl,
				$(`div.ade-eng-node.type-${node.type}.status-${visualStatus}${isLocked ? '.locked' : ''}${isAwaitingGate ? '.awaiting-gate' : ''}${workerActive ? '.phase-worker' : ''}${empActive ? '.phase-employee' : ''}${this.activePopoverNodeId === node.id ? '.inspected' : ''}${this.connectSourceNodeId === node.id ? '.connect-source' : ''}`, {
					'data-node-id': node.id,
					'data-visual-status': visualStatus,
				}),
			);
			nodeEl.style.left = `${Math.round(cx)}px`;
			nodeEl.style.top = `${Math.round(cy)}px`;
			this.nodeDomById.set(node.id, nodeEl);

			const inPort = append(nodeEl, $('div.ade-eng-port.port-in', {
				title: localize('adeEngPortInTooltip', "Input Port ({0})", node.id),
			}));
			const outPort = append(nodeEl, $('div.ade-eng-port.port-out', {
				title: localize('adeEngPortOutTooltip', "Drag from {0} to wire downstream dependency", node.id),
			}));
			this.installPortWiring(node, outPort, inPort);

			// 1-Click Quick-Spawn `+` Handle right beside output port
			const quickSpawnBtn = append(nodeEl, $('button.ade-eng-quick-spawn-btn', {
				type: 'button',
				title: localize('adeEngQuickSpawnTooltip', "Click: + Connected Downstream Task · Alt+Click: + Connected User Gate"),
			}, '+'));
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.POINTER_DOWN, e => {
				EventHelper.stop(e, true);
			}));
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.CLICK, (e: MouseEvent) => {
				EventHelper.stop(e, true);
				this.addDraftNode(e.altKey ? 'user_gate' : 'task', node.id);
			}));

			if (node.type === 'user_gate') {
				const gateBody = append(nodeEl, $('div.ade-eng-gate-body.ade-pistol-cursor', {
					title: isAwaitingGate
						? localize('adeEngGateReadyTooltip', "Click or right-click to review upstream reports and Approve / Rollback")
						: localize('adeEngGateIdleTooltip', "Click or right-click to configure User Gate [{0}]", node.id),
				}));
				this.nodeAnchorsById.set(node.id, { gate: gateBody });

				const gateTop = append(gateBody, $('div.ade-eng-gate-top'));
				const gateIcon = append(gateTop, $('span.ade-eng-gate-icon'));
				gateIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.verifiedFilled));
				const gateTextWrap = append(gateTop, $('div.ade-eng-gate-text'));
				const kickerRow = append(gateTextWrap, $('div.ade-eng-gate-kicker-row'));
				append(kickerRow, $('span.ade-eng-gate-kicker', {}, isAwaitingGate
					? localize('adeEngGateWaitingKicker', "AWAITING APPROVAL")
					: localize('adeEngGateKicker', "USER GATE")));
				append(kickerRow, $('span.ade-eng-node-id-chip', {}, node.id));
				const gateTitleEl = append(gateTextWrap, $('span.ade-eng-gate-title', {}, node.title));
				this.nodeTitleDomById.set(node.id, gateTitleEl);

				const upstreamReports = buildUpstreamReportChain(node.id, bp, snap.state.reports);
				if (isAwaitingGate && this.activeGovernorId) {
					const govId = this.activeGovernorId;
					const inlineActions = append(gateBody, $('div.ade-eng-gate-inline-actions'));
					const quickApproveBtn = append(inlineActions, $('button.ade-eng-gate-inline-approve', {
						type: 'button',
						title: localize('adeEngQuickApproveGateTooltip', "Approve User Gate [{0}] immediately and continue downstream", node.id),
					}, localize('adeEngQuickApproveShort', "✓ Approve")));
					this.canvasRenderDisposables.add(addDisposableListener(quickApproveBtn, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(quickApproveBtn, EventType.CLICK, async e => {
						EventHelper.stop(e, true);
						if (this.gateSubmitting) {
							return;
						}
						this.gateSubmitting = true;
						try {
							await this.engineering.submitGateVerdict({
								governorSessionId: govId,
								nodeId: node.id,
								verdict: 'pass',
							});
						} catch (err) {
							this.notificationService.error(err instanceof Error ? err.message : String(err));
						} finally {
							this.gateSubmitting = false;
						}
					}));

					const quickReviewBtn = append(inlineActions, $('button.ade-eng-gate-inline-review', {
						type: 'button',
						title: localize('adeEngQuickReviewGateTooltip', "Inspect upstream reports or Rollback to an ancestor node"),
					}, localize('adeEngQuickRollbackShort', "Rollback…")));
					this.canvasRenderDisposables.add(addDisposableListener(quickReviewBtn, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(quickReviewBtn, EventType.CLICK, e => {
						EventHelper.stop(e, true);
						this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'gate', tab: 'task' });
					}));
				} else {
					const gateFoot = append(gateBody, $('div.ade-eng-gate-foot'));
					append(gateFoot, $('span.ade-eng-gate-desc-preview', {}, node.description?.trim() || localize('adeEngGateDefaultFoot', "Human acceptance checkpoint")));
					if (upstreamReports.length > 0) {
						append(gateFoot, $('span.ade-eng-gate-up-badge', {}, `${upstreamReports.length} ✓`));
					}
				}
			} else {
				// =========================================================================
				// NESTED DUAL-SHELL TASK POD:
				//   OUTER SHELL = Employee (L3 · Acceptance Reviewer) [.ade-eng-concentric]
				//   INNER CORE  = Worker   (L4 · Pure Native Executor) [.ade-eng-inner-core]
				// =========================================================================
				const concentric = append(nodeEl, $('div.ade-eng-concentric.ade-pistol-cursor'));

				const ringSvg = concentric.appendChild($.SVG<SVGSVGElement>('svg', {
					class: 'ade-eng-outer-ring-svg',
					viewBox: `0 0 ${TASK_POD_WIDTH} ${TASK_POD_HEIGHT}`,
					width: String(TASK_POD_WIDTH),
					height: String(TASK_POD_HEIGHT),
				}));
				ringSvg.appendChild($.SVG<SVGRectElement>('rect', {
					class: 'ade-eng-ring-track',
					x: '1.5',
					y: '1.5',
					width: String(TASK_POD_WIDTH - 3),
					height: String(TASK_POD_HEIGHT - 3),
					rx: '17',
				}));
				ringSvg.appendChild($.SVG<SVGRectElement>('rect', {
					class: 'ade-eng-ring-indicator',
					x: '1.5',
					y: '1.5',
					width: String(TASK_POD_WIDTH - 3),
					height: String(TASK_POD_HEIGHT - 3),
					rx: '17',
					pathLength: '100',
				}));

				// 1. OUTER SHELL HEADER = Employee (L3 · Acceptance Reviewer)
				const empSatellite = append(concentric, $(`div.ade-eng-emp-satellite${empActive ? '.role-active' : ''}${node.critical ? '.has-critical' : ''}`, {
					title: localize(
						'adeEngEmployeeSatTooltip',
						"Outer Shell — Employee · L3 (Acceptance Reviewer): {0} — Click to open Employee chat · Right-click to configure",
						formatRoleConfigCompact(node.employee, 'medium'),
					),
				}));
				append(empSatellite, $('span.ade-eng-role-tag.emp', {}, localize('adeEngEmpTierBadge', "EMPLOYEE · L3")));
				const empGlyph = append(empSatellite, $('span'));
				this.applyEngineIconToElement(empGlyph, node.employee?.engine);
				append(empSatellite, $('span.ade-eng-emp-meta', {}, formatRoleConfigCompact(node.employee, 'medium')));

				if (isLocked) {
					const doneBadge = append(empSatellite, $('span.ade-eng-corner-status.done', {
						title: localize('adeEngDoneBadgeTooltip', "Verified by Employee · Locked — Click or right-click to inspect Report & Diff"),
					}));
					doneBadge.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
					const openRep = (e: Event) => {
						EventHelper.stop(e, true);
						this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'report' });
					};
					this.canvasRenderDisposables.add(addDisposableListener(doneBadge, EventType.CONTEXT_MENU, openRep));
					this.canvasRenderDisposables.add(addDisposableListener(doneBadge, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(doneBadge, EventType.CLICK, openRep));
				} else if (runtime && runtime.formalFailureCount > 0) {
					const failBadge = append(empSatellite, $(`span.ade-eng-corner-status.fail-${Math.min(3, runtime.formalFailureCount)}`, {
						title: runtime.formalFailureCount >= 3
							? localize('adeEngCircuitBrokenBadgeTooltip', "Circuit Broken (Formal Failure {0}/3) — Click or right-click to inspect feedback or Reset", runtime.formalFailureCount)
							: localize('adeEngFormalFailBadgeTooltip', "Formal Failure {0}/3 (Fresh Worker retry) — Click or right-click for feedback", runtime.formalFailureCount),
					}, `F${runtime.formalFailureCount}`));
					const openRep = (e: Event) => {
						EventHelper.stop(e, true);
						this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'report' });
					};
					this.canvasRenderDisposables.add(addDisposableListener(failBadge, EventType.CONTEXT_MENU, openRep));
					this.canvasRenderDisposables.add(addDisposableListener(failBadge, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(failBadge, EventType.CLICK, openRep));
				} else if (runtime && runtime.employeeRejectCount > 0) {
					append(empSatellite, $('span.ade-eng-corner-status.rework', {
						title: localize('adeEngInternalReworkBadgeTooltip', "Employee Internal Rework {0}/3 (not a formal failure)", runtime.employeeRejectCount),
					}, `R${runtime.employeeRejectCount}`));
				} else if (empActive) {
					append(empSatellite, $('span.ade-eng-emp-verdict-chip.auditing', {}, localize('adeEngEmpAuditingChip', "Auditing")));
				} else {
					append(empSatellite, $('span.ade-eng-emp-verdict-chip', {}, localize('adeEngEmpReviewerChip', "Review")));
				}

				if (node.critical) {
					append(concentric, $('span.ade-eng-critical-badge', {
						title: localize('adeEngCriticalBadgeTooltip', "★ Critical Node — Triggers Segment Manager Secondary Review"),
					}, '★'));
				}

				// 2. INNER RECESSED CORE = Worker (L4 · Pure Native Executor) visibly enclosed inside Employee Shell!
				const innerCore = append(concentric, $(`div.ade-eng-inner-core${workerActive ? '.role-active' : ''}`, {
					title: localize(
						'adeEngWorkerCoreTooltip',
						"Inner Core — Worker · L4 (Executor): {0} — Click to open Worker chat · Right-click or click ⚙ to configure",
						formatRoleConfigCompact(node.worker, 'high'),
					),
				}));
				this.nodeAnchorsById.set(node.id, { worker: concentric, employee: empSatellite });

				const wrkTopBar = append(innerCore, $('div.ade-eng-wrk-topbar'));
				append(wrkTopBar, $('span.ade-eng-role-tag.wrk', {}, localize('adeEngWrkTierBadge', "WORKER · L4")));
				append(wrkTopBar, $('span.ade-eng-node-id-chip', {}, node.id));
				if (empActive) {
					append(wrkTopBar, $('span.ade-eng-handoff-chip', {}, localize('adeEngHandoffToEmp', "↑ Auditing")));
				} else if (workerActive) {
					append(wrkTopBar, $('span.ade-eng-handoff-chip.executing', {}, localize('adeEngWrkCodingChip', "● Coding")));
				}

				const cfgBtn = append(wrkTopBar, $('button.ade-eng-node-cfg-btn', {
					type: 'button',
					title: localize('adeEngNodeGearTooltip', "Configure Node [{0}] Roles, Spec & Reports", node.id),
				}));
				cfgBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));
				this.canvasRenderDisposables.add(addDisposableListener(cfgBtn, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
				this.canvasRenderDisposables.add(addDisposableListener(cfgBtn, EventType.CLICK, e => {
					EventHelper.stop(e, true);
					this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'worker' });
				}));

				const wrkMainRow = append(innerCore, $('div.ade-eng-wrk-main'));
				const wrkIconWell = append(wrkMainRow, $('div.ade-eng-wrk-icon-well'));
				const workerGlyph = append(wrkIconWell, $('span'));
				this.applyEngineIconToElement(workerGlyph, node.worker?.engine);

				const wrkTextCol = append(wrkMainRow, $('div.ade-eng-wrk-text'));
				const nodeTitleEl = append(wrkTextCol, $('span.ade-eng-node-title', {
					title: `[${node.id}] ${node.title}`,
				}, node.title));
				this.nodeTitleDomById.set(node.id, nodeTitleEl);
				append(wrkTextCol, $('span.ade-eng-node-sub', {
					title: `Worker: ${node.worker?.engine ?? 'claude-code'}${node.worker?.model ? ` (${node.worker.model})` : ''} · thinking=${node.worker?.thinking ?? 'high'}`,
				}, formatRoleConfigCompact(node.worker, 'high')));

				// Right-clicking directly on Outer Employee Shell Header vs Inner Worker Core targets that exact role tab!
				this.canvasRenderDisposables.add(addDisposableListener(empSatellite, EventType.CONTEXT_MENU, e => {
					EventHelper.stop(e, true);
					this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'employee', tab: 'employee' });
				}));
				this.canvasRenderDisposables.add(addDisposableListener(innerCore, EventType.CONTEXT_MENU, e => {
					EventHelper.stop(e, true);
					this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'worker' });
				}));

				// 3. POD BOTTOM TELEMETRY BAR (inside Outer Employee Shell)
				const caption = append(concentric, $('div.ade-eng-node-caption'));
				const footLeft = append(caption, $('div.ade-eng-pod-foot-left'));
				const footRight = append(caption, $('div.ade-eng-pod-foot-right'));

				const activePhaseLabelMap: Partial<Record<IAdeEngineeringNodeRuntimeState['phase'], string>> = {
					worker_running: localize('adeEngLiveWrk', "Worker"),
					employee_review: localize('adeEngLiveEmp', "Emp Audit"),
					manager_review: localize('adeEngLiveMgr', "Mgr Review"),
					manager_escalation: localize('adeEngLiveEsc', "Mgr Escalation"),
				};
				const activePhaseLabel = runtime ? activePhaseLabelMap[runtime.phase] : undefined;
				if (activePhaseLabel && runtime) {
					const startedAt = runtime.startedAt || now;
					const pill = append(footLeft, $('span.ade-eng-live-phase-pill', {
						'data-started-at': String(startedAt),
						'data-phase-label': activePhaseLabel,
					}, `${activePhaseLabel} · ${formatElapsedCompact(startedAt, now)}`));
					this.livePhasePillRefs.push({ pill, startedAt, phaseLabel: activePhaseLabel });
				} else if (isLocked) {
					const repChip = append(footLeft, $('button.ade-eng-pod-report-btn', {
						type: 'button',
						title: localize('adeEngInspectVerifiedReportTooltip', "Click to inspect Verified Report & Diff"),
					}, localize('adeEngVerifiedChipLabel', "✓ Report")));
					this.canvasRenderDisposables.add(addDisposableListener(repChip, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(repChip, EventType.CLICK, e => {
						EventHelper.stop(e, true);
						this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'report' });
					}));
				} else {
					const snippet = (node.goal?.trim() || node.acceptance?.trim() || '').replace(/\s+/g, ' ');
					append(footLeft, $('span.ade-eng-pod-goal-hint', {
						title: snippet || node.title,
					}, snippet || localize('adeEngReadyHint', "Ready")));
				}

				const touchedCount = runtime?.lastChanges?.touchedFiles.length ?? 0;
				if (touchedCount > 0) {
					const filesChip = append(footRight, $('button.ade-eng-pod-files-pill', {
						type: 'button',
						title: localize('adeEngTouchedFilesBadgeTooltip', "{0} touched file(s) — Click to view diff", touchedCount),
					}, `${touchedCount}f`));
					this.canvasRenderDisposables.add(addDisposableListener(filesChip, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(filesChip, EventType.CLICK, e => {
						EventHelper.stop(e, true);
						this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'report' });
					}));
				}

				const nodeTok = runtime?.tokenUsage?.total;
				if (nodeTok && nodeTok.totalTokens > 0) {
					const wTok = runtime?.tokenUsage?.worker.totalTokens ?? 0;
					const eTok = runtime?.tokenUsage?.employee.totalTokens ?? 0;
					const mTok = runtime?.tokenUsage?.manager.totalTokens ?? 0;
					const sumRole = Math.max(1, wTok + eTok + mTok);
					const wPct = Math.round((wTok / sumRole) * 100);
					const ePct = Math.round(((wTok + eTok) / sumRole) * 100);
					const nodeBreakdownTitle = localize(
						'adeEngNodeTokensTooltip',
						"Node [{0}] Tokens: {1} total (In {2} · Out {3} · Cache {4})\nWorker (L4): {5} · Employee (L3): {6} · Manager (L2): {7}",
						node.id,
						nodeTok.totalTokens.toLocaleString(),
						nodeTok.inputTokens.toLocaleString(),
						nodeTok.outputTokens.toLocaleString(),
						nodeTok.cacheReadTokens.toLocaleString(),
						wTok.toLocaleString(),
						eTok.toLocaleString(),
						mTok.toLocaleString(),
					);
					const tokEl = append(footRight, $('span.ade-eng-node-tokens', {
						title: nodeBreakdownTitle,
					}, `${formatCompactTokenCount(nodeTok.totalTokens)} tok`));
					tokEl.style.setProperty('--wrk-pct', `${wPct}%`);
					tokEl.style.setProperty('--emp-pct', `${ePct}%`);
				}
			}

			this.installNodeInteractions(node, nodeEl);
		}

		this.renderMinimap();
	}

	private renderEdgesOnly(): void {
		this.edgesGroupEl.replaceChildren();
		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!bp || !snap) {
			return;
		}
		const nodeById = new Map(bp.nodes.map(n => [n.id, n]));
		const runtimes = snap.state.nodes;

		for (const edge of bp.edges) {
			const src = nodeById.get(edge.from);
			const dst = nodeById.get(edge.to);
			if (!src || !dst) {
				continue;
			}
			const p1 = this.getNodePorts(src);
			const p2 = this.getNodePorts(dst);
			const d = this.buildBezierPath(p1.outX, p1.outY, p2.inX, p2.inY);
			const edgeStatus: AdeEngineeringEdgeVisualStatus = computeEdgeVisualStatus(edge, runtimes);
			const canDelete = !this.isNodeCompletedLocked(edge.to);

			const g = this.edgesGroupEl.appendChild($.SVG<SVGGElement>('g', {
				class: `ade-eng-edge-item status-${edgeStatus}${canDelete ? ' deletable' : ''}`,
				'data-edge': `${edge.from}->${edge.to}`,
				'data-edge-status': edgeStatus,
			}));

			if (edgeStatus === 'running' || edgeStatus === 'completed') {
				g.appendChild($.SVG<SVGPathElement>('path', {
					class: `ade-eng-edge-glow status-${edgeStatus}`,
					d,
				}));
			}

			g.appendChild($.SVG<SVGPathElement>('path', {
				class: `ade-eng-edge-path status-${edgeStatus}`,
				d,
				'marker-end': `url(#${this.markerId(edgeStatus)})`,
			}));

			const hitPath = g.appendChild($.SVG<SVGPathElement>('path', {
				class: 'ade-eng-edge-hit',
				d,
			}));
			if (canDelete) {
				hitPath.appendChild($.SVG<SVGTitleElement>('title')).textContent = localize(
					'adeEngEdgeDeleteHint',
					"Edge {0} → {1} (Click ×, double-click, or right-click to remove)",
					edge.from,
					edge.to,
				);
				this.canvasRenderDisposables.add(addDisposableListener(hitPath, EventType.DBLCLICK, e => {
					EventHelper.stop(e, true);
					this.removeDraftEdge(edge.from, edge.to);
				}));
				this.canvasRenderDisposables.add(addDisposableListener(hitPath, EventType.CONTEXT_MENU, e => {
					EventHelper.stop(e, true);
					this.removeDraftEdge(edge.from, edge.to);
				}));

				const midX = Math.round((p1.outX + p2.inX) / 2);
				const midY = Math.round((p1.outY + p2.inY) / 2);
				const delGroup = g.appendChild($.SVG<SVGGElement>('g', {
					class: 'ade-eng-edge-del-btn',
					transform: `translate(${midX}, ${midY})`,
				}));
				delGroup.appendChild($.SVG<SVGTitleElement>('title')).textContent = localize('adeEngRemoveEdgeBtnTitle', "Remove edge {0} → {1}", edge.from, edge.to);
				delGroup.appendChild($.SVG<SVGCircleElement>('circle', {
					r: '9.5',
					cx: '0',
					cy: '0',
				}));
				const xText = delGroup.appendChild($.SVG<SVGTextElement>('text', {
					x: '0',
					y: '3.5',
					'text-anchor': 'middle',
				}));
				xText.textContent = '×';
				this.canvasRenderDisposables.add(addDisposableListener(delGroup, EventType.CLICK, e => {
					EventHelper.stop(e, true);
					this.removeDraftEdge(edge.from, edge.to);
				}));
			}
		}
	}

	private installPortWiring(node: IAdeEngineeringBlueprintNode, outPort: HTMLElement, inPort: HTMLElement): void {
		let wiring = false;

		this.canvasRenderDisposables.add(addDisposableListener(outPort, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			EventHelper.stop(e, true);
			wiring = true;
			this.connectSourceNodeId = node.id;
			this.worldEl.classList.add('wiring-active');
			const startPorts = this.getNodePorts(node);
			this.rubberBandPathEl.style.display = '';
			this.rubberBandPathEl.setAttribute('d', this.buildBezierPath(startPorts.outX, startPorts.outY, startPorts.outX + 12, startPorts.outY));

			const win = getWindow(this.rootEl);
			const moveListener = addDisposableListener(win, EventType.POINTER_MOVE, (me: PointerEvent) => {
				if (!wiring) {
					return;
				}
				const rect = this.viewportEl.getBoundingClientRect();
				const wx = (me.clientX - rect.left - this.panX) / this.zoom;
				const wy = (me.clientY - rect.top - this.panY) / this.zoom;
				const curPorts = this.getNodePorts(node);
				this.rubberBandPathEl.setAttribute('d', this.buildBezierPath(curPorts.outX, curPorts.outY, wx, wy));
			});

			const upListener = addDisposableListener(win, EventType.POINTER_UP, (ue: PointerEvent) => {
				wiring = false;
				moveListener.dispose();
				upListener.dispose();
				this.worldEl.classList.remove('wiring-active');
				this.rubberBandPathEl.style.display = 'none';
				this.connectSourceNodeId = undefined;

				const targetEl = (ue.target as HTMLElement | null)?.closest?.('.ade-eng-node') as HTMLElement | null;
				const targetNodeId = targetEl?.getAttribute('data-node-id');
				if (targetNodeId && targetNodeId !== node.id) {
					this.tryAddDraftEdge(node.id, targetNodeId);
				}
			});
		}));

		this.canvasRenderDisposables.add(addDisposableListener(inPort, EventType.CLICK, e => {
			if (this.connectSourceNodeId && this.connectSourceNodeId !== node.id) {
				EventHelper.stop(e, true);
				const src = this.connectSourceNodeId;
				this.connectSourceNodeId = undefined;
				this.tryAddDraftEdge(src, node.id);
			}
		}));
	}

	private installNodeInteractions(node: IAdeEngineeringBlueprintNode, nodeEl: HTMLElement): void {
		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.CONTEXT_MENU, e => {
			EventHelper.stop(e, true);
			const target = e.target as HTMLElement | null;
			const isEmp = Boolean(target?.closest('.ade-eng-emp-satellite'));
			if (node.type === 'user_gate') {
				this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'gate', tab: 'task' });
			} else {
				const kind = isEmp ? 'employee' : 'worker';
				this.openPopoverForTarget({
					nodeId: node.id,
					anchorKind: kind,
					tab: kind,
				});
			}
		}));

		let dragging = false;
		let movedBeyondClickThreshold = false;
		let pushedDragUndo = false;
		let downClickedEmp = false;
		let downClientX = 0;
		let downClientY = 0;
		let origX = 0;
		let origY = 0;

		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 || this.spacePressed) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-eng-port, .ade-eng-quick-spawn-btn, .ade-eng-node-cfg-btn, .ade-eng-pod-report-btn, .ade-eng-pod-files-pill, .ade-eng-gate-inline-actions')) {
				return;
			}
			EventHelper.stop(e, false);

			if (this.connectMode) {
				if (!this.connectSourceNodeId) {
					this.connectSourceNodeId = node.id;
					this.renderCanvas();
				} else if (this.connectSourceNodeId !== node.id) {
					const src = this.connectSourceNodeId;
					this.connectSourceNodeId = undefined;
					this.tryAddDraftEdge(src, node.id);
				} else {
					this.connectSourceNodeId = undefined;
					this.renderCanvas();
				}
				return;
			}

			dragging = true;
			movedBeyondClickThreshold = false;
			pushedDragUndo = false;
			downClickedEmp = Boolean(target?.closest('.ade-eng-emp-satellite'));
			downClientX = e.clientX;
			downClientY = e.clientY;
			const liveNode = this.draftBlueprint?.nodes.find(n => n.id === node.id) ?? node;
			origX = liveNode.position?.x ?? 196;
			origY = liveNode.position?.y ?? 256;

			try {
				nodeEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic pointer event */ }
		}));

		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!dragging || !this.draftBlueprint) {
				return;
			}
			const dxScreen = e.clientX - downClientX;
			const dyScreen = e.clientY - downClientY;
			if (!movedBeyondClickThreshold && Math.hypot(dxScreen, dyScreen) < 5) {
				return;
			}
			if (!pushedDragUndo) {
				pushedDragUndo = true;
				this.pushUndoSnapshot();
				this.worldEl.classList.add('dragging-node');
				nodeEl.classList.add('dragging');
			}
			movedBeyondClickThreshold = true;
			let nextX = Math.round(origX + dxScreen / this.zoom);
			let nextY = Math.round(origY + dyScreen / this.zoom);

			// Smart Snap-to-Alignment Guides against peer nodes (within 7px threshold unless Alt is held)
			const guides: { x1: number; y1: number; x2: number; y2: number }[] = [];
			if (!e.altKey) {
				const snapThreshold = 7;
				for (const peer of this.draftBlueprint.nodes) {
					if (peer.id === node.id || !peer.position) {
						continue;
					}
					if (Math.abs(peer.position.x - nextX) <= snapThreshold) {
						nextX = peer.position.x;
						guides.push({
							x1: nextX,
							y1: Math.min(peer.position.y, nextY) - 96,
							x2: nextX,
							y2: Math.max(peer.position.y, nextY) + 96,
						});
					}
					if (Math.abs(peer.position.y - nextY) <= snapThreshold) {
						nextY = peer.position.y;
						guides.push({
							x1: Math.min(peer.position.x, nextX) - 140,
							y1: nextY,
							x2: Math.max(peer.position.x, nextX) + 140,
							y2: nextY,
						});
					}
				}
			}
			this.renderAlignmentGuides(guides);

			nodeEl.style.left = `${nextX}px`;
			nodeEl.style.top = `${nextY}px`;
			this.draftBlueprint = {
				...this.draftBlueprint,
				nodes: this.draftBlueprint.nodes.map(n => n.id === node.id ? { ...n, position: { x: nextX, y: nextY } } : n),
			};
			if (!this.isDraftDirty) {
				this.isDraftDirty = true;
				this.renderToolbar();
			} else if (this.undoBtnEl) {
				this.undoBtnEl.disabled = false;
			}
			this.updateSegmentHalosInPlace();
			this.renderEdgesOnly();
			this.renderMinimap();
			this.positionPopoverNearAnchor();
		}));

		const finishPointer = (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			dragging = false;
			this.worldEl.classList.remove('dragging-node');
			nodeEl.classList.remove('dragging');
			this.renderAlignmentGuides([]);
			try {
				nodeEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }

			if (movedBeyondClickThreshold) {
				this.renderToolbar();
				this.renderCanvas();
				this.positionPopoverNearAnchor();
				return;
			}

			const clickedTarget = e.target as HTMLElement | null;
			if (node.type === 'task' && this.activeGovernorId) {
				const clickedEmp = downClickedEmp || Boolean(clickedTarget?.closest('.ade-eng-emp-satellite'));
				void this.engineering.ensureNodeAgentSessionOpen(
					this.activeGovernorId,
					node.id,
					clickedEmp ? 'employee' : 'worker',
				).catch(err => {
					this.notificationService.error(err instanceof Error ? err.message : String(err));
				});
			} else if (node.type === 'user_gate') {
				this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'gate', tab: 'task' });
			}
		};

		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_UP, finishPointer));
		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, 'pointercancel', () => {
			dragging = false;
			this.worldEl.classList.remove('dragging-node');
			nodeEl.classList.remove('dragging');
			this.renderAlignmentGuides([]);
		}));
	}

	// =========================================================================
	// Anchored Floating Engine & Node Option Popover (Right-Click / Gear Menu)
	// =========================================================================

	private renderPopover(): void {
		this.popoverRenderDisposables.clear();
		clearNode(this.popoverContentEl);
		this.popoverTokensCardEl = undefined;
		this.popoverTelemetryEl = undefined;

		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		const nodeId = this.activePopoverNodeId;
		if (!bp || !snap || !nodeId) {
			return;
		}
		const draftNode = bp.nodes.find(n => n.id === nodeId);
		if (!draftNode) {
			return;
		}

		const runtime = snap.state.nodes[nodeId];
		const isLocked = Boolean(runtime?.completed);
		const visualStatus = computeNodeVisualStatus(draftNode, runtime);
		const seg = (this.activePopoverSegmentId ? bp.managers.find(m => m.segmentId === this.activePopoverSegmentId) : undefined)
			?? bp.managers.find(m => m.nodeIds.includes(nodeId));

		const updateNodeDraft = (
			patch: Partial<IAdeEngineeringBlueprintNode>,
			options?: { readonly skipPopoverRebuild?: boolean; readonly skipCanvasRebuild?: boolean; readonly coalesceKey?: string },
		) => {
			if (!this.draftBlueprint || isLocked) {
				return;
			}
			this.markDraftModified({
				...this.draftBlueprint,
				nodes: this.draftBlueprint.nodes.map(n => n.id === draftNode.id ? { ...n, ...patch } : n),
			}, options);
		};

		// 1. Sleek Compact Header Row: [ID] + Inline Editable Title + ★ Critical + Delete/Locked + Close
		const header = append(this.popoverContentEl, $('.ade-eng-pop-header'));
		append(header, $(`span.ade-eng-pop-id.status-${visualStatus}`, {}, draftNode.id));

		const titleInput = append(header, $('input.ade-eng-pop-title-input.ade-eng-input', {
			type: 'text',
			value: draftNode.title,
			title: draftNode.title,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLInputElement;
		const applyLiveTitle = () => {
			const trimmed = titleInput.value.trim();
			if (!trimmed) {
				return;
			}
			const titleDom = this.nodeTitleDomById.get(draftNode.id);
			if (titleDom) {
				titleDom.textContent = trimmed;
				titleDom.title = `[${draftNode.id}] ${trimmed}`;
			}
			updateNodeDraft(
				{ title: trimmed },
				{ skipPopoverRebuild: true, skipCanvasRebuild: Boolean(titleDom), coalesceKey: `title:${draftNode.id}` },
			);
		};
		this.popoverRenderDisposables.add(addDisposableListener(titleInput, EventType.INPUT, applyLiveTitle));
		this.popoverRenderDisposables.add(addDisposableListener(titleInput, EventType.CHANGE, () => {
			const trimmed = titleInput.value.trim();
			if (trimmed) {
				updateNodeDraft({ title: trimmed }, { skipPopoverRebuild: true, coalesceKey: `title:${draftNode.id}` });
			}
		}));

		if (draftNode.type === 'task') {
			const critBtn = append(header, $(`button.ade-eng-pop-icon-btn.crit${draftNode.critical ? '.active' : ''}`, {
				type: 'button',
				title: localize('adeEngToggleCritTooltip', "Toggle ★ Critical Gate (triggers Segment Manager secondary review)"),
				...(isLocked ? { disabled: 'disabled' } : {}),
			}, '★'));
			this.popoverRenderDisposables.add(addDisposableListener(critBtn, EventType.CLICK, () => {
				if (!isLocked) {
					updateNodeDraft({ critical: !draftNode.critical });
				}
			}));
		}

		if (!isLocked) {
			const delBtn = append(header, $('button.ade-eng-pop-icon-btn.danger', {
				type: 'button',
				title: localize('adeEngDeleteNodeTooltip', "Delete Node (Delete / Backspace)"),
			}));
			delBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.trash));
			this.popoverRenderDisposables.add(addDisposableListener(delBtn, EventType.CLICK, () => {
				this.deleteDraftNode(draftNode.id);
			}));
		} else {
			append(header, $('span.ade-eng-lock-pill', {}, localize('adeEngLockedShort', "Locked")));
		}

		const closeBtn = append(header, $('button.ade-eng-pop-icon-btn.close', {
			type: 'button',
			title: localize('adeEngClosePopoverTooltip', "Close (Esc)"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.popoverRenderDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.closePopover();
		}));

		// 2. User Gate Popover
		if (draftNode.type === 'user_gate') {
			this.renderGatePopoverBody(draftNode, runtime, isLocked, updateNodeDraft);
			this.positionPopoverNearAnchor();
			return;
		}

		// 3. Task Node Segmented Role Option Switcher (Color-coded per architectural layer!)
		const ownReport = snap.state.reports[draftNode.id];
		const hasReportOrFeedback = Boolean(
			ownReport
			|| (runtime?.lastChanges && runtime.lastChanges.touchedFiles.length > 0)
			|| runtime?.lastEmployeeFeedback
			|| runtime?.lastManagerFeedback
			|| runtime?.lastGateFeedback
			|| (runtime && (runtime.formalFailureCount > 0 || runtime.completed)),
		);
		const segBar = append(this.popoverContentEl, $('.ade-eng-pop-role-tabs', { role: 'tablist' }));
		const tabs: { readonly id: PopoverTabKind; readonly label: string; readonly dot?: boolean }[] = [
			{ id: 'worker', label: localize('adeEngPopTabWorker', "Worker") },
			{ id: 'employee', label: localize('adeEngPopTabEmployee', "Employee") },
			...(seg ? [{ id: 'manager' as const, label: `Mgr [${seg.segmentId}]` }] : []),
			{ id: 'task', label: localize('adeEngPopTabTask', "Spec") },
			{ id: 'report', label: localize('adeEngPopTabReport', "Report"), dot: hasReportOrFeedback },
		];
		for (const t of tabs) {
			const isActive = this.activePopoverTab === t.id;
			const btn = append(segBar, $(`button.ade-eng-pop-role-tab.tab-${t.id}${isActive ? '.active' : ''}${t.dot ? '.has-dot' : ''}`, {
				type: 'button',
				role: 'tab',
				'aria-selected': String(isActive),
				title: t.label,
			}, t.label));
			if (t.dot) {
				append(btn, $('span.ade-eng-tab-dot'));
			}
			this.popoverRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.activePopoverTab = t.id;
				this.renderPopover();
			}));
		}

		if (this.activePopoverTab === 'report') {
			this.renderNodeReportPopoverBody(draftNode, runtime);
		} else if (this.activePopoverTab === 'task') {
			this.renderTaskSpecPopoverBody(draftNode, runtime, isLocked, updateNodeDraft);
		} else if (this.activePopoverTab === 'manager' && seg) {
			this.renderEngineOptionListBody({
				roleBadge: 'L2 · SEGMENT',
				roleClass: 'mgr',
				roleTitle: localize('adeEngMgrRoleSubtitle', "Segment Manager [{0}]", seg.segmentId),
				current: seg.config,
				disabled: false,
				onOpenSession: (side) => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, draftNode.id, 'manager', side ? { side: true } : undefined).catch(err => {
							this.notificationService.error(err instanceof Error ? err.message : String(err));
						});
					}
				},
				onChange: (next, opts) => {
					if (!this.draftBlueprint) {
						return;
					}
					this.markDraftModified({
						...this.draftBlueprint,
						managers: this.draftBlueprint.managers.map(m => m.segmentId === seg.segmentId ? { ...m, config: next } : m),
					}, opts);
				},
				runtime,
			});
		} else if (this.activePopoverTab === 'employee') {
			this.renderEngineOptionListBody({
				roleBadge: 'OUTER · L3',
				roleClass: 'emp',
				roleTitle: localize('adeEngEmpRoleSubtitle', "Outer Shell · Acceptance Reviewer"),
				current: draftNode.employee ?? { engine: 'claude-code', thinking: 'medium' },
				disabled: isLocked,
				onOpenSession: (side) => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, draftNode.id, 'employee', side ? { side: true } : undefined).catch(err => {
							this.notificationService.error(err instanceof Error ? err.message : String(err));
						});
					}
				},
				onChange: (next, opts) => updateNodeDraft({ employee: next }, opts),
				runtime,
			});
		} else {
			this.renderEngineOptionListBody({
				roleBadge: 'INNER · L4',
				roleClass: 'wrk',
				roleTitle: localize('adeEngWrkRoleSubtitle', "Inner Core · Pure Native Executor"),
				current: draftNode.worker ?? { engine: 'claude-code', thinking: 'high' },
				disabled: isLocked,
				onOpenSession: (side) => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, draftNode.id, 'worker', side ? { side: true } : undefined).catch(err => {
							this.notificationService.error(err instanceof Error ? err.message : String(err));
						});
					}
				},
				onChange: (next, opts) => updateNodeDraft({ worker: next }, opts),
				runtime,
			});
		}

		this.positionPopoverNearAnchor();
	}

	private renderEngineOptionListBody(params: {
		readonly roleBadge: string;
		readonly roleClass: 'wrk' | 'emp' | 'mgr';
		readonly roleTitle: string;
		readonly current: { readonly engine: string; readonly model?: string; readonly thinking: AdeThinkingLevel };
		readonly disabled: boolean;
		readonly onOpenSession: (side?: boolean) => void;
		readonly onChange: (next: { engine: string; model?: string; thinking: AdeThinkingLevel }, options?: { readonly skipPopoverRebuild?: boolean; readonly coalesceKey?: string }) => void;
		readonly runtime: IAdeEngineeringNodeRuntimeState | undefined;
	}): void {
		const normEngine = normalizeBlueprintEngine(params.current.engine);
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body'));

		// Role Banner + Open Chat / Open Split Actions
		const subRow = append(body, $(`div.ade-eng-pop-subrow.role-${params.roleClass}`));
		const roleMeta = append(subRow, $('div.ade-eng-pop-role-meta'));
		append(roleMeta, $(`span.ade-eng-role-tag.${params.roleClass}`, {}, params.roleBadge));
		append(roleMeta, $('span.ade-eng-pop-role-desc', {}, params.roleTitle));

		const chatBtns = append(subRow, $('div.ade-eng-pop-chat-btns'));
		const openBtn = append(chatBtns, $('button.ade-eng-pop-open-link', {
			type: 'button',
			title: localize('adeEngOpenRoleChatTooltip', "Open this role's session"),
		}, localize('adeEngOpenRoleChat', "Open Session ↗")));
		this.popoverRenderDisposables.add(addDisposableListener(openBtn, EventType.CLICK, () => params.onOpenSession(false)));

		const splitBtn = append(chatBtns, $('button.ade-eng-pop-open-link.split', {
			type: 'button',
			title: localize('adeEngOpenRoleSplitTooltip', "Open session side-by-side next to Engineering DAG"),
		}, '◫'));
		this.popoverRenderDisposables.add(addDisposableListener(splitBtn, EventType.CLICK, () => params.onOpenSession(true)));

		// 1. Direct Visual Engine Option Grid (2-column compact option list with real engine icons!)
		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngPopEngineLabel', "Engine")));
		const engineGrid = append(body, $('.ade-eng-engine-grid'));
		for (const opt of ENGINE_OPTIONS) {
			const isSelected = opt.value === normEngine;
			const itemBtn = append(engineGrid, $(`button.ade-eng-engine-opt${isSelected ? '.selected' : ''}`, {
				type: 'button',
				title: opt.label,
				...(params.disabled ? { disabled: 'disabled' } : {}),
			}));
			const glyph = append(itemBtn, $('span'));
			this.applyEngineIconToElement(glyph, opt.value);
			append(itemBtn, $('span.ade-eng-engine-opt-name', {}, opt.shortLabel));
			if (isSelected) {
				const check = append(itemBtn, $('span.ade-eng-engine-opt-check'));
				check.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
			}
			this.popoverRenderDisposables.add(addDisposableListener(itemBtn, EventType.CLICK, () => {
				if (!params.disabled && opt.value !== normEngine) {
					params.onChange({
						engine: opt.value,
						thinking: params.current.thinking,
					});
				}
			}));
		}

		// 2. Thinking Effort Segmented Pill Bar (Off | Low | Med | High | Max)
		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngPopThinkingLabel', "Thinking Effort")));
		const thinkBar = append(body, $('.ade-eng-thinking-bar'));
		for (const opt of THINKING_OPTIONS) {
			const active = opt.value === params.current.thinking;
			const tBtn = append(thinkBar, $(`button.ade-eng-think-opt${active ? '.selected' : ''}`, {
				type: 'button',
				...(params.disabled ? { disabled: 'disabled' } : {}),
			}, opt.label));
			this.popoverRenderDisposables.add(addDisposableListener(tBtn, EventType.CLICK, () => {
				if (!params.disabled && opt.value !== params.current.thinking) {
					params.onChange({
						engine: normEngine,
						...(params.current.model ? { model: params.current.model } : {}),
						thinking: normalizeThinkingLevel(opt.value, params.current.thinking),
					});
				}
			}));
		}

		// 3. Model Quick-Select Option Chips + Compact Custom Input
		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngPopModelLabel', "Model")));
		const configuredModels = this.configuredModelsByEngine[normEngine] ?? [];
		if (configuredModels.length > 0) {
			const chipsRow = append(body, $('.ade-eng-model-chips'));
			const autoChip = append(chipsRow, $(`button.ade-eng-model-chip${!params.current.model ? '.selected' : ''}`, {
				type: 'button',
				...(params.disabled ? { disabled: 'disabled' } : {}),
			}, localize('adeEngModelAuto', "Default")));
			this.popoverRenderDisposables.add(addDisposableListener(autoChip, EventType.CLICK, () => {
				if (!params.disabled && params.current.model) {
					params.onChange({ engine: normEngine, thinking: params.current.thinking });
				}
			}));
			for (const m of configuredModels) {
				const active = params.current.model === m.id;
				const mChip = append(chipsRow, $(`button.ade-eng-model-chip${active ? '.selected' : ''}`, {
					type: 'button',
					title: m.label,
					...(params.disabled ? { disabled: 'disabled' } : {}),
				}, m.id));
				this.popoverRenderDisposables.add(addDisposableListener(mChip, EventType.CLICK, () => {
					if (!params.disabled && params.current.model !== m.id) {
						params.onChange({ engine: normEngine, model: m.id, thinking: params.current.thinking });
					}
				}));
			}
		}

		const listId = `ade-eng-models-${this.nextDatalistId++}`;
		const modelInput = append(body, $('input.ade-eng-pop-model-input', {
			type: 'text',
			list: listId,
			placeholder: localize('adeEngModelCompactPlaceholder', "Default model (or enter e.g. deepseek-flash[1m])"),
			value: params.current.model ?? '',
			...(params.disabled ? { disabled: 'disabled' } : {}),
		})) as HTMLInputElement;
		const datalistEl = append(body, $('datalist', { id: listId }));
		for (const m of configuredModels) {
			append(datalistEl, $('option', { value: m.id }, m.label));
		}
		const commitModelChange = () => {
			if (!params.disabled) {
				params.onChange({
					engine: normEngine,
					...(modelInput.value.trim() ? { model: modelInput.value.trim() } : {}),
					thinking: params.current.thinking,
				}, { skipPopoverRebuild: true, coalesceKey: `model:${this.activePopoverNodeId}:${params.roleClass}` });
			}
		};
		this.popoverRenderDisposables.add(addDisposableListener(modelInput, EventType.INPUT, commitModelChange));
		this.popoverRenderDisposables.add(addDisposableListener(modelInput, EventType.CHANGE, commitModelChange));

		// 3b. 1-Click Batch Preset across all unlocked Workers, Employees & Manager segments!
		if (!params.disabled) {
			const batchBtn = append(body, $('button.ade-eng-batch-apply-btn', {
				type: 'button',
				title: localize('adeEngBatchApplyTooltip', "Apply this Engine, Model & Thinking Effort across all unlocked Workers, Employees, and Managers in the Blueprint"),
			}));
			const boltIco = append(batchBtn, $('span'));
			boltIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
			append(batchBtn, $('span', {}, localize('adeEngBatchApplyLabel', "Apply to All Unlocked Roles")));
			this.popoverRenderDisposables.add(addDisposableListener(batchBtn, EventType.CLICK, () => {
				const liveModel = modelInput.value.trim();
				this.applyRolePresetToAllUnlocked({
					engine: normEngine,
					...(liveModel ? { model: liveModel } : {}),
					thinking: params.current.thinking,
				});
			}));
		}

		// 4. Compact Runtime Telemetry & Token Consumption Card at Footer
		if (params.runtime) {
			this.popoverTokensCardEl = this.renderNodeTokenUsageCard(body, params.runtime);
			this.popoverTelemetryEl = append(
				body,
				$('div.ade-eng-pop-telemetry', {}, `Phase: ${params.runtime.phase} · Rework ${params.runtime.employeeRejectCount}/3 · Fail ${params.runtime.formalFailureCount}/3`),
			);
		}
	}

	private renderNodeTokenUsageCard(parent: HTMLElement, runtime: IAdeEngineeringNodeRuntimeState): HTMLElement {
		const usage = runtime.tokenUsage;
		const total: IAdeTokenUsage | undefined = usage?.total;
		const totalTok = total?.totalTokens ?? 0;
		const card = append(parent, $(`div.ade-eng-pop-tokens-card${totalTok > 0 ? '.has-usage' : ''}`));
		if (this.popoverContentEl.contains(parent)) {
			this.popoverTokensCardEl = card;
		}
		const topRow = append(card, $('div.ade-eng-pop-tokens-head'));
		append(topRow, $('span.ade-eng-pop-tokens-label', {}, localize('adeEngPopTokensHeader', "TOKEN CONSUMPTION")));
		append(
			topRow,
			$('span.ade-eng-pop-tokens-total', {}, `${totalTok.toLocaleString()} tok${total?.turns ? ` · ${total.turns}t` : ''}`),
		);

		if (total && totalTok > 0) {
			append(
				card,
				$('div.ade-eng-pop-tokens-io', {}, `In ${formatCompactTokenCount(total.inputTokens)} · Out ${formatCompactTokenCount(total.outputTokens)}${total.cacheReadTokens > 0 ? ` · Cache ${formatCompactTokenCount(total.cacheReadTokens)}` : ''}`),
			);
			const rolesRow = append(card, $('div.ade-eng-pop-tokens-roles'));
			append(rolesRow, $('span.ade-eng-pop-role-tok.wrk', {}, `W: ${formatCompactTokenCount(usage?.worker.totalTokens ?? 0)}`));
			append(rolesRow, $('span.ade-eng-pop-role-tok.emp', {}, `E: ${formatCompactTokenCount(usage?.employee.totalTokens ?? 0)}`));
			append(rolesRow, $('span.ade-eng-pop-role-tok.mgr', {}, `M: ${formatCompactTokenCount(usage?.manager.totalTokens ?? 0)}`));
		}
		return card;
	}

	private renderDownstreamEdgesSection(body: HTMLElement, node: IAdeEngineeringBlueprintNode): void {
		if (!this.draftBlueprint) {
			return;
		}
		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngDownstreamShortLabel', "Downstream Edges")));
		const outgoing = this.draftBlueprint.edges.filter(e => e.from === node.id);
		if (outgoing.length > 0) {
			const chipsWrap = append(body, $('.ade-eng-edge-chips'));
			for (const edge of outgoing) {
				const chip = append(chipsWrap, $('span.ade-eng-edge-chip', {}, `→ ${edge.to}`));
				if (!this.isNodeCompletedLocked(edge.to)) {
					const rmBtn = append(chip, $('button.ade-eng-chip-rm', { type: 'button', title: localize('adeEngRemoveEdge', "Remove Edge") }, '×'));
					this.popoverRenderDisposables.add(addDisposableListener(rmBtn, EventType.CLICK, () => {
						this.removeDraftEdge(edge.from, edge.to);
					}));
				}
			}
		}
		const candidates = this.draftBlueprint.nodes.filter(
			cand => cand.id !== node.id
				&& !this.isNodeCompletedLocked(cand.id)
				&& !outgoing.some(e => e.to === cand.id),
		);
		if (candidates.length > 0) {
			const addRow = append(body, $('.ade-eng-form-row'));
			const targetSelect = append(addRow, $('select.ade-eng-select')) as HTMLSelectElement;
			for (const cand of candidates) {
				append(targetSelect, $('option', { value: cand.id }, `[${cand.id}] ${cand.title}`));
			}
			const addEdgeBtn = append(addRow, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
			}, localize('adeEngConnectTargetBtn', "+ Connect")));
			this.popoverRenderDisposables.add(addDisposableListener(addEdgeBtn, EventType.CLICK, () => {
				if (targetSelect.value) {
					this.tryAddDraftEdge(node.id, targetSelect.value);
				}
			}));
		}
	}

	private renderTaskSpecPopoverBody(
		node: IAdeEngineeringBlueprintNode,
		runtime: IAdeEngineeringNodeRuntimeState | undefined,
		isLocked: boolean,
		updateNodeDraft: (patch: Partial<IAdeEngineeringBlueprintNode>, options?: { readonly skipPopoverRebuild?: boolean; readonly coalesceKey?: string }) => void,
	): void {
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body.scrollable'));
		if (isLocked) {
			append(body, $('div.ade-eng-lock-banner', {}, localize('adeEngCompletedLockNotice', "Completed & locked — task prompt and incoming edges are immutable.")));
		}

		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngGoalShortLabel', "Worker Task Goal (L4)")));
		const goalArea = append(body, $('textarea.ade-eng-textarea', {
			rows: 3,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLTextAreaElement;
		goalArea.value = node.goal ?? '';
		const commitGoal = () => updateNodeDraft({ goal: goalArea.value }, { skipPopoverRebuild: true, coalesceKey: `goal:${node.id}` });
		this.popoverRenderDisposables.add(addDisposableListener(goalArea, EventType.INPUT, commitGoal));
		this.popoverRenderDisposables.add(addDisposableListener(goalArea, EventType.CHANGE, commitGoal));

		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngAccShortLabel', "Employee Acceptance Criteria (L3)")));
		const accArea = append(body, $('textarea.ade-eng-textarea', {
			rows: 2,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLTextAreaElement;
		accArea.value = node.acceptance ?? '';
		const commitAcc = () => updateNodeDraft({ acceptance: accArea.value }, { skipPopoverRebuild: true, coalesceKey: `acc:${node.id}` });
		this.popoverRenderDisposables.add(addDisposableListener(accArea, EventType.INPUT, commitAcc));
		this.popoverRenderDisposables.add(addDisposableListener(accArea, EventType.CHANGE, commitAcc));

		this.renderDownstreamEdgesSection(body, node);

		if (runtime) {
			this.renderNodeTokenUsageCard(body, runtime);
		}
	}

	private renderNodeReportPopoverBody(
		node: IAdeEngineeringBlueprintNode,
		runtime: IAdeEngineeringNodeRuntimeState | undefined,
	): void {
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body.scrollable'));
		const snap = this.snapshot;
		const ownReport = snap?.state.reports[node.id];

		const canResetNode = Boolean(
			this.activeGovernorId
			&& runtime
			&& (runtime.completed || runtime.formalFailureCount > 0 || runtime.employeeRejectCount > 0 || runtime.phase !== 'idle'),
		);
		if (canResetNode && this.activeGovernorId) {
			const govId = this.activeGovernorId;
			const resetRow = append(body, $('.ade-eng-pop-subrow'));
			append(resetRow, $('span.ade-eng-pop-role-desc', {}, runtime?.completed
				? localize('adeEngReportCompletedStatus', "Completed & Verified")
				: `Phase: ${runtime?.phase ?? 'idle'}`));
			const resetNodeBtn = append(resetRow, $('button.ade-eng-pop-reset-node-btn', {
				type: 'button',
				title: localize('adeEngResetSingleNodeTooltip', "Unlock and reset [{0}] (+ downstream dependents) so it can be edited or re-run", node.id),
			}, localize('adeEngResetSingleNodeBtn', "↺ Reset Node")));
			this.popoverRenderDisposables.add(addDisposableListener(resetNodeBtn, EventType.CLICK, () => {
				void this.engineering.resetTree({ governorSessionId: govId, nodeId: node.id }).catch(err => {
					this.notificationService.error(err instanceof Error ? err.message : String(err));
				});
			}));
		}

		if (ownReport) {
			const repHead = append(body, $('.ade-eng-pop-subrow'));
			append(repHead, $('div.ade-eng-pop-section-label', {}, ownReport.stale
				? localize('adeEngNodeReportStaleLabel', "Previous Report (Stale)")
				: localize('adeEngNodeReportShort', "Verified Report")));
			const copyBtn = append(repHead, $('button.ade-eng-pop-open-link', {
				type: 'button',
			}, localize('adeEngCopyReportBtn', "Copy")));
			this.popoverRenderDisposables.add(addDisposableListener(copyBtn, EventType.CLICK, () => {
				void getWindow(this.rootEl).navigator.clipboard?.writeText(ownReport.summary);
				copyBtn.textContent = localize('adeEngCopiedShort', "Copied ✓");
				const win = getWindow(this.rootEl);
				win.setTimeout(() => {
					if (copyBtn.isConnected) {
						copyBtn.textContent = localize('adeEngCopyReportBtn', "Copy");
					}
				}, 1800);
			}));
			append(body, $(`div.ade-eng-report-card${ownReport.stale ? '.stale' : ''}`, {}, ownReport.summary));
		}

		if (runtime?.lastGateFeedback) {
			append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngLastGateFbLabel', "User Gate Rollback Instructions")));
			append(body, $('div.ade-eng-feedback-card.warn', {}, runtime.lastGateFeedback));
		}
		if (runtime?.lastManagerFeedback) {
			append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngLastMgrFbLabel', "Manager Feedback")));
			append(body, $('div.ade-eng-feedback-card.error', {}, runtime.lastManagerFeedback));
		}
		if (runtime?.lastEmployeeFeedback) {
			append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngLastEmpFbLabel', "Employee Review Feedback")));
			append(body, $('div.ade-eng-feedback-card.warn', {}, runtime.lastEmployeeFeedback));
		}

		if (runtime?.lastChanges && runtime.lastChanges.touchedFiles.length > 0) {
			const headRow = append(body, $('.ade-eng-pop-subrow'));
			append(headRow, $('div.ade-eng-pop-section-label', {}, localize('adeEngTouchedShort', "Touched Files ({0})", runtime.lastChanges.touchedFiles.length)));
			const previewKey = `${this.activeGovernorId ?? ''}:${node.id}`;
			const isDiffOpen = this.expandedDiffFiles.has(previewKey);
			const diffToggleBtn = append(headRow, $('button.ade-eng-pop-open-link', {
				type: 'button',
			}, isDiffOpen ? localize('adeEngHideDiffBtn', "Hide Diff") : localize('adeEngShowDiffBtn', "View Diff")));

			const filesWrap = append(body, $('.ade-eng-files-list'));
			const govAgent = this.activeGovernorId ? this.projects.getAgent(this.activeGovernorId) : undefined;
			for (const f of runtime.lastChanges.touchedFiles) {
				const fileBtn = append(filesWrap, $(`button.ade-eng-file-pill.kind-${f.kind}`, {
					type: 'button',
					title: localize('adeEngOpenFileTooltip', "Click to open {0} in editor", f.relativePath),
				}));
				append(fileBtn, $('span.ade-eng-file-kind', {}, f.kind[0].toUpperCase()));
				append(fileBtn, $('span.ade-eng-file-path', {}, f.relativePath));
				this.popoverRenderDisposables.add(addDisposableListener(fileBtn, EventType.CLICK, () => {
					if (govAgent) {
						void this.commandService.executeCommand('vscode.open', URI.joinPath(govAgent.projectUri, f.relativePath));
					}
				}));
			}

			const diffHolder = append(body, $('.ade-eng-inline-diff-holder'));
			const lastChanges = runtime.lastChanges;
			const renderDiffIntoHolder = () => {
				clearNode(diffHolder);
				if (!this.expandedDiffFiles.has(previewKey)) {
					return;
				}
				const diffText = lastChanges.combinedDiff?.trim()
					|| lastChanges.touchedFiles.map(tf => tf.diff?.trim()).filter(Boolean).join('\n\n')
					|| localize('adeEngEmptyDiff', "(No textual diff available)");
				const pre = append(diffHolder, $('pre.ade-eng-inline-diff'));
				for (const line of diffText.split('\n')) {
					const cls = line.startsWith('+') && !line.startsWith('+++')
						? 'add'
						: line.startsWith('-') && !line.startsWith('---')
							? 'del'
							: line.startsWith('@@')
								? 'hunk'
								: 'ctx';
					append(pre, $(`span.ade-eng-diff-line.${cls}`, {}, `${line}\n`));
				}
			};
			this.popoverRenderDisposables.add(addDisposableListener(diffToggleBtn, EventType.CLICK, () => {
				if (this.expandedDiffFiles.has(previewKey)) {
					this.expandedDiffFiles.delete(previewKey);
					diffToggleBtn.textContent = localize('adeEngShowDiffBtn', "View Diff");
					clearNode(diffHolder);
				} else {
					this.expandedDiffFiles.add(previewKey);
					diffToggleBtn.textContent = localize('adeEngHideDiffBtn', "Hide Diff");
					renderDiffIntoHolder();
				}
			}));
			if (isDiffOpen) {
				renderDiffIntoHolder();
			}
		}

		if (!ownReport && !runtime?.lastChanges?.touchedFiles.length && !runtime?.lastEmployeeFeedback && !runtime?.lastManagerFeedback && !runtime?.lastGateFeedback) {
			append(body, $('div.ade-eng-empty-hint', {}, localize('adeEngNoReportYet', "No report or workspace diff recorded for this node yet.")));
		}

		if (runtime) {
			this.renderNodeTokenUsageCard(body, runtime);
		}
	}

	private renderGatePopoverBody(
		node: IAdeEngineeringBlueprintNode,
		runtime: IAdeEngineeringNodeRuntimeState | undefined,
		isLocked: boolean,
		updateNodeDraft: (patch: Partial<IAdeEngineeringBlueprintNode>, options?: { readonly skipPopoverRebuild?: boolean; readonly coalesceKey?: string }) => void,
	): void {
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body.scrollable'));
		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngGateDescShort', "Gate Inspection Instructions")));
		const descArea = append(body, $('textarea.ade-eng-textarea', {
			rows: 2,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLTextAreaElement;
		descArea.value = node.description ?? '';
		const commitDesc = () => updateNodeDraft({ description: descArea.value }, { skipPopoverRebuild: true, coalesceKey: `desc:${node.id}` });
		this.popoverRenderDisposables.add(addDisposableListener(descArea, EventType.INPUT, commitDesc));
		this.popoverRenderDisposables.add(addDisposableListener(descArea, EventType.CHANGE, commitDesc));

		this.renderDownstreamEdgesSection(body, node);

		if (this.draftBlueprint && this.snapshot) {
			const upstreamChain = buildUpstreamReportChain(node.id, this.draftBlueprint, this.snapshot.state.reports);
			if (upstreamChain.length > 0) {
				append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngGateUpstreamReports', "Upstream Verified Reports ({0})", upstreamChain.length)));
				const chainWrap = append(body, $('.ade-eng-gate-reports'));
				for (const r of upstreamChain) {
					const rCard = append(chainWrap, $('.ade-eng-report-card.compact'));
					append(rCard, $('div.ade-eng-report-card-title', {}, `[${r.nodeId}] ${r.nodeTitle}`));
					append(rCard, $('div.ade-eng-report-card-text', {}, r.summary));
				}
			}
		}

		if (runtime?.phase === 'waiting_user_gate' && this.activeGovernorId && this.draftBlueprint) {
			const govId = this.activeGovernorId;
			const decisionWrap = append(body, $('.ade-eng-gate-pop-actions'));
			const approveBtn = append(decisionWrap, $('button.ade-eng-action-btn.run.full-width', {
				type: 'button',
				...(this.gateSubmitting ? { disabled: 'disabled' } : {}),
			}, localize('adeEngApproveGatePopBtn', "✓ Approve & Continue Downstream"))) as HTMLButtonElement;
			this.popoverRenderDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, async () => {
				if (this.gateSubmitting) {
					return;
				}
				this.gateSubmitting = true;
				approveBtn.disabled = true;
				try {
					await this.engineering.submitGateVerdict({
						governorSessionId: govId,
						nodeId: node.id,
						verdict: 'pass',
					});
					this.closePopover();
				} catch (err) {
					this.notificationService.error(err instanceof Error ? err.message : String(err));
				} finally {
					this.gateSubmitting = false;
				}
			}));

			const candidates = listUpstreamTaskAncestors(node.id, this.draftBlueprint);
			if (candidates.length > 0) {
				const rbRow = append(decisionWrap, $('.ade-eng-form-row'));
				const targetSelect = append(rbRow, $('select.ade-eng-select')) as HTMLSelectElement;
				for (const c of candidates) {
					append(targetSelect, $('option', { value: c.id }, `↩ [${c.id}] ${c.title}`));
				}
				targetSelect.value = candidates[candidates.length - 1].id;

				const rbBtn = append(rbRow, $('button.ade-eng-action-btn.danger', {
					type: 'button',
					...(this.gateSubmitting ? { disabled: 'disabled' } : {}),
				}, localize('adeEngRollbackShortBtn', "Rollback"))) as HTMLButtonElement;
				const fbInput = append(decisionWrap, $('textarea.ade-eng-textarea', {
					rows: 2,
					placeholder: localize('adeEngRollbackReasonPh', "Revision instructions for target Worker..."),
				})) as HTMLTextAreaElement;
				this.popoverRenderDisposables.add(addDisposableListener(rbBtn, EventType.CLICK, async () => {
					if (this.gateSubmitting) {
						return;
					}
					this.gateSubmitting = true;
					rbBtn.disabled = true;
					try {
						await this.engineering.submitGateVerdict({
							governorSessionId: govId,
							nodeId: node.id,
							verdict: 'rollback',
							targetNodeId: targetSelect.value,
							feedback: fbInput.value.trim() || undefined,
						});
						this.closePopover();
					} catch (err) {
						this.notificationService.error(err instanceof Error ? err.message : String(err));
					} finally {
						this.gateSubmitting = false;
					}
				}));
			}
		}
	}

	// =========================================================================
	// Floating Blueprint Markdown & Filterable Live Timeline Sheet
	// =========================================================================

	private matchesEventFilter(ev: IAdeEngineeringEventLogEntry): boolean {
		if (this.activeEventFilter === 'all') {
			return true;
		}
		const kind = ev.event.toLowerCase();
		if (this.activeEventFilter === 'worker') {
			return kind.includes('worker');
		}
		if (this.activeEventFilter === 'employee') {
			return kind.includes('employee') || kind.includes('node_passed');
		}
		if (this.activeEventFilter === 'manager') {
			return kind.includes('manager') || kind.includes('segment');
		}
		return kind.includes('gate') || kind.includes('fail') || kind.includes('circuit') || kind.includes('watchdog') || ev.level !== 'info';
	}

	private renderSheet(): void {
		this.sheetRenderDisposables.clear();
		clearNode(this.sheetContentEl);
		this.sheetEventsBodyEl = undefined;
		if (!this.activeSheetTab || !this.snapshot) {
			return;
		}
		const snap = this.snapshot;

		const head = append(this.sheetContentEl, $('.ade-eng-sheet-header'));
		const tabsWrap = append(head, $('.ade-eng-sheet-tabs'));
		const bpTabBtn = append(tabsWrap, $(`button.ade-eng-sheet-tab${this.activeSheetTab === 'blueprint' ? '.active' : ''}`, {
			type: 'button',
		}, localize('adeEngSheetBlueprintTab', "Blueprint Markdown")));
		const evTabBtn = append(tabsWrap, $(`button.ade-eng-sheet-tab${this.activeSheetTab === 'events' ? '.active' : ''}`, {
			type: 'button',
		}, localize('adeEngSheetEventsTab', "Execution Logs ({0})", snap.state.events.length)));

		this.sheetRenderDisposables.add(addDisposableListener(bpTabBtn, EventType.CLICK, () => {
			this.activeSheetTab = 'blueprint';
			this.renderToolbar();
			this.renderSheet();
		}));
		this.sheetRenderDisposables.add(addDisposableListener(evTabBtn, EventType.CLICK, () => {
			this.activeSheetTab = 'events';
			this.renderToolbar();
			this.renderSheet();
		}));

		const closeBtn = append(head, $('button.ade-eng-pop-icon-btn.close', {
			type: 'button',
			title: localize('adeEngCloseSheetTooltip', "Close (Esc)"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.sheetRenderDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeSheet()));

		if (this.activeSheetTab === 'blueprint') {
			const body = append(this.sheetContentEl, $('.ade-eng-sheet-body'));
			const initialMd = this.draftBlueprint
				? serializeEngineeringBlueprint(this.draftBlueprint)
				: snap.blueprintText;
			const editor = append(body, $('textarea.ade-eng-blueprint-editor', {
				spellcheck: 'false',
			})) as HTMLTextAreaElement;
			editor.value = initialMd;

			const statusMsg = append(body, $('div.ade-eng-sheet-status'));
			const actions = append(body, $('.ade-eng-sheet-actions'));
			const copyBtn = append(actions, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
			}, localize('adeEngCopyBlueprintBtn', "Copy Markdown")));
			this.sheetRenderDisposables.add(addDisposableListener(copyBtn, EventType.CLICK, () => {
				void getWindow(this.rootEl).navigator.clipboard?.writeText(editor.value);
				statusMsg.textContent = localize('adeEngCopiedBlueprintMsg', "Blueprint Markdown copied to clipboard.");
				statusMsg.className = 'ade-eng-sheet-status ok';
			}));

			const applyBtn = append(actions, $('button.ade-eng-action-btn.confirm', {
				type: 'button',
			}, localize('adeEngApplyRawBlueprintBtn', "Validate & Apply")));
			const doApplyRaw = async () => {
				try {
					const ok = await this.applyRawBlueprintWithSafety(editor.value);
					if (ok) {
						statusMsg.textContent = localize('adeEngBlueprintAppliedMsg', "Blueprint validated & applied.");
						statusMsg.className = 'ade-eng-sheet-status ok';
					}
				} catch (err) {
					statusMsg.textContent = err instanceof Error ? err.message : String(err);
					statusMsg.className = 'ade-eng-sheet-status err';
				}
			};
			this.sheetRenderDisposables.add(addDisposableListener(applyBtn, EventType.CLICK, () => {
				void doApplyRaw();
			}));
			this.sheetRenderDisposables.add(addDisposableListener(editor, EventType.KEY_DOWN, (ke: KeyboardEvent) => {
				if ((ke.metaKey || ke.ctrlKey) && ke.key.toLowerCase() === 's') {
					EventHelper.stop(ke, true);
					void doApplyRaw();
				}
			}));
		} else {
			const filterBar = append(this.sheetContentEl, $('.ade-eng-event-filters'));
			const filters: { readonly id: EventFilterKind; readonly label: string }[] = [
				{ id: 'all', label: localize('adeEngLogFilterAll', "All") },
				{ id: 'worker', label: localize('adeEngLogFilterWrk', "Worker · L4") },
				{ id: 'employee', label: localize('adeEngLogFilterEmp', "Employee · L3") },
				{ id: 'manager', label: localize('adeEngLogFilterMgr', "Manager · L2") },
				{ id: 'gates', label: localize('adeEngLogFilterGates', "Gates & Alerts") },
			];
			for (const f of filters) {
				const fBtn = append(filterBar, $(`button.ade-eng-event-filter-btn${this.activeEventFilter === f.id ? '.active' : ''}`, {
					type: 'button',
				}, f.label));
				this.sheetRenderDisposables.add(addDisposableListener(fBtn, EventType.CLICK, () => {
					this.activeEventFilter = f.id;
					this.renderSheet();
				}));
			}

			const body = append(this.sheetContentEl, $('.ade-eng-sheet-body.events'));
			this.sheetEventsBodyEl = body;
			const events = [...snap.state.events].reverse().filter(ev => this.matchesEventFilter(ev));
			if (events.length === 0) {
				append(body, $('div.ade-eng-empty-hint', {}, localize('adeEngNoEventsYet', "No execution events match this filter yet.")));
			} else {
				for (const ev of events) {
					const row = append(body, $(`div.ade-eng-event-row.level-${ev.level}.kind-${ev.event}`));
					const meta = append(row, $('div.ade-eng-event-meta'));
					const d = new Date(ev.timestamp);
					const hhmmss = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
					append(meta, $('span.ade-eng-event-time', {}, hhmmss));
					if (ev.nodeId) {
						const nodeId = ev.nodeId;
						const nodeJumpBtn = append(meta, $('button.ade-eng-event-node-btn', {
							type: 'button',
							title: localize('adeEngJumpToEventNodeTooltip', "Click to focus [{0}] on canvas", nodeId),
						}, `[${nodeId}]`));
						this.sheetRenderDisposables.add(addDisposableListener(nodeJumpBtn, EventType.CLICK, () => {
							this.focusNodeOnCanvas(nodeId, false);
						}));
					}
					append(meta, $('span.ade-eng-event-kind', {}, ev.event));
					if (ev.detail) {
						append(row, $('div.ade-eng-event-msg', {}, ev.detail));
					}
				}
			}
		}
	}

	override focus(): void {
		this.rootEl?.focus();
	}

	layout(dimension: Dimension): void {
		this.lastDimension = dimension;
		this.rootEl.style.width = `${dimension.width}px`;
		this.rootEl.style.height = `${dimension.height}px`;
		if (this.pendingInitialFit && dimension.width > 0 && this.draftBlueprint && this.draftBlueprint.nodes.length > 0) {
			this.pendingInitialFit = false;
			this.fitViewportToGraph(false);
		} else {
			this.updateMinimapLens();
			this.positionPopoverNearAnchor();
		}
	}
}
