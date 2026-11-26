/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure Single-Parent Reporting Tree Layout, Nested Department Bounding Regions,
 * Magnetic Drag Snap Alignment, and Symmetric Bidirectional Multi-Anchor Orthogonal Edge Router
 * with Strict 22px Outward-Normal Rigid Stubs.
 *
 * Zero Node.js imports (`valid-layers-check` safe) and zero legacy Mission/Baton dependencies.
 */

import {
	getEffectiveDeptIds,
	IAdePolicyAgent,
	IAdePolicyBoardGrant,
	IAdePolicyDepartment,
	IAdePolicyProjectState,
	IAdePolicyWhiteboard,
} from './adeJurisdictionPolicy.js';
import {
	AdeLayoutDirection,
	canonicalEdgePairKey,
	formatLevelLabel,
	IAdeAgentNode,
	IAdeDepartment,
	IAdeProjectSnapshot,
} from './adeModels.js';
import { normalizeAdeNodeColor } from './adeNodeColors.js';

// ============================================================================
// Pure Canvas Geometry & Snap Alignment Primitives
// ============================================================================

export interface IMissionNodePosition {
	readonly x: number;
	readonly y: number;
}

export interface IMissionEdgeObstacle {
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
}

export interface IMissionOrthogonalEdgeOptions {
	readonly cornerRadius?: number;
	readonly minStub?: number;
	readonly wrapClearanceY?: number;
	readonly orientation?: 'horizontal' | 'vertical';
	readonly obstacles?: readonly IMissionEdgeObstacle[];
	readonly rigidStubLength?: number;
}

export interface IMissionOrthogonalEdgeRoute {
	readonly path: string;
	readonly midX: number;
	readonly midY: number;
	readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface IMissionAlignRect {
	readonly id: string;
	readonly minX: number;
	readonly maxX: number;
	readonly minY: number;
	readonly maxY: number;
}

export interface IMissionAlignGuide {
	readonly axis: 'x' | 'y';
	/** World coordinate along the snapped axis (X for vertical line, Y for horizontal line). */
	readonly coord: number;
	/** Start coordinate along the perpendicular axis. */
	readonly start: number;
	/** End coordinate along the perpendicular axis. */
	readonly end: number;
}

export interface IMissionSnapAlignmentResult {
	readonly dx: number;
	readonly dy: number;
	readonly guides: readonly IMissionAlignGuide[];
}

function roundSvgCoord(v: number): number {
	return Math.round(v * 100) / 100;
}

function verticalSegmentHitsObstacles(
	x: number,
	yA: number,
	yB: number,
	obstacles: readonly IMissionEdgeObstacle[],
): boolean {
	const top = Math.min(yA, yB);
	const bottom = Math.max(yA, yB);
	for (const obs of obstacles) {
		if (x >= obs.minX && x <= obs.maxX && bottom >= obs.minY && top <= obs.maxY) {
			return true;
		}
	}
	return false;
}

/**
 * Converts an orthogonal polyline into a smooth SVG `<path>` with `Q` quadratic Bezier corners.
 * When `rigidStubLength > 0` (e.g. `22px` for staff bidirectional edges), corner rounding at the
 * first bend (`i === 1`) and last bend (`i === pts.length - 2`) is strictly clamped so it NEVER
 * intrudes into the initial `[p0, p0 + u0 * rigidStubLength]` or final `[pn - un * rigidStubLength, pn]`
 * straight segments.
 */
export function roundedOrthogonalPolylineToSvgPath(
	rawPoints: readonly { readonly x: number; readonly y: number }[],
	cornerRadius: number,
	rigidStubLength = 0,
	obstacleBoxes?: readonly IMissionEdgeObstacle[],
): string {
	const pts: { x: number; y: number }[] = [];
	for (const p of rawPoints) {
		const prev = pts[pts.length - 1];
		if (prev && Math.abs(prev.x - p.x) < 0.05 && Math.abs(prev.y - p.y) < 0.05) {
			continue;
		}
		if (pts.length >= 2) {
			const a = pts[pts.length - 2];
			const b = pts[pts.length - 1];
			const sameX = Math.abs(a.x - b.x) < 0.05 && Math.abs(b.x - p.x) < 0.05;
			const sameY = Math.abs(a.y - b.y) < 0.05 && Math.abs(b.y - p.y) < 0.05;
			const dotDir = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
			if ((sameX || sameY) && dotDir >= 0) {
				pts[pts.length - 1] = { x: p.x, y: p.y };
				continue;
			}
		}
		pts.push({ x: p.x, y: p.y });
	}
	if (pts.length === 0) {
		return '';
	}
	let penX = roundSvgCoord(pts[0].x);
	let penY = roundSvgCoord(pts[0].y);
	if (pts.length === 1) {
		return `M ${penX} ${penY}`;
	}
	const parts: string[] = [`M ${penX} ${penY}`];
	const emitLineTo = (tx: number, ty: number): void => {
		const rx = roundSvgCoord(tx);
		const ry = roundSvgCoord(ty);
		if (Math.hypot(rx - penX, ry - penY) >= 0.05) {
			parts.push(`L ${rx} ${ry}`);
			penX = rx;
			penY = ry;
		}
	};
	if (pts.length === 2) {
		emitLineTo(pts[1].x, pts[1].y);
		return parts.join(' ');
	}

	const safeStub = Math.max(0, rigidStubLength);
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = pts[i - 1];
		const curr = pts[i];
		const next = pts[i + 1];
		const vx1 = curr.x - prev.x;
		const vy1 = curr.y - prev.y;
		const vx2 = next.x - curr.x;
		const vy2 = next.y - curr.y;
		const len1 = Math.hypot(vx1, vy1);
		const len2 = Math.hypot(vx2, vy2);
		if (len1 < 0.05 || len2 < 0.05) {
			continue;
		}
		const avail1 = i === 1
			? Math.max(0, len1 - safeStub)
			: len1 / 2;
		const avail2 = i === pts.length - 2
			? Math.max(0, len2 - safeStub)
			: len2 / 2;
		const rMax = Math.min(Math.max(0, cornerRadius), avail1, avail2);
		const ux1 = vx1 / len1;
		const uy1 = vy1 / len1;
		const ux2 = vx2 / len2;
		const uy2 = vy2 / len2;
		let r = rMax;
		if (r >= 0.5 && obstacleBoxes && obstacleBoxes.length > 0) {
			r = 0;
			for (const rc of [rMax, Math.min(rMax, 8), Math.min(rMax, 4), 0]) {
				if (rc < 0.5) {
					r = 0;
					break;
				}
				const axc = curr.x - ux1 * rc, ayc = curr.y - uy1 * rc;
				const bxc = curr.x + ux2 * rc, byc = curr.y + uy2 * rc;
				let hit = false;
				for (let tk = 1; tk < 16; tk++) {
					const t = tk / 16, omt = 1 - t;
					const qx = omt * omt * axc + 2 * omt * t * curr.x + t * t * bxc;
					const qy = omt * omt * ayc + 2 * omt * t * curr.y + t * t * byc;
					if (obstacleBoxes.some(b => qx > b.minX - 0.5 && qx < b.maxX + 0.5 && qy > b.minY - 0.5 && qy < b.maxY + 0.5)) {
						hit = true;
						break;
					}
				}
				if (!hit) {
					r = rc;
					break;
				}
			}
		}
		if (r < 0.5) {
			emitLineTo(curr.x, curr.y);
		} else {
			const ax = curr.x - ux1 * r;
			const ay = curr.y - uy1 * r;
			const bx = curr.x + ux2 * r;
			const by = curr.y + uy2 * r;
			emitLineTo(ax, ay);
			const rbx = roundSvgCoord(bx);
			const rby = roundSvgCoord(by);
			parts.push(`Q ${roundSvgCoord(curr.x)} ${roundSvgCoord(curr.y)} ${rbx} ${rby}`);
			penX = rbx;
			penY = rby;
		}
	}
	const last = pts[pts.length - 1];
	emitLineTo(last.x, last.y);
	return parts.join(' ');
}

export function computeOrthogonalRoundedEdgeRoute(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	options?: IMissionOrthogonalEdgeOptions,
): IMissionOrthogonalEdgeRoute {
	const rigidStubLength = Math.max(0, options?.rigidStubLength ?? 0);
	if (options?.orientation === 'vertical') {
		const transposedObstacles: IMissionEdgeObstacle[] | undefined = options.obstacles?.map(o => ({
			minX: o.minY,
			maxX: o.maxY,
			minY: o.minX,
			maxY: o.maxX,
		}));
		const cornerRadius = Math.max(0, options.cornerRadius ?? 14);
		const horizontal = computeOrthogonalRoundedEdgeRoute(y1, x1, y2, x2, {
			cornerRadius,
			minStub: options.minStub,
			wrapClearanceY: options.wrapClearanceY ?? 120,
			orientation: 'horizontal',
			obstacles: transposedObstacles,
			rigidStubLength,
		});
		const points = horizontal.points.map(p => ({ x: p.y, y: p.x }));
		return {
			path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius, rigidStubLength),
			midX: horizontal.midY,
			midY: horizontal.midX,
			points,
		};
	}

	const cornerRadius = Math.max(0, options?.cornerRadius ?? 14);
	const minStub = Math.max(rigidStubLength, Math.max(4, options?.minStub ?? 22));
	const wrapClearanceY = Math.max(24, options?.wrapClearanceY ?? 84);
	const obstacles = options?.obstacles ?? [];
	const dx = x2 - x1;
	const dy = y2 - y1;

	if (Math.abs(dy) < 1.5 && dx >= Math.max(0, rigidStubLength * 2)) {
		const blocking = obstacles.filter(o => o.minX < x2 - 4 && o.maxX > x1 + 4 && y1 >= o.minY && y1 <= o.maxY);
		if (blocking.length === 0) {
			const y = roundSvgCoord((y1 + y2) / 2);
			const points = [{ x: x1, y }, { x: x2, y }];
			return {
				path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius, rigidStubLength),
				midX: roundSvgCoord((x1 + x2) / 2),
				midY: y,
				points,
			};
		}
		const minTop = Math.min(...blocking.map(o => o.minY)) - 18;
		const maxBot = Math.max(...blocking.map(o => o.maxY)) + 18;
		const detourY = Math.abs(y1 - minTop) <= Math.abs(maxBot - y1) ? minTop : maxBot;
		const stub = Math.max(rigidStubLength, Math.min(minStub, Math.max(8, dx * 0.25)));
		const lx = x1 + stub;
		const rx = x2 - stub;
		const points = [
			{ x: x1, y: y1 },
			{ x: lx, y: y1 },
			{ x: lx, y: detourY },
			{ x: rx, y: detourY },
			{ x: rx, y: y2 },
			{ x: x2, y: y2 },
		];
		return {
			path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius, rigidStubLength),
			midX: roundSvgCoord((lx + rx) / 2),
			midY: roundSvgCoord(detourY),
			points,
		};
	}

	if (dx >= Math.max(rigidStubLength * 2, Math.min(minStub * 1.4, 20))) {
		let trunkX = (x1 + x2) / 2;
		const minTrunk = x1 + Math.max(rigidStubLength, Math.min(minStub, dx / 2));
		const maxTrunk = x2 - Math.max(rigidStubLength, Math.min(minStub, dx / 2));
		if (obstacles.length > 0 && verticalSegmentHitsObstacles(trunkX, y1, y2, obstacles)) {
			const gutterOffset = Math.min(minStub + 14, dx * 0.28);
			const candidates = [
				Math.max(minTrunk, Math.min(maxTrunk, x2 - gutterOffset)),
				Math.max(minTrunk, Math.min(maxTrunk, x1 + gutterOffset)),
			];
			for (const c of candidates) {
				if (!verticalSegmentHitsObstacles(c, y1, y2, obstacles)) {
					trunkX = c;
					break;
				}
			}
		}
		trunkX = Math.max(minTrunk, Math.min(maxTrunk, trunkX));
		const points = [
			{ x: x1, y: y1 },
			{ x: trunkX, y: y1 },
			{ x: trunkX, y: y2 },
			{ x: x2, y: y2 },
		];
		return {
			path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius, rigidStubLength),
			midX: roundSvgCoord(trunkX),
			midY: roundSvgCoord((y1 + y2) / 2),
			points,
		};
	}

	const outStub = Math.max(minStub, rigidStubLength + cornerRadius);
	const rightX = x1 + outStub;
	const leftX = x2 - outStub;
	const bridgeY = Math.abs(dy) >= 48
		? (y1 + y2) / 2
		: Math.min(y1, y2) - wrapClearanceY;
	const points = [
		{ x: x1, y: y1 },
		{ x: rightX, y: y1 },
		{ x: rightX, y: bridgeY },
		{ x: leftX, y: bridgeY },
		{ x: leftX, y: y2 },
		{ x: x2, y: y2 },
	];
	return {
		path: roundedOrthogonalPolylineToSvgPath(points, cornerRadius, rigidStubLength),
		midX: roundSvgCoord((rightX + leftX) / 2),
		midY: roundSvgCoord(bridgeY),
		points,
	};
}

export function buildOrthogonalRoundedEdgePath(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	options?: IMissionOrthogonalEdgeOptions,
): string {
	return computeOrthogonalRoundedEdgeRoute(x1, y1, x2, y2, options).path;
}

export function computeMissionWorldSize(
	positions: ReadonlyMap<string, IMissionNodePosition>,
	paddingX = 640,
	paddingY = 480,
): { readonly width: number; readonly height: number } {
	let maxX = 1280;
	let maxY = 820;
	for (const p of positions.values()) {
		if (p.x + paddingX > maxX) {
			maxX = p.x + paddingX;
		}
		if (p.y + paddingY > maxY) {
			maxY = p.y + paddingY;
		}
	}
	return {
		width: Math.ceil(maxX),
		height: Math.ceil(maxY),
	};
}

/**
 * Computes magnetic drag alignment snap deltas & visual reference guide lines against stationary nodes.
 */
export function computeNodeDragSnapAlignment(
	movingBounds: Omit<IMissionAlignRect, 'id'>,
	stationaryRects: readonly IMissionAlignRect[],
	threshold = 8,
): IMissionSnapAlignmentResult {
	if (stationaryRects.length === 0 || threshold <= 0) {
		return { dx: 0, dy: 0, guides: [] };
	}
	const movCx = (movingBounds.minX + movingBounds.maxX) / 2;
	const movCy = (movingBounds.minY + movingBounds.maxY) / 2;
	const movXs = [movingBounds.minX, movCx, movingBounds.maxX];
	const movYs = [movingBounds.minY, movCy, movingBounds.maxY];

	let bestDx: number | undefined;
	let bestXAbs = threshold + 1;
	let bestXCoord = 0;
	let bestXRefs: IMissionAlignRect[] = [];

	let bestDy: number | undefined;
	let bestYAbs = threshold + 1;
	let bestYCoord = 0;
	let bestYRefs: IMissionAlignRect[] = [];

	for (const ref of stationaryRects) {
		const refCx = (ref.minX + ref.maxX) / 2;
		const refCy = (ref.minY + ref.maxY) / 2;
		const refXs = [ref.minX, refCx, ref.maxX];
		const refYs = [ref.minY, refCy, ref.maxY];

		for (const mx of movXs) {
			for (const rx of refXs) {
				const delta = rx - mx;
				const abs = Math.abs(delta);
				if (abs <= threshold) {
					if (abs < bestXAbs - 0.01) {
						bestXAbs = abs;
						bestDx = delta;
						bestXCoord = rx;
						bestXRefs = [ref];
					} else if (Math.abs(abs - bestXAbs) <= 0.01 && Math.abs(rx - bestXCoord) <= 0.5) {
						bestXRefs.push(ref);
					}
				}
			}
		}

		for (const my of movYs) {
			for (const ry of refYs) {
				const delta = ry - my;
				const abs = Math.abs(delta);
				if (abs <= threshold) {
					if (abs < bestYAbs - 0.01) {
						bestYAbs = abs;
						bestDy = delta;
						bestYCoord = ry;
						bestYRefs = [ref];
					} else if (Math.abs(abs - bestYAbs) <= 0.01 && Math.abs(ry - bestYCoord) <= 0.5) {
						bestYRefs.push(ref);
					}
				}
			}
		}
	}

	const dx = bestDx !== undefined ? Math.round(bestDx) : 0;
	const dy = bestDy !== undefined ? Math.round(bestDy) : 0;
	const guides: IMissionAlignGuide[] = [];
	const pad = 20;

	if (bestDx !== undefined && bestXRefs.length > 0) {
		let startY = movingBounds.minY + dy;
		let endY = movingBounds.maxY + dy;
		for (const ref of bestXRefs) {
			startY = Math.min(startY, ref.minY);
			endY = Math.max(endY, ref.maxY);
		}
		guides.push({
			axis: 'x',
			coord: Math.round(bestXCoord),
			start: Math.round(startY - pad),
			end: Math.round(endY + pad),
		});
	}

	if (bestDy !== undefined && bestYRefs.length > 0) {
		let startX = movingBounds.minX + dx;
		let endX = movingBounds.maxX + dx;
		for (const ref of bestYRefs) {
			startX = Math.min(startX, ref.minX);
			endX = Math.max(endX, ref.maxX);
		}
		guides.push({
			axis: 'y',
			coord: Math.round(bestYCoord),
			start: Math.round(startX - pad),
			end: Math.round(endX + pad),
		});
	}

	return { dx, dy, guides };
}

// ============================================================================
// Single-Parent Reporting Tree + Whiteboard Graph & Multi-Anchor Geometry
// ============================================================================

