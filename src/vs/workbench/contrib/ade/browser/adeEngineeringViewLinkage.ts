/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getWindow, getWindows, onDidRegisterWindow } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	formatLevelLabel,
	IAdeAgentNode,
	IAdeDepartment,
	IAdeProjectSnapshot,
	IAdeWhiteboard,
} from '../../../../platform/ade/common/adeModels.js';
import { resolveAdeNodeColorHex } from '../../../../platform/ade/common/adeNodeColors.js';
import {
	buildOrthogonalRoundedEdgePath,
	computeNodeDragSnapAlignment,
	computeOrchestrationAnchorPoint,
	getOrchestrationNodeSize,
	IMissionAlignRect,
	IMissionNodePosition,
	IOrchestrationDepartmentGroup,
	IOrchestrationGraphNode,
	ORCH_STAFF_CARD_HEIGHT,
	ORCH_STAFF_CARD_WIDTH,
	OrchestrationAnchorSide,
} from '../../../../platform/ade/common/adeOrchestrationLayout.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { adeBi } from '../common/adeLocalization.js';
import type { IOrchDeptBounds } from './adeMissionCanvasEdgeRouter.js';
import type { IMissionMinimapSyncOptions } from './adeMissionMinimap.js';
import type { ICanvasContextMenuItem } from './adeMissionPopovers.js';

export interface IEngineeringHistoryEntry {
	readonly positions: Readonly<Record<string, IMissionNodePosition>>;
	readonly label: string;
}

export interface IAdePendingMissionNodeFocus {
	readonly nodeId: string;
	readonly highlightNodeIds?: readonly string[];
	readonly openPopover?: 'whiteboard' | 'agent';
	readonly openAgentBeside?: boolean;
}

export interface IEngineeringViewportState {
	readonly panX: number;
	readonly panY: number;
	readonly zoom: number;
}

export interface IEngineeringWorldBounds {
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
}

const MAX_VIEWPORT_MEMORY_ENTRIES = 64;
const MAX_HISTORY_KEYS = 32;
const MAX_UNDO_HISTORY = 50;

const visibilityRestoreEmitter = new Emitter<void>();
export const onDidRestoreAdePageVisibility: Event<void> = visibilityRestoreEmitter.event;

/**
 * Pauses background CSS animations while window/document is hidden and triggers deterministic
 * `AdeTicketFlowController.reconcileNow()` reconciliation immediately on restore (`plan.md` §8.3.2).
 */
export class AdePageVisibilityAnimationGuard extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.adePageVisibilityAnimationGuard';

	constructor() {
		super();
		const bindWindow = (win: Window) => {
			const sync = () => {
				const hidden = win.document.visibilityState === 'hidden';
				win.document.documentElement.classList.toggle('ade-page-hidden', hidden);
				if (!hidden) {
					visibilityRestoreEmitter.fire();
				}
			};
			sync();
			this._register(addDisposableListener(win.document, 'visibilitychange', sync));
		};
		for (const entry of getWindows()) {
			bindWindow(entry.window);
		}
		this._register(onDidRegisterWindow(({ window }) => bindWindow(window)));
	}
}

/**
 * Bounded per-`projectId` camera memory so switching between Project tabs or split views
 * preserves each Project's exact pan & zoom framing.
 */
export class EngineeringViewportMemory {
	private readonly states = new Map<string, IEngineeringViewportState>();

	save(projectId: string, state: IEngineeringViewportState): void {
		if (!projectId || !Number.isFinite(state.panX) || !Number.isFinite(state.panY) || !Number.isFinite(state.zoom)) {
			return;
		}
		this.states.delete(projectId);
		this.states.set(projectId, { panX: state.panX, panY: state.panY, zoom: state.zoom });
		if (this.states.size > MAX_VIEWPORT_MEMORY_ENTRIES) {
			const oldest = this.states.keys().next().value;
			if (oldest !== undefined) {
				this.states.delete(oldest);
			}
		}
	}

	get(projectId: string): IEngineeringViewportState | undefined {
		const found = this.states.get(projectId);
		if (!found) {
			return undefined;
		}
		this.states.delete(projectId);
		this.states.set(projectId, found);
		return found;
	}

	clear(projectId?: string): void {
		if (!projectId) {
			this.states.clear();
			return;
		}
		this.states.delete(projectId);
	}
}

interface IScopedHistoryBucket {
	undo: IEngineeringHistoryEntry[];
	redo: IEngineeringHistoryEntry[];
	lastCoalescedAt: number;
}

/**
 * Per-`projectId` node position Undo/Redo history store (zero pre-prompt state, zero Mermaid code).
 */
export class EngineeringHistoryStore {
	private readonly buckets = new Map<string, IScopedHistoryBucket>();

	private getOrCreate(projectId: string): IScopedHistoryBucket {
		let bucket = this.buckets.get(projectId);
		if (bucket) {
			this.buckets.delete(projectId);
			this.buckets.set(projectId, bucket);
			return bucket;
		}
		bucket = { undo: [], redo: [], lastCoalescedAt: 0 };
		this.buckets.set(projectId, bucket);
		if (this.buckets.size > MAX_HISTORY_KEYS) {
			const oldest = this.buckets.keys().next().value;
			if (oldest !== undefined) {
				this.buckets.delete(oldest);
			}
		}
		return bucket;
	}

