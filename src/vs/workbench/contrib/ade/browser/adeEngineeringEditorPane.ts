/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, EventType, getWindow, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	computeMissionAutoLayout,
	IMissionDagEdge,
	IMissionDagNode,
	IMissionNodePosition,
	parseMissionMermaidDag,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	removeNodesFromMermaid,
	renameEdgeLabelInMermaid,
	renameNodeInMermaid,
	upsertTaskMetadataInMermaid,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { formatCompactTokenCount, IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import { formatFinOpsUsd } from '../../../../platform/ade/common/adeModelPricing.js';
import {
	buildOrchestrationTokenDeltaView,
	findHighestRankStaffNode,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	MissionTaskStatus,
	planDynamicSubordinateCreation,
	updateMissionTaskNodeStatus,
	upsertDepartmentWhiteboard,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	addOrchestrationGroup,
	addStaffNodeToOrchestration,
	addWhiteboardNodeToOrchestration,
	computeOrchestrationAutoLayout,
	connectOrchestrationEdge,
	getOrchestrationNodeSize,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	moveOrchestrationNodeToGroup,
	OrchestrationLayoutMode,
	parseOrchestrationGraph,
	removeOrchestrationEdge,
	removeOrchestrationGroup,
	removeOrchestrationNode,
	renameOrchestrationEdgeLabel,
	renameOrchestrationGroup,
	renameOrchestrationNode,
	upsertOrchestrationNodeColorInCode,
	upsertOrchestrationWhiteboardInCode,
} from '../../../../platform/ade/common/adeOrchestrationGraph.js';
import { DEFAULT_ADE_ORGANIZATION_CONFIG, getMissionDisplayName, resolveEffectiveRankDefinition } from '../../../../platform/ade/common/adeRoleSchema.js';
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
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import {
	ADE_ENGINEERING_SCHEME,
	ADE_SECRETARY_ID,
	AdeEngineeringViewMode,
	encodeAdeEngineeringInputSpec,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	parseAdeEngineeringInputSpec,
} from '../common/ade.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { AdeMissionCanvasRenderer, getMissionNodeSize, IMissionCanvasRenderSnapshot } from './adeMissionCanvasRenderer.js';
import { AdeMissionFileDrawer } from './adeMissionFileDrawer.js';
import { AdeMissionHostCatalog } from './adeMissionHostCatalog.js';
import { AdeMissionMinimap } from './adeMissionMinimap.js';
import { MissionInspectorTab } from './adeMissionNodeInspector.js';
import { AdeMissionPopovers } from './adeMissionPopovers.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import './media/adeMissionCanvas.css';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const CANVAS_PAN_CLICK_THRESHOLD_PX = 5;
const MAX_UNDO_HISTORY = 50;

interface IEngineeringHistoryEntry {
	readonly viewMode: AdeEngineeringViewMode;
	readonly codeText: string;
	readonly positions: Record<string, IMissionNodePosition>;
	readonly nodePrompts: Record<string, string>;
	readonly label: string;
}

export interface IAdePendingMissionNodeFocus {
	readonly nodeId: string;
	readonly inspectorTab?: MissionInspectorTab;
	readonly openAgentBeside?: boolean;
}

export class AdeEngineeringEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeEngineering';
	readonly governorSessionId: string;
	readonly viewMode: AdeEngineeringViewMode;
	override readonly resource: URI;
	private readonly missionService: IAdeMissionService | undefined;
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	private pendingFocus: IAdePendingMissionNodeFocus | undefined;

	constructor(
		rawSpec: string,
		@IAdeProjectsService private readonly projects: IAdeProjectsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const parsed = parseAdeEngineeringInputSpec(rawSpec);
		this.governorSessionId = parsed.id;
		this.viewMode = parsed.viewMode;
		this.resource = URI.from({ scheme: ADE_ENGINEERING_SCHEME, path: `/${this.governorSessionId}/${this.viewMode}` });
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
		return this.viewMode === 'orchestration'
			? localize('adeEngOrchTabTitle', "{0} · Orchestration", base)
			: localize('adeEngMissionTabTitle', "{0} · Mission", base);
	}

	override getIcon(): ThemeIcon {
		return this.viewMode === 'orchestration' ? Codicon.organization : Codicon.typeHierarchySub;
	}

	setPendingFocus(focus: IAdePendingMissionNodeFocus | undefined): void {
		this.pendingFocus = focus;
	}

	consumePendingFocus(): IAdePendingMissionNodeFocus | undefined {
		const next = this.pendingFocus;
		this.pendingFocus = undefined;
		return next;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeEngineeringEditorInput
			&& other.governorSessionId === this.governorSessionId
			&& other.viewMode === this.viewMode;
	}
}

/**
 * Workbench-wide page-visibility animation guardrail for all ADE views.
 * Toggles `html.ade-page-hidden` on every registered VS Code window so ALL
 * infinite CSS animations pause when a window is minimized, hidden, or occluded.
 */
export class AdePageVisibilityAnimationGuard extends Disposable {
	static readonly ID = 'workbench.contrib.adePageVisibilityAnimationGuard';

	constructor() {
		super();
		const attachToWindow = (win: Window, store: DisposableStore) => {
			const doc = win.document;
			const sync = () => {
				const hidden = Boolean(doc.hidden || doc.visibilityState === 'hidden');
				doc.documentElement.classList.toggle('ade-page-hidden', hidden);
			};
			sync();
			store.add(addDisposableListener(doc, 'visibilitychange', sync));
			store.add({
				dispose: () => {
					if (!doc.hidden && doc.visibilityState !== 'hidden') {
						doc.documentElement.classList.remove('ade-page-hidden');
					}
				},
			});
		};

		for (const { window: win, disposables } of getWindows()) {
			const localStore = this._register(new DisposableStore());
			disposables.add(localStore);
			attachToWindow(win, localStore);
		}
		this._register(onDidRegisterWindow(({ window: win, disposables }) => {
			const localStore = this._register(new DisposableStore());
			disposables.add(localStore);
			attachToWindow(win, localStore);
		}));
	}
}

export class AdeEngineeringEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeEngineeringEditorInput;
	}

	serialize(input: EditorInput): string | undefined {
		return input instanceof AdeEngineeringEditorInput
			? encodeAdeEngineeringInputSpec(input.governorSessionId, input.viewMode)
			: undefined;
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		if (!serialized) {
			return undefined;
		}
		return instantiationService.createInstance(AdeEngineeringEditorInput, serialized);
	}
}