export type OrchestrationDirection = 'LR' | 'TD';
export type OrchestrationLayoutMode = 'lr' | 'td' | 'radial' | 'grid';
export type OrchestrationNodeKind = 'staff' | 'whiteboard';
export type OrchestrationAnchorSide = 'top' | 'right' | 'bottom' | 'left';

export const ORCHESTRATION_ANCHOR_SIDES: readonly OrchestrationAnchorSide[] = ['top', 'right', 'bottom', 'left'];
export const ORCHESTRATION_SLOTS_PER_SIDE = 5;

export const ORCH_STAFF_CARD_WIDTH = 344;
export const ORCH_STAFF_CARD_HEIGHT = 188;
export const ORCH_WHITEBOARD_CARD_WIDTH = 276;
export const ORCH_WHITEBOARD_CARD_HEIGHT = 164;

export const ORCHESTRATION_STAFF_NODE_WIDTH = ORCH_STAFF_CARD_WIDTH;
export const ORCHESTRATION_STAFF_NODE_HEIGHT = ORCH_STAFF_CARD_HEIGHT;
export const ORCHESTRATION_WHITEBOARD_NODE_WIDTH = ORCH_WHITEBOARD_CARD_WIDTH;
export const ORCHESTRATION_WHITEBOARD_NODE_HEIGHT = ORCH_WHITEBOARD_CARD_HEIGHT;

/** Symmetric anchor outset (px) outside 344×188 staff card border so 8.5px userSpaceOnUse arrow tips sit at +5.66px (+1.66px outside +4.0px pin ring). */
export const ORCH_STAFF_EDGE_OUTSET = 6;
/** Whiteboard dashed attachment links have zero outset and zero arrowheads. */
export const ORCH_WHITEBOARD_EDGE_OUTSET = 0;
/** Strict outward-normal rigid stub length (px) forbidden to corner-rounding tangents and pill-box detours. */
export const ORCH_RIGID_STUB_LENGTH = 22;
/** Default orthogonal corner radius (px) for staff edges outside the 22px rigid stubs. */
export const ORCH_CORNER_RADIUS = 16;

const DEFAULT_SLOT_FRACTIONS_5 = [0.18, 0.34, 0.5, 0.66, 0.82] as const;
const DEFAULT_SLOT_FRACTIONS_3 = [0.26, 0.5, 0.74] as const;

export function toOrchestrationLayoutMode(dir: AdeLayoutDirection | string | undefined): OrchestrationLayoutMode {
	switch (String(dir || '').toUpperCase()) {
		case 'LR': return 'lr';
		case 'RADIAL': return 'radial';
		case 'GRID': return 'grid';
		case 'TD':
		default:
			return 'td';
	}
}

export function fromOrchestrationLayoutMode(mode: OrchestrationLayoutMode): AdeLayoutDirection {
	switch (mode) {
		case 'lr': return 'LR';
		case 'radial': return 'RADIAL';
		case 'grid': return 'GRID';
		case 'td':
		default:
			return 'TD';
	}
}

export interface IOrchestrationGraphNode {
	readonly id: string;
	readonly label: string;
	readonly kind: OrchestrationNodeKind;
	readonly employeeName?: string;
	/** Hierarchy level (`1` = sole top-level L1, `2` = L2, ...; smaller is higher). */
	readonly tier?: number;
	readonly levelLabel?: string;
	readonly isTopRole?: boolean;
	readonly parentId?: string | null;
	readonly roleSummary?: string;
	readonly host?: string;
	readonly engineId?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly sessionPhase?: string;
	readonly sessionStarted?: boolean;
	readonly sessionResource?: string;
	readonly department?: string;
	readonly departmentId?: string;
	readonly effectiveDeptIds?: readonly string[];
	readonly color?: string;
	/** Whiteboard properties when `kind === 'whiteboard'`. */
	readonly whiteboardId?: string;
	readonly ownerId?: string | null;
	readonly ownerName?: string;
	readonly storageHost?: string;
	readonly migrationState?: string;
	readonly tagCategories?: readonly string[];
	readonly heldTicketCount?: number;
}

export interface IOrchestrationDepartmentGroup {
	readonly id: string;
	readonly name: string;
	readonly rootAgentId?: string;
	readonly parentDeptId?: string | null;
	readonly createdBy?: string;
	readonly color?: string;
	readonly nodeIds: readonly string[];
	readonly whiteboardIds: readonly string[];
}

export interface IOrchestrationGraphEdge {
	readonly id: string;
	readonly from: string;
	readonly to: string;
	/** Canonical undirected key `canonicalEdgePairKey(from, to)` for staff parent-child edges. */
	readonly edgePairKey?: string;
	readonly isBidirectional?: boolean;
	readonly isWhiteboardLink?: boolean;
	readonly dashed?: boolean;
}

export interface IOrchestrationAnchorPoint {
	readonly side: OrchestrationAnchorSide;
	readonly slot: number;
	readonly fraction: number;
	readonly x: number;
	readonly y: number;
	/** Outward unit normal vector `(nx, ny)` leaving the card border. */
	readonly nx: number;
	readonly ny: number;
}

export interface IOrchestrationRoutedEdge {
	readonly edgeId: string;
	readonly from: string;
	readonly to: string;
	readonly fromAnchor: IOrchestrationAnchorPoint;
	readonly toAnchor: IOrchestrationAnchorPoint;
	readonly path: string;
	readonly midX: number;
	readonly midY: number;
	readonly points: readonly { readonly x: number; readonly y: number }[];
	readonly isBidirectional: boolean;
	readonly isWhiteboardLink: boolean;
	readonly laneIndex: number;
}

export interface IProjectOrchestrationGraph {
	readonly direction: OrchestrationDirection;
	readonly layoutMode: OrchestrationLayoutMode;
	readonly nodes: readonly IOrchestrationGraphNode[];
	readonly edges: readonly IOrchestrationGraphEdge[];
	readonly departments: readonly IOrchestrationDepartmentGroup[];
	readonly storedPositions: ReadonlyMap<string, IMissionNodePosition>;
}

export function getOrchestrationNodeSize(
	node: Pick<IOrchestrationGraphNode, 'kind'>,
): { readonly width: number; readonly height: number } {
	return node.kind === 'whiteboard'
		? { width: ORCH_WHITEBOARD_CARD_WIDTH, height: ORCH_WHITEBOARD_CARD_HEIGHT }
		: { width: ORCH_STAFF_CARD_WIDTH, height: ORCH_STAFF_CARD_HEIGHT };
}

export const getRenderedOrchestrationNodeSize = getOrchestrationNodeSize;

/**
 * Projects an `IAdeProjectSnapshot` into pure single-parent reporting tree nodes,
 * $N - 1$ direct bidirectional parent-child solid edges (ZERO cross-tier dashed edges),
 * nested connected-subtree department groups, and whiteboard dashed links.
 */
/**
 * Pure helper evaluating whether `agentId` is an effective member of `department` under the
 * connected-subtree branch-cut formula (`plan.md` §5.1).
 */
export function isAgentEffectiveDepartmentMember(
	agentsById: ReadonlyMap<string, IAdeAgentNode>,
	department: IAdeDepartment,
	agentId: string,
): boolean {
	const chain: IAdeAgentNode[] = [];
	const seen = new Set<string>();
	let cur: string | null = agentId;
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		const node = agentsById.get(cur);
		if (!node) {
			break;
		}
		chain.push(node);
		cur = node.parent_id;
	}
	chain.reverse();
	const rootIdx = chain.findIndex(a => a.agent_id === department.root_agent_id);
	if (rootIdx < 0) {
		return false;
	}
	for (let i = rootIdx; i < chain.length; i++) {
		if (chain[i].excluded_dept_ids.includes(department.dept_id)) {
			return false;
		}
	}
	return true;
}

export function buildProjectOrchestrationGraph(
	snapshot: IAdeProjectSnapshot,
	colorOverrides?: {
		readonly deptColors?: Readonly<Record<string, string | undefined>>;
		readonly wbColors?: Readonly<Record<string, string | undefined>>;
	},
): IProjectOrchestrationGraph {
	const layoutMode = toOrchestrationLayoutMode(snapshot.meta.layout_direction);
	const direction: OrchestrationDirection = layoutMode === 'lr' ? 'LR' : 'TD';

	const policyAgents: Record<string, IAdePolicyAgent> = {};
	for (const a of snapshot.agents) {
		policyAgents[a.agent_id] = {
			agent_id: a.agent_id,
			project_id: a.project_id,
			level: a.level,
			is_top_role: a.is_top_role,
			parent_id: a.parent_id,
			excluded_dept_ids: [...a.excluded_dept_ids],
		};
	}
	const policyDepts: Record<string, IAdePolicyDepartment> = {};
	for (const d of snapshot.departments) {
		policyDepts[d.dept_id] = {
			dept_id: d.dept_id,
			project_id: d.project_id,
			name: d.name,
			root_agent_id: d.root_agent_id,
			parent_dept_id: d.parent_dept_id,
			board_permissions: d.board_permissions,
			created_by: d.created_by,
		};
	}
	const policyWbs: Record<string, IAdePolicyWhiteboard> = {};
	for (const w of snapshot.whiteboards) {
		policyWbs[w.board_id] = {
			board_id: w.board_id,
			project_id: w.project_id,
			owner_id: w.owner_id,
			dept_id: w.dept_id,
		};
	}
	const policyGrants: IAdePolicyBoardGrant[] = snapshot.board_grants.map(g => ({
		board_id: g.board_id,
		agent_id: g.agent_id,
		permission: g.permission,
		granted_by: g.granted_by,
	}));
	const policyState: IAdePolicyProjectState = {
		project_id: snapshot.meta.project_id,
		agents: policyAgents,
		departments: policyDepts,
		whiteboards: policyWbs,
		board_grants: policyGrants,
		tickets: {},
	};

	const heldCountByAgent = new Map<string, number>();
	for (const tk of snapshot.tickets) {
		if (tk.status === 'active' && tk.holder_id) {
			heldCountByAgent.set(tk.holder_id, (heldCountByAgent.get(tk.holder_id) ?? 0) + 1);
		}
	}

	const deptById = new Map(snapshot.departments.map(d => [d.dept_id, d]));
	const agentById = new Map(snapshot.agents.map(a => [a.agent_id, a]));
	const storedPositions = new Map<string, IMissionNodePosition>();

	const sortedAgents = [...snapshot.agents].sort((a, b) =>
		a.level - b.level
		|| a.created_at - b.created_at
		|| a.agent_id.localeCompare(b.agent_id),
	);

	const memberIdsByDept = new Map<string, string[]>();
	for (const d of snapshot.departments) {
		memberIdsByDept.set(d.dept_id, []);
	}

	const nodes: IOrchestrationGraphNode[] = [];
	const edges: IOrchestrationGraphEdge[] = [];

	for (const agent of sortedAgents) {
		const effDeptIds = getEffectiveDeptIds(policyState, agent.agent_id);
		for (const did of effDeptIds) {
			memberIdsByDept.get(did)?.push(agent.agent_id);
		}
		const innermostDeptId = effDeptIds.length > 0 ? effDeptIds[effDeptIds.length - 1] : undefined;
		const innermostDept = innermostDeptId ? deptById.get(innermostDeptId) : undefined;

		if (typeof agent.canvas_x === 'number' && Number.isFinite(agent.canvas_x)
			&& typeof agent.canvas_y === 'number' && Number.isFinite(agent.canvas_y)) {
			storedPositions.set(agent.agent_id, { x: agent.canvas_x, y: agent.canvas_y });
		}

		nodes.push({
			id: agent.agent_id,
			label: agent.name,
			kind: 'staff',
			employeeName: agent.name,
			tier: agent.level,
			levelLabel: formatLevelLabel(agent.level),
			isTopRole: agent.is_top_role,
			parentId: agent.parent_id,
			roleSummary: agent.role_summary,
			host: agent.host,
			engineId: agent.engine,
			model: agent.model,
			thinking: agent.effort,
			sessionPhase: agent.session_phase,
			sessionStarted: agent.session_started,
			sessionResource: agent.session_resource,
			department: innermostDept?.name,
			departmentId: innermostDeptId,
			effectiveDeptIds: effDeptIds,
			color: normalizeAdeNodeColor(agent.color_token),
			heldTicketCount: heldCountByAgent.get(agent.agent_id) ?? 0,
		});

		// STRICT INVARIANT: Render ONLY the N-1 direct parent-child reporting tree edges, always bidirectional!
		if (agent.parent_id && agentById.has(agent.parent_id)) {
			const pairKey = canonicalEdgePairKey(agent.parent_id, agent.agent_id);
			edges.push({
				id: pairKey,
				from: agent.parent_id,
				to: agent.agent_id,
				edgePairKey: pairKey,
				isBidirectional: true,
				isWhiteboardLink: false,
				dashed: false,
			});
		}
	}

	const wbIdsByDept = new Map<string, string[]>();
	for (const d of snapshot.departments) {
		wbIdsByDept.set(d.dept_id, []);
	}

	const sortedWhiteboards = [...snapshot.whiteboards].sort((a, b) =>
		a.created_at - b.created_at || a.board_id.localeCompare(b.board_id),
	);

	for (const wb of sortedWhiteboards) {
		const boundDept = wb.dept_id ? deptById.get(wb.dept_id) : undefined;
		if (boundDept) {
			wbIdsByDept.get(boundDept.dept_id)?.push(wb.board_id);
		}
		if (typeof wb.canvas_x === 'number' && Number.isFinite(wb.canvas_x)
			&& typeof wb.canvas_y === 'number' && Number.isFinite(wb.canvas_y)) {
			storedPositions.set(wb.board_id, { x: wb.canvas_x, y: wb.canvas_y });
		}
		const ownerAgent = wb.owner_id ? agentById.get(wb.owner_id) : undefined;
		nodes.push({
			id: wb.board_id,
			label: wb.name,
			kind: 'whiteboard',
			whiteboardId: wb.board_id,
			department: boundDept?.name,
			departmentId: boundDept?.dept_id,
			ownerId: wb.owner_id,
			ownerName: ownerAgent?.name,
			storageHost: wb.storage_host,
			migrationState: wb.migration_state,
			tagCategories: wb.tag_categories,
			color: normalizeAdeNodeColor(colorOverrides?.wbColors?.[wb.board_id]),
		});

		const attachAgentId = (boundDept && agentById.has(boundDept.root_agent_id))
			? boundDept.root_agent_id
			: (wb.owner_id && agentById.has(wb.owner_id) ? wb.owner_id : undefined);
		if (attachAgentId) {
			edges.push({
				id: `wb:${wb.board_id}`,
				from: attachAgentId,
				to: wb.board_id,
				isBidirectional: false,
				isWhiteboardLink: true,
				dashed: true,
			});
		}
	}

	const computeDeptDepth = (deptId: string): number => {
		let depth = 0;
		const seen = new Set<string>();
		let cur = deptById.get(deptId);
		while (cur?.parent_dept_id && !seen.has(cur.dept_id)) {
			seen.add(cur.dept_id);
			const parent = deptById.get(cur.parent_dept_id);
			if (!parent) {
				break;
			}
			depth++;
			cur = parent;
		}
		return depth;
	};

	const sortedDepts = [...snapshot.departments].sort((a, b) =>
		computeDeptDepth(a.dept_id) - computeDeptDepth(b.dept_id)
		|| a.created_at - b.created_at
		|| a.dept_id.localeCompare(b.dept_id),
	);

	const departments: IOrchestrationDepartmentGroup[] = sortedDepts.map(d => ({
		id: d.dept_id,
		name: d.name,
		rootAgentId: d.root_agent_id,
		parentDeptId: d.parent_dept_id,
		createdBy: d.created_by,
		color: normalizeAdeNodeColor(colorOverrides?.deptColors?.[d.dept_id]),
		nodeIds: memberIdsByDept.get(d.dept_id) ?? [],
		whiteboardIds: wbIdsByDept.get(d.dept_id) ?? [],
	}));

	return {
		direction,
		layoutMode,
		nodes,
		edges,
		departments,
		storedPositions,
	};
}

// ============================================================================
// Auto-Layout Engine (`td` | `lr` | `radial` | `grid`) for Single-Parent Tree
// ============================================================================