	push(projectId: string, entry: IEngineeringHistoryEntry, coalesceMs = 0): void {
		const bucket = this.getOrCreate(projectId);
		const now = Date.now();
		if (coalesceMs > 0 && bucket.undo.length > 0 && (now - bucket.lastCoalescedAt) < coalesceMs) {
			bucket.lastCoalescedAt = now;
			bucket.redo = [];
			return;
		}
		bucket.lastCoalescedAt = coalesceMs > 0 ? now : 0;
		bucket.undo.push(entry);
		if (bucket.undo.length > MAX_UNDO_HISTORY) {
			bucket.undo.shift();
		}
		bucket.redo = [];
	}

	popUndo(projectId: string, captureCurrent: (label: string) => IEngineeringHistoryEntry): IEngineeringHistoryEntry | undefined {
		const bucket = this.buckets.get(projectId);
		if (!bucket || bucket.undo.length === 0) {
			return undefined;
		}
		const prev = bucket.undo.pop()!;
		bucket.redo.push(captureCurrent(prev.label));
		return prev;
	}

	popRedo(projectId: string, captureCurrent: (label: string) => IEngineeringHistoryEntry): IEngineeringHistoryEntry | undefined {
		const bucket = this.buckets.get(projectId);
		if (!bucket || bucket.redo.length === 0) {
			return undefined;
		}
		const next = bucket.redo.pop()!;
		bucket.undo.push(captureCurrent(next.label));
		return next;
	}

	clear(projectId?: string): void {
		if (!projectId) {
			this.buckets.clear();
			return;
		}
		this.buckets.delete(projectId);
	}
}

