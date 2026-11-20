/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	computeMissionAutoLayout,
	computeMissionWorldSize,
	computeOrthogonalRoundedEdgeRoute,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionEdgeObstacle,
	IMissionNodePosition,
	MISSION_GATE_NODE_HEIGHT,
	MISSION_GATE_NODE_WIDTH,
	MISSION_TASK_NODE_HEIGHT,
	MISSION_TASK_NODE_WIDTH,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, getMissionDisplayName } from '../../../../platform/ade/common/adeRoleSchema.js';
import { formatTierTag } from '../../../../platform/ade/common/adeRankResize.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_ENGINEERING_SCHEME, ADE_REMOVE_MISSION_COMMAND_ID, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionService } from './adeMissionStore.js';
import './media/adeMissionCanvas.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const MERMAID_PLACEHOLDER = [
	'flowchart LR',
	'  N1["Design Architecture"] --> N2["Core Engine"]',
	'  N1 --> N3["UI Canvas"]',
	'  N2 --> N4["Integration"]',
	'  N3 --> N4',
].join('\n');

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string>): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			el.setAttribute(k, v);
		}
	}
	return el;
}

function getNodeSize(node: IMissionDagNode): { readonly width: number; readonly height: number } {
	return node.kind === 'gate'
		? { width: MISSION_GATE_NODE_WIDTH, height: MISSION_GATE_NODE_HEIGHT }
		: { width: MISSION_TASK_NODE_WIDTH, height: MISSION_TASK_NODE_HEIGHT };
}

export class AdeEngineeringEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeEngineering';
	override readonly resource: URI;
	private readonly missionService: IAdeMissionService | undefined;
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;

	constructor(
		readonly governorSessionId: string,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.resource = URI.from({ scheme: ADE_ENGINEERING_SCHEME, path: `/${governorSessionId}` });
		const tryGet = <T>(id: ServiceIdentifier<T>): T | undefined => instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(id);
			} catch {
				return undefined;
			}
		});
		this.missionService = tryGet(IAdeMissionService);
		this.roleSchemaService = tryGet(IAdeRoleSchemaService);
		this._register(projects.onDidChange(() => this._onDidChangeLabel.fire()));
		if (this.missionService) {
			this._register(this.missionService.onDidChange(() => this._onDidChangeLabel.fire()));
		}
		if (this.roleSchemaService) {
			this._register(this.roleSchemaService.onDidChangeSchema(() => this._onDidChangeLabel.fire()));
		}
	}

	override get typeId(): string {
		return AdeEngineeringEditorInput.ID;
	}

	override getName(): string {
		const missionAlias = getMissionDisplayName(this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG);
		const record = this.missionService?.getMission(this.governorSessionId);
		const linkedAgent = this.projects.getAgent(this.governorSessionId);
		const base = record?.title ?? linkedAgent?.label ?? missionAlias;
		return localize('adeMissionTabTitle', "{0} · {1}", base, missionAlias);
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

	deserialize(instantiationService: IInstantiationService, missionId: string): EditorInput | undefined {
		if (!missionId) {
			return undefined;
		}
		return instantiationService.createInstance(AdeEngineeringEditorInput, missionId);
	}
}

/**
 * Pure frontend Mission DAG Canvas:
 * - Infinite pannable & zoomable dot-grid canvas
 * - Top-left File icon opening the Mission Mermaid DAG text file (create empty first, edit later)
 * - Strictly flat (non-nested) nodes rendered with calm dark matte styling
 * - Draw.io smooth rounded orthogonal edges
 * - Hovering any node highlights its upstream & downstream edges as flowing animated dashed lines
 */