export function computeOrchestrationLayoutPositions(
	nodes: readonly IOrchestrationGraphNode[],
	edges: readonly IOrchestrationGraphEdge[],
	departments: readonly IOrchestrationDepartmentGroup[],
	options?: {
		readonly mode?: OrchestrationLayoutMode;
		readonly direction?: OrchestrationDirection;
		readonly existingPositions?: ReadonlyMap<string, IMissionNodePosition>;
		readonly ignoreExisting?: boolean;
	},
): Map<string, IMissionNodePosition> {
	const positions = new Map<string, IMissionNodePosition>();
	if (nodes.length === 0) {
		return positions;
	}

	const mode: OrchestrationLayoutMode = options?.mode
		?? (options?.direction === 'LR' ? 'lr' : 'td');
	const staffNodes = nodes.filter(n => n.kind === 'staff');
	const wbNodes = nodes.filter(n => n.kind === 'whiteboard');
	const staffById = new Map(staffNodes.map(n => [n.id, n]));

	// Build parent -> children map from either `parentId` or staff edges
	const childrenByParent = new Map<string, string[]>();
	const parentByChild = new Map<string, string>();
	for (const s of staffNodes) {
		childrenByParent.set(s.id, []);
	}
	for (const s of staffNodes) {
		if (s.parentId && staffById.has(s.parentId) && s.parentId !== s.id) {
			parentByChild.set(s.id, s.parentId);
			childrenByParent.get(s.parentId)!.push(s.id);
		}
	}
	for (const e of edges) {
		if (e.isWhiteboardLink) {
			continue;
		}
		if (staffById.has(e.from) && staffById.has(e.to) && e.from !== e.to && !parentByChild.has(e.to)) {
			parentByChild.set(e.to, e.from);
			childrenByParent.get(e.from)?.push(e.to);
		}
	}

	// Sort children so same-department siblings stay contiguous!
	for (const list of childrenByParent.values()) {
		list.sort((aId, bId) => {
			const a = staffById.get(aId)!;
			const b = staffById.get(bId)!;
			const da = a.departmentId ?? '';
			const db = b.departmentId ?? '';
			if (da !== db) {
				return da.localeCompare(db);
			}
			return (a.tier ?? 99) - (b.tier ?? 99) || a.id.localeCompare(b.id);
		});
	}

	const roots = staffNodes
		.filter(s => !parentByChild.has(s.id))
		.sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1) || a.id.localeCompare(b.id));

	// Map whiteboards attached to each staff node so tree width accounts for side-mounted whiteboards
	const attachedWbsByStaff = new Map<string, IOrchestrationGraphNode[]>();
	const orphanWbs: IOrchestrationGraphNode[] = [];
	const wbById = new Map(wbNodes.map(w => [w.id, w]));
	const placedWbs = new Set<string>();
	for (const e of edges) {
		if (!e.isWhiteboardLink) {
			continue;
		}
		const staffId = staffById.has(e.from) ? e.from : (staffById.has(e.to) ? e.to : undefined);
		const wbId = wbById.has(e.to) ? e.to : (wbById.has(e.from) ? e.from : undefined);
		if (staffId && wbId && !placedWbs.has(wbId)) {
			placedWbs.add(wbId);
			const arr = attachedWbsByStaff.get(staffId) ?? [];
			arr.push(wbById.get(wbId)!);
			attachedWbsByStaff.set(staffId, arr);
		}
	}
	for (const w of wbNodes) {
		if (!placedWbs.has(w.id)) {
			orphanWbs.push(w);
		}
	}

	if (mode === 'grid') {
		const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
		const cellW = ORCH_STAFF_CARD_WIDTH + 136;
		const cellH = ORCH_STAFF_CARD_HEIGHT + 124;
		const startX = 280;
		const startY = 210;
		nodes.forEach((n, idx) => {
			const col = idx % cols;
			const row = Math.floor(idx / cols);
			positions.set(n.id, {
				x: Math.round(startX + col * cellW),
				y: Math.round(startY + row * cellH),
			});
		});
	} else if (mode === 'radial') {
		const centerX = 760;
		const centerY = 540;
		const depthById = new Map<string, number>();
		const orderedByDepth = new Map<number, string[]>();
		const visited = new Set<string>();
		const queue: Array<{ id: string; depth: number }> = roots.map(r => ({ id: r.id, depth: 0 }));
		while (queue.length > 0) {
			const cur = queue.shift()!;
			if (visited.has(cur.id)) {
				continue;
			}
			visited.add(cur.id);
			depthById.set(cur.id, cur.depth);
			const arr = orderedByDepth.get(cur.depth) ?? [];
			arr.push(cur.id);
			orderedByDepth.set(cur.depth, arr);
			for (const ch of childrenByParent.get(cur.id) ?? []) {
				queue.push({ id: ch, depth: cur.depth + 1 });
			}
		}
		for (const s of staffNodes) {
			if (!visited.has(s.id)) {
				const arr = orderedByDepth.get(1) ?? [];
				arr.push(s.id);
				orderedByDepth.set(1, arr);
			}
		}
		let prevRingRadius = 0;
		const sortedDepths = [...orderedByDepth.keys()].sort((a, b) => a - b);
		for (const depth of sortedDepths) {
			const ids = orderedByDepth.get(depth)!;
			if (depth === 0 && ids.length === 1) {
				positions.set(ids[0], { x: centerX, y: centerY });
				continue;
			}
			const minRadialStep = 468;
			const minChordRadius = ids.length >= 2
				? Math.ceil(440 / (2 * Math.sin(Math.PI / ids.length)))
				: minRadialStep;
			const ringRadius = Math.max(minRadialStep, prevRingRadius + minRadialStep, depth * minRadialStep, minChordRadius);
			prevRingRadius = ringRadius;
			ids.forEach((id, idx) => {
				const angle = -Math.PI / 2 + (2 * Math.PI * idx) / ids.length;
				positions.set(id, {
					x: Math.round(centerX + Math.cos(angle) * ringRadius),
					y: Math.round(centerY + Math.sin(angle) * ringRadius),
				});
			});
		}
		const radialOccupied: IMissionEdgeObstacle[] = staffNodes
			.map(s => positions.get(s.id))
			.filter((p): p is IMissionNodePosition => Boolean(p))
			.map(p => ({
				minX: p.x - ORCH_STAFF_CARD_WIDTH / 2 - 36,
				maxX: p.x + ORCH_STAFF_CARD_WIDTH / 2 + 36,
				minY: p.y - ORCH_STAFF_CARD_HEIGHT / 2 - 36,
				maxY: p.y + ORCH_STAFF_CARD_HEIGHT / 2 + 36,
			}));
		const placeRadialWbClear = (prefX: number, prefY: number): IMissionNodePosition => {
			const hw = ORCH_WHITEBOARD_CARD_WIDTH / 2;
			const hh = ORCH_WHITEBOARD_CARD_HEIGHT / 2;
			const baseOffsets: readonly (readonly [number, number])[] = [
				[0, 0], [-796, 0], [0, 220], [0, -220], [420, 0], [-1216, 0], [0, 440], [0, -440],
			];
			for (let ring = 0; ring < 16; ring++) {
				const cands = ring === 0 ? baseOffsets : [[ring * 360, 0], [-796 - ring * 360, 0], [0, ring * 230], [0, -ring * 230]] as const;
				for (const [ox, oy] of cands) {
					const cx = Math.round(prefX + ox), cy = Math.round(prefY + oy);
					if (!radialOccupied.some(o => cx + hw > o.minX && cx - hw < o.maxX && cy + hh > o.minY && cy - hh < o.maxY)) {
						radialOccupied.push({ minX: cx - hw - 36, maxX: cx + hw + 36, minY: cy - hh - 36, maxY: cy + hh + 36 });
						return { x: cx, y: cy };
					}
				}
			}
			return { x: Math.round(centerX + prevRingRadius + 460), y: Math.round(prefY) };
		};
		for (const [staffId, wbs] of attachedWbsByStaff.entries()) {
			const sp = positions.get(staffId) ?? { x: centerX, y: centerY };
			wbs.forEach((wb, idx) => {
				positions.set(wb.id, placeRadialWbClear(
					sp.x + ORCH_STAFF_CARD_WIDTH / 2 + ORCH_WHITEBOARD_CARD_WIDTH / 2 + 88,
					sp.y + idx * (ORCH_WHITEBOARD_CARD_HEIGHT + 44),
				));
			});
		}
		orphanWbs.forEach((wb, idx) => {
			positions.set(wb.id, placeRadialWbClear(centerX + prevRingRadius + 460, 200 + idx * (ORCH_WHITEBOARD_CARD_HEIGHT + 48)));
		});
	} else {
		// Hierarchical single-parent tree layout (`td` or `lr`) with extra room for nested department frames & side whiteboards
		const isTD = mode === 'td';
		const primaryStep = isTD
			? ORCH_STAFF_CARD_HEIGHT + 136 // 324px center-to-center -> 136px clean vertical corridor (> 76px)
			: ORCH_STAFF_CARD_WIDTH + 168; // 512px center-to-center -> 168px clean horizontal corridor (> 76px)
		const baseBreadthUnit = isTD
			? ORCH_STAFF_CARD_WIDTH + 88
			: ORCH_STAFF_CARD_HEIGHT + 84;
		const deptBoundaryPad = 64;

		const spanByNode = new Map<string, number>();
		const visitedSpan = new Set<string>();
		const computeSubtreeSpan = (id: string): number => {
			if (visitedSpan.has(id)) {
				return baseBreadthUnit;
			}
			visitedSpan.add(id);
			const attachedCount = attachedWbsByStaff.get(id)?.length ?? 0;
			const selfSpan = baseBreadthUnit + (attachedCount > 0
				? (isTD ? ORCH_WHITEBOARD_CARD_WIDTH + 72 : attachedCount * (ORCH_WHITEBOARD_CARD_HEIGHT + 40))
				: 0);
			const children = childrenByParent.get(id) ?? [];
			if (children.length === 0) {
				spanByNode.set(id, selfSpan);
				return selfSpan;
			}
			let childrenSum = 0;
			for (let i = 0; i < children.length; i++) {
				const ch = children[i];
				childrenSum += computeSubtreeSpan(ch);
				if (i > 0) {
					const prevDept = staffById.get(children[i - 1])?.departmentId ?? '';
					const curDept = staffById.get(ch)?.departmentId ?? '';
					if (prevDept !== curDept) {
						childrenSum += deptBoundaryPad;
					}
				}
			}
			const span = Math.max(selfSpan, childrenSum);
			spanByNode.set(id, span);
			return span;
		};

		for (const r of roots) {
			computeSubtreeSpan(r.id);
		}
		for (const s of staffNodes) {
			if (!spanByNode.has(s.id)) {
				computeSubtreeSpan(s.id);
			}
		}

		const visitedPlace = new Set<string>();
		const placeSubtree = (id: string, depth: number, breadthStart: number): void => {
			if (visitedPlace.has(id)) {
				return;
			}
			visitedPlace.add(id);
			const span = spanByNode.get(id) ?? baseBreadthUnit;
			const attachedWbs = attachedWbsByStaff.get(id) ?? [];
			// Shift staff slightly left in TD when it has a right-mounted whiteboard so subtree stays balanced
			const wbCenterShift = isTD && attachedWbs.length > 0
				? -(ORCH_WHITEBOARD_CARD_WIDTH + 60) / 2
				: 0;
			const breadthCenter = breadthStart + span / 2 + wbCenterShift;
			const primaryCoord = (isTD ? 210 : 280) + depth * primaryStep;

			const staffPos: IMissionNodePosition = isTD
				? { x: Math.round(breadthCenter), y: Math.round(primaryCoord) }
				: { x: Math.round(primaryCoord), y: Math.round(breadthCenter) };
			positions.set(id, staffPos);

			attachedWbs.forEach((wb, idx) => {
				if (isTD) {
					positions.set(wb.id, {
						x: Math.round(staffPos.x + ORCH_STAFF_CARD_WIDTH / 2 + ORCH_WHITEBOARD_CARD_WIDTH / 2 + 64),
						y: Math.round(staffPos.y + idx * (ORCH_WHITEBOARD_CARD_HEIGHT + 36)),
					});
				} else {
					positions.set(wb.id, {
						x: Math.round(staffPos.x),
						y: Math.round(staffPos.y + ORCH_STAFF_CARD_HEIGHT / 2 + ORCH_WHITEBOARD_CARD_HEIGHT / 2 + 54 + idx * (ORCH_WHITEBOARD_CARD_HEIGHT + 32)),
					});
				}
			});

			const children = childrenByParent.get(id) ?? [];
			if (children.length === 0) {
				return;
			}
			let totalChildSpan = 0;
			for (let i = 0; i < children.length; i++) {
				totalChildSpan += spanByNode.get(children[i]) ?? baseBreadthUnit;
				if (i > 0) {
					const prevDept = staffById.get(children[i - 1])?.departmentId ?? '';
					const curDept = staffById.get(children[i])?.departmentId ?? '';
					if (prevDept !== curDept) {
						totalChildSpan += deptBoundaryPad;
					}
				}
			}
			let cursor = breadthStart + (span - totalChildSpan) / 2;
			for (let i = 0; i < children.length; i++) {
				const ch = children[i];
				if (i > 0) {
					const prevDept = staffById.get(children[i - 1])?.departmentId ?? '';
					const curDept = staffById.get(ch)?.departmentId ?? '';
					if (prevDept !== curDept) {
						cursor += deptBoundaryPad;
					}
				}
				const chSpan = spanByNode.get(ch) ?? baseBreadthUnit;
				placeSubtree(ch, depth + 1, cursor);
				cursor += chSpan;
			}
		};

		let rootCursor = isTD ? 220 : 180;
		for (const r of roots) {
			const rSpan = spanByNode.get(r.id) ?? baseBreadthUnit;
			placeSubtree(r.id, 0, rootCursor);
			rootCursor += rSpan + 96;
		}
		for (const s of staffNodes) {
			if (!positions.has(s.id)) {
				const sSpan = spanByNode.get(s.id) ?? baseBreadthUnit;
				placeSubtree(s.id, 0, rootCursor);
				rootCursor += sSpan + 96;
			}
		}

		orphanWbs.forEach((wb, idx) => {
			if (isTD) {
				positions.set(wb.id, {
					x: Math.round(rootCursor + ORCH_WHITEBOARD_CARD_WIDTH / 2 + 40),
					y: Math.round(210 + idx * (ORCH_WHITEBOARD_CARD_HEIGHT + 48)),
				});
			} else {
				positions.set(wb.id, {
					x: Math.round(280 + idx * (ORCH_WHITEBOARD_CARD_WIDTH + 64)),
					y: Math.round(rootCursor + ORCH_WHITEBOARD_CARD_HEIGHT / 2 + 40),
				});
			}
		});
	}

	// Overlay any user-persisted coordinates unless caller explicitly requested a fresh auto-layout,
	// and nudge any newly added unpinned nodes if a manually pinned card already occupies their auto slot!
	if (!options?.ignoreExisting && options?.existingPositions && options.existingPositions.size > 0) {
		const occupied: Array<{ readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }> = [];
		const unpinnedNodes: IOrchestrationGraphNode[] = [];
		for (const n of nodes) {
			const saved = options.existingPositions.get(n.id);
			if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
				const p = { x: Math.round(saved.x), y: Math.round(saved.y) };
				positions.set(n.id, p);
				const sz = getOrchestrationNodeSize(n);
				occupied.push({
					minX: p.x - sz.width / 2 - 24,
					maxX: p.x + sz.width / 2 + 24,
					minY: p.y - sz.height / 2 - 24,
					maxY: p.y + sz.height / 2 + 24,
				});
			} else {
				unpinnedNodes.push(n);
			}
		}
		for (const n of unpinnedNodes) {
			const base = positions.get(n.id) ?? { x: 280, y: 210 };
			const sz = getOrchestrationNodeSize(n);
			const stepX = mode === 'lr' ? 0 : (sz.width + 64);
			const stepY = mode === 'lr' ? (sz.height + 56) : 0;
			let cand = base;
			for (let attempt = 0; attempt < 24; attempt++) {
				const box = {
					minX: cand.x - sz.width / 2,
					maxX: cand.x + sz.width / 2,
					minY: cand.y - sz.height / 2,
					maxY: cand.y + sz.height / 2,
				};
				const collides = occupied.some(o => box.maxX > o.minX && box.minX < o.maxX && box.maxY > o.minY && box.minY < o.maxY);
				if (!collides) {
					break;
				}
				cand = {
					x: Math.round(base.x + stepX * (attempt + 1)),
					y: Math.round(base.y + stepY * (attempt + 1)),
				};
			}
			positions.set(n.id, cand);
			occupied.push({
				minX: cand.x - sz.width / 2 - 24,
				maxX: cand.x + sz.width / 2 + 24,
				minY: cand.y - sz.height / 2 - 24,
				maxY: cand.y + sz.height / 2 + 24,
			});
		}
	}

	void departments;
	return positions;
}

// ============================================================================
// Multi-Anchor Port Coordinates & Strict 22px Outward-Normal Rigid Stub Router
// ============================================================================

export function getOrchestrationAnchorFraction(slot: number, totalSlots = ORCHESTRATION_SLOTS_PER_SIDE): number {
	if (totalSlots <= 1) {
		return 0.5;
	}
	if (totalSlots === 5 && slot >= 0 && slot < 5) {
		return DEFAULT_SLOT_FRACTIONS_5[slot];
	}
	if (totalSlots === 3 && slot >= 0 && slot < 3) {
		return DEFAULT_SLOT_FRACTIONS_3[slot];
	}
	const clamped = Math.max(0, Math.min(totalSlots - 1, slot));
	return 0.16 + (clamped / (totalSlots - 1)) * 0.68;
}

export function computeOrchestrationAnchorPoint(
	center: IMissionNodePosition,
	size: { readonly width: number; readonly height: number },
	side: OrchestrationAnchorSide,
	slot: number,
	totalSlots = ORCHESTRATION_SLOTS_PER_SIDE,
	outset = 0,
): IOrchestrationAnchorPoint {
	const fraction = getOrchestrationAnchorFraction(slot, totalSlots);
	const left = center.x - size.width / 2;
	const top = center.y - size.height / 2;
	switch (side) {
		case 'top':
			return { side, slot, fraction, x: Math.round(left + size.width * fraction), y: Math.round(top - outset), nx: 0, ny: -1 };
		case 'bottom':
			return { side, slot, fraction, x: Math.round(left + size.width * fraction), y: Math.round(top + size.height + outset), nx: 0, ny: 1 };
		case 'left':
			return { side, slot, fraction, x: Math.round(left - outset), y: Math.round(top + size.height * fraction), nx: -1, ny: 0 };
		case 'right':
			return { side, slot, fraction, x: Math.round(left + size.width + outset), y: Math.round(top + size.height * fraction), nx: 1, ny: 0 };
	}
}

