/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType, getWindow, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IAdeCloudHostBackendService } from '../../../../platform/ade/common/adeCloudHosts.js';
import { MissionNodeRoleKind } from '../../../../platform/ade/common/adeMissionBoundary.js';
import {
	addEdgeToMermaid,
	addNodeToMermaid,
	computeMissionAutoLayout,
	getMissionEdgeKind,
	IMissionCanvasHistorySnapshot,
	IMissionDagEdge,
	IMissionDagEmployeeGroup,
	IMissionDagNode,
	IMissionNodeCheckHook,
	IMissionNodePosition,
	MissionCanvasHistoryStack,
	parseMissionMermaidDag,
	removeEdgeFromMermaid,
	removeNodeFromMermaid,
	removeNodesFromMermaid,
	renameEdgeLabelInMermaid,
	renameNodeInMermaid,
	setNodeEmployeeInMermaid,
	toggleEdgeFailInMermaid,
} from '../../../../platform/ade/common/adeMissionDag.js';
import { IMissionDagRevision, IMissionRuntimeState, IMissionToken } from '../../../../platform/ade/common/adeMissionEngine.js';
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
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ADE_ENGINEERING_SCHEME, ADE_REMOVE_MISSION_COMMAND_ID, ADE_SECRETARY_ID, IAdeAgent, IAdeEditorService, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { AdeMissionCanvasRenderer, getMissionNodeSize, getMissionSupervisorColorIndex, IMissionCanvasRenderSnapshot } from './adeMissionCanvasRenderer.js';
import { AdeMissionFileDrawer } from './adeMissionFileDrawer.js';
import { AdeMissionHostCatalog } from './adeMissionHostCatalog.js';
import { AdeMissionMinimap } from './adeMissionMinimap.js';
import { AdeMissionNodeInspector, MissionInspectorTab } from './adeMissionNodeInspector.js';
import { AdeMissionPopovers } from './adeMissionPopovers.js';
import { IAdeMissionRuntimeService } from './adeMissionRuntime.js';
import { IAdeMissionService } from './adeMissionStore.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import './media/adeMissionCanvas.css';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const DUAL_DRAWER_MIN_WIDTH = 1120;
const INSPECTOR_HUD_SAFE_INSET = 378;
const CANVAS_PAN_CLICK_THRESHOLD_PX = 5;

export interface IAdePendingMissionNodeFocus {
	readonly nodeId: string;
	readonly inspectorTab?: MissionInspectorTab;
	readonly openAgentBeside?: boolean;
}

export class AdeEngineeringEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.adeEngineering';
	override readonly resource: URI;
	private readonly missionService: IAdeMissionService | undefined;
	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;
	private pendingFocus: IAdePendingMissionNodeFocus | undefined;

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

	setPendingFocus(focus: IAdePendingMissionNodeFocus | undefined): void {
		this.pendingFocus = focus;
	}

	consumePendingFocus(): IAdePendingMissionNodeFocus | undefined {
		const next = this.pendingFocus;
		this.pendingFocus = undefined;
		return next;
	}

	override matches(other: EditorInput): boolean {
		return other instanceof AdeEngineeringEditorInput && other.governorSessionId === this.governorSessionId;
	}
}