export class AdeEngineeringEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeEngineering';

	private readonly missionService: IAdeMissionService | undefined;
	private readonly commandService: ICommandService | undefined;
	private readonly graphDisposables = this._register(new DisposableStore());

	private rootEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private edgesSvgEl!: SVGSVGElement;
	private edgesLayerEl!: SVGGElement;
	private nodesLayerEl!: HTMLElement;
	private emptyHintEl!: HTMLElement;

	private fileBtnEl!: HTMLButtonElement;
	private fileDotEl!: HTMLElement;
	private fileDrawerEl!: HTMLElement;
	private drawerMetaEl!: HTMLElement;
	private mermaidTextareaEl!: HTMLTextAreaElement;
	private drawerStatusEl!: HTMLElement;

	private activeMissionId: string | undefined;
	private drawerOpen = false;
	private mermaidText = '';
	private nodes: readonly IMissionDagNode[] = [];
	private edges: readonly IMissionDagEdge[] = [];
	private positions = new Map<string, IMissionNodePosition>();
	private nodeElements = new Map<string, HTMLElement>();
	private edgeElements = new Map<string, { readonly group: SVGGElement; readonly path: SVGPathElement; readonly edge: IMissionDagEdge }>();
	private hoveredNodeId: string | undefined;
	private parseTimer: ReturnType<typeof setTimeout> | undefined;

	private panX = 0;
	private panY = 0;
	private zoom = 1;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(AdeEngineeringEditorPane.ID, group, telemetryService, themeService, storageService);
		const tryGet = <T>(id: ServiceIdentifier<T>): T | undefined => instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(id);
			} catch {
				return undefined;
			}
		});
		this.missionService = tryGet(IAdeMissionService);
		this.commandService = tryGet(ICommandService);
		if (this.missionService) {
			this._register(this.missionService.onDidChange(() => {
				if (!this.activeMissionId) {
					return;
				}
				const latest = this.missionService?.getMission(this.activeMissionId);
				if (!latest) {
					return;
				}
				if (latest.mermaidText !== this.mermaidText) {
					this.mermaidText = latest.mermaidText;
					if (this.mermaidTextareaEl && this.mermaidTextareaEl.value !== this.mermaidText) {
						this.mermaidTextareaEl.value = this.mermaidText;
					}
					this.parseAndRenderGraph(this.mermaidText);
				}
			}));
		}
		this._register({
			dispose: () => {
				if (this.parseTimer !== undefined) {
					clearTimeout(this.parseTimer);
					this.parseTimer = undefined;
				}
			},
		});
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-mission-editor.ade-eng-editor', {
			tabindex: 0,
			role: 'region',
			'aria-label': localize('adeMissionCanvasAria', "Mission Canvas"),
		}));
		this.bodyEl = append(this.rootEl, $('.ade-mission-body.ade-eng-body'));

		this.buildTopLeftFileControls();

		this.viewportEl = append(this.bodyEl, $('.ade-mission-viewport.ade-eng-viewport'));
		this.emptyHintEl = append(this.viewportEl, $('.ade-mission-empty-hint'));
		const hintIcon = append(this.emptyHintEl, $('span.codicon.codicon-file-code', { 'aria-hidden': 'true' }));
		hintIcon.setAttribute('aria-hidden', 'true');
		append(this.emptyHintEl, $('.ade-mission-empty-hint-title', {}, localize('adeMissionEmptyTitle', "Empty Mission Canvas")));
		append(this.emptyHintEl, $('.ade-mission-empty-hint-sub', {}, localize('adeMissionEmptySub', "Click the top-left file icon to write a Mermaid DAG.")));

		this.worldEl = append(this.viewportEl, $('.ade-mission-world.ade-eng-world'));
		this.edgesSvgEl = svgEl('svg', { class: 'ade-mission-edges-svg' });
		this.buildSvgMarkers();
		this.edgesLayerEl = svgEl('g', { class: 'ade-mission-edges-layer' });
		this.edgesSvgEl.appendChild(this.edgesLayerEl);
		this.worldEl.appendChild(this.edgesSvgEl);

		this.nodesLayerEl = append(this.worldEl, $('.ade-mission-nodes-layer'));

		this.installCanvasInteractions();
		this.applyWorldTransform();
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
			const path = svgEl('path', { d: 'M 0 1.4 L 9 5 L 0 8.6 z', fill: color });
			marker.appendChild(path);
			defs.appendChild(marker);
		};
		createArrow('ade-mission-arrow-default', '#52b788');
		createArrow('ade-mission-arrow-in', '#38bdf8');
		createArrow('ade-mission-arrow-out', '#34d399');
		this.edgesSvgEl.appendChild(defs);
	}

	private buildTopLeftFileControls(): void {
		this.fileBtnEl = append(this.bodyEl, $('button.ade-mission-file-btn', {
			type: 'button',
			title: localize('adeMissionFileBtnTooltip', "Mission Mermaid DAG File"),
			'aria-label': localize('adeMissionFileBtnAria', "Open Mission Mermaid DAG File"),
			'aria-expanded': 'false',
			'data-ade-mission-file-btn': 'true',
		})) as HTMLButtonElement;
		const iconEl = append(this.fileBtnEl, $('span', { 'aria-hidden': 'true' }));
		iconEl.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		this.fileDotEl = append(this.fileBtnEl, $('span.ade-mission-file-dot', { 'aria-hidden': 'true' }));
		this.fileDotEl.hidden = true;

		this._register(addDisposableListener(this.fileBtnEl, EventType.CLICK, () => {
			this.toggleFileDrawer();
		}));

		this.fileDrawerEl = append(this.bodyEl, $('.ade-mission-file-drawer', {
			role: 'dialog',
			'aria-label': localize('adeMissionDrawerAria', "Mission Mermaid File"),
			'data-ade-mission-drawer': 'true',
		}));
		this.fileDrawerEl.hidden = true;

		const header = append(this.fileDrawerEl, $('.ade-mission-drawer-header'));
		const titleWrap = append(header, $('.ade-mission-drawer-title'));
		const titleIcon = append(titleWrap, $('span', { 'aria-hidden': 'true' }));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.fileCode));
		append(titleWrap, $('span', {}, 'mission.mmd'));
		this.drawerMetaEl = append(titleWrap, $('span.ade-mission-drawer-meta', {}, 'Empty'));

		const actions = append(header, $('.ade-mission-drawer-actions'));
		const layoutBtn = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: localize('adeMissionAutoLayoutBtn', "Auto Layout"),
			'aria-label': localize('adeMissionAutoLayoutBtn', "Auto Layout"),
			'data-ade-mission-autolayout': 'true',
		})) as HTMLButtonElement;
		layoutBtn.appendChild($('span.codicon.codicon-layout'));
		this._register(addDisposableListener(layoutBtn, EventType.CLICK, () => {
			this.resetToAutoLayout();
		}));

		const removeBtn = append(actions, $('button.ade-mission-icon-btn.danger', {
			type: 'button',
			title: localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"),
			'aria-label': localize('adeMissionRemoveAllBtn', "Remove Mission & All Employees"),
			'data-ade-mission-remove': 'true',
		})) as HTMLButtonElement;
		removeBtn.appendChild($('span.codicon.codicon-trash'));
		this._register(addDisposableListener(removeBtn, EventType.CLICK, () => {
			if (this.activeMissionId) {
				void this.commandService?.executeCommand(ADE_REMOVE_MISSION_COMMAND_ID, this.activeMissionId);
			}
		}));

		const closeBtn = append(actions, $('button.ade-mission-icon-btn', {
			type: 'button',
			title: localize('adeMissionCloseDrawer', "Close"),
			'aria-label': localize('adeMissionCloseDrawer', "Close"),
		})) as HTMLButtonElement;
		closeBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(closeBtn, EventType.CLICK, () => {
			this.toggleFileDrawer(false);
		}));

		this.mermaidTextareaEl = append(this.fileDrawerEl, $('textarea.ade-mission-mermaid-input', {
			spellcheck: 'false',
			placeholder: MERMAID_PLACEHOLDER,
			'aria-label': localize('adeMissionMermaidInputAria', "Mermaid DAG Definition"),
			'data-ade-mission-mermaid-input': 'true',
		})) as HTMLTextAreaElement;

		this._register(addDisposableListener(this.mermaidTextareaEl, EventType.INPUT, () => {
			const nextText = this.mermaidTextareaEl.value;
			this.mermaidText = nextText;
			if (this.activeMissionId) {
				this.missionService?.updateMermaid(this.activeMissionId, nextText);
			}
			if (this.parseTimer !== undefined) {
				clearTimeout(this.parseTimer);
			}
			this.parseTimer = setTimeout(() => {
				this.parseTimer = undefined;
				this.parseAndRenderGraph(nextText);
			}, 90);
		}));

		const footer = append(this.fileDrawerEl, $('.ade-mission-drawer-footer'));
		this.drawerStatusEl = append(footer, $('span.ade-mission-drawer-status', {}, localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes")));
	}

	toggleFileDrawer(forceOpen?: boolean): void {
		this.drawerOpen = forceOpen ?? !this.drawerOpen;
		if (this.fileDrawerEl) {
			this.fileDrawerEl.hidden = !this.drawerOpen;
		}
		if (this.fileBtnEl) {
			this.fileBtnEl.classList.toggle('active', this.drawerOpen);
			this.fileBtnEl.setAttribute('aria-expanded', String(this.drawerOpen));
		}
		if (this.drawerOpen) {
			this.mermaidTextareaEl?.focus();
		}
	}

	private resetToAutoLayout(): void {
		if (this.activeMissionId) {
			this.missionService?.clearNodePositions(this.activeMissionId);
		}
		this.positions.clear();
		this.parseAndRenderGraph(this.mermaidText, true);
	}

	private parseAndRenderGraph(rawText: string, forceAutoLayout = false): void {
		const trimmed = rawText.trim();
		if (this.fileDotEl) {
			this.fileDotEl.hidden = trimmed.length === 0;
		}
		const parsed = parseMissionMermaidDag(rawText);
		if (parsed.error) {
			this.drawerStatusEl.textContent = parsed.error;
			this.drawerStatusEl.className = 'ade-mission-drawer-status error';
			return;
		}

		const hadNodesBefore = this.nodes.length > 0;
		this.nodes = parsed.nodes;
		this.edges = parsed.edges;
		this.hoveredNodeId = undefined;

		const ownerRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const ownerPrefix = ownerRec ? `${formatTierTag(ownerRec.ownerTier)} · ` : '';

		if (parsed.nodes.length === 0) {
			this.positions.clear();
			this.drawerMetaEl.textContent = `${ownerPrefix}${localize('adeMissionMetaEmpty', "Empty")}`;
			this.drawerStatusEl.textContent = localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes");
			this.drawerStatusEl.className = 'ade-mission-drawer-status';
			this.renderGraphDom();
			return;
		}

		const autoPos = computeMissionAutoLayout(parsed);
		const storedPos = !forceAutoLayout && this.activeMissionId
			? (this.missionService?.getMission(this.activeMissionId)?.positions ?? {})
			: {};
		const nextPositions = new Map<string, IMissionNodePosition>();
		for (const node of parsed.nodes) {
			const saved = storedPos[node.id] ?? (!forceAutoLayout ? this.positions.get(node.id) : undefined);
			nextPositions.set(node.id, saved ?? autoPos.get(node.id) ?? { x: 240, y: 240 });
		}
		this.positions = nextPositions;

		this.drawerMetaEl.textContent = `${ownerPrefix}${localize(
			'adeMissionMetaCounts',
			"{0} nodes · {1} edges",
			parsed.nodes.length,
			parsed.edges.length,
		)}`;
		this.drawerStatusEl.textContent = localize('adeMissionStatusValid', "Valid DAG rendered");
		this.drawerStatusEl.className = 'ade-mission-drawer-status ok';
		this.renderGraphDom();
		if (!hadNodesBefore || forceAutoLayout) {
			this.fitGraphToViewport();
		}
	}

	fitGraphToViewport(): void {
		if (!this.viewportEl || this.nodes.length === 0) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		if (rect.width < 40 || rect.height < 40) {
			return;
		}
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const node of this.nodes) {
			const pos = this.positions.get(node.id);
			if (!pos) {
				continue;
			}
			const size = getNodeSize(node);
			minX = Math.min(minX, pos.x - size.width / 2);
			maxX = Math.max(maxX, pos.x + size.width / 2);
			minY = Math.min(minY, pos.y - size.height / 2);
			maxY = Math.max(maxY, pos.y + size.height / 2);
		}
		if (!Number.isFinite(minX)) {
			return;
		}
		const padX = 72;
		const padY = 64;
		const graphW = Math.max(1, maxX - minX);
		const graphH = Math.max(1, maxY - minY);
		const scaleX = (rect.width - padX * 2) / graphW;
		const scaleY = (rect.height - padY * 2) / graphH;
		this.zoom = Math.round(Math.min(1, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY))) * 100) / 100;
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		this.panX = Math.round(rect.width / 2 - centerX * this.zoom);
		this.panY = Math.round(rect.height / 2 - centerY * this.zoom);
		this.applyWorldTransform();
	}

	private renderGraphDom(): void {
		this.graphDisposables.clear();
		this.nodeElements.clear();
		this.edgeElements.clear();
		this.worldEl.classList.remove('has-node-hover');
		clearNode(this.nodesLayerEl);
		while (this.edgesLayerEl.firstChild) {
			this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
		}

		const hasNodes = this.nodes.length > 0;
		this.emptyHintEl.hidden = hasNodes;

		const worldSize = computeMissionWorldSize([...this.positions.values()]);
		this.worldEl.style.width = `${worldSize.width}px`;
		this.worldEl.style.height = `${worldSize.height}px`;
		this.edgesSvgEl.setAttribute('width', String(worldSize.width));
		this.edgesSvgEl.setAttribute('height', String(worldSize.height));

		if (!hasNodes) {
			return;
		}

		for (const node of this.nodes) {
			const pos = this.positions.get(node.id) ?? { x: 240, y: 240 };
			const nodeEl = append(this.nodesLayerEl, $(`.ade-mission-node.kind-${node.kind}`, {
				'data-node-id': node.id,
			}));
			nodeEl.style.left = `${pos.x}px`;
			nodeEl.style.top = `${pos.y}px`;

			const card = append(nodeEl, $('.ade-mission-node-card'));
			const topRow = append(card, $('.ade-mission-node-top'));
			append(topRow, $('span.ade-mission-node-id', {}, node.id));
			if (node.kind === 'gate') {
				append(topRow, $('span.ade-mission-node-kind-tag', {}, localize('adeMissionGateTag', "Gate")));
			}
			append(card, $('.ade-mission-node-title', {}, node.label));
			append(card, $('.ade-mission-port.port-in', { 'aria-hidden': 'true' }));
			append(card, $('.ade-mission-port.port-out', { 'aria-hidden': 'true' }));

			this.nodeElements.set(node.id, nodeEl);
			this.bindNodeInteractions(node, nodeEl);
		}

		this.renderEdgesSvg();
	}

	private bindNodeInteractions(node: IMissionDagNode, nodeEl: HTMLElement): void {
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerenter', () => {
			this.setHoveredNode(node.id);
		}));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointerleave', () => {
			if (this.hoveredNodeId === node.id) {
				this.setHoveredNode(undefined);
			}
		}));

		// Node drag-to-reposition on the infinite canvas
		let dragging = false;
		let startClientX = 0;
		let startClientY = 0;
		let startNodeX = 0;
		let startNodeY = 0;

		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0) {
				return;
			}
			e.stopPropagation();
			dragging = true;
			startClientX = e.clientX;
			startClientY = e.clientY;
			const cur = this.positions.get(node.id) ?? { x: 240, y: 240 };
			startNodeX = cur.x;
			startNodeY = cur.y;
			nodeEl.classList.add('dragging');
			try {
				nodeEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic events */ }
		}));

		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			const nextPos: IMissionNodePosition = {
				x: Math.round(startNodeX + (e.clientX - startClientX) / this.zoom),
				y: Math.round(startNodeY + (e.clientY - startClientY) / this.zoom),
			};
			this.positions.set(node.id, nextPos);
			nodeEl.style.left = `${nextPos.x}px`;
			nodeEl.style.top = `${nextPos.y}px`;
			this.renderEdgesSvg();
		}));

		const finishDrag = (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			dragging = false;
			nodeEl.classList.remove('dragging');
			try {
				nodeEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
			if (this.activeMissionId) {
				const pos = this.positions.get(node.id);
				if (pos) {
					this.missionService?.updateNodePositions(this.activeMissionId, { [node.id]: pos });
				}
			}
		};
		this.graphDisposables.add(addDisposableListener(nodeEl, EventType.POINTER_UP, finishDrag));
		this.graphDisposables.add(addDisposableListener(nodeEl, 'pointercancel', finishDrag));
	}

	private renderEdgesSvg(): void {
		this.edgeElements.clear();
		while (this.edgesLayerEl.firstChild) {
			this.edgesLayerEl.removeChild(this.edgesLayerEl.firstChild);
		}
		if (this.edges.length === 0) {
			return;
		}

		const nodeById = new Map(this.nodes.map(n => [n.id, n]));
		const allObstacles: { readonly id: string; readonly box: IMissionEdgeObstacle }[] = [];
		for (const node of this.nodes) {
			const pos = this.positions.get(node.id);
			if (!pos) {
				continue;
			}
			const size = getNodeSize(node);
			const pad = 12;
			allObstacles.push({
				id: node.id,
				box: {
					minX: pos.x - size.width / 2 - pad,
					maxX: pos.x + size.width / 2 + pad,
					minY: pos.y - size.height / 2 - pad,
					maxY: pos.y + size.height / 2 + pad,
				},
			});
		}

		for (const edge of this.edges) {
			const fromNode = nodeById.get(edge.from);
			const toNode = nodeById.get(edge.to);
			const fromPos = this.positions.get(edge.from);
			const toPos = this.positions.get(edge.to);
			if (!fromNode || !toNode || !fromPos || !toPos) {
				continue;
			}
			const fromSize = getNodeSize(fromNode);
			const toSize = getNodeSize(toNode);
			const x1 = fromPos.x + fromSize.width / 2;
			const y1 = fromPos.y;
			const x2 = toPos.x - toSize.width / 2 - 4;
			const y2 = toPos.y;

			const obstacles = allObstacles
				.filter(o => o.id !== edge.from && o.id !== edge.to)
				.map(o => o.box);

			const route = computeOrthogonalRoundedEdgeRoute(x1, y1, x2, y2, {
				cornerRadius: 14,
				minStub: 24,
				obstacles,
			});

			const group = svgEl('g', {
				class: 'ade-mission-edge-group',
				'data-edge-id': edge.id,
				'data-from': edge.from,
				'data-to': edge.to,
			});

			const path = svgEl('path', {
				class: 'ade-mission-edge-path',
				d: route.path,
				'marker-end': 'url(#ade-mission-arrow-default)',
			});
			group.appendChild(path);

			if (edge.label) {
				const pillW = Math.max(36, Math.min(140, edge.label.length * 7 + 16));
				const bg = svgEl('rect', {
					class: 'ade-mission-edge-label-bg',
					x: String(route.midX - pillW / 2),
					y: String(route.midY - 10),
					width: String(pillW),
					height: '20',
					rx: '6',
				});
				const txt = svgEl('text', {
					class: 'ade-mission-edge-label-text',
					x: String(route.midX),
					y: String(route.midY),
				});
				txt.textContent = edge.label;
				group.appendChild(bg);
				group.appendChild(txt);
			}

			this.edgesLayerEl.appendChild(group);
			this.edgeElements.set(edge.id, { group, path, edge });
		}

		if (this.hoveredNodeId) {
			this.applyHoverHighlight(this.hoveredNodeId);
		}
	}

	/**
	 * Public helper (and hover handler) highlighting upstream & downstream connected edges
	 * as animated flowing dashed lines while gently dimming unrelated nodes/edges.
	 */
	setHoveredNode(nodeId: string | undefined): void {
		if (this.hoveredNodeId === nodeId) {
			return;
		}
		this.hoveredNodeId = nodeId;
		this.applyHoverHighlight(nodeId);
	}

	private applyHoverHighlight(nodeId: string | undefined): void {
		if (!this.worldEl) {
			return;
		}
		this.worldEl.classList.toggle('has-node-hover', Boolean(nodeId));

		const upstreamIds = new Set<string>();
		const downstreamIds = new Set<string>();
		const raisedGroups: SVGGElement[] = [];

		for (const { group, path, edge } of this.edgeElements.values()) {
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
				path.setAttribute('marker-end', 'url(#ade-mission-arrow-default)');
			}
		}

		// Raise flowing dashed edges to top of SVG stack so they paint cleanly over dimmed edges
		for (const g of raisedGroups) {
			this.edgesLayerEl.appendChild(g);
		}

		for (const [id, el] of this.nodeElements.entries()) {
			const isHovered = Boolean(nodeId && id === nodeId);
			const isUp = upstreamIds.has(id);
			const isDown = downstreamIds.has(id);
			el.classList.toggle('is-hovered', isHovered);
			el.classList.toggle('is-neighbor', isUp || isDown);
			el.classList.toggle('is-upstream', isUp);
			el.classList.toggle('is-downstream', isDown);
		}
	}

	private applyWorldTransform(): void {
		if (!this.viewportEl || !this.worldEl) {
			return;
		}
		const rx = Math.round(this.panX);
		const ry = Math.round(this.panY);
		this.worldEl.style.transform = `translate(${rx}px, ${ry}px) scale(${this.zoom})`;
		this.viewportEl.style.setProperty('--grid-x', `${rx}px`);
		this.viewportEl.style.setProperty('--grid-y', `${ry}px`);
		this.viewportEl.style.setProperty('--grid-scale', String(this.zoom));
		this.viewportEl.classList.toggle('zoom-macro', this.zoom < 0.5);
	}

	private installCanvasInteractions(): void {
		let panning = false;
		let startClientX = 0;
		let startClientY = 0;
		let startPanX = 0;
		let startPanY = 0;

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 && e.button !== 1) {
				return;
			}
			panning = true;
			startClientX = e.clientX;
			startClientY = e.clientY;
			startPanX = this.panX;
			startPanY = this.panY;
			this.viewportEl.classList.add('panning');
			try {
				this.viewportEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic events */ }
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
				const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
				this.zoom = Math.round(nextZoom * 100) / 100;
				this.panX = cursorX - worldX * this.zoom;
				this.panY = cursorY - worldY * this.zoom;
				this.applyWorldTransform();
			} else {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.applyWorldTransform();
			}
		}, { passive: false }));

		const win = getWindow(this.rootEl);
		this._register(addDisposableListener(win, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.drawerOpen) {
				this.toggleFileDrawer(false);
			}
		}));
	}

	override async setInput(input: AdeEngineeringEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.activeMissionId = input.governorSessionId;
		const record = this.missionService?.ensureMission(input.governorSessionId);
		this.mermaidText = record?.mermaidText ?? '';
		if (this.mermaidTextareaEl) {
			this.mermaidTextareaEl.value = this.mermaidText;
		}
		this.positions.clear();
		this.parseAndRenderGraph(this.mermaidText);
		this.applyWorldTransform();
	}

	override clearInput(): void {
		this.activeMissionId = undefined;
		this.setHoveredNode(undefined);
		super.clearInput();
	}

	override focus(): void {
		this.rootEl?.focus();
	}

	layout(dimension: Dimension): void {
		if (this.rootEl) {
			this.rootEl.style.width = `${dimension.width}px`;
			this.rootEl.style.height = `${dimension.height}px`;
		}
	}
}
