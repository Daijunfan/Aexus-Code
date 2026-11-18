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
	IAdeEngineeringNodeRuntimeState,
	IAdeEngineeringService,
	IAdeEngineeringTreeSnapshot,
	IAdeTokenUsage,
	formatCompactTokenCount,
} from '../../../../platform/ade/common/adeEngineering.js';
import {
	AdeBlueprintValidationError,
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

const ENGINE_OPTIONS: readonly { readonly value: string; readonly label: string; readonly shortLabel: string }[] = [
	{ value: 'claude-code', label: 'Claude Code', shortLabel: 'Claude Code' },
	{ value: 'codex', label: 'Codex', shortLabel: 'Codex' },
	{ value: 'antigravity', label: 'Google Antigravity', shortLabel: 'Antigravity' },
	{ value: 'kilo', label: 'Kilo Code', shortLabel: 'Kilo Code' },
	{ value: 'opencode', label: 'OpenCode', shortLabel: 'OpenCode' },
	{ value: 'dsh', label: 'DeepSeek Harness', shortLabel: 'DeepSeek' },
	{ value: 'cline', label: 'Cline', shortLabel: 'Cline' },
	{ value: 'pi', label: 'Pi', shortLabel: 'Pi' },
];

const THINKING_OPTIONS: readonly { readonly value: AdeThinkingLevel; readonly label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'low', label: 'Low' },
	{ value: 'medium', label: 'Med' },
	{ value: 'high', label: 'High' },
	{ value: 'max', label: 'Max' },
];

const TASK_NODE_DIAMETER = 82;
const GATE_NODE_WIDTH = 172;
const POPOVER_WIDTH = 286;