export function getOrchestrationNodeAnchors(
	center: IMissionNodePosition,
	size: { readonly width: number; readonly height: number },
): readonly IOrchestrationAnchorPoint[] {
	const out: IOrchestrationAnchorPoint[] = [];
	for (const side of ORCHESTRATION_ANCHOR_SIDES) {
		for (let slot = 0; slot < ORCHESTRATION_SLOTS_PER_SIDE; slot++) {
			out.push(computeOrchestrationAnchorPoint(center, size, side, slot, ORCHESTRATION_SLOTS_PER_SIDE, 0));
		}
	}
	return out;
}

function chooseOptimalAnchorSides(
	fromPos: IMissionNodePosition,
	toPos: IMissionNodePosition,
	fromSize: { readonly width: number; readonly height: number },
	toSize: { readonly width: number; readonly height: number },
	isWhiteboardLink: boolean,
	direction: OrchestrationDirection,
	layoutMode?: OrchestrationLayoutMode,
): { readonly fromSide: OrchestrationAnchorSide; readonly toSide: OrchestrationAnchorSide } {
	const dx = toPos.x - fromPos.x;
	const dy = toPos.y - fromPos.y;
	const absDx = Math.abs(dx);
	const absDy = Math.abs(dy);

	const normDx = absDx / Math.max(1, (fromSize.width + toSize.width) / 2);
	const normDy = absDy / Math.max(1, (fromSize.height + toSize.height) / 2);

	let candidate: { readonly fromSide: OrchestrationAnchorSide; readonly toSide: OrchestrationAnchorSide };
	if (isWhiteboardLink) {
		if (normDx >= normDy * 0.75) {
			candidate = dx >= 0
				? { fromSide: 'right', toSide: 'left' }
				: { fromSide: 'left', toSide: 'right' };
		} else {
			candidate = dy >= 0
				? { fromSide: 'bottom', toSide: 'top' }
				: { fromSide: 'top', toSide: 'bottom' };
		}
	} else if ((layoutMode === 'td' || (layoutMode === undefined && direction === 'TD')) && normDy >= normDx * 0.72) {
		candidate = dy >= 0
			? { fromSide: 'bottom', toSide: 'top' }
			: { fromSide: 'top', toSide: 'bottom' };
	} else if ((layoutMode === 'lr' || (layoutMode === undefined && direction === 'LR')) && normDx >= normDy * 0.72) {
		candidate = dx >= 0
			? { fromSide: 'right', toSide: 'left' }
			: { fromSide: 'left', toSide: 'right' };
	} else if (normDy >= normDx * 0.85) {
		candidate = dy >= 0
			? { fromSide: 'bottom', toSide: 'top' }
			: { fromSide: 'top', toSide: 'bottom' };
	} else {
		candidate = dx >= 0
			? { fromSide: 'right', toSide: 'left' }
			: { fromSide: 'left', toSide: 'right' };
	}

	// When the two cards do NOT physically overlap, never jam opposite-facing rigid stubs
	// into a narrow < 52px primary-axis slit (< 28px for whiteboard links) when cross-axis spans overlap/near-touch:
	// automatically switch to orthogonal side anchors (hetero-directional L-entry or same-side perimeter arch).
	const gapX = absDx - (fromSize.width + toSize.width) / 2;
	const gapY = absDy - (fromSize.height + toSize.height) / 2;
	const cardsOverlap = gapX < 0 && gapY < 0;
	if (cardsOverlap) {
		return candidate;
	}

	const minFaceGap = isWhiteboardLink ? 28 : 52;
	const crossClearance = 20;
	const isVerticalPair = candidate.fromSide === 'top' || candidate.fromSide === 'bottom';
	const squeezedVertical = isVerticalPair && gapY < minFaceGap && gapX < crossClearance;
	const squeezedHorizontal = !isVerticalPair && gapX < minFaceGap && gapY < crossClearance;

	if (squeezedVertical || squeezedHorizontal) {
		if (gapY >= minFaceGap) {
			return dy >= 0
				? { fromSide: 'bottom', toSide: 'top' }
				: { fromSide: 'top', toSide: 'bottom' };
		}
		if (gapX >= minFaceGap) {
			return dx >= 0
				? { fromSide: 'right', toSide: 'left' }
				: { fromSide: 'left', toSide: 'right' };
		}
		if (gapY >= 0) {
			const horizSide: OrchestrationAnchorSide = dx >= 0 ? 'right' : 'left';
			if (absDx - fromSize.width / 2 >= minFaceGap && absDy - toSize.height / 2 >= minFaceGap) {
				return { fromSide: horizSide, toSide: dy >= 0 ? 'top' : 'bottom' };
			}
			return { fromSide: horizSide, toSide: horizSide };
		}
		const vertSide: OrchestrationAnchorSide = dy >= 0 ? 'bottom' : 'top';
		if (absDy - fromSize.height / 2 >= minFaceGap && absDx - toSize.width / 2 >= minFaceGap) {
			return { fromSide: vertSide, toSide: dx >= 0 ? 'left' : 'right' };
		}
		return { fromSide: vertSide, toSide: vertSide };
	}

	return candidate;
}

function segmentHitsObstacle(
	a: { readonly x: number; readonly y: number },
	b: { readonly x: number; readonly y: number },
	obs: IMissionEdgeObstacle,
): boolean {
	if (Math.abs(a.x - b.x) < 0.5) {
		const x = a.x;
		const minY = Math.min(a.y, b.y);
		const maxY = Math.max(a.y, b.y);
		return x > obs.minX && x < obs.maxX && maxY > obs.minY && minY < obs.maxY;
	}
	if (Math.abs(a.y - b.y) < 0.5) {
		const y = a.y;
		const minX = Math.min(a.x, b.x);
		const maxX = Math.max(a.x, b.x);
		return y > obs.minY && y < obs.maxY && maxX > obs.minX && minX < obs.maxX;
	}
	return false;
}

export function simplifyOrthogonalPoints(
	pts: readonly { readonly x: number; readonly y: number }[],
): { readonly x: number; readonly y: number }[] {
	const deduped: { x: number; y: number }[] = [];
	for (const p of pts) {
		const prev = deduped[deduped.length - 1];
		if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.25) {
			deduped.push({ x: roundSvgCoord(p.x), y: roundSvgCoord(p.y) });
		}
	}
	if (deduped.length <= 2) {
		return deduped;
	}
	const out: { x: number; y: number }[] = [deduped[0]];
	for (let i = 1; i < deduped.length - 1; i++) {
		const a = out[out.length - 1];
		const b = deduped[i];
		const c = deduped[i + 1];
		const colinearX = Math.abs(a.x - b.x) < 0.25 && Math.abs(b.x - c.x) < 0.25;
		const colinearY = Math.abs(a.y - b.y) < 0.25 && Math.abs(b.y - c.y) < 0.25;
		// Only merge collinear vertices when direction does NOT fold 180° back onto itself!
		const dotDir = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
		if ((colinearX || colinearY) && dotDir >= 0) {
			continue;
		}
		out.push(b);
	}
	out.push(deduped[deduped.length - 1]);
	return out;
}

function computeHorizontalDetourYCandidates(
	s1: { readonly x: number; readonly y: number },
	e1: { readonly x: number; readonly y: number },
	obstacles: readonly IMissionEdgeObstacle[],
	laneOffset: number,
): readonly [number, number] {
	const minX = Math.min(s1.x, e1.x) - 16;
	const maxX = Math.max(s1.x, e1.x) + 16;
	let lowestObs = Math.max(s1.y, e1.y) + 54;
	let highestObs = Math.min(s1.y, e1.y) - 54;
	for (const obs of obstacles) {
		if (obs.maxX >= minX && obs.minX <= maxX) {
			lowestObs = Math.max(lowestObs, obs.maxY + 28);
			highestObs = Math.min(highestObs, obs.minY - 28);
		}
	}
	const midY = (s1.y + e1.y) / 2;
	const distDown = Math.abs(lowestObs - midY);
	const distUp = Math.abs(midY - highestObs);
	const lowY = Math.round(lowestObs + Math.abs(laneOffset));
	const highY = Math.round(highestObs - Math.abs(laneOffset));
	return distDown <= distUp ? [lowY, highY] : [highY, lowY];
}

function computeVerticalDetourXCandidates(
	s1: { readonly x: number; readonly y: number },
	e1: { readonly x: number; readonly y: number },
	obstacles: readonly IMissionEdgeObstacle[],
	laneOffset: number,
): readonly [number, number] {
	const minY = Math.min(s1.y, e1.y) - 16;
	const maxY = Math.max(s1.y, e1.y) + 16;
	let rightObs = Math.max(s1.x, e1.x) + 54;
	let leftObs = Math.min(s1.x, e1.x) - 54;
	for (const obs of obstacles) {
		if (obs.maxY >= minY && obs.minY <= maxY) {
			rightObs = Math.max(rightObs, obs.maxX + 28);
			leftObs = Math.min(leftObs, obs.minX - 28);
		}
	}
	const midX = (s1.x + e1.x) / 2;
	const distRight = Math.abs(rightObs - midX);
	const distLeft = Math.abs(midX - leftObs);
	const rightX = Math.round(rightObs + Math.abs(laneOffset));
	const leftX = Math.round(leftObs - Math.abs(laneOffset));
	return distRight <= distLeft ? [rightX, leftX] : [leftX, rightX];
}

function pointStrictlyInsideObstacle(
	p: { readonly x: number; readonly y: number },
	obs: IMissionEdgeObstacle,
): boolean {
	return p.x > obs.minX && p.x < obs.maxX && p.y > obs.minY && p.y < obs.maxY;
}

function shrinkObstacleBox(obs: IMissionEdgeObstacle, inset: number): IMissionEdgeObstacle {
	const cx = (obs.minX + obs.maxX) / 2;
	const cy = (obs.minY + obs.maxY) / 2;
	return {
		minX: Math.min(cx - 1, obs.minX + inset),
		maxX: Math.max(cx + 1, obs.maxX - inset),
		minY: Math.min(cy - 1, obs.minY + inset),
		maxY: Math.max(cy + 1, obs.maxY - inset),
	};
}

function hasCollinearFoldback(
	points: readonly { readonly x: number; readonly y: number }[],
): boolean {
	for (let i = 0; i < points.length - 2; i++) {
		const a = points[i];
		const b = points[i + 1];
		const c = points[i + 2];
		const v1x = b.x - a.x;
		const v1y = b.y - a.y;
		const v2x = c.x - b.x;
		const v2y = c.y - b.y;
		const len1 = Math.hypot(v1x, v1y);
		const len2 = Math.hypot(v2x, v2y);
		if (len1 < 0.05 || len2 < 0.05) {
			return true;
		}
		const uDot = (v1x * v2x + v1y * v2y) / (len1 * len2);
		if (uDot < -1e-6) {
			return true;
		}
	}
	return false;
}

/**
 * Checks whether `points` strictly satisfies the 22px outward-normal rigid stub invariant at BOTH ends,
 * has ZERO 180° collinear foldback spikes across all adjacent segments, and (when `safetyBoxes` is supplied)
 * does not penetrate `fromBox`, `toBox`, or shrunk obstacle boxes:
 * 1. `points[0]` === `(from.x, from.y)` and `points[1] - points[0]` lies strictly along `+from.n` with length `>= minStub`.
 * 2. `points[last]` === `(to.x, to.y)` and `points[last - 1] - points[last]` lies strictly along `+to.n` with length `>= minStub`.
 * 3. Every adjacent segment pair `(k, k + 1)` satisfies `u_k · u_{k+1} >= -1e-6` (forbidding 180° spikes).
 * 4. When `points.length === 2` (collinear direct segment), `from.n === -to.n` and `(to - from) · from.n >= 2 * minStub`.
 */
export function satisfiesRigidNormalStubs(
	points: readonly { readonly x: number; readonly y: number }[],
	from: IOrchestrationAnchorPoint,
	to: IOrchestrationAnchorPoint,
	minStub = ORCH_RIGID_STUB_LENGTH,
	safetyBoxes?: readonly IMissionEdgeObstacle[],
): boolean {
	if (points.length < 2) {
		return false;
	}
	const p0 = points[0];
	const pn = points[points.length - 1];
	if (Math.hypot(p0.x - from.x, p0.y - from.y) > 0.5 || Math.hypot(pn.x - to.x, pn.y - to.y) > 0.5) {
		return false;
	}
	if (points.length === 2) {
		const dx = pn.x - p0.x;
		const dy = pn.y - p0.y;
		const crossFrom = Math.abs(dx * from.ny - dy * from.nx);
		const dotFrom = dx * from.nx + dy * from.ny;
		const dotTo = (-dx) * to.nx + (-dy) * to.ny;
		if (crossFrom >= 0.5 || dotFrom < minStub * 2 - 0.05 || dotTo < minStub * 2 - 0.05) {
			return false;
		}
		if (safetyBoxes && safetyBoxes.length > 0) {
			for (const box of safetyBoxes) {
				if (!pointStrictlyInsideObstacle(p0, box) && !pointStrictlyInsideObstacle(pn, box) && segmentHitsObstacle(p0, pn, box)) {
					return false;
				}
			}
		}
		return true;
	}

	const p1 = points[1];
	const vStartX = p1.x - p0.x;
	const vStartY = p1.y - p0.y;
	const crossStart = Math.abs(vStartX * from.ny - vStartY * from.nx);
	const dotStart = vStartX * from.nx + vStartY * from.ny;
	if (crossStart >= 0.5 || dotStart < minStub - 0.05) {
		return false;
	}

	const pPrev = points[points.length - 2];
	const vEndX = pPrev.x - pn.x;
	const vEndY = pPrev.y - pn.y;
	const crossEnd = Math.abs(vEndX * to.ny - vEndY * to.nx);
	const dotEnd = vEndX * to.nx + vEndY * to.ny;
	if (crossEnd >= 0.5 || dotEnd < minStub - 0.05) {
		return false;
	}

	if (hasCollinearFoldback(points)) {
		return false;
	}

	if (safetyBoxes && safetyBoxes.length > 0) {
		const lastSegIdx = points.length - 2;
		for (let i = 0; i <= lastSegIdx; i++) {
			const a = points[i];
			const b = points[i + 1];
			for (const box of safetyBoxes) {
				if (i === 0 && pointStrictlyInsideObstacle(p0, box)) {
					continue;
				}
				if (i === lastSegIdx && pointStrictlyInsideObstacle(pn, box)) {
					continue;
				}
				if (segmentHitsObstacle(a, b, box)) {
					return false;
				}
			}
		}
	}
	return true;
}

function polylineHitsEndpointAwareObstacles(
	pts: readonly { readonly x: number; readonly y: number }[],
	obstacles: readonly IMissionEdgeObstacle[],
	endpointObstacles: readonly IMissionEdgeObstacle[],
): boolean {
	if (pts.length < 2) {
		return false;
	}
	const p0 = pts[0];
	const pn = pts[pts.length - 1];
	const fromPadBox = endpointObstacles[0];
	const toPadBox = endpointObstacles[1];
	const lastSegIdx = pts.length - 2;

	for (let i = 0; i <= lastSegIdx; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		for (const obs of obstacles) {
			if (i === 0 && pointStrictlyInsideObstacle(p0, obs)) {
				continue;
			}
			if (i === lastSegIdx && pointStrictlyInsideObstacle(pn, obs)) {
				continue;
			}
			if (segmentHitsObstacle(a, b, obs)) {
				return true;
			}
		}
		if (pts.length > 2) {
			if (i === 0) {
				if (toPadBox && !pointStrictlyInsideObstacle(p0, toPadBox) && segmentHitsObstacle(a, b, toPadBox)) {
					return true;
				}
			} else if (i === lastSegIdx) {
				if (fromPadBox && !pointStrictlyInsideObstacle(pn, fromPadBox) && segmentHitsObstacle(a, b, fromPadBox)) {
					return true;
				}
			} else {
				for (const epBox of endpointObstacles) {
					if (segmentHitsObstacle(a, b, epBox)) {
						return true;
					}
				}
			}
		}
	}
	return false;
}

function buildUniqueSortedCoords(raw: readonly number[], requiredExact: readonly number[]): number[] {
	const sorted = [...raw].sort((a, b) => a - b);
	const out: number[] = [];
	for (const v of sorted) {
		const rv = roundSvgCoord(v);
		if (out.length === 0 || Math.abs(rv - out[out.length - 1]) >= 0.5) {
			out.push(rv);
		}
	}
	for (const req of requiredExact) {
		const rReq = roundSvgCoord(req);
		const existingIdx = out.findIndex(v => Math.abs(v - rReq) < 0.5);
		if (existingIdx >= 0) {
			out[existingIdx] = rReq;
		} else {
			out.push(rReq);
			out.sort((a, b) => a - b);
		}
	}
	return out;
}

/**
 * Hanan-grid direction-aware orthogonal A* router with locked start/end outward-normal rigid stubs:
 * - Forbids 180° reversals at `sGate`, `eGate`, and every intermediate grid step.
 * - Penalizes 90° turns so detours stay minimal-bend and strictly outside card obstacles.
 */
