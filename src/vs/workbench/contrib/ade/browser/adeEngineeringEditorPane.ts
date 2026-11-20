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
	getEmployeeColorIndex,
	IMissionDagEdge,
	IMissionDagEmployeeGroup,
	IMissionDagNode,
	IMissionEdgeObstacle,
	IMissionNodePosition,
	MISSION_GATE_NODE_HEIGHT,
	MISSION_GATE_NODE_WIDTH,
	MISSION_TASK_NODE_HEIGHT,
	MISSION_TASK_NODE_WIDTH,
	parseMissionMermaidDag,
	setNodeEmployeeInMermaid,
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
	'  N1["@Backend: API Schema"] --> N2["@Frontend: UI Canvas"]',
	'  N1 --> N3["@Backend: Core Engine"]',
	'  N2 --> N4["@Backend: Integration"]',
	'  N3 --> N4',
].join('\n');

function buildOrthogonalContextRibbonPath(x1: number, y1: number, x2: number, y2: number, laneY: number, radius = 12): string {
	const dx = x2 - x1;
	const dirY1 = laneY >= y1 ? 1 : -1;
	const dirY2 = y2 >= laneY ? 1 : -1;
	const r = Math.max(0, Math.min(radius, Math.abs(dx) / 2, Math.abs(laneY - y1) / 2, Math.abs(y2 - laneY) / 2));
	if (Math.abs(dx) < 2) {
		return `M ${x1} ${y1} L ${x2} ${y2}`;
	}
	const dirX = dx > 0 ? 1 : -1;
	return [
		`M ${x1} ${y1}`,
		`L ${x1} ${laneY - dirY1 * r}`,
		`Q ${x1} ${laneY} ${x1 + dirX * r} ${laneY}`,
		`L ${x2 - dirX * r} ${laneY}`,
		`Q ${x2} ${laneY} ${x2} ${laneY + dirY2 * r}`,
		`L ${x2} ${y2}`,
	].join(' ');
}

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
	private contextLinksLayerEl!: SVGGElement;
	private nodesLayerEl!: HTMLElement;
	private emptyHintEl!: HTMLElement;
	private employeePopoverEl!: HTMLElement;
	private readonly popoverDisposables = this._register(new DisposableStore());

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
	private employees: readonly IMissionDagEmployeeGroup[] = [];
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
		this.contextLinksLayerEl = svgEl('g', { class: 'ade-mission-context-layer' });
		this.edgesSvgEl.appendChild(this.edgesLayerEl);
		this.edgesSvgEl.appendChild(this.contextLinksLayerEl);
		this.worldEl.appendChild(this.edgesSvgEl);

		this.nodesLayerEl = append(this.worldEl, $('.ade-mission-nodes-layer'));
		this.employeePopoverEl = append(this.bodyEl, $('.ade-mission-emp-popover', {
			role: 'dialog',
			'aria-label': localize('adeMissionEmployeePickerAria', "Assign or Reuse Employee"),
			'data-ade-mission-emp-popover': 'true',
		}));
		this.employeePopoverEl.hidden = true;

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
		createArrow('ade-mission-arrow-ctx', '#a78bfa');
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
		this.employees = parsed.employees ?? [];
		this.hoveredNodeId = undefined;
		this.closeEmployeePopover();

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

		const hasReusedEmployee = this.employees.some(e => e.nodeIds.length > 1);
		this.drawerMetaEl.textContent = hasReusedEmployee
			? `${ownerPrefix}${localize('adeMissionMetaWithEmployees', "{0} steps · {1} employees", parsed.nodes.length, this.employees.length)}`
			: `${ownerPrefix}${localize('adeMissionMetaCounts', "{0} nodes · {1} edges", parsed.nodes.length, parsed.edges.length)}`;
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
				...(node.employeeKey ? { 'data-employee-key': node.employeeKey } : {}),
			}));
			nodeEl.style.left = `${pos.x}px`;
			nodeEl.style.top = `${pos.y}px`;

			const card = append(nodeEl, $('.ade-mission-node-card'));
			const topRow = append(card, $('.ade-mission-node-top'));
			append(topRow, $('span.ade-mission-node-id', {}, node.id));
			if (node.kind === 'gate') {
				append(topRow, $('span.ade-mission-node-kind-tag', {}, localize('adeMissionGateTag', "Gate")));
			} else {
				const isAssigned = Boolean(node.employeeName && node.employeeKey);
				const isReused = Boolean((node.employeeTotalOccurrences ?? 0) > 1);
				const colorCls = isAssigned ? `.emp-color-${getEmployeeColorIndex(node.employeeKey!)}` : '.unassigned';
				const empBtn = append(topRow, $(`button.ade-mission-emp-pill${colorCls}${isReused ? '.is-reused' : ''}`, {
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
				this.graphDisposables.add(addDisposableListener(empBtn, EventType.POINTER_DOWN, (e: PointerEvent) => {
					e.stopPropagation();
				}));
				this.graphDisposables.add(addDisposableListener(empBtn, EventType.CLICK, (e: MouseEvent) => {
					e.stopPropagation();
					this.openEmployeePopover(node, empBtn);
				}));
			}
			append(card, $('.ade-mission-node-title', {}, node.label));
			append(card, $('.ade-mission-port.port-in', { 'aria-hidden': 'true' }));
			append(card, $('.ade-mission-port.port-out', { 'aria-hidden': 'true' }));

			this.nodeElements.set(node.id, nodeEl);
			this.bindNodeInteractions(node, nodeEl);
		}

		this.renderEdgesSvg();
	}

	private closeEmployeePopover(): void {
		this.popoverDisposables.clear();
		if (this.employeePopoverEl) {
			clearNode(this.employeePopoverEl);
			this.employeePopoverEl.hidden = true;
		}
	}

	private assignNodeEmployee(nodeId: string, employeeName: string | undefined): void {
		const nextMermaid = setNodeEmployeeInMermaid(this.mermaidText, nodeId, employeeName);
		this.mermaidText = nextMermaid;
		if (this.mermaidTextareaEl) {
			this.mermaidTextareaEl.value = nextMermaid;
		}
		if (this.activeMissionId) {
			this.missionService?.updateMermaid(this.activeMissionId, nextMermaid);
		}
		this.closeEmployeePopover();
		this.parseAndRenderGraph(nextMermaid);
	}

	private openEmployeePopover(node: IMissionDagNode, anchorEl: HTMLElement): void {
		this.closeEmployeePopover();
		if (!this.employeePopoverEl || !this.bodyEl) {
			return;
		}
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const left = Math.max(12, Math.min(bodyRect.width - 236, anchorRect.left - bodyRect.left));
		const top = Math.max(12, Math.min(bodyRect.height - 220, anchorRect.bottom - bodyRect.top + 6));
		this.employeePopoverEl.style.left = `${Math.round(left)}px`;
		this.employeePopoverEl.style.top = `${Math.round(top)}px`;
		this.employeePopoverEl.hidden = false;

		append(this.employeePopoverEl, $('.ade-mission-emp-popover-title', {}, localize('adeMissionReuseTitle', "Employee for {0} (Reuse Context)", node.id)));
		const input = append(this.employeePopoverEl, $('input.ade-mission-emp-popover-input', {
			type: 'text',
			placeholder: localize('adeMissionEmpInputPlaceholder', "Employee name + Enter..."),
			value: node.employeeName ?? '',
			'data-ade-mission-emp-input': 'true',
		})) as HTMLInputElement;
		this.popoverDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = input.value.trim();
				this.assignNodeEmployee(node.id, val || undefined);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this.closeEmployeePopover();
			}
		}));

		const explicitGroups = this.employees.filter(g => g.isExplicit);
		const list = append(this.employeePopoverEl, $('.ade-mission-emp-popover-list'));
		for (const group of explicitGroups) {
			const isCurrent = Boolean(node.employeeKey && group.key === `emp:${node.employeeKey}`);
			const btn = append(list, $(`button.ade-mission-emp-popover-item${isCurrent ? '.active' : ''}`, {
				type: 'button',
				'data-ade-emp-option': group.displayName,
			}));
			append(btn, $('span', {}, group.displayName));
			append(btn, $('span.ade-mission-emp-popover-meta', {}, localize('adeMissionEmpStepCount', "{0} step(s)", group.nodeIds.length)));
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.assignNodeEmployee(node.id, group.displayName);
			}));
		}

		if (node.employeeName) {
			const clearBtn = append(list, $('button.ade-mission-emp-popover-item.clear', {
				type: 'button',
				'data-ade-emp-clear': 'true',
			}, localize('adeMissionEmpClearBtn', "Detach (Standalone Step)")));
			this.popoverDisposables.add(addDisposableListener(clearBtn, EventType.CLICK, () => {
				this.assignNodeEmployee(node.id, undefined);
			}));
		}

		input.focus();
		input.select();
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

		// Clear & redraw hover-only orthogonal context-reuse ribbons for repeated employees
		while (this.contextLinksLayerEl.firstChild) {
			this.contextLinksLayerEl.removeChild(this.contextLinksLayerEl.firstChild);
		}
		const hoveredNode = nodeId ? this.nodes.find(n => n.id === nodeId) : undefined;
		const sameEmployeeIds = new Set<string>();
		if (hoveredNode?.employeeKey && (hoveredNode.employeeTotalOccurrences ?? 0) > 1) {
			const sequenceNodes = this.nodes
				.filter(n => n.employeeKey === hoveredNode.employeeKey)
				.sort((a, b) => (a.employeeOccurrence ?? 0) - (b.employeeOccurrence ?? 0));
			for (const peer of sequenceNodes) {
				if (peer.id !== hoveredNode.id) {
					sameEmployeeIds.add(peer.id);
				}
			}
			// Draw draw.io-style orthogonal rounded bridges connecting #1 -> #2 -> #3 of the same employee,
			// automatically choosing the unobstructed top or bottom clearance lane so ribbons never cross cards.
			let minTopY = Infinity;
			let maxBottomY = -Infinity;
			for (const n of this.nodes) {
				const p = this.positions.get(n.id);
				if (p) {
					const sz = getNodeSize(n);
					minTopY = Math.min(minTopY, p.y - sz.height / 2);
					maxBottomY = Math.max(maxBottomY, p.y + sz.height / 2);
				}
			}
			const hasNodeVertically = (target: IMissionDagNode, side: 'above' | 'below'): boolean => {
				const tp = this.positions.get(target.id);
				if (!tp) {
					return false;
				}
				return this.nodes.some(other => {
					if (other.id === target.id) {
						return false;
					}
					const op = this.positions.get(other.id);
					if (!op) {
						return false;
					}
					const osz = getNodeSize(other);
					const horizOverlap = Math.abs(op.x - tp.x) < osz.width / 2 + 16;
					return horizOverlap && (side === 'above' ? op.y < tp.y - 10 : op.y > tp.y + 10);
				});
			};
			const anyBlockedAbove = sequenceNodes.some(n => hasNodeVertically(n, 'above'));
			const anyBlockedBelow = sequenceNodes.some(n => hasNodeVertically(n, 'below'));
			const routeBelow = anyBlockedAbove && !anyBlockedBelow;

			for (let i = 0; i + 1 < sequenceNodes.length; i++) {
				const fromN = sequenceNodes[i];
				const toN = sequenceNodes[i + 1];
				const p1 = this.positions.get(fromN.id);
				const p2 = this.positions.get(toN.id);
				if (!p1 || !p2) {
					continue;
				}
				const s1 = getNodeSize(fromN);
				const s2 = getNodeSize(toN);
				const x1 = p1.x + (i > 0 ? 12 : 0);
				const x2 = p2.x - (i + 2 < sequenceNodes.length ? 12 : 0);
				const y1 = routeBelow ? (p1.y + s1.height / 2) : (p1.y - s1.height / 2);
				const y2 = routeBelow ? (p2.y + s2.height / 2 + 4) : (p2.y - s2.height / 2 - 4);
				const laneY = routeBelow
					? (Math.max(maxBottomY, y1, y2) + 28 + i * 16)
					: (Math.min(minTopY, y1, y2) - 28 - i * 16);
				const d = buildOrthogonalContextRibbonPath(x1, y1, x2, y2, laneY, 12);
				const ribbon = svgEl('path', {
					class: 'ade-mission-context-edge',
					'data-context-link': `${fromN.id}->${toN.id}`,
					d,
					'marker-end': 'url(#ade-mission-arrow-ctx)',
				});
				this.contextLinksLayerEl.appendChild(ribbon);
			}
		}

		for (const [id, el] of this.nodeElements.entries()) {
			const isHovered = Boolean(nodeId && id === nodeId);
			const isUp = upstreamIds.has(id);
			const isDown = downstreamIds.has(id);
			const isSameEmp = sameEmployeeIds.has(id);
			el.classList.toggle('is-hovered', isHovered);
			el.classList.toggle('is-neighbor', isUp || isDown);
			el.classList.toggle('is-upstream', isUp);
			el.classList.toggle('is-downstream', isDown);
			el.classList.toggle('is-same-employee', isSameEmp);
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
			this.closeEmployeePopover();
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
			if (e.key === 'Escape') {
				if (this.employeePopoverEl && !this.employeePopoverEl.hidden) {
					this.closeEmployeePopover();
				} else if (this.drawerOpen) {
					this.toggleFileDrawer(false);
				}
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
