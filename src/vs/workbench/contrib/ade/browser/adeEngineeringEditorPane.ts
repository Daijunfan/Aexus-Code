/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asCSSUrl } from '../../../../base/browser/cssValue.js';
import { $, addDisposableListener, append, clearNode, Dimension, EventType, getWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import { IMissionSupervisorBinding } from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	buildMissionContextReusePaths,
	computeMissionAutoLayout,
	computeMissionWorldSize,
	computeOrthogonalRoundedEdgeRoute,
	getEmployeeColorIndex,
	getMissionEdgeKind,
	IMissionContextReuseAnchor,
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
import { DEFAULT_ADE_ORGANIZATION_CONFIG, getMissionDisplayName, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
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
import { ADE_ENGINEERING_SCHEME, ADE_REMOVE_MISSION_COMMAND_ID, ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import './media/adeMissionCanvas.css';

const ENGINE_FALLBACK_NAMES: Readonly<Record<string, string>> = {
	'aexus-claude': 'Claude Code',
	'aexus-codex': 'Codex',
	'aexus-kilo': 'Kilo Code',
	'aexus-opencode': 'OpenCode',
	'aexus-dsh': 'DeepSeek Harness',
	'aexus-antigravity': 'Google Antigravity',
	'aexus-cline': 'Cline',
	'aexus-pi': 'Pi',
};

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
	private readonly missionRuntimeService: IAdeMissionRuntimeService | undefined;
	private readonly projectsService: IAdeProjectsService | undefined;
	private readonly adeEditorService: IAdeEditorService | undefined;
	private readonly sessionsService: IAdeSessionsService | undefined;
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	private readonly cloudHostService: IAdeCloudHostBackendService | undefined;
	private readonly commandService: ICommandService | undefined;
	private readonly graphDisposables = this._register(new DisposableStore());
	private isDraggingNode = false;

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
	private runBarEl!: HTMLElement;
	private runStatusLabelEl!: HTMLElement;
	private runPrimaryBtnEl!: HTMLButtonElement;
	private runStopBtnEl!: HTMLButtonElement;
	private fileDrawerEl!: HTMLElement;
	private drawerMetaEl!: HTMLElement;
	private mermaidTextareaEl!: HTMLTextAreaElement;
	private timeoutInputEl!: HTMLInputElement;
	private cutoffSelectEl!: HTMLSelectElement;
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
		this.missionRuntimeService = tryGet(IAdeMissionRuntimeService);
		this.projectsService = tryGet(IAdeProjectsService);
		this.adeEditorService = tryGet(IAdeEditorService);
		this.sessionsService = tryGet(IAdeSessionsService);
		this.roleSchemaService = tryGet(IAdeRoleSchemaService);
		this.cloudHostService = tryGet(IAdeCloudHostBackendService);
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
				this.syncRuntimeControlsUi();
			}));
		}
		if (this.missionRuntimeService) {
			this._register(this.missionRuntimeService.onDidChange(changedMissionId => {
				if (!this.activeMissionId || changedMissionId !== this.activeMissionId) {
					return;
				}
				this.syncRuntimeControlsUi();
				if (this.nodes.length > 0 && !this.isDraggingNode) {
					this.renderGraphDom();
				}
			}));
		}
		if (this.projectsService) {
			this._register(this.projectsService.onDidChange(() => {
				if (this.activeMissionId && this.nodes.length > 0 && !this.isDraggingNode) {
					this.renderGraphDom();
				}
			}));
		}
		if (this.sessionsService) {
			this._register(this.sessionsService.onDidChangeEngines(() => {
				if (this.activeMissionId && this.nodes.length > 0 && !this.isDraggingNode) {
					this.renderGraphDom();
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
		createArrow('ade-mission-arrow-fail', '#f87171');
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

		// Minimal corner run-control pill next to the top-left file icon (Section 6.1)
		this.runBarEl = append(this.bodyEl, $('.ade-mission-run-bar', {
			'data-ade-mission-run-bar': 'true',
		}));
		append(this.runBarEl, $('span.ade-mission-run-dot', { 'aria-hidden': 'true' }));
		this.runStatusLabelEl = append(this.runBarEl, $('span.ade-mission-run-status', {}, localize('adeMissionRunIdle', "Idle")));
		this.runPrimaryBtnEl = append(this.runBarEl, $('button.ade-mission-run-btn', {
			type: 'button',
			'data-ade-mission-run-primary': 'true',
		})) as HTMLButtonElement;
		this.runStopBtnEl = append(this.runBarEl, $('button.ade-mission-run-stop-btn', {
			type: 'button',
			title: localize('adeMissionStopTooltip', "Stop Mission"),
			'aria-label': localize('adeMissionStopTooltip', "Stop Mission"),
			'data-ade-mission-run-stop': 'true',
		})) as HTMLButtonElement;
		this.runStopBtnEl.appendChild($('span.codicon.codicon-debug-stop'));
		this.runStopBtnEl.hidden = true;

		this._register(addDisposableListener(this.runPrimaryBtnEl, EventType.CLICK, () => {
			void this.handlePrimaryRunButtonClick();
		}));
		this._register(addDisposableListener(this.runStopBtnEl, EventType.CLICK, () => {
			if (this.activeMissionId && this.missionRuntimeService) {
				void this.missionRuntimeService.stop(this.activeMissionId);
			}
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

		const commitLiveMermaidPatch = (): void => {
			const missionId = this.activeMissionId;
			if (!missionId || !this.missionRuntimeService) {
				return;
			}
			const rtStatus = this.missionRuntimeService.getRuntimeState(missionId).status;
			if (rtStatus !== 'running' && rtStatus !== 'paused') {
				return;
			}
			const nextText = this.mermaidTextareaEl.value;
			if (nextText === this.mermaidText) {
				return;
			}
			const previousValidMermaid = this.mermaidText;
			this.drawerStatusEl.textContent = localize('adeMissionLivePatchValidating', "Applying atomic live patch...");
			this.drawerStatusEl.className = 'ade-mission-drawer-status';
			void this.missionRuntimeService.patchMermaid(missionId, {
				caller: { isHumanUser: true },
				newMermaidText: nextText,
				reason: 'Live canvas Mermaid patch',
			}).then(res => {
				if (this.activeMissionId !== missionId) {
					return;
				}
				if (res.ok) {
					this.mermaidText = nextText;
					this.parseAndRenderGraph(nextText);
					this.drawerStatusEl.textContent = localize('adeMissionLivePatchApplied', "Atomic live DAG patch applied");
					this.drawerStatusEl.className = 'ade-mission-drawer-status ok';
				} else {
					if (this.mermaidTextareaEl && this.mermaidTextareaEl.value === nextText) {
						this.mermaidTextareaEl.value = previousValidMermaid;
					}
					this.drawerStatusEl.textContent = res.error ?? localize('adeMissionLivePatchRejected', "Live DAG patch rejected.");
					this.drawerStatusEl.className = 'ade-mission-drawer-status error';
				}
			});
		};

		this._register(addDisposableListener(this.mermaidTextareaEl, EventType.INPUT, () => {
			const nextText = this.mermaidTextareaEl.value;
			const missionId = this.activeMissionId;
			const rtStatus = missionId ? this.missionRuntimeService?.getRuntimeState(missionId).status : undefined;
			const isLiveRun = rtStatus === 'running' || rtStatus === 'paused';

			if (this.parseTimer !== undefined) {
				clearTimeout(this.parseTimer);
			}

			if (isLiveRun && missionId && this.missionRuntimeService) {
				// R2-1 / P0-7: While running/paused, NEVER mutate live Mermaid or wipe typing on keystrokes;
				// validate syntax locally and commit atomic patch only on Cmd/Ctrl+Enter or blur.
				const preview = parseMissionMermaidDag(nextText);
				if (preview.error) {
					this.drawerStatusEl.textContent = preview.error;
					this.drawerStatusEl.className = 'ade-mission-drawer-status error';
				} else {
					this.drawerStatusEl.textContent = localize('adeMissionLivePatchPendingCommit', "Draft live edit valid — press Cmd/Ctrl+Enter or click outside to apply atomic patch");
					this.drawerStatusEl.className = 'ade-mission-drawer-status';
				}
				return;
			}

			this.mermaidText = nextText;
			if (missionId) {
				this.missionService?.updateMermaid(missionId, nextText);
			}
			this.parseTimer = setTimeout(() => {
				this.parseTimer = undefined;
				this.parseAndRenderGraph(nextText);
			}, 90);
		}));

		this._register(addDisposableListener(this.mermaidTextareaEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				const missionId = this.activeMissionId;
				const rtStatus = missionId ? this.missionRuntimeService?.getRuntimeState(missionId).status : undefined;
				if (rtStatus === 'running' || rtStatus === 'paused') {
					e.preventDefault();
					commitLiveMermaidPatch();
				}
			}
		}));

		this._register(addDisposableListener(this.mermaidTextareaEl, EventType.BLUR, () => {
			commitLiveMermaidPatch();
		}));

		const configStrip = append(this.fileDrawerEl, $('.ade-mission-drawer-config', {
			'data-ade-mission-drawer-config': 'true',
		}));
		const timeoutField = append(configStrip, $('label.ade-mission-config-field'));
		append(timeoutField, $('span.ade-mission-config-label', {}, localize('adeMissionTimeoutLabel', "Silence (min)")));
		this.timeoutInputEl = append(timeoutField, $('input.ade-mission-config-input', {
			type: 'number',
			min: '1',
			max: '240',
			value: '5',
			'data-ade-mission-timeout-input': 'true',
		})) as HTMLInputElement;
		this._register(addDisposableListener(this.timeoutInputEl, EventType.CHANGE, () => {
			if (!this.activeMissionId || !this.missionRuntimeService) {
				return;
			}
			const mins = Number.parseInt(this.timeoutInputEl.value, 10);
			if (Number.isFinite(mins) && mins >= 1) {
				void this.missionRuntimeService.setSilenceTimeout(this.activeMissionId, mins).then(res => {
					if (!res.ok && res.error) {
						this.drawerStatusEl.textContent = res.error;
						this.drawerStatusEl.className = 'ade-mission-drawer-status error';
					}
					this.syncRuntimeControlsUi();
				});
			}
		}));

		const cutoffField = append(configStrip, $('label.ade-mission-config-field'));
		append(cutoffField, $('span.ade-mission-config-label', {}, localize('adeMissionCutoffLabel', "Off-graph")));
		this.cutoffSelectEl = append(cutoffField, $('select.ade-mission-config-select', {
			'data-ade-mission-cutoff-select': 'true',
		})) as HTMLSelectElement;
		this._register(addDisposableListener(this.cutoffSelectEl, EventType.CHANGE, () => {
			if (!this.activeMissionId || !this.missionRuntimeService) {
				return;
			}
			const cutoff = Number.parseInt(this.cutoffSelectEl.value, 10);
			if (Number.isInteger(cutoff) && cutoff >= 0) {
				void this.missionRuntimeService.setBoundary(this.activeMissionId, { offGraphMaxTier: cutoff }).then(res => {
					if (!res.ok && res.error) {
						this.drawerStatusEl.textContent = res.error;
						this.drawerStatusEl.className = 'ade-mission-drawer-status error';
					}
					this.syncRuntimeControlsUi();
				});
			}
		}));

		const footer = append(this.fileDrawerEl, $('.ade-mission-drawer-footer'));
		this.drawerStatusEl = append(footer, $('span.ade-mission-drawer-status', {}, localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes")));
	}

	private async handlePrimaryRunButtonClick(): Promise<void> {
		if (!this.activeMissionId || !this.missionRuntimeService) {
			return;
		}
		const state = this.missionRuntimeService.getRuntimeState(this.activeMissionId);
		if (state.status === 'running') {
			await this.missionRuntimeService.pause(this.activeMissionId);
			return;
		}
		if (state.status === 'paused') {
			await this.missionRuntimeService.resume(this.activeMissionId);
			return;
		}
		const mins = Number.parseInt(this.timeoutInputEl?.value ?? '5', 10);
		const res = await this.missionRuntimeService.start(this.activeMissionId, {
			silenceTimeoutMinutes: Number.isFinite(mins) && mins >= 1 ? mins : state.silenceTimeoutMinutes,
		});
		if (!res.ok && res.error && this.drawerStatusEl) {
			this.drawerStatusEl.textContent = res.error;
			this.drawerStatusEl.className = 'ade-mission-drawer-status error';
		}
		this.syncRuntimeControlsUi();
	}

	private syncRuntimeControlsUi(): void {
		if (!this.runBarEl || !this.activeMissionId) {
			return;
		}
		const hasRuntime = Boolean(this.missionRuntimeService);
		this.runBarEl.hidden = !hasRuntime;
		if (!hasRuntime || !this.missionRuntimeService) {
			return;
		}
		const state = this.missionRuntimeService.getRuntimeState(this.activeMissionId);
		const status = state.status;
		this.runBarEl.dataset.status = status;
		this.runStatusLabelEl.textContent = status === 'running'
			? localize('adeMissionRunRunning', "Running")
			: status === 'paused'
				? localize('adeMissionRunPaused', "Paused")
				: status === 'completed'
					? localize('adeMissionRunCompleted', "Done")
					: status === 'failed'
						? localize('adeMissionRunFailed', "Failed")
						: status === 'stopped'
							? localize('adeMissionRunStopped', "Stopped")
							: localize('adeMissionRunIdle', "Idle");

		clearNode(this.runPrimaryBtnEl);
		if (status === 'running') {
			this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-debug-pause'));
			append(this.runPrimaryBtnEl, $('span', {}, localize('adeMissionPauseBtn', "Pause")));
		} else if (status === 'paused') {
			this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-debug-continue'));
			append(this.runPrimaryBtnEl, $('span', {}, localize('adeMissionResumeBtn', "Resume")));
		} else {
			this.runPrimaryBtnEl.appendChild($('span.codicon.codicon-play'));
			append(this.runPrimaryBtnEl, $('span', {}, localize('adeMissionStartBtn', "Start")));
		}
		this.runPrimaryBtnEl.disabled = this.nodes.length === 0 && status !== 'running' && status !== 'paused';
		this.runStopBtnEl.hidden = status !== 'running' && status !== 'paused';

		if (this.timeoutInputEl) {
			this.timeoutInputEl.value = String(state.silenceTimeoutMinutes);
			this.timeoutInputEl.disabled = state.silenceTimeoutLocked;
			this.timeoutInputEl.title = state.silenceTimeoutLocked
				? localize('adeMissionTimeoutLockedTip', "Locked while Mission is running")
				: localize('adeMissionTimeoutEditTip', "Watchdog silence nudge timeout in minutes (locked once started)");
		}

		if (this.cutoffSelectEl) {
			const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const maxCutoff = Math.max(0, org.ranks.length - 1);
			clearNode(this.cutoffSelectEl);
			for (let k = 0; k <= maxCutoff; k++) {
				const opt = append(this.cutoffSelectEl, $('option', { value: String(k) },
					k === 0
						? localize('adeMissionCutoffL0', "L0 only")
						: localize('adeMissionCutoffLk', "L0..L{0}", k),
				)) as HTMLOptionElement;
				if (k === state.boundary.offGraphMaxTier) {
					opt.selected = true;
				}
			}
			this.cutoffSelectEl.disabled = status === 'running' || status === 'paused';
		}
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
		this.syncRuntimeControlsUi();
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

		const generatedEmployees = this.activeMissionId
			? (this.missionService?.getGeneratedEmployees(this.activeMissionId) ?? [])
			: [];
		const agentByNodeId = new Map<string, IAdeAgent>();
		const agentByTreeKey = new Map<string, IAdeAgent>();
		for (const emp of generatedEmployees) {
			if (emp.treeNodeId) {
				agentByTreeKey.set(emp.treeNodeId, emp);
			}
			for (const nid of emp.treeNodeIds ?? []) {
				agentByNodeId.set(nid, emp);
			}
		}
		const missionRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const runtimeState = this.activeMissionId && this.missionRuntimeService
			? this.missionRuntimeService.getRuntimeState(this.activeMissionId)
			: undefined;
		const ownerAgent = missionRec?.ownerSessionId ? this.projectsService?.getAgent(missionRec.ownerSessionId) : undefined;
		const fallbackOwnerEngineId = ownerAgent?.session?.engineId ?? ownerAgent?.preferredEngineId ?? 'aexus-claude';

		for (const node of this.nodes) {
			const pos = this.positions.get(node.id) ?? { x: 240, y: 240 };
			const nodeState = runtimeState?.nodeStates[node.id] ?? 'idle';
			const stateClass = nodeState !== 'idle' ? `.state-${nodeState.replace(/_/g, '-')}` : '';
			const nodeEl = append(this.nodesLayerEl, $(`.ade-mission-node.kind-${node.kind}${stateClass}`, {
				'data-node-id': node.id,
				'data-node-state': nodeState,
				...(node.employeeKey ? { 'data-employee-key': node.employeeKey } : {}),
			}));
			nodeEl.style.left = `${pos.x}px`;
			nodeEl.style.top = `${pos.y}px`;

			const card = append(nodeEl, $('.ade-mission-node-card'));
			const topRow = append(card, $('.ade-mission-node-top'));
			const idWrap = append(topRow, $('span.ade-mission-node-id-wrap'));
			if (nodeState !== 'idle') {
				append(idWrap, $('span.ade-mission-state-dot', {
					'aria-hidden': 'true',
					title: nodeState,
				}));
			}
			append(idWrap, $('span.ade-mission-node-id', {}, node.id));
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
			if (node.kind !== 'gate') {
				const linkedAgent = agentByNodeId.get(node.id)
					?? (node.employeeKey ? agentByTreeKey.get(`emp:${node.employeeKey}`) : undefined)
					?? agentByTreeKey.get(node.id);
				const engineId = linkedAgent?.session?.engineId ?? linkedAgent?.preferredEngineId ?? fallbackOwnerEngineId;
				const resolvedName = this.sessionsService?.getEngineName(engineId);
				const engineName = resolvedName && resolvedName !== engineId
					? resolvedName
					: (ENGINE_FALLBACK_NAMES[engineId] ?? engineId.replace(/^aexus-/, ''));
				const engineIcon = this.sessionsService?.getIcon(engineId);
				const canSwitchEngine = Boolean(linkedAgent && !linkedAgent.session && this.projectsService && this.sessionsService);
				const footer = append(card, $('.ade-mission-node-footer'));
				const engineBadge = append(footer, $(`button.ade-mission-engine-pill${canSwitchEngine ? '.is-editable' : ''}`, {
					type: 'button',
					'data-node-engine-id': engineId,
					title: canSwitchEngine
						? localize('adeMissionEngineSwitchTooltip', "Agent Engine: {0} — Click to switch engine for this employee", engineName)
						: localize('adeMissionEngineBoundTooltip', "Agent Engine: {0}", engineName),
				})) as HTMLButtonElement;
				const iconEl = append(engineBadge, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
				this.applyEngineIcon(iconEl, engineIcon);
				append(engineBadge, $('span.ade-mission-engine-name', {}, engineName));
				if (canSwitchEngine && linkedAgent) {
					this.graphDisposables.add(addDisposableListener(engineBadge, EventType.POINTER_DOWN, (e: PointerEvent) => {
						e.stopPropagation();
					}));
					this.graphDisposables.add(addDisposableListener(engineBadge, EventType.CLICK, (e: MouseEvent) => {
						e.stopPropagation();
						void this.openEnginePopover(linkedAgent, engineId, engineBadge);
					}));
				} else {
					engineBadge.disabled = true;
				}
				const boundHost = runtimeState?.boundary.nodeAssignments[node.id]?.hostAlias
					?? (linkedAgent?.projectUri.scheme === 'aexus-ssh' ? linkedAgent.projectUri.authority : undefined);
				if (boundHost && boundHost !== 'local') {
					const hostPill = append(footer, $('span.ade-mission-host-pill', {
						title: localize('adeMissionHostBadgeTip', "Cloud Host: {0}", boundHost),
						'data-node-host': boundHost,
					}));
					append(hostPill, $('span.codicon.codicon-cloud', { 'aria-hidden': 'true' }));
					append(hostPill, $('span', {}, boundHost));
				}
			}
			append(card, $('.ade-mission-port.port-in', { 'aria-hidden': 'true' }));
			append(card, $('.ade-mission-port.port-out', { 'aria-hidden': 'true' }));
			append(card, $('.ade-mission-port.port-ctx-top', { 'aria-hidden': 'true' }));
			append(card, $('.ade-mission-port.port-ctx-bottom', { 'aria-hidden': 'true' }));

			this.nodeElements.set(node.id, nodeEl);
			const resolvedAgentForClick = node.kind !== 'gate'
				? (agentByNodeId.get(node.id)
					?? (node.employeeKey ? agentByTreeKey.get(`emp:${node.employeeKey}`) : undefined)
					?? agentByTreeKey.get(node.id))
				: undefined;
			this.bindNodeInteractions(node, nodeEl, resolvedAgentForClick, nodeState);
		}

		this.renderEdgesSvg();
	}

	private applyEngineIcon(iconEl: HTMLElement, icon: URI | ThemeIcon | undefined): void {
		if (URI.isUri(icon)) {
			iconEl.className = 'ade-mission-engine-icon ade-mission-engine-icon-svg';
			iconEl.style.backgroundImage = asCSSUrl(icon);
		} else {
			const themeIcon = icon ?? Codicon.hubot;
			iconEl.className = `ade-mission-engine-icon ${ThemeIcon.asClassName(themeIcon)}`;
			iconEl.style.backgroundImage = '';
		}
	}

	private async openEnginePopover(agent: IAdeAgent, currentEngineId: string, anchorEl: HTMLElement): Promise<void> {
		this.closeEmployeePopover();
		if (!this.employeePopoverEl || !this.bodyEl || !this.sessionsService || !this.projectsService) {
			return;
		}
		const engines = await this.sessionsService.getEngines(agent.projectUri).catch(() => []);
		if (!this.employeePopoverEl || !this.bodyEl) {
			return;
		}
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const left = Math.max(12, Math.min(bodyRect.width - 236, anchorRect.left - bodyRect.left));
		const top = Math.max(12, Math.min(bodyRect.height - 260, anchorRect.bottom - bodyRect.top + 6));
		this.employeePopoverEl.style.left = `${Math.round(left)}px`;
		this.employeePopoverEl.style.top = `${Math.round(top)}px`;
		this.employeePopoverEl.hidden = false;

		append(this.employeePopoverEl, $('.ade-mission-emp-popover-title', {}, localize('adeMissionEnginePickerTitle', "Agent Engine for {0}", agent.label)));
		const list = append(this.employeePopoverEl, $('.ade-mission-emp-popover-list'));
		const entries = engines.length > 0
			? engines
			: Object.entries(ENGINE_FALLBACK_NAMES).map(([id, name]) => ({ id, name, icon: this.sessionsService?.getIcon(id) }));
		for (const eng of entries) {
			const isActive = eng.id === currentEngineId;
			const btn = append(list, $(`button.ade-mission-emp-popover-item${isActive ? '.active' : ''}`, {
				type: 'button',
				'data-ade-engine-option': eng.id,
			}));
			const lead = append(btn, $('span.ade-mission-engine-option-lead'));
			const iconEl = append(lead, $('span.ade-mission-engine-icon', { 'aria-hidden': 'true' }));
			this.applyEngineIcon(iconEl, eng.icon);
			append(lead, $('span', {}, eng.name));
			if (isActive) {
				append(btn, $('span.codicon.codicon-check', { 'aria-hidden': 'true' }));
			}
			this.popoverDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				this.projectsService?.updateAgentEnginePreferences?.(agent.id, { preferredEngineId: eng.id });
				this.closeEmployeePopover();
				this.renderGraphDom();
			}));
		}
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
		const missionId = this.activeMissionId;
		const rtStatus = missionId ? this.missionRuntimeService?.getRuntimeState(missionId).status : undefined;
		const isLiveRun = rtStatus === 'running' || rtStatus === 'paused';

		if (isLiveRun && missionId && this.missionRuntimeService) {
			void this.missionRuntimeService.patchMermaid(missionId, {
				caller: { isHumanUser: true },
				newMermaidText: nextMermaid,
				reason: `Reassign employee on ${nodeId}`,
			}).then(res => {
				if (this.activeMissionId !== missionId) {
					return;
				}
				if (res.ok) {
					this.mermaidText = nextMermaid;
					if (this.mermaidTextareaEl) {
						this.mermaidTextareaEl.value = nextMermaid;
					}
					this.closeEmployeePopover();
					this.parseAndRenderGraph(nextMermaid);
				} else {
					this.drawerStatusEl.textContent = res.error ?? localize('adeMissionAssignRejected', "Cannot reassign employee while Mission is running.");
					this.drawerStatusEl.className = 'ade-mission-drawer-status error';
					if (this.employeePopoverEl && !this.employeePopoverEl.hidden) {
						append(this.employeePopoverEl, $('.ade-mission-drawer-status.error', {}, res.error ?? localize('adeMissionAssignRejected', "Cannot reassign employee while Mission is running.")));
					}
				}
			});
			return;
		}

		this.mermaidText = nextMermaid;
		if (this.mermaidTextareaEl) {
			this.mermaidTextareaEl.value = nextMermaid;
		}
		if (missionId) {
			this.missionService?.updateMermaid(missionId, nextMermaid);
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

		// Compact host binding strip inside the existing employee popover (Local or saved SSH Cloud Host)
		if (this.activeMissionId && this.missionRuntimeService && this.cloudHostService) {
			const currentHost = this.missionRuntimeService.getRuntimeState(this.activeMissionId).boundary.nodeAssignments[node.id]?.hostAlias ?? 'local';
			const hostSection = append(this.employeePopoverEl, $('.ade-mission-host-section'));
			append(hostSection, $('.ade-mission-emp-popover-title', {}, localize('adeMissionHostPickerTitle', "Execution Host")));
			const hostSelect = append(hostSection, $('select.ade-mission-config-select.full', {
				'data-ade-node-host-select': node.id,
			})) as HTMLSelectElement;
			const localOpt = append(hostSelect, $('option', { value: 'local' }, localize('adeMissionHostLocal', "Local Machine"))) as HTMLOptionElement;
			if (currentHost === 'local') {
				localOpt.selected = true;
			}
			void this.cloudHostService.listHosts().then(hosts => {
				if (!hostSelect.isConnected) {
					return;
				}
				for (const h of hosts) {
					const opt = append(hostSelect, $('option', { value: h.alias }, `${h.name} (${h.alias})`)) as HTMLOptionElement;
					if (h.alias === currentHost) {
						opt.selected = true;
					}
				}
			}).catch(() => undefined);
			this.popoverDisposables.add(addDisposableListener(hostSelect, EventType.CHANGE, () => {
				if (this.activeMissionId && this.missionRuntimeService) {
					void this.missionRuntimeService.bindNodeHost(this.activeMissionId, node.id, { hostAlias: hostSelect.value }).then(() => {
						this.closeEmployeePopover();
						this.renderGraphDom();
					});
				}
			}));
		}

		// Compact off-graph supervisor binding strip inside the existing node popover (§6.1)
		if (this.activeMissionId && this.missionRuntimeService) {
			const missionId = this.activeMissionId;
			const rt = this.missionRuntimeService.getRuntimeState(missionId);
			const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const inGraphAgentIds = new Set(
				Object.values(rt.boundary.nodeAssignments)
					.map(a => a.agentId)
					.filter((id): id is string => Boolean(id)),
			);
			const currentSup = rt.boundary.supervisors.find(s => s.managedNodeIds.includes(node.id));
			const supSection = append(this.employeePopoverEl, $('.ade-mission-host-section'));
			append(supSection, $('.ade-mission-emp-popover-title', {}, localize('adeMissionSupervisorPickerTitle', "Off-graph Supervisor")));
			const supSelect = append(supSection, $('select.ade-mission-config-select.full', {
				'data-ade-node-supervisor-select': node.id,
			})) as HTMLSelectElement;
			const autoOpt = append(supSelect, $('option', { value: '' }, localize('adeMissionSupervisorAuto', "Auto (Mission Owner)"))) as HTMLOptionElement;
			if (!currentSup) {
				autoOpt.selected = true;
			}
			const eligibleSupervisors: { readonly id: string; readonly label: string; readonly tier: number }[] = [
				{ id: ADE_SECRETARY_ID, label: 'Secretary (L0)', tier: 0 },
			];
			for (const agent of this.projectsService?.agents ?? []) {
				if (this.projectsService?.isArchived(agent.id) || inGraphAgentIds.has(agent.id) || agent.treeNodeId) {
					continue;
				}
				const liveTier = resolveEffectiveRankDefinition(org, agent.role, this.projectsService?.hasSubordinates(agent.id) ?? false).tier;
				if (liveTier <= rt.boundary.offGraphMaxTier) {
					eligibleSupervisors.push({ id: agent.id, label: `${agent.label} (${formatTierTag(liveTier)})`, tier: liveTier });
				}
			}
			for (const sup of eligibleSupervisors) {
				const opt = append(supSelect, $('option', { value: sup.id }, sup.label)) as HTMLOptionElement;
				if (currentSup?.id === sup.id) {
					opt.selected = true;
				}
			}
			const supErrEl = append(supSection, $('.ade-mission-drawer-status.error', { hidden: 'true' }));
			this.popoverDisposables.add(addDisposableListener(supSelect, EventType.CHANGE, () => {
				if (!this.missionRuntimeService) {
					return;
				}
				const selectedId = supSelect.value.trim();
				const latestRt = this.missionRuntimeService.getRuntimeState(missionId);
				const updated: IMissionSupervisorBinding[] = [];
				let foundSelected = false;
				for (const existingSup of latestRt.boundary.supervisors) {
					const withoutNode = existingSup.managedNodeIds.filter(nid => nid !== node.id);
					if (selectedId && existingSup.id === selectedId) {
						foundSelected = true;
						updated.push({ ...existingSup, managedNodeIds: [...withoutNode, node.id] });
					} else if (withoutNode.length > 0 || existingSup.managedNodeIds.length === 0) {
						updated.push({ ...existingSup, managedNodeIds: withoutNode });
					}
				}
				if (selectedId && !foundSelected) {
					const meta = eligibleSupervisors.find(e => e.id === selectedId);
					updated.push({ id: selectedId, tier: meta?.tier ?? 0, managedNodeIds: [node.id] });
				}
				void this.missionRuntimeService.setBoundary(missionId, { supervisors: updated }).then(res => {
					if (res.ok) {
						this.closeEmployeePopover();
						this.syncRuntimeControlsUi();
					} else {
						supErrEl.textContent = res.error ?? localize('adeMissionSupervisorBindFailed', "Failed to bind supervisor.");
						supErrEl.hidden = false;
					}
				});
			}));
		}

		input.focus();
		input.select();
	}

	private openGateDecisionPopover(node: IMissionDagNode, anchorEl: HTMLElement): void {
		this.closeEmployeePopover();
		if (!this.employeePopoverEl || !this.bodyEl || !this.activeMissionId || !this.missionRuntimeService) {
			return;
		}
		const missionId = this.activeMissionId;
		const bodyRect = this.bodyEl.getBoundingClientRect();
		const anchorRect = anchorEl.getBoundingClientRect();
		const left = Math.max(12, Math.min(bodyRect.width - 252, anchorRect.left - bodyRect.left));
		const top = Math.max(12, Math.min(bodyRect.height - 160, anchorRect.bottom - bodyRect.top + 8));
		this.employeePopoverEl.style.left = `${Math.round(left)}px`;
		this.employeePopoverEl.style.top = `${Math.round(top)}px`;
		this.employeePopoverEl.hidden = false;

		append(this.employeePopoverEl, $('.ade-mission-emp-popover-title', {}, localize('adeMissionGateSignoffTitle', "Human Gate · {0}", node.label)));
		const noteInput = append(this.employeePopoverEl, $('input.ade-mission-emp-popover-input', {
			type: 'text',
			placeholder: localize('adeMissionGateNotePlaceholder', "Optional note or rejection reason..."),
			'data-ade-gate-note': 'true',
		})) as HTMLInputElement;
		const btnRow = append(this.employeePopoverEl, $('.ade-mission-gate-actions'));
		const approveBtn = append(btnRow, $('button.ade-mission-gate-btn.approve', {
			type: 'button',
			'data-ade-gate-approve': node.id,
		}, localize('adeMissionGateApproveBtn', "Approve"))) as HTMLButtonElement;
		const rejectBtn = append(btnRow, $('button.ade-mission-gate-btn.reject', {
			type: 'button',
			'data-ade-gate-reject': node.id,
		}, localize('adeMissionGateRejectBtn', "Reject"))) as HTMLButtonElement;
		const gateErrEl = append(this.employeePopoverEl, $('.ade-mission-drawer-status.error', {
			hidden: 'true',
			'data-ade-gate-error': 'true',
		}));

		const handleGateResult = (res: { readonly ok: boolean; readonly error?: string } | undefined) => {
			if (res?.ok) {
				this.closeEmployeePopover();
			} else {
				gateErrEl.textContent = res?.error ?? localize('adeMissionGateFailed', "Gate decision failed.");
				gateErrEl.hidden = false;
			}
		};
		this.popoverDisposables.add(addDisposableListener(approveBtn, EventType.CLICK, () => {
			void this.missionRuntimeService?.resolveGate(missionId, {
				nodeId: node.id,
				decision: 'approve',
				note: noteInput.value.trim() || undefined,
			}).then(handleGateResult);
		}));
		this.popoverDisposables.add(addDisposableListener(rejectBtn, EventType.CLICK, () => {
			void this.missionRuntimeService?.resolveGate(missionId, {
				nodeId: node.id,
				decision: 'reject',
				note: noteInput.value.trim() || undefined,
			}).then(handleGateResult);
		}));
		noteInput.focus();
	}

	private bindNodeInteractions(node: IMissionDagNode, nodeEl: HTMLElement, linkedAgent?: IAdeAgent, nodeState?: string): void {
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
			this.isDraggingNode = true;
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
			this.isDraggingNode = false;
			nodeEl.classList.remove('dragging');
			try {
				nodeEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
			const movedPx = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
			if (movedPx < 5) {
				// Clean click (not drag): Gate waiting -> inline Approve/Reject popover; task node -> open employee chat
				if (node.kind === 'gate' && nodeState === 'waiting_gate') {
					this.openGateDecisionPopover(node, nodeEl);
				} else if (linkedAgent && this.adeEditorService) {
					void this.adeEditorService.openAgent(linkedAgent.id);
				}
				return;
			}
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

			const edgeKind = getMissionEdgeKind(edge);
			const group = svgEl('g', {
				class: edgeKind === 'fail' ? 'ade-mission-edge-group is-fail-edge' : 'ade-mission-edge-group',
				'data-edge-id': edge.id,
				'data-edge-kind': edgeKind,
				'data-from': edge.from,
				'data-to': edge.to,
			});

			const path = svgEl('path', {
				class: 'ade-mission-edge-path',
				d: route.path,
				'marker-end': edgeKind === 'fail' ? 'url(#ade-mission-arrow-fail)' : 'url(#ade-mission-arrow-default)',
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
				path.setAttribute('marker-end', getMissionEdgeKind(edge) === 'fail' ? 'url(#ade-mission-arrow-fail)' : 'url(#ade-mission-arrow-default)');
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
		const reuseChainIds = new Set<string>();
		let reuseRouteBelow = false;
		if (hoveredNode?.employeeKey && (hoveredNode.employeeTotalOccurrences ?? 0) > 1) {
			const sequenceNodes = this.nodes
				.filter(n => n.employeeKey === hoveredNode.employeeKey)
				.sort((a, b) => (a.employeeOccurrence ?? 0) - (b.employeeOccurrence ?? 0));
			for (const peer of sequenceNodes) {
				reuseChainIds.add(peer.id);
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
			const aboveBlockedCount = sequenceNodes.filter(n => hasNodeVertically(n, 'above')).length;
			const belowBlockedCount = sequenceNodes.filter(n => hasNodeVertically(n, 'below')).length;
			const routeBelow = aboveBlockedCount > belowBlockedCount;
			reuseRouteBelow = routeBelow;

			const anchors: IMissionContextReuseAnchor[] = [];
			for (const seqNode of sequenceNodes) {
				const p = this.positions.get(seqNode.id);
				if (!p) {
					continue;
				}
				const sz = getNodeSize(seqNode);
				anchors.push({
					id: seqNode.id,
					x: p.x,
					borderY: routeBelow ? (p.y + sz.height / 2) : (p.y - sz.height / 2),
				});
			}

			const laneY = routeBelow
				? (Math.max(maxBottomY, ...anchors.map(a => a.borderY)) + 32)
				: (Math.min(minTopY, ...anchors.map(a => a.borderY)) - 32);

			const reuseHops = buildMissionContextReusePaths(anchors, laneY, routeBelow, 12);
			for (const hop of reuseHops) {
				const ribbon = svgEl('path', {
					class: 'ade-mission-context-edge',
					'data-context-link': `${hop.fromId}->${hop.toId}`,
					d: hop.path,
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
			const inReuse = reuseChainIds.has(id);
			el.classList.toggle('is-hovered', isHovered);
			el.classList.toggle('is-neighbor', isUp || isDown);
			el.classList.toggle('is-upstream', isUp);
			el.classList.toggle('is-downstream', isDown);
			el.classList.toggle('is-same-employee', isSameEmp);
			el.classList.toggle('has-ctx-port-top', inReuse && !reuseRouteBelow);
			el.classList.toggle('has-ctx-port-bottom', inReuse && reuseRouteBelow);
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
		this.syncRuntimeControlsUi();
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