/**
 * Workbench-wide page-visibility animation guardrail for all ADE views
 * (Mission Canvas, Sidebar Secretary Deck, Cloud Hosts Console, Session Warmup).
 * Toggles `html.ade-page-hidden` on every registered VS Code window so ALL
 * infinite CSS animations pause when a window is minimized, hidden, or occluded —
 * even when no Mission Canvas editor tab is currently open.
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
 * Lean, high-performance Mission DAG Canvas EditorPane coordinator.
 * Delegates host probing/model cataloging (`AdeMissionHostCatalog`), split Mermaid/Pre-Prompt drawer
 * & run controls (`AdeMissionFileDrawer`), floating popovers (`AdeMissionPopovers`), and
 * in-place patching SVG/DOM graph rendering (`AdeMissionCanvasRenderer`) to dedicated modules.
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
	private canvasAlertEl!: HTMLElement;
	private canvasAlertIconEl!: HTMLElement;
	private canvasAlertTextEl!: HTMLElement;
	private canvasAlertOpenFileBtn!: HTMLButtonElement;
	private supLegendEl!: HTMLElement;
	private readonly supLegendDisposables = this._register(new DisposableStore());
	private readonly supLegendChips = new Map<string, HTMLButtonElement>();
	private lastSupLegendSignature = '';
	private pinnedSupervisorId: string | undefined;
	private hoveredSupervisorId: string | undefined;
	private tabSpotlightBannerEl!: HTMLElement;
	private tabSpotlightActive = false;
	private revisionBarEl!: HTMLElement;
	private readonly revisionBarDisposables = this._register(new DisposableStore());
	private readonly revisionBtnByVersion = new Map<number, HTMLButtonElement>();
	private revisionSliderEl: HTMLInputElement | undefined;
	private revisionExitBtnEl: HTMLButtonElement | undefined;
	private lastRevisionListSignature = '';
	private previewRevisionVersion: number | undefined;
	private activeRenderNodes: readonly IMissionDagNode[] = [];
	private activeRenderPositions: ReadonlyMap<string, IMissionNodePosition> = new Map();
	private zoomSliderEl!: HTMLInputElement;
	private zoomReadoutBtnEl!: HTMLButtonElement;
	private undoBtnEl!: HTMLButtonElement;
	private redoBtnEl!: HTMLButtonElement;
	private selectModeBtnEl!: HTMLButtonElement;
	private cloudHaloToggleBtnEl!: HTMLButtonElement;
	private minimapToggleBtnEl!: HTMLButtonElement;
	private marqueeBoxEl!: HTMLElement;
	private selectionHudEl!: HTMLElement;
	private selectionHudLabelEl!: HTMLElement;
	private searchBarEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private searchCountEl!: HTMLElement;

	private fileDrawer!: AdeMissionFileDrawer;
	private popovers!: AdeMissionPopovers;
	private renderer!: AdeMissionCanvasRenderer;
	private nodeInspector!: AdeMissionNodeInspector;
	private minimap!: AdeMissionMinimap;

	private readonly historyStack = new MissionCanvasHistoryStack(50);
	private preDragHistorySnapshot: IMissionCanvasHistorySnapshot | undefined;
	private selectedNodeIds = new Set<string>();
	private selectedEdgeKey: string | undefined;
	private selectBoxMode = false;
	private searchMatchIds: string[] = [];
	private searchActiveIdx = -1;

	private activeMissionId: string | undefined;
	private activePromptEditSource: 'drawer' | 'popover' | undefined;
	private isDraggingNode = false;
	private mermaidText = '';
	private direction: 'LR' | 'TD' = 'LR';
	private nodes: readonly IMissionDagNode[] = [];
	private edges: readonly IMissionDagEdge[] = [];
	private employees: readonly IMissionDagEmployeeGroup[] = [];
	private positions = new Map<string, IMissionNodePosition>();

	private panX = 0;
	private panY = 0;
	private zoom = 1;
	private transformRafId: number | undefined;
	private edgeRerouteRafId: number | undefined;
	private pendingDraggedNodeId: string | undefined;
	private pendingDraggedMultipleNodes = false;
	private blockedCountdownTimer: number | undefined;
	private canvasAlertTimer: number | undefined;
	private lastProjectsFingerprint = '';
	private lastNodeChecksFingerprint = '';
	private isEditorTabVisible = true;
	private animationsPaused = false;
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
				if (latest.mermaidText !== this.mermaidText) {
					this.mermaidText = latest.mermaidText;
					this.fileDrawer?.setMermaidValue(this.mermaidText);
					this.parseAndRenderGraph(this.mermaidText);
				} else {
					this.syncAllNodePromptViews(this.activePromptEditSource);
					const checksFp = this.computeNodeChecksFingerprint(latest.nodeChecks);
					if (checksFp !== this.lastNodeChecksFingerprint) {
						this.lastNodeChecksFingerprint = checksFp;
						if (this.nodes.length > 0 && !this.isDraggingNode) {
							this.syncGraphDom();
						}
					}
				}
				this.syncRuntimeControlsUi();
			}));
		}

		if (this.missionRuntimeService) {
			this._register(this.missionRuntimeService.onDidChange(changedMissionId => {
				if (!this.activeMissionId || changedMissionId !== this.activeMissionId || !this.renderer) {
					return;
				}
				this.syncRuntimeControlsUi();
				if (this.nodes.length > 0 && !this.isDraggingNode) {
					this.syncGraphDom();
				}
			}));
		}

		if (this.projectsService) {
			this._register(this.projectsService.onDidChange(() => {
				if (!this.activeMissionId || this.nodes.length === 0 || this.isDraggingNode || !this.renderer) {
					return;
				}
				const nextFp = this.computeActiveMissionProjectsFingerprint();
				if (nextFp !== this.lastProjectsFingerprint) {
					this.lastProjectsFingerprint = nextFp;
					this.syncGraphDom();
					if (this.nodeInspector?.isOpen()) {
						this.nodeInspector.refresh();
					}
				}
			}));
		}

		if (this.sessionsService) {
			this._register(this.sessionsService.onDidChangeEngines(() => {
				if (this.activeMissionId && this.nodes.length > 0 && !this.isDraggingNode && this.renderer) {
					this.syncGraphDom();
					this.prewarmMissionHosts();
				}
			}));
		}

		const extensionService = tryGet(IExtensionService);
		if (extensionService) {
			void extensionService.whenInstalledExtensionsRegistered().then(() => {
				if (!this.isPaneDisposed && this.activeMissionId && this.nodes.length > 0 && !this.isDraggingNode && this.renderer) {
					this.syncGraphDom();
				}
			});
		}

		this._register(themeService.onDidColorThemeChange(() => {
			if (this.activeMissionId && this.nodes.length > 0 && !this.isDraggingNode && this.renderer) {
				this.syncGraphDom();
			}
		}));

		this._register(this.hostCatalog.onDidChangeHosts(() => {
			if (this.activeMissionId && this.nodes.length > 0 && !this.isDraggingNode && this.renderer) {
				this.syncGraphDom();
			}
		}));

		this._register({
			dispose: () => {
				this.isPaneDisposed = true;
				this.isDraggingNode = false;
				this.cancelScheduledFrames();
				this.stopBlockedCountdownTimer();
				this.clearCanvasAlertTimer();
				const doc = this.rootEl ? getWindow(this.rootEl).document : undefined;
				if (doc && !doc.hidden && doc.visibilityState !== 'hidden') {
					doc.documentElement.classList.remove('ade-page-hidden');
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

		this.fileDrawer = this._register(new AdeMissionFileDrawer(this.bodyEl, {
			getActiveMissionId: () => this.activeMissionId,
			getMermaidText: () => this.mermaidText,
			isLiveRun: () => this.isLiveRun(),
			getNodes: () => this.nodes,
			getNodePrompts: () => this.getActiveNodePrompts(),
			onMermaidDraftChange: nextText => {
				if (this.isLiveRun()) {
					return;
				}
				if (nextText !== this.mermaidText) {
					this.historyStack.push(this.captureHistorySnapshot(localize('adeMissionHistoryEditMermaid', "编辑 Mermaid")), { coalesceMs: 1200 });
					this.syncHistoryButtons();
				}
				this.mermaidText = nextText;
				if (this.activeMissionId) {
					this.missionService?.updateMermaid(this.activeMissionId, nextText);
				}
				this.parseAndRenderGraph(nextText);
			},
			onCommitLiveMermaidPatch: async nextText => {
				const missionId = this.activeMissionId;
				if (!missionId || !this.missionRuntimeService) {
					return { ok: false, error: localize('adeMissionLivePatchRejected', "Live DAG patch rejected.") };
				}
				const res = await this.missionRuntimeService.patchMermaid(missionId, {
					caller: { isHumanUser: true },
					newMermaidText: nextText,
					reason: 'Live canvas Mermaid patch',
				});
				if (this.isPaneDisposed || this.activeMissionId !== missionId) {
					return res;
				}
				if (res.ok) {
					this.mermaidText = nextText;
					this.hideCanvasAlert();
					this.parseAndRenderGraph(nextText);
				} else {
					const msg = res.error || localize('adeMissionLivePatchRejected', "Live DAG patch rejected.");
					this.showCanvasAlert(msg, 'error');
				}
				return res;
			},
			onNodePromptEdit: (nodeId, nextVal) => {
				if (!this.activeMissionId) {
					return;
				}
				this.commitNodePromptEdit(this.activeMissionId, nodeId, nextVal, 'drawer');
			},
			onPrimaryRunClick: async timeoutMinutes => {
				await this.handlePrimaryRunButtonClick(timeoutMinutes);
			},
			onStopClick: () => {
				const missionId = this.activeMissionId;
				if (!missionId || !this.missionRuntimeService) {
					return;
				}
				void this.missionRuntimeService.stop(missionId).then(res => {
					if (this.isPaneDisposed || this.activeMissionId !== missionId) {
						return;
					}
					if (!res.ok && res.error) {
						this.reportRuntimeFeedback(res.error, 'error');
					} else {
						this.hideCanvasAlert();
					}
					this.syncRuntimeControlsUi();
				}, err => {
					if (!this.isPaneDisposed && this.activeMissionId === missionId) {
						this.reportRuntimeFeedback(err instanceof Error ? err.message : String(err), 'error');
					}
				});
			},
			onTimeoutChange: async minutes => {
				await this.handleTimeoutChange(minutes);
			},
			onCutoffChange: async cutoff => {
				await this.handleCutoffChange(cutoff);
			},
			onAutoLayoutClick: () => this.resetToAutoLayout(),
			onRemoveMissionClick: () => {
				if (this.activeMissionId) {
					void this.commandService?.executeCommand(ADE_REMOVE_MISSION_COMMAND_ID, this.activeMissionId);
				}
			},
			onDrawerOpenChanged: isOpen => {
				if (isOpen && this.nodeInspector?.isOpen() && this.getPaneWidth() < DUAL_DRAWER_MIN_WIDTH) {
					this.selectNode(undefined);
				}
				this.syncHudLayoutClasses();
			},
		}));

		this.viewportEl = append(this.bodyEl, $('.ade-mission-viewport.ade-eng-viewport'));
		this.marqueeBoxEl = append(this.viewportEl, $('.ade-mission-marquee-box', {
			'data-ade-marquee-box': 'true',
		}));
		this.marqueeBoxEl.hidden = true;

		// Floating Large-DAG Node Search Bar (Cmd/Ctrl+F)
		this.searchBarEl = append(this.bodyEl, $('.ade-mission-search-bar', {
			role: 'search',
			'aria-label': localize('adeMissionSearchAria', "Search Mission Canvas Nodes"),
			'data-ade-canvas-search': 'true',
		}));
		this.searchBarEl.hidden = true;
		this._register(addDisposableListener(this.searchBarEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		append(this.searchBarEl, $('span.codicon.codicon-search.ade-mission-search-ico', { 'aria-hidden': 'true' }));
		this.searchInputEl = append(this.searchBarEl, $('input.ade-mission-search-input', {
			type: 'text',
			placeholder: localize('adeMissionSearchPlaceholder', "搜索节点 ID / 名称 / 员工 / 模型 / 提示词… (Enter 下一个)"),
			'aria-label': localize('adeMissionSearchInputAria', "Filter nodes"),
			'data-ade-canvas-search-input': 'true',
		})) as HTMLInputElement;
		this.searchCountEl = append(this.searchBarEl, $('span.ade-mission-search-count', {
			'data-ade-canvas-search-count': 'true',
		}, ''));
		const searchPrevBtn = append(this.searchBarEl, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionSearchPrevTip', "上一个匹配 (Shift+Enter)"),
			'aria-label': localize('adeMissionSearchPrevTip', "上一个匹配 (Shift+Enter)"),
			'data-ade-canvas-search-prev': 'true',
		})) as HTMLButtonElement;
		searchPrevBtn.appendChild($('span.codicon.codicon-arrow-up'));
		const searchNextBtn = append(this.searchBarEl, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionSearchNextTip', "下一个匹配 (Enter)"),
			'aria-label': localize('adeMissionSearchNextTip', "下一个匹配 (Enter)"),
			'data-ade-canvas-search-next': 'true',
		})) as HTMLButtonElement;
		searchNextBtn.appendChild($('span.codicon.codicon-arrow-down'));
		const searchCloseBtn = append(this.searchBarEl, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionSearchCloseTip', "关闭搜索 (Esc)"),
			'aria-label': localize('adeMissionSearchCloseTip', "关闭搜索 (Esc)"),
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

		// Multi-selection Action HUD Pill (shown when >= 2 nodes are box-selected or Shift-selected)
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
			title: localize('adeMissionBatchDeleteTip', "删除全部选中节点 (Delete / Backspace)"),
			'data-ade-selection-batch-delete': 'true',
		})) as HTMLButtonElement;
		batchDelBtn.appendChild($('span.codicon.codicon-trash'));
		append(batchDelBtn, $('span', {}, localize('adeMissionBatchDeleteLabel', "删除")));
		this._register(addDisposableListener(batchDelBtn, EventType.CLICK, () => {
			this.deleteSelectedItems();
		}));
		const clearSelBtn = append(this.selectionHudEl, $('button.ade-mission-selection-hud-btn', {
			type: 'button',
			title: localize('adeMissionClearSelectionTip', "取消多选 (Esc)"),
			'data-ade-selection-clear': 'true',
		})) as HTMLButtonElement;
		clearSelBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(clearSelBtn, EventType.CLICK, () => {
			this.selectNode(undefined);
		}));
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
		}, localize('adeMissionAlertOpenFile', "Open mission.mmd"))) as HTMLButtonElement;
		this.canvasAlertOpenFileBtn.hidden = true;
		this._register(addDisposableListener(this.canvasAlertOpenFileBtn, EventType.CLICK, () => {
			this.toggleFileDrawer(true);
		}));
		const alertDismissBtn = append(this.canvasAlertEl, $('button.ade-mission-canvas-alert-close', {
			type: 'button',
			title: localize('adeMissionAlertDismiss', "Dismiss"),
			'aria-label': localize('adeMissionAlertDismiss', "Dismiss"),
			'data-ade-mission-canvas-alert-dismiss': 'true',
		})) as HTMLButtonElement;
		alertDismissBtn.appendChild($('span.codicon.codicon-close'));
		this._register(addDisposableListener(alertDismissBtn, EventType.CLICK, () => {
			this.hideCanvasAlert();
		}));

		// Off-graph Supervisor Jurisdiction Legend Strip (visible whenever ≥1 supervisor is bound)
		this.supLegendEl = append(this.bodyEl, $('.ade-mission-sup-legend', {
			role: 'region',
			'aria-label': localize('adeMissionSupLegendAria', "Off-graph Supervisor Jurisdiction"),
			'data-ade-mission-sup-legend': 'true',
		}));
		this.supLegendEl.hidden = true;

		// Hold-Tab Off-Graph Supervisor X-Ray Spotlight HUD Banner
		this.tabSpotlightBannerEl = append(this.bodyEl, $('.ade-mission-tab-spotlight-banner', {
			role: 'status',
			'aria-live': 'polite',
			'data-ade-tab-spotlight-banner': 'true',
		}));
		append(this.tabSpotlightBannerEl, $('span.ade-mission-tab-spotlight-ico', { 'aria-hidden': 'true' }, '👑'));
		append(this.tabSpotlightBannerEl, $('span', {}, localize('adeMissionTabSpotlightBanner', "场外监工管辖探照灯 (X-Ray) 已开启 — 松开 Tab 键退出")));
		this.tabSpotlightBannerEl.hidden = true;

		// v1 -> vN Dynamic DAG Patch Revision Timeline Bar (shown when ≥2 topology versions exist)
		this.revisionBarEl = append(this.bodyEl, $('.ade-mission-revision-bar', {
			role: 'toolbar',
			'aria-label': localize('adeMissionRevisionBarAria', "Dynamic DAG Revision Timeline"),
			'data-ade-mission-revision-bar': 'true',
		}));
		this.revisionBarEl.hidden = true;
		this._register(addDisposableListener(this.revisionBarEl, EventType.POINTER_DOWN, e => e.stopPropagation()));

		// Dedicated Bottom-Right Viewport Controls Bar (Undo/Redo / Box-Select / Search / Zoom − / % / + / Fit / Auto Layout)
		const viewportBar = append(this.bodyEl, $('.ade-mission-viewport-bar', {
			role: 'toolbar',
			'aria-label': localize('adeMissionViewportToolbarAria', "Canvas Viewport Controls"),
			'data-ade-mission-viewport-controls': 'true',
		}));
		this._register(addDisposableListener(viewportBar, EventType.POINTER_DOWN, e => e.stopPropagation()));

		this.undoBtnEl = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionUndoTip', "撤销 (Cmd/Ctrl+Z)"),
			'aria-label': localize('adeMissionUndoAria', "Undo"),
			'data-ade-mission-undo': 'true',
		})) as HTMLButtonElement;
		this.undoBtnEl.disabled = true;
		this.undoBtnEl.appendChild($('span.codicon.codicon-discard'));
		this._register(addDisposableListener(this.undoBtnEl, EventType.CLICK, () => this.undoCanvasMutation()));

		this.redoBtnEl = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionRedoTip', "重做 (Cmd/Ctrl+Shift+Z)"),
			'aria-label': localize('adeMissionRedoAria', "Redo"),
			'data-ade-mission-redo': 'true',
		})) as HTMLButtonElement;
		this.redoBtnEl.disabled = true;
		this.redoBtnEl.appendChild($('span.codicon.codicon-redo'));
		this._register(addDisposableListener(this.redoBtnEl, EventType.CLICK, () => this.redoCanvasMutation()));

		this.selectModeBtnEl = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionSelectModeTip', "切换框选多选模式（也可按住 Shift 直接框选）"),
			'aria-label': localize('adeMissionSelectModeAria', "Toggle Box Select Mode"),
			'aria-pressed': 'false',
			'data-ade-mission-select-mode': 'true',
		})) as HTMLButtonElement;
		this.selectModeBtnEl.appendChild($('span.codicon.codicon-selection'));
		this._register(addDisposableListener(this.selectModeBtnEl, EventType.CLICK, () => {
			this.setSelectBoxMode(!this.selectBoxMode);
		}));

		const searchToggleBtn = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionSearchBtnTip', "搜索并定位节点 (Cmd/Ctrl+F)"),
			'aria-label': localize('adeMissionSearchBtnAria', "Search Nodes"),
			'data-ade-mission-search-btn': 'true',
		})) as HTMLButtonElement;
		searchToggleBtn.appendChild($('span.codicon.codicon-search'));
		this._register(addDisposableListener(searchToggleBtn, EventType.CLICK, () => {
			if (this.searchBarEl.hidden) {
				this.openCanvasSearch();
			} else {
				this.closeCanvasSearch(true);
			}
		}));

		append(viewportBar, $('span.ade-mission-vp-sep', { 'aria-hidden': 'true' }));

		const zoomOutBtn = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionZoomOutTip', "Zoom Out"),
			'aria-label': localize('adeMissionZoomOutTip', "Zoom Out"),
			'data-ade-mission-zoom-out': 'true',
		})) as HTMLButtonElement;
		zoomOutBtn.appendChild($('span.codicon.codicon-remove'));
		this._register(addDisposableListener(zoomOutBtn, EventType.CLICK, () => this.stepZoom(-0.15)));

		this.zoomSliderEl = append(viewportBar, $('input.ade-mission-vp-zoom-slider', {
			type: 'range',
			min: String(Math.round(MIN_ZOOM * 100)),
			max: String(Math.round(MAX_ZOOM * 100)),
			step: '1',
			value: '100',
			title: localize('adeMissionZoomSliderTip', "Canvas Zoom Scale"),
			'aria-label': localize('adeMissionZoomSliderTip', "Canvas Zoom Scale"),
			'data-ade-mission-zoom-slider': 'true',
		})) as HTMLInputElement;
		this._register(addDisposableListener(this.zoomSliderEl, EventType.INPUT, () => {
			const pct = Number.parseInt(this.zoomSliderEl.value, 10);
			if (Number.isFinite(pct)) {
				this.setZoomCentered(pct / 100);
			}
		}));

		this.zoomReadoutBtnEl = append(viewportBar, $('button.ade-mission-vp-zoom-readout', {
			type: 'button',
			title: localize('adeMissionZoomResetTip', "Reset zoom to 100%"),
			'data-ade-mission-zoom-label': 'true',
		}, '100%')) as HTMLButtonElement;
		this._register(addDisposableListener(this.zoomReadoutBtnEl, EventType.CLICK, () => this.resetZoomTo100()));

		const zoomInBtn = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionZoomInTip', "Zoom In"),
			'aria-label': localize('adeMissionZoomInTip', "Zoom In"),
			'data-ade-mission-zoom-in': 'true',
		})) as HTMLButtonElement;
		zoomInBtn.appendChild($('span.codicon.codicon-add'));
		this._register(addDisposableListener(zoomInBtn, EventType.CLICK, () => this.stepZoom(0.15)));

		append(viewportBar, $('span.ade-mission-vp-sep', { 'aria-hidden': 'true' }));

		const fitViewBtn = append(viewportBar, $('button.ade-mission-vp-btn.with-label', {
			type: 'button',
			title: localize('adeMissionFitViewTip', "Fit graph to viewport without changing manual node positions"),
			'aria-label': localize('adeMissionFitViewAria', "Fit to View"),
			'data-ade-mission-fit-view': 'true',
		})) as HTMLButtonElement;
		fitViewBtn.appendChild($('span.codicon.codicon-screen-full'));
		append(fitViewBtn, $('span', {}, localize('adeMissionFitViewLabel', "Fit")));
		this._register(addDisposableListener(fitViewBtn, EventType.CLICK, () => this.fitGraphToViewport()));

		const autoLayoutVpBtn = append(viewportBar, $('button.ade-mission-vp-btn', {
			type: 'button',
			title: localize('adeMissionCanvasAutoLayoutTip', "Auto Layout (resets manual node positions)"),
			'aria-label': localize('adeMissionCanvasAutoLayoutAria', "Auto Layout"),
			'data-ade-mission-canvas-autolayout': 'true',
		})) as HTMLButtonElement;
		autoLayoutVpBtn.appendChild($('span.codicon.codicon-layout'));
		this._register(addDisposableListener(autoLayoutVpBtn, EventType.CLICK, () => this.resetToAutoLayout()));

		this.cloudHaloToggleBtnEl = append(viewportBar, $('button.ade-mission-vp-btn.active', {
			type: 'button',
			title: localize('adeMissionCloudHaloToggleTip', "Toggle Cross-Cloud Compute Territory Halos"),
			'aria-label': localize('adeMissionCloudHaloToggleTip', "Toggle Cross-Cloud Compute Territory Halos"),
			'aria-pressed': 'true',
			'data-ade-mission-cloud-halo-toggle': 'true',
		})) as HTMLButtonElement;
		this.cloudHaloToggleBtnEl.appendChild($('span.codicon.codicon-cloud'));
		this._register(addDisposableListener(this.cloudHaloToggleBtnEl, EventType.CLICK, () => {
			const next = !this.renderer.isCloudTerritoriesVisible();
			const nodes = this.previewRevisionVersion !== undefined ? this.activeRenderNodes : this.nodes;
			const pos = this.previewRevisionVersion !== undefined ? this.activeRenderPositions : this.positions;
			this.renderer.setShowCloudTerritories(next, nodes, pos);
			this.cloudHaloToggleBtnEl.classList.toggle('active', next);
			this.cloudHaloToggleBtnEl.setAttribute('aria-pressed', String(next));
		}));

		this.minimapToggleBtnEl = append(viewportBar, $('button.ade-mission-vp-btn.active', {
			type: 'button',
			title: localize('adeMissionMinimapToggleTip', "Toggle Minimap Overview"),
			'aria-label': localize('adeMissionMinimapToggleTip', "Toggle Minimap Overview"),
			'aria-pressed': 'true',
			'data-ade-mission-minimap-toggle': 'true',
		})) as HTMLButtonElement;
		this.minimapToggleBtnEl.appendChild($('span.codicon.codicon-map'));
		this._register(addDisposableListener(this.minimapToggleBtnEl, EventType.CLICK, () => {
			const next = !this.minimap.isUserVisible();
			this.minimap.setUserVisible(next);
			this.minimapToggleBtnEl.classList.toggle('active', next);
			this.minimapToggleBtnEl.setAttribute('aria-pressed', String(next));
		}));

		this.minimap = this._register(new AdeMissionMinimap(this.bodyEl, {
			onNavigateToWorldCenter: (worldX, worldY) => {
				if (!this.viewportEl) {
					return;
				}
				const rect = this.viewportEl.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) {
					return;
				}
				this.panX = rect.width / 2 - worldX * this.zoom;
				this.panY = rect.height / 2 - worldY * this.zoom;
				this.scheduleWorldTransform();
			},
		}));

		this.emptyHintEl = append(this.viewportEl, $('.ade-mission-empty-hint', {
			'data-ade-mission-empty-onboarding': 'true',
		}));
		this._register(addDisposableListener(this.emptyHintEl, EventType.POINTER_DOWN, e => e.stopPropagation()));
		const emptyHero = append(this.emptyHintEl, $('.ade-mission-empty-hero'));
		const hintIcon = append(emptyHero, $('span.codicon.codicon-type-hierarchy-sub', { 'aria-hidden': 'true' }));
		hintIcon.setAttribute('aria-hidden', 'true');
		append(emptyHero, $('.ade-mission-empty-hint-title', {}, localize('adeMissionEmptyTitle', "开始编排多 Agent Mission DAG")));
		append(emptyHero, $('.ade-mission-empty-hint-sub', {}, localize('adeMissionEmptySub', "点击下方按钮、右键画布空白处或打开左上角源码抽屉，快速构建多 Agent 协作流图。")));

		const emptyActions = append(this.emptyHintEl, $('.ade-mission-empty-actions'));
		const emptyAddTaskBtn = append(emptyActions, $('button.ade-mission-empty-action-btn.primary', {
			type: 'button',
			'data-ade-empty-add-task': 'true',
		})) as HTMLButtonElement;
		emptyAddTaskBtn.appendChild($('span.codicon.codicon-add'));
		append(emptyAddTaskBtn, $('span', {}, localize('adeMissionEmptyAddTask', "新建任务节点")));
		this._register(addDisposableListener(emptyAddTaskBtn, EventType.CLICK, () => this.addVisualNode({ kind: 'task' })));

		const emptyAddRevBtn = append(emptyActions, $('button.ade-mission-empty-action-btn', {
			type: 'button',
			'data-ade-empty-add-reviewer': 'true',
		})) as HTMLButtonElement;
		emptyAddRevBtn.appendChild($('span.codicon.codicon-shield'));
		append(emptyAddRevBtn, $('span', {}, localize('adeMissionEmptyAddReviewer', "新建审稿 Reviewer")));
		this._register(addDisposableListener(emptyAddRevBtn, EventType.CLICK, () => this.addVisualNode({ kind: 'task', roleKind: 'reviewer' })));

		const emptyAddGateBtn = append(emptyActions, $('button.ade-mission-empty-action-btn', {
			type: 'button',
			'data-ade-empty-add-gate': 'true',
		})) as HTMLButtonElement;
		emptyAddGateBtn.appendChild($('span.codicon.codicon-law'));
		append(emptyAddGateBtn, $('span', {}, localize('adeMissionEmptyAddGate', "新建人工 Gate")));
		this._register(addDisposableListener(emptyAddGateBtn, EventType.CLICK, () => this.addVisualNode({ kind: 'gate' })));

		const emptyOpenMermaidBtn = append(emptyActions, $('button.ade-mission-empty-action-btn', {
			type: 'button',
			'data-ade-empty-open-mermaid': 'true',
		})) as HTMLButtonElement;
		emptyOpenMermaidBtn.appendChild($('span.codicon.codicon-file-code'));
		append(emptyOpenMermaidBtn, $('span', {}, localize('adeMissionEmptyOpenMermaid', "编辑 Mermaid 源码")));
		this._register(addDisposableListener(emptyOpenMermaidBtn, EventType.CLICK, () => this.toggleFileDrawer(true)));

		this.worldEl = append(this.viewportEl, $('.ade-mission-world.ade-eng-world'));

		this.renderer = this._register(new AdeMissionCanvasRenderer(
			this.worldEl,
			this.emptyHintEl,
			this.hostCatalog,
			{
				onHoverNode: nodeId => this.setHoveredNode(nodeId),
				onHoverToken: token => this.handleHoverToken(token),
				onHoverSupervisor: supId => this.setHoveredSupervisor(supId),
				onSelectNode: (node, _anchorEl, opts) => this.selectNode(node.id, opts),
				onSelectEdge: edge => this.selectEdge(edge),
				onDoubleClickNode: (_node, agentId) => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId);
					}
				},
				onOpenEmployeePopover: (node, anchorEl) => {
					this.popovers.openEmployeePopover(this.activeMissionId, node, this.employees, anchorEl);
				},
				onOpenSupervisorPopover: (node, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openSupervisorPopover(this.activeMissionId, node, anchorEl);
					}
				},
				onOpenModelPopover: (nodeId, agent, engineId, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openModelPopover(this.activeMissionId, nodeId, agent, engineId, anchorEl);
					}
				},
				onOpenEnginePopover: (nodeId, agent, engineId, anchorEl) => {
					if (this.activeMissionId) {
						void this.popovers.openEnginePopover(this.activeMissionId, nodeId, agent, engineId, anchorEl);
					}
				},
				onOpenHostPopover: (node, currentHost, anchorEl) => {
					if (this.activeMissionId) {
						void this.popovers.openHostPopover(this.activeMissionId, node, currentHost, anchorEl);
					}
				},
				onOpenNodePromptPopover: (node, anchorEl) => {
					if (this.activeMissionId) {
						this.fileDrawer.setSelectedPromptNodeId(node.id);
						this.popovers.openNodePromptPopover(this.activeMissionId, node, anchorEl);
						this.syncAllNodePromptViews('popover');
					}
				},
				onOpenNodeTriggersPopover: (node, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openTriggersPopover(this.activeMissionId, this.nodes, this.edges, anchorEl, node.id);
					}
				},
				onOpenGateDecisionPopover: (node, anchorEl, preferredTokenId, options) => {
					if (this.activeMissionId) {
						this.popovers.openGateDecisionPopover(this.activeMissionId, node, anchorEl, preferredTokenId, options);
					}
				},
				onQuickGateApprove: (node, token, anchorEl) => {
					if (!this.activeMissionId || !this.missionRuntimeService) {
						return;
					}
					const btnEl = anchorEl.tagName === 'BUTTON' ? anchorEl as HTMLButtonElement : undefined;
					if (btnEl?.disabled) {
						return;
					}
					if (btnEl) {
						btnEl.disabled = true;
					}
					void this.missionRuntimeService.resolveGate(this.activeMissionId, {
						nodeId: node.id,
						tokenId: token?.id,
						decision: 'approve',
					}).then(res => {
						if (btnEl) {
							btnEl.disabled = false;
						}
						if (res.ok) {
							this.popovers.close();
						} else if (res.error) {
							this.reportRuntimeFeedback(res.error, 'error');
						}
					}, err => {
						if (btnEl) {
							btnEl.disabled = false;
						}
						const msg = err instanceof Error ? err.message : String(err);
						this.reportRuntimeFeedback(msg, 'error');
					});
				},
				onOpenTokenInspectorPopover: (node, token, allNodeTokens, anchorEl) => {
					if (this.activeMissionId) {
						const linkedAgent = this.buildAgentNodeMap().get(node.id);
						this.popovers.openTokenInspectorPopover(this.activeMissionId, node, token, allNodeTokens, linkedAgent?.id, anchorEl);
					}
				},
				onQuickRetryNode: (node, token) => {
					void this.handleQuickRetryNode(node, token);
				},
				onOpenGuidedRetryPopover: (node, token, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openGuidedRetryPopover(this.activeMissionId, node, token, anchorEl);
					}
				},
				onQuickRecallNode: (node, token) => {
					void this.handleQuickRecallNode(node, token);
				},
				onRenameNode: (nodeId, nextLabel) => {
					this.renameVisualNode(nodeId, nextLabel);
				},
				onRenameEdgeLabel: (fromId, toId, nextLabel) => {
					this.renameVisualEdgeLabel(fromId, toId, nextLabel);
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
				getEffectiveNodeChecksCount: nodeId => {
					if (!this.activeMissionId || !this.missionRuntimeService) {
						return 0;
					}
					return (this.missionRuntimeService.getEffectiveNodeChecks(this.activeMissionId, nodeId)[nodeId] ?? []).length;
				},
				isRevisionPreview: () => this.previewRevisionVersion !== undefined,
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
					if (this.previewRevisionVersion !== undefined) {
						return;
					}
					this.popovers.close();
					this.isDraggingNode = true;
					this.preDragHistorySnapshot = this.captureHistorySnapshot(localize('adeMissionHistoryMoveNode', "移动节点"));
				},
				onDragNodeMove: (nodeId, nextPos) => {
					if (this.previewRevisionVersion !== undefined) {
						return;
					}
					this.positions.set(nodeId, nextPos);
					this.scheduleEdgeReroute(nodeId);
				},
				onDragNodesMove: moves => {
					if (this.previewRevisionVersion !== undefined || moves.length === 0) {
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
				getNodePosition: nodeId => (this.previewRevisionVersion !== undefined ? this.activeRenderPositions.get(nodeId) : this.positions.get(nodeId)),
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
				getExplicitNodeHost: (missionId, nodeId) => this.missionRuntimeService?.getRuntimeState(missionId).boundary.nodeAssignments[nodeId]?.hostAlias,
				resolveSupervisorDisplay: supId => this.resolveSupervisorDisplay(supId),
				onAssignNodeEmployee: (nodeId, empName) => this.assignNodeEmployee(nodeId, empName),
				onNodePromptEdit: (missionId, nodeId, nextVal) => this.commitNodePromptEdit(missionId, nodeId, nextVal, 'popover'),
				onOpenDrawerForNodePrompt: nodeId => this.toggleFileDrawer(true, nodeId),
				onOpenAgentSession: agentId => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId);
					}
				},
				onHoverSupervisor: supId => this.setHoveredSupervisor(supId),
				onQuickRetryNode: (node, token, guidance) => this.handleQuickRetryNode(node, token, guidance),
				onActionFeedback: (message, kind) => this.reportRuntimeFeedback(message, kind),
				onGraphVisualInvalidated: prewarmHosts => {
					if (this.isPaneDisposed) {
						return;
					}
					this.syncGraphDom();
					this.nodeInspector?.refresh();
					if (prewarmHosts) {
						this.prewarmMissionHosts();
					}
				},
				onRuntimeControlsInvalidated: () => this.syncRuntimeControlsUi(),
			},
		));

		this.nodeInspector = this._register(new AdeMissionNodeInspector(
			this.bodyEl,
			this.hostCatalog,
			this.projectsService,
			this.missionRuntimeService,
			this.roleSchemaService,
			{
				getActiveMissionId: () => this.activeMissionId,
				getNodes: () => this.nodes,
				getEdges: () => this.edges,
				getAgentForNode: nodeId => this.buildAgentNodeMap().get(nodeId),
				getHostByNodeIdMap: () => this.buildHostByNodeIdMap(),
				getFallbackOwnerEngineId: () => {
					const missionRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
					const ownerAgent = missionRec?.ownerSessionId ? this.projectsService?.getAgent(missionRec.ownerSessionId) : undefined;
					return ownerAgent?.session?.engineId ?? ownerAgent?.preferredEngineId ?? 'aexus-claude';
				},
				getNodePrompt: (missionId, nodeId) => this.missionService?.getMission(missionId)?.nodePrompts?.[nodeId] ?? '',
				resolveSupervisorDisplay: supId => this.resolveSupervisorDisplay(supId),
				canSwitchAgentEngine: agent => this.canSwitchAgentEngine(agent),
				onClose: () => {
					this.selectedNodeIds.clear();
					this.renderer?.setSelectedNodeIds([]);
					this.syncSelectionHud();
					this.syncHudLayoutClasses();
					this.minimap?.setInspectorOpen(false);
					this.syncMinimapGraph();
				},
				onSelectNodeFromInspector: nodeId => {
					this.selectNode(nodeId);
				},
				onOpenAgentBeside: agentId => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId, { side: true });
					}
				},
				onOpenAgentTab: agentId => {
					if (this.adeEditorService) {
						void this.adeEditorService.openAgent(agentId);
					}
				},
				onOpenEmployeePopover: (node, anchorEl) => {
					this.popovers.openEmployeePopover(this.activeMissionId, node, this.employees, anchorEl);
				},
				onOpenSupervisorPopover: (node, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openSupervisorPopover(this.activeMissionId, node, anchorEl);
					}
				},
				onOpenHostPopover: (node, currentHost, anchorEl) => {
					if (this.activeMissionId) {
						void this.popovers.openHostPopover(this.activeMissionId, node, currentHost, anchorEl);
					}
				},
				onOpenModelPopover: (nodeId, agent, engineId, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openModelPopover(this.activeMissionId, nodeId, agent, engineId, anchorEl);
					}
				},
				onOpenEnginePopover: (nodeId, agent, engineId, anchorEl) => {
					if (this.activeMissionId) {
						void this.popovers.openEnginePopover(this.activeMissionId, nodeId, agent, engineId, anchorEl);
					}
				},
				onOpenNodePromptPopover: (node, anchorEl) => {
					if (this.activeMissionId) {
						this.fileDrawer.setSelectedPromptNodeId(node.id);
						this.popovers.openNodePromptPopover(this.activeMissionId, node, anchorEl);
						this.syncAllNodePromptViews('popover');
					}
				},
				onOpenTriggersPopover: (preferredNodeId, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openTriggersPopover(this.activeMissionId, this.nodes, this.edges, anchorEl, preferredNodeId);
					}
				},
				onOpenTokenInspectorPopover: (node, token, allNodeTokens, anchorEl) => {
					if (this.activeMissionId) {
						const linkedAgent = this.buildAgentNodeMap().get(node.id);
						this.popovers.openTokenInspectorPopover(this.activeMissionId, node, token, allNodeTokens, linkedAgent?.id, anchorEl);
					}
				},
				onOpenGateDecisionPopover: (node, anchorEl) => {
					if (this.activeMissionId) {
						this.popovers.openGateDecisionPopover(this.activeMissionId, node, anchorEl);
					}
				},
				onQuickRetryNode: (node, token, guidance) => {
					void this.handleQuickRetryNode(node, token, guidance);
				},
				onQuickRecallNode: (node, token) => {
					void this.handleQuickRecallNode(node, token);
				},
				onDistillNodeContext: (node, memo) => {
					void this.handleDistillNodeContext(node, memo);
				},
				onRunNodeChecks: node => {
					void this.handleRunNodeChecks(node);
				},
				onToggleNodeRoleKind: (node, nextRoleKind) => {
					void this.handleToggleNodeRoleKind(node, nextRoleKind);
				},
				onUpsertNodeCheck: (nodeId, check) => {
					this.handleUpsertNodeCheck(nodeId, check);
				},
				onRemoveNodeCheck: (nodeId, checkId) => {
					this.handleRemoveNodeCheck(nodeId, checkId);
				},
				onSetBudgetLimit: limitUsd => {
					void this.handleSetBudgetLimit(limitUsd);
				},
				onRaiseAndResumeBudget: nextLimitUsd => {
					void this.handleRaiseAndResumeBudget(nextLimitUsd);
				},
			},
		));

		this.installCanvasInteractions();
		this.applyWorldTransformNow();
	}

	private getPaneWidth(): number {
		const rectW = this.bodyEl?.getBoundingClientRect().width ?? 0;
		if (rectW > 0) {
			return rectW;
		}
		return this.rootEl?.offsetWidth || 1280;
	}

	private getEffectiveRuntimeState(): IMissionRuntimeState | undefined {
		return this.activeMissionId ? this.missionRuntimeService?.getRuntimeState(this.activeMissionId) : undefined;
	}

	private syncHudLayoutClasses(): void {
		if (!this.bodyEl) {
			return;
		}
		this.bodyEl.classList.toggle('has-inspector-open', Boolean(this.nodeInspector?.isOpen()));
		this.bodyEl.classList.toggle('has-file-drawer-open', Boolean(this.fileDrawer?.isOpen()));
		this.bodyEl.classList.toggle('has-sup-legend', Boolean(this.supLegendEl && !this.supLegendEl.hidden));
		this.bodyEl.classList.toggle('has-canvas-alert', Boolean(this.canvasAlertEl && !this.canvasAlertEl.hidden));
		this.bodyEl.classList.toggle('has-search-open', Boolean(this.searchBarEl && !this.searchBarEl.hidden));
		this.bodyEl.classList.toggle('has-revision-bar', Boolean(this.revisionBarEl && !this.revisionBarEl.hidden));
	}

	/**
	 * Gently pans the canvas when opening the right-side 352px Inspector would occlude
	 * the selected node (or if the node sits outside the safe visible canvas corridor).
	 */
	private ensureNodeVisibleBesideInspector(nodeId: string): void {
		if (!this.viewportEl || !this.nodeInspector?.isOpen()) {
			return;
		}
		const node = this.nodes.find(n => n.id === nodeId);
		const pos = this.positions.get(nodeId);
		if (!node || !pos) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		const vpW = rect.width;
		const vpH = rect.height;
		if (vpW < 240 || vpH < 160) {
			return;
		}
		const sz = getMissionNodeSize(node);
		const halfW = (sz.width / 2) * this.zoom;
		const halfH = (sz.height / 2) * this.zoom;
		const screenLeft = this.panX + pos.x * this.zoom - halfW;
		const screenRight = this.panX + pos.x * this.zoom + halfW;
		const screenTop = this.panY + pos.y * this.zoom - halfH;
		const screenBottom = this.panY + pos.y * this.zoom + halfH;

		const safeLeft = 24;
		const safeRight = vpW - INSPECTOR_HUD_SAFE_INSET;
		const safeTop = 66;
		const safeBottom = vpH - 64;

		let nextPanX = this.panX;
		let nextPanY = this.panY;

		if (safeRight > safeLeft + 40) {
			if (screenRight > safeRight) {
				const shift = safeRight - screenRight;
				if (screenLeft + shift >= safeLeft) {
					nextPanX += shift;
				} else {
					const corridorCenterX = (safeLeft + safeRight) / 2;
					nextPanX = corridorCenterX - pos.x * this.zoom;
				}
			} else if (screenLeft < safeLeft) {
				const shift = safeLeft - screenLeft;
				if (screenRight + shift <= safeRight) {
					nextPanX += shift;
				} else {
					const corridorCenterX = (safeLeft + safeRight) / 2;
					nextPanX = corridorCenterX - pos.x * this.zoom;
				}
			}
		}

		if (safeBottom > safeTop + 40) {
			if (screenTop < safeTop) {
				nextPanY += safeTop - screenTop;
			} else if (screenBottom > safeBottom) {
				nextPanY -= screenBottom - safeBottom;
			}
		}

		if (Math.round(nextPanX) !== Math.round(this.panX) || Math.round(nextPanY) !== Math.round(this.panY)) {
			this.panX = Math.round(nextPanX);
			this.panY = Math.round(nextPanY);
			this.applyWorldTransformNow();
		}
	}

	toggleFileDrawer(forceOpen?: boolean, focusNodeId?: string): void {
		this.fileDrawer?.toggle(forceOpen, focusNodeId);
		if (this.fileDrawer?.isOpen() && this.nodeInspector?.isOpen() && this.getPaneWidth() < DUAL_DRAWER_MIN_WIDTH) {
			this.selectNode(undefined);
		}
		this.syncHudLayoutClasses();
	}

	setHoveredNode(nodeId: string | undefined): void {
		if (!this.renderer || this.renderer.getHoveredNodeId() === nodeId) {
			return;
		}
		const nodes = this.previewRevisionVersion !== undefined ? this.activeRenderNodes : this.nodes;
		const positions = this.previewRevisionVersion !== undefined ? this.activeRenderPositions : this.positions;
		this.renderer.applyHoverHighlight(nodeId, nodes, positions);
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
			const size = getMissionNodeSize(node);
			minX = Math.min(minX, pos.x - size.width / 2);
			maxX = Math.max(maxX, pos.x + size.width / 2);
			minY = Math.min(minY, pos.y - size.height / 2);
			maxY = Math.max(maxY, pos.y + size.height / 2);
		}
		if (!Number.isFinite(minX)) {
			return;
		}
		const padLeft = 72;
		const padRight = this.nodeInspector?.isOpen() ? 380 : 72;
		const padTop = 88;
		const padBottom = 64;
		const availW = Math.max(120, rect.width - padLeft - padRight);
		const availH = Math.max(120, rect.height - padTop - padBottom);
		const graphW = Math.max(1, maxX - minX);
		const graphH = Math.max(1, maxY - minY);
		const scaleX = availW / graphW;
		const scaleY = availH / graphH;
		this.zoom = Math.round(Math.min(1, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY))) * 100) / 100;
		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		const targetCenterX = padLeft + availW / 2;
		const targetCenterY = padTop + availH / 2;
		this.panX = Math.round(targetCenterX - centerX * this.zoom);
		this.panY = Math.round(targetCenterY - centerY * this.zoom);
		this.applyWorldTransformNow();
	}

	/**
	 * Deep-jumps the Mission Canvas to a specific node (e.g. from Inbox `Open Node ↗`):
	 * exits revision preview, closes blocking drawers/popovers, centers the viewport onto the node,
	 * highlights it with a spotlight pulse, opens the right-side Inspector on the requested tab,
	 * and optionally opens the bound employee Agent chat beside the canvas.
	 */
	focusNode(
		nodeId: string,
		options?: { readonly inspectorTab?: MissionInspectorTab; readonly openAgentBeside?: boolean },
	): void {
		if (this.isPaneDisposed || !nodeId) {
			return;
		}
		if (this.previewRevisionVersion !== undefined) {
			this.exitRevisionPreview();
		}
		if (this.fileDrawer?.isOpen()) {
			this.fileDrawer.toggle(false);
		}
		this.popovers?.close();

		const targetNode = this.nodes.find(n => n.id === nodeId);
		if (!targetNode) {
			return;
		}

		const tab: MissionInspectorTab = options?.inspectorTab ?? 'token';
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		this.selectedNodeIds = new Set([targetNode.id]);
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.syncSelectionHud();
		this.nodeInspector?.open(targetNode.id, tab);
		this.minimap?.setInspectorOpen(true);

		const pos = this.positions.get(targetNode.id);
		if (pos && this.viewportEl) {
			const rect = this.viewportEl.getBoundingClientRect();
			const vpW = rect.width > 40 ? rect.width : 1080;
			const vpH = rect.height > 40 ? rect.height : 720;
			const inspectorW = this.nodeInspector?.isOpen() ? 336 : 0;
			const availW = Math.max(160, vpW - inspectorW);
			this.zoom = Math.round(Math.min(1.15, Math.max(0.85, this.zoom)) * 100) / 100;
			this.panX = Math.round(availW / 2 - pos.x * this.zoom);
			this.panY = Math.round(vpH / 2 - pos.y * this.zoom);
			this.applyWorldTransformNow();
		}

		this.renderer?.pulseFocusNode(targetNode.id, 3000);
		this.syncMinimapGraph();

		if (options?.openAgentBeside && this.adeEditorService) {
			const linkedAgent = this.buildAgentNodeMap().get(targetNode.id);
			if (linkedAgent) {
				void this.adeEditorService.openAgent(linkedAgent.id, { side: true });
			}
		}
	}

	private isLiveRun(): boolean {
		if (!this.activeMissionId || !this.missionRuntimeService) {
			return false;
		}
		const status = this.missionRuntimeService.getRuntimeState(this.activeMissionId).status;
		return status === 'running' || status === 'paused';
	}

	private canSwitchAgentEngine(agent: IAdeAgent): boolean {
		if (!this.projectsService || !this.sessionsService || agent.session) {
			return false;
		}
		return !this.isLiveRun();
	}

	private getActiveNodePrompts(): Readonly<Record<string, string>> {
		return (this.activeMissionId ? this.missionService?.getMission(this.activeMissionId)?.nodePrompts : undefined) ?? {};
	}

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
		const prompts = this.getActiveNodePrompts();
		this.renderer?.syncNodePromptPreviews(prompts);
		this.fileDrawer?.syncPromptsPane(source === 'drawer');
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
			}, 4000);
		}
	}

	private hideCanvasAlert(): void {
		this.clearCanvasAlertTimer();
		if (this.canvasAlertEl) {
			this.canvasAlertEl.hidden = true;
		}
		this.syncHudLayoutClasses();
	}

	private reportRuntimeFeedback(message: string, kind: 'error' | 'ok' | 'info', options?: { readonly offerOpenFile?: boolean }): void {
		this.fileDrawer?.setStatus(message, kind === 'info' ? undefined : kind);
		this.showCanvasAlert(message, kind, options);
	}

	private handleHoverToken(token: IMissionToken | undefined): void {
		if (!this.renderer) {
			return;
		}
		if (!token || !this.activeMissionId || !this.missionRuntimeService) {
			this.renderer.setTraceHighlightEdges(undefined);
			return;
		}
		const rt = this.missionRuntimeService.getRuntimeState(this.activeMissionId);
		const traceEntries = this.missionRuntimeService.expandTrace(this.activeMissionId, token.tracePtr, 100);
		const edgeKeys = new Set<string>();
		if (token.fromNodeId && token.fromNodeId !== token.nodeId) {
			edgeKeys.add(`${token.fromNodeId}->${token.nodeId}`);
		}
		for (const entry of traceEntries) {
			for (const parentPtr of entry.parentPtrs) {
				const parent = rt.traces[parentPtr];
				if (parent && parent.nodeId !== entry.nodeId) {
					edgeKeys.add(`${parent.nodeId}->${entry.nodeId}`);
				}
			}
		}
		this.renderer.setTraceHighlightEdges(edgeKeys);
	}

	private async handleQuickRetryNode(node: IMissionDagNode, token: IMissionToken, guidance?: string): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.retryToken(missionId, {
			caller: { isHumanUser: true },
			tokenId: token.id,
			nodeId: node.id,
			...(guidance ? { guidance } : {}),
		}).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (res.ok) {
			this.reportRuntimeFeedback(localize('adeMissionQuickRetryOk', "Retried node {0}.", node.id), 'ok');
		} else {
			this.reportRuntimeFeedback(res.error ?? localize('adeMissionQuickRetryFail', "Failed to retry node {0}.", node.id), 'error');
		}
	}

	private async handleDistillNodeContext(node: IMissionDagNode, memo?: string): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.distillNodeContext(missionId, node.id, memo ? { memo } : undefined)
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (res.ok) {
			this.reportRuntimeFeedback(localize('adeMissionDistillOk', "节点 {0} 已完成提纯换血并刷新干净会话。", node.id), 'ok');
		} else {
			this.reportRuntimeFeedback(res.error ?? localize('adeMissionDistillFail', "节点 {0} 提纯换血失败。", node.id), 'error');
		}
		this.syncRuntimeControlsUi();
		this.syncGraphDom();
	}

	private async handleRunNodeChecks(node: IMissionDagNode): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.runNodeChecks(missionId, node.id)
			.catch(err => ({ passed: false, summary: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		this.reportRuntimeFeedback(
			res.summary || (res.passed
				? localize('adeMissionNodeChecksOk', "节点 {0} 确定性验收全部通过。", node.id)
				: localize('adeMissionNodeChecksFail', "节点 {0} 确定性验收未通过。", node.id)),
			res.passed ? 'ok' : 'error',
		);
		this.syncRuntimeControlsUi();
	}

	private computeNodeChecksFingerprint(nodeChecks: Readonly<Record<string, readonly IMissionNodeCheckHook[]>> | undefined): string {
		if (!nodeChecks) {
			return '';
		}
		return Object.keys(nodeChecks)
			.sort()
			.map(nid => `${nid}:${(nodeChecks[nid] ?? []).map(c => `${c.id}|${c.name ?? ''}|${c.command ?? ''}|${(c.expectFiles ?? []).join(',')}|${c.onFail ?? ''}`).join(';')}`)
			.join('\x1e');
	}

	private clientToWorldPos(clientX: number, clientY: number): IMissionNodePosition {
		const rect = this.viewportEl.getBoundingClientRect();
		const z = this.zoom > 0 ? this.zoom : 1;
		return {
			x: Math.round((clientX - rect.left - this.panX) / z),
			y: Math.round((clientY - rect.top - this.panY) / z),
		};
	}

	private computeDefaultNewNodeWorldPos(): IMissionNodePosition {
		if (this.nodes.length === 0) {
			return { x: 260, y: 200 };
		}
		let maxX = -Infinity;
		let sumY = 0;
		let count = 0;
		for (const node of this.nodes) {
			const pos = this.positions.get(node.id);
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
		return { x: Math.round(maxX + 310), y: Math.round(sumY / count) };
	}

	private captureHistorySnapshot(label: string): IMissionCanvasHistorySnapshot {
		const rec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const positions: Record<string, IMissionNodePosition> = {};
		for (const [nid, pos] of this.positions.entries()) {
			positions[nid] = { x: pos.x, y: pos.y };
		}
		if (Object.keys(positions).length === 0 && rec?.positions) {
			for (const [nid, pos] of Object.entries(rec.positions)) {
				positions[nid] = { x: pos.x, y: pos.y };
			}
		}
		const nodePrompts: Record<string, string> = {};
		if (rec?.nodePrompts) {
			for (const [nid, val] of Object.entries(rec.nodePrompts)) {
				nodePrompts[nid] = val;
			}
		}
		const nodeChecks: Record<string, readonly IMissionNodeCheckHook[]> = {};
		if (rec?.nodeChecks) {
			for (const [nid, list] of Object.entries(rec.nodeChecks)) {
				nodeChecks[nid] = list.map(c => ({ ...c, ...(c.expectFiles ? { expectFiles: [...c.expectFiles] } : {}) }));
			}
		}
		return {
			mermaidText: this.mermaidText,
			positions,
			nodePrompts,
			nodeChecks,
			label,
		};
	}

	private syncHistoryButtons(): void {
		if (this.undoBtnEl) {
			this.undoBtnEl.disabled = !this.historyStack.canUndo();
			const undoLabel = this.historyStack.peekUndoLabel();
			this.undoBtnEl.title = undoLabel
				? localize('adeMissionUndoSpecificTip', "撤销「{0}」(Cmd/Ctrl+Z)", undoLabel)
				: localize('adeMissionUndoTip', "撤销 (Cmd/Ctrl+Z)");
		}
		if (this.redoBtnEl) {
			this.redoBtnEl.disabled = !this.historyStack.canRedo();
			const redoLabel = this.historyStack.peekRedoLabel();
			this.redoBtnEl.title = redoLabel
				? localize('adeMissionRedoSpecificTip', "重做「{0}」(Cmd/Ctrl+Shift+Z)", redoLabel)
				: localize('adeMissionRedoTip', "重做 (Cmd/Ctrl+Shift+Z)");
		}
	}

	private applyHistorySnapshot(snapshot: IMissionCanvasHistorySnapshot, direction: 'undo' | 'redo'): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		if (this.previewRevisionVersion !== undefined) {
			this.exitRevisionPreview();
		}
		const existingRec = this.missionService?.getMission(missionId);

		// Restore positions atomically
		this.missionService?.clearNodePositions(missionId);
		this.positions.clear();
		if (Object.keys(snapshot.positions).length > 0) {
			for (const [nid, pos] of Object.entries(snapshot.positions)) {
				this.positions.set(nid, { x: pos.x, y: pos.y });
			}
			this.missionService?.updateNodePositions(missionId, snapshot.positions);
		}

		// Restore Mermaid source
		this.mermaidText = snapshot.mermaidText;
		this.fileDrawer.setMermaidValue(snapshot.mermaidText);
		this.missionService?.updateMermaid(missionId, snapshot.mermaidText);

		// Restore node prompts (explicitly clearing keys that did not exist in snapshot)
		if (this.missionService) {
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

			// Restore node checks
			const allCheckNodeIds = new Set<string>([
				...Object.keys(existingRec?.nodeChecks ?? {}),
				...Object.keys(snapshot.nodeChecks),
			]);
			for (const nid of allCheckNodeIds) {
				this.missionService.updateNodeChecks(missionId, nid, snapshot.nodeChecks[nid] ?? []);
			}
			this.lastNodeChecksFingerprint = this.computeNodeChecksFingerprint(this.missionService.getMission(missionId)?.nodeChecks);
		}

		this.parseAndRenderGraph(snapshot.mermaidText, false);
		this.syncAllNodePromptViews();
		this.syncHistoryButtons();
		this.reportRuntimeFeedback(
			direction === 'undo'
				? localize('adeMissionUndoFeedback', "已撤销：{0}", snapshot.label)
				: localize('adeMissionRedoFeedback', "已重做：{0}", snapshot.label),
			'info',
		);
	}

	private undoCanvasMutation(): void {
		if (!this.activeMissionId || !this.historyStack.canUndo()) {
			return;
		}
		if (this.isLiveRun()) {
			this.reportRuntimeFeedback(localize('adeMissionUndoBlockedLive', "Mission 运行中暂不支持整图撤销，请先停止当前运行。"), 'error');
			return;
		}
		const prev = this.historyStack.undo(this.captureHistorySnapshot(''));
		if (prev) {
			this.applyHistorySnapshot(prev, 'undo');
		}
	}

	private redoCanvasMutation(): void {
		if (!this.activeMissionId || !this.historyStack.canRedo()) {
			return;
		}
		if (this.isLiveRun()) {
			this.reportRuntimeFeedback(localize('adeMissionRedoBlockedLive', "Mission 运行中暂不支持整图重做，请先停止当前运行。"), 'error');
			return;
		}
		const next = this.historyStack.redo(this.captureHistorySnapshot(''));
		if (next) {
			this.applyHistorySnapshot(next, 'redo');
		}
	}

	private handleEndNodesDrag(movedNodeIds: readonly string[], movedPx: number): void {
		const preSnap = this.preDragHistorySnapshot;
		this.preDragHistorySnapshot = undefined;
		if (this.previewRevisionVersion !== undefined) {
			this.isDraggingNode = false;
			return;
		}
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
				const label = movedNodeIds.length > 1
					? localize('adeMissionHistoryMoveNodesBatch', "批量移动 {0} 个节点", movedNodeIds.length)
					: localize('adeMissionHistoryMoveNodeSingle', "移动节点 {0}", movedNodeIds[0]);
				this.historyStack.push({ ...preSnap, label });
				this.syncHistoryButtons();
			}
			if (Object.keys(updates).length > 0) {
				this.missionService?.updateNodePositions(this.activeMissionId, updates);
			}
		}
	}

	private setSelectBoxMode(enabled: boolean): void {
		this.selectBoxMode = enabled;
		this.viewportEl?.classList.toggle('is-select-mode', enabled);
		if (this.selectModeBtnEl) {
			this.selectModeBtnEl.classList.toggle('active', enabled);
			this.selectModeBtnEl.setAttribute('aria-pressed', String(enabled));
		}
	}

	private syncSelectionHud(): void {
		if (!this.selectionHudEl) {
			return;
		}
		if (this.selectedNodeIds.size > 1) {
			this.selectionHudEl.hidden = false;
			const label = localize('adeMissionMultiSelectHudText', "已选 {0} 个节点 · 拖拽批量移动 / Delete 删除", this.selectedNodeIds.size);
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
		const inspectorW = this.nodeInspector?.isOpen() ? 336 : 0;
		const availW = Math.max(160, vpW - inspectorW);
		if (this.zoom < 0.75) {
			this.zoom = 0.85;
		}
		this.panX = Math.round(availW / 2 - pos.x * this.zoom);
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
		const agentMap = this.buildAgentNodeMap();
		const prompts = this.getActiveNodePrompts();
		const hostMap = this.buildHostByNodeIdMap();
		const matches: string[] = [];
		for (const node of this.nodes) {
			const agent = agentMap.get(node.id);
			const haystack = [
				node.id,
				node.label,
				node.employeeName ?? '',
				agent?.label ?? '',
				agent?.preferredModel ?? '',
				agent?.preferredEngineId ?? '',
				agent?.session?.engineId ?? '',
				hostMap.get(node.id) ?? '',
				prompts[node.id] ?? '',
			].join('\n').toLowerCase();
			if (haystack.includes(query)) {
				matches.push(node.id);
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

	private commitVisualMermaidMutation(
		nextMermaid: string,
		reason: string,
		options?: {
			readonly nodePosition?: { readonly nodeId: string; readonly pos: IMissionNodePosition };
			readonly clearPositions?: boolean;
			readonly successMessage?: string;
			readonly afterApply?: () => void;
			readonly skipHistory?: boolean;
		},
	): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		if (this.previewRevisionVersion !== undefined) {
			this.exitRevisionPreview();
		}
		const preSnapshot = !options?.skipHistory ? this.captureHistorySnapshot(reason) : undefined;
		if (this.isLiveRun() && this.missionRuntimeService) {
			void this.missionRuntimeService.patchMermaid(missionId, {
				caller: { isHumanUser: true },
				newMermaidText: nextMermaid,
				reason,
			}).then(res => {
				if (this.isPaneDisposed || this.activeMissionId !== missionId) {
					return;
				}
				if (res.ok) {
					if (preSnapshot) {
						this.historyStack.push(preSnapshot);
						this.syncHistoryButtons();
					}
					if (options?.clearPositions) {
						this.missionService?.clearNodePositions(missionId);
						this.positions.clear();
					}
					if (options?.nodePosition) {
						this.positions.set(options.nodePosition.nodeId, options.nodePosition.pos);
						this.missionService?.updateNodePositions(missionId, { [options.nodePosition.nodeId]: options.nodePosition.pos });
					}
					this.mermaidText = nextMermaid;
					this.fileDrawer.setMermaidValue(nextMermaid);
					this.parseAndRenderGraph(nextMermaid, Boolean(options?.clearPositions));
					options?.afterApply?.();
					if (options?.successMessage) {
						this.reportRuntimeFeedback(options.successMessage, 'ok');
					}
				} else {
					this.reportRuntimeFeedback(res.error ?? localize('adeMissionLivePatchRejected', "Live DAG patch rejected."), 'error');
				}
			}, err => {
				if (!this.isPaneDisposed && this.activeMissionId === missionId) {
					this.reportRuntimeFeedback(err instanceof Error ? err.message : String(err), 'error');
				}
			});
			return;
		}

		if (preSnapshot) {
			this.historyStack.push(preSnapshot);
			this.syncHistoryButtons();
		}
		if (options?.clearPositions) {
			this.missionService?.clearNodePositions(missionId);
			this.positions.clear();
		}
		if (options?.nodePosition) {
			this.positions.set(options.nodePosition.nodeId, options.nodePosition.pos);
			this.missionService?.updateNodePositions(missionId, { [options.nodePosition.nodeId]: options.nodePosition.pos });
		}
		this.mermaidText = nextMermaid;
		this.fileDrawer.setMermaidValue(nextMermaid);
		this.missionService?.updateMermaid(missionId, nextMermaid);
		this.parseAndRenderGraph(nextMermaid, Boolean(options?.clearPositions));
		options?.afterApply?.();
		if (options?.successMessage) {
			this.reportRuntimeFeedback(options.successMessage, 'ok');
		}
	}

	private addVisualNode(options: {
		readonly kind: 'task' | 'gate';
		readonly roleKind?: MissionNodeRoleKind;
		readonly worldPos?: IMissionNodePosition;
	}): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const targetPos = options.worldPos ?? this.computeDefaultNewNodeWorldPos();
		const added = addNodeToMermaid(this.mermaidText, {
			kind: options.kind,
			roleHint: options.roleKind,
			direction: this.direction,
		});
		this.commitVisualMermaidMutation(added.mermaidText, `Add node ${added.nodeId}`, {
			nodePosition: { nodeId: added.nodeId, pos: targetPos },
			successMessage: localize('adeMissionVisualAddNodeOk', "已添加节点 {0}（双击标题可改名，拖拽右端口可连线）。", added.nodeId),
			afterApply: () => {
				// Clear any stale prompt/check residue if this node ID was previously deleted.
				if (this.missionService) {
					const existingRec = this.missionService.getMission(missionId);
					if (existingRec?.nodePrompts?.[added.nodeId]) {
						this.missionService.updateNodePrompt(missionId, added.nodeId, '');
					}
					if (existingRec?.nodeChecks?.[added.nodeId]?.length) {
						this.missionService.updateNodeChecks(missionId, added.nodeId, []);
						this.lastNodeChecksFingerprint = this.computeNodeChecksFingerprint(this.missionService.getMission(missionId)?.nodeChecks);
					}
					this.syncAllNodePromptViews();
				}
				if (options.kind === 'task' && options.roleKind === 'reviewer' && this.missionRuntimeService) {
					void this.missionRuntimeService.bindNodeHost(missionId, added.nodeId, { roleKind: 'reviewer' }).then(() => {
						if (!this.isPaneDisposed && this.activeMissionId === missionId) {
							this.syncGraphDom();
							this.nodeInspector?.refresh();
						}
					}, () => undefined);
				}
			},
		});
	}

	private renameVisualNode(nodeId: string, nextLabel: string): void {
		const nextMermaid = renameNodeInMermaid(this.mermaidText, nodeId, nextLabel);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitVisualMermaidMutation(nextMermaid, `Rename node ${nodeId}`, {
			successMessage: localize('adeMissionVisualRenameOk', "已将节点 {0} 重命名为「{1}」。", nodeId, nextLabel),
		});
	}

	private deleteVisualNode(nodeId: string): void {
		this.deleteVisualNodes([nodeId]);
	}

	private deleteVisualNodes(nodeIds: readonly string[]): void {
		const missionId = this.activeMissionId;
		const uniqueIds = [...new Set(nodeIds.map(id => id.trim()).filter(Boolean))];
		if (uniqueIds.length === 0) {
			return;
		}
		const nextMermaid = uniqueIds.length === 1
			? removeNodeFromMermaid(this.mermaidText, uniqueIds[0])
			: removeNodesFromMermaid(this.mermaidText, uniqueIds);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		const reason = uniqueIds.length === 1
			? localize('adeMissionHistoryDeleteNode', "删除节点 {0}", uniqueIds[0])
			: localize('adeMissionHistoryDeleteNodes', "批量删除 {0} 个节点", uniqueIds.length);
		this.commitVisualMermaidMutation(nextMermaid, reason, {
			successMessage: uniqueIds.length === 1
				? localize('adeMissionVisualDeleteNodeOk', "已删除节点 {0}。", uniqueIds[0])
				: localize('adeMissionVisualDeleteNodesOk', "已批量删除 {0} 个节点。", uniqueIds.length),
			afterApply: () => {
				if (missionId && this.missionService) {
					for (const nid of uniqueIds) {
						this.missionService.updateNodePrompt(missionId, nid, '');
						this.missionService.updateNodeChecks(missionId, nid, []);
					}
					this.lastNodeChecksFingerprint = this.computeNodeChecksFingerprint(this.missionService.getMission(missionId)?.nodeChecks);
					this.syncAllNodePromptViews();
				}
				const removedSet = new Set(uniqueIds);
				for (const nid of removedSet) {
					this.selectedNodeIds.delete(nid);
				}
				const curInspectorNode = this.nodeInspector?.getSelectedNodeId();
				if (curInspectorNode && removedSet.has(curInspectorNode)) {
					this.nodeInspector.close(false);
					this.minimap?.setInspectorOpen(false);
				}
				this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
				this.syncSelectionHud();
			},
		});
	}

	private renameVisualEdgeLabel(fromId: string, toId: string, nextLabel: string): void {
		const nextMermaid = renameEdgeLabelInMermaid(this.mermaidText, fromId, toId, nextLabel);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		const clean = nextLabel.trim();
		this.commitVisualMermaidMutation(nextMermaid, localize('adeMissionHistoryEditEdgeLabel', "修改连线 {0}→{1} 标签", fromId, toId), {
			successMessage: clean
				? localize('adeMissionVisualRenameEdgeOk', "已将连线 {0} → {1} 标签更新为「{2}」。", fromId, toId, clean)
				: localize('adeMissionVisualClearEdgeLabelOk', "已清空连线 {0} → {1} 的标签。", fromId, toId),
		});
	}

	private deleteSelectedItems(): void {
		if (!this.activeMissionId || this.previewRevisionVersion !== undefined) {
			return;
		}
		if (this.selectedEdgeKey) {
			const edge = this.edges.find(e => `${e.from}->${e.to}` === this.selectedEdgeKey);
			this.selectEdge(undefined);
			if (edge) {
				this.deleteVisualEdge(edge.from, edge.to);
			}
			return;
		}
		if (this.selectedNodeIds.size > 0) {
			this.deleteVisualNodes([...this.selectedNodeIds]);
		}
	}

	private connectVisualEdge(fromId: string, toId: string, options?: { readonly fail?: boolean }): void {
		const res = addEdgeToMermaid(
			this.mermaidText,
			fromId,
			toId,
			options?.fail ? { kind: 'fail', label: 'fail' } : undefined,
		);
		if (!res.ok || !res.mermaidText) {
			this.reportRuntimeFeedback(res.error ?? localize('adeMissionVisualConnectFail', "无法建立连线。"), 'error');
			return;
		}
		this.commitVisualMermaidMutation(res.mermaidText, `Connect ${fromId} -> ${toId}`, {
			successMessage: options?.fail
				? localize('adeMissionVisualConnectFailEdgeOk', "已建立异常兜底边 {0} --|fail|--> {1}。", fromId, toId)
				: localize('adeMissionVisualConnectOk', "已建立连线 {0} → {1}。", fromId, toId),
		});
	}

	private deleteVisualEdge(fromId: string, toId: string): void {
		const nextMermaid = removeEdgeFromMermaid(this.mermaidText, fromId, toId);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitVisualMermaidMutation(nextMermaid, `Delete edge ${fromId} -> ${toId}`, {
			successMessage: localize('adeMissionVisualDeleteEdgeOk', "已删除连线 {0} → {1}。", fromId, toId),
		});
	}

	private toggleVisualEdgeFail(fromId: string, toId: string): void {
		const nextMermaid = toggleEdgeFailInMermaid(this.mermaidText, fromId, toId);
		if (nextMermaid === this.mermaidText) {
			return;
		}
		this.commitVisualMermaidMutation(nextMermaid, `Toggle fail edge ${fromId} -> ${toId}`, {
			successMessage: localize('adeMissionVisualToggleEdgeOk', "已切换连线 {0} → {1} 类型。", fromId, toId),
		});
	}

	private openNodeContextMenu(node: IMissionDagNode, clientX: number, clientY: number): void {
		const missionId = this.activeMissionId;
		if (!missionId || this.previewRevisionVersion !== undefined) {
			return;
		}
		const rt = this.missionRuntimeService?.getRuntimeState(missionId);
		const currentRole: MissionNodeRoleKind = rt?.boundary.nodeAssignments[node.id]?.roleKind ?? 'worker';
		const items: {
			readonly id: string;
			readonly label: string;
			readonly icon?: string;
			readonly danger?: boolean;
			readonly separatorBefore?: boolean;
			readonly run: () => void;
		}[] = [
				{
					id: 'rename-node',
					label: localize('adeMissionCtxRenameNode', "Rename"),
					icon: 'edit',
					run: () => this.renderer.startInlineNodeRename(node.id),
				},
				{
					id: 'inspect-node',
					label: localize('adeMissionCtxInspectNode', "Inspect"),
					icon: 'info',
					run: () => this.openInspectorTab('overview', node.id),
				},
			];
		if (node.kind !== 'gate') {
			items.push(
				{
					id: 'toggle-role',
					label: currentRole === 'reviewer'
						? localize('adeMissionCtxSwitchWorker', "Set as Worker")
						: localize('adeMissionCtxSwitchReviewer', "Set as Reviewer"),
					icon: 'shield',
					run: () => void this.handleToggleNodeRoleKind(node, currentRole === 'reviewer' ? 'worker' : 'reviewer'),
				},
				{
					id: 'manage-checks',
					label: localize('adeMissionCtxManageChecks', "Checks…"),
					icon: 'checklist',
					run: () => this.openInspectorTab('distill', node.id),
				},
			);
		}
		items.push({
			id: 'delete-node',
			label: localize('adeMissionCtxDeleteNode', "Delete {0}", node.id),
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			run: () => this.deleteVisualNode(node.id),
		});
		this.popovers.openCanvasContextMenu(clientX, clientY, items);
	}

	private openEdgeContextMenu(edge: IMissionDagEdge, clientX: number, clientY: number): void {
		if (!this.activeMissionId || this.previewRevisionVersion !== undefined) {
			return;
		}
		const isFail = getMissionEdgeKind(edge) === 'fail';
		this.popovers.openCanvasContextMenu(clientX, clientY, [
			{
				id: 'edit-edge-label',
				label: localize('adeMissionCtxEditEdgeLabel', "Edit Label"),
				icon: 'edit',
				run: () => this.renderer.startInlineEdgeLabelEdit(edge.id),
			},
			{
				id: 'toggle-edge-fail',
				label: isFail
					? localize('adeMissionCtxEdgeToSuccess', "Mark as Normal Edge")
					: localize('adeMissionCtxEdgeToFail', "Mark as Fail Edge"),
				icon: 'arrow-swap',
				run: () => this.toggleVisualEdgeFail(edge.from, edge.to),
			},
			{
				id: 'delete-edge',
				label: localize('adeMissionCtxDeleteEdge', "Delete Edge"),
				icon: 'trash',
				danger: true,
				separatorBefore: true,
				run: () => this.deleteVisualEdge(edge.from, edge.to),
			},
		]);
	}

	private async handleToggleNodeRoleKind(node: IMissionDagNode, nextRoleKind: MissionNodeRoleKind): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.bindNodeHost(missionId, node.id, { roleKind: nextRoleKind })
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (res.ok) {
			this.reportRuntimeFeedback(
				nextRoleKind === 'reviewer'
					? localize('adeMissionRoleReviewerOk', "节点 {0} 已设为图内审稿 Reviewer。", node.id)
					: localize('adeMissionRoleWorkerOk', "节点 {0} 已切回执行 Worker。", node.id),
				'ok',
			);
		} else if (res.error) {
			this.reportRuntimeFeedback(res.error, 'error');
		}
		this.syncGraphDom();
		this.nodeInspector?.refresh();
	}

	private handleUpsertNodeCheck(nodeId: string, check: IMissionNodeCheckHook): void {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionService) {
			return;
		}
		this.missionService.upsertNodeCheck(missionId, nodeId, check);
		this.lastNodeChecksFingerprint = this.computeNodeChecksFingerprint(this.missionService.getMission(missionId)?.nodeChecks);
		this.reportRuntimeFeedback(localize('adeMissionCheckSavedOk', "已为节点 {0} 添加确定性验收钩子「{1}」。", nodeId, check.name || check.id), 'ok');
		this.syncGraphDom();
		this.nodeInspector?.refresh();
	}

	private handleRemoveNodeCheck(nodeId: string, checkId: string): void {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionService) {
			return;
		}
		this.missionService.removeNodeCheck(missionId, nodeId, checkId);
		this.lastNodeChecksFingerprint = this.computeNodeChecksFingerprint(this.missionService.getMission(missionId)?.nodeChecks);
		this.reportRuntimeFeedback(localize('adeMissionCheckRemovedOk', "已移除节点 {0} 的验收钩子。", nodeId), 'ok');
		this.syncGraphDom();
		this.nodeInspector?.refresh();
	}

	private async handleSetBudgetLimit(budgetLimitUsd: number | undefined): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.setBudgetLimit(missionId, budgetLimitUsd)
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok && res.error) {
			this.reportRuntimeFeedback(res.error, 'error');
		} else {
			this.reportRuntimeFeedback(
				budgetLimitUsd !== undefined
					? localize('adeMissionBudgetSetOk', "FinOps 预算熔断上限已设为 ${0}。", budgetLimitUsd.toFixed(2))
					: localize('adeMissionBudgetUnlimitedOk', "FinOps 预算熔断已切换为不设上限。"),
				'ok',
			);
		}
		this.syncRuntimeControlsUi();
	}

	private async handleRaiseAndResumeBudget(nextLimitUsd: number): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const budgetRes = await this.missionRuntimeService.setBudgetLimit(missionId, nextLimitUsd)
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!budgetRes.ok && budgetRes.error) {
			this.reportRuntimeFeedback(budgetRes.error, 'error');
			this.syncRuntimeControlsUi();
			return;
		}
		const resumeRes = await this.missionRuntimeService.resume(missionId)
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (resumeRes.ok) {
			this.reportRuntimeFeedback(localize('adeMissionBudgetResumedOk', "预算已上调至 ${0} 并恢复 Mission 运行。", nextLimitUsd.toFixed(2)), 'ok');
		} else if (resumeRes.error) {
			this.reportRuntimeFeedback(resumeRes.error, 'error');
		}
		this.syncRuntimeControlsUi();
	}

	private async handleQuickRecallNode(node: IMissionDagNode, token: IMissionToken | undefined): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.recallTokens(missionId, {
			caller: { isHumanUser: true },
			nodeIds: [node.id],
			reason: token ? `Recalled ${token.id} from Mission canvas` : `Recalled ${node.id} from Mission canvas`,
		}).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (res.ok) {
			this.reportRuntimeFeedback(localize('adeMissionQuickRecallOk', "Recalled node {0}.", node.id), 'ok');
		} else {
			this.reportRuntimeFeedback(res.error ?? localize('adeMissionQuickRecallFail', "Failed to recall node {0}.", node.id), 'error');
		}
	}

	private stopBlockedCountdownTimer(): void {
		if (this.blockedCountdownTimer !== undefined) {
			const win = this.rootEl ? getWindow(this.rootEl) : undefined;
			win?.clearInterval(this.blockedCountdownTimer);
			this.blockedCountdownTimer = undefined;
		}
	}

	private syncAnimationPauseState(): void {
		if (this.isPaneDisposed || !this.rootEl) {
			return;
		}
		const win = getWindow(this.rootEl);
		const doc = win.document;
		const pageHidden = Boolean(doc.hidden || doc.visibilityState === 'hidden');
		doc.documentElement.classList.toggle('ade-page-hidden', pageHidden);
		const paused = pageHidden || !this.isEditorTabVisible;
		const wasPaused = this.animationsPaused;
		this.animationsPaused = paused;
		this.rootEl.classList.toggle('ade-animations-paused', paused);
		if (paused) {
			this.rootEl.setAttribute('data-animations-paused', 'true');
			this.stopBlockedCountdownTimer();
		} else {
			this.rootEl.removeAttribute('data-animations-paused');
		}
		this.renderer?.setAnimationsPaused(paused);
		if (!paused && wasPaused && this.activeMissionId) {
			const latest = this.getEffectiveRuntimeState();
			if (latest) {
				const now = Date.now();
				this.renderer?.patchBlockedCountdowns(latest, now);
				this.popovers?.patchOpenTokenCountdown(latest, now);
				this.nodeInspector?.patchBlockedCountdowns(latest, now);
				this.reconcileBlockedTimer(latest);
			}
		}
	}

	private reconcileBlockedTimer(runtimeState: IMissionRuntimeState | undefined): void {
		if (this.isPaneDisposed || this.animationsPaused) {
			this.stopBlockedCountdownTimer();
			return;
		}
		const hasBlocked = Boolean(runtimeState && Object.values(runtimeState.tokens).some(t => t.status === 'blocked' && Boolean(t.blocked)));
		if (hasBlocked && this.blockedCountdownTimer === undefined && this.rootEl) {
			this.blockedCountdownTimer = getWindow(this.rootEl).setInterval(() => {
				if (this.isPaneDisposed || this.animationsPaused || !this.activeMissionId || !this.missionRuntimeService) {
					this.stopBlockedCountdownTimer();
					return;
				}
				const latest = this.missionRuntimeService.getRuntimeState(this.activeMissionId);
				const now = Date.now();
				this.renderer?.patchBlockedCountdowns(latest, now);
				this.popovers?.patchOpenTokenCountdown(latest, now);
				this.nodeInspector?.patchBlockedCountdowns(latest, now);
				if (!Object.values(latest.tokens).some(t => t.status === 'blocked' && Boolean(t.blocked))) {
					this.stopBlockedCountdownTimer();
				}
			}, 1000);
		} else if (!hasBlocked && this.blockedCountdownTimer !== undefined) {
			this.stopBlockedCountdownTimer();
		}
	}

	private resolveSupervisorDisplay(supervisorId: string): { readonly label: string; readonly shortLabel: string; readonly tier: number } {
		if (supervisorId === ADE_SECRETARY_ID) {
			return { label: 'Secretary', shortLabel: 'Secretary', tier: 0 };
		}
		const agent = this.projectsService?.getAgent(supervisorId);
		const label = agent?.label?.trim() || supervisorId;
		const shortLabel = label.length > 14 ? `${label.slice(0, 12)}…` : label;
		const org = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		const tier = agent
			? resolveEffectiveRankDefinition(org, agent.role, this.projectsService?.hasSubordinates(agent.id) ?? false).tier
			: 1;
		return { label, shortLabel, tier };
	}

	private openInspectorTab(tab: MissionInspectorTab, nodeId?: string): void {
		const targetNodeId = nodeId ?? this.nodeInspector?.getSelectedNodeId();
		if (this.fileDrawer?.isOpen() && this.getPaneWidth() < DUAL_DRAWER_MIN_WIDTH) {
			this.fileDrawer.toggle(false);
		}
		if (targetNodeId) {
			this.selectedEdgeKey = undefined;
			this.renderer?.setSelectedEdgeKey(undefined);
			this.selectedNodeIds = new Set([targetNodeId]);
			this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
			this.syncSelectionHud();
		}
		this.nodeInspector?.open(targetNodeId, tab);
		this.syncHudLayoutClasses();
		this.minimap?.setInspectorOpen(true);
		if (targetNodeId) {
			this.ensureNodeVisibleBesideInspector(targetNodeId);
		}
		this.syncMinimapGraph();
	}

	private buildHostByNodeIdMap(): Map<string, string> {
		const map = new Map<string, string>();
		const runtimeState = this.activeMissionId && this.missionRuntimeService
			? this.missionRuntimeService.getRuntimeState(this.activeMissionId)
			: undefined;
		const agentMap = this.buildAgentNodeMap();
		for (const node of this.nodes) {
			if (node.kind === 'gate') {
				continue;
			}
			const explicitHost = runtimeState?.boundary.nodeAssignments[node.id]?.hostAlias;
			const hostInfo = this.hostCatalog.resolveNodeHostAndOs(explicitHost, agentMap.get(node.id));
			map.set(node.id, hostInfo.hostAlias || 'local');
		}
		return map;
	}

	private setTabSpotlight(active: boolean): void {
		if (this.tabSpotlightActive === active) {
			return;
		}
		this.tabSpotlightActive = active;
		if (this.tabSpotlightBannerEl) {
			this.tabSpotlightBannerEl.hidden = !active;
		}
		const state = this.activeMissionId && this.missionRuntimeService
			? this.missionRuntimeService.getRuntimeState(this.activeMissionId)
			: undefined;
		const nodes = this.previewRevisionVersion !== undefined ? this.activeRenderNodes : this.nodes;
		const positions = this.previewRevisionVersion !== undefined ? this.activeRenderPositions : this.positions;
		this.renderer?.setTabSpotlightActive(
			active,
			nodes,
			positions,
			state,
			supId => this.resolveSupervisorDisplay(supId),
		);
	}

	private syncRevisionTimelineBar(state: IMissionRuntimeState | undefined): void {
		if (!this.revisionBarEl) {
			return;
		}
		const revisions = state?.revisions ?? [];
		if (revisions.length < 2) {
			const wasPreviewing = this.previewRevisionVersion !== undefined;
			if (wasPreviewing) {
				this.previewRevisionVersion = undefined;
				this.renderer?.setPreviewAddedNodeIds(undefined);
				this.syncGraphDom(true);
			}
			this.revisionBarEl.hidden = true;
			this.lastRevisionListSignature = '';
			this.revisionBarDisposables.clear();
			this.revisionBtnByVersion.clear();
			this.revisionSliderEl = undefined;
			this.revisionExitBtnEl = undefined;
			clearNode(this.revisionBarEl);
			this.syncHudLayoutClasses();
			return;
		}
		const latestVersion = revisions[revisions.length - 1].version;
		if (this.previewRevisionVersion !== undefined && !revisions.some(r => r.version === this.previewRevisionVersion)) {
			this.previewRevisionVersion = undefined;
			this.renderer?.setPreviewAddedNodeIds(undefined);
		}
		const activeVersion = this.previewRevisionVersion ?? latestVersion;
		const isPreviewing = this.previewRevisionVersion !== undefined && this.previewRevisionVersion !== latestVersion;
		const activeIndex = Math.max(0, revisions.findIndex(r => r.version === activeVersion));

		const listSig = `${this.activeMissionId ?? ''}|${revisions.map(r => `${r.version}:${r.timestamp}:${r.reason}:${r.nodeCount}:${r.edgeCount}:${(r.addedNodeIds ?? []).join(',')}:${(r.removedNodeIds ?? []).join(',')}`).join('|')}`;
		this.revisionBarEl.hidden = false;
		this.revisionBarEl.classList.toggle('is-previewing', isPreviewing);
		this.syncHudLayoutClasses();

		// Patch active selection, slider value, and exit button IN PLACE so continuous slider dragging never tears down DOM or drops focus!
		if (listSig === this.lastRevisionListSignature && this.revisionSliderEl) {
			for (const [ver, btn] of this.revisionBtnByVersion.entries()) {
				const isCurrent = ver === activeVersion;
				btn.classList.toggle('active', isCurrent);
				btn.setAttribute('aria-pressed', String(isCurrent));
			}
			if (this.revisionSliderEl.value !== String(activeIndex)) {
				this.revisionSliderEl.value = String(activeIndex);
			}
			if (this.revisionExitBtnEl) {
				this.revisionExitBtnEl.hidden = !isPreviewing;
			}
			return;
		}

		this.lastRevisionListSignature = listSig;
		this.revisionBarDisposables.clear();
		this.revisionBtnByVersion.clear();
		this.revisionSliderEl = undefined;
		this.revisionExitBtnEl = undefined;
		clearNode(this.revisionBarEl);

		append(this.revisionBarEl, $('span.ade-mission-rev-title', {}, localize('adeMissionRevTimelineTitle', "DAG 时间轴")));
		const pillsWrap = append(this.revisionBarEl, $('.ade-mission-rev-pills'));
		for (let i = 0; i < revisions.length; i++) {
			const rev = revisions[i];
			const isLatest = i === revisions.length - 1;
			const isCurrent = rev.version === activeVersion;
			if (i > 0) {
				append(pillsWrap, $('span.ade-mission-rev-arrow', { 'aria-hidden': 'true' }, '▸'));
			}
			const tipParts = [
				`v${rev.version}: ${rev.reason}`,
				`${rev.nodeCount} nodes · ${rev.edgeCount} edges`,
				rev.addedNodeIds && rev.addedNodeIds.length > 0 ? `+ ${rev.addedNodeIds.join(', ')}` : undefined,
				rev.removedNodeIds && rev.removedNodeIds.length > 0 ? `- ${rev.removedNodeIds.join(', ')}` : undefined,
			].filter((v): v is string => Boolean(v));
			const revBtn = append(pillsWrap, $(`button.ade-mission-rev-btn${isCurrent ? '.active' : ''}${isLatest ? '.is-live' : ''}`, {
				type: 'button',
				'data-ade-revision-btn': String(rev.version),
				'aria-pressed': String(isCurrent),
				title: tipParts.join('\n'),
			}, isLatest ? `v${rev.version} Live` : `v${rev.version}`)) as HTMLButtonElement;
			this.revisionBtnByVersion.set(rev.version, revBtn);
			this.revisionBarDisposables.add(addDisposableListener(revBtn, EventType.CLICK, () => {
				this.enterRevisionPreview(rev, isLatest);
			}));
		}

		const slider = append(this.revisionBarEl, $('input.ade-mission-rev-slider', {
			type: 'range',
			min: '0',
			max: String(revisions.length - 1),
			step: '1',
			value: String(activeIndex),
			title: localize('adeMissionRevSliderTip', "Scrub DAG topology revisions (v1 → v{0})", latestVersion),
			'aria-label': localize('adeMissionRevSliderTip', "Scrub DAG topology revisions (v1 → v{0})", latestVersion),
			'data-ade-revision-slider': 'true',
		})) as HTMLInputElement;
		this.revisionSliderEl = slider;
		this.revisionBarDisposables.add(addDisposableListener(slider, EventType.INPUT, () => {
			const idx = Number.parseInt(slider.value, 10);
			const target = revisions[idx];
			if (target) {
				this.enterRevisionPreview(target, idx === revisions.length - 1);
			}
		}));

		const exitBtn = append(this.revisionBarEl, $('button.ade-mission-rev-exit-btn', {
			type: 'button',
			'data-ade-revision-exit': 'true',
		}, localize('adeMissionRevBackToLive', "返回实时"))) as HTMLButtonElement;
		exitBtn.hidden = !isPreviewing;
		this.revisionExitBtnEl = exitBtn;
		this.revisionBarDisposables.add(addDisposableListener(exitBtn, EventType.CLICK, () => {
			this.exitRevisionPreview();
		}));
	}

	private enterRevisionPreview(rev: IMissionDagRevision, isLatest: boolean): void {
		if (isLatest) {
			this.exitRevisionPreview();
			return;
		}
		this.previewRevisionVersion = rev.version;
		this.renderer?.setPreviewAddedNodeIds(rev.addedNodeIds && rev.addedNodeIds.length > 0 ? new Set(rev.addedNodeIds) : undefined);
		this.syncGraphDom(true);
		const st = this.activeMissionId && this.missionRuntimeService
			? this.missionRuntimeService.getRuntimeState(this.activeMissionId)
			: undefined;
		this.syncRevisionTimelineBar(st);
	}

	private exitRevisionPreview(): void {
		if (this.previewRevisionVersion === undefined) {
			return;
		}
		this.previewRevisionVersion = undefined;
		this.renderer?.setPreviewAddedNodeIds(undefined);
		this.syncGraphDom(true);
		const st = this.activeMissionId && this.missionRuntimeService
			? this.missionRuntimeService.getRuntimeState(this.activeMissionId)
			: undefined;
		this.syncRevisionTimelineBar(st);
	}

	private selectNode(nodeId: string | undefined, options?: { readonly toggleMulti?: boolean }): void {
		this.selectedEdgeKey = undefined;
		this.renderer?.setSelectedEdgeKey(undefined);
		if (!nodeId) {
			this.selectedNodeIds.clear();
			this.nodeInspector?.close(false);
			this.renderer?.setSelectedNodeIds([]);
			this.syncSelectionHud();
			this.syncHudLayoutClasses();
			this.minimap?.setInspectorOpen(false);
			this.syncMinimapGraph();
			return;
		}
		if (options?.toggleMulti) {
			if (this.selectedNodeIds.has(nodeId)) {
				this.selectedNodeIds.delete(nodeId);
			} else {
				this.selectedNodeIds.add(nodeId);
			}
			this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
			this.syncSelectionHud();
			if (this.selectedNodeIds.size === 1) {
				const onlyId = [...this.selectedNodeIds][0];
				if (this.fileDrawer?.isOpen() && this.getPaneWidth() < DUAL_DRAWER_MIN_WIDTH) {
					this.fileDrawer.toggle(false);
				}
				this.nodeInspector?.open(onlyId);
				this.syncHudLayoutClasses();
				this.minimap?.setInspectorOpen(true);
				this.ensureNodeVisibleBesideInspector(onlyId);
			} else {
				this.nodeInspector?.close(false);
				this.syncHudLayoutClasses();
				this.minimap?.setInspectorOpen(false);
			}
			this.syncMinimapGraph();
			return;
		}
		if (this.fileDrawer?.isOpen() && this.getPaneWidth() < DUAL_DRAWER_MIN_WIDTH) {
			this.fileDrawer.toggle(false);
		}
		this.selectedNodeIds = new Set([nodeId]);
		this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
		this.syncSelectionHud();
		this.nodeInspector?.open(nodeId);
		this.syncHudLayoutClasses();
		this.minimap?.setInspectorOpen(true);
		this.ensureNodeVisibleBesideInspector(nodeId);
		this.syncMinimapGraph();
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
		if (this.selectedNodeIds.size === 1) {
			const onlyId = [...this.selectedNodeIds][0];
			if (this.fileDrawer?.isOpen() && this.getPaneWidth() < DUAL_DRAWER_MIN_WIDTH) {
				this.fileDrawer.toggle(false);
			}
			this.nodeInspector?.open(onlyId);
			this.syncHudLayoutClasses();
			this.minimap?.setInspectorOpen(true);
			this.ensureNodeVisibleBesideInspector(onlyId);
		} else {
			this.nodeInspector?.close(false);
			this.syncHudLayoutClasses();
			this.minimap?.setInspectorOpen(false);
		}
		this.syncMinimapGraph();
	}

	private selectEdge(edge: IMissionDagEdge | undefined): void {
		if (!edge) {
			this.selectedEdgeKey = undefined;
			this.renderer?.setSelectedEdgeKey(undefined);
			return;
		}
		if (this.selectedNodeIds.size > 0 || this.nodeInspector?.isOpen()) {
			this.selectedNodeIds.clear();
			this.nodeInspector?.close(false);
			this.renderer?.setSelectedNodeIds([]);
			this.syncSelectionHud();
			this.syncHudLayoutClasses();
			this.minimap?.setInspectorOpen(false);
			this.syncMinimapGraph();
		}
		this.selectedEdgeKey = `${edge.from}->${edge.to}`;
		this.renderer?.setSelectedEdgeKey(this.selectedEdgeKey);
	}

	private setHoveredSupervisor(supervisorId: string | undefined): void {
		this.hoveredSupervisorId = supervisorId;
		this.renderer?.setHighlightedSupervisorId(this.hoveredSupervisorId ?? this.pinnedSupervisorId);
	}

	private togglePinnedSupervisor(supervisorId: string): void {
		this.pinnedSupervisorId = this.pinnedSupervisorId === supervisorId ? undefined : supervisorId;
		this.renderer?.setHighlightedSupervisorId(this.hoveredSupervisorId ?? this.pinnedSupervisorId);
		for (const [id, chip] of this.supLegendChips.entries()) {
			chip.classList.toggle('is-pinned', this.pinnedSupervisorId === id);
		}
	}

	private syncSupervisorLegend(state: IMissionRuntimeState | undefined): void {
		if (!this.supLegendEl) {
			return;
		}
		const allSups = state?.boundary.supervisors ?? [];
		const referencedParentIds = new Set(allSups.map(s => s.parentSupervisorId).filter((id): id is string => Boolean(id)));
		const boundSups = allSups.filter(s => s.managedNodeIds.length > 0 || referencedParentIds.has(s.id));
		if (boundSups.length === 0) {
			this.supLegendEl.hidden = true;
			this.syncHudLayoutClasses();
			if (this.pinnedSupervisorId) {
				this.pinnedSupervisorId = undefined;
				this.renderer?.setHighlightedSupervisorId(this.hoveredSupervisorId);
			}
			this.lastSupLegendSignature = '';
			this.supLegendDisposables.clear();
			this.supLegendChips.clear();
			clearNode(this.supLegendEl);
			return;
		}
		if (this.pinnedSupervisorId && !boundSups.some(s => s.id === this.pinnedSupervisorId)) {
			this.pinnedSupervisorId = undefined;
			this.renderer?.setHighlightedSupervisorId(this.hoveredSupervisorId);
		}
		const sig = boundSups.map(s => `${s.id}:${s.tier}:${s.parentSupervisorId ?? ''}:${s.managedNodeIds.join(',')}`).join(';');
		this.supLegendEl.hidden = false;
		this.syncHudLayoutClasses();
		if (sig === this.lastSupLegendSignature) {
			for (const [id, chip] of this.supLegendChips.entries()) {
				chip.classList.toggle('is-pinned', this.pinnedSupervisorId === id);
			}
			return;
		}
		this.lastSupLegendSignature = sig;
		this.supLegendDisposables.clear();
		this.supLegendChips.clear();
		clearNode(this.supLegendEl);
		append(this.supLegendEl, $('span.ade-mission-sup-legend-title', {}, localize('adeMissionSupLegendLabel', "场外监工")));
		for (const sup of boundSups) {
			const disp = this.resolveSupervisorDisplay(sup.id);
			const parentDisp = sup.parentSupervisorId ? this.resolveSupervisorDisplay(sup.parentSupervisorId) : undefined;
			const colorIdx = getMissionSupervisorColorIndex(sup.id);
			const isPinned = this.pinnedSupervisorId === sup.id;
			const scopeText = sup.managedNodeIds.length > 0
				? sup.managedNodeIds.join(', ')
				: localize('adeMissionSupLegendUpperScope', "上级监工");
			const compactNodesText = sup.managedNodeIds.length === 0
				? localize('adeMissionSupLegendUpperBadge', "上级")
				: sup.managedNodeIds.length <= 3
					? sup.managedNodeIds.join(',')
					: `${sup.managedNodeIds.slice(0, 3).join(',')} +${sup.managedNodeIds.length - 3}`;
			const tip = parentDisp
				? localize(
					'adeMissionSupLegendChipWithParentTip',
					"{0} ({1}) ↑ {2} · 管辖节点: {3} — 悬停高亮，点击固定（按住 Tab 开启全局探照灯）",
					disp.label,
					formatTierTag(sup.tier),
					parentDisp.label,
					scopeText,
				)
				: localize(
					'adeMissionSupLegendChipTip',
					"{0} ({1}) · 管辖节点: {2} — 悬停高亮，点击固定（按住 Tab 开启全局探照灯）",
					disp.label,
					formatTierTag(sup.tier),
					scopeText,
				);
			const chip = append(this.supLegendEl, $(`button.ade-mission-sup-legend-chip.sup-color-${colorIdx}${isPinned ? '.is-pinned' : ''}`, {
				type: 'button',
				'data-ade-sup-legend-id': sup.id,
				...(sup.parentSupervisorId ? { 'data-ade-sup-parent-id': sup.parentSupervisorId } : {}),
				title: tip,
			})) as HTMLButtonElement;
			append(chip, $(`span.ade-mission-sup-dot.sup-color-${colorIdx}`, { 'aria-hidden': 'true' }));
			append(chip, $('span.ade-mission-sup-legend-name', {}, disp.shortLabel));
			if (parentDisp) {
				append(chip, $('span.ade-mission-sup-legend-parent', {}, `↑ ${parentDisp.shortLabel}`));
			}
			append(chip, $('span.ade-mission-sup-legend-nodes', {}, compactNodesText));
			this.supLegendChips.set(sup.id, chip);
			this.supLegendDisposables.add(addDisposableListener(chip, EventType.POINTER_DOWN, e => e.stopPropagation()));
			this.supLegendDisposables.add(addDisposableListener(chip, 'pointerenter', () => this.setHoveredSupervisor(sup.id)));
			this.supLegendDisposables.add(addDisposableListener(chip, 'pointerleave', () => this.setHoveredSupervisor(undefined)));
			this.supLegendDisposables.add(addDisposableListener(chip, EventType.CLICK, e => {
				e.stopPropagation();
				this.togglePinnedSupervisor(sup.id);
			}));
		}
	}

	private async handleTimeoutChange(minutes: number): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.setSilenceTimeout(missionId, minutes).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok && res.error) {
			this.reportRuntimeFeedback(res.error, 'error');
		}
		this.syncRuntimeControlsUi();
	}

	private async handleCutoffChange(cutoff: number): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			return;
		}
		const res = await this.missionRuntimeService.setBoundary(missionId, { offGraphMaxTier: cutoff }).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok && res.error) {
			this.reportRuntimeFeedback(res.error, 'error');
		}
		this.syncRuntimeControlsUi();
	}

	private setZoomCentered(targetZoom: number): void {
		if (!this.viewportEl) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		const cx = rect.width / 2;
		const cy = rect.height / 2;
		const worldX = (cx - this.panX) / this.zoom;
		const worldY = (cy - this.panY) / this.zoom;
		this.zoom = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom)) * 100) / 100;
		this.panX = cx - worldX * this.zoom;
		this.panY = cy - worldY * this.zoom;
		this.applyWorldTransformNow();
	}

	private stepZoom(delta: number): void {
		this.setZoomCentered(this.zoom + delta);
	}

	private resetZoomTo100(): void {
		this.setZoomCentered(1);
	}

	private syncMinimapGraph(): void {
		if (!this.minimap) {
			return;
		}
		const runtimeState = this.activeMissionId && this.missionRuntimeService
			? this.missionRuntimeService.getRuntimeState(this.activeMissionId)
			: undefined;
		this.minimap.syncGraph(this.nodes, this.edges, this.positions, runtimeState, this.nodeInspector?.getSelectedNodeId());
		this.syncMinimapViewport();
	}

	private syncMinimapViewport(): void {
		if (!this.minimap || !this.viewportEl) {
			return;
		}
		const rect = this.viewportEl.getBoundingClientRect();
		this.minimap.updateViewport(this.panX, this.panY, this.zoom, rect.width, rect.height);
	}

	private syncRuntimeControlsUi(): void {
		if (this.isPaneDisposed || !this.fileDrawer || !this.activeMissionId) {
			return;
		}
		const state = this.getEffectiveRuntimeState();
		const rankCount = (this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG).ranks.length;
		this.fileDrawer.syncRuntimeControls(state, this.nodes.length, rankCount);
		this.syncSupervisorLegend(state);
		this.syncRevisionTimelineBar(state);
		this.reconcileBlockedTimer(state);
		if (this.nodeInspector?.isOpen()) {
			this.nodeInspector.refresh();
		}
	}

	private async handlePrimaryRunButtonClick(timeoutMinutes: number): Promise<void> {
		const missionId = this.activeMissionId;
		if (!missionId || !this.missionRuntimeService) {
			this.reportRuntimeFeedback(localize('adeMissionRuntimeUnavailable', "Mission runtime is unavailable."), 'error');
			return;
		}
		const state = this.missionRuntimeService.getRuntimeState(missionId);
		if (state.status === 'running') {
			const res = await this.missionRuntimeService.pause(missionId).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
			if (this.isPaneDisposed || this.activeMissionId !== missionId) {
				return;
			}
			if (!res.ok && res.error) {
				this.reportRuntimeFeedback(res.error, 'error');
			} else {
				this.hideCanvasAlert();
			}
			this.syncRuntimeControlsUi();
			return;
		}
		if (state.status === 'paused') {
			const res = await this.missionRuntimeService.resume(missionId).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
			if (this.isPaneDisposed || this.activeMissionId !== missionId) {
				return;
			}
			if (!res.ok && res.error) {
				this.reportRuntimeFeedback(res.error, 'error');
			} else {
				this.hideCanvasAlert();
			}
			this.syncRuntimeControlsUi();
			return;
		}
		const res = await this.missionRuntimeService.start(missionId, {
			silenceTimeoutMinutes: Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 ? timeoutMinutes : state.silenceTimeoutMinutes,
		}).catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		if (this.isPaneDisposed || this.activeMissionId !== missionId) {
			return;
		}
		if (!res.ok) {
			const msg = res.error || localize('adeMissionStartFailedFallback', "Failed to start Mission.");
			this.reportRuntimeFeedback(msg, 'error', { offerOpenFile: true });
		} else {
			this.hideCanvasAlert();
		}
		this.syncRuntimeControlsUi();
	}

	private resetToAutoLayout(): void {
		if (this.activeMissionId && this.nodes.length > 0) {
			this.historyStack.push(this.captureHistorySnapshot(localize('adeMissionHistoryAutoLayout', "自动排版")));
			this.syncHistoryButtons();
		}
		if (this.activeMissionId) {
			this.missionService?.clearNodePositions(this.activeMissionId);
		}
		this.positions.clear();
		this.parseAndRenderGraph(this.mermaidText, true);
	}

	private assignNodeEmployee(nodeId: string, employeeName: string | undefined): void {
		const nextMermaid = setNodeEmployeeInMermaid(this.mermaidText, nodeId, employeeName);
		if (nextMermaid === this.mermaidText) {
			this.popovers.close();
			return;
		}
		const preSnap = this.captureHistorySnapshot(localize('adeMissionHistoryReassignEmployee', "指派节点 {0} 员工", nodeId));
		const missionId = this.activeMissionId;
		if (this.isLiveRun() && missionId && this.missionRuntimeService) {
			void this.missionRuntimeService.patchMermaid(missionId, {
				caller: { isHumanUser: true },
				newMermaidText: nextMermaid,
				reason: `Reassign employee on ${nodeId}`,
			}).then(res => {
				if (this.isPaneDisposed || this.activeMissionId !== missionId) {
					return;
				}
				if (res.ok) {
					this.historyStack.push(preSnap);
					this.syncHistoryButtons();
					this.mermaidText = nextMermaid;
					this.fileDrawer.setMermaidValue(nextMermaid);
					this.popovers.close();
					this.parseAndRenderGraph(nextMermaid);
				} else {
					const errMsg = res.error ?? localize('adeMissionAssignRejected', "Cannot reassign employee while Mission is running.");
					this.reportRuntimeFeedback(errMsg, 'error');
					this.popovers.showInlineError(errMsg);
				}
			}, err => {
				if (this.isPaneDisposed || this.activeMissionId !== missionId) {
					return;
				}
				const errMsg = err instanceof Error ? err.message : localize('adeMissionAssignRejected', "Cannot reassign employee while Mission is running.");
				this.reportRuntimeFeedback(errMsg, 'error');
				this.popovers.showInlineError(errMsg);
			});
			return;
		}

		this.historyStack.push(preSnap);
		this.syncHistoryButtons();
		this.mermaidText = nextMermaid;
		this.fileDrawer.setMermaidValue(nextMermaid);
		if (missionId) {
			this.missionService?.updateMermaid(missionId, nextMermaid);
		}
		this.popovers.close();
		this.parseAndRenderGraph(nextMermaid);
	}

	private parseAndRenderGraph(rawText: string, forceAutoLayout = false): void {
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
		this.employees = parsed.employees ?? [];
		this.popovers.close();
		if (this.canvasAlertEl?.dataset.alertKind === 'error') {
			this.hideCanvasAlert();
		}

		const ownerRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const ownerPrefix = ownerRec ? `${formatTierTag(ownerRec.ownerTier)} · ` : '';

		if (parsed.nodes.length === 0) {
			this.positions.clear();
			this.fileDrawer.setMeta(`${ownerPrefix}${localize('adeMissionMetaEmpty', "Empty")}`);
			this.fileDrawer.setStatus(localize('adeMissionStatusEmpty', "Write Mermaid DAG syntax to render nodes"));
			this.syncGraphDom(true);
			this.fileDrawer.syncPromptsPane();
			this.syncRuntimeControlsUi();
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
		this.fileDrawer.setMeta(hasReusedEmployee
			? `${ownerPrefix}${localize('adeMissionMetaWithEmployees', "{0} steps · {1} employees", parsed.nodes.length, this.employees.length)}`
			: `${ownerPrefix}${localize('adeMissionMetaCounts', "{0} nodes · {1} edges", parsed.nodes.length, parsed.edges.length)}`);
		this.fileDrawer.setStatus(localize('adeMissionStatusValid', "Valid DAG rendered"), 'ok');

		this.syncGraphDom();
		// Reconcile selection & live search matches against the latest parsed topology
		const liveNodeIdSet = new Set(parsed.nodes.map(n => n.id));
		let selChanged = false;
		for (const id of [...this.selectedNodeIds]) {
			if (!liveNodeIdSet.has(id)) {
				this.selectedNodeIds.delete(id);
				selChanged = true;
			}
		}
		if (selChanged) {
			this.renderer?.setSelectedNodeIds(this.selectedNodeIds);
			this.syncSelectionHud();
		}
		if (this.selectedEdgeKey && !parsed.edges.some(e => `${e.from}->${e.to}` === this.selectedEdgeKey)) {
			this.selectedEdgeKey = undefined;
			this.renderer?.setSelectedEdgeKey(undefined);
		}
		if (this.searchBarEl && !this.searchBarEl.hidden) {
			this.updateCanvasSearchResults(false);
		}
		this.fileDrawer.syncPromptsPane();
		this.syncRuntimeControlsUi();
		this.prewarmMissionHosts();
		if (!hadNodesBefore || forceAutoLayout) {
			this.fitGraphToViewport();
		}
	}

	private buildAgentNodeMap(): Map<string, IAdeAgent> {
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
		const runtimeAssignments = this.missionRuntimeService?.getRuntimeState(this.activeMissionId).boundary.nodeAssignments;
		for (const node of this.nodes) {
			if (node.kind === 'gate' || map.has(node.id)) {
				continue;
			}
			const assignedAgentId = runtimeAssignments?.[node.id]?.agentId;
			const manualAgent = assignedAgentId ? this.projectsService?.getAgent(assignedAgentId) : undefined;
			if (manualAgent) {
				map.set(node.id, manualAgent);
				continue;
			}
			const fallback = (node.employeeKey ? byTreeKey.get(`emp:${node.employeeKey}`) : undefined)
				?? byTreeKey.get(node.id);
			if (fallback) {
				map.set(node.id, fallback);
			}
		}
		return map;
	}

	private computeActiveMissionProjectsFingerprint(agentByNodeId?: ReadonlyMap<string, IAdeAgent>): string {
		if (!this.activeMissionId || !this.projectsService) {
			return '';
		}
		const missionRec = this.missionService?.getMission(this.activeMissionId);
		const ownerAgent = missionRec?.ownerSessionId ? this.projectsService.getAgent(missionRec.ownerSessionId) : undefined;
		const map = agentByNodeId ?? this.buildAgentNodeMap();
		const parts: string[] = [
			this.activeMissionId,
			ownerAgent
				? `${ownerAgent.id}|${ownerAgent.label}|${ownerAgent.role ?? ''}|${ownerAgent.session?.engineId ?? ''}|${ownerAgent.preferredEngineId ?? ''}|${ownerAgent.preferredModel ?? ''}|${ownerAgent.preferredThinking ?? ''}|${ownerAgent.projectUri.toString()}`
				: '',
		];
		for (const node of this.nodes) {
			if (node.kind === 'gate') {
				continue;
			}
			const a = map.get(node.id);
			parts.push(a
				? `${node.id}:${a.id}|${a.label}|${a.role ?? ''}|${a.session ? '1' : '0'}|${a.session?.engineId ?? ''}|${a.preferredEngineId ?? ''}|${a.preferredModel ?? ''}|${a.preferredThinking ?? ''}|${a.projectUri.toString()}|${this.projectsService.hasSubordinates(a.id) ? '1' : '0'}`
				: `${node.id}:`);
		}
		const rt = this.missionRuntimeService?.getRuntimeState(this.activeMissionId);
		if (rt) {
			for (const sup of rt.boundary.supervisors) {
				const supAgent = this.projectsService.getAgent(sup.id);
				parts.push(`sup:${sup.id}|${supAgent?.label ?? ''}|${supAgent?.role ?? ''}`);
			}
		}
		return parts.join('\x1e');
	}

	private syncGraphDom(forceFullRebuild = false): void {
		if (!this.renderer) {
			return;
		}
		const missionRec = this.activeMissionId ? this.missionService?.getMission(this.activeMissionId) : undefined;
		const runtimeState = this.getEffectiveRuntimeState();
		const ownerAgent = missionRec?.ownerSessionId ? this.projectsService?.getAgent(missionRec.ownerSessionId) : undefined;
		const fallbackOwnerEngineId = ownerAgent?.session?.engineId ?? ownerAgent?.preferredEngineId ?? 'aexus-claude';

		let renderDirection = this.direction;
		let renderNodes = this.nodes;
		let renderEdges = this.edges;
		let renderPositions: ReadonlyMap<string, IMissionNodePosition> = this.positions;

		if (this.previewRevisionVersion !== undefined && runtimeState?.revisions) {
			const rev = runtimeState.revisions.find(r => r.version === this.previewRevisionVersion);
			if (rev) {
				const parsedRev = parseMissionMermaidDag(rev.mermaidText);
				if (!parsedRev.error && parsedRev.nodes.length > 0) {
					renderDirection = parsedRev.direction;
					renderNodes = parsedRev.nodes;
					renderEdges = parsedRev.edges;
					const autoPos = computeMissionAutoLayout(parsedRev);
					const revPos = new Map<string, IMissionNodePosition>();
					for (const n of parsedRev.nodes) {
						revPos.set(n.id, this.positions.get(n.id) ?? autoPos.get(n.id) ?? { x: 240, y: 240 });
					}
					renderPositions = revPos;
				}
			}
		}

		this.activeRenderNodes = renderNodes;
		this.activeRenderPositions = renderPositions;
		const agentByNodeId = this.buildAgentNodeMap();
		this.lastProjectsFingerprint = this.computeActiveMissionProjectsFingerprint(agentByNodeId);
		const snapshot: IMissionCanvasRenderSnapshot = {
			direction: renderDirection,
			nodes: renderNodes,
			edges: renderEdges,
			positions: renderPositions,
			runtimeState,
			nodePrompts: missionRec?.nodePrompts ?? {},
			agentByNodeId,
			fallbackOwnerEngineId,
			orgConfig: this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG,
			resolveSupervisorDisplay: supId => this.resolveSupervisorDisplay(supId),
			hasSubordinates: agentId => this.projectsService?.hasSubordinates(agentId) ?? false,
			canSwitchEngine: agent => this.canSwitchAgentEngine(agent),
			canSwitchModel: Boolean(this.projectsService),
			canSwitchHost: Boolean(this.activeMissionId && this.missionRuntimeService && this.cloudHostService),
		};
		this.renderer.syncGraph(snapshot, forceFullRebuild);
		if (this.tabSpotlightActive) {
			this.renderer.setTabSpotlightActive(true, renderNodes, renderPositions, runtimeState, supId => this.resolveSupervisorDisplay(supId));
		}
		this.syncMinimapGraph();
		this.reconcileBlockedTimer(runtimeState);
	}

	private prewarmMissionHosts(): void {
		const missionId = this.activeMissionId;
		if (!missionId) {
			return;
		}
		const agentByNodeId = this.buildAgentNodeMap();
		this.hostCatalog.prewarmMissionHosts(
			this.nodes,
			node => agentByNodeId.get(node.id),
			nodeId => this.missionRuntimeService?.getRuntimeState(missionId).boundary.nodeAssignments[nodeId]?.hostAlias,
			() => {
				if (!this.isPaneDisposed && this.activeMissionId === missionId && !this.isDraggingNode && !this.popovers.isOpen()) {
					this.syncGraphDom();
				}
			},
		);
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
		const zoomPctNum = Math.round(this.zoom * 100);
		if (this.zoomReadoutBtnEl) {
			const pct = `${zoomPctNum}%`;
			if (this.zoomReadoutBtnEl.textContent !== pct) {
				this.zoomReadoutBtnEl.textContent = pct;
			}
		}
		if (this.zoomSliderEl && this.zoomSliderEl.value !== String(zoomPctNum)) {
			this.zoomSliderEl.value = String(zoomPctNum);
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
			this.renderer?.updateEdgesSvg(this.nodes, this.edges, this.positions, targetNodeId ? { movedNodeId: targetNodeId, direction: this.direction } : { direction: this.direction });
		});
	}

	private flushEdgeReroute(): void {
		if (this.edgeRerouteRafId !== undefined && this.rootEl) {
			getWindow(this.rootEl).cancelAnimationFrame(this.edgeRerouteRafId);
			this.edgeRerouteRafId = undefined;
		}
		this.pendingDraggedNodeId = undefined;
		this.pendingDraggedMultipleNodes = false;
		this.renderer?.updateEdgesSvg(this.nodes, this.edges, this.positions, { direction: this.direction });
		this.syncMinimapGraph();
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
			for (const node of this.nodes) {
				const pos = this.positions.get(node.id);
				if (!pos) {
					continue;
				}
				const sz = getMissionNodeSize(node);
				const nMinX = pos.x - sz.width / 2;
				const nMaxX = pos.x + sz.width / 2;
				const nMinY = pos.y - sz.height / 2;
				const nMaxY = pos.y + sz.height / 2;
				if (nMinX <= w2.x && nMaxX >= w1.x && nMinY <= w2.y && nMaxY >= w1.y) {
					hits.push(node.id);
				}
			}
			return hits;
		};

		const updateMarqueeBoxDom = (curX: number, curY: number): void => {
			const vpRect = this.viewportEl.getBoundingClientRect();
			const left = Math.min(startClientX, curX) - vpRect.left;
			const top = Math.min(startClientY, curY) - vpRect.top;
			const width = Math.abs(curX - startClientX);
			const height = Math.abs(curY - startClientY);
			this.marqueeBoxEl.style.left = `${Math.round(left)}px`;
			this.marqueeBoxEl.style.top = `${Math.round(top)}px`;
			this.marqueeBoxEl.style.width = `${Math.round(width)}px`;
			this.marqueeBoxEl.style.height = `${Math.round(height)}px`;
		};

		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			if (e.button !== 0 && e.button !== 1) {
				return;
			}
			this.popovers.close();

			// Shift + Left-Drag (or active Select Mode + Left-Drag) draws a Marquee Box Selection
			const wantsMarquee = e.button === 0 && (e.shiftKey || this.selectBoxMode) && this.previewRevisionVersion === undefined;
			if (wantsMarquee) {
				e.preventDefault();
				this.selectEdge(undefined);
				marqueeSelecting = true;
				marqueeAdditive = Boolean(e.metaKey || e.ctrlKey || (this.selectBoxMode && e.shiftKey));
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

			// Defer clearing selection / closing Inspector until pointerup so drag-panning the canvas never
			// accidentally slams shut the right-side Inspector or drops active selection!
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
						const hits = computeMarqueeHitIds(startClientX, startClientY, e.clientX, e.clientY);
						this.selectNodes(hits, { additive: marqueeAdditive });
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

			// Only a genuine stationary click on empty canvas clears selection & closes Inspector.
			if (!cancelled && !wasMoved) {
				this.selectEdge(undefined);
				if (this.nodeInspector?.isOpen() || this.selectedNodeIds.size > 0) {
					this.selectNode(undefined);
				}
				if (this.pinnedSupervisorId) {
					this.pinnedSupervisorId = undefined;
					this.renderer?.setHighlightedSupervisorId(this.hoveredSupervisorId);
					const st = this.activeMissionId ? this.missionRuntimeService?.getRuntimeState(this.activeMissionId) : undefined;
					this.syncSupervisorLegend(st);
				}
			}
		};
		this._register(addDisposableListener(this.viewportEl, EventType.POINTER_UP, e => stopViewportDrag(e, false)));
		this._register(addDisposableListener(this.viewportEl, 'pointercancel', e => stopViewportDrag(e, true)));

		this._register(addDisposableListener(this.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-mission-node, .ade-mission-edge-group, .ade-mission-empty-hint')) {
				return;
			}
			if (!this.activeMissionId || this.previewRevisionVersion !== undefined) {
				return;
			}
			e.preventDefault();
			const worldPos = this.clientToWorldPos(e.clientX, e.clientY);
			this.popovers.openCanvasContextMenu(e.clientX, e.clientY, [
				{
					id: 'add-task',
					label: localize('adeMissionCtxAddTaskHere', "New Node"),
					icon: 'add',
					run: () => this.addVisualNode({ kind: 'task', worldPos }),
				},
				{
					id: 'add-reviewer',
					label: localize('adeMissionCtxAddReviewerHere', "New Reviewer"),
					icon: 'shield',
					run: () => this.addVisualNode({ kind: 'task', roleKind: 'reviewer', worldPos }),
				},
				{
					id: 'add-gate',
					label: localize('adeMissionCtxAddGateHere', "New Gate"),
					icon: 'law',
					run: () => this.addVisualNode({ kind: 'gate', worldPos }),
				},
				{
					id: 'fit-view',
					label: localize('adeMissionCtxFitView', "Fit View"),
					icon: 'screen-full',
					separatorBefore: true,
					disabled: this.nodes.length === 0,
					run: () => this.fitGraphToViewport(),
				},
				{
					id: 'auto-layout',
					label: localize('adeMissionCtxAutoLayout', "Auto Layout"),
					icon: 'layout',
					disabled: this.nodes.length === 0,
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
				const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
				this.zoom = Math.round(nextZoom * 100) / 100;
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

			// Cmd/Ctrl+F: Open / focus floating large-DAG node search
			if (hasPrimaryMod && !e.shiftKey && lowerKey === 'f' && canvasActive && !this.fileDrawer.isOpen()) {
				const typingOutsideSearch = isTyping && target !== this.searchInputEl;
				if (!typingOutsideSearch) {
					e.preventDefault();
					e.stopPropagation();
					this.openCanvasSearch();
					return;
				}
			}

			// Cmd/Ctrl+Z (Undo) & Cmd/Ctrl+Shift+Z / Ctrl+Y (Redo)
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
				if (lowerKey === 'a' && !e.shiftKey && !this.fileDrawer.isOpen() && this.nodes.length > 0) {
					e.preventDefault();
					e.stopPropagation();
					this.selectNodes(this.nodes.map(n => n.id));
					return;
				}
			}

			// Delete / Backspace: Remove selected edge or selected node(s)
			if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
				if (!isTyping && canvasActive && !this.fileDrawer.isOpen() && !this.popovers.isOpen() && this.previewRevisionVersion === undefined) {
					if (this.selectedEdgeKey || this.selectedNodeIds.size > 0) {
						e.preventDefault();
						e.stopPropagation();
						this.deleteSelectedItems();
						return;
					}
				}
			}

			if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
				if (this.tabSpotlightActive) {
					e.preventDefault();
					return;
				}
				if (!isTyping && canvasActive && !e.repeat && !this.fileDrawer.isOpen() && !this.popovers.isOpen()) {
					e.preventDefault();
					this.setTabSpotlight(true);
				}
				return;
			}
			if (e.key === 'Escape') {
				if (this.searchBarEl && !this.searchBarEl.hidden) {
					this.closeCanvasSearch(true);
				} else if (this.tabSpotlightActive) {
					this.setTabSpotlight(false);
				} else if (this.previewRevisionVersion !== undefined) {
					this.exitRevisionPreview();
				} else if (this.popovers.isOpen()) {
					this.popovers.close();
				} else if (this.fileDrawer.isOpen()) {
					this.fileDrawer.toggle(false);
				} else if (this.nodeInspector?.isOpen() || this.selectedNodeIds.size > 0 || this.selectedEdgeKey) {
					this.selectNode(undefined);
				} else if (this.pinnedSupervisorId) {
					this.pinnedSupervisorId = undefined;
					this.renderer?.setHighlightedSupervisorId(this.hoveredSupervisorId);
					const st = this.activeMissionId ? this.missionRuntimeService?.getRuntimeState(this.activeMissionId) : undefined;
					this.syncSupervisorLegend(st);
				}
			}
		}));
		this._register(addDisposableListener(win, EventType.KEY_UP, (e: KeyboardEvent) => {
			if (e.key === 'Tab' && this.tabSpotlightActive) {
				this.setTabSpotlight(false);
			}
		}));
		this._register(addDisposableListener(win, EventType.BLUR, () => {
			if (this.tabSpotlightActive) {
				this.setTabSpotlight(false);
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
		this.stopBlockedCountdownTimer();
		this.hideCanvasAlert();
		this.isDraggingNode = false;
		this.historyStack.clear();
		this.preDragHistorySnapshot = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.syncHistoryButtons();
		this.syncSelectionHud();
		this.closeCanvasSearch(false);
		this.pinnedSupervisorId = undefined;
		this.hoveredSupervisorId = undefined;
		this.previewRevisionVersion = undefined;
		this.setTabSpotlight(false);
		this.fileDrawer.clearParseTimer();
		this.popovers.close();
		this.nodeInspector.close(false);
		this.setHoveredNode(undefined);
		this.renderer.setSelectedNodeIds([]);
		this.renderer.setSelectedEdgeKey(undefined);
		this.renderer.setHighlightedSupervisorId(undefined);
		this.renderer.setTraceHighlightEdges(undefined);
		this.renderer.setPreviewAddedNodeIds(undefined);
		this.renderer.resetTransitTracking();
		this.activeMissionId = input.governorSessionId;
		this.fileDrawer.setSelectedPromptNodeId(undefined);
		const record = this.missionService?.ensureMission(input.governorSessionId);
		this.mermaidText = record?.mermaidText ?? '';
		this.lastNodeChecksFingerprint = this.computeNodeChecksFingerprint(record?.nodeChecks);
		this.fileDrawer.setMermaidValue(this.mermaidText);
		this.nodes = [];
		this.edges = [];
		this.employees = [];
		this.positions.clear();
		this.renderer.invalidateStructure();
		this.parseAndRenderGraph(this.mermaidText);
		if (this.nodes.length === 0) {
			this.syncGraphDom(true);
		}
		this.syncRuntimeControlsUi();
		this.syncHudLayoutClasses();
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
		this.stopBlockedCountdownTimer();
		this.hideCanvasAlert();
		this.isDraggingNode = false;
		this.historyStack.clear();
		this.preDragHistorySnapshot = undefined;
		this.selectedNodeIds.clear();
		this.selectedEdgeKey = undefined;
		this.syncHistoryButtons();
		this.syncSelectionHud();
		this.closeCanvasSearch(false);
		this.pinnedSupervisorId = undefined;
		this.hoveredSupervisorId = undefined;
		this.previewRevisionVersion = undefined;
		this.setTabSpotlight(false);
		this.fileDrawer?.clearParseTimer();
		this.popovers?.close();
		this.nodeInspector?.close(false);
		this.minimap?.setInspectorOpen(false);
		this.minimap?.syncGraph([], [], new Map(), undefined, undefined);
		this.syncSupervisorLegend(undefined);
		this.syncRevisionTimelineBar(undefined);
		this.syncHudLayoutClasses();
		this.activeMissionId = undefined;
		this.setHoveredNode(undefined);
		this.renderer?.setSelectedNodeIds([]);
		this.renderer?.setSelectedEdgeKey(undefined);
		this.renderer?.setHighlightedSupervisorId(undefined);
		this.renderer?.setTraceHighlightEdges(undefined);
		this.renderer?.setPreviewAddedNodeIds(undefined);
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
			if (dimension.width < DUAL_DRAWER_MIN_WIDTH && this.fileDrawer?.isOpen() && this.nodeInspector?.isOpen()) {
				this.fileDrawer.toggle(false);
			}
			this.syncHudLayoutClasses();
			this.syncMinimapViewport();
		}
	}
}