function polylineRoundedCornersClearBoxes(
	pts: readonly { readonly x: number; readonly y: number }[],
	cornerRadius: number,
	rigidStub: number,
	boxes: readonly IMissionEdgeObstacle[],
): boolean {
	if (pts.length < 3 || cornerRadius < 0.5 || boxes.length === 0) {
		return true;
	}
	const safeStub = Math.max(0, rigidStub);
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = pts[i - 1];
		const curr = pts[i];
		const next = pts[i + 1];
		const vx1 = curr.x - prev.x;
		const vy1 = curr.y - prev.y;
		const vx2 = next.x - curr.x;
		const vy2 = next.y - curr.y;
		const len1 = Math.hypot(vx1, vy1);
		const len2 = Math.hypot(vx2, vy2);
		if (len1 < 0.05 || len2 < 0.05) {
			continue;
		}
		const avail1 = i === 1 ? Math.max(0, len1 - safeStub) : len1 / 2;
		const avail2 = i === pts.length - 2 ? Math.max(0, len2 - safeStub) : len2 / 2;
		const r = Math.min(Math.max(0, cornerRadius), avail1, avail2);
		if (r < 0.5) {
			continue;
		}
		const ux1 = vx1 / len1;
		const uy1 = vy1 / len1;
		const ux2 = vx2 / len2;
		const uy2 = vy2 / len2;
		const ax = curr.x - ux1 * r;
		const ay = curr.y - uy1 * r;
		const bx = curr.x + ux2 * r;
		const by = curr.y + uy2 * r;
		for (const t of [0.25, 0.5, 0.75]) {
			const omt = 1 - t;
			const qp = {
				x: omt * omt * ax + 2 * omt * t * curr.x + t * t * bx,
				y: omt * omt * ay + 2 * omt * t * curr.y + t * t * by,
			};
			for (const box of boxes) {
				if (pointStrictlyInsideObstacle(qp, box)) {
					return false;
				}
			}
		}
	}
	return true;
}

function computeOrthogonalGridDetour(
	from: IOrchestrationAnchorPoint,
	to: IOrchestrationAnchorPoint,
	obstacles: readonly IMissionEdgeObstacle[],
	endpointObstacles: readonly IMissionEdgeObstacle[],
	safetyBoxes: readonly IMissionEdgeObstacle[],
	rigidStub: number,
	preferredTurnStub: number,
	laneOffset: number,
	cornerRadius = ORCH_CORNER_RADIUS,
	rawObstacles?: readonly IMissionEdgeObstacle[],
	rawEndpoints?: readonly [IMissionEdgeObstacle, IMissionEdgeObstacle],
): { readonly x: number; readonly y: number }[] | undefined {
	const DIRS: readonly { readonly dx: number; readonly dy: number }[] = [
		{ dx: 1, dy: 0 },
		{ dx: -1, dy: 0 },
		{ dx: 0, dy: 1 },
		{ dx: 0, dy: -1 },
	];
	const vecToDir = (vx: number, vy: number): number => {
		if (Math.abs(vx) >= Math.abs(vy)) {
			return vx >= 0 ? 0 : 1;
		}
		return vy >= 0 ? 2 : 3;
	};
	const startDir = vecToDir(from.nx, from.ny);
	const endStubDir = vecToDir(-to.nx, -to.ny);
	const forbiddenArrivalAtEnd = endStubDir ^ 1;

	const fromPoint = { x: from.x, y: from.y };
	const toPoint = { x: to.x, y: to.y };

	const allPadded = [...obstacles, ...endpointObstacles];
	const safetyObs = obstacles.map(obs => shrinkObstacleBox(obs, 3));
	const safetyEps = endpointObstacles.map(obs => shrinkObstacleBox(obs, 3));

	const rawObsList = rawObstacles ?? obstacles.map(obs => shrinkObstacleBox(obs, 9));
	const rawEpPair: readonly [IMissionEdgeObstacle, IMissionEdgeObstacle] | undefined = rawEndpoints ?? (
		endpointObstacles.length >= 2
			? [shrinkObstacleBox(endpointObstacles[0], 8), shrinkObstacleBox(endpointObstacles[1], 8)]
			: undefined
	);
	const rawTorsoBoxes: readonly IMissionEdgeObstacle[] = [...rawObsList, ...(rawEpPair ?? [])];

	const inflateIfClear = (box: IMissionEdgeObstacle, pad: number): IMissionEdgeObstacle => {
		if (pad <= 0) {
			return box;
		}
		const expanded: IMissionEdgeObstacle = {
			minX: box.minX - pad,
			maxX: box.maxX + pad,
			minY: box.minY - pad,
			maxY: box.maxY + pad,
		};
		if (pointStrictlyInsideObstacle(fromPoint, expanded) || pointStrictlyInsideObstacle(toPoint, expanded)) {
			return box;
		}
		return expanded;
	};
	const hardObs = rawObsList.map(box => inflateIfClear(box, 1));
	const hardEps = rawEpPair ? [inflateIfClear(rawEpPair[0], 1), inflateIfClear(rawEpPair[1], 1)] as const : [];
	const hardGridBoxes = [...hardObs, ...hardEps];

	const endpointsPhysicallyOverlap = rawEpPair
		? (
			rawEpPair[0].maxX > rawEpPair[1].minX
			&& rawEpPair[0].minX < rawEpPair[1].maxX
			&& rawEpPair[0].maxY > rawEpPair[1].minY
			&& rawEpPair[0].minY < rawEpPair[1].maxY
		)
		: false;
	const endpointsInsideAnyRawBox = rawTorsoBoxes.some(
		b => pointStrictlyInsideObstacle(fromPoint, b) || pointStrictlyInsideObstacle(toPoint, b),
	);

	const stubPairsStandard: readonly (readonly [number, number])[] = preferredTurnStub > rigidStub
		? [
			[preferredTurnStub, preferredTurnStub],
			[rigidStub, rigidStub],
			[preferredTurnStub, rigidStub],
			[rigidStub, preferredTurnStub],
		]
		: [[rigidStub, rigidStub]];
	const stubPairsTightFirst: readonly (readonly [number, number])[] = preferredTurnStub > rigidStub
		? [
			[rigidStub, rigidStub],
			[preferredTurnStub, rigidStub],
			[rigidStub, preferredTurnStub],
			[preferredTurnStub, preferredTurnStub],
		]
		: [[rigidStub, rigidStub]];

	interface IGridDetourTier {
		readonly gridBoxes: readonly IMissionEdgeObstacle[];
		readonly obsForStubCheck: readonly IMissionEdgeObstacle[];
		readonly epForStubCheck: readonly IMissionEdgeObstacle[];
		readonly verifyBoxes: readonly IMissionEdgeObstacle[] | undefined;
		readonly cornerBoxes: readonly IMissionEdgeObstacle[] | undefined;
		readonly stubs: readonly (readonly [number, number])[];
	}

	const tiers: IGridDetourTier[] = [
		{
			gridBoxes: allPadded,
			obsForStubCheck: obstacles,
			epForStubCheck: endpointObstacles,
			verifyBoxes: safetyBoxes,
			cornerBoxes: rawTorsoBoxes,
			stubs: stubPairsStandard,
		},
		{
			gridBoxes: safetyBoxes,
			obsForStubCheck: safetyObs,
			epForStubCheck: safetyEps,
			verifyBoxes: safetyBoxes,
			cornerBoxes: rawTorsoBoxes,
			stubs: stubPairsStandard,
		},
	];

	const minStartGate = { x: roundSvgCoord(from.x + from.nx * rigidStub), y: roundSvgCoord(from.y + from.ny * rigidStub) };
	const minEndGate = { x: roundSvgCoord(to.x + to.nx * rigidStub), y: roundSvgCoord(to.y + to.ny * rigidStub) };
	const inflatePerSideClear = (box: IMissionEdgeObstacle, pad: number): IMissionEdgeObstacle => {
		if (pointStrictlyInsideObstacle(fromPoint, box) || pointStrictlyInsideObstacle(toPoint, box)) {
			return box;
		}
		const clearOfEndpointsAndMinStubs = (cand: IMissionEdgeObstacle): boolean => (
			!pointStrictlyInsideObstacle(fromPoint, cand)
			&& !pointStrictlyInsideObstacle(toPoint, cand)
			&& !pointStrictlyInsideObstacle(minStartGate, cand)
			&& !pointStrictlyInsideObstacle(minEndGate, cand)
			&& !segmentHitsObstacle(fromPoint, minStartGate, cand)
			&& !segmentHitsObstacle(minEndGate, toPoint, cand)
		);
		let res = inflateIfClear(box, 1);
		const tryMinX = { ...res, minX: box.minX - pad };
		if (clearOfEndpointsAndMinStubs(tryMinX)) { res = tryMinX; }
		const tryMaxX = { ...res, maxX: box.maxX + pad };
		if (clearOfEndpointsAndMinStubs(tryMaxX)) { res = tryMaxX; }
		const tryMinY = { ...res, minY: box.minY - pad };
		if (clearOfEndpointsAndMinStubs(tryMinY)) { res = tryMinY; }
		const tryMaxY = { ...res, maxY: box.maxY + pad };
		if (clearOfEndpointsAndMinStubs(tryMaxY)) { res = tryMaxY; }
		return res;
	};
	const padded6Boxes = rawTorsoBoxes.map(box => inflatePerSideClear(box, 6));
	const padded6Obs = rawObsList.map(box => inflatePerSideClear(box, 6));
	const padded6Eps = rawEpPair ? [inflatePerSideClear(rawEpPair[0], 6), inflatePerSideClear(rawEpPair[1], 6)] as const : [];
	if (!endpointsPhysicallyOverlap && !endpointsInsideAnyRawBox) {
		tiers.push({
			gridBoxes: padded6Boxes,
			obsForStubCheck: padded6Obs,
			epForStubCheck: padded6Eps,
			verifyBoxes: rawTorsoBoxes,
			cornerBoxes: rawTorsoBoxes,
			stubs: stubPairsTightFirst,
		});
		tiers.push({
			gridBoxes: hardGridBoxes,
			obsForStubCheck: hardObs,
			epForStubCheck: hardEps,
			verifyBoxes: rawTorsoBoxes,
			cornerBoxes: undefined,
			stubs: stubPairsTightFirst,
		});
		tiers.push({
			gridBoxes: rawTorsoBoxes,
			obsForStubCheck: rawObsList,
			epForStubCheck: rawEpPair ? [...rawEpPair] : [],
			verifyBoxes: rawTorsoBoxes,
			cornerBoxes: undefined,
			stubs: stubPairsTightFirst,
		});
	} else {
		// Physical card overlap fallback ONLY when user dragged cards onto each other
		const clearRawThirdParty = rawObsList.filter(
			b => !pointStrictlyInsideObstacle(fromPoint, b) && !pointStrictlyInsideObstacle(toPoint, b),
		);
		const clearHardThirdParty = clearRawThirdParty.map(b => inflateIfClear(b, 1));
		if (clearHardThirdParty.length > 0) {
			tiers.push({
				gridBoxes: clearHardThirdParty,
				obsForStubCheck: clearHardThirdParty,
				epForStubCheck: [],
				verifyBoxes: clearRawThirdParty,
				cornerBoxes: undefined,
				stubs: stubPairsTightFirst,
			});
		}
		tiers.push({
			gridBoxes: [],
			obsForStubCheck: [],
			epForStubCheck: [],
			verifyBoxes: undefined,
			cornerBoxes: undefined,
			stubs: stubPairsTightFirst,
		});
	}

	const segBlocked = (
		a: { readonly x: number; readonly y: number },
		b: { readonly x: number; readonly y: number },
		boxes: readonly IMissionEdgeObstacle[],
	): boolean => {
		for (const box of boxes) {
			if (segmentHitsObstacle(a, b, box)) {
				return true;
			}
		}
		return false;
	};

	for (const tier of tiers) {
		for (const [startStubLen, endStubLen] of tier.stubs) {
			const sGate = {
				x: roundSvgCoord(from.x + from.nx * startStubLen),
				y: roundSvgCoord(from.y + from.ny * startStubLen),
			};
			const eGate = {
				x: roundSvgCoord(to.x + to.nx * endStubLen),
				y: roundSvgCoord(to.y + to.ny * endStubLen),
			};

			if (tier.gridBoxes.some(b => pointStrictlyInsideObstacle(sGate, b) || pointStrictlyInsideObstacle(eGate, b))) {
				continue;
			}
			const startCheckBoxes = tier.verifyBoxes
				? [...tier.obsForStubCheck, ...(tier.epForStubCheck[1] ? [tier.epForStubCheck[1]] : [])].filter(b => !pointStrictlyInsideObstacle(fromPoint, b))
				: [];
			const endCheckBoxes = tier.verifyBoxes
				? [...tier.obsForStubCheck, ...(tier.epForStubCheck[0] ? [tier.epForStubCheck[0]] : [])].filter(b => !pointStrictlyInsideObstacle(toPoint, b))
				: [];
			if (segBlocked(fromPoint, sGate, startCheckBoxes) || segBlocked(eGate, toPoint, endCheckBoxes)) {
				continue;
			}

			if (Math.hypot(sGate.x - eGate.x, sGate.y - eGate.y) < 0.5) {
				if (startDir !== forbiddenArrivalAtEnd) {
					const directGate = simplifyOrthogonalPoints([fromPoint, sGate, toPoint]);
					if (
						satisfiesRigidNormalStubs(directGate, from, to, rigidStub, tier.verifyBoxes)
						&& (!tier.cornerBoxes || polylineRoundedCornersClearBoxes(directGate, cornerRadius, rigidStub, tier.cornerBoxes))
					) {
						return directGate;
					}
				}
				continue;
			}

			const rawXs: number[] = [
				sGate.x,
				eGate.x,
				Math.round((sGate.x + eGate.x) / 2 + laneOffset),
				sGate.x + from.nx * 24,
				eGate.x + to.nx * 24,
			];
			const rawYs: number[] = [
				sGate.y,
				eGate.y,
				Math.round((sGate.y + eGate.y) / 2 + laneOffset),
				sGate.y + from.ny * 24,
				eGate.y + to.ny * 24,
			];
			let minX = Math.min(from.x, to.x, sGate.x, eGate.x);
			let maxX = Math.max(from.x, to.x, sGate.x, eGate.x);
			let minY = Math.min(from.y, to.y, sGate.y, eGate.y);
			let maxY = Math.max(from.y, to.y, sGate.y, eGate.y);

			for (const obs of allPadded) {
				minX = Math.min(minX, obs.minX);
				maxX = Math.max(maxX, obs.maxX);
				minY = Math.min(minY, obs.minY);
				maxY = Math.max(maxY, obs.maxY);
				rawXs.push(
					Math.floor(obs.minX - 18),
					Math.ceil(obs.maxX + 18),
					Math.floor(obs.minX - 34 - Math.abs(laneOffset)),
					Math.ceil(obs.maxX + 34 + Math.abs(laneOffset)),
				);
				rawYs.push(
					Math.floor(obs.minY - 18),
					Math.ceil(obs.maxY + 18),
					Math.floor(obs.minY - 34 - Math.abs(laneOffset)),
					Math.ceil(obs.maxY + 34 + Math.abs(laneOffset)),
				);
			}
			for (const hb of hardGridBoxes) {
				rawXs.push(Math.floor(hb.minX - 6), Math.ceil(hb.maxX + 6), Math.floor(hb.minX - 2), Math.ceil(hb.maxX + 2));
				rawYs.push(Math.floor(hb.minY - 6), Math.ceil(hb.maxY + 6), Math.floor(hb.minY - 2), Math.ceil(hb.maxY + 2));
			}
			for (let i = 0; i < rawTorsoBoxes.length; i++) {
				for (let j = i + 1; j < rawTorsoBoxes.length; j++) {
					const a = rawTorsoBoxes[i], b = rawTorsoBoxes[j];
					if (a.maxX < b.minX && b.minX - a.maxX <= 64) { rawXs.push(roundSvgCoord((a.maxX + b.minX) / 2)); }
					else if (b.maxX < a.minX && a.minX - b.maxX <= 64) { rawXs.push(roundSvgCoord((b.maxX + a.minX) / 2)); }
					if (a.maxY < b.minY && b.minY - a.maxY <= 64) { rawYs.push(roundSvgCoord((a.maxY + b.minY) / 2)); }
					else if (b.maxY < a.minY && a.minY - b.maxY <= 64) { rawYs.push(roundSvgCoord((b.maxY + a.minY) / 2)); }
				}
			}
			rawXs.push(Math.floor(minX - 56), Math.ceil(maxX + 56));
			rawYs.push(Math.floor(minY - 56), Math.ceil(maxY + 56));

			const xs = buildUniqueSortedCoords(rawXs, [sGate.x, eGate.x]);
			const ys = buildUniqueSortedCoords(rawYs, [sGate.y, eGate.y]);
			const nxCount = xs.length;
			const nyCount = ys.length;
			const startIx = xs.findIndex(v => Math.abs(v - sGate.x) < 0.25);
			const startIy = ys.findIndex(v => Math.abs(v - sGate.y) < 0.25);
			const endIx = xs.findIndex(v => Math.abs(v - eGate.x) < 0.25);
			const endIy = ys.findIndex(v => Math.abs(v - eGate.y) < 0.25);
			if (startIx < 0 || startIy < 0 || endIx < 0 || endIy < 0) {
				continue;
			}

			const totalStates = nxCount * nyCount * 4;
			const gScore = new Float64Array(totalStates);
			gScore.fill(Number.POSITIVE_INFINITY);
			const prevState = new Int32Array(totalStates);
			prevState.fill(-1);
			const closed = new Uint8Array(totalStates);

			const encode = (ix: number, iy: number, d: number): number => (iy * nxCount + ix) * 4 + d;
			const startState = encode(startIx, startIy, startDir);
			gScore[startState] = 0;

			// Compact binary min-heap over `(fScore, stateIdx)`
			const heapStates: number[] = [startState];
			const heapF: number[] = [Math.abs(eGate.x - sGate.x) + Math.abs(eGate.y - sGate.y)];
			const pushHeap = (st: number, f: number): void => {
				let idx = heapStates.length;
				heapStates.push(st);
				heapF.push(f);
				while (idx > 0) {
					const parent = (idx - 1) >> 1;
					if (heapF[parent] <= f) {
						break;
					}
					heapStates[idx] = heapStates[parent];
					heapF[idx] = heapF[parent];
					idx = parent;
				}
				heapStates[idx] = st;
				heapF[idx] = f;
			};
			const popHeap = (): number => {
				const top = heapStates[0];
				const lastSt = heapStates.pop()!;
				const lastF = heapF.pop()!;
				if (heapStates.length > 0) {
					let idx = 0;
					const n = heapStates.length;
					while (true) {
						const left = (idx << 1) + 1;
						const right = left + 1;
						let smallest = idx;
						if (left < n && heapF[left] < (smallest === idx ? lastF : heapF[smallest])) {
							smallest = left;
						}
						if (right < n && heapF[right] < (smallest === idx ? lastF : heapF[smallest])) {
							smallest = right;
						}
						if (smallest === idx) {
							break;
						}
						heapStates[idx] = heapStates[smallest];
						heapF[idx] = heapF[smallest];
						idx = smallest;
					}
					heapStates[idx] = lastSt;
					heapF[idx] = lastF;
				}
				return top;
			};

			let bestGoalState = -1;
			let bestGoalTotal = Number.POSITIVE_INFINITY;
			const turnPenalty = 32;

			while (heapStates.length > 0) {
				const cur = popHeap();
				if (closed[cur]) {
					continue;
				}
				closed[cur] = 1;
				const curG = gScore[cur];
				if (curG >= bestGoalTotal) {
					break;
				}
				const d = cur & 3;
				const cell = cur >> 2;
				const ix = cell % nxCount;
				const iy = Math.floor(cell / nxCount);

				if (ix === endIx && iy === endIy && cur !== startState && d !== forbiddenArrivalAtEnd) {
					const totalCost = curG + (d !== endStubDir ? turnPenalty : 0);
					if (totalCost < bestGoalTotal) {
						bestGoalTotal = totalCost;
						bestGoalState = cur;
					}
					continue;
				}

				const pA = { x: xs[ix], y: ys[iy] };
				for (let nd = 0; nd < 4; nd++) {
					if (nd === (d ^ 1)) {
						// Strictly forbid 180° collinear reversal!
						continue;
					}
					const nix = ix + DIRS[nd].dx;
					const niy = iy + DIRS[nd].dy;
					if (nix < 0 || nix >= nxCount || niy < 0 || niy >= nyCount) {
						continue;
					}
					const nextSt = encode(nix, niy, nd);
					if (closed[nextSt]) {
						continue;
					}
					const pB = { x: xs[nix], y: ys[niy] };
					if (segBlocked(pA, pB, tier.gridBoxes)) {
						continue;
					}
					const stepDist = Math.abs(pB.x - pA.x) + Math.abs(pB.y - pA.y);
					const nextG = curG + stepDist + (nd !== d ? turnPenalty : 0);
					if (nextG < gScore[nextSt]) {
						gScore[nextSt] = nextG;
						prevState[nextSt] = cur;
						const h = Math.abs(eGate.x - pB.x) + Math.abs(eGate.y - pB.y);
						pushHeap(nextSt, nextG + h);
					}
				}
			}

			if (bestGoalState >= 0) {
				const gridPts: { x: number; y: number }[] = [];
				let walk = bestGoalState;
				while (walk >= 0) {
					const cell = walk >> 2;
					const ix = cell % nxCount;
					const iy = Math.floor(cell / nxCount);
					gridPts.push({ x: xs[ix], y: ys[iy] });
					walk = prevState[walk];
				}
				gridPts.reverse();
				const cand = simplifyOrthogonalPoints([fromPoint, ...gridPts, toPoint]);
				if (
					satisfiesRigidNormalStubs(cand, from, to, rigidStub, tier.verifyBoxes)
					&& (!tier.cornerBoxes || polylineRoundedCornersClearBoxes(cand, cornerRadius, rigidStub, tier.cornerBoxes))
				) {
					return cand;
				}
			}
		}
	}
	return undefined;
}