/**
 * Minimalist dual-view ADE Engineering Canvas EditorPane:
 * - View 1 (`mission`): Strictly acyclic Mermaid Task DAG + 2-pane source drawer
 *   (Mermaid code editor + All Task Nodes' descriptions) + click-to-edit task popover.
 * - View 2 (`orchestration`): All-staff cyclic/bidirectional free-topology canvas
 *   with 4-side x 3-slot multi-anchor routing, department shared whiteboards (lightweight pointers),
 *   token relay batons, and a single-pane declarative code drawer bidirectionally synced in real time.
 * - Minimalist Chrome Invariant: ONLY ONE button in the top-left corner of the canvas
 *   (plus existing blank-canvas right-click menu to create nodes).
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
	private readonly hostCatalog: AdeMissionHostCatalog;

	private rootEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private emptyHintEl!: HTMLElement;
	private emptyHintTitleEl!: HTMLElement;
	private emptyHintSubEl!: HTMLElement;
	private canvasAlertEl!: HTMLElement;
	private canvasAlertIconEl!: HTMLElement;
	private canvasAlertTextEl!: HTMLElement;
	private canvasAlertOpenFileBtn!: HTMLButtonElement;
	private marqueeBoxEl!: HTMLElement;
	private selectionHudEl!: HTMLElement;
	private selectionHudLabelEl!: HTMLElement;
	private searchBarEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private searchCountEl!: HTMLElement;
	private consoleBarEl!: HTMLElement;
	private viewOrchBtnEl!: HTMLButtonElement;
	private viewMissionBtnEl!: HTMLButtonElement;
	private viewSplitBtnEl!: HTMLButtonElement;
	private consoleTokensEl!: HTMLElement;
	private consoleSpendEl!: HTMLElement;
	private consolePauseBtnEl!: HTMLButtonElement;
	private consoleAbortBtnEl!: HTMLButtonElement;
	private consoleMinimapBtnEl!: HTMLButtonElement;

	private fileDrawer!: AdeMissionFileDrawer;
	private popovers!: AdeMissionPopovers;
	private renderer!: AdeMissionCanvasRenderer;
	private minimap!: AdeMissionMinimap;

	private undoStack: IEngineeringHistoryEntry[] = [];
	private redoStack: IEngineeringHistoryEntry[] = [];
	private preDragHistorySnapshot: IEngineeringHistoryEntry | undefined;
	private lastCoalescedHistoryAt = 0;

	private viewMode: AdeEngineeringViewMode = 'mission';
	private activeMissionId: string | undefined;
	private activePromptEditSource: 'drawer' | 'popover' | undefined;
	private isDraggingNode = false;

	// Mission View (Task DAG) State
	private mermaidText = '';
	private direction: 'LR' | 'TD' = 'LR';
	private nodes: readonly IMissionDagNode[] = [];
	private edges: readonly IMissionDagEdge[] = [];

	// Orchestration View (All-Staff Cyclic Topology) State
	private orchestrationText = '';
	private orchDirection: 'LR' | 'TD' = 'LR';
	private orchLayoutMode: OrchestrationLayoutMode = 'lr';
	private orchNodes: readonly IOrchestrationGraphNode[] = [];
	private orchEdges: readonly IOrchestrationGraphEdge[] = [];
	private orchDepartments: readonly IOrchestrationDepartmentGroup[] = [];

	// Shared Canvas Viewport & Selection State
	private positions = new Map<string, IMissionNodePosition>();
	private selectedNodeIds = new Set<string>();
	private selectedEdgeKey: string | undefined;
	private searchMatchIds: string[] = [];
	private searchActiveIdx = -1;

	private panX = 0;
	private panY = 0;
	private zoom = 1;
	private transformRafId: number | undefined;
	private edgeRerouteRafId: number | undefined;
	private pendingDraggedNodeId: string | undefined;
	private pendingDraggedMultipleNodes = false;
	private canvasAlertTimer: number | undefined;
	private abortConfirmUntil = 0;
	private abortConfirmTimer: number | undefined;
	private lastProjectsFingerprint = '';
	private lastTaskStatusFingerprint = '';
	private lastOrchAuxiliaryFingerprint = '';
	private isEditorTabVisible = true;
	private isPaneDisposed = false;

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

		this.hostCatalog = this._register(new AdeMissionHostCatalog(
			storageService,
			this.sessionsService,
			this.cloudHostService,
			this.commandService,
		));

		if (this.missionService) {
			this._register(this.missionService.onDidChange(() => {
				if (!this.activeMissionId || !this.renderer) {
					return;
				}
				const latest = this.missionService?.getMission(this.activeMissionId);
				if (!latest) {
					return;
				}
				if (this.viewMode === 'mission') {
					if (latest.mermaidText !== this.mermaidText) {
						this.mermaidText = latest.mermaidText;
						this.fileDrawer?.setCodeValue(this.mermaidText);
						this.parseAndRenderMissionGraph(this.mermaidText);
					} else {
						this.syncAllNodePromptViews(this.activePromptEditSource);
						const statusFp = this.computeTaskStatusesFingerprint(latest.taskStatuses);
						if (statusFp !== this.lastTaskStatusFingerprint) {
							this.lastTaskStatusFingerprint = statusFp;
							if (!this.isDraggingNode) {
								this.syncGraphDom();
							}
							this.fileDrawer?.syncTaskDescriptionsPane(true);
						}
					}
				} else {
					const latestOrch = latest.orchestrationText ?? '';
					if (latestOrch !== this.orchestrationText) {
						this.orchestrationText = latestOrch;
						this.fileDrawer?.setCodeValue(this.orchestrationText);
						this.parseAndRenderOrchestrationGraph(this.orchestrationText);
					} else {
						const auxFp = this.computeOrchAuxiliaryFingerprint(latest.whiteboards, latest.orchestrationRuntime);
						if (auxFp !== this.lastOrchAuxiliaryFingerprint) {
							this.lastOrchAuxiliaryFingerprint = auxFp;
							if (!this.isDraggingNode) {
								this.syncGraphDom();
							}
						}
					}
				}
			}));
		}

		if (this.missionRuntimeService) {
			this._register(this.missionRuntimeService.onDidChange(changedMissionId => {
				if (!this.activeMissionId || changedMissionId !== this.activeMissionId || !this.renderer) {
					return;
				}
				if (!this.isDraggingNode) {
					this.syncGraphDom();
				}
				if (this.viewMode === 'mission') {
					this.fileDrawer?.syncTaskDescriptionsPane(true);
				}
			}));
		}

		if (this.projectsService) {
			this._register(this.projectsService.onDidChange(() => {
				if (!this.activeMissionId || this.viewMode !== 'orchestration' || this.orchNodes.length === 0 || this.isDraggingNode || !this.renderer) {
					return;
				}
				const nextFp = this.computeActiveProjectsFingerprint();
				if (nextFp !== this.lastProjectsFingerprint) {
					this.lastProjectsFingerprint = nextFp;
					this.syncGraphDom();
				}
			}));
		}

		if (this.sessionsService) {
			this._register(this.sessionsService.onDidChangeEngines(() => {
				if (this.activeMissionId && this.viewMode === 'orchestration' && this.orchNodes.length > 0 && !this.isDraggingNode && this.renderer) {
					this.syncGraphDom();
					this.prewarmHosts();
				}
			}));
		}

		const extensionService = tryGet(IExtensionService);
		if (extensionService) {
			void extensionService.whenInstalledExtensionsRegistered().then(() => {
				if (!this.isPaneDisposed && this.activeMissionId && this.getActiveNodeCount() > 0 && !this.isDraggingNode && this.renderer) {
					this.syncGraphDom();
				}
			});
		}

		this._register(themeService.onDidColorThemeChange(() => {
			if (this.activeMissionId && this.getActiveNodeCount() > 0 && !this.isDraggingNode && this.renderer) {
				this.syncGraphDom();
			}
		}));

		this._register(this.hostCatalog.onDidChangeHosts(() => {
			if (this.activeMissionId && this.viewMode === 'orchestration' && this.orchNodes.length > 0 && !this.isDraggingNode && this.renderer) {
				this.syncGraphDom();
			}
		}));

		this._register(onDidChangeAdeLocale(() => {
			this.syncEmptyHintCopy();
			this.updateConsoleBar();
			if (this.activeMissionId && this.renderer && !this.isDraggingNode) {
				if (this.viewMode === 'orchestration') {
					this.parseAndRenderOrchestrationGraph(this.orchestrationText);
				} else {
					this.parseAndRenderMissionGraph(this.mermaidText);
				}
			}
		}));

		this._register({
			dispose: () => {
				this.isPaneDisposed = true;
				this.isDraggingNode = false;
				this.cancelScheduledFrames();
				this.clearCanvasAlertTimer();
				this.clearAbortConfirmTimer();
				const doc = this.rootEl ? getWindow(this.rootEl).document : undefined;
				if (doc && !doc.hidden && doc.visibilityState !== 'hidden') {
					doc.documentElement.classList.remove('ade-page-hidden');
				}
			},
		});
	}

	getViewMode(): AdeEngineeringViewMode {
		return this.viewMode;
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.ade-mission-editor.ade-eng-editor', {
			tabindex: 0,
			role: 'region',
			'aria-label': adeBi(localize('adeEngCanvasAria', "Engineering Canvas"), '工程编排画布'),
		}));
		this.bodyEl = append(this.rootEl, $('.ade-mission-body.ade-eng-body'));

		// ONLY ONE top-left button on the entire canvas + its minimalist dual-mode drawer
		this.fileDrawer = this._register(new AdeMissionFileDrawer(this.bodyEl, {
			getActiveMissionId: () => this.activeMissionId,
			getViewMode: () => this.viewMode,
			getCodeText: () => (this.viewMode === 'orchestration' ? this.orchestrationText : this.mermaidText),
			getMissionTaskNodes: () => this.nodes,
			getTaskDescriptions: () => this.getActiveNodePrompts(),
			getTaskStatuses: () => this.getActiveTaskStatuses(),
			getOrchestrationLayoutMode: () => this.orchLayoutMode,
			onChangeOrchestrationLayoutMode: mode => {
				this.handleChangeOrchestrationLayoutMode(mode);
			},
			onCodeDraftChange: nextText => {
				this.handleCodeDraftChange(nextText);
			},
			onTaskDescriptionEdit: (nodeId, nextVal) => {
				if (!this.activeMissionId) {
					return;
				}
				this.commitNodePromptEdit(this.activeMissionId, nodeId, nextVal, 'drawer');
			},
			onDrawerOpenChanged: () => {
				this.syncHudLayoutClasses();
			},
		}));

		this.viewportEl = append(this.bodyEl, $('.ade-mission-viewport.ade-eng-viewport'));
		this.marqueeBoxEl = append(this.viewportEl, $('.ade-mission-marquee-box', {
			'data-ade-marquee-box': 'true',
		}));
		this.marqueeBoxEl.hidden = true;

		// Top-center floating Global Run Console & Dual-View Switcher (never overlaps top-left drawer button)
		this.consoleBarEl = append(this.bodyEl, $('.ade-eng-console-bar', {
			role: 'toolbar',
			'aria-label': adeBi(localize('adeEngConsoleBarAria', "Engineering Global Console"), '工程编排全局控制台'),
			'data-ade-eng-console-bar': 'true',
		}));
		this._register(addDisposableListener(this.consoleBarEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

		const viewSwitch = append(this.consoleBarEl, $('.ade-eng-view-switch', {
			role: 'tablist',
			'aria-label': adeBi(localize('adeEngViewSwitchAria', "Switch Engineering View"), '切换工程视图'),
		}));
		this.viewOrchBtnEl = append(viewSwitch, $('button.ade-eng-view-btn', {
			type: 'button',
			role: 'tab',
			'data-ade-eng-view-btn': 'orchestration',
			title: adeBi(localize('adeEngViewOrchTip', "Orchestration · All-Staff Cyclic Topology"), '员工自由编排拓扑视图'),
		})) as HTMLButtonElement;
		append(this.viewOrchBtnEl, $('span.codicon.codicon-organization', { 'aria-hidden': 'true' }));
		append(this.viewOrchBtnEl, $('span', {}, adeBi(localize('adeEngViewOrchLabel', "Staff"), '员工拓扑')));
		this._register(addDisposableListener(this.viewOrchBtnEl, EventType.CLICK, () => this.switchViewMode('orchestration', false)));

		this.viewMissionBtnEl = append(viewSwitch, $('button.ade-eng-view-btn', {
			type: 'button',
			role: 'tab',
			'data-ade-eng-view-btn': 'mission',
			title: adeBi(localize('adeEngViewMissionTip', "Mission · Acyclic Task DAG"), '任务有向无环图 (DAG) 视图'),
		})) as HTMLButtonElement;
		append(this.viewMissionBtnEl, $('span.codicon.codicon-type-hierarchy-sub', { 'aria-hidden': 'true' }));
		append(this.viewMissionBtnEl, $('span', {}, adeBi(localize('adeEngViewMissionLabel', "Task DAG"), '任务 DAG')));
		this._register(addDisposableListener(this.viewMissionBtnEl, EventType.CLICK, () => this.switchViewMode('mission', false)));

		this.viewSplitBtnEl = append(viewSwitch, $('button.ade-eng-view-btn.is-split', {
			type: 'button',
			'data-ade-eng-view-split': 'true',
			title: adeBi(localize('adeEngViewSplitTip', "Open both views side by side"), '同屏分栏对照查看双视图'),
		})) as HTMLButtonElement;
		append(this.viewSplitBtnEl, $('span.codicon.codicon-split-horizontal', { 'aria-hidden': 'true' }));
		this._register(addDisposableListener(this.viewSplitBtnEl, EventType.CLICK, () => {
			this.switchViewMode(this.viewMode === 'orchestration' ? 'mission' : 'orchestration', true);
		}));

		append(this.consoleBarEl, $('span.ade-eng-console-sep', { 'aria-hidden': 'true' }));

		this.consoleTokensEl = append(this.consoleBarEl, $('span.ade-eng-console-pill.is-tokens', {
			'data-ade-eng-console-tokens': 'true',
		}));
		this.consoleSpendEl = append(this.consoleBarEl, $('span.ade-eng-console-pill.is-spend', {
			'data-ade-eng-console-spend': 'true',
		}));
		this.consoleSpendEl.hidden = true;

		append(this.consoleBarEl, $('span.ade-eng-console-sep', { 'aria-hidden': 'true' }));

		this.consolePauseBtnEl = append(this.consoleBarEl, $('button.ade-eng-console-btn.is-pause', {
			type: 'button',
			'data-ade-eng-pause-btn': 'true',
		})) as HTMLButtonElement;
		this._register(addDisposableListener(this.consolePauseBtnEl, EventType.CLICK, () => void this.handleToggleOrchestrationPause()));

		this.consoleAbortBtnEl = append(this.consoleBarEl, $('button.ade-eng-console-btn.is-danger', {
			type: 'button',
			'data-ade-eng-abort-btn': 'true',
		})) as HTMLButtonElement;
		this._register(addDisposableListener(this.consoleAbortBtnEl, EventType.CLICK, () => void this.handleAbortAllOrchestrationTokens()));

		this.consoleMinimapBtnEl = append(this.consoleBarEl, $('button.ade-eng-console-btn.is-minimap', {
			type: 'button',
			'data-ade-eng-minimap-btn': 'true',
			title: adeBi(localize('adeEngMinimapToggleTip', "Toggle Minimap Overview"), '显示/隐藏拓扑小地图'),
		})) as HTMLButtonElement;
		append(this.consoleMinimapBtnEl, $('span.codicon.codicon-map', { 'aria-hidden': 'true' }));
		this._register(addDisposableListener(this.consoleMinimapBtnEl, EventType.CLICK, () => {
			this.minimap?.setUserVisible(!this.minimap.isUserVisible());
			this.updateConsoleBar();
		}));

		// Interactive Bottom-Right Minimap Overview for Large Topologies
		this.minimap = this._register(new AdeMissionMinimap(this.bodyEl, {
			onNavigateToWorldCenter: (worldX, worldY) => this.centerViewportOnWorldPoint(worldX, worldY),
		}));

		// Floating Node Search Bar (hidden until Cmd/Ctrl+F)
		this.searchBarEl = append(this.bodyEl, $('.ade-mission-search-bar', {
			role: 'search',
			'aria-label': adeBi(localize('adeMissionSearchAria', "Search Canvas Nodes"), '搜索画布节点'),
			'data-ade-canvas-search': 'true',
		}));
		this.searchBarEl.hidden = true;
		this._register(addDisposableListener(this.searchBarEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		append(this.searchBarEl, $('span.codicon.codicon-search.ade-mission-search-ico', { 'aria-hidden': 'true' }));
		this.searchInputEl = append(this.searchBarEl, $('input.ade-mission-search-input', {
			type: 'text',
			placeholder: adeBi(localize('adeMissionSearchPlaceholder', "Search nodes… (Enter next)"), '搜索节点 ID / 名称 / 描述… (Enter 下一个)'),
			'aria-label': localize('adeMissionSearchInputAria', "Filter nodes"),
			'data-ade-canvas-search-input': 'true',
		})) as HTMLInputElement;
		this.searchCountEl = append(this.searchBarEl, $('span.ade-mission-search-count', {
			'data-ade-canvas-search-count': 'true',
		}, ''));
		const searchPrevBtn = append(this.searchBarEl, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionSearchPrevTip', "Previous match (Shift+Enter)"), '上一个匹配 (Shift+Enter)'),
			'data-ade-canvas-search-prev': 'true',
		})) as HTMLButtonElement;
		searchPrevBtn.appendChild($('span.codicon.codicon-arrow-up'));
		const searchNextBtn = append(this.searchBarEl, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionSearchNextTip', "Next match (Enter)"), '下一个匹配 (Enter)'),
			'data-ade-canvas-search-next': 'true',
		})) as HTMLButtonElement;
		searchNextBtn.appendChild($('span.codicon.codicon-arrow-down'));
		const searchCloseBtn = append(this.searchBarEl, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionSearchCloseTip', "Close search (Esc)"), '关闭搜索 (Esc)'),
			'data-ade-canvas-search-close': 'true',
		})) as HTMLButtonElement;
		searchCloseBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(this.searchInputEl, EventType.INPUT, () => this.updateCanvasSearchResults(true)));
		this._register(addDisposableListener(this.searchInputEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				this.stepCanvasSearchMatch(e.shiftKey ? -1 : 1);
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				e.stopPropagation();
				this.stepCanvasSearchMatch(1);
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				e.stopPropagation();
				this.stepCanvasSearchMatch(-1);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.closeCanvasSearch(true);
			}
		}));
		this._register(addDisposableListener(searchPrevBtn, EventType.CLICK, () => this.stepCanvasSearchMatch(-1)));
		this._register(addDisposableListener(searchNextBtn, EventType.CLICK, () => this.stepCanvasSearchMatch(1)));
		this._register(addDisposableListener(searchCloseBtn, EventType.CLICK, () => this.closeCanvasSearch(true)));

		// Multi-selection Action HUD Pill (hidden unless >= 2 nodes selected)
		this.selectionHudEl = append(this.bodyEl, $('.ade-mission-selection-hud', {
			role: 'status',
			'aria-live': 'polite',
			'data-ade-selection-hud': 'true',
		}));
		this.selectionHudEl.hidden = true;
		this._register(addDisposableListener(this.selectionHudEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.selectionHudLabelEl = append(this.selectionHudEl, $('span.ade-mission-selection-hud-label', {
			'data-ade-selection-hud-label': 'true',
		}));
		const batchDelBtn = append(this.selectionHudEl, $('button.ade-mission-selection-hud-btn.danger', {
			type: 'button',
			title: adeBi(localize('adeMissionBatchDeleteTip', "Delete selected nodes (Delete / Backspace)"), '删除全部选中节点 (Delete / Backspace)'),
			'data-ade-selection-batch-delete': 'true',
		})) as HTMLButtonElement;
		batchDelBtn.appendChild($('span.codicon.codicon-trash'));
		append(batchDelBtn, $('span', {}, adeBi(localize('adeMissionBatchDeleteLabel', "Delete"), '删除')));
		this._register(addDisposableListener(batchDelBtn, EventType.CLICK, () => this.deleteSelectedItems()));
		const clearSelBtn = append(this.selectionHudEl, $('button.ade-mission-selection-hud-btn', {
			type: 'button',
			title: adeBi(localize('adeMissionClearSelectionTip', "Clear selection (Esc)"), '取消多选 (Esc)'),
			'data-ade-selection-clear': 'true',
		})) as HTMLButtonElement;
		clearSelBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(clearSelBtn, EventType.CLICK, () => this.selectNode(undefined)));

		// Transient Canvas Alert Toast (hidden unless syntax/action feedback fires)
		this.canvasAlertEl = append(this.bodyEl, $('.ade-mission-canvas-alert', {
			role: 'alert',
			'aria-live': 'assertive',
			'data-ade-mission-canvas-alert': 'true',
		}));
		this.canvasAlertEl.hidden = true;
		this.canvasAlertIconEl = append(this.canvasAlertEl, $('span.codicon.codicon-error.ade-mission-canvas-alert-icon', { 'aria-hidden': 'true' }));
		this.canvasAlertTextEl = append(this.canvasAlertEl, $('span.ade-mission-canvas-alert-text', {
			'data-ade-mission-canvas-alert-text': 'true',
		}));
		this.canvasAlertOpenFileBtn = append(this.canvasAlertEl, $('button.ade-mission-canvas-alert-action', {
			type: 'button',
			'data-ade-mission-canvas-alert-open-file': 'true',
		}, adeBi(localize('adeEngAlertOpenSource', "Open Code"), '打开源码'))) as HTMLButtonElement;
		this.canvasAlertOpenFileBtn.hidden = true;
		this._register(addDisposableListener(this.canvasAlertOpenFileBtn, EventType.CLICK, () => this.toggleFileDrawer(true)));
		const alertDismissBtn = append(this.canvasAlertEl, $('button.ade-mission-canvas-alert-close', {
			type: 'button',
			title: adeBi(localize('adeMissionAlertDismiss', "Dismiss"), '关闭'),
			'aria-label': adeBi(localize('adeMissionAlertDismiss', "Dismiss"), '关闭'),
			'data-ade-mission-canvas-alert-dismiss': 'true',
		})) as HTMLButtonElement;
		alertDismissBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(alertDismissBtn, EventType.CLICK, () => this.hideCanvasAlert()));

		// Minimalist text-only empty hint (strictly ZERO buttons on canvas!)
		this.emptyHintEl = append(this.viewportEl, $('.ade-mission-empty-hint.is-minimal', {
			'data-ade-mission-empty-onboarding': 'true',
		}));
		const emptyHero = append(this.emptyHintEl, $('.ade-mission-empty-hero'));
		append(emptyHero, $('span.codicon.codicon-type-hierarchy-sub', { 'aria-hidden': 'true' }));
		this.emptyHintTitleEl = append(emptyHero, $('.ade-mission-empty-hint-title'));
		this.emptyHintSubEl = append(emptyHero, $('.ade-mission-empty-hint-sub'));
		this.syncEmptyHintCopy();

		this.worldEl = append(this.viewportEl, $('.ade-mission-world.ade-eng-world'));

		this.renderer = this._register(new AdeMissionCanvasRenderer(
			this.worldEl,
			this.emptyHintEl,
			this.hostCatalog,
			{
				onHoverNode: nodeId => this.setHoveredNode(nodeId),
				onSelectNode: (node, _anchorEl, opts) => this.selectNode(node.id, opts),
				onSelectEdge: edge => this.selectEdge(edge),
				onDoubleClickNode: (_node, agentId) => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId);
					}
				},
				onOpenMissionTaskPopover: (node, anchorEl) => {
					this.openMissionTaskPopover(node, anchorEl);
				},
				onOpenWhiteboardPopover: (whiteboard, anchorEl) => {
					this.openWhiteboardPopover(whiteboard, anchorEl);
				},
				onOpenOrchestrationTokenPopover: (staffLabel, token, anchorEl) => {
					this.openOrchestrationTokenPopover(staffLabel, token, anchorEl);
				},
				onOpenEmployeePopover: (node, anchorEl) => {
					this.popovers.openEmployeePopover(this.activeMissionId, node, [], anchorEl);
				},
				onOpenModelPopover: (nodeId, agent, engineId, anchorEl, options) => {
					if (this.activeMissionId) {
						this.popovers.openModelPopover(this.activeMissionId, nodeId, agent, engineId, anchorEl, options);
					}
				},
				onOpenEnginePopover: (nodeId, agent, engineId, anchorEl, options) => {
					if (this.activeMissionId) {
						void this.popovers.openEnginePopover(this.activeMissionId, nodeId, agent, engineId, anchorEl, options);
					}
				},
				onOpenHostPopover: (node, currentHost, anchorEl) => {
					if (this.activeMissionId) {
						void this.popovers.openHostPopover(this.activeMissionId, node, currentHost, anchorEl);
					}
				},
				onOpenNodePromptPopover: (node, anchorEl) => {
					this.openMissionTaskPopover(node, anchorEl);
				},
				onOpenNodeColorPopover: (nodeId, label, currentColor, anchorEl) => {
					this.popovers.openNodeColorPopover(label, currentColor, anchorEl, nextColor => {
						this.setNodeColorVisual(nodeId, nextColor);
					});
				},
				onOpenGateDecisionPopover: (node, anchorEl, preferredTokenId, options) => {
					if (this.activeMissionId) {
						this.popovers.openGateDecisionPopover(this.activeMissionId, node, anchorEl, preferredTokenId, options);
					}
				},
				onRenameNode: (nodeId, nextLabel) => {
					this.renameVisualNode(nodeId, nextLabel);
				},
				onRenameEdgeLabel: (fromId, toId, nextLabel) => {
					this.renameVisualEdgeLabel(fromId, toId, nextLabel);
				},
				onRenameGroup: (groupId, nextName) => {
					this.renameOrchestrationGroupVisual(groupId, nextName);
				},
				onGroupContextMenu: (group, clientX, clientY) => {
					this.openGroupContextMenu(group, clientX, clientY);
				},
				onConnectNodes: (fromNodeId, toNodeId, opts) => {
					this.connectVisualEdge(fromNodeId, toNodeId, opts);
				},
				onNodeContextMenu: (node, clientX, clientY) => {
					this.openNodeContextMenu(node, clientX, clientY);
				},
				onEdgeContextMenu: (edge, clientX, clientY) => {
					this.openEdgeContextMenu(edge, clientX, clientY);
				},
				onOpenAgentSession: agentId => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId);
					}
				},
				getDragGroupNodeIds: anchorNodeId => {
					if (this.selectedNodeIds.size > 1 && this.selectedNodeIds.has(anchorNodeId)) {
						return [...this.selectedNodeIds];
					}
					return [anchorNodeId];
				},
				onStartNodeDrag: () => {
					this.popovers.close();
					this.isDraggingNode = true;
					this.preDragHistorySnapshot = this.captureHistorySnapshot(adeBi(localize('adeMissionHistoryMoveNode', "Move node"), '移动节点'));
				},
				onDragNodeMove: (nodeId, nextPos) => {
					this.positions.set(nodeId, nextPos);
					this.scheduleEdgeReroute(nodeId);
				},
				onDragNodesMove: moves => {
					if (moves.length === 0) {
						return;
					}
					for (const move of moves) {
						this.positions.set(move.nodeId, move.pos);
					}
					this.scheduleEdgeReroute(moves.length === 1 ? moves[0].nodeId : undefined);
				},
				onEndNodeDrag: (nodeId, movedPx) => {
					this.handleEndNodesDrag([nodeId], movedPx);
				},
				onEndNodesDrag: (movedNodeIds, movedPx) => {
					this.handleEndNodesDrag(movedNodeIds, movedPx);
				},
				getNodePosition: nodeId => this.positions.get(nodeId),
				getZoom: () => this.zoom,
			},
		));

		this.popovers = this._register(new AdeMissionPopovers(
			this.bodyEl,
			this.hostCatalog,
			this.projectsService,
			this.missionRuntimeService,
			this.roleSchemaService,
			this.cloudHostService,
			{
				getActiveMissionId: () => this.activeMissionId,
				getMissionGraph: () => ({ nodes: this.nodes, edges: this.edges }),
				getNodePrompt: (missionId, nodeId) => this.missionService?.getMission(missionId)?.nodePrompts?.[nodeId] ?? '',
				canSwitchAgentEngine: agent => this.canSwitchAgentEngine(agent),
				getExplicitNodeHost: (missionId, nodeId) =>
					this.missionRuntimeService?.getRuntimeState(missionId).boundary.nodeAssignments[nodeId]?.hostAlias
					?? this.orchNodes.find(n => n.id === nodeId)?.hostAlias,
				resolveSupervisorDisplay: supId => this.resolveStaffDisplay(supId),
				onAssignNodeEmployee: () => undefined,
				onNodePromptEdit: (missionId, nodeId, nextVal) => this.commitNodePromptEdit(missionId, nodeId, nextVal, 'popover'),
				onOpenDrawerForNodePrompt: nodeId => this.toggleFileDrawer(true, nodeId),
				onOpenAgentSession: agentId => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId);
					}
				},
				onUpdateOrchestrationStaffConfig: async (missionId, nodeId, patch) => {
					await this.handleUpdateOrchestrationStaffConfig(missionId, nodeId, patch);
				},
				onActionFeedback: (message, kind) => this.reportFeedback(message, kind),
				onGraphVisualInvalidated: prewarmHosts => {
					if (this.isPaneDisposed) {
						return;
					}
					this.syncGraphDom();
					if (prewarmHosts) {
						this.prewarmHosts();
					}
				},
				onRuntimeControlsInvalidated: () => {
					if (!this.isPaneDisposed && !this.isDraggingNode) {
						this.syncGraphDom();
					}
				},
			},
		));

		this.installCanvasInteractions();
		this.applyWorldTransformNow();
	}

	private syncEmptyHintCopy(): void {
		if (!this.emptyHintTitleEl || !this.emptyHintSubEl) {
			return;
		}
		if (this.viewMode === 'orchestration') {
			this.emptyHintTitleEl.textContent = adeBi(
				localize('adeOrchEmptyTitle', "Orchestration · All-Staff Free Topology"),
				'Orchestration · 全员自由编排画布',
			);
			this.emptyHintSubEl.textContent = adeBi(
				localize('adeOrchEmptySub', "Right-click anywhere to create staff or a department whiteboard, or click the top-left button to edit declarative code."),
				'右键空白处创建员工节点或部门共享白板，或点击左上角编排按钮编写声明式拓扑代码。',
			);
		} else {
			this.emptyHintTitleEl.textContent = adeBi(
				localize('adeMissionEmptyTaskTitle', "Mission · Acyclic Task DAG"),
				'Mission · 任务有向无环图 (DAG)',
			);
			this.emptyHintSubEl.textContent = adeBi(
				localize('adeMissionEmptyTaskSub', "Right-click anywhere to create a task node, or click the top-left button to edit Mermaid code and task descriptions."),
				'右键空白处创建任务节点，或点击左上角编排按钮编写 Mermaid 代码与任务描述。',
			);
		}
	}

	private getActiveNodeCount(): number {
		return this.viewMode === 'orchestration' ? this.orchNodes.length : this.nodes.length;
	}

	private getActiveNodeIds(): readonly string[] {
		return this.viewMode === 'orchestration'
			? this.orchNodes.map(n => n.id)
			: this.nodes.map(n => n.id);
	}

	private getNodeDimensions(nodeId: string): { readonly width: number; readonly height: number } {
		if (this.viewMode === 'orchestration') {
			const oNode = this.orchNodes.find(n => n.id === nodeId);
			return oNode ? getOrchestrationNodeSize(oNode) : { width: 316, height: 220 };
		}
		const mNode = this.nodes.find(n => n.id === nodeId);
		return mNode ? getMissionNodeSize(mNode) : getMissionNodeSize({ id: nodeId, label: nodeId, kind: 'task' });
	}

	private getEffectiveRuntimeState(): IMissionRuntimeState | undefined {
		return this.activeMissionId ? this.missionRuntimeService?.getRuntimeState(this.activeMissionId) : undefined;
	}

	private getActiveNodePrompts(): Readonly<Record<string, string>> {
		return (this.activeMissionId ? this.missionService?.getMission(this.activeMissionId)?.nodePrompts : undefined) ?? {};
	}

	private getActiveTaskStatuses(): Readonly<Record<string, IMissionTaskStatusRecord>> {
		return (this.activeMissionId ? this.missionService?.getMission(this.activeMissionId)?.taskStatuses : undefined) ?? {};
	}

	private getActiveWhiteboards(): Readonly<Record<string, IOrchestrationWhiteboard>> {
		return (this.activeMissionId ? this.missionService?.getMission(this.activeMissionId)?.whiteboards : undefined) ?? {};
	}

	private getActiveOrchestrationRuntime(): IOrchestrationRuntimeState | undefined {
		if (!this.activeMissionId) {
			return undefined;
		}
		return this.missionRuntimeService?.getOrchestrationState(this.activeMissionId)
			?? this.missionService?.getMission(this.activeMissionId)?.orchestrationRuntime;
	}

	private canSwitchAgentEngine(agent: IAdeAgent): boolean {
		return Boolean(this.projectsService && this.sessionsService && !agent.session);
	}

	private resolveStaffDisplay(staffId: string): { readonly label: string; readonly shortLabel: string; readonly tier: number } {
		if (staffId === ADE_SECRETARY_ID) {
			return { label: 'Secretary', shortLabel: 'Secretary', tier: 0 };
		}
		const agent = this.projectsService?.getAgent(staffId);
		const label = agent?.label?.trim() || staffId;
		const shortLabel = label.length > 14 ? `${label.slice(0, 12)}…` : label;
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const tier = agent
			? resolveEffectiveRankDefinition(org, agent.role, this.projectsService?.hasSubordinates(agent.id) ?? false).tier
			: 1;
		return { label, shortLabel, tier };
	}

	private syncHudLayoutClasses(): void {
		if (!this.bodyEl) {
			return;
		}
		this.bodyEl.classList.toggle('has-file-drawer-open', Boolean(this.fileDrawer?.isOpen()));
		this.bodyEl.classList.toggle('has-canvas-alert', Boolean(this.canvasAlertEl && !this.canvasAlertEl.hidden));
		this.bodyEl.classList.toggle('has-search-open', Boolean(this.searchBarEl && !this.searchBarEl.hidden));
	}

	toggleFileDrawer(forceOpen?: boolean, focusNodeId?: string): void {
		this.fileDrawer?.toggle(forceOpen, focusNodeId);
		this.syncHudLayoutClasses();
	}

	setHoveredNode(nodeId: string | undefined): void {
		if (!this.renderer || this.renderer.getHoveredNodeId() === nodeId) {
			return;
		}
		const compatNodes: readonly IMissionDagNode[] = this.viewMode === 'orchestration'
			? this.orchNodes.map(n => ({ id: n.id, label: n.label, kind: 'task' as const }))
			: this.nodes;
		this.renderer.applyHoverHighlight(nodeId, compatNodes, this.positions);
	}

	fitGraphToViewport(): void {
		const ids = this.getActiveNodeIds();
		if (!this.viewportEl || ids.length === 0) {
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
		for (const id of ids) {
			const pos = this.positions.get(id);
			if (!pos) {
				continue;
			}
			const size = this.getNodeDimensions(id);
			minX = Math.min(minX, pos.x - size.width / 2);
			maxX = Math.max(maxX, pos.x + size.width / 2);
			minY = Math.min(minY, pos.y - size.height / 2);
			maxY = Math.max(maxY, pos.y + size.height / 2);
		}
		if (!Number.isFinite(minX)) {
			return;
		}
		const padX = 72;
		const padTop = 80;
		const padBottom = 60;
		const availW = Math.max(120, rect.width - padX * 2);
		const availH = Math.max(120, rect.height - padTop - padBottom);
		const graphW = Math.max(1, maxX - minX);
		const graphH = Math.max(1, maxY - minY);
		this.zoom = Math.round(Math.min(1, Math.max(MIN_ZOOM, Math.min(availW / graphW, availH / graphH))) * 100) / 100;
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		this.panX = Math.round((padX + availW / 2) - centerX * this.zoom);
		this.panY = Math.round((padTop + availH / 2) - centerY * this.zoom);
		this.applyWorldTransformNow();
	}

	focusNode(
		nodeId: string,
		options?: { readonly inspectorTab?: MissionInspectorTab; readonly openAgentBeside?: boolean },
	): void {
		if (this.isPaneDisposed || !nodeId) {
			return;
		}
		if (this.fileDrawer?.isOpen()) {
			this.fileDrawer.toggle(false);
		}
		this.popovers?.close();
		if (!this.getActiveNodeIds().includes(nodeId)) {
			return;
		}
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		this.selectedNodeIds = new Set([nodeId]);
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.syncSelectionHud();
		this.centerViewportOnNode(nodeId);
		this.renderer?.pulseFocusNode(nodeId, 3000);

		if (options?.openAgentBeside && this.adeEditorService && this.viewMode === 'orchestration') {
			const linkedAgent = this.buildOrchestrationAgentMap().get(nodeId);
			if (linkedAgent) {
				void this.adeEditorService.openAgent(linkedAgent.id, { side: true });
			}
		}
	}

	// =========================================================================
	// Mission View: Task Details Popover & Status Authority
	// =========================================================================

	private openMissionTaskPopover(node: IMissionDagNode, anchorEl: HTMLElement): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		this.fileDrawer.setSelectedTaskNodeId(node.id);
		const statusRec = this.getActiveTaskStatuses()[node.id];
		this.popovers.openMissionTaskEditorPopover(missionId, node, statusRec, anchorEl, {
			onRenameTask: nextTitle => this.renameVisualNode(node.id, nextTitle),
			onChangeDescription: nextDesc => this.commitNodePromptEdit(missionId, node.id, nextDesc, 'popover'),
			onSetTaskStatus: nextStatus => void this.handleSetMissionTaskStatus(node.id, nextStatus),
			onChangeColor: nextColor => this.setNodeColorVisual(node.id, nextColor),
		});
	}

	private handleSetMissionTaskStatus(nodeId: string, nextStatus: MissionTaskStatus): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		if (this.missionRuntimeService) {
			const res = this.missionRuntimeService.setMissionTaskStatus(missionId, {
				nodeId,
				status: nextStatus,
				caller: { isHumanUser: true, callerLabel: 'Human' },
			});
			if (!res.ok && res.error) {
				this.reportFeedback(res.error, 'error');
				return;
			}
		} else if (this.missionService) {
			const rec = this.missionService.getMission(missionId);
			const orgConfig = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const parsedTaskDag = parseMissionMermaidDag(this.mermaidText);
			const trans = updateMissionTaskNodeStatus(
				rec?.taskStatuses ?? {},
				parsedTaskDag,
				orgConfig,
				{
					nodeId,
					status: nextStatus,
					caller: { isHumanUser: true, callerLabel: 'Human' },
				},
			);
			if (!trans.ok) {
				this.reportFeedback(trans.error ?? 'Failed to update task status.', 'error');
				return;
			}
			this.missionService.updateTaskStatuses(missionId, trans.taskStatuses);
		}
		this.syncGraphDom();
		this.fileDrawer.syncTaskDescriptionsPane(true);
	}

	// =========================================================================
	// Orchestration View: Whiteboards, Staff Creation, Token Baton & Dispatch
	// =========================================================================

	private openWhiteboardPopover(whiteboard: IOrchestrationWhiteboard, anchorEl: HTMLElement): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const liveWb = this.getActiveWhiteboards()[whiteboard.id] ?? whiteboard;
		const wbGraphNode = this.orchNodes.find(n => n.id === liveWb.id);
		this.popovers.openWhiteboardEditorPopover(liveWb, anchorEl, patch => {
			let savedVersion = (liveWb.version ?? 0) + 1;
			if (this.missionRuntimeService) {
				const res = this.missionRuntimeService.upsertOrchestrationWhiteboard(missionId, {
					id: liveWb.id,
					department: patch.department,
					title: patch.title,
					content: patch.content,
					caller: { isHumanUser: true },
				});
				if (!res.ok && res.error) {
					this.reportFeedback(res.error, 'error');
					return;
				}
				if (res.whiteboard) {
					savedVersion = res.whiteboard.version;
				}
				if (res.orchestrationText && res.orchestrationText !== this.orchestrationText) {
					this.orchestrationText = res.orchestrationText;
					this.fileDrawer?.setCodeValue(res.orchestrationText);
				}
			} else if (this.missionService) {
				const cur = this.getActiveWhiteboards();
				const up = upsertDepartmentWhiteboard(cur, {
					id: liveWb.id,
					department: patch.department,
					title: patch.title,
					content: patch.content,
					updatedBy: 'human',
					updatedByLabel: 'Human',
				});
				savedVersion = up.whiteboard.version;
				this.missionService.updateWhiteboards(missionId, up.whiteboards);
				const nextCode = upsertOrchestrationWhiteboardInCode(this.orchestrationText, {
					id: liveWb.id,
					department: patch.department,
					title: patch.title,
					content: patch.content,
					version: savedVersion,
				});
				if (nextCode !== this.orchestrationText) {
					this.orchestrationText = nextCode;
					this.fileDrawer?.setCodeValue(nextCode);
					this.missionService.updateOrchestrationText(missionId, nextCode);
				}
			}
			void savedVersion;
			this.syncGraphDom();
			this.reportFeedback(adeBi(localize('adeOrchWbSavedOk', "Saved whiteboard '{0}'.", patch.title), '已保存部门白板「{0}」。', patch.title), 'ok');
		}, {
			currentColor: wbGraphNode?.color,
			onChangeColor: nextColor => this.setNodeColorVisual(liveWb.id, nextColor),
		});
	}

	private openWhiteboardById(whiteboardId: string): void {
		const wb = this.getActiveWhiteboards()[whiteboardId];
		if (!wb) {
			return;
		}
		const anchor = this.worldEl.querySelector<HTMLElement>(`[data-whiteboard-id="${whiteboardId}"]`) ?? this.viewportEl;
		this.openWhiteboardPopover(wb, anchor);
	}

	private openOrchestrationTokenPopover(staffLabel: string, token: IOrchestrationToken, anchorEl: HTMLElement): void {
		const missionId = this.activeMissionId;
		const orch = this.getActiveOrchestrationRuntime();
		const delta = (missionId ? this.missionRuntimeService?.getOrchestrationTokenDelta(missionId, token.id) : undefined)
			?? (orch ? buildOrchestrationTokenDeltaView(orch, token, this.getActiveWhiteboards()) : undefined);
		this.popovers.openOrchestrationTokenPopover(staffLabel, token, anchorEl, {
			delta,
			onOpenWhiteboard: wbId => this.openWhiteboardById(wbId),
			onReadPointer: ptr => {
				if (missionId && this.missionRuntimeService) {
					const res = this.missionRuntimeService.readOrchestrationTokenPointers(missionId, {
						ptrs: [ptr],
						tokenId: token.id,
						caller: { isHumanUser: true },
					});
					const item = res.items[0];
					return item ? { title: item.title, kind: item.kind, content: item.content, error: item.error } : undefined;
				}
				const orch = this.getActiveOrchestrationRuntime();
				const blob = orch?.payloadStore?.[ptr];
				if (blob) {
					return { title: blob.title, kind: blob.kind, content: blob.content };
				}
				const wbId = ptr.startsWith('wb:') ? ptr.slice(3) : ptr;
				const wb = this.getActiveWhiteboards()[wbId];
				if (wb) {
					return { title: wb.title, kind: 'whiteboard', content: wb.content };
				}
				return { error: `Pointer "${ptr}" not found.` };
			},
		});
	}

	private addOrchestrationStaffVisual(payload: {
		readonly name: string;
		readonly rankId: string;
		readonly tier: number;
		readonly department?: string;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const rankDef = org.ranks.find(r => r.id === payload.rankId || r.tier === payload.tier);
		const added = addStaffNodeToOrchestration(this.orchestrationText, {
			name: payload.name,
			roleLabel: rankDef?.name,
			tier: payload.tier,
			rankId: payload.rankId,
			department: payload.department,
			direction: this.orchDirection,
		});
		if (!added.ok || !added.orchestrationText || !added.nodeId) {
			this.reportFeedback(added.error ?? adeBi(localize('adeOrchAddStaffFail', "Failed to add staff node."), '添加员工节点失败。'), 'error');
			return;
		}
		const targetPos = payload.worldPos ?? this.computeDefaultNewNodeWorldPos();
		this.commitCodeMutation(added.orchestrationText, `Add staff ${payload.name}`, {
			nodePosition: { nodeId: added.nodeId, pos: targetPos },
			successMessage: adeBi(
				localize('adeOrchAddStaffOk', "Added unique staff node '{0}' ({1}).", payload.name, added.nodeId),
				'已添加唯一员工节点「{0}」({1})。',
				payload.name,
				added.nodeId,
			),
		});
	}

	private addOrchestrationSubordinateVisual(
		parentNode: IOrchestrationGraphNode,
		payload: {
			readonly name: string;
			readonly rankId: string;
			readonly tier: number;
			readonly department?: string;
		},
	): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const plan = planDynamicSubordinateCreation(this.orchestrationText, org, {
			callerNodeId: parentNode.id,
			callerTier: parentNode.tier,
			name: payload.name,
			targetRankIdOrTier: payload.rankId || payload.tier,
			department: payload.department ?? parentNode.department,
			bidirectional: true,
		});
		if (!plan.ok || !plan.orchestrationText || !plan.newNodeId) {
			this.reportFeedback(plan.error ?? adeBi(localize('adeOrchAddSubFail', "Failed to create subordinate."), '动态创建下级员工失败。'), 'error');
			return;
		}
		const parentPos = this.positions.get(parentNode.id);
		const targetPos = parentPos
			? {
				x: Math.round(parentPos.x + (this.orchDirection === 'TD' ? 0 : 440)),
				y: Math.round(parentPos.y + (this.orchDirection === 'TD' ? 300 : 120)),
			}
			: this.computeDefaultNewNodeWorldPos();
		this.commitCodeMutation(plan.orchestrationText, `Create subordinate ${payload.name} under ${parentNode.id}`, {
			nodePosition: { nodeId: plan.newNodeId, pos: targetPos },
			successMessage: adeBi(
				localize('adeOrchAddSubOk', "Created subordinate '{0}' ({1}) with bidirectional link {2} ⇄ {1}.", payload.name, plan.newNodeId, parentNode.id),
				'已动态扩编下级「{0}」({1})，并自动建立双向连线 {2} ⇄ {1}。',
				payload.name,
				plan.newNodeId,
				parentNode.id,
			),
		});
	}

	private addOrchestrationWhiteboardVisual(payload: {
		readonly department: string;
		readonly title: string;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const added = addWhiteboardNodeToOrchestration(this.orchestrationText, {
			department: payload.department,
			title: payload.title,
			direction: this.orchDirection,
		});
		if (!added.ok || !added.orchestrationText || !added.whiteboardId) {
			this.reportFeedback(added.error ?? adeBi(localize('adeOrchAddWbFail', "Failed to add whiteboard."), '创建部门白板失败。'), 'error');
			return;
		}
		const wbId = added.whiteboardId;
		const targetPos = payload.worldPos ?? this.computeDefaultNewNodeWorldPos();
		this.commitCodeMutation(added.orchestrationText, `Add whiteboard ${payload.title}`, {
			nodePosition: { nodeId: wbId, pos: targetPos },
			afterApply: () => {
				if (this.missionRuntimeService) {
					this.missionRuntimeService.upsertOrchestrationWhiteboard(missionId, {
						id: wbId,
						department: payload.department,
						title: payload.title,
						content: '',
						caller: { isHumanUser: true },
					});
				} else if (this.missionService) {
					const up = upsertDepartmentWhiteboard(this.getActiveWhiteboards(), {
						id: wbId,
						department: payload.department,
						title: payload.title,
						content: '',
					});
					this.missionService.updateWhiteboards(missionId, up.whiteboards);
				}
			},
			successMessage: adeBi(
				localize('adeOrchAddWbOk', "Created department whiteboard '{0}' ({1}).", payload.title, wbId),
				'已创建部门共享白板「{0}」({1})。',
				payload.title,
				wbId,
			),
		});
	}

	private clearAbortConfirmTimer(): void {
		if (this.abortConfirmTimer !== undefined) {
			const win = this.rootEl ? getWindow(this.rootEl) : undefined;
			win?.clearTimeout(this.abortConfirmTimer);
			this.abortConfirmTimer = undefined;
		}
		this.abortConfirmUntil = 0;
	}

	private switchViewMode(targetMode: AdeEngineeringViewMode, side: boolean): void {
		const missionId = this.activeMissionId;
		if (!missionId || !this.adeEditorService?.openEngineering) {
			return;
		}
		if (!side && targetMode === this.viewMode) {
			return;
		}
		void this.adeEditorService.openEngineering(missionId, { viewMode: targetMode, side });
	}

	private async handleUpdateOrchestrationStaffConfig(
		missionId: string,
		nodeId: string,
		patch: {
			readonly engineId?: string;
			readonly model?: string;
			readonly thinking?: string;
			readonly resetSession?: boolean;
		},
	): Promise<void> {
		if (!this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.updateOrchestrationStaffConfig(missionId, nodeId, patch);
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchStaffCfgFail', "Failed to update staff configuration."), '更新员工配置失败。'), 'error');
			return;
		}
		const latest = this.missionService?.getMission(missionId);
		if (latest?.orchestrationText !== undefined && latest.orchestrationText !== this.orchestrationText) {
			this.orchestrationText = latest.orchestrationText;
			if (this.viewMode === 'orchestration') {
				this.fileDrawer?.setCodeValue(this.orchestrationText);
				this.parseAndRenderOrchestrationGraph(this.orchestrationText);
			}
		} else {
			this.syncGraphDom();
		}
		if (patch.resetSession) {
			this.reportFeedback(adeBi(
				localize('adeOrchStaffCfgResetOk', "Reset session for {0} and switched engine to {1}.", nodeId, patch.engineId ?? ''),
				'已重置员工 {0} 的会话并切换引擎至 {1}。',
				nodeId,
				patch.engineId ?? '',
			), 'ok');
		} else {
			this.reportFeedback(adeBi(
				localize('adeOrchStaffCfgOk', "Updated configuration for {0}.", nodeId),
				'已更新员工 {0} 的配置。',
				nodeId,
			), 'ok');
		}
	}

	private async handleToggleOrchestrationPause(): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const orch = this.getActiveOrchestrationRuntime();
		const isPaused = orch?.status === 'paused';
		const res = isPaused
			? await this.missionRuntimeService.resumeOrchestration(missionId)
			: await this.missionRuntimeService.pauseOrchestration(missionId, 'Paused from Engineering global console');
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchPauseFail', "Failed to change orchestration state."), '切换编排状态失败。'), 'error');
			return;
		}
		this.syncGraphDom();
		this.reportFeedback(
			isPaused
				? adeBi(localize('adeOrchResumedOk', "Resumed orchestration token dispatch."), '已恢复编排令牌流转。')
				: adeBi(localize('adeOrchPausedOk', "Paused orchestration token dispatch."), '已暂停编排令牌流转。'),
			'ok',
		);
	}

	private async handleAbortAllOrchestrationTokens(): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const now = Date.now();
		if (now > this.abortConfirmUntil) {
			this.clearAbortConfirmTimer();
			this.abortConfirmUntil = now + 4000;
			this.updateConsoleBar();
			if (this.rootEl) {
				this.abortConfirmTimer = getWindow(this.rootEl).setTimeout(() => {
					this.abortConfirmTimer = undefined;
					this.abortConfirmUntil = 0;
					this.updateConsoleBar();
				}, 4000);
			}
			return;
		}
		this.clearAbortConfirmTimer();
		const res = await this.missionRuntimeService.abortOrchestrationTokens(missionId, 'Emergency abort from Engineering global console');
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchAbortFail', "Failed to abort active tokens."), '终止活跃令牌失败。'), 'error');
			return;
		}
		this.syncGraphDom();
		const count = res.data?.abortedTokenIds.length ?? 0;
		this.reportFeedback(adeBi(
			localize('adeOrchAbortOk', "Aborted {0} active orchestration token(s).", count),
			'已强制终止 {0} 枚在途编排令牌。',
			count,
		), 'info');
	}

	private updateConsoleBar(): void {
		if (!this.consoleBarEl) {
			return;
		}
		const hasMission = Boolean(this.activeMissionId);
		this.consoleBarEl.hidden = !hasMission;
		if (!hasMission) {
			return;
		}

		const isOrch = this.viewMode === 'orchestration';
		this.viewOrchBtnEl.classList.toggle('is-active', isOrch);
		this.viewOrchBtnEl.setAttribute('aria-selected', String(isOrch));
		this.viewMissionBtnEl.classList.toggle('is-active', !isOrch);
		this.viewMissionBtnEl.setAttribute('aria-selected', String(!isOrch));

		const orch = this.getActiveOrchestrationRuntime();
		const runtimeState = this.getEffectiveRuntimeState();
		const isPaused = orch?.status === 'paused';

		let activeCount = 0;
		let blockedCount = 0;
		let waitingJoinCount = 0;
		if (orch) {
			for (const tok of Object.values(orch.tokens)) {
				if (tok.status === 'active') {
					activeCount++;
				} else if (tok.status === 'blocked') {
					blockedCount++;
				} else if (tok.status === 'waiting_join') {
					waitingJoinCount++;
				}
			}
		}
		const inFlight = activeCount + blockedCount + waitingJoinCount;

		if (isPaused) {
			this.consoleTokensEl.textContent = adeBi(
				localize('adeEngConsolePausedText', "PAUSED · {0} in-flight", inFlight),
				'已暂停 · {0} 在途',
				inFlight,
			);
		} else if (inFlight > 0) {
			const detailParts: string[] = [];
			if (activeCount > 0) { detailParts.push(`${activeCount} active`); }
			if (blockedCount > 0) { detailParts.push(`${blockedCount} blk`); }
			if (waitingJoinCount > 0) { detailParts.push(`${waitingJoinCount} join`); }
			this.consoleTokensEl.textContent = adeBi(
				localize('adeEngConsoleInFlightText', "{0} tokens ({1})", inFlight, detailParts.join(' · ')),
				'{0} 在途 ({1})',
				inFlight,
				detailParts.join(' · '),
			);
		} else {
			this.consoleTokensEl.textContent = adeBi(localize('adeEngConsoleIdleText', "0 in-flight"), '0 在途令牌');
		}
		this.consoleTokensEl.classList.toggle('is-paused', isPaused);
		this.consoleTokensEl.classList.toggle('is-active', !isPaused && inFlight > 0);

		let totalCostUsd = 0;
		let totalTokens = 0;
		let anyEstimated = false;
		if (runtimeState?.nodeTelemetry) {
			for (const t of Object.values(runtimeState.nodeTelemetry)) {
				totalCostUsd += t.costUsd ?? 0;
				totalTokens += t.totalTokens ?? 0;
				if (t.costEstimated) {
					anyEstimated = true;
				}
			}
		}
		if (totalCostUsd > 0 || totalTokens > 0) {
			const costText = totalCostUsd > 0 ? formatFinOpsUsd(totalCostUsd, { estimated: anyEstimated, compact: true }) : '$0';
			const tokText = totalTokens > 0 ? formatCompactTokenCount(totalTokens) : '';
			this.consoleSpendEl.textContent = tokText ? `${costText} · ${tokText}` : costText;
			this.consoleSpendEl.hidden = false;
		} else {
			this.consoleSpendEl.hidden = true;
		}

		const hasRuntime = Boolean(this.missionRuntimeService);
		this.consolePauseBtnEl.disabled = !hasRuntime;
		this.consolePauseBtnEl.classList.toggle('is-paused', isPaused);
		this.consolePauseBtnEl.textContent = isPaused
			? adeBi(localize('adeEngConsoleResumeBtn', "Resume"), '恢复流转')
			: adeBi(localize('adeEngConsolePauseBtn', "Pause"), '暂停流转');
		this.consolePauseBtnEl.title = isPaused
			? adeBi(localize('adeEngConsoleResumeTip', "Resume orchestration token dispatch"), '恢复整波令牌流转')
			: adeBi(localize('adeEngConsolePauseTip', "Pause orchestration token dispatch"), '一键暂停整波流转');

		const isConfirmingAbort = Date.now() <= this.abortConfirmUntil;
		this.consoleAbortBtnEl.disabled = !hasRuntime || (inFlight === 0 && !isPaused);
		this.consoleAbortBtnEl.classList.toggle('is-confirming', isConfirmingAbort);
		this.consoleAbortBtnEl.textContent = isConfirmingAbort
			? adeBi(localize('adeEngConsoleAbortConfirmBtn', "Confirm Abort?"), '确认终止全部?')
			: adeBi(localize('adeEngConsoleAbortBtn', "Abort All"), '终止全部');
		this.consoleAbortBtnEl.title = adeBi(localize('adeEngConsoleAbortTip', "Force-abort all active orchestration tokens (click twice to confirm)"), '强制终止全部在途令牌（点击两次确认）');

		this.consoleMinimapBtnEl.classList.toggle('is-active', Boolean(this.minimap?.isUserVisible()));
	}

	private centerViewportOnWorldPoint(worldX: number, worldY: number): void {
		if (!this.viewportEl) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		const vpW = rect.width > 40 ? rect.width : 1080;
		const vpH = rect.height > 40 ? rect.height : 720;
		this.panX = Math.round(vpW / 2 - worldX * this.zoom);
		this.panY = Math.round(vpH / 2 - worldY * this.zoom);
		this.applyWorldTransformNow();
	}

	private syncMinimap(): void {
		if (!this.minimap) {
			return;
		}
		const firstSelected = this.selectedNodeIds.size > 0 ? [...this.selectedNodeIds][0] : undefined;
		const runtimeState = this.getEffectiveRuntimeState();
		if (this.viewMode === 'orchestration') {
			const compatNodes: IMissionDagNode[] = this.orchNodes.map(n => ({
				id: n.id,
				label: n.label,
				kind: n.kind === 'whiteboard' ? 'gate' : 'task',
			}));
			const compatEdges: IMissionDagEdge[] = this.orchEdges.map(e => ({
				id: e.id,
				from: e.from,
				to: e.to,
				label: e.label,
			}));
			const sizeOverride = new Map<string, { readonly width: number; readonly height: number }>();
			const nodeColors: Record<string, string | undefined> = {};
			for (const n of this.orchNodes) {
				sizeOverride.set(n.id, getOrchestrationNodeSize(n));
				if (n.color) {
					nodeColors[n.id] = n.color;
				}
			}
			const orchRuntime = this.getActiveOrchestrationRuntime();
			this.minimap.syncGraph(compatNodes, compatEdges, this.positions, runtimeState, firstSelected, {
				nodeStates: orchRuntime?.nodeStates,
				nodeSizeOverride: sizeOverride,
				nodeColors,
			});
		} else {
			const taskStatuses = this.getActiveTaskStatuses();
			const mappedStates: Record<string, string> = {};
			const nodeColors: Record<string, string | undefined> = {};
			for (const n of this.nodes) {
				if (n.color) {
					nodeColors[n.id] = n.color;
				}
			}
			for (const [nid, rec] of Object.entries(taskStatuses)) {
				mappedStates[nid] = rec.status === 'in_progress'
					? 'active'
					: rec.status === 'completed'
						? 'completed'
						: rec.status === 'blocked'
							? 'blocked'
							: 'idle';
			}
			this.minimap.syncGraph(this.nodes, this.edges, this.positions, runtimeState, firstSelected, {
				nodeStates: mappedStates,
				nodeColors,
			});
		}
		this.syncMinimapViewport();
	}

	private syncMinimapViewport(): void {
		if (!this.minimap || !this.viewportEl) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			this.minimap.updateViewport(this.panX, this.panY, this.zoom, rect.width, rect.height);
		}
	}

	private handleDispatchRequirement(requirement: string, targetNodeId?: string): void {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			this.reportFeedback(adeBi(localize('adeOrchRuntimeUnavailable', "Orchestration runtime is unavailable."), '编排运行时不可用。'), 'error');
			return;
		}
		void this.missionRuntimeService.dispatchOrchestrationRequirement(missionId, {
			prompt: requirement,
			targetNodeId,
		}).then(res => {
			if (this.isPaneDisposed || this.activeMissionId !== missionId) {
				return;
			}
			if (!res.ok) {
				this.reportFeedback(res.error ?? adeBi(localize('adeOrchDispatchFail', "Failed to dispatch requirement."), '需求派发失败。'), 'error');
			} else {
				this.syncGraphDom();
				const tokId = res.data?.tokenId ?? '';
				const tgtId = res.data?.targetNodeId ?? '';
				this.reportFeedback(
					adeBi(
						localize('adeOrchDispatchOk', "Dispatched baton token {0} to {1}.", tokId, tgtId),
						'已派发接力令牌 {0} 至 {1}。',
						tokId,
						tgtId,
					),
					'ok',
				);
			}
		}, err => {
			if (!this.isPaneDisposed && this.activeMissionId === missionId) {
				this.reportFeedback(err instanceof Error ? err.message : String(err), 'error');
			}
		});
	}

	// =========================================================================
	// Prompt & Feedback Helpers
	// =========================================================================

	private commitNodePromptEdit(missionId: string, nodeId: string, nextVal: string, source: 'drawer' | 'popover'): void {
		this.activePromptEditSource = source;
		try {
			this.missionService?.updateNodePrompt(missionId, nodeId, nextVal);
		} finally {
			this.activePromptEditSource = undefined;
		}
		this.syncAllNodePromptViews(source);
	}

	private syncAllNodePromptViews(source?: 'drawer' | 'popover'): void {
		if (this.viewMode !== 'mission') {
			return;
		}
		const prompts = this.getActiveNodePrompts();
		this.renderer?.syncNodePromptPreviews(prompts);
		this.fileDrawer?.syncTaskDescriptionsPane(source === 'drawer');
		this.popovers?.syncOpenPromptPopover(prompts, source);
	}

	private clearCanvasAlertTimer(): void {
		if (this.canvasAlertTimer !== undefined) {
			const win = this.rootEl ? getWindow(this.rootEl) : undefined;
			win?.clearTimeout(this.canvasAlertTimer);
			this.canvasAlertTimer = undefined;
		}
	}

	private showCanvasAlert(message: string, kind: 'error' | 'ok' | 'info' = 'error', options?: { readonly offerOpenFile?: boolean }): void {
		if (this.isPaneDisposed || !this.canvasAlertEl) {
			return;
		}
		this.clearCanvasAlertTimer();
		this.canvasAlertEl.classList.remove('is-error', 'is-ok', 'is-info');
		this.canvasAlertEl.classList.add(`is-${kind}`);
		this.canvasAlertEl.dataset.alertKind = kind;
		this.canvasAlertIconEl.className = kind === 'ok'
			? 'codicon codicon-pass-filled ade-mission-canvas-alert-icon'
			: kind === 'info'
				? 'codicon codicon-info ade-mission-canvas-alert-icon'
				: 'codicon codicon-error ade-mission-canvas-alert-icon';
		this.canvasAlertTextEl.textContent = message;
		this.canvasAlertOpenFileBtn.hidden = !(options?.offerOpenFile && !this.fileDrawer?.isOpen());
		this.canvasAlertEl.hidden = false;
		this.syncHudLayoutClasses();
		if (kind !== 'error' && this.rootEl) {
			this.canvasAlertTimer = getWindow(this.rootEl).setTimeout(() => {
				this.canvasAlertTimer = undefined;
				this.hideCanvasAlert();
			}, 3600);
		}
	}

	private hideCanvasAlert(): void {
		this.clearCanvasAlertTimer();
		if (this.canvasAlertEl) {
			this.canvasAlertEl.hidden = true;
		}
		this.syncHudLayoutClasses();
	}

	private reportFeedback(message: string, kind: 'error' | 'ok' | 'info', options?: { readonly offerOpenFile?: boolean }): void {
		this.fileDrawer?.setStatus(message, kind === 'info' ? undefined : kind);
		this.showCanvasAlert(message, kind, options);
	}

	// =========================================================================
	// Code Draft, History (Undo/Redo) & Graph Mutations
	// =========================================================================

	private handleCodeDraftChange(nextText: string): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		if (this.viewMode === 'orchestration') {
			const parsed = parseOrchestrationGraph(nextText);
			if (parsed.error) {
				this.fileDrawer.setStatus(parsed.error, 'error');
				this.showCanvasAlert(parsed.error);
				return;
			}
			this.hideCanvasAlert();
			if (nextText !== this.orchestrationText) {
				this.pushHistory(this.captureHistorySnapshot(adeBi(localize('adeOrchHistoryEditCode', "Edit topology"), '编辑编排代码')), 1200);
			}
			this.orchestrationText = nextText;
			this.missionService?.updateOrchestrationText(missionId, nextText);
			this.parseAndRenderOrchestrationGraph(nextText);
		} else {
			const parsed = parseMissionMermaidDag(nextText);
			if (parsed.error) {
				this.fileDrawer.setStatus(parsed.error, 'error');
				this.showCanvasAlert(parsed.error);
				return;
			}
			this.hideCanvasAlert();
			if (nextText !== this.mermaidText) {
				this.pushHistory(this.captureHistorySnapshot(adeBi(localize('adeMissionHistoryEditMermaid', "Edit Mermaid"), '编辑 Mermaid')), 1200);
			}
			this.mermaidText = nextText;
			this.missionService?.updateMermaid(missionId, nextText);
			this.parseAndRenderMissionGraph(nextText);
		}
	}

	private captureHistorySnapshot(label: string): IEngineeringHistoryEntry {
		const rec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const positions: Record<string, IMissionNodePosition> = {};
		for (const [nid, pos] of this.positions.entries()) {
			positions[nid] = { x: pos.x, y: pos.y };
		}
		const nodePrompts: Record<string, string> = {};
		if (this.viewMode === 'mission' && rec?.nodePrompts) {
			for (const [nid, val] of Object.entries(rec.nodePrompts)) {
				nodePrompts[nid] = val;
			}
		}
		return {
			viewMode: this.viewMode,
			codeText: this.viewMode === 'orchestration' ? this.orchestrationText : this.mermaidText,
			positions,
			nodePrompts,
			label,
		};
	}

	private pushHistory(entry: IEngineeringHistoryEntry, coalesceMs = 0): void {
		const now = Date.now();
		if (coalesceMs > 0 && this.undoStack.length > 0 && (now - this.lastCoalescedHistoryAt) < coalesceMs) {
			this.lastCoalescedHistoryAt = now;
			this.redoStack = [];
			return;
		}
		this.lastCoalescedHistoryAt = coalesceMs > 0 ? now : 0;
		this.undoStack.push(entry);
		if (this.undoStack.length > MAX_UNDO_HISTORY) {
			this.undoStack.shift();
		}
		this.redoStack = [];
	}

	private applyHistorySnapshot(snapshot: IEngineeringHistoryEntry, dir: 'undo' | 'redo'): void {
		const missionId = this.activeMissionId;
		if (!missionId || snapshot.viewMode !== this.viewMode) {
			return;
		}
		this.positions.clear();
		for (const [nid, pos] of Object.entries(snapshot.positions)) {
			this.positions.set(nid, { x: pos.x, y: pos.y });
		}
		if (this.viewMode === 'orchestration') {
			this.missionService?.clearOrchestrationPositions(missionId);
			if (Object.keys(snapshot.positions).length > 0) {
				this.missionService?.updateOrchestrationPositions(missionId, snapshot.positions);
			}
			this.orchestrationText = snapshot.codeText;
			this.fileDrawer.setCodeValue(snapshot.codeText);
			this.missionService?.updateOrchestrationText(missionId, snapshot.codeText);
			this.parseAndRenderOrchestrationGraph(snapshot.codeText, false);
		} else {
			this.missionService?.clearNodePositions(missionId);
			if (Object.keys(snapshot.positions).length > 0) {
				this.missionService?.updateNodePositions(missionId, snapshot.positions);
			}
			this.mermaidText = snapshot.codeText;
			this.fileDrawer.setCodeValue(snapshot.codeText);
			this.missionService?.updateMermaid(missionId, snapshot.codeText);
			if (this.missionService) {
				const existingRec = this.missionService.getMission(missionId);
				const promptPatch: Record<string, string> = {};
				if (existingRec?.nodePrompts) {
					for (const oldKey of Object.keys(existingRec.nodePrompts)) {
						if (!Object.prototype.hasOwnProperty.call(snapshot.nodePrompts, oldKey)) {
							promptPatch[oldKey] = '';
						}
					}
				}
				for (const [k, v] of Object.entries(snapshot.nodePrompts)) {
					promptPatch[k] = v;
				}
				if (Object.keys(promptPatch).length > 0) {
					this.missionService.updateNodePrompts(missionId, promptPatch);
				}
			}
			this.parseAndRenderMissionGraph(snapshot.codeText, false);
			this.syncAllNodePromptViews();
		}
		this.reportFeedback(
			dir === 'undo'
				? adeBi(localize('adeMissionUndoFeedback', "Undid: {0}", snapshot.label), '已撤销：{0}', snapshot.label)
				: adeBi(localize('adeMissionRedoFeedback', "Redid: {0}", snapshot.label), '已重做：{0}', snapshot.label),
			'info',
		);
	}

	private undoCanvasMutation(): void {
		if (!this.activeMissionId || this.undoStack.length === 0) {
			return;
		}
		const prev = this.undoStack.pop()!;
		this.redoStack.push(this.captureHistorySnapshot(prev.label));
		this.applyHistorySnapshot(prev, 'undo');
	}

	private redoCanvasMutation(): void {
		if (!this.activeMissionId || this.redoStack.length === 0) {
			return;
		}
		const next = this.redoStack.pop()!;
		this.undoStack.push(this.captureHistorySnapshot(next.label));
		this.applyHistorySnapshot(next, 'redo');
	}

	private commitCodeMutation(
		nextCode: string,
		reason: string,
		options?: {
			readonly nodePosition?: { readonly nodeId: string; readonly pos: IMissionNodePosition };
			readonly clearPositions?: boolean;
			readonly successMessage?: string;
			readonly afterApply?: () => void;
		},
	): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		this.pushHistory(this.captureHistorySnapshot(reason));
		if (this.viewMode === 'orchestration') {
			if (options?.clearPositions) {
				this.missionService?.clearOrchestrationPositions(missionId);
				this.positions.clear();
			}
			if (options?.nodePosition) {
				this.positions.set(options.nodePosition.nodeId, options.nodePosition.pos);
				this.missionService?.updateOrchestrationPositions(missionId, { [options.nodePosition.nodeId]: options.nodePosition.pos });
			}
			this.orchestrationText = nextCode;
			this.fileDrawer.setCodeValue(nextCode);
			this.missionService?.updateOrchestrationText(missionId, nextCode);
			options?.afterApply?.();
			this.parseAndRenderOrchestrationGraph(nextCode, Boolean(options?.clearPositions));
		} else {
			if (options?.clearPositions) {
				this.missionService?.clearNodePositions(missionId);
				this.positions.clear();
			}
			if (options?.nodePosition) {
				this.positions.set(options.nodePosition.nodeId, options.nodePosition.pos);
				this.missionService?.updateNodePositions(missionId, { [options.nodePosition.nodeId]: options.nodePosition.pos });
			}
			this.mermaidText = nextCode;
			this.fileDrawer.setCodeValue(nextCode);
			this.missionService?.updateMermaid(missionId, nextCode);
			options?.afterApply?.();
			this.parseAndRenderMissionGraph(nextCode, Boolean(options?.clearPositions));
		}
		if (options?.successMessage) {
			this.reportFeedback(options.successMessage, 'ok');
		}
	}

	private addMissionTaskVisual(worldPos?: IMissionNodePosition): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const targetPos = worldPos ?? this.computeDefaultNewNodeWorldPos();
		const added = addNodeToMermaid(this.mermaidText, {
			kind: 'task',
			direction: this.direction,
		});
		this.commitCodeMutation(added.mermaidText, `Add task ${added.nodeId}`, {
			nodePosition: { nodeId: added.nodeId, pos: targetPos },
			afterApply: () => {
				if (this.missionService) {
					const existingRec = this.missionService.getMission(missionId);
					if (existingRec?.nodePrompts?.[added.nodeId]) {
						this.missionService.updateNodePrompt(missionId, added.nodeId, '');
					}
					this.syncAllNodePromptViews();
				}
			},
			successMessage: adeBi(
				localize('adeMissionVisualAddTaskOk', "Added task node {0} (click to edit description, drag port to connect).", added.nodeId),
				'已添加任务节点 {0}（点击编辑描述，拖拽端口连线）。',
				added.nodeId,
			),
		});
	}

	private renameVisualNode(nodeId: string, nextLabel: string): void {
		if (this.viewMode === 'orchestration') {
			const nextCode = renameOrchestrationNode(this.orchestrationText, nodeId, nextLabel);
			if (nextCode === this.orchestrationText) {
				return;
			}
			this.commitCodeMutation(nextCode, `Rename ${nodeId}`, {
				successMessage: adeBi(localize('adeMissionVisualRenameOk', "Renamed {0} to '{1}'.", nodeId, nextLabel), '已将节点 {0} 重命名为「{1}」。', nodeId, nextLabel),
			});
			return;
		}
		const nextMermaid = renameNodeInMermaid(this.mermaidText, nodeId, nextLabel);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitCodeMutation(nextMermaid, `Rename ${nodeId}`, {
			successMessage: adeBi(localize('adeMissionVisualRenameOk', "Renamed {0} to '{1}'.", nodeId, nextLabel), '已将节点 {0} 重命名为「{1}」。', nodeId, nextLabel),
		});
	}

	private deleteVisualNodes(nodeIds: readonly string[]): void {
		const missionId = this.activeMissionId;
		const uniqueIds = [...new Set(nodeIds.map(id => id.trim()).filter(Boolean))];
		if (uniqueIds.length === 0) {
			return;
		}
		if (this.viewMode === 'orchestration') {
			const staffIds = uniqueIds.filter(id => this.orchNodes.some(n => n.id === id && n.kind === 'staff'));
			const nonStaffIds = uniqueIds.filter(id => !staffIds.includes(id));

			if (missionId && this.missionRuntimeService && staffIds.length > 0) {
				void (async () => {
					let removedCount = 0;
					let reclaimedTotal = 0;
					let recoveryTotal = 0;
					const errors: string[] = [];
					for (const staffId of staffIds) {
						const res = await this.missionRuntimeService!.removeOrchestrationSubordinate(missionId, {
							targetNodeId: staffId,
							isHumanUser: true,
							force: true,
							reason: 'Removed from Engineering canvas',
						});
						if (res.ok) {
							removedCount++;
							reclaimedTotal += res.reclaimedTokenIds?.length ?? 0;
							recoveryTotal += res.recoveryTokenIds?.length ?? 0;
						} else if (res.error) {
							errors.push(`${staffId}: ${res.error}`);
						}
					}
					if (this.isPaneDisposed || this.activeMissionId !== missionId) {
						return;
					}
					const latestText = this.missionService?.getMission(missionId)?.orchestrationText ?? this.orchestrationText;
					let nextCode = latestText;
					for (const id of nonStaffIds) {
						nextCode = removeOrchestrationNode(nextCode, id);
					}
					if (nextCode !== latestText) {
						this.missionService?.updateOrchestrationText(missionId, nextCode);
						removedCount += nonStaffIds.length;
					}
					this.orchestrationText = nextCode;
					this.fileDrawer?.setCodeValue(nextCode);
					for (const nid of uniqueIds) {
						this.selectedNodeIds.delete(nid);
					}
					this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
					this.syncSelectionHud();
					this.parseAndRenderOrchestrationGraph(nextCode, false);
					if (errors.length > 0) {
						this.reportFeedback(errors.join(' | '), 'error');
					} else if (removedCount > 0) {
						const reclaimNote = reclaimedTotal > 0
							? adeBi(
								localize('adeOrchDeleteReclaimNote', " (reclaimed {0} token(s), bounced {1} recovery baton(s))", reclaimedTotal, recoveryTotal),
								'（已回收 {0} 枚在途令牌，回弹 {1} 枚恢复令牌给上级）',
								reclaimedTotal,
								recoveryTotal,
							)
							: '';
						this.reportFeedback(adeBi(
							localize('adeOrchDeleteOkWithReclaim', "Removed {0} node(s){1}.", removedCount, reclaimNote),
							'已删除 {0} 个节点{1}。',
							removedCount,
							reclaimNote,
						), 'ok');
					}
				})();
				return;
			}

			let nextCode = this.orchestrationText;
			for (const id of uniqueIds) {
				nextCode = removeOrchestrationNode(nextCode, id);
			}
			if (nextCode === this.orchestrationText) {
				return;
			}
			this.commitCodeMutation(nextCode, `Delete ${uniqueIds.join(', ')}`, {
				afterApply: () => {
					for (const nid of uniqueIds) {
						this.selectedNodeIds.delete(nid);
					}
					this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
					this.syncSelectionHud();
				},
				successMessage: adeBi(localize('adeOrchDeleteOk', "Removed {0} node(s).", uniqueIds.length), '已删除 {0} 个节点。', uniqueIds.length),
			});
			return;
		}

		const nextMermaid = uniqueIds.length === 1
			? removeNodeFromMermaid(this.mermaidText, uniqueIds[0])
			: removeNodesFromMermaid(this.mermaidText, uniqueIds);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitCodeMutation(nextMermaid, `Delete ${uniqueIds.join(', ')}`, {
			afterApply: () => {
				if (missionId && this.missionService) {
					for (const nid of uniqueIds) {
						this.missionService.updateNodePrompt(missionId, nid, '');
					}
					this.syncAllNodePromptViews();
				}
				for (const nid of uniqueIds) {
					this.selectedNodeIds.delete(nid);
				}
				this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
				this.syncSelectionHud();
			},
			successMessage: adeBi(localize('adeMissionDeleteTasksOk', "Removed {0} task node(s).", uniqueIds.length), '已删除 {0} 个任务节点。', uniqueIds.length),
		});
	}

	private renameVisualEdgeLabel(fromId: string, toId: string, nextLabel: string): void {
		if (this.viewMode === 'orchestration') {
			const nextCode = renameOrchestrationEdgeLabel(this.orchestrationText, fromId, toId, nextLabel);
			if (nextCode === this.orchestrationText) {
				return;
			}
			this.commitCodeMutation(nextCode, `Edit edge label ${fromId}->${toId}`);
			return;
		}
		const nextMermaid = renameEdgeLabelInMermaid(this.mermaidText, fromId, toId, nextLabel);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitCodeMutation(nextMermaid, `Edit edge label ${fromId}->${toId}`);
	}

	private connectVisualEdge(fromId: string, toId: string, options?: { readonly fail?: boolean; readonly bidirectional?: boolean }): void {
		if (this.viewMode === 'orchestration') {
			const res = connectOrchestrationEdge(this.orchestrationText, fromId, toId, {
				bidirectional: options?.bidirectional,
			});
			if (!res.ok || !res.orchestrationText) {
				this.reportFeedback(res.error ?? adeBi(localize('adeMissionVisualConnectFail', "Cannot create edge."), '无法建立连线。'), 'error');
				return;
			}
			const fromStaff = this.orchNodes.find(n => n.id === fromId && n.kind === 'staff');
			const toStaff = this.orchNodes.find(n => n.id === toId && n.kind === 'staff');
			const hasReverse = this.orchEdges.some(e => e.from === toId && e.to === fromId);
			const isDownwardOneWay = !options?.bidirectional && !hasReverse
				&& fromStaff?.tier !== undefined && toStaff?.tier !== undefined && fromStaff.tier < toStaff.tier;
			this.commitCodeMutation(res.orchestrationText, `Connect ${fromId} ${options?.bidirectional ? '<-->' : '-->'} ${toId}`, {
				successMessage: options?.bidirectional
					? adeBi(localize('adeOrchConnectBidirOk', "Connected {0} <--> {1}.", fromId, toId), '已建立双向连线 {0} ⇄ {1}。', fromId, toId)
					: isDownwardOneWay
						? adeBi(localize('adeOrchConnectOneWayTip', "Connected {0} → {1} (Tip: right-click edge → Make Bidirectional <--> if subordinate must return tokens).", fromId, toId), '已建立单向连线 {0} → {1}（提示：若下级需回传令牌，请右键连线切换为双向 <-->）。', fromId, toId)
						: adeBi(localize('adeMissionVisualConnectOk', "Connected {0} → {1}.", fromId, toId), '已建立连线 {0} → {1}。', fromId, toId),
			});
			return;
		}
		const res = addEdgeToMermaid(this.mermaidText, fromId, toId);
		if (!res.ok || !res.mermaidText) {
			this.reportFeedback(res.error ?? adeBi(localize('adeMissionVisualConnectFail', "Cannot create edge."), '无法建立连线。'), 'error');
			return;
		}
		this.commitCodeMutation(res.mermaidText, `Connect ${fromId} -> ${toId}`, {
			successMessage: adeBi(localize('adeMissionVisualConnectOk', "Connected {0} → {1}.", fromId, toId), '已建立任务依赖 {0} → {1}。', fromId, toId),
		});
	}

	private deleteVisualEdge(fromId: string, toId: string): void {
		if (this.viewMode === 'orchestration') {
			const nextCode = removeOrchestrationEdge(this.orchestrationText, fromId, toId);
			if (nextCode === this.orchestrationText) {
				return;
			}
			this.commitCodeMutation(nextCode, `Delete edge ${fromId} -> ${toId}`, {
				successMessage: adeBi(localize('adeMissionVisualDeleteEdgeOk', "Removed edge {0} → {1}.", fromId, toId), '已删除连线 {0} → {1}。', fromId, toId),
			});
			return;
		}
		const nextMermaid = removeEdgeFromMermaid(this.mermaidText, fromId, toId);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitCodeMutation(nextMermaid, `Delete edge ${fromId} -> ${toId}`, {
			successMessage: adeBi(localize('adeMissionVisualDeleteEdgeOk', "Removed edge {0} → {1}.", fromId, toId), '已删除连线 {0} → {1}。', fromId, toId),
		});
	}

	private toggleOrchestrationEdgeBidirectional(fromId: string, toId: string): void {
		const hasReverse = this.orchEdges.some(e => e.from === toId && e.to === fromId);
		if (hasReverse) {
			const nextCode = removeOrchestrationEdge(this.orchestrationText, toId, fromId);
			if (nextCode !== this.orchestrationText) {
				this.commitCodeMutation(nextCode, `Unidirectional ${fromId} -> ${toId}`, {
					successMessage: adeBi(localize('adeOrchEdgeUnidirOk', "Switched {0} → {1} to one-way.", fromId, toId), '已将连线 {0} → {1} 切换为单向。', fromId, toId),
				});
			}
		} else {
			const res = connectOrchestrationEdge(this.orchestrationText, toId, fromId);
			if (res.ok && res.orchestrationText) {
				this.commitCodeMutation(res.orchestrationText, `Bidirectional ${fromId} <--> ${toId}`, {
					successMessage: adeBi(localize('adeOrchEdgeBidirOk', "Switched {0} ⇄ {1} to bidirectional.", fromId, toId), '已将连线 {0} ⇄ {1} 切换为双向。', fromId, toId),
				});
			}
		}
	}

	private deleteSelectedItems(): void {
		if (!this.activeMissionId) {
			return;
		}
		if (this.selectedEdgeKey) {
			const [from, to] = this.selectedEdgeKey.split('->');
			this.selectEdge(undefined);
			if (from && to) {
				this.deleteVisualEdge(from, to);
			}
			return;
		}
		if (this.selectedNodeIds.size > 0) {
			this.deleteVisualNodes([...this.selectedNodeIds]);
		}
	}

	private resetToAutoLayout(): void {
		const missionId = this.activeMissionId;
		if (!missionId || this.getActiveNodeCount() === 0) {
			return;
		}
		this.pushHistory(this.captureHistorySnapshot(adeBi(localize('adeMissionHistoryAutoLayout', "Auto layout"), '自动排版')));
		this.positions.clear();
		if (this.viewMode === 'orchestration') {
			this.missionService?.clearOrchestrationPositions(missionId);
			this.parseAndRenderOrchestrationGraph(this.orchestrationText, true);
		} else {
			this.missionService?.clearNodePositions(missionId);
			this.parseAndRenderMissionGraph(this.mermaidText, true);
		}
	}

	// =========================================================================
	// Context Menus (Node, Edge & Blank Canvas)
	// =========================================================================

	private openNodeContextMenu(node: IMissionDagNode, clientX: number, clientY: number): void {
		if (!this.activeMissionId) {
			return;
		}
		if (this.viewMode === 'mission') {
			const st = this.getActiveTaskStatuses()[node.id]?.status ?? 'pending';
			const isDone = st === 'completed';
			this.popovers.openCanvasContextMenu(clientX, clientY, [
				{
					id: 'edit-task',
					label: adeBi(localize('adeMissionCtxEditTask', "Edit Task Details"), '编辑任务详情'),
					icon: 'note',
					run: () => {
						const el = this.worldEl.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`) ?? this.viewportEl;
						this.openMissionTaskPopover(node, el);
					},
				},
				{
					id: 'rename-node',
					label: adeBi(localize('adeMissionCtxRenameNode', "Rename"), '重命名'),
					icon: 'edit',
					run: () => this.renderer.startInlineNodeRename(node.id),
				},
				{
					id: 'toggle-complete',
					label: isDone
						? adeBi(localize('adeMissionCtxReopenTask', "Reopen Task"), '重置为待完成')
						: adeBi(localize('adeMissionCtxCompleteTask', "Mark Completed ✓"), '标注为已完成 ✓'),
					icon: isDone ? 'discard' : 'check',
					run: () => void this.handleSetMissionTaskStatus(node.id, isDone ? 'pending' : 'completed'),
				},
				{
					id: 'delete-node',
					label: adeBi(localize('adeMissionCtxDeleteNode', "Delete {0}", node.id), '删除 {0}', node.id),
					icon: 'trash',
					danger: true,
					separatorBefore: true,
					run: () => this.deleteVisualNodes([node.id]),
				},
			], {
				colorPicker: {
					currentColor: node.color,
					onSelectColor: nextColor => this.setNodeColorVisual(node.id, nextColor),
				},
			});
			return;
		}

		const oNode = this.orchNodes.find(n => n.id === node.id);
		if (oNode?.kind === 'whiteboard') {
			const wb = this.getActiveWhiteboards()[oNode.id] ?? {
				id: oNode.id,
				title: oNode.label,
				department: oNode.department || 'General',
				content: '',
				version: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			this.popovers.openCanvasContextMenu(clientX, clientY, [
				{
					id: 'edit-whiteboard',
					label: adeBi(localize('adeOrchCtxEditWb', "Edit Whiteboard"), '编辑共享白板'),
					icon: 'notebook',
					run: () => {
						const el = this.worldEl.querySelector<HTMLElement>(`[data-node-id="${oNode.id}"]`) ?? this.viewportEl;
						this.openWhiteboardPopover(wb, el);
					},
				},
				{
					id: 'rename-node',
					label: adeBi(localize('adeMissionCtxRenameNode', "Rename"), '重命名'),
					icon: 'edit',
					run: () => this.renderer.startInlineNodeRename(node.id),
				},
				{
					id: 'move-to-group',
					label: adeBi(localize('adeOrchCtxMoveToGroup', "Move to Group…"), '移动至分组…'),
					icon: 'folder',
					run: () => this.popovers.openMoveToGroupPopover(clientX, clientY, oNode.label, oNode.department, this.orchDepartments, targetGrp => {
						this.moveOrchestrationNodeToGroupVisual(oNode.id, targetGrp);
					}),
				},
				{
					id: 'delete-node',
					label: adeBi(localize('adeMissionCtxDeleteNode', "Delete {0}", node.id), '删除 {0}', node.id),
					icon: 'trash',
					danger: true,
					separatorBefore: true,
					run: () => this.deleteVisualNodes([node.id]),
				},
			], {
				colorPicker: {
					currentColor: oNode.color,
					onSelectColor: nextColor => this.setNodeColorVisual(oNode.id, nextColor),
				},
			});
			return;
		}

		const linkedAgent = this.buildOrchestrationAgentMap().get(node.id);
		const items: {
			readonly id: string;
			readonly label: string;
			readonly icon?: string;
			readonly danger?: boolean;
			readonly separatorBefore?: boolean;
			readonly run: () => void;
		}[] = [];
		if (linkedAgent && this.adeEditorService) {
			items.push({
				id: 'open-agent-chat',
				label: adeBi(localize('adeOrchCtxOpenChat', "Open Employee Chat"), '打开员工会话'),
				icon: 'comment-discussion',
				run: () => void this.adeEditorService?.openAgent(linkedAgent.id),
			});
		}
		if (oNode && linkedAgent?.session && this.activeMissionId) {
			const curEngineId = linkedAgent.session.engineId ?? linkedAgent.preferredEngineId ?? oNode.engineId ?? 'aexus-claude';
			items.push({
				id: 'reset-session-switch-engine',
				label: adeBi(localize('adeOrchCtxResetSwitchEngine', "Reset Session & Switch Engine…"), '重置会话并切换引擎…'),
				icon: 'refresh',
				run: () => {
					if (!this.activeMissionId) {
						return;
					}
					const anchor = this.worldEl.querySelector<HTMLElement>(`[data-node-id="${oNode.id}"] .ade-mission-engine-pill`)
						?? this.worldEl.querySelector<HTMLElement>(`[data-node-id="${oNode.id}"]`)
						?? this.viewportEl;
					void this.popovers.openEnginePopover(this.activeMissionId, oNode.id, linkedAgent, curEngineId, anchor, {
						staffLabel: oNode.label,
						hostAlias: oNode.hostAlias,
					});
				},
			});
		}
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const maxTier = org.ranks.reduce((m, r) => Math.max(m, r.tier), 1);
		const parentTier = oNode?.tier ?? 1;
		const parentRankDef = org.ranks.find(r => r.tier === parentTier);
		if (oNode && parentTier < maxTier && (!parentRankDef || parentRankDef.canHaveSubordinates)) {
			items.push({
				id: 'create-subordinate',
				label: adeBi(localize('adeOrchCtxCreateSub', "Create Subordinate…"), '动态创建下级员工…'),
				icon: 'person-add',
				run: () => this.popovers.openAddStaffPopover(clientX, clientY, payload => {
					this.addOrchestrationSubordinateVisual(oNode, payload);
				}, {
					title: adeBi(localize('adeOrchSubTitle', "Create Subordinate under {0}", oNode.label), '在「{0}」下动态扩编下级', oNode.label),
					subtitle: adeBi(localize('adeOrchSubHint', "Auto-wires bidirectional <--> link so tokens can return."), '自动建立双向 <--> 通道，确保下级完成后可回传令牌'),
					submitLabel: adeBi(localize('adeOrchSubSubmit', "Create & Link <-->"), '创建并双向连线'),
					minTier: parentTier + 1,
					defaultDepartment: oNode.department,
				}),
			});
		}
		items.push(
			{
				id: 'dispatch-requirement',
				label: adeBi(localize('adeOrchCtxDispatch', "Dispatch Requirement…"), '下达任务需求…'),
				icon: 'send',
				run: () => this.popovers.openDispatchRequirementPopover(clientX, clientY, node.label, req => {
					this.handleDispatchRequirement(req, node.id);
				}),
			},
			{
				id: 'rename-node',
				label: adeBi(localize('adeMissionCtxRenameNode', "Rename"), '重命名'),
				icon: 'edit',
				run: () => this.renderer.startInlineNodeRename(node.id),
			},
			...(oNode ? [{
				id: 'move-to-group',
				label: adeBi(localize('adeOrchCtxMoveToGroup', "Move to Group…"), '移动至分组…'),
				icon: 'folder',
				run: () => this.popovers.openMoveToGroupPopover(clientX, clientY, oNode.label, oNode.department, this.orchDepartments, targetGrp => {
					this.moveOrchestrationNodeToGroupVisual(oNode.id, targetGrp);
				}),
			}] : []),
			{
				id: 'delete-node',
				label: adeBi(localize('adeMissionCtxDeleteNode', "Delete {0}", node.id), '删除 {0}', node.id),
				icon: 'trash',
				danger: true,
				separatorBefore: true,
				run: () => this.deleteVisualNodes([node.id]),
			},
		);
		this.popovers.openCanvasContextMenu(clientX, clientY, items, {
			colorPicker: {
				currentColor: oNode?.color,
				onSelectColor: nextColor => this.setNodeColorVisual(node.id, nextColor),
			},
		});
	}

	private setNodeColorVisual(nodeId: string, color: string | null): void {
		if (!this.activeMissionId) {
			return;
		}
		if (this.viewMode === 'mission') {
			const nextMermaid = upsertTaskMetadataInMermaid(this.mermaidText, nodeId, { color });
			if (nextMermaid !== this.mermaidText) {
				this.commitCodeMutation(nextMermaid, `Set node color ${nodeId}`, {
					successMessage: color
						? adeBi(localize('adeNodeColorUpdatedOk', "Updated color for {0}.", nodeId), '已更新 {0} 的节点颜色。', nodeId)
						: adeBi(localize('adeNodeColorResetOk', "Reset color for {0} to default.", nodeId), '已恢复 {0} 为默认配色。', nodeId),
				});
			}
			return;
		}
		const res = upsertOrchestrationNodeColorInCode(this.orchestrationText, nodeId, color);
		if (!res.ok || !res.orchestrationText) {
			this.reportFeedback(res.error ?? adeBi(localize('adeNodeColorFail', "Failed to update node color."), '更新节点颜色失败。'), 'error');
			return;
		}
		if (res.orchestrationText !== this.orchestrationText) {
			this.commitCodeMutation(res.orchestrationText, `Set node color ${nodeId}`, {
				successMessage: color
					? adeBi(localize('adeNodeColorUpdatedOk', "Updated color for {0}.", nodeId), '已更新 {0} 的节点颜色。', nodeId)
					: adeBi(localize('adeNodeColorResetOk', "Reset color for {0} to default.", nodeId), '已恢复 {0} 为默认配色。', nodeId),
			});
		}
	}

	private addOrchestrationGroupVisual(name: string, worldPos?: IMissionNodePosition): void {
		const res = addOrchestrationGroup(this.orchestrationText, {
			name,
			direction: this.orchDirection,
		});
		if (!res.ok || !res.orchestrationText || !res.groupId) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchAddGroupFail', "Failed to create group."), '创建分组失败。'), 'error');
			return;
		}
		this.commitCodeMutation(res.orchestrationText, `Add group ${name}`, {
			...(worldPos ? { nodePosition: { nodeId: res.groupId, pos: worldPos } } : {}),
			successMessage: adeBi(localize('adeOrchAddGroupOk', "Created group '{0}' ({1}).", res.groupName ?? name, res.groupId), '已创建部门分组「{0}」({1})。', res.groupName ?? name, res.groupId),
		});
	}

	private renameOrchestrationGroupVisual(groupId: string, nextName: string): void {
		const res = renameOrchestrationGroup(this.orchestrationText, groupId, nextName);
		if (!res.ok || !res.orchestrationText) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchRenameGroupFail', "Failed to rename group."), '重命名分组失败。'), 'error');
			return;
		}
		this.commitCodeMutation(res.orchestrationText, `Rename group ${groupId}`, {
			successMessage: adeBi(localize('adeOrchRenameGroupOk', "Renamed group to '{0}'.", res.newName ?? nextName), '已将分组重命名为「{0}」。', res.newName ?? nextName),
		});
	}

	private moveOrchestrationNodeToGroupVisual(nodeId: string, targetGroupIdOrName: string | undefined): void {
		const res = moveOrchestrationNodeToGroup(this.orchestrationText, nodeId, targetGroupIdOrName);
		if (!res.ok || !res.orchestrationText) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchMoveGroupFail', "Failed to move node to group."), '移动节点至分组失败。'), 'error');
			return;
		}
		this.commitCodeMutation(res.orchestrationText, `Move ${nodeId} to ${res.groupName ?? 'top-level'}`, {
			successMessage: res.groupName
				? adeBi(localize('adeOrchMoveGroupOk', "Moved {0} into group '{1}'.", nodeId, res.groupName), '已将节点 {0} 移入分组「{1}」。', nodeId, res.groupName)
				: adeBi(localize('adeOrchUngroupNodeOk', "Removed {0} from its group.", nodeId), '已将节点 {0} 移出分组。', nodeId),
		});
	}

	private removeOrchestrationGroupVisual(groupId: string, deleteMembers: boolean): void {
		const res = removeOrchestrationGroup(this.orchestrationText, groupId, { deleteMembers });
		if (!res.ok || !res.orchestrationText) {
			this.reportFeedback(res.error ?? adeBi(localize('adeOrchRemoveGroupFail', "Failed to remove group."), '删除分组失败。'), 'error');
			return;
		}
		this.commitCodeMutation(res.orchestrationText, deleteMembers ? `Delete group ${groupId} & members` : `Ungroup ${groupId}`, {
			successMessage: deleteMembers
				? adeBi(localize('adeOrchDeleteGroupMembersOk', "Deleted group '{0}' and {1} member(s).", groupId, res.removedNodeIds?.length ?? 0), '已删除分组「{0}」及其 {1} 个成员。', groupId, res.removedNodeIds?.length ?? 0)
				: adeBi(localize('adeOrchUngroupOk', "Ungrouped '{0}' (all members preserved).", groupId), '已解散分组「{0}」（已保留全部成员）。', groupId),
		});
	}

	private openGroupContextMenu(group: IOrchestrationDepartmentGroup, clientX: number, clientY: number): void {
		if (!this.activeMissionId || this.viewMode !== 'orchestration') {
			return;
		}
		const worldPos = this.clientToWorldPos(clientX, clientY);
		this.popovers.openCanvasContextMenu(clientX, clientY, [
			{
				id: 'rename-group',
				label: adeBi(localize('adeOrchCtxRenameGroup', "Rename Group"), '重命名分组'),
				icon: 'edit',
				run: () => this.renderer.startInlineGroupRename(group.id),
			},
			{
				id: 'add-staff-to-group',
				label: adeBi(localize('adeOrchCtxAddStaffToGroup', "Add Staff to '{0}'…", group.name), '在「{0}」中新建员工…', group.name),
				icon: 'person-add',
				run: () => this.popovers.openAddStaffPopover(clientX, clientY, payload => {
					this.addOrchestrationStaffVisual({ ...payload, worldPos });
				}, { defaultDepartment: group.name }),
			},
			{
				id: 'add-wb-to-group',
				label: adeBi(localize('adeOrchCtxAddWbToGroup', "Add Whiteboard to '{0}'…", group.name), '在「{0}」中新建白板…', group.name),
				icon: 'notebook',
				run: () => this.popovers.openAddWhiteboardPopover(clientX, clientY, payload => {
					this.addOrchestrationWhiteboardVisual({ ...payload, worldPos });
				}, { defaultDepartment: group.name }),
			},
			{
				id: 'ungroup',
				label: adeBi(localize('adeOrchCtxUngroup', "Ungroup (Keep Members)"), '解散分组（保留成员）'),
				icon: 'ungroup-by-ref-type',
				separatorBefore: true,
				run: () => this.removeOrchestrationGroupVisual(group.id, false),
			},
			{
				id: 'delete-group-members',
				label: adeBi(localize('adeOrchCtxDeleteGroup', "Delete Group & Members"), '删除分组及全部成员'),
				icon: 'trash',
				danger: true,
				run: () => this.removeOrchestrationGroupVisual(group.id, true),
			},
		]);
	}

	private openEdgeContextMenu(edge: IMissionDagEdge, clientX: number, clientY: number): void {
		if (!this.activeMissionId) {
			return;
		}
		if (this.viewMode === 'orchestration') {
			const hasReverse = this.orchEdges.some(e => e.from === edge.to && e.to === edge.from);
			this.popovers.openCanvasContextMenu(clientX, clientY, [
				{
					id: 'edit-edge-label',
					label: adeBi(localize('adeMissionCtxEditEdgeLabel', "Edit Label"), '编辑连线标签'),
					icon: 'edit',
					run: () => this.renderer.startInlineEdgeLabelEdit(edge.id),
				},
				{
					id: 'toggle-bidir',
					label: hasReverse
						? adeBi(localize('adeOrchCtxToUnidir', "Make One-Way (-->)"), '切换为单向 (-->)')
						: adeBi(localize('adeOrchCtxToBidir', "Make Bidirectional (<-->)"), '切换为双向 (<-->)'),
					icon: 'arrow-swap',
					run: () => this.toggleOrchestrationEdgeBidirectional(edge.from, edge.to),
				},
				{
					id: 'delete-edge',
					label: adeBi(localize('adeMissionCtxDeleteEdge', "Delete Edge"), '删除连线'),
					icon: 'trash',
					danger: true,
					separatorBefore: true,
					run: () => this.deleteVisualEdge(edge.from, edge.to),
				},
			]);
			return;
		}

		this.popovers.openCanvasContextMenu(clientX, clientY, [
			{
				id: 'edit-edge-label',
				label: adeBi(localize('adeMissionCtxEditEdgeLabel', "Edit Label"), '编辑连线标签'),
				icon: 'edit',
				run: () => this.renderer.startInlineEdgeLabelEdit(edge.id),
			},
			{
				id: 'delete-edge',
				label: adeBi(localize('adeMissionCtxDeleteEdge', "Delete Edge"), '删除连线'),
				icon: 'trash',
				danger: true,
				separatorBefore: true,
				run: () => this.deleteVisualEdge(edge.from, edge.to),
			},
		]);
	}

	// =========================================================================
	// Parsing & Rendering (Mission View vs. Orchestration View)
	// =========================================================================

	private parseAndRenderMissionGraph(rawText: string, forceAutoLayout = false): void {
		this.fileDrawer.setFileDotVisible(rawText.trim().length > 0);
		const parsed = parseMissionMermaidDag(rawText);
		if (parsed.error) {
			this.fileDrawer.setStatus(parsed.error, 'error');
			if (!this.fileDrawer.isOpen()) {
				this.showCanvasAlert(parsed.error, 'error', { offerOpenFile: true });
			}
			return;
		}

		const hadNodesBefore = this.nodes.length > 0;
		this.isDraggingNode = false;
		this.direction = parsed.direction;
		this.nodes = parsed.nodes;
		this.edges = parsed.edges;
		this.popovers.close();
		if (this.canvasAlertEl?.dataset.alertKind === 'error') {
			this.hideCanvasAlert();
		}

		if (parsed.nodes.length === 0) {
			this.positions.clear();
			this.fileDrawer.setMeta(adeBi(localize('adeMissionMetaEmpty', "Empty"), '空画布'));
			this.fileDrawer.setStatus(adeBi(localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render task nodes"), '编写 Mermaid DAG 语法以渲染任务节点'));
			this.syncGraphDom(true);
			this.fileDrawer.syncTaskDescriptionsPane();
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

		this.fileDrawer.setMeta(adeBi(
			localize('adeMissionMetaTasksCounts', "{0} tasks · {1} edges", parsed.nodes.length, parsed.edges.length),
			'{0} 个任务 · {1} 条依赖',
			parsed.nodes.length,
			parsed.edges.length,
		));
		this.fileDrawer.setStatus(adeBi(localize('adeMissionStatusValid', "Valid acyclic DAG synced"), '无环任务 DAG 已实时同步'), 'ok');

		this.syncGraphDom();
		this.reconcileSelectionAndSearch(parsed.nodes.map(n => n.id), parsed.edges.map(e => `${e.from}->${e.to}`));
		this.fileDrawer.syncTaskDescriptionsPane();
		if (!hadNodesBefore || forceAutoLayout) {
			this.fitGraphToViewport();
		}
	}

	private parseAndRenderOrchestrationGraph(rawText: string, forceAutoLayout = false): void {
		this.fileDrawer.setFileDotVisible(rawText.trim().length > 0);
		const parsed = parseOrchestrationGraph(rawText);
		if (parsed.error) {
			this.fileDrawer.setStatus(parsed.error, 'error');
			if (!this.fileDrawer.isOpen()) {
				this.showCanvasAlert(parsed.error, 'error', { offerOpenFile: true });
			}
			return;
		}

		const hadNodesBefore = this.orchNodes.length > 0 || this.orchDepartments.length > 0;
		this.isDraggingNode = false;
		this.orchDirection = parsed.direction;
		if (parsed.layoutMode && !forceAutoLayout) {
			this.orchLayoutMode = parsed.layoutMode;
			this.fileDrawer?.setLayoutMode(parsed.layoutMode);
		}
		this.orchNodes = parsed.nodes;
		this.orchEdges = parsed.edges;
		this.orchDepartments = parsed.departments;
		this.popovers.close();
		if (this.canvasAlertEl?.dataset.alertKind === 'error') {
			this.hideCanvasAlert();
		}

		if (parsed.nodes.length === 0 && parsed.departments.length === 0) {
			this.positions.clear();
			this.fileDrawer.setMeta(adeBi(localize('adeMissionMetaEmpty', "Empty"), '空画布'));
			this.fileDrawer.setStatus(adeBi(localize('adeOrchStatusEmpty', "Write declarative staff topology (cycles & <--> supported)"), '编写声明式员工编排代码（支持回路与双向连线）'));
			this.syncGraphDom(true);
			return;
		}

		const autoPos = computeOrchestrationAutoLayout(parsed, { layoutMode: this.orchLayoutMode });
		const storedPos = !forceAutoLayout && this.activeMissionId
			? (this.missionService?.getMission(this.activeMissionId)?.orchestrationPositions ?? {})
			: {};
		const codePos = !forceAutoLayout ? (parsed.positions ?? {}) : {};
		const nextPositions = new Map<string, IMissionNodePosition>();
		for (const node of parsed.nodes) {
			const saved = storedPos[node.id] ?? codePos[node.id] ?? (!forceAutoLayout ? this.positions.get(node.id) : undefined);
			nextPositions.set(node.id, saved ?? autoPos.get(node.id) ?? { x: 260, y: 240 });
		}
		for (const dept of parsed.departments) {
			const savedDept = storedPos[dept.id] ?? codePos[dept.id] ?? (!forceAutoLayout ? this.positions.get(dept.id) : undefined);
			if (savedDept) {
				nextPositions.set(dept.id, savedDept);
			}
		}
		this.positions = nextPositions;

		const staffCount = parsed.nodes.filter(n => n.kind === 'staff').length;
		const wbCount = parsed.nodes.filter(n => n.kind === 'whiteboard').length;
		this.fileDrawer.setMeta(wbCount > 0
			? adeBi(localize('adeOrchMetaStaffWb', "{0} staff · {1} WB · {2} links", staffCount, wbCount, parsed.edges.length), '{0} 名员工 · {1} 块白板 · {2} 条连线', staffCount, wbCount, parsed.edges.length)
			: adeBi(localize('adeOrchMetaStaffOnly', "{0} staff · {1} links", staffCount, parsed.edges.length), '{0} 名员工 · {1} 条连线', staffCount, parsed.edges.length));
		if (parsed.advisories && parsed.advisories.length > 0) {
			const firstAdv = parsed.advisories[0];
			const extraCount = parsed.advisories.length - 1;
			const extraSuffix = extraCount > 0
				? adeBi(localize('adeOrchStatusAdvExtra', " (+{0} more)", extraCount), '（另有 {0} 条建议）', extraCount)
				: '';
			this.fileDrawer.setStatus(
				(firstAdv.code === 'ONE_WAY_HIERARCHY_EDGE' && firstAdv.toNodeId
					? adeBi(
						localize('adeOrchStatusOneWayTip', "Synced · Tip: {0} --> {1} is one-way (use <--> if {1} must return tokens)", firstAdv.fromNodeId, firstAdv.toNodeId),
						'已同步 · 提示：{0} --> {1} 为单向连线（若下级需回传令牌，请改为 <--> 回连）',
						firstAdv.fromNodeId,
						firstAdv.toNodeId,
					)
					: adeBi(
						localize('adeOrchStatusDeadEndTip', "Synced · Tip: {0} has no outgoing edge to hand off tokens", firstAdv.fromNodeId),
						'已同步 · 提示：节点 {0} 暂无出边，收到令牌后将无法向其他节点传递',
						firstAdv.fromNodeId,
					)) + extraSuffix,
				'ok',
			);
		} else {
			this.fileDrawer.setStatus(adeBi(localize('adeOrchStatusValid', "Topology synced (cycles & bidirectional enabled)"), '员工自由拓扑已双向实时同步'), 'ok');
		}

		this.syncGraphDom();
		this.reconcileSelectionAndSearch(parsed.nodes.map(n => n.id), parsed.edges.map(e => `${e.from}->${e.to}`));
		this.prewarmHosts();
		if (!hadNodesBefore || forceAutoLayout) {
			this.fitGraphToViewport();
		}
	}

	private handleChangeOrchestrationLayoutMode(mode: OrchestrationLayoutMode): void {
		const missionId = this.activeMissionId;
		this.orchLayoutMode = mode;
		this.fileDrawer?.setLayoutMode(mode);
		if (!missionId || this.viewMode !== 'orchestration') {
			return;
		}
		this.missionService?.updateOrchestrationLayoutMode?.(missionId, mode);
		this.positions.clear();
		this.missionService?.clearOrchestrationPositions(missionId);
		this.parseAndRenderOrchestrationGraph(this.orchestrationText, true);
	}

	private reconcileSelectionAndSearch(liveNodeIds: readonly string[], liveEdgeKeys: readonly string[]): void {
		const liveNodeSet = new Set(liveNodeIds);
		let selChanged = false;
		for (const id of [...this.selectedNodeIds]) {
			if (!liveNodeSet.has(id)) {
				this.selectedNodeIds.delete(id);
				selChanged = true;
			}
		}
		if (selChanged) {
			this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
			this.syncSelectionHud();
		}
		if (this.selectedEdgeKey && !liveEdgeKeys.includes(this.selectedEdgeKey)) {
			this.selectedEdgeKey = undefined;
			this.renderer?.setSelectedEdgeKey(undefined);
		}
		if (this.searchBarEl && !this.searchBarEl.hidden) {
			this.updateCanvasSearchResults(false);
		}
	}

	private buildOrchestrationAgentMap(): Map<string, IAdeAgent> {
		const map = new Map<string, IAdeAgent>();
		if (!this.activeMissionId) {
			return map;
		}
		const generatedEmployees = this.missionService?.getGeneratedEmployees(this.activeMissionId) ?? [];
		const byTreeKey = new Map<string, IAdeAgent>();
		for (const emp of generatedEmployees) {
			if (emp.treeNodeId) {
				byTreeKey.set(emp.treeNodeId, emp);
			}
			for (const nid of emp.treeNodeIds ?? []) {
				map.set(nid, emp);
			}
		}
		const missionRec = this.missionService?.getMission(this.activeMissionId);
		const ownerAgent = missionRec?.ownerSessionId && missionRec.ownerSessionId !== ADE_SECRETARY_ID
			? this.projectsService?.getAgent(missionRec.ownerSessionId)
			: undefined;
		if (ownerAgent && this.orchNodes.length > 0) {
			const rootNode = findHighestRankStaffNode({
				direction: this.orchDirection,
				nodes: this.orchNodes,
				edges: this.orchEdges,
				departments: this.orchDepartments,
			});
			if (rootNode && !map.has(rootNode.id)) {
				map.set(rootNode.id, ownerAgent);
			}
		}
		for (const oNode of this.orchNodes) {
			if (oNode.kind !== 'staff' || map.has(oNode.id)) {
				continue;
			}
			if (oNode.agentId) {
				const direct = this.projectsService?.getAgent(oNode.agentId);
				if (direct) {
					map.set(oNode.id, direct);
					continue;
				}
			}
			const fallback = (oNode.employeeKey ? byTreeKey.get(`emp:${oNode.employeeKey}`) : undefined)
				?? byTreeKey.get(oNode.id);
			if (fallback) {
				map.set(oNode.id, fallback);
			}
		}
		return map;
	}

	private computeActiveProjectsFingerprint(agentByNodeId?: ReadonlyMap<string, IAdeAgent>): string {
		if (!this.activeMissionId || !this.projectsService) {
			return '';
		}
		const map = agentByNodeId ?? this.buildOrchestrationAgentMap();
		const parts: string[] = [this.activeMissionId];
		for (const oNode of this.orchNodes) {
			if (oNode.kind !== 'staff') {
				continue;
			}
			const a = map.get(oNode.id);
			parts.push(a
				? `${oNode.id}:${a.id}|${a.label}|${a.role ?? ''}|${a.session?.engineId ?? ''}|${a.preferredEngineId ?? ''}|${a.preferredModel ?? ''}|${a.preferredThinking ?? ''}`
				: `${oNode.id}:`);
		}
		return parts.join('\x1e');
	}

	private computeTaskStatusesFingerprint(statuses: Readonly<Record<string, IMissionTaskStatusRecord>> | undefined): string {
		if (!statuses) {
			return '';
		}
		return Object.keys(statuses).sort().map(k => {
			const r = statuses[k];
			return `${k}:${r.status}:${r.completedAt ?? 0}:${r.assigneeNodeId ?? ''}:${r.activeTokenIds?.length ?? 0}:${r.artifactPtrs?.length ?? 0}:${r.lastError ?? ''}`;
		}).join('|');
	}

	private computeOrchAuxiliaryFingerprint(
		whiteboards: Readonly<Record<string, IOrchestrationWhiteboard>> | undefined,
		runtime: IOrchestrationRuntimeState | undefined,
	): string {
		const wbPart = whiteboards
			? Object.keys(whiteboards).sort().map(k => `${k}:${whiteboards[k].version}:${whiteboards[k].updatedAt}`).join('|')
			: '';
		const rtPart = runtime
			? `${runtime.status ?? 'running'}:${runtime.tokenSeq}:${Object.values(runtime.tokens).map(t => `${t.id}:${t.status}:${t.nudgeCount}`).join(',')}:${Object.values(runtime.joinBarriers ?? {}).map(b => `${b.id}:${b.status}:${Object.keys(b.settledChildren).length}`).join(',')}`
			: '';
		return `${wbPart}#${rtPart}`;
	}

	private syncGraphDom(forceFullRebuild = false): void {
		if (!this.renderer) {
			return;
		}
		const missionRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const runtimeState = this.getEffectiveRuntimeState();
		const ownerAgent = missionRec?.ownerSessionId ? this.projectsService?.getAgent(missionRec.ownerSessionId) : undefined;
		const fallbackOwnerEngineId = ownerAgent?.session?.engineId ?? ownerAgent?.preferredEngineId ?? 'aexus-claude';
		const agentByNodeId = this.viewMode === 'orchestration' ? this.buildOrchestrationAgentMap() : new Map<string, IAdeAgent>();
		if (this.viewMode === 'orchestration') {
			this.lastProjectsFingerprint = this.computeActiveProjectsFingerprint(agentByNodeId);
			this.lastOrchAuxiliaryFingerprint = this.computeOrchAuxiliaryFingerprint(missionRec?.whiteboards, this.getActiveOrchestrationRuntime());
		} else {
			this.lastTaskStatusFingerprint = this.computeTaskStatusesFingerprint(missionRec?.taskStatuses);
		}

		const snapshot: IMissionCanvasRenderSnapshot = {
			viewMode: this.viewMode,
			direction: this.viewMode === 'orchestration' ? this.orchDirection : this.direction,
			nodes: this.nodes,
			edges: this.edges,
			positions: this.positions,
			runtimeState,
			nodePrompts: missionRec?.nodePrompts ?? {},
			taskStatuses: missionRec?.taskStatuses ?? {},
			orchestrationNodes: this.orchNodes,
			orchestrationEdges: this.orchEdges,
			orchestrationDepartments: this.orchDepartments,
			orchestrationLayoutMode: this.orchLayoutMode,
			whiteboards: missionRec?.whiteboards ?? {},
			orchestrationRuntime: this.getActiveOrchestrationRuntime(),
			agentByNodeId,
			fallbackOwnerEngineId,
			orgConfig: this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG,
			resolveSupervisorDisplay: supId => this.resolveStaffDisplay(supId),
			hasSubordinates: agentId => this.projectsService?.hasSubordinates(agentId) ?? false,
			canSwitchEngine: agent => this.canSwitchAgentEngine(agent),
			canSwitchModel: Boolean(this.projectsService),
			canSwitchHost: Boolean(this.activeMissionId && this.missionRuntimeService && this.cloudHostService),
		};
		this.renderer.syncGraph(snapshot, forceFullRebuild);
		this.updateConsoleBar();
		this.syncMinimap();
	}

	private prewarmHosts(): void {
		const missionId = this.activeMissionId;
		if (!missionId || this.viewMode !== 'orchestration') {
			return;
		}
		const agentMap = this.buildOrchestrationAgentMap();
		const staffNodes: IMissionDagNode[] = this.orchNodes
			.filter(n => n.kind === 'staff')
			.map(n => ({ id: n.id, label: n.label, kind: 'task' as const }));
		this.hostCatalog.prewarmMissionHosts(
			staffNodes,
			node => agentMap.get(node.id),
			() => undefined,
			() => {
				if (!this.isPaneDisposed && this.activeMissionId === missionId && !this.isDraggingNode && !this.popovers.isOpen()) {
					this.syncGraphDom();
				}
			},
		);
	}

	// =========================================================================
	// Viewport Transform, Dragging, Selection, Search & Keyboard
	// =========================================================================

	private clientToWorldPos(clientX: number, clientY: number): IMissionNodePosition {
		const rect = this.viewportEl.getBoundingClientRect();
		const z = this.zoom > 0 ? this.zoom : 1;
		return {
			x: Math.round((clientX - rect.left - this.panX) / z),
			y: Math.round((clientY - rect.top - this.panY) / z),
		};
	}

	private computeDefaultNewNodeWorldPos(): IMissionNodePosition {
		const ids = this.getActiveNodeIds();
		if (ids.length === 0) {
			return { x: 260, y: 200 };
		}
		let maxX = -Infinity;
		let sumY = 0;
		let count = 0;
		for (const id of ids) {
			const pos = this.positions.get(id);
			if (!pos) {
				continue;
			}
			maxX = Math.max(maxX, pos.x);
			sumY += pos.y;
			count++;
		}
		if (count === 0 || !Number.isFinite(maxX)) {
			return { x: 260, y: 200 };
		}
		return { x: Math.round(maxX + 320), y: Math.round(sumY / count) };
	}

	private handleEndNodesDrag(movedNodeIds: readonly string[], movedPx: number): void {
		const preSnap = this.preDragHistorySnapshot;
		this.preDragHistorySnapshot = undefined;
		this.isDraggingNode = false;
		this.flushEdgeReroute();
		if (movedPx >= 5 && this.activeMissionId && movedNodeIds.length > 0) {
			const updates: Record<string, IMissionNodePosition> = {};
			let anyChanged = false;
			for (const nid of movedNodeIds) {
				const pos = this.positions.get(nid);
				if (!pos) {
					continue;
				}
				updates[nid] = { x: pos.x, y: pos.y };
				const prevPos = preSnap?.positions[nid];
				if (!prevPos || prevPos.x !== pos.x || prevPos.y !== pos.y) {
					anyChanged = true;
				}
			}
			if (anyChanged && preSnap) {
				this.pushHistory({ ...preSnap, label: movedNodeIds.length > 1 ? `Move ${movedNodeIds.length} nodes` : `Move ${movedNodeIds[0]}` });
			}
			if (Object.keys(updates).length > 0) {
				if (this.viewMode === 'orchestration') {
					this.missionService?.updateOrchestrationPositions(this.activeMissionId, updates);
				} else {
					this.missionService?.updateNodePositions(this.activeMissionId, updates);
				}
			}
		}
	}

	private selectNode(nodeId: string | undefined, options?: { readonly toggleMulti?: boolean }): void {
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		if (!nodeId) {
			this.selectedNodeIds.clear();
			this.renderer?.setSelectedNodeIds([]);
			this.syncSelectionHud();
			return;
		}
		if (options?.toggleMulti) {
			this.popovers?.close();
			if (this.selectedNodeIds.has(nodeId)) {
				this.selectedNodeIds.delete(nodeId);
			} else {
				this.selectedNodeIds.add(nodeId);
			}
		} else {
			this.selectedNodeIds = new Set([nodeId]);
		}
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.syncSelectionHud();
	}

	private selectNodes(nodeIds: Iterable<string>, options?: { readonly additive?: boolean }): void {
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		const next = options?.additive ? new Set(this.selectedNodeIds) : new Set<string>();
		for (const id of nodeIds) {
			next.add(id);
		}
		this.selectedNodeIds = next;
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.syncSelectionHud();
	}

	private selectEdge(edge: IMissionDagEdge | undefined): void {
		if (!edge) {
			this.selectedEdgeKey = undefined;
			this.renderer?.setSelectedEdgeKey(undefined);
			return;
		}
		if (this.selectedNodeIds.size > 0) {
			this.selectedNodeIds.clear();
			this.renderer?.setSelectedNodeIds([]);
			this.syncSelectionHud();
		}
		this.selectedEdgeKey = `${edge.from}->${edge.to}`;
		this.renderer?.setSelectedEdgeKey(this.selectedEdgeKey);
	}

	private syncSelectionHud(): void {
		if (!this.selectionHudEl) {
			return;
		}
		if (this.selectedNodeIds.size > 1) {
			this.selectionHudEl.hidden = false;
			const label = adeBi(
				localize('adeMissionMultiSelectHudText', "{0} selected · Drag to move / Delete to remove", this.selectedNodeIds.size),
				'已选 {0} 个节点 · 拖拽批量移动 / Delete 删除',
				this.selectedNodeIds.size,
			);
			if (this.selectionHudLabelEl.textContent !== label) {
				this.selectionHudLabelEl.textContent = label;
			}
		} else {
			this.selectionHudEl.hidden = true;
		}
	}

	private openCanvasSearch(): void {
		if (!this.searchBarEl || !this.activeMissionId) {
			return;
		}
		this.popovers.close();
		this.searchBarEl.hidden = false;
		this.syncHudLayoutClasses();
		this.searchInputEl.focus();
		this.searchInputEl.select();
		if (this.searchInputEl.value.trim()) {
			this.updateCanvasSearchResults(false);
		}
	}

	private closeCanvasSearch(restoreCanvasFocus = false): void {
		if (!this.searchBarEl) {
			return;
		}
		this.searchBarEl.hidden = true;
		this.syncHudLayoutClasses();
		this.searchMatchIds = [];
		this.searchActiveIdx = -1;
		if (this.searchCountEl) {
			this.searchCountEl.textContent = '';
		}
		this.renderer?.setSearchMatches(undefined, undefined);
		if (restoreCanvasFocus) {
			this.rootEl?.focus();
		}
	}

	private centerViewportOnNode(nodeId: string): void {
		const pos = this.positions.get(nodeId);
		if (!pos || !this.viewportEl) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		const vpW = rect.width > 40 ? rect.width : 1080;
		const vpH = rect.height > 40 ? rect.height : 720;
		if (this.zoom < 0.75) {
			this.zoom = 0.85;
		}
		this.panX = Math.round(vpW / 2 - pos.x * this.zoom);
		this.panY = Math.round(vpH / 2 - pos.y * this.zoom);
		this.applyWorldTransformNow();
		this.renderer?.pulseFocusNode(nodeId, 1800);
	}

	private updateCanvasSearchResults(autoCenter = true): void {
		const query = (this.searchInputEl?.value ?? '').trim().toLowerCase();
		if (!query) {
			this.searchMatchIds = [];
			this.searchActiveIdx = -1;
			if (this.searchCountEl) {
				this.searchCountEl.textContent = '';
			}
			this.renderer?.setSearchMatches(undefined, undefined);
			return;
		}
		const matches: string[] = [];
		if (this.viewMode === 'orchestration') {
			const wbs = this.getActiveWhiteboards();
			for (const oNode of this.orchNodes) {
				const haystack = [
					oNode.id,
					oNode.label,
					oNode.employeeName ?? '',
					oNode.department ?? '',
					oNode.rankId ?? '',
					wbs[oNode.id]?.content ?? '',
				].join('\n').toLowerCase();
				if (haystack.includes(query)) {
					matches.push(oNode.id);
				}
			}
		} else {
			const prompts = this.getActiveNodePrompts();
			for (const node of this.nodes) {
				const haystack = [node.id, node.label, prompts[node.id] ?? ''].join('\n').toLowerCase();
				if (haystack.includes(query)) {
					matches.push(node.id);
				}
			}
		}
		this.searchMatchIds = matches;
		if (matches.length === 0) {
			this.searchActiveIdx = -1;
			this.searchCountEl.textContent = '0 / 0';
			this.renderer?.setSearchMatches(undefined, undefined);
			return;
		}
		this.searchActiveIdx = this.searchActiveIdx >= 0 && this.searchActiveIdx < matches.length ? this.searchActiveIdx : 0;
		const activeId = matches[this.searchActiveIdx];
		this.searchCountEl.textContent = `${this.searchActiveIdx + 1} / ${matches.length}`;
		this.renderer?.setSearchMatches(new Set(matches), activeId);
		if (autoCenter) {
			this.centerViewportOnNode(activeId);
		}
	}

	private stepCanvasSearchMatch(delta: 1 | -1): void {
		if (this.searchMatchIds.length === 0) {
			this.updateCanvasSearchResults(true);
			return;
		}
		const len = this.searchMatchIds.length;
		this.searchActiveIdx = (this.searchActiveIdx + delta + len) % len;
		const activeId = this.searchMatchIds[this.searchActiveIdx];
		this.searchCountEl.textContent = `${this.searchActiveIdx + 1} / ${len}`;
		this.renderer?.setSearchMatches(new Set(this.searchMatchIds), activeId);
		this.centerViewportOnNode(activeId);
	}

	private cancelScheduledFrames(): void {
		const win = this.rootEl ? getWindow(this.rootEl) : undefined;
		if (this.transformRafId !== undefined) {
			win?.cancelAnimationFrame(this.transformRafId);
			this.transformRafId = undefined;
		}
		if (this.edgeRerouteRafId !== undefined) {
			win?.cancelAnimationFrame(this.edgeRerouteRafId);
			this.edgeRerouteRafId = undefined;
		}
		this.pendingDraggedNodeId = undefined;
		this.pendingDraggedMultipleNodes = false;
	}

	private scheduleWorldTransform(): void {
		if (this.transformRafId !== undefined || !this.rootEl) {
			return;
		}
		const win = getWindow(this.rootEl);
		this.transformRafId = win.requestAnimationFrame(() => {
			this.transformRafId = undefined;
			this.applyWorldTransformNow();
		});
	}

	private applyWorldTransformNow(): void {
		if (!this.viewportEl || !this.worldEl) {
			return;
		}
		if (this.transformRafId !== undefined && this.rootEl) {
			getWindow(this.rootEl).cancelAnimationFrame(this.transformRafId);
			this.transformRafId = undefined;
		}
		const rx = Math.round(this.panX);
		const ry = Math.round(this.panY);
		this.worldEl.style.transform = `translate(${rx}px, ${ry}px) scale(${this.zoom})`;
		this.viewportEl.style.setProperty('--grid-x', `${rx}px`);
		this.viewportEl.style.setProperty('--grid-y', `${ry}px`);
		this.viewportEl.style.setProperty('--grid-scale', String(this.zoom));
		this.viewportEl.classList.toggle('zoom-macro', this.zoom < 0.5);
		this.syncMinimapViewport();
	}

	private scheduleEdgeReroute(movedNodeId?: string): void {
		if (movedNodeId) {
			if (this.pendingDraggedNodeId && this.pendingDraggedNodeId !== movedNodeId) {
				this.pendingDraggedMultipleNodes = true;
			}
			this.pendingDraggedNodeId = movedNodeId;
		} else {
			this.pendingDraggedMultipleNodes = true;
		}
		if (this.edgeRerouteRafId !== undefined || !this.rootEl) {
			return;
		}
		const win = getWindow(this.rootEl);
		this.edgeRerouteRafId = win.requestAnimationFrame(() => {
			this.edgeRerouteRafId = undefined;
			const targetNodeId = this.pendingDraggedMultipleNodes ? undefined : this.pendingDraggedNodeId;
			this.pendingDraggedNodeId = undefined;
			this.pendingDraggedMultipleNodes = false;
			const dir = this.viewMode === 'orchestration' ? this.orchDirection : this.direction;
			this.renderer?.updateEdgesSvg(this.nodes, this.edges, this.positions, targetNodeId ? { movedNodeId: targetNodeId, direction: dir } : { direction: dir });
		});
	}

	private flushEdgeReroute(): void {
		if (this.edgeRerouteRafId !== undefined && this.rootEl) {
			getWindow(this.rootEl).cancelAnimationFrame(this.edgeRerouteRafId);
			this.edgeRerouteRafId = undefined;
		}
		this.pendingDraggedNodeId = undefined;
		this.pendingDraggedMultipleNodes = false;
		const dir = this.viewMode === 'orchestration' ? this.orchDirection : this.direction;
		this.renderer?.updateEdgesSvg(this.nodes, this.edges, this.positions, { direction: dir });
	}

	private syncAnimationPauseState(): void {
		if (this.isPaneDisposed || !this.rootEl) {
			return;
		}
		const doc = getWindow(this.rootEl).document;
		const pageHidden = Boolean(doc.hidden || doc.visibilityState === 'hidden');
		doc.documentElement.classList.toggle('ade-page-hidden', pageHidden);
		const paused = pageHidden || !this.isEditorTabVisible;
		this.rootEl.classList.toggle('ade-animations-paused', paused);
		if (paused) {
			this.rootEl.setAttribute('data-animations-paused', 'true');
		} else {
			this.rootEl.removeAttribute('data-animations-paused');
		}
		this.renderer?.setAnimationsPaused(paused);
	}

	private installCanvasInteractions(): void {
		let panning = false;
		let panMoved = false;
		let marqueeSelecting = false;
		let marqueeAdditive = false;
		let startClientX = 0;
		let startClientY = 0;
		let startPanX = 0;
		let startPanY = 0;

		const computeMarqueeHitIds = (c1x: number, c1y: number, c2x: number, c2y: number): string[] => {
			const w1 = this.clientToWorldPos(Math.min(c1x, c2x), Math.min(c1y, c2y));
			const w2 = this.clientToWorldPos(Math.max(c1x, c2x), Math.max(c1y, c2y));
			const hits: string[] = [];
			for (const id of this.getActiveNodeIds()) {
				const pos = this.positions.get(id);
				if (!pos) {
					continue;
				}
				const sz = this.getNodeDimensions(id);
				if (pos.x - sz.width / 2 <= w2.x && pos.x + sz.width / 2 >= w1.x && pos.y - sz.height / 2 <= w2.y && pos.y + sz.height / 2 >= w1.y) {
					hits.push(id);
				}
			}
			return hits;
		};

		const updateMarqueeBoxDom = (curX: number, curY: number): void => {
			const vpRect = this.viewportEl.getBoundingClientRect();
			this.marqueeBoxEl.style.left = `${Math.round(Math.min(startClientX, curX) - vpRect.left)}px`;
			this.marqueeBoxEl.style.top = `${Math.round(Math.min(startClientY, curY) - vpRect.top)}px`;
			this.marqueeBoxEl.style.width = `${Math.round(Math.abs(curX - startClientX))}px`;
			this.marqueeBoxEl.style.height = `${Math.round(Math.abs(curY - startClientY))}px`;
		};

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 && e.button !== 1) {
				return;
			}
			this.popovers.close();

			if (e.button === 0 && e.shiftKey) {
				e.preventDefault();
				this.selectEdge(undefined);
				marqueeSelecting = true;
				marqueeAdditive = Boolean(e.metaKey || e.ctrlKey);
				startClientX = e.clientX;
				startClientY = e.clientY;
				this.marqueeBoxEl.hidden = false;
				updateMarqueeBoxDom(e.clientX, e.clientY);
				this.viewportEl.classList.add('is-marquee-selecting');
				try {
					this.viewportEl.setPointerCapture(e.pointerId);
				} catch { /* synthetic events */ }
				return;
			}

			panning = true;
			panMoved = false;
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
			if (marqueeSelecting) {
				updateMarqueeBoxDom(e.clientX, e.clientY);
				const hits = computeMarqueeHitIds(startClientX, startClientY, e.clientX, e.clientY);
				const previewIds = marqueeAdditive ? new Set([...this.selectedNodeIds, ...hits]) : new Set(hits);
				this.renderer?.setSelectedNodeIds(previewIds);
				return;
			}
			if (!panning) {
				return;
			}
			const dx = e.clientX - startClientX;
			const dy = e.clientY - startClientY;
			if (!panMoved && Math.hypot(dx, dy) >= CANVAS_PAN_CLICK_THRESHOLD_PX) {
				panMoved = true;
			}
			this.panX = startPanX + dx;
			this.panY = startPanY + dy;
			this.scheduleWorldTransform();
		}));

		const stopViewportDrag = (e: PointerEvent, cancelled = false) => {
			if (marqueeSelecting) {
				marqueeSelecting = false;
				this.marqueeBoxEl.hidden = true;
				this.viewportEl.classList.remove('is-marquee-selecting');
				try {
					this.viewportEl.releasePointerCapture(e.pointerId);
				} catch { /* ignore */ }
				if (!cancelled) {
					const dist = Math.hypot(e.clientX - startClientX, e.clientY - startClientY);
					if (dist >= 4) {
						this.selectNodes(computeMarqueeHitIds(startClientX, startClientY, e.clientX, e.clientY), { additive: marqueeAdditive });
					} else if (!marqueeAdditive) {
						this.selectNode(undefined);
					}
				} else {
					this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
				}
				return;
			}
			if (!panning) {
				return;
			}
			const wasMoved = panMoved || Math.hypot(e.clientX - startClientX, e.clientY - startClientY) >= CANVAS_PAN_CLICK_THRESHOLD_PX;
			panning = false;
			panMoved = false;
			this.viewportEl.classList.remove('panning');
			this.applyWorldTransformNow();
			try {
				this.viewportEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
			if (!cancelled && !wasMoved) {
				this.selectEdge(undefined);
				if (this.selectedNodeIds.size > 0) {
					this.selectNode(undefined);
				}
			}
		};
		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_UP, e => stopViewportDrag(e, false)));
		this._register(addDisposableListener(this.viewportEl, 'pointercancel', e => stopViewportDrag(e, true)));

		// Blank-canvas right-click context menu (preserved interaction to create nodes cleanly!)
		this._register(addDisposableListener(this.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-mission-node, .ade-mission-edge-group, .ade-orch-dept-pill-group')) {
				return;
			}
			if (!this.activeMissionId) {
				return;
			}
			e.preventDefault();
			const worldPos = this.clientToWorldPos(e.clientX, e.clientY);
			const hasNodes = this.getActiveNodeCount() > 0;

			if (this.viewMode === 'orchestration') {
				const topStaff = findHighestRankStaffNode({
					direction: this.orchDirection,
					nodes: this.orchNodes,
					edges: this.orchEdges,
					departments: this.orchDepartments,
				});
				this.popovers.openCanvasContextMenu(e.clientX, e.clientY, [
					{
						id: 'add-group',
						label: adeBi(localize('adeOrchCtxAddGroup', "New Group / Department…"), '新建部门分组 (Group)…'),
						icon: 'folder',
						run: () => this.popovers.openAddGroupPopover(e.clientX, e.clientY, name => {
							this.addOrchestrationGroupVisual(name, worldPos);
						}),
					},
					{
						id: 'add-staff',
						label: adeBi(localize('adeOrchCtxAddStaff', "New Staff Node…"), '新建员工节点…'),
						icon: 'person-add',
						run: () => this.popovers.openAddStaffPopover(e.clientX, e.clientY, payload => {
							this.addOrchestrationStaffVisual({ ...payload, worldPos });
						}),
					},
					{
						id: 'add-whiteboard',
						label: adeBi(localize('adeOrchCtxAddWhiteboard', "New Department Whiteboard…"), '新建部门共享白板…'),
						icon: 'notebook',
						run: () => this.popovers.openAddWhiteboardPopover(e.clientX, e.clientY, payload => {
							this.addOrchestrationWhiteboardVisual({ ...payload, worldPos });
						}),
					},
					...(topStaff ? [{
						id: 'dispatch-requirement',
						label: adeBi(localize('adeOrchCtxDispatchTop', "Dispatch Requirement to {0}…", topStaff.label), '向最高职级 {0} 下达需求…', topStaff.label),
						icon: 'send',
						separatorBefore: true,
						run: () => this.popovers.openDispatchRequirementPopover(e.clientX, e.clientY, topStaff.label, req => {
							this.handleDispatchRequirement(req, topStaff.id);
						}),
					}] : []),
					{
						id: 'fit-view',
						label: adeBi(localize('adeMissionCtxFitView', "Fit View"), '适配视口'),
						icon: 'screen-full',
						separatorBefore: true,
						disabled: !hasNodes,
						run: () => this.fitGraphToViewport(),
					},
					{
						id: 'auto-layout',
						label: adeBi(localize('adeMissionCtxAutoLayout', "Auto Layout"), '自动排版'),
						icon: 'layout',
						disabled: !hasNodes,
						run: () => this.resetToAutoLayout(),
					},
				]);
				return;
			}

			this.popovers.openCanvasContextMenu(e.clientX, e.clientY, [
				{
					id: 'add-task',
					label: adeBi(localize('adeMissionCtxAddTaskNode', "New Task Node"), '新建任务节点'),
					icon: 'add',
					run: () => this.addMissionTaskVisual(worldPos),
				},
				{
					id: 'fit-view',
					label: adeBi(localize('adeMissionCtxFitView', "Fit View"), '适配视口'),
					icon: 'screen-full',
					separatorBefore: true,
					disabled: !hasNodes,
					run: () => this.fitGraphToViewport(),
				},
				{
					id: 'auto-layout',
					label: adeBi(localize('adeMissionCtxAutoLayout', "Auto Layout"), '自动排版'),
					icon: 'layout',
					disabled: !hasNodes,
					run: () => this.resetToAutoLayout(),
				},
			]);
		}));

		this._register(addDisposableListener(this.viewportEl, EventType.WHEEL, (e: WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const rect = this.viewportEl.getBoundingClientRect();
				const cursorX = e.clientX - rect.left;
				const cursorY = e.clientY - rect.top;
				const worldX = (cursorX - this.panX) / this.zoom;
				const worldY = (cursorY - this.panY) / this.zoom;
				const factor = e.deltaY < 0 ? 1.08 : 0.92;
				this.zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor)) * 100) / 100;
				this.panX = cursorX - worldX * this.zoom;
				this.panY = cursorY - worldY * this.zoom;
			} else {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
			}
			this.applyWorldTransformNow();
		}, { passive: false }));

		const win = getWindow(this.rootEl);
		this._register(addDisposableListener(win, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable);
			const doc = this.rootEl?.ownerDocument;
			const activeEl = doc?.activeElement as HTMLElement | null;
			const focusWithinCanvas = !activeEl || activeEl === doc?.body || this.rootEl.contains(activeEl);
			const isPaneDisplayed = Boolean(this.rootEl?.isConnected && (this.rootEl.offsetWidth > 0 || this.rootEl.offsetHeight > 0));
			const canvasActive = focusWithinCanvas && isPaneDisplayed && !this.isPaneDisposed && Boolean(this.activeMissionId);
			const hasPrimaryMod = (e.metaKey || e.ctrlKey) && !e.altKey;
			const lowerKey = e.key.toLowerCase();

			if (hasPrimaryMod && !e.shiftKey && lowerKey === 'f' && canvasActive && !this.fileDrawer.isOpen()) {
				const typingOutsideSearch = isTyping && target !== this.searchInputEl;
				if (!typingOutsideSearch) {
					e.preventDefault();
					e.stopPropagation();
					this.openCanvasSearch();
					return;
				}
			}

			if (hasPrimaryMod && !isTyping && canvasActive && !this.popovers.isOpen()) {
				if (lowerKey === 'z') {
					e.preventDefault();
					e.stopPropagation();
					if (e.shiftKey) {
						this.redoCanvasMutation();
					} else {
						this.undoCanvasMutation();
					}
					return;
				}
				if (lowerKey === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey) {
					e.preventDefault();
					e.stopPropagation();
					this.redoCanvasMutation();
					return;
				}
				if (lowerKey === 'a' && !e.shiftKey && !this.fileDrawer.isOpen() && this.getActiveNodeCount() > 0) {
					e.preventDefault();
					e.stopPropagation();
					this.selectNodes(this.getActiveNodeIds());
					return;
				}
			}

			if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
				if (!isTyping && canvasActive && !this.fileDrawer.isOpen() && !this.popovers.isOpen()) {
					if (this.selectedEdgeKey || this.selectedNodeIds.size > 0) {
						e.preventDefault();
						e.stopPropagation();
						this.deleteSelectedItems();
						return;
					}
				}
			}

			if (e.key === 'Escape') {
				if (this.searchBarEl && !this.searchBarEl.hidden) {
					this.closeCanvasSearch(true);
				} else if (this.popovers.isOpen()) {
					this.popovers.close();
				} else if (this.fileDrawer.isOpen()) {
					this.fileDrawer.toggle(false);
				} else if (this.selectedNodeIds.size > 0 || this.selectedEdgeKey) {
					this.selectNode(undefined);
				}
			}
		}));
		this._register(addDisposableListener(win.document, 'visibilitychange', () => {
			this.syncAnimationPauseState();
		}));
		this.syncAnimationPauseState();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.isEditorTabVisible = visible;
		this.syncAnimationPauseState();
	}

	override async setInput(input: AdeEngineeringEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.cancelScheduledFrames();
		this.hideCanvasAlert();
		this.isDraggingNode = false;
		this.undoStack = [];
		this.redoStack = [];
		this.preDragHistorySnapshot = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.syncSelectionHud();
		this.closeCanvasSearch(false);
		this.fileDrawer.clearParseTimer();
		this.fileDrawer.toggle(false);
		this.popovers.close();
		this.setHoveredNode(undefined);
		this.renderer.setSelectedNodeIds([]);
		this.renderer.setSelectedEdgeKey(undefined);
		this.renderer.setTraceHighlightEdges(undefined);
		this.renderer.resetTransitTracking();

		this.activeMissionId = input.governorSessionId;
		this.viewMode = input.viewMode;
		this.rootEl.dataset.viewMode = this.viewMode;
		this.fileDrawer.setViewMode(this.viewMode);
		this.fileDrawer.setSelectedTaskNodeId(undefined);
		this.syncEmptyHintCopy();

		const record = this.missionService?.ensureMission(input.governorSessionId);
		this.mermaidText = record?.mermaidText ?? '';
		this.orchestrationText = record?.orchestrationText ?? '';
		this.nodes = [];
		this.edges = [];
		this.orchNodes = [];
		this.orchEdges = [];
		this.orchDepartments = [];
		this.positions.clear();
		this.renderer.invalidateStructure();

		if (this.viewMode === 'orchestration') {
			const parsedInit = parseOrchestrationGraph(this.orchestrationText);
			this.orchLayoutMode = record?.orchestrationLayoutMode ?? (parsedInit.direction === 'TD' ? 'td' : 'lr');
			this.fileDrawer.setLayoutMode(this.orchLayoutMode);
			this.fileDrawer.setCodeValue(this.orchestrationText);
			this.parseAndRenderOrchestrationGraph(this.orchestrationText);
			if (this.orchNodes.length === 0) {
				this.syncGraphDom(true);
			}
		} else {
			this.fileDrawer.setCodeValue(this.mermaidText);
			this.parseAndRenderMissionGraph(this.mermaidText);
			if (this.nodes.length === 0) {
				this.syncGraphDom(true);
			}
		}

		this.syncHudLayoutClasses();
		this.updateConsoleBar();
		this.applyWorldTransformNow();

		const pendingFocus = input.consumePendingFocus();
		if (pendingFocus) {
			this.focusNode(pendingFocus.nodeId, {
				inspectorTab: pendingFocus.inspectorTab,
				openAgentBeside: pendingFocus.openAgentBeside,
			});
		}
	}

	override clearInput(): void {
		this.cancelScheduledFrames();
		this.hideCanvasAlert();
		this.isDraggingNode = false;
		this.undoStack = [];
		this.redoStack = [];
		this.preDragHistorySnapshot = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.syncSelectionHud();
		this.closeCanvasSearch(false);
		this.fileDrawer?.clearParseTimer();
		this.popovers?.close();
		this.syncHudLayoutClasses();
		this.activeMissionId = undefined;
		this.clearAbortConfirmTimer();
		this.updateConsoleBar();
		this.setHoveredNode(undefined);
		this.renderer?.setSelectedNodeIds([]);
		this.renderer?.setSelectedEdgeKey(undefined);
		this.renderer?.setTraceHighlightEdges(undefined);
		this.renderer?.resetTransitTracking();
		super.clearInput();
	}

	override focus(): void {
		this.rootEl?.focus();
	}

	layout(dimension: Dimension): void {
		if (this.rootEl) {
			this.rootEl.style.width = `${dimension.width}px`;
			this.rootEl.style.height = `${dimension.height}px`;
			this.syncHudLayoutClasses();
			this.syncMinimapViewport();
		}
	}
}