type PopoverTabKind = 'worker' | 'employee' | 'manager' | 'task';

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
		return localize('adeEngineeringTabTitle', "{0} · Engineering", base);
	}

	override getIcon(): ThemeIcon {
		return Codicon.typeHierarchySub;
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

	private rootEl!: HTMLElement;
	private toolbarEl!: HTMLElement;
	private bannerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private segmentsLayerEl!: HTMLElement;
	private edgesSvgEl!: SVGSVGElement;
	private edgesDefsEl!: SVGDefsElement;
	private edgesGroupEl!: SVGGElement;
	private rubberBandPathEl!: SVGPathElement;
	private nodesLayerEl!: HTMLElement;
	private hudEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private popoverContentEl!: HTMLElement;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly toolbarRenderDisposables = this._register(new DisposableStore());
	private readonly hudRenderDisposables = this._register(new DisposableStore());
	private readonly canvasRenderDisposables = this._register(new DisposableStore());
	private readonly popoverRenderDisposables = this._register(new DisposableStore());

	private activeGovernorId: string | undefined;
	private snapshot: IAdeEngineeringTreeSnapshot | undefined;
	private draftBlueprint: IAdeEngineeringBlueprint | undefined;
	private isDraftDirty = false;
	private connectMode = false;
	private connectSourceNodeId: string | undefined;

	private panX = 48;
	private panY = 36;
	private zoom = 1;
	private lastDimension: Dimension | undefined;

	private activePopoverNodeId: string | undefined;
	private activePopoverSegmentId: string | undefined;
	private activePopoverTab: PopoverTabKind = 'worker';
	private activeAnchorKind: 'worker' | 'employee' | 'manager' | 'gate' = 'worker';

	private nodeDomById = new Map<string, HTMLElement>();
	private nodeAnchorsById = new Map<string, {
		readonly worker?: HTMLElement;
		readonly employee?: HTMLElement;
		readonly gate?: HTMLElement;
	}>();
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
		super(AdeEngineeringEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.renderCanvas();
			this.renderPopover();
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
				if (this.activePopoverNodeId) {
					this.renderPopover();
				}
			}
		} catch {
			// Command may not be registered in standalone unit-test harnesses.
		}
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-eng-editor', { tabindex: 0 }));
		this.toolbarEl = append(this.rootEl, $('.ade-eng-toolbar'));
		this.bannerEl = append(this.rootEl, $('.ade-eng-banner'));
		this.bannerEl.hidden = true;

		this.bodyEl = append(this.rootEl, $('.ade-eng-body'));
		this.viewportEl = append(this.bodyEl, $('.ade-eng-viewport'));
		this.worldEl = append(this.viewportEl, $('.ade-eng-world'));
		this.segmentsLayerEl = append(this.worldEl, $('.ade-eng-segments-layer'));

		this.edgesSvgEl = this.worldEl.appendChild($.SVG<SVGSVGElement>('svg', {
			class: 'ade-eng-edges-svg',
			width: '4000',
			height: '3000',
			viewBox: '0 0 4000 3000',
		}));
		this.edgesDefsEl = this.edgesSvgEl.appendChild($.SVG<SVGDefsElement>('defs'));
		this.buildSvgMarkers();
		this.edgesGroupEl = this.edgesSvgEl.appendChild($.SVG<SVGGElement>('g', { class: 'ade-eng-edges-group' }));
		this.rubberBandPathEl = this.edgesSvgEl.appendChild($.SVG<SVGPathElement>('path', {
			class: 'ade-eng-edge-path rubber-band',
			d: '',
		}));
		this.rubberBandPathEl.style.display = 'none';

		this.nodesLayerEl = append(this.worldEl, $('.ade-eng-nodes-layer'));

		// Floating Bottom-Right Canvas Controls HUD
		this.hudEl = append(this.bodyEl, $('.ade-eng-canvas-hud'));

		// Anchored Floating Option Popover right adjacent to right-clicked engine / node (NO sidebar drawer, NO auto-popup on hover!)
		this.popoverEl = append(this.bodyEl, $('.ade-eng-popover'));
		this.popoverContentEl = append(this.popoverEl, $('.ade-eng-popover-inner'));

		this.installViewportInteractions();
		this.installPopoverDismissal();
	}

	private buildSvgMarkers(): void {
		this.edgesDefsEl.replaceChildren();
		const createArrow = (id: string, colorVar: string) => {
			const marker = $.SVG<SVGMarkerElement>('marker', {
				id,
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
		createArrow('ade-arrow-pending', 'var(--ade-eng-edge-pending, #6e7681)');
		createArrow('ade-arrow-running', 'var(--ade-eng-green, #3fb950)');
		createArrow('ade-arrow-completed', 'var(--ade-eng-green, #2ea043)');
		createArrow('ade-arrow-blocked', 'var(--ade-eng-edge-blocked, #6e7681)');
	}

	private installViewportInteractions(): void {
		let panning = false;
		let startClientX = 0;
		let startClientY = 0;
		let startPanX = 0;
		let startPanY = 0;

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (target && (target.closest('.ade-eng-node') || target.closest('.ade-eng-edge-hit') || target.closest('.ade-eng-segment-header'))) {
				return;
			}
			if (e.button !== 0 && e.button !== 1) {
				return;
			}
			if (this.connectSourceNodeId) {
				this.connectSourceNodeId = undefined;
				this.rubberBandPathEl.style.display = 'none';
				this.renderCanvas();
			}
			this.closePopover();
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
			if (e.ctrlKey || e.metaKey) {
				const rect = this.viewportEl.getBoundingClientRect();
				const cursorX = e.clientX - rect.left;
				const cursorY = e.clientY - rect.top;
				const worldX = (cursorX - this.panX) / this.zoom;
				const worldY = (cursorY - this.panY) / this.zoom;
				const factor = e.deltaY < 0 ? 1.08 : 0.92;
				const nextZoom = Math.min(2.1, Math.max(0.38, this.zoom * factor));
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

	private installPopoverDismissal(): void {
		this._register(addDisposableListener(this.rootEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (!this.activePopoverNodeId || e.button !== 0) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-eng-popover')) {
				return;
			}
			this.closePopover();
		}, true));

		this._register(addDisposableListener(this.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-eng-node, .ade-eng-segment-header, .ade-eng-popover')) {
				return;
			}
			EventHelper.stop(e, true);
			this.closePopover();
		}));

		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.activePopoverNodeId) {
				EventHelper.stop(e, true);
				this.closePopover();
			}
		}));
	}

	private openPopoverForTarget(params: {
		readonly nodeId: string;
		readonly anchorKind: 'worker' | 'employee' | 'manager' | 'gate';
		readonly tab?: PopoverTabKind;
		readonly segmentId?: string;
	}): void {
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
		this.popoverEl.style.maxHeight = '';
		for (const el of this.nodeDomById.values()) {
			el.classList.remove('inspected');
		}
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

		// Fallback math for synthetic headless unit tests where getBoundingClientRect() may be 0
		const node = this.draftBlueprint?.nodes.find(n => n.id === this.activePopoverNodeId);
		if (!node) {
			return undefined;
		}
		const cx = (node.position?.x ?? 180) * this.zoom + this.panX;
		const cy = (node.position?.y ?? 240) * this.zoom + this.panY;
		const halfW = ((node.type === 'user_gate' ? GATE_NODE_WIDTH : TASK_NODE_DIAMETER) / 2) * this.zoom;
		const halfH = ((node.type === 'user_gate' ? 76 : TASK_NODE_DIAMETER) / 2) * this.zoom;
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
		const bodyH = Math.max(240, this.bodyEl.clientHeight || ((this.lastDimension?.height ?? 640) - 42));
		this.popoverEl.style.maxHeight = `${Math.max(200, bodyH - 20)}px`;
		const popW = Math.min(bodyW - 20, this.popoverEl.offsetWidth || POPOVER_WIDTH);
		const popH = Math.min(bodyH - 20, this.popoverEl.offsetHeight || 280);
		const gap = 10;

		let left = anchor.right + gap;
		let top = Math.max(10, Math.min(bodyH - popH - 10, anchor.centerY - Math.min(96, popH * 0.34)));
		let flippedLeft = false;
		let placedBelow = false;
		let placedAbove = false;

		if (anchor.right + gap + popW <= bodyW - 10) {
			// Priority 1: Right of hovered engine/node
			left = anchor.right + gap;
		} else if (anchor.left - gap - popW >= 10) {
			// Priority 2: Left of hovered engine/node
			left = anchor.left - gap - popW;
			flippedLeft = true;
		} else {
			// Priority 3 / 4: Narrow split-pane — place cleanly Below or Above so hovered icon is NEVER covered!
			const anchorCenterX = (anchor.left + anchor.right) / 2;
			left = Math.max(10, Math.min(bodyW - popW - 10, anchorCenterX - popW / 2));
			const spaceBelow = bodyH - anchor.bottom - gap - 10;
			const spaceAbove = anchor.top - gap - 10;
			if (spaceBelow >= Math.min(popH, 230) || spaceBelow >= spaceAbove) {
				placedBelow = true;
				top = Math.max(10, anchor.bottom + gap);
				this.popoverEl.style.maxHeight = `${Math.max(180, bodyH - top - 10)}px`;
			} else {
				placedAbove = true;
				const maxAboveH = Math.max(180, anchor.top - gap - 10);
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
		this.activeGovernorId = input.governorSessionId;
		this.isDraftDirty = false;
		this.connectMode = false;
		this.connectSourceNodeId = undefined;
		this.closePopover();

		await this.engineering.whenReady();
		if (token.isCancellationRequested) {
			return;
		}
		if (!this.engineering.hasTree(input.governorSessionId) && this.projects.getAgent(input.governorSessionId)) {
			await this.engineering.initTree({ governorSessionId: input.governorSessionId }).catch(() => undefined);
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
		this.inputDisposables.clear();
		this.toolbarRenderDisposables.clear();
		this.hudRenderDisposables.clear();
		this.canvasRenderDisposables.clear();
		this.popoverRenderDisposables.clear();
		this.activeGovernorId = undefined;
		this.snapshot = undefined;
		this.draftBlueprint = undefined;
		this.closePopover();
		super.clearInput();
	}

	private reloadFromService(resetDraft: boolean): void {
		if (!this.activeGovernorId) {
			return;
		}
		const snap = this.engineering.getTreeSnapshot(this.activeGovernorId);
		this.snapshot = snap;
		if (snap && (resetDraft || !this.isDraftDirty || !this.draftBlueprint)) {
			const cloned = cloneBlueprint(snap.blueprint);
			const autoPos = computeAutoLayoutPositions(cloned);
			this.draftBlueprint = {
				...cloned,
				nodes: cloned.nodes.map(n => n.position ? n : { ...n, position: autoPos.get(n.id) ?? { x: 180, y: 240 } }),
			};
			if (resetDraft) {
				this.isDraftDirty = false;
			}
		}
		this.renderToolbar();
		this.renderCanvas();
		this.renderHud();
		if (this.activePopoverNodeId) {
			if (this.draftBlueprint?.nodes.some(n => n.id === this.activePopoverNodeId)) {
				this.renderPopover();
			} else {
				this.closePopover();
			}
		}
	}

	private markDraftModified(nextBp: IAdeEngineeringBlueprint): void {
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
		this.renderCanvas();
		if (this.activePopoverNodeId) {
			const nextSeg = recomputedManagers.find(m => m.nodeIds.includes(this.activePopoverNodeId!));
			if (this.activeAnchorKind === 'manager' && nextSeg) {
				this.activePopoverSegmentId = nextSeg.segmentId;
			}
			this.renderPopover();
		}
	}

	private showBanner(message: string, kind: 'info' | 'warn' | 'error'): void {
		this.bannerEl.textContent = message;
		this.bannerEl.className = `ade-eng-banner ${kind}`;
		this.bannerEl.hidden = false;
	}

	private hideBanner(): void {
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
		this.positionPopoverNearAnchor();
	}

	private fitViewportToGraph(): void {
		if (!this.draftBlueprint || this.draftBlueprint.nodes.length === 0 || !this.lastDimension) {
			this.panX = 48;
			this.panY = 36;
			this.zoom = 1;
			this.applyWorldTransform();
			this.renderHud();
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of this.draftBlueprint.nodes) {
			const x = n.position?.x ?? 180;
			const y = n.position?.y ?? 240;
			minX = Math.min(minX, x - 96);
			minY = Math.min(minY, y - 82);
			maxX = Math.max(maxX, x + 130);
			maxY = Math.max(maxY, y + 112);
		}
		const availW = Math.max(320, this.lastDimension.width - 72);
		const availH = Math.max(240, this.lastDimension.height - 96);
		const graphW = Math.max(200, maxX - minX);
		const graphH = Math.max(160, maxY - minY);
		const scale = Math.min(1.12, Math.max(0.45, Math.min(availW / graphW, availH / graphH)));
		this.zoom = Math.round(scale * 100) / 100;
		this.panX = Math.round((availW - graphW * this.zoom) / 2 - minX * this.zoom + 36);
		this.panY = Math.round((availH - graphH * this.zoom) / 2 - minY * this.zoom + 18);
		this.applyWorldTransform();
		this.renderHud();
	}

	private renderToolbar(): void {
		this.toolbarRenderDisposables.clear();
		clearNode(this.toolbarEl);
		const snap = this.snapshot;
		const bp = this.draftBlueprint;
		if (!snap || !bp) {
			append(this.toolbarEl, $('span.ade-eng-toolbar-title', {}, localize('adeEngLoading', "ADE Engineering")));
			return;
		}

		// Left Cluster: Title + Engineering Pill + Status Pill + Progress
		const left = append(this.toolbarEl, $('.ade-eng-toolbar-group.left'));
		const titleIcon = append(left, $('span.ade-eng-title-icon'));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchySub));
		append(left, $('span.ade-eng-toolbar-title', {}, snap.governorLabel));
		append(left, $('span.ade-eng-tree-pill', {}, snap.treeType === 'research' ? 'Research' : 'Engineering'));

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

		append(
			left,
			$('span.ade-eng-progress-pill', {}, `${snap.progress.completedNodes}/${snap.progress.totalNodes} · ${bp.managers.length} Mgr`),
		);

		const treeTokens = snap.tokenUsage.total;
		const tokenTooltipLines = [
			localize(
				'adeEngTokensTotalTooltip',
				"Total Token Consumption: {0} tokens ({1} turns)",
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
		const tokensPill = append(left, $(`span.ade-eng-tokens-pill${treeTokens.totalTokens > 0 ? '.has-usage' : ''}`, {
			title: tokenTooltipLines.join('\n'),
		}));
		const tokIco = append(tokensPill, $('span.ade-eng-tokens-ico'));
		tokIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.pulse));
		append(tokensPill, $('span', {}, `${formatCompactTokenCount(treeTokens.totalTokens)} tok`));

		// Right Cluster: Compact Authoring Pills + Draft Guard + Execution Controls (single crisp row!)
		const right = append(this.toolbarEl, $('.ade-eng-toolbar-group.right'));

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

		makeToolBtn(Codicon.add, localize('adeEngAddTaskBtn', "Task"), () => this.addDraftNode('task'));
		makeToolBtn(Codicon.verified, localize('adeEngAddGateBtn', "User Gate"), () => this.addDraftNode('user_gate'));
		makeToolBtn(
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

		append(right, $('span.ade-eng-toolbar-sep'));

		if (this.isDraftDirty) {
			append(right, $('span.ade-eng-draft-badge', {}, localize('adeEngDraftUnsaved', "Draft")));

			const cancelBtn = append(right, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
			}, localize('adeEngCancelDraftBtn', "Cancel")));
			this.toolbarRenderDisposables.add(addDisposableListener(cancelBtn, EventType.CLICK, () => {
				this.hideBanner();
				this.reloadFromService(true);
			}));

			const confirmBtn = append(right, $('button.ade-eng-action-btn.confirm', {
				type: 'button',
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
					void this.engineering.pauseTree(this.activeGovernorId);
				}
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.danger', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.toolbarRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.stopTree(this.activeGovernorId);
				}
			}));
		} else if (runStatus === 'paused' || runStatus === 'waiting_gate') {
			const resumeBtn = append(right, $('button.ade-eng-action-btn.run', { type: 'button' }));
			const resumeIco = append(resumeBtn, $('span'));
			resumeIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.play));
			append(resumeBtn, $('span', {}, localize('adeEngResumeBtn', "Resume")));
			this.toolbarRenderDisposables.add(addDisposableListener(resumeBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.resumeTree(this.activeGovernorId, 'user');
				}
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.secondary', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.toolbarRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.stopTree(this.activeGovernorId);
				}
			}));
		} else {
			const runBtn = append(right, $('button.ade-eng-action-btn.run', {
				type: 'button',
				...(this.isDraftDirty ? { title: localize('adeEngConfirmBeforeRunHint', "Confirm or cancel draft changes before starting execution") } : {}),
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
		const autoLayoutBtn = append(this.hudEl, $('button.ade-eng-hud-btn', {
			type: 'button',
			title: localize('adeEngAutoLayoutTooltip', "Auto-arrange DAG nodes cleanly"),
		}));
		const layoutIco = append(autoLayoutBtn, $('span'));
		layoutIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.layout));
		append(autoLayoutBtn, $('span', {}, localize('adeEngAutoLayoutBtn', "Auto Layout")));
		this.hudRenderDisposables.add(addDisposableListener(autoLayoutBtn, EventType.CLICK, () => this.runAutoLayoutDraft()));

		append(this.hudEl, $('span.ade-eng-hud-sep'));

		const zoomOutBtn = append(this.hudEl, $('button.ade-eng-hud-icon-btn', { type: 'button', title: localize('adeEngZoomOut', "Zoom Out") }));
		zoomOutBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomOut));
		this.hudRenderDisposables.add(addDisposableListener(zoomOutBtn, EventType.CLICK, () => {
			this.zoom = Math.max(0.38, Math.round((this.zoom - 0.12) * 100) / 100);
			this.applyWorldTransform();
			this.renderHud();
		}));

		const zoomLabelBtn = append(this.hudEl, $('button.ade-eng-zoom-readout', {
			type: 'button',
			title: localize('adeEngFitView', "Fit Graph in Viewport"),
		}, `${Math.round(this.zoom * 100)}%`));
		this.hudRenderDisposables.add(addDisposableListener(zoomLabelBtn, EventType.CLICK, () => this.fitViewportToGraph()));

		const zoomInBtn = append(this.hudEl, $('button.ade-eng-hud-icon-btn', { type: 'button', title: localize('adeEngZoomIn', "Zoom In") }));
		zoomInBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomIn));
		this.hudRenderDisposables.add(addDisposableListener(zoomInBtn, EventType.CLICK, () => {
			this.zoom = Math.min(2.1, Math.round((this.zoom + 0.12) * 100) / 100);
			this.applyWorldTransform();
			this.renderHud();
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
			await this.engineering.applyBlueprint({
				governorSessionId: this.activeGovernorId,
				blueprintText: serialized,
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
				try {
					await this.engineering.applyBlueprint({
						governorSessionId: this.activeGovernorId,
						blueprintText: serialized,
						forceStopRunning: true,
					});
					this.isDraftDirty = false;
					this.hideBanner();
					this.reloadFromService(true);
					return true;
				} catch (innerErr) {
					this.showBanner(innerErr instanceof Error ? innerErr.message : String(innerErr), 'error');
					return false;
				}
			}
			this.showBanner(err instanceof Error ? err.message : String(err), 'error');
			return false;
		}
	}

	private addDraftNode(type: 'task' | 'user_gate'): void {
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

		const maxX = this.draftBlueprint.nodes.reduce((acc, n) => Math.max(acc, n.position?.x ?? 180), 100);
		const pos = {
			x: this.draftBlueprint.nodes.length === 0 ? 180 : maxX + 260,
			y: 240 + ((index % 3) - 1) * 75,
		};

		const defaultEngine = this.draftBlueprint.nodes.find(n => n.worker)?.worker?.engine ?? 'claude-code';
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
				employee: { engine: defaultEngine, thinking: 'medium' },
				worker: { engine: defaultEngine, thinking: 'high' },
				goal: localize('adeEngNewTaskDefaultGoal', "Implement task {0} cleanly in the workspace.", newId),
				acceptance: localize('adeEngNewTaskDefaultAcceptance', "1. Implementation passes static checks and unit tests."),
				position: pos,
			};

		this.markDraftModified({
			...this.draftBlueprint,
			nodes: [...this.draftBlueprint.nodes, newNode],
		});
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
			this.fitViewportToGraph();
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
		const cx = node.position?.x ?? 180;
		const cy = node.position?.y ?? 240;
		if (node.type === 'user_gate') {
			return {
				inX: cx - GATE_NODE_WIDTH / 2,
				inY: cy,
				outX: cx + GATE_NODE_WIDTH / 2,
				outY: cy,
			};
		}
		const r = TASK_NODE_DIAMETER / 2;
		return {
			inX: cx - r - 4,
			inY: cy,
			outX: cx + r + 4,
			outY: cy,
		};
	}

	private buildBezierPath(x1: number, y1: number, x2: number, y2: number): string {
		const dx = Math.abs(x2 - x1);
		const controlOffset = Math.max(58, Math.min(180, dx * 0.52));
		const c1x = x1 + controlOffset;
		const c2x = x2 - controlOffset;
		return `M ${Math.round(x1)} ${Math.round(y1)} C ${Math.round(c1x)} ${Math.round(y1)}, ${Math.round(c2x)} ${Math.round(y2)}, ${Math.round(x2)} ${Math.round(y2)}`;
	}

	private renderCanvas(): void {
		this.canvasRenderDisposables.clear();
		this.renderToolbar();
		clearNode(this.segmentsLayerEl);
		this.edgesGroupEl.replaceChildren();
		clearNode(this.nodesLayerEl);
		this.nodeDomById.clear();
		this.nodeAnchorsById.clear();
		this.segmentHeaderDomById.clear();

		this.applyWorldTransform();

		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!bp || !snap) {
			return;
		}

		const nodeById = new Map(bp.nodes.map(n => [n.id, n]));
		const runtimes = snap.state.nodes;

		// 1. Render Auto-Partitioned Manager Segment Enclosures
		for (const seg of bp.managers) {
			const segNodes = seg.nodeIds.map(id => nodeById.get(id)).filter((n): n is IAdeEngineeringBlueprintNode => Boolean(n));
			if (segNodes.length === 0) {
				continue;
			}
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const n of segNodes) {
				const cx = n.position?.x ?? 180;
				const cy = n.position?.y ?? 240;
				minX = Math.min(minX, cx - 90);
				minY = Math.min(minY, cy - 72);
				maxX = Math.max(maxX, cx + 90);
				maxY = Math.max(maxY, cy + 98);
			}
			const halo = append(this.segmentsLayerEl, $('.ade-eng-segment-halo'));
			halo.style.left = `${Math.round(minX)}px`;
			halo.style.top = `${Math.round(minY)}px`;
			halo.style.width = `${Math.round(maxX - minX)}px`;
			halo.style.height = `${Math.round(maxY - minY)}px`;

			const header = append(halo, $('button.ade-eng-segment-header', {
				type: 'button',
				'data-segment-id': seg.segmentId,
				title: localize('adeEngManagerHeaderTooltip', "Right-click to configure Manager [{0}] · Click to open Manager session", seg.segmentId),
			}));
			this.segmentHeaderDomById.set(seg.segmentId, header);
			const mgrGlyph = append(header, $('span'));
			this.applyEngineIconToElement(mgrGlyph, seg.config.engine);
			append(header, $('span.ade-eng-segment-label', {}, `Mgr [${seg.segmentId}] · ${seg.config.thinking}`));

			this.canvasRenderDisposables.add(addDisposableListener(header, EventType.CONTEXT_MENU, e => {
				EventHelper.stop(e, true);
				if (segNodes[0]) {
					this.openPopoverForTarget({
						nodeId: segNodes[0].id,
						anchorKind: 'manager',
						tab: 'manager',
						segmentId: seg.segmentId,
					});
				}
			}));
			this.canvasRenderDisposables.add(addDisposableListener(header, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				this.closePopover();
				if (this.activeGovernorId && segNodes[0]) {
					void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, segNodes[0].id, 'manager');
				}
			}));
		}

		// 2. Render Edges
		this.renderEdgesOnly();

		// 3. Render Nodes (Dual-Core Concentric Circles + Shield User Gates)
		for (const node of bp.nodes) {
			const runtime: IAdeEngineeringNodeRuntimeState | undefined = runtimes[node.id];
			const visualStatus = computeNodeVisualStatus(node, runtime);
			const isLocked = Boolean(runtime?.completed);

			const cx = node.position?.x ?? 180;
			const cy = node.position?.y ?? 240;

			const nodeEl = append(this.nodesLayerEl, $(`div.ade-eng-node.type-${node.type}.status-${visualStatus}${isLocked ? '.locked' : ''}${this.activePopoverNodeId === node.id ? '.inspected' : ''}${this.connectSourceNodeId === node.id ? '.connect-source' : ''}`, {
				'data-node-id': node.id,
				'data-visual-status': visualStatus,
			}));
			nodeEl.style.left = `${Math.round(cx)}px`;
			nodeEl.style.top = `${Math.round(cy)}px`;
			this.nodeDomById.set(node.id, nodeEl);

			const inPort = append(nodeEl, $('div.ade-eng-port.port-in', {
				title: localize('adeEngPortInTooltip', "Input Port ({0})", node.id),
			}));
			const outPort = append(nodeEl, $('div.ade-eng-port.port-out', {
				title: localize('adeEngPortOutTooltip', "Drag to connect from {0}", node.id),
			}));

			this.installPortWiring(node, outPort, inPort);

			if (node.type === 'user_gate') {
				const gateBody = append(nodeEl, $('div.ade-eng-gate-body.ade-pistol-cursor'));
				this.nodeAnchorsById.set(node.id, { gate: gateBody });
				const gateIcon = append(gateBody, $('span.ade-eng-gate-icon'));
				gateIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.verifiedFilled));
				const gateTextWrap = append(gateBody, $('div.ade-eng-gate-text'));
				append(gateTextWrap, $('span.ade-eng-gate-kicker', {}, runtime?.phase === 'waiting_user_gate'
					? localize('adeEngGateWaitingKicker', "AWAITING APPROVAL")
					: localize('adeEngGateKicker', "USER GATE")));
				append(gateTextWrap, $('span.ade-eng-gate-title', {}, node.title));
			} else {
				const concentric = append(nodeEl, $('div.ade-eng-concentric.ade-pistol-cursor'));

				const ringSvg = concentric.appendChild($.SVG<SVGSVGElement>('svg', {
					class: 'ade-eng-outer-ring-svg',
					viewBox: '0 0 88 88',
					width: '88',
					height: '88',
				}));
				ringSvg.appendChild($.SVG<SVGCircleElement>('circle', {
					class: 'ade-eng-ring-track',
					cx: '44',
					cy: '44',
					r: '38',
				}));
				ringSvg.appendChild($.SVG<SVGCircleElement>('circle', {
					class: 'ade-eng-ring-indicator',
					cx: '44',
					cy: '44',
					r: '38',
				}));

				const innerCore = append(concentric, $('div.ade-eng-inner-core', {
					title: localize('adeEngWorkerCoreTooltip', "Worker (L4): {0} — Right-click for options · Click to open session", node.worker?.engine ?? 'claude-code'),
				}));
				const workerGlyph = append(innerCore, $('span'));
				this.applyEngineIconToElement(workerGlyph, node.worker?.engine);

				const empSatellite = append(concentric, $('div.ade-eng-emp-satellite', {
					title: localize('adeEngEmployeeSatTooltip', "Employee (L3): {0} — Right-click for options · Click to open session", node.employee?.engine ?? 'claude-code'),
				}));
				this.nodeAnchorsById.set(node.id, { worker: concentric, employee: empSatellite });
				const empGlyph = append(empSatellite, $('span'));
				this.applyEngineIconToElement(empGlyph, node.employee?.engine);

				// Right-clicking directly on Employee satellite or Worker core opens the anchored popover at that exact role!
				this.canvasRenderDisposables.add(addDisposableListener(empSatellite, EventType.CONTEXT_MENU, e => {
					EventHelper.stop(e, true);
					this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'employee', tab: 'employee' });
				}));
				this.canvasRenderDisposables.add(addDisposableListener(innerCore, EventType.CONTEXT_MENU, e => {
					EventHelper.stop(e, true);
					this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'worker' });
				}));

				if (node.critical) {
					append(concentric, $('span.ade-eng-critical-badge', {
						title: localize('adeEngCriticalBadgeTooltip', "★ Critical Node — Triggers Segment Manager Secondary Review"),
					}, '★'));
				}

				if (isLocked) {
					const doneBadge = append(concentric, $('span.ade-eng-corner-status.done'));
					doneBadge.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
				} else if (runtime && runtime.formalFailureCount > 0) {
					append(concentric, $(`span.ade-eng-corner-status.fail-${Math.min(3, runtime.formalFailureCount)}`, {}, `F${runtime.formalFailureCount}`));
				} else if (runtime && runtime.employeeRejectCount > 0) {
					append(concentric, $('span.ade-eng-corner-status.rework', {
						title: localize('adeEngInternalReworkBadgeTooltip', "Employee Internal Rework {0}/3 (not a formal failure)", runtime.employeeRejectCount),
					}, `R${runtime.employeeRejectCount}`));
				}

				const caption = append(nodeEl, $('div.ade-eng-node-caption'));
				append(caption, $('span.ade-eng-node-title', {}, `[${node.id}] ${node.title}`));
				const subMeta = `${node.worker?.engine ?? 'claude-code'}:${node.worker?.thinking ?? 'high'}`;
				append(caption, $('span.ade-eng-node-sub', {}, subMeta));
				const nodeTok = runtime?.tokenUsage?.total;
				if (nodeTok && nodeTok.totalTokens > 0) {
					const nodeBreakdownTitle = localize(
						'adeEngNodeTokensTooltip',
						"Node [{0}] Tokens: {1} total (In {2} · Out {3} · Cache {4})\nWorker (L4): {5} · Employee (L3): {6} · Manager (L2): {7}",
						node.id,
						nodeTok.totalTokens.toLocaleString(),
						nodeTok.inputTokens.toLocaleString(),
						nodeTok.outputTokens.toLocaleString(),
						nodeTok.cacheReadTokens.toLocaleString(),
						(runtime?.tokenUsage?.worker.totalTokens ?? 0).toLocaleString(),
						(runtime?.tokenUsage?.employee.totalTokens ?? 0).toLocaleString(),
						(runtime?.tokenUsage?.manager.totalTokens ?? 0).toLocaleString(),
					);
					append(caption, $('span.ade-eng-node-tokens', { title: nodeBreakdownTitle }, `${formatCompactTokenCount(nodeTok.totalTokens)} tok`));
				}
			}

			this.installNodeInteractions(node, nodeEl);
		}
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

			const g = this.edgesGroupEl.appendChild($.SVG<SVGGElement>('g', {
				class: `ade-eng-edge-item status-${edgeStatus}`,
				'data-edge': `${edge.from}->${edge.to}`,
				'data-edge-status': edgeStatus,
			}));

			if (edgeStatus === 'running') {
				g.appendChild($.SVG<SVGPathElement>('path', {
					class: 'ade-eng-edge-glow',
					d,
				}));
			}

			g.appendChild($.SVG<SVGPathElement>('path', {
				class: `ade-eng-edge-path status-${edgeStatus}`,
				d,
				'marker-end': `url(#ade-arrow-${edgeStatus})`,
			}));

			const hitPath = g.appendChild($.SVG<SVGPathElement>('path', {
				class: 'ade-eng-edge-hit',
				d,
			}));
			const canDelete = !this.isNodeCompletedLocked(edge.to);
			if (canDelete) {
				this.canvasRenderDisposables.add(addDisposableListener(hitPath, EventType.DBLCLICK, e => {
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
			const startPorts = this.getNodePorts(node);
			this.rubberBandPathEl.style.display = '';
			this.rubberBandPathEl.setAttribute('d', this.buildBezierPath(startPorts.outX, startPorts.outY, startPorts.outX + 10, startPorts.outY));

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
		let downClickedEmp = false;
		let downClientX = 0;
		let downClientY = 0;
		let origX = 0;
		let origY = 0;

		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-eng-port')) {
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
					this.connectMode = false;
					this.tryAddDraftEdge(src, node.id);
				} else {
					this.connectSourceNodeId = undefined;
					this.renderCanvas();
				}
				return;
			}

			dragging = true;
			movedBeyondClickThreshold = false;
			downClickedEmp = Boolean(target?.closest('.ade-eng-emp-satellite'));
			downClientX = e.clientX;
			downClientY = e.clientY;
			const liveNode = this.draftBlueprint?.nodes.find(n => n.id === node.id) ?? node;
			origX = liveNode.position?.x ?? 180;
			origY = liveNode.position?.y ?? 240;

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
			movedBeyondClickThreshold = true;
			const nextX = Math.round(origX + dxScreen / this.zoom);
			const nextY = Math.round(origY + dyScreen / this.zoom);

			nodeEl.style.left = `${nextX}px`;
			nodeEl.style.top = `${nextY}px`;
			this.draftBlueprint = {
				...this.draftBlueprint,
				nodes: this.draftBlueprint.nodes.map(n => n.id === node.id ? { ...n, position: { x: nextX, y: nextY } } : n),
			};
			if (!this.isDraftDirty) {
				this.isDraftDirty = true;
				this.renderToolbar();
			}
			this.renderEdgesOnly();
			this.positionPopoverNearAnchor();
		}));

		const finishPointer = (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			dragging = false;
			try {
				nodeEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }

			if (movedBeyondClickThreshold) {
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
				);
			} else if (this.snapshot?.state.nodes[node.id]?.phase === 'waiting_user_gate') {
				this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'gate', tab: 'task' });
			}
		};

		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_UP, finishPointer));
		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, 'pointercancel', () => { dragging = false; }));
	}

	// =========================================================================
	// Anchored Floating Engine & Node Option Popover (Right-Click Adjacent Menu)
	// =========================================================================

	private renderPopover(): void {
		this.popoverRenderDisposables.clear();
		clearNode(this.popoverContentEl);

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

		const updateNodeDraft = (patch: Partial<IAdeEngineeringBlueprintNode>) => {
			if (!this.draftBlueprint || isLocked) {
				return;
			}
			this.markDraftModified({
				...this.draftBlueprint,
				nodes: this.draftBlueprint.nodes.map(n => n.id === draftNode.id ? { ...n, ...patch } : n),
			});
		};

		// 1. Sleek Compact Header Row: [ID] + Inline Editable Title + ★ Critical + Open Session + Delete
		const header = append(this.popoverContentEl, $('.ade-eng-pop-header'));
		append(header, $(`span.ade-eng-pop-id.status-${visualStatus}`, {}, draftNode.id));

		const titleInput = append(header, $('input.ade-eng-pop-title-input.ade-eng-input', {
			type: 'text',
			value: draftNode.title,
			title: draftNode.title,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLInputElement;
		this.popoverRenderDisposables.add(addDisposableListener(titleInput, EventType.CHANGE, () => {
			if (titleInput.value.trim()) {
				updateNodeDraft({ title: titleInput.value.trim() });
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
				title: localize('adeEngDeleteNodeTooltip', "Delete Node"),
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
			title: localize('adeEngClosePopoverTooltip', "Close"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.popoverRenderDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.closePopover();
		}));

		// 2. User Gate Popover (Compact Gate Options + Direct Approve/Rollback)
		if (draftNode.type === 'user_gate') {
			this.renderGatePopoverBody(draftNode, runtime, isLocked, updateNodeDraft);
			this.positionPopoverNearAnchor();
			return;
		}

		// 3. Task Node Segmented Role Option Switcher: Worker | Employee | Manager | Task
		const segBar = append(this.popoverContentEl, $('.ade-eng-pop-role-tabs'));
		const tabs: { readonly id: PopoverTabKind; readonly label: string }[] = [
			{ id: 'worker', label: localize('adeEngPopTabWorker', "Worker") },
			{ id: 'employee', label: localize('adeEngPopTabEmployee', "Employee") },
			...(seg ? [{ id: 'manager' as const, label: `Mgr [${seg.segmentId}]` }] : []),
			{ id: 'task', label: localize('adeEngPopTabTask', "Spec") },
		];
		for (const t of tabs) {
			const btn = append(segBar, $(`button.ade-eng-pop-role-tab${this.activePopoverTab === t.id ? '.active' : ''}`, {
				type: 'button',
			}, t.label));
			this.popoverRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.activePopoverTab = t.id;
				this.renderPopover();
			}));
		}

		if (this.activePopoverTab === 'task') {
			this.renderTaskSpecPopoverBody(draftNode, runtime, isLocked, updateNodeDraft);
		} else if (this.activePopoverTab === 'manager' && seg) {
			this.renderEngineOptionListBody({
				roleTitle: localize('adeEngMgrRoleSubtitle', "Segment Manager · L2 [{0}]", seg.segmentId),
				current: seg.config,
				disabled: false,
				onOpenSession: () => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, draftNode.id, 'manager');
					}
				},
				onChange: next => {
					if (!this.draftBlueprint) {
						return;
					}
					this.markDraftModified({
						...this.draftBlueprint,
						managers: this.draftBlueprint.managers.map(m => m.segmentId === seg.segmentId ? { ...m, config: next } : m),
					});
				},
				runtime,
			});
		} else if (this.activePopoverTab === 'employee') {
			this.renderEngineOptionListBody({
				roleTitle: localize('adeEngEmpRoleSubtitle', "Single-Node Reviewer · L3"),
				current: draftNode.employee ?? { engine: 'claude-code', thinking: 'medium' },
				disabled: isLocked,
				onOpenSession: () => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, draftNode.id, 'employee');
					}
				},
				onChange: next => updateNodeDraft({ employee: next }),
				runtime,
			});
		} else {
			this.renderEngineOptionListBody({
				roleTitle: localize('adeEngWrkRoleSubtitle', "Pure Native Executor · L4"),
				current: draftNode.worker ?? { engine: 'claude-code', thinking: 'high' },
				disabled: isLocked,
				onOpenSession: () => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, draftNode.id, 'worker');
					}
				},
				onChange: next => updateNodeDraft({ worker: next }),
				runtime,
			});
		}

		this.positionPopoverNearAnchor();
	}

	private renderEngineOptionListBody(params: {
		readonly roleTitle: string;
		readonly current: { readonly engine: string; readonly model?: string; readonly thinking: AdeThinkingLevel };
		readonly disabled: boolean;
		readonly onOpenSession: () => void;
		readonly onChange: (next: { engine: string; model?: string; thinking: AdeThinkingLevel }) => void;
		readonly runtime: IAdeEngineeringNodeRuntimeState | undefined;
	}): void {
		const normEngine = normalizeBlueprintEngine(params.current.engine);
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body'));

		// Role Subtitle + Direct Open Session Link
		const subRow = append(body, $('.ade-eng-pop-subrow'));
		append(subRow, $('span.ade-eng-pop-role-desc', {}, params.roleTitle));
		const openBtn = append(subRow, $('button.ade-eng-pop-open-link', {
			type: 'button',
		}, localize('adeEngOpenRoleChat', "Open Session ↗")));
		this.popoverRenderDisposables.add(addDisposableListener(openBtn, EventType.CLICK, params.onOpenSession));

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
		this.popoverRenderDisposables.add(addDisposableListener(modelInput, EventType.CHANGE, () => {
			if (!params.disabled) {
				params.onChange({
					engine: normEngine,
					...(modelInput.value.trim() ? { model: modelInput.value.trim() } : {}),
					thinking: params.current.thinking,
				});
			}
		}));

		// 4. Compact Runtime Telemetry & Token Consumption Card at Footer
		if (params.runtime) {
			this.renderNodeTokenUsageCard(body, params.runtime);
			append(
				body,
				$('div.ade-eng-pop-telemetry', {}, `Phase: ${params.runtime.phase} · Rework ${params.runtime.employeeRejectCount}/3 · Fail ${params.runtime.formalFailureCount}/3`),
			);
		}
	}

	private renderNodeTokenUsageCard(parent: HTMLElement, runtime: IAdeEngineeringNodeRuntimeState): void {
		const usage = runtime.tokenUsage;
		const total: IAdeTokenUsage | undefined = usage?.total;
		const totalTok = total?.totalTokens ?? 0;
		const card = append(parent, $(`div.ade-eng-pop-tokens-card${totalTok > 0 ? '.has-usage' : ''}`));
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
			append(rolesRow, $('span.ade-eng-pop-role-tok', {}, `W: ${formatCompactTokenCount(usage?.worker.totalTokens ?? 0)}`));
			append(rolesRow, $('span.ade-eng-pop-role-tok', {}, `E: ${formatCompactTokenCount(usage?.employee.totalTokens ?? 0)}`));
			append(rolesRow, $('span.ade-eng-pop-role-tok', {}, `M: ${formatCompactTokenCount(usage?.manager.totalTokens ?? 0)}`));
		}
	}

	private renderTaskSpecPopoverBody(
		node: IAdeEngineeringBlueprintNode,
		runtime: IAdeEngineeringNodeRuntimeState | undefined,
		isLocked: boolean,
		updateNodeDraft: (patch: Partial<IAdeEngineeringBlueprintNode>) => void,
	): void {
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body.scrollable'));
		if (isLocked) {
			append(body, $('div.ade-eng-lock-banner', {}, localize('adeEngCompletedLockNotice', "Completed & locked — task prompt and incoming edges are immutable.")));
		}

		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngGoalShortLabel', "Worker Task Goal")));
		const goalArea = append(body, $('textarea.ade-eng-textarea', {
			rows: 3,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLTextAreaElement;
		goalArea.value = node.goal ?? '';
		this.popoverRenderDisposables.add(addDisposableListener(goalArea, EventType.CHANGE, () => {
			updateNodeDraft({ goal: goalArea.value });
		}));

		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngAccShortLabel', "Acceptance Criteria")));
		const accArea = append(body, $('textarea.ade-eng-textarea', {
			rows: 2,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLTextAreaElement;
		accArea.value = node.acceptance ?? '';
		this.popoverRenderDisposables.add(addDisposableListener(accArea, EventType.CHANGE, () => {
			updateNodeDraft({ acceptance: accArea.value });
		}));

		if (this.draftBlueprint) {
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

		const ownReport = this.snapshot?.state.reports[node.id];
		if (ownReport && !ownReport.stale) {
			append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngNodeReportShort', "Verified Report")));
			append(body, $('div.ade-eng-report-card', {}, ownReport.summary));
		}
		if (runtime?.lastChanges && runtime.lastChanges.touchedFiles.length > 0) {
			append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngTouchedShort', "Touched Files ({0})", runtime.lastChanges.touchedFiles.length)));
			for (const f of runtime.lastChanges.touchedFiles) {
				append(body, $('div.ade-eng-file-pill', {}, `[${f.kind.toUpperCase()}] ${f.relativePath}`));
			}
		}
	}

	private renderGatePopoverBody(
		node: IAdeEngineeringBlueprintNode,
		runtime: IAdeEngineeringNodeRuntimeState | undefined,
		isLocked: boolean,
		updateNodeDraft: (patch: Partial<IAdeEngineeringBlueprintNode>) => void,
	): void {
		const body = append(this.popoverContentEl, $('.ade-eng-pop-body.scrollable'));
		append(body, $('div.ade-eng-pop-section-label', {}, localize('adeEngGateDescShort', "Gate Inspection Instructions")));
		const descArea = append(body, $('textarea.ade-eng-textarea', {
			rows: 2,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLTextAreaElement;
		descArea.value = node.description ?? '';
		this.popoverRenderDisposables.add(addDisposableListener(descArea, EventType.CHANGE, () => {
			updateNodeDraft({ description: descArea.value });
		}));

		if (runtime?.phase === 'waiting_user_gate' && this.activeGovernorId && this.draftBlueprint) {
			const govId = this.activeGovernorId;
			const decisionWrap = append(body, $('.ade-eng-gate-pop-actions'));
			const approveBtn = append(decisionWrap, $('button.ade-eng-action-btn.run.full-width', {
				type: 'button',
			}, localize('adeEngApproveGatePopBtn', "✓ Approve & Continue Downstream")));
			this.popoverRenderDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, () => {
				void this.engineering.submitGateVerdict({
					governorSessionId: govId,
					nodeId: node.id,
					verdict: 'pass',
				});
			}));

			const candidates = listUpstreamTaskAncestors(node.id, this.draftBlueprint);
			if (candidates.length > 0) {
				const rbRow = append(decisionWrap, $('.ade-eng-form-row'));
				const targetSelect = append(rbRow, $('select.ade-eng-select')) as HTMLSelectElement;
				for (const c of candidates) {
					append(targetSelect, $('option', { value: c.id }, `↩ [${c.id}] ${c.title}`));
				}
				const rbBtn = append(rbRow, $('button.ade-eng-action-btn.danger', {
					type: 'button',
				}, localize('adeEngRollbackShortBtn', "Rollback")));
				const fbInput = append(decisionWrap, $('input.ade-eng-pop-model-input', {
					type: 'text',
					placeholder: localize('adeEngRollbackReasonPh', "Revision instructions for target Worker..."),
				})) as HTMLInputElement;
				this.popoverRenderDisposables.add(addDisposableListener(rbBtn, EventType.CLICK, () => {
					void this.engineering.submitGateVerdict({
						governorSessionId: govId,
						nodeId: node.id,
						verdict: 'rollback',
						targetNodeId: targetSelect.value,
						feedback: fbInput.value.trim() || undefined,
					});
				}));
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
		this.positionPopoverNearAnchor();
	}
}
