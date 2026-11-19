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
	IAdeOrthogonalEdgeObstacle,
	IAdeOrthogonalEdgeRoute,
	buildOrthogonalRoundedEdgePath,
	buildUpstreamReportChain,
	computeAutoLayoutPositions,
	computeEdgeVisualStatus,
	computeNodeVisualStatus,
	computeOrthogonalRoundedEdgeRoute,
	hasOverlappingPodPositions,
	listUpstreamTaskAncestors,
	normalizeBlueprintEngine,
	normalizeThinkingLevel,
	parseEngineeringBlueprint,
	partitionEngineeringManagers,
	serializeEngineeringBlueprint,
	toAdeEngineId,
	topologicalSortNodes,
} from '../../../../platform/ade/common/adeEngineeringBlueprint.js';
import {
	AdeBlueprintTemplatePreset,
	buildBlueprintFromTemplate,
	listBlueprintTemplates,
} from '../../../../platform/ade/common/adeBlueprintTemplates.js';
import {
	computeTreeFinancialSummary,
	formatUsdCost,
} from '../../../../platform/ade/common/adePricing.js';
import { buildEngineeringDagSvg, buildEngineeringRunReportMarkdown } from '../../../../platform/ade/common/adeRunReport.js';
import { PROMPT_DAG_EXAMPLES, synthesizeBlueprintFromPrompt } from '../../../../platform/ade/common/adePromptToDag.js';
import {
	DEFAULT_ADE_ORGANIZATION_CONFIG,
	IAdeOrganizationConfig,
	IAdeRankDefinition,
	resolveWorkTreeSlotRank,
} from '../../../../platform/ade/common/adeRoleSchema.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ADE_ENGINEERING_SCHEME, IAdeProjectsService } from '../common/ade.js';
import { IAdeRoleSchemaService } from '../common/adeRoleSchemaService.js';
import { AdeRunningNodesAffectedError } from './adeEngineeringWorkbenchService.js';
import { IAdeSessionsService } from './adeSessionsService.js';
import './media/adeEngineeringStudio.css';

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

const TASK_POD_WIDTH = 268;
const TASK_POD_HEIGHT = 172;
const TASK_POD_RADIUS = 14;
const GATE_NODE_WIDTH = 220;
const GATE_NODE_HEIGHT = 96;
const POPOVER_WIDTH = 304;
const MAX_UNDO_STACK = 40;
const MINIMAP_WIDTH = 164;
const MINIMAP_HEIGHT = 104;
const MIN_WORLD_WIDTH = 4800;
const MIN_WORLD_HEIGHT = 3600;
const WORLD_MARGIN = 640;
/** Vertical safe inset kept free for the floating glass toolbar islands. */
const TOOLBAR_SAFE_INSET = 56;
const QUICK_SPAWN_DX = 410;
const QUICK_SPAWN_DY = 236;
const SHORTCUTS_HINT_STORAGE_KEY = 'ade.engineering.shortcutsHintDismissed';

/** At most this many running edges get SMIL signal particles; beyond it edges fall back to the CSS dash flow. */
export const ADE_ENG_MAX_PARTICLE_EDGES = 24;
export const ADE_ENG_PARTICLES_PER_EDGE = 3;
/** Soft SLA: a live phase timer turns amber (`.over-sla`) after this many milliseconds. */
export const ADE_ENG_PHASE_SOFT_SLA_MS = 10 * 60 * 1000;

type PopoverTabKind = 'worker' | 'employee' | 'manager' | 'task' | 'report';
type SheetTabKind = 'blueprint' | 'events' | 'worktrees';
type SheetModeKind = 'overlay' | 'split';
type EventFilterKind = 'all' | 'worker' | 'employee' | 'manager' | 'gates';
type CanvasSpotlightFilter = 'all' | 'active' | 'gates' | 'issues';
type PhaseRoleKind = 'wrk' | 'emp' | 'mgr';
type EventRoleKind = 'wrk' | 'emp' | 'mgr' | 'gate' | 'sys';

export function computeDiffLineStats(combinedDiff: string | undefined): { readonly added: number; readonly removed: number } {
	if (!combinedDiff) {
		return { added: 0, removed: 0 };
	}
	let added = 0;
	let removed = 0;
	for (const line of combinedDiff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			added++;
		} else if (line.startsWith('-') && !line.startsWith('---')) {
			removed++;
		}
	}
	return { added, removed };
}

/**
 * World (canvas) size grows beyond the 4800×3600 baseline so large graphs never clip their edges SVG.
 */
export function computeEngineeringWorldSize(nodes: readonly Pick<IAdeEngineeringBlueprintNode, 'position'>[]): { readonly width: number; readonly height: number } {
	let maxX = 0;
	let maxY = 0;
	for (const n of nodes) {
		maxX = Math.max(maxX, n.position?.x ?? 0);
		maxY = Math.max(maxY, n.position?.y ?? 0);
	}
	return {
		width: Math.max(MIN_WORLD_WIDTH, Math.ceil((maxX + WORLD_MARGIN) / 200) * 200),
		height: Math.max(MIN_WORLD_HEIGHT, Math.ceil((maxY + WORLD_MARGIN) / 200) * 200),
	};
}

/**
 * Pure position math shared by quick-spawn (`addDraftNode(…, fromSourceNodeId)`) and the hover spawn ghost preview,
 * so the ghost lands exactly where the real node will be created.
 */
export function computeQuickSpawnPosition(
	bp: Pick<IAdeEngineeringBlueprint, 'nodes' | 'edges'>,
	sourceNodeId: string,
): { readonly x: number; readonly y: number } | undefined {
	const sourceNode = bp.nodes.find(n => n.id === sourceNodeId);
	if (!sourceNode?.position) {
		return undefined;
	}
	const existingDownstreamCount = bp.edges.filter(e => e.from === sourceNode.id).length;
	const offsetY = existingDownstreamCount === 0 ? 0 : (existingDownstreamCount % 2 === 1 ? 1 : -1) * Math.ceil(existingDownstreamCount / 2) * QUICK_SPAWN_DY;
	return {
		x: sourceNode.position.x + QUICK_SPAWN_DX,
		y: Math.max(150, sourceNode.position.y + offsetY),
	};
}

export function phaseRoleOf(phase: IAdeEngineeringNodeRuntimeState['phase'] | undefined): PhaseRoleKind | undefined {
	switch (phase) {
		case 'worker_running': return 'wrk';
		case 'employee_review': return 'emp';
		case 'manager_review':
		case 'manager_escalation': return 'mgr';
		default: return undefined;
	}
}

export function eventRoleOf(ev: Pick<IAdeEngineeringEventLogEntry, 'event' | 'level'>): EventRoleKind {
	const kind = ev.event.toLowerCase();
	if (kind.includes('gate') || kind.includes('circuit') || kind.includes('watchdog') || kind.includes('fail') || ev.level !== 'info') {
		return 'gate';
	}
	if (kind.includes('manager') || kind.includes('segment')) {
		return 'mgr';
	}
	if (kind.includes('employee') || kind.includes('node_passed')) {
		return 'emp';
	}
	if (kind.includes('worker')) {
		return 'wrk';
	}
	return 'sys';
}

/** Live tokens-per-minute rate computed from `(time, cumulativeTotal)` samples taken on each tree refresh. */
export function computeTokenRatePerMinute(samples: readonly { readonly t: number; readonly total: number }[]): number {
	if (samples.length < 2) {
		return 0;
	}
	const first = samples[0];
	const last = samples[samples.length - 1];
	const dtMin = (last.t - first.t) / 60_000;
	if (dtMin <= 1 / 60 || last.total <= first.total) {
		return 0;
	}
	return Math.round((last.total - first.total) / dtMin);
}

function matchBlueprintNodeHeading(rawLine: string): string | undefined {
	const trimmed = rawLine.trim();
	const bracketedH3 = /^###\s*\[([A-Za-z0-9_-]+)\](?:\s+.*)?$/.exec(trimmed);
	if (bracketedH3) {
		return bracketedH3[1];
	}
	const inlineH2 = /^##\s+Node\s*:\s*\[?([A-Za-z0-9_-]+)\]?(?:\s*[—:-]\s*.*)?$/i.exec(trimmed);
	return inlineH2?.[1];
}

