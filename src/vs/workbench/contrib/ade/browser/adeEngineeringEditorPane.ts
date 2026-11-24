/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension, getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import {
	IMissionDagEdge,
	IMissionDagNode,
	IMissionNodePosition,
	parseMissionMermaidDag,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionRuntimeState } from '../../../../platform/ade/common/adeMissionEngine.js';
import {
	buildOrchestrationTokenDeltaView,
	findHighestRankStaffNode,
	IMissionTaskStatusRecord,
	IOrchestrationRuntimeState,
	IOrchestrationToken,
	IOrchestrationWhiteboard,
	MissionTaskStatus,
	updateMissionTaskNodeStatus,
} from '../../../../platform/ade/common/adeOrchestrationEngine.js';
import {
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	OrchestrationLayoutMode,
	parseOrchestrationGraph,
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
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
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
import { AdeEngineeringGraphActions } from './adeEngineeringGraphActions.js';
import {
	AdePageVisibilityAnimationGuard,
	buildBlankCanvasContextMenuItems,
	buildEdgeContextMenuItems,
	buildGroupContextMenuItems,
	buildMinimapSyncPayload,
	buildMissionNodeContextMenuItems,
	buildOrchestrationAgentMap,
	buildStaffNodeContextMenuItems,
	buildWhiteboardNodeContextMenuItems,
	computeActiveProjectsFingerprint,
	computeDefaultNewNodeWorldPos,
	computeGraphWorldBounds,
	computeMissionTaskStatusesFingerprint,
	computeOrchestrationAuxiliaryFingerprint,
	createEngineeringChromeDom,
	EngineeringHistoryStore,
	EngineeringViewportMemory,
	findCanvasSearchMatches,
	IAdePendingMissionNodeFocus,
	IEngineeringHistoryEntry,
	inferEngineeringViewModeForNode,
	installEngineeringCanvasInteractions,
	resolveCrossViewLinkedNodeIds,
	resolveMissionLayoutPositions,
	resolveOrchestrationLayoutPositions,
	resolveTaskAssigneeAndTokens,
	updateEngineeringConsoleBarDom,
} from './adeEngineeringViewLinkage.js';
import { AdeMissionCanvasRenderer, getMissionNodeSize, getRenderedOrchestrationNodeSize, IMissionCanvasRenderSnapshot } from './adeMissionCanvasRenderer.js';
import { AdeMissionFileDrawer } from './adeMissionFileDrawer.js';
import { AdeMissionHostCatalog } from './adeMissionHostCatalog.js';
import { AdeMissionMinimap } from './adeMissionMinimap.js';
import { AdeMissionPopovers } from './adeMissionPopovers.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import './media/adeMissionCanvas.css';
import './media/adeMissionEdges.css';
import './media/adeMissionCards.css';
import './media/adeMissionOverlays.css';

export { AdePageVisibilityAnimationGuard };
export type { IAdePendingMissionNodeFocus };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const CANVAS_PAN_CLICK_THRESHOLD_PX = 5;
const SMOOTH_CAMERA_GLIDE_MS = 220;

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
	private readonly editorGroupsService: IEditorGroupsService | undefined;
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
	private consoleTokensEl!: HTMLElement;
	private consoleSpendEl!: HTMLElement;
	private consolePauseBtnEl!: HTMLButtonElement;
	private consoleAbortBtnEl!: HTMLButtonElement;
	private consoleMinimapBtnEl!: HTMLButtonElement;

	private fileDrawer!: AdeMissionFileDrawer;
	private popovers!: AdeMissionPopovers;
	private renderer!: AdeMissionCanvasRenderer;
	private minimap!: AdeMissionMinimap;

	private readonly historyStore = new EngineeringHistoryStore();
	private readonly viewportMemory = new EngineeringViewportMemory();
	private readonly graphActions: AdeEngineeringGraphActions;
	private preDragHistorySnapshot: IEngineeringHistoryEntry | undefined;

	private viewMode: AdeEngineeringViewMode = 'mission';
	private activeMissionId: string | undefined;
	private activePromptEditSource: 'drawer' | 'popover' | undefined;
	private isDraggingNode = false;
	private pendingResyncAfterDrag = false;
	private crossViewHoverIds = new Set<string>();
	private crossViewSelectIds = new Set<string>();
	private focusHighlightIds = new Set<string>();
	private openMissionTaskPopoverNodeId: string | undefined;

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
	private cameraAnimRafId: number | undefined;
	private pendingDraggedNodeId: string | undefined;
	private pendingDraggedMultipleNodes = false;
	private canvasAlertTimer: number | undefined;
	private abortConfirmUntil = 0;
	private abortConfirmMissionId: string | undefined;
	private abortConfirmTimer: number | undefined;
	private popoverCountdownTimer: number | undefined;
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
		this.editorGroupsService = tryGet(IEditorGroupsService);

		this.hostCatalog = this._register(new AdeMissionHostCatalog(
			storageService,
			this.sessionsService,
			this.cloudHostService,
			this.commandService,
		));

		this.graphActions = new AdeEngineeringGraphActions({
			getActiveMissionId: () => this.activeMissionId,
			getViewMode: () => this.viewMode,
			isDisposed: () => this.isPaneDisposed,
			getMermaidText: () => this.mermaidText,
			getDirection: () => this.direction,
			getOrchestrationText: () => this.orchestrationText,
			setOrchestrationText: text => { this.orchestrationText = text; },
			getOrchDirection: () => this.orchDirection,
			getOrchNodes: () => this.orchNodes,
			getOrchEdges: () => this.orchEdges,
			getNodePosition: nodeId => this.positions.get(nodeId),
			computeDefaultNewNodeWorldPos: () => this.computeDefaultNewNodeWorldPos(),
			getOrgConfig: () => this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG,
			getActiveWhiteboards: () => this.getActiveWhiteboards(),
			getMissionService: () => this.missionService,
			getMissionRuntimeService: () => this.missionRuntimeService,
			captureHistorySnapshot: label => this.captureHistorySnapshot(label),
			pushHistory: entry => this.pushHistory(entry),
			commitCodeMutation: (nextCode, reason, opts) => this.commitCodeMutation(nextCode, reason, opts),
			syncCodeToDrawer: nextCode => this.fileDrawer?.setCodeValue(nextCode, true),
			parseAndRenderOrchestrationGraph: (nextCode, force) => this.parseAndRenderOrchestrationGraph(nextCode, force),
			syncAllNodePromptViews: () => this.syncAllNodePromptViews(),
			removeDeletedNodeIdsFromSelection: ids => {
				for (const nid of ids) {
					this.selectedNodeIds.delete(nid);
				}
				this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
				this.syncSelectionHud();
			},
			reportFeedback: (msg, kind, opts) => this.reportFeedback(msg, kind, opts),
		});

		if (this.adeEditorService?.onDidCrossViewLinkHint) {
			this._register(this.adeEditorService.onDidCrossViewLinkHint(hint => {
				if (this.isPaneDisposed || !this.activeMissionId || hint.missionId !== this.activeMissionId || hint.sourceView === this.viewMode) {
					return;
				}
				if (hint.kind === 'hover') {
					this.crossViewHoverIds = new Set(hint.nodeIds);
				} else {
					this.crossViewSelectIds = new Set(hint.nodeIds);
				}
				this.applyCrossViewLinkHighlights();
			}));
		}

		if (this.missionService) {
			this._register(this.missionService.onDidChange(() => {
				if (!this.activeMissionId || !this.renderer) {
					return;
				}
				if (this.isDraggingNode) {
					this.pendingResyncAfterDrag = true;
					return;
				}
				this.resyncFromMissionStore();
			}));
		}

		if (this.missionRuntimeService) {
			this._register(this.missionRuntimeService.onDidChange(changedMissionId => {
				if (!this.activeMissionId || changedMissionId !== this.activeMissionId || !this.renderer) {
					return;
				}
				if (this.isDraggingNode) {
					this.pendingResyncAfterDrag = true;
					return;
				}
				this.syncGraphDom();
				if (this.viewMode === 'mission') {
					this.fileDrawer?.syncTaskDescriptionsPane(true);
				}
			}));
		}

		if (this.projectsService) {
			this._register(this.projectsService.onDidChange(() => {
				if (!this.activeMissionId || this.viewMode !== 'orchestration' || this.orchNodes.length === 0 || !this.renderer) {
					return;
				}
				if (this.isDraggingNode) {
					this.pendingResyncAfterDrag = true;
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
				if (this.activeMissionId && this.viewMode === 'orchestration' && this.orchNodes.length > 0 && this.renderer) {
					if (this.isDraggingNode) {
						this.pendingResyncAfterDrag = true;
						return;
					}
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
			if (this.activeMissionId && this.getActiveNodeCount() > 0 && this.renderer) {
				if (this.isDraggingNode) {
					this.pendingResyncAfterDrag = true;
					return;
				}
				this.syncGraphDom();
			}
		}));

		this._register(this.hostCatalog.onDidChangeHosts(() => {
			if (this.activeMissionId && this.viewMode === 'orchestration' && this.orchNodes.length > 0 && this.renderer) {
				if (this.isDraggingNode) {
					this.pendingResyncAfterDrag = true;
					return;
				}
				this.syncGraphDom();
			}
		}));

		this._register(onDidChangeAdeLocale(() => {
			this.syncEmptyHintCopy();
			this.updateConsoleBar();
			if (this.activeMissionId && this.renderer) {
				if (this.isDraggingNode) {
					this.pendingResyncAfterDrag = true;
					return;
				}
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
				this.emitCrossViewLinkHint([], 'hover');
				this.emitCrossViewLinkHint([], 'select');
				this.cancelScheduledFrames();
				this.clearCanvasAlertTimer();
				this.clearAbortConfirmTimer();
				this.stopPopoverCountdownTimer();
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
			tabindex: -1,
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

		const chrome = createEngineeringChromeDom(this.bodyEl, this.viewportEl, this._store, {
			onChromePointerDown: () => this.popovers?.close(),
			onSwitchViewMode: (mode, side) => this.switchViewMode(mode, side),
			onToggleSplit: () => this.switchViewMode(this.viewMode === 'orchestration' ? 'mission' : 'orchestration', true),
			onTogglePause: () => void this.handleToggleOrchestrationPause(),
			onAbortAll: () => void this.handleAbortAllOrchestrationTokens(),
			onToggleMinimap: () => {
				this.minimap?.setUserVisible(!this.minimap.isUserVisible());
				this.updateConsoleBar();
			},
			onSearchInput: () => this.updateCanvasSearchResults(true),
			onSearchStep: delta => this.stepCanvasSearchMatch(delta),
			onSearchClose: () => this.closeCanvasSearch(true),
			onBatchDelete: () => this.deleteSelectedItems(),
			onClearSelection: () => this.selectNode(undefined),
			onAlertOpenFile: () => this.toggleFileDrawer(true),
			onAlertDismiss: () => this.hideCanvasAlert(),
		});
		this.consoleBarEl = chrome.consoleBarEl;
		this.viewOrchBtnEl = chrome.viewOrchBtnEl;
		this.viewMissionBtnEl = chrome.viewMissionBtnEl;
		this.consoleTokensEl = chrome.consoleTokensEl;
		this.consoleSpendEl = chrome.consoleSpendEl;
		this.consolePauseBtnEl = chrome.consolePauseBtnEl;
		this.consoleAbortBtnEl = chrome.consoleAbortBtnEl;
		this.consoleMinimapBtnEl = chrome.consoleMinimapBtnEl;
		this.searchBarEl = chrome.searchBarEl;
		this.searchInputEl = chrome.searchInputEl;
		this.searchCountEl = chrome.searchCountEl;
		this.selectionHudEl = chrome.selectionHudEl;
		this.selectionHudLabelEl = chrome.selectionHudLabelEl;
		this.canvasAlertEl = chrome.canvasAlertEl;
		this.canvasAlertIconEl = chrome.canvasAlertIconEl;
		this.canvasAlertTextEl = chrome.canvasAlertTextEl;
		this.canvasAlertOpenFileBtn = chrome.canvasAlertOpenFileBtn;
		this.emptyHintEl = chrome.emptyHintEl;
		this.emptyHintTitleEl = chrome.emptyHintTitleEl;
		this.emptyHintSubEl = chrome.emptyHintSubEl;
		this.syncEmptyHintCopy();

		// Interactive Bottom-Right Minimap Overview for Large Topologies
		this.minimap = this._register(new AdeMissionMinimap(this.bodyEl, {
			onNavigateToWorldCenter: (worldX, worldY) => this.centerViewportOnWorldPoint(worldX, worldY),
		}));

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
				onOpenMissionTaskPopover: (node, anchorEl, opts) => {
					this.openMissionTaskPopover(node, anchorEl, opts);
				},
				onOpenWhiteboardPopover: (whiteboard, anchorEl, opts) => {
					this.openWhiteboardPopover(whiteboard, anchorEl, opts);
				},
				onOpenOrchestrationTokenPopover: (staffLabel, token, anchorEl, opts) => {
					this.openOrchestrationTokenPopover(staffLabel, token, anchorEl, opts);
				},
				onJumpToOrchestrationStaff: (staffNodeId, opts) => {
					this.jumpToCrossViewNode('orchestration', staffNodeId, opts);
				},
				onJumpToMissionTask: taskNodeId => {
					this.jumpToCrossViewNode('mission', taskNodeId);
				},
				onJumpToWhiteboard: (whiteboardId, opts) => {
					this.jumpToWhiteboardNode(whiteboardId, opts?.initialSection);
				},
				getEffectiveNodeChecksCount: nodeId => {
					const rec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
					const storedChecks = rec?.nodeChecks?.[nodeId];
					if (storedChecks && storedChecks.length > 0) {
						return storedChecks.filter(c => c.enabled !== false).length;
					}
					const mNode = this.nodes.find(n => n.id === nodeId);
					return mNode?.checks ? mNode.checks.filter(c => c.enabled !== false).length : 0;
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
					if (this.isDraggingNode) {
						this.pendingResyncAfterDrag = true;
						return;
					}
					this.syncGraphDom();
					if (prewarmHosts) {
						this.prewarmHosts();
					}
				},
				onRuntimeControlsInvalidated: () => {
					if (this.isPaneDisposed) {
						return;
					}
					if (this.isDraggingNode) {
						this.pendingResyncAfterDrag = true;
						return;
					}
					this.syncGraphDom();
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
			return oNode ? getRenderedOrchestrationNodeSize(oNode) : { width: 344, height: 188 };
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

	private resyncFromMissionStore(): void {
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
				this.fileDrawer?.setCodeValue(this.mermaidText, false);
				this.parseAndRenderMissionGraph(this.mermaidText);
			} else {
				this.syncAllNodePromptViews(this.activePromptEditSource);
				const statusFp = computeMissionTaskStatusesFingerprint(latest, this.getActiveOrchestrationRuntime());
				if (statusFp !== this.lastTaskStatusFingerprint) {
					this.lastTaskStatusFingerprint = statusFp;
					this.syncGraphDom();
					this.fileDrawer?.syncTaskDescriptionsPane(true);
				}
			}
		} else {
			const latestOrch = latest.orchestrationText ?? '';
			if (latestOrch !== this.orchestrationText) {
				this.orchestrationText = latestOrch;
				this.fileDrawer?.setCodeValue(this.orchestrationText, false);
				this.parseAndRenderOrchestrationGraph(this.orchestrationText);
			} else {
				const auxFp = computeOrchestrationAuxiliaryFingerprint(latest, this.getActiveOrchestrationRuntime());
				if (auxFp !== this.lastOrchAuxiliaryFingerprint) {
					this.lastOrchAuxiliaryFingerprint = auxFp;
					this.syncGraphDom();
				}
			}
		}
	}

	private replayDeferredStoreResync(): void {
		if (!this.pendingResyncAfterDrag || this.isPaneDisposed || this.isDraggingNode) {
			return;
		}
		this.pendingResyncAfterDrag = false;
		this.resyncFromMissionStore();
		this.syncGraphDom();
	}

	private emitCrossViewLinkHint(sourceNodeIds: readonly string[], kind: 'hover' | 'select'): void {
		if (!this.activeMissionId || !this.adeEditorService?.fireCrossViewLinkHint) {
			return;
		}
		const rec = this.missionService?.getMission(this.activeMissionId);
		const linkedIds = sourceNodeIds.length > 0
			? resolveCrossViewLinkedNodeIds(rec, this.viewMode, sourceNodeIds, this.orchNodes, this.nodes)
			: [];
		this.adeEditorService.fireCrossViewLinkHint({
			missionId: this.activeMissionId,
			sourceView: this.viewMode,
			nodeIds: linkedIds,
			kind,
		});
	}

	private applyCrossViewLinkHighlights(): void {
		const activeSet = new Set<string>([...this.crossViewHoverIds, ...this.crossViewSelectIds, ...this.focusHighlightIds]);
		this.renderer?.setCrossViewLinkedNodeIds?.(activeSet.size > 0 ? activeSet : undefined);
	}

	setHoveredNode(nodeId: string | undefined): void {
		if (!this.renderer || this.renderer.getHoveredNodeId() === nodeId) {
			return;
		}
		const compatNodes: readonly IMissionDagNode[] = this.viewMode === 'orchestration'
			? this.orchNodes.map(n => ({
				id: n.id,
				label: n.label,
				kind: 'task' as const,
				department: n.department,
				employeeName: n.employeeName,
				employeeKey: n.employeeKey,
			}))
			: this.nodes;
		this.renderer.applyHoverHighlight(nodeId, compatNodes, this.positions);
		this.emitCrossViewLinkHint(nodeId ? [nodeId] : [], 'hover');
	}

	fitGraphToViewport(): void {
		const ids = this.getActiveNodeIds();
		if (!this.viewportEl || (ids.length === 0 && (this.viewMode !== 'orchestration' || this.orchDepartments.length === 0))) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		if (rect.width < 40 || rect.height < 40) {
			return;
		}
		const bounds = computeGraphWorldBounds(
			this.viewMode,
			ids,
			this.positions,
			id => this.getNodeDimensions(id),
			this.orchDepartments,
			this.viewMode === 'orchestration' ? this.renderer?.getLastDepartmentBounds?.() : undefined,
		);
		if (!bounds) {
			return;
		}
		this.cancelCameraAnimation();
		const padX = 72;
		const padTop = 80;
		const padBottom = 60;
		const availW = Math.max(120, rect.width - padX * 2);
		const availH = Math.max(120, rect.height - padTop - padBottom);
		const graphW = Math.max(1, bounds.maxX - bounds.minX);
		const graphH = Math.max(1, bounds.maxY - bounds.minY);
		this.zoom = Math.round(Math.min(1, Math.max(MIN_ZOOM, Math.min(availW / graphW, availH / graphH))) * 100) / 100;
		const centerX = (bounds.minX + bounds.maxX) / 2;
		const centerY = (bounds.minY + bounds.maxY) / 2;
		this.panX = Math.round((padX + availW / 2) - centerX * this.zoom);
		this.panY = Math.round((padTop + availH / 2) - centerY * this.zoom);
		this.applyWorldTransformNow();
	}

	focusNode(
		nodeId: string,
		options?: Omit<IAdePendingMissionNodeFocus, 'nodeId'>,
	): void {
		if (this.isPaneDisposed || !nodeId) {
			return;
		}
		if (this.fileDrawer?.isOpen()) {
			this.fileDrawer.toggle(false);
		}
		this.popovers?.close();
		if (!this.getActiveNodeIds().includes(nodeId)) {
			if (this.activeMissionId && this.adeEditorService?.openEngineering) {
				const rec = this.missionService?.getMission(this.activeMissionId);
				const inferred = inferEngineeringViewModeForNode(rec, nodeId, this.viewMode);
				if (inferred !== this.viewMode) {
					void this.adeEditorService.openEngineering(this.activeMissionId, {
						viewMode: inferred,
						focusNodeId: nodeId,
						focusTokenId: options?.focusTokenId,
						highlightNodeIds: options?.highlightNodeIds,
						openPopover: options?.openPopover,
						whiteboardSection: options?.whiteboardSection,
						inspectorTab: options?.inspectorTab,
						openAgentBeside: options?.openAgentBeside,
						preferExistingGroup: true,
					});
				}
			}
			return;
		}
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		this.selectedNodeIds = new Set([nodeId]);
		this.focusHighlightIds = new Set((options?.highlightNodeIds ?? []).filter(id => id !== nodeId));
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.applyCrossViewLinkHighlights();
		this.syncSelectionHud();
		this.emitCrossViewLinkHint([nodeId, ...this.focusHighlightIds], 'select');
		const willOpenPopover = Boolean(
			options?.openPopover
			|| (this.viewMode === 'orchestration' && (options?.whiteboardSection || options?.focusTokenId)),
		);
		this.centerViewportOnNode(nodeId, { smooth: !willOpenPopover, pulseMs: 2400 });

		if (this.viewMode === 'orchestration') {
			if (options?.openPopover === 'whiteboard' || options?.whiteboardSection) {
				this.openWhiteboardById(nodeId, options?.whiteboardSection);
			} else if (options?.openPopover === 'token' || options?.focusTokenId) {
				const orch = this.getActiveOrchestrationRuntime();
				const targetTok = (options?.focusTokenId ? orch?.tokens?.[options.focusTokenId] : undefined)
					?? Object.values(orch?.tokens ?? {}).find(t => t.nodeId === nodeId && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join'));
				const oNode = this.orchNodes.find(n => n.id === nodeId);
				if (targetTok && oNode) {
					const anchor = this.findWorldAnchorByAttr('data-node-id', nodeId, 'ade-mission-token-puck')
						?? this.findWorldAnchorByAttr('data-node-id', nodeId)
						?? this.viewportEl;
					this.openOrchestrationTokenPopover(oNode.label, targetTok, anchor, { staffNodeId: nodeId });
				}
			}
			if (options?.openAgentBeside && this.adeEditorService) {
				const linkedAgent = this.buildOrchestrationAgentMap().get(nodeId);
				if (linkedAgent) {
					void this.adeEditorService.openAgent(linkedAgent.id, { side: true });
				}
			}
		} else if (options?.openPopover === 'task') {
			const mNode = this.nodes.find(n => n.id === nodeId);
			if (mNode) {
				const anchor = this.findWorldAnchorByAttr('data-node-id', nodeId) ?? this.viewportEl;
				this.openMissionTaskPopover(mNode, anchor);
			}
		}
	}

	protected jumpToCrossViewNode(
		targetView: AdeEngineeringViewMode,
		nodeId: string,
		options?: {
			readonly focusTokenId?: string;
			readonly openPopover?: 'task' | 'token' | 'whiteboard';
			readonly whiteboardSection?: string;
		},
	): void {
		const missionId = this.activeMissionId;
		if (!missionId || !nodeId) {
			return;
		}
		if (targetView === this.viewMode && this.getActiveNodeIds().includes(nodeId)) {
			this.focusNode(nodeId, options);
			return;
		}
		void this.adeEditorService?.openEngineering?.(missionId, {
			viewMode: targetView,
			focusNodeId: nodeId,
			focusTokenId: options?.focusTokenId,
			openPopover: options?.openPopover,
			whiteboardSection: options?.whiteboardSection,
			preferExistingGroup: true,
		});
	}

	protected jumpToWhiteboardNode(whiteboardId: string, initialSection?: string): void {
		this.jumpToCrossViewNode('orchestration', whiteboardId, {
			openPopover: 'whiteboard',
			whiteboardSection: initialSection,
		});
	}

	protected async handleRunMissionTaskChecks(nodeId: string): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const wasOpenForNode = Boolean(this.popovers?.isOpen() && this.openMissionTaskPopoverNodeId === nodeId);
		const res = await this.missionRuntimeService.runNodeChecks(missionId, nodeId);
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		this.syncGraphDom();
		this.fileDrawer?.syncTaskDescriptionsPane(true);
		const passed = Boolean(res?.passed);
		const msg = passed
			? adeBi(localize('adeMissionChecksRunPass', "Deterministic checks passed for {0}.", nodeId), '任务 {0} 确定性校验已通过。', nodeId)
			: (res?.summary || adeBi(localize('adeMissionChecksRunFail', "Deterministic checks failed for {0}.", nodeId), '任务 {0} 确定性校验未通过。', nodeId));
		this.reportFeedback(msg, passed ? 'ok' : 'error');
		if (wasOpenForNode && this.viewMode === 'mission' && this.popovers?.isOpen()) {
			const mNode = this.nodes.find(n => n.id === nodeId);
			if (mNode) {
				const anchor = this.findWorldAnchorByAttr('data-node-id', nodeId) ?? this.viewportEl;
				this.openMissionTaskPopover(mNode, anchor, { focusSection: 'checks' });
			}
		}
	}

	// =========================================================================
	// Mission View: Task Details Popover & Status Authority
	// =========================================================================

	private openMissionTaskPopover(
		node: IMissionDagNode,
		anchorEl: HTMLElement,
		opts?: { readonly focusSection?: 'contract' | 'checks' },
	): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		this.openMissionTaskPopoverNodeId = node.id;
		this.fileDrawer.setSelectedTaskNodeId(node.id);
		const missionRec = this.missionService?.getMission(missionId);
		const statusRec = missionRec?.taskStatuses?.[node.id];
		const orchRuntime = this.getActiveOrchestrationRuntime();
		const parsedOrchNodes = this.orchNodes.length > 0
			? this.orchNodes
			: (missionRec?.orchestrationText ? parseOrchestrationGraph(missionRec.orchestrationText).nodes : []);
		const resolved = resolveTaskAssigneeAndTokens(node, statusRec, orchRuntime, parsedOrchNodes);
		const effectiveChecks = missionRec?.nodeChecks?.[node.id] ?? node.checks;
		this.popovers.openMissionTaskEditorPopover(missionId, node, statusRec, anchorEl, {
			onRenameTask: nextTitle => this.renameVisualNode(node.id, nextTitle),
			onChangeDescription: nextDesc => this.commitNodePromptEdit(missionId, node.id, nextDesc, 'popover'),
			onSetTaskStatus: nextStatus => this.handleSetMissionTaskStatusResult(node.id, nextStatus),
			onChangeColor: nextColor => this.setNodeColorVisual(node.id, nextColor),
		}, {
			completionContract: node.completionContract,
			statusRecord: statusRec,
			nodeChecks: effectiveChecks,
			activeTokens: resolved.activeTokens,
			assigneeNodeId: resolved.assigneeNodeId,
			assigneeLabel: resolved.assigneeLabel,
			focusSection: opts?.focusSection,
			onRunChecks: this.missionRuntimeService ? () => this.handleRunMissionTaskChecks(node.id) : undefined,
			onJumpToStaff: (staffNodeId, focusTokenId) => this.jumpToCrossViewNode('orchestration', staffNodeId, {
				focusTokenId,
				openPopover: focusTokenId ? 'token' : undefined,
			}),
			onJumpToWhiteboard: wbId => this.jumpToWhiteboardNode(wbId),
			onReadPointer: ptr => this.readPointerContentText(ptr),
		});
	}

	private handleSetMissionTaskStatusResult(nodeId: string, nextStatus: MissionTaskStatus): { readonly ok: boolean; readonly error?: string; readonly unmetRequirements?: readonly string[] } {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return { ok: false, error: 'No active mission.' };
		}
		if (this.missionRuntimeService) {
			const res = this.missionRuntimeService.setMissionTaskStatus(missionId, {
				nodeId,
				status: nextStatus,
				caller: { isHumanUser: true, callerLabel: 'Human' },
			});
			if (!res.ok) {
				if (res.error) {
					this.reportFeedback(res.error, 'error');
				}
				return {
					ok: false,
					error: res.error,
					unmetRequirements: (res as { readonly unmetRequirements?: readonly string[] }).unmetRequirements,
				};
			}
		} else if (this.missionService) {
			const rec = this.missionService.getMission(missionId);
			const orgConfig = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
			const parsedTaskDag = parseMissionMermaidDag(this.mermaidText);
			const hasConfiguredChecks = Boolean((rec?.nodeChecks?.[nodeId] ?? []).some(c => c.enabled !== false));
			const trans = updateMissionTaskNodeStatus(
				rec?.taskStatuses ?? {},
				parsedTaskDag,
				orgConfig,
				{
					nodeId,
					status: nextStatus,
					hasConfiguredChecks,
					caller: { isHumanUser: true, callerLabel: 'Human' },
				},
			);
			if (!trans.ok) {
				const err = trans.error ?? 'Failed to update task status.';
				this.reportFeedback(err, 'error');
				return {
					ok: false,
					error: err,
					unmetRequirements: (trans as { readonly unmetRequirements?: readonly string[] }).unmetRequirements,
				};
			}
			this.missionService.updateTaskStatuses(missionId, trans.taskStatuses);
		}
		this.syncGraphDom();
		this.fileDrawer.syncTaskDescriptionsPane(true);
		return { ok: true };
	}

	private handleSetMissionTaskStatus(nodeId: string, nextStatus: MissionTaskStatus): boolean {
		return this.handleSetMissionTaskStatusResult(nodeId, nextStatus).ok;
	}

	// =========================================================================
	// Orchestration View: Whiteboards, Staff Creation, Token Baton & Dispatch
	// =========================================================================

	private openWhiteboardPopover(
		whiteboard: IOrchestrationWhiteboard,
		anchorEl: HTMLElement,
		opts?: { readonly initialSection?: string },
	): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		this.openMissionTaskPopoverNodeId = undefined;
		const liveWb = this.getActiveWhiteboards()[whiteboard.id] ?? whiteboard;
		const wbGraphNode = this.orchNodes.find(n => n.id === liveWb.id);
		this.popovers.openWhiteboardEditorPopover(liveWb, anchorEl, patch => {
			const saved = this.graphActions.saveWhiteboardPatch(missionId, liveWb, patch);
			if (!saved.ok) {
				return;
			}
			if (saved.codeChanged || patch.title !== liveWb.title || patch.department !== liveWb.department) {
				this.parseAndRenderOrchestrationGraph(this.orchestrationText, false);
			} else {
				this.syncGraphDom();
			}
			this.reportFeedback(adeBi(localize('adeOrchWbSavedOk', "Saved whiteboard '{0}'.", patch.title), '已保存部门白板「{0}」。', patch.title), 'ok');
		}, {
			currentColor: wbGraphNode?.color,
			onChangeColor: nextColor => this.setNodeColorVisual(liveWb.id, nextColor),
			initialSection: opts?.initialSection,
			updatedByLabel: liveWb.updatedByLabel,
			updatedAt: liveWb.updatedAt,
			getLatestVersion: () => this.getActiveWhiteboards()[liveWb.id]?.version,
			getLatestWhiteboard: () => this.getActiveWhiteboards()[liveWb.id],
		});
	}

	private findDescendantByClass(root: HTMLElement, className: string): HTMLElement | undefined {
		const queue: Element[] = Array.from(root.children);
		for (let i = 0; i < queue.length; i++) {
			const el = queue[i];
			if (isHTMLElement(el) && el.classList.contains(className)) {
				return el;
			}
			for (let j = 0; j < el.children.length; j++) {
				queue.push(el.children[j]);
			}
		}
		return undefined;
	}

	private findWorldAnchorByAttr(attrName: string, attrValue: string, descendantClass?: string): HTMLElement | undefined {
		const queue: Element[] = Array.from(this.worldEl.children);
		for (let i = 0; i < queue.length; i++) {
			const el = queue[i];
			if (isHTMLElement(el) && el.getAttribute(attrName) === attrValue) {
				return descendantClass ? (this.findDescendantByClass(el, descendantClass) ?? el) : el;
			}
			for (let j = 0; j < el.children.length; j++) {
				queue.push(el.children[j]);
			}
		}
		return undefined;
	}

	private openWhiteboardById(whiteboardId: string, initialSection?: string): void {
		const wb = this.getActiveWhiteboards()[whiteboardId];
		if (!wb) {
			return;
		}
		const anchor = this.findWorldAnchorByAttr('data-whiteboard-id', whiteboardId) ?? this.viewportEl;
		this.openWhiteboardPopover(wb, anchor, initialSection ? { initialSection } : undefined);
	}

	private readPointerSync(ptr: string, tokenId?: string): { readonly title?: string; readonly kind?: string; readonly content?: string; readonly error?: string } | undefined {
		const missionId = this.activeMissionId;
		if (missionId && this.missionRuntimeService) {
			const res = this.missionRuntimeService.readOrchestrationTokenPointers(missionId, {
				ptrs: [ptr],
				tokenId,
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
	}

	private async readPointerContentText(ptr: string, tokenId?: string): Promise<string> {
		const syncItem = this.readPointerSync(ptr, tokenId);
		if (syncItem?.content !== undefined) {
			return syncItem.content;
		}
		if (this.activeMissionId && this.missionRuntimeService?.readOrchestrationTokenPointersAsync) {
			const res = await this.missionRuntimeService.readOrchestrationTokenPointersAsync(this.activeMissionId, {
				ptrs: [ptr],
				tokenId,
				caller: { isHumanUser: true },
			});
			const item = res.items[0];
			if (item?.content !== undefined) {
				return item.content;
			}
			return item?.error ?? '';
		}
		return syncItem?.error ?? '';
	}

	private stopPopoverCountdownTimer(): void {
		if (this.popoverCountdownTimer !== undefined && this.rootEl) {
			getWindow(this.rootEl).clearInterval(this.popoverCountdownTimer);
			this.popoverCountdownTimer = undefined;
		}
	}

	private ensurePopoverCountdownTimer(): void {
		if (this.popoverCountdownTimer !== undefined || !this.rootEl) {
			return;
		}
		const win = getWindow(this.rootEl);
		this.popoverCountdownTimer = win.setInterval(() => {
			if (this.isPaneDisposed || !this.popovers?.isOpen()) {
				this.stopPopoverCountdownTimer();
				return;
			}
			if (!this.isEditorTabVisible) {
				return;
			}
			this.popovers.patchOpenTokenCountdown(this.getEffectiveRuntimeState(), Date.now(), this.getActiveOrchestrationRuntime());
		}, 1000);
	}

	private openOrchestrationTokenPopover(
		staffLabel: string,
		token: IOrchestrationToken,
		anchorEl: HTMLElement,
		opts?: { readonly focusSection?: 'barrier' | 'scope' | 'rework'; readonly staffNodeId?: string },
	): void {
		this.openMissionTaskPopoverNodeId = undefined;
		const missionId = this.activeMissionId;
		const orch = this.getActiveOrchestrationRuntime();
		const targetNodeId = opts?.staffNodeId ?? token.nodeId;
		const allStaffTokens = orch
			? Object.values(orch.tokens).filter(t => t.nodeId === targetNodeId && (t.status === 'active' || t.status === 'blocked' || t.status === 'waiting_join'))
			: [token];
		const resolveDelta = (tok: IOrchestrationToken) => (missionId ? this.missionRuntimeService?.getOrchestrationTokenDelta(missionId, tok.id) : undefined)
			?? (orch ? buildOrchestrationTokenDeltaView(orch, tok, this.getActiveWhiteboards()) : undefined);
		const joinBarrier = token.joinBarrierId ? orch?.joinBarriers?.[token.joinBarrierId] : undefined;
		this.popovers.openOrchestrationTokenPopover(staffLabel, token, anchorEl, {
			delta: resolveDelta(token),
			getDeltaForToken: resolveDelta,
			onOpenWhiteboard: wbId => this.openWhiteboardById(wbId),
			onReadPointer: (ptr, tokId) => this.readPointerSync(ptr, tokId ?? token.id),
			allStaffTokens: allStaffTokens.length > 0 ? allStaffTokens : [token],
			joinBarrier,
			joinBarriers: orch?.joinBarriers,
			onJumpToTask: taskNodeId => this.jumpToCrossViewNode('mission', taskNodeId),
			focusSection: opts?.focusSection,
		});
		this.ensurePopoverCountdownTimer();
	}

	private addOrchestrationStaffVisual(payload: {
		readonly name: string;
		readonly rankId: string;
		readonly tier: number;
		readonly department?: string;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		this.graphActions.addOrchestrationStaffVisual(payload);
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
		this.graphActions.addOrchestrationSubordinateVisual(parentNode, payload);
	}

	private addOrchestrationWhiteboardVisual(payload: {
		readonly department: string;
		readonly title: string;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		this.graphActions.addOrchestrationWhiteboardVisual(payload);
	}

	private clearAbortConfirmTimer(): void {
		if (this.abortConfirmTimer !== undefined) {
			const win = this.rootEl ? getWindow(this.rootEl) : undefined;
			win?.clearTimeout(this.abortConfirmTimer);
			this.abortConfirmTimer = undefined;
		}
		this.abortConfirmUntil = 0;
		this.abortConfirmMissionId = undefined;
	}

	private switchViewMode(targetMode: AdeEngineeringViewMode, side: boolean): void {
		const missionId = this.activeMissionId;
		if (!missionId || !this.adeEditorService?.openEngineering) {
			return;
		}
		if (!side && targetMode === this.viewMode) {
			return;
		}
		this.viewportMemory.save(missionId, this.viewMode, { panX: this.panX, panY: this.panY, zoom: this.zoom });
		void this.adeEditorService.openEngineering(missionId, { viewMode: targetMode, side, preferExistingGroup: true });
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
		if (now > this.abortConfirmUntil || this.abortConfirmMissionId !== missionId) {
			this.clearAbortConfirmTimer();
			this.abortConfirmUntil = now + 4000;
			this.abortConfirmMissionId = missionId;
			this.updateConsoleBar();
			if (this.rootEl) {
				this.abortConfirmTimer = getWindow(this.rootEl).setTimeout(() => {
					this.abortConfirmTimer = undefined;
					this.abortConfirmUntil = 0;
					this.abortConfirmMissionId = undefined;
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
		updateEngineeringConsoleBarDom({
			consoleBarEl: this.consoleBarEl,
			viewOrchBtnEl: this.viewOrchBtnEl,
			viewMissionBtnEl: this.viewMissionBtnEl,
			consoleTokensEl: this.consoleTokensEl,
			consoleSpendEl: this.consoleSpendEl,
			consolePauseBtnEl: this.consolePauseBtnEl,
			consoleAbortBtnEl: this.consoleAbortBtnEl,
			consoleMinimapBtnEl: this.consoleMinimapBtnEl,
		}, {
			hasMission: Boolean(this.activeMissionId),
			viewMode: this.viewMode,
			orch: this.getActiveOrchestrationRuntime(),
			runtimeState: this.getEffectiveRuntimeState(),
			hasRuntime: Boolean(this.missionRuntimeService),
			isConfirmingAbort: Date.now() <= this.abortConfirmUntil && this.abortConfirmMissionId === this.activeMissionId,
			minimapVisible: Boolean(this.minimap?.isUserVisible()),
		});
	}

	private centerViewportOnWorldPoint(worldX: number, worldY: number): void {
		if (!this.viewportEl) {
			return;
		}
		this.cancelCameraAnimation();
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
		const payload = buildMinimapSyncPayload(
			this.viewMode,
			this.orchNodes,
			this.orchEdges,
			this.nodes,
			this.edges,
			this.getActiveOrchestrationRuntime(),
			this.getActiveTaskStatuses(),
			{
				departmentBounds: this.viewMode === 'orchestration' ? this.renderer?.getLastDepartmentBounds?.() : undefined,
				orchConflictNodeIds: this.viewMode === 'orchestration' ? this.renderer?.getLastOrchConflictNodeIds?.() : undefined,
				dagDiagnostics: this.viewMode === 'mission' ? this.renderer?.getLastDagDiagnosticsSummary?.() : undefined,
			},
		);
		this.minimap.syncGraph(payload.nodes, payload.edges, this.positions, runtimeState, firstSelected, payload.options);
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

	private getCurrentHistoryKey(): string | undefined {
		return this.activeMissionId ? EngineeringHistoryStore.keyFor(this.activeMissionId, this.viewMode) : undefined;
	}

	private pushHistory(entry: IEngineeringHistoryEntry, coalesceMs = 0): void {
		const key = this.getCurrentHistoryKey();
		if (!key) {
			return;
		}
		this.historyStore.push(key, entry, coalesceMs);
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
			this.fileDrawer.setCodeValue(snapshot.codeText, true);
			this.missionService?.updateOrchestrationText(missionId, snapshot.codeText);
			this.parseAndRenderOrchestrationGraph(snapshot.codeText, false);
		} else {
			this.missionService?.clearNodePositions(missionId);
			if (Object.keys(snapshot.positions).length > 0) {
				this.missionService?.updateNodePositions(missionId, snapshot.positions);
			}
			this.mermaidText = snapshot.codeText;
			this.fileDrawer.setCodeValue(snapshot.codeText, true);
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
		const key = this.getCurrentHistoryKey();
		if (!key) {
			return;
		}
		const prev = this.historyStore.popUndo(key, label => this.captureHistorySnapshot(label));
		if (prev) {
			this.applyHistorySnapshot(prev, 'undo');
		}
	}

	private redoCanvasMutation(): void {
		const key = this.getCurrentHistoryKey();
		if (!key) {
			return;
		}
		const next = this.historyStore.popRedo(key, label => this.captureHistorySnapshot(label));
		if (next) {
			this.applyHistorySnapshot(next, 'redo');
		}
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
		this.graphActions.addMissionTaskVisual(worldPos);
	}

	private renameVisualNode(nodeId: string, nextLabel: string): void {
		this.graphActions.renameVisualNode(nodeId, nextLabel);
	}

	private deleteVisualNodes(nodeIds: readonly string[]): void {
		this.graphActions.deleteVisualNodes(nodeIds);
	}

	private renameVisualEdgeLabel(fromId: string, toId: string, nextLabel: string): void {
		this.graphActions.renameVisualEdgeLabel(fromId, toId, nextLabel);
	}

	private connectVisualEdge(fromId: string, toId: string, options?: { readonly fail?: boolean; readonly bidirectional?: boolean }): void {
		this.graphActions.connectVisualEdge(fromId, toId, options);
	}

	private deleteVisualEdge(fromId: string, toId: string): void {
		this.graphActions.deleteVisualEdge(fromId, toId);
	}

	private toggleOrchestrationEdgeBidirectional(fromId: string, toId: string): void {
		this.graphActions.toggleOrchestrationEdgeBidirectional(fromId, toId);
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
			this.popovers.openCanvasContextMenu(clientX, clientY, buildMissionNodeContextMenuItems(node, isDone, {
				onEditTask: () => {
					const el = this.findWorldAnchorByAttr('data-node-id', node.id) ?? this.viewportEl;
					this.openMissionTaskPopover(node, el);
				},
				onRename: () => this.renderer.startInlineNodeRename(node.id),
				onToggleComplete: () => { this.handleSetMissionTaskStatus(node.id, isDone ? 'pending' : 'completed'); },
				onDelete: () => this.deleteVisualNodes([node.id]),
			}), {
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
			this.popovers.openCanvasContextMenu(clientX, clientY, buildWhiteboardNodeContextMenuItems(node.id, {
				onEditWhiteboard: () => {
					const el = this.findWorldAnchorByAttr('data-node-id', oNode.id) ?? this.viewportEl;
					this.openWhiteboardPopover(wb, el);
				},
				onRename: () => this.renderer.startInlineNodeRename(node.id),
				onMoveToGroup: () => this.popovers.openMoveToGroupPopover(clientX, clientY, oNode.label, oNode.department, this.orchDepartments, targetGrp => {
					this.moveOrchestrationNodeToGroupVisual(oNode.id, targetGrp);
				}),
				onDelete: () => this.deleteVisualNodes([node.id]),
			}), {
				colorPicker: {
					currentColor: oNode.color,
					onSelectColor: nextColor => this.setNodeColorVisual(oNode.id, nextColor),
				},
			});
			return;
		}

		const linkedAgent = this.buildOrchestrationAgentMap().get(node.id);
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const items = buildStaffNodeContextMenuItems(node, oNode, linkedAgent, org, {
			canOpenChat: Boolean(this.adeEditorService),
			canResetSwitchEngine: Boolean(oNode && linkedAgent?.session && this.activeMissionId),
			onOpenChat: () => {
				if (linkedAgent) {
					void this.adeEditorService?.openAgent(linkedAgent.id);
				}
			},
			onResetSwitchEngine: () => {
				if (!this.activeMissionId || !oNode || !linkedAgent) {
					return;
				}
				const curEngineId = linkedAgent.session?.engineId ?? linkedAgent.preferredEngineId ?? oNode.engineId ?? 'aexus-claude';
				const anchor = this.findWorldAnchorByAttr('data-node-id', oNode.id, 'ade-mission-engine-pill')
					?? this.viewportEl;
				void this.popovers.openEnginePopover(this.activeMissionId, oNode.id, linkedAgent, curEngineId, anchor, {
					staffLabel: oNode.label,
					hostAlias: oNode.hostAlias,
				});
			},
			onCreateSubordinate: minTier => {
				if (!oNode) {
					return;
				}
				this.popovers.openAddStaffPopover(clientX, clientY, payload => {
					this.addOrchestrationSubordinateVisual(oNode, payload);
				}, {
					title: adeBi(localize('adeOrchSubTitle', "Create Subordinate under {0}", oNode.label), '在「{0}」下动态扩编下级', oNode.label),
					subtitle: adeBi(localize('adeOrchSubHint', "Auto-wires bidirectional <--> link so tokens can return."), '自动建立双向 <--> 通道，确保下级完成后可回传令牌'),
					submitLabel: adeBi(localize('adeOrchSubSubmit', "Create & Link <-->"), '创建并双向连线'),
					minTier,
					defaultDepartment: oNode.department,
				});
			},
			onDispatchRequirement: () => this.popovers.openDispatchRequirementPopover(clientX, clientY, node.label, req => {
				this.handleDispatchRequirement(req, node.id);
			}),
			onRename: () => this.renderer.startInlineNodeRename(node.id),
			onMoveToGroup: () => {
				if (!oNode) {
					return;
				}
				this.popovers.openMoveToGroupPopover(clientX, clientY, oNode.label, oNode.department, this.orchDepartments, targetGrp => {
					this.moveOrchestrationNodeToGroupVisual(oNode.id, targetGrp);
				});
			},
			onDelete: () => this.deleteVisualNodes([node.id]),
		});
		this.popovers.openCanvasContextMenu(clientX, clientY, items, {
			colorPicker: {
				currentColor: oNode?.color,
				onSelectColor: nextColor => this.setNodeColorVisual(node.id, nextColor),
			},
		});
	}

	private setNodeColorVisual(nodeId: string, color: string | null): void {
		this.graphActions.setNodeColorVisual(nodeId, color);
	}

	private addOrchestrationGroupVisual(name: string, worldPos?: IMissionNodePosition): void {
		this.graphActions.addOrchestrationGroupVisual(name, worldPos);
	}

	private renameOrchestrationGroupVisual(groupId: string, nextName: string): void {
		this.graphActions.renameOrchestrationGroupVisual(groupId, nextName);
	}

	private moveOrchestrationNodeToGroupVisual(nodeId: string, targetGroupIdOrName: string | undefined): void {
		this.graphActions.moveOrchestrationNodeToGroupVisual(nodeId, targetGroupIdOrName);
	}

	private removeOrchestrationGroupVisual(groupId: string, deleteMembers: boolean): void {
		this.graphActions.removeOrchestrationGroupVisual(groupId, deleteMembers);
	}

	private openGroupContextMenu(group: IOrchestrationDepartmentGroup, clientX: number, clientY: number): void {
		if (!this.activeMissionId || this.viewMode !== 'orchestration') {
			return;
		}
		const worldPos = this.clientToWorldPos(clientX, clientY);
		this.popovers.openCanvasContextMenu(clientX, clientY, buildGroupContextMenuItems(group, {
			onRenameGroup: () => this.renderer.startInlineGroupRename(group.id),
			onAddStaffToGroup: () => this.popovers.openAddStaffPopover(clientX, clientY, payload => {
				this.addOrchestrationStaffVisual({ ...payload, worldPos });
			}, { defaultDepartment: group.name }),
			onAddWbToGroup: () => this.popovers.openAddWhiteboardPopover(clientX, clientY, payload => {
				this.addOrchestrationWhiteboardVisual({ ...payload, worldPos });
			}, { defaultDepartment: group.name }),
			onUngroup: () => this.removeOrchestrationGroupVisual(group.id, false),
			onDeleteGroupMembers: () => this.removeOrchestrationGroupVisual(group.id, true),
		}));
	}

	private openEdgeContextMenu(edge: IMissionDagEdge, clientX: number, clientY: number): void {
		if (!this.activeMissionId) {
			return;
		}
		const hasReverse = this.viewMode === 'orchestration' && this.orchEdges.some(e => e.from === edge.to && e.to === edge.from);
		this.popovers.openCanvasContextMenu(clientX, clientY, buildEdgeContextMenuItems(this.viewMode, hasReverse, {
			onEditLabel: () => this.renderer.startInlineEdgeLabelEdit(edge.id),
			onToggleBidirectional: () => this.toggleOrchestrationEdgeBidirectional(edge.from, edge.to),
			onDeleteEdge: () => this.deleteVisualEdge(edge.from, edge.to),
		}));
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

		const storedPos = !forceAutoLayout && this.activeMissionId
			? (this.missionService?.getMission(this.activeMissionId)?.positions ?? {})
			: {};
		this.positions = resolveMissionLayoutPositions(parsed, storedPos, this.positions, forceAutoLayout, getMissionNodeSize);

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
		if (forceAutoLayout) {
			this.fitGraphToViewport();
		} else if (!hadNodesBefore) {
			this.restoreViewportOrFit();
		}
	}

	private restoreViewportOrFit(): void {
		this.cancelCameraAnimation();
		const saved = this.activeMissionId ? this.viewportMemory.get(this.activeMissionId, this.viewMode) : undefined;
		if (saved) {
			this.panX = saved.panX;
			this.panY = saved.panY;
			this.zoom = saved.zoom;
			this.applyWorldTransformNow();
			return;
		}
		this.fitGraphToViewport();
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

		const storedPos = !forceAutoLayout && this.activeMissionId
			? (this.missionService?.getMission(this.activeMissionId)?.orchestrationPositions ?? {})
			: {};
		this.positions = resolveOrchestrationLayoutPositions(parsed, this.orchLayoutMode, storedPos, this.positions, forceAutoLayout);

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
		if (forceAutoLayout) {
			this.fitGraphToViewport();
		} else if (!hadNodesBefore) {
			this.restoreViewportOrFit();
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
		const generatedEmployees = this.activeMissionId ? (this.missionService?.getGeneratedEmployees(this.activeMissionId) ?? []) : [];
		const missionRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		return buildOrchestrationAgentMap(
			this.activeMissionId,
			this.orchDirection,
			this.orchNodes,
			this.orchEdges,
			this.orchDepartments,
			generatedEmployees,
			missionRec,
			this.projectsService,
		);
	}

	private computeActiveProjectsFingerprint(agentByNodeId?: ReadonlyMap<string, IAdeAgent>): string {
		if (!this.activeMissionId || !this.projectsService) {
			return '';
		}
		return computeActiveProjectsFingerprint(this.activeMissionId, this.orchNodes, agentByNodeId ?? this.buildOrchestrationAgentMap());
	}

	private syncGraphDom(forceFullRebuild = false): void {
		if (!this.renderer) {
			return;
		}
		const missionRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const runtimeState = this.getEffectiveRuntimeState();
		const orchRuntime = this.getActiveOrchestrationRuntime();
		const ownerAgent = missionRec?.ownerSessionId ? this.projectsService?.getAgent(missionRec.ownerSessionId) : undefined;
		const fallbackOwnerEngineId = ownerAgent?.session?.engineId ?? ownerAgent?.preferredEngineId ?? 'aexus-claude';
		const agentByNodeId = this.viewMode === 'orchestration' ? this.buildOrchestrationAgentMap() : new Map<string, IAdeAgent>();
		if (this.viewMode === 'orchestration') {
			this.lastProjectsFingerprint = this.computeActiveProjectsFingerprint(agentByNodeId);
			this.lastOrchAuxiliaryFingerprint = computeOrchestrationAuxiliaryFingerprint(missionRec, orchRuntime);
		} else {
			this.lastTaskStatusFingerprint = computeMissionTaskStatusesFingerprint(missionRec, orchRuntime);
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
			orchestrationRuntime: orchRuntime,
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
		this.applyCrossViewLinkHighlights();
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
		return computeDefaultNewNodeWorldPos(this.getActiveNodeIds(), this.positions);
	}

	private handleEndNodesDrag(movedNodeIds: readonly string[], movedPx: number): void {
		const preSnap = this.preDragHistorySnapshot;
		this.preDragHistorySnapshot = undefined;
		const hadDeferredResync = this.pendingResyncAfterDrag;
		this.pendingResyncAfterDrag = false;
		this.flushEdgeReroute(movedNodeIds.length === 1 ? movedNodeIds[0] : undefined);
		try {
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
		} finally {
			this.isDraggingNode = false;
			this.pendingResyncAfterDrag = false;
		}
		if (hadDeferredResync) {
			this.pendingResyncAfterDrag = true;
			this.replayDeferredStoreResync();
		}
	}

	private selectNode(nodeId: string | undefined, options?: { readonly toggleMulti?: boolean }): void {
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		if (this.focusHighlightIds.size > 0) {
			this.focusHighlightIds.clear();
			this.applyCrossViewLinkHighlights();
		}
		if (!nodeId) {
			this.selectedNodeIds.clear();
			this.renderer?.setSelectedNodeIds([]);
			this.syncSelectionHud();
			this.emitCrossViewLinkHint([], 'select');
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
		this.emitCrossViewLinkHint([...this.selectedNodeIds], 'select');
	}

	private selectNodes(nodeIds: Iterable<string>, options?: { readonly additive?: boolean }): void {
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		if (this.focusHighlightIds.size > 0) {
			this.focusHighlightIds.clear();
			this.applyCrossViewLinkHighlights();
		}
		const next = options?.additive ? new Set(this.selectedNodeIds) : new Set<string>();
		for (const id of nodeIds) {
			next.add(id);
		}
		this.selectedNodeIds = next;
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.syncSelectionHud();
		this.emitCrossViewLinkHint([...this.selectedNodeIds], 'select');
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

	private closeCanvasSearch(restoreCanvasFocus = false, clearQuery = false): void {
		if (!this.searchBarEl) {
			return;
		}
		this.searchBarEl.hidden = true;
		this.syncHudLayoutClasses();
		this.searchMatchIds = [];
		this.searchActiveIdx = -1;
		if (clearQuery && this.searchInputEl) {
			this.searchInputEl.value = '';
		}
		if (this.searchCountEl) {
			this.searchCountEl.textContent = '';
		}
		this.renderer?.setSearchMatches(undefined, undefined);
		if (restoreCanvasFocus) {
			this.rootEl?.focus();
		}
	}

	private cancelCameraAnimation(): void {
		if (this.cameraAnimRafId !== undefined && this.rootEl) {
			getWindow(this.rootEl).cancelAnimationFrame(this.cameraAnimRafId);
			this.cameraAnimRafId = undefined;
		}
	}

	private centerViewportOnNode(nodeId: string, options?: { readonly smooth?: boolean; readonly pulseMs?: number }): void {
		const pos = this.positions.get(nodeId);
		if (!pos || !this.viewportEl) {
			return;
		}
		this.cancelCameraAnimation();
		const rect = this.viewportEl.getBoundingClientRect();
		const vpW = rect.width > 40 ? rect.width : 1080;
		const vpH = rect.height > 40 ? rect.height : 720;
		const targetZoom = this.zoom < 0.85 ? 0.85 : this.zoom;
		const targetPanX = Math.round(vpW / 2 - pos.x * targetZoom);
		const targetPanY = Math.round(vpH / 2 - pos.y * targetZoom);
		const pulseMs = options?.pulseMs ?? 1800;

		const win = getWindow(this.viewportEl);
		const reducedMotion = Boolean(
			this.rootEl?.classList.contains('ade-animations-paused')
			|| win.document.documentElement.classList.contains('ade-page-hidden')
			|| win.document.body.classList.contains('monaco-reduce-motion')
			|| win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
		);
		const dist = Math.hypot(targetPanX - this.panX, targetPanY - this.panY);
		if (!options?.smooth || reducedMotion || rect.width <= 40 || (dist < 8 && Math.abs(targetZoom - this.zoom) < 0.01)) {
			this.zoom = targetZoom;
			this.panX = targetPanX;
			this.panY = targetPanY;
			this.applyWorldTransformNow();
			this.renderer?.pulseFocusNode(nodeId, pulseMs);
			return;
		}

		const startPanX = this.panX;
		const startPanY = this.panY;
		const startZoom = this.zoom;
		const startTs = win.performance.now();
		const step = (now: number) => {
			if (this.isPaneDisposed) {
				this.cameraAnimRafId = undefined;
				return;
			}
			const t = Math.min(1, (now - startTs) / SMOOTH_CAMERA_GLIDE_MS);
			const ease = 1 - Math.pow(1 - t, 3);
			this.zoom = Math.round((startZoom + (targetZoom - startZoom) * ease) * 100) / 100;
			this.panX = startPanX + (targetPanX - startPanX) * ease;
			this.panY = startPanY + (targetPanY - startPanY) * ease;
			this.applyWorldTransformNow();
			if (t < 1) {
				this.cameraAnimRafId = win.requestAnimationFrame(step);
			} else {
				this.cameraAnimRafId = undefined;
				this.zoom = targetZoom;
				this.panX = targetPanX;
				this.panY = targetPanY;
				this.applyWorldTransformNow();
			}
		};
		this.cameraAnimRafId = win.requestAnimationFrame(step);
		this.renderer?.pulseFocusNode(nodeId, pulseMs);
	}

	private updateCanvasSearchResults(autoCenter = true): void {
		const rawQuery = this.searchInputEl?.value ?? '';
		if (!rawQuery.trim()) {
			this.searchMatchIds = [];
			this.searchActiveIdx = -1;
			if (this.searchCountEl) {
				this.searchCountEl.textContent = '';
			}
			this.renderer?.setSearchMatches(undefined, undefined);
			return;
		}
		const matches = findCanvasSearchMatches(
			rawQuery,
			this.viewMode,
			this.orchNodes,
			this.nodes,
			this.getActiveWhiteboards(),
			this.getActiveNodePrompts(),
		);
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
		this.cancelCameraAnimation();
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
		if (this.activeMissionId && this.getActiveNodeCount() > 0) {
			this.viewportMemory.save(this.activeMissionId, this.viewMode, { panX: this.panX, panY: this.panY, zoom: this.zoom });
		}
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

	private flushEdgeReroute(movedNodeId?: string): void {
		if (this.edgeRerouteRafId !== undefined && this.rootEl) {
			getWindow(this.rootEl).cancelAnimationFrame(this.edgeRerouteRafId);
			this.edgeRerouteRafId = undefined;
		}
		const targetNodeId = this.pendingDraggedMultipleNodes ? undefined : (movedNodeId ?? this.pendingDraggedNodeId);
		this.pendingDraggedNodeId = undefined;
		this.pendingDraggedMultipleNodes = false;
		const dir = this.viewMode === 'orchestration' ? this.orchDirection : this.direction;
		this.renderer?.updateEdgesSvg(this.nodes, this.edges, this.positions, targetNodeId ? { movedNodeId: targetNodeId, direction: dir } : { direction: dir });
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

	private isCanvasShortcutActive(): boolean {
		const doc = this.rootEl?.ownerDocument;
		const activeEl = doc?.activeElement as HTMLElement | null;
		const isMountedInWorkbenchGroup = Boolean(this.editorGroupsService?.mainPart?.groups?.includes(this.group));
		const isActiveWorkbenchPane = !isMountedInWorkbenchGroup
			|| (this.editorGroupsService?.activeGroup === this.group && (!this.group.activeEditor || this.group.activeEditor === this.input));
		const focusWithinCanvas = Boolean(activeEl && this.rootEl.contains(activeEl))
			|| ((!activeEl || activeEl === doc?.body) && isActiveWorkbenchPane);
		const isPaneDisplayed = Boolean(this.rootEl?.isConnected && (this.rootEl.offsetWidth > 0 || this.rootEl.offsetHeight > 0));
		return this.isEditorTabVisible && focusWithinCanvas && isPaneDisplayed && !this.isPaneDisposed && Boolean(this.activeMissionId);
	}

	private openBlankCanvasContextMenu(clientX: number, clientY: number): void {
		if (!this.activeMissionId) {
			return;
		}
		const worldPos = this.clientToWorldPos(clientX, clientY);
		const hasNodes = this.getActiveNodeCount() > 0;
		const topStaff = this.viewMode === 'orchestration'
			? findHighestRankStaffNode({
				direction: this.orchDirection,
				nodes: this.orchNodes,
				edges: this.orchEdges,
				departments: this.orchDepartments,
			})
			: undefined;
		this.popovers.openCanvasContextMenu(clientX, clientY, buildBlankCanvasContextMenuItems(this.viewMode, hasNodes, topStaff?.label, {
			onAddGroup: () => this.popovers.openAddGroupPopover(clientX, clientY, name => this.addOrchestrationGroupVisual(name, worldPos)),
			onAddStaff: () => this.popovers.openAddStaffPopover(clientX, clientY, payload => this.addOrchestrationStaffVisual({ ...payload, worldPos })),
			onAddWhiteboard: () => this.popovers.openAddWhiteboardPopover(clientX, clientY, payload => this.addOrchestrationWhiteboardVisual({ ...payload, worldPos })),
			onDispatchTopStaff: () => {
				if (topStaff) {
					this.popovers.openDispatchRequirementPopover(clientX, clientY, topStaff.label, req => this.handleDispatchRequirement(req, topStaff.id));
				}
			},
			onAddTask: () => this.addMissionTaskVisual(worldPos),
			onFitView: () => this.fitGraphToViewport(),
			onAutoLayout: () => this.resetToAutoLayout(),
		}));
	}

	private installCanvasInteractions(): void {
		installEngineeringCanvasInteractions(this._store, {
			rootEl: this.rootEl,
			viewportEl: this.viewportEl,
			marqueeBoxEl: this.marqueeBoxEl,
			searchBarEl: this.searchBarEl,
			searchInputEl: this.searchInputEl,
			minZoom: MIN_ZOOM,
			maxZoom: MAX_ZOOM,
			panClickThresholdPx: CANVAS_PAN_CLICK_THRESHOLD_PX,
			getPanZoom: () => ({ panX: this.panX, panY: this.panY, zoom: this.zoom }),
			setPanZoom: (panX, panY, zoom, immediate) => {
				this.panX = panX;
				this.panY = panY;
				this.zoom = zoom;
				if (immediate) {
					this.applyWorldTransformNow();
				} else {
					this.scheduleWorldTransform();
				}
			},
			cancelCameraAnimation: () => this.cancelCameraAnimation(),
			closePopovers: () => this.popovers.close(),
			isPopoverOpen: () => this.popovers.isOpen(),
			isFileDrawerOpen: () => this.fileDrawer.isOpen(),
			closeFileDrawer: () => this.fileDrawer.toggle(false),
			isCanvasShortcutActive: () => this.isCanvasShortcutActive(),
			getActiveNodeIds: () => this.getActiveNodeIds(),
			getNodePosition: id => this.positions.get(id),
			getNodeDimensions: id => this.getNodeDimensions(id),
			clientToWorldPos: (x, y) => this.clientToWorldPos(x, y),
			getSelectedNodeIds: () => this.selectedNodeIds,
			hasSelection: () => Boolean(this.selectedEdgeKey || this.selectedNodeIds.size > 0),
			previewSelectedNodeIds: ids => this.renderer?.setSelectedNodeIds(ids),
			selectNode: id => this.selectNode(id),
			selectNodes: (ids, opts) => this.selectNodes(ids, opts),
			clearEdgeSelection: () => this.selectEdge(undefined),
			openBlankCanvasContextMenu: (x, y) => this.openBlankCanvasContextMenu(x, y),
			openSearch: () => this.openCanvasSearch(),
			closeSearch: restore => this.closeCanvasSearch(restore),
			undo: () => this.undoCanvasMutation(),
			redo: () => this.redoCanvasMutation(),
			deleteSelected: () => this.deleteSelectedItems(),
			syncAnimationPauseState: () => this.syncAnimationPauseState(),
		});
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		this.isEditorTabVisible = visible;
		this.syncAnimationPauseState();
	}

	private resetTransientCanvasState(): void {
		this.cancelScheduledFrames();
		this.hideCanvasAlert();
		this.clearAbortConfirmTimer();
		this.isDraggingNode = false;
		this.pendingResyncAfterDrag = false;
		this.preDragHistorySnapshot = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.crossViewHoverIds.clear();
		this.crossViewSelectIds.clear();
		this.focusHighlightIds.clear();
		this.openMissionTaskPopoverNodeId = undefined;
		this.syncSelectionHud();
		this.closeCanvasSearch(false, true);
		this.fileDrawer?.clearParseTimer();
		this.stopPopoverCountdownTimer();
		this.popovers?.close();
		this.setHoveredNode(undefined);
		this.renderer?.setSelectedNodeIds([]);
		this.renderer?.setSelectedEdgeKey(undefined);
		this.renderer?.setTraceHighlightEdges(undefined);
		this.renderer?.resetTransitTracking();
	}

	override async setInput(input: AdeEngineeringEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		this.fileDrawer?.flushPendingCodeDraft();
		if (this.activeMissionId && this.getActiveNodeCount() > 0) {
			this.viewportMemory.save(this.activeMissionId, this.viewMode, { panX: this.panX, panY: this.panY, zoom: this.zoom });
		}
		this.emitCrossViewLinkHint([], 'hover');
		this.emitCrossViewLinkHint([], 'select');
		await super.setInput(input, options, context, token);
		this.resetTransientCanvasState();
		this.fileDrawer.toggle(false);

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
			this.fileDrawer.setCodeValue(this.orchestrationText, true);
			this.parseAndRenderOrchestrationGraph(this.orchestrationText);
			if (this.orchNodes.length === 0) {
				this.syncGraphDom(true);
			}
		} else {
			this.fileDrawer.setCodeValue(this.mermaidText, true);
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
				focusTokenId: pendingFocus.focusTokenId,
				highlightNodeIds: pendingFocus.highlightNodeIds,
				openPopover: pendingFocus.openPopover,
				whiteboardSection: pendingFocus.whiteboardSection,
				inspectorTab: pendingFocus.inspectorTab,
				openAgentBeside: pendingFocus.openAgentBeside,
			});
		}
	}

	override clearInput(): void {
		this.fileDrawer?.flushPendingCodeDraft();
		if (this.activeMissionId && this.getActiveNodeCount() > 0) {
			this.viewportMemory.save(this.activeMissionId, this.viewMode, { panX: this.panX, panY: this.panY, zoom: this.zoom });
		}
		this.emitCrossViewLinkHint([], 'hover');
		this.emitCrossViewLinkHint([], 'select');
		this.resetTransientCanvasState();
		this.syncHudLayoutClasses();
		this.activeMissionId = undefined;
		this.updateConsoleBar();
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