function buildMultiAnchorOrthogonalPoints(
	from: IOrchestrationAnchorPoint,
	to: IOrchestrationAnchorPoint,
	obstacles: readonly IMissionEdgeObstacle[],
	endpointObstacles: readonly IMissionEdgeObstacle[],
	laneOffset: number,
	rigidStub = ORCH_RIGID_STUB_LENGTH,
	cornerRadius = ORCH_CORNER_RADIUS,
	rawObstacles?: readonly IMissionEdgeObstacle[],
	rawEndpoints?: readonly [IMissionEdgeObstacle, IMissionEdgeObstacle],
): readonly { readonly x: number; readonly y: number }[] {
	// Prefer `rigidStub + cornerRadius` (38px) on bends so the 16px rounded corner never shrinks while keeping 22px straight!
	const preferredTurnStub = Math.max(rigidStub, rigidStub + cornerRadius);
	const s1 = { x: from.x + from.nx * preferredTurnStub, y: from.y + from.ny * preferredTurnStub };
	const e1 = { x: to.x + to.nx * preferredTurnStub, y: to.y + to.ny * preferredTurnStub };
	const sMin = { x: from.x + from.nx * rigidStub, y: from.y + from.ny * rigidStub };
	const eMin = { x: to.x + to.nx * rigidStub, y: to.y + to.ny * rigidStub };

	const fromHoriz = from.nx !== 0;
	const toHoriz = to.nx !== 0;
	const allWrapObstacles = [...obstacles, ...endpointObstacles];
	// Shrunk by 3px from `pad=8..10` leaves `>= 5px` margin (> 4.0px Bezier corner sagitta for r=16) outside every 344×188 card torso!
	const cardSafetyBoxes = allWrapObstacles.map(obs => shrinkObstacleBox(obs, 3));
	const rawTorsoBoxes: readonly IMissionEdgeObstacle[] = [
		...(rawObstacles ?? obstacles.map(obs => shrinkObstacleBox(obs, 9))),
		...(rawEndpoints ?? endpointObstacles.map(obs => shrinkObstacleBox(obs, 8))),
	];

	const tryCandidate = (
		rawPts: readonly { readonly x: number; readonly y: number }[],
	): { readonly x: number; readonly y: number }[] | undefined => {
		const cand = simplifyOrthogonalPoints(rawPts);
		if (!polylineHitsEndpointAwareObstacles(cand, obstacles, endpointObstacles)
			&& satisfiesRigidNormalStubs(cand, from, to, rigidStub, cardSafetyBoxes)
			&& polylineRoundedCornersClearBoxes(cand, cornerRadius, rigidStub, rawTorsoBoxes)) {
			return cand;
		}
		return undefined;
	};

	const fallbackGridDetour = (): readonly { readonly x: number; readonly y: number }[] => {
		const solved = computeOrthogonalGridDetour(
			from,
			to,
			obstacles,
			endpointObstacles,
			cardSafetyBoxes,
			rigidStub,
			preferredTurnStub,
			laneOffset,
			cornerRadius,
			rawObstacles,
			rawEndpoints,
		);
		if (solved) {
			return solved;
		}
		return simplifyOrthogonalPoints([{ x: from.x, y: from.y }, sMin, eMin, { x: to.x, y: to.y }]);
	};

	// Case 1: Same-side perimeter arch (e.g. bottom -> bottom or right -> right)
	if (from.side === to.side) {
		if (from.side === 'bottom' || from.side === 'top') {
			const sign = from.side === 'bottom' ? 1 : -1;
			let channelY = sign > 0
				? Math.max(s1.y, e1.y) + 20 + Math.abs(laneOffset)
				: Math.min(s1.y, e1.y) - 20 - Math.abs(laneOffset);
			for (let step = 0; step < 6; step++) {
				const cand = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: from.x, y: channelY },
					{ x: to.x, y: channelY },
					{ x: to.x, y: to.y },
				]);
				if (cand) {
					return cand;
				}
				channelY += sign * 42;
			}
			return fallbackGridDetour();
		} else {
			const sign = from.side === 'right' ? 1 : -1;
			let channelX = sign > 0
				? Math.max(s1.x, e1.x) + 24 + Math.abs(laneOffset)
				: Math.min(s1.x, e1.x) - 24 - Math.abs(laneOffset);
			for (let step = 0; step < 6; step++) {
				const cand = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: channelX, y: from.y },
					{ x: channelX, y: to.y },
					{ x: to.x, y: to.y },
				]);
				if (cand) {
					return cand;
				}
				channelX += sign * 42;
			}
			return fallbackGridDetour();
		}
	}

	// Case 2: Opposite horizontal sides (`right -> left` or `left -> right`)
	if (fromHoriz && toHoriz) {
		const forwardSpan = (to.x - from.x) * from.nx;
		// Direct collinear horizontal segment when aligned and separated by >= 2 * rigidStub
		if (Math.abs(from.y - to.y) < 0.5 && forwardSpan >= rigidStub * 2 && laneOffset === 0) {
			const direct = tryCandidate([{ x: from.x, y: from.y }, { x: to.x, y: to.y }]);
			if (direct) {
				return direct;
			}
		}
		if (forwardSpan >= rigidStub * 2) {
			const loX = Math.min(sMin.x, eMin.x);
			const hiX = Math.max(sMin.x, eMin.x);
			const baseMidX = (from.x + to.x) / 2 + laneOffset;
			const shifts = [0, 28, -28, 56, -56, 92, -92];
			for (const shift of shifts) {
				const mx = Math.max(loX, Math.min(hiX, Math.round(baseMidX + shift)));
				const cand = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: mx, y: from.y },
					{ x: mx, y: to.y },
					{ x: to.x, y: to.y },
				]);
				if (cand) {
					return cand;
				}
			}
		}
		// Non-degenerate outer wrap: prevent `s1.x === e1.x` (`forwardSpan === 76px`) from collapsing into a 180° spike!
		const minBridgeGap = 16;
		const wrapStubPairs: Array<{ readonly sx: number; readonly ex: number }> = [];
		if (Math.abs(s1.x - e1.x) >= minBridgeGap) {
			wrapStubPairs.push({ sx: s1.x, ex: e1.x });
		}
		if (forwardSpan >= rigidStub * 2 + minBridgeGap) {
			const staggerStub = Math.max(rigidStub, Math.min(preferredTurnStub, Math.floor((forwardSpan - minBridgeGap) / 2)));
			wrapStubPairs.push({
				sx: from.x + from.nx * staggerStub,
				ex: to.x + to.nx * staggerStub,
			});
		} else if (Math.abs(s1.x - e1.x) < minBridgeGap) {
			wrapStubPairs.push({
				sx: from.x + from.nx * (preferredTurnStub + minBridgeGap),
				ex: e1.x,
			});
		}
		const wrapYs = computeHorizontalDetourYCandidates(s1, e1, allWrapObstacles, laneOffset);
		for (const pair of wrapStubPairs) {
			for (const wrapY of wrapYs) {
				const cand = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: pair.sx, y: from.y },
					{ x: pair.sx, y: wrapY },
					{ x: pair.ex, y: wrapY },
					{ x: pair.ex, y: to.y },
					{ x: to.x, y: to.y },
				]);
				if (cand) {
					return cand;
				}
			}
		}
		return fallbackGridDetour();
	}

	// Case 3: Opposite vertical sides (`bottom -> top` or `top -> bottom`)
	if (!fromHoriz && !toHoriz) {
		const forwardSpan = (to.y - from.y) * from.ny;
		if (Math.abs(from.x - to.x) < 0.5 && forwardSpan >= rigidStub * 2 && laneOffset === 0) {
			const direct = tryCandidate([{ x: from.x, y: from.y }, { x: to.x, y: to.y }]);
			if (direct) {
				return direct;
			}
		}
		if (forwardSpan >= rigidStub * 2) {
			const loY = Math.min(sMin.y, eMin.y);
			const hiY = Math.max(sMin.y, eMin.y);
			const baseMidY = (from.y + to.y) / 2 + laneOffset;
			const shifts = [0, 26, -26, 52, -52, 86, -86];
			for (const shift of shifts) {
				const my = Math.max(loY, Math.min(hiY, Math.round(baseMidY + shift)));
				const cand = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: from.x, y: my },
					{ x: to.x, y: my },
					{ x: to.x, y: to.y },
				]);
				if (cand) {
					return cand;
				}
			}
		}
		// Non-degenerate outer wrap: prevent `s1.y === e1.y` (`forwardSpan === 76px`) from collapsing into a 180° spike!
		const minBridgeGap = 16;
		const wrapStubPairs: Array<{ readonly sy: number; readonly ey: number }> = [];
		if (Math.abs(s1.y - e1.y) >= minBridgeGap) {
			wrapStubPairs.push({ sy: s1.y, ey: e1.y });
		}
		if (forwardSpan >= rigidStub * 2 + minBridgeGap) {
			const staggerStub = Math.max(rigidStub, Math.min(preferredTurnStub, Math.floor((forwardSpan - minBridgeGap) / 2)));
			wrapStubPairs.push({
				sy: from.y + from.ny * staggerStub,
				ey: to.y + to.ny * staggerStub,
			});
		} else if (Math.abs(s1.y - e1.y) < minBridgeGap) {
			wrapStubPairs.push({
				sy: from.y + from.ny * (preferredTurnStub + minBridgeGap),
				ey: e1.y,
			});
		}
		const wrapXs = computeVerticalDetourXCandidates(s1, e1, allWrapObstacles, laneOffset);
		for (const pair of wrapStubPairs) {
			for (const wrapX of wrapXs) {
				const cand = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: from.x, y: pair.sy },
					{ x: wrapX, y: pair.sy },
					{ x: wrapX, y: pair.ey },
					{ x: to.x, y: pair.ey },
					{ x: to.x, y: to.y },
				]);
				if (cand) {
					return cand;
				}
			}
		}
		return fallbackGridDetour();
	}

	// Case 4: Orthogonal perpendicular sides (e.g. `left -> top`, `right -> top`, `bottom -> left`, `top -> left`)
	if (fromHoriz && !toHoriz) {
		const corner = { x: to.x, y: from.y };
		if ((corner.x - from.x) * from.nx >= preferredTurnStub && (corner.y - to.y) * to.ny >= preferredTurnStub) {
			const cand = tryCandidate([{ x: from.x, y: from.y }, corner, { x: to.x, y: to.y }]);
			if (cand) {
				return cand;
			}
		}
		if ((corner.x - from.x) * from.nx >= rigidStub && (corner.y - to.y) * to.ny >= rigidStub) {
			const tightCorner = tryCandidate([{ x: from.x, y: from.y }, corner, { x: to.x, y: to.y }]);
			if (tightCorner) {
				return tightCorner;
			}
		}
		for (const xStep of [0, 28, 56]) {
			const vx = s1.x + from.nx * xStep;
			for (const yStep of [0, 24]) {
				const ay = e1.y + to.ny * yStep;
				const alt = tryCandidate([
					{ x: from.x, y: from.y },
					{ x: vx, y: from.y },
					{ x: vx, y: ay },
					{ x: to.x, y: ay },
					{ x: to.x, y: to.y },
				]);
				if (alt) {
					return alt;
				}
			}
		}

		const detourYs = computeHorizontalDetourYCandidates(s1, e1, allWrapObstacles, laneOffset);
		const toBox = endpointObstacles[1] ?? { minX: to.x - 182, maxX: to.x + 182, minY: to.y - 104, maxY: to.y + 104 };
		for (const detourY of detourYs) {
			if ((detourY - e1.y) * to.ny >= 0 && Math.abs(s1.x - e1.x) >= 12) {
				const frontWrap = tryCandidate([
					{ x: from.x, y: from.y },
					s1,
					{ x: s1.x, y: detourY },
					{ x: e1.x, y: detourY },
					e1,
					{ x: to.x, y: to.y },
				]);
				if (frontWrap) {
					return frontWrap;
				}
			} else {
				// `detourY` lies behind `e1` (`(detourY - e1.y) * to.ny < 0`): NEVER connect directly to `(e1.x, detourY)`
				// through `toCard`! Bypass outside `toBox` along a clear vertical side column `sideClearX` to `approachY` in front of `e1`.
				const approachY = e1.y;
				const bandMinY = Math.min(detourY, approachY) - 8;
				const bandMaxY = Math.max(detourY, approachY) + 8;
				let clearLeftX = toBox.minX - 28 - Math.abs(laneOffset);
				let clearRightX = toBox.maxX + 28 + Math.abs(laneOffset);
				for (const obs of allWrapObstacles) {
					if (obs.maxY >= bandMinY && obs.minY <= bandMaxY) {
						if (obs.minX <= toBox.maxX + 40 && obs.maxX >= toBox.minX - 40) {
							clearLeftX = Math.min(clearLeftX, Math.floor(obs.minX - 28));
							clearRightX = Math.max(clearRightX, Math.ceil(obs.maxX + 28));
						}
					}
				}
				const sideXs = Math.abs(s1.x - clearLeftX) + Math.abs(to.x - clearLeftX)
					<= Math.abs(s1.x - clearRightX) + Math.abs(to.x - clearRightX)
					? [clearLeftX, clearRightX]
					: [clearRightX, clearLeftX];
				for (const sideClearX of sideXs) {
					const outerBypass = tryCandidate([
						{ x: from.x, y: from.y },
						s1,
						{ x: s1.x, y: detourY },
						{ x: sideClearX, y: detourY },
						{ x: sideClearX, y: approachY },
						{ x: to.x, y: approachY },
						{ x: to.x, y: to.y },
					]);
					if (outerBypass) {
						return outerBypass;
					}
				}
			}
		}
		return fallbackGridDetour();
	}

	const corner = { x: from.x, y: to.y };
	if ((corner.y - from.y) * from.ny >= preferredTurnStub && (corner.x - to.x) * to.nx >= preferredTurnStub) {
		const cand = tryCandidate([{ x: from.x, y: from.y }, corner, { x: to.x, y: to.y }]);
		if (cand) {
			return cand;
		}
	}
	if ((corner.y - from.y) * from.ny >= rigidStub && (corner.x - to.x) * to.nx >= rigidStub) {
		const tightCorner = tryCandidate([{ x: from.x, y: from.y }, corner, { x: to.x, y: to.y }]);
		if (tightCorner) {
			return tightCorner;
		}
	}
	for (const yStep of [0, 28, 56]) {
		const vy = s1.y + from.ny * yStep;
		for (const xStep of [0, 24]) {
			const ax = e1.x + to.nx * xStep;
			const alt = tryCandidate([
				{ x: from.x, y: from.y },
				{ x: from.x, y: vy },
				{ x: ax, y: vy },
				{ x: ax, y: to.y },
				{ x: to.x, y: to.y },
			]);
			if (alt) {
				return alt;
			}
		}
	}

	const detourXs = computeVerticalDetourXCandidates(s1, e1, allWrapObstacles, laneOffset);
	const toBox = endpointObstacles[1] ?? { minX: to.x - 182, maxX: to.x + 182, minY: to.y - 104, maxY: to.y + 104 };
	for (const detourX of detourXs) {
		if ((detourX - e1.x) * to.nx >= 0 && Math.abs(s1.y - e1.y) >= 12) {
			const frontWrap = tryCandidate([
				{ x: from.x, y: from.y },
				s1,
				{ x: detourX, y: s1.y },
				{ x: detourX, y: e1.y },
				e1,
				{ x: to.x, y: to.y },
			]);
			if (frontWrap) {
				return frontWrap;
			}
		} else {
			// `detourX` lies behind `e1` (`(detourX - e1.x) * to.nx < 0`): bypass outside `toBox` along `sideClearY` to `approachX` in front of `e1`.
			const approachX = e1.x;
			const bandMinX = Math.min(detourX, approachX) - 8;
			const bandMaxX = Math.max(detourX, approachX) + 8;
			let clearTopY = toBox.minY - 28 - Math.abs(laneOffset);
			let clearBottomY = toBox.maxY + 28 + Math.abs(laneOffset);
			for (const obs of allWrapObstacles) {
				if (obs.maxX >= bandMinX && obs.minX <= bandMaxX) {
					if (obs.minY <= toBox.maxY + 40 && obs.maxY >= toBox.minY - 40) {
						clearTopY = Math.min(clearTopY, Math.floor(obs.minY - 28));
						clearBottomY = Math.max(clearBottomY, Math.ceil(obs.maxY + 28));
					}
				}
			}
			const sideYs = Math.abs(s1.y - clearTopY) + Math.abs(to.y - clearTopY)
				<= Math.abs(s1.y - clearBottomY) + Math.abs(to.y - clearBottomY)
				? [clearTopY, clearBottomY]
				: [clearBottomY, clearTopY];
			for (const sideClearY of sideYs) {
				const outerBypass = tryCandidate([
					{ x: from.x, y: from.y },
					s1,
					{ x: detourX, y: s1.y },
					{ x: detourX, y: sideClearY },
					{ x: approachX, y: sideClearY },
					{ x: approachX, y: to.y },
					{ x: to.x, y: to.y },
				]);
				if (outerBypass) {
					return outerBypass;
				}
			}
		}
	}
	return fallbackGridDetour();
}