/** Returns the `### [id]` or `## Node: id` section enclosing the given caret offset in raw Blueprint Markdown. */
export function blueprintNodeIdAtOffset(text: string, offset: number): string | undefined {
	const clamped = Math.max(0, Math.min(text.length, offset));
	const lineEnd = text.indexOf('\n', clamped);
	const sliceEnd = lineEnd === -1 ? text.length : lineEnd;
	const lines = text.slice(0, sliceEnd).split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const id = matchBlueprintNodeHeading(lines[i]);
		if (id) {
			return id;
		}
		if (/^```/.test(lines[i]) || /^---\s*$/.test(lines[i]) || /^##\s+(?!Nodes\b)/i.test(lines[i].trim())) {
			return undefined;
		}
	}
	return undefined;
}

/** Returns the zero-based line index of a node's `### [id]` or `## Node: id` heading, or -1. */
export function blueprintNodeSectionLine(text: string, nodeId: string): number {
	return text.split('\n').findIndex(line => matchBlueprintNodeHeading(line) === nodeId);
}

function countChangedLines(original: string, edited: string): number {
	const pool = new Map<string, number>();
	for (const line of original.split('\n')) {
		pool.set(line, (pool.get(line) ?? 0) + 1);
	}
	let changed = 0;
	for (const line of edited.split('\n')) {
		const left = pool.get(line) ?? 0;
		if (left > 0) {
			pool.set(line, left - 1);
		} else {
			changed++;
		}
	}
	let removed = 0;
	for (const left of pool.values()) {
		removed += left;
	}
	return Math.max(changed, removed);
}

function formatRelativeAge(timestamp: number, now = Date.now()): string {
	const sec = Math.max(0, Math.round((now - timestamp) / 1000));
	if (sec < 60) {
		return `${sec}s`;
	}
	const min = Math.round(sec / 60);
	if (min < 60) {
		return `${min}m`;
	}
	return `${Math.round(min / 60)}h`;
}

function sanitizeSvgId(raw: string): string {
	return raw.replace(/[^A-Za-z0-9_-]/g, '_');
}

const XLINK_NS = 'http://www.w3.org/1999/xlink';

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
	private starterHintEl!: HTMLElement;
	private promptBarEl!: HTMLElement;
	private starterHintDismissed = false;
	private showPromptBar = false;
	private promptDraftText = '';
	private minimapEl!: HTMLElement;
	private minimapSvgEl!: SVGSVGElement;
	private minimapLensEl!: HTMLElement;
	private tokenAnalyticsEl!: HTMLElement;
	private hudEl!: HTMLElement;
	private popoverEl!: HTMLElement;
	private popoverContentEl!: HTMLElement;
	private sheetEl!: HTMLElement;
	private sheetContentEl!: HTMLElement;
	private popoverCaretEl!: HTMLElement;
	private minimapLegendEl!: HTMLElement;
	private shortcutsCardEl!: HTMLElement;
	private templatesModalEl!: HTMLElement;
	private spawnGhostEl!: HTMLElement;
	private ghostGroupEl!: SVGGElement;
	private spawnGhostEdgeEl!: SVGPathElement;
	private readonly storage: IStorageService;

	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly toolbarRenderDisposables = this._register(new DisposableStore());
	private readonly hudRenderDisposables = this._register(new DisposableStore());
	private readonly canvasRenderDisposables = this._register(new DisposableStore());
	private readonly popoverRenderDisposables = this._register(new DisposableStore());
	private readonly sheetRenderDisposables = this._register(new DisposableStore());
	private readonly sheetTimelineDisposables = this._register(new DisposableStore());
	private readonly tokenAnalyticsDisposables = this._register(new DisposableStore());
	private readonly templatesRenderDisposables = this._register(new DisposableStore());
	private readonly promptBarRenderDisposables = this._register(new DisposableStore());
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
	private showTemplatesModal = false;
	private templateFilterMode: 'all' | 'engineering' | 'research' = 'all';
	private templatePreset: AdeBlueprintTemplatePreset = 'balanced';
	private templateUseWorktree: boolean | undefined;
	private templateBudgetCap = '';
	private canvasFilter: CanvasSpotlightFilter = 'all';
	private worktreeActionBusy = false;
	private activeEventFilter: EventFilterKind = 'all';
	private pendingInitialFit = false;
	private liveTickTimer: number | undefined;
	private cameraAnimFrame: number | undefined;
	private livePhasePillRefs: { readonly pill: HTMLElement; readonly startedAt: number; readonly phaseLabel: string }[] = [];
	private popoverTokensCardEl: HTMLElement | undefined;
	private popoverTelemetryEl: HTMLElement | undefined;
	private popoverPinBtnEl: HTMLElement | undefined;
	private readonly popoverTabBtnById = new Map<PopoverTabKind, HTMLElement>();
	private tokensPillEl: HTMLElement | undefined;
	private undoBtnEl: HTMLButtonElement | undefined;
	private blueprintSheetBtnEl: HTMLElement | undefined;
	private eventsSheetBtnEl: HTMLElement | undefined;
	private sheetEventsBodyEl: HTMLElement | undefined;
	private sheetEventsNewPillEl: HTMLElement | undefined;
	private blueprintEditorEl: HTMLTextAreaElement | undefined;
	private popoverPinned = false;
	private popoverDragged = false;
	private popoverTabOrder: PopoverTabKind[] = [];
	private sheetMode: SheetModeKind = 'overlay';
	private eventSearchQuery = '';
	private eventsSeenCount = 0;
	private showShortcuts = false;
	private altPressed = false;
	private spawnGhostSourceId: string | undefined;
	private xrefNodeId: string | undefined;
	private tokenSamples: { readonly t: number; readonly total: number }[] = [];
	private flashSegmentId: string | undefined;

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

	private readonly roleSchemaService: IAdeRoleSchemaService | undefined;

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
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(AdeEngineeringEditorPane.ID, group, telemetryService, storageService ? themeService : themeService, storageService);
		this.storage = storageService;
		this.roleSchemaService = instantiationService.invokeFunction(accessor => {
			try {
				return accessor.get(IAdeRoleSchemaService);
			} catch {
				return undefined;
			}
		});
		this._register(this.themeService.onDidColorThemeChange(() => {
			this.renderCanvas();
			if (this.activePopoverNodeId && !this.isFocusInsideEditableControl(this.popoverEl)) {
				this.renderPopover();
			}
		}));
		if (this.roleSchemaService) {
			this._register(this.roleSchemaService.onDidChangeSchema(() => {
				if (!this.rootEl) {
					return;
				}
				this.renderToolbar();
				this.renderCanvas();
				if (this.showTokenAnalytics) {
					this.renderTokenAnalytics();
				}
				if (this.activeSheetTab) {
					this.renderSheet();
				}
				if (this.activePopoverNodeId && !this.isFocusInsideEditableControl(this.popoverEl)) {
					this.renderPopover();
				}
			}));
		}
		void this.refreshConfiguredModels();
	}

	private getOrgRoleContext(): {
		readonly config: IAdeOrganizationConfig;
		readonly tierCount: number;
		readonly orchestrator: IAdeRankDefinition;
		readonly segmentOwner: IAdeRankDefinition;
		readonly reviewer: IAdeRankDefinition;
		readonly executor: IAdeRankDefinition;
	} {
		const config = this.roleSchemaService?.getConfig() ?? DEFAULT_ADE_ORGANIZATION_CONFIG;
		return {
			config,
			tierCount: config.ranks.length,
			orchestrator: resolveWorkTreeSlotRank(config, 'orchestrator'),
			segmentOwner: resolveWorkTreeSlotRank(config, 'segment_owner'),
			reviewer: resolveWorkTreeSlotRank(config, 'reviewer'),
			executor: resolveWorkTreeSlotRank(config, 'executor'),
		};
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
		// NOTE: `.ade-eng-toolbar` MUST stay the first child of the root; the glass "floating" look is CSS-only.
		this.rootEl = append(parent, $('.ade-eng-editor.mode-engineering', { tabindex: 0 }));
		this.toolbarEl = append(this.rootEl, $('.ade-eng-toolbar.floating', { role: 'toolbar' }));
		this.bannerEl = append(this.rootEl, $('.ade-eng-banner', { role: 'status', 'aria-live': 'polite' }));
		this.bannerEl.hidden = true;

		this.bodyEl = append(this.rootEl, $('.ade-eng-body'));
		this.viewportEl = append(this.bodyEl, $('.ade-eng-viewport'));
		this.worldEl = append(this.viewportEl, $('.ade-eng-world'));
		this.segmentsLayerEl = append(this.worldEl, $('.ade-eng-segments-layer'));

		this.edgesSvgEl = this.worldEl.appendChild($.SVG<SVGSVGElement>('svg', {
			class: 'ade-eng-edges-svg',
			width: String(MIN_WORLD_WIDTH),
			height: String(MIN_WORLD_HEIGHT),
			viewBox: `0 0 ${MIN_WORLD_WIDTH} ${MIN_WORLD_HEIGHT}`,
		}));
		this.edgesDefsEl = this.edgesSvgEl.appendChild($.SVG<SVGDefsElement>('defs'));
		this.buildSvgMarkers();
		this.guidesGroupEl = this.edgesSvgEl.appendChild($.SVG<SVGGElement>('g', { class: 'ade-eng-guides-group' }));
		this.edgesGroupEl = this.edgesSvgEl.appendChild($.SVG<SVGGElement>('g', { class: 'ade-eng-edges-group' }));
		this.ghostGroupEl = this.edgesSvgEl.appendChild($.SVG<SVGGElement>('g', { class: 'ade-eng-ghost-group', 'aria-hidden': 'true' }));
		this.spawnGhostEdgeEl = this.ghostGroupEl.appendChild($.SVG<SVGPathElement>('path', {
			class: 'ade-eng-spawn-ghost-edge',
			d: '',
		}));
		this.spawnGhostEdgeEl.style.display = 'none';
		this.rubberBandPathEl = this.edgesSvgEl.appendChild($.SVG<SVGPathElement>('path', {
			class: 'ade-eng-edge-path rubber-band',
			d: '',
		}));
		this.rubberBandPathEl.style.display = 'none';

		this.nodesLayerEl = append(this.worldEl, $('.ade-eng-nodes-layer'));

		// Hover quick-spawn preview ghost (NEVER carries `.ade-eng-node`, so node counts stay exact)
		this.spawnGhostEl = append(this.worldEl, $('.ade-eng-spawn-ghost.type-task', { 'aria-hidden': 'true' }));
		this.spawnGhostEl.hidden = true;

		// Empty-state onboarding card & Connect-mode floating guide banner
		this.emptyStateEl = append(this.bodyEl, $('.ade-eng-empty-canvas'));
		this.emptyStateEl.hidden = true;
		this.connectHintEl = append(this.bodyEl, $('.ade-eng-connect-banner'));
		this.connectHintEl.hidden = true;
		this.starterHintEl = append(this.bodyEl, $('.ade-eng-starter-banner'));
		this.starterHintEl.hidden = true;
		this.promptBarEl = append(this.bodyEl, $('.ade-eng-prompt-bar', {
			role: 'dialog',
			'aria-label': localize('adeEngPromptBarAria', "Generate DAG from Natural Language Prompt"),
		}));
		this.promptBarEl.hidden = true;

		// Interactive Bottom-Left Live Minimap
		this.minimapEl = append(this.bodyEl, $('.ade-eng-minimap', {
			title: localize('adeEngMinimapTooltip', "Live DAG Minimap — Click or drag to navigate · Double-click to fit"),
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
		this.minimapLegendEl = append(this.minimapEl, $('.ade-eng-minimap-legend'));
		const addLegend = (cls: string, glyph: string, label: string) => {
			const item = append(this.minimapLegendEl, $(`span.ade-eng-minimap-legend-item.${cls}`));
			append(item, $('span.ade-eng-minimap-legend-glyph', { 'aria-hidden': 'true' }, glyph));
			append(item, $('span.ade-eng-minimap-legend-label', {}, label));
		};
		addLegend('run', '●', localize('adeEngMinimapLegendRun', "run"));
		addLegend('gate', '◆', localize('adeEngMinimapLegendGate', "gate"));
		addLegend('fail', '✕', localize('adeEngMinimapLegendFail', "fail"));

		// Tree Token & 4-Tier Analytics: right-docked telemetry card (class stays `.ade-eng-token-analytics-card`, toggled via `hidden`)
		this.tokenAnalyticsEl = append(this.bodyEl, $('.ade-eng-token-analytics-card.docked', {
			role: 'complementary',
			'aria-label': localize('adeEngTokenAnalyticsAria', "Token and telemetry analytics"),
		}));
		this.tokenAnalyticsEl.hidden = true;

		// Floating Bottom-Right Canvas Controls HUD
		this.hudEl = append(this.bodyEl, $('.ade-eng-canvas-hud'));

		// Keyboard shortcuts cheat-sheet card (toggled with `?`)
		this.shortcutsCardEl = append(this.bodyEl, $('.ade-eng-shortcuts-card', {
			role: 'dialog',
			'aria-label': localize('adeEngShortcutsTitle', "Keyboard Shortcuts"),
		}));
		this.shortcutsCardEl.hidden = true;
		this.buildShortcutsCard();

		// Anchored Floating Option Popover right adjacent to right-clicked / gear-clicked node (NEVER auto-popup on hover!)
		this.popoverEl = append(this.bodyEl, $('.ade-eng-popover', { 'aria-hidden': 'true', role: 'dialog' }));
		this.popoverEl.inert = true;
		this.popoverCaretEl = append(this.popoverEl, $('span.ade-eng-pop-caret', { 'aria-hidden': 'true' }));
		this.popoverContentEl = append(this.popoverEl, $('.ade-eng-popover-inner'));

		// Floating Blueprint & Live Event Log Sheet (Overlay ⇄ Split)
		this.sheetEl = append(this.bodyEl, $('.ade-eng-sheet.mode-overlay', { 'aria-hidden': 'true', role: 'dialog' }));
		this.sheetEl.inert = true;
		this.sheetContentEl = append(this.sheetEl, $('.ade-eng-sheet-inner'));

		// Curated Blueprint Recipe Gallery Modal
		this.templatesModalEl = append(this.bodyEl, $('.ade-eng-templates-backdrop', {
			role: 'dialog',
			'aria-modal': 'true',
			'aria-label': localize('adeEngTemplatesModalAria', "Blueprint Recipe Gallery"),
		}));
		this.templatesModalEl.hidden = true;
		this._register(addDisposableListener(this.templatesModalEl, EventType.CLICK, (e: MouseEvent) => {
			if (e.target === this.templatesModalEl) {
				this.closeTemplatesModal();
			}
		}));

		this.installViewportInteractions();
		this.installMinimapInteractions();
		this.installPopoverDismissal();
		this.installPopoverHeaderDrag();
	}

	private buildShortcutsCard(): void {
		clearNode(this.shortcutsCardEl);
		const head = append(this.shortcutsCardEl, $('.ade-eng-shortcuts-head'));
		append(head, $('span.ade-eng-shortcuts-title', {}, localize('adeEngShortcutsTitle', "Keyboard Shortcuts")));
		const closeBtn = append(head, $('button.ade-eng-pop-icon-btn.close', {
			type: 'button',
			title: localize('adeEngCloseShortcutsTooltip', "Close (Esc or ?)"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this._register(addDisposableListener(closeBtn, EventType.CLICK, () => this.toggleShortcuts(false)));

		const list = append(this.shortcutsCardEl, $('dl.ade-eng-shortcuts-list'));
		const rows: readonly { readonly keys: readonly string[]; readonly label: string }[] = [
			{ keys: ['Space', 'Drag'], label: localize('adeEngKbPan', "Pan canvas") },
			{ keys: ['⌘/Ctrl', 'Wheel'], label: localize('adeEngKbZoom', "Zoom around cursor") },
			{ keys: ['F', '0'], label: localize('adeEngKbFit', "Fit entire DAG") },
			{ keys: ['L'], label: localize('adeEngKbLayout', "Auto-layout") },
			{ keys: ['G'], label: localize('adeEngKbGate', "Jump to waiting User Gate") },
			{ keys: ['N'], label: localize('adeEngKbSpawn', "Quick-spawn task from inspected node") },
			{ keys: ['⇧', 'N'], label: localize('adeEngKbSpawnGate', "Quick-spawn User Gate") },
			{ keys: ['←', '→'], label: localize('adeEngKbTabs', "Switch inspector tabs") },
			{ keys: ['⌘/Ctrl', 'S'], label: localize('adeEngKbConfirm', "Confirm Blueprint draft") },
			{ keys: ['⌘/Ctrl', 'Z'], label: localize('adeEngKbUndo', "Undo") },
			{ keys: ['⇧', '⌘/Ctrl', 'Z'], label: localize('adeEngKbRedo', "Redo") },
			{ keys: ['Del'], label: localize('adeEngKbDelete', "Delete inspected node") },
			{ keys: ['/'], label: localize('adeEngKbPromptBar', "Toggle Prompt-to-DAG bar (or ⇧⌘K / Ctrl+Shift+K)") },
			{ keys: ['Esc'], label: localize('adeEngKbClose', "Close surface / cancel wiring") },
			{ keys: ['?'], label: localize('adeEngKbHelp', "Toggle this card") },
		];
		for (const row of rows) {
			const dt = append(list, $('dt'));
			row.keys.forEach((k, idx) => {
				if (idx > 0) {
					append(dt, $('span.ade-eng-kbd-plus', { 'aria-hidden': 'true' }, '+'));
				}
				append(dt, $('kbd.ade-eng-kbd', {}, k));
			});
			append(list, $('dd', {}, row.label));
		}
	}

	private toggleShortcuts(force?: boolean): void {
		const next = force ?? !this.showShortcuts;
		if (next === this.showShortcuts) {
			return;
		}
		this.showShortcuts = next;
		this.shortcutsCardEl.hidden = !this.showShortcuts;
		if (this.showShortcuts) {
			this.storage.store(SHORTCUTS_HINT_STORAGE_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		}
		this.renderHud();
	}

	private autoLayoutPositions(bp: IAdeEngineeringBlueprint) {
		const vertical = bp.metadata.flowDirection === 'TD';
		return computeAutoLayoutPositions(bp, vertical
			? { horizontalGap: 352, verticalGap: 270 }
			: { horizontalGap: QUICK_SPAWN_DX, verticalGap: 276 });
	}

	private viewportHeight(): number {
		return this.viewportEl.clientHeight || (this.lastDimension?.height ?? 640);
	}

	private viewportWidth(): number {
		return this.viewportEl.clientWidth || (this.lastDimension?.width ?? 960);
	}

	/** Vertical center of the canvas area left free by the floating toolbar. */
	private viewportCenterY(): number {
		const h = this.viewportHeight();
		return TOOLBAR_SAFE_INSET + (h - TOOLBAR_SAFE_INSET) / 2;
	}

	private prefersReducedMotion(): boolean {
		if (!this.rootEl) {
			return false;
		}
		if (this.rootEl.closest('.monaco-reduce-motion')) {
			return true;
		}
		try {
			return getWindow(this.rootEl).matchMedia('(prefers-reduced-motion: reduce)').matches;
		} catch {
			return false;
		}
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
				refX: '8.2',
				refY: '5',
				markerWidth: '5.5',
				markerHeight: '5.5',
				orient: 'auto-start-reverse',
			});
			marker.appendChild($.SVG<SVGPathElement>('path', {
				d: 'M 0 1.8 L 8.6 5 L 0 8.2 L 1.8 5 z',
				fill: colorVar,
			}));
			this.edgesDefsEl.appendChild(marker);
		};
		createArrow('pending', 'var(--ade-eng-edge-pending, #6e7681)');
		createArrow('running', 'var(--ade-eng-green, #3fb950)');
		createArrow('completed', 'var(--ade-eng-green-solid, #10b981)');
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
		if (!animate || !this.rootEl || this.prefersReducedMotion()) {
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
		const vw = this.viewportWidth();
		const vh = this.viewportHeight();
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
			if (!this.popoverPinned) {
				this.closePopover();
			}
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
			const vw = this.viewportWidth();
			this.cancelCameraAnimation();
			this.panX = Math.round(vw / 2 - worldTargetX * this.zoom);
			this.panY = Math.round(this.viewportCenterY() - worldTargetY * this.zoom);
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
		this._register(addDisposableListener(this.minimapEl, EventType.DBLCLICK, (e: MouseEvent) => {
			EventHelper.stop(e, true);
			this.fitViewportToGraph(true);
		}));
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
			if (this.activePopoverNodeId && !this.popoverPinned && !target?.closest('.ade-eng-popover') && !target?.closest('.ade-eng-node-cfg-btn') && !target?.closest('.ade-eng-seg-cfg-ico')) {
				this.closePopover();
			}
			if (this.showTokenAnalytics && !target?.closest('.ade-eng-token-analytics-card') && !target?.closest('.ade-eng-tokens-pill')) {
				this.closeTokenAnalytics();
			}
			if (this.activeSheetTab && this.sheetMode === 'overlay' && !target?.closest('.ade-eng-sheet') && !target?.closest('.ade-eng-sheet-toggle') && !target?.closest('.ade-eng-tokens-pill') && !target?.closest('.ade-eng-token-analytics-card')) {
				this.closeSheet();
			}
			if (this.showShortcuts && !target?.closest('.ade-eng-shortcuts-card') && !target?.closest('.ade-eng-shortcuts-toggle')) {
				this.toggleShortcuts(false);
			}
		}, true));

		this._register(addDisposableListener(this.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('.ade-eng-node, .ade-eng-segment-header, .ade-eng-popover, .ade-eng-edge-item')) {
				return;
			}
			EventHelper.stop(e, true);
			if (!this.popoverPinned) {
				this.closePopover();
			}
		}));

		this._register(addDisposableListener(getWindow(this.rootEl), EventType.KEY_UP, (e: KeyboardEvent) => {
			if (e.key === 'Alt' && this.altPressed) {
				this.altPressed = false;
				this.updateSpawnGhost();
			}
		}));
		this._register(addDisposableListener(getWindow(this.rootEl), EventType.BLUR, () => {
			if (this.altPressed) {
				this.altPressed = false;
				this.updateSpawnGhost();
			}
		}));

		this._register(addDisposableListener(this.rootEl, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const targetEl = e.target as HTMLElement | null;
			const inInput = Boolean(targetEl && (targetEl.tagName === 'INPUT' || targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'SELECT' || targetEl.isContentEditable));
			// Focused buttons/tabs/links must never turn Delete/Backspace/Enter into destructive canvas actions.
			const onControl = Boolean(targetEl && targetEl !== this.rootEl && targetEl.closest('button, a, [role="button"], [role="tab"], [role="menuitem"]'));

			if (e.key === 'Alt' && !this.altPressed) {
				this.altPressed = true;
				this.updateSpawnGhost();
			}

			if (e.code === 'Space' && !inInput) {
				this.spacePressed = true;
				this.viewportEl.classList.add('space-pan');
			}

			if (e.key === 'Escape') {
				if (this.showPromptBar) {
					EventHelper.stop(e, true);
					this.togglePromptBar(false);
					return;
				}
				if (this.showTemplatesModal) {
					EventHelper.stop(e, true);
					this.closeTemplatesModal();
					return;
				}
				if (this.showShortcuts) {
					EventHelper.stop(e, true);
					this.toggleShortcuts(false);
					return;
				}
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

			const plainKey = !e.metaKey && !e.ctrlKey && !e.altKey;

			if ((e.key === 'Delete' || e.key === 'Backspace') && plainKey) {
				if (onControl) {
					// e.g. Backspace while a toolbar/HUD/popover button holds focus: never delete the inspected node.
					return;
				}
				if (this.activePopoverNodeId && !this.isNodeCompletedLocked(this.activePopoverNodeId)) {
					EventHelper.stop(e, true);
					this.deleteDraftNode(this.activePopoverNodeId);
				}
				return;
			}

			if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
				EventHelper.stop(e, true);
				this.toggleShortcuts();
				return;
			}

			if (plainKey && !onControl && e.key === '/') {
				EventHelper.stop(e, true);
				this.togglePromptBar(!this.showPromptBar);
				return;
			}

			// Inspector keyboard tab switching (←/→ and 1–5) while the popover is open and focus is not in an input
			if (plainKey && !e.shiftKey && this.activePopoverNodeId && this.popoverEl.classList.contains('open') && this.popoverTabOrder.length > 1) {
				if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
					EventHelper.stop(e, true);
					this.cyclePopoverTab(e.key === 'ArrowRight' ? 1 : -1);
					return;
				}
				const digit = Number(e.key);
				if (Number.isInteger(digit) && digit >= 1 && digit <= this.popoverTabOrder.length) {
					EventHelper.stop(e, true);
					this.selectPopoverTab(this.popoverTabOrder[digit - 1]);
					return;
				}
			}

			if (onControl && (e.key === 'Enter' || e.key === ' ')) {
				return;
			}

			if (plainKey && (e.key === '0' || e.key.toLowerCase() === 'f')) {
				EventHelper.stop(e, true);
				this.fitViewportToGraph(true);
				return;
			}

			if (plainKey && e.key.toLowerCase() === 'l') {
				EventHelper.stop(e, true);
				this.runAutoLayoutDraft();
				return;
			}

			if (plainKey && e.key.toLowerCase() === 'g') {
				EventHelper.stop(e, true);
				this.focusWaitingGateNode();
				return;
			}

			if (plainKey && e.key.toLowerCase() === 'n') {
				EventHelper.stop(e, true);
				const sourceId = this.activePopoverNodeId && this.draftBlueprint?.nodes.some(n => n.id === this.activePopoverNodeId)
					? this.activePopoverNodeId
					: undefined;
				this.addDraftNode(e.shiftKey ? 'user_gate' : 'task', sourceId);
			}
		}));

		this._register(addDisposableListener(this.rootEl, EventType.KEY_UP, (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				this.spacePressed = false;
				this.viewportEl.classList.remove('space-pan');
			}
		}));
	}

	/** Pinned inspector cards can be dragged by their header (opt-in; default anchoring is unchanged). */
	private installPopoverHeaderDrag(): void {
		let dragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;
		this._register(addDisposableListener(this.popoverEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (!this.popoverPinned || e.button !== 0 || !target?.closest('.ade-eng-pop-header') || target.closest('input, button, select, textarea')) {
				return;
			}
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			origLeft = this.popoverEl.offsetLeft;
			origTop = this.popoverEl.offsetTop;
			this.popoverEl.classList.add('dragging');
			try {
				this.popoverEl.setPointerCapture(e.pointerId);
			} catch { /* synthetic */ }
		}));
		this._register(addDisposableListener(this.popoverEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			const bodyW = this.bodyEl.clientWidth || (this.lastDimension?.width ?? 960);
			const bodyH = this.bodyEl.clientHeight || (this.lastDimension?.height ?? 640);
			const nextLeft = Math.max(4, Math.min(bodyW - 60, origLeft + e.clientX - startX));
			const nextTop = Math.max(4, Math.min(bodyH - 40, origTop + e.clientY - startY));
			this.popoverDragged = true;
			this.popoverEl.style.left = `${Math.round(nextLeft)}px`;
			this.popoverEl.style.top = `${Math.round(nextTop)}px`;
			this.popoverEl.dataset.caretSide = 'none';
		}));
		const stop = (e: PointerEvent) => {
			if (!dragging) {
				return;
			}
			dragging = false;
			this.popoverEl.classList.remove('dragging');
			try {
				this.popoverEl.releasePointerCapture(e.pointerId);
			} catch { /* ignore */ }
		};
		this._register(addDisposableListener(this.popoverEl, EventType.POINTER_UP, stop));
		this._register(addDisposableListener(this.popoverEl, 'pointercancel', stop));
	}

	private selectPopoverTab(tab: PopoverTabKind): void {
		if (this.activePopoverTab === tab) {
			return;
		}
		this.activePopoverTab = tab;
		this.renderPopover();
		this.popoverTabBtnById.get(tab)?.focus();
	}

	private cyclePopoverTab(delta: number): void {
		const order = this.popoverTabOrder;
		if (order.length === 0) {
			return;
		}
		const idx = Math.max(0, order.indexOf(this.activePopoverTab));
		const next = order[(idx + delta + order.length) % order.length];
		this.selectPopoverTab(next);
	}

	private setPopoverPinned(pinned: boolean): void {
		this.popoverPinned = pinned;
		if (!pinned) {
			this.popoverDragged = false;
		}
		this.popoverEl.classList.toggle('pinned', pinned);
		const pinBtn = this.popoverPinBtnEl;
		if (pinBtn) {
			pinBtn.classList.toggle('active', pinned);
			pinBtn.setAttribute('aria-pressed', String(pinned));
		}
		if (!pinned) {
			this.positionPopoverNearAnchor();
		}
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
		this.syncTokensPillState();
	}

	private syncTokensPillState(): void {
		const pill = this.tokensPillEl;
		pill?.classList.toggle('active', this.showTokenAnalytics);
		pill?.setAttribute('aria-expanded', String(this.showTokenAnalytics));
	}

	private closeTokenAnalytics(): void {
		if (!this.showTokenAnalytics) {
			return;
		}
		this.showTokenAnalytics = false;
		this.tokenAnalyticsEl.hidden = true;
		this.tokenAnalyticsDisposables.clear();
		this.syncTokensPillState();
	}

	private openTemplatesModal(): void {
		this.closePopover();
		this.closeTokenAnalytics();
		this.toggleShortcuts(false);
		this.showTemplatesModal = true;
		this.templateFilterMode = this.snapshot?.treeType === 'research' ? 'research' : 'engineering';
		this.templateUseWorktree = undefined;
		this.renderTemplatesModal();
		this.templatesModalEl.hidden = false;
	}

	private closeTemplatesModal(): void {
		if (!this.showTemplatesModal) {
			return;
		}
		this.showTemplatesModal = false;
		this.templatesModalEl.hidden = true;
		this.templatesRenderDisposables.clear();
		clearNode(this.templatesModalEl);
	}

	togglePromptToDagBar(open?: boolean): void {
		this.togglePromptBar(open ?? !this.showPromptBar);
	}

	private togglePromptBar(open: boolean): void {
		this.showPromptBar = open;
		if (!open) {
			this.promptBarEl.hidden = true;
			this.promptBarRenderDisposables.clear();
			clearNode(this.promptBarEl);
			this.renderToolbar();
			return;
		}
		this.closePopover();
		this.closeTemplatesModal();
		this.closeTokenAnalytics();
		this.renderPromptBar();
		this.promptBarEl.hidden = false;
		this.renderToolbar();
	}

	private async applySynthesizedPrompt(promptText: string): Promise<void> {
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const trimmed = promptText.trim();
		if (!trimmed) {
			return;
		}
		const gov = this.projects.getAgent(snap.governorSessionId);
		const defaultEngine = gov?.preferredEngineId ?? gov?.session?.engineId ?? 'claude-code';
		const synth = synthesizeBlueprintFromPrompt(trimmed, {
			governorSessionId: snap.governorSessionId,
			defaultEngine,
		});
		const blueprintText = serializeEngineeringBlueprint(synth.blueprint);
		const ok = await this.applyRawBlueprintWithSafety(blueprintText);
		if (ok) {
			this.promptDraftText = '';
			this.togglePromptBar(false);
			this.fitViewportToGraph(true);
			this.notificationService.info(localize(
				'adeEngPromptDagGenerated',
				"Generated {0}-node {1} DAG ({2} parallel lanes · ${3} cap) from prompt.",
				synth.blueprint.nodes.length,
				synth.treeType === 'research' ? 'Research' : 'Engineering',
				synth.tracks.length,
				synth.blueprint.metadata.maxBudgetUsd ?? 6,
			));
		}
	}

	private renderPromptBar(): void {
		this.promptBarRenderDisposables.clear();
		clearNode(this.promptBarEl);

		const topRow = append(this.promptBarEl, $('.ade-eng-prompt-input-row'));
		const ico = append(topRow, $('span.ade-eng-prompt-ico', { 'aria-hidden': 'true' }));
		ico.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));

		const input = append(topRow, $('input.ade-eng-prompt-input', {
			type: 'text',
			placeholder: localize('adeEngPromptPlaceholder', "Describe your goal — press Enter to generate DAG…"),
			value: this.promptDraftText,
		})) as HTMLInputElement;
		this.promptBarRenderDisposables.add(addDisposableListener(input, EventType.INPUT, () => {
			this.promptDraftText = input.value;
		}));
		this.promptBarRenderDisposables.add(addDisposableListener(input, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				EventHelper.stop(e, true);
				void this.applySynthesizedPrompt(input.value);
			} else if (e.key === 'Escape') {
				EventHelper.stop(e, true);
				this.togglePromptBar(false);
			}
		}));

		const genBtn = append(topRow, $('button.ade-eng-prompt-submit-btn', {
			type: 'button',
			title: localize('adeEngPromptSubmitTooltip', "Synthesize tailored multi-agent DAG immediately (0 tokens)"),
		}, localize('adeEngPromptSubmitBtn', "Generate DAG ↵")));
		this.promptBarRenderDisposables.add(addDisposableListener(genBtn, EventType.CLICK, () => {
			void this.applySynthesizedPrompt(input.value);
		}));

		const closeBtn = append(topRow, $('button.ade-eng-pop-icon-btn.close', {
			type: 'button',
			title: localize('adeEngPromptCloseTooltip', "Close (Esc)"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.promptBarRenderDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.togglePromptBar(false)));

		const chipsRow = append(this.promptBarEl, $('.ade-eng-prompt-chips'));
		append(chipsRow, $('span.ade-eng-prompt-chips-label', {}, localize('adeEngPromptTryLabel', "Try:")));
		for (const ex of PROMPT_DAG_EXAMPLES) {
			const chip = append(chipsRow, $('button.ade-eng-prompt-chip', {
				type: 'button',
				'data-example-id': ex.id,
				title: ex.prompt,
			}, ex.label));
			this.promptBarRenderDisposables.add(addDisposableListener(chip, EventType.CLICK, () => {
				input.value = ex.prompt;
				this.promptDraftText = ex.prompt;
				void this.applySynthesizedPrompt(ex.prompt);
			}));
		}
		if (this.engineering.startDemoSimulation) {
			const simChip = append(chipsRow, $('button.ade-eng-prompt-chip.demo', {
				type: 'button',
				title: localize('adeEngPromptSimTooltip', "Play animated 6-node walkthrough simulation (0 API tokens, 0 file changes)"),
			}, localize('adeEngPromptSimBtn', "▶ Simulated Demo (0 tok)")));
			this.promptBarRenderDisposables.add(addDisposableListener(simChip, EventType.CLICK, async () => {
				const govId = this.snapshot?.governorSessionId;
				if (!govId || !this.engineering.startDemoSimulation) {
					return;
				}
				this.togglePromptBar(false);
				await this.engineering.startDemoSimulation(govId);
				this.fitViewportToGraph(true);
			}));
		}

		getWindow(this.rootEl).requestAnimationFrame(() => {
			if (input.isConnected) {
				input.focus();
				input.setSelectionRange(input.value.length, input.value.length);
			}
		});
	}

	private renderTemplatesModal(): void {
		this.templatesRenderDisposables.clear();
		clearNode(this.templatesModalEl);
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const card = append(this.templatesModalEl, $('.ade-eng-templates-card'));
		const head = append(card, $('.ade-eng-templates-head'));
		const titleWrap = append(head, $('.ade-eng-templates-title-wrap'));
		const ico = append(titleWrap, $('span.ade-eng-templates-ico'));
		ico.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		const titleStack = append(titleWrap, $('.ade-eng-templates-title-stack'));
		append(titleStack, $('div.ade-eng-templates-title', {}, localize('adeEngRecipesTitle', "DAG Blueprint Recipes")));
		append(titleStack, $('div.ade-eng-templates-sub', {}, localize('adeEngRecipesSubtitle', "Battle-tested 4-tier workflows with automatic MNP segment lanes, adversarial L3 review, and human sign-off gates.")));
		const headRight = append(head, $('.ade-eng-templates-head-actions'));
		if (this.engineering.startDemoSimulation) {
			const demoBtn = append(headRight, $('button.ade-eng-demo-btn', {
				type: 'button',
				title: localize('adeEngTryDemoTooltip', "Play a live animated 6-node DAG simulation with 0 API tokens spent and 0 file changes"),
			}, localize('adeEngTryDemoBtn', "▶ Interactive Demo (0 tok)")));
			this.templatesRenderDisposables.add(addDisposableListener(demoBtn, EventType.CLICK, async () => {
				const govId = this.snapshot?.governorSessionId;
				if (!govId || !this.engineering.startDemoSimulation) {
					return;
				}
				this.closeTemplatesModal();
				await this.engineering.startDemoSimulation(govId);
				this.fitViewportToGraph(true);
			}));
		}
		const closeBtn = append(headRight, $('button.ade-eng-pop-icon-btn.close', {
			type: 'button',
			title: localize('adeEngCloseRecipesTooltip', "Close (Esc)"),
		}));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.templatesRenderDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeTemplatesModal()));

		// Controls Strip: Mode filter + Engine preset + Worktree toggle + Budget Cap
		const controls = append(card, $('.ade-eng-templates-controls'));
		const modeGroup = append(controls, $('.ade-eng-templates-seg-group'));
		const modeTabs: { readonly id: 'all' | 'engineering' | 'research'; readonly label: string }[] = [
			{ id: 'all', label: localize('adeEngRecipeFilterAll', "All (6)") },
			{ id: 'engineering', label: localize('adeEngRecipeFilterEng', "Engineering") },
			{ id: 'research', label: localize('adeEngRecipeFilterRes', "Research") },
		];
		for (const mt of modeTabs) {
			const b = append(modeGroup, $(`button.ade-eng-templates-pill${this.templateFilterMode === mt.id ? '.active' : ''}`, { type: 'button' }, mt.label));
			this.templatesRenderDisposables.add(addDisposableListener(b, EventType.CLICK, () => {
				this.templateFilterMode = mt.id;
				this.renderTemplatesModal();
			}));
		}

		const presetGroup = append(controls, $('.ade-eng-templates-seg-group'));
		const presets: { readonly id: AdeBlueprintTemplatePreset; readonly label: string; readonly tip: string }[] = [
			{ id: 'balanced', label: localize('adeEngPresetBalanced', "Balanced"), tip: localize('adeEngPresetBalancedTip', "High thinking on critical Workers, Medium on Reviewers & Managers") },
			{ id: 'max-quality', label: localize('adeEngPresetMaxQuality', "Max Quality"), tip: localize('adeEngPresetMaxQualityTip', "Max thinking on critical paths, High everywhere else") },
			{ id: 'fast-economy', label: localize('adeEngPresetFastEco', "Fast · $2 Cap"), tip: localize('adeEngPresetFastEcoTip', "Low/Medium thinking with automatic $2.00 budget guardrail") },
		];
		for (const pr of presets) {
			const b = append(presetGroup, $(`button.ade-eng-templates-pill${this.templatePreset === pr.id ? '.active' : ''}`, { type: 'button', title: pr.tip }, pr.label));
			this.templatesRenderDisposables.add(addDisposableListener(b, EventType.CLICK, () => {
				this.templatePreset = pr.id;
				this.renderTemplatesModal();
			}));
		}

		const budgetWrap = append(controls, $('.ade-eng-templates-budget-wrap'));
		append(budgetWrap, $('span.ade-eng-templates-budget-lbl', {}, localize('adeEngRecipeBudgetLbl', "Cap $")));
		const budgetInput = append(budgetWrap, $('input.ade-eng-templates-budget-input', {
			type: 'number',
			min: '0',
			step: '0.5',
			placeholder: localize('adeEngRecipeBudgetPh', "Auto"),
			value: this.templateBudgetCap,
			'aria-label': localize('adeEngRecipeBudgetAria', "Optional maximum budget in USD"),
		})) as HTMLInputElement;
		this.templatesRenderDisposables.add(addDisposableListener(budgetInput, EventType.INPUT, () => {
			this.templateBudgetCap = budgetInput.value;
		}));

		// Recipe Cards Grid
		const grid = append(card, $('.ade-eng-templates-grid'));
		const templates = listBlueprintTemplates(this.templateFilterMode === 'all' ? undefined : this.templateFilterMode);
		const govAgent = this.activeGovernorId ? this.projects.getAgent(this.activeGovernorId) : undefined;
		const defaultEngine = govAgent?.preferredEngineId ?? govAgent?.session?.engineId ?? 'claude-code';

		for (const tpl of templates) {
			const item = append(grid, $(`div.ade-eng-recipe-card.mode-${tpl.treeType}`, { 'data-template-id': tpl.id }));
			const itemTop = append(item, $('.ade-eng-recipe-top'));
			append(itemTop, $(`span.ade-eng-recipe-cat.mode-${tpl.treeType}`, {}, tpl.category));
			append(itemTop, $('span.ade-eng-recipe-meta', {}, localize(
				'adeEngRecipeMeta',
				"{0} nodes · {1}× parallel · {2}",
				tpl.nodeCount,
				tpl.parallelBranches,
				tpl.recommendedIsolation === 'worktree' ? 'Worktree' : 'Shared',
			)));

			// Mini SVG Topology Preview
			const previewWrap = append(item, $('.ade-eng-recipe-preview', { 'aria-hidden': 'true' }));
			const svg = previewWrap.appendChild($.SVG<SVGSVGElement>('svg', {
				viewBox: '0 0 100 52',
				class: 'ade-eng-recipe-svg',
			}));
			const pMap = new Map(tpl.previewNodes.map(n => [n.id, { x: n.x, y: 6 + (n.y / 100) * 40, type: n.type }]));
			for (const e of tpl.previewEdges) {
				const a = pMap.get(e.from);
				const b = pMap.get(e.to);
				if (!a || !b) {
					continue;
				}
				const aOutX = a.type === 'user_gate' ? a.x + 5 : a.x + 6;
				const bInX = b.type === 'user_gate' ? b.x - 5 : b.x - 6;
				svg.appendChild($.SVG<SVGPathElement>('path', {
					class: 'ade-eng-recipe-edge',
					d: buildOrthogonalRoundedEdgePath(aOutX, a.y, bInX, b.y, { cornerRadius: 4, minStub: 4, wrapClearanceY: 12 }),
				}));
			}
			for (const pn of tpl.previewNodes) {
				const pt = pMap.get(pn.id)!;
				if (pn.type === 'user_gate') {
					svg.appendChild($.SVG<SVGPolygonElement>('polygon', {
						class: 'ade-eng-recipe-gate',
						points: `${pt.x},${pt.y - 4.5} ${pt.x + 5},${pt.y} ${pt.x},${pt.y + 4.5} ${pt.x - 5},${pt.y}`,
					}));
				} else {
					svg.appendChild($.SVG<SVGRectElement>('rect', {
						class: 'ade-eng-recipe-node',
						x: String(pt.x - 6),
						y: String(pt.y - 3.6),
						width: '12',
						height: '7.2',
						rx: '2',
					}));
				}
			}

			append(item, $('div.ade-eng-recipe-name', {}, tpl.name));
			append(item, $('div.ade-eng-recipe-desc', {}, tpl.tagline));
			const hlWrap = append(item, $('.ade-eng-recipe-highlights'));
			for (const hl of tpl.highlights) {
				append(hlWrap, $('span.ade-eng-recipe-hl', {}, hl));
			}

			const foot = append(item, $('.ade-eng-recipe-foot'));
			append(foot, $('span.ade-eng-recipe-budget-hint', {}, localize('adeEngRecipeRecBudget', "Est. cap ~{0}", formatUsdCost(tpl.recommendedBudgetUsd))));
			const applyBtn = append(foot, $('button.ade-eng-action-btn.confirm.ade-eng-recipe-apply-btn', {
				type: 'button',
				'data-template-id': tpl.id,
			}, localize('adeEngRecipeApplyBtn', "Apply Recipe")));
			this.templatesRenderDisposables.add(addDisposableListener(applyBtn, EventType.CLICK, async () => {
				if (!this.activeGovernorId) {
					return;
				}
				const parsedBudget = this.templateBudgetCap.trim() ? Number(this.templateBudgetCap.trim()) : undefined;
				const nextBp = buildBlueprintFromTemplate(tpl.id, {
					governorSessionId: this.activeGovernorId,
					defaultEngine,
					treeType: snap.treeType,
					preset: this.templatePreset,
					workspaceIsolation: this.templateUseWorktree !== undefined
						? (this.templateUseWorktree ? 'worktree' : 'shared')
						: tpl.recommendedIsolation,
					...(parsedBudget !== undefined && Number.isFinite(parsedBudget) && parsedBudget > 0 ? { maxBudgetUsd: parsedBudget } : {}),
				});
				const ok = await this.applyRawBlueprintWithSafety(serializeEngineeringBlueprint(nextBp));
				if (ok) {
					this.closeTemplatesModal();
					this.fitViewportToGraph(true);
				}
			}));
		}
	}

	private downloadArtifactFile(filename: string, content: string, mimeType: string): void {
		const win = getWindow(this.rootEl);
		const blob = new Blob([content], { type: mimeType });
		const url = win.URL.createObjectURL(blob);
		const link = win.document.createElement('a');
		link.href = url;
		link.download = filename;
		link.click();
		win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
	}

	private safeArtifactSlug(snap: IAdeEngineeringTreeSnapshot): string {
		return (snap.governorLabel || snap.governorSessionId).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'aexus-dag';
	}

	private exportDagSvg(): void {
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const svg = buildEngineeringDagSvg(snap);
		const filename = `${this.safeArtifactSlug(snap)}-dag.svg`;
		this.downloadArtifactFile(filename, svg, 'image/svg+xml;charset=utf-8');
		this.notificationService.info(localize('adeEngExportedSvgNotice', "Exported shareable vector DAG snapshot to {0}.", filename));
	}

	private downloadRunReportMarkdown(): void {
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const markdown = buildEngineeringRunReportMarkdown(snap);
		const filename = `${this.safeArtifactSlug(snap)}-pr-report.md`;
		this.downloadArtifactFile(filename, markdown, 'text/markdown;charset=utf-8');
		this.notificationService.info(localize('adeEngDownloadedPrReportNotice', "Downloaded PR Verification Report to {0}.", filename));
	}

	private copyRunReportToClipboard(triggerBtn?: HTMLElement): void {
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const markdown = buildEngineeringRunReportMarkdown(snap);
		void getWindow(this.rootEl).navigator.clipboard?.writeText(markdown);
		if (triggerBtn) {
			const prev = triggerBtn.textContent;
			triggerBtn.textContent = localize('adeEngCopiedPrReportBtn', "✓ Copied PR Report");
			getWindow(this.rootEl).setTimeout(() => {
				if (triggerBtn.isConnected && prev) {
					triggerBtn.textContent = prev;
				}
			}, 1800);
		}
		this.notificationService.info(localize('adeEngCopiedPrReportNotice', "Copied PR-ready Verification Report ({0} chars) to clipboard.", markdown.length));
	}

	private renderTokenAnalytics(): void {
		this.tokenAnalyticsDisposables.clear();
		clearNode(this.tokenAnalyticsEl);
		const snap = this.snapshot;
		if (!snap) {
			return;
		}
		const tu = snap.tokenUsage;
		const fin = computeTreeFinancialSummary(snap);
		const total = Math.max(1, tu.total.totalTokens);
		const orgCtx = this.getOrgRoleContext();

		const head = append(this.tokenAnalyticsEl, $('.ade-eng-ta-head'));
		append(head, $('span.ade-eng-ta-title', {}, localize('adeEngTokenAnalyticsTitle', "{0}-Tier FinOps", orgCtx.tierCount)));
		const headActions = append(head, $('.ade-eng-ta-head-actions'));
		const svgBtn = append(headActions, $('button.ade-eng-ta-svg-btn', {
			type: 'button',
			title: localize('adeEngExportSvgTooltip', "Export shareable vector SVG snapshot of this DAG"),
		}, localize('adeEngExportSvgShort', "SVG")));
		this.tokenAnalyticsDisposables.add(addDisposableListener(svgBtn, EventType.CLICK, () => this.exportDagSvg()));
		const prBtn = append(headActions, $('button.ade-eng-ta-pr-btn', {
			type: 'button',
			title: localize('adeEngCopyPrReportTooltip', "Copy GitHub PR-ready Verification & FinOps Markdown Report"),
		}, localize('adeEngCopyPrReportShort', "Copy PR Report")));
		this.tokenAnalyticsDisposables.add(addDisposableListener(prBtn, EventType.CLICK, () => this.copyRunReportToClipboard(prBtn)));
		const closeBtn = append(headActions, $('button.ade-eng-pop-icon-btn.close', { type: 'button', title: localize('adeEngClosePopoverTooltip', "Close (Esc)") }));
		closeBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		this.tokenAnalyticsDisposables.add(addDisposableListener(closeBtn, EventType.CLICK, () => this.closeTokenAnalytics()));

		const kpiGrid = append(this.tokenAnalyticsEl, $('.ade-eng-ta-kpis'));
		const addKpi = (label: string, val: string, extraCls = '', title?: string) => {
			const cell = append(kpiGrid, $(`.ade-eng-ta-kpi${extraCls ? `.${extraCls}` : ''}`, title ? { title } : {}));
			append(cell, $('span.ade-eng-ta-kpi-label', {}, label));
			append(cell, $('span.ade-eng-ta-kpi-val', {}, val));
		};
		addKpi(localize('adeEngTaEstSpend', "Est. Spend"), formatUsdCost(fin.totalCostUsd), `spend budget-${fin.budgetStatus}`, localize('adeEngTaEstSpendTip', "Estimated API cost across all 4 tiers"));
		addKpi(
			localize('adeEngTaCacheSaved', "Cache Saved"),
			fin.cacheSavingsUsd > 0 ? `${formatUsdCost(fin.cacheSavingsUsd)} (${fin.cacheHitRatePct}%)` : `${fin.cacheHitRatePct}% hit`,
			fin.cacheSavingsUsd > 0 ? 'savings' : '',
			localize('adeEngTaCacheSavedTip', "Prompt-cache savings vs full uncached input rates"),
		);
		addKpi(localize('adeEngTaTotal', "Total"), `${tu.total.totalTokens.toLocaleString()} tok`);
		addKpi(localize('adeEngTaTurns', "Turns"), String(tu.total.turns));
		addKpi(localize('adeEngTaInput', "Input"), formatCompactTokenCount(tu.total.inputTokens));
		addKpi(localize('adeEngTaOutput', "Output"), formatCompactTokenCount(tu.total.outputTokens));
		addKpi(localize('adeEngTaCacheRead', "Cache Read"), formatCompactTokenCount(tu.total.cacheReadTokens));
		const ratePerMin = computeTokenRatePerMinute(this.tokenSamples);
		const isLive = snap.state.runStatus === 'running';
		const rateCell = append(kpiGrid, $(`.ade-eng-ta-kpi.rate${isLive && ratePerMin > 0 ? '.live' : ''}`, {
			title: localize('adeEngTaRateTooltip', "Live token burn rate sampled across recent tree refreshes"),
		}));
		append(rateCell, $('span.ade-eng-ta-kpi-label', {}, localize('adeEngTaRate', "Rate")));
		append(rateCell, $('span.ade-eng-ta-kpi-val.ade-eng-ta-rate', {}, localize('adeEngTaRateValue', "{0} tok/min", formatCompactTokenCount(ratePerMin))));

		// Hard Budget Guardrail Strip
		const budgetBox = append(this.tokenAnalyticsEl, $(`.ade-eng-ta-budget.status-${fin.budgetStatus}`));
		const budgetTop = append(budgetBox, $('.ade-eng-ta-budget-top'));
		append(budgetTop, $('span.ade-eng-ta-budget-title', {}, localize('adeEngBudgetGuardTitle', "Budget Guardrail")));
		append(budgetTop, $('span.ade-eng-ta-budget-readout', {}, fin.maxBudgetUsd !== undefined
			? `${formatUsdCost(fin.totalCostUsd)} / ${formatUsdCost(fin.maxBudgetUsd)} (${fin.budgetUtilizationPct ?? 0}%)`
			: localize('adeEngBudgetUncapped', "Uncapped")));
		if (fin.maxBudgetUsd !== undefined) {
			const bTrack = append(budgetBox, $('.ade-eng-ta-bar-track.budget'));
			const bFill = append(bTrack, $(`div.ade-eng-ta-bar-fill.budget-${fin.budgetStatus}`));
			bFill.style.width = `${Math.min(100, Math.max(fin.totalCostUsd > 0 ? 4 : 0, fin.budgetUtilizationPct ?? 0))}%`;
		}
		const budgetBtns = append(budgetBox, $('.ade-eng-ta-budget-presets'));
		const presetCaps: { readonly label: string; readonly val: number | undefined }[] = [
			{ label: localize('adeEngBudgetOff', "Off"), val: undefined },
			{ label: '$2', val: 2 },
			{ label: '$5', val: 5 },
			{ label: '$10', val: 10 },
			{ label: '$25', val: 25 },
		];
		for (const pc of presetCaps) {
			const isActiveCap = pc.val === undefined ? fin.maxBudgetUsd === undefined : fin.maxBudgetUsd === pc.val;
			const capBtn = append(budgetBtns, $(`button.ade-eng-ta-cap-btn${isActiveCap ? '.active' : ''}`, {
				type: 'button',
				'data-budget-cap': pc.val === undefined ? 'off' : String(pc.val),
			}, pc.label));
			this.tokenAnalyticsDisposables.add(addDisposableListener(capBtn, EventType.CLICK, async () => {
				if (!this.activeGovernorId) {
					return;
				}
				try {
					await this.engineering.configureTree({
						governorSessionId: this.activeGovernorId,
						...(pc.val === undefined ? { clearBudget: true } : { maxBudgetUsd: pc.val }),
					});
				} catch (err) {
					this.notificationService.error(err instanceof Error ? err.message : String(err));
				}
			}));
		}

		// Stacked tier bar dynamically labeled from active IAdeRoleSchemaService
		const tiers: { readonly label: string; readonly short: string; readonly usage: IAdeTokenUsage; readonly cost: number; readonly cls: string }[] = [
			{ label: localize('adeEngTierGov', "{0} · L{1} (Architect)", orgCtx.orchestrator.name, orgCtx.orchestrator.tier), short: orgCtx.orchestrator.shortName, usage: tu.governor, cost: fin.costByTier.governor, cls: 'gov' },
			{ label: localize('adeEngTierMgr', "{0} · L{1} (Segment)", orgCtx.segmentOwner.name, orgCtx.segmentOwner.tier), short: orgCtx.segmentOwner.shortName, usage: tu.manager, cost: fin.costByTier.manager, cls: 'mgr' },
			{ label: localize('adeEngTierEmp', "{0} · L{1} (Reviewer)", orgCtx.reviewer.name, orgCtx.reviewer.tier), short: orgCtx.reviewer.shortName, usage: tu.employee, cost: fin.costByTier.employee, cls: 'emp' },
			{ label: localize('adeEngTierWrk', "{0} · L{1} (Executor)", orgCtx.executor.name, orgCtx.executor.tier), short: orgCtx.executor.shortName, usage: tu.worker, cost: fin.costByTier.worker, cls: 'wrk' },
		];
		const stack = append(this.tokenAnalyticsEl, $('.ade-eng-ta-stack', {
			role: 'img',
			'aria-label': tiers.map(t => `${t.short} ${t.usage.totalTokens.toLocaleString()}`).join(' · '),
		}));
		for (const tier of tiers) {
			const pct = tu.total.totalTokens > 0 ? (tier.usage.totalTokens / total) * 100 : 0;
			const seg = append(stack, $(`span.ade-eng-ta-stack-seg.${tier.cls}`, {
				title: `${tier.label}: ${tier.usage.totalTokens.toLocaleString()} (${Math.round(pct)}%) · ${formatUsdCost(tier.cost)}`,
			}));
			seg.style.flexGrow = String(Math.max(tu.total.totalTokens > 0 ? 0 : 1, pct));
		}
		const stackLegend = append(this.tokenAnalyticsEl, $('.ade-eng-ta-stack-legend'));
		for (const tier of tiers) {
			const item = append(stackLegend, $(`span.ade-eng-ta-stack-key.${tier.cls}`));
			append(item, $('i', { 'aria-hidden': 'true' }));
			append(item, $('span', {}, `${tier.short} ${formatCompactTokenCount(tier.usage.totalTokens)}`));
		}

		const rolesWrap = append(this.tokenAnalyticsEl, $('.ade-eng-ta-roles'));
		for (const tier of tiers) {
			const pct = tu.total.totalTokens > 0 ? Math.round((tier.usage.totalTokens / total) * 100) : 0;
			const row = append(rolesWrap, $('.ade-eng-ta-role-row'));
			const top = append(row, $('.ade-eng-ta-role-top'));
			append(top, $(`span.ade-eng-ta-role-name.${tier.cls}`, {}, tier.label));
			append(top, $('span.ade-eng-ta-role-val', {}, `${tier.usage.totalTokens.toLocaleString()} (${pct}%) · ${formatUsdCost(tier.cost)}`));
			const track = append(row, $('.ade-eng-ta-bar-track'));
			const fill = append(track, $(`div.ade-eng-ta-bar-fill.${tier.cls}`));
			fill.style.width = `${Math.max(tier.usage.totalTokens > 0 ? 4 : 0, pct)}%`;
		}

		// Per-Manager-segment rows (click = focus lane)
		const bp = this.draftBlueprint;
		if (bp && bp.managers.length > 0) {
			append(this.tokenAnalyticsEl, $('div.ade-eng-ta-section-label', {}, localize('adeEngTaSegmentsLabel', "Manager Lanes")));
			const segWrap = append(this.tokenAnalyticsEl, $('.ade-eng-ta-segments'));
			const segRows = bp.managers.map(m => {
				let tokens = 0;
				let done = 0;
				for (const id of m.nodeIds) {
					const rt = snap.state.nodes[id];
					tokens += rt?.tokenUsage?.total.totalTokens ?? 0;
					if (rt?.completed) {
						done++;
					}
				}
				return { seg: m, tokens, cost: fin.costBySegment[m.segmentId] ?? 0, done };
			});
			const maxSegTokens = Math.max(1, ...segRows.map(r => r.tokens));
			for (const r of segRows) {
				const row = append(segWrap, $('button.ade-eng-ta-seg-row', {
					type: 'button',
					'data-segment-id': r.seg.segmentId,
					title: localize('adeEngTaSegRowTooltip', "Focus Manager lane [{0}] on canvas", r.seg.segmentId),
				}));
				append(row, $('span.ade-eng-ta-seg-name', {}, r.seg.segmentId));
				append(row, $('span.ade-eng-ta-seg-done', {}, `${r.done}/${r.seg.nodeIds.length}`));
				append(row, $('span.ade-eng-ta-seg-tok', {}, r.cost > 0 ? `${formatCompactTokenCount(r.tokens)} · ${formatUsdCost(r.cost)}` : formatCompactTokenCount(r.tokens)));
				const bar = append(row, $('span.ade-eng-ta-seg-bar'));
				const barFill = append(bar, $('span.ade-eng-ta-seg-bar-fill'));
				barFill.style.width = `${Math.round((r.tokens / maxSegTokens) * 100)}%`;
				this.tokenAnalyticsDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.focusSegmentOnCanvas(r.seg.segmentId)));
			}
		}

		// Top-5 most expensive nodes (click = focus node)
		append(this.tokenAnalyticsEl, $('div.ade-eng-ta-section-label', {}, localize('adeEngTaTopLabel', "Top Nodes by Spend")));
		const topWrap = append(this.tokenAnalyticsEl, $('.ade-eng-ta-top'));
		const topNodes = (bp?.nodes ?? [])
			.map(n => ({ node: n, tokens: snap.state.nodes[n.id]?.tokenUsage?.total.totalTokens ?? 0, cost: fin.costByNode[n.id] ?? 0 }))
			.filter(r => r.tokens > 0)
			.sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens))
			.slice(0, 5);
		if (topNodes.length === 0) {
			append(topWrap, $('div.ade-eng-empty-hint', {}, localize('adeEngTaTopEmpty', "No node has consumed tokens yet.")));
		}
		const maxNodeTokens = Math.max(1, ...topNodes.map(r => r.tokens));
		topNodes.forEach((r, idx) => {
			const row = append(topWrap, $('button.ade-eng-ta-top-row', {
				type: 'button',
				'data-node-id': r.node.id,
				title: localize('adeEngTaTopRowTooltip', "Focus [{0}] {1} on canvas", r.node.id, r.node.title),
			}));
			append(row, $('span.ade-eng-ta-top-rank', {}, String(idx + 1)));
			append(row, $('span.ade-eng-node-id-chip', {}, r.node.id));
			append(row, $('span.ade-eng-ta-top-title', {}, r.node.title));
			append(row, $('span.ade-eng-ta-top-tok', {}, r.cost > 0 ? `${formatCompactTokenCount(r.tokens)} · ${formatUsdCost(r.cost)}` : formatCompactTokenCount(r.tokens)));
			const bar = append(row, $('span.ade-eng-ta-top-bar'));
			bar.style.setProperty('--pct', `${Math.round((r.tokens / maxNodeTokens) * 100)}%`);
			this.tokenAnalyticsDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.focusNodeOnCanvas(r.node.id, false)));
		});
	}

	private recordTokenSample(): void {
		const total = this.snapshot?.tokenUsage.total.totalTokens ?? 0;
		const now = Date.now();
		const last = this.tokenSamples[this.tokenSamples.length - 1];
		if (last && last.total === total && now - last.t < 5_000) {
			return;
		}
		this.tokenSamples.push({ t: now, total });
		const cutoff = now - 5 * 60_000;
		while (this.tokenSamples.length > 2 && (this.tokenSamples.length > 40 || this.tokenSamples[0].t < cutoff)) {
			this.tokenSamples.shift();
		}
	}

	private focusSegmentOnCanvas(segmentId: string): void {
		const seg = this.draftBlueprint?.managers.find(m => m.segmentId === segmentId);
		const nodes = seg ? seg.nodeIds.map(id => this.draftBlueprint?.nodes.find(n => n.id === id)).filter((n): n is IAdeEngineeringBlueprintNode => Boolean(n)) : [];
		if (!seg || nodes.length === 0 || !this.lastDimension) {
			return;
		}
		const b = this.computeSegmentBounds(nodes);
		const cx = (b.minX + b.maxX) / 2;
		const cy = (b.minY + b.maxY) / 2;
		this.animateViewportTo(
			Math.round(this.viewportWidth() * 0.42 - cx * this.zoom),
			Math.round(this.viewportCenterY() - cy * this.zoom),
			this.zoom,
			true,
		);
		this.flashSegmentId = segmentId;
		const halo = this.segmentHaloDomById.get(segmentId);
		if (halo) {
			halo.classList.remove('flash');
			void halo.offsetWidth;
			halo.classList.add('flash');
		}
	}

	private openPopoverForTarget(params: {
		readonly nodeId: string;
		readonly anchorKind: 'worker' | 'employee' | 'manager' | 'gate';
		readonly tab?: PopoverTabKind;
		readonly segmentId?: string;
	}): void {
		if (this.activeSheetTab && this.sheetMode === 'overlay') {
			this.closeSheet();
		}
		this.closeTokenAnalytics();
		this.toggleShortcuts(false);
		const targetTab: PopoverTabKind = params.tab ?? (params.anchorKind === 'gate' ? 'task' : params.anchorKind);
		const sameState = this.activePopoverNodeId === params.nodeId
			&& this.activeAnchorKind === params.anchorKind
			&& this.activePopoverTab === targetTab
			&& this.activePopoverSegmentId === params.segmentId
			&& this.popoverEl.classList.contains('open');

		if (this.activePopoverNodeId !== params.nodeId) {
			this.popoverDragged = false;
		}
		this.activePopoverNodeId = params.nodeId;
		this.activeAnchorKind = params.anchorKind;
		this.activePopoverTab = targetTab;
		this.activePopoverSegmentId = params.segmentId;
		this.popoverEl.inert = false;
		this.popoverEl.removeAttribute('aria-hidden');
		this.popoverEl.classList.add('open');
		this.popoverEl.dataset.anchor = params.anchorKind;

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
		this.popoverTabOrder = [];
		this.popoverPinned = false;
		this.popoverDragged = false;
		this.popoverRenderDisposables.clear();
		this.popoverEl.classList.remove('open', 'flipped-left', 'placed-below', 'placed-above', 'pinned', 'dragging');
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

	private syncSheetModeClasses(): void {
		const open = Boolean(this.activeSheetTab) && this.sheetEl.classList.contains('open');
		this.sheetEl.classList.toggle('mode-split', this.sheetMode === 'split');
		this.sheetEl.classList.toggle('mode-overlay', this.sheetMode === 'overlay');
		const wasSplit = this.bodyEl.classList.contains('split-sheet');
		const isSplit = open && this.sheetMode === 'split';
		this.bodyEl.classList.toggle('split-sheet', isSplit);
		if (wasSplit !== isSplit) {
			this.updateMinimapLens();
			this.positionPopoverNearAnchor();
		}
	}

	private setSheetMode(mode: SheetModeKind): void {
		if (this.sheetMode === mode) {
			return;
		}
		this.sheetMode = mode;
		this.syncSheetModeClasses();
		this.renderSheet();
		if (this.lastDimension && this.draftBlueprint && this.draftBlueprint.nodes.length > 0) {
			this.fitViewportToGraph(true);
		}
	}

	private toggleSheet(tab: SheetTabKind): void {
		if (this.activeSheetTab === tab && this.sheetEl.classList.contains('open')) {
			this.closeSheet();
			return;
		}
		if (this.activePopoverNodeId && this.sheetMode === 'overlay') {
			this.closePopover();
		}
		this.toggleShortcuts(false);
		this.activeSheetTab = tab;
		this.sheetEl.inert = false;
		this.sheetEl.removeAttribute('aria-hidden');
		this.sheetEl.classList.add('open');
		this.syncSheetToggleActiveState();
		this.syncSheetModeClasses();
		if (tab === 'events' && this.snapshot) {
			this.eventsSeenCount = this.snapshot.state.events.length;
		}
		this.renderSheet();
		if (tab === 'events' && this.sheetEventsBodyEl) {
			this.sheetEventsBodyEl.scrollTop = this.sheetEventsBodyEl.scrollHeight;
		}
	}

	private closeSheet(): void {
		if (!this.activeSheetTab && !this.sheetEl?.classList.contains('open')) {
			return;
		}
		this.activeSheetTab = undefined;
		this.blueprintEditorEl = undefined;
		this.sheetRenderDisposables.clear();
		this.sheetTimelineDisposables.clear();
		this.sheetEl.classList.remove('open');
		this.sheetEl.inert = true;
		this.sheetEl.setAttribute('aria-hidden', 'true');
		this.syncSheetToggleActiveState();
		this.syncSheetModeClasses();
		this.setXrefNode(undefined);
	}

	private setXrefNode(nodeId: string | undefined): void {
		if (this.xrefNodeId === nodeId) {
			return;
		}
		this.xrefNodeId = nodeId;
		for (const [id, el] of this.nodeDomById) {
			el.classList.toggle('xref', id === nodeId);
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
		if (this.popoverPinned && this.popoverDragged) {
			this.popoverEl.dataset.caretSide = 'none';
			return;
		}
		const anchor = this.resolveAnchorViewportRect();
		if (!anchor) {
			return;
		}
		const bodyW = this.viewportWidth();
		const bodyH = Math.max(160, this.viewportHeight());
		const topInset = Math.min(TOOLBAR_SAFE_INSET, Math.floor(bodyH * 0.2));
		this.popoverEl.style.maxHeight = `${Math.max(140, bodyH - topInset - 12)}px`;
		const popW = Math.min(bodyW - 20, this.popoverEl.offsetWidth || POPOVER_WIDTH);
		const popH = Math.min(bodyH - topInset - 12, this.popoverEl.offsetHeight || 290);
		const gap = 12;

		let left = anchor.right + gap;
		let top = Math.max(topInset, Math.min(bodyH - popH - 10, anchor.centerY - Math.min(110, popH * 0.36)));
		let flippedLeft = false;
		let placedBelow = false;
		let placedAbove = false;
		const anchorCenterX = (anchor.left + anchor.right) / 2;

		if (anchor.right + gap + popW <= bodyW - 10) {
			left = anchor.right + gap;
		} else if (anchor.left - gap - popW >= 10) {
			left = anchor.left - gap - popW;
			flippedLeft = true;
		} else {
			left = Math.max(10, Math.min(bodyW - popW - 10, anchorCenterX - popW / 2));
			const spaceBelow = bodyH - anchor.bottom - gap - 10;
			const spaceAbove = anchor.top - gap - topInset;
			if (spaceBelow >= Math.min(popH, 220) || spaceBelow >= spaceAbove) {
				placedBelow = true;
				top = Math.max(topInset, Math.min(bodyH - 130, anchor.bottom + gap));
				this.popoverEl.style.maxHeight = `${Math.max(120, bodyH - top - 10)}px`;
			} else {
				placedAbove = true;
				const maxAboveH = Math.max(120, Math.min(bodyH - topInset - 10, anchor.top - gap - topInset));
				this.popoverEl.style.maxHeight = `${maxAboveH}px`;
				const clampedH = Math.min(popH, maxAboveH);
				top = Math.max(topInset, anchor.top - gap - clampedH);
			}
		}

		this.popoverEl.classList.toggle('flipped-left', flippedLeft);
		this.popoverEl.classList.toggle('placed-below', placedBelow);
		this.popoverEl.classList.toggle('placed-above', placedAbove);
		this.popoverEl.style.left = `${Math.round(left)}px`;
		this.popoverEl.style.top = `${Math.round(top)}px`;

		if (placedBelow || placedAbove) {
			this.popoverEl.dataset.caretSide = placedBelow ? 'top' : 'bottom';
			const caretX = Math.max(18, Math.min(popW - 18, Math.round(anchorCenterX - left)));
			this.popoverCaretEl.style.setProperty('--caret-offset', `${caretX}px`);
		} else {
			this.popoverEl.dataset.caretSide = flippedLeft ? 'right' : 'left';
			const caretY = Math.max(18, Math.min(popH - 18, Math.round(anchor.centerY - top)));
			this.popoverCaretEl.style.setProperty('--caret-offset', `${caretY}px`);
		}
	}

	private syncRootModeClass(): void {
		if (!this.rootEl) {
			return;
		}
		const govAgent = this.activeGovernorId ? this.projects.getAgent(this.activeGovernorId) : undefined;
		const treeType = this.snapshot?.treeType ?? (govAgent?.treeType === 'research' ? 'research' : 'engineering');
		const isResearch = treeType === 'research';
		this.rootEl.classList.toggle('mode-research', isResearch);
		this.rootEl.classList.toggle('mode-engineering', !isResearch);
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
		this.spawnGhostSourceId = undefined;
		this.tokenSamples = [];
		this.eventsSeenCount = 0;
		this.eventSearchQuery = '';
		this.xrefNodeId = undefined;
		this.hideBanner();
		this.closePopover();
		this.closeTokenAnalytics();
		this.closeTemplatesModal();
		this.closeSheet();
		this.toggleShortcuts(false);
		this.canvasFilter = 'all';
		this.syncRootModeClass();
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
		this.sheetTimelineDisposables.clear();
		this.tokenAnalyticsDisposables.clear();
		this.activeGovernorId = undefined;
		this.snapshot = undefined;
		this.draftBlueprint = undefined;
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.tokenSamples = [];
		this.eventsSeenCount = 0;
		this.spawnGhostSourceId = undefined;
		this.xrefNodeId = undefined;
		this.pendingInitialFit = false;
		this.hideBanner();
		this.closePopover();
		this.closeTokenAnalytics();
		this.closeTemplatesModal();
		this.closeSheet();
		this.toggleShortcuts(false);
		this.canvasFilter = 'all';
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
					item.pill.classList.toggle('over-sla', now - item.startedAt >= ADE_ENG_PHASE_SOFT_SLA_MS);
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
		this.syncRootModeClass();
		this.recordTokenSample();
		this.syncLivePhaseTicker();
		if (snap && (resetDraft || !this.isDraftDirty || !this.draftBlueprint)) {
			const cloned = cloneBlueprint(snap.blueprint);
			const autoPos = this.autoLayoutPositions(cloned);
			const needsDeOverlap = hasOverlappingPodPositions(cloned.nodes);
			this.draftBlueprint = {
				...cloned,
				nodes: cloned.nodes.map(n => (!needsDeOverlap && n.position) ? n : { ...n, position: autoPos.get(n.id) ?? { x: 204, y: 260 } }),
			};
			if (resetDraft) {
				this.isDraftDirty = false;
				this.undoStack.length = 0;
				this.redoStack.length = 0;
				this.lastCoalesceKey = undefined;
				this.eventsSeenCount = snap.state.events.length;
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
			const eventsEl = this.sheetEventsBodyEl;
			const prevScroll = eventsEl?.scrollTop ?? 0;
			const wasDatasetPinned = eventsEl?.dataset.pinnedScroll === '1';
			const distFromBottom = eventsEl ? eventsEl.scrollHeight - prevScroll - eventsEl.clientHeight : 0;
			const pinnedAwayFromBottom = Boolean(eventsEl && (distFromBottom > 24 || wasDatasetPinned));
			this.renderSheet();
			const nextEventsEl = this.sheetEventsBodyEl;
			if (nextEventsEl) {
				if (pinnedAwayFromBottom) {
					if (wasDatasetPinned) {
						nextEventsEl.dataset.pinnedScroll = '1';
					}
					nextEventsEl.scrollTop = prevScroll;
					this.syncEventsNewPill();
				} else {
					this.eventsSeenCount = snap?.state.events.length ?? 0;
					nextEventsEl.scrollTop = nextEventsEl.scrollHeight;
					this.syncEventsNewPill();
				}
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
		const rx = Math.round(this.panX);
		const ry = Math.round(this.panY);
		this.worldEl.style.transform = `translate(${rx}px, ${ry}px) scale(${this.zoom})`;
		this.viewportEl.style.setProperty('--grid-x', `${rx}px`);
		this.viewportEl.style.setProperty('--grid-y', `${ry}px`);
		this.viewportEl.style.setProperty('--grid-scale', String(this.zoom));
		this.viewportEl.classList.toggle('zoom-compact', this.zoom < 0.58);
		this.viewportEl.classList.toggle('zoom-macro', this.zoom < 0.5);
		this.updateMinimapLens();
		this.positionPopoverNearAnchor();
	}

	private updateWorldBounds(nodes: readonly Pick<IAdeEngineeringBlueprintNode, 'position'>[]): void {
		const { width, height } = computeEngineeringWorldSize(nodes);
		this.worldEl.style.width = `${width}px`;
		this.worldEl.style.height = `${height}px`;
		this.edgesSvgEl.setAttribute('width', String(width));
		this.edgesSvgEl.setAttribute('height', String(height));
		this.edgesSvgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
	}

	private fitViewportToGraph(animate = false): void {
		if (!this.draftBlueprint || this.draftBlueprint.nodes.length === 0 || !this.lastDimension) {
			this.animateViewportTo(48, TOOLBAR_SAFE_INSET + 16, 1, animate);
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of this.draftBlueprint.nodes) {
			const x = n.position?.x ?? 192;
			const y = n.position?.y ?? 250;
			minX = Math.min(minX, x - 152);
			minY = Math.min(minY, y - 118);
			maxX = Math.max(maxX, x + 156);
			maxY = Math.max(maxY, y + 108);
		}
		const vw = this.viewportWidth();
		const vh = this.viewportHeight();
		const availW = Math.max(320, vw - 48);
		const availH = Math.max(220, vh - TOOLBAR_SAFE_INSET - 54);
		const graphW = Math.max(260, maxX - minX);
		const graphH = Math.max(196, maxY - minY);
		const scale = Math.min(1.08, Math.max(0.42, Math.min(availW / graphW, availH / graphH)));
		const targetZoom = Math.round(scale * 100) / 100;
		const targetPanX = Math.round((availW - graphW * targetZoom) / 2 - minX * targetZoom + 24);
		const targetPanY = Math.round(TOOLBAR_SAFE_INSET + (availH - graphH * targetZoom) / 2 - minY * targetZoom + 14);
		this.animateViewportTo(targetPanX, targetPanY, targetZoom, animate);
	}

	private focusNodeOnCanvas(nodeId: string, openInspector = false): void {
		const target = this.draftBlueprint?.nodes.find(n => n.id === nodeId);
		if (!target) {
			return;
		}
		if (this.lastDimension && target.position) {
			const targetZoom = Math.max(0.75, Math.min(1.08, this.zoom));
			const targetPanX = Math.round(this.viewportWidth() * (openInspector ? 0.36 : 0.5) - target.position.x * targetZoom);
			const targetPanY = Math.round(this.viewportCenterY() - target.position.y * targetZoom);
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
			const targetPanX = Math.round(this.viewportWidth() * 0.36 - waitingGate.position.x * this.zoom);
			const targetPanY = Math.round(this.viewportCenterY() - waitingGate.position.y * this.zoom);
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
		this.tokensPillEl = undefined;
		this.undoBtnEl = undefined;
		this.blueprintSheetBtnEl = undefined;
		this.eventsSheetBtnEl = undefined;
		this.syncRootModeClass();
		const snap = this.snapshot;
		const bp = this.draftBlueprint;
		if (!snap || !bp) {
			const loadingIsland = append(this.toolbarEl, $('.ade-eng-toolbar-group.left.island'));
			append(loadingIsland, $('span.ade-eng-toolbar-title', {}, localize('adeEngLoading', "ADE Engineering")));
			return;
		}

		const orgCtx = this.getOrgRoleContext();
		// Island 1 (Left): Title + Mode Pill + Status + Rich Progress Bar + Interactive Token Analytics + Quick Node Jump
		const left = append(this.toolbarEl, $('.ade-eng-toolbar-group.left.island'));
		const titleIcon = append(left, $('span.ade-eng-title-icon'));
		titleIcon.classList.add(...ThemeIcon.asClassNameArray(snap.treeType === 'research' ? Codicon.beaker : Codicon.typeHierarchySub));
		append(left, $('span.ade-eng-toolbar-title', { title: snap.governorLabel }, snap.governorLabel));
		append(left, $('span.ade-eng-tree-pill', {
			title: localize(
				'adeEngTierLegendTooltip',
				"{0}-Tier Architecture: {1} (L{2}) → Segment {3} (L{4} Lane) → Outer {5} Shell (L{6} Reviewer) → Inner {7} Core (L{8} Executor)",
				orgCtx.tierCount,
				orgCtx.orchestrator.name,
				orgCtx.orchestrator.tier,
				orgCtx.segmentOwner.name,
				orgCtx.segmentOwner.tier,
				orgCtx.reviewer.name,
				orgCtx.reviewer.tier,
				orgCtx.executor.name,
				orgCtx.executor.tier,
			),
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
		const fin = computeTreeFinancialSummary(snap);
		const tokenTooltipLines = [
			localize(
				'adeEngTokensTotalTooltip',
				"Total Token Consumption: {0} tokens ({1} turns) · Est. Spend: {2} — Click for {3}-tier FinOps & Budget Guardrail",
				treeTokens.totalTokens.toLocaleString(),
				treeTokens.turns,
				formatUsdCost(fin.totalCostUsd),
				orgCtx.tierCount,
			),
			localize(
				'adeEngTokensIoTooltip',
				"Input: {0} · Output: {1} · Cache Read: {2} (Saved {3}) · Cache Write: {4}",
				treeTokens.inputTokens.toLocaleString(),
				treeTokens.outputTokens.toLocaleString(),
				treeTokens.cacheReadTokens.toLocaleString(),
				formatUsdCost(fin.cacheSavingsUsd),
				treeTokens.cacheWriteTokens.toLocaleString(),
			),
			localize(
				'adeEngTokensByRoleTooltip',
				"By Role — {8} (L{9}): {0} ({4}) · {10} (L{11}): {1} ({5}) · {12} (L{13}): {2} ({6}) · {14} (L{15}): {3} ({7})",
				snap.tokenUsage.worker.totalTokens.toLocaleString(),
				snap.tokenUsage.employee.totalTokens.toLocaleString(),
				snap.tokenUsage.manager.totalTokens.toLocaleString(),
				snap.tokenUsage.governor.totalTokens.toLocaleString(),
				formatUsdCost(fin.costByTier.worker),
				formatUsdCost(fin.costByTier.employee),
				formatUsdCost(fin.costByTier.manager),
				formatUsdCost(fin.costByTier.governor),
				orgCtx.executor.name,
				orgCtx.executor.tier,
				orgCtx.reviewer.name,
				orgCtx.reviewer.tier,
				orgCtx.segmentOwner.name,
				orgCtx.segmentOwner.tier,
				orgCtx.orchestrator.name,
				orgCtx.orchestrator.tier,
			),
		];
		const budgetClass = fin.budgetStatus === 'exceeded' ? '.budget-exceeded' : fin.budgetStatus === 'warn' ? '.budget-warn' : '';
		const tokensPill = append(left, $(`span.ade-eng-tokens-pill${treeTokens.totalTokens > 0 ? '.has-usage' : ''}${this.showTokenAnalytics ? '.active' : ''}${budgetClass}`, {
			title: tokenTooltipLines.join('\n'),
			role: 'button',
			tabindex: '0',
		}));
		this.tokensPillEl = tokensPill;
		const tokIco = append(tokensPill, $('span.ade-eng-tokens-ico'));
		tokIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.pulse));
		const pillLabel = fin.maxBudgetUsd !== undefined
			? `${formatCompactTokenCount(treeTokens.totalTokens)} · ${formatUsdCost(fin.totalCostUsd)}/${formatUsdCost(fin.maxBudgetUsd)}`
			: (fin.totalCostUsd > 0 ? `${formatCompactTokenCount(treeTokens.totalTokens)} · ${formatUsdCost(fin.totalCostUsd)}` : `${formatCompactTokenCount(treeTokens.totalTokens)} tok`);
		append(tokensPill, $('span', {}, pillLabel));
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

		// Island 2 (Center): Authoring Tools (Task → User Gate → Connect) + Undo/Redo
		const center = append(this.toolbarEl, $('.ade-eng-toolbar-group.center.island'));

		const makeToolBtnIn = (host: HTMLElement, icon: ThemeIcon, label: string, onClick: () => void, extraClass = '') => {
			const btn = append(host, $(`button.ade-eng-tool-btn${extraClass ? `.${extraClass}` : ''}`, {
				type: 'button',
				title: label,
			}));
			const ico = append(btn, $('span.ade-eng-tool-ico'));
			ico.classList.add(...ThemeIcon.asClassNameArray(icon));
			append(btn, $('span.ade-eng-tool-label', {}, label));
			this.toolbarRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, onClick));
			return btn;
		};

		const addTaskBtn = makeToolBtnIn(center, Codicon.add, localize('adeEngAddTaskBtn', "Task"), () => this.addDraftNode('task'), 'primary-spawn');
		addTaskBtn.title = localize('adeEngAddTaskTooltip', "Add Dual-Layer Task Node (Outer Employee L3 + Inner Worker L4)");

		const addGateBtn = makeToolBtnIn(center, Codicon.verified, localize('adeEngAddGateBtn', "User Gate"), () => this.addDraftNode('user_gate'));
		addGateBtn.title = localize('adeEngAddGateTooltip', "Add Human Acceptance Checkpoint Gate");

		const connectBtn = makeToolBtnIn(
			center,
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

		const promptBtn = makeToolBtnIn(
			center,
			Codicon.wand,
			localize('adeEngPromptBtn', "Prompt"),
			() => this.togglePromptBar(!this.showPromptBar),
			`ade-eng-prompt-bar-btn${this.showPromptBar ? '.active' : ''}`,
		);
		promptBtn.title = localize('adeEngPromptBarTooltip', "Describe a goal in plain language to synthesize a tailored multi-agent DAG (/ or Cmd/Ctrl+Shift+K)");

		const recipesBtn = makeToolBtnIn(
			center,
			Codicon.sparkle,
			localize('adeEngRecipesBtn', "Recipes"),
			() => this.openTemplatesModal(),
			`ade-eng-recipes-btn${this.showTemplatesModal ? '.active' : ''}`,
		);
		recipesBtn.title = localize('adeEngRecipesTooltip', "Open Curated Blueprint Recipe Gallery (6 Engineering & Research Workflows)");

		append(center, $('span.ade-eng-toolbar-sep'));

		const undoBtn = append(center, $('button.ade-eng-icon-btn.ade-eng-undo-btn', {
			type: 'button',
			title: localize('adeEngUndoTooltip', "Undo Blueprint Edit (Cmd/Ctrl+Z)"),
			...(this.undoStack.length === 0 ? { disabled: 'disabled' } : {}),
		})) as HTMLButtonElement;
		this.undoBtnEl = undoBtn;
		undoBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.discard));
		this.toolbarRenderDisposables.add(addDisposableListener(undoBtn, EventType.CLICK, () => this.undoDraft()));

		const redoBtn = append(center, $('button.ade-eng-icon-btn.ade-eng-redo-btn', {
			type: 'button',
			title: localize('adeEngRedoTooltip', "Redo Blueprint Edit (Cmd/Ctrl+Shift+Z)"),
			...(this.redoStack.length === 0 ? { disabled: 'disabled' } : {}),
		}));
		redoBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.redo));
		this.toolbarRenderDisposables.add(addDisposableListener(redoBtn, EventType.CLICK, () => this.redoDraft()));

		// Island 3 (Right): Isolation + Blueprint/Logs Sheet Toggles + Draft Guard + Execution Controls
		const right = append(this.toolbarEl, $('.ade-eng-toolbar-group.right.island'));
		const makeToolBtn = (icon: ThemeIcon, label: string, onClick: () => void, extraClass = '') => makeToolBtnIn(right, icon, label, onClick, extraClass);

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
		logsBtn.title = localize('adeEngEventsSheetTooltip', "Inspect live Engineering timeline, Gantt & execution logs ({0})", snap.state.events.length);
		this.eventsSheetBtnEl = logsBtn;

		const activeWorktrees = Object.keys(snap.state.worktrees ?? {}).length;
		if (bp.metadata.workspaceIsolation === 'worktree' || activeWorktrees > 0) {
			const wtBtn = makeToolBtn(
				Codicon.gitMerge,
				activeWorktrees > 0
					? localize('adeEngWorktreesCountBtn', "Worktrees ({0})", activeWorktrees)
					: localize('adeEngWorktreesBtn', "Worktrees"),
				() => this.toggleSheet('worktrees'),
				`ade-eng-sheet-toggle.ade-eng-worktrees-btn${this.activeSheetTab === 'worktrees' ? '.active' : ''}`,
			);
			wtBtn.title = localize('adeEngWorktreesSheetTooltip', "Inspect isolated Git worktree branches, merge into project, or clean up");
		}

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

		const snap = this.snapshot;
		const bp = this.draftBlueprint;
		if (snap && bp && bp.nodes.length >= 2) {
			const filterWrap = append(this.hudEl, $('.ade-eng-hud-filters', {
				role: 'group',
				'aria-label': localize('adeEngSpotlightFilterAria', "Spotlight DAG nodes by status"),
			}));
			const filterDefs: { readonly id: CanvasSpotlightFilter; readonly label: string; readonly count?: number }[] = [
				{ id: 'all', label: localize('adeEngSpotAll', "All") },
				{ id: 'active', label: localize('adeEngSpotActive', "Active"), count: snap.progress.runningNodes },
				{ id: 'gates', label: localize('adeEngSpotGates', "Gates"), count: snap.progress.waitingGates },
				{ id: 'issues', label: localize('adeEngSpotIssues', "Issues"), count: snap.progress.failedNodes },
			];
			for (const fd of filterDefs) {
				const txt = fd.count && fd.count > 0 ? `${fd.label} ${fd.count}` : fd.label;
				const fBtn = append(filterWrap, $(`button.ade-eng-hud-filter-btn${this.canvasFilter === fd.id ? '.active' : ''}${fd.id === 'issues' && (fd.count ?? 0) > 0 ? '.has-issues' : ''}`, {
					type: 'button',
					'data-canvas-filter': fd.id,
				}, txt));
				this.hudRenderDisposables.add(addDisposableListener(fBtn, EventType.CLICK, () => {
					this.canvasFilter = fd.id;
					this.renderHud();
					this.renderCanvas();
				}));
			}
			append(this.hudEl, $('span.ade-eng-hud-sep'));
		}

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

		const zoomPct = Math.round(((this.zoom - 0.35) / (2.1 - 0.35)) * 100);
		const zoomLabelBtn = append(this.hudEl, $('button.ade-eng-zoom-readout', {
			type: 'button',
			title: localize('adeEngFitView', "Fit Graph in Viewport (0 or F)"),
		}, `${Math.round(this.zoom * 100)}%`));
		zoomLabelBtn.style.setProperty('--zoom-pct', `${Math.max(4, Math.min(100, zoomPct))}%`);
		this.hudRenderDisposables.add(addDisposableListener(zoomLabelBtn, EventType.CLICK, () => this.fitViewportToGraph(true)));

		const zoomInBtn = append(this.hudEl, $('button.ade-eng-hud-icon-btn', { type: 'button', title: localize('adeEngZoomIn', "Zoom In") }));
		zoomInBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.zoomIn));
		this.hudRenderDisposables.add(addDisposableListener(zoomInBtn, EventType.CLICK, () => {
			this.zoomAroundViewportCenter(0.12);
		}));

		append(this.hudEl, $('span.ade-eng-hud-sep'));

		const hintDismissed = this.storage.getBoolean(SHORTCUTS_HINT_STORAGE_KEY, StorageScope.PROFILE, false);
		const shortcutsBtn = append(this.hudEl, $(`button.ade-eng-hud-icon-btn.ade-eng-shortcuts-toggle${this.showShortcuts ? '.active' : ''}${!hintDismissed && !this.showShortcuts ? '.has-hint' : ''}`, {
			type: 'button',
			title: localize('adeEngShortcutsBtnTooltip', "Keyboard Shortcuts (?)"),
			'aria-expanded': String(this.showShortcuts),
		}, '?'));
		this.hudRenderDisposables.add(addDisposableListener(shortcutsBtn, EventType.CLICK, () => {
			this.toggleShortcuts();
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
		const quickPos = fromSourceNodeId ? computeQuickSpawnPosition(this.draftBlueprint, fromSourceNodeId) : undefined;
		if (quickPos) {
			pos = { x: quickPos.x, y: quickPos.y };
		} else {
			const maxX = this.draftBlueprint.nodes.reduce((acc, n) => Math.max(acc, n.position?.x ?? 204), 100);
			pos = {
				x: this.draftBlueprint.nodes.length === 0 ? 204 : maxX + 360,
				y: 260 + ((index % 3) - 1) * 96,
			};
		}
		this.spawnGhostSourceId = undefined;
		this.updateSpawnGhost();

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
			const vw = this.viewportWidth();
			const vh = this.viewportHeight();
			const screenX = pos.x * this.zoom + this.panX;
			const screenY = pos.y * this.zoom + this.panY;
			if (screenX > vw - 140 || screenX < 100 || screenY > vh - 120 || screenY < TOOLBAR_SAFE_INSET + 24) {
				const targetPanX = Math.round(vw * 0.42 - pos.x * this.zoom);
				const targetPanY = Math.round(this.viewportCenterY() - pos.y * this.zoom);
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
			const positions = this.autoLayoutPositions(this.draftBlueprint);
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

	private collectEdgeObstacles(excludeFromId?: string, excludeToId?: string): IAdeOrthogonalEdgeObstacle[] {
		const bp = this.draftBlueprint;
		if (!bp) {
			return [];
		}
		const obstacles: IAdeOrthogonalEdgeObstacle[] = [];
		for (const n of bp.nodes) {
			if (n.id === excludeFromId || n.id === excludeToId) {
				continue;
			}
			const cx = n.position?.x ?? 196;
			const cy = n.position?.y ?? 256;
			const hw = (n.type === 'user_gate' ? GATE_NODE_WIDTH : TASK_POD_WIDTH) / 2 + 12;
			const hh = (n.type === 'user_gate' ? GATE_NODE_HEIGHT : TASK_POD_HEIGHT) / 2 + 12;
			obstacles.push({ minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh });
		}
		return obstacles;
	}

	private buildOrthogonalEdgeRoute(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		excludeFromId?: string,
		excludeToId?: string,
	): IAdeOrthogonalEdgeRoute {
		return computeOrthogonalRoundedEdgeRoute(x1, y1, x2, y2, {
			cornerRadius: 14,
			minStub: 24,
			wrapClearanceY: 116,
			obstacles: this.collectEdgeObstacles(excludeFromId, excludeToId),
		});
	}

	private buildOrthogonalEdgePath(x1: number, y1: number, x2: number, y2: number, excludeFromId?: string, excludeToId?: string): string {
		return this.buildOrthogonalEdgeRoute(x1, y1, x2, y2, excludeFromId, excludeToId).path;
	}

	private computeSegmentBounds(segNodes: readonly IAdeEngineeringBlueprintNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of segNodes) {
			const cx = n.position?.x ?? 204;
			const cy = n.position?.y ?? 260;
			const padX = n.type === 'user_gate' ? 128 : 148;
			minX = Math.min(minX, cx - padX);
			minY = Math.min(minY, cy - 100);
			maxX = Math.max(maxX, cx + padX);
			maxY = Math.max(maxY, cy + 98);
		}
		return { minX, minY, maxX, maxY };
	}

	private updateSpawnGhost(): void {
		if (!this.spawnGhostEl || !this.spawnGhostEdgeEl) {
			return;
		}
		const srcId = this.spawnGhostSourceId;
		const bp = this.draftBlueprint;
		const srcNode = srcId && bp ? bp.nodes.find(n => n.id === srcId) : undefined;
		const ghostPos = srcId && bp ? computeQuickSpawnPosition(bp, srcId) : undefined;
		if (!srcNode || !ghostPos) {
			this.spawnGhostEl.hidden = true;
			this.spawnGhostEdgeEl.style.display = 'none';
			return;
		}
		const isGate = this.altPressed;
		this.spawnGhostEl.className = `ade-eng-spawn-ghost ${isGate ? 'type-user_gate' : 'type-task'}`;
		this.spawnGhostEl.style.left = `${Math.round(ghostPos.x)}px`;
		this.spawnGhostEl.style.top = `${Math.round(ghostPos.y)}px`;
		clearNode(this.spawnGhostEl);
		append(this.spawnGhostEl, $('span.ade-eng-spawn-ghost-label', {}, isGate
			? localize('adeEngSpawnGhostGate', "+ User Gate")
			: localize('adeEngSpawnGhostTask', "+ Task Pod")));
		this.spawnGhostEl.hidden = false;

		const p1 = this.getNodePorts(srcNode);
		const ghostInX = ghostPos.x - (isGate ? GATE_NODE_WIDTH : TASK_POD_WIDTH) / 2 - 4;
		this.spawnGhostEdgeEl.setAttribute('d', this.buildOrthogonalEdgePath(p1.outX, p1.outY, ghostInX, ghostPos.y, srcNode.id));
		this.spawnGhostEdgeEl.style.display = '';
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
			const p1 = this.getNodePorts(src);
			const p2 = this.getNodePorts(dst);
			this.minimapSvgEl.appendChild($.SVG<SVGPathElement>('path', {
				class: 'ade-eng-minimap-edge',
				d: buildOrthogonalRoundedEdgePath(sx(p1.outX), sy(p1.outY), sx(p2.inX), sy(p2.inY), {
					cornerRadius: 3,
					minStub: 4,
					wrapClearanceY: 10,
				}),
			}));
		}

		for (const n of bp.nodes) {
			const rt = snap.state.nodes[n.id];
			const status = computeNodeVisualStatus(n, rt);
			const mx = sx(n.position?.x ?? 196);
			const my = sy(n.position?.y ?? 256);
			if (n.type === 'user_gate') {
				const side = Math.max(7.5, Math.min(13, (GATE_NODE_HEIGHT / worldH) * MINIMAP_HEIGHT));
				this.minimapSvgEl.appendChild($.SVG<SVGRectElement>('rect', {
					class: `ade-eng-minimap-node status-${status} gate${rt?.phase === 'waiting_user_gate' ? ' awaiting' : ''}`,
					x: String((mx - side / 2).toFixed(1)),
					y: String((my - side / 2).toFixed(1)),
					width: String(side.toFixed(1)),
					height: String(side.toFixed(1)),
					rx: '1.8',
					transform: `rotate(45 ${mx.toFixed(1)} ${my.toFixed(1)})`,
				}));
			} else {
				const w = Math.max(10, (TASK_POD_WIDTH / worldW) * MINIMAP_WIDTH);
				const h = Math.max(7, (TASK_POD_HEIGHT / worldH) * MINIMAP_HEIGHT);
				this.minimapSvgEl.appendChild($.SVG<SVGRectElement>('rect', {
					class: `ade-eng-minimap-node status-${status}`,
					x: String((mx - w / 2).toFixed(1)),
					y: String((my - h / 2).toFixed(1)),
					width: String(w.toFixed(1)),
					height: String(h.toFixed(1)),
					rx: '2.2',
				}));
			}
		}

		this.updateMinimapLens();
	}

	private updateMinimapLens(): void {
		if (!this.minimapLensEl || this.minimapEl.hidden || !this.showMinimap) {
			return;
		}
		const vw = this.viewportWidth();
		const vh = this.viewportHeight();
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
		this.spawnGhostSourceId = undefined;
		this.updateSpawnGhost();

		this.updateWorldBounds(this.draftBlueprint?.nodes ?? []);
		this.applyWorldTransform();

		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!bp || !snap) {
			this.emptyStateEl.hidden = true;
			this.connectHintEl.hidden = true;
			this.starterHintEl.hidden = true;
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
			this.starterHintEl.hidden = true;
		} else {
			this.connectHintEl.hidden = true;
			const govId = snap.governorSessionId;
			const isDemo = Boolean(this.engineering.isDemoSimulation?.(govId));
			const isPristineTree = snap.state.events.every(event => event.event === 'tree.initialized');
			const isFreshStarter = bp.nodes.length === 1 && snap.state.runStatus === 'idle' && isPristineTree && !this.starterHintDismissed;
			if (isDemo) {
				clearNode(this.starterHintEl);
				this.starterHintEl.className = 'ade-eng-starter-banner demo-active';
				append(this.starterHintEl, $('span.ade-eng-starter-text', {}, localize('adeEngDemoBannerText', "✦ Interactive Demo ($0.00 real spend) · Click ✓ Approve on Gate U1 or right-click any pod to inspect diffs")));
				const stopDemoBtn = append(this.starterHintEl, $('button.ade-eng-starter-btn', { type: 'button' }, localize('adeEngStopDemoBtn', "Stop Demo")));
				this.canvasRenderDisposables.add(addDisposableListener(stopDemoBtn, EventType.CLICK, () => {
					void this.engineering.stopTree(govId);
				}));
				this.starterHintEl.hidden = false;
			} else if (isFreshStarter) {
				clearNode(this.starterHintEl);
				this.starterHintEl.className = 'ade-eng-starter-banner';
				append(this.starterHintEl, $('span.ade-eng-starter-text', {}, localize('adeEngStarterHintText', "✦ Quick Start:")));
				const promptCta = append(this.starterHintEl, $('button.ade-eng-starter-btn.prompt', {
					type: 'button',
					title: localize('adeEngStarterPromptTip', "Type one sentence to generate a full multi-agent DAG (/ or Cmd/Ctrl+Shift+K)"),
				}, localize('adeEngStarterPromptBtn', "✦ Prompt to DAG (/)")));
				this.canvasRenderDisposables.add(addDisposableListener(promptCta, EventType.CLICK, () => this.togglePromptBar(true)));
				const recipesCta = append(this.starterHintEl, $('button.ade-eng-starter-btn.primary', { type: 'button' }, localize('adeEngStarterRecipesBtn', "Blueprint Recipes")));
				this.canvasRenderDisposables.add(addDisposableListener(recipesCta, EventType.CLICK, () => this.openTemplatesModal()));
				if (this.engineering.startDemoSimulation) {
					const demoCta = append(this.starterHintEl, $('button.ade-eng-starter-btn.demo', { type: 'button' }, localize('adeEngStarterDemoBtn', "▶ Interactive Demo (0 tok)")));
					this.canvasRenderDisposables.add(addDisposableListener(demoCta, EventType.CLICK, async () => {
						if (this.engineering.startDemoSimulation) {
							await this.engineering.startDemoSimulation(govId);
							this.fitViewportToGraph(true);
						}
					}));
				}
				const dismissBtn = append(this.starterHintEl, $('button.ade-eng-starter-dismiss', {
					type: 'button',
					title: localize('adeEngStarterDismiss', "Dismiss Quick Start"),
				}, '×'));
				this.canvasRenderDisposables.add(addDisposableListener(dismissBtn, EventType.CLICK, () => {
					this.starterHintDismissed = true;
					this.starterHintEl.hidden = true;
				}));
				this.starterHintEl.hidden = false;
			} else {
				this.starterHintEl.hidden = true;
			}
		}

		// Empty Blueprint Onboarding CTA + Curated Recipe Quick-Launch
		if (bp.nodes.length === 0) {
			clearNode(this.emptyStateEl);
			append(this.emptyStateEl, $('div.ade-eng-empty-title', {}, localize('adeEngEmptyCanvasTitle', "Design Your Engineering DAG")));
			append(this.emptyStateEl, $('div.ade-eng-empty-desc', {}, localize('adeEngEmptyCanvasDesc', "Each Task Node wraps an inner Worker (L4 Executor) inside an outer Employee (L3 Reviewer) shell, supervised by Segment Managers (L2).")));
			const ctaRow = append(this.emptyStateEl, $('.ade-eng-empty-cta-row'));
			const ctaBtn = append(ctaRow, $('button.ade-eng-action-btn.run', { type: 'button' }, localize('adeEngEmptyCreateFirstBtn', "+ Create First Task Node")));
			this.canvasRenderDisposables.add(addDisposableListener(ctaBtn, EventType.CLICK, () => this.addDraftNode('task')));
			const browseBtn = append(ctaRow, $('button.ade-eng-action-btn.secondary', { type: 'button' }, localize('adeEngEmptyBrowseRecipesBtn', "Browse Blueprint Recipes")));
			this.canvasRenderDisposables.add(addDisposableListener(browseBtn, EventType.CLICK, () => this.openTemplatesModal()));
			if (this.engineering.startDemoSimulation) {
				const demoBtn = append(ctaRow, $('button.ade-eng-demo-btn', { type: 'button' }, localize('adeEngEmptyDemoBtn', "▶ Interactive Demo (0 tok)")));
				this.canvasRenderDisposables.add(addDisposableListener(demoBtn, EventType.CLICK, async () => {
					if (this.engineering.startDemoSimulation) {
						await this.engineering.startDemoSimulation(snap.governorSessionId);
						this.fitViewportToGraph(true);
					}
				}));
			}
			this.emptyStateEl.hidden = false;
			this.minimapEl.hidden = true;
			return;
		}
		this.emptyStateEl.hidden = true;

		const nodeById = new Map(bp.nodes.map(n => [n.id, n]));
		const runtimes = snap.state.nodes;
		const fin = computeTreeFinancialSummary(snap);
		const orgCtx = this.getOrgRoleContext();

		// 1. Render Auto-Partitioned Segment Owner Enclosures
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

			const halo = append(this.segmentsLayerEl, $(`div.ade-eng-segment-halo${isManagerActive ? '.role-active' : ''}${this.flashSegmentId === seg.segmentId ? '.flash' : ''}`, {
				'data-segment-id': seg.segmentId,
			}));
			halo.style.left = `${Math.round(bounds.minX)}px`;
			halo.style.top = `${Math.round(bounds.minY)}px`;
			halo.style.width = `${Math.round(bounds.maxX - bounds.minX)}px`;
			halo.style.height = `${Math.round(bounds.maxY - bounds.minY)}px`;
			this.segmentHaloDomById.set(seg.segmentId, halo);

			const segPct = Math.round((segDoneCount / Math.max(1, segNodes.length)) * 100);
			const progressStrip = append(halo, $('div.ade-eng-segment-progress', { 'aria-hidden': 'true' }));
			progressStrip.style.setProperty('--pct', `${segPct}%`);

			const header = append(halo, $(`button.ade-eng-segment-header${isManagerActive ? '.role-active' : ''}`, {
				type: 'button',
				'data-segment-id': seg.segmentId,
				title: localize(
					'adeEngManagerHeaderTooltip',
					"{0} · L{1} [{2}] — Click to open {0} session · Right-click or click ⚙ to configure",
					orgCtx.segmentOwner.name,
					orgCtx.segmentOwner.tier,
					seg.segmentId,
				),
			}));
			this.segmentHeaderDomById.set(seg.segmentId, header);

			append(header, $('span.ade-eng-role-tag.mgr', {}, `${orgCtx.segmentOwner.shortName.toUpperCase()} · L${orgCtx.segmentOwner.tier}`));
			const segWt = snap.state.worktrees?.[seg.segmentId];
			if (segWt) {
				append(header, $('span.ade-eng-segment-label.compact', {}, seg.segmentId));
				const wtBadge = append(header, $('span.ade-eng-segment-branch', {
					title: localize('adeEngSegmentBranchTooltip', "Isolated Git Worktree: {0} ({1})", segWt.branchName, segWt.worktreePath),
				}));
				const brIco = append(wtBadge, $('span'));
				brIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.gitBranch));
				const cleanBranch = segWt.branchName.replace(/^(?:aexus-eng|ade-eng|ade)\//, '');
				const shortBranch = cleanBranch.length > 16 ? `${cleanBranch.slice(0, 15)}…` : cleanBranch;
				append(wtBadge, $('span', {}, shortBranch));
			} else {
				const mgrGlyph = append(header, $('span'));
				this.applyEngineIconToElement(mgrGlyph, seg.config.engine);
				const segModelText = segNodes.length > 1
					? `${seg.segmentId} · ${formatRoleConfigCompact(seg.config, 'medium')}`
					: `${seg.segmentId} · ${compactModelShort(seg.config.model) || compactEngineTag(seg.config.engine)}`;
				append(header, $('span.ade-eng-segment-label', {}, segModelText));
				if (segNodes.length > 1) {
					append(header, $('span.ade-eng-segment-stat', {}, `${segDoneCount}/${segNodes.length}`));
				}
			}
			if (segTokens > 0 && segNodes.length > 1) {
				const segCost = fin.costBySegment[seg.segmentId] ?? 0;
				const compactMetric = segWt && segCost > 0
					? formatUsdCost(segCost)
					: (segCost > 0 ? `${formatCompactTokenCount(segTokens)} · ${formatUsdCost(segCost)}` : formatCompactTokenCount(segTokens));
				append(header, $('span.ade-eng-segment-tok', {
					title: `${formatCompactTokenCount(segTokens)} tokens · Est. ${formatUsdCost(segCost)}`,
				}, compactMetric));
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
			const mgrActive = runtime?.phase === 'manager_review' || runtime?.phase === 'manager_escalation';
			const failCount = Math.min(3, Math.max(0, runtime?.formalFailureCount ?? 0));
			const phaseName = runtime?.phase ?? 'idle';

			const cx = node.position?.x ?? 204;
			const cy = node.position?.y ?? 260;

			const nodeAriaLabel = node.type === 'user_gate'
				? localize('adeEngGateAriaLabel', "User Gate {0}: {1}, status {2}", node.id, node.title, visualStatus)
				: localize('adeEngTaskAriaLabel', "Task {0}: {1}, phase {2}, failure {3} of 3", node.id, node.title, phaseName, failCount);

			const matchesSpotlight = this.canvasFilter === 'all'
				|| (this.canvasFilter === 'active' && visualStatus === 'running')
				|| (this.canvasFilter === 'gates' && node.type === 'user_gate')
				|| (this.canvasFilter === 'issues' && (visualStatus === 'failure_1' || visualStatus === 'failure_2' || visualStatus === 'failure_3'));

			const nodeEl = append(
				this.nodesLayerEl,
				$(`div.ade-eng-node.type-${node.type}.status-${visualStatus}${isLocked ? '.locked' : ''}${isAwaitingGate ? '.awaiting-gate' : ''}${workerActive ? '.phase-worker' : ''}${empActive ? '.phase-employee' : ''}${mgrActive ? '.phase-manager' : ''}${this.activePopoverNodeId === node.id ? '.inspected' : ''}${this.connectSourceNodeId === node.id ? '.connect-source' : ''}${this.xrefNodeId === node.id ? '.xref' : ''}${!matchesSpotlight ? '.spotlight-dim' : ''}`, {
					'data-node-id': node.id,
					'data-visual-status': visualStatus,
					'data-phase': phaseName,
					'data-fail': String(failCount),
					'aria-label': nodeAriaLabel,
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

			// 1-Click Quick-Spawn `+` Handle right beside output port (hover shows ghost pod + ghost spline)
			const quickSpawnBtn = append(nodeEl, $('button.ade-eng-quick-spawn-btn', {
				type: 'button',
				title: localize('adeEngQuickSpawnTooltip', "Click: + Connected Downstream Task · Alt+Click: + Connected User Gate"),
			}, '+'));
			const showGhost = (me?: MouseEvent) => {
				if (me) {
					this.altPressed = me.altKey;
				}
				this.spawnGhostSourceId = node.id;
				this.updateSpawnGhost();
			};
			const hideGhost = () => {
				if (this.spawnGhostSourceId === node.id) {
					this.spawnGhostSourceId = undefined;
					this.updateSpawnGhost();
				}
			};
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.MOUSE_ENTER, (me: MouseEvent) => showGhost(me)));
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.MOUSE_MOVE, (me: MouseEvent) => {
				if (this.altPressed !== me.altKey || this.spawnGhostSourceId !== node.id) {
					showGhost(me);
				}
			}));
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.FOCUS, () => showGhost()));
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.MOUSE_LEAVE, hideGhost));
			this.canvasRenderDisposables.add(addDisposableListener(quickSpawnBtn, EventType.BLUR, hideGhost));
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

				const upstreamReports = buildUpstreamReportChain(node.id, bp, snap.state.reports);
				const gateTop = append(gateBody, $('div.ade-eng-gate-top'));
				const gateIcon = append(gateTop, $('span.ade-eng-gate-icon'));
				gateIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.verifiedFilled));
				const gateTextWrap = append(gateTop, $('div.ade-eng-gate-text'));
				const kickerRow = append(gateTextWrap, $('div.ade-eng-gate-kicker-row'));
				append(kickerRow, $('span.ade-eng-gate-kicker', {}, isAwaitingGate
					? localize('adeEngGateWaitingKicker', "AWAITING APPROVAL")
					: localize('adeEngGateKicker', "USER GATE")));
				const kickerChips = append(kickerRow, $('span.ade-eng-gate-kicker-chips'));
				if (isAwaitingGate && upstreamReports.length > 0) {
					append(kickerChips, $('span.ade-eng-gate-up-badge', {
						title: localize('adeEngGateUpstreamCountTooltip', "{0} verified upstream report(s) ready for inspection", upstreamReports.length),
					}, `${upstreamReports.length} ✓`));
				}
				append(kickerChips, $('span.ade-eng-node-id-chip', {}, node.id));
				const gateTitleEl = append(gateTextWrap, $('span.ade-eng-gate-title', {}, node.title));
				this.nodeTitleDomById.set(node.id, gateTitleEl);

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
					rx: String(TASK_POD_RADIUS - 1),
				}));
				ringSvg.appendChild($.SVG<SVGRectElement>('rect', {
					class: 'ade-eng-ring-indicator',
					x: '1.5',
					y: '1.5',
					width: String(TASK_POD_WIDTH - 3),
					height: String(TASK_POD_HEIGHT - 3),
					rx: String(TASK_POD_RADIUS - 1),
					pathLength: '100',
				}));

				// 4 violet L-corner clamps gripping the recessed Worker well
				for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
					append(concentric, $(`span.ade-eng-shell-clamp.${corner}`, { 'aria-hidden': 'true' }));
				}

				if (visualStatus === 'failure_3') {
					append(concentric, $('div.ade-eng-phase-ribbon.circuit-broken', {}, localize('adeEngCircuitBrokenRibbon', "CIRCUIT BROKEN")));
				} else if (mgrActive) {
					append(concentric, $('div.ade-eng-phase-ribbon.mgr-review', {}, runtime?.phase === 'manager_escalation'
						? localize('adeEngMgrEscalationRibbon', "MGR ESCALATION")
						: localize('adeEngMgrReviewRibbon', "MGR REVIEW")));
				}

				// Hover Quick-Action Micro-Halo (Figma-style direct manipulation without opening heavy popover on hover!)
				const quickBar = append(concentric, $('div.ade-eng-pod-quickbar', {
					role: 'toolbar',
					'aria-label': localize('adeEngPodQuickActionsAria', "Quick Actions for {0}", node.id),
				}));
				const addQuickAction = (icon: ThemeIcon, tip: string, extraCls: string, onClick: () => void) => {
					const btn = append(quickBar, $(`button.ade-eng-pod-qa-btn${extraCls ? `.${extraCls}` : ''}`, {
						type: 'button',
						title: tip,
					}));
					btn.classList.add(...ThemeIcon.asClassNameArray(icon));
					this.canvasRenderDisposables.add(addDisposableListener(btn, EventType.POINTER_DOWN, e => EventHelper.stop(e, true)));
					this.canvasRenderDisposables.add(addDisposableListener(btn, EventType.CLICK, e => {
						EventHelper.stop(e, true);
						onClick();
					}));
				};
				addQuickAction(Codicon.commentDiscussion, localize('adeEngQaWorkerTip', "Open {0} · L{1} Chat", orgCtx.executor.name, orgCtx.executor.tier), 'wrk', () => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, node.id, 'worker');
					}
				});
				addQuickAction(Codicon.shield, localize('adeEngQaEmpTip', "Open {0} · L{1} Reviewer", orgCtx.reviewer.name, orgCtx.reviewer.tier), 'emp', () => {
					if (this.activeGovernorId) {
						void this.engineering.ensureNodeAgentSessionOpen(this.activeGovernorId, node.id, 'employee');
					}
				});
				addQuickAction(Codicon.settings, localize('adeEngQaCfgTip', "Configure Roles, Spec & Reports"), 'cfg', () => {
					this.openPopoverForTarget({ nodeId: node.id, anchorKind: 'worker', tab: 'worker' });
				});
				addQuickAction(Codicon.add, localize('adeEngQaSpawnTip', "Spawn Downstream Task"), 'spawn', () => {
					this.addDraftNode('task', node.id);
				});

				// 1. OUTER SHELL HEADER = Reviewer + 3-Stage Pipeline Rail (Code ▸ Audit ▸ Sign-off)
				const empSatellite = append(concentric, $(`div.ade-eng-emp-satellite${empActive ? '.role-active' : ''}${node.critical ? '.has-critical' : ''}`, {
					title: localize(
						'adeEngEmployeeSatTooltip',
						"Outer Shell — {1} · L{2} (Acceptance Reviewer): {0} — Click to open {1} chat · Right-click to configure",
						formatRoleConfigCompact(node.employee, 'medium'),
						orgCtx.reviewer.name,
						orgCtx.reviewer.tier,
					),
				}));
				append(empSatellite, $('span.ade-eng-role-tag.emp', {}, `${orgCtx.reviewer.name.toUpperCase()} · L${orgCtx.reviewer.tier}`));
				const empGlyph = append(empSatellite, $('span'));
				this.applyEngineIconToElement(empGlyph, node.employee?.engine);
				const empCompactLabel = compactModelShort(node.employee?.model) || compactEngineTag(node.employee?.engine);
				append(empSatellite, $('span.ade-eng-emp-meta', {}, empCompactLabel));

				// Visual 3-stage Adversarial Pipeline Rail: L4 Code -> L3 Audit -> L2 Sign-off
				const stageRail = append(empSatellite, $('span.ade-eng-stage-rail', {
					title: localize('adeEngStageRailTip', "3-Stage Adversarial Pipeline: L4 Code → L3 Employee Audit → L2 Manager Sign-off"),
				}));
				const stCode = isLocked || empActive || mgrActive ? 'done' : (workerActive ? 'active' : 'idle');
				const stAudit = isLocked || mgrActive ? 'done' : (empActive ? 'active' : (failCount > 0 || (runtime?.employeeRejectCount ?? 0) > 0 ? 'warn' : 'idle'));
				const stMgr = isLocked ? 'done' : (mgrActive ? 'active' : (failCount > 0 ? 'warn' : 'idle'));
				append(stageRail, $(`i.ade-eng-stage-seg.s-code.st-${stCode}`));
				append(stageRail, $(`i.ade-eng-stage-seg.s-audit.st-${stAudit}`));
				append(stageRail, $(`i.ade-eng-stage-seg.s-mgr.st-${stMgr}`));

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
					const failBadge = append(empSatellite, $(`span.ade-eng-corner-status.fail-${failCount}`, {
						title: runtime.formalFailureCount >= 3
							? localize('adeEngCircuitBrokenBadgeTooltip', "Circuit Broken (Formal Failure {0}/3) — Click or right-click to inspect feedback or Reset", runtime.formalFailureCount)
							: localize('adeEngFormalFailBadgeTooltip', "Formal Failure {0}/3 (Fresh Worker retry) — Click or right-click for feedback", runtime.formalFailureCount),
					}, `F${runtime.formalFailureCount}`));
					const pips = append(empSatellite, $('span.ade-eng-fail-pips', { 'aria-hidden': 'true' }));
					for (let pipIdx = 0; pipIdx < 3; pipIdx++) {
						append(pips, $(pipIdx < failCount ? 'i.lit' : 'i'));
					}
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

				// 2. INNER RECESSED CORE = Pure Executor visibly enclosed inside Reviewer Shell!
				const innerCore = append(concentric, $(`div.ade-eng-inner-core${workerActive ? '.role-active' : ''}`, {
					title: localize(
						'adeEngWorkerCoreTooltip',
						"Inner Core — {1} · L{2} (Executor): {0} — Click to open {1} chat · Right-click or click ⚙ to configure",
						formatRoleConfigCompact(node.worker, 'high'),
						orgCtx.executor.name,
						orgCtx.executor.tier,
					),
				}));
				this.nodeAnchorsById.set(node.id, { worker: concentric, employee: empSatellite });

				const wrkTopBar = append(innerCore, $('div.ade-eng-wrk-topbar'));
				append(wrkTopBar, $('span.ade-eng-role-tag.wrk', {}, `${orgCtx.executor.name.toUpperCase()} · L${orgCtx.executor.tier}`));
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
					title: localize('adeEngNodeTitleDblClickTip', "[{0}] {1} — Double-click to rename inline", node.id, node.title),
				}, node.title));
				this.nodeTitleDomById.set(node.id, nodeTitleEl);
				// Figma-style direct manipulation: Double-click pod title to rename inline on canvas!
				this.canvasRenderDisposables.add(addDisposableListener(nodeTitleEl, EventType.DBLCLICK, e => {
					EventHelper.stop(e, true);
					if (isLocked || !this.draftBlueprint) {
						return;
					}
					const editInput = $('input.ade-eng-inline-rename', { type: 'text', value: node.title }) as HTMLInputElement;
					nodeTitleEl.replaceWith(editInput);
					let finished = false;
					const finishRename = (commit: boolean) => {
						if (finished) {
							return;
						}
						finished = true;
						const nextTitle = editInput.value.trim();
						if (commit && nextTitle && nextTitle !== node.title && this.draftBlueprint) {
							this.markDraftModified({
								...this.draftBlueprint,
								nodes: this.draftBlueprint.nodes.map(n => n.id === node.id ? { ...n, title: nextTitle } : n),
							}, { coalesceKey: `rename:${node.id}` });
						} else {
							this.renderCanvas();
						}
					};
					this.canvasRenderDisposables.add(addDisposableListener(editInput, EventType.POINTER_DOWN, pe => EventHelper.stop(pe, true)));
					this.canvasRenderDisposables.add(addDisposableListener(editInput, EventType.CLICK, ce => EventHelper.stop(ce, true)));
					this.canvasRenderDisposables.add(addDisposableListener(editInput, EventType.KEY_DOWN, (ke: KeyboardEvent) => {
						if (ke.key === 'Enter') {
							EventHelper.stop(ke, true);
							finishRename(true);
						} else if (ke.key === 'Escape') {
							EventHelper.stop(ke, true);
							finishRename(false);
						}
					}));
					this.canvasRenderDisposables.add(addDisposableListener(editInput, EventType.BLUR, () => finishRename(true)));
					editInput.focus();
					editInput.select();
				}));
				append(wrkTextCol, $('span.ade-eng-node-sub', {
					title: `Worker: ${node.worker?.engine ?? 'claude-code'}${node.worker?.model ? ` (${node.worker.model})` : ''} · thinking=${node.worker?.thinking ?? 'high'}`,
				}, formatRoleConfigCompact(node.worker, 'high')));

				// Live 1-line Activity Ticker inside recessed Worker L4 core
				const latestFile = runtime?.lastChanges?.touchedFiles?.[0]?.relativePath;
				const reportEntry = snap.state.reports?.[node.id];
				let tickerKind: 'coding' | 'audit' | 'warn' | 'done' | 'idle' = 'idle';
				let tickerText = (node.goal?.trim() || node.acceptance?.trim() || localize('adeEngTickerReady', "Ready for dispatch")).replace(/\s+/g, ' ');
				if (visualStatus === 'failure_1' || visualStatus === 'failure_2' || visualStatus === 'failure_3') {
					tickerKind = 'warn';
					tickerText = `⚠ ${(runtime?.lastManagerFeedback || runtime?.lastEmployeeFeedback || localize('adeEngTickerRework', "Adversarial rework in progress")).replace(/\s+/g, ' ')}`;
				} else if (empActive) {
					tickerKind = 'audit';
					const cnt = runtime?.lastChanges?.touchedFiles.length ?? 0;
					tickerText = cnt > 0
						? localize('adeEngTickerAuditingFiles', "▸ L3 auditing {0} touched file(s)…", cnt)
						: localize('adeEngTickerAuditing', "▸ L3 verifying diff & acceptance criteria…");
				} else if (mgrActive) {
					tickerKind = 'audit';
					tickerText = localize('adeEngTickerMgrReview', "▸ L2 Manager segment sign-off…");
				} else if (workerActive) {
					tickerKind = 'coding';
					tickerText = latestFile
						? localize('adeEngTickerCodingFile', "▸ Coding · {0}", latestFile)
						: localize('adeEngTickerCodingGoal', "▸ Coding · {0}", tickerText);
				} else if (isLocked) {
					tickerKind = 'done';
					tickerText = reportEntry?.summary
						? `✓ ${reportEntry.summary.replace(/\s+/g, ' ')}`
						: localize('adeEngTickerVerified', "✓ Verified & locked");
				} else {
					tickerText = `· ${tickerText}`;
				}
				append(innerCore, $(`div.ade-eng-wrk-ticker.kind-${tickerKind}`, {
					title: tickerText,
				}, tickerText));

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
					const overSla = now - startedAt >= ADE_ENG_PHASE_SOFT_SLA_MS;
					const role = phaseRoleOf(runtime.phase) ?? 'wrk';
					const pill = append(footLeft, $(`span.ade-eng-live-phase-pill${overSla ? '.over-sla' : ''}`, {
						'data-started-at': String(startedAt),
						'data-phase-label': activePhaseLabel,
						'data-phase-role': role,
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
					append(footLeft, $('span.ade-eng-pod-goal-hint', {
						title: localize('adeEngPipelineReadyTooltip', "Ready — Worker (L4) → Employee Audit (L3) → Manager Sign-off (L2)"),
					}, localize('adeEngReadyPipelineHint', "Ready · L4→L3→L2")));
				}

				const touchedCount = runtime?.lastChanges?.touchedFiles.length ?? 0;
				if (touchedCount > 0) {
					const diffStats = computeDiffLineStats(runtime?.lastChanges?.combinedDiff);
					const filesChip = append(footRight, $('button.ade-eng-pod-files-pill', {
						type: 'button',
						title: localize('adeEngTouchedFilesBadgeTooltip', "{0} touched file(s) (+{1} -{2}) — Click to view diff", touchedCount, diffStats.added, diffStats.removed),
					}));
					if (diffStats.added > 0 || diffStats.removed > 0) {
						append(filesChip, $('span.ade-eng-diff-add', {}, `+${diffStats.added}`));
						if (diffStats.removed > 0) {
							append(filesChip, $('span.ade-eng-diff-del', {}, `-${diffStats.removed}`));
						}
					} else {
						append(filesChip, $('span', {}, `${touchedCount}f`));
					}
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
					const nCost = fin.costByNode[node.id] ?? 0;
					const sumRole = Math.max(1, wTok + eTok + mTok);
					const wPct = Math.round((wTok / sumRole) * 100);
					const ePct = Math.round(((wTok + eTok) / sumRole) * 100);
					const nodeBreakdownTitle = localize(
						'adeEngNodeTokensTooltip',
						"Node [{0}] Tokens: {1} total · Est. {8} (In {2} · Out {3} · Cache {4})\nWorker (L4): {5} · Employee (L3): {6} · Manager (L2): {7}",
						node.id,
						nodeTok.totalTokens.toLocaleString(),
						nodeTok.inputTokens.toLocaleString(),
						nodeTok.outputTokens.toLocaleString(),
						nodeTok.cacheReadTokens.toLocaleString(),
						wTok.toLocaleString(),
						eTok.toLocaleString(),
						mTok.toLocaleString(),
						formatUsdCost(nCost),
					);
					const tokLabel = nCost > 0
						? `${formatCompactTokenCount(nodeTok.totalTokens)} · ${formatUsdCost(nCost)}`
						: `${formatCompactTokenCount(nodeTok.totalTokens)} tok`;
					const tokEl = append(footRight, $('span.ade-eng-node-tokens', {
						title: nodeBreakdownTitle,
					}, tokLabel));
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
		this.buildSvgMarkers();
		const bp = this.draftBlueprint;
		const snap = this.snapshot;
		if (!bp || !snap) {
			return;
		}
		const nodeById = new Map(bp.nodes.map(n => [n.id, n]));
		const runtimes = snap.state.nodes;
		let runningEdgeCount = 0;

		bp.edges.forEach((edge, edgeIdx) => {
			const src = nodeById.get(edge.from);
			const dst = nodeById.get(edge.to);
			if (!src || !dst) {
				return;
			}
			const p1 = this.getNodePorts(src);
			const p2 = this.getNodePorts(dst);
			const route = this.buildOrthogonalEdgeRoute(p1.outX, p1.outY, p2.inX, p2.inY, edge.from, edge.to);
			const d = route.path;
			const edgeStatus: AdeEngineeringEdgeVisualStatus = computeEdgeVisualStatus(edge, runtimes);
			const canDelete = !this.isNodeCompletedLocked(edge.to);
			const edgeUid = `${this.instanceUid}-${edgeIdx}-${sanitizeSvgId(edge.from)}-${sanitizeSvgId(edge.to)}`;
			const pathId = `ade-edge-path-${edgeUid}`;

			const g = this.edgesGroupEl.appendChild($.SVG<SVGGElement>('g', {
				class: `ade-eng-edge-item status-${edgeStatus}${canDelete ? ' deletable' : ''}`,
				'data-edge': `${edge.from}->${edge.to}`,
				'data-edge-status': edgeStatus,
			}));

			let gradUrl: string | undefined;
			if (edgeStatus === 'running' || edgeStatus === 'completed') {
				const gradId = `ade-edge-grad-${edgeUid}`;
				const grad = $.SVG<SVGLinearGradientElement>('linearGradient', {
					id: gradId,
					gradientUnits: 'userSpaceOnUse',
					x1: String(Math.round(p1.outX)),
					y1: String(Math.round(p1.outY)),
					x2: String(Math.round(p2.inX)),
					y2: String(Math.round(p2.inY)),
				});
				grad.appendChild($.SVG<SVGStopElement>('stop', {
					offset: '0%',
					'stop-color': edgeStatus === 'running' ? '#10b981' : '#059669',
					'stop-opacity': '0.62',
				}));
				grad.appendChild($.SVG<SVGStopElement>('stop', {
					offset: '100%',
					'stop-color': edgeStatus === 'running' ? '#34d399' : '#3fb950',
					'stop-opacity': '1',
				}));
				this.edgesDefsEl.appendChild(grad);
				gradUrl = `url(#${gradId})`;

				g.appendChild($.SVG<SVGPathElement>('path', {
					class: `ade-eng-edge-glow status-${edgeStatus}`,
					d,
				}));
			}

			const edgePath = g.appendChild($.SVG<SVGPathElement>('path', {
				id: pathId,
				class: `ade-eng-edge-path status-${edgeStatus}`,
				d,
				'marker-end': `url(#${this.markerId(edgeStatus)})`,
			}));
			if (gradUrl) {
				edgePath.style.setProperty('--ade-edge-stroke', gradUrl);
			}

			// Capped SMIL directional signal particles on running edges (≤ 24 animated edges; CSS hides under reduced-motion)
			if (edgeStatus === 'running') {
				runningEdgeCount++;
				if (runningEdgeCount <= ADE_ENG_MAX_PARTICLE_EDGES) {
					for (let pi = 0; pi < ADE_ENG_PARTICLES_PER_EDGE; pi++) {
						const particle = g.appendChild($.SVG<SVGCircleElement>('circle', {
							class: 'ade-eng-edge-particle',
							r: '2.7',
						}));
						const motion = particle.appendChild($.SVG('animateMotion', {
							dur: '1.6s',
							begin: `${(pi * 0.53).toFixed(2)}s`,
							repeatCount: 'indefinite',
						}));
						const mpath = motion.appendChild($.SVG('mpath', {
							href: `#${pathId}`,
						}));
						mpath.setAttributeNS(XLINK_NS, 'xlink:href', `#${pathId}`);
					}
				}
			}

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

				const midX = Math.round(route.midX);
				const midY = Math.round(route.midY);
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
		});
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
			this.rubberBandPathEl.setAttribute('d', this.buildOrthogonalEdgePath(startPorts.outX, startPorts.outY, startPorts.outX + 24, startPorts.outY, node.id));

			const win = getWindow(this.rootEl);
			const moveListener = addDisposableListener(win, EventType.POINTER_MOVE, (me: PointerEvent) => {
				if (!wiring) {
					return;
				}
				const rect = this.viewportEl.getBoundingClientRect();
				const wx = (me.clientX - rect.left - this.panX) / this.zoom;
				const wy = (me.clientY - rect.top - this.panY) / this.zoom;
				const curPorts = this.getNodePorts(node);
				this.rubberBandPathEl.setAttribute('d', this.buildOrthogonalEdgePath(curPorts.outX, curPorts.outY, wx, wy, node.id));
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
			if (target?.closest('.ade-eng-port, .ade-eng-quick-spawn-btn, .ade-eng-node-cfg-btn, .ade-eng-pod-report-btn, .ade-eng-pod-files-pill, .ade-eng-gate-inline-actions, .ade-eng-pod-quickbar, .ade-eng-inline-rename')) {
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

			this.scrollBlueprintEditorToNode(node.id);
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
		this.popoverPinBtnEl = undefined;
		this.popoverTabBtnById.clear();

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

		const pinBtn = append(header, $(`button.ade-eng-pop-icon-btn.pin${this.popoverPinned ? '.active' : ''}`, {
			type: 'button',
			'aria-pressed': String(this.popoverPinned),
			title: localize('adeEngPinPopoverTooltip', "Pin Inspector (keep open on canvas click & drag by header)"),
		}));
		this.popoverPinBtnEl = pinBtn;
		pinBtn.classList.add(...ThemeIcon.asClassNameArray(this.popoverPinned ? Codicon.pinned : Codicon.pin));
		this.popoverRenderDisposables.add(addDisposableListener(pinBtn, EventType.CLICK, e => {
			EventHelper.stop(e, true);
			this.setPopoverPinned(!this.popoverPinned);
			this.renderPopover();
		}));

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
			this.popoverTabOrder = [];
			this.renderGatePopoverBody(draftNode, runtime, isLocked, updateNodeDraft);
			this.positionPopoverNearAnchor();
			return;
		}

		// 3. Task Node 32×20 Mini Podmap + Segmented Role Switcher (←/→ & 1–5 keyboard nav)
		const ownReport = snap.state.reports[draftNode.id];
		const hasReportOrFeedback = Boolean(
			ownReport
			|| (runtime?.lastChanges && runtime.lastChanges.touchedFiles.length > 0)
			|| runtime?.lastEmployeeFeedback
			|| runtime?.lastManagerFeedback
			|| runtime?.lastGateFeedback
			|| (runtime && (runtime.formalFailureCount > 0 || runtime.completed)),
		);
		const reportVerdictCls = runtime?.completed
			? 'verdict-pass'
			: (runtime?.formalFailureCount ?? 0) >= 3
				? 'verdict-fail'
				: ((runtime?.formalFailureCount ?? 0) > 0 || (runtime?.employeeRejectCount ?? 0) > 0)
					? 'verdict-warn'
					: '';

		const tabStripRow = append(this.popoverContentEl, $('.ade-eng-pop-tabstrip'));
		const podmap = append(tabStripRow, $(`div.ade-eng-pop-podmap.active-${this.activePopoverTab}`, { 'aria-hidden': 'true' }));
		const pmSvg = podmap.appendChild($.SVG<SVGSVGElement>('svg', {
			viewBox: '0 0 32 20',
			width: '32',
			height: '20',
		}));
		pmSvg.appendChild($.SVG<SVGRectElement>('rect', { class: 'pm-lane', x: '1', y: '1', width: '30', height: '18', rx: '4' }));
		pmSvg.appendChild($.SVG<SVGRectElement>('rect', { class: 'pm-shell', x: '4', y: '3.5', width: '24', height: '13', rx: '3' }));
		pmSvg.appendChild($.SVG<SVGRectElement>('rect', { class: 'pm-core', x: '7.5', y: '6.5', width: '17', height: '7', rx: '1.8' }));

		const segBar = append(tabStripRow, $('.ade-eng-pop-role-tabs', { role: 'tablist' }));
		const tabs: { readonly id: PopoverTabKind; readonly label: string; readonly dot?: boolean; readonly extraCls?: string }[] = [
			{ id: 'worker', label: localize('adeEngPopTabWorker', "Worker") },
			{ id: 'employee', label: localize('adeEngPopTabEmployee', "Employee") },
			...(seg ? [{ id: 'manager' as const, label: `Mgr [${seg.segmentId}]` }] : []),
			{ id: 'task', label: localize('adeEngPopTabTask', "Spec") },
			{ id: 'report', label: localize('adeEngPopTabReport', "Report"), dot: hasReportOrFeedback, extraCls: reportVerdictCls },
		];
		this.popoverTabOrder = tabs.map(t => t.id);
		const activeIdx = Math.max(0, tabs.findIndex(t => t.id === this.activePopoverTab));
		segBar.style.setProperty('--tab-count', String(tabs.length));
		segBar.style.setProperty('--tab-idx', String(activeIdx));
		for (const t of tabs) {
			const isActive = this.activePopoverTab === t.id;
			const btn = append(segBar, $(`button.ade-eng-pop-role-tab.tab-${t.id}${isActive ? '.active' : ''}${t.dot ? '.has-dot' : ''}${t.extraCls ? `.${t.extraCls}` : ''}`, {
				type: 'button',
				role: 'tab',
				'aria-selected': String(isActive),
				tabindex: isActive ? '0' : '-1',
				title: t.label,
			}, t.label));
			if (t.dot) {
				append(btn, $('span.ade-eng-tab-dot'));
			}
			this.popoverTabBtnById.set(t.id, btn);
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
			placeholder: localize('adeEngModelCompactPlaceholder', "Default model (or enter e.g. sonnet, gpt-5, deepseek-reasoner)"),
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

		if (runtime && (runtime.completed || runtime.formalFailureCount > 0 || runtime.employeeRejectCount > 0 || runtime.phase !== 'idle')) {
			const verdictStrip = append(body, $('.ade-eng-verdict-strip'));
			const empVerdict = runtime.completed
				? { cls: 'pass', text: localize('adeEngEmpVerdictPass', "EMP · PASS") }
				: runtime.employeeRejectCount > 0
					? { cls: 'warn', text: localize('adeEngEmpVerdictRework', "EMP · REWORK {0}/3", runtime.employeeRejectCount) }
					: runtime.phase === 'employee_review'
						? { cls: 'active', text: localize('adeEngEmpVerdictAudit', "EMP · AUDITING") }
						: { cls: 'idle', text: localize('adeEngEmpVerdictIdle', "EMP · STANDBY") };
			append(verdictStrip, $(`span.ade-eng-verdict-pill.${empVerdict.cls}`, {}, empVerdict.text));

			const mgrVerdict = runtime.completed
				? { cls: 'pass', text: localize('adeEngMgrVerdictPass', "MGR · PASS") }
				: runtime.formalFailureCount >= 3
					? { cls: 'fail', text: localize('adeEngMgrVerdictBroken', "MGR · BROKEN") }
					: runtime.formalFailureCount > 0
						? { cls: 'warn', text: localize('adeEngMgrVerdictEscalate', "MGR · RETRY {0}/3", runtime.formalFailureCount) }
						: { cls: 'idle', text: localize('adeEngMgrVerdictIdle', "MGR · OK") };
			append(verdictStrip, $(`span.ade-eng-verdict-pill.${mgrVerdict.cls}`, {}, mgrVerdict.text));

			if (runtime.formalFailureCount > 0) {
				const stepper = append(verdictStrip, $('.ade-eng-attempt-stepper', {
					title: localize('adeEngAttemptStepperTooltip', "Formal failure ladder ({0} of 3 attempts used)", runtime.formalFailureCount),
				}));
				for (let step = 1; step <= 3; step++) {
					const lit = step <= runtime.formalFailureCount;
					append(stepper, $(`span.ade-eng-attempt-step.step-${step}${lit ? '.lit' : ''}`, {}, `F${step}`));
				}
			}
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
				if (f.diff) {
					let addCount = 0;
					let delCount = 0;
					for (const dl of f.diff.split('\n')) {
						if (dl.startsWith('+') && !dl.startsWith('+++')) {
							addCount++;
						} else if (dl.startsWith('-') && !dl.startsWith('---')) {
							delCount++;
						}
					}
					if (addCount > 0 || delCount > 0) {
						append(fileBtn, $('span.ade-eng-file-diff-stat', {}, `+${addCount} −${delCount}`));
					}
				}
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

	private matchesEventSearch(ev: IAdeEngineeringEventLogEntry): boolean {
		const q = this.eventSearchQuery.trim().toLowerCase();
		if (!q) {
			return true;
		}
		return (
			ev.event.toLowerCase().includes(q)
			|| (ev.nodeId?.toLowerCase().includes(q) ?? false)
			|| (ev.segmentId?.toLowerCase().includes(q) ?? false)
			|| (ev.detail?.toLowerCase().includes(q) ?? false)
		);
	}

	private scrollBlueprintEditorToNode(nodeId: string): void {
		const editor = this.blueprintEditorEl;
		if (this.activeSheetTab !== 'blueprint' || !editor || !editor.isConnected) {
			return;
		}
		const lineIdx = blueprintNodeSectionLine(editor.value, nodeId);
		if (lineIdx < 0) {
			return;
		}
		const lineHeightPx = 17;
		editor.scrollTop = Math.max(0, (lineIdx - 1) * lineHeightPx);
		this.setXrefNode(nodeId);
	}

	private syncEventsNewPill(): void {
		const pill = this.sheetEventsNewPillEl;
		if (!pill || !this.snapshot) {
			return;
		}
		const unseen = Math.max(0, this.snapshot.state.events.length - this.eventsSeenCount);
		if (unseen > 0) {
			pill.textContent = localize('adeEngEventsNewPill', "↓ {0} new", unseen);
			pill.hidden = false;
		} else {
			pill.hidden = true;
		}
	}

	private renderEventTimelineRows(body: HTMLElement, snap: IAdeEngineeringTreeSnapshot): void {
		this.sheetTimelineDisposables.clear();
		clearNode(body);
		const events = snap.state.events.filter(ev => this.matchesEventFilter(ev) && this.matchesEventSearch(ev));
		if (events.length === 0) {
			append(body, $('div.ade-eng-empty-hint', {}, localize('adeEngNoEventsYet', "No execution events match this filter yet.")));
			return;
		}

		const now = Date.now();
		let idx = 0;
		while (idx < events.length) {
			const first = events[idx];
			let end = idx + 1;
			if (first.nodeId) {
				while (end < events.length && events[end].nodeId === first.nodeId) {
					end++;
				}
			}
			const slice = events.slice(idx, end);
			idx = end;

			let rowHost: HTMLElement = body;
			if (first.nodeId && slice.length > 1) {
				const groupNodeId = first.nodeId;
				const group = append(body, $('div.ade-eng-event-group', { 'data-node-id': groupNodeId }));
				const gHead = append(group, $('button.ade-eng-event-group-head', {
					type: 'button',
					'aria-expanded': 'true',
				}));
				append(gHead, $('span.ade-eng-node-id-chip', {}, groupNodeId));
				append(gHead, $('span.ade-eng-event-group-count', {}, localize('adeEngEventGroupCount', "{0} events", slice.length)));
				const rowsWrap = append(group, $('div.ade-eng-event-group-rows'));
				this.sheetTimelineDisposables.add(addDisposableListener(gHead, EventType.CLICK, () => {
					const collapsed = group.classList.toggle('collapsed');
					gHead.setAttribute('aria-expanded', String(!collapsed));
				}));
				rowHost = rowsWrap;
			}

			for (const ev of slice) {
				const role = eventRoleOf(ev);
				const row = append(rowHost, $(`div.ade-eng-event-row.level-${ev.level}.kind-${ev.event}.role-${role}`));
				const rail = append(row, $('span.ade-eng-event-rail', { 'aria-hidden': 'true' }));
				append(rail, $(`i.ade-eng-event-rail-dot.role-${role}`));

				const content = append(row, $('div.ade-eng-event-content'));
				const meta = append(content, $('div.ade-eng-event-meta'));
				const d = new Date(ev.timestamp);
				const hhmmss = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
				append(meta, $('span.ade-eng-event-time', {
					title: hhmmss,
				}, `${formatRelativeAge(ev.timestamp, now)} · ${hhmmss}`));
				if (ev.nodeId) {
					const nodeId = ev.nodeId;
					const nodeJumpBtn = append(meta, $('button.ade-eng-event-node-btn', {
						type: 'button',
						title: localize('adeEngJumpToEventNodeTooltip', "Click to focus [{0}] on canvas", nodeId),
					}, `[${nodeId}]`));
					this.sheetTimelineDisposables.add(addDisposableListener(nodeJumpBtn, EventType.CLICK, () => {
						this.focusNodeOnCanvas(nodeId, false);
					}));
				}
				append(meta, $('span.ade-eng-event-kind', {}, ev.event));
				if (ev.detail) {
					append(content, $('div.ade-eng-event-msg', {}, ev.detail));
				}
			}
		}
	}

	private renderSheet(): void {
		this.sheetRenderDisposables.clear();
		this.sheetTimelineDisposables.clear();
		clearNode(this.sheetContentEl);
		this.sheetEventsBodyEl = undefined;
		this.sheetEventsNewPillEl = undefined;
		this.blueprintEditorEl = undefined;
		if (!this.activeSheetTab || !this.snapshot) {
			return;
		}
		this.syncSheetModeClasses();
		const snap = this.snapshot;

		const head = append(this.sheetContentEl, $('.ade-eng-sheet-header'));
		const tabsWrap = append(head, $('.ade-eng-sheet-tabs'));
		const bpTabBtn = append(tabsWrap, $(`button.ade-eng-sheet-tab${this.activeSheetTab === 'blueprint' ? '.active' : ''}`, {
			type: 'button',
		}, localize('adeEngSheetBlueprintTab', "Blueprint")));
		const evTabBtn = append(tabsWrap, $(`button.ade-eng-sheet-tab${this.activeSheetTab === 'events' ? '.active' : ''}`, {
			type: 'button',
		}, localize('adeEngSheetEventsTab', "Logs ({0})", snap.state.events.length)));
		const wtEntries = Object.values(snap.state.worktrees ?? {});
		const showWorktreesTab = snap.blueprint.metadata.workspaceIsolation === 'worktree' || wtEntries.length > 0 || this.activeSheetTab === 'worktrees';
		if (showWorktreesTab) {
			const wtTabBtn = append(tabsWrap, $(`button.ade-eng-sheet-tab${this.activeSheetTab === 'worktrees' ? '.active' : ''}`, {
				type: 'button',
			}, localize('adeEngSheetWorktreesTab', "Worktrees ({0})", wtEntries.length)));
			this.sheetRenderDisposables.add(addDisposableListener(wtTabBtn, EventType.CLICK, () => {
				this.activeSheetTab = 'worktrees';
				this.setXrefNode(undefined);
				this.renderToolbar();
				this.renderSheet();
			}));
		}

		this.sheetRenderDisposables.add(addDisposableListener(bpTabBtn, EventType.CLICK, () => {
			this.activeSheetTab = 'blueprint';
			this.renderToolbar();
			this.renderSheet();
		}));
		this.sheetRenderDisposables.add(addDisposableListener(evTabBtn, EventType.CLICK, () => {
			this.activeSheetTab = 'events';
			this.eventsSeenCount = snap.state.events.length;
			this.setXrefNode(undefined);
			this.renderToolbar();
			this.renderSheet();
			if (this.sheetEventsBodyEl) {
				this.sheetEventsBodyEl.scrollTop = this.sheetEventsBodyEl.scrollHeight;
			}
		}));

		const headRight = append(head, $('.ade-eng-sheet-head-actions'));
		let diffBadgeEl: HTMLElement | undefined;
		if (this.activeSheetTab === 'blueprint') {
			diffBadgeEl = append(headRight, $('span.ade-eng-sheet-diff-badge'));
			diffBadgeEl.hidden = true;
		}

		const modeBtn = append(headRight, $(`button.ade-eng-sheet-mode-btn${this.sheetMode === 'split' ? '.active' : ''}`, {
			type: 'button',
			'aria-pressed': String(this.sheetMode === 'split'),
			title: localize('adeEngSheetModeToggleTooltip', "Toggle Overlay ⇄ Side-by-Side Split View"),
		}));
		const modeIco = append(modeBtn, $('span'));
		modeIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.splitHorizontal));
		append(modeBtn, $('span', {}, this.sheetMode === 'split'
			? localize('adeEngSheetModeSplit', "Split")
			: localize('adeEngSheetModeOverlay', "Overlay")));
		this.sheetRenderDisposables.add(addDisposableListener(modeBtn, EventType.CLICK, () => {
			this.setSheetMode(this.sheetMode === 'overlay' ? 'split' : 'overlay');
		}));

		const closeBtn = append(headRight, $('button.ade-eng-pop-icon-btn.close', {
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
			const baselineMd = serializeEngineeringBlueprint(snap.blueprint);

			const editorWrap = append(body, $('.ade-eng-bp-editor-wrap'));
			const gutter = append(editorWrap, $('div.ade-eng-bp-gutter', { 'aria-hidden': 'true' }));
			const gutterInner = append(gutter, $('div.ade-eng-bp-gutter-inner'));
			const editor = append(editorWrap, $('textarea.ade-eng-blueprint-editor', {
				spellcheck: 'false',
			})) as HTMLTextAreaElement;
			editor.value = initialMd;
			this.blueprintEditorEl = editor;

			const statusMsg = append(body, $('div.ade-eng-sheet-status'));

			const syncGutterAndStatus = () => {
				const lines = editor.value.split('\n');
				const activeId = blueprintNodeIdAtOffset(editor.value, editor.selectionStart ?? 0);
				this.setXrefNode(activeId);
				const activeLine = activeId ? blueprintNodeSectionLine(editor.value, activeId) : -1;
				clearNode(gutterInner);
				for (let i = 0; i < lines.length; i++) {
					append(gutterInner, $(`span.ade-eng-bp-line${i === activeLine ? '.active' : ''}`, {}, String(i + 1)));
				}
				gutterInner.style.transform = `translateY(${-Math.round(editor.scrollTop)}px)`;

				if (diffBadgeEl) {
					const diffCount = countChangedLines(baselineMd, editor.value);
					diffBadgeEl.hidden = diffCount === 0;
					diffBadgeEl.textContent = localize('adeEngSheetDiffCount', "{0} changes", diffCount);
				}

				try {
					const parsed = parseEngineeringBlueprint(editor.value, {
						governorSessionId: snap.governorSessionId,
						treeType: snap.treeType,
					});
					statusMsg.textContent = localize(
						'adeEngSheetValidStatus',
						"✓ Valid Blueprint · {0} nodes · {1} edges",
						parsed.nodes.length,
						parsed.edges.length,
					);
					statusMsg.className = 'ade-eng-sheet-status ok';
				} catch (err) {
					statusMsg.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
					statusMsg.className = 'ade-eng-sheet-status err';
				}
			};
			syncGutterAndStatus();

			this.sheetRenderDisposables.add(addDisposableListener(editor, EventType.SCROLL, () => {
				gutterInner.style.transform = `translateY(${-Math.round(editor.scrollTop)}px)`;
			}));
			const syncCaret = () => {
				const activeId = blueprintNodeIdAtOffset(editor.value, editor.selectionStart ?? 0);
				this.setXrefNode(activeId);
			};
			this.sheetRenderDisposables.add(addDisposableListener(editor, EventType.INPUT, syncGutterAndStatus));
			this.sheetRenderDisposables.add(addDisposableListener(editor, EventType.CLICK, syncCaret));
			this.sheetRenderDisposables.add(addDisposableListener(editor, EventType.KEY_UP, syncCaret));
			this.sheetRenderDisposables.add(addDisposableListener(editor, 'select', syncCaret));

			const actions = append(body, $('.ade-eng-sheet-actions'));
			const copyBtn = append(actions, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
			}, localize('adeEngCopyBlueprintBtn', "Copy Markdown")));
			this.sheetRenderDisposables.add(addDisposableListener(copyBtn, EventType.CLICK, () => {
				void getWindow(this.rootEl).navigator.clipboard?.writeText(editor.value);
				statusMsg.textContent = localize('adeEngCopiedBlueprintMsg', "Blueprint Markdown copied to clipboard.");
				statusMsg.className = 'ade-eng-sheet-status ok';
			}));

			const exportBtn = append(actions, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
				title: localize('adeEngExportBlueprintTooltip', "Download shareable .aexus-blueprint.md file"),
			}, localize('adeEngExportBlueprintBtn', "Export .md")));
			this.sheetRenderDisposables.add(addDisposableListener(exportBtn, EventType.CLICK, () => {
				const win = getWindow(this.rootEl);
				const blob = new Blob([editor.value], { type: 'text/markdown;charset=utf-8' });
				const url = win.URL.createObjectURL(blob);
				const link = win.document.createElement('a');
				const safeName = (snap.governorLabel || snap.governorSessionId).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'aexus-dag';
				link.href = url;
				link.download = `${safeName}.aexus-blueprint.md`;
				link.click();
				win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
				statusMsg.textContent = localize('adeEngExportedBlueprintMsg', "Exported {0}.aexus-blueprint.md.", safeName);
				statusMsg.className = 'ade-eng-sheet-status ok';
			}));

			const prReportBtn = append(actions, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
				title: localize('adeEngSheetCopyPrTooltip', "Copy GitHub PR-ready Verification & FinOps Report"),
			}, localize('adeEngSheetCopyPrBtn', "PR Report")));
			this.sheetRenderDisposables.add(addDisposableListener(prReportBtn, EventType.CLICK, () => {
				this.copyRunReportToClipboard(prReportBtn);
			}));

			const exportSvgBtn = append(actions, $('button.ade-eng-action-btn.secondary', {
				type: 'button',
				title: localize('adeEngSheetExportSvgTooltip', "Export shareable vector SVG snapshot of this DAG"),
			}, localize('adeEngSheetExportSvgBtn', "Export SVG")));
			this.sheetRenderDisposables.add(addDisposableListener(exportSvgBtn, EventType.CLICK, () => {
				this.exportDagSvg();
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
					statusMsg.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
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
		} else if (this.activeSheetTab === 'worktrees') {
			const body = append(this.sheetContentEl, $('.ade-eng-sheet-body.worktrees'));
			const wtList = Object.values(snap.state.worktrees ?? {});
			const summaryBanner = append(body, $('.ade-eng-wt-summary'));
			append(summaryBanner, $('div.ade-eng-wt-summary-title', {}, snap.blueprint.metadata.workspaceIsolation === 'worktree'
				? localize('adeEngWtActiveModeTitle', "Git Worktree Sandbox Isolation Enabled")
				: localize('adeEngWtSharedModeTitle', "Shared Workspace Mode")));
			const orgCtx = this.getOrgRoleContext();
			append(summaryBanner, $('div.ade-eng-wt-summary-sub', {}, localize(
				'adeEngWtSummaryDesc',
				"Each parallel {0} · L{1} segment executes on its own Git worktree branch so concurrent {2} lanes never collide. Review changes and merge cleanly into your main branch.",
				orgCtx.segmentOwner.name,
				orgCtx.segmentOwner.tier,
				orgCtx.executor.name,
			)));

			if (wtList.length === 0) {
				append(body, $('div.ade-eng-empty-hint', {}, localize('adeEngWtNoneYet', "No isolated worktrees have been provisioned yet. Run the DAG in Worktree mode to spin up per-segment branches automatically.")));
			} else {
				const listWrap = append(body, $('.ade-eng-wt-list'));
				for (const wt of wtList) {
					const seg = snap.blueprint.managers.find(m => m.segmentId === wt.segmentId);
					const segTouched = new Set<string>();
					for (const nid of seg?.nodeIds ?? []) {
						for (const f of snap.state.nodes[nid]?.lastChanges?.touchedFiles ?? []) {
							segTouched.add(f.relativePath);
						}
					}
					const card = append(listWrap, $('.ade-eng-wt-card', { 'data-segment-id': wt.segmentId }));
					const top = append(card, $('.ade-eng-wt-card-top'));
					append(top, $('span.ade-eng-role-tag.mgr', {}, `MGR · ${wt.segmentId}`));
					const br = append(top, $('span.ade-eng-wt-branch-chip', {}));
					const brIco = append(br, $('span'));
					brIco.classList.add(...ThemeIcon.asClassNameArray(Codicon.gitBranch));
					append(br, $('span', {}, wt.branchName));
					if (wt.headCommit) {
						append(top, $('span.ade-eng-wt-sha', {}, wt.headCommit.slice(0, 7)));
					}
					append(card, $('div.ade-eng-wt-path', { title: wt.worktreePath }, wt.worktreePath));
					const foot = append(card, $('.ade-eng-wt-card-foot'));
					append(foot, $('span.ade-eng-wt-files', {}, localize('adeEngWtFilesCount', "{0} touched file(s)", segTouched.size)));
					const focusBtn = append(foot, $('button.ade-eng-wt-focus-btn', { type: 'button' }, localize('adeEngWtFocusLaneBtn', "Focus Lane")));
					this.sheetRenderDisposables.add(addDisposableListener(focusBtn, EventType.CLICK, () => this.focusSegmentOnCanvas(wt.segmentId)));
				}
			}

			const wtStatusEl = append(body, $('div.ade-eng-sheet-status'));
			const actions = append(body, $('.ade-eng-sheet-actions'));
			const mergeBtn = append(actions, $('button.ade-eng-action-btn.confirm.ade-eng-wt-merge-btn', {
				type: 'button',
				...(wtList.length === 0 || this.worktreeActionBusy ? { disabled: 'disabled' } : {}),
			}, localize('adeEngWtMergeAllBtn', "Merge All into Project"))) as HTMLButtonElement;
			const cleanBtn = append(actions, $('button.ade-eng-action-btn.secondary.ade-eng-wt-cleanup-btn', {
				type: 'button',
				...(wtList.length === 0 || this.worktreeActionBusy ? { disabled: 'disabled' } : {}),
			}, localize('adeEngWtCleanupBtn', "Clean Up Worktrees"))) as HTMLButtonElement;

			this.sheetRenderDisposables.add(addDisposableListener(mergeBtn, EventType.CLICK, async () => {
				if (!this.activeGovernorId || !this.engineering.mergeTreeWorktrees || this.worktreeActionBusy) {
					return;
				}
				this.worktreeActionBusy = true;
				mergeBtn.disabled = true;
				cleanBtn.disabled = true;
				try {
					const res = await this.engineering.mergeTreeWorktrees(this.activeGovernorId);
					wtStatusEl.textContent = res.ok ? `✓ ${res.summary}` : `⚠ ${res.summary}`;
					wtStatusEl.className = `ade-eng-sheet-status ${res.ok ? 'ok' : 'err'}`;
				} catch (err) {
					wtStatusEl.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
					wtStatusEl.className = 'ade-eng-sheet-status err';
				} finally {
					this.worktreeActionBusy = false;
					if (this.activeSheetTab === 'worktrees') {
						this.renderSheet();
					}
				}
			}));

			this.sheetRenderDisposables.add(addDisposableListener(cleanBtn, EventType.CLICK, async () => {
				if (!this.activeGovernorId || !this.engineering.cleanupTreeWorktrees || this.worktreeActionBusy) {
					return;
				}
				this.worktreeActionBusy = true;
				mergeBtn.disabled = true;
				cleanBtn.disabled = true;
				try {
					await this.engineering.cleanupTreeWorktrees(this.activeGovernorId);
					wtStatusEl.textContent = localize('adeEngWtCleanedMsg', "✓ Pruned all isolated worktrees cleanly.");
					wtStatusEl.className = 'ade-eng-sheet-status ok';
				} catch (err) {
					wtStatusEl.textContent = `⚠ ${err instanceof Error ? err.message : String(err)}`;
					wtStatusEl.className = 'ade-eng-sheet-status err';
				} finally {
					this.worktreeActionBusy = false;
					if (this.activeSheetTab === 'worktrees') {
						this.renderSheet();
					}
				}
			}));
		} else {
			// Visual Execution Gantt Strip (when at least 1 node has started)
			const fin = computeTreeFinancialSummary(snap);
			const ganttItems = snap.nodes
				.filter(n => typeof n.runtime.startedAt === 'number' && n.runtime.startedAt > 0)
				.map(n => ({
					node: n.node,
					visualStatus: n.visualStatus,
					start: n.runtime.startedAt!,
					end: n.runtime.completedAt || Math.max(n.runtime.startedAt! + 1000, snap.state.updatedAt),
					cost: fin.costByNode[n.node.id] ?? 0,
				}));
			if (ganttItems.length > 0) {
				const minT = Math.min(...ganttItems.map(g => g.start));
				const maxT = Math.max(minT + 1000, ...ganttItems.map(g => g.end));
				const span = maxT - minT;
				const ganttWrap = append(this.sheetContentEl, $('.ade-eng-gantt'));
				const ganttHead = append(ganttWrap, $('.ade-eng-gantt-head'));
				append(ganttHead, $('span.ade-eng-gantt-title', {}, localize('adeEngGanttTitle', "Execution Gantt · {0} ({1})", formatElapsedCompact(minT, maxT), formatUsdCost(fin.totalCostUsd))));
				const ganttActions = append(ganttHead, $('.ade-eng-gantt-actions'));
				const ganttSvgBtn = append(ganttActions, $('button.ade-eng-ta-svg-btn', {
					type: 'button',
					title: localize('adeEngGanttExportSvgTip', "Export shareable vector SVG snapshot"),
				}, localize('adeEngGanttExportSvgLabel', "SVG")));
				this.sheetRenderDisposables.add(addDisposableListener(ganttSvgBtn, EventType.CLICK, () => this.exportDagSvg()));
				const ganttDlBtn = append(ganttActions, $('button.ade-eng-ta-svg-btn', {
					type: 'button',
					title: localize('adeEngGanttDownloadPrTip', "Download PR Verification Report (.md)"),
				}, localize('adeEngGanttDownloadPrLabel', "↓ .md")));
				this.sheetRenderDisposables.add(addDisposableListener(ganttDlBtn, EventType.CLICK, () => this.downloadRunReportMarkdown()));
				const ganttPrBtn = append(ganttActions, $('button.ade-eng-ta-pr-btn', {
					type: 'button',
					title: localize('adeEngGanttCopyPrTip', "Copy PR Verification Report Markdown"),
				}, localize('adeEngGanttCopyPrLabel', "Copy PR Report")));
				this.sheetRenderDisposables.add(addDisposableListener(ganttPrBtn, EventType.CLICK, () => this.copyRunReportToClipboard(ganttPrBtn)));
				for (const item of ganttItems.slice(0, 8)) {
					const row = append(ganttWrap, $('button.ade-eng-gantt-row', {
						type: 'button',
						'data-node-id': item.node.id,
						title: `[${item.node.id}] ${item.node.title} · ${formatElapsedCompact(item.start, item.end)} · ${formatUsdCost(item.cost)}`,
					}));
					append(row, $('span.ade-eng-node-id-chip', {}, item.node.id));
					const track = append(row, $('span.ade-eng-gantt-track'));
					const leftPct = Math.max(0, Math.min(96, ((item.start - minT) / span) * 100));
					const widthPct = Math.max(4, Math.min(100 - leftPct, ((item.end - item.start) / span) * 100));
					const bar = append(track, $(`span.ade-eng-gantt-bar.status-${item.visualStatus}`));
					bar.style.left = `${leftPct.toFixed(1)}%`;
					bar.style.width = `${widthPct.toFixed(1)}%`;
					append(row, $('span.ade-eng-gantt-meta', {}, item.cost > 0
						? `${formatElapsedCompact(item.start, item.end)} · ${formatUsdCost(item.cost)}`
						: formatElapsedCompact(item.start, item.end)));
					this.sheetRenderDisposables.add(addDisposableListener(row, EventType.CLICK, () => this.focusNodeOnCanvas(item.node.id, false)));
				}
			}

			const orgCtx = this.getOrgRoleContext();
			const filterBar = append(this.sheetContentEl, $('.ade-eng-event-filters'));
			const filters: { readonly id: EventFilterKind; readonly label: string }[] = [
				{ id: 'all', label: localize('adeEngLogFilterAll', "All") },
				{ id: 'worker', label: localize('adeEngLogFilterWrk', "{0} · L{1}", orgCtx.executor.name, orgCtx.executor.tier) },
				{ id: 'employee', label: localize('adeEngLogFilterEmp', "{0} · L{1}", orgCtx.reviewer.name, orgCtx.reviewer.tier) },
				{ id: 'manager', label: localize('adeEngLogFilterMgr', "{0} · L{1}", orgCtx.segmentOwner.name, orgCtx.segmentOwner.tier) },
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

			const searchInput = append(filterBar, $('input.ade-eng-event-search', {
				type: 'search',
				placeholder: localize('adeEngEventSearchPh', "Filter logs…"),
				value: this.eventSearchQuery,
				'aria-label': localize('adeEngEventSearchAria', "Filter execution logs"),
			})) as HTMLInputElement;

			const laneLegend = append(this.sheetContentEl, $('.ade-eng-event-lane-legend', { 'aria-hidden': 'true' }));
			append(laneLegend, $('span.lane-key.wrk', {}, 'W'));
			append(laneLegend, $('span.lane-key.emp', {}, 'E'));
			append(laneLegend, $('span.lane-key.mgr', {}, 'M'));
			append(laneLegend, $('span.lane-label', {}, localize('adeEngEventLaneRailLabel', "3-Lane Role Rail · Chronological")));

			const body = append(this.sheetContentEl, $('.ade-eng-sheet-body.events.timeline'));
			this.sheetEventsBodyEl = body;
			this.renderEventTimelineRows(body, snap);

			this.sheetRenderDisposables.add(addDisposableListener(searchInput, EventType.INPUT, () => {
				this.eventSearchQuery = searchInput.value;
				this.renderEventTimelineRows(body, snap);
			}));

			const newPill = append(this.sheetContentEl, $('button.ade-eng-event-new-pill', {
				type: 'button',
			}));
			newPill.hidden = true;
			this.sheetEventsNewPillEl = newPill;
			this.syncEventsNewPill();

			this.sheetRenderDisposables.add(addDisposableListener(body, EventType.SCROLL, () => {
				const dist = body.scrollHeight - body.scrollTop - body.clientHeight;
				if (dist <= 24 && body.dataset.pinnedScroll !== '1') {
					this.eventsSeenCount = this.snapshot?.state.events.length ?? 0;
					this.syncEventsNewPill();
				}
			}));
			this.sheetRenderDisposables.add(addDisposableListener(newPill, EventType.CLICK, () => {
				delete body.dataset.pinnedScroll;
				body.scrollTop = body.scrollHeight;
				this.eventsSeenCount = this.snapshot?.state.events.length ?? 0;
				this.syncEventsNewPill();
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
		if (this.pendingInitialFit && dimension.width > 0 && this.draftBlueprint && this.draftBlueprint.nodes.length > 0) {
			this.pendingInitialFit = false;
			this.fitViewportToGraph(false);
		} else {
			this.updateMinimapLens();
			this.positionPopoverNearAnchor();
		}
	}
}
