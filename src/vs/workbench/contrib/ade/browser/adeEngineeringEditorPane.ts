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
	AdeEngineeringNodeVisualStatus,
	AdeThinkingLevel,
	IAdeEngineeringBlueprint,
	IAdeEngineeringBlueprintEdge,
	IAdeEngineeringBlueprintNode,
	IAdeEngineeringManagerSegment,
	IAdeEngineeringNodeRuntimeState,
	IAdeEngineeringService,
	IAdeEngineeringTreeSnapshot,
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

const ENGINE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'codex', label: 'Codex' },
	{ value: 'antigravity', label: 'Google Antigravity' },
	{ value: 'kilo', label: 'Kilo Code' },
	{ value: 'opencode', label: 'OpenCode' },
	{ value: 'dsh', label: 'DeepSeek Harness' },
	{ value: 'cline', label: 'Cline' },
	{ value: 'pi', label: 'Pi' },
];

const THINKING_OPTIONS: readonly { readonly value: AdeThinkingLevel; readonly label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'low', label: 'Low' },
	{ value: 'medium', label: 'Medium' },
	{ value: 'high', label: 'High' },
	{ value: 'max', label: 'Max' },
];

const TASK_NODE_DIAMETER = 82;
const GATE_NODE_WIDTH = 172;

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
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private segmentsLayerEl!: HTMLElement;
	private edgesSvgEl!: SVGSVGElement;
	private edgesDefsEl!: SVGDefsElement;
	private edgesGroupEl!: SVGGElement;
	private rubberBandPathEl!: SVGPathElement;
	private nodesLayerEl!: HTMLElement;
	private drawerEl!: HTMLElement;
	private drawerContentEl!: HTMLElement;
	private bannerEl!: HTMLElement;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly canvasRenderDisposables = this._register(new DisposableStore());
	private readonly drawerRenderDisposables = this._register(new DisposableStore());

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

	private hoveredOrSelectedNodeId: string | undefined;
	private drawerTab: 'status' | 'config' = 'status';
	private isPointerInNode = false;
	private isPointerInDrawer = false;
	private drawerCloseTimer: ReturnType<typeof setTimeout> | undefined;

	private nodeDomById = new Map<string, HTMLElement>();
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
			this.renderDrawer();
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
				if (this.hoveredOrSelectedNodeId) {
					this.renderDrawer();
				}
			}
		} catch {
			// Command may not be registered in standalone unit-test harnesses.
		}
	}

	override dispose(): void {
		if (this.drawerCloseTimer !== undefined) {
			clearTimeout(this.drawerCloseTimer);
			this.drawerCloseTimer = undefined;
		}
		super.dispose();
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

		this.drawerEl = append(this.bodyEl, $('.ade-eng-drawer'));
		this.drawerContentEl = append(this.drawerEl, $('.ade-eng-drawer-inner'));

		this.installViewportInteractions();
		this.installDrawerHoverKeep();
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
			panning = true;
			startClientX = e.clientX;
			startClientY = e.clientY;
			startPanX = this.panX;
			startPanY = this.panY;
			this.viewportEl.classList.add('panning');
			try {
				this.viewportEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic test events may not register pointerId */ }
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
				this.renderToolbar();
			} else {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.applyWorldTransform();
			}
		}, { passive: false }));
	}

	private installDrawerHoverKeep(): void {
		this._register(addDisposableListener(this.drawerEl, EventType.MOUSE_ENTER, () => {
			this.isPointerInDrawer = true;
			this.cancelDrawerClose();
		}));
		this._register(addDisposableListener(this.drawerEl, EventType.MOUSE_LEAVE, () => {
			this.isPointerInDrawer = false;
			this.scheduleDrawerCloseIfIdle();
		}));
		this._register(addDisposableListener(this.drawerEl, EventType.FOCUS_OUT, () => {
			setTimeout(() => {
				if (!this.isPointerInDrawer && !this.isPointerInNode && !this.isFocusInsideDrawer()) {
					this.scheduleDrawerCloseIfIdle();
				}
			}, 120);
		}));
	}

	private isFocusInsideDrawer(): boolean {
		const active = getWindow(this.rootEl).document.activeElement;
		return Boolean(active && this.drawerEl.contains(active) && (
			active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT'
		));
	}

	private cancelDrawerClose(): void {
		if (this.drawerCloseTimer !== undefined) {
			clearTimeout(this.drawerCloseTimer);
			this.drawerCloseTimer = undefined;
		}
	}

	private scheduleDrawerCloseIfIdle(): void {
		this.cancelDrawerClose();
		this.drawerCloseTimer = setTimeout(() => {
			this.drawerCloseTimer = undefined;
			if (!this.isPointerInNode && !this.isPointerInDrawer && !this.isFocusInsideDrawer()) {
				this.closeDrawer();
			}
		}, 340);
	}

	private openDrawerForNode(nodeId: string, preferredTab?: 'status' | 'config'): void {
		this.cancelDrawerClose();
		const changedNode = this.hoveredOrSelectedNodeId !== nodeId;
		this.hoveredOrSelectedNodeId = nodeId;
		if (preferredTab) {
			this.drawerTab = preferredTab;
		} else if (changedNode && this.isDraftDirty) {
			// Keep current tab preference smoothly
		}
		this.drawerEl.classList.add('open');
		for (const [id, el] of this.nodeDomById) {
			el.classList.toggle('inspected', id === nodeId);
		}
		this.renderDrawer();
	}

	private closeDrawer(): void {
		this.hoveredOrSelectedNodeId = undefined;
		this.drawerEl.classList.remove('open');
		for (const el of this.nodeDomById.values()) {
			el.classList.remove('inspected');
		}
	}

	override async setInput(input: AdeEngineeringEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputDisposables.clear();
		this.activeGovernorId = input.governorSessionId;
		this.isDraftDirty = false;
		this.connectMode = false;
		this.connectSourceNodeId = undefined;

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
		this.canvasRenderDisposables.clear();
		this.drawerRenderDisposables.clear();
		this.activeGovernorId = undefined;
		this.snapshot = undefined;
		this.draftBlueprint = undefined;
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
		if (this.hoveredOrSelectedNodeId) {
			if (this.draftBlueprint?.nodes.some(n => n.id === this.hoveredOrSelectedNodeId)) {
				this.renderDrawer();
			} else {
				this.closeDrawer();
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
		if (this.hoveredOrSelectedNodeId) {
			this.renderDrawer();
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
	}

	private fitViewportToGraph(): void {
		if (!this.draftBlueprint || this.draftBlueprint.nodes.length === 0 || !this.lastDimension) {
			this.panX = 48;
			this.panY = 36;
			this.zoom = 1;
			this.applyWorldTransform();
			this.renderToolbar();
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of this.draftBlueprint.nodes) {
			const x = n.position?.x ?? 180;
			const y = n.position?.y ?? 240;
			minX = Math.min(minX, x - 90);
			minY = Math.min(minY, y - 80);
			maxX = Math.max(maxX, x + 130);
			maxY = Math.max(maxY, y + 110);
		}
		const availW = Math.max(320, this.lastDimension.width - 80);
		const availH = Math.max(240, this.lastDimension.height - 110);
		const graphW = Math.max(200, maxX - minX);
		const graphH = Math.max(160, maxY - minY);
		const scale = Math.min(1.15, Math.max(0.45, Math.min(availW / graphW, availH / graphH)));
		this.zoom = Math.round(scale * 100) / 100;
		this.panX = Math.round((availW - graphW * this.zoom) / 2 - minX * this.zoom + 40);
		this.panY = Math.round((availH - graphH * this.zoom) / 2 - minY * this.zoom + 20);
		this.applyWorldTransform();
		this.renderToolbar();
	}

	private renderToolbar(): void {
		clearNode(this.toolbarEl);
		const snap = this.snapshot;
		const bp = this.draftBlueprint;
		if (!snap || !bp) {
			append(this.toolbarEl, $('span.ade-eng-toolbar-title', {}, localize('adeEngLoading', "ADE Engineering")));
			return;
		}

		// Left Cluster: Title + Engineering Pill + Run Status + Progress
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
			$('span.ade-eng-progress-pill', {
				title: localize('adeEngProgressTooltip', "Completed nodes & auto-partitioned Manager segments"),
			}, `${snap.progress.completedNodes}/${bp.nodes.length} · ${bp.managers.length} Mgr`),
		);

		// Center Cluster: Graph Authoring & Layout Controls
		const center = append(this.toolbarEl, $('.ade-eng-toolbar-group.center'));

		const makeToolBtn = (icon: ThemeIcon, label: string, onClick: () => void, extraClass = '') => {
			const btn = append(center, $(`button.ade-eng-tool-btn${extraClass ? `.${extraClass}` : ''}`, {
				type: 'button',
				title: label,
			}));
			const ico = append(btn, $('span'));
			ico.classList.add(...ThemeIcon.asClassNameArray(icon));
			if (label) {
				append(btn, $('span.ade-eng-btn-text', {}, label));
			}
			this.canvasRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => onClick()));
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
		makeToolBtn(Codicon.layout, localize('adeEngAutoLayoutBtn', "Auto Layout"), () => this.runAutoLayoutDraft());

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

		const zoomOutBtn = append(center, $('button.ade-eng-icon-btn', { type: 'button', title: localize('adeEngZoomOut', "Zoom Out") }));
		zoomOutBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomOut));
		this.canvasRenderDisposables.add(addDisposableListener(zoomOutBtn, EventType.CLICK, () => {
			this.zoom = Math.max(0.38, Math.round((this.zoom - 0.12) * 100) / 100);
			this.applyWorldTransform();
			this.renderToolbar();
		}));

		const zoomLabelBtn = append(center, $('button.ade-eng-zoom-readout', {
			type: 'button',
			title: localize('adeEngFitView', "Fit Graph in Viewport"),
		}, `${Math.round(this.zoom * 100)}%`));
		this.canvasRenderDisposables.add(addDisposableListener(zoomLabelBtn, EventType.CLICK, () => this.fitViewportToGraph()));

		const zoomInBtn = append(center, $('button.ade-eng-icon-btn', { type: 'button', title: localize('adeEngZoomIn', "Zoom In") }));
		zoomInBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomIn));
		this.canvasRenderDisposables.add(addDisposableListener(zoomInBtn, EventType.CLICK, () => {
			this.zoom = Math.min(2.1, Math.round((this.zoom + 0.12) * 100) / 100);
			this.applyWorldTransform();
			this.renderToolbar();
		}));

		// Right Cluster: Draft Confirm/Cancel Guard + Execution Controls
		const right = append(this.toolbarEl, $('.ade-eng-toolbar-group.right'));

		if (this.isDraftDirty) {
			append(right, $('span.ade-eng-draft-badge', {}, localize('adeEngDraftUnsaved', "Draft Unsaved")));

			const cancelBtn = append(right, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
			}, localize('adeEngCancelDraftBtn', "Cancel")));
			this.canvasRenderDisposables.add(addDisposableListener(cancelBtn, EventType.CLICK, () => {
				this.hideBanner();
				this.reloadFromService(true);
			}));

			const confirmBtn = append(right, $('button.ade-eng-action-btn.confirm', {
				type: 'button',
			}, localize('adeEngConfirmDraftBtn', "Confirm")));
			this.canvasRenderDisposables.add(addDisposableListener(confirmBtn, EventType.CLICK, () => {
				void this.confirmDraftChanges();
			}));
		}

		const runStatus = snap.state.runStatus;
		if (runStatus === 'running') {
			const pauseBtn = append(right, $('button.ade-eng-action-btn.secondary', { type: 'button' }));
			const pauseIco = append(pauseBtn, $('span'));
			pauseIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugPause));
			append(pauseBtn, $('span', {}, localize('adeEngPauseBtn', "Pause")));
			this.canvasRenderDisposables.add(addDisposableListener(pauseBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.pauseTree(this.activeGovernorId);
				}
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.danger', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.canvasRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.stopTree(this.activeGovernorId);
				}
			}));
		} else if (runStatus === 'paused' || runStatus === 'waiting_gate') {
			const resumeBtn = append(right, $('button.ade-eng-action-btn.run', { type: 'button' }));
			const resumeIco = append(resumeBtn, $('span'));
			resumeIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.play));
			append(resumeBtn, $('span', {}, localize('adeEngResumeBtn', "Resume")));
			this.canvasRenderDisposables.add(addDisposableListener(resumeBtn, EventType.CLICK, () => {
				if (this.activeGovernorId) {
					void this.engineering.resumeTree(this.activeGovernorId, 'user');
				}
			}));

			const stopBtn = append(right, $('button.ade-eng-action-btn.secondary', { type: 'button' }));
			const stopIco = append(stopBtn, $('span'));
			stopIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStop));
			append(stopBtn, $('span', {}, localize('adeEngStopBtn', "Stop")));
			this.canvasRenderDisposables.add(addDisposableListener(stopBtn, EventType.CLICK, () => {
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
			this.canvasRenderDisposables.add(addDisposableListener(runBtn, EventType.CLICK, () => {
				void this.handleRunClicked();
			}));
		}
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
				// Spec 6.4: Prompt user before force-stopping active running Worker(s) and re-partitioning Managers!
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
				} catch (retryErr) {
					this.showBanner(retryErr instanceof Error ? retryErr.message : String(retryErr), 'error');
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
		const prefix = type === 'user_gate' ? 'U' : 'N';
		let index = 1;
		const existingIds = new Set(this.draftBlueprint.nodes.map(n => n.id));
		while (existingIds.has(`${prefix}${index}`)) {
			index++;
		}
		const newId = `${prefix}${index}`;

		const maxX = this.draftBlueprint.nodes.reduce((acc, n) => Math.max(acc, n.position?.x ?? 180), 100);
		const pos = {
			x: this.draftBlueprint.nodes.length === 0 ? 180 : maxX + 250,
			y: 240 + ((index % 3) - 1) * 70,
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
		this.openDrawerForNode(newId, 'config');
	}

	private deleteDraftNode(nodeId: string): void {
		if (!this.draftBlueprint || this.isNodeCompletedLocked(nodeId)) {
			return;
		}
		const remainingNodes = this.draftBlueprint.nodes.filter(n => n.id !== nodeId);
		const remainingEdges = this.draftBlueprint.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
		if (this.hoveredOrSelectedNodeId === nodeId) {
			this.closeDrawer();
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
				title: localize('adeEngManagerHeaderTooltip', "Auto-Partitioned Manager Segment [{0}] — Click to open Manager conversation", seg.segmentId),
			}));
			const mgrGlyph = append(header, $('span'));
			this.applyEngineIconToElement(mgrGlyph, seg.config.engine);
			append(header, $('span.ade-eng-segment-label', {}, `Mgr [${seg.segmentId}] · ${seg.config.thinking}`));
			this.canvasRenderDisposables.add(addDisposableListener(header, EventType.CLICK, e => {
				EventHelper.stop(e, true);
				if (this.activeGovernorId && segNodes[0]) {
					void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, segNodes[0].id, 'manager');
				}
			}));
		}

		// 2. Render Edges (Spec 3.6 Matrix)
		this.renderEdgesOnly();

		// 3. Render Nodes (Dual-Core Concentric Circles + Hexagonal User Gates)
		for (const node of bp.nodes) {
			const runtime: IAdeEngineeringNodeRuntimeState | undefined = runtimes[node.id];
			const visualStatus = computeNodeVisualStatus(node, runtime);
			const isLocked = Boolean(runtime?.completed);

			const cx = node.position?.x ?? 180;
			const cy = node.position?.y ?? 240;

			const nodeEl = append(this.nodesLayerEl, $(`div.ade-eng-node.type-${node.type}.status-${visualStatus}${isLocked ? '.locked' : ''}${this.hoveredOrSelectedNodeId === node.id ? '.inspected' : ''}${this.connectSourceNodeId === node.id ? '.connect-source' : ''}`, {
				'data-node-id': node.id,
				'data-visual-status': visualStatus,
			}));
			nodeEl.style.left = `${Math.round(cx)}px`;
			nodeEl.style.top = `${Math.round(cy)}px`;
			this.nodeDomById.set(node.id, nodeEl);

			// Input & Output Ports
			const inPort = append(nodeEl, $('div.ade-eng-port.port-in', {
				title: localize('adeEngPortInTooltip', "Input Port ({0})", node.id),
			}));
			const outPort = append(nodeEl, $('div.ade-eng-port.port-out', {
				title: localize('adeEngPortOutTooltip', "Drag to connect from {0}", node.id),
			}));

			this.installPortWiring(node, outPort, inPort);

			if (node.type === 'user_gate') {
				const gateBody = append(nodeEl, $('div.ade-eng-gate-body.ade-pistol-cursor'));
				const gateIcon = append(gateBody, $('span.ade-eng-gate-icon'));
				gateIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.verifiedFilled));
				const gateTextWrap = append(gateBody, $('div.ade-eng-gate-text'));
				append(gateTextWrap, $('span.ade-eng-gate-kicker', {}, runtime?.phase === 'waiting_user_gate'
					? localize('adeEngGateWaitingKicker', "AWAITING APPROVAL")
					: localize('adeEngGateKicker', "USER GATE")));
				append(gateTextWrap, $('span.ade-eng-gate-title', {}, node.title));
			} else {
				// Dual-Core Concentric Circle Design (Spec 6.2)
				const concentric = append(nodeEl, $('div.ade-eng-concentric.ade-pistol-cursor'));

				// Outer Ring SVG (Employee L3 Status Ring + Animated Progress Arc)
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

				// Inner Core Disc (Worker L4 Native Engine Icon)
				const innerCore = append(concentric, $('div.ade-eng-inner-core', {
					title: localize('adeEngWorkerCoreTooltip', "Worker (L4 · Pure Native Context): {0} — Left-click to open Worker session", node.worker?.engine ?? 'codex'),
				}));
				const workerGlyph = append(innerCore, $('span'));
				this.applyEngineIconToElement(workerGlyph, node.worker?.engine);

				// Outer Ring Satellite Badge (Employee L3 Engine Icon)
				const empSatellite = append(concentric, $('div.ade-eng-emp-satellite', {
					title: localize('adeEngEmployeeSatTooltip', "Employee Reviewer (L3): {0} — Click to open Employee session", node.employee?.engine ?? 'claude-code'),
				}));
				const empGlyph = append(empSatellite, $('span'));
				this.applyEngineIconToElement(empGlyph, node.employee?.engine);

				// Critical Star Crown Badge
				if (node.critical) {
					append(concentric, $('span.ade-eng-critical-badge', {
						title: localize('adeEngCriticalBadgeTooltip', "★ Critical Node — Triggers Segment Manager Secondary Review"),
					}, '★'));
				}

				// Completed Check / Lock or Failure Tier Pill on Ring
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

				// Caption Below Concentric Circle
				const caption = append(nodeEl, $('div.ade-eng-node-caption'));
				append(caption, $('span.ade-eng-node-title', {}, `[${node.id}] ${node.title}`));
				const subMeta = `${node.worker?.engine ?? 'codex'}:${node.worker?.thinking ?? 'high'}`;
				append(caption, $('span.ade-eng-node-sub', {}, subMeta));
			}

			this.installNodeHoverDragAndClick(node, nodeEl);
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

	private installNodeHoverDragAndClick(node: IAdeEngineeringBlueprintNode, nodeEl: HTMLElement): void {
		// Spec 6.3(a): Zero-click Hover opens Right Drawer automatically
		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.MOUSE_ENTER, () => {
			this.isPointerInNode = true;
			this.openDrawerForNode(node.id);
		}));
		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.MOUSE_LEAVE, () => {
			this.isPointerInNode = false;
			this.scheduleDrawerCloseIfIdle();
		}));

		let dragging = false;
		let movedBeyondClickThreshold = false;
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
				// Re-render segment halos cleanly after drag finishes
				this.renderCanvas();
				return;
			}

			// Spec 6.3(b): Clean Single Left-Click immediately jumps to the node's Coding Agent session!
			const clickedTarget = e.target as HTMLElement | null;
			if (node.type === 'task' && this.activeGovernorId) {
				const clickedEmp = Boolean(clickedTarget?.closest('.ade-eng-emp-satellite'));
				void this.engineering.ensureNodeAgentSessionOpen(
					this.activeGovernorId,
					node.id,
					clickedEmp ? 'employee' : 'worker',
				);
			} else {
				this.openDrawerForNode(node.id, 'status');
			}
		};

		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_UP, finishPointer));
		this.canvasRenderDisposables.add(addDisposableListener(nodeEl, 'pointercancel', () => { dragging = false; }));
	}

	private renderDrawer(): void {
		this.drawerRenderDisposables.clear();
		clearNode(this.drawerContentEl);

		const nodeId = this.hoveredOrSelectedNodeId;
		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!nodeId || !bp || !snap) {
			return;
		}
		const node = bp.nodes.find(n => n.id === nodeId);
		if (!node) {
			return;
		}
		const runtime = snap.state.nodes[node.id];
		const visualStatus: AdeEngineeringNodeVisualStatus = computeNodeVisualStatus(node, runtime);
		const isLocked = Boolean(runtime?.completed);
		const seg: IAdeEngineeringManagerSegment | undefined = bp.managers.find(m => m.nodeIds.includes(node.id));
		const upstreamReports = snap.nodes.find(n => n.node.id === node.id)?.upstreamReports ?? [];

		// Drawer Header
		const header = append(this.drawerContentEl, $('.ade-eng-drawer-header'));
		const titleRow = append(header, $('.ade-eng-drawer-title-row'));
		append(titleRow, $(`span.ade-eng-drawer-badge.status-${visualStatus}`, {}, `[${node.id}] ${visualStatus.toUpperCase()}`));
		if (isLocked) {
			append(titleRow, $('span.ade-eng-lock-pill', {}, localize('adeEngLockedNodePill', "Locked (Completed)")));
		}
		const closeBtn = append(titleRow, $('button.ade-eng-icon-btn.drawer-close', {
			type: 'button',
			title: localize('adeEngCloseDrawer', "Close Drawer"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.drawerRenderDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeDrawer()));

		append(header, $('h3.ade-eng-drawer-heading', {}, node.title));

		// Quick Session Jump Strip (Worker / Employee / Manager)
		if (node.type === 'task' && this.activeGovernorId) {
			const govId = this.activeGovernorId;
			const jumpRow = append(header, $('.ade-eng-drawer-jumps'));
			const addJump = (label: string, role: 'worker' | 'employee' | 'manager') => {
				const btn = append(jumpRow, $('button.ade-eng-jump-btn', { type: 'button' }, label));
				this.drawerRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
					void this.engineering.ensureNodeAgentSessionOpen(govId, node.id, role);
				}));
			};
			addJump(localize('adeEngJumpWorker', "Worker (L4) ↗"), 'worker');
			addJump(localize('adeEngJumpEmployee', "Employee (L3) ↗"), 'employee');
			if (seg) {
				addJump(localize('adeEngJumpManager', "Manager [{0}] ↗", seg.segmentId), 'manager');
			}
		}

		// Sub-tabs: Status & Reports | Configure (Draft)
		const tabsBar = append(this.drawerContentEl, $('.ade-eng-drawer-tabs'));
		const statusTabBtn = append(tabsBar, $(`button.ade-eng-drawer-tab${this.drawerTab === 'status' ? '.active' : ''}`, {
			type: 'button',
		}, localize('adeEngDrawerTabStatus', "Status & Reports")));
		const configTabBtn = append(tabsBar, $(`button.ade-eng-drawer-tab${this.drawerTab === 'config' ? '.active' : ''}`, {
			type: 'button',
		}, localize('adeEngDrawerTabConfig', "Configure (Draft)")));

		this.drawerRenderDisposables.add(addDisposableListener(statusTabBtn, EventType.CLICK, () => {
			this.drawerTab = 'status';
			this.renderDrawer();
		}));
		this.drawerRenderDisposables.add(addDisposableListener(configTabBtn, EventType.CLICK, () => {
			this.drawerTab = 'config';
			this.renderDrawer();
		}));

		const scrollBody = append(this.drawerContentEl, $('.ade-eng-drawer-scroll'));

		if (this.drawerTab === 'status') {
			this.renderDrawerStatusTab(scrollBody, node, runtime, seg, upstreamReports, snap);
		} else {
			this.renderDrawerConfigTab(scrollBody, node, seg, isLocked);
		}
	}

	private renderDrawerStatusTab(
		host: HTMLElement,
		node: IAdeEngineeringBlueprintNode,
		runtime: IAdeEngineeringNodeRuntimeState | undefined,
		seg: IAdeEngineeringManagerSegment | undefined,
		upstreamReports: readonly { nodeId: string; nodeTitle: string; summary: string }[],
		snap: IAdeEngineeringTreeSnapshot,
	): void {
		// Telemetry Grid
		const grid = append(host, $('.ade-eng-kv-grid'));
		const addKv = (k: string, v: string) => {
			const cell = append(grid, $('.ade-eng-kv-cell'));
			append(cell, $('span.ade-eng-kv-key', {}, k));
			append(cell, $('span.ade-eng-kv-val', {}, v));
		};
		addKv(localize('adeEngKvPhase', "Phase"), runtime?.phase ?? 'idle');
		if (node.type === 'task') {
			addKv(localize('adeEngKvSegment', "Manager Segment"), seg?.segmentId ?? '—');
			addKv(localize('adeEngKvInternalRework', "Employee Rework"), `${runtime?.employeeRejectCount ?? 0} / 3`);
			addKv(localize('adeEngKvFormalFailures', "Manager Failures"), `${runtime?.formalFailureCount ?? 0} / 3`);
		}

		// User Gate Decision Controls (Spec 3.5)
		if (node.type === 'user_gate' && this.activeGovernorId) {
			const govId = this.activeGovernorId;
			const gateCard = append(host, $('.ade-eng-drawer-section.gate-decision-box'));
			append(gateCard, $('h4', {}, localize('adeEngGateDecisionHeading', "User Acceptance Gate Decision")));
			append(gateCard, $('p.ade-eng-muted', {}, node.description || localize('adeEngGateDefaultHint', "Approve to unlock downstream tasks, or surgically roll back along a specific upstream branch.")));

			const approveBtn = append(gateCard, $('button.ade-eng-action-btn.run.full-width', {
				type: 'button',
			}, localize('adeEngGateApproveBtn', "Approve & Continue Downstream")));
			this.drawerRenderDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, () => {
				void this.engineering.submitGateVerdict({
					governorSessionId: govId,
					nodeId: node.id,
					verdict: 'pass',
				});
			}));

			const ancestors = listUpstreamTaskAncestors(node.id, snap.blueprint);
			if (ancestors.length > 0) {
				const rbWrap = append(gateCard, $('.ade-eng-rollback-form'));
				append(rbWrap, $('label.ade-eng-field-label', {}, localize('adeEngRollbackTargetLabel', "Surgical Partial Rollback Target (Parallel branches stay untouched)")));
				const selectEl = append(rbWrap, $('select.ade-eng-select')) as HTMLSelectElement;
				for (const anc of ancestors) {
					const opt = append(selectEl, $('option', { value: anc.id }, `[${anc.id}] ${anc.title}`)) as HTMLOptionElement;
					if (anc.id === ancestors[ancestors.length - 1].id) {
						opt.selected = true;
					}
				}
				const fbArea = append(rbWrap, $('textarea.ade-eng-textarea', {
					rows: 2,
					placeholder: localize('adeEngRollbackFeedbackPlaceholder', "Feedback instructions for incremental rework…"),
				})) as HTMLTextAreaElement;
				const rbBtn = append(rbWrap, $('button.ade-eng-action-btn.danger.full-width', {
					type: 'button',
				}, localize('adeEngRollbackSubmitBtn', "Roll Back Selected Path")));
				this.drawerRenderDisposables.add(addDisposableListener(rbBtn, EventType.CLICK, () => {
					void this.engineering.submitGateVerdict({
						governorSessionId: govId,
						nodeId: node.id,
						verdict: 'rollback',
						targetNodeId: selectEl.value,
						feedback: fbArea.value.trim() || undefined,
					});
				}));
			}
		}

		// Latest Feedback / Output
		if (runtime?.lastManagerFeedback || runtime?.lastEmployeeFeedback || runtime?.lastGateFeedback) {
			const fbSec = append(host, $('.ade-eng-drawer-section'));
			append(fbSec, $('h4', {}, localize('adeEngLatestFeedbackHeading', "Latest Review / Gate Feedback")));
			append(fbSec, $('pre.ade-eng-code-box', {}, runtime.lastManagerFeedback || runtime.lastEmployeeFeedback || runtime.lastGateFeedback || ''));
		}

		// Node's Own Report
		const ownReport = snap.state.reports[node.id];
		const repSec = append(host, $('.ade-eng-drawer-section'));
		append(repSec, $('h4', {}, localize('adeEngOwnReportHeading', "Node Report")));
		append(
			repSec,
			$('div.ade-eng-report-card', {}, ownReport && !ownReport.stale
				? ownReport.summary
				: localize('adeEngNoReportYet', "Generated by Employee (L3) after Worker verification passes.")),
		);

		// Upstream Incremental Report Chain (Spec 3.2)
		const upSec = append(host, $('.ade-eng-drawer-section'));
		append(upSec, $('h4', {}, localize('adeEngUpstreamChainHeading', "Upstream Incremental Report Chain ({0})", upstreamReports.length)));
		if (upstreamReports.length === 0) {
			append(upSec, $('p.ade-eng-muted', {}, localize('adeEngNoUpstreamReports', "No completed upstream reports yet.")));
		} else {
			for (const rep of upstreamReports) {
				const item = append(upSec, $('.ade-eng-report-card.upstream'));
				append(item, $('strong', {}, `[${rep.nodeId}] ${rep.nodeTitle}`));
				append(item, $('p', {}, rep.summary));
			}
		}

		// Touched Files Summary
		if (runtime?.lastChanges && runtime.lastChanges.touchedFiles.length > 0) {
			const diffSec = append(host, $('.ade-eng-drawer-section'));
			append(diffSec, $('h4', {}, localize('adeEngTouchedFilesHeading', "Worker Touched Files ({0})", runtime.lastChanges.touchedFiles.length)));
			for (const f of runtime.lastChanges.touchedFiles) {
				append(diffSec, $('div.ade-eng-file-pill', {}, `[${f.kind.toUpperCase()}] ${f.relativePath}`));
			}
		}
	}

	private renderDrawerConfigTab(
		host: HTMLElement,
		node: IAdeEngineeringBlueprintNode,
		seg: IAdeEngineeringManagerSegment | undefined,
		isLocked: boolean,
	): void {
		if (isLocked) {
			append(host, $('div.ade-eng-lock-banner', {}, localize('adeEngCompletedLockNotice', "This node has already completed verification and is strictly locked (Spec 6.4).")));
		}

		const updateNodeDraft = (patch: Partial<IAdeEngineeringBlueprintNode>) => {
			if (!this.draftBlueprint || isLocked) {
				return;
			}
			this.markDraftModified({
				...this.draftBlueprint,
				nodes: this.draftBlueprint.nodes.map(n => n.id === node.id ? { ...n, ...patch } : n),
			});
		};

		// Title
		const titleSec = append(host, $('.ade-eng-drawer-section'));
		append(titleSec, $('label.ade-eng-field-label', {}, localize('adeEngFieldTitle', "Node Title")));
		const titleInput = append(titleSec, $('input.ade-eng-input', {
			type: 'text',
			value: node.title,
			...(isLocked ? { disabled: 'disabled' } : {}),
		})) as HTMLInputElement;
		this.drawerRenderDisposables.add(addDisposableListener(titleInput, EventType.CHANGE, () => {
			if (titleInput.value.trim()) {
				updateNodeDraft({ title: titleInput.value.trim() });
			}
		}));

		if (node.type === 'user_gate') {
			const descSec = append(host, $('.ade-eng-drawer-section'));
			append(descSec, $('label.ade-eng-field-label', {}, localize('adeEngGateDescLabel', "Gate Inspection Instructions")));
			const descArea = append(descSec, $('textarea.ade-eng-textarea', {
				rows: 4,
				...(isLocked ? { disabled: 'disabled' } : {}),
			})) as HTMLTextAreaElement;
			descArea.value = node.description ?? '';
			this.drawerRenderDisposables.add(addDisposableListener(descArea, EventType.CHANGE, () => {
				updateNodeDraft({ description: descArea.value });
			}));
		} else {
			// Critical Checkbox
			const critRow = append(titleSec, $('label.ade-eng-checkbox-row'));
			const critBox = append(critRow, $('input', {
				type: 'checkbox',
				...(isLocked ? { disabled: 'disabled' } : {}),
			})) as HTMLInputElement;
			critBox.checked = Boolean(node.critical);
			append(critRow, $('span', {}, localize('adeEngCriticalCheckbox', "★ Critical Gate (triggers Segment Manager secondary review)")));
			this.drawerRenderDisposables.add(addDisposableListener(critBox, EventType.CHANGE, () => {
				updateNodeDraft({ critical: critBox.checked });
			}));

			// Role Model Config Helper
			const renderRoleConfigurator = (
				heading: string,
				current: { engine: string; model?: string; thinking: AdeThinkingLevel },
				onChange: (next: { engine: string; model?: string; thinking: AdeThinkingLevel }) => void,
				disabled = isLocked,
			) => {
				const sec = append(host, $('.ade-eng-drawer-section.role-box'));
				append(sec, $('h4', {}, heading));

				const row = append(sec, $('.ade-eng-form-row'));
				const engSelect = append(row, $('select.ade-eng-select', {
					...(disabled ? { disabled: 'disabled' } : {}),
				})) as HTMLSelectElement;
				const normCurrentEng = normalizeBlueprintEngine(current.engine);
				for (const opt of ENGINE_OPTIONS) {
					const el = append(engSelect, $('option', { value: opt.value }, opt.label)) as HTMLOptionElement;
					if (opt.value === normCurrentEng) {
						el.selected = true;
					}
				}

				const thinkSelect = append(row, $('select.ade-eng-select.compact', {
					...(disabled ? { disabled: 'disabled' } : {}),
				})) as HTMLSelectElement;
				for (const opt of THINKING_OPTIONS) {
					const el = append(thinkSelect, $('option', { value: opt.value }, opt.label)) as HTMLOptionElement;
					if (opt.value === current.thinking) {
						el.selected = true;
					}
				}

				const listId = `ade-eng-models-${this.nextDatalistId++}`;
				const modelInput = append(sec, $('input.ade-eng-input', {
					type: 'text',
					list: listId,
					placeholder: localize('adeEngModelPlaceholder', "Model (optional, e.g. deepseek-flash[1m] / gpt-5-codex)"),
					value: current.model ?? '',
					...(disabled ? { disabled: 'disabled' } : {}),
				})) as HTMLInputElement;
				const datalistEl = append(sec, $('datalist', { id: listId }));
				const populateDatalist = (engineKey: string) => {
					clearNode(datalistEl);
					for (const m of this.configuredModelsByEngine[engineKey] ?? []) {
						append(datalistEl, $('option', { value: m.id }, m.label));
					}
				};
				populateDatalist(normCurrentEng);

				const emit = () => {
					populateDatalist(engSelect.value);
					onChange({
						engine: engSelect.value,
						...(modelInput.value.trim() ? { model: modelInput.value.trim() } : {}),
						thinking: normalizeThinkingLevel(thinkSelect.value, current.thinking),
					});
				};
				this.drawerRenderDisposables.add(addDisposableListener(engSelect, EventType.CHANGE, emit));
				this.drawerRenderDisposables.add(addDisposableListener(thinkSelect, EventType.CHANGE, emit));
				this.drawerRenderDisposables.add(addDisposableListener(modelInput, EventType.CHANGE, emit));
			};

			renderRoleConfigurator(
				localize('adeEngWorkerConfigHeading', "Worker (L4 · 100% Pure Native Executor)"),
				node.worker ?? { engine: 'codex', thinking: 'high' },
				next => updateNodeDraft({ worker: next }),
			);

			renderRoleConfigurator(
				localize('adeEngEmployeeConfigHeading', "Employee (L3 · Single-Node Reviewer)"),
				node.employee ?? { engine: 'claude-code', thinking: 'medium' },
				next => updateNodeDraft({ employee: next }),
			);

			if (seg && this.draftBlueprint) {
				const bpRef = this.draftBlueprint;
				renderRoleConfigurator(
					localize('adeEngManagerConfigHeading', "Segment Manager (L2 · [{0}])", seg.segmentId),
					seg.config,
					next => {
						this.markDraftModified({
							...bpRef,
							managers: bpRef.managers.map(m => m.segmentId === seg.segmentId ? { ...m, config: next } : m),
						});
					},
					false,
				);
			}

			// Goal & Acceptance Prompts
			const goalSec = append(host, $('.ade-eng-drawer-section'));
			append(goalSec, $('label.ade-eng-field-label', {}, localize('adeEngGoalLabel', "Worker Task Goal (Static Business Prompt)")));
			const goalArea = append(goalSec, $('textarea.ade-eng-textarea', {
				rows: 4,
				...(isLocked ? { disabled: 'disabled' } : {}),
			})) as HTMLTextAreaElement;
			goalArea.value = node.goal ?? '';
			this.drawerRenderDisposables.add(addDisposableListener(goalArea, EventType.CHANGE, () => {
				updateNodeDraft({ goal: goalArea.value });
			}));

			const accSec = append(host, $('.ade-eng-drawer-section'));
			append(accSec, $('label.ade-eng-field-label', {}, localize('adeEngAcceptanceLabel', "Acceptance Criteria")));
			const accArea = append(accSec, $('textarea.ade-eng-textarea', {
				rows: 3,
				...(isLocked ? { disabled: 'disabled' } : {}),
			})) as HTMLTextAreaElement;
			accArea.value = node.acceptance ?? '';
			this.drawerRenderDisposables.add(addDisposableListener(accArea, EventType.CHANGE, () => {
				updateNodeDraft({ acceptance: accArea.value });
			}));
		}

		// Outgoing Connections Editor (Draft)
		if (this.draftBlueprint) {
			const connSec = append(host, $('.ade-eng-drawer-section'));
			append(connSec, $('label.ade-eng-field-label', {}, localize('adeEngOutgoingEdgesLabel', "Downstream Connections")));
			const outgoing = this.draftBlueprint.edges.filter(e => e.from === node.id);
			const chipsWrap = append(connSec, $('.ade-eng-edge-chips'));
			for (const edge of outgoing) {
				const chip = append(chipsWrap, $('span.ade-eng-edge-chip', {}, `→ ${edge.to}`));
				if (!this.isNodeCompletedLocked(edge.to)) {
					const rmBtn = append(chip, $('button.ade-eng-chip-rm', { type: 'button', title: localize('adeEngRemoveEdge', "Remove Edge") }, '×'));
					this.drawerRenderDisposables.add(addDisposableListener(rmBtn, EventType.CLICK, () => {
						this.removeDraftEdge(edge.from, edge.to);
					}));
				}
			}

			const candidates = this.draftBlueprint.nodes.filter(
				cand => cand.id !== node.id
					&& !this.isNodeCompletedLocked(cand.id)
					&& !outgoing.some(e => e.to === cand.id),
			);
			if (candidates.length > 0) {
				const addRow = append(connSec, $('.ade-eng-form-row'));
				const targetSelect = append(addRow, $('select.ade-eng-select')) as HTMLSelectElement;
				for (const cand of candidates) {
					append(targetSelect, $('option', { value: cand.id }, `[${cand.id}] ${cand.title}`));
				}
				const addEdgeBtn = append(addRow, $('button.ade-eng-action-btn.secondary', {
					type: 'button',
				}, localize('adeEngConnectTargetBtn', "+ Connect")));
				this.drawerRenderDisposables.add(addDisposableListener(addEdgeBtn, EventType.CLICK, () => {
					if (targetSelect.value) {
						this.tryAddDraftEdge(node.id, targetSelect.value);
					}
				}));
			}
		}

		// Delete Node Button
		if (!isLocked) {
			const delSec = append(host, $('.ade-eng-drawer-section'));
			const delBtn = append(delSec, $('button.ade-eng-action-btn.danger.full-width', {
				type: 'button',
			}, localize('adeEngDeleteNodeDraftBtn', "Delete Node (Draft)")));
			this.drawerRenderDisposables.add(addDisposableListener(delBtn, EventType.CLICK, () => {
				this.deleteDraftNode(node.id);
			}));
		}
	}

	override focus(): void {
		this.rootEl?.focus();
	}

	layout(dimension: Dimension): void {
		this.lastDimension = dimension;
		this.rootEl.style.width = `${dimension.width}px`;
		this.rootEl.style.height = `${dimension.height}px`;
	}
}
