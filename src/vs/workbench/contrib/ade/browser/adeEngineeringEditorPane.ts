/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, Dimension, EventType, isHTMLElement } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import { IAdeControlCenterService } from '../../../../platform/ade/common/adeControlCenterIpc.js';
import {
	AdeLayoutDirection,
	canonicalEdgePairKey,
	IAdeAgentNode,
	IAdeProjectSnapshot,
	IAdeWhiteboard,
} from '../../../../platform/ade/common/adeModels.js';
import {
	buildProjectOrchestrationGraph,
	computeOrchestrationLayoutPositions,
	IMissionNodePosition,
	IOrchestrationGraphEdge,
	IOrchestrationGraphNode,
	OrchestrationDirection,
	OrchestrationLayoutMode,
} from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService, ServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import {
	ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID,
	buildAdeProjectEditorUri,
	IAdeAgent,
	IAdeEditorService,
	IAdeProjectsService,
	parseAdeProjectEditorUri,
} from '../common/ade.js';
import { adeBi, onDidChangeAdeLocale } from '../common/adeLocalization.js';
import {
	AdeProjectContextUsageTracker,
	IAdeAgentContextUsage,
} from './adeContextUsageTracker.js';
import { AdeEdgeTicketHistoryPopover } from './adeEdgeTicketHistoryPopover.js';
import { AdeEngineeringGraphActions } from './adeEngineeringGraphActions.js';
import {
	AdePageVisibilityAnimationGuard,
	buildBlankCanvasContextMenuItems,
	buildDepartmentContextMenuItems,
	buildMinimapSyncPayload,
	buildStaffNodeContextMenuItems,
	buildWhiteboardNodeContextMenuItems,
	computeGraphWorldBounds,
	EngineeringHistoryStore,
	EngineeringViewportMemory,
	findCanvasSearchMatches,
	IAdePendingMissionNodeFocus,
	IInstalledCanvasInteractions,
	installEngineeringCanvasInteractions,
	onDidRestoreAdePageVisibility,
} from './adeEngineeringViewLinkage.js';
import {
	ADE_CARD_INTERACTIVE_SELECTOR,
	AdeMissionCanvasRenderer,
	getMissionNodeSize,
	getRenderedOrchestrationNodeSize,
} from './adeMissionCanvasRenderer.js';
import {
	AdeMissionHostCatalog,
	MISSION_ENGINE_DEFAULT_MODELS,
	toPrefixedAdeEngineId,
} from './adeMissionHostCatalog.js';
import { AdeMissionMinimap } from './adeMissionMinimap.js';
import { AdeMissionPopovers } from './adeMissionPopovers.js';
import { IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import { AdeWhiteboardPopover } from './adeWhiteboardPopover.js';
import './media/adeMissionCanvas.css';
import './media/adeMissionEdges.css';
import './media/adeMissionCards.css';
import './media/adeMissionOverlays.css';

export { AdePageVisibilityAnimationGuard, getMissionNodeSize, getRenderedOrchestrationNodeSize };
export type { IAdePendingMissionNodeFocus };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

const sharedViewportMemory = new EngineeringViewportMemory();
const sharedHistoryStore = new EngineeringHistoryStore();

function normalizeProjectIdInput(raw: string): string {
	const trimmed = String(raw || '').trim();
	if (trimmed.startsWith('ade-project://')) {
		try {
			return parseAdeProjectEditorUri(URI.parse(trimmed)) ?? trimmed;
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

/**
 * Project Orchestration Canvas EditorInput (`plan.md` §8.1.3):
 * - Keyed uniquely by `ade-project://${projectId}`.
 * - Enables `EditorInputCapabilities.CanSplitInGroup` (without `Singleton`) so two Project canvases
 *   or split views of the same Project canvas can be compared side-by-side.
 */
export class AdeEngineeringEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeEngineering';

	readonly projectId: string;
	override readonly resource: URI;
	private pendingFocus: IAdePendingMissionNodeFocus | undefined;

	constructor(
		rawProjectId: string,
		@IAdeProjectsService private readonly projects?: IAdeProjectsService,
		@IInstantiationService instantiationService?: IInstantiationService,
	) {
		super();
		this.projectId = normalizeProjectIdInput(rawProjectId);
		this.resource = buildAdeProjectEditorUri(this.projectId);

		const missionService = instantiationService?.invokeFunction(accessor => {
			try {
				return accessor.get(IAdeMissionService);
			} catch {
				return undefined;
			}
		});

		if (this.projects?.onDidChange) {
			this._register(this.projects.onDidChange(() => this._onDidChangeLabel.fire()));
		}
		if (missionService?.onDidChange) {
			this._register(missionService.onDidChange(ev => {
				if (!ev.projectId || ev.projectId === this.projectId) {
					this._onDidChangeLabel.fire();
				}
			}));
		}
		this._register(onDidChangeAdeLocale(() => this._onDidChangeLabel.fire()));
	}

	override get typeId(): string {
		return AdeEngineeringEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.CanSplitInGroup;
	}

	override getName(): string {
		const page = this.projects?.getProjectPage?.(this.projectId);
		if (page?.name) {
			return page.name;
		}
		return this.projectId || localize('adeProjectCanvasFallbackTitle', "ADE Project");
	}

	override getDescription(): string | undefined {
		const folder = this.projects?.getFolderForProjectPage?.(this.projectId);
		return folder?.name;
	}

	override getIcon(): ThemeIcon {
		return Codicon.organization;
	}

	setPendingFocus(focus: IAdePendingMissionNodeFocus | undefined): void {
		this.pendingFocus = focus;
	}

	consumePendingFocus(): IAdePendingMissionNodeFocus | undefined {
		const next = this.pendingFocus;
		this.pendingFocus = undefined;
		return next;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof AdeEngineeringEditorInput) {
			return other.projectId === this.projectId;
		}
		return false;
	}
}

/**
 * `{ v: 2, projectId }` Safe Serializer (`plan.md` §8.1.3):
 * - Synchronously discards any legacy `v !== 2` cache to prevent crashes.
 * - Synchronously returns `AdeEngineeringEditorInput(projectId)` for valid `v === 2` payloads
 *   without checking unhydrated catalog state synchronously (preventing `Cmd+R` tab loss).
 * - Deferred existence check runs in `AdeEngineeringEditorPane.setInput()` after `await projectsService.whenReady()`.
 */
export class AdeEngineeringEditorSerializer implements IEditorSerializer {
	canSerialize(input: EditorInput): boolean {
		return input instanceof AdeEngineeringEditorInput && Boolean(input.projectId);
	}

	serialize(input: EditorInput): string | undefined {
		if (!(input instanceof AdeEngineeringEditorInput) || !input.projectId) {
			return undefined;
		}
		return JSON.stringify({ v: 2, projectId: input.projectId });
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		if (!serialized || typeof serialized !== 'string') {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(serialized);
		} catch {
			return undefined;
		}
		if (!parsed || typeof parsed !== 'object') {
			return undefined;
		}
		const rec = parsed as { readonly v?: unknown; readonly projectId?: unknown };
		if (rec.v !== 2 || typeof rec.projectId !== 'string' || !rec.projectId.trim()) {
			return undefined;
		}
		return instantiationService.createInstance(AdeEngineeringEditorInput, rec.projectId.trim());
	}
}

/**
 * Refactored ADE Project Single-Parent Tree Orchestration Canvas EditorPane (`plan.md` §8):
 * - Renders `344×188` staff cards, `276×164` whiteboard cards, nested department regions, and minimap.
 * - Enforces mandatory bidirectional edges (`markerUnits="userSpaceOnUse"`, `outset = 6`, `22px` rigid normal stubs).
 * - Drives strict `3000ms` arc-length proportional Ticket flow animations (`AdeTicketFlowController`).
 * - Mounts physically isolated `AdeEdgeTicketHistoryPopover` & `AdeWhiteboardPopover` on `bodyEl`
 *   so canvas wheel zoom and topology refreshes never close open inspection panels.
 */
export class AdeEngineeringEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.adeEngineering';

	private readonly controlCenterService: IAdeControlCenterService | undefined;
	private readonly missionService: IAdeMissionService | undefined;
	private readonly projectsService: IAdeProjectsService | undefined;
	private readonly adeEditorService: IAdeEditorService | undefined;
	private readonly sessionsService: IAdeSessionsService | undefined;
	private readonly cloudHostService: IAdeCloudHostBackendService | undefined;
	private readonly commandService: ICommandService | undefined;
	private readonly dialogService: IDialogService | undefined;
	private readonly fileDialogService: IFileDialogService | undefined;
	private readonly markdownRendererService: IMarkdownRendererService | undefined;
	private readonly hostCatalog: AdeMissionHostCatalog;
	private readonly contextUsageTracker: AdeProjectContextUsageTracker;
	private readonly graphActions: AdeEngineeringGraphActions;

	private readonly domDisposables = this._register(new DisposableStore());
	private rootEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private viewportEl!: HTMLElement;
	private worldEl!: HTMLElement;
	private emptyHintEl!: HTMLElement;
	private marqueeBoxEl!: HTMLElement;

	private projectTitleBadgeEl!: HTMLElement;
	private layoutBtns = new Map<AdeLayoutDirection, HTMLButtonElement>();
	private addAgentBtnEl!: HTMLButtonElement;
	private addDeptBtnEl!: HTMLButtonElement;
	private addWbBtnEl!: HTMLButtonElement;
	private searchToggleBtnEl!: HTMLButtonElement;
	private fitViewBtnEl!: HTMLButtonElement;
	private zoomReadoutBtnEl!: HTMLButtonElement;
	private minimapToggleBtnEl!: HTMLButtonElement;

	private searchBarEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private searchCountEl!: HTMLElement;
	private toastEl!: HTMLElement;
	private toastTimer: ReturnType<typeof setTimeout> | undefined;

	private renderer!: AdeMissionCanvasRenderer;
	private minimap!: AdeMissionMinimap;
	private popovers!: AdeMissionPopovers;
	private edgeHistoryPopover!: AdeEdgeTicketHistoryPopover;
	private whiteboardPopover!: AdeWhiteboardPopover;
	private interactions!: IInstalledCanvasInteractions;

	private activeProjectId: string | undefined;
	private currentSnapshot: IAdeProjectSnapshot | undefined;
	private currentNodes: readonly IOrchestrationGraphNode[] = [];
	private currentEdges: readonly IOrchestrationGraphEdge[] = [];
	private readonly livePositions = new Map<string, IMissionNodePosition>();
	private readonly liveChatStateByAgentId = new Map<string, 'idle' | 'working' | 'pending'>();
	private selectedNodeIds = new Set<string>();
	private selectedEdgePairKey: string | undefined;
	private setInputSeq = 0;
	private isSettingInput = false;

	private panX = 80;
	private panY = 72;
	private zoom = 1;
	private viewportWidth = 1280;
	private viewportHeight = 800;
	private searchMatches: readonly string[] = [];
	private searchMatchIndex = 0;

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

		this.controlCenterService = tryGet(IAdeControlCenterService);
		this.missionService = tryGet(IAdeMissionService);
		this.projectsService = tryGet(IAdeProjectsService);
		this.adeEditorService = tryGet(IAdeEditorService);
		this.sessionsService = tryGet(IAdeSessionsService);
		this.cloudHostService = tryGet(IAdeCloudHostBackendService);
		this.commandService = tryGet(ICommandService);
		this.dialogService = tryGet(IDialogService);
		this.fileDialogService = tryGet(IFileDialogService);
		this.markdownRendererService = tryGet(IMarkdownRendererService);

		this.hostCatalog = this._register(new AdeMissionHostCatalog(
			storageService,
			this.sessionsService,
			this.cloudHostService,
			this.commandService,
			this.controlCenterService,
		));

		const chatService = tryGet(IChatService);
		this.contextUsageTracker = this._register(new AdeProjectContextUsageTracker(
			storageService,
			chatService,
			this.commandService,
		));
		this._register(this.contextUsageTracker.onDidChange(() => {
			if (
				!this.isSettingInput
				&& this.currentSnapshot
				&& this.activeProjectId
				&& this.currentSnapshot.meta.project_id === this.activeProjectId
			) {
				this.applySnapshotToCanvas(this.currentSnapshot, false);
			}
		}));

		this.graphActions = new AdeEngineeringGraphActions(
			this.controlCenterService,
			this.missionService,
			this.dialogService,
			sharedHistoryStore,
			{
				getProjectId: () => this.activeProjectId,
				getProjectSnapshot: () => this.currentSnapshot,
				getCurrentPositionsObject: () => {
					const obj: Record<string, IMissionNodePosition> = {};
					for (const [id, p] of this.livePositions.entries()) {
						obj[id] = { x: p.x, y: p.y };
					}
					return obj;
				},
				clearLocalPositionCache: () => {
					this.livePositions.clear();
				},
				applyOptimisticPositions: positions => {
					const map = new Map<string, IMissionNodePosition>();
					for (const [id, p] of Object.entries(positions)) {
						map.set(id, p);
					}
					this.renderer?.updateDraggedNodesPositions(map);
					this.syncMinimap();
				},
				onFeedback: (msg, kind) => this.showFeedbackToast(msg, kind),
				onRefreshSnapshot: async (force = true) => {
					if (this.activeProjectId) {
						await this.reloadAndRenderProject(this.activeProjectId, force, false);
					}
				},
			},
		);

		this._register({
			dispose: () => {
				if (this.toastTimer !== undefined) {
					clearTimeout(this.toastTimer);
					this.toastTimer = undefined;
				}
			},
		});

		if (this.controlCenterService) {
			this._register(this.controlCenterService.onDidTransferTicket(ev => {
				if (
					this.isSettingInput
					|| !this.activeProjectId
					|| ev.project_id !== this.activeProjectId
					|| !this.renderer
					|| (this.currentSnapshot && this.currentSnapshot.meta.project_id !== this.activeProjectId)
				) {
					return;
				}
				this.renderer.triggerTicketTransferAnimation(ev);
				if (this.currentSnapshot && this.currentSnapshot.meta.project_id === this.activeProjectId) {
					const nextTimes: Record<string, number> = { ...this.currentSnapshot.edge_latest_transfer_at };
					for (const hop of ev.hops) {
						const prev = nextTimes[hop.edge_pair_key] ?? 0;
						if (ev.transferred_at > prev) {
							nextTimes[hop.edge_pair_key] = ev.transferred_at;
						}
					}
					this.currentSnapshot = {
						...this.currentSnapshot,
						edge_latest_transfer_at: nextTimes,
					};
				}
				const activeEdgeKeys = new Set(
					this.currentEdges
						.filter(e => !e.isWhiteboardLink)
						.map(e => e.edgePairKey ?? canonicalEdgePairKey(e.from, e.to)),
				);
				this.edgeHistoryPopover?.notifyTopologyOrTransferUpdated(activeEdgeKeys);
			}));

			if (!this.missionService) {
				this._register(this.controlCenterService.onDidChangeProject(({ projectId }) => {
					if (!this.isSettingInput && this.activeProjectId && projectId === this.activeProjectId) {
						void this.reloadAndRenderProject(projectId, true, false);
					}
				}));
			}
		}

		if (this.missionService) {
			this._register(this.missionService.onDidChange(ev => {
				if (this.isSettingInput) {
					return;
				}
				if (this.activeProjectId && (!ev.projectId || ev.projectId === this.activeProjectId)) {
					const cached = this.missionService?.getProjectSnapshotCached(this.activeProjectId);
					if (cached && cached.meta.project_id === this.activeProjectId) {
						this.applySnapshotToCanvas(cached, false);
					}
				}
			}));
		}

		if (this.projectsService) {
			this._register(this.projectsService.onDidChange(changeKind => {
				if (this.isSettingInput || changeKind === 'selection' || changeKind === 'order') {
					return;
				}
				if (
					this.currentSnapshot
					&& this.activeProjectId
					&& this.currentSnapshot.meta.project_id === this.activeProjectId
				) {
					if (this.missionService?.isSyncingProjectSnapshot?.(this.activeProjectId)) {
						return;
					}
					const cached = this.missionService?.getProjectSnapshotCached(this.activeProjectId);
					if (cached && cached !== this.currentSnapshot) {
						return;
					}
					this.applySnapshotToCanvas(this.currentSnapshot, false);
				}
			}));
		}

		this._register(this.hostCatalog.onDidChangeHosts(() => {
			if (
				!this.isSettingInput
				&& this.currentSnapshot
				&& this.activeProjectId
				&& this.currentSnapshot.meta.project_id === this.activeProjectId
			) {
				this.applySnapshotToCanvas(this.currentSnapshot, false);
			}
		}));

		this._register(onDidRestoreAdePageVisibility(() => {
			this.renderer?.ticketFlow.reconcileNow();
		}));

		this._register(onDidChangeAdeLocale(() => {
			this.syncTopToolbarLabels();
			if (
				!this.isSettingInput
				&& this.currentSnapshot
				&& (!this.activeProjectId || this.currentSnapshot.meta.project_id === this.activeProjectId)
			) {
				this.applySnapshotToCanvas(this.currentSnapshot, true);
			}
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this.domDisposables.clear();

		this.rootEl = append(parent, $('.ade-mission-editor.ade-eng-editor', {
			tabIndex: 0,
			'data-ade-project-canvas': 'true',
		}));
		this.bodyEl = append(this.rootEl, $('.ade-mission-body.ade-eng-body'));
		this.viewportEl = append(this.bodyEl, $('.ade-mission-viewport'));
		this.worldEl = append(this.viewportEl, $('.ade-mission-world.ade-eng-world'));
		this.emptyHintEl = append(this.viewportEl, $('.ade-mission-empty-hint'));
		this.emptyHintEl.hidden = true;

		this.marqueeBoxEl = append(this.viewportEl, $('.ade-mission-marquee'));
		this.marqueeBoxEl.hidden = true;

		this.buildTopToolbarDom();
		this.buildSearchAndToastDom();

		this.renderer = this._register(new AdeMissionCanvasRenderer(
			this.worldEl,
			this.emptyHintEl,
			this.hostCatalog,
			{
				onHoverNode: nodeId => this.renderer.setHoveredNode(nodeId),
				onOpenModelPopover: (nodeId, agent, eng, anchorEl, opts) => {
					this.edgeHistoryPopover?.closeClickPopover();
					this.whiteboardPopover?.close();
					this.popovers.openModelPopover(nodeId, agent, eng, anchorEl, opts);
				},
				onOpenEffortPopover: (nodeId, agent, eng, anchorEl, opts) => {
					this.edgeHistoryPopover?.closeClickPopover();
					this.whiteboardPopover?.close();
					this.popovers.openEffortPopover(nodeId, agent, eng, anchorEl, opts);
				},
				onOpenEnginePopover: (nodeId, agent, eng, anchorEl, opts) => {
					this.edgeHistoryPopover?.closeClickPopover();
					this.whiteboardPopover?.close();
					this.popovers.openEnginePopover(nodeId, agent, eng, anchorEl, opts);
				},
				onOpenHostPopover: (nodeId, agent, rawHost, anchorEl, opts) => {
					this.edgeHistoryPopover?.closeClickPopover();
					this.whiteboardPopover?.close();
					this.popovers.openHostPopover(nodeId, agent, rawHost, anchorEl, opts);
				},
				onOpenStaffEditPopover: (node, anchorEl) => {
					if (!this.currentSnapshot) {
						return;
					}
					const ag = this.currentSnapshot.agents.find(a => a.agent_id === node.id);
					if (ag) {
						this.edgeHistoryPopover?.closeClickPopover();
						this.whiteboardPopover?.close();
						this.popovers.openEditAgentPopover(this.currentSnapshot, ag, anchorEl);
					}
				},
				onOpenAgentSession: (agentId, side) => {
					if (!this.activeProjectId) {
						return;
					}
					void this.adeEditorService?.openAgent(agentId, { projectId: this.activeProjectId, side });
				},
				onStartNodeDrag: (nodeId, e) => this.interactions.startNodeDrag(nodeId, e),
				onDragNodeMove: (nodeId, e) => this.interactions.moveNodeDrag(nodeId, e),
				onEndNodeDrag: (nodeId, e) => this.interactions.endNodeDrag(nodeId, e),
				getNodePosition: nodeId => this.livePositions.get(nodeId),
				getZoom: () => this.zoom,
				onSelectNode: (nodeId, additive) => {
					if (!nodeId) {
						this.setSelectedNodesAndEdge(new Set(), undefined);
						return;
					}
					const next = additive ? new Set(this.selectedNodeIds) : new Set<string>();
					if (additive && next.has(nodeId)) {
						next.delete(nodeId);
					} else {
						next.add(nodeId);
					}
					this.setSelectedNodesAndEdge(next, undefined);
				},
				onHoverStaffEdge: (edgePairKey, clientX, clientY) => {
					this.edgeHistoryPopover?.showHover(edgePairKey, clientX, clientY);
				},
				onMoveStaffEdge: (edgePairKey, clientX, clientY) => {
					this.edgeHistoryPopover?.moveHover(edgePairKey, clientX, clientY);
				},
				onLeaveStaffEdge: edgePairKey => {
					this.edgeHistoryPopover?.hideHover(edgePairKey);
				},
				onClickStaffEdge: (edgePairKey, clientX, clientY) => {
					if (!this.activeProjectId) {
						return;
					}
					this.popovers.close('dismiss');
					this.whiteboardPopover?.close();
					this.setSelectedNodesAndEdge(new Set(), edgePairKey);
					void this.edgeHistoryPopover.openForEdge(edgePairKey, clientX, clientY);
				},
				onRenameNode: (nodeId, nextTitle) => {
					void this.graphActions.renameNode(nodeId, nextTitle);
				},
				onNodeContextMenu: (nodeId, _label, kind, clientX, clientY) => {
					this.openNodeContextMenu(nodeId, kind, clientX, clientY);
				},
				onOpenNodeColorPopover: (nodeId, label, currentColor, anchorEl) => {
					this.popovers.openNodeColorPopover(nodeId, label, currentColor, anchorEl);
				},
				onStartConnectDrag: (fromId, e, anchor) => this.interactions.startConnectDrag(fromId, e, anchor),
				onMoveConnectDrag: e => this.interactions.moveConnectDrag(e),
				onEndConnectDrag: e => this.interactions.endConnectDrag(e),
				onOpenWhiteboardPopover: (wb, anchorEl) => {
					if (!this.activeProjectId) {
						return;
					}
					this.popovers.close('dismiss');
					this.edgeHistoryPopover?.closeClickPopover();
					void this.whiteboardPopover?.open(wb, anchorEl);
				},
				onStartDepartmentDrag: (dept, members, e, empty) => this.interactions.startDepartmentDrag(dept, members, e, empty),
				onMoveDepartmentDrag: e => this.interactions.moveDepartmentDrag(e),
				onEndDepartmentDrag: e => this.interactions.endDepartmentDrag(e),
				onDepartmentContextMenu: (dept, clientX, clientY) => {
					this.openDepartmentContextMenu(dept.id, clientX, clientY);
				},
				onCreateSoleTopRoleFromEmptyHint: () => {
					this.openCreateAgentCascade({ anchorEl: this.addAgentBtnEl });
				},
			},
		));

		this.minimap = this._register(new AdeMissionMinimap(this.bodyEl, {
			onNavigateToWorldCenter: (worldX, worldY) => {
				this.centerViewportOnWorldPoint(worldX, worldY);
			},
		}));

		this.popovers = this._register(new AdeMissionPopovers(this.bodyEl, this.hostCatalog, {
			getProjectSnapshot: () => this.currentSnapshot,
			onCreateAgent: input => this.graphActions.createAgent(input),
			onEditAgent: input => this.graphActions.editAgent(input),
			onDeleteAgent: id => this.graphActions.deleteAgentWithConfirm(id, false),
			onOpenAgentSession: (id, side) => {
				if (this.activeProjectId) {
					void this.adeEditorService?.openAgent(id, { projectId: this.activeProjectId, side });
				}
			},
			onManageCloudHosts: () => {
				void this.commandService?.executeCommand(ADE_CLOUD_HOSTS_MANAGE_COMMAND_ID);
			},
			onCreateDepartment: (rootId, name, color) => this.graphActions.createDepartment(rootId, name, color),
			onEditDepartment: (deptId, patch) => this.graphActions.editDepartment(deptId, patch),
			onToggleDepartmentMember: (deptId, agentId, action) => this.graphActions.toggleDepartmentMember(deptId, agentId, action),
			onDeleteDepartment: deptId => this.graphActions.deleteDepartment(deptId),
			onCreateWhiteboard: input => this.graphActions.createWhiteboard(input),
			onSetNodeColor: (nodeId, color) => this.graphActions.setNodeColor(nodeId, color),
			onActionFeedback: (msg, kind) => this.showFeedbackToast(msg, kind),
		}));

		if (this.controlCenterService) {
			this.edgeHistoryPopover = this._register(new AdeEdgeTicketHistoryPopover(
				this.bodyEl,
				this.controlCenterService,
				this.markdownRendererService,
				{
					getProjectId: () => this.activeProjectId,
					getProjectSnapshot: () => this.currentSnapshot,
					onDidDismissEdgeSelection: () => {
						if (this.selectedEdgePairKey) {
							this.setSelectedNodesAndEdge(this.selectedNodeIds, undefined);
						}
					},
				},
			));

			this.whiteboardPopover = this._register(new AdeWhiteboardPopover(
				this.bodyEl,
				this.controlCenterService,
				this.hostCatalog,
				this.markdownRendererService,
				this.fileDialogService,
				{
					getProjectId: () => this.activeProjectId,
					getProjectSnapshot: () => this.currentSnapshot,
					onFeedback: (msg, kind) => this.showFeedbackToast(msg, kind),
					onDidMutateWhiteboard: () => {
						if (this.activeProjectId) {
							void this.reloadAndRenderProject(this.activeProjectId, true, false);
						}
					},
				},
			));
		}

		this.interactions = installEngineeringCanvasInteractions(
			{
				viewportEl: this.viewportEl,
				marqueeBoxEl: this.marqueeBoxEl,
				getZoom: () => this.zoom,
				getPan: () => ({ x: this.panX, y: this.panY }),
				setCamera: (nx, ny, nz) => this.setCamera(nx, ny, nz),
				getNodes: () => this.currentNodes,
				getPositions: () => this.livePositions,
				getSelectedNodeIds: () => this.selectedNodeIds,
				setSelectedNodesAndEdge: (ids, edgeKey) => this.setSelectedNodesAndEdge(ids, edgeKey),
				onBlankCanvasClick: () => {
					this.setSelectedNodesAndEdge(new Set(), undefined);
					this.popovers.close('dismiss');
					this.edgeHistoryPopover?.closeClickPopover();
					this.whiteboardPopover?.close();
				},
				onBlankCanvasContextMenu: (clientX, clientY) => {
					if (!this.currentSnapshot) {
						return;
					}
					const pos = this.clientToWorld(clientX, clientY);
					const items = buildBlankCanvasContextMenuItems({
						snapshot: this.currentSnapshot,
						onCreateSoleTopRole: () => this.openCreateAgentCascade({ clientX, clientY }, undefined, pos),
						onCreateSubordinate: () => this.openCreateAgentCascade({ clientX, clientY }, undefined, pos),
						onCreateDepartment: () => this.popovers.openCreateDepartmentPopover(this.currentSnapshot!, { clientX, clientY }),
						onCreateWhiteboard: () => this.popovers.openCreateWhiteboardPopover(this.currentSnapshot!, { clientX, clientY }, {
							canvasX: pos.x,
							canvasY: pos.y,
						}),
						onFitView: () => this.fitCanvasToView(),
					});
					this.popovers.openContextMenu(items, clientX, clientY);
				},
				onDismissTransientContextMenuOnly: () => {
					this.edgeHistoryPopover?.hideHover();
					if (this.popovers.isContextMenuOpen()) {
						this.popovers.close('dismiss');
					}
				},
				onUpdateLivePositions: (updated, primaryMovedId) => {
					for (const [id, p] of updated.entries()) {
						this.livePositions.set(id, p);
					}
					this.renderer.updateDraggedNodesPositions(updated, primaryMovedId);
					this.syncMinimap();
				},
				onRenderSnapGuides: guides => this.renderer.renderSnapGuides(guides),
				onCommitPositionsChange: (before, after, label) => {
					void this.graphActions.commitPositionsChange(before, after, label);
				},
				onSetConnectPreview: (pathD, targetId) => this.renderer.setConnectPreview(pathD, targetId),
				onReparentAgent: (agentId, newParentId) => {
					void this.graphActions.reparentAgent(agentId, newParentId);
				},
				onSpawnSubordinateAtWorldPos: (parentId, worldX, worldY, clientX, clientY) => {
					this.openCreateAgentCascade({ clientX, clientY }, parentId, { x: worldX, y: worldY });
				},
			},
			this.domDisposables,
			{ minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM },
		);

		this.bindKeyboardShortcuts();
		this.syncTopToolbarLabels();
	}

	private buildTopToolbarDom(): void {
		const slot = append(this.bodyEl, $('.ade-mission-top-bar-slot'));
		const bar = append(slot, $('.ade-mission-top-bar'));

		this.projectTitleBadgeEl = append(bar, $('.ade-canvas-project-badge'));

		// Layout Direction Segmented Control (`TD | LR | RADIAL | GRID`)
		const layoutSeg = append(bar, $('.ade-canvas-seg-group', {
			role: 'group',
		}));
		this.layoutBtns.clear();
		for (const dir of ['TD', 'LR', 'RADIAL', 'GRID'] as const) {
			const btn = append(layoutSeg, $('button.ade-canvas-seg-btn', {
				type: 'button',
				'data-ade-layout-dir': dir,
			}, dir)) as HTMLButtonElement;
			this.layoutBtns.set(dir, btn);
			this.domDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				void this.graphActions.switchLayoutDirection(dir);
			}));
		}

		// Creation Cluster
		const actionSeg = append(bar, $('.ade-canvas-seg-group'));
		this.addAgentBtnEl = append(actionSeg, $('button.ade-canvas-toolbar-btn.is-primary', {
			type: 'button',
			'data-ade-toolbar-add-agent': 'true',
		})) as HTMLButtonElement;
		this.domDisposables.add(addDisposableListener(this.addAgentBtnEl, EventType.CLICK, () => {
			const selectedParent = [...this.selectedNodeIds].find(id => this.currentSnapshot?.agents.some(a => a.agent_id === id));
			this.openCreateAgentCascade({ anchorEl: this.addAgentBtnEl }, selectedParent);
		}));

		this.addDeptBtnEl = append(actionSeg, $('button.ade-canvas-toolbar-btn', {
			type: 'button',
			'data-ade-toolbar-add-dept': 'true',
		})) as HTMLButtonElement;
		this.domDisposables.add(addDisposableListener(this.addDeptBtnEl, EventType.CLICK, () => {
			if (!this.currentSnapshot || this.currentSnapshot.agents.length === 0) {
				return;
			}
			const selectedRoot = [...this.selectedNodeIds].find(id => this.currentSnapshot?.agents.some(a => a.agent_id === id));
			this.popovers.openCreateDepartmentPopover(this.currentSnapshot, { anchorEl: this.addDeptBtnEl }, selectedRoot);
		}));

		this.addWbBtnEl = append(actionSeg, $('button.ade-canvas-toolbar-btn', {
			type: 'button',
			'data-ade-toolbar-add-wb': 'true',
		})) as HTMLButtonElement;
		this.domDisposables.add(addDisposableListener(this.addWbBtnEl, EventType.CLICK, () => {
			if (!this.currentSnapshot || this.currentSnapshot.agents.length === 0) {
				return;
			}
			this.popovers.openCreateWhiteboardPopover(this.currentSnapshot, { anchorEl: this.addWbBtnEl });
		}));

		// Right View Controls
		const viewSeg = append(bar, $('.ade-canvas-seg-group.ade-canvas-right-seg'));
		this.searchToggleBtnEl = append(viewSeg, $('button.ade-canvas-icon-btn', {
			type: 'button',
			'data-ade-toolbar-search': 'true',
		})) as HTMLButtonElement;
		append(this.searchToggleBtnEl, $('span.codicon.codicon-search'));
		this.domDisposables.add(addDisposableListener(this.searchToggleBtnEl, EventType.CLICK, () => this.toggleSearchBar()));

		const zoomOutBtn = append(viewSeg, $('button.ade-canvas-icon-btn', { type: 'button' }, '−')) as HTMLButtonElement;
		this.zoomReadoutBtnEl = append(viewSeg, $('button.ade-canvas-zoom-readout', { type: 'button' }, '100%')) as HTMLButtonElement;
		const zoomInBtn = append(viewSeg, $('button.ade-canvas-icon-btn', { type: 'button' }, '+')) as HTMLButtonElement;
		this.domDisposables.add(addDisposableListener(zoomOutBtn, EventType.CLICK, () => this.zoomByFactor(1 / 1.2)));
		this.domDisposables.add(addDisposableListener(zoomInBtn, EventType.CLICK, () => this.zoomByFactor(1.2)));
		this.domDisposables.add(addDisposableListener(this.zoomReadoutBtnEl, EventType.CLICK, () => this.setCamera(this.panX, this.panY, 1)));

		this.fitViewBtnEl = append(viewSeg, $('button.ade-canvas-icon-btn', {
			type: 'button',
			'data-ade-toolbar-fit': 'true',
		})) as HTMLButtonElement;
		append(this.fitViewBtnEl, $('span.codicon.codicon-screen-full'));
		this.domDisposables.add(addDisposableListener(this.fitViewBtnEl, EventType.CLICK, () => this.fitCanvasToView()));

		this.minimapToggleBtnEl = append(viewSeg, $('button.ade-canvas-icon-btn.is-active', {
			type: 'button',
			'data-ade-toolbar-minimap': 'true',
		})) as HTMLButtonElement;
		append(this.minimapToggleBtnEl, $('span.codicon.codicon-map'));
		this.domDisposables.add(addDisposableListener(this.minimapToggleBtnEl, EventType.CLICK, () => {
			const next = !this.minimap.isUserVisible();
			this.minimap.setUserVisible(next);
			this.minimapToggleBtnEl.classList.toggle('is-active', next);
		}));
	}

	private buildSearchAndToastDom(): void {
		this.searchBarEl = append(this.bodyEl, $('.ade-canvas-search-bar'));
		this.searchBarEl.hidden = true;
		this.domDisposables.add(addDisposableListener(this.searchBarEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		this.searchInputEl = append(this.searchBarEl, $('input.ade-popover-input', {
			type: 'text',
		})) as HTMLInputElement;
		this.searchCountEl = append(this.searchBarEl, $('span.ade-canvas-search-count', {}, '0/0'));
		const closeSearchBtn = append(this.searchBarEl, $('button.ade-mission-popover-close', { type: 'button' }, '×')) as HTMLButtonElement;

		this.domDisposables.add(addDisposableListener(this.searchInputEl, EventType.INPUT, () => {
			this.runCanvasSearch(this.searchInputEl.value, true);
		}));
		this.domDisposables.add(addDisposableListener(this.searchInputEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && this.searchMatches.length > 0) {
				e.preventDefault();
				this.searchMatchIndex = (this.searchMatchIndex + (e.shiftKey ? this.searchMatches.length - 1 : 1)) % this.searchMatches.length;
				this.focusSearchMatch();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.toggleSearchBar(false);
			}
		}));
		this.domDisposables.add(addDisposableListener(closeSearchBtn, EventType.CLICK, () => this.toggleSearchBar(false)));

		this.toastEl = append(this.bodyEl, $('.ade-canvas-feedback-toast'));
		this.toastEl.hidden = true;
	}

	private syncTopToolbarLabels(): void {
		if (!this.addAgentBtnEl) {
			return;
		}
		const hasAgents = (this.currentSnapshot?.agents.length ?? 0) > 0;
		this.addAgentBtnEl.textContent = hasAgents
			? adeBi(localize('adeToolbarRecruitBtn', "+ Agent"), '+ 招募下属')
			: adeBi(localize('adeToolbarCreateL1Btn', "+ L1 Lead"), '+ 创建唯一 L1');

		this.addDeptBtnEl.textContent = adeBi(localize('adeToolbarAddDeptBtn', "+ Dept"), '+ 部门');
		this.addDeptBtnEl.disabled = !hasAgents;
		this.addDeptBtnEl.title = hasAgents
			? adeBi(localize('adeToolbarAddDeptTip', "Create department boundary"), '创建部门边界')
			: adeBi(localize('adeToolbarAddDeptDisabledTip', "Create the sole L1 Lead first"), '请先创建唯一顶层 L1 负责人');

		this.addWbBtnEl.textContent = adeBi(localize('adeToolbarAddWbBtn', "+ Whiteboard"), '+ 白板');
		this.addWbBtnEl.disabled = !hasAgents;
		this.addWbBtnEl.title = hasAgents
			? adeBi(localize('adeToolbarAddWbTip', "Create shared whiteboard"), '新建共享白板')
			: adeBi(localize('adeToolbarAddWbDisabledTip', "Create the sole L1 Lead first"), '请先创建唯一顶层 L1 负责人');

		this.searchToggleBtnEl.title = adeBi(localize('adeToolbarSearchTip', "Search canvas (Cmd/Ctrl+F)"), '搜索画布节点 (Cmd/Ctrl+F)');
		this.fitViewBtnEl.title = adeBi(localize('adeToolbarFitTip', "Fit canvas to view"), '自适应居中视图');
		this.minimapToggleBtnEl.title = adeBi(localize('adeToolbarMinimapTip', "Toggle minimap"), '显示/隐藏小地图');
		this.searchInputEl.placeholder = adeBi(localize('adeSearchCanvasPh', "Find employee, model, host, whiteboard..."), '搜索员工、模型、主机、白板…');

		const activeDir = this.currentSnapshot?.meta.layout_direction ?? 'TD';
		for (const [dir, btn] of this.layoutBtns.entries()) {
			btn.classList.toggle('is-active', dir === activeDir);
		}
	}

	private bindKeyboardShortcuts(): void {
		this.domDisposables.add(addDisposableListener(this.rootEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const target = e.target;
			const inEditable = isHTMLElement(target) && Boolean(target.closest(`${ADE_CARD_INTERACTIVE_SELECTOR}, .ade-mission-emp-popover`));

			if (e.key === 'Escape') {
				if (this.edgeHistoryPopover?.handleEscapeKey()) {
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				if (this.whiteboardPopover?.isOpen()) {
					e.preventDefault();
					e.stopPropagation();
					this.whiteboardPopover.close();
					return;
				}
				if (this.popovers?.isOpen()) {
					e.preventDefault();
					e.stopPropagation();
					this.popovers.close('escape');
					return;
				}
				if (!this.searchBarEl.hidden) {
					e.preventDefault();
					this.toggleSearchBar(false);
					return;
				}
				if (this.selectedNodeIds.size > 0 || this.selectedEdgePairKey) {
					this.setSelectedNodesAndEdge(new Set(), undefined);
				}
				return;
			}

			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
				e.preventDefault();
				this.toggleSearchBar(true);
				return;
			}

			if (inEditable) {
				return;
			}

			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
				e.preventDefault();
				if (e.shiftKey) {
					void this.graphActions.redoPositions();
				} else {
					void this.graphActions.undoPositions();
				}
				return;
			}

			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
				e.preventDefault();
				void this.graphActions.redoPositions();
				return;
			}

			if (e.key === 'F2' && this.selectedNodeIds.size === 1) {
				e.preventDefault();
				const [soleId] = this.selectedNodeIds;
				this.renderer.startInlineNodeRename(soleId);
				return;
			}

			// Delete key applies ONLY to selected leaf staff or whiteboard nodes — NEVER to mandatory bidirectional edges (`plan.md` §8.2.3)!
			if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNodeIds.size === 1) {
				const [soleId] = this.selectedNodeIds;
				const wb = this.currentSnapshot?.whiteboards.find(w => w.board_id === soleId);
				if (wb) {
					e.preventDefault();
					void this.graphActions.deleteWhiteboardWithConfirm(wb.board_id, false);
					return;
				}
				const ag = this.currentSnapshot?.agents.find(a => a.agent_id === soleId);
				if (ag) {
					e.preventDefault();
					void this.graphActions.deleteAgentWithConfirm(ag.agent_id, false);
				}
			}
		}));
	}

	override async setInput(
		input: AdeEngineeringEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		const seq = ++this.setInputSeq;
		this.isSettingInput = true;
		const prevProjectId = this.activeProjectId;
		const nextProjectId = input.projectId;

		if (prevProjectId !== nextProjectId) {
			if (prevProjectId) {
				sharedViewportMemory.save(prevProjectId, { panX: this.panX, panY: this.panY, zoom: this.zoom });
			}
			this.popovers?.close('dismiss');
			this.edgeHistoryPopover?.closeClickPopover();
			this.edgeHistoryPopover?.hideHover();
			this.whiteboardPopover?.close();
			this.activeProjectId = nextProjectId;
			this.currentSnapshot = undefined;
			this.currentNodes = [];
			this.currentEdges = [];
			this.livePositions.clear();
			this.liveChatStateByAgentId.clear();
			this.selectedNodeIds.clear();
			this.selectedEdgePairKey = undefined;
			this.renderer?.ticketFlow.clearAll();
			if (prevProjectId && this.renderer) {
				this.renderer.syncGraph({
					direction: 'TD',
					layoutMode: 'td',
					nodes: [],
					edges: [],
					departments: [],
					positions: this.livePositions,
					agentNodesById: new Map(),
					whiteboardsById: new Map(),
					tickets: [],
				}, true);
				if (this.emptyHintEl) {
					this.emptyHintEl.hidden = true;
				}
			}
			this.minimap?.syncGraph([], [], this.livePositions, this.selectedNodeIds);
			if (this.projectTitleBadgeEl) {
				this.projectTitleBadgeEl.textContent = this.projectsService?.getProjectPage?.(nextProjectId)?.name ?? '';
				this.projectTitleBadgeEl.title = '';
			}
			this.syncTopToolbarLabels();
		} else {
			this.activeProjectId = nextProjectId;
		}

		try {
			await super.setInput(input, options, context, token);
			if (token.isCancellationRequested || this.input !== input || this.setInputSeq !== seq) {
				return;
			}

			// Defer project existence check until `projectsService.whenReady()` settles (`plan.md` §8.1.3)
			await this.projectsService?.whenReady?.();
			if (token.isCancellationRequested || this.input !== input || this.setInputSeq !== seq) {
				return;
			}

			const snap = await this.loadSnapshotForProject(nextProjectId, true);
			if (token.isCancellationRequested || this.input !== input || this.setInputSeq !== seq) {
				return;
			}

			const pageExists = Boolean(snap || this.projectsService?.getProjectPage?.(nextProjectId));
			if (!pageExists) {
				await this.group.closeEditor(input);
				return;
			}

			this.projectsService?.selectProjectPage?.(nextProjectId);

			const savedCam = sharedViewportMemory.get(nextProjectId);
			const isFirstOpen = !savedCam && prevProjectId !== nextProjectId;
			if (savedCam) {
				this.setCamera(savedCam.panX, savedCam.panY, savedCam.zoom, false);
			}
			if (this.setInputSeq === seq) {
				this.isSettingInput = false;
			}
			if (snap) {
				this.applySnapshotToCanvas(snap, prevProjectId !== nextProjectId);
				if (isFirstOpen && this.currentNodes.length > 0) {
					this.fitCanvasToView();
				}
			}

			const pendingFocus = input.consumePendingFocus();
			if (pendingFocus) {
				this.focusNode(pendingFocus.nodeId, {
					highlightNodeIds: pendingFocus.highlightNodeIds,
					openPopover: pendingFocus.openPopover,
					openAgentBeside: pendingFocus.openAgentBeside,
				});
			}
		} finally {
			if (this.setInputSeq === seq) {
				this.isSettingInput = false;
			}
		}
	}

	override clearInput(): void {
		this.setInputSeq++;
		this.isSettingInput = false;
		if (this.activeProjectId) {
			sharedViewportMemory.save(this.activeProjectId, { panX: this.panX, panY: this.panY, zoom: this.zoom });
		}
		this.popovers?.close('dismiss');
		this.edgeHistoryPopover?.closeClickPopover();
		this.edgeHistoryPopover?.hideHover();
		this.whiteboardPopover?.close();
		this.activeProjectId = undefined;
		this.currentSnapshot = undefined;
		this.currentNodes = [];
		this.currentEdges = [];
		this.livePositions.clear();
		this.liveChatStateByAgentId.clear();
		this.selectedNodeIds.clear();
		this.selectedEdgePairKey = undefined;
		this.renderer?.ticketFlow.clearAll();
		this.minimap?.setSelectedNodes(this.selectedNodeIds);
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		this.viewportWidth = Math.max(200, dimension.width);
		this.viewportHeight = Math.max(160, dimension.height);
		this.applyViewportTransform();
	}

	override focus(): void {
		super.focus();
		this.rootEl?.focus();
	}

	private async loadSnapshotForProject(projectId: string, forceRefresh: boolean): Promise<IAdeProjectSnapshot | undefined> {
		if (this.missionService) {
			return this.missionService.loadProjectSnapshot(projectId, forceRefresh);
		}
		return this.controlCenterService?.getProjectSnapshot(projectId);
	}

	private async reloadAndRenderProject(projectId: string, forceRefresh: boolean, forceDomRebuild: boolean): Promise<void> {
		const snap = await this.loadSnapshotForProject(projectId, forceRefresh);
		if (!snap || this.activeProjectId !== projectId || snap.meta.project_id !== projectId) {
			return;
		}
		if (forceDomRebuild || this.currentSnapshot !== snap) {
			this.applySnapshotToCanvas(snap, forceDomRebuild);
		}
	}

	private applySnapshotToCanvas(snapshot: IAdeProjectSnapshot, forceRebuild: boolean): void {
		if (this.activeProjectId && snapshot.meta.project_id !== this.activeProjectId) {
			return;
		}
		this.currentSnapshot = snapshot;
		const projectId = snapshot.meta.project_id;
		const pageName = this.projectsService?.getProjectPage?.(projectId)?.name ?? snapshot.meta.name;
		if (this.projectTitleBadgeEl) {
			this.projectTitleBadgeEl.textContent = pageName;
			this.projectTitleBadgeEl.title = snapshot.meta.folder_uri;
		}

		const deptColors: Record<string, string | undefined> = {};
		for (const d of snapshot.departments) {
			const c = this.missionService?.getDepartmentAccentColor(projectId, d.dept_id);
			if (c) {
				deptColors[d.dept_id] = c;
			}
		}

		const wbColors: Record<string, string | undefined> = {};
		for (const w of snapshot.whiteboards) {
			const c = this.missionService?.getWhiteboardAccentColor(projectId, w.board_id);
			if (c) {
				wbColors[w.board_id] = c;
			}
		}

		const graph = buildProjectOrchestrationGraph(snapshot, { deptColors, wbColors });
		const layoutMode: OrchestrationLayoutMode = graph.layoutMode;
		const direction: OrchestrationDirection = graph.direction;

		const computedPositions = computeOrchestrationLayoutPositions(
			graph.nodes,
			graph.edges,
			graph.departments,
			{
				mode: layoutMode,
				direction,
				existingPositions: graph.storedPositions,
			},
		);

		this.currentNodes = graph.nodes;
		this.currentEdges = graph.edges;
		this.livePositions.clear();
		for (const [id, p] of computedPositions.entries()) {
			this.livePositions.set(id, p);
		}

		const agentNodesById = new Map<string, IAdeAgentNode>(snapshot.agents.map(a => [a.agent_id, a]));
		const whiteboardsById = new Map<string, IAdeWhiteboard>(snapshot.whiteboards.map(w => [w.board_id, w]));
		const linkedAgentsById = new Map<string, IAdeAgent>();
		const contextUsageByAgentId = new Map<string, IAdeAgentContextUsage>();
		const modelOverrides = this.hostCatalog.getModelCategoryOverrides();
		this.liveChatStateByAgentId.clear();

		for (const a of snapshot.agents) {
			const linked = this.projectsService?.getAgent?.(a.agent_id, projectId);
			const liveChatState = linked?.status ?? 'idle';
			if (linked) {
				linkedAgentsById.set(a.agent_id, linked);
				this.liveChatStateByAgentId.set(a.agent_id, liveChatState);
			}
			const prefixedEngine = toPrefixedAdeEngineId(a.engine);
			const resolvedModel = a.model || MISSION_ENGINE_DEFAULT_MODELS[prefixedEngine] || 'claude-sonnet-4-5';
			contextUsageByAgentId.set(a.agent_id, this.contextUsageTracker.resolveAgentUsage({
				projectId,
				agentId: a.agent_id,
				engine: a.engine,
				model: resolvedModel,
				sessionStarted: a.session_started,
				sessionResource: a.session_resource,
				nativeSessionId: a.native_session_id,
				liveChatState,
				overrides: modelOverrides,
			}));
		}

		this.hostCatalog.prewarmOrchestrationHosts(graph.nodes, () => {
			if (
				!this.isSettingInput
				&& this.currentSnapshot
				&& this.activeProjectId === projectId
				&& this.currentSnapshot.meta.project_id === projectId
			) {
				this.applySnapshotToCanvas(this.currentSnapshot, false);
			}
		});

		this.renderer.syncGraph({
			direction,
			layoutMode,
			nodes: graph.nodes,
			edges: graph.edges,
			departments: graph.departments,
			positions: this.livePositions,
			agentNodesById,
			whiteboardsById,
			tickets: snapshot.tickets,
			linkedAgentsById,
			liveChatStateByAgentId: this.liveChatStateByAgentId,
			contextUsageByAgentId,
		}, forceRebuild);

		this.syncTopToolbarLabels();
		this.syncMinimap();

		// Preserve open AdeEdgeTicketHistoryPopover across topology refreshes unless the edge itself was removed (`plan.md` §8.4.2)!
		if (this.edgeHistoryPopover?.isClickPopoverOpen()) {
			const activeEdgeKeys = new Set(
				graph.edges
					.filter(e => !e.isWhiteboardLink)
					.map(e => e.edgePairKey ?? canonicalEdgePairKey(e.from, e.to)),
			);
			this.edgeHistoryPopover.notifyTopologyOrTransferUpdated(activeEdgeKeys);
		}

		if (this.whiteboardPopover?.isOpen()) {
			this.whiteboardPopover.notifyProjectSnapshotChanged();
		}
	}

	private syncMinimap(): void {
		if (!this.minimap || !this.renderer) {
			return;
		}
		const payload = buildMinimapSyncPayload(
			this.currentNodes,
			this.currentSnapshot,
			this.liveChatStateByAgentId,
			this.renderer.getLastDepartmentBounds(),
		);
		this.minimap.syncGraph(this.currentNodes, this.currentEdges, this.livePositions, this.selectedNodeIds, payload);
		this.minimap.updateViewport(this.panX, this.panY, this.zoom, this.viewportWidth, this.viewportHeight);
	}

	private setCamera(panX: number, panY: number, zoom: number, persist = true): void {
		this.panX = Number.isFinite(panX) ? panX : 80;
		this.panY = Number.isFinite(panY) ? panY : 72;
		this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(zoom) ? zoom : 1));
		this.applyViewportTransform();
		if (persist && this.activeProjectId) {
			sharedViewportMemory.save(this.activeProjectId, { panX: this.panX, panY: this.panY, zoom: this.zoom });
		}
	}

	private applyViewportTransform(): void {
		if (!this.worldEl || !this.viewportEl) {
			return;
		}
		this.worldEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
		this.viewportEl.style.setProperty('--grid-scale', String(this.zoom));
		this.viewportEl.style.setProperty('--grid-x', `${this.panX}px`);
		this.viewportEl.style.setProperty('--grid-y', `${this.panY}px`);
		this.viewportEl.classList.toggle('zoom-macro', this.zoom < 0.52);
		if (this.zoomReadoutBtnEl) {
			this.zoomReadoutBtnEl.textContent = `${Math.round(this.zoom * 100)}%`;
		}
		this.minimap?.updateViewport(this.panX, this.panY, this.zoom, this.viewportWidth, this.viewportHeight);
	}

	private zoomByFactor(factor: number): void {
		const cx = this.viewportWidth * 0.5;
		const cy = this.viewportHeight * 0.5;
		const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
		const wx = (cx - this.panX) / this.zoom;
		const wy = (cy - this.panY) / this.zoom;
		this.setCamera(cx - wx * nextZoom, cy - wy * nextZoom, nextZoom);
	}

	private centerViewportOnWorldPoint(worldX: number, worldY: number): void {
		const nx = this.viewportWidth * 0.5 - worldX * this.zoom;
		const ny = this.viewportHeight * 0.5 - worldY * this.zoom;
		this.setCamera(nx, ny, this.zoom);
	}

	fitCanvasToView(): void {
		const bounds = computeGraphWorldBounds(this.currentNodes, this.livePositions, this.renderer?.getLastDepartmentBounds());
		if (!bounds) {
			this.setCamera(80, 72, 1);
			return;
		}
		const contentW = Math.max(240, bounds.maxX - bounds.minX + 140);
		const contentH = Math.max(180, bounds.maxY - bounds.minY + 140);
		const availW = Math.max(240, this.viewportWidth - 64);
		const availH = Math.max(180, this.viewportHeight - 96);
		const fitZoom = Math.max(MIN_ZOOM, Math.min(1.15, Math.min(availW / contentW, availH / contentH)));
		const centerWorldX = (bounds.minX + bounds.maxX) * 0.5;
		const centerWorldY = (bounds.minY + bounds.maxY) * 0.5;
		const nx = this.viewportWidth * 0.5 - centerWorldX * fitZoom;
		const ny = (this.viewportHeight + 28) * 0.5 - centerWorldY * fitZoom;
		this.setCamera(nx, ny, fitZoom);
	}

	focusNode(nodeId: string, opts?: Omit<IAdePendingMissionNodeFocus, 'nodeId'>): void {
		const node = this.currentNodes.find(n => n.id === nodeId);
		const pos = this.livePositions.get(nodeId);
		if (!node || !pos) {
			return;
		}
		this.centerViewportOnWorldPoint(pos.x, pos.y);
		const selected = new Set<string>([nodeId, ...(opts?.highlightNodeIds ?? [])]);
		this.setSelectedNodesAndEdge(selected, undefined);

		const cardEl = this.renderer.getCardElement(nodeId);
		if (opts?.openPopover === 'whiteboard' && node.kind === 'whiteboard' && cardEl && this.activeProjectId) {
			const wbObj = this.currentSnapshot?.whiteboards.find(w => w.board_id === nodeId);
			if (wbObj) {
				void this.whiteboardPopover?.open(wbObj, cardEl);
			}
		} else if (opts?.openPopover === 'agent' && node.kind === 'staff' && cardEl && this.currentSnapshot) {
			const ag = this.currentSnapshot.agents.find(a => a.agent_id === nodeId);
			if (ag) {
				this.popovers.openEditAgentPopover(this.currentSnapshot, ag, cardEl);
			}
		}
		if (opts?.openAgentBeside && node.kind === 'staff' && this.activeProjectId) {
			void this.adeEditorService?.openAgent(nodeId, { projectId: this.activeProjectId, side: true });
		}
	}

	private setSelectedNodesAndEdge(nodeIds: ReadonlySet<string>, edgePairKey: string | undefined): void {
		this.selectedNodeIds = new Set(nodeIds);
		this.selectedEdgePairKey = edgePairKey;
		this.renderer?.setSelectedState(this.selectedNodeIds, this.selectedEdgePairKey);
		this.minimap?.setSelectedNodes(this.selectedNodeIds);
		if (this.activeProjectId && this.currentSnapshot) {
			if (this.selectedNodeIds.size === 1) {
				const [soleId] = this.selectedNodeIds;
				if (this.currentSnapshot.agents.some(a => a.agent_id === soleId)) {
					this.projectsService?.selectAgent?.(soleId, this.activeProjectId);
				}
			} else if (this.selectedNodeIds.size === 0) {
				this.projectsService?.selectProjectPage?.(this.activeProjectId);
			}
		}
	}

	private clientToWorld(clientX: number, clientY: number): IMissionNodePosition {
		const rect = this.viewportEl.getBoundingClientRect();
		return {
			x: Math.max(40, Math.round((clientX - rect.left - this.panX) / this.zoom)),
			y: Math.max(40, Math.round((clientY - rect.top - this.panY) / this.zoom)),
		};
	}

	private openCreateAgentCascade(
		openTarget: { readonly anchorEl?: HTMLElement; readonly clientX?: number; readonly clientY?: number },
		defaultParentId?: string | null,
		worldPos?: IMissionNodePosition,
	): void {
		if (!this.currentSnapshot) {
			return;
		}
		this.popovers.openCreateAgentPopover({
			snapshot: this.currentSnapshot,
			defaultParentId,
			canvasX: worldPos?.x,
			canvasY: worldPos?.y,
		}, openTarget);
	}

	private openNodeContextMenu(nodeId: string, kind: 'staff' | 'whiteboard', clientX: number, clientY: number): void {
		if (!this.currentSnapshot) {
			return;
		}
		this.setSelectedNodesAndEdge(new Set([nodeId]), undefined);
		const cardEl = this.renderer.getCardElement(nodeId) ?? this.bodyEl;

		if (kind === 'whiteboard') {
			const wb = this.currentSnapshot.whiteboards.find(w => w.board_id === nodeId);
			if (!wb) {
				return;
			}
			const wbColor = this.missionService?.getWhiteboardAccentColor(this.currentSnapshot.meta.project_id, wb.board_id);
			const items = buildWhiteboardNodeContextMenuItems({
				whiteboard: wb,
				onInspectWhiteboard: () => {
					if (this.activeProjectId) {
						void this.whiteboardPopover?.open(wb, cardEl);
					}
				},
				onRenameInline: () => this.renderer.startInlineNodeRename(nodeId),
				onPickColor: () => this.popovers.openNodeColorPopover(nodeId, wb.name, wbColor, cardEl),
				onDeleteWhiteboard: () => {
					void this.graphActions.deleteWhiteboardWithConfirm(wb.board_id, false);
				},
			});
			this.popovers.openContextMenu(items, clientX, clientY);
			return;
		}

		const agent = this.currentSnapshot.agents.find(a => a.agent_id === nodeId);
		if (!agent) {
			return;
		}
		const items = buildStaffNodeContextMenuItems({
			snapshot: this.currentSnapshot,
			agent,
			onOpenSession: side => {
				if (this.activeProjectId) {
					void this.adeEditorService?.openAgent(agent.agent_id, { projectId: this.activeProjectId, side });
				}
			},
			onEditAgent: () => this.popovers.openEditAgentPopover(this.currentSnapshot!, agent, cardEl),
			onRecruitSubordinate: () => this.openCreateAgentCascade(
				{ anchorEl: cardEl },
				agent.agent_id,
			),
			onCreateDepartmentHere: () => this.popovers.openCreateDepartmentPopover(
				this.currentSnapshot!,
				{ anchorEl: cardEl },
				agent.agent_id,
			),
			onRenameInline: () => this.renderer.startInlineNodeRename(nodeId),
			onPickColor: () => this.popovers.openNodeColorPopover(nodeId, agent.name, agent.color_token, cardEl),
			onDeleteAgent: () => {
				void this.graphActions.deleteAgentWithConfirm(agent.agent_id, false);
			},
		});
		this.popovers.openContextMenu(items, clientX, clientY);
	}

	private openDepartmentContextMenu(deptId: string, clientX: number, clientY: number): void {
		if (!this.currentSnapshot) {
			return;
		}
		const dept = this.currentSnapshot.departments.find(d => d.dept_id === deptId);
		if (!dept) {
			return;
		}
		const curColor = this.missionService?.getDepartmentAccentColor(this.currentSnapshot.meta.project_id, deptId);
		const items = buildDepartmentContextMenuItems({
			snapshot: this.currentSnapshot,
			department: dept,
			onEditDepartment: () => this.popovers.openEditDepartmentPopover(this.currentSnapshot!, dept, curColor, { clientX, clientY }),
			onCreateDeptWhiteboard: () => this.popovers.openCreateWhiteboardPopover(this.currentSnapshot!, { clientX, clientY }, {
				deptId: dept.dept_id,
				ownerId: dept.root_agent_id,
			}),
			onDissolveDepartment: () => {
				void this.graphActions.deleteDepartment(dept.dept_id);
			},
		});
		this.popovers.openContextMenu(items, clientX, clientY);
	}

	private toggleSearchBar(forceOpen?: boolean): void {
		const nextOpen = forceOpen !== undefined ? forceOpen : this.searchBarEl.hidden;
		this.searchBarEl.hidden = !nextOpen;
		if (nextOpen) {
			this.searchInputEl.focus();
			this.searchInputEl.select();
			this.runCanvasSearch(this.searchInputEl.value, false);
		}
	}

	private runCanvasSearch(query: string, jumpToFirst: boolean): void {
		this.searchMatches = findCanvasSearchMatches(this.currentNodes, query);
		this.searchMatchIndex = 0;
		this.searchCountEl.textContent = this.searchMatches.length > 0
			? `1/${this.searchMatches.length}`
			: '0/0';
		if (jumpToFirst && this.searchMatches.length > 0) {
			this.focusSearchMatch();
		}
	}

	private focusSearchMatch(): void {
		if (this.searchMatches.length === 0) {
			return;
		}
		const id = this.searchMatches[this.searchMatchIndex];
		this.searchCountEl.textContent = `${this.searchMatchIndex + 1}/${this.searchMatches.length}`;
		this.focusNode(id);
	}

	private showFeedbackToast(message: string, kind: 'ok' | 'error' | 'info'): void {
		if (!this.toastEl) {
			return;
		}
		if (this.toastTimer !== undefined) {
			clearTimeout(this.toastTimer);
		}
		this.toastEl.textContent = message;
		this.toastEl.className = `ade-canvas-feedback-toast is-${kind}`;
		this.toastEl.hidden = false;
		this.toastTimer = setTimeout(() => {
			this.toastTimer = undefined;
			this.toastEl.hidden = true;
		}, kind === 'error' ? 4500 : 2400);
	}
}