export function computeGraphWorldBounds(
	nodes: readonly IOrchestrationGraphNode[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	deptBounds?: readonly IOrchDeptBounds[],
): IEngineeringWorldBounds | undefined {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;

	for (const node of nodes) {
		const pos = positions.get(node.id);
		if (!pos) {
			continue;
		}
		const size = getOrchestrationNodeSize(node);
		minX = Math.min(minX, pos.x - size.width / 2);
		maxX = Math.max(maxX, pos.x + size.width / 2);
		minY = Math.min(minY, pos.y - size.height / 2);
		maxY = Math.max(maxY, pos.y + size.height / 2);
	}

	for (const d of deptBounds ?? []) {
		minX = Math.min(minX, d.minX);
		maxX = Math.max(maxX, d.maxX);
		minY = Math.min(minY, d.minY);
		maxY = Math.max(maxY, d.maxY);
	}

	if (!Number.isFinite(minX)) {
		return undefined;
	}
	return { minX, maxX, minY, maxY };
}

export function computeDefaultNewNodeWorldPos(
	viewportW: number,
	viewportH: number,
	panX: number,
	panY: number,
	zoom: number,
): IMissionNodePosition {
	const safeZoom = Math.max(0.25, zoom || 1);
	const cx = ((viewportW || 960) * 0.5 - panX) / safeZoom;
	const cy = ((viewportH || 640) * 0.5 - panY) / safeZoom;
	return {
		x: Math.max(Math.round(ORCH_STAFF_CARD_WIDTH / 2 + 24), Math.round(cx)),
		y: Math.max(Math.round(ORCH_STAFF_CARD_HEIGHT / 2 + 24), Math.round(cy)),
	};
}

export function findCanvasSearchMatches(
	nodes: readonly IOrchestrationGraphNode[],
	rawQuery: string,
): readonly string[] {
	const q = rawQuery.trim().toLowerCase();
	if (!q) {
		return [];
	}
	const matches: string[] = [];
	for (const n of nodes) {
		const hay = [
			n.id,
			n.label,
			n.roleSummary ?? '',
			n.engineId ?? '',
			n.model ?? '',
			n.host ?? '',
			n.department ?? '',
			...(n.tagCategories ?? []),
		].join(' ').toLowerCase();
		if (hay.includes(q)) {
			matches.push(n.id);
		}
	}
	return matches;
}

export function buildMinimapSyncPayload(
	nodes: readonly IOrchestrationGraphNode[],
	snapshot: IAdeProjectSnapshot | undefined,
	liveChatStates: ReadonlyMap<string, 'idle' | 'working' | 'pending'> | undefined,
	deptBounds: readonly IOrchDeptBounds[] | undefined,
): IMissionMinimapSyncOptions {
	const nodeStates: Record<string, string> = {};
	const nodeSizeOverride = new Map<string, { readonly width: number; readonly height: number }>();
	const nodeColors: Record<string, string | undefined> = {};
	const whiteboardNodeIds = new Set<string>();

	const activeTicketsByHolder = new Set<string>();
	for (const tk of snapshot?.tickets ?? []) {
		if (tk.status === 'active' && tk.holder_id) {
			activeTicketsByHolder.add(tk.holder_id);
		}
	}

	for (const n of nodes) {
		nodeSizeOverride.set(n.id, getOrchestrationNodeSize(n));
		if (n.color) {
			nodeColors[n.id] = n.color;
		}
		if (n.kind === 'whiteboard') {
			whiteboardNodeIds.add(n.id);
			nodeStates[n.id] = 'idle';
		} else {
			const chatSt = liveChatStates?.get(n.id);
			if (chatSt === 'working' || activeTicketsByHolder.has(n.id)) {
				nodeStates[n.id] = 'active';
			} else if (chatSt === 'pending') {
				nodeStates[n.id] = 'waiting_gate';
			} else {
				nodeStates[n.id] = 'idle';
			}
		}
	}

	const departmentBounds = (deptBounds ?? []).map(d => ({
		id: d.id,
		minX: d.minX,
		minY: d.minY,
		maxX: d.maxX,
		maxY: d.maxY,
		colorHex: d.colorHex ?? resolveAdeNodeColorHex(undefined),
	}));

	return {
		nodeStates,
		nodeSizeOverride,
		nodeColors,
		whiteboardNodeIds,
		departmentBounds,
	};
}

// ============================================================================
// Context Menu Builders (Strictly ZERO Edge One-Way / Edit-Label / Delete-Edge!)
// ============================================================================

export function buildBlankCanvasContextMenuItems(options: {
	readonly snapshot: IAdeProjectSnapshot;
	readonly onCreateSoleTopRole: () => void;
	readonly onCreateSubordinate: () => void;
	readonly onCreateDepartment: () => void;
	readonly onCreateWhiteboard: () => void;
	readonly onFitView: () => void;
}): readonly ICanvasContextMenuItem[] {
	const hasL1 = options.snapshot.agents.length > 0;
	if (!hasL1) {
		return [
			{
				id: 'create-sole-l1',
				icon: 'organization',
				label: adeBi(localize('adeMenuCreateSoleL1', "Create Sole Top-Level L1 Lead..."), '创建唯一顶层 L1 负责人…'),
				run: options.onCreateSoleTopRole,
			},
			{
				id: 'create-dept-disabled',
				icon: 'symbol-namespace',
				label: adeBi(localize('adeMenuCreateDeptDisabled', "Create Department (Create L1 First)"), '创建部门（需先创建 L1 负责人）'),
				disabled: true,
				separatorBefore: true,
				run: () => { },
			},
			{
				id: 'create-wb-disabled',
				icon: 'note',
				label: adeBi(localize('adeMenuCreateWbDisabled', "Create Whiteboard (Create L1 First)"), '新建共享白板（需先创建 L1 负责人）'),
				disabled: true,
				run: () => { },
			},
		];
	}

	return [
		{
			id: 'create-subordinate',
			icon: 'person-add',
			label: adeBi(localize('adeMenuRecruitSubordinate', "Recruit Subordinate Agent..."), '招募下级员工节点…'),
			run: options.onCreateSubordinate,
		},
		{
			id: 'create-dept',
			icon: 'symbol-namespace',
			label: adeBi(localize('adeMenuCreateDept', "Create Department..."), '创建部门边界…'),
			run: options.onCreateDepartment,
		},
		{
			id: 'create-wb',
			icon: 'note',
			label: adeBi(localize('adeMenuCreateWb', "Create Shared Whiteboard..."), '新建共享白板…'),
			run: options.onCreateWhiteboard,
		},
		{
			id: 'fit-view',
			icon: 'screen-full',
			label: adeBi(localize('adeMenuFitView', "Fit Canvas to View"), '自适应居中全图'),
			separatorBefore: true,
			run: options.onFitView,
		},
	];
}

export function buildStaffNodeContextMenuItems(options: {
	readonly snapshot: IAdeProjectSnapshot;
	readonly agent: IAdeAgentNode;
	readonly onOpenSession: (side: boolean) => void;
	readonly onEditAgent: () => void;
	readonly onRecruitSubordinate: () => void;
	readonly onCreateDepartmentHere: () => void;
	readonly onRenameInline: () => void;
	readonly onPickColor: () => void;
	readonly onDeleteAgent: () => void;
}): readonly ICanvasContextMenuItem[] {
	const { snapshot, agent } = options;
	const hasSubs = snapshot.agents.some(a => a.parent_id === agent.agent_id);
	const isDeptRoot = snapshot.departments.some(d => d.root_agent_id === agent.agent_id);

	return [
		{
			id: 'open-chat',
			icon: 'comment-discussion',
			label: adeBi(localize('adeStaffMenuOpenChat', "Open Agent Conversation"), '打开对话会话'),
			run: () => options.onOpenSession(false),
		},
		{
			id: 'open-chat-side',
			icon: 'split-horizontal',
			label: adeBi(localize('adeStaffMenuOpenChatSide', "Open Conversation to the Side"), '右侧分屏打开会话'),
			run: () => options.onOpenSession(true),
		},
		{
			id: 'edit-agent',
			icon: 'settings-gear',
			label: adeBi(localize('adeStaffMenuEdit', "Configure Employee ({0})...", formatLevelLabel(agent.level)), `编辑员工配置 (${formatLevelLabel(agent.level)})…`),
			separatorBefore: true,
			run: options.onEditAgent,
		},
		{
			id: 'recruit-sub',
			icon: 'person-add',
			label: adeBi(localize('adeStaffMenuRecruitSub', "Recruit Direct Subordinate..."), '招募直属下级员工…'),
			run: options.onRecruitSubordinate,
		},
		{
			id: 'create-dept-here',
			icon: 'symbol-namespace',
			label: adeBi(localize('adeStaffMenuCreateDeptHere', "Create Department Rooted Here..."), '以此员工为根创建部门…'),
			disabled: isDeptRoot,
			run: options.onCreateDepartmentHere,
		},
		{
			id: 'rename-node',
			icon: 'edit',
			label: adeBi(localize('adeStaffMenuRename', "Rename Employee (F2)"), '重命名员工 (F2)'),
			separatorBefore: true,
			run: options.onRenameInline,
		},
		{
			id: 'color-node',
			icon: 'symbol-color',
			label: adeBi(localize('adeStaffMenuColor', "Card Accent Color..."), '自定义卡片主题色…'),
			run: options.onPickColor,
		},
		{
			id: 'delete-agent',
			icon: 'trash',
			danger: true,
			disabled: hasSubs || isDeptRoot,
			separatorBefore: true,
			label: hasSubs
				? adeBi(localize('adeStaffMenuDelHasSubs', "Delete Employee (Has Subordinates)"), '删除员工（请先移除下属）')
				: isDeptRoot
					? adeBi(localize('adeStaffMenuDelDeptRoot', "Delete Employee (Active Dept Root)"), '删除员工（请先解散所属部门根）')
					: adeBi(localize('adeStaffMenuDelete', "Delete Employee"), '删除员工节点'),
			run: options.onDeleteAgent,
		},
	];
}

export function buildWhiteboardNodeContextMenuItems(options: {
	readonly whiteboard: IAdeWhiteboard;
	readonly onInspectWhiteboard: () => void;
	readonly onRenameInline: () => void;
	readonly onPickColor: () => void;
	readonly onDeleteWhiteboard: () => void;
}): readonly ICanvasContextMenuItem[] {
	return [
		{
			id: 'inspect-wb',
			icon: 'book',
			label: adeBi(localize('adeWbMenuInspect', "Inspect Whiteboard, Files & Notes..."), '查看白板条目、备份文件与留言…'),
			run: options.onInspectWhiteboard,
		},
		{
			id: 'rename-wb',
			icon: 'edit',
			label: adeBi(localize('adeWbMenuRename', "Rename Whiteboard (F2)"), '重命名白板 (F2)'),
			separatorBefore: true,
			run: options.onRenameInline,
		},
		{
			id: 'color-wb',
			icon: 'symbol-color',
			label: adeBi(localize('adeWbMenuColor', "Card Accent Color..."), '自定义卡片主题色…'),
			run: options.onPickColor,
		},
		{
			id: 'delete-wb',
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			label: adeBi(localize('adeWbMenuDelete', "Delete Whiteboard"), '删除共享白板'),
			run: options.onDeleteWhiteboard,
		},
	];
}

export function buildDepartmentContextMenuItems(options: {
	readonly snapshot: IAdeProjectSnapshot;
	readonly department: IAdeDepartment;
	readonly onEditDepartment: () => void;
	readonly onCreateDeptWhiteboard: () => void;
	readonly onDissolveDepartment: () => void;
}): readonly ICanvasContextMenuItem[] {
	const alreadyHasBoard = options.snapshot.whiteboards.some(w => w.dept_id === options.department.dept_id);
	return [
		{
			id: 'edit-dept',
			icon: 'organization',
			label: adeBi(localize('adeDeptMenuEdit', "Edit Department & Subtree Members..."), '编辑部门与子树成员边界…'),
			run: options.onEditDepartment,
		},
		{
			id: 'create-dept-wb',
			icon: 'note',
			disabled: alreadyHasBoard,
			label: alreadyHasBoard
				? adeBi(localize('adeDeptMenuWbExists', "Department Whiteboard Already Bound"), '已绑定部门白板（一部门一板）')
				: adeBi(localize('adeDeptMenuCreateWb', "Create Department Whiteboard..."), '新建本部门共享白板…'),
			run: options.onCreateDeptWhiteboard,
		},
		{
			id: 'dissolve-dept',
			icon: 'trash',
			danger: true,
			separatorBefore: true,
			label: adeBi(localize('adeDeptMenuDissolve', "Dissolve Department (Keeps Whiteboard)"), '解散部门（无损保留白板）'),
			run: options.onDissolveDepartment,
		},
	];
}

// ============================================================================
// Viewport Pointer / Wheel / Marquee / Snap-Drag / Anchor-Connect Controller
// ============================================================================

export interface ICanvasInteractionsHost {
	readonly viewportEl: HTMLElement;
	readonly marqueeBoxEl: HTMLElement;
	getZoom(): number;
	getPan(): { readonly x: number; readonly y: number };
	setCamera(panX: number, panY: number, zoom: number): void;
	getNodes(): readonly IOrchestrationGraphNode[];
	getPositions(): ReadonlyMap<string, IMissionNodePosition>;
	getSelectedNodeIds(): ReadonlySet<string>;
	setSelectedNodesAndEdge(nodeIds: ReadonlySet<string>, edgePairKey: string | undefined): void;
	onBlankCanvasClick(): void;
	onBlankCanvasContextMenu(clientX: number, clientY: number): void;
	onDismissTransientContextMenuOnly(): void;
	onUpdateLivePositions(positions: ReadonlyMap<string, IMissionNodePosition>, primaryMovedId?: string): void;
	onRenderSnapGuides(guides: ReturnType<typeof computeNodeDragSnapAlignment>['guides']): void;
	onCommitPositionsChange(before: Readonly<Record<string, IMissionNodePosition>>, after: Readonly<Record<string, IMissionNodePosition>>, label: string): void;
	onSetConnectPreview(pathD: string | undefined, targetNodeId?: string): void;
	onReparentAgent(agentId: string, newParentId: string): void;
	onSpawnSubordinateAtWorldPos(parentId: string, worldX: number, worldY: number, clientX: number, clientY: number): void;
}

export interface IInstalledCanvasInteractions {
	startNodeDrag(nodeId: string, e: PointerEvent): void;
	moveNodeDrag(nodeId: string, e: PointerEvent): void;
	endNodeDrag(nodeId: string, e: PointerEvent): void;
	startDepartmentDrag(dept: IOrchestrationDepartmentGroup, memberNodeIds: readonly string[], e: PointerEvent, emptyCenter?: IMissionNodePosition): void;
	moveDepartmentDrag(e: PointerEvent): void;
	endDepartmentDrag(e: PointerEvent): void;
	startConnectDrag(fromNodeId: string, e: PointerEvent, anchor?: { readonly side: OrchestrationAnchorSide; readonly slot: number }): void;
	moveConnectDrag(e: PointerEvent): void;
	endConnectDrag(e: PointerEvent): void;
}

export function installEngineeringCanvasInteractions(
	host: ICanvasInteractionsHost,
	disposables: DisposableStore,
	limits: { readonly minZoom: number; readonly maxZoom: number },
): IInstalledCanvasInteractions {
	const clientToWorld = (clientX: number, clientY: number): IMissionNodePosition => {
		const rect = host.viewportEl.getBoundingClientRect();
		const { x: panX, y: panY } = host.getPan();
		const z = host.getZoom();
		return {
			x: (clientX - rect.left - panX) / z,
			y: (clientY - rect.top - panY) / z,
		};
	};

	// 1. Wheel Zoom / Trackpad Pan — NEVER closes AdeEdgeTicketHistoryPopover or AdeWhiteboardPopover! (`plan.md` §8.4.2)
	let lastTrackpadPanGestureAt = 0;
	disposables.add(addDisposableListener(host.viewportEl, EventType.WHEEL, (e: WheelEvent) => {
		e.preventDefault();
		host.onDismissTransientContextMenuOnly();
		const now = Date.now();
		const rect = host.viewportEl.getBoundingClientRect();
		const cursorX = e.clientX - rect.left;
		const cursorY = e.clientY - rect.top;
		const { x: panX, y: panY } = host.getPan();
		const oldZoom = host.getZoom();

		const modeScale = e.deltaMode === 1 ? 28 : (e.deltaMode === 2 ? 240 : 1);
		const dy = e.deltaY * modeScale;
		const dx = e.deltaX * modeScale;

		const isTrackpadPinch = e.ctrlKey && !e.metaKey && e.deltaMode === 0 && Math.abs(e.deltaY) < 65;
		const isTrackpadTwoFingerSwipe = !e.ctrlKey && !e.metaKey && e.deltaMode === 0 && (
			Math.abs(e.deltaX) > 0
			|| Math.abs(e.deltaY) < 28
			|| (now - lastTrackpadPanGestureAt < 160 && !Number.isInteger(e.deltaY))
		);
		if (isTrackpadTwoFingerSwipe) {
			lastTrackpadPanGestureAt = now;
		}
		const isWheelZoom = isTrackpadPinch
			|| e.ctrlKey
			|| e.metaKey
			|| (!isTrackpadTwoFingerSwipe && (e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 28)));

		if (isWheelZoom) {
			const clampedDy = isTrackpadPinch ? dy : Math.max(-180, Math.min(180, dy));
			const sensitivity = isTrackpadPinch ? 0.0105 : 0.0042;
			const factor = Math.exp(-clampedDy * sensitivity);
			const nextZoom = Math.max(limits.minZoom, Math.min(limits.maxZoom, oldZoom * factor));
			const worldX = (cursorX - panX) / oldZoom;
			const worldY = (cursorY - panY) / oldZoom;
			const nextPanX = cursorX - worldX * nextZoom;
			const nextPanY = cursorY - worldY * nextZoom;
			host.setCamera(nextPanX, nextPanY, nextZoom);
		} else {
			host.setCamera(panX - dx, panY - dy, oldZoom);
		}
	}, { passive: false }));

	// 2. Blank Viewport Pan & Shift-Drag Marquee Selection
	let panState: {
		pointerId: number;
		startClientX: number;
		startClientY: number;
		startPanX: number;
		startPanY: number;
		moved: boolean;
		marquee: boolean;
	} | undefined;

	disposables.add(addDisposableListener(host.viewportEl, EventType.POINTER_DOWN, (e: PointerEvent) => {
		if (e.button !== 0 && e.button !== 1) {
			return;
		}
		const target = e.target as Element | null;
		if (target && target.closest('.ade-mission-node, .ade-mission-edge-hit, .ade-orch-dept-pill-group')) {
			return;
		}
		const { x: panX, y: panY } = host.getPan();
		panState = {
			pointerId: e.pointerId,
			startClientX: e.clientX,
			startClientY: e.clientY,
			startPanX: panX,
			startPanY: panY,
			moved: false,
			marquee: Boolean(e.shiftKey && e.button === 0),
		};
		host.viewportEl.classList.add('panning');
		try {
			host.viewportEl.setPointerCapture(e.pointerId);
		} catch { /* synthetic event */ }
	}));

	disposables.add(addDisposableListener(host.viewportEl, EventType.POINTER_MOVE, (e: PointerEvent) => {
		if (!panState || e.pointerId !== panState.pointerId) {
			return;
		}
		const dx = e.clientX - panState.startClientX;
		const dy = e.clientY - panState.startClientY;
		if (Math.hypot(dx, dy) > 4) {
			panState.moved = true;
		}
		if (panState.marquee) {
			const rect = host.viewportEl.getBoundingClientRect();
			const x1 = Math.min(panState.startClientX, e.clientX) - rect.left;
			const y1 = Math.min(panState.startClientY, e.clientY) - rect.top;
			const w = Math.abs(e.clientX - panState.startClientX);
			const h = Math.abs(e.clientY - panState.startClientY);
			host.marqueeBoxEl.hidden = false;
			host.marqueeBoxEl.style.left = `${x1}px`;
			host.marqueeBoxEl.style.top = `${y1}px`;
			host.marqueeBoxEl.style.width = `${w}px`;
			host.marqueeBoxEl.style.height = `${h}px`;

			const pA = clientToWorld(Math.min(panState.startClientX, e.clientX), Math.min(panState.startClientY, e.clientY));
			const pB = clientToWorld(Math.max(panState.startClientX, e.clientX), Math.max(panState.startClientY, e.clientY));
			const selected = new Set<string>();
			const positions = host.getPositions();
			for (const n of host.getNodes()) {
				const pos = positions.get(n.id);
				if (!pos) {
					continue;
				}
				const sz = getOrchestrationNodeSize(n);
				if (pos.x + sz.width / 2 >= pA.x && pos.x - sz.width / 2 <= pB.x && pos.y + sz.height / 2 >= pA.y && pos.y - sz.height / 2 <= pB.y) {
					selected.add(n.id);
				}
			}
			host.setSelectedNodesAndEdge(selected, undefined);
		} else if (panState.moved) {
			host.setCamera(panState.startPanX + dx, panState.startPanY + dy, host.getZoom());
		}
	}));

	const finishViewportPointer = (e: PointerEvent) => {
		if (!panState || e.pointerId !== panState.pointerId) {
			return;
		}
		const wasMoved = panState.moved;
		const wasMarquee = panState.marquee;
		panState = undefined;
		host.viewportEl.classList.remove('panning');
		host.marqueeBoxEl.hidden = true;
		try {
			if (host.viewportEl.hasPointerCapture?.(e.pointerId)) {
				host.viewportEl.releasePointerCapture(e.pointerId);
			}
		} catch { /* ignore */ }
		if (!wasMoved && !wasMarquee && e.button === 0) {
			host.onBlankCanvasClick();
		}
	};
	disposables.add(addDisposableListener(host.viewportEl, EventType.POINTER_UP, finishViewportPointer));
	disposables.add(addDisposableListener(host.viewportEl, 'pointercancel', finishViewportPointer));

	disposables.add(addDisposableListener(host.viewportEl, EventType.CONTEXT_MENU, (e: MouseEvent) => {
		const target = e.target as Element | null;
		if (target && target.closest('.ade-mission-node, .ade-mission-edge-hit, .ade-orch-dept-pill-group')) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		host.onBlankCanvasContextMenu(e.clientX, e.clientY);
	}));

	// 3. Node Dragging (Single or Multi-Selected Group + Snap Guides)
	let nodeDrag: {
		primaryId: string;
		startClientX: number;
		startClientY: number;
		moved: boolean;
		dragIds: readonly string[];
		beforeAll: Record<string, IMissionNodePosition>;
	} | undefined;

	const captureAllPositions = (): Record<string, IMissionNodePosition> => {
		const out: Record<string, IMissionNodePosition> = {};
		for (const [id, pos] of host.getPositions().entries()) {
			out[id] = { x: pos.x, y: pos.y };
		}
		return out;
	};

	const applyClampedGroupTranslation = (
		ids: readonly string[],
		beforeAll: Readonly<Record<string, IMissionNodePosition>>,
		nodesById: ReadonlyMap<string, IOrchestrationGraphNode>,
		dx: number,
		dy: number,
		target: Map<string, IMissionNodePosition>,
	): void => {
		const validIds = ids.filter(id => Boolean(beforeAll[id]));
		if (validIds.length === 0) {
			return;
		}
		const sz = (id: string): { readonly width: number; readonly height: number } => {
			const node = nodesById.get(id);
			return node ? getOrchestrationNodeSize(node) : { width: ORCH_STAFF_CARD_WIDTH, height: ORCH_STAFF_CARD_HEIGHT };
		};
		const minDx = Math.max(...validIds.map(id => 24 + sz(id).width / 2 - beforeAll[id].x));
		const minDy = Math.max(...validIds.map(id => 24 + sz(id).height / 2 - beforeAll[id].y));
		const clampedDx = Math.max(minDx, dx);
		const clampedDy = Math.max(minDy, dy);
		for (const id of validIds) {
			const orig = beforeAll[id];
			target.set(id, {
				x: Math.round(orig.x + clampedDx),
				y: Math.round(orig.y + clampedDy),
			});
		}
	};

	const startNodeDrag = (nodeId: string, e: PointerEvent) => {
		const selected = host.getSelectedNodeIds();
		const dragIds = selected.has(nodeId) && selected.size > 1 ? [...selected] : [nodeId];
		nodeDrag = {
			primaryId: nodeId,
			startClientX: e.clientX,
			startClientY: e.clientY,
			moved: false,
			dragIds,
			beforeAll: captureAllPositions(),
		};
	};

	const moveNodeDrag = (_nodeId: string, e: PointerEvent) => {
		if (!nodeDrag) {
			return;
		}
		const z = host.getZoom();
		const dx = (e.clientX - nodeDrag.startClientX) / z;
		const dy = (e.clientY - nodeDrag.startClientY) / z;
		if (!nodeDrag.moved && Math.hypot(dx * z, dy * z) < 3) {
			return;
		}
		nodeDrag.moved = true;

		const nodes = host.getNodes();
		const nodesById = new Map(nodes.map(n => [n.id, n]));
		const updated = new Map<string, IMissionNodePosition>();

		if (nodeDrag.dragIds.length === 1 && !e.altKey) {
			const primary = nodesById.get(nodeDrag.primaryId);
			const orig = nodeDrag.beforeAll[nodeDrag.primaryId];
			if (primary && orig) {
				const sz = getOrchestrationNodeSize(primary);
				const otherRects: IMissionAlignRect[] = [];
				for (const n of nodes) {
					if (n.id === primary.id) {
						continue;
					}
					const p = host.getPositions().get(n.id);
					if (!p) {
						continue;
					}
					const nSz = getOrchestrationNodeSize(n);
					otherRects.push({
						id: n.id,
						minX: p.x - nSz.width / 2,
						maxX: p.x + nSz.width / 2,
						minY: p.y - nSz.height / 2,
						maxY: p.y + nSz.height / 2,
					});
				}
				const candX = Math.max(24 + sz.width / 2, orig.x + dx);
				const candY = Math.max(24 + sz.height / 2, orig.y + dy);
				const snapped = computeNodeDragSnapAlignment(
					{
						minX: candX - sz.width / 2,
						maxX: candX + sz.width / 2,
						minY: candY - sz.height / 2,
						maxY: candY + sz.height / 2,
					},
					otherRects,
					7,
				);
				updated.set(primary.id, {
					x: Math.round(Math.max(24 + sz.width / 2, candX + snapped.dx)),
					y: Math.round(Math.max(24 + sz.height / 2, candY + snapped.dy)),
				});
				host.onRenderSnapGuides(snapped.guides);
			}
		} else {
			host.onRenderSnapGuides([]);
			applyClampedGroupTranslation(nodeDrag.dragIds, nodeDrag.beforeAll, nodesById, dx, dy, updated);
		}

		if (updated.size > 0) {
			host.onUpdateLivePositions(updated, nodeDrag.primaryId);
		}
	};

	const endNodeDrag = (_nodeId: string, _e: PointerEvent) => {
		if (!nodeDrag) {
			return;
		}
		const finished = nodeDrag;
		nodeDrag = undefined;
		host.onRenderSnapGuides([]);
		if (!finished.moved) {
			return;
		}
		const afterAll = captureAllPositions();
		host.onCommitPositionsChange(finished.beforeAll, afterAll, 'Move Card');
	};

	// 4. Department Pill Group Drag
	let deptDrag: {
		memberIds: readonly string[];
		startClientX: number;
		startClientY: number;
		moved: boolean;
		beforeAll: Record<string, IMissionNodePosition>;
	} | undefined;

	const startDepartmentDrag = (
		_dept: IOrchestrationDepartmentGroup,
		memberNodeIds: readonly string[],
		e: PointerEvent,
	) => {
		if (memberNodeIds.length === 0) {
			return;
		}
		deptDrag = {
			memberIds: memberNodeIds,
			startClientX: e.clientX,
			startClientY: e.clientY,
			moved: false,
			beforeAll: captureAllPositions(),
		};
	};

	const moveDepartmentDrag = (e: PointerEvent) => {
		if (!deptDrag) {
			return;
		}
		const z = host.getZoom();
		const dx = (e.clientX - deptDrag.startClientX) / z;
		const dy = (e.clientY - deptDrag.startClientY) / z;
		if (!deptDrag.moved && Math.hypot(dx * z, dy * z) < 3) {
			return;
		}
		deptDrag.moved = true;
		const nodesById = new Map(host.getNodes().map(n => [n.id, n]));
		const updated = new Map<string, IMissionNodePosition>();
		applyClampedGroupTranslation(deptDrag.memberIds, deptDrag.beforeAll, nodesById, dx, dy, updated);
		if (updated.size > 0) {
			host.onUpdateLivePositions(updated);
		}
	};

	const endDepartmentDrag = (_e: PointerEvent) => {
		if (!deptDrag) {
			return;
		}
		const finished = deptDrag;
		deptDrag = undefined;
		if (!finished.moved) {
			return;
		}
		host.onCommitPositionsChange(finished.beforeAll, captureAllPositions(), 'Move Department');
	};

	// 5. Anchor-to-Card Reparenting & Anchor-to-Empty Subordinate Quick-Spawn
	let connectDrag: {
		fromNodeId: string;
		side: OrchestrationAnchorSide;
		slot: number;
		startWorld: IMissionNodePosition;
	} | undefined;

	const resolveHoveredCardAtClient = (clientX: number, clientY: number, excludeId: string): IOrchestrationGraphNode | undefined => {
		const win = getWindow(host.viewportEl);
		const hit = win.document.elementFromPoint(clientX, clientY);
		const nodeEl = hit?.closest?.('[data-node-id]') as HTMLElement | null;
		const id = nodeEl?.getAttribute('data-node-id');
		if (!id || id === excludeId) {
			return undefined;
		}
		return host.getNodes().find(n => n.id === id && n.kind === 'staff');
	};

	const startConnectDrag = (
		fromNodeId: string,
		e: PointerEvent,
		anchor?: { readonly side: OrchestrationAnchorSide; readonly slot: number },
	) => {
		const fromNode = host.getNodes().find(n => n.id === fromNodeId);
		const fromPos = host.getPositions().get(fromNodeId);
		if (!fromNode || !fromPos || fromNode.kind !== 'staff') {
			return;
		}
		const side = anchor?.side ?? 'bottom';
		const slot = anchor?.slot ?? 2;
		const pt = computeOrchestrationAnchorPoint(fromPos, getOrchestrationNodeSize(fromNode), side, slot, 5, 6);
		connectDrag = {
			fromNodeId,
			side,
			slot,
			startWorld: { x: pt.x, y: pt.y },
		};
		const curWorld = clientToWorld(e.clientX, e.clientY);
		const pathD = buildOrthogonalRoundedEdgePath(connectDrag.startWorld.x, connectDrag.startWorld.y, curWorld.x, curWorld.y);
		host.onSetConnectPreview(pathD, undefined);
	};

	const moveConnectDrag = (e: PointerEvent) => {
		if (!connectDrag) {
			return;
		}
		const curWorld = clientToWorld(e.clientX, e.clientY);
		const target = resolveHoveredCardAtClient(e.clientX, e.clientY, connectDrag.fromNodeId);
		const pathD = buildOrthogonalRoundedEdgePath(connectDrag.startWorld.x, connectDrag.startWorld.y, curWorld.x, curWorld.y);
		host.onSetConnectPreview(pathD, target?.id);
	};

	const endConnectDrag = (e: PointerEvent) => {
		if (!connectDrag) {
			return;
		}
		const finished = connectDrag;
		connectDrag = undefined;
		host.onSetConnectPreview(undefined, undefined);

		const curWorld = clientToWorld(e.clientX, e.clientY);
		if (Math.hypot(curWorld.x - finished.startWorld.x, curWorld.y - finished.startWorld.y) < 36) {
			return;
		}

		const fromNode = host.getNodes().find(n => n.id === finished.fromNodeId && n.kind === 'staff');
		if (!fromNode) {
			return;
		}

		const targetNode = resolveHoveredCardAtClient(e.clientX, e.clientY, finished.fromNodeId);
		if (targetNode) {
			const fromLv = fromNode.tier ?? 1;
			const targetLv = targetNode.tier ?? 1;
			if (fromLv < targetLv && !targetNode.isTopRole) {
				host.onReparentAgent(targetNode.id, fromNode.id);
			} else if (targetLv < fromLv && !fromNode.isTopRole) {
				host.onReparentAgent(fromNode.id, targetNode.id);
			}
			return;
		}

		host.onSpawnSubordinateAtWorldPos(
			fromNode.id,
			Math.max(Math.round(ORCH_STAFF_CARD_WIDTH / 2 + 24), Math.round(curWorld.x)),
			Math.max(Math.round(ORCH_STAFF_CARD_HEIGHT / 2 + 24), Math.round(curWorld.y)),
			e.clientX,
			e.clientY,
		);
	};

	return {
		startNodeDrag,
		moveNodeDrag,
		endNodeDrag,
		startDepartmentDrag,
		moveDepartmentDrag,
		endDepartmentDrag,
		startConnectDrag,
		moveConnectDrag,
		endConnectDrag,
	};
}