export function computePolylineMidpoint(
	points: readonly { readonly x: number; readonly y: number }[],
	fraction = 0.5,
): { readonly midX: number; readonly midY: number } {
	if (points.length === 0) {
		return { midX: 0, midY: 0 };
	}
	if (points.length === 1) {
		return { midX: points[0].x, midY: points[0].y };
	}
	let totalLen = 0;
	const segLens: number[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		const len = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
		segLens.push(len);
		totalLen += len;
	}
	if (totalLen < 1) {
		return { midX: points[0].x, midY: points[0].y };
	}
	const targetDist = totalLen * Math.max(0.05, Math.min(0.95, fraction));
	let acc = 0;
	for (let i = 0; i < segLens.length; i++) {
		const segLen = segLens[i];
		if (acc + segLen >= targetDist || i === segLens.length - 1) {
			const frac = segLen > 0.01 ? (targetDist - acc) / segLen : 0.5;
			return {
				midX: Math.round(points[i].x + (points[i + 1].x - points[i].x) * frac),
				midY: Math.round(points[i].y + (points[i + 1].y - points[i].y) * frac),
			};
		}
		acc += segLen;
	}
	return { midX: points[0].x, midY: points[0].y };
}

/**
 * Detours interior orthogonal segments around department header pill boxes while STRICTLY preserving
 * the first `[fa, fa + fa.n * 22]` and last `[ta + ta.n * 22, ta]` rigid outward-normal stubs!
 */
export function detourPolylineAroundPillBoxes(
	rawPoints: readonly { readonly x: number; readonly y: number }[],
	pillBoxes: readonly IMissionEdgeObstacle[],
	cornerRadius = ORCH_CORNER_RADIUS,
	rigidStubLength = ORCH_RIGID_STUB_LENGTH,
	cardObstacles?: readonly IMissionEdgeObstacle[],
): {
	readonly points: readonly { readonly x: number; readonly y: number }[];
	readonly path?: string;
	readonly midX?: number;
	readonly midY?: number;
} {
	if (pillBoxes.length === 0 || rawPoints.length < 2) {
		return { points: rawPoints };
	}
	const safeStub = Math.max(0, rigidStubLength);
	let changed = false;
	const working: { x: number; y: number }[] = rawPoints.map(p => ({ x: p.x, y: p.y }));

	// Only allow detours in interior region strictly outside `[0, safeStub]` from start and `[len - safeStub, len]` from end!
	const out: { x: number; y: number }[] = [working[0]];
	const totalSegs = working.length - 1;
	for (let i = 0; i < totalSegs; i++) {
		const a = out[out.length - 1];
		const b = working[i + 1];
		const isHoriz = Math.abs(a.y - b.y) < 0.5;
		const isVert = Math.abs(a.x - b.x) < 0.5;
		const segLen = Math.hypot(b.x - a.x, b.y - a.y);

		if ((!isHoriz && !isVert) || segLen < 1) {
			out.push(b);
			continue;
		}

		// Protect start stub on segment 0 and end stub on last segment
		const minFromA = i === 0 ? safeStub : 4;
		const minFromB = i === totalSegs - 1 ? safeStub : 4;
		if (segLen <= minFromA + minFromB + 8) {
			out.push(b);
			continue;
		}

		const hit = pillBoxes.find(box => segmentHitsObstacle(a, b, box));
		if (!hit) {
			out.push(b);
			continue;
		}

		if (isHoriz) {
			const dir = b.x >= a.x ? 1 : -1;
			const allowedStart = a.x + dir * minFromA;
			const allowedEnd = b.x - dir * minFromB;
			const rawEnterX = dir > 0 ? hit.minX - 10 : hit.maxX + 10;
			const rawExitX = dir > 0 ? hit.maxX + 10 : hit.minX - 10;
			const enterOk = dir > 0 ? rawEnterX >= allowedStart : rawEnterX <= allowedStart;
			const exitOk = dir > 0 ? rawExitX <= allowedEnd : rawExitX >= allowedEnd;
			if (!enterOk || !exitOk) {
				// Pill box intrudes into 22px forbidden stub zone: NEVER bend inside the 22px stub!
				out.push(b);
				continue;
			}
			const detourY = Math.abs(a.y - (hit.minY - 12)) <= Math.abs((hit.maxY + 12) - a.y)
				? hit.minY - 12
				: hit.maxY + 12;
			out.push(
				{ x: roundSvgCoord(rawEnterX), y: a.y },
				{ x: roundSvgCoord(rawEnterX), y: roundSvgCoord(detourY) },
				{ x: roundSvgCoord(rawExitX), y: roundSvgCoord(detourY) },
				{ x: roundSvgCoord(rawExitX), y: b.y },
				b,
			);
			changed = true;
		} else {
			const dir = b.y >= a.y ? 1 : -1;
			const allowedStart = a.y + dir * minFromA;
			const allowedEnd = b.y - dir * minFromB;
			const rawEnterY = dir > 0 ? hit.minY - 10 : hit.maxY + 10;
			const rawExitY = dir > 0 ? hit.maxY + 10 : hit.minY - 10;
			const enterOk = dir > 0 ? rawEnterY >= allowedStart : rawEnterY <= allowedStart;
			const exitOk = dir > 0 ? rawExitY <= allowedEnd : rawExitY >= allowedEnd;
			if (!enterOk || !exitOk) {
				out.push(b);
				continue;
			}
			const detourX = Math.abs(a.x - (hit.minX - 12)) <= Math.abs((hit.maxX + 12) - a.x)
				? hit.minX - 12
				: hit.maxX + 12;
			out.push(
				{ x: a.x, y: roundSvgCoord(rawEnterY) },
				{ x: roundSvgCoord(detourX), y: roundSvgCoord(rawEnterY) },
				{ x: roundSvgCoord(detourX), y: roundSvgCoord(rawExitY) },
				{ x: b.x, y: roundSvgCoord(rawExitY) },
				b,
			);
			changed = true;
		}
	}

	if (!changed) {
		return { points: rawPoints };
	}
	const clean = simplifyOrthogonalPoints(out);
	if (hasCollinearFoldback(clean)) {
		return { points: rawPoints };
	}
	if (cardObstacles && cardObstacles.length > 0) {
		for (let k = 0; k < clean.length - 1; k++) {
			if (cardObstacles.some(box => segmentHitsObstacle(clean[k], clean[k + 1], box))) {
				return { points: rawPoints };
			}
		}
	}
	const mid = computePolylineMidpoint(clean, 0.5);
	const allCornerObstacles = cardObstacles && cardObstacles.length > 0
		? [...cardObstacles, ...pillBoxes]
		: pillBoxes;
	return {
		points: clean,
		path: roundedOrthogonalPolylineToSvgPath(clean, cornerRadius, safeStub, allCornerObstacles),
		midX: mid.midX,
		midY: mid.midY,
	};
}

function resolveClearAnchorPoint(
	center: IMissionNodePosition,
	size: { readonly width: number; readonly height: number },
	preferredSide: OrchestrationAnchorSide,
	preferredSlot: number,
	totalSlots: number,
	outset: number,
	rigidStub: number,
	targetPos: IMissionNodePosition,
	nonOverlappingBoxes: readonly IMissionEdgeObstacle[],
): IOrchestrationAnchorPoint {
	const selfBox: IMissionEdgeObstacle = {
		minX: center.x - size.width / 2,
		maxX: center.x + size.width / 2,
		minY: center.y - size.height / 2,
		maxY: center.y + size.height / 2,
	};
	const clearBoxes = nonOverlappingBoxes.filter(
		b => !(selfBox.minX < b.maxX && selfBox.maxX > b.minX && selfBox.minY < b.maxY && selfBox.maxY > b.minY),
	);
	const isAnchorStubClear = (anc: IOrchestrationAnchorPoint): boolean => {
		const borderPt = { x: anc.x - anc.nx * outset, y: anc.y - anc.ny * outset };
		const gatePt = { x: anc.x + anc.nx * rigidStub, y: anc.y + anc.ny * rigidStub };
		for (const box of clearBoxes) {
			const exp = { minX: box.minX - 0.5, maxX: box.maxX + 0.5, minY: box.minY - 0.5, maxY: box.maxY + 0.5 };
			if (pointStrictlyInsideObstacle(anc, exp) || pointStrictlyInsideObstacle(gatePt, exp) || segmentHitsObstacle(borderPt, gatePt, exp)) {
				return false;
			}
		}
		return true;
	};
	const initial = computeOrchestrationAnchorPoint(center, size, preferredSide, preferredSlot, totalSlots, outset);
	if (clearBoxes.length === 0 || isAnchorStubClear(initial)) {
		return initial;
	}
	for (const sl of [2, 1, 3, 0, 4]) {
		if (sl >= totalSlots || sl === preferredSlot) { continue; }
		const cand = computeOrchestrationAnchorPoint(center, size, preferredSide, sl, totalSlots, outset);
		if (isAnchorStubClear(cand)) { return cand; }
	}
	const dx = targetPos.x - center.x, dy = targetPos.y - center.y;
	const otherSides = ORCHESTRATION_ANCHOR_SIDES.filter(s => s !== preferredSide).sort((a, b) => {
		const score = (s: OrchestrationAnchorSide) => s === 'right' ? dx : s === 'left' ? -dx : s === 'bottom' ? dy : -dy;
		return score(b) - score(a);
	});
	for (const side of otherSides) {
		for (const sl of [2, 1, 3, 0, 4]) {
			if (sl >= totalSlots) { continue; }
			const cand = computeOrchestrationAnchorPoint(center, size, side, sl, totalSlots, outset);
			if (isAnchorStubClear(cand)) { return cand; }
		}
	}
	return initial;
}

/**
 * Re-anchors an existing `IOrchestrationRoutedEdge` onto exact rendered card sizes (`344×188` staff,
 * `276×164` whiteboard) during live card dragging or incremental refreshes:
 * - Symmetric `outset = 6` on BOTH endpoints of staff parent-child edges (`outset = 0` on whiteboard links).
 * - Locks `[fa, fa + fa.n * 22]` and `[ta + ta.n * 22, ta]` strictly along outward normals, forbidding
 *   `cornerRadius = 16` tangents from intruding into the 22px zone and preventing 180° barb flips under overlap!
 */
export function reanchorOrchestrationRoute(
	edge: IOrchestrationGraphEdge,
	raw: IOrchestrationRoutedEdge,
	nodeById: ReadonlyMap<string, IOrchestrationGraphNode>,
	positions: ReadonlyMap<string, IMissionNodePosition>,
	allObstacles?: readonly { readonly id: string; readonly box: IMissionEdgeObstacle }[],
	layoutMode: 'TD' | 'LR' = 'TD',
): IOrchestrationRoutedEdge {
	const fNode = nodeById.get(edge.from);
	const tNode = nodeById.get(edge.to);
	const fPos = positions.get(edge.from);
	const tPos = positions.get(edge.to);
	if (!fNode || !tNode || !fPos || !tPos) {
		return raw;
	}
	const fSize = getOrchestrationNodeSize(fNode);
	const tSize = getOrchestrationNodeSize(tNode);
	const isWhiteboardLink = Boolean(edge.isWhiteboardLink || fNode.kind === 'whiteboard' || tNode.kind === 'whiteboard');
	const outset = isWhiteboardLink ? ORCH_WHITEBOARD_EDGE_OUTSET : ORCH_STAFF_EDGE_OUTSET;
	const rigidStub = isWhiteboardLink ? 14 : ORCH_RIGID_STUB_LENGTH;
	const cornerRadius = isWhiteboardLink ? 12 : ORCH_CORNER_RADIUS;

	// Re-evaluate anchor sides if relative geometry inverted during drag OR non-overlapping cards entered a narrow < 52px slit
	const normDir: OrchestrationDirection = layoutMode === 'LR' ? 'LR' : 'TD';
	const optimalSides = chooseOptimalAnchorSides(fPos, tPos, fSize, tSize, isWhiteboardLink, normDir, normDir === 'LR' ? 'lr' : 'td');
	const gapX = Math.abs(tPos.x - fPos.x) - (fSize.width + tSize.width) / 2;
	const gapY = Math.abs(tPos.y - fPos.y) - (fSize.height + tSize.height) / 2;
	const cardsOverlap = gapX < 0 && gapY < 0;
	const minFaceGap = isWhiteboardLink ? 28 : 52;
	const squeezedVerticalSlit = !cardsOverlap
		&& gapY < minFaceGap
		&& gapX < 20
		&& (
			(raw.fromAnchor.ny !== 0 && (tPos.y - fPos.y) * raw.fromAnchor.ny >= 0)
			|| (raw.toAnchor.ny !== 0 && (fPos.y - tPos.y) * raw.toAnchor.ny >= 0)
		);
	const squeezedHorizontalSlit = !cardsOverlap
		&& gapX < minFaceGap
		&& gapY < 20
		&& (
			(raw.fromAnchor.nx !== 0 && (tPos.x - fPos.x) * raw.fromAnchor.nx >= 0)
			|| (raw.toAnchor.nx !== 0 && (fPos.x - tPos.x) * raw.toAnchor.nx >= 0)
		);
	const recoverFromSameSideArch = !cardsOverlap
		&& raw.fromAnchor.side === raw.toAnchor.side
		&& optimalSides.fromSide !== optimalSides.toSide;

	const currentFromDot = (tPos.x - fPos.x) * raw.fromAnchor.nx + (tPos.y - fPos.y) * raw.fromAnchor.ny;
	const currentToDot = (fPos.x - tPos.x) * raw.toAnchor.nx + (fPos.y - tPos.y) * raw.toAnchor.ny;
	const forceOptimalPair = squeezedVerticalSlit || squeezedHorizontalSlit || recoverFromSameSideArch;
	const useSideFrom = (forceOptimalPair || currentFromDot < -24) ? optimalSides.fromSide : raw.fromAnchor.side;
	const useSideTo = (forceOptimalPair || currentToDot < -24) ? optimalSides.toSide : raw.toAnchor.side;
	const useSlotFrom = useSideFrom === raw.fromAnchor.side ? raw.fromAnchor.slot : 2;
	const useSlotTo = useSideTo === raw.toAnchor.side ? raw.toAnchor.slot : 2;

	const fRawBox: IMissionEdgeObstacle = {
		minX: fPos.x - fSize.width / 2,
		maxX: fPos.x + fSize.width / 2,
		minY: fPos.y - fSize.height / 2,
		maxY: fPos.y + fSize.height / 2,
	};
	const tRawBox: IMissionEdgeObstacle = {
		minX: tPos.x - tSize.width / 2,
		maxX: tPos.x + tSize.width / 2,
		minY: tPos.y - tSize.height / 2,
		maxY: tPos.y + tSize.height / 2,
	};
	const endpointObstacles: readonly [IMissionEdgeObstacle, IMissionEdgeObstacle] = [
		{
			minX: fRawBox.minX - 8,
			maxX: fRawBox.maxX + 8,
			minY: fRawBox.minY - 8,
			maxY: fRawBox.maxY + 8,
		},
		{
			minX: tRawBox.minX - 8,
			maxX: tRawBox.maxX + 8,
			minY: tRawBox.minY - 8,
			maxY: tRawBox.maxY + 8,
		},
	];
	const otherObstacles: IMissionEdgeObstacle[] = [];
	const otherRawObstacles: IMissionEdgeObstacle[] = [];
	if (allObstacles) {
		for (const o of allObstacles) {
			if (o.id !== edge.from && o.id !== edge.to) {
				otherObstacles.push(o.box);
				const oNode = nodeById.get(o.id);
				const oPos = positions.get(o.id);
				if (oNode && oPos) {
					const oSize = getOrchestrationNodeSize(oNode);
					otherRawObstacles.push({
						minX: oPos.x - oSize.width / 2,
						maxX: oPos.x + oSize.width / 2,
						minY: oPos.y - oSize.height / 2,
						maxY: oPos.y + oSize.height / 2,
					});
				} else {
					otherRawObstacles.push(shrinkObstacleBox(o.box, 9));
				}
			}
		}
	}

	const fa = resolveClearAnchorPoint(fPos, fSize, useSideFrom, useSlotFrom, ORCHESTRATION_SLOTS_PER_SIDE, outset, rigidStub, tPos, [...otherRawObstacles, tRawBox]);
	const ta = resolveClearAnchorPoint(tPos, tSize, useSideTo, useSlotTo, ORCHESTRATION_SLOTS_PER_SIDE, outset, rigidStub, fPos, [...otherRawObstacles, fRawBox]);

	const clean = buildMultiAnchorOrthogonalPoints(
		fa,
		ta,
		otherObstacles,
		endpointObstacles,
		0,
		rigidStub,
		cornerRadius,
		otherRawObstacles,
		[fRawBox, tRawBox],
	);
	const path = roundedOrthogonalPolylineToSvgPath(clean, cornerRadius, rigidStub, [...otherRawObstacles, fRawBox, tRawBox]);
	const mid = computePolylineMidpoint(clean, 0.5);
	return {
		...raw,
		fromAnchor: fa,
		toAnchor: ta,
		points: clean,
		path,
		midX: mid.midX,
		midY: mid.midY,
	};
}

/**
 * Globally computes 4-side multi-anchor slot assignments, dead-center single-track bidirectional edges,
 * symmetric `outset = 6` on staff edges (`outset = 0` on whiteboard links), and smooth rounded orthogonal paths
 * with strict 22px outward-normal rigid stubs.
 */
export function computeOrchestrationMultiAnchorRoutes(
	nodes: readonly IOrchestrationGraphNode[],
	edges: readonly IOrchestrationGraphEdge[],
	positions: ReadonlyMap<string, IMissionNodePosition>,
	options?: { readonly direction?: OrchestrationDirection; readonly cornerRadius?: number; readonly layoutMode?: OrchestrationLayoutMode },
): Map<string, IOrchestrationRoutedEdge> {
	const result = new Map<string, IOrchestrationRoutedEdge>();
	if (edges.length === 0) {
		return result;
	}

	const layoutMode = options?.layoutMode;
	const direction = layoutMode === 'td' ? 'TD' : layoutMode === 'lr' ? 'LR' : (options?.direction ?? 'TD');
	const defaultCornerRadius = options?.cornerRadius ?? ORCH_CORNER_RADIUS;
	const nodeById = new Map(nodes.map(n => [n.id, n]));
	const sizeById = new Map(nodes.map(n => [n.id, getOrchestrationNodeSize(n)]));

	const allObstacles: { readonly id: string; readonly box: IMissionEdgeObstacle; readonly rawBox: IMissionEdgeObstacle }[] = [];
	const obstacleById = new Map<string, { readonly box: IMissionEdgeObstacle; readonly rawBox: IMissionEdgeObstacle }>();
	for (const node of nodes) {
		const pos = positions.get(node.id);
		const sz = sizeById.get(node.id);
		if (!pos || !sz) {
			continue;
		}
		const pad = 10;
		const rawBox: IMissionEdgeObstacle = {
			minX: pos.x - sz.width / 2,
			maxX: pos.x + sz.width / 2,
			minY: pos.y - sz.height / 2,
			maxY: pos.y + sz.height / 2,
		};
		const box: IMissionEdgeObstacle = {
			minX: rawBox.minX - pad,
			maxX: rawBox.maxX + pad,
			minY: rawBox.minY - pad,
			maxY: rawBox.maxY + pad,
		};
		allObstacles.push({ id: node.id, box, rawBox });
		obstacleById.set(node.id, { box, rawBox });
	}

	interface IEdgeSideChoice {
		readonly edge: IOrchestrationGraphEdge;
		readonly isWhiteboardLink: boolean;
		fromSide: OrchestrationAnchorSide;
		toSide: OrchestrationAnchorSide;
	}
	const edgeChoices: IEdgeSideChoice[] = [];
	for (const edge of edges) {
		const fromPos = positions.get(edge.from);
		const toPos = positions.get(edge.to);
		const fromSize = sizeById.get(edge.from);
		const toSize = sizeById.get(edge.to);
		if (!fromPos || !toPos || !fromSize || !toSize) {
			continue;
		}
		const fNode = nodeById.get(edge.from);
		const tNode = nodeById.get(edge.to);
		const isWhiteboardLink = Boolean(edge.isWhiteboardLink || fNode?.kind === 'whiteboard' || tNode?.kind === 'whiteboard');
		const sides = chooseOptimalAnchorSides(
			fromPos,
			toPos,
			fromSize,
			toSize,
			isWhiteboardLink,
			direction,
			layoutMode,
		);
		edgeChoices.push({ edge, isWhiteboardLink, fromSide: sides.fromSide, toSide: sides.toSide });
	}

	interface ISideEndpointRef {
		readonly choice: IEdgeSideChoice;
		readonly nodeId: string;
		readonly edgeId: string;
		readonly isFrom: boolean;
		readonly otherPos: IMissionNodePosition;
	}
	const endpointsByNodeSide = new Map<string, ISideEndpointRef[]>();
	const getSideBucket = (nodeId: string, side: OrchestrationAnchorSide): ISideEndpointRef[] => {
		const key = `${nodeId}:${side}`;
		let list = endpointsByNodeSide.get(key);
		if (!list) {
			list = [];
			endpointsByNodeSide.set(key, list);
		}
		return list;
	};

	for (const ch of edgeChoices) {
		const fromPos = positions.get(ch.edge.from)!;
		const toPos = positions.get(ch.edge.to)!;
		getSideBucket(ch.edge.from, ch.fromSide).push({ choice: ch, nodeId: ch.edge.from, edgeId: ch.edge.id, isFrom: true, otherPos: toPos });
		getSideBucket(ch.edge.to, ch.toSide).push({ choice: ch, nodeId: ch.edge.to, edgeId: ch.edge.id, isFrom: false, otherPos: fromPos });
	}

	const sortSideBucket = (list: ISideEndpointRef[], side: OrchestrationAnchorSide) => {
		const isHorizontalSide = side === 'top' || side === 'bottom';
		list.sort((a, b) => {
			const coordA = isHorizontalSide ? a.otherPos.x : a.otherPos.y;
			const coordB = isHorizontalSide ? b.otherPos.x : b.otherPos.y;
			if (Math.abs(coordA - coordB) > 2) {
				return coordA - coordB;
			}
			return a.edgeId.localeCompare(b.edgeId);
		});
	};

	for (const node of nodes) {
		const nodePos = positions.get(node.id);
		if (!nodePos) {
			continue;
		}
		for (const side of ORCHESTRATION_ANCHOR_SIDES) {
			const bucket = endpointsByNodeSide.get(`${node.id}:${side}`);
			if (!bucket || bucket.length <= ORCHESTRATION_SLOTS_PER_SIDE) {
				continue;
			}
			sortSideBucket(bucket, side);
			const isHorizontalSide = side === 'top' || side === 'bottom';
			const oppositeSide: OrchestrationAnchorSide =
				side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left';
			let peelFromStart = true;
			let guard = bucket.length * 2;
			while (bucket.length > ORCHESTRATION_SLOTS_PER_SIDE && guard-- > 0) {
				const candidate = peelFromStart ? bucket[0] : bucket[bucket.length - 1];
				peelFromStart = !peelFromStart;
				const preferredTargets: OrchestrationAnchorSide[] = isHorizontalSide
					? (candidate.otherPos.x < nodePos.x ? ['left', 'right', oppositeSide] : ['right', 'left', oppositeSide])
					: (candidate.otherPos.y < nodePos.y ? ['top', 'bottom', oppositeSide] : ['bottom', 'top', oppositeSide]);
				const targetSide = preferredTargets.find(s => getSideBucket(node.id, s).length < ORCHESTRATION_SLOTS_PER_SIDE);
				if (!targetSide) {
					break;
				}
				const idx = bucket.indexOf(candidate);
				if (idx >= 0) {
					bucket.splice(idx, 1);
				}
				if (candidate.isFrom) {
					candidate.choice.fromSide = targetSide;
				} else {
					candidate.choice.toSide = targetSide;
				}
				getSideBucket(node.id, targetSide).push(candidate);
			}
		}
	}

	// Single edge on a side ALWAYS picks slot 2 (exact 0.50 dead-center!)
	const pickSymmetricSlots = (count: number, totalSlots: number): readonly number[] => {
		if (totalSlots === 5) {
			switch (count) {
				case 1: return [2];
				case 2: return [1, 3];
				case 3: return [0, 2, 4];
				case 4: return [0, 1, 3, 4];
				case 5: return [0, 1, 2, 3, 4];
			}
		}
		if (count === 1) { return [Math.floor(totalSlots / 2)]; }
		if (count === 2) { return [0, totalSlots - 1]; }
		return Array.from({ length: count }, (_, idx) => Math.min(totalSlots - 1, Math.floor((idx * totalSlots) / count)));
	};

	const assignedSlot = new Map<string, { readonly slot: number; readonly totalSlots: number }>();
	for (const [key, list] of endpointsByNodeSide.entries()) {
		const side = key.slice(key.lastIndexOf(':') + 1) as OrchestrationAnchorSide;
		sortSideBucket(list, side);
		const count = list.length;
		const slotMap = pickSymmetricSlots(count, ORCHESTRATION_SLOTS_PER_SIDE);
		for (let i = 0; i < count; i++) {
			const ref = list[i];
			const mapKey = `${ref.edgeId}:${ref.isFrom ? 'from' : 'to'}`;
			assignedSlot.set(mapKey, {
				slot: slotMap[i] ?? Math.floor(ORCHESTRATION_SLOTS_PER_SIDE / 2),
				totalSlots: ORCHESTRATION_SLOTS_PER_SIDE,
			});
		}
	}

	const makeCorridorKey = (ch: IEdgeSideChoice): string => {
		const fp = positions.get(ch.edge.from)!;
		const tp = positions.get(ch.edge.to)!;
		const bx = Math.round((fp.x + tp.x) / 840);
		const by = Math.round((fp.y + tp.y) / 840);
		return `${ch.fromSide}->${ch.toSide}@${bx}:${by}`;
	};
	const corridorCounts = new Map<string, number>();
	const edgeLaneMap = new Map<string, number>();
	for (const ch of edgeChoices) {
		const corridorKey = makeCorridorKey(ch);
		const idx = corridorCounts.get(corridorKey) ?? 0;
		corridorCounts.set(corridorKey, idx + 1);
		edgeLaneMap.set(ch.edge.id, idx);
	}

	for (const ch of edgeChoices) {
		const { edge, isWhiteboardLink, fromSide, toSide } = ch;
		const fromPos = positions.get(edge.from)!;
		const toPos = positions.get(edge.to)!;
		const fromSize = sizeById.get(edge.from)!;
		const toSize = sizeById.get(edge.to)!;

		const fromSlotInfo = assignedSlot.get(`${edge.id}:from`) ?? { slot: 2, totalSlots: ORCHESTRATION_SLOTS_PER_SIDE };
		const toSlotInfo = assignedSlot.get(`${edge.id}:to`) ?? { slot: 2, totalSlots: ORCHESTRATION_SLOTS_PER_SIDE };

		// Symmetric outset = 6 on BOTH endpoints of staff parent-child edges; outset = 0 on whiteboard dashed links!
		const outset = isWhiteboardLink ? ORCH_WHITEBOARD_EDGE_OUTSET : ORCH_STAFF_EDGE_OUTSET;
		const rigidStub = isWhiteboardLink ? 14 : ORCH_RIGID_STUB_LENGTH;
		const cornerRadius = isWhiteboardLink ? 12 : defaultCornerRadius;

		// Dead-center lane offset when single edge in corridor (ZERO `bidirRank * 9` bias!)
		const corridorKey = makeCorridorKey(ch);
		const totalInCorridor = corridorCounts.get(corridorKey) ?? 1;
		const laneIdx = edgeLaneMap.get(edge.id) ?? 0;
		const laneOffset = totalInCorridor > 1
			? Math.max(-44, Math.min(44, Math.round((laneIdx - (totalInCorridor - 1) / 2) * 12)))
			: 0;

		const fromEntry = obstacleById.get(edge.from);
		const toEntry = obstacleById.get(edge.to);
		const fromRawBox: IMissionEdgeObstacle = fromEntry?.rawBox ?? {
			minX: fromPos.x - fromSize.width / 2,
			maxX: fromPos.x + fromSize.width / 2,
			minY: fromPos.y - fromSize.height / 2,
			maxY: fromPos.y + fromSize.height / 2,
		};
		const toRawBox: IMissionEdgeObstacle = toEntry?.rawBox ?? {
			minX: toPos.x - toSize.width / 2,
			maxX: toPos.x + toSize.width / 2,
			minY: toPos.y - toSize.height / 2,
			maxY: toPos.y + toSize.height / 2,
		};
		const fromBox: IMissionEdgeObstacle = fromEntry?.box ?? {
			minX: fromRawBox.minX - 10,
			maxX: fromRawBox.maxX + 10,
			minY: fromRawBox.minY - 10,
			maxY: fromRawBox.maxY + 10,
		};
		const toBox: IMissionEdgeObstacle = toEntry?.box ?? {
			minX: toRawBox.minX - 10,
			maxX: toRawBox.maxX + 10,
			minY: toRawBox.minY - 10,
			maxY: toRawBox.maxY + 10,
		};
		// Strictly order [fromBox, toBox] (index 0 = edge.from, index 1 = edge.to) independent of nodes iteration order!
		const endpointObstacles: readonly [IMissionEdgeObstacle, IMissionEdgeObstacle] = [fromBox, toBox];
		const rawEndpoints: readonly [IMissionEdgeObstacle, IMissionEdgeObstacle] = [fromRawBox, toRawBox];

		const corridorPad = 560;
		const corridor: IMissionEdgeObstacle = {
			minX: Math.min(fromBox.minX, toBox.minX) - corridorPad,
			maxX: Math.max(fromBox.maxX, toBox.maxX) + corridorPad,
			minY: Math.min(fromBox.minY, toBox.minY) - corridorPad,
			maxY: Math.max(fromBox.maxY, toBox.maxY) + corridorPad,
		};
		const includeAllNonEndpoints = allObstacles.length <= 160;
		const localObstacles: IMissionEdgeObstacle[] = [];
		const localRawObstacles: IMissionEdgeObstacle[] = [];
		for (const o of allObstacles) {
			if (o.id === edge.from || o.id === edge.to) {
				continue;
			}
			if (
				includeAllNonEndpoints
				|| (o.box.minX <= corridor.maxX && o.box.maxX >= corridor.minX && o.box.minY <= corridor.maxY && o.box.maxY >= corridor.minY)
			) {
				localObstacles.push(o.box);
				localRawObstacles.push(o.rawBox);
			}
		}

		const fromAnchor = resolveClearAnchorPoint(fromPos, fromSize, fromSide, fromSlotInfo.slot, fromSlotInfo.totalSlots, outset, rigidStub, toPos, [...localRawObstacles, toRawBox]);
		const toAnchor = resolveClearAnchorPoint(toPos, toSize, toSide, toSlotInfo.slot, toSlotInfo.totalSlots, outset, rigidStub, fromPos, [...localRawObstacles, fromRawBox]);

		const points = buildMultiAnchorOrthogonalPoints(
			fromAnchor,
			toAnchor,
			localObstacles,
			endpointObstacles,
			laneOffset,
			rigidStub,
			cornerRadius,
			localRawObstacles,
			rawEndpoints,
		);
		const path = roundedOrthogonalPolylineToSvgPath(points, cornerRadius, rigidStub, [...localRawObstacles, fromRawBox, toRawBox]);
		// Dead-center 0.5 midpoint (ZERO `0.38/0.62` dual-track bias!)
		const { midX, midY } = computePolylineMidpoint(points, 0.5);

		result.set(edge.id, {
			edgeId: edge.id,
			from: edge.from,
			to: edge.to,
			fromAnchor,
			toAnchor,
			path,
			midX,
			midY,
			points,
			isBidirectional: !isWhiteboardLink,
			isWhiteboardLink,
			laneIndex: laneIdx,
		});
	}

	return result;
}
